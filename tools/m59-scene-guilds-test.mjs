#!/usr/bin/env node
import assert from 'node:assert/strict';
import {normalizeSceneGuilds,prepareSceneGuilds} from './m59-scene-guilds.mjs';
const scene={room:{num:39},actors:[{key:'self',name:'Victim',kind:'player',mine:true},
  {key:'foe',name:'Morpheus',kind:'player'},{key:'friend',name:'Ally',kind:'player'}]};
const plan=normalizeSceneGuilds(scene,'opponents',{attackers:['Morpheus']});
assert.deepEqual(plan.assignments,{self:'Guild A',foe:'Guild B',friend:'Guild A'});
assert.deepEqual(normalizeSceneGuilds(scene,plan,{attackers:[]}),plan,'idle control keeps assignments');
assert.deepEqual(normalizeSceneGuilds(scene),{mode:'preserve'});
for(const input of [
  {mode:'bad'}, {mode:'preserve',assignments:{}},
  {assignments:{self:'A'}},
  {assignments:{self:'A',Victim:'A',foe:'B',friend:null}},
  {assignments:{self:'A\ncommand',foe:'B',friend:null}},
  {assignments:{self:'A ',foe:'B',friend:null}},
  {assignments:{self:'A',foe:'a',friend:null}},
  {...plan,relations:[{a:'Guild A',b:'Unknown',kind:'war'}]},
  {...plan,relations:[{a:'Guild A',b:'Guild B',kind:'war'},{a:'Guild B',b:'Guild A',kind:'neutral'}]},
])assert.throws(()=>normalizeSceneGuilds(scene,input));

