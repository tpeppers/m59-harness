#!/usr/bin/env node
// THE PVP RECORD: EVERY KILL AND DEATH BETWEEN THIS FLEET AND A PLAYER, GROUPED INTO BATTLES.
//
//   node tools/m59-pvp.mjs                      # battles in the last 7 days, newest first
//   node tools/m59-pvp.mjs --days 1 --json      # the same, as the /pvp page reads it
//   node tools/m59-pvp.mjs --gap 10             # minutes of quiet that end a battle
//
// ---------------------------------------------------------------------------
// WHY A LOG OF ITS OWN
//
// Operator, 2026-10-06, after Rick Deckard stepped out of the Brownestone Inn into nine of ours
// and was shot by a lightning-wand volley in half a second: nothing durable said it happened.
// The keeper recordings had all of it and ROTATE — fifteen two-minute buckets, so a fight is gone
// in half an hour — and the server's own kill line ("### X of the Human Resistance has been
// slaughtered by Y of the The Second Swines in guild combat.", system.kod:60, :1564-1594) was kept
// nowhere at all: the recorder refuses every `message` on purpose (m59-recorder.mjs), and only a
// postmortem — which is written when WE die — ever held one. So our deaths to players were on
// record and our kills of them were not, which is the half of a war a board most needs.
//
// So each keeper appends, to `substrate/pvp/<fleet>/<UTC day>.jsonl`:
//
//   kind: 'death'   the server's death broadcast, when one side is THIS keeper's character —
//                   so exactly one keeper writes each line, although every keeper hears it.
//                   Our deaths come with their killer; our KILLS come only from here.
//   kind: 'combat'  the return-fire decision's own milestones (pvp_attacked, wand_volley,
//                   wand_refused, pvp_outcome, finished), with the attacker tallies.
//
// and the reader joins three records that already existed:
//
//   * the ledger's `died` rows with `was_killed_by_player`, and `pvp_return_hold_started`, which
//     carries the room number a death row lacks — our deaths from before this log existed;
//   * the war alarms (war-alarms-<fleet>.jsonl) — who saw an enemy where, and when;
//   * reconstructed battles (substrate/pvp/<fleet>/reconstructed/*.json) — a fight rebuilt by hand
//     from evidence that has since rotated away. Every one says what it was rebuilt FROM.
//
// ---------------------------------------------------------------------------
// WHAT A BATTLE IS
//
// Hostile contact — a death on either side, an attack, a volley, a hit — clustered on
// time: an event joins a battle when it is within `gapMs` of that battle's last event AND shares
// an enemy with it (or either names none). A battle may cross maps, because a fight that starts at
// the Brownestone door and ends in South Barloque is one fight. A sighting is never a battle on
// its own: Loial reporting Rick standing in the inn every sixteen seconds is context, not war —
// and neither is an engagement alarm: `war_flag` fires every time an enemy is SEEN, and a week of
// them alone read as forty "battles" in which nothing was hit. Alarms attach to a battle as
// context and are counted per enemy as sightings.
//
// `finished` and `waiting` are bookkeeping — a return-fire decision closes thirty seconds after
// the attacker leaves — and do not stretch a battle's duration. The Rick fight lasted 0.49s; its
// records end 30s later.
//
// The /pvp page names real players and is served on loopback only, like /players.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName, ledgerDirFor } from './m59-fleetpath.mjs';
import { parseDeathBroadcast } from './m59-death-attribution.mjs';
import { parseGuildCombat, normName, ALARM_FILE, WAR_FILE } from './m59-war.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..', '..');

export const DEFAULT_GAP_MS = 10 * 60_000;
// Bookkeeping rows: they mark the END of a decision, not contact, so they never extend a battle.
const BOOKKEEPING = new Set(['finished', 'waiting', 'visible', 'pvp_offline', 'pvp_restored']);
// What the combat tee writes. Anything else the combat mode records is movement or gear.
export const COMBAT_EVENTS = new Set(['pvp_attacked', 'triggered', 'wand_volley', 'wand_refused', 'opener_cast',
  'pvp_outcome', 'pvp_rebound', 'pvp_retargeted', 'finished']);

