#!/usr/bin/env node
// WHEN A ROOM HAS TWO SIDES, WHICH DOOR DO YOU TAKE?
//
//   node tools/m59-doorside-test.mjs
//
// Offline. Reads the baked map and the real geometry; opens no socket, starts no broker.
//
// WHY THIS FILE EXISTS. "A room's several ways to the same place are alternatives, not
// different journeys" is a rule in m59-game.mjs and it is true — right up until the
// destination is SPLIT, and then they are different journeys wearing the same name.
//
// Measured on prod 2026-08-27, Castle Victoria into Upstairs Castle Victoria:
//
//     door (19,2) and (19,1)  ->  arrives (28,8)
//     door (17,2) and (17,1)  ->  arrives (23,8)
//
// Four doors, two landing squares, one per disconnected island. `orderExits` ranks by
// reachable-then-nearest, so a character wanting the far side takes the near door, lands on
// the wrong island, and then stands looking at six battered skeletons it cannot path to —
// "the coarse grid found no route beside the target, and the fine grid could not reach one
// either". Six characters at levels 46-57 produced ZERO kills across a whole night in a
// room with prey standing in it.
//
// `arriveCol`/`arriveRow` have been in the map the entire time. `sameRoomIslandBridgePlan`
// was the only thing that ever read them, and it can only be planned from INSIDE the room —
// so a character part-way through the bridge, standing in the via room, fell back to plain
// travel and picked by distance.
//
// What is pinned here is the DATA and the LAW, not the plumbing: that room 39 really is
// split, that its two islands really are served by different doors, and that asking "which
// door lands where" separates them. If someone re-bakes the map and this room stops being
// split, this test should be deleted rather than fixed — but it must not fail quietly.
// ASK THE MAP THE MOVER ENFORCES, NOT THE ONE THE ROUTER GUESSES ON.
//
// The first version of this test loaded the raw map and reported that room 39 was NOT
// split — every landing reached every other, and it very nearly retired a correct fix as
// unnecessary. The difference is `attachStepMasks`: without it `path` runs on the coarse
// grid, and on the coarse grid the two halves of Upstairs Castle Victoria are joined.
// With the masks — which is what the keeper walks on — they are not:
//
//                   landingA  landingB  bots(34,15)  quarry(23,14)
//   landingA(28,8)  yes       NO        yes          NO
//   landingB(23,8)  NO        yes       NO           yes
//
// CLAUDE.md has said this since the routing notes: the router must plan on the map the
// mover enforces. A test that forgets it does not fail — it reports the opposite answer.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedRoomGeometry } from './m59-roo.mjs';
import { loadMap } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAP = join(HERE, '..', 'substrate', 'm59-map.json');

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

if (!existsSync(MAP)) {
  console.log('no substrate/m59-map.json — nothing to check');
  process.exit(0);
}
const map = loadMap();
const masks = attachStepMasks(map);
const rooms = map.rooms || map;
const VIA = 38, SPLIT = 39;

console.log(`step masks: ${masks.attached} room(s)${masks.ok ? '' : ' — ' + (masks.why ?? 'not attached')}`);
// A bake with no masks answers this whole file on the coarse grid, which gives the WRONG
// answer rather than no answer. Say so loudly instead of quietly testing the wrong map.
ok('the routing bake carries step masks, or this test is asking the wrong map',
   masks.attached > 0, 'run node tools/setup.mjs routes');

console.log('the map already knows which door lands where');
{
  const via = rooms[VIA];
  ok('Castle Victoria is in the map', !!via, 'room 38 missing');
  const doors = (via?.goExits || []).filter(e => Number(e.to) === SPLIT && !e.locked);
  ok('and it publishes more than one door into Upstairs Castle Victoria',
     doors.length > 1, `${doors.length} door(s)`);
  ok('every one of them declares where it lands',
     doors.length > 0 && doors.every(d => d.arriveRow != null && d.arriveCol != null));

  const landings = new Set(doors.map(d => `${d.arriveCol},${d.arriveRow}`));
  // THE WHOLE POINT. More doors than landing squares means the doors are not alternatives.
  ok('and they land on FEWER squares than there are doors — so they are not alternatives',
     landings.size > 1 && landings.size < doors.length,
     `${doors.length} doors -> ${landings.size} landing(s): ${[...landings].join(' | ')}`);
}

console.log('\nand those landings really are on different sides');
{
  const to = rooms[SPLIT];
  const geo = to?.roo ? sharedRoomGeometry(to) : null;
  ok('Upstairs Castle Victoria has geometry to ask', !!geo);
  if (geo) {
    const via = rooms[VIA];
    const doors = (via.goExits || []).filter(e => Number(e.to) === SPLIT && !e.locked
                                              && e.arriveRow != null && e.arriveCol != null);
    const onFloor = (row, col) => geo.walkable(row, col)
      ? { row, col } : (geo.nearestWalkable?.(row, col) ?? null);
    const landings = [...new Map(doors.map(d =>
      [`${d.arriveCol},${d.arriveRow}`, onFloor(d.arriveRow, d.arriveCol)])).entries()]
      .filter(([, p]) => p);
    ok('each landing square is standable (or has floor beside it)', landings.length > 1,
       `${landings.length} usable landing(s)`);

    // Two landings that cannot reach each other ARE two islands. This is the fact the
    // whole night turned on, and it is checked rather than assumed.
    let disconnected = null;
    for (let i = 0; i < landings.length && !disconnected; i++)
      for (let j = i + 1; j < landings.length; j++) {
        const [ka, a] = landings[i], [kb, b] = landings[j];
        if (!geo.path(a.row, a.col, b.row, b.col, { fine: true }).found) {
          disconnected = [ka, kb]; break;
        }
      }
    ok('at least two landings cannot walk to each other — the room IS split',
       !!disconnected, disconnected ? '' : 'every landing reaches every other; room not split');
    if (disconnected)
      console.log(`       islands reached by ${disconnected[0]} and ${disconnected[1]}`);
  }
}

