#!/usr/bin/env node
// THE COMBAT-LINE PARSER, CHECKED AGAINST THE GAME'S SOURCE AND AGAINST REAL TRAFFIC.
//
// Two kinds of assertion here, and the second kind is the one that matters:
//
//   1. THE WORKED EXAMPLES FROM battler.kod. Its own comments give one line per template, so
//      those are transcribed verbatim and must classify correctly. If somebody edits the
//      regexes and these break, the regexes stopped matching the game.
//
//   2. THE LINES THAT MUST NOT MATCH. Every parser this module replaces failed by being too
//      permissive or too narrow in a direction that flattered whatever it was measuring, so
//      the near-misses are asserted explicitly: weapon prose that looks like an attack, other
//      people's fights, poison, and the enumerated-verb gap that dropped 22 real swings.
import { classifyCombatLine, isMySwing, isEnemySwing, isEnemyHit, isEnemyMiss, isPoisonTick,
         tallyCombat, VERB_TABLE, DAMAGE_VERBS, EVADE_VERBS, stripCodes } from './m59-combatlog.mjs';
import { readFileSync, existsSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } };
const eq = (a, b, what) => ok(a === b, `${what}${a === b ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`);

console.log('\nTHE FOUR TEMPLATES, using battler.kod\'s own worked examples');
// battler.kod:37-40 — the comments directly above the resource definitions.
{
  const c = classifyCombatLine('Your scimitar wounds Psychochild.');       // battler_attacker_hit
  eq(c?.kind, 'my-swing', 'attacker_hit  — "Your scimitar wounds Psychochild."');
  eq(c?.landed, true, '  landed');
  eq(c?.other, 'Psychochild', '  the target is the other party');
  eq(c?.weapon, 'scimitar', '  the weapon is carried through');
  eq(c?.tier, 'wound', '  wounds is the wound tier');
}
{
  const c = classifyCombatLine('Psychochild blocks your attack.');         // battler_attacker_miss
  eq(c?.kind, 'my-swing', 'attacker_miss — "Psychochild blocks your attack."');
  eq(c?.landed, false, '  did not land');
  eq(c?.other, 'Psychochild', '  the target is the other party');
}
{
  const c = classifyCombatLine('Psychochild wounds you with his scimitar.'); // battler_defender_hit
  eq(c?.kind, 'enemy-swing', 'defender_hit  — "Psychochild wounds you with his scimitar."');
  eq(c?.landed, true, '  landed');
  eq(c?.other, 'Psychochild', '  the attacker is the other party');
  eq(c?.weapon, 'scimitar', '  the weapon is carried through');
}
{
  const c = classifyCombatLine("You block Psychochild's attack.");          // battler_defender_miss
  eq(c?.kind, 'enemy-swing', 'defender_miss — "You block Psychochild\'s attack."');
  eq(c?.landed, false, '  did not land');
  eq(c?.other, 'Psychochild', '  the attacker is the other party');
}

console.log('\nTHE FOUR QUESTIONS CALLERS ASK');
ok(isMySwing('Your mace crushes the spider.'), 'my swing, landed');
ok(isMySwing('The troll dodges your attack.'), 'my swing, evaded — still a swing');
ok(isMySwing('The troll laughs off your pitiful blow.'), 'my swing, laughed off — still a swing');
ok(isMySwing('The spider is too far away to hit with a mace.'), 'my swing, out of range — still a swing');
ok(isEnemySwing('The troll wounds you with its attack.'), 'enemy swing, landed');
ok(isEnemySwing("You dodge the orc's attack."), 'enemy swing, evaded');
ok(isEnemyHit('The troll wounds you with its attack.'), 'enemy HIT');
ok(!isEnemyHit("You dodge the orc's attack."), 'an evaded blow is not a hit');
ok(isEnemyMiss("You dodge the orc's attack."), 'enemy MISS');
ok(isEnemyMiss("You avoid the battered skeleton's attack."), 'enemy MISS, multiword name');
ok(!isEnemyMiss('The troll wounds you with its attack.'), 'a landed blow is not a miss');
ok(!isMySwing('The troll wounds you with its attack.'), 'being hit is not swinging');
ok(!isEnemySwing('Your mace crushes the spider.'), 'swinging is not being hit');

console.log('\nTHE GAP THAT DROPPED 22 REAL SWINGS');
// m59-wallproof.mjs enumerated verbs by hand and had no "crushes". Those lines scored as
// UNRECOGNISED, so the intervals holding them counted as "standing there not swinging" —
// the direction that manufactures a safe-looking wall. Every tier of every element now.
for (const [verb, { element, tier }] of Object.entries(VERB_TABLE)) {
  const line = `Your mace ${verb} the spider.`;
  const c = classifyCombatLine(line);
  if (c?.kind !== 'my-swing' || c.landed !== true) { fail++; console.log(`  FAIL ${element}/${tier}: ${line}`); }
}
console.log(`  ok   all ${DAMAGE_VERBS.length} damage verbs parse as my landed swing`);
pass++;
for (const verb of EVADE_VERBS.filter(v => v.endsWith('s'))) {
  const c = classifyCombatLine(`The troll ${verb} your attack.`);
  if (c?.kind !== 'my-swing' || c.landed !== false) { fail++; console.log(`  FAIL evade verb ${verb}`); }
}
console.log(`  ok   every evade verb parses as my swing that missed`);
pass++;
eq(classifyCombatLine('Your halberd runs through the troll.')?.tier, 'slay', 'the multiword verb "runs through" is not split');
eq(classifyCombatLine('The orc fails to damage you with its attack.')?.landed, true,
   '"fails to damage" CONNECTED — it is not a miss, it did no damage');

