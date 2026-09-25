// THE ARMORERS: pool the fleet's money, ride the chalice to the guild hall, buy shields, chain
// and missing hammers at the Barloque smith, walk it back to Castle Victoria and dress the fleet.
//
// Operator, 2026-09-24: "send a designated pair of armorers who everyone hands their money to in
// Castle Victoria, who then takes a chalice-ride home, sells/drops anything non-essential they're
// carrying, and then they buy as many leather/chain armors and small-round-shields as they can
// carry, which they bring back to Castle Victoria to re-equip the rest of the fleet (they can do
// the shopping run while the fleet is assembling their enchanted hammers)." Chain rather than
// leather by the operator's choice: Barloque sells no leather, and a tusked skeleton SLASHES,
// which chain resists by 20%.
//
// NOTHING HERE USES A DM POWER. Every step is a broker tool a player has: `supply` for money
// and goods, `act eat` to drink the cup (the broker's `eat` is c.apply(target, self), the same
// call the keeper's own chalice ride makes, m59-autopilot.mjs), `act drop`/`get` for the cup,
// `travel`, `sell_all`, `shop`, `act use` to wear. The same code runs on prod and on a
// full-fidelity shadow clone, which is the point of the rehearsal.
//
// FACTS IT RESTS ON (docs/armorer-run-facts.md, from the research pass of 2026-09-24):
//   * the cup is in Loial's pack; drinking it casts Rescue (chalice.kod:189-208), which for a
//     Second Swines member lands in hall 714 (rescue.kod:113-167) 15-25 s later; a drop and a
//     pick-up in room 2 (forest) refills it, so it serves any number of drinkers;
//   * 714's only exit is 101; the smith Fehr'loi Qan is 3 city hops away in 113 (x1.8 markup,
//     unlimited stock): hammer 810, chain 1,800, small round shield 288;
//   * the only road back to room 2 is 11 hops through 584, 598 and Ukgoth 599 — the pair crosses
//     it together, from 598, like the muster convoy;
//   * weight and bulk each cap at 1700 + 20 x might; a shield is 100/125, chain 200/250, a hammer
//     80/75 — an empty pack holds about seven shield+chain kits.

import { call, castVerified, observe } from '../m59-fleetscript.mjs';
import { weighItem } from '../m59-items.mjs';
// PACK HANDLING LIVES IN m59-inventory.mjs — the cup, the floor, making room, hand-overs, buying,
// walking, the hall. Re-exported under the names this file used to define, so callers are unchanged.
import { rideCup, inHall, serially, walkRoom, cupRide, freshItems, grabFromFloor, makeRoom as invMakeRoom,
         handOver, buyByName, HALL_STASH_KEEP, SELL_KEEP, hallStash, KEEP, roomFor } from '../m59-inventory.mjs';
export { rideCup, buyByName, HALL_STASH_KEEP };
export const chaliceRide = (armorer, holder, opts) => cupRide(armorer, holder, opts);
export const PACK_KEEP = SELL_KEEP;
/** The raid's make-room: the operator's rule (KEEP.raid), `keep` food of each kind, `min` free. */
export const makeRoom = (agent, { keep = 10, min = 400 } = {}) => invMakeRoom(agent, { min, profile: KEEP.raid, keepFood: keep });
import { barrier, reexpect, DEDICATE, countFamily, isReagent } from '../m59-ghostraid-lib.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lower = s => String(s ?? '').toLowerCase();

// ----------------------------------------------------------------------------------- pure

export const OUTFIT = Object.freeze({
  shield: { match: /^small round shield$/i, weight: 100, bulk: 125, price: 288 },
  chain:  { match: /^chain armor$/i,        weight: 200, bulk: 250, price: 1800 },
  hammer: { match: /^hammer$/i,             weight: 80,  bulk: 75,  price: 810 },
});
const SHIELDISH = /shield/i;
const ARMORISH = /armor|armour|chain|plate|mail/i;
const BLUNT = /^(hammer|mace)$/i;

