// Cross-roster account ownership.
//
// Fleet-state paths are not account identities: a named alias or copied roster gets a
// different fleet lock while still containing credentials for the same Meridian accounts.
// These leases are keyed by canonical game endpoint + normalized account id, so every
// runtime in this checkout meets at the same atomic file before any login is attempted.

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { domainToASCII, fileURLToPath } from 'node:url';

import {
  FLEET_LOCK_KIND,
  BROKER_FLEET_LOCK_KIND,
  addFleetLockGuard,
  claimFleetLock,
  finalizeFleetLockAdoption,
  inspectFleetLock,
  isProcessLive,
  verifyFleetLockGuard,
} from './fleet-lock.mjs';

export const DEFAULT_LEGACY_ROSTER_ROOT = fileURLToPath(
  new URL('../../substrate/', import.meta.url),
);
// Runtime ownership needs one namespace, not a configurable cache directory. Tests may
// inject `leaseDir` into AccountLeaseRegistry, but standard run modes always use this
// checkout's canonical directory and reject an ambient override before claiming anything.
export const DEFAULT_ACCOUNT_LEASE_DIR = fileURLToPath(
  new URL('../../substrate/runtime-account-leases/', import.meta.url),
);

export class AccountLeaseError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AccountLeaseError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function assertCanonicalAccountLeaseNamespace(env = process.env) {
  if (typeof env?.M59_ACCOUNT_LEASE_DIR === 'string' && env.M59_ACCOUNT_LEASE_DIR.trim())
    throw new AccountLeaseError(
      'LEASE_NAMESPACE_OVERRIDE',
      'M59_ACCOUNT_LEASE_DIR is refused in run mode because it would partition account ownership',
    );
  return DEFAULT_ACCOUNT_LEASE_DIR;
}

export function normalizeAccountId(value) {
  if (typeof value !== 'string') throw new AccountLeaseError('INVALID_ACCOUNT', 'account id must be a string');
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/.test(normalized))
    throw new AccountLeaseError('INVALID_ACCOUNT', 'account id is empty, too long, or contains control characters');
  return normalized;
}

function normalizedCharacter(value) {
  if (value == null) return null;
  if (typeof value !== 'string')
    throw new AccountLeaseError('INVALID_CHARACTER', 'character must be a string when supplied');
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/.test(normalized))
    throw new AccountLeaseError(
      'INVALID_CHARACTER', 'character is empty, too long, or contains control characters');
  return normalized;
}

function accountClaimSubject(agent, character) {
  // Opaque on disk: actor and character are useful authority inputs, not additional
  // plaintext identity fields to expose in a runtime directory or conflict report.
  return createHash('sha256')
    .update(JSON.stringify([agent, normalizedCharacter(character)]))
    .digest('hex');
}

function strictIpv4(value, original) {
  if (!/^[0-9]+(?:\.[0-9]+){3}$/.test(value)) return null;
  const parts = value.split('.');
  if (parts.some(part => (part.length > 1 && part.startsWith('0')) || Number(part) > 255))
    throw new AccountLeaseError('INVALID_ENDPOINT', `game endpoint host is ambiguous: ${original}`);
  return parts.map(Number);
}

