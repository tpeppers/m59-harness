// DIBS: FLOOR ITEMS IN ONE ROOM RESERVED FOR NAMED CHARACTERS.
//
// Operator, 2026-11-05: "make it a room-specific rule capability -- add and deploy a harness fix to allow specifically that:
// 'dibs'ing resources on the floor for specific bots in the fleet, in this case purple mushrooms for those casters".
//
// What it was for: a courier (Gonzo) drops purple mushrooms at a cache character's feet in the Clearing of the Trading Post
// (2144) for three hold casters, and every other farmer walking through looted the pile on its ordinary loot pass -- Rizzo
// took 52 that were never his. The ignore list (`loot_ignore`, m59-game.mjs lootIgnored) is per CHARACTER and everywhere, so
// the only lever was to stop the whole fleet looting purple mushrooms off its own kills too. A claim is per ROOM and per ITEM:
// in that room, that item lies on the floor for the named characters and nobody else picks it up.
//
// THE BOOK. `substrate/dibs-<fleet>.json` (M59_DIBS_FILE overrides), gitignored: an instruction to the fleet is this
// machine's, like a loadout or a tuning line. Shape (substrate/dibs.example.json):
//   { "claims": [ { "room": 2144, "item": "purple mushroom", "for": ["Bunsen", "Beaker", "Robin"],
//                   "why": "...", "by": "...", "at": "<iso>", "until": "<iso>|null" } ] }
// Re-read on mtime, every keeper, no restart. A file that will not parse keeps the last good book and says so -- a bad edit
// must not silently release every claim (or invent one).
//
// THE RULE (pure, `dibsVerdict`): an item on the floor of `room` matching a live claim's `item` (exact name, case-insensitive,
// a trailing plural `s` ignored -- the floor says "purple mushrooms") is left alone unless this character is in `for`.
// Everything else is untouched. It is applied in Session.lootFloor -- the single place a floor drop becomes a carried item,
// which every loot path goes through -- and, like the ignore list, NEVER against an explicit id request: a caller that names
// the object it wants (a hand-written `act get`, a rescue) is choosing to take it.
//
//   node tools/m59-dibs.mjs list  --fleet prod
//   node tools/m59-dibs.mjs set   --fleet prod --room 2144 --item "purple mushroom" --for Bunsen,Beaker,Robin --by tp --why "..."
//   node tools/m59-dibs.mjs clear --fleet prod --room 2144 --item "purple mushroom"
import { readFileSync, writeFileSync, statSync, existsSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBSTRATE = resolve(HERE, '..', 'substrate');

export const dibsFile = (fleet = fleetName(), env = process.env) => env.M59_DIBS_FILE || join(SUBSTRATE, `dibs-${fleet || 'default'}.json`);
export const itemKey = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/(?<=[a-z])s$/, '');
const nameKey = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Normalize a book; bad claims are reported in `problems` and dropped, never guessed at. */
export function normalizeBook(raw, problems = []) {
  const claims = [];
  for (const [i, c] of (Array.isArray(raw?.claims) ? raw.claims : []).entries()) {
    const room = Number(c?.room), item = itemKey(c?.item);
    const who = (Array.isArray(c?.for) ? c.for : []).map(nameKey).filter(Boolean);
    if (!Number.isInteger(room) || room <= 0) { problems.push(`claim ${i}: room must be a room number`); continue; }
    if (!item) { problems.push(`claim ${i}: item is required`); continue; }
    if (!who.length) { problems.push(`claim ${i}: "for" names nobody -- a claim for nobody would strand the item`); continue; }
    const until = c?.until ? Date.parse(c.until) : null;
    if (c?.until && !Number.isFinite(until)) { problems.push(`claim ${i}: until is not a date`); continue; }
    claims.push({ room, item, for: who, names: c.for.map(n => String(n).trim()).filter(Boolean), until, why: c?.why ?? null, by: c?.by ?? null, at: c?.at ?? null });
  }
  return { claims };
}

/** Live claims only: a claim past its `until` is spent. */
export const liveClaims = (book, now = Date.now()) => (book?.claims ?? []).filter(c => c.until == null || c.until > now);

/**
 * May `character` (a name, or [character, agent id]) pick up `item` off the floor of `room`? Pure.
 * -> { allowed: true } | { allowed: false, claim } (the claim it is reserved under).
 */
