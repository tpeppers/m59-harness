#!/usr/bin/env node
// HOW MUCH OF THIS RUN WAS REAL. Offline: no server, no DM socket, no broker.
//
//   node tools/m59-fidelity-test.mjs
//
// The three loads of one raid script, which are three different questions rather than three
// configs (operator, 2026-09-11), and the thing that makes them distinguishable afterwards:
//
//   1. PREPARED       clone the fleet, DM-skip to everyone armed and standing in the hall.
//                     Answers "does the fight work", and nothing about getting there.
//   2. PROD-FAITHFUL  rebuild the scene, then NO DM command at all. The only mode whose result
//                     transfers to production — so it REFUSES a shortcut rather than footnoting it.
//   3. THE GAP LEDGER Every shortcut written down at the moment it is taken, because that is the
//                     only way to look back after a bad prod run and see which one to regret.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fidelity, permits, recordGap, gradeRun, formatGaps, MODES, FIDELITY_COST,
         appendGapLog, readGapLog, shortcutHistory } from './m59-fidelity.mjs';
import { checkpoint, reach } from './m59-establish.mjs';

const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};
const LAB = { M59_ADMIN_HOST: '127.0.0.1' };
const threw = f => { try { f(); return null; } catch (e) { return e.message; } };

console.log('\nthe modes are a closed set, and prebuffed cannot be smuggled into a faithful run');
{
  ok('four modes', MODES.join(',') === 'prod,prod-faithful,prepared,anything', MODES.join(','));
  ok('an unknown mode is refused', /unknown fidelity mode "fast"/.test(threw(() => fidelity('fast'))));
  ok('the default claims nothing', fidelity().mode === 'anything');

  // prebuffed IS a DM preparation, so it contradicts the one claim prod-faithful makes.
  const why = threw(() => fidelity('prod-faithful', { prebuffed: true }));
  ok('prebuffed + prod-faithful is refused', !!why);
  ok('and the refusal explains the contradiction rather than just rejecting',
     /no DM command was used after the scene loaded/.test(why), why);
  ok('and it names both ways out', /'prepared'/.test(why) && /concede/.test(why), why);
  ok('prepared + prebuffed is fine', fidelity('prepared', { prebuffed: true }).prebuffed === true);
}

console.log('\nIN-GAME SOLUTIONS COST TIME. DM SHORTCUTS COST FIDELITY.');
{
  ok('played costs no fidelity however long it takes', FIDELITY_COST.played === 'none');
  for (const w of ['dm', 'scene', 'shadow'])
    ok(`${w} costs fidelity`, FIDELITY_COST[w] === 'high');

  const faithful = fidelity('prod-faithful');
  ok('a faithful run permits played', permits(faithful, 'played').ok === true);
  const p = permits(faithful, 'dm', { label: 'armed' });
  ok('and REFUSES dm', p.ok === false);
  ok('the refusal says production cannot take it',
     /production cannot take/.test(p.why), p.why);
  ok('and names both the in-game route and the concession',
     /allow\[\]/.test(p.why) && /concede it by name/.test(p.why), p.why);

  ok('a prepared run permits dm', permits(fidelity('prepared'), 'dm').ok === true);
  ok('but does not mark it bought in — nobody asked for it specifically',
     permits(fidelity('prepared'), 'dm').boughtIn === false);
}

