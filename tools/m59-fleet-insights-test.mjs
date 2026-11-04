import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectInsights, courierEndTime, courierReport, parseCourierRun, percentile, practiceReport, readRows, stamp } from './m59-fleet-insights.mjs';
import { renderInsights } from './m59-fleet-insights-page.mjs';
import { dashboardRedirectUrl, isDashboardOnlyPath } from './m59-dashboard-route.mjs';

const now = Date.parse('2026-11-02T12:00:00Z'), minute = 60_000, hour = 60 * minute;
const person = () => ({ agent: 't1', character: 'Tester', live: { snapshot_age_ms: 0, policy: { practiceSpells: { enabled: true, spells: ['bless'] } } }, order: { trainings: [{ kind: 'spell', name: 'bless', to: 99 }] }, book: { spells: { bless: { ability: 42, first: now - 3 * hour, at: now } }, history: [{ kind: 'spell', name: 'bless', from: 40, to: 41, at: now - 50 * minute }, { kind: 'spell', name: 'bless', from: 41, to: 43, at: now - 30 * minute }, { kind: 'spell', name: 'bless', from: 43, to: 42, at: now - minute }] }, events: [{ kind: 'cast', spell: 'bless', outcome: 'success', t: now - minute }, { kind: 'cast', spell: 'bless', outcome: 'fizzle', t: now - minute }, { kind: 'improve', spell: 'bless', from: 40, to: 43, t: now - 20 * minute }] });

test('practice uses net wall-clock rate, preserves atrophy and does not double-count telemetry', () => {
  const p = person(); p.live.policy.practiceSpells = null;
  const r = practiceReport({ people: [p], now, hours: 1 }).rows[0];
  assert.equal(r.gained, 3); assert.equal(r.lost, 1); assert.equal(r.rate, 2);
  assert.equal(r.attempts, 2); assert.equal(r.successPct, 50); assert.equal(r.current, 42);
  assert.equal(r.etaMs, 57 / 2 * hour);
});

test('a practice policy preserves an explicit standing target', () => {
  const r = practiceReport({ people: [person()], now, hours: 1 }).rows[0];
  assert.equal(r.target, 99);
});

test('ETA refuses missing targets, stale activity, zero rate and insufficient samples', () => {
  const p = person(); p.order = null;
  assert.equal(practiceReport({ people: [p], now, hours: 1 }).rows[0].etaReason, 'No target recorded');
  p.order = person().order; p.live = null; p.events = []; p.book.history.forEach(h => h.at -= 10 * minute);
  assert.equal(practiceReport({ people: [p], now, hours: 1 }).rows[0].etaMs, null);
  p.live = person().live; p.book.history = [];
  assert.equal(practiceReport({ people: [p], now, hours: 1 }).rows[0].etaReason, 'No positive net advancement');
  p.book.history = [person().book.history[0]];
  assert.match(practiceReport({ people: [p], now, hours: 1 }).rows[0].etaReason, /two changes/);
});

test('human pilots cannot receive an ETA; recent ability changes do not imply an order', () => {
  const p = person(); p.live.piloted = true;
  assert.equal(practiceReport({ people: [p], now, hours: 1 }).rows[0].etaMs, null);
  p.order = null; p.live = null; p.events = [];
  const r = practiceReport({ people: [p], now, hours: 1 }).rows[0];
  assert.equal(r.source, 'observed ability change'); assert.equal(r.target, null);
});

test('future events and other spells stay outside practice totals', () => {
  const p = person(); p.events.push({ kind: 'cast', spell: 'bless', outcome: 'success', t: now + 1 });
  p.book.history.push({ kind: 'spell', name: 'bless', from: 42, to: 99, at: now + 1 });
  const r = practiceReport({ people: [p], now, hours: 1 }).rows[0];
  assert.equal(r.attempts, 2); assert.equal(r.gained, 3);
});

test('keeper practice casts fill telemetry gaps without duplicating instrumented runs', () => {
  const p = person();
  p.keeperEvents = [{ kind: 'cast', spell: 'bless', outcome: 'unknown', t: now - minute }];
  assert.equal(practiceReport({ people: [p], now, hours: 1 }).rows[0].attempts, 2);
  p.events = [];
  const r = practiceReport({ people: [p], now, hours: 1 }).rows[0];
  assert.equal(r.attempts, 1); assert.equal(r.outcomes.unknown, 1); assert.equal(r.successPct, 0);
  assert.equal(r.castSource, 'keeper ledger');
});

test('a capped ability book uses only the retained observation span for its rate', () => {
  const p = person();
  p.book.history = [...Array.from({ length: 398 }, (_, i) => ({ kind: 'skill', name: 'slash', at: now - 30 * minute + i, from: 1, to: 2 })), ...p.book.history.slice(1)];
  const r = practiceReport({ people: [p], now, hours: 1 }).rows[0];
  assert.equal(r.spanHours, .5); assert.equal(r.rate, 2);
});

