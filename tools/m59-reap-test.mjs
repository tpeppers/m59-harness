#!/usr/bin/env node
// Offline guard for m59-reap.mjs: what it may kill, and the things it must never kill.
//   node tools/m59-reap-test.mjs
import { classify, isMonitor } from './m59-reap.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };

const NOW = Date.parse('2026-10-05T12:00:00Z');
const old = NOW - 60 * 60_000;
const P = (pid, ppid, name, cmd, created = old) => ({ pid, ppid, name, cmd, created });

ok(isMonitor('tail.exe', 'tail.exe -n +1 -f x.log'), 'tail -f is a monitor');
ok(isMonitor('tail.exe', 'tail -n 0 -F x.log'), 'tail -F is a monitor');
ok(isMonitor('tail.exe', 'tail --follow=name x.log'), 'tail --follow is a monitor');
ok(isMonitor('tail.exe', 'tail -nf x.log') === true, 'bundled -nf counts as follow');
ok(!isMonitor('tail.exe', 'tail -n 50 x.log'), 'plain tail is not a monitor');
ok(!isMonitor('tail.exe', 'tail -n 50 my-file.log'), 'a hyphenated filename is not a follow flag');
ok(isMonitor('grep.exe', 'grep -E --line-buffered -i "died"'), 'line-buffered grep is a monitor');
ok(!isMonitor('grep.exe', 'grep -rn foo .'), 'one-shot grep is not a monitor');
ok(!isMonitor('node.exe', 'node x.mjs --line-buffered -f'), 'node is never a monitor');

const live = P(10, 1, 'bash.exe', 'bash', old - 1000);
const procs = [
  live,
  P(11, 10, 'tail.exe', 'tail -f a.log'),                       // parent alive: keep
  P(12, 99, 'tail.exe', 'tail -f a.log'),                       // parent gone: reap
  P(13, 99, 'grep.exe', 'grep --line-buffered x'),              // parent gone: reap
  P(14, 99, 'grep.exe', 'grep -rn x .'),                        // not a monitor: keep
  P(15, 99, 'node.exe', 'node m59-keeper-process.mjs --agent t1'), // node orphan: NEVER
  P(16, 99, 'tail.exe', 'tail -f a.log', NOW - 60_000),         // too young: keep
  P(20, 1, 'chrome.exe', 'chrome', old + 5000),                 // recycled parent pid
  P(17, 20, 'tail.exe', 'tail -f b.log'),                       // parent pid recycled: reap
  P(18, 99, 'cat.exe', 'cat -f x'),                             // not on the list: keep
];
const got = classify(procs, { now: NOW }).map(p => p.pid).sort((a, b) => a - b);
ok(JSON.stringify(got) === JSON.stringify([12, 13, 17]), `reaps exactly 12,13,17 (got ${got})`);
ok(!got.includes(15), 'an orphaned node keeper is never reaped');
ok(!got.includes(11), 'a pipeline whose shell is alive is left alone');
ok(!got.includes(16), 'a pipeline younger than min-age is left alone');
ok(classify(procs, { now: NOW, minAgeMs: 0 }).some(p => p.pid === 16), 'min-age 0 includes the young one');
ok(classify([P(30, 99, 'TAIL.EXE', 'tail -f x')], { now: NOW }).length === 1, 'image name is case-insensitive');
ok(classify([P(31, 99, 'tail.exe', 'tail -f x', NaN)], { now: NOW }).length === 0, 'unknown creation time is never reaped');

console.log(`m59-reap-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
