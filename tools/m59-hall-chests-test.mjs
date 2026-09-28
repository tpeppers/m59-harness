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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
