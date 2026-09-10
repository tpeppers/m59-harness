// PRACTISE ONE SHAL'ILLE SPELL, WITH THAT SPELL'S OWN GATE WRITTEN DOWN NEXT TO IT.
//
//   practice-shalille agents=hk1 spell=rescue casts=40
//   practice-shalille agents=hk1 spell="spiritual hammer" casts=40
//   practice-shalille --list                 # what is practisable, what is not, and why
//
// PUBLIC. Asked for by the operator, 2026-09-10: "I think we should be leaving behind like a
// FleetScript function for practicing each spell... like, a function per spell that gets
// practiced." So there is one function per spell below, and each one carries the reason it is
// shaped the way it is.
//
// WHY A FUNCTION PER SPELL, RATHER THAN ONE LOOP WITH A NAME PARAMETER. Because the loop is
// NOT the same for each spell, and the differences are not cosmetic — they decide whether the
// practice happens at all. Every Shal'ille spell has its own `CanPayCosts`, and a cast that
// fails it is refused BEFORE any cost is taken: no mana, no reagent, NO PRACTICE, and often no
// message on the wire. So a generic loop reports a hundred successful casts and moves nothing.
//
// THERE ARE THREE LOOP SHAPES HERE, and which one a spell needs is a property of the spell.
//
//   FREE        cast, rest, cast. No target, no state, nothing to clean up.
//               spiritual hammer, holy resolve, holy symbol, detect evil.
//
//   RESET       the cast changes the caster's own state, and the loop has to undo it before the
//               next one is legal. Rescue is the whole example: it refuses while a rescue is
//               pending or a Token is held, and it TELEPORTS you, so — the operator, 2026-09-10
//               — "walk out of the inn (or guild hall) that it placed you inside, then recast
//               rescue." The walk out IS the reset, and it is also the wait.
//
//   FACTORY     the target is consumable and the loop has to manufacture it. Operator, same
//               day: "For dedicating weapon spells (holy weapon, enchant weapon, unholy
//               weapon) people often do 'create weapon' to supply weapons, then cast the
//               enchant, then drop the weapon... it's all about the factory method: speed."
//               See holyWeapon() below for why a weapon is single-use here, and why for
//               Shal'ille the factory is itself a spell worth practising.
//
// And the ones that cannot be looped at all:
//
//   hospice           refuses on a target already at full health (hospice.kod:88)
//   cure disease      refuses unless the target is genuinely diseased — not practisable
//   identify          refuses on anything that is not identifiable weapon or armour
//
// THE GATE THIS IS ALL FOR. `PlayerCanLearn` gates school level N on the best THREE abilities
// at level N-1 summing to a threshold — 115 for level 4. That is why practice has to be
// SPREAD: pushing one spell to 79 is worth exactly as much to the gate as three spells at 26,
// and costs far more, because a high ability advances more slowly than a low one. Loial the
// Ogier measured 2026-09-10: hospice 31 + cure disease 19 + identify 17 = 67 of 115, with all
// the night's casts having gone into hospice alone and cure disease frozen because nothing in
// the fleet was diseased.
//
// THE OPERATOR'S TRIPLE, and his reasons, 2026-09-10: "Rescue, Spiritual Hammer, and Hospice
// are the three best for level three, IMHO (spirit hammer because it's genuinely good, hospice
// because it's useful for karma purposes, and rescue because it's good and cheap)."
//
// AND THE ADVANCEMENT CAP PAYS RESCUE A BONUS NOBODY DESIGNED FOR US. `ADVANCEMENT_LIMIT` is
// 10 (player.kod:68) and a room change refunds 2 — player.kod:1465, whose own comment reads
// "Player moved to a new location, give them a break on the botting imp cap." Rescue teleports
// the caster home on every cast, and walking back out is a second room change, so the loop
// refunds up to 4 against the 1 it spends. `CheckAdvancementPoints` even prints a hint telling
// players to move between rooms to keep practising. The rescue loop is that hint, automated.
//
// WHAT IT COSTS TO GET THAT: rescue's `viChance_To_Increase` is 10, the LOWEST of the level-3
// set, against 20 for spiritual hammer (inherited from spell.kod) and 15 for hospice. So
// rescue buys unlimited casts at half the per-cast chance. Run hammer for rate, rescue when
// hammer has hit the cap or the emeralds for it have run out, hospice whenever anybody is hurt
// because that one also pays karma.
import { act, walk, rest, verify } from '../m59-fleetscript.mjs';

