// Shared room preparation for CLI scenes, FleetScratch and death replays.
// Preparation can create/remove lab monsters. Only the verified final state starts.
import {readFileSync} from 'node:fs';
import {dm,sendMsg,setProp,returnedObject,rejections,resolve} from './m59-dm.mjs';
import {executeLoad,assertLab,resolveRoom} from './m59-scene.mjs';
import {readAdminRoom,readAdminObjects,compareScenePlacement} from './m59-scene-admin.mjs';
import {sceneWithOptions} from './m59-scene-options.mjs';
import {nativeMonsterPlan,enrichHeldScene} from './m59-scene-native-state.mjs';

const creatureClasses=()=>JSON.parse(readFileSync(new URL('../substrate/m59-spawns.json',import.meta.url))).creatures;
const className=s=>typeof s==='string'&&/^[A-Za-z][A-Za-z0-9_]*$/.test(s);
const isMonster=o=>o.properties?.pihit_points!=null;
export async function prepareScene(input,{env=process.env,resolveActor,classes={},options={},
    requireNativeHold=false,dmFn=dm}={}) {
  assertLab(env);
  const scene=sceneWithOptions(input,options),changes=[],assumptions=[],bindings=new Map(),used=new Set();
  const initial=await readAdminRoom(scene.room.num,{env,dmFn});
  const labItems=new Map();
  if(options.labScenery===true) {
    const removed=scene.actors.filter(a=>a.kind==='item').map(a=>a.key??a.name);
    scene.actors=scene.actors.filter(a=>a.kind!=='item');
    for(const o of initial.actors.filter(o=>!isMonster(o)&&o.properties?.pihealth==null&&
      !['User','Player'].includes(o.class))) {
      const key='lab-scenery-'+o.id;labItems.set(key,o.id);
      scene.actors.push({key,name:o.name??o.class,kind:'item',
        at:{v:{row:o.row,col:o.col,x:o.x,y:o.y},how:'observed'},angle:{v:o.angle,how:'observed'}});
    }
    scene.reload.faithful=false;
    scene.reload.changes.push({kind:'use_lab_scenery',removed,retained:[...labItems.keys()]});
    assumptions.push('Explicit labScenery: room items and scenery come from the lab snapshot, not the recording');
  }
  const native=initial.properties?.pbsceneheld!=null;
  if(requireNativeHold&&!native)throw Error('native scene hold is required; use the scene-hold lab image');
  const book=creatureClasses();
  for(const a of scene.actors)if(a.kind==='monster') {
    if(a.server_state?.v&&!native)throw Error('captured native monster state requires the native scene hold image');
    a.server_class??=classes[a.name]??book[a.name?.toLowerCase()]?.cls;
    if(!className(a.server_class))throw Error(`no unambiguous KOD class for ${a.name}`);
  }
  // Resolve user identity and scenery before any destructive preparation.
  for(const a of scene.actors.filter(a=>a.kind!=='monster')) {
    const key=a.key??a.name;
    let id=labItems.get(key)??await resolveActor?.(a);
    if(id==null&&a.kind==='player')id=(await resolve([a.name],{env}))[a.name];
    if(id==null) {
      const candidates=initial.actors.filter(o=>!used.has(o.id)&&o.name?.toLowerCase()===a.name?.toLowerCase());
      const at=a.at?.v;
      const exact=candidates.filter(o=>o.row===at?.row&&o.col===at?.col&&
        (at.x==null||o.x===at.x)&&(at.y==null||o.y===at.y));
      const matches=exact.length?exact:candidates;
      if(matches.length===1)id=matches[0].id;
    }
    if(!Number.isInteger(id)||used.has(id))throw Error(`missing or ambiguous lab binding for ${key}`);
    bindings.set(key,id);used.add(id);
  }
  const foreignPlayers=initial.actors.filter(o=>(['User','Player'].includes(o.class)||
    o.properties?.pihealth!=null)&&!used.has(o.id));
  if(foreignPlayers.length)throw Error('room contains player bodies outside the explicit scene bindings');
  const generation=initial.properties?.pbgeneratemonsters?.value;
  let started=false;
  const restoreSpawns=async()=>{
    const room=await resolveRoom(scene.room.num,{env,dmFn});
    if(generation!=null)await dmFn([sendMsg(room,'SetMonsterGeneration',{bValue:['INT',generation]})],{env});
  };
  const releaseSetup=async()=>{
    // A GC can renumber objects during a long trial; resolve current identities.
    const actual=await readAdminRoom(scene.room.num,{env,dmFn});
    const commands=native?[sendMsg(actual.room_object,'SceneStartRoom',{fresh:['INT',0]})]:
      actual.actors.filter(isMonster).flatMap(o=>[
        sendMsg(o.id,'EnterStateWait',{delay:['INT',1]}),sendMsg(o.id,'StartBasicTimers')]);
    if(commands.length)await dmFn(commands,{env});
  };
  try {
    if(generation!=null) {
      await dmFn([sendMsg(initial.room_object,'SetMonsterGeneration',{bValue:['INT',0]})],{env});
      changes.push({kind:'suppress_spawns_during_setup',previous:generation});
    }
    if(native)await dmFn([sendMsg(initial.room_object,'SceneHoldRoom')],{env});
    else assumptions.push('stock server staging hold: behavior timers stopped; reactive callbacks are not a native barrier');
    // Hold existing monsters before moving the first player, including extras.
    if(!native)await dmFn(initial.actors.filter(isMonster).flatMap(o=>[
      sendMsg(o.id,'EnterStateWait',{delay:['INT',200000000]}),sendMsg(o.id,'ClearBasicTimers')]),{env});
    for(const a of scene.actors.filter(a=>a.kind==='monster')) {
      const key=a.key??a.name;
      let got=initial.actors.find(o=>!used.has(o.id)&&o.class?.toLowerCase()===a.server_class.toLowerCase());
      if(!got) {
        const result=await dmFn([`create object ${a.server_class}`],{env});
        const id=Number(/Created object (\d+)/.exec(result)?.[1])||returnedObject(result);
        if(!id)throw Error(`creating ${a.server_class} did not return an object`);
        [got]=await readAdminObjects([id],{env,dmFn});changes.push({kind:'create_monster',actor:key,class:got.class});
        // Newly constructed monsters start in LIMBO. A room relocation alone does
        // not establish their WAIT behavior while sensory callbacks are held.
        if(native&&!a.server_state?.v)await dmFn([sendMsg(got.id,'SceneHold'),
          setProp(got.id,'piState',8),setProp(got.id,'piSceneBehaviorMs',1)],{env});
      }
      bindings.set(key,got.id);used.add(got.id);
      const cmds=native?[sendMsg(got.id,'SceneHold')]:[
        sendMsg(got.id,'EnterStateWait',{delay:['INT',200000000]}),sendMsg(got.id,'ClearBasicTimers')];
      await dmFn(cmds,{env});
      if(a.vitals?.hp?.how==='unknown') {
        a.vitals.hp={v:got.hp,how:'estimated'};
        assumptions.push(`${key}: production did not expose monster HP; lab HP is an estimate`);
      }
    }
    const extras=initial.actors.filter(o=>isMonster(o)&&!used.has(o.id));
    if(extras.length) {
      const result=await dmFn(extras.map(o=>sendMsg(o.id,'Delete')),{env});
      if(rejections(result).length)throw Error('extra monster removal was rejected');
      changes.push({kind:'remove_extra_monsters',actors:extras.map(o=>({class:o.class,id_at_setup:o.id}))});
    }
    const loaded=await executeLoad(scene,{pause:false,env,dmFn,resolveActor:a=>bindings.get(a.key??a.name),
      verify:async(sc,map)=>{
        const commands=sc.actors.flatMap(a=>nativeMonsterPlan(a,map.get(a.key??a.name),map));
        if(commands.length) {
          const response=await dmFn(commands,{env});
          if(rejections(response).length)return {ok:false,mismatches:['native monster restoration rejected']};
        }
        return compareScenePlacement(sc,map,await readAdminRoom(sc.room.num,{env,dmFn}));
      }});
    loaded.preparation={native_hold:native,changes,assumptions,reload:scene.reload};
    const start=async()=>{
      if(started)throw Error('scene has already started');
      if(!loaded.ok)throw Error('refusing to start an unverified scene');
      // Verify once more immediately before release; setup reads may have taken time.
      const actual=await readAdminRoom(scene.room.num,{env,dmFn});
      const final=compareScenePlacement(scene,bindings,actual);
      if(!final.ok)throw Error('scene changed while held: '+JSON.stringify(final.mismatches));
      const commands=native?[sendMsg(actual.room_object,'SceneStartRoom',{fresh:['INT',1]})]:
        scene.actors.filter(a=>a.kind==='monster').flatMap(a=>[
          sendMsg(bindings.get(a.key??a.name),'EnterStateWait',{delay:['INT',1]}),
          sendMsg(bindings.get(a.key??a.name),'StartBasicTimers')]);
      // A no-monster experiment must remain free of automatic spawns during its run.
      if(generation!=null&&!options.noMonsters)commands.push(sendMsg(actual.room_object,'SetMonsterGeneration',{bValue:['INT',generation]}));
      const at=Date.now(),response=await dmFn(commands,{env});
      if(rejections(response).length)throw Error('scene release rejected');
      started=true;
      return {ok:true,at,completed_at:Date.now(),atomic_monster_release:native,
        note:native?'one server message releases all room monsters':'one admin batch; stock server cannot certify an atomic release'};
    };
    const cleanup=async()=>{
      try {if(!started)await releaseSetup();}finally{await restoreSpawns();}
    };
    const receipt={schema:'m59-scene-prepared/v1',scene,loaded,native_hold:native,
      generation_before:generation??null,prepared_at:Date.now()};
    const snapshot=async()=>{
      if(started)throw Error('capture the held checkpoint before starting');
      return enrichHeldScene(scene,bindings,await readAdminRoom(scene.room.num,{env,dmFn}));
    };
    return {scene,bindings,loaded,start,cleanup,receipt,snapshot};
  }catch(e) {
    await releaseSetup().catch(()=>{});
    await restoreSpawns().catch(()=>{});throw e;
  }
}

