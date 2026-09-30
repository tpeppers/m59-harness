// Offline protocol fakes exercise resource protection, interruption and formations.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chargePossibilities,expendable,predictedRescueRoom,chooseRescueRoute,
  rescueCapability,performRescue,rechargeChalice,rechargeRoom,travelRescueOption} from './m59-rescue.mjs';
import {rescueDefenseDecision} from './m59-rescue-defense.mjs';
let passed=0;
async function test(name,fn){await fn();passed++;console.log('ok '+name);}
function fake({remaining=3,capacity=3,complete=true,room=39,learned=false,emerald=true,mana=50}={}){
  const s={live:true,world:{room:{num:room}},combat:{active:false},uses:0,gets:0,drops:0,
    pacer:{submit:async(_kind,fn)=>fn()}};
  const item={id:11,name:'Chalice of the Rain'};
  const c=s.client={evSeq:0,events:[],selfId:1,self:{row:20,col:20},room:{objects:new Map()},
    rsc:new Map([[7,'rescue']]),spells:learned?[{id:7,nameRsc:7}]:[],
    inventory:[item,...(emerald?[{id:12,name:'emerald'}]:[])],
    vitals:()=>({mana:{value:mana}}),look:()=>{},stand:()=>{},requestInventory:()=>{},
    waitFor:async({kinds}={})=>({events:kinds?.includes('look')?[{id:11,description:description()}]:[]}),
    use:()=>{s.uses++;remaining--;if(complete)land();},cast:()=>{s.uses++;if(complete)land();},
    drop:()=>{s.drops++;c.inventory=c.inventory.filter(i=>i.id!==11);remaining=capacity;},
    get:()=>{s.gets++;if(!c.inventory.some(i=>i.id===11))c.inventory.push(item);},
  };
  function description(){const pct=Math.floor(100*remaining/capacity);return pct>90?'filled to the brim':pct>65?'mostly full':pct>30?'a few sips':'almost empty';}
  function land(){s.world.room.num=714;c.events.push({seq:++c.evSeq,kind:'message',text:'You feel a holy force rescue you from your current situation.'});}
  s.need=()=>c;s.remaining=()=>remaining;return s;
}
await test('every possible last charge is protected, including ambiguous few sips',()=>{
  for(let cap=3;cap<=5;cap++)for(let n=1;n<=cap;n++){
    const pct=Math.floor(n*100/cap),label=pct>90?'filled to the brim':pct>65?'mostly full':pct>30?'a few sips':'almost empty';
    const p=chargePossibilities(label);
    assert(p.some(x=>x.capacity===cap&&x.remaining===n));
    if(n===1)assert.equal(expendable(p),false);
  }
  assert.equal(expendable(chargePossibilities('unknown')),false);
});
await test('guild/region/home precedence matches native Rescue',()=>{
  assert.equal(predictedRescueRoom(39,{guildHall:714,homeRoom:11}),714);
  assert.equal(predictedRescueRoom(714,{guildHall:714,homeRoom:11}),11);
  assert.equal(predictedRescueRoom(2002,{guildHall:714,homeRoom:11}),2001);
  assert.equal(predictedRescueRoom(2501,{guildHall:714}),2510);
  assert.equal(predictedRescueRoom(2510,{guildHall:714}),2001);
  assert.equal(predictedRescueRoom(43,{guildHall:714}),null);
});
await test('route shortcuts respect cost, landing bans and confinement',()=>{
  const args={from:39,to:714,landing:714,capability:{available:true,delay_max_ms:25000},walking:{found:true,hops:[1,2,3]}};
  assert.equal(chooseRescueRoute(args).kind,'rescue');
  assert.equal(chooseRescueRoute({...args,walking:{found:true,hops:[1]}}),null);
  assert.equal(chooseRescueRoute({...args,blocked:[714]}),null);
  assert.equal(chooseRescueRoute({...args,confine:[39]}),null);
  assert.equal(chooseRescueRoute({...args,to:11,tail:{found:false}}),null);
});
await test('real item flow spends once and verifies the destination',async()=>{
  const s=fake({remaining:2});
  const cap=await rescueCapability(s);
  assert.equal((await performRescue(s,cap,{destination:714})).arrived,true);
  assert.equal(s.remaining(),1);
  assert.equal((await performRescue(s,cap)).refused,true);
  assert.equal(s.uses,1);
  await rescueCapability(s);assert.equal(s.chaliceErrand.state,'pending');
});
await test('pending/uncertain Rescue cannot consume a second charge',async()=>{
  const s=fake({complete:false}),cap=await rescueCapability(s);
  assert.equal((await performRescue(s,cap,{timeoutMs:5})).pending,true);
  assert.equal((await performRescue(s,cap)).refused,true);
  assert.equal((await rescueCapability(s)).available,false);assert.equal(s.uses,1);
});
await test('an externally pending Rescue pauses without starting a walking fallback',async()=>{
  const s=fake(),cap=await rescueCapability(s);
  s.client.use=()=>{s.uses++;s.client.events.push({seq:++s.client.evSeq,kind:'message',text:'You are already being rescued.'});};
  assert.equal((await performRescue(s,cap)).pending,true);
  assert.equal((await performRescue(s,cap)).refused,true);assert.equal(s.uses,1);
});
await test('preemption before send consumes nothing',async()=>{
  const s=fake(),cap=await rescueCapability(s);
  assert.equal((await performRescue(s,cap,{stopped:()=>true})).cancelled,true);
  assert.equal(s.uses,0);
});
await test('unexpected native landing is reported without pretending to arrive',async()=>{
  const s=fake(),cap=await rescueCapability(s);
  const result=await performRescue(s,cap,{destination:11});
  assert.equal(result.arrived,false);assert.equal(result.landed_in,714);
});
await test('spell requires a learned Rescue, emerald and mana; low karma is rejected',async()=>{
  for(const options of [{learned:false},{learned:true,emerald:false},{learned:true,mana:15}]){
    const s=fake(options);s.client.inventory=s.client.inventory.filter(i=>i.id!==11);
    assert.equal((await rescueCapability(s)).available,false);
  }
  const s=fake({learned:true});s.client.inventory=s.client.inventory.filter(i=>i.id!==11);
  assert.equal((await rescueCapability(s)).kind,'spell');
  s.client.stat=()=>({value:0});assert.equal((await rescueCapability(s)).available,false);
});
await test('forest refills use drop/get, confirm inventory and clear the errand',async()=>{
  const s=fake({remaining:1,room:587});await rescueCapability(s);
  assert.equal((await rechargeChalice(s)).ok,true);
  assert.equal(s.drops,1);assert.equal(s.gets,1);assert.equal(s.remaining(),3);assert.equal(s.chaliceErrand,null);
});
await test('unknown rooms never risk dropping the chalice',async()=>{
  const s=fake({remaining:1,room:39});
  assert.equal((await rechargeChalice(s)).ok,false);assert.equal(s.drops,0);
  assert(rechargeRoom(587));
  const catalog=JSON.parse(readFileSync(new URL('../substrate/m59-rescue-terrain.json',import.meta.url)));
  assert(Object.values(catalog.rooms).every(r=>r.shalille_bonus>20&&r.cls.toLowerCase()!=='ka0'));
});
await test('a room packet without the player body cannot trigger a refill drop',async()=>{
  const s=fake({remaining:1,room:587});delete s.client.self;
  assert.equal((await rechargeChalice(s)).ok,false);assert.equal(s.drops,0);
});
await test('failed pickup holds travel and retains an exact recovery receipt',async()=>{
  const s=fake({remaining:1,room:587});s.client.get=()=>{s.gets++;};
  assert.equal((await rechargeChalice(s)).dropped,true);
  assert.equal(s.chaliceErrand.item_id,11);assert.equal(s.chaliceErrand.state,'pickup_unconfirmed');
  assert.equal((await travelRescueOption(s,714)).kind,'blocked');assert.equal(s.gets,2);
});
await test('deadline releases Rescue and a shield-reset quorum shrinks before capture',()=>{
  const actor=(key,stage=false)=>({key,alive:true,foyer:true,staged:stage});
  assert.equal(rescueDefenseDecision([]).cast,false);
  assert.equal(rescueDefenseDecision([actor('t6')]).cast,false);
  assert.equal(rescueDefenseDecision([],{elapsedMs:480000}).cast,true);
  assert.equal(rescueDefenseDecision([actor('t6'),actor('t5')]).assemble,true);
  const group=['t6','t9','t5','t16'].map(k=>actor(k,true));
  assert.equal(rescueDefenseDecision(group).assemble,true);
  assert.equal(rescueDefenseDecision(group).breach,false);
  assert.equal(rescueDefenseDecision(group,{elapsedMs:480000}).breach,true);
  group.push({...actor('t3'),foyer:false});
  assert.equal(rescueDefenseDecision(group,{elapsedMs:480000}).breach,false,'wait for the living Rescue partner');
  group.pop();
  group[0].alive=false;assert.equal(rescueDefenseDecision(group,{elapsedMs:480000}).breach,false);
  assert.equal(rescueDefenseDecision(group,{elapsedMs:555000}).breach,true);
  assert.equal(rescueDefenseDecision([actor('t16',true)],{elapsedMs:570000}).breach,true);
  assert.equal(rescueDefenseDecision([],{elapsedMs:570000}).breach,false);
});
console.log(passed+' Rescue checks passed');
