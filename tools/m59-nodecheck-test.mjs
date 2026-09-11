#!/usr/bin/env node
// CAN THE NODE CHECKER EVER CALL A DEAD STONE MELDED?
//
//   node tools/m59-nodecheck-test.mjs
//
// Offline. No broker, no socket, no map, no roster — every fixture below is a literal copy of
// the resource strings and AddPacket calls in `kod/object/passive/mananode.kod`, so this says
// the same thing on a fresh clone as on the machine that runs the fleet.
//
// WHAT IT PINS, and the first one is the whole reason the tool exists:
//
//   * THE SHARED PREFIX. `mananode_meld` and `mananode_failed_meld` are the same sentence for
//     116 characters. Any matcher keyed on the opening reports a successful meld on a dead
//     stone — a node crossed off a list that was never melded, which is worse than a failure
//     because nothing ever goes back to check it. The test asserts the overlap is real, so the
//     claim in the header is checkable rather than remembered.
//   * THE LADDER'S ORDER. `piState = NODE_DEAD` is tested BEFORE the range check, so being in
//     the box cannot rescue a dead node and "nothing happened" has two very different causes.
//   * THE BOX IS PER AXIS AND EXCLUSIVE. `abs(d) < 3` on each of row and col independently: a
//     stone 2 rows and 2 cols away is IN, and one 3 rows away is OUT however close the columns.
//     A radius or a Euclidean distance gets both of those wrong.
import { classifyNode, meldVerdict, meldBox, manaAdjust, nodesIn, nodeReport,
         ANIMATE, MANANODE_RANGE } from './m59-nodecheck.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};

// Verbatim from mananode.kod:28-46. Two spaces after the full stop, as the kod has them.
const MELD = 'Closing your eyes, you put yourself in a trancelike state and reach ' +
  'out to bind yourself mystically with the node.  Reality expands and ' +
  'time collapses, until you come to, refreshed and invigorated.';
const FAILED = 'Closing your eyes, you put yourself in a trancelike state and reach ' +
  'out to bind yourself mystically with the node.  You are disappointed ' +
  'when nothing seems to happen.';
const ALREADY = 'You have already bonded with this mana node.';
const NOT_IN_RANGE = 'The mana node is not close enough to meld with.';

console.log('\nthe trap: success and failure are the same sentence until they are not');
{
  let shared = 0;
  while (shared < MELD.length && MELD[shared] === FAILED[shared]) shared++;
  ok('mananode_meld and mananode_failed_meld share a prefix of over 100 characters',
     shared > 100, `they share ${shared}`);
  ok('and the header\'s figure of 116 is the real one', shared === 116, `measured ${shared}`);
  ok('so a 100-character prefix match CANNOT tell them apart',
     MELD.slice(0, 100) === FAILED.slice(0, 100));

  ok('the success message reads as melded', meldVerdict(MELD).verdict === 'melded');
  ok('THE FAILURE MESSAGE READS AS DEAD, NOT AS SUCCESS', meldVerdict(FAILED).verdict === 'dead',
     'this is the assertion the tool exists for');
  ok('already-melded is its own verdict', meldVerdict(ALREADY).verdict === 'already');
  ok('out of range is its own verdict', meldVerdict(NOT_IN_RANGE).verdict === 'not_in_range');
}

console.log('\nthe exact pattern that shipped, pinned as the trap it was');
{
  // `m59-mananode.mjs:96` until 2026-09-10. It had no case for the failure message at all.
  const SHIPPED = /trancelike state and reach out to bind/i;
  ok('the pattern that shipped DOES match the success message', SHIPPED.test(MELD));
  ok('and it matches the FAILURE message just as happily', SHIPPED.test(FAILED),
     'which is how a dead stone was reported MELDED and crossed off the list');
  ok('while the replacement tells them apart',
     meldVerdict(MELD).verdict === 'melded' && meldVerdict(FAILED).verdict === 'dead');
}

console.log('\na subclass may refuse for a reason the base class has no word for');
{
  const AVAR = 'The node rejects your attempt to meld with it.';
  ok('AvarNode_rejected is its own verdict', meldVerdict(AVAR).verdict === 'karma',
     'avarnode.kod:63 checks karma SIGN before anything the base class does');
}

console.log('\na truncated message is AMBIGUOUS rather than a guess');
{
  const cut = MELD.slice(0, 116);                 // exactly the shared part, nothing after
  ok('the shared prefix alone decides nothing', meldVerdict(cut).verdict === 'ambiguous',
     'guessing here is how a dead stone gets crossed off a list');
  ok('and it says to read max mana instead', /max mana/i.test(meldVerdict(cut).why));
  ok('silence is distinguishable from all of them', meldVerdict('').verdict === 'silent');
  ok('and silence names the two silent refusals in the ladder',
     /owner|room object/i.test(meldVerdict('').why));
  ok('an unrelated sentence is not forced into a verdict',
     meldVerdict('You hear a dog barking.').verdict === 'unrelated');
}