console.log('\nLINES THAT MUST NOT BE READ AS COMBAT');
const notCombat = [
  'Your weapon takes on a duller cast.',
  'Your body is possessed by the spirit of the warrior Kara\'hol for a brief period, enhancing the ferocity of your attacks.',
  'You have improved in the art of mace fighting.',
  'You focus your whole will on casting create food.',
  'A bunch of grapes appears.',
  'You are too full to eat that right now.',
  'Welcome to the world of Meridian 59! (type "help" to see the manual).',
  'You open the door and walk through.',
  'You spit on the corpse of your unworthy foe.',
  "You aren't daring enough to take THAT plunge!",
  'The spider is seriously wounded.',
  'Skivlat tells you, "Thank you for your deposit.  You now have 400 shillings in your account."',
];
for (const line of notCombat)
  ok(classifyCombatLine(line) === null, `not combat: "${line.slice(0, 58)}${line.length > 58 ? '…' : ''}"`);

console.log('\nPOISON IS CLASSIFIED, NOT COUNTED AS AN ATTACK');
ok(isPoisonTick('Fresh poison courses through your veins like fire.'), 'a poison tick is recognised');
ok(!isEnemySwing('Fresh poison courses through your veins like fire.'), 'and it is NOT an enemy swing');
eq(classifyCombatLine('Fresh poison courses through your veins like fire.')?.kind, 'poison',
   'so a caller can SHOW poison was excluded rather than assert it');

console.log('\nCOLOUR CODES ARE MARKUP, NOT TEXT');
eq(stripCodes('~bThe thrasher spins, damaging you with its attack.'),
   'The thrasher spins, damaging you with its attack.', 'battler_blue_text is stripped');
{
  const c = classifyCombatLine('~bThe troll wounds you with its attack.');
  eq(c?.kind, 'enemy-swing', 'a blue-coded line still classifies');
  eq(c?.other, 'troll', '  and the name survives the code');
}
{
  // thrasher.kod writes its own prose; the loose fallback catches it and says so.
  const c = classifyCombatLine('~bThe thrasher spins, damaging you with its attack.');
  eq(c?.kind, 'enemy-swing', 'bespoke monster prose is still an enemy swing');
  eq(c?.loose, true, '  and it is flagged loose, so a strict caller can drop it');
}

console.log('\nTHE BUGS IN THE PARSERS THIS REPLACES');
// m59-provewall.mjs:132 and m59-circuit.mjs:142 share /^You\s+\w+\s+.+'s attack\.?$/i
const oldProvewall = /^You\s+\w+\s+.+'s attack\.?$/i;
ok(!oldProvewall.test('The troll wounds you with its attack.'),
   'the old provewall/circuit regex cannot see a landed blow (reproducing the bug)');
ok(isEnemyHit('The troll wounds you with its attack.'),
   '  and this module does');
// m59-game.mjs:1492
const oldGame = /^(?:The|An?) ([a-z' -]+?) (?:[a-z]+s) you\b/i;
ok(!oldGame.test("You dodge the orc's attack."),
   'the old m59-game regex cannot see an evaded blow (the exact complement)');
ok(isEnemySwing("You dodge the orc's attack."), '  and this module does');

console.log('\nTALLY');
{
  const t = tallyCombat([
    'Your mace crushes the spider.',
    'The spider is seriously wounded.',
    "You dodge the orc's attack.",
    'The troll wounds you with its attack.',
    'The troll wounds you with its attack.',
    'You killed the spider.',
    'Fresh poison courses through your veins like fire.',
  ]);
  eq(t.mySwings, 1, 'one swing of mine');
  eq(t.enemySwings, 3, 'three swings at me');
  eq(t.enemyHits, 2, '  two landed');
  eq(t.enemyMisses, 1, '  one evaded');
  eq(t.kills, 1, 'one kill');
  eq(t.poison, 1, 'one poison tick, kept out of the attack counts');
  eq(t.byAttacker.troll, 2, 'attacks are attributed by name');
  eq(t.unclassified.length, 1, 'and the non-combat line is surfaced, not swallowed');
}

// ── REAL TRAFFIC, when a recording is present ───────────────────────────────────────────────
// substrate/wallproof.jsonl is gitignored, so this arm is skipped on a fresh clone rather than
// failing. Where it does run it is the strongest assertion in the file: the parser meeting
// lines nobody wrote a test for.
const REC = 'substrate/wallproof.jsonl';
if (existsSync(REC)) {
  console.log('\nAGAINST A REAL RECORDING');
  const texts = readFileSync(REC, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(r => r?.type === 'msg' && typeof r.text === 'string').map(r => r.text);
  const t = tallyCombat(texts);
  console.log(`  ${texts.length} messages: ${t.mySwings} own swings, ${t.enemySwings} swings at me ` +
              `(${t.enemyHits} landed / ${t.enemyMisses} evaded), ${t.kills} kills, ${t.poison} poison`);
  ok(t.enemyHits > 0 && t.enemyMisses > 0, 'both halves of incoming are seen — neither parser bug survives');
  ok(t.mySwings > 0, 'own swings are seen');
  const combatish = t.unclassified.filter(x => /\battack\b|\byou with\b|your (?:attack|blow)\b/i.test(x));
  ok(combatish.length === 0,
     `nothing combat-shaped is left unclassified${combatish.length ? ` — e.g. "${combatish[0].slice(0, 70)}"` : ''}`);
} else {
  console.log(`\n(no ${REC} on this checkout — the real-traffic arm is skipped, not failed)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
