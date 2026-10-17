#!/usr/bin/env node
// Read-only queue diagnosis from cached keeper snapshots. Never forces a room read.
import {fileURLToPath} from 'node:url';
import {scanKeepers,identityOf,identityMismatch} from './m59-keeper.mjs';
export function railTrafficReport(states,{now=Date.now(),stallMs=3000}={}){
 const byBody=new Map(states.filter(s=>s.you).map(s=>[s.room?.num+':'+s.you.id,s.agent]));
 const actors=states.map(s=>{
  const r=s.movement?.rail,active=!!r&&!r.endedAt&&s.room?.num===r.room,blocked=r?.blockedBy;
  return {agent:s.agent,room:s.room?.num,position:s.you?{row:s.you.row,col:s.you.col,x:s.you.x,y:s.you.y}:null,
   active,phase:active?r.phase:null,aim:active?r.aim:null,totalAims:active?r.total_aims:null,
   movedAgoMs:active?Math.max(0,now-r.movedAt):null,stalled:active&&now-r.movedAt>=stallMs,
   blocker:active&&blocked!=null?byBody.get(s.room.num+':'+blocked)??null:null,
   blockedBodyId:active?blocked??null:null,reason:active?r.reason??null:null};
 });
 const byAgent=new Map(actors.map(a=>[a.agent,a])),queues=[];
 for(const a of actors.filter(a=>a.stalled)){
  let front=a,chain=[a.agent],termination;
  while(front.blocker){
   if(chain.includes(front.blocker)){chain.push(front.blocker);termination='cycle';break;}
   chain.push(front.blocker);front=byAgent.get(front.blocker);
   if(!front.stalled){termination=front.active?'moving-front':'stationary-front';break;}
  }
  termination??=front.blockedBodyId!=null?'outside-roster-body':'no-body-identified';
  queues.push({chain,termination,room:a.room});
 }
 return {at:now,moving:actors.filter(a=>a.active&&!a.stalled).length,stalled:actors.filter(a=>a.stalled).length,actors,queues};
}
export async function main(argv=process.argv.slice(2)){
 const i=argv.indexOf('--fleet'),fleet=i<0?process.env.M59_FLEET:argv[i+1];
 if(!fleet)throw Error('name the fleet with --fleet');
 const keepers=await scanKeepers({fleet}),states=await Promise.all([...keepers.values()].map(async k=>{
  const url=new URL('http://127.0.0.1:'+k.port+'/state');
  for(const [key,value]of Object.entries({agent:k.agent,character:k.character,keeper_pid:k.pid}))url.searchParams.set(key,String(value));
  const response=await fetch(url,{signal:AbortSignal.timeout(10000)}),s=await response.json();
  if(!response.ok||identityMismatch(k,identityOf(response.headers,s)))throw Error('keeper identity changed');return s;
 }));
 console.log(JSON.stringify(railTrafficReport(states),null,2));
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
