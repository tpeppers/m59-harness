#!/usr/bin/env node
// THE SESSION ITSELF, DRIVEN AS A CHILD PROCESS. Offline: no broker, no socket, no fleet.
//
//   node tools/m59-fleetscratch-session-test.mjs
//
// WHY A SECOND TEST FILE, AND WHY IT SPAWNS. m59-fleetscratch-test.mjs imports `loadPads` and
// calls it directly, which means the session's own startup never runs — and on 2026-09-11 that is
// exactly what let a fatal bug through 46 green cases.
//
// A pad that imported its check helpers from m59-fleetscratch.mjs closed a cycle: the pad waited
// for that module to finish evaluating, and that module was inside its top-level
// `await loadPads()` waiting for the pad. Node prints
//
//     Warning: Detected unsettled top-level await at .../m59-fleetscratch.mjs:460
//
// and exits 0 with nothing else on stdout. No pads, no prompt, no reason, no failure. And the
// example pad told every future pad to write that import, so the first real customer hit it
// immediately. Found by the peer session running the raid, not by this repository's tests.
//
// Two things are therefore pinned HERE rather than in the unit file: that the session actually
// comes up with a pad on disk, and that a pad importing the session module is REPORTED instead of
// hanging. Neither is visible without starting the real thing.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { readBoard, post, writeBoard } from './m59-board.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NL2 = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};

const root = mkdtempSync(join(tmpdir(), 'm59-session-'));

// THE SPAWNED SESSIONS SHARE ONE BOARD, in a temp directory, so these tests exercise the real
// gate without touching the machine's own board. `go` refuses an unpinned pad by design, so a
// phase test that wants to reach setup has to pin its pad first — which is the gate working, and
// is why these three lines exist rather than a flag that turns it off.
const BOARD = join(root, 'board');
mkdirSync(BOARD);
const BOARD_ENV = { M59_BOARD_DIR: BOARD };
const pin = (name, agents = []) => {
  const b = post(readBoard('prod', BOARD_ENV),
                 { name, by: 'session-test', purpose: 'a phase ordering fixture', agents });
  writeBoard({ ...b, fleet: 'prod' }, BOARD_ENV);
};

