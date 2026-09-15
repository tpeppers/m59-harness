import assert from 'node:assert/strict';
import { groundEffect, groundEffects, groundEffectSquares, groundEffectOnSegment, effectsAt } from './m59-ground-effects.mjs';
import { World } from './m59-world.mjs';
import { renderProjection } from './m59-render-projection.mjs';
import { OF } from './m59-parse.mjs';

const names = new Map([[1, 'wall of fire'], [2, 'wall of lightning'], [3, 'thick fog'], [4, 'web'], [5, 'patch of bramble']]);
const c = { rsc: names, selfId: 100, self: { row: 2, col: 2 },
  room: { id: 1000, objects: new Map() }, vitals: () => ({}), inventory: [] };
const add = (id, row, col, flags = OF.NOEXAMINE | 3) => c.room.objects.set(id, { id, nameRsc: id, row, col, flags });
add(1, 30, 61); add(2, 30, 62); add(3, 20, 30); add(4, 8, 12); add(5, 10, 10, OF.ATTACKABLE);
assert.deepEqual(groundEffects(c).map(e => e.kind), ['firewall', 'lightning_wall', 'poison_or_spore_cloud', 'web', 'brambles']);
assert.equal(groundEffects(c)[2].radius, null);
assert.equal(groundEffects(c)[2].avoid_radius, 3);
assert.equal(groundEffects(c)[3].periodic, false);
assert.equal(groundEffect({ name: 'wall of fire', row: 1, col: 2, flags: OF.PLAYER }), null);
assert.equal(groundEffect({ name: 'firewall scroll', row: 1, col: 2, flags: OF.GETTABLE }), null);
assert.equal(groundEffect({ name: 'thick fog', row: 1, col: 2, flags: OF.NOEXAMINE }).harmful, null);
assert.equal(groundEffect({ name: 'mystery', row: 1, col: 2, flags: OF.NOEXAMINE | 3 }).certainty, 'unknown');
assert.equal(groundEffectSquares(c).has('30,61'), true);
assert.equal(groundEffectSquares(c).has('61,30'), false);
assert.equal(effectsAt(c, { row: 20, col: 33 }).length, 1);
assert.equal(effectsAt(c, { row: 20, col: 34 }).length, 0);
assert.equal(groundEffectOnSegment(c, { row: 30, col: 60 }, { row: 30, col: 63 }).kind, 'firewall');
assert.equal(groundEffectOnSegment(c, { row: 29, col: 60 }, { row: 29, col: 63 }), null);
assert.equal(groundEffectOnSegment(c, { row: 30, col: 61 }, { row: 29, col: 61 }), null, 'may leave a hazard');
assert.equal(groundEffectOnSegment(c, { row: 30, col: 61 }, { row: 30, col: 62 }).kind, 'lightning_wall', 'may not escape into another effect');
assert.equal(groundEffectOnSegment(c, { row: 20, col: 30 }, { row: 20, col: 31 }), null, 'may move outward through a spore area');
assert.ok(groundEffectOnSegment(c, { row: 20, col: 32 }, { row: 20, col: 31 }), 'may not approach the spore center');
const w = new World(c, { rooms: {} });
assert.equal(w.objects().find(o => o.id === 1).ground_effect.kind, 'firewall');
assert.equal(w.perception().ground_effects.length, 5);
const rv = { objects: [], ground_effects: groundEffects(c), room_num: 38 };
assert.equal(renderProjection(rv).ground_effects.length, 5);
c.room.objects.delete(1);
assert.equal(groundEffectSquares(c).has('30,61'), false, 'REMOVE expires hazards without an invented timer');
c.room.objects.clear();
assert.deepEqual(groundEffects(c), [], 'room reset clears hazards');
console.log('PASS ground effects: flags, ambiguity, spore extent, escape, segment crossing, lifecycle and projections');

const plate = { id: 10, name: 'something', icon_file: 'blank.bgf', flags: OF.NOEXAMINE | 3, row: 4, col: 28 };
const hall = { roomFile: 'guildh14.roo' };
assert.equal(groundEffect(plate, () => null, hall).avoid, false);
assert.equal(groundEffect({ ...plate, icon_file: undefined, iconRsc: 21598 },
  id => id === 21598 ? 'blank.bgf' : null, hall).avoid, false, 'uses the real parsed iconRsc field');
assert.equal(groundEffect(plate).avoid, true, 'unknown room does not exempt blank triggers');
assert.equal(groundEffect({ ...plate, col: 26 }, () => null, hall).avoid, true);
assert.equal(groundEffect({ ...plate, name: 'wall of fire' }, () => null, hall).avoid, true);
assert.equal(groundEffect({ ...plate, icon_file: 'poisoncl.bgf' }, () => null, hall).avoid, true);
const plates = { roomRsc: 20, rsc: new Map([[20, 'guildh14.roo']]),
  room: { objects: new Map([[10, plate]]) } };
assert.equal(groundEffectOnSegment(plates, { row: 3, col: 28 }, { row: 5, col: 28 }), null);
assert.equal(groundEffectSquares(plates).size, 0);
plates.room.objects.set(11, { ...plate, id: 11, name: 'wall of lightning' });
assert.equal(groundEffectOnSegment(plates, { row: 3, col: 28 }, { row: 5, col: 28 }).kind, 'lightning_wall');
console.log('PASS guild entry triggers: room-bound exception preserves harmful and unknown effects');
