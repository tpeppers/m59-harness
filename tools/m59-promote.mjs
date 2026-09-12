#!/usr/bin/env node
// ScratchToScript() — TURN A PAD INTO A FLEETSCRIPT, OR SAY WHY IT IS NOT ONE YET.
//
//   > promote raid-farnohl                     in the session: check, generate, verify, move
//   node tools/m59-promote.mjs check <pad>     what is standing between this pad and v1.0
//   node tools/m59-promote.mjs runs <pad>      what evidence exists that it works
//
// ============================================================ WHAT PROMOTION ACTUALLY CHANGES
//
// Nothing about the steps. A pad's only output is `steps[]` and a fleetscript's is the same
// array, so if promotion had to rewrite the errand to make it runnable, the pad had been allowed
// to do something a fleetscript cannot and m59-fleetscratch.mjs was wrong. What changes is the
// CLAIM: docs/m59-fleetscratch.md says a pad's findings "are allowed to be provisional — that is
// the whole reason pads exist. They stop being allowed to be provisional at promotion."
//
// So this file is mostly refusals, and each one is a way a promoted script has actually gone
// wrong or would obviously go wrong:
//
//   PROVENANCE    A fleetscript pins the code it was written against. Without it a future
//                 reader cannot tell whether a number is still true, and "cite kod/file:line"
//                 is the standing rule in every report this repository writes.
//
//   EVIDENCE      At least one recorded run that SUCCEEDED and was not sliced. A pad promoted
//                 on a `runUntil=step-4` run is a claim about four steps wearing the name of
//                 eleven — which is exactly the shape of error m59-resume.mjs exists to stop,
//                 so it would be perverse to let promotion launder it back in.
//
//   PROD          A checkpoint that can only be reached by `dm`, `scene` or `shadow` is a lab
//                 affordance. The doc's own sentence: "The deliverable is the prod walk. A route
//                 that only works with spawns off is not done; it is diagnosed." A promoted
//                 script runs on production, so every checkpoint it carries needs a `played`
//                 route — or the pad stays a pad, which is not a failure, it is the honest state.
//
//   NO PAD IMPORTS  "A promoted fleetscript may not import a pad, checked when it is promoted"
//                 — m59-fleetscratch.mjs's third containment rule, and this is the check it
//                 refers to. A script that imports m59-padcheck.mjs or reaches back into
//                 substrate/fleetscratch/ drags the operator-only stack into a file that a
//                 keeper may load by name.
//
// ============================================================ AND IT IS VERIFIED BY RE-COMPILING
//
// The generated file is written to a temporary path, LOADED BACK through the same
// loadFleetScripts the harness uses, and its compiled steps are diffed against the pad's. Only
// if they match does it move into tools/fleetscripts/.
//
// That check is not ceremony; it is the one that catches the failure this kind of generator
// always has. `Function.prototype.toString()` gives the source of a function and NOT its
// closure, so a `steps` that calls a helper defined beside it in the pad emits source that
// references a name the generated file has never heard of. The symptom is a ReferenceError at
// load — which the diff turns into "this pad has a helper you have not declared as a composite",
// named, before anything is left on disk.
//
// Hence `composites`: the pad declares the helpers it wants carried across, and they are emitted
// as real exported functions. That is the operator's ask — "making new internal functions ...
// that later get broken into their own scripts/libraries when you call ScratchToScript()" — and
// the verification is what makes it safe to do mechanically.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, rmSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCheckpoint } from './m59-establish.mjs';
import { marksOf } from './m59-resume.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

export const SCRIPT_DIR = process.env.M59_FLEETSCRIPT_OUT || join(REPO, 'tools', 'fleetscripts');
export const RUNS_FILE = process.env.M59_SCRATCH_RUNS ||
  join(REPO, 'substrate', 'fleetscratch-runs.jsonl');

// Modules a promoted script may never reach for. The first two are the operator-only stack; the
// third is the pad directory itself, imported by relative path.
export const PAD_ONLY = Object.freeze(['m59-padcheck.mjs', 'm59-fleetscratch.mjs',
                                       'm59-fleetscratch-session', 'fleetscratch/']);

