// Offline guard for PATROL FARMING (m59-patrol-farm.mjs, a strategy's `patrol`, Autopilot.patrolHere /
// patrolEngageFilter / patrolWalk and their two call sites in passFarm). Opens no socket, touches no roster.
//
//   node tools/m59-patrol-farm-test.mjs
//
// Operator, 2026-11-04, of the Icky Cave (27): walk the spawn points in a loop for ever, killing everything met.
// Pinned: the normal form (named squares only) and its refusals; OFF unless declared; loop order, arrival and laps;
// resume at the nearest waypoint after a fight, forward rather than back; an unreachable waypoint skipped; the
// engagement radius; the walk is one bounded piece of the planned leg and yields to a movement lease; every leg of
// the operator's own loop proved on the shipped map, including the pocket entry that needed a declared jump; and
// the two passFarm call sites, in the right places.
import assert from 'node:assert/strict';
import { readToolSource } from './autopilot/source.mjs';
import { Autopilot } from './m59-autopilot.mjs';
import { STRATEGY_FIELDS, validateStrategy } from './m59-strategy-schema.mjs';
import { normPatrol, patrolState, patrolNext, nearestWaypoint, engageFilter, replayOnMover, validatePatrol,
         parseSquare, PATROL_DEFAULTS } from './m59-patrol-farm.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };
const W = (row, col) => ({ row, col });
const ICKY = { room: 27, loop: [W(23, 53), W(35, 58), W(31, 31), W(32, 35), W(51, 14), W(50, 34)] };

await ok('the schema names patrol as a work field', () => {
  const f = STRATEGY_FIELDS.find(x => x.path === 'patrol');
  assert.ok(f && f.keys.includes('patrol') && f.faculty === 'work');
  const r = validateStrategy({ name: 'p', hunt: ['orc'], patrol: ICKY });
  assert.ok(r.ok, JSON.stringify(r.problems));
});
await ok('normal form: named squares, defaults filled, a repeated closing waypoint dropped', () => {
  const p = normPatrol({ room: 27, loop: [W(1, 2), W(1, 2), W(3, 4), W(1, 2)] });
  assert.deepEqual(p.loop, [W(1, 2), W(3, 4)]);
  for (const [k, v] of Object.entries(PATROL_DEFAULTS)) assert.equal(p[k], v);
  assert.equal(normPatrol({ ...ICKY, engageWithin: 5 }).engageWithin, 5);
  assert.equal(normPatrol(null), null);
});
await ok('refusals: bare pairs, no room, one waypoint, bad numbers, unknown keys', () => {
  for (const bad of [{ room: 27, loop: [[23, 53], [35, 58]] }, { loop: ICKY.loop }, { room: 27, loop: [W(1, 1)] },
    { room: 27, loop: [W(1, 1), W(1.5, 2)] }, { room: 27, loop: [W(0, 1), W(2, 2)] }, { ...ICKY, engageWithin: 0 },
    { ...ICKY, legSteps: true }, { ...ICKY, speed: 3 }, [27]])
    assert.throws(() => normPatrol(bad), /patrol/);
  assert.match((() => { try { normPatrol({ room: 27, loop: [[1, 2], [3, 4]] }); } catch (e) { return e.message; } })(), /bare pair.*row, col/);
});
await ok('rNcM is the CLI spelling and nothing positional is', () => {
  assert.deepEqual(parseSquare('r23c53'), W(23, 53));
  assert.throws(() => parseSquare('23,53'), /rNcM/);
});

// --- off by default -----------------------------------------------------------------------------------------
function keeper(policy = {}) { const ap = Object.create(Autopilot.prototype); ap.policy = policy; return ap; }
await ok('OFF unless declared: the policy default is null and every helper answers the old way', async () => {
  const fresh = new Autopilot({ name: 'x', client: null, world: null }, {});
  assert.equal(fresh.policy.patrol, null);
  const ap = keeper({});
  assert.equal(ap.patrolHere(27), null);
  assert.equal(ap.patrolStatus(), null);
  assert.equal(await ap.patrolWalk({}, null), false);
  assert.equal(keeper({ patrol: ICKY }).patrolHere(38), null, 'another room is untouched');
});

