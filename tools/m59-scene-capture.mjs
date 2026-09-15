// No requests, file reads, serialization, or git calls on the crisis path.
import {makeScene,observed,unknownField} from './m59-scene.mjs';
import {OF} from './m59-parse.mjs';
import {currentSurvivalDecision} from './m59-survival-decision.mjs';

export const CAPTURE_LIMITS=Object.freeze({actors:2048,inventory:512,abilities:512});
const number=x=>Number.isFinite(x)?x:null;
const label=x=>x==null?null:String(x).slice(0,240);
const vital=v=>v?observed({value:number(v.value),max:number(v.max),scale_max:number(v.scale_max),rest_threshold:number(v.rest_threshold)}):unknownField();
export function finePosition(o) {
  if(!o)return unknownField();
  const p={row:number(o.row),col:number(o.col),x:number(o.x),y:number(o.y),predicted:!!o.predicted,
    units:'KOD/protocol fine units; 64 per square'};
  return observed(p);
}
// Only gameplay configuration is permitted here, never a Session, account or request.
export function copyReplayConfig(value,depth=0,gaps=[]) {
  if(value==null||typeof value==='boolean'||typeof value==='number')return value??null;
  if(typeof value==='string'){if(value.length>800)gaps.push('controller string truncated');return value.slice(0,800);}
  if(depth>8){gaps.push('controller depth truncated');return null;}
  if(Array.isArray(value)){
    if(value.length>512)gaps.push('controller array truncated');
    return value.slice(0,512).map(v=>copyReplayConfig(v,depth+1,gaps));
  }
  if(typeof value!=='object')return null;
  return Object.fromEntries(Object.entries(value).filter(([k])=>!/password|credential|secret|token|account/i.test(k))
    .map(([k,v])=>[k,copyReplayConfig(v,depth+1,gaps)]));
}
export function captureCachedScene(s,k,{name='replay',at=Date.now(),provenance={pending:true},limits=CAPTURE_LIMITS}={}) {
  const c=s.client,v=c?.vitals?.()??{},objects=c?.room?.objects;
  const rsc=o=>label(o.name??c?.rsc?.get?.(o.nameRsc));
  const actors=[],gaps=[];
  const body=(o,self=false)=>({key:self?'self':`body-${o.id}`,object_at_capture:o.id??null,
    kind:self||!!(o.flags&OF.PLAYER)||c?.playersOnline?.has?.(o.id)?'player'
      :o.flags&OF.ATTACKABLE?'monster':'item',
    kind_source:observed('client flags and online-player identity'),name:rsc(o),mine:self,
    at:finePosition(o),angle:Number.isFinite(o.angle)?observed(o.angle):unknownField(),
    facing_degrees:Number.isFinite(o.degrees)?observed(o.degrees):unknownField(),
    flags:observed(o.flags??null),name_resource:observed(o.nameRsc??null),
    vitals:{hp:self?vital(v.health):unknownField(),mana:self?vital(v.mana):unknownField(),
      vigor:self?vital(v.vigor):unknownField()},
    server_state:unknownField()});
  if(c?.self) {
    const a=body({...c.self,name:c.me?.name??s.name},true);a.agent=s.name;
    a.stats=observed(Object.fromEntries(['might','intellect','stamina','agility','mysticism','aim','karma']
      .map(n=>[n,c.statsById?.get?.(n)?.value]).filter(([,v])=>Number.isFinite(v))));
    const item=o=>({id:o.id,name:rsc(o),nameRsc:o.nameRsc,amount:o.amount??null,rarity:o.rarity??null,flags:o.flags??null});
    a.inventory=observed((c.inventory??[]).slice(0,limits.inventory).map(item));
    a.equipment=observed((c.equipment?.()?.equipped??[]).map(item));
    a.abilities={v:[...(c.abilities?.values?.()??[])].slice(0,limits.abilities)
      .map(v=>({kind:v.kind,name:v.name,ability:v.ability})),
      how:c.abilitiesAt?.skills!=null&&c.abilitiesAt?.spells!=null?'observed':'unknown'};
    a.ability_read_at=copyReplayConfig(c.abilitiesAt??null);
    if((c.inventory?.length??0)>limits.inventory)gaps.push('inventory truncated');
    if((c.abilities?.size??0)>limits.abilities)gaps.push('abilities truncated');
    actors.push(a);
  }else gaps.push('self position unavailable');
  let scanned=0;
  for(const o of objects?.values?.()??[]) {
    if(o.id===c.selfId)continue;
    if(++scanned>=limits.actors){gaps.push('room objects truncated');break;}
    actors.push(body(o));
  }
  for(const a of actors) {
    const p=a.at.v;
    if(p?.x==null||p?.y==null)gaps.push(`${a.key}: fine position unknown`);
    else if(Math.floor(p.x/64)!==p.col||Math.floor(p.y/64)!==p.row)gaps.push(`${a.key}: fine/square mismatch`);
    if(p?.predicted)gaps.push(`${a.key}: predicted position`);
  }
  const scene=makeScene({name,room:{num:s.world?.room?.num??-1,name:observed(s.world?.room?.name??null)},actors,
    provenance,capturedAt:new Date(at).toISOString(),capturedFrom:s.name,
    notes:['cached client observations; no server request made during capture',
      'server RNG state, timer phase, monster HP/targets and other players\' inputs are unknown',
      'fine positions describe the latest received state, not a simultaneous server checkpoint']});
  scene.capture={at,event_sequence:c.evSeq??null,room_object_id:c.room?.id??null,
    room_wire:copyReplayConfig(s.world?.roomBinding?.room_wire),objects_total:objects?.size??null,
    captured_actors:actors.length,gaps,complete_visible_positions:gaps.length===0};
  const controllerGaps=[];
  scene.controller=copyReplayConfig({mode:k?.mode,policy:k?.policy,hold:k?.hold,
    inert:k?.inert,suspended_journey:k?.suspendedJourney,doing:k?.doing,
    frozen_until:k?.frozenUntil,freeze_sample:k?.freezeSample,turned_at:k?.turnedAt,
    froze_at:k?.frozeAt,freezes_without_gain:k?.freezesWithoutGain,
    posture_command:c?.lastPostureCommand??null,
    position_reads:{requested:c?.roomContentsRequested,received:c?.roomContentsReceived,lost:c?.roomContentsLost??0},
    movement_generation:s.movementGeneration,decision:currentSurvivalDecision(s),
    variant:k?.replayVariant??null,start_actions:k?.replayStartActions??null},0,controllerGaps);
  scene.capture.controller_gaps=[...new Set(controllerGaps)];
  scene.capture.complete_controller=controllerGaps.length===0;
  return scene;
}
