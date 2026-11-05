// THE FLOOR AROUND A CACHE IS PART OF THE CACHE.
//
// Operator, 2026-11-05: "Ensure that for our cache/courier pickups the ground nearby is also checked for whatever's
// desired: e.g., if an archer needs arrows but Zheng He is full of reagents and has no arrows, but there are arrows on the
// ground, the archer should get the nerudite arrows (or regular "arrows") from the ground around Zheng He... and similarly
// with dropping off, if Zheng He (or Raphael) can't carry everything to cache, the extra can be dropped off at the ground
// under them". Refinement the same day: PICKUPS FROM THE FLOOR ARE AUTOMATIC; the drop-off overflow is ON BY DEFAULT and
// `no_dropoff: true` switches it off wherever a drop-off is configured or invoked.
//
// Two operations, one rule each:
//
//   floorPickup  the PICKER takes what it wants off the floor within `radius` squares of the HOLDER, nearest first, up to
//                `amount` and the picker's own pack room. Judged by the picker's pack before and after each get, never by a
//                reply. The server splits a stack to what the picker can hold by itself (user.kod UserGet: ReqNewHold, then
//                GetNumberCanHold + Split), and a get takes the whole stack otherwise, so anything over `amount` is dropped
//                straight back where it was found (`return_excess`, default on) and stays reserved.
//   floorDrop    the GIVER drops a remainder the holder could not take, standing within `radius` of the holder (walking
//                there first when it can), and the result says how much went to the floor. Each drop is verified by the
//                giver's pack; a drop the server refused is reported under `refused` and never counted.
//
// AND THE STASH IS RESERVED. Every floor sweep in the fleet picks up "*" since deploy-2026-11-05-12, so a pile dropped at a
// cache would be looted by the next farmer through. A drop writes a DIBS claim (m59-dibs.mjs `addStashClaim`): this item,
// in this room, within `radius` squares of the holder, for the holder only, until `ttl_ms`. A sweep by anyone else leaves
// it; `floorPickup` asks by explicit id, which dibs never refuses -- a pickup that WANTS the item is the one allowed to take
// it. Operator claims on the same item are never replaced (a stash claim is its own entry).
//
// THE FLOOR IS NOT A VAULT. room.kod DisposeTimer runs every 5 min +/- 5 s (piDispose_delay 300000): with nobody in the room
// it destroys every disposable floor item, and with somebody there and more than five floor objects it destroys the OLDEST
// fifth (docs/m59-coordination-research.md). A cache holder standing in the room keeps the first rule away; nothing keeps
// the second away. So the stash is a buffer for minutes, not a store, and the claim's ttl defaults to 30 minutes.
//
// PICKUP REACH IS 7 SQUARES, MANHATTAN (user.kod:3634 "You can't pick up %s%s; it's too far away."). A candidate further
// than that from the picker is approached first when an `approach` is available, and skipped (`too_far`) when it is not.
//
// `io` is everything that touches a body, so the same two functions run in the broker (in-process or KeeperProxy), in the
// keeper (loot ejection) and against fakes in tools/m59-floor-cache-test.mjs:
//   io.scene(agent)            -> { room, you: {col,row}|null, objects: [{ id, name, col, row, amount, player }] }
//   io.inventory(agent)        -> [{ id, name, amount }]
//   io.get(agent, id)          -> anything (the reply is not believed)
//   io.drop(agent, row, n)     -> anything (row is an inventory row; n the amount, null for all of it)
//   io.capacity(agent)         -> { bulk, weight } free, or null when unknown
//   io.character(agent)        -> the character name (to find the holder / to name the claim)
//   io.approach?(agent, {col,row}) -> { arrived }
//   io.reserve?(claim)         -> the claim written (m59-dibs addStashClaim)
//   io.settle?()               -> a short wait between a send and the re-read
import { weighItem } from './m59-items.mjs';
import { carryCapacity } from './m59-skills.mjs';

export const PICKUP_REACH = 7;          // user.kod:3634, manhattan squares
export const DEFAULT_RADIUS = 4;        // "around Zheng He": the squares a stash lies on
export const STASH_TTL_MS = 30 * 60_000;
export const MAX_PICKS = 12;            // gets per call: a floor of a hundred one-arrow stacks is not one call's job

