#!/usr/bin/env node
// THE TRAVEL A/B — the randomisation and the arithmetic. Offline, safe any time:
//
//   node tools/m59-travel-ab-test.mjs
//
// This experiment runs on twenty-one live characters and its outcome is DEATHS, so the two
// things that can quietly ruin it are pinned here.
//
//   * A BIASED SPLIT. If the arm correlates with the character — or with the time of day,
//     or with which character travels most — the result is a fact about the fleet rather
//     than about the intervention, and it will look exactly like a real effect.
//   * ARITHMETIC THAT CLAIMS TOO MUCH. Rare events make it very easy to read noise as a
//     finding. A two-hour run with one death in each arm must say "not yet", and the
//     "how much longer" answer has to be right or somebody stops the experiment early.
//
// The outcome metric is deliberately NOT damage taken. The hypothesis players state is
// that fighting from a wall means you take MORE damage and die LESS — so a measurement
// built on damage would reject the intervention precisely when it is working.

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { twoProportion, eventsNeeded, isTravelTrip } from './m59-travel-ab.mjs';
import { Autopilot } from './m59-autopilot.mjs';
import { OF } from './m59-parse.mjs';
import * as party from './m59-party.mjs';

const AUTOPILOT_SRC = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
// A NAME THE PARTY ROSTER ACTUALLY KNOWS. `party.isFleetmate` reads the live roster, and a
// keeper that has not had a pass yet is absent from it — so the fixture registers one
// rather than asserting against whatever happens to be in memory.
const FLEETMATE = 'AbsolutelyOurs';
party.setRosterSource(() => new Set([FLEETMATE]));

// AN OFFLINE TEST MUST NOT READ THIS MACHINE'S ORDERS, AND THIS ONE DID.
//
// `travelHoldCandidate` refuses a hold while the FLEET-WIDE grudge book has a live entry —
// somebody who attacked one of ours within the hour. That book is a real, gitignored file
// belonging to whichever fleet is playing, and this suite was reading it.
//
// So seven assertions here passed or failed on whether a stranger had hit one of our
// characters in the preceding sixty minutes. It read 85/0 for weeks because the book was
// empty, then 78/7 the afternoon a player called Chris Farley hit five of ours ten times —
// and the failures pointed at vigor, which had nothing to do with it. A day was nearly
// spent bisecting a code change that had never been wrong.
//
// The rule this belongs to is already written down for loadouts and tuning: an instruction
// that arrives from somebody else's afternoon is obeyed silently. A TEST that reads one is
// the same bug wearing a lab coat — it reports on the machine instead of on the repository.
//
// `GRUDGE_FILE()` is evaluated per call, so pointing it at a path that does not exist is
// enough, and it has to happen before the first `travelHoldCandidate`. Same pattern
// m59-collision-trace-test.mjs uses for the trace file.
process.env.M59_GRUDGE_FILE =
  join(tmpdir(), `m59-travel-ab-test-no-grudges-${process.pid}.json`);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const armOf = (seed) => Autopilot.prototype.travelArmFor.call(null, seed);

console.log('what counts as a journey');
{
  ok('one room boundary is zoning, not a trip', !isTravelTrip({ legs: 1 }));
  ok('zero room changes are not a trip either', !isTravelTrip({ legs: 0 }));
  ok('two or more room changes are a trip', isTravelTrip({ legs: 2 }));
  ok('legacy rows with no leg count are retained rather than guessed away', isTravelTrip({}));
}

