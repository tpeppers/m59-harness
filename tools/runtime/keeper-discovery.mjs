// Safe loopback discovery for per-character keeper processes.
//
// A fleet owns one complete 100-port band. Discovery first asks every candidate
// port for the cheap `/live` identity tuple, then asks `/state` only for agents the
// caller explicitly expects. A process that changes between those two reads is
// discarded by the agent/character/PID comparison.

import { KEEPER_BAND_WIDTH, lookupKeeperBand } from './keeper-bands.mjs';
import { normalizeKeeperCharacter, validateKeeperSample } from './keeper-liveness.mjs';

export { KEEPER_BAND_WIDTH };

const MAX_PORT = 65535;

function completeBand(base, source = 'keeper port base') {
  const numeric = Number(base);
  if (!Number.isSafeInteger(numeric) || numeric < 1 ||
      numeric + KEEPER_BAND_WIDTH - 1 > MAX_PORT) {
    throw new RangeError(
      `${source} must begin a complete ${KEEPER_BAND_WIDTH}-port range within 1-${MAX_PORT}`,
    );
  }
  return Object.freeze({
    base: numeric,
    end: numeric + KEEPER_BAND_WIDTH - 1,
    width: KEEPER_BAND_WIDTH,
  });
}

export function validateKeeperBand(value, source = 'keeper band') {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${source} must be an object`);
  const result = completeBand(value.base, `${source} base`);
  if (Number(value.width) !== KEEPER_BAND_WIDTH || Number(value.end) !== result.end)
    throw new RangeError(`${source} must describe exactly ports ${result.base}-${result.end}`);
  return result;
}

/** Resolve a fleet's band without allocating one or guessing another fleet's range. */
export function resolveKeeperBand(fleet, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('options must be an object');
  if (Object.hasOwn(options, 'override') && options.override !== undefined)
    return completeBand(options.override, options.overrideName ?? 'M59_KEEPER_PORT_BASE');

  const lookupOptions = Object.hasOwn(options, 'registryPath')
    ? { registryPath: options.registryPath }
    : {};
  const found = lookupKeeperBand(fleet ?? null, lookupOptions);
  if (!found) {
    if (options.missing === 'null') return null;
    const name = fleet == null || fleet === '' ? '<unnamed>' : String(fleet);
    throw new Error(
      `fleet ${JSON.stringify(name)} has no keeper port band; ` +
      'start its broker once or set M59_KEEPER_PORT_BASE explicitly',
    );
  }
  return validateKeeperBand(found, `keeper band for ${fleet || '<unnamed>'}`);
}

export function keeperBandPorts(value) {
  const band = validateKeeperBand(value);
  return Array.from({ length: band.width }, (_, offset) => band.base + offset);
}

function positivePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > MAX_PORT)
    throw new RangeError('keeper port must be an integer within 1-65535');
  return port;
}

function expectedSet(values) {
  if (values == null) throw new TypeError('expectedAgents is required');
  const result = new Set();
  for (const value of values) {
    const agent = String(value ?? '');
    if (!agent) throw new TypeError('expected agent names must be non-empty');
    result.add(agent);
  }
  return result;
}

function identityMatches(sample, identity) {
  return String(sample?.agent ?? '') === identity.agent &&
    normalizeKeeperCharacter(sample?.character) ===
      normalizeKeeperCharacter(identity.character) &&
    Number(sample?.pid) === identity.pid;
}

async function jsonGet(url, { timeoutMs, fetchImpl }) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    try { await response.body?.cancel(); } catch {}
    return { ok: false, status: response.status, value: null };
  }
  const value = await response.json();
  return {
    ok: true,
    status: response.status,
    value: value && typeof value === 'object' && !Array.isArray(value) ? value : null,
  };
}

/** Probe one port using only the cheap `/live` endpoint. */
export async function probeKeeperLive(port, {
  expectedAgents,
  timeoutMs = 1500,
  fetchImpl = globalThis.fetch,
} = {}) {
  const numericPort = positivePort(port);
  const expected = expectedAgents instanceof Set ? expectedAgents : expectedSet(expectedAgents);
  try {
    let read = await jsonGet(`http://127.0.0.1:${numericPort}/live`, {
      timeoutMs,
      fetchImpl,
    });
    let source = 'live';
    // Rolling compatibility is deliberately narrow. Only a keeper that positively says
    // the endpoint does not exist earns one legacy `/health` identity read. Silence,
    // timeout, 500, and arbitrary protocol failures do not turn into expensive retries.
    if (!read.ok && (read.status === 404 || read.status === 405)) {
      read = await jsonGet(`http://127.0.0.1:${numericPort}/health`, {
        timeoutMs,
        fetchImpl,
      });
      source = 'health';
    }
    if (!read.ok) return null;
    const sample = read.value;
    const agent = String(sample?.agent ?? '');
    if (!expected.has(agent)) return null;
    const valid = validateKeeperSample(sample, { agent });
    if (!valid.ok || sample.in_game !== true || sample.connected === false ||
        sample.ok === false || !normalizeKeeperCharacter(sample.character)) return null;
    return Object.freeze({
      port: numericPort,
      agent,
      character: sample.character,
      pid: Number(sample.pid),
      source,
      live: Object.freeze({ ...sample }),
    });
  } catch {
    return null;
  }
}

