// Offline guard for CARRIED ASSIGNMENTS (tools/m59-keeper-carry.mjs): a character's claims, busy
// declaration, live policy and mode survive a keeper roll -- the no-logout handoff, a stop and
// the sweep, a SIGTERM -- and never override a roster that changed. Opens no socket.
//
//   node tools/m59-keeper-carry-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carryFile, captureCarry, writeCarry, readCarry, consumeCarry, policyToAdopt, leasesToAdopt,
         CARRY_MAX_AGE_MS } from './m59-keeper-carry.mjs';

const dir = mkdtempSync(join(tmpdir(), 'm59-carry-test-'));
const roster = join(dir, 'fleets', 'prod.json');
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${name}`); };
const now = 1_800_000_000_000;

const claims = new Map([
  ['movement', { owner: 'fleetscript/crypt@pid-1', until: now + 60_000, at: now - 600_000, why: 'crypt run' }],
  ['work', { owner: 'fleetscript/crypt@pid-1', until: now + 60_000, at: now - 600_000, why: 'crypt run' }],
  ['economy', { owner: 'dum/old@pid-2', until: now - 1, at: now - 900_000, why: 'lapsed' }],
]);
const busy = { by: 'fleetscript/crypt@pid-1', kind: 'errand', label: 'levers', at: now - 30_000, until: now + 120_000 };
const bootPolicy = { hunt: 'skeleton', confineRooms: [38], fleeBelow: 0.4 };
const livePolicy = { hunt: 'statue', confineRooms: [2601], fleeBelow: 0.4, assignedRoom: 2601 };

ok('the carry file is keyed to the ROSTER FILE and the agent, beside the roster', () => {
  const f = carryFile(roster, 't5');
  assert.equal(f, join(dir, 'fleets', '.keeper-carry', 'prod.json-t5.json'));
});

ok('capture: live leases, busy, and exactly the policy the keeper was TOLD since boot', () => {
  const c = captureCarry({ agent: 't5', character: 'Bunsen', pid: 10, reason: 'handoff', claims, busy,
    bootPolicy, livePolicy, bootMode: 'goap', liveMode: 'farm', now });
  assert.deepEqual(c.claims.map(x => x.faculty).sort(), ['movement', 'work'], 'a lapsed lease is not carried');
  assert.equal(c.busy.label, 'levers');
  assert.deepEqual(Object.keys(c.policy_overrides).sort(), ['assignedRoom', 'confineRooms', 'hunt']);
  assert.deepEqual(c.policy_overrides.hunt, { boot: 'skeleton', live: 'statue' });
  assert.deepEqual(c.mode, { boot: 'goap', live: 'farm' });
});

ok('write -> read round trip; the wrong character, our own pid, or a stale file are refused', () => {
  const f = carryFile(roster, 't5');
  const c = captureCarry({ agent: 't5', character: 'Bunsen', pid: 10, reason: 'handoff', claims, busy,
    bootPolicy, livePolicy, now });
  writeCarry(f, c);
  assert.ok(readCarry(f, { agent: 't5', character: 'bunsen', pid: 11, now }), 'the replacement adopts it');
  assert.equal(readCarry(f, { agent: 't5', character: 'Floyd', pid: 11, now }), null, 'not another character');
  assert.equal(readCarry(f, { agent: 't6', pid: 11, now }), null, 'not another agent');
  assert.equal(readCarry(f, { agent: 't5', pid: 10, now }), null, 'not the process that wrote it');
  assert.equal(readCarry(f, { agent: 't5', pid: 11, now: now + CARRY_MAX_AGE_MS + 1 }), null, 'not a stale one');
  writeFileSync(f, '{not json'); assert.equal(readCarry(f, { agent: 't5', pid: 11, now }), null, 'not a torn one');
  consumeCarry(f); assert.equal(existsSync(f), false);
});

ok('policy: carried where the roster has not moved; the ROSTER WINS where it has', () => {
  const c = captureCarry({ agent: 't5', pid: 10, reason: 'stop', claims, busy, bootPolicy, livePolicy,
    bootMode: 'goap', liveMode: 'farm', now });
  const same = policyToAdopt(c, bootPolicy, 'goap');
  assert.deepEqual(same.fields, { hunt: 'statue', confineRooms: [2601], assignedRoom: 2601 });
  assert.equal(same.mode, 'farm');
  // The operator edited the roster's hunt and rolled keepers to apply it.
  const edited = policyToAdopt(c, { ...bootPolicy, hunt: 'zombie' }, 'goap');
  assert.equal(edited.fields.hunt, undefined, 'the roster edit is not undone');
  assert.deepEqual(edited.skipped, ['hunt']);
  assert.deepEqual(edited.fields.confineRooms, [2601], 'the rest still carries');
  assert.equal(policyToAdopt(c, bootPolicy, 'farm').mode, null, 'a roster mode change wins too');
});

ok('leases keep their OWN expiry: none revived, none extended, and busy needs its owner', () => {
  const c = captureCarry({ agent: 't5', pid: 10, reason: 'handoff', claims, busy, now });
  const at = leasesToAdopt(c, now + 1000);
  assert.deepEqual([...at.claims.keys()].sort(), ['movement', 'work']);
  assert.equal(at.claims.get('movement').until, now + 60_000, 'not extended');
  assert.equal(at.claims.get('movement').at, now - 600_000, '"driving since" survives the roll');
  assert.equal(at.busy.label, 'levers');
  const later = leasesToAdopt(c, now + 90_000);
  assert.equal(later.claims.size, 0, 'lapsed while the replacement was starting');
  assert.equal(later.busy, null, 'busy without its claim is not carried');
});

ok('the keeper writes the carry on handoff, stop and SIGTERM, adopts before start(), and drops it on cancel/lapse', () => {
  const src = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
  for (const why of ["writeAssignmentCarry('handoff')", "writeAssignmentCarry('stop')", "writeAssignmentCarry('SIGTERM')"])
    assert.ok(src.includes(why), why);
  const adopt = src.indexOf('leasesToAdopt(carried)'), start = src.indexOf('autopilot.start();', adopt);
  assert.ok(adopt > 0 && start > adopt, 'leases are set before the autopilot starts');
  assert.ok(/asked\.cancel\) \{\s*handoff = null;\s*consumeCarry\(CARRY_FILE\);/.test(src), 'a cancelled handoff drops it');
  assert.ok(src.includes('handoff = null; consumeCarry(CARRY_FILE); return;'), 'a lapsed handoff drops it');
  assert.ok(src.indexOf('const bootPolicy = structuredClone(') < src.indexOf('let policy = entry.autopilot?.policy'),
    'the boot policy is cloned before anything can mutate it');
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${n} passed`);
