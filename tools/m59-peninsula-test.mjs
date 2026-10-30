#!/usr/bin/env node
// A RAISED POCKET YOU CAN FALL OUT OF BUT NEVER CLIMB INTO MUST NOT CHOOSE THE DOOR. Offline:
// a synthetic peninsula, then the real Clearing of the Trading Post (2144) from
// substrate/m59-map.json and the baked step masks, as a keeper runs them. No socket, no roster.
//
//   node tools/m59-peninsula-test.mjs
//
// THE INCIDENT, 2026-10-30. All day, walks from 2144 to Wulfgang's trading post (2101) ended
// `route_progressing_exits_exhausted`, and the ledger's refusals were the same three squares
// every time: r38c49, r30c39, r27c49. Pepe stood at r26c50 for 279s; Piggy at r26c48.
//
// THE QUESTION THE OPERATOR ASKED: is "a wall built of height increases over the step limit is
// not a wall to the router" the cause? Measured here, and the answer is no AT THE STEP: the
// palisade (365 on a 300 floor, 65 kod against 24) is unclimbable in the mask and a fall off
// it is allowed, exactly as the client allows. What is wrong is the two places that reason
// about a room by flooding FORWARD from one seed, and the peninsula is precisely the shape
// that breaks them -- the operator's instinct about "a peninsula, not an island" was right:
//
//   1. THE BAKE'S BODY. `from_body` is the largest forward flood. A pocket you fall out of
//      floods itself plus the whole floor below, so it out-floods the floor. 2144's palisade
//      line won (2163 squares to 2153), its door r38c49 was `from_body`, and `anchorFor` made
//      it THE anchor for 2101. Fixed by counting backwards: `reverseReachCounts` / `reached_by`.
//   2. THE LIVE ORDER. `leaveViaAny` flagged that anchor `from_anchor`, which `orderExits`
//      ranks above the live `verified` verdict, and `path()`'s goal exemption makes six doors
//      the mover cannot step into "reachable". Fixed by letting the live verdict from where
//      the body stands outrank the position-free one: `anchorContradictedLive`,
//      `provenDoorsBeforeExempt`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'm59-peninsula-'));
for (const [k, v] of Object.entries({ M59_LEDGER_DIR: 'ledger', M59_TACTICS_DIR: 'tactics', M59_TRAILS_DIR: 'trails',
  M59_SPOT_CLAIMS_DIR: 'claims', M59_SHELTER_DIR: 'shelter', M59_CROSSINGS_LEARNED: 'crossings.json' }))
  process.env[k] = join(scratch, v);
process.env.M59_RUNTIME_PROFILE = 'lab'; process.env.M59_EXIT_FALLBACK = '0'; process.env.M59_EXIT_DEBUG = '0';

const { World, anchorContradictedLive, provenDoorsBeforeExempt } = await import('./m59-world.mjs');
const { Session } = await import('./m59-game.mjs');
const { reverseReachCounts } = await import('./m59-routebake.mjs');
const { attachStepMasks, anchorFor } = await import('./m59-routes.mjs');
const { sharedRoomGeometry, MAX_STEP_HEIGHT } = await import('./m59-roo.mjs');
const { geometryFor } = await import('./m59-safespots.mjs');
const { loadMap } = await import('./m59-map.mjs');
const { configureSpotClaimStore } = await import('./m59-spotclaims.mjs');
configureSpotClaimStore({ enabled: false });

// ---------------------------------------------------------------- the synthetic peninsula
//
// A 6x6 floor (cols 1-6) and a three-square raised strip at col 7, rows 1-3. The strip is
// walkable along itself and drops onto the floor beside it; the floor cannot climb onto it.
// Door P is on the strip, door G on the floor; both lead to room 99.
function peninsula() {
  const rows = 6, cols = 7;
  const raised = (r, c) => c === 7 && r <= 3;
  const standable = (r, c) => r >= 1 && r <= rows && c >= 1 && c <= cols && (c <= 6 || raised(r, c));
  const neighbors = (r, c) => {
    const out = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (!standable(nr, nc)) continue;
      if (raised(nr, nc) && !raised(r, c)) continue;          // the climb the client refuses
      out.push({ row: nr, col: nc });                          // walk, or the fall off the strip
    }
    return out;
  };
  return { rows, cols, standable, neighbors: (r, c) => neighbors(r, c) };
}
const forward = (g, r, c) => {
  const seen = new Set([`${r},${c}`]), stack = [[r, c]];
  while (stack.length) {
    const [a, b] = stack.pop();
    for (const n of g.neighbors(a, b)) {
      const k = `${n.row},${n.col}`;
      if (!seen.has(k)) { seen.add(k); stack.push([n.row, n.col]); }
    }
  }
  return seen;
};
const P = { kind: 'go', to: 99, row: 2, col: 7 }, G = { kind: 'go', to: 99, row: 5, col: 1 };

