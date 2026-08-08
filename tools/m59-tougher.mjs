// THE OPPOSITE OF A POSTMORTEM: WHAT IT TOOK TO GET TOUGHER.
//
//   node tools/m59-tougher.mjs              every max-health point the fleet has earned
//   node tools/m59-tougher.mjs --feed       the last 10 kills and deaths per character
//
// A point of maximum health is the only thing this fleet is actually for. Everything
// else — the safe spots, the vigor floors, the reagent runs, the signet rings — exists to
// buy more of them. There are 636 files describing the deaths and, until this, NOTHING
// describing the gains.
//
// AND THE SERVER ANNOUNCES EVERY ONE OF THEM. `player_improve_maxhealth`
// (player.kod:144) is the string "You suddenly feel a little tougher.", sent the instant
// GainBaseMaxHealth fires (player.kod:7838), followed by "You are invigorated by your
// success." and the tougher.wav. It has been arriving on the wire this whole time and
// nothing in this repository was listening for it. The ledger instead INFERRED gains by
// diffing five-minute samples — so two points in one window were one event, a point
// gained and a point lost in the same window were no event at all, and anything during a
// broker outage never happened. An announcement was being reconstructed from a snapshot.
//
// WHAT THE ANNOUNCEMENT LETS US SAY THAT THE DIFF COULD NOT: which creature paid for it.
// The roll happens inside the killing blow (player.kod:7827), so the kill that earned the
// point is the one immediately before the message. That is the question this whole file
// exists to answer — "Kermit is 24 because a spider in the Sewers of Barloque died", not
// "Kermit went from 23 to 24 sometime in the last five minutes".
//
// TWO RECORDS, AND THEY ARE KEPT DIFFERENTLY ON PURPOSE.
//
//   THE FEED is the last ten kills and deaths per character, in memory, gone when the
//   broker stops. That is the right lifetime for it: it answers "what is this character
//   doing right now", which is a question about the running process, and 21 characters
//   killing something every few seconds would be an enormous and worthless file.
//
//   THE GAINS are written to disk, one small file per character, and never rotated. A
//   character gains a point every few hours at best. They are the scarcest events the
//   fleet produces and the only ones that survive a death, so losing one to a restart is
//   losing the record of a whole evening's work.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const TOUGHER_DIR = process.env.M59_TOUGHER_DIR || here('../substrate/tougher');

// What the server says when it happens. Both lines are sent together; the first is the
// one that means it, and the second is matched too because a dropped packet should not
// cost us the record of a point that took three hours to earn.
export const TOUGHER_LINE = /you suddenly feel a little tougher/i;
export const INVIGORATED_LINE = /you are invigorated by your success/i;
export const isTougherText = (s) => TOUGHER_LINE.test(s || '') || INVIGORATED_LINE.test(s || '');

// Ten, because that is what a person can read at a glance and because this is a live
// feed rather than an archive. The gains file is where the long memory lives.
export const FEED_SIZE = Number(process.env.M59_FEED_SIZE || 10);

// HOW FAR FROM A KILL THE ANNOUNCEMENT MAY STILL BELONG TO IT — IN EITHER DIRECTION.
//
// The message is emitted synchronously inside the killing blow, so on the wire the two
// are simultaneous. Every bit of the gap is on our side, and it does not have a
// consistent sign:
//
//   the KILL is written down after fight() returns, which is after the corpse is looted
//   the MESSAGE is read at the top of the next pass, from the client's event ring
//
// So the kill is usually recorded a few milliseconds AFTER the message it caused. The
// first version of this required the kill to come first and produced exactly what you
// would expect — the fleet's very first recorded gain, Lew 22 -> 23 in The Queen's Way,
// filed with "cause unknown" while the kill that paid for it sat in the feed 40ms later.
// Ordering between our own two clocks is not evidence about anything, so it is not used:
// the window is symmetric and the NEAREST kill wins.
const ATTRIBUTE_MS = Number(process.env.M59_TOUGHER_ATTRIBUTE_MS || 15_000);

// The kill nearest in time to `at`, either side, within the window. Null if none.
const nearestKill = (feed, at) => feed
  .filter(e => e.kind === 'kill' && Math.abs(at - e.at) <= ATTRIBUTE_MS)
  .sort((a, b) => Math.abs(at - a.at) - Math.abs(at - b.at))[0] ?? null;

