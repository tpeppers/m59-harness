// THE DEFAULT LOCKDOWN SHAPE (operator 2026-10-29): ANY NO-COMBAT ROOM IS ACCEPTABLE. A committed EXAMPLE, beside
// substrate/postures/; copy it there to make it this machine's.
//
//   node tools/m59-posture.mjs apply   example-no-combat-lock --fleet <name>
//   node tools/m59-posture.mjs release example-no-combat-lock --fleet <name>
//
// Every character is locked to the NO_COMBAT room it stands in (every inn, shop, bank and hall), and the keeper itself
// keeps it that way (lock_no_combat, docs/m59-joints.md): a character a person walks to another inn and logs off stays
// THERE, and one left outside a no-combat room walks to the nearest and locks there. assigned_room and confine_rooms are
// set only where the unit stands in one, so the save holds them for the release and tend never fights the keeper's
// choice of destination.
import { isNoCombatRoom } from '../../tools/m59-hazards.mjs';

export default {
  name: 'example-no-combat-lock',
  about: 'every character stays in the no-combat room it is in (outside one: the nearest); no farming, no town trips',
  who: { min_max_health: 1 },
  orders: unit => ({
    lock_no_combat: true, farm_strategy: null, town_trips: false,
    ...(unit.room && isNoCombatRoom(unit.room) ? { assigned_room: unit.room, confine_rooms: [unit.room] } : {}),
  }),
  pause_jobs: false,
};
