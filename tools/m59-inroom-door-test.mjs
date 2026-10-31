#!/usr/bin/env node
// Offline: an IN-ROOM walk to a square behind an operable door opens the door and walks through.
//
//   node tools/m59-inroom-door-test.mjs
//
// PROD, 2026-10-31. Priestess Qerti'nya stands at r13c20 in the Temple of Kraanan (801), behind a
// ceiling door (tempkra.kod SECTOR_DOOR, sector 1) that opens for a `go` pressed on r30c20 or
// r31c20 and shuts itself RESET_TIME (10 s) after the press. Raphael and Zoot spent forty-five
// minutes failing `walk_to` / `crawl_to` toward her from r31c20 and r32c21 — `movement_deviation`,
// "no route the mover can walk", crawls out of time 10-19 squares short — and the operator
// delivered the letter by hand. Journeys had worked doors before an exit walk since The Wryn's
// Keep (m59-wrynkeep-exit-test.mjs); the in-room `walkTo` never asked, so disciple-quest.mjs
// carried its own copy of the door step. Operator: "change it so the m59-harness does the door
// properly, and it's not something being copied fleetscript-to-fleetscript."
//
// Two halves. The first drives the REAL Session (`walkTo`, the door hook, `openOperableDoor`,
// `waitForDoorOpen`, the mover's collision) on the committed 801 geometry through the socketless
// fixture the Bastion and Ko'catan tests use; only the server is a model, of exactly the kod that
// decides this door, at its real speed — so those cases take a few real seconds each. The second
// lifts the door methods by name onto a virtual clock for the cases that would take a minute of
// real time: a door that will not open, a cancel, a door that shuts on the way, and 802's guess.
//
// THE TEMPLE OF QOR (802), BOTH WAYS, PROD 2026-10-31: walk_to Zuxana refused at r21c17 stepping
// into the pit, and `travel` out from her side failing for an hour with the door shut. The real
// Session again, at the game's own pace: in from r33c14 and r4c18, out from r15c18 to 598. See
// the 802 block below for the three defects (two stand-point bakes and the door's head-high
// moment). Those walks take about 40 s each of real time.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bastionHarness } from './fixtures/bastion-fallback-client.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (detail ? ' — ' + detail : '')); }
};
const sq = p => p ? `r${p.row}c${p.col}` : 'nowhere';

