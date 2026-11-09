#!/usr/bin/env node
// ONE PLAY-DEAD LOGOFF PER HEALING SESSION -- offline, no socket, no roster.
//
//   node tools/m59-healing-session-test.mjs
//
// Operator, 2026-10-27: "Only one logoff: After, It just sits still and safe after rotating so it can heal." What this pins
// (m59-healing-session.mjs and the keeper's playDead / survival pass):
//   * repeated doomed triggers inside one session give ONE logoff, then none, however many hits re-arm the old rule;
//   * the session ends only at FULL health, and the next bad moment after that may log off once again;
//   * it is on disk, so a replacement keeper (a handoff) is held to the logoff the old one already spent;
//   * every path that logs off to lose aggro records itself, and the poisoned-relog loop is gone;
//   * inside a spent session the poison shelter does not walk to another spot;
//   * a body that comes back OFF a safe spot (any logoff, cooperative included) never stands still: it flees to the
//     nearest reachable spot, with no second logoff, and stays there.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
process.env.M59_HEALING_DIR = mkdtempSync(join(tmpdir(), 'm59-healing-'));

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};
const H = await import('./m59-healing-session.mjs');

console.log('one logoff a session, any number of triggers');
{
  let logoffs = 0, hp = 30;
  const max = 120, now0 = 1_000_000;
  for (let tick = 0; tick < 40; tick++) {                    // a poison tick or a blow every pass: the old rule re-armed on each
    const now = now0 + tick * 3000;
    H.closeIfHealed('fozzie', { hp, max, now });
    if (H.mayLogoff('fozzie', { now })) { H.noteLogoff('fozzie', { why: 'doomed', now }); logoffs++; }
    hp = Math.max(1, hp - 2);
  }
  ok('forty doomed triggers: exactly one logoff', logoffs === 1, String(logoffs));
  ok('the session says so', H.readSession('fozzie', { now: now0 + 120_000 })?.logoffs === 1);
  H.closeIfHealed('fozzie', { hp: 119, max, now: now0 + 200_000 });
  ok('one short of full: the session is still open, no logoff', !H.mayLogoff('fozzie', { now: now0 + 200_000 }));
  H.closeIfHealed('fozzie', { hp: 120, max, now: now0 + 300_000 });
  ok('at full health the session ends', H.readSession('fozzie', { now: now0 + 300_000 }) === null && H.mayLogoff('fozzie', { now: now0 + 300_000 }));
  H.noteLogoff('fozzie', { why: 'doomed again', now: now0 + 400_000 });
  ok('the next bad moment opens a new session with its own one logoff', !H.mayLogoff('fozzie', { now: now0 + 401_000 }));
  ok('an unreadable health does not close a session', H.closeIfHealed('fozzie', { hp: null, max: null, now: now0 + 402_000 }) !== null);
  ok('a session older than the cap is stale, not trusted for ever', H.mayLogoff('fozzie', { now: now0 + 400_000 + H.SESSION_MAX_MS + 1 }));
}

console.log('a logoff at FULL health is still the session\'s one logoff');
{
  // Prod 2026-10-27, Robin (t8), room 599, 79/79: "logging off rather than dying" at 06:56:27, a crowded-spot breakout at
  // 06:57:35, hit-while-resting at 06:58:31 -- three logoffs in two minutes. Each session was closed by the next pass's
  // full-health reading.
  const t0 = 50_000_000;
  H.noteLogoff('robin', { why: 'logging off rather than dying', now: t0 });
  H.closeIfHealed('robin', { hp: 79, max: 79, now: t0 + 3000 });
  ok('full health three seconds after the logoff does not close the session', !H.mayLogoff('robin', { now: t0 + 3000 }));
  const recovery = { strategy: 'rest_safe', status: 'recovering', chosen_at: t0 + 1000, hp: { max: 79 }, min_hp: 79 };
  const proof = { health: { value: 79, max: 79 }, now: t0 + 3000 };
  ok('a wall decision with only full-health readings cannot re-arm cooperation',
    !H.noteHealingRecovery('robin', { ...proof, decision: recovery }));
  ok('a low reading from before the logoff cannot re-arm cooperation',
    !H.noteHealingRecovery('robin', { ...proof, decision: { ...recovery, chosen_at: t0 - 1000, min_hp: 60 } }));
  H.closeIfHealed('robin', { hp: 79, max: 79, now: t0 + 68_000 });
  ok('nor a minute later (the breakout came at +68 s)', !H.mayLogoff('robin', { now: t0 + 68_000 }));
  H.closeIfHealed('robin', { hp: 79, max: 79, now: t0 + H.SESSION_MIN_MS + 1 });
  ok(`full health ${H.SESSION_MIN_MS / 60000} minutes after the logoff closes it`, H.mayLogoff('robin', { now: t0 + H.SESSION_MIN_MS + 1 }));
}

