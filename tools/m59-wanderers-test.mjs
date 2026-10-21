// THE GUARD FOR m59-wanderers.mjs — offline, opens no socket, writes only a temp ledger.
//
//   node tools/m59-wanderers-test.mjs
//
// The cases that matter: a sighting is recorded (in a temp world book) from a look and goes STALE (a sighting is a
// moment, not an arrival); a look that shows his room EMPTY ends the sighting there; "Parrin"
// in a player's name is not Parrin; and posting puts the closest body on each room, never two
// bodies on one room while another room has none.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The module builds fleetscript steps, and the chassis wants a fleet name at import. Nothing here
// touches a fleet, so a name no fleet uses.
process.env.M59_FLEET ??= 'wanderers-test';
const { WANDERERS, wandererKey, wanderersIn, recordView, whereIs, searchOrder, assignPosts } = await import('./m59-wanderers.mjs');

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${what}`); } };
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);
const throws = (fn, what) => { try { fn(); ok(false, what); } catch { ok(true, what); } };

const dir = mkdtempSync(join(tmpdir(), 'wanderers-'));
const view = (room, ...names) => ({ room: { num: room }, objects: names.map(n => (typeof n === 'string' ? { name: n } : n)) });

// ---- names ------------------------------------------------------------------------------
eq(wandererKey('Perrin'), 'parrin', 'the misspelling everybody types resolves');
eq(wandererKey('DarkWizard'), 'maleval', 'the kod class name resolves');
throws(() => wandererKey('Jonas'), 'Jonas is coded but never spawned, so he is not a key');
eq(wanderersIn(view(952, 'Maleval', 'Parrin Aragone')), ['maleval', 'parrin'], 'both in the Duke\'s chambers');
eq(wanderersIn(view(952, { name: 'Parrin Aragone', is_player: true })), [], 'a PLAYER called that is not him');

// ---- the ledger ---------------------------------------------------------------------------
const t0 = 1_000_000_000_000;
eq(recordView(view(53, 'Maleval'), 'a', { now: t0, dir }), ['maleval'], 'a look with him in it records him');
{
  const w = whereIs('maleval', { now: t0 + 60_000, dir });
  ok(w.fresh && w.room === 53 && w.by === 'a', 'one minute later he is fresh in 53');
  ok(!whereIs('maleval', { now: t0 + 10 * 60_000, dir }).fresh, 'ten minutes later it is a rumour, not a fact');
  eq(whereIs('maleval', { now: t0 + 10 * 60_000, dir }).rumour, 53, '...but still the room to try first');
}
recordView(view(53), 'b', { now: t0 + 120_000, dir });
{
  const w = whereIs('maleval', { now: t0 + 130_000, dir });
  ok(!w.fresh && w.room === null, 'his room seen EMPTY ends the sighting');
  ok(w.absent[53] === t0 + 120_000, 'and is remembered as seen empty');
}
// Rooms seen empty recently go to the back of the search.
recordView(view(802), 'd', { now: t0 + 200_000, dir });
recordView(view(950), 'd', { now: t0 + 210_000, dir });
{
  const order = searchOrder('maleval', { now: t0 + 220_000, dir });
  ok(order.indexOf(950) > order.indexOf(952) && order.indexOf(802) > order.indexOf(200),
     `rooms just seen empty are searched last (${order.join(',')})`);
}

// ---- posting ------------------------------------------------------------------------------
{
  const rooms = WANDERERS.maleval.rooms;
  const five = assignPosts(rooms, rooms.map((r, i) => ({ agent: `x${i}`, room: r })));
  eq([...five.values()].map(r => r.length), [1, 1, 1, 1, 1], 'five bodies, five rooms: one room each');
  eq([...five.entries()].every(([a, r]) => rooms[Number(a.slice(1))] === r[0]), true, 'and a body already standing on a room keeps it');
  const two = assignPosts(rooms, [{ agent: 'a', room: 53 }, { agent: 'b', room: 200 }]);
  eq([...two.values()].flat().sort(), [...rooms].sort(), 'two bodies still cover every room between them');
  ok(two.get('a')[0] === 53 && two.get('b')[0] === 200, 'each posted first where it stands');
  const one = assignPosts(rooms, [{ agent: 'a', room: 53 }, { agent: 'b', room: 200 }, { agent: 'c', room: 952 }], { count: 1 });
  eq(one.size, 1, 'count=1 uses one body');
  eq(assignPosts(rooms, []).size, 0, 'no bodies, no plan, no throw');
}

console.log(`\nm59-wanderers: ${pass} assertion(s) passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
