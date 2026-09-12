#!/usr/bin/env node
// TWO SOURCES SEE WHAT ONE CANNOT — offline, no socket, no fleet, no roster:
//
//   node tools/m59-corroborate-test.mjs
//
// WHAT THIS PINS, AND I AM THE INCIDENT AGAIN. I argued in writing that the FABRICATED face of
// tonight's bug class could have no reader-side guard — a synthesised value is present,
// correctly typed, in the right field and internally consistent, so nothing is left to test —
// and concluded it could only be refused at the point of manufacture.
//
// That is true of one source and false of two. Measured on prod the same hour:
//
//     equipment  hammer  id = -1     (synthesised by KeeperProxy.equipment())
//     inventory  hammer  id = 8789   (the server's)
//
// Undetectable inside the first reply, unmistakable across the pair. And it is the move that
// found everything else tonight: the rarity field (a sweep said "nothing unidentified" while
// the keeper's own state showed two), the `look_at` race (the id asked for and the id returned
// disagreed). Nobody found any of them by reading one answer harder.
import { corroborate, usableId, wornItemId, answeredWhatWasAsked,
         AGREED, DISAGREED, UNCORROBORATED, ABSENT } from './m59-corroborate.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
};
const eq = (label, got, want) =>
  ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

console.log('\ntwo sources, three verdicts');
{
  eq('agreement', corroborate([{ from: 'a', value: 7 }, { from: 'b', value: 7 }]).verdict, AGREED);
  eq('disagreement', corroborate([{ from: 'a', value: 7 }, { from: 'b', value: 9 }]).verdict, DISAGREED);
  // THE VERDICT THAT MUST NOT READ AS SUCCESS. One source cannot corroborate itself, and this
  // is precisely the state a fabricated value sits in when nobody thought to ask twice.
  eq('one source is UNCORROBORATED, not agreed',
     corroborate([{ from: 'a', value: 7 }]).verdict, UNCORROBORATED);
  ok('and it says why one is not enough',
     /cannot be corroborated/.test(corroborate([{ from: 'a', value: 7 }]).why));
  eq('nothing carries it at all', corroborate([{ from: 'a', value: null }]).verdict, ABSENT);
  eq('nothing asked', corroborate([]).verdict, ABSENT);
}

console.log('\nabsent is not disagreement — a different bug, a different fix');
{
  // `equipment` dropping `rarity` is the WRONG-PATH face; `equipment` inventing an id is this
  // one. Reporting them as the same thing sends the reader to the wrong remedy.
  const r = corroborate([{ from: 'equipment', value: null }, { from: 'inventory', value: 8789 }]);
  eq('a silent source does not create a conflict', r.verdict, UNCORROBORATED);
  eq('and the silent one is named', r.silent, ['equipment']);
  ok('the surviving value is still reported', r.value === 8789);
}

console.log('\nthe prod case, exactly as measured');
{
  const r = usableId([{ from: 'equipment', value: -1 }, { from: 'inventory', value: 8789 }]);
  ok('a synthesised id is refused', r.ok === false);
  ok('and the reason names it as an array index, not a bad id',
     /array index/.test(r.why), r.why.slice(0, 70));
  ok('no id is handed back at all', r.id === null);

  // THE NEGATIVE TEST IS A TELL, NOT THE RULE. A synthesiser counting UPWARD would defeat it,
  // and corroboration still catches that — which is the whole reason the general check exists
  // underneath the cheap one.
  const upward = usableId([{ from: 'equipment', value: 1 }, { from: 'inventory', value: 8789 }]);
  ok('an upward-counting fake is caught by disagreement alone', upward.ok === false);
  eq('and it reads as a disagreement', upward.verdict, DISAGREED);

  const good = usableId([{ from: 'equipment', value: 8789 }, { from: 'inventory', value: 8789 }]);
  ok('two honest sources agreeing is usable', good.ok === true && good.id === 8789);

  // One source, even an honest-looking one, is not enough to act on.
  ok('a lone id is refused', usableId([{ from: 'inventory', value: 8789 }]).ok === false);
}

console.log('\nresolving a worn item, which needs both paths and has neither alone');
{
  const equipment = [{ id: -1, name: 'hammer' }];
  const inventory = [{ id: 8789, name: 'hammer' }, { id: 8790, name: 'shilling' }];
  const r = wornItemId('hammer', { equipment, inventory });
  ok('the fabricated id is still refused', r.ok === false);
  ok('and it explains rather than just failing', /array index/.test(r.why));

  eq('an item that is not worn is ABSENT, not a conflict',
     wornItemId('scimitar', { equipment, inventory }).verdict, ABSENT);

  // AMBIGUITY IS NOT AN ANSWER. Two hammers in the pack and the name cannot say which is in
  // hand; picking the first would be a fabrication of our own, committed by the guard against
  // fabrication.
  const two = wornItemId('hammer', {
    equipment, inventory: [{ id: 8789, name: 'hammer' }, { id: 9001, name: 'hammer' }] });
  ok('two items of the same name refuses', two.ok === false);
  ok('and says choosing one would invent the answer', /invent the answer/.test(two.why));
}

console.log('\ndid this reply answer MY question');
{
  ok('matching ids pass', answeredWhatWasAsked({ asked: 8325, got: 8325 }).ok === true);
  const race = answeredWhatWasAsked({ asked: 8325, got: 8334 });
  ok('the look_at race is caught', race.ok === false);
  ok('and the reason carries the measurement', /two calls in nine/.test(race.why));
  ok('a reply with no id cannot be matched', answeredWhatWasAsked({ asked: 8325, got: null }).ok === false);
  ok('and neither can a request with none', answeredWhatWasAsked({ got: 8325 }).ok === false);
  ok('string and number ids compare equal', answeredWhatWasAsked({ asked: '8325', got: 8325 }).ok === true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
