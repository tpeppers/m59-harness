#!/usr/bin/env node
// FLEETSCRATCH'S RETENTION CONTRACT — offline, in a throwaway directory, safe any time:
//
//   node tools/m59-scratch-test.mjs
//
// WHAT THIS PINS, AND WHY IT IS THE HALF WORTH TESTING. The scratch has one job that can go
// silently and irreversibly wrong: DELETING EVIDENCE. Every other defect here shows up as a
// missing number on a report; this one shows up as a recording that is not there any more, at
// the moment somebody goes looking for it, with no way to tell whether it was pruned or never
// written.
//
// So the three rules are asserted rather than documented: the kept half is never touched, the
// aggregates are never touched, and `--dry` deletes nothing at all.
//
// AND THE EPOCH IS STAMPED AT WRITE TIME. Reading it later would label old evidence with
// whatever the mover happens to be today — silently, and in the direction that makes two
// incomparable things look comparable, which is the exact failure the `#movement` epoch exists
// to prevent.
import { mkdtempSync, rmSync, existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-scratch-test-'));
process.env.M59_SCRATCH_DIR = dir;
const { save, list, read, prune, roll, aggregates, byEpoch, DEFAULT_HOURS } =
  await import('./m59-scratch.mjs');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
};
const eq = (label, got, want) =>
  ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

const age = (file, hours) => {
  const t = (Date.now() - hours * 3600_000) / 1000;
  utimesSync(file, t, t);
};

console.log('\nwriting a recording');
{
  const r = save('grind', { episodes: [{ kind: 'shuffle', ms: 1000 }] }, { label: 'room-578' });
  ok('it lands on disk', existsSync(r.file));
  const back = read(r.id);
  eq('and reads back', back?.kind, 'grind');
  eq('with the payload intact', back?.data?.episodes?.[0]?.ms, 1000);
  ok('the label survives into the id', r.id.includes('room-578'), r.id);
  // THE EPOCH IS PART OF THE RECORDING, not something computed when somebody reads it.
  ok('an epoch field is written at save time', 'epoch' in back);
}

console.log('\nthe prune drops old fine data');
{
  const old = save('grind', { n: 1 }, { label: 'yesterday' });
  const fresh = save('grind', { n: 2 }, { label: 'now' });
  age(old.file, 48);

  const dry = prune({ dry: true });
  eq('--dry reports what it would drop', dry.dropped, 1);
  ok('and deletes NOTHING', existsSync(old.file), 'the old file is still there');

  const real = prune({});
  eq('the real prune drops it', real.dropped, 1);
  ok('the old one is gone', !existsSync(old.file));
  ok('the fresh one is untouched', existsSync(fresh.file));
  eq('the window is 24h by default', DEFAULT_HOURS, 24);
}

console.log('\nthe kept half is never pruned — this is the one that matters');
{
  // A recording promoted to `keep` is somebody saying "I will want this later". Pruning it
  // would be the scratch destroying the exact thing the operator asked the scratch to make
  // possible: looking back at old movement behaviour through a lens invented afterwards.
  const kept = save('grind', { n: 3 }, { keep: true, label: 'the-ukgoth-wedge' });
  age(kept.file, 24 * 365);
  const r = prune({});
  ok('a year-old KEEP recording survives', existsSync(kept.file));
  eq('and the prune says so', r.kept >= 1, true);
  ok('it still reads back', read(kept.id)?.data?.n === 3);
}

console.log('\naggregates outlive everything');
{
  roll([{ epoch: 'aaa1111', kind: 'wall_contact', room: 578, row: 20, col: 30,
          count: 3, ms_total: 9000, ms_max: 5000 }]);
  roll([{ epoch: 'bbb2222', kind: 'wall_contact', room: 578, row: 20, col: 30,
          count: 1, ms_total: 1000, ms_max: 1000 }]);
  eq('both rows are there', aggregates().length, 2);

  // Prune everything prunable, hard.
  for (const r of list({ keep: false })) age(r.file, 10_000);
  prune({});
  eq('aggregates survive a total prune', aggregates().length, 2);
  eq('no fine recordings left', list({ keep: false }).length, 0);

  // AND THEY ARE APPEND-ONLY. A rewritten total cannot be audited; two lines can.
  roll([{ epoch: 'aaa1111', kind: 'wall_contact', room: 578, row: 20, col: 30,
          count: 5, ms_total: 20000, ms_max: 9000 }]);
  eq('a second roll-up for the same epoch APPENDS rather than replacing', aggregates().length, 3);
  eq('and can be read back per epoch', aggregates({ epoch: 'aaa1111' }).length, 2);
}

console.log('\nwhat was measured, per version of the movement code');
{
  const rows = byEpoch();
  eq('one row per epoch', rows.length, 2);
  const a = rows.find(r => r.epoch === 'aaa1111');
  eq('episodes are summed across its roll-ups', a.count, 8);
  eq('and so is the time', a.ms_total, 29000);
  // THE WHOLE POINT: two versions of the mover, side by side, comparable because neither
  // number was ever allowed to span the commit between them.
  const b = rows.find(r => r.epoch === 'bbb2222');
  ok('the other epoch is separate, not averaged in', b.count === 1 && b.ms_total === 1000);
}

console.log('\nrobustness, because a scratch that throws is a scratch nobody runs');
{
  ok('reading an unknown id is null, not a throw', read('nope.json') === null);
  eq('pruning an empty scratch is fine', typeof prune({ hours: 1 }).dropped, 'number');
  // A half-written line must not poison the whole permanent record.
  writeFileSync(join(dir, 'aggregates.jsonl'),
    '{"epoch":"ccc3333","count":1,"ms_total":5}\n{ broken json\n', { flag: 'a' });
  ok('a corrupt aggregate line is skipped, not fatal',
     aggregates().some(a => a.epoch === 'ccc3333'));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
