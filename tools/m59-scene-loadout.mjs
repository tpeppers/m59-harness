#!/usr/bin/env node
// Portable loadout state, shared by scene staging and temporary PvP players.
// Server object/list ids never leave capture. Unsupported state fails closed.
import {readFile,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {dm,split,sendMsg,resolve,rejections} from './m59-dm.mjs';
import {assertLab} from './m59-scene.mjs';
import {inspectSceneContainer} from './m59-scene-reset.mjs';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const int=x=>Number.isSafeInteger(x)&&Math.abs(x)<2**27;
const timer=x=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===1&&
  Number.isInteger(x.timer_ms)&&x.timer_ms>0&&x.timer_ms<=2147483647;
const field=k=>/^p[ib][a-z0-9_]+$/i.test(k)&&k.toLowerCase()!=='piused';
const clean=s=>String(s).split(/\r?\n/).map(l=>l.replace(/^:\s?/,'').trim());
export function parseLoadoutList(text) {
  const stack=[];let root=null;
  for(const line of clean(text)) {
    if(line==='['){const a=[];if(stack.length)stack.at(-1).push(a);else if(root)throw Error('multiple native lists');else root=a;stack.push(a);}
    else if(line===']'){if(!stack.length)throw Error('unbalanced native list');stack.pop();}
    else if(stack.length) {
      const m=/^(INT|OBJECT|TIMER|RESOURCE|\$) (-?\d+)$/.exec(line);
      if(!m)throw Error('unsupported or truncated native list value: '+line);
      stack.at(-1).push(m[1]==='INT'?Number(m[2]):m[1]==='$'?null:{type:m[1],id:Number(m[2])});
    }
  }
  if(!root||stack.length)throw Error('incomplete native list');return root;
}
function properties(text) {
  return Object.fromEntries([...String(text).matchAll(/\b(\w+)\s+=\s+(\w+|\$)\s+(-?\d+)/g)]
    .map(m=>[m[1].toLowerCase(),{type:m[2],value:Number(m[3])}]));
}
async function listProperty(p,opts) {
  if(p?.type==='$')return [];
  if(p?.type!=='LIST')throw Error('native loadout list unavailable');
  return parseLoadoutList(await opts.dmFn(['show list '+p.value],{env:opts.env}));
}
const primitiveList=(v,depth=0)=>Array.isArray(v)&&v.length<=512&&depth<8&&
  v.every(x=>x===null||int(x)||timer(x)||(Array.isArray(x)&&primitiveList(x,depth+1)));
export function validateLoadout(spec) {
  if(spec?.schema!=='m59-player-loadout/v1'||!Array.isArray(spec.items)||spec.items.length>256)
    throw Error('a m59-player-loadout/v1 specification is required');
  if(spec.complete!==true||(spec.gaps??[]).length)throw Error('loadout has missing or unsupported state: '+(spec.gaps??[]).join('; '));
  if(!Array.isArray(spec.skills)||!Array.isArray(spec.spells))throw Error('complete skill and spell lists are required');
  for(const entries of [spec.skills,spec.spells]) {
    if(entries.length>512||entries.some(v=>!int(v)||Math.floor(Math.abs(v)/100)<1)||
      new Set(entries.map(v=>Math.floor(Math.abs(v)/100))).size!==entries.length)
      throw Error('invalid or duplicate encoded abilities');
  }
  const keys=new Set();
  for(const item of spec.items) {
    if(typeof item.key!=='string'||!item.key||keys.has(item.key)||!/^[A-Za-z][A-Za-z0-9_]*$/.test(item.class)||
      typeof item.equipped!=='boolean')throw Error('invalid loadout item identity or equipment state');
    keys.add(item.key);
    if(!item.fields||Array.isArray(item.fields)||Object.entries(item.fields).some(([k,v])=>!field(k)||!int(v))||
      new Set(Object.keys(item.fields).map(k=>k.toLowerCase())).size!==Object.keys(item.fields).length)
      throw Error('invalid or duplicate loadout scalar field');
    if(!primitiveList(item.attributes)||item.attributes.some(a=>!Array.isArray(a)||!int(a[0])||
      a.some((v,i)=>Array.isArray(v)||(timer(v)&&i!==1))))
      throw Error('unsupported item attribute state; use a native server save for external references');
  }
  return spec;
}
export function loadoutForActor(actor,loadouts={}) {
  const matches=Object.entries(loadouts).filter(([key])=>[actor.key,actor.name].some(n=>
    typeof n==='string'&&n.toLowerCase()===key.toLowerCase()));
  if(matches.length>1)throw Error('ambiguous loadout for '+actor.name);
  const value=matches[0]?.[1]??actor.loadout?.v??actor.loadout;
  return value?validateLoadout(value):null;
}
export function validateLoadoutBindings(scene,loadouts={}) {
  if(!loadouts||Array.isArray(loadouts)||typeof loadouts!=='object')throw Error('loadouts must map captured names or actor keys to specifications');
  for(const key of Object.keys(loadouts)) {
    const matches=(scene.actors??[]).filter(a=>a.kind==='player'&&[a.key,a.name].some(n=>n?.toLowerCase()===key.toLowerCase()));
    if(matches.length!==1)throw Error('loadout must identify exactly one captured player: '+key);
  }
  for(const a of scene.actors??[])if(a.kind==='player')loadoutForActor(a,loadouts);
}
async function readState(id,{env=process.env,dmFn=dm}={}) {
  assertLab(env);const opts={env,dmFn};
  const head=await dmFn(['show object '+id],{env}),p=properties(head);
  if(p.pihealth==null)throw Error('loadout source must be a player');
  const [pack,using,skills,spells]=await Promise.all(['plpassive','plusing','plskills','plspells'].map(k=>listProperty(p[k],opts)));
  if(pack.some(x=>x?.type!=='OBJECT')||using.some(x=>x?.type!=='OBJECT'))throw Error('invalid native inventory');
  const commands=pack.map(x=>'show object '+x.id),out=commands.length?await dmFn(commands,{env}):'';
  const blocks=split(out,commands),gaps=[],items=[];
  if(p.plactive&&(await listProperty(p.plactive,opts)).length)
    gaps.push('active held objects require a native checkpoint');
  for(let i=0;i<pack.length;i++) {
    const raw=blocks[i],q=properties(raw),itemId=pack[i].id;
    if(q.poowner?.value!==id)throw Error('inventory changed during capture');
    const cls=/is CLASS (\w+)/.exec(raw)?.[1];
    if(!cls||q.pihits==null||q.plitem_attributes==null)throw Error('non-item or incomplete inventory object');
    const attributes=await listProperty(q.plitem_attributes,opts);
    for(const attr of attributes)if(Array.isArray(attr))for(let n=0;n<attr.length;n++) {
      if(attr[n]?.type==='TIMER'&&n===1) {
        const text=await dmFn(['show timer '+attr[n].id],{env});
        const m=new RegExp('^\\s*:?\\s*'+attr[n].id+'\\s+(\\d+)\\s+'+itemId+'\\s+AttributeTimer\\s*$','m').exec(text);
        if(!m||!timer({timer_ms:Number(m[1])}))throw Error('item attribute timer expired or changed during capture');
        attr[n]={timer_ms:Number(m[1])};
      }
    }
    if(!primitiveList(attributes))gaps.push(cls+': item attributes contain external references');
    for(const [k,v] of Object.entries(q))if(!['self','poowner','piused','plitem_attributes'].includes(k)&&
      !(v.type==='INT'&&field(k))&&v.type!=='$')gaps.push(cls+': unsupported '+k+' '+v.type);
    items.push({key:'item-'+i,class:cls,equipped:using.some(x=>x.id===itemId),
      fields:Object.fromEntries(Object.entries(q).filter(([k,v])=>v.type==='INT'&&field(k)).map(([k,v])=>[k,v.value])),
      attributes,object_at_read:itemId});
  }
  if(using.some(x=>!pack.some(y=>y.id===x.id)))gaps.push('equipped objects outside the inventory');
  return {schema:'m59-player-loadout/v1',complete:!gaps.length,gaps,items,skills,spells};
}
const timerState=(value,mode)=>Array.isArray(value)?value.map(v=>timerState(v,mode)):
  timer(value)&&mode!=='duration'?(mode==='paused'?null:{timer:true}):value;
const stableItem=(i,mode)=>({class:i.class.toLowerCase(),equipped:i.equipped,
  fields:Object.fromEntries(Object.entries(i.fields).map(([k,v])=>[k.toLowerCase(),v]).sort()),attributes:timerState(i.attributes,mode)});
export function loadoutSignature(spec,mode='state') {
  return {items:spec.items.map(i=>stableItem(i,mode)).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
    skills:[...spec.skills].sort((a,b)=>a-b),spells:[...spec.spells].sort((a,b)=>a-b)};
}
export async function capturePlayerLoadout(id,opts={}) {
  const first=await readState(id,opts),second=await readState(id,opts);
  if(JSON.stringify(loadoutSignature(first))!==JSON.stringify(loadoutSignature(second))||
    JSON.stringify(first.gaps)!==JSON.stringify(second.gaps))
    throw Error('loadout changed during capture; retry from a quiet/held checkpoint');
  const portable=structuredClone(second);
  for(const item of portable.items)delete item.object_at_read;
  const redact=v=>Array.isArray(v)?v.map(redact):v?.type?{unsupported:v.type}:v;
  for(const item of portable.items)item.attributes=redact(item.attributes);
  return {...portable,source:{kind:'lab-capture',captured_at:new Date().toISOString(),...opts.source}};
}
export async function verifyPlayerLoadout(id,spec,opts={}) {
  const got=await readState(id,opts),want=loadoutSignature(validateLoadout(spec),opts.timersPaused?'paused':'state'),actual=loadoutSignature(got);
  return {ok:got.complete&&JSON.stringify(want)===JSON.stringify(actual),
    specification_sha256:hash(loadoutSignature(spec,'duration')),
    expected_state_sha256:hash(want),actual_state_sha256:hash(actual),gaps:got.gaps,
    ...(JSON.stringify(want)!==JSON.stringify(actual)?{expected:want,actual}:{}),
    historical_loadout_verified:false,source:spec.source??{kind:'supplied'},
    scope:'item classes, scalar properties, attributes, equipment, skills and spells',
    timers:opts.timersPaused?'paused until scene start':'running (remaining durations checked separately when armed)'};
}
async function makeList(values,opts,itemId=null,timerReceipts=null) {
  let tail=['$',0];
  for(const value of [...values].reverse()) {
    let head=Array.isArray(value)?await makeList(value,opts,itemId,timerReceipts):value===null?['$',0]:['INT',value];
    if(timer(value)) {
      if(!timerReceipts)head=['$',0];
      else {
        const at=Date.now(),text=await opts.dmFn([`create timer ${itemId} AttributeTimer ${value.timer_ms}`],{env:opts.env});
        const timerId=Number(/Created timer (\d+)/.exec(text)?.[1]);if(!timerId)throw Error('item timer creation did not confirm');
        head=['TIMER',timerId];timerReceipts.push({item:itemId,timerId,requested_ms:value.timer_ms,armed_at:at});
      }
    }
    const out=await opts.dmFn([`create listnode ${head[0]} ${head[1]} ${tail[0]} ${tail[1]}`],{env:opts.env});
    const id=Number(/Created list node (\d+)/.exec(out)?.[1]);if(!id)throw Error('loadout list creation did not confirm');
    tail=['LIST',id];
  }
  return tail;
}
export async function restorePlayerLoadout(id,spec,{env=process.env,dmFn=dm}={}) {
  assertLab(env);validateLoadout(spec);const opts={env,dmFn},created=[];
  const before=await readState(id,opts);
  // Callers hold the scene and own the target. All removed ids were just read
  // from this exact player's inventory. No saved object id is ever addressed.
  const remove=before.items.flatMap(i=>[sendMsg(id,'TryUnuseItem',{what:['OBJECT',i.object_at_read]}),sendMsg(i.object_at_read,'Delete')]);
  if(remove.length)await dmFn(remove,{env});
  try {
    // Install abilities before equipment eligibility checks, then rebuild the
    // server's derived school totals used by spell/skill calculations.
    for(const [property,values] of [['plSkills',spec.skills],['plSpells',spec.spells]]) {
      const list=await makeList(values,opts);
      await dmFn([`set object ${id} ${property} ${list[0]} ${list[1]}`],{env});
    }
    const schools=await dmFn([sendMsg(id,'RefigureSchoolsLists')],{env});
    if(rejections(schools).length)throw Error('ability school recalculation rejected');
    for(const item of spec.items) {
      const out=await dmFn(['create object '+item.class],{env});
      const obj=Number(/Created object (\d+)/.exec(out)?.[1]);if(!obj)throw Error('loadout item creation failed: '+item.class);
      created.push(obj);
      const raw=await dmFn(['show object '+obj],{env}),props=properties(raw);
      if(props.pihits==null||props.plitem_attributes==null)throw Error('loadout class is not an item');
      const missing=Object.keys(item.fields).filter(k=>props[k.toLowerCase()]?.type!=='INT');
      if(missing.length)throw Error('loadout fields do not exist in this server class: '+missing.join(', '));
      const oldAttributes=await listProperty(props.plitem_attributes,opts);
      if(oldAttributes.length)await dmFn(oldAttributes.map(a=>sendMsg(obj,'RemoveAttribute',{ItemAtt:['INT',Math.floor(a[0]/100)]})),{env});
      // NewHold runs ownership hooks before exact properties are installed.
      await dmFn([sendMsg(id,'NewHold',{what:['OBJECT',obj]})],{env});
      const attributes=await makeList(item.attributes,opts);
      const commands=Object.entries(item.fields).map(([k,v])=>`set object ${obj} ${k} INT ${v}`);
      commands.push(`set object ${obj} plItem_attributes ${attributes[0]} ${attributes[1]}`);
      if(item.equipped) {
        commands.push(sendMsg(id,'TryUseItem',{what:['OBJECT',obj]}));
        // Clothing use can recolor itself for the stand-in's appearance. Keep
        // the captured item properties while still requiring normal use success.
        commands.push(...Object.entries(item.fields).map(([k,v])=>`set object ${obj} ${k} INT ${v}`));
      }
      if(rejections(await dmFn(commands,{env})).length)throw Error('loadout item restoration rejected');
    }
    const totals=await dmFn(['RecalcBulkAndWeight','RecalcLight','RecalcDrawFXFlags'].map(msg=>sendMsg(id,msg)),{env});
    if(rejections(totals).length)throw Error('derived inventory state recalculation rejected');
    const verified=await verifyPlayerLoadout(id,spec,{...opts,timersPaused:true});
    if(!verified.ok)throw Error('restored loadout did not match specification: '+JSON.stringify(verified));
    let armed=false;
    return {...verified,async armTimers(){
      if(armed)throw Error('loadout timers already armed');armed=true;
      return armPlayerLoadoutTimers(id,spec,opts);
    }};
  }catch(e){
    // Even a failure before NewHold must not strand a newly created object.
    if(created.length)await dmFn(created.map(obj=>sendMsg(obj,'Delete')),{env}).catch(()=>{});
    throw e;
  }
}
// Public so a serialized prepare receipt can be released from another CLI process.
// Bind to freshly read items by complete state, never to saved native object ids.
export async function armPlayerLoadoutTimers(id,spec,opts={}) {
  validateLoadout(spec);
  const current=await readState(id,opts),env=opts.env??process.env,dmFn=opts.dmFn??dm;
  if(!current.complete||JSON.stringify(loadoutSignature(current))!==JSON.stringify(loadoutSignature(spec,'paused')))
    throw Error('cannot arm timers: prepared loadout changed');
  const remaining=[...current.items],receipts=[],began=Date.now();
  for(const item of spec.items) {
    const index=remaining.findIndex(got=>JSON.stringify(stableItem(got,'state'))===JSON.stringify(stableItem(item,'paused')));
    const [got]=remaining.splice(index,1),obj=got.object_at_read;
    if(item.attributes.some(a=>a.some(timer))) {
      const list=await makeList(item.attributes,{env,dmFn},obj,receipts);
      const response=await dmFn([`set object ${obj} plItem_attributes ${list[0]} ${list[1]}`],{env});
      if(rejections(response).length)throw Error('item enchantment timer installation rejected');
    }
  }
  for(const r of receipts) {
    const text=await dmFn(['show timer '+r.timerId],{env});
    const m=new RegExp('^\\s*:?\\s*'+r.timerId+'\\s+(\\d+)\\s+'+r.item+'\\s+AttributeTimer\\s*$','m').exec(text);
    r.remaining_ms=m?Number(m[1]):null;
    if(r.remaining_ms==null||Math.abs(r.remaining_ms-(r.requested_ms-(Date.now()-r.armed_at)))>250)
      throw Error('item enchantment timer did not verify before start');
  }
  return {ok:true,started_at:began,completed_at:Date.now(),timers:receipts.map(({timerId,item,...r})=>r),
    note:'Timers start just before room release; measured setup skew is reported, not assumed zero.'};
}
export async function readLoadoutFile(file) {
  const data=JSON.parse(await readFile(file,'utf8'));
  if(data.schema==='m59-player-loadout-file/v1') {
    if(data.sha256!==hash(data.payload))throw Error('loadout checksum mismatch');return validateLoadout(data.payload);
  }
  return validateLoadout(data);
}
export async function readLoadoutBindings(file) {
  const map=JSON.parse(await readFile(file,'utf8')),base=path.dirname(path.resolve(file));
  if(!map||Array.isArray(map)||typeof map!=='object')throw Error('loadout file must map player names/keys to profiles');
  return Object.fromEntries(await Promise.all(Object.entries(map).map(async([key,value])=>[key,
    typeof value==='string'?await readLoadoutFile(path.resolve(base,value)):validateLoadout(value)])));
}
export async function writeLoadoutFile(file,payload) {
  await writeFile(file+'.tmp',JSON.stringify({schema:'m59-player-loadout-file/v1',sha256:hash(payload),payload},null,2));
  await rename(file+'.tmp',file);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [action,player,...args]=process.argv.slice(2),out=args[args.indexOf('--out')+1];
    if(action!=='capture'||!player||!args.includes('--out'))throw Error('usage: m59-scene-loadout.mjs capture SHADOW_PLAYER --out LOADOUT.json');
    const info=inspectSceneContainer(),env={...process.env,M59_ADMIN_HOST:'127.0.0.1',M59_ADMIN_PORT:'17998'};
    const id=(await resolve([player],{env}))[player];if(!id)throw Error('shadow player was not found');
    const payload=await capturePlayerLoadout(id,{env,source:{character:player,image:info.Image,
      server_commit:info.Config.Labels?.['org.openai.m59.scene-hold.source-commit']}});
    await writeLoadoutFile(out,payload);
    console.log(JSON.stringify({file:out,complete:payload.complete,gaps:payload.gaps,items:payload.items.length,
      skills:payload.skills.length,spells:payload.spells.length}));
  }catch(e){console.error(e.message);process.exitCode=1;}
}
