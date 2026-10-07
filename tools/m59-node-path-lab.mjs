#!/usr/bin/env node
// Held, movement-only native lab trial. Explicit config and authored scene required.
// node tools/m59-node-path-lab.mjs --config FILE --scene FILE --to r25c20 --via r24c10 --door --return r46c25 --out DIR
// No production fleet, attacks or activation. Candidate falls require explicit opt-in and model proof; local ownership is enforced.
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createShadowReplayAdapter} from './m59-shadow-replay.mjs';
import {fineRouter,proveCandidateFall} from './m59-fineroute.mjs';
import {previewOpenedDoor} from './m59-ceiling-doors.mjs';
import {doorsFor} from './m59-doorplan.mjs';
import {protocolToClient} from './m59-finepos.mjs';
import {quantizeRailPoint,landingCheck} from './m59-railfollow.mjs';
import {parseNodeSquare,auditNodeWalk} from './m59-node-route-audit.mjs';
const args=process.argv.slice(2),has=n=>args.includes('--'+n),flag=n=>args[args.indexOf('--'+n)+1];
if(has('help')){console.log('Explicit --config FILE --scene FILE --to rNcM --out DIR; optional --via rNcM --door --return rNcM --horizon-ms N --quiet --candidate-jumps 1..3');process.exit(0);}
for(const n of ['config','scene','to','out'])if(!has(n))throw Error('--'+n+' required');
const scene=JSON.parse(readFileSync(flag('scene'),'utf8')),goal=parseNodeSquare(flag('to')),
  via=has('via')?parseNodeSquare(flag('via')):null,back=has('return')?parseNodeSquare(flag('return')):null;
