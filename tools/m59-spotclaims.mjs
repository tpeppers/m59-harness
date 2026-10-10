// m59-spotclaims.mjs — Atomic wall reservations shared by keeper processes.
//
// Production runs one keeper per OS process. An in-memory Map therefore cannot stop two
// characters from choosing the same deterministic safe square before either walk lands.
// This store keeps one tiny claim file per character behind an atomic `wx` lock. The lock
// makes "count occupants, then reserve" one operation; the claim file makes the result
// visible to every keeper without involving the broker or the game connection.

import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const PROCESS_STARTED_AT = Date.now();
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const LOCK_TIMEOUT_MS = 3_000;
const BROKEN_LOCK_MS = 5_000;
let sequence = 0;
let explicitConfiguration = null;
const ownPartners = new Map();

const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 20);

// A fleet file alone is not a namespace: the same roster can point at two servers, and
// two fleets can use the same character handles on different servers. Conversely every
// keeper for one fleet/server pair must derive exactly the same directory.
export function spotClaimNamespace({ fleetPath = '', host = '', port = '' } = {}) {
  return hash(JSON.stringify({
    fleet: fleetPath ? resolve(String(fleetPath)).toLowerCase() : '',
    host: String(host).trim().toLowerCase(),
    port: Number(port) || 0,
  }));
}

export function configureSpotClaimStore({ directory, namespace, enabled = true } = {}) {
  explicitConfiguration = enabled ? {
    directory: resolve(String(directory || join('substrate', '.spot-claims'))),
    namespace: String(namespace || 'default'),
  } : { disabled: true };
  const cfg = configuration();
  if (cfg) mkdirSync(cfg.path, { recursive: true });
  return cfg ? { directory: cfg.directory, namespace: cfg.namespace, path: cfg.path } : null;
}

function configuration() {
  if (explicitConfiguration?.disabled) return null;
  const configured = explicitConfiguration ?? (() => {
    const directory = String(process.env.M59_SPOT_CLAIMS_DIR || '').trim();
    if (!directory) return null;       // ordinary imports/tests retain the in-memory APIs
    return {
      directory: resolve(directory),
      namespace: String(process.env.M59_SPOT_CLAIMS_NAMESPACE || 'default'),
    };
  })();
  if (!configured) return null;
  // Hash the namespace again at the filesystem boundary. It may have come from an
  // environment variable, so it must never be able to name a parent directory.
  return { ...configured, path: join(configured.directory, `v1-${hash(configured.namespace)}`) };
}

export const fileSpotClaimsEnabled = () => !!configuration();

function pidAlive(pid) {
  pid = Number(pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }
}

function remove(path) {
  try { unlinkSync(path); return true; }
  catch (e) { if (e?.code !== 'ENOENT') throw e; return false; }
}

function lockOwner(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function clearAbandonedLock(path) {
  const owner = lockOwner(path);
  if (owner?.pid && !pidAlive(owner.pid)) return remove(path);
  if (owner) return false;
  // There is a few-byte interval between `open(wx)` and writing the owner. Only a lock
  // that has stayed unreadable for seconds is abandoned; a current writer is left alone.
  try {
    if (Date.now() - statSync(path).mtimeMs > BROKEN_LOCK_MS) return remove(path);
  } catch (e) {
    if (e?.code === 'ENOENT') return true;
    throw e;
  }
  return false;
}

function withLock(fn) {
  const cfg = configuration();
  if (!cfg) throw new Error('file spot claims are not configured');
  mkdirSync(cfg.path, { recursive: true });
  const path = join(cfg.path, '.claims.lock');
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = null;
  while (fd == null) {
    try {
      fd = openSync(path, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, process_started_at: PROCESS_STARTED_AT }));
      fsyncSync(fd);
    } catch (e) {
      if (fd != null) { try { closeSync(fd); } catch {} fd = null; remove(path); }
      if (e?.code !== 'EEXIST') throw e;
      clearAbandonedLock(path);
      if (Date.now() >= deadline)
        throw new Error(`wall claim store stayed locked for ${LOCK_TIMEOUT_MS}ms`);
      Atomics.wait(LOCK_WAIT, 0, 0, 5);
    }
  }
  try { return fn(cfg.path); }
  finally {
    try { closeSync(fd); } catch {}
    remove(path);
  }
}

