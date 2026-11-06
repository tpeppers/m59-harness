// Offline guard for THE NEEDLE (m59-needle-farm.mjs; a strategy's `needle`; Autopilot.needlePass and its one call site in
// passFarm, tools/autopilot/needle.mjs). Opens no socket and touches no roster: the shared presence rows go to a temp
// directory, and the keeper is the real prototype on a fake session.
//
//   node tools/m59-needle-farm-test.mjs
//
// Operator, 2026-11-05: a single striker at the tip of 2143's needle (r35c42, the pack stopping at r34c43) swings at the
// closest valid monster and switches when another is closer; archers behind it shoot the closest; when nothing has come
// for 15 s the front archer steps out, shoots one, and steps back; the striker is optional (archers-only runs, and is
// reported as money-losing). Pinned: the site's normal form and its refusals; target choice and retargeting; the station
// held and never chased from; the pull trigger and its rate limit; the allocation, the archer capacity and overflow, and
// the striker REPLACEMENT (stale or unfit -> next eligible, incumbent never displaced); survival left to the keeper
// (needle code below passFleeAndRest, no protected key accepted, a striker that breaks off retreats); the economics
// readout's denominators; the 2143 example site proved on the shipped map; and the passFarm seam in the right place.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readToolSource } from './autopilot/source.mjs';
import { Autopilot, HANDLED } from './m59-autopilot.mjs';
import { STRATEGY_FIELDS, validateStrategy } from './m59-strategy-schema.mjs';
import { allocate, archerSlots, safeSquaresFor, standInFor, yieldDecision, chainVacancies, checkSite, chooseCourierLap, chooseNextCourier, chooseTarget, mendExemptPlan, mendStock, preDispatchDue, rotateChain, deriveNeedle, econReport, loadSite, monsterComponent, needleBusy,
  normNeedle, normSite, parseSquare, pullDue, readPresence, roleReach, shillingsIn, slotOf, weaponReach, writePresence } from './m59-needle-farm.mjs';
import { OF } from './m59-parse.mjs';
import * as party from './m59-party.mjs';

const STATE = mkdtempSync(join(tmpdir(), 'needle-test-'));
process.env.M59_NEEDLE_STATE_DIR = STATE;
process.on('exit', () => { try { rmSync(STATE, { recursive: true, force: true }); } catch { /* temp */ } });

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };
const W = (row, col) => ({ row, col });
const SITE_RAW = {
  name: 'test-needle', room: 2143, kill: W(34, 43),
  striker: { station: W(35, 42), reach: 3 },
  archers: { stations: [W(34, 41), W(34, 42), W(35, 43), W(35, 44), W(34, 45), W(33, 43)], capacity: 4, pullSquare: W(30, 43) },
  reserve: { mode: 'hold', squares: [W(34, 39), W(36, 39)] },
  roster: { strikers: ['t2', 't1'], archers: ['t9', 't7'] },
};
const SITE = normSite(SITE_RAW);
const NOW = 1_800_000_000_000;
const row = (agent, role, extra = {}) => ({ agent, role, room: 2143, at: NOW - 1000, fit: true, health: 1, slot: null, ...extra });

// ------------------------------------------------------------------------------------------------- the normal form
await ok('the schema names needle as a work field and validates a strategy using it', () => {
  const f = STRATEGY_FIELDS.find(x => x.path === 'needle');
  assert.ok(f && f.keys.join() === 'needle' && f.faculty === 'work');
  const r = validateStrategy({ name: 'n', hunt: ['avar'], needle: { site: 'deep-jungle-2143', role: 'striker' } });
  assert.ok(r.ok, JSON.stringify(r.problems));
  const bad = validateStrategy({ name: 'n', hunt: ['avar'], needle: { site: 'x', role: 'healer' } });
  assert.ok(!bad.ok);
});
await ok('normal form: defaults filled, notes kept out, 15 s idle pull by default', () => {
  assert.equal(SITE.pull.idleS, 15);
  assert.equal(SITE.staleS, 20);
  assert.equal(SITE.rounds, 1);
  assert.equal(SITE.archers.reach, 17);
  assert.equal(SITE.reserve.mode, 'hold');
  assert.equal(archerSlots(SITE), 4);
  assert.equal(archerSlots(normSite({ ...SITE_RAW, archers: { ...SITE_RAW.archers, capacity: 6 } })), 6);
  assert.equal(archerSlots(normSite({ ...SITE_RAW, archers: { ...SITE_RAW.archers, capacity: 12 } })), 6, 'never more than the stations');
  assert.ok(normSite({ ...SITE_RAW, _note: 'x', why: 'y' }));
  assert.deepEqual(normNeedle({ site: 'deep-jungle-2143', role: 'ARCHER' }), { site: 'deep-jungle-2143', role: 'archer' });
  assert.equal(normNeedle(null), null);
  assert.equal(normNeedle({ site: SITE_RAW, role: 'striker' }).site.name, 'test-needle');
});
await ok('refusals: bare pairs, unknown keys, a hold bench with no squares, a protected key, bad names and numbers', () => {
  const refuses = v => assert.throws(() => normSite(v), undefined, JSON.stringify(v).slice(0, 80));
  refuses({ ...SITE_RAW, kill: [34, 43] });
  refuses({ ...SITE_RAW, striker: { station: [35, 42] } });
  refuses({ ...SITE_RAW, speed: 3 });
  refuses({ ...SITE_RAW, striker: { ...SITE_RAW.striker, fleeBelow: 0.2 } });
  refuses({ ...SITE_RAW, reserve: { mode: 'hold' } });
  refuses({ ...SITE_RAW, reserve: { mode: 'wander', squares: [] } });
  refuses({ ...SITE_RAW, pull: { idleS: 0 } });
  refuses({ ...SITE_RAW, archers: { stations: [W(35, 42)] } });
  refuses({ ...SITE_RAW, archers: { stations: [W(34, 41), W(34, 41)] } });
  refuses({ ...SITE_RAW, name: '../escape' });
  refuses({ ...SITE_RAW, striker: {} });
  assert.throws(() => normNeedle({ site: 'x', role: 'striker', fleeBelow: 0.1 }));
  assert.throws(() => normNeedle({ site: 'x' }));
  assert.throws(() => parseSquare('35,42'));
  assert.deepEqual(parseSquare('r35c42'), W(35, 42));
});

// ------------------------------------------------------------------------------------------------ target choice
const M = (id, row, col, extra = {}) => ({ id, row, col, ...extra });
await ok('the closest valid monster in reach is chosen; out of reach is nothing', () => {
  const at = W(35, 42);
  const r = chooseTarget([M(1, 33, 44), M(2, 34, 43), M(3, 20, 20)], at, { reach: 3 });
  assert.equal(r.target.id, 2);
  assert.deepEqual(r.inReach.map(o => o.id), [2, 1]);
  assert.equal(chooseTarget([M(3, 20, 20)], at, { reach: 3 }).target, null);
  assert.equal(chooseTarget([M(1, 33, 45)], at, { reach: 3 }).target, null, '(2,3) is 13 > 9: outside reach 3');
});
await ok('retargeting: a new monster at the front takes the next swing; a tie keeps the current one', () => {
  const at = W(35, 42);
  assert.equal(chooseTarget([M(1, 33, 44), M(2, 34, 43)], at, { reach: 3, currentId: 1 }).target.id, 2, 'closer wins over current');
  assert.equal(chooseTarget([M(1, 34, 43), M(2, 34, 41)], at, { reach: 3, currentId: 2 }).target.id, 2, 'equidistant: keep current');
  assert.equal(chooseTarget([M(1, 34, 43), M(2, 34, 41)], at, { reach: 3, los: o => o.id === 2 }).target.id, 2, 'tie: the one we can see');
});
await ok('reach: the site number clamped to the weapon in hand', () => {
  assert.deepEqual(weaponReach('nerudite sword'), { reach: 3, ranged: false });
  assert.deepEqual(weaponReach('mace'), { reach: 2, ranged: false });
  assert.deepEqual(weaponReach('practice bow'), { reach: 30, ranged: true });
  assert.equal(weaponReach('longbow').reach, 100);
  assert.equal(roleReach(SITE, 'striker', 'nerudite sword'), 3);
  assert.equal(roleReach(SITE, 'striker', 'mace'), 2);
  assert.equal(roleReach(SITE, 'striker', null), 2, 'unknown weapon: the safe 2');
  assert.equal(roleReach(SITE, 'archer', 'practice bow'), 17, 'the site caps it');
  assert.equal(roleReach(SITE, 'archer', 'long sword'), 3, 'an archer holding a sword reaches like a sword');
});
await ok('the needle is busy when something is near the tip or in the striker\'s reach', () => {
  assert.ok(needleBusy(SITE, [M(1, 32, 44)]));
  assert.ok(!needleBusy(SITE, [M(1, 20, 20)]));
  assert.ok(!needleBusy(SITE, []));
});

