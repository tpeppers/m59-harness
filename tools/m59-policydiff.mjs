// A POLICY FIELD THAT CHANGES WITHOUT A LOG LINE IS A POLICY FIELD THAT CANNOT BE
// DEBUGGED, AND ONE OF THEM HAS KILLED CHARACTERS.
//
// The broker's persistence layer already logs one transition — `autopilot.mode` — and the
// comment beside it says why: "a silent tick->survive revert … was the undiagnosable
// part". That argument was never carried across to the rest of the policy. So a push that
// landed `useSafeSpots:true, requireSafeWall:true` could be reverted to `false/false` by a
// later write and leave NO trace anywhere in the broker log, by construction.
//
// What that cost, fleet `lan`, three deaths in two days:
//
//   #24, #25  2026-08-28 15:49Z / 16:31Z, room 554, both at square (11,11) with no safe
//             spot established; root-caused at 17:06Z to the spot policy being off.
//   #26       2026-08-29 00:39Z, room 586, killed by a centipede. `in_safe_spot: false`,
//             every trial reading "not holding a spot — nothing to test", pinned in the
//             open ~18 minutes. A re-arm at 01:28Z had VERIFIED both flags true; the live
//             policy read `false/false` by ~01:47Z and nothing said who wrote it.
//
// Twenty-one `policy updated` lines in one keeper process, and the spot flags oscillating
// through them — `false/false` x4, `true/false`, `true/true` x9, `true/false`,
// `false/false`, `true/false`, `true/true` x2 — with no writer named on any of them.
//
// So: one place that says what changed, shared by the broker's two persistence paths and
// the keeper's live merge, and testable without a fleet. `m59-policyrevert-test.mjs`.

// THE PAIR THAT HAS ACTUALLY KILLED SOMEBODY. Diffed everywhere, and logged with a stack
// trace on the path that writes the roster, exactly as `mode` is — because the question
// these two raise is never "did it change" but "which line changed it".
export const SPOT_POLICY_KEYS = ['useSafeSpots', 'requireSafeWall'];

// Long values are summarised rather than dropped: `farmDelivery` going from a configured
// object to null is a real revert and must not print as `[object Object] -> null`.
const MAX_VALUE_CHARS = 72;

const show = (v) => {
  if (v === undefined) return '(unset)';
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v !== 'object') return String(v);
  const s = JSON.stringify(v);
  return s.length > MAX_VALUE_CHARS ? s.slice(0, MAX_VALUE_CHARS - 1) + '…' : s;
};

const equal = (a, b) => {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
};

// EVERY FIELD, NOT A WATCHLIST. A watchlist is how `purpose` stayed out of a schema for a
// year with every keeper's audit switched off: the next field nobody thought to add is
// always the one that matters. The spot pair is sorted to the front because it is the one
// a reader is scanning for, not because it is the only one reported.
export function policyDiff(prev, next) {
  const a = prev && typeof prev === 'object' ? prev : {};
  const b = next && typeof next === 'object' ? next : {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const rows = [];
  for (const key of keys) {
    const from = a[key], to = b[key];
    if (from === undefined && to === undefined) continue;
    if (equal(from, to)) continue;
    rows.push({ key, from, to, survival: SPOT_POLICY_KEYS.includes(key) });
  }
  // The pair reads in the order the policy is REASONED in — look for a wall, then refuse
  // without one — rather than alphabetically, which puts the consequence before its cause.
  const rank = k => { const i = SPOT_POLICY_KEYS.indexOf(k); return i < 0 ? SPOT_POLICY_KEYS.length : i; };
  rows.sort((x, y) => (rank(x.key) - rank(y.key)) || x.key.localeCompare(y.key));
  return rows;
}

export function formatPolicyDiff(rows) {
  return rows.map(r => `${r.key} ${show(r.from)} -> ${show(r.to)}`).join(', ');
}

export const hasSpotChange = (rows) => rows.some(r => r.survival);

// THE ONE PARTIAL STATE THAT IS NOT A LEGAL RESTING VALUE.
//
// The two flags are set by independent `!== undefined` guards and merged with
// `Object.assign`, so any combination is representable. Three of the four are meaningful:
//
//   false / false   fight wherever the prey is
//   true  / false   PREFER a wall, take the fight anyway if there is not one
//   true  / true    refuse a fight without a wall
//   false / true    ← meaningless: refuse a fight without a wall, while not looking for one
//
// The last one asks the keeper to require something it has been told not to seek. It is
// not a tuning choice anybody makes; it is the shape a half-applied push leaves behind.
// So it is coerced up rather than down — a caller that said `requireSafeWall: true` asked
// for MORE caution, and quietly clearing that flag instead would answer a request for
// safety by removing it.
//
// Mutates `policy` and returns what it had to change, so the caller can log it. Silence
// means the pair was already coherent, which is the ordinary case.
export function coerceSpotPair(policy) {
  if (!policy || typeof policy !== 'object') return [];
  if (policy.requireSafeWall === true && policy.useSafeSpots !== true) {
    const from = policy.useSafeSpots;
    policy.useSafeSpots = true;
    return [{ key: 'useSafeSpots', from, to: true,
              why: 'requireSafeWall:true refuses a fight without a wall, which is ' +
                   'meaningless with spots off — coerced up rather than clearing the ' +
                   'stricter flag' }];
  }
  return [];
}
