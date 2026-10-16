// m59-interest-store.mjs — the fleet's wants / needs / spare board, shared by keeper processes.
//
// `skills.interest` was written when every keeper ran inside the broker, and its own comment says
// so: "a process-wide board ... every keeper in this broker writes what it is short of". Production
// now runs one keeper per OS process (m59-keeper-process.mjs), so that Map held exactly ONE entry in
// each keeper — its own — and the broker's copy was empty because the broker runs no autopilot.
// Everything that read the aggregate was quietly reading nothing:
//
//   - the sell path's "somebody else wants this" hold (anyoneWants) never held anything back;
//   - farm delivery's demandsNear never saw a farmer but the courier itself;
//   - nothing could ever hand a service desk the reagents it ran out of (operator, 2026-10-16:
//     "the flow should go straight from the first time Loial runs out of reagents to being fully
//     supplied by anyone else in the map/area that doesn't need their reagents").
//
// So each keeper publishes its declaration to ONE small file of its own, written atomically, and
// reads everyone else's back through a short cache. Same shape and same scoping as the wall
// reservations in m59-spotclaims.mjs: scoped to the roster AND the game endpoint, hidden runtime
// state under substrate/, and no broker or game connection involved.
//
// GIFT CLAIMS ride in the same directory: one `wx` lock per (needer, kind), so a desk that runs out
// of emeralds in a room of six farmers gets one courier, not six.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync,
         writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
const CACHE_MS = 5_000;
let store = null;           // { path }
let cache = null;           // { at, rows }

/** Point the store at a directory. Without it, every function here is a no-op and reads []. */
export function configureInterestStore({ directory, namespace = 'default', enabled = true } = {}) {
  cache = null;
  if (!enabled || !directory) { store = null; return null; }
  // The namespace is hashed at the filesystem boundary: it may come from an environment variable.
  const path = join(resolve(String(directory)), `v1-${hash(namespace)}`);
  mkdirSync(path, { recursive: true });
  store = { path };
  return { path };
}

export const interestStoreEnabled = () => !!store;

/**
 * Publish one keeper's declaration. Written to a temporary file and renamed over the old one, so a
 * reader never sees half of it. A failed write is reported, never thrown: the board is advice.
 */
export function writeDeclaration(agent, rec = {}) {
  if (!store || !agent) return false;
  const file = join(store.path, `${hash(agent)}.json`);
  const body = JSON.stringify({ ...rec, agent: String(agent), at: rec.at ?? Date.now() });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, body);
    try { renameSync(tmp, file); }
    // Windows refuses a rename over a file another process has open for reading. The direct write
    // is not atomic, which the reader tolerates: a torn file fails to parse and is skipped.
    catch { writeFileSync(file, body); try { unlinkSync(tmp); } catch {} }
    cache = null;
    return true;
  } catch { return false; }
}

/** Remove one keeper's declaration (a keeper that stops should not leave a want behind). */
export function forgetDeclaration(agent) {
  if (!store || !agent) return false;
  try { unlinkSync(join(store.path, `${hash(agent)}.json`)); cache = null; return true; }
  catch { return false; }
}

/**
 * Every fresh declaration on the board. Cached for a few seconds: the keeper loop reads this every
 * pass, and the answer is about where people were a moment ago anyway. A stale entry is dropped
 * rather than trusted — a want from a keeper that died is not a want.
 */
export function readDeclarations({ now = Date.now(), maxAgeMs = 180_000 } = {}) {
  if (!store) return [];
  if (!cache || now - cache.at > CACHE_MS) {
    const rows = [];
    let names = [];
    try { names = readdirSync(store.path); } catch { names = []; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(readFileSync(join(store.path, name), 'utf8'));
        if (rec && rec.agent) rows.push(rec);
      } catch { /* torn or foreign file: skipped */ }
    }
    cache = { at: now, rows };
  }
  return cache.rows.filter(r => Number.isFinite(Number(r.at)) && now - Number(r.at) <= maxAgeMs);
}

// ------------------------------------------------------------------------------ gift claims

const claimFile = (needer, kind) => join(store.path, `gift-${hash(`${needer}|${String(kind).toLowerCase()}`)}.claim`);

/**
 * Claim the right to give `needer` some `kind`. True when this giver holds the claim (newly, or
 * still). A claim older than `ttlMs` belongs to nobody: a giver that died mid-walk must not block
 * the desk for ever. Without a configured store the claim is always granted — the in-process
 * world has one keeper per needer anyway.
 */
export function claimGift(giver, needer, kind, { ttlMs = 10 * 60_000, now = Date.now() } = {}) {
  if (!store) return true;
  const file = claimFile(needer, kind);
  const mine = JSON.stringify({ giver: String(giver), needer: String(needer), kind: String(kind), at: now });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      try { writeSync(fd, mine); } finally { closeSync(fd); }
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
      let held = null;
      try { held = JSON.parse(readFileSync(file, 'utf8')); } catch { held = null; }
      if (held && held.giver === String(giver)) {
        try { writeFileSync(file, mine); } catch {}
        return true;
      }
      // Unreadable or expired: take it over on the second attempt.
      if (!held || now - Number(held.at) > ttlMs) { try { unlinkSync(file); } catch {} continue; }
      return false;
    }
  }
  return false;
}

/** Give the claim back. Only its holder may. */
export function releaseGift(giver, needer, kind) {
  if (!store) return false;
  const file = claimFile(needer, kind);
  try {
    const held = JSON.parse(readFileSync(file, 'utf8'));
    if (held?.giver !== String(giver)) return false;
    unlinkSync(file);
    return true;
  } catch { return false; }
}

/** Tests only: forget the cache so a write from "another process" is read at once. */
export function _clearInterestCache() { cache = null; }
