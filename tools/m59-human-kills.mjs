#!/usr/bin/env node
// THE KILLS A PERSON MAKES, IN THE LEDGER BESIDE THE FLEET'S, SO THE TWO RATES CAN BE COMPARED.
//
//   node tools/m59-human-kills.mjs                    kills/30m per character: by hand, by keeper, total
//   node tools/m59-human-kills.mjs --minutes 60 --room 27
//   node tools/m59-human-kills.mjs --fleet prod --json
//
// The operator, 2026-11-04: "You're going to have to enhance the debug client so we can pull out the kills/30m
// data." He plays characters by hand through the DebugClient and wants his kill rate beside the bots'. While a
// person pilots a character its keeper is stopped (the pilot claim), so nothing wrote a `killed` row for him:
// every kills/30m reader -- the fleet board's `kills_30m` (countKills), m59-minimal, m59-roomyield -- read his
// hours as zero.
//
// WHERE THE KILL IS SEEN. The DebugClient the fleet terminal's L key starts connects through the gate proxy on
// 5962 (`m59-proxy.mjs --observe --fleet-state ...`), and that proxy already runs a passive decoder for the
// person's session (m59-proxy-communications.mjs: who the character is, the resource table, the room). This
// rides on it: BP_MESSAGE / BP_SYS_MESSAGE text through `classifyCombatLine`, the same parser the fleet uses for
// combat prose, whose `kill` is player.kod's "You killed the orc." The C client itself is unchanged.
//
// THE SAME ROW AS A KEEPER'S. `recordEvent(<character>, 'killed', { agent, creature, room, room_num, ... })`
// into the fleet's own ledger, with `human: true` and `source: 'proxy'` added. So every existing reader counts it
// with no change, and this file's reader can split by hand / by keeper.
//
// NEVER TWICE. (1) Nothing is written while a keeper is attached to the person's connection (a spectate keeper /
// Full Auto drives it then, and writes its own rows). (2) A human row a keeper row already covers -- same
// character, same creature, within HUMAN_DEDUPE_MS -- is dropped by every reader that goes through
// `dedupeKills`, which `countKills` in m59-ledger.mjs now does. With no human rows that is the identity.
//
// NOT SEEN: a client that connects straight to the server (no proxy), and a kill whose message is not
// "You killed ..." (a touch spell's own kill line, m59-touchspell.mjs). Killing a PLAYER says the same sentence;
// a name on the online-players list is not recorded, because the fleet's kill rate is a monster rate.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCombatLine } from './m59-combatlog.mjs';
import { parsePlayer, parseStringMessage } from './m59-parse.mjs';
import { dedupeKills, HUMAN_DEDUPE_MS } from './m59-ledger.mjs';
export { dedupeKills, HUMAN_DEDUPE_MS };

export const WINDOW_MS = 30 * 60 * 1000;
const BP_SYS_MESSAGE = 31, BP_MESSAGE = 32, BP_PLAYER = 130;

/** "You killed the orc." -> "orc"; anything else -> null. */
export function killedCreature(text) {
  const c = classifyCombatLine(text);
  return c?.kind === 'kill' && c.other ? String(c.other).trim() : null;
}

const lc = s => String(s ?? '').trim().toLowerCase();

/**
 * Kills per character in [from, to), split by hand and by keeper, with the rate per 30 minutes of WINDOW (the
 * same denominator m59-minimal and the board use), optionally for one room. De-duplicated first.
 */
export function killRates(events = [], { from, to = Date.now(), room = null } = {}) {
  const span = Math.max(1, to - from), per30 = n => +(n * WINDOW_MS / span).toFixed(2);
  const by = new Map();
  for (const e of dedupeKills(events)) {
    if (e?.kind !== 'killed' || !e.character || !(e.t >= from && e.t < to)) continue;
    if (room != null && Number(e.room_num) !== Number(room)) continue;
    const r = by.get(e.character) ?? by.set(e.character, { character: e.character, agent: e.agent ?? null,
      human: 0, keeper: 0, total: 0, rooms: {} }).get(e.character);
    r.agent ??= e.agent ?? null;
    const side = e.human === true ? 'human' : 'keeper';
    r[side]++; r.total++;
    const rn = Number.isInteger(e.room_num) ? e.room_num : 'unknown';
    const rr = r.rooms[rn] ?? (r.rooms[rn] = { human: 0, keeper: 0 });
    rr[side]++;
  }
  return [...by.values()].map(r => ({ ...r, kills_30m: { human: per30(r.human), keeper: per30(r.keeper), total: per30(r.total) } }))
    .sort((a, b) => b.total - a.total || String(a.character).localeCompare(String(b.character)));
}

// Room number from the BP_PLAYER security word, by the route table (which carries `security` per room and is a
// fraction of the size of the map). Unknown -> null: roomyield then leaves the row out of its per-room table, it
// still counts toward the character.
let securityIndex = null;
export function roomNumForSecurity(security, file = join(dirname(fileURLToPath(import.meta.url)), '..', 'substrate', 'm59-routes.json')) {
  if (!securityIndex) {
    securityIndex = new Map();
    try {
      const t = JSON.parse(readFileSync(file, 'utf8'));
      for (const [num, r] of Object.entries(t.rooms ?? {}))
        if (Number.isFinite(r?.security) && !securityIndex.has(r.security)) securityIndex.set(r.security, Number(num));
    } catch { /* no table: rooms stay unknown */ }
  }
  return securityIndex.get(security) ?? null;
}

