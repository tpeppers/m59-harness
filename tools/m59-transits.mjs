#!/usr/bin/env node
// HOW LONG IT TAKES TO CROSS ONE MAP, measured per room, per journey.
//
//   node tools/m59-transits.mjs                 slowest rooms first, fleet-wide
//   node tools/m59-transits.mjs --worst 40      the forty slowest individual crossings
//   node tools/m59-transits.mjs --room 544      every crossing of one room
//   node tools/m59-transits.mjs --character Gonzo
//   node tools/m59-transits.mjs --failures      only the hops that never got out
//
// WHY THIS EXISTS, AND WHAT IT IS NOT FOR.
//
// It is NOT for measuring damage taken in transit. There is no safe travel in Meridian 59
// and there is not meant to be: human players die crossing the world constantly, taking
// hits on the road is a normal feature of the game, and the world is expected to get more
// dangerous as other players start hunting these characters. A journey that took damage is
// a journey, not a fault. Damage is minimised by leaving at full health and the best vigor
// that food and rest can buy, by moving faster, by evading, and by picking a cheaper route
// — never by giving up partway, which would cancel most journeys the fleet ever makes.
//
// It IS for TIME EXPOSED. Every second spent inside a map is a second something can reach
// you, so the crossing time is the thing worth attacking, and it is a number nothing was
// recording. The case that started this: Gonzo took ten hits in ten different squares of
// the Valley of Ileria between 09:36:01 and 09:37:55 — nearly two minutes inside one map.
// Most maps in this game can be crossed in well under a minute from any exit to any other.
// A two-minute crossing is not a dangerous map, it is a slow one, and slow is a thing we
// control.
//
// SO THE MEASUREMENT IS PER ROOM AND PER ATTEMPT, not per journey. A journey that took six
// minutes tells you nothing; six rooms with one of them at 114 seconds tells you where to
// look. `tried` and `reason` are recorded with the time because the suspicion is that most
// of the tail is not walking at all — it is candidate exit squares being refused one after
// another, each attempt paced against the server, with the successful one arrived at last.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const TRANSIT_DIR = process.env.M59_TRANSIT_DIR || here('../substrate/transits');

// A few hours of travel for a busy character. Crossings are far rarer than hits — one per
// room entered rather than one per swing — so this is a deeper history for a smaller file.
const MAX_TRANSITS = 600;

const safeName = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
const fileFor = (character) => join(TRANSIT_DIR, `${safeName(character)}.json`);

export function emptyBook(character) {
  return { character: character ?? null, version: 1, transits: [] };
}

export function loadBook(character) {
  try { return { ...emptyBook(character), ...JSON.parse(readFileSync(fileFor(character), 'utf8')) }; }
  catch { return emptyBook(character); }
}

export function saveBook(book) {
  if (!book?.character) return null;
  try {
    mkdirSync(TRANSIT_DIR, { recursive: true });
    writeFileSync(fileFor(book.character), JSON.stringify(book, null, 2));
    return fileFor(book.character);
  } catch { return null; }
}

export const listCharacters = () => {
  try { return readdirSync(TRANSIT_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)); }
  catch { return []; }
};

// One room, crossed once, during one journey.
//
// `ms` is the whole time in the room — from the moment the previous hop's arrival settled
// to the moment we left. `walk_ms` is only the part inside leaveViaAny. The DIFFERENCE is
// route planning and exit selection, and separating them is the point: if the tail is in
// `ms - walk_ms` the problem is deciding, and if it is in `walk_ms` the problem is doing.
export function record(book, { at = Date.now(), room = null, roomName = null,
                               to = null, toName = null, ms = 0, walkMs = null,
                               ok = true, tried = 1, reason = null,
                               journey = null, hop = null, destination = null } = {}) {
  const t = { at, room, room_name: roomName, to, to_name: toName,
              ms, walk_ms: walkMs, ok, tried,
              ...(reason ? { reason } : {}),
              journey, hop, destination };
  book.transits.push(t);
  while (book.transits.length > MAX_TRANSITS) book.transits.shift();
  return t;
}

const pctile = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

