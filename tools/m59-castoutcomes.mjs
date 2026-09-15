#!/usr/bin/env node
// HOW A CAST FAILS, IN THE SERVER'S OWN WORDS — the failures-only table, with citations.
//
//   node tools/m59-castoutcomes.mjs                  the table, and what each one means
//   node tools/m59-castoutcomes.mjs "..."            classify one sentence
//
// FAILURE IS A CLOSED SET AND SUCCESS IS NOT. Every spell announces success in its own words
// ("Your scimitar is now dedicated to Kraanan.", "%s%s eyes pulse briefly.", and thirty-five
// more), and there is no enumerating those. But the ways a cast fails are generic, live in
// two files, and read the same for all of them. So this table is failures and neutrals only,
// and a cast that paid in full without matching one of them landed.
//
// WHY IT IS A SEPARATE MODULE. It was written inside m59-fleetscript.mjs, whose header is
// already 155 lines — 77 of them a mana-node narrative with two same-day retractions, sitting
// in the header of a compiler because there was nowhere else to put it. Adding sixty more
// lines of spell lore to that file while arguing that scratchpads exist to stop exactly this
// would be funny in the wrong way.
//
// WHY IT EXISTS AT ALL. `castVerified` used to decide from the COST: mana gone or reagents
// moved meant it landed. That is wrong for every spell with a casting trance, and wrong in
// the direction that does real damage — it reports SUCCESS for a cast that did nothing.
// Measured on the shadow fleet 2026-09-11: three casters, three reported successes, zero
// enchanted weapons, and a raid that set off at a boss resisting mundane weapons by 90%
// believing three of its weapons were magic. The server had said otherwise every time.

/**
 * THE ANATOMY OF A CASTING TRANCE, because three of the entries below only make sense with it.
 *
 * A spell with `viCast_time` takes its mana and reagents UP FRONT and then freezes the caster
 * (trance.kod). `enchant weapon` is thirty seconds (enchwp.kod:52, `viCast_time = 30000`).
 * kod raises a break on EVENT_RUN, EVENT_REST, EVENT_USE, EVENT_ATTACK, EVENT_CAST,
 * EVENT_DAMAGE and EVENT_NEWOWNER — running, resting, using or eating anything, swinging,
 * casting again, being hit, or changing room. A broken trance refunds about HALF the mana and
 * none of the reagents, which is why reading the cost sees a partial spend and misreads it as
 * a bad roll. It is not a bad roll. It has a different fix.
 *
 * 16 of the 37 buffs in this game carry a trance; `node tools/m59-buffs.mjs` lists them with
 * `cast_time_ms`.
 */
export const TRANCE_BREAK_EVENTS = Object.freeze([
  'EVENT_RUN', 'EVENT_REST', 'EVENT_USE', 'EVENT_ATTACK',
  'EVENT_CAST', 'EVENT_DAMAGE', 'EVENT_NEWOWNER',
]);

/**
 * Every entry carries `cites` — the kod file and line the sentence is defined at — because
 * the bar in this repository is that a number is read from source rather than remembered.
 * `retryable` is the operational half: it is the only field a caller has to branch on.
 */
