#!/usr/bin/env node
// THE COMBAT LOG IS A VERIFICATION INSTRUMENT — read the sentence, learn the resistance.
//
//   node tools/m59-resistance.mjs "The ghost of Far'Nohl laughs off your pitiful blow."
//
// When a blow lands on something with a resistance to that damage type, the server picks one
// of four sentences by BAND (`MsgPlayerHitResisted`, player.kod:9686). The sentence is therefore a measurement of
// the target's resistance to the damage you just dealt — and it is available to any player,
// with no maintenance socket and nothing to read off an object.
//
// ============================================================================
// WHY THIS MATTERS MORE THAN IT LOOKS
// ============================================================================
//
// The server never renames an enchanted weapon. `inEffect()` therefore answers UNKNOWN for
// weapon scope, `client.equipment()` reports names with no object id, and two swords called
// "long sword" — one dedicated, one not — are indistinguishable from anything a prod-safe read
// can reach. That is the exact hole that let 17 raiders report a completed action phase
// against a boss that finished on 233 of 233 health.
//
// But the thing you cannot read, you can HEAR. Against the ghost of Far'Nohl
// (ghost.kod:87-88, `[90, ATCK_WEAP_NONMAGIC]` and `[-50, ATCK_WEAP_MAGIC]`) the two states
// are different sentences:
//
//     mundane weapon   resistance  90  ->  "laughs off your pitiful blow"
//     dedicated weapon resistance -50  ->  "staggers backwards from the blow"
//
// One swing distinguishes them. The unreadable flag and the readable sentence are the same
// mechanic seen from two sides — which makes a single attack the cheapest and most
// authoritative `holds` available for "is this weapon actually enchanted", and unlike the
// maintenance-socket read it works on prod. Thanks to the FleetScratch session for the
// observation; the bands below are read out of kod rather than taken on trust.
//
// ============================================================================
// THE LADDER
// ============================================================================
//
// MAX_RESISTANCE = 100 and MIN_RESISTANCE = -100 (blakston.khd:1521, :1523), and
// MsgPlayerHitResisted picks on fifths of them:
//
//          r >  60          player_hit_immunity       "laughs off your pitiful blow."
//     20 < r <= 60          player_hit_resisted       "shrugs off your attack."
//    -20 < r <= 20          (no message at all — an ordinary hit)
//    -60 < r <= -20         player_hit_anti_resisted  "staggers backwards from the blow."
//          r <= -60         player_hit_anti_immunity  "convulses and seems to be suffering badly."
//
// WRITTEN AS INEQUALITIES ON PURPOSE, because the two endpoints are decided by the ORDER of
// the tests rather than by the constants, and a range table is ambiguous at exactly the values
// a careless reading gets wrong:
//
//   * -60 is "convulses", NOT "staggers": the negative branch tests `<= (3*MIN/5)` FIRST.
//   * 60 is "shrugs off", NOT "laughs off": the positive branch tests `> (3*MAX/5)` first, and
//     60 is not greater than 60.
//   * 20 produces NO MESSAGE: the outer guard is `> (MAX/5)`, which 20 fails, and the negative
//     outer guard `<= (MIN/5)` it fails too.
//
// Nothing in the ghost fight turns on those three values — 90 and -50 are nowhere near them —
// but anyone applying this table to another monster would be wrong at precisely them. The test
// checks all 201 values against the kod predicate written out separately, which is how the
// first two were caught in this file.
//
// A NEGATIVE RESISTANCE IS A VULNERABILITY: the anti- bands mean you are doing MORE damage,
// not less. Reading "staggers backwards" as bad news is the obvious mistake here.
// ============================================================================
// THERE ARE TWO LADDERS AND THEY ARE NOT THE SAME. READ THE HANDLER NAME.
// ============================================================================
//
// `MsgPlayerHitResisted` (player.kod:9686) — "if the person HIT has a resistance". These are
// the sentences about the THING YOU ARE HITTING, and they are what this module decodes:
//
//     laughs off your pitiful blow / shrugs off your attack /
//     staggers backwards from the blow / convulses and seems to be suffering badly
//
// `MsgPlayerResistsHit` (player.kod:9732) — "if THEY have a resistance", meaning YOURS, when
// something hits you. Entirely different sentences (player.kod:214-218):
//
//     Mysteriously, you feel almost no pain! / Much of the pain fades away. / ...
//
// AND THE THRESHOLDS DIFFER, which is the trap. The first splits at 3/5 of the extremes and
// tests `>` and `<=`; the second splits at 2/3 and tests `>` and `<` (:9746, :9755-9758). So
// the bands below are wrong if applied to the other family's sentences — not slightly wrong,
// wrong at different numbers. Decode the sentence, never "a resistance message".
export const MAX_RESISTANCE = 100;    // blakston.khd:1521
export const MIN_RESISTANCE = -100;   // blakston.khd:1523

