import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = mkdtempSync(join(tmpdir(), 'tougher-observation-'));
process.env.M59_TOUGHER_DIR = join(scratch, 'tougher');
process.env.M59_LEDGER_DIR = join(scratch, 'ledger');
const t = await import('./m59-tougher.mjs');
const { recoverInterval, recoveryPlan } = await import('./m59-tougher-recover.mjs');
const { Session } = await import('./m59-session.mjs');
const { M59Client } = await import('./m59-client.mjs');
const { renderTougher } = await import('./m59-deaths-page.mjs');
try {
  const c = Object.assign(Object.create(M59Client.prototype), {
    me: { name: 'Test Character' }, evSeq: 0, events: [], maxEvents: 2, waiters: [],
    combatReady: true, vitals: () => ({ health: { value: 40, max: 41 } }),
  });
  const s = Object.assign(Object.create(Session.prototype), {
    name: 'offline-tougher', client: c, world: { room: { name: 'Test room', num: 39 } },
    recorder: { line() {} }, noteBanker() {}, noteCombatLine() {}, noteLoyalty() {},
  });
  const source = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('    c.onEvent = ev => {', source.indexOf('  async joinOnce('));
  const end = source.indexOf('    if (character)', start);
  new Function('c', 'autopilotIfAny', source.slice(start, end)).call(s, c, () => null);
  const at = Date.now();
  c.emit('message', { at, text: 'You suddenly feel a little tougher.' });
  assert.equal(t.loadGains(c.me.name).gains.length, 1, 'saved immediately without an autopilot or next pass');
  c.emit('message', { at: at + 1, text: 'You are invigorated by your success.' });
  for (let i = 0; i < 600; i++) c.emit('changed', {});
  assert.equal(c.events.length, 2);
  assert.equal(t.loadGains(c.me.name).gains.length, 1, 'paired line and event eviction cannot lose or duplicate a gain');
  t.recordKill(c.me.name, { at: at + 40, creature: 'skeleton' });
  assert.equal(t.loadGains(c.me.name).gains[0].creature, 'skeleton', 'late attribution enriches the already durable gain');
  assert.equal(t.allGains({ characters: new Set([c.me.name]) }).length, 1, 'real names survive filename sanitizing');
  c.emit('message', { at: at + 2000, text: 'You are invigorated by your success.' });
  assert.equal(t.loadGains(c.me.name).gains.length, 2, 'fallback line records a missing primary line');
  const g = recoverInterval({ t: at - 10000, level: 38 }, { t: at + 5000, level: 41 }, t.loadGains(c.me.name).gains);
  assert.equal(g.length, 1, 'subtract announcements from sample delta');
  assert.equal(recoverInterval({t:1,level:41},{t:2,level:40},[]).length, 0, 'losses are not gains');
  assert.equal(recoverInterval({t:1,level:41},{t:2,level:41},[]).length, 0);
  const multi = recoverInterval({t:at-20000,level:20},{t:at-15000,level:23},[]);
  for (const gain of multi) t.commitGain('Recovered', gain);
  for (const gain of multi) t.commitGain('Recovered', gain);
  assert.equal(t.loadGains('Recovered').gains.length, 3, 'multiple +1 gains at one sample time survive dedupe, and reruns are idempotent');
  const html = renderTougher({ characters: new Set(['Recovered']) });
  assert.match(html, /3 points recovered/);
  assert.match(html, /by this time/);
  assert.match(html, /minimum/);
  // Missing kill attribution must survive a fresh module instance (process restart).
  t.recordGain('Restart', {at,from:50,to:51});
  const fresh = await import('./m59-tougher.mjs?restart');
  assert.equal(fresh.loadGains('Restart').gains.length, 1);
  const history = join(scratch, 'history'); mkdirSync(history);
  writeFileSync(join(history, 'fleet-2026-09-23.jsonl'), [
    { type:'sample', character:'History', t:10000, level:20 },
    { type:'sample', character:'History', t:20000, level:23 },
    { type:'event', character:'History', t:20001, kind:'level_up', from:20, to:23 },
    { type:'sample', character:'Other fleet', t:10000, level:20 },
    { type:'sample', character:'Other fleet', t:20000, level:30 },
  ].map(x=>JSON.stringify(x)).join('\n'));
  const options = { history, characters: new Set(['History']) };
  const plan = await recoveryPlan(options);
  assert.equal(plan.additions.length, 3, 'recover samples once, excluding other fleets and derived ledger events');
  for (const {character,...gain} of plan.additions) t.commitGain(character, gain);
  assert.equal((await recoveryPlan(options)).additions.length, 0, 'full recovery rerun makes no additions');
  console.log('Tougher packet recording, persistence, recovery and rendering checks passed');
} finally { rmSync(scratch, {recursive:true,force:true}); }
