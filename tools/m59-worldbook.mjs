#!/usr/bin/env node
// WHAT THE FLEET HAS SEEN OF THE WORLD THAT IS NOT A PLAYER: NPCS, WHERE THEY STAND, WHAT THEY SELL.
//
//   node tools/m59-worldbook.mjs --fleet prod                 every NPC, newest sighting first
//   node tools/m59-worldbook.mjs --fleet prod --npc maleval   one NPC: room, age, history, last shop
//   node tools/m59-worldbook.mjs --fleet prod --wanderers     the five wanderers and where they are
//   node tools/m59-worldbook.mjs --fleet prod --sells prism   whose last-seen list had it
//   node tools/m59-worldbook.mjs --fleet prod --room 952      who stood in a room when we last looked
//
// THE PLAYER HALF ALREADY EXISTS (m59-sightings.mjs: every login and logoff, once). This is the
// half above it. Every keeper already holds the full contents of the room it stands in -- the
// server sends the whole room, not a view cone -- and until now each one threw it away. So the
// keeper hands its room to `createWorldObserver().tick()` every few seconds, and what any one
// character sees, every script and the broker's `world` tool can ask about:
//
//   * NPCS: name, room, square, when, by whom; the last 12 rooms each was seen in; and LEFT --
//     a keeper standing in the room an NPC was last recorded in, without him in it, ends that
//     sighting. For a wanderer this is the difference between "he is in 802" and "he was".
//   * ROOMS: which NPCs stood in each room the last time a keeper was there, and when.
//   * SHOPS: every buy list a keeper opened (the broker's `shop` tool still writes
//     m59-shops-seen.mjs as before, and now here too), keyed by the PERSON as well as the room --
//     so a travelling merchant's last stock follows him round his circuit instead of splitting
//     into five rows.
//
// WHAT IS AN NPC. Not a player, not attackable, not gettable -- and then either the server marks
// it as a seller or a receiver (BUYABLE / OFFERABLE, m59-parse.mjs), or its name is a person the
// merchant catalogue or the wanderer table knows. The last clause is because the flags alone
// also admit a sign or a fountain.
//
// ONE FILE PER FLEET (fleets are different servers), beside the sightings ledger, written under a
// lock and only when something changed or a held sighting is a minute old: a quiet keeper writes
// about once a minute, not once a tick. A keeper that cannot get the lock in a few milliseconds
// skips that write; the next tick carries it. Off with M59_WORLDBOOK=0.
//
// Not to be confused with m59-worldstate.mjs, which is the GOAP planner's symbol vocabulary.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { takeLock } from './m59-sightings.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA = 'm59-worldbook/v1';
export const REFRESH_MS = 60_000;       // re-stamp a sighting this often while it holds
export const FRESH_MS = 3 * 60_000;     // a sighting younger than this is a fact; older, a rumour
export const HISTORY = 12;

// ---------------------------------------------------------------- the wanderers, as data
//
// From each class's CreateDestinationList (m59-research reports/wandering-npcs.md;
// minstrel.kod:82-83, dkwizard.kod:85-87, heretic.kod:77-78, huntghst.kod:48-49,
// izzio.kod:240-241). Jonas D'Accor is coded and never spawned. Here rather than in
// m59-wanderers.mjs so a keeper can know them without loading the fleetscript chassis.
export const WANDERERS = Object.freeze({
  maleval: { npc: 'Maleval', cls: 'DarkWizard', rooms: [802, 952, 53, 200, 950] },
  parrin: { npc: 'Parrin Aragone', cls: 'Minstrel', rooms: [952, 150, 371, 103, 852] },
  miriana: { npc: 'Miriana', cls: 'Heretic', rooms: [511, 567, 516, 597] },
  tendrath: { npc: 'Tendrath', cls: 'HunterGhost', rooms: [578, 599, 39, 615] },
  izzio: { npc: 'Izzio', cls: 'Izzio', rooms: [575, 535, 593, 48, 568] },
});

