#!/usr/bin/env node
// WHO HAS ATTACKED THIS FLEET, AND FOR HOW LONG THAT STILL COUNTS.
//
//   node tools/m59-grudge.mjs              # who is on the list, and when they earned it
//   node tools/m59-grudge.mjs --clear      # forget everybody
//   node tools/m59-grudge.mjs --forgive "Name"
//
// A monster and a player are not the same problem, and the difference this file exists
// for is MEMORY. A monster does not follow you to another town, does not wait, and does
// not come back tomorrow. A person does all three — so a fleet that only reacts to the
// blow currently landing is defenceless against somebody who hits one character, walks
// away, and hits the next one in a different room ten minutes later.
//
// So an attack is written down, fleet-wide, and stays written down for an hour.
//
// ---------------------------------------------------------------------------
// THE THREE THINGS THAT MUST ALL BE TRUE BEFORE WE SWING, AND WHY IT IS THREE
//
//   1. THE GRUDGE — this name attacked one of ours inside the window. That is memory,
//      and memory is the part that can go stale or be wrong.
//   2. THE LIVE FLAG — the object in front of us RIGHT NOW carries PF_KILLER or
//      PF_OUTLAW. That is the server's current opinion, re-read every time.
//   3. THE SERVER'S OWN SAFETY — `PFLAG_SAFETY` stays ON, and the server refuses any
//      attack on a player who is neither murderer nor outlaw
//      ("Hey! You almost hit %s%s! Good thing your safety was on!", player.kod:177).
//
// Only the first is ours to get wrong, and the other two are what contain it. That is
// the whole safety argument, and it is why this file does not need to be clever.
//
// ---------------------------------------------------------------------------
// KEYED ON THE NAME, WHICH IS THE WEAKER KEY, AND DELIBERATELY
//
// Everything else in this repository that identifies a character insists on the OBJECT
// ID, because names are chosen by their owners and two players can be made confusingly
// alike. That rule is right and it does not apply here, for a reason that is worth
// stating rather than discovering:
//
//   * `guild spread` matches OURS by object id because a live session gives us one that
//     the server itself vouches for.
//   * A STRANGER GIVES US NO SESSION, and object ids are renumbered by the server on
//     every save — the trap this repository already records, where a character resolved
//     as 7218 and half an hour later 7218 was a heartstone. An hour-long grudge keyed on
//     an id would, by design, outlive the id.
//
// So the durable key is the name, and the cost of that choice is bounded by rule 2: to
// be attacked under a stolen or coincidental name you must ALSO be currently flagged by
// the server as a murderer or outlaw. The worst available error is that we return fire
// on a red-named stranger who did not personally attack us — which the server permits,
// which carries no murderer or outlaw penalty (player.kod:4856), and which is a long way
// short of hitting an innocent.
//
// ---------------------------------------------------------------------------
// THE RECORD IS THE FLEET'S, NOT A CHARACTER'S
//
// One character being hit is the whole fleet's information. The file is shared, written
// by whoever was attacked and read by everyone, so nine characters in a room all defend
// the one that got hit — which is the point, and which no per-keeper field could do.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName, resolveFleet } from './m59-fleetpath.mjs';
import { rosterCharacterNames } from './m59-party.mjs';
import { warHostility } from './m59-war.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..', '..');

// ONE BOOK PER FLEET, BECAUSE A GRUDGE IS ABOUT PLAYERS ON ONE SERVER.
//
// The book was shared by every fleet on this machine, and a fleet is a server. So the
// shadow fleet — a copy of production running on a LOCAL test server that no other player
// can reach — inherited production's twenty-two grudges, including one with fifty-five
// hits that is refreshed every time a real person attacks a real character.
//
// That is not cosmetic. `travel_hold_pvp` defaults to `refuse`: no stopping at a safe wall
// while the grudge book has a live entry, on the sound reasoning that a stationary
// character with a full pack is the best target this game offers. So every shadow
// character crossing Ukgoth declined to take a wall — because of a fight happening on a
// different server, against people who do not exist in its world. Recorded verbatim in its
// own ledger while three characters were being killed by trolls in that room:
//
//     did not consider a wall :: 1 live grudge(s) — PvP is anticipated
//
// The fleet name is resolved the same way everything else resolves it, so `--fleet`,
// `M59_FLEET` and `substrate/fleet-default` all reach here. `M59_GRUDGE_FILE` still wins
// outright, which is what the tests use.
//
// A NAMED FLEET STARTS ITS OWN BOOK EMPTY rather than inheriting the shared one. Inheriting
// is what this is fixing, and a book that arrives pre-populated with another server's
// enemies is the bug wearing a migration. The unnamed fleet keeps `grudges.json`, so
// nothing that was already using it changes file.
export const GRUDGE_FILE = () => {
  if (process.env.M59_GRUDGE_FILE) return process.env.M59_GRUDGE_FILE;
  let name = null;
  try { name = fleetName(); } catch { name = null; }
  return join(HERE, 'substrate', name ? `grudges-${name}.json` : 'grudges.json');
};

