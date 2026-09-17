#!/usr/bin/env node
// WHAT A REVEALED ITEM IS FOR — offline, safe any time: no socket, no roster, no broker.
//
//   node tools/m59-magicsort-test.mjs
//
// Every assertion here guards a decision that spends or destroys something. A mis-sorted keeper
// is sold and cannot be got back; a mis-sorted timed item is held until it is worthless; and an
// item nobody could read must not be sold on the strength of the absence.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, sortPack, loadList, DEFAULT_LIST, WEAPON_ATTRIBUTES,
         KEEP_AT_DIFFICULTY, VERDICTS, describeItem, routeOf } from './m59-magicsort.mjs';
import { noDropFrom, NO_DROP_REASONS } from './m59-nodrop.mjs';

let n = 0;
const ok = (what, fn) => { fn(); n++; console.log('  ok  ' + what); };

const dir = mkdtempSync(join(tmpdir(), 'm59-magicsort-test-'));
const listAt = (obj) => {
  const p = join(dir, `l${n}.json`);
  writeFileSync(p, JSON.stringify(obj));
  return loadList({ file: p });
};

console.log('\nthe kod table is the policy, and the default is derived from it');

ok('the table is complete: sixteen weapon attributes', () => {
  assert.equal(WEAPON_ATTRIBUTES.length, 16);
  assert.equal(WEAPON_ATTRIBUTES.filter(a => a.timed).length, 4, 'four carry a timer');
});

// THE THREE PILES ARE DERIVED, NOT TYPED BESIDE THE TABLE. A correction to the kod reading has
// to move the lists with it, or the next person edits a comment and believes they changed policy.
ok('every permanent, strong attribute is a keeper', () => {
  for (const a of WEAPON_ATTRIBUTES) {
    if (a.timed || (a.difficulty ?? 0) < KEEP_AT_DIFFICULTY) continue;
    assert.ok(DEFAULT_LIST.keep.attributes.includes(a.look), `${a.file} missing from keep`);
  }
});
ok('every permanent, WEAK attribute goes to a person — the operator\'s rule', () => {
  for (const a of WEAPON_ATTRIBUTES) {
    if (a.timed || (a.difficulty ?? 0) >= KEEP_AT_DIFFICULTY) continue;
    assert.ok(DEFAULT_LIST.sell_to_players.attributes.includes(a.look), `${a.file} misfiled`);
  }
});
ok('and every TIMED attribute goes to a counter, because the timer runs in the vault too', () => {
  for (const a of WEAPON_ATTRIBUTES) {
    if (!a.timed) continue;
    assert.ok(DEFAULT_LIST.sell_to_npc.attributes.includes(a.look), `${a.file} misfiled`);
  }
});
ok('no attribute is in two piles at once', () => {
  const seen = new Set();
  for (const k of ['keep', 'sell_to_players', 'sell_to_npc'])
    for (const a of DEFAULT_LIST[k].attributes) {
      assert.ok(!seen.has(a), `${a} is in more than one pile`);
      seen.add(a);
    }
});

console.log('\nthe case the operator remembered');

// Ceremonial is the one they named, and the kod agrees in as many words: +2 damage,
// difficulty 5, x1.5 price, "obviously unsuitable for blood combat".
ok('a ceremonial weapon is sold to a PERSON, not kept and not dumped at a counter', () => {
  const v = classify({ name: 'long sword',
                       look: 'Beautiful and ornate, this weapon is obviously unsuitable for ' +
                             'blood combat, though it might provide a slight edge in games.' });
  assert.equal(v.verdict, 'sell_to_players');
  assert.match(v.why, /unsuitable for combat|looks than its edge/);
});
ok('a mystic sword too — no fixed merchant stocks one', () => {
  assert.equal(classify({ name: 'mystic sword', look: 'An ordinary mystic sword.' }).verdict,
               'sell_to_players');
});
ok('while a vampiric weapon is kept, because difficulty 10 is worth fighting with', () => {
  assert.equal(classify({ name: 'mace',
                          look: 'An unholy glow seems to suck all life from the air.' }).verdict,
               'keep');
});
ok('a glowing one goes to a counter TODAY — it is worth nothing tomorrow', () => {
  assert.equal(classify({ name: 'glowing mace', look: 'It is a glowing mace.' }).verdict,
               'sell_to_npc');
});

