#!/usr/bin/env node
// Offline. Pins the resistance ladder against the kod it is read from, including the three
// endpoints the kod decides by the ORDER of its tests, the sign-selects-namespace encoding, and
// the max+min combining rule.
import { RESISTANCE_BANDS, MAX_RESISTANCE, MIN_RESISTANCE, bandOfLine, bandOfLines,
         blowLandedAsMagic, GHOST_OF_FARNOHL } from './m59-resistance.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};

// The predicate the kod actually applies, written out once so the table can be checked
// against it rather than against my memory of it (MsgPlayerHitResisted, player.kod:9686).
const kodBand = r => r > (3 * MAX_RESISTANCE / 5) ? 'immune'
  : r > (MAX_RESISTANCE / 5) ? 'resisted'
  : r <= (3 * MIN_RESISTANCE / 5) ? 'helpless'
  : r <= (MIN_RESISTANCE / 5) ? 'vulnerable'
  : 'neutral';

const tableBand = r => RESISTANCE_BANDS.find(b =>
  (b.exclusive_min ? r > b.min : r >= b.min) && r <= b.max)?.band ?? 'neutral';

console.log('the table agrees with the kod at every resistance from -100 to 100');
{
  const wrong = [];
  for (let r = MIN_RESISTANCE; r <= MAX_RESISTANCE; r++)
    if (tableBand(r) !== kodBand(r)) wrong.push(`${r}: table=${tableBand(r)} kod=${kodBand(r)}`);
  ok('all 201 values agree', wrong.length === 0, wrong.slice(0, 6).join('; '));
}

console.log('\nthe two boundaries the kod decides by ORDER of test');
{
  // kod asks `<= 3*MIN/5` BEFORE `<= MIN/5`, so exactly -60 is the anti-IMMUNITY message.
  ok('-60 is helpless, not vulnerable', tableBand(-60) === 'helpless', tableBand(-60));
  ok('-59 is vulnerable', tableBand(-59) === 'vulnerable', tableBand(-59));
  // and `> 3*MAX/5` before the else, so exactly 60 is the RESISTED message, not immunity.
  ok('60 is resisted, not immune', tableBand(60) === 'resisted', tableBand(60));
  ok('61 is immune', tableBand(61) === 'immune', tableBand(61));
  ok('20 is neutral — the band is exclusive at its low end', tableBand(20) === 'neutral');
  ok('21 is resisted', tableBand(21) === 'resisted');
  ok('-20 is vulnerable — this one is INCLUSIVE, because kod tests <=', tableBand(-20) === 'vulnerable');
  ok('-19 is neutral', tableBand(-19) === 'neutral');
}

console.log('\nsentences map to bands');
{
  ok('the immunity sentence', bandOfLine('The ghost of Far\'Nohl laughs off your pitiful blow.')?.band === 'immune');
  ok('the resisted sentence', bandOfLine('A zombie shrugs off your attack.')?.band === 'resisted');
  ok('the vulnerable sentence', bandOfLine('The ghost of Far\'Nohl staggers backwards from the blow.')?.band === 'vulnerable');
  ok('the helpless sentence', bandOfLine('It convulses and seems to be suffering badly.')?.band === 'helpless');
  // AN ORDINARY HIT PRINTS NOTHING. Silence is not evidence of a neutral resistance; it is
  // evidence of nothing, which is why this answers null rather than 'neutral'.
  ok('an ordinary hit says nothing at all', bandOfLine('Your long sword pokes the ghost of Far\'Nohl.') === null);
  ok('and so does a miss', bandOfLine('The ghost of Far\'Nohl avoids your attack.') === null);
  ok('bandOfLines takes the first verdict in a transcript',
     bandOfLines(['You swing.', 'It shrugs off your attack.', 'It laughs off your pitiful blow.'])?.band === 'resisted');
  ok('and answers null for a transcript with no verdict in it',
     bandOfLines(['You swing.', 'It avoids your attack.']) === null);
}

