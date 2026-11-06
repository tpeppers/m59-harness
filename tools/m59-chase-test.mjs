#!/usr/bin/env node
// CHASE ON FOOT (m59-chase.mjs), offline: the planner on the real Icky Cave (27) map, and fight() walking a chase
// piece under real collision in the socketless Bastion harness. No broker, keeper, server or roster.
//
//   node tools/m59-chase-test.mjs
//
// Every case is a square the operator named on 2026-11-05, or the one Zoot stalled on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadMap } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { sharedRoomGeometry, MAX_STEP_HEIGHT } from './m59-roo.mjs';
import { CHASE_DEFAULTS, chaseAim, chaseCache, chaseCapable, orderByWalk, walkPlan } from './m59-chase.mjs';
import { replayOnMover } from './m59-patrol-farm.mjs';
import { bastionHarness } from './fixtures/bastion-fallback-client.mjs';

const map = loadMap(); attachStepMasks(map);
const geo = sharedRoomGeometry(map.rooms['27']);
const W = (row, col) => ({ row, col });
const sq = p => `r${p.row}c${p.col}`;

test('the Icky Cave has a step mask, so the chase can answer there', () => {
  assert.equal(chaseCapable(geo), true);
});

test('r35c45 -> r35c58: thirteen squares straight, the long way round on foot (operator\'s example)', () => {
  const p = walkPlan(geo, W(35, 45), W(35, 58));
  assert.equal(p.known, true); assert.equal(p.found, true); assert.equal(p.detour, true);
  assert.ok(p.length >= 40, `walk ${p.length}`);
  assert.equal(sq(p.steps.at(-1)), 'r35c58', 'the plan ends ON the quarry\'s square');
  assert.equal(replayOnMover(geo, W(35, 45), p.steps.slice(0, -1)).walks, true, 'every step short of the quarry is one the mover takes');
  const aim = chaseAim(p);
  assert.equal(aim.index, CHASE_DEFAULTS.pieceSteps - 1, 'one bounded piece, not the whole walk');
  assert.equal(aim.remaining, p.length - CHASE_DEFAULTS.pieceSteps);
});

test('r35c41 -> r34c39: 2.2 squares through the wall is a detour on foot, never "in range" for a slash', () => {
  const p = walkPlan(geo, W(35, 41), W(34, 39));
  assert.equal(p.found, true); assert.equal(p.detour, true);
  assert.ok(p.straight > 2, 'outside the server\'s 2-square slash range (TargetWithinSightAndRange, integer squares)');
  assert.ok(p.length > 20, `walk ${p.length}`);
});

test('a quarry beside us on foot needs no piece: chaseAim is null one step out', () => {
  assert.equal(chaseAim(walkPlan(geo, W(35, 45), W(35, 44))), null);
  assert.equal(chaseAim({ found: false }), null);
});

test('the r35c48 "trench" plans out since its declared stand points (m59-spawnreach.mjs) -- and never east up the cliff', () => {
  // It was five squares whose centre stand points sat on a ledge edge (wall 1032 on the row's centre line). With the
  // walk-log stand points declared and the room re-baked, it joins the room; east is still a 1152-unit climb.
  assert.ok(MAX_STEP_HEIGHT * 3 <= 1152);
  for (const to of [W(35, 58), W(23, 53), W(35, 40)]) {
    const p = walkPlan(geo, W(35, 48), to);
    assert.equal(p.found, true, `out of r35c48 to ${sq(to)}`); assert.equal(p.pocket, undefined);
  }
  assert.equal(geo.moverStepLands(35, 48, 35, 49), false, 'the climb east stays refused');
  const east = walkPlan(geo, W(35, 48), W(35, 58));
  assert.ok(east.length > 30, `the long way round, not over the cliff (${east.length} steps)`);
});

test('orderByWalk: the near-on-foot quarry outranks the near-in-a-straight-line one; no route goes last, never away', () => {
  const self = W(35, 41);
  const across = { id: 1, ...W(34, 39) };     // 2.2 straight, ~30 on foot
  const along = { id: 2, ...W(35, 45) };      // 4 straight, 4 on foot
  const cache = chaseCache();
  const r = orderByWalk([across, along], geo, self, { room: 27, cache });
  assert.deepEqual(r.ordered.map(o => o.id), [2, 1]);
  assert.equal(r.planned, 2); assert.equal(r.walks.get(2).length, 4);
  assert.equal(cache.size, 2);
  const again = orderByWalk([across, along], geo, self, { room: 27, cache });
  assert.deepEqual(again.ordered.map(o => o.id), [2, 1], 'the cache answers the same');
  // A geometry the planner cannot read: the input order, untouched.
  const flat = { path: () => { throw new Error('must not plan'); }, hasStepMask: false };
  assert.deepEqual(orderByWalk([across, along], flat, self).ordered.map(o => o.id), [1, 2]);
  // No route: last, still present.
  const noRoute = { hasStepMask: true, path: (r, c, tr, tc) => (tc === 39 ? { found: false, expanded: 999, reason: 'no route the mover can walk through this geometry' } : { found: true, steps: [W(35, 42), W(35, 43), W(35, 44), W(35, 45)] }) };
  assert.deepEqual(orderByWalk([across, along], noRoute, self).ordered.map(o => o.id), [2, 1]);
});