console.log('a handoff keeps it');
{
  H.noteLogoff('piggy', { why: 'doomed', room: 599 });
  const fresh = await import(`./m59-healing-session.mjs?second=${Date.now()}`);   // a new keeper process reads the same file
  ok('the new keeper may not log off again', !fresh.mayLogoff('piggy') && fresh.readSession('piggy')?.room === 599);
}

console.log('native full-health pushes close a settled session while a keeper rung is awaiting');
{
  const [{ Session }, { M59Client }] = await Promise.all([import('./m59-game.mjs'), import('./m59-client.mjs')]);
  const actor = name => {
    const s = Object.assign(Object.create(Session.prototype), { name, hitBook: () => null });
    const c = new M59Client({ host: '127.0.0.1', port: 1 });
    Object.assign(c, { state: 'game', combatReady: true, selfId: 4446 });
    s.client = c;
    c.onEvent = ev => { if (ev.kind === 'stat' && ev.name === 'health') s.noteHealth(ev, c); };
    const push = (value, max = 124) => c.noteStat({ group: 1, num: 1, name: 'health', value, currentMax: max });
    return { s, c, push };
  };
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-11-09T15:07:48.903Z') });
  try {
    const piggy = actor('native-full-edge');
    H.noteLogoff(piggy.s.name);
    piggy.push(106);
    mock.timers.tick(H.SESSION_MIN_MS + 17_382);
    piggy.push(124);
    mock.timers.tick(3_263);
    piggy.push(106);
    ok('Piggy’s brief settled full push closes the session before damage and without another keeper pass', H.mayLogoff(piggy.s.name));

    const animal = actor('native-full-until-settled');
    H.noteLogoff(animal.s.name);
    mock.timers.tick(20_000);
    animal.push(124);
    const timer = animal.s._healingFullHealth.timer;
    animal.push(124);
    ok('duplicate full pushes keep the one scheduled check', animal.s._healingFullHealth.timer === timer);
    mock.timers.tick(H.SESSION_MIN_MS - 20_001);
    ok('earlier full health cannot close before the five-minute guard', !H.mayLogoff(animal.s.name));
    mock.timers.tick(1);
    ok('a same-body full reading still current at the deadline closes an otherwise blocked town session', H.mayLogoff(animal.s.name));

    for (const [name, invalidate] of [
      ['damage', ({ push }) => push(122)],
      ['new socket', ({ s }) => { s.client = { state: 'game', combatReady: true }; }],
      ['unready', ({ c }) => { c.combatReady = false; }],
      ['renumbered body', ({ c }) => { c.selfId++; }],
      ['new life', ({ s }) => { s.lifeBoundary = 1; }],
    ]) {
      const f = actor(`native-invalid-${name}`);
      H.noteLogoff(f.s.name);
      f.push(124);
      invalidate(f);
      mock.timers.tick(H.SESSION_MIN_MS);
      ok(`${name} invalidates an earlier full-health timer`, !H.mayLogoff(f.s.name));
      if (name === 'unready') {
        f.c.combatReady = true;
        f.push(124);
        ok('a new ready full observation may replace discarded timer evidence', H.mayLogoff(f.s.name));
      }
    }
    const stale = actor('native-stale-socket');
    H.noteLogoff(stale.s.name, { now: Date.now() - H.SESSION_MIN_MS });
    stale.s.client = { state: 'game', combatReady: true };
    stale.push(124);
    ok('a full push from the previous client cannot close a settled session', !H.mayLogoff(stale.s.name));
    const over = actor('native-over-max');
    H.noteLogoff(over.s.name, { now: Date.now() - H.SESSION_MIN_MS });
    over.push(125);
    ok('an unsettled over-max pair is not an exact full-health observation', !H.mayLogoff(over.s.name));
  } finally { mock.timers.reset(); }
}

