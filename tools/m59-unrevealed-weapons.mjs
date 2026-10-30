// AN UNIDENTIFIED WEAPON ON THE FLOOR, AND WHETHER THIS CHARACTER MAY PICK IT UP.
//
//   import { unrevealedWeaponMode, readUnrevealedWeaponMode, unrevealedWeaponGate, uncurseDesk,
//            refusedWeaponPickup } from './m59-unrevealed-weapons.mjs';
//
// PICKING UP A CURSED WEAPON IS WIELDING IT. `item.kod:508-514` (`NewOwner`): when an item for
// which `IsCursed` answers TRUE enters a User's pack, the server says `item_try_use_cursed_rsc` and
// POSTS `TryUseItem` on the picker -- the item equips itself. `WeapAttCursed` is one of the item
// attributes `IsCursed` asks (item.kod:779-790, wacursed.kod), and once it is in the hand
// `ItemReqUnuse` returns FALSE unconditionally: "The axe seems to cling to your hand!". So for a
// weapon, exactly as for a ring, THE LOOT DECISION IS THE WIELD DECISION, and `weaponRanking`
// never gets the second chance the floor filter's old comment promised it.
//
// AND THE CURSE CANNOT BE SEEN FROM THE FLOOR. A loot attribute is hidden until revealed, and
// `GetRarity` (item.kod:714-730) answers ITEM_RARITY_GRADE_UNIDENTIFIED (100) before it looks at
// anything else, so a cursed long sword lying on a corpse reads "long sword", rarity 100 -- the
// same as one carrying a harmless +1. Operator, 2026-10-30: many fleet characters found wielding
// cursed weapons they could not put down, every one of them picked up off a kill.
//
//   policy.lootUnrevealedWeapons = null      silence: the old behaviour -- unidentified weapons are
//                                            looted like anything else (the default on every roster)
//                                  'always'  the same, said out loud
//                                  'desk'    only while a remove-curse desk is publishing on the
//                                            service board (`uncurse` ok on its menu), so a curse that
//                                            does cling has somewhere to be lifted
//                                  'never'   never; a weapon that has been revealed is unaffected
//
// Under 'desk' and 'never' a weapon already GRADED cursed (rarity 200, revealed and cursed) is
// refused too: it is the same self-equip with no doubt left about it. Under silence nothing changes.
//
// PURE. No client, no keeper, no store: the board is handed in, and the session's classifier is too.

export const UNREVEALED_WEAPON_MODES = Object.freeze(['always', 'desk', 'never']);

// A desk republishes its menu every minute while its keeper runs (chalicePublishDesk), so a record
// older than this is a desk nobody is sitting at -- the same bound pickMendDesk uses.
export const UNCURSE_DESK_MAX_AGE_MS = 15 * 60_000;

const RARITY_CURSED = 200;

/** Strict normaliser for the strategy field and the broker argument: null | 'always' | 'desk' | 'never'; else throws. */
export function unrevealedWeaponMode(v) {
  if (v === null || v === undefined) return null;
  const m = typeof v === 'string' ? v.trim().toLowerCase() : null;
  if (!UNREVEALED_WEAPON_MODES.includes(m))
    throw new Error(`lootUnrevealedWeapons must be one of ${UNREVEALED_WEAPON_MODES.join(', ')} or null; ` +
                    `got ${JSON.stringify(v)}`);
  return m;
}

/**
 * The keeper's reading of whatever is in the policy. Never throws. An unrecognised value is
 * REPORTED (`problem`) and NOT applied -- the mode stays null, which is the behaviour that was
 * already there (docs/m59-policy.md: an unusable value keeps the committed one). Both doors that
 * write the key -- a strategy file and the broker's `autopilot` argument -- refuse it before it
 * gets here, so a bad value on a keeper means somebody wrote the roster by hand.
 */
export function readUnrevealedWeaponMode(v) {
  try { return { mode: unrevealedWeaponMode(v), problem: null }; }
  catch (e) { return { mode: null, problem: `${e.message}; ignored, so unidentified weapons loot as before` }; }
}

/**
 * A desk that can lift a curse NOW: a service-board record (`ChaliceStore.desk()`) whose menu lists
 * `{ kind: 'uncurse', ok: true }` and which was published within `maxAgeMs`. A record with no
 * timestamp is not fresh -- an unknown is not a desk. When `rooms` (the character's confinement) is
 * given, a desk stationed inside it is preferred; any live desk still counts.
 *   -> { desk: { name, room, at } | null, in_confinement: bool | null, why }
 */
