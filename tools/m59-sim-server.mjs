#!/usr/bin/env node
// Lifecycle controller for one source-attested, loopback-only simulation server.
// This never discovers or operates on the ordinary `m59` container.

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dm } from './m59-dm.mjs';
import {
  REPOSITORY_ROOT,
  SERVER_CLOCK_SCHEMA,
  SERVER_STATE_SCHEMA,
  SIMULATION_GUARD_TEXT,
  loadPatchArtifacts,
  parseSimulationClock,
  sha256File,
  validateImageLabels,
  validateLabId,
  validateScale,
  validateServerState,
} from './runtime/server-clock-contract.mjs';

const INSTANCE_LABEL = 'org.openai.m59.sim-clock.instance';
const STATE_LABEL = 'org.openai.m59.sim-clock.state-schema';
const RUNTIME_BASE = resolve(REPOSITORY_ROOT, 'substrate', '.sim-servers');
const ACTIONS = new Set(['start', 'status', 'attest', 'stop']);
const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?$/;
const MEMORY_LIMIT = /^[1-9][0-9]*(?:[kmgt])?$/i;

export const HELP = `Usage:
  node tools/m59-sim-server.mjs start  --id NAME --image IMAGE --scale N \\
      --game-port PORT --admin-port PORT [--memory 2g] [--cpus 2]
  node tools/m59-sim-server.mjs status --id NAME
  node tools/m59-sim-server.mjs attest --id NAME
  node tools/m59-sim-server.mjs stop   --id NAME

Safety boundaries:
  * NAME must be explicitly lab-like; prod/live names are refused.
  * both published ports are bound to 127.0.0.1 and production ports are refused.
  * the image labels and live "show simclock" line must match before success or stop.
  * stop uses the server's "terminate save"; it never uses docker stop/kill/rm.
`;

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (value == null || String(value).startsWith('--')) throw new Error(`${flag} needs a value`);
  return String(value);
}

function port(value, flag) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1024 || number > 65535)
    throw new Error(`${flag} must be an integer from 1024 through 65535`);
  if (number === 5959 || number === 9998)
    throw new Error(`${flag} refuses the ordinary server port ${number}; choose a lab-specific port`);
  return number;
}

export function parseServerArgs(argv = process.argv.slice(2)) {
  const out = {
    action: null, id: null, image: null, scale: null,
    gamePort: null, adminPort: null, memory: '2g', cpus: 2, help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--help' || token === '-h') { out.help = true; continue; }
    if (!token.startsWith('--') && ACTIONS.has(token) && out.action == null) {
      out.action = token;
      continue;
    }
    if (token === '--id') { out.id = valueAfter(argv, index++, token); continue; }
    if (token === '--image') { out.image = valueAfter(argv, index++, token); continue; }
    if (token === '--scale') { out.scale = valueAfter(argv, index++, token); continue; }
    if (token === '--game-port') { out.gamePort = valueAfter(argv, index++, token); continue; }
    if (token === '--admin-port') { out.adminPort = valueAfter(argv, index++, token); continue; }
    if (token === '--memory') { out.memory = valueAfter(argv, index++, token); continue; }
    if (token === '--cpus') { out.cpus = valueAfter(argv, index++, token); continue; }
    throw new Error(`unknown action or option ${token}`);
  }
  if (out.help) return Object.freeze(out);
  if (!out.action) throw new Error(`one action is required: ${[...ACTIONS].join(', ')}`);
  out.id = validateLabId(out.id);
  if (out.action === 'start') {
    if (!IMAGE_REFERENCE.test(String(out.image ?? '')))
      throw new Error('--image is required and must be a local Docker image reference');
    if (out.scale == null) throw new Error('--scale is required for start');
    if (out.gamePort == null || out.adminPort == null)
      throw new Error('--game-port and --admin-port are both required for start');
    out.scale = validateScale(out.scale, '--scale');
    out.gamePort = port(out.gamePort, '--game-port');
    out.adminPort = port(out.adminPort, '--admin-port');
    if (out.gamePort === out.adminPort) throw new Error('game and admin ports must differ');
    if (!MEMORY_LIMIT.test(out.memory)) throw new Error('--memory must be a Docker size such as 768m or 2g');
    out.cpus = Number(out.cpus);
    if (!Number.isFinite(out.cpus) || out.cpus < 0.1 || out.cpus > 64)
      throw new Error('--cpus must be from 0.1 through 64');
  } else if (out.image != null || out.scale != null || out.gamePort != null || out.adminPort != null ||
             out.memory !== '2g' || Number(out.cpus) !== 2) {
    throw new Error(`${out.action} reads its image, scale, ports, and limits from the attested state file`);
  }
  return Object.freeze(out);
}

