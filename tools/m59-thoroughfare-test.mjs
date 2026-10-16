#!/usr/bin/env node
// A THOROUGHFARE IS NOT A SEAT — offline, no socket, no roster, no broker.
//
// Pins m59-thoroughfare.mjs against a synthetic grid and against East Jasper's real stair
// tunnel (350, r51c27..c34), where Scooter idled at r51c28 and Fozzie stood behind him for
// forty-five minutes on 2026-10-16: which squares are chokes, that the idle body walks out the
// open end and away from the player behind it, that resting no longer picks the tunnel as its
// safe wall, and that the keeper's idle branch asks before it sits still.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isChokeSquare, thoroughfareYield } from './m59-thoroughfare.mjs';
import { nearestSafeSpot } from './m59-safespots.mjs';
import { sharedRoomGeometry } from './m59-roo.mjs';
import { loadMap } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0, skipped = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};
const skip = (name, why) => { skipped++; console.log('  --   ' + name + ' — ' + why); };

// A grid geometry: '.' floor, '#' wall; a step lands when both ends are floor and, on a
// diagonal, both orthogonal corners are too (no corner cutting).
function gridGeo(rows) {
  const at = (r, c) => rows[r]?.[c] === '.';
  return {
    moverStepLands(r0, c0, r1, c1) {
      if (!at(r0, c0) || !at(r1, c1)) return false;
      if (r0 !== r1 && c0 !== c1) return at(r0, c1) && at(r1, c0);
      return true;
    },
  };
}

console.log('\na corridor between two rooms');
{
  const geo = gridGeo([
    '##########################',
    '#.....#############......#',
    '#.....#############......#',
    '#........................#',
    '#.....#############......#',
    '#.....#############......#',
    '##########################',
  ]);
  ok('the middle of the corridor is a choke', isChokeSquare(geo, 3, 12));
  ok('open floor is not', !isChokeSquare(geo, 2, 3));
  ok('a room corner is not (one opening group)', !isChokeSquare(geo, 1, 1));
  const y = thoroughfareYield(geo, { row: 3, col: 12 }, [{ row: 3, col: 11 }]);
  ok('an idle body with a player behind it walks out the far end', y && y.to.col > 12, JSON.stringify(y));
  ok('and lands clear of the corridor mouth', y && y.clear === true && !isChokeSquare(geo, y.to.row, y.to.col));
  ok('it never steps through the player', y && y.path.every(p => p.col > 11));
  ok('no player near, nothing to do', thoroughfareYield(geo, { row: 3, col: 12 }, [{ row: 3, col: 2 }]) === null);
  ok('not in a choke, nothing to do', thoroughfareYield(geo, { row: 2, col: 3 }, [{ row: 2, col: 4 }]) === null);
  const shared = thoroughfareYield(geo, { row: 3, col: 12, x: 12 * 64 + 40, y: 3 * 64 + 32 },
                                   [{ row: 3, col: 12, x: 12 * 64 + 22, y: 3 * 64 + 32 }]);
  ok('on a shared square, it goes away from the side the player is on', shared && shared.path[0].col === 13,
     JSON.stringify(shared?.path?.[0]));
}

console.log('\na dead-end alcove');
{
  const geo = gridGeo([
    '#######',
    '#.....#',
    '#.....#',
    '###.###',
    '###.###',
    '#######',
  ]);
  ok('the alcove\'s last square is not a choke (one opening)', !isChokeSquare(geo, 4, 3));
  ok('the alcove\'s neck is a choke', isChokeSquare(geo, 3, 3));
}

console.log('\nEast Jasper (350), the stair tunnel');
const map = (() => { try { return loadMap(); } catch { return null; } })();
if (!map?.rooms?.['350']) skip('East Jasper geometry', 'no baked map in this checkout');
else {
  attachStepMasks(map);
  const geo = sharedRoomGeometry(map.rooms['350']);
  ok('r51c27..c34 are chokes', [27, 28, 29, 30, 31, 32, 33, 34].every(c => isChokeSquare(geo, 51, c)));
  ok('r51c35, the east mouth, is not', !isChokeSquare(geo, 51, 35));
  // The live positions, kod fine units: Scooter idle at x 1824, Fozzie behind him at x 1806.
  const scooter = { row: 51, col: 28, x: 1824, y: 3296 }, fozzie = { row: 51, col: 28, x: 1806, y: 3296 };
  const y = thoroughfareYield(geo, scooter, [fozzie]);
  ok('the idle body ahead walks east out of the tunnel', y && y.path.every(p => p.col >= 29) && y.to.col >= 35,
     JSON.stringify(y));
  ok('to ground clear of the mouth', y && y.clear === true);
  const back = thoroughfareYield(geo, fozzie, [scooter]);
  ok('the one behind, pinned against the stair landing, still gets off the line',
     back && !isChokeSquare(geo, back.to.row, back.to.col) && back.path[0].col <= 28, JSON.stringify(back));
  const old = nearestSafeSpot(geo, scooter, { within: 12, room: 350 });
  const now = nearestSafeSpot(geo, scooter, { within: 12, room: 350, avoidChokes: true });
  if (!(old?.row === 51 && old?.col === 28))
    skip('the tunnel was the best wall without avoidChokes', `this bake answers r${old?.row}c${old?.col}`);
  else ok('without avoidChokes the tunnel is still the best wall (combat walls unchanged)', true);
  ok('with avoidChokes resting picks a wall outside the tunnel', now && !isChokeSquare(geo, now.row, now.col),
     JSON.stringify(now && { row: now.row, col: now.col }));
}

console.log('\nwiring');
{
  const ap = readFileSync(join(HERE, 'm59-autopilot.mjs'), 'latin1');
  ok('restingSquare asks nearestSafeSpot to avoid chokes', /unreachable: this\.unreachableSpots \?\? null,[\s\S]{0,200}avoidChokes: true/.test(ap));
  const idle = ap.indexOf("if (await this.makeWay().catch(() => false)) return HANDLED;");
  const sit = ap.indexOf("if (await this.hibernate('idle: no job to do')");
  const eat = ap.indexOf("if (await this.eatToFloor(ctx) === 'ate') return HANDLED;", idle);
  ok('the idle branch makes way before it eats or rests', idle > 0 && eat > idle && sit > eat);
}

console.log(`\n${pass} passed, ${fail} failed` + (skipped ? `, ${skipped} skipped` : ''));
process.exit(fail ? 1 : 0);
