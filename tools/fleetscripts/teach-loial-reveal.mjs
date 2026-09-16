// BUY ONE SPELL FROM A TEACHER WHO WILL NOT STAND STILL.
//
// PUBLIC. Operator, 2026-09-11: "have Loial learn 'Reveal', the level 5 Shal'ille spell, from
// Jonas in the Jasper pub". This is `learn-skill` narrowed to that errand, and it exists as its
// own file because three of the facts below are specific to this teacher and would be wrong as
// defaults anywhere else.
//
// WHAT THE KOD SAYS, since all of it was checked rather than assumed:
//
//   THE SPELL      `reveal.kod`: viSpell_num SID_REVEAL, viSchool SS_SHALILLE, viSpell_level 5,
//                  viMana 30. The operator's description was exact.
//   THE TEACHER    SID_REVEAL appears in exactly two teach lists in the whole tree, and both
//                  belong to "Jonas D'Accor" — `rebel.kod` (the Rebel liege) and `jGeneral.kod`
//                  (the Jealous General). So Jonas is right, and he is the ONLY teacher of it.
//   THE GATE       `SpecialTeachChecks` (jGeneral.kod:131) refuses exactly two people: someone
//                  who already has the spell, and a PFLAG_MURDERER. There is no faction
//                  requirement, which is the thing worth checking about a faction leader.
//
// AND THE FACT THAT SHAPES THE SCRIPT: HE IS A WANDERER. `JealousGeneral is Wanderer` with
// plDestinations across FIVE rooms — RID_JAS_ELDER_HUT, RID_TEMPLE_KRAANAN, RID_JAS_BAR (371,
// Pietro's Wicked Brews), RID_BAR_BAR and RID_COR_INN. The pub is where the operator last saw
// him and where he is most often, but "walk to 371 and buy" is a coin flip dressed as a plan.
// So the shop list is read where we land, and a Jonas who is not there is reported as a
// MISSING TEACHER rather than as a failed purchase. Those are different errands to re-run.
//
// WHY THE `learn` VERB AND NOT A SHOP CALL. It asks whether the ability is already held before
// it buys (so a re-run is `already_held` rather than a second charge), it reads the live shop
// list and returns `not_offered` when the row is absent, and it writes a `learn_attempt` ledger
// row whatever happens. That last one matters here: on 2026-09-07 a character standing with
// Rook, with the ability in the live list at 500, was charged 500 and never received it. The
// verb refuses the SECOND attempt for that reason, which is the difference between paying once
// by accident and paying every sweep for ever.
//
// `not_offered` IS ALSO THE LEARNABILITY TEST, AND DELIBERATELY SO. PlayerCanLearn gates level
// N on the best THREE abilities at level N-1, and a spell a character has not earned is simply
// absent from the list — the server says nothing. Loial holds four level-4 Shal'ille spells
// (mark of dishonor, dazzle, purify, forces of light), so the operator's "he can get the next
// level" is plausible; but the keeper's spell rows carry no ability values (`{id, name, school,
// targets}`), so it cannot be computed from here. The shelf is the only honest oracle, and a
// refusal that names the room and the teacher is a better answer than a guess either way.
//
// WHAT THIS MUST NEVER DO: CAST RESCUE. Loial knows `rescue`, and the operator changed his
// hometown to Barloque on 2026-09-11 — so the spell that used to be a free ride to Jasper now
// teleports him to the wrong town entirely. Nothing here calls it, `leaveRaza` is not imported,
// and the journey is two rooms inside one town precisely so that no escape verb is ever wanted.
import { walk, learn, verify, bank } from '../m59-fleetscript.mjs';

const JASPER_BANK = 376;      // The Royal Bank of Jasper — Yevitan
const JASPER_PUB = 371;       // Pietro's Wicked Brews — RID_JAS_BAR, one of Jonas's five haunts
const JASPER_INN = 370;       // Yonder Inn of Jasper — where Loial is parked on the karma pump
const TEACHER = "Jonas D'Accor";
const SPELL = 'reveal';

