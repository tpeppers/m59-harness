import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stateFileFor, lockFileFor } from '../m59-fleetpath.mjs';
import { configuredPartyPlan } from './party-roster.mjs';
import { createRuntimeProfile } from './runtime-profile.mjs';

const FLEET_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// This is explicit operator intent, carried in the part of a roster record that survives
// existing broker rewrites. It is not proof that another roster does not alias the account.
export const LAB_ROSTER_MARKER_FIELD = 'credentials.lab_runtime';

export const LAB_RUNNER_HELP = `Usage:
  node tools/m59-lab-runner.mjs --fleet NAME --check
  node tools/m59-lab-runner.mjs --fleet NAME --run [options]

Options:
  --agents a,b          run only named roster slots
  --shards N            isolate actors across N lab processes (default 1, max 32)
  --control-port PORT   loopback inspection/shutdown API
  --startup-concurrency N  simultaneous logins per shard/process (default 2)
  --time-scale N        client scheduling remains 1; accelerated server clocks run alongside
  --help                show this text
`;

function take(argv, index, flag) {
  const value = argv[index + 1];
  if (value == null || String(value).startsWith('--')) throw new Error(`${flag} needs a value`);
  return String(value);
}

function integer(value, flag, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new Error(`${flag} must be an integer from ${min} to ${max}`);
  return number;
}

function ambientStateFile(env) {
  const value = env?.M59_STATE_FILE;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function ambientAccountLeaseDir(env) {
  const value = env?.M59_ACCOUNT_LEASE_DIR;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function checkedFleetName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!FLEET_NAME.test(name))
    throw new Error('--fleet must use only letters, digits, dash, and underscore');
  return name;
}

function normalizedAccount(value, id) {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`roster entry ${id} has no account credentials`);
  const account = value.trim();
  return { account, identity: account.normalize('NFKC').toLowerCase() };
}

export function parseLabArgs(argv = process.argv.slice(2), env = process.env) {
  const out = {
    action: null, fleet: null, agents: null, controlPort: null,
    startupConcurrency: 2, shards: 1,
    timeScale: env.M59_TIME_SCALE ?? 1, help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') { out.help = true; continue; }
    if (flag === '--check' || flag === '--run') {
      const action = flag.slice(2);
      if (out.action && out.action !== action) throw new Error('--check and --run are mutually exclusive');
      out.action = action;
      continue;
    }
    if (flag === '--fleet') { out.fleet = checkedFleetName(take(argv, index++, flag)); continue; }
    if (flag === '--agents') {
      const raw = take(argv, index++, flag);
      const ids = raw.split(',').map(value => value.trim()).filter(Boolean);
      if (!ids.length || new Set(ids).size !== ids.length)
        throw new Error('--agents needs a comma-separated list without duplicates');
      out.agents = ids;
      continue;
    }
    if (flag === '--control-port') {
      out.controlPort = integer(take(argv, index++, flag), flag, { max: 65535 });
      continue;
    }
    if (flag === '--shards') {
      out.shards = integer(take(argv, index++, flag), flag, { max: 32 });
      continue;
    }
    if (flag === '--startup-concurrency') {
      out.startupConcurrency = integer(take(argv, index++, flag), flag, { max: 64 });
      continue;
    }
    if (flag === '--time-scale') {
      out.timeScale = Number(take(argv, index++, flag));
      continue;
    }
    throw new Error(`unknown option ${flag}`);
  }
  if (out.help) return Object.freeze(out);
  if (!out.fleet) throw new Error('--fleet is required; the lab runner never uses a default fleet');
  if (/prod|production|live/i.test(out.fleet))
    throw new Error(`fleet ${JSON.stringify(out.fleet)} is production-like and is refused by the lab runner`);
  out.action ??= 'check';
  if (out.action === 'run' && ambientStateFile(env))
    throw new Error('--run refuses ambient M59_STATE_FILE; the named --fleet roster path is mandatory');
  if (out.action === 'run' && ambientAccountLeaseDir(env))
    throw new Error('--run refuses ambient M59_ACCOUNT_LEASE_DIR because ownership has one canonical namespace');
  const profile = createRuntimeProfile({ name: 'lab', timeScale: out.timeScale });
  if (profile.timeScale !== 1)
    throw new Error('lab-runtime v1 requires --time-scale 1; server simulation time is not ' +
      'accelerated by this client flag. Use m59-sim-server.mjs for the isolated accelerated ' +
      'Blakod timer/world-hour clock');
  out.profile = profile;
  return Object.freeze(out);
}

