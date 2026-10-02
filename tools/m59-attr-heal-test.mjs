// Offline guard for tools/m59-attr-heal.mjs: a keeper re-asks for stat group 2 only when its
// attribute block is genuinely incomplete, never on a healthy one. Opens no socket.
//
//   node tools/m59-attr-heal-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attributesIncomplete, attrHealDue, droppedStatMessages, statTraceOf } from './m59-attr-heal.mjs';

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
ok('the keeper heals only in game, never during a handoff, once a minute, and logs once per drop', () => {
  const src = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
  assert.ok(/if \(!inGame \|\| !session\.live \|\| handoffActive\(\)\) return;\s*const bad = attributesIncomplete/.test(src));
  assert.ok(src.includes('if (!bad) { attrHealReported = false; return; }'));
  assert.ok(src.includes('}, ATTR_HEAL_TICK_MS);'));
  assert.ok(src.includes('attrHealDue({ now, loggedInAt: session.loggedInAt, lastAskAt: attrHealAskedAt })'));
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
  assert.ok(/\} finally \{\s*c\.combatReady = true;\s*\}/.test(body), 'combat readiness ALWAYS runs');
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
