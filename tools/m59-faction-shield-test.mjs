#!/usr/bin/env node
// Offline tests for tools/fleetscripts/faction-shield.mjs — the sentences, the cover check, the
// hunt order, and that the plan compiles for all three lieges with every room declared.
//
// The liege sentences are built the way the server builds them: the assign hints from
// questengine.kod with %INDEF_CARGO%CARGO / %NPC / %INDEF_MONSTER%MONSTER filled in. When an
// M59_ROOT (or C:/code/Meridian59) tree is present, the hint text is read from the kod itself,
// so a reworded resource fails here rather than at a liege.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { joinCoverage, joinCandidates, readJoinAsk, readSoldierAsk, readPromoted, huntOrder,
         newLetter, factionKey, script } from './fleetscripts/faction-shield.mjs';
import { trapCheck } from './m59-fleetscript.mjs';
import { WILDERNESS_FLAG_ROOMS } from './m59-factions.mjs';

let n = 0;
const ok = (name, fn) => { fn(); n++; };

// ---------------------------------------------------------------- the kod, when it is here
const ROOT = process.env.M59_ROOT || 'C:/code/Meridian59';
const QE = join(ROOT, 'kod', 'util', 'questengine.kod');
const kod = existsSync(QE) ? readFileSync(QE, 'latin1') : null;
// A resource may be split over several quoted source lines; join them the way the compiler does.
const resource = (name) => {
  if (!kod) return null;
  const m = new RegExp(`^\\s*${name}\\s*=\\s*\\\\?\\s*((?:"[^"]*"\\s*)+)`, 'm').exec(kod);
  return m ? [...m[1].matchAll(/"([^"]*)"/g)].map(x => x[1]).join('') : null;
};
const fill = (hint, sub) => Object.entries(sub).reduce((s, [k, v]) => s.split(k).join(v), hint);

const DUKE_JOIN = resource('duke_join2_assign') ??
  'So, you wish to prove yourself worthy of my trust?  You can begin by bringing me %INDEF_CARGO%CARGO.';
const REBEL_JOIN = resource('rebel_join2_assign') ??
  'You wish to join our fight for freedom?  I cannot trust you, for you may be a spy for my enemies.  ' +
  'Prove your value by bringing me %INDEF_CARGO%CARGO.';
const PRINCESS_JOIN = resource('princess_join2_assign') ??
  'So, you wish to prove yourself worthy of my trust?  Wouldst thou be so kind as to deliver an ' +
  'official letter to %NPC?  I would be most grateful.';
const DUKE_SOLDIER_1 = resource('duke_faction_soldier_assign_1') ??
  'Yes, perhaps you\'ll do.  Prove your loyalty by murdering %INDEF_MONSTER%MONSTER.';
const DUKE_SOLDIER_2 = resource('duke_faction_soldier_assign_2') ??
  'Excellent.  Now, show your contempt for my enemies by murdering %INDEF_MONSTER%MONSTER.';
const DUKE_SUCCESS = resource('duke_faction_soldier_success') ??
  'You have done well, my soldier.';
const REBEL_SOLDIER_1 = resource('rebel_faction_soldier_assign_1') ??
  'I have faith in you.  Go dispatch %INDEF_MONSTER%MONSTER near a flagpole.';
const PRINCESS_SUCCESS = resource('princess_faction_soldier_success') ??
  'It is good that we can count you as an ally.';
if (kod) ok('the hints were read from the kod', () => {
  for (const h of [DUKE_JOIN, REBEL_JOIN, PRINCESS_JOIN, DUKE_SOLDIER_1, DUKE_SOLDIER_2])
    assert.match(h, /%INDEF_CARGO%CARGO|%NPC|%INDEF_MONSTER%MONSTER/);
});

