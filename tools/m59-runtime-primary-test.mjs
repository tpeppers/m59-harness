#!/usr/bin/env node
// O(1) primary-state contract for the optional lab runtime. Offline: no socket or roster.

import { classifyClientEvent, meridianPrimarySource } from './runtime/primary-source.mjs';

let pass = 0, fail = 0;
function ok(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('primary state reads pushed primitives only');
{
  let forbidden = 0;
  const session = {
    live: true,
    credentials: { character: 'Fallback' },
    get world() { forbidden++; throw new Error('routing world must not be observed'); },
    client: {
      state: 'game', evSeq: 12, me: { name: 'Tester' }, roomNameRsc: 9,
      rsc: new Map([[9, 'A Quiet Room']]),
      room: { id: 123, objects: new Map([[1, { id: 1 }]]) },
      self: { col: 3, row: 4, x: 224, y: 288 },
      inventory: [{ id: 7 }, { id: 8 }],
      vitals: () => ({
        health: { value: 19, max: 20 }, vigor: { value: 77, max: 200 },
        mana: { value: 10, max: 15 },
      }),
    },
  };
  const controller = {
    mode: 'farm', running: true, passes: 4, lastDoing: 'recovering',
    get status() { forbidden++; throw new Error('full status must not be observed'); },
  };
  const state = meridianPrimarySource({
    agent: 'lab1', session, controller,
  });
  ok('routing and full status were never touched', forbidden === 0, `${forbidden} forbidden reads`);
  ok('identity is projected', state.agent === 'lab1' && state.character === 'Tester');
  ok('catch-all event revision is omitted from the hot projection',
     state.revisions.events === null,
     `events=${JSON.stringify(state.revisions.events)}`);
  ok('room and position come from pushed client state', state.room.name === 'A Quiet Room' && state.you.col === 3);
  ok('vitals are compact', state.vitals.health.value === 19 && state.vitals.vigor.value === 77 && state.vitals.mana.max === 15);
  ok('inventory bodies are absent', !('inventory' in state) && !('items' in state));
  ok('controller facts stay primitive', state.activity.mode === 'farm' && state.activity.action === 'recovering');
  ok('state is immutable JSON data', Object.isFrozen(state) && state.schema === 'm59-primary-state/v1');
}

console.log('\nsafety classification is edge-driven');
{
  const hurt = classifyClientEvent({ kind: 'stat', name: 'health', value: 8 }, 12);
  const heal = classifyClientEvent({ kind: 'stat', name: 'health', value: 15 }, 12);
  const same = classifyClientEvent({ kind: 'stat', name: 'health', value: 12 }, 12);
  const prior = {
    health: { value: 69, max: 100 },
    mana: { value: 14, max: 20 },
    vigor: { value: 79, scale_max: 200 },
  };
  const healthReady = classifyClientEvent(
    { kind: 'stat', name: 'health', value: 70, max: 100 }, 69,
    { previousVitals: prior, currentVitals: { ...prior, health: { value: 70, max: 100 } },
      policy: { restBelow: 0.7 } },
  );
  const manaReady = classifyClientEvent(
    { kind: 'stat', name: 'mana', value: 15, max: 20 }, 69,
    { previousVitals: prior, currentVitals: { ...prior, mana: { value: 15, max: 20 } } },
  );
  const vigorReady = classifyClientEvent(
    { kind: 'stat', name: 'vigor', value: 80, max: 80 }, 69,
    { previousVitals: prior,
      currentVitals: { ...prior, vigor: { value: 80, scale_max: 200 } } },
  );
  const customVigorReady = classifyClientEvent(
    { kind: 'stat', name: 'vigor', value: 60, max: 80 }, 69,
    { previousVitals: { ...prior, vigor: { value: 59, scale_max: 200 } },
      currentVitals: { ...prior, vigor: { value: 60, scale_max: 200 } },
      policy: { restBelow: 0.3 } },
  );
  const ability = classifyClientEvent(
    { kind: 'stat', name: 'slash', value: 42, max: 100 }, 69,
    { previousVitals: prior, currentVitals: prior },
  );
  const death = classifyClientEvent({ kind: 'death' }, 8);
  const moved = classifyClientEvent({ kind: 'moved' }, 8);
  const object = classifyClientEvent({ kind: 'object' }, 8);
  ok('a health decrease enters the safety lane', hurt.safety && hurt.reason === 'health-decreased' && hurt.health === 8);
  ok('an upward health packet without enough context is observation-only',
     !heal.safety && !heal.decision && heal.health === 15);
  ok('a no-op health packet is observation-only',
     !same.safety && !same.decision && same.health === 12);
  ok('crossing a configured health recovery threshold wakes a decision',
     healthReady.decision && !healthReady.safety && healthReady.thresholdCrossed &&
       healthReady.reason === 'vital-threshold-crossed:health');
  ok('crossing the raw mana casting threshold wakes a decision',
     manaReady.decision && manaReady.reason === 'vital-threshold-crossed:mana');
  ok('vigor uses scale_max and wakes when it crosses the resting threshold',
     vigorReady.decision && vigorReady.vitals.vigor.max === 200 &&
       vigorReady.reason === 'vital-threshold-crossed:vigor');
  ok('a configured vigor fraction is also an exact decision threshold',
     customVigorReady.decision && customVigorReady.thresholdCrossed);
  ok('non-vital bulk stat packets are observation-only',
     !ability.safety && ability.decision === false);
  ok('death is always safety-critical and decision-relevant',
     death.safety && death.decision && death.reason === 'client:death');
  ok('movement is observation-only', !moved.safety && moved.decision === false);
  ok('unknown/ordinary domain events remain conservatively decision-relevant',
     !object.safety && object.decision === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
