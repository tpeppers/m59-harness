import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {identityKey,readIntent,setIntent,planInventory,saleBlocked,atomicJson} from './m59-inventory-intent.mjs';
const dir=mkdtempSync(join(tmpdir(),'m59-intent-test-'));
const identity={server:'test.invalid:5959',account:'fixture',character:'Fixture',player_id:17};
const item={id:31,name:'herb',amount:7,recommended:true,reason:'surplus'};
const session={credentials:{host:'test.invalid',port:5959,account:'fixture'},client:{me:{id:17,name:'Fixture'}}};
try {
  let doc=readIntent(identity,{dir});assert.equal(planInventory([item],doc)[0].queued,true);
  doc=setIntent(identity,item,{dir,state:'keep',reason:'save these',revision:0});
  assert.equal(planInventory([item],doc)[0].state,'keep');assert.match(saleBlocked(session,item,{dir}),/veto/);
  doc=setIntent(identity,item,{dir,state:'sell',source:'ai',reason:'surplus'});assert.equal(doc.revision,1);assert.equal(doc.intents[31].state,'keep');
  assert.throws(()=>setIntent(identity,item,{dir,state:'sell',revision:0}),/revision/);
  doc=setIntent(identity,item,{dir,state:'sell',revision:1});assert.equal(planInventory([item],doc)[0].queued,true);
  assert.equal(planInventory([{...item,equipped:true}],doc)[0].state,'blocked');
  assert.equal(planInventory([{...item,blocked:'guild reserve'}],doc)[0].queued,false);
  assert.equal(planInventory([{...item,name:'coin'}],doc)[0].queued,false);
  assert.equal(planInventory([{...item,name:'other',recommended:false}],doc)[0].state,'none');
  assert.equal(readIntent({...identity,server:'other.invalid:5959'},{dir}).revision,0);
  assert.equal(planInventory([item],doc,{paused:true})[0].paused,true);
  atomicJson(join(dir,'pilots',identityKey(identity)+'.json'),{identity,expires_at:200});
  assert.match(saleBlocked(session,item,{dir,now:100}),/possessed/);assert.equal(saleBlocked(session,item,{dir,now:201}),null);
  writeFileSync(join(dir,'plans',identityKey(identity)+'.json'),'broken');assert.match(saleBlocked(session,item,{dir}),/unavailable/);
  assert.throws(()=>identityKey({...identity,account:'../outside'}));
  console.log('inventory intent tests passed: AI queue, operator precedence, CAS, identity, protections, possession, corrupt-state fail-closed');
} finally {rmSync(dir,{recursive:true,force:true});}
