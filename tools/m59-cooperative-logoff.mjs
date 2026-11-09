// Transport and execution only. Cooperative policy is an opt-in private strategy.
import {mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, openSync, closeSync, unlinkSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {OF} from './m59-parse.mjs';
import {withPacketScope} from './m59-packet-scope.mjs';
import {keeperOrigin, liveMoveOrder, withMoveOrder} from './m59-move-origin.mjs';
import {isActiveRecoveryDecision,currentSurvivalDecision} from './m59-survival-decision.mjs';
import {lineOfSight} from './m59-safespots.mjs';
import * as party from './m59-party.mjs';
import {stationaryTradeActive} from './m59-stationary-trade.mjs';
import {recordEvent} from './m59-ledger.mjs';
const base = fileURLToPath(new URL('../substrate/cooperative-logoff/', import.meta.url));
const fold = x => String(x ?? '').trim().toLowerCase();
const hash = x => createHash('sha256').update(x).digest('hex');
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if(e.code==='ENOENT')return null; throw e; } };
const fresh = (p, now) => p && p.at <= now && now-p.at < 5000 && p.live && p.health?.value > 0;
const cannotDistract = pilot => pilot.policy?.neverAttack === true || pilot.s.world?.room?.num === 552 &&
  pilot.policy?.molluskCoverRecovery === true && ['idle', 'survive'].includes(pilot.mode);
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
// WINDOWS WILL NOT REPLACE A FILE SOMEBODY ELSE HAS OPEN. renameSync over a target that another
// process is reading at that instant throws EPERM/EACCES/EBUSY, and here ~20 keeper processes read
// every request file twice a second (presence publication lists them all). Prod, 2026-11-01: 142
// orphaned `request-*.json.<pid>.<uuid>.tmp` files, each a write that never landed -- among them
// Robin's `offline` (00:03:02Z, markCooperativeOffline: the record stayed `preparing` for 4.5 hours
// with her out of the game) and Scooter's deadline `aborted` (04:41:13Z, exactly offline_at + 240 s:
// the release threw, the waiter died, and he stayed out for an hour). A short bounded retry is what
// every Windows writer of a shared file needs; a write that still fails throws, and every caller
// that owns a login now survives that (see cooperativeBeforeLogin).
const BUSY=new Set(['EPERM','EACCES','EBUSY']);
const pause=ms=>{try{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);}catch{}};
export function replaceFileSync(tmp,path,{rename=renameSync,attempts=8}={}){
  for(let i=0;;i++){
    try{rename(tmp,path);return;}
    catch(e){if(!BUSY.has(e.code)||i>=attempts-1){try{unlinkSync(tmp);}catch{}throw e;}pause(Math.min(100,5*2**i));}
  }
}
export function cooperativeStore(session, credentials=session.credentials, {directory=session.cooperativeLogoffDirectory??process.env.M59_COOPERATIVE_LOGOFF_DIR??base}={}) {
  if (!session.fleetStateFile || !credentials?.host || !credentials?.port || !session.name) return null;
  const scope=JSON.stringify([fold(resolve(session.fleetStateFile)),fold(credentials.host),Number(credentials.port)]);
  const dir=join(directory,hash(scope));
  const file=(kind,agent)=>join(dir,kind+'-'+hash(agent)+'.json');
  const write=(kind,agent,value)=>{mkdirSync(dir,{recursive:true});const path=file(kind,agent),tmp=path+'.'+process.pid+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(value));replaceFileSync(tmp,path,{rename:session.cooperativeRename??renameSync});return value;};
  const list=kind=>{try{return readdirSync(dir).filter(n=>n.startsWith(kind+'-')&&n.endsWith('.json')).map(n=>read(join(dir,n))).filter(Boolean);}catch(e){if(e.code==='ENOENT')return[];throw e;}};
  // EPERM on an exclusive create is a lock whose owner is deleting it right now (Windows keeps the
  // name until the last handle closes): busy, exactly like EEXIST, never an error. A held lock is
  // still never broken; the login gate no longer needs one to end a stuck record (gateStep).
  const open=path=>{try{return openSync(path,'wx');}catch(e){if(e.code==='EEXIST'||BUSY.has(e.code))return null;throw e;}};
  return {scope,dir,read:(kind,agent)=>read(file(kind,agent)),write,list,
    lock(room,run){mkdirSync(dir,{recursive:true});const path=join(dir,'room-'+room+'.lock');const fd=open(path);if(fd==null)return null;
      const token=randomUUID();
      try{writeFileSync(fd,JSON.stringify({pid:process.pid,process_started_at:Math.round(Date.now()-process.uptime()*1000),at:Date.now(),token}));return run();}
      finally{closeSync(fd);try{if(read(path)?.token===token)unlinkSync(path);}catch{}}}};
}
export function normalizeCooperativeLogoff(answer) {
  if(answer?.enabled!==true)return null;
  const bounded=(key,min,max,otherwise)=>Number.isFinite(answer[key])?Math.max(min,Math.min(max,answer[key])):otherwise;
  return {enabled:true,helper_health:bounded('helper_health',.9,1,.95),danger_quiet_ms:bounded('danger_quiet_ms',1000,30000,3000),
    cooldown_ms:bounded('cooldown_ms',30000,300000,60000),attempt_ms:bounded('attempt_ms',1000,10000,6000),
    // OPT-IN. Absent or null is no deadline at all, which is the behaviour this always had.
    max_offline_ms:answer.max_offline_ms>0?bounded('max_offline_ms',60000,1800000,null):null};
}
export function publishCooperativePresence(pilot,{now=Date.now()}={}) {
  if(!pilot._cooperativeLogoffConfig)return false;
  const s=pilot.s,c=s.client,store=cooperativeStore(s);if(!store)return false;
  // Station holders and passive Ocean support still publish their observations.
  const enabled=!cannotDistract(pilot)&&!pilot.needleHere?.(s.world?.room?.num);
  if(now-(s._cooperativePublishedAt??0)<500&&s._cooperativePublishedEnabled===enabled)return false;
  const p={at:now,agent:s.name,pid:process.pid,character:c?.me?.name??s.credentials?.character,
    live:!!s.live&&c?.combatReady===true,body:c?.selfId,room:s.world?.room?.num,room_object:c?.room?.id,
    health:c?.vitals?.()?.health??null,enabled};
  store.write('presence',s.name,p);s._cooperativePublishedAt=now;s._cooperativePublishedEnabled=enabled;
  // Presence is published by the watchdog every 500ms whatever the keeper is doing, including
  // fighting, so the gone observation rides on it: a helper busy in combat still reports.
  try{observeCooperativeTargets(pilot,{now,store});}catch(e){pilot.note?.('cooperative target observation unavailable',{why:e.message});}
  return true;
}