console.log('\nthe raid question: did that blow land as MAGIC?');
{
  const G = GHOST_OF_FARNOHL;
  ok('"laughs off your pitiful blow" means the weapon was MUNDANE',
     blowLandedAsMagic(['The ghost of Far\'Nohl laughs off your pitiful blow.'], G) === false);
  ok('"staggers backwards" means the enchantment is LIVE',
     blowLandedAsMagic(['The ghost of Far\'Nohl staggers backwards from the blow.'], G) === true);
  ok('a transcript with no verdict answers UNKNOWN, not false',
     blowLandedAsMagic(['Your long sword pokes the ghost of Far\'Nohl.'], G) === null);
  ok('an empty transcript answers unknown', blowLandedAsMagic([], G) === null);

  // The whole method depends on the two resistances falling in DIFFERENT bands. Against a
  // creature that resists both the same way the sentence cannot separate them, and saying so
  // is the difference between a measurement and a guess.
  ok('a target whose magic and non-magic resistances share a band answers unknown',
     blowLandedAsMagic(['It laughs off your pitiful blow.'],
                       { resistNonMagic: 90, resistMagic: 80 }) === null);
  ok('and so does one with no resistance table supplied',
     blowLandedAsMagic(['It laughs off your pitiful blow.'], {}) === null);
  ok('a verdict from a band belonging to NEITHER answers unknown rather than picking one',
     blowLandedAsMagic(['It convulses and seems to be suffering badly.'], G) === null);
}

console.log('\nthe ghost\'s table, as cited');
{
  ok('90 against a mundane weapon', GHOST_OF_FARNOHL.resistNonMagic === 90);
  ok('-50 against a magic one', GHOST_OF_FARNOHL.resistMagic === -50);
  ok('and it cites the kod', /ghost\.kod:87-88/.test(GHOST_OF_FARNOHL.cites));
  ok('holy is the spell school that works', GHOST_OF_FARNOHL.resistHolySpell === -50);
  ok('and the elemental schools are wasted on it', GHOST_OF_FARNOHL.resistElementalSpell === 90);
  ok('every band carries its citation', RESISTANCE_BANDS.every(b => /player\.kod:\d+/.test(b.cites)));
}

console.log('\nthe max+min rule — never read one entry and stop');
{
  const { effectiveResistance, damageAfterResistance, ATCK } = await import('./m59-resistance.mjs');

  // battler.kod:195-249 keeps the LARGEST and SMALLEST matching values, both starting at
  // NO_RESISTANCE 0, and returns their SUM. Two matching entries can cancel completely.
  ok('a single positive entry is itself',
     effectiveResistance([[90, ATCK.WEAP_ALL]], { atype: ATCK.WEAP_SLASH }) === 90);
  ok('a single negative entry is itself',
     effectiveResistance([[-50, ATCK.WEAP_MAGIC]], { atype: ATCK.WEAP_MAGIC }) === -50);
  ok('+20 and -20 on the same damage type CANCEL to zero',
     effectiveResistance([[20, ATCK.WEAP_SLASH], [-20, ATCK.WEAP_SLASH]],
                         { atype: ATCK.WEAP_SLASH }) === 0);
  ok('a non-matching entry contributes nothing',
     effectiveResistance([[90, ATCK.WEAP_PIERCE]], { atype: ATCK.WEAP_SLASH }) === 0);
  ok('ATCK_WEAP_ALL matches any weapon type',
     effectiveResistance([[30, ATCK.WEAP_ALL]], { atype: ATCK.WEAP_BLUDGEON }) === 30);
  ok('but ATCK_WEAP_ALL does not match a SPELL',
     effectiveResistance([[30, ATCK.WEAP_ALL]], { aspell: ATCK.SPELL_FIRE }) === 0);
  ok('values are clipped to the extremes before summing',
     effectiveResistance([[500, ATCK.WEAP_ALL], [-500, ATCK.WEAP_ALL]],
                         { atype: ATCK.WEAP_SLASH }) === 0);
}

