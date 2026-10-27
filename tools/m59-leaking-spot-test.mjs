#!/usr/bin/env node
// SCOOTER, KO'CATAN 2125, 2026-10-27 16:20: PINNED TO A SPOT THAT HAD ALREADY FAILED, WITH THE EXIT UNDER HIS FEET.
//
//   node tools/m59-leaking-spot-test.mjs
//
// Offline: no socket, no roster; healing-session files go to a temp dir; the room is the real 2125 geometry from
// substrate/m59-map.json. The postmortem (substrate/postmortems/Scooter-2026-10-27T16-20-06-094Z.json, prod) read:
//
//   16:14:21  the healing session's ONE logoff ("breaking out of a crowded safe spot"); healed to 94/94 in the East
//             Tower by 16:15:35, but a session closes only at full health 5 min after its logoff, so it stayed open
//   16:16:53  back in 2125 at 94/94; farms dragonflies from hold r17c1 -- which is also the stand square of the west
//             edge exit to 2115 (World.exits: steps_away 1, "cross west")
//   16:18:46  a survival episode at 77/94; rest_safe at r17c1; a dragonfly at r16c1 hits him while he rests, so the
//             rest is recorded as failed (noteFailedRestSpot) and currentRecoveryWall stops naming r17c1
//   16:19:12 -> 16:20:04  once a second: rest_safe -> "recovery is no longer at a safe wall" -> nearest_refuge to a wall
//             27 steps away through the swarm -> object_blocked -> logoff_open -> refused (spent session) -> sessionSpotHere
//             says "on the held square" -> rest_safe again. Every pass ended inside continueSurvivalDecision (all 48
//             frames: stage continueSurvivalDecision), so the ladder never ran: 79 s without a swing, 11 hits for 100.
//   16:20:04  knocked to r16c2, sessionSpotHere finally false, leave_room toward 2115 -- at 7/94. Killed while zoning.
//
// What this pins:
//   1. one answer to "will this keeper rest on this square" (restSpotRefused), read alike by the dispatcher and by the
//      healing session's "is this the spot";
//   2. a failed spot is not the session's spot: the refusal moves the body -- the exit, in this room -- on the first
//      cycle, not after 80 s; and the failed hold is given up;
//   3. a working spot is still kept: one logoff per session, then sit still on the spot (the operator's rule);
//   4. a refused logoff turned into a rest the dispatcher will not take is not "handled": the ladder gets the pass;
//   5. never a second logoff, in any of it.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.M59_HEALING_DIR = mkdtempSync(join(tmpdir(), 'm59-leaking-'));

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};

const H = await import('./m59-healing-session.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');
const { sharedRoomGeometry } = await import('./m59-roo.mjs');
const { World } = await import('./m59-world.mjs');
const { attachSurvivalDecisions, chooseSurvivalDecision, currentSurvivalDecision, survivalDecisionSnapshot } =
  await import('./m59-survival-decision.mjs');

const map = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url), 'utf8'));
const ROOM = map.rooms['2125'];
const GEO = sharedRoomGeometry(ROOM);
// kocatan-dragonflies' confinement, as the keeper log printed it at 15:05:08Z.
const CONFINE = [2125, 2115, 2013, 2000, 2001, 2002, 2003, 2004, 2005, 2006, 2008, 2009];
const MONSTER = 0x60009, GUILDMATE = 0xF800220D;   // the two flag words in the postmortem's threat rows
const HOLD = { room: 2125, row: 17, col: 1, proven: true };