// A TARGET THAT IS GONE IS RESOLVED -- AND "GONE" IS EVIDENCE, NOT A DEADLINE.
//
// Measured on prod 2026-10-31: in a room with ~18 fleet farmers the captured monster is
// nearly always killed by somebody else before a helper gets its distraction swing in, so
// no hit receipt can ever be written and ~25 of ~30 play-deads in two hours waited offline
// for ever. A monster that no longer exists cannot be attacking anybody; what was missing was
// a way to SAY so that is as strict as a hit.
//
// So a 'gone' receipt is written only by a fleet-mate standing in the request's own room
// (same room number and room object, same save epoch), from its OWN live object list, after
// the target id has been absent from that list across repeated observations spanning at least
// GONE_MS with no gap longer than GONE_GAP_MS. One read is never enough; a read this helper
// could not make (not live, not combat-ready, not in that room, own body not in the list, a
// save in progress or a different save epoch) is never absence and restarts the clock. The id
// seen again deletes the receipt. The gate accepts it only while it is fresh and its writer's
// presence is fresh and in the room -- the same rules a hit receipt meets.
export const GONE_MS=15000, GONE_GAP_MS=3000, GONE_REFRESH_MS=5000;
export function observeCooperativeTargets(pilot,{now=Date.now(),store=cooperativeStore(pilot.s)}={}) {
  const s=pilot.s,c=s?.client;if(!store||!s?.name)return 0;
  const seen=s._cooperativeGoneSeen??=new Map(),ids=c?.idsAsOf?.()??null;
  const room=s.world?.room?.num,roomObject=c?.room?.id,objects=c?.room?.objects;
  const readable=!!s.live&&c.combatReady===true&&objects instanceof Map&&c.selfId!=null&&objects.has(c.selfId)&&
    ids?.saving!==true&&room!=null&&roomObject!=null&&!pending(store.read('request',s.name));
  const requests=readable?store.list('request').filter(r=>r.agent!==s.name&&['offline','returning'].includes(r.state)&&
    r.room===room&&r.room_object===roomObject&&(ids?.last_save_at??null)===(r.last_save_at??null)):[];
  const live=new Set();let wrote=0;
  for(const r of requests)for(const t of r.targets??[]){
    const key=r.id+':'+t.id;live.add(key);
    const present=objects.has(t.id),prior=seen.get(key);
    if(present){
      seen.delete(key);
      if(r.receipts?.[t.id]?.kind==='gone')wrote+=store.lock(room,()=>{const cur=store.read('request',r.agent);
        if(cur?.id!==r.id||cur.state!=='offline'||cur.receipts?.[t.id]?.kind!=='gone')return 0;
        delete cur.receipts[t.id];store.write('request',r.agent,cur);return 1;})?1:0;
      continue;
    }
    const continued=!!prior&&now>=prior.last&&now-prior.last<=GONE_GAP_MS;
    const since=continued?prior.since:now,n=continued?prior.n+1:1;
    seen.set(key,{since,last:now,n});
    const had=r.receipts?.[t.id];
    if(n<2||now-since<GONE_MS||had&&now-(had.kind==='gone'?had.at:had.hit_at)<(had.kind==='gone'?GONE_REFRESH_MS:30000))continue;
    wrote+=store.lock(room,()=>{const cur=store.read('request',r.agent);
      // Only an 'offline' record: 'returning' is requester-owned (see cooperativeAfterLogin).
      if(cur?.id!==r.id||cur.state!=='offline'||cur.room!==room||cur.room_object!==roomObject)return 0;
      const old=cur.receipts?.[t.id];if(old&&old.kind!=='gone'&&now-old.hit_at<30000)return 0;
      cur.receipts={...(cur.receipts??{}),[t.id]:{kind:'gone',request_id:cur.id,target_id:t.id,name:t.name,
        helper:s.name,helper_body:c.selfId,seen_absent_since:since,observations:n,at:now}};
      store.write('request',cur.agent,cur);return 1;})?1:0;
  }
  // An unreadable observation is never absence: it forgets every clock it could not continue.
  for(const key of [...seen.keys()])if(!live.has(key))seen.delete(key);
  return wrote;
}
export async function configureCooperativeLogoff(pilot,phase,{ includeOceanRanged = false } = {}) {
  const s=pilot.s;if(typeof s._askStrategies!=='function')return null;
  const c=s.client,objects=[...(c?.room?.objects?.values?.()??[])];
  const fleetmates=objects.filter(o=>o.id!==c?.selfId&&(o.flags&OF.PLAYER)&&party.isFleetmate(c.rsc?.get(o.nameRsc)));
  let monsters=(pilot.inReachOfUs?.()??[]).filter(o=>(o.flags&OF.ATTACKABLE)&&!(o.flags&OF.PLAYER));
  if (phase === 'request' && includeOceanRanged) {
    const ranged = oceanRockThreats(pilot, objects, { outsideMelee: true });
    monsters = [...new Map([...monsters, ...ranged].map(body => [body.id, body])).values()];
  } else if (phase === 'request' && monsters.length === 0) monsters = oceanRockThreats(pilot, objects);
  const ctx={phase,agent:s.name,room:s.world?.room?.num,at_safe_spot:!!pilot.currentRecoveryWall?.(),
    fleetmates:fleetmates.map(o=>({id:o.id,character:c.rsc.get(o.nameRsc)})),monsters:monsters.map(o=>({id:o.id,name:c.rsc.get(o.nameRsc)}))};
  const got=await s._askStrategies('cooperativeLogoff',ctx);
  const config=normalizeCooperativeLogoff(got?.answer);
  if(phase==='helper')pilot._cooperativeLogoffConfig=config;
  if(config){pilot._cooperativeLogoffConfig=config;publishCooperativePresence(pilot);}
  return config?{config,ctx,monsters,fleetmates,strategy:got.strategy}:null;
}

