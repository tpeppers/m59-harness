#!/usr/bin/env node

// Static integration contract for a script that intentionally cannot be imported without
// starting a broker. Behavioural state-machine coverage lives beside KeeperLiveness; this
// pins the expensive/no-expensive seams in the two process entry points.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const broker = readFileSync(fileURLToPath(new URL('./m59-broker.mjs', import.meta.url)), 'utf8');
const keeper = readFileSync(fileURLToPath(new URL('./m59-keeper-process.mjs', import.meta.url)), 'utf8');
const service = readFileSync(fileURLToPath(new URL('./m59-service.mjs', import.meta.url)), 'utf8');

const between = (source, from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `could not isolate ${from}`);
  return source.slice(start, end);
};

const liveEndpoint = between(keeper,
  "if (req.method === 'GET' && path === '/live')",
  "if (req.method === 'GET' && path === '/health')");
assert.doesNotMatch(liveEndpoint, /stateSnapshot\s*\(/,
  '/live must never build the enriched state projection');
assert.doesNotMatch(liveEndpoint, /\bstate\s*\(/,
  '/live must remain a direct process/session projection');
for (const field of ['agent', 'character', 'pid', 'in_game', 'connected', 'connection_revision'])
  assert.match(liveEndpoint, new RegExp(`\\b${field}\\b`), `/live must publish ${field}`);

const proxy = between(broker, 'class KeeperProxy {', '// Agent index for port allocation');
assert.doesNotMatch(proxy, /_startPoller|setInterval\s*\(/,
  'KeeperProxy must own no recurring rich-state poller');
assert.match(proxy, /async refreshLiveness/);
assert.match(proxy, /async ensureSnapshot/);
assert.match(proxy, /dispose\(\)/);
assert.match(proxy, /while \(this\._stateInFlight\)/,
  'strong readers waiting behind a weak projection must recheck and join one fresh build');
assert.match(proxy, /s\.as_of_ms[\s\S]{0,500}_stateMaxReportedAge/,
  'a keeper response may not renew the broker cache past its published age bound');

const callBoundary = between(broker, 'async function callTool(', '// ---------------------------------------------------------------- MCP');
assert.match(callBoundary, /targeted\.ensureSnapshot\(\)/,
  'agent-scoped tools must materialize state at the request boundary');
const fleetTool = between(broker, "name: 'fleet'", "name: 'pilot'");
assert.match(fleetTool, /ensureSnapshot\(\{ force: a\.refresh === true \}\)/,
  'fleet reads must materialize bounded snapshots on demand');
const rerollTool = between(broker, "name: 'reroll'", "name: 'loot_run'");
assert.match(rerollTool, /if \(made\.created\)[\s\S]{0,300}rememberJoin\(a\.agent, s\.credentials\)[\s\S]{0,150}listen\(a\.agent, s\)/,
  'a successful credentials-first creation must become a durable, listened-to roster session');

assert.match(broker, /setTimeout\(runKeeperLivenessSweep/,
  'the fleet uses one recursive liveness deadline');
assert.doesNotMatch(broker, /setInterval\(poll, this\._stateTtl\)/,
  'the removed two-second per-keeper poller must stay removed');
assert.match(broker, /proof\.unavailable && proof\.processAlive === true/,
  'HTTP silence with a live PID must skip reconciliation');
assert.match(broker, /if \(s instanceof KeeperProxy\) s\.dispose\(\)/,
  'deliberate leave must dispose its proxy');
assert.equal((broker.match(/reconcileFleet\s*\(/g) ?? []).length, 2,
  'all scheduled/manual reconciliation must join the one runReconcile in-flight gate');
assert.match(broker, /'x-m59-keeper-pid': String\(identity\.pid\)/,
  'every keeper write carries the attested process id');
assert.match(broker,
  /return Object\.freeze\(\{ port, identity: Object\.freeze\(expected\), record: rec \}\)/,
  'the exact attested identity and process allocation are carried atomically to the write');
assert.match(keeper, /requestIdentity[\s\S]*x-m59-keeper-pid/,
  'the receiving keeper validates the process id on every write');
assert.match(broker, /await targeted\.ensureSnapshot\(\);/,
  'state-consuming tool calls fail rather than silently using an arbitrarily stale snapshot');
assert.match(broker, /SNAPSHOT_OPTIONAL_TOOLS[\s\S]*'wait_for_event'/,
  'event waits must not materialize rich world state');
assert.match(broker, /allocateKeeperBand\(FLEET\)/,
  'keeper bands are assigned through the cross-process atomic registry');
assert.match(broker, /port <= portBand\.end/,
  'keeper allocation must stop at the assigned 100-port band edge');
assert.match(broker, /refusing to borrow another fleet's range/,
  'an exhausted 100-actor band fails closed instead of spilling into its neighbour');
const resumeRoster = between(broker, 'const work = [];', '// IN-PROCESS SESSIONS STAY SERIAL');
assert.ok(
  resumeRoster.indexOf('agentIndices.set(agent, index)') <
    resumeRoster.indexOf('if (held.has(agent)) continue'),
  'locally-held roster entries must retain a stable keeper slot for later reconciliation',
);

const childStart = between(broker, 'async function spawnKeeperInner(', 'async function killAllKeepers(');
assert.match(childStart, /closeSync\(logFd\)/,
  'the broker must close its copy of every keeper log descriptor after spawn');
assert.match(childStart, /child\.once\('error'/,
  'spawn errors must be observed instead of crashing the broker');
assert.match(childStart, /const readinessDeadline = began \+ 30_000/,
  'keeper readiness uses an absolute deadline rather than N serial request timeouts');
assert.match(childStart, /recordedKeeperAlive\(previous\)[\s\S]{0,1000}refusing an overlapping spawn/,
  'a tracked live child must block replacement until it is ready or exits');
assert.match(childStart, /did not stop[\s\S]{0,250}guarded record is retained|guarded record is retained[\s\S]{0,250}did not stop/,
  'a failed child that cannot be stopped remains tracked as an overlap barrier');
const spawnGate = between(broker, 'function spawnKeeper(agent, index, credentials)',
  'function keeperCharacterIdentity(');
assert.match(spawnGate, /const existing = keeperSpawning\.get\(agent\);[\s\S]*if \(existing\) return existing/,
  'resume and reconciliation share one per-agent spawn promise');
assert.match(spawnGate, /keeperSpawning\.get\(agent\) === task[\s\S]*keeperSpawning\.delete\(agent\)/,
  'only the promise that owns a spawn slot may clear it');

const stopLifecycle = between(broker, 'async function stopRecordedKeeper(', '// PUSH AN ORDER TO THE PROCESS');
assert.match(stopLifecycle, /record\.child\.kill\('SIGTERM'\)/,
  'owned children are terminated through their exact ChildProcess handle');
assert.doesNotMatch(stopLifecycle, /process\.kill\(record\.pid|process\.kill\(pid/,
  'keeper stop/leave must never signal a reusable numeric PID');
assert.doesNotMatch(stopLifecycle, /keeperProcesses\.clear\(\)/,
  'shutdown cannot discard records before exact child death is proved');
const shutdown = between(broker, 'async function beginBrokerShutdown(', 'function acquireBrokerOwnership(');
assert.match(shutdown, /brokerStopping = true[\s\S]*await killAllKeepers[\s\S]*releaseBrokerOwnership/,
  'the synchronous shutdown gate and bounded child stop precede ownership release');
assert.match(shutdown, /stopped\.ok && keeperSpawning\.size === 0 && reconcileSettled/,
  'ownership is retained unless child, spawn, and reconcile lanes are all settled');
const ownershipHandlers = between(broker, 'function installBrokerOwnershipHandlers(',
  'async function beginBrokerShutdown(');
assert.doesNotMatch(ownershipHandlers, /process\.on\('exit'[\s\S]*releaseBrokerOwnership/,
  'the synchronous exit fallback must retain claims for any unobservable in-flight child');
const brokerControl = between(broker, 'function handleControl(action, res)', 'function serveDashboard(');
assert.match(brokerControl, /action === 'quiesce'[\s\S]{0,400}beginBrokerShutdown\('service stop'\)/,
  'the verified loopback service path must enter the broker orderly shutdown gate');
const serviceStop = between(service, 'async function cmdStop(', 'async function cmdStatus(');
assert.match(serviceStop, /control\/quiesce[\s\S]*graceful\?\.ok[\s\S]*killPid\(found\.pid\)/,
  'service stop must attempt orderly broker quiescence before its explicit forced fallback');
assert.ok(serviceStop.indexOf('control/quiesce') < serviceStop.indexOf('uptime.markStopped();'),
  'the service must not erase crash evidence during the graceful shutdown window');

console.log('broker demand state: PASS');
