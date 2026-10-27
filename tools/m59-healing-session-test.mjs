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