// A WANT THAT MEANS A FAMILY, SPELLED OUT. 'arrows' is the archer's want; the operator named both kinds. Every other want is
// matched as an exact name (plural-insensitive), never as a substring: 'wand' must not take 'wand of healing' (2026-10-13).
export const FLOOR_FAMILIES = Object.freeze({
  arrows: ['nerudite arrows', 'arrows'],
  arrow: ['nerudite arrows', 'arrows'],
});

export const key = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
// Exact, plural-insensitive: 'mushroom'/'mushrooms', and 'entroot berry'/'entroot berries' (a -y stack is -ies on the wire).
const sing = n => n.replace(/ies$/, 'y').replace(/s$/, '');
const same = (a, b) => a === b || a === `${b}s` || `${a}s` === b || (sing(a) === sing(b) && /ies$|y$/.test(a) && /ies$|y$/.test(b));

/** The exact names a want covers, in preference order. `want` is a name, a family or a list of either. */
export function wantNames(want) {
  const out = [];
  for (const w of [].concat(want ?? [])) {
    const k = key(typeof w === 'object' && w ? w.name : w);
    if (!k) continue;
    for (const n of FLOOR_FAMILIES[k] ?? [k]) if (!out.includes(key(n))) out.push(key(n));
  }
  return out;
}

/** Index of `name` in `names` (exact, plural-insensitive), or -1. */
export function matchIndex(name, names) {
  const n = key(name);
  return names.findIndex(w => same(n, w));
}

export const manhattan = (a, b) => Math.abs(Number(a.row) - Number(b.row)) + Math.abs(Number(a.col) - Number(b.col));
const placed = p => p && Number.isFinite(Number(p.row)) && Number.isFinite(Number(p.col));

/** Floor items matching the want within `radius` of `near`, best first (want order, then nearest). Pure. */
export function floorCandidates({ objects = [], want, near = null, radius = DEFAULT_RADIUS }) {
  const names = wantNames(want);
  const out = [];
  for (const o of objects) {
    if (!o || o.player || o.is_player) continue;
    const rank = matchIndex(o.name, names);
    if (rank < 0) continue;
    if (near) { if (!placed(o) || manhattan(o, near) > radius) continue; }
    out.push({ id: o.id, name: o.name, amount: Number(o.amount) > 0 ? Number(o.amount) : 1, col: o.col, row: o.row, rank,
               distance: near && placed(o) ? manhattan(o, near) : null });
  }
  return out.sort((a, b) => a.rank - b.rank || (a.distance ?? 0) - (b.distance ?? 0));
}

/** How many units of `name` fit in `free` ({bulk, weight}); null when the item or the pack is unweighed. Pure. */
export function unitsThatFit(name, free, weigh = weighItem) {
  if (!free) return null;
  const w = weigh(name);
  if (!w) return null;
  const by = (room, per) => (per > 0 ? Math.floor(Math.max(0, room) / per) : Infinity);
  return Math.min(by(free.bulk, Number(w.bulk) || 0), by(free.weight, Number(w.weight) || 0));
}

/** Count by exact name key. */
export function countNamed(rows = [], name) {
  return rows.filter(r => same(key(r.name), key(name))).reduce((n, r) => n + (Number(r.amount) > 0 ? Number(r.amount) : 1), 0);
}

/** The holder's square, as the picker / giver sees it: a {col,row} passed straight in, or the player object by name. */
export function holderSquare(scene, holder) {
  if (placed(holder)) return { col: Number(holder.col), row: Number(holder.row) };
  const want = key(holder);
  const o = (scene?.objects ?? []).find(x => (x.player || x.is_player) && key(x.name) === want);
  return o && placed(o) ? { col: o.col, row: o.row } : null;
}

/**
 * The dibs claim for a stash dropped at a holder's feet. Pure.
 * -> { room, item, for: [holder], near: {row, col, radius}, source: 'floor-cache', until, why, by, at }
 */
export function stashClaim({ room, item, holder, near, radius = DEFAULT_RADIUS, ttlMs = STASH_TTL_MS, now = Date.now(), by = 'floor-cache', why = null }) {
  return { room: Number(room), item: String(item), for: [String(holder)],
           ...(placed(near) ? { near: { row: Number(near.row), col: Number(near.col), radius: Number(radius) } } : {}),
           source: 'floor-cache', until: new Date(now + ttlMs).toISOString(), by, at: new Date(now).toISOString(),
           why: why ?? `a cache drop-off ${holder} could not carry: reserved for the cache; a pickup that wants it takes it by id` };
}

const settleOf = io => (io.settle ? io.settle() : new Promise(r => setTimeout(r, 600)));

