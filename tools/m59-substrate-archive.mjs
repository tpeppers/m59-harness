#!/usr/bin/env node
// m59-substrate-archive.mjs — ARCHIVE SUBSTRATE CLUTTER ONLY WHERE NOTHING LIVE STILL IMPORTS IT,
// AND PUT IT BACK BY ITSELF WHEN SOMETHING DOES.
//
//   node tools/m59-substrate-archive.mjs check                       # every broken substrate import
//   node tools/m59-substrate-archive.mjs move <paths...> [--to scratch/archive-<date>] [--with-importers] [--apply]
//   node tools/m59-substrate-archive.mjs restore <file-or-module> [--apply]
//   node tools/m59-substrate-archive.mjs restore-missing [--apply]
//   ... --substrate <dir>   (default M59_SUBSTRATE_DIR, else this checkout's substrate/)   --json
//
// THE INCIDENT, 2026-10-21. A session moved ~630 "clutter" files out of prod-deploy/substrate/ into
// substrate/scratch/archive-2026-10-21/substrate/ with a bare move, to clear prod for a deploy cut.
// Some of them were still IMPORTED by live strategy code, and nothing anywhere said so:
//   * pvp-strategies/bastion.mjs imported seven production-*-guard modules. Every keeper's PvP strategy
//     refresh then failed with "Cannot find module", and the keepers silently kept the module they had
//     loaded before (FleeTA) for HOURS while reporting their strategy as "bastion".
//   * fleetscripts/zheng-he-lap.mjs imported production-robin-guild-posture.mjs, so the courier lap
//     "will not import" and the courier sat idle.
//   * fleetscripts/cv-lockdown.mjs imports the archived cv-lockdown-farm.mjs and stayed broken.
// Operator: "Fix our archival process so that we can't archive anything such that it can't be used in
// a restore ... or make it so reviving an old strategy and hitting that error causes an automatic
// restore. We want to be able to re-use old postures." This file is both halves:
//   `move` REFUSES to archive a file a live file (or a strategy assignment) still reaches, naming every
//   importer, and `--with-importers` archives the whole closure instead; and `autoRestore` /
//   `importWithAutoRestore` are what m59-fleetlib.mjs and m59-pvp-strategy.mjs call when an import
//   fails with ERR_MODULE_NOT_FOUND — the missing files come back from the newest archive and the
//   import is retried once.
//
// THE GRAPH. Every .mjs/.js/.cjs under the substrate (data directories and scratch/ skipped — see
// SKIP_DIRS), plus the top-level modules of every extra strategy directory named in a
// substrate/*-dirs.json ({ "dirs": [...] }, e.g. pvp-strategy-dirs.json, farm-strategy-dirs.json).
// Edges: static `import ... from '<spec>'` and bare `import '<spec>'`, `export ... from '<spec>'`,
// dynamic `import('<literal>')` / `import(new URL('<literal>', import.meta.url))`, and
// `new URL('<literal>.mjs', import.meta.url)`. A `?v=8` query or `#hash` is stripped before resolving.
// Relative specs and file:// URLs are resolved; bare and node: specs are not files and are ignored.
// Plus CONFIG edges: the strategy names in substrate/pvp-strategy[-<fleet>].json, and every
// farm_strategy / farmStrategy value in substrate/*.json, fleets/*.json and fleets/.keeper-carry/
// (a strategy is reached by NAME, not by import, so a moved strategy file breaks an assignment just as
// surely). Those files hold credentials: only the strategy name and the file's path are ever reported.
//
// WHAT THE PARSER IS NOT: a JavaScript parser. Lines that START as comments are skipped; anything
// else that looks like an import counts. It errs toward an EXTRA edge, because an extra edge refuses a
// move that was safe (a nuisance) and a missing edge allows one that was not (the incident). A string
// built at run time (`import(name)`) cannot be followed by anything short of running it; the
// auto-restore on the import paths is the net under that.
//
// THE ARCHIVE LAYOUT is the one the incident used: <substrate>/scratch/archive-<label>/substrate/<rel>,
// with MOVED.txt (one `substrate/<rel>` per line) and README.txt beside it. An archive with no
// substrate/ directory inside is read flat (<archive>/<rel>). Newest archive first = name descending.
//
// RESTORE IS NARROW ON PURPOSE: it only ever moves FROM <substrate>/scratch/archive-*/ INTO the
// matching original path inside the same substrate, never into scratch/, and never over an existing
// file (copy with COPYFILE_EXCL, then unlink the archived copy). Each restore appends a line to the
// archive's RESTORED.txt.
//
// Zero dependencies. Importing this file does nothing; the CLI runs only when it is the entry point.

