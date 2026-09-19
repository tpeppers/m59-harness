// BUILD KRAANAN BY BUFFING THE ROOM, AND SPEND THE COOLDOWN ON A WEAPON YOU MADE YOURSELF.
//
//   practice-kraanan agents=hk1 level=2                # the composite loop — the point of this
//   practice-kraanan agents=hk1 level=3                # same loop, level 3's buffs
//   practice-kraanan agents=hk1 spell=bless casts=40   # one spell on its own
//   practice-kraanan agents=hk1 spell=mend casts=20    # the create-weapon cycle, mend flavour
//   practice-kraanan --list                            # what is drillable, what is not, and why
//
// PUBLIC. Asked for by the operator, 2026-09-19: "build kraanan (level 2->3) ... The primary way
// it will build Kraanan is by casting buff spells on itself and anyone else passing through the
// room," then sharpened twice — first with the level-2 shape ("Bless, Super Strength and Enchant
// Weapon ... the primary two to build are bless and super strength, since they require far less
// mana and are faster to cast/build -- but it requires a cooldown if there's nobody in the room
// who doesn't already have the buffs.. so the loop is basically buff everyone in the room... then
// wait a bit by creating & enchanting a weapon... then going back to the buff loop"), and then
// with the generalisation this file is built around:
//
//   "these parts will be reusable for building higher levels of kraanan -- not often the
//   create/enchant weapon cycle part, but the 'buff everyone else in the room plus buff
//   yourself'-part... like for example, Level 3 kraanan has 'night vision', 'magic shield', and
//   'free action' -- spells that require a player target and increasingly long durations, just
//   like Bless and Super Strength.. level 4 has eagle eyes and deflect for personal spells, but
//   'mend' actually has the same create-weapon-cycle as 'enchant weapon' (create weapon -> mend
//   the created weapon -> Drop it, restart the cycle.. because created weapons are slightly worn,
//   so they can be mended to improve the mend skill)"
//
// SO THERE ARE EXACTLY TWO ENGINES HERE AND BOTH ARE LEVEL-AGNOSTIC:
//
//   buffRoom(spell)          any PersonalEnchantment, any level. Self first (always legal), then
//                            every other player in the room once. Levels 2, 3 and 4 all have a
//                            set; `buffsAtLevel(n)` derives them from the table.
//   weaponCycle({ apply })   create a weapon, cast ONE thing on it, drop it. `apply` is
//                            'enchant weapon' (level 2), 'mend' (level 4) or 'glow' (level 1) —
//                            three different school levels through one loop.
//
// `trainLevel(n)` is the composite: buff rounds from level n, with the weapon cycle filling the
// gap between them. Everything below is in service of those three.
//
// THE OPERATOR'S READING IS RIGHT ON EVERY POINT THAT WAS CHECKABLE, including the mend claim,
// which turns out to be stronger than he put it — see THE MEND CYCLE below. Two things he could
// not have known change the shape, and both are improvements:
//
//   THE CASTER NEVER NEEDS THE COOLDOWN. `pbCanRecastSelfEnchantment` is TRUE
//   (kod/util/settings.kod:80), and persench.kod:121-125 lets a caster overwrite its OWN
//   enchantment while it is still running. So the cooldown he describes is real for everybody
//   ELSE in the room and does not exist for the character doing the casting. The weapon cycle is
//   therefore not dead time that must be filled — it is a CHOICE, and `fillWith` picks.
//
//   AND THE COOLDOWN THAT DOES BIND IS NOT THE ENCHANTMENT'S. It is the botting cap, which is
//   10 SUCCESSFUL IMPROVES per 15-22 minutes, and the answer to it is to walk, not to wait.
//   See THE COUNTER THAT ACTUALLY STOPS THIS below.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE KEEPER USED TO REFUSE ALMOST EVERY CAST IN THIS FILE. IT NO LONGER DOES.
//
// Until 2026-09-19 a keeper-backed `cast` was screened by a fail-closed RTS allowlist holding
// exactly three spells — create food, create weapon, blink — so every buff, every enchant and
// every mend in this file came back 409 "not classified as safe for RTS casting". The whole
// script planned and priced and then refused at step 0.
//
// The operator retired that allowlist: "we've progressed far enough we can cast on other players
// at will." m59-rts-safety.mjs carries what it was and what was given up. What survives there is
// an arity check — a zero-target spell must be sent with no target and a one-target spell with
// one — which is packet shape rather than policy, and which every cast here already satisfies
// because the `targets` column is read off the same `GetNumSpellTargets` the server reports.
//
// So there is no gate in this file any more. It plans, and the casts go.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE BUFF ROUND IS ONE STEP AND NOT A LIST OF CASTS.
//
// `act()` FREEZES ITS ARGUMENTS WHEN THE STEP LIST IS COMPILED. The whole plan is built before
// the character moves, so a target resolved at build time names somebody who was in the room
// when the run was planned — which, for a script whose entire premise is "anyone else passing
// through the room", is nobody. There is no `act` step that can express "and whoever is standing
// here when you get to step 30".
//
// So `buffRoom()` is a single `verify` step that does its own `look`, its own target selection
// and its own casts inside one callback, and reports what it actually managed. That is not a
// workaround; it is the only shape that can read the room at the moment it is standing in it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE COUNTER THAT ACTUALLY STOPS THIS, and it is not mana and not the buff duration.
//
// `ADVANCEMENT_LIMIT` is 10 (player.kod:68) and `CheckAdvancementPoints` refuses every improve
// above it (player.kod:7647). The thing charged against that cap is NOT a cast:
// `AddAdvancementPoints` is called from `ChangeSpellAbility` under `if iChange > 0`
// (player.kod:6783-6786), so ONLY A SUCCESSFUL IMPROVE COSTS A POINT. Casts that fail the roll
// are free, and there is no per-cast budget at all.
//
// So the real ceiling on a Kraanan night is TEN ABILITY POINTS PER 15-22 MINUTES
// (`ADVANCE_TIMER_MIN/MAX` 900000/1320000, player.kod:66-67), across spells and skills together.
// Two things move it, and the script uses both:
//
//   A ROOM CHANGE REFUNDS 2. player.kod:1465, whose own comment reads "Player moved to a new
//   location, give them a break on the botting imp cap." Stepping out and back in is two room
//   changes and refunds 4 against a cap of 10 — so `stepOut` is not cosmetic, it is worth 40% of
//   a window every time the loop does it.
//
//   SITTING AT THE CAP ALSO HALVES THE PITY TIMER. `AddSchoolCast` adds only half its amount
//   while `CheckAdvancementPoints` is false (player.kod:6271-6274), so casting into a full cap
//   is worse than not casting: it burns mana and reagents AND builds the bonus at half rate.
//
// THE PITY TIMER IS REAL AND IT IS SHARED ACROSS THE SCHOOL. Every cast calls
// `AddSchoolCast(school, amount=viSpell_Level)` (spell.kod:1441), and `GetSecondaryChance` adds
// `GetSchoolCast(school) / viSpell_Level / CASTS_PER_PERCENT_BONUS` (spell.kod:1745-1747,
// CASTS_PER_PERCENT_BONUS = 7, spell.kod:25). It RESETS on every successful improve
// (spell.kod:1685). For a level-2 spell that is `casts * 2 / 2 / 7` — ONE EXTRA PERCENT PER
// SEVEN LEVEL-2 CASTS, wiped each time something advances.
//
// The consequence is the one the kod comments itself (spell.kod:1439-1443): "you can catch up on
// lower level spells by casting higher level spells, but you can't do the reverse as easily."
// Because the pool is per-SCHOOL, bless casts build the bonus that helps super strength advance
// and vice versa. SPREADING ACROSS A LEVEL IS FREE. It is not a compromise against grinding one
// spell — the shared pool means every cast in the school feeds every other spell in it. This is
// also why the weapon cycle is worth more than it looks: `enchant weapon` at level 2 pays 2 into
// a pool that `mend` at level 4 draws from at a quarter rate, and `mend` pays 4 into the pool
// that bless draws from at half.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHERE TO STAND: ROOM 801, THE TEMPLE OF KRAANAN, AND IT IS NOT FOR THE ATMOSPHERE.
//
//   IT PAYS 10%. `tempkra.kod:283-294` implements `ModifyChanceToImprove` and returns
//   `(chance * 11)/10` for any Spell whose school is SS_KRAANAN. That hook is called on the
//   SECONDARY roll only (spell.kod:1664-1666), so it is a 10% bonus on the second of the two
//   gates, not on the whole cast.
//
//   IT IS COMBAT-LEGAL, WHICH ALMOST NOWHERE WITH FOOTFALL IS. persench.kod:107-114 refuses a
//   buff on ANYBODY BUT YOURSELF when the room's PERMANENT flags carry ROOM_NO_COMBAT
//   (0x0002, blakston.khd:1036) — "You cannot cast enchantments upon others here." 67 rooms in
//   this world carry it and they are the inns, the shops, the halls and the guild houses: every
//   indoor room where people actually stand around. Room 801 does not (`flags & 2` is 0 in
//   substrate/m59-map.json), and neither do the other temples.
//
//   AND A CROWD MAKES KRAANAN STRONGER. Alone among the schools, Kraanan's spellpower primary
//   bonus is `Length(Send(oRoom,@GetHolderActive))` — spell.kod:2168-2170, "Kraanan favors
//   adversity and armies.  More people in a room, the better." The secondary is
//   `(health*10)/maxHealth`, so a full-health caster gets ten more. Shal'ille reads the scenery
//   and your karma; Kraanan reads the crowd and your hit points.
//
// THE TWIST IN THAT LAST ONE, because it cuts against this script rather than for it.
// Spellpower does not touch the improve rolls at all — those are `viChance_To_Increase`,
// intellect and stamina. What spellpower buys is DURATION, and a longer buff means the bystander
// wearing it is re-castable LESS often. The crowd gives you more bodies and makes each one
// refresh more slowly. Both effects are real; the first is much the larger.
//
// AND THE DURATIONS RISE STEEPLY WITH LEVEL, WHICH IS THE OPERATOR'S "increasingly long
// durations" AND IS A PROBLEM RATHER THAN A FEATURE FOR PRACTICE. At spellpower 30, off the
// `durSec` column below: bless 110-220s, super strength 240-480s, free action 135-270s, magic
// shield 240s flat, and NIGHT VISION 1125-2250s — nearly forty minutes, during which that
// bystander is spent. A passer-by is close to single-use for night vision and genuinely reusable
// only for deflect, which is 25-50s. `buffRoom` holds a `seen` map for exactly this reason, and
// `holdMs` should be raised when drilling the long ones.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE MEND CYCLE, and why the operator's claim is not just right but guaranteed.
//
// He said created weapons are "slightly worn, so they can be mended". The kod is stronger than
// that: a created weapon is ALWAYS worn, and cannot not be.
//
//   creaweap.kod:112-114 sets the new weapon's hits to `GetHits * (iSpellPower + 100) / 200`,
//   with the comment "Weapon has half its hits, + iSpellPower% of the other half."
//   `SPELLPOWER_MAXIMUM` is 99 (blakston.khd:2090), so the best possible multiplier is 199/200
//   and the integer division loses the remainder. A freshly created weapon is therefore below
//   its maximum at every spellpower there is.
//
//   mend.kod's `CanPayCosts` refuses three things: a target that is not an Item answering
//   `CanMend`; one at zero hits ("beyond hope"); and one where `iHits = iMaxHits` ("already at
//   perfect condition"). A created weapon fails none of them.
//
// AND THAT IS WHY IT IS ONE MEND PER WEAPON, WHICH IS THE PART WORTH KNOWING. `CastSpell` sets
// **both** maxHits and hits to `maxHits * bound(75 + power/5, 75, 95) / 100` — it repairs the
// weapon by permanently LOWERING its ceiling to meet it. The weapon ends at `hits = maxHits`,
// which is the exact state the second refusal above rejects. So a mended weapon can never be
// mended again, the cycle must create a fresh one every time, and mend is a slow destruction
// spell that only makes sense on something disposable. Which a created weapon is: it carries an
// IA_MADE attribute that deletes it after `spellpower * 2` minutes anyway (creaweap.kod:120-123).
//
// THE SAME SHAPE, THREE LEVELS: glow (level 1, refuses a weapon already glowing), enchant weapon
// (level 2, refuses `ATCK_WEAP_MAGIC`), mend (level 4, refuses perfect condition). All three
// refuse a weapon they have already been cast on, so all three need the factory, and all three
// run through one `weaponCycle({ apply })`.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// AND THE STAT THAT GOVERNS THIS SCHOOL IS STAMINA, WHICH IS WHY THE SHAL'ILLE PLAN DOES NOT
// TRANSFER. `GetDivisionReq` returns Mysticism for Qor/Shal'ille/Faren and STAMINA for Kraanan
// (spell.kod:392-404). That stat is the whole of the secondary roll's base — `60 + stamina -
// level*10` (spell.kod:1715-1719) — and it sets the soft cap: above `2*stamina - 1` ability,
// the chance is divided by SOFTCAP_PENALTY = 4 (spell.kod:21, 1750-1753). A 30-stamina character
// hits that wall at ability 59; a 50-stamina one never does.
//
// Intellect still matters, but on the OTHER roll: `GetInitialChance` is
// `inc + (inc * intellect)/100` (spell.kod:1693-1709), which is school-blind. So the mystic who
// was good at Shal'ille is not thereby good at Kraanan, and the warrior is.
//
// AND KRAANAN ASKS NO KARMA AT ALL. `GetRequiredKarma` returns non-zero only for Qor (negative)
// and Shal'ille (positive) — spell.kod:483-496. The entire karma-management problem that shapes
// a Shal'ille run simply is not present here.
import { act, walk, rest, verify } from '../m59-fleetscript.mjs';

