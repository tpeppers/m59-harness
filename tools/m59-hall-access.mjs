// GETTING THINGS OUT OF THE GUILD HALL, THE ONE WAY EVERY ERRAND SHOULD DO IT.
//
// A dozen fleetscripts called `hall_withdraw` raw, each with its own (or no) idea of what a refusal
// means. On 2026-10-05 three draws in a row came back `took {}` — two curse cycles and a mushroom
// courier — while the chests held 3,556 emeralds; a probe showed why: a body that WALKS in lands in
// the foyer and the passage to the chests can refuse at a door trigger ("guild door 55 trigger not
// reached"), while one that rides the chalice lands past the doors. Nothing told the scripts apart.
//
// So this is the shared half:
//   withdrawWithRecovery(call, agent, wants)  one draw; a PASSAGE refusal (a door trigger, outside the
//                                             passage) is retried once after a pause, everything else is
//                                             returned as it came. The result always says why.
//   hallDrawSteps({ wants, holder, why })     the standard approach as fleetscript steps: the chalice
//                                             ride first when a holder is named (it lands past the
//                                             doors), the walk in as the fallback, then the recovering
//                                             draw. Compose your own walk home after it.
import { walk, verify, rideChalice } from './m59-fleetscript.mjs';

export const HALL = 714;
// A refusal of the PASSAGE, not of the chests: worth one more try from wherever the body now stands.
export const PASSAGE_REFUSAL = /guild door \d+ trigger not reached|outside the known passage|not in the hall/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const countIn = (inv, item) => (inv?.items ?? [])
  .filter(i => String(i.name ?? '').toLowerCase().replace(/s$/, '') === String(item).toLowerCase().replace(/s$/, ''))
  // The inventory reports an UNSTACKABLE item (a wand, an axe) as amount 0, meaning one — so 0 counts
  // as 1, as everywhere else in this repository. A stack is never listed at zero.
  .reduce((n, i) => n + (Number(i.amount) || 1), 0);

/**
 * One hall withdrawal, retried once on a passage refusal. Never throws.
 * @returns {{ ok, took, short, why, attempts, arrived: {item: n} }} — `arrived` is read off the pack,
 *          which is the evidence; `took` is the keeper's own account.
 */
export async function withdrawWithRecovery(call, agent, wants, { retries = 1, pauseMs = 15_000, sleepFn = sleep } = {}) {
  const before = await call('inventory', { agent }, 60_000).catch(() => null);
  let r = null, attempts = 0;
  for (; attempts <= retries; attempts++) {
    if (attempts) await sleepFn(pauseMs);
    r = await call('hall_withdraw', { agent, wants }, 620_000).catch(e => ({ ok: false, why: e?.message ?? String(e) }));
    if (r?.ok || !PASSAGE_REFUSAL.test(String(r?.why ?? ''))) break;
  }
  const after = await call('inventory', { agent }, 60_000).catch(() => null);
  const arrived = Object.fromEntries(wants.map(w => [w.item, Math.max(0, countIn(after, w.item) - countIn(before, w.item))]));
  const gotAny = Object.values(arrived).some(n => n > 0);
  return { ok: !!r?.ok && gotAny, took: r?.took ?? {}, short: r?.short ?? {}, arrived,
           why: r?.ok ? (gotAny ? null : 'the keeper reported a draw but nothing arrived in the pack') : (r?.why ?? r?.error ?? 'no reason given'),
           attempts: Math.min(attempts + 1, retries + 1) };
}

/** The standard approach and draw, as fleetscript steps. */
export function hallDrawSteps({ wants, holder = null, why = 'the guild chests', onResult = null } = {}) {
  return [
    ...(holder ? [{ ...rideChalice({ why }), optional: true }] : []),
    walk(HALL, { why: `${why} (on foot if no ride landed us; a no-op if one did)` }),
    verify(async ({ agent, call }) => {
      const r = await withdrawWithRecovery(call, agent, wants);
      console.log(`  ${agent}: hall draw ${JSON.stringify(r.arrived)} in ${r.attempts} attempt(s)` + (r.why ? ` — ${r.why}` : ''));
      onResult?.(r);
      return r.ok ? { ok: true } : { ok: false, why: `hall draw: ${r.why}` };
    }, 'draw from the guild chests'),
  ];
}
