#!/usr/bin/env node
// m59-menagerie-script-test.mjs — WHAT A HOST DOES IS A TABLE, AND TABLES CAN BE CHECKED.
//
//   node tools/m59-menagerie-script-test.mjs
//
// Offline. Opens no socket, starts no broker, touches no roster.
//
// ======================== WHAT THIS PINS ========================
//
// A host's behaviour is a JSON file: what it says when spoken to, what it calls out, where
// it stands, and what it will take for a thing. Making it data rather than code is what
// lets it be reloaded on an edit and — the part this file is about — checked without a
// game server, a broker, or a character.
//
// Five claims:
//   1. a script that will not load reports every problem, and never half-loads
//   2. a pattern from disk cannot hang the driver
//   3. what a host says is a line an operator wrote, chosen by a rule an operator wrote
//   4. the haggle terminates, always, and never sells below the floor
//   5. the routine is a pure function of elapsed time, so a crashed driver resumes

import {
  parseScript, respondTo, haggle, priceFor, stepAt, shopWarnings, EXAMPLE_MERCHANT,
} from './m59-menagerie-script.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

// ---------------------------------------- 1. loading

console.log('\n1. a script reports every problem and never half-loads');

const good = parseScript(EXAMPLE_MERCHANT, 'merchant-tos');
ok('the committed example is valid', good.ok === true, JSON.stringify(good.problems));
ok('...and carries its dialogue, routine and shop',
   good.dialogue.length === 4 && good.routine.length === 2 && good.shop != null);

ok('a file that will not parse says so rather than throwing',
   parseScript('{ nope', 'x').ok === false);
ok('a non-object is refused', parseScript('[]', 'x').ok === false);

const noSay = parseScript({ dialogue: [{ when: 'hello' }] }, 'x');
ok('a rule that matches but says nothing is refused',
   noSay.ok === false && /says nothing/.test(noSay.problems.join(' ')));
ok('...and is DROPPED, not half-loaded — a rule that matches and is silent would swallow ' +
   'every later rule', noSay.dialogue.length === 0);

const badKind = parseScript({ kind: 'wizard' }, 'x');
ok('an unrecognised kind is reported, never silently accepted', badKind.ok === false);

// A ROUTINE ALWAYS EXISTS. A host with no routine would do nothing at all and look exactly
// like a healthy one, which is this repository's standing definition of the worst kind of
// bug. Standing still is the default and it is explicit.
ok('a script with no routine still gets one', parseScript({}, 'x').routine.length === 1);
ok('...and it is `stand`', parseScript({}, 'x').routine[0].do === 'stand');

// ---------------------------------------- 2. patterns from disk are bounded

console.log('\n2. a pattern from disk cannot hang the driver');

const huge = parseScript({ dialogue: [{ when: 'a'.repeat(500), say: ['hi'] }] }, 'x');
ok('an over-long pattern is refused rather than compiled',
   huge.ok === false && /max 200/.test(huge.problems.join(' ')));
const broken = parseScript({ dialogue: [{ when: '([unclosed', say: ['hi'] }] }, 'x');
ok('a pattern that will not compile is reported with the engine\'s own message',
   broken.ok === false && broken.dialogue.length === 0);
const longLine = parseScript({ dialogue: [{ when: 'hi', say: ['x'.repeat(500)] }] }, 'x');
ok('a line longer than the game will carry is refused',
   longLine.ok === false && /max 400/.test(longLine.problems.join(' ')));

// ---------------------------------------- 3. what it says

console.log('\n3. what a host says is an operator\'s line, chosen by an operator\'s rule');

const s = parseScript(EXAMPLE_MERCHANT, 'm');
ok('"what do you sell?" matches the wares rule',
   respondTo(s, 'what do you sell?')?.intent === 'wares');
ok('"how much for this" matches the price rule',
   respondTo(s, 'how much for this sword')?.intent === 'price');
ok('"thanks" ends the exchange', respondTo(s, 'thanks!')?.ends === true);
ok('something with no rule returns null, so the caller can escalate',
   respondTo(s, 'the sky is a peculiar colour today') === null);
ok('an empty utterance answers nothing', respondTo(s, '   ') === null);

// FIRST MATCH WINS, which is the rule m59-chatter.mjs uses and the reason order is the
// operator's to control. `wares` is before `price` in the file, so a sentence with both
// words gets `wares` — deterministically, every time.
ok('first match wins, so the file\'s order is the operator\'s control',
   respondTo(s, 'what do you sell and how much') ?.intent === 'wares');