console.log('\nso a target on one side selects a strict subset of the doors');
{
  const to = rooms[SPLIT], via = rooms[VIA];
  const geo = to?.roo ? sharedRoomGeometry(to) : null;
  if (!geo) { ok('geometry available', false); }
  else {
    const doors = (via.goExits || []).filter(e => Number(e.to) === SPLIT && !e.locked
                                              && e.arriveRow != null && e.arriveCol != null);
    const onFloor = (row, col) => geo.walkable(row, col)
      ? { row, col } : (geo.nearestWalkable?.(row, col) ?? null);
    // Aim at each landing in turn and ask which doors can reach it. A split room must
    // answer "some of them" at least once, never "all of them" every time.
    let sawStrictSubset = false;
    for (const d of doors) {
      const goal = onFloor(d.arriveRow, d.arriveCol);
      if (!goal) continue;
      const reaching = doors.filter(x => {
        const landing = onFloor(x.arriveRow, x.arriveCol);
        return landing && geo.path(landing.row, landing.col, goal.row, goal.col, { fine: true }).found;
      });
      if (reaching.length && reaching.length < doors.length) sawStrictSubset = true;
    }
    ok('aiming at a side narrows the doors rather than keeping all of them', sawStrictSubset,
       'every target kept every door — the door choice would be a coin flip');
  }
}

console.log('\nand the mover asks the question');
{
  const src = readFileSync(join(HERE, 'm59-game.mjs'), 'utf8');
  ok('doorsLandingNear exists', /function doorsLandingNear\(/.test(src));
  ok('it reads the landing coordinates the map carries',
     /g\.arriveRow == null \|\| g\.arriveCol == null/.test(src));
  ok('travel accepts which side it should arrive on', /arriveNear = null,/.test(src));
  // NO OPINION IS NOT THE SAME AS NO DOORS. A door set that narrowed to nothing would
  // strand a character at a boundary it could otherwise have crossed, so an empty result
  // must fall through to the ordinary ordering rather than refuse the hop.
  ok('and an empty answer crosses anyway rather than refusing the boundary',
     /if \(right\.length\) \{[\s\S]{0,400}?candidates = right;/.test(src) &&
     /no door lands on the wanted side/.test(src));
  ok('the side is remembered across an interrupted bridge',
     /this\.wantSide = \{ room: plan\.fromRoom/.test(readFileSync(join(HERE, 'm59-autopilot.mjs'), 'utf8')));
}

// ---------------------------------------------------------------------------
// LEAVE BY THE DOOR YOU CAME IN BY.
//
// Room 39 above is split and its doors land on two islands. Blackstone Keep (951) is the
// same shape and worse: THREE pairs of doors back to the Courtyard (950), landing at
// r15c44, r15c16 and r14c29 - and no landing can walk to either of the others. Two of the
// three are watch towers, which exist for shooting at people from and are not reachable
// from the main yard at all.
//
// `orderExits` ranks reachable-then-nearest, so the nearest door won, put the character in
// a tower, and it then spent vigor and minutes trying to path out of one before falling back
// to a blink. Operator's report, 2026-09-05.
//
// The fix is not a better ranking. It is remembering: the door square we came IN by is one
// square in the far room that we KNOW connects to where we were, so `doorsLandingNear` -
// which already filters doors by whether their landing can walk to a target - is handed it.
console.log('\nBlackstone Keep: three ways out, and only one is where you came from');
{
  const yard = sharedRoomGeometry(map.rooms[950]);
  const outDoors = (map.rooms[951].goExits || []).filter(e => Number(e.to) === 950);
  const inDoors  = (map.rooms[950].goExits || []).filter(e => Number(e.to) === 951);
  ok('the Keep has six doors back to the Courtyard', outDoors.length === 6, String(outDoors.length));

  const landings = [...new Set(outDoors.map(d => `${d.arriveRow},${d.arriveCol}`))];
  ok('landing on three distinct squares', landings.length === 3, landings.join(' | '));

  // THE PROPERTY THAT MAKES THIS MATTER AT ALL. If the three landings could reach each other
  // the door choice would be cosmetic; they cannot, so it is the whole trip. If a re-bake
  // ever joins them, read this rather than deleting it.
  let joined = 0;
  for (const a of landings) for (const b of landings) {
    if (a === b) continue;
    const [ar, ac] = a.split(',').map(Number), [br, bc] = b.split(',').map(Number);
    if (yard.path(ar, ac, br, bc, { fine: true }).found) joined++;
  }
  ok('and no landing can walk to another - three pockets, not one yard', joined === 0, String(joined));

  // The selection itself: for every way in, exactly the pair that lands back where we were.
  let right = 0;
  const sizes = new Set();
  for (const came of inDoors) {
    const usable = outDoors.filter(o => {
      if (!yard.walkable(o.arriveRow, o.arriveCol)) return false;
      if (o.arriveRow === came.row && o.arriveCol === came.col) return true;
      return yard.path(o.arriveRow, o.arriveCol, came.row, came.col, { fine: true }).found;
    });
    sizes.add(usable.length);
    if (usable.length === 2) right++;
  }
  ok('every way in narrows six ways out to the two that lead back',
     right === inDoors.length, `${right} of ${inDoors.length}, sizes ${[...sizes].join(',')}`);
  // Two rather than one because the doors come in pairs on adjacent squares: one boundary,
  // two crossing squares. Either is correct. What matters is that the four belonging to the
  // towers are gone.
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
