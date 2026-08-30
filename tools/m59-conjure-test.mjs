#!/usr/bin/env node
// CAN AN UNARMED CHARACTER GET A WEAPON, OR DOES IT WAIT FOR THE WRONG THING FOREVER?
//
//   node tools/m59-conjure-test.mjs
//
// Offline. Reads source; opens no socket, joins nobody.
//
// WHY THIS FILE EXISTS. Beaker and Janice stood in the Valley of Ileria for 3.6 hours,
// unarmed, casting `create weapon` and producing nothing. Measured 2026-08-29 from the
// keeper's own spellbook:
//
//     create weapon: cast 5194, produced 0, worked 0%, mana_spent 56
//     refusal: UNARMED_NO_DONOR "unarmed -- 25 mana, needs 15 to make one"
//     mana 25/25 (FULL)   vigor 1   rests 0   kills in 8h: 0
//
// Five thousand casts spending 56 mana between them. The refusal blamed mana, and mana
// was full to its maximum the whole time.
//
// THE REAL GATE IS VIGOR, AND IT IS CHECKED BEFORE MANA. spell.kod:597 CanPayManaVigor:
//
//     % Make sure caster is not too tired
//     if (NOT Send(who,@HasVigor,#amount=viSpellExertion))     % viSpellExertion = 13
//        Send(who,@MsgSendUser,#message_rsc=spell_too_tired,#parm1=vrName);
//        return FALSE;                    <-- returns BEFORE the mana check, spends nothing
//
// So a character under 13 vigor cannot cast at all, and the refusal costs no mana — which
// is indistinguishable, from the keeper's side, from a cast that was never sent. That is
// why `mana_spent` read 56 across 5194 attempts and why the failure looked like a mystery
// rather than a precondition.
//
// AND THAT IS A DEADLOCK, not merely a bad message. The unarmed branch runs AHEAD of the
// rest branch on purpose — being unarmed is why the fight is going badly — so it returns
// HANDLED every pass. It concludes "not enough mana", sits down to wait for mana, and
// vigor is the thing that never comes back. `rests: 0` while vigor sat at 1.
//
// These are source assertions because the behaviour needs a live server and this must be
// runnable on a clone with no fleet. It should fail the day somebody makes `makeWeapon`
// check mana without checking vigor again.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const auto = readFileSync(join(HERE, 'm59-autopilot.mjs'), 'utf8');

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '  — ' + extra : ''}`); }
};

const makeWeapon = (() => {
  const i = auto.indexOf('async makeWeapon(');
  return i === -1 ? '' : auto.slice(i, i + 5200);
})();

console.log('the exertion cost is named, not inlined');
{
  ok('SPELL_EXERTION_VIGOR is a named constant',
     /const SPELL_EXERTION_VIGOR = 13;/.test(auto));
  // A bare 13 in a comparison is unreadable and un-greppable the next time the kod moves.
  ok('and it cites the kod that sets it',
     /viSpellExertion/.test(auto) && /spell\.kod/.test(auto));
}

console.log('\nmakeWeapon checks vigor, and checks it BEFORE spending a cast');
{
  ok('makeWeapon was found', makeWeapon.length > 0);
  ok('it reads vigor at all', /vigorOf\(c\.vitals\?\.\(\)\)|vitals\?\.\(\)\?\.vigor/.test(makeWeapon),
     'makeWeapon still only looks at mana');
  ok('it declines when vigor is under the exertion cost',
     /< SPELL_EXERTION_VIGOR/.test(makeWeapon));
  // ORDER MATTERS. The server checks vigor first; checking mana first here would report
  // "not enough mana" for a character with full mana, which is the original bug verbatim.
  const vigorAt = makeWeapon.search(/< SPELL_EXERTION_VIGOR/);
  const castAt = makeWeapon.indexOf("pacer.submit('cast'");
  ok('and it does so before the cast goes out', vigorAt > -1 && castAt > -1 && vigorAt < castAt);
  // The decline must be honest about WHICH precondition failed, because the remedy
  // differs: mana comes back by waiting, vigor comes back by RESTING or EATING.
  ok('the decline says too tired, not "not enough mana"',
     /'too tired'/.test(makeWeapon));
  ok('and reports the vigor it had against what it needed',
     /needs: SPELL_EXERTION_VIGOR/.test(makeWeapon));
}

console.log('');
console.log('and it will not pay 15 mana for a weapon the pack cannot hold');
{
  // creaweap.kod:116-129 — ReqNewHold fails, the weapon is Deleted, and the mana is
  // already gone. Beaker had 57 bulk free and Janice 12 against a scimitar's 70, so
  // fixing only the vigor gate would have moved the stall one step along.
  ok('the largest conjurable weapon is a named constant',
     auto.includes('const CONJURED_WEAPON_BULK = 70;'));
  ok('and it cites the spell that rolls between them', auto.includes('creaweap.kod'));
  ok('makeWeapon asks how much room there is',
     makeWeapon.includes('skills.carryCapacity(c)'));
  ok('and declines when it positively knows there is not enough',
     makeWeapon.includes('bulkFree < CONJURED_WEAPON_BULK'));
  // The asymmetry matters: room_for is withheld whenever the load is inexact, and
  // refusing on that silence would strand the same characters a different way.
  ok('but an UNKNOWN load still attempts the cast, rather than deadlocking again',
     makeWeapon.includes('bulkFree != null && bulkFree < CONJURED_WEAPON_BULK'));
}

console.log('\nthe unarmed branch names the blocker it is actually waiting on');
{
  const branch = (() => {
    const i = auto.indexOf("this.refuse('UNARMED_NO_DONOR'");
    return i === -1 ? '' : auto.slice(Math.max(0, i - 9000), i + 2500);
  })();
  ok('the unarmed branch was found', branch.length > 0);
  // The whole failure was a character waiting for a resource it already had a maximum of.
  ok('it distinguishes a vigor block from a mana block',
     /blocker/.test(branch) && /SPELL_EXERTION_VIGOR/.test(branch),
     'the branch still assumes mana is the only thing that can be missing');
  ok('the wait code says vigor when vigor is what is missing',
     /VIGOR_FOR_CREATE_WEAPON/.test(branch));
  ok('and the refusal text stops hard-coding the mana story',
     !/needs 15 to make one`/.test(branch) || /blocker/.test(branch));
}

