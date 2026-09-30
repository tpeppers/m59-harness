// Exploratory guild defense, isolated native Simulator only. Never calls production.
// Run one fresh Node process per trial; argument: output report path.
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
import {ensureReplayHallDoors,respondWithRecovery,observedHallSection,
  defenseAssemblyPoint,recoverGuildPassage,withHallObjective} from './m59-guild-defense-controller.mjs';
import {rescueCapability,performRescue} from './m59-rescue.mjs';
import {handoffChalice} from './m59-rescue-handoff.mjs';
import {RESCUE_CARRIERS,RESCUE_RELAYS,RESCUE_RESPONDERS,RUNNER_SPACING_MS,rescueDefenseDecision} from './m59-rescue-defense.mjs';
const root=path.resolve('substrate/guild-defense');
const out=process.argv[2]??'castle-response.json',armor='ScaleArmor',tactic='focus',hallMode='owned-raided';
const count=20,horizonMs=900000;
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
    'Full HP and 200 vigor, light packs, fresh mundane gear, no enchantments or learned spells. Start rooms have no monsters; native road monsters remain. Floyd and Bunsen each have one 3/3 Chalice of the Rain.',
    'Defender attributes and skill percentages come from saved production captures. Weapons and armor are explicit preparation scenarios.',
    'Combat responders focus raider1 then raider2. Raiders hold the inner room, target its lowest-current-HP defender, and contest the shield lever after a defender raises it. No human kiting.',
    'At 8:00 Floyd and Bunsen drink, then gift their chalices to Janice and Statler who also drink. The four Rescue responders stay in Castle Victoria until then; sixteen road responders start immediately. Each chalice retains its final charge.',
    'Two foyer arrivals start corridor assembly. From 8:00 at least four staged defenders, including every living Rescue responder, breach for the lever. The quorum falls to two at 9:15 and one at 9:30 to avoid waiting through conquest. Every arrival prioritizes a shield reset before fighting, including Floyd. Sacrificial resets are permitted.',
    'Both teams briefly stop combat and defer automatic retaliation while moving to and activating the lever. Native incoming damage remains active; prior combat eligibility is restored afterward. This prevents combat body ownership from blocking an objective action.',
    `Road launch spacing: ${RUNNER_SPACING_MS}ms. Orders are issued immediately; scheduled releases, first observed motion and castle exits are recorded separately.`,
    'Fifteen-minute observation permits a contested shield reset to be observed. Ownership held at the horizon with living raiders is unresolved, not a victory.']};
const skillNames={'dodge':401,'parry':402,'assess':403,'block':404,'second wind':405,'disarm':406,'slash':421,'thrust':422,'fire':425,'punch':430,'kick':431,'brawling':450,'fencing':451,'mace fighting':452,'scimitar wielding':453,'hammer wielding':454,'axe wielding':455,'archery':456,'short sword fighting':457};
const teams={mode:'teams',assignments:Object.fromEntries(actors.map(a=>[a.key,a.mine?null:a.key.startsWith('raider')?'Raiders':'Defenders']))};
let timer,castleStage,done=false,lever=null,reading=false,roster=[],at=0,hall=null;
let autopilotFor,dropAutopilot,HANDLED,CONTINUE;
const pilots=new Map(),journeys=[],dead=new Set(),ready=new Set(),last=new Map();
const foyer=new Set(),stagedDef=new Set(),chalices=new Map();
const rescueResults=new Map(),motionSeen=new Set(),exitSeen=new Set();
const leverRuns=new Set();
let breached=false,assemble=false,leverBusy=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const summary={assumptions:scene.assumptions,loadouts:{},orders:[],trace:[],events:[],hall_trace:[],errors:[]};
const event=(kind,data={})=>{const row={ms:at?Date.now()-at:null,kind,...data};summary.events.push(row);console.log(JSON.stringify(row));};
const hallState=async()=>{const o=(await readAdminObjects([hall],{env}))[0];return {status:o.properties.pistatus?.value,owner:o.properties.poguild_owner?.value??null,conquerer:o.properties.poconquerer?.value??null,timer:o.properties.ptconquer?.value??null};};
const alive=a=>!dead.has(a.key)&&a.session.live&&a.session.world?.room?.num!==1&&(a.session.client?.vitals?.()?.health?.value??0)>0;
const formation=()=>rescueDefenseDecision(roster.filter(a=>!a.key.startsWith('raider')).map(a=>({
  key:a.key,alive:alive(a),foyer:foyer.has(a.key)&&a.session.world?.room?.num===714,
  staged:stagedDef.has(a.key)&&a.session.world?.room?.num===714})),{breached,elapsedMs:Date.now()-at});
