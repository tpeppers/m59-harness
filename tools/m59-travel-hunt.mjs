// HUNT ON THE ROAD: A FARMER WALKING TO TOWN AND BACK KILLS WHAT IT WOULD KILL AT HOME, THEN WALKS ON.
//
//   import { normalizeTravelHunt, travelHuntDecision, TRAVEL_HUNT_ORIGINS } from './m59-travel-hunt.mjs';
//
// Operator, 2026-11-07, of the Farol mollusk farmers: "Have the farmers also clear monsters they come across while
// traveling". What already existed, and why none of it is this:
//   * `clear_path` (TRAVEL_GUARD_DEFAULTS) swings only at a creature that has PINNED the walk for six seconds -- a blocker,
//     never a monster beside the road. And it is gated off while a travel hold is on the keeper (`this.inert`), which is
//     every keeper journey; it arms for a body already stalled with a suspended journey.
//   * the fight-back edict (`fightBackAfterMs`) answers only BEING HIT, and is off unless an operator sets it.
//   * `fight_back` in the guard is the PvP exemption wearing a misleading name.
// So a farmer crossing the Forest of Farol to Marion walked past every baby spider it could have eaten, and through every
// one that bit it.
//
// WHAT THIS IS: a third trigger beside those two, read by the WATCHDOG (Autopilot.travelHuntCheck) and answered by the one
// consumer they share (`passFightBack`, reason 'travel_hunt'), so the target is still chosen by the engagement band, the
// spare list and karma_strict (refuseEngagement), and the fight still disengages at the flee line. It cancels the WALK,
// never the objective: a town trip re-issues its leg five seconds later, a keeper journey resumes from its suspension.
//
// WHAT IT NEVER DOES, and each gate below is one of these:
//   * survival first. Below `safety().fleeAt` it does nothing; it OPENS a fight only at or above `engageAt` (the farm's own
//     "do not start a fight that cannot be finished" line) and the fight floor in vigor. A monster already swinging at us
//     may be answered between the flee line and engageAt -- running from it is the survival ladder's call, not this one's.
//   * only on the keeper's OWN journeys (TRAVEL_HUNT_ORIGINS: town trips, the walk back to the station, a relocation).
//     An operator's or a FleetScript's travel, a red-alert recall, a PvP flight, a shelter walk, a rescue: never.
//   * never under an errand (an inert hold that is not a journey), never while already fighting, never with a player
//     (inReachOfUs-style filtering drops PLAYER objects: a bump on a shared road must not start a war).
//   * never in a crowd (`maxThreats` attackable monsters within CROWD_SQUARES), never in a wall-to-wall crossing room
//     (`skipRooms`, Ukgoth 599 by default -- m59-safelegs.mjs), and at most `maxPerJourney` fights per destination, so a
//     road full of spiders cannot turn one town trip into an afternoon or push a resumed journey over its attempt cap.
//
// PURE. The keeper gathers the inputs; this decides and says why.

export const TRAVEL_HUNT_DEFAULTS = Object.freeze({
  enabled: true,
  // How far off the line a monster may be and still be "come across": coarse squares, Euclidean. Melee reach is 3
  // (REACH); four lets the fight's own approach (capped at 6 steps) close the last square. Above 8 is a detour.
  reach: 4,
  // At or above this many attackable monsters within CROWD_SQUARES, walk on: a crowd is the road's problem, not quarry.
  maxThreats: 4,
  // Fights per destination before the rest of the road is walked. Under the resume cap (resumeTravelAttempts, 12).
  maxPerJourney: 6,
  // After a road fight, this long before the next is opened, so the leg makes progress between fights.
  cooldownS: 8,
  // Rooms never hunted in on a journey.
  skipRooms: Object.freeze([599]),
  // Keeper journey origins (m59-move-origin.mjs keeperOrigin names) that may stop to hunt; null = the default list.
  origins: null,
});
export const CROWD_SQUARES = 8;
/** The keeper's own WORK journeys. Survival, rescue, PvP and anybody else's order are absent on purpose. */
export const TRAVEL_HUNT_ORIGINS = Object.freeze([
  'town_trip', 'sell_circuit', 'food_shopping', 'reagent_shopping', 'purchase_funds', 'vault_run',
  'town_favor_buy', 'town_favor_deliver', 'farm_supply_buy', 'farm_supply_delivery', 'provision',
  'station_return', 'station_approach', 'hunt_relocation', 'spawn_cap_relocation', 'roam', 'roam_home',
]);
const KEYS = Object.keys(TRAVEL_HUNT_DEFAULTS);

