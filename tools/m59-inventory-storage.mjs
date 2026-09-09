// Cached storage presentation and intentions. No game packets or transfers.
import {readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {packFullness,vaultFullness,PACK_BASE} from './m59-storage.mjs';
import {itemIdentity} from './m59-inventory-intent.mjs';
const need=(ok,why)=>{if(!ok)throw Error(why);};
export function packCapacity(plan,row,now=Date.now()) {
  if(!row||row.agent!==plan.agent||row.character!==plan.identity.character||
     !Number.isFinite(row.snapshot_age_ms)||row.snapshot_age_ms<0||row.snapshot_age_ms>6000||
     !Number.isSafeInteger(row.pack?.max)||row.pack.max<PACK_BASE||row.pack.max>100000)return null;
  // Reweigh THIS inventory generation. Only the observed might-derived ceiling
  // is reused, so a pickup between two reads cannot pair old load with new items.
  const p=packFullness(plan.items,(row.pack.max-PACK_BASE)/20);
  return {max:p.max,weight:p.weight,bulk:p.bulk,exact:p.exact,at:now};
}
export function readVaultPlan(root,identity,doc,now=Date.now()) {
  try {
    const name=identity.character.replace(/[^a-z0-9_-]+/gi,'-').replace(/^-|-$/g,'')||'unknown';
    const path=join(root,'substrate','storage','vaults',name+'.json');
    const st=statSync(path);need(st.isFile()&&st.size>0&&st.size<=1048576,'invalid vault cache');
    const v=JSON.parse(readFileSync(path,'utf8'));
    need(v.character===identity.character&&Array.isArray(v.items)&&v.items.length<=2048&&
      Number.isSafeInteger(v.observed_at)&&v.observed_at>0&&v.observed_at<=now+1000,'invalid vault observation');
    const items=v.items.map((i,n)=>{
      itemIdentity({id:n+1,name:i.name});
      need(Number.isSafeInteger(i.amount)&&i.amount>0&&i.amount<=0x7fffffff,'invalid vault quantity');
      return {id:n+1,name:i.name,amount:i.amount,equipped:false,role:'other',actions:[],
        fee:Number.isSafeInteger(i.fee)&&i.fee>=0?i.fee:null};
    });
    const key=createHash('sha256').update(JSON.stringify({character:v.character,items})).digest('hex');
    for(const item of items){const intent=doc?.withdrawals?.[key+':'+item.id];
      item.purpose=intent?.state==='withdraw'?'withdraw':'leave';item.state='keep';
      item.source=intent?.source||'';item.reason=intent?.reason||'Cached vault item';}
    const f=vaultFullness(items);
    return {key,at:v.observed_at,max:f.max,bulk:f.bulk,exact:f.exact,items};
  }catch{return null;}
}
export function remainingCapacity(capacity,location='pack') {
  if(!capacity||capacity.exact!==true||!(capacity.max>0))return null;
  const used=location==='vault'?capacity.bulk:Math.max(capacity.weight,capacity.bulk);
  return Math.max(0,Math.min(1,1-used/capacity.max));
}
export function storageViewerText(plans,{fleet,broker_pid,now=Date.now()},encode) {
  const rows=[['M59SELLPLAN',2,encode(fleet),broker_pid,now].join('\t')];
  for(const p of plans){const w=p.room_wire;if(!w?.room_resource_id||!Number.isInteger(w.room_security_u32))continue;
    rows.push(['A',encode(p.agent),p.identity.player_id,encode(p.identity.character),p.room||0,
      w.room_resource_id,w.room_security_u32,p.revision,p.paused?1:0].join('\t'));
    if(p.capacity)rows.push(['C',encode(p.agent),p.capacity.max,p.capacity.weight,p.capacity.bulk,p.capacity.exact?1:0].join('\t'));
    if(p.vault)rows.push(['V',encode(p.agent),p.vault.at,p.vault.key,p.vault.max,p.vault.bulk,p.vault.exact?1:0].join('\t'));
    for(const [tag,items] of [['I',p.items],['J',p.vault?.items||[]]])for(const i of items)
      rows.push([tag,encode(p.agent),i.id,encode(i.name),i.amount,i.equipped?1:0,encode(i.role||'other'),
        encode((i.actions||[]).join(',')),i.state,encode(i.source||''),encode(i.reason||''),i.purpose||''].join('\t'));
  }
  return rows.join('\n')+'\nEND\n';
}
