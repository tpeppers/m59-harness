#!/usr/bin/env node
// Offline contract for the guild chest's eviction order and history. Opens no socket, joins
// nobody, and writes only under a temporary directory.
//
// What it pins, one case per way this goes quietly wrong:
//   - unplanned before surplus, and a stack within its target is never ranked
//   - least value per bulk first; an unpriced or unsized item goes LAST in its tier, never as 0
//   - shillings are never ranked (a chest is bulk-bound; they free nothing)
//   - an option called `valueOf` once read Object.prototype.valueOf out of `{}`; the defaults
//     must survive being called with no options at all
//   - the history is a diff of two readings: the first reading records nothing, a re-reading
//     records exactly what left and arrived, and an unchanged re-reading records nothing
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evictionOrder, chestDiff, tally } from './m59-chest-eviction.mjs';
import { StorageCache } from './m59-storage.mjs';

let passed = 0, failed = 0;
const ok = (what, cond) => {
  if (cond) { passed++; console.log('  ok  ', what); }
  else { failed++; console.log('  FAIL', what); }
};

const BULK = { rock: 10, gem: 1, feather: 4, shilling: 0, mystery: 5 };
const PRICE = { rock: 10, gem: 100, feather: 40, shilling: 1 };
const opts = { bulkOf: n => BULK[n] ?? null, priceOf: n => PRICE[n] ?? null };

console.log('evictionOrder');
{
  const chest = { items: [
    { name: 'Rock', amount: 5 }, { name: 'gem', amount: 30 }, { name: 'feather', amount: 12 },
    { name: 'shilling', amount: 75000 }, { name: 'mystery', amount: 1 }, { name: 'unsized', amount: 2 },
  ] };
  const plan = [{ item: 'gem', target: 10 }, { item: 'feather', target: 20 }];
  const { rows, kept } = evictionOrder(chest, plan, opts);
  const names = rows.map(r => r.name);
  ok('unplanned rows come before surplus rows',
     rows.findIndex(r => r.tier === 'surplus') > rows.findLastIndex(r => r.tier === 'unplanned'));
  ok('the cheapest unplanned stack per bulk is first (rock: 1/bulk)', names[0] === 'rock');
  ok('an unpriced item sorts after every priced one in its tier',
     names.indexOf('mystery') > names.indexOf('rock'));
  ok('an item with no bulk in the table sorts last in its tier',
     names.indexOf('unsized') > names.indexOf('mystery'));
  ok('surplus evicts only the excess over target (30 held, 10 wanted -> 20)',
     rows.find(r => r.name === 'gem')?.evict === 20);
  ok('a stack under its target is never ranked', !names.includes('feather'));
  ok('shillings are never ranked', !names.includes('shilling'));
  ok('the kept list names the planned stacks and the never-evict ones',
     kept.some(k => k.name === 'feather') && kept.some(k => k.name === 'shilling'));
  ok('ranks are 1..n in order', rows.every((r, i) => r.rank === i + 1));
}
{
  const { rows } = evictionOrder({ items: [{ name: 'rock', amount: 2 }] }, null, opts);
  ok('with no plan at all every stack is unplanned', rows.length === 1 && rows[0].tier === 'unplanned');
}
{
  let threw = null;
  try { evictionOrder({ items: [{ name: 'nerudite sword', amount: 3 }] }, [{ item: 'nerudite sword', target: 1 }]); }
  catch (e) { threw = e; }
  ok('the default bulk and price tables work with no options (the valueOf trap)', threw === null);
}

console.log('chestDiff');
{
  const a = { items: [{ name: 'gem', amount: 10 }, { name: 'rock', amount: 1 }, { name: 'rock', amount: 1 }] };
  const b = { items: [{ name: 'gem', amount: 4 }, { name: 'feather', amount: 3 }] };
  const d = chestDiff(a, b);
  ok('stacks of one name are summed before comparing', tally(a.items).get('rock') === 2);
  ok('what left is named with its amount', d.left.some(x => x.name === 'gem' && x.amount === 6)
     && d.left.some(x => x.name === 'rock' && x.amount === 2));
  ok('what arrived is named with its amount', d.arrived.length === 1 && d.arrived[0].amount === 3);
  ok('a first reading has no diff at all, not "everything arrived"', chestDiff(null, b) === null);
}

console.log('StorageCache chest history');
{
  const dir = mkdtempSync(join(tmpdir(), 'm59-chest-'));
  try {
    const s = new StorageCache({ dir, now: () => 1000 });
    s.writeChest('r18c2', { items: [{ name: 'gem', amount: 10 }], at: 1000, room: 714 });
    ok('the first reading writes no history', s.readChestHistory('r18c2').length === 0);
    s.writeChest('r18c2', { items: [{ name: 'gem', amount: 10 }], at: 2000, room: 714 });
    ok('an unchanged re-reading writes no history', s.readChestHistory('r18c2').length === 0);
    s.writeChest('r18c2', { items: [{ name: 'gem', amount: 7 }, { name: 'rock', amount: 1 }], at: 3000, room: 714 });
    const h = s.readChestHistory('r18c2');
    ok('a changed re-reading writes one row', h.length === 1);
    ok('the row carries both readings\' times', h[0]?.prev_at === 2000 && h[0]?.at === 3000);
    ok('the row names what left and what arrived',
       h[0]?.left?.[0]?.name === 'gem' && h[0]?.left?.[0]?.amount === 3 && h[0]?.arrived?.[0]?.name === 'rock');
    ok('the history file is not mistaken for a chest', s.allChests().length === 1);
    s.writeChest('r18c2', { items: [], at: 4000, room: 714 });
    ok('history reads newest first', s.readChestHistory('r18c2')[0]?.at === 4000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
