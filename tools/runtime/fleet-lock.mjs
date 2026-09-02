// Atomic ownership shared by the optional lab FleetRuntime and the standard broker.
//
// This module accepts an exact absolute file path. It never searches a directory, derives a
// path from a fleet label, or guesses an owner. Observed-state channels may be lossy;
// ownership cannot be, so uncertain files fail closed. Guarded broker claims are reclaimed
// only when owner and guards are positively dead, or atomically adopted by the exact broker
// successor; pre-guard broker claims need an explicit one-time migration override.

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as FS_CONSTANTS,
  copyFileSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const FLEET_LOCK_KIND = 'lab-runtime';
export const BROKER_FLEET_LOCK_KIND = 'broker-runtime';
const CLAIM_KINDS = new Set([FLEET_LOCK_KIND, BROKER_FLEET_LOCK_KIND]);
const MAX_LOCK_BYTES = 4096;
const MAX_GUARD_PIDS = 1024;
const MAX_PREDECESSOR_PIDS = 256;
const RAW = Symbol('fleet-lock-raw');

function exactPath(lockPath) {
  if (typeof lockPath !== 'string' || !lockPath.trim())
    throw new TypeError('lockPath must be a non-empty absolute path');
  if (!isAbsolute(lockPath)) throw new TypeError('lockPath must be absolute');
  return resolve(lockPath);
}

function missing(error) {
  return error?.code === 'ENOENT';
}

function safePid(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function safeToken(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 256 ? value : null;
}

function claimSubject(value, { optional = true } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || !value || value.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(value)) return false;
  return value;
}

function claimKind(value) {
  return CLAIM_KINDS.has(value) ? value : null;
}

function guardPids(value, { optional = true } = {}) {
  if (value == null && optional) return null;
  if (!Array.isArray(value) || value.length > MAX_GUARD_PIDS) return false;
  const guards = [];
  const seen = new Set();
  for (const candidate of value) {
    const pid = safePid(candidate);
    if (!pid || seen.has(pid)) return false;
    seen.add(pid);
    guards.push(pid);
  }
  return Object.freeze(guards.sort((left, right) => left - right));
}

function predecessorPids(value, { optional = true } = {}) {
  if (value == null && optional) return null;
  if (!Array.isArray(value) || value.length > MAX_PREDECESSOR_PIDS) return false;
  const predecessors = [];
  const seen = new Set();
  for (const candidate of value) {
    const pid = safePid(candidate);
    if (!pid || seen.has(pid)) return false;
    seen.add(pid);
    predecessors.push(pid);
  }
  return Object.freeze(predecessors);
}

function quarantineSuffix(tokenFactory) {
  const value = tokenFactory();
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value))
    throw new TypeError('tokenFactory must return an 8-128 character filename-safe token');
  return value;
}

function lockRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pid = safePid(value.pid);
  const at = Number.isSafeInteger(value.at) && value.at >= 0 ? value.at : null;
  if (!pid || at === null) return null;
  const kind = claimKind(value.kind);
  const token = safeToken(value.token);
  const subject = Object.hasOwn(value, 'subject')
    ? claimSubject(value.subject, { optional: false }) : null;
  const guards = Object.hasOwn(value, 'guards') ? guardPids(value.guards, { optional: false }) : null;
  const predecessors = Object.hasOwn(value, 'predecessors')
    ? predecessorPids(value.predecessors, { optional: false }) : null;
  if (subject === false || guards === false || predecessors === false) return null;
  if (kind && token) return Object.freeze({
    pid, at, kind, token,
    ...(subject !== null ? { subject } : {}),
    ...(guards !== null ? { guards } : {}),
    ...(predecessors !== null ? { predecessors } : {}),
  });
  // Migration from the old broker's check-then-overwrite `{pid,at}` file. It blocks while
  // the pid is alive and, even after owner death, fails closed unless the standard broker
  // receives the explicit migration override: old keeper children may have survived. It
  // can never be released as ours because it has no ownership token.
  const legacyKeys = Object.keys(value).sort();
  if (value.kind === undefined && value.token === undefined && legacyKeys.length === 2 &&
      legacyKeys[0] === 'at' && legacyKeys[1] === 'pid')
    return Object.freeze({ pid, at, kind: BROKER_FLEET_LOCK_KIND, token: null, legacy: true });
  return null;
}

