#!/usr/bin/env node
// m59-logoffgate-test.mjs — A LOGOFF HAS TO BE FOR SOMETHING.
//
//   node tools/m59-logoffgate-test.mjs
//
// Offline. Opens no socket, joins nobody, needs no broker.
//
// ======================== WHAT THIS PINS ========================
//
// Every logoff outside an inn leaves a LogoffGhost whose timer lands about ten minutes out;
// offline at that instant and the server takes items, spell and skill points and base max
// health (kod `logghost.kod` InflictPenalties), escalating toward the cost of a death. A
// second logoff within two minutes of logging in keeps the OLD deadline (`user.kod`
// UserLogoff), so rapid reconnects are repeated rolls at being offline when it lands.
//
// MEASURED ON PROD, 2026-09-24: 31 logoffs per character per hour, median 54s apart, 32% at
// FULL health. Rizzo: 898 in one day in map 2 (Outside Castle Victoria), which spawns
// nothing, every one at full health, from chalice duty — six in twenty-five seconds.
//
// THE RULE: at a wall, with no player in the room, a logoff is taken only when something is
// hitting us (6s, or 18s below the flee line), and above the flee line not within two
// minutes of the last login. Otherwise the character rests at the wall, which is what the
// logoff was going to end in anyway. Below the flee line and under attack, and with a
// player present, playDead is exactly what it was.

import { Autopilot } from './m59-autopilot.mjs';
import { OF } from './m59-parse.mjs';
import { currentSurvivalDecision } from './m59-survival-decision.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  — ' + extra : '')); }
};

const SEC = 1000;
function keeper({ hp = 75, max = 75, hitAgo = null, loggedInAgo = 10 * 60 * SEC,
                  occupants = [], atWall = true, fleeBelow = 0.4 } = {}) {
  const k = Object.create(Autopilot.prototype);
  const objects = new Map();
  let id = 100;
  for (const o of occupants) objects.set(++id, { id, flags: o.flags, nameRsc: id });
  const names = new Map([...objects.values()].map((o, i) => [o.nameRsc, occupants[i].name]));
  const now = Date.now();
  k.notes = [];
  k.note = (what, detail) => k.notes.push({ what, detail });
  k.s = {
    name: 'fixture',
    combat: { active: null },
    client: { selfId: 1, self: { row: 5, col: 5 }, room: { objects }, rsc: { get: n => names.get(n) },
              vitals: () => ({ health: { value: hp, max }, vigor: { value: 150, max: 200 } }) },
    world: { room: { num: 2 } },
    damagedAt: hitAgo == null ? 0 : now - hitAgo,
    loggedInAt: now - loggedInAgo,
    cancelMovement: () => {},
  };
  k.policy = { fleeBelow, restBelow: 0.7 };
  k.safety = () => ({ fleeAt: fleeBelow });
  k.adoptRecoveryWall = () => {
    if (!atWall) return false;
    k.hold ??= { room: 2, row: 5, col: 5, proven: true, takenAt: Date.now() };
    return true;
  };
  k.inert = null;
  k.hold = null;
  k.turnedAt = 0;
  k.rejoinedAt = 0;
  k.passes = 1;
  k.tally = { deaths: 0 };
  k.loggedOff = 0;
  k.playDeadObserved = async () => { k.loggedOff++; return true; };
  return k;
}

const MONSTER = { flags: 0, name: 'a skeleton' };
const STRANGER = { flags: OF.PLAYER, name: 'Morpheus' };

console.log('\nRizzo, map 2, full health, nothing hitting him');
{
  const k = keeper({ hp: 75, max: 75 });
  const got = await k.playDead('on chalice duty while the holder is away');
  ok('playDead does NOT log off', k.loggedOff === 0);
  ok('...returns false, so callers fall through to resting', got === false);
  ok('...and leaves a rest_safe recovery at the wall, not a pending logoff',
     currentSurvivalDecision(k.s)?.strategy === 'rest_safe'
     && currentSurvivalDecision(k.s)?.status === 'recovering',
     JSON.stringify(currentSurvivalDecision(k.s)));
  ok('...coded as not under attack', currentSurvivalDecision(k.s)?.reason_code === 'logoff_not_under_attack');
  ok('...counted', k.tally.logoffs_declined === 1);
  ok('...and said once in a greppable line', k.notes.filter(n => /not logging off/.test(n.what)).length === 1);
  await k.playDead('again');
  await k.playDead('and again');
  ok('asking every pass logs off none of the times', k.loggedOff === 0);
  ok('...and does not repeat the note every pass', k.notes.filter(n => /not logging off/.test(n.what)).length === 1);
}

console.log('\nchalice duty through its real caller');
{
  const k = keeper({ hp: 75, max: 75 });
  k.hereRoom = () => 2;
  k.travel = async () => { throw new Error('should not travel — already at the post'); };
  const cfg = { post_room: 2, station_room: 2 };
  await k.chaliceParked(cfg, 'alternate', true);
  ok('parking the alternate takes the wall', !!k.hold);
  ok('...without a logoff', k.loggedOff === 0);
  await k.chaliceParked(cfg, 'alternate', true);
  ok('a second pass leaves the held wall alone', k.loggedOff === 0);
}

console.log('\nat the wall and being hit, above the flee line');
{
  const fresh = keeper({ hp: 60, max: 75, hitAgo: 2 * SEC, loggedInAgo: 30 * SEC, occupants: [MONSTER] });
  await fresh.playDead('hit while resting');
  ok('logged in 30s ago: refused — the previous ghost deadline still stands', fresh.loggedOff === 0);
  ok('...coded as too soon', currentSurvivalDecision(fresh.s)?.reason_code === 'logoff_too_soon');

  const settled = keeper({ hp: 60, max: 75, hitAgo: 2 * SEC, loggedInAgo: 5 * 60 * SEC, occupants: [MONSTER] });
  await settled.playDead('hit while resting');
  ok('logged in 5 minutes ago: the logoff is taken', settled.loggedOff === 1);

  const reconnected = keeper({ hp: 60, max: 75, hitAgo: 2 * SEC, loggedInAgo: 5 * 60 * SEC, occupants: [MONSTER] });
  reconnected.rejoinedAt = Date.now() - 20 * SEC;
  await reconnected.playDead('hit again');
  ok('a playDead reconnect 20s ago counts as the last login too', reconnected.loggedOff === 0);
  ok('...and the rest waits on the turn a reconnect owes',
     currentSurvivalDecision(reconnected.s)?.phase === 'turn_required');
}

console.log('\nbelow the flee line — survival first');
{
  const k = keeper({ hp: 20, max: 75, hitAgo: 10 * SEC, loggedInAgo: 5 * SEC, occupants: [MONSTER] });
  await k.playDead('at 20/75');
  ok('hit 10s ago, logged in 5s ago: the logoff is STILL taken', k.loggedOff === 1);

  const quiet = keeper({ hp: 20, max: 75, hitAgo: 40 * SEC, occupants: [MONSTER] });
  await quiet.playDead('at 20/75, quiet');
  ok('nothing for 40s at a wall that holds: rest, even this hurt', quiet.loggedOff === 0);
}

console.log('\nplayers and PvP are untouched');
{
  const k = keeper({ hp: 75, max: 75, occupants: [STRANGER] });
  await k.playDead('a player is here');
  ok('a non-fleet player in the room: the logoff is taken as before', k.loggedOff === 1);

  const pvp = keeper({ hp: 75, max: 75 });
  pvp.s.combat = { active: { pvp: true }, tick: async () => {} };
  ok('active PvP combat short-circuits as before', (await pvp.playDead('pvp')) === true && pvp.loggedOff === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
