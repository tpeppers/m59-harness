// Capability boundary between the optional lab parent and its shard children.
//
// The parent owns every fleet/account token. A child receives only a bounded permit after
// its pid is present on the exact assigned account claims and, last, on the fleet claim.
// The child must verify the complete permit before importing Meridian/Session code.

import { isAbsolute, resolve } from 'node:path';

import {
  DEFAULT_ACCOUNT_LEASE_DIR,
  planAccountLeases,
} from '../account-leases.mjs';
import {
  FLEET_LOCK_KIND,
  addFleetLockGuard,
  inspectFleetLock,
  isProcessLive,
  verifyFleetLockGuard,
} from '../fleet-lock.mjs';
import { configuredPartyPlan } from '../party-roster.mjs';

export const SHARD_PERMIT_SCHEMA = 'm59-lab-shard-permit/v1';
export const MAX_LAB_SHARDS = 32;
const MAX_ACTORS_PER_PERMIT = 256;
const TOKEN = /^[^\u0000-\u001f\u007f]{8,256}$/;
const SUBJECT = /^[^\u0000-\u001f\u007f]{1,128}$/;

function positivePid(value, label) {
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError(`${label} must be a positive pid`);
  return pid;
}

function actorId(value, label = 'actor id') {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(value))
    throw new TypeError(`${label} is invalid`);
  return value.trim();
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value))
    throw new TypeError(`${label} must be an absolute path`);
  return resolve(value);
}

function claimPermit(value, label, { requireSubject = false } = {}) {
  const source = value?.lock && value?.path
    ? { path: value.path, ...value.lock }
    : value;
  if (!source || typeof source !== 'object' || Array.isArray(source))
    throw new TypeError(`${label} is invalid`);
  const path = absolutePath(source.path, `${label} path`);
  const pid = positivePid(source.pid, `${label} owner`);
  const token = typeof source.token === 'string' && TOKEN.test(source.token) ? source.token : null;
  if (!token) throw new TypeError(`${label} token is invalid`);
  if (source.kind !== FLEET_LOCK_KIND)
    throw new TypeError(`${label} must be owned by a lab runtime`);
  const subject = requireSubject && typeof source.subject === 'string' && SUBJECT.test(source.subject)
    ? source.subject : null;
  if (requireSubject && !subject) throw new TypeError(`${label} subject is invalid`);
  return Object.freeze({ path, pid, token, kind: source.kind, ...(subject ? { subject } : {}) });
}

function exactEntries(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_ACTORS_PER_PERMIT)
    throw new TypeError(`shard entries must contain 1-${MAX_ACTORS_PER_PERMIT} actors`);
  const seen = new Set();
  return entries.map(entry => {
    const id = actorId(entry?.id);
    if (seen.has(id)) throw new TypeError(`shard actor ${id} is duplicated`);
    seen.add(id);
    return { id, entry };
  });
}

/**
 * Keep configured partner pairs in one process, then place the largest independent
 * groups into the currently least-loaded shard. IDs break every tie, so a roster with
 * the same actors and partner graph always receives the same partition.
 */
export function partitionShardEntries(entries, shardCount) {
  const rows = exactEntries(entries);
  const count = Number(shardCount);
  const max = Math.min(MAX_LAB_SHARDS, rows.length);
  if (!Number.isSafeInteger(count) || count < 1 || count > max)
    throw new RangeError(`shard count must be an integer from 1 to ${max}`);

  const plan = configuredPartyPlan(rows.map(row => row.entry));
  const parent = new Map(rows.map(({ id }) => [id, id]));
  const find = id => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== id) {
      const next = parent.get(id);
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  for (const [left, right] of plan.pairs) {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(b, a < b ? a : b), parent.set(a, a < b ? a : b);
  }

  const byRoot = new Map();
  for (const row of rows) {
    const root = find(row.id);
    const group = byRoot.get(root) ?? [];
    group.push(row);
    byRoot.set(root, group);
  }
  const groups = [...byRoot.values()].map(group => Object.freeze({
    key: group.map(row => row.id).sort().join('\u0000'),
    rows: Object.freeze(group),
  })).sort((left, right) =>
    right.rows.length - left.rows.length || left.key.localeCompare(right.key));
  if (count > groups.length)
    throw new RangeError(
      `shard count ${count} exceeds ${groups.length} independent actor/partner groups`);

  const order = new Map(rows.map((row, index) => [row.id, index]));
  const bins = Array.from({ length: count }, (_, index) => ({ index, rows: [] }));
  for (const group of groups) {
    const bin = [...bins].sort((left, right) =>
      left.rows.length - right.rows.length || left.index - right.index)[0];
    bin.rows.push(...group.rows);
  }
  return Object.freeze(bins.map((bin, index) => {
    const assigned = [...bin.rows].sort((left, right) => order.get(left.id) - order.get(right.id));
    return Object.freeze({
      id: index + 1,
      actorIds: Object.freeze(assigned.map(row => row.id)),
      entries: Object.freeze(assigned.map(row => row.entry)),
    });
  }));
}

