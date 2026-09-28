import assert from 'node:assert/strict';
import { summarizeAttempts } from './m59-node-attempts.mjs';
const sample=i=>({format:'m59-node-attempt/1',stone:'ancient',checkout_sha:'revision',broker_sha:'build',
  movement_epoch:'epoch',start:{room:579,x_client:75264,y_client:38400,floor_client:6560},
  scene_ref:'reset-'+i,route_ref:'route-v1',independent_reset:true,navigation:{status:'reached_box'},
  objective:{status:'already'},end:{room:579,row:52,col:30},recovery:{kind:'admin_rescue_after_trial',verified:true}});
const read=r=>summarizeAttempts(r).find(x=>x.stone==='ancient');
assert.equal(read([sample(1)]).route_verified,false);
assert.equal(read([sample(1),sample(2),sample(3)]).route_verified,true);
assert.equal(read([sample(1),sample(1),sample(1)]).route_verified,false);
assert.equal(read([sample(1),sample(2),{...sample(3),route_ref:'new-fix'}]).route_verified,false);
assert.equal(read([sample(1),sample(2),{...sample(3),end:{room:579,row:49,col:30}}]).route_verified,false);
assert.equal(read([sample(1),sample(2),sample(3)]).melds,0);
assert.equal(read([sample(1),sample(2),sample(3)]).escape_verified,false);
assert.equal(read([sample(1),sample(2),{...sample(3),broker_sha:undefined}]).route_verified,false);
assert.equal(read([sample(1),sample(2),{...sample(3),start:{...sample(3).start,floor_client:3200}}]).route_verified,false);
assert.equal(read([sample(1),sample(2),{...sample(3),movement_epoch:'another'}]).route_verified,false);
assert.equal(read([1,2,3].map(i=>({...sample(i),escape:{verified:true}}))).escape_verified,true);
console.log('m59-node-attempts: 11 assertions passed');
