// Offline guard for PULLING THROUGH A CROWD (policy.pullThroughCrowd, a strategy's `pull.throughCrowd`,
// Autopilot.closestPullable and the crowd gate in Autopilot.pull). Opens no socket.
//
//   node tools/m59-pull-crowd-test.mjs
//
// Operator, 2026-10-12, of two Qor casters holding walls in room 112 with 21 lupoggs and every pull refused:
// "Let strategies always pull through a crowd, but have them just always prefer the closest target out of
// the crowd that fits the criteria". Pinned: the closest by WALKING steps wins, not by straight line; spared,
// unhunted and players never qualify; the gate still refuses without the flag; the flee-line refusal is
// untouched; and the lupogg strategy sets it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OF } from './m59-parse.mjs';
import { Autopilot } from './m59-autopilot.mjs';
import { STRATEGY_FIELDS, validateStrategy } from './m59-strategy-schema.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };
const AUTOPILOT = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');

const NAMES = { 1: 'lupogg', 2: 'giant rat', 3: 'Morpheus' };
// Us at r10c10 on the wall. `steps` is what approachSquare answers for each body: the walking distance,
// which a pillar can make longer than the straight line.
function keeper(bodies, { spare = ['giant rat'], hunt = ['lupogg'] } = {}) {
  const objects = new Map(bodies.map(b => [b.id, { id: b.id, nameRsc: b.rsc, row: b.row, col: b.col,
    flags: b.rsc === 3 ? (OF.PLAYER | OF.ATTACKABLE) : OF.ATTACKABLE }]));
  const steps = new Map(bodies.map(b => [`${b.col},${b.row}`, b.steps]));
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { hunt, spareCreatures: spare };
  ap.threatCeiling = () => 200;
  ap.s = { client: { selfId: 99, self: { row: 10, col: 10 }, rsc: { get: k => NAMES[k] ?? '' }, room: { objects } },
           world: { approachSquare: (col, row) => (steps.get(`${col},${row}`) == null ? null : { steps: steps.get(`${col},${row}`), col, row }) } };
  return ap;
}

await ok('the closest by WALKING steps wins, not by straight line', () => {
  const ap = keeper([
    { id: 10, rsc: 1, row: 10, col: 12, steps: 9 },   // two squares away, behind a pillar
    { id: 11, rsc: 1, row: 10, col: 15, steps: 5 },
    { id: 12, rsc: 1, row: 10, col: 20, steps: 10 },
  ]);
  assert.equal(ap.closestPullable()?.id, 11);
});

await ok('a spared rat, a player and an unreachable lupogg never qualify', () => {
  const ap = keeper([
    { id: 20, rsc: 2, row: 10, col: 11, steps: 1 },
    { id: 21, rsc: 3, row: 10, col: 11, steps: 1 },
    { id: 22, rsc: 1, row: 11, col: 10, steps: null },
    { id: 23, rsc: 1, row: 10, col: 16, steps: 7 },
  ]);
  assert.equal(ap.closestPullable()?.id, 23);
});

await ok('nothing qualifies -> null, and the pull keeps the target it was given', () => {
  assert.equal(keeper([{ id: 30, rsc: 2, row: 10, col: 11, steps: 1 }]).closestPullable(), null);
});

await ok('the one already started on wins over a closer one, while it is in the room and reachable', () => {
  const ap = keeper([
    { id: 40, rsc: 1, row: 10, col: 12, steps: 2 },
    { id: 41, rsc: 1, row: 10, col: 20, steps: 11 },
  ]);
  const pick = ap.closestPullable({ preferId: 41 });
  assert.equal(pick?.id, 41);
  assert.equal(pick?.focus, true);
});

await ok('the focus gone, unreachable or no longer qualifying -> back to the closest', () => {
  const bodies = [{ id: 50, rsc: 1, row: 10, col: 12, steps: 2 }, { id: 51, rsc: 1, row: 11, col: 10, steps: null },
                  { id: 52, rsc: 2, row: 10, col: 11, steps: 1 }];
  const ap = keeper(bodies);
  assert.equal(ap.closestPullable({ preferId: 99 })?.id, 50, 'not in the room');
  assert.equal(ap.closestPullable({ preferId: 51 })?.id, 50, 'cannot be reached');
  assert.equal(ap.closestPullable({ preferId: 52 })?.id, 50, 'a spared rat is never the focus');
  assert.equal(ap.closestPullable({ preferId: 50 })?.focus, true);
});

await ok('pullFocusId: the body last pulled, only in the room it was pulled in, forgotten once it is gone', () => {
  const ap = keeper([{ id: 60, rsc: 1, row: 10, col: 12, steps: 2 }]);
  ap.s.world.room = { num: 112 };
  ap._pullFocus = { id: 60, room: 112, at: Date.now() };
  assert.equal(ap.pullFocusId(), 60);
  ap.s.world.room = { num: 111 };
  assert.equal(ap.pullFocusId(), null, 'another room');
  ap.s.world.room = { num: 112 };
  ap._pullFocus = { id: 61, room: 112, at: Date.now() };
  assert.equal(ap.pullFocusId(), null, 'dead or gone');
  assert.equal(ap._pullFocus, null);
  const p = AUTOPILOT.slice(AUTOPILOT.indexOf('  async pull(want) {'));
  assert.ok(p.includes('this._pullFocus = { id: foe.id, room: s.world?.room?.num ?? null, at: Date.now() };'), 'set at the swing');
  assert.ok(p.includes('const pick = this.closestPullable({ preferId: this.pullFocusId() });'));
});

await ok('the gate: refuses in a crowd unless pullThroughCrowd, and only then re-picks', () => {
  const p = AUTOPILOT.slice(AUTOPILOT.indexOf('  async pull(want) {'));
  const body = p.slice(0, p.indexOf('\n  closestPullable() {'));
  assert.ok(body.includes("const throughCrowd = crowd && this.policy?.pullThroughCrowd === true;"));
  assert.ok(body.includes("if (!buddyCrowdOk && crowd && !throughCrowd) {"));
  assert.ok(body.indexOf('const pick = this.closestPullable(') < body.indexOf('below the flee line'),
    're-picked before the flee-line check, which still runs on every pull');
  assert.ok(body.includes('below the flee line'));
});

await ok('the field, the argument, and qor-lupogg-sewers declares it', async () => {
  const f = STRATEGY_FIELDS.find(x => x.path === 'pull.throughCrowd');
  assert.equal(f?.arg, 'pull_through_crowd');
  assert.deepEqual(f.keys, ['pullThroughCrowd']);
  const mod = await import('../substrate/farm-strategies.example/qor-lupogg-sewers.mjs');
  assert.equal(mod.default.pull?.throughCrowd, true);
  const v = validateStrategy(mod.default, { file: 'qor-lupogg-sewers.mjs' });
  assert.ok(v.ok !== false && !(v.problems?.length), JSON.stringify(v).slice(0, 300));
  const broker = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  assert.ok(broker.includes('p.policy.pullThroughCrowd = a.pull_through_crowd === true;'));
});

console.log(`\n${n} passed`);