// EVERY NUMBER HERE IS READ OFF THE KOD, AND CARRIES WHERE FROM. Not from the spell catalogue on
// the wire and not from memory.
//
// `targets` is what `GetNumSpellTargets` answers — note that for every PersonalEnchantment that
// is 1 AND NOT 0, because `vbCanCastOnOthers` defaults TRUE (persench.kod:51,62-72) and not one
// Kraanan buff overrides it. A self-cast still has to NAME the caster: the broker refuses `cast`
// with no target when the server says the spell takes one (m59-broker.mjs:12137-12139), and
// persench's own `lTargets = [who]` default is never reached through this path.
//
// `kind` is what decides which engine can drill it, and it is the column the whole file routes
// on — 'buff' goes to buffRoom, 'weapon' goes to weaponCycle, 'other' goes nowhere yet.
// `gate` is what that spell's own `CanPayCosts` adds on top of the base class; `inc` is
// `viChance_To_Increase`, the FIRST of the two rolls; `castMs` is `viCast_time`, which is 0 on
// most spells and very much not on enchant weapon. `durSec` is `GetDuration` in seconds before
// the random halving, which `halved` records separately — a duration that is `random(d/2, d)`
// has a floor half as long as the number in the column.
export const KRAANAN = Object.freeze({
  'relay':            { level: 1, mana: 5,  inc: 20, targets: 1, castMs: 0, kind: 'other',
                        reagents: [['snack', 1]],
                        gate: 'a player target to relay to', src: 'relay.kod' },
  'create food':      { level: 1, mana: 10, inc: 15, targets: 0, castMs: 0, kind: 'other',
                        reagents: [['elderberry', 2], ['herb', 2]],
                        gate: null, src: 'creafood.kod' },
  'create weapon':    { level: 1, mana: 15, inc: 20, targets: 0, castMs: 500, kind: 'factory',
                        reagents: [],
                        gate: null, src: 'creaweap.kod:39-41,55-57' },
  'glow':             { level: 1, mana: 15, inc: 20, targets: 1, castMs: 0, kind: 'weapon',
                        reagents: [['elderberry', 2], ['mushroom', 2]],
                        gate: 'a weapon that is not already glowing', src: 'glow.kod' },

  'bless':            { level: 2, mana: 6,  inc: 25, targets: 1, castMs: 0, kind: 'buff',
                        reagents: [['mushroom', 2], ['sapphire', 2]],
                        durSec: (p) => 40 + 6 * p, halved: true,
                        gate: 'a User not already blessed — unless it is you',
                        src: 'bless.kod:52-57,105-113' },
  'super strength':   { level: 2, mana: 10, inc: 30, targets: 1, castMs: 0, kind: 'buff',
                        reagents: [['mushroom', 2], ['orc tooth', 1]],
                        durSec: (p) => 300 + 6 * p, halved: true,
                        gate: 'a User not already strengthened — unless it is you',
                        src: 'strength.kod:44-49,77-84' },
  'haste':            { level: 2, mana: 10, inc: 15, targets: 1, castMs: 0, kind: 'buff',
                        reagents: [['snack', 5]],
                        durSec: null, halved: true,
                        gate: 'a User not already hasted — unless it is you',
                        src: 'haste.kod:45-52' },
  'resist poison':    { level: 2, mana: 10, inc: 15, targets: 1, castMs: 0, kind: 'buff',
                        reagents: [['herb', 2], ['red mushroom', 1]],
                        durSec: null, halved: true,
                        gate: 'a User not already resistant — unless it is you',
                        src: 'respois.kod' },
  'enchant weapon':   { level: 2, mana: 17, inc: 20, targets: 1, castMs: 30_000, kind: 'weapon',
                        reagents: [['elderberry', 3], ['orc tooth', 1]],
                        gate: 'a weapon IN YOUR OWN INVENTORY that is not already ATCK_WEAP_MAGIC',
                        src: 'enchwp.kod:49-53,76-98' },

  'free action':      { level: 3, mana: 10, inc: 15, targets: 1, castMs: 2_000, kind: 'buff',
                        reagents: [['red mushroom', 1], ['purple mushroom', 1]],
                        durSec: (p) => 180 + 3 * p, halved: true,
                        gate: 'a User not already free — unless it is you',
                        src: 'freeact.kod:58-65,71-75' },
  'magic shield':     { level: 3, mana: 9,  inc: 35, targets: 1, castMs: 0, kind: 'buff',
                        reagents: [['mushroom', 2], ['red mushroom', 1]],
                        // The one buff with NO random halving — GetDuration returns it flat.
                        durSec: (p) => (1 + Math.trunc((p + 5) / 10)) * 60, halved: false,
                        gate: 'a User not already shielded — unless it is you',
                        src: 'mshield.kod:47-55' },
  'night vision':     { level: 3, mana: 6,  inc: 35, targets: 1, castMs: 0, kind: 'buff',
                        reagents: [['elderberry', 3]],
                        durSec: (p) => 1500 + 25 * p, halved: true,
                        gate: 'a User without it already — unless it is you',
                        src: 'nightv.kod' },
  'detect invisible': { level: 3, mana: 15, inc: 15, targets: 1, castMs: 3_000, kind: 'buff',
                        reagents: [['solagh', 2]],
                        durSec: (p) => (2400 * (100 + p)) / 1000, halved: true,
                        gate: 'a User without it already — unless it is you',
                        src: 'detinvis.kod' },
  'shroud':           { level: 3, mana: 10, inc: 25, targets: 1, castMs: 0, kind: 'other',
                        reagents: [],
                        gate: 'an item that can be shrouded', src: 'shroud.kod' },

  'eagle eyes':       { level: 4, mana: 5,  inc: 20, targets: 1, castMs: 2_000, kind: 'buff',
                        reagents: [['mushroom', 3], ['purple mushroom', 1]],
                        durSec: (p) => 120 + 2 * p, halved: true,
                        gate: 'a User without it already — unless it is you',
                        src: 'Eagleyes.kod' },
  'deflect':          { level: 4, mana: 20, inc: 20, targets: 1, castMs: 3_000, kind: 'buff',
                        reagents: [['solagh', 1], ['kriipa claw', 1]],
                        durSec: (p) => 20 + p, halved: true,
                        gate: 'a User not already deflecting — unless it is you',
                        src: 'deflect.kod:62-85' },
  'mend':             { level: 4, mana: 9,  inc: 10, targets: 1, castMs: 0, kind: 'weapon',
                        reagents: [['sapphire', 1], ['orc tooth', 1]],
                        gate: 'an item answering CanMend, NOT at zero hits and NOT at full hits ' +
                              '— a freshly created weapon is always below full, guaranteed',
                        src: 'mend.kod:40-44,58-95' },
});