export function dibsVerdict({ book, room, item, character, now = Date.now() }) {
  const r = Number(room), k = itemKey(item), me = [].concat(character ?? []).map(nameKey).filter(Boolean);
  if (!Number.isFinite(r) || !k) return { allowed: true };
  for (const c of liveClaims(book, now)) {
    if (c.room !== r || c.item !== k) continue;
    if (me.some(m => c.for.includes(m))) return { allowed: true, claim: c, mine: true };
    return { allowed: false, claim: c };
  }
  return { allowed: true };
}

// ---- the file, re-read on mtime (every keeper calls this on every loot pass; a stat is the whole cost when nothing changed)
const cache = new Map();
export function readDibs(file) {
  let mtime = null;
  try { mtime = statSync(file).mtimeMs; } catch { cache.set(file, { mtime: null, book: { claims: [] }, error: null }); return { claims: [] }; }
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.book;
  try {
    const problems = [];
    const book = normalizeBook(JSON.parse(readFileSync(file, 'utf8')), problems);
    cache.set(file, { mtime, book, error: problems.length ? problems.join('; ') : null });
    return book;
  } catch (e) {
    // A FILE THAT WILL NOT PARSE IS NOT AN EMPTY FILE: keep the last good book.
    const last = hit?.book ?? { claims: [] };
    cache.set(file, { mtime, book: last, error: `unreadable, last good book kept: ${e.message}` });
    return last;
  }
}
export const dibsError = file => cache.get(file)?.error ?? null;
export const forgetDibs = () => cache.clear();

/** Split floor candidates into kept and left-for-someone-else. `nameOf(o)` gives the item name. */
export function dibsFilter(cands, { book, room, character, nameOf = o => o?.name ?? '', now = Date.now() }) {
  const keep = [], left = [];
  for (const o of cands ?? []) {
    const v = dibsVerdict({ book, room, item: nameOf(o), character, now });
    if (v.allowed) keep.push(o); else left.push({ o, name: nameOf(o), claim: v.claim });
  }
  return { keep, left };
}

// ---- edits (the CLI); the raw file is rewritten whole and atomically, entries keep their original fields
function readRaw(file) {
  if (!existsSync(file)) return { format: 'm59-dibs/1', claims: [] };
  return JSON.parse(readFileSync(file, 'utf8'));
}
function writeRaw(file, raw) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(raw, null, 1) + '\n');
  renameSync(tmp, file);
  cache.delete(file);
}
export function setClaim(file, { room, item, forWho, why = null, by = null, until = null }, now = Date.now()) {
  const raw = readRaw(file);
  raw.claims = (raw.claims ?? []).filter(c => !(Number(c.room) === Number(room) && itemKey(c.item) === itemKey(item)));
  const claim = { room: Number(room), item: String(item), for: forWho, why, by, at: new Date(now).toISOString(), until };
  const problems = [];
  normalizeBook({ claims: [claim] }, problems);
  if (problems.length) throw new Error(problems.join('; '));
  raw.claims.push(claim);
  writeRaw(file, raw);
  return claim;
}
export function clearClaim(file, { room, item }) {
  const raw = readRaw(file);
  const before = (raw.claims ?? []).length;
  raw.claims = (raw.claims ?? []).filter(c => !(Number(c.room) === Number(room) && itemKey(c.item) === itemKey(item)));
  writeRaw(file, raw);
  return before - raw.claims.length;
}

// ---- CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2), cmd = argv[0];
  const arg = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };
  const fleet = arg('fleet') || process.env.M59_FLEET;
  if (!fleet) { console.error('name the fleet: --fleet <name> (or M59_FLEET)'); process.exit(2); }
  const file = dibsFile(fleet);
  if (cmd === 'set') {
    const forWho = String(arg('for') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const c = setClaim(file, { room: arg('room'), item: arg('item'), forWho, why: arg('why'), by: arg('by'), until: arg('until') });
    console.log(`claimed: ${c.item} on the floor of ${c.room} is for ${c.for.join(', ')} only\n  ${file}`);
  } else if (cmd === 'clear') {
    console.log(`cleared ${clearClaim(file, { room: arg('room'), item: arg('item') })} claim(s)\n  ${file}`);
  } else if (cmd === 'list' || !cmd) {
    const book = readDibs(file);
    console.log(`${file}${dibsError(file) ? `  (${dibsError(file)})` : ''}`);
    if (!book.claims.length) console.log('  no claims: every floor item is anybody\'s');
    for (const c of book.claims) console.log(`  room ${c.room}: ${c.item} -> ${(c.names ?? c.for).join(', ')}${c.until ? ` until ${new Date(c.until).toISOString()}` : ''}${c.why ? `  (${c.why})` : ''}`);
  } else { console.error('commands: list | set | clear'); process.exit(2); }
}
