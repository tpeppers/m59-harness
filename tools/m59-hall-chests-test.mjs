#!/usr/bin/env node
// OFFLINE. m59-hall-chests.mjs summarise(): the chest readings printed without walking to the hall.
import { summarise } from './m59-hall-chests.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const now = 10 * 60000;
const chests = [{ slot: 'r18c2', room: 714, opened_by: 't11', observed_at: 0, items: [
  { name: 'elderberry', amount: 100 }, { name: 'elderberry', amount: 24 },
  { name: 'scroll', amount: 0 }, { name: 'scroll', amount: 1 }, { name: 'ring', amount: 0 },
  { name: 'ring of lethargy', amount: 1 }] }];
const [s] = summarise(chests, { now });
ok(s.items.find(i => i.name === 'elderberry')?.amount === 124, 'stacks of one name are merged');
ok(s.items.find(i => i.name === 'scroll')?.amount === 2, 'amount 0 is ONE non-stacking item, not none');
ok(s.age_min === 10, 'every chest carries the age of its reading');
const [r] = summarise(chests, { find: 'ring', now });
ok(r.items.length === 2 && r.items.every(i => /ring/.test(i.name)), '--find keeps unidentified "ring" as well as named rings');
ok(summarise([], {}).length === 0, 'no readings is no chests, not invented ones');
// TWO HALLS: a square names a chest in each, so every row says its hall and the guild that owns it.
const two = summarise([{ ...chests[0] }, { ...chests[0], room: 705, chest_id: '705/r18c2' }],
                      { now, owners: { 714: 'Guild A' } });
ok(two.map(c => c.chest_id).join(',') === '714/r18c2,705/r18c2', 'each chest carries a chest_id naming its hall');
ok(two[0].guild === 'Guild A' && two[1].guild === null, 'and its owner, or null where nothing records one');
ok(/Bookmaker/.test(two[0].hall_name ?? ''), "and the hall's name");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
