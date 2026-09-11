#!/usr/bin/env node
// ITEM NAMES: DID YOU MEAN. Offline, opens no socket and joins nobody.
//
//   node tools/m59-itemcheck-test.mjs
//
// A wrong item name is the quietest fault here, because it is not rejected where it is
// WRITTEN — it is rejected where it is USED, and it takes everything around it with it. One
// unresolvable entry rejects the whole autopilot order: "magic wand" (the item is "wand")
// threw away every station change, hunt list and weapon ban computed for sixteen of
// twenty-one characters on 2026-09-10, and the symptom was orders that looked correct and
// reached nobody.
//
// THE NEAR MISS IS THE OTHER HALF AND IT NEVER FAILS AT ALL. `herb` and `herbs` both
// resolve, because itemNameKey folds the plural — so one directory can hold both spellings of
// one item, every file works, and a tally keyed on the string reads zero. That is not an
// error and must not be reported as one; it is reported as a DISAGREEMENT.
import assert from 'node:assert/strict';
import { checkItemName, suggestItemName, resolveItemName } from './m59-items.mjs';

let n = 0;
const ok = (what, cond) => { assert.ok(cond, what); n++; };
const suggests = (typo, wanted) => {
  const s = suggestItemName(typo);
  ok(`"${typo}" suggests "${wanted}"`, s.includes(wanted));
};

// ---------------------------------------------------------------- the real mistakes
// Every one of these is a name somebody actually wrote into this fleet's own config.
suggests('herbz', 'herb');
suggests('hamer', 'hammer');
suggests('elder berry', 'elderberry');
suggests('knightshield', "knight's shield");
suggests('yrxlsap', 'yrxl sap');
suggests('inky cap', 'Inky-cap mushroom');
suggests('ore chunk', 'chunk of ore');
suggests('nerudite ore chunk', 'chunk of nerudite');
suggests('solagh', 'vial of solagh');
suggests('simple helm', 'helm');
// The one that cost a night: a qualifier nobody dropped. No edit distance would rank these
// together — it is the shared whole word that does it.
suggests('magic wand', 'generic wand');

// ---------------------------------------------------------------- and it must stay quiet
//
// A SUGGESTER THAT ALWAYS SUGGESTS IS A SUGGESTER NOBODY BELIEVES. The distance is bounded,
// so a string with nothing near it gets nothing rather than a confident irrelevance.
ok('gibberish gets no suggestion', suggestItemName('xyzzyqqq').length === 0);
ok('an empty name gets no suggestion', suggestItemName('').length === 0);
ok('a suggestion list is capped', suggestItemName('wand', { limit: 2 }).length <= 2);

// ---------------------------------------------------------------- resolves vs canonical
{
  const good = checkItemName('elderberry');
  ok('a canonical name is ok', good.ok === true && good.canonical === 'elderberry');
  ok('and is not flagged as renamed', !good.renamed);

  // THE HERB CASE, which is the whole reason this exists.
  const plural = checkItemName('herbs');
  ok('"herbs" RESOLVES — it is not an error', plural.ok === true);
  ok('and it resolves to the singular canonical name', plural.canonical === 'herb');
  ok('but it IS reported as a non-canonical spelling', plural.renamed === 'herb');

  const bad = checkItemName('magic wand');
  ok('an unresolvable name is not ok', bad.ok === false);
  ok('it carries suggestions', bad.suggestions.length > 0);
  ok('and it does not throw', typeof bad.why === 'string');

  ok('an empty name is refused rather than resolved', checkItemName('   ').ok === false);
}

// ---------------------------------------------------------------- the thrown message too
//
// Callers that resolve rather than check still deserve the hint — that is where the night
// was lost, in an exception nobody could act on.
{
  let message = '';
  try { resolveItemName('magic wand'); } catch (e) { message = e.message; }
  ok('the throw still says it does not resolve', /does not resolve/.test(message));
  ok('AND now says what you probably meant', /did you mean/.test(message));
  ok('naming a real candidate', /wand/.test(message));

  let none = '';
  try { resolveItemName('xyzzyqqq'); } catch (e) { none = e.message; }
  ok('with nothing close, it does not invent a suggestion', !/did you mean/.test(none));
}

console.log(`\n${n} passed, 0 failed\n`);
