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
//   depositWithRecovery(call, agent, deposit) the other direction: put the named things (name substrings,
//                                             as hall_withdraw's `deposit`) into the chests, the same retry,
//                                             and the pack says what LEFT.
//   hallWithdrawRetrying(call, args, ms)      a DROP-IN for `call('hall_withdraw', args, ms)`: same
//                                             arguments, same reply shape, same throw -- with the passage
//                                             retry and the survival wait. For scripts whose own logic reads
//                                             the raw reply and should not change.
//   hallDrawSteps({ wants, holder, why })     the standard approach as fleetscript steps: the chalice
//                                             ride first when a holder is named (it lands past the
//                                             doors), the walk in as the fallback, then the recovering
//                                             draw. Compose your own walk home after it.
import { walk, verify, rideChalice } from './m59-fleetscript.mjs';

export const HALL = 714;
// A refusal of the PASSAGE, not of the chests: worth one more try from wherever the body now stands.
export const PASSAGE_REFUSAL = /guild door \d+ trigger not reached|outside the known passage|not in the hall/i;

// A passage walk the KEEPER cancelled for survival (playing dead, resting at the wall): the body is
// hurt and the ladder is doing its job. Retrying 15 seconds later walks straight into the same cancel
// -- the 2026-10-05 rerun stopped at r13c18 after two steps, Statler at 72% after a road fight. So the
// retry waits for health first.
export const SURVIVAL_CANCEL = /cancelled by keeper:(play_dead|rest|shelter|flee|retreat|recover)|rest at the safe wall|playing dead/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));
// The status tool has two shapes (keeper-backed and in-process); read either.
export const healthFraction = st => {
  const h = st?.hp ?? st?.health ?? st?.vitals?.health ?? null;
  if (h && Number(h.max) > 0) return Number(h.value) / Number(h.max);
  if (Number(st?.max_health) > 0) return Number(st.health) / Number(st.max_health);
  return null;
};
// Wait until health is back to `atLeast` (or the clock runs out). Never throws; returns the last reading.
export async function waitForRecovery(call, agent, { atLeast = 0.95, maxMs = 8 * 60_000, everyMs = 20_000, sleepFn = sleep, now = Date.now } = {}) {
  const until = now() + maxMs; let frac = null;
  for (;;) {
    frac = healthFraction(await call('status', { agent }, 60_000).catch(() => null));
    if (frac != null && frac >= atLeast) return { recovered: true, health: frac };
    if (now() >= until) return { recovered: false, health: frac };
    await sleepFn(everyMs);
  }
}
// One pause between attempts: a survival cancel waits out the rest; anything else waits pauseMs.
async function pauseBefore(call, agent, why, { pauseMs, sleepFn, recovery }) {
  if (SURVIVAL_CANCEL.test(String(why ?? ''))) return waitForRecovery(call, agent, { sleepFn, ...recovery });
  await sleepFn(pauseMs); return null;
}
const countIn = (inv, item) => (inv?.items ?? [])
  .filter(i => String(i.name ?? '').toLowerCase().replace(/s$/, '') === String(item).toLowerCase().replace(/s$/, ''))
  // The inventory reports an UNSTACKABLE item (a wand, an axe) as amount 0, meaning one — so 0 counts
  // as 1, as everywhere else in this repository. A stack is never listed at zero.
  .reduce((n, i) => n + (Number(i.amount) || 1), 0);

/**
 * Drop-in for the raw broker call. A thrown call throws as before (it is not a passage refusal); a
 * passage refusal is retried after pauseBefore; the LAST reply is returned unchanged, with `attempts`.
 */
export async function hallWithdrawRetrying(call, args, timeoutMs = 620_000, { retries = 1, pauseMs = 15_000, sleepFn = sleep, recovery = {} } = {}) {
  let r = null;
  for (let attempts = 0; attempts <= retries; attempts++) {
    if (attempts) await pauseBefore(call, args?.agent, r?.why ?? r?.error, { pauseMs, sleepFn, recovery });
    r = await call('hall_withdraw', args, timeoutMs);
    if (r && typeof r === 'object') r.attempts = attempts + 1;
    if (r?.ok || !PASSAGE_REFUSAL.test(String(r?.why ?? r?.error ?? ''))) break;
  }
  return r;
}

/**
 * One hall withdrawal, retried once on a passage refusal. Never throws.
 * @returns {{ ok, took, short, why, attempts, arrived: {item: n} }} — `arrived` is read off the pack,
 *          which is the evidence; `took` is the keeper's own account.
 */
export async function withdrawWithRecovery(call, agent, wants, { retries = 1, pauseMs = 15_000, sleepFn = sleep, recovery = {} } = {}) {
  const before = await call('inventory', { agent }, 60_000).catch(() => null);
  let r = null, attempts = 0;
  for (; attempts <= retries; attempts++) {
    if (attempts) await pauseBefore(call, agent, r?.why ?? r?.error, { pauseMs, sleepFn, recovery });
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

// What a deposit list names in a pack: case-insensitive substrings, as the keeper matches them
// (`id:<n>` entries name one object). Worn items are counted too; they never leave, so a fall is still
// the evidence and a pack holding only worn matches reads as "nothing to put in".
const countMatching = (inv, deposit) => {
  const names = deposit.map(d => String(d).toLowerCase()).filter(d => !/^id:\d+$/.test(d));
  const ids = new Set(deposit.map(d => /^id:(\d+)$/i.exec(String(d))?.[1]).filter(Boolean).map(Number));
  return (inv?.items ?? []).filter(i => ids.has(Number(i.id)) || names.some(d => String(i.name ?? '').toLowerCase().includes(d)))
    .reduce((n, i) => n + (Number(i.amount) || 1), 0);
};

/**
 * One deposit into the hall chests, retried once on a passage refusal. Never throws.
 * @returns {{ ok, before, left, why, attempts, reply }} — `left` is how many matching items left the pack.
 */
export async function depositWithRecovery(call, agent, deposit, { retries = 1, pauseMs = 15_000, sleepFn = sleep, recovery = {} } = {}) {
  const inv0 = await call('inventory', { agent }, 60_000).catch(() => null);
  const before = inv0 ? countMatching(inv0, deposit) : null;
  if (before === 0) return { ok: true, before, left: 0, why: 'nothing in the pack matches the deposit list', attempts: 0, reply: null };
  let r = null, attempts = 0;
  for (; attempts <= retries; attempts++) {
    if (attempts) await pauseBefore(call, agent, r?.why ?? r?.error, { pauseMs, sleepFn, recovery });
    r = await call('hall_withdraw', { agent, wants: [], deposit }, 620_000).catch(e => ({ ok: false, why: e?.message ?? String(e) }));
    const why = String(r?.why ?? r?.error ?? '');
    if (!PASSAGE_REFUSAL.test(why)) break;
  }
  const inv1 = await call('inventory', { agent }, 60_000).catch(() => null);
  const left = before != null && inv1 ? Math.max(0, before - countMatching(inv1, deposit)) : null;
  const refused = r?.ok === false || r?.error;
  return { ok: !refused && left !== 0, before, left, reply: r,
           why: refused ? (r?.why ?? r?.error ?? 'no reason given')
              : left === 0 ? 'the keeper reported a deposit but nothing left the pack'
              : left == null ? 'deposit reported; the pack could not be read back' : null,
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
