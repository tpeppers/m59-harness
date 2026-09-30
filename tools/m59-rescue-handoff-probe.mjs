// Isolated native proof: use -> player trade -> recipient use -> two arrivals.
import fs from 'node:fs';
import path from 'node:path';
import {simulateScene} from './m59-fleetscript.mjs';
import {createShadowReplayAdapter} from './m59-shadow-replay.mjs';
import {dm,sendMsg,setProp} from './m59-dm.mjs';
import {resolveRoom} from './m59-scene.mjs';
import {readAdminObjects} from './m59-scene-admin.mjs';
import {rescueCapability,performRescue} from './m59-rescue.mjs';
import {handoffChalice} from './m59-rescue-handoff.mjs';
const output=process.argv[2];if(!output||fs.existsSync(output))throw Error('Supply a new report path');
const env={...process.env,M59_ADMIN_HOST:'127.0.0.1',M59_ADMIN_PORT:'17998'};
const f=v=>({v,how:'estimated'});
const actors=['self','giver','receiver'].map((key,i)=>({key,name:key,kind:'player',mine:i===0,
  at:f({row:7,col:18+i*2,x:(18+i*2)*64+32,y:7*64+32}),
  vitals:{hp:f({value:100,max:100}),mana:f({value:50,max:50}),vigor:f({value:200})},
  stats:f({might:50,intellect:50,stamina:50,agility:50,mysticism:50,aim:50,karma:0})}));
const scene={schema:'m59-scene/v1',name:'rescue-handoff',room:{num:39},actors,controller:{mode:'survive'}};
const evidence={events:[]};let adapter,roster,chalice,at;
const event=(actor,kind,data)=>evidence.events.push({ms:Date.now()-at,actor,kind,...data});
async function native(){return (await readAdminObjects([chalice,...roster.map(a=>a.session.client.selfId)],{env})).map(o=>({
  id:o.id,owner:o.properties.poowner?.value,charges:o.properties.pihits?.value,rescue_timer:o.properties.ptrescue?.value}));}
try{
 const report=await simulateScene({scene,configFile:path.resolve('substrate/replay-smoke-config.json'),trials:1,horizonMs:1000,
  cases:[{id:'pending-rescue-handoff',reload:{noMonsters:true,labScenery:true},pvp:{enabled:true,attackers:[],allow_approximate_player:true,
    guilds:{mode:'teams',assignments:Object.fromEntries(actors.map(a=>[a.key,'Defenders']))}}}],
  adapterFactory:async options=>{adapter=await createShadowReplayAdapter({...options,isolate:false});return {attest:adapter.attest,close:adapter.close,run:async args=>{
   const result=await adapter.run({...args,onPrepared:async(s,k,_staged,players)=>{
    k.loop=async()=>{};roster=players.controlledActors();const group=players.receipt.guilds.groups[0],hall=await resolveRoom(714,{env});
    await dm([setProp(group.id,'piMature',0)],{env});
    const resource=await dm(['create resource HandoffProbeFixture'],{env});
    const rid=Number(/(\d+)\s*\(dynamic\) = HandoffProbeFixture/.exec(resource)?.[1]);if(!rid)throw Error('fixture resource missing');
    await dm([sendMsg(hall,'ClaimGuildHall',{oGuild:['OBJECT',group.id],rep:['OBJECT',s.client.selfId],password:['RESOURCE',rid]})],{env});
    const made=await dm(['create object Chalice'],{env});chalice=Number(/Created object (\d+)/.exec(made)?.[1]);
    await dm([setProp(chalice,'piHits_init',3),setProp(chalice,'piHits',3),sendMsg(roster.find(a=>a.key==='giver').session.client.selfId,'NewHold',{what:['OBJECT',chalice]})],{env});
    for(const a of roster){const since=a.session.client.evSeq;await a.session.pacer.submit('read',()=>a.session.client.requestInventory());await a.session.client.waitFor({since,kinds:['inventory'],timeoutMs:1000});}
   },onStarted:async()=>{
    at=Date.now();const g=roster.find(a=>a.key==='giver').session,r=roster.find(a=>a.key==='receiver').session;
    evidence.before=await native();let sent;const sentPromise=new Promise(resolve=>{sent=resolve;});
    const pending=performRescue(g,await rescueCapability(g),{destination:714,onEvent:(kind,data)=>{event('giver',kind,data);if(kind==='rescue_sent')sent();}});
    await Promise.race([sentPromise,pending.then(()=>{throw Error('Rescue did not send');})]);
    evidence.handoff=await handoffChalice(g,r,chalice);evidence.after_trade=await native();
    const second=performRescue(r,await rescueCapability(r),{destination:714,onEvent:(kind,data)=>event('receiver',kind,data)});
    evidence.results=await Promise.all([pending,second]);evidence.after=await native();
    if(!evidence.results.every(x=>x.arrived)||evidence.after.find(o=>o.id===chalice)?.charges!==1)throw Error('handoff Rescue or reserve failed');
    evidence.final_charge_attempt=await performRescue(r,{kind:'chalice',item_id:chalice},{destination:39});
    if(!evidence.final_charge_attempt.refused)throw Error('final charge not refused');
    evidence.rooms=roster.map(a=>({key:a.key,room:a.session.world?.room?.num}));
   }});result.handoff_probe=evidence;return result;
  }};}});
 fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({completed:report.completed,evidence,cleanup:report.runs[0]?.pvp?.cleanup}));
}catch(e){fs.writeFileSync(output,JSON.stringify({error:e.stack,evidence,report:e.report},null,2));console.error(e.stack);process.exitCode=1;}
process.exit(process.exitCode??0);
