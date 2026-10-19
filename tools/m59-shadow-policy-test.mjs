import assert from 'node:assert/strict';import {clonePolicy,policyFidelity} from './m59-shadow-policy.mjs';
const source={policy:{buyReagents:false,buyFood:false,buyWeapons:false,restBelow:0,practiceSpells:[],roomEnchant:null,buddy:{pairs:{t1:'t2'}},custom:{enabled:false}}};
const result=clonePolicy(source,{overlay:{townTrips:false,assignedRoom:827},identities:{t1:'copy1',t2:'copy2'}});
assert.equal(result.policy.buyReagents,false);assert.equal(result.policy.restBelow,0);assert.deepEqual(result.policy.buddy.pairs,{copy1:'copy2'});assert.equal(source.policy.buddy.pairs.t1,'t2');
assert(policyFidelity(result.policy,structuredClone(result.policy)).ok);assert(!policyFidelity(result.policy,{...result.policy,buyReagents:true}).ok);assert(!policyFidelity(result.policy,{}).ok);
assert.deepEqual(result.changes.assignedRoom,{source:null,scenario:827});console.log('PASS whole-policy fidelity, explicit overlay differences, false/zero/null and cloned identity references');

const {shadowAbilityResponseRejected}=await import('./m59-shadow-fidelity.mjs');assert(!shadowAbilityResponseRejected('send object 123 InvalidateData\nReturned NIL'));assert(shadowAbilityResponseRejected('Invalid message id'));console.log('PASS echoed InvalidateData is not mistaken for an invalid setup response');