export function normalizeGameEndpoint(hostValue, portValue) {
  if (typeof hostValue !== 'string')
    throw new AccountLeaseError('INVALID_ENDPOINT', 'game endpoint host must be a string');
  let host = hostValue.normalize('NFKC').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.+$/, '');
  if (!host) throw new AccountLeaseError('INVALID_ENDPOINT', 'game endpoint host is empty');
  if (host === 'localhost') {
    host = 'loopback';
  } else if (isIP(host) === 6) {
    // URL uses Node's standards-compliant IPv6 parser and emits one compressed lowercase
    // spelling. This collapses zero-padded/expanded aliases before hashing the lease key.
    const canonical = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
    const mappedFirstOctet = mapped ? (Number.parseInt(mapped[1], 16) >>> 8) : null;
    host = canonical === '::1' || mappedFirstOctet === 127 ? 'loopback' : canonical;
  } else {
    const ipv4 = strictIpv4(host, hostValue);
    if (ipv4) {
      const dotted = ipv4.join('.');
      host = ipv4[0] === 127 ? 'loopback' : dotted;
    } else if (/^[0-9.]+$/.test(host)) {
      // WHATWG/DNS parsers accept 127.1 and even one-integer IPv4 forms. Different textual
      // aliases reaching the same listener must not create different ownership files.
      throw new AccountLeaseError(
        'INVALID_ENDPOINT', `game endpoint host must use strict dotted-quad IPv4: ${hostValue}`);
    } else if (host.includes(':')) {
      throw new AccountLeaseError('INVALID_ENDPOINT', `game endpoint host is invalid: ${hostValue}`);
    } else {
      // DNS aliases are intentionally not resolved here: that would make lock identity
      // depend on mutable network state. Operators must use one canonical hostname.
      const ascii = domainToASCII(host);
      if (!ascii) throw new AccountLeaseError('INVALID_ENDPOINT', `game endpoint host is invalid: ${hostValue}`);
      host = ascii.toLowerCase();
    }
  }
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new AccountLeaseError('INVALID_ENDPOINT', 'game endpoint port must be an integer from 1 to 65535');
  return Object.freeze({ host, port, key: `${host}:${port}` });
}

function absoluteLeaseDir(value) {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value))
    throw new AccountLeaseError('INVALID_LEASE_DIR', 'account lease directory must be an absolute path');
  return resolve(value);
}

function entryRows(entries) {
  if (Array.isArray(entries)) return entries;
  if (entries && typeof entries === 'object')
    return Object.entries(entries).map(([agent, value]) => ({ agent, ...(value ?? {}) }));
  throw new AccountLeaseError('INVALID_ROSTER', 'account lease entries must be an array or roster object');
}

function identityFor(row, { defaultHost, defaultPort, leaseDir }) {
  if (!row || typeof row !== 'object' || Array.isArray(row))
    throw new AccountLeaseError('INVALID_ROSTER', 'account lease entry must be an object');
  const explicitAgent = typeof row.agent === 'string' ? row.agent.trim() : '';
  const actorId = typeof row.id === 'string' ? row.id.trim() : '';
  if (explicitAgent && actorId && explicitAgent !== actorId)
    throw new AccountLeaseError('INVALID_AGENT', 'account lease entry has conflicting agent and id fields');
  const agent = explicitAgent || actorId;
  if (!agent || agent.length > 128)
    throw new AccountLeaseError('INVALID_AGENT', 'account lease entry requires an agent name');
  const credentials = row.credentials && typeof row.credentials === 'object'
    ? row.credentials : row;
  const account = normalizeAccountId(credentials.account);
  const endpoint = normalizeGameEndpoint(credentials.host ?? defaultHost, credentials.port ?? defaultPort);
  const subject = accountClaimSubject(agent, credentials.character);
  const key = JSON.stringify([endpoint.host, endpoint.port, account]);
  const digest = createHash('sha256').update(key).digest('hex');
  return Object.freeze({
    agent, account, endpoint, subject,
    key,
    path: join(leaseDir, `${digest}.lock`),
  });
}

function absolutePaths(values, label) {
  if (!Array.isArray(values)) throw new AccountLeaseError('INVALID_LEGACY_AUDIT', `${label} must be an array`);
  return Object.freeze(values.map(value => {
    if (typeof value !== 'string' || !value.trim() || !isAbsolute(value))
      throw new AccountLeaseError('INVALID_LEGACY_AUDIT', `${label} entries must be absolute paths`);
    return resolve(value);
  }));
}

function unguardedRecoveryContext(value) {
  if (!value) return false;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new AccountLeaseError('INVALID_RECOVERY', 'unguarded recovery requires an exact predecessor and roster path');
  const previousPid = Number(value.previousPid);
  const rosterPaths = absolutePaths(value.rosterPaths, 'unguardedBrokerRecovery.rosterPaths');
  if (!Number.isSafeInteger(previousPid) || previousPid <= 0 || !rosterPaths.length)
    throw new AccountLeaseError('INVALID_RECOVERY', 'unguarded recovery context is invalid');
  return Object.freeze({ previousPid, rosterPaths });
}

