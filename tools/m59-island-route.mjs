// #movement: separate directional cave trips, measured through ordinary keeper travel.
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {withTourWalkOwnership} from './m59-node-tour-policy.mjs';
import {walkHollowsOut,approachIslandDoor,approachMainlandCaveExit,eatIslandAtWall,checkIslandCancellation,readIslandFinePosition} from './m59-island-finewalk.mjs';
import {originLabel} from './m59-move-origin.mjs';
import {currentCallOrigin} from './m59-fleetscript.mjs';
export const CAVE=27,ISLAND=2000;
export const MAIN_CAVES=[27,2500,2501,2502,2503,2504,2505,2000];
export const pause=ms=>new Promise(r=>setTimeout(r,ms));
export const ISLAND_SAFE_LEGS={rooms:[599,...MAIN_CAVES.filter(r=>r!==ISLAND)]};
const islandWaves=new Map();
function waveFor(ctx,agents){
  const participants=Array.isArray(agents)?agents:String(agents).split(',').map(a=>a.trim()).filter(Boolean);
  if(!participants.includes(ctx.agent)||new Set(participants).size!==participants.length)throw Error('invalid_island_wave_roster');
  const key=ctx.fleet+'|'+originLabel(ctx.origin??currentCallOrigin());
  let wave=islandWaves.get(key);
  if(!wave){wave={participants:[...participants].sort(),done:new Map(),finished:new Set()};islandWaves.set(key,wave);}
  if(JSON.stringify(wave.participants)!==JSON.stringify([...participants].sort()))throw Error('island_wave_roster_changed');
  return {key,wave};
}
export function reportIslandOutbound(ctx,agents,ok){
  const {wave}=waveFor(ctx,agents);wave.done.set(ctx.agent,ok===true);
  if(wave.done.size===wave.participants.length)wave.readyAt??=Date.now();
}
export function releaseIslandWave(ctx,agents){
  const {key,wave}=waveFor(ctx,agents);
  wave.done.set(ctx.agent,ctx.state.islandOutboundComplete===true);wave.finished.add(ctx.agent);
  if(wave.done.size===wave.participants.length)wave.readyAt??=Date.now();
  if(wave.finished.size===wave.participants.length)islandWaves.delete(key);
}
export async function waitIslandOutbound(ctx,agents,{phase='return',room=ISLAND,budgetMs=1440000,pollMs=1000,spacingMs=0,read=()=>readIslandFinePosition(ctx)}={}){
  if(!['out','return'].includes(phase))throw Error('invalid_island_wave_phase');
  const {wave}=waveFor(ctx,agents),deadline=Date.now()+budgetMs;
  wave.startedAt??=Date.now();
  const first=await read();
  const validate=l=>{
    checkIslandCancellation(ctx,l);
    if(!Number.isFinite(l.hp?.value)||!Number.isFinite(l.hp?.max)||l.hp.max<=0)throw Error('wave_health_unreadable');
    if(l.hp.value<=0||l.room?.num===1)throw Error('traveller_died');
    if(l.hp.max<first.hp.max)throw Error('traveller_lost_max_health');
    if(l.room?.num!==room)throw Error('wave_wait_unexpected_room');
  };
  validate(first);
  while(phase==='return'&&wave.done.size<wave.participants.length){
    if(Date.now()>=deadline)throw Error('island_outbound_wave_budget');
    await pause(pollMs);validate(await read());
  }
  if(phase==='return')wave.readyAt??=Date.now();
  const departure=(phase==='return'?wave.readyAt:wave.startedAt)+wave.participants.indexOf(ctx.agent)*Math.max(0,spacingMs);
  while(Date.now()<departure){
    if(Date.now()>=deadline)throw Error('island_return_wave_budget');
    await pause(Math.min(pollMs,departure-Date.now()));validate(await read());
  }
  return {ok:true,outbound_complete:wave.participants.filter(a=>wave.done.get(a)),outbound_failed:wave.participants.filter(a=>!wave.done.get(a))};
}
export async function withIslandSafeLegs(ctx,fn){
  const {agent,call}=ctx,before=await call('autopilot',{agent,action:'status'});
  if(!before.policy||typeof before.policy!=='object')throw Error('traveller_policy_unreadable');
  const prior=before.policy.safeLegs??null;
  const installed={...(prior&&typeof prior==='object'?prior:{}),rooms:[...new Set([...(prior?.rooms??[599]),...ISLAND_SAFE_LEGS.rooms])]};
  await call('autopilot',{agent,action:'town_trip',op:'drop',hold_ms:0});
  await call('autopilot',{agent,action:'start',safe_legs:installed});
  try{
    const check=await call('autopilot',{agent,action:'status'});
    if(JSON.stringify(check.policy?.safeLegs)!==JSON.stringify(installed))throw Error('island_safe_legs_not_applied');
    return await fn();
  }finally{
    // Do not overwrite a policy changed by the operator while the trip ran.
    const current=await call('autopilot',{agent,action:'status'});
    if(JSON.stringify(current.policy?.safeLegs)===JSON.stringify(installed))
      await call('autopilot',{agent,action:'start',safe_legs:prior});
  }
}
export function location(l){const p=l.you??l.self??{};return {room:l.room?.num,row:p.row,col:p.col,x:p.x,y:p.y,units:'kod',hp:l.hp};}
export const foreignIslandDestination=(order,to)=>order?.to!=null&&Number.isFinite(Number(order.to))&&Number(order.to)!==to;
export async function prepareIslandDeparture(ctx,first,{minVigor=120}={}){
  if(!Number.isFinite(minVigor)||minVigor<12||minVigor>200)throw Error('invalid_island_departure_vigor');
  const health=l=>{
    if(!Number.isFinite(l.hp?.value)||!Number.isFinite(l.hp?.max)||l.hp.max<=0)throw Error('traveller_health_unreadable');
    if(l.room?.num===1||l.hp.value<=0)throw Error('traveller_died');
    if(l.hp.max<(ctx.fragileBelow??20))throw Error('traveller_below_max_health_floor');
    if(l.hp.max<first.hp.max)throw Error('traveller_lost_max_health');
  };
  health(first);let ready=first;
  if(first.room.num===ISLAND&&(first.vigor?.value<minVigor||first.hp.value<first.hp.max)){
    await ctx.call('rest_up',{agent:ctx.agent,to:1,max_seconds:90},110000);
    health(await ctx.call('look',{agent:ctx.agent}));
    await eatIslandAtWall(ctx,health);ready=await ctx.call('look',{agent:ctx.agent});health(ready);
  }
  if(!Number.isFinite(ready.vigor?.value)||ready.vigor.value<minVigor)throw Error('island_departure_requires_food_and_vigor_'+minVigor);
  return ready;
}
export async function ordinaryHop(ctx,to,options={}){
  return withTourWalkOwnership(ctx.agent,async()=>{
    try{return await hopOwned(ctx,to,options);}
    catch(e){await ctx.call('cancel_movement',{agent:ctx.agent}).catch(()=>{});throw e;}
  });
}
async function hopOwned(ctx,to,{budgetMs=180000,pollMs=1000,idleGraceMs=5000,onSample=()=>{}}={}){
  const {agent,call}=ctx,start=Date.now(),first=await call('look',{agent}),leg={to,start:location(first),samples:[],damage:0,lowest_hp:first.hp?.value};
  let previous=first.hp?.value;
  const sample=l=>{
    const p=location(l),hp=l.hp?.value;
    if(!Number.isFinite(hp)||!Number.isFinite(l.hp?.max)||l.hp.max<=0)throw Error('traveller_health_unreadable');
    if(Number.isFinite(hp)&&Number.isFinite(previous))leg.damage+=Math.max(0,previous-hp);
    if(Number.isFinite(hp))leg.lowest_hp=Math.min(leg.lowest_hp??hp,hp);
    previous=hp;leg.samples.push({ms:Date.now()-start,...p});onSample(leg);
    if(p.room===1||hp<=0)throw Error('traveller_died');
    if(first.hp?.max&&l.hp?.max<first.hp.max)throw Error('traveller_lost_max_health');
    return p;
  };
  sample(first);
  if(first.room?.num===to){leg.ok=true;leg.end=location(first);return leg;}
  if(first.hp.max<(ctx.fragileBelow??20))throw Error('traveller_below_max_health_floor');
  if(first.hp.value/first.hp.max<(ctx.minHealth??1))throw Error('traveller_below_departure_health_floor');
  if(first.room?.num===27&&to===2500)await approachMainlandCaveExit(ctx,{budgetMs,onSample:sample});
  if(first.room?.num===2502&&to===2503)await walkHollowsOut(ctx,{budgetMs,onSample:sample});
  if(first.room?.num===2505&&to===2000)await approachIslandDoor(ctx,{budgetMs,onSample:sample});
  // Both mainland exits are detours from this measured cave expedition.
  const request=async()=>{
    const by=originLabel(ctx.origin??currentCallOrigin());let reply;
    for(let attempt=0;attempt<6;attempt++){
      reply=await call('travel',{agent,to,background:true,max_hops:1,avoid:[5,587],run_errands:false},30000);
      // Room entry can precede the previous hop's job cleanup. Wait only for
      // this controller's own busy job; never replace another owner's order.
      if(!reply.error?.includes(' is busy:')||reply.ordered_by!==by||!reply.error.includes('(ordered by '+by+')'))return reply;
      leg.handoff_waits=(leg.handoff_waits??0)+1;
      const l=await call('look',{agent}),p=sample(l);
      checkIslandCancellation(ctx,await call('status',{agent,brief:true}));
      if(p.room===to)return {...reply,arrived:true};
      if(p.room!==first.room.num)throw Error('travel_handoff_unexpected_room');
      if(Date.now()-start>=budgetMs)break;
      await pause(pollMs);
    }
    return reply;
  };
  leg.request=await request();leg.retries=0;
  let attemptStarted=Date.now();
  for(;;){
    await pause(pollMs);const l=await call('look',{agent}),p=sample(l);
    if(p.room===to){leg.ok=true;leg.end=p;break;}
    if(p.room!==first.room.num){leg.reason='unexpected_room_'+p.room;leg.status=await call('status',{agent,brief:true});break;}
    const s=await call('status',{agent,brief:true});
    checkIslandCancellation(ctx,s);
    if(Date.now()-start>budgetMs){leg.reason='budget';break;}
    if(foreignIslandDestination(s.movement?.order,to)){leg.reason='preempted_by_other_destination';leg.status=s;break;}
    if(s.movement?.order?.kind==='shelter')continue;
    // A keeper-resumed journey can be running before the broker's busy snapshot
    // catches up. Its live movement order is the authority during that interval.
    const order=s.movement?.order;
    if(order?.kind==='travel'&&Number(order.to)===to&&leg.request?.ordered_by&&order.ordered_by===leg.request.ordered_by)continue;
    if(Date.now()-attemptStarted>idleGraceMs&&!s.busy){
      const auto=s.autopilot_status,wall=auto?.safe_spot,hold=auto?.suspended_journey;
      const ownRecovery=hold?.to===to&&hold.ordered_by===leg.request?.ordered_by;
      if(ownRecovery){
        const at=wall?.at;
        if(wall?.works&&at?.row===p.row&&at?.col===p.col){
          if((leg.recoveries??0)>=3){leg.reason='shelter_recovery_exhausted';leg.status=s;break;}
          // Recovery is made on the observed wall. A shelter order is part of
          // this journey, not a replacement destination or a completed failure.
          await call('rest_up',{agent,to:1,max_seconds:30},45000);
          leg.recoveries=(leg.recoveries??0)+1;
          let recovered=await call('look',{agent});sample(recovered);
          if(recovered.room?.num===to){leg.ok=true;break;}
          if(recovered.room?.num!==first.room.num)throw Error('recovery_unexpected_room');
          try{await eatIslandAtWall(ctx,sample);}
          catch(e){
            if(e.message!=='meal_unexpected_room')throw e;
            recovered=await call('look',{agent});sample(recovered);
            if(recovered.room?.num===to){leg.ok=true;break;}
            throw e;
          }
          const rested=await call('look',{agent});sample(rested);
          if(rested.room?.num===to){leg.ok=true;break;}
          if(rested.room?.num!==first.room.num)throw Error('recovery_unexpected_room');
          if(!Number.isFinite(rested.vigor?.value))throw Error('traveller_vigor_unreadable');
          if(rested.hp.value/rested.hp.max<(ctx.minHealth??1)||rested.vigor.value<40)continue;
          await call('rest',{agent,stand:true});
          leg.request=await request();attemptStarted=Date.now();continue;
        }
        // The keeper may still be approaching its refuge or reconnecting.
        continue;
      }
      // A crowded entrance can exhaust the mover's exit attempts. Re-read the
      // body and restart the same one-room order; never substitute a raw move.
      if(leg.retries<3&&/object_blocked|route_progressing_exits_exhausted|no route from/.test(s.failed??s.movement?.failed??'')){
        await call('cancel_movement',{agent});await pause(2000);
        leg.retries++;leg.request=await request();attemptStarted=Date.now();continue;
      }
      leg.reason='journey_ended_short';leg.status=s;break;
    }
  }
  if(!leg.ok)await call('cancel_movement',{agent}).catch(()=>{});
  leg.ms=Date.now()-start;leg.end=location(await call('look',{agent}));
  // A room-entry packet can arrive between the position and idle-status polls.
  if(leg.end.room===to){leg.ok=true;delete leg.reason;}
  return leg;
}
export async function walkIsland(ctx,{direction='out',budgetMs=180000,minVigor=120,evidenceDir='substrate/island-trials'}={}){
  if(!['out','back'].includes(direction))throw Error('direction must be out or back');
  const {agent,call,state}=ctx,chain=MAIN_CAVES;
  state.islandCancelFence??=Date.now();
  const route=direction==='back'?[...chain].reverse():[...chain];
  let first=await call('look',{agent});
  if(first.room?.num!==route[0])throw Error('route_start_requires_room_'+route[0]);
  await call('autopilot',{agent,action:'town_trip',op:'drop',hold_ms:0});
  first=await prepareIslandDeparture(ctx,first,{minVigor});
  const initial=location(first);
  if(initial.room!==route[0])throw Error('route_start_requires_room_'+route[0]);
  const out=resolve(evidenceDir);mkdirSync(out,{recursive:true});
  const file=resolve(out,agent+'-'+direction+'-'+Date.now()+'.json');
  const record={format:'m59-island-walk/1',at:new Date().toISOString(),agent,direction,route,start:initial,setup:state.islandSetup??null,legs:[],complete:false};
  state.islandTrial=record;state.islandTrialFile=file;
  const save=()=>writeFileSync(file,JSON.stringify(record,null,2));
  save();
  try{
    return await withIslandSafeLegs(ctx,async()=>{
    for(const to of route.slice(1)){
      const leg=await ordinaryHop(ctx,to,{budgetMs,onSample:live=>{record.current=live;save();}});
      record.legs.push(leg);delete record.current;save();
      console.log('ISLAND HOP '+JSON.stringify({agent,to,ok:leg.ok,ms:leg.ms,damage:leg.damage,end:leg.end,reason:leg.reason}));
      if(!leg.ok)return {ok:false,why:'hop_failed_'+to,evidence:file};
    }
    record.end=location(await call('look',{agent}));record.complete=record.end.room===route.at(-1);save();
    return {ok:record.complete,evidence:file};
    });
  }catch(e){record.failure=e.message;record.failure_detail=state.islandFineFailure;save();throw e;}
}