function pathsFor(id) {
  const runtime = resolve(RUNTIME_BASE, id);
  if (!runtime.startsWith(RUNTIME_BASE + '\\') && !runtime.startsWith(RUNTIME_BASE + '/'))
    throw new Error('lab runtime path escaped its private base');
  return Object.freeze({
    runtime,
    state: join(runtime, 'server-state.json'),
    savegame: join(runtime, 'savegame'),
    channel: join(runtime, 'channel'),
    guard: join(runtime, 'savegame', '.m59-simulation-clock.guard'),
  });
}

function docker(args, { timeout = 30000, allowMissing = false } = {}) {
  const result = spawnSync('docker', args, { cwd: REPOSITORY_ROOT, encoding: 'utf8', timeout });
  if (result.error) throw new Error(`docker could not run: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    if (allowMissing && /No such (?:object|container|image)/i.test(detail)) return null;
    throw new Error(`docker ${args[0]} failed with exit ${result.status}${detail ? `: ${detail.slice(-800)}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function assertDockerReady() {
  docker(['info', '--format', '{{json .ServerVersion}}'], { timeout: 30000 });
}

function inspectImageLabels(image) {
  const raw = docker(['image', 'inspect', '--format', '{{json .Config.Labels}}', image]);
  try { return JSON.parse(raw); }
  catch { throw new Error('docker returned malformed image label JSON'); }
}

function inspectContainer(name) {
  const raw = docker(['container', 'inspect', name], { allowMissing: true });
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('shape');
    return parsed[0];
  } catch { throw new Error('docker returned malformed container inspection JSON'); }
}

function readState(id, { required = true } = {}) {
  const paths = pathsFor(id);
  if (!existsSync(paths.state)) {
    if (!required) return null;
    throw new Error(`no state for lab instance ${id}; expected ${paths.state}`);
  }
  let value;
  try { value = JSON.parse(readFileSync(paths.state, 'utf8')); }
  catch { throw new Error(`lab instance ${id} has an unreadable or malformed state file`); }
  return validateServerState(value, { expectedId: id });
}

function writeState(paths, state) {
  validateServerState(state, { expectedId: state.id });
  const temp = join(paths.runtime, `.server-state-${process.pid}.tmp`);
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  renameSync(temp, paths.state);
}

function manifestForState(manifest, state) {
  return {
    ...manifest,
    source: { ...manifest.source, commit: state.source_commit },
  };
}

function validateContainer(container, state, manifest) {
  if (!container) throw new Error(`container ${state.container} does not exist`);
  if (container.Name !== `/${state.container}`) throw new Error('container name does not match state identity');
  if (container.Config?.Image !== state.image) throw new Error('container image does not match state identity');
  if (container.Config?.Labels?.[INSTANCE_LABEL] !== state.id)
    throw new Error('container lab instance label does not match state identity');
  if (container.Config?.Labels?.[STATE_LABEL] !== SERVER_STATE_SCHEMA)
    throw new Error('container state schema label does not match this controller');
  validateImageLabels(container.Config?.Labels, {
    manifest: manifestForState(manifest, state),
    patchSha256: state.patch_sha256,
    scale: state.scale,
  });

  const portChecks = [[state.game_port, '5959/tcp'], [state.admin_port, '9998/tcp']];
  for (const [expected, key] of portChecks) {
    const bindings = container.HostConfig?.PortBindings?.[key];
    if (!Array.isArray(bindings) || bindings.length !== 1 ||
        bindings[0]?.HostIp !== '127.0.0.1' || Number(bindings[0]?.HostPort) !== expected)
      throw new Error(`container ${key} is not bound only to expected loopback port ${expected}`);
  }
  return container;
}

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

async function clockAttestation(state, { retriesMs = 0 } = {}) {
  const deadline = Date.now() + retriesMs;
  let lastError;
  do {
    try {
      const output = await dm('show simclock', {
        timeoutMs: 5000,
        env: { M59_ADMIN_HOST: '127.0.0.1', M59_ADMIN_PORT: String(state.admin_port) },
      });
      return parseSimulationClock(output, { expectedScale: state.scale });
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await delay(300);
    }
  } while (true);
  throw new Error(`server did not provide a valid simulation-clock attestation: ${lastError?.message ?? 'no reply'}`);
}

function publicStatus(state, container, clock = null) {
  return {
    id: state.id,
    container: state.container,
    image: state.image,
    running: container?.State?.Running === true,
    status: container?.State?.Status ?? 'missing',
    game: `127.0.0.1:${state.game_port}`,
    admin: `127.0.0.1:${state.admin_port}`,
    scale: state.scale,
    clock,
  };
}

async function start(config) {
  assertDockerReady();
  const artifacts = loadPatchArtifacts();
  const patchSha256 = sha256File(artifacts.patchPath);
  const labels = inspectImageLabels(config.image);
  validateImageLabels(labels, { manifest: artifacts.manifest, patchSha256, scale: config.scale });

  const name = `m59-sim-${config.id}`;
  if (inspectContainer(name)) throw new Error(`container ${name} already exists; inspect it with status`);
  // A stale, valid state file is allowed after an unexpected --rm container exit;
  // its private save directory is the persistence boundary for the next start.
  readState(config.id, { required: false });

  const paths = pathsFor(config.id);
  mkdirSync(paths.savegame, { recursive: true });
  mkdirSync(paths.channel, { recursive: true });
  writeFileSync(paths.guard, SIMULATION_GUARD_TEXT, { encoding: 'utf8' });

  const id = docker([
    'run', '--detach', '--rm', '--init',
    '--name', name,
    '--label', `${INSTANCE_LABEL}=${config.id}`,
    '--label', `${STATE_LABEL}=${SERVER_STATE_SCHEMA}`,
    '--publish', `127.0.0.1:${config.gamePort}:5959/tcp`,
    '--publish', `127.0.0.1:${config.adminPort}:9998/tcp`,
    '--mount', `type=bind,source=${paths.savegame},target=/m59/savegame`,
    '--mount', `type=bind,source=${paths.channel},target=/m59/channel`,
    '--memory', config.memory,
    '--cpus', String(config.cpus),
    '--pids-limit', '256',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    config.image,
  ], { timeout: 60000 });
  if (!/^[0-9a-f]{12,64}$/i.test(id)) throw new Error('docker run did not return one container id');

  const state = {
    schema: SERVER_STATE_SCHEMA,
    id: config.id,
    container: name,
    image: config.image,
    scale: config.scale,
    game_port: config.gamePort,
    admin_port: config.adminPort,
    source_commit: artifacts.manifest.source.commit,
    patch_sha256: patchSha256,
    clock_schema: SERVER_CLOCK_SCHEMA,
    created_at: new Date().toISOString(),
  };
  writeState(paths, state);

  const container = validateContainer(inspectContainer(name), state, artifacts.manifest);
  if (!container.State?.Running) throw new Error(`container ${name} exited before attestation`);
  const clock = await clockAttestation(state, { retriesMs: 30000 });
  console.log(JSON.stringify(publicStatus(state, container, clock), null, 2));
}

async function status(config, { requireClock = false } = {}) {
  assertDockerReady();
  const artifacts = loadPatchArtifacts();
  const state = readState(config.id);
  const found = inspectContainer(state.container);
  if (!found) {
    console.log(JSON.stringify(publicStatus(state, null), null, 2));
    if (requireClock) throw new Error(`container ${state.container} does not exist`);
    return;
  }
  const container = validateContainer(found, state, artifacts.manifest);
  let clock = null;
  if (container.State?.Running) clock = await clockAttestation(state);
  else if (requireClock) throw new Error(`container ${state.container} is not running`);
  console.log(JSON.stringify(publicStatus(state, container, clock), null, 2));
}

async function stop(config) {
  assertDockerReady();
  const artifacts = loadPatchArtifacts();
  const state = readState(config.id);
  const container = validateContainer(inspectContainer(state.container), state, artifacts.manifest);
  if (!container.State?.Running) throw new Error(`container ${state.container} is not running`);
  await clockAttestation(state);

  const output = await dm('terminate save', {
    timeoutMs: 180000,
    env: { M59_ADMIN_HOST: '127.0.0.1', M59_ADMIN_PORT: String(state.admin_port) },
  });
  if (!/Terminating server|Garbage collecting and saving game/i.test(output))
    throw new Error('server did not acknowledge terminate save; state and container were left intact');

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const current = inspectContainer(state.container);
    if (!current || current.State?.Running !== true) {
      if (existsSync(pathsFor(config.id).state)) unlinkSync(pathsFor(config.id).state);
      console.log(`stopped ${state.container} through terminate save; lab savegame was preserved`);
      return;
    }
    await delay(500);
  }
  throw new Error(`server acknowledged terminate save but ${state.container} is still running; no kill was attempted`);
}

export async function main(argv = process.argv.slice(2)) {
  const config = parseServerArgs(argv);
  if (config.help) { process.stdout.write(HELP); return 0; }
  if (config.action === 'start') await start(config);
  else if (config.action === 'status') await status(config);
  else if (config.action === 'attest') await status(config, { requireClock: true });
  else if (config.action === 'stop') await stop(config);
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`m59-sim-server: ${error.message}`);
    process.exitCode = 1;
  });
}