console.log('\nthe SIGN selects a namespace, and the two mask spaces collide exactly');
{
  const { effectiveResistance, ATCK } = await import('./m59-resistance.mjs');
  // ATCK_WEAP_MAGIC 0x4 IS ATCK_SPELL_SHOCK 0x4. Only the sign tells them apart, which is why
  // a missing minus does not mistype an entry — it moves it to the other namespace.
  ok('the masks really are identical', ATCK.WEAP_MAGIC === ATCK.SPELL_SHOCK
     && ATCK.WEAP_ALL === ATCK.SPELL_ALL && ATCK.WEAP_THRUST === ATCK.SPELL_ACID
     && ATCK.WEAP_SLASH === ATCK.SPELL_QUAKE);
  ok('a NEGATED type is a spell resistance and ignores a weapon blow',
     effectiveResistance([[90, -ATCK.SPELL_SHOCK]], { atype: ATCK.WEAP_MAGIC }) === 0);
  ok('and applies to the spell',
     effectiveResistance([[90, -ATCK.SPELL_SHOCK]], { aspell: ATCK.SPELL_SHOCK }) === 90);
  ok('an UN-negated spell token is read as the colliding WEAPON type',
     effectiveResistance([[20, ATCK.SPELL_SHOCK]], { atype: ATCK.WEAP_MAGIC }) === 20);
}

console.log('\nthe Ice Peryton — a real mis-signed list in the tree (iceper.kod:151-160)');
{
  const { effectiveResistance, ATCK } = await import('./m59-resistance.mjs');
  // Four entries lost their minus, so they landed in the weapon namespace. Two of them collide
  // with genuine weapon entries in the same list and cancel them.
  const PERYTON = [
    [ 99, -ATCK.SPELL_COLD],    // :151 correct
    [ 40,  ATCK.WEAP_PIERCE],   // :152
    [ 30,  ATCK.WEAP_THRUST],   // :153
    [ 20,  ATCK.SPELL_SHOCK],   // :154 MIS-SIGNED -> reads as ATCK_WEAP_MAGIC
    [ 20,  ATCK.SPELL_ALL],     // :155 MIS-SIGNED -> reads as ATCK_WEAP_ALL, matches anything
    [ 20,  ATCK.WEAP_SLASH],    // :156
    [-10,  ATCK.WEAP_BLUDGEON], // :157
    [-10,  ATCK.SPELL_ACID],    // :158 MIS-SIGNED -> reads as ATCK_WEAP_THRUST
    [-20,  ATCK.SPELL_QUAKE],   // :159 MIS-SIGNED -> reads as ATCK_WEAP_SLASH
    [-30, -ATCK.SPELL_FIRE],    // :160 correct
  ];
  ok('its listed SLASH resistance is cancelled to zero by a mis-signed quake entry',
     effectiveResistance(PERYTON, { atype: ATCK.WEAP_SLASH }) === 0,
     String(effectiveResistance(PERYTON, { atype: ATCK.WEAP_SLASH })));
  ok('its listed THRUST resistance is halved by a mis-signed acid entry: 30 + -10',
     effectiveResistance(PERYTON, { atype: ATCK.WEAP_THRUST }) === 20,
     String(effectiveResistance(PERYTON, { atype: ATCK.WEAP_THRUST })));
  ok('it has NO shock spell resistance at all, whatever the list appears to say',
     effectiveResistance(PERYTON, { aspell: ATCK.SPELL_SHOCK }) === 0);
  ok('and no general spell resistance either',
     effectiveResistance(PERYTON, { aspell: ATCK.SPELL_HOLY }) === 0);
  ok('its cold resistance is intact, because that entry was signed correctly',
     effectiveResistance(PERYTON, { aspell: ATCK.SPELL_COLD }) === 99);
  ok('and a mis-signed ALL entry gives it a weapon resistance nobody wrote on purpose',
     effectiveResistance(PERYTON, { atype: ATCK.WEAP_PIERCE }) === 40);
}

