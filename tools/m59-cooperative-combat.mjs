// Generic cooperative attack transport. The private strategy chooses participants,
// target and wait policy; this module owns evidence, bounded geometry and execution.
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,writeFileSync,renameSync,realpathSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {OF} from './m59-parse.mjs';
import {classifyCombatLine} from './m59-combatlog.mjs';
import {tagLanded} from './m59-buddy.mjs';
import {planBodyDetour} from './m59-body-detour.mjs';
import * as party from './m59-party.mjs';
import {creatureByName,loadSpawns} from './m59-spawns.mjs';
import {survivalDecisionSnapshot} from './m59-survival-decision.mjs';
const SPAWNS=process.env.M59_SPAWN_FILE||new URL('../substrate/m59-spawns.json',import.meta.url);

export class CooperationStore {
  constructor(fleetPath) {
    const canonical=realpathSync(fleetPath);
    const path=process.platform==='win32'?canonical.toLowerCase():canonical;
    this.scope=createHash('sha256').update(path).digest('hex').slice(0,24);
    this.dir=join(dirname(fleetPath),'.cooperative-combat',this.scope);
  }
  write(record) {
    if(!/^[\w-]{1,64}$/.test(record.agent))throw new Error('invalid cooperative agent');
    mkdirSync(this.dir,{recursive:true});
    const file=join(this.dir,record.agent+'.json'),tmp=file+'.'+process.pid+'.tmp';
    writeFileSync(tmp,JSON.stringify({...record,scope:this.scope}));renameSync(tmp,file);
  }
  read(now=Date.now()) {
    let names=[];try{names=readdirSync(this.dir);}catch{return [];}
    return names.filter(n=>/^[\w-]+\.json$/.test(n)).flatMap(n=>{
      try {const r=JSON.parse(readFileSync(join(this.dir,n),'utf8'));
        return r.scope===this.scope&&Number.isFinite(r.at)&&now>=r.at&&now-r.at<=6000?[r]:[];
      }catch{return [];}
    });
  }
}

const distance=(a,b)=>Math.hypot(a.row-b.row,a.col-b.col);
export function localMeleeProof(s,o,{radius=4}={}) {
  const c=s.client,me=c?.self,geo=s.world?.geometry;
  if(!me||me.predicted||!o||distance(me,o)>radius||!geo?.collisionReady)return false;
  if(distance(me,o)<=2)return true; // no movement proposed; the server judges the hit
  const goals=[];
  for(let row=o.row-2;row<=o.row+2;row++)for(let col=o.col-2;col<=o.col+2;col++)
    if((row!==o.row||col!==o.col)&&Math.hypot(row-o.row,col-o.col)<=2)goals.push({row,col});
  const p=planBodyDetour(geo,me,{x:o.col*64+32,y:o.row*64+32},{goalSquares:goals,
    objects:c.room.objects,selfId:c.selfId,roomFlags:c.room.flags??0,overrideDepths:c.room.overrideDepths,
    avoidSquares:s.hazardSquares?.(),maxRangeSquares:radius+2,maxNodes:768,maxMs:20});
  return p.found===true;
}