test('peninsula: the largest FORWARD flood is seeded on the strip, not the floor', () => {
  const g = peninsula();
  const fromStrip = forward(g, 2, 7), fromFloor = forward(g, 4, 3);
  assert.equal(fromFloor.size, 36, 'the floor reaches only itself');
  assert.equal(fromStrip.size, 39, 'the strip reaches itself AND the whole floor');
  assert.ok(!fromFloor.has('2,7'), 'nobody on the floor can step onto the strip');
  // This is the old rule's defect, stated as a fact: "whichever square floods the most" is the
  // pocket, so a door on it is `from_body`.
  assert.ok(fromStrip.size > fromFloor.size);
});

test('peninsula: counted backwards, the strip door is reached by 3 squares and the floor door by 39', () => {
  const counts = reverseReachCounts(peninsula(), [P, G, P]);
  assert.equal(counts.get('2,7'), 3);
  assert.equal(counts.get('5,1'), 39);
  assert.equal(counts.size, 2, 'one count per distinct square');
});

test('anchorFor: among same-room anchors the most-reached wins; an old table ranks as before', () => {
  const table = anchors => ({ rooms: { 1: { anchors } } });
  const withCounts = table([{ ...P, from_body: true, reached_by: 3 }, { ...G, from_body: true, reached_by: 39 }]);
  assert.deepEqual([anchorFor(withCounts, 1, 99).row, anchorFor(withCounts, 1, 99).col], [5, 1]);
  const old = table([{ ...P, from_body: true }, { ...G, from_body: true }]);
  assert.deepEqual([anchorFor(old, 1, 99).row, anchorFor(old, 1, 99).col], [2, 7], 'no field, first from_body');
  // from_body still outranks a count: a stranded door is never chosen over a reachable one.
  const mixed = table([{ ...P, from_body: false, reached_by: 900 }, { ...G, from_body: true, reached_by: 39 }]);
  assert.equal(anchorFor(mixed, 1, 99).col, 1);
  const none = table([{ ...P, from_body: false, reached_by: 3 }, { ...G, from_body: false, reached_by: 39 }]);
  assert.equal(anchorFor(none, 1, 99).col, 1, 'no from_body at all: still the most-reached');
});

// ---------------------------------------------------------------- the live ordering helpers
const door = (row, col, verified, extra = {}) =>
  ({ kind: 'go', to: 2101, stand_on: { row, col }, reachable: true, verified, ...extra });

test('anchorContradictedLive: only when the anchor is refused from here AND a proven door exists', () => {
  const spread = [door(38, 49, false), door(27, 49, false), door(30, 39, true)];
  assert.equal(anchorContradictedLive(spread, 2101, { row: 38, col: 49 }), true);
  assert.equal(anchorContradictedLive(spread, 2101, { row: 30, col: 39 }), false, 'a proven anchor stands');
  assert.equal(anchorContradictedLive(spread.slice(0, 2), 2101, { row: 38, col: 49 }), false,
    'every door is goal-exempt: the bake is the best guess there is, keep it');
  assert.equal(anchorContradictedLive(spread, 2101, { row: 1, col: 1 }), false, 'not offered live: nothing to contradict');
  assert.equal(anchorContradictedLive([door(38, 49, null), door(30, 39, true)], 2101, { row: 38, col: 49 }), false,
    'unknown is not refused');
  const edge = [{ kind: 'edge', to: 61, stand_on: { row: 1, col: 1 }, reachable: true, grid_only: true, verified: false },
                { kind: 'edge', to: 61, stand_on: { row: 2, col: 42 }, reachable: true, verified: true }];
  assert.equal(anchorContradictedLive(edge, 61, { row: 1, col: 1 }), false, 'edge anchors are the bake\'s walked line; untouched');
});

