// Native guild fixtures for the owned scene lab. Combat/room rules stay unchanged.
import {randomBytes} from 'node:crypto';
import {dm,sendMsg,setProp,split} from './m59-dm.mjs';
import {readAdminObjects} from './m59-scene-admin.mjs';
import {parseLoadoutList} from './m59-scene-loadout.mjs';
import {resolveRoom} from './m59-scene.mjs';

const norm=s=>String(s??'').trim().toLowerCase();
const key=a=>a.key??a.name;
const integerReturn=s=>{const m=/^:\s+INT (-?\d+)\s*$/m.exec(s);return m?Number(m[1]):null;};
export function normalizeSceneGuilds(scene,input='preserve',{attackers=[]}={}) {
  if(typeof input==='string')input={mode:input};
  if(!input||Array.isArray(input)||typeof input!=='object'||
      Object.keys(input).some(k=>!['mode','assignments','relations'].includes(k)))throw Error('invalid guild setup options');
  const mode=input.mode??'teams',players=(scene.actors??[]).filter(a=>a.kind==='player');
  if(mode==='preserve') {
    if(input.assignments||input.relations)throw Error('preserve guild mode cannot assign teams or relations');
    return {mode:'preserve'};
  }
  if(!['opponents','teams'].includes(mode))throw Error('guild mode must be opponents, teams or preserve');
  let assignments=input.assignments;
  if(mode==='opponents') {
    if(input.assignments||input.relations)throw Error('opponents guild mode uses its generated teams; use teams for custom relations');
    const selected=new Set(attackers.map(n=>{
      const found=players.filter(a=>[a.key,a.name].some(v=>norm(v)===norm(n)));
      if(found.length!==1||found[0].mine)throw Error('guild opponent must identify one other captured player');
      return key(found[0]);
    }));
    assignments=Object.fromEntries(players.map(a=>[key(a),selected.has(key(a))?'Guild B':'Guild A']));
  }
  if(!assignments||Array.isArray(assignments)||typeof assignments!=='object')throw Error('guild assignments must map every player to a team or null');
  const resolved={},labels=new Map();
  for(const [name,team] of Object.entries(assignments)) {
    const found=players.filter(a=>[a.key,a.name].some(v=>norm(v)===norm(name)));
    if(found.length!==1||Object.hasOwn(resolved,key(found[0])))throw Error('guild assignment must identify exactly one player: '+name);
    if(team!==null&&(typeof team!=='string'||team!==team.trim()||!/^[A-Za-z][A-Za-z0-9 _-]{0,15}$/.test(team)))throw Error('guild team names must be 1..16 simple characters without surrounding whitespace');
    if(team!==null) {
      if(labels.has(norm(team))&&labels.get(norm(team))!==team)throw Error('guild team names differ only in case');
      labels.set(norm(team),team);
    }
    resolved[key(found[0])]=team;
  }
  if(players.some(a=>!Object.hasOwn(resolved,key(a))))throw Error('guild assignments must include every captured player (null leaves one unguilded)');
  const relations=input.relations??[],seen=new Set();
  if(!Array.isArray(relations))throw Error('guild relations must be an array');
  for(const r of relations) {
    if(!r||Object.keys(r).some(k=>!['a','b','kind'].includes(k))||!labels.has(norm(r.a))||!labels.has(norm(r.b))||
        labels.get(norm(r.a))!==r.a||labels.get(norm(r.b))!==r.b||r.a===r.b||!['neutral','allied','war'].includes(r.kind))
      throw Error('guild relations need distinct existing teams and neutral, allied or war');
    const pair=[r.a,r.b].sort().join('\0');if(seen.has(pair))throw Error('duplicate guild relationship');seen.add(pair);
  }
  return {mode:'teams',assignments:resolved,relations:structuredClone(relations)};
}

