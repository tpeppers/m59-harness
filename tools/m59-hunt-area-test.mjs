// Offline guard for THE HUNT AREA (policy.huntArea, a strategy's `huntArea`, Autopilot.huntAreaHere and the
// quarry filter / walk-back in Autopilot.passFarm). Opens no socket.
//
//   node tools/m59-hunt-area-test.mjs
//
// Operator, 2026-10-16, bastion-defense mode: "everyone with positive karma farm and guard the door, staying in
// line-of-sight of the door". Farm mode chased Castle Victoria's skeletons to the far side of the room within
// seconds, so the area is a list of squares: in its room only quarry standing on one is chosen, and an idle
// farmer walks back onto it. Pinned: the schema's normal form and refusals; the area applies only in its own
// room; the set follows a policy change; the nearest square is the nearest; and passFarm filters before it
// ranks and walks back before it holds a wall elsewhere.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Autopilot } from './m59-autopilot.mjs';
import { STRATEGY_FIELDS, validateStrategy, normHuntArea } from './m59-strategy-schema.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };
const AUTOPILOT = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');

await ok('the schema names huntArea as a work field a strategy may set', () => {
  const f = STRATEGY_FIELDS.find(x => x.path === 'huntArea');
  assert.ok(f && f.keys.includes('huntArea') && f.faculty === 'work' && f.arg === 'hunt_area');
});
await ok('normal form: [row, col] and { row, col } both accepted, duplicates dropped', () => {
  assert.deepEqual(normHuntArea({ room: 38, squares: [[7, 14], { row: 7, col: 14 }, { row: 8, col: 15 }] }),
    { room: 38, squares: [[7, 14], [8, 15]] });
  assert.equal(normHuntArea(null), null);
});
await ok('refusals: no room, room 1, empty, fractional or negative squares', () => {
  for (const bad of [{}, { room: 1, squares: [[1, 1]] }, { room: 38, squares: [] }, { room: 38, squares: [[1.5, 2]] },
    { room: 38, squares: [[-1, 2]] }, { room: 38, squares: 'all' }, [38]])
    assert.throws(() => normHuntArea(bad), /huntArea/);
});
await ok('a strategy file carrying huntArea validates', () => {
  const r = validateStrategy({ name: 'door', huntArea: { room: 38, squares: [[7, 14]] } });
  assert.ok(!r?.problems?.length, JSON.stringify(r?.problems));
});

function keeper(area) { const ap = Object.create(Autopilot.prototype); ap.policy = { huntArea: area }; return ap; }
await ok('the area applies only in its own room; no area means the whole room', () => {
  const ap = keeper({ room: 38, squares: [[7, 14], [8, 15]] });
  assert.ok(ap.huntAreaHere(38).has('7,14') && ap.huntAreaHere(38).has('8,15') && !ap.huntAreaHere(38).has('9,9'));
  assert.equal(ap.huntAreaHere(39), null);
  assert.equal(keeper(null).huntAreaHere(38), null);
});
await ok('a new policy object rebuilds the set', () => {
  const ap = keeper({ room: 38, squares: [[7, 14]] });
  assert.ok(ap.huntAreaHere(38).has('7,14'));
  ap.policy = { huntArea: { room: 38, squares: [[9, 9]] } };
  assert.ok(ap.huntAreaHere(38).has('9,9') && !ap.huntAreaHere(38).has('7,14'));
});
await ok('the nearest area square is the nearest', () => {
  const ap = keeper({ room: 38, squares: [[7, 14], [12, 20], [14, 16]] });
  assert.deepEqual(ap.nearestHuntAreaSquare(ap.huntAreaHere(38), { row: 14, col: 10 }), { row: 14, col: 16 });
});
await ok('the walk-back skips squares another body holds', () => {
  const ap = keeper({ room: 38, squares: [[14, 16], [14, 18], [7, 14]] });
  assert.deepEqual(ap.nearestHuntAreaSquare(ap.huntAreaHere(38), { row: 14, col: 10 }, new Set(['14,16'])), { row: 14, col: 18 });
  assert.equal(ap.nearestHuntAreaSquare(ap.huntAreaHere(38), { row: 14, col: 10 }, new Set(['14,16', '14,18', '7,14'])), null);
});
await ok('passFarm: the area filter runs after the avoid filter and before ranking; the walk-back before the vigil', () => {
  const i = AUTOPILOT.indexOf('  async passFarm(ctx) {');
  const body = AUTOPILOT.slice(i, AUTOPILOT.indexOf('\n  async ', i + 30));
  const at = s => body.indexOf(s);
  assert.ok(at('const huntArea = this.huntAreaHere(room?.num)') > at('const avoidPrey = this.preyAvoid('));
  assert.ok(at('const huntArea = this.huntAreaHere(room?.num)') < at('found = rankQuarries('));
  assert.ok(at('OUTSIDE THE HUNT AREA WITH NOTHING TO DO') > 0
    && at('OUTSIDE THE HUNT AREA WITH NOTHING TO DO') < at('HOLDING A WALL IN A ROOM THAT SPAWNS IS WORK'));
});

console.log(`\n${n} passed`);
