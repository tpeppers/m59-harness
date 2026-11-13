#!/usr/bin/env node
// Explicit owned native quiet lab validation of an authored typed route.
// Imports and pure validation never log in. Runtime requires config/scene/plan/out.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { protocolToClient } from './m59-finepos.mjs';
import { quantizeRailPoint, landingCheck } from './m59-railfollow.mjs';
import { proveCandidateFall } from './m59-fineroute.mjs';
import { navMeshExecutionAims, proveNavMeshWalk, proveNavMeshJump } from './m59-navmesh.mjs';

const gap=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),finite=p=>Number.isFinite(p?.x)&&Number.isFinite(p?.y);
const wirePoint=p=>finite(p)&&Number.isInteger(p.x)&&Number.isInteger(p.y)&&p.x%16===0&&p.y%16===0;
const copy=p=>({x:p.x,y:p.y});
const goalOk=g=>g&&(['square','range'].includes(g.kind)?Number.isInteger(g.row)&&Number.isInteger(g.col)&&g.row>0&&g.col>0
  &&(g.kind!=='range'||Number.isInteger(g.within)&&g.within>=0):g.kind==='point'&&wirePoint(g));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function selectTypedNavMeshLabPlan(input,{onlyLeg=null,includeReturn=true}={}) {
  const raw=input?.typedCandidatePlan??input;
  if(!['m59-typed-candidate-plan/1','m59-navmesh-lab-plan/1'].includes(raw?.format))throw Error('unsupported_typed_lab_plan');
  if(!Number.isInteger(raw.room)||raw.room<1||!wirePoint(raw.from)||!Array.isArray(raw.legs)||!raw.legs.length)throw Error('invalid_typed_lab_plan');
  const legs=structuredClone(raw.legs);
  const validateLegs=(list,start)=>{
    let at=start;
    for(const [i,leg]of list.entries()){
      if(!['walk','jump'].includes(leg?.kind)||!wirePoint(leg.from)||!wirePoint(leg.to)||gap(at,leg.from)>.05)throw Error('invalid_or_disconnected_lab_leg_'+i);
      if(leg.kind==='walk'){
        if(!Array.isArray(leg.waypoints)||!leg.waypoints.length||!leg.waypoints.every(wirePoint)
          ||gap(leg.waypoints[0],leg.from)>.05||gap(leg.waypoints.at(-1),leg.to)>.05)throw Error('invalid_lab_walk_proof_'+i);
      }else if(!wirePoint(leg.fromFine??leg.from)||!wirePoint(leg.toFine??leg.to)
        ||gap(leg.fromFine??leg.from,leg.from)>.05||gap(leg.toFine??leg.to,leg.to)>.05)throw Error('invalid_lab_fall_endpoints_'+i);
      at=leg.to;
    }return at;
  };
  const end=validateLegs(legs,raw.from),goal=raw.goal??{kind:'point',...end};
  if(!goalOk(goal))throw Error('invalid_lab_goal');
  const endRow=Math.floor(end.y/1024)+1,endCol=Math.floor(end.x/1024)+1,radius=goal.kind==='range'?goal.within:0;
  if(goal.kind==='point'?gap(goal,end)>.05:Math.abs(endRow-goal.row)>radius||Math.abs(endCol-goal.col)>radius)throw Error('lab_goal_does_not_match_typed_endpoint');
  if(onlyLeg!=null){
    if(!Number.isInteger(onlyLeg)||onlyLeg<0||onlyLeg>=legs.length)throw Error('invalid_only_leg');
    const leg=legs[onlyLeg];return {format:'m59-navmesh-lab-plan/1',room:raw.room,from:copy(leg.from),goal:{kind:'point',...copy(leg.to)},legs:[leg],returnRoute:null,
      scope:'single authored leg '+onlyLeg+'; not a complete route trial',selectedLeg:onlyLeg};
  }
  let returnRoute=null;
  if(includeReturn&&raw.returnPlan){
    const back=structuredClone(raw.returnPlan.legs);
    if(!Array.isArray(back)||!back.length)throw Error('invalid_lab_return_plan');
    const returned=validateLegs(back,end);if(gap(returned,raw.from)>.05)throw Error('lab_return_does_not_match_original_start');returnRoute={from:copy(end),goal:{kind:'point',...copy(raw.from)},legs:back};
  }
  return {format:'m59-navmesh-lab-plan/1',room:raw.room,from:copy(raw.from),goal,legs,returnRoute,scope:'authored typed approach'+(returnRoute?' and return':'')};
}

