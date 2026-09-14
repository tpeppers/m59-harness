// Portable, allowlisted Monster state. References use scene keys, never saved ids.
import {observed} from './m59-scene.mjs';
import {sendMsg,setProp} from './m59-dm.mjs';
export const MONSTER_SCALARS=['piState','piHatred','piWalkingEffort','piBehavior',
  'piSceneBehaviorMs','piSceneRandomMs','piSceneSpasmMs','piSceneOfferMs','piSceneUnturnMs'];
export function nativeMonsterPlan(actor,id,bindings) {
  const state=actor.server_state?.v;
  if(!state)return [];
  if(actor.kind!=='monster'||state.schema!=='m59-held-monster/v1')throw Error('unsupported native actor state');
  const commands=[];
  if(state.target!=null) {
    const target=bindings.get(state.target);
    if(!Number.isInteger(target))throw Error('native monster target is outside the explicit scene');
    commands.push(sendMsg(id,'TargetSwitch',{what:['OBJECT',target]}));
  }else commands.push(`set object ${id} poTarget $ 0`);
  for(const [key,value] of Object.entries(state.fields??{})) {
    if(!MONSTER_SCALARS.includes(key)||!Number.isInteger(value))throw Error('unsupported native monster property');
    commands.push(setProp(id,key,value));
  }
  return commands;
}
export function compareNativeMonster(actor,got,bindings) {
  const state=actor.server_state?.v;if(!state)return [];
  const mismatches=[];
  for(const [key,value] of Object.entries(state.fields??{}))
    if(got.properties?.[key.toLowerCase()]?.value!==value)mismatches.push({actor:actor.key,field:key,want:value,got:got.properties?.[key.toLowerCase()]?.value});
  const target=state.target==null?null:bindings.get(state.target),actual=got.properties?.potarget?.value??null;
  if(target!==actual)mismatches.push({actor:actor.key,field:'target',want:target,got:actual});
  return mismatches;
}
export function enrichHeldScene(input,bindings,actual) {
  if(actual.properties?.pbsceneheld?.value!==1)throw Error('authoritative monster capture requires a held room');
  const scene=structuredClone(input),keys=new Map([...bindings].map(([key,id])=>[id,key]));
  for(const a of scene.actors.filter(a=>a.kind==='monster')) {
    const got=actual.actors.find(o=>o.id===bindings.get(a.key??a.name));
    if(!got||got.properties?.pbsceneheld?.value!==1)throw Error('monster is not held');
    const target=got.properties?.potarget?.value;
    if(target!=null&&!keys.has(target))throw Error('monster target is outside the explicit scene');
    a.server_class=got.class;a.vitals??={};a.vitals.hp=observed(got.hp);
    a.server_state=observed({schema:'m59-held-monster/v1',target:target==null?null:keys.get(target),
      fields:Object.fromEntries(MONSTER_SCALARS.filter(k=>got.properties[k.toLowerCase()]?.type==='INT')
        .map(k=>[k,got.properties[k.toLowerCase()].value]))});
  }
  scene.notes??=[];scene.notes.push('native held monster state observed; subclass timers, RNG and player input streams still require separate evidence');
  return scene;
}