// A keeper standing where Scooter stood at 16:19:38: real geometry, real exits, real survival dispatcher, real playDead,
// real refuge/exit code. Faked: the wire (travel, reconnect) and the refuge walk itself, which in the room failed
// object_blocked on its first step every time.
function scooter({ name, self = { row: 17, col: 1, x: 97, y: 1090 }, hold = { ...HOLD }, bodies = null, travelAnswer = null } = {}) {
  const calls = { reconnect: 0, travel: [], refugeWalks: 0, notes: [], progress: [] };
  const health = { value: 22, max: 94 };
  const objects = new Map();
  for (const [id, row, col, flags, n] of bodies ?? [[15815, 16, 1, MONSTER, 'dragonfly'], [15763, 15, 2, MONSTER, 'dragonfly'],
    [15803, 15, 3, MONSTER, 'dragonfly'], [4460, 16, 2, GUILDMATE, 'Sweetums']])
    objects.set(id, { id, row, col, flags, name: n, nameRsc: n });
  const c = { state: 'game', selfId: 1, self: { id: 1, ...self }, room: { id: ROOM.objId, objects },
              roomNameRsc: ROOM.nameRsc, roomRsc: ROOM.roomRsc,
              vitals: () => ({ health, vigor: { value: 194, max: 200 } }), rsc: { get: x => x }, ailments: () => [] };
  const world = new World(c, map);
  const s = { name, client: c, live: true, movementGeneration: 11, combat: null,
              world: { room: { num: 2125, name: 'Into the Jungle', los: 0 }, geometry: GEO, exits: () => world.exits() },
              cancelMovement: () => ({ cancelled: true }) };
  const k = Object.assign(Object.create(Autopilot.prototype), {
    s, hold, policy: { confineRooms: CONFINE, restBelow: 0.8, fleeBelow: 0.45 }, passes: 360, tally: {},
    note: (w, d) => calls.notes.push({ w, d }), progress: w => calls.progress.push(w), noProgress() {},
    operatorSurvivalStandDown: () => false, playerThreatPresent: () => false, facultyHeld: () => false,
    checkFreeze: () => false, armedForSure: () => true, inReachOfUs: () => [objects.get(15815)].filter(Boolean),
    blinkPastSurvivalJam: async () => false, escapeIfWedgedAndHurt: async () => false,
    lureSparedBlocker: async () => false, tradeInPlaceIfWedged: async () => false,
    rememberSurvivalJam: () => null, survivalJam: () => null, observeBlockerLure: () => {},
    hitDamageTotal: () => 0, unreachableIn: () => null, safety: () => ({ fleeAt: 60 / 94, engageAt: 0.75 }),
    reconnect: async () => { calls.reconnect++; return { ok: true }; },
    suspendJourney: () => { throw new Error('playDead went past the one-logoff gate'); },
    // The refuge walk as it ran in 2125: a wall 27 steps away, blocked by a body on the first step.
    takeSafeSpotObserved: async () => { calls.refugeWalks++; return { took: false, why: 'object_blocked' }; },
    travel: async (room, opts) => {
      calls.travel.push({ room, origin: opts?.origin, maxHops: opts?.maxHops });
      const r = travelAnswer?.(room, s) ?? { arrived: false, reason: 'object_blocked' };
      return r;
    } });
  attachSurvivalDecisions(s, { onCancel: (why, d) => k.replacementSurvivalChoice(why, d), epoch: 'test' });
  return { k, s, c, calls, health, objects };
}
const strategies = s => survivalDecisionSnapshot(s).history.map(h => h.strategy);
// The decision playDead had installed at 16:19:38 (survival_decisions.history, row 0).
const REST_PINNED = { strategy: 'rest_safe', status: 'recovering', reason: 'object_blocked',
  reason_code: 'one_logoff_per_session', mitigation: 'already logged off once this healing session; heal here to full' };

console.log('the room as it was: the hold is the exit square, and the geometry calls it a wall');
{
  const { k } = scooter({ name: 'room-check' });
  const out = k.s.world.exits().find(e => e.to === 2115);
  ok('the west edge exit to 2115 stands on r17c1 -- the hold itself', out?.stand_on?.row === 17 && out?.stand_on?.col === 1
     && out.steps_away <= 1, JSON.stringify(out?.stand_on));
  ok('2115 is inside the strategy\'s confinement', H.spentSessionExit(k.s.world.exits(), { here: 2125, confine: CONFINE })?.to === 2115);
  ok('the coarse formula calls r17c1 a safe wall (no attacker square) although a dragonfly hit him there',
     k.wallHere()?.ok === true && k.currentRecoveryWall()?.row === 17, JSON.stringify(k.wallHere()));
}

