#!/usr/bin/env node
// THE WIDTH IS THE REQUIREMENT, SO IT IS ASSERTED AND NOT DESCRIBED.
//
// Offline: no socket, no broker, no roster. `render()` is pure on purpose — the fetching
// lives in `main()` — so the layout can be tested against numbers that will not occur for
// months without waiting for them.
//
// The operator's constraint was a line, not a number: "no lines wider than this next one",
// and that line measured 43. A layout rule written in a comment lasts one commit; the money
// columns are the ones that grow, and they grow silently — a fleet that banks a million
// shillings adds three characters to a line nobody re-measures.
import { render, MAX_WIDTH } from './m59-fs.mjs';

let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
};

const widestOf = (o) => Math.max(...render(o).map(l => l.length));

const base = {
  chars: 24, kpm: 0.37, hp: { min: 20, avg: 51.17, max: 62 },
  purse: 21766, banked: 84710, bankedFrom: 23, bankedOf: 24,
  oldestMs: 9 * 86_400_000,
};

console.log(`--- every line fits ${MAX_WIDTH} columns ---`);
ok('the ordinary fleet', widestOf(base) <= MAX_WIDTH, `${widestOf(base)} cols`);

// THE NUMBERS THAT GROW. Money is the column with no ceiling, and `toLocaleString` adds a
// separator every three digits — so the failure arrives as a slow drift rather than a jump.
const rich = { ...base, purse: 9_999_999, banked: 99_999_999 };
ok('a fleet with a hundred million banked', widestOf(rich) <= MAX_WIDTH, `${widestOf(rich)} cols`);

// A three-digit max health and a three-digit roster are both reachable.
const big = { ...base, chars: 100, hp: { min: 100, avg: 150, max: 199 }, kpm: 12.34 };
ok('three-digit health, roster and kill rate', widestOf(big) <= MAX_WIDTH, `${widestOf(big)} cols`);

// A year-old balance is the case the staleness line exists for, and it is the longest
// version of that line.
const stale = { ...base, oldestMs: 365 * 86_400_000 };
ok('a balance a year old', widestOf(stale) <= MAX_WIDTH, `${widestOf(stale)} cols`);

console.log('\n--- and it still says the things it is for ---');
{
  const out = render(base).join('\n');
  ok('kills per minute is present', /kills\/min\s+0\.37/.test(out));
  ok('max health is min, average and max', /max hp\s+20 \/ 51 \/ 62/.test(out));
  ok('the total is purse plus banked', /TOTAL\s+106,476/.test(out),
     '21,766 + 84,710');
  ok('and how many characters the banked figure covers', /23\/24/.test(out),
     'a total from 23 of 24 is not a fleet total, and the line must say so');
}

console.log('\n--- staleness is never silent ---');
{
  // A BALANCE IS PROSE THE BANKER SPOKE ONCE. There is no packet for it, so a recorded
  // balance is as old as the character's last visit to a teller — sometimes a month. A
  // confident total over a month-old component is the most misleading thing this can print.
  ok('an old read is called out', /may be stale/.test(render(base).join('\n')));
  ok('and the age is given in days', /oldest bank read 9d/.test(render(base).join('\n')));
  const fresh = render({ ...base, oldestMs: null }).join('\n');
  ok('no staleness line when nothing is dated', !/may be stale/.test(fresh),
     'a warning that always fires is a warning nobody reads');
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