// --- the state machine ------------------------------------------------------------------------------------
const P = normPatrol(ICKY);
await ok('the first call heads for the nearest waypoint', () => {
  const st = patrolState();
  const r = patrolNext(P, st, W(49, 30));
  assert.equal(r.action, 'walk'); assert.equal(r.index, 5); assert.deepEqual(r.target, W(50, 34));
});
await ok('arriving advances in loop order and counts a lap on wrapping', () => {
  const st = patrolState();
  patrolNext(P, st, W(50, 34));                     // standing on the last waypoint
  assert.equal(st.index, 0); assert.equal(st.laps, 1); assert.equal(st.arrivals, 1);
  const seen = [];
  for (const w of P.loop) { const r = patrolNext(P, st, w); seen.push(r.index); }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 0], 'r23c53 -> r35c58 -> r31c31 -> r32c35 -> r51c14 -> r50c34 -> again');
  assert.equal(st.laps, 2);
});
await ok('r31c31 then r32c35: one square off the rail is still its own stop, walked in order', () => {
  const st = patrolState(); st.index = 2; st.resume = false;
  assert.equal(patrolNext(P, st, W(31, 31)).index, 3);
  assert.equal(patrolNext(P, st, W(32, 35)).index, 4);
});
await ok('within arriveWithin counts as arrived (a body nudged by a crowd still advances)', () => {
  const st = patrolState(); st.index = 1; st.resume = false;
  assert.equal(patrolNext(P, st, W(34, 57)).index, 2);
});
await ok('after a fight: resume at the NEAREST waypoint', () => {
  const st = patrolState(); st.index = 1; st.resume = false;  // was heading for r35c58
  st.resume = true;                                            // ...then fought near r51c14
  assert.equal(patrolNext(P, st, W(50, 16)).index, 4);
});
await ok('after a fight: keep the waypoint we had when it is about as near (forward, not back)', () => {
  const st = patrolState(); st.index = 4; st.resume = true;    // heading for r51c14, fought half-way from r32c35
  const r = patrolNext(P, st, W(33, 33));                      // r32c35 is nearer, but only by the slack
  assert.equal(r.index, 3, 'nearest is r32c35 at ~2.2; r51c14 at ~26 is far past the slack');
  const st2 = patrolState(); st2.index = 4; st2.resume = true;
  assert.equal(patrolNext(P, st2, W(48, 18)).index, 4, 'r51c14 within slack of the nearest: kept');
});
await ok('an unreachable waypoint is skipped and recorded; nothing reachable is "stuck"', () => {
  const st = patrolState(); st.index = 5; st.resume = false;
  const r = patrolNext(P, st, W(45, 30), i => i !== 5 && i !== 0);
  assert.equal(r.index, 1); assert.equal(st.skipped.r50c34, 1); assert.equal(st.skipped.r23c53, 1);
  assert.equal(patrolNext(P, patrolState(), W(45, 30), () => false).action, 'stuck');
});
await ok('nearestWaypoint honours reachability and breaks ties by loop order', () => {
  assert.equal(nearestWaypoint([W(1, 1), W(1, 3)], W(1, 2)), 0);
  assert.equal(nearestWaypoint([W(1, 1), W(1, 3)], W(1, 2), i => i === 1), 1);
});

// --- engagement --------------------------------------------------------------------------------------------
await ok('engage only within the radius, plus whatever we are already fighting', () => {
  const found = [{ id: 1, row: 30, col: 30 }, { id: 2, row: 30, col: 45 }, { id: 3, row: 50, col: 50 }];
  const { kept, dropped } = engageFilter(found, W(30, 32), P, [3]);
  assert.deepEqual(kept.map(o => o.id), [1, 3]); assert.equal(dropped, 1);
  const ap = keeper({ patrol: ICKY }); ap.foeId = null;
  const k = ap.patrolEngageFilter(found, W(30, 32), P);
  assert.deepEqual(k.map(o => o.id), [1]);
  assert.equal(ap._patrol.resume, true, 'choosing to fight marks the loop for resuming');
});