console.log('one answer to "will this keeper rest on this square" (restSpotRefused)');
{
  const { k } = scooter({ name: 'one-answer' });
  ok('a clean wall: neither reader refuses it', k.restSpotRefused(HOLD) === null && !!k.currentRecoveryWall()
     && k.sessionSpotHere() === true);
  k.noteFailedRestSpot(2125, 1, 17);
  ok('after a rest there was attacked: restSpotRefused says rest_failed', k.restSpotRefused(HOLD) === 'rest_failed');
  ok('...the dispatcher will not rest there', k.currentRecoveryWall() === null);
  ok('...and the healing session no longer calls it the spot (THE DISAGREEMENT THAT CYCLED)', k.sessionSpotHere() === false);
  ok('the record expires with the same TTL as before', k.restSpotRefused(HOLD, Date.now() + 6 * 60_000) === null);

  const occ = scooter({ name: 'occupied', bodies: [[15815, 17, 1, MONSTER, 'dragonfly']] });
  ok('a monster ON the square: both refuse', occ.k.restSpotRefused(HOLD) === 'occupied' && occ.k.currentRecoveryWall() === null
     && occ.k.sessionSpotHere() === false);
  const mate = scooter({ name: 'mate', bodies: [[4460, 17, 1, GUILDMATE, 'Sweetums']] });
  ok('a fleet-mate on it is not a monster on it', mate.k.restSpotRefused(HOLD) === null && mate.k.sessionSpotHere() === true);
  const elsewhere = scooter({ name: 'elsewhere' });
  elsewhere.k.noteFailedRestSpot(2125, 2, 16);
  ok('a failed rest on ANOTHER square says nothing about this one', elsewhere.k.sessionSpotHere() === true);
}

console.log('16:19:38 replayed: the cycle that ended every pass now leaves by the exit on its first turn');
{
  const { k, s, calls } = scooter({ name: 'scooter-1620',
    travelAnswer: (room, s) => { s.world.room = { num: room, name: 'Outside the Guard Tower' }; return { arrived: true }; } });
  H.noteLogoff('scooter-1620', { why: 'breaking out of a crowded safe spot', room: 2125 });
  k.noteFailedRestSpot(2125, 1, 17);                 // the rest at 16:18:48 that a dragonfly interrupted
  chooseSurvivalDecision(s, { ...REST_PINNED, chosen_refuge: { ...HOLD } });
  await k.continueSurvivalDecision();
  const seq = strategies(s);
  ok('it walked the refuge once (blocked, as in the room) and then left: rest_safe -> nearest_refuge -> logoff_open -> leave_room',
     seq.join('>') === 'rest_safe>nearest_refuge>logoff_open>leave_room' && calls.refugeWalks === 1, seq.join('>'));
  ok('the exit it took is 2115, one hop, under the survival-exit origin', calls.travel.length === 1 && calls.travel[0].room === 2115
     && calls.travel[0].maxHops === 1 && calls.travel[0].origin?.source === 'keeper', JSON.stringify(calls.travel));
  ok('the body left and that is recorded as left_room and as progress', survivalDecisionSnapshot(s).history.at(-1)?.outcome === 'left_room'
     && calls.progress.length === 1, JSON.stringify({ out: survivalDecisionSnapshot(s).history.at(-1)?.outcome, progress: calls.progress }));
  ok('no rest_safe was re-pinned on the failed square', !seq.slice(1).includes('rest_safe'));
  ok('the failed hold was given up, so nothing downstream reads it as a working wall', k.hold == null);
  ok('and no second logoff', calls.reconnect === 0);
}

console.log('...and when the exit is blocked too, the pass is the ladder\'s, and the exit is not re-walked every pass');
{
  const { k, s, calls } = scooter({ name: 'scooter-blocked' });
  H.noteLogoff('scooter-blocked', { why: 'breaking out of a crowded safe spot', room: 2125 });
  k.noteFailedRestSpot(2125, 1, 17);
  chooseSurvivalDecision(s, { ...REST_PINNED, chosen_refuge: { ...HOLD } });
  const first = await k.continueSurvivalDecision();
  ok('a failed exit does not claim the pass', first === false && calls.travel.length === 1, JSON.stringify({ first, travel: calls.travel.length }));
  let claimed = 0;
  for (let p = 0; p < 10; p++) {
    chooseSurvivalDecision(s, { ...REST_PINNED, chosen_refuge: { ...HOLD } });
    if (await k.continueSurvivalDecision()) claimed++;
  }
  ok('ten more passes with the same pinned rest: none ends before the ladder', claimed === 0, String(claimed));
  ok('the exit is walked once per window, not every pass', calls.travel.length === 1, String(calls.travel.length));
  ok('still no second logoff', calls.reconnect === 0);
}

