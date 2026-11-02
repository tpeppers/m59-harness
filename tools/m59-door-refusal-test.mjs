#!/usr/bin/env node
// m59-door-refusal-test.mjs — the door-press refusal record (m59-door-refusal.mjs), offline.
//
// The guild hall and the Ko'catan tower suites (m59-ceiling-doors-test, m59-kocatan-door-test)
// pin that a refused press WRITES a `door_press_refused` row through the real crossing code. This
// one pins the record itself: its bounds (a refusal loop cannot flood the ledger, a crowded room
// cannot grow a row), that it never throws on a half-built session, that a silent press is
// `not_verified` and a spoken refusal `server_refused`, the reader, and that `--export` redacts
// players to roles while keeping monsters, numbers and units.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = mkdtempSync(join(tmpdir(), 'm59-door-refusal-'));
process.env.M59_LEDGER_DIR = scratch;
const dr = await import('./m59-door-refusal.mjs');
const { recordEvent } = await import('./m59-ledger.mjs');

const CANT = 'You are unable to go anywhere.';
function scene({ objects = [], said = [CANT], name = 'Tester' } = {}) {
  const events = said.map((text, i) => ({ seq: i + 1, kind: 'message', text }));
  const c = { me: name ? { name } : null, selfId: 1, evSeq: events.length,
    self: { row: 4, col: 28, x: 28 * 64 + 32, y: 4 * 64 + 32 },
    room: { id: 5150, objects: new Map(objects.map((o, i) => [100 + i, { id: 100 + i, ...o }])) },
    lastPostureCommand: { verb: 'stand', at: Date.now(), room_object_id: 5150 },
    vitals: () => ({ health: { value: 40, max: 75 }, vigor: { value: 120 } }),
    ailments: () => [{ name: 'webbed' }],
    eventsSince: since => events.filter(e => e.seq > since) };
  const s = { name: 't3', client: c, movementGeneration: 4, world: { room: { num: 714, name: 'Guild Hall' } },
    job: { label: 'walk to 714', kind: 'travel', to: 714, origin: { source: 'fleetscript', name: 'tree-farm' }, done: false } };
  return { s, c };
}

test('a spoken refusal is server_refused, a silent press not_verified, and the row says why', () => {
  dr.resetDoorRefusalWindows();
  const rows = [];
  const record = (character, kind, detail) => rows.push({ character, kind, ...detail });
  const { s, c } = scene();
  const pose = dr.doorPressPose(s, c);
  const a = dr.noteDoorPressRefused(s, { source: 'guild_passage', since: 0, pose, record,
    door: { sector: 59, kind: 'guild', direction: 'inward' }, trigger: [3, 28], across: [5, 28], attempt: 1, attempts: 3 });
  assert.equal(a.written, true); assert.equal(a.verdict, 'server_refused');
  assert.equal(rows[0].kind, 'door_press_refused'); assert.equal(rows[0].character, 'Tester');
  assert.equal(a.summary, 'body at r4c28, trigger r3c28, seated:false, held, 0 bodies within 2 sq');
  assert.deepEqual(rows[0].actual.at_press.off_trigger, { rows: 1, cols: 0, squares: 1 });
  assert.equal(rows[0].posture.held, true, 'webbed sets PFLAG_NO_MOVE like a rest; the row says so');
  assert.equal(rows[0].movement.job.ordered_by, 'fleetscript:tree-farm', 'what else was steering the body');
  assert.equal(rows[0].vitals.health, 40);

  const silent = scene({ said: [] });
  const b = dr.noteDoorPressRefused(silent.s, { source: 'guild_passage', since: 0, record,
    door: { sector: 59 }, trigger: [3, 28], openingReason: 'no matching opening event' });
  assert.equal(b.verdict, 'not_verified');
  assert.equal(rows[1].opening_reason, 'no matching opening event');
  assert.equal(rows[1].server_message, null);
});