let fleetCache;
const currentFleet = () => {
  if (fleetCache === undefined) { try { fleetCache = fleetName() || ''; } catch { fleetCache = ''; } }
  return fleetCache;
};

/** Where one fleet's PvP log lives. `M59_PVP_DIR` overrides it (tests, a lab). */
export function pvpDirFor(fleet = currentFleet(), env = process.env) {
  if (env.M59_PVP_DIR) return env.M59_PVP_DIR;
  return join(HERE, 'substrate', 'pvp', fleet || 'default');
}
const dayOf = at => new Date(at).toISOString().slice(0, 10);

/** Append one row. Never throws: a full disk must not stop a keeper fighting. */
export function appendPvp(row, { dir = pvpDirFor() } = {}) {
  try {
    const at = Number.isFinite(row?.at) ? row.at : Date.now();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${dayOf(at)}.jsonl`), JSON.stringify({ ...row, at }) + '\n');
    return true;
  } catch { return false; }
}

// ------------------------------------------------------------------ what a keeper writes

/**
 * A server line as a PvP death row, or null. Written only when one side of it is `me` — this
 * keeper's own character — so the one line twenty keepers hear is written once, by the keeper it
 * is about. `isOurs` decides which side is the fleet's when the other side is a fleetmate.
 */
export function deathRowFromMessage(text, { me, isOurs = () => false, at = Date.now(), room = null } = {}) {
  const clean = String(text ?? '').replace(/~[A-Za-z]/g, '').trim();
  if (!clean.startsWith('###')) return null;
  const g = parseGuildCombat(clean);
  const b = g ? null : parseDeathBroadcast(clean);
  const victim = g?.victim ?? b?.who ?? null;
  const killer = g?.killer ?? b?.killer ?? null;
  if (!victim) return null;
  const mine = n => n && normName(n) === normName(me);
  if (!mine(victim) && !mine(killer)) return null;
  // Our death to a monster is not PvP. A player is named without an article (system.kod:49 puts
  // GetIndef in front of a monster's name only), guild combat is PvP by definition, and a murder
  // is a player's act.
  const how = g ? 'guild combat' : b.how;
  if (!g && mine(victim)) {
    if (b.how === 'killed') {
      const raw = /\bkilled by\s+(.+?)\.?$/i.exec(clean)?.[1] ?? '';
      if (/^(an?|the)\s/i.test(raw) || !killer) return null;
    } else if (!/murder|outlaw/.test(b.how)) return null;
  }
  // A fleetmate killing a fleetmate is an accident, not a battle (the Statler incident).
  if (victim && killer && isOurs(victim) && isOurs(killer)) return null;
  return { kind: 'death', at, observer: me, text: clean, victim, killer,
    victim_guild: g?.victimGuild ?? null, killer_guild: g?.killerGuild ?? null, how,
    our_side: mine(victim) ? 'victim' : 'killer', room };
}

/** A combat-mode record as a compact PvP row, or null when it is not a PvP milestone. */
export function combatRow(event, { at = Date.now(), observer, room = null, target = null, pvp = null, reason = null } = {}) {
  if (!COMBAT_EVENTS.has(event) || !pvp) return null;
  const lo = pvp.last_outcome;
  return { kind: 'combat', event, at, observer, room, target, reason,
    decision: pvp.decision_id ?? null, outcome: pvp.outcome ?? null,
    attackers: (pvp.attackers ?? []).map(a => ({ character: a.character,
      incoming_hits: a.incoming_hits ?? 0, incoming_misses: a.incoming_misses ?? 0,
      outgoing_hits: a.outgoing_hits ?? 0, outgoing_misses: a.outgoing_misses ?? 0 })),
    zaps: pvp.zaps ?? null, wand: pvp.last_wand ?? null,
    opener_casts: pvp.opener_casts ?? null, opener: pvp.opener?.spell ?? null,
    last_outcome: lo ? { character: lo.character, direction: lo.direction, outcome: lo.outcome,
      weapon: lo.weapon ?? null, verb: lo.verb ?? null, text: lo.text ?? null, at: lo.at ?? null } : null };
}

// ------------------------------------------------------------------ readers

function jsonl(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn line */ }
  }
  return out;
}
const daysBetween = (since, until) => {
  const out = [];
  for (let t = Date.parse(dayOf(since) + 'T00:00:00Z'); t <= until; t += 86_400_000)
    out.push(dayOf(t));
  return out;
};

export function readPvpLog({ dir = pvpDirFor(), since = 0, until = Date.now() } = {}) {
  const rows = [];
  for (const d of daysBetween(since, until)) {
    const f = join(dir, `${d}.jsonl`);
    if (!existsSync(f)) continue;
    try { for (const r of jsonl(readFileSync(f, 'utf8'))) if (r.at >= since && r.at <= until) rows.push(r); } catch {}
  }
  return rows;
}

export function readReconstructed({ dir = join(pvpDirFor(), 'reconstructed'), since = 0, until = Date.now() } = {}) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    try {
      const b = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!Array.isArray(b?.events)) continue;
      const at = b.events.map(e => e.at).filter(Number.isFinite);
      if (!at.length || Math.max(...at) < since || Math.min(...at) > until) continue;
      out.push({ ...b, file: f });
    } catch { /* a malformed file is skipped, never fatal to the page */ }
  }
  return out;
}

// The ledger is 30MB a day, so it is scanned for the two kinds it needs rather than parsed whole,
// and a closed day's answer is kept for as long as its size does not change.
const ledgerCache = new Map();
const LEDGER_KINDS = /"kind":"(died|pvp_return_hold_started)"/;
function ledgerRowsOf(file) {
  let st; try { st = statSync(file); } catch { return []; }
  const hit = ledgerCache.get(file);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.rows;
  const rows = [];
  try {
    const text = readFileSync(file, 'utf8');
    const re = /"kind":"(?:died|pvp_return_hold_started)"/g;
    let m, lastEnd = -1;
    while ((m = re.exec(text))) {
      const start = text.lastIndexOf('\n', m.index) + 1;
      if (start <= lastEnd) continue;
      let end = text.indexOf('\n', m.index); if (end < 0) end = text.length;
      lastEnd = end;
      const line = text.slice(start, end);
      if (!LEDGER_KINDS.test(line)) continue;
      try { rows.push(JSON.parse(line)); } catch {}
    }
  } catch { return []; }
  ledgerCache.set(file, { size: st.size, mtime: st.mtimeMs, rows });
  return rows;
}

/** Our deaths to players, from the ledger: one row per death, the hold's room joined on. */
export function readLedgerPvpDeaths({ dir = ledgerDirFor(currentFleet()), since = 0, until = Date.now() } = {}) {
  const raw = [];
  // A death on the last minutes of a day is written into the next day's file (the postmortem is
  // read minutes later), so one extra day is scanned on the far side.
  for (const d of daysBetween(since, until + 86_400_000)) {
    const f = join(dir, `fleet-${d}.jsonl`);
    if (existsSync(f)) raw.push(...ledgerRowsOf(f));
  }
  return ledgerPvpDeaths(raw, { since, until });
}

/** Pure: ledger rows -> death events. Exported for the test. */
export function ledgerPvpDeaths(rows, { since = 0, until = Infinity } = {}) {
  const holds = rows.filter(r => r.kind === 'pvp_return_hold_started');
  const deaths = new Map();
  const key = (who, at) => `${normName(who)}|${Math.round(at / 1000)}`;
  for (const h of holds) {
    if (!(h.died_at >= since && h.died_at <= until)) continue;
    deaths.set(key(h.character, h.died_at), { kind: 'death', source: 'ledger', at: h.died_at,
      victim: h.character, killer: h.killers?.[0] ?? null, killers: h.killers ?? [], room: h.room ?? null,
      basis: h.basis ?? null, our_side: 'victim', how: h.basis === 'guild_combat' ? 'guild combat' : 'killed' });
  }
  for (const d of rows.filter(r => r.kind === 'died' && r.was_killed_by_player)) {
    const at = d.death_at ?? d.t;
    if (!(at >= since && at <= until)) continue;
    const k = key(d.character, at);
    const prior = deaths.get(k) ?? { kind: 'death', source: 'ledger', at, victim: d.character,
      killer: d.killed_by ?? null, killers: d.killed_by ? [d.killed_by] : [], room: null, our_side: 'victim',
      how: d.death_kind === 'player_kill' ? 'killed' : (d.how_died ?? 'killed') };
    deaths.set(k, { ...prior, room_name: d.died_in ?? null, level: d.level ?? null,
      killer: prior.killer ?? d.killed_by ?? null, guess: !!d.killed_by_player_is_a_guess,
      max_hp_lost: d.max_hp_lost ?? null });
  }
  return [...deaths.values()];
}

export function readAlarmsWindow({ file = ALARM_FILE(), since = 0, until = Date.now() } = {}) {
  try { return jsonl(readFileSync(file, 'utf8')).filter(a => a.at >= since && a.at <= until); }
  catch { return []; }
}

// ------------------------------------------------------------------ joining the sources

/** Same death heard twice (a log line and a ledger row): one event, the richer fields kept. */
function mergeDeaths(deaths) {
  const out = [];
  for (const d of deaths.sort((a, b) => a.at - b.at)) {
    const twin = out.find(o => normName(o.victim) === normName(d.victim) && Math.abs(o.at - d.at) < 120_000 &&
      (!o.killer || !d.killer || normName(o.killer) === normName(d.killer)));
    if (!twin) { out.push({ ...d, sources: [d.source ?? 'log'] }); continue; }
    for (const [k, v] of Object.entries(d)) if (twin[k] == null && v != null) twin[k] = v;
    twin.sources = [...new Set([...twin.sources, d.source ?? 'log'])];
    // The broadcast's clock is the server's moment; the ledger's death_at is the keeper's read of it.
    if (d.source !== 'ledger') twin.at = Math.min(twin.at, d.at);
  }
  return out;
}

/**
 * Every source -> one sorted list of events with `ours`, `enemies` and `hostile` filled in.
 * `isOurs(name)` answers whether a character is the fleet's.
 */
export function collectEvents({ log = [], ledger = [], alarms = [], reconstructed = [], isOurs = () => false } = {}) {
  const ev = [];
  const deaths = [...ledger.map(d => ({ ...d, source: 'ledger' })),
    ...log.filter(r => r.kind === 'death').map(r => ({ ...r, source: 'log' }))];
  for (const b of reconstructed) for (const e of b.events)
    if (e.kind === 'death') deaths.push({ ...e, source: 'reconstructed', battle: b.id });
  for (const d of mergeDeaths(deaths)) {
    const victimOurs = d.our_side ? d.our_side === 'victim' : isOurs(d.victim);
    ev.push({ ...d, hostile: true,
      ours: [victimOurs ? d.victim : d.killer].filter(Boolean),
      enemies: [victimOurs ? d.killer : d.victim].filter(Boolean),
      enemy_death: !victimOurs, our_death: victimOurs });
  }
  for (const r of log.filter(r => r.kind === 'combat')) {
    const enemies = [...new Set([r.target, ...(r.attackers ?? []).map(a => a.character)].filter(n => n && !isOurs(n)))];
    ev.push({ ...r, source: 'log', ours: [r.observer].filter(Boolean), enemies, hostile: !BOOKKEEPING.has(r.event) });
  }
  for (const a of alarms) {
    if (isOurs(a.enemy)) continue;
    ev.push({ kind: 'alarm', source: 'alarm', at: a.at, room: a.room, observer: a.reporter, basis: a.basis,
      ours: [a.reporter].filter(Boolean), enemies: [a.enemy], hostile: false });
  }
  for (const b of reconstructed) for (const e of b.events) {
    if (e.kind === 'death') continue;
    const enemies = e.enemies ?? [e.enemy, e.target].filter(n => n && !isOurs(n));
    ev.push({ ...e, source: 'reconstructed', battle: b.id, ours: e.ours ?? [e.observer].filter(Boolean),
      enemies: [...new Set(enemies)], hostile: e.hostile ?? !BOOKKEEPING.has(e.event) });
  }
  return ev.sort((a, b) => a.at - b.at);
}

const overlaps = (a, b) => !a.size || !b.length || b.some(n => a.has(normName(n)));

/**
 * Cluster hostile events into battles; attach bookkeeping and sightings that fall inside one.
 * A reconstructed battle's events always stay together, under its own id.
 */
export function groupBattles(events, { gapMs = DEFAULT_GAP_MS, reconstructed = [] } = {}) {
  const battles = [];
  const open = [];
  const byRecon = new Map();
  const newBattle = (e) => {
    const b = { events: [], start: e.at, end: e.at, last: e.at, enemyKeys: new Set(), rooms: new Set() };
    battles.push(b); return b;
  };
  for (const e of events.filter(e => e.hostile)) {
    let b = null;
    if (e.battle) b = byRecon.get(e.battle);
    if (!b) b = open.filter(o => e.at - o.last <= gapMs && overlaps(o.enemyKeys, e.enemies)).at(-1) ?? null;
    if (!b) {
      b = newBattle(e); open.push(b);
      if (e.battle) { b.recon = e.battle; byRecon.set(e.battle, b); }
    } else if (e.battle && !b.recon) { b.recon = e.battle; byRecon.set(e.battle, b); }
    b.events.push(e);
    b.start = Math.min(b.start, e.at); b.end = Math.max(b.end, e.at); b.last = Math.max(b.last, e.at);
    for (const n of e.enemies) b.enemyKeys.add(normName(n));
    if (e.room != null) b.rooms.add(e.room);
  }
  // Context: anything not hostile that falls in [start - 60s, end + 60s] of a battle it shares an
  // enemy with. A decision's `finished` row is the commonest, at end + 30s.
  for (const e of events.filter(e => !e.hostile)) {
    const b = battles.find(b => (e.battle && b.recon === e.battle) ||
      (e.at >= b.start - 60_000 && e.at <= b.end + 60_000 && overlaps(b.enemyKeys, e.enemies)));
    if (b) b.events.push({ ...e, context: true });
  }
  const recon = new Map(reconstructed.map(r => [r.id, r]));
  return battles.map(b => summarizeBattle(b, recon.get(b.recon) ?? null)).sort((a, b) => b.start - a.start);
}

function summarizeBattle(b, recon) {
  const events = b.events.sort((x, y) => x.at - y.at);
  const ours = new Map(), enemies = new Map();
  const me = (name) => {
    const k = normName(name);
    if (!ours.has(k)) ours.set(k, { name, kills: 0, deaths: 0, volleys: 0, refused: 0, hits_out: 0, hits_in: 0, misses_out: 0 });
    return ours.get(k);
  };
  const foe = (name) => {
    const k = normName(name);
    if (!enemies.has(k)) enemies.set(k, { name, guild: null, kills: 0, deaths: 0, first: Infinity, last: 0 });
    return enemies.get(k);
  };
  const decisions = new Map();
  for (const e of events) {
    for (const n of e.enemies ?? []) { const f = foe(n); f.first = Math.min(f.first, e.at); f.last = Math.max(f.last, e.at); }
    if (e.kind === 'death') {
      if (e.our_death) { me(e.victim).deaths++; if (e.killer) { const f = foe(e.killer); f.kills++; f.guild ??= e.killer_guild ?? null; } }
      else { foe(e.victim).deaths++; foe(e.victim).guild ??= e.victim_guild ?? null; if (e.killer) me(e.killer).kills++; }
    } else if (e.kind === 'combat' && e.observer) {
      const o = me(e.observer);
      if (e.event === 'wand_volley') o.volleys++;
      if (e.event === 'wand_refused') o.refused++;
      // The tallies are cumulative per decision: keep the last seen, sum across decisions.
      if (e.decision) decisions.set(`${normName(e.observer)}|${e.decision}`, e);
      else if (e.event === 'pvp_outcome' && e.last_outcome) {
        if (e.last_outcome.direction === 'outgoing') e.last_outcome.outcome === 'hit' ? o.hits_out++ : o.misses_out++;
        else if (e.last_outcome.outcome === 'hit') o.hits_in++;
      }
    } else if (e.observer && !e.context && e.kind !== 'alarm') me(e.observer);
  }
  for (const e of decisions.values()) {
    const o = me(e.observer);
    for (const a of e.attackers ?? []) {
      o.hits_out += a.outgoing_hits; o.misses_out += a.outgoing_misses; o.hits_in += a.incoming_hits;
    }
  }
  if (recon?.enemies) for (const r of recon.enemies) { const f = foe(r.name); f.guild = r.guild ?? f.guild; }
  // Contact span: the hostile rows only. Bookkeeping closes a decision 30s after the fact.
  const contact = events.filter(e => !e.context);
  const start = Math.min(...contact.map(e => e.at)), end = Math.max(...contact.map(e => e.at));
  const sum = k => [...ours.values()].reduce((s, o) => s + o[k], 0);
  // From the deaths, not the per-character tallies: a kill whose killer nobody heard named (the
  // Rick volley) is still a kill.
  const ourDeaths = contact.filter(e => e.kind === 'death' && e.our_death).length;
  const kills = contact.filter(e => e.kind === 'death' && e.enemy_death).length;
  const rooms = [...new Set(contact.map(e => e.room).filter(r => r != null))];
  const roomNames = {};
  for (const e of contact) if (e.room != null && e.room_name && !roomNames[e.room]) roomNames[e.room] = e.room_name;
  const result = kills && !ourDeaths ? 'won' : ourDeaths && !kills ? 'lost' : kills || ourDeaths ? 'traded' : 'skirmish';
  return {
    id: recon?.id ?? `b-${new Date(start).toISOString()}`,
    start, end, duration_ms: end - start, rooms, room_names: roomNames, result,
    our_deaths: ourDeaths, kills, hits_out: sum('hits_out'), hits_in: sum('hits_in'),
    volleys: sum('volleys'), refused: sum('refused'),
    ours: [...ours.values()].sort((a, b) => (b.kills - a.kills) || (b.hits_out - a.hits_out) || (b.deaths - a.deaths) || a.name.localeCompare(b.name)),
    enemies: [...enemies.values()].map(f => ({ ...f, first: Number.isFinite(f.first) ? f.first : null }))
      .sort((a, b) => (b.kills + b.deaths) - (a.kills + a.deaths) || a.name.localeCompare(b.name)),
    sources: [...new Set(events.map(e => e.source))],
    reconstructed: recon ? { file: recon.file, title: recon.title ?? null, provenance: recon.provenance ?? null,
      notes: recon.notes ?? [], scene: recon.scene ?? null } : null,
    events,
  };
}

/** Totals across battles, per enemy. */
export function enemyLedger(battles, sightings = new Map(), members = {}) {
  const m = new Map();
  for (const [k, s] of sightings) m.set(k, { name: s.name, guild: null, battles: 0, kills_on_us: 0, deaths_to_us: 0,
    last: s.last, alarms: s.alarms, alarm_rooms: [...s.rooms] });
  for (const b of battles) for (const f of b.enemies) {
    const k = normName(f.name);
    const r = m.get(k) ?? { name: f.name, guild: null, battles: 0, kills_on_us: 0, deaths_to_us: 0, last: 0, alarms: 0, alarm_rooms: [] };
    r.battles++; r.kills_on_us += f.kills; r.deaths_to_us += f.deaths;
    r.guild ??= f.guild; r.last = Math.max(r.last, f.last || b.end);
    m.set(k, r);
  }
  for (const r of m.values()) r.guild ??= members[normName(r.name)]?.guild ?? null;
  return [...m.values()].sort((a, b) => b.last - a.last);
}

// ------------------------------------------------------------------ the report

// Agent -> character. Some ledger rows name the AGENT ("t2") where others name the character
// ("Pepe"), and the same death then counts twice — measured on the 17:31 Rick fight. Names only:
// nothing here reads a credential beyond the character it belongs to.
export function rosterAliases(stateFile) {
  try {
    const roster = JSON.parse(readFileSync(stateFile, 'utf8'));
    const alias = new Map();
    for (const [agent, e] of Object.entries(roster)) {
      const ch = e?.credentials?.character ?? e?.character;
      if (ch) alias.set(normName(agent), ch);
    }
    return alias;
  } catch { return new Map(); }
}

function warGuilds() {
  try {
    const book = JSON.parse(readFileSync(WAR_FILE(), 'utf8'));
    return book.members ?? {};
  } catch { return {}; }
}

/**
 * The page's data. Every source is injectable; with none given it reads this checkout's fleet.
 * `characters` is the fleet's character names (the broker passes fleetCharacters()).
 */
export function pvpReport({ days = 7, gapMs = DEFAULT_GAP_MS, now = Date.now(), characters = null, stateFile = null,
                            log, ledger, alarms, reconstructed, members, aliases } = {}) {
  const since = now - days * 86_400_000;
  aliases ??= rosterAliases(stateFile ?? '');
  const names = new Set([...(characters ?? []), ...aliases.values()].map(normName));
  const isOurs = n => names.has(normName(n));
  const canon = n => (n && aliases.get(normName(n))) ?? n;
  log = (log ?? readPvpLog({ since, until: now })).map(r => ({ ...r, observer: canon(r.observer),
    victim: canon(r.victim), killer: canon(r.killer) }));
  ledger = (ledger ?? readLedgerPvpDeaths({ since, until: now })).map(d => ({ ...d, victim: canon(d.victim) }));
  alarms = (alarms ?? readAlarmsWindow({ since, until: now })).map(a => ({ ...a, reporter: canon(a.reporter) }));
  reconstructed = (reconstructed ?? readReconstructed({ since, until: now })).map(b => ({ ...b,
    events: b.events.map(e => ({ ...e, observer: canon(e.observer), victim: canon(e.victim), killer: canon(e.killer) })) }));
  members ??= warGuilds();
  const events = collectEvents({ log, ledger, alarms, reconstructed, isOurs });
  const battles = groupBattles(events, { gapMs, reconstructed });
  const sightings = new Map();
  for (const a of alarms) if (!isOurs(a.enemy)) {
    const k = normName(a.enemy), r = sightings.get(k) ?? { name: a.enemy, alarms: 0, last: 0, rooms: new Set() };
    r.alarms++; r.last = Math.max(r.last, a.at); if (a.room != null) r.rooms.add(a.room); sightings.set(k, r);
  }
  for (const b of battles) for (const f of b.enemies) f.guild ??= members[normName(f.name)]?.guild ?? null;
  const total = k => battles.reduce((s, b) => s + b[k], 0);
  return {
    generated_at: now, since, days, gap_ms: gapMs,
    totals: { battles: battles.length, kills: total('kills'), our_deaths: total('our_deaths'),
      hits_out: total('hits_out'), hits_in: total('hits_in'), volleys: total('volleys'), refused: total('refused') },
    enemies: enemyLedger(battles, sightings, members),
    battles,
    sources: { log_rows: log.length, ledger_deaths: ledger.length, alarms: alarms.length, reconstructed: reconstructed.length },
  };
}

// ---------------------------------------------------------------------------- CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const { resolveFleet } = await import('./m59-fleetpath.mjs');
  const { stateFile } = resolveFleet(argv);
  const r = pvpReport({ days: Number(arg('--days', 7)), gapMs: Number(arg('--gap', 10)) * 60_000, stateFile });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, (k, v) => k === 'events' ? undefined : v, 2)); process.exit(0); }
  const t = r.totals;
  console.log(`${t.battles} battles in ${r.days}d: ${t.kills} kills, ${t.our_deaths} deaths, ${t.hits_out} hits landed, ${t.volleys} volleys (${t.refused} refused)`);
  for (const b of r.battles) {
    const foes = b.enemies.map(f => f.name).join(', ') || '?';
    console.log(`${new Date(b.start).toISOString()}  ${(b.duration_ms / 1000).toFixed(1).padStart(7)}s  ${b.result.padEnd(8)} ` +
      `vs ${foes}  rooms ${b.rooms.join(',') || '?'}  K${b.kills}/D${b.our_deaths} hits ${b.hits_out}${b.reconstructed ? '  [reconstructed]' : ''}`);
  }
}
