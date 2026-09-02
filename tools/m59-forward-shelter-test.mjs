#!/usr/bin/env node
// A WALL ON THE ROAD AHEAD BEATS A NEARER ONE BEHIND, AND DISTANCE IS NOT A REASON.
//
//   node tools/m59-forward-shelter-test.mjs
//
// Offline: reads the baked map, opens no socket, touches no roster.
//
// WHAT THIS PINS. On 2026-09-01 Bbbb died in The border of the Badlands (585) at 7 of 20
// health, thirty-nine seconds on one square, after the survival ladder offered it the only
// wall it could find — 31 squares back down the road it had just been bitten on — and the
// walk there failed. The room's own cover is at its two doors: one square at the north
// doorway (r1c1) and thirteen at rows 44-53. A hurt traveller in the middle was always sent
// to whichever was nearer, whatever direction it was going.
//
// The operator's rule: distance to a wall does not matter as long as it is reachable and
// the exit is still reachable from it, and a wall in the direction of travel is preferred
// strongly — five or ten to one — over a small backtrack. `nearestSafeSpot` takes the exit
// as `onward` and a `forwardBias`; these are the assertions that make the rule concrete.
import { readFileSync } from 'node:fs';
import { RoomGeometry } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { movementMapFile } from './m59-map-path.mjs';
import { nearestSafeSpot, safeSpots } from './m59-safespots.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

const map = JSON.parse(readFileSync(movementMapFile(), 'utf8'));
const byRoom = new Map();
attachStepMasks(map, { geometryOf: room => {
  let g = byRoom.get(room);
  if (!g) { g = RoomGeometry.fromJSON(room.roo); byRoom.set(room, g); }
  return g;
} });
const geo = byRoom.get(map.rooms['585']);
const NORTH_DOOR = { row: 1, col: 2 };      // the anchor to 584, The Flatlands
const SOUTH_DOOR = { row: 53, col: 14 };    // the anchor to 586, Main gate to the city of Tos
const MID = { row: 13, col: 4 };            // roughly where Bbbb was standing
const at = s => s ? `r${s.row}c${s.col}` : 'none';

console.log('\nThe border of the Badlands (585) — where the cover actually is');
{
  const all = safeSpots(geo, { limit: Infinity });
  const north = all.filter(s => s.row < 10), south = all.filter(s => s.row >= 40);
  ok('every candidate wall is at one end of the room or the other',
     north.length + south.length === all.length && north.length >= 1 && south.length >= 10,
     `${all.length} candidates: ${north.length} north of row 10, ${south.length} south of row 40`);
}

console.log('\nwithout a journey, nothing changes: the nearest reachable wall, inside `within`');
{
  const s = nearestSafeSpot(geo, MID, { within: 12 });
  ok('from the middle the nearest wall inside 12 is the north doorway corner', s && s.row === 1 && s.col === 1, at(s));
  const far = nearestSafeSpot(geo, { row: 30, col: 11 }, { within: 12 });
  ok('and from row 30 there is nothing inside 12 at all', far === null, at(far));
  const wide = nearestSafeSpot(geo, { row: 30, col: 11 }, { within: 53 });
  ok('...until the caller widens the search, which is the whole-room behaviour of takeSafeSpot',
     wide && wide.row >= 40, at(wide));
}

console.log('\nheading north: the doorway corner is forward, and distance is not a cap');
{
  const s = nearestSafeSpot(geo, { row: 30, col: 11 }, { onward: NORTH_DOOR, forwardBias: 8, allowExit: false });
  ok('from row 30 with the north door as the exit, the wall 29 squares AHEAD is chosen over the ones 14 squares BEHIND',
     s && s.row === 1 && s.col === 1, at(s) + (s ? ` progress ${s.progress} steps ${s.steps_away}` : ''));
  ok('and it reports its progress toward the exit', s && s.progress > 20, String(s?.progress));
}

console.log('\nheading south: the same room, the opposite answer');
{
  const s = nearestSafeSpot(geo, MID, { onward: SOUTH_DOOR, forwardBias: 8 });
  ok('from the middle with the south door as the exit, a wall in the south end is chosen over the doorway corner 12 squares behind',
     s && s.row >= 40, at(s) + (s ? ` progress ${s.progress}` : ''));
}

console.log('\nthe bias is a bias, not a filter');
{
  const forward = nearestSafeSpot(geo, MID, { onward: SOUTH_DOOR, forwardBias: 8 });
  const flat = nearestSafeSpot(geo, MID, { onward: SOUTH_DOOR, forwardBias: 0 });
  ok('with the bias at zero the nearest wall wins again, whichever way it lies',
     flat && flat.row === 1 && flat.col === 1, at(flat));
  ok('so the forward choice is the bias doing its job and not the exit filtering the list',
     forward && forward.row !== flat.row, `${at(forward)} vs ${at(flat)}`);
}

console.log('\nreaching the exit is an addition, never a replacement');
{
  // Corrected 2026-09-01: for a day an `onward` nothing could reach rejected every wall as
  // one-way, and a character under attack in the Cragged Mountains was told there was
  // nothing to take in a room with sixteen walls on file. A wall we can walk back from is
  // always eligible; the exit's reachability only ADDS candidates and the forward bonus.
  const s = nearestSafeSpot(geo, MID, { onward: { row: 0, col: 0 }, forwardBias: 8 });
  const plain = nearestSafeSpot(geo, MID, {});
  ok('an exit no square can reach still yields the wall we can come back from',
     !!s && !!plain && s.row === plain.row && s.col === plain.col && s.kind !== 'exit', at(s) + ' vs ' + at(plain));
}

console.log('\nthe exit is a wall: on a journey the onward square joins the candidates');
{
  const s = nearestSafeSpot(geo, MID, { onward: SOUTH_DOOR, forwardBias: 8 });
  ok('the onward exit itself is taken when it can be walked to — crossing breaks every attack',
     s?.kind === 'exit' && s.row === SOUTH_DOOR.row && s.col === SOUTH_DOOR.col, at(s));
  const stats = {};
  nearestSafeSpot(geo, MID, { onward: SOUTH_DOOR, forwardBias: 8, stats });
  ok('and the search says it considered the exit', stats.exit_considered === true, JSON.stringify(stats));
  const wall = nearestSafeSpot(geo, MID, { onward: SOUTH_DOOR, forwardBias: 8, allowExit: false });
  ok('with the exit withheld (the far side of a crossing) a wall is chosen instead',
     !!wall && wall.kind !== 'exit', at(wall));
  const rest = nearestSafeSpot(geo, MID, { forwardBias: 8 });
  ok('a rest or a fight names no exit and never gets one', !!rest && rest.kind !== 'exit', at(rest));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
