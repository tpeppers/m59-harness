// Shared item-specific sell intent. Local state only; importing sends no game traffic.
import {readFileSync,writeFileSync,renameSync,mkdirSync,rmSync,rmdirSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';

export const INTENT_DIR=()=>process.env.M59_INVENTORY_INTENT_DIR || fileURLToPath(new URL('../substrate/inventory-intent',import.meta.url));
const need=(ok,message)=>{if(!ok)throw Error(message);};
const integer=n=>Number.isSafeInteger(n)&&n>0&&n<=0x0fffffff;
const text=(s,max)=>typeof s==='string'&&s.length>0&&s.length<=max&&!/[\x00-\x1f\x7f]/.test(s);
export function identityOf(value) {
  need(value&&text(value.server,128)&&/^[a-zA-Z0-9.:[\]-]+$/.test(value.server),'invalid server');
  need(text(value.account,64)&&/^[a-zA-Z0-9_-]+$/.test(value.account),'invalid account');
  need(text(value.character,100)&&integer(value.player_id),'invalid character identity');
  return {server:value.server.toLowerCase(),account:value.account.toLowerCase(),character:value.character,player_id:value.player_id};
}
export const identityKey=value=>createHash('sha256').update(JSON.stringify(identityOf(value))).digest('hex');
export function sessionIdentity(s) {
  const c=s?.client,cr=s?.credentials;
  if(!cr||!c?.me)return null;
  try{return identityOf({server:`${cr.host}:${cr.port}`,account:cr.account,character:c.me.name||cr.character,player_id:c.me.id});}catch{return null;}
}
export function itemIdentity(item) {
  need(item&&integer(item.id)&&text(item.name,256),'invalid item identity');
  return {id:item.id,name:item.name};
}
export function sameItem(a,b) {return a?.id===b?.id&&a?.name===b?.name;}
const empty=identity=>({schema:'m59-inventory-intent/1',identity:identityOf(identity),revision:0,intents:{}});
export function readIntent(identity,{dir=INTENT_DIR()}={}) {
  const key=identityKey(identity),path=join(dir,'plans',key+'.json');
  if(!existsSync(path))return empty(identity);
  const bytes=readFileSync(path);need(bytes.length<=1048576,'intent file too large');
  const doc=JSON.parse(bytes);
  need(doc?.schema==='m59-inventory-intent/1'&&identityKey(doc.identity)===key,'intent identity mismatch');
  need(Number.isSafeInteger(doc.revision)&&doc.revision>=0&&doc.intents&&typeof doc.intents==='object'&&!Array.isArray(doc.intents)&&Object.keys(doc.intents).length<=2048,'invalid intent document');
  for(const [id,row] of Object.entries(doc.intents)) {
    itemIdentity(row);need(String(row.id)===id,'intent id mismatch');
    need(['sell','keep'].includes(row.state)&&['operator','ai'].includes(row.source)&&text(row.reason,256),'invalid intent row');
  }
  return doc;
}
export function atomicJson(path,doc) {
  mkdirSync(dirname(path),{recursive:true});const tmp=path+'.'+randomUUID()+'.tmp';
  try {writeFileSync(tmp,JSON.stringify(doc)+'\n',{flag:'wx'});renameSync(tmp,path);}
  finally {if(existsSync(tmp))rmSync(tmp);}
}
export function publishPlan(s,plan,{room=null,room_wire=null,dir=INTENT_DIR(),now=Date.now()}={}) {
  if(!plan.identity)return;
  atomicJson(join(dir,'observed','bot-'+process.pid+'.json'),{
    schema:'m59-inventory-plan/1',at:now,pid:process.pid,agent:s.name,identity:plan.identity,
    room,room_wire,revision:plan.revision,error:plan.error,
    items:plan.items.map(({id,name,amount,equipped,role,actions,recommended,blocked,reason,state,queued,source})=>
      ({id,name,amount,equipped,role,actions,recommended,blocked,reason,state,queued,source}))
  });
}
// Multiple UI/AI callers use an OS-exclusive writer lock plus a revision check.
// A crashed writer leaves a named lock to inspect; never delete somebody else's lock.
export function setIntent(identity,item,{state,source='operator',reason='operator decision',revision,dir=INTENT_DIR()}={}) {
  identity=identityOf(identity);item=itemIdentity(item);
  need(['sell','keep','auto'].includes(state)&&['operator','ai'].includes(source)&&text(reason,256),'invalid intent change');
  const key=identityKey(identity),root=join(dir,'plans'),lock=join(root,key+'.lock');mkdirSync(root,{recursive:true});
  mkdirSync(lock); // EEXIST means another writer; the caller retries a fresh revision.
  try {
    const doc=readIntent(identity,{dir});
    need(revision===undefined||doc.revision===revision,'intent revision changed');
    const previous=doc.intents[item.id];
    if(source==='ai'&&sameItem(previous,item)&&previous.source==='operator')return doc;
    if(state==='auto')delete doc.intents[item.id];
    else doc.intents[item.id]={...item,state,source,reason,at:Date.now()};
    need(Object.keys(doc.intents).length<=2048,'too many item intents');
    doc.revision++;atomicJson(join(root,key+'.json'),doc);return doc;
  } finally {rmdirSync(lock);}
}
export function planInventory(items,doc,{paused=false}={}) {
  need(Array.isArray(items)&&items.length<=2048,'invalid inventory');
  return items.map(item=>{
    itemIdentity(item);
    const stored=doc?.intents?.[item.id],intent=sameItem(stored,item)?stored:null;
    const requested=intent?intent.state==='sell':item.recommended===true;
    const blocked=item.equipped?'equipped':/^(shillings?|coins?)$/i.test(item.name)?'money':item.blocked||null;
    const state=intent?.state==='keep'?'keep':requested?(blocked?'blocked':'sell'):'none';
    return {...item,state,queued:state==='sell',source:intent?.source||(requested?'ai':null),
      reason:intent?.state==='keep'?intent.reason:blocked||intent?.reason||item.reason||'not selected for sale',
      paused:!!paused};
  });
}
export function intentForSession(s,item,{dir=INTENT_DIR()}={}) {
  const identity=sessionIdentity(s);if(!identity)return null;
  const doc=readIntent(identity,{dir});const row=doc.intents[item.id];
  return sameItem(row,item)?row:null;
}
// Consulted again inside the paced accept callback, not just when planning.
export function saleBlocked(s,item,{dir=INTENT_DIR(),now=Date.now()}={}) {
  const identity=sessionIdentity(s);if(!identity)return null; // old callers remain compatible
  try {
    const row=intentForSession(s,item,{dir});if(row?.state==='keep')return 'operator veto: '+row.reason;
    const lease=join(dir,'pilots',identityKey(identity)+'.json');
    if(existsSync(lease)) {
      const bytes=readFileSync(lease);need(bytes.length<=4096,'pilot lease too large');
      const value=JSON.parse(bytes);
      need(identityKey(value.identity)===identityKey(identity)&&Number.isFinite(value.expires_at),'invalid pilot lease');
      if(value.expires_at>now)return 'character is possessed; sale queued for bot control';
    }
    return null;
  } catch {return 'inventory intent unavailable; sale held';}
}