/**
 * PICK UP WHAT IS WANTED OFF THE FLOOR AROUND THE HOLDER.
 * @returns { ok, wanted, got, picked: {name: n}, returned: {name: n}, refused: [...], skipped: [...], room, why }
 */
export async function floorPickup(io, { agent, holder, want, amount = null, radius = DEFAULT_RADIUS, reach = PICKUP_REACH,
                                         returnExcess = true, maxPicks = MAX_PICKS } = {}) {
  const names = wantNames(want);
  if (!names.length) return { ok: false, got: 0, why: 'floor pickup: nothing named to look for' };
  const wanted = amount == null ? Infinity : Math.max(0, Number(amount) || 0);
  const result = { ok: false, wanted: Number.isFinite(wanted) ? wanted : null, got: 0, picked: {}, returned: {}, refused: [], skipped: [], room: null };
  if (!(wanted > 0)) return { ...result, ok: true, why: 'nothing wanted' };
  const holderName = typeof holder === 'string' ? (io.character?.(holder) ?? holder) : holder;
  let scene = await io.scene(agent);
  result.room = scene?.room ?? null;
  const near = holderSquare(scene, holderName);
  if (!near) return { ...result, why: `floor pickup: ${typeof holder === 'string' ? holder : 'the holder'} is not visible in the picker's room` };
  const tried = new Set();
  let picks = 0;
  while (result.got < wanted && picks < maxPicks) {
    const cand = floorCandidates({ objects: scene?.objects ?? [], want: names, near, radius }).find(c => !tried.has(c.id));
    if (!cand) break;
    tried.add(cand.id);
    // REACH: the server refuses a get from further than 7 squares, and says so only in a sentence.
    if (placed(scene?.you) && manhattan(scene.you, cand) > reach) {
      if (!io.approach) { result.skipped.push({ id: cand.id, name: cand.name, why: 'too_far' }); continue; }
      const w = await io.approach(agent, { col: cand.col, row: cand.row }).catch(e => ({ arrived: false, reason: e.message }));
      scene = await io.scene(agent);
      if (placed(scene?.you) && manhattan(scene.you, cand) > reach) {
        result.skipped.push({ id: cand.id, name: cand.name, why: `too_far: approach ${w?.reason ?? 'did not get within reach'}` });
        continue;
      }
    }
    // RE-READ BEFORE ACTING: the id is a handle, and the pile may have been taken since the last look.
    const still = (scene?.objects ?? []).find(o => o.id === cand.id && matchIndex(o.name, names) >= 0);
    if (!still) { result.skipped.push({ id: cand.id, name: cand.name, why: 'gone from the floor' }); continue; }
    const fit = unitsThatFit(cand.name, await io.capacity(agent));
    if (fit === 0) { result.skipped.push({ id: cand.id, name: cand.name, why: 'no_room: the picker\'s pack is full' }); break; }
    const before = countNamed(await io.inventory(agent), cand.name);
    picks++;
    await io.get(agent, cand.id);
    await settleOf(io);
    const after = countNamed(await io.inventory(agent), cand.name);
    const delta = after - before;
    if (delta <= 0) { result.refused.push({ id: cand.id, name: cand.name, why: 'the get moved nothing (refused, too far, or taken first)' }); }
    else { result.got += delta; result.picked[cand.name] = (result.picked[cand.name] ?? 0) + delta; }
    scene = await io.scene(agent);
  }
  // OVER THE WANT: put the excess straight back where it came from, verified by the pack.
  if (returnExcess && Number.isFinite(wanted) && result.got > wanted) {
    let over = result.got - wanted;
    for (const name of Object.keys(result.picked).reverse()) {
      if (over <= 0) break;
      const inv = await io.inventory(agent);
      const row = inv.find(r => same(key(r.name), key(name)) && Number(r.amount) > 0);
      if (!row) continue;
      const n = Math.min(over, result.picked[name], Number(row.amount));
      const before = countNamed(inv, name);
      await io.drop(agent, row, n);
      await settleOf(io);
      const gone = before - countNamed(await io.inventory(agent), name);
      if (gone > 0) { result.returned[name] = gone; result.got -= gone; over -= gone; }
      else result.refused.push({ name, why: `returning ${n} excess: the drop moved nothing` });
    }
    if (Object.keys(result.returned).length && io.reserve && typeof holderName === 'string') {
      for (const name of Object.keys(result.returned))
        await Promise.resolve(io.reserve(stashClaim({ room: result.room, item: name, holder: holderName, near, radius }))).catch(() => null);
    }
  }
  result.ok = result.got >= wanted || (!Number.isFinite(wanted) && result.got > 0);
  if (!result.ok) result.why = result.got > 0 ? `short: ${result.got} of ${wanted} on the floor around the holder`
    : `nothing matching ${names.join(' / ')} on the floor within ${radius} squares of the holder`;
  return result;
}