test('orderByWalk stays inside its budget: past it the rest keep their straight-line order', () => {
  let t = 0; const clock = () => (t += 30);
  const many = [W(30, 41), W(31, 41), W(32, 41)].map((p, i) => ({ id: i, ...p }));
  const r = orderByWalk(many, geo, W(35, 41), { budgetMs: 20, clock });
  assert.ok(r.planned <= 1, `planned ${r.planned}`);
  assert.equal(r.ordered.length, 3);
});

test('silence is the old behaviour: no mask, no position, a floorless goal or a throwing planner all answer known:false', () => {
  assert.equal(walkPlan({ path() {}, hasStepMask: false }, W(1, 1), W(2, 2)).known, false);
  assert.equal(walkPlan(geo, null, W(2, 2)).known, false);
  assert.equal(walkPlan({ hasStepMask: true, path: () => ({ found: false, reason: 'goal square has no floor' }) }, W(1, 1), W(3, 3)).known, false);
  assert.equal(walkPlan({ hasStepMask: true, path: () => { throw new Error('boom'); } }, W(1, 1), W(3, 3)).known, false);
});

test('chaseCache expires and stays bounded', () => {
  const c = chaseCache({ ttlMs: 10, max: 2 });
  c.set('a', 1, 0); c.set('b', 2, 0); c.set('c', 3, 0);
  assert.equal(c.size, 2); assert.equal(c.get('a', 0), null);
  assert.equal(c.get('c', 5), 3); assert.equal(c.get('c', 50), null);
});

// --- fight() on real collision --------------------------------------------------------------------------------
const h = await bastionHarness();
const { fight } = await h.imp('m59-skills.mjs');
const { Autopilot } = await h.imp('m59-autopilot.mjs');

function caveFixture(self, foe) {
  const at = p => ({ row: p.row, col: p.col, x: p.col * 64 + 32, y: p.row * 64 + 32 });
  const entry = { format: 'm59-combat-approach-fixture/1', basis: 'synthetic: Icky Cave squares named by the operator',
    from: { room: 27, ...at(self) }, to: 27, reach: 2, target_id: 10,
    bodies: [{ id: 10, flags: 9, name: 'spider', ...at(foe) }] };
  const f = h.fixture(entry, { bodies: true, maxPackets: 384, maxMs: 60000 });
  for (const b of f.c.room.objects.values()) if (b.id !== 1) { b.nameRsc = b.id; f.c.rsc.set(b.id, b.name ?? 'spider'); }
  f.c.stats = () => {}; f.c.equipment = () => ({ equipped: [] });
  const swings = [];
  f.s.attackRounds = async id => {
    const me = f.c.self, it = f.c.room.objects.get(id), distance = Math.hypot(me.row - it.row, me.col - it.col);
    swings.push(distance);
    return { messages: [distance <= 2 ? 'You hit the spider.' : 'The spider is too far away.'], vitals: f.c.vitals() };
  };
  return { ...f, swings };
}

test('fight(): a spider across the r35c41/r34c39 wall is CHASED on foot -- one piece walked, nothing swung through the wall', async () => {
  const f = caveFixture(W(35, 41), W(34, 39));
  const before = walkPlan(geo, W(35, 41), W(34, 39)).length;
  const r = await fight(f.s, { target: 'spider', exactTargetId: 10, reach: 2, chase: true, equip: false, loot: false });
  assert.equal(r.closing, true, JSON.stringify({ reason: r.reason, chase: r.chase }));
  assert.equal(r.moved, true); assert.equal(r.fought, false);
  assert.equal(f.swings.length, 0, 'no swing at a quarry out of range');
  assert.ok(f.packets.length > 0);
  const now = f.c.self, after = walkPlan(geo, now, W(34, 39)).length;
  assert.ok(after < before, `closer on foot: ${before} -> ${after} steps`);
  assert.ok(r.chase?.detour === true && r.chase.on_foot === before);
});

test('fight(): a spider along open floor is still the local approach and is hit (nothing changed for the direct case)', async () => {
  const f = caveFixture(W(35, 41), W(35, 44));
  const r = await fight(f.s, { target: 'spider', exactTargetId: 10, reach: 2, chase: true, equip: false, loot: false, rounds: 1 });
  assert.equal(r.closing, undefined);
  assert.equal(r.fought, true, JSON.stringify(r).slice(0, 400));
  assert.ok(f.swings.length > 0 && f.swings.every(d => d <= 2));
  assert.ok(!r.log.some(x => x.stage === 'chase'), 'no chase on a direct walk');
});