export class CooperativeCombat {
  constructor(ap,{store,decide,now=Date.now,proof=localMeleeProof}={}) {
    this.ap=ap;this.store=store;this.decide=decide;this.now=now;this.proof=proof;
    this.cursor=ap.s.client?.evSeq??0;this.commitment=null;this.lastDecision=null;
  }
  ordinary() {
    const a=this.ap,s=a.s;
    return !this.failed&&s.live&&a.running!==false&&a.mode==='farm'&&!a.inert&&!a.travelling&&!s.combat?.active
      &&(!a.policy?.assignedRoom||Number(a.policy.assignedRoom)===Number(s.world?.room?.num))
      &&(!a.policy?.confineRooms?.length||a.policy.confineRooms.includes(s.world?.room?.num))
      &&!a.policy?.buddy&&!a.operatorSurvivalStandDown?.()
      &&['work','movement'].every(f=>(a.facultyOwner?.(f)??'keeper')==='keeper');
  }
  emergency() {
    const a=this.ap,h=a.s.client?.vitals?.()?.health;
    return !h?.max||!Number.isFinite(h.value)||h.value/h.max<=Math.max(0.5,a.safety?.().fleeAt??0.5)
      ||!!a.cooperativeDefensiveContact||!!a.fightBackDue||['pending','approaching','recovering'].includes(survivalDecisionSnapshot(a.s,{history:false})?.current?.status)
      ||(a.passStage&&!['passFarm','passCooperativeCombat'].includes(a.passStage));
  }
  update() {
    const c=this.ap.s.client,epoch=c&&`${c.selfId}:${c.room?.id}:${c.saveCount??0}`;
    if(c!==this.client||epoch!==this.epoch||c?.savePausedAt!=null) {
      this.client=c;this.epoch=epoch;this.epochAt=this.now();this.commitment=null;this.cursor=c?.evSeq??0;
    }
    const t=this.commitment;
    if(t) {
      const o=c?.room?.objects?.get(t.id);
      if(!o||!(o.flags&OF.ATTACKABLE)||(o.flags&OF.PLAYER)||o.nameRsc!==t.nameRsc)this.commitment=null;
      else for(const e of c.eventsSince?.(this.cursor)??[]) {
        if(e.kind==='message'&&tagLanded(classifyCombatLine(e.text),t.name))t.landed=true;
      }
    }
    this.cursor=c?.evSeq??this.cursor;
  }
  sent(id) {
    this.update();const c=this.ap.s.client;if(id===c?.selfId)return;
    const o=c?.room?.objects?.get(id);
    if(!o||(o.flags&OF.PLAYER)||!(o.flags&OF.ATTACKABLE)||!this.ordinary()||this.emergency()) {
      this.commitment=null;return;
    }
    if(!this.lastDecision||this.lastDecision.target_id!==id){this.commitment=null;return;}
    if(this.commitment?.id!==id)this.commitment={id,name:c.rsc?.get(o.nameRsc)??o.name??'',
      nameRsc:o.nameRsc,at:this.now(),started_at:this.lastDecision.started_at??this.now(),landed:false};
    this.cursor=c.evSeq??0;this.publish();
  }
  snapshot() {
    this.update();const a=this.ap,s=a.s,c=s.client,me=c?.self,h=c?.vitals?.()?.health;
    const eligible=this.ordinary()&&!this.emergency()&&!!me&&!me.predicted&&c.savePausedAt==null;
    const candidates=[];let proofs=0;const proofStarted=performance.now();
    if(eligible)for(const o of c.room?.objects?.values?.()??[]) {
      if((o.flags&OF.PLAYER)||!(o.flags&OF.ATTACKABLE)||distance(me,o)>4)continue;
      const name=c.rsc?.get(o.nameRsc)??o.name??'',level=creatureByName(loadSpawns(SPAWNS),name)?.level;
      if(!Number.isFinite(level)||!(level>h.max)||!a.huntMatch?.()(name)||a.sparedHere?.(o)||a.refuseEngagement?.(name))continue;
      if(++proofs>8||performance.now()-proofStarted>40)break;
      if(a.cooperativeTargetAllowed?.(o)===false)continue;
      if(this.proof(s,o))candidates.push({id:o.id,name,level,row:o.row,col:o.col});
      if(candidates.length>=8)break; // bounded scan/proof work per publication
    }
    const old=c?.lastAttackTarget,oldObject=c?.room?.objects?.get(old?.id);
    const oldValid=old?.at>=this.epochAt&&(c.rsc?.get(oldObject?.nameRsc)??oldObject?.name)===old?.name;
    const target=this.commitment?.id??(oldValid&&(oldObject?.flags&OF.ATTACKABLE)&&!(oldObject.flags&OF.PLAYER)?old.id:null);
    return {agent:s.name,character:a.who?.()??s.name,at:this.now(),eligible,room:s.world?.room?.num,
      room_id:c?.room?.id,body:c?.selfId,save:c?.saveCount??0,pos:me?{row:me.row,col:me.col}:null,
      hp:h?.max?h.value/h.max:null,target_id:target,tag:this.commitment?{...this.commitment}:null,candidates};
  }
  publish() {const r=this.snapshot();this.store.write(r);return r;}
  context(requested=null) {
    const me=this.publish(),a=this.ap,c=a.s.client;
    const visible=new Map([...(c.room?.objects?.values?.()??[])].filter(o=>o.flags&OF.PLAYER)
      .map(o=>[String(c.rsc?.get(o.nameRsc)??o.name??'').toLowerCase(),o.id]));
    const members=this.store.read(this.now()).filter(r=>r.agent!==me.agent&&r.eligible&&r.room===me.room
      &&r.at>(c.idsAsOf?.().last_save_began_at??0)&&r.room_id===me.room_id&&visible.get(String(r.character).toLowerCase())===r.body&&party.isFleetmate(r.character));
    const monsters=[...(c.room?.objects?.values?.()??[])].filter(o=>(o.flags&OF.ATTACKABLE)&&!(o.flags&OF.PLAYER));
    return {now:this.now(),me,members:[me,...members],monsters:monsters.map(o=>({id:o.id,row:o.row,col:o.col})),requested};
  }
  decision(requested=null) {
    if(!this.ordinary()||this.emergency()){this.commitment=null;this.publish();return null;}
    const ctx=this.context(requested),d=this.decide(ctx);
    if(d?.then)throw new Error('cooperativeCombat.decide must be synchronous');
    if(!d)return this.lastDecision=null;
    // Only checked huntable local targets, or the current live commitment, are executable.
    if(!ctx.me.candidates.some(o=>o.id===d.target_id)&&d.target_id!==this.commitment?.id)return null;
    if(!d.hold&&this.ap.cooperativeTargetAllowed?.(this.ap.s.client.room.objects.get(d.target_id))===false)
      return this.lastDecision={target_id:d.target_id,hold:true,why:'cooperative target no longer admitted by farming policy'};
    return this.lastDecision={target_id:d.target_id,hold:d.hold===true,
      started_at:Number.isFinite(d.started_at)&&d.started_at>=0&&d.started_at<=ctx.now?d.started_at:ctx.now,why:String(d.why??'cooperative combat')};
  }
  veto(id) {
    try {const o=this.ap.s.client?.room?.objects?.get(id);
      if(o?.flags&OF.PLAYER){this.commitment=null;return false;}
      const d=this.decision(id);return !!d&&(d.hold||id!==d.target_id);
    }catch(e){this.fail(e);return false;}
  }
  castSent(targets) {
    if(!targets.length||targets.some(id=>id!==this.ap.s.client.selfId))this.commitment=null;
  }
  castVeto(targets) {
    this.update();
    // Ordinary untargeted/other-target spells can overwrite gain flags too. Self buffs
    // remain available. Emergency/PvP stages bypass the cooperative restriction.
    if(!this.commitment||!this.ordinary()||this.emergency())return false;
    return !targets.length||targets.some(id=>id!==this.ap.s.client.selfId);
  }
  fail(e) {
    this.commitment=null;this.lastDecision=null;this.decide=()=>null;
    if(!this.failed)this.ap.note?.('cooperative combat unavailable',{why:e.message});
    this.failed=e.message;
  }
}

