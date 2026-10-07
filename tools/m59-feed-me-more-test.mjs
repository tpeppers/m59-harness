// OFFLINE. Pins m59-feed-me-more (the chest rebalancer) and the three guild-plan seams it relies on:
// `also` aliases, coop_caps, and a planner save that keeps the rest of the file.
// `node tools/m59-feed-me-more-test.mjs`.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cutOrder, allocate, applyToPlan, refreshBaseline, planTargets } from './m59-feed-me-more.mjs';
import { normalisePlan, guildKeepTest, contributionPlan, saveGuildPlan, coopCapFor } from './m59-guildwants.mjs';
import { evictionOrder } from './m59-chest-eviction.mjs';
import { coopDepositPlan, coopConfig } from './m59-reagent-coop.mjs';

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) { pass++; console.log('  ok  ', what); } else { fail++; console.log('  FAIL', what); } };

const BULK = { mushroom: 5, herb: 4, elderberry: 3, 'red mushroom': 5, ruby: 1, 'lightning wand': 5, 'fairy wing': 5 };
const VALUE = { mushroom: 10, herb: 10, elderberry: 20, 'red mushroom': 40, ruby: 200, 'fairy wing': 20 };
const bulkOf = n => BULK[n] ?? null, valueOf = n => VALUE[n] ?? null;

console.log('cut order');
{
  const buyable = new Set(['mushroom', 'herb', 'elderberry', 'red mushroom', 'ruby']);
  const o = cutOrder({ reagents: ['ruby', 'red mushroom', 'herb', 'fairy wing', 'mushroom', 'elderberry'], bulkOf, valueOf, buyable });
  ok(o.join() === 'mushroom,herb,elderberry,red mushroom,ruby', `cheapest buyable per bulk first (${o.join()})`);
  ok(!o.includes('fairy wing'), 'a reagent nobody sells is never cut');
  ok(cutOrder({ reagents: [], bulkOf, valueOf, buyable, order: ['Herb', 'mushroom'] }).join() === 'herb,mushroom',
     'config.order replaces the ranking outright');
}

const order = ['mushroom', 'herb', 'elderberry', 'red mushroom'];
const slots = ['r18c2', 'r18c6', 'r20c4'];
const base = Object.fromEntries(slots.map(s => [s, { mushroom: 500, herb: 500, elderberry: 500, 'red mushroom': 100 }]));
const demand = per => [{ item: 'lightning wand', per_chest: per }];

console.log('allocation');
{
  const cfg = { floor_fraction: 0.3, floor_total: 300, rounds: 3 };
  let r = allocate({ baseline: base, demands: demand(100), config: cfg, order, bulkOf, slots });
  ok(r.targets.r18c2['lightning wand'] === 100, 'the demand gets its target');
  ok(r.targets.r18c2.mushroom === 400 && r.targets.r18c2.herb === 500, '500 bulk comes from the cheapest first: 100 mushrooms, no herbs');
  ok(r.caps.r18c2.mushroom === 400 && !('herb' in r.caps.r18c2), 'only a reagent below its baseline is co-op capped');
  ok(!Object.keys(r.unmet).length, 'nothing unmet');

  r = allocate({ baseline: base, demands: demand(400), config: cfg, order, bulkOf, slots });
  // need 2000 bulk: mushroom 500 -> 150 (0.3 floor) frees 1750; herb frees the remaining 250 (63 herbs).
  ok(r.targets.r18c2.mushroom === 150, 'round 1 stops the cheapest at 30% of its original (150)');
  ok(r.targets.r18c2.herb === 500 - 63, `then moves to the next reagent (${r.targets.r18c2.herb})`);

  r = allocate({ baseline: base, demands: demand(2000), config: cfg, order, bulkOf, slots });
  ok(r.cuts.some(c => c.round === 2 && c.item === 'mushroom'), 'round 2 starts again from the cheapest');
  ok(Object.values(r.targets.r18c2).every(n => n >= 100), 'no reagent under floor_total/holders (300/3 = 100)');
  ok(r.targets.r18c2['red mushroom'] === 100, 'a reagent already at that floor is never cut');
  ok(r.unmet.r18c2 > 0, `unmet room is reported (${r.unmet.r18c2} bulk)`);

  r = allocate({ baseline: base, demands: [{ item: 'mushroom', per_chest: 900 }], config: cfg, order, bulkOf, slots });
  ok(r.targets.r18c2.mushroom === 900 && r.targets.r18c2.herb < 500, 'a demanded reagent is not cut to pay for itself');

  r = allocate({ baseline: base, demands: [{ item: 'lightning wand', per_chest: 100, chests: ['r18c6'] }], config: cfg, order, bulkOf, slots });
  ok(r.targets.r18c2.mushroom === 500 && r.targets.r18c6.mushroom === 400, 'a demand for one chest costs only that chest');
}

console.log('baseline');
{
  const b = refreshBaseline({ baseline: {}, written: {}, current: { r18c2: { mushroom: 142 } }, items: ['mushroom', 'lightning wand'], slots: ['r18c2'] });
  ok(b.r18c2.mushroom === 142 && b.r18c2['lightning wand'] === null, 'first sight records the plan, and absent as null');
  const b2 = refreshBaseline({ baseline: b, written: { r18c2: { mushroom: 100 } }, current: { r18c2: { mushroom: 100 } }, items: ['mushroom'], slots: ['r18c2'] });
  ok(b2.r18c2.mushroom === 142, 'our own write does not move the baseline');
  const b3 = refreshBaseline({ baseline: b, written: { r18c2: { mushroom: 100 } }, current: { r18c2: { mushroom: 250 } }, items: ['mushroom'], slots: ['r18c2'] });
  ok(b3.r18c2.mushroom === 250, 'a hand edit after our write becomes the baseline');
}

