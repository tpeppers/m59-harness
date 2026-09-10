#!/usr/bin/env node
// READY-TO-LEAVE-SANCTUARY MUST LET A CHARACTER ESCAPE A WRONG ROOM EVEN WHEN VITALS
// HAVE NOT COME BACK YET.
//
//   node tools/m59-sanctuary-test.mjs
//
// After a broker restart the connection takes several seconds to settle and the
// vitals read returns null for health/mana/vigor. Without this fix the keeper
// interprets null as "not whole" and parks the character inside whatever safe room
// it woke up in -- a recovery that never completes. JayB and Lee were stuck in
// room 1016 (Mausoleum) for that exact reason: assignedRoom 586, current 1016,
// vitals null, and the gate stayed closed.
//
// The fix is one line of judgement: when the character is in the wrong room by
// assignment, unknown vitals are not a reason to stay. They are a reason to leave.
// These are the cases that must not regress.

// Set M59_SPAWN_FILE BEFORE the autopilot is imported -- loadSpawns() caches the
// first read forever, so the file has to exist at the moment the import resolves.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-sanctuary-test-'));
const spawnFile = join(dir, 'spawns.json');
writeFileSync(spawnFile, JSON.stringify({ rooms: {
  1016: [],                              // Mausoleum -- no spawns, that is the point
  586:  [],                              // assigned room treated as a sanctuary for the
                                        // same reason (no spawns, but kept separate)
  999:  [{ creature: 'giant rat', huntable: true }],
                                        // a hunting ground, so this is NOT a sanctuary
}}));
process.env.M59_SPAWN_FILE = spawnFile;

