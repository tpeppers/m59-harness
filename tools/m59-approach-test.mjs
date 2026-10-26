import { readToolSource } from './autopilot/source.mjs';
// Offline guard for THE STATION'S APPROACH (policy.approachRooms, a strategy's `confine.approach`,
// Autopilot.approachLegs and the leg loop at the top of Autopilot.travel). Opens no socket.
//
//   node tools/m59-approach-test.mjs
//
// Operator, 2026-10-11: the lupogg strategy must "work going from outside and ... include going to the
// sewers, *always going* through via valley of ileria -> sandy shores -> ocean -> sewers" -- on the map
// 544 -> 552 -> 562 -> 108. Pinned: the legs from outside, the resume from a room on the road, nothing
// once inside the confinement or for a destination that is not the station's, the legs exempt from the
// confinement gate and only they, and the real map edges the road is made of.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Autopilot } from './m59-autopilot.mjs';
import { STRATEGY_FIELDS, validateStrategy } from './m59-strategy-schema.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };
const ROAD = [544, 552, 562, 108];
const keeper = (extra = {}) => {
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { assignedRoom: 112, confineRooms: [108, 111, 112], approachRooms: ROAD, ...extra };
  ap.s = { world: { room: { num: 201 } } };
  return ap;
};

await ok('from Marion (201): the whole road, then the station', () => {
  assert.deepEqual(keeper().approachLegs(112, 201), ROAD);
});

await ok('from a room on the road: only what is left of it', () => {
  assert.deepEqual(keeper().approachLegs(112, 544), [552, 562, 108]);
  assert.deepEqual(keeper().approachLegs(112, 562), [108]);
});

await ok('inside the confinement, or at the road\'s last room: no approach', () => {
  assert.equal(keeper().approachLegs(112, 108), null);
  assert.equal(keeper().approachLegs(112, 111), null);
  assert.equal(keeper().approachLegs(111, 112), null);
});

await ok('a journey that is not to the station or a confined room is not the approach\'s business', () => {
  assert.equal(keeper().approachLegs(202, 201), null);
  assert.equal(keeper({ approachRooms: null }).approachLegs(112, 201), null, 'silence is the router\'s own road');
});

await ok('a confined room as destination also takes the road (a relocation to 111 from outside)', () => {
  assert.deepEqual(keeper().approachLegs(111, 201), ROAD);
});

await ok('travel walks the legs first, each flagged, and only the legs are exempt from the confinement', () => {
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const t = src.slice(src.indexOf('  async travel(room, opts) {'));
  assert.ok(/approachLeg = false, \.\.\.sessionOpts \} = opts \?\? \{\};/.test(t.slice(0, 600)), 'approachLeg is not passed to the session');
  assert.ok(t.indexOf('const legs = this.approachLegs?.(room);') < t.indexOf('refused to leave the confinement'));
  assert.ok(t.includes("const r = await this.travel(leg, { ...(opts ?? {}), origin: opts?.origin ?? keeperOrigin('station_approach'), approachLeg: true });"));
  assert.ok(t.includes("const approachRoom = approachLeg && (this.policy?.approachRooms ?? []).map(Number).includes(Number(room));"));
  assert.ok(t.includes('&& !approachRoom) {'));
});

await ok('the road is real: 544 north -> 552, 552 east -> 562, 562 east -> 108 (m59-map.json edgeExits)', () => {
  const map = JSON.parse(readToolSource(new URL('../substrate/m59-map.json', import.meta.url), 'utf8'));
  const rooms = map.rooms ?? map;
  const edge = (a, b) => (rooms[a]?.edgeExits ?? []).some(e => Number(e.to) === b);
  for (let i = 0; i + 1 < ROAD.length; i++) assert.ok(edge(ROAD[i], ROAD[i + 1]), `${ROAD[i]} -> ${ROAD[i + 1]}`);
});

await ok('strategy field, broker argument, and qor-lupogg-sewers declares the road', async () => {
  const f = STRATEGY_FIELDS.find(x => x.path === 'confine.approach');
  assert.equal(f?.faculty, 'movement');
  assert.equal(f?.arg, 'approach_rooms');
  assert.deepEqual(f.normalize(['544', 552]), [544, 552]);
  assert.throws(() => f.normalize([]));
  const mod = await import('../substrate/farm-strategies.example/qor-lupogg-sewers.mjs');
  assert.deepEqual(mod.default.confine.approach, ROAD);
  const v = validateStrategy(mod.default, { file: 'qor-lupogg-sewers.mjs' });
  assert.ok(v.ok !== false && !(v.problems?.length), JSON.stringify(v).slice(0, 300));
  const broker = readToolSource(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  assert.ok(broker.includes("p.policy.approachRooms = farmStrategyField('confine.approach').normalize(a.approach_rooms ?? null);"));
});

console.log(`\n${n} passed`);