// EVERY NUMBER HERE IS READ OFF THE KOD, AND CARRIES WHERE FROM.
//
// Not from the spell catalogue on the wire, and not from memory: three separate claims about
// this school were wrong in one night when they came from memory. `targets` is
// `GetNumSpellTargets`, `gate` is what that spell's own `CanPayCosts` adds on top of the base
// class, and `inc` is `viChance_To_Increase` — the FIRST of the two advancement rolls.
export const SHALILLE = Object.freeze({
  'minor heal':       { level: 1, mana: 3,  inc: 20, targets: 1, reagents: [['herb', 1]],
                        gate: 'a User below maximum health', src: 'heal.kod' },
  'holy symbol':      { level: 1, mana: 8,  inc: 15, targets: 0, reagents: [['elderberry', 3]],
                        gate: null, src: 'holysymb.kod' },
  'seance':           { level: 1, mana: 10, inc: 20, targets: 0, reagents: [['herb', 2]],
                        gate: 'a corpse or spirit in the room', src: 'seance.kod' },
  'detect evil':      { level: 1, mana: 10, inc: 15, targets: 0, reagents: [],
                        gate: null, src: 'detevil.kod' },
  'breath of life':   { level: 1, mana: 3,  inc: 20, targets: 1, reagents: [['herb', 1]],
                        gate: 'a dead player', src: 'brthlife.kod' },

  'resist acid':      { level: 2, mana: 9,  inc: 30, targets: 0, reagents: [['herb', 2], ['entroot berry', 1]],
                        gate: null, src: 'resacid.kod' },
  'remove curse':     { level: 2, mana: 9,  inc: 30, targets: 1, reagents: [['emerald', 1]],
                        gate: 'a cursed item', src: 'remcurse.kod' },
  'cure poison':      { level: 2, mana: 10, inc: 30, targets: 1, reagents: [['herb', 2], ['elderberry', 1]],
                        gate: 'a POISONED User', src: 'cpoison.kod' },
  'holy touch':       { level: 2, mana: 12, inc: 20, targets: 0, reagents: [['emerald', 2]],
                        gate: null, src: 'holytch.kod' },
  'holy weapon':      { level: 2, mana: 17, inc: 20, targets: 1, reagents: [['fairy wing', 3], ['orc tooth', 1]],
                        gate: 'a weapon in hand', src: 'holywp.kod' },

  'hospice':          { level: 3, mana: 10, inc: 15, targets: 1, reagents: [['herb', 3]],
                        gate: 'a User below maximum health', src: 'hospice.kod:88' },
  'cure disease':     { level: 3, mana: 9,  inc: 40, targets: 1, reagents: [['herb', 3], ['elderberry', 2]],
                        gate: 'a User actually enchanted by &Disease', src: 'cdisease.kod' },
  'identify':         { level: 3, mana: 10, inc: 15, targets: 1, reagents: [['orc tooth', 1]],
                        gate: 'an item whose class answers CanIdentify — weapon or armour',
                        src: 'identify.kod' },
  'rescue':           { level: 3, mana: 16, inc: 10, targets: 0, reagents: [['emerald', 1]],
                        gate: 'no Token held, no rescue already pending, no recent player attack',
                        src: 'rescue.kod' },
  'spiritual hammer': { level: 3, mana: 15, inc: 20, targets: 0, reagents: [['emerald', 2], ['orc tooth', 1]],
                        gate: null, src: 'creasphm.kod' },
  'holy resolve':     { level: 3, mana: 3,  inc: 35, targets: 0, reagents: [['solagh', 1], ['fairy wing', 1]],
                        gate: null, src: 'resevil.kod' },

  'forces of light':  { level: 4, mana: 12, inc: 40, targets: 0, reagents: [['elderberry', 2], ['emerald', 1]],
                        gate: null, src: 'forceslt.kod' },
  'purify':           { level: 4, mana: 10, inc: 10, targets: 1, reagents: [['emerald', 2], ['elderberry', 2]],
                        gate: 'something to purify', src: 'purify.kod' },
  'mark of dishonor': { level: 4, mana: 12, inc: 30, targets: 1, reagents: [['emerald', 1]],
                        gate: 'a player target', src: 'dishonor.kod' },

  'major heal':       { level: 5, mana: 20, inc: 20, targets: 1, reagents: [['herb', 5]],
                        gate: 'a User below maximum health', src: 'majheal.kod' },
  'reveal':           { level: 5, mana: 30, inc: 20, targets: 1, reagents: [['orc tooth', 3]],
                        gate: 'something hidden to reveal', src: 'reveal.kod' },
  'final rites':      { level: 5, mana: 20, inc: 20, targets: 0, reagents: [['emerald', 2], ['elderberry', 5]],
                        gate: null, src: 'finlrite.kod' },
});