function accountPermitRows(value) {
  if (value instanceof Map)
    return [...value].map(([agent, permit]) => ({ agent, ...permit }));
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object')
    return Object.entries(value).map(([agent, permit]) => ({ agent, ...permit }));
  throw new TypeError('account permits must be an array, Map, or object');
}

/** Build the bounded credential-free object sent over IPC after guard installation. */
export function buildShardPermit({
  shardId,
  stateFile,
  guardPid,
  fleetPermit,
  accountPermits,
  entries,
} = {}) {
  const rows = exactEntries(entries);
  const id = Number(shardId);
  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_LAB_SHARDS)
    throw new RangeError(`shardId must be an integer from 1 to ${MAX_LAB_SHARDS}`);
  const childPid = positivePid(guardPid, 'shard guard');
  const fleet = claimPermit(fleetPermit, 'fleet permit');
  const wanted = new Set(rows.map(row => row.id));
  const accounts = accountPermitRows(accountPermits).map(row => {
    const agent = actorId(row?.agent, 'account permit actor');
    if (!wanted.delete(agent)) throw new TypeError('account permits do not exactly match shard actors');
    const permit = claimPermit(row, `account permit for ${agent}`, { requireSubject: true });
    if (permit.pid !== fleet.pid) throw new TypeError('account and fleet permits have different owners');
    return Object.freeze({ agent, ...permit });
  });
  if (wanted.size || accounts.length !== rows.length)
    throw new TypeError('account permits do not exactly match shard actors');
  accounts.sort((left, right) => left.agent.localeCompare(right.agent));
  return Object.freeze({
    schema: SHARD_PERMIT_SCHEMA,
    shard_id: id,
    state_file: absolutePath(stateFile, 'state file'),
    guard_pid: childPid,
    parent_pid: fleet.pid,
    actor_ids: Object.freeze(rows.map(row => row.id)),
    fleet,
    accounts: Object.freeze(accounts),
  });
}

function permitFailure(reason, agent = null) {
  return Object.freeze({ ok: false, reason, ...(agent ? { agent } : {}) });
}

/**
 * Child-side fail-closed verification. `entries` are the credentials delivered in the
 * same post-authorization IPC message; account path + opaque subject bind them to the
 * exact endpoint/account/actor/character claims without returning secrets in errors.
 */
export function verifyShardPermit({
  permit,
  entries,
  childPid = process.pid,
  expectedStateFile = null,
  expectedLockFile = null,
  leaseDir = DEFAULT_ACCOUNT_LEASE_DIR,
  isPidLive = isProcessLive,
} = {}) {
  let rows;
  let fleet;
  let guardPid;
  let stateFile;
  try {
    rows = exactEntries(entries);
    if (!permit || permit.schema !== SHARD_PERMIT_SCHEMA || !Array.isArray(permit.actor_ids) ||
        !Array.isArray(permit.accounts) || permit.accounts.length > MAX_ACTORS_PER_PERMIT)
      return permitFailure('invalid-permit');
    guardPid = positivePid(childPid, 'child pid');
    if (positivePid(permit.guard_pid, 'permit guard') !== guardPid)
      return permitFailure('guard-pid-mismatch');
    if (positivePid(permit.parent_pid, 'permit parent') === guardPid)
      return permitFailure('invalid-permit');
    fleet = claimPermit(permit.fleet, 'fleet permit');
    if (fleet.pid !== permit.parent_pid) return permitFailure('invalid-permit');
    stateFile = absolutePath(permit.state_file, 'permit state file');
    if (expectedStateFile && stateFile !== absolutePath(expectedStateFile, 'expected state file'))
      return permitFailure('state-file-mismatch');
    if (expectedLockFile && fleet.path !== absolutePath(expectedLockFile, 'expected lock file'))
      return permitFailure('fleet-lock-mismatch');
  } catch {
    return permitFailure('invalid-permit');
  }

  let parentLive;
  try { parentLive = isPidLive(fleet.pid); } catch { parentLive = undefined; }
  if (parentLive !== true) return permitFailure('parent-not-live');

  const ids = rows.map(row => row.id);
  if (permit.actor_ids.length !== ids.length ||
      permit.actor_ids.some((id, index) => id !== ids[index]))
    return permitFailure('actor-set-mismatch');

  let identities;
  try { identities = planAccountLeases(entries, { leaseDir }); }
  catch { return permitFailure('account-identity-mismatch'); }
  const identityByAgent = new Map(identities.map(identity => [identity.agent, identity]));
  const seen = new Set();
  const accountPermits = [];
  try {
    for (const row of permit.accounts) {
      const agent = actorId(row?.agent, 'permit actor');
      if (seen.has(agent)) return permitFailure('account-permit-duplicate', agent);
      seen.add(agent);
      const account = claimPermit(row, `account permit for ${agent}`, { requireSubject: true });
      const identity = identityByAgent.get(agent);
      if (!identity || account.pid !== fleet.pid || account.path !== identity.path ||
          account.subject !== identity.subject)
        return permitFailure('account-identity-mismatch', agent);
      accountPermits.push({ agent, account });
    }
  } catch {
    return permitFailure('invalid-permit');
  }
  if (seen.size !== identities.length) return permitFailure('account-set-mismatch');

  const fleetVerified = verifyFleetLockGuard(fleet.path, {
    ...fleet, guardPid, isPidLive,
  });
  if (!fleetVerified.ok) return permitFailure('fleet-guard-not-held');
  for (const { agent, account } of accountPermits) {
    const verified = verifyFleetLockGuard(account.path, {
      ...account, guardPid, isPidLive,
    });
    if (!verified.ok || verified.found?.lock?.subject !== account.subject)
      return permitFailure('account-guard-not-held', agent);
  }
  return Object.freeze({
    ok: true,
    shardId: permit.shard_id,
    parentPid: fleet.pid,
    stateFile,
    actorIds: Object.freeze([...ids]),
  });
}