test('provenDoorsBeforeExempt: refused doors sink behind every proven one, per destination, nothing dropped', () => {
  const other = { kind: 'go', to: 2102, stand_on: { row: 33, col: 42 }, reachable: true, verified: false };
  const list = [door(38, 49, false, { from_anchor: true }), door(30, 39, true), door(27, 49, false), other, door(31, 39, true)];
  const out = provenDoorsBeforeExempt(list);
  assert.equal(out.length, list.length);
  assert.deepEqual(out.map(e => `r${e.stand_on.row}c${e.stand_on.col}`),
    ['r30c39', 'r33c42', 'r31c39', 'r38c49', 'r27c49'],
    'r33c42 leads to 2102, which has no proven door, so it is not this rule\'s business');
  const head = provenDoorsBeforeExempt(list, 1);
  assert.equal(head[0], list[0], 'entries before `from` stay put');
  assert.deepEqual(provenDoorsBeforeExempt([door(38, 49, false), door(27, 49, false)]).map(e => e.stand_on.row), [38, 27]);
  assert.deepEqual(provenDoorsBeforeExempt(null), []);
});

// ---------------------------------------------------------------- the real room
const map = existsSync(join(HERE, '..', 'substrate', 'm59-map.json')) ? loadMap() : null;
const attached = map ? attachStepMasks(map) : null;
const skip = !map?.rooms?.[2144] ? 'no room 2144 in the map on disk'
  : !attached?.ok ? `no routing table attached (${attached?.why})` : false;
const DOORS_2101 = () => map.rooms[2144].goExits.filter(g => Number(g.to) === 2101);
const WEST = new Set(['30,39', '31,39']);
// Pepe and Piggy's own squares at 18:30Z, and where each was standing in kod fine units.
const STUCK = [{ who: 'Pepe', row: 26, col: 50, x: 3236, y: 1718 }, { who: 'Piggy', row: 26, col: 48, x: 3125, y: 1672 }];

test('2144: the palisade IS a wall to the mover -- climb refused, fall allowed', { skip }, () => {
  const geo = sharedRoomGeometry(map.rooms[2144]);
  const floor = (r, c) => { const p = geo.standPoint(r, c); return geo.floorBaseAtClient(p.x, p.y); };
  assert.ok(floor(26, 49) - floor(26, 48) > MAX_STEP_HEIGHT, `palisade ${floor(26, 49)} over floor ${floor(26, 48)}`);
  assert.equal(geo.moverStepLands(26, 48, 26, 49), false, 'onto the palisade from inside the fort');
  assert.equal(geo.moverStepLands(26, 50, 26, 49), false, 'onto the palisade from outside it');
  assert.equal(geo.moverStepLands(26, 49, 26, 48), true, 'off it is a fall the client allows');
});

for (const s of STUCK) {
  test(`2144 from ${s.who}'s r${s.row}c${s.col}: the mover can step into the west door and no other door to 2101`, { skip }, () => {
    const geo = sharedRoomGeometry(map.rooms[2144]);
    const seen = new Set([`${s.row},${s.col}`]), stack = [[s.row, s.col]];
    while (stack.length) {
      const [r, c] = stack.pop();
      for (const n of geo.neighbors(r, c, { collision: true })) {
        const k = `${n.row},${n.col}`;
        if (!seen.has(k)) { seen.add(k); stack.push([n.row, n.col]); }
      }
    }
    for (const d of DOORS_2101()) {
      const k = `${d.row},${d.col}`;
      assert.equal(seen.has(k), WEST.has(k), `r${d.row}c${d.col}`);
      const p = geo.path(s.row, s.col, d.row, d.col, { clearance: 0 });
      assert.equal(p.found, true, `the router still OFFERS r${d.row}c${d.col} -- a door is never deleted`);
      assert.equal(p.goal_exempt === true, !WEST.has(k), `r${d.row}c${d.col} goal-exempt only off the west door`);
    }
  });
}

