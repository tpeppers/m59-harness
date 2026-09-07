import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Autopilot, HANDLED } from './m59-autopilot.mjs';

// Execute the keeper's actual dispatch cases with an offline Autopilot. This catches
// authority being written to the dormant broker shell, or a mismatched wire field.
const source = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
const start = source.indexOf("case 'autopilot_claim':");
const end = source.indexOf('// WHO IS ACTUALLY STANDING HERE', start);
assert.ok(start > 0 && end > start);
const dispatch = new Function('name', 'args', 'autopilot', 'json',
  `switch (name) { ${source.slice(start, end)} }`);
const keeper = Object.assign(Object.create(Autopilot.prototype), {
  running: true, claims: new Map(), policy: {},
  s: { cancelMovement: () => ({ cancelled: true }) },
  note() {}, progress() {},
});
let result;
const call = (name, args) => { dispatch(name, args, keeper, x => { result = x; }); return result; };
assert.deepEqual(call('autopilot_claim', { by: 'director', faculties: ['work', 'mortality'],
  lease_ms: 120000 }).granted, ['work']);
assert.ok(keeper.claims.get('work').until - Date.now() > 110000);
assert.ok(call('autopilot_busy', { by: 'director', kind: 'town', lease_ms: 300000 }).busy);
assert.equal(await keeper.passOutside({}), HANDLED, 'the socket owner stands down for a town job');
keeper.suspendedJourney = { to: 114 };
let resumed = 0;
keeper.resumeSuspendedJourney = async () => { resumed++; return HANDLED; };
assert.equal(await keeper.passOutside({}), HANDLED);
assert.equal(resumed, 1, 'a busy owner still gets its interrupted destination resumed');
assert.deepEqual(call('autopilot_heartbeat', { by: 'director', lease_ms: 120000 }).renewed, ['work']);
assert.equal(call('autopilot_free', { by: 'stranger' }).refused, 'director owns it');
assert.equal(call('autopilot_free', { by: 'director' }).busy, null);
assert.deepEqual(call('autopilot_yield', { by: 'director' }).released, ['work']);
call('commander_claim', { by: 'rts', faculties: ['work'], leaseMs: 120000 });
assert.ok(keeper.claims.get('work').until - Date.now() <= 30000, 'RTS keeps its shorter lease');
const broker = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
assert.match(broker, /s instanceof KeeperProxy && \['claim', 'heartbeat', 'yield', 'busy', 'free'\][\s\S]{0,200}keeperAction/);
assert.match(broker, /committed: s instanceof KeeperProxy \? st\?\.committed/,
  'the fleet board reports the actual socket owner commitment');
console.log('keeper authority dispatch and busy gate regressions passed');
