// THE KEEP-OFF LOCK: A SWARM TARGET WHO LOGS OFF IS WAITED FOR, AND RUSHED WHEN HE COMES BACK.
//
// Operator, 2026-09-30: "if a swarm mode target logs off ... one or more characters will by default
// wait at the logoff ghost to attack them when they log back in. Any swarm characters not currently
// doing PvP fighting will similarly rush over to attack the logging in player that was previously
// attacked by the swarm, a sort of 'keep off'-lock".
//
//   substrate/keepoff-<fleet>.json   (this machine's; gitignored -- it names other players)
//   { "format": "m59-keepoff/1",
//     "locks": { "<name, lower>": { name, room, row, col, locked_at, offline, offline_at, online_at,
//                                    waiters: { <agent>: <heartbeat ms> }, cleared, cleared_why } } }
//
// HOW A LOGOFF IS TOLD FROM A DEATH OR A WALK. The player object leaves the room in all three. Only
// a logoff also takes the name off the server-wide player list (BP_PLAYER_REMOVE, the "who" list,
// which every client receives for every player) and leaves a logoff ghost where he stood. The
// keeper checks the list; the ghost, when it can see one, refines the square.
//
// WHY A NAME AND NEVER AN ID. The player comes back as a new object; ids recycle within hours.
//
// Every keeper holds this file, so writes are read-modify-write with an atomic rename. Two keepers
// claiming the last waiter slot in the same instant can both win: an extra waiter, never none.
import { readFileSync, writeFileSync, renameSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..', '..');

export const KEEPOFF_FILE = () => {
  if (process.env.M59_KEEPOFF_FILE) return process.env.M59_KEEPOFF_FILE;
  let name = null;
  try { name = fleetName(); } catch { name = null; }
  return join(HERE, 'substrate', name ? `keepoff-${name}.json` : 'keepoff.json');
};

// A lock lasts this long after it was last renewed by a logoff (config: keepoff_ms).
export const KEEPOFF_MS = 3 * 60 * 60_000;
// A waiter that has not renewed its slot in this long is presumed gone (keeper restarted, died).
export const WAITER_STALE_MS = 90_000;
export const WAITER_HEARTBEAT_MS = 20_000;

export const norm = n => String(n ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const EMPTY = () => ({ format: 'm59-keepoff/1', locks: {} });

let cache = { file: null, mtime: -1, checked: 0, value: EMPTY() };
function read({ fresh = false } = {}) {
  const file = KEEPOFF_FILE(), now = Date.now();
  if (!fresh && cache.file === file && now - cache.checked < 200) return cache.value;
  cache.checked = now;
  let mtime = 0;
  try { mtime = existsSync(file) ? statSync(file).mtimeMs : 0; } catch { mtime = 0; }
  if (cache.file === file && cache.mtime === mtime) return cache.value;
  let value = EMPTY();
  if (mtime) try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw && typeof raw.locks === 'object') value = { ...EMPTY(), ...raw };
  } catch { return cache.value; }                     // a torn read keeps the last good book
  cache = { file, mtime, checked: now, value };
  return value;
}

function update(fn) {
  const file = KEEPOFF_FILE();
  const book = structuredClone(read({ fresh: true }));
  const out = fn(book);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(book, null, 2));
  renameSync(tmp, file);
  cache = { file: null, mtime: -1, checked: 0, value: book };
  return out;
}

export const current = () => read();

/** The live lock on this name, or null (cleared or expired). */
export function lockOf(name, { now = Date.now(), ttl = KEEPOFF_MS } = {}) {
  const l = read().locks?.[norm(name)];
  if (!l || l.cleared) return null;
  // Renewed by every logoff and every login: a target who keeps coming back keeps the lock.
  const last = Math.max(Number(l.locked_at) || 0, Number(l.offline_at) || 0, Number(l.online_at) || 0);
  return now - last > ttl ? null : l;
}

export const activeLocks = ({ now = Date.now(), ttl = KEEPOFF_MS } = {}) =>
  Object.values(read().locks ?? {}).map(l => lockOf(l.name, { now, ttl })).filter(Boolean);

