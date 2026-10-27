#!/usr/bin/env node
// SCOOTER, KO'CATAN 2115, 2026-10-27: PULLED OFF HIS HEALING SPOT, THEN STRANDED ON A LOGOFF NOBODY WOULD CARRY OUT.
//
//   node tools/m59-scooter-stranded-test.mjs
//
// Offline: no socket, no roster; the healing-session files go to a temp dir. The postmortem
// (substrate/postmortems/Scooter-2026-10-27T13-12-57-493Z.json, prod) read, in order:
//
//   13:08:12  the healing session's ONE logoff, at 74/94 on wall r12c19
//   13:10:36  pass 1044: passFleeAndRest takes wall r17c11 ("a wall before a rest", rest_safe "heal here to full"),
//             then its rest gate, asked with `sheltered`/`testing` read BEFORE the wall was taken, says "the open, a
//             combat zone", the stage returns CONTINUE, and passFarm PULLS from the new wall at 74/94
//   13:10:43  "could not get back after a failed pull" -- the hold released, the body at r11c18 among the avars
//   13:10:44  refuge search: "nothing in this room is more defensible than open floor"; replacement logoff_open;
//             playDead refuses it (one logoff per session -- correct) and installs nothing (its only replacement
//             was rest_safe, and that needed a hold), so the logoff stays PENDING
//   13:10:44 -> 13:12:57  133 passes, every one ended at the top of passOnce: continueSurvivalDecisionStep reported
//             the refused playDead as handled, the unchanged decision made continueSurvivalDecision return true, and
//             the ladder -- passFightBack (due five times), passFleeAndRest's leave-to-recover rung toward 2013,
//             passFarm's fight -- never ran. The watchdog saw no blocked pass (each took milliseconds) and the
//             postmortem's `blocked_in: passFarm 139621ms` named a rung that had returned two minutes earlier.
//
// What this pins, one block per defect:
//   1. a wall taken in passFleeAndRest is rested at on the same pass (the gate is asked with the wall it now holds);
//   2. a refused logoff off a spot is replaced by something that MOVES (nearest refuge, then out by a permitted exit),
//      and the operator's rule stands: still exactly one logoff per healing session;
//   3. the dispatcher never claims a pass on a decision it did not carry out -- the ladder gets it;
//   4. the pass names where it is, so a postmortem cannot blame a rung that already returned.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.M59_HEALING_DIR = mkdtempSync(join(tmpdir(), 'm59-scooter-'));

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};

const H = await import('./m59-healing-session.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');
const { CONTINUE } = await import('./m59-autopilot.mjs');
const { OF } = await import('./m59-parse.mjs');
const { World } = await import('./m59-world.mjs');
const { attachSurvivalDecisions, chooseSurvivalDecision, currentSurvivalDecision, survivalDecisionSnapshot } =
  await import('./m59-survival-decision.mjs');
const { readToolSource } = await import('./autopilot/source.mjs');

// The decision Scooter died on, as the postmortem recorded it (survival_decisions.history, last row).
const SCOOTER_LAST = {
  strategy: 'logoff_open', status: 'pending', reason_code: 'approach_interrupted', replan_count: 2,
  reason: 'nothing in this room is more defensible than open floor (walls considered 376, reachable from here 16, one-way 12, eligible 347)',
};
const KOCATAN_CONFINE = [2115, 2013, 2000, 2001, 2002, 2003, 2004, 2005, 2006, 2008, 2009];

