#!/usr/bin/env node
// Offline. Opens no socket, starts no program, touches no roster.
//
//   node tools/m59-keeper-restart-test.mjs
//
// THE KEEPER RESTART IS A HANDOFF UNLESS MEMORY SAYS OTHERWISE, AND A LOGOFF IS SAID OUT LOUD.
// Pins decideRestartMode's rule -- handoff when free > (concurrency + 1) x per-keeper RSS +
// margin -- its override, the one-at-a-time default for a broker without the port reservation,
// and that the callers which used to POST /stop now go through it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideRestartMode, defaultHandoffConcurrency, measureKeeperRssBytes, logoffKeepers,
  DEFAULT_KEEPER_RSS_MB, DEFAULT_MARGIN_MB,
} from './m59-keeper-restart.mjs';
import { brokerLacksHandoff } from './m59-war-restart.mjs';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const src = f => readFileSync(join(TOOLS, f), 'utf8');
const MB = 1024 * 1024, GB = 1024 * MB;
let n = 0;
const ok = (c, why) => { n++; assert.ok(c, why); };
const eq = (a, b, why) => { n++; assert.deepEqual(a, b, why); };
const noEnv = {};

// ---- the defaults are the documented ones
eq(DEFAULT_KEEPER_RSS_MB, 600, 'default per-keeper RSS is 600 MB');
eq(DEFAULT_MARGIN_MB, 2048, 'default margin is 2 GB');

// ---- enough memory: handoff at the concurrency asked for
{
  const d = decideRestartMode({ concurrency: 3, env: noEnv, freeBytes: 15.1 * GB });
  eq(d.mode, 'handoff', 'prod on 2026-09-30 (15.1 GB free) hands off');
  eq(d.concurrency, 3, 'at the concurrency asked for');
  eq(d.need_mb, 4 * 600 + 2048, 'need is (3 + 1) x 600 + 2048');
  eq(d.warnings, [], 'no warnings on the ordinary path');
  ok(/handoff/.test(d.message) && !/LOGOFF/.test(d.message), 'the message says handoff');
}

// ---- measured RSS is used when a caller has it
{
  const d = decideRestartMode({ concurrency: 1, env: noEnv, freeBytes: 15.1 * GB, keeperRssBytes: 490 * MB });
  eq([d.mode, d.per_keeper_mb, d.per_keeper_source], ['handoff', 490, 'measured'], 'measured 490 MB keepers');
}

// ---- short for the asked concurrency but not for one: lowered, not given up
{
  const free = (2 * 600 + 2048 + 100) * MB;   // fits 1, not 3
  const d = decideRestartMode({ concurrency: 3, env: noEnv, freeBytes: free });
  eq([d.mode, d.concurrency, d.asked_concurrency], ['handoff', 1, 3], 'concurrency lowered to what fits');
  ok(/lowered from 3/.test(d.message), 'and it says it lowered it');
}

// ---- short even for one: LOGOFF, loudly, with the free memory and the threshold
{
  const free = 3 * GB;
  const d = decideRestartMode({ concurrency: 1, env: noEnv, freeBytes: free });
  eq(d.mode, 'logoff', 'short memory falls back to the logoff');
  ok(/^LOGOFF RESTART/.test(d.message), 'announced in capitals');
  ok(d.message.includes(`${Math.round(free / MB)} MB free`), 'names the free memory');
  ok(d.message.includes(`${2 * 600 + 2048} MB`), 'names the threshold');
  ok(/M59_RESTART_MODE=handoff/.test(d.message), 'and how to force the handoff');
}

// ---- the boundary is strict: exactly the threshold is not enough
{
  const need = 2 * 600 + 2048;
  eq(decideRestartMode({ env: noEnv, freeBytes: need * MB }).mode, 'logoff', 'free == need is a logoff');
  eq(decideRestartMode({ env: noEnv, freeBytes: (need + 1) * MB }).mode, 'handoff', 'one MB over is a handoff');
}