// WHAT THE FLEET'S TRAVEL ACTUALLY COSTS, by room.
//
// The median is not the interesting number and never was — it is the tail that kills, and
// a room whose median crossing is 8 seconds and whose p99 is 140 is a room with a specific
// bug in it rather than a big map.
export function byRoom(books, { since = 0, failuresOnly = false } = {}) {
  const rooms = new Map();
  for (const b of books) {
    for (const t of b.transits || []) {
      if (t.at < since) continue;
      if (failuresOnly && t.ok) continue;
      const k = t.room;
      if (!rooms.has(k)) rooms.set(k, { room: k, name: t.room_name, times: [], fails: 0,
                                        tried: 0, crossings: 0, worst: null });
      const r = rooms.get(k);
      r.name ??= t.room_name;
      r.crossings++;
      r.times.push(t.ms);
      r.tried += t.tried || 1;
      if (!t.ok) r.fails++;
      if (!r.worst || t.ms > r.worst.ms) r.worst = t;
    }
  }
  const out = [...rooms.values()].map(r => {
    const s = r.times.slice().sort((a, b) => a - b);
    return { room: r.room, name: r.name, crossings: r.crossings, failed: r.fails,
             median_ms: pctile(s, 0.5), p90_ms: pctile(s, 0.9), max_ms: s[s.length - 1] ?? 0,
             // How many exit squares had to be attempted per crossing on average. Above 1
             // means squares are being refused, which is where the suspicion points.
             squares_per_crossing: +(r.tried / r.crossings).toFixed(2),
             worst: r.worst };
  });
  out.sort((a, b) => b.max_ms - a.max_ms);
  return out;
}

// ------------------------------------------------------------------ the command line

if (process.argv[1]?.endsWith('m59-transits.mjs')) {
  const arg = (name, dflt = null) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? (process.argv[i + 1] ?? true) : dflt;
  };
  const only = arg('character');
  const roomWanted = arg('room');
  const worstN = Number(arg('worst', 0));
  const failuresOnly = process.argv.includes('--failures');
  const names = only ? [safeName(only)] : listCharacters();
  if (!names.length) {
    console.log(`no transit records yet — ${TRANSIT_DIR} is empty.`);
    console.log('The broker writes one per room crossed during a travel; give a running fleet a while.');
    process.exit(0);
  }
  const books = names.map(loadBook);
  const secs = (ms) => (ms / 1000).toFixed(1) + 's';
  const pad = (s, w) => String(s).padEnd(w);

  let all = books.flatMap(b => (b.transits || []).map(t => ({ ...t, who: b.character })));
  if (roomWanted != null) all = all.filter(t => String(t.room) === String(roomWanted));
  if (failuresOnly) all = all.filter(t => !t.ok);
  if (!all.length) { console.log('nothing recorded that matches.'); process.exit(0); }

  if (worstN || roomWanted != null || only) {
    const rows = all.slice().sort((a, b) => b.ms - a.ms).slice(0, worstN || 30);
    console.log(pad('when', 10) + pad('who', 10) + pad('room', 34) + pad('->', 26) +
                pad('in room', 10) + pad('walking', 10) + pad('squares', 9) + 'outcome');
    for (const t of rows)
      console.log(pad(new Date(t.at).toISOString().slice(11, 19), 10) + pad(t.who, 10) +
                  pad(`${t.room_name ?? '?'} (${t.room})`, 34) +
                  pad(`${t.to_name ?? t.to ?? '?'}`, 26) +
                  pad(secs(t.ms), 10) + pad(t.walk_ms != null ? secs(t.walk_ms) : '-', 10) +
                  pad(t.tried, 9) + (t.ok ? 'left' : `FAILED — ${String(t.reason).slice(0, 44)}`));
    console.log('');
  }

  const rooms = byRoom(books, { failuresOnly });
  console.log(pad('room', 36) + pad('crossings', 11) + pad('failed', 8) +
              pad('median', 9) + pad('p90', 9) + pad('worst', 9) + 'squares/crossing');
  for (const r of rooms.slice(0, 25))
    console.log(pad(`${r.name ?? '?'} (${r.room})`, 36) + pad(r.crossings, 11) + pad(r.failed, 8) +
                pad(secs(r.median_ms), 9) + pad(secs(r.p90_ms), 9) + pad(secs(r.max_ms), 9) +
                r.squares_per_crossing);
  const every = all.map(t => t.ms).sort((a, b) => a - b);
  console.log('');
  console.log(`${all.length} crossings — median ${secs(pctile(every, 0.5))}, ` +
              `p90 ${secs(pctile(every, 0.9))}, p99 ${secs(pctile(every, 0.99))}, ` +
              `worst ${secs(every[every.length - 1])}. ` +
              `${all.filter(t => !t.ok).length} never got out.`);
  console.log('A map that cannot be crossed in under a minute is a map with a problem in ' +
              'it, not a big map.');
}