test('2144: the mask is not hiding a door -- a body-sized fine flood over the whole fort enters the west door and no other', { skip }, () => {
  const geo = sharedRoomGeometry(map.rooms[2144]);
  // Client units, 1024 to a square; a lattice of 128 is half the 248-unit body radius. The box
  // is the fort and a ring outside it (r20-r44, c30-c56), so the ramp up to the north wall walk
  // at r24c32-36 -- which the body CAN climb and the square router cannot see -- is inside it:
  // the doors are unreachable even by the ground the router misses.
  const STEP = 128, x0 = 29 * 1024, x1 = 56 * 1024 - STEP, y0 = 19 * 1024, y1 = 44 * 1024 - STEP;
  const start = [47.5 * 1024, 25.5 * 1024];
  const key = (x, y) => `${x},${y}`, seen = new Set([key(...start)]), q = [start];
  for (let i = 0; i < q.length; i++) {
    const [x, y] = q[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = x + dx * STEP, ny = y + dy * STEP;
      if (nx < x0 || nx > x1 || ny < y0 || ny > y1 || seen.has(key(nx, ny))) continue;
      if (!geo.traceFineMoveClient(x, y, nx, ny, { slide: false })?.arrived) continue;
      seen.add(key(nx, ny)); q.push([nx, ny]);
    }
  }
  const inSquare = (row, col) => [...seen].some(k => {
    const [x, y] = k.split(',').map(Number);
    return Math.floor(x / 1024) + 1 === col && Math.floor(y / 1024) + 1 === row;
  });
  assert.ok(seen.size > 1000, `the flood walked the courtyard (${seen.size} points)`);
  for (const d of DOORS_2101())
    assert.equal(inSquare(d.row, d.col), WEST.has(`${d.row},${d.col}`), `door r${d.row}c${d.col}`);
});

test('2144: counted backwards, r38c49 is reached by the palisade alone and the west door by the room', { skip }, () => {
  const geo = sharedRoomGeometry(map.rooms[2144]);
  const counts = reverseReachCounts(geo, DOORS_2101());
  assert.ok(counts.get('38,49') <= 16, `r38c49 reached_by ${counts.get('38,49')}`);
  assert.ok(counts.get('31,39') >= 2000 && counts.get('30,39') >= 2000, `west door ${counts.get('31,39')}/${counts.get('30,39')}`);
  for (const d of DOORS_2101()) if (!WEST.has(`${d.row},${d.col}`))
    assert.ok(counts.get(`${d.row},${d.col}`) <= 40, `r${d.row}c${d.col} reached_by ${counts.get(`${d.row},${d.col}`)}`);
  // And the anchor a table carrying those counts would choose, with the bake's own from_body:
  // the palisade door is from_body (it is in the pocket-seeded "body") and still loses.
  const anchors = DOORS_2101().map(d => ({ kind: 'go', to: 2101, row: d.row, col: d.col,
    from_body: ['38,49', '31,39', '30,39'].includes(`${d.row},${d.col}`), reached_by: counts.get(`${d.row},${d.col}`) }));
  const a = anchorFor({ rooms: { 2144: { anchors } } }, 2144, 2101);
  assert.ok(WEST.has(`${a.row},${a.col}`), `anchor r${a.row}c${a.col}`);
});

// The real walker against a fake client, as m59-edge-stage-test does it. `leaveVia` is stubbed
// to refuse every square with a body, which is what the west door did on prod; the question is
// only which squares the three-walk budget buys.
function walker(x, y) {
  const room = map.rooms[2144], geo = geometryFor(room);
  const self = { id: 1, flags: 4, x, y, row: Math.floor(y / 64), col: Math.floor(x / 64), predicted: false };
  const c = { selfId: 1, self, evSeq: 0, rsc: new Map(), roomNameRsc: room.nameRsc, roomRsc: room.roomRsc,
    room: { id: 2144, security: geo.security, flags: 0, objects: new Map([[1, self]]) },
    vitals: () => ({ health: { value: 20, max: 20 }, vigor: { value: 200, max: 200 } }), face() {}, stand() {},
    roomContents() { return 1; }, async waitFor() { return { events: [] }; },
    predictSelf(p) { this.self = { ...this.self, ...p, predicted: true }; this.room.objects.set(1, this.self); },
    moveTo(nx, ny) { this.predictSelf({ x: nx, y: ny, row: Math.floor(ny / 64), col: Math.floor(nx / 64) }); } };
  const s = Object.assign(Object.create(Session.prototype), { client: c, movementGeneration: 0, name: 'offline-2144',
    need: () => c, moveSpeed: () => 18, movementWasCancelled: g => g !== s.movementGeneration,
    pacer: { async submit(_k, run) { return run(); } }, async confirmPosition() { c.self.predicted = false; return c.self; },
    async _askStrategies() { return null; }, _blinkPointHere: () => null,
    noteTransit() {}, planSameRoomDoors: () => null, async rideTrack() { return { rode: false }; } });
  Object.defineProperty(s, 'live', { value: true }); s.threatsHere = () => [];
  s.world = new World(c, map);
  s.recentreInSquare = async () => false;
  const asked = [];
  s.leaveVia = async exit => { asked.push(exit); return { left: false, reason: 'object_blocked', stage: 'walk', crossing_packet_sent: false }; };
  return { s, asked };
}

