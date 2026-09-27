#!/usr/bin/env node
// AN ASSIGNED ROOM OUTRANKS THE BYSTANDER CEILING, AND ONLY THAT.
//
//   node tools/m59-assigned-room-test.mjs
//
// Offline: binds Autopilot.prototype.preyRooms to a rig and reads the real spawn table. Opens
// no socket.
//
// 2026-09-27. Ukgoth (599) generates trolls and is rejected by the threat ceiling for its
// level-120 Guardians of Zjiria. The ukgoth-trolls rule assigned troll hunters to 599 on
// purpose, and they farmed it once inside — but anything that took them out of the room sent
// them to 516, because `preyRooms` dropped the assignment before `preferAssignedRoom` could put
// it first. Both keepers were noting "leaving for the explicitly assigned farming room" on the
// way somewhere else.
import { Autopilot } from './m59-autopilot.mjs';

let passed = 0, failed = 0;
const ok = (what, cond) => { if (cond) { passed++; console.log(`  ok   ${what}`); }
                             else { failed++; console.log(`  FAIL ${what}`); } };

const rig = (policy, extra = {}) => {
  const notes = [];
  const r = { policy, notes, note: (k, d) => notes.push({ k, d }),
    threatCeiling: () => 112, noWallRooms: new Map(), cappedRooms: new Map(),
    unreachable: new Set(), bansDestination: () => false, ...extra };
  r.preyRooms = Autopilot.prototype.preyRooms.bind(r);
  return r;
};
const here = { num: 2 };

{
  const r = rig({ hunt: ['troll'], assignedRoom: 599 });
  const rooms = r.preyRooms(here);
  ok('the assigned troll room is first even though the ceiling rejects it', rooms[0]?.room === 599);
  ok('and the keeper says so, once', r.notes.filter(n => n.k === 'keeping the assigned room over the threat ceiling').length === 1);
  r.preyRooms(here);
  ok('not twice', r.notes.filter(n => n.k === 'keeping the assigned room over the threat ceiling').length === 1);
}
{
  const rooms = rig({ hunt: ['troll'], assignedRoom: null }).preyRooms(here);
  ok('an unassigned keeper still honours the ceiling', !rooms.some(x => x.room === 599));
}
{
  const rooms = rig({ hunt: ['troll'], assignedRoom: 516 }).preyRooms(here);
  ok('a different assignment does not let 599 through', rooms[0]?.room === 516 && !rooms.some(x => x.room === 599));
}
{
  const r = rig({ hunt: ['troll'], assignedRoom: 599 }, { unreachable: new Set([599]) });
  ok('the other filters still apply: an unreachable assignment is not obeyed', !r.preyRooms(here).some(x => x.room === 599));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
