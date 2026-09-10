import assert from 'node:assert/strict';
import {withIntent,setIntentTarget,intentObservation,installIntentObservers} from './m59-intent-observations.mjs';
import {Session} from './m59-game.mjs';
const c={selfId:17,room:{id:99,objects:new Map([[42,{col:61,row:30}]])}};
const s={client:c,live:true,movementGeneration:0,fightGeneration:0};
const target=()=>intentObservation(s,123).target;
assert.equal(target(),null);
await withIntent(s,{kind:'exit',col:76,row:27,destination_room:563},async()=>{
 assert.equal(target().destination_room,563);
 await withIntent(s,{kind:'move',col:72,row:27},async()=>assert.equal(target().kind,'exit'));
 assert.equal(target().kind,'exit');
});assert.equal(target(),null);
await withIntent(s,null,async()=>{
 setIntentTarget(s,{kind:'pickup',object_id:42});
 await withIntent(s,{kind:'move',col:60,row:30},async()=>assert.equal(target().object_id,42));
 c.room.objects.get(42).col=62;assert.equal(target().col,62,'moving target follows current cache');
 c.room.objects.delete(42);assert.equal(target(),null,'removed object is not a ghost');
});
c.room.objects.set(42,{col:61,row:30});
await assert.rejects(()=>withIntent(s,{kind:'attack',object_id:42},async()=>{assert.equal(target().kind,'attack');throw Error('same error');}),/same error/);
assert.equal(target(),null,'throw clears target');
await withIntent(s,{kind:'attack',object_id:42},async()=>{s.fightGeneration++;assert.equal(target(),null,'cancel clears before unwind');});
await withIntent(s,{kind:'move',col:61,row:30},async()=>{s.movementGeneration++;assert.equal(target(),null);});
await withIntent(s,{kind:'move',col:61,row:30},async()=>{c.room.id++;assert.equal(target(),null);});
await withIntent(s,{kind:'move',col:61,row:30},async()=>{s.live=false;assert.equal(target(),null);s.live=true;});
let release;const pending=withIntent(s,{kind:'exit',col:10,row:20},()=>new Promise(r=>release=r));
await withIntent(s,{kind:'move',col:61,row:30},async()=>assert.equal(target().kind,'move'));
assert.equal(target(),null,'new completed action does not resurrect older root');release();await pending;
class Stub{async walkFine(){assert.equal(intentObservation(this).target.col,61);return 7;}}
installIntentObservers(Stub.prototype);assert.equal(await Stub.prototype.walkFine.call(s,3936,1952),7,'fine center preserves named col/row');
// Shipped Session boundary, zero pacer/client sends. Hold its existing position
// confirmation await so the current target can be observed without moving.
const self={col:61,row:30};const real={...s,world:{geometry:{}},need:()=>({...c,self}),
 confirmPosition:()=>new Promise(r=>release=()=>r(self))};
const walk=Session.prototype.walkTo.call(real,61,30);
assert.deepEqual(intentObservation(real,100).target,{kind:'move',col:61,row:30});
release();assert.equal((await walk).arrived,true);assert.equal(intentObservation(real).target,null);
console.log('PASS intent scopes: native Session, zero added queries, nested targets, cancellation, room changes, moving/removed objects and non-resurrection');
