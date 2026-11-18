#!/usr/bin/env node
// A SWING EVERY 1.05 SECONDS, AND A FIGHT THAT IS WORKING IS NOT HANDED BACK EVERY THREE ROUNDS.
//
//   node tools/m59-fight-cadence-test.mjs      # offline: no socket, no roster, a virtual clock
//
// WHAT THIS PINS AND WHY IT WAS WORTH BUILDING.
//
// Prod, 2026-11-18: four healthy 143-149 health farmers in Castle Victoria, seven monsters in reach, journaling
// "broke off - still alive after 3 rounds" five times running on one skeleton. Measured from their journals: a
// median 1.71 s a round (n=32) against a server that takes a swing a second (IsOkayAttackTime, player.kod:5305),
// and a median 7 rounds a kill. One 3-round fight() call took 3.62 s and the pass between two calls 1.56 s, so
// 2.9 s of every 5.2 was spent handing the fight back and picking it up again.
//
// The REAL Session, the REAL Pacer and the REAL M59Client run here under node:test's mock clock; only the wire is
// replaced, by a small model of what the server does with each packet:
//
//   - an attack arriving less than 1000 ms after the last accepted one is refused IN SILENCE (TryAttack returns
//     FALSE with no message, player.kod:3974), and counted, so "never faster than the server's timer" is an
//     assertion and not a hope;
//   - a target behind our facing's octant line is refused with "You can't see your selected target." (the eight
//     clauses of TargetWithinSightAndRange, player.kod:4188-4205, ported below), so a turn that was skipped
//     wrongly shows up as a refused swing;
//   - a hit sends its sentence, and the resistance band a little LATER as its own delivery;
//   - health is pushed on change and never otherwise (DrawHealth, user.kod:6631).
//
// One block is the comparison: a ten-round kill asked for the way the farm pass now asks, against the same kill at
// the old budget of three rounds a call with the measured 1.56 s of pass between calls. The last block is the farm
// pass itself: what it asks fight() for, when its gate wants the body back, and what it writes to the journal and
// the ledger.

import './m59-test-ledger.mjs';          // FIRST: a test that touches keeper code never writes a real fleet's history
import { mock } from 'node:test';
import { M59Client, BP } from './m59-client.mjs';
import { OF } from './m59-parse.mjs';
import { Session, ATTACK_INTERVAL_MS } from './m59-game.mjs';
import { fight } from './m59-skills.mjs';
import { Autopilot } from './m59-autopilot.mjs';
import { readToolSource } from './autopilot/source.mjs';
import {
  SWING_REFACE_DEG, SWING_REPLY_MS, SWING_SETTLE_MS, VITALS_POLL_MS, FARM_PRESS_ROUNDS,
  bearingDeg, degreesApart, swingFacing, notInViewText, outOfReachText, pressVerdict, handedBackNote,
  swingPace, paceFields, tallyQuarry, killTotals, paceReport,
} from './m59-fight-cadence.mjs';

