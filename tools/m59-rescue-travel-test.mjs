import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {executeRescuePlan,verifiedRescueContext,tryRescueTravel} from './m59-rescue-travel.mjs';
const dir=mkdtempSync(join(tmpdir(),'rescue-chain-'));
assert.equal(await tryRescueTravel({},714,{arriveNear:{row:1,col:1}}),null);
assert.equal(await tryRescueTravel({},714,{handOffAt:()=>true}),null);
assert.equal(await tryRescueTravel({combat:{active:true}},714),null);
function fake({cancel=false,wrong=false,remaining=3}={}){
 let cancelled=false;
 const s={name:'test',credentials:{character:'Test'},live:true,uses:0,world:{room:{num:39}},movementWasCancelled:()=>cancelled,need:()=>c,pacer:{submit:async(k,f)=>f()},travel:async(to)=>{s.world.room={num:to};return {arrived:true};}};
 const c=s.client={selfId:1,evSeq:0,events:[],inventory:[{id:11,name:'chalice of the rain'}],spells:[],rsc:new Map(),stand(){},look(){},vitals:()=>({health:{value:100,max:100}}),
 waitFor:async()=>({events:[{id:11,description:remaining===3?'filled to the brim':remaining===2?'mostly full':'almost empty'}]}),
 use(){s.uses++;remaining--;s.world.room={num:wrong?106:s.world.room.num===39?714:202};c.events.push({seq:++c.evSeq,kind:'message',text:'You feel a holy force rescue you'});if(cancel)cancelled=true;}};
 c.apply=(id,target)=>{assert.equal(target,1);c.use(id);};
 return s;
}
const best={legs:[{kind:'chalice',from:39,to:714},{kind:'chalice',from:714,to:202}],p90_ms:45000,basis:'test'};
async function run(s,name){return executeRescuePlan(s,202,best,{policy:{},file:join(dir,name+'.json'),contextFor:async()=>({guildHall:714,homeRoom:202})});}
let s=fake();s.client.guild={name:'Test guild'};s.client.requestGuildInfo=()=>{};
assert.equal(await verifiedRescueContext(s,{guildName:'Test guild',guildHall:714}),null);
s=fake();assert.equal((await run(s,'success')).arrived,true);assert.equal(s.uses,2);assert.equal(JSON.parse(readFileSync(join(dir,'success.json'))).pending,false);
s=fake({remaining:2});assert.equal((await run(s,'not-full')).arrived,false);assert.equal(s.uses,0);
s=fake({wrong:true});assert.equal((await run(s,'wrong')).arrived,false);assert.equal(s.uses,1);assert.equal(JSON.parse(readFileSync(join(dir,'wrong.json'))).pending,true);
s=fake({cancel:true});assert.equal((await run(s,'cancel')).cancelled,true);assert.equal(s.uses,1);
s=fake();s.lastPlayerAttackAt=Date.now();assert.equal((await run(s,'pvp')).arrived,false);assert.equal(s.uses,0);
s=fake();let mana=32;s.client.inventory=[{id:12,name:'emerald',amount:2}];s.client.spells=[{id:7,name:'rescue'}];s.client.stat=()=>({value:50});s.client.vitals=()=>({health:{value:100,max:100},mana:{value:mana}});s.client.cast=()=>{mana-=16;s.client.inventory[0].amount--;s.client.use();};
const spells={...best,legs:best.legs.map(l=>({...l,kind:'spell'}))};
assert.equal((await executeRescuePlan(s,202,spells,{policy:{},file:join(dir,'spells.json'),contextFor:async()=>({guildHall:714,homeRoom:202})})).arrived,true);assert.equal(s.uses,2);assert.equal(mana,0);
s=fake();s.travel=async(to,opts)=>{assert.equal(opts.origin.name,'rapid-arrival');assert.equal(opts.allowRescue,false);s.world.room.num=to;return {arrived:true,hops:1};};
assert.equal((await executeRescuePlan(s,714,{legs:[{kind:'walk',from:39,to:714,hops:[1]}]},{policy:{},opts:{origin:{source:'fleetscript',name:'rapid-arrival'}},file:join(dir,'origin.json')})).arrived,true);
console.log('Rescue executor: two confirmed landings, retained cup, full-chain resource gate, wrong landing, cancellation, durable uncertainty and PvP lockout passed.');

