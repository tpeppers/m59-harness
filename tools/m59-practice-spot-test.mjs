// A PRACTICE SPOT: WHERE TO STAND WHILE DRILLING. Offline: the normaliser and the pass's source, no socket.
//
//   node tools/m59-practice-spot-test.mjs
//
// Operator, 2026-10-27: "There's a big area just south of the chalice spawn with no monster spawns that's usually quiet
// enough for practice" ... "no reason not to add it as a feature". practice_spells.spot = { room, row, col }: in that room
// the drill walks to within 2 squares of the spot first, then practises standing still as before.
import fs from 'node:fs';
import { normalizePractice } from './m59-deskpractice.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}`); } };

const good = normalizePractice({ spells: ['bless'], rooms: [27], spot: { room: 27, row: 30, col: 11 } });
ok(JSON.stringify(good.spot) === JSON.stringify({ room: 27, row: 30, col: 11 }) && !good.problems.length, 'a spot is kept as { room, row, col }');
ok(normalizePractice({ spells: ['bless'] }).spot === null, 'no spot: null, practise where it stands');
const bad = normalizePractice({ spells: ['bless'], spot: { room: 27, row: 'south' } });
ok(bad.spot === null && bad.problems.some(p => /spot is \{ room, row, col \}/.test(p)), 'a malformed spot is reported and not applied');

const src = fs.readFileSync(new URL('./autopilot/desk-practice.mjs', import.meta.url), 'utf8');
const pass_ = src.slice(src.indexOf('async practiceAtDesk('));
const walkAt = pass_.indexOf("this.doing = 'walking to the practice spot'"), castAt = pass_.indexOf('choosePractice(');
ok(walkAt > 0 && castAt > walkAt, 'the walk to the spot comes before the drill');
ok(/spot && !session && spot\.room === Number\(here\)/.test(pass_), 'only in the spot\'s room, never during a session elsewhere');
ok(/Math\.max\(Math\.abs\(c\.self\.row - spot\.row\), Math\.abs\(c\.self\.col - spot\.col\)\)[\s\S]{0,40}off > 2/.test(pass_), 'within 2 squares counts as on the spot');
const health = pass_.indexOf('v.health.value / v.health.max < 0.9');
ok(health > 0 && health < walkAt, 'a hurt body (under 90%) never walks to drill');

console.log(`m59-practice-spot-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