/** Pure guards; credentials are read only to refuse a wrong endpoint, never returned. */
export function validateNativeNavMeshLabInputs({config,roster,scene,plan,candidateJumps=0}={}) {
  if(!config?.fleet_file||!config.agent||!config.native_snapshot)throw Error('explicit_owned_config_and_native_snapshot_required');
  selectTypedNavMeshLabPlan({...plan,returnPlan:plan.returnRoute?{legs:plan.returnRoute.legs}:undefined});
  const credentials=roster?.[config.agent]?.credentials;
  if(!['127.0.0.1','localhost','::1'].includes(credentials?.host)||Number(credentials?.port)!==17959)
    throw Error('native_navmesh_lab_requires_loopback_17959_before_login');
  if(config.admin_port!=null&&Number(config.admin_port)!==17998||config.admin_host!=null&&config.admin_host!=='127.0.0.1')throw Error('native_navmesh_lab_requires_loopback_17998');
  if(config.pvp&&config.pvp.enabled!==false)throw Error('movement_lab_refuses_pvp_configuration');
  if(scene?.schema!=='m59-scene/v1'||Number(scene.room?.num)!==plan?.room)throw Error('scene_plan_room_mismatch');
  const actors=scene.actors??[],mine=actors.filter(a=>a.mine);
  if(mine.length!==1||mine[0].kind!=='player'||actors.some(a=>a.kind==='monster'||a.kind==='player'&&!a.mine))throw Error('movement_lab_requires_one_owned_player_without_other_bodies');
  if(scene.controller&&Object.entries(scene.controller).some(([key,value])=>key!=='mode'&&value!=null&&(!(Array.isArray(value))||value.length)))throw Error('movement_lab_refuses_captured_controller_actions');
  if(/REPLACE_|^</.test(mine[0].name??''))throw Error('authored_scene_requires_private_character_binding');
  const at=mine[0].at?.v??mine[0].at;
  if(![at?.row,at?.col,at?.x,at?.y].every(Number.isInteger)||Math.floor(at.x/64)!==at.col||Math.floor(at.y/64)!==at.row
    ||gap(protocolToClient(at),plan.from)>.05)throw Error('scene_fine_start_does_not_match_plan');
  if(!Number.isInteger(candidateJumps)||candidateJumps<0||candidateJumps>4)throw Error('candidate_jumps_must_be_0_to_4');
  const legs=[...plan.legs,...(plan.returnRoute?.legs??[])],candidates=legs.filter(l=>l.kind==='jump'&&l.declared!==true);
  if(candidates.length>candidateJumps)throw Error('candidate_falls_require_explicit_candidate_jumps');
  return {room:plan.room,candidateFalls:candidates.length,declaredFalls:legs.filter(l=>l.kind==='jump'&&l.declared===true).length,
    walkingLegs:legs.filter(l=>l.kind==='walk').length};
}

