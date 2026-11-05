#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// A refused press is written to the fleet ledger (m59-door-refusal.mjs), so the ledger is pointed
// at a scratch directory BEFORE anything that records is imported (see m59-ledger-test.mjs).
const scratch = mkdtempSync(join(tmpdir(), 'm59-ceiling-doors-'));
process.env.M59_LEDGER_DIR = scratch;
const { M59Client, BP } = await import('./m59-client.mjs');
const { sharedRoomGeometry } = await import('./m59-roo.mjs');
const { attachStepMasks, applyDoorState, doorStates } = await import('./m59-routes.mjs');
const { applyCeilingDoors, installDoorObserver } = await import('./m59-ceiling-doors.mjs');
const { guildPassage, guildSection } = await import('./m59-guild-passage.mjs');
const { Session } = await import('./m59-session.mjs');
const { resetDoorRefusalWindows } = await import('./m59-door-refusal.mjs');
// Every `door_press_refused` row the ledger holds so far.
const refusals = () => existsSync(scratch) ? readdirSync(scratch).filter(f => /^fleet-.*\.jsonl$/.test(f))
  .flatMap(f => readFileSync(join(scratch, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)))
  .filter(r => r.kind === 'door_press_refused') : [];
const fresh = () => {
  const map = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url)));
  attachStepMasks(map);
  return { map, g: sharedRoomGeometry(map.rooms[714]), observed: new Map() };
};
test('a replacement session client keeps live door geometry and ignores the old socket', () => {
  const { map, g } = fresh();
  const client = () => new M59Client({ host: '127.0.0.1', port: 1, log: () => {} });
  const old = client(), s = Object.assign(Object.create(Session.prototype), {
    client: old, world: { map, room: { num: 714 } }, recorder: { line() {} },
  });
  s.observeDoorGeometry(old);
  old.onGameMessage(BP.SECTOR_MOVE, Buffer.from([5,59,0,190,0,0]));
  assert.equal(g.path(3,28,5,28).found, true);
  s.client = client();
  s.observeDoorGeometry(s.client);
  assert.equal(g.path(3,28,5,28).found, false, 'replacement starts with shipped geometry');
  old.onGameMessage(BP.SECTOR_MOVE, Buffer.from([5,59,0,190,0,0]));
  assert.equal(g.path(3,28,5,28).found, false, 'old socket cannot mutate the replacement map');
  s.client.onGameMessage(BP.SECTOR_MOVE, Buffer.from([5,59,0,190,0,50]));
  assert.equal(g.path(3,28,5,28).found, true, 'replacement opening updates the mover');
  const source = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/this\.world = new World\(c, worldMap\);\s*this\.observeDoorGeometry\(c\);/g) ?? []).length, 2,
    'both login paths attach the observer when constructing their new world');
});
test('ceiling packet keeps type and speed, and listeners can set the actual settling deadline', () => {
  const c = new M59Client({ host: '127.0.0.1', port: 1, log: () => {} });
  const { map, g } = fresh(); let recorded = 0;
  c.onEvent = e => { if (e.kind === 'sector-height') recorded++; };
  installDoorObserver(c, map, () => 714);
  const before = Date.now();
  c.onGameMessage(BP.SECTOR_MOVE, Buffer.from([5,59,0,190,0,50]));
  assert.equal(c.room.sectorHeights.get(59).type, 5);
  assert.equal(recorded, 1);
  assert.ok(c.room.collisionInvalidated.until >= before + 1900);
  assert.ok(c.room.collisionInvalidated.until <= Date.now() + 1900);
  assert.equal(g.path(3,28,5,28).found, true);
});
test('live ceiling geometry opens and closes the real entrance without moving its floors', () => {
  const { map, g, observed } = fresh(), floors = g.sectors.map(s => s.floorHeight);
  applyCeilingDoors(map, 714, observed);
  assert.equal(g.path(3,28,5,28).found, false);
  observed.set(59, { type: 5, height: 190 });
  const result = applyCeilingDoors(map, 714, observed, { type: 5, sector: 59, speed: 50 }, { now: 1000 });
  assert.equal(result.settledAt, 2900); // 90/50 seconds + 100ms margin, under the five-second window
  assert.equal(g.path(3,28,5,28).found, true);
  assert.deepEqual(g.sectors.map(s => s.floorHeight), floors);
  observed.set(59, { type: 5, height: 100 }); applyCeilingDoors(map, 714, observed);
  assert.equal(g.path(3,28,5,28).found, false);
  observed.set(59, { type: 5, height: 123 });
  assert.equal(applyCeilingDoors(map, 714, observed), null);
});
test('overlapping ceiling animations retain both collision sectors until settled', () => {
  const { map, observed } = fresh();
  observed.set(59, { type: 5, height: 190 });
  const first = applyCeilingDoors(map, 714, observed, { type: 5, sector: 59, speed: 50 }, { now: 1000 });
  observed.set(55, { type: 5, height: 230 });
  const second = applyCeilingDoors(map, 714, observed, { type: 5, sector: 55, speed: 50 }, { now: 1100 });
  assert.equal(second.settledAt, first.settledAt);
  assert.ok(first.sectorIndices.every(i => second.sectorIndices.includes(i)));
  assert.ok(second.sectorIndices.length > first.sectorIndices.length);
});
test('a ceiling update cannot masquerade as the floor of a legacy door', () => {
  const { map } = fresh();
  const r = applyDoorState(map, 951, new Map([[3, { type: 5, height: 356 }]]));
  assert.equal(r.state, null);
});
test('actual baked hall supports every inward and outward trigger even when doors close between legs', async () => {
  const { map, g, observed } = fresh(), opened = [];
  const c = { self: { row: 2, col: 32 }, room: { id: 2572, sectorHeights: observed }, evSeq: 0,
    events: [], waitFor: async ({ since, match }) => ({
      events: c.events.filter(e => e.seq > since && (!match || match(e))),
    }) };
  const open = id => {
    opened.push(id); observed.set(id, { type: 5, height: ({ 59:190,55:230,53:240,3:250 })[id] });
    c.events.push({ kind: 'sector-height', sector: id, room: 2572,
      height: observed.get(id).height, speed: 0, at: Date.now(), seq: ++c.evSeq });
    applyCeilingDoors(map, 714, observed);
  };
  c.go = () => {
    const { row, col } = c.self;
    if (col === 28 && [3,4].includes(row)) open(59);
    else if (col === 10 && [18,19].includes(row)) open(55);
    else if (col === 13 && [11,13].includes(row)) open(53);
    else throw new Error(`invalid GO trigger r${row}c${col}`);
  };
  const k = { sayHallPassword: async () => { open(3); return { ok: true }; },
    s: { need: () => c, world: { geometry: g }, pacer: { submit: async (_kind, fn) => fn() },
      async step(col, row, options) {
        assert.equal(options.confirm, true);
        assert.ok(Math.max(Math.abs(row - c.self.row), Math.abs(col - c.self.col)) <= 1);
        assert.ok(g.path(c.self.row, c.self.col, row, col).found);
        assert.ok(g.moverStepLands(c.self.row, c.self.col, row, col), `mover cannot land r${row}c${col}`);
        c.self = { row, col }; return { moved: true };
      },
      async walkTo(col, row) {
        const path = g.path(c.self.row, c.self.col, row, col);
        assert.ok(path.found, `closed path to r${row}c${col}`);
        let previous = c.self;
        for (const next of path.steps) {
          assert.ok(g.moverStepLands(previous.row, previous.col, next.row, next.col),
            `route planner's goal exception cannot certify landing r${next.row}c${next.col}`);
          previous = next;
        }
        c.self = { row, col }; observed.clear(); applyCeilingDoors(map, 714, observed);
      } } };
  await guildPassage(k, 4, () => false);
  assert.equal(guildSection(c.self.row, c.self.col), 4);
  await guildPassage(k, 0, () => false);
  assert.equal(guildSection(c.self.row, c.self.col), 0);
  assert.deepEqual(opened, [59,55,53,3,3,53,55,59]);
  await assert.rejects(guildPassage(k, 4, () => true), /survival/);
});

