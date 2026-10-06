// WAND DUTY: THE WAND BANK AT CASTLE VICTORIA'S GATE.
//
// Operator, 2026-10-06: "Wand duty will now consist of dropping off wands on Raphael before leaving
// Castle Victoria to walk home or to take a chalice ride.. everyone arriving and farming at Castle
// Victoria should carry 2 lightning wands for PVP readiness." Then, on the shape:
//   * Raphael is the bank, standing Outside Castle Victoria (room 2): a farmer ARRIVING to farm the
//     castle and short of wands stops by him and is handed up to two; a farmer LEAVING (a town trip,
//     walking or riding the chalice) hands him every wand it carries first.
//   * an unidentified "wand" counts the same as a "lightning wand": a living tree's treasure table
//     holds exactly one wand, &Lightningwand (trestype/entt.kod), so a tree's unidentified wand IS one.
//   * it must work when the operator is PLAYING Raphael: the farmer sends the same service tell the
//     chalice desk uses -- "[Service Request] wand duty dropoff (offer back nothing and accept the
//     wands)" -- and the reverse for a pickup, then waits for the person's side of the trade.
//   * "if Raphael doesn't have sufficient wands they can take 1, but shouldn't wait around if he has 0
//     wands and should continue on normally if they only get 1"; no answer gives up after the
//     default wait, the chalice desk's 60 s; and nothing is ever dropped except to make room.
//   * "stylistically mirror Chalice Duty".
//
// THE TRADE, both ways, is the game's own two-sided offer (m59-client.mjs): the giver offers, the
// receiver COUNTERS WITH NOTHING, and the giver accepts. A keeper-run Raphael already does the
// receiving half for every fleetmate's offer (acceptDonations, "wand" on his take list); his keeper
// answers a pickup tell by offering. A person at Raphael's client does either by hand. So the
// farmer's side is the same whoever is at Raphael's keyboard, which is the whole point.
//
// THIS FILE IS PURE PLUS ONE SMALL FILE: Raphael's keeper publishes how many wands he holds, so a
// farmer can skip a pickup from an empty bank without walking over to find out. The rest -- the walk,
// the tell, the trade -- is in m59-autopilot.mjs. m59-wand-duty-test.mjs pins this file offline.

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WAND_DUTY_DEFAULTS = Object.freeze({
  enabled: false,
  // The bank. Named, never derived: a character name is an instruction, so it comes from the private
  // strategy, exactly like the chalice holder.
  holder: null,
  // Where the bank stands and where every hand-over happens.
  station_room: 2,
  // CASTLE VICTORIA: arriving to farm any of these is "arriving", leaving all of them is "leaving".
  region_rooms: Object.freeze([2, 38, 39]),
  // What a farmer in the region carries for PvP readiness.
  carry: 2,
  // How long a farmer waits for the bank's side of a trade -- a person's or a keeper's -- before it
  // gives the stop up and carries on. The chalice desk's human wait.
  wait_ms: 60_000,
  // One pickup attempt per visit to the region, and never more often than this, so a bank that is
  // empty or unattended is not asked every pass.
  pickup_gap_ms: 10 * 60_000,
  // How far a farmer detours to the station for a pickup, in room hops.
  max_detour_hops: 2,
  // A published count older than this is not believed: the bank may have been restocked by hand.
  count_fresh_ms: 30 * 60_000,
});

const BOUNDS = { carry: [1, 10], wait_ms: [10_000, 300_000], pickup_gap_ms: [60_000, 6 * 3600_000],
                 max_detour_hops: [0, 6], count_fresh_ms: [60_000, 24 * 3600_000] };

/** The strategy's answer, cleaned, with every problem named. Pure. */
export function normalizeWandDuty(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // A strategy that answers the hook means ON, unless it says `enabled: false` -- chalice's rule.
  const out = { ...WAND_DUTY_DEFAULTS, enabled: raw.enabled !== false, problems: [] };
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in WAND_DUTY_DEFAULTS)) { out.problems.push(`unknown key ${k}`); continue; }
    if (k === 'enabled') { out.enabled = v !== false; continue; }
    if (k === 'holder') { out.holder = typeof v === 'string' && v.trim() ? v.trim() : null; continue; }
    if (k === 'region_rooms') {
      const rooms = [].concat(v).map(Number).filter(n => Number.isInteger(n) && n > 1);
      if (rooms.length) out.region_rooms = Object.freeze(rooms); else out.problems.push('region_rooms is empty');
      continue;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) { out.problems.push(`${k} is not a number`); continue; }
    const [lo, hi] = BOUNDS[k] ?? [-Infinity, Infinity];
    out[k] = Math.min(hi, Math.max(lo, k === 'station_room' ? Math.trunc(n) : n));
  }
  if (raw.enabled !== false && !out.holder) { out.problems.push('no holder named'); out.enabled = false; }
  if (!out.region_rooms.includes(out.station_room)) out.region_rooms = Object.freeze([out.station_room, ...out.region_rooms]);
  return Object.freeze(out);
}

const lower = s => String(s ?? '').trim().toLowerCase();
export const sameName = (a, b) => !!a && !!b && lower(a) === lower(b);