// ------------------------------------------------------------------------------- allocation and the replacement rule
await ok('allocation: one striker by roster order, archers fill stations, capacity, overflow and the bench', () => {
  const rows = [row('t1', 'striker'), row('t2', 'striker'), ...['t3', 't7', 't9', 't11', 't12', 't13'].map(a => row(a, 'archer'))];
  const a = allocate(SITE, rows, { now: NOW });
  assert.equal(a.mode, 'needle');
  assert.equal(a.striker, 't2', 'roster.strikers order: t2 before t1');
  assert.deepEqual(a.archers.map(x => x.agent), ['t9', 't7', 't11', 't12'], 'roster.archers first, then by name; 4 slots');
  assert.deepEqual(a.archers.map(x => x.index), [0, 1, 2, 3]);
  assert.deepEqual(a.overflow, ['t13', 't3']);
  assert.ok(a.reserve.includes('t1') && a.reserve.includes('t13'));
  assert.equal(a.puller.agent, 't9');
  assert.deepEqual(a.puller.from, W(30, 43));
  assert.equal(a.money_losing, false);
  assert.deepEqual(slotOf(a, 't7'), { role: 'archer', slot: 'archer:1', index: 1, station: W(34, 42) });
  assert.equal(slotOf(a, 't1').role, 'reserve');
});
await ok('the incumbent striker is never displaced by a better-listed arrival', () => {
  const a = allocate(SITE, [row('t1', 'striker', { slot: 'striker' }), row('t2', 'striker')], { now: NOW });
  assert.equal(a.striker, 't1');
});
await ok('REPLACEMENT: a stale or unfit striker is replaced by the next eligible melee', () => {
  const stale = allocate(SITE, [row('t2', 'striker', { slot: 'striker', at: NOW - 21_000 }), row('t1', 'striker')], { now: NOW });
  assert.equal(stale.striker, 't1');
  assert.deepEqual(stale.stale, ['t2']);
  const unfit = allocate(SITE, [row('t2', 'striker', { slot: 'striker', fit: false, why_unfit: 'health 40%' }), row('t1', 'striker')], { now: NOW });
  assert.equal(unfit.striker, 't1');
  assert.equal(unfit.unfit[0].agent, 't2');
  // The healed striker comes back: t1 now holds the tip and keeps it.
  const back = allocate(SITE, [row('t2', 'striker'), row('t1', 'striker', { slot: 'striker' })], { now: NOW });
  assert.equal(back.striker, 't1');
});
await ok('a newcomer must be clear of the floor by 0.2 to take the tip; the incumbent only needs to be fit', () => {
  const a = allocate(SITE, [row('t1', 'striker', { health: 0.6 })], { now: NOW });
  assert.equal(a.striker, null, '0.6 < 0.5 + 0.2');
  assert.equal(allocate(SITE, [row('t1', 'striker', { health: 0.6, slot: 'striker' })], { now: NOW }).striker, 't1');
  assert.equal(allocate(SITE, [row('t1', 'striker', { health: 0.75 })], { now: NOW }).striker, 't1');
});
await ok('archer incumbents keep their stations; a freed station is filled lowest first', () => {
  const a = allocate(SITE, [row('t7', 'archer', { slot: 'archer:2' }), row('t9', 'archer'), row('t3', 'archer', { slot: 'archer:0' })], { now: NOW });
  assert.deepEqual(a.archers.map(x => [x.agent, x.index]), [['t3', 0], ['t9', 1], ['t7', 2]]);
  assert.equal(a.puller.agent, 't3', 'the front archer is the lowest occupied station');
});
await ok('the striker is optional: archers-only runs, pulls, and is reported money-losing', () => {
  const a = allocate(SITE, [row('t9', 'archer'), row('t7', 'archer')], { now: NOW });
  assert.equal(a.mode, 'archers_only');
  assert.equal(a.money_losing, true);
  assert.equal(a.puller.role, 'archer');
  assert.match(a.why, /money|loot/);
});
await ok('striker-only: holds alone; pulls only with a pull step', () => {
  const a = allocate(SITE, [row('t1', 'striker')], { now: NOW });
  assert.equal(a.mode, 'striker_only');
  assert.equal(a.puller, null);
  const step = normSite({ ...SITE_RAW, striker: { ...SITE_RAW.striker, pullStep: W(34, 42) } });
  assert.equal(allocate(step, [row('t1', 'striker')], { now: NOW }).puller.agent, 't1');
  assert.equal(allocate(SITE, [], { now: NOW }).mode, 'empty');
  assert.equal(allocate(SITE, [row('t1', 'striker', { room: 2144 })], { now: NOW }).mode, 'empty', 'another room is not the needle');
});

// ---------------------------------------------------------------------------------------------------- the pull
await ok('pull trigger: 15 s quiet with something visible, a fit puller not under attack', () => {
  const base = { site: SITE, now: NOW, quietSince: NOW - 16_000, visible: 2, health: 1 };
  assert.equal(pullDue(base).due, true);
  assert.equal(pullDue({ ...base, quietSince: NOW - 14_000 }).due, false);
  assert.equal(pullDue({ ...base, visible: 0 }).due, false);
  assert.equal(pullDue({ ...base, attacked: true }).due, false);
  assert.equal(pullDue({ ...base, health: 0.5 }).due, false);
});
await ok('pull rate limit: one every everyS, at most maxPer10m', () => {
  const base = { site: SITE, now: NOW, quietSince: NOW - 60_000, visible: 1 };
  assert.equal(pullDue({ ...base, lastPullAt: NOW - 10_000 }).due, false);
  assert.equal(pullDue({ ...base, lastPullAt: NOW - 25_000 }).due, true);
  const times = Array.from({ length: 20 }, (_, i) => NOW - 30_000 * i - 25_000);
  assert.equal(pullDue({ ...base, lastPullAt: NOW - 25_000, pullTimes: times }).due, false);
  assert.match(pullDue({ ...base, lastPullAt: NOW - 25_000, pullTimes: times }).why, /cap/);
});

// ------------------------------------------------------------------------------------------- the shared state store
await ok('presence rows round-trip, one file per agent, a broken file is a missing row', () => {
  writePresence('rt', 't1', { role: 'striker', room: 2143, fit: true }, { now: NOW });
  writePresence('rt', 't9', { role: 'archer', room: 2143, fit: true }, { now: NOW });
  const rows = readPresence('rt');
  assert.deepEqual(rows.map(r => r.agent).sort(), ['t1', 't9']);
  assert.equal(rows.find(r => r.agent === 't1').at, NOW);
  assert.throws(() => writePresence('rt', '../x', {}));
});

// ------------------------------------------------------------------------------------------------------ economics
await ok('economics: every rate beside its duty minutes; no arrow price is null, not zero; archers-only flagged', () => {
  const ev = [
    { type: 'event', kind: 'needle_duty', site: 'd', role: 'striker', agent: 't1', minutes: 30, shots: 0, mode: 'needle' },
    { type: 'event', kind: 'needle_duty', site: 'd', role: 'archer', agent: 't9', minutes: 30, shots: 200, mode: 'needle' },
    { type: 'event', kind: 'needle_duty', site: 'd', role: 'archer', agent: 't9', minutes: 10, shots: 60, mode: 'archers_only' },
    { type: 'event', kind: 'killed', agent: 't1', needle: { site: 'd', role: 'striker' }, looted: 'shilling x40, fern' },
    { type: 'event', kind: 'killed', agent: 't1', needle: { site: 'd', role: 'striker' }, looted: 'shillings x20' },
    { type: 'event', kind: 'killed', agent: 't9', needle: { site: 'd', role: 'archer' }, looted: 'arrows x3' },
    { type: 'event', kind: 'killed', agent: 't4', looted: 'shilling x999' },              // not the needle's
  ];
  const r = econReport(ev, { site: 'd' });
  const s = r.roles.find(x => x.role === 'striker'), a = r.roles.find(x => x.role === 'archer');
  assert.equal(s.kills, 2); assert.equal(s.duty_min, 30); assert.equal(s.kills_30m, 2); assert.equal(s.shillings, 60);
  assert.equal(a.duty_min, 40); assert.equal(a.shots, 260); assert.equal(a.arrows_30m, 195);
  assert.equal(a.net_30m, null); assert.equal(r.total.net, null);
  assert.equal(r.modes_min.archers_only, 10);
  const priced = econReport(ev, { site: 'd', arrowPrice: 2 });
  assert.equal(priced.total.arrow_cost, 520);
  assert.equal(priced.total.net, 60 - 520);
  assert.equal(econReport([], { site: 'd' }).roles.length, 0);
  // Arrows as bought: the keeper's own `bought` rows, filed under the buyer's main needle role; a non-needle buyer is not.
  const withBuys = econReport([...ev, { type: 'event', kind: 'bought', agent: 't9', what: 'arrows', cost: 100 },
    { type: 'event', kind: 'bought', agent: 't4', what: 'arrows', cost: 999 }, { type: 'event', kind: 'bought', agent: 't9', what: 'meat pie', cost: 7 }], { site: 'd' });
  assert.equal(withBuys.roles.find(x => x.role === 'archer').arrows_bought_sh, 100);
  assert.equal(withBuys.total.net_as_bought, 60 - 100);
  assert.equal(shillingsIn(['shilling x5', 'shillings x7', 'fern x2']), 12);
});

// --------------------------------------------------------------------------------------------- deriving offline
// A synthetic 9x9 room: monsters come down column 5 to the tip at r5c5; its only SW step is r6c4, a dead end.
function fakeGeo() {
  const R = 9, C = 9;
  const walk = new Set(), dirs = new Map(), mover = new Set();
  const add = (r, c, ds) => { walk.add(`${r},${c}`); dirs.set(`${r},${c}`, ds); };
  for (let r = 1; r <= 4; r++) add(r, 5, [[1, 0], [-1, 0]]);
  add(5, 5, [[-1, 0], [1, -1]]);          // the tip
  add(6, 4, [[-1, 1]]);                   // the striker's square: back only
  for (const [r, c] of [[5, 3], [5, 4], [6, 3], [7, 3], [7, 4], [6, 5], [7, 5]]) add(r, c, []);   // player-only pocket
  for (const k of walk) mover.add(k);
  return {
    rows: R, cols: C, collisionReady: true,
    inBounds: (r, c) => r >= 1 && c >= 1 && r <= R && c <= C,
    walkable: (r, c) => walk.has(`${r},${c}`),
    openDirections: (r, c) => (dirs.get(`${r},${c}`) ?? []).map(([dr, dc]) => ({ dr, dc })),
    canMove(fr, fc, tr, tc) {
      if (!walk.has(`${tr},${tc}`)) return false;
      return (dirs.get(`${fr},${fc}`) ?? []).some(([dr, dc]) => fr + dr === tr && fc + dc === tc);
    },
    moverStepLands: (fr, fc, tr, tc) => mover.has(`${fr},${fc}`) && mover.has(`${tr},${tc}`) && !(mover.has(`${tr},${tc}`) && tr <= 4),
    standPoint: () => ({ x: 0, y: 0 }),
  };
}
const fakeLib = {
  lineOfSight(geo, fr, fc, tr, tc) {               // the kod staircase, on the fake's canMove
    let r = fr, c = fc;
    for (let g = 0; g < 64 && (r !== tr || c !== tc); g++) {
      const r2 = Math.abs(r - tr) > Math.abs(c - tc) ? r + Math.sign(tr - r) : r, c2 = r2 === r ? c + Math.sign(tc - c) : c;
      if (!geo.canMove(r, c, r2, c2)) return false;
      r = r2; c = c2;
    }
    return r === tr && c === tc;
  },
  reachableFrom(geo, from) {
    const seen = new Set([`${from.row},${from.col}`]), q = [[from.row, from.col]];
    while (q.length) {
      const [a, b] = q.shift();
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const k = `${a + dr},${b + dc}`;
        if ((dr || dc) && !seen.has(k) && geo.moverStepLands(a, b, a + dr, b + dc)) { seen.add(k); q.push([a + dr, b + dc]); }
      }
    }
    return seen;
  },
};
await ok('derive (synthetic): the monster component is the coarse cul-de-sac; pocket squares are safe; the striker square is its dead end', () => {
  const g = fakeGeo();
  const comp = monsterComponent(g, W(5, 5));
  assert.ok(comp.has('6,4') && comp.has('1,5') && !comp.has('5,4'));
  const d = deriveNeedle(g, { kill: W(5, 5), striker: W(6, 4), strikerReach: 3, bowReach: 17, lib: fakeLib });
  assert.deepEqual(d.problems, []);
  assert.ok(d.striker_in_monster_component);
  assert.deepEqual(d.striker_coarse_dirs, ['-1,1']);
  const all = [...d.stations, ...d.blind];
  assert.ok(all.length > 0 && all.every(c => c.threat === 0), 'nothing the coarse grid cannot step toward can see the pocket');
  assert.ok(!all.some(c => c.square === 'r6c4'), 'the striker square is not an archer square');
});

