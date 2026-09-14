// Runtime survival intent. Telemetry observes this state; it is not inferred from logs.
import { OF } from './m59-parse.mjs';

export const SURVIVAL_DECISION_VERSION = 1;
const states = new WeakMap();
const MAX_HISTORY = 64, MAX_PATH = 256;
const text = x => x == null ? null : String(x).slice(0, 400);
const point = p => p && Number.isFinite(p.row) && Number.isFinite(p.col)
  ? { row:p.row, col:p.col, ...(p.room != null ? {room:p.room} : {}) } : null;
const refuge = p => point(p) ? {...point(p),kind:text(p.kind??'wall'),
  ...(p.destination!=null?{destination:p.destination}:{})} : null;
function state(s) {
  if (!states.has(s)) states.set(s, { sequence:0, current:null, history:[], dropped:0, errors:0 });
  return states.get(s);
}
export function survivalObservation(s) {
  try { return observedSurvivalState(s); }
  catch { state(s).errors++; return {hp:null,vigor:null,room:null,position:null,
    threat:{source:'cached observation unavailable',bodies:[],omitted:null}}; }
}
function observedSurvivalState(s) {
  const c=s.client, me=c?.self, v=c?.vitals?.(), bodies=[];
  let scanned=0;
  for (const o of c?.room?.objects?.values?.() ?? []) {
    if (++scanned>2048) break;
    if (o.id===c.selfId || !(o.flags & (OF.ATTACKABLE|OF.PLAYER))) continue;
    const p=point(o); if (!p) continue;
    bodies.push({id:o.id,...p,flags:o.flags,distance:me ? Math.max(Math.abs(me.row-o.row),Math.abs(me.col-o.col)) : null});
  }
  bodies.sort((a,b)=>(a.distance??Infinity)-(b.distance??Infinity));
  return {hp:v?.health ? {value:v.health.value,max:v.health.max} : null,
    vigor:v?.vigor?.value??null, room:s.world?.room?.num??null, position:point(me),
    threat:{source:'cached visible bodies; not an attribution of attacks',bodies:bodies.slice(0,16),
      omitted:Math.max(0,bodies.length-16),scan_truncated:scanned>2048}};
}
function emit(s,t,event,d,extra={}) {
  try { t.record?.({version:1,event,at:Date.now(),decision:structuredClone(d),...extra}); }
  catch { t.errors++; }
}
export function attachSurvivalDecisions(s,{record,onCancel,epoch=null}={}) {
  Object.assign(state(s),{record,onCancel,epoch});
}
export function currentSurvivalDecision(s) { return state(s).current; }
function make(s,t,spec,previous) {
  const now=Date.now(), obs=survivalObservation(s);
  return {version:1,id:`${process.pid}-${now}-${++t.sequence}`,episode_id:previous?.episode_id??null,
    strategy:text(spec.strategy??'seek_refuge'),reason:text(spec.reason),reason_code:text(spec.reason_code??spec.strategy),
    hp:obs.hp,threat:obs.threat,room:obs.room,position:obs.position,vigor:obs.vigor,
    chosen_refuge:refuge(spec.chosen_refuge),path:null,path_length:null,path_source:null,
    chosen_at:now,selected_at:null,status:spec.status??'pending',
    previous_decision_id:previous?.id??null,replacement_id:null,
    replan_count:spec.replan_count??0,original_reason:previous?.original_reason??previous?.reason??text(spec.reason),
    mitigation:text(spec.mitigation),source:text(spec.source??'keeper'),
    movement_generation:s.movementGeneration??null,epoch:t.epoch,
    damage_taken:0,last_hp:obs.hp?.value??null,min_hp:obs.hp?.value??null,
    activated_at:null,arrived_at:null,ended_at:null,outcome:null};
}
function archive(t,d) {
  t.history.push(d);
  if(t.history.length>MAX_HISTORY) {t.history.shift();t.dropped++;}
}
export function chooseSurvivalDecision(s,spec,{because='new survival choice',outcome='cancelled'}={}) {
  const t=state(s), old=t.current, next=make(s,t,spec,old?.strategy==='yield_to_controller'?null:old);
  next.previous_decision_id=old?.id??null;
  next.episode_id??=next.id;
  // Install the replacement before reporting cancellation. No observer sees an empty intent.
  t.current=next;
  if(old) {
    old.status='ended';old.outcome=outcome;old.ended_at=Date.now();
    old.cancelled_at=old.ended_at;old.cancel_reason=text(because);old.replacement_id=next.id;
    archive(t,old);emit(s,t,'replaced',old);
  }
  emit(s,t,'chosen',next);
  return next;
}
export function updateSurvivalDecision(s,id,patch) {
  const t=state(s),d=t.current;
  if(!d||d.id!==id) return null;
  for(const key of ['status','activated_at','arrived_at','selected_at','phase','retry_at'])
    if(patch[key]!==undefined) d[key]=patch[key];
  if(patch.chosen_refuge!==undefined) d.chosen_refuge=refuge(patch.chosen_refuge);
  if(patch.path!==undefined) {
    d.path=Array.isArray(patch.path)?patch.path.slice(0,MAX_PATH).map(point).filter(Boolean):null;
    d.path_truncated=Array.isArray(patch.path)&&patch.path.length>MAX_PATH;
  }
  for(const key of ['path_length','path_source','mitigation','phase_reason'])
    if(patch[key]!==undefined) d[key]=typeof patch[key]==='string'?text(patch[key]):patch[key];
  emit(s,t,'updated',d);
  return d;
}
export function observeSurvivalDecision(s, value = undefined) {
  const d=state(s).current,hp=value??s.client?.vitals?.()?.health?.value;
  if(!d||!Number.isFinite(hp)) return;
  if(Number.isFinite(d.last_hp)&&hp<d.last_hp) d.damage_taken+=d.last_hp-hp;
  d.last_hp=hp;d.min_hp=Math.min(d.min_hp??hp,hp);
}
export function finishSurvivalDecision(s,id,outcome,reason=null) {
  const t=state(s),d=t.current;
  if(!d||d.id!==id) return false;
  if(outcome!=='died')observeSurvivalDecision(s);
  d.status='ended';d.outcome=outcome;d.ended_at=Date.now();
  d.end_reason=text(reason);d.end_hp={value:d.last_hp,max:d.hp?.max??null};
  t.current=null;archive(t,d);emit(s,t,'finished',d);return true;
}
export function cancelSurvivalDecision(s,reason,{replacement=null,preserveId=null}={}) {
  const t=state(s),d=t.current;
  if(!d||d.id===preserveId) return d;
  let spec=replacement;
  if(!spec) { try {spec=t.onCancel?.(reason,d);} catch {t.errors++;} }
  spec??={strategy:'reassess_survival',reason,reason_code:'movement_cancelled'};
  return chooseSurvivalDecision(s,spec,{because:reason});
}
export function survivalDecisionSnapshot(s,{history=true}={}) {
  const t=state(s),now=Date.now();
  const project=d=>d?{...d,age_ms:now-d.chosen_at,
    cancelled_ago_ms:d.cancelled_at?now-d.cancelled_at:null,
    duration_ms:(d.ended_at??now)-d.chosen_at}:null;
  return structuredClone({version:1,captured_at:now,current:project(t.current),
    ...(history?{history:t.history.map(project)}:{}),history_dropped:t.dropped,record_errors:t.errors});
}
