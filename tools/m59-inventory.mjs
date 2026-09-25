// INVENTORY — WHAT A CHARACTER CARRIES, AND EVERY WAY WE HAVE LEARNED TO MOVE IT.
//
// One module for pack handling, so an errand gets it right by importing it instead of rediscovering
// it (operator, 2026-09-25: "make sure the inventory management is done through reusable
// FleetScript, so future efforts don't have to independently fix the same problems"). Every rule
// here was paid for on the 2026-09-25 ghost-raid rehearsals; each says which failure it prevents.
//
//   classify(name)            money | cup | reagent | weapon | armour | magic | food | junk — ONE
//                             answer, reagents first (so ELDERBERRY is never "food"), food from the
//                             game's own Food class tree (m59-fleetscript foodIn), never a regex
//   freshItems / roomFor      the pack and its free room AS THE SERVER HAS THEM NOW (look fresh),
//                             never the keeper's cached inventory
//   grabFromFloor             walk within reach (UserGet refuses past 7 squares, in silence), get,
//                             read back, retry
//   makeRoom                  drop junk heaviest first, then food past a keep; never money,
//                             reagents, the cup, gear, jewellery or anything WORN
//   handOver                  supply one thing; a full receiver makes room and is asked again
//   buyByName                 one exchange per piece of gear, one per stack, read back
//   walkRoom                  travel and wait; clear the journey on arrival (a registered travel
//                             refuses the next walk "busy")
//   cupRide                   the Chalice of the Rain: dropped and grabbed, never handed (it refuses
//                             a trade); a cup already on the floor is used; the holder takes it back
//                             if the rider cannot lift it; riders one at a time, spaced
//   hallStash/Deposit/Draw    the guild chests, one character at a time through the spoken door
//
// And the same as FleetScript STEPS (makeRoomStep, grabStep, handOverStep, buyStep, stashStep,
// depositStep, drawStep, cupRideStep), so a script composes them like walk() and verify().
import { call, observe, verify, foodIn, REAGENT_RE } from './m59-fleetscript.mjs';
import { weighItem } from './m59-items.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lower = s => String(s ?? '').toLowerCase().trim();

// ------------------------------------------------------------------------- classification

const WEAPON = /\b(sword|axe|hammer|mace|scimitar|bow|arrows?|staff|dagger|club|spear|flail|javelin)\b/i;
const ARMOUR = /\b(armor|armour|shield|robe|helm|gauntlets?|boots|pants|shirt|circlet|cloak|gloves)\b/i;
const MAGIC = /\b(ring|amulet|necklace|wand|potion|scroll|signet|jewel|gem|ruby|diamond|emerald|sapphire)\b/i;

/**
 * WHAT A THING IS, for keeping and dropping. Order matters and is the point:
 *   money, cup, then REAGENTS (REAGENT_RE — the harness's one list), then gear, then magic,
 *   then FOOD by the game's Food class tree, then junk.
 * Reagents before food is the elderberry rule: /berry/ once called elderberry food and a dedicator
 * dropped 18 of the reagents it was about to cast with.
 */
export function classify(name) {
  const n = lower(typeof name === 'string' ? name : name?.name);
  if (!n) return 'junk';
  if (/^shilling/.test(n)) return 'money';
  if (/chalice/.test(n)) return 'cup';
  if (REAGENT_RE.test(n) || /dragon scale|eye of the|kriipa|uncut seraphym|polished seraphym/.test(n)) return 'reagent';
  if (WEAPON.test(n)) return 'weapon';
  if (ARMOUR.test(n)) return 'armour';
  if (MAGIC.test(n)) return 'magic';
  if (foodIn([{ name: n }]).length) return 'food';
  return 'junk';
}

/** Keep profiles: which classes are never dropped, and how much food to keep of each kind. */
export const KEEP = Object.freeze({
  // A raider making room for raid gear (operator: "junk loot + excess food").
  // Weapons are NOT kept wholesale (operator, 2026-09-25: "We never want to drop swords that are
  // earmarked for use in the current raid, but it's fine to drop swords/weapons otherwise"). A
  // raider carrying twenty-two long swords could not take a shield. What stays: anything worn,
  // one spare of each worn weapon, and whatever the running errand has EARMARKED (see earmark()).
  raid: Object.freeze({ keep: ['money', 'cup', 'reagent', 'armour', 'magic'], food: 10, spareWeapons: 1 }),
  // Everything but junk — the most conservative.
  all: Object.freeze({ keep: ['money', 'cup', 'reagent', 'weapon', 'armour', 'magic', 'food'], food: Infinity }),
});

