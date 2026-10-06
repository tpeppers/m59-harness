#!/usr/bin/env node
// Offline tests for swarm follow (m59-swarm-follow.mjs). No broker, keeper or socket: the state
// files live in a fresh temp directory (M59_SWARM_DIR).
//
// Pins: the 30 MAXIMUM-health line (29 out, 30 in, unread out); hosts, noncombatants, human-held
// characters and the leader himself never join; the leader's room comes from the freshest keeper
// that SEES him and a stale sighting is no evidence; every follower in a room computes the same
// slot assignment from the same view; the wedge trails BEHIND the leader's walking direction, on
// alternating sides, never on his square; and the door he took is inferred from his last square --
// a go exit in reach, else the room edge he stood against, else nothing (no guessed door).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-swarm-follow-test-'));
process.env.M59_SWARM_DIR = dir;
const sw = await import('./m59-swarm-follow.mjs');
let passed = 0;
const ok = () => { passed++; };

try {
  // ------------------------------------------------------------ eligibility
  const base = { agent: 't5', room: 106, max_health: 80, at: Date.now() };
  assert.equal(sw.eligibility({ ...base, max_health: 29 }).ok, false);
  assert.equal(sw.eligibility({ ...base, max_health: 30 }).ok, true);
  assert.equal(sw.eligibility({ ...base, max_health: null }).ok, false, 'an unread maximum is not 30');
  assert.match(sw.eligibility({ ...base, max_health: 25 }).why, /under 30/);
  ok();
  assert.equal(sw.eligibility({ ...base, host: true }).ok, false);
  assert.equal(sw.eligibility({ ...base, noncombatant: true }).ok, false);
  assert.equal(sw.eligibility({ ...base, piloted: true }).ok, false);
  assert.equal(sw.eligibility({ ...base, agent: 't21' }, { leader: 't21' }).ok, false);
  assert.equal(sw.eligibility({ ...base, room: 1 }).ok, false, 'the Underworld is not a room to follow from');
  ok();

  // ------------------------------------------------------------ the leader's room
  const now = Date.now();
  assert.equal(sw.leaderRoom([{ agent: 'a', room: 106, sees_leader: true, at: now - 3000 },
                              { agent: 'b', room: 101, sees_leader: true, at: now - 100 },
                              { agent: 'c', room: 714, sees_leader: false, at: now }]), 101,
               'the freshest keeper that sees him');
  assert.equal(sw.leaderRoom([{ agent: 'c', room: 714, sees_leader: false, at: now }]), null);
  ok();

  // ------------------------------------------------------------ state and sightings on disk
  sw.writeState('lab', { leader: 't21', members: { t5: { home_room: 106, character: 'Bunsen' } }, phase: 'following' });
  const m = sw.membership(sw.readState('lab'), 't5');
  assert.deepEqual([m.on, m.member, m.leader, m.phase, m.home], [true, true, 't21', 'following', 106]);
  assert.equal(sw.membership(sw.readState('lab'), 't6').member, false);
  assert.equal(sw.membership({ ...sw.readState('lab'), ended_at: now }, 't5').on, false, 'an ended swarm holds nobody');
  ok();
  sw.writeSighting('lab', 't5', { agent: 't5', room: 106, at: now });
  sw.writeSighting('lab', 't6', { agent: 't6', room: 106, at: now - sw.SIGHTING_FRESH_MS - 1 });
  assert.deepEqual(sw.readSightings('lab', { now }).map(s => s.agent), ['t5'], 'a stale sighting is no evidence');
  assert.deepEqual(sw.readSightings('nobody', { now }), []);
  ok();

  // ------------------------------------------------------------ slots
  assert.equal(sw.slotIndex('t5', ['t9', 't10', 't5']), 0, 'numeric order: t5 is first');
  assert.equal(sw.slotIndex('t10', ['t9', 't5', 't10']), 2, 'numeric order: t5 < t9 < t10');
  assert.equal(sw.slotIndex('t9', ['t10', 't5', 't9']), sw.slotIndex('t9', ['t9', 't5', 't10']),
               'the same members in any order give the same slot');
  assert.equal(sw.slotIndex('t7', ['t5']), 1, 'a follower not yet listed still gets a slot');
  ok();

  // ------------------------------------------------------------ the wedge
  const leader = { row: 10, col: 10 };
  const east = { dr: 0, dc: 1 };          // walking east (columns rising)
  const slots = [0, 1, 2, 3].map(i => sw.wedgeSlot(leader, east, i));
  for (const s of slots) assert.ok(s.col < leader.col, 'every slot is behind (west of) a leader walking east');
  assert.equal(slots[0].row + slots[1].row, 2 * leader.row, 'the first pair sits either side of his line');
  assert.notEqual(slots[0].row, slots[1].row);
  assert.ok(sw.chebyshev(slots[2], leader) > sw.chebyshev(slots[0], leader), 'the second rank is further back');
  assert.equal(new Set(slots.map(s => `${s.row},${s.col}`)).size, 4, 'no two followers share a square');
  for (const s of slots) assert.ok(!(s.row === leader.row && s.col === leader.col), 'nobody on his square');
  ok();
  assert.deepEqual(sw.headingBetween({ row: 5, col: 5 }, { row: 5, col: 8 }), { dr: 0, dc: 1 });
  assert.equal(sw.headingBetween({ row: 5, col: 5 }, { row: 5, col: 5 }), null);
  const rest = sw.restingHeading({ row: 10, col: 10 }, [{ row: 10, col: 6 }, { row: 11, col: 7 }]);
  assert.ok(rest.dc > 0, 'a still leader faces away from where his swarm already stands');
  assert.ok(sw.wedgeSlot({ row: 10, col: 10 }, rest, 0).col < 10, 'so the wedge forms on their side');
  ok();

  // ------------------------------------------------------------ which door he took
  const inn = { num: 106, rows: 20, cols: 30, goExits: [
    { row: 17, col: 12, to: 101, locked: false }, { row: 4, col: 17, to: -1, locked: true }], edgeExits: [] };
  assert.equal(sw.inferExit(inn, { row: 16, col: 12 })?.to, 101, 'a door in reach of his last square');
  assert.equal(sw.inferExit(inn, { row: 4, col: 16 }), null, 'a locked door is never the answer');
  assert.equal(sw.inferExit(inn, { row: 9, col: 15 }), null, 'nowhere near a door: no guess');
  ok();
  const field = { num: 2, rows: 25, cols: 44, goExits: [], edgeExits: [
    { leaveName: 'west', to: 599 }, { leaveName: 'south', to: 3 }] };
  assert.equal(sw.inferExit(field, { row: 12, col: 1 })?.to, 599, 'against the west edge');
  assert.equal(sw.inferExit(field, { row: 25, col: 20 })?.to, 3, 'against the south edge');
  assert.equal(sw.inferExit(field, { row: 1, col: 20 }), null, 'an edge with no exit is not a door');
  assert.equal(sw.inferExit(null, { row: 1, col: 1 }), null);
  ok();

  assert.equal(sw.holderFor('t21'), 'swarm/t21@terminal', 'the prefix CombatMode keys the warband on');
  ok();

  console.log(`m59-swarm-follow-test: ${passed} passed, 0 failed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