/** true | false | null | { ...TRAVEL_HUNT_DEFAULTS } -> null (off) or the full settings. Throws on a bad shape. */
export function normalizeTravelHunt(v) {
  if (v === null || v === undefined || v === false) return null;
  if (v === true) return { ...TRAVEL_HUNT_DEFAULTS };
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('travelHunt is true, false, null or { reach, maxThreats, maxPerJourney, cooldownS, skipRooms, origins }');
  for (const k of Object.keys(v)) if (!KEYS.includes(k)) throw new Error(`travelHunt: unrecognised key ${k} (known: ${KEYS.join(', ')})`);
  const out = { ...TRAVEL_HUNT_DEFAULTS };
  if (v.enabled !== undefined) { if (typeof v.enabled !== 'boolean') throw new Error('travelHunt.enabled must be true or false'); out.enabled = v.enabled; }
  const num = (k, lo, hi, int = false) => {
    if (v[k] === undefined) return;
    const n = Number(v[k]);
    if (typeof v[k] === 'boolean' || !Number.isFinite(n) || n < lo || n > hi || (int && !Number.isInteger(n)))
      throw new Error(`travelHunt.${k} must be a${int ? ' whole' : ''} number from ${lo} to ${hi}`);
    out[k] = n;
  };
  num('reach', 1, 8); num('maxThreats', 1, 20, true); num('maxPerJourney', 1, 11, true); num('cooldownS', 0, 600);
  for (const k of ['skipRooms', 'origins']) {
    if (v[k] === undefined) continue;
    if (v[k] === null) { out[k] = k === 'origins' ? null : Object.freeze([]); continue; }
    if (!Array.isArray(v[k])) throw new Error(`travelHunt.${k} must be a list or null`);
    if (k === 'skipRooms') {
      const rooms = v[k].map(Number);
      if (rooms.some(r => !Number.isInteger(r) || r <= 0)) throw new Error('travelHunt.skipRooms must be room numbers');
      out[k] = Object.freeze([...new Set(rooms)]);
    } else {
      if (v[k].some(x => typeof x !== 'string' || !/^[a-z_]+$/.test(x))) throw new Error('travelHunt.origins must be keeper origin names (town_trip, station_return, ...)');
      out[k] = Object.freeze([...new Set(v[k])]);
    }
  }
  return out.enabled ? out : null;
}

/** Never throws: a bad stored value is off (and the validator is where it was refused out loud). */
export function travelHuntSettings(v) { try { return normalizeTravelHunt(v); } catch { return null; } }

/**
 * Should the watchdog stop this walk for a road fight?
 *
 *   cfg          normalizeTravelHunt output (null: no)
 *   journey      { travelling: bool (a journey hold or a GOING state), errand: bool (an inert hold that is NOT a journey),
 *                  fighting: bool, origin: { source, name } | null, to: room | null, room: room here }
 *   health       { frac, fleeAt, engageAt }        fractions of max health
 *   vigor        { value, floor }                  the fight floor, as fightFloor() reports it
 *   candidates   [{ id, name, d, refused, attacking }]   attackable NON-PLAYER objects within cfg.reach, nearest first;
 *                `refused` is refuseEngagement / spare / karma's verdict, `attacking` true for one in melee reach while we bleed
 *   threats      attackable non-player monsters within CROWD_SQUARES
 *   budget       { fights, lastAt }                fights this keeper has had on the road to `journey.to`
 *   now
 * -> { hunt: true, pick, why } | { hunt: false, why }
 */
export function travelHuntDecision({ cfg, journey = {}, health = {}, vigor = {}, candidates = [], threats = 0,
                                     budget = {}, now = Date.now() } = {}) {
  const no = why => ({ hunt: false, why });
  if (!cfg) return no('travelHunt is off');
  if (!journey.travelling) return no('not on a journey');
  if (journey.errand) return no('an errand holds the body');
  if (journey.fighting) return no('already fighting');
  const origin = journey.origin;
  const allowed = cfg.origins ?? TRAVEL_HUNT_ORIGINS;
  if (origin?.source !== 'keeper' || !allowed.includes(origin?.name))
    return no(`not the keeper's own work journey (${origin ? `${origin.source}:${origin.name}` : 'unattributed'})`);
  if (cfg.skipRooms?.map(Number).includes(Number(journey.room))) return no(`room ${journey.room} is crossed wall to wall, never hunted`);
  const { frac, fleeAt = 0, engageAt = 1 } = health;
  if (frac == null || !Number.isFinite(frac)) return no('health unknown');
  if (frac < fleeAt) return no('below the flee line: survival owns the body');
  if (Number(budget.fights ?? 0) >= cfg.maxPerJourney) return no(`already fought ${budget.fights} times on the road to ${journey.to ?? '?'}`);
  if (budget.lastAt && now - budget.lastAt < cfg.cooldownS * 1000) return no('the last road fight was moments ago: walk on first');
  if (threats >= cfg.maxThreats) return no(`a crowd (${threats} within ${CROWD_SQUARES} squares): the road is walked, not hunted`);
  const live = candidates.filter(c => c && c.name && !c.refused && Number.isFinite(c.d) && c.d <= cfg.reach)
    .sort((a, b) => Number(!!b.attacking) - Number(!!a.attacking) || a.d - b.d);
  if (!live.length) return no(candidates.length ? `nothing in reach inside the band (${candidates[0]?.refused?.why ?? 'refused'})` : 'nothing in reach');
  const pick = live[0];
  // Opening a fight needs the farm's own engage line and the vigor floor; answering one that is already on us does not.
  const fed = !(Number(vigor.floor) > 0) || Number(vigor.value) >= Number(vigor.floor);
  if (!pick.attacking) {
    if (frac < engageAt) return no(`below the engage line (${Math.round(frac * 100)}% < ${Math.round(engageAt * 100)}%): no new fight`);
    if (!fed) return no(`below the fight floor in vigor (${vigor.value} < ${vigor.floor}): no new fight`);
  }
  return { hunt: true, pick, why: pick.attacking ? `a ${pick.name} is on us: answer it, then walk on`
                                                 : `a ${pick.name} ${pick.d.toFixed(1)} squares off the road, inside the band` };
}

/** The per-destination road-fight count, reset when the destination changes or the count is stale (30 min). */
export function travelHuntBudget(prev, to, now = Date.now()) {
  if (!prev || prev.to !== to || now - (prev.since ?? 0) > 30 * 60_000) return { to, fights: 0, lastAt: 0, since: now };
  return prev;
}