console.log('\nthe damage formula, which is where the fifteenfold swing comes from');
{
  const { damageAfterResistance } = await import('./m59-resistance.mjs');
  ok('90 resistance leaves a tenth', damageAfterResistance(100, 90) === 10);
  ok('-50 resistance deals one and a half', damageAfterResistance(100, -50) === 150);
  ok('so an enchanted weapon is fifteen times a mundane one against the ghost',
     damageAfterResistance(100, -50) / damageAfterResistance(100, 90) === 15);
  ok('zero resistance is unchanged', damageAfterResistance(100, 0) === 100);
  ok('the two branches agree at the boundary', damageAfterResistance(100, 0) === 100);
}

console.log('\nthe damage formula matches the SERVER, which divides as integers');
{
  const { damageAfterResistance, MAX_RESISTANCE, MIN_RESISTANCE } = await import('./m59-resistance.mjs');
  // battler.kod:258/:262 are one expression spelled twice: MIN+v is -(MAX-v) when the constants
  // are +/-100, so both numerator and denominator are negated and the quotient is identical
  // under every rounding convention. Swept rather than argued.
  let branchDisagreements = 0, kodMismatches = 0;
  for (let d = 0; d <= 500; d++) {
    for (let v = MIN_RESISTANCE; v <= MAX_RESISTANCE; v++) {
      const pos = (d * (MAX_RESISTANCE - v)) / MAX_RESISTANCE;
      const neg = (d * (MIN_RESISTANCE + v)) / MIN_RESISTANCE;
      if (Math.trunc(pos) !== Math.trunc(neg) || Math.floor(pos) !== Math.floor(neg))
        branchDisagreements++;
      if (damageAfterResistance(d, v) !== Math.trunc(pos)) kodMismatches++;
    }
  }
  ok('the two spellings never disagree, over all 100,701 pairs and both conventions',
     branchDisagreements === 0, String(branchDisagreements));
  ok('and the implementation matches the integer result at every one of them',
     kodMismatches === 0, String(kodMismatches));

  // The specific case that exposed the float bug: a float here is not a rounding nicety, it is
  // a different number from the one the server used.
  ok('1 damage against -99 resistance is 1, not 1.99', damageAfterResistance(1, -99) === 1);
  // The SCALING returns 0 here — but see damageDelivered: the caller floors it at 1, so the
  // blow still lands for a point. Reading this 0 as "the fight is unwinnable" was wrong.
  ok('7 damage against 90 resistance scales to 0 before the caller floors it',
     damageAfterResistance(7, 90) === 0);
  ok('every result is an integer', Number.isInteger(damageAfterResistance(37, -37)));
}

console.log('\na resisted blow never does zero — the caller floors it at 1');
{
  const { damageDelivered, damageAfterResistance, GHOST_OF_FARNOHL } = await import('./m59-resistance.mjs');
  // monster.kod:1561-1562 "Always do a minimum of one point of damage", player.kod:4597-4600.
  // The difference between "slow" and "impossible", and the clamp a reimplementation drops
  // because it looks like defensive noise.
  ok('the scaling returns 0 but the delivered damage is 1',
     damageAfterResistance(7, 90) === 0 && damageDelivered(7, 90) === 1);
  ok('a mundane weapon against the ghost still lands a point every swing',
     damageDelivered(30, GHOST_OF_FARNOHL.resistNonMagic) >= 1);
  ok('an enchanted one lands one and a half times',
     damageDelivered(30, GHOST_OF_FARNOHL.resistMagic) === 45);
  ok('the floor never REDUCES a real hit', damageDelivered(100, 0) === 100);
  ok('absolute damage skips both the scaling and the floor',
     damageDelivered(0, 90, { absolute: true }) === 0);

  // The bonus is applied AFTER the scaling, so it bypasses resistance. Real rule, and
  // unreachable in this tree: all 39 @AssessDamage call sites pass no bonus.
  ok('a bonus bypasses resistance entirely',
     damageDelivered(10, 90, { bonus: 5 }) === 6);      // 10*10/100 = 1, +5
  ok('which is worth far more than the same number on the weapon',
     damageDelivered(10, 90, { bonus: 5 }) > damageDelivered(15, 90));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