/**
 * DROP A REMAINDER AT THE HOLDER'S FEET. `items` is [{ name, amount }] (exact names); the giver's own stacks are re-read here.
 * @returns { ok, dropped: {name: n}, total, refused: [...], at: {room, col, row}, reserved: [...], why }
 */
export async function floorDrop(io, { agent, holder, items = [], radius = DEFAULT_RADIUS, reserve = true, ttlMs = STASH_TTL_MS,
                                       holderCharacter = null, walk = true } = {}) {
  const out = { ok: false, dropped: {}, total: 0, refused: [], reserved: [], at: null };
  const asked = items.filter(i => i?.name && Number(i.amount) > 0);
  if (!asked.length) return { ...out, ok: true, why: 'nothing to drop' };
  const holderName = holderCharacter ?? (typeof holder === 'string' ? (io.character?.(holder) ?? holder) : holder);
  let scene = await io.scene(agent);
  const near = holderSquare(scene, holderName);
  if (!near) return { ...out, why: `floor drop: ${typeof holder === 'string' ? holder : 'the holder'} is not visible in the giver's room: nothing dropped` };
  if (placed(scene?.you) && manhattan(scene.you, near) > radius) {
    // walk:false -- a hand-over's overflow (m59-supply) never walks the GIVER: 2026-11-05 22:54Z Zheng He, a cache that must
    // stay put, handed Camilla arrows, hit receiver_full, and was walked ~30 squares across 2144 to drop them at her feet.
    if (walk && io.approach) { await io.approach(agent, near).catch(() => null); scene = await io.scene(agent); }
    if (placed(scene?.you) && manhattan(scene.you, near) > radius)
      return { ...out, why: `floor drop: could not stand within ${radius} squares of the holder (at ${manhattan(scene.you, near)}): nothing dropped` };
  }
  out.at = { room: scene?.room ?? null, col: scene?.you?.col ?? null, row: scene?.you?.row ?? null };
  for (const it of asked) {
    let left = Number(it.amount);
    for (let guard = 0; left > 0 && guard < 4; guard++) {
      const inv = await io.inventory(agent);
      const row = inv.find(r => same(key(r.name), key(it.name)));
      if (!row) { if (!out.dropped[it.name]) out.refused.push({ name: it.name, why: 'not in the giver\'s pack' }); break; }
      const stack = Number(row.amount) > 0;
      const n = stack ? Math.min(left, Number(row.amount)) : 1;
      const before = countNamed(inv, it.name);
      await io.drop(agent, row, stack ? n : null);
      await settleOf(io);
      const gone = before - countNamed(await io.inventory(agent), it.name);
      if (gone <= 0) { out.refused.push({ name: it.name, amount: n, why: 'the drop moved nothing: refused by the server' }); break; }
      out.dropped[it.name] = (out.dropped[it.name] ?? 0) + gone;
      out.total += gone; left -= gone;
    }
  }
  if (reserve && io.reserve && out.total > 0) {
    const who = holderCharacter ?? (typeof holderName === 'string' ? holderName : null);
    if (who) for (const name of Object.keys(out.dropped)) {
      const c = stashClaim({ room: out.at.room, item: name, holder: who, near, radius, ttlMs });
      try { await io.reserve(c); out.reserved.push({ item: name, for: who, until: c.until }); }
      catch (e) { out.refused.push({ name, why: `dropped but NOT reserved: ${e.message}` }); }
    }
  }
  out.ok = out.total >= asked.reduce((n, i) => n + Number(i.amount), 0);
  if (!out.ok) out.why = out.total > 0 ? 'partial: see refused' : 'nothing was dropped: see refused';
  return out;
}

/**
 * THE io FOR A SESSION -- a broker Session, a KeeperProxy, or the keeper's own Session. Same verbs on all three: the pacer,
 * `need()` for the client, `roomContents` on a proxy. `sessionOf(agent)` looks the body up; `proxied(s)` says which kind.
 */
