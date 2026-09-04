#!/usr/bin/env node
// PICKING THE RIGHT DOOR STATE AT RUNTIME — offline, no server, no .roo files.
//
//   node tools/m59-doorstate-test.mjs
//
// `m59-doorbake-test.mjs` pins the BAKE: that overriding a sector and re-deriving the walls
// opens the Duke's Feast Hall. This pins the half that runs while the fleet is playing —
// taking `BP_SECTOR_MOVE`'s word for where a door is and moving the model to match.
//
// Everything here reads `substrate/m59-map.json` and `substrate/m59-routes.json`, which is
// exactly what a broker has. If it needed the game's source tree it would not be testing
// the thing that runs.
//
// WHAT IT PINS, and every line was measured on 2026-09-04:
//
//   * the state the server actually reports for an open feast hall — `{3:356, 4:419}`,
//     both sectors at once — takes room 951 from a 38-square island to 682 squares;
//
//   * AND THE MOVER AGREES. The mask alone moves the router and leaves
//     `stepAllowedByCollision` refusing the door, which is a plan the mover will not walk.
//     This is the assertion that would have caught it: a mask swap without the sector
//     heights passes the region check and fails this one;
//
//   * a state with no baked mask is REFUSED, not approximated. Single-sector masks do not
//     compose — a door that rises removes steps — and room 951's open state is provably
//     neither of its halves;
//
//   * shutting the door puts the room back exactly as shipped, byte for byte;
//
//   * a sector at its shipped height is not part of the state, so an ordinary closed door
//     reads as the baseline rather than as something unbaked.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attachStepMasks, applyDoorState, doorVariants, doorStateKey,
         reachableExits, reachableFrom, anchorReach, activeRoutes,
         assertDoorStates, resetDoorStates } from './m59-routes.mjs';
import { sharedRoomGeometry } from './m59-roo.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
};

const HERE = (p) => fileURLToPath(new URL(p, import.meta.url));
const map = JSON.parse(readFileSync(HERE('../substrate/m59-map.json'), 'utf8'));
const attached = attachStepMasks(map);

if (!attached.attached) {
  console.log('\nSKIPPED — no step masks attached: ' + (attached.why ?? 'unknown'));
  console.log('Run node tools/m59-routebake.mjs, then node tools/m59-doorbake.mjs --write.');
  process.exit(0);
}

/** Every square the mover can reach from one square, by its own step predicate. */
const region = (g, r0, c0) => {
  const seen = new Set([`${r0},${c0}`]);
  const queue = [[r0, c0]];
  for (let i = 0; i < queue.length; i++) {
    const [r, c] = queue[i];
    for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
      const nr = r + dr, nc = c + dc, key = `${nr},${nc}`;
      if (seen.has(key)) continue;
      let lands = false;
      try { lands = g.moverStepLands(r, c, nr, nc); } catch { lands = false; }
      if (!lands) continue;
      seen.add(key); queue.push([nr, nc]);
    }
  }
  return seen;
};

console.log('\nthe key names a state, and only one name per state');
{
  ok('sorted by sector, so the order it arrived in does not matter',
     doorStateKey([{ id: 4, kod: 419 }, { id: 3, kod: 356 }]) === 'sector3@356+sector4@419',
     doorStateKey([{ id: 4, kod: 419 }, { id: 3, kod: 356 }]));
  ok('a single sector keeps the plain form',
     doorStateKey([{ id: 1, kod: 340 }]) === 'sector1@340');
}

