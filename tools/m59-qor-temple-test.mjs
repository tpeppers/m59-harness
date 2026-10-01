#!/usr/bin/env node
// Offline: walking into the Temple of Qor (802), whose two entrances a lift opens in turn.
//
//   node --test tools/m59-qor-temple-test.mjs        (M59_ROOT set also checks the kod)
//
// PROD, 2026-10-01. Camilla (t9) could not reach Priestess Zuxana. `walk(802)` from 579 failed
// "did not reach 802 in three attempts", and in 598 with the lift observed OPEN (348) `walk_to`
// r38c26 stopped at r26c23 every time with "kept ending up somewhere other than the planned
// square". The lift was not what refused her. Three defects, measured here:
//
//   1. THE ROUTER PICKED AN ENTRANCE NOBODY CAN WALK TO. A code exit has no baked anchor, so
//      `transitOk` answered null ("carry on") for every trigger, and 579 -> 802 planned
//      579 > 589 > 802. 589's trigger is the end of a corridor reached only from a sunken pit
//      that nothing in 589 steps or falls into, at any lift height. Likewise 599 > 598 > 802
//      enters 598 by its south door, which reaches neither the bowl nor the temple.
//   2. THE WALK PLANNED THE LAST STEP THROUGH A SLIVER. 68% of plans from the north enter
//      r38c26 diagonally from r39c25. The step mask holds that edge because it lands from
//      r39c25's exact stand point; a walker that slid into r39c25 is never on it, slides off
//      wall 69, climbs back north and bounces at r27c23 until its budget ends.
//   3. SHUT, THE CORRIDOR IS SEALED AND STILL OFFERED. With the ceiling at 284 the mover
//      refuses r34c26 -> r35c26, and `path` still finds the trigger the long way round to the
//      same r39c25 sliver, so travel would walk at a closed door.
//
// The mover here is the offline model of the real one: `simulateWalk` (m59-walksim.mjs) plans
// with `RoomGeometry.path`, aims with `aimInto` and moves the body with `traceFineMoveClient`,
// carrying the fine position forward.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sharedRoomGeometry, STEP_MASK_VERSION } from './m59-roo.mjs';
import { attachStepMasks, activeRoutes, anchorFor, reachableFrom } from './m59-routes.mjs';
import { applyCeilingDoors } from './m59-ceiling-doors.mjs';
import { simulateWalk } from './m59-walksim.mjs';
import { World } from './m59-world.mjs';
import { Session } from './m59-session.mjs';
import { GATED_ENTRANCES, gatedEntrance, gateState, gatePassable, liftTravelMs,
         waitForGateOpen } from './m59-gated-entrances.mjs';

const map = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url), 'utf8'));
attachStepMasks(map);
const g598 = sharedRoomGeometry(map.rooms[598]);
const lift598 = height => applyCeilingDoors(map, 598, new Map([[1, { type: 5, height }]]));
const OPEN = 348, SHUT = 284;

function worldAt(roomNum, row, col, sectorHeights = new Map()) {
  const room = map.rooms[roomNum];
  const c = { roomNameRsc: room.nameRsc, roomRsc: room.roomRsc,
    room: { id: room.objId, objects: new Map(), sectorHeights },
    self: { row, col }, rsc: { get: () => '?' } };
  return { c, world: new World(c, map) };
}