function withRaw(result, raw = null) {
  if (raw !== null) Object.defineProperty(result, RAW, { value: raw });
  return Object.freeze(result);
}

function protectedResult(path, why, details = {}) {
  const { raw = null, ...visible } = details;
  return withRaw({
    state: 'live', path, reclaimable: false, unverifiable: true, why, ...visible,
  }, raw);
}

function readExact(path) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (missing(error)) return { state: 'free', path };
    return protectedResult(path, `lock metadata cannot be read: ${error.message}`, {
      error_code: error.code ?? null,
    });
  }
  if (stat.isSymbolicLink())
    return protectedResult(path, 'lock path is a symbolic link and will not be followed');
  if (!stat.isFile()) return protectedResult(path, 'lock path is not a regular file');
  if (stat.size > MAX_LOCK_BYTES)
    return protectedResult(path, `lock file exceeds ${MAX_LOCK_BYTES} bytes`);
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) {
    if (missing(error)) return { state: 'free', path };
    return protectedResult(path, `lock cannot be read: ${error.message}`, {
      error_code: error.code ?? null,
    });
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    return protectedResult(path, 'lock is not valid JSON', { raw });
  }
  const lock = lockRecord(parsed);
  if (!lock)
    return protectedResult(path, 'lock is not a valid lab-runtime or broker-runtime claim', { raw });
  return { path, raw, lock };
}

/**
 * Windows-compatible pid liveness. EPERM proves the process exists but cannot be signalled;
 * only ESRCH is positive evidence that it is gone. Unexpected errors fail closed as live.
 */
export function isProcessLive(pid, { kill = process.kill.bind(process) } = {}) {
  if (!safePid(pid)) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    return true;
  }
}

/** Return exactly one of free, live, or stale for an exact absolute lock path. */
export function inspectFleetLock(lockPath, { isPidLive = isProcessLive } = {}) {
  const path = exactPath(lockPath);
  if (typeof isPidLive !== 'function') throw new TypeError('isPidLive must be a function');
  const read = readExact(path);
  if (read.state) return read;
  let live;
  try { live = isPidLive(read.lock.pid); }
  catch (error) {
    return protectedResult(path, `pid ${read.lock.pid} liveness could not be verified: ${error.message}`, {
      lock: read.lock, raw: read.raw,
    });
  }
  if (live === true) return withRaw({
    state: 'live', path, reclaimable: false, lock: read.lock,
    mine: read.lock.pid === process.pid,
  }, read.raw);
  if (live !== false) return protectedResult(path,
    `pid ${read.lock.pid} liveness returned no definite answer`, { lock: read.lock, raw: read.raw });
  for (const guardPid of read.lock.guards ?? []) {
    let guardLive;
    try { guardLive = isPidLive(guardPid); }
    catch (error) {
      return protectedResult(path,
        `guard pid ${guardPid} liveness could not be verified: ${error.message}`,
        { lock: read.lock, raw: read.raw, owner_dead: true, guard_pid: guardPid });
    }
    if (guardLive === true) return withRaw({
      state: 'live', path, reclaimable: false, lock: read.lock,
      mine: false, owner_dead: true, guard_pid: guardPid,
      why: `owner pid ${read.lock.pid} is gone but guarded keeper pid ${guardPid} is running`,
    }, read.raw);
    if (guardLive !== false) return protectedResult(path,
      `guard pid ${guardPid} liveness returned no definite answer`,
      { lock: read.lock, raw: read.raw, owner_dead: true, guard_pid: guardPid });
  }
  return withRaw({
    state: 'stale', path, reclaimable: true, confirmed_dead: true,
    lock: read.lock, why: `pid ${read.lock.pid} is not running`,
  }, read.raw);
}