// ------------------------------------------------------------------ what has actually been run
//
// APPEND-ONLY AND LOCAL. One line per `go`, never rewritten, and not committed: it is this
// machine's record of what this fleet did, the same class of fact as the keeper state files.
// A JSON line that will not parse is SKIPPED rather than fatal — a half-written last line
// (the session was killed mid-write) must not make the whole history unreadable.
export function recordRun(row, { file = RUNS_FILE } = {}) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
    return true;
  } catch { return false; }
}

export function readRuns({ file = RUNS_FILE, pad = null } = {}) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!pad || row.pad === pad) out.push(row);
    } catch { /* a torn last line is not a reason to lose the rest */ }
  }
  return out;
}

/**
 * Is there evidence this errand works?
 *
 * A run counts only if it SUCCEEDED and ran the whole list. Partial is disqualifying rather than
 * weighted, because there is no honest way to average "the first four steps worked" with "all
 * eleven worked" — they are statements about different errands.
 */
export function evidenceFor(pad, { file = RUNS_FILE, runs = null } = {}) {
  const rows = runs ?? readRuns({ file, pad: pad.name });
  const whole = rows.filter(r => r.ok && !r.partial);
  const partial = rows.filter(r => r.ok && r.partial);
  return {
    ok: whole.length > 0, runs: rows.length, whole: whole.length, partial: partial.length,
    last: whole[whole.length - 1] ?? null,
    why: whole.length ? null
      : rows.length === 0
        ? `nothing has ever run this pad to completion — there is no record of it working at all`
        : partial.length
          ? `${partial.length} run(s) succeeded but every one was SLICED (skipTo/runUntil). A ` +
            `partial run is a claim about the steps that ran, not about the errand. Run it whole ` +
            `once.`
          : `${rows.length} run(s) recorded and none of them succeeded`,
  };
}

// ------------------------------------------------------------------ is this pad a script yet
const importLines = (src) =>
  [...String(src).matchAll(/^\s*import\s[^\n]*?from\s*['"]([^'"]+)['"];?\s*$/gm)]
    .map(m => ({ line: m[0].trim(), from: m[1] }));

/** Everything standing between this pad and a v1.0 file, each with what to do about it. */
export function promotionBlockers(pad, { source = null, file = RUNS_FILE, runs = null,
                                         scriptDir = SCRIPT_DIR, steps = null } = {}) {
  const out = [];
  const add = (what, why, fix) => out.push({ what, why, fix });

  if (!pad?.name) add('name', 'the pad declares no name', 'give it `name:`');

  // ---- provenance: the pin that makes a future reader able to check it
  const prov = pad?.provenance;
  const cites = prov && (prov.kod || prov.files || prov.cite || prov.sources);
  if (!prov)
    add('provenance', 'a fleetscript pins the code it was written against, and this declares none',
        `add \`provenance: { kod: ['kod/path/file.kod:123'], why: '...' }\``);
  else if (!cites)
    add('provenance', 'provenance is declared but cites no source file',
        'name at least one kod/path/file.kod:line the behaviour was read from');

  // ---- evidence
  const ev = evidenceFor(pad, { file, runs });
  if (!ev.ok) add('evidence', ev.why, 'run it whole once with `go`, then promote');

  // ---- prod reachability: a lab-only checkpoint is a diagnosis, not a deliverable
  for (const st of [].concat(pad?.setup ?? []).filter(Boolean)) {
    if (!isCheckpoint(st)) continue;
    if (!st.establish?.played)
      add('lab-only', `the checkpoint "${st.name}" can only be reached by ` +
                      `${st.ways.join('/')} — every one of those is a lab instrument`,
          `give it \`establish.played\`: the in-game way to get there. If there is no in-game ` +
          `way, this pad is a diagnosis and should stay a pad.`);
  }

  // ---- the operator-only stack must not travel
  for (const imp of importLines(source ?? '')) {
    const bad = PAD_ONLY.find(p => imp.from.includes(p));
    if (bad)
      add('pad import', `it imports ${imp.from}, which is part of the operator-only pad stack`,
          `a promoted script may be loaded by a keeper, so it may not reach back into the pad ` +
          `machinery. Move what you need into a shared module, or declare it as a composite.`);
  }

  // ---- unsafe waivers do not survive promotion unexamined
  if (pad?.unsafe)
    add('unsafe', `it carries an \`unsafe\` waiver: ${JSON.stringify(pad.unsafe)}`,
        `a waiver written to get a pad moving is not a waiver a committed errand should inherit. ` +
        `Drop it, or restate it here with the reason it is still true.`);

  // ---- a name already taken is a silent overwrite
  const dest = join(scriptDir, `${pad?.name}.mjs`);
  if (pad?.name && existsSync(dest))
    add('collision', `tools/fleetscripts/${pad.name}.mjs already exists`,
        `pick another name, or delete the old one on purpose — promotion will not overwrite`);

  // ---- marks are fine to keep, but a mark nothing covers is dead weight worth saying
  const dead = steps ? marksOf(steps).map(m => m.mark)
    .filter(m => ![].concat(pad?.setup ?? []).filter(isCheckpoint).some(c => c.covers?.includes(m)))
    : [];
  return { ok: out.length === 0, blockers: out, evidence: ev, deadMarks: dead, dest };
}

