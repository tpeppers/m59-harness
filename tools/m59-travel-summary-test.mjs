import assert from 'node:assert/strict';
import { travelSummary } from './m59-travel-summary.mjs';
import { renderTravel } from './m59-travel-page.mjs';
import { M59Client } from './m59-client.mjs';

const event = (kind, detail = {}) => ({ kind, t: 10000, character: 'Kermit', ...detail });
const events = [event('travel_journey', { from: 39, to: 544, ended_in: 40, arrived: false, ms: 5000 }),
  event('travel_journey', { from: 40, to: 41, ended_in: 41, arrived: true, ms: 4000 }),
  event('travel_journey', { to: 999 }),
  event('travel_journey', { character: 'Other', from: 888, to: 889, arrived: true }),
  event('chalice', { what: 'drank' }), event('chalice', { what: 'landed', landed_in: 714 }),
  event('cast', { spell: 'rescue', t: 2000 }), event('travel_cast', { spell: 'rescue', t: 3000 }),
  event('cast', { spell: 'rescue', t: 3001 }), event('travel_cast', { spell: 'elusion' }),
  event('travel_method', { method: 'portal' }), event('travel_method', { method: 'underworld' }),
  event('travel_map_entered', { room: 41, from: 40 }),
  event('stuck_backed_up', { room: 39, wedged_for_ms: 5000, t: 7000 }),
  event('wedge_gave_up', { room: 39, wedged_for_ms: 5000, t: 9000 }),
  event('stuck_backed_up', { room: 39, wedged_for_ms: 10000, t: 999999 }),
];
const books = [{ character: 'Kermit', transits: [
  { at: 4000, room: 39, to: 40, ok: true, ms: 1000, tried: 2, refusals: [{ why: 'collision refused' }] },
  { at: 5000, room: 39, to: 544, ok: false, ms: 3000 },
  ...Array.from({ length: 5 }, (_, i) => ({ at: 6000 + i, room: 40, room_name: 'Clean road <test>', to: 41, ok: true, ms: 500 })),
]}];
const data = travelSummary({ events, books, characters: new Set(['Kermit', 'Idle']), since: 3000, now: 20000 });
const k = data.characters.find(r => r.character === 'Kermit');
assert.equal(data.characters.length, 2, 'fleet scoping excludes another fleet');
assert.equal(k.maps, 4, 'failed and unknown intended destinations are excluded');
assert.equal(k.journeys, 3); assert.equal(k.unknown, 1); assert.equal(k.failed, 1);
assert.equal(k.methods.rescue, 1, 'new and old cast logs do not double count');
assert.equal(k.methods.chalice, 1, 'drinking is not proof of landing');
assert.equal(k.method_types, 5); assert.equal(k.entries, 1);
assert.equal(k.stuck_ms, 6000, 'overlapping wedges are unioned and clipped to the window');
assert.equal(k.issues, 2); assert.equal(k.collisions, 1);
assert.equal(data.maps.find(r => r.room === 39).issue_rate, 1);
assert.equal(data.cleanBusy.room, 40);
assert.equal(data.maps.some(r => [544, 999, 888, 889].includes(r.room)), false);
const html = renderTravel({ data, sort: 'stuck_ms' });
assert.match(html, /Chalice rides/); assert.match(html, /Underworld exits/);
assert.match(html, /Clean road &lt;test&gt;/); assert.match(html, /at most 600/);
assert.match(renderTravel({ data: travelSummary() }), /No travel recorded/);

const sent = [], emitted = [];
const c = Object.assign(Object.create(M59Client.prototype), { spells: [{ id: 3, nameRsc: 1 }],
  rsc: { get: () => 'Rescue' }, send: (...args) => sent.push(args), emit: (...args) => emitted.push(args) });
c.cast(3); assert.equal(sent.length, 1); assert.deepEqual(emitted, [['travel-cast', { spell: 'rescue' }]]);
console.log('travel: fleet/window scope, failed destinations, method counts, overlap, rankings, rendering and casts passed');