// --- the walk ----------------------------------------------------------------------------------------------
function walkingKeeper({ held = false, steps = 40, refuse = false } = {}) {
  const walks = [];
  const line = Array.from({ length: steps }, (_, i) => W(50, 33 - i));   // a straight plan west from r50c34
  const geo = {
    path: (r, c, tr, tc) => ({ found: true, steps: tr === 51 && tc === 14 ? line : [W(tr, tc)] }),
    moverStepLands: () => true, declaredFallJumps: () => [],
  };
  const ap = keeper({ patrol: ICKY });
  ap.s = { client: { self: W(50, 34) }, world: { geometry: geo, room: { num: 27 } },
           walkTo: async (col, row, o) => { walks.push({ row, col, maxSteps: o.maxSteps }); return { arrived: true, steps: 5 }; } };
  ap.facultyHeld = () => held; ap.facultyOwner = () => (held ? 'bot:dum' : 'keeper');
  ap.leaveHold = async () => (refuse ? { refused: true } : { left: false });
  ap.note = () => {}; ap.progress = () => {}; ap.noProgress = () => {};
  return { ap, walks };
}
await ok('the walk is ONE PIECE of the planned leg, legSteps long, never the whole leg', async () => {
  const { ap, walks } = walkingKeeper();
  const p = ap.patrolHere(27);
  ap._patrol.index = 4; ap._patrol.resume = false;                     // heading for r51c14
  assert.equal(await ap.patrolWalk({}, p), true);
  assert.deepEqual({ row: walks[0].row, col: walks[0].col }, W(50, 33 - (p.legSteps - 1)));
  assert.equal(ap.patrolStatus().last_walk.to, 'r51c14');
});
await ok('a movement lease pauses the patrol (the ordinary branch answers)', async () => {
  const { ap, walks } = walkingKeeper({ held: true });
  assert.equal(await ap.patrolWalk({}, ap.patrolHere(27)), false); assert.equal(walks.length, 0);
});
await ok('too hurt to leave a wall: the pass is spent waiting, nothing walks', async () => {
  const { ap, walks } = walkingKeeper({ refuse: true });
  assert.equal(await ap.patrolWalk({}, ap.patrolHere(27)), true); assert.equal(walks.length, 0);
});
await ok('a leg the mover refuses is not walked: an undeclared 2-square step fails the replay', () => {
  const geo = { moverStepLands: () => true, declaredFallJumps: () => [] };
  assert.equal(replayOnMover(geo, W(36, 46), [W(34, 46)]).walks, false);
  const declared = { moverStepLands: () => false, declaredFallJumps: (r, c) => (r === 36 && c === 46 ? [W(34, 46)] : []) };
  assert.deepEqual(replayOnMover(declared, W(36, 46), [W(34, 46)]), { walks: true, refused: null, jumps: ['r36c46->r34c46'] });
});

