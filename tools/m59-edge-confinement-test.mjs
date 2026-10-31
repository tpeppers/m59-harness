// A STEP OVER AN EDGE INTO A ROOM OUTSIDE THE CONFINEMENT IS REFUSED. Offline: reads the baked map, opens no socket.
//
//   node tools/m59-edge-confinement-test.mjs
//
// Pins edgeCrossedAt (m59-map.mjs) against the real island rooms where it went wrong on 2026-10-27 -- 2115's east
// edge splits by row (row < 20 -> 2124 kriipa, row > 20 -> 2125 dragonflies), 2125's east edge is 2135 (dragonfly
// queens, level 145) -- and that Session.beforeMove consults edgeCrossingBlock, so every faculty's step goes
// through it.
import fs from 'node:fs';
import { loadMap, edgeCrossedAt } from './m59-map.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}`); } };

const map = loadMap();
const r2115 = map.rooms[2115], r2125 = map.rooms[2125];
ok(r2115 && r2125, 'the baked map carries 2115 and 2125');

// inside: no crossing
ok(edgeCrossedAt(r2125, 20, 20) === null, '2125 interior r20c20 crosses nothing');
ok(edgeCrossedAt(r2115, 1, 1) === null, '2115 corner r1c1 is still inside');
// 2125's sides
ok(edgeCrossedAt(r2125, 20, r2125.cols + 1)?.edge?.to === 2135, '2125 east edge leads to 2135 (queens)');
ok(edgeCrossedAt(r2125, 16, 0)?.edge?.to === 2115, '2125 west edge leads to 2115');
// 2115's east edge, split by row exactly as ka5.kod declares it
ok(edgeCrossedAt(r2115, 10, r2115.cols + 1)?.edge?.to === 2124, '2115 east edge at row 10 leads to 2124 (kriipa)');
ok(edgeCrossedAt(r2115, 30, r2115.cols + 1)?.edge?.to === 2125, '2115 east edge at row 30 leads to 2125');
// a side with no exit: a crossing with no destination
const blank = { rows: 10, cols: 10, edgeExits: [] };
const none = edgeCrossedAt(blank, 0, 5);
ok(none?.direction === 'north' && none.edge === null, 'a side with no exit names the side and no destination');
// unreadable input never claims a crossing
ok(edgeCrossedAt(null, 0, 0) === null && edgeCrossedAt(r2125, NaN, 3) === null, 'no room or no square: null');

// the guard is on the step: beforeMove consults edgeCrossingBlock and refuses with the code movers see
const src = fs.readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
ok(/c\.beforeMove = target => \{[\s\S]{0,600}this\.edgeCrossingBlock\(target\)/.test(src), 'beforeMove consults edgeCrossingBlock');
ok(/code: 'EDGE_OUT_OF_CONFINEMENT'/.test(src), 'the refusal carries EDGE_OUT_OF_CONFINEMENT');
// The confinement is read once, by `edgeConfinement`, for the step guard and for travel's pre-walk check
// (`edgeIntoRefused`); m59-edge-guard-travel-test drives both against the real map.
ok(/edgeConfinement\(\) \{[\s\S]{0,120}confineRooms[\s\S]{0,120}confine\.length \? [\s\S]{0,40}: null/.test(src)
   && /edgeCrossingBlock\(target\) \{\s*const confine = this\.edgeConfinement\(\);\s*if \(!confine \|\| !target\) return null;/.test(src),
   'no confinement, no guard');
ok(/!room \|\| !confine\.includes\(Number\(room\.num\)\)\) return null/.test(src), 'only a step that LEAVES the confinement: a body outside it walks home');

console.log(`m59-edge-confinement-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
