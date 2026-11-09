#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureInterestStore, _clearInterestCache } from './m59-interest-store.mjs';
import { interest, inventorySalePlan } from './m59-skills.mjs';
import { Autopilot } from './m59-autopilot.mjs';

const directory = mkdtempSync(join(tmpdir(), 'm59-interest-identity-'));
configureInterestStore({ directory, namespace: 'identity-test' });
try {
  const client = {
    inventory: [ { id: 1, nameRsc: 1, amount: 4 }, { id: 2, nameRsc: 2, amount: 57 },
      { id: 3, nameRsc: 3, amount: 21 }, { id: 4, nameRsc: 4, amount: 9 } ],
    rsc: new Map([[1, 'mushroom'], [2, 'blue mushroom'], [3, 'red mushroom'], [4, 'edible mushroom']]),
    using: new Set(),
  };
  const keeper = Object.create(Autopilot.prototype);
  Object.assign(keeper, {
    name: 'ingredient-desk', policy: {}, s: { client, world: { room: { num: 552 } } },
    reagentCount: () => ({ elderberry: 100, herbs: 100 }), larder: () => [1],
    loadout: () => ({ carry: [{ item: 'mushroom', min: 24, max: 48, match: 'exact' },
      { item: 'sword', min: 1, max: 2, match: 'contains' }] }),
    packAsItems: () => [], countOfKind: () => 0, autobalanceObserve: () => {}, autobalanceCouriers: () => null,
    isServicePost: () => true,
    _reagentShortfall: new Map([['edible mushroom', { target: 1, since: Date.now() }]]),
  });
  keeper.declareInterest();
  interest.byAgent.delete(keeper.name); // Read the published record as another keeper would.
  _clearInterestCache();
  assert.deepEqual(Object.fromEntries(interest.records().get(keeper.name).wantMatches),
    { mushroom: 'exact', sword: 'contains', 'edible mushroom': 'exact' });
  assert.deepEqual(interest.wantedBy('mushrooms'), [keeper.name]);
  assert.deepEqual(interest.wantedBy('edible mushrooms'), [keeper.name]);
  assert.deepEqual(interest.wantedBy('red mushroom'), []);
  assert.deepEqual(interest.wantedBy('blue mushroom'), []);
  assert.deepEqual(interest.wantedBy('short sword'), [keeper.name]);

  const seller = { name: 'ocean-farmer', need: () => client };
  const rows = options => inventorySalePlan(seller, options).items;
  assert.equal(rows().find(row => row.id === 2).state, 'sell');
  assert.equal(rows({ protect: ['blue mushroom'] }).find(row => row.id === 2).blocked, 'protected item');
  assert.equal(rows({ exclude: new Set([2]) }).find(row => row.id === 2).blocked, 'held out of the offer by the caller');
  assert.equal(rows({ loadout: { keep: ['blue mushroom'], sell: [], gear: { weapon: [], slots: {} }, carry: [] } })
    .find(row => row.id === 2).blocked, "this character's loadout: on the keep list");

  interest.declare('blue-caster', { wants: ['blue mushrooms'], wantMatches: { 'blue mushrooms': 'exact' } });
  interest.declare('legacy-search', { wants: ['short'] });
  interest.declare('prefix-search', { wants: ['red'], wantMatches: { red: 'prefix' } });
  assert.deepEqual(interest.wantedBy('blue mushroom'), ['blue-caster']);
  assert.equal(rows().find(row => row.id === 2).blocked, 'wanted by the fleet');
  assert.ok(interest.wantedBy('short sword').includes('legacy-search'));
  assert.deepEqual(interest.wantedBy('red mushroom'), ['prefix-search']);
  for (const agent of [keeper.name, 'blue-caster', 'legacy-search', 'prefix-search']) interest.forget(agent);
} finally {
  configureInterestStore({ enabled: false });
  rmSync(directory, { recursive: true, force: true });
}
console.log('Fleet interest keeps exact ingredients and deliberate broad wants distinct');