console.log('\nthe split');
{
  let hold = 0;
  const N = 200000;
  for (let i = 0; i < N; i++) if (armOf(`t${i % 21}-${i}-${1786000000000 + i * 137}`) === 'hold') hold++;
  const share = hold / N;
  // At n=200,000 the standard error is 0.11%, so a fair coin lands inside 0.5% almost
  // always and a tighter bound would fail on noise a few runs in a row. The imbalance that
  // would actually matter to a rare-event experiment is percent-scale, not this.
  ok('it is a coin, within half a percent', Math.abs(share - 0.5) < 0.005,
     `got ${(share * 100).toFixed(2)}%`);

  // THE BUG THIS CAUGHT. FNV-1a's last step multiplies by an odd constant, so its low bit
  // is (running hash) XOR (last character) and nothing else in the seed reaches it. Seeds
  // differing only in their final character alternated arms exactly.
  const tails = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(t => armOf('same-prefix-' + t));
  ok('THE ARM IS NOT DECIDED BY THE LAST CHARACTER — with the old hash these alternated ' +
     'in lockstep with its parity, which meant the experiment was randomising on one bit ' +
     'of the clock and the character was contributing nothing',
     !tails.every((a, i) => (a === 'hold') === (i % 2 === 1)));

  // THE ONE THAT MATTERS. A split that is 50/50 overall can still put one character almost
  // entirely in one arm, and the characters differ by max health, hunting ground and
  // strategy — so that would be a fact about Kermit, not about holding at walls.
  let worst = 0, worstWho = null;
  for (const who of ['Kermit', 'Piggy', 'Lew', 'Gonzo', 'Sweetums', 'Rizzo', 'Camilla']) {
    let h = 0;
    for (let i = 0; i < 20000; i++) if (armOf(`${who}-${i}-${1786000000000 + i * 911}`) === 'hold') h++;
    const d = Math.abs(h / 20000 - 0.5);
    if (d > worst) { worst = d; worstWho = who; }
  }
  ok('NO CHARACTER SITS IN ONE ARM — every one of them is within 2% of even, so the ' +
     'comparison is within-character and the differences between them cancel',
     worst < 0.02, `worst was ${worstWho} at ${(worst * 100).toFixed(1)}% off`);

  ok('it is stable — asking twice gives the same answer, so a decision re-evaluated ' +
     'mid-journey cannot flip arms', armOf('Kermit-7-1786000000000') === armOf('Kermit-7-1786000000000'));
  ok('and it is not stable across journeys, which is the point',
     new Set(Array.from({ length: 40 }, (_, i) => armOf(`Kermit-${i}-17860000000${i}`))).size === 2);
}

console.log('\nthe test that decides when to believe it');
{
  ok('no data, no answer', twoProportion(0, 0, 0, 0) === null);
  ok('identical rates are not a finding',
     twoProportion(10, 1000, 10, 1000).p > 0.99);
  // The shape of a real early result: one death each, a couple of thousand journeys.
  const early = twoProportion(1, 2000, 1, 2000);
  ok('ONE DEATH IN EACH ARM IS NOT A RESULT, however tempting the ratio looks',
     early.p > 0.9, `p = ${early?.p?.toFixed(3)}`);
  // And the shape of a real finding: a halving, with enough events behind it.
  const real = twoProportion(40, 20000, 18, 20000);
  ok('a halving on 58 deaths is', real.p < 0.01, `p = ${real?.p?.toFixed(4)}`);
  ok('the sign is right — fewer deaths in the second arm gives a positive z',
     twoProportion(40, 20000, 18, 20000).z > 0);
  ok('a zero-death window does not divide by zero', twoProportion(0, 500, 0, 500) === null);
}

console.log('\nhow much longer to run');
{
  // Standard two-proportion sizing. The absolute values matter less than the shape: a
  // smaller effect must need more events, and every answer must be a usable number.
  const half = eventsNeeded(0.5), quarter = eventsNeeded(0.25), most = eventsNeeded(0.75);
  ok('detecting a halving needs tens of deaths, not hundreds', half > 15 && half < 60, `got ${half}`);
  ok('A SMALLER EFFECT NEEDS MORE EVIDENCE, which is the property that stops this being ' +
     'used to justify stopping early', quarter > half && half > most,
     `${quarter} > ${half} > ${most}`);
  ok('all of them are finite and positive',
     [0.1, 0.25, 0.5, 0.75, 0.9].every(r => Number.isFinite(eventsNeeded(r)) && eventsNeeded(r) > 0));
}