function restoreProtected(quarantine, path) {
  try {
    copyFileSync(quarantine, path, FS_CONSTANTS.COPYFILE_EXCL);
    unlinkSync(quarantine);
    return true;
  } catch {
    // Never overwrite a contender that already claimed the exact path. Leaving the moved
    // file beside it is safer than deleting a claim we could not identify.
    return false;
  }
}

// Rename first rather than unlinking the active pathname. Two stale reclaimers can then race
// safely: only one moves the old inode; every other contender sees ENOENT or the new claim.
function quarantineStale(path, expected, { isPidLive, tokenFactory }) {
  const latest = inspectFleetLock(path, { isPidLive });
  if (latest.state === 'free') return { retry: true };
  if (latest.state !== 'stale') return { blocked: latest };
  if (expected[RAW] !== latest[RAW]) return { retry: true };

  const quarantine = `${path}.stale-${quarantineSuffix(tokenFactory)}`;
  try { renameSync(path, quarantine); }
  catch (error) {
    if (missing(error) || error?.code === 'EEXIST') return { retry: true };
    return { blocked: protectedResult(path, `stale lock cannot be quarantined: ${error.message}`, {
      error_code: error.code ?? null,
    }) };
  }

  // Re-read and re-check the exact inode that was moved. This is the final liveness check
  // before deletion and catches a replacement that landed between inspection and rename.
  const moved = inspectFleetLock(quarantine, { isPidLive });
  if (moved.state !== 'stale' || moved[RAW] !== latest[RAW]) {
    const restored = restoreProtected(quarantine, path);
    return { blocked: {
      ...(moved.state ? moved : protectedResult(path, 'quarantined lock changed during reclaim')),
      path, restored,
    } };
  }
  try { unlinkSync(quarantine); }
  catch {
    // It is no longer at the authoritative path. A quarantine remnant is harmless and must
    // not turn a safely available lab runtime into a permanent refusal.
  }
  return { removed: true, stale: latest };
}

function writeClaim(path, record) {
  writeFileSync(path, JSON.stringify(record), {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  });
}

function guardedAdoptionMatches(found, option, nextRecord) {
  if (!option || nextRecord.kind !== BROKER_FLEET_LOCK_KIND || found.state !== 'live' ||
      found.unverifiable || found.owner_dead !== true ||
      found.lock?.kind !== BROKER_FLEET_LOCK_KIND ||
      !Array.isArray(found.lock.guards) || !found.lock.guards.length) return false;
  // Account claims bind the human-readable actor slot as well as the hashed endpoint/account
  // pathname. A roster rename must not silently relabel a surviving keeper that will still
  // answer /health under its predecessor actor id. Fleet claims have no subject field.
  if (found.lock.subject !== nextRecord.subject)
    return false;
  if (option === true) return true;
  if (!option || typeof option !== 'object' || Array.isArray(option)) return false;
  const previousPids = predecessorPids(
    option.previousPids ?? (option.previousPid == null ? null : [option.previousPid]),
    { optional: false },
  );
  const allowedGuards = guardPids(option.guardPids, { optional: false });
  return previousPids !== false && previousPids.includes(found.lock.pid) && allowedGuards !== false &&
    found.lock.guards.every(pid => allowedGuards.includes(pid));
}

function unguardedTakeoverMatches(found, option) {
  if (option === true) return true;
  return !!option && typeof option === 'object' && !Array.isArray(option) &&
    safePid(option.previousPid) === found.lock?.pid;
}

