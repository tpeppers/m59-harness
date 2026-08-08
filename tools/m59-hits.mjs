#!/usr/bin/env node
// WHERE THE CHARACTER WAS STANDING WHEN IT TOOK DAMAGE.
//
//   node tools/m59-hits.mjs                 the whole fleet, worst rooms first
//   node tools/m59-hits.mjs --character Zoot
//   node tools/m59-hits.mjs --travelling    only damage taken while travelling
//   node tools/m59-hits.mjs --room 562
//
// WHY THIS EXISTS. The keeper samples once a pass, and a pass can be a single `await`
// that lasts minutes — `Session.travel` loops up to 25 hops with no observation in it at
// all. So the whole of a journey is one blind window, and the post-mortem reconstructs
// the death from the last frame before it: 33 of 50 recent deaths had their final
// observation more than a minute before the killing blow, the worst of them twelve
// minutes and an entire room away. The records name inns. Nobody died in an inn.
//
// Damage does not have that problem. The server PUSHES health (BP_STAT, one packet per
// change), so a hit arrives as an event whether or not anything is looking — which means
// it can be recorded from the event stream at full resolution while the keeper is mid-
// travel, mid-errand, or inert with something else driving. That is the one measurement
// in this repository that does not go dark when the keeper does.
//
// AND IT ANSWERS THE QUESTION THE KEEPER CANNOT. "It set off for the Valley and died
// somewhere" is not a finding. "It took 19 of its 30 health across four squares in room
// 562, over 53 seconds, having last been observed in an inn" is one.
//
// SEGMENTS, NOT ONE ROW PER SWING. A character standing still under six attackers takes a
// hit every couple of seconds, and a row each would bury the shape in its own volume. So
// consecutive damage at the same square, in the same room, doing the same thing is folded
// into one segment carrying first/last/count/lost. A NEW SEGMENT IS A NEW PLACE — which
// makes "it was hit in nine different squares crossing the room" and "it was hit ninety
// times without moving" different-looking records, and they are completely different
// deaths.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const HITS_DIR = process.env.M59_HITS_DIR || here('../substrate/hits');

// Enough to cover a long session without the file growing without bound. A busy character
// closes a segment every few seconds while it is being chewed on, so this is roughly the
// last hour of trouble.
const MAX_SEGMENTS = 400;

const safeName = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
const fileFor = (character) => join(HITS_DIR, `${safeName(character)}.json`);

export function emptyBook(character) {
  return { character: character ?? null, version: 1, segments: [] };
}

export function loadBook(character) {
  try { return { ...emptyBook(character), ...JSON.parse(readFileSync(fileFor(character), 'utf8')) }; }
  catch { return emptyBook(character); }
}

export function saveBook(book) {
  if (!book?.character) return null;                  // never write an "unknown.json"
  try {
    mkdirSync(HITS_DIR, { recursive: true });
    writeFileSync(fileFor(book.character), JSON.stringify(book, null, 2));
    return fileFor(book.character);
  } catch { return null; }                            // a failed write must not stop play
}

export const listCharacters = () => {
  try { return readdirSync(HITS_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)); }
  catch { return []; }
};

// IS THIS THE SAME PLACE AND THE SAME SITUATION as the segment we are already in?
//
// Room, square and `doing` all count. The last one matters more than it looks: being hit
// at (21,20) while `fighting` and being hit at (21,20) while `travelling` are the same
// coordinates and opposite facts — one is a fight, the other is a character being chipped
// at on its way past — and folding them together would erase the distinction the whole
// file exists to draw.
export const sameSpot = (seg, at) =>
  !!seg && seg.room === at.room && seg.col === at.col && seg.row === at.row &&
  (seg.doing ?? null) === (at.doing ?? null);

// HOW LONG A GAP STILL COUNTS AS THE SAME TROUBLE. Two hits ninety seconds apart on the
// same square are not one event, they are two visits — and a segment that swallowed the
// gap would report a character "under attack for eleven minutes" when it stood there
// unharmed for ten of them.
export const SEGMENT_GAP_MS = 30_000;

// Fold one hit into a book. Returns the OPEN segment, which the caller may keep a
// reference to; it is the same object stored in the book, so later hits extend it in
// place rather than reallocating.
//
// `lost` is the health delta, always positive. A gain is not a hit and must never reach
// here — see the caller, which is the only thing that can tell a heal from a hit, because
// this sees one number at a time.
export function record(book, { at = Date.now(), room = null, roomName = null,
                               col = null, row = null, doing = null, health = null,
                               max = null, lost = 0, by = null } = {}) {
  if (!(lost > 0)) return null;
  const segs = book.segments;
  const open = segs[segs.length - 1];
  const spot = { room, col, row, doing };
  if (sameSpot(open, spot) && at - open.last_at <= SEGMENT_GAP_MS) {
    open.last_at = at;
    open.hits++;
    open.lost += lost;
    open.health = health;
    if (by && !open.by.includes(by)) open.by.push(by);
    return open;
  }
  const seg = {
    room, room_name: roomName, col, row, doing,
    first_at: at, last_at: at, hits: 1, lost,
    // The health we were left on, and the ceiling, so a reader can see 11/30 rather than
    // having to carry the character's max around separately.
    health, max,
    // Whatever the server named as the attacker, when a combat line arrived close enough
    // to the damage to be about it. Best-effort by construction — see the caller.
    by: by ? [by] : [],
  };
  segs.push(seg);
  while (segs.length > MAX_SEGMENTS) segs.shift();
  return seg;
}