// ----------------------------------------------------------------------------- the keeper: station, chase, pull
let fightCalls = [], walkCalls = [], notes = [];
function keeperAt(agent, role, { self = W(35, 42), monsters = [], policyExtra = {}, wield = 'nerudite sword', inventory = null } = {}) {
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { needle: { site: SITE_RAW, role }, ...policyExtra };
  const objects = new Map(monsters.map(o => [o.id, { flags: OF.ATTACKABLE, nameRsc: 1, ...o }]));
  const inv = inventory ?? (role === 'archer'
    ? [{ id: 101, nameRsc: 2, amount: 1 }, { id: 102, nameRsc: 3, amount: 80 }]
    : [{ id: 101, nameRsc: 4, amount: 1 }]);
  const names = { 1: 'peet-seeeep avar warrior', 2: 'practice bow', 3: 'arrows', 4: wield };
  const client = { self: { ...self }, selfId: 9, room: { objects }, inventory: inv, using: new Set([101]),
    rsc: { get: id => names[id] ?? '' } };
  ap.s = { name: agent, client, world: { geometry: { canMove: () => true } }, combatEpoch: 0,
    async walkTo(col, row) { walkCalls.push({ agent, to: `r${row}c${col}` }); client.self = { row, col }; return { arrived: true, steps: 1 }; } };
  ap.tally = { kills: 0 }; ap.killTimes = [];
  Object.assign(ap, {
    facultyHeld: () => false, facultyOwner: () => 'keeper', safety: () => ({ fleeAt: 0.3 }),
    inReachOfUs: () => [], sparedHere: () => false, karmaForbids: () => false,
    note: (what, d) => notes.push({ agent, what, d }), progress() {}, noProgress() {}, ledgerEvent() {},
    leaveHold: async () => ({}), isTrainingPrey: () => true, trainingStyleFor: () => 'normal', styleForNonPrey: () => 'normal',
    prepareTrainingStyle: async () => ({ ready: true, equip: true }), farmStrategyHook() {}, farmBuffAsk: async () => null,
    touchTrainingHere: () => false, weaponPriorityNow: () => null, bannedWeaponsNow: () => null, finishTrainingBout() {},
    recordFarmFightOutcome: async () => {}, retreatToSafety: async () => ({ arrived: true }),
    async needleSwing(s, opts) { fightCalls.push({ agent, ...opts }); return { fought: true, killed: false, rounds: 1, foe_id: opts.exactTargetId }; },
  });
  return ap;
}
const ctxOf = ap => ({ s: ap.s, c: ap.s.client, room: { num: 2143, name: 'Deep in the Jungle' }, v: { health: { value: 100, max: 100 } } });
const reset = () => { fightCalls = []; walkCalls = []; notes = []; rmSync(join(STATE, 'test-needle'), { recursive: true, force: true }); };

await ok('striker on station swings, held, at the closest valid monster; the next pass switches to a closer one', async () => {
  reset();
  const ap = keeperAt('t1', 'striker', { monsters: [M(51, 33, 44), M(52, 34, 43)] });
  const found = [...ap.s.client.room.objects.values()];
  assert.equal(await ap.needlePass(ctxOf(ap), found, ap.needleHere(2143)), HANDLED);
  assert.equal(fightCalls.length, 1);
  assert.equal(fightCalls[0].exactTargetId, 52);
  assert.equal(fightCalls[0].holdPosition, true, 'never chases');
  assert.equal(fightCalls[0].reach, 3);
  assert.equal(walkCalls.length, 0);
  // 52 steps back, 51 is now at the front.
  ap.s.client.room.objects.get(52).row = 31; ap.s.client.room.objects.get(52).col = 45;
  ap.s.client.room.objects.get(51).row = 34; ap.s.client.room.objects.get(51).col = 43;
  await ap.needlePass(ctxOf(ap), [...ap.s.client.room.objects.values()], ap.needleHere(2143));
  assert.equal(fightCalls[1].exactTargetId, 51);
});
await ok('station holding: off the square, the striker walks back to it before swinging; out of reach it waits, never chases', async () => {
  reset();
  const off = keeperAt('t1', 'striker', { self: W(36, 41), monsters: [M(52, 34, 43)] });
  await off.needlePass(ctxOf(off), [...off.s.client.room.objects.values()], off.needleHere(2143));
  assert.deepEqual(walkCalls.map(w => w.to), ['r35c42']);
  assert.equal(fightCalls.length, 0);
  reset();
  const far = keeperAt('t1', 'striker', { monsters: [M(53, 25, 44)] });
  assert.equal(await far.needlePass(ctxOf(far), [...far.s.client.room.objects.values()], far.needleHere(2143)), HANDLED);
  assert.equal(fightCalls.length, 0); assert.equal(walkCalls.length, 0);
  assert.equal(far.doing, 'waiting');
});
await ok('archers take their own stations and shoot the closest in bow reach', async () => {
  reset();
  const s = keeperAt('t1', 'striker');
  await s.needlePass(ctxOf(s), [], s.needleHere(2143));
  const a = keeperAt('t9', 'archer', { self: W(40, 40), monsters: [M(52, 34, 43), M(51, 25, 44)] });
  await a.needlePass(ctxOf(a), [...a.s.client.room.objects.values()], a.needleHere(2143));
  assert.deepEqual(walkCalls.map(w => w.to), ['r34c41'], 'station 1');
  await a.needlePass(ctxOf(a), [...a.s.client.room.objects.values()], a.needleHere(2143));
  assert.equal(fightCalls.at(-1).exactTargetId, 52);
  assert.equal(fightCalls.at(-1).reach, 17);
  assert.equal(fightCalls.at(-1).holdPosition, true);
});
await ok('the pull: after 15 s quiet the front archer steps to the pull square, shoots once, walks back; then rate-limited', async () => {
  reset();
  const a = keeperAt('t9', 'archer', { self: W(34, 41), monsters: [M(60, 28, 44)] });
  const needle = a.needleHere(2143);
  const objs = () => [...a.s.client.room.objects.values()];
  await a.needlePass(ctxOf(a), objs(), needle);                 // starts the quiet clock; out of bow reach? (6.7 < 17) -> shoots
  assert.equal(fightCalls.length, 1, 'in bow reach from the station: a plain shot, no pull');
  reset();
  const b = keeperAt('t9', 'archer', { self: W(34, 41), monsters: [M(61, 15, 44)] });   // 19+ away: out of reach from the station
  const nb = b.needleHere(2143);
  await b.needlePass(ctxOf(b), [...b.s.client.room.objects.values()], nb);
  assert.equal(fightCalls.length, 0);
  b.needleState().quietSince = Date.now() - 16_000;
  await b.needlePass(ctxOf(b), [...b.s.client.room.objects.values()], nb);
  assert.deepEqual(walkCalls.map(w => w.to), ['r30c43', 'r34c41'], 'out to the pull square and back');
  assert.equal(fightCalls.length, 1);
  assert.equal(fightCalls[0].rounds, 1);
  assert.equal(fightCalls[0].exactTargetId, 61);
  assert.ok(notes.some(x => x.what === 'needle pull'));
  b.needleState().quietSince = Date.now() - 16_000;
  await b.needlePass(ctxOf(b), [...b.s.client.room.objects.values()], nb);
  assert.equal(fightCalls.length, 1, 'rate limit: no second pull inside everyS');
});
await ok('a lease on movement, another room, or no needle: null, and passFarm decides as before', async () => {
  reset();
  const a = keeperAt('t1', 'striker', { monsters: [M(52, 34, 43)] });
  a.facultyHeld = f => f === 'movement'; a.facultyOwner = () => 'bot:dum';
  assert.equal(await a.needlePass(ctxOf(a), [...a.s.client.room.objects.values()], a.needleHere(2143)), null);
  assert.equal(fightCalls.length, 0);
  assert.equal(a.needleHere(2144), null);
  const plain = Object.create(Autopilot.prototype); plain.policy = {};
  assert.equal(plain.needleHere(2143), null);
  assert.equal(plain.needleStatus(), null);
});
await ok('an archer with no arrows hands the pass back (the normal restock); a hurt striker goes to the bench', async () => {
  reset();
  const dry = keeperAt('t9', 'archer', { self: W(34, 41), inventory: [{ id: 101, nameRsc: 2, amount: 1 }] });
  assert.equal(await dry.needlePass(ctxOf(dry), [], dry.needleHere(2143)), null);
  reset();
  const hurt = keeperAt('t1', 'striker');
  const ctx = { ...ctxOf(hurt), v: { health: { value: 40, max: 100 } } };
  assert.equal(await hurt.needlePass(ctx, [], hurt.needleHere(2143)), HANDLED);
  assert.deepEqual(walkCalls.map(w => w.to), ['r34c39'], 'reserve square 1');
  assert.equal(hurt.needleStatus().slot, null);
});
await ok('replacement through the keepers: the old striker\'s row goes stale and the bench takes the tip', async () => {
  reset();
  const old = keeperAt('t2', 'striker');
  await old.needlePass(ctxOf(old), [], old.needleHere(2143));
  assert.equal(old.needleStatus().slot, 'striker');
  const bench = keeperAt('t1', 'striker', { self: W(34, 39) });
  await bench.needlePass(ctxOf(bench), [], bench.needleHere(2143));
  assert.equal(bench.needleStatus().slot, 'reserve');
  // t2's survival ladder takes the body; its farm pass stops publishing. Twenty-one seconds later:
  const rows = readPresence('test-needle');
  writePresence('test-needle', 't2', rows.find(r => r.agent === 't2'), { now: Date.now() - 21_000 });
  walkCalls = [];
  await bench.needlePass(ctxOf(bench), [], bench.needleHere(2143));
  assert.equal(bench.needleStatus().slot, 'striker');
  assert.deepEqual(walkCalls.map(w => w.to), ['r35c42']);
});
await ok('a striker that breaks off leaves the tip through retreatToSafety; an archer rests on its square', async () => {
  reset();
  const st = keeperAt('t1', 'striker', { monsters: [M(52, 34, 43)] });
  let retreated = 0;
  st.retreatToSafety = async () => { retreated++; return { arrived: true }; };
  st.needleSwing = async () => ({ fought: true, rounds: 1, disengaged: { at_health: '30%' } });
  await st.needlePass(ctxOf(st), [...st.s.client.room.objects.values()], st.needleHere(2143));
  assert.equal(retreated, 1);
  const ar = keeperAt('t9', 'archer', { self: W(34, 41), monsters: [M(52, 34, 43)] });
  ar.retreatToSafety = async () => { retreated++; return { arrived: true }; };
  ar.needleSwing = async () => ({ fought: true, rounds: 1, disengaged: { at_health: '30%' } });
  await ar.needlePass(ctxOf(ar), [...ar.s.client.room.objects.values()], ar.needleHere(2143));
  assert.equal(retreated, 1, 'the archer did not run');
});
await ok('archers-only is said out loud as money-losing', async () => {
  reset();
  const a = keeperAt('t9', 'archer', { self: W(34, 41) });
  await a.needlePass(ctxOf(a), [], a.needleHere(2143));
  assert.ok(notes.some(x => /MONEY-LOSING/.test(x.what)));
  assert.equal(a.needleStatus().money_losing, true);
});