/**
 * What one raider still needs, from what it carries (inventory lists worn items too). Pure.
 * A raider holding ANY shield or ANY body armour at least as good as chain is left alone for
 * that slot; a mace counts as blunt, so only a raider with no blunt weapon at all gets a hammer.
 */
export function outfitNeeds(items = []) {
  const names = items.map(i => String(i.name ?? ''));
  return {
    shield: !names.some(n => SHIELDISH.test(n)),
    // BODY ARMOUR, not a word in a name: "blue dragon scale" is a reagent, and /scale/ alone let
    // two raiders in leather count as armoured on 2026-09-25.
    chain: !names.some(n => /\b(chain|plate|scale)\s+(armou?r|mail)\b/i.test(n)),
    hammer: !names.some(n => BLUNT.test(n.trim())),
  };
}

/**
 * Turn every raider's needs into a shopping list, in the operator's priority: a shield for
 * everyone first (cheap, light, and it makes the block skill they already have count), then
 * chain, then a hammer where nothing blunt is carried. Cut to the money and to what the
 * armorers can carry, and SAY what was cut. Pure; deterministic in agent name order.
 *
 *   needs: { agent: {shield, chain, hammer} }
 *   budget: shillings; capacity: [{agent, weight, bulk}] free per armorer
 */
export function planOutfit(needs = {}, { budget = 0, capacity = [], order = ['shield', 'chain', 'hammer'] } = {}) {
  const agents = Object.keys(needs).sort((a, b) => lower(a).localeCompare(lower(b)));
  const cap = capacity.map(c => ({ ...c, lines: [] }));
  let money = budget;
  const buys = [], cut = [];
  for (const kind of order) {
    const spec = OUTFIT[kind];
    for (const a of agents) {
      if (!needs[a]?.[kind]) continue;
      if (money < spec.price) { cut.push({ agent: a, kind, why: 'money' }); continue; }
      const carrier = cap.filter(c => c.weight >= spec.weight && c.bulk >= spec.bulk)
        .sort((x, y) => (y.weight + y.bulk) - (x.weight + x.bulk))[0];
      if (!carrier) { cut.push({ agent: a, kind, why: 'pack' }); continue; }
      carrier.weight -= spec.weight; carrier.bulk -= spec.bulk;
      carrier.lines.push({ agent: a, kind });
      money -= spec.price;
      buys.push({ agent: a, kind, carrier: carrier.agent });
    }
  }
  return { buys, cut, spend: budget - money, byCarrier: Object.fromEntries(cap.map(c => [c.agent, c.lines])) };
}

/** Free weight and bulk in a pack, from the carry block the fleet row / status reports. */
export function packRoom(might, items = []) {
  const ceiling = 1700 + 20 * (Number(might) || 0);
  const used = items.reduce((acc, i) => {
    const kind = Object.values(OUTFIT).find(o => o.match.test(String(i.name ?? '').trim()));
    acc.w += (kind?.weight ?? (Number(i.weight) || 0)) * (i.amount || 1);
    acc.b += (kind?.bulk ?? (Number(i.bulk) || 0)) * (i.amount || 1);
    return acc;
  }, { w: 0, b: 0 });
  return { weight: Math.max(0, ceiling - used.w), bulk: Math.max(0, ceiling - used.b), ceiling };
}

// ----------------------------------------------------------------------------------- runtime

/** One run's shared state across agents (fleetScript runs them in one process). */
export const OUTFIT_RUN = { plan: null, delivered: new Map(), done: false, cupHolder: null, log: [] };

const purseOf = items => items.filter(i => /^shilling/i.test(String(i.name ?? '')))
  .reduce((n, i) => n + (Number(i.amount) || 1), 0);
// FRESH, never the keeper's cached inventory (m59-inventory freshItems).
const inv = freshItems;

