// Offline. Pure functions of tools/m59-roomyield.mjs plus one read of the committed room tables.
// Opens no socket, touches no roster, reads no ledger.
//
//   node tools/m59-roomyield-test.mjs
import { generatorOf, ceilingPerHour, residency, roomOfRow, roomYield, loadCeilings, onlyWho, SHARED_MS } from './m59-roomyield.mjs';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('FAIL', what); } };
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

// ---- the ceiling: Ukgoth, from i9.kod (70000 ms, 85%, trolls 100) ----
const classes = new Map([
  ['MonsterRoom', { class: 'MonsterRoom', parent: 'Room', pigen_time: '20000', pigen_percent: '100', pimonster_count_max: '10' }],
  ['ObjectRoom', { class: 'ObjectRoom', parent: 'MonsterRoom' }],
  ['OutdoorsI9', { class: 'OutdoorsI9', parent: 'MonsterRoom', pigen_time: '70000', pigen_percent: '85', pimonster_count_max: '15' }],
  ['CASTLE1', { class: 'CASTLE1', parent: 'ObjectRoom' }],
]);
const i9 = generatorOf(classes, 'OutdoorsI9');
ok(i9.gen_ms === 70000 && i9.gen_percent === 85 && i9.cap === 15, 'i9 reads its own generator');
const uk = ceilingPerHour(i9, [{ creature: 'troll', cls: 'Troll', chance: 100, how: 'generator' }], n => /troll/i.test(n));
ok(near(uk.per_hour, 218.57), `Ukgoth makes ~218 trolls an hour, got ${uk.per_hour}`);
ok(near(uk.tick_s, 14), 'one roll every 14s: the five-player rate, never scaled down');

// ---- inheritance: a class that declares nothing must inherit, not read 0 ----
const castle = generatorOf(classes, 'CASTLE1');
ok(castle.gen_ms === 20000 && castle.gen_percent === 100 && castle.cap === 10,
   `CASTLE1 inherits MonsterRoom through ObjectRoom (an undeclared field is not 0): ${JSON.stringify(castle)}`);

// ---- weights under 100 are empty ticks; a mixed room's share is its own weight ----
const cv = ceilingPerHour(castle, [{ creature: 'skeleton', chance: 40, how: 'generator' },
                                   { creature: 'zombie', chance: 20, how: 'generator' }], () => true);
ok(near(cv.per_hour, 540), `40+20 of 100: 60% of 900 rolls an hour, got ${cv.per_hour}`);
const tw = ceilingPerHour({ gen_ms: 45000, gen_percent: 80, cap: 15 },
  [{ creature: 'spider', chance: 55, how: 'generator' }, { creature: 'troll', chance: 45, how: 'generator' }],
  n => /troll/i.test(n));
ok(near(tw.per_hour, 144), `597's trolls are 45% of its rolls, got ${tw.per_hour}`);
ok(ceilingPerHour({ gen_ms: 0 }, [{ creature: 'troll', chance: 100, how: 'generator' }], () => true) === null,
   'no generator, no ceiling');
ok(ceilingPerHour(i9, [{ creature: 'StoneTroll', chance: null, how: 'respawn' }], () => true) === null,
   'a placed respawn is not a generator and has no rate');
ok(near(ceilingPerHour(i9, [{ creature: 'troll', chance: 100, how: 'generator' }], () => true, { spawnRate: 50 }).per_hour, 437.14),
   'a server SpawnRate of 50 halves the wait');

// ---- rows that place a body ----
ok(roomOfRow({ kind: 'travel_map_entered', room: 599 }) === 599, 'a room entry places the body');
ok(roomOfRow({ kind: 'zone_change', ended_in: 350, from: 599 }) === 350, 'a journey places it where it ENDED');
ok(roomOfRow({ kind: 'killed', room: 'Ukgoth', room_num: 599 }) === 599, 'a kill places it by number, not name');
ok(roomOfRow({ kind: 'travel_map_entered', room: 'Ukgoth' }) === null, 'a room NAME is not a room number');