import {
  existsSync, readFileSync, readdirSync, statSync, mkdirSync, copyFileSync, unlinkSync,
  appendFileSync, writeFileSync, constants as FS,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

export const defaultSubstrate = (env = process.env) => resolve(env.M59_SUBSTRATE_DIR || join(REPO, 'substrate'));

/** Directories under the substrate that hold data, backups or ad-hoc scratch, never live code. */
export const SKIP_DIRS = new Set([
  'scratch', 'replay-smoke', 'session-evidence', 'history', 'recordings', 'replays', 'postmortems',
  'survival-decisions', 'inventory-intent', 'local-test-checkpoints', 'player-evidence', 'client-context',
  'overlay', 'node-tours', 'fleets', 'investigations', 'undo-lockdown', 'archive', 'node_modules', 'logs',
  'roomviews', 'jams', 'banks', 'attribution-backups', 'lockdown-saved', 'errands-saved',
]);
const CODE_EXT = /\.(mjs|js|cjs)$/i;
const WIN = process.platform === 'win32';
const key = p => (WIN ? resolve(p).toLowerCase() : resolve(p));
const isUnder = (child, parent) => {
  const r = relative(resolve(parent), resolve(child));
  return r === '' || (!!r && !r.startsWith('..') && !isAbsolute(r));
};
const relS = (sub, p) => relative(sub, p).split(sep).join('/');
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

/** `'../x.mjs?v=8'` -> `'../x.mjs'`. */
export const stripQuery = spec => String(spec).replace(/[?#].*$/, '');

function commentedAt(src, idx) {
  const ls = src.lastIndexOf('\n', idx - 1) + 1;
  const prefix = src.slice(ls, idx);
  const t = prefix.trimStart();
  if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return true;
  const c = prefix.indexOf('//');
  return c >= 0 && !/['"`]/.test(prefix.slice(0, c));
}

const RE_STATIC = /\bimport\s+(?:[\w$*{}\s,]+?\s*from\s*)?(['"])([^'"\n]+)\1/g;
const RE_EXPORT = /\bexport\s+(?:\*\s*(?:as\s+[\w$]+\s*)?|\{[^}]*\}\s*)from\s*(['"])([^'"\n]+)\1/g;
const RE_DYNAMIC = /\bimport\s*\(\s*(?:(['"`])([^'"`\n]+?)\1|new\s+URL\(\s*(['"`])([^'"`\n]+?)\3\s*,\s*import\.meta\.url\s*\)(?:\.href)?)\s*[,)]/g;
const RE_URL = /new\s+URL\(\s*(['"`])([^'"`\n]+?)\1\s*,\s*import\.meta\.url\s*\)/g;

/** Every module reference in one source text: [{ spec, kind, line }]. One entry per spec. */
export function parseImports(src) {
  const out = [], seen = new Set();
  const lineOf = i => src.slice(0, i).split('\n').length;
  const add = (spec, kind, idx) => {
    if (!spec || spec.includes('${') || commentedAt(src, idx)) return;
    if (seen.has(spec)) return;
    seen.add(spec); out.push({ spec, kind, line: lineOf(idx) });
  };
  for (const m of src.matchAll(RE_STATIC)) add(m[2], 'static', m.index);
  for (const m of src.matchAll(RE_EXPORT)) add(m[2], 'export', m.index);
  for (const m of src.matchAll(RE_DYNAMIC)) {
    if (m[2] != null) add(m[2], 'dynamic', m.index);
    else add(urlSpec(m[4]), 'dynamic', m.index);
  }
  for (const m of src.matchAll(RE_URL)) {
    if (CODE_EXT.test(stripQuery(m[2]))) add(urlSpec(m[2]), 'url', m.index);
  }
  return out;
}
// `new URL('x.mjs', import.meta.url)` is relative even without the ./
const urlSpec = s => (/^(\.{1,2}\/|\/|[a-z][a-z0-9+.-]*:)/i.test(s) ? s : `./${s}`);

/** The file a spec names, from `fromFile`, or null for a bare / node: specifier. */
export function resolveSpec(fromFile, spec) {
  const s = String(spec);
  try {
    if (s.startsWith('./') || s.startsWith('../')) {
      const u = new URL(s, pathToFileURL(fromFile));
      u.search = ''; u.hash = '';
      return fileURLToPath(u);
    }
    if (/^file:/i.test(s)) {
      const u = new URL(s); u.search = ''; u.hash = '';
      return fileURLToPath(u);
    }
  } catch { /* malformed: not a file we can name */ }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------------------------

function readJson(f) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } }

/** Every directory named by a substrate/*-dirs.json, by file: { 'pvp-strategy-dirs.json': [...] }. */
export function extraDirsBySource(substrate, env = process.env) {
  const out = {};
  let names = [];
  try { names = readdirSync(substrate).filter(n => /-dirs\.json$/i.test(n)); } catch { /* none */ }
  for (const n of names) {
    const j = readJson(join(substrate, n));
    out[n] = (Array.isArray(j?.dirs) ? j.dirs : []).filter(d => typeof d === 'string' && d.trim()).map(d => resolve(d.trim()));
  }
  if (resolve(substrate) === defaultSubstrate(env)) {
    for (const [file, v] of [['pvp-strategy-dirs.json', 'M59_PVP_STRATEGY_PATH'], ['farm-strategy-dirs.json', 'M59_FARM_STRATEGY_PATH']]) {
      for (const d of String(env?.[v] ?? '').split(delimiter)) if (d.trim()) (out[file] ??= []).push(resolve(d.trim()));
    }
  }
  return out;
}

function walkCode(root, { skip = SKIP_DIRS, includeScratch = false } = {}) {
  const out = [];
  const go = (dir, depth) => {
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 8 || e.name.startsWith('.')) continue;
        if (depth === 0 && skip.has(e.name) && !(includeScratch && e.name === 'scratch')) continue;
        if (/^archive-/.test(e.name) || /(^|[-.])bak(up)?s?($|[-.])/i.test(e.name)) continue;
        go(p, depth + 1);
      } else if (e.isFile() && CODE_EXT.test(e.name)) out.push(p);
    }
  };
  go(root, 0);
  return out;
}

const STRATEGY_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

/**
 * Strategy assignments: every place a module is named by NAME. Only the name and the config's path are
 * kept — fleets/*.json is the credential store and is never echoed.
 *   -> [{ config, where, kind: 'pvp'|'farm', name, target, exists, candidates }]
 */
export function configRefs(substrate, extras = extraDirsBySource(substrate)) {
  const out = [];
  const pvpDirs = [join(substrate, 'pvp-strategies'), ...(extras['pvp-strategy-dirs.json'] ?? [])];
  const farmDirs = [join(substrate, 'farm-strategies'), ...(extras['farm-strategy-dirs.json'] ?? [])];
  const find = (name, dirs) => {
    const candidates = dirs.map(d => join(d, `${name}.mjs`));
    const hit = candidates.find(c => existsSync(c));
    return { target: hit ?? candidates[0], exists: !!hit, candidates };
  };
  let top = [];
  try { top = readdirSync(substrate); } catch { return out; }
  // PvP: { default, agents: {}, characters: {} }, each "name" | { strategy } | null.
  for (const n of top.filter(n => /^pvp-strategy(-[A-Za-z0-9_-]+)?\.json$/.test(n))) {
    const book = readJson(join(substrate, n));
    if (!book || typeof book !== 'object') continue;
    const entries = [['default', book.default]];
    for (const t of ['agents', 'characters']) {
      for (const [k, v] of Object.entries(book[t] && typeof book[t] === 'object' ? book[t] : {})) entries.push([`${t}.${k}`, v]);
    }
    for (const [where, e] of entries) {
      const name = typeof e === 'string' ? e.trim() : (e && typeof e.strategy === 'string' ? e.strategy.trim() : null);
      if (!name || !STRATEGY_NAME.test(name)) continue;
      out.push({ config: join(substrate, n), where, kind: 'pvp', name, ...find(name, pvpDirs) });
    }
  }
  // Farm strategies are assigned per character and carried in policy: find every farm_strategy value.
  const files = top.filter(n => n.endsWith('.json')).map(n => join(substrate, n));
  for (const d of [join(substrate, 'fleets'), join(substrate, 'fleets', '.keeper-carry')]) {
    try { for (const n of readdirSync(d)) if (n.endsWith('.json')) files.push(join(d, n)); } catch { /* none */ }
  }
  for (const f of files) {
    let txt;
    try { if (statSync(f).size > 8 * 1024 * 1024) continue; txt = readFileSync(f, 'utf8'); } catch { continue; }
    if (!/"farm_?[sS]trategy"/.test(txt)) continue;
    let j; try { j = JSON.parse(txt); } catch { continue; }
    const seen = new Set();
    const visit = (v, depth) => {
      if (!v || typeof v !== 'object' || depth > 12) return;
      for (const [k, x] of Object.entries(v)) {
        if ((k === 'farm_strategy' || k === 'farmStrategy') && typeof x === 'string' && STRATEGY_NAME.test(x) && !seen.has(x)) {
          seen.add(x);
          out.push({ config: f, where: k, kind: 'farm', name: x, ...find(x, farmDirs) });
        } else if (x && typeof x === 'object') visit(x, depth + 1);
      }
    };
    visit(j, 0);
  }
  return out;
}

/**
 * The import graph over a substrate.
 *   -> { substrate, extras, nodes: Map(key -> { file, origin, src, imports: [{ spec, kind, line, target, exists, inSubstrate }] }),
 *        importers: Map(key(target) -> Set(file)), configs: [...configRefs] }
 */
export function buildGraph({ substrate = defaultSubstrate(), includeScratch = false, env = process.env } = {}) {
  substrate = resolve(substrate);
  const extras = extraDirsBySource(substrate, env);
  const extraDirs = [...new Set(Object.values(extras).flat())].filter(d => existsSync(d));
  const nodes = new Map(), importers = new Map();
  const queue = [];
  const enqueue = (f, origin) => { if (!nodes.has(key(f))) { nodes.set(key(f), null); queue.push([f, origin]); } };
  for (const f of walkCode(substrate, { includeScratch })) enqueue(f, 'substrate');
  for (const d of extraDirs) {
    let ents = []; try { ents = readdirSync(d); } catch { /* none */ }
    for (const n of ents) if (CODE_EXT.test(n)) enqueue(join(d, n), 'extra');
  }
  const existsCache = new Map();
  const exists = p => { const k = key(p); if (!existsCache.has(k)) existsCache.set(k, existsSync(p)); return existsCache.get(k); };
  while (queue.length) {
    const [file, origin] = queue.shift();
    let src = '';
    try { src = readFileSync(file, 'utf8'); } catch { /* vanished */ }
    const imports = [];
    for (const imp of parseImports(src)) {
      const target = resolveSpec(file, imp.spec);
      if (!target) continue;
      const inSubstrate = isUnder(target, substrate);
      const ok = exists(target);
      imports.push({ ...imp, target, exists: ok, inSubstrate });
      const k = key(target);
      if (!importers.has(k)) importers.set(k, new Set());
      importers.get(k).add(file);
      if (ok && CODE_EXT.test(target) && (inSubstrate || extraDirs.some(d => isUnder(target, d))))
        enqueue(target, inSubstrate ? 'substrate' : 'extra');
    }
    nodes.set(key(file), { file, origin, src, imports });
  }
  return { substrate, extras, nodes, importers, configs: configRefs(substrate, extras) };
}

// ---------------------------------------------------------------------------------------------
// Archives
// ---------------------------------------------------------------------------------------------

/** Every <substrate>/scratch/archive-* directory, newest (name descending) first. */
export function listArchives(substrate) {
  const s = join(substrate, 'scratch');
  let ents = [];
  try { ents = readdirSync(s, { withFileTypes: true }); } catch { return []; }
  return ents.filter(e => e.isDirectory() && /^archive-/.test(e.name)).map(e => e.name)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).map(n => join(s, n));
}

/** Archived copies of a live substrate path, newest first: [{ archive, path }]. */
export function findArchived(substrate, target) {
  substrate = resolve(substrate);
  if (!isUnder(target, substrate)) return [];
  const rel = relative(substrate, resolve(target));
  if (!rel || rel.split(sep)[0] === 'scratch') return [];
  const out = [];
  for (const a of listArchives(substrate)) {
    const nested = join(a, 'substrate');
    const p = existsSync(nested) ? join(nested, rel) : join(a, rel);
    if (existsSync(p)) out.push({ archive: a, path: p });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------------------------

/**
 * Every live reference that does not resolve.
 *   -> { substrate, broken: [{ from, spec, kind, line, target, inSubstrate, archived }],
 *        configs: [{ ...configRef, archived }], files }
 */
export function checkSubstrate({ substrate = defaultSubstrate(), graph = null, env = process.env } = {}) {
  const g = graph ?? buildGraph({ substrate, env });
  const broken = [];
  for (const n of g.nodes.values()) {
    if (!n) continue;
    for (const i of n.imports) {
      if (i.exists) continue;
      broken.push({ from: n.file, spec: i.spec, kind: i.kind, line: i.line, target: i.target,
        inSubstrate: i.inSubstrate, archived: i.inSubstrate ? findArchived(g.substrate, i.target) : [] });
    }
  }
  const configs = g.configs.filter(c => !c.exists).map(c => ({ ...c, archived: findArchived(g.substrate, c.target) }));
  return { substrate: g.substrate, broken, configs, files: [...g.nodes.values()].filter(Boolean).length };
}

export function formatCheck(r, { cli = 'node tools/m59-substrate-archive.mjs' } = {}) {
  const lines = [];
  const rel = p => (isUnder(p, r.substrate) ? relS(r.substrate, p) : p);
  if (!r.broken.length && !r.configs.length) {
    lines.push(`no broken imports in ${r.substrate} (${r.files} module(s) scanned).`);
    return lines.join('\n');
  }
  if (r.broken.length) {
    lines.push(`${r.broken.length} broken import(s) in ${r.substrate} (${r.files} module(s) scanned):`);
    for (const b of r.broken) {
      lines.push(`  ${rel(b.from)}:${b.line}  ${b.kind} '${b.spec}'`);
      lines.push(`      missing ${rel(b.target)}`);
      if (b.archived.length) lines.push(`      archived: ${b.archived.map(a => rel(a.path)).join(', ')}`);
      else lines.push(b.inSubstrate ? '      no archived copy under scratch/archive-*/' : '      outside the substrate: not restorable from an archive');
    }
  }
  if (r.configs.length) {
    lines.push(`${r.configs.length} strategy assignment(s) name a module that is not there:`);
    for (const c of r.configs) {
      lines.push(`  ${rel(c.config)} (${c.where}): ${c.kind} strategy "${c.name}" -> missing ${rel(c.target)}`);
      if (c.archived.length) lines.push(`      archived: ${c.archived.map(a => rel(a.path)).join(', ')}`);
    }
  }
  if ([...r.broken, ...r.configs].some(b => b.archived.length))
    lines.push('', `restore (dry first): M59_SUBSTRATE_DIR="${r.substrate}" ${cli} restore-missing   then  --apply`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------------------------

/** What a request names: an absolute or substrate-relative path, or a module name found in an archive. */
export function resolveRestoreTarget(substrate, request) {
  substrate = resolve(substrate);
  const req = String(request);
  const cands = isAbsolute(req) ? [req] : [join(substrate, req), resolve(req)];
  if (!CODE_EXT.test(req)) cands.push(...cands.map(c => `${c}.mjs`));
  for (const c of cands) if (isUnder(c, substrate) && (existsSync(c) || findArchived(substrate, c).length)) return { target: resolve(c) };
  // By name: the newest archive holding <name> or <name>.mjs anywhere.
  const want = new Set([basename(req).toLowerCase(), `${basename(req)}.mjs`.toLowerCase()]);
  const hits = new Map();
  for (const a of listArchives(substrate)) {
    const root = existsSync(join(a, 'substrate')) ? join(a, 'substrate') : a;
    const go = (dir, depth) => {
      let ents = []; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = join(dir, e.name);
        if (e.isDirectory() && depth < 8) go(p, depth + 1);
        else if (e.isFile() && want.has(e.name.toLowerCase())) {
          const t = join(substrate, relative(root, p));
          if (!hits.has(key(t))) hits.set(key(t), t);
        }
      }
    };
    go(root, 0);
  }
  if (hits.size === 1) return { target: [...hits.values()][0] };
  if (hits.size > 1) return { target: null, why: `"${req}" is ambiguous in the archives: ${[...hits.values()].map(h => relS(substrate, h)).join(', ')}` };
  return { target: null, why: `nothing named "${req}" is live or archived under ${join(substrate, 'scratch', 'archive-*')}` };
}

/**
 * The moves that bring `targets` (live paths that do not exist) back, plus — transitively — every
 * relative import of a restored module that is missing too. Imports are resolved against the file's
 * ORIGINAL location, which is where it is going.
 *   -> { moves: [{ from, to, archive }], missing: [paths with no archived copy], exists: [paths already live] }
 */
export function planRestore(substrate, targets) {
  substrate = resolve(substrate);
  const moves = [], missing = [], already = [], seen = new Set();
  const queue = [].concat(targets).map(t => resolve(t));
  while (queue.length) {
    const t = queue.shift();
    if (seen.has(key(t))) continue;
    seen.add(key(t));
    if (existsSync(t)) { already.push(t); continue; }
    if (!isUnder(t, substrate) || relS(substrate, t).startsWith('scratch/')) { missing.push(t); continue; }
    const arch = findArchived(substrate, t)[0];
    if (!arch) { missing.push(t); continue; }
    moves.push({ from: arch.path, to: t, archive: arch.archive });
    if (CODE_EXT.test(t)) {
      let src = ''; try { src = readFileSync(arch.path, 'utf8'); } catch { /* unreadable */ }
      for (const i of parseImports(src)) {
        const dep = resolveSpec(t, i.spec);
        if (dep && isUnder(dep, substrate) && !existsSync(dep)) queue.push(dep);
      }
    }
  }
  return { moves, missing, exists: already };
}

/** Every missing in-substrate import reachable from `entry` through live files (entry may be outside). */
export function missingFromEntry(substrate, entry) {
  substrate = resolve(substrate);
  const out = [], seen = new Set(), queue = [resolve(entry)];
  const entryRoot = dirname(resolve(entry));
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(key(f))) continue;
    seen.add(key(f));
    let src; try { src = readFileSync(f, 'utf8'); } catch { continue; }
    for (const i of parseImports(src)) {
      const t = resolveSpec(f, i.spec);
      if (!t) continue;
      if (!existsSync(t)) { if (isUnder(t, substrate)) out.push(t); continue; }
      if (CODE_EXT.test(t) && (isUnder(t, substrate) || isUnder(t, entryRoot))) queue.push(t);
    }
  }
  return [...new Map(out.map(t => [key(t), t])).values()];
}

function assertSafeMove(substrate, from, to) {
  const archives = listArchives(substrate);
  if (!archives.some(a => isUnder(from, a))) throw new Error(`refusing to restore from outside ${join(substrate, 'scratch', 'archive-*')}: ${from}`);
  if (!isUnder(to, substrate)) throw new Error(`refusing to restore outside the substrate: ${to}`);
  if (relS(substrate, to).startsWith('scratch/')) throw new Error(`refusing to restore into scratch/: ${to}`);
}

/** Carry out a planRestore. Never overwrites; each move is checked again at the moment it happens. */
export function applyRestore(substrate, plan, { reason = 'restore', log = () => {} } = {}) {
  substrate = resolve(substrate);
  const done = [], refused = [];
  for (const m of plan.moves) {
    try {
      assertSafeMove(substrate, m.from, m.to);
      if (existsSync(m.to)) throw new Error(`refusing to overwrite ${m.to}`);
      mkdirSync(dirname(m.to), { recursive: true });
      copyFileSync(m.from, m.to, FS.COPYFILE_EXCL);
      unlinkSync(m.from);
      done.push(m);
      try { appendFileSync(join(m.archive, 'RESTORED.txt'), `${new Date().toISOString()}\t${relS(m.archive, m.from)}\t-> ${relS(substrate, m.to)}\t(${reason})\n`); } catch { /* the move stands */ }
      log(`restored ${relS(substrate, m.to)} from ${relS(substrate, m.from)}`);
    } catch (e) { refused.push({ ...m, why: e.message }); }
  }
  return { restored: done, refused };
}

// ---------------------------------------------------------------------------------------------
// Automatic restore, for the places an old strategy or errand is revived
// ---------------------------------------------------------------------------------------------

/** The path an ERR_MODULE_NOT_FOUND names, and the file that imported it. */
export function missingModuleFromError(e) {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') return null;
  const msg = String(e.message ?? '');
  const asPath = s => { try { return /^file:/i.test(s) ? fileURLToPath(s) : resolve(s); } catch { return null; } };
  const m = /Cannot find (?:module|package) '([^']+)'/.exec(msg);
  const from = /imported from (.+?)\s*$/m.exec(msg);
  let missing = m ? asPath(m[1]) : null;
  if (!missing && e.url) missing = asPath(e.url);
  return missing ? { missing, importer: from ? asPath(from[1].trim()) : null } : null;
}

/** The substrate a path lives in: its nearest ancestor called `substrate`, else the default if under it. */
export function substrateFor(p, fallback = defaultSubstrate()) {
  if (!p) return null;
  let d = resolve(p);
  for (;;) {
    if (basename(d).toLowerCase() === 'substrate' && existsSync(d)) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return fallback && isUnder(p, fallback) ? fallback : null;
}

/**
 * The restore an import failure asks for. Restores the module the error names AND every other missing
 * in-substrate import reachable from `entry` (the module being loaded) — an error names only the FIRST
 * missing import, and bastion.mjs was missing seven, so restoring one and retrying would fail six times.
 *   -> { attempted, restored: [{from, to}], missing: [paths], refused, substrate, summary }
 */
export function autoRestore(e, { entry = null, substrate = null, log = m => console.error(m) } = {}) {
  const hit = missingModuleFromError(e);
  if (!hit) return { attempted: false, restored: [], missing: [], refused: [], substrate: null, summary: null };
  const sub = substrate ?? substrateFor(hit.missing) ?? substrateFor(hit.importer) ?? substrateFor(entry);
  if (!sub || !isUnder(hit.missing, sub)) {
    return { attempted: true, restored: [], missing: [hit.missing], refused: [], substrate: sub,
      summary: `missing ${hit.missing} (outside any substrate: not restorable from an archive)` };
  }
  const wanted = [hit.missing, ...(entry ? missingFromEntry(sub, entry) : []), ...(hit.importer ? missingFromEntry(sub, hit.importer) : [])];
  const plan = planRestore(sub, wanted);
  const r = applyRestore(sub, plan, { reason: `auto-restore on import of ${entry ?? hit.importer ?? hit.missing}` });
  const rel = p => relS(sub, p);
  for (const m of r.restored)
    log(`[substrate-archive] AUTO-RESTORED ${rel(m.to)} from ${rel(m.from)} -- it was archived while still imported`);
  const missing = plan.missing.filter(p => !r.restored.some(m => key(m.to) === key(p)));
  const parts = [];
  if (r.restored.length) parts.push(`auto-restored ${r.restored.map(m => `${rel(m.to)} (from ${rel(m.archive)})`).join(', ')}`);
  if (missing.length) parts.push(`missing with no archived copy: ${missing.map(rel).join(', ')}`);
  if (r.refused.length) parts.push(`refused: ${r.refused.map(m => m.why).join('; ')}`);
  if (!r.restored.length) parts.push(`run: M59_SUBSTRATE_DIR="${sub}" node tools/m59-substrate-archive.mjs check`);
  return { attempted: true, restored: r.restored, missing, refused: r.refused, substrate: sub, summary: parts.join('; ') };
}

/**
 * import(url), and on ERR_MODULE_NOT_FOUND restore what the archives hold and retry ONCE under a new
 * URL (Node caches a failed module graph by URL). The thrown error carries `.autoRestore`.
 *   -> { mod, restored: autoRestore result | null }
 */
export async function importWithAutoRestore(url, { entry = null, substrate = null, importer = u => import(u),
                                                   log = m => console.error(m) } = {}) {
  try { return { mod: await importer(url), restored: null }; }
  catch (e) {
    let file = entry;
    if (!file) { try { file = fileURLToPath(String(url).replace(/[?#].*$/, '')); } catch { file = null; } }
    const r = autoRestore(e, { entry: file, substrate, log });
    if (!r.attempted) throw e;
    if (!r.restored.length) { e.autoRestore = r; e.message = `${e.message} [${r.summary}]`; throw e; }
    const retry = `${url}${String(url).includes('?') ? '&' : '?'}restored=${Date.now()}`;
    try { return { mod: await importer(retry), restored: r }; }
    catch (e2) { e2.autoRestore = r; e2.message = `${e2.message} [after ${r.summary}]`; throw e2; }
  }
}

// ---------------------------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------------------------

function expandPaths(substrate, paths) {
  const out = [], bad = [];
  for (const p of paths) {
    const cands = isAbsolute(p) ? [p] : [resolve(p), join(substrate, p)];
    const hit = cands.find(c => existsSync(c));
    if (!hit) { bad.push(`${p}: does not exist`); continue; }
    if (!isUnder(hit, substrate) || resolve(hit) === resolve(substrate)) { bad.push(`${p}: not inside ${substrate}`); continue; }
    if (relS(substrate, hit).startsWith('scratch/')) { bad.push(`${p}: already in scratch/`); continue; }
    if (statSync(hit).isDirectory()) {
      const go = d => { for (const e of readdirSync(d, { withFileTypes: true })) { const q = join(d, e.name); e.isDirectory() ? go(q) : out.push(resolve(q)); } };
      go(hit);
    } else out.push(resolve(hit));
  }
  return { files: [...new Map(out.map(f => [key(f), f])).values()], bad };
}

/**
 * What archiving `paths` would do, and whether it is allowed.
 *   -> { ok, files, closure, blockers: [{ file, importers, configs }], warnings, moves: [{from, to}], dest, problems }
 */
export function planMove(substrate, paths, { to = null, withImporters = false, graph = null, env = process.env } = {}) {
  substrate = resolve(substrate);
  const problems = [];
  const { files, bad } = expandPaths(substrate, paths);
  problems.push(...bad);
  const g = graph ?? buildGraph({ substrate, env });
  const dest = resolve(to ? (isAbsolute(to) ? to : join(substrate, to)) : join(substrate, 'scratch', `archive-${today()}`));
  if (!isUnder(dest, join(substrate, 'scratch')) || !/^archive-/.test(relS(join(substrate, 'scratch'), dest).split('/')[0]))
    problems.push(`--to must be ${join(substrate, 'scratch', 'archive-<label>')}, not ${dest}`);
  const closure = new Map(files.map(f => [key(f), f]));
  const importersOf = f => [...(g.importers.get(key(f)) ?? [])];
  if (withImporters) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of [...closure.values()]) {
        for (const imp of importersOf(f)) {
          if (closure.has(key(imp)) || !isUnder(imp, substrate)) continue;
          closure.set(key(imp), resolve(imp)); grew = true;
        }
      }
    }
  }
  const blockers = [];
  for (const f of closure.values()) {
    const importers = importersOf(f).filter(i => !closure.has(key(i)));
    const configs = g.configs.filter(c => c.exists && key(c.target) === key(f)).map(c => ({ config: c.config, where: c.where, kind: c.kind, name: c.name }));
    if (importers.length || configs.length) blockers.push({ file: f, importers, configs });
  }
  // Data files are read by name, not imported: a WARNING, since logs are named by the code that writes them.
  const warnings = [];
  const liveSrc = [...g.nodes.values()].filter(n => n && !closure.has(key(n.file)));
  for (const f of closure.values()) {
    if (CODE_EXT.test(f)) continue;
    const b = basename(f);
    const re = new RegExp(`['"\`/]${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
    const by = liveSrc.filter(n => re.test(n.src)).map(n => n.file);
    if (by.length) warnings.push({ file: f, namedBy: by });
  }
  const moves = [...closure.values()].map(f => ({ from: f, to: join(dest, 'substrate', relative(substrate, f)) }));
  for (const m of moves) if (existsSync(m.to)) problems.push(`the archive already holds ${m.to}`);
  return { ok: !problems.length && !blockers.length, substrate, files, closure: [...closure.values()], blockers, warnings, moves, dest, problems };
}

/** Carry out an allowed planMove: copy-exclusive then unlink, MOVED.txt appended, README written once. */
export function applyMove(plan, { log = () => {} } = {}) {
  if (!plan.ok) throw new Error('refusing to apply a move plan that was refused');
  const moved = [];
  mkdirSync(plan.dest, { recursive: true });
  for (const m of plan.moves) {
    mkdirSync(dirname(m.to), { recursive: true });
    copyFileSync(m.from, m.to, FS.COPYFILE_EXCL);
    unlinkSync(m.from);
    moved.push(m);
    appendFileSync(join(plan.dest, 'MOVED.txt'), `substrate/${relS(plan.substrate, m.from)}\n`);
    log(`moved ${relS(plan.substrate, m.from)}`);
  }
  const readme = join(plan.dest, 'README.txt');
  if (!existsSync(readme)) {
    writeFileSync(readme,
      `Archived ${new Date().toISOString()} by tools/m59-substrate-archive.mjs move.\n` +
      'Each file keeps its path relative to the checkout root (substrate/<path>); MOVED.txt lists them.\n' +
      'Nothing here was imported by live substrate code or named by a strategy assignment when it moved.\n' +
      'Put a module back (and its own archived imports) with:\n' +
      `  M59_SUBSTRATE_DIR="${plan.substrate}" node tools/m59-substrate-archive.mjs restore <file-or-module> --apply\n` +
      'Never move files back by hand over a live file; restore refuses to overwrite.\n');
  }
  return { moved };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function cli(argv) {
  const args = argv.slice(2);
  const flag = f => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true; };
  const opt = f => { const i = args.indexOf(f); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
  const apply = flag('--apply'), json = flag('--json'), withImporters = flag('--with-importers');
  const to = opt('--to');
  const substrate = resolve(opt('--substrate') ?? defaultSubstrate());
  const [cmd, ...rest] = args;
  const out = o => console.log(json ? JSON.stringify(o, (k, v) => (k === 'src' ? undefined : v), 2) : o);
  const rel = p => (isUnder(p, substrate) ? relS(substrate, p) : p);

  if (cmd === 'check') {
    const r = checkSubstrate({ substrate });
    out(json ? r : formatCheck(r));
    return r.broken.length || r.configs.length ? 1 : 0;
  }
  if (cmd === 'move') {
    if (!rest.length) { console.error('move <paths...> [--to scratch/archive-<label>] [--with-importers] [--apply]'); return 2; }
    const p = planMove(substrate, rest, { to, withImporters });
    if (json) out({ ...p, applied: false });
    else {
      for (const x of p.problems) console.log(`problem: ${x}`);
      for (const b of p.blockers) {
        console.log(`REFUSED: ${rel(b.file)} is still in use`);
        for (const i of b.importers) console.log(`    imported by ${rel(i)}`);
        for (const c of b.configs) console.log(`    named by ${rel(c.config)} (${c.where}) as ${c.kind} strategy "${c.name}"`);
      }
      for (const w of p.warnings) console.log(`warning: ${rel(w.file)} is named (as data) by ${w.namedBy.map(rel).join(', ')}`);
      if (p.ok) {
        console.log(`${p.moves.length} file(s) -> ${rel(p.dest)}/substrate/${withImporters ? '  (closure, with importers)' : ''}`);
        for (const m of p.moves) console.log(`  ${rel(m.from)}`);
      } else if (p.blockers.length && !withImporters) console.log('\nnothing moved. Archive the importers too with --with-importers, or leave these files where they are.');
    }
    if (!p.ok) return 1;
    if (!apply) { if (!json) console.log('\ndry run: nothing moved. Add --apply to act.'); return 0; }
    applyMove(p, { log: m => console.log(m) });
    return 0;
  }
  if (cmd === 'restore' || cmd === 'restore-missing') {
    let targets = [];
    if (cmd === 'restore') {
      if (!rest[0]) { console.error('restore <file-or-module> [--apply]'); return 2; }
      const t = resolveRestoreTarget(substrate, rest[0]);
      if (!t.target) { console.error(t.why); return 1; }
      if (existsSync(t.target)) {
        // The module itself is live; bring back only what it is missing.
        targets = missingFromEntry(substrate, t.target);
        if (!targets.length) { console.log(`${rel(t.target)} is live and resolves; nothing to restore (restore never overwrites).`); return 0; }
      } else targets = [t.target];
    } else {
      const r = checkSubstrate({ substrate });
      targets = [...r.broken.filter(b => b.inSubstrate).map(b => b.target), ...r.configs.map(c => c.target)];
    }
    const plan = planRestore(substrate, targets);
    if (json && !apply) { out(plan); return plan.missing.length ? 1 : 0; }
    for (const m of plan.moves) console.log(`${apply ? 'restoring' : 'would restore'} ${rel(m.to)}  <-  ${rel(m.from)}`);
    for (const m of plan.missing) console.log(`missing, no archived copy: ${rel(m)}`);
    if (!plan.moves.length) console.log('nothing to restore.');
    if (!apply) { if (plan.moves.length) console.log('\ndry run: nothing moved. Add --apply to act.'); return plan.missing.length ? 1 : 0; }
    const r = applyRestore(substrate, plan, { reason: cmd, log: m => console.log(m) });
    for (const x of r.refused) console.log(`refused: ${x.why}`);
    return r.refused.length || plan.missing.length ? 1 : 0;
  }
  console.error('usage: m59-substrate-archive.mjs check | move <paths...> [--to ...] [--with-importers] | restore <file-or-module> | restore-missing   [--apply] [--substrate <dir>] [--json]');
  return 2;
}

const isMain = (() => {
  try { return !!process.argv[1] && key(process.argv[1]) === key(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) process.exitCode = cli(process.argv);
