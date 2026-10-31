#!/usr/bin/env node
// THE FINE NAVIGATION GRAPH: what the bake promises and what the query does with it. Offline.
//
//   node tools/m59-finenav-test.mjs
//
// Bakes 578 (The Cragged Mountains), 2144 (The Clearing of the Trading Post) and 599 (Ukgoth,
// for its door state) in-process from substrate/m59-map.json — it never reads or writes the
// table on disk — and pins the properties docs/m59-fine-nav-design.md depends on:
//
//   * a representative is a place a body can BE and never sits on a wall line (578's r2c10
//     stand point sits on one-sided wall 499, which is how the square planner planned from a
//     place no body was);
//   * every edge executes from its footing's representative and lands where it says, by the
//     mover's own slide-and-quantize arithmetic (`replayLegs`);
//   * falls are one-way; exits attach to footings; door states are baked, not frozen;
//   * the query's fallback to the square planner is FLAGGED, never silent;
//   * nothing on the hot path imports the graph yet (this stage changes no movement).
//
// Runs at below-normal priority: it shares cores with the live fleet.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
const HERE = dirname(fileURLToPath(import.meta.url));
const MAP_FILE = join(HERE, '..', 'substrate', 'm59-map.json');
const map = existsSync(MAP_FILE) ? (await import('./m59-map.mjs')).loadMap() : null;
const skip = !map?.rooms?.[578] || !map?.rooms?.[2144] ? 'no substrate/m59-map.json with rooms 578 and 2144' : false;

const FN = await import('./m59-finenav.mjs');
const { bakeRoom, bakeRoomAllStates } = await import('./m59-finenav-bake.mjs');
const { sharedRoomGeometry, MAX_STEP_HEIGHT } = await import('./m59-roo.mjs');
const { routesFor } = await import('./m59-routes.mjs');

const graphs = new Map();
function graphOf(n) {
  if (!graphs.has(n)) {
    const room = map.rooms[n];
    const raw = bakeRoom(room, sharedRoomGeometry(room));
    graphs.set(n, { raw, g: FN.decodeRoom(FN.encodeRoom(raw), n) });
  }
  return graphs.get(n);
}
const geoOf = n => sharedRoomGeometry(map.rooms[n]);

test('encode/decode round-trips a room exactly (2144)', { skip }, () => {
  const { raw, g } = graphOf(2144);
  assert.equal(g.footings.length, raw.footings.length);
  raw.footings.forEach((f, i) => {
    const d = g.footings[i];
    assert.deepEqual([d.row, d.col, d.rep, d.floor], [f.row, f.col, f.rep, f.floor], `footing ${i}`);
    assert.equal(d.edges.length, f.edges.length, `footing ${i} edges`);
    f.edges.forEach((e, k) => {
      const de = d.edges[k];
      assert.equal(de.to, e.to); assert.equal(de.kind, e.kind);
      if (e.kind === FN.EDGE.SLIDE) { assert.equal(de.aim, e.aim); assert.deepEqual(de.land, e.land); }
      assert.deepEqual(de.via ?? [], e.via ?? [], `footing ${i} edge ${k} via`);
    });
  });
  assert.deepEqual(g.exits, raw.exits);
});

test('every representative is a place a body can be, and none is on a wall line (578, 2144)', { skip }, () => {
  for (const n of [578, 2144]) {
    const { g } = graphOf(n), geo = geoOf(n);
    const lines = (geo.walls ?? []).filter(w => !(w.passable && Number.isFinite(w.sector1?.floorHeight)
      && Number.isFinite(w.sector2?.floorHeight) && Math.abs(w.sector1.floorHeight - w.sector2.floorHeight) <= MAX_STEP_HEIGHT));
    for (const f of g.footings) {
      for (const [px, py] of [[2, 0], [-2, 0], [0, 2], [0, -2]])
        assert.ok(geo.traceFineMoveClient(f.rep.x, f.rep.y, f.rep.x + px, f.rep.y + py, FN.STRAIGHT).arrived,
          `${n} ${FN.footingKey(g, f.id)} rep (${f.rep.x},${f.rep.y}) is inside a body radius of a wall`);
      for (const w of lines) {
        const dx = w.x1 - w.x0, dy = w.y1 - w.y0, len2 = dx * dx + dy * dy;
        if (!(len2 > 0)) continue;
        const t = Math.max(0, Math.min(1, ((f.rep.x - w.x0) * dx + (f.rep.y - w.y0) * dy) / len2));
        assert.ok(Math.hypot(w.x0 + t * dx - f.rep.x, w.y0 + t * dy - f.rep.y) > 2, `${n} ${FN.footingKey(g, f.id)} rep on a wall line`);
      }
    }
  }
});

