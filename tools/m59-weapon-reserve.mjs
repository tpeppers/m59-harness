// THE WEAPON RESERVE: THE ROOM A REPLACEMENT WEAPON NEEDS IS KEPT FREE, AND AN UNARMED BODY SHORT OF IT MAKES IT.
//
// Prod, 2026-11-18. Gonzo (t18) stood unarmed in the Ancient Place for 19,045 seconds -- 5.3 hours -- reciting
// `unarmed -- 60 bulk free, needs 70 to hold one` 17,710 times with `stuck.lever: null`. Fozzie (t12) 11,799 s at 51 free,
// Waldorf (t4) 4,608 s at 61, Zoot (t17) every ten minutes: `made space -- unarmed: room for a conjured weapon
// {freed: {bulk: 0}, short_by: {bulk: 40}, dropped: []}`. Their packs were 400 to 820 orc teeth, 190 purple mushrooms,
// 70 red mushrooms: the farm's PRODUCT, which the keep list, the strategy's protect list, the farm town's keep and the
// fleet-wants board all protect, so the sale plan was empty and make_space, which drops only sale-plan rows, dropped
// nothing. Each was freed by hand by dropping 12 to 15 orc teeth and re-armed within a minute.
//
// FOUR DEFECTS, ONE CAUSE: nothing kept room for the next weapon, and nothing could make it.
//   1. LOOTING HAD NO RESERVE. A farmer filled its pack to the last unit of bulk. Weapons break constantly here; the
//      broken one is swept (50 to 90 bulk back) and the replacement needs up to 90, so a pack filled to the brim around
//      a short sword is 20 bulk short of the 70 the conjure preflight asks for, for ever.
//   2. THE UNARMED REMEDY READ ONLY THE SALE PLAN, which is empty exactly when the pack is all product.
//   3. THE STALL HAD NO LEVER, and its refusal code (UNARMED_NO_DONOR) was the one the supervisor skips as "waiting for
//      casting mana".
//   4. AN UNARMED KEEPER PICKED UP WEAPONS IT MAY NOT WIELD, filling the room it needed.
//
// ONE DEFINITION OF THE RESERVE (weaponReserveSize): the largest thing `create weapon` can hand over -- an axe, 90
// weight and 90 bulk (creaweap.kod:71-105 rolls mace 60/60, short sword 50/50, hammer 80/75, axe 90/90, long sword
// 80/60, scimitar 85/70, mystic sword 60/60; weight/bulk from substrate/m59-items.json). ReqNewHold refuses on EITHER
// ceiling (holder.kod:259 -> :281 CanHoldWeightAndBulk) and creaweap.kod:116-129 then deletes the weapon after the mana
// is spent, so the reserve is both dimensions. A bought, looted or handed-over weapon of any ordinary kind fits in it.
//
// WHO ASKS IT:
//   Session.lootFloor (m59-game.mjs)        reservePickup: a sweep leaves an item that would take free space under the
//                                           reserve, with the reason on the refusal (and so on the kill_drop row).
//                                           unwieldablePickup: an unarmed body leaves a weapon it may not wield.
//   planPickup (m59-overfarm.mjs)           `reserve`: an overfarm lap is full at the reserve line, so it trades up
//                                           there instead of stopping.
//   Autopilot.unarmedMakeSpace (pass-combat) the ordered remedy: the sale plan, then beyondThePlan's two tiers.
//   Autopilot.checkIfShouldSell (market)    reserveReached: a pack stopped at the reserve line IS full, so a
//                                           sell_at_load or the 97% rule above the line still fires.
//
// THE RESERVE IS IN FORCE while a body that fights carries no usable spare weapon (Autopilot.weaponReserveNow decides;
// reserveState below is the pure half). With a usable spare aboard it is waived and the pack fills to the brim as it
// always did: the spare IS the replacement. A weapon on the floor that this body may wield is never refused for the
// reserve -- picking it up is what the reserve is for.
//
// PURE, except usableWeapons, which reads a client's pack through m59-skills' own ranking so "usable" here can never
// disagree with what equipBest would actually put in the hand.
import { weighItem } from './m59-items.mjs';
import * as skills from './m59-skills.mjs';

