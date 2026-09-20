// WHICH CREATURES APPLY AN AILMENT, TAKEN FROM THE GAME'S SOURCE AND NOT FROM THEIR NAMES.
//
//   import { POISONS, poisons, AILMENT_SOURCE } from './m59-ailments.mjs';
//   poisons('baby spider')  ->  false
//   poisons('dusk rat')     ->  true
//
// WHY THIS IS A LIST AND NOT A REGEX. Every safe-wall measurement in this repository has to
// keep poison out of its damage column, because a tick reaches a body through any geometry
// ever built and makes a perfect wall look like it leaked. The exclusion was written as
// `/spider/i`, on the reasoning that spiders are the poisoners. It was wrong in BOTH
// directions at once, and only one of them was safe:
//
//   MISSED A REAL POISONER. `DuskRat` (duskrat.kod) applies SID_POISON in HitSideEffect and
//   is called "dusk rat". No regex about spiders will ever match it, so its ticks were
//   landing in the violation column as though they were blows that got through a wall.
//   That is the dangerous direction: it manufactures counterexamples.
//
//   EXCLUDED SOMETHING HARMLESS. "baby spider" is `SpiderBaby`, and SpiderBaby is Monster —
//   it does not extend Spider and carries no HitSideEffect at all. Its blows are ordinary
//   attacks, and throwing them away only cost evidence. The operator caught this one:
//   "Baby spiders don't poison."
//
// THE LESSON IS THE SHAPE, not the two names. A creature's DISPLAY NAME is a resource
// string; what it does is its class. `spider_name_rsc = "spider"` and
// `DeathSpider_name_rsc = "black spider"` are siblings by behaviour and unrelated by text,
// while "baby spider" reads like a spider and inherits nothing from one. Matching on text
// was guessing at the class hierarchy from the outside.
//
// DERIVED, AND THE TEST RE-DERIVES IT. m59-ailments-test.mjs walks the kod tree, finds every
// class whose `HitSideEffect` sends SID_POISON/MakePoisoned, reads its `*_name_rsc`, and
// asserts the result equals this list. So a monster added to the game, or one whose poison
// is removed, fails the test rather than silently changing what the fleet believes.

/** Where each fact came from, so a reader can check it without trusting this file. */
export const AILMENT_SOURCE = Object.freeze({
  kod_root: 'kod/object/active/holder/nomoveon/battler/monster',
  rule: 'a class applies poison when its HitSideEffect() sends SID_POISON via MakePoisoned',
  checked: '2026-09-20',
});

/**
 * Display name -> the kod class that carries the poison, for every creature that poisons.
 * Names are exactly the `*_name_rsc` strings the server sends, lowercased.
 */
export const POISONS = Object.freeze({
  'spider':       'Spider',        // spider.kod      POISON_CHANCE 30
  'black spider': 'DeathSpider',   // dethspid.kod
  'queen spider': 'SpiderQueen',   // spdrquen.kod
  'dusk rat':     'DuskRat',       // duskrat.kod     — NOT a spider, and the one a name match missed
});

/** Creatures whose names invite a false positive. Listed so the test can pin them. */
export const NAMED_LIKE_A_POISONER_BUT_IS_NOT = Object.freeze({
  'baby spider': 'SpiderBaby',     // spdrbaby.kod — `SpiderBaby is Monster`, no HitSideEffect
});

const NAMES = new Set(Object.keys(POISONS));

/**
 * Does this creature apply poison?
 *
 * Exact on the display name, after lowercasing and trimming. NOT a substring test: "baby
 * spider" contains "spider" and does not poison, which is the whole reason this exists.
 * An unknown name answers FALSE, because the question this gates is "may I count this
 * damage as an attack" and the list is complete as of AILMENT_SOURCE.checked — a creature
 * nobody has heard of is far more likely to be new than to be a missing poisoner, and the
 * test is what keeps that true.
 */
export function poisons(name) {
  return NAMES.has(String(name ?? '').trim().toLowerCase());
}

/** The same question for a whole scene: does anything here poison? */
export const anyPoisons = (names = []) => names.some(poisons);