export function sessionFloorIo(sessionOf, { proxied = () => false, approach = null, reserve = null, capacityOf = null, settleMs = 600, character = null } = {}) {
  const nameOf = c => o => { try { return c.rsc?.get?.(o.nameRsc) ?? o.name ?? ''; } catch { return o.name ?? ''; } };
  return {
    async scene(agent) {
      const s = sessionOf(agent);
      if (proxied(s)) {
        const r = await s.roomContents({ timeout_ms: 2500 }).catch(e => ({ error: e.message }));
        if (r?.error) return { room: s.world?.room?.num ?? null, you: null, objects: [] };
        return { room: r.room ?? null, you: r.you ?? null,
                 objects: (r.objects ?? []).map(o => ({ id: o.id, name: o.name ?? '', col: o.col, row: o.row, amount: o.amount ?? 0, player: !!(o.is_player || ((o.flags ?? 0) & 0x0004)) })) };
      }
      const c = s.need();
      const since = c.evSeq;
      await s.pacer.submit('read', () => c.roomContents?.()).catch(() => {});
      await c.waitFor?.({ since, kinds: ['room-contents'], timeoutMs: 2500 })?.catch?.(() => null);
      const cl = s.need(), n = nameOf(cl), me = cl.self;
      return { room: s.world?.room?.num ?? null, you: me ? { col: me.col, row: me.row } : null,
               objects: [...(cl.room?.objects?.values?.() ?? [])].filter(o => o.id !== cl.selfId)
                 .map(o => ({ id: o.id, name: n(o), col: o.col, row: o.row, amount: o.amount ?? 0, player: !!((o.flags ?? 0) & 0x0004) })) };
    },
    async inventory(agent) {
      const s = sessionOf(agent);
      await s.pacer.submit('read', () => s.need().requestInventory?.()).catch(() => {});
      await s.need().waitFor?.({ kinds: ['inventory'], timeoutMs: 3000 })?.catch?.(() => null);
      const c = s.need(), n = nameOf(c);
      return (c.inventory ?? []).map(o => ({ id: o.id, name: n(o), amount: o.amount ?? 0, tag: o.tag }));
    },
    async get(agent, id) { const s = sessionOf(agent); return s.pacer.submit('get', () => s.need().get(id)).catch(e => ({ error: e.message })); },
    async drop(agent, row, n) {
      const s = sessionOf(agent);
      const spec = Number(row.amount) > 0 ? { id: row.id, amount: n == null ? Number(row.amount) : n } : row.id;
      return s.pacer.submit('drop', () => s.need().drop([spec])).catch(e => ({ error: e.message }));
    },
    async capacity(agent) {
      if (capacityOf) return capacityOf(sessionOf(agent));
      const c = sessionOf(agent).need(), cap = c.carry ?? carryCapacity(c);
      if (!cap?.known) return null;
      if (cap.room_for) return { bulk: cap.room_for.bulk, weight: cap.room_for.weight };
      return { bulk: cap.bulk_max - (cap.load?.bulk ?? 0), weight: cap.weight_max - (cap.load?.weight ?? 0) };
    },
    character(agent) { if (character) return character(agent); try { const s = sessionOf(agent); return s.need().me?.name ?? s.name ?? agent; } catch { return agent; } },
    ...(approach ? { approach } : {}),
    ...(reserve ? { reserve } : {}),
    settle: () => new Promise(r => setTimeout(r, settleMs)),
  };
}

// ============================================================================ WHEN AN OVERFLOW MAY DROP
//
// Operator follow-up, 2026-11-05: "Overflow drop-at-feet must fire ONLY on an AFFIRMATIVE 'receiver would accept this if it
// had space' signal. Distinguish 'full' from any form of 'not taking that' (not configured to accept trade goods, wrong item,
// refused offer, combat, etc.)". Two facts, both required:
//
//   WILLING  the receiver is configured to take THIS giver's goods. For `supply` the caller's own order is that config (it
//            names the receiver and the goods); for loot ejection the receiver's keeper publishes its `trade_goods` setting
//            (`publishAccepts`, refreshed every pass) and a stale or absent record is a no.
//   FULL     the refusal was about SPACE: the server's own "can't carry all the items" sentence, or the receiver's keeper
//            recording that THIS offer would fill its pack past `keep_free` (`noteRefusal` kind 'capacity'), after the
//            offer went out. A refusal for any other reason -- not on the take list, not a fleetmate, unweighed items,
//            a cursed item, busy, left, offline, a silent wire, no counter -- is not 'full' and drops nothing.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIGNAL_DIR = process.env.M59_FLOOR_SIGNAL_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'substrate', '.floor-signals');
export const ACCEPTS_MAX_AGE_MS = 5 * 60_000;
export const REFUSAL_MAX_AGE_MS = 60_000;