// What `create weapon` can make (creaweap.kod:71-105). The keeper's CONJURABLE_WEAPONS is the same list; the suite
// pins the two against each other, because this file cannot import the keeper (the session imports this file).
export const REPLACEMENT_WEAPONS = Object.freeze(['mace', 'short sword', 'hammer', 'axe', 'long sword', 'scimitar', 'mystic sword']);
// The axe, for a checkout whose weight table is missing or cannot weigh every one of them: a table with a hole in it
// does not get to shrink the reserve.
export const WEAPON_RESERVE_FALLBACK = Object.freeze({ bulk: 90, weight: 90 });
// The unarmed remedy clears this much past the reserve when it drops what was going to be sold anyway (the make-space
// margin since 2026-11-05). Protected stock is dropped to the reserve itself and not a unit further.
export const WEAPON_RESERVE_MARGIN = 10;
// "Stopped at the reserve line": within this much of it, or a pickup left for it this recently with the pack no emptier.
export const RESERVE_REACHED_SLACK = 10;
export const RESERVE_LEFT_FRESH_MS = 10 * 60_000;

let sized = null;
/** { bulk, weight } a replacement weapon needs: the largest in each dimension of what create weapon can make. */
export function weaponReserveSize(weigh = null) {
  if (!weigh && sized) return sized;
  let bulk = 0, weight = 0, known = 0;
  for (const name of REPLACEMENT_WEAPONS) {
    let w = null;
    try { w = (weigh ?? weighItem)(name); } catch { w = null; }
    if (!w || !(Number(w.bulk) > 0) || !(Number(w.weight) > 0)) continue;
    known++;
    bulk = Math.max(bulk, Number(w.bulk));
    weight = Math.max(weight, Number(w.weight));
  }
  const out = Object.freeze(known === REPLACEMENT_WEAPONS.length ? { bulk, weight } : { ...WEAPON_RESERVE_FALLBACK });
  if (!weigh) sized = out;
  return out;
}

/** The policy value: true (the default) or false. Anything else is refused with the reason, never coerced. */
export function normWeaponReserve(v) {
  if (v === undefined || v === null || v === true) return true;
  if (v === false) return false;
  throw new Error('weapon_reserve is true (the default: keep a replacement weapon\'s room free, and let an unarmed ' +
    `body short of it make it) or false (loot to the brim, drop only sale-plan rows); got ${JSON.stringify(v)}`);
}

/** How far `free` is under `need` in each dimension (0 when met); null when either is unknown. */
export function shortOf(free, need) {
  if (!free || !need) return null;
  return { bulk: Math.max(0, (Number(need.bulk) || 0) - (Number(free.bulk) || 0)),
           weight: Math.max(0, (Number(need.weight) || 0) - (Number(free.weight) || 0)) };
}
export const isShort = s => !!s && (s.bulk > 0 || s.weight > 0);

/**
 * MAY THIS FLOOR ITEM BE PICKED UP WITHOUT EATING THE RESERVE? Pure.
 *   free         { bulk, weight } free now (an upper bound when the load is inexact), or null when unknown
 *   reserve      { bulk, weight }, or null when no reserve is in force
 *   cost         { bulk, weight } of the whole floor stack (a get takes the stack), or null when the item is unweighed
 *   replacement  the item is itself a weapon this body may wield
 * CERTAINTY IN ONE DIRECTION ONLY: an unweighed pack or item is taken exactly as before. The reserve refuses only
 * what it can show would breach it.
 */
export function reservePickup({ free = null, reserve = null, cost = null, replacement = false } = {}) {
  if (!reserve) return { take: true };
  if (replacement) return { take: true, replacement: true };
  if (!free || !cost) return { take: true, unknown: true };
  const after = { bulk: free.bulk - cost.bulk, weight: free.weight - cost.weight };
  if (after.bulk >= reserve.bulk && after.weight >= reserve.weight) return { take: true, after };
  const dim = after.bulk < reserve.bulk ? 'bulk' : 'weight';
  return { take: false, after,
    why: `WEAPON RESERVE — taking it would leave ${Math.max(0, after[dim])} ${dim} free, and the next weapon needs ` +
         `${reserve[dim]} (${reserve.bulk} bulk and ${reserve.weight} weight: no usable spare is carried, and a weapon ` +
         'that does not fit is deleted after the mana is spent). Left on the floor.' };
}

// HOW MANY USABLE SPARES A BODY KEEPS. The best two by its own ranking (weaponRanking: the order equipBest would reach
// for them). A third is not a replacement, it is 50 to 90 bulk of pack: Kermit, 2026-11-18, carried six usable spare
// weapons with the reserve reading "waived: a usable spare is carried". `drop_junk: false` had switched his field
// weapon cap off whole (fieldWeaponCap), pickup limit included, so nothing was counting.
export const WEAPON_SPARES_KEPT = 2;

