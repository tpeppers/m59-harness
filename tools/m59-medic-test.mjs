#!/usr/bin/env node
// THE MEDIC CASTS ITS BEST HEAL, NOT ITS FIRST — offline, no socket, no roster.
//
//   node tools/m59-medic-test.mjs
//
// WHAT THIS PINS, and why it is worth a file of its own.
//
// `medic()` matched `/^(minor heal|heal)$/` and therefore always cast the LEVEL ONE spell,
// whatever the caster knew. Shal'ille's heal ladder is minor heal (level 1, 3 mana), hospice
// (level 3, 10 mana and 3 herbs) and major heal (level 5, 20 mana), and the difference is not
// cosmetic: `PlayerCanLearn` gates level N on the best THREE abilities at level N-1, so for a
// character trying to reach the next school level, practice on a level-1 spell contributes
// EXACTLY NOTHING to the gate.
//
// Measured on prod 2026-09-09 — Loial the Ogier at hospice 25, cure disease 19, identify 17
// against the 115 "forces of light" wants. A medic pass healing allies all day with minor
// heal would have moved none of it, while looking busy and reporting successful casts.
//
// The second half is the target. `hospice.kod:88` CanPayCosts returns FALSE for a target
// already at full health, BEFORE any message — so the cast does not happen at all: no mana,
// no reagent, no practice, and nothing on the wire to say so. The wire does not carry another
// player's health either, so the only honest way to learn it is to cast and watch the mana.
// A no-op therefore has to be recorded as one, and that body skipped for a while, or the pass
// re-picks the same healthy ally for ever and every cast reports `ok`.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (what, cond) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}`); }
};

const SRC = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');

console.log('');
console.log('the heal ladder is declared, ordered, and priced');
{
  // Imported rather than regexed where possible: the ladder is data and data can be asserted.
  const mod = await import('./m59-autopilot.mjs');
  const A = mod.Autopilot ?? mod.default;
  ok('Autopilot exposes a HEALS ladder', Array.isArray(A?.HEALS) && A.HEALS.length >= 3);
  const names = A.HEALS.map(h => h.name);
  ok('it holds all three Shal\'ille heals',
     ['major heal', 'hospice', 'minor heal'].every(n => names.includes(n)));
  ok('and it is ordered BEST FIRST, which is what makes the search a ladder',
     names.indexOf('major heal') < names.indexOf('hospice') &&
     names.indexOf('hospice') < names.indexOf('minor heal'));

  const by = Object.fromEntries(A.HEALS.map(h => [h.name, h]));
  // Costs are the game's, from each spell's own kod: heal.kod, hospice.kod, majheal.kod.
  ok('minor heal costs 3 mana', by['minor heal'].mana === 3);
  ok('hospice costs 10', by.hospice.mana === 10);
  ok('major heal costs 20', by['major heal'].mana === 20);
  // ONLY HOSPICE TAKES REAGENTS, and a rung that cannot pay them must be skipped rather
  // than cast — a cast that cannot pay is refused server-side and looks like one that landed.
  ok('hospice needs 3 herbs and the others need none',
     JSON.stringify(by.hospice.reagents) === JSON.stringify([['herb', 3]]) &&
     by['minor heal'].reagents.length === 0 && by['major heal'].reagents.length === 0);
  ok('the ladder is frozen, so a policy cannot reorder it by accident',
     Object.isFrozen(A.HEALS));
}

console.log('');
console.log('medic() walks the ladder instead of matching one name');
{
  const body = SRC.slice(SRC.indexOf('async medic()'), SRC.indexOf('async medic()') + 4200);
  ok('the old level-1-only match is gone',
     !/\/\^\(minor heal\|heal\)\$\/i/.test(body));
  ok('it iterates the ladder', /for \(const h of Autopilot\.HEALS\)/.test(body));
  ok('it checks mana before choosing a rung', /mana\.value < h\.mana/.test(body));
  ok('and reagents too, before the cast rather than after the refusal',
     /this\.reagentOnHand\(n\) < k/.test(body));
  ok('a caster that can pay for nothing says which rungs it tried',
     /cannot pay for any heal/.test(body));
}

console.log('');
console.log('a full-health target is a no-op, and is recorded as one');
{
  const body = SRC.slice(SRC.indexOf('async medic()'), SRC.indexOf('async medic()') + 5200);
  ok('mana is read before the cast', /const manaBefore = /.test(body));
  ok('and the spend is what decides whether anything happened',
     /const landed = !\(spent === 0\)/.test(body));
  ok('an unhurt body is remembered so the next pass tries somebody else',
     /_unhurtUntil\.set\(other\.id/.test(body));
  ok('and skipped while that memory lasts',
     /!\(this\._unhurtUntil\.get\(o\.id\) > now\)/.test(body));
  ok('the tally only counts heals that cost something',
     /if \(landed\) this\.tally\.heals_given/.test(body));
  ok('and a no-op does not report ok', /ok: landed/.test(body));
  ok('it says plainly that no practice happened either',
     /so no practice either/.test(body));
}

console.log('');
console.log('the pass is still gated on the strategy that asked for it');
{
  ok('coop enables medic', /medic: true, share: true/.test(SRC));
  ok('and the tick consults the strategy, not a bare flag',
     /\(STRATEGIES\[this\.policy\.strategy\] \|\| \{\}\)\.medic/.test(SRC));
}

console.log('');
console.log('and a healer behind a wall can actually reach the pass');
{
  // THE BUG THIS PINS. `medic()` is called from the WORK pass, several stages below the
  // flee-and-rest stage. That stage's own comment says why the work pass is unreachable,
  // about a different victim: "a character holding a wall never reaches it, because this
  // stage handles the pass and returns first." A dedicated healer's normal resting state IS
  // holding a wall, so the medic was unreachable in the one configuration it is for.
  //
  // Measured on prod 2026-09-10: Loial the Ogier, coop strategy, 65/65 mana, hospice known,
  // two wounded fleet-mates in the room, activity "holding a proven safe spot" — six samples
  // over a hundred seconds and mana never moved.
  const holdCall = /if \(this\.hold && \(STRATEGIES\[this\.policy\.strategy\] \|\| \{\}\)\.medic\)/;
  ok('the hold stage asks the medic too', holdCall.test(SRC));
  const at = SRC.search(holdCall);
  const work = SRC.indexOf("if ((STRATEGIES[this.policy.strategy] || {}).medic) await this.medic()");
  ok('and it is asked EARLIER than the work pass, which is the unreachable one',
     at > 0 && work > 0 && at < work);
  const near = SRC.slice(at, at + 700);
  ok('only while sheltered — a wall at our back', /this\.hold &&/.test(near));
  ok('and only while whole, so a character mending itself does not spend mana on others',
     /whole >= 0\.9/.test(near));
  // The ordering of the survival ladder is the thing that must NOT change: mis-ranking one
  // rung of it has already cost four deaths, per the retreat note in the same function.
  ok('the work-pass call is still there, so nothing was reordered away',
     work > 0);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
