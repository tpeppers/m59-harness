#!/usr/bin/env node
// A FIGHT MUST BE STOPPABLE FROM OUTSIDE IT.
//
//   node tools/m59-fightcancel-test.mjs      # offline, opens no socket, touches no roster
//
// WHAT THIS PINS AND WHY IT WAS WORTH BUILDING.
//
// `fight()` took no control token and no generation, and there is no `cancelAttack`
// anywhere in the tree — the watchdog's only interrupt is `cancelMovement`, which cancels
// WALKING. So once a keeper entered a fight the only ways out were inside the loop: the
// foe died, we died, the weapon shattered, health fell through the flee line, or THE ROUND
// COUNT RAN OUT.
//
// That made the round budget load-bearing for a job it was never designed for, which is
// exactly why the three call sites disagreed about it — 3 by omission (the main hunting
// fight never passed one, so it inherited fight()'s parameter default), 10 and 30 by
// choice — and why none of them argued for a number.
//
// What it cost while it stood, none of which the health floor covers:
//
//   * a commander_claim, an errand, a park or a shutdown could not reach a swinging
//     character. DUM's lease is 30s with a heartbeat; a long fight sails through it.
//   * vigor is not checked inside the loop AT ALL, and vigor sets the health regeneration
//     rate — 1.0 hp/s at 200 against 0.29 at 80.
//   * the room is invisible in there, so a crowd can build while "in a crowd the only wall
//     is the exit" never gets to run.
//
// THE GENERATION IS SEPARATE FROM MOVEMENT'S, ON PURPOSE. Nearly every `cancelMovement`
// caller in the keeper is the watchdog or a travel guard saying "stop walking" — breaking
// a wedge, pulling out of a blind walk. A wedged character that cannot move is supposed to
// SWING (`tradeInPlaceIfWedged`), so sharing one counter would have the watchdog cancel
// the one rung that exists for that case. The cancelled-TOKEN set is shared, because a
// command lease cancelled by token means "stop everything".

import { fight } from './m59-skills.mjs';
// The real flag, not a magic number: findCreature filters on `flags & OF.ATTACKABLE`,
// so a fake foe without it is invisible and the fight reports an empty room.
import { OF } from './m59-parse.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  — ' + extra : '')); }
};

// A session stripped to what fight() touches. The foe never dies and never drifts, so the
// ONLY way any of these tests can terminate is a cancel — which is the point.
function fakeSession({ hp = 40, max = 40 } = {}) {
  const foe = { id: 7, col: 1, row: 1, nameRsc: 1, flags: OF.ATTACKABLE };
  const objects = new Map([[7, foe], [1, { id: 1 }]]);
  const swings = [];
  const s = {
    name: 'test',
    fightGeneration: 0,
    movementGeneration: 0,
    cancelledMovementTokens: new Set(),
    fightWasCancelled(gen, token) {
      return gen !== this.fightGeneration ||
        (!!token && this.cancelledMovementTokens.has(token));
    },
    cancelFight(token, why = 'test') {
      this.fightGeneration++;
      if (token) this.cancelledMovementTokens.add(token);
      return { cancelled: true, why };
    },
    client: {
      selfId: 1, evSeq: 0,
      self: { id: 1, col: 1, row: 1 },
      room: { id: 1, objects },
      rsc: { get: () => 'battered skeleton' },
      vitals: () => ({ health: { value: hp, max } }),
      face: async () => {},
      equipment: async () => ({ using: ['long sword'] }),
      stats: async () => ({}),
      waitFor: async () => ({ events: [] }),
      attack: async () => ({}),
    },
    // `fight` reaches the client through `s.need()`, like every other skill.
    need() { return this.client; },
    pacer: { submit: async (_kind, fn) => fn?.() },
    // Every swing lands and the foe never dies: an uncancellable fight here runs for ever.
    attackRounds: async (_id, n, { shouldCancel = null } = {}) => {
      for (let i = 0; i < n; i++) {
        if (typeof shouldCancel === 'function' && shouldCancel())
          return { messages: [], vitals: s.client.vitals(), aborted: null,
                   cancelled: { at_swing: i } };
        swings.push(Date.now());
      }
      return { messages: ['You hit the battered skeleton.'], vitals: s.client.vitals(),
               aborted: null, cancelled: null };
    },
    lootFloor: async () => ({ taken: [], refused: [], carrying: [] }),
  };
  s.client.face = async () => {};
  return { s, swings, foe };
}