console.log('\nseven of the strong attributes do not rename the item, so the LOOK TEXT decides');

ok('an attribute invisible in the name is still found in the description', () => {
  // watwist renames nothing at all; the signature is a stamp on the pommel.
  const v = classify({ name: 'long sword',
                       look: "A swirling green 'GMT' is stamped into the pommel." });
  assert.equal(v.verdict, 'keep');
  assert.equal(v.where, 'look text');
});
ok('and a name match is reported as a name match, so the two can be told apart', () => {
  assert.equal(classify({ name: 'glowing mace', look: 'nothing here' }).where, 'name');
});

console.log('\nunknown is not a sale, and that is the whole design');

// Every expensive mistake in this repository is an absence read as a value. This decision is
// irreversible in one direction only: a sold keeper cannot be got back.
ok('an item whose look text could not be read is UNKNOWN, never sold', () => {
  const v = classify({ name: 'plate armor', look: null });
  assert.equal(v.verdict, 'unknown');
  assert.match(v.why, /nobody looked/);
});
ok('a READ item matching nothing is also unknown — a missing line, not a decision', () => {
  const v = classify({ name: 'long sword', look: 'Nothing remarkable about it.' });
  assert.equal(v.verdict, 'unknown');
  assert.match(v.why, /MISSING LINE|missing line/);
});
ok('the two unknowns give DIFFERENT reasons, because they need different fixes', () => {
  const blind = classify({ name: 'x', look: null }).why;
  const read = classify({ name: 'x', look: 'plain' }).why;
  assert.notEqual(blind, read);
});
// A name match still works with no look text: the name is cheap and always present, and a wand
// is a wand whether or not anybody read it.
ok('but a NAME match does not need the look text at all', () => {
  assert.equal(classify({ name: 'wand', look: null }).verdict, 'sell_to_players');
});

console.log('\nthe list is orders, and where it came from is always on the record');

ok('with no local file the committed default is in force, and says so', () => {
  const L = loadList({ file: join(dir, 'nope.json') });
  assert.equal(L.source.exists, false);
  assert.match(L.source.note, /committed default/);
  assert.ok(L.keep.attributes.length > 0);
});
// A FILE THAT WILL NOT PARSE IS NOT AN EMPTY FILE — docs/m59-policy.md, and the same rule that
// kept a broken tuning file from unsetting every threshold.
ok('a file that will not parse keeps the default and reports the parse error', () => {
  const p = join(dir, 'broken.json');
  writeFileSync(p, '{ this is not json');
  const L = loadList({ file: p });
  assert.ok(L.source.unreadable, 'the error is carried');
  assert.ok(L.keep.attributes.length > 0, 'and the default still sorts');
});
// AN EMPTY LIST WOULD ROUTE THE WHOLE FLEET TO `unknown` and stall the service in silence.
ok('a file that names nothing is ignored rather than obeyed', () => {
  const L = listAt({ keep: {}, sell_to_players: {}, sell_to_npc: {} });
  assert.equal(L.source.ignored, true);
  assert.ok(L.keep.attributes.length > 0);
});
ok('a real local list REPLACES the default rather than adding to it', () => {
  const L = listAt({ keep: { items: ['thing'] } });
  assert.deepEqual(L.keep.items, ['thing']);
  assert.equal(L.keep.attributes.length, 0, 'not merged with the committed keep list');
  assert.equal(classify({ name: 'glowing mace', look: 'glowing' }, L).verdict, 'unknown',
               'and the default sell_to_npc list is gone with it');
});

console.log('\noverrides are keyed by name and text, never by object id');