/** Hand everything but a small reserve to this raider's armorer. */
export async function poolMoney(agent, armorer, keep = 20) {
  const items = await inv(agent);
  const stack = items.filter(i => /^shilling/i.test(String(i.name ?? '')) && i.id != null)
    .sort((a, b) => (b.amount || 1) - (a.amount || 1))[0];
  const give = (stack?.amount ?? 0) - keep;
  if (!stack || give <= 0) return { gave: 0 };
  const r = await serially(() => call('supply', { from: agent, to: armorer, what: [{ id: stack.id, amount: give }],
                                                  who_travels: 'neither' }, 120_000).catch(e => ({ supplied: false, reason: e.message })));
  return { gave: r?.supplied ? give : 0, why: r?.supplied ? null : r?.reason };
}

const hopTo = (agent, to, { floor = 0 } = {}) => walkRoom(agent, to, { floor });

/** Sell what the smith buys, keeping money, reagents, food, the outfit and the cup. */
export async function clearPack(agent, merchant) {
  const keep = PACK_KEEP;
  const r = await call('sell_all', { agent, merchant, keep }, 300_000).catch(e => ({ error: e.message }));
  return r?.error ? { error: r.error } : { sold: r?.sold ?? r?.count ?? null };
}

/** Buy this armorer's share of the plan from the smith. */
export async function buyShare(agent, merchant, lines) {
  const want = {};
  for (const l of lines) want[l.kind] = (want[l.kind] ?? 0) + 1;
  const list = await call('shop', { agent, seller: merchant }, 120_000).catch(e => ({ error: e.message }));
  const items = list?.items ?? [];
  const buy = [];
  for (const [kind, n] of Object.entries(want)) {
    const it = items.find(i => OUTFIT[kind].match.test(String(i.name ?? '').trim()));
    if (it) buy.push({ id: it.id, amount: n });
  }
  if (!buy.length) return { bought: {}, why: list?.error ?? list?.note ?? 'the smith sells none of it' };
  // ONE PIECE PER EXCHANGE, READ BACK EACH TIME. Armour and shields do not stack, and on the
  // 2026-09-25 rehearsal an order of six shields in one line bought ONE, and an order for the
  // other armorer bought none, with nothing logged to say why. So: one at a time, count the
  // pack after each, stop a kind at the first exchange that brings nothing, and log the reply.
  const countKind = (items, k) => items.filter(i => OUTFIT[k].match.test(String(i.name ?? '').trim()))
    .reduce((n, i) => n + (i.amount || 1), 0);
  const start = await inv(agent);
  const replies = [];
  for (const line of buy) {
    const kind = Object.keys(want).find(k => OUTFIT[k].match.test(String(items.find(i => i.id === line.id)?.name ?? '').trim()));
    let have = countKind(start, kind);
    for (let i = 0; i < line.amount; i++) {
      const r = await call('shop', { agent, seller: merchant, buy_ids: [{ id: line.id, amount: 1 }] }, 120_000)
        .catch(e => ({ error: e.message }));
      const now = countKind(await inv(agent), kind);
      if (now <= have) {
        replies.push({ kind, at: i, error: r?.error ?? null, note: r?.note ?? null, clamped: r?.clamped ?? null });
        break;
      }
      have = now;
    }
  }
  const after = await inv(agent);
  const bought = Object.fromEntries(Object.keys(want).map(k => [k, countKind(after, k)]));
  if (replies.length) console.log(`  ${agent} buy stopped: ${JSON.stringify(replies).slice(0, 400)}`);
  return { bought, stopped: replies };
}

/** Hand each raider its pieces, by id, and record what arrived. */
export async function deliver(armorer, lines) {
  const out = [];
  for (const l of lines) {
    if (l.agent === armorer) { out.push({ ...l, ok: true, self: true }); continue; }
    const piece = (await inv(armorer)).find(i => OUTFIT[l.kind].match.test(String(i.name ?? '').trim()));
    if (!piece) { out.push({ ...l, ok: false, why: 'not in the pack' }); continue; }
    // A FULL RECEIVER MAKES ROOM AND IS ASKED AGAIN — m59-inventory handOver.
    const h = await handOver(armorer, l.agent, piece.id);
    const r = { supplied: h.ok, reason: h.why };
    out.push({ ...l, ok: !!r?.supplied, why: r?.supplied ? null : r?.reason });
    if (r?.supplied) {
      const got = OUTFIT_RUN.delivered.get(l.agent) ?? [];
      got.push(l.kind); OUTFIT_RUN.delivered.set(l.agent, got);
    }
  }
  return out;
}