// ---- the override: env and flag
{
  const plenty = 40 * GB, short = 1 * GB;
  const a = decideRestartMode({ env: { M59_RESTART_MODE: 'logoff' }, freeBytes: plenty });
  eq([a.mode, a.source], ['logoff', 'M59_RESTART_MODE'], 'M59_RESTART_MODE=logoff forces the logoff');
  ok(/forced by M59_RESTART_MODE=logoff/.test(a.message), 'and says who forced it');
  const b = decideRestartMode({ env: { M59_RESTART_MODE: 'handoff' }, freeBytes: short });
  eq(b.mode, 'handoff', 'M59_RESTART_MODE=handoff forces the handoff on a short machine');
  ok(b.warnings.some(w => /forced/.test(w) && /MB free/.test(w)), 'with a warning naming the shortfall');
  const c = decideRestartMode({ env: { M59_RESTART_MODE: 'logoff' }, requested: 'handoff', freeBytes: plenty });
  eq([c.mode, c.source], ['handoff', '--mode'], 'a caller --mode beats the environment');
  const d = decideRestartMode({ env: { M59_RESTART_MODE: 'AUTO' }, freeBytes: plenty });
  eq(d.mode, 'handoff', 'case-insensitive');
  const e = decideRestartMode({ env: { M59_RESTART_MODE: 'hand-off' }, freeBytes: plenty });
  eq([e.mode, e.requested], ['handoff', 'auto'], 'an unrecognised mode is treated as auto');
  ok(e.warnings.some(w => /unrecognised restart mode "hand-off"/.test(w)), 'and REPORTED, never silently applied');
}

// ---- a decision carried out later is attributed to whoever made it, never to --mode
{
  const a = decideRestartMode({ requested: 'logoff', decidedBy: 'the memory check above', env: noEnv, freeBytes: 1 * GB });
  eq(a.mode, 'logoff', 'the carried decision is honoured');
  ok(/decided by the memory check above/.test(a.message), 'and attributed to the decision');
  ok(!/forced by/.test(a.message), 'never "forced by --mode=logoff" when auto chose it');
  const b = decideRestartMode({ requested: 'handoff', decidedBy: 'x', env: noEnv, freeBytes: 1 * GB });
  eq(b.warnings, [], 'a carried handoff does not re-warn');
  ok(/claims, busy, live policy and mode are carried/.test(
     decideRestartMode({ env: noEnv, freeBytes: 1 * GB }).message), 'the logoff says assignments are carried');
}

// ---- the sizing knobs
{
  const d = decideRestartMode({ env: { M59_KEEPER_RSS_MB: '800', M59_RESTART_MARGIN_MB: '1000' }, freeBytes: 40 * GB });
  eq([d.per_keeper_mb, d.per_keeper_source, d.margin_mb, d.need_mb], [800, 'M59_KEEPER_RSS_MB', 1000, 2 * 800 + 1000],
     'M59_KEEPER_RSS_MB and M59_RESTART_MARGIN_MB are honoured');
  const m = decideRestartMode({ env: { M59_KEEPER_RSS_MB: '800' }, freeBytes: 40 * GB, keeperRssBytes: 500 * MB });
  eq(m.per_keeper_source, 'measured', 'a measurement beats the configured figure');
  const bad = decideRestartMode({ env: { M59_KEEPER_RSS_MB: 'lots', M59_RESTART_MARGIN_MB: '-5' }, freeBytes: 40 * GB });
  eq([bad.per_keeper_mb, bad.margin_mb], [600, 2048], 'unusable values keep the defaults');
  eq(bad.warnings.length, 2, 'and each is reported');
}

// ---- concurrency default: one at a time unless the broker advertises the port reservation
eq(defaultHandoffConcurrency(null), 1, 'no health: one at a time');
eq(defaultHandoffConcurrency({ ok: true }), 1, 'a broker older than the advertisement: one at a time');
eq(defaultHandoffConcurrency({ keeper_handoff: { tool: 'war_restart' } }), 1, 'handoff without the reservation: one');
eq(defaultHandoffConcurrency({ keeper_handoff: { tool: 'war_restart', port_reservation: true } }), 3,
   'a broker with fae8bd3 advertised may run three');