console.log('the keeper refuses the second logoff');
const { Autopilot } = await import('./m59-autopilot.mjs');
{
  H.noteLogoff('animal', { why: 'doomed', now: Date.now() - H.SESSION_MIN_MS - 1000 });
  const notes = []; let reconnects = 0;
  const k = Object.assign(Object.create(Autopilot.prototype), {
    s: { name: 'animal', client: { vitals: () => ({ health: { value: 9, max: 60 } }) }, combat: null },
    hold: null, note: (w, d) => notes.push({ w, d }), operatorSurvivalStandDown: () => false,
    reconnect: async () => { reconnects++; }, suspendJourney: () => { throw new Error('should not get this far'); } });
  const r1 = await k.playDead('a troll adjacent at 9/60');
  const r2 = await k.playDead('a poison tick at 8/60');
  ok('playDead declines inside a spent session and logs off nothing', r1 === false && r2 === false && reconnects === 0);
  ok('and says why, once', notes.filter(n => n.w === 'not logging off again this healing session').length === 1);
  k.s.client.vitals = () => ({ health: { value: 60, max: 60 } });
  let reached = false; k.suspendJourney = () => { reached = true; throw new Error('stop'); };
  await k.playDead('healed, then hit again').catch(() => {});
  ok('healed to full: the next playDead is allowed through', reached);
}

console.log('a proved recovery re-arms cooperative rescue while routine reconnects stay blocked');
{
  const { chooseSurvivalDecision } = await import('./m59-survival-decision.mjs');
  const { configureCooperativeLogoff, cooperativeStore } = await import('./m59-cooperative-logoff.mjs');
  const { OF } = await import('./m59-parse.mjs');
  const party = await import('./m59-party.mjs');
  const directory = join(process.env.M59_HEALING_DIR, 'cooperation');
  const bodies = [
    { id: 1, nameRsc: 'Victim', flags: OF.PLAYER, row: 10, col: 10 },
    { id: 2, nameRsc: 'Helper', flags: OF.PLAYER, row: 10, col: 11 },
    { id: 3, nameRsc: 'mollusk creature', flags: OF.ATTACKABLE, row: 11, col: 10 },
  ];
  const actor = (name, body, vitals, ailments) => ({ name, live: true, movementGeneration: 1,
    credentials: { host: 'fixture.invalid', port: 15959 }, fleetStateFile: join(directory, 'fleet.json'),
    cooperativeLogoffDirectory: directory, world: { room: { num: 552 } },
    client: { combatReady: true, self: body, selfId: body.id, me: { name: body.nameRsc }, vitals, ailments,
      room: { id: 827, contentsAt: Date.now(), objects: new Map(bodies.map(o => [o.id, o])) },
      idsAsOf: () => ({ last_save_at: null }), rsc: { get: x => x } },
    _askStrategies: async () => ({ strategy: 'fixture-private', answer: { enabled: true, helper_health: 1 } }),
  });
  const vitals = value => ({ health: { value, max: 100 }, vigor: { value: 180 } });
  let health = 86, ailments = [], atWall = true, reconnects = 0;
  const s = actor('recovered-victim', bodies[0], () => vitals(health), () => ailments);
  const helper = actor('recovered-helper', bodies[1], () => vitals(100), () => []);
  const wall = { room: 552, row: 10, col: 10, proven: true };
  const k = Object.assign(Object.create(Autopilot.prototype), { s, tally: {}, hold: wall,
    policy: { fleeBelow: .4, breakOutViaLogoff: true },
    safety: () => ({ fleeAt: .5 }),
    threat: () => ({ near: [1, 2], engaged: 2, names: ['mollusk creature'] }),
    currentRecoveryWall: () => atWall ? wall : null, sessionSpotHere: () => atWall,
    operatorSurvivalStandDown: () => false, suspendJourney: () => {}, resumeCooperativeReturn: async () => {},
    inReachOfUs: () => [bodies[2]], note: () => {}, reconnect: async () => { reconnects++; return { ok: true }; },
  });
  party.setRosterSource(() => new Set(['Victim', 'Helper']));
  try {
    H.noteLogoff(s.name, { why: 'breaking out of a crowded safe spot', room: 552, now: Date.now() - 20_000 });
    chooseSurvivalDecision(s, { strategy: 'rest_safe', status: 'recovering', chosen_refuge: wall });
    health = 100;
    await k.continueSurvivalDecisionStep();
    ok('a post-logoff recovery from 86 to full at a proven wall re-arms cooperation', H.mayLogoff(s.name, { afterRecovery: true }));
    ok('a routine crowded-wall breakout still cannot log off at full', !(await k.breakOut('leaving the wall')).did && reconnects === 0);
    atWall = false; k.hold = null; health = 48;
    const newDanger = () => chooseSurvivalDecision(s, { strategy: 'logoff_open', status: 'pending', reason: 'failed refuge', replan_count: 1 });
    newDanger();
    ok('no admitted helper leaves the recovery evidence intact', !(await k.fleetLogoff('no helper', { afterRecovery: true })) &&
      H.mayLogoff(s.name, { afterRecovery: true }));
    await configureCooperativeLogoff({ s: helper, inReachOfUs: () => [bodies[2]] }, 'helper');
    health = 51;
    ok('the re-arm cannot be used above the flee line', !(await k.fleetLogoff('still above the line', { afterRecovery: true })));
    health = 48; ailments = [{ name: 'poison' }];
    ok('the re-arm cannot be used to start a poison relog loop', !(await k.fleetLogoff('poisoned', { afterRecovery: true })));
    ailments = [];
    ok('the later emergency admits a cooperative request and consumes exactly one logoff',
      await k.playDead('renewed danger after completed recovery') && reconnects === 1 &&
      cooperativeStore(s).read('request', s.name)?.state === 'preparing' && H.readSession(s.name)?.logoffs === 1 &&
      !H.mayLogoff(s.name, { afterRecovery: true }));
    newDanger();
    ok('the new healing session still refuses repeated rescue while hurt', !(await k.playDead('same emergency, still hurt')) && reconnects === 1);
  } finally { party.setRosterSource(null); }
}

