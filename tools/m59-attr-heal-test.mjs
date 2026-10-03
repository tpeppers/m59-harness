// Offline guard for tools/m59-attr-heal.mjs: a keeper re-asks for stat group 2 only when its
// attribute block is genuinely incomplete, never on a healthy one. Opens no socket.
//
//   node tools/m59-attr-heal-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pacer } from './m59-game.mjs';
import { attributesIncomplete, attrHealDue, droppedStatMessages, statTraceOf, loginSettling, combatReadyOverdue } from './m59-attr-heal.mjs';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${name}`); };
const block = (over = {}) => {
  const m = new Map();
  const vals = { might: 30, intellect: 45, stamina: 40, agility: 35, mysticism: 50, aim: 25, karma: -40, ...over };
  for (const [k, v] of Object.entries(vals)) if (v !== undefined) m.set(k, { value: v, observed_at: 1000 });
  return m;
};

ok('a healthy block asks nothing -- including karma 0, which is a real value', () => {
  assert.equal(attributesIncomplete(block()), null);
  assert.equal(attributesIncomplete(block({ karma: 0 })), null);
});
ok('karma missing: re-ask', () => assert.match(attributesIncomplete(block({ karma: undefined })).why, /karma missing/));
ok('intellect 0 is an absence, not a value: re-ask', () => assert.match(attributesIncomplete(block({ intellect: 0 })).why, /intellect 0/));
ok('an empty block (t9, 2026-10-01): re-ask, and the snapshot says what was there', () => {
  const r = attributesIncomplete(new Map());
  assert.match(r.why, /karma missing.*intellect missing/);
  assert.equal(r.snapshot.karma, null);
});
ok('the snapshot carries observed_at, so the log can tell "never arrived" from "overwritten"', () => {
  assert.deepEqual(attributesIncomplete(block({ intellect: 0 })).snapshot.intellect, { value: 0, observed_at: 1000 });
});
ok('no client yet: nothing to judge', () => assert.equal(attributesIncomplete(null), null));
ok('the keeper heals only in game, never during a handoff, once a minute, and reports once per LOGIN', () => {
  const src = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
  assert.ok(/if \(!inGame \|\| !session\.live \|\| handoffActive\(\)\) \{[\s\S]{0,700}?return;\s*\}[\s\S]{0,2500}?const bad = attributesIncomplete/.test(src));
  assert.ok(/if \(!bad\) return;[\s\S]{0,400}?if \(!attrHealReported\.has\(cl\)\) \{\s*attrHealReported\.add\(cl\);/.test(src),
    'keyed on the client, so a second relog inside one drop reports again');
  assert.ok(src.includes('}, ATTR_HEAL_TICK_MS);'));
  assert.ok(src.includes('attrHealDue({ now, loggedInAt: since, lastAskAt: attrHealAskedAt })'));
});
ok('A LOGIN IN PROGRESS IS NOT A DROP: the heal leaves it alone inside the grace', () => {
  const login = 1_000_000, g = { since: login, graceMs: 20_000 };
  assert.equal(loginSettling({ loginPhase: 'installed' }, { ...g, now: login + 300 }), true, 'installed, reads not yet run');
  assert.equal(loginSettling({ loginPhase: 'reads' }, { ...g, now: login + 5_000 }), true);
  assert.equal(loginSettling({ loginPhase: 'reads' }, { ...g, now: login + 25_000 }), false, 'past the grace it is judged');
  assert.equal(loginSettling({ loginPhase: 'ready' }, { ...g, now: login + 300 }), false);
  assert.equal(loginSettling({}, { ...g, now: login + 300 }), false, 'a client with no phase is judged as before');
  const src = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
  assert.ok(/if \(loginSettling\(cl, [^)]*\)\) return;\s*const bad = attributesIncomplete/.test(src), 'checked before the block is judged');
  assert.ok(src.includes('const since = cl?.loginStartedAt ?? session.loggedInAt'),
    "timed from THIS client's login, so an in-process relog restarts the clock");
  const game = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
  assert.ok(/this\.client = c;[\s\S]{0,400}?c\.loginStartedAt = Date\.now\(\);\s*c\.loginPhase = 'installed';/.test(game), 'stamped as it is installed');
});
ok('a deaf client the guard hides is reported, and every rejoin names its reason', () => {
  const src = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
  assert.ok(/if \(overdue && !attrHealGuardLogged\.has\(cl\)\)[\s\S]{0,400}heal is held/.test(src));
  const game = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
  assert.ok(/async rejoin\(why = 'unspecified'\)[\s\S]{0,600}this\.lastRejoin = \{/.test(game));
  assert.ok(game.includes('login complete in'), 'each login says how long its reads took');
  const ap = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  assert.ok(ap.includes('this.s.rejoin(why)'), 'the autopilot passes its reason');
  assert.equal(statTraceOf({ createdAt: 1, statTrace: {}, loginPhase: 'reads', loginStartedAt: 5 }).login_phase, 'reads');
});
ok('THE CAUSE: Session.joinOnce waits for our own BP_PLAYER before the login reads', () => {
  // c.login() resolves on AP_GAME, before the character is chosen; ToCliStats drops a request
  // until UserLogon sets pbLogged_on (user.kod:2663). BP_PLAYER is sent from inside UserLogon.
  const src = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('  async joinOnce('));
  const wait = body.indexOf('!c.selfId && Date.now() < until');
  const firstRead = body.indexOf("await observe('room', () => c.roomContents())");
  const statsRead = body.indexOf("await observe('stats 2', () => c.stats(2))");
  assert.ok(wait > 0 && wait < firstRead && firstRead < statsRead, 'the wait comes before every login read');
});
ok('THE CAUSE (t17, 2026-10-01): a preempted login read no longer aborts the login', () => {
  // "join failed: body command preempted by combat override" left a live client with no group 2
  // and combatReady false -- and the retry returned it as "already in game".
  const src = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('  async joinOnce('), src.indexOf('this.firstAbilityRead = readAbilitiesOnce'));
  assert.ok(!/\n\s*await loginRead\(/.test(body), 'no login read is awaited bare: each goes through observe()');
  assert.ok(/catch \(e\) \{\s*loginReadFailures\.push[\s\S]{0,120}this\.pacer\.submit\('read', fn\)/.test(body),
    'a preempted read is recorded and re-sent under the current owner');
  assert.ok(/\} finally \{\s*c\.combatReady = true;\s*c\.loginPhase = 'ready';/.test(body), 'combat readiness ALWAYS runs');
});
ok('THE HANG (t4, 2026-10-02): a login read the pacer never delivers is sent directly after a bound', () => {
  // trace: login_read_failures [], nothing asked, combat_ready false -- joinOnce parked on its first
  // read behind a pacer job that never settled.
  const src = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('  async joinOnce('), src.indexOf('this.firstAbilityRead = readAbilitiesOnce'));
  assert.ok(/const r = await delivered\(loginRead\(fn\)\);\s*if \(r\?\.held === true\)[^\n]*\n\s*return r === STALL \? sendDirect\(what, stalled, fn\) : r;/.test(body),
    'the first attempt is bounded and falls back to a direct send');
  assert.ok(/head: this\.pacer\.q\?\.\[0\]\?\.kind/.test(body), 'and the record names the job blocking the pacer');
  assert.match(src, /export const LOGIN_READ_STALL_MS = /);
});
ok('a keeper never stays combat-deaf: readiness is declared 20s after a login that did not set it', () => {
  const src = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
  assert.ok(/const overdue = combatReadyOverdue\(cl, [\s\S]{0,1800}?if \(overdue\) \{\s*cl\.combatReady = true;/.test(src));
  const login = 1_000_000, g = { since: login, graceMs: 20_000 };
  assert.equal(combatReadyOverdue({ combatReady: false }, { ...g, now: login + 21_000 }), true);
  assert.equal(combatReadyOverdue({ combatReady: false }, { ...g, now: login + 19_000 }), false);
  assert.equal(combatReadyOverdue({ combatReady: true }, { ...g, now: login + 99_000 }), false);
  assert.equal(combatReadyOverdue(null, { ...g, now: login + 99_000 }), false);
  assert.ok(src.includes('combat_ready: c?.combatReady ?? null,'), '/state reports it, so deafness is visible');
});
ok('THE CAUSE (t9, 2026-10-03): a cast hold drops a read as {held:true} without sending it', () => {
  // The two failures after the login-phase fix had phase 'ready', ~650ms logins, group 2 never
  // asked and no read failures: t9 was practising poison fog, relogged mid-cast, and the PACER
  // (which outlives the socket) still held the cast's trance.
  const p = new Pacer();
  p.holdForCast(15_000, 'casting poison fog');
  let ran = false;
  p.submit('read', () => { ran = true; });
  assert.equal(ran, false, 'a read under a cast hold is never sent');
  assert.equal(p.holdStatus().dropped.read, 1, 'it is counted as dropped, and resolves -- so no failure was recorded');
  p.releaseCastHold();
  assert.equal(p.holdStatus().active, false);
});
ok('so joinOnce releases an inherited hold, and a held login read is sent directly and recorded', () => {
  const src = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('  async joinOnce('), src.indexOf('this.firstAbilityRead = readAbilitiesOnce'));
  const install = body.indexOf("c.loginPhase = 'installed';");
  const release = body.indexOf('this.pacer.releaseCastHold();');
  const reads = body.indexOf("await observe('room'");
  assert.ok(install > 0 && install < release && release < reads, 'released after install, before the first read');
  assert.ok(/if \(r\?\.held === true\) return sendDirect\(what,/.test(body), 'a held read is a failure, not a delivery');
  assert.ok(body.includes('released cast hold'), 'and the login line says it released one');
});
ok('fast right after a login (every 10s for 2 min), then once a minute', () => {
  const login = 1_000_000;
  assert.equal(attrHealDue({ now: login + 15_000, loggedInAt: login, lastAskAt: login + 4_000 }), true, 'fresh login, 11s since the last ask');
  assert.equal(attrHealDue({ now: login + 15_000, loggedInAt: login, lastAskAt: login + 9_000 }), false, 'only 6s');
  assert.equal(attrHealDue({ now: login + 300_000, loggedInAt: login, lastAskAt: login + 270_000 }), false, 'old login: 30s is not a minute');
  assert.equal(attrHealDue({ now: login + 300_000, loggedInAt: login, lastAskAt: login + 230_000 }), true);
  assert.equal(attrHealDue({ now: 5_000_000, loggedInAt: null, lastAskAt: 0 }), true, 'never asked');
});
ok('the trace tells "never asked", "asked and unanswered" and "the login wait timed out" apart', () => {
  const t = statTraceOf({ createdAt: 1000, statTrace: { asked: { 2: [2000, 3000] }, got: { 1: 2500 } },
                          loginWait: { waited_ms: 10000, timed_out: true } });
  assert.equal(t.group2_asked.length, 2, 'asked twice');
  assert.equal(t.group2_got, null, 'never answered');
  assert.ok(t.group1_got, 'while group 1 was');
  assert.equal(t.login_wait.timed_out, true);
  assert.equal(statTraceOf(null), null);
  const src = readFileSync(new URL('./m59-client.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('this.statTrace.got[res.group] = Date.now();'), 'the client records each group reply');
  assert.ok(/stats\(group = 1\)\s*\{[\s\S]{0,200}asked\.push\(Date\.now\(\)\)/.test(src), 'and each request');
});
ok('the report names dropped STAT messages only, newest last', () => {
  const c = { parseErrors: [{ what: 'SAID', why: 'x', at: 1 }, { what: 'STAT_GROUP', why: 'cursor off by 4 bytes', at: 2 }] };
  assert.deepEqual(droppedStatMessages(c).map(e => e.what), ['STAT_GROUP']);
  assert.deepEqual(droppedStatMessages(null), []);
});

console.log(`\n${n} passed`);
