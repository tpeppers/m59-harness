#!/usr/bin/env node
// THE WALL STOPS THAT KILLED, PINNED ON THE REAL GEOMETRY.
//
// Each `tools/fixtures/wallstop-*.json` is a spot where a traveller took "a wall on the way
// past", stood on it in a room of many monsters, was reached anyway, and died without
// moving (see m59-recordwallstop.mjs, and the 2026-09-02 reading in docs/m59-policy.md:
// 57 of 89 road deaths across both fleets). Two things are pinned here for every spot:
//
//   1. THE GEOMETRY OFFERS THE WALL. From the square the body died on, the wall search with
//      walls allowed finds a wall, and the wall the keeper actually chose is one the
//      geometry calls a safe square. That is the old behaviour, and it is what killed.
//   2. IN THIS CROWD THE SEARCH OFFERS NO WALL. With walls withheld (the crowd rule,
//      Autopilot.crowded, at or above travelStopMaxThreats live threats) the same search
//      answers nothing without a journey and only the exit with one.
//
// And two facts from the record, so the fixture cannot be quietly re-read as something
// milder: the crowd was at or above the rule's default, and blows landed on the stop square.
// Offline, no socket, no roster. Fixtures stay redacted — the last section checks.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadMap } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { sharedRoomGeometry } from './m59-roo.mjs';
import { nearestSafeSpot, safeSpots } from './m59-safespots.mjs';
import { rosterNamesFrom, FORMAT } from './m59-recordwallstop.mjs';

let pass = 0, fail = 0, skipped = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};
const skip = (name, why) => { skipped++; console.log('  --   ' + name + ' — ' + why); };

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'fixtures');
const files = existsSync(dir) ? readdirSync(dir).filter(f => /^wallstop-.*\.json$/.test(f)).sort() : [];
if (!files.length) {
  skip('wall-stop fixtures', 'none on disk — run m59-recordwallstop.mjs');
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(0);
}

const map = (() => { try { return loadMap(); } catch (e) { return null; } })();
if (!map) { skip('the map', 'could not load substrate/m59-map.json'); console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`); process.exit(0); }
try { attachStepMasks(map, { lazy: true }); } catch { /* masks are a bonus here */ }

const STOP_MAX_THREATS_DEFAULT = 6;
let spotsWithCrowd = 0, spotsReached = 0;

for (const f of files) {
  const fx = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const label = `${f}`;
  console.log(`\n${label}: ${fx.room?.name ?? '?'} (${fx.room?.num}), stop r${fx.stop?.row}c${fx.stop?.col}, ${fx.occurrences?.length ?? 0} death(s)`);
  ok('is a wall-stop fixture', fx.format === FORMAT && Array.isArray(fx.occurrences) && fx.occurrences.length > 0);
  const room = map.rooms[String(fx.room?.num)];
  if (!room) { skip('geometry', `room ${fx.room?.num} is not in the map`); continue; }
  let geo = null; try { geo = sharedRoomGeometry(room); } catch { geo = null; }
  if (!geo?.walkable) { skip('geometry', 'no BSP for this room'); continue; }

  const stop = { row: fx.stop.row, col: fx.stop.col };
  ok('the stop square is walkable', geo.walkable(stop.row, stop.col) === true, `r${stop.row}c${stop.col}`);
  const within = Math.max(geo.rows ?? 0, geo.cols ?? 0) || 64;
  const opts = { within, rule: 'wall', minAvoided: 20, fromFightWeight: 0.3, room: fx.room.num, los: 0 };

  // 1. the geometry offers a wall from here, and the chosen wall is one the geometry calls safe
  let offered = null;
  try { offered = nearestSafeSpot(geo, stop, { ...opts }); } catch (e) { offered = { error: e.message }; }
  ok('with walls allowed the search offers a wall from the stop square (the old behaviour)',
     !!offered && !offered.error && Number.isFinite(offered.row), JSON.stringify(offered).slice(0, 120));
  const walls = fx.occurrences.map(o => o.wall).filter(w => w && Number.isFinite(w.row));
  if (walls.length) {
    let all = [];
    try { all = safeSpots(geo, { limit: Infinity, los: 0 }); } catch { all = []; }
    const isWall = (w) => all.some(s => s.row === w.row && s.col === w.col);
    const chosenIsWall = walls.some(isWall);
    ok('the wall the keeper chose is a square the geometry calls a wall',
       chosenIsWall || walls.some(w => !geo.walkable(w.row, w.col)) === false && chosenIsWall,
       walls.map(w => `r${w.row}c${w.col}`).join(' ') + (chosenIsWall ? '' : ' not among ' + all.length + ' geometric walls'));
  }

  // 2. in this crowd the search offers no wall
  const stats = {};
  let withheld = null;
  try { withheld = nearestSafeSpot(geo, stop, { ...opts, wallsAllowed: false, stats }); } catch (e) { withheld = { error: e.message }; }
  ok('with walls withheld and no journey the search offers nothing', withheld === null, JSON.stringify(withheld).slice(0, 120));
  ok('and says so', stats.walls_withheld === true, JSON.stringify(stats));

  // the record's facts
  const most = Math.max(0, ...fx.occurrences.map(o => Number(o.threats?.most_at_once) || 0));
  const crowd = most >= STOP_MAX_THREATS_DEFAULT;
  if (crowd) { spotsWithCrowd++; ok(`the crowd was at or above the rule's default of ${STOP_MAX_THREATS_DEFAULT}`, true, `most at once ${most}`); }
  else skip(`the crowd rule would not have applied here (most at once ${most}, default ${STOP_MAX_THREATS_DEFAULT})`,
            'a wall stop in a thin room is the wedge class, not the crowd class — kept as evidence, not as a crowd case');
  const reached = fx.occurrences.some(o => (o.hits_on_the_stop_square ?? 0) > 0 || (o.hits_while_standing ?? []).some(h => (h.by ?? []).length));
  if (reached) spotsReached++;
  ok('blows landed while the body stood there — the wall was reached',
     reached, JSON.stringify(fx.occurrences.map(o => [o.hits_on_the_stop_square, o.lost_on_the_stop_square])));
  const stood = Math.max(...fx.occurrences.map(o => Number(o.stood_ms) || 0));
  ok('the body had stood at least a minute', stood >= 60_000, `${Math.round(stood / 1000)}s`);
}

console.log(`\n${files.length} spot(s): crowd at or above the default in ${spotsWithCrowd}, reached on the wall in ${spotsReached}`);

// ---------------------------------------------------------------- redaction
console.log('\nthe fixtures on disk stay redacted and well-formed');
{
  const rosterFiles = [];
  for (const d of ['substrate/fleets']) if (existsSync(d)) for (const f of readdirSync(d)) if (f.endsWith('.json')) rosterFiles.push(join(d, f));
  if (existsSync('substrate/fleet-state.json')) rosterFiles.push('substrate/fleet-state.json');
  const names = [...rosterNamesFrom(rosterFiles)].filter(n => n.length >= 4 && !/^(shadow|t)\d+$/i.test(n));
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    const leaked = names.filter(n => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
    ok(`${f} names no character of this machine's rosters`, leaked.length === 0, leaked.length ? `${leaked.length} leaked` : '');
    ok(`${f} carries no agent alias`, !/"(agent|character)":/.test(text));
  }
}

console.log(`\n${pass} passed, ${fail} failed` + (skipped ? `, ${skipped} skipped` : ''));
process.exit(fail ? 1 : 0);