/**
 * The armorer's hall-stash keep list, as the SUBSTRINGS the keeper's stash matches (it runs in the
 * keeper, which cannot import this). Money, the cup, weapons for the hammer hand-out, light food.
 */
export const HALL_STASH_KEEP = Object.freeze(['shilling', 'chalice', 'hammer', 'mace', 'sword', 'axe', 'scimitar',
  'bread', 'edible mushroom', 'apple', 'cheese']);

/** What never goes on a smith's counter (sell_all keep list). */
export const SELL_KEEP = Object.freeze(['shilling', 'elderberry', 'herb', 'mushroom', 'orc tooth', 'emerald', 'sapphire', 'ruby',
  'hammer', 'mace', 'chain', 'shield', 'chalice', 'bread', 'pork', 'mutton', 'apple', 'cheese', 'spider eye', 'edible']);

// ------------------------------------------------------------------------- reading the pack

/** The pack, fresh from the server (`look fresh:true`, as_of_ms 0) — never the keeper's cache. */
export const freshLook = agent => call('look', { agent, fresh: true }, 40_000).catch(() => null);
export const freshItems = async agent => (await freshLook(agent))?.items ?? [];
/** Free {weight, bulk} as the SERVER counts it (negative when over the limit). */
export const roomFor = async agent => (await freshLook(agent))?.carry?.room_for ?? null;
export const hasItem = async (agent, re) => (await freshItems(agent)).some(x => re.test(String(x.name ?? '')));
export const countItem = (items, name) => items.filter(i => lower(i.name).replace(/s$/, '') === lower(name).replace(/s$/, ''))
  .reduce((n, i) => n + (Number(i.amount) || 1), 0);

// ------------------------------------------------------------------------- moving things

/**
 * PICK SOMETHING UP OFF THE FLOOR, AND KEEP TRYING UNTIL IT IS IN THE PACK. Found by what is on the
 * floor now, never a stored id; within reach first (UserGet, user.kod:3576, refuses past a row +
 * column distance of 7 IN SILENCE — a rider 32 squares away got nothing, 2026-09-25); read back
 * fresh (the cached inventory said "missing" for a cup that had arrived).
 */
export async function grabFromFloor(agent, re, tries = 10) {
  for (let i = 0; i < tries; i++) {
    await sleep(1500);
    const l = await freshLook(agent);
    if ((l?.items ?? []).some(x => re.test(String(x.name ?? '')))) return true;
    const onFloor = (l?.objects ?? []).find(o => re.test(String(o.name ?? '')));
    if (!onFloor) continue;
    const me = l?.you;
    if (me && Number.isFinite(onFloor.col) && Math.abs(me.col - onFloor.col) + Math.abs(me.row - onFloor.row) > 5)
      await call('walk_to', { agent, col: onFloor.col, row: onFloor.row }, 120_000).catch(() => {});
    await call('act', { agent, verb: 'get', target: onFloor.id }, 60_000).catch(() => {});
  }
  return hasItem(agent, re);
}

/**
 * MAKE ROOM: drop junk heaviest first, then food past the profile's keep, until `min` weight AND
 * bulk are free. Never a kept class, never anything WORN (matched by name against the worn list).
 * Returns {item: dropped} or null. The operator's rule for raids is KEEP.raid.
 */
/**
 * WHAT MAY GO, IN ORDER — pure, so it is testable. Junk heaviest first (whole stacks), then food
 * past `keepFood` of each kind (the excess only), heaviest first. Never a kept class, never worn.
 * Returns [{item, amount|null}] — amount null means the whole stack.
 */
