#!/usr/bin/env node
// KILLING THE SMALL THING THAT IS STANDING IN THE WAY.
// Offline: no broker, no socket, no roster, no fleet.
//
// `tradeInPlaceIfWedged` is the only rung in the survival ladder that does not answer being
// stuck with movement. It had two gates that made it unreachable in the state it exists for:
//
//   1. `crowded()` was its FIRST line, above everything, so a room at or over
//      travelStopMaxThreats (6) refused the swing before anything asked whether the character
//      could still walk. `crowded()` implements "in a crowd the only wall is the EXIT", which
//      rests on the exit being reachable — and a wedge is precisely the state where it is not.
//   2. It required the character to be BELOW its flee line, so a routine jam was unanswerable
//      until somebody was nearly dead — by which time the room is always crowded too.
//
// Measured over 3,665 postmortems carrying a threat list: 3,131 (85.4%) died with 6 or more
// threats present, and 3,057 (83.4% of ALL deaths) did so with `swinging: false`. Clifford,
// lv55, The Flatlands, 2026-09-19: six spiders and an ant in melee reach, 36 wedges,
// gross_squares 0 over 60s, health 1/55, never swung, trail ending "survival alternatives
// exhausted for the current observation".
import { Autopilot } from './m59-autopilot.mjs';
import {OF} from './m59-parse.mjs';

let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
};

const SPIDER = { id: 1, name: 'spider', col: 11, row: 10, flags:OF.ATTACKABLE };
const TROLL  = { id: 2, name: 'troll',  col: 11, row: 10, flags:OF.ATTACKABLE };

const rig = ({ health = 0.9, wedged = { why: 'covered no ground for 25s', for_ms: 25000 },
               threats = 8, near = [SPIDER], overCeiling = ['troll'],
               policy = {}, hold = null } = {}) => {
  const calls = { fights: [], notes: [], crowdRefusals: [], progress: [] };
  const self = {
    policy, hold, tally: {},
    s: { client: { self: { col: 10, row: 10 }, rsc: { get: () => null } } },
    safety: () => ({ fleeAt: 0.7 }),
    holdWorks: () => false,
    armedForSure:()=>true,facultyHeld:()=>false,checkFreeze:()=>false,currentRecoveryWall:()=>null,
    weaponPriorityNow:()=>[],bannedWeaponsNow:()=>[],ledgerEvent:()=>{},
    planBlockerLure:()=>null,takeRecoverySpot:async()=>({took:false}),
    wedgedInPlace: () => wedged,
    threatCountHere: () => threats,
    travelStopMaxThreats: () => 6,
    crowded() { return this.threatCountHere() >= this.travelStopMaxThreats(); },
    refuseEngagement: (n) => (overCeiling.includes(String(n)) ? { why: 'over the ceiling' } : null),
    noteCrowdRefusal: (w) => calls.crowdRefusals.push(w),
    note: (what, data) => calls.notes.push({ what, ...data }),
    progress: (w) => calls.progress.push(w),
    async fightNow(opts) { calls.fights.push(opts.target); return { fought:true,killed: true }; },
  };
  const v = { health: { value: Math.round(health * 55), max: 55 } };
  self.s.client.vitals=()=>v;
  self.s.client.room={objects:new Map(near.map(o=>[o.id,o]))};
  return { self, v, near, calls };
};
const call = (self, near, v) => Autopilot.prototype.tradeInPlaceIfWedged.call(self, { near, v });

console.log('--- THE CLIFFORD CASE: wedged, dying, and the room is full ---');
{
  const { self, v, near, calls } = rig({ health: 1 / 55, threats: 8,
    near: [SPIDER, {...SPIDER, id: 3}, {...SPIDER, id: 4}] });
  const r = await call(self, near, v);
  ok('swings instead of dying without swinging', r === true, 'fought ' + calls.fights.join(','));
  ok('the crowd no longer vetoes a wedged body', calls.crowdRefusals.length === 0);
  ok('and the note records that it overrode the crowd',
     calls.notes[0]?.crowd_overridden === true && calls.notes[0]?.threats_here === 8);
}

console.log('\n--- NOT THAT LAST RESORT: full health, small thing in the way ---');
{
  const { self, v, near, calls } = rig({ health: 1.0, threats: 8, near: [SPIDER] });
  const r = await call(self, near, v);
  ok('a healthy wedged character clears the blocker', r === true, 'fought ' + calls.fights.join(','));
  ok('and says it was running the in-band rule, not desperation',
     calls.notes[0]?.mode === 'fight until clear', String(calls.notes[0]?.mode));
}

console.log('\n--- AND IT IS "SMALL CRITTERS", NOT "EVERYTHING ON THE ROAD" ---');
{
  const { self, v, near, calls } = rig({ health: 1.0, near: [TROLL] });
  const r = await call(self, near, v);
  ok('a healthy character does NOT pick a fight with an out-of-band troll', r === false);
  ok('nothing was swung at', calls.fights.length === 0);
  ok('and it says WHY, which is a doctrine choice not an absence',
     /without a reachable refuge/.test(String(calls.notes[0]?.what)), String(calls.notes[0]?.what));
}
{
  const { self, v, near, calls } = rig({ health: 1.0, near: [TROLL, { ...SPIDER, col: 12 }] });
  const r = await call(self, near, v);
  ok('but it will step over the troll to hit the in-band spider behind it',
     r === true && calls.fights[0] === 'spider', calls.fights.join(','));
}
{
  const { self, v, near, calls } = rig({ health: 1 / 55, near: [TROLL] });
  const r = await call(self, near, v);
  ok('a dying character does not newly provoke a larger blocker',
     r === false && calls.fights.length === 0);
}

console.log('\n--- the gates that must still hold ---');
{
  const { self, v, near, calls } = rig({ wedged: null });
  ok('not wedged is not a jam', (await call(self, near, v)) === false && calls.fights.length === 0);
}
{
  const { self, v, near, calls } = rig({ near: [] });
  ok('nothing in reach, nothing to clear', (await call(self, near, v)) === false);
}
{
  const { self, v, near, calls } = rig({ hold: { spot: true } });
  ok('a held safe spot owns the body', (await call(self, near, v)) === false);
}
{
  const { self, v, near } = rig({ policy: { tradeInPlaceWhenWedged: false } });
  ok('the existing off-switch still switches it off', (await call(self, near, v)) === false);
}
{
  // The aggro argument for the crowd veto is real; an operator must be able to take it back
  // without a deploy, which is the whole reason this is a policy key rather than a deletion.
  const { self, v, near, calls } = rig({ policy: { tradeInPlaceWhenCrowded: false }, threats: 8 });
  const r = await call(self, near, v);
  ok('tradeInPlaceWhenCrowded:false restores the OLD precedence', r === false);
  ok('and it is recorded as a crowd refusal', calls.crowdRefusals[0] === 'clearing a blocker');
}
{
  const { self, v, near, calls } = rig({ policy: { tradeInPlaceWhenCrowded: false }, threats: 2 });
  ok('...but only when actually crowded', (await call(self, near, v)) === true);
}

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
