#!/usr/bin/env node
// COOK FROM THE ROAD. Offline, no server, no socket, safe any time:
//
//   node tools/m59-cook-food-test.mjs
//
// Operator, 2026-11-07: "also create food from reagents from baby spiders / spiders, also spiders drop edible mushrooms".
// Pins the decision (m59-cook-food.mjs cookFirstDecision) and the keeper half (Autopilot.cookFirst, called from provision
// before it eats): off by default; cooks only below the ceiling and only while the food aboard will not reach it; never
// with something in reach or just after a hit; never below the spell's mana; a character without the spell is not asked
// again for half an hour.
import './m59-test-ledger.mjs';        // FIRST — the ledger goes to a scratch file
import { Autopilot, CREATE_FOOD_MANA } from './m59-autopilot.mjs';
import { readToolSource } from './autopilot/source.mjs';
import { normalizeCookFood, cookFirstDecision, COOK_FOOD_DEFAULTS } from './m59-cook-food.mjs';
import { validateStrategy } from './m59-strategy-schema.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};
const throws = (f) => { try { f(); return false; } catch { return true; } };

console.log('\nthe setting');
{
  ok('absent, null and false are off', [undefined, null, false].every(v => normalizeCookFood(v) === null));
  ok('true cooks first, keeping no reserve', normalizeCookFood(true).first === true && normalizeCookFood(true).reserveCasts === 0);
  ok('a reserve may be kept', normalizeCookFood({ reserveCasts: 3 }).reserveCasts === 3);
  ok('an unrecognised key is refused', throws(() => normalizeCookFood({ frist: true })));
  ok('enabled:false is off', normalizeCookFood({ enabled: false }) === null);
  const v = validateStrategy({ name: 'x', cookFood: true });
  ok('a strategy may set it', v.ok && v.strategy.desired.cookFood?.first === true && v.strategy.faculties.cookFood === 'work', v.why);
}

console.log('\nthe decision');
{
  const cfg = { ...COOK_FOOD_DEFAULTS };
  const base = { cfg, vigor: 90, ceiling: 180, larder: 20, reagents: { elderberry: 6, herbs: 4 }, mana: 30, manaCost: 10, danger: false };
  ok('90 of 180 with 20 aboard and two sets of reagents: cook', cookFirstDecision(base).cook);
  ok('off is off', !cookFirstDecision({ ...base, cfg: null }).cook);
  ok('at the ceiling: no', !cookFirstDecision({ ...base, vigor: 180 }).cook);
  ok('the food aboard already reaches it: eat that instead', !cookFirstDecision({ ...base, larder: 90 }).cook);
  ok('one herb short of a set: no', !cookFirstDecision({ ...base, reagents: { elderberry: 6, herbs: 1 } }).cook);
  ok('the reserve is kept', !cookFirstDecision({ ...base, cfg: { ...cfg, reserveCasts: 2 } }).cook);
  ok('below the spell cost in mana: no (it refuses silently)', !cookFirstDecision({ ...base, mana: 9 }).cook);
  ok('unknown mana is asked of cookSomething, which checks it again', cookFirstDecision({ ...base, mana: null }).cook);
  ok('something in reach: no casting on a contested square', !cookFirstDecision({ ...base, danger: true }).cook);
  ok('a character seen without the spell: no', !cookFirstDecision({ ...base, knows: false }).cook);
}

console.log('\nthe keeper half');
function keeper({ policy = { cookFood: normalizeCookFood(true) }, reagents = { elderberry: 4, herbs: 4 }, inReach = [],
                  attack = null, made = true, declined = null } = {}) {
  const k = Object.create(Autopilot.prototype);
  Object.assign(k, { policy, watch: { attack }, cooks: [],
    reagentCount: () => reagents, inReachOfUs: () => inReach,
    cookSomething: async (why) => { k.cooks.push(why); if (!made && declined) k.lastDeclinedCast = declined; return made; } });
  return k;
}
const v = (vigor, mana = 40) => ({ vigor: { value: vigor }, mana: { value: mana } });
const loaf = n => ({ food: { nutrition: 20, filling: 10 }, o: { amount: n } });
{
  const off = keeper({ policy: {} });
  ok('off by default: no cast', await off.cookFirst(v(90), 180, []) === false && off.cooks.length === 0);
  const k = keeper();
  ok('below the ceiling with reagents and an empty larder: one cast, and the pass is spent', await k.cookFirst(v(90), 180, []) === true
     && k.cooks.length === 1 && /road reagents/.test(k.cooks[0]));
  const fed = keeper();
  ok('with four loaves aboard (80) and 90 short: still cooks', await fed.cookFirst(v(90), 180, [loaf(4)]) === true);
  const full = keeper();
  ok('with five loaves (100) and 90 short: eats them instead', await full.cookFirst(v(90), 180, [loaf(5)]) === false && full.cooks.length === 0);
  const crowded = keeper({ inReach: [{ id: 1 }] });
  ok('a spider in reach: no cast', await crowded.cookFirst(v(90), 180, []) === false && crowded.cooks.length === 0);
  const bitten = keeper({ attack: { lastHitAt: Date.now() - 1000 } });
  ok('hit a second ago: no cast', await bitten.cookFirst(v(90), 180, []) === false);
  const poor = keeper();
  ok(`under ${CREATE_FOOD_MANA} mana: no cast`, await poor.cookFirst(v(90, CREATE_FOOD_MANA - 1), 180, []) === false);
  const noSpell = keeper({ made: false, declined: { spell: 'create food', why: 'the character does not have the spell' } });
  await noSpell.cookFirst(v(90), 180, []);
  await noSpell.cookFirst(v(90), 180, []);
  ok('a character without the spell is asked once, then left alone for half an hour', noSpell.cooks.length === 1);
}

console.log('\nwired in');
{
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('provision cooks first, before it eats, and ends the pass on it',
     /if \(await this\.cookFirst\(v, ceiling \|\| floor, larder\)\.catch\(\(\) => false\)\) return 'ate';\s*const e = await skills\.eat/.test(src));
  ok('the empty-larder cook is unchanged', /if \(!best\) \{[\s\S]{0,1500}?if \(await this\.cookSomething\(\)\) return 'ate';/.test(src));
  ok('the policy key exists on the keeper', /\n\s+cookFood: null,/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
