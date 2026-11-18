#!/usr/bin/env node
// THE SWING CLOCK: WHAT MAY HAPPEN BETWEEN TWO SWINGS, AND WHEN A FIGHT IS HANDED BACK.
//
// Pure: no socket, no clock of its own, no policy. `Session.attackRounds` (m59-game.mjs) asks it whether to turn
// before a swing, `fight()` (m59-skills.mjs) asks it whether a fight goes on for another round, and the farm pass
// records what it measured. tools/m59-fight-cadence-test.mjs pins all of it.
//
// MEASURED, prod 2026-11-18. Four Castle Victoria farmers (143-149 max health, skeletons and zombies), keeper
// journals over six minutes, every break-off that followed another fight outcome:
//
//     seconds per round    n=32   p25 1.60   median 1.71   p75 1.91   mean 1.82
//     rounds per kill      n=33   p25 5      median 7      p75 10     max 26
//     one 3-round fight() call        median 3.62 s      (1.21 s a round INSIDE the call)
//     the pass between two calls      median 1.56 s      (the same quarry, nothing else journaled)
//
// The server allows one melee attack a second: Player.TryAttack calls IsOkayAttackTime with no argument
// (player.kod:3974), whose default is `time = 1000` (player.kod:5305), and no weapon or skill passes another value.
// The only other callers are a spell's post-cast time (spell.kod:760), a user action such as a wave (user.kod:4873)
// and the staff of jolting (joltstaf.kod:76), and they share the one timer. So a round should cost 1.05 s and was
// costing 1.7: two fifths of every fight was spent between swings.
//
// WHERE IT WENT. Not into the swings themselves: inside one call they were already about a second apart. It went
// into (a) HANDING THE FIGHT BACK EVERY THREE ROUNDS: the farm pass never passed a round budget, so it inherited
// fight()'s parameter default of 3, and each hand-back cost the pass (1.56 s) plus the next call's setup and tail
// (a room read, the weapon check, two health reads: about 1.5 s) for 3.15 s of swinging; and (b) THREE OR FOUR
// PACKETS A SWING: an unpaced turn in fight(), a paced turn in attackRounds, the attack, and a health read with a
// wait of up to 1.5 s behind it. Against a server that drops everything past five packets in one second
// (user.kod:50, :883) that left no room for anything else, and every one of them sat in the same 200 ms pacer gap.
//
// WHAT THE SERVER ACTUALLY NEEDS FOR A BLOW, which is what decides the rest:
//
//   FACING. TargetWithinSightAndRange (player.kod:4115) skips the view test entirely at squared distance <= 1
//   (player.kod:4188) and otherwise refuses only a target BEHIND the line through us perpendicular to our facing's
//   own octant (player.kod:4189-4205; an octant is 45 degrees, blakston.khd:1233-1250). An octant's centre is at
//   most 22.5 degrees from the facing, so a target within 67.5 degrees of where we face is always accepted. It reads
//   whole squares (GetRow/GetCol), so the bearing between two bodies that have not changed square has not changed.
//   Hence SWING_REFACE_DEG: turn when the bearing has left our facing by more than half an octant, which leaves a
//   whole octant of margin for a target that steps while the swing waits its second. A refusal names itself
//   ("You can't see your selected target.", player_attack_not_in_view) and forces the next turn.
//
//   HEALTH. LoseHealth and GainHealth both end in NewHealth (player.kod:5761, :5777, :5823), which calls
//   DrawHealth, and DrawHealth sends BP_STAT for health whenever the player is logged on (user.kod:6631). So the
//   number in memory is as fresh as the last thing the server sent, on an ordered stream. A hit or a miss always
//   sends the attacker a sentence (the stroke's prose on a hit; battler_attacker_miss, battler.kod:993, on a miss),
//   so "the server has spoken since my last swing left" is the ordinary case and a read is owed only when it has not.
//
// Anything here that is a number is a number about the SERVER, not an opinion about this fleet: none of it is policy.

/** Degrees the bearing to a target may sit from our facing before a swing turns first. Half an octant; see above. */
export const SWING_REFACE_DEG = 22.5;

/**
 * How long a swing's exchange may stay silent before health is asked for outright (ms). Just under the swing
 * interval: by the time the next swing would be due the server has either spoken or been asked.
 */
export const SWING_REPLY_MS = 1000;

/**
 * How long after a swing leaves the rest of its exchange is given to arrive before the call's messages are swept
 * (ms). The resistance sentence follows the hit sentence a fraction later (player.kod:9686), and the read this
 * replaces used to give it one pacer gap plus a round trip. It costs nothing: the next swing is not due for 1050.
 */
export const SWING_SETTLE_MS = 250;