console.log('what a refused logoff becomes (spentLogoffReplacement)');
{
  const leave = H.spentLogoffReplacement({ active: SCOOTER_LAST, onSpot: false });
  ok('Scooter\'s last decision, off any spot after a failed refuge search: leave the room', leave?.strategy === 'leave_room',
     JSON.stringify(leave));
  const first = H.spentLogoffReplacement({ active: { strategy: 'logoff_open', status: 'pending', replan_count: 0 } });
  ok('a logoff no refuge search has failed for yet: flee to the nearest reachable spot first', first?.strategy === 'nearest_refuge'
     && first.replan_count >= 1, JSON.stringify(first));
  ok('so a failed refuge after it is re-planned to logoff_open and then out, not round again',
     H.spentLogoffReplacement({ active: { strategy: 'logoff_open', status: 'pending', replan_count: first.replan_count + 1 } })
       ?.strategy === 'leave_room');
  ok('a pending logoff_safe off its wall flees too', H.spentLogoffReplacement({ active: { strategy: 'logoff_safe', status: 'pending' } })
       ?.strategy === 'nearest_refuge');
  const again = H.spentLogoffReplacement({ active: SCOOTER_LAST, exitTriedRecently: true });
  ok('the exit was just tried from here: end the decision so the ladder decides', again?.finish === true && !again.strategy,
     JSON.stringify(again));
  ok('on its spot: nothing replaces the rest (the caller keeps the spot and heals)',
     H.spentLogoffReplacement({ active: SCOOTER_LAST, onSpot: true }) === null);
  ok('no pending logoff and no hold: nothing was stranded, nothing is installed',
     H.spentLogoffReplacement({ active: null }) === null
     && H.spentLogoffReplacement({ active: { strategy: 'nearest_refuge', status: 'pending' } }) === null);
  ok('a hold the body has lost is not pinned with "rest here": it flees',
     H.spentLogoffReplacement({ active: null, hadHold: true })?.strategy === 'nearest_refuge');
  ok('...unless an approach is already under way, which it does not clobber',
     H.spentLogoffReplacement({ active: { strategy: 'nearest_refuge', status: 'approaching' }, hadHold: true }) === null);
  const all = [];
  for (const strategy of ['logoff_open', 'logoff_safe', 'nearest_refuge', 'rest_safe', null])
    for (const status of ['pending', 'approaching', 'recovering'])
      for (const replan_count of [0, 1, 2, 5])
        for (const hadHold of [false, true])
          for (const exitTriedRecently of [false, true])
            all.push(H.spentLogoffReplacement({ active: strategy ? { strategy, status, replan_count } : null, hadHold, exitTriedRecently }));
  ok('and it never answers a logoff, in any combination (one logoff per healing session)',
     all.every(r => r === null || r.finish === true || !/logoff/.test(r.strategy)), String(all.length));
}

console.log('which way out (spentSessionExit), on the real 2115 geometry from Scooter\'s square r11c18');
{
  const map = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url), 'utf8'));
  const r = map.rooms['2115'];
  const c = { roomNameRsc: r.nameRsc, roomRsc: r.roomRsc, room: { id: r.objId, objects: new Map() },
              self: { row: 11, col: 18, x: 1198, y: 753 }, selfId: 1 };
  const exits = new World(c, map).exits();
  const to = exits.map(e => e.to);
  ok('the room has an exit into the East Tower (2013) and a nearer one into the jungle (2114)',
     to.includes(2013) && to.includes(2114), JSON.stringify(to));
  const out = H.spentSessionExit(exits, { here: 2115, confine: KOCATAN_CONFINE });
  ok('confined like the strategy, it leaves for the guard tower, 2013', out?.to === 2013, JSON.stringify(out?.to));
  ok('...by a square the map says to stand on', Number.isFinite(out?.stand_on?.row) && Number.isFinite(out?.stand_on?.col));
  ok('unconfined, the nearest exit', H.spentSessionExit(exits, { here: 2115 })?.to === 2114);
  ok('a confinement with no exit out of here answers null rather than leaving it',
     H.spentSessionExit(exits, { here: 2115, confine: [2115, 2000] }) === null);
  ok('never the Underworld, never this room, never an unreachable one',
     H.spentSessionExit([{ to: 1, steps_away: 1 }, { to: 2115, steps_away: 1 }, { to: 2013, steps_away: 2, reachable: false }],
                        { here: 2115 }) === null);
}

