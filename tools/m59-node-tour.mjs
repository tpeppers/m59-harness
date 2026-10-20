// Five-node circuit. No maintenance calls: this module only uses ordinary movement.
import {readFileSync,writeFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {execFile,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {protocolToClient} from './m59-finepos.mjs';
import {roomGeometry,floorAt,edgeOf,floodReport} from './m59-ground.mjs';
import {cutRail} from './m59-railcut.mjs';
import {railLeg,checkRoute} from './m59-noderails.mjs';
import {STONES} from './m59-stones.mjs';
import {resolveControlUrl} from './m59-fleetpath.mjs';
import {nodeReport,meldVerdict} from './m59-nodecheck.mjs';
import {epochId} from './m59-epoch.mjs';
import {updateNodeMemory,readNodeMemory} from './m59-node-memory.mjs';
import {CIRCUIT_NODES,circuitPlan,selectCircuitNodes,selectedCircuitComplete} from './m59-node-circuit.mjs';
import {ensureTourRails} from './m59-node-tour-rails.mjs';
import {withTourWalkOwnership,stableNodeGrant,railIdentityProblem} from './m59-node-tour-policy.mjs';
import {rosterGameEndpoint,stateFileFor} from './m59-fleetpath.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const TOUR_NODES=CIRCUIT_NODES;
export const TOUR_ROOMS=[2,38,39,599,589,579,578,576,587,586,585,584,583,593,49,45,574,150,575,27,597,598];
export const hashFile=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
// look retains a completed/cancelled job as a receipt. Presence does not mean busy.
export const travelJobActive=job=>!!job?.busy;
export function tourPosition(l){
  const p=l.you,c=p?.x!=null?protocolToClient(p):null,room=l.room?.num;
  return {room,row:p?.row,col:p?.col,x_client:c?.x??null,y_client:c?.y??null,
    floor_client:c?floorAt(roomGeometry(room),c.x,c.y):null,hp:l.hp,mana:l.mana,connection_revision:l.connection_revision};
}
export function insideNode(p,node){const s=STONES[node];return p.room===s.room&&Math.abs(p.row-s.row)<3&&Math.abs(p.col-s.col)<3;}
export function tourComplete(r){return r.start?.room===2&&r.end?.room===2&&r.nodes?.length===5&&
  r.nodes.every((n,i)=>n.stone===TOUR_NODES[i]&&insideNode(n.position,n.stone))&&!r.failure;}
export function cutTourWalk(geo,from,step){
  const edge=edgeOf(geo);
  const proof=step.boxFlood?floodReport(geo,from,{row:step.row,col:step.col},{lattice:64,cap:1500000,box:0}):
    cutRail(from,step,{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y)});
  let points=step.boxFlood?proof.path:(proof.ok&&proof.bridgeOk?proof.waypoints:null);
  if(points&&(points[0].x!==from.x||points[0].y!==from.y))points=[from,...points];
  return {proof,points};
}
export const tourPlan=circuitPlan;

// ALREADY IN THE STONE'S ROOM. A farmer posted beside a stone has no reason to go to room 2 and back to meld it, and
// a planner walk from the farm floor cannot get onto the stone's shelf: Robin in The Badlands (45), 2026-10-19,
// stalled at r54c47 with walk_to and at r58c45 crawling (40 hops that "did not take"), floor 1664 under a stone on
// 4096. So: a checked body-seeded cut to the first waypoint of the stone's measured rail, the rail itself, the
// circuit's own meld (node memory written), and the circuit's return cut to the room's entrance. Only stones whose
// rail start is on the room's common floor are listed; anything else answers no plan rather than a guess.
const IN_ROOM_RAIL_START=Object.freeze({badlands:{room:45,x:53856,y:992,row:1,col:53}});
export function inRoomNodePlan(node){
  const start=IN_ROOM_RAIL_START[node];
  if(!start)throw Error('no_in_room_plan_for_'+node);
  return [{kind:'cut',...start,board:node},{kind:'rail',node},{kind:'meld',node},{kind:'cut',room:start.room,boxFlood:true,row:start.row,col:start.col}];
}
// BOARD THE RAIL WHERE THE BODY IS, NOT ONLY AT ITS HEAD. Bunsen, 2026-10-20 02:49Z: a broker handover cut his first
// run at waypoint 102 of 361, his keeper then carried him on to r37c33 (floor 2816, on the rail's own shelf), and the
// cut back to the rail's head at r1c53 flooded 400000 cells without reaching it -- body_seeded_cut_failed, 5.2 squares
// from rail waypoint 1468 (fineclimb boards within 2). So the cut tries the nearest rail waypoints first, one per
// 16-waypoint stretch, then the head; the rail follow then boards on the segment the cut ended on. Each try is a
// checked cut (68 ms for Bunsen's), and a body under the mesa still answers no plan rather than a guess.
// ALREADY ON THE RAIL IS NOT A CUT. Robin, 03:37Z: 0.27 squares from rail waypoint 3076, so the boarding cut was three
// fine steps (270 client units) and fineclimb answered "did not arrive" in 1 s, which stopped the run before the rail.
// Within `onRail` (one square, half fineclimb's --board-within 2) the cut stands down and the rail follow boards there.
export function railBoardingCut(geo,from,step,waypoints,{tries=6,spacing=16,onRail=1024}={}){
  const head={...step,board:undefined},attempts=[];
  const near=(waypoints??[]).map((p,i)=>({i,p,d:Math.hypot(p.x-from.x,p.y-from.y)})).sort((a,b)=>a.d-b.d),picked=[];
  if(near.length&&near[0].d<=onRail)return {proof:{ok:true,why:'already_on_rail'},points:null,onRail:true,target:{index:near[0].i},attempts};
  for(const c of near){if(picked.length>=tries)break;if(!picked.some(q=>Math.abs(q.i-c.i)<spacing))picked.push(c);}
  const square=v=>Math.floor(v/1024)+1;
  const candidates=[...picked.map(c=>({index:c.i,step:{kind:'cut',room:step.room,x:c.p.x,y:c.p.y,row:square(c.p.y),col:square(c.p.x)}})),{index:'head',step:head}];
  for(const c of candidates){
    const {proof,points}=cutTourWalk(geo,from,c.step);attempts.push({index:c.index,ok:!!points,why:points?null:proof.why??null});
    if(points)return {proof,points,target:c,attempts};
  }
  return {proof:{ok:false,why:'no_rail_waypoint_reachable',attempts},points:null,target:null,attempts};
}

export function tourReturnPlan(room){
  const travel=to=>({kind:'travel',to});
  const north=[578,576,587,597,598,599,2].map(travel);
  const ancient=[{kind:'rail',node:'ancient',direction:'to_exit',exit:'edge:578:r1c17'},...north];
  const canyon=[{kind:'cut',room:49,x:20544,y:512,row:1,col:21},{kind:'cross',row:0,col:21,to:593},
    ...[583,584,574,150,575,576,587,597,598,599,2].map(travel)];
  if(room===2)return [];
  if(room===39)return [{kind:'rail',node:'victoria',direction:'to_exit',exit:'go:38:r9c27'},travel(38),travel(2)];
  if(room===589)return [{kind:'rail',node:'sentinel',direction:'to_exit',exit:'edge:579:r43c1'},travel(579),...ancient];
  if(room===579)return ancient;
  if(room===45)return [{kind:'cut',room:45,boxFlood:true,row:1,col:53},{kind:'cross',row:0,col:53,to:49},...canyon];
  if(room===49)return canyon;
  if(room===27)return [{kind:'walk',row:57,col:45},travel(587),...north.slice(3)];
  for(const road of [[38,2],[578,576,587,597,598,599,2],[586,585,584,574,150,575,576,587,597,598,599,2],
    [593,583,584,574,150,575,576,587,597,598,599,2]]){
    const i=road.indexOf(room);if(i>=0)return road.slice(i+1).map(travel);
  }
  throw Error('no_measured_return_for_room_'+room);
}

// The broker the fleetscript already proved holds this fleet (guarantee 11), resolved the same way, not the raw
// env var: node-in-room run from the REPL had no M59_CONTROL_URL and stopped on 'Invalid URL', 2026-10-20 02:39Z.
const controlUrl=()=>{const r=resolveControlUrl();if(!r.url)throw Error('no broker named: '+r.why);return r.url;};
export async function runTour(ctx,options={}){
  return withTourWalkOwnership(ctx.agent,()=>runTourInner(ctx,options));
}
async function runTourInner(ctx,{railFile='substrate/node-tour-rails.json',evidenceDir='substrate/node-tours',fromStep=0,expectedGame=null,recovery=false,useCache=false,getAll=false,inRoom=null}={}){
  fromStep=Number(fromStep);
  if(!Number.isInteger(fromStep)||fromStep<0||fromStep>=tourPlan().length)throw Error('invalid_tour_start_step');
  const {agent,call,state}=ctx,out=resolve(root,evidenceDir);mkdirSync(out,{recursive:true});
  const health=await(await fetch(new URL('health',controlUrl()))).json();
  if(useCache){
    const identityProblem=railIdentityProblem({fleet:health.fleet,agent,health,expectedGame,
      rostered:rosterGameEndpoint(stateFileFor(health.fleet)),checkedRail:true});
    if(identityProblem)throw Error(identityProblem);
  }
  const first=await call('look',{agent});
  if(inRoom&&first.room?.num!==STONES[inRoom]?.room)throw Error('in_room_start_requires_room_'+STONES[inRoom]?.room);
  if(!inRoom&&!recovery&&fromStep===0&&first.room?.num!==2)throw Error('tour_start_requires_room_2');
  if(useCache&&fromStep!==0)throw Error('cache_selection_cannot_resume_by_full_circuit_step');
  const character=health.session_characters?.[agent];
  const server=health.session_game_servers?.[agent]??health.game_server;
  const memory=useCache&&!recovery&&!inRoom?await readNodeMemory({server:server.host+':'+server.port,character}):null;
  const selection=inRoom?{selected:[inRoom],in_room:true}:selectCircuitNodes(memory,{getAll:useCache?getAll:true});
  console.log('TOUR SELECTION '+JSON.stringify(selection));
  const plan=inRoom?inRoomNodePlan(inRoom):recovery?tourReturnPlan(first.room.num):tourPlan(selection.selected);
  if((useCache&&!recovery)||inRoom)await ensureTourRails({railFile,selected:selection.selected});
  const usesBakedRails=plan.some(s=>s.kind==='rail');
  const id='five-node-'+Date.now(),record={format:'m59-node-tour/1',id,at:new Date().toISOString(),agent,
    fleet:health.fleet,character,game_server:server,checkout_sha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),
    broker_sha:process.env.M59_TRIAL_BROKER_SHA??'unknown',broker_pid:health.pid,movement_epoch:epochId(),
    recipe_sha256:hashFile(fileURLToPath(import.meta.url)),rail_sha256:usesBakedRails?hashFile(resolve(root,railFile)):null,
    setup:state.tourSetup??null,scene_ref:state.tourSceneRef??null,from_step:recovery?-1:fromStep,recovery,
    start:tourPosition(first),nodes:[],legs:[],complete:false,selection};
  if(usesBakedRails){record.rail_ref=id+'-rails.json';writeFileSync(join(out,record.rail_ref),readFileSync(resolve(root,railFile)));}
  state.tour=record;state.tourFile=join(out,id+'.json');
  let journalRead=null,lastJournalAt=0;
  const journalTimer=setInterval(()=>{
    if(journalRead)return;
    journalRead=call('autopilot',{agent,action:'status'}).then(a=>{
      const recent=(a.recent??[]).filter(r=>r.at>lastJournalAt);
      if(recent.length)lastJournalAt=Math.max(...recent.map(r=>r.at));
      appendFileSync(join(out,id+'-keeper.jsonl'),JSON.stringify({at:new Date().toISOString(),recent,
        did:a.did,faculties:a.faculties})+'\n');
    }).catch(()=>{}).finally(()=>{journalRead=null;});
  },5000);journalTimer.unref?.();
  const save=()=>writeFileSync(state.tourFile,JSON.stringify(record,null,2));
  const read=async()=>{const l=await call('look',{agent});if(l.hp?.value<=0||l.room?.num===1)throw Error('tour_character_died');return l;};
  const command=async(name,args,label,stopRoom=null)=>{
    const before=tourPosition(await read());let reply,done=false,crossed=false,watchError=null;
    const watcher=stopRoom==null?null:(async()=>{
      while(!done){const l=await read();
        appendFileSync(join(out,id+'-positions.jsonl'),JSON.stringify({at:new Date().toISOString(),label,...tourPosition(l)})+'\n');
        if(l.room.num===stopRoom){crossed=true;await call('cancel_movement',{agent});return;}
        await sleep(300);
      }
    })().catch(async e=>{watchError=e;done=true;try{await call('cancel_movement',{agent});}catch{}});
    try{reply=await call(name,{agent,...args});}catch(e){reply={error:e.message};}
    finally{done=true;if(watcher)await watcher;}
    if(watchError)throw watchError;
    const after=tourPosition(await read());
    appendFileSync(join(out,id+'-commands.jsonl'),JSON.stringify({at:new Date().toISOString(),label,name,args,before,reply,after,
      ...(stopRoom==null?{}:{stop_on_room:stopRoom,crossing_observed:crossed})})+'\n');
    return reply;
  };
  const travel=async(to,label)=>{
    if((await read()).room.num===to)return;
    const reply=await command('travel',{to,max_hops:1,background:true,run_errands:false},label);
    const until=Date.now()+240000;let seenJob=false;
    while(Date.now()<until){const l=await read();
      appendFileSync(join(out,id+'-positions.jsonl'),JSON.stringify({at:new Date().toISOString(),label,...tourPosition(l)})+'\n');
      if(l.room.num===to){await command('cancel_movement',{},label+'-arrived');return;}
      seenJob ||= travelJobActive(l.job);
      if(!travelJobActive(l.job)&&(seenJob||Date.now()>until-234000))throw Error('travel_stopped_before_room_'+to+': '+JSON.stringify({issued:reply,terminal_job:l.job}));
      await sleep(1000);
    }
    await command('cancel_movement',{},label+'-timeout');throw Error('travel_timeout_room_'+to);
  };
  const railWaypoints=node=>{const stone=JSON.parse(readFileSync(resolve(root,railFile),'utf8')).stones?.find(s=>s.node===node);
    return (stone?.routes?.find(r=>r.direction==='to_node')?.legs??[]).flatMap(l=>l.waypoints??[]);};
  const follow=async(step,label,file=railFile)=>{
    const args=['tools/m59-fineclimb.mjs','--fleet',health.fleet,'--port',String(new URL(controlUrl()).port),
      '--agent',agent,'--rail',step.node,'--rail-file',resolve(root,file),'--direction',step.direction??'to_node','--no-hop',
      ...(expectedGame?['--expected-game',expectedGame]:[]),
      ...(step.exit?['--exit',step.exit]:[])];
    for(const dry of [true,false]){
      const extra=dry?['--dry-run']:['--receipt',join(out,id+'-'+label+'-commands.jsonl')];
      const result=await new Promise(done=>execFile(process.execPath,[...args,...extra],{cwd:root,timeout:900000,maxBuffer:8000000,windowsHide:true},
        (error,stdout,stderr)=>done({code:error?(error.code??'terminated'):0,signal:error?.signal,stdout,stderr})));
      writeFileSync(join(out,id+'-'+label+(dry?'-dry':'-follow')+'.txt'),result.stdout+'\n'+result.stderr);
      console.log(result.stdout.slice(-1400));
      if(result.code!==0)throw Error((dry?'rail_dry_refused':'rail_follow_stopped')+': '+label);
    }
  };
  try{
    for(let i=fromStep;i<plan.length;i++){
      const step=plan[i],label=String(i).padStart(2,'0')+'-'+step.kind+'-'+(step.node??step.to??step.room??'point');
      const leg={index:i,label,step,start:tourPosition(await read()),at:new Date().toISOString()};record.legs.push(leg);save();
      console.log('TOUR LEG '+JSON.stringify(leg));
      if(step.kind==='travel')await travel(step.to,label);
      else if(step.kind==='rail')await follow(step,label);
      else if(step.kind==='cut'){
        const p=tourPosition(await read());if(p.room!==step.room)throw Error('cut_wrong_room');
        const geo=roomGeometry(p.room),edge=edgeOf(geo),from={x:p.x_client,y:p.y_client};
        const board=step.board?railBoardingCut(geo,from,step,railWaypoints(step.board)):null;
        // A boarding cut ends on the rail waypoint it chose, and fineclimb judges arrival against route.to: naming the
        // rail head there read Bunsen's 14 arrived waypoints as 'did not arrive', 2026-10-20 03:39Z.
        const {proof,points}=board??cutTourWalk(geo,from,step);
        if(board)leg.board={target:board.target?.index??null,attempts:board.attempts,on_rail:board.onRail||undefined};
        if(board?.onRail){console.log('already on the rail at waypoint '+board.target.index+': no cut');continue;}
        if(!points){leg.cut=proof;throw Error('body_seeded_cut_failed');}
        writeFileSync(join(out,id+'-'+label+'-cut.json'),JSON.stringify(proof));
        const walk=railLeg({waypoints:points},{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y)});
        const route={ok:true,rail_complete:walk.unvalidated===0,direction:'to_node',exit:'body-cut',exit_label:'body-cut',
          from:`r${p.row}c${p.col}`,to:`r${(board?.target?.step??step).row}c${(board?.target?.step??step).col}`,legs:[walk],jumps:0,all_declared:true,waypoints:walk.waypoints.length,
          confidence:'body-seeded exact-endpoint walk, checked before following'};
        leg.check=checkRoute(route,{edge});if(!leg.check.ok||leg.check.skipped||!route.rail_complete)throw Error('cut_check_failed');
        const file=join(out,id+'-'+label+'-rail.json');writeFileSync(file,JSON.stringify({stones:[{node:'cut',room:p.room,routes:[route]}]}));
        leg.rail_ref=file;leg.rail_sha256=hashFile(file);await follow({node:'cut'},label,file);
      }else if(step.kind==='walk'||step.kind==='cross'){
        if(step.to&&(await read()).room.num===step.to){leg.already_in_room=true;}
        else await command('walk_to',{row:step.row,col:step.col,fine:false,max_steps:step.kind==='cross'&&step.to!==587?8:80,arrive_within:3},label,step.to??null);
        await command('cancel_movement',{},label+'-settle');await sleep(500);
        if(step.to&&(await read()).room.num!==step.to)throw Error('crossing_failed_room_'+step.to);
      }else if(step.kind==='meld'){
        const l=await read(),p=tourPosition(l);if(!insideNode(p,step.node))throw Error('outside_meld_box_'+step.node);
        const node=l.objects.find(o=>/mana node/i.test(o.name));if(!node)throw Error('node_not_visible_'+step.node);
        const before=await call('status',{agent}),activation=await command('act',{verb:'activate',target:node.id},label);
        // A short act response can precede its message. Read only events after this
        // room look; never search old history for an already-bonded sentence.
        const observation=meldVerdict(JSON.stringify(activation)).verdict==='unrelated'&&Number.isFinite(l.ev_seq)
          ?await call('wait_for_event',{agent,since:l.ev_seq,kinds:['message'],timeout_ms:3000}):null;
        await sleep(3000);const after=await call('status',{agent});await sleep(1500);const stable=await call('status',{agent});
        const verdict=meldVerdict(JSON.stringify({activation,observation}));
        const grant=stableNodeGrant(before,after,stable);
        const objective={stone:step.node,position:p,node_state:nodeReport({objects:l.objects,you:l.you}),activation,observation,observed_since:l.ev_seq,verdict,
          before:before.mana,after:after.mana,stable:stable.mana,grant,connection_revision:before.connection_revision,
          keeper_pids:[before.pid,after.pid,stable.pid],connection_revisions:[before.connection_revision,after.connection_revision,stable.connection_revision],
          status:verdict.verdict==='melded'||grant?'melded':verdict.verdict==='already'?'already':verdict.verdict==='dead'?'dead_node':'unknown'};
        record.nodes.push(objective);save();
        if(['melded','already'].includes(objective.status)){
          const character=health.session_characters?.[agent]??l.character??l.you?.name;
          const server=health.session_game_servers?.[agent]??health.game_server;
          objective.memory=await updateNodeMemory({server:server.host+':'+server.port,character},
            {kind:'observe',node:step.node,status:objective.status,evidence:state.tourFile,at:new Date().toISOString()});
        }
        console.log('TOUR NODE '+JSON.stringify(objective));
      }
      leg.end=tourPosition(await read());leg.completed_at=new Date().toISOString();save();
    }
    record.end=tourPosition(await read());record.complete=!recovery&&fromStep===0&&tourComplete(record);
    record.selected_complete=selectedCircuitComplete(record);
    record.recovery_complete=recovery&&record.end.room===2;
    record.partial_complete=!recovery&&fromStep>0;
    if(inRoom){record.in_room_complete=record.nodes.some(n=>n.stone===inRoom&&['melded','already'].includes(n.status));return record.in_room_complete;}
    return useCache&&!recovery?record.selected_complete:record.complete||record.partial_complete||record.recovery_complete;
  }catch(e){record.failure=String(e.stack??e);console.log('TOUR STOP '+e.message);return false;}
  finally{
    clearInterval(journalTimer);if(journalRead)await journalRead;
    await call('cancel_movement',{agent});record.end=tourPosition(await call('look',{agent}));save();
    appendFileSync(join(out,'tours.jsonl'),JSON.stringify(record)+'\n');console.log('TOUR RECEIPT '+state.tourFile+' complete='+record.complete);
  }
}
