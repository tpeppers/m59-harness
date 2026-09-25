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
import { barrier, reexpect } from '../m59-ghostraid-lib.mjs';

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
    chain: !names.some(n => /b(chain|plate|scale)\s+(armou?r|mail)b/i.test(n)),
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

let CHAIN = Promise.resolve();
const serially = fn => { const p = CHAIN.then(fn, fn); CHAIN = p.catch(() => {}); return p; };

const purseOf = items => items.filter(i => /^shilling/i.test(String(i.name ?? '')))
  .reduce((n, i) => n + (Number(i.amount) || 1), 0);
const inv = async agent => (await call('inventory', { agent }, 40_000).catch(() => null))?.items ?? [];

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

async function hopTo(agent, to, { floor = 0 } = {}) {
  for (let i = 0; i < 3; i++) {
    await call('travel', { agent, to, background: true, run_errands: false, health_floor: floor }, 60_000).catch(() => {});
    const until = Date.now() + 15 * 60_000;
    while (Date.now() < until) {
      const o = await observe(agent);
      if (o.dead) return { ok: false, dead: true };
      if (Number(o.room) === Number(to)) return { ok: true };
      await sleep(3000);
    }
  }
  return { ok: Number((await observe(agent)).room) === Number(to) };
}

/**
 * THE CHALICE RIDE, one armorer. The holder hands the cup over, the armorer drinks it and drops
 * it on the floor of room 2 at once — Rescue takes 15-25 s to land — and the holder picks it back
 * up, which refills it (room 2 is forest). Returns whether the armorer reached the hall.
 */
export async function chaliceRide(armorer, holder, { hall = 714 } = {}) {
  const cup = (await inv(holder)).find(i => /chalice/i.test(String(i.name ?? '')));
  if (!cup) return { ok: false, why: `${holder} is not carrying the chalice` };
  const given = await serially(() => call('supply', { from: holder, to: armorer, what: [cup.id], who_travels: 'neither' }, 120_000)
    .catch(e => ({ supplied: false, reason: e.message })));
  if (!given?.supplied) return { ok: false, why: `could not hand the cup over: ${given?.reason ?? '?'}` };
  const mine = (await inv(armorer)).find(i => /chalice/i.test(String(i.name ?? '')));
  await call('rest', { agent: armorer, stand: true }, 30_000).catch(() => {});
  await call('act', { agent: armorer, verb: 'eat', target: mine.id }, 60_000).catch(() => {});
  await sleep(1500);
  await call('act', { agent: armorer, verb: 'drop', target: mine.id }, 60_000).catch(() => {});
  // The holder picks it up off the floor — by what is on the floor now, not by a stored id.
  await sleep(1500);
  const look = await call('look', { agent: holder }, 40_000).catch(() => null);
  const onFloor = (look?.objects ?? []).find(o => /chalice/i.test(String(o.name ?? '')));
  if (onFloor) await call('act', { agent: holder, verb: 'get', target: onFloor.id }, 60_000).catch(() => {});
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const o = await observe(armorer);
    if (Number(o.room) === hall) return { ok: true, cupBack: !!onFloor };
    await sleep(2000);
  }
  return { ok: false, why: 'the ride did not land in the hall (not a guild member? teleport blocked after PVP?)', cupBack: !!onFloor };
}

/** Sell what the smith buys, keeping money, reagents, food, the outfit and the cup. */
export async function clearPack(agent, merchant) {
  const keep = ['shilling', 'elderberry', 'herb', 'mushroom', 'orc tooth', 'emerald', 'sapphire', 'ruby',
                'hammer', 'mace', 'chain', 'shield', 'chalice', 'bread', 'pork', 'mutton', 'apple', 'cheese',
                'spider eye', 'edible'];
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
  const r = await call('shop', { agent, seller: merchant, buy_ids: buy }, 180_000).catch(e => ({ error: e.message }));
  const after = await inv(agent);
  const bought = Object.fromEntries(Object.keys(want).map(k =>
    [k, after.filter(i => OUTFIT[k].match.test(String(i.name ?? '').trim())).reduce((n, i) => n + (i.amount || 1), 0)]));
  return { bought, clamped: r?.clamped ?? null, error: r?.error ?? null };
}