function standardRosterPaths(roots, extraPaths) {
  const paths = new Set(extraPaths);
  for (const root of roots) {
    paths.add(join(root, 'fleet-state.json'));
    const fleets = join(root, 'fleets');
    let entries;
    try { entries = readdirSync(fleets, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new AccountLeaseError(
        'LEGACY_AUDIT_FAILED', `cannot enumerate legacy roster directory ${fleets}: ${error.message}`,
        { path: fleets, error_code: error?.code ?? null },
      );
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) paths.add(join(fleets, entry.name));
    }
  }
  return [...paths].sort();
}

function legacyRosterRows(roster, rosterPath) {
  if (!roster || typeof roster !== 'object' || Array.isArray(roster))
    throw new AccountLeaseError(
      'LEGACY_ROSTER_UNVERIFIABLE', `live legacy roster is not an object: ${rosterPath}`,
      { roster_path: rosterPath },
    );
  return Object.entries(roster).flatMap(([agent, entry]) => {
    const credentials = entry?.credentials;
    if (!credentials || credentials.account == null) return [];
    let account;
    try { account = normalizeAccountId(credentials.account); }
    catch (error) {
      throw new AccountLeaseError(
        'LEGACY_ROSTER_UNVERIFIABLE',
        `live legacy roster has an invalid account for ${agent}: ${rosterPath}`,
        { roster_path: rosterPath, agent, cause: error.message },
      );
    }
    // A legacy broker's process-wide M59_HOST/M59_PORT cannot be recovered from its lock.
    // Explicit persisted endpoints can be compared exactly. Missing or malformed endpoint
    // fields are deliberately a wildcard: refusing another use of the same account is safer
    // than assuming the old broker used this process's defaults.
    let endpoint = null;
    if (credentials.host != null && credentials.port != null) {
      try { endpoint = normalizeGameEndpoint(credentials.host, credentials.port); }
      catch { endpoint = null; }
    }
    return [{ agent, account, endpoint }];
  });
}

function auditPlanAgainstLegacy(plan, {
  legacyRosterRoots,
  legacyRosterPaths,
  isPidLive,
  unguardedBrokerRecovery = false,
}) {
  if (!legacyRosterRoots.length && !legacyRosterPaths.length)
    return Object.freeze({ ok: true, checked: 0 });
  const candidates = new Map();
  for (const identity of plan) {
    const rows = candidates.get(identity.account) ?? [];
    rows.push(identity);
    candidates.set(identity.account, rows);
  }
  let checked = 0;
  for (const rosterPath of standardRosterPaths(legacyRosterRoots, legacyRosterPaths)) {
    const found = inspectFleetLock(`${rosterPath}.lock`, { isPidLive });
    const unguardedDeadBroker = found.state === 'stale' &&
      found.lock?.kind === BROKER_FLEET_LOCK_KIND && !Object.hasOwn(found.lock, 'guards');
    const exactRecovery = unguardedDeadBroker && unguardedBrokerRecovery &&
      found.lock.pid === unguardedBrokerRecovery.previousPid &&
      unguardedBrokerRecovery.rosterPaths.includes(resolve(rosterPath));
    if (exactRecovery) continue;
    if (found.state !== 'live' && !unguardedDeadBroker) continue;
    // Token-bearing owners participate in account leases. If this process wins an account
    // race before such an owner claims it, that owner will fail its own startup safely.
    if (found.state === 'live' && found.lock && !found.lock.legacy) continue;
    checked++;
    let rosterSource;
    try { rosterSource = readFileSync(rosterPath, 'utf8'); }
    catch (error) {
      return Object.freeze({
        ok: false,
        code: 'LEGACY_ROSTER_UNVERIFIABLE',
        found,
        legacy_roster: rosterPath,
        why: `live legacy roster cannot be read before login: ${rosterPath} ` +
          `(${error.code ?? 'read failed'})`,
      });
    }
    let roster;
    try { roster = JSON.parse(rosterSource); }
    catch {
      return Object.freeze({
        ok: false,
        code: 'LEGACY_ROSTER_UNVERIFIABLE',
        found,
        legacy_roster: rosterPath,
        why: `live legacy roster is not valid JSON: ${rosterPath}`,
      });
    }
    let legacyRows;
    try { legacyRows = legacyRosterRows(roster, rosterPath); }
    catch (error) {
      return Object.freeze({
        ok: false,
        code: error.code ?? 'LEGACY_ROSTER_UNVERIFIABLE',
        found,
        legacy_roster: rosterPath,
        why: error.message,
      });
    }
    for (const legacy of legacyRows) {
      const matchingAccount = candidates.get(legacy.account) ?? [];
      const conflict = matchingAccount.find(identity =>
        legacy.endpoint === null || identity.endpoint.key === legacy.endpoint.key);
      if (!conflict) continue;
      return Object.freeze({
        ok: false,
        code: unguardedDeadBroker ? 'UNGUARDED_STALE_BROKER' :
          found.lock?.legacy ? 'LEGACY_ACCOUNT_HELD' : 'UNVERIFIABLE_ROSTER_LOCK',
        conflict,
        found,
        legacy_roster: rosterPath,
        legacy_agent: legacy.agent,
        legacy_endpoint: legacy.endpoint,
        why: `the account for actor ${conflict.agent} at ${conflict.endpoint.key} may already be ` +
          `logged in by ${rosterPath} (pid ${found.lock?.pid ?? 'unknown'})`,
      });
    }
  }
  return Object.freeze({ ok: true, checked });
}

