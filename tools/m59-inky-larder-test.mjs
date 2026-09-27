#!/usr/bin/env node
// VAULTED IS NOT UNEATABLE, AND "NOT YET" MEANS NOT YET — offline, no server.
//
//   node tools/m59-inky-larder-test.mjs
//
// Measured on prod 2026-09-27: 22 of 24 characters listed "Inky-cap mushroom" in
// `vaultItems` (the vault strategy's cap of fifty), and the keeper's larder subtracted every
// keep list — so no keeper ever ate one. 12 of 21 fleet characters sat at the 80 resting cap,
// several carrying 2-10 inkies, and `has_food` read false on Beaker holding eight.
//
// The operator's rule (2026-09-07, vault-strategy.mjs EAT): eat an inky only at vigor 150 or
// below, after any other food. This pins both halves: the keep lists no longer hide food from
// the eater, and the preference's "held" is honoured by eat() rather than merely sorted last.

import { larderOf, eat, setFoodPreference } from './m59-skills.mjs';
import { Autopilot } from './m59-autopilot.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
};

const INKY = 'Inky-cap mushroom';
const names = new Map([[1, INKY], [2, 'slice of pork'], [3, 'herb']]);
const rsc = { get: (id) => names.get(id) };
const NUTRITION = { [INKY]: 50, 'slice of pork': 9 };

// A pack, a vigor bar, and an apply() that eats one of the stack.
function rig(pack, vigor) {
  const c = {
    rsc, selfId: 99, evSeq: 0,
    inventory: pack.map(([nameRsc, amount], i) => ({ id: 100 + i, nameRsc, amount })),
    _vigor: vigor,
    vitals() { return this._vigor == null ? null : { vigor: { value: this._vigor } }; },
    apply(id) {
      const o = this.inventory.find(x => x.id === id);
      this._vigor = Math.min(200, this._vigor + NUTRITION[names.get(o.nameRsc)]);
      if (--o.amount <= 0) this.inventory = this.inventory.filter(x => x !== o);
    },
    stats() {},
    async waitFor() { return { events: [] }; },
  };
  const s = { need: () => c, pacer: { submit: async (_k, fn) => fn() } };
  return { c, s };
}

// The same shape as prod's substrate/hooks/food-preference.mjs over vault-strategy's mayEat.
const inkyRule = (name, vigor) => {
  if (name !== INKY) return 1;
  if (vigor == null || vigor > 150) return null;
  return 2;
};

console.log('\nheld food is still food');
{
  setFoodPreference(inkyRule);
  const { c } = rig([[1, 8]], 180);
  const rows = larderOf(c, { vigor: 180 });
  ok('an inky held at 180 stays in the larder', rows.length === 1);
  ok('and is marked held', rows[0]?.held === true);
  ok('with no vigor it is still counted', larderOf(c).length === 1);
  ok('at 150 it is not held', larderOf(c, { vigor: 150 })[0]?.held !== true);
}

console.log('\neat() honours the 150 rule');
{
  setFoodPreference(inkyRule);
  {
    const { c, s } = rig([[1, 8]], 160);
    const r = await eat(s, { refresh: false, upToVigor: 200 });
    ok('at 160 with only inkies, nothing is eaten', r.ate.length === 0, JSON.stringify(r.ate));
    ok('and it says why', /saving/.test(r.reason || ''), r.reason);
    ok('the vigor is untouched', c._vigor === 160);
  }
  {
    const { c, s } = rig([[1, 8]], 80);
    // One mouthful per stack per call; the keeper calls again every pass.
    const r = await eat(s, { refresh: false, upToVigor: 200 });
    ok('at 80 it eats an inky', r.ate.length === 1 && r.ate[0] === INKY, JSON.stringify(r.ate));
    await eat(s, { refresh: false, upToVigor: 200 });
    ok('at 130 it eats another', c._vigor === 180, String(c._vigor));
    const third = await eat(s, { refresh: false, upToVigor: 200 });
    ok('at 180 it stops: never past 150', third.ate.length === 0 && c._vigor === 180,
       String(c._vigor));
  }
  {
    const { c, s } = rig([[1, 3], [2, 5]], 100);
    const r = await eat(s, { refresh: false, upToVigor: 200, maxItems: 4 });
    ok('below 150, pork goes first', r.ate[0] === 'slice of pork', JSON.stringify(r.ate));
    ok('and an inky only after it', r.ate.includes(INKY), JSON.stringify(r.ate));
  }
  {
    const { c, s } = rig([[1, 2]], null);
    const r = await eat(s, { refresh: false, upToVigor: 200 });
    ok('unknown vigor does not throw', Array.isArray(r.ate));
  }
  setFoodPreference(null);
}

console.log('\nthe keeper\'s keep lists govern giving, not eating');
{
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { vaultItems: [INKY, 'blue dragon scale'], protectedItems: ['herb', INKY] };
  ap.inheritedProtectedNames = () => ['chalice'];
  const { c } = rig([[1, 8], [3, 20]], 80);
  ap.s = { client: c };
  ok('protectedItemNames still holds the inky back from sale',
     ap.protectedItemNames().includes(INKY));
  ok('the eating larder sees it', ap.larder(c).some(r => r.name === INKY));
  ok('the giving larder does not', !ap.giveableLarder(c).some(r => r.name === INKY));

  // Not this character's to eat: something protected by inheritance stays out of the larder.
  ap.inheritedProtectedNames = () => [INKY];
  ok('an inky that is the holder\'s cargo is still not eaten', ap.larder(c).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