function replaceGuardedOwner(path, expected, record) {
  const expectedRaw = expected?.[RAW] ?? expected?.raw;
  if (typeof expectedRaw !== 'string')
    return { ok: false, reason: 'missing-expected-bytes' };
  let fd;
  try { fd = openSync(path, 'r+'); }
  catch (error) { return { ok: false, retry: missing(error), reason: 'open-failed' }; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_LOCK_BYTES)
      return { ok: false, reason: 'invalid-lock-file' };
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const raw = bytes.subarray(0, offset).toString('utf8');
    if (raw !== expectedRaw) return { ok: false, retry: true, reason: 'ownership-changed' };
    const output = Buffer.from(JSON.stringify(record));
    if (output.length > MAX_LOCK_BYTES) return { ok: false, reason: 'encoded-lock-too-large' };
    let written = 0;
    while (written < output.length)
      written += writeSync(fd, output, written, output.length - written, written);
    ftruncateSync(fd, output.length);
    fsyncSync(fd);
  } catch (error) {
    return { ok: false, reason: 'update-failed', error_code: error?.code ?? null };
  } finally {
    try { closeSync(fd); } catch {}
  }
  const verified = readExact(path);
  const ok = !verified.state && verified.lock.pid === record.pid &&
    verified.lock.token === record.token && verified.lock.kind === record.kind &&
    verified.lock.subject === record.subject &&
    JSON.stringify(verified.lock.guards) === JSON.stringify(record.guards) &&
    JSON.stringify(verified.lock.predecessors) === JSON.stringify(record.predecessors);
  return ok ? { ok: true } : { ok: false, reason: 'verify-failed' };
}

function adoptGuardedClaim(path, found, record, options) {
  const gatePath = `${path}.adopt.lock`;
  const gate = claimFleetLock(gatePath, {
    pid: record.pid,
    kind: FLEET_LOCK_KIND,
    token: randomUUID(),
    tokenFactory: options.tokenFactory,
    isPidLive: options.isPidLive,
    attempts: options.attempts,
  });
  if (!gate.ok) return { ok: false, blocked: found, gate: gate.found };
  try {
    const latest = inspectFleetLock(path, { isPidLive: options.isPidLive });
    if (!guardedAdoptionMatches(latest, options.adoptGuardedBroker, record))
      return { ok: false, blocked: latest };
    const predecessors = predecessorPids([
      latest.lock.pid,
      ...(latest.lock.predecessors ?? []),
    ], { optional: false });
    if (predecessors === false)
      return { ok: false, blocked: protectedResult(path, 'broker adoption lineage is full') };
    const adoptedRecord = Object.freeze({
      ...record,
      guards: latest.lock.guards,
      predecessors,
    });
    const replaced = replaceGuardedOwner(path, latest, adoptedRecord);
    if (!replaced.ok) return { ok: false, retry: replaced.retry === true,
      blocked: inspectFleetLock(path, { isPidLive: options.isPidLive }) };
    return { ok: true, record: adoptedRecord, from: latest };
  } finally {
    gate.release();
  }
}

/**
 * Atomically claim a free/stale lab-runtime lock.
 *
 * Returns `{ ok:true, lock, release }`, or `{ ok:false, found }` when a live or
 * unverifiable holder remains. The exclusive create is the authority; inspection is only
 * used to decide whether a pre-existing valid dead claim may be quarantined.
 */