// ------------------------------------------------------------------ reading it back

// WHAT THIS CHARACTER'S TROUBLE LOOKS LIKE, without needing to read every segment.
//
// `while_travelling` is the number that motivated the file. A character that takes most
// of its damage while `doing: travelling` is not losing fights — it is being worn down on
// the roads between them, and no amount of tuning the fight will help it.
export function summarise(book, { since = 0 } = {}) {
  const segs = (book.segments || []).filter(s => s.last_at >= since);
  const total = segs.reduce((t, s) => t + s.lost, 0);
  const byDoing = {};
  const byRoom = {};
  for (const s of segs) {
    const d = s.doing || 'unknown';
    byDoing[d] = (byDoing[d] || 0) + s.lost;
    const k = s.room_name ? `${s.room_name} (${s.room})` : String(s.room);
    byRoom[k] = (byRoom[k] || 0) + s.lost;
  }
  const worst = Object.entries(byRoom).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return {
    character: book.character,
    segments: segs.length,
    hits: segs.reduce((t, s) => t + s.hits, 0),
    health_lost: total,
    by_activity: byDoing,
    while_travelling: byDoing.travelling || 0,
    worst_rooms: Object.fromEntries(worst),
    // A segment with many hits and one square is a character that stood there; many
    // segments with few hits each is one that was moving. Both die, differently.
    squares_hit_in: new Set(segs.map(s => `${s.room}:${s.col},${s.row}`)).size,
  };
}

// ------------------------------------------------------------------ the command line

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
    || process.argv[1]?.endsWith('m59-hits.mjs')) {
  const arg = (name, dflt = null) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? (process.argv[i + 1] ?? true) : dflt;
  };
  const only = arg('character');
  const roomWanted = arg('room');
  const travellingOnly = process.argv.includes('--travelling');
  const names = only ? [safeName(only)] : listCharacters();
  if (!names.length) {
    console.log(`no hit records yet — ${HITS_DIR} is empty.`);
    console.log('The broker writes them as damage arrives; give a running fleet a few minutes.');
    process.exit(0);
  }
  const rows = [];
  for (const n of names) {
    const book = loadBook(n);
    let segs = book.segments || [];
    if (travellingOnly) segs = segs.filter(s => s.doing === 'travelling');
    if (roomWanted != null) segs = segs.filter(s => String(s.room) === String(roomWanted));
    if (!segs.length) continue;
    rows.push({ n, book: { ...book, segments: segs }, sum: summarise({ ...book, segments: segs }) });
  }
  rows.sort((a, b) => b.sum.health_lost - a.sum.health_lost);
  const pad = (s, w) => String(s).padEnd(w);
  console.log(pad('character', 11) + pad('lost', 7) + pad('hits', 7) + pad('squares', 9) +
              pad('travelling', 12) + 'worst room');
  for (const r of rows) {
    const worst = Object.entries(r.sum.worst_rooms)[0];
    console.log(pad(r.n, 11) + pad(r.sum.health_lost, 7) + pad(r.sum.hits, 7) +
                pad(r.sum.squares_hit_in, 9) + pad(r.sum.while_travelling, 12) +
                (worst ? `${worst[0]} — ${worst[1]}` : ''));
  }
  if (only) {
    const r = rows[0];
    if (r) {
      console.log('');
      for (const s of r.book.segments.slice(-25)) {
        const secs = Math.round((s.last_at - s.first_at) / 1000);
        console.log(`  ${new Date(s.first_at).toISOString().slice(11, 19)}  ` +
                    `${pad(s.room_name || s.room, 34)}${pad(`${s.col},${s.row}`, 9)}` +
                    `${pad(s.doing || '?', 12)}${pad(`-${s.lost}`, 6)}` +
                    `${pad(`${s.hits} hit${s.hits === 1 ? '' : 's'}`, 10)}` +
                    `${pad(secs ? `over ${secs}s` : 'instant', 12)}` +
                    `${s.health != null ? `left ${s.health}/${s.max ?? '?'}` : ''}` +
                    `${s.by.length ? `  by ${s.by.join(', ')}` : ''}`);
      }
    }
  }
}
