// Offline. The desk-or-walk decision of m59-desk-travel.mjs on the real map, with no transit evidence (every
// crossing priced at the 20 s fallback). Station 2 (Outside Castle Victoria), guild hall 714 (opens onto North
// Barloque 101). Operator's example, 2026-10-20: "'Get to Tos' can mean 'rescue to barloque and walk to Tos, if
// the ETA is quicker'" -- from Ukgoth it is NOT quicker for Tos and IS for Barloque, and both are pinned here.
import assert from 'node:assert/strict';
import { loadMap } from './m59-map.mjs';
import { chooseDeskRide, deskRideFirst } from './m59-desk-travel.mjs';

const map = loadMap();
const base = { map, from: 599, station: 2, guildHall: 714, homeRoom: 202 };
let n = 0;
const ok = async (what, fn) => { await fn(); n++; console.log(`  ok   ${what}`); };

await ok('Ukgoth to North Barloque rides the desk and lands in the guild hall', () => {
  const d = chooseDeskRide({ ...base, to: 101 });
  assert.equal(d.ride, true, d.why);
  assert.equal(d.landing, 714);
  assert.equal(d.approach_hops, 1);
  assert.ok(d.saves_ms >= 60_000, `saves ${d.saves_ms}`);
  assert.deepEqual(d.plan.legs.map(l => l.kind), ['walk', 'desk', 'walk']);
});
await ok('Ukgoth to Tos walks: the hall is further from Tos than Ukgoth is', () => {
  const d = chooseDeskRide({ ...base, to: 50 });
  assert.equal(d.ride, false);
  assert.ok(d.best.legs.every(l => l.kind === 'walk'));
});
await ok('a confinement that does not hold the station and landing never rides', () => {
  assert.equal(chooseDeskRide({ ...base, to: 101, confine: [599, 101] }).ride, false);
});
await ok('a blocked landing never rides', () => {
  assert.equal(chooseDeskRide({ ...base, to: 101, blocked: [714] }).ride, false);
});
await ok('riders queued at the desk are priced in, and a long queue walks', () => {
  const d = chooseDeskRide({ ...base, to: 101, queued: 3 });
  assert.equal(d.ride, false, 'four serves cost more than the walk');
});
await ok('a near tie walks (margin)', () => {
  const d = chooseDeskRide({ ...base, to: 101, marginMs: 10 * 60_000 });
  assert.equal(d.ride, false);
  assert.match(d.why, /margin/);
});
await ok('a station further than the approach limit is not walked to', () => {
  const d = chooseDeskRide({ ...base, to: 101, maxApproachHops: 0 });
  assert.equal(d.ride, false);
  assert.match(d.why, /rooms away/);
});
await ok("the unit's own Rescue, landing in the hall directly, beats walking to the desk", () => {
  const d = chooseDeskRide({ ...base, to: 101, own: [{ kind: 'spell', uses: 1 }] });
  assert.equal(d.ride, false);
  assert.ok(d.best.legs.some(l => l.kind === 'spell'));
});
await ok('already there is not a journey', () => {
  assert.equal(chooseDeskRide({ ...base, to: 599 }).ride, false);
});
await ok('no station configured is silence', () => {
  assert.equal(chooseDeskRide({ ...base, to: 101, station: null }).ride, false);
});
await ok('a guildless rider lands at home, and the plan is priced from there', () => {
  const d = chooseDeskRide({ ...base, guildHall: null, homeRoom: 101, to: 102 });
  assert.equal(d.ride, true, d.why);
  assert.equal(d.landing, 101);
});
await ok('keeper glue: no desk policy is silence, and nothing is asked of the desk', async () => {
  let asked = false;
  const ap = { s: { live: true, name: 'x', credentials: { character: 'Nobody' }, world: { map, room: { num: 599 } },
                    client: { spells: [], rsc: { get: () => '' } } },
               refreshChaliceConfig: () => { asked = true; return null; }, chaliceCfg: null };
  const r = await deskRideFirst(ap, 101, {});
  assert.equal(r, null);
  assert.equal(asked, false);
});
console.log(`\n${n} passed, 0 failed`);