test('every edge executes from its footing representative and lands where it says (578)', { skip }, () => {
  const { g } = graphOf(578), geo = geoOf(578);
  let n = 0;
  for (const a of g.footings) for (const e of a.edges) {
    if (e.kind === FN.EDGE.FALL_UNTIMED) continue;
    const r = FN.replayLegs(geo, a.rep, FN.edgeLegs(g, e));
    assert.ok(r.ok, `${FN.footingKey(g, a.id)} -> ${FN.footingKey(g, e.to)} (${FN.EDGE_NAME[e.kind]}): ${r.reason} at leg ${r.at}`);
    n++;
  }
  assert.ok(n > 15000, `${n} edges executed`);
});

test('a fall is one-way: lower ground, and no walk straight back up (578)', { skip }, () => {
  const { g } = graphOf(578);
  let falls = 0;
  for (const a of g.footings) for (const e of a.edges) {
    if (e.kind !== FN.EDGE.FALL && e.kind !== FN.EDGE.FALL_UNTIMED) continue;
    falls++;
    const b = g.footings[e.to];
    assert.ok(b.floor < a.floor - MAX_STEP_HEIGHT, `${FN.footingKey(g, a.id)} falls onto ${b.floor} from ${a.floor}`);
    assert.ok(!b.edges.some(x => x.to === a.id && x.kind === FN.EDGE.WALK && !x.via), `${FN.footingKey(g, e.to)} walks back up to ${FN.footingKey(g, a.id)}`);
  }
  assert.ok(falls > 100, `${falls} falls in the Cragged Mountains`);
  // PROVED WITH THE LIVE MOVER'S OPTIONS (slide:true, fall:true). A fall that slides along the
  // lip lands somewhere other than its aim; the edge records that landing and goes on from it,
  // and test 3 above executes every one of them. With slide:false these were not edges at all.
  const slid = g.footings.flatMap(a => a.edges.filter(e => (e.kind === FN.EDGE.FALL || e.kind === FN.EDGE.FALL_UNTIMED) && e.land));
  assert.ok(slid.length > 20, `${slid.length} falls in 578 land somewhere other than their aim`);
  for (const e of slid) assert.notDeepEqual(e.land, g.footings[e.aim].rep);
});

test("578's r2c10 is two footings, either side of the one-sided wall at x=9728", { skip }, () => {
  const { g } = graphOf(578);
  const here = FN.footingsIn(g, 2, 10).map(id => g.footings[id]);
  assert.ok(here.some(f => f.rep.x < 9728) && here.some(f => f.rep.x > 9728),
    `r2c10 footings: ${here.map(f => `(${f.rep.x},${f.rep.y})`).join(' ')}`);
});

test('exits attach to footings: every declared exit of 578 and 2144 has one', { skip }, () => {
  for (const n of [578, 2144]) {
    const { raw, g } = graphOf(n);
    assert.deepEqual(raw.stats.exits_unattached, [], `${n} unattached exits`);
    for (const x of g.exits) assert.ok(g.footings[x.footing], `${n} exit to ${x.to} names a footing`);
  }
  // 2144's west door to the trading post is a door on the ground floor the room walks to
  const { g } = graphOf(2144);
  const west = g.exits.filter(x => x.to === 2101 && x.kind === 'go' && x.col === 39 && (x.row === 30 || x.row === 31));
  assert.ok(west.length >= 1, 'the west door r30c39/r31c39 is attached');
});

test('a planned route executes end to end from the body, not from a stand point (578 r26c50 -> r49c44)', { skip }, () => {
  const { g } = graphOf(578), geo = geoOf(578);
  const from = geo.standPoint(26, 50);
  const p = FN.planFine({ geo, graph: g, from, goal: { row: 49, col: 44 } });
  assert.equal(p.source, 'finenav', p.fallback_reason ?? p.why);
  assert.ok(p.ok);
  const r = FN.replayLegs(geo, from, p.legs);
  assert.ok(r.ok, `${r.reason} at leg ${r.at}`);
  // and the square graph's own baked route for this pair cannot be followed by the body:
  // the before-number this graph exists to remove (docs/m59-fine-nav-design.md, (c))
});