// Ids are renumbered by every system save and 23% named a different object within three days.
// A stored per-id tag would eventually sell somebody else's property and read as success.
ok('an override wins over every list', () => {
  const L = listAt({ sell_to_npc: { attributes: ['glowing'] },
                     overrides: [{ name: 'mace', verdict: 'keep', why: 'mine' }] });
  const v = classify({ name: 'glowing mace', look: 'It is glowing.' }, L);
  assert.equal(v.verdict, 'keep');
  assert.equal(v.kind, 'override');
});
ok('`looks_like` narrows it to the ONE item, not every item sharing the name', () => {
  const L = listAt({ sell_to_npc: { attributes: ['glowing'] },
                     overrides: [{ name: 'mace', looks_like: 'Colhorr', verdict: 'keep' }] });
  assert.equal(classify({ name: 'glowing mace', look: "Colhorr's signature" }, L).verdict, 'keep');
  assert.equal(classify({ name: 'glowing mace', look: 'just glowing' }, L).verdict, 'sell_to_npc',
               'a different mace of the same name is unaffected');
});
ok('an override naming a verdict that does not exist is dropped, not obeyed', () => {
  const L = listAt({ overrides: [{ name: 'mace', verdict: 'incinerate' }],
                     keep: { items: ['x'] } });
  assert.equal(L.overrides.length, 0);
});


console.log('\nthe fifth verdict: the mule holds it, and `unknown` ends up there too');

// Operator, 2026-09-17: "we want a mule-keep... and I guess that means unknown will probably
// end up on Loial, so it's really just default mule-keep". Both true, and they stay separate
// verdicts anyway — `mule_keep` is a decision, `unknown` is a gap, and they need different
// actions from whoever reads the report.
ok('there are five verdicts and THREE destinations — two verdicts share the mule', () => {
  assert.equal(VERDICTS.length, 5);
  assert.deepEqual([...new Set(VERDICTS.map(v => routeOf(v).to))].sort(),
                   ['counter', 'mule', 'owner']);
});
ok('unknown routes to the mule WITHOUT becoming a decision', () => {
  assert.equal(routeOf('unknown').to, 'mule');
  assert.equal(routeOf('mule_keep').to, 'mule');
  assert.match(routeOf('unknown').why, /DEFAULT mule-keep|Not a decision/);
  assert.notEqual(routeOf('unknown').why, routeOf('mule_keep').why,
                  'same shelf, different reason — the report has to be able to say which');
});
ok('and a verdict nobody recognises routes to the mule rather than to a sale', () => {
  assert.equal(routeOf('incinerate').to, 'mule');
  assert.equal(routeOf(undefined).to, 'mule');
});

// A HOLD BEATS A SALE. An item named on both the mule list and a sell list must not be sold out
// from under the operator's own line.
ok('mule_keep outranks both sales', () => {
  const L = listAt({ mule_keep: { items: ['mace'] }, sell_to_npc: { attributes: ['glowing'] },
                     sell_to_players: { items: ['mace'] } });
  assert.equal(classify({ name: 'glowing mace', look: 'It is glowing.' }, L).verdict, 'mule_keep');
});
ok('but `keep` still outranks it — an owner who can use it beats a shelf', () => {
  const L = listAt({ keep: { items: ['mace'] }, mule_keep: { items: ['mace'] } });
  assert.equal(classify({ name: 'mace', look: 'x' }, L).verdict, 'keep');
});
ok('the committed default claims NOTHING for the mule, because the kod does not say', () => {
  assert.equal(DEFAULT_LIST.mule_keep.items.length, 0);
  assert.equal(DEFAULT_LIST.mule_keep.attributes.length, 0);
});
ok('sortPack gives the fifth pile and carries the destination on every row', () => {
  const L = listAt({ mule_keep: { items: ['orb'] } });
  const out = sortPack([{ id: 1, name: 'orb of x', look: 'plain' },
                        { id: 2, name: 'helm', look: null }], L);
  assert.deepEqual(out.mule_keep.map(i => i.id), [1]);
  assert.equal(out.mule_keep[0].route, 'mule');
  assert.deepEqual(out.unknown.map(i => i.id), [2]);
  assert.equal(out.unknown[0].route, 'mule', 'the same shelf');
});

console.log('\na mule is a character that keeps its pack, and the protection EXPIRES');