// THE THREE THE OPERATOR NAMED FOR LEVEL 2, in his order. Kept by name because a later edit that
// drops one should be visible in the test rather than silent.
export const OPERATOR_TRIPLE = Object.freeze(['bless', 'super strength', 'enchant weapon']);

// ───────────────────────────────────────────────────────────── what each engine can be given
//
// DERIVED FROM THE `kind` COLUMN, NEVER LISTED BY HAND, so a spell whose gate is corrected in one
// place stops appearing in every answer at once. This is the generalisation the operator asked
// for: nothing below names a level.
export const buffsAtLevel = (level = null) =>
  Object.entries(KRAANAN)
    .filter(([, s]) => s.kind === 'buff' && (level === null || s.level === level))
    .sort((a, b) => b[1].inc - a[1].inc)
    .map(([n]) => n);

// The spells that can be drilled against a weapon you made a moment ago. All three refuse a
// weapon they have already been cast on, which is precisely why the factory is needed.
export const weaponSpells = (level = null) =>
  Object.entries(KRAANAN)
    .filter(([, s]) => s.kind === 'weapon' && (level === null || s.level === level))
    .sort((a, b) => b[1].inc - a[1].inc)
    .map(([n]) => n);

// WHAT LEVEL N HOLDS FOR PRACTICE, both engines together, best odds first. This is the answer to
// "I am at level N-1, what do I drill", and it is the only list a caller should need.
export const drillableAtLevel = (level) =>
  [...buffsAtLevel(level), ...weaponSpells(level)]
    .sort((a, b) => KRAANAN[b].inc - KRAANAN[a].inc);