export async function executeTypedNavMeshLabPlan(s,plan,{candidateJumps=0,deadline=Date.now()+900000,isInterrupted=()=>false,onEvent=()=>{},nap=sleep}={}) {
  const client=s.client,body=client.selfId,roomId=client.room.id,generation=s.movementGeneration,token='navmesh-native-lab:'+Date.now();
  s.movementCancellationChecks??=new Map();s.movementCancellationChecks.set(token,()=>isInterrupted()||Date.now()>=deadline);
  const check=()=>{
    if(isInterrupted()||Date.now()>=deadline||s.client!==client||client.selfId!==body||s.movementWasCancelled(generation,token))throw Error('native_trial_cancelled_or_expired');
    if(Number(s.world.room.num)!==plan.room||client.room.id!==roomId)throw Error('native_trial_room_changed');
    const health=client.vitals()?.health?.value;if(!Number.isFinite(health)||health<=0)throw Error('native_trial_body_not_living');
  };
  const beforeMutation=()=>{check();return true;};
  const confirm=async()=>{check();const confirmed=await s.confirmPosition({timeoutMs:1500});check();
    if(!confirmed||client.self?.predicted)throw Error('native_trial_position_not_confirmed');return protocolToClient(client.self);};
  const wait=async ms=>{const until=Date.now()+ms;while(Date.now()<until){check();await nap(Math.min(100,until-Date.now()));}check();};
  const pose=()=>{const at=protocolToClient(client.self),g=s.world.geometry,l=g.leafAtClient(at.x,at.y);return {room:s.world.room.num,protocol:{x:client.self.x,y:client.self.y,row:client.self.row,col:client.self.col},client:at,
    floor:l?.sector?g.floorBaseAtClient(at.x,at.y,l):null,hp:client.vitals()?.health?.value};};
  let usedCandidates=0;
  const route=async(route,label)=>{
    let actual=await confirm();if(gap(actual,route.from)>48)throw Error('native_trial_origin_mismatch');
    for(const [legIndex,leg]of route.legs.entries()){
      check();const g=s.world.geometry,floorAt=(x,y)=>g.floorBaseAtClient(x,y,g.leafAtClient(x,y));
      actual=await confirm();if(gap(actual,leg.from)>48)throw Error('native_trial_leg_origin_mismatch');
      if(leg.kind==='walk'){
        const proof=proveNavMeshWalk(g,[actual,...leg.waypoints]);if(!proof.ok)throw Error('native_trial_walk_not_proved:'+proof.reason);
        const execution=navMeshExecutionAims(g,{waypoints:proof.points},{maxDistance:1024,maxMs:1000});
        onEvent({kind:'walk_prepared',label,legIndex,proofPoints:proof.points.length,aims:execution.aims.length,pose:pose()});
        for(const [index,p]of execution.aims.entries()){
          check();const wire=quantizeRailPoint(p,{floorAt,edge:(a,b)=>g.traceFineMoveClient(a.x,a.y,b.x,b.y)?.arrived===true});
          if(!wire.ok)throw Error('native_trial_wire_point_not_proved:'+wire.reason);
          const before=pose(),reply=await s.walkFine(wire.protocol.x,wire.protocol.y,{maxSteps:10,stride:32,arriveWithin:3,exactArrival:true,holdShelf:true,
            movementGeneration:generation,controlToken:token,beforeMutation});check();
          onEvent({kind:'walk_reply',label,legIndex,index,targetClient:p,targetProtocol:wire.protocol,before,reply,after:pose()});
          if(!reply.arrived)throw Error('native_trial_walk_refused:'+(reply.reason??'waypoint_'+index));
        }
      }else{
        if(leg.declared!==true&&++usedCandidates>candidateJumps)throw Error('native_trial_candidate_fall_not_authorized');
        const settling=s.collisionVertical?{...s.collisionVertical}:null,waitMs=settling?Math.max(0,Math.min(5000,settling.settleAt-Date.now())):0;
        if(waitMs)await wait(waitMs+20);
        actual=await confirm();if(gap(actual,leg.from)>48)throw Error('native_trial_fall_origin_changed');
        let declaredProof=null;
        if(leg.declared===true){
          const action={declared:true,room:plan.room,from:leg.fromSquare??{row:Math.floor(leg.from.y/1024)+1,col:Math.floor(leg.from.x/1024)+1},
            to:leg.toSquare??{row:Math.floor(leg.to.y/1024)+1,col:Math.floor(leg.to.x/1024)+1},fromFine:leg.from,toFine:leg.to,
            declaredFrom:leg.declaredFrom??leg.from,declaredTo:leg.declaredTo??leg.to,requires:leg.requires};
          declaredProof=proveNavMeshJump(g,leg.from,leg.to,action);if(!declaredProof.ok)throw Error('native_trial_declaration_not_proved:'+declaredProof.reason);
        }
        const proof=proveCandidateFall(g,{fromFine:actual,toFine:leg.to});
        if(!proof.model_proved)throw Error('native_trial_live_fall_not_proved:'+proof.reason);
        const before=pose(),aim=proof.to_wire.protocol,to={row:Math.floor(aim.y/64),col:Math.floor(aim.x/64)};
        const reply=await s.step(to.col,to.row,{fall:true,timedFall:true,aimX:aim.x,aimY:aim.y,movementGeneration:generation,controlToken:token,beforeMutation});
        onEvent({kind:'fall_dispatch',label,legIndex,candidate:leg.declared!==true,before,proof,declaredProof,settling,waitMs,reply});
        if(!reply.moved)throw Error('native_trial_fall_not_sent:'+(reply.reason??'refused'));
        await wait(5500);actual=await confirm();const p=pose(),landing=landingCheck(actual,proof.to_wire.client,{floor:p.floor,wantedFloor:proof.to_wire.floor,tolerance:48});
        onEvent({kind:'fall_landing',label,legIndex,landing,pose:p});if(!landing.ok)throw Error('native_trial_landing_not_confirmed');
      }
    }
    actual=await confirm();const end=route.legs.at(-1).to,g=s.world.geometry,wantedFloor=g.floorBaseAtClient(end.x,end.y,g.leafAtClient(end.x,end.y)),p=pose();
    const landing=landingCheck(actual,end,{floor:p.floor,wantedFloor,tolerance:48});
    const goal=route.goal,row=p.protocol.row,col=p.protocol.col,within=goal.kind==='range'?goal.within:0;
    const matched=goal.kind==='point'?gap(actual,goal)<=48:Math.abs(row-goal.row)<=within&&Math.abs(col-goal.col)<=within;
    onEvent({kind:'route_endpoint',label,landing,goal,matched,pose:p});
    if(!landing.ok||!matched)throw Error('native_trial_endpoint_not_confirmed');return {arrived:true,landing,pose:p};
  };
  try{const approach=await route(plan,'approach'),back=plan.returnRoute?await route(plan.returnRoute,'return'):null;
    return {arrived:true,approach_verified:approach.arrived,return_verified:back?.arrived??null,scope:plan.scope,approach,return:back,candidate_falls:usedCandidates};
  }finally{s.movementCancellationChecks.delete(token);}
}

