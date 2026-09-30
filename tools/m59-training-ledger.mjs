// THE TRAINING LEDGER: WHAT A PRACTICE RUN COST AND WHAT IT BOUGHT, PER CHARACTER, WITH THE CODE THAT RAN IT.
//
//   import { trainingLedger, codeIdentity, summarizeTraining } from './m59-training-ledger.mjs';
//   const led = await trainingLedger({ agent: 't2' });          // resolves the file from the broker
//   await led.record({ kind: 'cast', spell: 'minor heal', outcome: 'success' });
//
// Operator, 2026-09-27: "when these two finish, I'd like to be able to say: how much wall clock time
// they spend practicing, how much money they spent, how many improves they got, how many total
// fizzles, successful casts, whether bought or chest/shared for getting the practice reagents, maybe
// number of rooms travelled ... and a git-sha for what code the practice-[school] script is from, so
// each character can later have a history and compare different stats/tactics/etc. inputs to find
// 'optimal' solutions."
//
// NOTHING IN THE EXISTING LEDGERS COULD ANSWER THAT. The fleet ledger records the keeper's own casts
// (buffs, create weapon) and purchases, and a practice cast sent through the broker or a keeper action
// never reaches it; `level_up` there is max health; the `abilities` advancement log is absent for a
// keeper-backed character. So this is its own file, and every practice tool writes to it.
//
// ONE FILE PER CHARACTER, UNDER THE BROKER'S OWN CHECKOUT. The usual ledger path is the checkout the
// TOOL runs from, and practice tools run from two (a runner from a worktree, a FleetScript from the
// deploy) — two files for one character's history. The broker's /health names the checkout holding
// the fleet (`root`), so every writer and the report agree:
//     <root>/substrate/history/<fleet>/training/<agent>.jsonl        (gitignored with history/)
//
// THE EVENTS. Every record carries t, iso, agent, character, run (an id shared by one run's records)
// and code {tool, git_sha, dirty, file_sha1}:
//   run_start / run_end   snapshot: {abilities: {name: n}, purse, reagents: {name: n}, room}
//   cast                  {spell, school, outcome: success|fizzle|refused|unknown, target?, why?}
//   restock               {item, qty, source: bought|chest|shared|bank, cost?, from?}
//   improve               {spell, from, to}   (read off ability snapshots, never assumed)
// Anything unknown is null and says so; a missing number is never written as 0.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BROKER = () => (process.env.M59_CONTROL_URL || 'http://127.0.0.1:8901').replace(/\/?$/, '/');

export async function brokerHealth() {
  const r = await fetch(`${BROKER()}health`, { signal: AbortSignal.timeout(15_000) });
  return r.json();
}

export function trainingPath({ root, fleet, agent }) {
  return join(root, 'substrate', 'history', fleet || 'default', 'training', `${agent}.jsonl`);
}

