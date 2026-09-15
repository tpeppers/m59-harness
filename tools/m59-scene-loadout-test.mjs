#!/usr/bin/env node
// Offline native-admin fixture: no socket, Docker, roster or credentials.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseLoadoutList,validateLoadout,loadoutForActor,validateLoadoutBindings,loadoutSignature,
  capturePlayerLoadout,verifyPlayerLoadout,restorePlayerLoadout,armPlayerLoadoutTimers,
  readLoadoutFile,writeLoadoutFile,readLoadoutBindings} from './m59-scene-loadout.mjs';
import {replayPlayerPlan} from './m59-replay-players.mjs';
const env={M59_ADMIN_HOST:'127.0.0.1',M59_ADMIN_PORT:'17998'};
const profile=()=>({schema:'m59-player-loadout/v1',complete:true,gaps:[],items:[
  {key:'axe',class:'Axe',equipped:true,fields:{pihits_init:300,pihits:70,piitem_flags:0,
    piattack_type:132,piattack_spell:0,pidamagebonus:3,pihitbonus:6},attributes:[[6201,{timer_ms:30000}],[901]]},
  {key:'coat',class:'LeatherArmor',equipped:true,fields:{pihits_init:350,pihits:80,piitem_flags:247,
    pidefense_bonus:50,pidamage_reduce:0},attributes:[]}
],skills:[-43033,40191],spells:[-6176,6377],source:{kind:'test-fixture'}});
function native({refuseUse=false}={}) {
  let nextObject=20,nextList=10,nextTimer=1;
  const objects=new Map([[1,{class:'User',pihealth:100,plpassive:[],plusing:[],plskills:[],plspells:[]}]]),
    lists=new Map(),timers=new Map(),commands=[];
  const value=(tag,v)=>tag==='$'?null:tag==='INT'?Number(v):tag==='LIST'?structuredClone(lists.get(Number(v))):{type:tag,id:Number(v)};
  const render=v=>Array.isArray(v)?['[',...v.map(render),']'].join('\n: '):v===null?'$ 0':
    typeof v==='object'?v.type+' '+v.id:'INT '+v;
  const dmFn=async cmds=>cmds.map(c=>{
    commands.push(c);const t=c.split(' ');let out='';
    if(c.startsWith('show object ')) {
      const o=objects.get(Number(t[2]));if(!o)return c+'\nCannot find object';
      const lines=Object.entries(o).filter(([k])=>k!=='class').map(([k,v])=>{
        if(Array.isArray(v)){const id=nextList++;lists.set(id,structuredClone(v));return k+' = LIST '+id;}
        return k+' = '+render(v);
      });
      out='OBJECT '+t[2]+' is CLASS '+o.class+'\n'+lines.join('\n');
    }else if(c.startsWith('show list '))out=render(lists.get(Number(t[2])));
    else if(c.startsWith('create object ')) {
      const id=nextObject++,template=profile().items.find(i=>i.class===t[2]);
      if(!template)throw Error('fixture unknown class');
      objects.set(id,{class:t[2],...structuredClone(template.fields),poowner:null,piused:0,plitem_attributes:[]});
      out='Created object '+id+'.';
    }else if(c.startsWith('create listnode ')) {
      const id=nextList++;lists.set(id,[value(t[2],t[3]),...(value(t[4],t[5])??[])]);out='Created list node '+id+'.';
    }else if(c.startsWith('set object '))objects.get(Number(t[2]))[t[3].toLowerCase()]=value(t[4],t[5]);
    else if(c.startsWith('create timer ')) {
      const id=nextTimer++;timers.set(id,{item:Number(t[2]),at:Date.now(),ms:Number(t[4])});out='Created timer '+id+'.';
    }else if(c.startsWith('show timer ')) {
      const r=timers.get(Number(t[2]));out=r?`${t[2]} ${Math.max(0,r.ms-(Date.now()-r.at))} ${r.item} AttributeTimer`:'not found';
    }else if(c.startsWith('send object ')) {
      const id=Number(t[2]),o=objects.get(id),what=Number(t[6]);
      if(t[3]==='NewHold'){o.plpassive.unshift({type:'OBJECT',id:what});objects.get(what).poowner={type:'OBJECT',id};}
      else if(t[3]==='TryUseItem'){if(!refuseUse){o.plusing.unshift({type:'OBJECT',id:what});
        if(objects.get(what).class==='LeatherArmor')objects.get(what).piitem_flags=203;}}
      else if(t[3]==='TryUnuseItem')o.plusing=o.plusing.filter(x=>x.id!==what);
      else if(t[3]==='Delete'){objects.delete(id);for(const v of objects.values())if(v.plpassive)v.plpassive=v.plpassive.filter(x=>x.id!==id);}
      else if(['RefigureSchoolsLists','RecalcBulkAndWeight','RecalcLight','RecalcDrawFXFlags'].includes(t[3]))out='ok';
      else throw Error('fixture unexpected message: '+c);
    }else throw Error('fixture unexpected command: '+c);
    return c+'\n: '+out+'\n';
  }).join('');
  return {dmFn,objects,timers,commands};
}
assert.deepEqual(parseLoadoutList(': [\n: [\n: INT 6201\n: TIMER 14\n: ]\n: INT -43033\n: ]'),
  [[6201,{type:'TIMER',id:14}],-43033]);