test('the declaration is the kod: heights, sectors, triggers and the ten-minute alternation', t => {
  const root = process.env.M59_ROOT;
  if (!root || !existsSync(join(root, 'kod'))) return t.skip('M59_ROOT is not a Meridian 59 tree');
  const kod = rel => readFileSync(join(root, 'kod/object/active/holder/room', rel), 'utf8');
  const i8 = kod('monsroom/i8.kod'), h9 = kod('monsroom/objroom/h9.kod'), qor = kod('tempqor.kod');
  assert.match(qor, /EXIT_DELAY\s*=\s*600000/);
  assert.match(qor, /plExitPossibilities\s*=\s*\[\s*RID_I8\s*,\s*RID_H9\s*\]/,
    'two candidates, and ExitsTimer always picks the other: a strict alternation');
  for (const [src, g, anim] of [[i8, gatedEntrance(598, 802), 'CEILING'], [h9, gatedEntrance(589, 802), 'FLOOR']]) {
    assert.match(src, new RegExp(`QOR_DOOR\\s*=\\s*${g.sector}\\b`));
    assert.match(src, new RegExp(`OpenQorTemple\\(\\)[\\s\\S]*?ANIMATE_${anim}_LIFT[\\s\\S]*?#height\\s*=\\s*${g.open}\\b`));
    assert.match(src, new RegExp(`CloseQorTemple\\(\\)[\\s\\S]*?ANIMATE_${anim}_LIFT[\\s\\S]*?#height\\s*=\\s*${g.closed}\\b`));
    assert.match(src, new RegExp(`new_row\\s*=\\s*${g.trigger.row}\\s+and\\s+new_col\\s*=\\s*${g.trigger.col}\\b`));
  }
  for (const g of GATED_ENTRANCES) assert.equal(g.cycle_ms, 600000);
});

test('598 is in the ceiling table at the runtime version, so the observed lift IS applied', () => {
  const table = JSON.parse(readFileSync(new URL('../substrate/m59-ceiling-doors.json', import.meta.url)));
  assert.equal(table.version, STEP_MASK_VERSION);
  const d = table.rooms['598'];
  assert.deepEqual(d.doors.map(x => [x.id, x.open, x.closed]), [[1, OPEN, SHUT]]);
  assert.deepEqual(Object.keys(d.states).sort(), [String(SHUT), String(OPEN)]);
  assert.equal(lift598(OPEN).state, String(OPEN));
  // The parent hypothesis for the live failure, refuted: with the lift open, the plan from where
  // Camilla stopped exists and every planned step lands from its stand point. What failed was
  // the walk, not the plan.
  const p = g598.path(26, 23, 38, 26);
  assert.ok(p.found && !p.goal_exempt);
  let at = { row: 26, col: 23 };
  for (const s of p.steps) { assert.ok(g598.moverStepLands(at.row, at.col, s.row, s.col)); at = s; }
});

test('open, the corridor is four straight steps from its mouth; shut, it is sealed and still planned', () => {
  lift598(OPEN);
  assert.equal(g598.moverStepLands(34, 26, 35, 26), true);
  const fromMouth = g598.path(34, 26, 38, 26, { goalExempt: false });
  assert.deepEqual(fromMouth.steps.map(s => `${s.row},${s.col}`), ['35,26', '36,26', '37,26', '38,26']);
  assert.equal(simulateWalk(g598, 34, 26, 38, 26).arrived, true);
  try {
    assert.equal(lift598(SHUT).state, String(SHUT));
    assert.equal(g598.moverStepLands(34, 26, 35, 26), false, 'the lowered ceiling seals the corridor');
    // ...and the planner still answers yes: 23 steps round the bowl to the r39c25 sliver. This is
    // why the session must read the lift rather than trust a plan.
    const offered = g598.path(34, 26, 38, 26);
    assert.equal(offered.found, true);
    assert.deepEqual(offered.steps.at(-2), { ...offered.steps.at(-2), row: 39, col: 25 });
    assert.ok(!offered.steps.some(s => s.row === 35 && s.col === 26), 'not through the corridor');
    assert.equal(simulateWalk(g598, 34, 26, 38, 26).arrived, false, 'and walking it does not arrive');
  } finally { lift598(OPEN); }
});