// A PRACTICE PLAN IS NOT A CAST LOOP — IT IS A CAST LOOP PLUS THE THING THAT MAKES THE NEXT
// CAST LEGAL. That second half is what differs per spell, and it is the whole reason these are
// separate functions.
//
// Each returns { steps, why, partner, buy } where `partner` names a second body the loop needs
// (null if it can be run alone, which is the property the operator cares about: "you can
// practice on yourself! you don't need a partner!") and `buy` is the reagent shopping list per
// cast, so a caller can price the run before driving anything.

// MANA IS THE THROTTLE ON EVERY ONE OF THESE, and NOTHING IN THIS HARNESS RESTS FOR MANA.
//
// `rest()` waits on health and vigor; `rest_up` waits on health and vigor; there is no mana
// target anywhere. So the wait is polled here rather than pretended at: sit down (which is
// safe-spot-checked by the rest step, unlike a bare `act('rest')`), then read the ceiling back
// until the next cast is affordable.
//
// `maxMana` has to be PASSED, not assumed. Max mana is recomputed from the node bitmask on
// every login (`ComputeMaxMana`), so a value read from a freshly joined session understates it
// — hk1 read 25 and then 65 across one keeper restart with nothing having walked anywhere.
const castsPerBar = (maxMana, mana) => Math.max(1, Math.floor(maxMana / mana));

// STATUS HAS TWO SHAPES, and this is the fourth tool in this repository to be caught by it: a
// keeper-backed character answers `mana`, while the broker answering in-process for a joined
// character with no keeper yet answers `vitals.mana`. Reading only one gives `null`, which
// reads as "no mana" and is indistinguishable from an empty bar.
const manaOf = (st) => st?.vitals?.mana?.value ?? st?.mana?.value ?? null;