console.log('\nthe Duke\'s feast door, as the server reports it');
{
  resetDoorStates();
  const variants = doorVariants(951);
  ok('room 951 has baked door states', !!variants, Object.keys(variants ?? {}).join(' '));
  // duke2.kod line 131: opening sends FEAST_DOOR_CLOSED to 356 and FEAST_DOOR_OPEN to 419,
  // in one branch. Line 113 is the other half of the if/else and is what the .roo ships.
  ok('and among them the pair the kod actually sends together',
     !!variants?.['sector3@356+sector4@419']);

  const g = sharedRoomGeometry(map.rooms['951']);
  const shipped = region(g, 9, 9).size;
  ok('as shipped, the feast exit is stranded', shipped < 100, `${shipped} squares`);
  ok('and the mover refuses the door step',
     g.stepAllowedByCollision(9, 13, 10, 14) === false);

  const opened = applyDoorState(map, 951, new Map([[3, { height: 356 }], [4, { height: 419 }]]));
  ok('the server saying so moves the model', opened.changed === true,
     JSON.stringify(opened));
  ok('to the state the kod names', opened.state === 'sector3@356+sector4@419');
  const open = region(g, 9, 9).size;
  ok('and the hall joins the keep', open > shipped * 10, `${shipped} -> ${open} squares`);
  // THE ASSERTION THAT SEPARATES THIS FROM A MASK SWAP. `moverStepLands` consults the mask
  // and would pass on a swap alone; `stepAllowedByCollision` goes to the walls, which only
  // move when the sector heights do. Router and mover have to change their minds together.
  ok('AND THE MOVER AGREES, which a mask swap alone would not deliver',
     g.stepAllowedByCollision(9, 13, 10, 14) === true);

  // Idempotent: the packet stream from an animating door must not thrash the geometry.
  const again = applyDoorState(map, 951, new Map([[3, { height: 356 }], [4, { height: 419 }]]));
  ok('saying it twice changes nothing the second time', again.changed === false,
     JSON.stringify(again));

  const shut = applyDoorState(map, 951, new Map([[3, { height: 420 }], [4, { height: 356 }]]));
  ok('closing it returns to the shipped state', shut.state === null, JSON.stringify(shut));
  ok('exactly as shipped, square for square', region(g, 9, 9).size === shipped,
     `${region(g, 9, 9).size} vs ${shipped}`);
  ok('and the mover refuses the door again',
     g.stepAllowedByCollision(9, 13, 10, 14) === false);
}

console.log('\na state nobody baked is refused rather than approximated');
{
  resetDoorStates();
  const g = sharedRoomGeometry(map.rooms['951']);
  const before = region(g, 9, 9).size;
  const out = applyDoorState(map, 951, new Map([[3, { height: 999 }]]));
  ok('an unheard-of height does not move anything', out.changed === false, JSON.stringify(out));
  ok('and it says which state it could not serve', out.unbaked === 'sector3@999');
  ok('the room is left on the shipped state, which is what it did before any of this',
     region(g, 9, 9).size === before);

  // WHY REFUSING IS THE ONLY HONEST ANSWER. If the two halves could be composed, the open
  // state would equal one of them, or their union. It is provably its own thing.
  const variants = doorVariants(951);
  const open = variants['sector3@356+sector4@419'].mask;
  ok('the pair state is not either half — so masks may not be OR-ed together',
     open !== variants['sector3@356'].mask && open !== variants['sector4@419'].mask);
}

console.log('\na door at its shipped height is not part of the state');
{
  resetDoorStates();
  // Room 951 ships shut. Reporting exactly that must read as the baseline, not as an
  // unbaked `sector3@420+sector4@356` — the bake deliberately does not store the baseline
  // under a second name, and a lookup that expected one would refuse every closed door.
  const out = applyDoorState(map, 951, new Map([[3, { height: 420 }], [4, { height: 356 }]]));
  ok('reporting the shipped heights is the baseline, not an unbaked state',
     out.state === null && !out.unbaked, JSON.stringify(out));
}

console.log('\none sector id, several collision records');
{
  // Room 532's door is TWO sector records carrying the same id. A runtime that patched the
  // first would move half a door and then enforce the half it had moved.
  const variants = doorVariants(532);
  const only = variants && Object.values(variants)[0];
  ok('room 532\'s door names more than one record', (only?.sectors?.length ?? 0) > 1,
     JSON.stringify(only?.sectors));
  ok('and they are all the same sector id',
     new Set((only?.sectors ?? []).map(s => s.id)).size === 1);
}

