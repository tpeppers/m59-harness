#!/usr/bin/env node
// A LEDGER NOBODY ROTATES BECOMES A LEDGER NOBODY CAN READ. Offline: a temp dir, no fleet.
//
// 2026-09-20, on prod: `substrate/trails/prod.jsonl` had reached 26.15 GB because nothing in
// this module had ever rotated anything. Reading it, measured:
//
//     readFileSync(file, 'utf8') -> ERR_STRING_TOO_LONG after 102,639 ms   (node v25.2.1)
//
// V8's MAX_STRING_LENGTH is 536,870,888, so the read could never have succeeded — but it does
// not fail at the stat. It reads all 26 GB first, blocking the loop for a hundred and two
// seconds, and the `catch { return []; }` that used to sit there turned that into "no samples
// recorded". A hundred seconds of blocked loop in a broker is long enough for blakserv to log
// out every character it holds (INACTIVE_GAME is 30 s).
//
// So two claims are pinned here and they are two halves of one rule: the WRITER rotates at
// the size the READER can hold, and the reader REFUSES anything past it out loud rather than
// spending the hundred seconds finding out. The env var is set before the import on purpose —
// the cap is read at module load, and a test that cannot make the cap small would have to
// make a half-gigabyte file to say anything.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'm59-trailsize-'));
process.env.M59_TRAILS_DIR = DIR;
process.env.M59_TRAIL_MAX_BYTES = '4096';          // small enough to test, same code path
process.env.M59_FLEET = 'trailsizetest';

const { rotateTrailIfHuge, readSamples, trailsFile, flushTrails, recordSeen, MAX_TRAIL_BYTES } =
  await import('./m59-trails.mjs');

// Capture the warnings, because "said so" is half of every assertion below.
const said = [];
const realError = console.error;
console.error = (...a) => { said.push(a.join(' ')); };
const spoke = () => said.splice(0).join('\n');

const row = i => JSON.stringify({ t: 1000 + i, body: 'a', room: 1, x: i * 64, y: 64 });
const write = (file, n) => fs.writeFileSync(file, Array.from({ length: n }, (_, i) => row(i)).join('\n') + '\n');

