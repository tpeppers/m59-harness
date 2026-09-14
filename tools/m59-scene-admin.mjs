// Authoritative reads on the LOCAL lab only, shared by scene verification and replay.
import {dm,split,sendMsg,isLoopbackHost} from './m59-dm.mjs';
import {resolveRoom,assertLab} from './m59-scene.mjs';
import {compareNativeMonster} from './m59-scene-native-state.mjs';

export function parseAdminObject(block,id) {
  const properties={};
  for(const m of block.matchAll(/\b(\w+)\s+=\s+(INT|OBJECT|RESOURCE|LIST|TIMER)\s+(-?\d+)/g))
    properties[m[1].toLowerCase()]={type:m[2],value:Number(m[3])};
  const n=key=>properties[key.toLowerCase()]?.value??null;
  const row=n('piRow'),col=n('piCol'),fr=n('piFine_row'),fc=n('piFine_col');
  return {id,class:/is CLASS (\w+)/i.exec(block)?.[1]??null,properties,
    room_object:n('poOwner'),row,col,x:col!=null&&fc!=null?col*64+fc:null,
    y:row!=null&&fr!=null?row*64+fr:null,angle:n('piAngle'),
    hp:{value:n('piHealth')??n('piHit_points'),max:n('piMax_Health')??n('piMax_hit_points')},
    mana:{value:n('piMana'),max:n('piMax_Mana')},vigor:{value:n('piVigor')}};
}
export async function readAdminObjects(ids,{dmFn=dm,env=process.env}={}) {
  assertLab(env);
  if(!ids.every(Number.isInteger))throw Error('invalid current object id');
  if(!ids.length)return [];
  const commands=ids.flatMap(id=>[`show object ${id}`,sendMsg(id,'GetName')]);
  const blocks=split(await dmFn(commands,{env}),commands);
  return ids.map((id,i)=>({...parseAdminObject(blocks[i*2]??'',id),
    name:/== "([^"]*)"/.exec(blocks[i*2+1]??'')?.[1]??null,
    name_resource:Number(/:\s*RESOURCE (\d+)/.exec(blocks[i*2+1]??'')?.[1])||null}));
}
export async function readAdminRoom(num,{dmFn=dm,env=process.env}={}) {
  assertLab(env);
  const room=await resolveRoom(num,{dmFn,env});if(room==null)throw Error(`lab room ${num} unavailable`);
  const head=await dmFn([`show object ${room}`],{env});
  const positions=new Map();
  for(const property of ['plActive','plPassive']) {
    const found=new RegExp(`${property}\\s+= (LIST|\\$) (\\d+)`).exec(head);
    if(!found)throw Error(`room ${property} unavailable`);
    if(found[1]==='$')continue;
    const raw=await dmFn([`show list ${found[2]}`],{env});let cur=null;
    for(const line of String(raw).split(/\r?\n/).map(l=>l.replace(/^:\s?/,'').trim())) {
      if(line==='['){cur=[];continue;}
      if(line===']') {
        if(cur&&/^OBJECT \d+$/.test(cur[0]??'')) {
          const values=cur.map(x=>Number(x.split(' ')[1]));
          const [id,angle,row,col,fr,fc]=values;
          positions.set(id,{row,col,angle,x:col*64+fc,y:row*64+fr,room_object:room});
        }
        cur=null;continue;
      }
      if(cur)cur.push(line);
    }
  }
  const actors=await readAdminObjects([...positions.keys()],{dmFn,env});
  return {room_object:room,properties:parseAdminObject(head,room).properties,
    actors:actors.map(o=>({...o,...positions.get(o.id)}))};
}
export function compareScenePlacement(scene,bindings,actual) {
  const mismatches=[];
  for(const a of scene.actors??[]) {
    const id=bindings.get(a.key??a.name),got=actual.actors.find(o=>o.id===id),want=a.at?.v;
    if(!got){mismatches.push({actor:a.key??a.name,why:'missing actor'});continue;}
    mismatches.push(...compareNativeMonster(a,got,bindings));
    if(got.room_object!==actual.room_object)mismatches.push({actor:a.key??a.name,why:'wrong room'});
    for(const key of ['row','col','x','y'])if(want?.[key]!=null&&got[key]!==want[key])
      mismatches.push({actor:a.key??a.name,field:key,want:want[key],got:got[key]});
    if(a.angle?.v!=null&&got.angle!==a.angle.v)mismatches.push({actor:a.key??a.name,field:'angle',want:a.angle.v,got:got.angle});
    for(const kind of ['hp','mana','vigor'])for(const key of ['value','max']) {
      const value=a.vitals?.[kind]?.v?.[key];
      if(value!=null&&got[kind]?.[key]!==value)mismatches.push({actor:a.key??a.name,field:`${kind}.${key}`,want:value,got:got[kind]?.[key]});
    }
    for(const [name,value] of Object.entries(a.stats?.v??{})) {
      const raw=got.properties?.[('pi'+name).toLowerCase()]?.value;
      const gotValue=name==='karma'?raw/100:raw;
      if(Number.isFinite(value)&&gotValue!==value)mismatches.push({actor:a.key??a.name,field:name,want:value,got:gotValue??null});
    }
  }
  const addressed=new Set(bindings.values());
  const extra=actual.actors.filter(o=>!addressed.has(o.id)).map(o=>({id:o.id,class:o.class}));
  if(extra.length)mismatches.push({why:'extra room actors',actors:extra});
  return {ok:mismatches.length===0,mismatches,actors:actual.actors.length};
}

// Object ids legitimately differ across servers. Compare the known gameplay payload.
export function comparePlayerState(want,actual) {
  const mismatches=[];
  const items=xs=>(xs??[]).map(o=>({name:o.name,amount:o.amount??1,rarity:o.rarity??null}))
    .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const abilities=xs=>(xs??[]).map(o=>({name:o.name,kind:o.kind,ability:o.ability}))
    .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  for(const field of ['inventory','equipment','abilities']) {
    if(want[field]?.how!=='observed')continue;
    const normalize=field==='abilities'?abilities:items;
    if(actual[field]?.how!=='observed'||JSON.stringify(normalize(want[field].v))!==JSON.stringify(normalize(actual[field].v)))
      mismatches.push({field,why:'prepare the shadow character to match the recorded state before replay'});
  }
  return {ok:mismatches.length===0,mismatches};
}