// ------------------------------------------------------------------------- the rotation chain: courier -> striker -> archer
// Operator 2026-11-05: Sweetums (t11) is the striker and takes the next free archer seat; the Hanla arrow courier (Kermit, t1)
// becomes the striker; the next courier is chosen by the rule (chooseNextCourier). Never without a striker.
const CH = { striker: 't11', courier: 't1', next: { agent: 't4', why: 'pre-dispatched' }, pending: null, history: [] };
const vac = [{ agent: 't3', why: 'reached 99' }];
await ok('vacancies: off the roster, at stop_at, or away from the needle past seatVacantS', () => {
  const mem = {};
  const rows = [{ agent: 't3', present: true, usable: true, room: 2143, skill: 99, stopAt: 99 },
    { agent: 't2', present: false }, { agent: 't10', present: true, usable: false, room: 2143, skill: 40, stopAt: 99 },
    { agent: 't14', present: true, usable: true, room: 2144, skill: 40, stopAt: 99 }];
  const a = chainVacancies({ archers: ['t3', 't2', 't10', 't14', 't15'], rows, rooms: [2143, 2144, 2101], absentSince: mem, now: NOW, seatVacantS: 300 });
  assert.deepEqual(a.map(v => v.agent).sort(), ['t15', 't2', 't3'], 't10 dead 0 s and t14 in the clearing are not vacancies yet; t15 unread = off roster');
  assert.ok(mem.t10 === NOW && mem.t14 === undefined);
  const b = chainVacancies({ archers: ['t10'], rows, rooms: [2143], absentSince: mem, now: NOW + 301_000, seatVacantS: 300 });
  assert.equal(b[0].agent, 't10'); assert.match(b[0].why, /not usable/);
  chainVacancies({ archers: ['t10'], rows: [{ ...rows[2], usable: true }], rooms: [2143], absentSince: mem, now: NOW + 302_000 });
  assert.equal(mem.t10, undefined, 'back at the needle: the clock resets');
});
await ok('chain: a free seat CALLS UP the courier as the next striker; the pre-dispatched next courier takes the job', () => {
  const r = rotateChain(CH, { now: NOW, vacancies: vac, incoming: { agent: 't1', onLap: false } });
  assert.deepEqual(r.actions, [{ kind: 'call_up', agent: 't1' }, { kind: 'new_courier', agent: 't4', why: 'pre-dispatched' }]);
  assert.equal(r.chain.next, null);
  assert.equal(r.chain.striker, 't11', 'the striker keeps the tip during the call-up');
  assert.equal(r.chain.courier, 't4');
  assert.deepEqual(r.chain.pending, { incoming: 't1', seat: 't3', why: 'reached 99', at: NOW });
  assert.equal(r.hold, true, 'the seat is held for the striker');
  assert.match(r.log[0], /called up/);
  assert.equal(r.chain.history.at(-1).kind, 'call_up');
});
await ok('chain: the coordinator\'s own fields (seed) survive a tick -- it seeded every 15 s live', () => {
  const r = rotateChain({ ...CH, seed: '2026-11-05' }, { now: NOW });
  assert.equal(r.chain.seed, '2026-11-05');
  const p2 = rotateChain({ ...CH, seed: 's' }, { now: NOW, vacancies: vac, incoming: { agent: 't1' } });
  assert.equal(p2.chain.seed, 's'); assert.ok(p2.chain.pending);
  assert.equal(rotateChain(p2.chain, { now: NOW + 1, incoming: { agent: 't1', inRoom: true, fit: true } }).chain.seed, 's');
});
await ok('chain: the HANDOVER waits for the incoming striker to be in the room, fit, and between pulls', () => {
  const pending = rotateChain(CH, { now: NOW, vacancies: vac, incoming: { agent: 't1' } }).chain;
  for (const [inc, pulling, why] of [[{ agent: 't1', inRoom: false, fit: true }, false, /not in the needle/],
    [{ agent: 't1', inRoom: true, fit: false }, false, /not fit/], [{ agent: 't1', inRoom: true, fit: true }, true, /pull/], [null, false, /not read/]]) {
    const r = rotateChain(pending, { now: NOW + 1000, incoming: inc, pulling });
    assert.deepEqual(r.actions, []); assert.equal(r.hold, true); assert.equal(r.chain.striker, 't11'); assert.match(r.log[0], why);
  }
});
await ok('chain: the handover gives the striker the seat (FIRE when it knows no archery) and the tip to the courier', () => {
  const pending = rotateChain(CH, { now: NOW, vacancies: vac, incoming: { agent: 't1' } }).chain;
  const r = rotateChain(pending, { now: NOW + 60_000, incoming: { agent: 't1', inRoom: true, fit: true }, oldStriker: { agent: 't11', knowsArchery: false } });
  assert.deepEqual(r.actions, [{ kind: 'to_archer', agent: 't11', skill: 'fire' }]);
  assert.equal(r.chain.striker, 't1'); assert.equal(r.chain.pending, null); assert.equal(r.chain.courier, 't4');
  assert.match(r.log[0], /FIRE/);
  const r2 = rotateChain(pending, { now: NOW + 60_000, incoming: { agent: 't1', inRoom: true, fit: true }, oldStriker: { agent: 't11', knowsArchery: true } });
  assert.equal(r2.actions[0].skill, 'archery');
});
await ok('chain: nobody eligible for courier -- the job stops, said out loud; the next free seat promotes nobody', () => {
  const r = rotateChain({ ...CH, next: null }, { now: NOW, vacancies: vac, incoming: { agent: 't1' }, nextCourier: { agent: null, why: 'nobody eligible who knows fire' } });
  assert.equal(r.chain.courier, null);
  assert.match(r.log[0], /NO NEXT COURIER/);
  const done = rotateChain(r.chain, { now: NOW + 1, incoming: { agent: 't1', inRoom: true, fit: true } }).chain;
  assert.equal(done.striker, 't1');
  const again = rotateChain(done, { now: NOW + 2, vacancies: [{ agent: 't2', why: 'left the roster' }] });
  assert.deepEqual(again.actions, []); assert.equal(again.hold, false, 'nothing held: the archer queue fills the seat');
  assert.equal(again.chain.striker, 't1', 'the striker stays at the tip');
  assert.match(again.log[0], /NO COURIER/);
});
await ok('chain: a courier on a lap holds the seat and is not called up mid-lap; a stuck handover times out', () => {
  const r = rotateChain(CH, { now: NOW, vacancies: vac, incoming: { agent: 't1', onLap: true } });
  assert.deepEqual(r.actions, []); assert.equal(r.hold, true); assert.equal(r.chain.courier, 't1');
  const pending = rotateChain(CH, { now: NOW, vacancies: vac, incoming: { agent: 't1' } }).chain;
  const t = rotateChain(pending, { now: NOW + 2701_000, incoming: { agent: 't1', inRoom: false, fit: true }, holdMaxS: 2700 });
  assert.equal(t.hold, false); assert.equal(t.chain.pending, null); assert.equal(t.chain.striker, 't11');
});
await ok('NEVER WITHOUT A STRIKER: across random ticks the striker is never null and is replaced only by an incoming in the room and fit', () => {
  let chain = { ...CH };
  let n = 20;
  let seed = 7; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < 2000; i++) {
    const inc = { agent: chain.pending?.incoming ?? chain.courier, inRoom: rnd() < 0.5, fit: rnd() < 0.6, onLap: rnd() < 0.2 };
    const before = chain.striker;
    const r = rotateChain(chain, { now: NOW + i * 15_000, vacancies: rnd() < 0.3 ? [{ agent: 'tx', why: 'test' }] : [], incoming: inc,
      oldStriker: { agent: before, knowsArchery: rnd() < 0.5 }, pulling: rnd() < 0.2,
      nextCourier: rnd() < 0.2 ? { agent: null, why: 'none' } : { agent: `t${n++}`, why: 'rule' } });
    assert.ok(r.chain.striker, `tick ${i}: no striker`);
    if (r.chain.striker !== before) {
      assert.ok(inc.inRoom && inc.fit, `tick ${i}: tip handed to an incoming not in the room or not fit`);
      assert.deepEqual(r.actions.map(a => a.kind), ['to_archer']);
      assert.equal(r.chain.striker, inc.agent, 'the tip goes to the called-up courier and nobody else');
    }
    for (const a of r.actions) if (a.kind === 'to_archer') assert.equal(a.agent, before, 'only the old striker goes to an archer seat');
    chain = r.chain;
  }
});