/** Run the session over one pad directory, feed it lines, return everything it said. */
function session(padDir, lines, { ms = 9000, env = {} } = {}) {
  return new Promise((resolve) => {
    const kid = spawn(process.execPath, [join(HERE, 'm59-fleetscratch.mjs')], {
      env: { ...process.env, M59_FLEETSCRATCH_DIR: padDir,
             M59_SCRATCH_OPERATOR: 'session-test', ...BOARD_ENV, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    kid.stdout.on('data', d => { out += d; });
    kid.stderr.on('data', d => { out += d; });
    // A HARD DEADLINE IS THE POINT. The bug being pinned is a HANG, so a test that waited for the
    // child would itself hang; it has to time out and report what it got.
    const timer = setTimeout(() => { kid.kill(); resolve({ out, timedOut: true }); }, ms);
    kid.on('close', (code) => { clearTimeout(timer); resolve({ out, code, timedOut: false }); });
    kid.stdin.write(lines.join('\n') + '\nquit\n');
    kid.stdin.end();
  });
}

const padSrc = (importFrom) =>
  `import { knows } from '${importFrom}';\n` +
  `export const script = {\n` +
  `  name: 'helperpad', describe: 'imports its check helpers',\n` +
  `  requires: [{ what: 'knows bless', check: knows('bless') }],\n` +
  `  params: { agents: { type: 'agents', required: true } },\n` +
  `  async steps() { return [{ do: 'walk', to: 39 }]; },\n};\n`;

// The pad directory is a temp one, so the import has to be absolute — and on Windows a bare
// `C:\...` is refused by the ESM loader, which is its own trap. A file:// URL is what works.
const urlOf = (file) => new URL(`file:///${join(HERE, file).replace(/\\/g, '/')}`).href;

console.log('\nthe session comes up with a pad that imports from m59-padcheck.mjs');
{
  const dir = join(root, 'good');
  mkdirSync(dir);
  writeFileSync(join(dir, 'helperpad.mjs'), padSrc(urlOf('m59-padcheck.mjs')));
  const { out, timedOut } = await session(dir, ['list', 'dry helperpad agents=t1']);
  ok('it did not hang', !timedOut, out.slice(0, 300));
  ok('the pad is listed', /helperpad\s+imports its check helpers/.test(out), out.slice(0, 400));
  ok('it reports no load problem', !/will not import/.test(out), out.slice(0, 400));
  ok('and the steps compile', /0\. walk -> room 39/.test(out), out.slice(0, 600));
  ok('the unsettled-await warning is gone', !/unsettled top-level await/.test(out));
}

console.log('\nA PAD THAT IMPORTS THE SESSION MODULE IS REPORTED, NOT A HANG — the regression');
{
  const dir = join(root, 'cycle');
  mkdirSync(dir);
  writeFileSync(join(dir, 'helperpad.mjs'), padSrc(urlOf('m59-fleetscratch.mjs')));
  const { out, timedOut } = await session(dir, ['list']);
  ok('the session still starts', !timedOut && /fleetscratch — fleet/.test(out), out.slice(0, 300));
  ok('it never hangs on an unsettled top-level await', !/unsettled top-level await/.test(out));
  ok('the pad is not listed as runnable', !/^\s+helperpad\s/m.test(out));
  ok('and the failure names the file and says why',
     /helperpad\.mjs: will not import/.test(out) &&
     /does not provide an export named 'knows'/.test(out), out.slice(0, 700));
}

console.log('\nthe operator gate refuses automation, and says so on stderr');
{
  const dir = join(root, 'gate');
  mkdirSync(dir);
  const kid = spawn(process.execPath, [join(HERE, 'm59-fleetscratch.mjs')], {
    // No M59_SCRATCH_OPERATOR, and stdin is a pipe rather than a TTY.
    env: { ...process.env, M59_FLEETSCRATCH_DIR: dir, M59_SCRATCH_OPERATOR: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  kid.stdout.on('data', d => { out += d; });
  kid.stderr.on('data', d => { out += d; });
  kid.stdin.end();
  const code = await new Promise(r => kid.on('close', r));
  ok('it exits 3, the same refusal code a second broker uses', code === 3, String(code));
  ok('it says nothing automated may drive a pad', /Nothing automated may drive a pad/.test(out));
  ok('and it names the way through for a deliberate piped session',
     /M59_SCRATCH_OPERATOR/.test(out));
}

console.log('\nA SETUP THAT FAILS STOPS THE ERRAND — the world is not in the declared state');
{
  const dir = join(root, 'setupfail');
  mkdirSync(dir);
  // No `lab: true`, so no DM requirement to satisfy; the setup just throws.
  writeFileSync(join(dir, 'p.mjs'),
    `export const script = {\n` +
    `  name: 'setupfail',\n` +
    `  params: { agents: { type: 'agents', required: true } },\n` +
    `  async setup() { throw new Error('the spawners would not turn off'); },\n` +
    `  async teardown() { console.log('TEARDOWN-RAN'); },\n` +
    `  async steps() { console.log('STEPS-BUILT'); return []; },\n};\n`);
  // THE RUN LOCK IS ISOLATED INTO A TEMP DIRECTORY, and the agents are names no roster has.
  // A test that took the real per-agent lock could contend with a live fleet, which is the one
  // thing a test in this repository must never do.
  pin('setupfail', ['zz-test-a']);
  const { out, timedOut } = await session(dir, ['go setupfail agents=zz-test-a'],
    { env: { M59_RUNLOCK_DIR: dir } });
  ok('it did not hang', !timedOut, out.slice(0, 300));
  ok('the setup ran', /setup: setupfail/.test(out), out.slice(-600));
  ok('its failure is reported with the reason',
     /setup FAILED: the spawners would not turn off/.test(out), out.slice(-600));
  ok('AND THE ERRAND DID NOT RUN', !/STEPS-BUILT/.test(out), out.slice(-600));
  ok('the refusal explains why, not just that',
     /not in the state the pad was written against/.test(out), out.slice(-600));
  // Nothing was set up, so there is nothing to tear down — running teardown here would
  // un-configure a world the pad never configured.
  ok('and teardown did NOT run after a failed setup', !/TEARDOWN-RAN/.test(out), out.slice(-600));
}

console.log('\nTEARDOWN RUNS EVEN WHEN THE ERRAND FAILS — that is what the finally is for');
{
  const dir = join(root, 'teardown');
  mkdirSync(dir);
  // With no broker reachable, fleetScript fails. The point of the case is that teardown still
  // runs: the failure that wedges a lab is the one where the errand threw.
  writeFileSync(join(dir, 'p.mjs'),
    `export const script = {\n` +
    `  name: 'tdown',\n` +
    `  params: { agents: { type: 'agents', required: true } },\n` +
    `  async setup() { console.log('SETUP-RAN'); },\n` +
    `  async teardown() { console.log('TEARDOWN-RAN'); },\n` +
    `  async steps() { return [{ do: 'walk', to: 39 }]; },\n};\n`);
  pin('tdown', ['zz-test-b']);
  const { out, timedOut } = await session(dir, ['go tdown agents=zz-test-b'],
    { env: { M59_RUNLOCK_DIR: dir, M59_CONTROL_URL: 'http://127.0.0.1:1/nope' }, ms: 20000 });
  ok('it did not hang', !timedOut, out.slice(0, 300));
  ok('setup ran first', /SETUP-RAN/.test(out), out.slice(-800));
  ok('TEARDOWN RAN ANYWAY', /TEARDOWN-RAN/.test(out), out.slice(-800));
  ok('and setup came before teardown',
     out.indexOf('SETUP-RAN') < out.indexOf('TEARDOWN-RAN'));
}

console.log(NL2 + 'THE BOARD GATE, END TO END: looking is allowed, driving is not');
{
  const dir = join(root, 'boardgate');
  mkdirSync(dir);
  writeFileSync(join(dir, 'p.mjs'),
    `export const script = {\n` +
    `  name: 'unpinned',\n` +
    `  params: { agents: { type: 'agents', required: true } },\n` +
    `  async steps() { console.log('STEPS-BUILT'); return [{ do: 'walk', to: 39 }]; },\n};\n`);
  const { out, timedOut } = await session(dir,
    ['dry unpinned agents=zz-test-c', 'go unpinned agents=zz-test-c'],
    { env: { M59_RUNLOCK_DIR: dir } });

  ok('it did not hang', !timedOut, out.slice(0, 200));
  // LOOKING IS ALLOWED. You have to be able to read a pad before you can sensibly pin it, and
  // `dry` sends nothing, so gating it would only make people pin blind.
  ok('dry works on an unpinned pad', /0\. walk -> room 39/.test(out), out.slice(-700));
  // DRIVING IS NOT.
  ok('go REFUSES it', /is not on the scratchpad board/.test(out), out.slice(-700));
  ok('and the refusal names the board file', /\.scratchpads\.json/.test(out));
  ok('and hands over the exact command',
     /m59-board\.mjs post unpinned --by/.test(out), out.slice(-500));

  // The banner warns before you try, rather than at the moment you do.
  ok('the startup banner says which pads go will refuse',
     /not on the board, so `go` will refuse: unpinned/.test(out), out.slice(0, 800));
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
