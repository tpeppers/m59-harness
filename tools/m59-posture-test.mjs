#!/usr/bin/env node
// POSTURES, LIVE HALF (tools/m59-posture.mjs), against a fake broker. Offline: opens no socket, joins nobody.
//
// What it pins, each from prod: a hazardous order (survival off) is refused unless accepted by name and nothing is
// pushed; a keeper handoff that resets orders is caught by `tend` and re-pushed; a piloted or absent character is not
// re-ordered; a lease releases itself through `tend`; a refused start shows as a read-back failure, not success.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'posture-'));
process.env.M59_POSTURE_DIR = join(dir, 'postures');
process.env.M59_POSTURE_SAVES = join(dir, 'saves');
const { mkdirSync } = await import('node:fs');
mkdirSync(process.env.M59_POSTURE_DIR);
writeFileSync(join(process.env.M59_POSTURE_DIR, 'hold-38.mjs'), `export default { name: 'hold-38', orders: { assigned_room: 38, town_trips: false } };`);
writeFileSync(join(process.env.M59_POSTURE_DIR, 'grim.mjs'), `export default { name: 'grim', orders: { assigned_room: 38, survival_enabled: false, flee_below: 0.000001 } };`);
const P = await import('./m59-posture.mjs');

let passed = 0, failed = 0;
const ok = (what, cond) => { if (cond) { passed++; console.log('  ok  ', what); } else { failed++; console.log('  FAIL', what); } };
const section = t => console.log(`\n${t}`);
const quiet = () => {};
const camel = k => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

// The fake broker: a policy per agent; `start` applies keys unless `refuse` names the agent.
function fakeBroker(units) {
  const policy = Object.fromEntries(units.map(u => [u.agent, { assignedRoom: 70, townTrips: true }]));
  const calls = [], refuse = new Set();
  const call = async (name, args = {}) => {
    calls.push({ name, ...args });
    if (name === 'fleet') return { fleet: units.map(u => ({ activity: 'farming', ...u })) };
    if (name === 'autopilot' && args.action === 'status') return { policy: { ...policy[args.agent] } };
    if (name === 'autopilot' && args.action === 'start') {
      if (refuse.has(args.agent)) return { started: false, reason: 'farm mode needs something to hunt' };
      for (const [k, v] of Object.entries(args)) if (!['agent', 'action', 'why'].includes(k)) policy[args.agent][camel(k)] = v;
      return { started: true };
    }
    if (name === 'job_pause') return { paused: [] };
    throw new Error(`unexpected call ${name}`);
  };
  return { call, calls, policy, refuse };
}

section('hazards have to be accepted by name');
{
  ok('survival_enabled:false is a hazard', P.hazardsOf([{ agent: 't1', orders: { survival_enabled: false } }])[0]?.id === 'survival_off');
  ok('an ordinary lockdown has none', P.hazardsOf([{ agent: 't1', orders: { assigned_room: 38, town_trips: false } }]).length === 0);
  const b = fakeBroker([{ agent: 't1' }]);
  let err = null; try { await P.apply('grim', { fleet: 'test', call: b.call, log: quiet }); } catch (e) { err = e.message; }
  ok('unaccepted: refused, naming the flag to pass', /--accept survival_off,no_flee/.test(err ?? ''));
  ok('and nothing was pushed or saved', !b.calls.some(c => c.action === 'start') && P.readSave('test', 'grim') == null);
  err = null; try { await P.apply('grim', { fleet: 'test', call: b.call, accept: ['survival_off'], log: quiet }); } catch (e) { err = e.message; }
  ok('accepting one of two is still refused', /no_flee/.test(err ?? ''));
  const r = await P.apply('grim', { fleet: 'test', call: b.call, accept: ['survival_off', 'no_flee'], log: quiet });
  ok('accepting both applies it and the save says what was accepted', !r.failed.length && P.readSave('test', 'grim').accepted.join() === 'survival_off,no_flee');
  await P.release('grim', { fleet: 'test', call: b.call, log: quiet });
}