for (const s of STUCK) {
  test(`2144 from ${s.who}'s r${s.row}c${s.col}: the budget buys the west door twice before any door the mover refused`, { skip }, async () => {
    const { s: session, asked } = walker(s.x, s.y);
    const doors = session.world.exits().filter(e => Number(e.to) === 2101);
    assert.equal(doors.length, 8);
    await session.leaveViaAny(doors);
    const said = asked.map(e => `r${e.stand_on.row}c${e.stand_on.col}${e.verified === false ? '?' : ''}`).join(' ');
    // Before: r38c49? r30c39 r27c49? -- the prod ledger's sequence, the only real door once.
    assert.ok(asked.length >= 2, said);
    assert.deepEqual(new Set(asked.slice(0, 2).map(e => `${e.stand_on.row},${e.stand_on.col}`)), WEST, said);
    assert.ok(asked.slice(0, 2).every(e => e.verified === true), said);
    assert.ok(!asked.slice(0, 2).some(e => e.stand_on.row === 38 && e.stand_on.col === 49), said);
  });
}

// ---------------------------------------------------------------- WHAT THIS DOES NOT FIX
//
// The square graph has ONE node per square and ONE stand point per node; the body has a fine
// position. Where a square holds two places the body can be -- two floors more than a step
// apart (5.6% of standable squares map-wide, 21.8% in The Cragged Mountains, 11.2% in Ukgoth,
// 6.5% here), or two sides of a pinch narrower than the body -- the graph is not 1:1 with the
// body's state and A* over it is neither complete nor sound. In 2144 it errs conservative (the
// ramp to the north wall walk at r24c32-36 is climbable and the router cannot see it); in 578
// it errs the dangerous way, and that is pinned here as a TODO rather than fixed:
//
//   r2c11 -> r2c10 is legal in the mask because the step SLIDES and stops at x=10080, inside
//   r2c10 but east of a pinch the body cannot pass; `_strandedByLanding` is not consulted
//   because r2c10's stand point sits on a wall line (`_standOnBoundary`), and r2c10 -> r2c9 is
//   then planned from the stand point the body never reached.
//
// The categorical fix is a node per (square, footing) -- a connected piece of floor inside the
// square, at step-compatible heights and reachable by a body-sized disc -- with edges proved by
// the same trace from footing to footing. That changes the mask format (STEP_MASK_VERSION), the
// bake and every consumer keyed on "row,col"; see docs/m59-routing.md, "Peninsulas".
test('578 (TODO, layered squares): a slid landing the planner counts as r2c10 can reach what r2c10 is planned to step to', {
  skip: !map?.rooms?.[578] ? 'no room 578 in the map on disk' : (!attached?.ok ? 'no routing table attached' : false),
  todo: 'node = (square, footing), not square: docs/m59-routing.md "Peninsulas"',
}, () => {
  const geo = sharedRoomGeometry(map.rooms[578]);
  const sp = geo.standPoint(2, 11);
  const landing = geo._moverStepFrom(sp.x, sp.y, 2, 10);
  assert.equal(geo.moverStepLands(2, 11, 2, 10), true, 'precondition: the planner steps r2c11 -> r2c10');
  assert.equal(geo.moverStepLands(2, 10, 2, 9), true, 'precondition: and plans r2c10 -> r2c9 next');
  const STEP = 64, x1 = 16 * 1024, y1 = 20 * 1024;
  const key = (x, y) => `${x},${y}`, start = [landing.x, landing.y], seen = new Set([key(...start)]), q = [start];
  for (let i = 0; i < q.length; i++) {
    const [x, y] = q[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = x + dx * STEP, ny = y + dy * STEP;
      if (nx < 0 || nx > x1 || ny < 0 || ny > y1 || seen.has(key(nx, ny))) continue;
      if (!geo.traceFineMoveClient(x, y, nx, ny, { slide: false, fall: true })?.arrived) continue;
      seen.add(key(nx, ny)); q.push([nx, ny]);
    }
  }
  const reachesR2c9 = [...seen].some(k => {
    const [x, y] = k.split(',').map(Number);
    return Math.floor(x / 1024) + 1 === 9 && Math.floor(y / 1024) + 1 === 2;
  });
  assert.ok(reachesR2c9, `the body stopped at (${landing.x},${landing.y}) cannot get into r2c9, which the planner steps to next`);
});