console.log('\nstate off the animation, without trying the meld');
{
  // The three AddPacket calls at mananode.kod:245-262, as `look` delivers them.
  const normal = { type: ANIMATE.CYCLE, period: 150, group_low: 1, group_high: 5 };
  const cursed = { type: ANIMATE.CYCLE, period: 250, group_low: 6, group_high: 7 };
  const dead   = { type: ANIMATE.NONE, group: 8 };
  ok('ANIMATE_CYCLE 150ms groups 1-5 is NORMAL', classifyNode(normal).state === 'normal');
  ok('ANIMATE_CYCLE 250ms groups 6-7 is CURSED', classifyNode(cursed).state === 'cursed');
  ok('ANIMATE_NONE group 8 is DEAD', classifyNode(dead).state === 'dead');
  ok('and each cites the kod line it came from', /mananode\.kod:\d+/.test(classifyNode(dead).why));

  ok('a static object in another group is UNKNOWN, not dead',
     classifyNode({ type: ANIMATE.NONE, group: 1 }).state === 'unknown',
     'every idle scenery object in the game is ANIMATE_NONE — calling those dead nodes is noise');
  ok('a cycle at an unexpected period is UNKNOWN, not guessed at',
     classifyNode({ type: ANIMATE.CYCLE, period: 200, group_low: 1, group_high: 5 }).state === 'unknown');
  ok('a missing animation does not throw', classifyNode(undefined).state === 'unknown');
  ok('ANIMATE_ONCE is not a node animation', classifyNode({ type: ANIMATE.ONCE }).state === 'unknown');
}

console.log('\nthe meld box is a 5x5 judged PER AXIS, exclusive');
{
  const you = { row: 20, col: 20 };
  ok('MANANODE_RANGE is 3', MANANODE_RANGE === 3);
  ok('the stone\'s own square is in', meldBox(you, { row: 20, col: 20 }).inBox);
  ok('2 rows and 2 cols away is IN — the far corner of the box',
     meldBox(you, { row: 22, col: 22 }).inBox);
  ok('3 rows away is OUT', !meldBox(you, { row: 23, col: 20 }).inBox);
  ok('3 cols away is OUT', !meldBox(you, { row: 20, col: 23 }).inBox);
  ok('3 rows away is OUT even with the columns identical',
     !meldBox(you, { row: 23, col: 20 }).inBox,
     'a radius test would call this 3.0 and a Euclidean one would too — both per-axis wrong');
  ok('and 2,2 is IN even though its Euclidean distance is 2.83',
     meldBox(you, { row: 22, col: 22 }).inBox,
     'a radius-2 test would refuse the corner of the box the kod accepts');
  ok('negative offsets are symmetric', meldBox(you, { row: 18, col: 18 }).inBox);
  const off = meldBox(you, { row: 25, col: 20 });
  ok('how much closer to get is reported per axis', off.needRow === 3 && off.needCol === 0);
}

console.log('\nthe grant is kod integer division, and a dead node grants nothing');
{
  ok('mysticism 50 grants 8', manaAdjust(50) === 8);          // (55/10)+3 = 5+3
  ok('mysticism 0 grants 3', manaAdjust(0) === 3);            // (5/10)+3  = 0+3
  ok('mysticism 4 still grants 3 — it truncates', manaAdjust(4) === 3);
  ok('mysticism 5 tips it to 4', manaAdjust(5) === 4);
  ok('a DEAD node grants 0 however mystic you are', manaAdjust(99, { state: 'dead' }) === 0,
     'mananode.kod:230 returns 0 before the formula');
}

console.log('\nfinding the stone among the furniture');
{
  const objects = [
    { id: 1, name: 'Morrigan', row: 2, col: 4, appearance: { icon_resource: 'mrinnk.bgf' } },
    { id: 2, name: 'mana node', row: 23, col: 53,
      appearance: { icon_resource: 'node.bgf', animation: { type: ANIMATE.CYCLE, period: 150, group_low: 1, group_high: 5 } } },
    { id: 3, name: 'a mushroom', row: 5, col: 5, appearance: { icon_resource: 'mushroom.bgf' } },
  ];
  const found = nodesIn(objects);
  ok('the node is found and the furniture is not', found.length === 1 && found[0].id === 2);
  ok('and it says both signals agreed', found[0].identifiedBy === 'name+icon');
  ok('a subclass with its own name is still caught by the icon',
     nodesIn([{ id: 9, name: 'faerie node', appearance: { icon_resource: 'node.bgf' } }])[0]
       ?.identifiedBy === 'icon only',
     'FeyNode and AvarNode are both `is ManaNode` and need not share the name');

  const rep = nodeReport({ objects, you: { row: 23, col: 54 }, mysticism: 50 });
  ok('the report puts us in the box', rep.nodes[0].box.inBox);
  ok('and says to meld now', /MELD NOW/i.test(rep.nodes[0].verdict));
  ok('and carries what it would be worth', rep.nodes[0].wouldGrant === 8);

  const far = nodeReport({ objects, you: { row: 30, col: 53 }, mysticism: 50 });
  ok('from seven rows away it says how far off we are', /7 square/.test(far.nodes[0].verdict));

  const deadObjs = [{ id: 2, name: 'mana node', row: 23, col: 53,
    appearance: { icon_resource: 'node.bgf', animation: { type: ANIMATE.NONE, group: 8 } } }];
  const dead = nodeReport({ objects: deadObjs, you: { row: 23, col: 53 }, mysticism: 50 });
  ok('A DEAD NODE SAYS SO EVEN STANDING ON TOP OF IT', /DEAD/.test(dead.nodes[0].verdict),
     'the kod checks piState BEFORE the range test — being in the box cannot rescue it');
  ok('and it is worth nothing', dead.nodes[0].wouldGrant === 0);
  ok('an empty room reports no nodes rather than failing',
     nodeReport({ objects: [], you: { row: 1, col: 1 } }).count === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