function writeExclusive(dir, kind, agent, record) {
  const name = `${kind}-${process.pid}-${hash(agent)}-${Date.now()}-${++sequence}.json`;
  const path = join(dir, name);
  let fd = null, complete = false;
  try {
    fd = openSync(path, 'wx');
    writeFileSync(fd, JSON.stringify(record));
    fsyncSync(fd);
    complete = true;
  } finally {
    if (fd != null) try { closeSync(fd); } catch {}
    if (!complete) remove(path);
  }
  return { path, name };
}

function records(dir, prefix) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix + '-') || !entry.name.endsWith('.json'))
      continue;
    const path = join(dir, entry.name);
    let value;
    try { value = JSON.parse(readFileSync(path, 'utf8')); }
    catch {
      const pid = Number(entry.name.split('-')[1]);
      if (!pidAlive(pid)) { remove(path); continue; }
      // An unreadable record owned by a live process means the store is not safe to use.
      // Failing closed is preferable to sending two characters to the same wall.
      throw new Error(`live wall claim record is unreadable: ${entry.name}`);
    }
    if (!value?.agent || !pidAlive(value.pid)) { remove(path); continue; }
    out.push({ ...value, _path: path, _name: entry.name });
  }

  // A process can die between creating its new claim and deleting its old one. Keep the
  // newest complete record, which makes the create-before-delete move crash-safe.
  const newest = new Map();
  for (const value of out) {
    const old = newest.get(value.agent);
    const at = Number(value.updated_at ?? value.claimed_at ?? 0);
    const oldAt = Number(old?.updated_at ?? old?.claimed_at ?? 0);
    if (!old || at > oldAt || (at === oldAt && value._name > old._name)) {
      if (old) remove(old._path);
      newest.set(value.agent, value);
    } else remove(value._path);
  }
  return [...newest.values()];
}

const stripPrivate = value => Object.fromEntries(
  Object.entries(value).filter(([key]) => !key.startsWith('_')));

function writeParticipantUnlocked(dir, agent, partner) {
  const all = records(dir, 'participant');
  const current = all.find(r => r.agent === agent);
  const normalized = partner ? String(partner) : null;
  if (current?.pid === process.pid && (current.partner ?? null) === normalized) return current;
  const now = Date.now();
  const made = {
    version: 1, agent: String(agent), partner: normalized,
    pid: process.pid, process_started_at: PROCESS_STARTED_AT, updated_at: now,
  };
  const file = writeExclusive(dir, 'participant', agent, made);
  for (const old of all) if (old.agent === agent) remove(old._path);
  return { ...made, _path: file.path, _name: file.name };
}

// Publish the relationship separately from a wall. A keeper already holding a square can
// be paired later; the next selector must see that change without making it abandon/re-take
// the wall merely to refresh metadata.
export function rememberFileSpotPartner(agent, partner = null) {
  if (!agent) return false;
  ownPartners.set(String(agent), partner ? String(partner) : null);
  if (!fileSpotClaimsEnabled()) return false;
  withLock(dir => writeParticipantUnlocked(dir, String(agent), partner));
  return true;
}

function snapshotUnlocked(dir) {
  const claims = records(dir, 'claim');
  const participants = records(dir, 'participant');
  return { claims, participants };
}

export function fileSpotClaimSnapshot() {
  return withLock(snapshotUnlocked);
}

function participantOf(snapshot, agent) {
  const row = snapshot.participants.find(r => r.agent === agent);
  if (row) return row;
  const claim = snapshot.claims.find(r => r.agent === agent);
  return claim ? { agent, partner: claim.partner ?? null } : null;
}

function recordedPartners(snapshot, a, b) {
  const ar = participantOf(snapshot, a), br = participantOf(snapshot, b);
  return ar?.partner === b && br?.partner === a;
}

function mayShare(snapshot, a, b, callback) {
  try { if (callback?.(a, b)) return true; } catch {}
  return recordedPartners(snapshot, a, b);
}

function occupants(snapshot, room, col, row) {
  room = Number(room); col = Number(col); row = Number(row);
  return snapshot.claims.filter(r =>
    Number(r.room) === room && Number(r.col) === col && Number(r.row) === row);
}

export function fileSpotOccupancy(agent, room, col, row,
                                  { snapshot = null, mayShare: share = null } = {}) {
  snapshot ??= fileSpotClaimSnapshot();
  return occupants(snapshot, room, col, row)
    .filter(r => r.agent !== agent && !mayShare(snapshot, String(agent), r.agent, share)).length;
}