/** The refusal for a weapon picked up past the spares a body keeps. */
export const spareLeftWhy = (name, kept = WEAPON_SPARES_KEPT) =>
  `SPARE WEAPONS — ${kept} usable spare weapons are already carried, and a further ${name} is not a replacement, only ` +
  'bulk the pack needs for loot. Nothing collects it (no loot list, loadout, guild want or hall names it). Left on the floor.';

/** The refusal for a weapon an unarmed body may not wield. `why` is unwieldableWhy's answer. */
export const unwieldableLeftWhy = (name, why) =>
  `UNWIELDABLE — unarmed, and ${name} is a weapon this character may not wield (${why}). Nothing collects it ` +
  '(no loot list, loadout or guild want names it), so it would only fill the room a usable weapon needs. Left on the floor.';

/**
 * WHY THIS BODY MAY NOT WIELD A WEAPON OF THIS NAME, or null when it may. The name-level half of weaponRanking: the
 * ban list, the owner's "only this weapon" (training_weapon_only, through skills.equipOnlyTest), junk and PvP-only
 * gear. Broken, cursed and unread are facts about one object and are asked of the object where it is known.
 */
export function unwieldableWhy(name, { banned = null, only = null, pvpOnly = false } = {}) {
  const n = String(name ?? '');
  if (!(skills.weaponScore(n) > 0)) return 'not a weapon';
  if (skills.isBannedWeapon(n, banned)) return `on its banned_weapons list: ${[].concat(banned).join(', ')}`;
  const onlyTest = skills.equipOnlyTest(only);
  if (onlyTest && !onlyTest(n)) return `only ${[].concat(only).join(' / ')} may be wielded here (training_weapon_only)`;
  if (pvpOnly) return 'PvP-only gear is never a farming weapon';
  return null;
}

/**
 * THE WEAPONS IN THE PACK THIS BODY WOULD ACTUALLY PUT IN ITS HAND, best first: skills.weaponRanking (not junk, cursed,
 * broken, banned, PvP-only, magic-graded or unread hall cargo) narrowed by the owner's "only this weapon", exactly as
 * equipBest narrows it. `only` and `trollQuarry` are what the session's equipOnly / equipTrollQuarry hooks answer.
 * Rows are { o, name, ... }.
 */
export function usableWeapons(c, { priority = null, banned = null, only = null, trollQuarry = false } = {}) {
  if (!c) return [];
  const ranked = skills.weaponRanking(c, { priority, banned, trollQuarry: trollQuarry === true });
  const onlyTest = skills.equipOnlyTest(only);
  return onlyTest ? ranked.filter(r => onlyTest(r.name)) : ranked;
}

/**
 * IS THE RESERVE IN FORCE? Pure: the keeper gathers the facts (Autopilot.weaponReserveNow).
 *   enabled     policy.weaponReserve !== false
 *   exempt      a reason this body holds no weapon by design (never_attack, a posted caster, bare-handed training,
 *               PvP gear on), or null
 *   equipment   true when the server's use list has been read; unknown is not unarmed
 *   armed       a weapon is in the hand
 *   carried     usable weapons in the pack that are NOT in the hand (names), best first
 *   surplus     the usable spares past the best WEAPON_SPARES_KEPT that nothing protects (names)
 * A body with nothing in its hand will wield one of `carried` next pass, so that one is not a spare.
 * A HOARD IS NOT A WAIVER: with surplus spares aboard the reserve stays in force, so the pack does not fill to the
 * brim around weapons that are themselves the problem. They are what the sale plan sells and the remedy sheds first.
 */
export function reserveState({ enabled = true, exempt = null, equipment = false, armed = false, carried = [], surplus = [], size = weaponReserveSize() } = {}) {
  const off = why => ({ in_force: false, reserve: null, unarmed: false, spares: null, why });
  if (!enabled) return off('weapon_reserve is off for this character');
  if (exempt) return off(exempt);
  if (!equipment) return off('equipment has not been read: an unread hand is not an empty one');
  const spares = Math.max(0, carried.length - (armed ? 0 : 1));
  if (surplus.length)
    return { in_force: true, reserve: { bulk: size.bulk, weight: size.weight }, unarmed: !armed, spares, surplus: surplus.length,
             why: `${surplus.length} surplus spare weapon(s) are carried (${surplus.join(', ')}) past the ${WEAPON_SPARES_KEPT} it keeps: a hoard is not ` +
                  `a replacement, so ${size.bulk} bulk and ${size.weight} weight stay free until they are sold or shed` };
  if (spares > 0)
    return { in_force: false, waived: true, reserve: null, unarmed: !armed, spares,
             why: `a usable spare is carried (${carried.slice(armed ? 0 : 1).join(', ')}): it is the replacement, so the pack fills to the brim` };
  return { in_force: true, reserve: { bulk: size.bulk, weight: size.weight }, unarmed: !armed, spares: 0,
           why: armed ? `armed with no usable spare: ${size.bulk} bulk and ${size.weight} weight stay free for the next weapon`
                      : `unarmed with ${carried.length ? 'one usable weapon to wield and no spare' : 'no usable weapon'}: ` +
                        `${size.bulk} bulk and ${size.weight} weight are what the next one needs` };
}