/** Ordered worst-for-you first. `min`/`max` bound the target's resistance to what you dealt. */
export const RESISTANCE_BANDS = Object.freeze([
  { band: 'immune', re: /laughs off your pitiful blow/i,
    min: MAX_RESISTANCE * 3 / 5, max: MAX_RESISTANCE, exclusive_min: true,
    means: 'this damage type is nearly useless against it',
    cites: 'player.kod:208, selected at :9703' },
  { band: 'resisted', re: /shrugs off your attack/i,
    min: MAX_RESISTANCE / 5, max: MAX_RESISTANCE * 3 / 5, exclusive_min: true,
    means: 'resisted, but it is landing something',
    cites: 'player.kod:209, selected at :9707' },
  // EXCLUSIVE AT -60, because kod tests `resistance <= (3*MIN_RESISTANCE/5)` FIRST and sends
  // anti_immunity for it (:9715). Exactly -60 is "convulses", not "staggers".
  { band: 'vulnerable', re: /staggers backwards from the blow/i,
    min: MIN_RESISTANCE * 3 / 5, max: MIN_RESISTANCE / 5, exclusive_min: true,
    means: 'NEGATIVE resistance — you are doing extra damage with this type',
    cites: 'player.kod:210, selected at :9719' },
  { band: 'helpless', re: /convulses and seems to be suffering badly/i,
    min: MIN_RESISTANCE, max: MIN_RESISTANCE * 3 / 5,
    means: 'the best case — deeply vulnerable to this damage type',
    cites: 'player.kod:211, selected at :9715' },
]);

/**
 * Which band does this sentence report, if any? `null` for every other line in the log —
 * an ordinary hit prints no resistance message at all, so silence is genuinely uninformative
 * rather than evidence of a neutral resistance.
 */
export function bandOfLine(line) {
  const s = String(line ?? '');
  for (const b of RESISTANCE_BANDS) if (b.re.test(s)) return b;
  return null;
}

/** The first resistance verdict in a transcript, or null if nothing in it said anything. */
export function bandOfLines(lines = []) {
  for (const l of lines) { const b = bandOfLine(l); if (b) return b; }
  return null;
}

/**
 * DID THAT BLOW LAND AS MAGIC? true / false / null, against a target whose resistance table
 * separates the two — which is the common shape for undead and for most bosses.
 *
 * `resistNonMagic` and `resistMagic` come from the creature's own `plResistances`; for the
 * ghost of Far'Nohl they are 90 and -50 (ghost.kod:87-88). The answer is only as good as the
 * bands being DISTINGUISHABLE: if both values fall in the same band the sentence cannot tell
 * them apart, and this says so by answering null rather than guessing.
 */
export function blowLandedAsMagic(lines, { resistNonMagic, resistMagic } = {}) {
  if (!Number.isFinite(resistNonMagic) || !Number.isFinite(resistMagic)) return null;
  const bandFor = r => RESISTANCE_BANDS.find(b =>
    (b.exclusive_min ? r > b.min : r >= b.min) && r <= b.max)?.band ?? 'neutral';
  const nonMagicBand = bandFor(resistNonMagic);
  const magicBand = bandFor(resistMagic);
  if (nonMagicBand === magicBand) return null;        // the log cannot separate them here
  const heard = bandOfLines(lines);
  if (!heard) return null;                            // nothing in the transcript said anything
  if (heard.band === magicBand) return true;
  if (heard.band === nonMagicBand) return false;
  return null;
}