// ---------------------------------------------------------------------------------------------
console.log('\nthe seam: where the hook sits, and the walks that must not recurse');
const source = readFileSync(new URL('./m59-session-walk.mjs', import.meta.url), 'utf8');
{
  const at = source.indexOf('  async walkTo(col, row, {');
  assert.ok(at > 0, 'walkTo is not in m59-session-walk.mjs — this test is stale');
  const head = source.slice(at, source.indexOf('rememberedDeparture(this', at));
  ok('walkTo asks the door hook before it plans, after the no-geometry refusal',
     /collision_geometry_unavailable[\s\S]*walkThroughOperableDoor\(col, row,/.test(head));
  ok('only when the caller has not turned doors off, and has not asked to authorise every packet',
     /if \(doors && typeof beforeMutation !== 'function' && typeof this\.walkThroughOperableDoor === 'function'\)/.test(head));
  const opener = source.slice(source.indexOf('  async openOperableDoor('), source.indexOf('  exitsBehindShutDoor(targets)'));
  ok('the walk onto a trigger square passes doors: false',
     /this\.walkTo\(target\.col, target\.row,\s*\{ movementGeneration, controlToken, doors: false \}\)/.test(opener));
  const through = source.slice(source.indexOf('  async walkThroughOperableDoor('), source.indexOf('A CODE EXIT WHOSE TRIGGER'));
  ok('and so does the walk through the opened door', /doors: false/.test(through));
  const dq = readFileSync(new URL('./fleetscripts/disciple-quest.mjs', import.meta.url), 'utf8');
  ok('disciple-quest.mjs no longer carries its own door press',
     !/verb: 'go'/.test(dq) && !/doorsFor/.test(dq.replace(/\/\/.*$/gm, '')));
}

// ---------------------------------------------------------------------------------------------
// THE REAL SESSION in 801, with a server that runs tempkra.kod's door.
const h = await bastionHarness();
const { fixture, map, imp } = h;
const { installDoorObserver } = await imp('m59-ceiling-doors.mjs');
const { doorsFor } = await imp('m59-doorplan.mjs');
const KRAANAN = 801, PRIESTESS = { row: 13, col: 20 };
const timers = new Set();
const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function room(num, from, { door = null, realPace = false, edgeLandings = null, maxMs = 60_000 } = {}) {
  const f = fixture({ from: { room: num, x: from.col * 64 + 32, y: from.row * 64 + 32 } }, { maxMs, realPace, edgeLandings });
  const { s, c } = f;
  c.room.sectorHeights = new Map();
  const mine = [], seen = { go: [], opened: [], closed: [] };
  // What M59Client does on BP_SECTOR_MOVE: keep the height, mark collision invalidated, emit.
  const emit = (kind, data) => {
    if (kind === 'sector-height') {
      c.room.sectorHeights.set(data.sector, { height: data.height, type: data.type, speed: data.speed, at: Date.now() });
      c.room.collisionInvalidated = { sector: data.sector, until: Date.now() + 8000 };
    }
    const ev = { seq: ++c.evSeq, kind, at: Date.now(), ...data };
    mine.push(ev);
    c.onEvent?.(ev);
  };
  const baseWait = c.waitFor.bind(c), baseSince = c.eventsSince.bind(c);
  c.eventsSince = since => [...baseSince(since), ...mine.filter(e => e.seq > since)];
  c.waitFor = async (o = {}) => {
    const pick = () => mine.filter(e => e.seq > (o.since ?? 0) && (!o.kinds?.length || o.kinds.includes(e.kind))
                                        && (!o.match || o.match(e)));
    let extra = pick();
    if (!extra.length && o.timeoutMs) { await sleep(Math.min(o.timeoutMs, 100)); extra = pick(); }
    const base = await baseWait(o);
    return { events: [...base.events, ...extra] };
  };
  const baseGo = c.go.bind(c);
  c.go = () => {
    const me = c.self;
    seen.go.push({ at: sq(me), t: Date.now() });
    // SomethingTryGo judges the body's OWN square (user.kod:5669). A door with `holds` ignores a
    // press while its timer runs (tempqor.kod: `AND ptDoor = $`).
    if (door && door.on(me) && door.works && !(door.holds && door.busy)) {
      door.busy = true;
      later(() => { seen.opened.push(Date.now()); emit('sector-height', { room: c.room.id, sector: door.sector, height: door.open, type: 5, speed: door.speed }); }, 50);
      later(() => { door.busy = false; seen.closed.push(Date.now()); emit('sector-height', { room: c.room.id, sector: door.sector, height: door.closed, type: 5, speed: door.speed }); }, door.resetMs);
    }
    return baseGo();
  };
  installDoorObserver(c, map, () => s.world.room?.num);
  return { ...f, seen, where: () => ({ row: c.self?.row, col: c.self?.col }) };
}
// tempkra.kod: SECTOR_DOOR to 164 at speed 16 from r30c20/r31c20, back to 92 RESET_TIME later.
const kraananDoor = (works = true) => ({ sector: 1, open: 164, closed: 92, speed: 16, resetMs: 10_000, works,
  on: me => me && me.col === 20 && (me.row === 30 || me.row === 31) });

for (const start of [{ row: 31, col: 20 }, { row: 32, col: 21 }]) {
  console.log(`\n801: walk_to Qerti'nya at ${sq(PRIESTESS)} from ${sq(start)} (the incident)`);
  const t = room(KRAANAN, start, { door: kraananDoor() });
  ok('the shut door leaves the mover no path to her', t.s.exitsBehindShutDoor([PRIESTESS]) === true);
  const began = Date.now();
  const r = await t.s.walkTo(PRIESTESS.col, PRIESTESS.row, { maxSteps: 60 });
  const arrivedAt = Date.now();
  ok('the walk works the door: one press, on the trigger', t.seen.go.length === 1 &&
     ['r30c20', 'r31c20'].includes(t.seen.go[0].at), JSON.stringify(t.seen.go));
  ok('the door it reports is sector 1, opened', r.doors?.length === 1 && r.doors[0].sector === 1 &&
     r.doors[0].opened === true && r.doors[0].proven === true, JSON.stringify(r.doors));
  ok('and the walk reaches her square', r.arrived === true && sq(t.where()) === sq(PRIESTESS),
     JSON.stringify({ arrived: r.arrived, reason: r.reason, at: t.where() }));
  ok('inside the open window — before the door shut again',
     t.seen.closed.length === 0 || t.seen.closed[0] > arrivedAt,
     `pressed ${t.seen.go[0]?.t - began}ms, arrived ${arrivedAt - began}ms`);
  for (const x of timers) clearTimeout(x);
  timers.clear();
}

console.log('\n801: the same walk with doors turned off is the incident, square for square');
{
  const t = room(KRAANAN, { row: 31, col: 20 }, { door: kraananDoor() });
  const r = await t.s.walkTo(PRIESTESS.col, PRIESTESS.row, { maxSteps: 20, doors: false });
  ok('it does not arrive', r.arrived !== true, JSON.stringify({ reason: r.reason, at: t.where() }));
  ok('and nothing pressed the door', t.seen.go.length === 0);
  for (const x of timers) clearTimeout(x);
  timers.clear();
}

// ---------------------------------------------------------------------------------------------
// THE TEMPLE OF QOR (802), BOTH WAYS. PROD 2026-10-31. Walking in: walk_to Zuxana (r16c15) from
// r33c17 went 23 steps to r21c17 and was refused stepping r21c17 > r20c16 (`movement_deviation`,
// `geometry_blocked`); from the door trigger r4c18 it walked 73 steps back to the same refusal;
// with the door opened by hand it walked east to r7c30 and was refused heading south. No reply
// carried `doors`. Walking out: from Zuxana's side with the door shut, `travel` to 852 failed
// every seven minutes for an hour ("did not reach 852 in three attempts").
//
// Three defects, all offline-measurable:
//   1. ZUXANA'S DAIS WAS UNREACHABLE IN THE BAKE WITH THE DOOR OPEN OR SHUT. The dais (sector floor
//      3488) is reached from the north hall (3200) by a stepped bridge one square wide whose edges
//      are the centre lines of columns 14 and 15, over a pit (floor 0). Every bridge square's centre
//      is on an edge and reads the pit, so the step mask had no step onto it, `path` found nothing,
//      and `walkTo` fell back to the coarse grid, which calls the pit floor and planned into it
//      (r21c17 > r20c16). Declared stand points on the bridge (substrate/m59-standpoints.json).
//   2. THE DOOR COULD BE ENTERED BUT NOT LEFT. From Zuxana's side the doorway is a gap in a
//      one-sided wall at x 17152; r4c17's centre is the end of wall 42 and r3c17's is on wall 19,
//      so the mask crossed the door only from outside (a one-sided wall is walked through from its
//      back). A declared stand point in the gap.
//   3. THE DOOR NEVER COUNTED AS OPEN. tempqor.kod lifts the ceiling 192 -> 270 at speed 16 (4.98 s)
//      and its DoorTimer drops it 5.0 s after the press; `waitForDoorOpen` waited for the full lift,
//      so a press "opened" 25 ms before it closed (and in this model, never: "pressed three times
//      and no sector moved"). It now ends when the ceiling is head-high (`ceilingPassableKod`, 240,
//      at 3.1 s). And `m59-doors.json` had RESET_TIME as null: `RESET_TIME = 5000   % five seconds`.
//
// The walks are the REAL Session at the game's own pace (`realPace`): an instant fixture outruns
// the vertical fall envelope on the entrance staircase and is refused for a reason no body meets.
{
  const { ceilingPassableKod, previewOpenedDoor, applyCeilingDoors: applyCD, planDoorChain: chain } = await imp('m59-ceiling-doors.mjs');
  const { sharedRoomGeometry: shared } = await imp('m59-roo.mjs');
  const { loadDoors } = await imp('m59-doorplan.mjs');
  const QOR = 802, ZUXANA = { row: 16, col: 15 }, ENTRANCE = { row: 33, col: 14 }, SOUTH_EXIT = { row: 38, col: 14 };
  const INSIDE = { row: 15, col: 18 };   // Raphael's square on Zuxana's side, 2026-10-31

  console.log('\n802: what the committed tables say about the room');
  applyCD(map, QOR, new Map());                                  // the door where the .roo ships it: shut
  const shut = shared(map.rooms[QOR]), open = previewOpenedDoor(map, QOR, 4).geometry;
  const found = (g, a, b) => !!g.path(a.row, a.col, b.row, b.col)?.found;
  for (const from of [ENTRANCE, { row: 21, col: 17 }, { row: 4, col: 18 }])
    ok(`door open, the mover has a path to Zuxana from ${sq(from)}; shut, it has none`,
       found(open, from, ZUXANA) && !found(shut, from, ZUXANA));
  for (const from of [INSIDE, ZUXANA])
    ok(`door open, the mover has a path from ${sq(from)} to the south exit ${sq(SOUTH_EXIT)}; shut, it has none`,
       found(open, from, SOUTH_EXIT) && !found(shut, from, SOUTH_EXIT));
  const plans = (at) => doorsFor(QOR, at).others;
  const inChain = chain(map, QOR, ENTRANCE, [ZUXANA], plans(ENTRANCE), {});
  ok('the ceiling table PROVES the north door gets the entrance to Zuxana', inChain?.sector === 4,
     JSON.stringify(inChain));
  const outChain = chain(map, QOR, INSIDE, [SOUTH_EXIT], plans(INSIDE), {});
  ok('and gets Zuxana\'s side to the south exit, pressed from inside the door',
     outChain?.sector === 4 && outChain.at?.col === 17, JSON.stringify(outChain));
  const qorTable = loadDoors().rooms?.[QOR]?.doors?.[0];
  ok('m59-doors.json knows the door shuts 5000 ms after the press (tempqor.kod RESET_TIME)',
     qorTable?.delay_ms === 5000, JSON.stringify(qorTable?.delay_ms));
  const passable = typeof ceilingPassableKod === 'function' ? ceilingPassableKod(map, QOR, 4) : 'no ceilingPassableKod';
  ok('and a body fits under it at ceiling 240 (floor 3072 + PLAYER_HEIGHT 768), 3.0 s into the lift',
     passable === 240, String(passable));

  // tempqor.kod: SECTOR_DOOR lifts to 270 at speed 16 from r3-4 c17-18, back to 192 RESET_TIME
  // (5000 ms) after the press, and a press while ptDoor runs does nothing.
  const qorDoor = () => ({ sector: 4, open: 270, closed: 192, speed: 16, resetMs: 5000, works: true, holds: true,
    on: me => me && (me.row === 3 || me.row === 4) && (me.col === 17 || me.col === 18) });

  for (const start of [ENTRANCE, { row: 4, col: 18 }]) {
    console.log(`\n802: walk_to Zuxana at ${sq(ZUXANA)} from ${sq(start)}, door shut`);
    const t = room(QOR, start, { door: qorDoor(), realPace: true, maxMs: 120_000 });
    const r = await t.s.walkTo(ZUXANA.col, ZUXANA.row, { maxSteps: 120 });
    ok('the door is pressed once, from a trigger square', t.seen.go.length === 1 &&
       ['r3c17', 'r3c18', 'r4c17', 'r4c18'].includes(t.seen.go[0].at), JSON.stringify(t.seen.go));
    ok('it is the table\'s door, proven, and it opened', r.doors?.length === 1 && r.doors[0].sector === 4 &&
       r.doors[0].proven === true && r.doors[0].opened === true, JSON.stringify(r.doors));
    ok('and the walk reaches her square', r.arrived === true && sq(t.where()) === sq(ZUXANA),
       JSON.stringify({ arrived: r.arrived, reason: r.reason, at: t.where() }));
    for (const x of timers) clearTimeout(x);
    timers.clear();
  }

  console.log(`\n802: leaving from Zuxana's side (${sq(INSIDE)}), door shut — a journey to 598`);
  {
    // The south edge is StandardLeaveDir -> ExitFromQor into whichever entrance is live; i8.kod
    // (598) puts the body at r32c25.
    const t = room(QOR, INSIDE, { door: qorDoor(), realPace: true, maxMs: 120_000,
      edgeLandings: { [QOR]: { south: { to: 598, arriveRow: 32, arriveCol: 25 } } } });
    const r = await t.s.travel(598, {});
    ok('the journey presses the door once, from inside it', t.seen.go.length === 1 &&
       ['r3c17', 'r4c17'].includes(t.seen.go[0].at), JSON.stringify(t.seen.go));
    ok('says it worked a door before the exit walk',
       (r.log ?? []).some(e => e.outcome === 'operated_a_door' && Number(e.sector) === 4),
       JSON.stringify((r.log ?? []).map(e => e.outcome ?? e.reason ?? e.to)));
    ok('and leaves the temple for 598', r.arrived === true && t.crossings.some(x => x.from === QOR && x.to === 598),
       JSON.stringify({ arrived: r.arrived, reason: r.reason, crossings: t.crossings, at: t.where() }));
    for (const x of timers) clearTimeout(x);
    timers.clear();
  }
}

console.log('\na room with no operable door walks exactly as before');
{
  // Castle Victoria (39): no door in m59-doors.json.
  const plan = doorsFor(39, null);
  assert.ok(!plan.on.length && !plan.others.length, 'room 39 grew an operable door — pick another room');
  const geo = (await imp('m59-roo.mjs')).sharedRoomGeometry(map.rooms[39]);
  // Two interior squares four steps apart in a straight line, every step one the mover lands —
  // a plain walk with nothing interesting in it, chosen from the committed geometry.
  let from = null, to = null;
  for (let r = 4; r <= geo.rows - 4 && !to; r++) for (let c = 4; c <= geo.cols - 8 && !to; c++) {
    let clear = geo.standable(r, c);
    for (let k = 0; k < 4 && clear; k++) clear = geo.moverStepLands(r, c + k, r, c + k + 1) && geo.standable(r, c + k + 1);
    if (clear) { from = { row: r, col: c }; to = { row: r, col: c + 4 }; }
  }
  assert.ok(from && to, 'no walkable pair in room 39');
  const t = room(39, from);
  ok('the hook answers null without pressing anything', (await t.s.walkThroughOperableDoor(to.col, to.row)) === null);
  const r = await t.s.walkTo(to.col, to.row, { maxSteps: 40 });
  ok('the walk arrives', r.arrived === true, JSON.stringify(r).slice(0, 300));
  ok('and carries no door report', r.doors === undefined && t.seen.go.length === 0);
}

console.log('\n568: a target cut off by something other than a door is not a reason to press');
{
  // The Lake of Jala's Song: a hunting room with a door that never shuts itself, at r6c49.
  const t = room(568, { row: 21, col: 21 });
  ok('the target really is unreachable from here', t.s.exitsBehindShutDoor([{ row: 1, col: 7 }]) === true);
  const { doorBringsCloser } = await imp('m59-ceiling-doors.mjs');
  const why = doorBringsCloser(map, 568, { row: 21, col: 21 }, { row: 1, col: 7 }, 1, { live: t.s.world.geometry });
  ok('opening the lake door would bring the body no closer', why && why.closer === false, JSON.stringify(why));
  ok('so no door is pressed for it', (await t.s.walkThroughOperableDoor(7, 1)) === null && t.seen.go.length === 0);
  ok('and that answer is remembered for this target, not re-derived on every walk',
     [...(t.s.inRoomDoorGuesses?.keys() ?? [])].some(k => k.endsWith(':1,7')));
}

console.log('\nno geometry, no door');
{
  const t = room(KRAANAN, { row: 31, col: 20 }, { door: kraananDoor() });
  Object.defineProperty(t.s.world, 'geometry', { get: () => null });
  ok('a session without geometry answers null', (await t.s.walkThroughOperableDoor(PRIESTESS.col, PRIESTESS.row)) === null
     && t.seen.go.length === 0);
}

// ---------------------------------------------------------------------------------------------
// THE DOOR METHODS ON A VIRTUAL CLOCK. Lifted by name, as m59-wrynkeep-exit-test does, with an
// honest mover over the committed geometry and a fake walkTo that runs walkTo's own head.
const { sharedRoomGeometry } = await imp('m59-roo.mjs');
const { applyCeilingDoors, planDoorChain, doorBringsCloser } = await imp('m59-ceiling-doors.mjs');
const { waitForDoorOpen, refusedToGo, doorRetryAt } = await imp('m59-door-wait.mjs');
const a = source.indexOf('  async openOperableDoor('), b = source.indexOf('\n  // WHICH INTERNAL DOOR', a);
assert.ok(a >= 0 && b > a, 'openOperableDoor moved — this test is stale');
assert.ok(source.slice(a, b).includes('async walkThroughOperableDoor('), 'walkThroughOperableDoor moved out of the lifted span');

function virtual(num, start, { door, stallFirstThrough = 0, cancelAfterPress = false } = {}) {
  const g = sharedRoomGeometry(map.rooms[num]);
  const observed = new Map();
  let clock = 1_000_000, pos = { ...start }, evSeq = 0, cancel = false;
  const pending = [], seen = { go: [], walks: [], through: 0 };
  applyCeilingDoors(map, num, observed, null, { now: clock });
  const deliver = () => {
    pending.sort((x, y) => x.at - y.at);
    const due = [];
    while (pending.length && pending[0].at <= clock) {
      const e = pending.shift();
      e.seq = ++evSeq;
      observed.set(e.sector, { type: 5, height: e.height, speed: e.speed });
      applyCeilingDoors(map, num, observed, e, { now: clock });
      due.push(e);
    }
    return due;
  };
  const vsleep = async ms => { clock += ms; deliver(); };
  const c = {
    get self() { return pos; },
    get evSeq() { return evSeq; },
    room: { id: 9000 + num, sectorHeights: observed, objects: new Map() },
    eventsSince: () => [],
    go: async () => {
      seen.go.push({ at: sq(pos), t: clock });
      if (cancelAfterPress) cancel = true;
      if (door.on(pos) && door.works) {
        pending.push({ kind: 'sector-height', type: 5, room: c.room.id, sector: door.sector, height: door.open, speed: door.speed, at: clock });
        pending.push({ kind: 'sector-height', type: 5, room: c.room.id, sector: door.sector, height: door.closed, speed: door.speed, at: clock + door.resetMs });
      }
    },
    waitFor: async ({ timeoutMs, match }) => { clock += timeoutMs; return { events: deliver().filter(e => !match || match(e)) }; },
  };
  const walk = async (row, col) => {
    let path = g.path(pos.row, pos.col, row, col);
    if (!path.found && path.collision_view) path = g.path(pos.row, pos.col, row, col, { collision: false });
    if (!path.found) return { arrived: false, reason: 'no route the mover can walk through this geometry' };
    for (const next of path.steps) {
      if (!g.moverStepLands(pos.row, pos.col, next.row, next.col))
        return { arrived: false, reason: 'movement_deviation', at: { ...pos } };
      pos = { row: next.row, col: next.col };
      await vsleep(250);
    }
    return { arrived: true };
  };
  const Session = new Function('doorsFor', 'setTimeout', 'Date', 'waitForDoorOpen', 'refusedToGo', 'doorRetryAt',
    'planDoorChain', 'doorBringsCloser', `return class { ${source.slice(a, b)} }`)(
      doorsFor, (fn, ms) => { clock += ms; deliver(); fn(); }, { now: () => clock },
      (cl, p, opts) => waitForDoorOpen(cl, p, { ...opts, now: () => clock, sleep: vsleep }), refusedToGo, doorRetryAt,
      planDoorChain, doorBringsCloser);
  const s = new Session();
  s.movementGeneration = 1;
  s.client = c;
  s.world = { room: { num }, geometry: g, map };
  s.movementWasCancelled = () => cancel;
  s.cancelledMovement = () => ({ arrived: false, cancelled: true, reason: 'movement cancelled' });
  s.pacer = { submit: async (_k, fn) => fn() };
  s.need = () => c;
  s.confirmPosition = async () => ({ ...pos });
  // walkTo's own head, then the honest mover: the shape of the real method for this purpose.
  s.walkTo = async (col, row, opts = {}) => {
    seen.walks.push({ to: sq({ row, col }), doors: opts.doors !== false, t: clock });
    if (opts.doors !== false && typeof opts.beforeMutation !== 'function') {
      const through = await s.walkThroughOperableDoor(col, row, opts);
      if (through) return through;
    }
    if (opts.doors === false && !(col === door.trigger?.col && row === door.trigger?.row)) {
      seen.through++;
      if (seen.through === 1 && stallFirstThrough) await vsleep(stallFirstThrough);
    }
    return walk(row, col);
  };
  return { s, c, seen, where: () => pos, now: () => clock, advance: vsleep };
}

console.log('\n801 on a virtual clock: a door that will not open');
{
  const v = virtual(KRAANAN, { row: 31, col: 20 }, { door: kraananDoor(false) });
  const r = await v.s.walkTo(PRIESTESS.col, PRIESTESS.row);
  ok('an ungated door is pressed three times, as openOperableDoor always has', v.seen.go.length === 3, JSON.stringify(v.seen.go));
  ok('then the walk proceeds as it would have, and says what the door did',
     r.arrived === false && r.doors?.[0]?.opened === false && /three times/.test(r.doors[0].reason ?? ''),
     JSON.stringify(r));
  await v.s.walkTo(PRIESTESS.col, PRIESTESS.row);
  ok('a re-issued walk inside the minute does not press it again', v.seen.go.length === 3, String(v.seen.go.length));
  await v.advance(61_000);
  await v.s.walkTo(PRIESTESS.col, PRIESTESS.row);
  ok('after the minute it does', v.seen.go.length === 6, String(v.seen.go.length));
}

console.log('\n801 on a virtual clock: cancelled at the press');
{
  const v = virtual(KRAANAN, { row: 31, col: 20 }, { door: kraananDoor(), cancelAfterPress: true });
  const r = await v.s.walkTo(PRIESTESS.col, PRIESTESS.row);
  ok('a cancel stops the walk', r.cancelled === true && r.arrived === false, JSON.stringify(r));
  ok('and nothing walks through afterwards', v.seen.through === 0 && sq(v.where()) === 'r31c20');
  ok('and a cancelled press is not remembered as a refusal', !(v.s.inRoomDoorRefusals?.size));
}

console.log('\n801 on a virtual clock: the door shuts on the way');
{
  // The first walk through does not start until the door has already shut — a body in the way,
  // a slow keeper. One more press and one more walk; not a third.
  const door = { ...kraananDoor(), trigger: { row: 31, col: 20 } };
  const v = virtual(KRAANAN, { row: 31, col: 20 }, { door, stallFirstThrough: 11_000 });
  const r = await v.s.walkTo(PRIESTESS.col, PRIESTESS.row);
  ok('pressed twice', v.seen.go.length === 2, JSON.stringify(v.seen.go));
  ok('and arrives on the second opening', r.arrived === true && sq(v.where()) === sq(PRIESTESS),
     JSON.stringify({ r, at: v.where() }));
}

console.log('\n802: the table cannot prove the door, and the guess is one press');
{
  // The Temple of Qor's north ceiling door (tempqor.kod, sector 4, r3-4 c17-18). Zuxana herself is
  // now PROVEN behind it (above); this is the branch for a target no door state reaches. r18c15 is
  // in the pit below her dais (sector floor 0, nothing climbs out of it): planDoorChain says null
  // with the door open or shut, and opening the door still brings the body's nearest square from
  // three away to two — so the harness presses it once, as a guess, and does not press again.
  const qorDoor = { sector: 4, open: 270, closed: 192, speed: 16, resetMs: 10_000, works: true,   // long enough that the guess is not about timing
    on: me => me && (me.row === 3 || me.row === 4) && (me.col === 17 || me.col === 18) };
  const v = virtual(802, { row: 33, col: 14 }, { door: qorDoor });
  const PIT = { row: 18, col: 15 };
  ok('the shut door leaves the mover no path to the pit square', v.s.exitsBehindShutDoor([PIT]) === true);
  ok('the table cannot prove a chain to it', planDoorChain(map, 802, { row: 33, col: 14 }, [PIT],
     doorsFor(802, { row: 33, col: 14 }).others, {}) === null);
  const began = performance.now();
  const why = doorBringsCloser(map, 802, { row: 33, col: 14 }, PIT, 4, { live: v.s.world.geometry });
  const tookMs = performance.now() - began;
  ok('but opening the door brings the body from three squares of it to two', why?.shut === 3 && why?.open === 2 &&
     why.closer === true, JSON.stringify(why));
  console.log(`       (doorBringsCloser took ${tookMs.toFixed(1)}ms, cold)`);
  const r = await v.s.walkTo(PIT.col, PIT.row);
  ok('the door is walked to and pressed once, as a guess', v.seen.go.length === 1 &&
     ['r3c17', 'r3c18', 'r4c17', 'r4c18'].includes(v.seen.go[0].at) && r.doors?.[0]?.proven === false &&
     r.doors[0].opened === true, JSON.stringify({ go: v.seen.go, doors: r.doors }));
  ok('then the walk goes on with doors off', v.seen.walks.at(-1)?.doors === false && v.seen.walks.at(-1)?.to === sq(PIT),
     JSON.stringify(v.seen.walks));
  // Nothing walks into the pit, so the guess did not help — and is not pressed again for this
  // target for ten minutes.
  await v.advance(30_000);
  await v.s.walkTo(PIT.col, PIT.row);
  ok('a guess that did not help is not repeated for the same target', v.seen.go.length === 1, String(v.seen.go.length));
}

console.log(`\n${pass} passed, ${fail} failed`);
for (const x of timers) clearTimeout(x);
process.exit(fail ? 1 : 0);