test('planned next school unlock estimates the explicit learning gate, not purchase time', () => {
  const p = person();
  p.events = [
    { kind: 'run_start', run: 'a', t: now - 30 * minute, school: 'shalille', goals: { until: 'rescue', until_known: true }, gate: { known: true, have: 100, need: 160, gap: 60 } },
    { kind: 'run_start', run: 'b', t: now - minute, school: 'shalille', goals: { until: 'rescue', until_known: true }, gate: { known: true, have: 129, need: 160, gap: 31 } },
  ];
  const plan = practiceReport({ people: [p], now, hours: 1 }).plans[0];
  assert.equal(plan.goal, 'rescue'); assert.equal(plan.rate, 60); assert.ok(Math.abs(plan.etaMs - 31 * minute) < 1);
  p.events[0].gate.need = 170;
  assert.equal(practiceReport({ people: [p], now, hours: 1 }).plans[0].reason, 'Learning requirement changed');
  p.events.forEach(e => e.t -= hour);
  assert.equal(practiceReport({ people: [p], now, hours: 2 }).plans[0].etaMs, null);
});

test('nearest rank percentiles reject null and negative data', () => {
  assert.equal(percentile([null, -1, 100, 200, 300, 400], .5), 200);
  assert.equal(percentile([100, 200, 300, 400], .75), 300);
  assert.equal(percentile([100, 200, 300, 400], .9), 400);
  assert.equal(percentile([], .5), null);
});

test('legacy lap dates use actual UTC end, including midnight, not the later collector timestamp', () => {
  const start = Date.parse('2026-11-01T23:58:00Z');
  const log = `zheng-he-lap-${start.toString(36)}.log`;
  const row = { log, started: '23:58:00', ended: '00:02:00', at: '2026-11-02T11:00:00Z' };
  assert.equal(courierEndTime(row), Date.parse('2026-11-02T00:02:00Z'));
  assert.equal(courierReport({ events: [{ ...row, kind: 'lap_end', completed: true }], now, hours: 1 }).summary.total, 0);
  assert.equal(courierReport({ events: [{ ...row, kind: 'lap_end', completed: true }], now, hours: 24 }).trips[0].duration, 4 * minute);
});

const lap = (id, ended, ok = true) => ({ kind: 'lap_end', run: id, agent: 'hk2', character: 'Courier', t: ended, duration_ms: 10 * minute, completed: ok });
const hit = (at, extras = {}) => ({ kind: 'combat', observer: 'Courier', at, event: 'pvp_outcome', last_outcome: { at, character: 'Enemy', direction: 'incoming', outcome: 'hit', text: 'a hit' }, ...extras });
test('quiet/PvP classification deduplicates repeated outcomes and excludes sightings, misses, and other recipients', () => {
  const a = now - 20 * minute;
  const h = hit(a);
  const pvp = [h, { ...h, at: a + 1000, event: 'finished' }, hit(a, { observer: 'Other' }), hit(a, { last_outcome: { ...h.last_outcome, outcome: 'miss' } }), { kind: 'alarm', at: a }];
  const r = courierReport({ events: [lap('a', now - 15 * minute), lap('b', now - 40 * minute), lap('c', now - 55 * minute, false)], pvp, coveredDays: ['2026-11-02'], now, hours: 1 });
  assert.equal(r.summary.pvpTrips, 1); assert.equal(r.summary.quiet, 2); assert.equal(r.summary.pvpHits, 1);
  assert.equal(r.summary.hitHours, 1); assert.equal(r.summary.inTransitHits, 1);
  assert.ok(Math.abs(r.summary.successPct - 200 / 3) < 1e-10); assert.equal(r.summary.timed, 2);
});

test('missing daily coverage means unmeasured; hits outside a lap appear only in hourly courier totals', () => {
  const r = courierReport({ events: [lap('a', now - 20 * minute)], pvp: [hit(now - minute)], now, hours: 1 });
  assert.equal(r.summary.unmeasured, 1); assert.equal(r.summary.quiet, 0); assert.equal(r.summary.pvpTrips, 0);
  assert.equal(r.summary.pvpHits, 1); assert.equal(r.summary.inTransitHits, 0);
});

test('new and old lap sources merge by log identity without losing refusals', () => {
  const r = courierReport({ events: [{ ...lap('a', now), log: 'same.log', transfer_refusals: ['refused'] }, { ...lap('a', now), log: 'same.log' }], now });
  assert.equal(r.summary.total, 1); assert.equal(r.trips[0].refusals, 1);
});

