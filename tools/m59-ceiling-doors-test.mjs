#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { M59Client, BP } from './m59-client.mjs';
import { sharedRoomGeometry } from './m59-roo.mjs';
import { attachStepMasks, applyDoorState, doorStates } from './m59-routes.mjs';
import { applyCeilingDoors, installDoorObserver } from './m59-ceiling-doors.mjs';
import { guildPassage, guildSection } from './m59-guild-passage.mjs';
import { Session } from './m59-session.mjs';
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
