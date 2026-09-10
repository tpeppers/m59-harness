#!/usr/bin/env node
// WHAT A RENDERER GETS FROM A KEEPER-BACKED BROKER.
//
// Opens no socket, joins nobody, reads no roster. Every case below is a shape that was
// observed on the production fleet, and the first two are the regression this file exists
// for: twenty-one characters in game and `looks: { t1: {}, ... }` on /rts/v1/read, because
// the broker answered a renderer with the keeper's /state — which has no position and no
// room contents — and because the endpoint did not await the promise it got back.
//
// Run: node tools/m59-render-test.mjs

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { keeperView, renderProjection } from './m59-render-projection.mjs';

let checks = 0;
const is = (a, b, why) => { checks++; assert.deepEqual(a, b, why); };
const ok = (v, why) => { checks++; assert.ok(v, why); };

const SELF_APPEARANCE = {
  icon_rsc: 950, icon_resource: 'bta.bgf', flags: 0x0004, rarity: 4,
  light: { flags: 1, intensity: 24, color: 65535 }, translation: 2, effect: 0,
  animation: { type: 1, group: 3, period: null, group_low: null,
    group_high: null, group_final: null },
  overlays: [{ icon_rsc: 952, icon_resource: 'helm.bgf', hotspot: 3,
    translation: 7, effect: 0, animation: { type: 1, group: 1, period: null,
      group_low: null, group_high: null, group_final: null } }],
  motion: { translation: 4, effect: 0,
    animation: { type: 2, group: null, period: 500, group_low: 2,
      group_high: 6, group_final: null },
    overlays: [{ icon_rsc: 953, icon_resource: 'swordov.bgf', hotspot: -2,
      translation: 0, effect: 1, animation: { type: 3, group: null, period: 200,
        group_low: 4, group_high: 6, group_final: 1 } }] },
};
const ENTITY_APPEARANCE = {
  icon_rsc: 951, icon_resource: 'rat.bgf', flags: 0x000c, rarity: 0,
  light: { flags: 0, intensity: 0, color: 0 }, translation: 0, effect: 0,
  animation: { type: 2, group: null, period: 1200, group_low: 1,
    group_high: 6, group_final: null },
  overlays: [], motion: null,
};

// The real /room-view body for Kermit in Familiars (room 52), trimmed to the objects that
// make each rule visible: four fleet players, an NPC, a stool, and a stack of reagents.
const FAMILIARS = {
  cols: 50, rows: 48,                      // the keeper's default, NOT the room's real size
  room_name: 'Familiars', room_num: 52,
  self: { col: 4, row: 5, degrees: 90, object_id: 4463,
    x: 288, y: 352, angle: 1024, facing_degrees: 90, appearance_revision: 12,
    appearance: SELF_APPEARANCE },
  objects: [
    { id: 4463, col: 4, row: 5, name: 'Kermit', is_self: true, is_player: true,
      can_attack: false, flags: 0x0004, degrees: 90 },
    { id: 4471, col: 7, row: 7, name: 'Camilla', is_self: false, is_player: true,
      can_attack: true, flags: 0x000c, degrees: 180,
      x: 480, y: 480, angle: 2048, facing_degrees: 180, appearance_revision: 21,
      appearance: ENTITY_APPEARANCE },
    { id: 96, col: 8, row: 6, name: 'Paddock', is_self: false, is_player: false,
      can_attack: false, flags: 0x0400, degrees: null },
    { id: 109, col: 7, row: 6, name: 'bar stool', is_self: false, is_player: false,
      can_attack: false, flags: 0x0000, degrees: null },
    { id: 10163, col: 5, row: 5, name: 'elderberry', is_self: false, is_player: false,
      can_attack: false, flags: 0x0010, degrees: null, amount: 26 },
  ],
  target: null,
};
const MAP_ROOM_52 = { num: 52, name: 'Familiars', rows: 11, cols: 11 };
const ROOM_WIRE_52 = {
  resolved_room_num: 52, room_resource_id: 22001, room_security_u32: 0xf1234567,
};
const BOUND_FAMILIARS = { ...FAMILIARS, room_wire: ROOM_WIRE_52 };
const BOUND_MAP_ROOM_52 = {
  ...MAP_ROOM_52, roomRsc: 22001, rooFile: 'familiars.roo',
};

// ---------------------------------------------------------------- the position exists