// The server's capacity sentences (user.kod; the same two m59-supply.mjs OFFER_FAILURES files under receiver_full).
const CAPACITY_SAID = [/can'?t carry all the items you have offered/i, /you can'?t carry all the items that .* offered you/i];
export const saidFull = (lines = []) => [].concat(lines ?? []).some(l => CAPACITY_SAID.some(re => re.test(String(l ?? ''))));

const fileKey = n => key(n).replace(/[^a-z0-9]+/g, '_') || '_';
const writeJson = (file, v) => { mkdirSync(dirname(file), { recursive: true }); const t = `${file}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(v)); renameSync(t, file); };
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

/** The receiver says what it accepts as trade goods (null: nothing). `tradeGoods` is normalizeTradeGoods' answer. */
export function publishAccepts(receiver, tradeGoods, { dir = SIGNAL_DIR, now = Date.now() } = {}) {
  const rec = { receiver: String(receiver), at: now,
                trade_goods: tradeGoods ? { from: tradeGoods.from ?? null, keep_free: tradeGoods.keep_free ?? null } : null };
  writeJson(join(dir, `accepts-${fileKey(receiver)}.json`), rec);
  return rec;
}
export const readAccepts = (receiver, { dir = SIGNAL_DIR } = {}) => readJson(join(dir, `accepts-${fileKey(receiver)}.json`));

/** The receiver records why it refused THIS giver's offer: kind 'capacity' (would fill the pack) or anything else. */
export function noteRefusal(receiver, giver, { kind, why = null, after = null }, { dir = SIGNAL_DIR, now = Date.now() } = {}) {
  const file = join(dir, `refusals-${fileKey(receiver)}.json`);
  const book = readJson(file) ?? {};
  for (const [g, r] of Object.entries(book)) if (!(now - Number(r?.at) < REFUSAL_MAX_AGE_MS * 10)) delete book[g];
  book[key(giver)] = { kind: String(kind), why, after, at: now };
  writeJson(file, book);
  return book[key(giver)];
}
export const readRefusal = (receiver, giver, { dir = SIGNAL_DIR } = {}) => (readJson(join(dir, `refusals-${fileKey(receiver)}.json`)) ?? {})[key(giver)] ?? null;

/**
 * MAY THE GIVER DROP THE REFUSED GOODS AT THE RECEIVER'S FEET? Pure.
 * @param willing   true when the caller's own order names this receiver and these goods (supply); otherwise read `accepts`
 * @param accepts   the receiver's published record (publishAccepts) -- loot ejection
 * @param refusal   the receiver's record for this giver (noteRefusal), or null
 * @param said      what the server told either side
 * @param since     when this offer went out (a refusal before it is about another offer)
 * -> { drop, why }
 */
export function overflowVerdict({ willing = false, accepts = null, refusal = null, said = [], giver, since = 0, now = Date.now() } = {}) {
  if (!willing) {
    if (!accepts || !(now - Number(accepts.at) <= ACCEPTS_MAX_AGE_MS)) return { drop: false, why: 'the receiver has not said it accepts trade goods (no fresh record): not dropped' };
    if (!accepts.trade_goods) return { drop: false, why: 'the receiver does not accept trade goods: not dropped' };
    const from = accepts.trade_goods.from;
    if (Array.isArray(from) && !from.map(key).includes(key(giver))) return { drop: false, why: `the receiver takes trade goods only from ${from.join(', ')}: not dropped` };
  }
  if (saidFull(said)) return { drop: true, why: 'the server said the receiver cannot carry it' };
  if (refusal && Number(refusal.at) >= Number(since) && now - Number(refusal.at) <= REFUSAL_MAX_AGE_MS) {
    if (refusal.kind === 'capacity') return { drop: true, why: `the receiver refused for space: ${refusal.why ?? 'its pack would be too full'}` };
    return { drop: false, why: `the receiver refused for another reason (${refusal.kind}: ${refusal.why ?? '?'}): not dropped` };
  }
  return { drop: false, why: 'no affirmative capacity refusal (silent, no counter, or another reason): not dropped' };
}