/** Hand each raider its pieces, by id, and record what arrived. */
export async function deliver(armorer, lines) {
  const out = [];
  for (const l of lines) {
    if (l.agent === armorer) { out.push({ ...l, ok: true, self: true }); continue; }
    const piece = (await inv(armorer)).find(i => OUTFIT[l.kind].match.test(String(i.name ?? '').trim()));
    if (!piece) { out.push({ ...l, ok: false, why: 'not in the pack' }); continue; }
    const r = await serially(() => call('supply', { from: armorer, to: l.agent, what: [piece.id], who_travels: 'neither' }, 120_000)
      .catch(e => ({ supplied: false, reason: e.message })));
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
export async function lateDedicate(owner, dedicators, { lab = false, dm = null } = {}) {
  return serially(async () => {
    const weapon = (await inv(owner)).find(i => /^(hammer|mace)$/i.test(String(i.name ?? '').trim()));
    if (!weapon) return { ok: false, why: 'no blunt weapon to dedicate' };
    let d = null;
    for (const a of dedicators) {
      const m = Number((await call('status', { agent: a, brief: true }, 30_000).catch(() => null))?.mana?.value ?? 0);
      if (m >= 17) { d = a; break; }
    }
    d ??= dedicators[0];
    if (!d) return { ok: false, why: 'no dedicator' };
    await call('act', { agent: owner, verb: 'unuse', target: weapon.id }, 60_000).catch(() => {});
    const g = await call('supply', { from: owner, to: d, what: [weapon.id], who_travels: 'neither' }, 120_000).catch(e => ({ supplied: false, reason: e.message }));
    if (!g?.supplied) return { ok: false, why: `hand-over failed: ${g?.reason ?? '?'}` };
    // Wait for mana on prod; the lab may refill. Bounded.
    const until = Date.now() + 10 * 60_000;
    while (Date.now() < until) {
      const m = Number((await call('status', { agent: d, brief: true }, 30_000).catch(() => null))?.mana?.value ?? 0);
      if (m >= 17) break;
      if (lab && dm) { const who = (await call('status', { agent: d, brief: true }, 30_000).catch(() => null))?.character; if (who) await dm.heal([who]); continue; }
      await call('rest', { agent: d }, 30_000).catch(() => {});
      await sleep(10_000);
    }
    await call('rest', { agent: d, stand: true }, 30_000).catch(() => {});
    const w2 = (await inv(d)).filter(i => String(i.name).toLowerCase() === String(weapon.name).toLowerCase());
    let r = null;
    for (const cand of w2) {
      r = await castVerified(d, 'enchant weapon', { target: cand.id, cost: 17 });
      if (r.landed || r.in_effect) {
        const back = await call('supply', { from: d, to: owner, what: [cand.id], who_travels: 'neither' }, 120_000).catch(e => ({ supplied: false, reason: e.message }));
        const mine = (await inv(owner)).find(i => String(i.name).toLowerCase() === String(weapon.name).toLowerCase());
        if (mine) await call('act', { agent: owner, verb: 'use', target: mine.id }, 60_000).catch(() => {});
        return { ok: !!back?.supplied, by: d, outcome: r.landed ? 'dedicated' : 'already' };
      }
    }
    return { ok: false, why: `dedication failed: ${String(r?.why ?? '?').slice(0, 80)}` };
  });
}

/**
 * ONE ARMORER'S WHOLE ERRAND, up to `trips` times: ride (or walk) to Barloque, clear the pack,
 * buy its share, meet its partner at the rally room, cross Ukgoth together, deliver.
 */
export async function armorerErrand({ agent, partner, holder, lines, p, log = console.log }) {
  const trips = [];
  let left = [...lines];
  for (let trip = 1; trip <= Number(p.trips) && left.length; trip++) {
    const t = { trip, want: left.length };
    // To Barloque: the cup if we can, the road if we cannot.
    const ride = holder ? await chaliceRide(agent, holder, { hall: Number(p.hall) }) : { ok: false, why: 'no cup holder' };
    t.ride = ride.ok ? 'chalice' : `walked (${ride.why})`;
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
    reexpect(`armorers-rally-${trip}`, 2);
    await barrier(`armorers-rally-${trip}`, agent, { ms: 10 * 60_000 });
    const home = await hopTo(agent, Number(p.stage), { floor: 0.7 });
    if (!home.ok) { t.failed = home.dead ? 'died on the road home' : 'could not get home'; trips.push(t); break; }
    t.delivered = await deliver(agent, now);
    log(`  ${agent} armorer trip ${trip}: delivered ${t.delivered.filter(d => d.ok).length}/${now.length}` +
        (later.length ? `, ${later.length} still owed` : ''));
    trips.push(t);
    left = later;
  }
  return { trips, owed: left };
}