/** He logged off (at this square, if known). Creates the lock, or re-arms it; waiters start over. */
export function markOffline(name, { room = null, row = null, col = null, at = Date.now(), by = null, noCombat = false } = {}) {
  return update(book => {
    const k = norm(name), prev = book.locks[k];
    const havePos = Number(room) > 1 && Number.isFinite(Number(row)) && Number.isFinite(Number(col));
    // Idempotent: every keeper in the room reports the same logoff within a second of the others.
    if (prev && !prev.cleared && prev.offline && at - Number(prev.offline_at) < 5000 && !havePos) return prev;
    const l = book.locks[k] = {
      name: prev?.name ?? String(name).trim(),
      room: havePos ? Number(room) : prev?.room ?? null,
      row: havePos ? Number(row) : prev?.row ?? null,
      col: havePos ? Number(col) : prev?.col ?? null,
      locked_at: prev && !prev.cleared ? prev.locked_at : at,
      offline: true, offline_at: prev?.offline && at - Number(prev.offline_at) < 5000 ? prev.offline_at : at,
      online_at: prev?.online_at ?? null,
      waiters: prev?.offline && at - Number(prev.offline_at) < 5000 ? prev.waiters ?? {} : {},
      reported_by: by ?? prev?.reported_by ?? null, cleared: null, cleared_why: null,
      // An inn (ROOM_NO_COMBAT / NO_PK): nobody can be hit where he will reappear, so nobody waits.
      no_combat: havePos ? !!noCombat : !!prev?.no_combat };
    return l;
  });
}

/** A ghost seen in a room refines where he will come back. */
export function notePosition(name, { room, row, col }) {
  const l = lockOf(name);
  if (!l || (l.room === room && l.row === row && l.col === col)) return l;
  return update(book => { Object.assign(book.locks[norm(name)], { room, row, col }); return book.locks[norm(name)]; });
}

export function markOnline(name, { at = Date.now() } = {}) {
  const l = lockOf(name);
  if (!l || (!l.offline && l.online_at && at - l.online_at < 5000)) return l;
  return update(book => { Object.assign(book.locks[norm(name)], { offline: false, online_at: at }); return book.locks[norm(name)]; });
}

/** Take a waiter slot. true when this agent now waits at the ghost. */
export function claimWaiter(name, agent, { max = 2, now = Date.now(), ttl = KEEPOFF_MS } = {}) {
  const l = lockOf(name, { now, ttl });
  if (!l || !l.offline) return false;
  const live = Object.entries(l.waiters ?? {}).filter(([, at]) => now - at < WAITER_STALE_MS);
  if (live.some(([a]) => a === agent)) return true;
  if (live.length >= max) return false;
  return update(book => {
    const b = book.locks[norm(name)];
    b.waiters = Object.fromEntries([...Object.entries(b.waiters ?? {}).filter(([, at]) => now - at < WAITER_STALE_MS), [agent, now]]);
    return true;
  });
}

export function heartbeatWaiter(name, agent, { now = Date.now() } = {}) {
  const l = read().locks?.[norm(name)];
  if (!l?.waiters?.[agent] || now - l.waiters[agent] < WAITER_HEARTBEAT_MS) return;
  update(book => { book.locks[norm(name)].waiters[agent] = now; });
}

export function releaseWaiter(name, agent) {
  const l = read().locks?.[norm(name)];
  if (!l?.waiters?.[agent]) return;
  update(book => { delete book.locks[norm(name)].waiters[agent]; });
}

export function markNoCombat(name) {
  if (!read({ fresh: true }).locks?.[norm(name)]) return;
  update(book => { Object.assign(book.locks[norm(name)], { no_combat: true, waiters: {} }); });
}

export function clearLock(name, why = 'cleared', { at = Date.now() } = {}) {
  if (!read({ fresh: true }).locks?.[norm(name)]) return null;
  return update(book => { Object.assign(book.locks[norm(name)], { cleared: at, cleared_why: why, waiters: {} }); return book.locks[norm(name)]; });
}

// ------------------------------------------------------------------ CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  if (flag('--clear')) { const l = clearLock(flag('--clear'), 'operator'); console.log(l ? `cleared ${l.name}` : 'no such lock'); }
  else {
    const now = Date.now();
    console.log(`keep-off locks (${KEEPOFF_FILE()})`);
    const all = Object.values(read({ fresh: true }).locks ?? {});
    if (!all.length) console.log('  none');
    for (const l of all) {
      const live = lockOf(l.name, { now });
      const w = Object.entries(l.waiters ?? {}).filter(([, at]) => now - at < WAITER_STALE_MS).map(([a]) => a);
      console.log(`  ${l.name.padEnd(24)} ${!live ? `inactive (${l.cleared_why ?? 'expired'})` : l.offline ? 'OFFLINE' : 'online '}` +
        `  map ${l.room ?? '?'} r${l.row ?? '?'}c${l.col ?? '?'}  waiters ${w.join(',') || '-'}`);
    }
    console.log('\n  --clear "<name>"   lift a lock');
  }
}
