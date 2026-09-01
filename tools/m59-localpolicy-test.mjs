#!/usr/bin/env node
// THE CONTRACT TEST FOR THE LOCAL OVERRIDE FILE.
//
//   node tools/m59-localpolicy-test.mjs
//
// Offline, against scratch files. It never reads substrate/policy.local.json, which a
// running supervisor is reading every round.
//
// The three properties worth pinning are the three that fail in the DANGEROUS direction
// if anybody inverts them:
//
//   1. SILENCE MEANS THE COMMITTED BEHAVIOUR, not an empty policy. An absent file that
//      returned {} would strip every floor off a live fleet and look like doing nothing.
//   2. AN UNUSABLE VALUE KEEPS THE COMMITTED ONE. Falling back to "unset" would let a
//      typo remove a flee threshold, which is a dead character rather than a warning.
//   3. AN UNKNOWN KEY IS REPORTED. A setting that silently does nothing is how a keeper
//      audit stayed switched off for a year while everyone believed it was on.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  localise, loadLocalPolicy, localBlocks, OVERRIDABLE,
  VIGOR_MAX, REST_VIGOR_CAP, MIN_FIGHT_VIGOR,
} from './m59-localpolicy.mjs';

let pass = 0, fail = 0;
const ok = (what, cond) => {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL ${what}`); }
};

const dir = mkdtempSync(join(tmpdir(), 'm59-localpolicy-'));
const write = (name, body) => {
  const p = join(dir, name);
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  return p;
};

// The committed block under test. Deliberately shaped like VALLEY_ORDERS.
const COMMITTED = Object.freeze({
  mode: 'farm', strategy: 'wellfed', fight_above_vigor: 180,
  rest_below: 0.75, flee_below: 0.35, max_carry: 14, roam: false,
});

// ---------------------------------------------------------------------------
console.log('silence means the behaviour that was already there');

{
  const r = localise('valley_orders', COMMITTED, { file: join(dir, 'does-not-exist.json') });
  ok('an absent file returns the committed orders', r.orders === COMMITTED);
  ok('an absent file applies nothing', r.applied.length === 0);
  ok('an absent file refuses nothing', r.refused.length === 0);
  ok('an absent file names no source', r.source === null);
  ok('loadLocalPolicy reports absence as null', loadLocalPolicy(join(dir, 'nope.json')) === null);
}

{
  const f = write('empty.json', {});
  const r = localise('valley_orders', COMMITTED, { file: f });
  ok('an empty file returns the committed orders unchanged', r.orders === COMMITTED);
}

{
  const f = write('other-block.json', { blocks: { lowland_orders: { roam: true } } });
  const r = localise('valley_orders', COMMITTED, { file: f });
  ok('a file with no block for this name changes nothing', r.orders === COMMITTED);
}

{
  // The failure this rule exists to stop: a fleet losing every floor at once and the
  // change looking like no change at all.
  const f = write('broken.json', '{ "blocks": { not json');
  const r = localise('valley_orders', COMMITTED, { file: f });
  ok('a file that will not parse keeps the committed orders', r.orders === COMMITTED);
  ok('a file that will not parse says so', r.refused.some((x) => /will not parse/.test(x.why)));
  const doc = loadLocalPolicy(f);
  ok('an unparseable file is not reported as absent', doc !== null && !!doc.__error);
  ok('an unparseable file is not reported as empty', doc.__error !== undefined);
}

{
  const f = write('array.json', '[1,2,3]');
  const r = localise('valley_orders', COMMITTED, { file: f });
  ok('a JSON array is refused, not treated as a policy', r.orders === COMMITTED);
}

// ---------------------------------------------------------------------------
console.log('an override that is usable is applied, and is reported');

{
  const f = write('good.json', { blocks: { valley_orders: { fight_above_vigor: 120 } } });
  const r = localise('valley_orders', COMMITTED, { file: f });
  ok('the local value wins', r.orders.fight_above_vigor === 120);
  ok('every other committed key survives', r.orders.rest_below === 0.75 &&
     r.orders.strategy === 'wellfed' && r.orders.max_carry === 14);
  ok('the committed object is not mutated', COMMITTED.fight_above_vigor === 180);
  ok('the change is reported with both ends', r.applied.some(
    (a) => a.key === 'fight_above_vigor' && a.from === 180 && a.to === 120));
  ok('the source file is named', r.source === f);
}

{
  // A bare object with no `blocks` wrapper is accepted, because somebody will write one.
  const f = write('bare.json', { valley_orders: { roam: true } });
  const r = localise('valley_orders', COMMITTED, { file: f });
  ok('a file without the blocks wrapper still works', r.orders.roam === true);
}

{
  const f = write('same.json', { blocks: { valley_orders: { fight_above_vigor: 180 } } });
  const r = localise('valley_orders', COMMITTED, { file: f });
  ok('an override equal to the default is marked as a no-op',
     r.applied.some((a) => a.key === 'fight_above_vigor' && a.same === true));
}

{
  const f = write('blocks.json', { blocks: { valley_orders: {}, lowland_orders: {} } });
  ok('localBlocks lists the blocks', localBlocks(f).sort().join(',') ===
     'lowland_orders,valley_orders');
  ok('localBlocks does not list the note key',
     !localBlocks(write('note.json', { note: 'hi', blocks: { a: {} } })).includes('note'));
}

// ---------------------------------------------------------------------------
console.log('an unusable value keeps the committed one, and says which');

for (const [name, value] of [
  ['a string where a number belongs', '180'],
  ['a vigor above the 200 ceiling', 250],
  ['a negative vigor', -1],
  ['null', null],
]) {
  const f = write(`bad-${encodeURIComponent(name)}.json`,
    { blocks: { valley_orders: { fight_above_vigor: value } } });
  const r = localise('valley_orders', COMMITTED, { file: f });
  ok(`${name} keeps the committed 180`, r.orders.fight_above_vigor === 180);
  ok(`${name} is refused out loud`, r.refused.some((x) => x.key === 'fight_above_vigor'));
}

{
  const f = write('bad-fraction.json', { blocks: { valley_orders: { flee_below: 35 } } });
  const r = localise('valley_orders', COMMITTED, { file: f });
  // 35 is the number somebody means when they type a percentage. It must not become a
  // flee threshold of 3500%, and it must not silently vanish either.
  ok('a fraction given as a percentage is refused', r.orders.flee_below === 0.35);
  ok('and the refusal names the expected shape',
     r.refused.some((x) => x.key === 'flee_below' && /fraction from 0 to 1/.test(x.why)));
}

{
  const f = write('bad-bool.json', { blocks: { valley_orders: { roam: 'false' } } });
  const r = localise('valley_orders', COMMITTED, { file: f });
  ok('the string "false" is not accepted as a boolean', r.orders.roam === false);
  ok('and it is refused rather than coerced', r.refused.some((x) => x.key === 'roam'));
}

{
  const f = write('bad-block.json', { blocks: { valley_orders: 180 } });
  const r = localise('valley_orders', COMMITTED, { file: f });
  ok('a block that is not an object is refused', r.orders === COMMITTED);
  ok('and says the block name', r.refused.some((x) => x.key === 'valley_orders'));
}

// ---------------------------------------------------------------------------
console.log('an unknown key is reported, never applied and never dropped');

{
  const f = write('typo.json', {
    blocks: { valley_orders: { fight_above_vigour: 120, fight_above_vigor: 130 } },
  });
  const r = localise('valley_orders', COMMITTED, { file: f });
  ok('the typo does not reach the orders', r.orders.fight_above_vigour === undefined);
  ok('the typo is reported', r.refused.some((x) => x.key === 'fight_above_vigour'));
  ok('the refusal lists what IS overridable',
     r.refused.some((x) => x.why.includes('fight_above_vigor')));
  ok('a good key beside a typo still applies', r.orders.fight_above_vigor === 130);
}

{
  // Every key the supervisor's committed blocks actually set should be overridable, or
  // the file is a half-measure that quietly ignores half of what somebody writes in it.
  const supervised = ['fight_above_vigor', 'rest_below', 'flee_below', 'max_carry',
                      'roam', 'use_safe_spots', 'hold_resume_above', 'max_threat_over',
                      'weapon_priority', 'strategy'];
  for (const k of supervised)
    ok(`${k} is overridable`, OVERRIDABLE.includes(k));
}

// ---------------------------------------------------------------------------
console.log('the mechanics are not overridable, and a bet against them is flagged');

{
  ok('the vigor ceiling is 200', VIGOR_MAX === 200);
  ok('resting stops at 80', REST_VIGOR_CAP === 80);
  ok('the fighting floor is 80', MIN_FIGHT_VIGOR === 80);

  const f = write('mech.json', { blocks: { valley_orders: { REST_VIGOR_CAP: 200 } } });
  const r = localise('valley_orders', COMMITTED, { file: f });
  ok('a local file cannot move the resting cap',
     r.refused.some((x) => x.key === 'REST_VIGOR_CAP'));
  ok('and the mechanic is untouched', REST_VIGOR_CAP === 80);
}

{
  // The whole reason this module exists. 180 is legal and is what this fleet runs, but it
  // is a claim about the food supply and should say so at the moment it is set — the
  // fleet spent an afternoon at exactly 80 vigor with zero herbs and read as healthy.
  const f = write('warn-high.json', { blocks: { valley_orders: { fight_above_vigor: 180 } } });
  const r = localise('valley_orders', { ...COMMITTED, fight_above_vigor: 100 }, { file: f });
  ok('a floor above the resting cap is applied', r.orders.fight_above_vigor === 180);
  ok('a floor above the resting cap is warned about',
     r.warnings.some((w) => w.key === 'fight_above_vigor' && /eating/.test(w.why)));
  ok('and the warning names the recipe',
     r.warnings.some((w) => /elderberry AND 2 herbs/.test(w.why)));

  const g = write('warn-low.json', { blocks: { valley_orders: { fight_above_vigor: 50 } } });
  const r2 = localise('valley_orders', COMMITTED, { file: g });
  ok('a floor below MIN_FIGHT_VIGOR is applied', r2.orders.fight_above_vigor === 50);
  ok('but is flagged as one the keeper will not honour while fed',
     r2.warnings.some((w) => /MIN_FIGHT_VIGOR/.test(w.why)));
}

{
  // The keeper floor moved from 100 to the resting cap of 80. A setting above 80 now
  // makes only the food-supply claim; it is no longer also below the keeper's own floor.
  // Keep this contract beside the constant so the warning prose cannot drift again.
  ok('the keeper floor matches the resting cap', MIN_FIGHT_VIGOR === REST_VIGOR_CAP);

  const mid = write('warn-mid.json', { blocks: { valley_orders: { fight_above_vigor: 90 } } });
  const r = localise('valley_orders', COMMITTED, { file: mid });
  ok('90 collects only the food-supply remark', r.warnings.length === 1);
  ok('90 needs food', r.warnings.some((w) => /resting cap/.test(w.why)));
  ok('90 is not under the keeper floor', !r.warnings.some((w) => /MIN_FIGHT_VIGOR/.test(w.why)));

  const high = write('warn-only-food.json',
    { blocks: { valley_orders: { fight_above_vigor: 180 } } });
  const r2 = localise('valley_orders', { ...COMMITTED, fight_above_vigor: 0 }, { file: high });
  ok('180 is a food claim only', r2.warnings.length === 1 &&
     /resting cap/.test(r2.warnings[0].why));

  const low = write('warn-only-floor.json',
    { blocks: { valley_orders: { fight_above_vigor: 60 } } });
  const r3 = localise('valley_orders', COMMITTED, { file: low });
  ok('60 is a keeper-floor remark only', r3.warnings.length === 1 &&
     /MIN_FIGHT_VIGOR/.test(r3.warnings[0].why));
}

// ---------------------------------------------------------------------------
console.log('a bad local file can never stop a supervisor round');

{
  for (const body of ['', 'null', '"a string"', '{"blocks":null}', '[]', '{bad']) {
    const f = write(`hostile-${encodeURIComponent(body)}.json`, body);
    let threw = false;
    try { localise('valley_orders', COMMITTED, { file: f }); } catch { threw = true; }
    ok(`localise does not throw on ${JSON.stringify(body)}`, !threw);
  }
}

rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