export function formatBlockers(res, pad) {
  if (res.ok)
    return `${pad?.name ?? 'this pad'} is promotable — ${res.evidence.whole} whole run(s) on ` +
           `record, last ${res.evidence.last?.at ?? '?'}`;
  const out = [`${pad?.name ?? 'this pad'} is not a fleetscript yet — ${res.blockers.length} ` +
               `thing(s) in the way:`];
  for (const b of res.blockers) {
    out.push(`  ${b.what}: ${b.why}`);
    out.push(`    -> ${b.fix}`);
  }
  if (res.deadMarks.length)
    out.push(`  (marks no checkpoint covers, so nothing may skip to them: ${res.deadMarks.join(', ')})`);
  return out.join('\n');
}

// ------------------------------------------------------------------ generating the file
//
// An arrow keeps its own source; a `function f()` keeps its name. Both are emitted so that the
// generated file reads like something a person wrote, because somebody is going to have to edit
// it next month.
const emitFn = (name, fn) => {
  const src = String(fn).trim();
  return /^(async\s+)?function\b/.test(src) && src.includes(name)
    ? `export ${src}`
    : `export const ${name} = ${src};`;
};

/** The names an import statement binds: default, namespace, and each named or renamed specifier. */
export function boundNames(line) {
  const names = [];
  const m = /^\s*import\s+([\s\S]*?)\s+from\s/.exec(line);
  if (!m) return names;
  const clause = m[1];
  const braces = /\{([\s\S]*?)\}/.exec(clause);
  if (braces)
    for (const part of braces[1].split(','))
      if (part.trim()) names.push(part.trim().split(/\s+as\s+/).pop().trim());
  const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
  if (ns) names.push(ns[1]);
  const dflt = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause.replace(/\{[\s\S]*?\}/, ''));
  if (dflt) names.push(dflt[1]);
  return [...new Set(names)];
}

/**
 * The imports a promoted file keeps.
 *
 * Two filters, and the second is the one that was missing. The first drops the operator-only
 * stack, which is a refusal. The second drops imports NOTHING IN THE GENERATED BODY USES — and
 * the common case is `checkpoint`, because a pad imports it for its setup and the setup is
 * exactly what promotion leaves behind. An unused import is not merely untidy: it points a
 * reader at a module the errand does not use, and it makes a committed fleetscript load the
 * establish machinery for no reason.
 *
 * `body` is the emitted steps and composites. A name is kept if it appears there as a WORD, which
 * over-keeps rather than under-keeps: matching a name inside a string still keeps the import, and
 * the failure mode of keeping one too many is a tidiness problem while dropping one too few is a
 * file that will not load.
 */
export function carriedImports(source, body = null) {
  const kept = importLines(source ?? '')
    .filter(i => !PAD_ONLY.some(p => i.from.includes(p)));
  if (body == null) return kept.map(i => i.line);
  return kept.filter(i => {
    const names = boundNames(i.line);
    if (!names.length) return true;                 // a side-effect import: keep it, it is deliberate
    // Built with string concatenation rather than a template literal: `` inside a
    // template is the BACKSPACE escape, not a word boundary, so the first version of this
    // matched nothing and dropped every import. One escape level is easier to be right about.
    return names.some(n => new RegExp('\\b' + n + '\\b').test(body));
  }).map(i => i.line);
}