// ---------------------------------------------------------------- a keeper standing where Scooter stood
function scooter({ name, hold = null, self = { row: 11, col: 18, x: 1198, y: 753 }, wall = null } = {}) {
  const calls = { reconnect: 0, travel: [], notes: [], progress: [] };
  const health = { value: 82, max: 94 };
  const objects = new Map();
  for (const [id, row, col] of [[14981, 11, 17], [14758, 11, 19], [14819, 12, 20], [14970, 11, 21]])
    objects.set(id, { id, row, col, flags: OF.ATTACKABLE, name: 'peet-seeeep avar warrior' });
  const c = { state: 'game', selfId: 1, self: { id: 1, ...self }, room: { id: 1091, objects },
              vitals: () => ({ health, vigor: { value: 198, max: 200 } }), rsc: { get: x => x }, ailments: () => [] };
  const s = { name, client: c, live: true, movementGeneration: 19, combat: null,
              world: { room: { num: 2115, name: 'Outside the Guard Tower' }, exits: () => [
                { kind: 'edge', to: 2114, stand_on: { row: 2, col: 23 }, steps_away: 13, reachable: true },
                { kind: 'go', to: 2013, stand_on: { row: 46, col: 24 }, steps_away: 35, reachable: true }] },
              cancelMovement: () => ({ cancelled: true }) };
  const k = Object.assign(Object.create(Autopilot.prototype), {
    s, hold, policy: { confineRooms: KOCATAN_CONFINE, restBelow: 0.8, fleeBelow: 0.45 }, passes: 1100, tally: {},
    note: (w, d) => calls.notes.push({ w, d }), progress: w => calls.progress.push(w), noProgress() {},
    operatorSurvivalStandDown: () => false, playerThreatPresent: () => false, facultyHeld: () => false,
    currentRecoveryWall: () => wall, adoptRecoveryWall() { if (!wall) return false; this.hold = { room: 2115, ...wall, proven: true }; return true; },
    checkFreeze: () => false, armedForSure: () => true, inReachOfUs: () => [...objects.values()],
    blinkPastSurvivalJam: async () => false, escapeIfWedgedAndHurt: async () => false,
    lureSparedBlocker: async () => false, tradeInPlaceIfWedged: async () => false,
    rememberSurvivalJam: () => null, survivalJam: () => null, observeBlockerLure: () => {},
    hitDamageTotal: () => 0, unreachableIn: () => null, safety: () => ({ fleeAt: 60 / 94, engageAt: 0.75 }),
    reconnect: async () => { calls.reconnect++; return { ok: true }; },
    suspendJourney: () => { throw new Error('playDead went past the one-logoff gate'); },
    travel: async (room, opts) => { calls.travel.push({ room, origin: opts?.origin }); return calls.travelAnswer?.(room) ?? { arrived: false, reason: 'object_blocked' }; } });
  attachSurvivalDecisions(s, { onCancel: (why, d) => k.replacementSurvivalChoice(why, d), epoch: 'test' });
  return { k, s, c, calls, health };
}