assert.throws(()=>parseLoadoutList('[\nINT 1'),/incomplete/);
assert.throws(()=>parseLoadoutList('[\nSTRING 7\n]'),/unsupported/);
assert.throws(()=>validateLoadout({...profile(),complete:false,gaps:['bonded owner']}),/bonded owner/);
for(const change of [p=>p.items[0].attributes[0][1]={type:'OBJECT',id:99},
  p=>p.items[0].attributes[0].push({timer_ms:40}),p=>p.items[0].attributes[0].push([{timer_ms:40}]),
  p=>p.skills.push(43099),p=>p.items[0].fields.piHits=12]) {
  const p=profile();change(p);assert.throws(()=>validateLoadout(p));
}
const scene={actors:[{kind:'player',mine:true,key:'self',name:'Victim'},
  {kind:'player',key:'attacker',name:'Morpheus'}]},p=profile();
assert.equal(loadoutForActor(scene.actors[1],{morpheus:p}),p);
assert.throws(()=>validateLoadoutBindings(scene,{Missing:p}),/exactly one/);
assert.throws(()=>validateLoadoutBindings(scene,{Morpheus:p,attacker:p}),/ambiguous/);
assert.throws(()=>replayPlayerPlan(scene,{enabled:true,attackers:['Morpheus'],require_loadouts:true}),/missing/);
const options={enabled:true,attackers:['Morpheus'],require_loadouts:true,loadouts:{Morpheus:p},
  sequences:{morpheus:[{do:'cast',spell:'fireball'},{do:'attack',swings:2}]}};
assert.deepEqual(replayPlayerPlan(scene,options).actors[0].loadout,p);
assert.equal(replayPlayerPlan(scene,options).actors[0].sequence[0].spell,'fireball');
assert.equal(replayPlayerPlan(scene,options).actors[0].behavior,'sequence');
assert.throws(()=>replayPlayerPlan(scene,{...options,sequences:{typo:[]}}),/exactly one/);
assert.throws(()=>replayPlayerPlan(scene,{...options,sequences:{Morpheus:[],attacker:[]}}),/ambiguous/);
assert.throws(()=>replayPlayerPlan(scene,{...options,sequences:{Morpheus:[]}}),/nonempty/);
const n=native(),opts={env,dmFn:n.dmFn};
const restored=await restorePlayerLoadout(1,p,opts);
assert.equal(restored.ok,true);assert.equal(n.timers.size,0,'setup cannot consume enchantment time');
assert.ok(n.commands.indexOf('send object 1 RefigureSchoolsLists')<n.commands.indexOf('send object 1 TryUseItem what OBJECT 20'));
assert.ok(n.commands.includes('send object 1 RecalcBulkAndWeight'),'stack amount changes must update carried weight');
assert.equal((await verifyPlayerLoadout(1,p,{...opts,timersPaused:true})).ok,true);
const c=await capturePlayerLoadout(1,opts);
assert.deepEqual(loadoutSignature(c),loadoutSignature(p,'paused'));
for(const change of [x=>x.items[0].fields.pihits++,x=>x.items[0].fields.pidamagebonus++,
  x=>x.items[0].equipped=false,x=>x.skills[0]--,x=>x.spells.pop(),x=>x.items[0].class='Scimitar']) {
  const altered=structuredClone(p);change(altered);
  assert.equal((await verifyPlayerLoadout(1,altered,{...opts,timersPaused:true})).ok,false);
}
const armed=await restored.armTimers();assert.equal(armed.ok,true);assert.equal(armed.timers.length,1);
assert.ok(armed.timers[0].remaining_ms>29000);
await assert.rejects(restored.armTimers(),/already armed/);
await assert.rejects(armPlayerLoadoutTimers(1,p,opts),/changed/);
assert.equal((await verifyPlayerLoadout(1,p,opts)).ok,true);
const captured=await capturePlayerLoadout(1,opts);
assert.equal(captured.complete,true);
assert.deepEqual(loadoutSignature(captured),loadoutSignature(p));
assert.doesNotMatch(JSON.stringify(captured),/object_at_read|"type":"OBJECT"|"type":"TIMER"/);
const active=native();active.objects.get(1).plactive=[{type:'OBJECT',id:99}];
const unsupported=await capturePlayerLoadout(1,{env,dmFn:active.dmFn});
assert.equal(unsupported.complete,false);assert.throws(()=>validateLoadout(unsupported),/active held objects/);
const bad=native({refuseUse:true});
await assert.rejects(restorePlayerLoadout(1,p,{env,dmFn:bad.dmFn}),/did not match/);
assert.equal(bad.objects.size,1,'failed restoration cleans new items');
let called=false;await assert.rejects(restorePlayerLoadout(1,p,{env:{M59_ADMIN_HOST:'production'},dmFn:()=>{called=true;}}));
assert.equal(called,false,'lab gate precedes mutation');
const dir=await mkdtemp(path.join(tmpdir(),'m59-loadout-'));
try {
  const file=path.join(dir,'loadout.json'),map=path.join(dir,'map.json');
  await writeLoadoutFile(file,p);assert.deepEqual(await readLoadoutFile(file),p);
  await writeFile(map,JSON.stringify({Morpheus:'loadout.json'}));assert.deepEqual(await readLoadoutBindings(map),{Morpheus:p});
  const saved=JSON.parse(await readFile(file));saved.payload.items[0].fields.pihits++;
  await writeFile(file,JSON.stringify(saved));await assert.rejects(readLoadoutFile(file),/checksum/);
}finally{await rm(dir,{recursive:true,force:true});}
console.log('Loadout capture, restoration, exact readback, timer barrier, mapping, checksum and refusal tests passed');