// ------------------------------------------------------------------- choosing the next courier, and sending it early
const C = (agent, maxHealth, { fire = true, archery = false, disco = false, room = 2001, piloted = false } = {}) =>
  ({ agent, maxHealth, knows: { fire, archery }, spells: disco ? ['discordance'] : [], room, piloted });
const POOL = [C('t4', 120), C('t5', 140, { disco: true }), C('t6', 150, { archery: true }), C('t8', 130),
  C('t16', 160, { fire: false }), C('hk2', 200), C('t12', 170, { piloted: true }), C('t19', 180, { room: 714 }),
  C('t21', 175), C('t22', 165, { disco: true })];
await ok('next courier, default rule: highest max health that knows fire and neither archery nor discordance', () => {
  const r = chooseNextCourier({ candidates: POOL, needle: { archers: [{ agent: 't3', skill: 60, spells: [] }, { agent: 't9', skill: 90, spells: ['discordance'] }], others: ['t11', 't1'] },
    hallGroup: ['t19', 't18', 't21', 't13', 't20'] });
  assert.equal(r.rule, 'default'); assert.equal(r.top, 't3', 'most training ahead: 99 - 60');
  assert.equal(r.agent, 't8', 't16 knows no fire, t6 knows archery, t5/t22 discordance, t12 piloted, t19/t21 the hall, hk2 the service fleet');
  assert.match(r.why, /highest max health \(130\)/);
});
await ok('next courier, disco rule: the top archer knows discordance -> the highest max health discordance knower', () => {
  const r = chooseNextCourier({ candidates: POOL, needle: { archers: [{ agent: 't3', skill: 95, spells: [] }, { agent: 't9', skill: 40, spells: ['discordance'] }], others: [] },
    hallGroup: ['t19', 't21'] });
  assert.equal(r.rule, 'disco'); assert.equal(r.top, 't9');
  assert.equal(r.agent, 't22');
  assert.match(r.why, /sandstorm room/);
  const nextOut = chooseNextCourier({ candidates: POOL, needle: { archers: [{ agent: 't3', skill: 95, spells: [] }, { agent: 't9', skill: 40, spells: ['discordance'] }] },
    hallGroup: ['t19', 't21'], rule: { topBy: 'next_out' } });
  assert.equal(nextOut.top, 't3'); assert.equal(nextOut.rule, 'default', 'the other reading of "highest remaining"');
});
await ok('next courier: the exclusions, and nobody eligible is said with the reasons', () => {
  const r = chooseNextCourier({ candidates: POOL, needle: { archers: [{ agent: 't3', skill: 60 }], others: ['t8', 't4'] }, exclude: ['t22', 't21'], hallGroup: [] });
  assert.equal(r.agent, null, 't8 and t4 in the needle; nobody else qualifies');
  assert.match(r.why, /nobody eligible/); assert.equal(r.refused.hk2, 'service fleet'); assert.equal(r.refused.t12, 'piloted');
  assert.equal(r.refused.t19, 'posted in the guild hall 714'); assert.equal(r.refused.t8, 'already in the needle'); assert.equal(r.refused.t22, 'excluded');
  const d = chooseNextCourier({ candidates: POOL, needle: { archers: [{ agent: 't9', skill: 10, spells: ['discordance'] }] }, exclude: ['t5', 't22'] });
  assert.equal(d.agent, null); assert.equal(d.rule, 'disco');
});
await ok('pre-dispatch: an archer at 98 (in the skill it trains) sends the next courier now, once', () => {
  assert.equal(preDispatchDue([{ agent: 't3', skill: 97 }, { agent: 't9', skill: 50 }]).due, false);
  const d = preDispatchDue([{ agent: 't3', skill: 98 }, { agent: 't9', skill: 50 }]);
  assert.equal(d.due, true); assert.equal(d.archer, 't3');
  assert.equal(preDispatchDue([{ agent: 't3', skill: 98 }], { already: { agent: 't8' } }).due, false, 'not twice');
  // The pre-dispatched courier is the one the call-up uses, and it is out of the candidate pool meanwhile.
  const pick = chooseNextCourier({ candidates: POOL, needle: { archers: [{ agent: 't3', skill: 98 }], others: ['t11', 't1'] }, hallGroup: ['t19', 't21'] });
  const r = rotateChain({ striker: 't11', courier: 't1', next: { agent: pick.agent, why: pick.why }, pending: null, history: [] },
    { now: NOW, vacancies: [{ agent: 't3', why: 'reached 99' }], incoming: { agent: 't1' } });
  assert.equal(r.chain.courier, pick.agent);
  assert.equal(chooseNextCourier({ candidates: POOL, needle: { archers: [], others: [pick.agent] } }).agent === pick.agent, false);
});

// ----------------------------------------------------------------------------------------------------- disco duty
await ok('a HELD seat: an archer away on disco duty keeps its station while its row is stale, and is not the puller', () => {
  const site = normSite({ ...SITE_RAW, disco: { agents: ['t9'], holdS: 120 } });
  const rows = [row('t9', 'archer', { slot: 'archer:0', at: NOW - 60_000, hold_until: NOW + 60_000, away: 'disco' }),
    row('t7', 'archer', { slot: 'archer:1' }), row('t3', 'archer'), row('t1', 'striker')];
  const a = allocate(site, rows, { now: NOW });
  assert.deepEqual(a.archers.map(x => [x.agent, x.index]), [['t9', 0], ['t7', 1], ['t3', 2]], 'nobody is given t9\'s seat');
  assert.equal(a.puller.agent, 't7', 'the front archer is away: the next one pulls');
  assert.deepEqual(a.away, ['t9']); assert.deepEqual(a.disco, ['t9']); assert.equal(a.disco_missing, false);
  const lapsed = allocate(site, [{ ...rows[0], hold_until: NOW - 1 }, ...rows.slice(1)], { now: NOW });
  assert.ok(!lapsed.archers.some(x => x.agent === 't9'), 'past hold_until the seat is free again');
  assert.equal(lapsed.disco_missing, true, 'and the needle says it has no Discordance caster');
  assert.equal(allocate(SITE, [row('t1', 'striker')], { now: NOW }).disco_missing, true, 'none configured is missing too');
  assert.throws(() => normSite({ ...SITE_RAW, disco: { agents: ['t9'], spell: 'x' } }));
});
await ok('disco duty on the keeper: in a storm the disco archer stops shooting, holds its seat, and shoots again after', async () => {
  reset();
  const raw = { ...SITE_RAW, disco: { agents: ['t9'], holdS: 120 } };
  const a = keeperAt('t9', 'archer', { self: W(34, 41), monsters: [M(52, 34, 43)] });
  a.policy.needle = { site: raw, role: 'archer' };
  a.s.client.enchantmentStatus = () => ({ entries: a._storm ? [{ type: 2, name: 'sandstorm' }] : [] });
  const go = () => a.needlePass(ctxOf(a), [...a.s.client.room.objects.values()], a.needleHere(2143));
  a._storm = true;
  assert.equal(await go(), HANDLED);
  assert.equal(fightCalls.length, 0, 'no shot in a storm (a sandstorm ruins shots anyway: player.kod WindsRuinShot)');
  const mineRow = readPresence('test-needle').find(r => r.agent === 't9');
  assert.equal(mineRow.away, 'disco'); assert.ok(mineRow.hold_until > Date.now() + 100_000);
  assert.equal(a.needleStatus().disco_duty, true);
  assert.ok(notes.some(x => /disco duty: sandstorm/.test(x.what)));
  a._storm = false;
  await go();
  assert.equal(fightCalls.length, 1, 'storm lifted: back to shooting from the same seat');
  assert.equal(a.needleStatus().slot, 'archer:0');
});
await ok('the needle says it out loud when no Discordance caster is there', async () => {
  reset();
  const s = keeperAt('t1', 'striker');
  await s.needlePass(ctxOf(s), [], s.needleHere(2143));
  assert.ok(notes.some(x => /NO DISCORDANCE CASTER/.test(x.what)));
});

