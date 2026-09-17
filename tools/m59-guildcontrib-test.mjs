// OFFLINE. Pins the one thing that made `guild_wants` a no-op on prod for seven hours: the
// `reagentCoop` guard in `contributeGuildWants` could not tell its two callers apart, and one
// of them was the town scheduler that the guard exists to defer to.
//
// SOURCE-TEXT ASSERTIONS, DELIBERATELY. The defect is one `if` in a 25,000-line file whose
// constructor needs a live session, so standing the class up to test it would cost more than
// it proves. What must not regress is the SHAPE — that the guard reads a caller-supplied
// flag, that the town trip passes it, and that nothing else does. Read `m59-autopilot.mjs`
// and check exactly that.
//
// `node tools/m59-guildcontrib-test.mjs`
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${what}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), `${what} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);
const section = s => console.log(`\n${s}`);

const src = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');

section('the guard takes a caller-supplied flag');
{
  ok(/async contributeGuildWants\(\{ duringTownTrip = false \} = \{\}\)/.test(src),
     'contributeGuildWants accepts { duringTownTrip }');
  ok(/reagentCoop\?\.enabled && !duringTownTrip/.test(src),
     'and only skips when reagentCoop is on AND this is NOT the town trip');
  // The bug, in one line: the guard with no flag at all.
  ok(!/if \(this\.policy\.reagentCoop\?\.enabled\)\s*\n\s*\/\/ The town scheduler owns/.test(src),
     'the flagless guard that skipped its own scheduler is gone');
  ok(/skipped: true, why:/.test(src),
     'and a skip says why, so "nothing to contribute" and "not my turn" are distinguishable');
}

section('the town trip identifies itself, and it is the only caller that does');
{
  ok(/\['guild contribution', \(\) => this\.contributeGuildWants\(\{ duringTownTrip: true \}\)\]/.test(src),
     'the town scheduler passes duringTownTrip: true');
  const calls = src.match(/contributeGuildWants\(/g) ?? [];
  // One definition + one call site. A second call site would need its own decision about the
  // flag, and defaulting it to false is the safe half — this asserts nobody added one quietly.
  eq(calls.length, 2, 'there is exactly one definition and one call site');
  const withFlag = src.match(/contributeGuildWants\(\{ duringTownTrip: true \}\)/g) ?? [];
  eq(withFlag.length, 1, 'and exactly one caller claims to be the town trip');
}

section('the incident is written down where the next person will read it');
{
  const guard = src.slice(src.indexOf('async contributeGuildWants'),
                          src.indexOf('const cfg = this.policy.guildWants'));
  ok(/seven hours/.test(guard), 'the comment says how long it went unnoticed');
  ok(/87 orc teeth/.test(guard), 'and what it cost, in the units the operator asked in');
  ok(/deposited NOTHING/i.test(guard), 'and states the outcome plainly');
  ok(/coopBusiness/.test(guard),
     'and names why the coop path did not cover the gap — it donates reagents, not chest stock');
  ok(/06:33/.test(guard),
     'and cites the evidence: the chest cache had not been written since');
}

section('the order of the town trip is unchanged');
{
  // The contribution must stay BEFORE the sale, or the surplus this is meant to deposit has
  // already been sold. `guildWantedNames` makes plan-short items unsellable, but the ordering
  // is the belt to that braces.
  const steps = src.slice(src.indexOf("['guild contribution'"), src.indexOf("['vault'"));
  ok(steps.indexOf("'guild contribution'") < steps.indexOf("['sell'"),
     'guild contribution still runs before the sale');
  ok(steps.indexOf("['sell'") < steps.indexOf("['guild tithe'"),
     'and the tithe still runs after the sale it is a fraction of');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