console.log('\nUkgoth, which this fleet walks through daily');
{
  resetDoorStates();
  const variants = doorVariants(599);
  ok('has a baked open state', !!variants?.['sector1@340'], Object.keys(variants ?? {}).join(' '));
  const g = sharedRoomGeometry(map.rooms['599']);
  const out = applyDoorState(map, 599, new Map([[1, { height: 340 }]]));
  ok('and the server can open it', out.changed === true && out.state === 'sector1@340',
     JSON.stringify(out));
  ok('the mask that arrived is the size of the room',
     g.hasStepMask === true);
}

console.log('\nan exit list without a position is a list of doors in the building');
{
  resetDoorStates();
  const t = Date.now();
  const reach = reachableFrom(map, 951, 9, 9);
  ok('a room answers reachability cheaply enough to do on demand',
     reach && Date.now() - t < 2000, `${reach?.size} square(s) in ${Date.now() - t}ms`);
  ok('and room 951 is not one connected place — the feast exit sees a fraction of it',
     reach.size < 100, `${reach.size} squares`);

  // THE POINT, ON THE ROOM THIS WAS BUILT FOR. Standing at the feast exit with the door
  // shut, half the keep's doors are on the far side of a wall. The room's exit list says
  // otherwise, because an exit belongs to the room and not to where you are standing.
  const shut = reachableExits(map, 951, 9, 9);
  ok('with the feast door shut, some of the keep\'s exits are unreachable',
     shut.unreachable.length > 0,
     `${shut.reachable.length} reachable, ${shut.unreachable.length} not`);
  ok('and the ones you cannot reach are named',
     shut.unreachable.some(e => e.to === 950) && shut.unreachable.some(e => e.to === 952),
     JSON.stringify(shut.unreachable.map(e => e.to)));

  applyDoorState(map, 951, new Map([[3, { height: 356 }], [4, { height: 419 }]]));
  const open = reachableExits(map, 951, 9, 9);
  ok('opening the door makes every exit reachable from the same square',
     open.unreachable.length === 0, JSON.stringify(open.unreachable));
  ok('which is more exits than were reachable before',
     open.reachable.length > shut.reachable.length,
     `${shut.reachable.length} -> ${open.reachable.length}`);

  // A door that moves changes the regions, so a labelling taken before it opened is a map
  // of a room that no longer exists. The cache has to go with the door.
  ok('the reachability was recomputed rather than served stale',
     open.reachable.length !== shut.reachable.length);
}

console.log('\nno opinion is not the same as no exits');
{
  resetDoorStates();
  // NARROWING TO NOTHING ON A MISSING ANSWER WOULD STRAND A CHARACTER at a boundary it
  // could have crossed, so every "I do not know" has to be null and not an empty list.
  const offMap = reachableExits(map, 951, 9999, 9999);
  ok('a position off the map yields no opinion', offMap.reachable === null, JSON.stringify(offMap));
  ok('and says why', /not a standable square/.test(offMap.why ?? ''), offMap.why);
  const noRoom = reachableExits(map, 999999, 1, 1);
  ok('so does a room we do not have', noRoom.reachable === null, JSON.stringify(noRoom));
}