test('the fallback to the square planner is flagged, never silent', { skip }, () => {
  const { g } = graphOf(578), geo = geoOf(578);
  const from = geo.standPoint(26, 50);
  const none = FN.planFine({ geo, graph: null, from, goal: { row: 49, col: 44 } });
  assert.equal(none.source, 'square_fallback'); assert.equal(none.fallback, true);
  assert.match(none.fallback_reason, /no fine-nav graph/);
  const strict = FN.planFine({ geo, graph: null, from, goal: { row: 49, col: 44 }, squareFallback: false });
  assert.equal(strict.ok, false); assert.equal(strict.source, 'finenav'); assert.ok(strict.why);
  // a goal with no footing (every square of 578 is standable, so one off the grid)
  const miss = FN.planFine({ geo, graph: g, from, goal: { row: 1, col: geo.cols + 1 } });
  assert.equal(miss.source, 'square_fallback'); assert.equal(miss.fallback, true); assert.ok(miss.fallback_reason);
});

test('door states are baked per variant, and a plan says which it assumed (599)', { skip: !map?.rooms?.[599] ? 'no room 599' : false }, () => {
  const routes = routesFor(map.geometryManifestSha256);
  if (!routes?.rooms?.[599]?.stepMaskVariants) return;   // no door variants in this table
  const raw = bakeRoomAllStates(map, routes, 599);
  const table = { rooms: { 599: FN.encodeRoom(raw) }, _decoded: new Map() };
  for (const k of Object.keys(routes.rooms[599].stepMaskVariants)) assert.ok(raw.variants?.[k], `variant ${k} baked`);
  assert.deepEqual(raw.moving?.unmodelled, [], 'every moving sector of 599 is covered by a baked state');
  const base = FN.fineNavRoom(table, 599);
  assert.ok(base.graph); assert.equal(base.door_state_assumed, true);
  const key = Object.keys(raw.variants)[0];
  const v = FN.fineNavRoom(table, 599, { doorState: key });
  assert.ok(v.graph); assert.equal(v.door_state_assumed, false); assert.equal(v.graph.variant, key);
  const bad = FN.fineNavRoom(table, 599, { doorState: 'sector99@1' });
  assert.equal(bad.graph, null); assert.match(bad.why, /no baked door state/);
});

test('loadFineNav refuses a table of another version or another geometry', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'm59-finenav-'));
  const write = (name, t) => { const f = join(dir, name); writeFileSync(f, gzipSync(Buffer.from(JSON.stringify(t)))); return f; };
  const good = { format: FN.FINE_NAV_FORMAT, version: FN.FINE_NAV_VERSION, geometryManifestSha256: map.geometryManifestSha256, rooms: {} };
  assert.ok(FN.loadFineNav(map, { file: write('ok.json.gz', good) }).table);
  const v = FN.loadFineNav(map, { file: write('v.json.gz', { ...good, version: FN.FINE_NAV_VERSION + 1 }) });
  assert.equal(v.table, null); assert.match(v.why, /rebake/);
  const m = FN.loadFineNav(map, { file: write('m.json.gz', { ...good, geometryManifestSha256: 'not-this-map' }) });
  assert.equal(m.table, null); assert.match(m.why, /different geometry/);
  const missing = FN.loadFineNav(map, { file: join(dir, 'absent.json.gz') });
  assert.equal(missing.table, null); assert.match(missing.why, /no fine-nav table/);
});

test('nothing on the hot path imports the fine-nav graph yet', () => {
  for (const f of ['m59-broker.mjs', 'm59-keeper-process.mjs', 'm59-game.mjs', 'm59-session-walk.mjs',
                   'm59-world.mjs', 'm59-autopilot.mjs', 'm59-routes.mjs', 'm59-roo.mjs']) {
    const p = join(HERE, f);
    if (!existsSync(p)) continue;
    assert.ok(!/m59-finenav/.test(readFileSync(p, 'utf8')), `${f} imports m59-finenav — this stage changes no movement`);
  }
});