// ---------------------------------------------------------------- faction names
ok('faction names an operator types', () => {
  assert.equal(factionKey('Duke'), 'duke');
  assert.equal(factionKey('jonas'), 'rebel');
  assert.equal(factionKey('princess'), 'princess');
  assert.equal(factionKey('council'), null);
});

// ---------------------------------------------------------------- the join ask
ok('the Duke asks for one gem', () => {
  for (const [gem, art] of [['sapphire', 'a '], ['ruby', 'a '], ['emerald', 'an '], ['diamond', 'a ']]) {
    const ask = readJoinAsk('duke', [`Duke Akardius says, "${fill(DUKE_JOIN, { '%INDEF_CARGO': art, '%CARGO': gem })}"`]);
    assert.equal(ask?.item, gem, gem);
    assert.equal(ask.room, 952);
  }
});
ok('Jonas asks for a HELM — the spoken name of SimpleHelm — and the longer names win', () => {
  const said = item => readJoinAsk('rebel', [fill(REBEL_JOIN, { '%INDEF_CARGO': 'a ', '%CARGO': item })])?.item;
  assert.equal(said('helm'), 'helm');
  assert.equal(said("knight's shield"), "knight's shield");
  assert.equal(said('plate armor'), 'plate armor');
  assert.equal(said('gauntlets'), 'gauntlets');
  assert.equal(said('mystic sword'), 'mystic sword');
  assert.equal(said('scimitar'), 'scimitar');
});
ok('the Princess names a recipient, and only the three on the JOIN list', () => {
  const to = npc => readJoinAsk('princess', [fill(PRINCESS_JOIN, { '%NPC': npc })]);
  assert.deepEqual([to('Priestess Xiana')?.room, to('Lady Aftyn')?.room, to('Herbutte')?.room], [48, 205, 109]);
  assert.equal(to('Alzahakar'), null, 'Alzahakar is commented out of the join list');
});
ok('a sentence nobody anticipated is not an errand', () => {
  assert.equal(readJoinAsk('duke', ['Duke Akardius says, "Hello there."']), null);
  assert.equal(readJoinAsk('duke', []), null);
});

// ---------------------------------------------------------------- cover before asking
ok('Duke cover: gems are bought, a ruby has to be carried', () => {
  assert.deepEqual(joinCoverage('duke', ['shilling', 'ruby']),
    { held: ['ruby'], buyable: ['sapphire', 'emerald', 'diamond'], missing: [] });
  assert.deepEqual(joinCoverage('duke', []).missing, ['ruby']);
});
ok('Jonas cover: nothing is reliably for sale', () => {
  assert.equal(joinCandidates('rebel').length, 6);
  assert.equal(joinCoverage('rebel', ['helm', 'scimitar']).missing.length, 4);
  assert.equal(joinCoverage('rebel', ['plate armor', 'helm', "knight's shield", 'gauntlets',
                                      'mystic sword', 'scimitar']).missing.length, 0);
});
ok('Princess cover: she hands over the cargo herself', () => {
  assert.deepEqual(joinCoverage('princess', []), { held: [], buyable: [], missing: [] });
});
ok('the new letter is the one that was not there before', () => {
  const before = [{ id: 10, name: 'letter' }, { id: 11, name: 'shilling' }];
  const after = [...before, { id: 99, name: 'letter' }];
  assert.equal(newLetter(before, after)?.id, 99);
  assert.equal(newLetter(after, after), null);
});