console.log('\nan uncancelled fight still runs its budget — the change is not a behaviour change');
{
  const { s, swings } = fakeSession();
  const out = await fight(s, { target: 'battered skeleton', preferId: 7, rounds: 5,
                               equip: false, loot: false, holdPosition: true, reach: 99 });
  ok('it fought every round it was given', out.rounds === 5, JSON.stringify(out.rounds));
  ok('...and did not report itself cancelled', !out.cancelled);
  ok('...and says the foe survived, as before', /still alive after 5 rounds/.test(out.note ?? ''),
     out.note);
  ok('five rounds is five swings', swings.length === 5, String(swings.length));
}

console.log('\ncancelling between rounds stops it, and says so');
{
  const { s } = fakeSession();
  // Cancel after the second round by bumping the generation from outside, exactly as
  // Session.cancelFight does.
  let n = 0;
  const orig = s.attackRounds;
  s.attackRounds = async (...a) => { if (++n === 2) s.cancelFight(null, 'a test'); return orig(...a); };
  const out = await fight(s, { target: 'battered skeleton', preferId: 7, rounds: 50,
                               equip: false, loot: false, holdPosition: true, reach: 99 });
  ok('it stopped long before the budget', out.rounds < 5, `rounds=${out.rounds}`);
  ok('and reports cancelled rather than "still alive"', out.cancelled === true, JSON.stringify(out).slice(0, 120));
  ok('...naming it as a cancellation, not a defeat', /cancelled/.test(out.note ?? ''), out.note);
  ok('...and it did NOT claim a kill', out.killed === false);
  // THE MONSTER IS STILL THERE. A caller that reads this as "fight over" and sits down
  // would be resting next to something hostile, which is how characters die.
  ok('the note says the monster is still hostile', /still there and still hostile/.test(out.note ?? ''));
}

console.log('\ncancelling by TOKEN works too, and is shared with movement');
{
  const { s } = fakeSession();
  const token = 'lease-abc';
  let n = 0;
  const orig = s.attackRounds;
  s.attackRounds = async (...a) => { if (++n === 2) s.cancelFight(token, 'commander'); return orig(...a); };
  const out = await fight(s, { target: 'battered skeleton', preferId: 7, rounds: 50,
                               controlToken: token, equip: false, loot: false,
                               holdPosition: true, reach: 99 });
  ok('a token cancel ends the fight', out.cancelled === true, JSON.stringify(out.rounds));
  // The token set is shared with movement on purpose: one lease, one cancel, both stopped.
  ok('and the token is in the shared set movement also reads',
     s.cancelledMovementTokens.has(token));
}

console.log('\na fight already cancelled before it starts never swings at all');
{
  const { s, swings } = fakeSession();
  s.cancelFight(null, 'cancelled first');
  const out = await fight(s, { target: 'battered skeleton', preferId: 7, rounds: 50,
                               // Read the generation from BEFORE the cancel, which is what a
                               // caller holding a stale generation looks like.
                               fightGeneration: 0,
                               equip: false, loot: false, holdPosition: true, reach: 99 });
  ok('it refuses to start', out.cancelled === true && out.rounds === 0, JSON.stringify(out.rounds));
  ok('...and buys no packets at all', swings.length === 0, String(swings.length));
}

console.log('\nmovement and fighting are cancelled SEPARATELY');
{
  // The load-bearing one. `cancelMovement` is what the watchdog calls to break a wedge, and
  // a wedged character that cannot move is supposed to keep swinging. If these shared a
  // counter, breaking a movement wedge would silently end the trade-in-place rung.
  const { s } = fakeSession();
  s.movementGeneration++;                       // exactly what cancelMovement does
  const out = await fight(s, { target: 'battered skeleton', preferId: 7, rounds: 4,
                               equip: false, loot: false, holdPosition: true, reach: 99 });
  ok('cancelling MOVEMENT does not cancel the fight',
     !out.cancelled && out.rounds === 4, JSON.stringify({ c: out.cancelled, r: out.rounds }));
}