// THE HALL OF THE SLAUGHTERED COMMAND (713). Same harness as above, the second hall's rules:
// MAIN_DOOR (sector 4) is PRESSED, from the foyer on col 7 (plGuild_doors, guildh13.kod:82) and from
// inside on col 8 (guildh13.kod:126), rows 2-4; the chest room is behind a WALL that the password
// moves you across -- row 8 -> row 10 and row 9 -> row 7, cols 26 and 27 only
// (WalkThroughSecretWall, guildh13.kod:191-217). No sector moves for that one.
const fresh713 = () => {
  const map = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url)));
  attachStepMasks(map);
  return { map, g: sharedRoomGeometry(map.rooms[713]), observed: new Map() };
};
const hall713 = (start) => {
  const { map, g, observed } = fresh713(), log = [];
  const c = { self: { ...start }, room: { id: 3051, sectorHeights: observed }, evSeq: 0,
    events: [], waitFor: async ({ since, match }) => ({
      events: c.events.filter(e => e.seq > since && (!match || match(e))),
    }) };
  c.go = () => {
    const { row, col } = c.self;
    if (![7, 8].includes(col) || row < 2 || row > 4) throw new Error(`invalid GO trigger r${row}c${col}`);
    log.push(4); observed.set(4, { type: 5, height: 500 });
    c.events.push({ kind: 'sector-height', sector: 4, room: 3051, height: 500, speed: 0, at: Date.now(), seq: ++c.evSeq });
    applyCeilingDoors(map, 713, observed);
  };
  const k = { sayHallPassword: async () => {
      log.push('say');
      const { row, col } = c.self;
      if ([26, 27].includes(col) && row === 8) c.self = { row: 10, col };
      else if ([26, 27].includes(col) && row === 9) c.self = { row: 7, col };
      return { ok: true };
    },
    s: { need: () => c, world: { geometry: g, room: { num: 713 } }, pacer: { submit: async (_kind, fn) => fn() },
      async step(col, row, options) {
        assert.equal(options.confirm, true);
        assert.ok(Math.max(Math.abs(row - c.self.row), Math.abs(col - c.self.col)) <= 1);
        assert.ok(g.moverStepLands(c.self.row, c.self.col, row, col), `mover cannot land r${row}c${col}`);
        c.self = { row, col }; return { moved: true };
      },
      async walkTo(col, row) {
        const path = g.path(c.self.row, c.self.col, row, col);
        assert.ok(path.found, `closed path r${c.self.row}c${c.self.col} -> r${row}c${col}`);
        let previous = c.self;
        for (const next of path.steps) {
          assert.ok(g.moverStepLands(previous.row, previous.col, next.row, next.col),
            `route planner's goal exception cannot certify landing r${next.row}c${next.col}`);
          previous = next;
        }
        c.self = { row, col }; observed.clear(); applyCeilingDoors(map, 713, observed);
      } } };
  return { c, k, log, g };
};
test('713: from the Rescue landing in the foyer to the chests and back out, on the real bake', async () => {
  const { c, k, log, g } = hall713({ row: 9, col: 3 });          // viTeleport, guildh13.kod:40-41
  assert.equal(guildSection(9, 3, 713), 0, 'the Rescue landing is the foyer');
  assert.equal(g.path(8, 26, 10, 26).found, false, 'the chest room is sealed: no walk crosses the secret wall');
  await guildPassage(k, 2, () => false);
  assert.equal(guildSection(c.self.row, c.self.col, 713), 2);
  assert.deepEqual([c.self.row, c.self.col], [10, 26], 'landed where WalkThroughSecretWall puts a speaker on r8c26');
  await guildPassage(k, 0, () => false);
  assert.equal(guildSection(c.self.row, c.self.col, 713), 0);
  // One press each way at the main door, and the word said exactly twice: on r8c26, then on r9c26.
  assert.deepEqual(log, [4, 'say', 'say', 4]);
});
test('713: the chest side of the secret wall is section 2 and both of its triggers are where the kod reads them', () => {
  for (const [r, col] of [[9, 26], [9, 27], [10, 26], [10, 27], [12, 24], [13, 24], [12, 29], [13, 29]])
    assert.equal(guildSection(r, col, 713), 2, `r${r}c${col}`);
  for (const [r, col] of [[8, 26], [8, 27], [7, 26], [3, 8], [3, 9], [5, 28], [9, 5], [13, 7]])
    assert.equal(guildSection(r, col, 713), 1, `r${r}c${col}`);
  for (const [r, col] of [[3, 7], [3, 6], [9, 3], [10, 2], [11, 2], [9, 4]])
    assert.equal(guildSection(r, col, 713), 0, `r${r}c${col}`);
});
test('713: a missing hall password refuses at the wall rather than standing there', async () => {
  const { k } = hall713({ row: 5, col: 28 });
  k.sayHallPassword = async () => ({ ok: false, why: 'no password recorded' });
  await assert.rejects(guildPassage(k, 2, () => false), /guild chest key unavailable/);
});
test('a hall nobody surveyed is refused by number, and so is a section the hall does not have', async () => {
  const { k } = hall713({ row: 5, col: 28 });
  await assert.rejects(guildPassage(k, 4, () => false), /hall 713 has no section 4/);
  k.s.world.room.num = 701;
  await assert.rejects(guildPassage(k, 2, () => false), /hall 701 has no surveyed passage/);
});