export const fold = n => String(n ?? '').trim().replace(/^(the|a|an)\s+/i, '').replace(/\s+/g, ' ').toLowerCase();
export const wandererOf = name => {
  const f = fold(name);
  return Object.keys(WANDERERS).find(k => fold(WANDERERS[k].npc) === f) ?? null;
};

// Flag bits from m59-parse.mjs OF, inlined so this module stays import-light for the keeper.
const F = { PLAYER: 0x4, ATTACKABLE: 0x8, GETTABLE: 0x10, OFFERABLE: 0x200, BUYABLE: 0x400 };

let KNOWN = null;
function knownNames() {
  if (KNOWN) return KNOWN;
  KNOWN = new Set(Object.values(WANDERERS).map(w => fold(w.npc)));
  try {
    const j = JSON.parse(readFileSync(join(REPO, 'substrate', 'm59-merchants.json'), 'utf8'));
    for (const m of j.merchants ?? []) if (m?.name) KNOWN.add(fold(m.name));
  } catch { /* no catalogue: flags alone */ }
  return KNOWN;
}
/** Tests only: replace the known-name list (null = reload from the catalogue). */
export const _setKnownNames = names => { KNOWN = names ? new Set([...names].map(fold)) : null; };

/**
 * Is this room object an NPC? Takes either wire flags (`flags`) or a broker look's
 * affordances (`can`, `is_player`).
 */
export function isNpc(o) {
  if (!o?.name) return false;
  const can = Array.isArray(o.can) ? o.can : null;
  const player = o.is_player ?? (o.flags != null ? !!(o.flags & F.PLAYER) : false);
  if (player) return false;
  const has = (bit, word) => (can ? can.includes(word) : !!((o.flags ?? 0) & bit));
  if (has(F.ATTACKABLE, 'attack') || has(F.GETTABLE, 'get')) return false;
  return has(F.BUYABLE, 'buy') || has(F.OFFERABLE, 'offer') || knownNames().has(fold(o.name));
}

// ---------------------------------------------------------------- the file

export const bookFile = dir => join(dir, 'world-book.json');
const lockOf = dir => ({ lock: join(dir, 'world-book.lock') });
export const emptyBook = () => ({ schema: SCHEMA, npcs: {}, rooms: {}, shops: {} });