test('run parser reads only finished courier runs, timing each walk', () => {
  const log = `courier-${(now - 3 * minute).toString(36)}.log`;
  const r = parseCourierRun(log, '11:57:00 hk2 walking 39 -> 38\n11:58:10 hk2 step 1 (walk) ok\n12:00:00 courier (local): 1/1 completed\n');
  assert.equal(r.agent, 'hk2'); assert.equal(r.legs[0].secs, 70); assert.equal(r.completed, true);
  assert.equal(parseCourierRun(log, '11:57:00 hk2 walking 39 -> 38'), null);
});

test('bounded JSONL, isolated fleet reads, escaping, page scripts, and routes', () => {
  const root = mkdtempSync(join(tmpdir(), 'm59-insights-'));
  try {
    const put = (file, data) => { const p = join(root, 'substrate', file); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data)); return p; };
    const p = person(); put('abilities/Tester.json', p.book); put('abilities/Other.json', { ...p.book, character: 'Other' });
    put('history/prod/training/t1.jsonl', p.events.map(e => JSON.stringify(e)).join('\n') + '\n{bad');
    put('courier-pigeon.jsonl', JSON.stringify(lap('foreign', now)));
    const data = collectInsights({ root, fleet: 'prod', live: [p.live], characters: [{ agent: 't1', character: 'Tester' }], now, hours: 1 });
    assert.equal(data.sources.abilityBooks, 1); assert.equal(data.couriers.summary.total, 0); assert.equal(data.characters, 1);
    assert.ok(data.coverage.some(s => s.includes('incomplete')));
    assert.throws(() => collectInsights({ root, fleet: '../other' }));
    const file = put('tail.jsonl', '\n' + JSON.stringify({ t: now }) + '\n');
    assert.equal(readRows(file, 12).truncated, true);
    for (const page of ['practice', 'couriers']) {
      data.practice.rows[0].character = '<script>bad</script>';
      const html = renderInsights({ data, page });
      assert.ok(!html.includes('<script>bad</script>')); assert.ok(html.includes('aria-label="Report window"'));
      for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(script);
      assert.equal(isDashboardOnlyPath(`/${page}`), true);
      assert.equal(dashboardRedirectUrl(`/${page}?hours=2`, '127.0.0.1', 8902), `http://127.0.0.1:8902/${page}?hours=2`);
    }
    assert.equal(stamp({ at: now }), now);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('every trained skill is on the practice board (fire and archery always for bow trainees): skill rows from the ability book, no casts, target 99 (2026-11-04)', () => {
  const p = { agent: 't3', character: 'Statler', live: { snapshot_age_ms: 0, policy: { farmStrategy: 'kocatan-deep-jungle-archer' } },
    book: { skills: { archery: { ability: 30, first: now - 48 * hour, at: now }, fire: { ability: 99, first: now - 48 * hour, at: now } },
      history: [
        { kind: 'skill', name: 'archery', from: 27, to: 28, by: 1, at: now - 50 * minute },
        { kind: 'skill', name: 'archery', from: 28, to: 29, by: 1, at: now - 30 * minute },
        { kind: 'skill', name: 'archery', from: 29, to: 30, by: 1, at: now - 5 * minute },
      ] } };
  const rows = practiceReport({ people: [p], now, hours: 1 }).rows;
  const arch = rows.find(r => r.spell === 'archery'), fire = rows.find(r => r.spell === 'fire');
  assert.ok(arch && fire, 'a bow trainee gets both skill rows, even fire with no change in the window');
  assert.equal(arch.kind, 'skill'); assert.equal(arch.gained, 3); assert.equal(arch.rate, 3);
  assert.equal(arch.current, 30); assert.equal(arch.target, 99); assert.equal(arch.attempts, 0);
  assert.equal(arch.state, 'Active'); assert.equal(arch.etaMs, 69 / 3 * hour);
  assert.equal(fire.etaReason, 'Target reached');
  const melee = { ...p, agent: 't12', character: 'Fozzie', live: { snapshot_age_ms: 0, policy: { farmStrategy: 'kocatan-deep-jungle' } }, book: { skills: { fire: { ability: 10 } }, history: [] } };
  assert.equal(practiceReport({ people: [melee], now, hours: 1 }).rows.filter(r => r.kind === 'skill').length, 0, 'no skill row for a melee striker whose skills did not move');
  // EVERY TRAINED SKILL, not only the bow pair: a striker whose parry moved gets a parry row, labelled as observed.
  melee.book = { skills: { parry: { ability: 61, first: now - 48 * hour } }, history: [{ kind: 'skill', name: 'parry', from: 60, to: 61, by: 1, at: now - 10 * minute }] };
  const parry = practiceReport({ people: [melee], now, hours: 1 }).rows.filter(r => r.kind === 'skill');
  assert.equal(parry.length, 1); assert.equal(parry[0].spell, 'parry'); assert.equal(parry[0].gained, 1);
  assert.equal(parry[0].source, 'observed skill change'); assert.equal(parry[0].state, 'Active');
});