export function claimFleetLock(lockPath, {
  pid = process.pid,
  now = Date.now,
  token = randomUUID(),
  kind = FLEET_LOCK_KIND,
  tokenFactory = randomUUID,
  isPidLive = isProcessLive,
  attempts = 8,
  guards = null,
  subject = null,
  allowUnguardedBrokerTakeover = false,
  adoptGuardedBroker = false,
} = {}) {
  const path = exactPath(lockPath);
  const ownerPid = safePid(pid);
  const ownerToken = safeToken(token);
  const ownerKind = claimKind(kind);
  const ownerGuards = guardPids(guards);
  const ownerSubject = claimSubject(subject);
  if (!ownerPid) throw new TypeError('pid must be a positive safe integer');
  if (!ownerToken) throw new TypeError('token must be an 8-256 character string');
  if (!ownerKind) throw new TypeError('kind must be lab-runtime or broker-runtime');
  if (ownerGuards === false) throw new TypeError(`guards must contain at most ${MAX_GUARD_PIDS} unique positive pids`);
  if (ownerSubject === false)
    throw new TypeError('subject must be a non-empty 1-128 character string without control characters');
  if (typeof now !== 'function' || typeof tokenFactory !== 'function')
    throw new TypeError('now and tokenFactory must be functions');
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 100)
    throw new RangeError('attempts must be between 1 and 100');
  const at = now();
  if (!Number.isSafeInteger(at) || at < 0) throw new TypeError('now() must return a non-negative safe integer');
  const record = Object.freeze({
    pid: ownerPid, at, kind: ownerKind, token: ownerToken,
    ...(ownerSubject !== null ? { subject: ownerSubject } : {}),
    ...(ownerGuards !== null ? { guards: ownerGuards } : {}),
  });
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_LOCK_BYTES)
    throw new RangeError(`encoded lock must not exceed ${MAX_LOCK_BYTES} bytes`);
  let tookOverFrom = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const found = inspectFleetLock(path, { isPidLive });
    if (found.state === 'live') {
      if (guardedAdoptionMatches(found, adoptGuardedBroker, record)) {
        const adopted = adoptGuardedClaim(path, found, record, {
          tokenFactory, isPidLive, attempts, adoptGuardedBroker,
        });
        if (adopted.retry) continue;
        if (!adopted.ok) return Object.freeze({ ok: false, path, found: adopted.blocked });
        const release = () => releaseFleetLock(path, {
          pid: ownerPid, token: ownerToken, kind: ownerKind, tokenFactory, isPidLive,
        });
        return Object.freeze({
          ok: true, path, lock: adopted.record, release,
          took_over_from: adopted.from,
          adopted_guarded: true,
        });
      }
      return Object.freeze({ ok: false, path, found });
    }
    if (found.state === 'stale') {
      // Broker records predating keeper guards cannot prove that the broker's child
      // sockets died with it. Refuse automatic takeover until an operator has explicitly
      // checked/stopped orphan keepers and enables the recovery override.
      if (found.lock?.kind === BROKER_FLEET_LOCK_KIND &&
          !Object.hasOwn(found.lock, 'guards') &&
          !unguardedTakeoverMatches(found, allowUnguardedBrokerTakeover)) {
        return Object.freeze({
          ok: false,
          path,
          found: Object.freeze({
            ...found,
            reclaimable: false,
            unguarded_broker: true,
            why: `broker pid ${found.lock.pid} is gone but its record predates keeper guards; ` +
              'orphan sockets must be ruled out before takeover',
          }),
        });
      }
      const reclaimed = quarantineStale(path, found, { isPidLive, tokenFactory });
      if (reclaimed.blocked) return Object.freeze({ ok: false, path, found: reclaimed.blocked });
      if (reclaimed.retry) continue;
      tookOverFrom = reclaimed.stale;
    }
    try { writeClaim(path, record); }
    catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
    const release = () => releaseFleetLock(path, {
      pid: ownerPid, token: ownerToken, kind: ownerKind, tokenFactory, isPidLive,
    });
    return Object.freeze({
      ok: true, path, lock: record, release,
      ...(tookOverFrom ? { took_over_from: tookOverFrom } : {}),
    });
  }
  return Object.freeze({
    ok: false, path,
    found: inspectFleetLock(path, { isPidLive }),
    why: `lock changed during ${attempts} claim attempts`,
  });
}