// --- the operator's loop, on the shipped map ----------------------------------------------------------------
await ok('every leg of the Icky Cave loop plans AND replays on the mover; the pocket entry is the declared jump', async () => {
  const { loadMap } = await import('./m59-map.mjs');
  const { attachStepMasks } = await import('./m59-routes.mjs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const map = loadMap(); attachStepMasks(map);
  const routes = JSON.parse(readToolSource('substrate/m59-routes.json', 'utf8')).rooms['27'];
  const report = validatePatrol(P, sharedRoomGeometry(map.rooms['27']), { routesRoom: routes });
  for (const l of report.legs) assert.ok(l.ok, `${l.from} -> ${l.to}: ${l.refused}`);
  for (const l of report.legs) assert.ok(l.baked, `${l.from} -> ${l.to} has a baked route`);
  const pocket = report.legs.find(l => l.from === 'r50c34' && l.to === 'r23c53');
  assert.deepEqual(pocket.jumps, ['r36c46->r34c46']);
});

// --- where passFarm asks ------------------------------------------------------------------------------------
await ok('passFarm: the radius after gang-up and before the ranking; the walk after the hunt area, before the vigil', () => {
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const at = s => { const i = src.indexOf(s); assert.ok(i >= 0, s); return i; };
  const gang = at('found = this.gangUpFilter(found);'), radius = at('found = this.patrolEngageFilter(found, c.self, patrol, quarryWalks)');
  // m59-chase.mjs: the walk order is computed after the filters and handed to the radius, which asks it.
  const ordered = at('const ow = orderByWalk(found, s.world?.geometry, c.self,');
  const rank = at('found = rankQuarries(this.s.name');
  assert.ok(gang < ordered && ordered < radius && radius < rank);
  const area = at("this.doing = 'returning to the hunt area';");
  const walk = at('if (!found.length && patrol && await this.patrolWalk(ctx, patrol)) return HANDLED;');
  const vigil = at("'holding the spot and waiting for something to come to us'");
  assert.ok(area < walk && walk < vigil);
});

await ok('a patrol walks on rather than waiting for a deferred quarry (Zoot, r35c40, 2026-11-05)', () => {
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const at = s => { const i = src.indexOf(s); assert.ok(i >= 0, s); return i; };
  const cooling = at('if (!found.length && coolingTargets.length) {');
  const walk = at('if (patrol && await this.patrolWalk(ctx, patrol)) return HANDLED;');
  const wait = src.indexOf("this.doing = 'waiting';", cooling);
  assert.ok(cooling < walk && walk < wait, 'inside the cooling branch, before it waits');
});

await ok('engageWalk: near on foot is engaged, far on foot or no walk is left for the loop, unknown is the old radius', () => {
  const P = normPatrol({ ...ICKY });
  assert.equal(P.engageWalk, 16);
  assert.equal(normPatrol({ ...ICKY, engageWithin: 5 }).engageWalk, 10, 'twice the radius when only the radius is set');
  assert.equal(normPatrol({ ...ICKY, engageWithin: 5, engageWalk: 30 }).engageWalk, 30);
  const self = W(35, 41);
  const found = [{ id: 1, ...W(34, 39) }, { id: 2, ...W(35, 45) }, { id: 3, ...W(33, 41) }, { id: 4, ...W(36, 42) }, { id: 5, ...W(30, 41) }];
  const walks = new Map([
    [1, { known: true, found: true, length: 32 }],          // 2.2 squares, round the wall: the loop meets it
    [2, { known: true, found: true, length: 4 }],           // near on foot
    [3, { known: true, found: false }],                     // no walk, 2 squares: within swinging range
    // 4: not planned -> the straight radius alone
    [5, { known: false }],                                  // the planner cannot say -> the straight radius alone
  ]);
  const { kept, off_foot } = engageFilter(found, self, P, [], walks);
  assert.deepEqual(kept.map(o => o.id), [2, 3, 4, 5]);
  assert.equal(off_foot, 1);
  assert.deepEqual(engageFilter(found, self, P, [1], walks).kept.map(o => o.id), [1, 2, 3, 4, 5], 'the quarry we are chasing is kept');
  assert.deepEqual(engageFilter(found, self, P).kept.map(o => o.id), [1, 2, 3, 4, 5], 'no walks: the old answer');
});

await ok('a patrol never pulls to a wall: in a patrol room the held wall is let go and the quarry is closed on (Scooter 2026-11-05)', () => {
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const at = s => { const i = src.indexOf(s); assert.ok(i >= 0, s); return i; };
  const ask = at('const patrolHereNow = this.patrolHere?.('), drop = at('if (patrolHereNow && this.hold) this.hold = null;');
  const close = at('const closed = quarry ? await this.closeOnQuarry(quarry)'), pull = at('const p = quarry ? await this.pull(quarry)');
  assert.ok(ask < drop && drop < close && close < pull, 'asked, wall dropped, then the close-on branch, before any pull');
});

console.log(`\n${n} passed`);