/** Normalize and reject aliases before touching any lease file. */
export function planAccountLeases(entries, {
  defaultHost = '127.0.0.1',
  defaultPort = 5959,
  leaseDir = DEFAULT_ACCOUNT_LEASE_DIR,
} = {}) {
  const root = absoluteLeaseDir(leaseDir);
  const identities = entryRows(entries).map(row => identityFor(row, {
    defaultHost, defaultPort, leaseDir: root,
  }));
  const agents = new Map();
  const accounts = new Map();
  for (const identity of identities) {
    if (agents.has(identity.agent))
      throw new AccountLeaseError('DUPLICATE_AGENT', `agent ${identity.agent} appears more than once`, {
        agent: identity.agent,
      });
    agents.set(identity.agent, identity);
    const other = accounts.get(identity.key);
    if (other) throw new AccountLeaseError(
      'DUPLICATE_ACCOUNT',
      `${identity.agent} and ${other.agent} normalize to the same account at ${identity.endpoint.key}`,
      { agents: [other.agent, identity.agent], account: identity.account, endpoint: identity.endpoint },
    );
    accounts.set(identity.key, identity);
  }
  return Object.freeze([...identities].sort((left, right) => left.key.localeCompare(right.key)));
}

/**
 * Migration guard for brokers that loaded the pre-token implementation. It only reads the
 * standard roster and lock files supplied here; it never mutates or reclaims them.
 */
export function auditLegacyRosterLocks(entries, {
  defaultHost = '127.0.0.1',
  defaultPort = 5959,
  leaseDir = DEFAULT_ACCOUNT_LEASE_DIR,
  legacyRosterRoots = [DEFAULT_LEGACY_ROSTER_ROOT],
  legacyRosterPaths = [],
  isPidLive = isProcessLive,
  unguardedBrokerRecovery = false,
} = {}) {
  const roots = absolutePaths(legacyRosterRoots, 'legacyRosterRoots');
  const paths = absolutePaths(legacyRosterPaths, 'legacyRosterPaths');
  const plan = planAccountLeases(entries, { defaultHost, defaultPort, leaseDir });
  const recovery = unguardedRecoveryContext(unguardedBrokerRecovery);
  return auditPlanAgainstLegacy(plan, {
    legacyRosterRoots: roots,
    legacyRosterPaths: paths,
    isPidLive,
    unguardedBrokerRecovery: recovery,
  });
}

export class AccountLeaseRegistry {
  #byAgent = new Map();
  #byKey = new Map();
  #guardedAdoption = false;
  #unguardedRecovery = false;