export async function refreshCooperation(ap) {
  ap.cooperativeDefensiveContact=false;
  const s=ap.s;
  if(!ap._cooperationLoaded) {
    ap._cooperationLoaded=true;
    const got=await s._askStrategies?.('cooperativeCombat',{phase:'configure',agent:s.name});
    if(typeof got?.answer?.decide!=='function'||!s.fleetStateFile)return;
    try {ap.cooperation=new CooperativeCombat(ap,{store:new CooperationStore(s.fleetStateFile),decide:got.answer.decide});}
    catch(e){ap.note?.('cooperative combat unavailable',{why:e.message});}
  }
  const co=ap.cooperation;if(!co)return;
  const c=s.client;if(!c)return;
  c.cooperativeAttackVeto=id=>co.veto(id);
  c.cooperativeCastVeto=targets=>co.castVeto(targets);
  c.cooperativeCastSent=targets=>co.castSent(targets);
  c.cooperativeAttackSent=id=>co.sent(id);
  c.cooperativeApplyVeto=id=>id!==c.selfId&&!!co.commitment&&co.veto(id);
  try {co.publish();}catch(e){co.fail(e);}
}

export async function cooperativePass(ap,{passiveOnly=false}={}) {
  const co=ap.cooperation;if(!co)return false;
  let d;try{d=co.decision();}catch(e){co.fail(e);return false;}
  if(!d)return false;
  ap.doing=d.why;
  if(d.hold)return true;
  if(passiveOnly)return false;
  const c=ap.s.client,o=c?.room?.objects?.get(d.target_id);
  if(!o||!localMeleeProof(ap.s,o))return false;
  ap.farmStrategyHook?.('beforeSwing',{target:c.rsc?.get(o.nameRsc)??o.name,target_id:o.id,room:ap.s.world?.room?.num});
  const roomId=c.room.id,body=c.selfId,save=c.saveCount,move=ap.s.movementGeneration,fight=ap.s.fightGeneration;
  const buff=await ap.farmBuffAsk?.('before_swing',{target:c.rsc?.get(o.nameRsc)??o.name});
  if(buff?.no_engage||buff?.went||buff?.logoff)return true;
  if(ap.hold&&distance(c.self,o)>2)ap.releaseHold?.('cooperative combat approach');
  const style=ap.trainingStyleFor?.(o.id),training=style?await ap.prepareTrainingStyle(style,o.id):{ready:true,equip:false};
  if(!training.ready)return true;
  if(ap.touchTrainingHere?.())await ap.maintainTouchSpell?.(`before tagging ${c.rsc?.get(o.nameRsc)??''}`);
  if(ap.s.client!==c||c.room.id!==roomId||c.selfId!==body||c.saveCount!==save
    ||ap.s.movementGeneration!==move||ap.s.fightGeneration!==fight)return true;
  const fresh=co.decision(o.id);if(!fresh||fresh.hold||fresh.target_id!==o.id)return true;
  const f=await ap.fightNow({target:c.rsc?.get(o.nameRsc)??o.name,exactTargetId:o.id,preferId:o.id,
    rounds:1,swingsPerRound:1,equip:training.equip,loot:true,reach:2,disengageAt:ap.safety().fleeAt});
  co.update();co.publish();
  if(f?.killed){ap.tally.kills=(ap.tally.kills??0)+1;ap.killTimes?.push(Date.now());
    ap.ledgerEvent?.('killed',{creature:f.target,room_num:ap.hereRoom(),cooperative:true});
    ap.farmStrategyHook?.('onKill',{creature:f.target,room:ap.hereRoom(),looted:f.looted});}
  if(f?.fought)ap.progress?.('cooperative combat exchange');
  return true;
}