if(has('door')&&!via)throw Error('--door requires --via at the normal door trigger');
const horizonMs=Number(has('horizon-ms')?flag('horizon-ms'):600000);
if(!Number.isSafeInteger(horizonMs)||horizonMs<1||horizonMs>1800000)throw Error('horizon-ms must be 1..1800000');
const candidateJumps=Number(has('candidate-jumps')?flag('candidate-jumps'):0);
if(!Number.isInteger(candidateJumps)||candidateJumps<0||candidateJumps>3)throw Error('candidate-jumps must be 0..3');
const out=resolve(flag('out'));mkdirSync(out,{recursive:true});
const receipt={format:'m59-node-path-lab/1',at:new Date().toISOString(),goal,via,return_to:back,quiet:has('quiet'),candidate_jumps:candidateJumps,scope:'Authored start to target; a partial high-start trial does not prove entrance access or acquisition.',legs:[],poses:[],finished:false};
let adapter,timer,result,active,aborted=false;
try{
  adapter=await createShadowReplayAdapter({configFile:resolve(flag('config')),isolate:false,terminateAfterTrial:true,engineRoot:resolve(fileURLToPath(new URL('..',import.meta.url)))});
  result=await adapter.run({scene,frame:{at:Date.now(),scene},horizonMs,
    variant:{id:'node-path',kind:'baseline',reload:{labScenery:true,exactMonsterPlacement:true,noMonsters:has('quiet')}},
    onPrepared:async(s,k)=>{k.startWatchdog=()=>{};k.loop=()=>new Promise(()=>{});},
    onStarted:async(s)=>{
      const room=Number(s.world.room.num),began=Date.now(),generation=s.movementGeneration;
      const sample=()=>{const p=s.client.self,c=p?protocolToClient(p):null,g=s.world.geometry;
        receipt.poses.push({ms:Date.now()-began,room:s.world.room.num,row:p?.row,col:p?.col,x:p?.x,y:p?.y,
          hp:s.client.vitals()?.health?.value,floor_client:c?g.floorBaseAtClient(c.x,c.y,g.leafAtClient(c.x,c.y)):null});};
      sample();timer=setInterval(sample,500);
      const walk=async(target,label,prepared=null)=>{
        if(aborted||s.movementWasCancelled(generation))return {arrived:false,reason:'trial_cancelled'};
        if(!await s.confirmPosition())return {arrived:false,reason:'position_not_confirmed'};
        if(Number(s.world.room.num)!==room)return {arrived:false,reason:'room_changed'};
        const start=protocolToClient(s.client.self),g=s.world.geometry;
        const plan=prepared?.plan??fineRouter(room,{geometry:g,worldMap:s.world.map,exactWalk:true}).plan({...s.client.self,...start},target,{maxJumps:candidateJumps,allowCandidates:candidateJumps>0,branch:24});
        const audit=auditNodeWalk(plan,g),leg={label,target,plan,audit,observed_sector_heights:[...(s.client.room.sectorHeights??[])],prepared:prepared?{state:prepared.state,at:prepared.at}:null,at:Date.now(),attempts:[]};receipt.legs.push(leg);
        const first=plan.legs?.[0]?.waypoints?.[0];
        if(prepared&&first&&Math.hypot(first.x-start.x,first.y-start.y)>48)return {arrived:false,reason:'prepared_route_origin_changed'};
        console.log(JSON.stringify({label,planned:plan.ok,waypoints:plan.legs?.[0]?.waypoints.length,audit_failures:audit.failures.length}));
        if(!audit.ok)return {arrived:false,reason:'route_not_proved',audit};
        for(const [routeIndex,routeLeg] of plan.legs.entries()){
          if(routeLeg.kind==='jump'){
            if(!candidateJumps||routeLeg.declared)return {arrived:false,reason:'trial_requires_explicit_candidate_fall'};
            if(aborted||s.movementWasCancelled(generation))return {arrived:false,reason:'trial_cancelled'};
            const settling=s.collisionVertical?{...s.collisionVertical}:null;
            const waitMs=settling?Math.max(0,Math.min(5000,settling.settleAt-Date.now())):0;
            if(waitMs)await new Promise(r=>setTimeout(r,waitMs+20));
            if(aborted||s.movementWasCancelled(generation))return {arrived:false,reason:'trial_cancelled'};
            if(!await s.confirmPosition()||Number(s.world.room.num)!==room)return {arrived:false,reason:'jump_origin_not_confirmed'};
            const origin=protocolToClient(s.client.self),proof=proveCandidateFall(g,routeLeg);
            if(!proof.model_proved||Math.hypot(origin.x-routeLeg.fromFine.x,origin.y-routeLeg.fromFine.y)>48)return {arrived:false,reason:'jump_origin_or_model_not_proved',proof,origin};
            // Recheck from the server's exact body, then use the existing paced fall verb.
            const liveProof=proveCandidateFall(g,{fromFine:origin,toFine:proof.to_wire.client});
            if(!liveProof.model_proved)return {arrived:false,reason:'live_origin_fall_not_proved',liveProof};
            const before={...s.client.self},aim=liveProof.to_wire.protocol;
            const reply=await s.step(routeLeg.to.col,routeLeg.to.row,{fall:true,timedFall:true,aimX:aim.x,aimY:aim.y});
            // A predicted destination is not a landing. Allow vertical settling, then read it.
            await new Promise(r=>setTimeout(r,5500));
            const confirmed=await s.confirmPosition(),actual=protocolToClient(s.client.self),floor=g.floorBaseAtClient(actual.x,actual.y,g.leafAtClient(actual.x,actual.y));
            const landing=landingCheck(actual,liveProof.to_wire.client,{floor,wantedFloor:liveProof.to_wire.floor});
            leg.attempts.push({at:Date.now(),kind:'candidate_fall',routeIndex,settling,wait_ms:waitMs,before,proof,liveProof,reply,confirmed:!!confirmed,landing,after:{...s.client.self}});
            console.log(JSON.stringify({label,routeIndex,fall_sent:reply.moved,landing}));
            if(aborted||s.movementWasCancelled(generation)||!reply.moved||!confirmed||Number(s.world.room.num)!==room||!landing.ok)return {arrived:false,reason:'candidate_landing_not_confirmed',landing};
            continue;
          }
          for(const [index,p] of routeLeg.waypoints.entries()){
            if(aborted||s.movementWasCancelled(generation))return {arrived:false,reason:'trial_cancelled',index};
            if(Number(s.world.room.num)!==room)return {arrived:false,reason:'room_changed',index};
            const wire=quantizeRailPoint(p,{floorAt:(x,y)=>g.floorBaseAtClient(x,y,g.leafAtClient(x,y)),edge:(a,b)=>g.traceFineMoveClient(a.x,a.y,b.x,b.y)?.arrived===true});
            if(!wire.ok)return {arrived:false,reason:wire.reason,index};
            const before={...s.client.self},reply=await s.walkFine(wire.protocol.x,wire.protocol.y,{maxSteps:10,stride:32,arriveWithin:3,exactArrival:true,holdShelf:true,movementGeneration:generation});
            leg.attempts.push({at:Date.now(),routeIndex,index,before,target_client:p,target_protocol:wire.protocol,reply,after:{...s.client.self}});
            if(index%24===0)console.log(JSON.stringify({label,index,position:{row:s.client.self.row,col:s.client.self.col}}));
            if(!reply.arrived)return {...reply,failed_waypoint:index};
          }
        }
        if(!await s.confirmPosition())return {arrived:false,reason:'endpoint_not_confirmed'};
        const position={...s.client.self};return {arrived:Number(s.world.room.num)===room&&position.row===target.row&&position.col===target.col,position};
      };
      const openFor=async(target,field)=>{
        const on=doorsFor(room,{row:s.client.self.row,col:s.client.self.col}).on;
        if(on.length!==1)return {ok:false,reason:'ambiguous_door_trigger'};
        const preview=previewOpenedDoor(s.world.map,room,on[0].sector,{observed:s.client.room.sectorHeights});
        if(!preview)return {ok:false,reason:'door_preview_unavailable'};
        const start=protocolToClient(s.client.self),plan=fineRouter(room,{geometry:preview.geometry,worldMap:s.world.map,exactWalk:true}).plan({...s.client.self,...start},target,{maxJumps:0});
        const audit=auditNodeWalk(plan,preview.geometry),prepared={plan,audit,state:preview.state,at:Date.now()};
        receipt[field+'_prepared']=prepared;
        if(!audit.ok)return {ok:false,reason:'conditional_door_route_not_proved'};
        receipt[field]={...(await s.openOperableDoor({movementGeneration:generation,isInterrupted:()=>aborted})),observed_at:Date.now()};
        console.log(JSON.stringify({[field]:receipt[field]}));
        return receipt[field].opened?{ok:true,prepared}:{ok:false,reason:'door_did_not_open'};
      };
      active=(async()=>{
        if(via){const r=await walk(via,'door-approach');receipt.staging=r;if(!r.arrived)return r;}
        let prepared=null;
        if(has('door')){const opened=await openFor(goal,'door');if(!opened.ok)return {arrived:false,reason:opened.reason};prepared=opened.prepared;}
        receipt.approach=await walk(goal,'node-approach',prepared);if(!receipt.approach.arrived)return receipt.approach;
        if(back){
          prepared=null;
          if(has('door')){
            // A timed door can close behind us. Find its normally reachable inside trigger.
            const doors=doorsFor(room,{row:s.client.self.row,col:s.client.self.col}),
              door=[...doors.on,...doors.others].find(d=>d.sector===receipt.door.sector);
            const start=protocolToClient(s.client.self),R=fineRouter(room,{geometry:s.world.geometry,worldMap:s.world.map,exactWalk:true});
            let trigger=null;
            for(const sq of door?.stand_on??[])if(R.plan({...s.client.self,...start},sq,{maxJumps:0}).ok){trigger=sq;break;}
            if(!trigger)return {arrived:false,reason:'no_reachable_return_trigger'};
            const r=await walk(trigger,'return-door');receipt.return_staging=r;if(!r.arrived)return r;
            const opened=await openFor(back,'return_door');if(!opened.ok)return {arrived:false,reason:opened.reason};prepared=opened.prepared;
          }
          receipt.return=await walk(back,'return',prepared);if(!receipt.return.arrived)return receipt.return;
        }
        return {arrived:true,approach_verified:true,return_verified:back?true:null};
      })().then(r=>{receipt.result=r;receipt.elapsed_ms=Date.now()-began;sample();receipt.finished=true;},e=>{receipt.error=e.stack;receipt.finished=true;});
    },onStopping:()=>{aborted=true;clearInterval(timer);},shouldStop:()=>receipt.finished});
}catch(e){result={outcome:'error',error:e.stack};}
finally{
  aborted=true;clearInterval(timer);
  try{if(adapter){await adapter.reset();receipt.baseline_restored=true;}}catch(e){receipt.cleanup_error=e.message;}
  try{await adapter?.close();}catch(e){receipt.close_error=e.message;}
}
receipt.trial=result;if(!receipt.finished)receipt.result={arrived:false,reason:result?.outcome==='died'?'died':'trial_ended_before_completion'};
const file=join(out,'node-path-'+Date.now()+'.json');writeFileSync(file,JSON.stringify(receipt,null,2));
console.log(JSON.stringify({file,outcome:result?.outcome,result:receipt.result,elapsed_ms:receipt.elapsed_ms},null,2));process.exitCode=receipt.result?.arrived&&!receipt.cleanup_error&&!receipt.close_error?0:2;