// ---- residency and the gap rule ----
const T = Date.parse('2026-10-17T04:30:00Z'), M = 60_000;
const res = residency(new Map([['A', [[T, 599], [T + 5 * M, 599], [T + 30 * M, 350]]]]),
  { from: T, to: T + 40 * M, gapMs: 10 * M });
ok(res.get('A').get(599) === 15 * M, `5 min + a 25-min silence capped at 10 = 15 min in 599, got ${res.get('A').get(599) / M}`);
ok(res.get('A').get(350) === 10 * M, 'the last 10 minutes are in 350');
const before = residency(new Map([['B', [[T - 5 * M, 599], [T + 2 * M, 599]]]]), { from: T, to: T + 10 * M });
ok(before.get('B').get(599) === 10 * M, 'a room entered before the window counts from the window start');

// ---- the whole report ----
const kill = (who, t, extra = {}) => ({ type: 'event', kind: 'killed', character: who, t, room_num: 599,
  room: 'Ukgoth, Holy Land of Trolls', creature: 'troll', from_safe_spot: true, ...extra });
const sample = (who, t, room, activity) => ({ type: 'sample', character: who, t, room_num: room, activity });
const events = [
  kill('A', T + 1 * M), kill('A', T + 6 * M), kill('B', T + 6 * M + 500),           // B shares A's second
  kill('B', T + 20 * M, { from_safe_spot: false }),
  { type: 'event', kind: 'killed', character: 'A', t: T + 25 * M, room_num: 597, creature: 'spider' },
];
const samples = [sample('A', T, 599, 'holding a proven safe spot'), sample('A', T + 5 * M, 599, 'hunting: troll'),
  sample('B', T, 599, 'holding a proven safe spot'), sample('B', T + 5 * M, 350, 'waiting'),
  sample('B', T + 15 * M, 599, 'holding a proven safe spot')];
const r = roomYield({ events, samples, from: T, to: T + 30 * M, match: n => /troll/i.test(n), gapMs: 10 * M,
  ceilings: new Map([[599, uk]]) });
const u = r.rooms.find(x => x.room === 599);
ok(r.kills === 4 && u.kills === 4, 'four trolls, the spider is not one');
ok(u.wall_share === 0.75, 'three of four from a wall');
ok(u.shared_share === 0.25 && SHARED_MS === 1500, 'one kill shares its creature with another character inside 1.5s');
ok(u.kills_per_30m === 4, 'four in a 30-minute window');
ok(near(u.of_ceiling, 8 / 218.57, 0.02), 'of-ceiling is the hourly rate against the hourly ceiling');
ok(u.activity[0].what === 'holding a proven safe spot', 'the commonest activity in the room comes first');
ok(u.activity.every(a => !/:/.test(a.what)), 'the quarry is cut off an activity, so "hunting: troll" and "hunting: orc" are one');
ok(!r.rooms.some(x => x.room === 597), 'a room with no matching kill is left out unless asked for');
ok(r.time_share[0].room === 599, 'the crew spent most of its time in 599');
ok(roomYield({ events, samples, from: T, to: T + 30 * M, rooms: [350], match: n => /troll/i.test(n) }).rooms[0]?.room === 350,
   'a room asked for by number is reported even with no kills');

// ---- one arm of an A/B ----
const arm = onlyWho([{ agent: 't7', character: 'A', kind: 'killed' }, { agent: 't8', character: 'B', kind: 'killed' }],
  [{ character: 'A' }, { character: 'B' }], ['t7']);
ok(arm.events.length === 1 && arm.samples.length === 1 && arm.samples[0].character === 'A',
   'an agent id selects that character\'s samples too, which carry only the name');
ok(onlyWho([], [{ character: 'Ann' }], ['ann']).samples.length === 1, 'names match regardless of case');

// ---- the committed tables join up ----
const real = loadCeilings(n => /^troll$/i.test(String(n ?? '')));
ok(!real.error, `the committed room tables load: ${real.error ?? ''}`);
ok(real.get(599) && near(real.get(599).per_hour, 218.57), 'Ukgoth from the real tables');
ok(real.get(598) && near(real.get(598).per_hour, 108), `the Cragged Mountains (60% of 80s ticks): ${real.get(598)?.per_hour}`);

console.log(`m59-roomyield-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