console.log('the refusal moves the body, and it is still one logoff (playDead inside a spent session)');
{
  const { k, s, calls } = scooter({ name: 'scooter-a' });
  H.noteLogoff('scooter-a', { why: 'logging off rather than dying', room: 2115 });
  chooseSurvivalDecision(s, SCOOTER_LAST);
  const did = await k.playDead(SCOOTER_LAST.reason).catch(e => 'THREW ' + e.message);
  const d = currentSurvivalDecision(s);
  ok('it refuses the second logoff', did === false && calls.reconnect === 0, JSON.stringify({ did, reconnects: calls.reconnect }));
  ok('and the logoff it refused is no longer the decision: it is leave_room, pending', d?.strategy === 'leave_room'
     && d.status === 'pending', JSON.stringify({ strategy: d?.strategy, status: d?.status }));
  ok('the refused logoff is recorded as refused, not as anything that happened',
     survivalDecisionSnapshot(s).history.at(-1)?.outcome === 'refused');

  const b = scooter({ name: 'scooter-b' });
  H.noteLogoff('scooter-b', { why: 'doomed' });
  chooseSurvivalDecision(b.s, { strategy: 'logoff_safe', status: 'pending', reason: 'pushed off the wall' });
  await b.k.playDead('pushed off the wall');
  ok('no refuge tried yet: the nearest reachable spot', currentSurvivalDecision(b.s)?.strategy === 'nearest_refuge'
     && b.calls.reconnect === 0);

  const cOn = scooter({ name: 'scooter-c', hold: { room: 2115, row: 11, col: 18, proven: true } });
  H.noteLogoff('scooter-c', { why: 'doomed' });
  await cOn.k.playDead('hit again on the spot');
  ok('ON its spot it keeps the spot and heals, as before (rest_safe)', currentSurvivalDecision(cOn.s)?.strategy === 'rest_safe'
     && cOn.calls.reconnect === 0);

  const dWall = scooter({ name: 'scooter-d', wall: { row: 11, col: 18, ok: true } });
  H.noteLogoff('scooter-d', { why: 'doomed' });
  await dWall.k.playDead('standing on a recovery wall with no hold');
  ok('standing on a recovery wall with no hold: adopts it and rests there', currentSurvivalDecision(dWall.s)?.strategy === 'rest_safe'
     && dWall.k.hold?.row === 11);

  const eLost = scooter({ name: 'scooter-e', hold: { room: 2115, row: 17, col: 11, proven: true } });
  H.noteLogoff('scooter-e', { why: 'doomed' });
  await eLost.k.playDead('at 60% with 4 adjacent');
  ok('a hold the body was pulled off is not pinned with "rest here" (r17c11 while standing at r11c18): it flees',
     currentSurvivalDecision(eLost.s)?.strategy === 'nearest_refuge', currentSurvivalDecision(eLost.s)?.strategy);

  // Scooter's trace carried `predicted: true` on every position after the pull; that is still a position.
  const fPred = scooter({ name: 'scooter-e2', hold: { room: 2115, row: 17, col: 11, proven: true },
                          self: { row: 11, col: 18, x: 1198, y: 753, predicted: true } });
  H.noteLogoff('scooter-e2', { why: 'doomed' });
  await fPred.k.playDead('at 60% with 4 adjacent');
  ok('...and a PREDICTED position nine squares off the hold counts as off it', currentSurvivalDecision(fPred.s)?.strategy === 'nearest_refuge');
  const gNone = scooter({ name: 'scooter-e3', hold: { room: 2115, row: 17, col: 11, proven: true }, self: {} });
  H.noteLogoff('scooter-e3', { why: 'doomed' });
  await gNone.k.playDead('position unknown');
  ok('with no position at all the hold is trusted, as before (rest_safe)', currentSurvivalDecision(gNone.s)?.strategy === 'rest_safe');
}

console.log('the dispatcher gives the pass to the ladder when it carried nothing out');
{
  // THE REGRESSION ITSELF. On 80ee703b this returned TRUE, every pass, for 133 passes.
  const { k, s, calls } = scooter({ name: 'scooter-f' });
  H.noteLogoff('scooter-f', { why: 'logging off rather than dying', room: 2115 });
  chooseSurvivalDecision(s, SCOOTER_LAST);
  const claimed = await k.continueSurvivalDecision();
  ok('Scooter\'s state no longer ends the pass before the ladder', claimed === false, String(claimed));
  ok('it tried the way out the strategy falls back to, 2013, under a keeper origin', calls.travel.length === 1
     && calls.travel[0].room === 2013 && calls.travel[0].origin?.source === 'keeper', JSON.stringify(calls.travel));
  ok('still no second logoff', calls.reconnect === 0);
  ok('and the failed exit is not left standing as an un-executable decision', currentSurvivalDecision(s) == null
     && survivalDecisionSnapshot(s).history.at(-1)?.strategy === 'leave_room'
     && survivalDecisionSnapshot(s).history.at(-1)?.outcome === 'blocked');

  // The next passes: the same refuge chain re-picks logoff_open (replacementSurvivalChoice). None of them may claim
  // the pass, and none may walk the same failed exit again inside the retry window.
  let claimedAgain = 0;
  for (let p = 0; p < 10; p++) {
    chooseSurvivalDecision(s, { ...SCOOTER_LAST });
    if (await k.continueSurvivalDecision()) claimedAgain++;
  }
  ok('ten more passes in the same room: none claimed, so passFightBack and passFleeAndRest get every one',
     claimedAgain === 0, String(claimedAgain));
  ok('the exit is not re-walked every pass (once per window)', calls.travel.length === 1, String(calls.travel.length));
  ok('and still no second logoff', calls.reconnect === 0);

  const g = scooter({ name: 'scooter-g' });
  H.noteLogoff('scooter-g', { why: 'doomed' });
  g.calls.travelAnswer = room => { g.s.world.room = { num: room }; return { arrived: true }; };
  chooseSurvivalDecision(g.s, SCOOTER_LAST);
  await g.k.continueSurvivalDecision();
  const last = survivalDecisionSnapshot(g.s).history.at(-1);
  ok('when the exit works the body leaves, and that is progress', g.calls.travel[0]?.room === 2013
     && last?.outcome === 'left_room' && g.calls.progress.length === 1, JSON.stringify({ last: last?.outcome, progress: g.calls.progress }));

  // THE CLASS, NOT THE SITE: any future path that refuses a pending logoff without replacing it.
  const h = scooter({ name: 'scooter-h' });
  h.k.playDead = async () => false;
  chooseSurvivalDecision(h.s, { strategy: 'logoff_safe', status: 'pending', reason: 'refused by something new' });
  const step = await h.k.continueSurvivalDecisionStep();
  ok('a refused logoff that nothing replaced is ended, and the step says it handled nothing', step === false
     && currentSurvivalDecision(h.s) == null && survivalDecisionSnapshot(h.s).history.at(-1)?.outcome === 'refused');
}

