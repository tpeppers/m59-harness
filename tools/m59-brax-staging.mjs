import {appendFileSync,mkdirSync,readFileSync} from 'node:fs';
import {loadMap,roomExitSquares} from './m59-map.mjs';
import {roomGeometry} from './m59-ground.mjs';
import {applyAncientFloors} from './m59-moving-platform.mjs';
import {createRailObserver} from './m59-rail-observer.mjs';
import {currentCallOrigin} from './m59-fleetscript.mjs';
import {originLabel} from './m59-move-origin.mjs';
import {checkIslandCancellation} from './m59-island-observation.mjs';
import {chooseCrowdClearanceStep,chooseRailAdvanceStep,crowdDepartureReady} from './m59-rail-traffic.mjs';
import {foodValue} from './m59-items.mjs';
import {isActiveRecoveryDecision} from './m59-survival-decision.mjs';
const cohorts=new Map(),sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const chooseBraxCrowdStep=(geo,objects,controlledIds,options={})=>chooseCrowdClearanceStep(geo,objects,controlledIds,{eligible:p=>p.row>=30&&p.col>=25||p.row<=8&&p.col>=50,...options});
export {chooseRailAdvanceStep as chooseBraxRailStep} from './m59-rail-traffic.mjs';
const chooseBraxRailStep=chooseRailAdvanceStep;
// Keep each donor a meal; use only food already carried by selected fleetmates.
export function braxFoodShare(items,{reserve=80,wanted=100}={}){
 const food=items.filter(i=>foodValue(i.name)?.nutrition>0),total=food.reduce((n,i)=>n+foodValue(i.name).nutrition*(i.amount||1),0);
 let spare=Math.max(0,total-reserve),given=0;const share=[];
 for(const i of food.sort((a,b)=>foodValue(b.name).nutrition-foodValue(a.name).nutrition)){
  const nutrition=foodValue(i.name).nutrition,amount=Math.min(i.amount||1,Math.floor(spare/nutrition),Math.ceil((wanted-given)/nutrition));
  if(amount>0){share.push({id:i.id,name:i.name,amount});spare-=amount*nutrition;given+=amount*nutrition;}
  if(given>=wanted)break;
 }
 return share;
}
async function feedBraxGroup(contexts,read){
 for(const actor of contexts){
  let state=await read(actor);if(state.room.num===827||!(state.vigor?.value<80))continue;
  for(let bite=0;bite<12&&state.vigor.value<120;bite++){
   let pack=await actor.call('inventory',{agent:actor.agent});
   let meal=pack.items?.find(i=>foodValue(i.name)?.nutrition>0);
   if(!meal){
    for(const donor of contexts){
     if(donor===actor)continue;const other=await read(donor);
     if(other.room.num!==state.room.num||isActiveRecoveryDecision(other.autopilot_status?.survival_decisions?.current))continue;
     const stock=await donor.call('inventory',{agent:donor.agent}),share=braxFoodShare(stock.items??[]);
     if(!share.length)continue;
     const delivery=await donor.call('supply',{from:donor.agent,to:actor.agent,what:share,ids_as_of:stock.ids_as_of,who_travels:'neither'},60000);
     console.log('BRAX food share '+JSON.stringify({from:donor.agent,to:actor.agent,supplied:delivery.supplied,reason:delivery.reason}));
     if(delivery.supplied)break;
    }
    pack=await actor.call('inventory',{agent:actor.agent});meal=pack.items?.find(i=>foodValue(i.name)?.nutrition>0);
   }
   if(!meal)break;
   const before=state.vigor.value;await actor.call('act',{agent:actor.agent,verb:'eat',target:meal.id});await sleep(2500);state=await read(actor);
   if(!(state.vigor.value>before))break;
  }
  console.log('BRAX prepared vigor '+JSON.stringify({agent:actor.agent,vigor:state.vigor.value}));
 }
}
export async function prepareBraxGroup(ctx,members,{approachFile,includeDestination=false,scope='travel',observerOf=createRailObserver}={}){
 const origin=ctx.origin??currentCallOrigin(),key=ctx.fleet+':'+originLabel(origin)+':'+scope+':'+[...members].sort().join(',');
 let group=cohorts.get(key);
 if(!group){
  const ready=new Map(members.map(agent=>{let resolve,reject;const promise=new Promise((ok,fail)=>{resolve=ok;reject=fail;});promise.catch(()=>{});return[agent,{promise,resolve,reject,released:false}];}));
  group={contexts:new Map(),ready,start:Date.now()};cohorts.set(key,group);
 }
 ctx.state.islandCancelFence??=Date.now();group.contexts.set(ctx.agent,ctx);
 if(!group.promise)group.promise=(async()=>{
  const readyUntil=Date.now()+30000;
  while(group.contexts.size<members.length){if(Date.now()>readyUntil)throw Error('Brax staging cohort did not acquire all controllers');await sleep(100);}
  const contexts=[...group.contexts.values()],readers=new Map(contexts.map(c=>[c.agent,observerOf({fleet:c.fleet,agent:c.agent})]));
  const read=async c=>{const s=await readers.get(c.agent)();checkIslandCancellation(c,s);return s;};
  const release=c=>{const entry=group.ready.get(c.agent);if(!entry.released){entry.released=true;entry.resolve(true);console.log('BRAX departure-ready '+c.agent);}};
  await feedBraxGroup(contexts,read);
  const snapshots=await Promise.all(contexts.map(async c=>[c,await read(c)]));
  const rooms=[...new Set(snapshots.map(([,s])=>s.room.num))].filter(room=>includeDestination||room!==827);
  const liftAgents=snapshots.filter(([,s])=>![826,827,833].includes(s.room.num)).map(([c])=>c.agent);
  for(const c of contexts){c.state.braxExpectedLiftAgents=liftAgents;c.state.braxConvoyCharacters=snapshots.map(([,s])=>s.character);}
  // A crowd in one room must not hold clear travelers in another room.
  for(const [c,s]of snapshots){
   const local=snapshots.filter(([,other])=>other.room.num===s.room.num);
   const objects=new Map(s.objects.map(o=>[o.id,o]));objects.set(s.you.id,{...s.you,name:s.character,flags:5,is_player:true});
   const ready=new Set(crowdDepartureReady(objects,new Set(local.map(([,other])=>other.you.id))));
   if(!rooms.includes(s.room.num)||local.length===1||ready.has(s.you.id))release(c);
  }
  const file='substrate/brax-attempts/brax-staging-'+process.pid+'-'+Date.now()+'.jsonl';mkdirSync('substrate/brax-attempts',{recursive:true});
  const deadline=Date.now()+180000;let commands=0;
  for(const room of rooms){
   const local=snapshots.filter(([,s])=>s.room.num===room);if(local.length<2){for(const[c]of local)release(c);continue;}
   const byName=new Map(local.map(([c,s])=>[s.character,c])),exclude=new Set();
   const geo=roomGeometry(room);if(!geo?.collisionReady){for(const[c]of local)release(c);continue;}
   const avoidSquares=roomExitSquares(loadMap().rooms[room],{rows:geo.rows,cols:geo.cols,includeInland:true});
   const legs=room===579&&approachFile?JSON.parse(readFileSync(approachFile,'utf8')).stones[0].routes[0].legs:[];
   while(Date.now()<deadline&&commands<96){
    const pending=local.filter(([c])=>!group.ready.get(c.agent).released);if(!pending.length)break;
    const scene=await read(pending[0][0]);if(scene.room.num!==room)break;
    if(room===579&&scene.doors?.observed){
     if(scene.doors.settling_until>Date.now()){await sleep(250);continue;}
     applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(scene.doors.observed).map(([id,height])=>[+id,{height,type:4}])),null,{geometryOf:()=>geo});
    }
    const objects=new Map(scene.objects.map(o=>[o.id,o]));objects.set(scene.you.id,{...scene.you,name:scene.character,flags:5,is_player:true});
    const actorById=new Map([...objects.values()].filter(o=>(o.is_player||(o.flags&4))&&byName.has(o.name)&&!group.ready.get(byName.get(o.name).agent).released).map(o=>[o.id,byName.get(o.name)]));
    for(const id of crowdDepartureReady(objects,new Set(actorById.keys())))release(actorById.get(id));
    const selected=new Set([...actorById].filter(([,c])=>!group.ready.get(c.agent).released).map(([id])=>id)),options={exclude,avoidSquares};
    const chosen=room===579?(chooseBraxRailStep(geo,objects,selected,legs,{exclude})??chooseBraxCrowdStep(geo,objects,selected,options)):chooseCrowdClearanceStep(geo,objects,selected,options);if(!chosen)break;
    const actor=actorById.get(chosen.id),s=await read(actor),lease=s.autopilot_status?.faculties?.movement,own=actor.origin??currentCallOrigin();
    if(s.you.id!==chosen.id){exclude.add(chosen.id);continue;}
    if(lease?.owner!==own.source+':'+own.name||!(lease.expires_in_ms>0))throw Error('Brax staging movement lease changed');
    if(s.room.num!==room||s.hp?.value<=0||isActiveRecoveryDecision(s.autopilot_status?.survival_decisions?.current)){exclude.add(chosen.id);continue;}
    if(Math.hypot(s.you.x-chosen.from.x,s.you.y-chosen.from.y)>1)continue;
    const reply=await actor.call('walk_to',{agent:actor.agent,...chosen.target,fine:true,stride:8,max_steps:32,arrive_within:0,exact_arrival:true,hold_shelf:true,origin:own,
      avoid_squares:[...avoidSquares].map(k=>{const[row,col]=k.split(',').map(Number);return{row,col};})},45000);
    commands++;const actual=await read(actor);appendFileSync(file,JSON.stringify({at:Date.now(),room,agent:actor.agent,chosen,reply,actual:actual.you})+'\n');
    if(reply.cancelled&&reply.cancelled_by_origin?.source!=='keeper')throw Error('Brax staging cancelled');
    if(Math.hypot(actual.you.x-chosen.from.x,actual.you.y-chosen.from.y)<1)exclude.add(chosen.id);
   }
   // The native road owns further queueing; staging never drives a released actor.
   for(const[c]of local)release(c);
  }
  for(const c of contexts)release(c);
  console.log('BRAX staging completed '+commands+' ordinary crowd-clearing walks');
 })().catch(error=>{for(const entry of group.ready.values())if(!entry.released)entry.reject(error);}).finally(()=>cohorts.delete(key));
 return group.ready.get(ctx.agent).promise;
}
