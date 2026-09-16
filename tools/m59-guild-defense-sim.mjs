// Exploratory guild defense, isolated native Simulator only. Never calls production.
// Run one fresh Node process per trial; argument: count, armor, focus|split, output.
import fs from 'node:fs';
import path from 'node:path';
import {simulateScene, killPlayer} from './m59-fleetscript.mjs';
import {createShadowReplayAdapter} from './m59-shadow-replay.mjs';
import {dm,sendMsg,setProp,skillCmds,abilityIds,relocateFineCmd} from './m59-dm.mjs';
import {capturePlayerLoadout,restorePlayerLoadout} from './m59-scene-loadout.mjs';
import {readLive} from './m59-abilities.mjs';
import {readAdminObjects,readAdminRoom} from './m59-scene-admin.mjs';
import {resolveRoom} from './m59-scene.mjs';
import {prepareScene} from './m59-scene-staging.mjs';
import {loadMap,findPath} from './m59-map.mjs';
import {RoomGeometry} from './m59-roo.mjs';
import {guildPassage} from './m59-guild-passage.mjs';
import {resumeReplayJourney} from './m59-replay-journey.mjs';
const root=path.resolve('substrate/guild-defense');
const out=process.argv[2]??'castle-response.json',armor='ScaleArmor',tactic='focus',hallMode='owned-raided';
const count=20,horizonMs=630000;
const env={...process.env,M59_ADMIN_HOST:'127.0.0.1',M59_ADMIN_PORT:'17998'};
async function sceneDm(commands,options){
  const list=Array.isArray(commands)?commands:[commands],responses=[];
  for(let i=0;i<list.length;i+=16){const chunk=list.slice(i,i+16),response=await dm(chunk,options);
    if(!response.includes('System Status')||chunk.some(c=>!response.includes(c)))throw Error('incomplete setup command batch');
    responses.push(response);}
  return responses.join('\n');
}
const source=JSON.parse(fs.readFileSync(process.env.SIM_DEFENDERS??path.join(root,'defenders.json'))).filter(d=>d.actor);
const priority=['t5','t3','t2','t4','t1','t6',...source.map(d=>d.agent).filter(id=>!['t5','t3','t2','t4','t1','t6'].includes(id))];
const defenders=priority.slice(0,count).map(id=>source.find(d=>d.agent===id));
if(defenders.some(x=>!x)||count<1||count>20)throw Error('missing captured defender');
const f=v=>({v,how:'estimated'});
const pos=(row,col)=>f({row,col,x:col*64+32,y:row*64+32});
const vitals=(hp,mana=50)=>({hp:f({value:hp,max:hp}),mana:f({value:mana,max:mana}),vigor:f({value:200})});
const placements=[{row:10,col:28},{row:11,col:28},{row:12,col:28},{row:10,col:29},{row:11,col:29},{row:12,col:29}];
for(let row=6;row<=9;row++)for(let col=26;col<=30;col++)placements.push({row,col});
const actors=[{key:'self',name:'Observer',kind:'player',mine:true,at:pos(2,32),vitals:vitals(100),
  stats:f({might:50,intellect:50,stamina:50,agility:50,mysticism:50,aim:50,karma:0})},
  ...defenders.map((d,i)=>({key:d.agent,name:d.name,kind:'player',mine:false,at:pos(placements[i].row,placements[i].col),
    vitals:vitals(d.actor.vitals.hp.v.max,d.actor.vitals.mana.v.max),stats:d.actor.stats})),
  ...['raider1','raider2'].map((key,i)=>({key,name:key,kind:'player',mine:false,at:pos(11+i,16),vitals:vitals(100),
    stats:f({might:50,intellect:50,stamina:50,agility:50,mysticism:50,aim:50,karma:0})}))];
const scene={schema:'m59-scene/v1',name:'castle-victoria-response-20',room:{num:714,name:f("The Bookmaker's Guild House")},
  captured:{at:new Date().toISOString(),from:'explicit synthetic counterfactual based on captured production defenders'},actors,
  controller:{mode:'survive',policy:{defendAgainstPlayers:false}},
  assumptions:['Twenty guild defenders start in Upstairs in Castle Victoria (39); two raiders already inside the owned Bookmaker hall (714), beside its lever. Immediate response, no warning delay.',
    'Full HP and 200 vigor, light empty packs, fresh mundane gear, no enchantments or spells. Start rooms have no monsters; native road monsters remain.',
    'Defender attributes and skill percentages come from saved production captures. Weapons and armor are explicit preparation scenarios.',
    'All defenders focus raider1 then raider2, or split; raiders focus lowest-current-HP surviving defender. No human kiting.']};