test('fight(): only a refusal for BOUNDS hands over to the plan; one for budget is a crowd and sends nothing', async () => {
  for (const [detour_reason, chases] of [['body detour budget exhausted', false], ['no clear local body route', false],
                                         ['body detour exceeds local bounds', true]]) {
    const f = caveFixture(W(35, 41), W(35, 44));            // a direct walk: the advance check does not chase it
    f.s.walkToMeleeRange = async () => ({ arrived: false, approach_blocked: true, reason: 'combat_approach_blocked', detour_reason });
    const r = await fight(f.s, { target: 'spider', exactTargetId: 10, reach: 2, chase: true, equip: false, loot: false, rounds: 1 });
    if (chases) {
      assert.ok(r.log.some(x => x.stage === 'chase'), detour_reason);
      assert.ok(f.packets.length > 0);
    } else {
      assert.equal(r.reason, 'combat_approach_blocked', detour_reason);
      assert.equal(f.packets.length, 0, `${detour_reason}: nothing sent`); assert.equal(f.swings.length, 0);
    }
  }
});

test('fight(): holding a wall never chases', async () => {
  const f = caveFixture(W(35, 41), W(34, 39));
  const r = await fight(f.s, { target: 'spider', exactTargetId: 10, reach: 2, chase: true, holdPosition: true, equip: false, loot: false });
  assert.equal(r.out_of_reach, true); assert.equal(f.packets.length, 0);
});

test('the keeper: a moved piece is progress and keeps the quarry; two idle pieces or too many without contact abandon it', () => {
  const f = caveFixture(W(35, 41), W(34, 39));
  const progress = [], stalls = [], notes = [];
  const ap = Object.assign(Object.create(Autopilot.prototype), { s: f.s, policy: {},
    note: (what, detail) => notes.push({ what, detail }), progress: m => progress.push(m), noProgress: m => stalls.push(m) });
  const piece = (moved, extra = {}) => ({ fought: false, closing: true, moved, foe_id: 10, target: 'spider',
    reason: moved ? 'closing on foot' : 'object_blocked', chase: { on_foot: 30 }, ...extra });
  assert.equal(ap.finishChasePiece({ fought: false }), false, 'not a chase: not ours to finish');
  assert.equal(ap.finishChasePiece(piece(true)), true);
  assert.equal(ap.foeId, 10, 'the next pass prefers the same quarry'); assert.equal(progress.length, 1);
  ap.finishChasePiece(piece(false)); assert.equal(ap.pullTargetCooling(27, 10), null, 'one idle piece is not yet a loop');
  ap.finishChasePiece(piece(false));
  assert.ok(ap.pullTargetCooling(27, 10), 'two idle pieces defer it'); assert.equal(ap.foeId, null);
  assert.ok(notes.some(n => n.what === 'chase abandoned - choosing another quarry'));
  const ap2 = Object.assign(Object.create(Autopilot.prototype), { s: f.s, policy: { chaseMaxPieces: 3 },
    note: () => {}, progress: () => {}, noProgress: m => stalls.push(m) });
  for (let i = 0; i < 4; i++) ap2.finishChasePiece(piece(true));
  assert.ok(ap2.pullTargetCooling(27, 10), 'a chase longer than chaseMaxPieces without contact is given up');
  const ap3 = Object.assign(Object.create(Autopilot.prototype), { s: f.s, policy: { chaseMaxPieces: 3 },
    note: () => {}, progress: () => {}, noProgress: () => {} });
  for (let i = 0; i < 3; i++) ap3.finishChasePiece(piece(true));
  ap3.swungAt = Date.now() + 1;                               // contact, then the quarry steps back
  ap3.finishChasePiece(piece(true));
  assert.equal(ap3.pullTargetCooling(27, 10), null, 'contact resets the count: the bound is on chasing WITHOUT contact');
  assert.equal(ap3._chase.pieces, 1);
});

// --- the staged rollout: off unless a strategy turns it on ------------------------------------------------------
test('OFF BY DEFAULT: fight() without `chase` never chases -- the wall case is the old local approach, nothing walked round', async () => {
  const f = caveFixture(W(35, 41), W(34, 39));
  const r = await fight(f.s, { target: 'spider', exactTargetId: 10, reach: 2, equip: false, loot: false });
  assert.equal(r.closing, undefined);
  assert.ok(!r.log.some(x => x.stage === 'chase'), 'no chase stage');
  assert.ok(r.log.some(x => x.stage === 'melee_approach'), 'the old local approach answered');
});

test('OFF BY DEFAULT: the keeper orders, fights and closes on foot only when policy.chaseOnFoot is true', async () => {
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  for (const pin of ['if (this.policy.chaseOnFoot === true && found.length && c.self && !c.self.predicted) {',
                     'chase: this.policy.chaseOnFoot === true,',
                     'if (this.policy?.chaseOnFoot === true && chaseCapable(geo) && c.self && !c.self.predicted) {'])
    assert.ok(src.includes(pin), pin);
  assert.equal(new Autopilot({ need() {}, client: null }, {}).policy.chaseOnFoot, false, 'the policy default is off');
});