console.log('\n2. PROD-FAITHFUL REFUSES THE SHORTCUT RATHER THAN TAKING IT QUIETLY');
{
  const calls = [];
  const cp = checkpoint('armed', {
    holds: () => (calls.length ? true : 'nobody is armed'),
    establish: { dm: () => calls.push('dm'), played: () => calls.push('played') },
  });

  const r = await reach(cp, {}, { env: LAB, fidelity: fidelity('prod-faithful') });
  ok('it establishes by PLAYED even with a lab available',
     r.ok === true && r.establishedBy === 'played', JSON.stringify(calls));
  ok('and took no fidelity cost at all', r.gaps.length === 0, JSON.stringify(r.gaps));

  // With only dm declared, a faithful run has nowhere to go — and says so.
  calls.length = 0;
  const dmOnly = checkpoint('armed', { holds: () => 'no', establish: { dm: () => calls.push('dm') } });
  const r2 = await reach(dmOnly, {}, { env: LAB, fidelity: fidelity('prod-faithful') });
  ok('with only a DM route it REFUSES', r2.ok === false);
  ok('AND THE DM COMMAND NEVER RAN', calls.length === 0);
  ok('the refusal explains it is the mode, not the machine',
     /prod-faithful/.test(r2.why), r2.why);

  // Conceding it by name is how the caller buys in.
  calls.length = 0;
  let armed = false;
  const cp3 = checkpoint('armed', { holds: () => (armed ? true : 'no'),
                                    establish: { dm: () => { calls.push('dm'); armed = true; } } });
  const r3 = await reach(cp3, {}, { env: LAB,
    fidelity: fidelity('prod-faithful', { concede: ['armed'] }) });
  ok('conceded by name, it runs', r3.ok === true && calls.length === 1);
  ok('and the gap is recorded as BOUGHT IN', r3.gaps[0].boughtIn === true, JSON.stringify(r3.gaps));
  ok('with the reason it was allowed', /named in concede/.test(r3.gaps[0].why), r3.gaps[0].why);
}

console.log('\n1. PREPARED TAKES THE SHORTCUT — AND STILL WRITES IT DOWN');
{
  let armed = false;
  const cp = checkpoint('armed', { holds: () => (armed ? true : 'no'),
                                   establish: { dm: () => { armed = true; } } });
  const run = fidelity('prepared', { prebuffed: true });
  const r = await reach(cp, {}, { env: LAB, fidelity: run });
  ok('it succeeds', r.ok === true);
  ok('and the shortcut IS recorded', r.gaps.length === 1, JSON.stringify(r.gaps));
  ok('as a fidelity cost', r.gaps[0].cost === 'high');
  ok('naming the checkpoint it closed', r.gaps[0].checkpoint === 'armed');
  ok('and NOT bought in — the mode allowed it, nobody asked for it',
     r.gaps[0].boughtIn === false);
}

console.log('\na waived UNKNOWN is a gap too — you paid without being able to tell you needed to');
{
  let n = 0;
  const cp = checkpoint('enchanted', {
    holds: () => (n++ === 0 ? null : true),          // unknown, then holds
    establish: { played: () => {} },
    cost: { played: 'expensive' },
  });
  const r = await reach(cp, {}, { env: LAB, allowUnknown: true, fidelity: fidelity('prod-faithful') });
  ok('it runs when the unknown is waived', r.ok === true);
  ok('and the waiver is recorded even though played costs no fidelity',
     r.gaps.length === 1 && r.gaps[0].unknownWaived === true, JSON.stringify(r.gaps));
  ok('with cost none, because the route itself was in-game', r.gaps[0].cost === 'none');
}

console.log('\n3. THE GRADE ANSWERS ONE QUESTION: DOES THIS TRANSFER TO PRODUCTION?');
{
  const faithful = fidelity('prod-faithful');
  ok('no shortcuts at all -> transfers',
     gradeRun(faithful, []).grade === 'transfers');
  ok('and says why', /every gap was closed the way production would have to/
     .test(gradeRun(faithful, []).why));

  const conceded = [];
  recordGap(conceded, { checkpoint: 'armed', strategy: 'dm', cost: 'high', boughtIn: true });
  ok('conceded shortcuts in a faithful run -> transfers-with-exceptions',
     gradeRun(faithful, conceded).grade === 'transfers-with-exceptions');

  const prepared = fidelity('prepared');
  ok('a prepared run with DM shortcuts -> does-not-transfer',
     gradeRun(prepared, conceded).grade === 'does-not-transfer');
  ok('and it says exactly what it DOES claim',
     /works FROM THAT STATE/.test(gradeRun(prepared, conceded).why));

  // A prepared run that happened to take no shortcut still transfers — the mode is permission,
  // not a stain.
  ok('a prepared run that took none still transfers',
     gradeRun(prepared, []).grade === 'transfers');
}