const inInner=a=>(observedHallSection(a.session)??-1)>=3;
async function waitUntil(predicate,a){while(!done&&alive(a)&&!predicate())await sleep(200);return !done&&alive(a);}
const nearLever=a=>{
  const object=a.session.client.room?.objects?.get(lever),me=a.session.client.self;
  return object&&me&&[object.row,object.col,me.row,me.col].every(Number.isFinite)
    &&Math.max(Math.abs(object.row-me.row),Math.abs(object.col-me.col))<=1;
};
async function withLeverControl(a,operation){
  if(leverRuns.has(a.key))return operation();
  leverRuns.add(a.key);last.delete(a.key);
  event('lever_control_acquired',{actor:a.key});
  try{return await withHallObjective(a.session,operation);}
  finally{leverRuns.delete(a.key);event('lever_control_released',{actor:a.key});}
}
async function contestLever(a,raising){
  if(leverBusy||done||!alive(a))return;leverBusy=true;
  try{
    const state=await hallState();
    if(state.status!==(raising?1:3))return;
    if(!nearLever(a))return; // Native GuildLever.LEVER_RANGE is one square.
    await withLeverControl(a,async()=>{
      await a.session.pacer.submit('action',()=>{if(!done&&alive(a))a.session.client.activate(lever);});
      await sleep(250);
      event(raising?'guard_lever_attempt':'raider_lever_attempt',{actor:a.key,state:await hallState()});
    });
  }catch(e){event('lever_attempt_error',{actor:a.key,error:e.message});}
  finally{leverBusy=false;}
}
async function resetShield(a,raising=true){
 return withLeverControl(a,async()=>{
  // Reach an unoccupied adjacent square; never queue every body on one point.
  for(let attempt=0;attempt<4&&!done&&alive(a);attempt++){
    if(nearLever(a)){await contestLever(a,raising);return;}
    const c=a.session.client,object=c.room?.objects?.get(lever),me=c.self;
    if(!object||!me)return;
    const choices=[];
    for(let row=object.row-1;row<=object.row+1;row++)for(let col=object.col-1;col<=object.col+1;col++){
      if(row===object.row&&col===object.col)continue;
      if([...c.room.objects.values()].some(o=>o.id!==c.selfId&&o.row===row&&o.col===col))continue;
      if(a.session.world.geometry.path(me.row,me.col,row,col).found)choices.push({row,col});
    }
    choices.sort((x,y)=>Math.hypot(x.row-me.row,x.col-me.col)-Math.hypot(y.row-me.row,y.col-me.col));
    const square=choices[attempt%Math.max(1,choices.length)];if(!square)return;
    const result=await a.session.walkTo(square.col,square.row,{maxSteps:16,hardCap:20,
      beforeMutation:()=>{if(done||!alive(a))throw Error('lever run stopped');}});
    event('guard_lever_approach',{actor:a.key,square,result});
  }
  if(nearLever(a))await contestLever(a,raising);
 });
}
async function launchRelay(a){
  const receiver=roster.find(r=>r.key===RESCUE_RELAYS[a.key]);
  const stopped=()=>done||!alive(a);
  const record=(body,promise)=>promise.then(result=>{rescueResults.set(body.key,result);return result;},error=>{
    const result={arrived:false,error:error.message};rescueResults.set(body.key,result);return result;});
  let pending;
  try{
    const capability=await rescueCapability(a.session);if(!capability.available)throw Error(capability.reason);
    let notify;const sent=new Promise(resolve=>{notify=resolve;});
    pending=record(a,performRescue(a.session,capability,{destination:714,stopped,
      onEvent:(kind,data)=>{event(kind,{actor:a.key,...data});if(kind==='rescue_sent')notify();}}));
    await Promise.race([sent,pending.then(()=>{throw Error('Rescue ended before handoff');})]);
    const transfer=await handoffChalice(a.session,receiver.session,capability.item_id,{stopped:()=>stopped()||!alive(receiver)});
    event('chalice_handoff',{actor:a.key,receiver:receiver.key,...transfer});
    const other=await rescueCapability(receiver.session);if(!other.available)throw Error(other.reason);
    await Promise.all([pending,record(receiver,performRescue(receiver.session,other,{destination:714,
      stopped:()=>done||!alive(receiver),onEvent:(kind,data)=>event(kind,{actor:receiver.key,...data})}))]);
  }catch(e){
    event('relay_failed',{actor:a.key,receiver:receiver.key,error:e.message});
    if(!pending)rescueResults.set(a.key,{arrived:false,error:e.message});
    if(!rescueResults.has(receiver.key))rescueResults.set(receiver.key,{arrived:false,error:e.message});
    await pending;
  }
}
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
        const r=await adapter.run({...args,sceneDm,shouldStop:()=>done,onStopping:async()=>{
          summary.hall_final=await hallState();
          summary.chalices_final=(await readAdminObjects([...chalices.values()],{env})).map(o=>({
            initial_actor:[...chalices].find(([,id])=>id===o.id)?.[0],
            actor:roster.find(a=>a.session.client.selfId===o.properties.poowner?.value)?.key??null,
            id:o.id,charges:o.properties.pihits?.value,capacity:o.properties.pihits_init?.value}));
          summary.stopping_snapshot={ms:Date.now()-at,actors:snapshot()};
          await stopResponders();
        },onPrepared:async(s,k,staged,players)=>{
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
            if(RESCUE_CARRIERS.includes(a.key)){
              const made=await dm(['create object Chalice'],{env});
              const item=Number(/Created object (\d+)/.exec(made)?.[1]);if(!item)throw Error('chalice create failed');
              await dm([setProp(item,'piHits_init',3),setProp(item,'piHits',3),
                sendMsg(id,'NewHold',{what:['OBJECT',item]})],{env});
              chalices.set(a.key,item);
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
            summary.assumptions.push('Native mature guilds and rank-3 defenders. Raider legal-entry history is a setup fixture; raiders lower the shield through an ordinary activation packet after both rooms verify. Road responders walk all roads and doors; Rescue uses normal item packets and lands in the foyer.');
            for(const a of roster.filter(a=>!a.key.startsWith('raider')))
              a.session.rescueContext={enabled:true,guildHall:714,guildName:def.name,recharge:true};
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
          summary.chalices_initial=(await readAdminObjects([...chalices.values()],{env})).map(o=>({
            actor:[...chalices].find(([,id])=>id===o.id)?.[0],id:o.id,charges:o.properties.pihits?.value,capacity:o.properties.pihits_init?.value}));
          if(summary.chalices_initial.some(o=>o.charges!==3||o.capacity!==3))throw Error('chalice setup mismatch');
        },onStarted:async(s,k,players)=>{
          ({autopilotFor,dropAutopilot,HANDLED,CONTINUE}=await import('./m59-autopilot.mjs'));
          for(const a of roster)ensureReplayHallDoors(a.session);
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
            for(const a of roster)ensureReplayHallDoors(a.session);
            for(const a of roster)if(!dead.has(a.key)&&(a.session.world?.room?.num===1||a.session.client?.vitals?.()?.health?.value===0)){
              dead.add(a.key);a.session.cancelMovement?.(null,'simulation casualty');pilots.get(a.key)?.stop('simulation casualty',{hard:true});event('casualty',{actor:a.key,room:a.session.world?.room?.num});}
            const inHall=roster.filter(a=>alive(a)&&a.session.world?.room?.num===714);
            const exposedDef=inHall.filter(a=>!a.key.startsWith('raider')&&inInner(a));
            const liveDef=exposedDef.filter(a=>ready.has(a.key));
            const liveRaid=inHall.filter(a=>a.key.startsWith('raider'));
            for(const a of [...liveRaid,...liveDef.filter(a=>!['t20','t21'].includes(a.key))]){
              if(leverRuns.has(a.key))continue;
              const raider=a.key.startsWith('raider');
              const target=(raider?[...exposedDef].sort((a,b)=>a.session.client.vitals().health.value-b.session.client.vitals().health.value):liveRaid)[0];
              if(!target){if(last.has(a.key)){a.session.combat.issue({action:'stop'});last.delete(a.key);}continue;}
              if(last.get(a.key)===target.key)continue;
              const receipt=a.session.combat.issue(killPlayer(target.session.client.me.name,{select_map:714,ttl_ms:horizonMs,stop_below:raider?0.05:0.45}));
              summary.orders.push({ms:Date.now()-at,actor:a.key,target:target.key,receipt});last.set(a.key,target.key);
            }
            const gate=formation();
            if(!assemble&&gate.assemble){assemble=true;event('assembly_released',gate);}
            if(!breached&&gate.breach){breached=true;event('breach_released',gate);}
            if(Date.now()-lastTrace>=2000){lastTrace=Date.now();summary.trace.push({ms:Date.now()-at,actors:snapshot()});void trackHall();
              // Both teams can contest through ordinary activation while near the lever.
              const shield=summary.hall_trace.at(-1)?.status;
              const candidate=(shield===3?liveRaid:exposedDef).find(nearLever);
              if(candidate)void contestLever(candidate,shield===1);
              else if(shield===3&&liveRaid.length&&!liveRaid.some(a=>leverRuns.has(a.key))){
                const a=liveRaid[0];
                journeys.push(resetShield(a,false).catch(e=>event('raider_lever_approach_failed',{actor:a.key,error:e.message})));
              }
            }
            if(Date.now()-lastProgress>=30000){lastProgress=Date.now();const rooms={};for(const a of roster.filter(a=>!a.key.startsWith('raider')&&alive(a))){const n=a.session.world?.room?.num;rooms[n]=(rooms[n]??0)+1;}event('progress',{rooms,casualties:[...dead]});
              fs.writeFileSync(path.join(process.env.SIM_ROUND_DIR??root,'latest-check-in.json'),JSON.stringify({started_at:summary.started_at,elapsed_ms:Date.now()-at,rooms,events:summary.events,hall:summary.hall_trace.at(-1),actors:snapshot()},null,2));}
          }catch(e){summary.errors.push(e.stack);summary.winner='invalid';summary.reason='simulation controller observation failed';
            summary.resolved_ms=Date.now()-at;event('tick_error',{error:e.message});done=true;}};
          timer=setInterval(tick,500);tick();
          const starts=snapshot(),runnerKeys=defenders.map(d=>d.agent).filter(key=>!RESCUE_RESPONDERS.includes(key));
          const departureTimer=setInterval(()=>{
            if(done){clearInterval(departureTimer);return;}
            for(const a of roster.filter(a=>runnerKeys.includes(a.key)&&alive(a))){
              const initial=starts.find(x=>x.key===a.key),me=a.session.client?.self,room=a.session.world?.room?.num;
              if(!me||![me.row,me.col].every(Number.isFinite))continue;
              if(!motionSeen.has(a.key)&&(room!==initial.room||me.row!==initial.row||me.col!==initial.col)){
                motionSeen.add(a.key);event('runner_first_motion',{actor:a.key,room,row:me.row,col:me.col,sample_interval_ms:500});}
              if(!exitSeen.has(a.key)&&room!==39&&room!==1&&room!=null){exitSeen.add(a.key);event('runner_castle_exit',{actor:a.key,room,sample_interval_ms:500});}
            }
          },500);
          for(const a of roster.filter(a=>!a.key.startsWith('raider'))){
            const pilot=autopilotFor(a.session);pilots.set(a.key,pilot);
            pilot.running=true;pilot.stopping=false;pilot.startedAt=Date.now();pilot.startWatchdog();
            const task=(async()=>{
              event('response_order',{actor:a.key});
              let result;
              const carrier=RESCUE_RESPONDERS.includes(a.key);
              if(carrier){
                event('rescue_waiting',{actor:a.key});
                if(!await waitUntil(()=>formation().cast,a))return;
                if(RESCUE_CARRIERS.includes(a.key))journeys.push(launchRelay(a));
                if(!await waitUntil(()=>rescueResults.has(a.key),a))return;
                result=rescueResults.get(a.key);
              }else{
                const delay=runnerKeys.indexOf(a.key)*RUNNER_SPACING_MS;
                if(!await waitUntil(()=>Date.now()-at>=delay,a))return;
                event('runner_released',{actor:a.key,scheduled_ms:delay});
                result=await respondWithRecovery(pilot,714,{alive:()=>alive(a),stopped:()=>done,
                  handled:HANDLED,continueStage:CONTINUE,onEvent:(kind,data)=>event(kind,{actor:a.key,...data})});
              }
              event('response_result',{actor:a.key,result});
              if(done||!alive(a)||!result?.arrived)return;
              if(!await waitUntil(()=>observedHallSection(a.session)!=null,a))return;
              foyer.add(a.key);event('hall_foyer_arrival',{actor:a.key,method:carrier?'rescue':'road'});
              if(!await waitUntil(()=>assemble,a))return;
              const passageOptions={stopped:()=>done||!alive(a),
                onEvent:(kind,data)=>event(kind,{actor:a.key,...data})};
              await recoverGuildPassage(pilot,2,passageOptions);
              const square=defenseAssemblyPoint(defenders.findIndex(d=>d.agent===a.key));
              const parked=await a.session.walkTo(square.col,square.row,{maxSteps:30,hardCap:36,
                beforeMutation:()=>{if(done||!alive(a))throw Error('assembly stopped');}});
              event('assembly_parked',{actor:a.key,square,result:parked,
                at:{row:a.session.client?.self?.row,col:a.session.client?.self?.col}});
              if(observedHallSection(a.session)!==2)throw Error('assembly position left the corridor');
              stagedDef.add(a.key);event('corridor_arrival',{actor:a.key});
              if(!await waitUntil(()=>breached,a))return;
              await recoverGuildPassage(pilot,3,passageOptions);
              event('inner_hall_arrival',{actor:a.key});
              await resetShield(a);
              ready.add(a.key);
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