// The operator's shorthand is "20hp characters that cannot drop items when they die". The
// mechanism is the newbie honour string, and hit points are only a correlate — which matters
// because the string is cleared at about two game months on a check that fires whenever
// anybody LOOKS at the character. player.kod:7990-8032, :1531-1550, :11086-11097.
ok('the newbie honour sentence means the pack survives death', () => {
  const v = noDropFrom('Grim looks tough. This soul is new to the lands of Meridian 59.');
  assert.equal(v.no_drop, true);
  assert.equal(v.reason, 'newbie_honour');
  assert.match(v.why, /two game months/, 'and it says the protection expires');
});
ok('a look that came back WITHOUT it is a real no, not a shrug', () => {
  const v = noDropFrom('Grim looks tough. He is a Barloquan.');
  assert.equal(v.no_drop, false);
  assert.match(v.why, /not in force/);
});
// NOBODY ASKED IS NOT A NO. The same three-way answer hometownFrom keeps, and for the same
// reason: a collection parked on a guess is parked on the floor after one death.
ok('no look text at all is NULL — nobody asked', () => {
  assert.equal(noDropFrom(null), null);
  assert.equal(noDropFrom(''), null);
  assert.equal(noDropFrom('   '), null);
});
ok('all four kod routes to no-drop are recorded, with citations', () => {
  assert.equal(NO_DROP_REASONS.length, 4);
  assert.ok(NO_DROP_REASONS.every(r => r.cite && r.why && r.durable));
  const honour = NO_DROP_REASONS.find(r => r.key === 'newbie_honour');
  assert.match(honour.durable, /two game months/,
               'the only durable one, and its expiry is part of the record');
});

console.log('\nsorting a pack keeps the reason with every row');

ok('four piles, and every item lands in exactly one', () => {
  const out = sortPack([
    { id: 1, name: 'long sword', look: 'It glows with a soft, white light.' },
    { id: 2, name: 'wand', look: 'It is shrouded.' },
    { id: 3, name: 'axe', look: 'It is an enchanted axe.' },
    { id: 4, name: 'helm', look: null },
  ]);
  assert.deepEqual(out.keep.map(i => i.id), [1]);
  assert.deepEqual(out.sell_to_players.map(i => i.id), [2]);
  assert.deepEqual(out.sell_to_npc.map(i => i.id), [3]);
  assert.deepEqual(out.unknown.map(i => i.id), [4]);
  assert.equal(VERDICTS.length, 5, 'four piles plus mule_keep');
});
ok('and every row carries WHY, because a sale has to be auditable afterwards', () => {
  const out = sortPack([{ id: 1, name: 'wand', look: null }]);
  assert.ok(out.sell_to_players[0].why);
  assert.equal(out.sell_to_players[0].matched, 'wand');
});
ok('the pack sort reports which list it used', () => {
  assert.ok(sortPack([]).source);
});

console.log('\nlook_at can answer about the WRONG item, and this refuses rather than guesses');

// Measured two calls in nine on prod: the reply carried the previous call's object with its own
// wrong id. Anything reading a description has to re-check the id it got back.
{
  const wrongThenRight = (() => {
    let i = 0;
    return async () => (i++ === 0
      ? { id: 999, description: 'somebody else\'s sword' }
      : { id: 8376, description: 'the right one' });
  })();
  const r = await describeItem('hk1', 8376, { call: wrongThenRight });
  ok('it retries past the mismatch and returns the right item\'s text', () => {
    assert.equal(r.text, 'the right one');
    assert.equal(r.tries, 2);
  });
}
{
  const alwaysWrong = async () => ({ id: 999, description: 'not yours' });
  const r = await describeItem('hk1', 8376, { call: alwaysWrong, tries: 3 });
  ok('and answers NULL rather than the wrong description when it never matches', () => {
    assert.equal(r, null);
  });
}
{
  const noId = async () => ({ description: 'no id in this reply' });
  const r = await describeItem('hk1', 8376, { call: noId });
  ok('a reply with no id at all is taken at its word — there is nothing to contradict', () => {
    assert.equal(r.text, 'no id in this reply');
  });
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${n} assertions, all offline.\n`);