export function uncurseDesk(desks, { now = Date.now(), rooms = null, maxAgeMs = UNCURSE_DESK_MAX_AGE_MS } = {}) {
  if (!desks || typeof desks !== 'object' || Array.isArray(desks))
    return { desk: null, in_confinement: null, why: 'the service board could not be read' };
  const offering = Object.entries(desks)
    .map(([key, d]) => ({ name: d?.server ?? key, room: d?.room ?? null, at: Number(d?.at) || null,
                          menu: Array.isArray(d?.menu) ? d.menu : [] }))
    .filter(d => d.menu.some(m => m?.kind === 'uncurse' && m.ok === true));
  const fresh = offering.filter(d => d.at != null && now - d.at >= 0 && now - d.at < maxAgeMs);
  if (!fresh.length)
    return { desk: null, in_confinement: null,
             why: offering.length
               ? `no remove-curse desk: ${offering.map(d => d.name).join(', ')} has not published in ${Math.round(maxAgeMs / 60_000)} min`
               : 'no remove-curse desk: no desk on the service board offers remove curse now' };
  const confine = Array.isArray(rooms) && rooms.length ? rooms.map(Number) : null;
  const inside = confine ? fresh.filter(d => confine.includes(Number(d.room))) : [];
  const pick = (inside.length ? inside : fresh).sort((a, b) => b.at - a.at)[0];
  return { desk: { name: pick.name, room: pick.room, at: pick.at },
           in_confinement: confine ? inside.length > 0 : null, why: null };
}

/**
 * This pass's verdict. `allow` is null under silence (the session's old behaviour), true or false
 * otherwise. Never throws.
 *   -> { mode, allow, desk, in_confinement, why }
 */
export function unrevealedWeaponGate(mode, { desks = null, now = Date.now(), rooms = null,
                                             maxAgeMs = UNCURSE_DESK_MAX_AGE_MS } = {}) {
  if (mode == null)
    return { mode: null, allow: null, desk: null, in_confinement: null,
             why: 'unset: unidentified weapons are looted as they always were' };
  if (mode === 'always')
    return { mode, allow: true, desk: null, in_confinement: null, why: 'always: unidentified weapons are looted' };
  if (mode === 'never')
    return { mode, allow: false, desk: null, in_confinement: null,
             why: 'lootUnrevealedWeapons is never' };
  if (mode === 'desk') {
    const d = uncurseDesk(desks, { now, rooms, maxAgeMs });
    return { mode, allow: !!d.desk, desk: d.desk, in_confinement: d.in_confinement,
             why: d.desk ? `remove curse is on offer at ${d.desk.name}${d.desk.room != null ? ` (room ${d.desk.room})` : ''}` : d.why };
  }
  // Not reachable through the normalisers; a mode nobody understands refuses rather than guesses.
  return { mode, allow: false, desk: null, in_confinement: null, why: `unknown mode ${JSON.stringify(mode)}` };
}

/**
 * Is this floor object a weapon the gate refuses? The reason to show, or null to leave it alone.
 * `isWeapon` and `isUnrevealed` are the session's own classifiers (skills.weaponScore > 0 and
 * skills.isUnrevealed), handed in so this file stays pure. Stacks are never unrevealed.
 */
export function refusedWeaponPickup(name, o, gate, { isWeapon, isUnrevealed } = {}) {
  if (!gate || typeof isWeapon !== 'function' || typeof isUnrevealed !== 'function') return null;
  if (gate.mode !== 'desk' && gate.mode !== 'never' && gate.allow !== false) return null;
  if (!isWeapon(name)) return null;
  // KNOWN CURSED: no desk makes this one worth having -- it is a penalty weapon (wacursed.kod
  // ModifyDamage/ModifyHitRoll, x - 2*power) that wields itself.
  if ((Number(o?.amount) || 0) <= 1 && Number(o?.rarity) === RARITY_CURSED)
    return `${name} (graded cursed — it would equip itself on pickup and never come off)`;
  if (gate.allow !== false) return null;
  const tail = gate.mode === 'never' ? 'lootUnrevealedWeapons is never' : 'no remove-curse desk';
  if (isUnrevealed(o)) return `${name} (unidentified weapon — a cursed one equips itself on pickup; ${tail})`;
  return null;
}