export const CAST_OUTCOMES = Object.freeze([
  {
    outcome: 'interrupted', retryable: true,
    re: /concentration is broken and the .* fizzles/i,
    why: 'the casting trance was interrupted before it finished',
    cites: 'spell.kod:126 spell_trance_break; trance.kod BreakTrance',
    note: 'HALF the mana comes back and the reagents do not. On this fleet the interrupter ' +
          'was usually our own keeper: the cast drops ~19 vigor, that put the caster under ' +
          'its `vigorFloor`, and the keeper sat it down to recover — EVENT_REST, three rest ' +
          'packets suppressed in a single cast once the Pacer hold was measuring them.',
  },
  {
    outcome: 'failed_roll', retryable: true,
    re: /\bunsuccessful in casting\b/i,
    why: 'the spell failed its roll',
    cites: 'spell.kod:73 spell_failed_by_chance, sent at spell.kod:1169',
    note: 'Ordinary. Nothing is wrong; cast it again. Distinct from `interrupted` because the ' +
          'fix is different: a roll wants another attempt, an interruption wants a quieter room.',
  },
  {
    // NOT A FAILURE. It is the answer "yes" to the question an idempotent prep is really
    // asking, and it is raised BEFORE the cost is taken — so asking is free when the answer
    // is yes. That makes a cast the cheapest and most authoritative `holds` predicate
    // available for a buff, and it is the only prod-safe way to ask whether a weapon is
    // enchanted, because the server never renames one.
    outcome: 'already', retryable: false, inEffect: true,
    // `infused`, `rages`, `present` and `polarized` are the ROOM enchantments' wording —
    // "This place is already infused with the spirit of Shal'ille." (forceslt.kod), plus the
    // sandstorm / magical winds / QorBane family. Without them a room enchantment reads as a
    // failed cast and is re-cast every pass, which for forces of light is 12 mana, two
    // elderberries and an EMERALD each time.
    re: /\balready\b.*\b(dedicated|enchanted|affected by that magic|have|has|resisting|see|bathed|shrouded|dripping|cloaked|dazzled|marked|listening|boils|infused|rages|present|polarized)\b/i,
    why: 'it is already in effect',
    cites: 'persench.kod:76 CanPayCosts, :132 vrAlreadyEnchanted (base rsc at :24); ' +
           'enchwp.kod:81-97, message at :94',
    note: 'The wording is per-spell — "You already have superior strength.", "This weapon is ' +
          'already dedicated to Kraanan." — over a base of "You are already enchanted."',
  },
  {
    outcome: 'out_of_range', retryable: false,
    re: /\b(out of range|too far away)\b/i,
    why: 'the target was out of range',
    cites: 'spell.kod spell_out_of_range; enchwp.kod:118 IsTargetInRange',
    note: 'enchant weapon reaches a weapon whose owner is the CASTER or the ROOM — so one ' +
          'lying on the floor of the same room is in range, and no hand-over is needed.',
  },
  {
    // ONE ENTRY PER OUTCOME NAME — the suite pins that, and it is right to: two entries
    // called `refused` would make "which rule fired" unanswerable from the outcome alone.
    // So a new refusal wording joins this pattern rather than adding a second entry.
    outcome: 'refused', retryable: false,
    re: /\byou may not\b|\bstrangely unaffected\b|\bcan't cast\b.*\bon\b/i,
    why: 'the server refused the target',
    cites: 'enchwp.kod:20 enchantweapon_no_can, :21 enchantweapon_fails; ' +
           'spell.kod:47 spell_bad_target ("You can\'t cast %s on %s!")',
    note: 'minor heal takes exactly one User, so a corpse, an item or a monster reads as ' +
          'spell_bad_target rather than as a miss.',
  },
  {
    outcome: 'no_such_spell', retryable: false,
    re: /do not know a spell matching/i,
    why: 'the caster does not know it',
    cites: 'harness-side refusal (m59-broker.mjs), not a server sentence',
  },
  // A REFUSAL THAT IS NOT A FAILURE, AND MUST NOT READ AS ONE.
  //
  // `CanPayCosts` in heal.kod returns FALSE with "Xxxx is perfectly healthy." when the target
  // is already at full health — before any payment, so no mana and no herb move. Unmatched, it
  // fell through to `nothing_happened`: "no mana and no reagents moved — the cast did not
  // happen", which is true and reads as a broken healer. Three healers reported 1 of 33 casts
  // landed on a run where most of the refusals were this: the target had been healed by
  // somebody else, or by its own rest, between choosing it and casting at it.
  //
  // It is worth its own name because the repair is different from every other entry here:
  // nothing is wrong with the caster, and the fix is to pick a different target.
  {
    outcome: 'unnecessary', retryable: false,
    re: /\bis perfectly healthy\b|\bdoes not need\b/i,
    why: 'the target did not need it',
    cites: 'heal.kod:29 heal_unnecessary_rsc, refused in CanPayCosts at :87',
    note: 'Raised BEFORE payment, so it costs nothing — which also makes re-checking free.',
  },
]);

/**
 * SOMETHING IS HITTING YOU — the one interruption no amount of holding still prevents.
 * EVENT_DAMAGE breaks a trance like everything else, so a thirty-second cast cannot be
 * completed in a fight, and retrying there burns the reagents once per attempt for a cast
 * that has no chance of landing. Matched by SHAPE rather than by enumerating every creature
 * and verb in the game, because the sentence belongs to the room and not to us.
 */
export const TOOK_A_HIT =
  /\b(wounds|hits|strikes|slashes|bites|stings|claws|burns|shocks|freezes|blasts)\s+you\b|\byou\b.*\btakes? damage\b/i;

/**
 * Classify one cast from the sentences the server said. `null` when none of them applies —
 * and null must not be read as success. An unrecognised sentence is an unrecognised sentence.
 *
 * An interruption additionally reports WHAT interrupted it when the transcript says so,
 * because "interrupted" and "interrupted because a troll is hitting you" call for completely
 * different responses: the first is retried, the second is a reason to prepare elsewhere.
 */
export function classifyCast(said = []) {
  for (const line of said)
    for (const o of CAST_OUTCOMES)
      if (o.re.test(String(line))) {
        const hit = o.outcome === 'interrupted' ? said.find(l => TOOK_A_HIT.test(String(l))) : null;
        return {
          outcome: o.outcome,
          retryable: hit ? false : !!o.retryable,
          in_effect: !!o.inEffect,
          why: hit
            ? `${o.why} — something is attacking: "${String(hit).slice(0, 60)}". A casting ` +
              'trance cannot survive a fight; prepare somewhere safe.'
            : o.why,
          ...(hit ? { interrupted_by: 'damage' } : {}),
          cites: o.cites,
          said: String(line),
        };
      }
  return null;
}

if (process.argv[1] && process.argv[1].endsWith('m59-castoutcomes.mjs')) {
  const sentence = process.argv.slice(2).join(' ').trim();
  if (sentence) {
    const r = classifyCast([sentence]);
    console.log(r ? JSON.stringify(r, null, 1)
                  : 'no entry matches that — which is NOT success, only silence about failure');
    process.exit(0);
  }
  console.log('HOW A CAST FAILS — failures and neutrals only; anything else that paid in full landed.\n');
  for (const o of CAST_OUTCOMES) {
    console.log(`  ${o.outcome.padEnd(14)} ${o.retryable ? 'retry' : '     '} ` +
                `${o.inEffect ? 'IN EFFECT' : '         '}  ${o.why}`);
    console.log(`  ${' '.repeat(14)} ${o.cites}`);
    if (o.note) console.log(`  ${' '.repeat(14)} ${o.note.replace(/\s+/g, ' ').slice(0, 300)}`);
    console.log('');
  }
  console.log(`a trance breaks on: ${TRANCE_BREAK_EVENTS.join(', ')}`);
}