export function oceanRockThreats(pilot, objects, { outsideMelee = false } = {}) {
  const { client, world } = pilot.s;
  if (!['farm', 'idle', 'survive'].includes(pilot.mode) || pilot.policy?.molluskCoverRecovery !== true ||
      world?.room?.num !== 552 || client?.combatReady !== true) return [];
  const geo = world.geometry, self = position(client.self);
  if (!self || !geo?.collisionReady || !Number.isInteger(geo.security) ||
      typeof geo.inBounds !== 'function' || typeof geo.canMove !== 'function' ||
      client.room?.security !== geo.security || !geo.inBounds(self.row, self.col)) return [];

  // The Ocean's mollusks can throw rocks through a clear line up to ten squares away.
  // Require both LOS grids to agree because the server may use either.
  return objects.filter(body => {
    if (body.id === client.selfId || !(body.flags & OF.ATTACKABLE) || (body.flags & OF.PLAYER) ||
        fold(client.rsc?.get(body.nameRsc)) !== 'mollusk creature') return false;
    const at = position(body);
    if (!at || !geo.inBounds(at.row, at.col)) return false;
    const squared = (at.row - self.row) ** 2 + (at.col - self.col) ** 2;
    return squared <= 100 && (!outsideMelee || squared > 9) &&
      lineOfSight(geo, at.row, at.col, self.row, self.col) &&
      lineOfSight(geo, at.row, at.col, self.row, self.col, { fine: true });
  });
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
      targets,helpers:helpers.map(p=>p.agent),receipts:{},strategy:offered.strategy,
      // Carried on the request because the gate also runs on keeper restart and broker rejoin,
      // where the strategy that granted it is not asked again.
      max_offline_ms:Number.isFinite(offered.config.max_offline_ms)?offered.config.max_offline_ms:null});
  });
}
// A COOPERATIVE LOGOFF THAT NOBODY IS FINISHING MUST END BY ITSELF, AND SAY SO.
//
// Prod, 2026-11-01, two shapes, both with the character out of the game and nothing waiting:
//
//  A. STUCK IN `preparing`. Robin (t8): created 00:03:02Z, never `offline`, 4.5 hours out; Lew (t20)
//     05:20Z. markCooperativeOffline runs AFTER Session.rejoinConnection has destroyed the socket, and
//     its write failed (the rename above; the orphaned tmp holds the `offline` that never landed). It
//     threw out of the rejoin, abortPreparingCooperativeLogoff refused because the session was no
//     longer live, and from then on every login refused a `preparing` record: the in-process gate
//     threw "has not confirmed socket departure" and the keeper's /join and /rejoin answered 423 to
//     the broker's sweep every 45 s. Hand-marking the file `aborted` let the next sweep in.
//
//  B. `offline` PAST ITS DEADLINE. Scooter (t21): offline 04:37:13Z, max_offline_ms 240000. The
//     deadline release at 04:41:13Z threw on its write, the throw killed the waiter loop and with it
//     the join -- but `session.cooperativeLogoffWaiting` was never cleared, so the keeper reported
//     `cooperative_wait: true` for an hour and the broker's sweep (keeperCooperativeWait) stepped
//     over him. Hand-aborting the file changed nothing for exactly that reason; a keeper handoff did.
//
// So: a waiter that exits by throwing clears its flag; cooperative_wait is reported only while a
// login continuation actually exists (cooperativeWaitActive); the gate rides out store errors; a
// `preparing` record this session itself departed for is confirmed offline by the gate; and two
// bounds end a record nobody can finish -- PREPARING_MAX_MS after creation (the honest window is
// under a second) and max_offline_ms + OFFLINE_OVERRUN_MS after going offline (the waiter releases
// at max_offline_ms; past the margin it releases even if the record cannot be written). Every one
// of those is a `cooperative_logoff_recovered` ledger row naming what was done and why.
//
// None of this logs anybody in by itself. The gate runs only inside a login somebody asked for
// (Autopilot.reconnect, keeper startup, the broker's sweep via /join or /rejoin), and it still
// throws on `cooperativeLoginAllowed() === false` -- dormancy, a handoff, a leave, a stopping keeper
// -- before it decides anything. A human pilot is the broker's to honour: its sweep never posts
// /rejoin for a piloted character, and the keeper's /rejoin refuses while dormant.
export const PREPARING_MAX_MS=60000, OFFLINE_OVERRUN_MS=30000, STORE_FAILURE_MAX_MS=60000;
const continuation=session=>!!(session?.joining||session?.rejoinTask);
// What the keeper reports as `cooperative_wait`, which makes the broker's sweep step over it. True
// only while a login is actually in flight in this process and the gate has a waiting record.
export function cooperativeWaitActive(session) {
  return !!session?.cooperativeLogoffWaiting&&continuation(session);
}
export function stuckCooperativeLogoff(r,now=Date.now()) {
  if(!pending(r))return null;
  if(r.state==='preparing'){
    const age=Number.isFinite(r.created_at)?now-r.created_at:Infinity;
    return age>=PREPARING_MAX_MS?{reason_code:'preparing_timeout',age_ms:Number.isFinite(age)?age:null,
      why:`still preparing ${Number.isFinite(age)?Math.round(age/1000)+'s':'(no created_at)'} after the request; `+
        `the socket departure is never confirmed this late (bound ${PREPARING_MAX_MS/1000}s)`}:null;
  }
  const since=Number.isFinite(r.offline_at)?r.offline_at:r.created_at;
  if(!Number.isFinite(r.max_offline_ms)||!Number.isFinite(since))return null;
  const over=now-since-r.max_offline_ms;
  return over>=OFFLINE_OVERRUN_MS?{reason_code:'offline_overrun',overrun_ms:over,
    why:`${r.state} ${Math.round((now-since)/1000)}s, past max_offline_ms ${Math.round(r.max_offline_ms/1000)}s `+
      `by more than ${OFFLINE_OVERRUN_MS/1000}s; nothing released it`}:null;
}
// The ledger row, written against the CHARACTER (the ledger's key) even while it has no client.
export function noteCooperativeRecovery(session,detail,{credentials=session?.credentials}={}) {
  const who=session?.client?.me?.name??credentials?.character??session?.credentials?.character??session?.name;
  try{(session?.cooperativeRecordEvent??recordEvent)(who,'cooperative_logoff_recovered',{agent:session?.name,...detail});}catch{}
  try{console.error(`[cooperative] ${session?.name} ${detail?.action}: ${detail?.why??''}`);}catch{}
}
function abandonRecord(session,store,r,{reason_code,why},{now,by}) {
  let written=false,error=null;
  try{
    written=!!store.lock(r.room??'none',()=>{const cur=store.read('request',session.name);
      if(cur?.id!==r.id||!pending(cur))return false;
      Object.assign(cur,{state:'aborted',reason:reason_code,aborted_at:now,recovered_by:by,recovered_why:why});
      store.write('request',session.name,cur);return true;});
  }catch(e){error=e.message;}
  return {written,error};
}
const summary=r=>({request_id:r?.id??null,state_was:r?.state??null,created_at:r?.created_at??null,
  offline_at:r?.offline_at??null,max_offline_ms:r?.max_offline_ms??null,room:r?.room??null});
