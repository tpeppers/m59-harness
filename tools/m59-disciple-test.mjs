#!/usr/bin/env node
// WHAT THE DISCIPLE QUEST NEEDS FROM US, PINNED (100). Offline: no broker, no server, no socket.
//
//   node tools/m59-disciple-test.mjs
//
// Three groups, and they guard three different kinds of mistake.
//
//   1. THE SENTENCES. A delivery node matches with `StringContain`, which after
//      `FuzzyCollapseString` (blakserv/ccode.c:626) is uppercase-and-trim then a plain
//      `strstr` — so interior whitespace is load-bearing and `sacriligious` is spelled the way
//      the server spells it. These cases read `kod/util/questengine.kod` and compare byte for
//      byte, because the failure mode is a reflowed comment or a helpful spell-check, and the
//      symptom is a character standing in the right town saying the right words to the right
//      NPC and being ignored. SKIPPED, not failed, where the kod tree is absent.
//
//   2. THE READING. Every refusal in this errand is silence, so the free teach probe is the
//      only instrument. If its classifier stops recognising one of the priestess's sentences,
//      the errand reports "could not tell" — which is survivable — but if it mis-files the
//      "become my disciple" refusal as anything else, it reports SUCCESS over a locked shop.
//
//   3. THE COMPILER CHANGES THIS ERRAND NEEDED. A step field that is a function of the run
//      state, and the trap check that refuses a run-time destination which does not say where
//      it could go.
import { readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK_DIR = mkdtempSync(join(tmpdir(), 'm59-disc-'));
process.env.M59_RUNLOCK_DIR = LOCK_DIR;
process.env.M59_CONTROL_URL = 'http://127.0.0.1:1/';   // never actually reached
const BAND_DIR = mkdtempSync(join(tmpdir(), 'm59-disc-band-'));
writeFileSync(join(BAND_DIR, 'keeper-bands.json'), JSON.stringify({ testfleet: 19900 }));
process.env.M59_KEEPER_BAND_REGISTRY = join(BAND_DIR, 'keeper-bands.json');

const { walk, trapCheck, resolveStep, KNOWN_TRAPS } = await import('./m59-fleetscript.mjs');
const { SAY_RADIUS, QUEST_NPC_RADIUS, sayApproachSquare, withinSayRange } =
  await import('./m59-sayrange.mjs');
const { script, readProbe, PROBE_ANSWERS, SCHOOLS, KRAANAN_MONSTERS } =
  await import('./fleetscripts/disciple-quest.mjs');

let pass = 0, fail = 0, skip = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};
const skipped = why => { skip++; console.log(`  skip ${why}`); };

// ---------------------------------------------------------------- 1. the sentences
//
// Read back out of the kod rather than out of a second copy in this file: a test that holds
// its own transcription of the string only proves the two transcriptions agree.
const KOD = process.env.M59_ROOT
  ? join(process.env.M59_ROOT, 'kod', 'util', 'questengine.kod')
  : 'C:/code/Meridian59/kod/util/questengine.kod';

