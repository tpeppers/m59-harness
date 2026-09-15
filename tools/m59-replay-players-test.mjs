#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createReplayPlayers,replayPlayerPlan,accountIdentity,assertTemporaryPlayerLab} from './m59-replay-players.mjs';
import {STAT_PRESETS} from './m59-newchar.mjs';
const scene=()=>({room:{num:60},actors:[{key:'self',kind:'player',mine:true,name:'Victim'},
  {key:'other',kind:'player',name:'Morpheus',at:{v:{row:10,col:12,x:800,y:672}},vitals:{hp:{v:null,how:'unknown'}}}]});
const options={enabled:true,attackers:['Morpheus']},env={M59_ADMIN_HOST:'127.0.0.1',M59_ADMIN_PORT:'17998'},
  attestation={temporary_account_delete:'v1'};
assert.equal(replayPlayerPlan(scene(),options).actors[0].behavior,'melee');
assert.equal(replayPlayerPlan(scene(),{...options,attackers:[]}).actors[0].behavior,'idle');
assert.throws(()=>replayPlayerPlan(scene(),{...options,attackers:['Absent']}),/exactly one/);
assert.throws(()=>replayPlayerPlan(scene(),{...options,profile:{health:100000}}),/health/);
assert.throws(()=>replayPlayerPlan(scene(),{...options,command:'kill'}),/unknown/);
assert.throws(()=>assertTemporaryPlayerLab({...env,M59_ADMIN_PORT:'9998'},attestation),/owned isolated/);
assert.throws(()=>assertTemporaryPlayerLab(env,{}),/deletion support/);
assert.equal(accountIdentity(' 12 replaysim_012345abcdef 0.00','replaysim_012345abcdef',12),12);
assert.equal(accountIdentity(' 12 replaysim_012345abcdef 0.00','replaysim_012345abcdef',13),null);
assert.equal(accountIdentity(' 12 prodaccount 0.00','prodaccount',12),null);
const dir=mkdtempSync(path.join(tmpdir(),'m59-replay-players-'));
async function fixture({creationLost=false,badStats=false,badDelete=false}={}) {
  let account=null,created=false,deleted=false,attacks=0;
  const commands=[],labState=new Map();
  class Session {
    constructor(name) {
      this.name=name;this.world={room:{num:60}};this.pacer={submit:async(_,f)=>f()};
      this.client={selfId:55,self:{},me:{name:'Standin'},sock:{destroyed:true,destroy(){}},
        roomContents(){},stats(){},vitals:()=>({health:{value:100,max:100}}),events:[],
        abilitiesKnown:()=>({skills:[{name:'punch',ability:99}]})};
      this.createdClient=this.client;this.live=true;
      this.recorder={stop(){}};
      this.combat={issue:o=>{if(o.action==='kill')attacks++;},
        status:()=>({attacks,active:false})};
    }
    async joinAsNewCharacter(){return {created:true};}
    async join(){this.client=this.createdClient;this.firstAbilityRead=Promise.resolve(true);}
  }
  const dmFn=async cmds=>{
    commands.push(...cmds);
    const c=cmds[0];
    if(c.startsWith('show account ')) {
      const name=c.slice(13);
      return created?' 12 '+account+'   0.00\n 12 55 User Standin':'Cannot find account '+name+'.';
    }
    if(c.startsWith('create automated ')){
      account=c.split(' ')[2];created=true;
      return creationLost?'incomplete reply':'Created account 12.\n 12 55 User Placeholder';
    }
    if(c==='delete account 12'){deleted=true;if(!badDelete)created=false;return 'Account 12 will be deleted.';}
    return 'ok';
  };
  const readObjects=async()=>[{properties:Object.fromEntries(Object.entries(STAT_PRESETS.melee)
    .map(([k,v])=>['pi'+k,{value:badStats?0:v}]))}];
  const input=scene();
  let manager,error;
  try{manager=await createReplayPlayers({scene:input,options,env,attestation,Session,dmFn,readObjects,
    leases:{acquireAll:()=>({ok:true})},labState,journalDir:dir});}
  catch(e){error=e;}
  return {manager,error,input,commands,labState,get deleted(){return deleted;},get attacks(){return attacks;}};
}
try {
  const f=await fixture();
  assert.equal(f.error,undefined);assert.equal(f.attacks,0,'nothing attacks during scene setup');
  assert.equal(f.input.actors[1].vitals.hp.how,'estimated');
  assert.equal(f.manager.resolve(f.input.actors[1]),55);
  await f.manager.sync();
  f.manager.start({target:{live:true,world:{room:{num:60}},client:{me:{name:'Victim'}}},horizonMs:10000,at:Date.now()});
  assert.equal(f.attacks,1);assert.equal(f.manager.snapshot().activity.attacks,1);
  await f.manager.close();assert.equal(f.deleted,true);assert.equal(f.manager.receipt.cleanup.complete,true);
  assert.equal(f.labState.size,0);assert.doesNotMatch(JSON.stringify(f.manager.receipt),/password|credentials/);
  const count=f.commands.filter(c=>c.startsWith('delete account')).length;await f.manager.close();
  assert.equal(f.commands.filter(c=>c.startsWith('delete account')).length,count,'cleanup is idempotent');
  const failed=await fixture({badStats:true});assert.match(failed.error.message,/stats/);assert.equal(failed.deleted,true);
  const lost=await fixture({creationLost:true});assert.match(lost.error.message,/creation/);assert.equal(lost.deleted,true,'lost creation reply still cleans owned account');
  const stuck=await fixture({badDelete:true});await assert.rejects(stuck.manager.close(),/cleanup failed/);
  assert.equal(stuck.manager.receipt.cleanup.complete,false,'a deletion acknowledgement alone is insufficient');
} finally {rmSync(dir,{recursive:true,force:true});}
console.log('PvP profile, lab gates, temporary creation, start barrier, failure cleanup and credentials tests passed');
