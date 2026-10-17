import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {withMoveOrder,movementReport,recordMovementCancel} from './m59-move-origin.mjs';
import {prepareDeclaredJump,declaredJumpMoveOptions} from './m59-jump-takeoff.mjs';
import {selectDeclaredFall} from './m59-falljump.mjs';
const origin={source:'fleetscript',name:'walk-to-brax',run_id:'jump-owned'};
const source=readFileSync(new URL('./m59-keeper-process.mjs',import.meta.url),'utf8');
const block=source.slice(source.indexOf("case 'jump': {")+"case 'jump': {".length,source.indexOf('// SWING AT SOMETHING.',source.indexOf("case 'jump': {"))).trim().replace(/\}\s*$/,'');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const handler=new AsyncFunction('args','session','json','fallJumpsIn','selectDeclaredFall','declaredJumpMoveOptions','prepareDeclaredJump','asWalkOrder',block);
const declaration={from:{row:15,col:55},to:{row:8,col:55},from_fine:{x:55808,y:14848},to_fine:{x:55808,y:7680}};
let seen,postures=0,steps=0,cancel=false;
const client={selfId:1,self:{id:1,row:15,col:55,x:3552,y:992},room:{id:10},vitals:()=>({vigor:{value:52}})};
const session={client,movementGeneration:3,world:{room:{num:579},geometry:{declaredFallJumps:(r,c)=>r===15&&c===55?[declaration.to]:[],floorBaseAtClient:()=>8160}},need:()=>client,movementWasCancelled:g=>g!==session.movementGeneration,pacer:{holdStatus:()=>({active:false})},standBeforeGo:async()=>{postures++;assert.equal(movementReport(session).order?.origin.run_id,origin.run_id,'posture retains the same jump owner');client.lastPostureCommand={verb:'stand',room_object_id:10};},step:async()=>{steps++;seen=movementReport(session).order;assert.equal(seen?.origin.run_id,origin.run_id,'the actual native step must retain its script issuer');if(cancel){recordMovementCancel(session,{why:'ordinary recovery',origin:{source:'keeper',name:'shelter'}});session.movementGeneration++;return {moved:false,reason:'movement_cancelled'};}client.self={...client.self,row:8,y:544};return{moved:true};}};
const execute=async()=>{let reply;await handler({to_row:8,to_col:55,origin},session,r=>{reply=r},()=>[declaration],selectDeclaredFall,declaredJumpMoveOptions,prepareDeclaredJump,(args,to,fn)=>withMoveOrder(session,{kind:'walk',to,origin:args.origin},fn));return reply;};
let r=await execute();assert(r.jumped);assert.equal(steps,1);assert.equal(postures,1);assert.equal(movementReport(session).order,null);
client.self={id:1,row:15,col:55,x:3552,y:992};cancel=true;r=await execute();assert(!r.jumped);assert.equal(steps,2,'cancellation never redispatches the jump');assert.equal(movementReport(session).last_preempted.preempted.origin.run_id,origin.run_id);
const requests=[];const server=createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;requests.push(JSON.parse(raw));res.setHeader('content-type','application/json');res.end(JSON.stringify({result:{content:[{type:'text',text:'{"jumped":false}'}]}}));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try{process.env.M59_CONTROL_URL='http://127.0.0.1:'+server.address().port+'/';const {call,setCallOrigin}=await import('./m59-fleetscript.mjs');setCallOrigin(origin);await call('jump',{agent:'offline-test',to_row:8,to_col:55});const sent=requests.at(-1);assert.equal(sent.params.arguments.origin.run_id,origin.run_id,'public FleetScript jump carries its issuer');console.log('native jump owns posture and step; recovery records exact preempted run; one action only; public jump forwards origin');}finally{await new Promise(r=>server.close(r));}

const {braxActiveRecovery,readyAfterSurvival}=await import('./m59-brax.mjs');
const body=current=>({hp:{value:76,max:76},vigor:{value:52},autopilot_status:{survival_decisions:{current}}});
assert(!braxActiveRecovery(body({status:'yielded',strategy:'yield_to_controller'})));
assert(readyAfterSurvival(body({status:'yielded',strategy:'yield_to_controller'})));
assert(!braxActiveRecovery(body({status:'recovering',strategy:'logoff_safe',ended_at:123})));
assert(braxActiveRecovery(body({status:'recovering',strategy:'logoff_safe'})));
assert(!readyAfterSurvival(body({status:'recovering',strategy:'logoff_safe'})));
console.log('the actual full-76HP / 52-vigor yielded label is resumable; live recovery still blocks');

const brokerSource=readFileSync(new URL('./m59-broker.mjs',import.meta.url),'utf8').replace(/\r\n/g,'\n'),jumpTool=brokerSource.indexOf("    name: 'jump',"),runAt=brokerSource.indexOf('    run: async (a) => {',jumpTool),runEnd=brokerSource.indexOf('\n    },\n  },\n  {',runAt);
assert(runAt>jumpTool&&runEnd>runAt);
const brokerJump=new AsyncFunction('a','session','keeperAction',brokerSource.slice(runAt+'    run: async (a) => {'.length,runEnd));
let forwarded;const proxy={name:'offline-test',_index:3,client:{self:client.self},walkFine:()=>{}};
await brokerJump({agent:'offline-test',to_row:8,to_col:55,origin},()=>proxy,async(agent,index,name,args)=>{forwarded={agent,index,name,args};return{jumped:false};});
assert.equal(forwarded.args.origin.run_id,origin.run_id);assert.equal(forwarded.name,'jump');
console.log('actual keeper-backed broker jump forwards the exact script identity');