export function markCooperativeOffline(session,{now=Date.now()}={}) {
  // NEVER THROWS: the socket is already gone, and the join that follows is the only way back in.
  let store=null,r=null;
  try{store=cooperativeStore(session);r=store?.read('request',session.name);}
  catch(e){session.cooperativeDeparture={request_id:null,at:now,unread:e.message};return;}
  if(r?.state!=='preparing')return;
  // Remembered in memory too, so the gate can confirm the departure the file failed to record.
  session.cooperativeDeparture={request_id:r.id,at:now};
  try{r.state='offline';r.offline_at=now;store.write('request',session.name,r);}
  catch(e){try{console.error(`[cooperative] ${session.name} could not record the departure (${e.message}); the login gate will`);}catch{}}
}
export function cooperativeReconnectRefusal(session,credentials=session.credentials,{now=Date.now()}={}) {
  let store=null,r=null;
  try{store=cooperativeStore(session,credentials);r=store?.read('request',session.name);}
  catch(e){
    // Unreadable: only a live continuation in this process is a reason to refuse; otherwise the
    // join's own gate copes (and bounds) the unreadable store.
    return continuation(session)?{ok:false,reason_code:'cooperative_wait',request_id:null,note:'cooperative store unreadable while a login continuation is running: '+e.message}:null;
  }
  if(!pending(r))return null;
  if(continuation(session))return {ok:false,reason_code:'cooperative_wait',request_id:r.id,
    note:'the current cooperative continuation owns login until distraction is confirmed'};
  const stuck=stuckCooperativeLogoff(r,now);
  if(stuck){
    const done=abandonRecord(session,store,r,stuck,{now,by:'keeper join handler'});
    noteCooperativeRecovery(session,{action:'abandoned',...summary(r),reason_code:stuck.reason_code,why:stuck.why,
      by:'keeper join handler',record_written:done.written,write_error:done.error,then:'login allowed'},{credentials});
    return null;
  }
  // Pending, inside its bound, and nothing in this process is waiting on it: whatever owned it is
  // gone (a keeper restart, or a waiter that died). Let the join in -- it runs the same gate again,
  // so distraction receipts and the deadline still decide when the body comes back.
  noteCooperativeRecovery(session,{action:'regated',...summary(r),reason_code:'no_continuation',
    why:'a pending cooperative logoff had no waiter in this process; the requested login re-enters the gate',
    by:'keeper join handler'},{credentials});
  return null;
}
export function abortPreparingCooperativeLogoff(session,id,reason) {
  // Live or not: a reconnect that failed must not leave `preparing` claiming login. If the socket did
  // go, the broker's sweep brings the body back once nothing refuses it.
  try{
    const store=cooperativeStore(session),r=store?.read('request',session.name);
    if(r?.id===id&&r.state==='preparing'){
      r.state='aborted';r.reason=reason;r.aborted_at=Date.now();store.write('request',session.name,r);
      if(!session.live)noteCooperativeRecovery(session,{action:'abandoned',...summary({...r,state:'preparing'}),
        reason_code:'reconnect_failed',why:'the cooperative reconnect failed and the session is out: '+reason,by:'fleetLogoff'});
      return true;
    }
  }catch(e){try{console.error(`[cooperative] ${session.name} could not abort the preparing request: ${e.message}`);}catch{}}
  return false;
}
// No UNASKED deadline can quietly change "not distracted" into "safe to log in". Each target
// is satisfied by a fresh confirmed hit OR by fresh evidence that it is gone (see
// observeCooperativeTargets) -- an observation from the room, not a timer. The one timer is
// `max_offline_ms`, which the private strategy must ask for; without it there is none.
// This gate also runs on keeper restart and broker rejoin, not just the initial call.
//
// The bounds above are not distraction timers: PREPARING_MAX_MS ends a request whose departure was
// never recorded, and OFFLINE_OVERRUN_MS only ever acts AFTER the strategy's own max_offline_ms.
const cancelled=()=>Object.assign(Error('cooperative login cancelled by keeper ownership'),{cooperativeCancel:true});
function gateStep(session,store,now) {
  const r=store.read('request',session.name);if(!pending(r))return true;
  if(session.cooperativeLoginAllowed?.()===false)throw cancelled();
  if(r.state==='preparing'){
    const d=session.cooperativeDeparture;
    if(d&&(d.request_id===r.id||d.request_id==null&&Number.isFinite(r.created_at)&&d.at>=r.created_at)){
      // This session closed its own socket for this request; only the record missed it.
      const marked=store.lock(r.room,()=>{const cur=store.read('request',session.name);
        if(cur?.id!==r.id||cur.state!=='preparing')return false;
        Object.assign(cur,{state:'offline',offline_at:d.at,offline_confirmed_by:'login gate'});
        store.write('request',session.name,cur);return true;});
      if(marked)noteCooperativeRecovery(session,{action:'confirmed_offline',...summary(r),reason_code:'departure_unrecorded',
        why:'this session closed its socket for this request but the record still said preparing; the gate recorded the departure'});
      return false;
    }
    const stuck=stuckCooperativeLogoff(r,now());
    if(stuck){
      const done=abandonRecord(session,store,r,stuck,{now:now(),by:'login gate'});
      noteCooperativeRecovery(session,{action:'abandoned',...summary(r),reason_code:stuck.reason_code,why:stuck.why,
        by:'login gate',record_written:done.written,write_error:done.error,then:'logging in and going straight for cover'});
      session.cooperativeLogoffReturn={request_id:r.id,room:r.room,receipts:[],refuge:null,released_at:now(),released:stuck.reason_code};
      return true;
    }
    session.cooperativeLogoffWaiting={request_id:r.id,room:r.room,at:now(),phase:'preparing',since:r.created_at,
      waiting_ms:now()-r.created_at,abandon_at:Number.isFinite(r.created_at)?r.created_at+PREPARING_MAX_MS:null};
    return false;
  }
  const receipts=Object.values(r.receipts??{});
  const satisfied=t=>{
    const hit=r.receipts?.[t.id],p=hit&&store.read('presence',hit.helper),at=hit?.kind==='gone'?hit.at:hit?.hit_at;
    if(!(hit?.request_id===r.id&&hit.target_id===t.id&&hit.name===t.name&&at>=r.offline_at&&at<=now()&&now()-at<30000&&
      fresh(p,now())&&p.body===hit.helper_body&&p.room===r.room&&p.room_object===r.room_object&&!pending(store.read('request',hit.helper))))return false;
    return hit.kind==='gone'?at-hit.seen_absent_since>=GONE_MS:true;
  };
  const targets=r.targets??[];
  const valid=targets.every(satisfied);
  if(valid&&receipts.length){
    const permit=store.lock(r.room,()=>{const current=store.read('request',session.name);
      if(current?.id!==r.id||!['offline','returning'].includes(current.state))return false;
      current.state='returning';store.write('request',session.name,current);return true;});
    if(permit){session.cooperativeLogoffReturn={request_id:r.id,room:r.room,receipts,refuge:r.refuge??null,released_at:now()};return true;}
  }else if(Number.isFinite(r.max_offline_ms)&&Number.isFinite(r.offline_at)&&now()-r.offline_at>=r.max_offline_ms){
    // The opt-in deadline: the strategy asked for a bounded wait, so the body comes back
    // undistracted and the record says so. 'aborted' is not pending, so nothing re-gates it.
    let released=false,error=null;
    try{released=store.lock(r.room,()=>{const current=store.read('request',session.name);
      if(current?.id!==r.id||!['offline','returning'].includes(current.state))return false;
      Object.assign(current,{state:'aborted',reason:'deadline',released:'deadline',released_at:now()});
      store.write('request',session.name,current);return true;});}
    catch(e){error=e.message;}
    if(released){
      noteCooperativeRecovery(session,{action:'released_at_deadline',...summary(r),reason_code:'deadline',
        why:`no distraction confirmed within max_offline_ms ${Math.round(r.max_offline_ms/1000)}s; logging in undistracted`});
      session.cooperativeLogoffReturn={request_id:r.id,room:r.room,receipts,refuge:r.refuge??null,released_at:now(),released:'deadline'};return true;
    }
    // The release could not be written. Past the margin the login goes anyway: a record nobody can
    // write must not keep the body out. Short of it, the next poll tries the write again.
    const stuck=stuckCooperativeLogoff(r,now());
    if(stuck){
      noteCooperativeRecovery(session,{action:'released_unrecorded',...summary(r),reason_code:stuck.reason_code,why:stuck.why,
        by:'login gate',record_written:false,write_error:error??'room lock busy',then:'logging in and going straight for cover'});
      session.cooperativeLogoffReturn={request_id:r.id,room:r.room,receipts,refuge:r.refuge??null,released_at:now(),released:stuck.reason_code};
      return true;
    }
  }else if(r.state==='returning'){
    store.lock(r.room,()=>{const current=store.read('request',session.name);if(current?.id===r.id&&current.state==='returning'){current.state='offline';store.write('request',session.name,current);}});
  }
  session.cooperativeLogoffWaiting={request_id:r.id,room:r.room,at:now(),phase:r.state,since:r.offline_at,waiting_ms:now()-r.offline_at,
    targets:targets.map(t=>({id:t.id,name:t.name,hit:!!r.receipts?.[t.id]&&r.receipts[t.id].kind!=='gone',
      gone:r.receipts?.[t.id]?.kind==='gone',satisfied:satisfied(t)})),stalled:now()-r.offline_at>30000,
    deadline_at:Number.isFinite(r.max_offline_ms)?r.offline_at+r.max_offline_ms:null};
  return false;
}
export async function cooperativeBeforeLogin(session,credentials,{wait=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}={}) {
  const store=cooperativeStore(session,credentials);if(!store)return;
  let failing=null;
  try{
    for(;;){
      let done;
      try{done=gateStep(session,store,now);failing=null;}
      catch(e){
        if(e.cooperativeCancel)throw e;
        // A store this process cannot read or write right now is a fact about Windows file sharing,
        // not about the distraction. Ride it out, bounded: past STORE_FAILURE_MAX_MS the login goes.
        failing??={since:now(),why:e.message};
        if(session.cooperativeLoginAllowed?.()===false)throw cancelled();
        if(now()-failing.since>=STORE_FAILURE_MAX_MS){
          noteCooperativeRecovery(session,{action:'released_store_failure',request_id:session.cooperativeLogoffWaiting?.request_id??null,
            reason_code:'store_failure',why:`the cooperative store failed for ${Math.round((now()-failing.since)/1000)}s: ${e.message}`,
            by:'login gate',then:'logging in and going straight for cover'});
          const id=session.cooperativeLogoffWaiting?.request_id??null;
          if(id)session.cooperativeLogoffReturn={request_id:id,room:session.cooperativeLogoffWaiting.room??null,receipts:[],refuge:null,released_at:now(),released:'store_failure'};
          return;
        }
        session.cooperativeLogoffWaiting={...(session.cooperativeLogoffWaiting??{}),at:now(),store_error:e.message,store_failing_since:failing.since};
        done=false;
      }
      if(done)return;
      await wait(200);
    }
  }catch(e){
    // A waiter that is gone must not go on telling the broker it is waiting (Scooter, above).
    session.cooperativeLogoffWaiting=null;
    throw e;
  }
}
export function cooperativeAfterLogin(session) {
  // Cleared first and unconditionally: a gate that returned because somebody else resolved the record
  // (a hand-abort, a deadline written by a previous keeper) set no return, and the flag it left
  // behind would otherwise keep the broker's sweep stepping over a character that is back in game.
  session.cooperativeLogoffWaiting=null;
  session.cooperativeDeparture=null;
  const id=session.cooperativeLogoffReturn?.request_id;
  if(!id)return;
  try{
    const store=cooperativeStore(session);if(!store)return;
    const r=store.read('request',session.name);
    // The admission lock made returning requester-owned. Helpers never write a
    // returning record, so post-login completion cannot race their old cleanup.
    if(r?.id===id&&r.state==='returning'){r.state='resumed';r.resumed_at=Date.now();store.write('request',session.name,r);}
  }catch(e){
    // Logged in either way. A `returning` record left behind is still pending, but bounded: the next
    // gate revalidates it, the join handler re-gates it, and the bounds above end it.
    try{console.error(`[cooperative] ${session.name} could not record the return: ${e.message}`);}catch{}
  }
}
export function cooperativeHelperReady(pilot,config,{now=Date.now(),during=false,requestId=null}={}) {
  const s=pilot.s,c=s.client,h=c?.vitals?.()?.health,v=c?.vitals?.()?.vigor;
  const movement=liveMoveOrder(s),ownApproach=during&&movement?.origin?.source==='keeper'&&movement.origin.name==='cooperative_distraction'&&movement.origin.run_id===requestId;
  if(cannotDistract(pilot)||pilot.needleHere?.(s.world?.room?.num))return false;
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
    // Work on live targets while the absence observer collects proof for missing ones.
    const target = request.targets.find(candidate => {
      const receipt = request.receipts?.[candidate.id];
      const receivedAt = receipt?.kind === 'gone' ? receipt.at : receipt?.hit_at;
      if (receipt && now() - receivedAt < 30000) return false;
      const object = c.room.objects.get(candidate.id);
      return object && object.nameRsc === candidate.name_rsc && c.rsc.get(object.nameRsc) === candidate.name &&
        (object.flags & OF.ATTACKABLE) && !(object.flags & OF.PLAYER);
    });
    if(!target)continue;
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