// AN HOUR, AND IT IS A BET RATHER THAN A MECHANIC — so it is overridable and the default
// is written down here rather than scattered. Long enough that walking away and coming
// back does not reset it; short enough that somebody who was flagged this morning and has
// left us alone since is not a standing target all day.
export const GRUDGE_MS = 60 * 60 * 1000;

// Names come off the wire and are chosen by their owners. Fold case and whitespace so
// "  Foo " and "foo" are one grudge, and cap the length so a pathological name cannot
// bloat the file.
export const normName = n => String(n ?? '').trim().replace(/\s+/g, ' ').slice(0, 64).toLowerCase();

function readAll() {
  const file = GRUDGE_FILE();
  try {
    if (!existsSync(file)) return {};
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.grudges) ? raw.grudges : {};
  } catch {
    // A FILE THAT WILL NOT PARSE IS NOT AN EMPTY LIST OF ENEMIES — but here those two
    // happen to mean the same thing, because an empty list means "defend nobody
    // pre-emptively", which is the safe direction. If this ever gains a rule that fires
    // on ABSENCE from the list, this has to become an error instead.
    return {};
  }
}

function writeAll(grudges) {
  const file = GRUDGE_FILE();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ format: 'm59-grudges/1', grudges }, null, 1));
    return true;
  } catch { return false; }
}

// Cached on mtime, exactly like a loadout and a playbook: the keeper asks this every
// pass, for every character, so the steady-state cost has to be a stat().
let cache = { mtime: -1, value: {} };
function current() {
  const file = GRUDGE_FILE();
  let mtime = 0;
  try { mtime = existsSync(file) ? statSync(file).mtimeMs : 0; } catch { mtime = 0; }
  if (cache.mtime !== mtime) cache = { mtime, value: readAll() };
  return cache.value;
}

/**
 * Write down that a flagged player attacked one of ours.
 *
 * `first` is kept as well as `at`, because "started on us forty minutes ago" and "hit us
 * once just now" are different situations and only one of them is a campaign. Re-dating
 * moves `at` and never `first` — the same rule the loyalty warning follows, and for the
 * same reason: re-dating the start of something on every repeat means it never has an age.
 */
export function recordAttack(name, { who = null, room = null, at = Date.now(),
                                     playerClass = null } = {}) {
  const key = normName(name);
  if (!key) return null;
  const all = readAll();                       // read-modify-write, not the cache
  const prev = all[key] ?? null;
  const row = {
    name: String(name).trim().slice(0, 64),
    first: prev?.first ?? at,
    at,
    hits: (prev?.hits ?? 0) + 1,
    // Who of ours, and where. A list rather than a counter: "has hit six of us" is the
    // fact that says this is aimed at the fleet rather than at one unlucky character.
    victims: [...new Set([...(prev?.victims ?? []), who].filter(Boolean))].slice(0, 32),
    last_room: room ?? prev?.last_room ?? null,
    player_class: playerClass ?? prev?.player_class ?? null,
  };
  all[key] = row;
  writeAll(all);
  cache = { mtime: -1, value: all };           // our own write; do not wait for a stat
  return row;
}

/** Is this name owed a return blow — as memory alone, before any live check? */
export function grudgeAgainst(name, { now = Date.now(), window = GRUDGE_MS } = {}) {
  const row = current()[normName(name)];
  if (!row) return null;
  if (now - row.at > window) return null;
  return { ...row, age_ms: now - row.at, expires_in_ms: window - (now - row.at) };
}

/**
 * THE ONE CALL A KEEPER MAKES. Everything defensive should ask this and nothing else,
 * because it is the only place all three conditions are checked together.
 *
 * @param {object} target   {name, flags} straight off the room's object map
 * @param {object} opts     {now, window, fleetmate}
 * @returns {{engage: boolean, why: string, grudge?: object}}
 */
