#!/usr/bin/env node
// THE FIGHT-BACK EDICT. Offline, no server, safe any time:
//
//   node tools/m59-fightback-test.mjs
//
// "If dithering and being attacked for more than ten seconds, fight back if it is smaller
// than you." An operator's order, 2026-08-27, given after watching six characters stand in
// one corner of the Valley of Ileria being chewed on while their keepers were each inside a
// walk they could not finish. The branch that hits back already existed in passFarm; it was
// never reached because the pass never ended.
//
// Two halves on two clocks, and this pins both against a hand-built keeper:
//
//   * `fightBackCheck` — the WATCHDOG half. Keeps an attack episode (health going down with
//     something attackable in reach), and when it is older than the edict pulls the handbrake
//     once per pass and asks for a fight. It decides nothing else: off by default, silent
//     below the flee line, silent while already fighting, silent under an errand.
//   * `passFightBack` — the PASS half. Answers with the nearest thing in reach that the
//     fleet's engagement band would let this character fight, before any wall, pull or walk;
//     steps aside below the flee line so the survival ladder is next; refuses what the band
//     refuses, and leaves that to the ladder too.
//
// Drives the REAL prototype methods with a fake `this`, the way m59-passorder-test does.
import './m59-test-ledger.mjs';        // FIRST — the ledger goes to a scratch file
import { Autopilot, PASS_STAGES, HANDLED, CONTINUE } from './m59-autopilot.mjs';
import { OF } from './m59-parse.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const MONSTER = OF.ATTACKABLE;                      // attackable, not a player
const T0 = 1_000_000;

// A keeper with exactly the surface the two methods read. Everything is overridable per
// case, and every note and cancel is recorded rather than printed.
function keeper({ policy = {}, inReach = [], refused = () => null, fleeAt = 0.4,
                  doing = 'travelling', inert = null, hold = null, armed = true,
                  passStartedAt = null, fight = null } = {}) {
  const k = Object.create(Autopilot.prototype);
  Object.assign(k, {
    // `tally.kills` starts at 0 in the real constructor; passFarm and this stage both `++` it.
    policy: { ...policy }, watch: { lastHealth: null }, tally: { kills: 0 }, notes: [], cancels: [],
    progressed: [], ledger: [], fought: [], killTimes: [], fledInARow: 3,
    doing, inert, hold, passes: 7, passStartedAt, fightBackDue: null,
    s: { name: 't1', live: true, client: null,
         cancelMovement: (g, why) => { k.cancels.push(why); return { interrupted: true }; } },
    inReachOfUs: () => inReach,
    refuseEngagement: (name) => refused(name),
    safety: () => ({ fleeAt, engageAt: 0.75 }),
    note: (what, d) => k.notes.push({ what, ...d }),
    progress: (m) => k.progressed.push(m), noProgress: (m) => k.progressed.push('! ' + m),
    ledgerEvent: (kind, d) => k.ledger.push({ kind, ...d }),
    countLoot: () => {}, who: () => 'Lew', weaponPriorityNow: () => null,
    fightNow: async (opts) => {
      k.fought.push(opts);
      return fight ? fight(opts) : { fought: true, killed: false, rounds: 3, landed_hits: 0 };
    },
  });
  const rsc = new Map(inReach.map(o => [o.nameRsc, o.name]));
  // `skills.isArmed` reads the client's own equipment list: an unknown list counts as armed
  // (the server has not said), a known empty one does not.
  k.s.client = { self: { col: 10, row: 10 }, rsc,
                 room: { objects: new Map(inReach.map(o => [o.id, o])) },
                 equipment: () => armed ? { known: false } : { known: true, equipped: [] },
                 vitals: () => ({}) };
  return k;
}
const creature = (id, name, col, row) => ({ id, name, nameRsc: 'rsc' + id, col, row, flags: MONSTER });
const hp = (value, max = 40) => ({ value, max });
const tick = (k, health, now, lost) => k.fightBackCheck(k.watch, hp(health), now, lost);
// One blow a second for `seconds` seconds, the first landing at t0 + 1s, health falling by
// one each time. The episode's clock starts at the FIRST BLOW, so after this the episode is
// (seconds - 1) seconds old.
const chewOn = (k, t0, seconds, from = 40) => {
  let out = null;
  for (let i = 0; i <= seconds; i++) out = tick(k, from - i, t0 + i * 1000, i ? 1 : 0);
  return out;
};
// For the pass half, which reads the real clock: an episode that started `seconds` ago.
const beaten = (k, seconds) => {
  const now = Date.now();
  k.watch.attack = { since: now - seconds * 1000, hits: seconds, lost: seconds, lastHitAt: now };
  k.fightBackDue = null;
};
const ctxFor = (k, health = 0.9) => ({ s: k.s, c: k.s.client, room: { name: 'Valley of Ileria', num: 544 },
                                       v: { health: hp(Math.round(health * 40)) }, hp: health });

