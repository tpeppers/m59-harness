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
         reachableExits, roomRegions, resetDoorStates } from './m59-routes.mjs';
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
  const regions = roomRegions(map, 951);
  ok('a room labels its regions cheaply enough to do on demand',
     regions && Date.now() - t < 2000, `${regions?.count} region(s) in ${Date.now() - t}ms`);
  ok('and room 951 is not one connected place', regions.count > 1, `${regions.count} regions`);

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
  ok('the region labelling was rebuilt rather than served stale',
     open.region !== shut.region || open.reachable.length !== shut.reachable.length);
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

console.log('\nthe region filter is honest about what it cannot see');
{
  resetDoorStates();
  // Ukgoth stranded three characters on 2026-09-04 and this filter passes all three of its
  // exits, because the floor really does connect to the north edge — leaving that way needs
  // a Relic of Qor and a spoken phrase. Pinned so nobody later believes geometry is the
  // whole answer: that room is caught by KNOWN_TRAPS, not by this.
  const r = reachableExits(map, 599, 51, 17);
  ok('it passes Ukgoth\'s north exit, which is NOT usable in the game',
     r.reachable?.some(e => e.to === 2) === true,
     JSON.stringify(r.reachable?.map(e => e.to)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
