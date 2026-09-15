#!/usr/bin/env node
// Offline evidence queries/backfill and explicitly assumed simulator loadouts.
import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {appendEvidence,readEvidence} from './m59-player-evidence-store.mjs';
import {parsePlayerCombat,isIncomingHit,estimatePlayer,weaponModel} from './m59-player-evidence.mjs';
import {readReplay} from './m59-death-replay.mjs';
import {readLoadoutFile,validateLoadout,writeLoadoutFile} from './m59-scene-loadout.mjs';

export async function backfillPlayerEvidence({postmortems,server,dir}={}) {
  if(!server)throw Error('explicit source server host:port required');
  const existing=await readEvidence({dir,server}),key=r=>[r.character,r.observer,r.at,r.text].join('|'),seen=new Set(existing.map(key));
  const rows=[],warnings=[];let files=0;
  for(const name of (await readdir(postmortems)).filter(f=>f.endsWith('.json')).sort()) {
    const file=path.join(postmortems,name),pm=JSON.parse(await readFile(file,'utf8'));
    if(!pm.character||!Array.isArray(pm.text))continue;
    let bundle=null;
    if(pm.replay?.file)try{bundle=await readReplay(path.resolve(postmortems,pm.replay.file));}
    catch(e){warnings.push({file:name,error:e.message});}
    files++;
    const frames=bundle?.frames??[],messages=pm.text.filter(e=>!e.kind||e.kind==='message');
    const names=[...new Set([...(pm.threats?.players_present??[]),...(pm.frames??[]).flatMap(f=>f.players_present??[]),
      ...frames.flatMap(f=>(f.scene?.actors??[]).filter(a=>a.kind==='player'&&!a.mine).map(a=>a.name))])];
    for(const e of messages) {
      const parsed=parsePlayerCombat(e.text,names);if(!parsed||!Number.isFinite(e.at))continue;
      const f=frames.filter(f=>f.at<=e.at+30).at(-1),self=f?.scene?.actors?.find(a=>a.mine);
      const room=f?.scene?.room?.num??pm.frames?.filter(f=>f.at<=e.at).at(-1)?.num??null;
      const losses=frames.filter(f=>f.reason==='health_loss'&&Math.abs(f.event?.at-e.at)<=800&&f.scene?.room?.num===room);
      const row={type:'combat',server,character:parsed.character,observer:pm.character,agent:pm.agent,room,at:e.at,...parsed,
        target_state:self?{stats:self.stats?.v,health:self.vitals?.hp?.v,abilities:self.abilities?.v,equipment:self.equipment?.v}:null,
        health_window:losses.flatMap(f=>[{at:f.event.at,hp:f.event.before,max:f.event.max},
          {at:f.event.at,hp:f.event.value,max:f.event.max}]),
        competing_hits:messages.filter(m=>m!==e&&Math.abs(m.at-e.at)<=800&&isIncomingHit(m.text)),
        window_interrupted:false,source:{kind:'postmortem-backfill',file:name,replay_id:bundle?.id??null,
          hp_source:losses.length?'checksummed replay health_loss before/value pushes':'unavailable',
          packet_window_complete:false},
        provenance:bundle?.provenance?{harness:{...bundle.provenance.harness,files:undefined},server:bundle.provenance.server}:null};
      if(!seen.has(key(row))){seen.add(key(row));rows.push(row);}
    }
  }
  await appendEvidence(rows,{dir,writer:'backfill-'+process.pid});return {files,added:rows.length,warnings};
}
export function modeledLoadout(estimate,template,{offense}={}) {
  validateLoadout(template);
  const weapon=weaponModel(estimate.latest_weapon??'');if(!weapon)throw Error('no recognized observed weapon to model');
  if(!Number.isInteger(offense)||offense<1||offense>99)throw Error('choose an explicit offensive skill scenario, 1..99');
  const result=structuredClone(template);
  if(estimate.defensive_skills.some(s=>s.name==='block')&&!result.items.some(i=>i.equipped&&/shield/i.test(i.class)))
    throw Error('99% block needs an equipped shield in the modeled template; its exact type remains an explicit equipment assumption');
  if(!result.items.some(i=>i.equipped&&i.class.toLowerCase()===weapon.class.toLowerCase()))
    throw Error('template must equip the observed weapon class: '+weapon.class);
  const ring=estimate.operator_facts.some(r=>r.fact.item==='BerserkerRing'&&(r.room==null||r.room===estimate.room));
  if(result.items.some(i=>i.equipped&&i.class.toLowerCase()==='berserkerring')!==ring)
    throw Error('template berserker ring differs from the room-scoped evidence; select a matching template');
  const updates=new Map([[weapon.proficiency,offense],[weapon.stroke,offense],...estimate.defensive_skills.map(s=>[s.id,s.ability])]);
  result.skills=result.skills.filter(v=>!updates.has(Math.floor(Math.abs(v)/100)));
  for(const [id,ability] of updates)result.skills.push(id*100+ability);
  result.source={kind:'evidence-informed-model',character:estimate.character,room:estimate.room,
    observed_weapon:estimate.latest_weapon,offensive_skill_scenario:offense,defensive_skills:estimate.defensive_skills,
    operator_facts:estimate.operator_facts,template_source:template.source,
    historical_loadout_verified:false,
    assumptions:'Remaining skills, spells, armor, enchantments and durability come from the template. Dropped items are carried inventory evidence, never automatically equipped.'};
  return validateLoadout(result);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [action,character,...args]=process.argv.slice(2),arg=k=>{const i=args.indexOf(k);return i<0?undefined:args[i+1];};
    const server=arg('--server'),dir=arg('--dir'),room=arg('--room')==null?null:Number(arg('--room'));
    if(!server)throw Error('explicit --server HOST:PORT required; this command never connects to the game');
    if(action==='backfill')console.log(JSON.stringify(await backfillPlayerEvidence({postmortems:character,server,dir}),null,2));
    else if(action==='fact') {
      const item=arg('--item'),source=arg('--source');if(!character||!item||!source)throw Error('fact requires CHARACTER --item CLASS --source DESCRIPTION [--room NUM]');
      await appendEvidence([{type:'operator_fact',server,character,room,at:Date.now(),fact:{item,equipped:true},source}],{dir,writer:'operator-'+process.pid});
      console.log(JSON.stringify({recorded:true,character,room,item}));
    }else if(['estimate','model'].includes(action)) {
      const estimate=estimatePlayer(await readEvidence({dir,server,character}),{character,room,
        ...(arg('--since')?{since:Date.parse(arg('--since'))}:{}),...(arg('--until')?{until:Date.parse(arg('--until'))}:{}),
        ...(arg('--defense')?{defense:Number(arg('--defense'))}:{}),...(arg('--aim')?{aim:Number(arg('--aim'))}:{}),
        ...(arg('--max-hp')?{maxHp:Number(arg('--max-hp'))}:{})});
      if(action==='model') {
        if(!arg('--template')||!arg('--out'))throw Error('model requires --template LOADOUT --offense 1..99 --out LOADOUT');
        const result=modeledLoadout(estimate,await readLoadoutFile(arg('--template')),{offense:Number(arg('--offense'))});
        await writeLoadoutFile(arg('--out'),result);console.log(JSON.stringify({file:arg('--out'),source:result.source},null,2));
      }else if(arg('--out')){await writeFile(arg('--out'),JSON.stringify(estimate,null,2));console.log('wrote '+arg('--out'));}
      else console.log(JSON.stringify(estimate,null,2));
    }else throw Error('usage: m59-player-intel.mjs estimate|fact|model CHARACTER | backfill POSTMORTEM_DIR --server HOST:PORT [--dir EVIDENCE_DIR]');
  }catch(e){console.error(e.message);process.exitCode=1;}
}