console.log('\nwhere it sits');
{
  ok('it is a stage, directly above the survival ladder',
     PASS_STAGES.indexOf('passFightBack') === PASS_STAGES.indexOf('passFleeAndRest') - 1);
  ok('and below arming and the playbook',
     PASS_STAGES.indexOf('passFightBack') > PASS_STAGES.indexOf('passArm') &&
     PASS_STAGES.indexOf('passFightBack') > PASS_STAGES.indexOf('passPlaybook'));
}

console.log('\nthe watchdog half: counting, and deciding nothing');
{
  const larva = creature(1, 'groundworm larva', 11, 10);
  // OFF BY DEFAULT.
  const off = keeper({ inReach: [larva] });
  ok('with no edict the clock still runs but nothing is asked for',
     chewOn(off, T0, 15) === null && off.watch.attack?.hits === 15 && !off.fightBackDue && off.cancels.length === 0);
  ok('and the edict reads as off', off.fightBackAfterMs() === 0);

  // A BLOW IS HEALTH GOING DOWN WITH SOMETHING IN REACH.
  const alone = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [] });
  ok('losing health with nothing in reach starts no episode — a ledge is not an attacker',
     chewOn(alone, T0, 15) === null && alone.watch.attack == null);

  // TEN SECONDS, NOT NINE. Ten blows: the first at +1s, the tenth at +10s — nine seconds old.
  const k = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [larva], passStartedAt: T0 - 5000 });
  ok('nine seconds of being hit asks for nothing', chewOn(k, T0, 10) === null && !k.fightBackDue);
  const due = tick(k, 29, T0 + 11_000, 1);
  ok('the tenth second asks for a fight', !!due && k.fightBackDue === due && due.hits === 11 && due.lost === 11,
     JSON.stringify(due));
  ok('and pulls the handbrake, because the pass is inside an await',
     k.cancels.length === 1 && /fight-back edict/.test(k.cancels[0]));
  ok('once per pass', tick(k, 28, T0 + 12_000, 1) === null && k.cancels.length === 1);
  ok('counted', k.tally.fight_back_interrupts === 1);
  ok('and said out loud, with the numbers',
     k.notes.some(n => /under attack for 10s/.test(n.what) && n.hits_taken === 11));

  // A QUIET SPELL ENDS THE EPISODE.
  const q = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [larva] });
  chewOn(q, T0, 5);
  tick(q, 35, T0 + 12_000, 0);                      // seven seconds of nothing
  ok('seven quiet seconds end the episode', q.watch.attack == null);
  tick(q, 34, T0 + 13_000, 1);
  ok('and the next blow starts a fresh one', q.watch.attack?.since === T0 + 13_000 && q.watch.attack.hits === 1);

  // THE THINGS IT DEFERS TO.
  const low = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [larva], fleeAt: 0.5 });
  ok('below the flee line it asks for nothing — running is the ladder\'s answer',
     chewOn(low, T0, 14, 18) === null && !low.fightBackDue);
  const swinging = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [larva], doing: 'fighting' });
  ok('already fighting is not dithering', chewOn(swinging, T0, 15) === null);
  const errand = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [larva], inert: { why: 'errand' } });
  ok('under an errand it stays silent — the inert rescue owns that case', chewOn(errand, T0, 15) === null);
  const quick = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [larva], passStartedAt: null });
  chewOn(quick, T0, 13);
  ok('with no pass in flight there is nothing to cancel, and it does not', !!quick.fightBackDue && quick.cancels.length === 0);
}

console.log('\nthe watchdog half: no cancel for a fight the pass would refuse');
{
  // Beaker, Bunsen and Robin (Qor, karma_strict), orc caves 2501, 2026-10-27: orc wizards (karma -60) hit them mid-walk,
  // the edict cancelled the walk "so the next pass can fight back", the pass refused every one, and the ladder sheltered
  // them in 2508. Five lost crossings of 2501 -> 2502 for fights that were never going to happen.
  const wizard = creature(2, 'orc wizard', 11, 10);
  const karma = () => ({ why: 'karma_strict: killing a orc wizard moves a evil character\'s karma the wrong way' });
  const k = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [wizard], refused: karma, passStartedAt: T0 - 5000 });
  chewOn(k, T0, 10);
  ok('every attacker refused: nothing is asked for', tick(k, 29, T0 + 11_000, 1) === null && !k.fightBackDue);
  ok('and the walk is NOT cancelled', k.cancels.length === 0, JSON.stringify(k.cancels));
  ok('said once, with what is hitting us and why',
     k.notes.filter(n => /nothing we would fight: the walk goes on/.test(n.what)).length === 1 &&
     k.notes.some(n => n.in_reach?.includes('orc wizard') && /karma_strict/.test(n.why)));
  tick(k, 28, T0 + 12_000, 1);
  ok('not repeated every tick of the same episode',
     k.notes.filter(n => /nothing we would fight/.test(n.what)).length === 1);

  // ONE FIGHTABLE ATTACKER IS ENOUGH: then the edict is what it always was.
  const larva = creature(3, 'groundworm larva', 12, 10);
  const mixed = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [wizard, larva], passStartedAt: T0 - 5000,
                         refused: name => (name === 'orc wizard' ? karma() : null) });
  chewOn(mixed, T0, 10);
  ok('a refused wizard beside a fightable larva still asks for the fight', !!tick(mixed, 29, T0 + 11_000, 1));
  ok('and still pulls the handbrake', mixed.cancels.length === 1);
}

