#!/usr/bin/env node
// A DOOR THAT OPENS UNDER A STANDING BODY MUST CHANGE THE EXITS IT IS OFFERED. Offline.
//
//   node tools/m59-illusion-exit-cache-test.mjs
//
// Icky Cave (27) -> Ugol's Warren Entrance (2500) is behind an illusion wall: cave2.kod
// sectors 1-5 drop to 24 for ~30 s after a dispel. The bake carries that state as
// `stepMaskVariants["sector1@24+...+sector5@24"]` and the keeper's door observer swaps it in.
//
// What broke (t4, prod 2026-10-26 .. 2026-11-05, every window): `World.exits()` caches its
// flood by (room, origin square, fine position) -- NOT by door state. A character standing
// still on the dispel square had its exits computed while the wall was shut; after the dispel
// the same key was served from the cache, so exits() offered only 587 and 5, `route()`
// constrained the first hop to those (`availableFirstHops`), and travel planned 27>5>27>2500
// (`planned_legs: 3`) or, once the wall shut again, reported "no route from 27 to 2500 in the
// graph -- the obstacle is the graph itself". The graph was fine; the cache was stale.
import { loadMap } from './m59-map.mjs';
import { attachStepMasks, applyDoorState, resetDoorStates } from './m59-routes.mjs';
import { World } from './m59-world.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

const map = loadMap();
attachStepMasks(map);
const room = map.rooms[27];
const STAND = { row: 23, col: 16 };            // icky-chalice CAVE.stand, where the dispel is cast
const self = { id: 1, flags: 4, row: STAND.row, col: STAND.col,
               x: STAND.col * 64 + 32, y: STAND.row * 64 + 32, predicted: false };
const client = { selfId: 1, self, rsc: new Map(), roomNameRsc: room.nameRsc, roomRsc: room.roomRsc,
                 room: { id: 27, flags: 0, objects: new Map([[1, self]]) } };
const OPEN = new Map([1, 2, 3, 4, 5].map(id => [id, { height: 24 }]));
const tos = list => list.map(e => Number(e.to)).sort((a, b) => a - b);

try {
  console.log('\nshut: the wall is a wall');
  const shutWorld = new World(client, map);
  ok('exits() from the stand square do not offer 2500', !tos(shutWorld.exits()).includes(2500),
     JSON.stringify(tos(shutWorld.exits())));
  ok('and route(2500) fails', shutWorld.route(2500).found === false);

  console.log('\nopen, SAME square, same fine position, cache warm');
  const applied = applyDoorState(map, 27, OPEN);
  ok('the five-sector open variant is baked and applied', applied.changed &&
     applied.state === 'sector1@24+sector2@24+sector3@24+sector4@24+sector5@24', JSON.stringify(applied));
  const openWorld = new World(client, map);   // no `_exitCache = null`: the warm shared cache is the point
  ok('exits() now offer 2500', tos(openWorld.exits()).includes(2500), JSON.stringify(tos(openWorld.exits())));
  const r = openWorld.route(2500);
  ok('and route(2500) is the single west hop, not 27>5>27>2500',
     r.found && r.hops.length === 1 && r.hops[0].to === 2500,
     JSON.stringify(r.found ? r.hops.map(h => h.to) : r.reason));

  console.log('\nshut again: the open answer must not outlive the wall either');
  applyDoorState(map, 27, new Map());
  const againWorld = new World(client, map);
  ok('exits() stop offering 2500', !tos(againWorld.exits()).includes(2500));
} finally {
  resetDoorStates();
}

console.log(`\nillusion exit cache: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
