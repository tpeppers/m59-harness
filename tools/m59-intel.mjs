#!/usr/bin/env node
// m59-intel.mjs — player sighting tracker, target manager, and conflict coordinator.
//
// THIS MODULE IS EVIDENCE, NEVER AUTHORITY. Nothing here decides that a character may
// swing at a person. `m59-grudge.mjs:mayReturnFire` is the only place all three
// conditions are checked together — the grudge, the live PF flag, and the fleetmate
// test — and a target listed here can only NARROW that answer, never widen it. See
// `engagePlayerTarget` in m59-autopilot.mjs, where the two are composed with `&&`.
//
// IT ALSO HAS NO OPINION ABOUT WHO IS OURS. It used to answer that itself, off
// substrate/fleet-state.json, which is the UNNAMED fleet's roster — so on a machine
// whose broker holds `prod` it excluded thirty-four characters nobody plays and not one
// of the twenty-one that were live. Every entry point that could name a fleetmate now
// takes an `isFleetmate` predicate from its caller, and the caller passes
// `m59-party.mjs:isFleetmate`, which the broker backs with the live sessions unioned
// with the roster it actually loaded.
//
// Storage layout:
//   substrate/players-seen.json          — index: one entry per player, last-seen summary
//   substrate/player-history/<name>.jsonl — full append-only sighting trail per player
//   substrate/targets.json               — auto-attack target list
//   substrate/active-conflicts-<fleet>.json  — live fleet conflicts (TTL-based), PER FLEET
//
// CLI:
//   node tools/m59-intel.mjs                     — sightings summary
//   node tools/m59-intel.mjs --player <name>     — full history for one player
//   node tools/m59-intel.mjs --targets           — target list
//   node tools/m59-intel.mjs --add <name> [--auto-attack]
//   node tools/m59-intel.mjs --remove <name>
//   node tools/m59-intel.mjs --heatmap <name>    — room frequency for one player