console.log('\nthe pass half: the answer');
{
  const larva = creature(1, 'groundworm larva', 11, 10);
  const beast = creature(2, 'fungus beast', 12, 12);
  const troll = creature(3, 'troll', 11, 11);

  // THE ORDINARY CASE: one thing inside the band has been on us for twelve seconds.
  const k = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [beast, larva],
                     fight: () => ({ fought: true, killed: true, target: 'groundworm larva', rounds: 2, looted: [] }) });
  beaten(k, 12);
  const r = await k.passFightBack(ctxFor(k));
  ok('it answers, and the tick is over', r === HANDLED);
  ok('at the NEAREST thing in reach, by id',
     k.fought.length === 1 && k.fought[0].preferId === 1 && k.fought[0].target === 'groundworm larva');
  ok('not holding a wall, so it may step to it', k.fought[0]?.holdPosition === false);
  ok('disengaging at the flee line, not some other number', k.fought[0]?.disengageAt === 0.4);
  ok('the kill is bookkept exactly as passFarm\'s is',
     k.tally.kills === 1 && k.ledger.some(e => e.kind === 'killed' && e.fought_back === true) && k.fledInARow === 0);
  ok('the fight-back itself is on the ledger', k.ledger.some(e => e.kind === 'fought_back' && e.under_attack_s === 12));
  ok('the clock restarts', k.watch.attack == null && k.fightBackDue == null);
  ok('and the tally says so', k.tally.fight_backs === 1);

  // FROM A WALL, IT SWINGS WITHOUT STEPPING OFF.
  const walled = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [larva], hold: { col: 10, row: 10 } });
  beaten(walled, 11);
  await walled.passFightBack(ctxFor(walled));
  ok('holding a spot, it fights in place', walled.fought[0]?.holdPosition === true);

  // THE BAND. "Smaller than you" is refuseEngagement, not the level.
  const banded = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [troll, beast],
                          refused: n => n === 'troll' ? { name: n, level: 70, rating: 750, why: 'above the band' } : null });
  beaten(banded, 11);
  const r2 = await banded.passFightBack(ctxFor(banded));
  ok('the nearer thing is refused, so the next one in reach that is inside the band is the target',
     r2 === HANDLED && banded.fought[0]?.target === 'fungus beast');
  const onlyTroll = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [troll],
                             refused: () => ({ name: 'troll', level: 70, rating: 750, why: 'above the band' }) });
  beaten(onlyTroll, 11);
  const r3 = await onlyTroll.passFightBack(ctxFor(onlyTroll));
  ok('nothing inside the band means no swing and the ladder decides — it walks away from what it will not fight',
     r3 === CONTINUE && onlyTroll.fought.length === 0 &&
     onlyTroll.notes.some(n => /nothing on us is inside the band/.test(n.what)));

  // WHAT IT DEFERS TO.
  const hurt = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [larva] });
  beaten(hurt, 11);
  ok('below the flee line it steps aside for the survival ladder',
     await hurt.passFightBack(ctxFor(hurt, 0.3)) === CONTINUE && hurt.fought.length === 0);
  const off = keeper({ inReach: [larva] });
  beaten(off, 20);
  ok('with the edict off it never answers, however long the beating', await off.passFightBack(ctxFor(off)) === CONTINUE);
  const notDue = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [larva] });
  beaten(notDue, 4);
  ok('four seconds is not ten', await notDue.passFightBack(ctxFor(notDue)) === CONTINUE && notDue.fought.length === 0);
  const unarmed = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [larva], armed: false });
  beaten(unarmed, 11);
  ok('unarmed it steps aside — that is passArm\'s problem', await unarmed.passFightBack(ctxFor(unarmed)) === CONTINUE);
  const busy = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [larva], inert: { why: 'errand' } });
  beaten(busy, 11);
  ok('under an errand it steps aside', await busy.passFightBack(ctxFor(busy)) === CONTINUE);
  const gone = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [larva] });
  beaten(gone, 11);
  gone.inReachOfUs = () => [];
  ok('if whatever it was has left, there is nothing to answer and the clock is cleared',
     await gone.passFightBack(ctxFor(gone)) === CONTINUE && gone.watch.attack == null);
  const stale = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [larva] });
  stale.fightBackDue = { since: Date.now() - 90_000, hits: 12, lost: 12, at: Date.now() - 60_000 };
  ok('a request a minute old is a memory, not an order',
     await stale.passFightBack(ctxFor(stale)) === CONTINUE && stale.fought.length === 0);

  // A FIGHT THAT LANDS NOTHING IS SAID SO, AND THE CLOCK STILL RESTARTS.
  const miss = keeper({ policy: { fightBackAfterMs: 10_000 }, inReach: [larva] });
  beaten(miss, 11);
  await miss.passFightBack(ctxFor(miss));
  ok('three rounds of missing is reported as no progress, not hidden',
     miss.progressed.some(m => /without landing a hit/.test(m)) && miss.tally.kills === 0
     && miss.watch.attack == null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