export function fileSpotTakenByAnother(agent, room, col, row, cap = 1,
                                       { snapshot = null, mayShare: share = null } = {}) {
  snapshot ??= fileSpotClaimSnapshot();
  const blocked = occupants(snapshot, room, col, row)
    .filter(r => r.agent !== agent && !mayShare(snapshot, String(agent), r.agent, share));
  const limit = Number.isFinite(Number(cap)) ? Math.max(1, Math.floor(Number(cap))) : Infinity;
  if (blocked.length < limit) return null;
  return blocked[0]?.agent ?? 'another keeper';
}

export function claimFileSpot(agent, room, col, row,
                              { cap = Infinity, partner = undefined, mayShare: share = null } = {}) {
  if (!fileSpotClaimsEnabled()) return null;
  agent = String(agent);
  if (partner !== undefined) ownPartners.set(agent, partner ? String(partner) : null);
  return withLock(dir => {
    if (partner !== undefined || ownPartners.has(agent))
      writeParticipantUnlocked(dir, agent, ownPartners.get(agent) ?? null);
    const snapshot = snapshotUnlocked(dir);
    const mine = snapshot.claims.find(r => r.agent === agent);
    if (mine && Number(mine.room) === Number(room) && Number(mine.col) === Number(col) &&
        Number(mine.row) === Number(row)) return true;

    const limit = Number.isFinite(Number(cap)) ? Math.max(1, Math.floor(Number(cap))) : Infinity;
    const occupied = occupants(snapshot, room, col, row)
      .filter(r => r.agent !== agent && !mayShare(snapshot, agent, r.agent, share));
    if (occupied.length >= limit) return false;

    const now = Date.now();
    const made = {
      version: 1, agent, partner: ownPartners.get(agent) ?? null,
      room: Number(room), col: Number(col), row: Number(row),
      pid: process.pid, process_started_at: PROCESS_STARTED_AT,
      claimed_at: now, updated_at: now,
    };
    const file = writeExclusive(dir, 'claim', agent, made);
    // Create first, release the old square second. A crash can temporarily leave two
    // complete records, but the next reader deterministically keeps this newer one.
    for (const old of snapshot.claims) if (old.agent === agent) remove(old._path);
    return !!file;
  });
}

export function releaseFileSpot(agent) {
  if (!fileSpotClaimsEnabled()) return null;
  return withLock(dir => {
    let released = 0;
    for (const old of records(dir, 'claim')) {
      if (old.agent !== String(agent)) continue;
      if (remove(old._path)) released++;
    }
    return released;
  });
}

export function fileClaimedSpotList({ snapshot = null } = {}) {
  snapshot ??= fileSpotClaimSnapshot();
  return snapshot.claims.map(r => ({ at: `${r.room}:${r.col},${r.row}`, agent: r.agent }));
}

export function fileSpotHeldBy(agent, { snapshot = null } = {}) {
  snapshot ??= fileSpotClaimSnapshot();
  const r = snapshot.claims.find(x => x.agent === String(agent));
  return r ? { room: Number(r.room), col: Number(r.col), row: Number(r.row) } : null;
}

// Passage claims use the same fleet/server namespace and atomic store as walls.
// No timeout can evict a live body from a passage. Only its owner releases it
// after a confirmed exit; dead-process claims are removed by records().
export function reserveFilePassage(agent, room, zone) {
  if (!fileSpotClaimsEnabled()) return null;
  return withLock(dir => {
    const all = records(dir, 'passage');
    const conflict = all.find(r => r.room === room && r.zone === zone && r.agent !== String(agent));
    if (conflict) return { ok: false, agent: conflict.agent };
    const own = all.find(r => r.agent === String(agent));
    if (own?.room === room && own.zone === zone) return { ok: true };
    if (own) return { ok: false, reason: 'passage_exit_unconfirmed' };
    writeExclusive(dir, 'passage', String(agent), { agent: String(agent), room, zone,
      pid: process.pid, updated_at: Date.now() });
    return { ok: true };
  });
}
export function releaseFilePassage(agent) {
  if (!fileSpotClaimsEnabled()) return null;
  return withLock(dir => {
    for (const r of records(dir, 'passage'))
      if (r.agent === String(agent) && r.pid === process.pid) remove(r._path);
    return true;
  });
}