import { readFileSync, writeFileSync, existsSync,
         mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';

const HERE      = dirname(fileURLToPath(import.meta.url));
const SUBSTRATE = join(HERE, '..', 'substrate');
export const INTEL_DIR = process.env.M59_INTEL_DIR || SUBSTRATE;

const SEEN_PATH       = join(INTEL_DIR, 'players-seen.json');
const TARGETS_PATH    = join(INTEL_DIR, 'targets.json');
// A CONFLICT BOOK IS PER FLEET, BECAUSE A CALL FOR HELP IS AN ORDER TO MOVE.
//
// This was one file for the whole machine, and two fleets run here. Measured 2026-08-27:
// ten SHADOW characters that had just arrived at Outside Castle Victoria left it within two
// seconds of each other and crossed into Ukgoth — the most dangerous room on their route —
// because a PROD character was in a fight. The keeper's own journal said so in plain words:
//
//     "Scooter is fighting Morpheus — travelling to assist"
//
// Scooter is prod. Aaaa is shadow. They are different accounts on different servers, and one
// fleet answered the other's call because they shared a file.
//
// Everything else per-fleet in this repository is already named for its fleet —
// `tactics/<fleet>.jsonl`, `broker-<fleet>.log`, `fleets/<fleet>.json` — and resolved through
// `fleetName()` rather than by reading the environment here. The tithe book and the tactics
// ledger were each caught getting exactly this wrong; see the note at the top of
// m59-tactics.mjs.
// EXPORTED, so the two read-only consumers ask this rather than rebuilding the name. A
// reader left pointing at the old fixed path does not error — it finds no file and shows an
// empty board, which is the quietest possible way for a rename to go wrong.
export const conflictsPath = () =>
  join(INTEL_DIR, `active-conflicts-${String(fleetName() || 'default').replace(/[^\w.-]/g, '_')}.json`);
const CONFLICTS_PATH = conflictsPath;
const HISTORY_DIR     = join(INTEL_DIR, 'player-history');
const MAP_PATH        = join(SUBSTRATE, 'm59-map.json');

// A conflict expires after this long with no updates.
const CONFLICT_TTL_MS    = 2 * 60_000;
// Sightings within this window trigger "suspicious".
const SUSPICIOUS_SIGHTINGS = 3;
const SUSPICIOUS_WINDOW_MS = 10 * 60_000;

// ------------------------------------------------------------------ room name cache

let _map = null;
function roomName(num) {
  if (num == null) return null;
  if (!_map) {
    try { _map = JSON.parse(readFileSync(MAP_PATH, 'utf8')); } catch { _map = {}; }
  }
  return (_map.rooms?.[num] ?? _map[num])?.name ?? null;
}

// ------------------------------------------------------------------ file I/O

function readJSON(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJSON(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}

function readSeen()        { return readJSON(SEEN_PATH)    ?? {}; }
function saveSeen(d)       { writeJSON(SEEN_PATH, d); }
function readTargets()     { return readJSON(TARGETS_PATH) ?? {}; }
function saveTargets(d)    { writeJSON(TARGETS_PATH, d); }
function readConflicts()   { return readJSON(CONFLICTS_PATH()) ?? {}; }
function saveConflicts(d)  { writeJSON(CONFLICTS_PATH(), d); }

// ------------------------------------------------------------------ per-player history

function historyPath(name) {
  // Sanitise the name so it is safe as a filename.
  const safe = name.replace(/[^a-zA-Z0-9_\-. ]/g, '_');
  return join(HISTORY_DIR, `${safe}.jsonl`);
}

function appendHistory(name, record) {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  appendFileSync(historyPath(name), JSON.stringify(record) + '\n', 'utf8');
}

// Read full history for a player. Returns array of records, newest first.
export function readHistory(name) {
  const path = historyPath(name);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .reverse();
  } catch { return []; }
}

// Compute room frequency heatmap from full history.
export function roomHeatmap(name) {
  const hist = readHistory(name);
  const freq = {};
  for (const r of hist) {
    if (r.room == null) continue;
    freq[r.room] = (freq[r.room] ?? 0) + 1;
  }
  return Object.entries(freq)
    .map(([room, count]) => ({ room: Number(room), name: roomName(Number(room)), count }))
    .sort((a, b) => b.count - a.count);
}

// ------------------------------------------------------------------ sighting API

// Runtime edge detector, shared by every actor in one lab shard. The durable book is an
// encounter log, not a frame log: an unchanged stranger standing in an unchanged room
// must not synchronously parse and rewrite the whole index on every policy pass. Each
// observer retains only its current stranger set, so leave/re-enter and room transitions
// remain observable without an unbounded history cache.
const liveSightingsByObserver = new Map();

// WHO WAS STANDING THERE. `isFleetmate` is REQUIRED and is the caller's to supply —
// there is deliberately no default, because the default this function used to have was
// wrong on this machine and silently so. A caller that cannot answer should pass
// `() => false` on purpose and know that it is filing its own fleet as strangers.
export function recordSightings(observer, players, room, isFleetmate) {
  if (typeof isFleetmate !== 'function')
    throw new TypeError('recordSightings needs an isFleetmate predicate — see m59-party.mjs');
  // Filter before touching disk. In a fleet room the common answer is "everybody here is
  // ours"; reading and rewriting the full global book for that non-event was synchronous
  // work on every keeper pass, plus a cross-process lost-update race.
  const strangers = (players ?? []).filter(p =>
    p?.name && p.name !== observer && !isFleetmate(p.name));
  const observerKey = String(observer ?? '');
  const previous = liveSightingsByObserver.get(observerKey) ?? new Map();
  const current = new Map(strangers.map(player => [player.name, {
    room,
    object_id: player.id ?? null,
  }]));
  liveSightingsByObserver.set(observerKey, current);
  const changed = strangers.filter(player => {
    const before = previous.get(player.name);
    return !before || before.room !== room || before.object_id !== (player.id ?? null);
  });
  if (!changed.length) return;
  const now     = Date.now();
  const seen    = readSeen();
  const rname   = roomName(room);

  for (const p of changed) {

    // --- update the index entry ---
    const entry = seen[p.name] ?? {
      name:        p.name,
      object_id:   p.id,
      first_seen:  now,
      total_sightings: 0,
      threat_level: 'none',
    };

    const isNewRoom = entry.last_room !== room;

    entry.object_id      = p.id;
    entry.last_seen      = now;
    entry.last_room      = room;
    entry.last_room_name = rname;
    entry.last_seen_by   = observer;
    entry.total_sightings = (entry.total_sightings ?? 0) + 1;

    // Keep a compact recent-sightings ring for the suspicious check (last 200).
    entry.recent = [...(entry.recent ?? []), { at: now, room }].slice(-200);
    const recentCount = entry.recent.filter(s => now - s.at < SUSPICIOUS_WINDOW_MS).length;
    if (recentCount >= SUSPICIOUS_SIGHTINGS && entry.threat_level === 'none') {
      entry.threat_level = 'suspicious';
    }

    seen[p.name] = entry;

    // --- append to per-player history file (one record per room change) ---
    // We only write when the room changes to avoid flooding the file on every pass.
    if (isNewRoom || !entry._last_history_room) {
      entry._last_history_room = room;
      appendHistory(p.name, {
        at:       now,
        iso:      new Date(now).toISOString(),
        room,
        room_name: rname,
        observer,
        object_id: p.id,
      });
    }
  }

  saveSeen(seen);
}

// ------------------------------------------------------------------ target API

// AUTO-ATTACK IS OFF UNLESS SOMEBODY ASKS FOR IT, and it is an operator's word rather
// than something the fleet writes about itself. It used to default TRUE and be called by
// the keeper the moment anything hit it, which made a permanent, fleet-wide kill order
// out of one contact — where `m59-grudge.mjs` records the same event as evidence that
// expires in an hour. Even set, it cannot authorise a swing on its own; see the header.
export function addTarget(name, { auto_attack = false, reason = null, assigned_to = null } = {}) {
  if (!name) return;
  const targets = readTargets();
  const seen    = readSeen();

  targets[name] = {
    name,
    auto_attack,
    reason:      reason ?? 'attacked fleet member',
    added_at:    Date.now(),
    assigned_to,
    kills:       targets[name]?.kills ?? 0,
  };

  if (seen[name]) { seen[name].threat_level = 'target'; saveSeen(seen); }
  saveTargets(targets);
  return targets[name];
}

export function removeTarget(name) {
  const targets = readTargets();
  if (!targets[name]) return false;
  delete targets[name];
  saveTargets(targets);

  const seen = readSeen();
  if (seen[name]?.threat_level === 'target') {
    seen[name].threat_level = 'suspicious';
    saveSeen(seen);
  }
  return true;
}

export function getTargets() { return readTargets(); }

export function recordTargetKill(killerName, victimName) {
  const targets = readTargets();
  if (!targets[victimName]) return;
  targets[victimName].kills = (targets[victimName].kills ?? 0) + 1;
  targets[victimName].last_killed_at = Date.now();
  targets[victimName].last_killed_by = killerName;
  saveTargets(targets);

  const seen = readSeen();
  if (seen[victimName]) {
    seen[victimName].confirmed_kills = (seen[victimName].confirmed_kills ?? 0) + 1;
    seen[victimName].last_killed_at  = Date.now();
    saveSeen(seen);
  }

  appendHistory(victimName, {
    at:      Date.now(),
    iso:     new Date().toISOString(),
    event:   'killed_by_fleet',
    killer:  killerName,
  });
}

export function isAutoAttackTarget(name) {
  if (!name) return false;
  return !!(readTargets()[name]?.auto_attack);
}

export function targetsFor(characterName) {
  return Object.values(readTargets()).filter(t =>
    t.auto_attack && (t.assigned_to == null || t.assigned_to === characterName));
}

// ------------------------------------------------------------------ conflict tracking

export function declareConflict(reporter, targetName, room) {
  const now       = Date.now();
  const conflicts = readConflicts();
  conflicts[targetName] = {
    target:     targetName,
    room,
    room_name:  roomName(room),
    reporter,
    // WHOSE CALL THIS IS. The file is already per fleet, so this is belt and braces — but
    // the failure it guards against is a file that OUTLIVES the split: an
    // `active-conflicts.json` left on disk from before the rename, copied between checkouts,
    // or written by an older broker still running. A record that cannot say which fleet it
    // belongs to is one `activeConflicts` has to either trust or discard, and trusting it is
    // how ten shadow characters answered a prod fight.
    fleet:      fleetName() || null,
    started_at: conflicts[targetName]?.started_at ?? now,
    updated_at: now,
    expires_at: now + CONFLICT_TTL_MS,
  };
  saveConflicts(conflicts);
}

export function clearConflict(targetName) {
  const conflicts = readConflicts();
  if (!conflicts[targetName]) return;
  delete conflicts[targetName];
  saveConflicts(conflicts);
}

export function activeConflicts() {
  const now       = Date.now();
  const conflicts = readConflicts();
  const mine      = fleetName() || null;
  const live      = {};
  let changed     = false;
  for (const [name, c] of Object.entries(conflicts)) {
    if (now >= c.expires_at) { changed = true; continue; }
    // A CALL FROM ANOTHER FLEET IS NOT A CALL. Dropped rather than returned, and dropped
    // SILENTLY rather than saved away — an old shared file should empty itself out through
    // the TTL rather than be rewritten into this fleet's book under this fleet's name.
    if (c.fleet && mine && c.fleet !== mine) { changed = true; continue; }
    live[name] = c;
  }
  if (changed) saveConflicts(live);
  return live;
}

// ------------------------------------------------------------------ GOAP state helpers

export function intelStateFor(characterName, roomNum) {
  const seen    = readSeen();
  const targets = readTargets();
  const now     = Date.now();
  const recentWindow = 2 * 60_000;

  const playersNearby = Object.values(seen)
    .filter(s => s.last_room === roomNum && s.last_seen_by === characterName
                 && now - (s.last_seen ?? 0) < recentWindow)
    .map(s => s.name);

  const threatNearby = playersNearby.some(name => targets[name]?.auto_attack);
  return { players_nearby: playersNearby, threat_nearby: threatNearby };
}

// ------------------------------------------------------------------ analytics helpers (for page)

// Movement trail: last N distinct room changes, with timestamps and room names.
export function movementTrail(name, limit = 20) {
  return readHistory(name)
    .filter(r => r.room != null && !r.event)
    .slice(0, limit)
    .map(r => ({ ...r, room_name: r.room_name ?? roomName(r.room) }));
}

// Summary stats for a player: total sightings, unique rooms, first/last seen, most common zone.
export function playerStats(name) {
  const index = readSeen()[name];
  const heat  = roomHeatmap(name);
  const hist  = readHistory(name).filter(r => !r.event);
  const uniqueRooms = new Set(hist.map(r => r.room)).size;
  const observers   = {};
  for (const r of hist) if (r.observer) observers[r.observer] = (observers[r.observer] ?? 0) + 1;

  return {
    name,
    total_sightings:  index?.total_sightings ?? 0,
    unique_rooms:     uniqueRooms,
    first_seen:       index?.first_seen ?? null,
    last_seen:        index?.last_seen  ?? null,
    last_room:        index?.last_room  ?? null,
    last_room_name:   index?.last_room_name ?? roomName(index?.last_room),
    threat_level:     index?.threat_level ?? 'none',
    confirmed_kills:  index?.confirmed_kills ?? 0,
    top_rooms:        heat.slice(0, 5),
    most_seen_by:     Object.entries(observers).sort((a,b) => b[1]-a[1])[0]?.[0] ?? null,
  };
}

// All known player names from the history directory.
export function knownPlayers() {
  if (!existsSync(HISTORY_DIR)) return [];
  return readdirSync(HISTORY_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => f.slice(0, -6).replace(/_/g, ' '));  // rough reverse of sanitisation
}

// ------------------------------------------------------------------ CLI

// `pathToFileURL`, not a hand-built `file://` string — see m59-path-test.mjs: a manual
// URL leaves spaces percent-encoded and needs drive-letter repair on Windows, so the tool
// silently stops being a CLI on any path with a space in it.

// ---------------------------------------------------------------------------
// READ-ONLY ANALYTICS over the sighting trail, carried across from the other
// checkout's /players page. Every one of these reads readHistory() and nothing
// else — none of them touches the fleetmate question, which is why they could
// be lifted onto this file's corrected recordSightings without adjustment.
// ---------------------------------------------------------------------------
export const ZONE_MAP = {
  // Ileria (barrows/clearing)
  534: 'Ileria', 535: 'Ileria', 536: 'Ileria', 544: 'Ileria',
  545: 'Ileria', 556: 'Ileria', 557: 'Ileria',
  // Raza
  1016: 'Raza', 1017: 'Raza', 1018: 'Raza',
  // Tos-area
  586: 'Tos', 596: 'Tos', 597: 'Tos',
  // Graveyard
  623: 'Graveyard', 624: 'Graveyard', 625: 'Graveyard', 626: 'Graveyard',
  // Marion / main areas
  301: 'Marion', 302: 'Marion', 303: 'Marion', 304: 'Marion',
  // Haven
  1: 'Haven', 2: 'Haven', 3: 'Haven',
  // Underworld
  900: 'Underworld', 901: 'Underworld', 902: 'Underworld',
};

// Hourly sighting distribution from per-player history. UTC hours 0..23.
// Returns a 24-element array of counts. Empty histories yield all zeros.
export function timeOfDayPattern(name) {
  const hist = readHistory(name).filter(r => r.at != null);
  const hours = new Array(24).fill(0);
  for (const r of hist) {
    const d = new Date(r.at);
    if (Number.isNaN(d.getTime())) continue;
    hours[d.getUTCHours()] += 1;
  }
  return hours;
}

// Per-zone frequency, derived from history and a room -> zone map.
// Rooms not present in zoneMap fall into "Other".
// Returns: { zone_name: count, ... } sorted by frequency desc.
export function zonePattern(name, zoneMap = ZONE_MAP) {
  const hist  = readHistory(name).filter(r => r.room != null);
  const freq  = {};
  for (const r of hist) {
    const zone = zoneMap[r.room] ?? 'Other';
    freq[zone] = (freq[zone] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(freq).sort((a, b) => b[1] - a[1])
  );
}

// Detect whether `name` may be following a fleet member. Compares their histories
// and counts cases where this player entered the same room within 60s of the fleet
// member doing the same. Confidence = matches / total_fleet_moves_in_window.
// fleetHistory may be:
//   - an array of history records (preferred), or
//   - a name whose history file we will read ourselves.
// Returns: { following, confidence, matches, fleet_moves, evidence: [...] }
// evidence is capped at 10 entries.
export function followingDetection(name, fleetHistory) {
  let fleet;
  if (Array.isArray(fleetHistory)) {
    fleet = fleetHistory;
  } else if (typeof fleetHistory === 'string') {
    fleet = readHistory(fleetHistory);
  } else {
    return { following: false, confidence: 0, matches: 0, fleet_moves: 0, evidence: [] };
  }

  const player = readHistory(name);
  if (!player.length || !fleet.length) {
    return { following: false, confidence: 0, matches: 0, fleet_moves: 0, evidence: [] };
  }

  // Index player room changes by room for quick lookup.
  const playerByRoom = {};
  for (const r of player) {
    if (r.room == null || r.at == null) continue;
    (playerByRoom[r.room] ??= []).push(r.at);
  }
  for (const room of Object.keys(playerByRoom)) playerByRoom[room].sort((a, b) => a - b);

  let matches = 0;
  const evidence = [];
  for (const f of fleet) {
    if (f.room == null || f.at == null) continue;
    const candidates = playerByRoom[f.room];
    if (!candidates) continue;
    // Find a player entry within +/- 60s of the fleet entry.
    const hit = candidates.find(t => Math.abs(t - f.at) <= 60_000);
    if (hit != null) {
      matches += 1;
      if (evidence.length < 10) evidence.push({ at: hit, room: f.room, fleet_at: f.at });
    }
  }

  const fleet_moves  = fleet.filter(f => f.room != null && f.at != null).length;
  const confidence   = fleet_moves > 0 ? matches / fleet_moves : 0;
  return {
    following:   confidence > 0.3 && matches >= 3,
    confidence:  Number(confidence.toFixed(3)),
    matches,
    fleet_moves,
    evidence,
  };
}

// All known player names from the history directory.

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);

  const fmtAgo = (t) => {
    if (!t) return 'never';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60)   return `${s}s ago`;
    if (s < 3600) return `${Math.round(s/60)}m ago`;
    return `${Math.round(s/3600)}h ago`;
  };

  if (args.includes('--add')) {
    const name = args[args.indexOf('--add') + 1];
    if (!name) { console.error('--add requires a name'); process.exit(1); }
    const entry = addTarget(name, { auto_attack: args.includes('--auto-attack'), reason: 'manually added' });
    console.log('added target:', JSON.stringify(entry, null, 2));
    process.exit(0);
  }

  if (args.includes('--remove')) {
    const name = args[args.indexOf('--remove') + 1];
    if (!name) { console.error('--remove requires a name'); process.exit(1); }
    console.log(removeTarget(name) ? `removed ${name}` : `${name} was not a target`);
    process.exit(0);
  }

  if (args.includes('--targets')) {
    const targets = readTargets();
    if (!Object.keys(targets).length) { console.log('no targets'); process.exit(0); }
    for (const [name, t] of Object.entries(targets)) {
      const flags = [t.auto_attack ? 'auto-attack' : 'observe', t.assigned_to ?? 'any', t.kills ? `kills:${t.kills}` : null].filter(Boolean).join(', ');
      console.log(`  ${name.padEnd(20)} ${flags}  (added ${fmtAgo(t.added_at)})`);
      if (t.reason) console.log(`    reason: ${t.reason}`);
    }
    process.exit(0);
  }

  if (args.includes('--heatmap')) {
    const name = args[args.indexOf('--heatmap') + 1];
    if (!name) { console.error('--heatmap requires a name'); process.exit(1); }
    const heat = roomHeatmap(name);
    if (!heat.length) { console.log(`no history for ${name}`); process.exit(0); }
    console.log(`Room heatmap for ${name} (${heat.reduce((t,r)=>t+r.count,0)} total):\n`);
    for (const r of heat.slice(0, 20))
      console.log(`  ${String(r.room).padStart(5)}  ${(r.name ?? '?').padEnd(40)} ${r.count}x`);
    process.exit(0);
  }

  if (args.includes('--player')) {
    const name = args[args.indexOf('--player') + 1];
    if (!name) { console.error('--player requires a name'); process.exit(1); }
    const stats = playerStats(name);
    const trail = movementTrail(name, 30);
    console.log(`\nPlayer: ${name}`);
    console.log(`  Threat:       ${stats.threat_level}`);
    console.log(`  Sightings:    ${stats.total_sightings} total, ${stats.unique_rooms} unique rooms`);
    console.log(`  First seen:   ${fmtAgo(stats.first_seen)}`);
    console.log(`  Last seen:    ${fmtAgo(stats.last_seen)} in ${stats.last_room_name ?? stats.last_room ?? '?'} (${stats.last_room ?? '?'})`);
    console.log(`  Mostly seen by: ${stats.most_seen_by ?? '?'}`);
    if (stats.confirmed_kills) console.log(`  Killed by fleet: ${stats.confirmed_kills}x`);
    console.log(`\n  Top rooms:`);
    for (const r of stats.top_rooms) console.log(`    ${String(r.room).padStart(5)}  ${(r.name??'?').padEnd(40)} ${r.count}x`);
    console.log(`\n  Movement trail (most recent first):`);
    for (const r of trail)
      console.log(`    ${fmtAgo(r.at).padEnd(12)} ${String(r.room).padStart(5)}  ${r.room_name ?? '?'}  (seen by ${r.observer})`);
    process.exit(0);
  }

  // Default: sightings summary
  const seen    = readSeen();
  const targets = readTargets();
  const entries = Object.values(seen).sort((a,b) => (b.last_seen??0) - (a.last_seen??0));

  if (!entries.length) { console.log('no player sightings recorded yet'); process.exit(0); }

  const now = Date.now();
  console.log(`Player sightings (${entries.length} unique players):\n`);
  console.log('  Name                 Threat       Sightings  Last seen    Last room');
  console.log('  ' + '-'.repeat(76));

  for (const s of entries) {
    const threat = targets[s.name] ? 'TARGET' : s.threat_level === 'suspicious' ? 'suspicious' : '-';
    const recent = (s.recent ?? []).filter(x => now - x.at < SUSPICIOUS_WINDOW_MS).length;
    const loc    = s.last_room_name ? `${s.last_room_name} (${s.last_room})` : String(s.last_room ?? '?');
    console.log(`  ${s.name.padEnd(20)} ${threat.padEnd(12)} ${String(s.total_sightings??0).padEnd(10)} ${fmtAgo(s.last_seen).padEnd(12)} ${loc}`);
    if (targets[s.name]) {
      const t = targets[s.name];
      console.log(`    -> ${t.auto_attack?'auto-attack':'observe'} | ${t.reason??''}`);
    }
  }
}

