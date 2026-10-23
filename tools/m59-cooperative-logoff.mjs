// Transport and execution only. Cooperative policy is an opt-in private strategy.
import {mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, openSync, closeSync, unlinkSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {OF} from './m59-parse.mjs';
import {withPacketScope} from './m59-packet-scope.mjs';
import {keeperOrigin, liveMoveOrder, withMoveOrder} from './m59-move-origin.mjs';
import {isActiveRecoveryDecision,currentSurvivalDecision} from './m59-survival-decision.mjs';
import * as party from './m59-party.mjs';
import {stationaryTradeActive} from './m59-stationary-trade.mjs';
const base = fileURLToPath(new URL('../substrate/cooperative-logoff/', import.meta.url));
const fold = x => String(x ?? '').trim().toLowerCase();
const hash = x => createHash('sha256').update(x).digest('hex');
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if(e.code==='ENOENT')return null; throw e; } };
const fresh = (p, now) => p && p.at <= now && now-p.at < 5000 && p.live && p.health?.value > 0;
const pending = r => r && ['preparing','offline','returning'].includes(r.state);
const position = p => p && !p.predicted && [p.x,p.y,p.row,p.col].every(Number.isFinite)
  ? {x:p.x,y:p.y,row:p.row,col:p.col} : null;

// The helper lends observations, never its body or command authority. Planning
// runs while the subject is offline; the subject claims and checks cover on return.
export function prepareCooperativeRefuge(pilot,request,{now=Date.now()}={}) {
  const s=pilot.s,c=s.client,geo=s.world?.geometry;
  if(!geo||typeof pilot.searchSafeSpot!=='function'||
    s.world.room.num!==request.room||c.room.id!==request.room_object||
    c.idsAsOf?.()?.last_save_at!==request.last_save_at)return null;
  const ghost=c.room.objects.get(request.body);
  if(ghost && fold(c.rsc.get(ghost.nameRsc))!==fold(request.character))return null;
  const from=position(ghost)??request.position;
  if(!from)return null;
  const projected=Object.create(pilot);
  projected.s={name:request.agent,client:{selfId:request.body,self:from,room:c.room,playersOnline:c.playersOnline},world:s.world};
  projected.policy={spotRule:request.spot_rule};
  // The helper's failed approaches are not failures by the offline subject.
  projected.spotExclusions=()=>null;
  const spot=pilot.searchSafeSpot.call(projected,geo,from,s.world.room,{within:Math.max(geo.rows,geo.cols)||64,
    los:request.los??0,quarry:null,stats:{},shareCap:1,exclusiveClaim:true,recovery:true});
  if(!spot)return null;
  return {at:now,by:s.name,room:request.room,room_object:request.room_object,last_save_at:request.last_save_at,
    roo:s.world.room.roo??null,from:{...from},subject_body:request.body,
    spot:{row:spot.row,col:spot.col,...(spot.fine?{fine:{...spot.fine}}:{}),steps_away:spot.steps_away??null}};
}
export function cooperativeReturnRefuge(session,{now=Date.now()}={}) {
  const r=session.cooperativeLogoffReturn,p=r?.refuge,c=session.client,me=position(c?.self);
  if(!p||!me||!session.live||c.combatReady!==true||now-p.at<0||now-p.at>30000||
    session.world?.room?.num!==p.room||c.room?.id!==p.room_object||
    c.idsAsOf?.()?.last_save_at!==p.last_save_at||(session.world.room.roo??null)!==p.roo||
    c.selfId!==p.subject_body||me.row!==p.from.row||me.col!==p.from.col||
    Math.hypot(me.x-p.from.x,me.y-p.from.y)>2)return null;
  return p.spot;
}
export function cooperativeStore(session, credentials=session.credentials, {directory=session.cooperativeLogoffDirectory??process.env.M59_COOPERATIVE_LOGOFF_DIR??base}={}) {
  if (!session.fleetStateFile || !credentials?.host || !credentials?.port || !session.name) return null;
  const scope=JSON.stringify([fold(resolve(session.fleetStateFile)),fold(credentials.host),Number(credentials.port)]);
  const dir=join(directory,hash(scope));
  const file=(kind,agent)=>join(dir,kind+'-'+hash(agent)+'.json');
  const write=(kind,agent,value)=>{mkdirSync(dir,{recursive:true});const path=file(kind,agent),tmp=path+'.'+process.pid+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(value));renameSync(tmp,path);return value;};
  const list=kind=>{try{return readdirSync(dir).filter(n=>n.startsWith(kind+'-')&&n.endsWith('.json')).map(n=>read(join(dir,n))).filter(Boolean);}catch(e){if(e.code==='ENOENT')return[];throw e;}};
  return {scope,dir,read:(kind,agent)=>read(file(kind,agent)),write,list,
    lock(room,run){mkdirSync(dir,{recursive:true});const path=join(dir,'room-'+room+'.lock');let fd;try{fd=openSync(path,'wx');}catch(e){if(e.code==='EEXIST')return null;throw e;}
      const token=randomUUID();
      try{writeFileSync(fd,JSON.stringify({pid:process.pid,process_started_at:Math.round(Date.now()-process.uptime()*1000),at:Date.now(),token}));return run();}
      finally{closeSync(fd);if(read(path)?.token===token)unlinkSync(path);}}};
}
export function normalizeCooperativeLogoff(answer) {
  if(answer?.enabled!==true)return null;
  const bounded=(key,min,max,otherwise)=>Number.isFinite(answer[key])?Math.max(min,Math.min(max,answer[key])):otherwise;
  return {enabled:true,helper_health:bounded('helper_health',.9,1,.95),danger_quiet_ms:bounded('danger_quiet_ms',1000,30000,3000),
    cooldown_ms:bounded('cooldown_ms',30000,300000,60000),attempt_ms:bounded('attempt_ms',1000,10000,6000)};
}
export function publishCooperativePresence(pilot,{now=Date.now()}={}) {
  if(!pilot._cooperativeLogoffConfig)return false;
  const s=pilot.s,c=s.client,store=cooperativeStore(s);if(!store)return false;
  if(now-(s._cooperativePublishedAt??0)<500)return false;
  const p={at:now,agent:s.name,pid:process.pid,character:c?.me?.name??s.credentials?.character,
    live:!!s.live&&c?.combatReady===true,body:c?.selfId,room:s.world?.room?.num,room_object:c?.room?.id,
    health:c?.vitals?.()?.health??null,enabled:true};
  store.write('presence',s.name,p);s._cooperativePublishedAt=now;return true;
}
export async function configureCooperativeLogoff(pilot,phase) {
  const s=pilot.s;if(typeof s._askStrategies!=='function')return null;
  const c=s.client,objects=[...(c?.room?.objects?.values?.()??[])];
  const fleetmates=objects.filter(o=>o.id!==c?.selfId&&(o.flags&OF.PLAYER)&&party.isFleetmate(c.rsc?.get(o.nameRsc)));
  const monsters=(pilot.inReachOfUs?.()??[]).filter(o=>(o.flags&OF.ATTACKABLE)&&!(o.flags&OF.PLAYER));
  const ctx={phase,agent:s.name,room:s.world?.room?.num,at_safe_spot:!!pilot.currentRecoveryWall?.(),
    fleetmates:fleetmates.map(o=>({id:o.id,character:c.rsc.get(o.nameRsc)})),monsters:monsters.map(o=>({id:o.id,name:c.rsc.get(o.nameRsc)}))};
  const got=await s._askStrategies('cooperativeLogoff',ctx);
  const config=normalizeCooperativeLogoff(got?.answer);
  if(phase==='helper')pilot._cooperativeLogoffConfig=config;
  if(config){pilot._cooperativeLogoffConfig=config;publishCooperativePresence(pilot);}
  return config?{config,ctx,monsters,fleetmates,strategy:got.strategy}:null;
}
// Serialize admission so the last available fleetmate cannot also go offline.
export function requestCooperativeLogoff(pilot,offered,{now=Date.now()}={}) {
  const s=pilot.s,c=s.client,store=cooperativeStore(s);if(!store||!s.live||!offered?.monsters.length)return null;
  return store.lock(s.world.room.num,()=>{
    const previous=store.read('request',s.name);
    if(pending(previous)||previous&&now-previous.created_at<offered.config.cooldown_ms)return null;
    const helpers=store.list('presence').filter(p=>p.agent!==s.name&&p.enabled&&fresh(p,now)&&p.room===s.world.room.num&&p.room_object===c.room.id&&
      !pending(store.read('request',p.agent))&&offered.fleetmates.some(o=>o.id===p.body&&fold(c.rsc.get(o.nameRsc))===fold(p.character)));
    if(!helpers.length)return null;
    const targets=offered.monsters.slice(0,16).map(o=>({id:o.id,name:c.rsc.get(o.nameRsc),name_rsc:o.nameRsc}));
    if(targets.length!==offered.monsters.length)return null;
    return store.write('request',s.name,{id:randomUUID(),agent:s.name,character:c.me?.name??s.credentials.character,state:'preparing',
      created_at:now,room:s.world.room.num,room_object:c.room.id,body:c.selfId,position:position(c.self),
      last_save_at:c.idsAsOf?.()?.last_save_at,spot_rule:pilot.policy?.spotRule??'wall',los:pilot.policy?.los??0,
      targets,helpers:helpers.map(p=>p.agent),receipts:{},strategy:offered.strategy});
  });
}
export function markCooperativeOffline(session) {
  const store=cooperativeStore(session),r=store?.read('request',session.name);
  if(r?.state==='preparing'){r.state='offline';r.offline_at=Date.now();store.write('request',session.name,r);}
}
export function cooperativeReconnectRefusal(session,credentials=session.credentials) {
  const store=cooperativeStore(session,credentials),r=store?.read('request',session.name);
  return pending(r)?{ok:false,reason_code:'cooperative_wait',request_id:r.id,
    note:'the current cooperative continuation owns login until distraction is confirmed'}:null;
}
export function abortPreparingCooperativeLogoff(session,id,reason) {
  const store=cooperativeStore(session),r=store?.read('request',session.name);
  if(session.live&&r?.id===id&&r.state==='preparing'){
    r.state='aborted';r.reason=reason;store.write('request',session.name,r);return true;
  }
  return false;
}
// No deadline can quietly change "not distracted" into "safe to log in".
// This gate also runs on keeper restart and broker rejoin, not just the initial call.
export async function cooperativeBeforeLogin(session,credentials,{wait=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}={}) {
  const store=cooperativeStore(session,credentials);if(!store)return;
  for(;;){
    const r=store.read('request',session.name);if(!pending(r))return;
    if(session.cooperativeLoginAllowed?.()===false)throw Error('cooperative login cancelled by keeper ownership');
    if(r.state==='preparing')throw Error('cooperative logoff has not confirmed socket departure');
    const receipts=Object.values(r.receipts??{});
    const valid=r.targets.every(t=>{
      const hit=r.receipts?.[t.id],p=hit&&store.read('presence',hit.helper);
      return hit?.request_id===r.id&&hit.hit_at>=r.offline_at&&hit.target_id===t.id&&hit.name===t.name&&
        now()-hit.hit_at<30000&&fresh(p,now())&&p.body===hit.helper_body&&p.room===r.room&&p.room_object===r.room_object&&!pending(store.read('request',hit.helper));
    });
    if(valid&&receipts.length){
      const permit=store.lock(r.room,()=>{const current=store.read('request',session.name);
        if(current?.id!==r.id||!['offline','returning'].includes(current.state))return false;
        current.state='returning';store.write('request',session.name,current);return true;});
      if(permit){session.cooperativeLogoffReturn={request_id:r.id,room:r.room,receipts,refuge:r.refuge??null,released_at:now()};return;}
    }else if(r.state==='returning'){
      store.lock(r.room,()=>{const current=store.read('request',session.name);if(current?.id===r.id&&current.state==='returning'){current.state='offline';store.write('request',session.name,current);}});
    }
    session.cooperativeLogoffWaiting={request_id:r.id,room:r.room,since:r.offline_at,waiting_ms:now()-r.offline_at,
      targets:r.targets.map(t=>({id:t.id,name:t.name,hit:!!r.receipts?.[t.id]})),stalled:now()-r.offline_at>30000};
    await wait(200);
  }
}
export function cooperativeAfterLogin(session) {
  const store=cooperativeStore(session),id=session.cooperativeLogoffReturn?.request_id;
  if(!store||!id)return;
  const r=store.read('request',session.name);
  // The admission lock made returning requester-owned. Helpers never write a
  // returning record, so post-login completion cannot race their old cleanup.
  if(r?.id===id&&r.state==='returning'){r.state='resumed';r.resumed_at=Date.now();store.write('request',session.name,r);}
  session.cooperativeLogoffWaiting=null;
}
export function cooperativeHelperReady(pilot,config,{now=Date.now(),during=false,requestId=null}={}) {
  const s=pilot.s,c=s.client,h=c?.vitals?.()?.health,v=c?.vitals?.()?.vigor;
  const movement=liveMoveOrder(s),ownApproach=during&&movement?.origin?.source==='keeper'&&movement.origin.name==='cooperative_distraction'&&movement.origin.run_id===requestId;
  if(!s.live||c?.combatReady!==true||!['farm','idle'].includes(pilot.mode)||pilot.stopping||pilot.inert||pilot.operatorSurvivalStandDown?.()||stationaryTradeActive(s)||s.combat?.active||s.job&&!s.job.done||
    movement&&!ownApproach||s._rite||pilot.checkFreeze?.()||pilot.keeperRecoveryTravel||s.keeperRecoveryTravel||
    isActiveRecoveryDecision(currentSurvivalDecision(s))||!(h?.max>0)||h.value/h.max<(during?pilot.safety?.().fleeAt??.9:config.helper_health)||
    typeof pilot.facultyHeld!=='function'||['work','movement','combat','survival','recovery'].some(k=>pilot.facultyHeld(k)))return false;
  if(!during&&(pilot.inflight||[...(pilot.stageInFlight?.keys?.()??[])].some(k=>k!=='passCooperative')||now-(s.damagedAt??0)<config.danger_quiet_ms||pilot.threat?.()?.landing>0||
    (v?.value??0)<(pilot.fightFloor?.()??0)))return false;
  return true;
}
export async function cooperativeAssist(pilot,{now=Date.now}={}) {
  const offered=await configureCooperativeLogoff(pilot,'helper');if(!offered)return false;
  const {config}=offered,s=pilot.s,store=cooperativeStore(s);if(!store||!cooperativeHelperReady(pilot,config,{now:now()}))return false;
  const c=s.client,room=s.world.room.num;
  const requests=store.list('request').filter(r=>r.state==='offline'&&now()-r.offline_at>=800&&now()-(r.last_attempt_at??0)>=2000&&r.room===room&&r.room_object===c.room.id&&r.helpers.includes(s.name)).sort((a,b)=>a.created_at-b.created_at);
  for(const request of requests){
    const target=request.targets.find(t=>!request.receipts?.[t.id]||now()-request.receipts[t.id].hit_at>=30000);
    if(!target)continue;
    const object=c.room.objects.get(target.id);
    if(!object||object.nameRsc!==target.name_rsc||c.rsc.get(object.nameRsc)!==target.name||!(object.flags&OF.ATTACKABLE)||(object.flags&OF.PLAYER))continue;
    const lock=store.lock(room,()=>{const r=store.read('request',request.agent);if(r?.id!==request.id||r.state!=='offline'||r.claim&&r.claim.until>now())return null;
      r.claim={helper:s.name,token:randomUUID(),until:now()+config.attempt_ms+4000};store.write('request',r.agent,r);return r.claim;});
    if(!lock)continue;
    const generation=s.movementGeneration,save=c.idsAsOf?.()?.last_save_at;
    // Do the expensive room search before the distracting swing releases login.
    // A failure here withholds only the hint, never the ordinary distraction.
    try{
      const refuge=prepareCooperativeRefuge(pilot,request,{now:now()});
      if(refuge)store.lock(room,()=>{const r=store.read('request',request.agent);
        if(r?.id===request.id&&r.state==='offline'&&r.claim?.token===lock.token){r.refuge=refuge;store.write('request',r.agent,r);}});
    }catch(e){pilot.note?.('cooperative refuge preparation unavailable',{request_id:request.id,why:e.message});}
    let active=true,result=null;const previousDoing=pilot.doing;
    const acknowledge=hit=>{
      if(hit?.target_id!==target.id||!(hit.landed_hits>0)||s.client!==c||!s.live||s.movementWasCancelled?.(generation)||s.world.room.num!==room||c.room.id!==request.room_object||c.idsAsOf?.()?.last_save_at!==save||!(c.vitals()?.health?.value>0))return;
      s._cooperativePublishedAt=0;publishCooperativePresence(pilot,{now:now()});
      store.lock(room,()=>{const r=store.read('request',request.agent);if(r?.id!==request.id||r.state!=='offline'||r.claim?.token!==lock.token)return;
        r.receipts[target.id]={request_id:r.id,target_id:target.id,name:target.name,helper:s.name,helper_body:c.selfId,hit_at:now(),landed_hits:hit.landed_hits};store.write('request',r.agent,r);});
    };
    const guard=kind=>{if(!active||s.client!==c||s.world.room.num!==room||c.room.id!==request.room_object||s.movementWasCancelled?.(generation)||
      c.idsAsOf?.()?.last_save_at!==save||kind!=='read'&&!cooperativeHelperReady(pilot,config,{now:now(),during:true,requestId:request.id}))throw Error('cooperative distraction preempted');
      const current=store.read('request',request.agent);if(current?.id!==request.id||!['offline','returning','resumed'].includes(current.state)||kind!=='read'&&current.state!=='offline'||current.claim?.token!==lock.token||current.claim.until<=now())throw Error('cooperative distraction claim expired');
      if(kind!=='read'){const o=c.room.objects.get(target.id);if(!o||o.nameRsc!==target.name_rsc||(o.flags&OF.PLAYER))throw Error('cooperative quarry changed');}};
    try{
      pilot.doing='fighting';
      pilot.note?.('cooperative distraction started',{request_id:request.id,for:request.agent,target_id:target.id,target:target.name});
      result=await withMoveOrder(s,{kind:'cooperative',to:target.id,generation,origin:keeperOrigin('cooperative_distraction',{run_id:request.id})},
        ()=>withPacketScope(guard,()=>pilot.fightNow({target:target.name,exactTargetId:target.id,preferId:target.id,rounds:1,swingsPerRound:1,
          disengageAt:pilot.safety?.().fleeAt??.9,loot:false,equip:false,controlToken:lock.token,onLandedHit:acknowledge})));
      if(result?.target_id===target.id&&result.killed)pilot.recordCooperativeKill?.(result,request);
      acknowledge(result);
    }catch(e){pilot.note?.('cooperative distraction deferred',{request_id:request.id,why:e.message});}
    finally{active=false;if(pilot.doing==='fighting'&&!s.combat?.active)pilot.doing=previousDoing;
      store.lock(room,()=>{const r=store.read('request',request.agent);if(r?.id===request.id&&r.state==='offline'&&r.claim?.token===lock.token){delete r.claim;r.last_attempt_at=now();store.write('request',r.agent,r);}});}
    pilot.note?.('cooperative distraction result',{request_id:request.id,target_id:target.id,landed_hits:result?.landed_hits??0});
    return true;
  }
  return false;
}
