// Isolated native acceptance checks. All relocations are explicit test-fixture
// boundaries; the observed Rescue arrivals and refill actions use player packets.
import fs from 'node:fs';
import path from 'node:path';
import {simulateScene} from './m59-fleetscript.mjs';
import {createShadowReplayAdapter} from './m59-shadow-replay.mjs';
import {dm,sendMsg,setProp,spellCmds} from './m59-dm.mjs';
import {resolveRoom} from './m59-scene.mjs';
import {prepareScene} from './m59-scene-staging.mjs';
import {readAdminObjects} from './m59-scene-admin.mjs';
import {readLive} from './m59-abilities.mjs';
import {rescueCapability,performRescue,inspectChalice,rechargeChalice,travelRescueOption} from './m59-rescue.mjs';
const output=process.argv[2];if(!output||fs.existsSync(output))throw Error('Supply a new report path');
const env={...process.env,M59_ADMIN_HOST:'127.0.0.1',M59_ADMIN_PORT:'17998'};
const f=v=>({v,how:'estimated'}),pos=(row,col)=>f({row,col,x:col*64+32,y:row*64+32});
const self={key:'self',name:'RescueProbe',kind:'player',mine:true,at:pos(7,18),
  vitals:{hp:f({value:100,max:100}),mana:f({value:50,max:50}),vigor:f({value:200})},
  stats:f({might:50,intellect:50,stamina:50,agility:50,mysticism:50,aim:50,karma:100})};
const scene={schema:'m59-scene/v1',name:'rescue-native-acceptance',room:{num:39},
  actors:[self,{...structuredClone(self),key:'friend',name:'Friend',mine:false,at:pos(7,20)}],controller:{mode:'survive'}};
const evidence={phases:[],assumptions:['Native item/spell packets; separate forest refill fixture between trials. No combat in this mechanics probe.']};
let adapter,forest,chalice,spellId;
async function itemState(){const o=(await readAdminObjects([chalice],{env}))[0];return {id:o.id,charges:o.properties.pihits?.value,capacity:o.properties.pihits_init?.value};}
try{
 const report=await simulateScene({scene,configFile:path.resolve('substrate/replay-smoke-config.json'),trials:1,horizonMs:1000,
  cases:[{id:'rescue-and-refill',reload:{noMonsters:true,labScenery:true},pvp:{enabled:true,attackers:[],allow_approximate_player:true,
    guilds:{mode:'teams',assignments:{self:'Defenders',friend:'Defenders'}}}}],
  adapterFactory:async options=>{adapter=await createShadowReplayAdapter({...options,isolate:false});return {attest:adapter.attest,close:async()=>{await forest?.cleanup();await adapter.close();},run:async args=>{
   const result=await adapter.run({...args,onPrepared:async(s,k,_staged,players)=>{
    k.loop=async()=>{};const hall=await resolveRoom(714,{env}),group=players.receipt.guilds.groups[0];
    await dm([setProp(group.id,'piMature',0)],{env});
    const resource=await dm(['create resource RescueProbeFixture'],{env});
    const rid=Number(/(\d+)\s*\(dynamic\) = RescueProbeFixture/.exec(resource)?.[1]);if(!rid)throw Error('fixture resource missing');
    await dm([sendMsg(hall,'ClaimGuildHall',{oGuild:['OBJECT',group.id],rep:['OBJECT',s.client.selfId],password:['RESOURCE',rid]})],{env});
    s.rescueContext={enabled:true,guildHall:714,guildName:group.name,recharge:true};
    const made=await dm(['create object Chalice'],{env});chalice=Number(/Created object (\d+)/.exec(made)?.[1]);
    await dm([setProp(chalice,'piHits_init',3),setProp(chalice,'piHits',2),
      sendMsg(s.client.selfId,'NewHold',{what:['OBJECT',chalice]}),...spellCmds(s.client.selfId,99,[7])],{env});
    const emerald=Number(/Created object (\d+)/.exec(await dm(['create object Emerald'],{env}))?.[1]);
    await dm([sendMsg(s.client.selfId,'NewHold',{what:['OBJECT',emerald]})],{env});
    await s.pacer.submit('read',()=>s.client.requestInventory());await readLive(s);
    spellId=s.client.spells.find(sp=>String(s.client.rsc.get(sp.nameRsc)).toLowerCase()==='rescue')?.id;
    if(!spellId)throw Error('learned Rescue not verified');
   },onStarted:async(s)=>{
    evidence.before=await itemState();
    const option=await travelRescueOption(s,714);
    if(option?.kind!=='rescue'||option.capability.kind!=='chalice')throw Error('dynamic shortcut not selected');
    const first=await s.travel(714,{origin:{source:'operator',name:'rescue_probe'}});
    evidence.phases.push({kind:'chalice_rescue',result:first,state:await itemState()});
    if(!first.arrived||evidence.phases.at(-1).state.charges!==1)throw Error('Rescue or charge consumption failed');
    const reserve=await performRescue(s,option.capability,{destination:39});
    evidence.phases.push({kind:'final_charge_refused',result:reserve,state:await itemState()});
    if(!reserve.refused||evidence.phases.at(-1).state.charges!==1)throw Error('final charge was not protected');
    forest=await prepareScene({...scene,name:'refill-fixture',room:{num:587},actors:[{...self,at:pos(22,35)}]},
      {env,options:{noMonsters:true,labScenery:true},requireNativeHold:true,resolveActor:()=>s.client.selfId});
    await s.pacer.submit('read',()=>s.client.roomContents());await forest.start();
    const refill=await rechargeChalice(s);
    evidence.phases.push({kind:'forest_drop_pickup',result:refill,state:await itemState()});
    if(!refill.ok||evidence.phases.at(-1).state.charges!==3)throw Error('forest refill not verified');
    const spell=await performRescue(s,{kind:'spell',spell_id:spellId},{destination:714});
    evidence.phases.push({kind:'learned_rescue',result:spell});
    if(!spell.arrived)throw Error('learned Rescue failed');
   }});result.rescue_probe=evidence;return result;
  }};}});
 fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({completed:report.completed,evidence,cleanup:report.runs[0]?.pvp?.cleanup}));
}catch(e){fs.writeFileSync(output,JSON.stringify({error:e.stack,evidence,report:e.report},null,2));console.error(e.stack);process.exitCode=1;}
process.exit(process.exitCode??0);