/**
 * HAS THE PACK STOPPED FILLING AT THE RESERVE LINE? Pure. True when free space is within `slack` of the reserve in
 * either dimension, or when a sweep left something for the reserve within `freshMs` and the pack has not been emptied
 * since (`left` = { at, free } as the session recorded it). A farm whose drops are all bigger than the slack is caught
 * by the second half.
 */
export function reserveReached({ free = null, reserve = null, left = null, now = Date.now(),
                                 slack = RESERVE_REACHED_SLACK, freshMs = RESERVE_LEFT_FRESH_MS } = {}) {
  if (!reserve || !free) return false;
  if (free.bulk < reserve.bulk + slack || free.weight < reserve.weight + slack) return true;
  if (!left || !(now - left.at < freshMs) || !left.free) return false;
  return free.bulk <= left.free.bulk + slack && free.weight <= left.free.weight + slack;
}

// ---------------------------------------------------------------- the unarmed remedy, beyond the sale plan
//
// ORDER (Autopilot.unarmedMakeSpace): (1) wield a usable carried weapon -- armSelf, before this is reached; (2) drop
// sale-plan rows (makeSpace, m59-make-space.mjs), spare weapons the plan would sell first; then, only with
// `weaponReserve` on and only while still short of the reserve:
//   (3) GEAR THE BODY MAY NOT USE AND NOTHING PROTECTS: a weapon on its ban list or outside its "only" weapon, a
//       broken weapon or broken armour, junk, a surplus spare past the two it keeps. Not a name its protect / vault /
//       guild lists or its loadout keep.
//   (4) THE MINIMUM NUMBER OF UNITS OF THE LEAST VALUABLE PROTECTED STACK. Stacks only (a number item), weighed and
//       valued (unknown is not cheap). PRODUCT first, cheapest first; food after it and never the last of a food.
//   (5) WORKING STOCK LAST, AND IT SAYS SO. Operator's standing rule: reagent priority is PvP > training > use > vault
//       > sell. The remedy's first prod drop (Lew, 2026-11-18) was 14 elderberries, his light/fog practice stock: the
//       cheapest stack by value, and the wrong one. So a stack a spell this character practises, buffs or heals with
//       consumes, its loadout floor and its create-food stock (`use`), its training reserve (`training`) and its PvP
//       reserve (`pvp`) are candidates only after every unit of product and food, in that order, cheapest first within
//       each. They may still be taken -- re-arming beats practising -- and the drop row carries `tier: 'working'` and
//       the class, so the journal and the ledger say practice stock was spent.
// NEVER, at any tier (`hard`): anything worn or wielded, money, a bow, arrows, the chalice, a quest item, or an item
// bound to somebody or something -- enchanted or dedicated, just delivered by trade, hall-bound magic weapons, a
// holder's cargo, the curse cycle's keeps, an operator's keep veto.

export const WORKING_CLASSES = Object.freeze(['use', 'training', 'pvp']);
const WORKING_LABEL = Object.freeze({ use: 'working stock', training: 'practice stock', pvp: 'PvP reserve stock' });

/**
 * Sort the pack into what the remedy may give up beyond the plan. Pure.
 *   rows  salePlanSummary rows (m59-make-space.mjs annotateRow): id, name, amount, role, equipped, unit, unit_value, droppable
 *   ctx   { hard(row) -> reason | null, unusable(row) -> reason | null, named(row) -> reason | null (a name-level
 *           keep, asked for gear), isFood(row) -> bool, stack(row) -> bool,
 *           floors(row) -> { use, training, pvp } units of the stack that are working stock by QUANTITY (a loadout
 *             minimum or create-food target; the training reserve; the PvP reserve), and
 *           reagentOf(row) -> { cls: 'use' | 'training', why } | null when the whole stack is working stock by NAME
 *             (a reagent of a spell this character practises, buffs or heals with) }
 * -> { gear, stock, food, working: { use, training, pvp }, kept }; every candidate row carries { give, tier, drop_why }.
 */