const view = renderProjection(FAMILIARS, MAP_ROOM_52);
is(view.you.col, 4, 'the character has a column');
is(view.you.row, 5, 'the character has a row');
is(view.you.facing, 'south', '90 degrees is south in this game, not north');
is(view.you.facing_degrees, 90, 'the raw bearing survives alongside the name');
is(view.you.object_id, 4463, 'the renderer can match `you` to the object list by id');
is(view.you.x, 288, 'self fine x survives the keeper boundary');
is(view.you.y, 352, 'self fine y survives the keeper boundary');
is(view.you.angle, 1024, 'self raw world-facing angle survives without reinterpretation');
is(view.you.appearance_revision, 12, 'the one-shot animation trigger token survives');
is(view.you.appearance, SELF_APPEARANCE, 'self base, motion, and ordered overlays survive exactly');
is(view.projection, 'render', 'the projection names itself');

// ---------------------------------------------------------------- room size is the map's

is(view.room.size, { rows: 11, cols: 11 },
  "the .roo's real size wins: the server never reports room dimensions and the keeper " +
  'sends 50x48 for every room, which draws an 11x11 inn as a mostly-void field');
ok(/world map/.test(view.room.size_source), 'and it says the measurement came from the map');

const unmapped = renderProjection(FAMILIARS, null);
is(unmapped.room.size, { rows: 48, cols: 50 },
  'with no map room there is no better answer than the default');
ok(/keeper default/.test(unmapped.room.size_source),
  'but a defaulted size must never look like a measured one');

const boundProjection = renderProjection(BOUND_FAMILIARS, BOUND_MAP_ROOM_52);
is(boundProjection.room_wire, ROOM_WIRE_52,
  'an exact room view/map join carries the complete closed BP_PLAYER provenance');
is(boundProjection.room.resource, 'familiars.roo',
  'the local filename is attached only to that exact resource-id-selected map row');
const wrongBoundMap = renderProjection(BOUND_FAMILIARS,
  { ...BOUND_MAP_ROOM_52, roomRsc: 22002, rooFile: 'wrong.roo' });
is(wrongBoundMap.room_wire, undefined,
  'a different map resource id cannot inherit the live tuple');
is(wrongBoundMap.room.resource, undefined,
  'and its filename is withheld rather than paired with unrelated server provenance');
ok(/withheld/.test(wrongBoundMap.room_binding_note),
  'the failed live-to-map join is explicit');

// ---------------------------------------------------------------- affordances, not buckets

const byId = Object.fromEntries(view.objects.map(o => [o.id, o]));
ok(!byId[4463], 'self is never in its own object list');
ok(byId[4471].can.includes('attack'),
  'a player carrying the attackable bit can be hit — this is the self-defence question');
ok(byId[96].can.includes('buy'),
  'a merchant is buyable-from, which is how a renderer draws a shop rather than a mob');
is(byId[109].can, ['look'],
  'a bar stool affords looking and nothing else — the bucket a renderer must be able to ' +
  'tell a mummy apart from');
ok(byId[10163].can.includes('get'), 'reagents on the floor can be picked up');
is(byId[10163].amount, 26, 'a quantity is carried, because a stack is not one item');
is(byId[4471].is_player, true, 'players stay flagged as players');
is(byId[96].is_player, false, 'an NPC merchant is not a player — OF.PLAYER is 0x0004');
is(byId[4471].x, 480, 'entity fine x survives');
is(byId[4471].y, 480, 'entity fine y survives');
is(byId[4471].angle, 2048, 'entity raw angle survives');
is(byId[4471].facing_degrees, 180, 'entity renderer-facing degrees survive');
is(byId[4471].appearance_revision, 21, 'entity animation revision survives');
is(byId[4471].appearance, ENTITY_APPEARANCE, 'entity appearance survives without a second parser');

// ---------------------------------------------------------------- nearest first

is(view.objects.map(o => o.id), [10163, 109, 4471, 96],
  'nearest first, so a truncating consumer truncates the far things');
is(byId[10163].distance, 1, 'one square east is distance 1');
is(byId[4471].distance, 4, 'diagonals are straight-line, not eight-way steps');

// ---------------------------------------------------------------- an older keeper

const { flags: _f, ...noFlagWord } = FAMILIARS.objects[1];
const older = renderProjection(
  { ...FAMILIARS, objects: [FAMILIARS.objects[0], { ...noFlagWord }] }, MAP_ROOM_52);
is(older.objects[0].can, ['attack', 'look'],
  'without the flag word, say what the two booleans support and NOT one bit more — an ' +
  'invented affordance claims the server will accept something it will refuse');
ok(/older keeper/.test(older.objects[0].affordances_source),
  'and mark it, so a guess is never mistaken for the flag word');

// ---------------------------------------------------------------- the honest silences