// A CEILING ROOM HAS TO BE ABLE TO SAY IT HAS A STATE APPLIED, AND COULD NOT.
//
// `DOOR_STATE` — what `doorStates()` returns — was written only by `applyDoorState`, the FLOOR
// path. `installDoorObserver` runs `const result = ceiling ?? applyDoorState(...)`, so in a
// room whose doors are moving ceilings the floor path never runs and the map was never
// written. `applyCeilingDoors` recorded its state in a WeakMap private to its own file, so
// nothing outside could see it.
//
// TWO READERS WERE GETTING NULL, AND ONE OF THEM COSTS A WALK.
//
//   * the keeper's `doors.applied`, which is therefore structurally null in 714 whether or not
//     the mask was applied — a blind instrument rather than a failure, and one that was read
//     on prod as evidence the mover was enforcing the shipped geometry;
//   * `reachableByDoor`, which gates the LIVE reachability answer on
//     `doorStates()[roomNum] != null` and so always fell back to the BAKED, doors-shut reach.
//     Its own comment names the cost: "the failure it fixes strands a fleet outside an open
//     door."
//
// Measured on prod 2026-09-20: door 59 opened (observed 100 -> 190) and a character inside the
// hall still could not reach door 55's trigger, because the router was reasoning about a hall
// with every door closed. Generalising the ceiling bake took this from one blind room to 26.
test('an applied ceiling state is visible to doorStates(), not just to its own WeakMap', () => {
  const { map, observed } = fresh();
  // Everything shut: the state the .roo ships 714 in.
  applyCeilingDoors(map, 714, observed);
  const shut = doorStates()[714];
  assert.ok(shut != null,
    'even the resting state must be recorded — `reachableByDoor` asks whether this room has ' +
    'ANY live state before it will consult live geometry, so null means "use the baked answer"');

  // Now open the main door, the way the server reports it.
  observed.set(59, { type: 5, height: 190 });
  applyCeilingDoors(map, 714, observed, { type: 5, sector: 59, speed: 50 }, { now: 1000 });
  const open = doorStates()[714];
  assert.ok(open != null, 'and the open state is recorded too');
  assert.notEqual(open, shut,
    'and it CHANGES — a key that does not move cannot invalidate a cached reach, so the ' +
    'router would go on answering from the geometry it had before the door opened');
  assert.ok(String(open).includes('190'),
    'the recorded key names the height the server actually reported');
});