// agent/character -> { feed: [...], pendingGain: {...} | null }. Module-level, the same
// trick as the party register and claimedSpots: every session in this broker shares one
// process, and the fleet page wants all of them at once.
const feeds = new Map();
const feedOf = (character) => {
  let f = feeds.get(character);
  if (!f) { f = { character, feed: [], pendingGain: null }; feeds.set(character, f); }
  return f;
};

const push = (character, ev) => {
  const f = feedOf(character);
  f.feed.push(ev);
  if (f.feed.length > FEED_SIZE) f.feed.splice(0, f.feed.length - FEED_SIZE);
  return ev;
};

// ------------------------------------------------------------------ the gains on disk

const safeName = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
const fileFor = (character) => join(TOUGHER_DIR, `${safeName(character)}.json`);

export const emptyGains = (character) => ({ character: character ?? null, version: 1, gains: [] });

export function loadGains(character) {
  try { return { ...emptyGains(character), ...JSON.parse(readFileSync(fileFor(character), 'utf8')) }; }
  catch { return emptyGains(character); }
}

function saveGains(book) {
  if (!book?.character) return null;
  try {
    mkdirSync(TOUGHER_DIR, { recursive: true });
    writeFileSync(fileFor(book.character), JSON.stringify(book, null, 2));
    return fileFor(book.character);
  } catch { return null; }              // a failed write must never stop play
}

export const listCharacters = () => {
  try { return readdirSync(TOUGHER_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)); }
  catch { return []; }
};

// ------------------------------------------------------------------ recording

export function recordKill(character, { at = Date.now(), creature = null, room = null,
                                        room_num = null, level = null, rounds = null,
                                        looted = [], from_safe_spot = false } = {}) {
  const ev = push(character, { kind: 'kill', at, creature, room, room_num, level, rounds,
                               looted, from_safe_spot });
  // A GAIN THAT ARRIVED BEFORE ITS KILL WAS WRITTEN DOWN. The announcement is emitted
  // inside the killing blow and we record the kill after looting, so this is the normal
  // order, not the exception — without this, every attributed gain would say "unknown".
  const f = feedOf(character);
  if (f.pendingGain && Math.abs(at - f.pendingGain.at) <= ATTRIBUTE_MS) {
    const g = f.pendingGain;
    f.pendingGain = null;
    commitGain(character, { ...g, creature, room: room ?? g.room, room_num: room_num ?? g.room_num,
                            attributed: 'the kill was recorded just after the announcement' });
  }
  return ev;
}

export function recordDeath(character, { at = Date.now(), killer = null, observed = false,
                                         room = null, room_num = null, level = null,
                                         in_safe_spot = false } = {}) {
  return push(character, { kind: 'death', at, killer, observed, room, room_num, level, in_safe_spot });
}

// THE POINT ITSELF. `to` is the new maximum health; `creature` is whatever killed for it,
// which may not be known yet — see the pending path above.
export function recordGain(character, { at = Date.now(), from = null, to = null, room = null,
                                        room_num = null, creature = null, said = null } = {}) {
  const f = feedOf(character);
  if (creature) return commitGain(character, { at, from, to, room, room_num, creature, said,
                                               attributed: 'named at the moment of the gain' });
  // The nearest kill either side of the announcement. See ATTRIBUTE_MS for why "either
  // side" rather than "before".
  const recent = nearestKill(f.feed, at);
  if (recent)
    return commitGain(character, { at, from, to, said,
                                   creature: recent.creature,
                                   room: room ?? recent.room, room_num: room_num ?? recent.room_num,
                                   attributed: 'the kill nearest the announcement, ' +
                                     Math.abs(at - recent.at) + 'ms away' });
  // Otherwise hold it and let the next kill claim it. Held rather than written with a
  // null creature, because a gain with no cause is the thing this file exists to stop
  // producing — and if nothing claims it, flushPending() writes it honestly as unknown.
  f.pendingGain = { at, from, to, room, room_num, said };
  return null;
}

// THE SAME POINT MUST NOT BE WRITTEN TWICE. The gains file is the long memory and it is
// append-only in practice, so a duplicate is permanent and inflates the one number this
// fleet is judged on. The server sends two lines per gain and a reconnect can re-deliver
// events, so this is a real path rather than a theoretical one: a gain within a second of
// one already on the books is the same gain.
const DEDUPE_MS = 1000;