ok(/keeper_handoff:\s*\{\s*tool:\s*'war_restart',\s*port_reservation:\s*true\s*\}/.test(src('m59-broker.mjs')),
   'the broker /health advertises the port reservation');

// ---- RSS measurement: one hidden program start, filtered to the keepers asked about
{
  let seen = null;
  const csv = [
    '"node.exe","100","Console","1","501,234 K"',
    '"node.exe","200","Console","1","612,000 K"',
    '"node.exe","300","Console","1","9,999,999 K"',   // not a keeper we asked about
  ].join('\r\n');
  const exec = (cmd, args, opts) => { seen = { cmd, args, opts }; return csv; };
  eq(measureKeeperRssBytes([100, 200], { exec, platform: 'win32' }), 612000 * 1024, 'the largest of the keepers asked about');
  eq(seen.cmd, 'tasklist', 'read with tasklist');
  eq(seen.opts.windowsHide, true, 'hidden: no console window on the operator desktop');
  eq(measureKeeperRssBytes([], { exec, platform: 'win32' }), null, 'no pids: no reading');
  eq(measureKeeperRssBytes([100], { exec: () => { throw Error('no tasklist'); }, platform: 'win32' }), null,
     'a failed reading is null, never zero');
}

// ---- the logoff fallback is addressed and says one line per keeper
{
  const posts = [], lines = [];
  const fetchImpl = async (url, init) => { posts.push({ url, init }); return { ok: !url.includes(':9502') }; };
  const r = await logoffKeepers([
    { agent: 't1', character: 'Kermit', pid: 11, port: 9501 },
    { agent: 't2', character: 'Gonzo', pid: 22, port: 9502 },
  ], { fetchImpl, log: l => lines.push(l) });
  eq(posts.map(p => p.url), ['http://127.0.0.1:9501/stop', 'http://127.0.0.1:9502/stop'], 'POST /stop per keeper');
  eq(posts[0].init.headers['x-m59-keeper-pid'], '11', 'addressed by exact pid');
  eq(JSON.parse(posts[0].init.body), { agent: 't1', character: 'Kermit', keeper_pid: 11 }, 'and by agent and character');
  eq(r.map(x => x.ok), [true, false], 'a refused stop is reported, not assumed');
  eq(lines.length, 2, 'one line per keeper');
}

// ---- only a broker that lacks the tool may fall through to the logoff
ok(brokerLacksHandoff(Error('unknown tool "war_restart"')), 'the broker\'s own unknown-tool error');
ok(!brokerLacksHandoff(Error('war_restart: fleet_state x is not this broker\'s roster (y)')),
   'a WRONG BROKER is a failure, never a reason to log the fleet off');
ok(!brokerLacksHandoff(Error('fetch failed')), 'an unreachable broker is a failure too');

// ---- the callers that used to log off go through the helper
{
  const fr = src('m59-friendly-reboot.mjs');
  ok(/restartKeepers\(/.test(fr), 'friendly-reboot restarts through restartKeepers');
  ok(!/fetch\(`http:\/\/127\.0\.0\.1:\$\{k\.port\}\/stop`/.test(fr), 'and no longer posts /stop itself');
  ok(/decideRestartMode\(/.test(src('m59-node-keeper-build.mjs')), 'node-keeper-build decides handoff vs logoff');
  ok(/'restart-keepers'/.test(src('m59-service.mjs')), 'm59-service has restart-keepers');
  ok(/KEEPERS/.test(src('m59-update.mjs')) && /restartKeepers/.test(src('m59-update.mjs')), 'm59-update --keepers hands off');
  ok(/restart-keepers/.test(src('m59-deploy.mjs')), 'a deploy tells you to hand keepers off');
  const wr = src('m59-war-restart.mjs');
  ok(/defaultHandoffConcurrency\(h\)/.test(wr), 'the CLI concurrency default comes from what the broker advertises');
  ok(!/concurrency:\s*Number\(opt\('concurrency'\) \?\? 1\)/.test(wr), 'not a constant');
}

console.log(`m59-keeper-restart-test: ${n} assertions passed`);