export async function runNativeNavMeshLab({configFile,sceneFile,planFile,out,horizonMs=900000,candidateJumps=0,onlyLeg=null,repeat=1}={}) {
  if(![configFile,sceneFile,planFile,out].every(p=>typeof p==='string'&&p))throw Error('explicit_config_scene_plan_out_required');
  if(!Number.isInteger(horizonMs)||horizonMs<1||horizonMs>1800000||!Number.isInteger(repeat)||repeat<1||repeat>5)throw Error('invalid_native_trial_bounds');
  const config=JSON.parse(fs.readFileSync(configFile,'utf8')),roster=JSON.parse(fs.readFileSync(path.resolve(path.dirname(configFile),config.fleet_file),'utf8')),
    scene=JSON.parse(fs.readFileSync(sceneFile,'utf8')),input=JSON.parse(fs.readFileSync(planFile,'utf8')),
    plan=selectTypedNavMeshLabPlan(input,{onlyLeg}),validation=validateNativeNavMeshLabInputs({config,roster,scene,plan,candidateJumps});
  if(!fs.existsSync(path.resolve(path.dirname(configFile),config.native_snapshot)))throw Error('explicit_native_snapshot_not_found');
  // Every endpoint/config/shape refusal above happens before adapter creation or login.
  const {createShadowReplayAdapter}=await import('./m59-shadow-replay.mjs');
  fs.mkdirSync(out,{recursive:true});const file=path.join(out,'navmesh-native-'+Date.now()+'.json');
  const receipt={format:'m59-navmesh-native-lab/1',at:new Date().toISOString(),scope:plan.scope,
    sceneSha256:crypto.createHash('sha256').update(fs.readFileSync(sceneFile)).digest('hex'),planSha256:crypto.createHash('sha256').update(fs.readFileSync(planFile)).digest('hex'),
    validation,quiet:true,candidateJumps,repeat,runs:[],native_execution_claim:'Only completed independent server-confirmed trials count; model candidates are not new declarations.'};
  let adapter,aborted=false,active;
  try{
    adapter=await createShadowReplayAdapter({configFile:path.resolve(configFile),isolate:false,terminateAfterTrial:true,engineRoot:fileURLToPath(new URL('../',import.meta.url))});
    for(let trial=0;trial<repeat;trial++){
      aborted=false;const row={trial:trial+1,events:[],finished:false};receipt.runs.push(row);
      row.replay=await adapter.run({scene,frame:{at:Date.now(),scene},horizonMs,
        variant:{id:'navmesh-authored-route',kind:'baseline',reload:{labScenery:true,exactMonsterPlacement:true,noMonsters:true}},
        onPrepared:async(s,k)=>{k.startWatchdog=()=>{};k.loop=()=>new Promise(()=>{});},
        onStarted:async s=>{
          active=executeTypedNavMeshLabPlan(s,plan,{candidateJumps,deadline:Date.now()+horizonMs,isInterrupted:()=>aborted,
            onEvent:event=>{row.events.push({at:Date.now(),...event});if(['walk_prepared','fall_dispatch','fall_landing','route_endpoint'].includes(event.kind))console.log(JSON.stringify({trial:trial+1,kind:event.kind,label:event.label,legIndex:event.legIndex,aims:event.aims,landing:event.landing}));}})
            .then(result=>{row.result=result;row.finished=true;},error=>{row.error=error.message;row.result={arrived:false,reason:error.message};row.finished=true;});
        },onStopping:()=>{aborted=true;},shouldStop:()=>row.finished});
      aborted=true;await Promise.race([active??Promise.resolve(),sleep(2000)]);
      await adapter.reset();row.baseline_restored=true;
      if(!row.finished)row.result={arrived:false,reason:row.replay?.outcome==='died'?'died':'trial_ended_before_completion'};
      fs.writeFileSync(file,JSON.stringify(receipt,null,2)+'\n');
      if(!row.result?.arrived)break;
    }
  }catch(error){receipt.error=error.message;}
  finally{
    aborted=true;
    try{if(adapter){await adapter.reset();receipt.baseline_restored=true;}}catch(error){receipt.cleanup_error=error.message;}
    try{await adapter?.close();}catch(error){receipt.close_error=error.message;}
  }
  receipt.complete=receipt.runs.length===repeat&&receipt.runs.every(r=>r.finished&&r.result?.arrived&&r.baseline_restored)&&receipt.baseline_restored&&!receipt.cleanup_error&&!receipt.close_error;
  fs.writeFileSync(file,JSON.stringify(receipt,null,2)+'\n');return {file,complete:!!receipt.complete,runs:receipt.runs.length,error:receipt.error??receipt.cleanup_error??receipt.close_error??null};
}

async function main(){
  const args=process.argv.slice(2),value=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
  if(args.includes('--help')){console.log('Explicit --config FILE --scene FILE --plan FILE --out DIR [--candidate-jumps N] [--only-leg N] [--repeat N] [--horizon-ms N]. Owned loopback17959 quiet movement only.');return;}
  const result=await runNativeNavMeshLab({configFile:value('--config'),sceneFile:value('--scene'),planFile:value('--plan'),out:value('--out'),
    candidateJumps:Number(value('--candidate-jumps',0)),onlyLeg:value('--only-leg',null)==null?null:Number(value('--only-leg')),repeat:Number(value('--repeat',1)),horizonMs:Number(value('--horizon-ms',900000))});
  console.log(JSON.stringify(result));if(!result.complete)process.exitCode=2;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(error.message);process.exitCode=2;});
