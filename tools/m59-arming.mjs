// CAN THIS CHARACTER EVER HOLD THE WEAPON YOU ARE ABOUT TO GIVE IT?
//
// A character with no weapon in hand is not a character that WANTS one. Three settings make
// a bare character permanent, and every one of them turns a hand-over into a silence:
//
//   * `trainingStyle: 'unarmed'` on its own ground — the keeper takes the weapon back off on
//     the first swing (`prepareTrainingStyle` -> `unuseTrainingWeapon`). Measured 2026-09-11:
//     Statler took three `act use` calls with three different weapons and answered with
//     silence each time.
//   * `bannedWeapons` covering everything the pack holds. Measured 2026-09-18: Rowlf carried
//     22 long swords and Rizzo 24, both banned `long sword`, both standing bare waiting on 15
//     mana for `create weapon` — Rizzo for 4,293 idle passes, vigor draining 42 to 33, with
//     the fleet board rendering `hunting: zombie or battered skeleton` the whole time.
//     Lifting that one ban armed both within seconds.
//   * being under `fightAboveVigor`, because `armSelf()` is reached from the RECOVERY branch
//     after `hibernate()` — "THEN ARM, because the resting is what pays for it" — so a
//     character held below its floor never reaches the arming step at all.
//
// WHY THIS IS A MODULE AND NOT A METHOD. `m59-autopilot.mjs` carries a doc comment for
// exactly the first function here — *"Conjured weapons in the pack that this character's own
// ban list forbids it to hold"* — sitting directly on top of `hostilePlayersInReach()`, with
// no method under it. The comment was written and the code never was, or was removed and the
// comment left. Either way the diagnostic the 2026-09-18 incident asked for did not exist,
// and `m59-rearm.mjs` — the tool whose whole job is handing weapons to bare characters —
// consults neither the style nor the ban list before it walks somebody across the map.
//
// It lives out here because `m59-rearm.mjs` calls `main()` at module scope and
// `m59-autopilot.mjs` is thirteen thousand lines: a predicate two tools need has to be
// somewhere both can import without starting a fleet. Same argument as `m59-keeper-address.mjs`.
//
// `isBannedWeapon` and `weaponScore` are INJECTED rather than imported so this stays pure and
// testable, and so there is exactly one ban-matching rule in the repository — the one in
// `m59-skills.mjs` (substring, case-insensitive) — rather than a second one written here that
// agrees with it until somebody changes one of them.

/** The ban rule, defaulted to the one in m59-skills.mjs so a caller cannot accidentally invent another. */
const defaultIsBanned = (name, banned) => {
  if (!banned || !banned.length) return false;
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  return [].concat(banned).some(b => {
    const want = String(b || '').trim().toLowerCase();
    return want && n.includes(want);
  });
};

const nameOf = item => typeof item === 'string' ? item : String(item?.name ?? '');

/**
 * The weapons in this pack that this character's own ban list forbids it to hold.
 *
 * This is the hoard `create weapon` builds when the ban and the spell disagree: every cast
 * succeeds, every result is refused by `equipBest`, and the pack fills with them. A full pack
 * then answers `receiver_full` to every `supply`, so the character cannot even be handed a
 * weapon it IS allowed to use.
 *
 * `weaponScore` decides what counts as a weapon; pass the one from `m59-skills.mjs`. A
 * hand-written list of weapon names has been wrong here before and would be wrong again the
 * first time somebody loots something the list does not name.
 */
export function bannedWeaponsHeld({ items = [], banned = null,
                                    weaponScore = () => 1,
                                    isBannedWeapon = defaultIsBanned } = {}) {
  if (!banned || ![].concat(banned).length) return [];
  return (items || []).filter(i => {
    const n = nameOf(i);
    return n && weaponScore(n) > 0 && isBannedWeapon(n, banned);
  });
}

/** Every weapon in the pack this character IS allowed to choose. */
export function usableWeaponsHeld({ items = [], banned = null,
                                    weaponScore = () => 1,
                                    isBannedWeapon = defaultIsBanned } = {}) {
  return (items || []).filter(i => {
    const n = nameOf(i);
    return n && weaponScore(n) > 0 && !isBannedWeapon(n, banned);
  });
}

/**
 * Why arming this character would not stick — or `null` when nothing is in the way.
 *
 * THE LIST IS CLOSED AND `unknown` IS NOT ON IT. Every reason here is a setting somebody can
 * read and change; a bare character with none of them is a bare character this function has
 * nothing to say about, and it says so by returning null rather than by inventing a cause.
 * That distinction is the point — "no reason found" and "no reason exists" are different
 * claims, and the refusal text (`UNARMED_NO_DONOR`, "needs 15 to make one") describes the
 * FALLBACK, never the reason the fallback was reached.
 *
 * `offered` is the specific weapon about to be handed over, when there is one. Checking it
 * separately matters: a character can have a usable weapon coming and still be blocked, and a
 * character whose pack is all-banned can still be rescued by a hand-over of something else.
 */
export function armingRefusal({ policy = {}, items = [], offered = null, vigor = null,
                               onOwnGround = true,
                               weaponScore = () => 1,
                               isBannedWeapon = defaultIsBanned } = {}) {
  const banned = policy?.bannedWeapons ?? policy?.banned_weapons ?? null;
  const style = policy?.trainingStyle ?? policy?.training_style ?? null;

  // BARE ON PURPOSE, and scoped to its own ground the way the keeper scopes it: off station an
  // unarmed trainer still arms, because that weapon is for the road rather than for the bout.
  if (String(style).toLowerCase() === 'unarmed' && onOwnGround)
    return { reason: 'training_style_unarmed',
             detail: 'trainingStyle is "unarmed" on its own ground — the keeper takes the ' +
                     'weapon back off on the first swing, so a hand-over is put straight down' };

  if (offered != null && isBannedWeapon(nameOf(offered), banned))
    return { reason: 'offer_banned',
             detail: `${nameOf(offered)} is on this character's bannedWeapons list, so ` +
                     '`equipBest` will refuse it after the walk' };

  const held = bannedWeaponsHeld({ items, banned, weaponScore, isBannedWeapon });
  const usable = usableWeaponsHeld({ items, banned, weaponScore, isBannedWeapon });
  if (offered == null && held.length && !usable.length)
    return { reason: 'every_weapon_banned',
             detail: `carries ${held.length} weapon(s) and every one is banned ` +
                     `(${[...new Set(held.map(nameOf))].join(', ')})` };

  // The vigor gate is LAST because it is the only reason here that clears on its own. A
  // character under its floor is resting its way back up to the arming step; the other two
  // never clear without somebody changing a setting.
  const floor = policy?.fightAboveVigor ?? policy?.fight_above_vigor ?? null;
  if (Number.isFinite(vigor) && Number.isFinite(floor) && floor > 0 && vigor < floor)
    return { reason: 'below_vigor_floor',
             detail: `vigor ${vigor} is under fightAboveVigor ${floor} — armSelf() sits after ` +
                     'hibernate() in the recovery branch and is not reached until it rests up' };

  return null;
}
