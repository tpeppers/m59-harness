#!/usr/bin/env node
// THE GUARD FOR m59-safelegs.mjs — offline, no socket, no keeper, no broker.
//
//   node tools/m59-safelegs-test.mjs
//
// Pins the pure leg planner on synthetic rooms (every leg bounded, walls preferred away from a
// threat, the honest refusals), the room switch, and — against the baked map when this checkout
// has one — Ukgoth itself: a chain exists both ways, no leg ends on the rim, and the planning
// that used to block a keeper's event loop for seconds now fits the bound the executor needs.
// Skips the map half LOUDLY rather than passing when there is no bake.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSafeLegs, legFlood, floodPath, exposure, safeLegsFor, legWalls, trackCorridor,
         SAFE_LEG_ROOMS, SAFE_LEG_DEFAULTS } from './m59-safelegs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failed = 0, passed = 0;
const ok = (label, cond, detail = '') => {
  if (cond) passed++; else failed++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
};

// A room described by a picture: '.' floor, '#' rock. 1-based (row, col). Steps are the eight
// neighbours onto floor, which is all `legFlood` asks of a geometry.
function room(picture) {
  const lines = picture.trim().split('\n').map(l => l.trim());
  const rows = lines.length, cols = lines[0].length;
  const floor = (r, c) => r >= 1 && c >= 1 && r <= rows && c <= cols && lines[r - 1][c - 1] !== '#';
  return {
    rows, cols, hasStepMask: true, collisionReady: true,
    inBounds: (r, c) => r >= 1 && c >= 1 && r <= rows && c <= cols,
    walkable: floor,
    neighbors(r, c) {
      const out = [];
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++)
        if ((dr || dc) && floor(r + dr, c + dc)) out.push({ row: r + dr, col: c + dc });
      return out;
    },
  };
}

console.log('--- a room the exit is one leg away in needs no wall ---');
{
  const g = room(`
    ..........
    ..........`);
  const p = planSafeLegs(g, { row: 1, col: 1 }, { row: 1, col: 9 }, { walls: [] });
  ok('found', p.found, p.reason);
  ok('and the only leg is the exit\'s', p.legs?.length === 1 && p.legs[0].kind === 'exit',
     JSON.stringify(p.legs));
}

console.log('\n--- a long corridor is walked as legs no longer than maxLeg, each ending on a wall ---');
{
  const g = room(`
    ........................................
    ........................................`);
  const walls = [8, 16, 24, 32].map(c => ({ row: 2, col: c }));
  const p = planSafeLegs(g, { row: 1, col: 1 }, { row: 1, col: 40 }, { walls, maxLeg: 10 });
  ok('found', p.found, p.reason);
  ok('every leg is within maxLeg', p.legs?.every(l => l.steps <= 10), JSON.stringify(p.legs));
  ok('every leg but the last ends on a wall',
     p.legs?.slice(0, -1).every(l => l.kind === 'wall' && walls.some(w => w.row === l.row && w.col === l.col)));
  ok('the last leg is the exit\'s', p.legs?.at(-1)?.kind === 'exit');
  ok('the chain is not much longer than the road', p.steps <= p.direct_steps + 4,
     `${p.steps} vs ${p.direct_steps}`);
}

console.log('\n--- a fleet-mate on a wall ahead does not break a convoy\'s chain ---');
{
  const g = room(`
    ........................................`);
  // r1c16 is where the character in front is standing; r1c15 beside it is free.
  const walls = [8, 15, 16, 24, 32].map(c => ({ row: 1, col: c }));
  const occupied = new Set(['1,16']);
  const from8 = planSafeLegs(g, { row: 1, col: 8 }, { row: 1, col: 40 }, { walls, maxLeg: 10, occupied });
  ok('still a chain when the next wall is held', from8.found, from8.reason);
  ok('the held wall may be a later stop, never the first', from8.found && !(from8.legs[0].row === 1 && from8.legs[0].col === 16),
     JSON.stringify(from8.legs));
  const from1 = planSafeLegs(g, { row: 1, col: 1 }, { row: 1, col: 40 }, { walls, maxLeg: 10, occupied });
  ok('and a held wall further on stays in the chain', from1.found && from1.legs.some(l => l.col === 16 || l.col === 15),
     JSON.stringify(from1.legs));
}