export function readBook(dir) {
  try {
    const j = JSON.parse(readFileSync(bookFile(dir), 'utf8'));
    return j?.schema === SCHEMA ? { ...emptyBook(), ...j } : emptyBook();
  } catch { return emptyBook(); }
}
function writeBook(dir, w) {
  const tmp = `${bookFile(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(w));
  renameSync(tmp, bookFile(dir));
}
/** Read-modify-write under the lock. Returns false (and writes nothing) when the lock is busy. */
export function updateBook(dir, fn, { waitMs = 25 } = {}) {
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const release = takeLock(lockOf(dir), { waitMs });
  if (!release) return false;
  try { const w = readBook(dir); fn(w); writeBook(dir, w); return true; }
  catch { return false; }
  finally { release(); }
}

// ---------------------------------------------------------------- observing

/** Apply one room observation to a book. Pure: exported for the tests. Returns the NPC names seen. */
export function applyRoom(w, { agent, room, room_name = null, objects = [], now = Date.now() }) {
  room = Number(room);
  if (!Number.isFinite(room) || room <= 0) return [];
  const npcs = objects.filter(isNpc);
  const here = new Set(npcs.map(o => fold(o.name)));
  for (const o of npcs) {
    const k = fold(o.name);
    const rec = w.npcs[k] ?? { name: String(o.name), history: [] };
    if (rec.room !== room || rec.left != null) rec.history = [{ room, at: now }, ...(rec.history ?? [])].slice(0, HISTORY);
    Object.assign(rec, { name: String(o.name), room, room_name, row: o.row ?? null, col: o.col ?? null, at: now, by: agent,
                         seller: o.can ? o.can.includes('buy') : !!((o.flags ?? 0) & F.BUYABLE) });
    delete rec.left;
    const wk = wandererOf(o.name);
    if (wk) { rec.wanderer = wk; if (rec.absent) delete rec.absent[room]; }
    w.npcs[k] = rec;
  }
  // Gone from where we last had them.
  for (const [k, rec] of Object.entries(w.npcs)) {
    if (here.has(k)) continue;
    if (rec.room === room && rec.left == null) rec.left = now;
    const wk = rec.wanderer ?? wandererOf(rec.name);
    if (wk && WANDERERS[wk].rooms.includes(room)) (rec.absent ??= {})[room] = now;
  }
  // A wanderer nobody has ever seen still gets his absences, so the first search is ordered too.
  for (const [wk, W] of Object.entries(WANDERERS)) {
    if (!W.rooms.includes(room) || here.has(fold(W.npc)) || w.npcs[fold(W.npc)]) continue;
    w.npcs[fold(W.npc)] = { name: W.npc, wanderer: wk, history: [], absent: { [room]: now } };
  }
  w.rooms[room] = { room_name, at: now, by: agent, npcs: npcs.map(o => String(o.name)) };
  return npcs.map(o => String(o.name));
}

export function applyShop(w, { agent, room, room_name = null, seller, items = [], now = Date.now() }) {
  if (!fold(seller) || !items.length) return;
  const shop = { name: String(seller), room: Number(room) || null, room_name, at: now, by: agent,
                 items: items.map(i => ({ name: String(i.name ?? ''), cost: Number(i.cost) || null,
                                          amount: Number(i.amount ?? i.quantity) || null })).filter(i => i.name) };
  w.shops[`${shop.room ?? '?'}:${fold(seller)}`] = shop;
  (w.npcs[fold(seller)] ??= { name: String(seller), history: [] }).shop = shop;
}

export const observeRoom = (dir, obs) => updateBook(dir, w => applyRoom(w, obs));
export const observeShop = (dir, obs) => updateBook(dir, w => applyShop(w, obs));

/**
 * The keeper's half. `tick(snapshot)` with { room, room_name, objects:[{name,flags,row,col}],
 * buyList:{seller, items}|null } -- writes only when the room's NPC set changed, a held sighting
 * is REFRESH_MS old, or a new buy list arrived. A room read on the first tick after a room change
 * is skipped: the contents may still be the old room's.
 */
export function createWorldObserver({ dir, agent, log = () => {} }) {
  let lastRoom = null, lastKey = null, lastWrite = 0, lastShop = null, failures = 0;
  return {
    tick({ room, room_name = null, objects = [], buyList = null, now = Date.now() } = {}) {
      if (!(room > 0)) return;
      const stable = room === lastRoom;
      lastRoom = room;
      if (buyList && buyList.raw !== lastShop && buyList.seller) {
        lastShop = buyList.raw;
        if (!observeShop(dir, { agent, room, room_name, seller: buyList.seller, items: buyList.items, now })) lastShop = null;
      }
      if (!stable) return;
      const npcs = objects.filter(isNpc).map(o => fold(o.name)).sort();
      const key = `${room}|${npcs.join(',')}`;
      if (key === lastKey && now - lastWrite < REFRESH_MS) return;
      // A town square full of nobody is still worth one write: it is what ends a stale sighting.
      if (observeRoom(dir, { agent, room, room_name, objects, now })) { lastKey = key; lastWrite = now; failures = 0; }
      else if (++failures === 20) log('world-book: lock busy for 20 ticks running');
    },
    status: () => ({ enabled: true, last_room: lastRoom, last_write: lastWrite ? new Date(lastWrite).toISOString() : null }),
  };
}

// ---------------------------------------------------------------- asking

const isoOf = t => (t != null ? new Date(t).toISOString() : null);

/** One NPC as the fleet knows it, with its freshness spelled out. `name` may be a wanderer key. */
export function npcInfo(w, name, { now = Date.now(), freshMs = FRESH_MS } = {}) {
  const wk = WANDERERS[String(name).toLowerCase()] ? String(name).toLowerCase() : null;
  const k = wk ? fold(WANDERERS[wk].npc) : fold(name);
  let rec = w.npcs[k];
  if (!rec) {
    const hits = Object.entries(w.npcs).filter(([n]) => n.includes(k));
    if (hits.length === 1) rec = hits[0][1];
  }
  if (!rec) return null;
  const age = rec.at != null ? now - rec.at : null;
  const gone = rec.left != null;
  return {
    name: rec.name, wanderer: rec.wanderer ?? wandererOf(rec.name),
    room: gone ? null : rec.room ?? null, last_room: rec.room ?? null, room_name: rec.room_name ?? null,
    square: rec.row != null ? { row: rec.row, col: rec.col } : null,
    seen_at: isoOf(rec.at), age_min: age != null ? Math.round(age / 6000) / 10 : null,
    by: rec.by ?? null, fresh: !gone && age != null && age <= freshMs,
    left_at: gone ? isoOf(rec.left) : null,
    history: (rec.history ?? []).map(h => ({ room: h.room, at: isoOf(h.at) })),
    absent_min_ago: Object.fromEntries(Object.entries(rec.absent ?? {}).map(([r, t]) => [r, Math.round((now - t) / 60_000)])),
    seller: rec.seller ?? null,
    last_shop: rec.shop ? { room: rec.shop.room, at: isoOf(rec.shop.at), by: rec.shop.by, items: rec.shop.items } : null,
    // Raw, for callers that do arithmetic (m59-wanderers.mjs).
    _raw: { at: rec.at ?? null, left: rec.left ?? null, room: rec.room ?? null, absent: rec.absent ?? {} },
  };
}

export function whoSells(w, text) {
  const q = fold(text);
  return Object.values(w.shops).filter(s => s.items.some(i => fold(i.name).includes(q)))
    .sort((a, b) => b.at - a.at)
    .map(s => ({ name: s.name, room: s.room, room_name: s.room_name, at: isoOf(s.at),
                 matching: s.items.filter(i => fold(i.name).includes(q)), wanderer: wandererOf(s.name) }));
}

export function roomInfo(w, room) {
  const r = w.rooms[Number(room)];
  return r ? { room: Number(room), ...r, at: isoOf(r.at) } : null;
}

export function recent(w, { limit = 50 } = {}) {
  return Object.values(w.npcs).filter(r => r.at).sort((a, b) => b.at - a.at).slice(0, limit)
    .map(r => ({ name: r.name, room: r.left ? null : r.room, last_room: r.room, seen_at: isoOf(r.at),
                 ...(r.left ? { left_at: isoOf(r.left) } : {}), ...(r.wanderer ? { wanderer: r.wanderer } : {}),
                 ...(r.shop ? { for_sale: r.shop.items.length } : {}) }));
}

// ---------------------------------------------------------------- CLI

if (import.meta.filename === process.argv[1]) {
  const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  if (arg('--fleet')) process.env.M59_FLEET = arg('--fleet');
  const { ledgerDirFor, fleetName } = await import('./m59-fleetpath.mjs');
  const w = readBook(ledgerDirFor(fleetName()));
  const strip = x => (x && x._raw ? (({ _raw, ...rest }) => rest)(x) : x);
  let out;
  if (arg('--npc')) out = strip(npcInfo(w, arg('--npc'))) ?? `no sighting of ${arg('--npc')}`;
  else if (process.argv.includes('--wanderers')) out = Object.keys(WANDERERS).map(k => strip(npcInfo(w, k)) ?? { name: WANDERERS[k].npc, never_seen: true });
  else if (arg('--sells')) out = whoSells(w, arg('--sells'));
  else if (arg('--room')) out = roomInfo(w, arg('--room')) ?? `no keeper has stood in ${arg('--room')}`;
  else out = recent(w, { limit: 200 });
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
}