console.log('every logoff records itself, and the loop is gone');
{
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('the play-dead logoff records itself before it goes', /noteLogoff\([^)]*\)[^\n]*\n\s*const came = await this\.reconnect\('logging off rather than dying'\)/.test(src));
  ok('so does the cooperative logoff', /noteLogoff\([^)]*\)[^\n]*\n\s*const result=await this\.reconnect\('cooperative logoff: wait for distraction'\)/.test(src));
  ok('the poisoned "hostile adjacent after the relog" loop is gone', !/poisoned, a hostile adjacent after the relog/.test(src) && !/_poisonRelogs/.test(src));
  ok('the survival pass closes a healed session every pass', /const healingSession = closeIfHealed\(/.test(src));
  ok('and the poison shelter takes no second spot inside a spent session', /!this\.hold && !oneSpotAlready/.test(src));
  ok('the breakout logoff records itself and is refused inside a spent session',
     /if \(!mayLogoff\(me\)\) return \{ did: false[\s\S]{0,800}noteLogoff\(me[^\n]*\n\s*const r = await this\.reconnect\('breaking out of a crowded safe spot'\)/.test(src));
}

console.log('every named cause, in Robin\'s order, at full health: one logoff');
{
  const reconnects = [];
  const vit = { health: { value: 79, max: 79 } };
  const c = { vitals: () => vit, self: { col: 3, row: 4 }, room: { objects: new Map() }, rsc: { get: x => x } };
  const k = Object.assign(Object.create(Autopilot.prototype), {
    s: { name: 't8', client: c, world: { room: { num: 599 } }, combat: null }, tally: {}, policy: { breakOutViaLogoff: true },
    hold: { col: 3, row: 4, room: 599, takenAt: Date.now() - 5000 }, note: () => {}, progress: () => {}, noProgress: () => {},
    operatorSurvivalStandDown: () => false, playerThreatPresent: () => false, tellPilot: async () => {},
    adoptRecoveryWall: () => true, holdWorks: () => true, logoffDeclined: () => null, suspendJourney: () => {},
    currentRecoveryWall: () => true, releaseHold: () => {}, noteFailedRestSpot: () => {},
    takeRecoverySpot: async () => ({ took: true }),
    reconnect: async why => { reconnects.push(why); return { ok: true }; },
    threat: () => ({ near: [1, 2, 3], engaged: 2, names: ['troll'] }) });
  await k.playDead('logging off rather than dying, at 79/79').catch(e => reconnects.push('ERR ' + e.message));
  const afterFirst = reconnects.length;
  await k.breakOut('leaving a crowded safe spot').catch(e => reconnects.push('ERR ' + e.message));
  vit.health.value = 73;
  await k.restBroken({ num: 599 }, [{ id: 1 }]).catch(e => reconnects.push('ERR ' + e.message));
  ok('play-dead logs off once', afterFirst === 1, JSON.stringify(reconnects));
  ok('then the crowded-spot breakout and the hit-while-resting do not', reconnects.length === 1, JSON.stringify(reconnects));
}

console.log('a stale recovery cannot spend a logout after a death or handoff');
{
  const { chooseSurvivalDecision, currentSurvivalDecision } = await import('./m59-survival-decision.mjs');
  for (const change of ['already in Underworld', 'fatal hit during tell', 'new decision during tell']) {
    const name = `lew-replay-${change}`;
    const health = { value: change === 'already in Underworld' ? 1 : 7, max: 121 };
    const room = { num: change === 'already in Underworld' ? 1 : 552 };
    const client = { vitals: () => ({ health }), self: { row: 12, col: 67 }, room: { objects: new Map() } };
    const s = { name, client, world: { room }, lifeBoundary: 4 };
    let reconnects = 0, tells = 0;
    const k = Object.assign(Object.create(Autopilot.prototype), {
      s, tally: {}, policy: {}, hold: { room: 552, row: 12, col: 67, proven: true },
      note() {}, operatorSurvivalStandDown: () => false, suspendJourney() {},
      adoptRecoveryWall: () => true, holdWorks: () => true, logoffDeclined: () => null,
      reconnect: async () => { reconnects++; return { ok: true }; },
      async tellPilot() {
        tells++;
        if (change === 'fatal hit during tell') { s.lifeBoundary++; room.num = 1; health.value = 1; }
        if (change === 'new decision during tell')
          chooseSurvivalDecision(s, { strategy: 'nearest_refuge', reason: 'new owner' });
      },
    });
    ok(`stale Ocean play-dead (${change}) spends no logout`,
      await k.playDead('exposed to mollusk rock throws after taking damage') === false &&
      reconnects === 0 && H.readSession(name) == null && tells === (change === 'already in Underworld' ? 0 : 1));
    if (change === 'new decision during tell') ok('the newer recovery decision remains in charge',
      currentSurvivalDecision(s)?.reason === 'new owner');
  }
}
console.log('a broken rest inside a spent session keeps the spot');
{
  H.noteLogoff('rowlf', { why: 'doomed' });
  const notes = []; let released = false, reconnects = 0, spots = 0;
  const k = Object.assign(Object.create(Autopilot.prototype), {
    s: { name: 'rowlf', client: { vitals: () => ({ health: { value: 20, max: 60 } }) } }, tally: {}, policy: {},
    hold: { col: 3, row: 4, room: 599 }, note: (w, d) => notes.push({ w, d }),
    releaseHold: () => { released = true; }, reconnect: async () => { reconnects++; return { ok: true }; },
    takeRecoverySpot: async () => { spots++; return { took: true }; }, noteFailedRestSpot: () => {}, progress: () => {} });
  await k.restBroken({ num: 599 }, [{ id: 1 }]);
  ok('no logoff, no new spot, the hold kept', reconnects === 0 && spots === 0 && !released && k.hold?.col === 3,
     JSON.stringify({ reconnects, spots, released }));
  ok('and it says why', notes.some(n => /staying put/.test(n.w)));
}

console.log('an Ocean rest with fresh attack evidence leaves a failed wall within the same session');
{
  const { loadMap, CHECKED_MAP_FILE } = await import('./m59-map.mjs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const { OF } = await import('./m59-parse.mjs');
  const room = loadMap(CHECKED_MAP_FILE).rooms[552];
  const geometry = sharedRoomGeometry(room);
  const mollusk = { id: 11790, nameRsc: 'mollusk creature', flags: OF.ATTACKABLE,
    row: 55, col: 41, x: 2653, y: 3567 };
  for (const [name, proof, melee, expectedMoves] of [
    ['ocean-rest-ranged', true, false, 1],
    ['ocean-rest-melee', true, true, 1],
    ['ocean-rest-stale', false, false, 0],
    ['ocean-rest-no-progress', true, false, 0],
  ]) {
    H.noteLogoff(name, { why: 'prior healing logoff' });
    const c = { combatReady: true, selfId: 100, self: { id: 100, row: 49, col: 44, x: 2848, y: 3168 },
      room: { id: 1416, security: geometry.security, objects: new Map(melee ? [] : [[mollusk.id, mollusk]]) },
      rsc: { get: x => x }, vitals: () => ({ health: { value: 84, max: 122 } }) };
    let moves = 0, failures = 0, reconnects = 0;
    const k = Object.assign(Object.create(Autopilot.prototype), {
      s: { name, live: true, client: c, world: { room, geometry },
        lastFleetDamage: { client: c, bodyId: c.selfId, roomId: c.room.id, at: Date.now() - (proof ? 0 : 6000) } },
      mode: 'farm', policy: { molluskCoverRecovery: true }, tally: {},
      hold: { row: 49, col: 44, room: 552, proven: true },
      inReachOfUs: () => melee ? [mollusk] : [],
      note: () => {}, progress: () => {},
      releaseHold: () => { k.hold = null; }, noteFailedRestSpot: () => { failures++; },
      reconnect: async () => { reconnects++; return { ok: true }; },
      takeRecoverySpot: async () => { moves++; return { took: true }; },
    });
    await k.restBroken(room, [], { interruptedByAttack: name !== 'ocean-rest-no-progress' });
    ok(name, moves === expectedMoves && failures === expectedMoves && !!k.hold === !expectedMoves &&
       reconnects === 0 && H.readSession(name)?.logoffs === 1, JSON.stringify({ moves, failures, reconnects }));
  }
}

console.log('off a safe spot it never stands still: it flees to the nearest reachable one');
{
  // Operator, 2026-10-27: "if it logs in and it's not in a safe spot it basically should never stay still: the log-off
  // for protection behaviors best conditions is on a safe spot to rest, anything else should flee to the safe spot to try
  // to the nearest reachable heal spot there". The cooperative logoff is the commonest case, not the only one.
  H.noteLogoff('gonzo', { why: 'cooperative', cooperative: true });
  ok('a spent cooperative session with no spot: not "stay put" -- it goes and takes one', H.staysPut('gonzo', { holding: false }) === false);
  ok('once it holds its spot, it stays there like any other', H.staysPut('gonzo', { holding: true }) === true);
  ok('and still no second logoff', !H.mayLogoff('gonzo'));
  H.noteLogoff('kermit', { why: 'doomed' });
  ok('an ordinary spent session with no spot flees too', H.staysPut('kermit', { holding: false }) === false);
  ok('and on its spot it stays', H.staysPut('kermit', { holding: true }) === true);
  ok('no session: nothing to stay put for', H.staysPut('nobody-at-all', { holding: true }) === false);
  const notes = []; let reconnects = 0, spots = 0;
  const k = Object.assign(Object.create(Autopilot.prototype), {
    s: { name: 'gonzo', client: { vitals: () => ({ health: { value: 20, max: 60 } }) } }, tally: {}, policy: {},
    hold: null, note: (w, d) => notes.push({ w, d }), releaseHold: () => {},
    reconnect: async () => { reconnects++; return { ok: true }; },
    takeRecoverySpot: async () => { spots++; return { took: true }; }, noteFailedRestSpot: () => {}, progress: () => {} });
  await k.restBroken({ num: 599 }, [{ id: 1 }]);
  ok('hit in the open after a cooperative relog: takes a spot, logs off nothing', spots === 1 && reconnects === 0,
     JSON.stringify({ spots, reconnects }));
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('the cooperative logoff marks its session cooperative', /noteLogoff\([^\n]*cooperative:true\}\)[^\n]*\n\s*const result=await this\.reconnect\('cooperative logoff/.test(src));
  ok('and the poison shelter asks staysPut, so it can flee there', /const oneSpotAlready = !!healingSession && staysPut\(/.test(src));
  ok('a relog that is not back on the spot flees to the nearest reachable one; the open freeze after it is gone',
     /relogged off a safe spot: fleeing to the nearest reachable one[\s\S]{0,300}takeRecoverySpot\('relogged off a safe spot/.test(src)
     && !/falling back to staying completely still/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
