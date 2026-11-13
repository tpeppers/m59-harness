// A REMOVE-CURSE DESK THAT IS NOT A CHALICE HOLDER, AND THE AMULET THAT GOES BACK ON.
//
//   policy.uncurseDesk   = null | { enabled: true, room: 552, reserve: 1, cooldown_ms: 60000 }    (broker: uncurse_desk)
//   policy.rewearCursed  = null | ['amulet of shadows']                                           (broker: rewear_cursed)
//
// Operator, 2026-11-13: Pepe (t2) and Sweetums (t11), karma-locked Shal'ille casters who never attack, stand in the Great
// Ocean (552) among ~20 farmers. Three wants, one module:
//
// (1) A DESK THE FARMERS CAN SEE. `lootUnrevealedWeapons: 'desk'` (m59-unrevealed-weapons.mjs) opens only while a FRESH
//     service-board record offers `uncurse` -- and the only writer of such a record was the chalice holder
//     (chalicePublishDesk). So 552, with no chalice, never qualified and its farmers left every unidentified weapon on the
//     floor. A character with `uncurseDesk` now publishes the same record shape (ChaliceStore.setDesk, deskMenu) with ONE
//     line on its menu, Remove Curse, and `ok` only while it can actually cast here: standing in its room, knowing the
//     spell, karma >= +20, 9 mana and an emerald over what it keeps back. When it cannot, it says so (ok: false) at once
//     rather than letting an `ok` record go stale for fifteen minutes.
// (2) A DESK THAT SERVES. A farmer that is wearing or wielding something cursed posts `uncurse` on the fleet's service
//     board (tools/rpg/requests.mjs) while a desk is offering in its room; the desk casts Remove Curse on it (remcurse.kod
//     targets the PLAYER and unuses every cursed item it wears) through the keeper's own cast path, and closes the request.
//     The board's two spellings -- `uncurse` (the farm engine) and `remove curse` (the joints, the private desks) -- are
//     one service now (requests.mjs serviceKey). Remove Curse is not harmful (remcurse.kod, catalogue `harmful: false`),
//     so `never_attack` lets it through (m59-never-attack.mjs).
// (3) THE AMULET GOES BACK ON. Remove Curse UNUSES a cursed item and leaves it cursed (player.kod RemoveCurseAllItems), so
//     a trainee practising it on itself needs the Amulet of Shadows worn again before the next cast. `rewearCursed` names
//     what this character puts back on at the next safe moment -- the curse cycle's re-wear (autopilot/curse-cycle.mjs),
//     without needing a ring to have cursed it first. And a `remove curse` practice cast on SELF is chosen only while
//     something cursed is actually worn (m59-deskpractice.mjs choosePractice `cursedWorn`): with nothing cursed the
//     server refuses it (RemoveCurse_bad_target) and the drill would only set the spell aside.
//
// PURE. No client, no store, no keeper: the keeper half is in autopilot/curse-cycle.mjs.
import { serviceKey } from './rpg/requests.mjs';

export const UNCURSE_SPELL = 'remove curse';
export const UNCURSE_REAGENT = 'emerald';
// remcurse.kod: level 2, 9 mana, one emerald. spell.kod GetRequiredKarma: level x 10.
export const UNCURSE_MANA = 9, UNCURSE_KARMA = 20;
export const UNCURSE_DESK_DEFAULTS = Object.freeze({ reserve: 0, cooldown_ms: 60_000 });

const norm = s => String(s ?? '').trim().toLowerCase();

/** Strict, for the broker argument: null | { enabled: true, room, reserve, cooldown_ms }; throws on anything else. */
export function normalizeUncurseDesk(v) {
  if (v == null || v === false) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('uncurse_desk must be null or { enabled, room, reserve, cooldown_ms }');
  if (v.enabled === false) return null;
  if (v.enabled !== true) throw new Error('uncurse_desk.enabled must be true (or pass null to turn the desk off)');
  const room = v.room == null ? null : Number(v.room);
  if (room != null && !(Number.isInteger(room) && room > 0)) throw new Error('uncurse_desk.room must be a room number');
  const reserve = v.reserve == null ? UNCURSE_DESK_DEFAULTS.reserve : Number(v.reserve);
  if (!(Number.isInteger(reserve) && reserve >= 0 && reserve <= 100)) throw new Error('uncurse_desk.reserve must be 0..100 emeralds');
  const cooldown = v.cooldown_ms == null ? UNCURSE_DESK_DEFAULTS.cooldown_ms : Number(v.cooldown_ms);
  if (!(cooldown >= 5_000 && cooldown <= 3_600_000)) throw new Error('uncurse_desk.cooldown_ms must be 5000..3600000');
  const unknown = Object.keys(v).filter(k => !['enabled', 'room', 'reserve', 'cooldown_ms'].includes(k));
  if (unknown.length) throw new Error(`uncurse_desk: unknown key(s) ${unknown.join(', ')}`);
  return { enabled: true, room, reserve, cooldown_ms: cooldown };
}

/** The keeper's reading: never throws; a bad value is reported and the desk stays off (silence = the old behaviour). */
export function readUncurseDesk(v) {
  try { return { cfg: normalizeUncurseDesk(v), problem: null }; }
  catch (e) { return { cfg: null, problem: `${e.message}; ignored, so no remove-curse desk` }; }
}

