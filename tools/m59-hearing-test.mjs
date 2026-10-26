#!/usr/bin/env node
// A DEATH SAYS WHETHER THE KEEPER WAS LOOKING AND COULD HEAR. Offline: opens no socket, joins nobody.
//
// Prod 2026-10-26: nine deaths "stalled" with a health trail flat at max. That is three different failures that look
// the same: frames stopped (nobody looking), the socket went quiet, or bytes arrived and nothing parsed. The
// postmortem's `hearing` block and the frame's link ages are what tell them apart; this pins that they are written.
import { Autopilot } from './m59-autopilot.mjs';
import { M59Client } from './m59-client.mjs';
import { tick } from './m59-watchdog.mjs';

let passed = 0, failed = 0;
const ok = (what, cond) => { if (cond) { passed++; console.log('  ok  ', what); } else { failed++; console.log('  FAIL', what); } };

section: {
  const c = new M59Client({ host: '127.0.0.1', port: 1, user: 'x', pass: 'y' });
  c.log = () => {};
  ok('a fresh client has dropped nothing', (c.framingDrops ?? 0) === 0);
  c.onData(Buffer.from([5, 0, 0, 0, 6, 0, 0, 1, 2, 3, 4, 5, 6]));     // len 5 but len2 6: a desynced header
  ok('a desynced frame header is counted, not only logged', c.framingDrops === 1 && c.lastFramingDropAt > 0);
  ok('and the socket still reads as alive (that is the trap)', c.lastRxAt > 0);
}

section: {
  const now = Date.now();
  const fakeClient = { lastRxAt: now - 1_000, lastGameMsgAt: now - 30_000, gameMsgs: 4321, framingDrops: 7, lastFramingDropAt: now - 2_000,
    parseErrors: [{ what: 'STAT', why: 'cursor off by 4 bytes', at: now - 3_000 }, { what: 'MOVE', why: 'x', at: now }], me: { name: 'X' } };
  const keeper = Object.create(Autopilot.prototype);
  Object.assign(keeper, { s: { client: fakeClient, name: 't1', combat: null }, policy: {}, mode: 'survive', journal: [],
    watch: { lastTickAt: now - 40_000, lastSkip: { at: now - 500, why: 'combat mode owns the body' } },
    recent5: [{ at: now - 41_000, health: 87, max: 87, num: 599, room: 'Ukgoth' }] });
  let pm = null; try { pm = keeper.postMortem('died'); } catch (e) { console.log('    postMortem threw:', e.message); }
  const h = pm?.hearing;
  ok('the postmortem carries a hearing block', !!h);
  ok('how long before the death the last frame was written', h?.last_frame_age_ms >= 40_000);
  ok('bytes fresh, last parsed message old: alive and deaf', h?.rx_age_ms < 5_000 && h?.msg_age_ms >= 30_000);
  ok('framing drops and the STAT parse errors are named', h?.framing_drops === 7 && h?.stat_parse_errors.length === 1 && h.stat_parse_errors[0].why === 'cursor off by 4 bytes');
  ok('whether survival was on', h?.survival_enabled === true);
  ok('and when the watchdog last ran, and why it last stepped aside', h?.watchdog?.last_tick_age_ms >= 40_000 && h.watchdog.last_skip.why === 'combat mode owns the body');
}

section: {
  const host = { s: { client: { state: 'game' }, live: true, combat: { active: true, tick: async () => {} } }, watch: {} };
  tick(host);
  ok('a watchdog that steps aside for combat mode says so', host.watch.lastSkip?.why === 'combat mode owns the body');
  host.s.live = false; tick(host);
  ok('and for a session that is not live', host.watch.lastSkip?.why === 'session not live');
}

section: {
  // THE KEEPER'S OWN WATCHDOG, survival off: it used to return before writing a frame.
  const frames = [];
  const keeper = Object.create(Autopilot.prototype);
  let hp = 80;
  Object.assign(keeper, { s: { live: true, combat: null, client: { state: 'game', vitals: () => ({ health: { value: hp, max: 87 } }) } },
    policy: { survivalEnabled: false }, watch: { ticks: 0 }, lastFrameAt: Date.now(), recordFrame(why) { frames.push(why); this.lastFrameAt = Date.now(); } });
  keeper.watchdogTick(); hp = 62; keeper.watchdogTick();
  ok('survival off: a hit still writes a frame', frames.some(f => /health moved \(survival OFF\)/.test(f)));
  ok('and the watchdog says why it did nothing else', keeper.watch.lastSkip?.why === 'survival disabled by operator');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