/** Put on a shield and chain if carried. Read back. */
export async function wearOutfit(agent) {
  const items = await inv(agent);
  const did = [];
  for (const kind of ['chain', 'shield']) {
    const piece = items.find(i => OUTFIT[kind].match.test(String(i.name ?? '').trim()));
    if (!piece) continue;
    await call('rest', { agent, stand: true }, 30_000).catch(() => {});
    await call('act', { agent, verb: 'use', target: piece.id }, 60_000).catch(() => {});
    did.push(kind);
    await sleep(1200);
  }
  const eq = (await call('status', { agent, brief: false }, 40_000).catch(() => null))?.equipment ?? [];
  return { wore: did, equipment: eq };
}

/**
 * DEDICATE A WEAPON THAT ARRIVED LATE — a newly bought hammer, or an armorer's own, which left
 * with it. The owner hands it to a dedicator with the mana, the dedicator casts, hands it back,
 * the owner wields it. Serialised: one dedicator trade at a time.
 */
export async function lateDedicate(owner, dedicators, { lab = false, dm = null, donors = [] } = {}) {
  return serially(async () => {
    const weapon = (await inv(owner)).find(i => /^(hammer|mace)$/i.test(String(i.name ?? '').trim()));
    if (!weapon) return { ok: false, why: 'no blunt weapon to dedicate' };
    // A DEDICATOR IN THE OWNER'S ROOM. A hand-over is one room; on the 2026-09-25 rehearsal four
    // late dedications all chose the same dedicator, who was not in the stage room, and every one
    // failed "not in the room". Same room first; the one with the mana for it before the rest.
    const roomOf = async a => { const s = await call('status', { agent: a, brief: true }, 30_000).catch(() => null);
      return { a, room: Number(s?.where?.num ?? s?.room_num ?? NaN), mana: Number(s?.mana?.value ?? 0) }; };
    const me = await roomOf(owner);
    const here = (await Promise.all(dedicators.filter(x => x !== owner).map(roomOf))).filter(x => x.room === me.room);
    // ONE WHO CAN PAY. Enchant weapon costs 3 elderberry and an orc tooth as well as the mana, and
    // by the time the armorers are back the dedicators have spent theirs: on the 2026-09-25
    // rehearsal three late dedications went to dedicators with no elderberry left ("no mana and no
    // reagents moved") while another in the same room still carried 13.
    const pays = async a => { const it = await inv(a);
      return Object.entries(DEDICATE.reagents).every(([k, n]) => countFamily(it, k) >= n); };
    for (const x of here) x.pays = await pays(x.a);
    let d = (here.find(x => x.pays && x.mana >= 17) ?? here.find(x => x.pays) ?? here.find(x => x.mana >= 17) ?? here[0])?.a ?? null;
    if (!d) return { ok: false, why: `no dedicator in room ${me.room} with the owner` };
    // Nobody here can pay: top the chosen one up from whoever in the room can spare it (the owner
    // first), stack by stack, by id — a hand-over is one room, which this already is.
    if (!here.find(x => x.a === d)?.pays) {
      for (const [k, n] of Object.entries(DEDICATE.reagents)) {
        let need = n - countFamily(await inv(d), k);
        for (const from of [owner, ...donors.filter(x => x !== owner && x !== d)]) {
          if (need <= 0) break;
          if ((await roomOf(from)).room !== me.room) continue;
          const stack = (await inv(from)).filter(i => i.id != null && isReagent(i.name, k)).sort((a, b) => (b.amount || 1) - (a.amount || 1))[0];
          if (!stack) continue;
          const give = Math.min(need, Number(stack.amount) || 1);
          const r = await call('supply', { from, to: d, what: [{ id: stack.id, amount: give }], who_travels: 'neither' }, 120_000).catch(() => null);
          if (r?.supplied) need -= give;
        }
      }
    }
    await call('act', { agent: owner, verb: 'unuse', target: weapon.id }, 60_000).catch(() => {});
    const g = await call('supply', { from: owner, to: d, what: [weapon.id], who_travels: 'neither' }, 120_000).catch(e => ({ supplied: false, reason: e.message }));
    if (!g?.supplied) return { ok: false, why: `hand-over failed: ${g?.reason ?? '?'}` };
    // Wait for mana on prod; the lab may refill. Bounded, and asked again before EVERY attempt,
    // because a fizzle spends the 17 (2026-09-25: every retry read "costs 17, you have 4/7").
    const until = Date.now() + 10 * 60_000;
    const waitMana = async () => {
      while (Date.now() < until) {
        const m = Number((await call('status', { agent: d, brief: true }, 30_000).catch(() => null))?.mana?.value ?? 0);
        if (m >= 17) break;
        if (lab && dm) { const who = (await call('status', { agent: d, brief: true }, 30_000).catch(() => null))?.character; if (who) await dm.heal([who]); continue; }
        await call('rest', { agent: d }, 30_000).catch(() => {});
        await sleep(10_000);
      }
      await call('rest', { agent: d, stand: true }, 30_000).catch(() => {});
    };
    const w2 = (await inv(d)).filter(i => String(i.name).toLowerCase() === String(weapon.name).toLowerCase());
    let r = null, got = null;
    for (const cand of w2) {
      for (let i = 0; i < 3 && Date.now() < until; i++) {
        await waitMana();
        r = await castVerified(d, 'enchant weapon', { target: cand.id, cost: 17 });
        if (r.landed || r.in_effect || !r.retryable) break;
      }
      if (r?.landed || r?.in_effect) { got = cand; break; }
    }
    // THE WEAPON GOES BACK WHETHER OR NOT IT WAS DEDICATED. Returning early on a failed cast left
    // the owner's only weapon in the dedicator's pack, and the owner went into the throne room bare.
    const give = got ?? w2[0];
    const back = give ? await handOver(d, owner, give.id, { makeRoomMin: 200 }).then(h => ({ supplied: h.ok, reason: h.why })) : null;
    const mine = (await inv(owner)).find(i => String(i.name).toLowerCase() === String(weapon.name).toLowerCase());
    if (mine) await call('act', { agent: owner, verb: 'use', target: mine.id }, 60_000).catch(() => {});
    if (got) return { ok: !!back?.supplied, by: d, outcome: r.landed ? 'dedicated' : 'already' };
    return { ok: false, returned: !!back?.supplied, why: `dedication failed: ${String(r?.why ?? '?').slice(0, 80)}` };
  });
}