  constructor({
    leaseDir = DEFAULT_ACCOUNT_LEASE_DIR,
    kind = FLEET_LOCK_KIND,
    pid = process.pid,
    defaultHost = '127.0.0.1',
    defaultPort = 5959,
    isPidLive = isProcessLive,
    now = Date.now,
    tokenFactory = randomUUID,
    legacyRosterRoots = [DEFAULT_LEGACY_ROSTER_ROOT],
    legacyRosterPaths = [],
    unguardedBrokerRecovery = false,
    adoptGuardedBroker = false,
    guardChildren = false,
  } = {}) {
    this.leaseDir = absoluteLeaseDir(leaseDir);
    this.kind = kind;
    this.pid = pid;
    this.defaultHost = defaultHost;
    this.defaultPort = defaultPort;
    this.isPidLive = isPidLive;
    this.now = now;
    this.tokenFactory = tokenFactory;
    if (typeof guardChildren !== 'boolean')
      throw new TypeError('guardChildren must be a boolean');
    this.guardChildren = guardChildren;
    this.legacyRosterRoots = absolutePaths(legacyRosterRoots, 'legacyRosterRoots');
    this.legacyRosterPaths = absolutePaths(legacyRosterPaths, 'legacyRosterPaths');
    if (unguardedBrokerRecovery) this.setUnguardedRecoveryContext(unguardedBrokerRecovery);
    if (adoptGuardedBroker) this.setGuardedAdoptionContext(adoptGuardedBroker);
  }