console.log('the operator\'s rule stands: on a spot that works, one logoff, then sit still on it');
{
  const { k, s, calls } = scooter({ name: 'working-spot', bodies: [[15763, 15, 2, MONSTER, 'dragonfly']] });
  H.noteLogoff('working-spot', { why: 'logging off rather than dying', room: 2125 });
  chooseSurvivalDecision(s, { strategy: 'logoff_safe', status: 'pending', reason: 'at 22/94 on a safe wall',
                              chosen_refuge: { ...HOLD } });
  const did = await k.playDead('at 22/94 on a safe wall');
  const d = currentSurvivalDecision(s);
  ok('refuses the second logoff and keeps the spot (rest_safe at r17c1)', did === false && d?.strategy === 'rest_safe'
     && d.status === 'recovering' && k.hold?.row === 17 && k.hold?.col === 1, JSON.stringify({ did, d: d?.strategy }));
  ok('nothing walks: no refuge, no exit', calls.travel.length === 0 && calls.refugeWalks === 0);
  ok('and no reconnect', calls.reconnect === 0);
  chooseSurvivalDecision(s, { strategy: 'logoff_safe', status: 'pending', reason: 'hit again', chosen_refuge: { ...HOLD } });
  const step = await k.continueSurvivalDecisionStep();
  ok('the dispatcher still owns that pass: the rest it was handed can be taken here', step === true
     && currentSurvivalDecision(s)?.strategy === 'rest_safe', String(step));
}

console.log('a refused logoff turned into a rest the dispatcher will not take is not "handled"');
{
  // The class, not the site: on the held square, nothing against the square, but not a square the dispatcher rests on
  // (r17c2: two attacker squares by the formula). Before, rest_safe went in, the dispatcher bounced it to a refuge
  // walk next pass, the walk failed, the logoff was refused, rest_safe went in -- and the pass was claimed every time.
  const { k, s, calls } = scooter({ name: 'not-a-wall', self: { row: 17, col: 2, x: 160, y: 1100 },
                                    hold: { room: 2125, row: 17, col: 2, proven: true } });
  H.noteLogoff('not-a-wall', { why: 'doomed', room: 2125 });
  ok('(the square is not one the dispatcher rests on)', k.currentRecoveryWall() === null && k.sessionSpotHere() === true);
  chooseSurvivalDecision(s, { strategy: 'logoff_open', status: 'pending', replan_count: 2, reason: 'object_blocked',
                              reason_code: 'approach_interrupted' });
  const claimed = await k.continueSurvivalDecision();
  ok('the pass goes to the ladder', claimed === false, String(claimed));
  ok('the rest stays the decision for the next pass to re-plan from', currentSurvivalDecision(s)?.strategy === 'rest_safe');
  ok('no second logoff', calls.reconnect === 0);
}

