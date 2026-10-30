// Offline only. All writes are confined to per-test temporary directories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blankLootPolicies, validateLootPolicies, decideLoot, LootPolicyStore, lootPolicyDiagnostics, sessionLootDecision, observedLootItem } from './m59-loot-policies.mjs';
import { LootPolicyControls } from './m59-loot-policy-controls.mjs';
const profile = action => ({ name: action, rules: [{ item: 'purple mushroom', action }] });
const doc = action => { const d = blankLootPolicies(); d.profiles.main = profile(action); d.assignments.fleet = 'main'; return d; };
const temporary = fn => async t => { const dir = mkdtempSync(join(tmpdir(), 'm59-loot-policy-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return fn(dir); };

test('silence preserves legacy behavior; all five dispositions have explicit pickup meaning', () => {
  assert.equal(decideLoot(blankLootPolicies(), {}, { name: 'purple mushroom' }), null);
  for (const action of ['keep', 'sell', 'vault', 'drop_town', 'leave']) {
    const d = decideLoot(validateLootPolicies(doc(action)), {}, { name: 'Purple Mushrooms' });
    assert.equal(d.action, action); assert.equal(d.pickup, action !== 'leave');
  }
  assert.equal(decideLoot(doc('vault'), {}, { name: 'mushroom' }), null);
});
test('individual then observed guild then fleet, with fallback for unmatched items', () => {
  const d = doc('sell'); d.profiles.guild = profile('vault'); d.profiles.person = profile('keep');
  d.assignments.guilds['7'] = 'guild'; d.assignments.characters.Loial = 'person';
  assert.equal(decideLoot(d, { character: 'loial', guild: 7 }, { name: 'purple mushroom' }).action, 'keep');
  assert.equal(decideLoot(d, { character: 'Other', guild: 7 }, { name: 'purple mushroom' }).action, 'vault');
  assert.equal(decideLoot(d, { character: 'Other' }, { name: 'purple mushroom' }).action, 'sell');
  d.profiles.person.rules = [];
  assert.equal(decideLoot(d, { character: 'Loial', guild: 7 }, { name: 'purple mushroom' }).action, 'vault');
});
test('quality is measured in real bands; unknown is never treated as poor', () => {
  const d = doc('vault'); Object.assign(d.profiles.main.rules[0], { min_condition: 3, otherwise: 'sell' });
  for (const condition of [null, undefined]) { const v = decideLoot(d, {}, { name: 'purple mushroom', condition }); assert.equal(v.action, 'keep'); assert.equal(v.needs_inspection, true); }
  assert.equal(decideLoot(d, {}, { name: 'purple mushroom', condition: 2 }).action, 'sell');
  assert.equal(decideLoot(d, {}, { name: 'purple mushroom', condition: 3 }).action, 'vault');
});
test('invalid or ambiguous documents fail loudly', () => {
  for (const mutate of [d => d.profiles.main.rules[0].action = 'destroy', d => d.assignments.fleet = 'missing',
    d => d.profiles.main.rules.push({ item: 'purple mushrooms', action: 'keep' }),
    d => d.profiles.main.rules[0].min_condition = 80, d => d.typo = true,
    d => d.assignments.guilds['Guild Name'] = 'main']) { const d = doc('vault'); mutate(d); assert.throws(() => validateLootPolicies(d)); }
});
test('source composition preserves provenance, writes back only selected source, and checks revisions', temporary(dir => {
  const publicFile = join(dir, 'public.json'), privateFile = join(dir, 'private.json');
  writeFileSync(publicFile, JSON.stringify(doc('sell')));
  const privateDoc = blankLootPolicies(); privateDoc.profiles.private = profile('vault'); privateDoc.assignments.characters.Loial = 'private';
  writeFileSync(privateFile, JSON.stringify(privateDoc));
  const store = new LootPolicyStore(join(dir, 'roster.json'), { sources: [{ path: publicFile, writable: true }, { path: privateFile, writable: true }] });
  const before = store.snapshot(); assert.equal(before.provenance.profiles.private, privateFile);
  assert.equal(decideLoot(store.read(), { character: 'Loial' }, { name: 'purple mushroom' }).action, 'vault');
  const publicBytes = readFileSync(publicFile, 'utf8'); privateDoc.profiles.private.rules[0].action = 'keep';
  const after = store.save(privateDoc, before.revision, privateFile);
  assert.equal(readFileSync(publicFile, 'utf8'), publicBytes);
  assert.notEqual(after.revision, before.revision);
  assert.throws(() => store.save(privateDoc, before.revision, privateFile), /changed/);
  assert.throws(() => store.save(privateDoc, after.revision, join(dir, 'unregistered.json')), /registered/);
}));
test('read-only sources, duplicate profiles and broken JSON are not silently overridden', temporary(dir => {
  const file = join(dir, 'repo.json'); writeFileSync(file, JSON.stringify(doc('keep')));
  const store = new LootPolicyStore(join(dir, 'roster'), { sources: [file] }); const snap = store.snapshot();
  assert.throws(() => store.save(doc('sell'), snap.revision, file), /registered/);
  assert.throws(() => store.save(doc('sell'), snap.revision), /two sources/);
  writeFileSync(file, '{broken'); assert.throws(() => store.read());
  const decision = sessionLootDecision({ lootPolicyStore: store, client: { me: { name: 'Loial' }, rsc: { get: () => 'mace' } } }, { id: 1 });
  assert.equal(decision.action, 'keep'); assert.equal(decision.pickup, false); assert.equal(decision.error, true);
}));
test('assignment overrides are case-insensitive, visible, and can reference another source profile', temporary(dir => {
  const file = join(dir, 'repo.json'), d = doc('keep'); d.assignments.characters.Loial = 'main'; writeFileSync(file, JSON.stringify(d));
  const store = new LootPolicyStore(join(dir, 'roster'), { sources: [file] }); const local = blankLootPolicies();
  local.profiles.personal = profile('vault'); local.assignments.characters.loial = 'personal'; local.assignments.guilds['7'] = 'main';
  const result = store.save(local, store.snapshot().revision);
  assert.equal(decideLoot(result.effective, { character: 'LOIAL' }, { name: 'purple mushroom' }).action, 'vault');
  assert.ok(result.warnings.some(w => w.code === 'assignment_override'));
}));
test('writer lock never gets removed or overwritten by a competing editor', temporary(dir => {
  const store = new LootPolicyStore(join(dir, 'roster'), { sources: [] }); const before = store.snapshot();
  mkdirSync(store.path + '.lock'); assert.throws(() => store.save(doc('vault'), before.revision), /EEXIST/);
  assert.equal(store.snapshot().revision, before.revision);
}));

test('an earlier repository may assign a profile defined by a later repository', temporary(dir => {
  const early = join(dir, 'early.json'), later = join(dir, 'later.json');
  const assignment = blankLootPolicies(); assignment.assignments.fleet = 'main';
  const definition = doc('vault'); definition.assignments.fleet = null;
  writeFileSync(early, JSON.stringify(assignment)); writeFileSync(later, JSON.stringify(definition));
  const store = new LootPolicyStore(join(dir, 'roster'), { sources: [early, later] });
  assert.equal(decideLoot(store.read(), {}, { name: 'purple mushroom' }).action, 'vault');
}));
test('keep/vault versus ignore is an error in legacy rules and an explained override with a disposition', () => {
  const legacy = { vaultItems: ['purple mushroom'], lootIgnore: [{ name: 'purple mushroom' }] };
  assert.equal(lootPolicyDiagnostics(blankLootPolicies(), {}, legacy)[0].code, 'unreachable_accumulation');
  assert.equal(lootPolicyDiagnostics(doc('vault'), {}, legacy)[0].code, 'pickup_override');
  assert.ok(lootPolicyDiagnostics(doc('vault'), {}, { townTrips: false }).some(r => r.code === 'town_trips_disabled'));
});
test('condition evidence is name-bound and expires', () => {
  const c = { rsc: { get: () => 'mace' }, _lootCondition: new Map([[1, { name: 'mace', level: 4, at: 1000 }]]) };
  assert.equal(observedLootItem(c, { id: 1 }, 2000).condition, 4);
  assert.equal(observedLootItem(c, { id: 1 }, 62000).condition, null);
  c.rsc.get = () => 'sword'; assert.equal(observedLootItem(c, { id: 1 }, 2000).condition, null);
});
test('control preview writes nothing; wrong broker and old keepers cannot save', temporary(async dir => {
  const stateFile = join(dir, 'roster'), control = new LootPolicyControls({ stateFile, pid: 7, sources: [], members: async () => [{ agent: 't1', character: 'Example', status: {} }] });
  const read = await control.run({ action: 'read' });
  const body = { action: 'preview', source: control.store.path, document: doc('vault'), expected_state: stateFile, expected_pid: 7, expected_revision: read.revision };
  const preview = await control.run(body); assert.equal(preview.effective.profiles.main.rules[0].action, 'vault');
  assert.equal(control.store.snapshot().revision, read.revision);
  await assert.rejects(control.run({ ...body, expected_pid: 8 }), /Broker/);
  await assert.rejects(control.run({ ...body, action: 'save' }), /compatible/);
}));

test('control saves with matching keeper evidence and refuses an unobserved revision', temporary(async dir => {
  const stateFile = join(dir, 'roster'); let revision;
  const control = new LootPolicyControls({ stateFile, pid: 7, sources: [], members: async () => [{ agent: 'fixture', character: 'Example', status: { protocol: 1, available: true, revision } }] });
  revision = control.store.snapshot().revision;
  const body = { action: 'save', source: control.store.path, document: doc('vault'), expected_state: stateFile, expected_pid: 7, expected_revision: revision };
  const result = await control.run(body);
  assert.equal(result.saved, true); assert.equal(result.applied, false);
  assert.equal(control.store.read().profiles.main.rules[0].action, 'vault');
  await assert.rejects(control.run({ ...body, expected_revision: result.revision }), /not yet observed/);
}));
