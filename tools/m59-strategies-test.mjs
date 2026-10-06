#!/usr/bin/env node
// THE LOADER'S REFUSALS, WHICH ARE THE WHOLE POINT OF IT.
//
//   node tools/m59-strategies-test.mjs
//
// Offline: it writes throwaway strategy files into the scratch directory it makes, loads
// them, and deletes them. It opens no socket and touches no roster, and it never reads the
// real substrate/strategies/ — a test that depended on this machine's private strategies
// would pass here and fail for everybody else.
//
// WHAT IT PINS. The four policy rules, applied to code instead of numbers: silence is the
// behaviour that was already there; a file that will not parse is NOT an empty file; an
// unusable strategy keeps the committed behaviour; an unrecognised export is reported rather
// than dropped. Each one exists because its opposite has cost this repository a session.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, activeFor, firstAnswer, REQUIRED, HOOKS } from './m59-strategies.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

const dir = mkdtempSync(join(tmpdir(), 'm59-strategies-'));
const write = (name, body) => writeFileSync(join(dir, name), body);

console.log('\nprivate travel strategies — the loader');

// ---------------------------------------------------------------- silence
{
  const loaded = await load({ dir: join(dir, 'does-not-exist') });
  ok('no directory is not an error and not an empty policy',
     loaded.present === false && loaded.strategies.length === 0 && loaded.problems.length === 0,
     JSON.stringify(loaded));
}
{
  const loaded = await load({ dir });
  ok('an empty directory loads nothing and complains about nothing',
     loaded.present === true && loaded.strategies.length === 0 && loaded.problems.length === 0,
     JSON.stringify(loaded));
}

// ---------------------------------------------------------------- a good one
write('good.mjs', `export default {
  name: 'good', kind: 'travel', enabled: true,
  async whenStuck(ctx) { return ctx.wanted ? { do: 'blink' } : null; },
};`);
{
  const loaded = await load({ dir });
  ok('a well-formed strategy loads and reports the hooks it answers',
     loaded.strategies.length === 1 && loaded.strategies[0].name === 'good' &&
     loaded.strategies[0].hooks.join() === 'whenStuck',
     JSON.stringify(loaded.strategies.map(s => s.name)));
  ok('and it is active for the hook it declares, not for the one it does not',
     activeFor(loaded, 'whenStuck').length === 1 && activeFor(loaded, 'beforeCrossing').length === 0);
  const answered = await firstAnswer(loaded, 'whenStuck', { wanted: true });
  ok('firstAnswer takes the first strategy that offers something',
     answered?.strategy === 'good' && answered.answer.do === 'blink', JSON.stringify(answered));
  const declined = await firstAnswer(loaded, 'whenStuck', { wanted: false });
  ok('and declining is null rather than an answer nobody asked for', declined === null);
}

// ---------------------------------------------------------------- will not parse
write('broken.mjs', 'export default { name: "broken", kind: "travel", enabled: true,');
{
  const loaded = await load({ dir });
  const p = loaded.problems.find(x => x.file === 'broken.mjs');
  ok('a file that will not parse is REPORTED BY NAME, not treated as an empty file',
     !!p && /did not load/.test(p.why), JSON.stringify(loaded.problems));
  ok('and it does not take the working strategies down with it',
     loaded.strategies.some(s => s.name === 'good'),
     JSON.stringify(loaded.strategies.map(s => s.name)));
}
rmSync(join(dir, 'broken.mjs'));

// ---------------------------------------------------------------- unusable
write('nameless.mjs', `export default { kind: 'travel', enabled: true, async whenStuck() { return null; } };`);
// 'combat' was the example of an unknown kind until it became one (2026-10-05, pvpWand).
write('wrongkind.mjs', `export default { name: 'wk', kind: 'diplomacy', enabled: true, async whenStuck() { return null; } };`);
write('nohook.mjs', `export default { name: 'nh', kind: 'travel', enabled: true };`);
write('notastrategy.mjs', 'export const something = 1;');
{
  const loaded = await load({ dir });
  const why = f => loaded.problems.find(x => x.file === f)?.why ?? '';
  ok('a strategy missing a required field is refused and says which',
     REQUIRED.some(k => why('nameless.mjs').includes(k)), why('nameless.mjs'));
  ok('an unknown kind is refused rather than guessed at', /kind/.test(why('wrongkind.mjs')));
  ok('a strategy answering no hook is refused and names the hooks',
     HOOKS.every(h => why('nohook.mjs').includes(h)), why('nohook.mjs'));
  ok('a module with no default export is refused',
     /default export/.test(why('notastrategy.mjs')), why('notastrategy.mjs'));
  ok('and none of the four became a running strategy',
     loaded.strategies.every(s => s.name === 'good'),
     JSON.stringify(loaded.strategies.map(s => s.name)));
}
for (const f of ['nameless.mjs', 'wrongkind.mjs', 'nohook.mjs', 'notastrategy.mjs'])
  rmSync(join(dir, f));