// ============================================================ the two defensive manoeuvres
//
// Operator's doctrine, 2026-09-06: in a fight there are exactly two defensive moves.
//
//   1. NOT on a safe wall  ->  go to the nearest one.
//   2. ON a safe wall      ->  log off and back on, turn, and rest.
//
// Nothing else may interrupt a fight — not a town trip, not a breadcrumb retreat, not a
// wander to "somewhere I can heal". Those are the movement-shaped rungs a post-mortem
// records as "every decision correct, 0.0 squares per second, dead".
//
// The two are ONE law rather than two, which is why they belong together: what makes a
// square worth fleeing to is the same property that makes the logoff work there — nothing
// can reach it.
import { Autopilot } from './m59-autopilot.mjs';

const keeper = ({ hp = 10, max = 40, hold = null, works = false } = {}) => {
  const calls = { playDead: 0, takeSafeSpot: 0, notes: [] };
  const ap = Object.create(Autopilot.prototype);
  ap.policy = {}; ap.hold = hold; ap.doing = 'fighting';
  ap.safety = () => ({ fleeAt: 0.7 });
  ap.holdWorks = () => works;
  ap.note = (what, detail) => calls.notes.push({ what, detail });
  ap.playDead = async () => { calls.playDead++; return true; };
  ap.takeSafeSpot = async () => { calls.takeSafeSpot++; return { took: true }; };
  ap.s = { client: { vitals: () => ({ health: { value: hp, max } }) } };
  return { ap, calls };
};
const vit = (hp, max = 40) => ({ health: { value: hp, max } });
const near1 = [{ id: 7 }];

console.log('\non a working wall, the answer is the logoff — and only that');
{
  const { ap, calls } = keeper({ hp: 10, hold: { col: 1, row: 1 }, works: true });
  const did = await ap.defensiveAnswer({ near: near1, v: vit(10) });
  ok('it handles the pass', did === true);
  ok('...by logging off, which is manoeuvre 2', calls.playDead === 1);
  ok('...and does NOT go looking for another wall', calls.takeSafeSpot === 0);
}

console.log('\noff a wall, the answer is the nearest wall — and only that');
{
  const { ap, calls } = keeper({ hp: 10, hold: null, works: false });
  const did = await ap.defensiveAnswer({ near: near1, v: vit(10) });
  ok('it handles the pass', did === true);
  ok('...by taking the nearest wall, which is manoeuvre 1', calls.takeSafeSpot === 1);
  ok('...and does NOT log off in the open', calls.playDead === 0,
     'a freeze off a wall recovers no health and leaves us exactly where we were');
}

console.log('\nand it declines everything that is not a fight');
{
  const a = keeper({ hp: 10 });
  ok('nothing in reach: not this rung',
     await a.ap.defensiveAnswer({ near: [], v: vit(10) }) === false);
  const b = keeper({ hp: 39 });
  ok('above the flee line: not this rung',
     await b.ap.defensiveAnswer({ near: near1, v: vit(39) }) === false);
  // NARROWING THE LADDER FOR A CHARACTER MERELY HURT WHILE WALKING WOULD TAKE AWAY RUNGS
  // THAT ARE RIGHT. Travel has its own guard, and somebody bleeding in a corridor is not
  // having a fight.
  const c = keeper({ hp: 10 }); c.ap.doing = 'travelling'; c.ap.hold = null;
  ok('not in a fight and not at a wall: not this rung',
     await c.ap.defensiveAnswer({ near: near1, v: vit(10) }) === false);
  const d = keeper({ hp: 10 }); d.ap.policy = { defensiveAnswer: false };
  ok('and it can be switched off per character',
     await d.ap.defensiveAnswer({ near: near1, v: vit(10) }) === false);
}

console.log('\nwith nowhere to go it falls THROUGH rather than idling');
{
  // Refusing to fall through would strand a character that has no wall available, which is
  // the failure mode this whole file keeps paying for.
  const { ap, calls } = keeper({ hp: 10, hold: null });
  ap.takeSafeSpot = async () => ({ took: false, why: 'no candidate' });
  const did = await ap.defensiveAnswer({ near: near1, v: vit(10) });
  ok('it does not claim the pass', did === false);
  ok('...and says why exactly once', calls.notes.some(n => /no wall to reach/.test(n.what)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
