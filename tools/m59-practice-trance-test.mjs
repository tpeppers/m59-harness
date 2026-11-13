#!/usr/bin/env node
// THE PRACTICE DRILL KNOWS WHAT EACH CAST CAME TO -- offline, no socket, no roster.
//
//   node tools/m59-practice-trance-test.mjs
//
// Operator, 2026-10-30: "It feels like the training script Zoot used didn't wait for concentration before casting,
// causing him to waste the >100 edible mushrooms he was carrying to practice haste". It had not: the 25 full-price haste
// casts all completed (resist poison, same 2 s trance, same drill: 11 of 11 full-price casts applied the buff 2.77 s
// later; the 9 half-price casts were failed rolls). But the drill could not have SAID either way -- it handed the pass
// back on the first message and recorded every cast that spent mana as worked, "43 cast, 100% worked". What this pins:
//   * practiceOutcome: nothing spent is refused, half price is a failed roll, a broken trance is broken whatever it cost,
//     full price with no break is completed, an unread mana is unknown (null) and not refused;
//   * the drill STAYS for a trance (the hold, or the trance's own clock) before it reads how it ended, and does not
//     wait for a failed roll or a spell with no trance;
//   * a broken trance is recorded as broken, not worked, sets the spell aside at least ten minutes and says so;
//   * a failed roll is recorded as not worked and sets NOTHING aside -- it is the dice, not a fault.
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};
const T = await import('./m59-trance.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');
const { PRACTICE_BROKEN_ASIDE_MS } = await import('./autopilot/desk-practice.mjs');

console.log('what a cast came to');
{
  const o = (spent, ended = null, name = 'resist poison') => T.practiceOutcome({ name, spent, ended });
  ok('nothing spent: refused', o(0) === 'refused');
  ok('half price (5 of 10): a failed roll', o(5) === 'failed roll');
  ok('a point lost to regeneration is still a failed roll (4) / still full (9)', o(4) === 'failed roll' && o(9) === 'completed');
  ok('full price, no break: completed', o(10) === 'completed');
  ok('full price and "concentration broken": broken', o(10, 'concentration broken') === 'broken');
  ok('an explicit break reads as broken too', o(10, 'broken: a cast that chose to replace it') === 'broken');
  ok('"no trance started" does not overrule a full price', o(10, 'no trance started') === 'completed');
  ok('mana not read: unknown, not refused', o(null) === null);
  ok('a spell with no trance at full price: completed (bless, 6)', o(6, null, 'bless') === 'completed');
  ok('haste is a 2 s trance, worst case 2.98 s', T.tranceMs('haste') === 2980 && T.tranceMs('bless') === 0);
}

// 2026-11-13: Pepe, a Princess soldier with remove curse ~81, logged 40 of 41 remove curse casts as failed rolls at about
// 4 mana each against a catalogue 9. GetManaCost (spell.kod:1544) takes 2 off for spellpower over 80 and the shield
// 5-25% more, so a completed cast costs 5 or 6 -- under the old flat 0.75 x 9 line.
console.log('a discounted cast is still a cast');
{
  const rc = (spent, x = {}) => T.practiceOutcome({ name: 'remove curse', spent, ...x });
  ok('GetManaCost: 9 at spellpower 85 is 7; the rank-10 shield makes it 5, rank-1 makes it 6',
     T.manaCostAt(9, { spellpower: 85 }) === 7 && T.manaCostAt(9, { spellpower: 85, reductionPct: 25 }) === 5
     && T.manaCostAt(9, { spellpower: 85, reductionPct: T.princessReductionPct(1) }) === 6);
  ok('the shield table: rank 1 is 5%, rank 10 is 25% (prinshld.kod)', T.princessReductionPct(1) === 5 && T.princessReductionPct(10) === 25);
  ok('never below 1 (bound(iCost,1,$))', T.manaCostAt(1, { spellpower: 99, reductionPct: 25 }) === 1);
  ok('a completed remove curse at 5 for a Princess soldier is completed, not a failed roll',
     rc(5, { princess: true }) === 'completed' && rc(5, { princess: true, spellpower: 85, princessRank: 10 }) === 'completed');
  ok('...and at 6 with no shield read (two-point spellpower discount, a point to regeneration)', rc(6) === 'completed');
  ok('a half-price failed roll with the shield known exactly is still a failed roll (2 of 5)',
     rc(2, { princess: true, spellpower: 85, princessRank: 10 }) === 'failed roll');
  ok('a price both readings explain is unknown, not a guess (4 for a soldier of unknown rank)', rc(4, { princess: true }) === null);
  ok('the reagents decide it: an emerald gone is completed even at 4 mana', rc(4, { princess: true, reagentsPaid: true }) === 'completed'
     && rc(3, { reagentsPaid: true }) === 'completed');
  ok('mana spent and the reagents NOT taken is a failed roll, even at full price', rc(9, { reagentsPaid: false }) === 'failed roll');
  ok('"You were unsuccessful in casting" is a failed roll whatever the price read',
     rc(5, { said: ['You were unsuccessful in casting remove curse.'] }) === 'failed roll'
     && rc(null, { said: 'You were unsuccessful in casting remove curse.' }) === 'failed roll');
  ok('"concentration is broken" in what was said is broken, and beats paid reagents',
     T.practiceOutcome({ name: 'haste', spent: 10, reagentsPaid: true,
                         said: ['Your concentration is broken and the haste spell fizzles.'] }) === 'broken');
  ok('nothing spent and nothing said is still refused; nothing read is still unknown', rc(0) === 'refused' && rc(null) === null);
}

