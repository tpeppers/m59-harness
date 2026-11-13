// Isolated memory/budget stress for the exact production fine-rail worker entry.
// Same payload and256MiBresource limit as cutFineRailAsync; no sockets or fleet.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Worker} from 'node:worker_threads';
import {loadMap} from '../../tools/m59-map.mjs';
import {RoomGeometry,clientToProtocol} from '../../tools/m59-roo.mjs';
import {assessPath} from './compare.mjs';
const map=loadMap(),geo=RoomGeometry.fromJSON(map.rooms[45].roo);geo.roomNum=45;
const clientFrom={x:53760,y:512},clientGoal={x:46080,y:64448};
const kod=p=>({x:clientToProtocol(p.x),y:clientToProtocol(p.y),row:Math.floor(clientToProtocol(p.y)/64),col:Math.floor(clientToProtocol(p.x)/64)});
const from=kod(clientFrom),goal=kod(clientGoal);
const bodyClient=geo.standPoint(4,53)??geo.standPoint(3,53);
if(!bodyClient)throw Error('No native footing for synthetic blocker');
const body={id:90002,...kod(bodyClient),flags:1};
const barriers=new Set(Array.from({length:geo.cols},(_,i)=>`40,${i+1}`));
const trials=[
 {id:'positive-entry-to-node',maxMs:4000,objects:[],threats:[],avoidSquares:new Set()},
 {id:'threat-priced-unblocked-entry-to-node',maxMs:4000,objects:[],threats:[body],threatWeight:12,threatRadius:8,avoidSquares:new Set()},
 {id:'blocked-threat-priced-entry-to-node',maxMs:4000,objects:[body],threats:[body],threatWeight:12,threatRadius:8,avoidSquares:barriers}
];
const report={format:'m59-fine-worker-memory/1',createdAt:new Date().toISOString(),room:45,
 scope:'Offline real production worker entry with identical IPC contract and256MiB heap cap. Synthetic stationary blocker and row barrier; no execution or survival claim.',
 inputs:{client:{from:clientFrom,goal:clientGoal,blocker:bodyClient},kod:{from,goal,blocker:body},barrierRow:40},trials:[]};
try{os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);}catch{}
for(const trial of trials.filter(t=>!process.argv[2]||t.id.includes(process.argv[2]))){
 const options={...trial,selfId:90001,allowBodyPrefix:false},began=performance.now();
 delete options.id;
 const worker=new Worker(new URL('../../tools/m59-fine-rail.mjs',import.meta.url),{
  execArgv:[],resourceLimits:{maxOldGenerationSizeMb:256},
  workerData:{kind:'m59-fine-rail/1',task:'cut',geometry:geo.toJSON({includeSurfaces:false,graphEntrySquares:[],edgeDirections:[]}),
   roomNum:45,stepMask:geo._stepMask??null,from,goal,options}});
 const result={id:trial.id,budgetMs:trial.maxMs,resourceLimits:worker.resourceLimits,heapSamples:0,maxHeapUsed:0,maxHeapTotal:0,maxExternal:0};
 const sample=()=>worker.getHeapStatistics().then(s=>{result.heapSamples++;result.maxHeapUsed=Math.max(result.maxHeapUsed,s.used_heap_size??0);result.maxHeapTotal=Math.max(result.maxHeapTotal,s.total_heap_size??0);result.maxExternal=Math.max(result.maxExternal,s.external_memory??0);}).catch(()=>{});
 const timer=setInterval(sample,100);worker.once('online',sample);
 let message=null;
 await new Promise(resolve=>{
  worker.once('message',value=>{message=value;});
  worker.once('error',error=>{result.error={code:error.code,name:error.name,message:error.message};});
  worker.once('exit',code=>{clearInterval(timer);result.exitCode=code;resolve();});
 });
 result.elapsedMs=performance.now()-began;result.processPeakRssKiB=process.resourceUsage().maxRSS;
 result.route=message?{ok:message.ok,bridgeOk:message.bridgeOk,partial:message.partial,source:message.source,why:message.why??message.reason,
  navmeshReason:message.navmesh_reason,visited:message.visited,waypoints:message.waypoints?.length,bodyObstacles:message.body_obstacles}:null;
 if(message?.ok&&message.bridgeOk&&!message.partial)result.proof=assessPath(geo,message.waypoints,clientFrom,clientGoal,
  {avoidSquares:[...trial.avoidSquares],obstacles:trial.objects.map(o=>({x:bodyClient.x,y:bodyClient.y}))});
 report.trials.push(result);console.log(JSON.stringify(result));
}
const out=path.resolve(`experiments/navmesh/worker-memory-${Date.now()}.json`);
fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');console.log('Saved '+out);
if(report.trials.some(t=>t.error||t.exitCode!==0))process.exitCode=1;