console.log('a wall taken in passFleeAndRest is rested at on the same pass');
{
  // Pass 1044 as it ran: hurt (74/94 against rest_below 0.8), nine avars, no hold, the nearest wall one square away.
  const { k, s, c } = scooter({ name: 'scooter-i', self: { row: 18, col: 11 } });
  const health = { value: 74, max: 94 };
  c.vitals = () => ({ health, vigor: { value: 198, max: 200 } });
  c.equipment = () => ({ known: true, equipped: [{ name: 'long sword' }] });
  const REST_GATE = 'rest gate reached';
  s.need = () => { throw new Error(REST_GATE); };
  Object.assign(k, { mode: 'farm', policy: { ...k.policy, hunt: ['peet-seeeep avar warrior'] }, tally: { rests: 0 },
    farmBuffPass: async () => false, defensiveAnswer: async () => false, leaveForCasters: async () => false,
    sanctuary: () => false, eatToFloor: async () => null, recovered: () => true, restVigorCeiling: () => 0.4,
    restVigorCap: () => 0.4, releaseRestedHold: async () => {}, healObservedFleetmate: async () => {},
    isRoomEnchantPost: () => false, recordHealUse: () => {}, askForHelp: async () => {},
    takeRecoverySpot: async function () { this.hold = { room: 2115, row: 17, col: 11, proven: true, takenAt: Date.now() }; return { took: true }; } });
  const ctx = { s, c, room: s.world.room, v: c.vitals(), hp: 74 / 94 };
  const out = await k.passFleeAndRest(ctx).then(v => v, e => e.message);
  ok('the pass rests at the wall it just took instead of returning CONTINUE to passFarm', out === REST_GATE && out !== CONTINUE,
     typeof out === 'symbol' ? out.toString() : String(out));
  ok('...as a rest: doing "recovering", one rest counted', k.doing === 'recovering' && k.tally.rests === 1,
     JSON.stringify({ doing: k.doing, rests: k.tally.rests }));
}

console.log('the pass names where it is');
{
  const k = Object.assign(Object.create(Autopilot.prototype), { s: { live: true }, passStage: 'passFarm', passStageAt: Date.now() - 139_621 });
  let seen = null;
  k.passOnce = async function () { seen = { stage: this.passStage, age: Date.now() - this.passStageAt }; };
  await k.pass();
  ok('a new pass does not inherit the last pass\'s rung', seen?.stage === 'passOnce' && seen.age < 5_000, JSON.stringify(seen));
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('and the survival dispatcher at the top of passOnce names itself before it can end the pass',
     /this\.passStage='continueSurvivalDecision';this\.passStageAt=Date\.now\(\);\n\s*if \(await this\.continueSurvivalDecision\(\)\) return;/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