// The keeper stub of m59-deskpractice-test.mjs, with a pacer that can hold, end or break a trance.
const { spellCost } = await import('./m59-deskpractice.mjs');
const makeAp = ({ spell = 'resist poison', mana = 28, roll = 'full', breakAfterMs = null, holdMs = null,
                 spend = null, takeReagents = false, say = null, wire = false } = {}) => {
  const names = new Map();
  const pack = { herb: 20, 'red mushroom': 20, mushroom: 20, sapphire: 20 };
  const inv = Object.entries(pack).map(([n, amount], i) => { names.set(2000 + i, n); return { id: 500 + i, nameRsc: 2000 + i, amount }; });
  const known = ['resist poison', 'bless'];
  const spells = known.map((n, i) => { names.set(3000 + i, n); return { id: 700 + i, nameRsc: 3000 + i, numTargets: 1 }; });
  const pacer = { holdUntil: 0, lastTranceEnd: null,
    holdStatus: () => ({ active: Date.now() < pacer.holdUntil, dropped: { rest: 1 } }),
    submit: async (_k, fn) => fn() };
  const client = {
    selfId: 1, me: { name: 'Zoot' }, inventory: inv, spells, rsc: { get: r => names.get(r) ?? '' },
    room: { num: 53, objects: new Map() }, sent: [], mana,
    vitals: () => ({ health: { value: 100, max: 100 }, mana: { value: client.mana, max: 28 }, vigor: { value: 100, max: 200 } }),
    cast: async (id) => {
      const name = names.get(spells.find(s => s.id === id).nameRsc);
      client.sent.push({ name, at: Date.now() });
      const full = T.spellInfo(name).mana;
      if (spend != null) client.mana -= spend;
      else if (roll === 'full') client.mana -= full; else if (roll === 'half') client.mana -= full / 2;
      // A real client's event stream and pack, for the cases that read what the server said and what left the pack.
      if (takeReagents) for (const [item, k] of spellCost(name).reagents) {
        const o = inv.find(x => names.get(x.nameRsc) === item);
        if (o) o.amount -= k;
      }
      if (wire) client.events.push({ seq: ++client.evSeq, kind: 'stat' });
      if (wire && say) client.events.push({ seq: ++client.evSeq, kind: 'message', text: say });
      if (roll === 'full' && T.tranceMs(name)) {
        pacer.holdUntil = Date.now() + (holdMs ?? T.tranceMs(name) + 750);
        if (breakAfterMs != null) setTimeout(() => {
          pacer.lastTranceEnd = { spell: name, why: 'concentration broken', at: Date.now() }; pacer.holdUntil = 0;
        }, breakAfterMs);
      }
      return true;
    },
    waitFor: async () => ({ events: [] }),
    ...(wire ? { evSeq: 0, events: [], eventsSince(since) { return this.events.filter(e => e.seq > since); } } : {}),
  };
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { practiceSpells: { spells: [spell], reserve_casts: 0, mana_floor: 0, refused_ms: 60_000 }, assignedRoom: 53 };
  ap._chaliceCfg = null;
  ap.hold = null;
  ap.tally = {};
  ap.declined = []; ap.casts = []; ap.notes = [];
  ap.s = { client, need: () => client, world: { room: { num: 53 } }, pacer };
  ap.threat = () => ({ landing: 0 });
  ap.busyStatus = () => null;
  ap.travelInterrupted = () => false;
  ap.declinedCast = (what, why, detail) => { ap.declined.push({ what, why, detail }); return false; };
  ap.recordCast = (sp, d) => { ap.casts.push({ spell: sp, ...d }); };
  ap.note = (what, detail) => { ap.notes.push({ what, detail }); };
  return ap;
};