console.log('\nthe gate that decides a candidate moment');
{
  // A stub keeper: travelHoldCandidate reads only vitals, the policy and what is in reach.
  // A ROOM IS PART OF THE STUB NOW, because the gate asks who else is standing here — see
  // the PvP section below. `objects` is the client's own map, keyed by id.
  const keeper = (health, max, vigor, inReach = 0, { policy = {}, players = [] } = {}) => ({
    policy,
    s: { client: {
      selfId: 99,
      vitals: () => ({ health: { value: health, max }, vigor: { value: vigor } }),
      rsc: { get: (r) => players.find(p => p.nameRsc === r)?.name ?? null },
      room: { objects: new Map(players.map(p => [p.id, p])) },
    } },
    inReachOfUs: () => Array.from({ length: inReach }, (_, i) => ({ id: i })),
    travelHoldCandidate: Autopilot.prototype.travelHoldCandidate,
  });
  const ask = (k, remaining = 3) => k.travelHoldCandidate({ remaining });

  ok('hurt, rested, nothing in reach, rooms to go — that is the case this exists for',
     ask(keeper(20, 44, 150)).candidate === true);
  ok('healthy enough is not a candidate', ask(keeper(40, 44, 150)).candidate === false);
  ok('ARRIVING HURT IS FINE — the last room of a journey is somebody else\'s decision',
     ask(keeper(20, 44, 150), 0).candidate === false);
  // VIGOR DOES NOT REFUSE REFUGE. This gate was wrong three times and only the third fix
  // was about the right thing. At 100 it was above anything an unfed fleet can present, so
  // the hold never fired. At 80 it sat on REST_VIGOR_CAP — the most resting can give you —
  // so a character slightly under was refused while vigor drains as it walks; measured, 8 of
  // 18 deaths were characters down to 1 or 2 health refused at 74, 76, 78.
  //
  // The exposure argument for having a floor does not apply to a SAFE SPOT, which is a square
  // a creature cannot path to — that is the whole mechanism. And it was a deadlock besides:
  // resting is how vigor comes back, and the gate on resting was vigor.
  ok('a hurt traveller at the resting cap is offered a wall', ask(keeper(20, 44, 80)).candidate === true);
  ok('and two points under it, which is where they were dying', ask(keeper(20, 44, 78)).candidate === true);
  ok('and at 54, and at 20, and at 1 — none of these is a reason to walk on bleeding',
     [74, 54, 20, 1].every(v => ask(keeper(20, 44, v)).candidate === true));
  ok('vigor 0 is not a refusal either', ask(keeper(20, 44, 0)).candidate === true);
  // THE KNOB SURVIVES for a fleet that would rather press on, and nothing is the default.
  ok('a fleet that sets a floor still gets one',
     ask({ ...keeper(20, 44, 40), policy: { travelHold: 'on', travelHoldBelow: 0.75, travelHoldVigor: 80 } })
       .candidate === false);
  ok('and that refusal names the floor the fleet chose, not a mechanic',
     /floor this fleet set at 80/.test(
       ask({ ...keeper(20, 44, 40), policy: { travelHold: 'on', travelHoldBelow: 0.75, travelHoldVigor: 80 } }).why));
  ok('nearby monsters cannot veto searching for a reachable refuge',
     [1, 2, 5, 6, 14].every(n => ask(keeper(20, 44, 150, n)).candidate === true));
  ok('unreadable health refuses rather than guessing',
     ask({ ...keeper(20, 44, 150), s: { client: { vitals: () => ({}) } } }).candidate === false);
  ok('and every refusal says why, because a gate that silently never fires is an ' +
     'experiment that measures nothing',
     [keeper(40, 44, 150),
      { ...keeper(20, 44, 40), policy: { travelHold: 'on', travelHoldBelow: 0.75, travelHoldVigor: 80 } }]
       .every(k => typeof ask(k).why === 'string' && ask(k).why.length > 0));
}

console.log('\na wall stops monsters, not people');
{
  // WHY THIS OUTRANKS BEING HURT. A safe spot works because a creature cannot path to it;
  // that says nothing whatever about a player, who can walk to the same square, swing
  // first, and take the pack. Standing still for a minute and a half with a full inventory
  // is the best target this game offers, so the trade inverts: dying to the troll while
  // running costs the walk back, dying to the player costs everything carried.
  const stranger = { id: 7, flags: OF.PLAYER, nameRsc: 700, name: 'SomebodyElse' };
  const mate = { id: 8, flags: OF.PLAYER, nameRsc: 800, name: FLEETMATE };
  const keeper = (players, policy = {}) => ({
    policy,
    s: { client: {
      selfId: 99,
      vitals: () => ({ health: { value: 20, max: 44 }, vigor: { value: 150 } }),
      rsc: { get: (r) => players.find(p => p.nameRsc === r)?.name ?? null },
      room: { objects: new Map(players.map(p => [p.id, p])) },
    } },
    inReachOfUs: () => [],
    travelHoldCandidate: Autopilot.prototype.travelHoldCandidate,
  });
  const ask = k => k.travelHoldCandidate({ remaining: 3 });

  ok('a stranger in the room cancels the hold', ask(keeper([stranger])).candidate === false);
  ok('and says so in words a person can grep for',
     /a wall stops\s+monsters, not people|not ours/.test(ask(keeper([stranger])).why));
  ok('an empty room still holds', ask(keeper([])).candidate === true);
  ok('a FLEETMATE is not a threat — twenty-one of our own walk the same road',
     ask(keeper([mate])).candidate === true);
  ok('"ignore" restores the behaviour from before this existed',
     ask(keeper([stranger], { travelHoldPvp: 'ignore' })).candidate === true);
  ok('"room" counts the player standing here', ask(keeper([stranger], { travelHoldPvp: 'room' })).candidate === false);
}

