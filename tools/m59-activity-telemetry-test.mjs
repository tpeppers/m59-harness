import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ACTIVITY_FORMAT, createActivityRecorder, createRunTelemetry, castTelemetry, scriptDomains } from './m59-activity-telemetry.mjs';
import { activityReport, mergeActivityCasts } from './m59-activity-report.mjs';
import { collectInsights } from './m59-fleet-insights.mjs';
import { renderInsights } from './m59-fleet-insights-page.mjs';
import { auditTelemetry } from './m59-telemetry-audit.mjs';

const now = Date.parse('2026-11-02T12:00:00Z');
const members = [{ agent: 't1', character: 'Courier' }, { agent: 't5', character: 'Caster' }];
function fixture() {
  let at = now - 60000;
  const rows = [];
  const recorder = createActivityRecorder({ dir: 'test-only', fleet: 'test', now: () => at,
    characterOf: a => members.find(p => p.agent === a)?.character, roomOf: () => 53,
    mkdir: () => {}, append: (_p, s) => rows.push(JSON.parse(s)) });
  return { rows, recorder, clock: n => { at = n; } };
}

test('Mystic Touch failed rolls, refusals, unknowns and success use observed evidence', () => {
  assert.equal(castTelemetry({ cast: true, mana_spent: 0, messages: ['You were unsuccessful in casting mystic touch.'] }).outcome, 'fizzle');
  assert.equal(castTelemetry({ cast: true, mana_spent: 3, messages: ['Your concentration is broken and the spell fizzles.'] }).outcome, 'broken');
  assert.equal(castTelemetry({ cast: false, reason: 'not enough reagents' }).outcome, 'refused');
  assert.equal(castTelemetry({ cast: true, mana_spent: 0 }).outcome, 'unknown');
  assert.equal(castTelemetry({ cast: true, queued: true, mana_spent: 3 }).outcome, 'unknown');
  assert.equal(castTelemetry({ cast: true, messages: ['You give part of your magical energy.'] }).outcome, 'success');
  assert.equal(castTelemetry({ cast: true, mana_spent: 3 }, null, { mana: 3, cast_time_ms: 0 }).outcome, 'success');
  assert.equal(castTelemetry({ cast: true, mana_spent: 30 }, null, { mana: 30, cast_time_ms: 30000 }).outcome, 'unknown');
  assert.equal(castTelemetry({ cast: true, mana_spent: 3 }).outcome, 'unknown');
});

test('direct broker callers need no runner and telemetry never keeps arbitrary arguments', () => {
  const { rows, recorder } = fixture();
  const reply = { cast: true, mana_spent: 0, messages: ['You were unsuccessful in casting mystic touch.'] };
  const before = JSON.stringify(reply);
  recorder.observe('cast', { agent: 't5', spell: 'mystic touch', target: 'Partner', password: 'SECRET' }, reply);
  assert.equal(rows.length, 1); assert.equal(rows[0].outcome, 'fizzle'); assert.equal(rows[0].character, 'Caster');
  assert.equal(JSON.stringify(reply), before); assert.ok(!JSON.stringify(rows).includes('SECRET'));
  recorder.observe('cast', { agent: '../foreign', spell: 'zap' }, reply);
  recorder.observe('cast', { agent: 'foreign', spell: 'zap' }, reply);
  assert.equal(rows.length, 1);
});

test('Hanla-shaped nested shopping reads report the observed arrow increase without another read', () => {
  const { rows, recorder } = fixture();
  const context = { run: 'hanla-run', script: 'arrow courier', source: 'fleetscripts/arrow-courier.mjs' };
  const options = { context };
  recorder.observe('inventory', { agent: 't1' }, { items: [{ name: 'arrows', amount: 10 }] }, options);
  recorder.observe('shop', { agent: 't1', seller: 'Bowmaker', buy_ids: [{ id: 5, amount: 100 }] }, { bought: [{ id: 5, amount: 100 }] }, options);
  assert.equal(rows[0].verified, false);
  recorder.observe('inventory', { agent: 't1' }, { items: [{ name: 'arrows', amount: 87 }] }, options);
  assert.deepEqual(rows[1].gained, [{ name: 'arrows', amount: 77 }]);
  assert.equal(rows[1].purchase, rows[0].id); assert.equal(rows[1].verified, true);
  assert.ok(scriptDomains({ name: 'hanla-arrows', steps: [{ do: 'walk', why: 'deliver arrows to the bowers' }] }).includes('courier'));
});

