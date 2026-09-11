#!/usr/bin/env node
// CAN A CHARACTER WALK ACROSS THE WORLD AND COME BACK HAVING LEARNED SOMETHING?
//
//   node tools/m59-learnskill-test.mjs            # offline, no broker, no server, no network
//   node tools/m59-learnskill-test.mjs --live --agent t4 --skill "punch" \
//        --teacher-room 106 --teacher Rook --price 500 --home 39
//
// WHY THIS IS A SEPARATE SUITE. `m59-fleetscript-test.mjs` pins the GUARANTEES — the run
// lock, the lease, the health floor, the budgets — one case per mistake a real ad-hoc script
// made. This one pins a CAPABILITY: the whole errand, end to end, as a thing somebody can be
// shown. Cross a continent, spend money at a stranger, and prove the character is different
// afterwards. It is the longest causal chain this repository can execute, and every link in
// it has failed in production at least once.
//
// IT IS NOT IN THE STANDARD OFFLINE LIST ON PURPOSE. The offline half is fast and safe and
// could be; the point of the file is the `--live` half, which walks a real character to a
// real teacher and spends real money, and that is a demo somebody runs deliberately.
//
// ---------------------------------------------------------------------------
// WHAT IT FOUND ON ITS FIRST RUN, which is the reason to keep it
// ---------------------------------------------------------------------------
//
// **A SKILL IS NOT GOODS, AND THE `shop` VERB COULD NOT EXPRESS ONE.** `shop` judges a purchase
// by what entered the PACK — `inventoryCounts` before and after, and `ok: anything` where
// anything means a stack got bigger (m59-fleetscript.mjs, case 'shop'). That rule is right,
// and it was bought expensively: a merchant that completes the handshake and hands over
// nothing looks like success on the wire.
//
// A skill enters nothing. `PlayerCanLearn` adds it to the character and says nothing
// (monster.kod:3865), so the pack is identical either side of a successful purchase. So the
// step waits out `packSettleMs`, reports `nothing entered the pack`, and — because a
// non-optional failure sets `failure` and every later step without `always` is skipped
// (m59-fleetscript.mjs ~1145) — **the `verify` that was the whole point never runs, and
// neither does the walk home.** The character is left standing at the teacher, the run says
// it failed, and the one question anybody cared about (did it learn the skill?) is unasked.
//
// THAT IS NOW BAKED INTO FleetScript RATHER THAN WRITTEN DOWN. `learn(teacher, ability)` is
// the verb, judged on the character's own skill and spell lists asked for over the wire, and
// `shop` REFUSES an ability at plan time — before the character walks — naming `learn`. The
// ability table is read from the game's own class tree (22 skills, 177 spells in
// compendium/data/koddb.json), the same discipline FOOD_KEEP uses, because a hand-written
// list of abilities goes stale in silence.
//
// This suite is what proves all of that still holds, and it keeps the end-to-end errand as
// the thing somebody can be SHOWN.
//
// A NOTE ON THE MONEY, because it is why `learn` reports THREE outcomes and not two. On
// 2026-09-07 a character standing with Rook, punch in the live shop list at 500, was charged
// exactly 500 and never received the skill — confirmed over 100s of polling. That defect is
// unresolved and is not a scripting bug. `charged_but_not_delivered` is what turns "the
// errand says it worked" into "the purse moved and the skill did not", which is the
// difference between noticing it once and paying for it twenty-one times. It is also why
// nothing here retries: each attempt costs the price again.
import { mkdtempSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// A TEST MUST NEVER TAKE THE LIVE FLEET'S RUN LOCK, and the module takes one on import.
// Scratch directory first, and a control URL nothing can answer, exactly as the sibling
// suite does — see the note at the top of m59-fleetscript-test.mjs.
const LOCK_DIR = mkdtempSync(join(tmpdir(), 'm59-learnskill-'));
process.env.M59_RUNLOCK_DIR = LOCK_DIR;
// AND A SCRATCH LEDGER. `learn` writes a `learn_attempt` row and READS ITS OWN ROWS BACK to
// refuse a second charge, so this suite both writes and reads history — which must never be
// the fleet's own. m59-ledger refuses a test write without this and says so on stderr.
const LEDGER_DIR = mkdtempSync(join(tmpdir(), 'm59-learnskill-ledger-'));
process.env.M59_LEDGER_DIR = LEDGER_DIR;
const LIVE = process.argv.includes('--live');
if (!LIVE) process.env.M59_CONTROL_URL = 'http://127.0.0.1:1/';
// Each fleetScript call installs its own signal handlers; a suite that runs a dozen trips
// the noise is not a leak. Raised rather than silenced so a REAL leak still shows up.
process.setMaxListeners(64);

const { fleetScript, walk, bank, shop, learn, verify, KNOWN_TRAPS,
        abilityNames, isAbilityName, abilitiesTargetedBy } =
  await import('./m59-fleetscript.mjs');
const { stateFileFor } = await import('./m59-fleetpath.mjs');
// One name, used by every case AND by the fake's /health answer — they have to agree or
// guarantee 11 refuses the run as the wrong broker.
const TEST_FLEET = 'learnskilltest';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};
const quiet = () => {};