export function generate(pad, { source = '', shape = [], evidence = null, at = new Date() } = {}) {
  const L = [];
  L.push(`// ${String(pad.describe ?? pad.name).toUpperCase()}`);
  L.push('//');
  L.push(`// PROMOTED FROM A PAD by tools/m59-promote.mjs on ${at.toISOString().slice(0, 10)}.`);
  L.push('// The steps below are the pad\'s steps unchanged — promotion never rewrites an errand,');
  L.push('// because a pad that needed rewriting to run was allowed to do something a fleetscript');
  L.push('// cannot, and that would be a bug in the pad stack rather than work for this file.');
  L.push('//');
  if (evidence?.last) {
    L.push(`// EVIDENCE AT PROMOTION: ${evidence.whole} whole run(s) recorded, the last on`);
    L.push(`// ${evidence.last.at} across ${(evidence.last.agents ?? []).length} character(s)` +
           `${evidence.last.fleet ? ` of fleet "${evidence.last.fleet}"` : ''}.`);
    L.push('//');
  }
  if (shape.length) {
    L.push('// THE SHAPE IT COMPILED TO AT PROMOTION. This is here to be diffed: if you change the');
    L.push('// steps and this list no longer describes them, say so here rather than leaving a');
    L.push('// reader to find out by running it.');
    for (const [i, s] of shape.entries()) L.push(`//   ${i}. ${s}`);
    L.push('//');
  }
  if (pad.notes?.length) {
    L.push('// WHAT THE PAD LEARNED, kept because it is the reason the steps are in this order:');
    for (const n of [].concat(pad.notes)) L.push(`//   ${n}`);
    L.push('//');
  }
  L.push('// WHAT WAS LEFT BEHIND: the pad\'s setup, teardown and checkpoints. Those configure the');
  L.push('// world over the DM socket, which a committed errand does not get — a fleetscript walks');
  L.push('// into the state it needs or fails saying it could not.');
  // THE BODY IS BUILT FIRST, so the import list can be chosen against what actually uses it.
  // A pad imports `checkpoint` for its setup, and the setup is precisely what promotion leaves
  // behind — carrying that import forward would make every promoted errand load the establish
  // machinery to use none of it.
  const comps = Object.entries(pad.composites ?? {});
  const body = [String(pad.steps), ...comps.map(([n, f]) => emitFn(n, f))].join('\n');
  const imports = carriedImports(source, body);
  if (imports.length) { L.push(''); for (const i of imports) L.push(i); }

  if (comps.length) {
    L.push('');
    L.push('// ---------------------------------------------------------------- carried composites');
    L.push('// Declared as `composites` on the pad and emitted here as real functions, which is');
    L.push('// what makes them reusable by the next errand instead of copied out of a scratchpad.');
    for (const [n, fn] of comps) { L.push(''); L.push(emitFn(n, fn)); }
  }

  L.push('');
  // `export const script`, not `export default`. Both load — m59-fleetlib.mjs takes
  // `mod.script ?? mod.default` — but every committed fleetscript uses the named form, and a
  // promoted file that reads differently from its fifteen neighbours is a file people hesitate
  // over. Generated code should be indistinguishable from the code around it.
  L.push('export const script = {');
  L.push(`  name: ${JSON.stringify(pad.name)},`);
  if (pad.describe) L.push(`  describe: ${JSON.stringify(pad.describe)},`);
  if (pad.recipe) L.push(`  recipe: ${JSON.stringify(pad.recipe, null, 2)
    .split('\n').join('\n  ')},`);
  if (pad.params) L.push(`  params: ${JSON.stringify(pad.params)},`);
  for (const tier of ['requires', 'capabilities', 'suggests'])
    if (pad[tier]) L.push(`  ${tier}: ${JSON.stringify(pad[tier])},`);
  if (pad.provenance) L.push(`  provenance: ${JSON.stringify(pad.provenance, null, 2)
    .split('\n').join('\n  ')},`);
  L.push('');
  L.push(`  steps: ${String(pad.steps).trim()},`);
  L.push('};');
  return L.join('\n') + '\n';
}