export async function prepareSceneGuilds({scene,plan,bindings,attestation,nativeSnapshot=false,
    env,dmFn=dm,readObjects=readAdminObjects,onReceipt=async()=>{}}={}) {
  if(plan.mode==='preserve')return {receipt:{mode:'preserve',modeled:false},verify:async()=>{},close:async()=>{}};
  if(env?.M59_ADMIN_HOST!=='127.0.0.1'||Number(env.M59_ADMIN_PORT)!==17998||attestation?.temporary_account_delete!=='v1'||!nativeSnapshot)
    throw Error('guild fixtures require the owned isolated scene container and a native_snapshot reset');
  const began=Date.now(),opts={env,dmFn},owned=new Set(),groups=[],original=[];
  const receipt={schema:'m59-scene-guilds/v1',mode:'teams',modeled:true,plan,groups,
    assumptions:['Guild membership and relationships are explicit lab fixtures, not verified historical guild intelligence.'],
    cleanup:{complete:false}};
  const ids=Object.keys(plan.assignments).map(k=>bindings.get(k));
  if(ids.some(id=>!Number.isInteger(id)||id<=0)||new Set(ids).size!==ids.length)throw Error('guild actors need unique bound player identities');
  const actors=await readObjects(ids,opts);
  for(const [i,id] of ids.entries()) {
    const actor=actors.find(a=>a.id===id);
    if(!actor?.properties?.pihealth||actor.properties.poguild?.value!=null)
      throw Error('guild fixtures require unguilded lab players; restore an unguilded native baseline or use preserve mode');
    const cooldown=actor.properties.piguildrejointimestamp?.value;
    if(!Number.isInteger(cooldown))throw Error('guild rejoin state unavailable');
    original.push({id,actor:Object.keys(plan.assignments)[i],rejoin_at:cooldown});owned.add(id);
  }
  receipt.original_members=original;
  const registry=async()=>{
    const response=await dmFn([sendMsg(0,'GetGuilds')],{env});
    if(/^:\s+\$ 0\s*$/m.test(response))return [];
    const list=/^:\s+LIST (\d+)\s*$/m.exec(response);
    if(!list)throw Error('native guild registry response missing');
    const values=parseLoadoutList(await dmFn(['show list '+list[1]],{env}));
    if(values.some(v=>v?.type!=='OBJECT'))throw Error('invalid native guild registry');
    return values.map(v=>v.id);
  };
  const nativeGroup=async g=>{
    const [actual]=await readObjects([g.id],opts);
    if(actual?.class!=='Guild'||actual.name!==g.name||actual.name_resource!==g.name_resource)throw Error('temporary guild identity did not verify');
    const list=actual.properties.plmembers;
    const members=list?parseLoadoutList(await dmFn(['show list '+list.value],{env})):[];
    if(members.some(m=>!Array.isArray(m)||m[0]?.type!=='OBJECT'||!owned.has(m[0].id)))throw Error('temporary guild contains an unowned member');
    return {actual,members:members.map(m=>m[0].id)};
  };
  const verify=async()=>{
    const actual=await readObjects(ids,opts),memberships=[],registered=await registry();
    for(const g of groups) {
      if(!registered.includes(g.id))throw Error('guild absent from server registry');
      const native=await nativeGroup(g);
      if(native.members.length!==g.members.length||g.members.some(id=>!native.members.includes(id)))throw Error('guild roster mismatch');
      for(const id of g.members)if(actual.find(a=>a.id===id)?.properties.poguild?.value!==g.id)throw Error('player-to-guild pointer mismatch');
      memberships.push({team:g.team,guild_id:g.id,name:g.name,actors:original.filter(a=>g.members.includes(a.id)).map(a=>a.actor),verified:true});
    }
    for(const a of original)if(plan.assignments[a.actor]===null&&actual.find(o=>o.id===a.id)?.properties.poguild?.value!=null)throw Error('unguilded actor unexpectedly joined a guild');
    const relationships=[];
    for(const r of plan.relations) {
      const a=groups.find(g=>g.team===r.a).id,b=groups.find(g=>g.team===r.b).id;
      const cmds=[sendMsg(a,'IsEnemy',{otherguild:['OBJECT',b]}),sendMsg(b,'IsEnemy',{otherguild:['OBJECT',a]}),
        sendMsg(a,'IsAlly',{otherguild:['OBJECT',b]}),sendMsg(b,'IsAlly',{otherguild:['OBJECT',a]})];
      const values=split(await dmFn(cmds,{env}),cmds).map(s=>integerReturn(s??''));
      const want=r.kind==='war'?[1,1,0,0]:r.kind==='allied'?[0,0,1,1]:[0,0,0,0];
      if(JSON.stringify(values)!==JSON.stringify(want))throw Error('guild relationship did not verify');
      relationships.push({...r,verified:true});
    }
    receipt.verification={at:Date.now(),memberships,relationships};await onReceipt(receipt);return receipt.verification;
  };
  const close=async()=>{
    if(receipt.cleanup.complete)return;
    const errors=[];
    for(const g of groups)if(g.id&&!g.deleted)try {
      const probe=await dmFn(['show object '+g.id],{env});
      if(!probe.includes(`Invalid object id ${g.id} (or it has been deleted).`)) {
        const before=await nativeGroup(g);
        if(before.members.length||(await registry()).includes(g.id))await dmFn([sendMsg(g.id,'Delete')],{env});
        // KOD Delete removes references; the object node survives until GC.
        // The authoritative result is no registry entry, members or live timers.
        const after=await nativeGroup(g);
        if(after.members.length||after.actual.properties.ptmaintenance||after.actual.properties['ptsuingforpeace'])
          throw Error('guild disband did not clear members and timers');
      }
      if((await registry()).includes(g.id))throw Error('guild remained in the server registry');
      g.deleted=true;
    }catch(e){errors.push({team:g.team,error:e.message});}
    if(!errors.length)try {
      const actual=await readObjects(ids,opts);
      if(actual.some(a=>a.properties.poguild?.value!=null))throw Error('player still guilded after cleanup');
      await dmFn(original.map(a=>setProp(a.id,'piGuildRejoinTimestamp',a.rejoin_at)),{env});
      const restored=await readObjects(ids,opts);
      if(original.some(a=>restored.find(o=>o.id===a.id)?.properties.piguildrejointimestamp?.value!==a.rejoin_at))throw Error('guild cooldown restoration not confirmed');
    }catch(e){errors.push({error:e.message});}
    receipt.cleanup={complete:errors.length===0,errors};await onReceipt(receipt);
    if(errors.length)throw Error('temporary guild cleanup failed: '+JSON.stringify(errors));
  };
  try {
    await onReceipt(receipt);
    await dmFn(original.map(a=>setProp(a.id,'piGuildRejoinTimestamp',0)),{env});
    for(const team of new Set(Object.values(plan.assignments).filter(x=>x!==null))) {
      const g={team,name:`Sim ${randomBytes(3).toString('hex')} ${team}`,
        members:original.filter(a=>plan.assignments[a.actor]===team).map(a=>a.id),id:null,deleted:false};
      groups.push(g);await onReceipt(receipt);
      const named=await dmFn(['create resource '+g.name],{env});
      const resource=/^\s*:?\s*(\d+)\s+\(dynamic\) = ([^\r\n]+)\r?$/m.exec(named);
      g.name_resource=Number(resource?.[1]);
      if(!g.name_resource||resource[2]!==g.name)throw Error('guild name resource creation not confirmed');
      // Constructor registers the guild, sets its master, roster and command powers.
      // Recover the exact created identity from the founder if the reply was lost.
      const made=await dmFn([`create object Guild master OBJECT ${g.members[0]} guildname RESOURCE ${g.name_resource}`],{env});
      g.id=Number(/Created object (\d+)/i.exec(made)?.[1])||null;
      if(!g.id)g.id=(await readObjects([g.members[0]],opts))[0]?.properties.poguild?.value??null;
      await onReceipt(receipt);if(!g.id)throw Error('guild creation not confirmed');
      await nativeGroup(g);
      await dmFn(g.members.slice(1).map(id=>sendMsg(g.id,'InductNewMember',{who:['OBJECT',id],inductor:['OBJECT',g.members[0]]})),{env});
    }
    for(const r of plan.relations)if(r.kind!=='neutral') {
      const a=groups.find(g=>g.team===r.a).id,b=groups.find(g=>g.team===r.b).id;
      if(r.kind==='war')await dmFn([a,b].map(id=>sendMsg(id,'PayRent',{amount:['INT',50000]})),{env});
      const method=r.kind==='war'?'NewEnemy':'NewAlly';
      await dmFn([sendMsg(a,method,{otherguild:['OBJECT',b]}),sendMsg(b,method,{otherguild:['OBJECT',a]})],{env});
    }
    await verify();receipt.preparation_ms=Date.now()-began;await onReceipt(receipt);
    return {receipt,verify,close,async guildAttackPermission(attacker,victim) {
      const room=await resolveRoom(scene.room.num,opts);
      const allowed=integerReturn(await dmFn([sendMsg(room,'AllowGuildAttack',{what:['OBJECT',attacker],victim:['OBJECT',victim]})],{env}));
      if(allowed==null)throw Error('room guild eligibility response missing');
      return allowed===1;
    }};
  }catch(e){try{await close();}catch(cleanup){e.message+='; '+cleanup.message;}throw e;}
}