test('the walk straight at the trigger takes the r39c25 sliver; through the mouth it arrives', () => {
  lift598(OPEN);
  // The sliver: the edge lands from r39c25's stand point and from nowhere the walker stands.
  const plan = g598.path(35, 21, 38, 26);
  assert.equal(plan.steps.at(-2)?.row, 39);
  assert.equal(plan.steps.at(-2)?.col, 25);
  const direct = simulateWalk(g598, 35, 21, 38, 26);
  assert.equal(direct.arrived, false, 'reproduces the live failure: a walk at r38c26 does not get there');
  assert.ok(direct.refusals.some(r => r.from === '39,25' && r.aimed === '38,26'),
    JSON.stringify(direct.refusals.slice(0, 4)));
  // The fix: the mouth first, then the corridor.
  const leg1 = simulateWalk(g598, 35, 21, 34, 26), leg2 = simulateWalk(g598, 34, 26, 38, 26);
  assert.equal(leg1.arrived, true, JSON.stringify(leg1.trail));
  assert.equal(leg2.arrived, true);
  // From the north the direct walk does arrive, the long way: down the west shelf, refused at
  // r39c25, back up, and round. Through the mouth it is half the steps.
  const far = simulateWalk(g598, 10, 11, 38, 26);
  const viaA = simulateWalk(g598, 10, 11, 34, 26), viaB = simulateWalk(g598, 34, 26, 38, 26);
  assert.ok(viaA.arrived && viaB.arrived);
  assert.ok(viaA.steps + viaB.steps < far.steps * 0.6, `${viaA.steps}+${viaB.steps} vs ${far.steps}`);
});

test('the 598 exit names its mouth and its gate', () => {
  lift598(OPEN);
  const { world } = worldAt(598, 3, 18);
  const temple = world.exits().find(e => e.kind === 'region' && e.to === 802);
  assert.ok(temple, 'the code exit is offered');
  assert.deepEqual(temple.gate, { sector: 1, lift: 'ceiling', open: OPEN, closed: SHUT, cycle_ms: 600000 });
  assert.deepEqual(temple.trigger_targets.map(t => t.via), [{ col: 26, row: 34 }]);
});

test('a code exit is a transit only from a door that can walk to its trigger', () => {
  const table = activeRoutes();
  const transit = (room, from, to) => {
    const { world } = worldAt(room, 1, 1);
    return world.codeExitTransit(room, anchorFor(table, room, from), to);
  };
  assert.equal(transit(598, 597, 802), true, 'the north door reaches the bowl and the corridor');
  assert.equal(transit(598, 599, 802), false, 'the south door reaches neither');
  assert.equal(transit(589, 579, 802), false, 'the Sentinel pit is not walkable from the west door');
  assert.equal(transit(589, 599, 802), false, '...nor from the east door');
  // The Icky Cave shape keeps its old answer: a trigger behind a gap narrower than a square is
  // entered by a staged fine move, which the step mask cannot see, so the flood has no opinion.
  assert.notEqual(transit(587, 576, 27), false);
});

test('589: the trigger is reached only from the pit the temple drops you in', () => {
  const table = activeRoutes();
  for (const from of [579, 599]) {
    const a = anchorFor(table, 589, from);
    const reach = reachableFrom(map, 589, a.row, a.col);
    assert.equal(reach.has('26,12'), false, `trigger from the ${from} door`);
    assert.equal(reach.has('22,13'), false, `ExitFromQor's landing from the ${from} door`);
  }
  // From the pit (ExitFromQor puts a body at r22c13) the corridor is walkable, so the mask does
  // model the region: the refusal above is the flood's answer, not its blindness.
  assert.equal(reachableFrom(map, 589, 22, 13).has('26,12'), true);
});

test('the router goes to 802 by the north of 598, never by 589', () => {
  lift598(OPEN);
  for (const [room, row, col] of [[579, 40, 40], [589, 21, 45]]) {
    const { world } = worldAt(room, row, col);
    const r = world.route(802);
    assert.equal(r.found, true);
    const hops = r.hops.map(h => `${h.from}>${h.to}`);
    assert.ok(!hops.includes('589>802'), hops.join(' '));
    assert.deepEqual(hops.slice(-2), ['597>598', '598>802'], hops.join(' '));
  }
});

test('gate state is the server\'s word for this room, and unobserved is the shipped state', () => {
  const g = gatedEntrance(598, 802);
  const at = h => gateState(g, new Map([[1, { type: 5, height: h, speed: 8 }]]));
  assert.equal(at(OPEN).state, 'open');
  assert.equal(at(SHUT).state, 'closed');
  assert.equal(at(300).state, 'moving');
  assert.equal(gateState(g, new Map()).state, 'unknown');
  assert.equal(gateState(g, new Map([[1, { type: 4, height: SHUT }]])).state, 'unknown',
    'a floor update for a ceiling lift is not this lift');
  assert.ok(gatePassable(at(OPEN)) && gatePassable(gateState(g, new Map())) && !gatePassable(at(SHUT)));
  assert.equal(liftTravelMs(g, 8), 8250);
  assert.equal(gatedEntrance(598, 597), null);
});

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async ms => { t += ms; } };
}