const dead = renderProjection({ ...FAMILIARS, self: null }, MAP_ROOM_52);
ok(dead.you.note, 'a character with no square gets a reason, not a fabricated one');
is(dead.you.col, undefined, 'and no coordinates at all');
is(dead.objects.length, 4, 'the room is still drawn while its occupant is missing');
is(dead.objects.every(o => o.distance === null), true,
  'distance from nowhere is null rather than zero');

for (const absent of [null, undefined, { error: 'no room data' }]) {
  const gone = renderProjection(absent, MAP_ROOM_52);
  ok(gone.render_note, 'an unavailable room view says so');
  is('room' in gone, false,
    'and publishes NO room key: the broker folds this over the keeper state, which does ' +
    'know the room, and a null here would overwrite a true answer with a false one');
  is('you' in gone, false, 'same argument for the position');
  is(gone.objects, [], 'an empty list is safe; a wrong room is not');
}

// ---------------------------------------------------------------- exits are refused loudly

is(view.exits, [], 'exits need a World, which lives in the keeper process');
ok(/keeper process/.test(view.topology_note),
  'and a renderer that asked for exits is TOLD why it got none, because quietly getting ' +
  'none is the exact failure this projection was written to undo');

// ---------------------------------------------------------------- junk in, no crash out

is(renderProjection({ ...FAMILIARS, objects: 'not a list' }, MAP_ROOM_52).objects, [],
  'a malformed object list is empty, not a throw inside a frame loop');
is(renderProjection({ ...FAMILIARS,
  objects: [{ id: 1, name: 'nowhere', col: null, row: 3 }] }, MAP_ROOM_52).objects, [],
  'an object with no square cannot be drawn and is dropped rather than placed at 0,0');

// ---------------------------------------------------------------- the composed view
//
// `keeperView` is what `look` returns on a keeper-backed broker: the keeper's /state with the
// render projection over it. It has gone wrong twice, in opposite directions, and both cost a
// fleet — so the shape `arrivalReport` (m59-game.mjs) reads is pinned field by field.

const STATE = {
  agent: 't1', character: 'Kermit', in_game: true,
  room: { name: 'Familiars', num: 52 },
  hp: { value: 33, max: 33 }, mana: { value: 21, max: 21 }, vigor: { value: 111, max: 200 },
  pack: ['elderberry (x24)'], as_of_ms: 812,
};
const mapFor = num => (num === 52 ? MAP_ROOM_52 : null);

const composed = keeperView(STATE, FAMILIARS, mapFor);
is(composed.you.col, 4, 'the position survives the composition');
is(composed.objects.length, 4, 'so do the room contents');
is(composed.you.appearance, SELF_APPEARANCE,
  'keeperView carries self appearance from the reconciled room-view clock');
is(composed.objects.find(o => o.id === 4471)?.appearance, ENTITY_APPEARANCE,
  'keeperView carries entity appearance from that same clock');
is(composed.room.name, 'Familiars', 'and the room');
is(composed.room.size, { rows: 11, cols: 11 }, "with the map's size, not the keeper default");
is(composed.character, 'Kermit', 'the state underneath is not lost');
is(composed.vitals, { health: { value: 33, max: 33 }, mana: { value: 21, max: 21 },
                      vigor: { value: 111, max: 200 } },
  'vitals are reshaped into the shape a real World.snapshot() returns, because that is what ' +
  'arrivalReport reads');
is(Array.isArray(composed.exits), true,
  'exits is ALWAYS an array — arrivalReport reads `v.exits.length` with no guard');
is(composed.scenery.total, 0, 'and scenery.total is always a number for the same reason');
ok(/room view/.test(composed.source), 'the composed answer says both halves were used');

const BOUND_STATE = { ...STATE, room_wire: ROOM_WIRE_52 };
const boundComposed = keeperView(BOUND_STATE, BOUND_FAMILIARS,
  num => (num === 52 ? BOUND_MAP_ROOM_52 : null));
is(boundComposed.room_wire, ROOM_WIRE_52,
  'state and room-view tuples are published only after exact reconciliation');
is(boundComposed.room.resource, 'familiars.roo',
  'the reconciled look carries the filename from the matching map row');
is(boundComposed.room_binding_note, undefined,
  'a complete exact binding needs no warning');

const changedSecurity = keeperView(
  { ...BOUND_STATE, room_wire: { ...ROOM_WIRE_52, room_security_u32: 0xf1234568 } },
  BOUND_FAMILIARS, num => (num === 52 ? BOUND_MAP_ROOM_52 : null));
is(changedSecurity.you.col, 4,
  'a provenance mismatch does not break the still-valid legacy room view');
is(changedSecurity.you.appearance, SELF_APPEARANCE,
  'legacy render state remains available while strict bound provenance is withheld');
is(changedSecurity.room_wire, undefined,
  'but a tuple sampled from only one cache is never published');