// HOW LONG THE THING YOU JUST CAST WILL SIT ON A BYSTANDER, which is how long before that
// bystander is worth casting at again. Returns a floor and a ceiling because most of these are
// `random(d/2, d)` and planning against the ceiling wastes a body for twice as long as needed.
export const durationRange = (spell, spellPower = 30) => {
  const s = KRAANAN[spell];
  if (!s?.durSec) return null;
  const full = Math.trunc(s.durSec(spellPower));
  return { minSec: s.halved ? Math.trunc(full / 2) : full, maxSec: full, spellPower };
};

// ───────────────────────────────────────────────────────────────────── what the gate really is
//
// THE SHAL'ILLE FILE SAYS "115 FOR LEVEL 4" AND THAT IS A MEASUREMENT, NOT THE RULE. The rule is
// player.kod:10837-10846 and it is a function of how many OTHER schools the character has been
// into, so it differs per character and there is no constant to quote:
//
//   iNeed = iPoints*POINTS_SLOPE + (297 - MaxLearnPoints*POINTS_SLOPE) - (rawIntellect*2*POINTS_SLOPE)/5
//   bounded below by MIN_NEEDED_TO_ADVANCE
//
// POINTS_SLOPE = 7 and MIN_NEEDED_TO_ADVANCE = 75 (player.kod:93,97); GetMaxLearnPoints is 16
// (settings.kod:71); GetLevelLearnPoints is Nth([1,2,4,6,8,10], level) (system.kod:414,
// 6217-6225). `iPoints` sums the HIGHEST level reached in each of the seven schools including
// weapons, and gets `+GetLevelLearnPoints(level) - GetLevelLearnPoints(level-1)` on top when the
// character knows nothing at the target level yet (player.kod:10824-10828).
//
// AND THE THING MEASURED AGAINST IT is the sum of the best THREE abilities in the same school at
// level N-1 (player.kod:10652-10787). Kraanan has no skills, only spells, so for us that is
// three of that level's spells — which is why `drillableAtLevel` returning four or five names
// matters: the other one or two are the bench, not waste.
//
// THE SHORTCUT NOBODY MENTIONS, AND IT IS THE MOST USEFUL THING IN THIS FILE.
// player.kod:10626-10641: if the character ALREADY KNOWS ANY SPELL AT THE TARGET LEVEL and that
// level is above 2, `PlayerCanLearn` returns SUCCESS before it does any of the arithmetic above.
// So THE FIRST SPELL AT ANY LEVEL ABOVE 2 IS THE ONLY ONE THAT COSTS ANYTHING — once one level-3
// Kraanan spell is bought, free action, night vision, magic shield, detect invisible and shroud
// are all unlocked with no further practice at all. The same is true again at level 4.
//
// Which sets the actual goal of a run: get ONE spell at the next level, then STOP drilling and go
// shopping. Drilling past that point is pure waste, and it is an easy mistake because the
// character keeps improving and the numbers keep going up.
export const learnGate = ({
  intellect = 0, kraanan = 2, weapon = 0, shalille = 0, qor = 0, faren = 0, riija = 0, jala = 0,
  knowsOneAtLevel = false, level = 3,
} = {}) => {
  const POINTS_SLOPE = 7, MIN_NEEDED = 75, MAX_LEARN_POINTS = 16;
  const lp = (lvl) => (lvl >= 1 && lvl <= 6 ? [1, 2, 4, 6, 8, 10][lvl - 1] : 0);
  let points = lp(weapon) + lp(kraanan) + lp(shalille) + lp(qor) + lp(faren) + lp(riija) + lp(jala);
  if (!knowsOneAtLevel) points += lp(level) - lp(level - 1);
  const need = points * POINTS_SLOPE
             + (297 - MAX_LEARN_POINTS * POINTS_SLOPE)
             - ((intellect * 2 * POINTS_SLOPE) / 5);
  return {
    need: Math.max(MIN_NEEDED, Math.trunc(need)),
    points,
    max: 3 * 99,      // the ceiling on the thing being measured: three abilities at 99
    why: knowsOneAtLevel
      ? `already knows a level-${level} Kraanan spell — player.kod:10626-10641 returns SUCCESS ` +
        `before any of this arithmetic runs, so the rest of the level is free`
      : `the best three level-${level - 1} Kraanan abilities must sum to this`,
    shortcut: `buy ONE level-${level} spell and the rest of level ${level} unlocks outright ` +
              `(player.kod:10626-10641)`,
  };
};

// ONE LINE PER REAGENT, SUMMED. A multi-spell plan naturally produces the same reagent twice —
// level 3 wants red mushrooms for both magic shield and free action, and elderberries for both
// night vision and the enchant that fills its cooldown. Handing a caller
// `[['red mushroom',2],['red mushroom',2]]` is not a shopping list: `shop()` takes lines and a
// merchant counter is one visit, so a duplicated line either buys half of what was meant or
// makes two trips for one errand. Order is preserved from first appearance so the list still
// reads in the order the plan needs things.
const mergeBuy = (buy = []) => {
  const totals = new Map();
  for (const [name, count] of buy) totals.set(name, (totals.get(name) ?? 0) + count);
  return [...totals.entries()].map(([name, count]) => [name, count]);
};

// Every plan passes its shopping list through mergeBuy on the way out. There used to be an RTS
// allowlist gate here as well, which replaced a blocked plan's steps with a refusal while
// keeping its price; the allowlist is retired and the gate went with it.
const priced = (plan) => ({ ...plan, buy: mergeBuy(plan.buy) });

// ───────────────────────────────────────────────────────────────────────────── shared plumbing
//
// STATUS HAS TWO SHAPES. A keeper-backed character answers `mana`; the broker answering
// in-process for a character joined before the sweep gave it a keeper answers `vitals.mana`.
// Reading only one gives null, which reads as "no mana" and is indistinguishable from an empty
// bar. Same trap as practice-shalille.mjs, same fix.
const manaOf = (st) => st?.vitals?.mana?.value ?? st?.mana?.value ?? null;

const castsPerBar = (maxMana, mana) => Math.max(1, Math.floor(maxMana / mana));

// NOTHING IN THIS HARNESS RESTS FOR MANA. `rest()` waits on health and vigor and has no mana
// target at all, so the wait is polled rather than pretended at.
const manaAtLeast = (need, maxSeconds = 180) => ({
  ...verify(async ({ agent, call }) => {
    const deadline = Date.now() + maxSeconds * 1000;
    for (;;) {
      const m = manaOf(await call('status', { agent }, 30_000).catch(() => null));
      if (m == null) return false;                       // unreadable is a refusal, not a pass
      if (m >= need) return true;
      if (Date.now() >= deadline) return false;
      await new Promise(r => setTimeout(r, 5_000));
    }
  }, `mana never reached ${need} — nothing in the harness rests for mana, so this polls status`),
  // Running out of mana must not unwind a practice run: the casts already made are the point.
  optional: true,
});