// ---------------------------------------------------------------- the fake world
//
// Modelled on m59-fleetscript-test's fake, plus the two things a teacher trip needs and a
// supply run does not: an `abilities` answer, and a shop that can take money without
// handing over an object. `sent` records every call, because most of what is asserted here
// is about what was NOT sent — a second `travel` into a journey already in flight, a
// `verify` that never ran, a bank leg on a character that could already pay.
function fakeWorld({
  rooms = {}, health = {}, inventory = {},
  // What the teacher lists. A skill only APPEARS when PlayerCanLearn says SUCCESS and the
  // character does not already hold it (monster.kod:4855-4862), so an empty shelf is a
  // legitimate "you have not earned it yet" and not an error.
  shelf = [{ id: 41, name: 'punch', price: 500 }],
  // How many polls before the skill shows up in the ability list. `Infinity` is the
  // money bug: charged, never delivered.
  learnedAfterPolls = 1,
  charge = 500,
  // The character walked here already holding it. A teacher does not list an ability you
  // hold, so without this the "not offered" branch cannot tell "you have it" from "you have
  // not earned it" — and the first is a success being reported as a failure on every repeat
  // run of a standing errand.
  alreadyHeld = false,
} = {}) {
  const sent = [];
  let abilityPolls = 0;
  const skills = alreadyHeld ? [{ name: shelf[0]?.name }] : [];
  globalThis.fetch = async (_url, opts) => {
    // GUARANTEE 11's BROKER-IDENTITY PROBE IS A BODYLESS GET, and this fake assumed every
    // request carried a JSON body. `JSON.parse(undefined)` threw, the probe's catch turned
    // that into `"undefined" is not valid JSON`, and the whole suite died at its first case
    // with "cannot tell whether the broker is holding fleet" — on a test that opens no socket
    // at all. A broker is ours only when its /health STATE PATH is our roster file, so the
    // fake answers with this fleet's own.
    if (!opts?.body) return { json: async () => ({ state: stateFileFor(TEST_FLEET) }) };
    const body = JSON.parse(opts.body);
    const { name, arguments: a } = body.params;
    sent.push({ name, ...a });
    const agent = a.agent;
    let payload = {};
    if (name === 'status') {
      payload = { where: { num: rooms[agent], name: 'room' },
                  hp: health[agent] ?? { value: 50, max: 50 }, gold: null };
    } else if (name === 'travel') {
      rooms[agent] = a.to;
      payload = { started: true };
    } else if (name === 'travel_estimate') {
      payload = { ms: 1000, hops: 9 };
    } else if (name === 'inventory') {
      payload = { items: inventory[agent] ?? [] };
    } else if (name === 'shop') {
      if (a.buy_ids) {
        // THE COUNTER TAKES THE MONEY AND HANDS OVER NOTHING YOU CAN CARRY. That is not a
        // failure being simulated, it is what buying a skill IS.
        const purse = (inventory[agent] ?? []).find(i => /shilling/i.test(i.name));
        if (purse) purse.amount -= charge;
        if (Number.isFinite(learnedAfterPolls)) skills.push({ name: shelf[0]?.name });
        payload = { bought: [] };
      } else payload = { items: shelf };
    } else if (name === 'abilities') {
      abilityPolls++;
      // An ability already held is visible on the FIRST ask; a freshly bought one only once
      // the list has caught up with the counter. `spells` is answered too, because `learn`
      // asks for both and a skill and a spell are bought the same way.
      const visible = alreadyHeld
        || (Number.isFinite(learnedAfterPolls) && abilityPolls >= learnedAfterPolls);
      payload = { skills: visible ? skills : [], spells: [] };
    } else if (name === 'bank') {
      payload = { banker_said: ['Skivlat hands it over.'] };
      const inv = inventory[agent] ??= [];
      const purse = inv.find(i => /shilling/i.test(i.name)) ?? (inv.push({ name: 'shilling', amount: 0 }), inv.at(-1));
      purse.amount += Number(a.amount) || 0;
    } else payload = { ok: true };
    return { json: async () => ({ result: { content: [{ text: JSON.stringify(payload) }] } }) };
  };
  return sent;
}