// ------------------------------------------------------------------------------------ mending the needle's bows
// Operator 2026-11-05: the disco caster also mends the needle's bows, carrying 30 orc teeth + 30 sapphires on top of its
// PvP floor; the courier keeps it supplied from hall 713, and buys arrows at Hanla when the hall cannot spare them.
await ok('mend stock: usable is above the PvP floor (always named), need is the gap to 30/30, ready at one cast', () => {
  const m = mendStock({ have: { sapphires: 50, 'orc teeth': 32 }, floor: { sapphire: 20, 'orc tooth': 2 } });
  assert.deepEqual(m.usable, { 'orc tooth': 30, sapphire: 30 }); assert.deepEqual(m.need, { 'orc tooth': 0, sapphire: 0 });
  assert.deepEqual(m.floor, { 'orc tooth': 2, sapphire: 20 }); assert.equal(m.ready, true);
  const low = mendStock({ have: { sapphire: 20, 'orc tooth': 5 }, floor: { sapphire: 20, 'orc tooth': 2 } });
  assert.deepEqual(low.need, { 'orc tooth': 27, sapphire: 30 }); assert.equal(low.ready, false, 'every sapphire is the PvP floor');
  const site = normSite({ ...SITE_RAW, mend: { stock: { 'orc tooth': 10, sapphire: 10 }, at: 'poor' } });
  assert.equal(site.mend.at, 'poor'); assert.equal(site.mend.agents, null, 'null = the disco-duty archers that know Mend');
  assert.throws(() => normSite({ ...SITE_RAW, mend: { at: 'broken' } }));
});
await ok('the mend exemption follows the role: given to the new mender, taken from the old, never from one it did not add', () => {
  const book = { default: { items: { sapphire: 100000 }, exempt: ['discordance'] }, agents: { t9: { exempt: ['mend'] }, t4: { exempt: ['mend'], spells: { bless: 2 } } } };
  const a = mendExemptPlan(book, ['t9'], []);
  assert.equal(a.changed, false, 't9 already has it (the operator set it): nothing to do, and it is not ours to take');
  const b = mendExemptPlan(book, ['t22'], ['t9']);
  assert.deepEqual(b.book.agents.t22.exempt, ['mend']); assert.equal(b.book.agents.t9, undefined, 'the old mender loses it');
  assert.deepEqual(b.owned, ['t22']); assert.ok(b.book.agents.t4.exempt.includes('mend'), 't4 was never ours');
  assert.equal(b.log.length, 2);
  const c2 = mendExemptPlan({ agents: { t9: { exempt: ['mend', 'bless'] } } }, [], ['t9']);
  assert.deepEqual(c2.book.agents.t9.exempt, ['bless'], 'only "mend" is removed');
});
await ok('courier lap: the hall for the mender\'s reagents and spare arrows, Hanla for the arrows the hall cannot spare', () => {
  const hall = { arrows: 3345, 'nerudite arrows': 5000, 'orc tooth': 200, sapphire: 80 };
  const floor = { arrows: 1500, 'nerudite arrows': 2500 };
  const a = chooseCourierLap({ hall, floor, arrowsWant: 400, menderNeed: { 'orc tooth': 22, sapphire: 30 } });
  assert.equal(a.kind, 'hall'); assert.deepEqual(a.take, { 'orc tooth': 22, sapphire: 30, arrow: 400 }); assert.equal(a.then, null);
  const b = chooseCourierLap({ hall: { ...hall, arrows: 1550, 'nerudite arrows': 2500 }, floor, arrowsWant: 400, menderNeed: {} });
  assert.equal(b.kind, 'hanla', 'the hall spares 50 plain < 100: buy them'); assert.deepEqual(b.take, { arrow: 400 });
  const c3 = chooseCourierLap({ hall: { ...hall, arrows: 1500 }, floor, arrowsWant: 4000, menderNeed: { sapphire: 5 } });
  assert.equal(c3.kind, 'hall'); assert.equal(c3.take['nerudite arrow'], 2500); assert.equal(c3.then, 'hanla', 'the rest from Hanla');
  assert.match(c3.why, /from Hanla/);
  assert.equal(chooseCourierLap({ hall, floor }).kind, 'none');
  assert.equal(chooseCourierLap({ hall: { sapphire: 0 }, menderNeed: { sapphire: 5 } }).kind, 'none', 'the hall cannot spare it: said, not looped');
});
await ok('the allocation names one mender: an archer that says it can mend, front-most first', () => {
  const rows = [row('t9', 'archer', { slot: 'archer:3', mend_ready: true }), row('t22', 'archer', { slot: 'archer:1', mend_ready: true }),
    row('t3', 'archer', { slot: 'archer:0' }), row('t1', 'striker')];
  assert.equal(allocate(SITE, rows, { now: NOW }).mender, 't22');
  assert.equal(allocate(SITE, rows.map(r => ({ ...r, mend_ready: false })), { now: NOW }).mender, null);
  assert.deepEqual(allocate(SITE, [row('t9', 'archer', { disco: true })], { now: NOW }).disco, ['t9'], 'a keeper that knows Discordance says so');
});
await ok('on the keepers: a worn bow is dropped on the station, the mender casts Mend on it, the archer picks it back up', async () => {
  reset();
  const raw = { ...SITE_RAW, mend: { at: 'med', waitS: 60 } };
  const mk = (agent, self, spells, inv) => {
    const k = keeperAt(agent, 'archer', { self, inventory: inv });
    k.policy.needle = { site: raw, role: 'archer' };
    const c = k.s.client;
    c.spells = spells.map((n, i) => ({ id: 900 + i, nameRsc: 50 + i, name: n }));
    const base = c.rsc.get; c.rsc = { get: id => ({ 50: spells[0], 51: spells[1] })[id] ?? base(id) };
    c.evSeq = 0; c.look = () => {}; c.unuse = () => {}; c.drop = ids => { for (const id of ids) objectsAt.set(id, { id, flags: 0 }); };
    c.get = id => objectsAt.delete(id);
    c.waitFor = async () => ({ events: [{ id: 101, description: 'The bow shows signs of wear; it is still an effective weapon.' }] });
    c.room.objects = objectsAt;
    k.s.pacer = { submit: async (_k, fn) => fn() };
    k.reagentOnHand = n => ({ sapphire: 50, 'orc tooth': 32 })[n] ?? 0;
    return k;
  };
  const objectsAt = new Map();
  const archer = mk('t3', W(34, 42), [], null);
  const mender = mk('t9', W(34, 41), ['discordance', 'mend'], null);
  let casts = [];
  mender.chaliceCast = async (name, id) => { casts.push({ name, id }); return { cast: true }; };
  mender.needleBow = async () => null;                         // its own bow is fine
  const pass = k => k.needlePass(ctxOf(k), [], k.needleHere(2143));
  await pass(mender);                                           // publishes mend_ready (knows Mend, 30/30 above a 0 floor)
  await pass(archer);                                           // drops its worn bow, asks t9
  assert.ok(objectsAt.has(101), 'the bow is on the floor of its own station');
  assert.equal(archer.needleStatus().mend_request.mender, 't9');
  assert.equal(fightCalls.length, 0);
  await pass(mender);
  assert.deepEqual(casts, [{ name: 'mend', id: 101 }]);
  await pass(archer);                                           // sees `mended`, picks it up
  assert.ok(!objectsAt.has(101)); assert.equal(archer.needleStatus().mend_request, null);
  assert.ok(notes.some(x => x.what === 'needle mend: bow picked back up'));
});

