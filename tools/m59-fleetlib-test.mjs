#!/usr/bin/env node
// RELOAD ACTUALLY RELOADS — the script loader, against scratch directories.
//
//   node tools/m59-fleetlib-test.mjs
//
// Offline: no broker, no socket, no fleet. Writes .mjs fixtures into a temp directory and
// points loadFleetScripts at them with its publicDir/localDir options.
//
// THE BUG THIS EXISTS FOR, measured 2026-09-11. loadFleetScripts imported
// `pathToFileURL(path).href` with nothing on the end, and the ESM module cache is keyed on the
// URL — so re-importing an EDITED file returned the module from the first import. `reload` in
// m59-fleet-repl.mjs picked up new files and silently ignored every edit to an existing one,
// which is the worst available failure for an authoring loop: the author changes a step, types
// `reload`, sees the old steps render, and concludes the EDIT was wrong. The stale thing looks
// freshly confirmed.
//
// Every case below is that bug, or a property the fix must not break while fixing it.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFleetScripts } from './m59-fleetlib.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};

const root = mkdtempSync(join(tmpdir(), 'm59-fleetlib-'));
const pub = join(root, 'public'), loc = join(root, 'local');
mkdirSync(pub); mkdirSync(loc);

const load = () => loadFleetScripts({ publicDir: pub, localDir: loc });

// A fixture is the minimum a script may be: a name, a steps function, and an object whose
// IDENTITY tells us whether we got a fresh module or the cached one. Identity rather than a
// load counter on purpose — a counter is work at import time, and the one rule a script module
// has is that it does nothing at all when it is loaded.
const fixture = (name, room, pad = '') =>
  `export const script = {\n` +
  `  name: '${name}',\n` +
  `  marker: {},\n` +
  `  async steps() { return [{ do: 'walk', to: ${room} }]; },\n` +
  `};${pad}\n`;

console.log('\na script loads at all');
writeFileSync(join(pub, 'errand.mjs'), fixture('errand', 11));
{
  const { scripts, problems } = await load();
  ok('the script is found by name', scripts.has('errand'));
  ok('and nothing is reported as a problem', problems.length === 0, JSON.stringify(problems));
  const steps = await scripts.get('errand').steps({});
  ok('and its steps are the ones on disk', steps[0].to === 11, JSON.stringify(steps));
}

console.log('\nAN EDIT IS PICKED UP — the bug');
{
  const before = (await load()).scripts.get('errand').marker;
  // A longer body, so this case moves the SIZE half of the key as well as the mtime and does
  // not lean on the filesystem's clock resolution. The mtime half gets its own case next.
  writeFileSync(join(pub, 'errand.mjs'), fixture('errand', 53, '\n// edited\n'));
  const after = (await load()).scripts.get('errand');
  const steps = await after.steps({});
  ok('reloading after an edit returns the NEW steps', steps[0].to === 53, JSON.stringify(steps));
  ok('and it is a different module instance', after.marker !== before);
}

console.log('\nand an edit that does not change the file SIZE is picked up too');
{
  const file = join(pub, 'errand.mjs');
  const before = (await load()).scripts.get('errand').marker;
  const body = fixture('errand', 39, '\n// edited\n');   // 39 and 53 are both two digits
  ok('the rewrite is identical in length',
     body.length === fixture('errand', 53, '\n// edited\n').length);
  writeFileSync(file, body);
  // mtime moved by hand: two writes inside one tick of the filesystem clock would otherwise
  // share a key, and that is a real case when a watcher fires on a GENERATED file rather than
  // on a human's save.
  const st = statSync(file);
  utimesSync(file, st.atime, new Date(st.mtimeMs + 2000));
  const after = (await load()).scripts.get('errand');
  ok('mtime alone is enough to reload', (await after.steps({}))[0].to === 39);
  ok('and it is a different module instance', after.marker !== before);
}

