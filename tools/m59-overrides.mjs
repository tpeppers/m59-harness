// AN OPERATOR OVERRIDE ON A CHARACTER: "STOP WHAT IS DRIVING IT, AND LET NOTHING QUEUED PICK IT UP FOR N MINUTES".
//
//   node tools/m59-jobs.mjs cancel --agents t11,t13            stop + retire their jobs, release the lease and any open trade,
//                                                              and hold them for 15 min (--hold N, --hold 0 for none)
//   node tools/m59-jobs.mjs override                           the overrides in force
//   node tools/m59-jobs.mjs override clear --agents t11        lift one early
//
// Operator, 2026-11-17: "Can we add a 'cancel/override' functionality to our keepers so that we don't keep letting things run
// that we know will fail? ... bake that cancel/skip functionality into the default supervisor code/template everyone uses".
//
// WHY CANCELLING THE JOB WAS NOT ENOUGH. Three things outlived `m59-jobs cancel` on the night this was written:
//   1. THE NEXT STEP. A supervisor driving a chain (buy -> fetch -> practise) saw its REPL child die and went straight on to the
//      next step for the same body -- so the only way to stop a doomed chain was to kill the whole supervisor, and every other
//      character it was driving with it.
//   2. THE KEEPER LEASE. Rowlf's cancelled `buy` still held "fleetscript:buy (public) is busy" for eighteen more minutes, so the
//      make-space that would have rescued him was refused.
//   3. AN OPEN TRADE. Sweetums had one, and `make_space` refuses mid-offer.
// So an override is a FILE (substrate/overrides-<fleet>.json, one checkout's, gitignored like every other runtime substrate
// file) that liveStart reads before every fleetscript run -- any supervisor, any session, any REPL line -- and refuses an
// overridden body by name, saying who set it, why, and until when. A run that has to drive the body anyway (the rescue that
// the override was cleared FOR) says so with `unsafe: { waives: ['liveStart'] }`, exactly as it already must for a live job.
//
// THE CLOCK IS THE POINT. An override that never expires is a character nobody can drive and nobody remembers parking; 15 min is
// long enough to clear the doomed chain and short enough that forgetting costs a quarter hour, not a night.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_HOLD_MIN = 15;

export function overridesPath(substrate, fleet) {
  const name = String(fleet ?? '').trim() || 'default';
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`overrides: bad fleet name ${JSON.stringify(fleet)}`);
  return join(substrate, `overrides-${name}.json`);
}

/** The file's entries, or {} when it is absent. A file that will not parse is NOT an empty file: it throws. */
export function readOverrides(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  const j = JSON.parse(text);
  return j && typeof j === 'object' && j.agents && typeof j.agents === 'object' ? j.agents : {};
}

function writeOverrides(path, agents) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ schema: 'm59-overrides/1', agents }, null, 2) + '\n');
  renameSync(tmp, path);
}

/** Pure: the entries still in force at `now`. */
export function activeOverrides(entries, now = Date.now()) {
  return Object.fromEntries(Object.entries(entries ?? {}).filter(([, e]) => Number(e?.until) > now));
}

/** Pure: which of `agents` are held at `now`, as [{agent, until, by, why}]. */
export function overridden(entries, agents, now = Date.now()) {
  const live = activeOverrides(entries, now);
  return agents.filter(a => live[a]).map(a => ({ agent: a, ...live[a] }));
}

export function overrideRefusal(o, now = Date.now()) {
  const mins = Math.max(1, Math.round((o.until - now) / 60000));
  return `${o.agent} is under an operator override for ${mins} more min` +
    (o.by ? ` (set by ${o.by}` + (o.why ? `: ${o.why}` : '') + ')' : o.why ? ` (${o.why})` : '') +
    ` -- lift it with: node tools/m59-jobs.mjs override clear --agents ${o.agent}`;
}

export function setOverrides(path, agents, { minutes = DEFAULT_HOLD_MIN, by = null, why = null, now = Date.now() } = {}) {
  const all = activeOverrides(readOverrides(path), now);
  for (const a of agents) all[a] = { until: now + minutes * 60000, at: now, by, why };
  writeOverrides(path, all);
  return all;
}

export function clearOverrides(path, agents, { now = Date.now() } = {}) {
  const all = activeOverrides(readOverrides(path), now);
  const cleared = agents.filter(a => all[a]);
  for (const a of agents) delete all[a];
  writeOverrides(path, all);
  return cleared;
}