const skillNames={'dodge':401,'parry':402,'assess':403,'block':404,'second wind':405,'disarm':406,'slash':421,'thrust':422,'fire':425,'punch':430,'kick':431,'brawling':450,'fencing':451,'mace fighting':452,'scimitar wielding':453,'hammer wielding':454,'axe wielding':455,'archery':456,'short sword fighting':457};
const teams={mode:'teams',assignments:Object.fromEntries(actors.map(a=>[a.key,a.mine?null:a.key.startsWith('raider')?'Raiders':'Defenders']))};
let timer,castleStage,done=false,lever=null,reading=false,roster=[],at=0,hall=null;
let autopilotFor,dropAutopilot;
const pilots=new Map(),journeys=[],dead=new Set(),ready=new Set(),last=new Map();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const summary={assumptions:scene.assumptions,loadouts:{},orders:[],trace:[],events:[],hall_trace:[],errors:[]};
const event=(kind,data={})=>{const row={ms:at?Date.now()-at:null,kind,...data};summary.events.push(row);console.log(JSON.stringify(row));};
const hallState=async()=>{const o=(await readAdminObjects([hall],{env}))[0];return {status:o.properties.pistatus?.value,owner:o.properties.poguild_owner?.value??null,conquerer:o.properties.poconquerer?.value??null,timer:o.properties.ptconquer?.value??null};};
const alive=a=>!dead.has(a.key)&&a.session.live&&a.session.world?.room?.num!==1&&(a.session.client?.vitals?.()?.health?.value??0)>0;
const snapshot=()=>roster.map(a=>({key:a.key,live:a.session.live,hp:a.session.client?.vitals?.()?.health?.value??null,room:a.session.world?.room?.num,
  row:a.session.client?.self?.row,col:a.session.client?.self?.col,combat:a.session.combat.status().state??null}));