// WHAT A CAST ACTUALLY DID, READ OFF THE MANA RATHER THAN OFF THE REPLY.
//
// `cast: true` means the packet went out. The three outcomes that matter cannot be told apart
// any other way, and the broker already reports the delta for exactly this reason:
//
//   spent nothing      CanPayCosts refused. No mana, no reagents, NO PRACTICE, and often
//                      nothing on the wire. This is the silent one.
//   spent half         the cast happened and the success roll failed — `SpellFailed` takes
//                      `GetManaCost/2` (spell.kod:1152-1167). ImproveAbility already ran.
//   spent all          it worked.
//
// A refusal is FREE, which is what makes "try it and see" the right way to find out whether a
// bystander is already buffed: the wire does not carry another player's enchantments, and
// persench.kod:118-146 returns FALSE before taking anything.
const readCast = (r) => {
  const spent = Number.isFinite(r?.mana_before) && Number.isFinite(r?.mana_after)
    ? r.mana_before - r.mana_after : null;
  const text = [].concat(r?.messages ?? []).join(' ').toLowerCase();
  return {
    sent: r?.cast === true,
    spent,
    refusedByKeeper: r?.refused_by === 'the keeper process',
    // persench.kod:29 — "%s%s is already affected by that magic." — plus the per-spell overrides,
    // which every buff in the table sets to its own wording (bless.kod:43, strength.kod:16, …).
    alreadyBuffed: /already affected by that magic|already blessed|already have superior strength|already have|already enchanted|can already see/.test(text),
    // persench.kod:33 — the ROOM_NO_COMBAT refusal, and the one that invalidates a whole venue
    // rather than one target.
    roomForbids: /cannot cast enchantments upon others here/.test(text),
    // mend.kod's two weapon refusals, which are what end a weapon's usefulness to the cycle.
    weaponSpent: /already|perfect condition|beyond hope/.test(text),
    // player.kod:174 — "~I~BYou have improved in the art of %s." This is the ONLY honest count
    // of progress, and it is also the count against the cap of 10.
    improved: /you have improved in the art of/.test(text),
    text,
  };
};

// ────────────────────────────────────────────────────────────────────────────── the buff round
//
// THE REUSABLE HALF, AND IT IS LEVEL-AGNOSTIC BY CONSTRUCTION: it takes a spell name and does not
// care what level that spell is. bless and super strength at level 2, night vision and magic
// shield and free action at level 3, eagle eyes and deflect at level 4 — same code, same gates,
// because they are all PersonalEnchantments and the gate lives in persench.kod rather than in
// any of them.
//
// ONE STEP, because the targets are not knowable until the character is standing there. See the
// header. It does its own look, its own selection and its own casts, and reports what it managed.
//
// SELF FIRST, ALWAYS, AND SELF IS NEVER REFUSED. `pbCanRecastSelfEnchantment` is TRUE
// (settings.kod:80), so persench.kod:121-125 propagates rather than refusing, and CastSpell
// strips the running enchantment before restarting it (persench.kod:176-180). The caster is
// therefore an infinitely reusable target and the only one that cannot run out.
//
// THEN EVERYBODY ELSE, IN ONE PASS, AND A REFUSAL IS THE ANSWER RATHER THAN AN ERROR. There is
// no way to ask whether a bystander is already buffed — so the round asks the server, which
// answers for free. `seen` remembers who refused so the next round does not waste the
// round-trip; it is deliberately NOT persisted across runs, because a buff that expired while
// the script was not looking must be retryable.
//
// `holdMs` DEFAULTS FROM THE SPELL'S OWN DURATION rather than from a constant, because the
// spread across this school is enormous: deflect is 25-50s at spellpower 30 and night vision is
// 1125-2250s. A fixed 90s hold would re-ask a night-vision target twenty-four times for nothing
// and would make deflect wait three times longer than it needed to.
export const buffRoom = ({
  spell = 'bless', self = true, others = true, seen = new Map(),
  holdMs = null, spellPower = 30,
} = {}) => {
  const range = durationRange(spell, spellPower);
  // The FLOOR, not the ceiling: a buff rolled at the short end is re-castable then, and asking
  // again early costs one free refusal where asking late wastes the whole remainder.
  const hold = holdMs ?? (range ? range.minSec * 1000 : 90_000);

  return verify(async ({ agent, call }) => {
    const info = KRAANAN[spell];
    if (!info) return false;
    const out = { spell, self: null, cast: [], refused: [], improved: 0, roomForbidsOthers: false };

    const status = await call('status', { agent }, 30_000).catch(() => null);
    const me = status?.character ?? status?.name ?? agent;
    const mana = manaOf(status);
    if (mana != null && mana < info.mana)
      return { ok: false, why: `${spell} costs ${info.mana}, the bar reads ${mana}`, ...out };

    const tryCast = async (target, label) => {
      const r = await call('cast', { agent, spell, target }, 60_000).catch(e => ({ error: String(e) }));
      const v = readCast(r);
      if (v.improved) out.improved++;
      if (v.roomForbids) out.roomForbidsOthers = true;
      if (v.refusedByKeeper) {
        out.refused.push({ who: label, why: 'the keeper refused the cast on /action' });
        return false;
      }
      if (v.roomForbids || v.alreadyBuffed || v.spent === 0) {
        out.refused.push({ who: label, why: v.roomForbids ? 'room forbids buffing others'
                                         : v.alreadyBuffed ? 'already has it' : 'refused, nothing spent' });
        if (v.alreadyBuffed) seen.set(`${spell}:${label}`, Date.now());
        return false;
      }
      out.cast.push(label);
      seen.set(`${spell}:${label}`, Date.now());
      return true;
    };

    if (self) out.self = await tryCast(me, me);

    if (others) {
      // `look` carries every player in `objects` with `is_player` (m59-broker.mjs:18131), and it
      // carries them IN FULL however many there are — the short-list optimisation applies only to
      // inert scenery.
      const room = await call('look', { agent }, 40_000).catch(() => null);
      const bystanders = (room?.objects ?? [])
        .filter(o => o?.is_player && String(o.name ?? '').toLowerCase() !== String(me).toLowerCase());
      for (const o of bystanders) {
        const key = `${spell}:${o.name}`;
        if (seen.has(key) && Date.now() - seen.get(key) < hold) continue;
        await tryCast(o.name, o.name);
        if (out.roomForbidsOthers) break;   // it will refuse for every one of them, identically
      }
    }

    // THE ROUND SUCCEEDED IF ANYTHING WAS CAST. A round that cast nothing is not an error — it is
    // the cooldown the operator described, and it is the signal the composite loop switches on.
    return { ok: out.cast.length > 0 || out.self === true, ...out };
  }, `buff the room with ${spell}: self always (self-recast is legal, settings.kod:80), then ` +
     `everybody else once each — a bystander who already has it refuses for free. Re-ask after ` +
     `${Math.round(hold / 1000)}s, the short end of its own duration.`);
};