const { Autopilot } = await import('./m59-autopilot.mjs');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' -- ' + detail : ''}`);
};

// ------------------------------------------------------------------ the fake room
//
// sanctuary() reads s.world.room.num and the spawn table; vitals() reads c.vitals().
// armedForSure() reads c.equipment(). A weapon in the equipped list makes
// armedForSure() say yes without dragging in the broker.
function keeper({ assignedRoom, currentRoom, vitalsValue = null }) {
  const c = {
    selfId: 99,
    room: { id: currentRoom, objects: new Map() },
    rsc: { get: () => '' },
    vitals: () => vitalsValue,
    equipment: () => ({ known: true, equipped: [{ name: 'short sword' }] }),
    inventory: [],
  };
  const s = {
    name: 'test', live: true, client: c,
    world: { room: { num: currentRoom, name: 'Test Room' }, geometry: null },
  };
  const ap = new Autopilot(s, { mode: 'farm', policy: { hunt: 'giant rat' } });
  ap.policy.assignedRoom = assignedRoom;
  return ap;
}

// ------------------------------------------------------------------ the cases

// 1. WRONG ROOM AND UNKNOWN VITALS: the broker restart case. Must allow leaving.
{
  const ap = keeper({ assignedRoom: 586, currentRoom: 1016, vitalsValue: null });
  const r = await ap.readyToLeaveSanctuary('back to work');
  ok('vitals null + wrong room -> allow leaving', r === true,
     `got ${JSON.stringify(r)}`);
}

// 2. NO ASSIGNMENT, UNKNOWN VITALS: still cautious. A character with nowhere to
//    be has no reason to walk out blind.
{
  const ap = keeper({ assignedRoom: null, currentRoom: 1016, vitalsValue: null });
  const r = await ap.readyToLeaveSanctuary('anywhere');
  ok('vitals null + no assignment -> stay put', r === false,
     `got ${JSON.stringify(r)}`);
}

// 3. ALREADY IN THE ASSIGNED ROOM, UNKNOWN VITALS: still cautious. There is no
//    place to be that we are not already in, so unknown vitals rightly mean wait.
{
  const ap = keeper({ assignedRoom: 586, currentRoom: 586, vitalsValue: null });
  const r = await ap.readyToLeaveSanctuary('anywhere');
  ok('vitals null + already home -> stay put', r === false,
     `got ${JSON.stringify(r)}`);
}

// 4. SANITY CHECK: whole vitals + wrong room still allow leaving (pre-existing
//    behaviour must not have regressed).
{
  const ap = keeper({ assignedRoom: 586, currentRoom: 1016,
    vitalsValue: { health: { value: 30, max: 30, pct: 1.0 },
                   mana:   { value: 30, max: 30, pct: 1.0 },
                   vigor:  { value: 200, scale_max: 200 } } });
  const r = await ap.readyToLeaveSanctuary('back to work');
  ok('vitals full + wrong room -> allow leaving', r === true,
     `got ${JSON.stringify(r)}`);
}

// 5. NOT IN A SANCTUARY: never gated by this check. A monster room is its own
//    problem and not one this function is allowed to make worse.
{
  const c = {
    selfId: 99, room: { id: 999, objects: new Map() }, rsc: { get: () => '' },
    vitals: () => null,
    equipment: () => ({ known: true, equipped: [{ name: 'short sword' }] }),
    inventory: [],
  };
  const s = { name: 'test', live: true, client: c,
    world: { room: { num: 999, name: 'hunting ground' }, geometry: null } };
  const ap = new Autopilot(s, { mode: 'farm', policy: { hunt: 'giant rat' } });
  ap.policy.assignedRoom = 999;
  const r = await ap.readyToLeaveSanctuary('already outside');
  ok('not in sanctuary -> short-circuit true even with null vitals', r === true,
     `got ${JSON.stringify(r)}`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE OTHER DEPARTURE GATE: HURT, IN THE OPEN, AND HOLDING NOTHING.
//
// `readyToLeaveSanctuary` above owns the inn and `leaveHold` owns a held wall. Between them
// sat the departure that actually kills this fleet: a keeper farming in a monster room, no
// wall held, hurt, deciding to walk somewhere else. Measured over the 268 travelling deaths
// since 2026-09-01, on the 163 whose departure is inside the frame ring: 128 (79%) set off
// below their own flee line holding nothing, against 4 that were holding a wall. Median time
// from setting off to dying: twenty-five seconds.
//
// These pin the three answers. The one that must never appear is a fourth: waiting in the open.

function outdoors({ health = null, hold = null, room = 999 } = {}) {
  const c = {
    selfId: 99,
    room: { id: room, objects: new Map() },
    rsc: { get: () => '' },
    vitals: () => (health === null ? null : { health }),
    equipment: () => ({ known: true, equipped: [{ name: 'short sword' }] }),
    inventory: [],
  };
  const s = { name: 'test', live: true, client: c,
    world: { room: { num: room, name: room === 999 ? 'hunting ground' : 'somewhere safe' },
             geometry: null } };
  const ap = new Autopilot(s, { mode: 'farm', policy: { hunt: 'giant rat' } });
  ap.policy.assignedRoom = room;
  ap.hold = hold;
  ap.walls = [];
  ap.takeSafeSpot = async (why, quarry, opts) => {
    ap.walls.push({ why, opts });
    if (ap.wallAvailable) { ap.hold = { col: 5, row: 5, takenAt: Date.now(), proven: true }; }
    return ap.wallAvailable ? { took: true } : { took: false, why: 'no wall found' };
  };
  return ap;
}

console.log('\nSETTING OFF HURT WITH NOTHING HELD');
{
  // 1. THE FIX. Hurt, in a room that spawns, no wall held -> take a wall, refuse this attempt.
  const ap = outdoors({ health: { value: 12, max: 50 } });   // 24%, the modal departure health
  ap.wallAvailable = true;
  const r = await ap.leaveHold('travelling to a room that generates our prey');
  ok('hurt and holding nothing -> the departure is refused', r.refused === true,
     JSON.stringify(r));
  ok('and a wall was actually taken, not merely wanted', ap.walls.length === 1 && !!ap.hold);
  ok('and the wall was chosen as a journey stopover, not as a fight position',
     ap.walls[0]?.opts?.source === 'travel', JSON.stringify(ap.walls[0]?.opts));

  // 2. THE WORSE DIRECTION, REFUSED. No wall to be had: the journey must GO, because standing
  //    hurt in a spawn room with nothing at our back is not safety. readyToLeaveSanctuary's
  //    first line refuses to create this state and so does this.
  const stuck = outdoors({ health: { value: 12, max: 50 } });
  stuck.wallAvailable = false;
  const s2 = await stuck.leaveHold('travelling to a room that generates our prey');
  ok('hurt with NO wall available -> the journey stands rather than waiting in the open',
     s2.refused !== true, JSON.stringify(s2));
  ok('and it tried before giving up', stuck.walls.length === 1);

  // 3. Healthy departures are untouched — no wall, no refusal, no cost.
  const well = outdoors({ health: { value: 48, max: 50 } });
  well.wallAvailable = true;
  const s3 = await well.leaveHold('walking to the bank');
  ok('a healthy character sets off unchanged', s3.refused !== true, JSON.stringify(s3));
  ok('and is not made to take a wall it does not need', well.walls.length === 0);
}

console.log('\nTHE GATE MUST NOT REACH WHAT IT DOES NOT OWN');
{
  // A forced departure is a withdrawal, a resume or a rested character going back on the road.
  // None of them is discretionary and none may be held up.
  const forced = outdoors({ health: { value: 5, max: 50 } });
  forced.wallAvailable = true;
  const r = await forced.leaveHold('carrying on with the journey', { force: true });
  ok('force skips the gate entirely', r.refused !== true && forced.walls.length === 0,
     JSON.stringify(r));

  // An inn has its own gate with a longer rule. Running both would be two thresholds for one
  // question, and the sanctuary one also knows how to give up and go.
  const inn = outdoors({ health: { value: 12, max: 50 }, room: 1016 });
  inn.wallAvailable = true;
  const r2 = await inn.leaveHold('leaving the inn');
  ok('a sanctuary is left to readyToLeaveSanctuary', r2.refused !== true && inn.walls.length === 0,
     JSON.stringify(r2));

  // The rule every other gate in this file follows: a missing bar is not an empty one. This is
  // the broker-restart case the top of this file exists for, arriving at a second door.
  const blind = outdoors({ health: null });
  blind.wallAvailable = true;
  const r3 = await blind.leaveHold('back to work');
  ok('unknown vitals are not a reason to stay', r3.refused !== true && blind.walls.length === 0,
     JSON.stringify(r3));

  // And a character that IS holding a wall still goes down the original branch, which has the
  // cap and the `leaving the wall anyway` escape. This gate only ever handles the no-hold case.
  const held = outdoors({ health: { value: 12, max: 50 },
                          hold: { col: 1, row: 1, takenAt: Date.now(), proven: true } });
  held.wallAvailable = true;
  const r4 = await held.leaveHold('roaming to look for hunting elsewhere');
  ok('a held character is refused by the ORIGINAL rule, not this one',
     r4.refused === true && held.walls.length === 0, JSON.stringify(r4));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