export const script = {
  name: 'teach-loial-reveal',
  provenance: {
    pinned: '2993127', verified: '2026-09-11',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-broker.mjs'],
  },
  describe: 'Walk Loial to the Jasper pub and buy Reveal from Jonas, proving he came away with it.',
  recipe: {
    effect: 'Buys the level-5 Shal\'ille spell "reveal" from Jonas D\'Accor and reads the spell ' +
            'list back to prove it landed. Reports a missing teacher and an unlearnable spell ' +
            'as two different refusals, because they need two different follow-ups.',
    run: 'teach-loial-reveal agents=hk1 [room=371] [home=370]',
    needs: ['the money already in his purse — this buys, it does not fund. Run fund-loial first',
            'Jonas actually standing in the room: he wanders across five of them',
            'Loial to be learnable at level 5, which only the teacher\'s shelf can answer'],
    cost: { time: '1-3 minutes, both rooms inside Jasper',
            risk: 'very low — no open country, and Loial keeps his pack on death (bNo_drop_death)',
            measured: 'not yet run — first outing' },
    scales: 'One character, one spell. Any other spell is learn-skill with different arguments.',
    notes: ['Loial is a 20-max-health body and must stay held; the lease is what stops his ' +
            'keeper walking him out of town the moment this finishes.',
            'Never cast rescue on him — his hometown is Barloque now, so it is a ride to the ' +
            'wrong town rather than a way home.'],
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'the learner — hk1 (Loial the Ogier)' },
    room: { type: 'number', default: JASPER_PUB, describe: 'where to look for Jonas' },
    home: { type: 'number', default: JASPER_INN, describe: 'where the learner ends up' },
    stay: { type: 'boolean', default: false, describe: 'stay with the teacher instead of going home' },
    // HOW MUCH TO CARRY TO THE COUNTER, AND WHY THERE IS A WITHDRAWAL STEP AT ALL.
    //
    // Loial's `bankAbove` is 500 against a `walkingMoney` of 400, so his keeper banks anything
    // above 400 within seconds of it landing. Measured 2026-09-11: Camilla handed him 40,000 at
    // 03:46:36 and his own keeper deposited it at 03:46:47 — eleven seconds — taking his account
    // from 1,643 to 41,643. His purse never showed the gift at all.
    //
    // That is correct behaviour for a 20-max-health body that must not carry a fortune around,
    // and it means a funded character arrives at a teacher BROKE. The money has to be drawn
    // inside the same held run that spends it, which is what this step is.
    purse: { type: 'number', default: 5000,
             describe: 'shillings to draw before buying — his keeper re-banks anything over 400' },
  },
  async steps({ room, home, stay, purse }) {
    // A BOOLEAN PARAMETER CANNOT BE TURNED OFF FROM THE REPL. `parseArgs` stores every k=v as a
    // STRING, so `stay=false` arrives as "false", which is truthy. Coerced here rather than
    // documented, because a switch that silently does nothing is worse than no switch.
    const on = v => !(v === false || v === 'false' || v === '0' || v === 'no' || v === 0);
    stay = on(stay);
    return [
      // The counter first: he is standing in it already, and a spell bought with an empty
      // purse is a walk across town for a refusal nobody reads.
      walk(JASPER_BANK),
      bank('withdraw', Number(purse)),

      walk(Number(room)),

      // IS THE TEACHER EVEN HERE? Asked before buying so that "Jonas is elsewhere today" and
      // "Loial has not earned level 5" are never the same message. `learn` would report the
      // first as `not_offered`, which reads exactly like the second and would send somebody
      // after the wrong thing — probably after the operator, to ask about spell levels, when
      // the answer is to wait ten minutes for a wanderer to come back.
      verify(async ({ agent, call }) => {
        const here = await call('status', { agent }, 60_000).catch(() => null);
        const objs = here?.objects ?? here?.room?.objects ?? [];
        const seen = objs.map(o => String(o?.name ?? ''));
        return seen.some(n => /jonas/i.test(n));
      }, `${TEACHER} is standing in room ${room} — he is a wanderer with five haunts`),

      // Buys only if the row is on the shelf; `already_held` if he has it; `not_offered` with
      // the teacher and the ability named if he cannot learn it yet. No price is passed
      // because the verb reads the live list and buys that row's id — a price written here
      // would be a second opinion about a number the shelf already states.
      learn(TEACHER, SPELL),

      // READ THE CHARACTER, NOT THE REPLY. A spell purchase is silent on both paths —
      // monster.kod:3865 adds it and says nothing, while every refusal above it speaks — so
      // the spell list is the only evidence there is, and the `learn` verb's own poll can
      // still be racing a lagging ability push. One more look, from outside the verb.
      verify(async ({ agent, call }) => {
        const a = await call('abilities', { agent, kind: 'both', refresh: true }, 60_000)
          .catch(() => null);
        const names = [...(a?.skills ?? []), ...(a?.spells ?? [])]
          .map(x => String(x?.name ?? '').toLowerCase());
        return names.includes(SPELL);
      }, `Loial's own spell list now contains "${SPELL}"`),

      ...(stay ? [] : [walk(Number(home))]),
    ];
  },
};