is(changedSecurity.room.resource, undefined,
  'the bound local filename is withheld with the mismatched tuple');
ok(/different room_wire/.test(changedSecurity.room_binding_note),
  'the exact-cache disagreement is reported rather than silently resolved');

// EVERY FIELD arrivalReport TOUCHES, exercised the way it touches them. This is the
// regression that killed twenty-one of twenty-one travels: an async view() made `v.objects`
// a promise property, and `.filter` threw.
const has = (o, verb) => Array.isArray(o.can) && o.can.includes(verb);
is(composed.objects.filter(o => has(o, 'attack') && !o.is_player).length, 0,
  'nothing attackable that is not a player, in an inn');
is(composed.objects.filter(o => o.is_player).length, 1, 'one other fleet member');
is(composed.objects.filter(o => has(o, 'get')).length, 1, 'one thing on the floor');
is(composed.objects.filter(o => has(o, 'buy')).length, 1, 'one merchant');
is(composed.exits.length, 0, 'the exits array is empty rather than absent, so nothing throws');

// AND THE EMPTY ARRAY HAS TO SAY IT IS AN ABSENCE. This assertion used to stop at "reads as
// zero rather than throwing" — which was the worry at the time, and blessed the zero.
// `arrivalReport` read `v.exits.length` with no guard, so every keeper-backed arrival report
// said the room had no exits; West Jasper declares thirty-five. An instrument that cannot
// produce the value which would show the problem must say so, not answer 0.
is(composed.exits_unknown, true,
  'the projection FLAGS that it has no World to ask, so no reader can turn empty into a count');
is(/m59-exits\.mjs/.test(composed.exits_note ?? ''), true,
  'and the note names an instrument that CAN answer, rather than only apologising');

// THE READER THAT TURNS IT INTO A SCALAR, PINNED STRUCTURALLY RATHER THAN BY IMPORT.
//
// `arrivalReport` lives in m59-game.mjs, and importing that module here would make this suite
// depend on whatever is in the shared checkout — it currently imports an untracked file, so a
// clean clone cannot load it at all. Matching the CALL in the source is the honest compromise:
// it cannot prove the behaviour, and it does prove the guard has not been deleted. Match the
// code, never the prose: every comment line is stripped first, because an assertion that
// matched a comment explaining a removal has passed for the wrong reason in this repository
// twice.
{
  const src = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8')
    .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  is(/exits: v\.exits_unknown \? null : v\.exits\.length/.test(src), true,
    'arrivalReport reports null, not a zero it never measured');
  is(/exits_note/.test(src), true, 'and carries the note that says where to ask instead');
}

// ---------------------------------------------------------------- two clocks disagreeing

// The state has moved on and the room view has not. This is the ordinary case one hop after
// a `travel`, and the wrong answer here is not "no position" — it is a CONFIDENT position in
// a room the character has left, handed to an arrival report.
const moved = keeperView({ ...STATE, room: { name: 'Cor Noth', num: 150 } }, FAMILIARS, mapFor);
is(moved.you, null, 'position and appearance from the room we have left are withheld together');
is(moved.objects, [], 'and so are its contents');
is(moved.room, { num: 150, name: 'Cor Noth' },
  'the room comes from the state, which is the half that knows we moved');
ok(/room 52/.test(moved.stale_render) && /in 150/.test(moved.stale_render),
  'and the disagreement is REPORTED, naming both rooms, rather than resolved in silence');

// An older keeper sends no room number at all. Withholding on that would withhold always.
const noRoomNum = keeperView(STATE, { ...FAMILIARS, room_num: null }, mapFor);
is(noRoomNum.you.col, 4, 'a room view that cannot name its room is trusted, not discarded');
is(noRoomNum.stale_render, undefined, 'and nothing is reported, because nothing disagreed');

// ---------------------------------------------------------------- nothing in hand

for (const absent of [null, undefined, { error: 'no room data' }]) {
  const bare = keeperView(STATE, absent, mapFor);
  is(bare.room, { num: 52, name: 'Familiars' },
    'with no room view the state still knows the room — this is the null that used to ' +
    'overwrite it');
  is(bare.you, null, 'and honestly has no position');
  is(bare.objects, [], 'an empty array, never undefined');
  is(bare.exits, [], 'same');
  is(bare.stale_render, undefined, 'an absent room view is not a stale one');
}

const nothing = keeperView(null, null, mapFor);
is(nothing.room, null, 'no state and no room view is a shape, not a throw');
is(nothing.objects, [], 'still an array');
is(nothing.vitals, { health: null, mana: null, vigor: null }, 'still the vitals shape');

console.log(`m59-render-test: ${checks} assertions passed`);