// The errand, built from the tracked verbs so this suite stands on its own. A fleetscript on
// disk is an ORDER and lives on the machine that owns the roster (see CLAUDE.md); a
// capability test may not depend on one being there.
const skillRx = s => new RegExp(`^${String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

function learnSkillSteps({ skill, teacherRoom, teacher, price, bankRoom = 54,
                           carrying = 0, home } = {}) {
  const needsBank = Number(carrying) < Number(price);
  return [
    // EXACT FUNDING, AND ONLY WHEN SHORT. A needless town lap is not free — four characters
    // died on these roads in one night — so the bank leg is absent, not skipped at runtime.
    ...(needsBank ? [walk(bankRoom), bank('withdraw', Number(price) - Number(carrying))] : []),
    walk(teacherRoom),
    // `learn`, NOT `shop`. The verb discovers the row id, keeps "not offered" apart from
    // "charged and not delivered", and is judged on the ability list rather than the pack.
    learn(teacher, skill),
    // ALWAYS, so a character that failed to learn is still brought home rather than left
    // standing at a merchant on the far side of the world.
    { ...walk(home), always: true },
  ];
}

const trip = (over = {}) => ({
  name: 'learn-skill-test', fleet: 'learnskilltest', agents: ['a1'],
  pollMs: 20, healMs: 200, packSettleMs: 200, learnSettleMs: 400,
  budgetFloorMs: 400, budgetCapMs: 800,
  onLog: quiet, ...over,
});

if (!LIVE) {
  console.log('walking across the world to buy a skill — offline\n');

  console.log('the errand, end to end');
  {
    const inv = { a1: [{ name: 'shilling', amount: 900 }] };
    const sent = fakeWorld({ rooms: { a1: 39 }, inventory: inv });
    const r = await fleetScript(trip({ steps: learnSkillSteps({
      skill: 'punch', teacherRoom: 106, teacher: 'Rook', price: 500, carrying: 900, home: 39 }) }));
    const walks = sent.filter(s => s.name === 'travel').map(s => s.to);
    ok('the run succeeds', r.ok === true && r.results.a1.ok === true,
       JSON.stringify(r.results.a1?.why ?? r.results.a1));
    ok('it walked to the teacher and then home', walks.join(',') === '106,39', walks.join(','));
    ok('it asked the teacher for a list before buying',
       sent.some(s => s.name === 'shop' && !s.buy_ids));
    ok('it read the ability list back afterwards', sent.some(s => s.name === 'abilities'));
    ok('and the purse actually moved',
       inv.a1[0].amount === 400, String(inv.a1[0].amount));
  }

  console.log('\nthe bank leg is absent when the character can already pay');
  {
    const sent = fakeWorld({ rooms: { a1: 39 }, inventory: { a1: [{ name: 'shilling', amount: 900 }] } });
    await fleetScript(trip({ steps: learnSkillSteps({
      skill: 'punch', teacherRoom: 106, teacher: 'Rook', price: 500, carrying: 900, home: 39 }) }));
    ok('no bank call', !sent.some(s => s.name === 'bank'));
    ok('and no lap through the bank room',
       !sent.some(s => s.name === 'travel' && s.to === 54));
  }

  console.log('\nand present when it is short');
  {
    const sent = fakeWorld({ rooms: { a1: 39 }, inventory: { a1: [{ name: 'shilling', amount: 100 }] } });
    await fleetScript(trip({ steps: learnSkillSteps({
      skill: 'punch', teacherRoom: 106, teacher: 'Rook', price: 500, carrying: 100, home: 39 }) }));
    const w = sent.filter(s => s.name === 'travel').map(s => s.to);
    ok('it goes to the bank first, then the teacher, then home', w.join(',') === '54,106,39', w.join(','));
    const withdrawal = sent.find(s => s.name === 'bank');
    ok('and withdraws exactly the shortfall, not a round number', withdrawal?.amount === 400,
       String(withdrawal?.amount));
  }

  console.log('\nCHARGED AND NOT DELIVERED IS A FAILURE — the defect of 2026-09-07');
  {
    // ITS OWN AGENT. `learn` now remembers a charge that bought nothing and refuses the
    // next attempt for that character, so a case that deliberately gets charged would
    // poison every later case sharing the name. That refusal is exercised on purpose
    // in its own section further down.
    const inv = { a9: [{ name: 'shilling', amount: 900 }] };
    const sent = fakeWorld({ rooms: { a9: 39 }, inventory: inv, learnedAfterPolls: Infinity });
    const r = await fleetScript(trip({ agents: ['a9'], steps: learnSkillSteps({
      skill: 'punch', teacherRoom: 106, teacher: 'Rook', price: 500, carrying: 900, home: 39 }) }));
    ok('the errand fails even though the counter said nothing was wrong',
       r.results.a9.ok === false);
    ok('and it says the purse moved and the skill did not',
       /never appeared in the skill or spell list/.test(r.results.a9.why ?? ''), r.results.a9.why);
    ok('the purse is down by the price, which is the evidence that matters',
       inv.a9[0].amount === 400, String(inv.a9[0].amount));
    ok('it asked more than once before believing the no',
       sent.filter(s => s.name === 'abilities').length >= 3,
       String(sent.filter(s => s.name === 'abilities').length));
    ok('and it still walked the character home rather than abandoning it at the teacher',
       sent.filter(s => s.name === 'travel').map(s => s.to).at(-1) === 39);
  }

  console.log('\nthe list lags the counter, so a late skill is still a success');
  {
    fakeWorld({ rooms: { a1: 39 }, inventory: { a1: [{ name: 'shilling', amount: 900 }] },
                learnedAfterPolls: 3 });
    const r = await fleetScript(trip({ steps: learnSkillSteps({
      skill: 'punch', teacherRoom: 106, teacher: 'Rook', price: 500, carrying: 900, home: 39 }) }));
    ok('a skill that appears on the third poll is learned, not lost', r.results.a1.ok === true,
       r.results.a1.why);
  }

  console.log('\nthe guarantees are still on underneath it');
  {
    const sent = fakeWorld({ rooms: { a1: 39 }, health: { a1: { value: 4, max: 50 } },
                             inventory: { a1: [{ name: 'shilling', amount: 900 }] } });
    const r = await fleetScript(trip({ steps: learnSkillSteps({
      skill: 'punch', teacherRoom: 106, teacher: 'Rook', price: 500, carrying: 900, home: 39 }) }));
    ok('a character at 4 of 50 does not set out for the teacher', r.results.a1.ok === false);
    ok('and no money was spent on the way to not going',
       !sent.some(s => s.name === 'shop' && s.buy_ids));
  }
  {
    const trap = Number(Object.keys(KNOWN_TRAPS)[0]);
    const sent = fakeWorld({ rooms: { a1: 39 }, inventory: { a1: [{ name: 'shilling', amount: 900 }] } });
    const r = await fleetScript(trip({ steps: learnSkillSteps({
      skill: 'punch', teacherRoom: trap, teacher: 'Rook', price: 500, carrying: 900, home: 39 }) }));
    ok(`a teacher inside a known trap (${trap}) is refused before anything walks`,
       r.results.a1.ok === false && !sent.some(s => s.name === 'travel' && s.to === trap),
       r.results.a1.why);
  }

  // THE REFUSAL THAT MAKES ALL OF THE ABOVE UNNECESSARY TO REMEMBER.
  console.log('\n`shop` refuses a skill BEFORE the character walks');
  {
    const sent = fakeWorld({ rooms: { a1: 39 }, inventory: { a1: [{ name: 'shilling', amount: 900 }] } });
    const r = await fleetScript(trip({ steps: [
      walk(106),
      shop('Rook', [{ match: skillRx('punch'), amount: 1 }]),
      walk(39),
    ] }));
    ok('the plan is refused', r.results.a1.ok === false);
    ok('and NOTHING WALKED — the refusal costs no journey',
       !sent.some(s => s.name === 'travel'), JSON.stringify(sent.map(x => x.name)));
    ok('it names the verb to use instead',
       /learn\('Rook', 'punch'\)/.test(r.results.a1.why ?? ''), r.results.a1.why);
    ok('and says why the pack cannot answer the question',
       /enters nothing/.test(r.results.a1.why ?? ''), r.results.a1.why);
  }

  console.log('\nand the reagent run is NOT refused, which is the harder half');
  {
    // `/herb/i` matches `slitherbolt`, a real spell. A check that refused this would break
    // the errand that keeps twenty-one characters in reagents, and would deserve deleting.
    const sent = fakeWorld({ rooms: { a1: 39 }, inventory: { a1: [{ name: 'shilling', amount: 900 }] },
                             shelf: [{ id: 7, name: 'herb', price: 3 }] });
    const r = await fleetScript(trip({ steps: [
      walk(106),
      shop('Frisconar', [{ match: /herb/i, amount: 2 }]),
    ] }));
    ok('a loose /herb/ is goods, not the spell it happens to be a substring of',
       r.results.a1.ok === true || !/learn\(/.test(r.results.a1.why ?? ''),
       r.results.a1.why);
    ok('and it really did go shopping', sent.some(s => s.name === 'shop'));
  }

  console.log('\nthe ability table, read from the game rather than typed');
  {
    ok('it has both skills and spells in it', abilityNames().length > 150,
       String(abilityNames().length));
    ok('punch is a skill', isAbilityName('punch'));
    ok('blink is a spell', isAbilityName('blink'));
    ok('herb is neither', !isAbilityName('herb'));
    ok('an anchored pattern names its ability',
       abilitiesTargetedBy([{ match: /^punch$/i }]).join() === 'punch');
    ok("resupply's own reagent lines target no ability at all",
       abilitiesTargetedBy([{ match: /elder/i }, { match: /herb/i }]).length === 0,
       JSON.stringify(abilitiesTargetedBy([{ match: /elder/i }, { match: /herb/i }])));
  }

  console.log('\nan ability already held is a success, not a failed purchase');
  {
    const sent = fakeWorld({ rooms: { a1: 39 }, inventory: { a1: [{ name: 'shilling', amount: 900 }] },
                             alreadyHeld: true });
    const r = await fleetScript(trip({ steps: learnSkillSteps({
      skill: 'punch', teacherRoom: 106, teacher: 'Rook', price: 500, carrying: 900, home: 39 }) }));
    ok('the run succeeds', r.results.a1.ok === true, r.results.a1.why);
    ok('and no money was spent buying something it already had',
       !sent.some(s => s.name === 'shop' && s.buy_ids));
  }

  console.log('\nA CHARGE THAT BOUGHT NOTHING IS REMEMBERED, and the second attempt is refused');
  {
    // The first trip is charged and gets nothing — the 2026-09-07 defect, which writes a row.
    fakeWorld({ rooms: { a2: 39 }, inventory: { a2: [{ name: 'shilling', amount: 900 }] },
                learnedAfterPolls: Infinity });
    const first = await fleetScript(trip({ agents: ['a2'], steps: learnSkillSteps({
      skill: 'punch', teacherRoom: 106, teacher: 'Rook', price: 500, carrying: 900, home: 39 }) }));
    ok('the first attempt fails as charged_but_not_delivered',
       first.results.a2.state?.['1:learn']?.outcome === 'charged_but_not_delivered',
       JSON.stringify(first.results.a2.state?.['1:learn']));

    // The second is refused BEFORE the counter, on the evidence of the first.
    const inv = { a2: [{ name: 'shilling', amount: 900 }] };
    const sent = fakeWorld({ rooms: { a2: 39 }, inventory: inv, learnedAfterPolls: Infinity });
    const second = await fleetScript(trip({ agents: ['a2'], steps: learnSkillSteps({
      skill: 'punch', teacherRoom: 106, teacher: 'Rook', price: 500, carrying: 900, home: 39 }) }));
    ok('the second attempt is refused rather than paying again',
       second.results.a2.state?.['1:learn']?.outcome === 'refused_after_charge',
       JSON.stringify(second.results.a2.state?.['1:learn']));
    ok('and NO money moved the second time',
       inv.a2[0].amount === 900 && !sent.some(s => s.name === 'shop' && s.buy_ids),
       String(inv.a2[0].amount));
    ok('the refusal says when it was charged and what to pass to override',
       /retry: true/.test(second.results.a2.state?.['1:learn']?.why ?? ''),
       second.results.a2.state?.['1:learn']?.why);

    // An operator who has understood the cause can say so. Deliberately something you type.
    const inv3 = { a2: [{ name: 'shilling', amount: 900 }] };
    const sent3 = fakeWorld({ rooms: { a2: 39 }, inventory: inv3 });
    const third = await fleetScript(trip({ agents: ['a2'], steps: [
      walk(106), learn('Rook', 'punch', { retry: true }), { ...walk(39), always: true },
    ] }));
    ok('`retry: true` gets past the refusal', third.results.a2.ok === true,
       JSON.stringify(third.results.a2.why ?? third.results.a2.state?.['1:learn']));
    ok('and that attempt really did go to the counter',
       sent3.some(s => s.name === 'shop' && s.buy_ids));
  }

  console.log('\nand every attempt leaves a row, so the defect is a number not an anecdote');
  {
    const rows = readdirSync(LEDGER_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .flatMap(f => readFileSync(join(LEDGER_DIR, f), 'utf8').split('\n').filter(Boolean))
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && e.kind === 'learn_attempt');
    ok('learn_attempt rows were written', rows.length >= 2, String(rows.length));
    ok('each names the ability and the teacher',
       rows.every(r => r.ability === 'punch' && r.teacher === 'Rook'));
    ok('a charged-and-not-delivered row records what it cost',
       rows.some(r => r.outcome === 'charged_but_not_delivered' && r.spent === 500),
       JSON.stringify(rows.map(r => [r.outcome, r.spent])));
    ok('and `room` is a MAP number, never a room object id',
       rows.every(r => r.room === null || (Number.isInteger(r.room) && r.room < 1000)),
       JSON.stringify(rows.map(r => r.room)));
  }

  // OPPORTUNISTIC. `tools/fleetscripts/` holds ORDERS, which live on the machine that owns
  // the roster and are not all committed — so a missing script is not a failure here. When
  // one IS present, its shape is worth checking against what this suite just proved.
  console.log('\nthe learn-skill fleetscript on this machine, if there is one');
  {
    const p = join(HERE, 'fleetscripts', 'learn-skill.mjs');
    if (!existsSync(p)) {
      console.log('  --   none present (orders are per-machine; not a failure)');
    } else {
      const { script } = await import('file://' + p.replace(/\\/g, '/'));
      const steps = await script.steps({ skill: 'punch', teacherRoom: 106, teacher: 'Rook',
        price: 500, bankRoom: 54, carrying: 900, home: 39 });
      const kinds = steps.map(s => s.do);
      ok('it walks, buys, verifies and goes home',
         kinds.includes('walk') && kinds.includes('verify')
         && kinds.filter(k => k === 'walk').length >= 2, kinds.join(','));
      ok('it verifies the skill rather than trusting the counter',
         steps.some(s => s.do === 'verify'));
      ok('it does not spell the purchase with `shop` — see the header',
         !steps.some(s => s.do === 'shop'),
         'this script uses `shop`, which is judged on the pack; a skill never enters it, ' +
         'so the verify and the walk home are skipped and the character is stranded');
      ok('and the walk home runs even when the purchase failed',
         steps.filter(s => s.do === 'walk').at(-1)?.always === true,
         'the last walk is not `always`, so a failed purchase abandons the character');

      // A SPELL IS AN ABILITY TOO, AND THE VERIFY COULD NOT SEE ONE.
      //
      // It asked `abilities` for `kind: 'skills'` and read only `a.skills`, so for a spell the
      // answer could never be yes however long it polled. Measured 2026-09-11: Statler bought
      // minor heal at Priestess Xiana, the `learn` step's own poll saw it and reported ok, and
      // this verify then declared "charged and never appeared in the skill list" — a sentence
      // that tells an operator to go and spend the price a second time. The callback is run
      // directly here against a broker that answers spells-only, because the shape of the
      // question is the whole bug.
      const v = steps.find(s => s.do === 'verify');
      const spellOnly = async (tool) =>
        tool === 'abilities' ? { skills: [], spells: [{ name: 'punch', ability: null }] } : {};
      ok('a verify that only reads `skills` cannot see a SPELL, so it must read both',
         (await v.fn({ agent: 'a1', call: spellOnly })) === true,
         'the purchase verify still asks only for skills — a spell reads as charged-and-not-delivered');
      ok('and it asks the broker for BOTH lists rather than filtering one',
         /kind:\s*'both'/.test(String(v.fn)));
    }
  }

  rmSync(LOCK_DIR, { recursive: true, force: true });
  rmSync(LEDGER_DIR, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ---------------------------------------------------------------- the live demo
//
// ONE CHARACTER, NAMED ON THE COMMAND LINE. There is no default agent and no default fleet
// on purpose: this spends money and walks a real body across the world, and a flag with a
// default is how that happens to somebody who was only trying to run the tests.
const arg = (k, d = null) => {
  const i = process.argv.indexOf(k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const need = k => arg(k) ?? (() => { throw new Error(`--live needs ${k}`); })();

const agent = need('--agent'), skill = need('--skill');
const teacherRoom = Number(need('--teacher-room')), teacher = need('--teacher');
const price = Number(need('--price')), home = Number(need('--home'));
const carrying = Number(arg('--carrying', '0'));

console.log(`LIVE: ${agent} -> room ${teacherRoom} to buy "${skill}" from ${teacher} ` +
            `for ${price}, then home to ${home}`);
console.log('this spends real money and walks a real character. Ctrl-C now if that is a surprise.\n');

const r = await fleetScript({
  name: 'learn-skill-demo', agents: [agent],
  steps: learnSkillSteps({ skill, teacherRoom, teacher, price, carrying, home,
                           pollEvery: 2500, polls: 6 }),
});
console.log(JSON.stringify(r.results, null, 1));
rmSync(LOCK_DIR, { recursive: true, force: true });
process.exit(r.ok ? 0 : 1);
