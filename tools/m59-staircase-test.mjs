#!/usr/bin/env node
// DOES THE STAIRCASE DETECTOR EVER CLIMB SOMETHING THE MOVER WOULD NOT?
//
//   node tools/m59-staircase-test.mjs
//
// Offline. No map, no bake, no broker, no socket — every lattice below is built here, so this
// says the same thing on a fresh clone as on the machine that runs the fleet.
//
// WHAT IT PINS. The tool's entire value is being TRUE about ground the body will actually
// cross, because its output is an instruction to walk somewhere. Three ways it could lie, and
// two of them it has already tried:
//
//   * CLIMB A CLIFF. The mover's one vertical rule caps a rise at MAX_STEP_HEIGHT and leaves
//     descent free. A flood that treats the rule as symmetric invents a way up every ledge in
//     the game.
//   * WALK THROUGH A WALL. The first version knew only about floors and produced an
//     eleven-tread chain in room 579 of which the mover refused SIX with `geometry_blocked`.
//     A chain the body cannot walk is worse than no chain, because it reads as an answer.
//   * START AT THE TOP. Seeding every fine sample inside a reachable SQUARE hands the flood
//     the summit of any split square for free — `r40c33` spans 3520 to 10880 — and it then
//     reports a staircase whose first step is the destination. It did exactly that, producing
//     a chain of zero treads.
import { sampleFloor, floodClimb, floodBasin, chainTo, treadsOf, verifyTreads }
  from './m59-staircase.mjs';
import { MAX_STEP_HEIGHT } from './m59-roo.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};

/** A hand-built lattice: `heights` is a row-major array of floors, NaN for solid. */
const lattice = (heights, w) => ({
  floor: Float64Array.from(heights), w, h: heights.length / w, step: 256,
  xOf: ix => ix * 256 + 128, yOf: iy => iy * 256 + 128,
});
const X = NaN;

console.log('\nthe one vertical rule: up is capped, down is free');
{
  // A flat run, then a tread inside the cap, then a cliff far past it.
  const g = lattice([0, 0, MAX_STEP_HEIGHT, MAX_STEP_HEIGHT + 10000], 4);
  const { seen } = floodClimb(g, [0]);
  ok('a flat neighbour is reached', seen[1] !== -1);
  ok('a rise EXACTLY at the cap is still a step', seen[2] !== -1,
     'the cap is inclusive — a tread of exactly MAX_STEP_HEIGHT is legal');
  ok('a rise past the cap is refused', seen[3] === -1);

  // The same ground walked downhill: every one of those is now a descent and all are legal.
  const down = floodClimb(g, [3]);
  ok('and from the TOP, every one of them is reachable — descent is unbounded',
     down.seen[0] !== -1 && down.seen[1] !== -1 && down.seen[2] !== -1,
     'a symmetric flood would refuse these, and invent a way up every ledge in the game');
}

console.log('\na staircase is a chain of legal treads, and the chain is what gets reported');
{
  // The Ancient Place's real shape: 4832 -> 5152 -> 5504 -> 5856 -> 6208, +320 then +352.
  const g = lattice([4832, 5152, 5504, 5856, 6208], 5);
  const { seen } = floodClimb(g, [0]);
  ok('every tread is reached', seen[4] !== -1);
  const chain = chainTo(g, seen, 4);
  ok('the chain runs from the boarding point to the top', chain.length === 5 &&
     chain[0].floor === 4832 && chain[4].floor === 6208);
  const treads = treadsOf(chain);
  ok('four treads, because four of the five steps gain height', treads.length === 4);
  ok('and the rises are the real ones', treads.map(t => t.rise).join(',') === '320,352,352,352');
  ok('the BOARDING point is the bottom, not the top', treads[0].from.floor === 4832,
     'a staircase is invisible unless you board it at the bottom');
}

console.log('\na wall is not a height, and the flood must be told about it');
{
  // Flat ground the whole way, so heights alone would walk straight across.
  const g = lattice([0, 0, 0, 0], 4);
  const open = floodClimb(g, [0]);
  ok('on heights alone the far side is reached', open.seen[3] !== -1);
  // `canStep` is the mover's own trace in production. Here it refuses one edge.
  const blocked = floodClimb(g, [0], { canStep: (i, j) => !(i === 1 && j === 2) });
  ok('with the mover refusing one edge, the far side is NOT reached', blocked.seen[3] === -1,
     'the first version knew only floors and reported a chain the mover refused six times');
  ok('and the near side still is', blocked.seen[1] !== -1);
}

console.log('\nverifyTreads reports a refusal rather than swallowing it');
{
  const g = lattice([0, 352], 2);
  const chain = chainTo(g, floodClimb(g, [0]).seen, 1);
  const treads = treadsOf(chain);
  const fakeGeo = { traceFineMoveClient: () => ({ arrived: false, blocked: true, reason: 'geometry_blocked' }) };
  const checked = verifyTreads(fakeGeo, treads);
  ok('a tread the trace refuses is marked unwalked', checked[0].walked === false);
  ok('and it carries the reason the mover gave', checked[0].reason === 'geometry_blocked');
  const goodGeo = { traceFineMoveClient: () => ({ arrived: true, blocked: false }) };
  ok('a tread it agrees to is marked walked', verifyTreads(goodGeo, treads)[0].walked === true);
  const throwGeo = { traceFineMoveClient: () => { throw new Error('no geometry'); } };
  ok('and a trace that THROWS is a refusal, not a pass',
     verifyTreads(throwGeo, treads)[0].walked === false);
}

console.log('\nthe basin answers "where would you have to be standing?"');
{
  // A shelf at 10000 with a ramp down to 0. Nothing can climb the cliff at index 1.
  const g = lattice([0, 10000, 10000], 3);
  const up = floodClimb(g, [0]);
  ok('the shelf cannot be climbed to', up.seen[2] === -1);
  // Flooding BACKWARDS from the shelf: descent is free, so the shelf can reach the floor,
  // which means the floor is NOT in the basin — the basin is what can reach the SHELF.
  const basin = floodBasin(g, 2);
  ok('the shelf itself is in its own basin', basin.seen[2] === -2);
  ok('its neighbour on the shelf is in the basin', basin.seen[1] !== -1);
  ok('but the ground 10000 below is NOT — you cannot climb up to it', basin.seen[0] === -1,
     'if this passed, the basin would claim every floor in the room can reach every ledge');
}

console.log('\nsampleFloor refuses a point rather than guessing at it');
{
  // step 512 over a 2x2-square room gives a 4x4 lattice sampled at x,y = 256, 768, 1280, 1792.
  const geo = {
    _occupiable: (x, y) => x < 512,                       // only the first COLUMN is real
    floorBaseAtClient: (x, y) => (y < 512 ? 100 : null),  // and only the first ROW has a floor
  };
  const g = sampleFloor(geo, 2, 2, { step: 512 });
  ok('a point that is not occupiable is left unsampled', Number.isNaN(g.floor[1]));
  ok('a point with no readable floor is left unsampled too',
     [...g.floor].filter(v => !Number.isNaN(v)).length === 1);
  ok('and the one real point carries its height', g.floor[0] === 100);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