let passed = 0, failed = 0;
function ok(name, condition, detail = '') {
  if (condition) { passed++; console.log(`ok ${passed} - ${name}`); return; }
  failed++;
  console.error(`not ok - ${name}${detail ? ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

// ------------------------------------------------------------------ the server's view test, in its own clauses
const MAX_ANGLE = 4096;
const unitsOf = deg => Math.round(deg * MAX_ANGLE / 360) & (MAX_ANGLE - 1);
function serverSees(angle, me, t) {
  const dRow = t.row - me.row, dCol = t.col - me.col;
  if (dRow * dRow + dCol * dCol <= 1) return true;                 // "if iDist > 1 AND (...)", player.kod:4188
  const A = n => n * MAX_ANGLE / 16;
  const ESE = A(1), SSE = A(3), SSW = A(5), WSW = A(7), WNW = A(9), NNW = A(11), NNE = A(13), ENE = A(15);
  const behind =
       ((angle > ENE || angle <= ESE) && t.col < me.col)
    || (angle > ESE && angle <= SSE && (t.row - me.row) < (me.col - t.col))
    || (angle > SSE && angle <= SSW && t.row < me.row)
    || (angle > SSW && angle <= WSW && (t.row - me.row) < (t.col - me.col))
    || (angle > WSW && angle <= WNW && t.col > me.col)
    || (angle > WNW && angle <= NNW && (t.row - me.row) > (me.col - t.col))
    || (angle > NNW && angle <= NNE && t.row > me.row)
    || (angle > NNE && angle <= ENE && (t.row - me.row) > (t.col - me.col));
  return !behind;
}

// ------------------------------------------------------------------ pure: facing
console.log('facing: turn when the server could refuse, never otherwise');
{
  const me = { col: 10, row: 10, degrees: 0 };
  ok('a target due east of a body facing east needs no turn',
     swingFacing({ me, target: { col: 11, row: 10 } }).turn === false);
  ok('the same target after it steps to the south-east is 45 degrees off, and is turned to',
     swingFacing({ me, target: { col: 11, row: 11 } }).turn === true);
  ok('a body that does not know where it faces turns',
     swingFacing({ me: { col: 10, row: 10 }, target: { col: 11, row: 10 } }).turn === true &&
     swingFacing({ me: { col: 10, row: 10, degrees: null }, target: { col: 11, row: 10 } }).turn === true);
  ok('a refusal for view forces the turn whatever we believe about our facing',
     swingFacing({ me, target: { col: 11, row: 10 }, force: true }).turn === true);
  ok('standing on its square there is no bearing, and no turn',
     swingFacing({ me, target: { col: 10, row: 10 } }).turn === false && bearingDeg(me, { col: 10, row: 10 }) === null);
  ok('with no position of our own the old behaviour stands: ask for the turn',
     swingFacing({ me: null, target: { col: 1, row: 1 } }).turn === true);
  ok('headings wrap: 350 and 10 are twenty degrees apart',
     degreesApart(350, 10) === 20 && degreesApart(10, 350) === 20 && degreesApart(0, 180) === 180);
  ok('the bearing is the one faceToward sends (east 0, south 90, west 180, north 270)',
     bearingDeg(me, { col: 11, row: 10 }) === 0 && bearingDeg(me, { col: 10, row: 11 }) === 90 &&
     bearingDeg(me, { col: 9, row: 10 }) === 180 && bearingDeg(me, { col: 10, row: 9 }) === 270);

  // THE THRESHOLD AGAINST THE SERVER'S OWN CLAUSES. Every facing a client can send, every offset inside six squares.
  let skippedAndRefused = 0, insideBoundAndRefused = 0, refusedBeyond = 0, cases = 0;
  for (let facing = 0; facing < 360; facing++) {
    const body = { col: 0, row: 0, degrees: Math.round(unitsOf(facing) * 360 / MAX_ANGLE) };
    for (let dRow = -6; dRow <= 6; dRow++) for (let dCol = -6; dCol <= 6; dCol++) {
      if (!dRow && !dCol) continue;
      const target = { col: dCol, row: dRow };
      const seen = serverSees(unitsOf(facing), body, target);
      const apart = degreesApart(bearingDeg(body, target), body.degrees);
      cases++;
      if (!swingFacing({ me: body, target }).turn && !seen) skippedAndRefused++;
      if (apart <= 67 && !seen) insideBoundAndRefused++;
      if (apart > 67.5 && !seen) refusedBeyond++;
    }
  }
  ok(`no swing the rule leaves unturned is one the server refuses for view (${cases} facing/offset pairs)`,
     skippedAndRefused === 0, { skippedAndRefused });
  ok('the server accepts everything within 67 degrees of the facing, so half an octant leaves a whole octant spare',
     insideBoundAndRefused === 0 && SWING_REFACE_DEG === 22.5, { insideBoundAndRefused });
  ok('and it does refuse beyond that, so the turn is not optional', refusedBeyond > 0, { refusedBeyond });
}

console.log('\nthe server\'s refusals, in its own words');
{
  ok('the view refusal is recognised', notInViewText("You can't see your selected target."));
  ok('the three range refusals are recognised',
     outOfReachText('The skeleton is too far away to hit with a long sword.') &&
     outOfReachText("You can't reach the skeleton with your fists.") &&
     outOfReachText('The skeleton is out of range.'));
  ok('a hit, a miss and an incoming blow are neither',
     ['Your long sword pokes the skeleton.', 'The skeleton dodges your attack.', 'The skeleton pokes you with its attack.']
       .every(t => !notInViewText(t) && !outOfReachText(t)));
}

// ------------------------------------------------------------------ pure: the round budget
console.log('\nthe round budget: three without proof, on while it lands, never past the cap');
{
  const farm = o => pressVerdict({ rounds: 3, pressRounds: 12, ...o });
  ok('a caller that passes only rounds gets exactly that many, whatever lands',
     [0, 1, 2].every(round => pressVerdict({ round, rounds: 3 }).go) &&
     pressVerdict({ round: 3, rounds: 3, sinceHit: 0 }).go === false &&
     pressVerdict({ round: 3, rounds: 3 }).why === 'rounds');
  ok('one round means one round', pressVerdict({ round: 0, rounds: 1 }).go && !pressVerdict({ round: 1, rounds: 1 }).go);
  ok('the first three rounds are granted without proof', [0, 1, 2].every(round => farm({ round, sinceHit: round }).go));
  ok('a fight that is landing goes on past three', farm({ round: 3, sinceHit: 0 }).go && farm({ round: 11, sinceHit: 2 }).pressing === true);
  ok('three rounds with nothing landed hand it back', farm({ round: 3, sinceHit: 3 }).why === 'quiet' && farm({ round: 8, sinceHit: 3 }).why === 'quiet');
  ok('a swing refused as out of reach hands it back at once', farm({ round: 5, sinceHit: 1, outOfReach: true }).why === 'out_of_reach');
  ok('the caller\'s gate hands it back, and says why', (v => v.go === false && v.why === 'gate' && v.gate === 'health is under the line')(
     farm({ round: 4, sinceHit: 0, gate: 'health is under the line' })));
  ok('the cap ends it however well it is going', farm({ round: 12, sinceHit: 0 }).why === 'cap' && farm({ round: 11, sinceHit: 0 }).go);
  ok('a cap under the proof budget is the whole budget',
     pressVerdict({ round: 1, rounds: 3, pressRounds: 2 }).go && pressVerdict({ round: 2, rounds: 3, pressRounds: 2 }).why === 'cap');
  ok('the default cap is twelve', FARM_PRESS_ROUNDS === 12);
  ok('every hand-back still opens with the words the readers match',
     ['rounds', 'cap', 'quiet', 'out_of_reach', 'gate'].every(why =>
       /^still alive after 7 rounds\. /.test(handedBackNote(7, { why, gate: 'x' }))) &&
     /too far away/.test(handedBackNote(3, { why: 'rounds' })));
}

console.log('\nthe numbers a fight reports');
{
  ok('ten swings 1050 ms apart are ten swings at 1050', (p => p.swings === 10 && p.swing_ms === 1050)(
     swingPace(Array.from({ length: 10 }, (_, i) => 5000 + i * 1050))));
  ok('one swing has no interval, and that is null rather than zero',
     swingPace([123]).swing_ms === null && swingPace([123]).swings === 1 && swingPace([]).swings === 0);
  ok('only measured fields reach a journal line',
     JSON.stringify(paceFields({ swings: 4, fight_ms: 4300, swing_ms: 1051, rounds: 4 })) === '{"swings":4,"fight_ms":4300,"swing_ms":1051}' &&
     JSON.stringify(paceFields({ rounds: 3 })) === '{}' &&
     paceFields({ handed_back: { why: 'gate', gate: 'a crowd' } }).handed_back === 'gate: a crowd');
  const a = tallyQuarry(null, { fought: true, target_id: 40, rounds: 12, swings: 12, started_at: 1000, fight_ms: 13000 }, { room: 38 });
  const b = tallyQuarry(a, { fought: true, target_id: 40, rounds: 5, swings: 5, started_at: 15600, fight_ms: 5600 }, { room: 38 });
  ok('a kill that took two calls reports both', (t => t.kill_calls === 2 && t.kill_rounds === 17 && t.kill_swings === 17 && t.kill_ms === 20200)(killTotals(b)));
  ok('another quarry, another room or a stale tally starts again',
     tallyQuarry(a, { fought: true, target_id: 41, rounds: 2, swings: 2, started_at: 15600, fight_ms: 2100 }, { room: 38 }).calls === 1 &&
     tallyQuarry(a, { fought: true, target_id: 40, rounds: 2, swings: 2, started_at: 15600, fight_ms: 2100 }, { room: 39 }).calls === 1 &&
     tallyQuarry(a, { fought: true, target_id: 40, rounds: 2, swings: 2, started_at: 400000, fight_ms: 2100 }, { room: 38 }).calls === 1);
  ok('a call that never fought changes nothing',
     tallyQuarry(a, { fought: false, out_of_reach: true, target_id: 40 }, { room: 38 }) === a);
  ok('swings that were not counted are not reported as counted',
     killTotals(tallyQuarry(a, { fought: true, target_id: 40, rounds: 3, started_at: 15600, fight_ms: 3300 }, { room: 38 })).kill_swings === undefined);

  // Reading it back: what `node tools/m59-fight-cadence.mjs --fleet prod --since 30m` prints.
  const report = paceReport([
    { kind: 'killed', character: 'Piggy', swing_ms: 1050, kill_rounds: 7, kill_ms: 7700, kill_calls: 1 },
    { kind: 'killed', character: 'Piggy', swing_ms: 1052, kill_rounds: 16, kill_ms: 19400, kill_calls: 2 },
    { kind: 'killed', character: 'Piggy', rounds: 3 },                        // written before the swing clock
    { kind: 'killed', character: 'Lew', swing_ms: 1049, fought_back: true },  // a fight-back kill: its own call's pace only
    { kind: 'ate', character: 'Lew' },
  ]);
  ok('the report counts every kill and measures only the rows that carry the fields',
     report.total.kills === 4 && report.total.measured === 2 && report.rows[0].character === 'Piggy' &&
     report.rows[0].kills === 3 && report.rows[0].measured === 2, report);
  ok('seconds per round is kill time over kill rounds; rounds per kill and the swing interval are medians',
     report.rows[0].seconds_per_round === 1.18 && report.rows[0].rounds_per_kill === 11.5 &&
     report.rows[0].swing_ms === 1051 && report.rows[0].handed_back === 1, report.rows[0]);
  ok('a character with nothing measured reads null, never zero',
     (lew => lew.kills === 1 && lew.measured === 0 && lew.seconds_per_round === null && lew.rounds_per_kill === null &&
             lew.handed_back === null && lew.swing_ms === 1049)(report.rows[1]), report.rows[1]);
  ok('an empty window is an empty report, with no number in it',
     paceReport([]).total.kills === 0 && paceReport([]).total.seconds_per_round === null && paceReport([]).rows.length === 0);
}

// ------------------------------------------------------------------ the virtual clock and the model server
mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
const immediate = () => new Promise(resolve => setImmediate(resolve));
async function quiesce(turns = 6) { for (let i = 0; i < turns; i++) await immediate(); }
/** Run `promise` to completion on the virtual clock, 5 ms at a time. */
async function drive(promise, { step = 5, limitMs = 240_000 } = {}) {
  let state = null;
  promise.then(value => { state = { value }; }, error => { state = { error }; });
  for (let spent = 0; !state && spent <= limitMs; spent += step) { await quiesce(); if (state) break; mock.timers.tick(step); }
  await quiesce();
  if (!state) throw new Error(`still pending after ${limitMs} virtual ms`);
  if (state.error) throw state.error;
  return state.value;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Wait (on the virtual clock) until `n` attacks have left, or a minute: a regression must fail, not hang. */
async function afterSwings(w, n) { for (const until = Date.now() + 60_000; w.attacks().length < n && Date.now() < until;) await sleep(10); }

const HIT = 'Your long sword pokes the skeleton.';
const BAND = 'The skeleton laughs off your pitiful blow.';
const MISS = 'The skeleton dodges your attack.';
const FAR = 'The skeleton is too far away to hit with a long sword.';
const UNSEEN = "You can't see your selected target.";
const BITTEN = 'The skeleton pokes you with its attack.';

let fixtures = 0;
/**
 * One farmer, one skeleton, and a server that answers the way the real one does.
 *   rtt        ms from a packet leaving to its answer arriving
 *   foeHp      landed blows the skeleton takes
 *   outcome    (n, world) => 'hit' | 'miss' | 'far' | 'silent'  for the n-th accepted swing (1-based)
 *   bandLag    ms after the hit sentence that the resistance band arrives (null: no band)
 *   bite       damage the skeleton does to us after each accepted swing
 *   facing     where the SERVER believes we face at the start (degrees); our own belief starts the same
 * We stand at r10c10 and the skeleton at r11c11, so its bearing is 45 degrees and we start with our back to it.
 */
function world({ rtt = 100, foeHp = 10, outcome = () => 'hit', bandLag = 20, bite = 0, facing = 180,
                 health = 149, healthMax = 149, mute = false } = {}) {
  const names = new Map([[1, 'skeleton'], [2, 'Tester'], [3, 'Castle Victoria']]);
  const rsc = { get: id => names.get(id) ?? '', has: id => names.has(id), set: (id, text) => names.set(id, text) };
  const c = new M59Client({ verbose: false, resources: rsc });
  c.state = 'game'; c.selfId = 99; c.roomNameRsc = 3;
  const self = { id: 99, col: 10, row: 10, nameRsc: 2, flags: OF.PLAYER, degrees: facing };
  // Diagonally beside us: squared distance 2, so the server's view test applies (it is skipped at <= 1).
  const foe = { id: 40, col: 11, row: 11, nameRsc: 1, flags: OF.ATTACKABLE };
  c.room.id = 5000; c.room.objects.set(self.id, self); c.room.objects.set(foe.id, foe);

  const w = { c, self, foe, rtt, mute, sent: [], accepted: 0, refusedEarly: 0, refusedView: 0, lastAccepted: -Infinity,
              angle: unitsOf(facing), foeHp, health, healthMax, ticks: 0 };
  const pushHealth = () => c.noteStat({ group: 1, num: 1, name: 'health', value: w.health, currentMax: w.healthMax, max: 100 });
  const pushVigor = () => c.noteStat({ group: 1, num: 3, name: 'vigor', value: 180, currentMax: 80, max: 200 });
  const deliver = (delay, fn) => setTimeout(() => { if (w.mute) return; c.lastRxAt = c.lastGameMsgAt = Date.now(); fn(); }, delay);
  const say = text => c.emit('message', { text });
  pushHealth(); pushVigor();
  w.pushHealth = value => { w.health = value; c.lastRxAt = c.lastGameMsgAt = Date.now(); pushHealth(); };
  w.say = text => { c.lastRxAt = c.lastGameMsgAt = Date.now(); say(text); };

  c.send = (op, ...parts) => {
    const at = Date.now();
    w.sent.push({ at, op });
    if (op === BP.REQ_TURN) { w.angle = parts[1].readUInt16LE(0); return; }
    if (op === BP.SEND_STATS) { deliver(rtt, () => { pushHealth(); pushVigor(); }); return; }
    if (op === BP.SEND_ROOM_CONTENTS) {
      const request = c.roomContentsRequested + 1;
      deliver(rtt, () => { c.roomContentsReceived = request;
                           c.emit('room-contents', { room: c.room.id, count: c.room.objects.size, request }); });
      return;
    }
    if (op !== BP.REQ_ATTACK) return;
    // The server's own order: the attack timer first and in silence, then range and view.
    if (at - w.lastAccepted < 1000) { w.refusedEarly++; return; }
    w.lastAccepted = at;
    if (!c.room.objects.has(foe.id)) return;
    w.accepted++;
    const n = w.accepted;
    const what = outcome(n, w);
    if (what === 'silent') return;
    if (what === 'far') { deliver(rtt, () => say(FAR)); return; }
    if (!serverSees(w.angle, self, foe)) { w.refusedView++; deliver(rtt, () => say(UNSEEN)); return; }
    if (what === 'miss') deliver(rtt, () => say(MISS));
    else {
      deliver(rtt, () => {
        say(HIT);
        if (--w.foeHp <= 0) { c.room.objects.delete(foe.id); c.emit('vanished', { id: foe.id, what: 'skeleton' }); }
      });
      if (bandLag != null) deliver(rtt + bandLag, () => say(BAND));
    }
    if (bite) deliver(rtt + 40, () => { w.health -= bite; say(BITTEN); pushHealth(); });
  };

  const s = new Session(`cadence-fixture-${++fixtures}`);
  Object.assign(s, { client: c, healingWandTick: async () => { w.ticks++; } });
  // The approach is not what is measured here; the body already stands beside the skeleton.
  s.walkToMeleeRange = async () => ({ arrived: true, steps: 0, reason: null, position: { row: self.row, col: self.col } });
  w.s = s;
  w.attacks = () => w.sent.filter(p => p.op === BP.REQ_ATTACK).map(p => p.at);
  w.count = op => w.sent.filter(p => p.op === op).length;
  w.gaps = () => { const at = w.attacks(); return at.slice(1).map((t, i) => t - at[i]); };
  return w;
}
const near = (value, want, slack = 25) => Math.abs(value - want) <= slack;
const allNear = (values, want, slack = 25) => values.length > 0 && values.every(v => near(v, want, slack));

// ------------------------------------------------------------------ attackRounds: the cadence
console.log('\nattackRounds: the swing interval is the server\'s');
{
  const w = world({ foeHp: 99 });
  const began = Date.now();
  const r = await drive(w.s.attackRounds(w.foe.id, 10, { abortBelow: 0.4 }));
  const gaps = w.gaps();
  ok(`ten swings leave ${ATTACK_INTERVAL_MS} ms apart (was about 1.7 s a round on prod)`,
     w.attacks().length === 10 && allNear(gaps, ATTACK_INTERVAL_MS), gaps);
  ok('none was sent inside the server\'s attack timer, and none was refused for view',
     w.refusedEarly === 0 && w.refusedView === 0 && w.accepted === 10, w);
  ok('one turn, for the facing we started with, and none after it: nobody moved',
     w.count(BP.REQ_TURN) === 1, `${w.count(BP.REQ_TURN)} turns`);
  ok('no health read was sent: every swing was answered, and health is pushed',
     w.count(BP.SEND_STATS) === 0, `${w.count(BP.SEND_STATS)} reads`);
  ok('eleven packets for ten swings, where there were thirty',
     w.sent.length === 11, `${w.sent.length} packets`);
  ok('the exchange reports what it sent and when',
     r.swings === 10 && r.swing_at.length === 10 && r.turns === 1 && !r.polls && near(r.swing_at[9] - r.swing_at[0], 9 * ATTACK_INTERVAL_MS, 60), r);
  ok('the whole exchange took ten intervals and a settle, not seventeen seconds',
     near(Date.now() - began, 9 * ATTACK_INTERVAL_MS + 200 + SWING_SETTLE_MS, 120), `${Date.now() - began} ms`);
  ok('the healing reflex still runs before every swing and after every exchange', w.ticks === 20, `${w.ticks} ticks`);
  ok('every band sentence was collected, including the one after the last hit',
     r.messages.filter(m => m === BAND).length === 10 && r.messages.filter(m => m === HIT).length === 10, r.messages.length);
}

{
  const w = world({ foeHp: 99, rtt: 100 });
  // The fight loop's shape: one swing a call, twelve calls back to back.
  const run = (async () => { const out = []; for (let i = 0; i < 12; i++) out.push(await w.s.attackRounds(w.foe.id, 1, { abortBelow: 0.4 })); return out; })();
  const rs = await drive(run);
  ok('called one swing at a time, as fight() calls it, the interval is the same',
     w.attacks().length === 12 && allNear(w.gaps(), ATTACK_INTERVAL_MS), w.gaps());
  ok('and still nothing but attacks after the first turn', w.count(BP.REQ_TURN) === 1 && w.count(BP.SEND_STATS) === 0 && w.refusedEarly === 0);
  ok('each one-swing call collected its own band sentence', rs.every(r => r.messages.includes(HIT) && r.messages.includes(BAND)),
     rs.map(r => r.messages.length));
}

{
  const w = world({ foeHp: 99, rtt: 320, bandLag: 5 });
  const r = await drive(w.s.attackRounds(w.foe.id, 6, { abortBelow: 0.4 }));
  ok('a third of a second of lag changes nothing: the reply fits inside the interval',
     allNear(w.gaps(), ATTACK_INTERVAL_MS) && w.count(BP.SEND_STATS) === 0 && r.swings === 6, w.gaps());
}

console.log('\nattackRounds: a turn only when the bearing moved');
{
  const w = world({ foeHp: 99, outcome: (n, world_) => { if (n === 4) world_.foe.col = 9; return 'hit'; } });
  // The skeleton steps from south-east of us to south-west of us while the fourth swing is being answered.
  const r = await drive(w.s.attackRounds(w.foe.id, 8, { abortBelow: 0.4 }));
  ok('the skeleton stepping round us costs exactly one more turn', w.count(BP.REQ_TURN) === 2 && r.turns === 2, `${w.count(BP.REQ_TURN)} turns`);
  ok('and the turn fits inside the interval: no swing is late for it', allNear(w.gaps(), ATTACK_INTERVAL_MS), w.gaps());
  ok('no swing was refused for view on the way', w.refusedView === 0 && w.accepted === 8);
}
{
  // We believe we face the skeleton; the server does not (a turn it dropped). Its refusal has to correct us.
  const w = world({ foeHp: 99, facing: 225 });
  w.self.degrees = 45;
  const r = await drive(w.s.attackRounds(w.foe.id, 4, { abortBelow: 0.4 }));
  ok('"You can\'t see your selected target." forces the next turn, and the blows land after it',
     w.refusedView === 1 && w.count(BP.REQ_TURN) === 1 && r.messages.filter(m => m === HIT).length === 3, { refusedView: w.refusedView, turns: w.count(BP.REQ_TURN), m: r.messages });
}

console.log('\nattackRounds: what stops the next swing still stops it');
{
  const w = world({ foeHp: 99 });
  const exchange = w.s.attackRounds(w.foe.id, 6, { abortBelow: 0.5 });
  // Health falls through the line 600 ms after the second swing leaves: the third is already waiting its second.
  const hurt = (async () => { await afterSwings(w, 2); await sleep(600); w.pushHealth(60); })();
  const r = await drive(Promise.all([exchange, hurt]).then(([value]) => value));
  ok('health pushed below the line while the next swing waits its turn stops that swing',
     w.attacks().length === 2 && r.aborted?.swing === 2 && near(r.aborted.at_health, 60 / 149, 0.001), r.aborted);
  ok('and it returns at once, without a read and without a settle', w.count(BP.SEND_STATS) === 0 && r.swings === 2);
}
{
  const w = world({ foeHp: 99, bite: 30 });
  const r = await drive(w.s.attackRounds(w.foe.id, 9, { abortBelow: 0.5 }));
  // 149 -> 119 -> 89 -> 59: the third bite puts us under half.
  ok('damage taken in an exchange is read before the next swing, from the push alone',
     w.attacks().length === 3 && r.aborted?.swing === 3 && w.count(BP.SEND_STATS) === 0 && r.vitals.health.value === 59, { n: w.attacks().length, aborted: r.aborted });
}
{
  const w = world({ foeHp: 99 });
  let stop = false;
  const exchange = w.s.attackRounds(w.foe.id, 6, { abortBelow: 0.4, shouldCancel: () => stop });
  const cancel = (async () => { await afterSwings(w, 3); await sleep(500); stop = true; })();
  const r = await drive(Promise.all([exchange, cancel]).then(([value]) => value));
  ok('a cancel that lands between two swings stops the next one', w.attacks().length === 3 && r.cancelled?.at_swing === 3, r.cancelled);
}
{
  const w = world({ foeHp: 3 });
  const began = Date.now();
  const r = await drive(w.s.attackRounds(w.foe.id, 10, { abortBelow: 0.4 }));
  const took = Date.now() - began;
  ok('a target that vanishes ends the exchange at once: no fourth swing, no read, no settle',
     w.attacks().length === 3 && w.count(BP.SEND_STATS) === 0 && near(took, 2 * ATTACK_INTERVAL_MS + 200 + w.rtt, 60), `${took} ms`);
  ok('and the killing blow is in the messages', r.messages.filter(m => m === HIT).length === 3 && r.swings === 3);
}
{
  const w = world({ foeHp: 99, bandLag: 150 });
  const r = await drive(w.s.attackRounds(w.foe.id, 1, { abortBelow: 0.4 }));
  ok('the resistance sentence that follows the hit is still collected from a single swing',
     r.messages.join('|') === `${HIT}|${BAND}`, r.messages);
}
{
  // The band arrives after a reply that itself came late: the sweep waits for the reply, then a little more.
  const w = world({ foeHp: 99, rtt: 400, bandLag: 40 });
  const r = await drive(w.s.attackRounds(w.foe.id, 1, { abortBelow: 0.4 }));
  ok('and from a single swing whose reply was itself slow', r.messages.join('|') === `${HIT}|${BAND}`, r.messages);
}

console.log('\nattackRounds: a silent server is asked, and a deaf one is not swung at');
{
  const w = world({ foeHp: 99, outcome: n => (n === 2 ? 'silent' : 'hit') });
  const r = await drive(w.s.attackRounds(w.foe.id, 4, { abortBelow: 0.4 }));
  const at = w.attacks();
  ok('a swing nothing answered is followed by ONE health read before the next swing',
     w.count(BP.SEND_STATS) === 1 && r.polls === 1 && r.swings === 4, { reads: w.count(BP.SEND_STATS), polls: r.polls });
  ok('the read went out when the reply window closed, and the swing after it waited for the answer',
     near(w.sent.find(p => p.op === BP.SEND_STATS).at - at[1], SWING_REPLY_MS, 30) && at[2] - at[1] >= SWING_REPLY_MS + w.rtt - 10 &&
     at[2] - at[1] <= SWING_REPLY_MS + w.rtt + 260, { gap: at[2] - at[1] });
  ok('the other swings kept the interval', near(at[1] - at[0], ATTACK_INTERVAL_MS) && near(at[3] - at[2], ATTACK_INTERVAL_MS), w.gaps());
}
{
  const w = world({ foeHp: 99 });
  const exchange = w.s.attackRounds(w.foe.id, 5, { abortBelow: 0.4 });
  const deafen = (async () => { await afterSwings(w, 2); w.mute = true; })();
  const began = Date.now();
  const r = await drive(Promise.all([exchange, deafen]).then(([value]) => value));
  ok('when neither the swing nor the read is answered, the next swing is NOT sent',
     w.attacks().length === 2 && r.stale?.at_swing === 2 && w.count(BP.SEND_STATS) === 1, { n: w.attacks().length, stale: r.stale, reads: w.count(BP.SEND_STATS) });
  ok('it gave the server the reply window and the read its time, and no longer',
     near(Date.now() - began, ATTACK_INTERVAL_MS + 200 + SWING_REPLY_MS + VITALS_POLL_MS, 120), `${Date.now() - began} ms`);
  // The server comes back: the next call asks once more, is answered, and swings.
  w.mute = false;
  const again = await drive(w.s.attackRounds(w.foe.id, 1, { abortBelow: 0.4 }));
  ok('and when the server answers again the fight goes on', again.swings === 1 && !again.stale && again.polls === 1, again);
}
{
  const w = world({ foeHp: 99 });
  w.mute = true;
  const r = await drive(w.s.attackRounds(w.foe.id, 1, { abortBelow: 0.4 }));
  ok('a single swing into a deaf server says so itself, after one read and no second swing',
     r.swings === 1 && r.stale?.at_swing === 1 && w.count(BP.SEND_STATS) === 1 && w.attacks().length === 1, { swings: r.swings, stale: r.stale });
}
{
  const w = world({ foeHp: 99, outcome: () => 'silent' });
  const r = await drive(w.s.attackRounds(w.foe.id, 3, {}));
  ok('with no health line to hold, a silent exchange is still asked about once it ends, and swings are not gated on it',
     r.swings === 3 && w.count(BP.SEND_STATS) === 1 && !r.stale, { swings: r.swings, reads: w.count(BP.SEND_STATS) });
}

// ------------------------------------------------------------------ fight(): pressing a fight that is working
const farmFight = (w, extra = {}) => fight(w.s, {
  target: 'skeleton', preferId: w.foe.id, exactTargetId: w.foe.id, match: () => true,
  disengageAt: 0.4, loot: false, equip: false, holdPosition: false, reach: 2,
  pressRounds: FARM_PRESS_ROUNDS, ...extra });

console.log('\nfight(): a fight that is landing runs to the kill');
{
  const w = world({ foeHp: 10 });
  const r = await drive(farmFight(w));
  ok('a ten-round kill is one call', r.killed === true && r.rounds === 10 && w.attacks().length === 10, { killed: r.killed, rounds: r.rounds });
  ok('at the server\'s interval', allNear(w.gaps(), ATTACK_INTERVAL_MS) && near(r.swing_ms, ATTACK_INTERVAL_MS, 15), { gaps: w.gaps(), swing_ms: r.swing_ms });
  ok('and it says so: swings, the interval, and what the call cost',
     r.swings === 10 && Number.isFinite(r.started_at) && near(r.fight_ms, 9 * ATTACK_INTERVAL_MS + 900, 500), { swings: r.swings, fight_ms: r.fight_ms });
  ok('no turn after the first, no read between swings', w.count(BP.REQ_TURN) === 1 && w.count(BP.SEND_STATS) === 2, { turns: w.count(BP.REQ_TURN), reads: w.count(BP.SEND_STATS) });
  ok('nothing was refused by the server', w.refusedEarly === 0 && w.refusedView === 0);
}
{
  const w = world({ foeHp: 99 });
  const r = await drive(farmFight(w));
  ok('the cap hands it back at twelve, and says it was the cap',
     r.killed === false && r.rounds === 12 && r.handed_back?.why === 'cap' && /^still alive after 12 rounds\. /.test(r.note), { rounds: r.rounds, hb: r.handed_back });
  ok('with the foe to resume', r.foe_id === w.foe.id && r.landed_hits === 12);
}
{
  const w = world({ foeHp: 99, outcome: () => 'far' });
  const r = await drive(farmFight(w));
  ok('a quarry that is out of reach from the start still gets three rounds and no more',
     r.rounds === 3 && w.attacks().length === 3 && r.landed_hits === 0 && r.handed_back?.why === 'out_of_reach', { rounds: r.rounds, hb: r.handed_back });
}
{
  const w = world({ foeHp: 99, outcome: n => (n <= 5 ? 'hit' : 'far') });
  const r = await drive(farmFight(w));
  ok('a quarry that steps out of reach mid-fight costs one refused swing, not three',
     r.rounds === 6 && w.attacks().length === 6 && r.handed_back?.why === 'out_of_reach' && /out of reach/.test(r.note), { rounds: r.rounds, hb: r.handed_back });
}
{
  const w = world({ foeHp: 99, outcome: n => (n <= 2 ? 'hit' : 'miss') });
  const r = await drive(farmFight(w));
  ok('three rounds running with nothing landed hand it back', r.rounds === 5 && r.handed_back?.why === 'quiet' && r.landed_hits === 2, { rounds: r.rounds, hb: r.handed_back });
}
{
  const w = world({ foeHp: 99, outcome: n => (n % 2 ? 'hit' : 'miss') });
  const r = await drive(farmFight(w));
  ok('missing every other swing is still a fight that is working', r.rounds === 12 && r.handed_back?.why === 'cap' && r.landed_hits === 6, { rounds: r.rounds, hb: r.handed_back });
}
{
  const w = world({ foeHp: 99 });
  let asked = 0;
  const r = await drive(farmFight(w, { pressWhile: () => (++asked >= 3 ? 'health is under the line a fight is started at' : null) }));
  ok('the caller\'s gate is asked before every round past the third, and ends the fight when it gives a reason',
     r.rounds === 5 && asked === 3 && r.handed_back?.why === 'gate' && /health is under the line/.test(r.note), { rounds: r.rounds, asked, hb: r.handed_back });
}
{
  const w = world({ foeHp: 99 });
  const r = await drive(farmFight(w, { pressWhile: () => { throw new Error('gate broke'); } }));
  ok('a gate that throws hands the fight back rather than pressing on blind', r.rounds === 3 && r.handed_back?.why === 'gate', { rounds: r.rounds, hb: r.handed_back });
}

console.log('\nfight(): the callers that chose a number keep it');
{
  const w = world({ foeHp: 99 });
  const r = await drive(farmFight(w, { rounds: 1, pressRounds: null }));
  ok('a training bout asks for one round and gets one, however well it lands',
     r.rounds === 1 && w.attacks().length === 1 && r.landed_hits === 1 && r.handed_back?.why === 'rounds', { rounds: r.rounds, hb: r.handed_back });
  ok('with the old words', r.note.startsWith('still alive after 1 rounds. Either it is too strong, or your attacks are missing'), r.note);
}
{
  const w = world({ foeHp: 99 });
  const r = await drive(farmFight(w, { pressRounds: null }));
  ok('nothing passed is three rounds, as it always was', r.rounds === 3 && w.attacks().length === 3 && r.handed_back?.why === 'rounds');
}
{
  const w = world({ foeHp: 99 });
  const r = await drive(farmFight(w, { rounds: 6, pressRounds: null }));
  ok('six rounds is six rounds (the buddy and the needle pass their own)', r.rounds === 6 && w.attacks().length === 6);
}
{
  const w = world({ foeHp: 99 });
  const r = await drive(farmFight(w, { pressRounds: 2 }));
  ok('an operator\'s fight_rounds under three is the whole budget', r.rounds === 2 && r.handed_back?.why === 'cap');
}

console.log('\nfight(): what ends a fight still ends a pressed one');
{
  const w = world({ foeHp: 99, bite: 30 });
  const r = await drive(farmFight(w, { disengageAt: 0.5 }));
  // 149 -> 119 -> 89 -> 59: the third bite lands after the hit sentence, while the exchange is settling.
  ok('the disengage line', r.disengaged?.at_health === '40%' && w.attacks().length === 3 && r.killed === false && !r.handed_back, { n: w.attacks().length, d: r.disengaged });
}
{
  const w = world({ foeHp: 99 });
  const fighting = farmFight(w);
  const cancel = (async () => { await afterSwings(w, 5); await sleep(300); w.s.cancelFight(null, 'a test'); })();
  const r = await drive(Promise.all([fighting, cancel]).then(([value]) => value));
  ok('a cancel from outside', r.cancelled === true && w.attacks().length === 5, { n: w.attacks().length, cancelled: r.cancelled });
}
{
  const w = world({ foeHp: 99, outcome: (n, world_) => { if (n === 6) world_.foe.col = 14; return 'hit'; } });
  const r = await drive(farmFight(w, { holdPosition: true, reach: 2 }));
  ok('a held wall whose quarry walks out of reach', r.drifted_out_of_reach?.distance === 4.1 && w.attacks().length === 6 && /holding position/.test(r.note), { n: w.attacks().length, drifted: r.drifted_out_of_reach });
}
{
  const w = world({ foeHp: 99, outcome: () => 'silent' });
  w.mute = true;
  const r = await drive(farmFight(w));
  ok('a server that answers nothing: one swing, then no more', w.attacks().length === 1 && r.killed === false && r.stale_vitals != null, { n: w.attacks().length, stale: r.stale_vitals, note: r.note });
}

// ------------------------------------------------------------------ the comparison the operator asked for
console.log('\na ten-round kill, the way the farm pass asks for it');
{
  const PASS_MS = 1560;      // the pass between two fight() calls on one quarry: median, prod 2026-11-18
  const kill = async press => {
    const w = world({ foeHp: 10 });
    const began = Date.now();
    let calls = 0, rounds = 0;
    const loop = (async () => {
      for (;;) {
        const r = await farmFight(w, { pressRounds: press });
        calls++; rounds += r.rounds;
        if (r.killed) return;
        await sleep(PASS_MS);
      }
    })();
    await drive(loop);
    return { calls, rounds, seconds: (Date.now() - began) / 1000, refused: w.refusedEarly + w.refusedView, packets: w.sent.length };
  };
  const before = await kill(null), after = await kill(FARM_PRESS_ROUNDS);
  const perRound = k => +(k.seconds / k.rounds).toFixed(2);
  console.log(`   three rounds a call:  ${before.calls} calls, ${before.seconds.toFixed(1)} s, ${perRound(before)} s a round, ${before.packets} packets`);
  console.log(`   pressed to the kill:  ${after.calls} call,  ${after.seconds.toFixed(1)} s, ${perRound(after)} s a round, ${after.packets} packets`);
  // Prod measured 1.71 s a round with the old budget AND the old swing loop (three or four packets a swing). This
  // is the old budget on the new loop: what the hand-back alone costs.
  ok('three rounds a call is four calls and well over a second a round, for the hand-backs alone',
     before.calls === 4 && before.rounds === 10 && perRound(before) >= 1.3, before);
  ok('pressed, it is one call at the server\'s second a round', after.calls === 1 && after.rounds === 10 && perRound(after) <= 1.15, after);
  ok('and neither sent the server a swing it refused', before.refused === 0 && after.refused === 0);
}

// ------------------------------------------------------------------ the farm pass: what it asks for and what it writes
console.log('\nthe farm pass');
{
  const pilot = (policy = {}, { health = 1, vigor = 180, attackers = 1 } = {}) => {
    const calls = { held: 0 };
    return {
      calls, policy,
      s: { client: { vitals: () => ({ health: { value: Math.round(health * 100), max: 100 }, vigor: { value: vigor, scale_max: 200 } }) } },
      fightFloor: () => 100,
      threat: () => ({ names: ['skeleton'], adjacent: Array.from({ length: attackers }), near: [] }),
      holdWorthwhile() { calls.held++; return { hold: this.wallNow === true, why: 'seven creatures in reach against a bar of six' }; },
      setHealth(h) { health = h; }, setVigor(v) { vigor = v; },
    };
  };
  const press = (p, o = {}) => Autopilot.prototype.farmFightPress.call(p, {
    training: { ready: true, equip: true }, alternate: null, safe: { engageAt: 0.75, fleeAt: 0.4 },
    worth: { hold: false }, holding: false, vigorNow: 180, vigorFloor: 100, engageName: 'skeleton', ...o });

  const p = pilot();
  const a = press(p);
  ok('an ordinary farm fight is pressed to the default cap', a.pressRounds === FARM_PRESS_ROUNDS && typeof a.pressWhile === 'function');
  ok('an operator\'s fight_rounds is the cap where one is set', press(pilot({ fightRounds: 30 })).pressRounds === 30);
  ok('a training bout is not pressed: it asked for one round',
     press(pilot(), { training: { ready: true, equip: false, rounds: 1 } }).pressRounds === null);
  ok('a covered-pull alternate is not pressed either', press(pilot(), { alternate: { target: {} } }).pressRounds === null);
  ok('the gate says go while nothing the pass decided has changed', a.pressWhile() === null);
  p.setHealth(0.7);
  ok('health under the line a fight is started at hands it back', /health/.test(a.pressWhile() ?? ''), a.pressWhile());
  p.setHealth(1); p.setVigor(90);
  ok('vigor falling through the fighting floor hands it back', /vigor/.test(a.pressWhile() ?? ''), a.pressWhile());
  p.setVigor(180); p.wallNow = true;
  ok('a wall the pass would now take hands it back', /wall/.test(a.pressWhile() ?? ''), a.pressWhile());
  const walled = pilot(); walled.wallNow = true;
  ok('a wall it already wanted and did not get is not a reason: nothing changed',
     press(walled, { worth: { hold: true } }).pressWhile() === null && walled.calls.held === 0);
  const tired = pilot({}, { vigor: 90 });
  ok('vigor that was already under the floor when the pass chose to fight is not a reason either',
     press(tired, { vigorNow: 90 }).pressWhile() === null);
  const held = pilot(); held.wallNow = true;
  ok('behind a wall there is no wall to take', press(held, { holding: true }).pressWhile() === null);

  // What reaches the journal and the ledger.
  const rows = [], notes = [];
  const keeper = {
    s: { name: 'fixture' }, tally: { kills: 0 }, killTimes: [], hold: null, policy: {},
    who: () => 'Tester', farmStrategyHook() {}, ledgerEvent: (kind, detail) => rows.push({ kind, ...detail }),
    progress() {}, noProgress() {}, countLoot() {}, wearLootedArmour: async () => {}, holdWorks: () => false,
    note: (what, detail) => notes.push({ what, ...detail }),
  };
  const record = f => Autopilot.prototype.recordFarmFightOutcome.call(keeper, f, { room: { num: 38, name: 'Castle Victoria' }, v: { health: { max: 149 } } });
  await record({ fought: true, killed: false, target: 'skeleton', target_id: 40, foe_id: 40, rounds: 12, landed_hits: 9,
                 swings: 12, fight_ms: 13100, swing_ms: 1051, started_at: 1000, handed_back: { why: 'cap' },
                 health: { after: { value: 140 } }, note: 'still alive after 12 rounds. ...' });
  await record({ fought: true, killed: true, target: 'skeleton', target_id: 40, foe_id: null, rounds: 4, landed_hits: 4,
                 swings: 4, fight_ms: 4700, swing_ms: 1050, started_at: 15700, health: { after: { value: 139 } }, looted: [] });
  const killed = rows.find(row => row.kind === 'killed');
  ok('the break-off line carries the pace and why it was handed back',
     notes[0].what === 'broke off' && notes[0].swings === 12 && notes[0].fight_ms === 13100 && notes[0].swing_ms === 1051 && notes[0].handed_back === 'cap', notes[0]);
  ok('the killed line carries the pace too', notes[1].what === 'killed' && notes[1].swings === 4 && notes[1].swing_ms === 1050, notes[1]);
  ok('the ledger\'s killed row carries this call and the whole kill',
     killed && killed.rounds === 4 && killed.swings === 4 && killed.fight_ms === 4700 && killed.swing_ms === 1050 &&
     killed.kill_calls === 2 && killed.kill_rounds === 16 && killed.kill_swings === 16 && killed.kill_ms === 19400, killed);
  await record({ fought: true, killed: true, target: 'zombie', target_id: 41, foe_id: null, rounds: 6, landed_hits: 5,
                 swings: 6, fight_ms: 6800, swing_ms: 1052, started_at: 30000, health: { after: { value: 139 } }, looted: [] });
  ok('and the next quarry starts its own count', (row => row.kill_calls === 1 && row.kill_rounds === 6 && row.kill_ms === 6800)(rows.filter(row => row.kind === 'killed')[1]), rows[rows.length - 1]);

  const farm = readToolSource(new URL('./autopilot/pass-farm.mjs', import.meta.url));
  ok('the farm fight is called with the press and its gate', /rounds: alternate \? 1 : training\.rounds,\s*\n\s*\.\.\.press,/.test(farm), 'pass-farm.mjs fight() options');
  const combat = readToolSource(new URL('./autopilot/pass-combat.mjs', import.meta.url));
  ok('a fight-back kill row carries the pace as well', /fought_back: true \}\), \.\.\.paceFields\(f\)/.test(combat));
  const process_ = readToolSource(new URL('./m59-keeper-process.mjs', import.meta.url));
  ok('the keeper process\'s fight verb stops on a stale exchange and reports the whole fight, not its last burst',
     /if \(lastR\?\.stale\) break;/.test(process_) &&
     /\.\.\.\(lastR \?\? \{\}\),[\s\S]{0,400}\.\.\.swingPace\(swingAt\), swing_at: undefined, turns, polls \}\);/.test(process_));
}

mock.timers.reset();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