// "wand" (unidentified) and "lightning wand" (identified) are the same thing here; any other wand
// (a wand of something else) is not what the castle carries.
export const isWand = name => /^(wand|lightning wand)$/i.test(String(name ?? '').trim());

/** Every wand in a pack, as `{id, name, amount}` rows, with the total. Pure. */
export function wandsIn(items = []) {
  const rows = [].concat(items).filter(i => isWand(i?.name));
  return { rows, count: rows.reduce((n, i) => n + (Number(i.amount) || 1), 0) };
}

export const inRegion = (cfg, room) => !!cfg && cfg.region_rooms.includes(Number(room));
export const roleOf = (cfg, me) => !cfg ? 'none' : sameName(me, cfg.holder) ? 'holder' : 'farmer';

/**
 * Should a farmer starting a trip OUT of Castle Victoria hand its wands to the bank first? Pure.
 * `targetRoom` is where the trip is going; a trip that ends inside the region is not leaving.
 */
export function shouldDropoff({ cfg, me, here, wands, targetRoom = null }) {
  if (!cfg?.enabled) return { go: false, why: 'wand duty is off' };
  if (roleOf(cfg, me) !== 'farmer') return { go: false, why: 'the bank does not hand wands to itself' };
  if (!inRegion(cfg, here)) return { go: false, why: 'not leaving Castle Victoria' };
  if (targetRoom != null && inRegion(cfg, targetRoom)) return { go: false, why: 'the trip stays in Castle Victoria' };
  if (!(wands > 0)) return { go: false, why: 'no wands to hand over' };
  return { go: true };
}

/**
 * Should a farmer in Castle Victoria stop by the bank for wands? Pure. `bank` is the bank's
 * published `{wands, at}` or null; `last` is when this character last tried, this visit.
 */
export function shouldPickup({ cfg, me, here, assignedRoom, farming, wands, bank = null, last = null,
                               hops = null, now = Date.now() }) {
  if (!cfg?.enabled) return { go: false, why: 'wand duty is off' };
  if (roleOf(cfg, me) !== 'farmer') return { go: false, why: 'the bank' };
  if (!farming || !inRegion(cfg, assignedRoom)) return { go: false, why: 'not farming Castle Victoria' };
  if (!inRegion(cfg, here)) return { go: false, why: 'not in Castle Victoria yet' };
  if (wands >= cfg.carry) return { go: false, why: `already carrying ${wands}` };
  if (last != null && now - last < cfg.pickup_gap_ms) return { go: false, why: 'tried recently' };
  if (bank && now - Number(bank.at) < cfg.count_fresh_ms && !(Number(bank.wands) > 0))
    return { go: false, why: 'the bank is empty', empty: true };
  if (hops != null && hops > cfg.max_detour_hops) return { go: false, why: `the station is ${hops} hops away` };
  return { go: true, want: cfg.carry - Math.max(0, wands) };
}

// ------------------------------------------------------------------ the service tell

/** What the farmer tells the bank. The operator's wording. */
export const dropoffRequest = () => 'wand duty dropoff (offer back nothing and accept the wands)';
export const pickupRequest = (n) => `wand duty pickup: offer me ${n} wand${n === 1 ? '' : 's'}, ` +
  'I will offer back nothing and accept';

const PICKUP = /wand\s+duty\s+pickup(?:\D+(\d+))?/i;
const DROPOFF = /wand\s+duty\s+dropoff/i;
/**
 * A heard line, read as a wand-duty request: `{kind:'pickup', n}` | `{kind:'dropoff'}` | null.
 * Colour codes and the "[Service Request]" prefix are ignored; the words are what count.
 */
export function parseWandRequest(text) {
  const t = String(text ?? '').replace(/~[A-Za-z]/g, ' ');
  const p = PICKUP.exec(t);
  if (p) return { kind: 'pickup', n: Math.max(1, Math.min(10, Number(p[1]) || 2)) };
  if (DROPOFF.test(t)) return { kind: 'dropoff' };
  return null;
}

/** How many the bank offers for a pickup of `n`: all it can, at most `n`. Pure. */
export const pickupOffer = (n, have) => Math.max(0, Math.min(Number(n) || 0, Number(have) || 0));

// ------------------------------------------------------------------ the bank's published count

const HERE = dirname(fileURLToPath(import.meta.url));
const storePath = (fleet, dir) => join(dir ?? process.env.M59_WAND_DUTY_DIR ?? join(HERE, '..', 'substrate', '.wand-duty'),
                                       `${fleet || 'default'}.json`);

export function readBank(fleet, dir) {
  try { return JSON.parse(readFileSync(storePath(fleet, dir), 'utf8')); } catch { return null; }
}

/** Atomic, and patient about Windows' rename-over-an-open-file (see m59-swarm-follow.mjs). */
export function writeBank(fleet, value, dir) {
  const path = storePath(fleet, dir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  for (let attempt = 0; ; attempt++) {
    try { renameSync(tmp, path); return; }
    catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e?.code) || attempt >= 20) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + attempt * 5);
    }
  }
}