  get size() { return this.#byAgent.size; }
  get held() {
    return Object.freeze([...this.#byKey.values()].map(row => row.identity));
  }
  hasAgent(agent) { return this.#byAgent.has(agent); }

  setGuardedAdoptionContext(context) {
    if (this.#byKey.size)
      throw new AccountLeaseError('ADOPTION_TOO_LATE', 'guarded adoption must be set before account claims');
    const candidates = context?.previousPids ??
      (context?.previousPid == null ? [] : [context.previousPid]);
    const previousPids = Array.isArray(candidates)
      ? [...new Set(candidates.map(Number))] : [];
    const guardPids = Array.isArray(context?.guardPids)
      ? [...new Set(context.guardPids.map(Number))].sort((a, b) => a - b) : [];
    if (!previousPids.length || previousPids.length > 256 ||
        previousPids.some(pid => !Number.isSafeInteger(pid) || pid <= 0) || !guardPids.length ||
        guardPids.some(pid => !Number.isSafeInteger(pid) || pid <= 0))
      throw new AccountLeaseError('INVALID_ADOPTION', 'guarded adoption context is invalid');
    this.#guardedAdoption = Object.freeze({
      previousPids: Object.freeze(previousPids), guardPids: Object.freeze(guardPids),
    });
    return this.#guardedAdoption;
  }

  setUnguardedRecoveryContext(context) {
    if (this.#byKey.size)
      throw new AccountLeaseError('RECOVERY_TOO_LATE', 'unguarded recovery must be set before account claims');
    this.#unguardedRecovery = unguardedRecoveryContext(context);
    return this.#unguardedRecovery;
  }

  permitForAgent(agent) {
    const row = this.#byAgent.get(agent);
    if (!row) return null;
    const { path, lock } = row.claim;
    return Object.freeze({
      path, pid: lock.pid, token: lock.token, kind: lock.kind,
      // An opaque actor+character binding lets a child prove that the credentials sent
      // over IPC are the exact subject the parent claimed without disclosing either one
      // in the lease file or permit diagnostics.
      subject: row.identity.subject,
    });
  }

  addGuard(agent, guardPid) {
    const permit = this.permitForAgent(agent);
    if (!permit) return Object.freeze({ ok: false, reason: 'agent-not-held', agent });
    const result = addFleetLockGuard(permit.path, {
      ...permit, guardPid, isPidLive: this.isPidLive,
    });
    return Object.freeze({ ...result, agent, ...(result.ok ? { permit } : {}) });
  }

  verifyGuard(agent, guardPid) {
    const permit = this.permitForAgent(agent);
    if (!permit) return Object.freeze({ ok: false, reason: 'agent-not-held', agent });
    const result = verifyFleetLockGuard(permit.path, {
      ...permit, guardPid, isPidLive: this.isPidLive,
    });
    return Object.freeze({ ...result, agent });
  }

  plan(entries) {
    return planAccountLeases(entries, {
      defaultHost: this.defaultHost,
      defaultPort: this.defaultPort,
      leaseDir: this.leaseDir,
    });
  }

  acquire(agent, credentials) {
    const before = this.#byAgent.get(agent) ?? null;
    const result = this.acquireAll([{ agent, credentials }]);
    if (!result.ok) return result;
    const row = this.#byAgent.get(agent);
    return Object.freeze({
      ok: true,
      identity: row.identity,
      newly_acquired: !before || before.identity.key !== row.identity.key,
    });
  }

  acquireAll(entries) {
    const plan = this.plan(entries);
    // Local aliases are rejected even across separate incremental calls.
    for (const identity of plan) {
      const sameAccount = this.#byKey.get(identity.key);
      if (sameAccount && sameAccount.identity.agent !== identity.agent)
        throw new AccountLeaseError('DUPLICATE_ACCOUNT',
          `${identity.agent} and ${sameAccount.identity.agent} normalize to the same account ` +
            `at ${identity.endpoint.key}`,
          { agents: [sameAccount.identity.agent, identity.agent],
            account: identity.account, endpoint: identity.endpoint });
    }

    // Account lease files did not exist before this protocol shipped. During rollout, a
    // still-running old broker can therefore own an alias roster without appearing in the
    // lease directory. Audit every standard live legacy roster lock before touching a lease
    // or opening a socket. This is intentionally conservative for unreadable live records.
    const legacy = auditPlanAgainstLegacy(plan, {
      legacyRosterRoots: this.legacyRosterRoots,
      legacyRosterPaths: this.legacyRosterPaths,
      isPidLive: this.isPidLive,
      unguardedBrokerRecovery: this.#unguardedRecovery,
    });
    if (!legacy.ok) return legacy;

    mkdirSync(this.leaseDir, { recursive: true });
    const provisional = [];
    for (const identity of plan) {
      const current = this.#byAgent.get(identity.agent);
      if (current?.identity.key === identity.key) continue;
      // A previous rebind by this same agent deliberately retains its old lease until
      // process shutdown. Switching back can reuse that claim rather than contending with
      // our own pid/token.
      const retained = this.#byKey.get(identity.key);
      if (retained?.identity.agent === identity.agent) continue;
      const claim = claimFleetLock(identity.path, {
        pid: this.pid,
        kind: this.kind,
        subject: identity.subject,
        guards: this.kind === BROKER_FLEET_LOCK_KIND || this.guardChildren ? [] : null,
        token: this.tokenFactory(),
        tokenFactory: this.tokenFactory,
        isPidLive: this.isPidLive,
        now: this.now,
        allowUnguardedBrokerTakeover: this.#unguardedRecovery
          ? { previousPid: this.#unguardedRecovery.previousPid } : false,
        adoptGuardedBroker: this.#guardedAdoption,
      });
      if (!claim.ok) {
        for (const row of provisional.reverse()) row.claim.release();
        return Object.freeze({
          ok: false,
          code: 'ACCOUNT_HELD',
          conflict: identity,
          found: claim.found,
        });
      }
      provisional.push({ identity, claim });
    }

    // Publish the new registry only after every cross-process claim succeeded. Rebinding an
    // agent retains the old endpoint/account claim for the process lifetime: Session.join may
    // fail after the new claim, while the old socket can still be alive. Releasing it here
    // would let another runtime kick that still-live account.
    for (const row of provisional) {
      this.#byKey.set(row.identity.key, row);
    }
    for (const identity of plan) {
      const row = this.#byKey.get(identity.key);
      if (row) this.#byAgent.set(identity.agent, row);
    }
    return Object.freeze({
      ok: true,
      acquired: Object.freeze(provisional.map(row => row.identity)),
      held: this.held,
    });
  }

  #validateGuardedAdoptionCoverage() {
    if (!this.#guardedAdoption)
      return Object.freeze({ ok: true, required: false });

    // Cache every answer so a PID is classified once across the fleet/account set. Only a
    // definite false is dead; exceptions and non-booleans retain lineage and fail closed.
    const liveness = new Map();
    const live = pid => {
      if (liveness.has(pid)) return liveness.get(pid);
      let value;
      try { value = this.isPidLive(pid); } catch { value = undefined; }
      liveness.set(pid, value);
      return value;
    };
    const inheritedLive = new Set();
    for (const guardPid of this.#guardedAdoption.guardPids) {
      const status = live(guardPid);
      if (status === true) inheritedLive.add(guardPid);
      else if (status !== false) return Object.freeze({
        ok: false, reason: 'fleet-guard-liveness-uncertain', guard_pid: guardPid,
      });
    }

    const accountOwners = new Map();
    for (const row of this.#byKey.values()) {
      const found = inspectFleetLock(row.identity.path, { isPidLive: this.isPidLive });
      if (found.state !== 'live' || found.lock?.pid !== row.claim.lock.pid ||
          found.lock?.token !== row.claim.lock.token || found.lock?.kind !== row.claim.lock.kind)
        return Object.freeze({
          ok: false, reason: 'account-claim-not-held', agent: row.identity.agent,
        });
      if (found.lock.subject !== row.identity.subject)
        return Object.freeze({
          ok: false, reason: 'account-subject-mismatch', agent: row.identity.agent,
        });
      for (const guardPid of found.lock.guards ?? []) {
        const status = live(guardPid);
        if (status !== true && status !== false) return Object.freeze({
          ok: false, reason: 'account-guard-liveness-uncertain',
          agent: row.identity.agent, guard_pid: guardPid,
        });
        if (status === false) continue;
        const agents = accountOwners.get(guardPid) ?? [];
        agents.push(row.identity.agent);
        accountOwners.set(guardPid, agents);
      }
    }

    for (const guardPid of [...inheritedLive].sort((a, b) => a - b)) {
      const agents = accountOwners.get(guardPid) ?? [];
      if (!agents.length) return Object.freeze({
        ok: false, reason: 'inherited-fleet-guard-unaccounted', guard_pid: guardPid,
      });
      if (agents.length !== 1) return Object.freeze({
        ok: false, reason: 'inherited-guard-claimed-more-than-once',
        guard_pid: guardPid, agents: Object.freeze(agents),
      });
    }
    for (const [guardPid, agents] of accountOwners) {
      if (!inheritedLive.has(guardPid)) return Object.freeze({
        ok: false, reason: 'account-guard-absent-from-fleet',
        guard_pid: guardPid, agent: agents[0],
      });
    }
    return Object.freeze({
      ok: true, required: true, live_guards: inheritedLive.size,
    });
  }

  /** Clear takeover lineage only after every inherited live guard maps to one selected account. */
  finalizeAdoptions() {
    const coverage = this.#validateGuardedAdoptionCoverage();
    if (!coverage.ok) return coverage;
    for (const row of this.#byKey.values()) {
      const result = finalizeFleetLockAdoption(row.identity.path, {
        pid: row.claim.lock.pid,
        token: row.claim.lock.token,
        kind: row.claim.lock.kind,
      });
      if (!result.ok) return Object.freeze({
        ok: false,
        reason: result.reason,
        agent: row.identity.agent,
      });
    }
    this.#guardedAdoption = false;
    this.#unguardedRecovery = false;
    return Object.freeze({ ok: true, finalized: this.#byKey.size, coverage });
  }

  releaseAgent(agent) {
    if (!this.#byAgent.has(agent)) return Object.freeze({ released: false, reason: 'not-held', agent });
    this.#byAgent.delete(agent);
    const rows = [...this.#byKey.values()].filter(row => row.identity.agent === agent);
    for (const row of rows) this.#byKey.delete(row.identity.key);
    const results = rows.map(row => row.claim.release());
    return results.length === 1 ? results[0] : Object.freeze({
      released: results.every(result => result.released), results: Object.freeze(results), agent,
    });
  }

  releaseAll() {
    const rows = [...this.#byKey.values()].reverse();
    this.#byAgent.clear();
    this.#byKey.clear();
    return Object.freeze(rows.map(row => row.claim.release()));
  }
}