export function mayReturnFire(target, { now = Date.now(), window = GRUDGE_MS,
                                        fleetmate = false } = {}) {
  const flags = Number(target?.flags ?? 0);
  const name = target?.name ?? null;
  // A FLEETMATE IS NEVER A TARGET, and this is checked first and separately rather than
  // being left to the flag test. `party.isFleetmate` can be briefly wrong just after a
  // restart, so the flag test is what actually protects us — but a fleet that could in
  // principle decide to shoot at itself is not one to leave one condition away from it.
  if (fleetmate) return { engage: false, why: 'one of ours' };
  if (!(flags & 0x00000004)) return { engage: false, why: 'not a player' };
  if (!(flags & 0x00000008)) return { engage: false, why: 'not attackable' };
  // A GUILD WAR IS THE OTHER THING THAT MAKES A PLAYER FAIR GAME, and it needs no grudge.
  // 2026-09-30: 117 of prod's last 150 deaths were three Human Resistance members, every one a
  // "guild combat" kill that flags nobody (player.kod:4868) — so rule 2 below answered "not
  // flagged" to all of them and the fleet never swung back. The server marks a member of a
  // MUTUALLY warring guild with PLAYER_IS_ENEMY on every object it sends; the war book adds
  // members remembered from a look or a kill broadcast. Rule 3 still holds and is what makes
  // the memory safe: a mutual war passes the server's safety check with safety ON
  // (player.kod:3803), and somebody who has since left the guild is refused rather than hit.
  // See tools/m59-war.mjs.
  const war = warHostility(target, { fleetmate, now });
  if (war.hostile) return { engage: true, war: war.basis, grudge: grudgeAgainst(name, { now, window }),
                            why: `at war: ${war.why}` };
  // Rule 2, the live flag. Read from THIS object, this moment — never from the record.
  const cls = (flags & 0x0001C000) >>> 0;
  if (cls !== 0x4000 && cls !== 0x8000)
    return { engage: false, why: 'not flagged a murderer or outlaw right now — the ' +
                                 'server would refuse this attack and it should' };
  // Rule 1, the memory.
  const g = grudgeAgainst(name, { now, window });
  if (!g) return { engage: false, why: 'flagged, but has not attacked this fleet — ' +
                                       'being a murderer is not by itself our business' };
  return { engage: true, grudge: g,
           why: `attacked ${g.victims.join(', ') || 'this fleet'} ${Math.round(g.age_ms / 60000)}m ` +
                `ago and is still flagged ${cls === 0x4000 ? 'a murderer' : 'an outlaw'}` };
}

/** Everyone still inside the window, freshest first. */
export function activeGrudges({ now = Date.now(), window = GRUDGE_MS } = {}) {
  return Object.values(current())
    .filter(r => now - r.at <= window)
    .sort((a, b) => b.at - a.at)
    .map(r => ({ ...r, age_ms: now - r.at }));
}

export function forgive(name) {
  const all = readAll();
  const key = normName(name);
  if (!(key in all)) return false;
  delete all[key];
  writeAll(all);
  cache = { mtime: -1, value: all };
  return true;
}

/**
 * Forget every name in `names`, in one read-modify-write. Returns the names removed, as
 * the book had them. This exists because THE BOOK MUST NEVER NAME OUR OWN PEOPLE and
 * for two days it did — see `rosterFileSource` in m59-party.mjs — so the repair is a
 * verb rather than twenty-one `--forgive`s, each of which races the keepers still writing.
 */
export function forgiveAll(names) {
  const all = readAll();
  const removed = [];
  for (const n of names ?? []) {
    const key = normName(n);
    if (key && key in all) { removed.push(all[key]?.name ?? String(n)); delete all[key]; }
  }
  if (removed.length) { writeAll(all); cache = { mtime: -1, value: all }; }
  return removed;
}

export function clearAll() { writeAll({}); cache = { mtime: -1, value: {} }; return true; }

// ---------------------------------------------------------------------------- CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  if (argv.includes('--clear')) { clearAll(); console.log('forgot everybody'); }
  else if (argv.includes('--forgive-ours')) {
    // Every ROSTER name out of this fleet's book, the strangers left alone. The roster is
    // resolved the way everything else resolves it (`--fleet`, M59_FLEET, fleet-default).
    const { stateFile } = resolveFleet(argv);
    let ours;
    try { ours = rosterCharacterNames(JSON.parse(readFileSync(stateFile, 'utf8'))); }
    catch (e) { console.error(`cannot read the roster at ${stateFile}: ${e.message}`); process.exit(1); }
    const removed = forgiveAll(ours);
    console.log(removed.length
      ? `forgave ${removed.length} of ours (roster: ${ours.size}): ${removed.join(', ')}`
      : `none of ours in the book (roster: ${ours.size})`);
    const left = Object.keys(readAll()).length;
    console.log(`${left} entr${left === 1 ? 'y' : 'ies'} remain, none of them ours`);
  }
  else if (argv.includes('--forgive')) {
    const who = argv[argv.indexOf('--forgive') + 1];
    console.log(forgive(who) ? `forgave ${who}` : `no grudge against ${who}`);
  } else {
    const rows = activeGrudges();
    if (!rows.length) console.log('nobody has attacked this fleet in the last hour');
    else {
      console.log(`${rows.length} active grudge(s) — the window is ${GRUDGE_MS / 60000} minutes\n`);
      console.log(`${'who'.padEnd(20)}${'last'.padStart(7)}${'hits'.padStart(6)}  attacked`);
      for (const r of rows)
        console.log(`${r.name.padEnd(20)}${(Math.round(r.age_ms / 60000) + 'm').padStart(7)}` +
                    `${String(r.hits).padStart(6)}  ${r.victims.join(', ')}`);
      console.log('\nA grudge alone never starts a fight: the target must ALSO be carrying');
      console.log('PF_KILLER or PF_OUTLAW at the moment we look at it.');
    }
  }
}
