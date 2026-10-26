#!/usr/bin/env node
// NAMED HAZARDS (tools/m59-hazards.mjs). Offline: opens no socket, joins nobody.
//
// What it pins: survival off is a lease that runs out by itself; a flag with no lease stays off, as before; a journey
// for a survival-off body is refused unless it goes to an inn or accepts survival_off_move; the refusal names the flag.
import { HAZARDS, refusal, survivalOffOf, survivalOffLeaseMs, survivalOffConflict, SURVIVAL_OFF_DEFAULT_MS, SURVIVAL_OFF_MAX_MS } from './m59-hazards.mjs';

let passed = 0, failed = 0;
const ok = (what, cond) => { if (cond) { passed++; console.log('  ok  ', what); } else { failed++; console.log('  FAIL', what); } };
const T = 1_800_000_000_000;

console.log('\nsurvival off is a lease');
ok('on is on', !survivalOffOf({ survivalEnabled: true }, T) && !survivalOffOf({}, T) && !survivalOffOf(null, T));
ok('off inside its lease', survivalOffOf({ survivalEnabled: false, survivalOffUntil: T + 1 }, T));
ok('ON again once the lease runs out, whatever the stored flag says', !survivalOffOf({ survivalEnabled: false, survivalOffUntil: T }, T));
ok('a flag with no lease stays off (pushed straight to a keeper, or older than leases)', survivalOffOf({ survivalEnabled: false }, T));
ok('default lease is 30 minutes', survivalOffLeaseMs() === SURVIVAL_OFF_DEFAULT_MS && SURVIVAL_OFF_DEFAULT_MS === 1_800_000);
ok('a long one is clamped to 12 hours', survivalOffLeaseMs(48 * 3_600_000) === SURVIVAL_OFF_MAX_MS);
let threw = false; try { survivalOffLeaseMs(5) } catch { threw = true; }
ok('a lease under a minute is refused (a typo in seconds)', threw);

console.log('\na journey for a survival-off body');
const inns = [{ inn: 370, innName: 'Yonder Inn of Jasper' }, { inn: 52, innName: 'Familiars' }];
const pol = { t13: { survivalEnabled: false, survivalOffUntil: T + 60_000 }, t1: { survivalEnabled: true } };
const ask = (args, tool = 'travel') => survivalOffConflict({ tool, args, policyOf: a => pol[a] ?? null, inns, now: T });
const r = ask({ agent: 't13', to: 599 });
ok('to Ukgoth: refused, naming the character and the flag', r?.id === 'survival_off_move' && /t13 -> 599/.test(r.error) && /accept: \["survival_off_move"\]/.test(r.error));
ok('to an inn by number: allowed', ask({ agent: 't13', to: 370 }) === null);
ok('to an inn by name: allowed', ask({ agent: 't13', to: 'yonder inn of jasper' }) === null);
ok('accepted by name: allowed', ask({ agent: 't13', to: 599, accept: ['survival_off_move'] }) === null);
ok('a character with survival on: untouched', ask({ agent: 't1', to: 599 }) === null);
ok('after the lease has run out: untouched', survivalOffConflict({ tool: 'travel', args: { agent: 't13', to: 599 }, policyOf: a => pol[a], inns, now: T + 60_000 }) === null);
ok('walk_to stays in the room: not this guard', ask({ agent: 't13', col: 3, row: 4 }, 'walk_to') === null);
ok('a combat order is not this guard: combat mode keeps its own stop_below', ask({ agent: 't13', action: 'kill', target: 'X' }, 'combat') === null);

console.log('\nthe keeper honours the lease');
{
  const { Autopilot } = await import('./m59-autopilot.mjs');
  const k = Object.create(Autopilot.prototype);
  Object.assign(k, { s: {}, policy: { survivalEnabled: false, survivalOffUntil: Date.now() + 60_000 } });
  ok('inside the lease the pass stands down', k.operatorSurvivalStandDown() === true);
  k.policy.survivalOffUntil = Date.now() - 1;
  ok('after it, the pass runs again: survival is back without anybody restoring it', k.operatorSurvivalStandDown() === false);
}

console.log('\nthe refusal');
ok('every hazard has a reason', Object.values(HAZARDS).every(w => typeof w === 'string' && w.length > 20));
ok('a refusal says nothing was done and how to mean it', /Nothing was done/.test(refusal('go_red')) && /--accept go_red/.test(refusal('go_red')));

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