export function resolveLabRosterPaths(config, env = process.env) {
  const fleet = checkedFleetName(config?.fleet);
  const action = config?.action ?? 'check';
  const injected = ambientStateFile(env);
  if (action === 'run' && injected)
    throw new Error('--run refuses ambient M59_STATE_FILE; the named --fleet roster path is mandatory');
  // A read-only check may inject a fixture. A run always resolves the repository's exact
  // substrate/fleets/<name>.json identity with an override-free environment.
  const pathEnv = action === 'check' && injected ? { M59_STATE_FILE: injected } : {};
  return Object.freeze({
    stateFile: resolve(stateFileFor(fleet, pathEnv)),
    lockFile: resolve(lockFileFor(fleet, pathEnv)),
  });
}

export function loadLabSelection(config, env = process.env) {
  const { stateFile, lockFile } = resolveLabRosterPaths(config, env);
  if (!existsSync(stateFile)) throw new Error(`fleet roster does not exist: ${stateFile}`);
  let source;
  try { source = readFileSync(stateFile, 'utf8'); }
  catch (error) {
    // Filesystem diagnostics do not need roster contents. Keep the V8 message out of this
    // boundary anyway so a platform-specific error cannot echo credential-bearing input.
    throw new Error(`fleet roster cannot be read (${error?.code ?? 'read failed'})`);
  }
  let roster;
  try { roster = JSON.parse(source); }
  catch {
    // Modern JSON.parse errors may quote source context. A malformed credentials object can
    // therefore put its password into stderr unless the parser detail is discarded here.
    throw new Error('fleet roster is not valid JSON');
  }
  if (!roster || typeof roster !== 'object' || Array.isArray(roster))
    throw new Error('fleet roster must be an object keyed by agent id');
  const invalidIds = Object.keys(roster).filter(id => !AGENT_NAME.test(id));
  if (invalidIds.length)
    throw new Error(`fleet roster has invalid actor ids: ${invalidIds.join(', ')}`);

  const requested = config.agents ?? Object.keys(roster);
  const unknown = requested.filter(id => !Object.hasOwn(roster, id));
  if (unknown.length) throw new Error(`unknown --agents: ${unknown.join(', ')}`);
  if (!requested.length) throw new Error('fleet roster has no actors');
  if (config.shards > requested.length)
    throw new Error(`--shards cannot exceed the ${requested.length} selected actor(s)`);

  const identities = new Map();
  const entries = requested.map(id => {
    const value = roster[id];
    const credentials = value?.credentials;
    if (credentials?.lab_runtime !== true)
      throw new Error(
        `roster entry ${id} is not explicitly marked ${LAB_ROSTER_MARKER_FIELD} === true`);
    const { account, identity: normalized } = normalizedAccount(credentials?.account, id);
    if (typeof credentials?.password !== 'string' || !credentials.password)
      throw new Error(`roster entry ${id} has no password credentials`);
    const host = typeof credentials.host === 'string' ? credentials.host.trim() : '';
    const port = Number(credentials.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`roster entry ${id} must name an explicit credentials.host and credentials.port`);
    if (value?.autopilot?.mode === 'tick')
      throw new Error(`roster entry ${id} uses tick mode, which lab-runtime v1 does not manage`);
    const endpoint = `${host.toLowerCase()}:${port}`;
    const identity = `${normalized}\0${endpoint}`;
    const prior = identities.get(identity);
    if (prior)
      throw new Error(
        `roster entries ${prior} and ${id} duplicate one normalized account+endpoint identity`);
    identities.set(identity, id);
    return { ...value, id, credentials: { ...credentials, account, host, port } };
  });
  const endpoints = new Set(entries.map(entry =>
    `${entry.credentials.host.toLowerCase()}:${entry.credentials.port}`));
  if (endpoints.size !== 1) throw new Error('selected actors do not name one common game endpoint');
  // Validate configuration while --check is still on its cheap, pre-atlas path. The
  // runtime installer calls this same pure planner again immediately before mutating the
  // process-wide party register, so check and run cannot acquire different rules.
  const parties = configuredPartyPlan(entries);

  return Object.freeze({
    fleet: config.fleet,
    stateFile,
    lockFile,
    roster,
    entries: Object.freeze(entries),
    endpoint: [...endpoints][0],
    parties,
  });
}

export function publicSelection(selection) {
  return Object.freeze({
    fleet: selection.fleet,
    state_file: selection.stateFile,
    endpoint: selection.endpoint,
    actors: Object.freeze(selection.entries.map(entry => entry.id)),
    count: selection.entries.length,
  });
}