/** Add a child/keeper pid to a token claim through its already-open inode. */
export function addFleetLockGuard(lockPath, {
  pid = process.pid,
  token,
  kind,
  guardPid,
  isPidLive = isProcessLive,
} = {}) {
  const path = exactPath(lockPath);
  const ownerPid = safePid(pid);
  const ownerToken = safeToken(token);
  const ownerKind = claimKind(kind);
  const childPid = safePid(guardPid);
  if (!ownerPid || !ownerToken || !ownerKind || !childPid)
    throw new TypeError('guard update requires valid owner pid, token, kind, and guardPid');
  if (typeof isPidLive !== 'function') throw new TypeError('isPidLive must be a function');

  let fd;
  try { fd = openSync(path, 'r+'); }
  catch (error) {
    return Object.freeze({ ok: false, path, reason: missing(error) ? 'free' : 'open-failed' });
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_LOCK_BYTES)
      return Object.freeze({ ok: false, path, reason: 'invalid-lock-file' });
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!read) break;
      offset += read;
    }
    const raw = bytes.subarray(0, offset).toString('utf8');
    let lock;
    try { lock = lockRecord(JSON.parse(raw)); } catch { lock = null; }
    if (!lock || lock.pid !== ownerPid || lock.token !== ownerToken || lock.kind !== ownerKind)
      return Object.freeze({ ok: false, path, reason: 'ownership-mismatch' });
    if (!Object.hasOwn(lock, 'guards'))
      return Object.freeze({ ok: false, path, reason: 'guard-protocol-missing' });
    const retained = [];
    for (const oldPid of lock.guards) {
      if (oldPid === childPid) { retained.push(oldPid); continue; }
      let live;
      try { live = isPidLive(oldPid); } catch { live = undefined; }
      // Only a definite dead result permits pruning. PID reuse or uncertain permission
      // errs toward retaining the guard and therefore refusing a future takeover.
      if (live !== false) retained.push(oldPid);
    }
    if (retained.includes(childPid) && retained.length === lock.guards.length)
      return Object.freeze({ ok: true, path, added: false, lock });
    if (!retained.includes(childPid)) retained.push(childPid);
    if (retained.length > MAX_GUARD_PIDS)
      return Object.freeze({ ok: false, path, reason: 'guard-limit' });

    const guards = guardPids(retained, { optional: false });
    const next = Object.freeze({
      pid: lock.pid, at: lock.at, kind: lock.kind, token: lock.token, guards,
      ...(lock.subject ? { subject: lock.subject } : {}),
      ...(lock.predecessors ? { predecessors: lock.predecessors } : {}),
    });
    const output = Buffer.from(JSON.stringify(next));
    if (output.length > MAX_LOCK_BYTES)
      return Object.freeze({ ok: false, path, reason: 'encoded-lock-too-large' });
    let written = 0;
    while (written < output.length)
      written += writeSync(fd, output, written, output.length - written, written);
    ftruncateSync(fd, output.length);
    fsyncSync(fd);
  } catch (error) {
    return Object.freeze({ ok: false, path, reason: 'update-failed', error_code: error?.code ?? null });
  } finally {
    try { closeSync(fd); } catch {}
  }
  const verified = inspectFleetLock(path);
  const ok = verified.lock?.pid === ownerPid && verified.lock?.token === ownerToken &&
    verified.lock?.kind === ownerKind && verified.lock?.guards?.includes(childPid);
  return Object.freeze({ ok, path, added: ok, ...(ok ? { lock: verified.lock } : { reason: 'verify-failed' }) });
}

/**
 * Finish a successful guarded takeover by removing its bounded crash-recovery lineage.
 * The lineage exists only while account claims may be split across predecessor broker
 * pids. It is cleared after the caller owns every account, so ordinary restarts cannot
 * grow the record forever. Only the exact current pid+token owner may clear it.
 */
export function finalizeFleetLockAdoption(lockPath, {
  pid = process.pid,
  token,
  kind,
} = {}) {
  const path = exactPath(lockPath);
  const ownerPid = safePid(pid);
  const ownerToken = safeToken(token);
  const ownerKind = claimKind(kind);
  if (!ownerPid || !ownerToken || !ownerKind)
    throw new TypeError('adoption finalization requires valid owner pid, token, and kind');

  const before = readExact(path);
  if (before.state === 'free')
    return Object.freeze({ ok: false, path, reason: 'free' });
  if (before.state || before.lock.pid !== ownerPid || before.lock.token !== ownerToken ||
      before.lock.kind !== ownerKind)
    return Object.freeze({ ok: false, path, reason: 'ownership-mismatch' });
  if (!Object.hasOwn(before.lock, 'predecessors'))
    return Object.freeze({ ok: true, path, finalized: false, lock: before.lock });

  const next = Object.freeze({
    pid: before.lock.pid,
    at: before.lock.at,
    kind: before.lock.kind,
    token: before.lock.token,
    ...(before.lock.subject ? { subject: before.lock.subject } : {}),
    ...(Object.hasOwn(before.lock, 'guards') ? { guards: before.lock.guards } : {}),
  });
  const replaced = replaceGuardedOwner(path, before, next);
  if (!replaced.ok)
    return Object.freeze({ ok: false, path, reason: replaced.reason,
      ...(replaced.error_code ? { error_code: replaced.error_code } : {}) });
  return Object.freeze({ ok: true, path, finalized: true, lock: next });
}