console.log('cornered below the flee line, the fight-back no longer steps aside for a flee that is not there');
{
  // passFightBack as the ladder would run it at 16:19:50 if the exit had been tried and blocked (the dragonfly on r16c1
  // stood on the exit's own fine stand): 20/94 against a flee line of 60, hold given up, an attack episode under way.
  const { CONTINUE, HANDLED } = await import('./m59-autopilot.mjs');
  const { SPENT_EXIT_RETRY_MS } = H;
  function cornerRig({ name, spent = true, exitAgoMs = 2_000, exitRoom = 2125, hp = 20, attackAgoMs = 3_000, edict = 10_000,
                       failed = true, hold = null } = {}) {
    const t = scooter({ name, hold });
    if (spent) H.noteLogoff(name, { why: 'breaking out of a crowded safe spot', room: 2125 });
    if (failed) t.k.noteFailedRestSpot(2125, 1, 17);
    if (exitAgoMs != null) t.k._spentExitTried = { room: exitRoom, at: Date.now() - exitAgoMs };
    const fights = [];
    Object.assign(t.k, {
      policy: { ...t.k.policy, fightBackAfterMs: edict || undefined, fightRounds: 10 },
      watch: { attack: { since: Date.now() - attackAgoMs, hits: 3, lost: 25, lastHitAt: Date.now() - 400 } },
      refuseEngagement: () => null, sparedHere: () => false, touchTrainingHere: () => false,
      weaponPriorityNow: () => [], bannedWeaponsNow: () => [], ledgerEvent: () => {}, farmStrategyHook: () => {},
      countLoot: () => {}, wearLootedArmour: async () => {}, inert: null, mode: 'farm',
      fightNow: async opts => { fights.push(opts); return { fought: true, killed: false, landed_hits: 1, rounds: 1 }; },
    });
    t.health.value = hp;
    const ctx = { s: t.s, c: t.c, room: t.s.world.room, v: t.c.vitals(), hp: hp / 94 };
    return { ...t, fights, run: () => t.k.passFightBack(ctx) };
  }
  const a = cornerRig({ name: 'corner-a' });
  ok('(cornered: logoff spent, exit just tried from here, no recovery wall)', a.k.spentAndCornered() === true);
  const out = await a.run();
  ok('it swings at what is hitting it', out === HANDLED && a.fights.length === 1 && a.fights[0].target === 'dragonfly',
     JSON.stringify(a.fights[0] ?? null));
  ok('one exchange, no disengage line, holding its square', a.fights[0]?.rounds === 1 && a.fights[0]?.disengageAt === 0
     && a.fights[0]?.holdPosition === true);
  ok('without waiting out the edict window again (3 s into the episode against a 10 s edict)', a.fights.length === 1);
  ok('and it is never a logoff', a.calls.reconnect === 0);

  for (const [label, opts] of [
    ['the exit has not been tried yet: the flee (the exit) outranks it', { exitAgoMs: null }],
    ['a logoff is still available this session: that outranks it', { spent: false }],
    ['the exit was tried from ANOTHER room', { exitRoom: 2115 }],
    ['the exit try is older than its retry window: the dispatcher will try it again first', { exitAgoMs: SPENT_EXIT_RETRY_MS + 1_000 }],
    ['standing on a working recovery wall: resting there is the answer', { failed: false, hold: { ...HOLD } }],
    ['no fight-back edict on this character: the opt-in is respected', { edict: 0 }],
  ]) {
    const r = cornerRig({ name: 'corner-' + label.slice(0, 12).replace(/\W/g, '') + Math.random().toString(36).slice(2, 6), ...opts });
    const res = await r.run();
    ok(label, res === CONTINUE && r.fights.length === 0, String(res?.toString?.() ?? res));
  }

  const above = cornerRig({ name: 'corner-above', hp: 80, exitAgoMs: null, attackAgoMs: 3_000 });
  ok('above the flee line the edict window still applies (3 s of a 10 s edict: no swing yet)',
     await above.run() === CONTINUE && above.fights.length === 0);
  const above2 = cornerRig({ name: 'corner-above2', hp: 80, exitAgoMs: null, attackAgoMs: 12_000 });
  const out2 = await above2.run();
  ok('...and once it has, the ordinary fight-back: ten rounds, disengaging at the flee line', out2 === HANDLED
     && above2.fights[0]?.rounds === 10 && Math.abs(above2.fights[0]?.disengageAt - 60 / 94) < 1e-9, JSON.stringify(above2.fights[0] ?? null));
}

console.log('never a second logoff, across every square and decision here');
{
  let reconnects = 0, runs = 0;
  const squares = [
    { label: 'failed hold', failed: true },
    { label: 'occupied hold', bodies: [[15815, 17, 1, MONSTER, 'dragonfly']] },
    { label: 'working hold' },
    { label: 'no wall hold', self: { row: 17, col: 2, x: 160, y: 1100 }, hold: { room: 2125, row: 17, col: 2, proven: true } },
    { label: 'no hold', hold: null },
  ];
  const decisions = [
    { strategy: 'logoff_open', status: 'pending', replan_count: 0 }, { strategy: 'logoff_open', status: 'pending', replan_count: 2 },
    { strategy: 'logoff_safe', status: 'pending' }, { ...REST_PINNED },
  ];
  for (const sq of squares) for (const dec of decisions) for (const exitOk of [false, true]) {
    const name = `combo-${runs++}`;
    const t = scooter({ name, self: sq.self, hold: sq.hold === undefined ? { ...HOLD } : sq.hold, bodies: sq.bodies,
      travelAnswer: exitOk ? (room, s) => { s.world.room = { num: room }; return { arrived: true }; } : null });
    H.noteLogoff(name, { why: 'doomed', room: 2125 });
    if (sq.failed) t.k.noteFailedRestSpot(2125, 1, 17);
    chooseSurvivalDecision(t.s, { ...dec, reason: 'combo', chosen_refuge: dec.strategy === 'rest_safe' ? t.k.hold : null });
    for (let p = 0; p < 3; p++) { await t.k.continueSurvivalDecision().catch(() => null); await t.k.playDead('combo').catch(() => null); }
    reconnects += t.calls.reconnect;
  }
  ok(`${runs} combinations, three passes each: zero reconnects`, reconnects === 0, String(reconnects));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