// ============================================================================
// PREDICTING A BAND FROM A RESISTANCE LIST: NEVER READ ONE ENTRY AND STOP
// ============================================================================
//
// `GetResistance` (battler.kod:195-249) walks the WHOLE list, keeps the largest and smallest
// matching values — both starting at NO_RESISTANCE 0 (blakston.khd:1522) — clips them to
// +/-100, and returns **iMaxRes + iMinRes**. So two matching entries can cancel: a target with
// [20, ATCK_WEAP_SLASH] and [-20, ATCK_WEAP_SLASH] has an effective slash resistance of ZERO,
// not 20 and not -20.
//
// AND THE SIGN OF THE SECOND ELEMENT SELECTS A NAMESPACE, it is not notation. battler.kod:201
// `if iResType > 0` takes the weapon branch; :223 flips the sign for the spell branch. It HAS
// to work that way, because the two bitmask spaces are numerically identical — ATCK_WEAP_MAGIC
// 0x4 IS ATCK_SPELL_SHOCK 0x4, ATCK_WEAP_THRUST 0x40 IS ATCK_SPELL_ACID 0x40, ATCK_WEAP_SLASH
// 0x80 IS ATCK_SPELL_QUAKE 0x80, ATCK_WEAP_ALL 0x1 IS ATCK_SPELL_ALL 0x1 (blakston.khd:1742-1780).
// Nothing but the sign distinguishes them, so a missing minus does not mistype an entry — it
// moves it into the other namespace. The FleetScratch session surveyed all 253 pairs in the
// tree and found four such entries, all in the Ice Peryton (iceper.kod:154, :155, :158, :159);
// two of them collide with real weapon entries in the same list and cancel them to zero.
export const ATCK = Object.freeze({
  WEAP_ALL: 0x00001, WEAP_MAGIC: 0x00004, WEAP_BLUDGEON: 0x00010,
  WEAP_PIERCE: 0x00020, WEAP_THRUST: 0x00040, WEAP_SLASH: 0x00080,
  SPELL_ALL: 0x0001, SPELL_FIRE: 0x0002, SPELL_SHOCK: 0x0004, SPELL_COLD: 0x0008,
  SPELL_HOLY: 0x0010, SPELL_UNHOLY: 0x0020, SPELL_ACID: 0x0040, SPELL_QUAKE: 0x0080,
});
export const NO_RESISTANCE = 0;   // blakston.khd:1522

/**
 * The effective resistance of a creature to one blow — a faithful port of battler.kod's
 * GetResistance, including the max+min rule and the ATCK_*_ALL match-anything branches.
 *
 * `entries` is the creature's own `plResistances` as [value, type] pairs, with the kod's sign
 * convention preserved: POSITIVE type = weapon, NEGATIVE type = spell.
 */
export function effectiveResistance(entries = [], { atype = 0, aspell = 0 } = {}) {
  let max = NO_RESISTANCE, min = NO_RESISTANCE;
  for (const entry of entries) {
    const value = Number(entry?.[0]), type = Number(entry?.[1]);
    if (!Number.isFinite(value) || !Number.isFinite(type)) continue;
    const matched = type > 0
      ? ((atype & type) !== 0 || (atype !== 0 && type === ATCK.WEAP_ALL))
      : ((aspell & -type) !== 0 || (aspell !== 0 && -type === ATCK.SPELL_ALL));
    if (!matched) continue;
    if (value > max) max = value;
    if (value < min) min = value;
  }
  return Math.min(max, MAX_RESISTANCE) + Math.max(min, MIN_RESISTANCE);
}

/**
 * Damage after resistance (battler.kod:258 and :262). 90 leaves a tenth, -50 deals one and a
 * half: the fifteenfold swing between a mundane and a dedicated weapon, and the whole argument
 * for the prep phase.
 *
 * ONE BRANCH, NOT TWO. kod spells it twice, but `MIN_RESISTANCE + value` is exactly
 * `-(MAX_RESISTANCE - value)` when the constants are +/-100, so the negative form negates BOTH
 * numerator and denominator and `(-a)/(-b)` is `a/b` under every rounding convention. Verified
 * rather than argued: all 100,701 damage x resistance pairs, both spellings, under truncation
 * and under floor — ZERO disagreements. The equivalence is exact, not approximate, which is
 * worth stating because integer division is exactly where a reader expects two spellings of one
 * formula to drift. (The FleetScratch session's correction; I had shipped a hedge against a
 * divergence that cannot happen.)
 *
 * AND IT TRUNCATES, because blakod divides as integers. That is the part I had wrong in a way
 * the hedge distracted from: returning a float disagrees with the server on 94,800 of those
 * same pairs — `damageAfterResistance(1, -99)` is 1 in kod and was 1.99 here. Damage is never
 * negative and the sign cancels, so truncation and floor agree and either spelling is safe.
 */
export function damageAfterResistance(damage, value) {
  return Math.trunc(damage * (MAX_RESISTANCE - value) / MAX_RESISTANCE);
}