/** Strict, for the broker argument: null | [lower-case names]. A ring is refused: rings belong to the curse cycle. */
export function normalizeRewearCursed(v) {
  if (v == null) return null;
  const list = Array.isArray(v) ? v : [v];
  if (list.some(x => typeof x !== 'string' || !x.trim())) throw new Error('rewear_cursed must be a list of item names, or null');
  const names = [...new Set(list.map(norm))];
  const ring = names.find(n => /\bring\b/.test(n));
  if (ring) throw new Error(`rewear_cursed: "${ring}" refused -- a cursed ring is the curse cycle's to drop, never to put back on`);
  return names.length ? names : null;
}
export const readRewearCursed = v => { try { return normalizeRewearCursed(v) ?? []; } catch { return []; } };

/**
 * Can this body run the desk RIGHT NOW? -> { able, why, menu }. `menu` is the record's menu: one `uncurse` line, the same
 * shape deskMenu writes (m59-chalice.mjs), so uncurseDesk() in m59-unrevealed-weapons.mjs reads it unchanged.
 * `floor` is what the body keeps back for its own reasons (the Rescue emeralds); the desk's own `reserve` is added on top.
 */
export function uncurseDeskMenu(cfg, { here = null, knows = false, karma = null, mana = null, emeralds = 0, floor = 0 } = {}) {
  let why = null;
  if (!cfg) why = 'no desk';
  else if (cfg.room != null && Number(here) !== cfg.room) why = `not in room ${cfg.room}`;
  else if (!knows) why = `does not know ${UNCURSE_SPELL}`;
  else if (karma == null || !Number.isFinite(Number(karma))) why = 'karma unknown';
  else if (Number(karma) < UNCURSE_KARMA) why = `karma ${karma} below ${UNCURSE_KARMA}`;
  else if (mana == null || !Number.isFinite(Number(mana))) why = 'mana unknown';
  else if (Number(mana) < UNCURSE_MANA) why = 'Req. mana';
  else if ((Number(emeralds) || 0) - (Number(floor) || 0) - (cfg.reserve ?? 0) < 1) why = 'Req. reagents';
  return { able: !why, why, menu: [{ kind: 'uncurse', label: 'Remove Curse', ok: !why, why }] };
}

/**
 * Whom to cast on now: open `uncurse` requests (either spelling) whose asker is a player standing in this room, oldest
 * first, each name at most once per `cooldownMs`. `players` is `[{ id, name }]` in the room (never the desk itself);
 * a request names its asker by `character` (the farm engine and this module's farmer side) or `target` (an agent slot or
 * a character name). -> [{ request, player }]
 */
export function uncurseCustomers({ requests = [], players = [], room = null, me = null, now = Date.now(),
                                   lastCast = new Map(), cooldownMs = UNCURSE_DESK_DEFAULTS.cooldown_ms } = {}) {
  const byName = new Map(players.filter(p => p?.name && norm(p.name) !== norm(me)).map(p => [norm(p.name), p]));
  const out = [], seen = new Set();
  for (const q of [...requests].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) {
    if (q?.state && q.state !== 'open') continue;
    if (serviceKey(q?.service) !== 'uncurse') continue;
    // TWO DESKS IN ONE ROOM (Pepe and Sweetums): a request the other desk has claimed is its to serve (a claim lapses
    // after CLAIM_MS, requests.mjs, so a desk that walked away does not hold it).
    if (q.claimed_by && norm(q.claimed_by) !== norm(me)) continue;
    if (q.room != null && room != null && Number(q.room) !== Number(room)) continue;
    const player = byName.get(norm(q.character)) ?? byName.get(norm(q.target));
    if (!player || seen.has(norm(player.name))) continue;
    if (now - (lastCast.get(norm(player.name)) ?? -Infinity) < cooldownMs) continue;
    seen.add(norm(player.name));
    out.push({ request: q, player });
  }
  return out;
}

/**
 * Should THIS body (a farmer) ask for a remove curse? Only for a curse it is not wearing on purpose, and only while a desk
 * is offering in its room -- a request with nobody to answer it is noise on the board.
 *   cursedWorn  names of cursed items worn/wielded (lower case); suspect: the keeper's curse suspect (or null)
 *   desk        uncurseDesk(...).desk from m59-unrevealed-weapons.mjs
 */
export function shouldAskUncurse({ cursedWorn = [], suspect = null, rewear = [], desk = null, room = null } = {}) {
  const keep = new Set(rewear.map(norm));
  const real = cursedWorn.map(norm).filter(n => !keep.has(n));
  if (!real.length && !suspect) return { ask: false, why: 'nothing cursed worn but what is worn on purpose' };
  if (!desk) return { ask: false, why: 'no remove-curse desk is offering' };
  if (desk.room != null && room != null && Number(desk.room) !== Number(room)) return { ask: false, why: `the desk is in ${desk.room}` };
  return { ask: true, why: `wearing ${real.join(', ') || suspect?.name || 'a suspected curse'}; ${desk.name} offers remove curse here` };
}

/**
 * What to put back on: pack items named in `rewear` that are not worn now, one per name (an Amulet of Shadows refuses a
 * second owner-wearer anyway, shadowam.kod ReqNewOwner). `pack` is `[{ id, name }]`; `wornIds` a Set. -> [{ id, name }]
 */
export function rewearDue({ pack = [], wornIds = new Set(), wornNames = [], rewear = [] } = {}) {
  const want = new Set(rewear.map(norm));
  const worn = new Set(wornNames.map(norm));
  const out = [], picked = new Set();
  for (const o of pack) {
    const n = norm(o?.name);
    if (!want.has(n) || worn.has(n) || picked.has(n) || wornIds.has(o.id)) continue;
    picked.add(n);
    out.push({ id: o.id, name: n });
  }
  return out;
}