async function stopResponders(){
  done=true;clearInterval(timer);
  for(const a of roster){a.session.combat.issue({action:'stop'});a.session.cancelMovement?.(null,'simulation complete');}
  for(const k of pilots.values())k.stop('simulation complete',{hard:true});
  await Promise.race([Promise.allSettled(journeys),sleep(12000)]);
  for(const a of roster)dropAutopilot?.(a.session.name);
  await castleStage?.cleanup();castleStage=null;
}
let adapter;
try {
  const report=await simulateScene({scene,configFile:path.resolve('substrate/replay-smoke-config.json'),trials:1,horizonMs,
    cases:[{id:scene.name,reload:{noMonsters:true,labScenery:true},pvp:{enabled:true,attackers:[],allow_approximate_player:true,guilds:teams}}],
    adapterFactory:async options=>{
      adapter=await createShadowReplayAdapter({...options,isolate:false});
      return {attest:adapter.attest,close:async()=>{try{await stopResponders();}finally{await adapter.close();}},run:async args=>{
        const r=await adapter.run({...args,sceneDm,shouldStop:()=>done,onStopping:async()=>{summary.hall_final=await hallState();await stopResponders();},onPrepared:async(s,k,staged,players)=>{
          roster=players.controlledActors();
          // The observer has no tactical inputs; only account-backed combatants act.
          k.loop=async()=>{};
          for(const a of roster){
            const id=a.session.client.selfId,raider=a.key.startsWith('raider');
            const d=defenders.find(d=>d.agent===a.key);
            const skills=raider?abilityIds('SKID').map(id=>[id,99]):d.actor.abilities.v.filter(x=>x.kind==='skill').map(x=>[skillNames[x.name],x.ability]);
            if(skills.some(([id,value])=>!id||!Number.isInteger(value)))throw Error('unmapped skill');
            await restorePlayerLoadout(id,{schema:'m59-player-loadout/v1',complete:true,gaps:[],items:[],
              skills:raider?[]:skills.map(([n,v])=>n*100+v),spells:[]},{env});
            if(raider)await dm(skillCmds(id,99,abilityIds('SKID')),{env});
            const weapon=count<=6?'Hammer':[['Hammer',454],['LongSword',451],['ShortSword',457],['Axe',455],['Mace',452]].sort((a,b)=>(skills.find(x=>x[0]===b[1])?.[1]??0)-(skills.find(x=>x[0]===a[1])?.[1]??0))[0][0];
            const equipment=raider?['Scimitar','Knightshield','PlateArmor']:[weapon,'Knightshield',...(armor==='none'?[]:[armor])];
            for(const cls of equipment){
              const made=await dm(['create object '+cls],{env});
              const item=Number(/Created object (\d+)/.exec(made)?.[1]);if(!item)throw Error('item create failed '+cls);
              await dm([sendMsg(id,'NewHold',{what:['OBJECT',item]}),sendMsg(id,'TryUseItem',{what:['OBJECT',item]})],{env});
            }
            const loadout=await capturePlayerLoadout(id,{env});
            if(!loadout.complete||equipment.some(cls=>!loadout.items.some(i=>i.class.toLowerCase()===cls.toLowerCase()&&i.equipped)))throw Error('gear did not equip');
            if((raider?loadout.skills.some(x=>Math.abs(x)%100!==99):skills.some(([id,v])=>!loadout.skills.some(x=>Math.floor(Math.abs(x)/100)===id&&Math.abs(x)%100===v)))||loadout.spells.length)throw Error('skill model mismatch');
            summary.loadouts[a.key]=loadout;
            console.log('prepared '+a.key);
            a.session.client.abilities.clear();await readLive(a.session);
            await a.session.pacer.submit('read',()=>a.session.client.requestInventory());
            await a.session.pacer.submit('read',()=>a.session.client.roomContents());
            // Restore ordinary hostility recognition on defenders; attackers keep scripted inputs.
            if(!raider)delete a.session.combat.pvpEligibility;
          }
          summary.verified_stats=(await readAdminObjects(roster.map(a=>a.session.client.selfId),{env})).map(o=>({id:o.id,hp:o.hp,stats:Object.fromEntries(['might','intellect','stamina','agility','mysticism','aim'].map(n=>[n,o.properties['pi'+n]?.value]))}));
          if(hallMode==='owned-raided'){
            hall=await resolveRoom(714,{env});const initial=await hallState();if(initial.owner!==null)throw Error('baseline hall occupied');
            const groups=players.receipt.guilds.groups,def=groups.find(g=>g.team==='Defenders');
            await dm(groups.map(g=>setProp(g.id,'piMature',0)),{env});
            await dm(def.members.slice(1).map(id=>sendMsg(def.id,'ChangeRank',{who:['OBJECT',id],promoter:['OBJECT',def.members[0]],newrank:['INT',3]})),{env});
            const resource=await dm(['create resource IsolatedDefenseFixture'],{env});const rid=Number(/(\d+)\s*\(dynamic\) = IsolatedDefenseFixture/.exec(resource)?.[1]);if(!rid)throw Error('fixture resource absent');
            await dm([sendMsg(hall,'ClaimGuildHall',{oGuild:['OBJECT',def.id],rep:['OBJECT',def.members[0]],password:['RESOURCE',rid]})],{env});
            for(const a of roster){await dm([relocateFineCmd(a.session.client.selfId,hall,actors.find(x=>x.key===a.key).at.v)],{env});
              await a.session.pacer.submit('read',()=>a.session.client.roomContents());}
            const leader=roster.find(a=>a.key==='raider1').session;
            await leader.pacer.submit('control',()=>leader.client.safety(false));
            await dm([sendMsg(hall,'TimeStampDoor'),...roster.filter(a=>a.key.startsWith('raider')).flatMap(a=>[1,2].map(n=>sendMsg(hall,'SomethingHitHotPlate',{what:['OBJECT',a.session.client.selfId],hpid:['INT',n]}))),
              ],{env});
            summary.owned_fixture=await hallState();if(summary.owned_fixture.status!==3||summary.owned_fixture.timer)throw Error('native owned hall fixture failed');
            lever=(await readAdminObjects([hall],{env}))[0].properties.poshield_lever?.value;
            if(!lever)throw Error('missing shield lever');
            summary.assumptions.push('Native mature guilds and rank-3 defenders. Raider legal-entry history is a setup fixture; raiders lower the shield through an ordinary activation packet after both rooms verify. Defenders must walk all roads and doors.');
          }
          const map=loadMap(),geometry=RoomGeometry.fromJSON(map.rooms[39].roo),spots=[];
          for(let row=7;row<=15;row+=2)for(let col=18;col<=24;col+=2)
            if(geometry.walkable(row,col)&&geometry.path(10,22,row,col).found)spots.push({row,col});
          if(spots.length!==20)throw Error('castle placement grid failed geometry validation');
          summary.route_plan=findPath(map,39,714);
          const castleActors=actors.filter(a=>!a.mine&&!a.key.startsWith('raider')).map((a,i)=>({...structuredClone(a),at:pos(spots[i].row,spots[i].col)}));
          castleStage=await prepareScene({...scene,name:'castle-response-defenders',room:{num:39},actors:castleActors},{env,dmFn:sceneDm,
            options:{noMonsters:true,labScenery:true},requireNativeHold:true,
            resolveActor:a=>roster.find(r=>r.key===a.key)?.session.client.selfId});
          if(!castleStage.loaded.ok)throw Error('Castle scene did not verify: '+JSON.stringify(castleStage.loaded));
          // Both rooms are independently verified before either side receives orders.
          staged.scene.actors=staged.scene.actors.filter(a=>!castleActors.some(d=>d.key===a.key));
          summary.castle_preparation=castleStage.receipt;
          for(const a of roster){await a.session.pacer.submit('read',()=>a.session.client.roomContents());await a.session.pacer.submit('read',()=>a.session.client.stats(1));}
          summary.castle_release=await castleStage.start();
          summary.start_positions=await readAdminObjects(roster.map(a=>a.session.client.selfId),{env});
          const castleRoom=await resolveRoom(39,{env});
          for(const a of roster){const actual=summary.start_positions.find(o=>o.id===a.session.client.selfId),want=a.key.startsWith('raider')?hall:castleRoom;
            if(actual.room_object!==want||a.session.world?.room?.num!==(a.key.startsWith('raider')?714:39))throw Error('split-room start did not verify '+a.key);}
          summary.room=await readAdminRoom(714,{env});
        },onStarted:async(s,k,players)=>{
          ({autopilotFor,dropAutopilot}=await import('./m59-autopilot.mjs'));
          at=Date.now();summary.started_at=new Date(at).toISOString();
          const raider=roster.find(a=>a.key==='raider1').session;
          await raider.pacer.submit('action',()=>raider.client.activate(lever));
          for(let i=0;i<15;i++){summary.raid_fixture=await hallState();if(summary.raid_fixture.status===1)break;await sleep(100);}
          if(summary.raid_fixture.status!==1||!summary.raid_fixture.timer)throw Error('raider activation did not start the native capture timer');
          event('raid_started',{defenders:20,defender_room:39,attackers:2,attacker_room:714});
          const trackHall=async()=>{
            if(reading||done)return;reading=true;
            try{const state=await hallState();summary.hall_trace.push({ms:Date.now()-at,...state});
              if(state.status===2||state.owner!==summary.owned_fixture.owner){summary.winner='raiders';summary.reason='native guild conquest';summary.resolved_ms=Date.now()-at;event('hall_conquered',state);done=true;}
              else if(state.status===3&&!roster.some(a=>a.key.startsWith('raider')&&alive(a))){summary.winner='defenders';summary.reason='shield raised and both attackers dead';summary.resolved_ms=Date.now()-at;event('hall_saved',state);done=true;}
            }catch(e){summary.errors.push(e.message);event('hall_read_error',{error:e.message});done=true;}finally{reading=false;}
          };
          let ticks=0,lastProgress=0,lastTrace=0;
          const tick=()=>{try{
            for(const a of roster)if(!dead.has(a.key)&&(a.session.world?.room?.num===1||a.session.client?.vitals?.()?.health?.value===0)){
              dead.add(a.key);a.session.cancelMovement?.(null,'simulation casualty');pilots.get(a.key)?.stop('simulation casualty',{hard:true});event('casualty',{actor:a.key,room:a.session.world?.room?.num});}
            const inHall=roster.filter(a=>alive(a)&&a.session.world?.room?.num===714);
            const liveDef=inHall.filter(a=>!a.key.startsWith('raider')&&ready.has(a.key));
            const liveRaid=inHall.filter(a=>a.key.startsWith('raider'));
            for(const a of [...liveRaid,...liveDef.filter(a=>!['t20','t21'].includes(a.key))]){
              const raider=a.key.startsWith('raider');
              const target=(raider?[...liveDef].sort((a,b)=>a.session.client.vitals().health.value-b.session.client.vitals().health.value):liveRaid)[0];
              if(!target){if(last.has(a.key)){a.session.combat.issue({action:'stop'});last.delete(a.key);}continue;}
              if(last.get(a.key)===target.key)continue;
              const receipt=a.session.combat.issue(killPlayer(target.session.client.me.name,{select_map:714,ttl_ms:horizonMs,stop_below:raider?0.05:0.45}));
              summary.orders.push({ms:Date.now()-at,actor:a.key,target:target.key,receipt});last.set(a.key,target.key);
            }
            if(Date.now()-lastTrace>=2000){lastTrace=Date.now();summary.trace.push({ms:Date.now()-at,actors:snapshot()});void trackHall();}
            if(Date.now()-lastProgress>=30000){lastProgress=Date.now();const rooms={};for(const a of roster.filter(a=>!a.key.startsWith('raider')&&alive(a))){const n=a.session.world?.room?.num;rooms[n]=(rooms[n]??0)+1;}event('progress',{rooms,casualties:[...dead]});
              fs.writeFileSync(path.join(process.env.SIM_ROUND_DIR??root,'latest-check-in.json'),JSON.stringify({started_at:summary.started_at,elapsed_ms:Date.now()-at,rooms,events:summary.events,hall:summary.hall_trace.at(-1),actors:snapshot()},null,2));}
          }catch(e){summary.errors.push(e.stack);event('tick_error',{error:e.message});done=true;}};
          timer=setInterval(tick,500);tick();
          for(const a of roster.filter(a=>!a.key.startsWith('raider'))){
            const pilot=autopilotFor(a.session);pilots.set(a.key,pilot);
            pilot.running=true;pilot.stopping=false;pilot.startedAt=Date.now();pilot.startWatchdog();
            const task=(async()=>{
              event('response_order',{actor:a.key});
              const result=await resumeReplayJourney(pilot,714,'guild defense response');
              event('journey_result',{actor:a.key,result});
              if(done||!alive(a)||!result?.arrived)return;
              event('hall_foyer_arrival',{actor:a.key});
              await guildPassage(pilot,3,()=>done||!alive(a));
              ready.add(a.key);event('inner_hall_arrival',{actor:a.key});
              if(['t20','t21'].includes(a.key)){
                const walked=await a.session.walkTo(a.key==='t21'?15:17,11,{maxSteps:50,hardCap:60});
                event('guard_lever_approach',{actor:a.key,result:walked});
                while(!done&&alive(a)){
                  const state=await hallState();
                  if(state.status===1){await a.session.pacer.submit('action',()=>a.session.client.activate(lever));await sleep(300);event('guard_lever_attempt',{actor:a.key,state:await hallState()});}
                  await sleep(1000);
                }
              }
            })().catch(e=>{event('response_stopped',{actor:a.key,error:e.message});});
            journeys.push(task);
          }
        }});
        clearInterval(timer);summary.final=summary.trace.at(-1);summary.casualties=[...dead];
        if(!summary.winner){summary.winner='unresolved';summary.reason='observation horizon ended';}
        r.team_experiment=summary;return r;
      }};
    }});
  if(summary.errors.length){report.completed=false;report.validation.status='invalid';report.error='experiment recorder failed';}
  fs.writeFileSync(path.resolve(root,out),JSON.stringify(report,null,2));
  console.log(JSON.stringify({file:out,completed:report.completed,winner:summary.winner??'unresolved',resolved_ms:summary.resolved_ms,
    final:summary.final?.actors.map(a=>({key:a.key,hp:a.hp,room:a.room})),errors:summary.errors,cleanup:report.runs[0]?.pvp?.cleanup}));
}catch(e){fs.writeFileSync(path.resolve(root,out),JSON.stringify({error:e.stack,report:e.report,team_experiment:summary},null,2));console.error(e.message);process.exitCode=1;}
finally{clearInterval(timer);}
process.exit(process.exitCode??0);
