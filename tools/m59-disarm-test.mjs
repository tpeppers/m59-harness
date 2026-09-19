#!/usr/bin/env node
// TAKING THE WEAPON OFF, AND THE ONE OUTCOME THAT USED TO BE INVISIBLE.
// Offline: no broker, no socket, no roster, no fleet.
//
// `unuseTrainingWeapon()` joins the server's USE LIST to the pack ON THE OBJECT ID. That is
// the one identifier this repository has written down as untrustworthy — renumbered on every
// system save, recycled within hours. When the join missed, the function returned
// `{ready: true, already: true}`, which reads as "the hand was already empty".
//
// That is indistinguishable from success, and `passArm` notes only on `ready && removed` and
// complains only on `!ready` — so `ready && !removed` wrote NOTHING ANYWHERE. A brawler went
// on holding a sword with every gate true and no line in any log saying why.
//
// Measured on prod 2026-09-19: Floyd, `trainingStyle: unarmed`, mode farm, room 27,
// `assignedRoom` 27, holding a short sword, decision ring not advancing at all. It matters
// because a swing with a weapon zeroes `piWeaponSwings` against the proficiency being
// trained (player.kod:4753-4757), so an "unarmed" character holding a sword trains nothing.
//
// The asymmetry that caused it is worth seeing: `skills.isArmed` reads `o.name ?? rsc.get(...)`
// — NAME first — and this function read `rsc.get(...)` only. Two functions answering "what is
// in the hand" from different fields of the same object.
import { Autopilot } from './m59-autopilot.mjs';

let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
};

// A client carrying only what the function reads. `using` and `inventory` are DELIBERATELY
// allowed to disagree on ids, because that disagreement is the bug.
const rig = ({ usingIds = [], inventory = [], equipped = null, known = true } = {}) => {
  const c = {
    using: new Set(usingIds),
    inventory,
    evSeq: 1,
    rsc: { get: (k) => (k == null ? '' : String(k)) },
    equipment: () => (equipped === null ? { equipped: [], known } : { equipped, known }),
    unuse: async () => { c._unused = true; },
    waitFor: async () => ({ events: [] }),
  };
  const self = {
    s: { client: c, pacer: { submit: async (_k, fn) => fn() } },
  };
  return { self, c };
};

const call = (self) => Autopilot.prototype.unuseTrainingWeapon.call(self);

console.log('--- the hand is genuinely empty ---');
{
  const { self } = rig({ usingIds: [], inventory: [], equipped: [] });
  const r = await call(self);
  ok('reports already bare', r.ready === true && r.already === true,
     JSON.stringify(r));
}

console.log('\n--- the id join works (the ordinary case) ---');
{
  const { self, c } = rig({ usingIds: [10882],
    inventory: [{ id: 10882, nameRsc: 'short sword' }],
    equipped: [{ id: 10882, name: 'short sword' }] });
  const r = await call(self);
  ok('finds the held weapon and sends the unuse', c._unused === true, JSON.stringify(r).slice(0, 80));
  ok('and does not claim it was already bare', r.already !== true);
}

console.log('\n--- the id join MISSES but the hand is full: the case that was silent ---');
{
  // The use list and the pack disagree on the id — a renumbering, a recycle, or a rebuilt
  // list. The NAME still matches, which is what the server itself speaks.
  const { self, c } = rig({ usingIds: [999],
    inventory: [{ id: 10882, name: 'short sword' }],
    equipped: [{ id: 999, name: 'short sword' }] });
  const r = await call(self);
  ok('falls back to the NAME and still takes it off', c._unused === true, JSON.stringify(r).slice(0, 80));
  ok('never reports "already bare" while the server says it is armed', r.already !== true);
}
{
  // Nothing matches by either route, and the server still says armed. That is a
  // CONTRADICTION and must be a refusal, because a caller told "already bare" stops asking.
  const { self } = rig({ usingIds: [999],
    inventory: [{ id: 10882, name: 'a rock' }],
    // A REAL weapon name in the hand: `isArmed` scores the name, so an unrecognised one
    // would answer "not armed" and this case would test nothing.
    equipped: [{ id: 999, name: 'short sword' }] });
  const r = await call(self);
  ok('refuses rather than claiming success', r.ready === false && r.already !== true,
     JSON.stringify(r).slice(0, 90));
  ok('and says WHY, so passArm can complain where somebody reads it',
     /armed/.test(String(r.why ?? '')) && /use list/.test(String(r.why ?? '')));
}

console.log('\n--- an unreadable use list is still a question, not an empty hand ---');
{
  const { self } = rig({ usingIds: [1], inventory: [{ id: 1, name: 'mace' }],
    equipped: [{ id: 1, name: 'mace' }], known: false });
  const r = await call(self);
  ok('isArmed fails safe to ARMED when it cannot see, so this is not "already bare"',
     r.already !== true, JSON.stringify(r).slice(0, 90));
}

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
