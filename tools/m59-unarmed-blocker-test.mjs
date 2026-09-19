#!/usr/bin/env node
// A REFUSAL MUST NEVER NAME A PRECONDITION THAT IS ALREADY SATISFIED.
// Offline: no broker, no socket, no roster, no fleet.
//
// `passArm` classifies why an unarmed character cannot conjure a weapon. The chain names the
// preconditions it knows about — vigor, mana, pack space — and calls the leftover case
// `neither`. `neither` was reported as `mana`, so a character with ALL THREE sufficient was
// told it needed mana it already had, and `waitFor('MANA_FOR_CREATE_WEAPON')` promised a wait
// for something that had already happened.
//
// THAT IS NOT COSMETIC, AND THIS IS THE PART WORTH PINNING. `m59-supervise.mjs` — the 60s
// UNSTICK layer, the only thing in this repository that can act on a keeper that cannot act
// on itself — SKIPS any character refusing UNARMED_NO_DONOR:
//
//     "leaving <character> alone: ... (waiting for casting mana — churning the keeper
//      restarts the decision, not the wait)"
//
// which is exactly right below the bar and exactly wrong above it. So the misclassification
// did not merely mislead a reader; it matched the skip and disabled the layer whose job was
// to catch it. Measured on prod 2026-09-19: Animal, standing in The Bookmaker's Guild House
// with 23 mana against a bar of 15, `stuck.seconds` 25122 — SEVEN HOURS — `repeats` 22155,
// refusing "unarmed — 23 mana, needs 15 to make one" the whole time. Beaker the same at 25.
//
// The fix is a distinct CODE rather than a better sentence, because the supervisor reads
// codes as data and a regex over prose can always be matched back into the old branch.
import { unarmedBlocker } from './m59-autopilot.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

// The real bars, stated here rather than imported, so this suite pins the arithmetic it
// depends on instead of trusting a constant to still mean what it meant.
const BARS = { vigorNeeded: 30, manaNeeded: 15, bulkNeeded: 70 };

console.log('\nTHE CASE THAT COST SEVEN HOURS: NOTHING IS SHORT');
{
  const r = unarmedBlocker({ vigor: 80, mana: 23, bulkFree: 567, ...BARS,
                             declinedWhy: 'every weapon it could make is banned' });
  ok('classifies as neither, not mana', r.blocker === 'neither', r.blocker);
  ok('gets its OWN refusal code', r.code === 'UNARMED_CANNOT_CAST', r.code);
  ok('and is NOT the code the supervisor skips', r.code !== 'UNARMED_NO_DONOR');
  ok('issues no wait — nothing it is short of will arrive', r.wait === null, String(r.wait));
  ok('and carries the reason the cast was actually declined',
     r.declinedWhy === 'every weapon it could make is banned', String(r.declinedWhy));
}
{
  // Animal's exact numbers.
  const r = unarmedBlocker({ vigor: 80, mana: 23, bulkFree: 567, ...BARS });
  ok("Animal's own reading no longer says 'mana'", r.blocker !== 'mana', r.blocker);
  ok('...and the declined reason is null rather than invented when nothing recorded one',
     r.declinedWhy === null);
}

console.log('\nTHE THREE REAL SHORTFALLS STILL CLASSIFY AS THEY DID');
{
  const v = unarmedBlocker({ vigor: 5, mana: 99, bulkFree: 999, ...BARS });
  ok('too tired is vigor, and vigor is a wait', v.blocker === 'vigor' && v.wait === 'VIGOR_FOR_CREATE_WEAPON');
  ok('and it keeps the code the supervisor knows', v.code === 'UNARMED_NO_DONOR');

  const m = unarmedBlocker({ vigor: 80, mana: 4, bulkFree: 999, ...BARS });
  ok('below the bar is mana, and mana is a wait', m.blocker === 'mana' && m.wait === 'MANA_FOR_CREATE_WEAPON');
  ok('and it keeps the code the supervisor knows', m.code === 'UNARMED_NO_DONOR');

  const b = unarmedBlocker({ vigor: 80, mana: 99, bulkFree: 10, ...BARS });
  ok('no pack space is room', b.blocker === 'room');
  // Nothing regenerates pack space, so a wait here would be the same false promise in a
  // different noun. It keeps the old code because an operator still has to hand it space.
  ok('and room is NOT a wait — nothing regenerates bulk', b.wait === null, String(b.wait));
}

console.log('\nORDER OF PRECEDENCE — THE SERVER CHECKS VIGOR BEFORE MANA, SO THIS DOES TOO');
{
  const r = unarmedBlocker({ vigor: 5, mana: 4, bulkFree: 10, ...BARS });
  ok('everything short reports VIGOR first', r.blocker === 'vigor', r.blocker);
}
{
  const r = unarmedBlocker({ vigor: 80, mana: 4, bulkFree: 10, ...BARS });
  ok('mana beats room when both are short', r.blocker === 'mana', r.blocker);
}

console.log('\nAN UNREADABLE BAR IS NOT A SHORTFALL');
{
  // A null reading is "no such bar", not "empty". Treating it as empty is how a character
  // gets retired by a missing field — the same family as `vigorPct` returning null.
  const r = unarmedBlocker({ vigor: null, mana: null, bulkFree: null, ...BARS });
  ok('nulls do not manufacture a shortfall', r.blocker === 'neither', r.blocker);
  ok('and it still refuses rather than claiming it can cast', r.code === 'UNARMED_CANNOT_CAST');
}

console.log('\nTHE INVARIANT, STATED AS ITSELF');
{
  // The whole defect in one sentence: if the named blocker is a bar, that bar must actually
  // be under its threshold. Swept across a grid so a future edit cannot reintroduce it in one
  // corner.
  let violations = 0, checked = 0;
  for (const vigor of [0, 29, 30, 80])
    for (const mana of [0, 14, 15, 25])
      for (const bulkFree of [0, 69, 70, 600]) {
        const r = unarmedBlocker({ vigor, mana, bulkFree, ...BARS });
        checked++;
        const lying = (r.blocker === 'vigor' && vigor >= BARS.vigorNeeded)
                   || (r.blocker === 'mana'  && mana  >= BARS.manaNeeded)
                   || (r.blocker === 'room'  && bulkFree >= BARS.bulkNeeded);
        if (lying) { violations++; console.log(`        lies at vigor=${vigor} mana=${mana} bulk=${bulkFree} -> ${r.blocker}`); }
      }
  ok(`no reading names a satisfied precondition (${checked} combinations)`, violations === 0,
     violations + ' violation(s)');
  // And the converse: a genuine shortfall is never called `neither`, which would send it to
  // the no-wait branch and strand a character that only needed to sit down.
  let missed = 0;
  for (const vigor of [0, 29])
    for (const mana of [0, 14])
      for (const bulkFree of [0, 69]) {
        const r = unarmedBlocker({ vigor, mana, bulkFree, ...BARS });
        if (r.blocker === 'neither') missed++;
      }
  ok('and a genuine shortfall is never classified as neither', missed === 0, String(missed));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