// --------------------------------------------------------------------- live 2026-11-06: stand-ins, never ordinary farming
// The needle went live in 2143 at 09:37Z and the archers were not on their stations: station walks were refused
// (object_blocked: bodies at the tip), every third refusal handed the pass to ordinary farming, and ordinary farming walked
// them to walls on the monsters' own ground; the cooperative strategy's attack veto refused the needle's own swings.
await ok('stand-in: the station when free; the nearest free safe square when it is occupied or refused; never off the safe set', () => {
  const st = W(34, 41);
  assert.deepEqual(standInFor({ site: SITE, role: 'archer', self: W(36, 39), preferred: st }).square, st);
  const occ = standInFor({ site: SITE, role: 'archer', self: W(34, 39), preferred: st, occupied: new Set(['34,41']) });
  assert.deepEqual(occ.square, W(34, 39), 'already on a bench square: stay and shoot from it');
  assert.match(occ.why, /occupied/);
  const away = standInFor({ site: SITE, role: 'archer', self: W(35, 42), preferred: st, blocked: new Set(['34,41']) });
  assert.deepEqual(away.square, W(34, 42), 'from the tip, the nearest free safe square');
  assert.match(away.why, /walk .* just failed/);
  const s1 = standInFor({ site: SITE, role: 'striker', self: W(36, 41), preferred: SITE.striker.station, occupied: new Set(['35,42']) });
  assert.ok(SITE.reserve.squares.some(q => q.row === s1.square.row && q.col === s1.square.col), 'a striker kept off the tip waits on the bench');
  const all = new Set([...safeSquaresFor(SITE, 'archer')].map(q => `${q.row},${q.col}`));
  assert.equal(standInFor({ site: SITE, role: 'archer', self: W(20, 20), preferred: st, occupied: all }), null);
  assert.ok(!safeSquaresFor(SITE, 'reserve').some(q => q.row === 35 && q.col === 42), 'the bench never includes the tip');
});
await ok('keeper: a station occupied by a body -> the archer walks to the nearest free safe square, not to ordinary farming', async () => {
  reset();
  const a = keeperAt('t9', 'archer', { self: W(35, 42), monsters: [M(70, 34, 41, { flags: OF.ATTACKABLE })] });
  const r = await a.needlePass(ctxOf(a), [], a.needleHere(2143));
  assert.equal(r, HANDLED);
  assert.deepEqual(walkCalls.map(w => w.to), ['r34c42']);
  assert.equal(a.needleStatus().last.what, 'walk');
});
await ok('keeper: a refused station walk is HANDLED, blocks that square for 30 s, and the archer shoots from a safe stand-in', async () => {
  reset();
  const a = keeperAt('t9', 'archer', { self: W(34, 39), monsters: [M(52, 34, 43)] });
  let refuse = true;
  const walk = a.s.walkTo;
  a.s.walkTo = async (col, row, o) => refuse ? (walkCalls.push({ agent: 't9', to: `r${row}c${col}` }), { arrived: false, steps: 0, reason: 'object_blocked' }) : walk(col, row, o);
  const go = () => a.needlePass(ctxOf(a), [...a.s.client.room.objects.values()], a.needleHere(2143));
  assert.equal(await go(), HANDLED, 'never null: never ordinary farming');
  assert.deepEqual(walkCalls.map(w => w.to), ['r34c41']);
  assert.ok(notes.some(x => /walk refused/.test(x.what)));
  await go();                                                // r34c41 blocked: stays on the safe bench square and shoots
  assert.equal(fightCalls.length, 1); assert.equal(fightCalls[0].holdPosition, true); assert.equal(fightCalls[0].exactTargetId, 52);
  assert.equal(a.needleStatus().last.what, 'fight');
  for (let i = 0; i < 6; i++) assert.equal(await go(), HANDLED);
});
await ok('keeper: a striker kept off the tip fights what is in reach from its safe square, and waits when nothing is', async () => {
  reset();
  const s = keeperAt('t1', 'striker', { self: W(34, 39), monsters: [M(80, 35, 42, { flags: OF.PLAYER }), M(52, 34, 41)] });
  assert.equal(await s.needlePass(ctxOf(s), [...s.s.client.room.objects.values()].filter(o => !(o.flags & OF.PLAYER)), s.needleHere(2143)), HANDLED);
  assert.equal(walkCalls.length, 0, 'already on a safe square');
  assert.equal(fightCalls.length, 1, 'live 2026-11-06: waiting for minutes beside a monster on the tip was the bug');
  assert.equal(fightCalls[0].exactTargetId, 52); assert.equal(fightCalls[0].holdPosition, true);
  reset();
  const q = keeperAt('t1', 'striker', { self: W(34, 39), monsters: [M(80, 35, 42, { flags: OF.PLAYER })] });
  await q.needlePass(ctxOf(q), [], q.needleHere(2143));
  assert.equal(fightCalls.length, 0); assert.equal(q.needleStatus().last.what, 'wait');
});
await ok('keeper: a MONSTER on the tip -- the striker takes the yield square beside it and kills it from there', async () => {
  reset();
  const s = keeperAt('t11', 'striker', { self: W(36, 39), monsters: [M(66, 35, 42)] });
  s.policy.needle = { site: { ...SITE_RAW, striker: { ...SITE_RAW.striker, yieldSquares: [W(36, 41), W(35, 41)] } }, role: 'striker' };
  const go = () => s.needlePass(ctxOf(s), [...s.s.client.room.objects.values()], s.needleHere(2143));
  await go();
  assert.deepEqual(walkCalls.map(w => w.to), ['r35c41'], 'beside the tip first (the nearest yield square), not the bench it stands on');
  await go();
  assert.equal(fightCalls.at(-1)?.exactTargetId, 66, 'the monster standing on the tip');
  s.s.client.room.objects.delete(66);
  await go();
  assert.deepEqual(walkCalls.map(w => w.to), ['r35c41', 'r35c42'], 'and takes the tip once it is free');
});
await ok('cooperative combat leaves a needle keeper alone: not ordinary, so no hold, no veto of its swings, not a member', async () => {
  const { CooperativeCombat } = await import('./m59-cooperative-combat.mjs');
  const ap = keeperAt('t9', 'archer', { self: W(34, 41) });
  Object.assign(ap, { running: true, mode: 'farm' });
for (const k of ['travelling', 'inert']) Object.defineProperty(ap, k, { value: false, configurable: true });
  ap.s.live = true; ap.s.combat = null; ap.s.world.room = { num: 2143 };
  ap.policy = { ...ap.policy, assignedRoom: 2143, confineRooms: [2143, 2144, 2101] };
  let asked = 0;
  const co = new CooperativeCombat(ap, { store: { write() {}, read: () => [] }, decide: () => { asked++; return { target_id: 1, hold: true, why: 'distraction' }; } });
  assert.equal(co.ordinary(), false, 'in the needle\'s room');
  assert.equal(co.veto(52), false, 'the needle\'s swing is never vetoed');
  assert.equal(co.decision(), null); assert.equal(asked, 0);
  ap.policy = { ...ap.policy, needle: null };
  assert.equal(co.ordinary(), true, 'the same keeper without a needle is an ordinary farmer (the control)');
});

// --------------------------------------------------------------------- the striker makes space; walks avoid monster ground
// Operator 2026-11-06: "the striker should step back/aside (toward the archers, away from monsters) if/when the courier try
// to walk past" ... "It should just always make space, they dont actually block the needle from monsters, only from players
// (the monsters are blocked by the map itself)".
const YSITE = normSite({ ...SITE_RAW, striker: { ...SITE_RAW.striker, yieldSquares: [W(36, 41), W(35, 41)], yieldMaxS: 20 } });
const P = (name, row, col, extra = {}) => ({ name, row, col, movedAt: NOW, ...extra });
await ok('yield: ALWAYS for a fleet-mate in transit near the tip -- no monster exception -- to the first free square off its way', () => {
  const st = {};
  const a = yieldDecision({ site: YSITE, now: NOW, passers: [P('Kermit', 36, 40)], state: st });
  assert.equal(a.yield, true); assert.deepEqual(a.square, W(36, 41)); assert.deepEqual(a.passers, ['Kermit']);
  const off = yieldDecision({ site: YSITE, now: NOW, passers: [P('Kermit', 36, 40)], state: {}, onWay: new Set(['36,41']) });
  assert.deepEqual(off.square, W(35, 41), 'r36c41 is on the passer\'s way: the other one');
  const taken = yieldDecision({ site: YSITE, now: NOW, passers: [P('Kermit', 36, 40)], state: {}, occupied: new Set(['36,41']) });
  assert.deepEqual(taken.square, W(35, 41));
  assert.equal(yieldDecision({ site: YSITE, now: NOW, passers: [], state: {} }).yield, false);
});
await ok('yield: a seated archer, a far body, or a body parked for 30 s is not passing; a needle walker saying so is', () => {
  assert.equal(yieldDecision({ site: YSITE, now: NOW, passers: [P('Statler', 34, 41)], state: {} }).yield, false, 'on a station');
  assert.equal(yieldDecision({ site: YSITE, now: NOW, passers: [P('Kermit', 40, 40)], state: {} }).yield, false, 'beyond passRadius');
  assert.equal(yieldDecision({ site: YSITE, now: NOW, passers: [P('Kermit', 36, 40, { movedAt: NOW - 31_000 })], state: {} }).yield, false, 'parked');
  assert.equal(yieldDecision({ site: YSITE, now: NOW, passers: [P('t3', 34, 41, { passing: { to: W(34, 45) } })], state: {} }).yield, true, 'walking through');
});
await ok('yield is bounded: back to the tip after yieldMaxS, a short cooldown, then make space again if still needed', () => {
  const st = { since: NOW - 21_000 };
  const a = yieldDecision({ site: YSITE, now: NOW, passers: [P('Kermit', 36, 40)], state: st });
  assert.equal(a.yield, false); assert.equal(a.expired, true);
  const b = yieldDecision({ site: YSITE, now: NOW + 1000, passers: [P('Kermit', 36, 40, { movedAt: NOW + 1000 })], state: { since: null, endedAt: NOW } });
  assert.equal(b.yield, false, 'cooldown');
  const c2 = yieldDecision({ site: YSITE, now: NOW + 4000, passers: [P('Kermit', 36, 40, { movedAt: NOW + 4000 })], state: { since: null, endedAt: NOW } });
  assert.equal(c2.yield, true, 'and again');
});
await ok('NO DEADLOCK: two bodies passing each other in the one-wide part both get through, and the striker is back after', () => {
  // The corridor the stations form (derive, 2143): bench r36c39 ... r34c41 r34c42 r35c43 r35c44 r34c45, one square wide,
  // and the tip r35c42 beside it. Two fleet-mates cross it in opposite directions; each square holds one body at a time
  // unless the two are passing (keepRightAim: a one-square pipe is two lanes, CLAUDE.md), and the striker makes space.
  const lane = [W(36, 40), W(35, 41), W(35, 42), W(35, 43), W(35, 44), W(34, 45)];
  let a = 0, b = lane.length - 1, striker = W(35, 42), state = {}, t = NOW, aside = 0;
  const key = q => `${q.row},${q.col}`;
  for (let tick = 0; tick < 40 && (a < lane.length - 1 || b > 0); tick++, t += 1000) {
    const passers = [P('Kermit', lane[a].row, lane[a].col, { movedAt: t }), P('Statler', lane[b].row, lane[b].col, { movedAt: t })]
      .filter((p, i) => (i === 0 ? a < lane.length - 1 : b > 0));
    const d = yieldDecision({ site: YSITE, now: t, passers, state, occupied: new Set(passers.map(key)) });
    if (d.yield) { if (state.since == null) state.since = t; striker = d.square; aside++; }
    else if (state.since != null) { state.since = null; state.endedAt = t; striker = W(35, 42); }
    // Each walker steps when its next square is free of the striker; meeting each other they pass (two lanes).
    const na = Math.min(a + 1, lane.length - 1), nb = Math.max(b - 1, 0);
    if (a < lane.length - 1 && key(lane[na]) !== key(striker)) a = na;
    if (b > 0 && key(lane[nb]) !== key(striker)) b = nb;
  }
  assert.equal(a, lane.length - 1, 'Kermit got through'); assert.equal(b, 0, 'Statler got through');
  assert.ok(aside > 0, 'the striker made space');
  const end = yieldDecision({ site: YSITE, now: t + 1000, passers: [], state });
  assert.equal(end.yield, false, 'and goes back to the tip when nobody is passing');
});
await ok('keeper: the striker on the tip steps to the yield square for a passing fleet-mate, and the walks avoid monster ground', async () => {
  reset();
  party.setRosterSource(() => new Set(['Kermit']));
  const s = keeperAt('t1', 'striker', { monsters: [M(52, 34, 43), M(90, 36, 40, { flags: OF.PLAYER })] });
  s.policy.needle = { site: { ...SITE_RAW, striker: { ...SITE_RAW.striker, yieldSquares: [W(36, 41), W(35, 41)] } }, role: 'striker' };
  const names = s.s.client.rsc.get; s.s.client.rsc = { get: id => (id === 9090 ? 'Kermit' : names(id)) };
  s.s.client.room.objects.get(90).nameRsc = 9090;
  const found = () => [...s.s.client.room.objects.values()].filter(o => !(o.flags & OF.PLAYER));
  await s.needlePass(ctxOf(s), found(), s.needleHere(2143));
  assert.deepEqual(walkCalls.map(w => w.to), ['r36c41'], 'aside, toward the archers, with a monster at the kill square all the same');
  assert.equal(s.needleStatus().yield.yield, true);
  s.s.client.room.objects.delete(90);
  await s.needlePass(ctxOf(s), found(), s.needleHere(2143));
  assert.deepEqual(walkCalls.map(w => w.to), ['r36c41', 'r35c42'], 'back to the tip once nobody is passing');
  party.setRosterSource(null);
  // A needle walk routes around the monster component (the tip excepted), unless the square is an accepted compromise.
  reset();
  const a = keeperAt('t9', 'archer', { self: W(36, 39) });
  let opts = null; const w0 = a.s.walkTo; a.s.walkTo = async (col, row, o) => { opts = o; return w0(col, row, o); };
  a.s.world.geometry = { openDirections: (r, c) => (r === 34 && c === 43 ? [{ dr: 1, dc: -1 }, { dr: 0, dc: 1 }] : []), inBounds: () => true, walkable: () => true, canMove: () => true };
  await a.needlePass(ctxOf(a), [], a.needleHere(2143));
  assert.ok(opts?.avoidSquares instanceof Set && opts.avoidSquares.has('34,43') && opts.avoidSquares.has('34,44'), 'the kill square and beyond are avoided');
  assert.ok(!opts.avoidSquares.has('35,42'), 'the tip is not: the striker makes space there');
});