/**
 * ONE ARMORER'S WHOLE ERRAND, up to `trips` times: ride (or walk) to Barloque, clear the pack,
 * buy its share, meet its partner at the rally room, cross Ukgoth together, deliver.
 */
export async function armorerErrand({ agent, partner, holder, lines, p, crew = 2, log = console.log }) {
  const trips = [];
  let left = [...lines];
  for (let trip = 1; trip <= Number(p.trips) && left.length; trip++) {
    const t = { trip, want: left.length };
    // To Barloque: the cup if we can, the road if we cannot.
    const ride = holder ? await rideCup(() => chaliceRide(agent, holder, { hall: Number(p.hall) })) : { ok: false, why: 'no cup holder' };
    t.ride = ride.ok ? 'chalice' : `walked (${ride.why})`;
    // EMPTY THE PACK IN THE HALL BEFORE SHOPPING. The ride lands in 714, beside the chests, and a
    // smith will not buy reagents or food — so what an armorer carries at the counter is what it
    // brought. On the 2026-09-25 rehearsal every armorer's buying stopped on "limited_by: bulk"
    // after two or three pieces. Everything but the essentials goes in a chest first.
    // A WALKER STASHES TOO: the hall is in the smith's town, so a rider who could not ride goes
    // there first. On the 2026-09-25 rehearsal a walking armorer skipped the stash, reached the
    // counter full and bought one piece of eight.
    if (!ride.ok && Number(p.hall)) {
      const at = await hopTo(agent, Number(p.hall), { floor: 0.5 });
      if (at.ok) ride.inHall = true;
    }
    if (ride.ok || ride.inHall) {
      const r = await hallStash(agent, HALL_STASH_KEEP);
      t.stashed = r?.stashed ?? 0;
      if (t.stashed) log(`  ${agent} armorer trip ${trip}: stashed ${t.stashed} in the hall before shopping`);
    }
    log(`  ${agent} armorer trip ${trip}: ${t.ride}`);
    const at = await hopTo(agent, Number(p.shop_room), { floor: 0.5 });
    if (!at.ok) { t.failed = 'could not reach the smith'; trips.push(t); break; }
    t.sold = await clearPack(agent, p.smith);
    const got = await buyShare(agent, p.smith, left);
    t.bought = got.bought; t.clamped = got.clamped;
    // Only what is actually in the pack is deliverable; the rest waits for the next trip.
    const have = { ...got.bought };
    const now = [], later = [];
    for (const l of left) (have[l.kind] > 0 ? (have[l.kind]--, now) : later).push(l);
    // Home, together, through Ukgoth.
    await hopTo(agent, Number(p.rally), { floor: 1 });
    reexpect(`armorers-rally-${trip}`, crew);
    await barrier(`armorers-rally-${trip}`, agent, { ms: 10 * 60_000 });
    const home = await hopTo(agent, Number(p.stage), { floor: 0.7 });
    if (!home.ok) { t.failed = home.dead ? 'died on the road home' : 'could not get home'; trips.push(t); break; }
    t.delivered = await deliver(agent, now);
    log(`  ${agent} armorer trip ${trip}: delivered ${t.delivered.filter(d => d.ok).length}/${now.length}` +
        (later.length ? `, ${later.length} still owed` : '') +
        // WHY each one failed — the summary alone left a 0/2 trip unexplained.
        (t.delivered.some(d => !d.ok) ? ` — not delivered: ${t.delivered.filter(d => !d.ok).map(d => `${d.kind}->${d.agent} (${String(d.why ?? '?').slice(0, 60)})`).join('; ')}` : ''));
    trips.push(t);
    left = later;
  }
  return { trips, owed: left };
}

