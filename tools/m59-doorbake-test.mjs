#!/usr/bin/env node
// A DOOR THAT IS A FLOOR — opened offline, against the real rooms, with no server.
//
//   node tools/m59-doorbake-test.mjs
//
// Needs the .roo files (M59_ROOT, or the usual checkout beside this one). Skips loudly
// rather than passing quietly when they are absent — a geometry test that silently tests
// nothing is the failure it exists to catch.
//
// WHAT IT PINS, and every line of it was measured on 2026-09-04:
//
//   * Overriding a sector's floor height and RE-DERIVING THE WALLS opens the Duke's Feast
//     Hall. The feast exits sit in a 38-square island that cannot reach the keep's body;
//     with FEAST_DOOR_CLOSED lowered to its open height they are one region of 682.
//
//   * Overriding the sector WITHOUT re-deriving the walls changes nothing at all. That is
//     not a detail — it is a false negative that reads exactly like proof the door is
//     innocent, and it cost an hour and a wrong conclusion out loud before the wall z
//     values were looked at.
//
//   * Ukgoth's door is the same shape and worth 85 squares.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseRoo, RoomGeometry, geometryWithSectorHeights, heightKodToClient,
         setWallHeights } from './m59-roo.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
};

const ROOMS = process.env.M59_ROOT
  ? join(process.env.M59_ROOT, 'resource/rooms')
  : 'C:/code/Meridian59/resource/rooms';

const rooFor = name => {
  const p = join(ROOMS, name);
  return existsSync(p) ? readFileSync(p) : null;
};

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

const duke2 = rooFor('duke2.roo');
if (!duke2) {
  console.log('\nSKIPPED — no .roo files found at ' + ROOMS);
  console.log('Set M59_ROOT to a Meridian 59 checkout to run this.');
  process.exit(0);
}

console.log('\nthe Duke\'s Feast Hall: a door that is a floor');
{
  // The feast exits are at r9c9 and r10c9 of Blackstone Keep (951); duke2.kod's
  // CreateStandardExits puts them there, and the keep's body is east of the antechamber.
  const shut = geometryWithSectorHeights(duke2, {}, { file: 'duke2.roo' });
  const shutRegion = region(shut.geometry, 9, 9);
  ok('as shipped, the feast exit is stranded in a small island',
     shutRegion.size < 100, `${shutRegion.size} squares`);
  ok('and that island cannot reach the keep body where a traveller lands',
     !shutRegion.has('9,14'));

  // duke2.kod Open(): FEAST_DOOR_CLOSED (serverId 3) drops to 356, FEAST_DOOR_OPEN to 419.
  const open = geometryWithSectorHeights(duke2, { 3: 356, 4: 419 }, { file: 'duke2.roo' });
  const openRegion = region(open.geometry, 9, 9);
  ok('opening the door moved a sector', open.moved === 2, `${open.moved} sector(s)`);
  ok('and the feast exit is then part of the keep proper',
     openRegion.has('9,14'), `${openRegion.size} squares`);
  ok('which is an order of magnitude more room than it had',
     openRegion.size > shutRegion.size * 10,
     `${shutRegion.size} -> ${openRegion.size}`);
}

console.log('\nre-deriving the WALLS is the whole trick, and skipping it is a false negative');
{
  // The mover tests walls, and a wall's z heights are computed from its sectors ONCE at
  // parse time. This reproduces the mistake deliberately: same override, no re-derivation.
  const parsed = parseRoo(duke2, 'duke2.roo');
  for (const s of parsed.sectors) if (s.serverId === 3) s.floorHeight = heightKodToClient(356);
  const g = new RoomGeometry(parsed);
  g.attachStepMask(g.buildStepMask());
  const stillStuck = region(g, 9, 9);
  ok('lowering the sector alone leaves the exit exactly as stranded',
     !stillStuck.has('9,14'), `${stillStuck.size} squares`);

  // And the same parse, rescued by the one line that was missing.
  for (const wall of parsed.walls) setWallHeights(wall, parsed.sectors);
  const g2 = new RoomGeometry(parsed);
  g2.attachStepMask(g2.buildStepMask());
  ok('re-deriving the wall heights is what opens it', region(g2, 9, 9).has('9,14'));
}

const i9 = rooFor('i9.roo');
if (i9) {
  console.log('\nUkgoth has one too, and this fleet walks through it daily');
  const biggest = (g) => {
    const seen = new Set();
    let best = 0;
    for (let r = 0; r < g.rows; r += 3) for (let c = 0; c < g.cols; c += 3) {
      if (seen.has(`${r},${c}`)) continue;
      let standable = false;
      try { standable = g.standable(r, c); } catch { standable = false; }
      if (!standable) continue;
      const found = region(g, r, c);
      for (const k of found) seen.add(k);
      if (found.size > best) best = found.size;
    }
    return best;
  };
  // i9.kod SECTOR_DOOR: 440 shut, 340 open.
  const shut = biggest(geometryWithSectorHeights(i9, {}, { file: 'i9.roo' }).geometry);
  const open = biggest(geometryWithSectorHeights(i9, { 1: 340 }, { file: 'i9.roo' }).geometry);
  ok('opening the door grows the room the fleet can actually use',
     open > shut, `${shut} -> ${open} squares`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
