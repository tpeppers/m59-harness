#!/usr/bin/env node
// THE GUARD FOR m59-crossingtrial.mjs's READING HALF — offline, no socket, no DM.
//
// The harness is only as honest as the two things it reduces: a keeper's `[loop]` line and a
// second-by-second sample stream. Both are pinned here, including the distinction the stall
// column depends on — how late the timer fired against how much of that OUR code spent.
import { parseLoopLine, stallsIn, summarise, windowOf } from './m59-crossingtrial.mjs';

let failed = 0, passed = 0;
const ok = (label, cond, detail = '') => {
  if (cond) passed++; else failed++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
};

const planning = '[loop] shadow21 event loop was blocked ~2964ms, resumed 2026-09-24T21:52:24.693Z (room 599, doing zoning, travelling to 2) hot: (idle) :0 780ms, exposureAt m59-safespots.mjs:120 485ms | callers: sheltersAlong m59-safespots.mjs:667 2549ms, nearestSafeSpot m59-safespots.mjs:843 2545ms';
const idle = '[loop] shadow07 event loop was blocked ~431ms, resumed 2026-09-24T22:37:09.632Z (room 599, doing ?, travelling to 104) hot: (idle) :0 685ms, bboxRejects m59-roo.mjs:1114 37ms | callers: state m59-keeper-process.mjs:815 37ms';
const self = '[loop] shadow07 event loop was blocked ~300ms, resumed 2026-09-24T22:37:10.632Z (room 599, doing ?) hot: (anon) m59-keeper-process.mjs:4825 250ms | callers: (anon) m59-keeper-process.mjs:4825 250ms';

console.log('--- a [loop] line ---');
const a = parseLoopLine(planning), b = parseLoopLine(idle), c = parseLoopLine(self);
ok('agent, lateness, room and time', a.agent === 'shadow21' && a.ms === 2964 && a.room === 599
   && a.at === Date.parse('2026-09-24T21:52:24.693Z'));
ok('the heaviest caller of ours, and what it spent', a.caller === 'sheltersAlong m59-safespots.mjs:667' && a.code_ms === 2549);
ok('a late timer that was mostly (idle) is not a planning stall', b.ms === 431 && b.code_ms === 37 && b.idle_ms === 685);
ok('the profiler analysing a stall is marked as its own report', c.self_report && !a.self_report);
ok('a line that is not a [loop] line is nothing', parseLoopLine('[keeper] shadow01 HTTP API on port 9101') === null);

console.log('\n--- stalls inside one crossing ---');
const lines = [a, b, c];
const s = stallsIn(lines, { agent: 'shadow07', room: 599, from: Date.parse('2026-09-24T22:37:00Z'), to: Date.parse('2026-09-24T22:38:00Z') });
ok('counts both of that agent\'s lines in the window', s.count === 2 && s.worst_ms === 431);
ok('but charges our code only for its own time, not the profiler\'s', s.code_ms === 37 && s.code_over_250 === 0 && s.worst_code_ms === 37);
const s2 = stallsIn(lines, { agent: 'shadow21', room: 599, from: 0, to: Infinity });
ok('a real planning block is over the bound', s2.code_over_250 === 1 && s2.top_caller.startsWith('sheltersAlong'));
ok('another room is not this room', stallsIn(lines, { agent: 'shadow21', room: 598, from: 0, to: Infinity }).count === 0);

console.log('\n--- one character\'s samples ---');
const T = 1_000_000;
const samples = [
  { t: T, room: 598, hp: 50, max: 50, deaths: 0 },
  { t: T + 1000, room: 599, hp: 50, max: 50, deaths: 0 },
  { t: T + 2000, room: 599, hp: 40, max: 50, deaths: 0 },
  { t: T + 3000, room: 599, hp: 45, max: 50, deaths: 0 },
  { t: T + 4000, room: 599, hp: 30, max: 50, deaths: 0 },
  { t: T + 5000, room: 2, hp: 31, max: 50, deaths: 0 },
];
const sum = summarise(samples, { danger: 599, dest: 2, start: 598 });
ok('arrived', sum.outcome === 'arrived');
ok('time in the room is first to last sample inside it', sum.in_room_s === 3);
ok('damage is every drop, not the net change (10 + 15, the regen does not cancel it)', sum.damage === 25, `${sum.damage}`);
ok('lowest health seen inside', sum.hp_min === 30 && sum.hp_start === 50);
const dead = summarise([...samples.slice(0, 4), { t: T + 4000, room: 1, hp: 1, max: 50, deaths: 1 }], { danger: 599, dest: 2, start: 598 });
ok('a death is a death, wherever the body ended', dead.outcome === 'died');
const fell = summarise([...samples.slice(0, 4), { t: T + 9000, room: 589, hp: 45, max: 50, deaths: 0 }], { danger: 599, dest: 2, start: 598 });
ok('ending in a third room is `elsewhere`, not arrival', fell.outcome === 'elsewhere');
const stuck = summarise(samples.slice(0, 4), { danger: 599, dest: 2, start: 598, timedOut: true });
ok('still inside when time ran out is a timeout', stuck.outcome === 'timeout');

console.log('\n--- the window of an old row, from its trace ---');
const w = windowOf({ at: new Date(T).toISOString(), danger: 599, total_s: 20,
                     trace: [[0, 598, 'x'], [4, 599, 'y'], [9, 599, 'z'], [15, 2, 'w']] });
ok('from the first trace entry inside to the first outside', w.from === T + 4000 && w.to === T + 15000 + 1500);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
