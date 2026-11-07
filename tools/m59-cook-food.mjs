// COOK FROM THE ROAD: A CREATE-FOOD KNOWER TURNS LOOTED REAGENTS INTO MEALS BEFORE IT EATS WHAT IT BOUGHT.
//
//   import { normalizeCookFood, cookFirstDecision } from './m59-cook-food.mjs';
//
// Operator, 2026-11-07, of the Farol mollusk farmers: "also create food from reagents from baby spiders / spiders, also
// spiders drop edible mushrooms". What the kod says they drop (monster.kod:4938, the treasure tables):
//   baby spider (spdrbaby.kod, TID_WIMPY, wimptres.kod): herbs 30, elderberry 20, mushroom 20, edible mushroom 20, red 5,
//                blue 5 -- one or two rolls a kill. BOTH halves of create food, and a meal.
//   spider      (spider.kod, TID_MEDIUM_TOUGH, med-tght.kod): red mushroom 30, edible mushroom 16, purple 15, emerald 10,
//                sapphire 10, blue 8, ... -- a meal, but NO herbs or elderberry.
// The default loot takes all of it (Session.lootFloor), and an edible mushroom is Food the keeper already eats.
//
// What already existed: `provision()` casts create food (2 elderberry + 2 herbs, 10 mana; creafood.kod:40-59) only when the
// larder is EMPTY -- so a farmer carrying three loaves of bread walks thirty herbs past its own spell and buys more bread.
// `cookFood: { first: true }` reverses the order while the character is climbing toward its vigor ceiling: cook first,
// as long as the food aboard will not reach the ceiling on its own, then eat. One cast a pass, no more.
//
// And the fleet-mate half is the one that already exists: a create-food knower that has cast and can no longer afford
// another raises a shortfall on the fleet board (hunt-setup.mjs, the `lastCastSent` rule), and every keeper in its room
// with spare elderberry and herbs hands them over (m59-sharing.mjs). That only works if the farm does NOT `protect` them --
// which is why the farm town's `keep` (m59-farm-town.mjs) is a sale exclusion and not a protection.
//
// WHAT IT NEVER DOES: cast with something in reach or while being hit (the casting-safety standard: a short cast needs no
// recent hit), cast below the mana the spell costs (the server refuses SILENTLY), or cook past the ceiling.
//
// PURE.

export const COOK_FOOD_DEFAULTS = Object.freeze({
  enabled: true,
  // Cook from reagents BEFORE eating carried food, while the food aboard will not reach the vigor ceiling.
  first: true,
  // Casts per pass is always one; this many reagent sets are left uncooked as a reserve (0: cook everything spare).
  reserveCasts: 0,
});
// What one cast is worth, on average (creafood.kod:73-122 rolls apple 10 .. cheese 30, inky-cap 50; the fleet measured
// about fourteen vigor a cast at the levels it casts at). Used only to say "the food aboard will not reach the ceiling".
export const COOK_VIGOR_PER_CAST = 14;
const KEYS = Object.keys(COOK_FOOD_DEFAULTS);

export function normalizeCookFood(v) {
  if (v === null || v === undefined || v === false) return null;
  if (v === true) return { ...COOK_FOOD_DEFAULTS };
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('cookFood is true, false, null or { first, reserveCasts }');
  for (const k of Object.keys(v)) if (!KEYS.includes(k)) throw new Error(`cookFood: unrecognised key ${k} (known: ${KEYS.join(', ')})`);
  const out = { ...COOK_FOOD_DEFAULTS };
  for (const k of ['enabled', 'first']) if (v[k] !== undefined) {
    if (typeof v[k] !== 'boolean') throw new Error(`cookFood.${k} must be true or false`);
    out[k] = v[k];
  }
  if (v.reserveCasts !== undefined) {
    const n = Number(v.reserveCasts);
    if (typeof v.reserveCasts === 'boolean' || !Number.isInteger(n) || n < 0 || n > 50) throw new Error('cookFood.reserveCasts must be a whole number from 0 to 50');
    out.reserveCasts = n;
  }
  return out.enabled ? out : null;
}
export function cookFoodSettings(v) { try { return normalizeCookFood(v); } catch { return null; } }

/**
 * Cook now, before eating?
 *   cfg        normalizeCookFood output
 *   vigor      current vigor; ceiling: what provision eats up to
 *   larder     total nutrition of the food aboard
 *   reagents   { elderberry, herbs }
 *   mana       current mana (null: unknown -- cookSomething checks it again), manaCost: CREATE_FOOD_MANA
 *   danger     something in melee reach, or hit in the last few seconds
 *   knows      false once this keeper has seen the spell absent (null: not yet asked)
 * -> { cook: bool, why }
 */
export function cookFirstDecision({ cfg, vigor, ceiling, larder = 0, reagents = {}, mana = null, manaCost = 10,
                                    danger = false, knows = null } = {}) {
  const no = why => ({ cook: false, why });
  if (!cfg?.first) return no('cookFood.first is off');
  if (knows === false) return no('the character does not know create food');
  if (!Number.isFinite(Number(vigor)) || !(Number(ceiling) > 0)) return no('no vigor ceiling to climb to');
  if (Number(vigor) >= Number(ceiling)) return no('at the vigor ceiling');
  const sets = Math.min(Math.floor((Number(reagents.elderberry) || 0) / 2), Math.floor((Number(reagents.herbs) || 0) / 2));
  if (sets <= (cfg.reserveCasts ?? 0)) return no(`${sets} reagent set(s), ${cfg.reserveCasts ?? 0} kept in reserve`);
  if (mana != null && Number(mana) < manaCost) return no(`mana ${mana} < ${manaCost}`);
  if (danger) return no('something is in reach: no casting on a contested square');
  const gap = Number(ceiling) - Number(vigor);
  if (Number(larder) >= gap) return no(`the food aboard (${larder}) already reaches the ceiling (${gap} short)`);
  return { cook: true, why: `${gap} vigor short of the ceiling with ${larder} aboard; ${sets} reagent set(s) to cook from` };
}