// ---------------------------------------------------------------- combat
write('volley.mjs', `export default { name: 'volley', kind: 'combat', enabled: true,
  async pvpWand(ctx) { return { fire: ctx.wands[0].id, hold: true }; } };`);
{
  const loaded = await load({ dir });
  const v = loaded.strategies.find(s => s.name === 'volley');
  ok('a combat strategy answering pvpWand loads, with no problem reported',
     !!v && v.hooks.join() === 'pvpWand' && !loaded.problems.some(p => p.file === 'volley.mjs'),
     JSON.stringify(loaded.problems));
  const got = await firstAnswer(loaded, 'pvpWand', { wands: [{ id: 7 }] });
  ok('and it is the one asked for pvpWand', got?.strategy === 'volley' && got.answer.fire === 7, JSON.stringify(got));
}
rmSync(join(dir, 'volley.mjs'));

// ---------------------------------------------------------------- unrecognised
write('typo.mjs', `export default {
  name: 'typo', kind: 'travel', enabled: true,
  async whenStuck() { return null; },
  whenStuk() { return null; },
};`);
{
  const loaded = await load({ dir });
  const p = loaded.problems.find(x => x.file === 'typo.mjs');
  ok('an unrecognised export is REPORTED, naming it',
     !!p && p.unrecognised === true && p.why.includes('whenStuk'), JSON.stringify(p));
  ok('and the strategy still runs, because reporting is not refusing',
     loaded.strategies.some(s => s.name === 'typo'),
     'a setting that silently does nothing is how `purpose` stayed out of a schema for a year');
}
rmSync(join(dir, 'typo.mjs'));

// ---------------------------------------------------------------- off, and throwing
write('off.mjs', `export default {
  name: 'off', kind: 'travel', enabled: false,
  async whenStuck() { return { do: 'blink' }; },
};`);
// NAMED TO SORT FIRST, because strategies are asked in load order and load order is the
// directory listing. Called 'throws.mjs' it sorted after 'good.mjs', which answered, so the
// thrower was never asked and the test passed without testing anything.
write('a-throws.mjs', `export default {
  name: 'throws', kind: 'travel', enabled: true,
  async whenStuck() { throw new Error('boom'); },
};`);
{
  const loaded = await load({ dir });
  ok('a strategy that is off is loaded but never asked',
     loaded.strategies.some(s => s.name === 'off') &&
     !activeFor(loaded, 'whenStuck').some(s => s.name === 'off'));
  const errors = [];
  const answered = await firstAnswer(loaded, 'whenStuck', { wanted: true },
                                     { onError: e => errors.push(e) });
  ok('one that throws is reported and skipped, and the next one still answers',
     errors.some(e => e.strategy === 'throws') && answered?.strategy === 'good',
     JSON.stringify({ errors, answered }));
}

// ---------------------------------------------------------------- helpers
write('_recorder.mjs', 'export const record = () => {};');
{
  const loaded = await load({ dir });
  ok('a _-prefixed file is a helper and is neither loaded nor complained about',
     !loaded.strategies.some(s => s.file === '_recorder.mjs') &&
     !loaded.problems.some(p => p.file === '_recorder.mjs'),
     JSON.stringify(loaded.problems.map(p => p.file)));
}

// ---------------------------------------------------------------- duplicate names
write('dupe.mjs', `export default {
  name: 'good', kind: 'travel', enabled: true, async whenStuck() { return null; },
};`);
{
  const loaded = await load({ dir });
  // WHICHEVER LOSES, not a named file: load order is the directory listing, and 'dupe.mjs'
  // sorts before 'good.mjs', so it is good.mjs that arrives second and is refused. Asserting
  // the file by name was asserting the alphabet.
  ok('two strategies with the same name is refused rather than silently shadowed',
     loaded.problems.some(p => /already called "good"/.test(p.why)) &&
     loaded.strategies.filter(s => s.name === 'good').length === 1,
     JSON.stringify(loaded.problems.map(p => p.file + ': ' + p.why)));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
