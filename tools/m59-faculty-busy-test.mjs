#!/usr/bin/env node
// The real FleetScript runner borrows a bot-held character; DUM's missing-claim
// heartbeat must wait until the operation frees it. Every HTTP reply is fake.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = mkdtempSync(join(tmpdir(), 'm59-faculty-busy-'));
process.env.M59_FLEET = 'testfleet';
process.env.M59_STATE_FILE = join(scratch, 'roster.json');
process.env.M59_CONTROL_URL = 'http://127.0.0.1:1/';
process.env.M59_RUNLOCK_DIR = scratch;
process.env.M59_EVIDENCE_DIR = scratch;
process.env.M59_LEDGER_DIR = join(scratch, 'history');
process.env.M59_KEEPER_BEAT_MS = '400';
process.env.M59_KEEPER_BAND_REGISTRY = join(scratch, 'keeper-bands.json');
writeFileSync(process.env.M59_KEEPER_BAND_REGISTRY, JSON.stringify({ testfleet: 19900 }));
const { Autopilot } = await import('./m59-autopilot.mjs');
const { fleetScript, verify } = await import('./m59-fleetscript.mjs');
const { busyClaimRefusal } = await import('./m59-faculty-claim.mjs');
const DUM = 'dum/test@pid-4242', faculties = ['work', 'movement', 'economy'];
let passed = 0;
const check = (name, value, detail = '') => { assert.ok(value, `${name}${detail ? `: ${detail}` : ''}`); passed++; console.log(`  ok ${name}`); };
let walking = false, interruptions = 0;
const keeper = () => Object.assign(Object.create(Autopilot.prototype), {
  running: true, claims: new Map(), policy: {}, busy: null,
  s: { cancelMovement: () => { if (walking) interruptions++; return { cancelled: true }; } },
  note() {}, progress() {}, clearSurvivalJam() {},
});
let ap = keeper();
const originalFetch = globalThis.fetch, calls = [];
const reply = value => ({ ok: true, json: async () => value });
function action(name, args) {
  if (name === 'commander_claim') return ap.claimFaculties({ faculties: args.faculties, by: args.by, leaseMs: args.lease_ms });
  if (name === 'commander_heartbeat') return ap.heartbeatFaculties({ by: args.by, leaseMs: args.lease_ms });
  if (name === 'commander_release') return ap.releaseFaculties({ faculties: args.faculties, by: args.by });
  if (name === 'autopilot_busy') return ap.declareBusy({ by: args.by, kind: args.kind, label: args.label, leaseMs: args.lease_ms });
  if (name === 'autopilot_free') return ap.freeBusy({ by: args.by });
  return {};
}
globalThis.fetch = async (input, options) => {
  const url = String(input);
  if (url.endsWith('/health')) return reply({ state: process.env.M59_STATE_FILE });
  if (url.includes(':19900/live')) return reply({ agent: 'a1', character: 'Fixture', pid: 4242 });
  if (/127\.0\.0\.1:19\d\d\d\/live/.test(url)) throw Error('fixture port absent');
  if (url.includes(':19900/action')) { const body = JSON.parse(options.body); return reply(action(body.name, body.args)); }
  if (url.includes(':19900/cancel')) return reply(ap.s.cancelMovement());
  const body = JSON.parse(options.body), { name, arguments: args } = body.params;
  calls.push({ name, args });
  let result = {};
  if (name === 'status') result = { where: { num: 2, name: 'Fixture Room' }, hp: { value: 50, max: 50 } };
  if (name === 'look') result = { room: { num: 2, name: 'Fixture Room' }, you: { row: 10, col: 10 }, objects: [] };
  if (name === 'autopilot' && args.action === 'busy') result = action('autopilot_busy', args);
  if (name === 'autopilot' && args.action === 'free') result = action('autopilot_free', args);
  return reply({ result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
};
try {
  const now = Date.now(), busy = { by: DUM, kind: 'sale', label: 'selling', until: now + 1000 };
  check('a bare standing claim does not block another director', busyClaimRefusal({ faculty: 'movement', by: 'fleetscript:task' }) === null);
  check('the active operation names its refusal and owner', busyClaimRefusal({ busy, faculty: 'movement', by: 'fleetscript:task', now })?.code === 'busy');
  check('its own holder can refresh the claim', busyClaimRefusal({ busy, faculty: 'movement', by: DUM, now }) === null);
  check('the legacy unnamed holder can refresh its own operation', busyClaimRefusal({ busy: { ...busy, by: 'unnamed' }, faculty: 'movement', now }) === null);
  check('an expired busy lease permits a new claim', busyClaimRefusal({ busy, faculty: 'movement', by: 'fleetscript:task', now: now + 1001 }) === null);
  check('protected survival faculties retain their separate policy', busyClaimRefusal({ busy, faculty: 'survival', by: 'fleetscript:task', now }) === null);

  ap.claimFaculties({ by: DUM, faculties, leaseMs: 120000 });
  const result = await fleetScript({ name: 'manage-borrow', fleet: 'testfleet', agents: ['a1'], onLog() {},
    steps: [verify(async () => {
      check('a normal bot-held character yields to the MANAGE FleetScript', ap.facultyOwner('movement') === 'fleetscript:manage-borrow');
      check('the FleetScript owns its busy marker before the first step', ap.busyStatus()?.by === 'fleetscript:manage-borrow');
      walking = true;
      const heartbeat = ap.heartbeatFaculties({ by: DUM, leaseMs: 120000 });
      check('DUM can detect that its old claim is temporarily absent', heartbeat.renewed.length === 0);
      const reclaim = ap.claimFaculties({ by: DUM, faculties, leaseMs: 120000 });
      check('DUM cannot restore its claim over an active FleetScript', reclaim.granted.length === 0 && reclaim.refused.every(r => r.code === 'busy'));
      check('a refused DUM reclaim keeps FleetScript movement ownership', ap.facultyOwner('movement') === 'fleetscript:manage-borrow');
      await new Promise(resolve => setTimeout(resolve, 1100));
      walking = false;
      return true;
    }, 'DUM heartbeat while walking')] });
  check('the real runner completes without its busy heartbeat cancelling the walk', result.ok && interruptions === 0, JSON.stringify(result));
  check('the runner clears its own busy operation after completion', ap.busyStatus() === null);
  check('DUM can restore its claim after the FleetScript finishes', ap.claimFaculties({ by: DUM, faculties }).granted.length === faculties.length);
  check('every FleetScript busy/free request names its own holder', calls.filter(c => c.name === 'autopilot' && ['busy', 'free'].includes(c.args.action))
    .every(c => c.args.by === 'fleetscript:manage-borrow'));

  ap = keeper();
  ap.claimFaculties({ by: DUM, faculties });
  ap.declareBusy({ by: DUM, kind: 'sale', label: 'existing DUM errand', leaseMs: 120000 });
  let acted = false;
  const refused = await fleetScript({ name: 'manage-overlap', fleet: 'testfleet', agents: ['a1'], onLog() {},
    steps: [verify(() => { acted = true; return true; }, 'must not execute')] });
  check('an existing DUM operation refuses the FleetScript before any step', !refused.ok && !acted && /busy.*existing DUM errand/.test(refused.results.a1.why));
  check('refused FleetScript cleanup preserves the DUM busy marker', ap.busyStatus()?.by === DUM);
  check('refused FleetScript cleanup preserves DUM faculty ownership', ap.facultyOwner('movement') === DUM);
  check('an operator can explicitly clear the operation', ap.freeBusy({ by: null }).busy === null);
  check('the character becomes claimable after that explicit release', ap.claimFaculties({ by: 'fleetscript:manage-overlap', faculties }).granted.length === faculties.length);
  check('the default protected survival faculty remains unclaimable', ap.claimFaculties({ by: DUM, faculties: ['survival'] }).granted.length === 0);
  console.log(`\n${passed} passed`);
} finally {
  walking = false;
  globalThis.fetch = originalFetch;
  rmSync(scratch, { recursive: true, force: true });
}