/**
 * The passive observer. `comms` is the session's ProxyCommunications (identity, resources, players online);
 * `attached()` says whether a keeper is driving this connection; `record` is m59-ledger's recordEvent.
 */
export class HumanKillObserver {
  constructor({ comms, record, attached = () => false, roomOf = roomNumForSecurity, now = Date.now, log = () => {} }) {
    Object.assign(this, { comms, record, attached, roomOf, now, log });
    this.roomNum = null; this.roomName = null; this.recorded = 0; this.skipped = { attached: 0, player: 0, unnamed: 0 };
  }
  serverPacket(packet) {
    const c = this.comms;
    if (!c?.inGame || !packet?.length) return;
    const op = packet[0], body = packet.subarray(1);
    try {
      if (op === BP_PLAYER) {
        const p = parsePlayer(body);
        this.roomNum = this.roomOf(p.security);
        this.roomName = c.lookup?.(p.roomNameRsc) ?? null;
        return;
      }
      if (op !== BP_MESSAGE && op !== BP_SYS_MESSAGE) return;
      const m = parseStringMessage(body, id => c.lookup(id));
      const creature = killedCreature(m?.text);
      if (!creature) return;
      const name = c.c?.me?.name;
      if (!name) { this.skipped.unnamed++; return; }
      if (this.attached()) { this.skipped.attached++; return; }
      if ([...(c.c?.playersOnline?.values?.() ?? [])].some(pl => lc(pl.name) === lc(creature))) { this.skipped.player++; return; }
      const agent = c.characters?.get?.(lc(name))?.agent ?? null;
      this.record(name, 'killed', { agent, creature, room: this.roomName, room_num: this.roomNum,
        human: true, source: 'proxy', from_safe_spot: null });
      this.recorded++;
      this.log(`human kill: ${name} killed ${creature} in ${this.roomNum ?? '?'}`);
    } catch { /* a message we cannot decode is not a kill we can count */ }
  }
}

/** Attach to a ProxySession that already carries `communications`. Returns the observer, or null. */
export async function attachHumanKills(session, { log } = {}) {
  if (!session?.communications) return null;
  const { recordEvent } = await import('./m59-ledger.mjs');   // lazily: the observer itself is testable without it
  const obs = new HumanKillObserver({ comms: session.communications, record: recordEvent,
    attached: () => !!session.attached, log });
  const on = p => obs.serverPacket(p);
  session.on('received-server-packet', on);
  session.once('closed', () => session.removeListener('received-server-packet', on));
  return obs;
}

// A cached read for the plan desk, which renders every second: one ledger read per 15 s at most.
let cache = { at: 0, ms: 0, rows: [] };
export async function recentKillRates(ms = WINDOW_MS, maxAgeMs = 15_000) {
  const now = Date.now();
  if (cache.ms === ms && now - cache.at < maxAgeMs) return cache.rows;
  const { readLedger } = await import('./m59-ledger.mjs');
  const { events } = readLedger({ sinceMs: ms });
  cache = { at: now, ms, rows: killRates(events, { from: now - ms, to: now }) };
  return cache.rows;
}

/** The DebugClient's MANAGE-tab status suffix for one character: "kills/30m 7 (by hand 7) | fleet bots 3.2 avg". */
export function killStatusLine(rows, character) {
  const me = rows.find(r => lc(r.character) === lc(character));
  const bots = rows.filter(r => r.keeper > 0 && lc(r.character) !== lc(character));
  const avg = bots.length ? bots.reduce((s, r) => s + r.kills_30m.keeper, 0) / bots.length : 0;
  const best = bots.reduce((b, r) => (r.kills_30m.keeper > (b?.kills_30m.keeper ?? -1) ? r : b), null);
  return `kills/30m ${me ? me.kills_30m.total : 0} (by hand ${me ? me.kills_30m.human : 0})` +
    ` | bots avg ${avg.toFixed(1)}${best ? `, best ${best.character} ${best.kills_30m.keeper}` : ''}`;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const val = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const minutes = Number(val('--minutes') ?? 30), room = val('--room') != null ? Number(val('--room')) : null;
  const { readLedger } = await import('./m59-ledger.mjs');
  const { events, source } = readLedger({ sinceMs: minutes * 60_000 });
  const to = Date.now(), rows = killRates(events, { from: to - minutes * 60_000, to, room });
  if (argv.includes('--json')) console.log(JSON.stringify({ minutes, room, source, rows }, null, 1));
  else {
    console.log(`kills in the last ${minutes} min${room != null ? ` in room ${room}` : ''}, per 30 min  (ledger ${source.dir}${source.exists ? '' : ' -- MISSING'})`);
    console.log('character'.padEnd(18) + 'agent'.padEnd(8) + 'by hand'.padStart(9) + 'keeper'.padStart(9) + 'total'.padStart(9));
    for (const r of rows) console.log(String(r.character).padEnd(18) + String(r.agent ?? '-').padEnd(8) +
      String(r.kills_30m.human).padStart(9) + String(r.kills_30m.keeper).padStart(9) + String(r.kills_30m.total).padStart(9));
    if (!rows.length) console.log('(no kills recorded)');
  }
}