test('bounded: a crowded room lists ten objects and a refusal loop writes six rows a window', () => {
  dr.resetDoorRefusalWindows();
  const crowd = Array.from({ length: 40 }, (_, i) => ({ row: 3 + (i % 3), col: 27 + (i % 3), flags: 8, name: `troll ${i}` }));
  const { s } = scene({ objects: crowd });
  const rows = [];
  const record = (character, kind, detail) => rows.push(detail);
  let suppressed = 0;
  for (let i = 0; i < 20; i++) {
    const r = dr.noteDoorPressRefused(s, { source: 'guild_passage', since: 0, record, door: { sector: 59 },
      trigger: [3, 28], now: 1_000_000 + i * 1000 });
    if (r.suppressed) suppressed++;
  }
  assert.equal(rows.length, dr.ROWS_PER_WINDOW, 'six rows in the window, however long the loop');
  assert.equal(suppressed, 20 - dr.ROWS_PER_WINDOW);
  assert.equal(rows[0].nearby.objects.length, 10, 'the object list is capped');
  assert.equal(rows[0].nearby.total, 40, 'and says how many it saw');
  assert.equal(rows[0].nearby.bodies_within_2, 40);
  // The next window's first row carries how many were held back.
  dr.noteDoorPressRefused(s, { source: 'guild_passage', since: 0, record, door: { sector: 59 },
    trigger: [3, 28], now: 1_000_000 + dr.WINDOW_MS + 1 });
  assert.equal(rows.at(-1).suppressed_since_last, 20 - dr.ROWS_PER_WINDOW);
  assert.ok(JSON.stringify(rows[0]).length < 16_000, `a row stays small: ${JSON.stringify(rows[0]).length} bytes`);
});

test('never throws, and writes nothing without a character name', () => {
  dr.resetDoorRefusalWindows();
  const rows = [];
  const record = () => rows.push(1);
  assert.doesNotThrow(() => dr.noteDoorPressRefused(null, { record }));
  assert.doesNotThrow(() => dr.noteDoorPressRefused({ client: { self: null, room: { objects: 'nope' } } }, { record, trigger: 'x' }));
  const r = dr.noteDoorPressRefused(scene({ name: null }).s, { since: 0, record, trigger: [3, 28] });
  assert.equal(r.written, false); assert.equal(rows.length, 0);
  assert.equal(dr.noteDoorPressRefused(scene().s, { since: 0, trigger: [3, 28], record: () => { throw new Error('disk'); } }).written, false,
    'a failing writer is a row not written, never an exception into the crossing');
});

test('the reader finds the rows in the ledger, and the export redacts players and keeps the rest', async () => {
  dr.resetDoorRefusalWindows();
  const { s } = scene({ objects: [{ row: 3, col: 29, flags: 4, name: 'Statler' }, { row: 3, col: 27, flags: 4, name: 'Stranger Person' },
                                  { row: 4, col: 29, flags: 8, name: 'troll' }] });
  const r = dr.noteDoorPressRefused(s, { source: 'guild_passage', since: 0, door: { sector: 59 }, trigger: [3, 28],
    record: recordEvent });
  assert.equal(r.written, true);
  const rows = dr.readDoorRefusals({ dir: scratch, room: 714 });
  assert.equal(rows.length, 1); assert.equal(rows[0].id, r.detail.id);
  assert.equal(dr.readDoorRefusals({ dir: scratch, room: 1 }).length, 0, 'filtered by room number');
  assert.equal(dr.readDoorRefusals({ dir: scratch, id: r.detail.id.slice(0, 6), sinceMs: 0 }).length, 1, 'by id prefix');

  const fx = await dr.exportDoorRefusal(rows[0], { names: new Set(['Statler', 'Tester', 't3']) });
  const text = JSON.stringify(fx);
  for (const n of ['Statler', 'Tester', 'Stranger Person', '"t3"']) assert.ok(!text.includes(n), `${n} is redacted`);
  assert.equal(fx.subject.name, 'player A');
  assert.deepEqual(fx.nearby.objects.map(o => o.name).sort(), ['player B', 'stranger A', 'troll'],
    'fleet-mates and strangers become roles; a monster keeps its name');
  assert.equal(fx.replay.room, 714); assert.deepEqual(fx.replay.stand_on, { row: 3, col: 28, at: 'r3c28' });
  assert.match(fx.units_note, /64 units per square/);
  assert.equal(fx.format, dr.FIXTURE_FORMAT);
});
