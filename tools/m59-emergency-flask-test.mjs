import assert from 'node:assert/strict';
import {Autopilot} from './m59-autopilot.mjs';
const blue='This flask, formed from clear glass and topped by a cork, contains a thick blue fluid. It looks cool and refreshing.';
function fixture(description=blue){
 let hp=8,applications=0,reads=0;
 const c={state:'game',selfId:7,self:{row:26,col:24},evSeq:0,
  room:{objects:new Map([[8,{id:8,flags:8,row:26,col:25}]])},
  inventory:[{id:44,nameRsc:9}],spells:[],rsc:{get:()=> 'flask'},
  vitals:()=>({health:{value:hp,max:20}}),
  requestInventory(){reads++;},look(){this.evSeq++;},
  apply(){applications++;hp+=8;this.inventory=[];},
  waitFor:async ({kinds})=>({events:kinds.includes('look')?[{id:44,seq:c.evSeq,description}]:[]})};
 const s={client:c,live:true,world:{room:{num:2504}},need:()=>c,pacer:{submit:async(_kind,fn)=>fn()}};
 const a=Object.assign(Object.create(Autopilot.prototype),{s,tally:{},facultyHeld:()=>false,safety:()=>({fleeAt:0.7}),holdWorks:()=>false,sanctuary:()=>false,recordHealUse(){},progress(){}});
 return {a,c,count:()=>({applications,reads,hp})};
}
const good=fixture();
assert.equal(good.a.emergencyFlaskTick({value:8,max:20}),true);
assert.equal(good.a.emergencyFlaskTick({value:8,max:20}),false,'only one emergency read/apply may be in flight');
await good.a.emergencyFlaskTask;
assert.equal(good.count().applications,1);assert.equal(good.count().hp,16);assert.equal(good.a.tally.heals,1);
for(const kind of ['healthy','dead','wall','sanctuary','foreign_recovery','pvp','player_only','no_flask']){
 const {a,c,count}=fixture();let hp={value:8,max:20};
 if(kind==='healthy')hp.value=20;
 if(kind==='dead')hp.value=0;
 if(kind==='wall')a.holdWorks=()=>true;
 if(kind==='sanctuary')a.sanctuary=()=>true;
 if(kind==='foreign_recovery')a.facultyHeld=k=>k==='recovery';
 if(kind==='pvp')a.s.combat={active:true};
 if(kind==='player_only')c.room.objects.get(8).flags=12;
 if(kind==='no_flask')c.inventory=[];
 assert.equal(a.emergencyFlaskTick(hp),false,kind);assert.equal(count().reads,0,kind);
}
const bad=fixture('The pungent liquid in this bottle contains floating bits of strange matter.');
assert(bad.a.emergencyFlaskTick({value:8,max:20}));await bad.a.emergencyFlaskTask;
assert.equal(bad.count().applications,0,'arsenic never becomes emergency medicine');
console.log('Emergency flask uses one verified item without moving, coalesces requests, honors protected ownership and refuses arsenic.');
