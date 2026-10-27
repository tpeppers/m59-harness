#!/usr/bin/env node
// A CONFINED FARMER RELOCATES INSIDE ITS CONFINEMENT, AND FALLS BACK TO ITS STATION.
//
//   node tools/m59-confined-relocation-test.mjs
//
// Offline: binds Autopilot.prototype.preyRooms to a rig and reads the real spawn table, as
// m59-assigned-room-test.mjs does. Every caller of preyRooms takes [0] -- the hunt relocation,
// the spawn-cap and no-wall relocations, and roam -- so [0] is the room the body is sent to.
//
// PROD 2026-10-27. Zoot (t17), farm strategy kocatan-avar-warriors: confined to 2115, 2013 and
// the Ko'catan town (2000-2009), station 2115. Back from a town trip in 2005 at 13:50Z, he stood
// there `stranded in 2005` while `confinement_refused_travel` recorded the hunt relocation
// asking for 2131, 2143, 2142, 2144, 2134 and 2152 -- avar camps in the jungle, outside the
// confinement -- three refusals each, until an operator walked him to 2115 at 14:00Z. Lew,
// Scooter, Kermit, Piggy and Pepe did the same that day. 2115 had dropped out of the list
// because failed departures at the East Tower door had put it on the keeper's session
// `unreachable` set (m59-kocatan-door-test.mjs, m59-in-flight-hold-test.mjs).
import { Autopilot, confinedPreyRooms } from './m59-autopilot.mjs';

let passed = 0, failed = 0;
const ok = (what, cond) => { if (cond) { passed++; console.log(`  ok   ${what}`); }
                             else { failed++; console.log(`  FAIL ${what}`); } };

const TOWN = [2000, 2001, 2002, 2003, 2004, 2005, 2006, 2008, 2009];
const AVARS = ['peet-seeeep avar warrior', 'kyip-kyip-kreeet avar warrior'];
// substrate/farm-strategies/kocatan-avar-warriors.mjs and kocatan-dragonflies.mjs, as the
// strategy schema installs them: confine.rooms -> confineRooms, confine.station -> assignedRoom.
const ZOOT = { hunt: AVARS, assignedRoom: 2115, confineRooms: [2115, 2013, ...TOWN], roam: false };
const ANIMAL = { hunt: ['dragonfly'], assignedRoom: 2125, confineRooms: [2125, 2115, 2013, ...TOWN], roam: false };

const rig = (policy, extra = {}) => {
  const notes = [];
  const r = { policy, notes, note: (k, d) => notes.push({ k, d }),
    // High enough that the camps' level-135 chieftains pass, as they did live: the keeper
    // chose those camps, so its ceiling admitted them.
    threatCeiling: () => 140, noWallRooms: new Map(), cappedRooms: new Map(),
    unreachable: new Set(), bansDestination: () => false,
    s: { world: { map: { rooms: { 2115: { name: 'Outside the Guard Tower' }, 2125: { name: 'Into the Jungle' } } } } },
    ...extra };
  r.preyRooms = Autopilot.prototype.preyRooms.bind(r);
  return r;
};
const JUNGLE_CAMPS = [2131, 2143, 2142, 2144, 2134, 2152];

console.log('\nthe old answer, for the record: unconfined, the camps are prey rooms');
{
  const rooms = rig({ ...ZOOT, confineRooms: null }, { unreachable: new Set([2115]) }).preyRooms({ num: 2005 });
  ok('without a confinement the jungle camps are offered (Zoot\'s refused list)',
     rooms.length > 0 && rooms.every(r => r.room !== 2115) && rooms.some(r => JUNGLE_CAMPS.includes(r.room)));
}

console.log('\nZoot in the bank, 2115 already on the unreachable list');
{
  const r = rig(ZOOT, { unreachable: new Set([2115]) });
  const rooms = r.preyRooms({ num: 2005 });
  ok('nothing outside the confinement is offered', rooms.every(x => ZOOT.confineRooms.includes(x.room)));
  ok('the station is', rooms.length === 1 && rooms[0].room === 2115);
  ok('named, so the relocation can say where it is going', rooms[0].room_name === 'Outside the Guard Tower');
  ok('and marked as the fallback it is', rooms[0].station_fallback === true);
}

console.log('\nZoot in the bank, nothing wrong with 2115');
{
  const rooms = rig(ZOOT).preyRooms({ num: 2005 });
  ok('the station is first, as it always was', rooms[0]?.room === 2115);
  ok('and it is the ordinary spawn-table row, not the fallback', rooms[0]?.station_fallback !== true && rooms[0]?.chance > 0);
  ok('still nothing outside the confinement', rooms.every(x => ZOOT.confineRooms.includes(x.room)));
}

console.log('\nthe station was given up as spawn-capped earlier in the session');
{
  const capped = new Map([[2115, 'spawn cap 12/12 is occupied by 12x dragonfly']]);
  const away = rig(ZOOT, { cappedRooms: capped }).preyRooms({ num: 2005 });
  ok('from town, the station is still where a confined farmer goes back to', away[0]?.room === 2115);
  const there = rig(ZOOT, { cappedRooms: capped }).preyRooms({ num: 2115 });
  ok('standing in it, there is no "elsewhere" -- it stays at its station', there.length === 0);
}

console.log('\nAnimal, dragonflies at 2125');
{
  const home = rig(ANIMAL).preyRooms({ num: 2013 });
  ok('from the tower the station is first', home[0]?.room === 2125);
  ok('and only confined rooms are listed', home.every(x => ANIMAL.confineRooms.includes(x.room)));
  const lost = rig(ANIMAL, { unreachable: new Set([2125, 2115]) }).preyRooms({ num: 2013 });
  ok('with both dragonfly rooms written off, the station', lost.length === 1 && lost[0].room === 2125);
}

console.log('\nwhat the fallback will not do');
{
  ok('it never overrides an operator\'s ban on the station',
     rig(ZOOT, { unreachable: new Set([2115]), bansDestination: r => r === 2115 }).preyRooms({ num: 2005 }).length === 0);
  ok('it never names a station outside the confinement',
     rig({ ...ZOOT, assignedRoom: 2143 }, { unreachable: new Set([2115]) }).preyRooms({ num: 2005 }).length === 0);
  ok('a confinement with no station and no prey offers nothing (the farm then holds, no refusal loop)',
     rig({ ...ZOOT, assignedRoom: null }, { unreachable: new Set([2115]) }).preyRooms({ num: 2005 }).length === 0);
  ok('a body outside its confinement is offered the way back in',
     rig(ZOOT).preyRooms({ num: 202 })[0]?.room === 2115);
}

console.log('\nconfinedPreyRooms on its own');
{
  const rows = [{ room: 1 }, { room: 2 }, { room: 3 }];
  ok('no confinement: the list, untouched', confinedPreyRooms(rows, {}) === rows);
  ok('an empty confinement is no confinement', confinedPreyRooms(rows, { confine: [] }) === rows);
  ok('a confinement keeps only its rooms, in order',
     JSON.stringify(confinedPreyRooms(rows, { confine: [3, 1] }).map(r => r.room)) === '[1,3]');
  ok('room numbers given as strings still match', confinedPreyRooms(rows, { confine: ['2'] })[0]?.room === 2);
  ok('nothing inside and no station: empty', confinedPreyRooms(rows, { confine: [9] }).length === 0);
  ok('nothing inside: the station', confinedPreyRooms(rows, { confine: [9], station: 9, here: 4 })[0]?.room === 9);
  ok('but not when the body is already there', confinedPreyRooms(rows, { confine: [9], station: 9, here: 9 }).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