// ───────────────────────────────────────────────────────────────────────── the weapon cycle
//
// THE OTHER REUSABLE HALF, AND `apply` IS THE WHOLE GENERALISATION. The operator noticed that
// mend has the same shape as enchant weapon; the table says glow does too. All three refuse a
// weapon they have already been cast on, so all three need a weapon nobody has touched, and
// create weapon manufactures one for 15 mana and NO REAGENTS (creaweap.kod:55-57).
//
//   glow             level 1, inc 20   refuses a weapon already glowing
//   enchant weapon   level 2, inc 20   refuses ATCK_WEAP_MAGIC (enchwp.kod:92-96)
//   mend             level 4, inc 10   refuses hits = maxHits (mend.kod:83-89)
//
// ONE ITERATION IS TWO PRACTICE ROLLS AT TWO DIFFERENT SCHOOL LEVELS — create weapon at level 1
// and whatever `apply` is — and it feeds `1 + applyLevel` into the shared school-cast pool. With
// mend that is 5 a go, the richest single iteration in the school.
//
// THE OPERATOR'S SPEC, VERIFIED LINE BY LINE: "wait for 15 mana -> create weapon (loop waiting
// mana and casting until successfully creating a weapon), then casting 'enchant weapon' on the
// created weapon, waiting the 30s cast time for enchant, then once the created weapon has been
// successfully enchanted, drop the weapon and restart the cycle". Every number is right:
// create weapon is 15 mana and viCast_time 500 (creaweap.kod:39-41), enchant weapon is 17 mana
// and viCast_time 30000 — thirty seconds exactly (enchwp.kod:49-53). Mend is 9 mana and no cast
// time at all, which makes the mend flavour of this loop roughly three times faster per
// iteration than the enchant flavour.
//
// THE TRAP: YOU DO NOT KNOW WHAT YOU MADE. `CastSpell` picks the weapon class from
// `iNum = Random(iSpellPower/3, iSpellPower)` — mace under 20, short sword under 30, hammer
// under 45, axe under 60, long sword under 75, scimitar under 95, mystic sword above
// (creaweap.kod:63-110). So `target: 'mace'` is wrong most of the time and wrong differently as
// the caster's spellpower drifts. `observe_created: true` makes the cast report its own
// inventory delta (m59-broker.mjs:12100), and THAT is what the second cast aims at.
//
// AND `IsTargetInRange` REQUIRES IT BE YOURS: `who = Send(target,@GetOwner)` for both enchant
// weapon (enchwp.kod:76-80) and mend (mend.kod:97-101), so the weapon must be in the caster's own
// pack. It is, having just been created into it — unless the pack was full, in which case
// `ReqNewHold` fails, the weapon is DELETED and the message is `createweapon_inv_full_rsc`
// (creaweap.kod:126-129). That is why the drop matters beyond tidiness, and why created weapons
// also carry an IA_MADE timer that deletes them after `spellpower * 2` minutes on their own
// (creaweap.kod:120-123).
export const weaponCycle = ({ iterations = 4, maxMana = 65, apply = 'enchant weapon' } = {}) => {
  const spell = KRAANAN[apply];
  if (!spell || spell.kind !== 'weapon')
    return { why: 'unknown', partner: null, buy: [],
             steps: [verify(() => false,
               `"${apply}" is not a spell this file knows how to cast on a created weapon. ` +
               `Those are: ${weaponSpells().join(', ')} — each refuses a weapon it has already ` +
               `been cast on, which is why each needs the factory.`)] };

  const per = KRAANAN['create weapon'].mana + spell.mana;
  const steps = [];
  for (let i = 0; i < iterations; i++) {
    steps.push(verify(async ({ agent, call }) => {
      // 1. MAKE ONE, AND FIND OUT WHAT IT IS.
      const made = await call('cast',
        { agent, spell: 'create weapon', observe_created: true }, 60_000).catch(() => null);
      const v = readCast(made);
      if (v.refusedByKeeper)
        return { ok: false, why: 'the keeper refused create weapon — it answered on /action ' +
                                 'rather than sending, so read that keeper\'s log' };
      const weapon = (made?.created ?? []).map(c => c?.name).filter(Boolean)[0] ?? null;
      if (!weapon)
        return { ok: false, why: 'create weapon reported no new item — a full pack deletes the ' +
                                 'weapon it just made (creaweap.kod:126-129), so check bulk' };

      // 2. CAST THE ONE THING ON THE THING THAT WAS ACTUALLY MADE, and wait out its viCast_time.
      const applied = await call('cast',
        { agent, spell: apply, target: weapon }, Math.max(60_000, spell.castMs * 3)).catch(() => null);
      const a = readCast(applied);

      // 3. DROP IT WHATEVER HAPPENED. Cast on, it is spent for ever — mend leaves the weapon at
      //    `hits = maxHits`, which is the exact state mend itself refuses (mend.kod:83-89), and
      //    the enchant sets ATCK_WEAP_MAGIC. Uncast, it is still bulk, and it will delete itself
      //    out of the pack on its own IA_MADE timer regardless.
      await call('act', { agent, verb: 'drop', target: weapon }, 30_000).catch(() => null);

      return { ok: a.sent && a.spent !== 0, weapon, applied: apply, worked: a.spent !== 0,
               improved: (v.improved ? 1 : 0) + (a.improved ? 1 : 0),
               why: a.spent === 0 ? `${apply} refused on "${weapon}" and spent nothing` : undefined };
    }, `factory ${i + 1}/${iterations}: create a weapon (15 mana, no reagents), cast ${apply} ` +
       `on it${spell.castMs ? ` (${spell.castMs / 1000}s cast)` : ''}, drop it — two practice ` +
       `rolls at levels 1 and ${spell.level} per iteration`));

    if ((i + 1) % Math.max(1, Math.floor(maxMana / per)) === 0 && i + 1 < iterations) {
      steps.push(rest({ vigor: 0.9, optional: true,
                        why: `a bar buys ${Math.max(1, Math.floor(maxMana / per))} iteration(s) ` +
                             `at ${per} mana each; sit somewhere safe first` }));
      steps.push(manaAtLeast(per));
    }
  }
  return priced({
    why: `two rolls an iteration — the free factory at level 1 and ${apply} at level ${spell.level}`,
    partner: null,
    // create weapon costs NO reagents (creaweap.kod:55-57); only the applied spell does.
    buy: spell.reagents.map(([n, c]) => [n, c * iterations]),
    steps,
  });
};