// A SEATED CHARACTER ON THE TRIGGER, 2026-09-24. Kermit and Robin rested on door 55's outward
// trigger (r18c10) and every press came back "You are unable to go anywhere." — PFLAG_NO_MOVE,
// set for as long as a character rests — while the passage reported "no matching opening
// event" for eight hours. Already on the trigger, they never walked, so nothing stood them up.
// Animal, seated at r19c10, could not walk to door 59 at all. The server here is modelled the
// way user.kod is: a seated body neither walks nor presses, and `stand` is the only way out.
//
// `drag` models the 2026-11-01 shape: something moves the body off the trigger between the confirm
// and the `go` (a competing walker), and the server, judging its OWN square, finds no trigger there.
function seatedHall(start, { standWorks = true, drag = null, bystanders = [] } = {}) {
  const { map, g, observed } = fresh(), opened = [], log = [], seals = [];
  let seated = true, stands = 0;
  const c = { self: { ...start }, room: { id: 2572, sectorHeights: observed,
      objects: new Map(bystanders.map((b, i) => [9000 + i, { id: 9000 + i, ...b }])) },
    me: { name: 'Tester' }, selfId: 1, evSeq: 0, events: [],
    lastPostureCommand: { verb: 'rest', at: Date.now(), room_object_id: 2572 },
    eventsSince: since => c.events.filter(e => e.seq > since),
    waitFor: async ({ since, match }) => ({ events: c.events.filter(e => e.seq > since && (!match || match(e))) }) };
  const emit = e => c.events.push({ ...e, at: Date.now(), seq: ++c.evSeq });
  const open = id => {
    opened.push(id); observed.set(id, { type: 5, height: ({ 59:190,55:230,53:240,3:250 })[id] });
    emit({ kind: 'sector-height', sector: id, room: 2572, height: observed.get(id).height, speed: 0 });
    applyCeilingDoors(map, 714, observed);
  };
  c.go = () => {
    if (seated) return emit({ kind: 'message', text: 'You are unable to go anywhere.' });
    const { row, col } = c.self;
    if (col === 28 && [3,4].includes(row)) open(59);
    else if (col === 10 && [18,19].includes(row)) open(55);
    else if (col === 13 && [11,13].includes(row)) open(53);
    // `SomethingTryGo` matched nothing at the server's square: the same sentence a seat gets.
    else emit({ kind: 'message', text: 'You are unable to go anywhere.' });
  };
  const s = { name: 't17', need: () => c, world: { geometry: g, room: { num: 714, name: 'Guild Hall' } },
    movementGeneration: 7,
    replayRecorder: { seal: (kind, detail) => { seals.push({ kind, detail });
      return { id: `seal-${seals.length}`, file: `replays/${kind}/seal-${seals.length}.json`, status: 'queued' }; } },
    pacer: { submit: async (kind, fn) => {
      if (kind !== 'move' || !drag) return fn();
      // The other walker moves the body before the `go` leaves, and its next command lands while
      // the passage is still waiting on the door.
      c.self = { ...drag, x: drag.col * 64 + 40, y: drag.row * 64 + 20 };
      const sent = fn(); s.movementGeneration++; return sent;
    } },
    // The client sends `stand` either way; whether the server honoured it is `standWorks`.
    async standBeforeGo() { stands++; c.lastPostureCommand = { verb: 'stand', at: Date.now(), room_object_id: 2572 };
      if (standWorks) seated = false; },
    async step(col, row) { if (seated) return { moved: false, reason: 'snapped back' };
      c.self = { row, col }; return { moved: true }; },
    async walkTo(col, row) {
      if (seated && (c.self.row !== row || c.self.col !== col)) return { reason: 'no_ground_gained' };
      c.self = { row, col }; observed.clear(); applyCeilingDoors(map, 714, observed);
    } };
  const k = { s, note: (what, facts) => log.push({ what, ...facts }), sayHallPassword: async () => ({ ok: true }) };
  return { k, c, opened, log, seals, stands: () => stands };
}

