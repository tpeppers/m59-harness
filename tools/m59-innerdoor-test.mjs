#!/usr/bin/env node
// A DOOR THAT LEADS BACK INTO THE ROOM IT IS IN — offline, no server, no broker.
//
//   node tools/m59-innerdoor-test.mjs
//
// WHY THIS FILE EXISTS. A room number is not necessarily one connected floor, and the
// repository already knew that — `sameRoomIslandBridgePlan` joins two halves of a room by
// going out through a NEIGHBOURING room and back. What nothing modelled is the shortcut the
// map authors wrote directly: a `go` exit whose destination room IS this room.
//
// Castle Victoria has four of them (castle1.kod:88-98), declared in pairs one row either
// side of an internal wall:
//
//     plExits = Cons([ 9, 32, RID_CASTLE1,  7, 32, ROTATE_NONE ])    south side -> north
//     plExits = Cons([ 8, 32, RID_CASTLE1, 10, 32, ROTATE_NONE ])    north side -> south
//
// A room graph discards a self-loop, so no router ever planned through one. Room 38's floor
// is 23 regions; every entrance — from 2, from 39, from 40 — lands in region 0, and the
// trapdoor down to the Underbasement (41) is at r4c33 in region 3. `anchorReach` answers
// false from every square in the body and it is RIGHT: there is no walk. There is a door.
//
// What it cost: `transitOk` refused room 38 for the pair (39 -> 41), which removes the room
// from the route graph, so `travel(41)` reported no route to a basement people walk to. When
// a route did survive, the mover picked the trapdoor, could not reach it, and ground against
// the internal wall until the job timed out. That is the crate errand's whole failure, and
// the reason the fleet has never been able to work the castle's ground floor.
//
// ELEVEN ROOMS IN THIS MAP DECLARE ONE, so this is a class and not a special case. The
// census below is part of the test: if a re-bake changes it, this should be read again
// rather than quietly adjusted.
//
// ASK THE MAP THE MOVER ENFORCES. Without `attachStepMasks` the coarse grid joins halves of
// a room that the mover keeps apart, and every assertion here inverts — the same trap
// m59-doorside-test records paying for.
import { loadMap } from './m59-map.mjs';
import { attachStepMasks, activeRoutes, regionsOf, anchorReach } from './m59-routes.mjs';
import { sharedRoomGeometry } from './m59-roo.mjs';
import { sameRoomDoors, sameRoomDoorPlan, World } from './m59-world.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

const map = loadMap();
attachStepMasks(map);
const table = activeRoutes();

console.log('\nthe data: Castle Victoria is one room with a wall down it');
{
  const g = regionsOf(table, 38);
  ok('room 38 is not one connected floor', g.regions > 1, `${g.regions} regions`);
  const find = (to, row, col) => g.anchors.find(a =>
    Number(a.to) === to && a.row === row && a.col === col);
  const crate = find(41, 4, 33);
  const stairs = find(39, 1, 19);
  const south = find(38, 9, 32);
  const north = find(38, 8, 32);
  ok('the trapdoor to the Underbasement is baked at r4c33', !!crate);
  ok('the stairs up to room 39 are baked at r1c19', !!stairs);
  ok('and they are in DIFFERENT regions — there is no walk between them',
     crate && stairs && crate.region !== stairs.region,
     `crate region ${crate?.region}, stairs region ${stairs?.region}`);
  ok('the crate is in the same region as the door\'s north side',
     crate && north && crate.region === north.region);
  ok('and the door\'s south side is in the body with the stairs',
     stairs && south && stairs.region === south.region);
  // The bake is not wrong and must not be "fixed": it reports the FLOOR, and the floor
  // really is cut in two. A door is not floor.
  ok('so the bake honestly reports no walk to the trapdoor',
     anchorReach(table, 38, { row: 1, col: 19 }, { row: 4, col: 33 }) === false);
  ok('and a real one where there is one',
     anchorReach(table, 38, { row: 8, col: 32 }, { row: 4, col: 33 }) === true);
}

console.log('\nand the wall is DIRECTED, which is why one door is enough');
{
  // THE ASYMMETRY IS THE WHOLE SHAPE OF THIS FIX, and it was found the slow way: by watching
  // a character that had got in fail to be pulled back out, then asking the geometry the
  // question both ways round.
  //
  // Region 3 is RAISED. You can step down off it and you cannot step up onto it, exactly the
  // way a fall makes a room directed in Ukgoth. So the door is needed in ONE direction, and a
  // plan that asked for one in both would be wrong in an expensive way - it would send a
  // character that can simply walk home hunting for a doorway instead.
  const geo = sharedRoomGeometry(map.rooms[38]);
  const walk = (a, b) => geo.path(a.row, a.col, b.row, b.col, { fine: true }).found;
  const STAIRS = { row: 1, col: 19 }, CRATE = { row: 4, col: 33 };
  ok('you cannot walk UP from the stairs to the trapdoor', walk(STAIRS, CRATE) === false);
  ok('and you CAN walk down from beside the trapdoor to the stairs',
     walk({ row: 3, col: 34 }, STAIRS) === true);
  const out = (map.rooms[38].goExits ?? []).filter(e => e.to === 39)
    .map(e => ({ row: e.row, col: e.col }));
  const home = sameRoomDoorPlan(map, 38, geo, { row: 3, col: 34 }, out);
  ok('so the way home needs no door at all',
     home?.doors?.length === 0 && home?.walkable === true, JSON.stringify(home));
  ok('while the way in needs exactly one',
     sameRoomDoorPlan(map, 38, geo, STAIRS, [CRATE])?.doors?.length === 1);
}