const env={M59_ADMIN_HOST:'127.0.0.1',M59_ADMIN_PORT:'17998'},attestation={temporary_account_delete:'v1'};
const bindings=new Map([['self',1],['foe',2],['friend',3]]);
function fixture({lostCreate=false,refuseInduct=false,existingGuild=false}={}) {
  const commands=[],players=new Map([1,2,3].map(id=>[id,{guild:existingGuild?70:null,cooldown:100+id}]));
  const guilds=new Map(),resources=new Map();let next=1000;
  const readObjects=async ids=>ids.map(id=>{
    const p=players.get(id),g=guilds.get(id);
    if(p)return {id,class:'User',properties:{pihealth:{value:100},piguildrejointimestamp:{value:p.cooldown},
      ...(p.guild!=null?{poguild:{value:p.guild}}:{})}};
    if(g)return {id,class:'Guild',name:resources.get(g.resource),name_resource:g.resource,
      properties:g.members.length?{plmembers:{type:'LIST',value:id}}:{}};
    return {id,class:null,properties:{}};
  });
  const run=c=>{
    let m;
    if(c.startsWith('create resource ')){const id=next++;resources.set(id,c.slice(16));return `: ${id} (dynamic) = ${resources.get(id)}\n`;}
    if((m=/^create object Guild master OBJECT (\d+) guildname RESOURCE (\d+)$/.exec(c))){
      const id=next++,master=Number(m[1]);guilds.set(id,{resource:Number(m[2]),members:[master],enemies:new Set(),allies:new Set()});players.get(master).guild=id;
      return lostCreate?'':`Created object ${id}.`;
    }
    if((m=/^set object (\d+) piGuildRejoinTimestamp INT (\d+)$/.exec(c))){players.get(Number(m[1])).cooldown=Number(m[2]);return '';}
    if(c==='show list 99999')return ': [\n'+[...guilds].filter(([,g])=>!g.deleted).map(([id])=>`: OBJECT ${id}\n`).join('')+': ]\n';
    if((m=/^show list (\d+)$/.exec(c)))return ': [\n'+guilds.get(Number(m[1])).members.map(id=>`: [\n: OBJECT ${id}\n: INT 5\n: OBJECT ${id}\n: ]\n`).join('')+': ]\n';
    if((m=/^show object (\d+)$/.exec(c)))return 'guild object exists until GC';
    if((m=/^send object (\d+) (\w+)(.*)$/.exec(c))){
      const id=Number(m[1]),method=m[2],tail=m[3],g=guilds.get(id);
      if(method==='GetGuilds')return [...guilds.values()].some(g=>!g.deleted)?': LIST 99999\n':': $ 0\n';
      if(method==='FindRoomByNum')return ': OBJECT 50\n';
      if(method==='AllowGuildAttack')return ': INT 1\n';
      if(method==='InductNewMember'){
        const who=Number(/ who OBJECT (\d+)/.exec(tail)[1]);
        if(!refuseInduct){g.members.push(who);players.get(who).guild=id;}return ': INT 1\n';
      }
      if(method==='Delete'){for(const id of g.members){players.get(id).guild=null;players.get(id).cooldown=999;}g.members=[];g.deleted=true;return '';}
      if(method==='PayRent')return '';
      const other=Number(/ otherguild OBJECT (\d+)/.exec(tail)?.[1]);
      if(method==='NewEnemy'){g.enemies.add(other);return '';}
      if(method==='NewAlly'){g.allies.add(other);return '';}
      if(method==='IsEnemy'||method==='IsAlly')return `: INT ${Number((method==='IsEnemy'?g.enemies:g.allies).has(other))}\n`;
    }
    throw Error('unexpected native command '+c);
  };
  const dmFn=async cmds=>{commands.push(...cmds);return cmds.map(c=>c+'\n'+run(c)).join('\n');};
  return {dmFn,readObjects,commands,players,guilds};
}
for(const kind of ['neutral','allied','war']) {
  const f=fixture({lostCreate:kind==='war'}),input={...plan,relations:[{a:'Guild A',b:'Guild B',kind}]};
  const g=await prepareSceneGuilds({...f,scene,plan:input,bindings,env,attestation,nativeSnapshot:true});
  assert.equal(g.receipt.verification.memberships.length,2);
  assert.equal(g.receipt.verification.relationships[0].kind,kind);
  assert.equal(f.players.get(1).guild,f.players.get(3).guild);
  assert.notEqual(f.players.get(1).guild,f.players.get(2).guild);
  assert.equal(await g.guildAttackPermission(2,1),true);
  await g.close();assert.equal(g.receipt.cleanup.complete,true);
  assert.ok([...f.guilds.values()].every(g=>g.deleted));
  assert.ok([...f.players].every(([id,p])=>p.guild===null&&p.cooldown===100+id));
  const count=f.commands.length;await g.close();assert.equal(f.commands.length,count,'cleanup is idempotent');
}
for(const fault of ['refuseInduct','existingGuild']) {
  const f=fixture({[fault]:true});
  await assert.rejects(prepareSceneGuilds({...f,scene,plan,bindings,env,attestation,nativeSnapshot:true}),/roster mismatch|unguilded/);
  assert.ok([...f.guilds.values()].every(g=>g.deleted),'failed setup removes only created guilds');
  if(fault==='existingGuild')assert.equal(f.commands.length,0,'existing guilds are never modified');
}
{
  const f=fixture(),g=await prepareSceneGuilds({...f,scene,plan,bindings,env,attestation,nativeSnapshot:true});
  const id=f.players.get(1).guild;
  f.players.get(1).guild=null;
  await assert.rejects(g.verify(),/pointer mismatch/,'start must refuse a stale membership');
  f.players.get(1).guild=id;
  f.guilds.get(id).members.push(99);
  await assert.rejects(g.close(),/unowned member/);
  assert.equal(g.receipt.cleanup.complete,false);
  assert.ok(!f.commands.includes(`send object ${id} Delete`),'never disband a guild containing an unowned actor');
  f.guilds.get(id).members=f.guilds.get(id).members.filter(member=>member!==99);
  await g.close();assert.equal(g.receipt.cleanup.complete,true,'verified recovery can retry teardown');
}
for(const extra of [{env:{...env,M59_ADMIN_PORT:'9998'}},{nativeSnapshot:false},{attestation:{}}]) {
  const f=fixture();await assert.rejects(prepareSceneGuilds({...f,scene,plan,bindings,env,attestation,nativeSnapshot:true,...extra}),/owned isolated/);
  assert.equal(f.commands.length,0);
}
console.log('Scene guild teams, relations, native membership, silent refusal, lost reply, cleanup and lab gates passed');