export function beyondThePlan(rows = [], ctx = {}) {
  const gear = [], stock = [], food = [], kept = [];
  const working = { use: [], training: [], pvp: [] };
  const keep = (row, why) => kept.push({ id: row.id, name: row.name, amount: row.amount,
    bulk: row.unit ? row.unit.bulk * row.amount : null, weight: row.unit ? row.unit.weight * row.amount : null, why });
  const ask = (fn, row) => { try { return fn ? fn(row) : null; } catch (e) { return `could not be judged (${e?.message ?? e})`; } };
  for (const row of rows) {
    if (row.droppable) continue;                                   // the sale plan's own; makeSpace has had its turn
    const hard = ask(ctx.hard, row);
    if (hard) { keep(row, hard); continue; }
    if (!row.unit) { keep(row, 'not in the weight table, so dropping it frees an unknown amount'); continue; }
    const useless = ask(ctx.unusable, row);
    if (useless) {
      const named = ask(ctx.named, row);
      if (named) { keep(row, `${useless}, but kept: ${named}`); continue; }
      gear.push({ ...row, give: row.amount, tier: 'gear', drop_why: useless });
      continue;
    }
    let isStack = false, isFood = false;
    try { isStack = ctx.stack ? ctx.stack(row) === true : row.amount > 1; } catch { isStack = false; }
    if (!isStack) { keep(row, row.drop_block ?? 'a single item, not stock'); continue; }
    if (row.unit_value == null) { keep(row, `${row.drop_block ?? 'kept'}; its value is unknown, and unknown is not cheap`); continue; }
    try { isFood = ctx.isFood ? ctx.isFood(row) === true : row.role === 'food'; } catch { isFood = true; }
    // HOW MANY UNITS ARE WHOSE, from the most protected up: the PvP reserve, then training, then use, then product.
    // A judgement that throws keeps the whole stack: unknown is not surplus.
    let fl = null, reagent = null, judged = true;
    try { fl = ctx.floors ? ctx.floors(row) : null; reagent = ctx.reagentOf ? ctx.reagentOf(row) : null; } catch { judged = false; }
    if (!judged) { keep(row, 'working stock that could not be counted: kept whole'); continue; }
    const n = v => Math.max(0, Math.floor(Number(v) || 0));
    const units = { pvp: Math.min(row.amount, n(fl?.pvp)) };
    units.training = Math.min(row.amount, n(fl?.pvp) + n(fl?.training)) - units.pvp;
    units.use = Math.min(row.amount, Math.max(n(fl?.use), n(fl?.pvp) + n(fl?.training))) - units.pvp - units.training;
    let product = row.amount - units.pvp - units.training - units.use;
    // BY NAME, THE WHOLE STACK IS AT LEAST THAT CLASS: a practice reagent's units under a loadout floor are practice
    // stock too, and are not spent as mere "use" ahead of somebody else's.
    if (reagent?.cls === 'training') { units.training += units.use + product; units.use = 0; product = 0; }
    else if (reagent?.cls === 'use') { units.use += product; product = 0; }
    // THE LAST OF A FOOD IS NEVER DROPPED: it comes off the most protected units there are.
    if (isFood) {
      if (units.pvp > 0) units.pvp--; else if (units.training > 0) units.training--; else if (units.use > 0) units.use--; else product--;
    }
    if (isFood && row.amount <= 1) { keep(row, 'the last of a food: never dropped'); continue; }
    if (product > 0)
      (isFood ? food : stock).push({ ...row, give: product, tier: isFood ? 'food' : 'stock',
        drop_why: `the least valuable protected stack (${row.drop_block ?? 'protected'}); ~${row.unit_value} each` });
    for (const cls of WORKING_CLASSES) {
      if (!(units[cls] > 0)) continue;
      const because = cls === reagent?.cls ? reagent.why
        : cls === 'pvp' ? 'the PvP reserve' : cls === 'training' ? 'the training reserve' : 'its loadout floor or create-food stock';
      working[cls].push({ ...row, give: units[cls], tier: 'working', stock_class: cls,
        drop_why: `${WORKING_LABEL[cls]} (${because}), taken only because nothing else was left to drop; ~${row.unit_value} each` });
    }
  }
  return { gear, stock, food, working, kept };
}
