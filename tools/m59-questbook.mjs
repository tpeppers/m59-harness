#!/usr/bin/env node
// WHAT THE GAME ACTUALLY ASKED FOR, KEPT — one file per quest run, saved and loadable.
//
//   node tools/m59-questbook.mjs list                    every run, newest first
//   node tools/m59-questbook.mjs list --failed           only the ones that did not finish
//   node tools/m59-questbook.mjs list --unhandled        only the asks nothing knows how to do
//   node tools/m59-questbook.mjs show <id>               one run in full, including what she said
//   node tools/m59-questbook.mjs asks                    every distinct ask ever recorded
//
// WHY THIS EXISTS. A quest engine that rolls its instruction and states it ONCE, in a private
// line, is a thing you cannot debug from a scrolled-away terminal. The disciple quests are
// that: Kraanan names one monster of three, the other three schools name one NPC of three to
// five, and `NPC_quote_to_one` (questnode.kod:67) says it once and never again. A run that
// failed and did not write down what it was asked for has destroyed the only evidence of why.
//
// So the errand writes its transcript TWICE, and the first write is the important one:
//
//   * as soon as the ask is read — before anything walks to fulfil it. A character that then
//     dies in the Badlands still leaves behind the sentence it was answering, which is the
//     thing the next run needs.
//   * again at the end, with the outcome, the verdict and every step's result.
//
// Two writes rather than one because a FleetScript that dies and cannot recover BREAKS out of
// its step loop, and a `break` skips even the steps marked `always`. A single write at the end
// is therefore a write that is missing exactly when it matters most.
//
// AN UNHANDLED ASK IS A RESULT, NOT AN ERROR. `kind: "unknown"` with the raw sentence is how a
// quest variant nobody has written a handler for gets recorded instead of silently doing
// nothing — `asks` lists them, and each one is the specification for the handler it needs.
//
// THESE FILES NAME CHARACTERS, so `substrate/questbook/` is gitignored, the same rule as
// loadouts and rosters: this machine's fleet, not the repository's.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

export const SCHEMA = 'm59-questbook/1';

// THE FLEET IS ALWAYS THE LAST SEGMENT, INCLUDING UNDER THE OVERRIDE. `M59_QUESTBOOK_DIR` names
// the BASE, not the leaf: an override that flattened the fleets together would quietly undo the
// only property this book has — that "what has this fleet ever been asked for" has one answer,
// and a shadow rehearsal does not contaminate the real one.
export const bookDir = (fleet = 'default') =>
  join(process.env.M59_QUESTBOOK_DIR || join(REPO, 'substrate', 'questbook'), String(fleet));

/** `<agent>-<quest>-<utc>` — sortable, unique per run, and readable in a directory listing. */
export const runId = ({ agent, quest, at = Date.now() }) =>
  `${agent}-${quest}-${new Date(at).toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}`;

/**
 * Write (or rewrite) one run's transcript. Returns the path.
 *
 * Deliberately last-write-wins on a whole object rather than an append: a transcript is the
 * state of ONE run, and two partial appends from the two write points would have to be
 * reassembled by every reader. The cost is that the caller carries the accumulating record,
 * which it is already doing — it is the FleetScript's `state`.
 */
export function saveRun(entry, { fleet = entry.fleet ?? 'default' } = {}) {
  const dir = bookDir(fleet);
  mkdirSync(dir, { recursive: true });
  const id = entry.id ?? runId(entry);
  const path = join(dir, `${id}.json`);
  writeFileSync(path, JSON.stringify({ schema: SCHEMA, id, ...entry }, null, 1));
  return path;
}

export function loadRun(idOrPath, { fleet = 'default' } = {}) {
  const path = idOrPath.endsWith('.json') && existsSync(idOrPath)
    ? idOrPath : join(bookDir(fleet), `${idOrPath}.json`);
  if (!existsSync(path)) return null;
  try { return { ...JSON.parse(readFileSync(path, 'utf8')), path }; } catch { return null; }
}

/** Every run on disk for a fleet, newest first. A file that will not parse is REPORTED. */
export function listRuns({ fleet = 'default' } = {}) {
  const dir = bookDir(fleet);
  if (!existsSync(dir)) return { runs: [], problems: [] };
  const runs = [], problems = [];
  for (const f of readdirSync(dir).filter(n => n.endsWith('.json'))) {
    const path = join(dir, f);
    try { runs.push({ ...JSON.parse(readFileSync(path, 'utf8')), path }); }
    // A CORRUPT TRANSCRIPT IS NOT AN ABSENT ONE. Swallowing it would make a half-written file
    // — which is what a crash mid-write leaves — look like a run that never happened.
    catch (e) { problems.push({ path, why: e.message }); }
  }
  runs.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  return { runs, problems };
}