console.log('\nthe report is the list, not a score');
{
  const run = fidelity('prepared', { allow: ['sell-to-afford'] });
  const led = [];
  recordGap(led, { checkpoint: 'at the hall', strategy: 'dm', label: 'teleport',
                   cost: 'high', boughtIn: false, why: 'mode permitted it' });
  recordGap(led, { checkpoint: 'armed', strategy: 'played', cost: 'none', boughtIn: true,
                   unknownWaived: true });
  const text = formatGaps(run, led);
  ok('it leads with the count and calls them error bars',
     /2 shortcut\(s\) taken. These are the error bars/.test(text), text);
  ok('it shows the mode and the allowances', /mode: prepared/.test(text) && /sell-to-afford/.test(text));
  ok('it grades the run', /verdict: DOES-NOT-TRANSFER/.test(text), text);
  ok('a fidelity cost is shouted and an in-game one is not',
     /HIGH  at the hall/.test(text) && /time  armed/.test(text), text);
  ok('a waived unknown is flagged', /UNKNOWN WAIVED/.test(text));
  ok('and it says how to READ the list against a prod outcome',
     /taken fifty times that never/.test(text), text);
  ok('a clean run says so plainly', /\(nothing was shortcut\)/.test(formatGaps(run, [])));
}

console.log('\nthe log answers "has this shortcut ever mattered?"');
{
  const dir = mkdtempSync(join(tmpdir(), 'm59-gap-'));
  const file = join(dir, 'gaps.jsonl');
  const run = fidelity('prepared');

  const led1 = []; recordGap(led1, { checkpoint: 'armed', strategy: 'dm', label: 'teleport', cost: 'high' });
  appendGapLog(run, led1, { scenario: 'raid', outcome: 'matched', file });
  const led2 = []; recordGap(led2, { checkpoint: 'armed', strategy: 'dm', label: 'teleport', cost: 'high' });
  appendGapLog(run, led2, { scenario: 'raid', outcome: 'diverged', file });
  const led3 = []; recordGap(led3, { checkpoint: 'armed', strategy: 'dm', label: 'teleport', cost: 'high' });
  appendGapLog(run, led3, { scenario: 'raid', outcome: 'matched', file });

  ok('three runs are recorded', readGapLog(file).length === 3);
  const h = shortcutHistory('teleport', file);
  ok('the shortcut was taken three times', h.taken === 3, JSON.stringify(h));
  ok('matched twice', h.matched === 2);
  ok('and diverged once — which is the number worth knowing', h.diverged === 1);
  ok('an unused shortcut has no history', shortcutHistory('never-used', file).taken === 0);
  ok('a missing log is empty rather than an error', readGapLog(join(dir, 'nope.jsonl')).length === 0);
  rmSync(dir, { recursive: true, force: true });
}

console.log(NL + 'SCENARIO 3: PROD. Not a simulation, and no shortcut to concede to.');
{
  const why = threw(() => fidelity('prod', { concede: ['armed'] }));
  ok('a prod run cannot concede anything', !!why);
  ok('because the capability is absent, not because the rule is stricter',
     /no DM socket on production/.test(why), why);
  ok('and it names the mode that DID mean a rehearsal', /'prod-faithful'/.test(why), why);
  ok('a prod run cannot be prebuffed either',
     /buffs on production are cast, not granted/.test(threw(() => fidelity('prod', { prebuffed: true }))));

  const prod = fidelity('prod');
  ok('in-game routes are permitted', permits(prod, 'played').ok === true);
  const p = permits(prod, 'dm', { label: 'armed' });
  ok('DM is refused absolutely', p.ok === false);
  ok('and the refusal says no concession would create a socket',
     /no concession that would/.test(p.why), p.why);

  ok('a clean prod run grades as production itself, not as transfers',
     gradeRun(prod, []).grade === 'is-production');
  ok('and says there is nothing to transfer to',
     /nothing to transfer to/.test(gradeRun(prod, []).why));

  // A fidelity gap in a prod ledger is a harness bug, and the grade says so rather than quietly
  // downgrading a result that should have been impossible to produce in the first place.
  const impossible = [];
  recordGap(impossible, { checkpoint: 'armed', strategy: 'dm', cost: 'high' });
  ok('a DM gap recorded against prod grades IMPOSSIBLE',
     gradeRun(prod, impossible).grade === 'impossible');
  ok('and blames the harness rather than the result',
     /bug in the harness/.test(gradeRun(prod, impossible).why));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