// WHICH CODE RAN. A tracked file names the commit its checkout is on and whether that checkout is
// dirty; an untracked local FleetScript (this machine's orders) has no commit that describes it, so
// the file's own content hash is recorded for every tool — two runs with the same hash ran the same
// code whatever git says.
export function codeIdentity(file) {
  const id = { tool: file.replace(/\\/g, '/').split('/').slice(-2).join('/'), git_sha: null, dirty: null, file_sha1: null };
  try { id.file_sha1 = createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 12); } catch {}
  try {
    const cwd = dirname(file);
    id.git_sha = execFileSync('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const tracked = execFileSync('git', ['-C', cwd, 'ls-files', '--error-unmatch', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    id.tracked = !!tracked;
    id.dirty = execFileSync('git', ['-C', cwd, 'status', '--porcelain', '--', file], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '';
  } catch { if (id.git_sha) id.tracked = false; }
  return id;
}

export async function trainingLedger({ agent, run = null, code = null, health = null } = {}) {
  const h = health ?? await brokerHealth();
  const character = h?.session_characters?.[agent] ?? null;
  const path = trainingPath({ root: h.root, fleet: h.fleet, agent });
  const runId = run ?? `${agent}-${Date.now().toString(36)}`;
  await mkdir(dirname(path), { recursive: true });
  return {
    path, run: runId, character,
    async record(evt) {
      const t = Date.now();
      const row = { t, iso: new Date(t).toISOString(), agent, character, run: runId, ...(code ? { code } : {}), ...evt };
      await appendFile(path, JSON.stringify(row) + '\n').catch(() => {});
      return row;
    },
  };
}

export async function readTraining(path) {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// THE AGGREGATE, AS A PURE FUNCTION OF THE EVENTS, so the report and its test agree by construction.
//
// Wall clock is the sum of RUN durations (run_start to run_end, or to the run's last event when a
// run ended without saying so), never first-to-last: a character idle between runs was not practising.
// Improves are counted from `improve` events, and cross-checked against the first and last snapshot.
export function summarizeTraining(events, { school = null, since = 0 } = {}) {
  const ev = events.filter(e => (e.t ?? 0) >= since && (!school || !e.school || sameSchool(e.school, school)));
  const runs = new Map();
  for (const e of ev) {
    const r = runs.get(e.run) ?? { run: e.run, first: e.t, last: e.t, start: null, end: null, code: e.code ?? null };
    r.first = Math.min(r.first, e.t); r.last = Math.max(r.last, e.t);
    if (e.kind === 'run_start') r.start = e; if (e.kind === 'run_end') r.end = e;
    if (!r.code && e.code) r.code = e.code;
    runs.set(e.run, r);
  }
  const ms = [...runs.values()].reduce((n, r) => n + ((r.end?.t ?? r.last) - (r.start?.t ?? r.first)), 0);
  const casts = {}, improves = {}, restock = {};
  for (const e of ev) {
    if (e.kind === 'cast') {
      const c = casts[e.spell] ??= { success: 0, fizzle: 0, refused: 0, unknown: 0 };
      c[e.outcome in c ? e.outcome : 'unknown']++;
    }
    if (e.kind === 'improve') {
      const i = improves[e.spell] ??= { improves: 0, from: e.from, to: e.to };
      i.improves += Math.max(0, (e.to ?? 0) - (e.from ?? 0)); i.to = e.to;
    }
    if (e.kind === 'restock') {
      const k = `${e.item}|${e.source}`;
      const r = restock[k] ??= { item: e.item, source: e.source, qty: 0, cost: 0, costKnown: true };
      r.qty += Number(e.qty) || 0;
      if (e.cost == null) r.costKnown = false; else r.cost += Number(e.cost) || 0;
    }
  }
  const spent = Object.values(restock).filter(r => r.source === 'bought').reduce((n, r) => n + r.cost, 0);
  // AN UNTRACKED FILE HAS NO COMMIT THAT DESCRIBES IT. The checkout's HEAD is still recorded (it
  // pins the tools the file imports), but the report must not print it as the file's own version:
  // for a local FleetScript the file hash is the identity.
  const codes = [...new Set([...runs.values()].map(r => r.code &&
    `${r.code.tool}@${r.code.tracked === false ? `untracked(checkout ${r.code.git_sha ?? '?'})` : (r.code.git_sha ?? '?')}` +
    `${r.code.dirty ? '+dirty' : ''}#${r.code.file_sha1 ?? '?'}`).filter(Boolean))];
  const snaps = ev.filter(e => e.kind === 'run_start' || e.kind === 'run_end').filter(e => e.snapshot?.abilities);
  const abilitySpan = snaps.length >= 2 ? diffAbilities(snaps[0].snapshot.abilities, snaps.at(-1).snapshot.abilities) : null;
  const rooms = ev.filter(e => e.kind === 'run_end').reduce((n, e) => n + (Number(e.rooms_travelled) || 0), 0);
  return {
    runs: runs.size, wall_clock_s: Math.round(ms / 1000), casts, improves, restock: Object.values(restock),
    money_spent_bought: spent, rooms_travelled: rooms, code: codes, ability_span: abilitySpan,
    totals: Object.values(casts).reduce((t, c) => ({ success: t.success + c.success, fizzle: t.fizzle + c.fizzle,
      refused: t.refused + c.refused, unknown: t.unknown + c.unknown }), { success: 0, fizzle: 0, refused: 0, unknown: 0 }),
  };
}

const sameSchool = (a, b) => String(a).toLowerCase().replace(/[^a-z]/g, '') === String(b).toLowerCase().replace(/[^a-z]/g, '');
function diffAbilities(a = {}, b = {}) {
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
    if ((b[k] ?? null) !== (a[k] ?? null)) out[k] = { from: a[k] ?? null, to: b[k] ?? null };
  return out;
}

// A SNAPSHOT, read through the broker. `school` filters the abilities to one school's spells;
// the reagents are whatever `reagentNames` asks for. Unreadable fields are null, never 0.
export async function snapshot(call, agent, { school = null, reagentNames = [] } = {}) {
  const [ab, inv, st] = await Promise.all([
    call('abilities', { agent, kind: 'spells', refresh: true }).catch(() => null),
    call('inventory', { agent }).catch(() => null),
    call('status', { agent }).catch(() => null),
  ]);
  const abilities = Array.isArray(ab?.spells)
    ? Object.fromEntries(ab.spells.filter(s => !school || sameSchool(s.school ?? '', school)).map(s => [s.name, s.ability ?? null]))
    : null;
  const items = Array.isArray(inv?.items) ? inv.items : null;
  const count = rx => items ? items.filter(i => rx.test(i.name ?? '')).reduce((n, i) => n + (Number(i.amount) || 1), 0) : null;
  return {
    abilities, purse: count(/^shilling$/i),
    reagents: Object.fromEntries(reagentNames.map(n => [n, count(new RegExp(`^${n}s?$`, 'i'))])),
    room: st?.where?.num ?? st?.room?.num ?? null,
    mana: st?.mana?.value ?? st?.vitals?.mana?.value ?? null,
    vigor: st?.vigor?.value ?? null,
    // Karma is progress for a Qor or Shal'ille disciple; it is read, never assumed.
    karma: st?.karma?.value ?? null,
  };
}

// IMPROVES BETWEEN TWO SNAPSHOTS, as `improve` events. Nothing is emitted when either side is unread.
export function improvesBetween(before, after) {
  if (!before?.abilities || !after?.abilities) return [];
  return Object.keys(after.abilities)
    .filter(k => before.abilities[k] != null && after.abilities[k] != null && after.abilities[k] > before.abilities[k])
    .map(k => ({ kind: 'improve', spell: k, from: before.abilities[k], to: after.abilities[k] }));
}