console.log('\nthe ROUTER has to change its mind too, or none of this reaches the fleet');
{
  resetDoorStates();
  const table = activeRoutes();
  // A body anchor (the 950 doorway at r40c15) and the feast doorway. `transitOk` in
  // m59-world.mjs gates every hop through a room on exactly this call, so if it says no
  // the router refuses 951 -> 953 and the door being open at runtime buys nothing at all.
  const body = { row: 40, col: 15 }, feast = { row: 9, col: 9 };

  ok('as shipped, the bake says the feast door is not reachable from the keep',
     anchorReach(table, 951, body, feast) === false);
  // AND THE BAKE CANNOT LEARN. Its reach map was computed with the door shut: the feast
  // anchors are region 3, every body anchor is region 0, and no entry joins them in either
  // direction. `sameRegion` — the documented fallback — agrees for the same stale reason.
  const baked = table.rooms['951'];
  ok('because the baked reach map has no entry joining them, in either direction',
     !baked.reach['40,15>9,9'] && !baked.reach['9,9>40,15']);

  applyDoorState(map, 951, new Map([[3, { height: 356 }], [4, { height: 419 }]]));
  ok('with the door open the router is told the truth instead',
     anchorReach(table, 951, body, feast) === true);
  ok('in both directions, since the two are now one region',
     anchorReach(table, 951, feast, body) === true);

  applyDoorState(map, 951, new Map([[3, { height: 420 }], [4, { height: 356 }]]));
  ok('and shutting it returns the baked answer rather than keeping the live one',
     anchorReach(table, 951, body, feast) === false);

  // A ROOM WHOSE DOORS HAVE NOT MOVED MUST BE UNTOUCHED BY ANY OF THIS. The live path is
  // reached only through a non-baseline door state; everything else reads the bake exactly
  // as it did before, which is what makes this safe to ship to a running fleet.
  resetDoorStates();
  ok('a room with no door state still reads the baked table',
     anchorReach(table, 599, { row: 71, col: 2 }, { row: 1, col: 66 }) ===
     !!table.rooms['599'].reach['71,2>1,66']);
}

console.log('\nreachability is DIRECTED, and Ukgoth is the room that proves it');
{
  resetDoorStates();
  // THE UKGOTH JUMP. The crossing to Castle Victoria is made by a jump; miss it and you
  // land in the gutters below, and there is no way back up without a Relic of Qor. So the
  // north exit is perfectly real from ABOVE and unreachable from BELOW, and a model that
  // cannot express that has only two options, both wrong: strand characters in front of a
  // door they can never take, or ban a route the fleet uses every day.
  //
  // An undirected component labelling cannot express it, because a fall-jump is one-way and
  // a component welds the top of the drop to the bottom. Measured from the gutter at
  // r51c17: undirected said all three exits were reachable; directed says two.
  const below = reachableExits(map, 599, 51, 17);
  ok('from the gutter, the exit to Castle Victoria is NOT offered',
     below.reachable.every(e => e.to !== 2), JSON.stringify(below.reachable.map(e => e.to)));
  ok('and it is named as unreachable rather than quietly omitted',
     below.unreachable.some(e => e.to === 2), JSON.stringify(below.unreachable.map(e => e.to)));
  // THIS IS THE LINE THAT SENDS IT HOME. Two real ways out, so a router asked from down
  // there routes through one of them and takes the eight-map walk round instead of aiming
  // at the jump for ever.
  ok('while the two ways out that DO exist are offered',
     below.reachable.some(e => e.to === 589) && below.reachable.some(e => e.to === 598),
     JSON.stringify(below.reachable.map(e => e.to)));

  const north = activeRoutes().rooms['599'].anchors.find(a => Number(a.to) === 2);
  ok('the drop really is one-way: from the north anchor you can reach the gutter',
     reachableFrom(map, 599, north.row, north.col).has('51,17'));
  ok('but not back', !reachableFrom(map, 599, 51, 17).has(`${north.row},${north.col}`));
  // And the route the fleet uses every day is untouched — this must not become a ban.
  ok('a character above can still be routed out through the north exit',
     reachableExits(map, 599, north.row, north.col).reachable.some(e => e.to === 2));
}