console.log('\nAN UNCHANGED FILE IS NOT RE-IMPORTED — why the key is mtime and not Date.now()');
{
  const a = (await load()).scripts.get('errand').marker;
  const b = (await load()).scripts.get('errand').marker;
  // Not an optimisation for its own sake: every distinct key strands a module instance in the
  // loader for the life of the process, and `list` is typed far more often than a file is
  // edited. Date.now() would strand one per listing.
  ok('two loads with no edit share one module instance', a === b);
}

console.log('\na new file appears, a deleted one goes away');
{
  writeFileSync(join(pub, 'second.mjs'), fixture('second', 70));
  let { scripts } = await load();
  ok('the new script is listed', scripts.has('second'));
  ok('and the first one is still there', scripts.has('errand'));
  rmSync(join(pub, 'second.mjs'));
  ({ scripts } = await load());
  ok('the deleted script is gone', !scripts.has('second'));
}

console.log('\nlocal wins on a name clash, and says so');
{
  writeFileSync(join(loc, 'errand.mjs'), fixture('errand', 599));
  const { scripts } = await load();
  const s = scripts.get('errand');
  ok('the local file is the one that runs', (await s.steps({}))[0].to === 599);
  ok('its source is local', s.source === 'local');
  ok('and it names the committed file it overrides',
     !!s.overrides && /public/.test(s.overrides), String(s.overrides));
  rmSync(join(loc, 'errand.mjs'));
}

console.log('\na module that is not a script is REPORTED, never skipped silently');
{
  writeFileSync(join(pub, 'broken.mjs'), 'export const nothing = 1;\n');
  writeFileSync(join(pub, 'syntax.mjs'), 'export const script = {{{\n');
  writeFileSync(join(pub, 'nosteps.mjs'), "export const script = { name: 'nosteps' };\n");
  const { scripts, problems } = await load();
  const why = f => problems.find(p => p.file.endsWith(f))?.why ?? '';
  ok('a module exporting no script is reported',
     /exports no `script` object/.test(why('broken.mjs')), why('broken.mjs'));
  ok('a module that will not parse is reported',
     /will not import/.test(why('syntax.mjs')), why('syntax.mjs'));
  ok('a script with no steps function is reported',
     /no steps\(params\) function/.test(why('nosteps.mjs')), why('nosteps.mjs'));
  ok('and none of the three is listed as runnable',
     !scripts.has('broken') && !scripts.has('syntax') && !scripts.has('nosteps'));
  for (const f of ['broken.mjs', 'syntax.mjs', 'nosteps.mjs']) rmSync(join(pub, f));
}

console.log('\na malformed waiver is refused at LOAD, not with a character already walking');
{
  const risky = body =>
    `export const script = { name: 'risky', unsafe: ${body}, async steps() { return []; } };\n`;
  const whyRisky = async () =>
    (await load()).problems.find(p => p.file.endsWith('risky.mjs'))?.why ?? '';

  writeFileSync(join(pub, 'risky.mjs'), risky("{ waives: ['trapCheck'] }"));
  ok('a waiver with no reason is refused', /needs a reason/.test(await whyRisky()));
  writeFileSync(join(pub, 'risky.mjs'), risky("{ reason: 'because', waives: ['noSuchThing'] }"));
  ok('a waiver naming an unknown guarantee is refused',
     /unknown guarantee/.test(await whyRisky()));
  writeFileSync(join(pub, 'risky.mjs'), risky("{ reason: 'because', waives: ['trapCheck'] }"));
  ok('a well-formed waiver loads', (await load()).scripts.has('risky'));
  rmSync(join(pub, 'risky.mjs'));
}

console.log('\na -test.mjs beside a script is not a script');
{
  // It would be EXECUTED by the loader if it were, which is why this is pinned rather than
  // assumed: a test file next to an errand is the normal arrangement in this repository.
  writeFileSync(join(pub, 'errand-test.mjs'), 'process.exit(99);\n');
  const { scripts, problems } = await load();
  ok('the test file is not loaded as a script', !scripts.has('errand-test'));
  ok('and it is not reported as a problem either',
     !problems.some(p => /errand-test/.test(p.file)));
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
