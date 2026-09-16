// Isolated native hall objective test; no production RPC or simulated damage.
import fs from 'node:fs';
import {ensureReplayHallDoors} from './m59-guild-defense-controller.mjs';
import path from 'node:path';
import {simulateScene} from './m59-fleetscript.mjs';
import {createShadowReplayAdapter} from './m59-shadow-replay.mjs';
import {dm,sendMsg,setProp,relocateFineCmd} from './m59-dm.mjs';
import {resolveRoom} from './m59-scene.mjs';
import {readAdminObjects} from './m59-scene-admin.mjs';
import {guildPassage,guildSection} from './m59-guild-passage.mjs';
const output=process.argv[2];
if(!output||fs.existsSync(output))throw Error('Supply a new output report path');
const env={...process.env,M59_ADMIN_HOST:'127.0.0.1',M59_ADMIN_PORT:'17998'};
const f=v=>({v,how:'estimated'}),at=(row,col)=>f({row,col,x:col*64+32,y:row*64+32});
const actors=[['self','Guard',2,32],['raider1','RaiderOne',11,16],['raider2','RaiderTwo',12,16]].map(([key,name,row,col])=>({key,name,kind:'player',mine:key==='self',at:at(row,col),
  vitals:{hp:f({value:100,max:100}),mana:f({value:50,max:50}),vigor:f({value:200})},
  stats:f({might:50,intellect:50,stamina:50,agility:50,mysticism:50,aim:50,karma:0})}));
const scene={schema:'m59-scene/v1',name:'guild-lever-native-objective',room:{num:714},actors,controller:{mode:'survive'}};
const fixture={mode:'teams',assignments:{self:'Defenders',raider1:'Raiders',raider2:'Raiders'}};
const evidence={assumptions:['Owned isolated hall, mature guilds. Native legal-entry events establish the post-tailgating fixture; the defender must walk every door.','No combat during this mechanics test. Lever uses ordinary client activation packets.']};
let hall,lever,raider,adapter;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const read=async()=>{const o=(await readAdminObjects([hall],{env}))[0];return {at:Date.now(),status:o.properties.pistatus?.value,owner:o.properties.poguild_owner?.value??null,conquerer:o.properties.poconquerer?.value??null,timer:o.properties.ptconquer?.value??null,delay_ms:o.properties.piconquer_delay?.value};};
const check=async status=>{for(let i=0;i<10;i++){const r=await read();if(r.status===status)return r;await sleep(100);}throw Error('hall did not reach status '+status);};
try{
 const report=await simulateScene({scene,configFile:path.resolve('substrate/replay-smoke-config.json'),trials:1,horizonMs:1000,
  cases:[{id:'lever-rescue',reload:{noMonsters:true,labScenery:true},pvp:{enabled:true,attackers:[],allow_approximate_player:true,guilds:fixture}}],
  adapterFactory:async options=>{adapter=await createShadowReplayAdapter({...options,isolate:false});return {attest:adapter.attest,close:adapter.close,run:async args=>{
   const result=await adapter.run({...args,onPrepared:async(s,k,staged,players)=>{
    k.loop=async()=>{};hall=await resolveRoom(714,{env});evidence.initial=await read();
    if(evidence.initial.owner!==null)throw Error('baseline hall already owned');
    const groups=players.receipt.guilds.groups,def=groups.find(g=>g.team==='Defenders');
    await dm(groups.map(g=>setProp(g.id,'piMature',0)),{env});
    const resource=await dm(['create resource IsolatedDefenseFixture'],{env});
    const rid=Number(/(\d+)\s*\(dynamic\) = IsolatedDefenseFixture/.exec(resource)?.[1]);if(!rid)throw Error('fixture resource missing');
    await dm([sendMsg(hall,'ClaimGuildHall',{oGuild:['OBJECT',def.id],rep:['OBJECT',s.client.selfId],password:['RESOURCE',rid]})],{env});
    evidence.owned=await check(3);if(evidence.owned.owner!==def.id)throw Error('ownership did not verify');
    const room=(await readAdminObjects([hall],{env}))[0];lever=room.properties.poshield_lever?.value;if(!lever)throw Error('missing shield lever');
    raider=players.controlledActors().find(a=>a.key==='raider1').session;
    // Claiming a native hall correctly ejects outsiders. Re-establish the explicit
    // intruder-inside fixture; the shared start barrier verifies these placements.
    for(const a of players.controlledActors()){
      await dm([relocateFineCmd(a.session.client.selfId,hall,actors.find(x=>x.key===a.key).at.v)],{env});
      await a.session.pacer.submit('read',()=>a.session.client.roomContents());
    }
    evidence.entry={defender:await dm([sendMsg(hall,'CanEnter',{who:['OBJECT',s.client.selfId]})],{env}),outsider:await dm([sendMsg(hall,'CanEnter',{who:['OBJECT',raider.client.selfId]})],{env})};
   },onStarted:async(s,k)=>{
    ensureReplayHallDoors(s); evidence.notes=[];const oldNote=k.note.bind(k);k.note=(what,detail)=>{const row={at:Date.now(),what,...detail};evidence.notes.push(row);console.log(JSON.stringify(row));return oldNote(what,detail);};
    const oldStep=s.step.bind(s);s.step=async(...args)=>{const result=await oldStep(...args);const c=s.client;const row={kind:'step',to:{col:args[0],row:args[1]},result,at:c?.self,invalidated:c?.room?.collisionInvalidated};evidence.notes.push(row);console.log(JSON.stringify(row));return result;};
    await raider.pacer.submit('control',()=>raider.client.safety(false));
    await raider.pacer.submit('action',()=>raider.client.activate(lever));await sleep(500);
    evidence.illegal_entry_attempt=await check(3);
    await dm([sendMsg(hall,'TimeStampDoor'),sendMsg(hall,'SomethingHitHotPlate',{what:['OBJECT',raider.client.selfId],hpid:['INT',1]}),
      sendMsg(hall,'SomethingHitHotPlate',{what:['OBJECT',raider.client.selfId],hpid:['INT',2]})],{env});
    evidence.legal_entry=await dm([sendMsg(hall,'ReqLegalEntry',{who:['OBJECT',raider.client.selfId]})],{env});
    await raider.pacer.submit('action',()=>raider.client.activate(lever));evidence.lowered=await check(1);
    if(!evidence.lowered.timer||evidence.lowered.delay_ms!==600000)throw Error('capture countdown missing');
    evidence.before={at:s.client.self,section:guildSection(s.client.self.row,s.client.self.col)};
    try{await guildPassage(k,3,()=>false);evidence.crossed=true;}
    catch(e){evidence.crossed=false;evidence.failure=e.message;}
    evidence.after={at:s.client.self,section:guildSection(s.client.self.row,s.client.self.col),messages:s.client.events.filter(e=>e.kind==='message').slice(-15)};
   }});result.lever_experiment=evidence;return result;
  }};}});
 fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({completed:report.completed,crossed:evidence.crossed,failure:evidence.failure,after:{section:evidence.after?.section,row:evidence.after?.at?.row,col:evidence.after?.at?.col},cleanup:report.runs[0]?.pvp?.cleanup}));
}catch(e){fs.writeFileSync(output,JSON.stringify({error:e.stack,evidence,report:e.report},null,2));console.error(e.message);process.exitCode=1;}
process.exit(process.exitCode??0);
