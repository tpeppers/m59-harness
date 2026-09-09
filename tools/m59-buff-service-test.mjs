#!/usr/bin/env node
// Offline contract for the ally-buff service. Opens no socket and joins nobody.
//
// The behaviour under test: a posted caster with an ally in the room casts super strength
// and bless on them, because that helps the ally AND is the only way the spell improves.
// The parts worth pinning are the refusals -- a cast that cannot pay its reagents is
// refused server-side and, from the client, looks exactly like a cast that landed on
// somebody who was already enchanted. Guessing there wastes reagents silently.

import { Autopilot } from './m59-autopilot.mjs';
import { OF } from './m59-parse.mjs';

let passed = 0, failed = 0;
const ok = (what, cond) => {
  if (cond) { passed++; console.log('  ok  ', what); }
  else { failed++; console.log('  FAIL', what); }
};

const SS = Autopilot.BUFFS.find(b => b.name === 'super strength');
const BLESS = Autopilot.BUFFS.find(b => b.name === 'bless');

// A client stub shaped like the real one where buffAllies touches it.
const makeAp = ({ pack = [], spells = [], others = 1, mana = 30, ability = 20,
                  cfg = { enabled: true } } = {}) => {
  const names = new Map();
  const inv = pack.map(([name, amount], i) => { names.set(2000 + i, name);
                                                return { id: 500 + i, nameRsc: 2000 + i, amount }; });
  const spl = spells.map(([name, id], i) => { names.set(3000 + i, name);
                                              return { id, nameRsc: 3000 + i }; });
  const objs = new Map();
  for (let i = 0; i < others; i++) objs.set(90 + i, { id: 90 + i, flags: OF.PLAYER, nameRsc: 4000 });
  names.set(4000, 'Ally');
  objs.set(1, { id: 1, flags: OF.PLAYER, nameRsc: 4000 });          // us
  const abilities = new Map(spl.map(sp => [sp.id, { ability }]));
  const client = {
    selfId: 1, inventory: inv, spells: spl, abilities,
    rsc: { get: r => names.get(r) ?? '' },
    room: { objects: objs },
    vitals: () => ({ mana: { value: mana } }),
    cast: async () => { client.casts++; return true; },
    waitFor: async () => ({ events: [] }),
  };
  client.casts = 0;
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { buffAllies: cfg };
  ap.tally = {};
  ap.declined = [];
  ap.notes = [];
  ap.s = { client, need: () => client, pacer: { submit: async (_k, fn) => fn() } };
  ap.declinedCast = (what, why, detail) => { ap.declined.push({ what, why, detail }); };
  ap.recordCast = () => {};
  ap.note = (what, detail) => { ap.notes.push({ what, detail }); };
  ap.progress = () => {};
  return ap;
};

const FULL = [['mushroom', 20], ['orc tooth', 10], ['sapphire', 10]];
const BOTH = [['super strength', 11], ['bless', 12]];

console.log('\nthe guaranteed duration is the HALF, never the roll');
{
  const ap = Object.create(Autopilot.prototype);
  // Random(d/2, d) promises only d/2, so a recast timer may assume no more than that.
  ok('super strength at ability 20 (power 10) holds at least 180s',
     ap.buffFloorMs(SS, 20) === ((300 + 60) * 1000) / 2);
  ok('bless at ability 20 holds at least 50s',
     ap.buffFloorMs(BLESS, 20) === ((40 + 60) * 1000) / 2);
  ok('a mature super strength holds at least 300s',
     ap.buffFloorMs(SS, 100) === ((300 + 300) * 1000) / 2);
  ok('ability 0 still yields the base', ap.buffFloorMs(SS, 0) === (300 * 1000) / 2);
}

console.log('\nreagents are counted before the cast, not inferred from its failure');
{
  const ap = makeAp({ pack: [['mushroom', 5], ['orc tooth', 0]], spells: BOTH });
  ok('a partial stack counts', ap.reagentOnHand('mushroom') === 5);
  ok('an absent reagent is zero', ap.reagentOnHand('sapphire') === 0);
  ok('names match on substring, as the server varies them',
     makeAp({ pack: [['blue mushroom', 3]] }).reagentOnHand('mushroom') === 3);
}

