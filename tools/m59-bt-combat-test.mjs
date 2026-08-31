#!/usr/bin/env node
// m59-bt-combat-test.mjs -- tests for combat BT atomics and composed trees.
//
// No live server. Mock sessions simulate hostiles, attack, flee, safe spots.

import {
  SelectTargetAction,
  FightUntilDeadAction,
  TakeSafeSpotAction,
  FleeRoomAction,
  EngageNearestAction,
  CombatTree,
  OF_ATTACKABLE,
  OF_PLAYER,
  MELEE_REACH,
} from './m59-bt-combat.mjs';
import { plan, GoapExecutor } from './m59-goap-planner.mjs';
import { SUCCESS, FAILURE, RUNNING } from './m59-bt.mjs';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0, failed = 0;
function section(name) { console.log('\n' + name); }
function ok(label, got, want) {
  const pass = got === want;
  console.log(`  ${pass ? 'ok' : 'FAIL'} ${label}${pass ? '' :
    `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  pass ? passed++ : failed++;
}
function assert(label, cond, note = '') {
  const pass = !!cond;
  console.log(`  ${pass ? 'ok' : 'FAIL'} ${label}${note && !pass ? `  (${note})` : ''}`);
  pass ? passed++ : failed++;
}

async function tickUntilDone(node, bb, maxTicks = 200) {
  let result;
  for (let i = 0; i < maxTicks; i++) {
    result = node.tick(bb);
    if (result === SUCCESS || result === FAILURE) return result;
    await new Promise(r => setTimeout(r, 5));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Mock object builder
// ---------------------------------------------------------------------------

function makeHostile(id, { name = 'fungus beast', col = 5, row = 5, level = 20 } = {}) {
  return { id, flags: OF_ATTACKABLE, name, col, row, level };
}

function makePlayer(id, { col = 5, row = 5 } = {}) {
  return { id, flags: OF_PLAYER | OF_ATTACKABLE, name: 'SomePlayer', col, row };
}

function makeClient({ selfId = 1, selfCol = 5, selfRow = 5, objects = [] } = {}) {
  const objMap = new Map(objects.map(o => [o.id, o]));
  let evSeqVal = 0;
  const inv = [];
  const eq  = new Set();

  return {
    selfId,
    get self() { return { id: selfId, col: selfCol, row: selfRow }; },
    get room() { return { objects: objMap }; },
    get inventory() { return inv; },
    get equipment() { return new Map([...eq].map(id => [id, inv.find(i => i.id === id)]).filter(([,v]) => v)); },
    get evSeq() { return evSeqVal; },
    attack: async () => { evSeqVal++; },
    waitFor: async () => { evSeqVal++; return { events: [] }; },
    _objects: objMap,
    _removeHostile: (id) => objMap.delete(id),
  };
}

function makeSession({ exits = [], walkToResult = { arrived: true } } = {}) {
  return {
    world: { exits: () => exits, room: { num: 1 } },
    leaveVia: async (exit) => ({ left: true }),
    walkTo: async () => walkToResult,
    pacer: { submit: async (label, fn, delay) => fn?.() },
  };
}

// ---------------------------------------------------------------------------
// Section: SelectTargetAction — picks nearest hostile
// ---------------------------------------------------------------------------

section('SelectTargetAction — picks nearest non-player hostile');
{
  const near = makeHostile(10, { col: 6, row: 5 });   // dist ~1
  const far  = makeHostile(11, { col: 9, row: 9 });   // dist ~5.6
  const plyr = makePlayer(12,  { col: 6, row: 5 });   // same distance, but player — skip

  const c = makeClient({ selfCol: 5, selfRow: 5, objects: [near, far, plyr] });
  const bb = { _bt: {}, ws: {}, client: c };

  const node = SelectTargetAction();
  const result = node.tick(bb);

  ok('result is SUCCESS',  result, SUCCESS);
  ok('target is nearest hostile', bb.ws._targetId, 10);
  assert('has_target set',   !!bb.ws.has_target);
  assert('target_dead false', !bb.ws.target_dead);
  assert('in_combat set',    !!bb.ws.in_combat);
}

section('SelectTargetAction — FAILURE when no hostiles in room');
{
  const c = makeClient({ objects: [makePlayer(99)] });
  const bb = { _bt: {}, ws: {}, client: c };
  const node = SelectTargetAction();
  ok('no hostiles → FAILURE', node.tick(bb), FAILURE);
  assert('has_target not set', !bb.ws.has_target);
}

section('SelectTargetAction — FAILURE when no client');
{
  const bb = { _bt: {}, ws: {} };
  ok('no client → FAILURE', SelectTargetAction().tick(bb), FAILURE);
}

section('SelectTargetAction — respects radius filter');
{
  const close = makeHostile(10, { col: 6, row: 5 });   // dist 1
  const far   = makeHostile(11, { col: 20, row: 5 });  // dist 15
  const c = makeClient({ selfCol: 5, selfRow: 5, objects: [close, far] });
  const bb = { _bt: {}, ws: {}, client: c };
  const node = SelectTargetAction({ radius: 3 });
  const result = node.tick(bb);
  ok('picks only close hostile', result, SUCCESS);
  ok('target is the close one', bb.ws._targetId, 10);
}

section('SelectTargetAction — radius excludes all → FAILURE');
{
  const far = makeHostile(11, { col: 20, row: 5 });
  const c = makeClient({ selfCol: 5, selfRow: 5, objects: [far] });
  const bb = { _bt: {}, ws: {}, client: c };
  ok('all out of radius → FAILURE', SelectTargetAction({ radius: 3 }).tick(bb), FAILURE);
}

section('SelectTargetAction — nameRe filter skips non-matching');
{
  const rat  = makeHostile(10, { name: 'giant rat', col: 6, row: 5 });
  const beast= makeHostile(11, { name: 'fungus beast', col: 7, row: 5 });
  const c = makeClient({ objects: [rat, beast] });
  const bb = { _bt: {}, ws: {}, client: c };
  const node = SelectTargetAction({ nameRe: /fungus beast/i });
  const result = node.tick(bb);
  ok('filters by name', result, SUCCESS);
  ok('target is beast', bb.ws._targetId, 11);
}

section('SelectTargetAction — threat ceiling filters level-too-high targets');
{
  const weak   = makeHostile(10, { level: 20, col: 6, row: 5 });
  const strong = makeHostile(11, { level: 80, col: 7, row: 5 });
  const c = makeClient({ objects: [weak, strong] });
  const bb = { _bt: {}, ws: { _threatCeiling: 50 }, client: c };
  const node = SelectTargetAction();
  node.tick(bb);
  ok('skips over-ceiling target', bb.ws._targetId, 10);
}

section('SelectTargetAction — pre/effects metadata');
{
  const node = SelectTargetAction();
  ok('pre is empty',           node.pre?.length, 0);
  assert('effects has has_target', node.effects?.includes('has_target'));
  assert('effects has in_combat',  node.effects?.includes('in_combat'));
}

// ---------------------------------------------------------------------------
// Section: FightUntilDeadAction — swings until target leaves room
// ---------------------------------------------------------------------------

section('FightUntilDeadAction — SUCCESS when target dies after swings');
{
  const hostile = makeHostile(20, { col: 6, row: 5 });
  const c = makeClient({ objects: [hostile] });
  let swings = 0;
  const s = {
    pacer: {
      submit: async (label, fn, delay) => {
        swings++;
        fn?.();
        // Remove hostile after 3rd swing.
        if (swings >= 3) c._removeHostile(20);
      },
    },
  };
  c.waitFor = async () => { return { events: [] }; };

  const bb = { _bt: {}, ws: { _targetId: 20, has_target: true, armed: true }, client: c, session: { s } };
  const node = FightUntilDeadAction({ pacerDelay: 0 });

  const result = await tickUntilDone(node, bb, 200);
  ok('target dies → SUCCESS', result, SUCCESS);
  assert('target_dead set',   !!bb.ws.target_dead);
  assert('has_target cleared', !bb.ws.has_target);
  assert('in_combat cleared',  !bb.ws.in_combat);
  assert('swings were sent',   swings >= 3);
}

section('FightUntilDeadAction — SUCCESS immediately when target already gone');
{
  const c = makeClient({ objects: [] });   // room is empty
  const s = makeSession();
  const bb = { _bt: {}, ws: { _targetId: 99, has_target: true, armed: true }, client: c, session: { s } };
  const node = FightUntilDeadAction({ pacerDelay: 0 });
  const result = await tickUntilDone(node, bb, 20);
  ok('target already gone → SUCCESS', result, SUCCESS);
  assert('target_dead set', !!bb.ws.target_dead);
}

section('FightUntilDeadAction — FAILURE on budget exhaustion');
{
  const hostile = makeHostile(20);
  const c = makeClient({ objects: [hostile] });
  const s = makeSession();
  const bb = { _bt: {}, ws: { _targetId: 20, has_target: true, armed: true }, client: c, session: { s } };
  const node = FightUntilDeadAction({ maxSwings: 2, pacerDelay: 0 });
  const result = await tickUntilDone(node, bb, 100);
  ok('budget exhausted → FAILURE', result, FAILURE);
  assert('slot cleaned up', !bb._bt['at_fight_until_dead']);
}

section('FightUntilDeadAction — FAILURE with no target id');
{
  const c = makeClient({ objects: [] });
  const s = makeSession();
  const bb = { _bt: {}, ws: {}, client: c, session: { s } };
  ok('no _targetId → FAILURE', await tickUntilDone(FightUntilDeadAction(), bb, 10), FAILURE);
}

section('FightUntilDeadAction — first tick returns RUNNING');
{
  const hostile = makeHostile(20);
  const c = makeClient({ objects: [hostile] });
  const s = makeSession();
  const bb = { _bt: {}, ws: { _targetId: 20, has_target: true, armed: true }, client: c, session: { s } };
  const node = FightUntilDeadAction({ pacerDelay: 500 });
  ok('first tick is RUNNING', node.tick(bb), RUNNING);
  assert('slot stashed', !!bb._bt['at_fight_until_dead']);
  await tickUntilDone(node, bb, 30);  // drain
}

section('FightUntilDeadAction — pre/effects metadata');
{
  const node = FightUntilDeadAction();
  assert('pre has armed',           node.pre?.includes('armed'));
  assert('pre has has_target',      node.pre?.includes('has_target'));
  assert('pre has safe_spot_taken', node.pre?.includes('safe_spot_taken'));
  assert('effects has target_dead',     node.effects?.includes('target_dead'));
  assert('effects clears has_target',   node.effects?.includes('!has_target'));
}

// ---------------------------------------------------------------------------
// Section: TakeSafeSpotAction
// ---------------------------------------------------------------------------

section('TakeSafeSpotAction — SUCCESS with no safe spots (stays put)');
{
  const s = makeSession();
  const c = makeClient();
  const bb = { _bt: {}, ws: {}, session: { s }, client: c };
  const node = TakeSafeSpotAction();
  const result = await tickUntilDone(node, bb, 30);
  ok('no spots → SUCCESS (stays put)', result, SUCCESS);
  assert('safe_spot_taken set', !!bb.ws.safe_spot_taken);
}

section('TakeSafeSpotAction — walks to best spot by free_shots');
{
  const walked = [];
  const s = {
    ...makeSession(),
    walkTo: async (col, row) => { walked.push({ col, row }); return { arrived: true }; },
  };
  const c = makeClient({ selfCol: 1, selfRow: 1 });
  const spots = [
    { col: 3, row: 3, free_shots: 2, steps_away: 4 },
    { col: 5, row: 5, free_shots: 5, steps_away: 6 },   // best: highest free_shots
    { col: 2, row: 2, free_shots: 1, steps_away: 1 },
  ];
  const bb = { _bt: {}, ws: { _safeSpots: spots }, session: { s }, client: c };
  const node = TakeSafeSpotAction();
  const result = await tickUntilDone(node, bb, 40);
  ok('result is SUCCESS', result, SUCCESS);
  assert('walked to best spot', walked.length > 0, JSON.stringify(walked));
  if (walked.length) {
    ok('walked to highest free_shots col', walked[0].col, 5);
    ok('walked to highest free_shots row', walked[0].row, 5);
  }
  assert('safe_spot_taken set', !!bb.ws.safe_spot_taken);
}

section('TakeSafeSpotAction — already at best spot → SUCCESS immediately');
{
  const s = {
    ...makeSession(),
    walkTo: async () => { throw new Error('should not walk'); },
  };
  const c = makeClient({ selfCol: 5, selfRow: 5 });
  const spots = [{ col: 5, row: 5, free_shots: 3, steps_away: 0 }];
  const bb = { _bt: {}, ws: { _safeSpots: spots }, session: { s }, client: c };
  const node = TakeSafeSpotAction();
  const result = await tickUntilDone(node, bb, 20);
  ok('already at spot → SUCCESS', result, SUCCESS);
}

section('TakeSafeSpotAction — pre/effects metadata');
{
  const node = TakeSafeSpotAction();
  ok('pre is empty', node.pre?.length, 0);
  assert('effects has safe_spot_taken', node.effects?.includes('safe_spot_taken'));
}

// ---------------------------------------------------------------------------
// Section: FleeRoomAction
// ---------------------------------------------------------------------------

section('FleeRoomAction — SUCCESS when leaveVia succeeds');
{
  const exits = [{ to: 2, stand_on: { col: 1, row: 1 }, steps_away: 2 }];
  const s = { ...makeSession({ exits }), leaveVia: async () => ({ left: true }) };
  const c = makeClient({ objects: [makeHostile(10)] });
  const bb = { _bt: {}, ws: { in_combat: true }, session: { s }, client: c };
  const node = FleeRoomAction();
  const result = await tickUntilDone(node, bb, 30);
  ok('flee succeeds → SUCCESS', result, SUCCESS);
  assert('fled_room set',    !!bb.ws.fled_room);
  assert('in_combat cleared', !bb.ws.in_combat);
  assert('has_target cleared', !bb.ws.has_target);
}

section('FleeRoomAction — FAILURE when all exits fail');
{
  const exits = [{ to: 2, stand_on: { col: 1, row: 1 }, steps_away: 2 }];
  const s = { ...makeSession({ exits }), leaveVia: async () => ({ left: false }) };
  const c = makeClient();
  const bb = { _bt: {}, ws: {}, session: { s }, client: c };
  const result = await tickUntilDone(FleeRoomAction(), bb, 30);
  ok('all exits fail → FAILURE', result, FAILURE);
  assert('fled_room not set', !bb.ws.fled_room);
}

section('FleeRoomAction — FAILURE with no exits');
{
  const s = makeSession({ exits: [] });
  const c = makeClient();
  const bb = { _bt: {}, ws: {}, session: { s }, client: c };
  ok('no exits → FAILURE', await tickUntilDone(FleeRoomAction(), bb, 20), FAILURE);
}

section('FleeRoomAction — prefers exits away from foe mass');
{
  // Self at (5,5), foes at (5,7). Two exits: one toward foes (row 7), one away (row 1).
  const exits = [
    { to: 2, stand_on: { col: 5, row: 7 }, steps_away: 2 },  // toward foes
    { to: 3, stand_on: { col: 5, row: 1 }, steps_away: 2 },  // away from foes
  ];
  const usedExits = [];
  const s = {
    world: { exits: () => exits, room: { num: 1 } },
    leaveVia: async (exit) => {
      usedExits.push(exit.to);
      return { left: true };  // always succeeds — we just want to see which is tried first
    },
    pacer: { submit: async (_, fn) => fn?.() },
  };
  const foe = makeHostile(10, { col: 5, row: 7 });
  const c = makeClient({ selfCol: 5, selfRow: 5, objects: [foe] });
  const bb = { _bt: {}, ws: {}, session: { s }, client: c };
  await tickUntilDone(FleeRoomAction(), bb, 30);
  assert('first exit tried is the away-exit', usedExits[0] === 3, `first tried: ${usedExits[0]}`);
}

section('FleeRoomAction — a room handoff invalidates the remaining exits');
{
  const exits = [
    { to: 2, stand_on: { col: 1, row: 1 }, steps_away: 1 },
    { to: 3, stand_on: { col: 2, row: 2 }, steps_away: 2 },
  ];
  let attempts = 0;
  const s = {
    ...makeSession({ exits }),
    leaveVia: async () => { attempts++; return { left: false, room_changed: true }; },
  };
  const bb = { _bt: {}, ws: {}, session: { s }, client: makeClient() };
  const result = await tickUntilDone(FleeRoomAction(), bb, 30);
  ok('an unconfirmed handoff ends this pass without claiming success', result, FAILURE);
  assert('no second source-room exit is executed', attempts === 1, `attempts: ${attempts}`);
}

section('FleeRoomAction — first tick returns RUNNING');
{
  const exits = [{ to: 2, stand_on: { col: 1, row: 1 }, steps_away: 1 }];
  const s = makeSession({ exits });
  const c = makeClient();
  const bb = { _bt: {}, ws: {}, session: { s }, client: c };
  const node = FleeRoomAction();
  ok('first tick is RUNNING', node.tick(bb), RUNNING);
  await tickUntilDone(node, bb, 20);
}

section('FleeRoomAction — pre/effects metadata');
{
  const node = FleeRoomAction();
  ok('pre is empty', node.pre?.length, 0);
  assert('effects has fled_room',    node.effects?.includes('fled_room'));
  assert('effects clears in_combat', node.effects?.includes('!in_combat'));
}

// ---------------------------------------------------------------------------
// Section: EngageNearestAction — select → safe spot → fight
// ---------------------------------------------------------------------------

section('EngageNearestAction — full sequence kills one hostile');
{
  const hostile = makeHostile(30, { col: 6, row: 5 });
  const c = makeClient({ objects: [hostile] });
  let swings = 0;
  const s = {
    ...makeSession(),
    walkTo: async () => ({ arrived: true }),
    pacer: {
      submit: async (label, fn) => {
        if (label === 'attack') {
          swings++;
          fn?.();
          if (swings >= 2) c._removeHostile(30);
        } else fn?.();
      },
    },
  };
  c.waitFor = async () => ({ events: [] });

  const bb = { _bt: {}, ws: { armed: true }, session: { s }, client: c };
  const node = EngageNearestAction({ pacerDelay: 0 });
  const result = await tickUntilDone(node, bb, 300);

  ok('engage → SUCCESS', result, SUCCESS);
  assert('target_dead', !!bb.ws.target_dead);
  assert('swings sent', swings >= 2);
}

section('EngageNearestAction — FAILURE when no hostile present');
{
  const c = makeClient({ objects: [] });
  const s = makeSession();
  const bb = { _bt: {}, ws: { armed: true }, session: { s }, client: c };
  const node = EngageNearestAction({ pacerDelay: 0 });
  const result = await tickUntilDone(node, bb, 20);
  ok('no hostile → FAILURE', result, FAILURE);
}

// ---------------------------------------------------------------------------
// Section: CombatTree — fight if able, flee otherwise
// ---------------------------------------------------------------------------

section('CombatTree — armed + hostile → engages');
{
  const hostile = makeHostile(40, { col: 6, row: 5 });
  const c = makeClient({ objects: [hostile] });
  // Put a mace in inventory + equipment so CombatTree's canFight condition sees it.
  c.inventory.push({ id: 99, name: 'mace' });
  c.equipment.set(99, { id: 99, name: 'mace' });

  let swings = 0;
  const s = {
    ...makeSession(),
    walkTo: async () => ({ arrived: true }),
    pacer: {
      submit: async (label, fn) => {
        if (label === 'attack') { swings++; fn?.(); if (swings >= 2) c._removeHostile(40); }
        else fn?.();
      },
    },
  };
  c.waitFor = async () => ({ events: [] });

  const bb = { _bt: {}, ws: { armed: true }, session: { s }, client: c };
  const tree = CombatTree({ pacerDelay: 0 });
  const result = await tickUntilDone(tree, bb, 300);

  assert('combat resolves to terminal', result === SUCCESS || result === FAILURE,
    `got ${result}`);
  assert('swings were sent', swings >= 2);
}

section('CombatTree — no hostile → skips entire tree');
{
  const c = makeClient({ objects: [] });
  const s = makeSession();
  const bb = { _bt: {}, ws: { armed: true }, session: { s }, client: c };
  // With no hostile, the hostilePresent Condition fails, Selector falls to flee.
  // flee also fails (no exits). So the tree returns FAILURE.
  const tree = CombatTree({ pacerDelay: 0 });
  const result = await tickUntilDone(tree, bb, 20);
  assert('no hostile → FAILURE (nothing to do)', result === FAILURE || result === SUCCESS,
    `got ${result}`);
}

section('CombatTree — unarmed + hostile → flees');
{
  const hostile = makeHostile(50, { col: 6, row: 5 });
  const c = makeClient({ objects: [hostile] });
  // No weapon in equipment → canFight fails.
  const exits = [{ to: 2, stand_on: { col: 1, row: 1 }, steps_away: 1 }];
  let fled = false;
  const s = { ...makeSession({ exits }), leaveVia: async () => { fled = true; return { left: true }; } };
  const bb = { _bt: {}, ws: { armed: false }, session: { s }, client: c };
  const tree = CombatTree({ pacerDelay: 0 });
  const result = await tickUntilDone(tree, bb, 60);
  ok('unarmed → flees → SUCCESS', result, SUCCESS);
  assert('fled the room', fled);
}

// ---------------------------------------------------------------------------
// Section: GOAP plan — select + fight + safe spot chain
// ---------------------------------------------------------------------------

section('GOAP plan: select → safe_spot → fight goal: { target_dead: true }');
{
  const select = SelectTargetAction();
  const spot   = TakeSafeSpotAction();
  const fight  = FightUntilDeadAction();

  // Chain pre/effects for planner — safe_spot_taken is required on fight so
  // the planner cannot shortcut select→fight directly.
  spot.pre  = ['has_target'];
  // fight.pre already includes 'safe_spot_taken' by default

  const allActions = [
    { pre: select.pre, effects: select.effects, cost: 1, node: select },
    { pre: spot.pre,   effects: spot.effects,   cost: 1, node: spot   },
    { pre: fight.pre,  effects: fight.effects,  cost: 1, node: fight  },
  ];

  const ws = { armed: true };
  const result = plan(allActions, ws, { target_dead: true });

  ok('plan found', result.found, true);
  ok('three steps', result.steps.length, 3);
  ok('step 0 is select', result.steps[0], select);
  ok('step 1 is spot',   result.steps[1], spot);
  ok('step 2 is fight',  result.steps[2], fight);
}

section('GOAP plan: armed=false → flee goal: { fled_room: true }');
{
  const flee = FleeRoomAction();
  flee.pre     = [];
  flee.effects = ['fled_room', '!in_combat', '!has_target'];

  const allActions = [
    { pre: flee.pre, effects: flee.effects, cost: 1, node: flee },
  ];

  const result = plan(allActions, {}, { fled_room: true });
  ok('flee plan found', result.found, true);
  ok('one step',        result.steps.length, 1);
}

section('GOAP executor — select → safe spot → fight → target_dead');
{
  const hostile = makeHostile(60, { col: 6, row: 5 });
  const c = makeClient({ objects: [hostile] });

  let swings = 0;
  const s = {
    ...makeSession(),
    walkTo: async () => ({ arrived: true }),
    pacer: {
      submit: async (label, fn) => {
        if (label === 'attack') { swings++; fn?.(); if (swings >= 2) c._removeHostile(60); }
        else fn?.();
      },
    },
  };
  c.waitFor = async () => ({ events: [] });

  const bb = { _bt: {}, ws: { armed: true }, session: { s }, client: c };

  const select = SelectTargetAction();
  const spot   = TakeSafeSpotAction();
  const fight  = FightUntilDeadAction({ pacerDelay: 0 });
  spot.pre     = ['has_target'];
  // fight.pre already requires 'safe_spot_taken'

  const allActions = [
    { pre: select.pre, effects: select.effects, cost: 1, node: select },
    { pre: spot.pre,   effects: spot.effects,   cost: 1, node: spot   },
    { pre: fight.pre,  effects: fight.effects,  cost: 1, node: fight  },
  ];

  const exec = GoapExecutor(allActions, { target_dead: true }, { key: 'combat_exec' });
  const result = await tickUntilDone(exec, bb, 300);

  ok('executor reaches goal → SUCCESS', result, SUCCESS);
  assert('target_dead in ws', !!bb.ws.target_dead);
  assert('swings sent', swings >= 2);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