console.log('\na completed trance');
{
  const ap = makeAp();
  const t0 = Date.now();
  ok('it casts', await ap.practiceAtDesk() === true, JSON.stringify({ declined: ap.declined, state: ap.practiceState }));
  const took = Date.now() - t0;
  ok('and stays for the trance before handing the pass back (>= 2.98 s)', took >= 2980, `${took} ms`);
  ok('but not past the hold by much (< 5 s)', took < 5000, `${took} ms`);
  ok('recorded completed and worked', ap.casts[0]?.outcome === 'completed' && ap.casts[0]?.ok === true, JSON.stringify(ap.casts[0]));
  ok('counted in practice_completed', ap.tally.practice_completed === 1);
  ok('nothing set aside', !(ap._practiceRefused.get('resist poison') > Date.now()));
}

console.log('\na broken trance');
{
  const ap = makeAp({ breakAfterMs: 400 });
  const t0 = Date.now();
  await ap.practiceAtDesk();
  const took = Date.now() - t0;
  ok('it stops waiting when the trance breaks', took < 2000, `${took} ms`);
  ok('recorded broken, NOT worked', ap.casts[0]?.outcome === 'broken' && ap.casts[0]?.ok === false, JSON.stringify(ap.casts[0]));
  ok('the why says so', /trance was broken/.test(ap.casts[0]?.why ?? ''));
  const until = ap._practiceRefused.get('resist poison') ?? 0;
  ok('the spell is set aside at least ten minutes', until - Date.now() > PRACTICE_BROKEN_ASIDE_MS - 5000, `${Math.round((until - Date.now()) / 1000)} s`);
  ok('a note names it, with what the hold dropped', ap.notes.some(n => n.what === 'practice trance broken' && n.detail?.dropped_during_hold));
  ok('counted in practice_trances_broken', ap.tally.practice_trances_broken === 1);
  ap._practiceAt = 0;
  const sent = ap.s.client.sent.length;
  await ap.practiceAtDesk();
  ok('the next pass does not pay again', ap.s.client.sent.length === sent);
}

console.log('\na failed roll');
{
  const ap = makeAp({ roll: 'half' });
  const t0 = Date.now();
  await ap.practiceAtDesk();
  ok('no trance to wait for (< 1 s)', Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
  ok('recorded failed roll, not worked', ap.casts[0]?.outcome === 'failed roll' && ap.casts[0]?.ok === false, JSON.stringify(ap.casts[0]));
  ok('and nothing set aside: it is the dice', !(ap._practiceRefused.get('resist poison') > Date.now()));
  ok('counted in practice_failed_rolls', ap.tally.practice_failed_rolls === 1);
}

console.log('\nno trance, and no hold');
{
  const ap = makeAp({ spell: 'bless' });
  const t0 = Date.now();
  await ap.practiceAtDesk();
  ok('bless has no trance: no wait', Date.now() - t0 < 1000 && ap.casts[0]?.outcome === 'completed', JSON.stringify(ap.casts[0]));
  const nohold = makeAp({ holdMs: 0 });
  const t1 = Date.now();
  await nohold.practiceAtDesk();
  ok('with no hold open it still waits out the trance by its clock', Date.now() - t1 >= 2980, `${Date.now() - t1} ms`);
}

// The drill reads the server's words and the pack, not only the price (Pepe, 2026-11-13).
console.log('\nthe drill asks the server and the pack before the price');
{
  const cheap = makeAp({ spell: 'bless', spend: 2, takeReagents: true, wire: true });
  await cheap.practiceAtDesk();
  ok('a bless that cost 2 of 6 but took its mushrooms and sapphires is completed and worked',
     cheap.casts[0]?.outcome === 'completed' && cheap.casts[0]?.ok === true, JSON.stringify(cheap.casts[0]));
  const unlucky = makeAp({ spell: 'bless', spend: 3, wire: true, say: 'You were unsuccessful in casting bless.' });
  await unlucky.practiceAtDesk();
  ok('half price with "You were unsuccessful in casting" is a failed roll, not worked, nothing set aside',
     unlucky.casts[0]?.outcome === 'failed roll' && unlucky.casts[0]?.ok === false
     && !(unlucky._practiceRefused.get('bless') > Date.now()), JSON.stringify(unlucky.casts[0]));
  const said = makeAp({ spell: 'bless', spend: 6, wire: true, say: 'You were unsuccessful in casting bless.' });
  await said.practiceAtDesk();
  ok('the sentence beats the price: full mana and "unsuccessful" is a failed roll', said.casts[0]?.outcome === 'failed roll');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