// ---------------------------------------------------------------------------------- the hall draw

/** What the armorers take out of the hall's chests before anything else, if nobody says otherwise. */
// Sized from `m59-ghostraid.mjs chests` against prod on 2026-09-25: short 21 teeth, 47 elderberry,
// 43 herbs and 52 mushrooms, and 15 chain and 19 shields wanted. Money is NOT drawn by default —
// the fleet's own purses covered the whole bill — so the hall's 75,000 stays where it is.
export const HALL_WANTS = Object.freeze([
  // Generous on purpose: the reagent step hands dedicators a per-head allowance (weapons /
  // dedicators) and ran out at 40 on the 2026-09-25 rehearsal, leaving four dedicators with no
  // tooth for their own hammer. The chests hold ~160 and a tooth weighs 3.
  { item: 'orc tooth', amount: 100 },
  { item: 'elderberry', amount: 150 },
  { item: 'herb', amount: 120 },
  { item: 'mushroom', amount: 60 },
  { item: 'chain armor', amount: 4 },
  { item: "knight's shield", amount: 6 },
  { item: 'small round shield', amount: 2 },
  { item: 'gold round shield', amount: 2 },
  { item: 'herald shield', amount: 1 },
]);

/**
 * SPLIT THE HALL'S WANTS ACROSS THE CREW BY WEIGHT, heaviest want first onto the lightest-loaded
 * rider, so no one pack takes all the chain. Shillings weigh nothing and go to the first rider,
 * whom the money pool then treats like any other purse. Pure; deterministic in crew order.
 *
 *   wants: [{item, amount}], weigh: name -> {weight} | null  ->  { agent: [{item, amount}] }
 */
