#!/usr/bin/env node
// Offline: leaving the Bookmaker's hall from the CHEST side (section 4) crosses the secret door
// first, and a crossing that stops in the doorway is not reported as a crossing.
//
//   node --test tools/m59-chestroom-exit-test.mjs
//
// PROD, 2026-10-01. Camilla (t9) stood in the chest corridor at r11c4 and every journey out of
// 714 failed with `guild door 53 trigger not reached`, the keeper logging "coarse grid failed
// (no route through the geometry), trying fine grid to ... [requested square r11c13]". Door 53's
// trigger is in section 3; she was in section 4. Two defects, either sufficient:
//
//   1. substrate/m59-ceiling-doors.json was baked at step-mask version 6 and the runtime enforces
//      7 (adba179). `applyCeilingDoors` refuses a table of another version WHOLESALE, so no
//      ceiling door in any of the 26 rooms ever opened in the mover's geometry: the password was
//      said, the server raised the door, and the mover still refused r7c7 -> r7c8.
//   2. `guildSection` filed r7c7 in section 3. Its membership test accepted the planner's goal
//      exemption, and the one step a shut door refuses is exactly the exempted last step. So the
//      body stopping in the doorway read as "crossed", the door shut behind the five-second
//      timer, and the next leg set off for door 53 from a square sealed in with the chests.
//
// The mover here is honest the way the live one is: a step lands only if `moverStepLands` says
// so, and a walk stops at the first step it cannot take.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sharedRoomGeometry, STEP_MASK_VERSION } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { applyCeilingDoors } from './m59-ceiling-doors.mjs';
import { guildPassage, guildSection, doors } from './m59-guild-passage.mjs';

const OPEN = { 59: 190, 55: 230, 53: 240, 3: 250 };

function hall(start, { refuseAcross = false } = {}) {
  const map = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url)));
  attachStepMasks(map);
  const g = sharedRoomGeometry(map.rooms[714]), observed = new Map(), opened = [], log = [];
  applyCeilingDoors(map, 714, observed);
  const c = { self: { ...start }, room: { id: 2572, sectorHeights: observed }, evSeq: 0, events: [],
    waitFor: async ({ since, match }) => ({ events: c.events.filter(e => e.seq > since && (!match || match(e))) }) };
  const open = id => {
    opened.push(id); observed.set(id, { type: 5, height: OPEN[id] });
    c.events.push({ kind: 'sector-height', sector: id, room: 2572, height: OPEN[id], speed: 0,
      at: Date.now(), seq: ++c.evSeq });
    applyCeilingDoors(map, 714, observed);
  };
  const shutAll = () => { observed.clear(); applyCeilingDoors(map, 714, observed); };
  c.go = () => {
    const { row, col } = c.self;
    if (col === 28 && [3, 4].includes(row)) open(59);
    else if (col === 10 && [18, 19].includes(row)) open(55);
    else if (col === 13 && [11, 13].includes(row)) open(53);
  };
  const lands = (row, col) => g.moverStepLands(c.self.row, c.self.col, row, col) &&
    !(refuseAcross && c.self.row === 7 && c.self.col === 7 && row === 7 && col === 8);
  const s = { need: () => c, world: { geometry: g }, pacer: { submit: async (_k, fn) => fn() },
    async step(col, row) {
      if (!lands(row, col)) return { moved: false, reason: 'the mover refused the step' };
      c.self = { row, col }; return { moved: true };
    },
    // Every walk starts with the doors shut: they close five seconds after opening, and a
    // walk between two doors is longer than that.
    async walkTo(col, row) {
      shutAll();
      const path = g.path(c.self.row, c.self.col, row, col);
      if (!path.found) return { reason: 'coarse grid failed (no route through the geometry)' };
      for (const next of path.steps) {
        if (!lands(next.row, next.col)) return { reason: 'no_ground_gained' };
        c.self = { row: next.row, col: next.col };
      }
      return { arrived: true };
    } };
  const k = { s, note: (what, facts) => log.push({ what, ...facts }),
    sayHallPassword: async () => { open(3); return { ok: true }; } };
  return { k, c, g, map, observed, opened, log };
}

test('the shipped ceiling table is the version the runtime will apply', () => {
  const table = JSON.parse(readFileSync(new URL('../substrate/m59-ceiling-doors.json', import.meta.url)));
  assert.equal(table.version, STEP_MASK_VERSION,
    'a table of another version is refused wholesale, and every ceiling door stays shut in the mover');
});

test('with the secret door open, the mover can step from the doorway to its across square', () => {
  const { g, map, observed } = hall({ row: 11, col: 4 });
  assert.equal(g.moverStepLands(7, 7, 7, 8), false, 'shut, the slab refuses the step');
  observed.set(3, { type: 5, height: OPEN[3] });
  assert.ok(applyCeilingDoors(map, 714, observed), 'the open state is applied, not refused');
  assert.equal(g.moverStepLands(7, 7, 7, 8), true, 'open, the step lands');
});

test('the doorway square r7c7 is still the chest side', () => {
  for (const [r, c] of [[10, 4], [11, 4], [13, 4], [14, 4], [7, 4], [7, 7]])
    assert.equal(guildSection(r, c), 4, `r${r}c${c}`);
  assert.equal(guildSection(7, 8), 3, 'the across square is section 3');
});

test('from r11c4 the way out starts at the secret door, then 53, 55 and 59', async () => {
  const { k, c, opened, log } = hall({ row: 11, col: 4 });
  assert.equal(guildSection(c.self.row, c.self.col), 4);
  await guildPassage(k, 0, () => false);
  assert.equal(opened[0], doors[3].sector, 'the first door worked is sector 3, the spoken one');
  assert.deepEqual(opened, [3, 53, 55, 59]);
  assert.equal(guildSection(c.self.row, c.self.col), 0, 'out in the foyer');
  const first = log.find(e => e.what === 'guild door passage');
  assert.equal(first.sector, 3);
  assert.deepEqual(first.at, { row: 7, col: 8 }, 'the crossing ends ON the across square');
});

test('a crossing that stops in the doorway is not reported as crossed', async () => {
  const { k, c, log } = hall({ row: 11, col: 4 }, { refuseAcross: true });
  await assert.rejects(guildPassage(k, 0, () => false), /guild door 3 could not be crossed/,
    'not "guild door 53 trigger not reached" from a square sealed in with the chests');
  assert.deepEqual(c.self, { row: 7, col: 7 });
  const passages = log.filter(e => e.what === 'guild door passage');
  assert.equal(passages.length, 3);
  assert.ok(passages.every(e => e.sector === 3 && e.crossed === false));
});
