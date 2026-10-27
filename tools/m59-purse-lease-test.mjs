#!/usr/bin/env node
// AN ERRAND'S PURSE LEASE -- offline, no socket, no roster.
//
//   node tools/m59-purse-lease-test.mjs
//
// What this pins (tools/m59-purse-lease.mjs), from prod 2026-10-26: a courier withdrew 6000 for a reagent run and the
// chalice holder's banking rule deposited it straight back (purse 400), so every buy read "sold out" for hours.
//   * a lease raises the float every banking rule keeps, and bank_above, to its carry, and lapses by itself;
//   * a lease is bounded (an hour by default, 12 h at most) and a malformed one is refused;
//   * EVERY keeper float read goes through walkingFloat(): no deposit path reads walkingMoney on its own any more;
//   * both bank-trip triggers read bankAboveNow(); status reports the lease; the broker and the bank tool can set it.
const { normalizePurseLease, leaseCarry, walkingFloatOf, bankAboveOf, PURSE_LEASE_DEFAULT_MS, PURSE_LEASE_MAX_MS } =
  await import('./m59-purse-lease.mjs');
import { readdirSync, readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};
const throws = fn => { try { fn(); return null; } catch (e) { return e.message; } };

console.log('the lease');
const now = 10_000_000;
const l = normalizePurseLease({ carry: 6000, owner: 'herb run' }, now);
ok('default term is an hour', l.until === now + PURSE_LEASE_DEFAULT_MS && l.carry === 6000 && l.owner === 'herb run');
ok('at most 12 hours', normalizePurseLease({ carry: 1, ms: 99 * 3_600_000 }, now).until === now + PURSE_LEASE_MAX_MS);
ok('a carry of nothing is refused', /positive/.test(throws(() => normalizePurseLease({ carry: 0 })) ?? ''));
ok('under a minute is refused', /60000/.test(throws(() => normalizePurseLease({ carry: 5, ms: 10 })) ?? ''));
ok('null clears', normalizePurseLease(null) === null);

console.log('what the banking rules keep');
const policy = { walkingMoney: 400, bankAbove: 500, purseLease: l };
ok('THE BUG: a live lease keeps the errand money (6000, not 400)', walkingFloatOf(policy, now + 1000) === 6000);
ok('and no bank trip fires on it (bank_above is at least the carry)', bankAboveOf(policy, now + 1000) === 6000);
ok('it lapses by itself, back to the standard float', walkingFloatOf(policy, l.until + 1) === 400 && bankAboveOf(policy, l.until + 1) === 500);
ok('a lease never lowers a bigger float', walkingFloatOf({ walkingMoney: 15000, purseLease: l }, now) === 15000);
ok('bank_above off stays off', bankAboveOf({ bankAbove: 0, purseLease: l }, now) === 0);
ok('a lease without a valid until is not live', leaseCarry({ purseLease: { carry: 5000 } }, now) === 0);
ok('no lease: walkingMoney, default 400', walkingFloatOf({}, now) === 400);

console.log('every deposit path reads the leased float');
{
  const dir = new URL('./autopilot/', import.meta.url);
  const raw = readdirSync(dir).filter(f => f.endsWith('.mjs')).flatMap(f =>
    readFileSync(new URL(f, dir), 'utf8').split('\n').map((line, i) => ({ f, i: i + 1, line })));
  const code = raw.filter(r => !/^\s*\/\//.test(r.line));
  const direct = code.filter(r => /policy\.walkingMoney/.test(r.line));
  ok('no keeper part reads policy.walkingMoney directly', direct.length === 0, direct.map(r => `${r.f}:${r.i}`).join(' '));
  const above = code.filter(r => /const above = this\.policy\.bankAbove/.test(r.line));
  ok('no bank-trip trigger reads bankAbove directly', above.length === 0, above.map(r => `${r.f}:${r.i}`).join(' '));
  ok('the chalice holder\'s deposit keeps walkingFloat()', code.some(r => r.f === 'chalice.mjs' && /Math\.max\(this\.walkingFloat\(\), this\.shoppingPlan/.test(r.line)));
}

console.log('the keeper');
{
  const { Autopilot } = await import('./m59-autopilot.mjs');
  const k = Object.assign(Object.create(Autopilot.prototype), { policy: { walkingMoney: 400, bankAbove: 500,
    purseLease: normalizePurseLease({ carry: 6000, owner: 'herb run' }) } });
  ok('walkingFloat() honours the lease', k.walkingFloat() === 6000);
  ok('bankAboveNow() honours the lease', k.bankAboveNow() === 6000);
  const st = k.purseLeaseStatus();
  ok('status says it is live, whose, and for how long', st.live === true && st.owner === 'herb run' && st.left_min > 59, JSON.stringify(st));
  k.policy.purseLease.until = Date.now() - 1;
  ok('and that it lapsed', k.purseLeaseStatus().live === false && k.walkingFloat() === 400);
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('purseLease defaults to null', /purseLease: null,/.test(src));
  const broker = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  ok('the broker takes purse_lease and the bank tool takes lease_ms', /purse_lease: \{ type:/.test(broker) && /lease_ms: \{ type: 'number'/.test(broker));
  const kp = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
  ok('a leased withdrawal sets the lease on the keeper\'s live policy', /autopilot\.policy\.purseLease = purseLease/.test(kp));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