/** Verify the exact token claim names this child before it is allowed to open a socket. */
export function verifyFleetLockGuard(lockPath, {
  pid,
  token,
  kind,
  subject = null,
  guardPid = process.pid,
  isPidLive = isProcessLive,
} = {}) {
  const path = exactPath(lockPath);
  const found = inspectFleetLock(path, { isPidLive });
  const expectedSubject = subject === null ? null : claimSubject(subject, { optional: false });
  const ok = found.lock?.pid === safePid(pid) && found.lock?.token === safeToken(token) &&
    found.lock?.kind === claimKind(kind) &&
    (expectedSubject === null || expectedSubject !== false && found.lock?.subject === expectedSubject) &&
    found.lock?.guards?.includes(safePid(guardPid));
  return Object.freeze({ ok, path, found, ...(ok ? {} : { reason: 'guard-not-held' }) });
}

/** Idempotently release only a matching token claim with no live keeper guards. */
export function releaseFleetLock(lockPath, {
  pid = process.pid,
  token,
  kind = null,
  tokenFactory = randomUUID,
  isPidLive = isProcessLive,
} = {}) {
  const path = exactPath(lockPath);
  const ownerPid = safePid(pid);
  const ownerToken = safeToken(token);
  const ownerKind = kind === null ? null : claimKind(kind);
  if (!ownerPid || !ownerToken) throw new TypeError('release requires a valid pid and token');
  if (kind !== null && !ownerKind) throw new TypeError('release kind must be lab-runtime or broker-runtime');
  if (typeof tokenFactory !== 'function') throw new TypeError('tokenFactory must be a function');
  if (typeof isPidLive !== 'function') throw new TypeError('isPidLive must be a function');

  const before = readExact(path);
  if (before.state === 'free') return Object.freeze({ released: false, path, reason: 'free' });
  if (before.state || before.lock.pid !== ownerPid || before.lock.token !== ownerToken ||
      (ownerKind && before.lock.kind !== ownerKind))
    return Object.freeze({ released: false, path, reason: 'ownership-mismatch' });
  for (const guardPid of before.lock.guards ?? []) {
    let live;
    try { live = isPidLive(guardPid); } catch { live = undefined; }
    if (live !== false) return Object.freeze({
      released: false, path,
      reason: live === true ? 'live-guard' : 'guard-liveness-uncertain',
      guard_pid: guardPid,
    });
  }

  const quarantine = `${path}.release-${quarantineSuffix(tokenFactory)}`;
  try { renameSync(path, quarantine); }
  catch (error) {
    if (missing(error)) return Object.freeze({ released: false, path, reason: 'free' });
    return Object.freeze({ released: false, path, reason: 'rename-failed', error_code: error.code ?? null });
  }
  const moved = readExact(quarantine);
  const stillOurs = !moved.state && moved.raw === before.raw && moved.lock.pid === ownerPid &&
    moved.lock.token === ownerToken && (!ownerKind || moved.lock.kind === ownerKind);
  if (!stillOurs) {
    const restored = restoreProtected(quarantine, path);
    return Object.freeze({ released: false, path, reason: 'ownership-changed', restored });
  }
  try { unlinkSync(quarantine); }
  catch (error) {
    return Object.freeze({ released: true, path, quarantine, cleanup_error: error.code ?? error.message });
  }
  return Object.freeze({ released: true, path });
}
