// Fresh process per arm/trial. This wrapper only observes the historical engine.
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {sourceAssessment} from './m59-movement-death-review.mjs';
process.once('message',async request=>{
 let adapter,timer,result,error;const started=Date.now();
 const trace={goal:request.destination,arrived_alive:false,arrival_ms:null,samples:[],exit_calls:[],messages:[]};
 try{
  if(request.traceFile&&fs.existsSync(path.join(path.dirname(path.dirname(request.traceFile)),'STOP_REVIEW')))throw Error('batch cleanup/stop requested via STOP_REVIEW before trial setup');
  const root=path.resolve(request.root),imp=f=>import(pathToFileURL(path.join(root,'tools',f)));
  const {readReplay}=await imp('m59-death-replay.mjs');const bundle=await readReplay(request.bundleFile),frame=bundle.frames.find(f=>f.id===request.frameId);
  if(!frame)throw Error('selected recorded checkpoint unavailable');
  const {createShadowReplayAdapter}=await import('./m59-shadow-replay.mjs');
  adapter=await createShadowReplayAdapter({configFile:request.configFile,isolate:false,terminateAfterTrial:true,engineRoot:root});
  const attestation=await adapter.attest(),assessment=sourceAssessment(bundle.provenance?.harness,attestation.harness,{patched:request.patched,allowedFiles:request.allowedFiles});
  if(!assessment.ok)throw Error('source verification failed: '+assessment.reasons.join('; '));
  if(request.traceFile){fs.mkdirSync(path.dirname(request.traceFile),{recursive:true});fs.writeFileSync(request.traceFile,'');}
  const sample=(s,k)=>{const room=s.world?.room?.num,hp=s.client?.vitals?.()?.health?.value,now=Date.now();
   const row={at:now,elapsed_ms:now-(trace.release_at??started),room,position:Object.fromEntries(['row','col','x','y','angle'].map(f=>[f,s.client?.self?.[f]??null])),hp,
    travelling:!!k.inert?.travelling,destination:k.inert?.to??k.suspendedJourney?.to??null,doing:k.doing,
    activity:k.hold?.phase??null,decision:s.survivalDecision?.strategy??null};
   trace.samples.push(row);if(room===request.destination&&hp>0&&!trace.arrived_alive){trace.arrived_alive=true;trace.arrival_ms=row.elapsed_ms;}
   if(request.traceFile)fs.appendFileSync(request.traceFile,JSON.stringify(row)+'\n');
  };
  result=await adapter.run({scene:structuredClone(frame.scene),frame,horizonMs:request.horizonMs,
   variant:{id:request.patched?'movement-patch':'original-code',kind:'baseline',reload:request.reload??{}},
   onPrepared:async(s,k)=>{
    const note=s.noteCombatLine;
    s.noteCombatLine=function(ev){if(trace.messages.length<256)trace.messages.push({at:ev.at??Date.now(),text:ev.text});return note.call(this,ev);};
    const leave=s.leaveVia;
    s.leaveVia=async function(exit,opts){const row={at:Date.now(),room:this.world?.room?.num,exit:structuredClone(exit),position:Object.fromEntries(['row','col','x','y'].map(f=>[f,this.client?.self?.[f]??null]))};
     if(trace.exit_calls.length<128)trace.exit_calls.push(row);const r=await leave.call(this,exit,opts);row.result=structuredClone(r);return r;};
   },onStarted:async(s,k)=>{trace.release_at=Date.now();sample(s,k);timer=setInterval(()=>sample(s,k),500);},
   onStopping:async()=>{clearInterval(timer);timer=null;},shouldStop:()=>trace.arrived_alive});
  result.driver_scope='Common current scene loader and observer; gameplay/decision/journey modules loaded from the attested historical engine tree';
  result.source_assessment=assessment;result.trace=trace;
  result.observed_killer=trace.messages.map(m=>/You are dead, poor soul.*revenge on (?:the |an? )?(.+?)!/i.exec(m.text)?.[1]).find(Boolean)??null;
 }catch(e){error=e.message;result={outcome:'error',error,trace};}
 finally{clearInterval(timer);try{await adapter?.close();}catch(e){result??={};result.cleanup_error=e.message;} }
 process.send({result},()=>process.exit(0));
});