// ------------------------------------------------------------------------- earmarks
// WHAT THE CURRENT ERRAND HAS SPOKEN FOR. makeRoom never drops an earmarked item. An errand
// earmarks a KIND for everyone (the ghost raid: every hammer) or one object for one agent (a
// weapon a dedicator is holding for its owner), and clears its own marks when it is done.
const EARMARK_ALL = new Map();            // label -> predicate(item, agent)
const EARMARK_IDS = new Map();            // agent -> Set(id)
export function earmark(label, predicate) { EARMARK_ALL.set(label, predicate); return () => EARMARK_ALL.delete(label); }
export function earmarkItem(agent, id) {
  if (!EARMARK_IDS.has(agent)) EARMARK_IDS.set(agent, new Set());
  EARMARK_IDS.get(agent).add(Number(id));
  return () => EARMARK_IDS.get(agent)?.delete(Number(id));
}
export function isEarmarked(agent, item) {
  if (item?.id != null && EARMARK_IDS.get(agent)?.has(Number(item.id))) return true;
  for (const p of EARMARK_ALL.values()) { try { if (p(item, agent)) return true; } catch {} }
  return false;
}
export function clearEarmarks() { EARMARK_ALL.clear(); EARMARK_IDS.clear(); }

export function dropCandidates(items = [], worn = [], { profile = KEEP.raid, keepFood = profile.food, earmarked = () => false } = {}) {
  const wornNames = worn.map(x => lower(typeof x === 'string' ? x : x?.name));
  const wornSet = new Set(wornNames);
  const w = it => (Number(weighItem(it.name)?.weight) || 10) * (Number(it.amount) || 1);
  const kept = it => earmarked(it) || profile.keep.includes(classify(it.name))
    || (classify(it.name) !== 'weapon' && wornSet.has(lower(it.name)));
  const junk = items.filter(it => it.id != null && !kept(it) && classify(it.name) === 'junk')
    .sort((a, b) => w(b) - w(a)).map(it => ({ item: it, amount: null }));
  // SPARE WEAPONS. The pack does not say WHICH copy is wielded, so a worn weapon's name keeps as
  // many copies as are worn plus `spareWeapons`; makeRoom re-wields if the dropped copy was the one
  // in hand. Other kinds keep none unless earmarked.
  const weapons = [];
  if (profile.spareWeapons != null && !profile.keep.includes('weapon')) {
    const byName = new Map();
    for (const it of items.filter(it => it.id != null && !kept(it) && classify(it.name) === 'weapon'))
      byName.set(lower(it.name), [...(byName.get(lower(it.name)) ?? []), it]);
    for (const [name, list] of byName) {
      const keepN = wornNames.filter(n => n === name).length + (wornSet.has(name) ? profile.spareWeapons : 0);
      weapons.push(...list.slice(keepN));
    }
    weapons.sort((a, b) => w(b) - w(a));
  }

  const food = !Number.isFinite(keepFood) ? [] : items.filter(it => it.id != null && !kept(it)
      && classify(it.name) === 'food' && (Number(it.amount) || 1) > keepFood)
    .sort((a, b) => w(b) - w(a)).map(it => ({ item: it, amount: (Number(it.amount) || 1) - keepFood }));
  return [...junk, ...weapons.map(it => ({ item: it, amount: null })), ...food];
}

export async function makeRoom(agent, { min = 400, profile = KEEP.raid, keepFood = profile.food } = {}) {
  let l = await freshLook(agent);
  const enough = r => r && Math.min(r.weight ?? 0, r.bulk ?? 0) >= min;
  if (!l || enough(l.carry?.room_for)) return null;
  const dropped = {};
  const wornBefore = (l.equipment ?? []).map(x => lower(typeof x === 'string' ? x : x?.name));
  let droppedWeapon = false;
  for (const { item: it, amount } of dropCandidates(l.items ?? [], l.equipment ?? [], { profile, keepFood, earmarked: it => isEarmarked(agent, it) })) {
    if (enough(l?.carry?.room_for)) break;
    await call('act', { agent, verb: 'drop', target: it.id, ...(amount ? { amount } : {}) }, 30_000).catch(() => {});
    dropped[it.name] = (dropped[it.name] ?? 0) + (amount ?? (Number(it.amount) || 1));
    if (classify(it.name) === 'weapon') droppedWeapon = true;
    l = await freshLook(agent);
  }
  // THE COPY IN HAND MAY HAVE BEEN ONE OF THOSE DROPPED — nothing on the wire says which copy is
  // wielded, and dropping it unwields it. Put the spare in hand.
  if (droppedWeapon) {
    const nowWorn = new Set((l?.equipment ?? []).map(x => lower(typeof x === 'string' ? x : x?.name)));
    for (const name of new Set(wornBefore.filter(n => classify(n) === 'weapon' && !nowWorn.has(n)))) {
      const spare = (l?.items ?? []).find(i => lower(i.name) === name && i.id != null);
      if (spare) await call('act', { agent, verb: 'use', target: spare.id }, 60_000).catch(() => {});
    }
  }
  return Object.keys(dropped).length ? dropped : null;
}

