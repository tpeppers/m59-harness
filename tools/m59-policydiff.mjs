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
export const SPOT_POLICY_KEYS = ['useSafeSpots', 'pullToSafeWall', 'requireSafeWall'];

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

// DOES A FIGHT OPEN BY WALKING TO A WALL? The one combat question left.
//
// UNDEFINED MUST MEAN THE CAUTIOUS ANSWER, and reading the flag as a bare truthiness test
// gets that exactly backwards: `!policy.pullToSafeWall` is true for a policy that has never
// heard of the key, which would hand the RESPONSE posture to anything built without the
// defaults — every test fixture, and any caller assembling a policy by hand. The old code
// spelled this `requireSafeWall === false` for the same reason. So: the new key, then the
// legacy one it was renamed from, then true.
export const opensFightFromWall = (policy) =>
  policy?.pullToSafeWall ?? policy?.requireSafeWall ?? true;

// THE STATES THAT ARE NOT LEGAL RESTING VALUES, AND THE NAME THAT WAS RETIRED.
//
// THE SAFE WALL IS NO LONGER OPTIONAL, EXCEPT IN A FIGHT. Operator, 2026-09-10.
//
// This pair used to describe four states, three meaningful, and the whole of
// `coerceSpotPair` existed to rule out the fourth. That framing is retired. The wall is
// now ALWAYS ON for everything that is not combat — resting, parking, recovering, being
// hurt in a spawn room, every rung of the survival ladder — because every one of those
// presupposes you already walked somewhere nothing can reach you, and making that
// contingent on a FIGHTING flag is what killed Waldorf four times on 2026-09-08.
//
// So `useSafeSpots` is coerced up unconditionally: it is the always-on facility, not a
// choice. The one remaining choice is what combat does, and it has its own key now —
// `pullToSafeWall`, which controls ONLY whether a fight OPENS by walking to a wall.
// Taking a wall as a RESPONSE to a crowd (`wallAtAttackers`) is not the initial pull and
// is not gated by it.
//
// Mutates `policy` and returns what it had to change, so the caller can log it. Silence
// means nothing needed adopting or coercing, which is the ordinary case.
export function coerceSpotPair(policy) {
  if (!policy || typeof policy !== 'object') return [];
  const changed = [];

  // LEGACY NAME, ADOPTED BEFORE ANYTHING READS THE NEW ONE. `requireSafeWall` is
  // persisted in the live roster for every character, so dropping it silently would
  // hand 21 of them the DEFAULT posture at the next keeper restart — the exact
  // "silence means the behaviour that was already there" rule this repository keeps.
  // Both keys are carried forward in step so an un-migrated reader still sees its own.
  if (policy.requireSafeWall !== undefined && policy.pullToSafeWall === undefined) {
    policy.pullToSafeWall = policy.requireSafeWall;
    changed.push({ key: 'pullToSafeWall', from: undefined, to: policy.requireSafeWall,
                   why: 'adopted from the legacy requireSafeWall, which now names only the ' +
                        'opening pull to a wall' });
  } else if (policy.pullToSafeWall !== undefined
             && policy.requireSafeWall !== policy.pullToSafeWall) {
    policy.requireSafeWall = policy.pullToSafeWall;
  }

  // THE COERCION NO LONGER ASKS ABOUT THE WALL FLAG. It used to fire only while
  // `requireSafeWall === true`, on the reasoning that requiring a wall while refusing to
  // look for one is incoherent. True, but far too narrow: with the wall flag false — which
  // is the whole prod fleet — `useSafeSpots:false` stuck, and it switched off SHELTER as
  // well as posture. Non-combat safety is not a tuning choice, so it is coerced up always.
  if (policy.useSafeSpots !== true) {
    const from = policy.useSafeSpots;
    policy.useSafeSpots = true;
    changed.push({ key: 'useSafeSpots', from, to: true,
                   why: 'safe spots are the always-on non-combat facility (rest, park, ' +
                        'recover, the survival ladder) and are no longer switchable — ' +
                        'use pull_to_safe_wall to choose the COMBAT posture' });
  }

  return changed;
}