test('courier lifecycle works for multiple agents and incomplete runs never become successful laps', () => {
  const { rows, recorder, clock } = fixture();
  const send = (agent, kind, extra = {}) => recorder.lifecycle({ run: 'r1', script: 'arrow courier', agent, kind, ...extra });
  send('t1', 'run_start', { room: 2143 }); send('t1', 'run_plan', { domains: ['courier'] });
  send('t5', 'run_start', { domains: ['courier'] });
  send('t1', 'step_start', { index: 0, step: 'walk', to: 2100 });
  clock(now - 30000); send('t1', 'step_end', { index: 0, step: 'walk', to: 2100, duration_ms: 30000, ok: true });
  clock(now); send('t1', 'run_end', { ok: true });
  const report = activityReport([...rows, ...rows], { characters: members, now });
  assert.equal(report.trips.length, 1); assert.equal(report.trips[0].duration_ms, 60000);
  assert.equal(report.trips[0].legs[0].from, 2143); assert.equal(report.trips[0].legs[0].secs, 30);
  assert.equal(report.active.length, 1); assert.equal(report.active[0].agent, 't5');
  assert.equal(activityReport(rows, { characters: [{ agent: 't1', character: 'Someone else' }], now }).rows, 0);
});

test('supply transfers use verified supplied result and do not turn stationary donations into laps', () => {
  const { rows, recorder } = fixture();
  recorder.observe('supply', { from: 't1', to: 't5', what: 'arrows', amount: 50, who_travels: 'neither' }, { supplied: true });
  recorder.observe('supply', { from: 't1', to: 't5', what: 'arrows', amount: 50, who_travels: 'from' }, { supplied: false, reason: 'receiver full' });
  const report = activityReport(rows, { characters: members, now });
  assert.equal(report.transfers.length, 2); assert.equal(report.transfers[0].moved, null);
  assert.equal(report.trips.length, 1); assert.equal(report.trips[0].completed, false);
});

test('guild restocking accepts the actual item-to-count receipt without inventing an amount', () => {
  const { rows, recorder } = fixture();
  recorder.observe('hall_withdraw', { agent: 't5', wants: [{ item: 'emerald', amount: 10 }], password: 'SECRET' }, { ok: true, took: { emerald: 7 } });
  assert.deepEqual(rows[0].items, [{ name: 'emerald', amount: 7 }]);
  assert.ok(!JSON.stringify(rows[0]).includes('SECRET'));
});

test('recorder errors cannot fail an action or invent telemetry', () => {
  const recorder = createActivityRecorder({ dir: 'not-used', characterOf: () => 'Tester', mkdir: () => { throw Error('disk full'); } });
  assert.equal(recorder.lifecycle({ run: 'x', script: 's', agent: 't1', kind: 'run_start' }), false);
  assert.doesNotThrow(() => recorder.observe('cast', { agent: 't1', spell: 'zap' }, { mana_spent: 3 }));
});

test('verified training results refine a native receipt without counting the cast twice', () => {
  const native = [{ t: now - 60000, run: 'inner', parent_run: 'outer', cast_time_ms: 30000, outcome: 'unknown' }];
  const legacy = [{ t: now - 20000, run: 'outer', outcome: 'success' }];
  const merged = mergeActivityCasts(native, legacy, []);
  assert.equal(merged.length, 1); assert.equal(merged[0].outcome, 'success');
  assert.equal(native[0].outcome, 'unknown');
  assert.equal(mergeActivityCasts([{ t: now, outcome: 'fizzle' }], [{ t: now, outcome: 'success' }], []).at(0).outcome, 'fizzle');
  const older = [{ t: now - 200000, outcome: 'success' }, { t: now - 199000, outcome: 'fizzle' }];
  assert.equal(mergeActivityCasts(native, older, []).length, 3);
});