let CHAIN = Promise.resolve();
/** Trades one at a time across the whole process: two supplies to one receiver collide. */
// REENTRANT. A serial step that calls another serial helper (lateDedicate's hand-back goes through
// handOver) would otherwise queue behind itself and wait for ever. Inside the chain, run at once.
const IN_CHAIN = new AsyncLocalStorage();
export const serially = fn => {
  if (IN_CHAIN.getStore()) return Promise.resolve().then(fn);
  const run = () => IN_CHAIN.run(true, fn);
  const p = CHAIN.then(run, run); CHAIN = p.catch(() => {}); return p;
};

/**
 * HAND ONE THING OVER (supply, verified both sides). A full receiver MAKES ROOM and is asked again —
 * packs fill after a muster, so an up-front make-room is too early (half the armour came home
 * undelivered on 2026-09-25). `what` is an id, or {id, amount} for part of a stack.
 */
export async function handOver(from, to, what, { makeRoomMin = 400 } = {}) {
  const give = () => serially(() => call('supply', { from, to, what: [what], who_travels: 'neither' }, 120_000)
    .catch(e => ({ supplied: false, reason: e.message })));
  let r = await give();
  if (!r?.supplied && /receiver_full|cannot hold/i.test(String(r?.reason ?? ''))) {
    if (await makeRoom(to, { min: makeRoomMin })) r = await give();
  }
  return { ok: !!r?.supplied, why: r?.supplied ? null : (r?.reason ?? '?') };
}

/**
 * BUY NAMED ITEMS: one exchange per piece of gear (an order of six shields in one line bought ONE),
 * one per stack, read back after each. Returns {item: bought}; an item the merchant does not sell
 * is 0, never skipped.
 */
export async function buyByName(agent, seller, lines = []) {
  const list = await call('shop', { agent, seller }, 120_000).catch(() => null);
  const norm = x => lower(x).replace(/ies$/, 'y').replace(/s$/, '');
  const out = {};
  for (const { item, amount } of lines) {
    const it = (list?.items ?? []).find(i => norm(i.name) === norm(item));
    // A LINE THAT BUYS NOTHING SAYS WHY. On the 2026-09-25 rehearsal a rider with 831 free bulk
    // and 4,120 shillings bought 0 of 26 mushrooms from a shop that sells them, and the step had
    // kept nothing that could say whether the shop did not open, did not list it, or clamped it.
    if (!it) { out[item] = 0; (out.why ??= {})[item] = list?.items?.length ? `not on ${seller}'s list` : `the shop did not open: ${list?.note ?? 'no answer'}`; continue; }
    let last = null;
    const start = countItem(await freshItems(agent), item);
    let have = start;
    const stack = Number(it.amount) > 1 || /elderberr|herb|mushroom|tooth|sapphire|emerald|ruby|berr/i.test(item);
    // ASK AGAIN FOR THE REMAINDER UNTIL THE PACK SAYS DONE. The broker splits an order into
    // chunks of 50 and stops at the first chunk whose arrival it did not see in time, so 125
    // elderberry came back as 50 on the 2026-09-25 rehearsal with room and money to spare. The
    // pack decides; a round that adds nothing ends it. Gear still goes one piece per exchange.
    for (let i = 0; i < (stack ? Math.ceil(amount / 50) + 2 : amount) && have - start < amount; i++) {
      last = await call('shop', { agent, seller, buy_ids: [{ id: it.id, amount: stack ? amount - (have - start) : 1 }] }, 180_000).catch(e => ({ error: e.message }));
      const now = countItem(await freshItems(agent), item);
      if (now <= have) break;
      have = now;
    }
    out[item] = have - start;
    if (out[item] < amount) (out.why ??= {})[item] = JSON.stringify({ note: last?.note ?? last?.error, clamped: last?.clamped, bought: last?.bought }).slice(0, 300);
  }
  return out;
}