/** The least the sweep waits after the FIRST sentence of an exchange, for a reply that itself came late (ms). */
export const SWING_TRAIL_MS = 60;

/** How long a health read asked for outright may take to come back before the swing is refused as blind (ms). */
export const VITALS_POLL_MS = 1500;

/**
 * How many rounds ONE farm fight may run while it keeps landing. A cap, not a target: the measured kill takes a
 * median of 7 rounds and three quarters take 10 or fewer, so twelve finishes most kills in one call and still
 * hands the body back to the pass inside thirteen seconds. `policy.fightRounds` replaces it where an operator set one.
 */
export const FARM_PRESS_ROUNDS = 12;

/** A per-quarry tally older than this describes a different fight (ms). Ids are handles; this is bookkeeping only. */
export const QUARRY_TALLY_STALE_MS = 120_000;

const norm = d => ((d % 360) + 360) % 360;

/** Smallest angle between two headings, 0..180. */
export function degreesApart(a, b) {
  const d = Math.abs(norm(Number(a)) - norm(Number(b)));
  return Math.min(d, 360 - d);
}

/**
 * The bearing from one body to another on WHOLE SQUARES, which is what the server's view test reads. kod angle 0 is
 * east and grows clockwise with rows growing downward, exactly atan2(dRow, dCol). Null when they share a square
 * (there is no bearing, and the server asks for none) or when either position is unknown.
 */
export function bearingDeg(from, to) {
  if (!from || !to) return null;
  const dx = Number(to.col) - Number(from.col), dy = Number(to.row) - Number(from.row);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (dx === 0 && dy === 0) return null;
  return norm(Math.round(Math.atan2(dy, dx) * 180 / Math.PI));
}

/**
 * DOES THIS SWING NEED A TURN FIRST? `turn: true` whenever the answer cannot be shown to be no: our own position
 * or facing is unknown, the last swing was refused for view (`force`), or the bearing has left our facing by more
 * than the tolerance. A body that has not changed square against a target that has not changed square is never
 * turned twice.
 */
export function swingFacing({ me = null, target = null, force = false, tolerance = SWING_REFACE_DEG } = {}) {
  if (!me || !target) return { turn: true, why: 'our own position is not known' };
  const bearing = bearingDeg(me, target);
  if (bearing == null) return { turn: false, why: 'standing on its square: there is no bearing to face', bearing: null };
  const facing = typeof me.degrees === 'number' && Number.isFinite(me.degrees) ? norm(me.degrees) : null;
  if (force) return { turn: true, why: 'the last swing was refused for view', bearing, facing };
  if (facing == null) return { turn: true, why: 'our own facing is not known', bearing, facing };
  const apart = degreesApart(bearing, facing);
  return apart > tolerance
    ? { turn: true, why: 'the bearing has left our facing', bearing, facing, apart }
    : { turn: false, why: 'already facing it', bearing, facing, apart };
}

// THE THREE WAYS THE SERVER SAYS "NOT FROM THERE", in its own words (player.kod:243-246). They are spoken only to
// the attacker, about the swing just sent, so they are evidence about OUR swing and nobody else's.
const NOT_IN_VIEW = /^\s*You can't see your selected target\.\s*$/i;
const OUT_OF_REACH = /\bis too far away to hit with\b|^\s*You can't reach .+ with your .+\.\s*$|\bis out of range\.\s*$/i;

/** "You can't see your selected target." -- the view test refused the blow, so where we think we face is wrong. */
export const notInViewText = text => NOT_IN_VIEW.test(String(text ?? ''));
/** The range test refused the blow: the quarry is beyond what this weapon, fist or spell reaches. */
export const outOfReachText = text => OUT_OF_REACH.test(String(text ?? ''));

/**
 * DOES THIS FIGHT GET ANOTHER ROUND?
 *
 * `rounds` is what a fight is given with no proof that it is getting anywhere, and for every caller that passes
 * nothing else it is the whole budget, exactly as it always was. `pressRounds` is the most rounds ONE call may run
 * while its swings keep LANDING: past the first `rounds`, a round is granted only when
 *
 *   - a hit landed inside the last `rounds` rounds (so "too far away" and "the geometry moved you" still end it),
 *   - the last exchange was not refused as out of reach (the quarry left; the next call walks up to it again),
 *   - the caller's own gate still says go (`gate` is null, or the reason it gave for wanting the body back),
 *   - and the cap has not been reached.
 *
 * `round` is the 0-based index of the round about to be fought. Returns { go, pressing } or { go: false, why, gate }.
 */