console.log('\n"on" means on, which it did not');
{
  // `travelHold` checks the mode for 'off' and 'observe' and then honours `arm === "walk"`
  // whatever the mode says. So `travel_hold: "on"` was accepted, stored, reported back by
  // `autopilot status`, and left the coin in charge: the shadow fleet ran an evening with
  // it set on all twenty-one characters and the ledger holds THREE hold events for the day,
  // two of them the control arm. `'on'` was not even in the tool's own enum.
  const armFor = (mode) => {
    const holdMode = mode ?? 'ab';
    return holdMode === 'on' ? 'hold' : holdMode === 'off' ? 'walk' : armOf('seed-' + mode);
  };
  ok('"on" always takes the hold arm', armFor('on') === 'hold');
  ok('"off" never does', armFor('off') === 'walk');
  ok('and the experiment still flips for "ab"',
     new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(x => armOf('ab-' + x))).size === 2);
  // THE SOURCE IS THE CONTRACT, and the contract changed: the A/B is retired (2026-08-21)
  // and there is no coin left for a mode to fail to override. What has to stay true is that
  // the arm is derived from the MODE and from nothing else, so the failure this originally
  // caught — a setting that reads `on` while something else decides — cannot come back.
  ok('travel() derives the arm from the mode, with no roll left to leave in charge',
     /const arm = holdMode === 'off' \? 'walk' : TRAVEL_HOLD_ARM;/.test(AUTOPILOT_SRC));
  ok('and the retired coin is not consulted on the live path',
     !/travelArmFor\(`/.test(AUTOPILOT_SRC));
}

console.log('\ndo not set out hurt from a place that is free to heal in');
{
  // AN INN IS THE ONE PLACE HEALING IS FREE. Nothing spawns there and nothing can reach
  // you, so the points that cost eighty-seven exposed seconds at a wall in the Cragged
  // Mountains cost nothing at all here — and it is exactly where a character stands after
  // coming out of the Underworld, which is when something next asks it to cross the world.
  const keeper = ({ health = 20, max = 44, vigor = 40, safe = true, policy = {},
                    inReach = 0 } = {}) => {
    const notes = [];
    return {
      policy, notes,
      settled: 0, restedTo: null,
      s: { world: { room: { num: safe ? 202 : 598, name: safe ? 'The Limping Toad' : 'The Cragged Mountains' } },
           client: { vitals: () => ({ health: { value: health, max },
                                      vigor: { value: vigor, scale_max: 200 } }) } },
      sanctuary: () => safe,
      inReachOfUs: () => Array.from({ length: inReach }, (_, i) => ({ id: i })),
      note: (what, detail) => notes.push({ what, detail }),
      async settle() { this.settled++; },
      // The travelling guard's switch for this faculty. The real method reads `this.inert`
      // and the fixture holds no journey, so the honest stub is the real answer for a
      // character nothing is driving: yes. Given explicitly rather than left to fall off
      // the prototype, so that a fixture missing it fails loudly instead of throwing
      // inside the method under test and reading as a refusal.
      travelAllows: Autopilot.prototype.travelAllows,
      restBeforeSettingOut: Autopilot.prototype.restBeforeSettingOut,
    };
  };

  // `restUntil` is the module's, so the fixture cannot drive it — what is asserted here is
  // the GATE, which is the part that was missing and the part an operator sets.
  const ask = async (k) => {
    const before = k.notes.length;
    let threw = null;
    try { await k.restBeforeSettingOut(); } catch (e) { threw = e; }
    return { note: k.notes[before] ?? null, threw, k };
  };

  const decided = await ask(keeper({ health: 20, max: 44 }));
  ok('hurt, in an inn, nothing in reach — it rests before setting out',
     /resting before setting out/.test(decided.note?.what ?? ''));
  ok('and says vigor stops at the resting cap, because everything above it is eaten',
     /resting cap/.test(JSON.stringify(decided.note?.detail ?? {})));

  const full = await ask(keeper({ health: 44, max: 44, vigor: 80 }));
  ok('already fit — it just goes', full.note === null);

  const outdoors = await ask(keeper({ health: 20, max: 44, safe: false }));
  ok('SOMEWHERE HOSTILE IT DOES NOT SIT DOWN — that is how characters die, and the ' +
     'ordinary survival ladder decides there instead', outdoors.note === null);

  const fighting = await ask(keeper({ health: 20, max: 44, inReach: 2 }));
  ok('something already swinging makes this a fight, not a pause', fighting.note === null);

  const off = await ask(keeper({ health: 20, max: 44, policy: { travelStartHealth: 0 } }));
  ok('travel_start_health 0 switches it off', off.note === null);

  // VIGOR ALONE IS ENOUGH TO JUSTIFY A SIT. A character at full health and 20 vigor heals
  // at a crawl for the rest of the journey, which is the whole reason vigor is in the gate.
  const tired = await ask(keeper({ health: 44, max: 44, vigor: 20 }));
  ok('full health but low vigor still rests, because vigor IS the healing rate',
     /resting before setting out/.test(tired.note?.what ?? ''));

  // The fraction bug that would have made this permanently on: REST_VIGOR_CAP is 0.4, a
  // fraction of 200, and comparing it against a raw vigor value makes every gate pass.
  ok('the vigor comparison is a fraction, not a raw value',
     /vigorPct\(v\)/.test(AUTOPILOT_SRC) &&
     !/vig >= wantVigor[\s\S]{0,40}vigor\?\.value/.test(AUTOPILOT_SRC));
}

console.log('');
console.log('a refusal leaves a trace');
{
  // The gate has six ways to say no and the caller used to throw all six away, so a window
  // with 1,599 journeys and 13 deaths held FOUR hold decisions and could not answer the only
  // question worth asking of it: did the characters that died try to shelter at a wall?
  //
  // These pin which refusals earn a line -- the ones where the character WANTED to stop,
  // hurt and mid-journey, and something else turned it away -- and which must stay silent.
  // A healthy character not stopping is the system working; writing that would put a row on
  // every hop of every journey and drown the rows that matter.
  const events = [];
  const keeper = {
    policy: { travelHold: 'on', travelHoldBelow: 0.75 },
    ledgerEvent: (kind, rec) => events.push({ kind, ...rec }),
    travelHoldCandidate: null,
    inReachOfUs: () => [],
    s: { client: null, world: null },
    book: null,
    note: () => {},
    // travelHold now does two things at a hop boundary — the sanctuary rest first, then
    // the wall hold — and both consult the travelling guard. The real methods are used so
    // this fixture exercises the real ordering; `s.world` is null, so `sanctuary()` reads
    // false and the rest arm returns without touching the ledger, which is what leaves
    // these assertions measuring the wall gate exactly as they did before.
    travelAllows: Autopilot.prototype.travelAllows,
    travelHoldMode: Autopilot.prototype.travelHoldMode,
    travelRestAtSanctuary: Autopilot.prototype.travelRestAtSanctuary,
    sanctuary: Autopilot.prototype.sanctuary,
  };
  const mid = { journey: 'j1', room: { num: 578, name: 'The Cragged Mountains' },
                hops_done: 3, remaining: 4 };
  const run = async (look, at = mid) => {
    events.length = 0;
    keeper.travelHoldCandidate = () => look;
    await Autopilot.prototype.travelHold.call(keeper, at, 'hold');
    return events;
  };

  let e = await run({ candidate: false, why: 'vigor 40 -- too tired for the points to come',
                      frac: 0.4, health: 20, max: 50, vigor: 40 });
  ok('a hurt character refused for vigor is recorded', e.length === 1, JSON.stringify(e));
  ok('and says it never got as far as looking', e[0] && e[0].did === 'did not consider a wall');
  ok('and carries the reason the gate gave, not a summary', !!e[0] && /vigor 40/.test(e[0].why));
  ok('and keeps the vitals that explain it', !!e[0] && e[0].health === 20 && e[0].vigor === 40);

  e = await run({ candidate: false, why: '3 already in reach -- this is a fight, not a pause',
                  frac: 0.3, health: 15, max: 50 });
  ok('refused because something is already swinging is recorded too', e.length === 1);
  ok('with that reason intact', !!e[0] && /in reach/.test(e[0].why));

  e = await run({ candidate: false, why: 'healthy enough (92%)', frac: 0.92, health: 46, max: 50 });
  ok('a healthy character not stopping writes nothing', e.length === 0, JSON.stringify(e));

  e = await run({ candidate: false, why: 'last room of the journey', frac: 0.3, health: 15, max: 50 },
                { ...mid, remaining: 0 });
  ok('arriving hurt at the destination is not a refusal to shelter', e.length === 0);

  e = await run({ candidate: false, why: 'health unreadable' });
  ok('an unreadable vital is not counted as a refusal either', e.length === 0);

  // OFF MEANS OFF, and it must stay ahead of the recording: a fleet that has switched the
  // feature off is not refusing anything and should not be filling a ledger with rows.
  keeper.policy = { travelHold: 'off', travelHoldBelow: 0.75 };
  e = await run({ candidate: false, why: 'vigor 40 -- too tired', frac: 0.4, health: 20, max: 50 });
  ok('with the hold switched off nothing is recorded at all', e.length === 0);
  keeper.policy = { travelHold: 'on', travelHoldBelow: 0.75 };
}

console.log('');
console.log('a wall is nearer than the next room -- the mid-hop rung');
{
  // THE RUNG THAT WAS MISSING. Every other mid-hop rung fires late by construction: the flee
  // line, two hits from death, an emptying bar. That is right when the only choices are run
  // or stand, and wrong when there is a square a creature cannot path to a few steps away.
  // Seven of eleven deaths in one clean window were inside the Cragged Mountains -- 2,450
  // squares -- with no refuge taken there at all, because the refuge question was only ever
  // asked at a hop BOUNDARY and a body never reached one.
  const SRC = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const rung = SRC.indexOf('A WALL IS NEARER THAN THE NEXT ROOM');
  const flee = SRC.indexOf('BELOW THE LINE THIS KEEPER FLEES AT');
  const dying = SRC.indexOf('LOSING HEALTH FAST ENOUGH THAT THE ROAD WILL NOT END FIRST');
  const twoHits = SRC.indexOf('INSIDE TWO HITS OF DEATH');
  ok('the rung exists at all', rung > 0);
  // ORDER IS THE WHOLE POINT. Above the flee line, so a character with a wall in reach walks
  // to it instead of running; below the emergencies, which know better than any detour does.
  ok('it is asked BEFORE the flee line', rung > 0 && flee > 0 && rung < flee);
  ok('and before the emptying-bar test', rung > 0 && dying > 0 && rung < dying);
  // AND ABOVE PLAYING DEAD, WHICH IS WHERE IT HAD TO MOVE. Below it the rung was dead code:
  // play_dead fires at worstHit*2, which for maxima of 22 to 56 is 67% to 73% of the bar and
  // therefore always beat this rung's 60%. Measured over 26 minutes, fifteen journeys taken
  // back and every one of them "two hits from death", six refuges and all six in towns.
  ok('and ABOVE playing dead, because a wall is geometry and playing dead is a gamble',
     twoHits > 0 && rung < twoHits);
  ok('it also fires wherever playing dead would have, when a wall is there to take instead',
     /wouldPlayDead/.test(SRC.slice(rung, twoHits)));
  const body = SRC.slice(rung, flee);
  // It must be switchable like every other faculty, and must reuse the guard key the
  // boundary version already uses rather than inventing a second one.
  ok('it is gated on the safe_spot faculty, not hard-wired',
     body.includes("travelAllows('safe_spot')"));
  ok('it only fires when a spot was actually found', /if \(spot\)/.test(body));
  ok('it uses the same reach the boundary hold uses', /travelHoldWithin/.test(body));
  ok('it hands back rather than steering, like the rungs around it', /takeBack\(/.test(body));
  ok('and it fires at its own threshold, well above the health people die at',
     /travelShelterBelow\(\)/.test(body));
  // THE THRESHOLD IS NO LONGER A CONSTANT — 2026-08-21, the operator's rule. In a zone the
  // character would never CHOOSE to fight in, any damage at all is a reason to take a wall;
  // everywhere else the ordinary 80% still applies, so a journey is not stopped by a
  // scratch. Measured cause: a level-33 character rested to full in the Cragged Mountains,
  // walked on, and lost twenty-two health in twenty seconds. Waiting to fall through 80%
  // there spends most of the margin it had.
  ok('and the threshold is asked for, not hardcoded, because it depends on the room',
     /travelShelterBelow\(\) \{/.test(SRC));
  ok('which is the ordinary 80% where we would fight',
     /travelWallBelow \?\? 0\.8/.test(SRC));
  ok('and 100% — any damage — where the room outranks us',
     /roomOutranksUs\(\) \? 1 :/.test(SRC));
  ok('with "outranks" meaning the engagement ceiling the ladder already uses',
     /roomOutranksUs\(/.test(SRC) && /refuseEngagement\(name\)/.test(SRC));
  // AND THE CLOCK SAYS HOP BOUNDARY, which is the other half of the same argument. A
  // threshold of 1 — any damage at all — is survivable as a rule for where to PAUSE and
  // ruinous as a rule for what may CANCEL: mid-hop the only thing the rung can do is take
  // the body off the line, so at this threshold the crossing was torn down at step 0 of 40
  // and never finished. The number stays; the clock is what changed.
  ok('and the clock says safe_spot pauses at a hop boundary rather than cancelling mid-hop',
     /safe_spot: 'hop boundary'/.test(SRC));
}

console.log('');
console.log('the fuel-stop policy is actually handed to the mover');
{
  // A MECHANISM NOBODY SETS IS A MECHANISM THAT DOES NOTHING. `walkTo` reads
  // `shelterPolicy` off the session; if the keeper never writes it, every crossing plans no
  // shelters and the whole thing is dead code that tests green.
  const SRC = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const go = SRC.indexOf('goTravelling(why = null');
  const body = SRC.slice(go, go + 2600);
  ok('goTravelling sets it', /this\.s\.shelterPolicy = \{/.test(body));
  ok('and only when the safe_spot faculty is allowed', /allow\.safe_spot/.test(body));
  ok('need() reads health at the moment it is asked, not when the journey began',
     /need: \(\) => \{[\s\S]{0,220}vitals/.test(body));
  ok('and it asks the same threshold the ladder does', /travelShelterBelow\(\)/.test(body));
  // AND IT IS CLEARED. Left set, it would offer a stop on an errand or a shopping trip,
  // neither of which has a route ahead to fold one into.
  const rev = SRC.indexOf('revive(why = null)');
  ok('revive clears it', /this\.s\.shelterPolicy = null/.test(SRC.slice(rev, rev + 700)));
}

console.log('');
console.log('playing dead can actually fire');
{
  // ZERO TIMES IN AN ENTIRE PROD SESSION. playDead was reachable only through the
  // `sheltered` branch -- holdWorks(), a wall the book has CONFIRMED -- and the deaths say
  // five of seven happened in the open and two on UNPROVEN walls, never once on a proven
  // one. The gate was false at the moment of every death, so the verb could not run.
  // Kermit sat at 5 of 36, fourteen per cent, for three consecutive pulses and died there.
  const PD = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const at = PD.indexOf('if (doomed && this.policy.panicLogoff !== false)');
  const body = PD.slice(at, at + 2400);
  ok('the doomed branch exists', at > 0);
  ok('a sheltered character still plays dead', /if \(sheltered\)[\s\S]{0,200}playDead/.test(body));
  ok('an unsheltered one still tries a town FIRST, which is the better option',
     /townTripIfCornered/.test(body));
  // THE FREEZE FALLBACK IS GONE, AND ITS ASSERTIONS MOVED. Reversed 2026-08-21: playing
  // dead off a proven safe spot is refused outright, because it recovers vigor and NEVER
  // health, and three characters were measured freezing in the open at 4, 10 and 13 health
  // in a fifteen-monster room and dying there.
  //
  // The checks for it live in `m59-playdead-test.mjs`, which is where somebody looking for
  // the rule would go — this file is named for an experiment that CLOSED on the same day,
  // and it had quietly become the home for rungs that have nothing to do with the A/B.
  // The operator's number, and it has to mean the same thing everywhere.
  ok('doomed is 30% behind a wall', /doomedInSpotBelow \?\? 0\.3\b/.test(PD));
  ok('and 30% in the open', /doomedInOpenBelow \?\? 0\.3\b/.test(PD));
  ok('with no older number left anywhere to disagree with it',
     !/doomedInOpenBelow \?\? 0\.4/.test(PD) && !/doomedInSpotBelow \?\? 0\.35/.test(PD));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
