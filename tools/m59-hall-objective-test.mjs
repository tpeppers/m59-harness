import assert from 'node:assert/strict';
import {withHallObjective} from './m59-guild-defense-controller.mjs';
import {bodyAuthority} from './m59-body-command.mjs';
const prior=()=>true;
const s={combatEpoch:0,combat:{active:{id:'fight'},pvpEligibility:prior,
  issue(order){assert.equal(order.action,'stop');this.active=null;s.combatEpoch++;}}};
assert.throws(()=>bodyAuthority(s).guard(),/combat override/);
await withHallObjective(s,async()=>{
  assert.equal(s.combat.pvpEligibility(),false);
  bodyAuthority(s).guard();
  await Promise.resolve();bodyAuthority(s).guard();
  await withHallObjective(s,async()=>assert.equal(s.combat.pvpEligibility(),false));
  assert.equal(s.combat.pvpEligibility(),false,'nested objective restores outer policy');
});
assert.equal(s.combat.pvpEligibility,prior);
delete s.combat.pvpEligibility;
await assert.rejects(withHallObjective(s,async()=>{throw Error('cancelled');}),/cancelled/);
assert.equal(Object.hasOwn(s.combat,'pvpEligibility'),false);
console.log('Hall objective: combat ownership, async action, nested scope and error restoration passed');