export function pressVerdict({ round = 0, rounds = 3, pressRounds = null, sinceHit = 0, outOfReach = false,
                               gate = null } = {}) {
  const pressing = pressRounds != null && Number.isFinite(Number(pressRounds));
  const limit = pressing ? Math.max(1, Math.floor(Number(pressRounds))) : rounds;
  const proof = Math.min(rounds, limit);
  if (round < proof) return { go: true, pressing: false };
  if (round >= limit) return { go: false, why: pressing ? 'cap' : 'rounds' };
  if (outOfReach) return { go: false, why: 'out_of_reach' };
  if (sinceHit >= proof) return { go: false, why: 'quiet' };
  if (gate) return { go: false, why: 'gate', gate: String(gate) };
  return { go: true, pressing: true };
}

/**
 * What a fight says about itself when its round budget, and nothing else, ended it. The opening words are the ones
 * every reader already matches ("still alive after N rounds"); what follows says which of the budget's edges it was.
 */
export function handedBackNote(rounds, stopped) {
  const lead = `still alive after ${rounds} rounds. `;
  switch (stopped?.why) {
    case 'cap':
      return lead + 'The swings were landing and the fight ran to its round cap, so the pass looks at the room ' +
                    'again before going on; pass the same foe back to carry on with it.';
    case 'quiet':
      return lead + 'Nothing has landed for several rounds. Either it is too strong, or your attacks are missing — ' +
                    'check the combat lines: "too far away" means the geometry moved you, "avoids/dodges" means you are just unlucky.';
    case 'out_of_reach':
      return lead + 'The last swing was refused as out of reach: it moved away. Walk up to it again rather than ' +
                    'swinging at where it was.';
    case 'gate':
      return lead + `Handed back because ${stopped.gate}.`;
    default:
      return lead + 'Either it is too strong, or your attacks are missing — ' +
                    'check the combat lines: "too far away" means the geometry moved you, "avoids/dodges" means you are just unlucky.';
  }
}

/**
 * The pace of one fight() call from the times its attack packets left: how many, and the mean gap between
 * consecutive ones. `swing_ms` is null with fewer than two swings, because one swing has no interval, and never 0.
 */
export function swingPace(times = []) {
  const at = (times || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  return { swings: at.length,
           swing_ms: at.length >= 2 ? Math.round((at[at.length - 1] - at[0]) / (at.length - 1)) : null };
}

/**
 * The pace fields of a fight() result, for a journal line or a ledger row: only the ones that were measured.
 * `swings` and `swing_ms` are absent when the exchange ran somewhere that does not report them (an older keeper
 * behind a newer broker), which must read as "not measured" and never as zero.
 */
export function paceFields(f) {
  const out = {};
  if (Number.isFinite(f?.swings)) out.swings = f.swings;
  if (Number.isFinite(f?.fight_ms)) out.fight_ms = f.fight_ms;
  if (Number.isFinite(f?.swing_ms)) out.swing_ms = f.swing_ms;
  if (f?.handed_back?.why) out.handed_back = f.handed_back.why === 'gate' ? `gate: ${f.handed_back.gate}` : f.handed_back.why;
  return out;
}

/**
 * ONE QUARRY, HOWEVER MANY CALLS IT TOOK. A fight that hits its cap is handed back and resumed, so the `rounds` on a
 * kill row is only the last call's. This carries the running total for the quarry being fought: same object id, same
 * room, and not older than QUARRY_TALLY_STALE_MS (an id is a handle that is renumbered on a save and recycled within
 * hours; this is bookkeeping about the last two minutes and decides nothing). A call that never swung changes nothing.
 */
export function tallyQuarry(prev, f, { room = null, staleMs = QUARRY_TALLY_STALE_MS } = {}) {
  const id = f?.target_id ?? null;
  const startedAt = Number(f?.started_at), fightMs = Number(f?.fight_ms);
  if (id == null || !f?.fought || !Number.isFinite(startedAt) || !Number.isFinite(fightMs)) return prev ?? null;
  const endedAt = startedAt + fightMs;
  const same = !!prev && prev.id === id && prev.room === room && startedAt - prev.lastAt <= staleMs && startedAt >= prev.firstAt;
  const base = same ? prev : { id, room, firstAt: startedAt, calls: 0, rounds: 0, swings: 0, counted: true };
  const counted = base.counted && Number.isFinite(f?.swings);
  return { id, room, firstAt: base.firstAt, lastAt: endedAt, calls: base.calls + 1,
           rounds: base.rounds + (Number(f.rounds) || 0),
           swings: base.swings + (Number.isFinite(f?.swings) ? f.swings : 0), counted };
}

/** The kill row's totals from a tally: every call it took on this quarry, first swing call to the death. */
export function killTotals(tally) {
  if (!tally) return {};
  return { kill_calls: tally.calls, kill_rounds: tally.rounds,
           ...(tally.counted ? { kill_swings: tally.swings } : {}),
           kill_ms: Math.max(0, Math.round(tally.lastAt - tally.firstAt)) };
}
