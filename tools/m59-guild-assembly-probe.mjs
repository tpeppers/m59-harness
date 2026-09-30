// Native five-body door/assembly check, with no enemy damage or production RPC.
import fs from 'node:fs';
import path from 'node:path';
import {simulateScene} from './m59-fleetscript.mjs';
import {createShadowReplayAdapter} from './m59-shadow-replay.mjs';
import {dm,setProp,sendMsg} from './m59-dm.mjs';
import {resolveRoom} from './m59-scene.mjs';
import {ensureReplayHallDoors,observedHallSection,defenseAssemblyPoint,recoverGuildPassage} from './m59-guild-defense-controller.mjs';
const output=process.argv[2];if(!output||fs.existsSync(output))throw Error('Supply a new report path');
const env={...process.env,M59_ADMIN_HOST:'127.0.0.1',M59_ADMIN_PORT:'17998'};
const f=v=>({v,how:'estimated'}),position=(row,col)=>f({row,col,x:col*64+32,y:row*64+32});
const actors=['self','t5','t9','t6','t4','t16'].map((key,i)=>({key,name:key,kind:'player',mine:i===0,
  at:i===0?position(1,32):position(2,27+i),
  vitals:{hp:f({value:100,max:100}),mana:f({value:50,max:50}),vigor:f({value:200})},
  stats:f({might:50,intellect:50,stamina:50,agility:50,mysticism:50,aim:50,karma:0})}));
const scene={schema:'m59-scene/v1',name:'five-defender-door-assembly',room:{num:714},actors,controller:{mode:'survive'}};
const evidence={events:[],assembly:[],inner:[],assumptions:['Five guild members start in the foyer. No combat; all movement and door opening use normal collision-checked player actions.']};
let adapter,roster;const began=Date.now();
const event=(actor,kind,data)=>{const e={actor,kind,ms:Date.now()-began,...data};evidence.events.push(e);console.log(JSON.stringify(e));};
async function all(tasks){const results=await Promise.allSettled(tasks);const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;}
try{
 const report=await simulateScene({scene,configFile:path.resolve('substrate/replay-smoke-config.json'),trials:1,horizonMs:1000,
  cases:[{id:'five-person-assembly',reload:{noMonsters:true,labScenery:true},pvp:{enabled:true,attackers:[],allow_approximate_player:true,
    guilds:{mode:'teams',assignments:Object.fromEntries(actors.map(a=>[a.key,'Defenders']))}}}],
  adapterFactory:async options=>{adapter=await createShadowReplayAdapter({...options,isolate:false});return {attest:adapter.attest,close:adapter.close,run:async args=>{
   const result=await adapter.run({...args,onPrepared:async(s,k,_staged,players)=>{
    k.loop=async()=>{};roster=players.controlledActors();const group=players.receipt.guilds.groups[0],hall=await resolveRoom(714,{env});
    await dm([setProp(group.id,'piMature',0),...group.members.slice(1).map(id=>sendMsg(group.id,'ChangeRank',
      {who:['OBJECT',id],promoter:['OBJECT',group.members[0]],newrank:['INT',3]}))],{env});
    const resource=await dm(['create resource AssemblyProbeFixture'],{env});
    const rid=Number(/(\d+)\s*\(dynamic\) = AssemblyProbeFixture/.exec(resource)?.[1]);if(!rid)throw Error('fixture resource missing');
    await dm([sendMsg(hall,'ClaimGuildHall',{oGuild:['OBJECT',group.id],rep:['OBJECT',s.client.selfId],password:['RESOURCE',rid]})],{env});
   },onStarted:async()=>{
    const indices={t5:0,t9:6,t6:5,t4:3,t16:10};
    for(const a of roster)ensureReplayHallDoors(a.session);
    await all(roster.map(async a=>{
      const pilot={s:a.session,note:(what,data)=>event(a.key,what,data)};
      await recoverGuildPassage(pilot,2,{onEvent:(kind,data)=>event(a.key,kind,data)});
      const square=defenseAssemblyPoint(indices[a.key]);
      const result=await a.session.walkTo(square.col,square.row,{maxSteps:30,hardCap:36});
      const body=a.session.client.self;
      evidence.assembly.push({actor:a.key,square,actual:{row:body.row,col:body.col},result,section:observedHallSection(a.session)});
      if(body.row!==square.row||body.col!==square.col||observedHallSection(a.session)!==2)throw Error('assembly square not reached '+a.key);
    }));
    await all(roster.filter(a=>a.key!=='t16').map(async a=>{
      await recoverGuildPassage({s:a.session,note:(what,data)=>event(a.key,what,data)},3,
        {onEvent:(kind,data)=>event(a.key,kind,data)});
      evidence.inner.push({actor:a.key,section:observedHallSection(a.session)});
      if(observedHallSection(a.session)!==3)throw Error('inner passage not reached '+a.key);
    }));
    evidence.reserve_section=observedHallSection(roster.find(a=>a.key==='t16').session);
    if(evidence.reserve_section!==2)throw Error('reserve moved into combat chamber');
   }});result.assembly_probe=evidence;return result;
  }};}});
 fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({completed:report.completed,
   assembled:evidence.assembly.length,inner:evidence.inner,reserve_section:evidence.reserve_section,cleanup:report.runs[0]?.pvp?.cleanup}));
}catch(e){fs.writeFileSync(output,JSON.stringify({error:e.stack,evidence,report:e.report},null,2));console.error(e.stack);process.exitCode=1;}
process.exit(process.exitCode??0);