console.log('\nan inert policy does nothing at all');
{
  // Set on the policy directly rather than through makeAp's parameter: a destructuring
  // default fires on `undefined`, so passing it in would silently test { enabled: true }.
  for (const cfg of [null, undefined, { enabled: false }]) {
    const ap = makeAp({ pack: FULL, spells: BOTH });
    ap.policy.buffAllies = cfg;
    await ap.buffAllies();
    ok(`policy ${JSON.stringify(cfg) ?? 'undefined'} casts nothing`, ap.s.client.casts === 0);
  }
}

console.log('\nwith an ally, reagents and mana, it casts super strength first');
{
  const ap = makeAp({ pack: FULL, spells: BOTH });
  await ap.buffAllies();
  ok('one cast went out', ap.s.client.casts === 1);
  ok('and it was super strength, the long one',
     ap.notes.at(-1)?.detail?.spell === 'super strength');
  ok('the note says how long it is good for',
     ap.notes.at(-1)?.detail?.holds_for_s === 180);
}

console.log('\nrefusals are named rather than silent');
{
  const noOne = makeAp({ pack: FULL, spells: BOTH, others: 0 });
  await noOne.buffAllies();
  ok('nobody to buff is said out loud', noOne.declined.at(-1)?.why === 'nobody else in the room to buff');
  ok('and nothing was cast', noOne.s.client.casts === 0);

  const broke = makeAp({ pack: [['mushroom', 20]], spells: BOTH });
  await broke.buffAllies();
  ok('a missing reagent is named, not guessed at',
     broke.declined.some(d => d.why === 'out of reagents'));
  ok('and it names which one is short',
     JSON.stringify(broke.declined).includes('orc tooth'));
  ok('nothing was cast without its reagents', broke.s.client.casts === 0);

  const dry = makeAp({ pack: FULL, spells: BOTH, mana: 2 });
  await dry.buffAllies();
  ok('low mana is a named refusal', dry.declined.at(-1)?.why === 'not enough mana');
}

console.log('\nit falls through to bless when super strength cannot be paid for');
{
  const ap = makeAp({ pack: [['mushroom', 20], ['sapphire', 10]], spells: BOTH });
  await ap.buffAllies();
  ok('bless went out instead', ap.notes.at(-1)?.detail?.spell === 'bless');
  ok('and the super strength shortfall was still recorded',
     ap.declined.some(d => d.why === 'out of reagents'));
}

console.log('\na target inside the guaranteed window is not re-buffed');
{
  const ap = makeAp({ pack: FULL, spells: BOTH });
  await ap.buffAllies();
  ok('first cast lands', ap.s.client.casts === 1);
  ap.lastBuffAt = 0;                                  // let the pass gap through
  await ap.buffAllies();
  // super strength is still up, so the second pass moves to bless rather than wasting it
  ok('the second pass does not repeat super strength',
     ap.notes.at(-1)?.detail?.spell === 'bless');
  ap.lastBuffAt = 0;
  await ap.buffAllies();
  ok('and with both up it casts nothing', ap.s.client.casts === 2);
}

console.log('\na caster who does not know the spell simply skips it');
{
  const ap = makeAp({ pack: FULL, spells: [['bless', 12]] });
  await ap.buffAllies();
  ok('bless is cast', ap.notes.at(-1)?.detail?.spell === 'bless');
  ok('and super strength was never attempted',
     !ap.declined.some(d => d.what === 'super strength'));
}

console.log('\nthe spell list can be narrowed by the doctrine');
{
  const ap = makeAp({ pack: FULL, spells: BOTH, cfg: { enabled: true, spells: ['bless'] } });
  await ap.buffAllies();
  ok('only the named spell is cast', ap.notes.at(-1)?.detail?.spell === 'bless');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
