#!/usr/bin/env node
// OFFLINE TEST FOR THE DEV-CLIENT LAUNCHER — the file every patched-client launch goes
// through, and the one place a password on a command line is arranged.
//
//   node tools/m59-devclient-test.mjs
//
// What it pins:
//
//   * shortcuts/dev.bat names NO character and carries NO password: the character is its
//     five arguments, so one file serves twenty-one characters and the terminal alike.
//   * The FOR variable is written `%%a`, not `%%%%a`. The first version of this tool wrote
//     the latter, which cmd rejects with "%%a was unexpected at this time" — so every
//     launcher it generated died on its endpoint lookup before starting anything.
//   * A per-character file is ONE `call` line with the arguments in the order dev.bat
//     wants them — host, port, account, password, label — and the terminal builds its
//     arguments from the same function, so the two cannot disagree about which is which.
//   * ensureUniversalLauncher rewrites a stale file and leaves a current one alone.
//   * On Windows, the generated dev.bat actually runs: with M59_DEVCLIENT_DRYRUN set it
//     prints the endpoint it resolved and the account it would log in as, and exits 0;
//     with too few arguments it prints usage and exits 2. The endpoint lookup goes through
//     `m59-devclient.mjs --endpoint`, which reads substrate/proxies and nothing else.
//   * proxyFor refuses an advert whose pid has been RECYCLED — alive, but started after the
//     advert was written. 2026-09-24: a dead proxy's pid had become a prod keeper, and every
//     launch from the fleet terminal went to a localhost port where nothing listened.
//
// Opens no socket, reads no roster, starts no client.
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  universalLauncherText, ensureUniversalLauncher, universalLauncherArgs, launcherText, UNIVERSAL_BAT,
  proxyFor,
} from './m59-devclient.mjs';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('  FAIL ' + what); } };

const entry = { agent: 'q9', account: 'acct9', password: 'hunter2', character: 'Tester', host: '10.0.0.5', port: 15959 };
const client = join('C:\\', 'nowhere', 'run', 'localclient', 'meridian.exe');

// ---------------------------------------------------------------- the universal file
console.log('universalLauncherText');
{
  const t = universalLauncherText({ client, overlayDir: 'C:\\ov', signalPort: 8907, mapUrl: 'http://127.0.0.1:8977' });
  ok(!t.includes('hunter2') && !t.includes('acct9') && !t.includes('Tester'), 'names no character and no password');
  ok(!/\/W:[^%]/.test(t), 'the password slot is an argument (%~4), not a value');
  ok(t.includes('/U:%~3 /W:%~4 /Q'), 'account and password are arguments 3 and 4');
  ok(t.includes('--endpoint %~1 %~2'), 'host and port are arguments 1 and 2, resolved through --endpoint');
  ok(t.includes('%%a') && !t.includes('%%%%a'), 'FOR variable is %%a, which cmd accepts');
  ok(t.includes('if "%~4"=="" ('), 'refuses fewer than four arguments');
  ok(t.includes('if not defined M59_OVERLAY_DIR set "M59_OVERLAY_DIR=C:\\ov"'), 'overlay dir is a default, not an override');
  ok(t.includes('if not defined M59_SIGNAL_PORT set "M59_SIGNAL_PORT=8907"'), 'signal port likewise');
  ok(t.includes('if not defined M59_MAP_URL set "M59_MAP_URL=http://127.0.0.1:8977"'), 'map url likewise');
  ok(t.includes(`cd /d "C:\\nowhere\\run\\localclient"`), 'starts in the client\'s own directory');
  ok(t.includes(`start "" /D "C:\\nowhere\\run\\localclient" "${client}"`), 'start with an empty title');
  ok(t.includes(`if not exist "${client}"`), 'says so when the client is not built');
  ok(t.split('\r\n').length > 20 && t.endsWith('\r\n'), 'CRLF, for cmd');
  const t0 = universalLauncherText({ client, title: false });
  ok(t0.includes('M59_DEBUG_TITLE=0'), '--no-title turns the caption off');
}

// ---------------------------------------------------------------- the arguments
console.log('universalLauncherArgs');
{
  const a = universalLauncherArgs(entry);
  ok(JSON.stringify(a) === JSON.stringify(['10.0.0.5', '15959', 'acct9', 'hunter2', 'Tester']),
     'host, port, account, password, label — in that order');
  const b = universalLauncherArgs(entry, { host: '127.0.0.1', port: 5961 });
  ok(b[0] === '127.0.0.1' && b[1] === '5961', 'an explicit endpoint overrides the entry\'s');
  const c = universalLauncherArgs({ ...entry, character: null });
  ok(c[4] === 'q9', 'label falls back to the agent id');
  ok(universalLauncherArgs({ agent: null, account: 'x', password: 'y', host: 'h', port: 1 })[4] === 'x',
     'and then to the account');
}