// ──────────────────────────────────────────────────────────────────────── the composite loop
//
// THE OPERATOR'S LOOP, GENERALISED TO ANY LEVEL, plus the one thing added to it. His shape is:
// buff everyone → fill the cooldown with the weapon cycle → buff again. The addition is
// `stepOut`, and it is there because the cooldown that actually binds is the botting cap rather
// than the enchantments: a room change refunds 2 of 10 (player.kod:1465) and the round trip
// refunds 4, which is worth more than anything else the loop could do with those seconds.
//
// WHY THE BUFFS ARE THE BACKBONE AND THE WEAPON IS THE FILLER, in the operator's own arithmetic:
// at level 2, bless is 6 mana and super strength 10 against 32 for an enchant-weapon iteration,
// and the buffs cast instantly where the enchant takes thirty seconds. A bar of 65 buys ten
// blesses or two weapons. The weapon cycle earns its place when the room has nobody left to buff
// — which, since self-recast is legal, is never strictly true. `fillWith: 'weapon'` is therefore
// a genuine choice and `fillWith: 'self'` is the alternative the operator did not know he had.
//
// AND AT LEVEL 4 THE BALANCE FLIPS. Mend has inc 10, the worst in the school, but it has no cast
// time and its iteration is 24 mana against deflect's 20 for a single cast — and deflect's
// reagents are solagh and kriipa claw rather than anything on a bulk shelf. At level 4 the
// weapon cycle is closer to the backbone than the filler.
export const trainLevel = ({
  level = 2, rounds = 6, spells = null, maxMana = 65,
  fillWith = 'weapon', fillApply = null, fillIterations = 2,
  stepOut = null, home = 801, spellPower = 30,
} = {}) => {
  // DERIVED FROM THE LEVEL, so adding a spell to the table adds it to every level's plan.
  const buffs = spells ?? buffsAtLevel(level);
  // The weapon spell to fill with: the one at this level if there is one, else the cheapest that
  // exists — a level-3 run has no weapon spell of its own and still wants a filler.
  const fill = fillApply ?? weaponSpells(level)[0] ?? 'enchant weapon';

  if (!buffs.length)
    return { why: 'nothing to drill', partner: null, buy: [],
             steps: [verify(() => false,
               `Kraanan level ${level} has no PersonalEnchantment to drill. Levels with buffs: ` +
               `${[...new Set(Object.values(KRAANAN).filter(s => s.kind === 'buff').map(s => s.level))].join(', ')}.`)] };

  const seen = new Map();          // shared across rounds, so one refusal is not asked twice
  const steps = [];
  for (let r = 0; r < rounds; r++) {
    // FULL HEALTH IS A KRAANAN BONUS AND NOT HOUSEKEEPING: the secondary spellpower term is
    // `(health*10)/maxHealth` (spell.kod:2171-2172), so a hurt caster casts shorter buffs.
    steps.push(rest({ health: 0.95, vigor: 0.9, optional: true,
                      why: 'Kraanan spellpower reads hit points — spell.kod:2171-2172' }));
    for (const spell of buffs) steps.push(buffRoom({ spell, seen, spellPower }));

    if (r + 1 >= rounds) break;

    if (fillWith === 'weapon')
      steps.push(...weaponCycle({ iterations: fillIterations, maxMana, apply: fill }).steps);
    else
      steps.push(manaAtLeast(Math.max(...buffs.map(s => KRAANAN[s].mana))));

    if (stepOut != null) {
      // Two room changes, 2 advancement points refunded each (player.kod:1465). `optional`
      // because a blocked exit must not unwind the casts already made.
      steps.push(walk(stepOut, { optional: true, why: 'refund 2 against the botting cap' }));
      steps.push(walk(home, { optional: true, why: 'and 2 more coming back — 4 of a cap of 10' }));
    }
  }

  return priced({
    why: `the operator's loop at level ${level}: buff the room, fill the cooldown, buff again ` +
         '— with a step out, because the cooldown that binds is the botting cap',
    partner: null,
    buy: buffs.flatMap(s => KRAANAN[s].reagents.map(([n, c]) => [n, c * rounds]))
      .concat(fillWith === 'weapon'
        ? KRAANAN[fill].reagents.map(([n, c]) => [n, c * rounds * fillIterations])
        : []),
    steps,
  });
};

// The operator's level-2 set by name, as a thin wrapper. Kept because "bless and super strength,
// filled with enchant weapon" is a specific plan he asked for, and `buffsAtLevel(2)` also returns
// haste and resist poison, which he deliberately did not name.
export const trainLevel2 = (opts = {}) =>
  trainLevel({ level: 2, spells: OPERATOR_TRIPLE.filter(s => KRAANAN[s].kind === 'buff'),
               fillApply: 'enchant weapon', ...opts, });

// ─────────────────────────────────────────────────────────── one spell on its own, for pricing
//
// A plain loop for a single spell, for when the question is "what does drilling just bless cost".
// It is deliberately NOT the recommended path — see `trainLevel` — because a lone self-recast
// loop hits the cap of 10 improves and then keeps paying full price for nothing.
export const drill = (spell, { casts = 20, maxMana = 65, target = null } = {}) => {
  const info = KRAANAN[spell];
  if (!info)
    return { why: 'unknown', partner: null, buy: [],
             steps: [verify(() => false, `no Kraanan spell named "${spell}" in this table`)] };
  // A weapon spell drilled alone is the factory loop, not a cast loop: it needs a fresh weapon
  // per cast and there is no other way to get one.
  if (info.kind === 'weapon') return weaponCycle({ iterations: casts, maxMana, apply: spell });

  const per = castsPerBar(maxMana, info.mana);
  const steps = [];
  for (let i = 0; i < casts; i++) {
    // `force` is deliberately NOT passed: the cast tool checks karma, mana and reagents first
    // and refuses with the reason rather than spending the attempt.
    steps.push(act('cast', target ? { spell, target } : { spell },
                   { optional: true, why: `practice ${i + 1}/${casts}` }));
    if ((i + 1) % per === 0 && i + 1 < casts) {
      steps.push(rest({ vigor: 0.9, optional: true,
                        why: `a bar of mana buys ${per} cast(s); sit somewhere safe first` }));
      steps.push(manaAtLeast(info.mana));
    }
  }
  return priced({
    why: `${casts} casts of ${spell} at ${info.mana} mana, inc ${info.inc}`,
    partner: info.targets > 0 && !target ? 'a target — this spell takes one' : null,
    buy: info.reagents.map(([n, c]) => [n, c * casts]),
    steps,
  });
};

// DERIVED FROM THE TABLE, so a spell added to KRAANAN is drillable without touching this.
export const PRACTICE = Object.freeze(Object.fromEntries(
  Object.entries(KRAANAN)
    .filter(([, s]) => s.kind === 'buff' || s.kind === 'weapon' || s.kind === 'factory')
    .map(([name]) => [name, (p = {}) =>
      drill(name, { casts: p.casts ?? 20, maxMana: p.maxMana ?? 65,
                    target: p.target ?? p.patient ?? null })])));

// WHAT A LONE CASTER CAN DRILL WITH NOBODY ELSE PRESENT.
//
// NOTE WHAT THIS ANSWERS AND WHAT IT DOES NOT. Every Kraanan buff reports `targets: 1`, so the
// usual test — "does it need a target" — marks all of them un-drillable and is WRONG: the target
// may be the caster, for ever, because self-recast is legal. The property that matters is
// whether the spell can be aimed at the caster, which is what this reads.
const aimableAtSelf = (s) =>
  // A PersonalEnchantment: gated on the target not already having it, EXCEPT when the target is
  // the caster (persench.kod:121-125). The gate column says so in words, and this reads it.
  /unless it is you/.test(s.gate ?? '') ||
  // Or it needs no target at all and nothing else gates it — create weapon, create food.
  (s.gate === null && s.targets === 0);

export const selfTargetable = (level = null) =>
  Object.entries(KRAANAN)
    .filter(([, s]) => (level === null || s.level === level) && aimableAtSelf(s))
    .sort((a, b) => b[1].inc - a[1].inc)
    .map(([n, s]) => ({ spell: n, level: s.level, mana: s.mana, inc: s.inc, reagents: s.reagents }));

