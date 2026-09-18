#!/usr/bin/env node
// Offline. Reads the baked map, opens no socket, touches no roster.
//
//   node tools/m59-stagespread-test.mjs
//
// A BOUNDARY'S CANDIDATES MUST BE DIFFERENT PLACES, AND THIS IS WHERE THEY ARE CREATED.
//
// `leaveViaAny` spends a bounded three walks on a boundary and then lets `travel` re-plan.
// That bargain only holds if the three tries are different squares. `distinctStagesFirst`
// (814f377) was the first attempt at keeping it — it reorders duplicates to the tail — and
// reordering cannot help when EVERY entry is a duplicate. This pins the place they are made.
//
// `_computeExits` walks each crossing on a wall and used to take `nearestIn(...)`: the single
// nearest staging square. On a short wall the nearest stage for every crossing is the SAME
// square, so four ways through published four copies of one, `distinctStagesFirst` folded
// them into one attempt, and the budget bought that attempt three times.
//
// THE INCIDENT, 2026-09-17, and it is the reason this file exists. Kardde's Canyon (49) north
// to the Main gate of Barloque offers four crossings at fine x 1392/1424/1440/1456. From the
// room body the nearest stage for all four is r1c21 — and r1c21 is the ONE square on that
// boundary the collision model refuses (`geometry_blocked`, raised before any packet is
// sent). r1c22 crosses on the first try, measured live on the lab server. But r1c22 was only
// ever offered when the body was ALREADY standing on it, because only then was it nearest.
//
// A failed crossing leaves the body standing on the anchor. So the first attempt walks a
// character onto r1c21, and every attempt after that starts there and can never try anything
// else. Marco Polo did it 13,777 times over 22.85 hours; the fleet's transit books hold 5,910
// refusals on that boundary and every single one is at 1,21.
//
// The fix is one line of policy: a crossing whose nearest stage is already spoken for falls
// through to its next-nearest, out of its own `stages` list. It cannot invent a square and it
// cannot change a boundary whose crossings already stage apart.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from './m59-world.mjs';
import { sharedRoomGeometry } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAP = join(HERE, '..', 'substrate', 'm59-map.json');
let n = 0;
const ok = (c, why) => { n++; assert.ok(c, why); };

// A BAKE IS NOT ALWAYS PRESENT, and a test that silently passes on a fresh clone is worse
// than one that says why it cannot run. This is the geometry the fleet actually walks on; a
// checkout without it has nothing to assert about.
if (!existsSync(MAP)) {
  console.log('m59-stagespread-test: SKIPPED — no substrate/m59-map.json in this checkout.');
  console.log('  Bake one with `node tools/setup.mjs routes`. Nothing was asserted.');
  process.exit(0);
}

const map = JSON.parse(readFileSync(MAP, 'utf8'));
attachStepMasks(map);
const rooms = map.rooms || map;
const world = new World(null, map);
const F = 64, HALF = 32;

// Every distinct staging square a boundary offers, from a body standing at (col,row).
function stagesFor(roomNum, to, col, row) {
  const room = rooms[String(roomNum)];
  if (!room) return null;
  const geo = sharedRoomGeometry(room);
  if (!geo) return null;
  const me = { col, row, x: col * F + HALF, y: row * F + HALF };
  const out = world._computeExits(room, geo, me, { col, row }) || [];
  const e = out.find(x => x.kind === 'edge' && Number(x.to) === Number(to));
  if (!e) return null;
  return {
    approach: `${e.stand_on.col},${e.stand_on.row}`,
    squares: new Set([`${e.stand_on.col},${e.stand_on.row}`,
                      ...(e.alternates || []).map(a => `${a.col},${a.row}`)]),
    viable: e.standable_on_this_boundary ?? null,
  };
}

// ------------------------------------------------- the incident, from the square it happens on
{
  const onAnchor = stagesFor(49, 593, 21, 1);
  ok(onAnchor, 'room 49 must publish its north crossing to 593 — without it there is nothing '
     + 'to assert and the bake has changed under this test');
  ok(onAnchor.squares.size > 1,
     'standing ON the bake anchor r1c21, the boundary must offer some OTHER staging square. '
     + 'Offering only the square the body is already refused on is the 22-hour loop: '
     + `got ${[...onAnchor.squares].join(' ')}`);
  ok(onAnchor.squares.has('22,1'),
     'and r1c22 specifically, because that is the square measured to cross on the first try '
     + `while r1c21 is refused before any packet: got ${[...onAnchor.squares].join(' ')}`);
}

// ------------------------------------------------- and from inside the room, which is the
// state a character is in when a journey plans this hop in the first place.
{
  const fromBody = stagesFor(49, 593, 12, 8);
  ok(fromBody, 'the same crossing must be published from the room body');
  ok(fromBody.squares.size > 1,
     'a character crossing the room to this boundary must arrive with more than one square to '
     + `try, or its first refusal is also its last: got ${[...fromBody.squares].join(' ')}`);
  ok(fromBody.squares.has('22,1'),
     'including the square that works — this is what makes the FIRST attempt able to succeed, '
     + `rather than only a rescue afterwards: got ${[...fromBody.squares].join(' ')}`);
}

// ------------------------------------------------- it must not have made every wall narrower
//
// The substitution can only ever pick another square out of the same crossing's own `stages`,
// so nothing should LOSE spread. Asserted as a population rather than per boundary, because
// which square a given crossing lands on is allowed to move; what must not happen is walls
// collapsing to one question.
{
  const ids = Object.keys(rooms).filter(k => rooms[k]?.roo).slice(0, 120);
  let boundaries = 0, single = 0;
  for (const id of ids) {
    const room = rooms[id];
    let geo; try { geo = sharedRoomGeometry(room); } catch { continue; }
    if (!geo) continue;
    const col = Math.floor((room.cols ?? 20) / 2), row = Math.floor((room.rows ?? 20) / 2);
    const me = { col, row, x: col * F + HALF, y: row * F + HALF };
    let out; try { out = world._computeExits(room, geo, me, { col, row }); } catch { continue; }
    for (const e of out || []) {
      if (e.kind !== 'edge') continue;
      boundaries++;
      const sq = new Set([`${e.stand_on.col},${e.stand_on.row}`,
                          ...(e.alternates || []).map(a => `${a.col},${a.row}`)]);
      if (sq.size === 1) single++;
    }
  }
  ok(boundaries > 40, `the sweep found only ${boundaries} edge boundaries — it has stopped `
     + 'measuring rather than the map having changed, and a guard that checks nothing passes');
  // Measured on this bake: 26 of 76 before the fix, 6 after. The bound is deliberately loose
  // — it is a regression alarm, not a re-statement of today's number, which would fail on the
  // next re-bake for no reason worth waking anybody for.
  ok(single <= boundaries / 4,
     `${single} of ${boundaries} boundaries offer only ONE staging square. Before this fix it `
     + 'was 26 of 76 and a quarter of the world could not spend its retry budget on a second '
     + 'question. Something has put that back.');
}

console.log(`m59-stagespread-test: ${n} assertions passed`);