test('waiting: returns once the server opens it and the lift has finished moving', async () => {
  const g = gatedEntrance(598, 802), clock = fakeClock();
  const heights = new Map([[1, { type: 5, height: SHUT, speed: 8, at: 0 }]]);
  const c = { room: { id: 7, sectorHeights: heights } };
  const sleep = async ms => {
    await clock.sleep(ms);
    if (clock.now() >= 120000 && heights.get(1).height !== OPEN)
      heights.set(1, { type: 5, height: OPEN, speed: 8, at: clock.now() });
  };
  const r = await waitForGateOpen(c, g, { now: clock.now, sleep });
  assert.equal(r.opened, true);
  assert.ok(r.waited_ms >= 120000 + 8250 && r.waited_ms < 120000 + 8250 + 2000, String(r.waited_ms));
});

test('waiting: bounded by one cycle, and it stops for a cancel or a room change', async () => {
  const g = gatedEntrance(598, 802);
  const shut = () => ({ room: { id: 7, sectorHeights: new Map([[1, { type: 5, height: SHUT }]]) } });
  const clock = fakeClock();
  const timeout = await waitForGateOpen(shut(), g, { now: clock.now, sleep: clock.sleep });
  assert.equal(timeout.opened, false);
  assert.ok(timeout.waited_ms >= 660000 && timeout.waited_ms < 662000);
  assert.match(timeout.reason, /did not open within 660s/);
  let n = 0;
  const cancelled = await waitForGateOpen(shut(), g, { now: fakeClock().now, sleep: async () => {},
    cancelled: () => ++n > 3 });
  assert.equal(cancelled.cancelled, true);
  const c = shut(), clock2 = fakeClock();
  const moved = await waitForGateOpen(c, g, { now: clock2.now,
    sleep: async ms => { await clock2.sleep(ms); c.room.id = 8; } });
  assert.match(moved.reason, /left the room/);
});

test('the session holds a shut gate at its mouth, and lets an open one straight through', async () => {
  const hold = Session.prototype.holdForGatedEntrance;
  assert.equal(typeof hold, 'function');
  const exit = { kind: 'region', to: 802 };
  const session = sectorHeights => {
    const c = { self: { row: 26, col: 23 }, room: { id: 7, sectorHeights } };
    return { c, walks: [], world: { room: { num: 598 } }, need: () => c,
      movementWasCancelled: () => false,
      async walkTo(col, row) { this.walks.push({ col, row }); c.self = { row, col }; return { arrived: true }; } };
  };
  const open = session(new Map([[1, { type: 5, height: OPEN }]]));
  assert.deepEqual(await hold.call(open, exit), { held: false, state: 'open' });
  const fresh = session(new Map());
  assert.equal((await hold.call(fresh, exit)).held, false, 'never reported moved is the shipped, open state');
  assert.equal(fresh.walks.length, 0);

  const shut = session(new Map([[1, { type: 5, height: SHUT }]]));
  let waitedAt = null;
  const r = await hold.call(shut, exit, { wait: async c => { waitedAt = { ...c.self }; return { opened: true, waited_ms: 5 }; } });
  assert.deepEqual(shut.walks, [{ col: 26, row: 34 }], 'it walks to the mouth first');
  assert.deepEqual(waitedAt, { row: 34, col: 26 }, 'and waits there');
  assert.equal(r.held, true);
  assert.equal(r.opened, true);
  assert.equal(r.state_before, 'closed');
  assert.deepEqual(await hold.call(shut, { kind: 'edge', to: 802 }), { held: false });
});

test('travel asks the session about a gate before walking a region exit', () => {
  const src = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
  const travel = src.slice(src.indexOf('  async travel(toRoomNum, {'));
  const hook = travel.indexOf("typeof this.holdForGatedEntrance === 'function'");
  assert.ok(hook > 0, 'the hook is in travel');
  assert.ok(hook < travel.indexOf('const walkBegan = Date.now();'), 'and it runs before the walk');
});