section('tend: a handoff that resets orders is caught and re-pushed');
{
  const b = fakeBroker([{ agent: 't1' }, { agent: 't2' }, { agent: 't3', piloted: true }]);
  await P.apply('hold-38', { fleet: 'tend', call: b.call, log: quiet });
  ok('applied and read back on the two unpiloted characters', b.policy.t1.assignedRoom === 38 && b.policy.t2.assignedRoom === 38 && b.policy.t3.assignedRoom === 70);
  let r = await P.tend({ fleet: 'tend', call: b.call, log: quiet });
  ok('nothing drifted: tend pushes nothing', r[0].drift.length === 0 && b.calls.filter(c => c.action === 'start').length === 2);
  b.policy.t2 = { assignedRoom: 70, townTrips: true };                      // restart-keepers: back to the roster
  const lines = []; r = await P.tend({ fleet: 'tend', call: b.call, log: l => lines.push(l) });
  ok('the reset is found, by key', r[0].drift[0]?.agent === 't2' && r[0].drift[0].keys.join() === 'assigned_room,town_trips');
  ok('and re-pushed', b.policy.t2.assignedRoom === 38 && b.policy.t2.townTrips === false);
  ok('the drift is kept on the save', P.readSave('tend', 'hold-38').drift.length === 1);
  b.policy.t2 = { assignedRoom: 70 }; b.refuse.add('t2');
  lines.length = 0; await P.tend({ fleet: 'tend', call: b.call, log: l => lines.push(l) });
  ok('a refused re-push is said out loud, not reported as fixed', lines.some(l => /t2 STILL does not hold assigned_room/.test(l)));
  b.refuse.clear();
  const before = b.calls.length;
  await P.tend({ fleet: 'tend', dry: true, call: b.call, log: quiet });
  ok('a dry tend reads and pushes nothing', b.calls.slice(before).every(c => c.action !== 'start'));
  await P.release('hold-38', { fleet: 'tend', call: b.call, log: quiet });
}

section('a lease comes off by itself');
{
  ok('parseDuration: 90m, 2h, 30s', P.parseDuration('90m') === 5_400_000 && P.parseDuration('2h') === 7_200_000 && P.parseDuration('30s') === 30_000);
  const b = fakeBroker([{ agent: 't1' }]);
  await P.apply('hold-38', { fleet: 'lease', call: b.call, forMs: 3_600_000, log: quiet });
  const save = P.readSave('lease', 'hold-38');
  ok('the save carries its expiry', save.expires_at > Date.now() && !P.expired(save));
  let r = await P.tend({ fleet: 'lease', call: b.call, log: quiet, now: Date.now() + 60_000 });
  ok('before it runs out, tend holds', !r[0].expired && P.readSave('lease', 'hold-38').active);
  r = await P.tend({ fleet: 'lease', call: b.call, log: quiet, now: Date.now() + 3_700_000 });
  ok('after, tend releases it', r[0].expired && r[0].released && !P.readSave('lease', 'hold-38').active);
  ok('and the character is back where it was', b.policy.t1.assignedRoom === 70 && b.policy.t1.townTrips === true);
}

console.log('the fleet reply as prod sends it (deploy-2026-10-27-1)');
{
  const prod = { agents: 24, fleet: [
    { agent: 't12', character: 'Fozzie', health: '86/86', room: 'The Jasper Inn', room_num: 370, activity: 'resting' },
    { agent: 'hk1', character: 'Loial', health: '20/20', room: 'The Jasper Inn', room_num: 370 },
    { agent: 't3', character: 'X', health: { value: 40, max: 50 }, room: { num: 39 } },
  ] };
  const u = P.unitsFromFleet(prod);
  ok('a non-array `agents` beside the rows does not hide them', u.length === 3, JSON.stringify(u.map(x => x.agent)));
  ok('max health from the "86/86" string', u[0].max_health === 86 && u[1].max_health === 20 && u[2].max_health === 50, JSON.stringify(u.map(x => x.max_health)));
  ok('room from room_num, not the room name', u[0].room === 370 && u[2].room === 39, JSON.stringify(u.map(x => x.room)));
  const picked = P.selectUnits({ who: { min_max_health: 31 } }, u).map(x => x.agent);
  ok('min_max_health 31 selects the 86 and the 50, not the 20', picked.join() === 't12,t3', picked.join());
  ok('a bare array still works', P.unitsFromFleet([{ agent: 't1', max_health: 60, room: 70 }])[0].room === 70);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