test('a character seated on the hall door trigger stands up and leaves', async () => {
  resetDoorRefusalWindows();
  const before = refusals().length;
  const { k, c, opened, stands, seals } = seatedHall({ row: 18, col: 10 });
  await guildPassage(k, 0, () => false);
  assert.equal(guildSection(c.self.row, c.self.col), 0, 'out through 55 and 59 to the foyer');
  assert.deepEqual(opened, [55, 59]);
  assert.ok(stands() >= 2, 'stood before each leg, not once per journey');
  assert.equal(refusals().length, before, 'a press that opened writes no door_press_refused row');
  assert.equal(seals.length, 0, 'and seals no replay ring');
});

test('a character seated beyond the hall door can walk to the entrance trigger', async () => {
  const { k, c } = seatedHall({ row: 19, col: 10 });
  await guildPassage(k, 0, () => false);
  assert.equal(guildSection(c.self.row, c.self.col), 0, 'Animal\'s square, r19c10, reaches the foyer');
});

test('a press the server refuses is named as a refusal, not a slow door', async () => {
  resetDoorRefusalWindows();
  const before = refusals().length;
  const { k, log, seals } = seatedHall({ row: 18, col: 10 }, { standWorks: false,
    bystanders: [{ row: 17, col: 10, x: 10 * 64 + 32, y: 17 * 64 + 32, flags: 0x4, name: 'Bystander' },
                 { row: 18, col: 13, flags: 0, name: 'meat pie' }] });
  await assert.rejects(guildPassage(k, 0, () => false),
    /guild door 55 could not be crossed: the server refused 3 of 3 presses as "unable to go anywhere" \(body at r18c10, trigger r18c10, seated:false, 1 bodies within 2 sq; ledger dp-[0-9a-f]{10}\)/);
  const notes = log.filter(e => e.what === 'guild door opening not verified');
  assert.equal(notes.length, 3);
  assert.ok(notes.every(e => /unable to go anywhere/.test(e.reason)), 'each note says the server refused');
  assert.ok(notes.every(e => /^body at r18c10, trigger r18c10/.test(e.scene)), 'and carries the scene');

  // THE LEDGER ROW: one per refused press, self-sufficient to stage the scene again.
  const rows = refusals().slice(before);
  assert.equal(rows.length, 3, 'one door_press_refused row per refused press');
  const r = rows[2];
  assert.equal(r.character, 'Tester'); assert.equal(r.agent, 't17');
  assert.equal(r.source, 'guild_passage'); assert.equal(r.verdict, 'server_refused');
  assert.equal(r.server_message, 'You are unable to go anywhere.');
  assert.deepEqual([r.attempt, r.attempts, r.refused_so_far], [3, 3, 3]);
  assert.equal(r.room.num, 714, 'the room by its map number');
  assert.equal(r.room.object_id_at_capture, 2572, 'the object id kept, and labelled as a handle');
  assert.deepEqual({ sector: r.door.sector, direction: r.door.direction }, { sector: 55, direction: 'outward' });
  assert.deepEqual(r.expected.trigger, { row: 18, col: 10, at: 'r18c10' });
  assert.deepEqual(r.expected.trigger_fine, { x: 10 * 64 + 32, y: 18 * 64 + 32, units: 'kod', what: 'square centre' });
  assert.deepEqual(r.expected.across, { row: 20, col: 10, at: 'r20c10' });
  assert.equal(r.actual.at_press.at, 'r18c10'); assert.equal(r.actual.at_press.on_trigger, true);
  assert.equal(r.posture.seated, false, 'the client had sent stand');
  assert.equal(r.posture.last_command, 'stand');
  assert.equal(r.nearby.bodies_within_2, 1, 'a player counts as a body; a meat pie does not');
  assert.equal(r.nearby.objects[0].name, 'Bystander'); assert.equal(r.nearby.objects[0].kind, 'player');
  assert.deepEqual(r.nearby.objects[0].fine, { x: 672, y: 1120, units: 'kod' });
  assert.ok(r.nearby.objects.some(o => o.kind === 'item'), 'the item is listed, just not counted');
  assert.equal(r.movement.generation_at_press, 7);
  assert.match(r.units_note, /64 units per square/);
  assert.ok('harness_sha' in (r.code ?? {}), 'the code it ran on');

  // THE RING IS SEALED ONCE, NOT THREE TIMES: a refusal loop must not write a bundle per press.
  assert.equal(seals.length, 1, 'one replay seal per door per window');
  assert.equal(seals[0].kind, 'door_refused');
  assert.equal(rows[0].replay_seal.file, 'replays/door_refused/seal-1.json', 'and the row names the bundle');
  assert.ok(!rows[1].replay_seal && !rows[2].replay_seal);
});

test('a body dragged off the trigger before the press is recorded where it actually was', async () => {
  resetDoorRefusalWindows();
  const before = refusals().length;
  // Walked onto door 55's trigger, then pulled one square north before the `go` left.
  const { k } = seatedHall({ row: 18, col: 10 }, { drag: { row: 17, col: 10 } });
  await assert.rejects(guildPassage(k, 0, () => false),
    /refused 3 of 3 presses as "unable to go anywhere" \(body at r17c10, trigger r18c10, seated:false, 0 bodies within 2 sq, movement gen \+1 since press/);
  const r = refusals().slice(before)[0];
  assert.equal(r.actual.at_press.at, 'r17c10', 'the pose at the press, not the trigger the walk reached');
  assert.equal(r.actual.at_press.on_trigger, false);
  assert.deepEqual(r.actual.at_press.off_trigger, { rows: -1, cols: 0, squares: 1 });
  assert.deepEqual(r.actual.at_press.fine, { x: 680, y: 1108, units: 'kod' });
  assert.equal(r.actual.at_press.fine_in_square, true);
  assert.deepEqual(r.expected.trigger, { row: 18, col: 10, at: 'r18c10' });
});