console.log('\na door the operator knows is open, which the server will never mention');
{
  resetDoorStates();
  const table = activeRoutes();
  const g = sharedRoomGeometry(map.rooms['951']);
  // THE CASE THIS EXISTS FOR. duke2.kod gates the hall on `RID_DUKE4 @IsLocked` and moves
  // the floor only when an actor walks the door square. Unlock it any other way and the
  // hall is open, walkable, and completely silent on the wire — nothing accumulates in
  // plSector_changes, so SendSectorChanges replays nothing and the bake enforces a wall
  // the server would have let us through. 2026-09-04: a courier sat five minutes in the
  // keep while the operator confirmed with the players that the hall was open.
  ok('as shipped the hall is unreachable', region(g, 9, 9).size < 100);

  const applied = assertDoorStates(map, { 951: 'sector3@356+sector4@419' });
  ok('the assertion is accepted', applied[0]?.applied === true, JSON.stringify(applied));
  ok('and it opens the hall', region(g, 9, 9).size > 600, `${region(g, 9, 9).size} squares`);
  ok('the mover agrees', g.stepAllowedByCollision(9, 13, 10, 14) === true);
  ok('and so does the router, which is the half that dispatches a courier',
     anchorReach(table, 951, { row: 40, col: 15 }, { row: 9, col: 9 }) === true);

  // A NAME NOBODY BAKED IS REFUSED AND SAYS WHAT IT HAS. An operator typing a state that
  // does not exist must not get silence — that is how a door nobody opened reads as open.
  resetDoorStates();
  const bad = assertDoorStates(map, { 951: 'sector3@999' });
  ok('an unbaked state name is refused', bad[0]?.applied === false);
  ok('and the refusal lists the states that do exist',
     /no baked state called/.test(bad[0]?.why ?? '') && /sector3@356/.test(bad[0]?.why ?? ''),
     bad[0]?.why);
  ok('a room with no baked doors says so',
     assertDoorStates(map, { 39: 'sector1@100' })[0]?.why === 'this room has no baked door states');

  // IT IS THE WEAKEST CLAIM IN THE SYSTEM. The server saying otherwise must win, because
  // this only ever stood in for the server's silence.
  resetDoorStates();
  assertDoorStates(map, { 951: 'sector3@356+sector4@419' });
  const shut = applyDoorState(map, 951, new Map([[3, { height: 420 }], [4, { height: 356 }]]));
  ok('a real packet from the server replaces the assertion', shut.state === null,
     JSON.stringify(shut));
  ok('and the room is shut again', region(g, 9, 9).size < 100);
}

console.log('\nthe filter answers geometry, which is not everything that shuts a door');
{
  resetDoorStates();
  // WHAT THIS BLOCK USED TO SAY, AND WHY IT WAS WRONG. It asserted that the filter passed
  // Ukgoth's north exit and could not catch it — written while the belief was that leaving
  // northward needed a Relic of Qor outright. It does not: the crossing is a JUMP, real and
  // used daily, and the Relic is only needed to climb back up after MISSING it. Directed
  // reachability expresses that exactly, so the filter does catch it, from below, without
  // banning it from above. The wrong belief had produced a blanket ban on the boundary,
  // which would have sent every trip to Castle Victoria the eight-map way round for ever.
  //
  // The caveat that survives is the general one, and it is still worth a test: this answers
  // where the FLOOR goes. A lock, a spoken word or a quest bit is invisible to it, and for
  // those the answer has to come from somewhere else — KNOWN_TRAPS in m59-fleetscript.mjs,
  // or the operator, as `assertDoorStates` above.
  const below = reachableExits(map, 599, 51, 17);
  ok('geometry alone still answers only about the floor: the hall door in 951 reads shut',
     reachableExits(map, 951, 9, 9).unreachable.length > 0);
  ok('and the operator had to tell us otherwise — no packet ever did',
     assertDoorStates(map, { 951: 'sector3@356+sector4@419' })[0]?.applied === true);
  resetDoorStates();
  ok('while a one-way drop IS geometry, and is now answered as one',
     below.reachable.every(e => e.to !== 2));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