console.log('\n--- a corridor keeps the legs on walked ground ---');
{
  const g = room(`
    ..............................
    ..............................
    ..............................
    ..............................
    ..............................`);
  // Two routes to the far side: along row 1 (walked) and along row 5 (never walked). Walls on both.
  const walls = [{ row: 1, col: 10 }, { row: 1, col: 20 }, { row: 5, col: 9 }, { row: 5, col: 18 }];
  const track = [{ x: 64 * 0 + 32, y: 32 }, { x: 64 * 29 + 32, y: 32 }];   // row 1, cols 1..30
  const corridor = trackCorridor(track, { radius: 1, rows: 5, cols: 30 });
  const p = planSafeLegs(g, { row: 1, col: 1 }, { row: 1, col: 30 }, { walls, maxLeg: 11, corridor });
  ok('found inside the corridor', p.found, p.reason);
  ok('and every stop is on the walked band', p.legs?.every(l => l.row <= 2), JSON.stringify(p.legs));
  ok('the band covers the track and its radius, no more', corridor.has('1,15') && corridor.has('2,15') && !corridor.has('3,15'));
}

console.log('\n--- a gap no leg can bridge is refused, never walked blind ---');
{
  const g = room(`
    ........................................`);
  const p = planSafeLegs(g, { row: 1, col: 1 }, { row: 1, col: 40 }, { walls: [{ row: 1, col: 5 }], maxLeg: 10 });
  ok('no chain', !p.found && p.reason === 'no_chain', p.reason);
}

console.log('\n--- a wall beside a troll loses to a wall away from it ---');
{
  const g = room(`
    ....................
    ....................
    ....................
    ....................
    ....................
    ....................
    ....................
    ....................
    ....................
    ....................
    ....................`);
  const walls = [{ row: 2, col: 10 }, { row: 10, col: 10 }];
  const quiet = planSafeLegs(g, { row: 6, col: 1 }, { row: 6, col: 20 }, { walls, maxLeg: 12 });
  const troll = planSafeLegs(g, { row: 6, col: 1 }, { row: 6, col: 20 },
                             { walls, maxLeg: 12, threats: [{ row: 1, col: 11 }] });
  ok('both found', quiet.found && troll.found);
  ok('with a threat on the north wall, the chain goes by the south one',
     troll.legs.some(l => l.row === 10 && l.col === 10) && !troll.legs.some(l => l.row === 2 && l.col === 10),
     JSON.stringify(troll.legs));
  ok('and exposure is counted on the path, not the stop',
     exposure([{ row: 1, col: 9 }, { row: 9, col: 9 }], [{ row: 1, col: 10 }], 4) === 1);
}

console.log('\n--- a chain much longer than the road is refused as a detour ---');
{
  const g = room(`
    ..............................
    ..............................
    ..............................
    ..............................
    ..............................
    ..............................
    ..............................
    ..............................`);
  // Walls only down the far end of a side street: every leg must dogleg away and back.
  const walls = [{ row: 8, col: 8 }, { row: 8, col: 16 }, { row: 8, col: 24 }];
  const p = planSafeLegs(g, { row: 1, col: 1 }, { row: 1, col: 30 },
                         { walls, maxLeg: 9, maxDetour: 1.0, slack: 0 });
  ok('refused', !p.found && p.reason === 'detour', `${p.reason} ${p.steps}/${p.direct_steps}`);
  ok('and the refusal says how long each was', Number.isFinite(p.steps) && Number.isFinite(p.direct_steps));
}

console.log('\n--- the planning budget is a budget ---');
{
  const g = room(`
    ........................................`);
  const p = planSafeLegs(g, { row: 1, col: 1 }, { row: 1, col: 40 },
                         { walls: [{ row: 1, col: 10 }], deadlineMs: -1 });
  ok('a spent budget answers `deadline`, never a half plan', !p.found && p.reason === 'deadline', p.reason);
}

console.log('\n--- the flood is cached, and its paths are real steps ---');
{
  const g = room(`
    .....
    .#...
    .....`);
  const a = legFlood(g, { row: 2, col: 1 }, 6);
  ok('same answer object on a second ask', legFlood(g, { row: 2, col: 1 }, 6) === a);
  const path = floodPath(a, { row: 2, col: 3 });
  ok('the path steps round the rock, one square at a time',
     path.length === 2 && path.every((s, i) => i === 0 ||
       Math.max(Math.abs(s.row - path[i - 1].row), Math.abs(s.col - path[i - 1].col)) === 1)
     && !path.some(s => s.row === 2 && s.col === 2), JSON.stringify(path));
}

console.log('\n--- which rooms ---');
ok('Ukgoth is on by default', safeLegsFor(599, null, {}) && SAFE_LEG_ROOMS.includes(599));
ok('and nothing else is', !safeLegsFor(598, null, {}) && !safeLegsFor(2, null, {}));
ok('a character can switch it off', !safeLegsFor(599, false, {}) && !safeLegsFor(599, { off: true }, {}));
ok('a policy list replaces the default', safeLegsFor(578, { rooms: [578] }, {}) && !safeLegsFor(599, { rooms: [578] }, {}));
ok('M59_SAFE_LEGS=0 turns it off process-wide', !safeLegsFor(599, null, { M59_SAFE_LEGS: '0' }));
ok('M59_SAFE_LEG_ROOMS replaces the default list',
   safeLegsFor(544, null, { M59_SAFE_LEG_ROOMS: '544,599' }) && !safeLegsFor(599, null, { M59_SAFE_LEG_ROOMS: '544' }));