export function hallSplit(crew = [], wants = [], weigh = () => null, room = null) {
  // BY ROOM, AND IN UNITS. The first version balanced WEIGHT between riders and never asked how
  // much any of them could hold: on the 2026-09-25 rehearsal one rider was handed every reagent
  // plus two gold shields — over 1,500 bulk against 0 free — drew 22 of 150 elderberry and then
  // bought none, the apothecary's stack having nowhere to go. A unit costs max(weight, bulk), the
  // tighter of the pack's two ceilings; each want is dealt out a stack-slice at a time to the rider
  // with the most room LEFT, so reagents split across riders instead of piling on one. `room` is
  // {agent: free room} from the server (min of weight and bulk); without it the riders are
  // assumed equal and the draw is balanced. What fits nowhere still goes to the roomiest rider, so
  // it surfaces as SHORT on the draw rather than vanishing from the plan.
  const out = Object.fromEntries(crew.map(a => [a, []]));
  if (!crew.length) return out;
  const unit = x => { const w = weigh(x); return Math.max(Number(w?.weight) || 0, Number(w?.bulk) || 0); };
  const total = wants.reduce((n, x) => n + unit(x.item) * (Number(x.amount) || 0), 0);
  const even = Math.ceil(total / crew.length * 1.1);
  const left = Object.fromEntries(crew.map(a => [a, room && Number.isFinite(Number(room[a])) ? Number(room[a]) : even]));
  const give = (a, item, n) => { const e = out[a].find(x => x.item === item); if (e) e.amount += n; else out[a].push({ item, amount: n }); };
  const sorted = [...wants].sort((x, y) => unit(y.item) * y.amount - unit(x.item) * x.amount || String(x.item).localeCompare(String(y.item)));
  for (const want of sorted) {
    const c = unit(want.item);
    let n = Number(want.amount) || 0;
    if (c === 0) { give(crew[0], want.item, n); continue; }
    while (n > 0) {
      const to = [...crew].sort((x, y) => left[y] - left[x] || crew.indexOf(x) - crew.indexOf(y))[0];
      const fit = Math.min(n, Math.floor(left[to] / c));
      if (fit <= 0) { give(to, want.item, n); left[to] -= n * c; break; }
      give(to, want.item, fit); left[to] -= fit * c; n -= fit;
    }
  }
  return out;
}

/**
 * ONE RIDER'S HALL DRAW: the cup to 714, its share out of the chests, home to the stage room
 * with the rest of the crew. A ride that does not land in the hall (no cup, no guild — the shadow
 * clone has neither) draws nothing and says so; a rider the Rescue dropped somewhere else still
 * walks home, because the raid is waiting for it.
 */