/**
 * The distinct things the game has ever asked for, with how often and where to read one.
 *
 * This is the working list for "what should the script do if it gets that quest": an ask that
 * appears here with `handled: false` is a variant that exists in the world and has no prepared
 * handler, which is exactly the entry criterion for writing one.
 */
export function distinctAsks({ fleet = 'default' } = {}) {
  const { runs } = listRuns({ fleet });
  const by = new Map();
  for (const r of runs) {
    const a = r.ask ?? { kind: 'none' };
    // Keyed on the SHAPE, not on the instance: "kill a skeleton" and "kill a fungus beast" are
    // one ask with two rolls, and collapsing them is what makes the list a specification.
    const key = `${r.quest ?? '?'}/${a.kind}`;
    // `none` IS NOT AN UNHANDLED ASK. A run that failed before the game said anything has no
    // ask to handle, and marking it NO HANDLER puts the largest row in the backlog on a
    // problem nobody can write a handler for. Only a real `unknown` belongs there.
    const row = by.get(key) ?? { quest: r.quest, kind: a.kind, count: 0,
                                 handled: a.kind === 'none' ? null : !!a.handled,
                                 outcomes: {}, rolls: new Set(), examples: [] };
    row.count++;
    row.outcomes[r.outcome ?? '?'] = (row.outcomes[r.outcome ?? '?'] ?? 0) + 1;
    for (const v of [a.monster, a.npc, a.item].filter(Boolean)) row.rolls.add(v);
    if (row.examples.length < 3 && a.raw) row.examples.push({ id: r.id, raw: a.raw });
    by.set(key, row);
  }
  return [...by.values()]
    .map(r => ({ ...r, rolls: [...r.rolls] }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------- cli
function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const has = n => argv.includes(n);
  const verb = argv.find(a => !a.startsWith('--')) ?? 'list';
  const fleet = arg('--fleet', process.env.M59_FLEET || 'shadow');

  if (verb === 'asks') {
    const rows = distinctAsks({ fleet });
    if (!rows.length) { console.log(`no runs recorded for "${fleet}" in ${bookDir(fleet)}`); return 0; }
    console.log(`what the game has asked for — fleet "${fleet}"\n`);
    for (const r of rows) {
      const out = Object.entries(r.outcomes).map(([k, v]) => `${k}:${v}`).join(' ');
      const flag = r.handled === false ? 'NO HANDLER  '
                 : r.handled === null ? 'nothing was asked  ' : '';
      console.log(`  ${r.quest}/${r.kind}  x${r.count}  ${flag}${out}`);
      if (r.rolls.length) console.log(`      rolls seen: ${r.rolls.join(', ')}`);
      for (const e of r.examples) console.log(`      e.g. ${e.id}: "${String(e.raw).slice(0, 110)}"`);
    }
    return 0;
  }

  if (verb === 'show') {
    const id = argv.find(a => !a.startsWith('--') && a !== 'show');
    if (!id) { console.error('usage: show <id>'); return 2; }
    const r = loadRun(id, { fleet });
    if (!r) { console.error(`no run "${id}" under ${bookDir(fleet)}`); return 1; }
    console.log(JSON.stringify(r, null, 1));
    return 0;
  }

  const { runs, problems } = listRuns({ fleet });
  const want = runs.filter(r =>
    (!has('--failed') || r.outcome !== 'ok') &&
    (!has('--unhandled') || r.ask?.handled === false));
  console.log(`${want.length} of ${runs.length} run(s) — fleet "${fleet}" — ${bookDir(fleet)}\n`);
  for (const r of want) {
    console.log(`  ${r.id}`);
    console.log(`      ${r.quest ?? '?'} · ask ${r.ask?.kind ?? 'none'}` +
                `${r.ask?.handled === false ? ' (NO HANDLER)' : ''}` +
                ` · ${r.probe_before ?? '?'} -> ${r.probe_after ?? '?'} · ${r.outcome ?? '?'}`);
    if (r.why) console.log(`      ${String(r.why).slice(0, 140)}`);
  }
  for (const p of problems) console.log(`  UNREADABLE ${p.path} — ${p.why}`);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href)
  process.exit(main());