/**
 * WALK TO A ROOM AND WAIT FOR IT; clear the journey on arrival. A background travel stays
 * registered after the body is there, and the next walk is refused "busy: walk to <here>".
 */
export async function walkRoom(agent, to, { floor = 0, budgetMs = 15 * 60_000, tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    await call('cancel_movement', { agent, why: `walking to ${to}` }, 30_000).catch(() => {});
    await call('travel', { agent, to, background: true, run_errands: false, health_floor: floor }, 60_000).catch(() => {});
    const until = Date.now() + budgetMs;
    while (Date.now() < until) {
      const o = await observe(agent);
      if (o.dead) return { ok: false, dead: true };
      if (Number(o.room) === Number(to)) { await call('cancel_movement', { agent, why: 'arrived' }, 30_000).catch(() => {}); return { ok: true }; }
      await sleep(3000);
    }
  }
  return { ok: Number((await observe(agent)).room) === Number(to) };
}

// ------------------------------------------------------------------------- the cup

let CUP = Promise.resolve();
const RIDE_GAP_MS = Number(process.env.M59_RIDE_GAP_MS ?? 20_000);
/** One rider at a time, spaced: a Rescue lands 15-25 s after the drink. */
export const rideCup = fn => { const p = CUP.then(fn, fn); CUP = p.catch(() => {}).then(() => sleep(RIDE_GAP_MS)); return p; };

/**
 * THE CHALICE OF THE RAIN, ONE RIDE: rider takes the cup, drinks (Rescue to the guild hall), drops
 * it; the holder takes it back (a Shal'ille room refills it on the drop).
 *   - DROPPED AND GRABBED, NEVER HANDED: the cup refuses a trade (item_refuses_to_leave).
 *   - A CUP ALREADY ON THE FLOOR IS USED: the holder's own keeper puts it down to refill it.
 *   - IF THE RIDER CANNOT LIFT IT, THE HOLDER TAKES IT BACK, or it lies there for every later rider.
 * Call inside rideCup(). Returns {ok, why?, cupBack}.
 */
export async function cupRide(rider, holder, { hall = 714, waitMs = 5 * 60_000 } = {}) {
  // THE CUP IS HANDED ACROSS A FLOOR, SO BOTH MUST BE STANDING ON IT. On the 2026-09-25 rehearsal
  // the holder had been walked off to another map; it dropped the cup there and two riders in the
  // stage room each came back "could not pick the cup up". Wait a while for the holder to be here,
  // and say where each of them is if it never comes — never drop a cup the rider cannot reach.
  const roomOf = async a => Number((await observe(a)).room);
  const meetBy = Date.now() + waitMs;
  let hr = await roomOf(holder), rr = await roomOf(rider);
  while (hr !== rr && Date.now() < meetBy) { await sleep(5000); hr = await roomOf(holder); rr = await roomOf(rider); }
  if (hr !== rr) return { ok: false, why: `${holder} (the cup) is in room ${hr} and ${rider} in room ${rr} — the cup is not dropped` };
  const cup = (await freshItems(holder)).find(i => /chalice/i.test(String(i.name ?? '')));
  if (!cup) {
    const floor = ((await freshLook(holder))?.objects ?? []).find(o => /chalice/i.test(String(o.name ?? '')));
    if (!floor) return { ok: false, why: `${holder} is not carrying the chalice, and none lies in its room` };
  } else await call('act', { agent: holder, verb: 'drop', target: cup.id }, 60_000).catch(() => {});
  if (!(await grabFromFloor(rider, /chalice/i))) {
    const back = await grabFromFloor(holder, /chalice/i);
    return { ok: false, why: `${rider} could not pick the cup up after ${holder} dropped it` + (back ? '' : ' — AND the holder could not take it back') };
  }
  const mine = (await freshItems(rider)).find(i => /chalice/i.test(String(i.name ?? '')));
  await call('rest', { agent: rider, stand: true }, 30_000).catch(() => {});
  await call('act', { agent: rider, verb: 'eat', target: mine.id }, 60_000).catch(() => {});
  await sleep(1500);
  await call('act', { agent: rider, verb: 'drop', target: mine.id }, 60_000).catch(() => {});
  const cupBack = await grabFromFloor(holder, /chalice/i);
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (Number((await observe(rider)).room) === Number(hall)) return { ok: true, cupBack };
    await sleep(2000);
  }
  return { ok: false, why: 'the ride did not land in the hall (not a guild member? teleport blocked after PVP?)', cupBack };
}

