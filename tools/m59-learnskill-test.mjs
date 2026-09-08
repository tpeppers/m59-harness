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
// **A SKILL IS NOT GOODS, AND THE `shop` VERB CANNOT EXPRESS ONE.** `shop` judges a purchase
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
// The errand is expressible; it just cannot be spelled with `shop`. Two `verify` steps do it
// — one that reads the teacher's shelf and remembers the row, one that buys it and then polls
// the ability list — because `verify` is the only step judged on evidence the caller chooses
// rather than on the pack. That is the shape asserted below, and the shape a working
// `learn-skill` fleetscript has to have.
//
// THE LIST STEP IS NOT CEREMONY. The id has to be discovered: a skill's shop row id is not
// stable, is not derivable from its name, and hard-coding one buys whatever is in that slot
// today. Splitting the read from the buy also keeps two failures apart that would otherwise
// collapse into one — "the teacher is not offering it" (already held, or PlayerCanLearn says
// not yet, and neither is an error) against "the purse moved and the skill did not".
//
// A NOTE ON THE MONEY, because it is the reason `verify` is not optional. On 2026-09-07 a
// character standing with Rook, punch in the live shop list at 500, was charged exactly 500
// and never received the skill — confirmed over 100s of polling. That defect is unresolved
// and is not a scripting bug. `verify` is what turns "the errand says it worked" into "the
// purse moved and the skill did not", which is the difference between noticing it once and
// paying for it twenty-one times. A test that let the errand report success without it would
// be actively harmful.
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// A TEST MUST NEVER TAKE THE LIVE FLEET'S RUN LOCK, and the module takes one on import.
// Scratch directory first, and a control URL nothing can answer, exactly as the sibling
// suite does — see the note at the top of m59-fleetscript-test.mjs.
const LOCK_DIR = mkdtempSync(join(tmpdir(), 'm59-learnskill-'));
process.env.M59_RUNLOCK_DIR = LOCK_DIR;
const LIVE = process.argv.includes('--live');
if (!LIVE) process.env.M59_CONTROL_URL = 'http://127.0.0.1:1/';
// Each fleetScript call installs its own signal handlers; a suite that runs a dozen trips
// the noise is not a leak. Raised rather than silenced so a REAL leak still shows up.
process.setMaxListeners(64);

const { fleetScript, walk, bank, shop, verify, KNOWN_TRAPS } =
  await import('./m59-fleetscript.mjs');

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
} = {}) {
  const sent = [];
  let abilityPolls = 0;
  const skills = [];
  globalThis.fetch = async (_url, opts) => {
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
      payload = { skills: (Number.isFinite(learnedAfterPolls) && abilityPolls >= learnedAfterPolls)
        ? skills : [] };
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
                           carrying = 0, home, pollEvery = 20, polls = 6 } = {}) {
  const rx = skillRx(skill);
  const needsBank = Number(carrying) < Number(price);
  return [
    // EXACT FUNDING, AND ONLY WHEN SHORT. A needless town lap is not free — four characters
    // died on these roads in one night — so the bank leg is absent, not skipped at runtime.
    ...(needsBank ? [walk(bankRoom), bank('withdraw', Number(price) - Number(carrying))] : []),
    walk(teacherRoom),
    // READ THE SHELF AND REMEMBER THE ROW. Not `shop` — see the header: `shop` is judged on
    // the pack, a skill never enters it, and spelling this with `shop` fails the errand
    // before the verify that is the entire point. The id is discovered rather than
    // hard-coded, because a shop row id is not stable and not derivable from the name.
    //
    // An empty shelf is its own answer and a legitimate one: a skill only appears when
    // PlayerCanLearn says SUCCESS and the character does not already hold it
    // (monster.kod:4855-4862), so "not offered" means already held or not yet earned.
    verify(async ({ agent, call, state }) => {
      const list = await call('shop', { agent, seller: teacher }, 60_000).catch(() => null);
      state.skillRow = (list?.items || []).find(i => rx.test(String(i.name || ''))) ?? null;
      return Boolean(state.skillRow);
    }, `${teacher} is not offering "${skill}" — either the character already holds it or ` +
       'PlayerCanLearn says it has not been earned yet. Neither is an error; do not retry.'),
    // BUY IT, THEN PROVE IT. The ability list is the only evidence there is, and it must be
    // polled: the list lags the counter, so asking once races it. A "no" that survives the
    // poll means the purse moved and the skill did not.
    verify(async ({ agent, call, state }) => {
      if (!state.skillRow) return false;
      await call('shop', { agent, seller: teacher,
                           buy_ids: [{ id: state.skillRow.id, amount: 1 }] }, 600_000)
        .catch(() => null);
      for (let i = 0; i < polls; i++) {
        await new Promise(r => setTimeout(r, pollEvery));
        const a = await call('abilities', { agent, kind: 'skills', refresh: i > 0 }, 60_000)
                          .catch(() => null);
        if ((a?.skills || []).some(s => rx.test(String(s.name || '')))) return true;
      }
      return false;
    }, `the purse was charged for "${skill}" and it never appeared in the skill list — ` +
       'do NOT retry in a loop, each attempt costs the price again'),
    // ALWAYS, so a character that failed to learn is still brought home rather than left
    // standing at a merchant on the far side of the world.
    { ...walk(home), always: true },
  ];
}

const trip = (over = {}) => ({
  name: 'learn-skill-test', fleet: 'learnskilltest', agents: ['a1'],
  pollMs: 20, healMs: 200, packSettleMs: 200, budgetFloorMs: 400, budgetCapMs: 800,
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
    const inv = { a1: [{ name: 'shilling', amount: 900 }] };
    const sent = fakeWorld({ rooms: { a1: 39 }, inventory: inv, learnedAfterPolls: Infinity });
    const r = await fleetScript(trip({ steps: learnSkillSteps({
      skill: 'punch', teacherRoom: 106, teacher: 'Rook', price: 500, carrying: 900, home: 39,
      polls: 3 }) }));
    ok('the errand fails even though the counter said nothing was wrong',
       r.results.a1.ok === false);
    ok('and it says the purse moved and the skill did not',
       /never appeared in the skill list/.test(r.results.a1.why ?? ''), r.results.a1.why);
    ok('the purse is down by the price, which is the evidence that matters',
       inv.a1[0].amount === 400, String(inv.a1[0].amount));
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

  // WHY THIS IS ASSERTED RATHER THAN LEFT TO THE READER. It is the finding that made this
  // file worth writing, and without a test it is a paragraph somebody deletes.
  console.log('\nand the reason this errand cannot be spelled with `shop`');
  {
    const sent = fakeWorld({ rooms: { a1: 39 }, inventory: { a1: [{ name: 'shilling', amount: 900 }] } });
    const r = await fleetScript(trip({ steps: [
      walk(106),
      shop('Rook', [{ match: skillRx('punch'), amount: 1 }]),
      verify(async () => true, 'unreachable'),
      walk(39),
    ] }));
    ok('`shop` judges on the pack, so a skill purchase reads as a failure',
       r.results.a1.ok === false && /nothing entered the pack/.test(r.results.a1.why ?? ''),
       r.results.a1.why);
    ok('and the verify that was the whole point never runs',
       !sent.some(s => s.name === 'abilities'));
    ok('nor does the walk home — the character is left standing at the teacher',
       sent.filter(s => s.name === 'travel').map(s => s.to).at(-1) === 106);
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
    }
  }

  rmSync(LOCK_DIR, { recursive: true, force: true });
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