// ---------------------------------------------------------------- the per-character file
console.log('launcherText');
{
  const t = launcherText(entry);
  const lines = t.split('\r\n').filter(l => l && !l.startsWith('rem'));
  ok(lines.length === 2 && lines[0] === '@echo off', 'one command besides @echo off');
  ok(lines[1] === 'call "%~dp0dev.bat" "10.0.0.5" "15959" "acct9" "hunter2" "Tester"',
     'calls dev.bat beside itself with the five arguments');
  ok(!t.includes('M59_OVERLAY_DIR') && !t.includes('start ""'), 'HOW is not repeated here');
  const p = launcherText(entry, { port: 5961 });
  ok(p.includes('"10.0.0.5" "5961"'), '--proxy writes the proxy port into the call');
  ok(p.includes('rem Tester (q9) on 10.0.0.5:5961'), 'and the header says so');
}

// ---------------------------------------------------------------- writing it
console.log('ensureUniversalLauncher');
const dir = mkdtempSync(join(tmpdir(), 'm59-devclient-test-'));
try {
  const r1 = ensureUniversalLauncher({ dir, client });
  ok(r1.written === true && r1.path === UNIVERSAL_BAT(dir) && existsSync(r1.path), 'writes dev.bat when absent');
  const r2 = ensureUniversalLauncher({ dir, client });
  ok(r2.written === false, 'leaves a current file alone');
  writeFileSync(r1.path, '@echo off\r\nrem stale\r\n');
  const r3 = ensureUniversalLauncher({ dir, client });
  ok(r3.written === true && readFileSync(r3.path, 'utf8') === universalLauncherText({ client }),
     'rewrites a stale one');

  // ---------------------------------------------------------------- it runs
  if (process.platform === 'win32') {
    console.log('dev.bat, executed');
    const run = (args, env = {}) => spawnSync('cmd.exe', ['/c', r3.path, ...args],
      { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20000 });
    const usage = run(['127.0.0.1']);
    ok(usage.status === 2 && /usage: dev\.bat <host>/.test(usage.stderr), 'too few arguments: usage on stderr, exit 2');

    // The fake client above does not exist, so without the dry run it must refuse —
    // AFTER the endpoint lookup, which is the FOR line that used to be broken.
    const missing = run(['198.51.100.7', '5959', 'acct9', 'hunter2', 'Tester']);
    ok(missing.status === 3 && /no patched client at/.test(missing.stderr), 'no client built: says so, exit 3');

    // And the dry run reports what the FOR line resolved. 198.51.100.7 is TEST-NET-2,
    // so no proxy on this machine can be fronting it and the answer is the input.
    const dry = run(['198.51.100.7', '5959', 'acct9', 'hunter2', 'Tester'], { M59_DEVCLIENT_DRYRUN: '1' });
    ok(dry.status === 0, 'dry run exits 0' + (dry.status === 0 ? '' : ` (got ${dry.status}: ${dry.stderr})`));
    ok(dry.stdout.trim() === '198.51.100.7 5959 acct9 Tester',
       `dry run prints endpoint, account, label (got ${JSON.stringify(dry.stdout.trim())})`);
    ok(!dry.stdout.includes('hunter2'), 'and never the password');
  } else {
    console.log('dev.bat, executed — skipped (not Windows)');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- whose proxy is it
console.log('proxyFor');
{
  const pdir = mkdtempSync(join(tmpdir(), 'm59-proxies-'));
  try {
    // The advert that caused it, as it was on disk: written 2026-09-09, pid 59560.
    const at = 1789004300612;
    writeFileSync(join(pdir, '5960.json'),
      JSON.stringify({ listen: 5960, server: { host: '76.214.42.186', port: 5959 }, pid: 59560, at }));
    const live = () => true;
    let asked = 0;
    const find = (startedAt, isLive = live, h = '76.214.42.186', p = 5959) =>
      proxyFor(h, p, { dir: pdir, isLive, startedAt: () => { asked++; return startedAt; } });

    // 21:18 on 2026-09-24, when that pid was a prod keeper.
    ok(find(Date.parse('2026-09-25T04:18:30Z')) === null,
       'a live pid that started AFTER the advert was written is a recycled one: connect direct');
    ok(find(at - 1500)?.listen === 5960, 'the proxy that wrote it, started just before: use it');
    ok(find(at + 1000)?.listen === 5960, 'within the start-time tolerance: still the writer');
    ok(find(null)?.listen === 5960, 'a start time that cannot be read keeps the old answer');
    asked = 0;
    ok(find(at - 1500, () => false) === null && asked === 0, 'a dead pid: no match, and no start-time lookup');
    ok(find(at - 1500, live, '76.214.42.186', 15959) === null && asked === 0,
       'a proxy for another server is not asked about at all');
  } finally {
    rmSync(pdir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
