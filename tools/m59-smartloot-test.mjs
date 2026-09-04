#!/usr/bin/env node
// WHAT THE PACK DECIDES. Offline and pure — no broker, no fleet, safe any time.
//
//   node tools/m59-smartloot-test.mjs
import { classifyPack, routeFor } from './m59-smartloot.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};

console.log('the skip is the point');
{
  // Gonzo's real pack, 2026-09-02, after a full Castle Victoria -> Barloque -> Tos circuit
  // that sold nothing: thirteen long swords and four knight's shields still aboard.
  const gonzo = classifyPack([
    { name: 'hammer' }, { name: 'long sword' }, { name: 'long sword' },
    { name: "knight's shield" }, { name: 'emerald', amount: 3 },
    { name: 'herb', amount: 8 }, { name: 'elderberry', amount: 8 },
    { name: 'turkey leg' }, { name: 'shilling', amount: 41 },
  ]);
  const r = routeFor(gonzo);
  ok('a pack with weapons routes through the smith town', r.viaBarloque === true);
  ok('and says which items forced it', /only a smith buys/.test(r.why), r.why);
  ok('money is not cargo', !gonzo.reagents.concat(gonzo.other).some(n => /shilling/i.test(n)));
}
{
  // THE ONE THAT SAVES THE TIME. Deciding to go to Barloque is easy; deciding not to is what
  // keeps a character off roads that killed four of this fleet in one night.
  const r = routeFor(classifyPack([
    { name: 'herb', amount: 150 }, { name: 'elderberry', amount: 150 },
    { name: 'red mushroom', amount: 20 }, { name: 'emerald', amount: 4 },
  ]));
  ok('a reagent-only pack SKIPS the smith town', r.viaBarloque === false);
  ok('and explains the skip', /nothing needs a smith/.test(r.why), r.why);
}

console.log('\nwhat rides home rather than being sold');
{
  const p = classifyPack([{ name: 'wand of identification' }, { name: 'scroll of discord' },
                          { name: 'rose' }, { name: 'herb', amount: 10 }]);
  ok('wands, scrolls and the rose are keepers, not stock', p.vaultable.length === 3,
     JSON.stringify(p.vaultable));
  // A wand is not a reagent and a mystic sword IS a weapon; in both cases what matters is
  // that we are not selling it, so vaultable is tested before the category rules.
  const m = classifyPack([{ name: 'mystic sword' }, { name: 'long sword' }]);
  ok('a mystic sword is a keeper even though it is a weapon',
     m.vaultable.length === 1 && m.smithOnly.length === 1, JSON.stringify(m));

  // Gems ARE reagents, which is why the apothecaries name the exclusion explicitly — so they
  // cannot be emptied at an apothecary and ride home instead. They are 1 bulk, so that is cheap.
  const g = classifyPack([{ name: 'emerald' }, { name: 'sapphire' }, { name: 'diamond' }]);
  ok('gems are their own pile, not apothecary stock', g.gems.length === 3 && !g.reagents.length);
  ok('and they do not force a detour on their own', routeFor(g).viaBarloque === false);
}

console.log('\nthings never to offer or wield');
{
  const p = classifyPack([{ name: 'amulet of shadows' }, { name: 'cursed long sword' },
                          { name: 'long sword' }]);
  ok('the amulet and a cursed weapon are set aside', p.never.length === 2, JSON.stringify(p.never));
  ok('and are not counted as sellable stock', p.smithOnly.length === 1, JSON.stringify(p.smithOnly));
}

console.log('\nvaulting is free once the detour is forced');
{
  const withBoth = classifyPack([{ name: 'long sword' }, { name: 'wand of fire' }]);
  const r = routeFor(withBoth);
  ok('a smith trip carrying keepers vaults on the same stop',
     r.viaBarloque === true && r.vaultHere === true);

  const keepersOnly = classifyPack([{ name: 'wand of fire' }, { name: 'herb', amount: 4 }]);
  ok('but keepers alone do not buy a detour', routeFor(keepersOnly).viaBarloque === false);
  ok('unless the caller asks for one',
     routeFor(keepersOnly, { alwaysVault: true }).viaBarloque === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