try {
  console.log('the cap is the size a reader can actually hold');
  {
    ok('MAX_TRAIL_BYTES is overridable', MAX_TRAIL_BYTES === 4096);
    // THE DEFAULT IS THE RUNTIME'S CEILING, NOT A ROUND NUMBER, and this asks the MODULE what
    // its default is rather than restating the arithmetic — a test that recomputes the value
    // it is checking passes whatever the code does. The first draft of this constant wrote
    // `512 * 1024 * 1024`, which is 536,870,912: twenty-four bytes ABOVE MAX_STRING_LENGTH, so
    // a file sized exactly to the cap would still have failed the read. A cap that does not
    // cap is worse than none, because it reads as protection.
    const { constants } = await import('node:buffer');
    const saved = process.env.M59_TRAIL_MAX_BYTES;
    delete process.env.M59_TRAIL_MAX_BYTES;
    // A query suffix defeats the module cache, so this is a second evaluation with no override.
    const fresh = await import('./m59-trails.mjs?shipped-default');
    process.env.M59_TRAIL_MAX_BYTES = saved;
    ok('the shipped default is exactly the string ceiling',
       fresh.MAX_TRAIL_BYTES === constants.MAX_STRING_LENGTH,
       `${fresh.MAX_TRAIL_BYTES} vs ${constants.MAX_STRING_LENGTH}`);
    ok('and a file at the cap is one a reader can hold',
       fresh.MAX_TRAIL_BYTES <= constants.MAX_STRING_LENGTH);
  }

  console.log('');
  console.log('the writer rotates, and rotating is not truncating');
  {
    const f = path.join(DIR, 'small.jsonl');
    write(f, 3);
    ok('a small file is left alone', rotateTrailIfHuge(f) === null);
    ok('and is still there', fs.existsSync(f));
    spoke();

    const big = path.join(DIR, 'big.jsonl');
    write(big, 400);                                   // comfortably over 4096 bytes
    const before = fs.statSync(big).size;
    const rolled = rotateTrailIfHuge(big);
    ok('an oversized file is rotated', typeof rolled === 'string' && rolled !== big, String(rolled));
    ok('the active name is free again', !fs.existsSync(big));
    ok('and every byte survived under the new name',
       fs.existsSync(rolled) && fs.statSync(rolled).size === before);
    ok('the rolled name is still a .jsonl, so the readers still find it',
       rolled.endsWith('.jsonl'));
    ok('and it said so', /rotated big\.jsonl/.test(spoke()));

    ok('a file that is not there is not an error', rotateTrailIfHuge(path.join(DIR, 'nope.jsonl')) === null);
    ok('and a missing file says nothing', spoke() === '');
  }

  console.log('');
  console.log('flushTrails rotates before it appends');
  {
    const f = trailsFile();
    write(f, 400);
    ok('the active trail starts oversized', fs.statSync(f).size > 4096);
    // A row `recordSeen` will actually keep: an id, finite x/y, and a body it is allowed to
    // record — monsters are dropped unless asked for, and `player` is how it knows.
    recordSeen({ id: 4463, name: 'someone', player: true, room: 1, x: 0, y: 0 });
    recordSeen({ id: 4463, name: 'someone', player: true, room: 1, x: 900, y: 0 });
    const n = flushTrails();
    ok('the flush wrote its rows', n >= 1, String(n));
    ok('and it rotated first', /rotated/.test(spoke()));
    ok('so the active file is small again', fs.statSync(f).size <= 4096,
       String(fs.statSync(f).size));
    const rolledCount = fs.readdirSync(DIR).filter(x => /^trailsizetest-.*\.jsonl$/.test(x)).length;
    ok('and the old rows are beside it, not gone', rolledCount === 1, `${rolledCount} rolled`);
  }

  console.log('');
  console.log('the reader refuses what it cannot hold, and says which');
  {
    const f = path.join(DIR, 'unreadable.jsonl');
    write(f, 400);
    const rows = readSamples(f);
    const why = spoke();
    ok('an oversized file reads as no samples', Array.isArray(rows) && rows.length === 0);
    // EMPTY AND UNREADABLE MUST NOT LOOK THE SAME. This is the whole finding: the old code
    // returned [] for both, and every caller read it as "this fleet has no trail".
    ok('but it SAYS it was skipped rather than empty', /is .*GB, past the/.test(why), why);
    ok('and names the file', /unreadable\.jsonl/.test(why), why);

    // The content is perfectly good JSONL — so the cap is what refused it, not a parse.
    const okFile = path.join(DIR, 'fine.jsonl');
    write(okFile, 3);
    const good = readSamples(okFile);
    ok('a file under the cap still reads', good.length === 3, JSON.stringify(good).slice(0, 80));
    ok('and reading it is silent', spoke() === '');
  }

  console.log('');
  console.log('a read that fails is a fact about this run, not an empty trail');
  {
    ok('a file that does not exist reads as empty',
       readSamples(path.join(DIR, 'absent.jsonl')).length === 0);
    ok('and does not cry wolf about it', spoke() === '');

    const dir = path.join(DIR, 'adirectory');
    fs.mkdirSync(dir, { recursive: true });
    const rows = readSamples(dir);
    ok('something unreadable reads as empty too', rows.length === 0);
    ok('but is reported', /cannot read adirectory/.test(spoke()));
  }

  console.log('');
  console.log('a torn last line is still not a crisis');
  {
    const f = path.join(DIR, 'torn.jsonl');
    fs.writeFileSync(f, row(1) + '\n' + row(2) + '\n{"t":3,"bo');
    const rows = readSamples(f);
    ok('the whole lines are kept', rows.length === 2, String(rows.length));
    spoke();
  }
} finally {
  console.error = realError;
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* temp dir */ }
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