/** Fetch rich state only after `/live` supplied an exact expected identity. */
export async function readVerifiedKeeperState(identity, {
  fresh = false,
  timeoutMs = 8000,
  maxStateAgeMs = 2500,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!identity || typeof identity !== 'object')
    throw new TypeError('keeper identity is required');
  const port = positivePort(identity.port);
  const pid = Number(identity.pid);
  const agent = String(identity.agent ?? '');
  const character = normalizeKeeperCharacter(identity.character);
  if (!agent || !character || !Number.isSafeInteger(pid) || pid <= 0)
    throw new TypeError('keeper identity must contain agent, character, positive PID, and port');
  if (!Number.isFinite(maxStateAgeMs) || maxStateAgeMs < 0)
    throw new RangeError('maxStateAgeMs must be a finite non-negative number');

  const query = new URLSearchParams({
    agent,
    character: String(identity.character),
    keeper_pid: String(pid),
  });
  if (fresh) query.set('fresh', '1');
  try {
    const read = await jsonGet(`http://127.0.0.1:${port}/state?${query}`, {
      timeoutMs,
      fetchImpl,
    });
    if (!read.ok) return null;
    const state = read.value;
    if (!identityMatches(state, { agent, character: identity.character, pid })) return null;
    const valid = validateKeeperSample(state, {
      agent,
      character: identity.character,
      pid,
    });
    if (!valid.ok || state.in_game !== true || state.connected === false || state.ok === false)
      return null;
    const age = state?.as_of_ms;
    if (!Number.isFinite(age) || age < 0 || age > maxStateAgeMs) return null;
    return state;
  } catch {
    return null;
  }
}

/**
 * Discover expected agents within a complete band (or a validated subset of its ports).
 * The returned maps contain no duplicate identity: two ports claiming one agent cause that
 * agent to be omitted, which is safer than selecting whichever concurrent request wins.
 */
export async function discoverKeeperStates({
  band,
  expectedAgents,
  ports = null,
  liveTimeoutMs = 1500,
  stateTimeoutMs = 8000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const checkedBand = validateKeeperBand(band);
  const expected = expectedSet(expectedAgents);
  const candidates = ports == null
    ? keeperBandPorts(checkedBand)
    : [...new Set([...ports].map(positivePort))];
  for (const port of candidates) {
    if (port < checkedBand.base || port > checkedBand.end)
      throw new RangeError(`keeper port ${port} is outside fleet band ${checkedBand.base}-${checkedBand.end}`);
  }
  if (!expected.size || !candidates.length)
    return { states: new Map(), identities: new Map(), duplicateAgents: new Set() };

  const probes = await Promise.all(candidates.map(port => probeKeeperLive(port, {
    expectedAgents: expected,
    timeoutMs: liveTimeoutMs,
    fetchImpl,
  })));
  const identities = new Map();
  const duplicateAgents = new Set();
  for (const identity of probes) {
    if (!identity) continue;
    if (identities.has(identity.agent)) {
      identities.delete(identity.agent);
      duplicateAgents.add(identity.agent);
    } else if (!duplicateAgents.has(identity.agent)) {
      identities.set(identity.agent, identity);
    }
  }

  const states = new Map();
  await Promise.all([...identities].map(async ([agent, identity]) => {
    const state = await readVerifiedKeeperState(identity, {
      timeoutMs: stateTimeoutMs,
      fetchImpl,
    });
    if (state) states.set(agent, { ...state, __port: identity.port, __identity: identity });
  }));
  return { states, identities, duplicateAgents };
}

export function keeperIdentityHeaders(identity) {
  if (!identity || !identity.agent || !identity.character ||
      !Number.isSafeInteger(Number(identity.pid)) || Number(identity.pid) <= 0)
    throw new TypeError('valid keeper identity is required');
  return {
    'x-m59-agent': String(identity.agent),
    'x-m59-character': String(identity.character),
    'x-m59-keeper-pid': String(identity.pid),
  };
}
