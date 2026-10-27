// AN ERRAND'S PURSE IS LEASED, AND NO STANDING BANKING RULE MAY TAKE IT BACK WHILE THE LEASE HOLDS.
//
// Prod, 2026-10-26: a courier withdrew 6000 at the Jasper bank for a reagent run, and the chalice holder's own banking
// rule (keep = max(walkingMoney, shopping plan), deposit the rest whenever standing at a bank) put it straight back:
// 19782 -> withdraw 6000 -> 19382, purse 400. `bank_above` did not help; the float did. Every buy then ran on an empty
// purse and read as "sold out" for hours. Operator: "Do we not wanna consider this all a bug for allowing this
// back-and-forth to happen? (maybe it's better to put a 'back to XYZ after...' note in the character paired with the
// withdrawal over the standard carry purse)".
//
// So the carry an errand needs is a LEASE: { carry, until, owner } in policy.purseLease. While it is live, every
// banking rule's float is max(its own float, carry), and bank_above is never below carry, so nothing deposits it and no
// bank trip fires on it. It lapses by itself at `until` (default an hour, at most 12), back to the standard float.
// Same shape as survival_off_ms (m59-hazards.mjs). Set by `autopilot purse_lease={carry, ms, owner}`, or by the bank
// tool's withdraw with `lease_ms`, which leases the purse as it stands after the withdrawal.
export const PURSE_LEASE_DEFAULT_MS = 60 * 60_000;
export const PURSE_LEASE_MAX_MS = 12 * 3_600_000;

/** { carry, ms?, owner? } -> { carry, until, owner } (or null to clear). Throws with the reason. */
export function normalizePurseLease(v, now = Date.now()) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('purse_lease must be null or { carry, ms, owner }');
  const carry = Math.floor(Number(v.carry));
  if (!Number.isFinite(carry) || carry < 1) throw new Error('purse_lease.carry must be a positive number of shillings');
  let ms = v.ms == null ? PURSE_LEASE_DEFAULT_MS : Number(v.ms);
  if (!Number.isFinite(ms) || ms < 60_000) throw new Error('purse_lease.ms must be at least 60000 (one minute)');
  ms = Math.min(ms, PURSE_LEASE_MAX_MS);
  const owner = v.owner == null ? 'errand' : String(v.owner).slice(0, 80);
  return { carry, until: now + ms, owner };
}

/** The carry a live lease protects, or 0. A lease with no valid `until` is not live: a lease never outlives its term. */
export function leaseCarry(policy, now = Date.now()) {
  const l = policy?.purseLease;
  if (!l || !(Number(l.carry) > 0)) return 0;
  const until = Number(l.until);
  return Number.isFinite(until) && now < until ? Math.floor(Number(l.carry)) : 0;
}

/** The float every banking rule keeps: the standard walking money, or the live lease's carry if more. */
export function walkingFloatOf(policy, now = Date.now()) {
  return Math.max(Number(policy?.walkingMoney ?? 400) || 0, leaseCarry(policy, now));
}

/** bank_above, never below a live lease's carry (0/null still means "no bank trips"). */
export function bankAboveOf(policy, now = Date.now()) {
  const above = policy?.bankAbove;
  if (!above) return above;
  return Math.max(Number(above), leaseCarry(policy, now));
}