export async function hallDraw({ agent, crew = [], holder, share = [], p, log = console.log }) {
  const out = { share };
  const ride = holder ? await rideCup(() => chaliceRide(agent, holder, { hall: Number(p.hall) }))
                      : { ok: false, why: 'no cup holder' };
  out.ride = ride.ok ? 'chalice' : `no ride (${ride.why})`;
  if (ride.ok && share.length) {
    // ONE AT A TIME THROUGH THE HALL. The chest door opens for five seconds on a spoken word
    // (guildh14.kod DOOR_DELAY); riders arriving together contend for it, and on the 2026-09-25
    // rehearsal one was refused 3 of 3 presses as "unable to go anywhere".
    const draw = () => inHall(() => call('hall_withdraw', { agent, wants: share, stash: [...HALL_STASH_KEEP, ...share.map(w => w.item)] }, 620_000)
      .catch(e => ({ ok: false, why: e.message })));
    let r = await draw();
    // A DOOR REFUSAL IS WORTH ONE MORE TRY. On the 2026-09-25 rehearsal a rider was refused
    // "guild door 53 trigger not reached" — the passage's walk to the trigger square did not
    // land, with the previous armorer still in the passage. The door itself is fine.
    // Door 3 (the chest room's spoken door) was refused twice in a row on the next run, right after
    // the previous rider came through it: saying the word while it is open does nothing, and it
    // shuts five seconds later. So up to three more tries, twenty seconds apart.
    for (let i = 0; i < 3 && !r?.ok && /door|trigger|could not be crossed|unable to go/i.test(String(r?.why ?? '')); i++) {
      await sleep(20_000);
      r = await draw();
    }
    out.took = r?.took ?? {}; out.short = r?.short ?? {}; out.ok = !!r?.ok; out.stashed = r?.stashed ?? 0;
    if (!r?.ok) out.why = r?.why ?? r?.error ?? 'no answer';
  }
  log(`  ${agent} hall draw: ${out.ride}` + (out.stashed ? `; stashed ${out.stashed}` : '') + (out.took ? `; took ${JSON.stringify(out.took)}` : '') +
      (out.short && Object.keys(out.short).length ? `; SHORT ${JSON.stringify(out.short)}` : '') +
      (out.why ? `; REFUSED ${out.why}` : ''));
  // WHAT THE CHESTS COULD NOT GIVE, BUY — WE ARE IN BARLOQUE ALREADY. On 2026-09-25 prod's chests
  // had fallen to 15 elderberry (the 238-stack drawn down by the fleet's own stockpile runs),
  // against a raid that needs ~95. Joguer, the Barloque apothecary (room 104), sells reagents a
  // short walk from the hall; the shortfall is bought there on the way home, before any hammer is
  // dedicated. Reagents only: gear is the smith's job, on the armorers' own trips.
  const buyable = Object.entries(out.short ?? {}).filter(([k, n]) => n > 0 && /elderberr|herb|orc tooth|mushroom/i.test(k));
  if (ride.ok && buyable.length && Number(p.reagent_shop)) {
    const at = await hopTo(agent, Number(p.reagent_shop), { floor: 0.5 });
    if (at.ok) {
      // ONLY WHAT FITS. A purchase the pack cannot take is refused whole and silently — the
      // 2026-09-25 rider asked for 128 elderberry at -41 bulk and got nothing, and said nothing.
      const r = await roomFor(agent);
      let free = r ? Math.min(r.weight ?? 0, r.bulk ?? 0) : Infinity;
      const lines = [];
      for (const [item, n] of buyable) {
        const u = weighItem(item); const c = Math.max(Number(u?.weight) || 0, Number(u?.bulk) || 0) || 1;
        const ask = Math.min(n, Math.max(0, Math.floor(free / c)));
        if (ask < n) (out.unbought ??= {})[item] = n - ask;
        if (ask > 0) { lines.push({ item, amount: ask }); free -= ask * c; }
      }
      out.bought = lines.length ? await buyByName(agent, p.apothecary, lines) : {};
      log(`  ${agent} bought at the apothecary: ${JSON.stringify(out.bought)}` +
          (out.unbought ? `; NO ROOM for ${JSON.stringify(out.unbought)}` : ''));
    }
  }
  // GEAR THE CHESTS LACKED, FROM THE SMITH — only when the caller asks (`buy_gear`). The ghost raid
  // leaves gear to its armorers' own smith trips; a general provisioning run (provision.mjs) buys it
  // here, on the same trip. One piece per exchange, read back (buyShare's rule).
  const gearShort = Object.entries(out.short ?? {}).filter(([k, n]) => n > 0 && !/elderberr|herb|orc tooth|mushroom|emerald|sapphire|ruby|shilling/i.test(k));
  if (ride.ok && gearShort.length && (p.buy_gear === true || p.buy_gear === 'true') && Number(p.shop_room)) {
    const at = await hopTo(agent, Number(p.shop_room), { floor: 0.5 });
    if (at.ok) {
      out.bought_gear = await buyByName(agent, p.smith, gearShort.map(([item, amount]) => ({ item, amount })));
      log(`  ${agent} bought at the smith: ${JSON.stringify(out.bought_gear)}`);
    }
  }
  if (Number((await observe(agent)).room) !== Number(p.stage)) {
    if (ride.ok) {
      await hopTo(agent, Number(p.rally), { floor: 1 });
      reexpect('hall-rally', crew.length);
      await barrier('hall-rally', agent, { ms: 10 * 60_000 });
    }
    const home = await hopTo(agent, Number(p.stage), { floor: 0.7 });
    out.home = home.ok ? 'home' : home.dead ? 'died on the road home' : 'could not get home';
  }
  return out;
}