function exactHeldClaim(path, permit, { subject = null, isPidLive }) {
  const found = inspectFleetLock(path, { isPidLive });
  return found.lock?.pid === permit.pid && found.lock?.token === permit.token &&
    found.lock?.kind === permit.kind && Object.hasOwn(found.lock, 'guards') &&
    (subject === null || found.lock.subject === subject);
}

/**
 * Parent-side authorization transaction. There is no rollback of account guards (guard
 * removal would itself race a starting child); the fleet guard is the final commit marker,
 * so every partial failure remains unauthorized and safe to prune once the child is dead.
 */
export function authorizeShard({
  shardId,
  stateFile,
  entries,
  childPid,
  fleetClaim,
  accountLeases,
  isPidLive = isProcessLive,
} = {}) {
  let rows;
  let fleet;
  let identities;
  let guardPid;
  try {
    rows = exactEntries(entries);
    guardPid = positivePid(childPid, 'child pid');
    fleet = claimPermit(fleetClaim, 'fleet claim');
    if (!accountLeases || typeof accountLeases.plan !== 'function' ||
        typeof accountLeases.permitForAgent !== 'function' ||
        typeof accountLeases.addGuard !== 'function')
      throw new TypeError('accountLeases must be an acquired AccountLeaseRegistry');
    identities = accountLeases.plan(entries);
  } catch {
    return permitFailure('invalid-authorization');
  }
  let live;
  try { live = isPidLive(guardPid); } catch { live = undefined; }
  if (live !== true) return permitFailure('child-not-live');
  if (!exactHeldClaim(fleet.path, fleet, { isPidLive }))
    return permitFailure('fleet-claim-not-held');

  const identityByAgent = new Map(identities.map(identity => [identity.agent, identity]));
  const accountPermits = [];
  const paths = new Set();
  for (const { id } of rows) {
    let permit;
    try { permit = claimPermit(accountLeases.permitForAgent(id), `account claim for ${id}`, {
      requireSubject: true,
    }); } catch { return permitFailure('account-claim-not-held', id); }
    const identity = identityByAgent.get(id);
    if (!identity || permit.pid !== fleet.pid || permit.path !== identity.path ||
        permit.subject !== identity.subject || paths.has(permit.path) ||
        !exactHeldClaim(permit.path, permit, { subject: identity.subject, isPidLive }))
      return permitFailure('account-claim-not-held', id);
    paths.add(permit.path);
    accountPermits.push(Object.freeze({ agent: id, ...permit }));
  }

  // Accounts first, fleet last. The child is not sent credentials/permit until this
  // function succeeds, and child verification requires both layers.
  for (const { id } of rows) {
    const added = accountLeases.addGuard(id, guardPid);
    if (!added?.ok) return permitFailure('account-guard-install-failed', id);
  }
  try { live = isPidLive(guardPid); } catch { live = undefined; }
  if (live !== true) return permitFailure('child-died-before-commit');
  const fleetAdded = addFleetLockGuard(fleet.path, {
    ...fleet, guardPid, isPidLive,
  });
  if (!fleetAdded.ok) return permitFailure('fleet-guard-install-failed');

  try {
    return Object.freeze({
      ok: true,
      permit: buildShardPermit({
        shardId, stateFile, guardPid, fleetPermit: fleet,
        accountPermits, entries,
      }),
    });
  } catch {
    // This should have been caught by preflight. Still fail closed: the now-live fleet
    // guard prevents ownership release/reclaim while the child may be running.
    return permitFailure('permit-build-failed');
  }
}