console.log('');
console.log('and the blocker that is actually biting is named, not guessed');
{
  const branch = (() => {
    const j = auto.indexOf("this.refuse('UNARMED_NO_DONOR'");
    return j === -1 ? '' : auto.slice(Math.max(0, j - 4000), j + 2000);
  })();
  // Measured on prod 2026-08-30: Gonzo, Rowlf and Janice were unarmed with vigor and mana
  // well over the bar and 40-60 bulk free against a scimitar's 70. makeWeapon declined
  // 3762/3183/1020 times with 'no room for the weapon' — correctly, spending nothing —
  // while the refusal still read 'unarmed — 33 mana, needs 15 to make one'. Right refusal,
  // wrong reason, which sends an operator after mana that was never short.
  ok('there is a third blocker for pack room', branch.includes("? 'room'"));
  ok('it is measured against the same constant the cast uses',
     branch.includes('bulkFreeNow < CONJURED_WEAPON_BULK'));
  ok('the refusal names bulk when bulk is what is missing',
     branch.includes('no room to hold one'));
  // Vigor and mana return on their own; pack space does not. A waitFor here would promise
  // something nothing intends to deliver.
  ok('and it does NOT register a wait, because pack space never arrives on its own',
     (() => {
       const at = branch.indexOf("blocker === 'room'");
       if (at < 0) return false;
       const next = branch.indexOf('} else if', at);
       const body = branch.slice(at, next < 0 ? at + 600 : next);
       return !body.includes('waitFor(');
     })());
  ok('the remedy says what a human has to do', branch.includes('sell, drop or hand over'));
}

console.log('\nand a character blocked on vigor actually rests');
{
  // THE DEADLOCK IS NOT THE MESSAGE, IT IS THE INACTION. `rests: 0` while vigor sat at 1
  // for 3.6 hours: settle() would not settle in a spawn room, the sit-anywhere fallback
  // was gated on sanctuary(), and so the branch did nothing at all every pass. Whatever
  // else changes, an unarmed character that cannot cast for want of vigor has to end its
  // pass having tried to recover some.
  const branch = (() => {
    const i = auto.indexOf("this.refuse('UNARMED_NO_DONOR'");
    return i === -1 ? '' : auto.slice(Math.max(0, i - 9000), i + 2500);
  })();
  // Assert the CONDITION, not the prose: the guard must fire on vigor and must not
  // require sanctuary(), and it must actually submit a rest. Matching comment wording
  // instead would pass the day somebody deletes the rest and keeps the sentence.
  // Assert the CONDITION, not the prose: the guard must fire on vigor and must not
  // require sanctuary(), and a rest must actually follow it. Matching comment wording
  // would pass the day somebody deletes the rest and keeps the sentence.
  const guard = "vigorLeft < SPELL_EXERTION_VIGOR && !sat?.settled && !this.sanctuary()";
  ok('the last-resort sit is guarded on vigor, not on sanctuary',
     branch.includes(guard), 'a spawn-room character still ends the pass standing');
  ok('and a rest actually follows that guard',
     branch.includes(guard) &&
     branch.indexOf("pacer.submit('rest'", branch.indexOf(guard)) > branch.indexOf(guard));
  // Sitting next to something that is hitting us is a worse bug than standing still.
  ok('but only when nothing is near enough to reach it',
     branch.includes('t.near?.length') && branch.includes('t.adjacent?.length'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
