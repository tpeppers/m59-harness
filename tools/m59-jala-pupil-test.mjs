// THE GUARD FOR fleetscripts/jala-pupil.mjs — offline, opens no socket, drives no character.
//
//   node tools/m59-jala-pupil-test.mjs
//
// Compiles the plan and replays the RUNNER'S OWN SKIP RULE over it (m59-fleetscript.mjs: a skipped
// optional walk takes every following step up to the next walk, unless it is `anywhere`), the shape
// m59-prism-quest-test.mjs pins for the same wanderer. Plus the parsing the quest turns on: the
// server's lines, the destination, and the words that must and must not be in what we say.
process.env.M59_FLEET ??= 'jala-pupil-test';
const { readFileSync } = await import('node:fs');
const { script, LINES, SINGERS, SING_TEXT, TRIGGER, singerIn, PARRIN_SONGS } = await import('./fleetscripts/jala-pupil.mjs');

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${what}`); } };

const params = { agent: 'hk1', agents: 'hk1', songs: 'truth,mirth,melancholy', invigorate: 'true', home: 39, bankRoom: 54,
                 askWaitMin: 10, searchSlots: 8, minHealth: 0.7, fleeBelow: 0.3, restBelow: 0.4 };
const plan = await script.steps(params);
const why = s => String(s.why ?? s.label ?? '');
const QUEST = /probe|say "pupil"|sing to|report back|did anybody hear|enough money|invigorate next|did not finish/;
const skippedAfter = i => {
  const out = [];
  for (let j = i + 1; j < plan.length && plan[j].do !== 'walk' && !plan[j].anywhere; j++) out.push(j);
  return out;
};

{
  const quest = plan.filter(s => s.do === 'verify' && QUEST.test(why(s)));
  ok(quest.length >= 10, `the plan carries the quest's own steps (found ${quest.length})`);
  const taken = new Set();
  for (const [s, i] of plan.map((s, i) => [s, i])) {
    if (s.do !== 'walk' || !s.optional) continue;
    for (const j of skippedAfter(i)) if (QUEST.test(why(plan[j]))) taken.add(`${j}: ${why(plan[j])}`);
  }
  ok(taken.size === 0, `no skipped walk takes a quest step with it -- would take: ${[...taken].slice(0, 3).join(' | ')}`);
}

{
  // Approaches, the withdrawal and the purchases must stand behind the walk that put the body there.
  const bound = plan.map((s, i) => [s, i]).filter(([s]) => ['walk_to', 'crawl_to', 'learn', 'carry_at_least'].includes(s.do));
  ok(bound.every(([s]) => !s.anywhere), 'approaches, withdrawals and purchases are never `anywhere`');
  const gated = bound.filter(([, i]) => {
    for (let j = i - 1; j >= 0; j--) {
      if (plan[j].do === 'walk') return plan[j].optional === true;
      if (!['walk_to', 'crawl_to', 'learn', 'carry_at_least'].includes(plan[j].do)) return false;
    }
    return false;
  });
  ok(gated.length === bound.length, `every bound step follows an optional gate walk (${gated.length}/${bound.length})`);
  const learns = plan.filter(s => s.do === 'learn').map(s => `${s.teacher}:${s.ability}`);
  ok(JSON.stringify(learns) === JSON.stringify(['Parrin:truth', 'Parrin:mirth', 'Parrin:melancholy', "D'Franco:invigorate"]),
     `buys the four level-1 songs from the right teachers (${learns.join(', ')})`);
  const always = plan.filter(s => s.always);
  ok(always.length >= 3 && always.every(s => s.do === 'walk' || s.anywhere), 'the always-steps survive a skip chain');
}

{
  const walks = plan.filter(s => s.do === 'walk' && typeof s.to === 'function');
  ok(walks.every(s => Array.isArray(s.candidates) && s.candidates.length), 'every run-time walk names its candidates');
}

{
  const quiet = await script.steps({ ...params, songs: '', invigorate: 'false' });
  ok(!quiet.some(s => s.do === 'learn'), 'songs= and invigorate=false buy nothing');
  let threw = false;
  try { await script.steps({ ...params, songs: 'warp time' }); } catch { threw = true; }
  ok(threw, 'a song Parrin does not sell at level 1 is refused at compile time');
}

{
  // The words, against the kod they come from.
  const kod = (() => { try { return readFileSync(process.env.M59_KOD ?? 'C:/code/Meridian59/kod/util/questengine.kod', 'utf8'); } catch { return null; } })();
  if (kod) {
    ok(kod.includes(`truthquest_trigger_1 = "${TRIGGER}"`), 'the start trigger is the kod\'s');
    ok(/truthquest_trigger_2 = "sings"/.test(kod), 'node 26 still wants "sings"');
    ok(/truthquest_trigger_4 = "bad"/.test(kod), 'node 28 still wants "bad"');
  } else console.log('  (questengine.kod not found -- set M59_KOD to check the triggers against source)');
  ok(SING_TEXT.toLowerCase().includes('sings'), 'what we sing contains "sings"');
  ok(!/pupil|formula|instrument|necklace|insignia|courier/i.test(SING_TEXT), 'what we sing holds no other quest trigger');
  ok(!/\bgood\b/i.test(SING_TEXT), 'never "good"');
  ok(SINGERS.length === 6 && !SINGERS.some(s => /obert/i.test(s.npc)), 'six destinations, the NOQUEST vaultman excluded');

  const assign = 'Parrin Aragone tells you, "Are you truly ready to learn the magic of songs of Jala?  If so you must prove ' +
                 'your devotion to the arts.  I would like you to try out your voice.  Go to Madelia and sing a song.  ' +
                 'Any song you wish.  Then come back to me and let me know how it went."';
  ok(LINES.assigned.test(assign), 'the assignment line is recognised');
  ok(singerIn([assign])?.room === 856, 'and the destination read off it');
  ok(singerIn(['nothing here']) === null, 'no name, no destination');
  ok(LINES.sung.test('Herbutte says, "By my troth, that is awful.  Did Parrin send thee?"'), 'the sung line is recognised');
  ok(LINES.passed.test('Oh well, we shall work on that.  Now open your mind to the ways of Jala;'), 'the pass line is recognised');
  ok(!LINES.passed.test('That would be a remarkable thing indeed. Are you being entirely honest with yourself?'),
     'the "good" dead end is not mistaken for a pass');
  ok(PARRIN_SONGS.join() === 'truth,mirth,melancholy', 'the three gated songs');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
