import assert from 'node:assert/strict';
import {railIdentityProblem,availableForTour,tourObjectiveComplete,atPost,withTourWalkOwnership,stableNodeGrant} from './m59-node-tour-policy.mjs';
import {tourReturnPlan} from './m59-node-tour.mjs';
import {keeperReloadProblem} from './m59-node-keeper-build.mjs';
const server={host:'example.test',port:5959},base={fleet:'prod',agent:'a',rostered:server,
  health:{fleet:'prod',game_server:server,session_characters:{a:'Example'}},expectedGame:'example.test:5959',checkedRail:true};
let n=0;const test=(name,fn)=>{fn();console.log('ok '+name);n++;};
test('explicit remote endpoint permits checked rail',()=>assert.equal(railIdentityProblem(base),null));
test('wrong server refuses',()=>assert.equal(railIdentityProblem({...base,expectedGame:'other:5959'}),'remote_requires_exact_expected_game'));
test('remote candidate jump refuses',()=>assert.equal(railIdentityProblem({...base,candidates:true}),'remote_requires_checked_declared_rail'));
test('remote incomplete rail refuses',()=>assert.equal(railIdentityProblem({...base,checkedRail:false}),'remote_requires_checked_declared_rail'));
test('wrong broker fleet refuses',()=>assert.equal(railIdentityProblem({...base,health:{...base.health,fleet:'shadow'}}),'fleet_or_game_endpoint_mismatch'));
test('another agent endpoint cannot borrow fleet identity',()=>assert.equal(railIdentityProblem({...base,health:{...base.health,session_game_servers:{a:{host:'other',port:5959}}}}),'fleet_or_game_endpoint_mismatch'));
test('human and active errand are deferred',()=>{assert.equal(availableForTour({piloted:{}}),false);assert.equal(availableForTour({committed:{label:'trade'}}),false);assert.equal(availableForTour({committed:{takeable:true}}),true);});
test('arrival with a dead node is not campaign completion',()=>assert.equal(tourObjectiveComplete({complete:true,nodes:[{status:'dead_node'},...Array(4).fill({status:'already'})]}),false));
test('already bonded counts as possession',()=>assert.equal(tourObjectiveComplete({complete:true,nodes:Array(5).fill({status:'already'})}),true));
test('mana grant requires a stable increase within the same keeper and login',()=>{
  const before={pid:11,connection_revision:1,mana:{max:25}},after={...before,mana:{max:30}};
  assert.equal(stableNodeGrant(before,after,after),true);
  assert.equal(stableNodeGrant(before,{...after,pid:12},{...after,pid:12}),false);
  assert.equal(stableNodeGrant(before,{...after,connection_revision:2},after),false);
  assert.equal(stableNodeGrant({...before,pid:undefined},after,after),false);
  assert.equal(stableNodeGrant(before,after,before),false);
});
test('post check requires actual room and square',()=>{assert.equal(atPost({room:2,row:19,col:8},{room:2,row:19,col:8}),true);assert.equal(atPost({room:39,row:19,col:8},{room:2,row:19,col:8}),false);});
test('every itinerary return ends at room2 without activation or admin steps',()=>{for(const room of [38,39,599,589,579,578,576,587,586,585,584,583,593,49,45,574,150,575,27,597,598]){const p=tourReturnPlan(room);assert.deepEqual(p.at(-1),{kind:'travel',to:2});assert.ok(p.every(s=>!['meld','place','heal'].includes(s.kind)));}});
test('cave recovery includes actual crossing',()=>assert.deepEqual(tourReturnPlan(27).slice(0,2),[{kind:'walk',row:57,col:45},{kind:'travel',to:587}]));
test('unknown recovery room refuses instead of guessing',()=>assert.throws(()=>tourReturnPlan(1),/no_measured_return/));
test('keeper reload is limited to the selected character in room2',()=>{
  const b={position:{room:2},identity:{agent:'a',character:'Example'},agent:'a',character:'Example'};
  assert.equal(keeperReloadProblem(b),null);
  assert.equal(keeperReloadProblem({...b,position:{room:579}}),'keeper_reload_requires_room2');
  assert.equal(keeperReloadProblem({...b,character:'Other'}),'keeper_reload_identity_mismatch');
});
await withTourWalkOwnership('child-rail',async()=>{
  assert.ok(globalThis.__m59OwnWalks.get('child-rail')>Date.now());
  await withTourWalkOwnership('child-rail',async()=>assert.ok(globalThis.__m59OwnWalks.get('child-rail')>Date.now()));
  assert.ok(globalThis.__m59OwnWalks.get('child-rail')>Date.now());
});
assert.equal(globalThis.__m59OwnWalks.has('child-rail'),false);
await assert.rejects(withTourWalkOwnership('child-rail',async()=>{throw Error('measured refusal');}),/measured refusal/);
assert.equal(globalThis.__m59OwnWalks.has('child-rail'),false);
console.log('ok child rail and return walks retain ownership through nesting and release on failure');n++;
console.log(n+' tour policy checks passed');