test('foreign fleet, malformed records and missing starts cannot become courier successes', () => {
  const rows = [null, { format: ACTIVITY_FORMAT, id: 'foreign', at: now, fleet: 'foreign', agent: 't1', character: 'Courier', kind: 'cast' },
    { format: ACTIVITY_FORMAT, id: 'end-only', at: now, fleet: 'test', agent: 't1', character: 'Courier', kind: 'run_end', run: 'r', domains: ['courier'], ok: true }];
  const report = activityReport(rows, { characters: members, fleet: 'test', now });
  assert.equal(report.trips.length, 0); assert.equal(report.rows, 1);
});

test('queued telemetry preserves event order and swallows transport failure', async () => {
  const sent = [], telemetry = createRunTelemetry({ run: 'r', script: 'script', now: () => now,
    call: async (_name, { event }) => { sent.push(event); if (event.kind === 'step_start') throw Error('offline'); } });
  telemetry.event('t1', 'run_start'); telemetry.event('t1', 'step_start'); telemetry.event('t1', 'run_end', { ok: true });
  await telemetry.flush(); assert.deepEqual(sent.map(r => r.kind), ['run_start', 'step_start', 'run_end']);
});

test('an unresponsive telemetry sink has a bounded flush and cannot hold up body cleanup', async () => {
  const telemetry = createRunTelemetry({ run: 'r', script: 'script', flushMs: 15, call: () => new Promise(() => {}) });
  telemetry.event('t1', 'run_start'); telemetry.event('t1', 'run_end');
  const start = Date.now(); await telemetry.flush();
  assert.ok(Date.now() - start < 500);
});

test('shared receipts reach both boards without legacy filenames, password rosters or fabricated attempts', () => {
  const root = mkdtempSync(join(tmpdir(), 'm59-activity-'));
  try {
    const dir = join(root, 'substrate', 'history', 'test', 'activity'); mkdirSync(dir, { recursive: true });
    const { rows, recorder, clock } = fixture();
    recorder.lifecycle({ run: 'hanla', script: 'hanla-arrows', agent: 't1', kind: 'run_start', domains: ['courier'] });
    clock(now); recorder.lifecycle({ run: 'hanla', script: 'hanla-arrows', agent: 't1', kind: 'run_end', ok: true });
    recorder.observe('cast', { agent: 't5', spell: 'mystic touch' }, { cast: true, mana_spent: 0, messages: ['You were unsuccessful in casting mystic touch.'] });
    writeFileSync(join(dir, '2026-11-02.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
    const data = collectInsights({ root, fleet: 'test', characters: members, now, hours: 2 });
    assert.equal(data.couriers.summary.total, 1); assert.equal(data.couriers.trips[0].script, 'hanla-arrows');
    const touch = data.practice.rows.find(r => r.spell === 'mystic touch');
    assert.equal(touch.attempts, 1); assert.equal(touch.outcomes.fizzle, 1); assert.equal(touch.current, null);
    assert.equal(data.sources.activityRows, 3);
    assert.ok(renderInsights({ data, page: 'couriers' }).includes('hanla-arrows'));
    assert.ok(renderInsights({ data, page: 'practice' }).includes('mystic touch'));
    const scratch = join(root, 'substrate', 'scratch'); mkdirSync(scratch);
    writeFileSync(join(scratch, 'mystic-drill.mjs'), "throw Error('must not execute'); rpc('cast', {spell:'mystic touch'});");
    const audit = auditTelemetry(root); assert.equal(audit.directBroker, 1);
    assert.equal(readFileSync(join(scratch, 'mystic-drill.mjs'), 'utf8').includes('must not execute'), true);
  } finally { rmSync(root, { force: true, recursive: true }); }
});
