#!/usr/bin/env node
// THE NO-COMBAT LOCK -- offline, no socket, no roster.
//
//   node tools/m59-no-combat-lock-test.mjs
//
// Operator, 2026-10-29: "keep any characters in whatever rooms I leave them in ... stay locked to their current rooms *as
// long as it's a no combat room* and have the lockdown auto-shepherd people to the nearest no combat room ... Make this
// the default lockdown behavior going forward: any no combat room is acceptable." What this pins:
//   * off by default, and off it changes nothing;
//   * in a NO_COMBAT room the lock is THAT room (assigned_room and confine_rooms), whatever was assigned before, and a
//     journey suspended toward the old room is dropped -- a relogged keeper must not walk back to where it was locked;
//   * outside one it walks to the nearest NO_COMBAT room by hops, locked there first so the confinement gate lets it go,
//     and adopts it on arrival; never from the Underworld, never over a journey already moving the body, at most every 20 s;
//   * the pass adopts before anything can move the body, and shepherds after the survival ladder;
//   * the broker carries lock_no_combat.
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};
const A = await import('./m59-autopilot.mjs');
const P = A.Autopilot.prototype;

// A world of five rooms: 10 (inn, NO_COMBAT) - 11 - 12 - 13 - 14 (shop, NO_COMBAT); 11..13 are fields.
const ROOMS = { 10: { flags: 2 }, 11: { flags: 0 }, 12: { flags: 0 }, 13: { flags: 0 }, 14: { flags: 2 } };
function keeper({ room, policy = {}, travelArrives = true } = {}) {
  const k = {
    policy: { lockNoCombat: true, assignedRoom: null, confineRooms: null, ...policy },
    notes: [], travels: [], progressed: [],
    note(msg, data) { this.notes.push({ msg, data }); },
    progress(msg) { this.progressed.push(msg); },
    async travel(to, opts) { this.travels.push({ to, opts, confine: [...(this.policy.confineRooms ?? [])] });
      if (travelArrives) this.s.world.room = { num: to }; return { arrived: travelArrives }; },
  };
  k.s = { world: { room: { num: room }, map: { rooms: ROOMS },
    route: to => ({ found: ROOMS[to] != null, hops: Array.from({ length: Math.abs(Number(to) - Number(k.s.world.room.num)) }) }) } };
  for (const m of ['noCombatLockAdopt', 'noCombatLockShepherd', 'nearestNoCombatRoom']) k[m] = P[m];
  return k;
}

console.log('off by default');
{
  const src = (await import('node:fs')).readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('the keeper default is lockNoCombat: false', /\n\s*lockNoCombat: false,/.test(src));
  const k = keeper({ room: 10, policy: { lockNoCombat: false, assignedRoom: 14, confineRooms: [14] } });
  ok('off, in an inn: nothing adopted', k.noCombatLockAdopt() === null && k.policy.assignedRoom === 14);
  const f = keeper({ room: 12, policy: { lockNoCombat: false } });
  ok('off, in a field: nothing walks', await f.noCombatLockShepherd() === false && f.travels.length === 0);
}

console.log('a no-combat room is the lock');
{
  const k = keeper({ room: 14, policy: { assignedRoom: 10, confineRooms: [10] } });
  k.suspendedJourney = { to: 10 };
  ok('left in the shop (14), locked to 14', k.noCombatLockAdopt() === 14 && k.policy.assignedRoom === 14 && k.policy.confineRooms.join() === '14');
  ok('the journey back to the old room (10) is dropped', k.suspendedJourney === null);
  ok('and it says so', k.notes.some(n => /locked to the no-combat room/.test(n.msg) && n.data.was.assigned_room === 10));
  const again = k.notes.length;
  ok('already locked here: no change, no note', k.noCombatLockAdopt() === 14 && k.notes.length === again);
  ok('a no-combat room never shepherds', await k.noCombatLockShepherd() === false && k.travels.length === 0);
  const u = keeper({ room: 1 });
  ok('the Underworld is never adopted', u.noCombatLockAdopt() === null);
}

console.log('outside one, to the nearest');
{
  const k = keeper({ room: 13, policy: { assignedRoom: 10, confineRooms: [10] } });
  ok('nearest from 13 is the shop (14), one hop', k.nearestNoCombatRoom()?.room === 14);
  ok('it walks', await k.noCombatLockShepherd() === true && k.travels.length === 1 && k.travels[0].to === 14);
  ok('locked to the destination before the journey (the confinement gate lets it go)', k.travels[0].confine.join() === '14');
  ok('adopted on arrival', k.s.world.room.num === 14 && k.policy.assignedRoom === 14 && k.policy.confineRooms.join() === '14');
  const j = keeper({ room: 11 });
  ok('nearest from 11 is the inn (10)', j.nearestNoCombatRoom()?.room === 10);
  const busy = keeper({ room: 12 }); busy.inert = { travelling: true };
  ok('a journey already moving the body is left alone', await busy.noCombatLockShepherd() === false && busy.travels.length === 0);
  const slow = keeper({ room: 12, travelArrives: false });
  await slow.noCombatLockShepherd();
  ok('not arrived: asked again no sooner than 20 s', await slow.noCombatLockShepherd() === false && slow.travels.length === 1);
  const dead = keeper({ room: 1 });
  ok('never from the Underworld', await dead.noCombatLockShepherd() === false && dead.travels.length === 0);
}

console.log('the pass and the broker');
{
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const once = src.slice(src.indexOf('  async passOnce() {'));
  const live = once.indexOf("if (!s.live) { this.note('not in game'); return; }"), adopt = once.indexOf('this.noCombatLockAdopt();');
  const combat = once.indexOf('if (s.combat?.active) {'), surv = once.indexOf('if (await this.continueSurvivalDecision()) return;');
  const herd = once.indexOf('if (await this.noCombatLockShepherd()) return;');
  ok('adopted after the live check, before combat and survival', live >= 0 && adopt > live && adopt < combat && adopt < surv);
  ok('shepherded after the survival ladder', herd > surv);
  const broker = (await import('node:fs')).readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  ok('the broker carries lock_no_combat', /a\.lock_no_combat !== undefined\) p\.policy\.lockNoCombat = a\.lock_no_combat === true/.test(broker)
     && /lock_no_combat: \{ type: 'boolean'/.test(broker));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
