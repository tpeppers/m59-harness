#!/usr/bin/env node
// m59-secret-travel-test.mjs — offline. Pins what counts as a witness, the watchdog's verdicts, the inn table and the report.
import { strangersIn, roomGraph, nearestOf, watchTick, summarise } from './m59-secret-travel.mjs';

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log('FAIL', what); } };

const fleet = new Set(['t1', 'kermit', 't2', 'pepe', 'a merchant host']);
const objs = [
  { name: 'Kermit', is_player: true }, { name: 'Pepe', is_player: true },
  { name: 'Rick Deckard', is_player: true, col: 3, row: 4 },
  { name: 'troll', is_player: false }, { name: 'Tendrath', is_player: false },
  { name: 'A Merchant Host', is_player: true },
];
const s = strangersIn(objs, fleet, 'Kermit');
ok(s.length === 1 && s[0].name === 'Rick Deckard' && s[0].col === 3, 'only the non-fleet player is a stranger');
ok(strangersIn([{ name: 'Tendrath', is_player: false }], fleet).length === 0, 'an NPC is never a witness');
ok(strangersIn([{ name: 'Someone', is_player: 1 }], fleet).length === 0, 'is_player must be literally true');
ok(strangersIn([{ name: '  ', is_player: true }], fleet).length === 0, 'an unnamed player is not counted as a name');
ok(strangersIn(null, fleet).length === 0, 'no objects, no strangers');

const t = { to: 615, sentAt: Date.now() - 60_000 };
ok(watchTick(t, { room: { num: 45 }, hp: { value: 80 }, objects: objs, character: 'Kermit', movement: { order: {} } }, fleet).act === 'discovered', 'a stranger mid-journey trips the watchdog');
ok(watchTick(t, { room: { num: 615 }, hp: { value: 80 }, objects: objs, character: 'Kermit' }, fleet).act === 'discovered', 'a stranger in the destination still trips it');
ok(watchTick(t, { room: { num: 615 }, hp: { value: 80 }, objects: [], movement: { order: null } }, fleet).act === 'arrived', 'arrival');
ok(watchTick(t, { room: { num: 1 }, hp: { value: 80 }, objects: [] }, fleet).act === 'died', 'the Underworld is a death');
ok(watchTick(t, { room: { num: 45 }, hp: { value: 0 }, objects: [] }, fleet).act === 'died', 'no health is a death');
const ts = { to: 615, sentAt: Date.now() - 60_000 };
ok(watchTick(ts, { room: { num: 45 }, hp: { value: 50 }, objects: [], movement: { order: null } }, fleet).act === 'continue', 'one null reading is a rest, not a stall');
ts.idleSince = Date.now() - 50_000;
ok(watchTick(ts, { room: { num: 45 }, hp: { value: 50 }, objects: [], movement: { order: null } }, fleet).act === 'stalled', 'a null order held 45s, not there: stalled');
watchTick(ts, { room: { num: 45 }, hp: { value: 50 }, objects: [], movement: { order: {} } }, fleet);
ok(ts.idleSince == null, 'a live order resets the idle clock');
ok(watchTick({ to: 615, sentAt: Date.now() }, { room: { num: 45 }, hp: { value: 50 }, objects: [], movement: { order: null } }, fleet).act === 'continue', 'a journey just sent is not yet stalled');
ok(watchTick(t, { room: { num: 45 }, hp: { value: 50 }, objects: [], movement: { order: { to: 615 } } }, fleet).act === 'continue', 'travelling, clear: continue');

const tw = { to: 615, sentAt: Date.now() - 600_000 };
const live = (row, col) => ({ room: { num: 49 }, hp: { value: 80 }, objects: [], you: { row, col }, movement: { order: { to: 615 } } });
ok(watchTick(tw, live(25, 17), fleet).act === 'continue', 'first reading anchors');
tw.anchor.at = Date.now() - 250_000;
ok(watchTick(tw, live(26, 17), fleet).act === 'wedged', 'a live order with one square of progress in 4 min is wedged');
ok(watchTick(tw, live(26, 17), fleet).act === 'continue', 'the anchor resets after a wedge verdict');
tw.anchor.at = Date.now() - 250_000;
ok(watchTick(tw, live(20, 17), fleet).act === 'continue', 'real progress is not wedged');
const tn = { to: 615, sentAt: Date.now() - 1000 };
watchTick(tn, live(25, 17), fleet); tn.anchor.at = Date.now() - 250_000;
ok(watchTick(tn, live(25, 17), fleet).act === 'continue', 'never wedged within 4 min of a send');

const map = { rooms: {
  153: { name: 'Cibilo Creek Inn', goExits: [{ to: 150 }] }, 150: { name: 'Cor Noth', goExits: [{ to: 153 }], edgeExits: [{ to: 574 }] },
  574: { name: 'gate', edgeExits: [{ to: 150 }, { to: 45 }] }, 45: { name: 'Badlands', edgeExits: [{ to: 574 }, { to: 615 }] }, 615: { name: 'Badlands' } } };
const g = roomGraph(map, [[615, 45]]);
const near = nearestOf(g, [153, 574, 45, 615], [153]);
ok(near[153].room === 153 && near[153].hops === 0, 'in the inn: the inn');
ok(near[574].hops === 2 && near[45].hops === 3, 'hops counted');
ok(near[615]?.room === 153 && near[615].hops === 4, 'the extra 615->45 exit makes 615 reachable');
ok(nearestOf(roomGraph(map), [615], [153])[615] === undefined, 'without it 615 has no way out');

const rows = [
  { what: 'run start' }, { what: 'waiting: stranger in the room', agent: 't2', room: 153, strangers: [{ name: 'X' }] },
  { what: 'DISCOVERED', agent: 't2', room: 45, strangers: [{ name: 'X' }, { name: 'Y' }] },
  { what: 'arrived', agent: 't1' }, { what: 'died', agent: 't3' },
];
const sm = summarise(rows);
ok(sm.discovered.length === 1 && sm.waited.length === 1 && sm.died.length === 1 && sm.arrived.size === 1, 'summary counts');
ok(sm.strangers.size === 2 && sm.strangers.get('X').triggered === 1 && sm.strangers.get('X').rooms.size === 2, 'per-stranger rooms and trips');

console.log(`m59-secret-travel-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