// ------------------------------------------------------------------ promote, and verify it
//
// `load` and `render` are injected for the same reason everything else here is: the verification
// has to run the REAL loader to be worth anything, and a test has to be able to run it without a
// fleet. The session passes loadFleetScripts and its own renderStep.
export async function promote(pad, { source = null, steps = [], render = (s) => s?.do ?? String(s),
                                     load = null, scriptDir = SCRIPT_DIR, file = RUNS_FILE,
                                     runs = null, force = false } = {}) {
  const src = source ?? (pad.file && existsSync(pad.file) ? readFileSync(pad.file, 'utf8') : '');
  const res = promotionBlockers(pad, { source: src, file, runs, scriptDir, steps });
  if (!res.ok && !force) return { ...res, ok: false, why: formatBlockers(res, pad) };

  const shape = [].concat(steps ?? []).map(render);
  const text = generate(pad, { source: src, shape, evidence: res.evidence });

  // WRITTEN SOMEWHERE IT CANNOT BE MISTAKEN FOR THE REAL THING, LOADED BACK, AND ONLY THEN MOVED.
  // A file that fails verification must not be left in tools/fleetscripts/ where the next
  // `loadFleetScripts` would pick it up: a broken errand present by name is worse than an absent
  // one, because the absent one cannot be run by mistake.
  //
  // AND IT IS STAGED INSIDE tools/fleetscripts/ RATHER THAN A TEMP DIRECTORY, which looks like
  // the wrong choice and is not: the generated file imports `../m59-fleetscript.mjs`, so it only
  // resolves from the directory it is going to live in. That makes removing it non-optional —
  // `listDir` in m59-fleetlib.mjs takes every *.mjs in the directory and does NOT skip dotfiles,
  // so a staging file left behind by a crash would be loaded as a real errand by the next caller.
  // Hence the finally.
  mkdirSync(scriptDir, { recursive: true });
  const staging = join(scriptDir, `.promoting-${pad.name}.mjs`);
  writeFileSync(staging, text);
  try {
    if (typeof load === 'function') {
      const back = await load(staging);
      if (back.error)
        return { ...res, ok: false, verified: false,
                 why: `the generated file does not load: ${back.error}\n` +
                      `  This is almost always a helper that lives in the pad's module scope. ` +
                      `Function.toString() carries source but not closure, so a steps() that ` +
                      `calls it emits a name the new file has never heard of. Declare it in ` +
                      `\`composites: { ... }\` on the pad and promote again.` };
      const got = [].concat(await Promise.resolve(back.steps) ?? []).map(render);
      const diff = shape.length !== got.length
        ? `${shape.length} step(s) became ${got.length}`
        : shape.map((s, i) => (s === got[i] ? null : `  ${i}. ${s}\n     became ${got[i]}`))
            .filter(Boolean).join('\n');
      if (diff)
        return { ...res, ok: false, verified: false,
                 why: `the generated file compiles to DIFFERENT steps than the pad:\n${diff}` };
    }
  } catch (e) {
    return { ...res, ok: false, verified: false,
             why: `verifying the generated file threw: ${e.message}` };
  } finally {
    rmSync(staging, { force: true });
  }

  writeFileSync(res.dest, text);
  return { ...res, ok: true, path: res.dest, verified: typeof load === 'function',
           bytes: text.length, shape,
           why: null };
}

export function formatPromotion(r, pad) {
  if (!r.ok) return `NOT PROMOTED — ${r.why}`;
  return [`promoted ${pad.name} -> ${r.path}`,
          r.verified
            ? '  verified: the generated file was loaded back and compiles to the same steps'
            : '  NOT verified: no loader was supplied, so nobody has checked it compiles',
          `  the pad is still on disk — promotion copies, it does not consume`].join('\n');
}

// ------------------------------------------------------------------ CLI
const invokedDirectly = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (invokedDirectly) {
  const [verb, name] = process.argv.slice(2);
  if (verb === 'runs') {
    const rows = readRuns({ pad: name ?? null });
    if (!rows.length) console.log(`no runs recorded${name ? ` for ${name}` : ''} (${RUNS_FILE})`);
    for (const r of rows)
      console.log(`${r.at}  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.partial ? `PARTIAL ${r.from}..${r.to - 1} of ${r.of}` : 'whole'}  ${r.pad}  ${(r.agents ?? []).join(',')}`);
  } else {
    console.log('usage: m59-promote.mjs runs [pad]');
    console.log('  `check` and `promote` need a loaded pad — run them from the fleetscratch session.');
  }
}