export const script = {
  name: 'practice-kraanan',
  provenance: {
    pinned: '83c6188', verified: '2026-09-19',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-broker.mjs', 'tools/m59-rts-safety.mjs'],
  },
  describe: 'Drill any level of Kraanan by buffing the room, filling the cooldown with a weapon.',
  recipe: {
    effect: 'Raises Kraanan abilities at a chosen level by buffing the caster and every player ' +
            'in the room, and spending the interval between rounds on the create-weapon factory. ' +
            'Both engines are level-agnostic: the buff round drills any PersonalEnchantment ' +
            '(bless and super strength at 2; night vision, magic shield and free action at 3; ' +
            'eagle eyes and deflect at 4) and the weapon cycle drills anything that refuses a ' +
            'weapon it has already touched (glow at 1, enchant weapon at 2, mend at 4). The gate ' +
            'for the next level reads the best THREE abilities at this one, and the school-cast ' +
            'bonus is shared across the whole school, so spreading costs nothing against ' +
            'grinding one spell.',
    run: 'practice-kraanan agents=<who> [level=<n>] [spell=<name>] [rounds=<n>] [maxMana=<n>]',
    needs: ['the spells already known — this drills, it does not teach',
            'room 801, the Temple of Kraanan: +10% on the secondary roll (tempkra.kod:283-294) ' +
            'and one of the few rooms with footfall that is not ROOM_NO_COMBAT',
            'reagents, which differ per level — `buy` prices any plan before it is driven. Note ' +
            'that level 4 leaves the bulk shelves: deflect wants solagh and kriipa claw.',
            'mana: the loop rests at the end of every bar, sized from maxMana'],
    cost: { time: 'buffs are instant to 3s; an enchant-weapon iteration is ~30.5s (viCast_time ' +
                  '30000), a mend iteration ~0.5s — mend is the fast flavour of the same loop',
            money: 'level 2: mushrooms, sapphires, orc teeth. Level 3: mushrooms, elderberries, ' +
                   'red and purple mushrooms. Level 4: solagh and kriipa claw for deflect, ' +
                   'sapphire and orc tooth for mend. Create weapon is free.',
            risk: 'none in a temple — no Kraanan spell needs an enemy and none turns you outlaw. ' +
                  'Kraanan asks NO KARMA at all (spell.kod:483-496), unlike Shal\'ille.',
            measured: 'NOT MEASURED. Every number in this file is read out of kod and cited, but ' +
                      'no run has been driven: the RTS allowlist that blocked every targeted ' +
                      'cast was retired 2026-09-19 and nothing has been put through it since.' },
    scales: 'The ceiling is 10 SUCCESSFUL IMPROVES per 15-22 minutes (ADVANCEMENT_LIMIT ' +
            'player.kod:68, ADVANCE_TIMER player.kod:66-67), charged only when an ability ' +
            'actually rose (player.kod:6783-6786). A room change refunds 2, so stepping out and ' +
            'back is worth 4 — more than any cast is worth in the same seconds. Casting while ' +
            'capped is worse than idling: it also halves the school-cast bonus ' +
            '(player.kod:6271-6274).',
    notes: ["THE FIRST SPELL AT ANY LEVEL ABOVE 2 IS THE ONLY ONE THAT COSTS ANYTHING. " +
            "PlayerCanLearn returns SUCCESS outright once the character knows one spell at the " +
            "target level (player.kod:10626-10641), so after buying one level-3 Kraanan spell " +
            "the rest of level 3 unlocks with no further practice. Drilling past that is waste.",
            "Self-recast is LEGAL — pbCanRecastSelfEnchantment TRUE (settings.kod:80), honoured " +
            "at persench.kod:121-125 — so the caster is an inexhaustible target and the " +
            "'cooldown' applies only to bystanders.",
            "Buffing anyone but yourself is refused outright in the 67 permanently-safe rooms " +
            "(persench.kod:107-114, ROOM_NO_COMBAT 0x0002), which is every inn and shop: the " +
            "rooms with the most footfall are exactly the ones where this half cannot run.",
            "Durations rise steeply with level and that is a COST, not a benefit: a bystander " +
            "wearing night vision (1125-2250s at spellpower 30) is spent for the session, while " +
            "deflect (25-50s) is genuinely reusable. buffRoom re-asks after the SHORT end of " +
            "each spell's own duration rather than after a fixed wait.",
            "A created weapon is ALWAYS below full hits — creaweap.kod:112-114 multiplies by " +
            "(spellpower+100)/200 and SPELLPOWER_MAXIMUM is 99 — which is what makes mend " +
            "drillable on it. And mend sets maxHits AND hits to 75-95% of the old max, leaving " +
            "the weapon at perfect condition, which is the state mend itself refuses: one mend " +
            "per weapon, always, so the cycle must make a fresh one every time.",
            "Kraanan's spellpower rises with the number of active holders in the room " +
            "(spell.kod:2168-2170) and with the caster's health fraction.",
            "The requisite stat is STAMINA, not Mysticism (spell.kod:392-404), and the soft cap " +
            "at 2*stamina-1 ability divides the chance by 4 (spell.kod:21,1750-1753). A " +
            "Shal'ille-shaped character is not a Kraanan-shaped one."],
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'who is practising' },
    level: { type: 'number', default: 2,
             describe: 'which school level to drill — 2, 3 or 4 all have a buff set' },
    spell: { type: 'string', default: null,
             describe: 'one spell on its own; omit for the composite buff/weapon loop' },
    rounds: { type: 'number', default: 6, describe: 'buff rounds in the composite loop' },
    casts: { type: 'number', default: 20, describe: 'attempts to plan when drilling one spell' },
    maxMana: { type: 'number', default: 65,
               describe: "the caster's mana ceiling; sizes the rest interval. Read it from a " +
                         'settled keeper, not a fresh login — ComputeMaxMana re-sums the node ' +
                         'bitmask on every login and a just-joined session reads low' },
    fillWith: { type: 'string', default: 'weapon',
                describe: "'weapon' runs the create/apply factory between rounds; 'self' just " +
                          'waits for mana and re-buffs the caster, which self-recast makes legal' },
    fillApply: { type: 'string', default: null,
                 describe: 'which spell the factory casts on its weapon — glow, enchant weapon ' +
                           'or mend. Defaults to the one at the level being drilled.' },
    fillIterations: { type: 'number', default: 2, describe: 'weapon iterations per cooldown' },
    spellPower: { type: 'number', default: 30,
                  describe: "estimate of the caster's spellpower; sets how long buffRoom waits " +
                            'before re-asking a bystander. Half a spell ability plus the room ' +
                            'crowd and the health fraction (spell.kod:2093,2168-2172).' },
    home: { type: 'number', default: 801,
            describe: 'where to stand: 801 is the Temple of Kraanan, +10% on the secondary roll' },
    stepOut: { type: 'number', default: null,
               describe: 'a neighbouring room to step to between rounds; each change refunds 2 ' +
                         'of the cap of 10. Null disables the refund entirely.' },
    target: { type: 'string', default: null, describe: 'for a single-spell drill: who to aim at' },
  },
  async steps(p) {
    if (!p.spell) return trainLevel(p).steps;
    const key = String(p.spell).toLowerCase();
    const make = PRACTICE[key] ?? PRACTICE[Object.keys(PRACTICE).find(k => k.startsWith(key)) ?? ''];
    if (!make)
      return [verify(() => false,
        `no practice function for "${p.spell}". Drillable: ${Object.keys(PRACTICE).join(', ')}. ` +
        `Omit spell= entirely for the composite loop, which is what this script is for.`)];
    return make(p).steps;
  },
};
