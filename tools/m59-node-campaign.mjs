#!/usr/bin/env node
// Durable, serial mana-node campaign. Plan first, then run the saved character queue.
// --plan file --fleet prod --port 8901 --priority hk3,t9 --expected-game host:port
// --run file [--limit 1]; --retry agent explicitly retries a stopped entry after diagnosis.
import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {availableForTour,tourObjectiveComplete,atPost,endpointName} from './m59-node-tour-policy.mjs';
import {runTour,tourPosition} from './m59-node-tour.mjs';
import {takeRunLock,releaseRunLock} from './m59-runlock.mjs';
import {fleetName,stateFileFor} from './m59-fleetpath.mjs';
import {ensureNodeKeeperBuild} from './m59-node-keeper-build.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const args=process.argv.slice(2),arg=(k,d=null)=>{const i=args.indexOf('--'+k);return i<0?d:args[i+1];};
const fleet=fleetName(),port=Number(arg('port',8901));
process.env.M59_CONTROL_URL=`http://127.0.0.1:${port}/`;
const {call,fleetScript,verify,walk,holdKeeper}=await import('./m59-fleetscript.mjs');
const {runNamed}=await import('./m59-fleetlib.mjs');
const file=resolve(arg('plan')??arg('run')??'substrate/node-campaign/campaign.json');
const save=r=>{mkdirSync(dirname(file),{recursive:true});const tmp=file+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(r,null,2));renameSync(tmp,file);};
const health=()=>fetch(process.env.M59_CONTROL_URL+'health',{signal:AbortSignal.timeout(15000)}).then(r=>r.json());
const assertFleet=h=>{if(h.fleet!==fleet||resolve(h.state)!==resolve(stateFileFor(fleet)))throw Error('campaign_fleet_identity_mismatch');};
const h=await health();assertFleet(h);
if(arg('plan')){
  if(existsSync(file))throw Error('campaign_file_already_exists');
  const expected=arg('expected-game');if(!expected||endpointName(h.game_server)!==expected)throw Error('plan_requires_exact_game_endpoint');
  const rows=(await call('fleet',{})).fleet,priority=(arg('priority','')??'').split(',').filter(Boolean);
  for(const agent of priority)if(!rows.some(r=>r.agent===agent))throw Error('priority_not_in_fleet_'+agent);
  const ordered=[...priority,...rows.map(r=>r.agent).filter(a=>!priority.includes(a))];
  const record={format:'m59-node-campaign/1',at:new Date().toISOString(),fleet,expected_game:expected,roster:resolve(h.state),
    checkout_sha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),
    status:'pending',queue:ordered.map(agent=>{const r=rows.find(r=>r.agent===agent);return {agent,character:r.character,status:'pending',
      service:priority.includes(agent),post:priority.includes(agent)?{room:2,row:19,col:8}:null,
      initial:{room:r.room_num,position:r.position,mode:r.autopilot?.mode,assigned_room:r.assigned_room,provides:r.provides},attempts:[]};})};
  save(record);console.log(JSON.stringify({file,fleet,expected_game:expected,queue:record.queue.map(r=>({agent:r.agent,character:r.character,service:r.service}))},null,2));
}else if(arg('run')){
  const record=JSON.parse(readFileSync(file,'utf8'));
  if(record.format!=='m59-node-campaign/1'||record.fleet!==fleet||record.roster!==resolve(h.state)||record.expected_game!==endpointName(h.game_server))throw Error('saved_campaign_identity_mismatch');
  const lockName=fleet+'-node-campaign',claim=takeRunLock(lockName,{label:'serial node campaign'});
  if(!claim.ok)throw Error('another_node_campaign_is_running');
  try{
    const retry=arg('retry');
    if(retry){const job=record.queue.find(j=>j.agent===retry);if(!job||!['needs_attention','active'].includes(job.status))throw Error('retry_requires_stopped_entry');job.status='pending';save(record);}
    if(record.queue.some(j=>['active','needs_attention'].includes(j.status)))throw Error('campaign_requires_review_of_previous_attempt');
    let finished=0;
    for(const job of record.queue.filter(j=>j.status==='pending')){
      if(finished>=Number(arg('limit',Infinity)))break;
      const fresh=await health();assertFleet(fresh);if(endpointName(fresh.session_game_servers?.[job.agent]??fresh.game_server)!==record.expected_game)throw Error('game_endpoint_changed');
      const rows=(await call('fleet',{})).fleet,row=rows.find(r=>r.agent===job.agent);
      if(!row||row.character!==job.character)throw Error('campaign_character_identity_changed');
      if(!availableForTour(row)){
        record.status='waiting';record.waiting={agent:job.agent,at:new Date().toISOString(),reason:row.piloted?'human_piloted':row.committed?.label??'parked'};save(record);
        console.log('CAMPAIGN WAIT '+JSON.stringify(record.waiting));break;
      }
      delete record.waiting;record.status='running';job.status='active';
      const attempt={at:new Date().toISOString(),broker_pid:fresh.pid,checkout_sha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim()};job.attempts.push(attempt);save(record);
      const evidenceDir=join(dirname(file),job.agent+'-'+Date.now());mkdirSync(evidenceDir,{recursive:true});
      let replacementHold=null;
      const script={name:'mana-node-service-tour',source:'public',params:{agents:{type:'agents',required:true},minHealth:{default:0.9},fragileBelow:{default:20}},
        async steps(){return [
          verify(async({agent,call,state})=>{
            const l=await call('look',{agent}),a=await call('autopilot',{agent,action:'status'});
            state.before={position:tourPosition(l),mode:a.mode,policy:a.policy,keeper_build:a.replay_capture?.provenance??null};
            writeFileSync(join(evidenceDir,'before.json'),JSON.stringify(state.before,null,2));return true;
          },'cannot capture return duties'),
          walk(2),
          verify(async({agent,call})=>{
            attempt.keeper_reload=await ensureNodeKeeperBuild({fleet,agent,character:job.character,
              expectedSha:attempt.checkout_sha,call});
            // A new process can have a new port. Give it its own verified heartbeat;
            // release it with the original hold when this one character's run ends.
            if(attempt.keeper_reload.reloaded){
              replacementHold=await holdKeeper({name:'mana-node-service-tour (public)',log:console.log},agent,fleet);
              if(!replacementHold.ok)throw Error('replacement_keeper_lease_refused');
            }
            save(record);return true;
          },'selected keeper did not load the deployed movement code'),
          verify(async ctx=>{
            const {agent,call,state}=ctx;
            state.tourSceneRef=join(evidenceDir,'start-scene.json');
            writeFileSync(state.tourSceneRef,JSON.stringify(await call('scene_capture',{agent}),null,2));
            state.tourSetup={quiet:false,independent_reset:false,procedure:'ordinary production travel; no scene changes or placement'};
            await runTour(ctx,{evidenceDir,expectedGame:record.expected_game});
            attempt.tour_ref=state.tourFile;attempt.route_complete=state.tour?.complete===true;
            attempt.nodes=state.tour?.nodes?.map(n=>({stone:n.stone,status:n.status}));
            state.fullTour=state.tour;save(record);return true; // Recovery and post check run even after a failed tour.
          },'tour invocation failed'),
          {...verify(async ctx=>{
            const {agent,call,state}=ctx;let l=await call('look',{agent});
            if(l.room?.num!==2&&l.room?.num!==1){
              await runTour(ctx,{evidenceDir,expectedGame:record.expected_game,recovery:true});attempt.recovery_ref=state.tourFile;
              l=await call('look',{agent});
            }
            if(l.room?.num!==2){attempt.return_failed=tourPosition(l);save(record);return false;}
            if(job.post){await call('walk_to',{agent,row:job.post.row,col:job.post.col,fine:false,max_steps:100,arrive_within:3});await call('cancel_movement',{agent});l=await call('look',{agent});}
            attempt.return_position=tourPosition(l);attempt.post_restored=!job.post||atPost(attempt.return_position,job.post);
            const a=await call('autopilot',{agent,action:'status'});
            attempt.saved_mode=state.before?.mode;attempt.return_mode=a.mode;
            attempt.duties_preserved=a.mode===state.before?.mode;attempt.objectives_complete=tourObjectiveComplete(state.fullTour);
            save(record);return attempt.post_restored&&attempt.duties_preserved;
          },'return to room 2 and saved post failed'),always:true}
        ];}};
      let result;
      try{result=await runNamed(script.name,{agents:job.agent},{scripts:new Map([[script.name,script]]),fleetScript});}
      catch(e){result={ok:false,error:e.stack};}
      finally{await replacementHold?.release();}
      writeFileSync(join(evidenceDir,'script-result.json'),JSON.stringify(result,null,2));
      attempt.finished_at=new Date().toISOString();attempt.script_ref=join(evidenceDir,'script-result.json');
      // Releasing the lease permits the original director to resume its saved service.
      const after=(await call('fleet',{})).fleet.find(r=>r.agent===job.agent);
      attempt.released=!String(after?.committed?.held_by?.by??'').startsWith('fleetscript:mana-node-service-tour');
      attempt.service_available=!job.service||after?.room_num===2&&(after.provides??[]).includes('enchant weapon');
      job.status=result.ok&&attempt.objectives_complete&&attempt.post_restored&&attempt.duties_preserved&&attempt.released&&attempt.service_available?'complete':'needs_attention';
      record.status=job.status==='complete'?'running':'needs_attention';save(record);
      console.log('CAMPAIGN RESULT '+JSON.stringify({agent:job.agent,character:job.character,status:job.status,attempt}));
      if(job.status!=='complete')break;
      finished++;
    }
    if(record.queue.every(j=>j.status==='complete'))record.status='complete';
    else if(record.status==='running')record.status='pending';
    save(record);console.log('CAMPAIGN '+record.status+' '+file);
  }finally{releaseRunLock(lockName);}
}else throw Error('Use --plan <file> or --run <file>, with --fleet and --port');
