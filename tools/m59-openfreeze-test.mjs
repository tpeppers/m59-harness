#!/usr/bin/env node
// m59-openfreeze-test.mjs — PLAYING DEAD IN THE OPEN DOES NOT WORK ON MONSTERS.
//
//   node tools/m59-openfreeze-test.mjs
//
// Offline. Opens no socket, joins nobody, needs no broker.
//
// ======================== WHAT THIS PINS ========================
//
// A freeze recovers VIGOR and never health — the logoff flag stops HealthTimer with
// everything else. At a proven wall that is half of a real sequence: reconnect, TURN to set
// PFLAG_MOVED_SINCE_ENTRY, heal. Off a wall there is no second half, so the freeze buys
// seconds and spends them on nothing.
//
// MEASURED. Animal, 2026-09-17, room 599, `in_safe_spot: false`, `hold: null`: frozen twelve
// seconds at 4/55 with vigor 135 — never the constraint — and unfroze `before {health: 4} ->
// now {health: 4}`. Zero health across the whole freeze, then dead 1.4s later. The 2026-08-21
// measurement the original refusal was written from says the same thing louder: three
// characters froze at 4, 10 and 13 health in a room of twelve to fifteen monsters and all
// three died.
//
// Operator, 2026-09-18: "the open freeze should be removed as a tactic or only ever done in
// PvP, it will not save you from monsters."
//
// SO THE RULE IS: no wall and no player => refuse, and let the ladder fall through to
// something that MOVES. A wall is still fine. A player is still fine — a person can be
// convinced you are dead; a monster cannot.
//
// THIS REVERSES A STANDING INSTRUCTION (2026-09-10, quoted in playDeadObserved), which is
// why the test states both sides: the earlier argument was that the logoff ends an attack
// AT ONCE, and that is still true. What it is not is sufficient, because nothing spends the
// seconds it buys.

import { Autopilot } from './m59-autopilot.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  — ' + extra : '')); }
};

// OF.PLAYER, from the same table the keeper reads — imported rather than copied, so a
// flag renumbering breaks this test instead of silently making it pass on a monster.
import { OF } from './m59-parse.mjs';
const PLAYER_FLAG = OF.PLAYER;

// ---------------------------------------------------------------------------
// The smallest keeper that `playDead`'s gate reads: a room of objects, a self id,
// a resource table for names, and whether a recovery wall is available.
// ---------------------------------------------------------------------------
function keeper({ atWall = false, occupants = [] } = {}) {
  const k = Object.create(Autopilot.prototype);
  const objects = new Map();
  let id = 100;
  for (const o of occupants) objects.set(++id, { id, flags: o.flags, nameRsc: id });
  const names = new Map([...objects.values()].map((o, i) => [o.nameRsc, occupants[i].name]));
  k.notes = [];
  k.note = (what, detail) => k.notes.push({ what, detail });
  k.s = {
    combat: { active: null },
    client: { selfId: 1, room: { objects }, rsc: { get: n => names.get(n) },
              vitals: () => ({ health: { value: 4, max: 55 } }) },
    world: { room: { num: 599 } },
  };
  k.adoptRecoveryWall = () => atWall;
  k.inert = null;
  k.hold = atWall ? { room: 599, row: 1, col: 1, proven: true, takenAt: Date.now() } : null;
  k.turnedAt = 0;
  k.passes = 1;
  k.tally = { deaths: 0 };
  return k;
}

const MONSTER = { flags: 0, name: 'a troll' };
const STRANGER = { flags: PLAYER_FLAG, name: 'Morpheus' };
const FLEETMATE = { flags: PLAYER_FLAG, name: 'Rowlf' };

// `party.isFleetmate` is consulted through the module the keeper imports. The fixture
// cannot reach into it, so the fleetmate case is asserted through playerThreatPresent's
// observable behaviour rather than by stubbing the party roster.

console.log('\nthe gate itself — playerThreatPresent');
{
  ok('an empty room reports no player', keeper().playerThreatPresent() === false);
  ok('a room of monsters reports no player',
     keeper({ occupants: [MONSTER, MONSTER] }).playerThreatPresent() === false);
  ok('a non-fleet player IS reported',
     keeper({ occupants: [STRANGER] }).playerThreatPresent() === true);
  ok('a room we cannot read reports NOBODY, which refuses the freeze — the safe direction',
     (() => { const k = keeper(); k.s.client.room = null; return k.playerThreatPresent() === false; })());
}

console.log('\nthe refusal — no wall and no player is the case that kills');
{
  const k = keeper({ atWall: false, occupants: [MONSTER, MONSTER, MONSTER] });
  const got = await k.playDead('at 4 health with 3 adjacent');
  ok('playDead REFUSES in the open against monsters', got === false);
  ok('...and says why, in a line a person can grep',
     k.notes.some(n => /refusing to play dead in the open/.test(n.what)),
     JSON.stringify(k.notes.map(n => n.what)));
  ok('...naming that it does not work on monsters rather than that it failed',
     k.notes.some(n => /does not work on monsters/.test(n.what)));
}

console.log('\nthe two cases that are still allowed');
{
  // A WALL: the freeze is half of reconnect-turn-heal, so it keeps its meaning.
  const wall = keeper({ atWall: true, occupants: [MONSTER] });
  // Being hit right now — a logoff with nothing to stop is refused (m59-logoffgate-test.mjs).
  wall.s.damagedAt = Date.now();
  let reached = false;
  wall.playDeadObserved = async () => { reached = true; return true; };
  await wall.playDead('at a proven wall');
  ok('at a proven wall the freeze is still attempted', reached === true);

  // A PLAYER: a person can be convinced you are dead; a monster cannot.
  const pvp = keeper({ atWall: false, occupants: [STRANGER, MONSTER] });
  let reachedPvp = false;
  pvp.playDeadObserved = async () => { reachedPvp = true; return true; };
  await pvp.playDead('a player is here');
  ok('in the open WITH A PLAYER present the freeze is still attempted', reachedPvp === true);

  // And active PVP combat short-circuits before any of this, as it always did.
  const inCombat = keeper({ atWall: false, occupants: [MONSTER] });
  inCombat.s.combat = { active: { pvp: true }, tick: async () => {} };
  ok('active PVP combat still returns true without consulting the wall',
     (await inCombat.playDead('pvp')) === true);
}

console.log('\nthe refusal must not be silent to the caller');
{
  // Callers branch on the return value and fall through to a rung that MOVES. A refusal
  // that threw, or returned true, would strand the character exactly where the freeze did.
  const k = keeper({ atWall: false, occupants: [MONSTER] });
  const got = await k.playDead('x');
  ok('it returns false rather than throwing, so the ladder falls through', got === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