console.log('\nsameRoomDoors finds them, and nothing else');
{
  const doors = sameRoomDoors(map.rooms[38]);
  ok('room 38 declares eight internal door squares', doors.length === 8, String(doors.length));
  ok('every one points back at its own room', doors.every(d => Number(d.to) === 38));
  ok('every one names where it lands',
     doors.every(d => Number.isFinite(d.arriveRow) && Number.isFinite(d.arriveCol)));
  ok('the trapdoor to 41 is NOT one of them — it leaves the room',
     !doors.some(d => d.row === 4 && d.col === 33));
  ok('a room with no such exit gets an empty list', sameRoomDoors(map.rooms[41]).length === 0);
  ok('and a missing room does not throw', sameRoomDoors(undefined).length === 0);

  // THE COORDINATES ARE THE KOD'S OWN, digit for digit. dungeon.kod:95 is
  // `plExits = Cons([ 25, 2, RID_CASTLE1, 5, 32, ROTATE_NONE ])`, and the bake says
  // {row:25, col:2, to:38, arriveRow:5, arriveCol:32}. Worth pinning: almost everything
  // else about coordinates here needs an offset, and this does not.
  const back = map.rooms[41].goExits[0];
  ok('room 41\'s way out matches dungeon.kod exactly',
     back.row === 25 && back.col === 2 && back.to === 38 &&
     back.arriveRow === 5 && back.arriveCol === 32, JSON.stringify(back));
}

console.log('\nthe plan: from the body, one door');
{
  const geo = sharedRoomGeometry(map.rooms[38]);
  const CRATE = [{ row: 4, col: 33 }];
  const plan = sameRoomDoorPlan(map, 38, geo, { row: 1, col: 19 }, CRATE);
  ok('a character on the stairs gets a plan', !!plan);
  ok('it needs exactly one door', plan?.doors?.length === 1, JSON.stringify(plan?.doors));
  const d = plan?.doors?.[0];
  ok('and it is the south side of the wall at column 32',
     d && d.row === 9 && d.col === 32, d && `r${d.row}c${d.col}`);
  ok('which lands north of the wall', d && d.arriveRow === 7 && d.arriveCol === 32);
  ok('the plan says it is not a walk', plan?.walkable === false);

  // Already on the far side: no door, and it must say so rather than opening one for
  // nothing — a needless `go` on a door square is a teleport back to where it came from.
  const near = sameRoomDoorPlan(map, 38, geo, { row: 7, col: 32 }, CRATE);
  ok('a character already north of the wall needs no door', near?.doors?.length === 0);
  ok('and is told the walk exists', near?.walkable === true);

  // The way back is a plain walk: the trapdoor and the exits to room 2 are on... no. They
  // are not, and this is the asymmetry worth pinning rather than assuming.
  const out = (map.rooms[38].goExits ?? []).filter(e => e.to === 2)
    .map(e => ({ row: e.row, col: e.col }));
  const home = sameRoomDoorPlan(map, 38, geo, { row: 4, col: 33 }, out);
  ok('and there is a way back from the trapdoor to the front door', !!home,
     home && JSON.stringify(home.doors.map(x => `r${x.row}c${x.col}`)));
}

console.log('\nthe plan refuses rather than inventing');
{
  const geo = sharedRoomGeometry(map.rooms[38]);
  ok('no targets, no plan', sameRoomDoorPlan(map, 38, geo, { row: 1, col: 19 }, []) === null);
  ok('no geometry, no plan',
     sameRoomDoorPlan(map, 38, null, { row: 1, col: 19 }, [{ row: 4, col: 33 }]) === null);
  ok('a room with no internal doors gets no plan',
     sameRoomDoorPlan(map, 41, sharedRoomGeometry(map.rooms[41]),
                      { row: 25, col: 2 }, [{ row: 10, col: 6 }]) === null);
  // A target nothing can reach through any chain of doors. The whole point of returning
  // null here is that the caller falls through to the ordinary path and fails there, in
  // the place that can say why, rather than walking a plan that was never going to work.
  ok('an unreachable target gets no plan',
     sameRoomDoorPlan(map, 38, geo, { row: 1, col: 19 }, [{ row: 0, col: 0 }]) === null);
}

console.log('\ntransitOk stops removing the room from the route graph');
{
  const w = new World(null, map);
  const t = w.transitOk();
  ok('39 -> 41 through Castle Victoria is no longer a hard refusal', t(38, 39, 41) === null);
  ok('2 -> 41 likewise', t(38, 2, 41) === null);
  // The softening must not become a blanket yes. An ordinary pair the bake CAN join still
  // gets a real answer, and a room that declares no internal door keeps its hard false —
  // which is what stops this resurrecting the stranded exits the bake exists to rule out.
  ok('a pair the bake can walk is still a real yes', t(38, 39, 2) === true);
  ok('a room with no internal door is unaffected',
     sameRoomDoors(map.rooms[2]).length === 0);
}

console.log('\nit is a class, not a special case');
{
  const rooms = Object.values(map.rooms ?? map)
    .filter(r => sameRoomDoors(r).length > 0);
  ok('eleven rooms in this map declare a door back into themselves',
     rooms.length === 11, `${rooms.length}: ${rooms.map(r => r.num).join(', ')}`);
  // Every one of them is a room where a character can be standing in a part of it that
  // cannot walk to a published exit. If a re-bake changes this number, read the list
  // rather than editing the expectation.
  ok('Castle Victoria is one of them', rooms.some(r => Number(r.num) === 38));
  ok('so is Blackstone Keep, on the feast road', rooms.some(r => Number(r.num) === 951));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