const manaAtLeast = (need, maxSeconds = 120) => ({
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

const loop = (spell, casts, maxMana, between = []) => {
  const per = castsPerBar(maxMana, SHALILLE[spell].mana);
  const need = SHALILLE[spell].mana;
  const steps = [];
  for (let i = 0; i < casts; i++) {
    // `force` is deliberately NOT passed. The cast tool checks karma, mana and reagents first
    // and refuses with the reason rather than spending the attempt, which is the behaviour we
    // want: a refused cast that is reported is worth more than a sent one that is silent.
    steps.push(act('cast', { spell }, { optional: true, why: `practice ${i + 1}/${casts}` }));
    steps.push(...between);
    // Rest at the end of a bar, not when already empty: resting from zero wastes the wait.
    if ((i + 1) % per === 0 && i + 1 < casts) {
      steps.push(rest({ vigor: 0.9, optional: true,
                        why: `a bar of mana buys ${per} cast(s); sit somewhere safe first` }));
      steps.push(manaAtLeast(need));
    }
  }
  return steps;
};

// RESCUE — the one the operator named as "good and cheap", and the only one that pays the
// advancement cap back.
//
// A RESET loop. Cast, get teleported about 15-25 seconds later, walk back out, cast again.
// `RescueBaseDelaySec` is 15 (settings.kod:91), reduced by spellpower/400 and increased by a
// random 5-10s half the time, and `CanPayCosts` refuses while that timer is still pending
// (`CanRescue`) or while the Token it produced is still held.
//
// THE WALK BACK OUT IS THE WAIT. It is not an extra step that costs time — it is how the loop
// spends the rescue timer, and it is also the second room change that earns the second -2
// against the advancement cap. That is why this takes `outside` rather than standing still:
// the operator's own description was "just running outside of the inn and casting it again."
// AND WHERE IT PUTS YOU DEPENDS ON WHETHER THE CASTER IS IN A GUILD. `DoRescue` sends a
// guilded character to the GUILD HALL when the hall is in the same region, and only otherwise
// falls through to `AdminGoToSafety` and the home room. So `home` is not a constant of the
// character — it changes the day it joins a guild, which for this fleet is today (The Second
// Swines, founded 2026-09-10). The operator said it in one breath: "walk out of the inn (or
// guild hall) that it placed you inside."
export const rescue = ({ casts = 20, maxMana = 65, home = 48, outside = 47 } = {}) => ({
  why: 'no target at all, 1 emerald a cast, and the teleport refunds the advancement cap',
  partner: null,
  buy: [['emerald', casts]],
  steps: loop('rescue', casts, maxMana, [
    // Absorbs the rescue timer AND banks a room change. `optional` because being teleported
    // mid-walk is the expected outcome here, exactly as on a trigger square.
    walk(outside, { optional: true, why: 'spend the rescue timer and earn the room-change refund' }),
    walk(home, { optional: true, why: 'back to where the rescue lands, ready to cast again' }),
  ]),
});

// SPIRITUAL HAMMER — the best per-cast odds in the school's third level, and the freest cast.
//
// `creasphm.kod` declares NO CanPayCosts at all, so it inherits only the base affordability
// check: mana, reagents, karma. No target, no state, nothing in the room. Its
// `viChance_To_Increase` is inherited from spell.kod at 20, DOUBLE rescue's 10.
//
// It creates a hammer each time, so the pack fills. That is the only thing to watch, and it is
// why this drops the hammers rather than carrying them: four containers with four different
// rules and a pack with two ceilings is not a thing to discover at cast forty.
export const spiritualHammer = ({ casts = 20, maxMana = 65, drop = true } = {}) => ({
  why: 'no gate whatsoever and inc 20 — the highest-rate level-3 spell a lone caster can drill',
  partner: null,
  buy: [['emerald', casts * 2], ['orc tooth', casts]],
  steps: loop('spiritual hammer', casts, maxMana,
    // The broker tool is called `act` and `drop` is one of its verbs (use/unuse/get/drop/
    // activate/eat/go) — NOT a tool of its own, which is what I reached for first.
    drop ? [act('act', { verb: 'drop', target: 'spiritual hammer' }, { optional: true,
             why: 'each cast creates one; the pack has two ceilings and neither is generous' })]
         : []),
});

// HOLY WEAPON — THE FACTORY, and the reason a factory is needed at all.
//
// `holywp.kod` refuses two ways: the target must be a `&weapon`, and it must NOT already carry
// `ATCK_SPELL_HOLY` — `holyweapon_already_done`. So A WEAPON IS SINGLE-USE FOR THIS PRACTICE.
// You cannot stand still re-casting on the sword in your hand; the second cast is refused
// before it takes anything, which is the silent-refusal shape again. Every practice cast needs
// a weapon that has never been blessed.
//
// Buying twenty daggers to bless and throw away is the slow way round, and it is why the
// operator described the fast one: manufacture the weapons. For Shal'ille the factory is
// SPIRITUAL HAMMER — `creasphm.kod` creates a `&SpiritualHammer`, and `spirhamm.kod` opens
// with `SpiritualHammer is Weapon`, so the chain links. That makes this loop unusual and
// unusually good:
//
//   cast spiritual hammer   practice on a level-3 spell, inc 20, no gate at all
//   cast holy weapon on it  practice on a level-2 spell, inc 20, on a weapon never blessed
//   drop the hammer         it is spent for this purpose, and the pack has two ceilings
//
// ONE ITERATION IS TWO PRACTICE ROLLS ON TWO DIFFERENT SPELLS, at two different school levels,
// with no shopping trip in the middle. That is what "it's all about the factory method: speed"
// buys. The same shape works for the other schools' dedications (enchant weapon, unholy
// weapon) with their own create-weapon spell as the factory; only the names change.
//
// Cost per iteration is 32 mana — hammer 15 plus holy weapon 17 — so a 65 bar buys two.
export const holyWeapon = ({ casts = 20, maxMana = 65 } = {}) => {
  const per = SHALILLE['spiritual hammer'].mana + SHALILLE['holy weapon'].mana;
  const steps = [];
  for (let i = 0; i < casts; i++) {
    steps.push(act('cast', { spell: 'spiritual hammer' },
                   { optional: true, why: `factory ${i + 1}/${casts}: make a weapon nobody has blessed` }));
    steps.push(act('cast', { spell: 'holy weapon', target: 'spiritual hammer' },
                   { optional: true, why: 'the enchant — refused on a weapon already holy' }));
    steps.push(act('act', { verb: 'drop', target: 'spiritual hammer' },
                   { optional: true, why: 'spent: ATCK_SPELL_HOLY is set, so it can never be practice again' }));
    if ((i + 1) % Math.max(1, Math.floor(maxMana / per)) === 0 && i + 1 < casts) {
      steps.push(rest({ vigor: 0.9, optional: true, why: 'a bar buys two iterations at 32 mana each' }));
      steps.push(manaAtLeast(per));
    }
  }
  return {
    why: 'two practice rolls an iteration — the factory spell AND the enchant — and no shopping',
    partner: null,
    buy: [['emerald', casts * 2], ['orc tooth', casts * 2], ['fairy wing', casts * 3]],
    steps,
  };
};

// HOSPICE — the karma one, and the one that silently does nothing.
//
// `hospice.kod:88`: CanPayCosts returns FALSE when the target is already at full health,
// BEFORE any message — so no mana, no reagent, no practice, and nothing on the wire to say so.
// The wire does not carry another player's health either, so the only honest way to know is to
// cast and watch the mana. `Autopilot.medic()` already does exactly that and records an unhurt
// body so the next pass tries somebody else; this script defers to it rather than
// reimplementing it badly.
//
// It needs a PARTNER, and one who is actually hurt. That is the whole difference from the two
// above, and it is why it cannot be the backbone of a practice run.
export const hospice = ({ casts = 20, maxMana = 65, patient = null } = {}) => ({
  why: 'the only level-3 rung that also pays karma — but it needs somebody genuinely wounded',
  partner: patient,
  buy: [['herb', casts * 3]],
  steps: patient
    ? loop('hospice', casts, maxMana)
    // RETURNS FALSE, NOT AN OBJECT. `verify` scores its step as `Boolean(v)`, so a refusal
    // shaped like `{ ok: false, why }` is TRUTHY and passes — which is how a refusal becomes a
    // silent success. The reason belongs in the second argument, which is what gets reported.
    : [verify(() => false,
        'hospice refuses a target already at full health before it sends anything ' +
        '(hospice.kod:88), so a run without a named wounded partner reports casts it never ' +
        'made. Pass patient=<who>, or let m59-shalille-train.mjs drive it — that one keeps the ' +
        'patient hurt on purpose and checks the healer could answer BEFORE the next self-harm.')],
});

// IDENTIFY — practisable alone, but only against gear.
//
// `identify.kod` refuses anything that is not an Item answering `CanIdentify`, which is weapon
// or armour. A reagent, a mushroom or a coin is a refusal. It also needs the caster STANDING:
// a resting player cannot cast, which cost a session's worth of "identify cannot target an
// inventory item" before somebody stood the character up.
export const identify = ({ casts = 20, maxMana = 65, item = null } = {}) => ({
  why: 'no partner needed, but the target has to be identifiable weapon or armour',
  partner: null,
  buy: [['orc tooth', casts]],
  steps: [
    // Standing is a FLAG on the `rest` tool, not a tool of its own.
    act('rest', { stand: true }, { optional: true, why: 'a resting player cannot cast at all' }),
    ...loop('identify', casts, maxMana),
  ].map(s => (item && s.tool === 'cast' ? { ...s, args: { ...s.args, target: item } } : s)),
});

// HOLY RESOLVE — the cheapest mana in the school and the best odds, gated only by its reagents.
//
// 3 mana and inc 35, with no CanPayCosts at all. On mana alone it would be the obvious answer.
// The catch is solagh and fairy wing rather than the emerald/herb/elderberry family, and those
// are not on the bulk shelves — which is why the operator's triple does not include it.
export const holyResolve = ({ casts = 20, maxMana = 65 } = {}) => ({
  why: '3 mana and inc 35 — the best odds per cast in the school, if the reagents can be found',
  partner: null,
  buy: [['solagh', casts], ['fairy wing', casts]],
  steps: loop('holy resolve', casts, maxMana),
});

// CURE DISEASE — NOT PRACTISABLE, AND THIS IS THE FUNCTION THAT SAYS SO.
//
// It is in the file precisely because it looks like the best rung on paper: inc 40, the highest
// in the third level, 9 mana, herb-and-elderberry reagents that the fleet buys by the hundred.
// And it cannot be drilled: `cdisease.kod` requires the target be a User that
// `IsEnchanted #byClass=&Disease`, and refuses otherwise. Nineteen points of Loial's 67 sit
// here, frozen, because nothing in the fleet has been diseased since he learned it.
//
// A function that refuses with the reason is worth more than an absent function, because the
// absent one gets rediscovered by a hundred silent casts.
export const cureDisease = () => ({
  why: 'inc 40 and cheap reagents, and unusable: it refuses any target that is not diseased',
  partner: 'somebody genuinely diseased — not obtainable on demand',
  buy: [],
  steps: [verify(() => false,
      'cure disease refuses any target not enchanted by &Disease (cdisease.kod), before taking ' +
      'mana or reagents. There is no way to drill it on a healthy fleet. If it is in your best ' +
      'three, the points have to come from elsewhere — which for the level-4 gate means ' +
      'spiritual hammer or rescue overtaking it.')],
});

export const PRACTICE = Object.freeze({
  'rescue': rescue,
  'spiritual hammer': spiritualHammer,
  'hospice': hospice,
  'identify': identify,
  'holy resolve': holyResolve,
  'holy weapon': holyWeapon,
  'cure disease': cureDisease,
});

// WHAT A LONE CASTER CAN DRILL, which is the question actually being asked when somebody wants
// to raise a school level. Derived from the table rather than listed by hand, so a spell whose
// gate is corrected in one place stops appearing here.
export const soloDrillable = (level = null) =>
  Object.entries(SHALILLE)
    .filter(([n, s]) => s.gate === null && s.targets === 0 && (level === null || s.level === level))
    .sort((a, b) => b[1].inc - a[1].inc)
    .map(([n, s]) => ({ spell: n, level: s.level, mana: s.mana, inc: s.inc, reagents: s.reagents }));

export const script = {
  name: 'practice-shalille',
  provenance: {
    pinned: 'fffa0c3', verified: '2026-09-10',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-broker.mjs', 'tools/m59-autopilot.mjs'],
  },
  describe: "Drill one Shal'ille spell, with that spell's own cast gate enforced up front.",
  recipe: {
    effect: "Raises ONE Shal'ille ability by repeated casting, and refuses up front when that " +
            "spell cannot be drilled by a lone caster. The point is the per-spell gate: a " +
            "generic cast loop reports a hundred successes and moves nothing, because a cast " +
            "that fails CanPayCosts is refused before it takes mana, takes reagents, or says " +
            "anything on the wire.",
    run: 'practice-shalille agents=<who> spell=<name> casts=<n> maxMana=<n>',
    needs: ['the spell already known — this drills, it does not teach',
            'the reagents for it, per cast, which --list prices',
            "for hospice, a named partner who is genuinely wounded",
            'mana: the loop rests at the end of every bar, sized from maxMana'],
    cost: { time: 'about 25s a cast for rescue (the teleport timer), a few seconds otherwise',
            money: 'rescue 1 emerald/cast; spiritual hammer 2 emeralds + 1 orc tooth/cast; ' +
                   'hospice 3 herbs/cast. Emeralds are bulk-buyable — the Tos banker lists ' +
                   'them at #number=15, the same signature as the apothecary\'s bulk herbs',
            risk: 'none in a town: no target spell needs an enemy, and rescue teleports HOME',
            measured: 'ESTIMATE for the run rate. What IS measured (2026-09-10, Loial the ' +
                      'Ogier): net ~17% advance per cast across a night of hospice, and ' +
                      'hospice 31 + cure disease 19 + identify 17 = 67 of the 115 the level-4 ' +
                      'gate wants' },
    scales: 'Cost per POINT rises as the ability rises, so three spells at 26 are much cheaper ' +
            'than one at 79 and are worth exactly the same to the gate, which reads the best ' +
            'THREE at the level below. Spread, do not grind.',
    notes: ["The level-4 gate is 115 across the best three level-3 abilities, and it is also " +
            "karma-gated at level x 10 — 40 for level 4, 50 for Reveal.",
            "Rescue is the only rung that pays the advancement cap back: ADVANCEMENT_LIMIT is " +
            "10 and a room change refunds 2 (player.kod:1465, 'give them a break on the " +
            "botting imp cap'), and every rescue teleports the caster, so the loop refunds up " +
            "to 4 against the 1 it spends. It buys that with the lowest inc in the level, 10.",
            "Spiritual hammer has NO CanPayCosts at all and inc 20 — the highest-rate level-3 " +
            "spell a caster can drill with nobody else present.",
            "cure disease looks like the best rung (inc 40, cheap reagents) and cannot be " +
            "drilled at all; the function for it exists to say so."],
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'who is practising' },
    spell: { type: 'string', required: true, describe: 'which spell — see --list' },
    casts: { type: 'number', default: 20, describe: 'how many attempts to plan' },
    maxMana: { type: 'number', default: 65,
               describe: 'the caster\'s mana ceiling; sizes the rest interval. Read it from a ' +
                         'settled keeper, not a fresh login — ComputeMaxMana re-sums the node ' +
                         'bitmask every time and a just-joined session reads low' },
    patient: { type: 'string', default: null, describe: 'for hospice: who is wounded' },
    item: { type: 'string', default: null, describe: 'for identify: which weapon or armour' },
    home: { type: 'number', default: 48, describe: 'for rescue: the room the teleport lands in' },
    outside: { type: 'number', default: 47, describe: 'for rescue: the room to step out to' },
    minHealth: { type: 'number', default: 1 },
  },
  async steps(p) {
    const key = String(p.spell || '').toLowerCase();
    const make = PRACTICE[key]
      ?? PRACTICE[Object.keys(PRACTICE).find(k => k.startsWith(key)) ?? ''];
    if (!make)
      return [verify(() => ({ ok: false,
          why: `no practice function for "${p.spell}". Practisable: ${Object.keys(PRACTICE).join(', ')}. ` +
               `A spell missing from that list is missing on purpose — either it needs a target ` +
               `nobody can produce on demand, or nobody has written its gate down yet.` }),
          'unknown spell')];
    return make(p).steps;
  },
};