// A BOT THAT REPEATS ITSELF WORD FOR WORD IS THE CLEAREST TELL THERE IS.
const many = parseScript({ dialogue: [{ when: 'hi', say: ['one', 'two', 'three'] }] }, 'x');
ok('asking twice rotates the answer',
   respondTo(many, 'hi', { turn: 0 }).say === 'one' &&
   respondTo(many, 'hi', { turn: 1 }).say === 'two');
ok('...and wraps rather than running out',
   respondTo(many, 'hi', { turn: 3 }).say === 'one');

// The negative claim that matters most about this whole file.
ok('there is no model anywhere in the script engine',
   !/anthropic|openai|fetch\(|http/i.test(
     await import('node:fs').then(fs =>
       fs.readFileSync(new URL('./m59-menagerie-script.mjs', import.meta.url), 'utf8'))));

// ---------------------------------------- 4. the haggle

console.log('\n4. the haggle terminates and never sells below the floor');

const shop = s.shop;                              // min_ratio 0.85, max_rounds 2
ok('an offer at the asking price is accepted',
   haggle({ asking: 100, offered: 100, shop }).verdict === 'accept');
ok('an offer above it is accepted at the offer',
   haggle({ asking: 100, offered: 120, shop }).price === 120);
ok('an offer above the floor is accepted',
   haggle({ asking: 100, offered: 90, shop }).verdict === 'accept');
ok('an offer below the floor is countered, not refused, while rounds remain',
   haggle({ asking: 100, offered: 10, shop, rounds: 0 }).verdict === 'counter');
ok('...and the counter is never below the floor',
   haggle({ asking: 100, offered: 10, shop, rounds: 0 }).price >= 85);
ok('at the last round it refuses and NAMES its floor',
   haggle({ asking: 100, offered: 10, shop, rounds: 2 }).verdict === 'refuse' &&
   haggle({ asking: 100, offered: 10, shop, rounds: 2 }).price === 85);

// TERMINATION, checked rather than argued. A negotiation that can go round for ever is a
// character standing in a shop being talked at until the server drops it.
let rounds = 0, offer = 1, ended = false;
for (; rounds < 20; rounds++) {
  const r = haggle({ asking: 100, offered: offer, shop, rounds });
  if (r.verdict !== 'counter') { ended = true; break; }
  offer = r.price;                                 // the player accepts every counter
}
ok('a player who only ever counters is finished with inside max_rounds+1', ended && rounds <= 3,
   `rounds=${rounds}`);

ok('nothing priced is a refusal, not a crash',
   haggle({ asking: 0, offered: 10, shop }).verdict === 'refuse');

// ---------------------------------------- pricing and what it will touch

console.log('\n   what a shop will and will not take');

ok('a refused item is refused by name',
   priceFor('an amulet of shadows', { shop, estimate: 900 }).ok === false);
ok('...and the two cursed items are refused by the committed example, because wielding ' +
   'one is the only irreversible mistake in this game',
   EXAMPLE_MERCHANT.shop.refuses.includes('amulet of shadows') &&
   EXAMPLE_MERCHANT.shop.refuses.includes('ring of lethargy'));
ok('an item with no value estimate is not priced at zero — it is not priced',
   priceFor('short sword', { shop, estimate: null }).ok === false);
const p = priceFor('short sword', { shop, estimate: 100 });
ok('the shop pays less than it charges', p.ok && p.buy < p.sell, JSON.stringify(p));

const losing = parseScript({ shop: { sell_markup: 0.5, buy_markdown: 0.9 } }, 'x');
ok('a shop that buys higher than it sells is WARNED about, not silently run',
   shopWarnings(losing.shop).length > 0);

// ---------------------------------------- 5. the routine

console.log('\n5. the routine is a pure function of elapsed time');

const r = parseScript({ routine: [{ do: 'stand', seconds: 10 }, { do: 'broadcast', seconds: 5 }] }, 'x');
ok('at t=0 it is standing', stepAt(r, 0).do === 'stand');
ok('at t=12s it is broadcasting', stepAt(r, 12_000).do === 'broadcast');
ok('at t=16s it has cycled back to standing', stepAt(r, 16_000).do === 'stand');
// The point of purity: a driver that died at t=100s and came back knows where it was
// WITHOUT having written anything down.
ok('a restarted driver resumes mid-cycle rather than restarting it',
   stepAt(r, 101_000).do === stepAt(r, 11_000).do);
ok('a negative or absent elapsed time is still answerable',
   stepAt(r, -1).do !== undefined && stepAt(r, undefined).do !== undefined);
ok('a patrol without a destination is refused rather than walking nowhere',
   parseScript({ routine: [{ do: 'patrol', seconds: 10 }] }, 'x').ok === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