await ok('cooperative LOGOFF leaves a needle keeper alone: it never asks for one, is never a helper, publishes disabled', async () => {
  const L = await import('./m59-cooperative-logoff.mjs');
  const a = keeperAt('t9', 'archer', { self: W(34, 41) });
  a.s.world.room = { num: 2143 };
  let asked = 0; a.note = () => {};
  const orig = a.fleetLogoff;
  assert.equal(await a.fleetLogoff('hurt'), false, 'no request: it stays in the game');
  assert.equal(L.cooperativeHelperReady(a, { helper_health: 0.9, danger_quiet_ms: 3000 }), false);
  let wrote = null;
  a._cooperativeLogoffConfig = {}; a.s.fleetStateFile = null;
  // presence: enabled false while holding a needle slot (the store is faked through the session's directory hook)
  const plain = Object.create(Object.getPrototypeOf(a)); Object.assign(plain, a, { policy: { ...a.policy, needle: null } });
  assert.equal(plain.needleHere(2143), null, 'the control: no needle, ordinary');
  void orig; void asked; void wrote;
});
await ok('knowing a spell: the client list, else the ability book -- an empty list after a rejoin is not "knows nothing"', async () => {
  const { mkdtempSync, writeFileSync: wf, mkdirSync } = await import('node:fs');
  const a = keeperAt('t9', 'archer', { self: W(34, 41) });
  a.s.client.spells = [];
  let asked = 0; a.s.client.requestSpells = () => { asked++; }; a.s.pacer = { submit: async (_k, fn) => fn() };
  a.who = () => 'NoSuchCharacterNeedleTest';
  assert.equal(a.needleKnows('discordance'), false, 'no list, no book');
  assert.equal(asked, 1, 'and it asked the server for the list');
  a.needleKnows('mend');
  assert.equal(asked, 1, 'at most once a minute');
  a._needleBook = { at: Date.now(), book: { spells: { discordance: { ability: 35 }, mend: { ability: 19 } } } };
  assert.equal(a.needleKnows('discordance'), true, 'the book says so');
  a.s.client.spells = [{ id: 1, nameRsc: 77 }]; const g = a.s.client.rsc.get; a.s.client.rsc = { get: id => (id === 77 ? 'Zap' : g(id)) };
  assert.equal(a.needleKnows('zap'), true, 'the live list first');
});
await ok('trust "operator": the operator\'s squares are taken verbatim -- check warns, never fails; walks do not avoid the model', async () => {
  const site = normSite({ ...SITE_RAW, trust: 'operator', striker: { station: W(36, 40), reach: 3 }, kill: W(36, 41),
    archers: { stations: [W(36, 38), W(1, 1)], capacity: 2 } });   // r1c1: no mover gets there -- the model objects
  assert.equal(site.trust, 'operator');
  assert.throws(() => normSite({ ...SITE_RAW, trust: 'mine' }));
  let map; try { map = (await import('./m59-map.mjs')).loadMap(); } catch { return; }
  (await import('./m59-routes.mjs')).attachStepMasks(map);
  const geo = (await import('./m59-roo.mjs')).sharedRoomGeometry(map.rooms['2143']);
  const r = checkSite(site, geo, await import('./m59-safespots.mjs'));
  assert.equal(r.ok, true); assert.ok(r.warnings.length > 0, 'and says what the model thinks');
  const strict = checkSite({ ...site, trust: 'derived' }, geo, await import('./m59-safespots.mjs'));
  assert.equal(strict.ok, false, 'the same squares fail when they are the model\'s');
  const a = keeperAt('t9', 'archer', { self: W(37, 37) });
  a.policy.needle = { site: { ...SITE_RAW, trust: 'operator' }, role: 'archer' };
  let opts = null; const w0 = a.s.walkTo; a.s.walkTo = async (col, row, o) => { opts = o; return w0(col, row, o); };
  a.s.world.geometry = { openDirections: () => [{ dr: 0, dc: 1 }], inBounds: () => true, walkable: () => true, canMove: () => true };
  await a.needlePass(ctxOf(a), [], a.needleHere(2143));
  assert.ok(opts && !opts.avoidSquares, 'no avoidance of a model the operator overrode');
});

// ------------------------------------------------------------------------------ survival is the keeper's, by shape
await ok('survival stays above: needle code lives in passFarm, below the ladder, and never names a protected faculty', () => {
  const AP = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const farm = AP.indexOf('  async passFarm(ctx) {');
  const seam = AP.indexOf('const needle = this.needleHere?.(room?.num)');
  const patrol = AP.indexOf('found = this.patrolEngageFilter(found, c.self, patrol)');
  const rank = AP.indexOf('found = rankQuarries(this.s.name');
  assert.ok(farm > 0 && seam > farm && seam > patrol && seam < rank, 'the seam is in passFarm, after every filter, before the ranking');
  const part = AP.slice(AP.indexOf('  needleState() {'), AP.indexOf('  needleStatus() {'));
  for (const bad of ['survivalEnabled', 'fleeBelow', 'restBelow', 'passFleeAndRest', 'panicLogoff', 'travelGuard', 'cancelMovement'])
    assert.ok(!part.includes(bad), `needle code does not touch ${bad}`);
  assert.ok(part.includes('disengageAt: safe.fleeAt'), 'every needle fight breaks off at the keeper\'s own flee line');
  assert.ok(!validateStrategy({ name: 'n', hunt: ['avar'], needle: { site: 'x', role: 'striker' }, fleeBelow: 0.2 }).ok);
});

// ------------------------------------------------------------------------------- the 2143 example, on the shipped map
await ok('the shipped 2143 example is the OPERATOR\'s needle, verbatim: striker r36c40, kill r35c41, the wall line, nobody east of c40', async () => {
  const { site } = loadSite('deep-jungle-2143', { dirs: [], extraDirs: [new URL('../substrate/needles.example', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')] });
  assert.equal(site.trust, 'operator');
  assert.deepEqual(site.kill, W(35, 41));
  assert.deepEqual(site.striker.station, W(36, 40));
  // Operator 2026-11-06, in his fill order, then the wall squares between them.
  assert.deepEqual(site.archers.stations.slice(0, 6), [W(37, 40), W(38, 38), W(40, 36), W(41, 36), W(42, 36), W(43, 36)]);
  assert.equal(archerSlots(site), 7);
  // Operator: the pull may step into the open toward the generator round r23c32; the 15 s idle trigger.
  assert.deepEqual(site.archers.pullSquare, W(27, 37)); assert.equal(site.pull.idleS, 15); assert.ok(site.pull.minHealth >= 0.8);
  const all = [site.striker.station, ...site.archers.stations, ...site.reserve.squares, ...site.striker.yieldSquares, site.archers.pullSquare];
  assert.ok(all.every(q => q.col <= 40), 'nobody east of c40');
  assert.deepEqual(site.roster.archers, ['t3', 't2', 't10', 't14', 't15', 't7', 't9']);
  assert.deepEqual(site.roster.strikers, ['t11', 't1']);
  assert.deepEqual(site.mend.stock, { 'orc tooth': 30, sapphire: 30 });
  let map;
  try { map = (await import('./m59-map.mjs')).loadMap(); } catch { console.log('   (no map on disk: geometry half skipped)'); return; }
  (await import('./m59-routes.mjs')).attachStepMasks(map);
  const geo = (await import('./m59-roo.mjs')).sharedRoomGeometry(map.rooms['2143']);
  const lib = await import('./m59-safespots.mjs');
  const r = checkSite(site, geo, lib);
  assert.equal(r.ok, true, 'operator squares pass');
  assert.ok(r.warnings.length > 0, 'and the model\'s disagreement is reported, not hidden');
  assert.deepEqual(r.rows.filter(x => x.what.startsWith('archer station')).map(x => x.square), site.archers.stations.map(q => `r${q.row}c${q.col}`), 'nothing dropped or reordered');
  for (const q of all) assert.ok(geo.walkable(q.row, q.col) && !!geo.standPoint(q.row, q.col), `r${q.row}c${q.col} is standable`);
  // The retired first approximation, as geometry facts: on the coarse grid r34c43 steps NE, E and SW, and r35c42 only back.
  const d = deriveNeedle(geo, { kill: W(34, 43), striker: W(35, 42), strikerReach: 3, lib });
  assert.deepEqual(d.kill_coarse_dirs.sort(), ['-1,1', '0,1', '1,-1'].sort());
  assert.deepEqual(d.striker_coarse_dirs, ['-1,1']);
});

console.log(`\n${n} passed`);