// Re-resolve a held scene from actual class/name/position; never trust saved object ids.
async function resolvePreparedScene(receipt,{env=process.env}={}) {
  assertLab(env);
  if(receipt?.schema!=='m59-scene-prepared/v1'||!receipt.loaded?.ok)throw Error('a verified preparation receipt is required');
  const {scene}=receipt,actual=await readAdminRoom(scene.room.num,{env}),bindings=new Map(),used=new Set();
  for(const a of scene.actors) {
    const p=a.at?.v;
    const matches=actual.actors.filter(o=>!used.has(o.id)&&o.name?.toLowerCase()===a.name?.toLowerCase()&&
      (a.server_class==null||o.class===a.server_class)&&o.row===p.row&&o.col===p.col&&
      (p.x==null||o.x===p.x)&&(p.y==null||o.y===p.y));
    if(matches.length!==1)throw Error(`held actor ${a.key??a.name} is missing or ambiguous`);
    bindings.set(a.key??a.name,matches[0].id);used.add(matches[0].id);
  }
  const verified=compareScenePlacement(scene,bindings,actual);
  if(!verified.ok)throw Error('held scene no longer matches: '+JSON.stringify(verified.mismatches));
  const native=actual.properties?.pbsceneheld?.value===1;
  if(receipt.native_hold&&!native)throw Error('native room hold is no longer active');
  return {scene,actual,bindings,native};
}
export async function capturePreparedScene(receipt,options={}) {
  const {scene,bindings,actual}=await resolvePreparedScene(receipt,options);
  return enrichHeldScene(scene,bindings,actual);
}
export async function releasePreparedScene(receipt,{env=process.env}={}) {
  const {scene,actual,bindings,native}=await resolvePreparedScene(receipt,{env});
  const cmds=native?[sendMsg(actual.room_object,'SceneStartRoom',{fresh:['INT',1]})]:
    scene.actors.filter(a=>a.kind==='monster').flatMap(a=>[
      sendMsg(bindings.get(a.key??a.name),'EnterStateWait',{delay:['INT',1]}),sendMsg(bindings.get(a.key??a.name),'StartBasicTimers')]);
  if(receipt.generation_before!=null&&!scene.reload?.options?.noMonsters)
    cmds.push(sendMsg(actual.room_object,'SetMonsterGeneration',{bValue:['INT',receipt.generation_before]}));
  const at=Date.now(),out=await dm(cmds,{env});
  return {ok:rejections(out).length===0,at,atomic_monster_release:native};
}