// ------------------------------------------------------------------------- the guild hall

let HALL = Promise.resolve();
/** One character at a time through the hall's spoken door (it opens for five seconds). */
export const inHall = fn => { const p = HALL.then(fn, fn); HALL = p.catch(() => {}); return p; };

const hallCall = (agent, args) => inHall(() => call('hall_withdraw', { agent, ...args }, 620_000)
  .catch(e => ({ ok: false, why: e.message })));
/** Empty the pack into a chest, keeping the substrings in `keep` (and anything worn). */
export const hallStash = (agent, keep = HALL_STASH_KEEP) => hallCall(agent, { wants: [], stash: [...keep] });
/** Put these named things into the chests. */
export const hallDeposit = (agent, names = []) => hallCall(agent, { wants: [], deposit: [...names] });
/** Take [{item, amount}] out of the chests, EXACT amounts (REQ_GET_FROM_CONTAINER carries a count). */
export const hallDraw = (agent, wants = [], { stash = null } = {}) => hallCall(agent, { wants, ...(stash ? { stash: [...stash] } : {}) });

// ------------------------------------------------------------------------- FleetScript steps

const stepOf = (fn, why) => verify(async ctx => { const agent = ctx.agent; return fn(agent, ctx); }, why);
/** Make room in the pack (KEEP.raid by default). Always passes; logs what went. */
export const makeRoomStep = (opts = {}) => stepOf(async agent => {
  const d = await makeRoom(agent, opts);
  if (d) console.log(`  ${agent} made room: dropped ${JSON.stringify(d)}`);
  return true;
}, 'making room in the pack');
/** Pick a named thing up off the floor. */
export const grabStep = (re, why = 'picked it up off the floor') => stepOf(agent => grabFromFloor(agent, re), why);
/** Hand a named thing to a fleet-mate (by name, the first stack that matches). */
export const handOverStep = (to, name, why) => stepOf(async agent => {
  const it = (await freshItems(agent)).find(i => lower(i.name).includes(lower(name)));
  if (!it) return { ok: false, why: `no ${name} to hand over` };
  const r = await handOver(agent, typeof to === 'function' ? to(agent) : to, it.id);
  return r.ok || { ok: false, why: r.why };
}, why ?? `handed ${name} over`);
/** Buy named items from a merchant (stand in its room first). */
export const buyStep = (seller, lines, why) => stepOf(async agent => {
  const got = await buyByName(agent, seller, lines);
  console.log(`  ${agent} bought: ${JSON.stringify(got)}`);
  return Object.values(got).some(n => n > 0) || { ok: false, why: `bought nothing from ${seller}` };
}, why ?? `bought from ${seller}`);
/** In the guild hall: empty the pack into a chest. */
export const stashStep = (keep = HALL_STASH_KEEP) => stepOf(async agent => {
  const r = await hallStash(agent, keep);
  return r?.ok ? true : { ok: false, why: r?.why ?? 'the stash was refused' };
}, 'stashed the pack in the guild chests');
/** In the guild hall: deposit named things. */
export const depositStep = names => stepOf(async agent => {
  const r = await hallDeposit(agent, names);
  console.log(`  ${agent} deposited ${r?.stashed ?? 0}`);
  return r?.ok ? true : { ok: false, why: r?.why ?? 'the deposit was refused' };
}, 'deposited in the guild chests');
/** In the guild hall: draw exact amounts. */
export const drawStep = wants => stepOf(async agent => {
  const r = await hallDraw(agent, wants);
  console.log(`  ${agent} drew ${JSON.stringify(r?.took ?? {})}${Object.keys(r?.short ?? {}).length ? ` SHORT ${JSON.stringify(r.short)}` : ''}`);
  return r?.ok ? true : { ok: false, why: r?.why ?? 'the draw was refused' };
}, 'drew from the guild chests');
/** Ride the Chalice of the Rain to the guild hall from `holder`'s room. */
export const cupRideStep = (holder, opts = {}) => stepOf(async agent => {
  const r = await rideCup(() => cupRide(agent, typeof holder === 'function' ? holder(agent) : holder, opts));
  return r.ok || { ok: false, why: r.why };
}, 'rode the Chalice of the Rain to the guild hall');
