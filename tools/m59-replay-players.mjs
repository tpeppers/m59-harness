// Temporary, account-backed players for the owned scene lab. Uses ordinary CombatMode
// packets after the shared start barrier; no damage is injected by the admin socket.
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {dm,setProp,sendMsg,skillCmds,rejections} from './m59-dm.mjs';
import {readAdminObjects} from './m59-scene-admin.mjs';
import {planCharacter,STAT_PRESETS} from './m59-newchar.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const norm=x=>String(x??'').trim().toLowerCase();
export function replayPlayerPlan(scene,options={}) {
  if(options.enabled!==true)return {enabled:false,actors:[]};
  const allowed=new Set(['enabled','attackers','profile','allow_approximate_player']);
  if(Object.keys(options).some(k=>!allowed.has(k)))throw Error('unknown PvP simulation option');
  const players=(scene.actors??[]).filter(a=>a.kind==='player'&&!a.mine);
  if(players.length>32)throw Error('PvP simulation supports at most 32 other player bodies');
  const attackers=options.attackers??[];
  if(!Array.isArray(attackers)||attackers.some(x=>typeof x!=='string'||!x.trim()))throw Error('pvp.attackers must be an array of exact captured names or actor keys');
  const matches=attackers.map(n=>players.filter(a=>norm(a.key)===norm(n)||norm(a.name)===norm(n)));
  if(matches.some(m=>m.length!==1))throw Error('each PvP attacker must identify exactly one captured player');
  const chosen=new Set(matches.map(m=>m[0].key??m[0].name));
  const profile={stats:'melee',health:100,mana:50,vigor:200,unarmed:99,...options.profile};
  if(Object.keys(profile).some(k=>!['stats','health','mana','vigor','unarmed'].includes(k)))throw Error('unknown PvP player profile option');
  if(typeof profile.stats!=='string'||!STAT_PRESETS[profile.stats])throw Error('PvP stats must name a character-creation preset');
  for(const [k,max] of [['health',151],['mana',200],['vigor',200],['unarmed',99]])
    if(!Number.isInteger(profile[k])||profile[k]<(k==='health'?1:0)||profile[k]>max)throw Error('invalid PvP profile '+k);
  return {enabled:true,profile,actors:players.map(a=>({key:a.key??a.name,name:a.name,
    behavior:chosen.has(a.key??a.name)?'melee':'idle',position:a.at?.v??null})),
    allow_approximate_player:options.allow_approximate_player===true,
    assumptions:['Other-player stats, unarmed skill and equipment are modeled unless captured; temporary players are unarmed.',
      'Melee stand-ins use the harness combat controller in the captured room; historical human inputs are unknown.']};
}
export function assertTemporaryPlayerLab(env,attestation) {
  if(env?.M59_ADMIN_HOST!=='127.0.0.1'||Number(env?.M59_ADMIN_PORT)!==17998||
     attestation?.temporary_account_delete!=='v1')
    throw Error('automatic PvP stand-ins require the owned isolated scene image with temporary-account deletion support');
}
export function accountIdentity(output,account,id=null) {
  if(!/^replaysim_[a-f0-9]{12}$/.test(account))return null;
  const m=new RegExp('^\\s*:?[ \\t]*(\\d+)[ ADG]?\\s+'+account+'(?:\\s|$)','m').exec(output);
  return m&&(id==null||Number(m[1])===id)?Number(m[1]):null;
}
export async function createReplayPlayers({scene,options,env,attestation,leases,labState,Session,
  dmFn=dm,readObjects=readAdminObjects,journalDir=process.env.M59_LAB_RUNTIME_DIR}={}) {
  const plan=replayPlayerPlan(scene,options);
  if(!plan.enabled)return null;
  assertTemporaryPlayerLab(env,attestation);
  const actors=[],journal=path.join(journalDir,'pvp',randomBytes(8).toString('hex')+'.json');
  const receipt={schema:'m59-replay-players/v1',modeled:true,owner_pid:process.pid,
    created_at:new Date().toISOString(),plan,actors:[],cleanup:{complete:false}};
  let writeQueue=Promise.resolve();
  const persist=()=>{
    const json=JSON.stringify(receipt,null,2);
    writeQueue=writeQueue.then(async()=>{await mkdir(path.dirname(journal),{recursive:true});
      await writeFile(journal+'.tmp',json);await rename(journal+'.tmp',journal);});
    return writeQueue;
  };
  const disconnect=async s=>{
    s.combat?.issue({action:'stop'});s.client?.stopKeepalive?.();
    const sock=s.client?.sock;
    if(sock&&!sock.destroyed)await new Promise(resolve=>{sock.once('close',resolve);sock.destroy();});
    s.recorder?.stop?.();await s.replayRecorder?.close?.();
  };
  let cleaned=false;
  const manager={
    receipt,
    stop(){for(const a of actors)a.s.combat?.issue({action:'stop'});},
    resolve:a=>actors.find(x=>x.spec.key===(a.key??a.name))?.s.client.selfId??null,
    async sync({target}={}) {
      // Raw stat restoration does not run the server's normal level-up hook.
      // Recompute eligibility using normal rules; do not force-enable PvP.
      const ids=[...actors.map(a=>a.s.client.selfId),...(target?[target.client.selfId]:[])];
      await dmFn(ids.map(id=>sendMsg(id,'EvaluatePKStatus')),{env});
      const actual=await readObjects(ids,{env,dmFn});
      receipt.eligibility=actual.map(o=>({actor:actors.find(a=>a.s.client.selfId===o.id)?.spec.key??'self',
        enabled:o.properties.piflags==null?null:(o.properties.piflags.value&0x400)!==0}));
      await Promise.all(actors.map(async a=>{
        const c=a.s.client,at=Date.now();
        await a.s.pacer.submit('read',()=>c.roomContents());
        await a.s.pacer.submit('read',()=>c.stats(1));
        for(let i=0;i<30&&(!c.self||a.s.world?.room?.num!==scene.room.num);i++)await sleep(20);
        if(a.s.world?.room?.num!==scene.room.num)throw Error('stand-in room sync failed: '+JSON.stringify({
          actor:a.spec.name,want:scene.room.num,got:a.s.world?.room?.num,live:a.s.live,
          self:c.selfId,room:c.room?.name,messages:(c.events??[]).filter(e=>e.kind==='message').slice(-4)}));
        a.report.ready_at=at;
      }));
    },
    start({target,horizonMs,at}) {
      if(!target?.live||target.world?.room?.num!==scene.room.num)throw Error('PvP target is not the bound replay victim');
      for(const a of actors) {
        a.report.started_at=Date.now();a.report.start_delay_ms=a.report.started_at-at;
        if(a.spec.behavior==='idle'||horizonMs===0)continue;
        a.s.combat.issue({action:'kill',target:target.client.me.name,select_map:scene.room.num,
          ttl_ms:Math.max(1000,Math.min(horizonMs,1800000)),stop_below:0.05});
      }
    },
    snapshot() {
      for(const a of actors) {
        a.report.combat=a.s.combat?.status();
        a.report.final_hp=a.s.client?.vitals?.()?.health??null;
        a.report.messages=(a.s.client?.events??[]).filter(e=>e.kind==='message'&&e.at>=a.report.started_at).slice(-64)
          .map(e=>({at:e.at,text:e.text}));
      }
      receipt.activity={attacks:actors.reduce((n,a)=>n+(a.report.combat?.attacks??0),0),
        casts:actors.reduce((n,a)=>n+(a.report.combat?.casts??0),0),
        attack_refusals:actors.flatMap(a=>a.report.messages??[]).filter(e=>
          /not yet experienced|may not attack|cannot attack|can't attack|not allowed|out of range/i.test(e.text)).length};
      return receipt;
    },
    async close() {
      if(cleaned)return;
      manager.snapshot();
      const errors=[];
      for(const a of actors) {
        try {
          await disconnect(a.s);
          if(a.reserved&&!a.created) {
            const found=accountIdentity(await dmFn(['show account '+a.account],{env}),a.account);
            if(found){a.created=true;a.id=found;a.report.account_id=found;}
          }
          if(a.created) {
            const before=await dmFn(['show account '+a.account],{env});
            if(accountIdentity(before,a.account,a.id)!==a.id)throw Error('temporary account identity changed; refusing deletion');
            await dmFn(['delete account '+a.id],{env});
            const after=await dmFn(['show account '+a.account],{env});
            if(!after.includes('Cannot find account '+a.account+'.'))throw Error('temporary account deletion did not verify');
            a.report.deleted=true;
          }
          labState.delete(a.agent);
        }catch(e){errors.push({actor:a.spec.key,error:e.message});}
      }
      receipt.cleanup={complete:errors.length===0,errors};await persist();
      cleaned=errors.length===0;
      if(errors.length)throw Error('temporary PvP player cleanup failed; inspect '+journal);
    },
  };
  try {
    await persist();
    const create=async spec=>{
      const suffix=randomBytes(6).toString('hex'),account='replaysim_'+suffix,agent=account;
      const name='Replay'+suffix.slice(0,10).replace(/[0-9a-f]/g,c=>String.fromCharCode(65+parseInt(c,16)));
      const credentials={host:'127.0.0.1',port:17959,account,password:randomBytes(18).toString('base64url'),character:name};
      const acquired=leases.acquireAll([{agent,credentials}]);
      if(!acquired.ok)throw Error('temporary replay account lease unavailable');
      labState.set(agent,{credentials});
      const s=new Session(agent),report={actor:spec.key,captured_name:spec.name,shadow_name:name,account,
        behavior:spec.behavior,stats_as_asked:false,deleted:false};
      const a={spec,s,report,account,agent,created:false,id:null};actors.push(a);receipt.actors.push(report);await persist();
      const prior=await dmFn(['show account '+account],{env});
      if(!prior.includes('Cannot find account '+account+'.'))throw Error('temporary account name was not absent before creation');
      a.reserved=true;
      const out=await dmFn(['create automated '+account+' '+credentials.password],{env});
      const id=Number(/Created account (\d+)/.exec(out)?.[1]);
      if(!id)throw Error('temporary account creation did not confirm a new account');
      a.created=true;a.id=id;report.account_id=id;await persist();
      const clean=out.replace(/^:\s?/gm,'');
      const obj=Number(/^\s*\d+\s+(\d+)\s+\w+/m.exec(clean)?.[1]);
      if(!obj)throw Error('temporary account placeholder identity unavailable');
      const zero=await dmFn([setProp(obj,'piLastLoginTime',0),setProp(obj,'piLast_Restart_time',0)],{env});
      if(rejections(zero).length)throw Error('temporary character preparation rejected');
      const creation=planCharacter({name,stats:plan.profile.stats,loadout:'none',skills:[430],appearance:'default',
        unsafe:{waives:['fullBudget'],reason:'temporary unarmed PvP simulation; no invented spells'}});
      if(!creation.ok)throw Error('temporary character plan invalid: '+creation.problems.join('; '));
      s.credentials=credentials;
      s.replayFastReads=true;
      const made=await s.joinAsNewCharacter(creation);
      if(!made.created||made.refused)throw Error('temporary character creation was refused');
      const [actual]=await readObjects([s.client.selfId],{env,dmFn});
      report.creation_stats=creation.stats;
      report.stats_as_asked=Object.entries(creation.stats).every(([k,v])=>actual.properties['pi'+k]?.value===v);
      if(!report.stats_as_asked)throw Error('temporary character stats did not match creation request');
      await dmFn(skillCmds(s.client.selfId,plan.profile.unarmed,[430]),{env});
      // Ordinary join installs the complete event wiring used by CombatMode.
      await disconnect(s);s.client=null;
      s.replayFastReads=true;await s.join(credentials);await s.firstAbilityRead;
      if(!s.live)throw Error('temporary player did not reconnect into the game');
      const punch=s.client.abilitiesKnown().skills.find(a=>norm(a.name)==='punch')?.ability??0;
      if(punch!==plan.profile.unarmed)throw Error('temporary player punch skill did not verify');
      report.verified_unarmed=punch;
      const actor=scene.actors.find(x=>(x.key??x.name)===spec.key);
      actor.stats??={v:creation.stats,how:'estimated'};
      actor.vitals??={};
      for(const [k,v] of [['hp',plan.profile.health],['mana',plan.profile.mana],['vigor',plan.profile.vigor]])
        if(actor.vitals[k]?.v?.value==null)actor.vitals[k]={v:{value:v,...(k!=='vigor'?{max:v}:{})},how:'estimated'};
      report.profile=plan.profile;await persist();
    };
    // Independent accounts may join concurrently. Settle every creation before
    // cleanup, including failures, so no late login can escape ownership.
    const todo=plan.actors.values();
    const results=await Promise.allSettled(Array.from({length:Math.min(4,plan.actors.length)},async()=>{
      for(const spec of todo)await create(spec);
    }));
    const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;
    return manager;
  }catch(e){try{await manager.close();}catch(cleanup){e.message+='; '+cleanup.message;}throw e;}
}