console.log('writing the plan');
{
  const raw = { reagents: { default: 'chest' }, note: 'keep me', coop_caps: { r20c4: { herb: 1 } },
    chests: { 1: { items: [{ item: 'mushroom', target: 142 }, { item: 'scale armor', target: 2 }, { item: 'Mushroom', target: 142 }] } } };
  const out = applyToPlan(raw, { targets: { r18c2: { mushroom: 100, 'lightning wand': 100 } },
    caps: { r18c2: { mushroom: 100 } }, demands: [{ item: 'lightning wand', also: ['wand'] }], clearCaps: ['r18c2'] });
  ok(out.reagents.default === 'chest' && out.note === 'keep me', 'every other key is kept');
  ok(Object.keys(out.chests).join() === '1', 'an old slot-number key stays as written');
  ok(out.chests[1].items.filter(i => /mushroom/i.test(i.item)).every(i => i.target === 100), 'both duplicate lines get the new target');
  const wand = out.chests[1].items.find(i => i.item === 'lightning wand');
  ok(wand?.target === 100 && wand.also?.[0] === 'wand', 'the demanded item is added with its aliases');
  ok(out.coop_caps.r18c2.mushroom === 100 && out.coop_caps.r20c4.herb === 1, 'caps written, other chests\' caps kept');
  ok(planTargets(out).r18c2.mushroom === 100, 'planTargets reads it back');
  const removed = applyToPlan(out, { targets: { r18c2: { 'lightning wand': 0, mushroom: 142 } }, caps: {}, demands: [],
    clearCaps: ['r18c2'], baseline: { r18c2: { 'lightning wand': null, mushroom: 142 } } });
  ok(!removed.chests[1].items.some(i => i.item === 'lightning wand'), 'removing a demand deletes a line that was never in the plan');
  ok(!removed.coop_caps?.r18c2, 'and a reagent back at baseline loses its cap');
}

console.log('guild plan: aliases, caps, save');
{
  const plan = normalisePlan({ chests: { r18c6: { items: [{ item: 'lightning wand', target: 100, also: ['wand'] }] } },
    coop_caps: { 2: { Mushroom: 43 } } });
  ok(plan.chests.get('r18c6')[0].also[0] === 'wand', '`also` survives normalisation');
  ok(coopCapFor(plan, 'r18c6', 'mushroom') === 43 && coopCapFor(plan, 'r18c2', 'mushroom') === null,
     'coop_caps read by square, from an old slot key');
  const chests = [{ slot: 'r18c6', items: [{ name: 'wand', amount: 41 }, { name: 'lightning wand', amount: 9 }] }];
  const rent = { in_guild: true };
  const keep = guildKeepTest({ plan, chests, rent });
  ok(keep('wand') && keep('lightning wand') && keep.shortfall.get('wand') === 50, '41 "wand" + 9 identified count toward 100; both names held back');
  const c = contributionPlan({ plan, chests, rent, pack: [{ name: 'wand', amount: 3 }, { name: 'lightning wand', amount: 2 }] });
  const give = c.chests[0].give;
  ok(give.find(g => g.item === 'lightning wand')?.amount === 2 && give.find(g => g.item === 'wand')?.amount === 3,
     'a deposit moves each carried name as itself');
  ok(give.find(g => g.item === 'wand')?.counts_as === 'lightning wand', 'and says what the alias counts as');
  const ev = evictionOrder({ items: [{ name: 'wand', amount: 41 }] }, plan.chests.get('r18c6'),
    { bulkOf: () => 5, priceOf: () => 1 });
  ok(!ev.rows.some(r => r.name === 'wand'), 'eviction keeps aliased stock under the entry\'s target');

  const cfg = coopConfig({ enabled: true, reagents: ['mushroom'], chest_keys: ['r18c6'] });
  const box = [{ slot: 'r18c6', items: [] }];
  const sale = [{ name: 'mushroom', amount: 500 }], pack = [{ name: 'mushroom', amount: 500 }];
  const free = coopDepositPlan({ config: cfg, chests: box, pack, saleItems: sale });
  const capped = coopDepositPlan({ config: cfg, chests: box, pack, saleItems: sale, capFor: (s, i) => coopCapFor(plan, s, i) });
  ok(free.plan[0].amount > 43 && capped.plan[0].amount === 43, `the co-op honours the cap (${free.plan[0].amount} -> ${capped.plan[0].amount})`);

  const dir = mkdtempSync(join(tmpdir(), 'fmm-'));
  try {
    const file = join(dir, 'guild-plan.json');
    writeFileSync(file, JSON.stringify({ reagents: { default: 'chest' }, coop_caps: { r18c2: { herb: 5 } }, chests: {} }));
    saveGuildPlan({ chests: { r18c2: { items: [{ item: 'herb', target: 9 }] } } }, file);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    ok(after.reagents?.default === 'chest' && after.coop_caps?.r18c2?.herb === 5, 'a planner save keeps reagents and coop_caps');
    ok(after.chests.r18c2.items[0].target === 9, 'and still writes the chests');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