// ---------------------------------------------------------------- the soldier quest
ok('the Duke: rebel soldier first, then the Princess\' army, then the shield', () => {
  const one = readSoldierAsk('duke', [fill(DUKE_SOLDIER_1, { '%INDEF_MONSTER': 'a ', '%MONSTER': 'rebel soldier' })]);
  assert.equal(one?.target, 'rebel soldier'); assert.equal(one.stage_index, 0);
  const two = readSoldierAsk('duke', [fill(DUKE_SOLDIER_2, { '%INDEF_MONSTER': 'a ', '%MONSTER': "soldier of the Princess' army" })]);
  assert.equal(two?.target, "soldier of the Princess' army"); assert.equal(two.stage_index, 1);
  assert.equal(readPromoted('duke', [DUKE_SUCCESS]), true);
  assert.equal(readPromoted('duke', ['Nothing much.'], ["shield of the duke's army"]), true, 'the shield in the pack is proof too');
  assert.equal(readPromoted('duke', ['Nothing much.'], []), false);
});
ok('Jonas: the Princess\' army first', () => {
  const one = readSoldierAsk('rebel', [fill(REBEL_SOLDIER_1, { '%INDEF_MONSTER': 'a ', '%MONSTER': "soldier of the Princess' army" })]);
  assert.equal(one?.stage_index, 0);
  assert.equal(readPromoted('princess', [PRINCESS_SUCCESS]), true);
});

// ---------------------------------------------------------------- where to hunt
ok('the starting holdings come first, then the nearest other flag rooms', () => {
  const order = huntOrder('rebel soldier', { 568: 9e5, 557: 1e5, 547: 5e5, 593: 1, 583: 2 }, { max: 5 });
  assert.deepEqual(order.slice(0, 3), [557, 547, 568], 'defaults, nearest first');
  assert.deepEqual(order.slice(3), [593, 583]);
  assert.ok(order.every(r => WILDERNESS_FLAG_ROOMS.includes(r)));
});
ok('an operator\'s room list replaces the search', () => {
  assert.deepEqual(huntOrder('rebel soldier', {}, { rooms: [575, 584], max: 8 }), [575, 584]);
});
ok('no town flag room is hunted: town poles never spawn troops', () => {
  for (const town of [50, 290, 1, 1015, 109]) assert.ok(!WILDERNESS_FLAG_ROOMS.includes(town));
});

// ---------------------------------------------------------------- the plan
for (const faction of ['duke', 'princess', 'jonas']) {
  ok(`the plan compiles for ${faction}, declares every dynamic walk, and passes the trap check`, async () => {});
  const steps = await script.steps({ faction, agent: 't5', agents: ['t5'], max_rooms: 8, fights: 4 });
  assert.ok(steps.length > 40, `${faction}: ${steps.length} steps`);
  for (const s of steps)
    if (s.do === 'walk' && typeof s.to === 'function')
      assert.ok(Array.isArray(s.candidates) && s.candidates.length, `${faction}: a dynamic walk without candidates`);
  // trapCheck answers null for a clean plan and a SENTENCE for a refusal.
  assert.equal(trapCheck(steps), null, `${faction}: trap check refused the plan`);
  // Every say is either a fixed liege word or empty — never free text, never a trigger by accident.
  const st = { needShield: true, needJoin: true, hasShield: false, stage: { n: 1, killed: true } };
  for (const s of steps.filter(x => x.do === 'say')) {
    const text = typeof s.text === 'function' ? s.text(st) : s.text;
    assert.ok(['', 'join', 'soldier', 'It is done, my liege.'].includes(text), `${faction}: said "${text}"`);
  }
}
await assert.rejects(script.steps({ faction: 'council', agent: 't5' }), /unknown faction/);
n++;

// A character that already carries its shield resolves every leg to where it stands.
ok('a finished soldier walks nowhere', async () => {});
{
  const steps = await script.steps({ faction: 'duke', agent: 't5', agents: ['t5'] });
  const st = { hasShield: true, here: 39 };
  for (const s of steps.filter(x => x.do === 'walk' && typeof x.to === 'function' && !x.always))
    assert.equal(s.to(st), 39);
  for (const s of steps.filter(x => x.do === 'say'))
    assert.equal(typeof s.text === 'function' ? s.text(st) : s.text, '');
}

console.log(`faction-shield: ${n} groups passed${kod ? ' (hints read from the kod)' : ' (no kod tree: built-in hints)'}`);