/**
 * WHAT ACTUALLY REACHES THE TARGET — `AssessDamage`, not `GetDamageFromResistance`.
 *
 * THE TWO ARE NOT THE SAME FUNCTION AND THE DIFFERENCE IS OPERATIONAL. The scaling above
 * really does return 0 for a small blow against a high resistance, but **0 never reaches
 * anybody**: the caller clamps it. monster.kod:1561-1562 is `% Always do a minimum of one
 * point of damage.` / `iDamage = Bound(iDamage,1,$)`, and player.kod:4597-4600 is the same
 * clamp spelled `if NOT absolute and damage <= 0 { damage = 1; }`.
 *
 * So a mundane weapon against the ghost of Far'Nohl is a STALEMATE, not an impossibility —
 * one point a swing, every swing. The operational consequence is the opposite of the obvious
 * one: DO NOT PULL A MUNDANE-WEAPON RAIDER OUT OF THE ROOM. It is doing damage, and more
 * importantly it is holding aggression off the healers. Fix the weapon, do not withdraw the
 * body. (The FleetScratch session's catch: I had read the 0 out of the scaling function and
 * called the fight unwinnable, which is the one conclusion that does not survive the citation.)
 *
 * `bonus` IS ADDED AFTER THE RESISTANCE SCALING, which would make attack-modifier damage
 * bypass resistance entirely — worth ten times its face value against a 90% resistance
 * (monster.kod:1556; player.kod:4581, whose own comment is `% Add attmods AFTER
 * resistance/suscep mods.`). MODELLED HERE BUT NOT REACHABLE IN THIS TREE: all 39
 * `@AssessDamage` call sites pass no bonus, the generic melee path at battler.kod:338 included,
 * and the two subclass overrides (lich.kod:312, lupking.kod:106) only track attackers and
 * propagate. So the parameter is always 0 today. It is modelled because the rule is real and
 * would matter enormously the day something supplies one — not because a raid can use it now.
 */
export function damageDelivered(damage, value, { bonus = 0, absolute = false } = {}) {
  const scaled = absolute ? damage : damageAfterResistance(damage, value);
  const withBonus = scaled + bonus;
  return absolute ? withBonus : Math.max(1, withBonus);
}

/** The ghost of Far'Nohl's table, since it is the one this fleet keeps fighting. */
export const GHOST_OF_FARNOHL = Object.freeze({
  resistNonMagic: 90, resistMagic: -50,
  // ghost.kod:83-89, one entry per line, in this order:
  //   :83 [ 90, -ATCK_SPELL_FIRE]    :84 [ 90, -ATCK_SPELL_COLD]
  //   :85 [ 90, -ATCK_SPELL_UNHOLY]  :86 [ 90, -ATCK_SPELL_ACID]
  //   :87 [ 90,  ATCK_WEAP_NONMAGIC] :88 [-50,  ATCK_WEAP_MAGIC]
  //   :89 [-50, -ATCK_SPELL_HOLY]
  // The leading minus on the SPELL types is part of the type encoding, not a negative
  // resistance — the resistance is the first element of the pair.
  cites: 'ghost.kod:87-88 (weapons); :83-86 elemental spells; :89 holy',
  // The same list also carries 90 against fire, cold, unholy and acid spells (:83-86) and -50
  // against HOLY (:89) — so a fire caster is as wasted as a mundane sword, and holy is the
  // school that works. Not used by the weapon check, but it is the same measurement.
  resistHolySpell: -50, resistElementalSpell: 90,
});

if (process.argv[1] && process.argv[1].endsWith('m59-resistance.mjs')) {
  const line = process.argv.slice(2).join(' ').trim();
  if (line) {
    const b = bandOfLine(line);
    if (!b) { console.log('no resistance verdict in that line — an ordinary hit says nothing'); process.exit(0); }
    console.log(`${b.band}: resistance ${b.exclusive_min ? '>' : '>='} ${b.min} and <= ${b.max}`);
    console.log(`  ${b.means}`);
    console.log(`  ${b.cites}`);
    process.exit(0);
  }
  console.log('WHAT A BLOW TELLS YOU ABOUT WHAT YOU ARE HITTING\n');
  for (const b of RESISTANCE_BANDS)
    console.log(`  ${b.band.padEnd(11)} ${String(b.exclusive_min ? '>' : '>=').padStart(2)} ${String(b.min).padStart(4)} ` +
                `.. ${String(b.max).padStart(4)}   ${b.means}\n  ${' '.repeat(11)} ${b.cites}`);
  console.log('\nAgainst the ghost of Far\'Nohl (ghost.kod:87-88): a mundane weapon is resisted at 90');
  console.log('and reads "laughs off your pitiful blow"; a dedicated one is -50 and reads');
  console.log('"staggers backwards from the blow". One swing tells you which you are holding.');
}