function commitGain(character, g) {
  const ev = push(character, { kind: 'gain', ...g });
  const book = loadGains(character);
  const dup = (book.gains || []).find(x => Math.abs((x.at ?? 0) - g.at) <= DEDUPE_MS);
  if (dup) {
    // Do not lose an attribution that arrived late. A gain first written with no cause,
    // then claimed by the kill that paid for it, should end up naming the creature.
    if (!dup.creature && g.creature) {
      dup.creature = g.creature;
      dup.room = dup.room ?? g.room ?? null;
      dup.room_num = dup.room_num ?? g.room_num ?? null;
      dup.attributed = g.attributed ?? dup.attributed;
      saveGains(book);
    }
    return ev;
  }
  book.gains.push({ at: g.at, from: g.from, to: g.to, creature: g.creature ?? null,
                    room: g.room ?? null, room_num: g.room_num ?? null,
                    attributed: g.attributed ?? null });
  book.gains.sort((a, b) => a.at - b.at);
  saveGains(book);
  return ev;
}

// A held gain that nothing ever claimed still happened, and after the window it is
// written with the cause left null rather than guessed at. Called on the keeper's pass,
// so the record lands within a second or two of the window closing.
export function flushPending(character, now = Date.now()) {
  const f = feeds.get(character);
  if (!f?.pendingGain || now - f.pendingGain.at <= ATTRIBUTE_MS) return null;
  const g = f.pendingGain;
  f.pendingGain = null;
  return commitGain(character, { ...g, creature: null,
                                 attributed: 'no kill was recorded near it — cause unknown' });
}

// ------------------------------------------------------------------ reading it back

export const feedFor = (character) => (feeds.get(character)?.feed ?? []).slice().reverse();
export const allFeeds = () => [...feeds.values()]
  .map(f => ({ character: f.character, feed: f.feed.slice().reverse(),
               pending_gain: !!f.pendingGain }))
  .filter(f => f.feed.length);

// Every gain the fleet has on disk, newest first, joined across characters. This is the
// TOUGHER page's whole dataset.
export function allGains({ sinceMs = null, limit = 2000 } = {}) {
  const cutoff = sinceMs ? Date.now() - sinceMs : null;
  const out = [];
  for (const c of listCharacters())
    for (const g of loadGains(c).gains || [])
      if (!cutoff || g.at >= cutoff) out.push({ character: c, ...g });
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, limit);
}

// What is actually paying. A creature that yields ten points across the fleet is worth
// hunting; one that yields none, however many die, is the thing the yield check exists to
// catch. Rooms the same — this is the positive image of the deaths treemap.
export function toughSummary(gains) {
  const by = (keyOf) => {
    const m = new Map();
    for (const g of gains) {
      const k = keyOf(g);
      if (k == null) continue;
      const e = m.get(k) ?? { name: k, value: 0, children: new Map() };
      e.value++;
      e.children.set(g.character, (e.children.get(g.character) || 0) + 1);
      m.set(k, e);
    }
    return [...m.values()].map(e => ({
      name: e.name, value: e.value,
      children: [...e.children.entries()].sort((a, b) => b[1] - a[1])
        .map(([name, value]) => ({ name, value })),
    })).sort((a, b) => b.value - a.value);
  };
  return {
    total: gains.length,
    by_creature: by(g => g.creature),
    by_room: by(g => g.room),
    by_character: by(g => g.character),
    unattributed: gains.filter(g => !g.creature).length,
  };
}

// ------------------------------------------------------------------ the command line

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gains = allGains({});
  const s = toughSummary(gains);
  console.log(`${s.total} max-health points on record` +
              (s.unattributed ? ` (${s.unattributed} with no cause recorded)` : ''));
  if (!s.total) {
    console.log('\nNothing yet. The record starts when a broker running this code sees');
    console.log('"You suddenly feel a little tougher." — it cannot be backfilled, because');
    console.log('the announcement was never written down before now.');
  }
  const table = (title, rows) => {
    if (!rows.length) return;
    console.log('\n' + title);
    for (const r of rows.slice(0, 12)) console.log('  ' + String(r.value).padStart(4) + '  ' + r.name);
  };
  table('WHAT PAID FOR THEM', s.by_creature);
  table('WHERE THEY WERE EARNED', s.by_room);
  table('WHO EARNED THEM', s.by_character);
}
