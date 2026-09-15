#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { M59Client, BP } from './m59-client.mjs';
import { sharedRoomGeometry } from './m59-roo.mjs';
import { attachStepMasks, applyDoorState } from './m59-routes.mjs';
import { applyCeilingDoors, installDoorObserver } from './m59-ceiling-doors.mjs';
import { guildPassage, guildSection } from './m59-guild-passage.mjs';
const fresh = () => {
  const map = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url)));
  attachStepMasks(map);
  return { map, g: sharedRoomGeometry(map.rooms[714]), observed: new Map() };
};
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
  const c = { self: { row: 2, col: 32 }, room: {}, evSeq: 0, waitFor: async () => ({ events: [] }) };
  const open = id => {
    opened.push(id); observed.set(id, { type: 5, height: ({ 59:190,55:230,53:240,3:250 })[id] });
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
    s: { need: () => c, pacer: { submit: async (_kind, fn) => fn() },
      async walkTo(col, row) {
        assert.ok(g.path(c.self.row, c.self.col, row, col).found, `closed path to r${row}c${col}`);
        c.self = { row, col }; observed.clear(); applyCeilingDoors(map, 714, observed);
      } } };
  await guildPassage(k, 4, () => false);
  assert.equal(guildSection(c.self.row, c.self.col), 4);
  await guildPassage(k, 0, () => false);
  assert.equal(guildSection(c.self.row, c.self.col), 0);
  assert.deepEqual(opened, [59,55,53,3,3,53,55,59]);
  await assert.rejects(guildPassage(k, 4, () => true), /survival/);
});