ok('the default leg is short enough to be one troll cycle of exposure', SAFE_LEG_DEFAULTS.maxLeg <= 16);

// ------------------------------------------------------------------ the real room
const MAP = join(HERE, '..', 'substrate', 'm59-map.json');
if (!existsSync(MAP)) {
  console.log('\n--- Ukgoth on the baked map: SKIPPED — no substrate/m59-map.json in this checkout ---');
} else {
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const { attachStepMasks } = await import('./m59-routes.mjs');
  const { sheltersAlong } = await import('./m59-safespots.mjs');
  const world = JSON.parse(readFileSync(MAP, 'utf8'));
  const att = attachStepMasks(world);
  const geo = sharedRoomGeometry(world.rooms['599']);
  if (!att?.ok || !geo?.hasStepMask) {
    console.log(`\n--- Ukgoth on the baked map: SKIPPED — no current step masks (${att?.why ?? 'unknown'}) ---`);
  } else {
    console.log('\n--- Ukgoth (599) on the baked map ---');
    const walls = legWalls(geo);
    ok('it has walls to chain', walls.length > 50, `${walls.length}`);
    ok('no stop is on the rim, which would eject the body through StandardLeaveDir',
       walls.every(w => w.row > 1 && w.col > 1 && w.row < geo.rows && w.col < geo.cols));
    const cases = [['from 598 to the Castle Victoria door', { row: 5, col: 59 }, { row: 2, col: 26 }],
                   ['from 2 to the Cragged Mountains door', { row: 3, col: 27 }, { row: 1, col: 66 }]];
    for (const [label, from, to] of cases) {
      const cold = planSafeLegs(geo, from, to, { deadlineMs: 5000 });
      ok(`${label}: a chain`, cold.found, cold.reason);
      ok(`${label}: every leg within maxLeg`, cold.legs?.every(l => l.steps <= SAFE_LEG_DEFAULTS.maxLeg));
      ok(`${label}: not much longer than the road`,
         cold.steps <= cold.direct_steps * SAFE_LEG_DEFAULTS.maxDetour + SAFE_LEG_DEFAULTS.slack,
         `${cold.steps} vs ${cold.direct_steps}`);
      const warm = planSafeLegs(geo, from, to);
      ok(`${label}: a re-plan from a wall fits the 150ms budget warm`, warm.found && warm.ms < 150, `${warm.ms}ms`);
    }
    // THE STALL THIS CHANGE WAS FOUND BY. sheltersAlong over a whole Ukgoth crossing measured
    // 868ms offline and 1.6-5.2s on a live keeper before the room's walls and the return set
    // were computed once; the bound here is the 250ms the executor promises.
    const path = geo.path(5, 59, 2, 26);
    if (path?.found) {
      sheltersAlong(geo, path.steps, { within: 6 });        // warm, as a keeper in the room is
      const t = performance.now();
      sheltersAlong(geo, path.steps, { within: 6 });
      const ms = performance.now() - t;
      ok('sheltersAlong over the whole crossing stays under 250ms', ms < 250, `${ms.toFixed(1)}ms for ${path.steps.length} steps`);
    }
  }
}

// THE OTHER STALL: `threatsHere()` built a whole tactical view — an A* approach for every
// object in the room — to read four fields off each. It must use the object list.
console.log('\n--- threatsHere reads the object list, never the tactical view ---');
{
  const { Session } = await import('./m59-game.mjs');
  const fake = {
    world: { objects: () => [{ name: 'troll', row: 3, col: 4, can: ['attack'], x: 1, y: 2 },
                             { name: 'Bob', is_player: true, row: 1, col: 1, can: ['attack'] }] },
    view() { throw new Error('view() was called'); },
  };
  let got = null, err = null;
  try { got = Session.prototype.threatsHere.call(fake); } catch (e) { err = e.message; }
  ok('no view was built', !err, err ?? '');
  ok('and the threats are the attackable non-players', got?.length === 1 && got[0].name === 'troll'
     && got[0].row === 3 && got[0].col === 4, JSON.stringify(got));
  const passed = { objects: [{ name: 'orc', row: 9, col: 9, can: ['attack'] }] };
  ok('a caller\'s own view is still honoured', Session.prototype.threatsHere.call(fake, passed)?.[0]?.name === 'orc');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