function kodResource(src, name) {
  const re = new RegExp(
    `^[ \\t]*${name}[ \\t]*=[ \\t]*\\\\?\\r?\\n?([\\s\\S]*?)(?=\\r?\\n[ \\t]*[A-Za-z_][A-Za-z0-9_]*[ \\t]*=)`,
    'm');
  const m = src.match(re);
  if (!m) return null;
  return [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map(x => x[1].replace(/\\"/g, '"')).join('');
}

console.log('\nthe sentences the server insists on');
let src = null;
try { src = readFileSync(KOD, 'utf8'); } catch { /* no tree here */ }
if (!src) {
  skipped(`no Meridian59 kod tree at ${KOD} — set M59_ROOT to check the cargo strings`);
} else {
  // The steps are built per school, and the cargo is the text of the delivery `say`. Resolve
  // it the way the runner would: the step's `text` is a function of the run state.
  const cargoOf = async school => {
    const steps = await script.steps({ school, agent: 't1', agents: ['t1'] });
    const says = steps.filter(s => s.do === 'say');
    // [0] starts the quest, [1] is the delivery, [2] is the closing word.
    return resolveStep(says[1], { disciple: false, quest: { npc: 'X', room: 1 } }).text;
  };
  for (const [school, rsc] of [['shalille', 'shalilledisciple_trigger'],
                               ['faren', 'farendisciple_trigger'],
                               ['qor', 'qordisciple_trigger']]) {
    const want = kodResource(src, rsc), got = await cargoOf(school);
    ok(`${school}'s sentence is byte-for-byte ${rsc}`, want !== null && got === want,
       want === null ? `${rsc} not found in ${KOD}`
                     : `\n    kod: ${JSON.stringify(want)}\n    us:  ${JSON.stringify(got)}`);
  }
  // The double spaces are the whole reason the case above exists, so assert them directly:
  // a single-space "fix" would still round-trip through any normalising comparison.
  const shal = kodResource(src, 'shalilledisciple_trigger') ?? '';
  ok('and the kod really does put two spaces after a full stop', /people\.  It is time/.test(shal));
  ok('Faren really is spelled "sacriligious" in the source',
     /sacriligious/.test(kodResource(src, 'farendisciple_trigger') ?? ''));
  ok('the kickoff word is exactly "disciple"', kodResource(src, 'disciple_trigger') === 'disciple');
  const start = await script.steps({ school: 'kraanan', agent: 't1', agents: ['t1'] });
  ok('and that is the word this errand says to start one',
     resolveStep(start.filter(s => s.do === 'say')[0], { disciple: false }).text === 'disciple');
}

// ---------------------------------------------------------------- 2. reading her answer
//
// The sentences are `monster.kod:40-54` and `temples.kod:18`, with `%s` filled in the way the
// server fills it.
console.log('\nthe free teach probe, which is the only instrument here');
{
  // THE SENTENCES COME FROM THE KOD, NOT FROM THIS FILE. `monster_teach_base` is split across
  // two source lines mid-word ("...further progress in the " / "previous %s levels..."), so a
  // grep for the runtime wording finds nothing in the source and a grep for the source finds
  // nothing at runtime. Concatenate first, substitute the parms the way the server does, and
  // hand the result to the classifier the errand actually uses.
  const MONSTER_KOD = KOD.replace(/util[\\/]questengine\.kod$/,
    'object/active/holder/nomoveon/battler/monster.kod');
  const TEMPLES_KOD = KOD.replace(/util[\\/]questengine\.kod$/,
    'object/active/holder/nomoveon/battler/monster/temples.kod');
  let msrc = null, tsrc = null;
  try { msrc = readFileSync(MONSTER_KOD, 'utf8'); } catch { /* no tree */ }
  try { tsrc = readFileSync(TEMPLES_KOD, 'utf8'); } catch { /* no tree */ }

  if (!msrc || !tsrc) {
    skipped('no monster.kod / temples.kod here — cannot pin the teacher sentences');
  } else {
    // `%s` is filled with an ability name, a school name or the "how much further" phrase.
    const fill = s => s.replace(/%s/g, 'night vision');
    const cases = [
      // temples.kod:18 — the one answer that means the quest is undone.
      [fill(kodResource(tsrc, 'priestess_teach_quest_needed')), 'not_a_disciple', false],
      // monster.kod:40 — the same gate on the other gated sellers.
      [fill(kodResource(msrc, 'monster_teach_quest_needed')), 'not_a_disciple', false],
      [fill(kodResource(msrc, 'monster_teach_success')), 'qualified', true],
      [fill(kodResource(msrc, 'monster_teach_base')), 'short_on_percentage', true],
      [fill(kodResource(msrc, 'monster_teach_already')), 'already_known', true],
      [fill(kodResource(msrc, 'monster_teach_nobase')), 'no_base', true],
      [fill(kodResource(msrc, 'monster_teach_impossible')), 'school_exhausted', true],
    ];
    for (const [line, verdict, disciple] of cases) {
      const got = line ? readProbe([line]) : null;
      ok(`"${String(line).slice(0, 44)}…" reads as ${verdict}`,
         got?.verdict === verdict && got?.disciple === disciple,
         line ? `got ${JSON.stringify(got?.verdict ?? null)}` : 'resource not found in the kod');
    }
    // THE ORDERING MATTERS AND IS EASY TO BREAK. Only the disciple refusal means the quest is
    // undone; `CanDoTeach` tests the gate BEFORE `PlayerCanLearn` (monster.kod:4506 vs 4536),
    // so every other sentence is itself proof the gate is already open. A classifier that
    // files one of them as `not_a_disciple` sends a character round the world for nothing; one
    // that files the refusal as anything else reports success over a locked shop.
    ok('exactly the two refusals mean "not a disciple"',
       cases.filter(([, v]) => v === 'not_a_disciple').length === 2 &&
       cases.every(([, v, d]) => (v === 'not_a_disciple') === (d === false)));
  }
  ok('an unrecognised sentence is NOT a verdict — silence must not read as a yes',
     readProbe(['Qerti\'nya says, "the weather is fine"']) === null);
  ok('and the first matching answer wins in table order',
     readProbe(['You have already been taught night vision.'])?.verdict === 'already_known');
  ok('every table entry carries a verdict, a disciple bit and a matcher',
     PROBE_ANSWERS.every(a => typeof a.verdict === 'string' &&
                              typeof a.disciple === 'boolean' && a.re instanceof RegExp));
  ok('and the verdicts are unique',
     new Set(PROBE_ANSWERS.map(a => a.verdict)).size === PROBE_ANSWERS.length);
}

// ---------------------------------------------------------------- the temples refusal itself
console.log('\nwhere the gate is, in the source');
{
  const TEMPLES = KOD.replace(/util[\\/]questengine\.kod$/,
    'object/active/holder/nomoveon/battler/monster/temples.kod');
  let t = null;
  try { t = readFileSync(TEMPLES, 'utf8'); } catch { /* no tree */ }
  if (!t) skipped('no temples.kod here');
  else {
    ok('it is still level 3 and above that is gated', /GetLevel\)\s*>\s*2/.test(t));
    ok('and the refusal still names the disciple', /become my disciple/.test(t));
  }
  const KHD = KOD.replace(/util[\\/]questengine\.kod$/, 'include/blakston.khd');
  let k = null;
  try { k = readFileSync(KHD, 'utf8'); } catch { /* no tree */ }
  if (!k) skipped('no blakston.khd here');
  else {
    const close = k.match(/Q_NPC_CLOSE_ENOUGH\s*=\s*(\d+)/)?.[1];
    ok('Q_NPC_CLOSE_ENOUGH is still 5, so the quest reach is still 25 squared',
       Number(close) === 5 && QUEST_NPC_RADIUS === 25, `khd says ${close}`);
    const say = k.match(/SAY_RADIUS\s*=\s*(\d+)/)?.[1];
    ok('and it is still TIGHTER than SAY_RADIUS — the silent band is real',
       Number(say) === SAY_RADIUS && QUEST_NPC_RADIUS < SAY_RADIUS, `khd says ${say}`);
  }
}

// ---------------------------------------------------------------- what Kraanan asks for
//
// THE CLASS AND THE SPOKEN NAME ARE DIFFERENT THINGS AND FOR ONE OF THEM THEY DIFFER A LOT.
// The quest engine holds `&RedAnt`; the priestess says "mutant ant". A parser written against
// the class name finds nothing in her sentence and reports no assignment, which then reads as
// "the quest never started".
console.log('\nthe three monsters, and what she calls them');
{
  if (!src) skipped('no questengine.kod here — cannot pin the monster list');
  else {
    const kraanan = src.match(/template #11[\s\S]{0,400}?monsterlist\s*=\s*\[([^\]]*)\]/);
    const classes = (kraanan?.[1] ?? '').split(',').map(s => s.trim().replace(/^&/, ''));
    ok('the Kraanan node still asks for exactly these three classes',
       classes.join(',') === 'FungusBeast,RedAnt,Skeleton', classes.join(','));
    const two = src.match(/template #11[\s\S]{0,400}?timelimit\s*=\s*(\d+)\s*\*\s*3600/);
    ok('and still gives two hours', two?.[1] === '2' && SCHOOLS.kraanan.deadline === '2 hours',
       `kod says ${two?.[1]} hours, we say ${SCHOOLS.kraanan.deadline}`);

    const NAMES = { FungusBeast: 'fungbst', RedAnt: 'redant', Skeleton: 'skel' };
    const spoken = {};
    for (const [cls, file] of Object.entries(NAMES)) {
      const path = KOD.replace(/util[\\/]questengine\.kod$/,
        `object/active/holder/nomoveon/battler/monster/${file}.kod`);
      let s2 = null;
      try { s2 = readFileSync(path, 'utf8'); } catch { /* no tree */ }
      if (!s2) { skipped(`no ${file}.kod here`); continue; }
      // THE PLAIN `<x>_name_rsc`, NOT `<x>_koc_name_rsc` OR `<x>_dead_name_rsc`. The Kocatan
      // one comes FIRST in every one of these files, so a lazy regex reads "puucmecmoch" and
      // reports that the fleet is hunting the wrong creature. It is not a name the priestess
      // ever uses: `GetKocName` is read only by the morph and illusionary-form spells.
      const name = s2.match(/^\s*(?!\w*_(?:koc|dead)_)\w+_name_rsc\s*=\s*"([^"]+)"/m)?.[1] ?? null;
      spoken[cls] = name;
      const lvl = Number(s2.match(/viLevel\s*=\s*(\d+)/)?.[1]);
      const diff = Number(s2.match(/viDifficulty\s*=\s*(\d+)/)?.[1]);
      const mine = KRAANAN_MONSTERS[name];
      ok(`${cls} is spoken as "${name}" and we hunt it by that name`, !!mine,
         `our table has ${Object.keys(KRAANAN_MONSTERS).join(', ')}`);
      if (mine) ok(`${cls}: level ${lvl} and viDifficulty ${diff} are unchanged`,
                   mine.level === lvl && mine.difficulty === diff,
                   `we say ${mine.level}/${mine.difficulty}`);
    }
    ok('RedAnt really is called something with no "red" in it — this is the whole trap',
       spoken.RedAnt === 'mutant ant', String(spoken.RedAnt));

    // AND THE ROOM WE SEND IT TO HAS TO MAKE THE THING. Asked against the repository's own
    // spawn index rather than against a second copy of it here — `huntingGrounds` already
    // knows the difference between a room that GENERATES a creature and one that merely had
    // one placed at construction, and it already drops the rooms measured to produce nothing.
    // A hardcoded room that quietly stops generating is a two-hour deadline spent standing in
    // an empty valley.
    // `substrate/m59-spawns.json`, which is the index the keeper reads and is committed — NOT
    // `compendium/data/spawns.json`, which is a different shape (rooms keyed by NAME, no
    // `creatures`) and makes every one of these answer "no generators found" rather than
    // failing. `loadSpawns` caches the first path it is given, so this must be the first call
    // in the process.
    const { loadSpawns, huntingGrounds } = await import('./m59-spawns.mjs');
    const spawns = loadSpawns(join(import.meta.dirname, '..', 'substrate', 'm59-spawns.json'));
    if (!spawns?.creatures) skipped('no substrate/m59-spawns.json — cannot check the hunting rooms');
    else for (const [name, m] of Object.entries(KRAANAN_MONSTERS)) {
      const rooms = huntingGrounds(spawns, name, { limit: 40 }).map(r => r.room ?? r.room_num);
      ok(`${name}: room ${m.room} really does generate one`, rooms.includes(m.room),
         `generators are ${rooms.join(', ') || '(none found)'}`);
    }
    ok('and the dangerous roll is still the one we warn about',
       KRAANAN_MONSTERS['mutant ant'].difficulty >= 8 &&
       KRAANAN_MONSTERS['fungus beast'].difficulty < 8);
  }
}

// ---------------------------------------------------------------- the approach
console.log('\nclosing to the reach the caller asked for');
{
  const me = { col: 10, row: 10 }, her = { col: 16, row: 10 };   // squared 36
  ok('six squares out is inside SAY_RADIUS', withinSayRange(me, her) === true);
  ok('and outside the quest node\'s reach', withinSayRange(me, her, QUEST_NPC_RADIUS) === false);
  const lazy = sayApproachSquare(me, her);
  ok('a plain approach says "already there", correctly, for speech', lazy.already === true);
  const tight = sayApproachSquare(me, her, { radius: QUEST_NPC_RADIUS });
  ok('a quest-reach approach does NOT — it used to, and then failed the check it had just passed',
     tight.already === false, JSON.stringify(tight));
  ok('and it aims two squares short of her', tight.col === 14 && tight.row === 10,
     JSON.stringify(tight));
  ok('which is inside the quest reach', withinSayRange(tight, her, QUEST_NPC_RADIUS) === true);
  ok('an unknown position is still not an answer', withinSayRange({ col: 1 }, her) === null);
}

// ---------------------------------------------------------------- 3. the compiler changes
console.log('\na step field that is a function of the run state');
{
  const state = { quest: { monster: 'skeleton', room: 38 }, disciple: false };
  ok('walk resolves its destination', resolveStep(walk(st => st.quest.room), state).to === 38);
  ok('and leaves a literal alone', resolveStep(walk(38), state).to === 38);
  ok('a fight resolves its target',
     resolveStep({ do: 'fight', target: st => st.quest.monster }, state).target === 'skeleton');
  ok('a say resolves both its text and its addressee',
     (r => r.text === 'hello' && r.to === 'Xiana')(
       resolveStep({ do: 'say', text: () => 'hello', to: () => 'Xiana' }, state)));
  ok('a verify\'s callback is NOT resolved — it is the step, not an argument',
     typeof resolveStep({ do: 'verify', fn: () => 1 }, state).fn === 'function');
  ok('an unknown verb is returned untouched',
     (s => resolveStep(s, state) === s)({ do: 'harvest' }));
  ok('and a step with no dynamic field is not copied',
     (s => resolveStep(s, state) === s)(walk(38)));
}

console.log('\na destination decided at run time still has to say where it could go');
{
  const someTrap = Number(Object.keys(KNOWN_TRAPS)[0]);
  ok('there is a known trap to test against', Number.isFinite(someTrap));
  const bare = trapCheck([walk(st => st.room)], { allowTraps: false });
  ok('a bare function destination is refused', /candidates/.test(bare ?? ''), String(bare));
  ok('and it is refused even with allowTraps, because that waives a different claim',
     /candidates/.test(trapCheck([walk(st => st.room)], { allowTraps: true }) ?? ''));
  ok('declaring the rooms is enough when none of them is a trap',
     trapCheck([walk(st => st.room, { candidates: [48, 801, 802] })]) === null);
  const bad = trapCheck([walk(st => st.room, { candidates: [48, someTrap] })]);
  ok('a trap among the candidates is caught before anything walks',
     bad !== null && bad.includes(String(someTrap)), String(bad));
  ok('and allowTraps still waives that half',
     trapCheck([walk(st => st.room, { candidates: [48, someTrap] })], { allowTraps: true }) === null);
  ok('a literal walk into a trap is caught as it always was',
     /allowTraps/.test(trapCheck([walk(someTrap)]) ?? ''));
}

// ---------------------------------------------------------------- the plan itself
console.log('\nthe errand, per school');
{
  for (const school of ['kraanan', 'shalille', 'faren', 'qor']) {
    const steps = await script.steps({ school, agent: 't1', agents: ['t1'],
                                       rounds: 40, abortBelow: 0.5, home: 39 });
    const verbs = steps.map(s => s.do);
    ok(`${school}: the plan starts at the temple and ends at home`,
       verbs[0] === 'walk' && steps[steps.length - 1].to === 39 &&
       steps[steps.length - 1].always === true, verbs.join(' '));
    ok(`${school}: it asks before it acts, and measures before it reports`,
       verbs[1] === 'verify' && verbs[verbs.length - 2] === 'verify', verbs.join(' '));
    ok(`${school}: every run-time walk declares its candidate rooms`,
       steps.filter(s => s.do === 'walk' && typeof s.to === 'function')
            .every(s => Array.isArray(s.candidates) && s.candidates.length),
       verbs.join(' '));
    ok(`${school}: and the whole plan passes the trap check`,
       trapCheck(steps, { allowTraps: false }) === null,
       String(trapCheck(steps, { allowTraps: false })));
    ok(`${school}: every say aims at the quest node's reach, not at earshot`,
       steps.filter(s => s.do === 'say').every(s => s.radius === QUEST_NPC_RADIUS));
  }

  // THE ONE DESTINATION THAT EXISTS TWICE. `HazarBartender` is live at 1007 and 1017 and both
  // are called "Eric d'Jorn", so the assign hint — which carries only the name — cannot say
  // which. The second address is walked only when the first delivery was not heard to land.
  {
    const fa = await script.steps({ school: 'faren', agent: 't1', agents: ['t1'] });
    const walks = fa.filter(s => s.do === 'walk' && typeof s.to === 'function');
    ok('faren declares both Hazarbad rooms as candidates',
       walks.every(w => w.candidates.includes(1007) && w.candidates.includes(1017)),
       JSON.stringify(walks.map(w => w.candidates)));
    const alt = walks[1];
    ok('a delivery that landed does not walk to the twin',
       resolveStep(alt, { delivered: true, quest: { npc: 'x', room: 1007, alt: 1017 } }).to === 45);
    ok('a delivery that did not land does',
       resolveStep(alt, { delivered: false, quest: { npc: 'x', room: 1007, alt: 1017 } }).to === 1017);
    ok('and a destination with no twin never walks a second time',
       resolveStep(alt, { delivered: false, quest: { npc: 'x', room: 103, alt: null } }).to === 45);
    // Every other school must not grow a twin leg by accident.
    for (const school of ['shalille', 'qor']) {
      const steps = await script.steps({ school, agent: 't1', agents: ['t1'] });
      const dyn = steps.filter(s => s.do === 'walk' && typeof s.to === 'function');
      ok(`${school}: its second address resolves to the temple, because it has no twin`,
         resolveStep(dyn[1], { delivered: false, quest: { npc: 'x', room: 1, alt: null } }).to
           === (school === 'shalille' ? 48 : 802));
    }
  }

  // THE DESTINATION'S REBUFF IS THE SUCCESS MESSAGE, and the errand reads it to decide whether
  // to try the twin. A regex that stops matching turns a delivered message into a second town.
  if (src) {
    for (const [school, rsc] of [['shalille', 'shalilledisciple_invoke_success'],
                                 ['faren', 'farendisciple_invoke_success'],
                                 ['qor', 'qordisciple_invoke_success']]) {
      const line = kodResource(src, rsc);
      const steps = await script.steps({ school, agent: 't1', agents: ['t1'] });
      // Reach the regex through the built plan rather than re-declaring it here.
      ok(`${school}: the delivery rebuff is still recognised as success`,
         line !== null && steps.length > 0 && SCHOOLS[school].invoke.test(line),
         `kod says ${JSON.stringify(line)}`);
    }
  }

  const kr = await script.steps({ school: 'kraanan', agent: 't1', agents: ['t1'],
                                  rounds: 40, abortBelow: 0.5 });
  ok('kraanan is the only school that fights', kr.some(s => s.do === 'fight'));
  const f = kr.find(s => s.do === 'fight');
  ok('and that fight is optional, so an unassigned run does not swing at a bystander',
     f.optional === true);
  ok('an unassigned fight resolves to no target at all',
     resolveStep(f, { quest: null }).target === null);

  // THE WORD IS SAID ONCE. Joining a second instance of a quest already in flight is how a
  // character ends up holding a deadline nobody is working on, so the closing utterance must
  // not be the trigger word.
  for (const school of ['kraanan', 'shalille', 'faren', 'qor']) {
    const steps = await script.steps({ school, agent: 't1', agents: ['t1'] });
    const spoken = steps.filter(s => s.do === 'say')
      .map(s => resolveStep(s, { disciple: false, quest: { npc: 'X', room: 1 } }).text);
    ok(`${school}: "disciple" is said exactly once in the whole errand`,
       spoken.filter(t => t === 'disciple').length === 1, JSON.stringify(spoken.map(t => t.slice(0, 20))));
    const done = steps.filter(s => s.do === 'say')
      .map(s => resolveStep(s, { disciple: true }).text);
    ok(`${school}: and not at all for a character that is already a disciple`,
       done.every(t => t === ''), JSON.stringify(done));
  }
}

console.log('\nthe two schools with no quest');
{
  for (const school of ['riija', 'jala']) {
    let threw = null;
    try { await script.steps({ school, agent: 't1', agents: ['t1'] }); }
    catch (e) { threw = e.message; }
    ok(`${school} is refused by name, with the reason`,
       threw !== null && /no disciple quest/.test(threw), String(threw));
  }
  let threw = null;
  try { await script.steps({ school: 'kranan', agent: 't1', agents: ['t1'] }); }
  catch (e) { threw = e.message; }
  ok('and a typo lists what it could have meant',
     threw !== null && /kraanan/.test(threw), String(threw));
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
