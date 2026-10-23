// Ordinary stationary ammunition gifts, initiated by the archer that owns its
// receiver lease. A courier must not commandeer a running training FleetScript.
import fs from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {stateFileFor} from './m59-fleetpath.mjs';
import {arrowCount,planArrowPull} from './m59-practicebow.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const room=s=>Number(s?.room?.num??s?.room);
const read=p=>fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):null;
function save(p,v){fs.mkdirSync(dirname(p),{recursive:true});const t=p+'.'+randomUUID();fs.writeFileSync(t,JSON.stringify(v,null,2));fs.renameSync(t,p);}
export function bowSupplyFile(fleet,agent){if(!/^[A-Za-z0-9_-]+$/.test(agent))throw Error('invalid bow supply agent');const key=createHash('sha256').update(resolve(stateFileFor(fleet)).toLowerCase()).digest('hex').slice(0,20);return join(ROOT,'substrate','bow-supply',key,agent+'.json');}
export function bowTrainingIntent(policy={},loadout={}){
 const target=loadout?.plan?.learning_target,track=typeof target==='object'?target?.track??target?.school??target?.name:target;
 return /archerplus|practice-bow/i.test(String(policy.farmStrategy??''))||
  /\bbow\b/i.test(String(policy.trainingWeapon??''))||
  /^(fire|archery)$/i.test(String(track??''))||
  (loadout?.gear?.weapon??[]).some(n=>/\bbow\b/i.test(n)&&!/crossbow/i.test(n));
}
export async function pullBowArrows(ctx,{donors=[],target=160,keep=0,stock={},room:expectedRoom=null,journal=bowSupplyFile(ctx.fleet,ctx.agent)}={}){
 if(!Number.isInteger(target)||target<1||!Number.isInteger(keep)||keep<0)throw Error('invalid arrow supply amounts');
 if(Object.entries(stock).some(([n,q])=>!n||!Number.isInteger(q)||q<0||q>1000))throw Error('invalid bow supply stock');
 const key=n=>/^herbs?$/i.test(n)?'herb':/\barrows?\b/i.test(n)&&!/bolt/i.test(n)?'arrows':String(n).toLowerCase();
 const count=(items,n)=>items.filter(i=>key(i.name)===n).reduce((sum,i)=>sum+(i.amount>0?i.amount:1),0);
 const previous=read(journal);if(previous&&['submitted','uncertain'].includes(previous.phase))throw Error('unresolved arrow gift: inspect '+journal);
 const pack=async agent=>{const p=await ctx.call('inventory',{agent,fresh:true});if(p?.error||!Array.isArray(p?.items)||p.ids_stale)throw Error('arrow inventory unconfirmed '+agent);return p;};
 let mine=await pack(ctx.agent),received=0;
 const state=agent=>ctx.readActor?ctx.readActor(agent):ctx.call('status',{agent,brief:true});
 for(const donor of [...new Set(donors)].filter(a=>a!==ctx.agent)){
  if(ctx.shouldStop?.())break;
  if(arrowCount(mine.items)>=target&&Object.entries(stock).every(([n,q])=>count(mine.items,key(n))>=q))break;
  const [me,giver]=await Promise.all([state(ctx.agent),state(donor)]);
  if(me?.in_game!==true||me?.connected===false||giver?.in_game!==true||giver?.connected===false||!(room(me)>1)||room(me)!==room(giver)||(expectedRoom!=null&&room(me)!==expectedRoom))continue;
  const policy=giver.autopilot_status?.policy??giver.autopilot?.policy,floors=giver.autopilot_status?.loadout_retention?.carry_floors??giver.autopilot?.loadout_retention?.carry_floors;
  if(!policy||!floors||typeof floors!=='object'||!Array.isArray(giver.equipment_items??giver.equipment?.equipped))continue;
  const theirs=await pack(donor),protectedNames=[...(policy.protectedItems??[]),...(policy.vaultItems??[])].map(n=>String(n).toLowerCase());
  const worn=new Set((giver.equipment_items??giver.equipment?.equipped??[]).map(i=>i.id));
  const available=theirs.items.filter(i=>!worn.has(i.id)&&!protectedNames.some(n=>n&&String(i.name).toLowerCase().includes(n)));
  const reserved=Object.entries(floors).filter(([n])=>/\barrows?\b/i.test(n)).reduce((sum,[,n])=>sum+(Number(n)||0),0);
  const gifts=planArrowPull(available,arrowCount(mine.items),{keep:Math.max(keep,reserved),want:target});
  for(const [raw,q]of Object.entries(stock)){
   const name=key(raw);if(name==='arrows')continue;
   const floor=Object.entries(floors).filter(([n])=>key(n)===name).reduce((sum,[,n])=>sum+(Number(n)||0),0);
   let left=Math.min(Math.max(0,q-count(mine.items,name)),Math.max(0,count(available,name)-floor));
   for(const item of available.filter(i=>key(i.name)===name)){const n=Math.min(left,item.amount>0?item.amount:1);if(n>0){gifts.push({id:item.id,name:item.name,amount:n});left-=n;}}
  }
  if(!gifts.length)continue;
  await ctx.verifyActors?.([donor,ctx.agent]);
  if(ctx.shouldStop?.())break;
  const intent={id:randomUUID(),phase:'submitted',at:Date.now(),from:donor,to:ctx.agent,room:room(me),items:gifts};save(journal,intent);
  try{
   const result=await ctx.call('supply',{from:donor,to:ctx.agent,what:gifts,ids_as_of:theirs.ids_as_of,who_travels:'neither',stationary:true},90000);
   const preSend=result?.reason==='native offer submission refused'&&result?.submission?.error==='stationary exchange expired or preempted by survival';
   if(result?.submission?.attempted===false||typeof result?.reason==='string'&&result.reason.startsWith('stationary body not ready:')||preSend){save(journal,{...intent,phase:'unsubmitted',result});continue;}
   const n=gifts.reduce((sum,i)=>sum+i.amount,0),after=await pack(ctx.agent),afterDonor=await pack(donor);
   const native=result?.amounts?.length===gifts.length&&result.amounts.reduce((sum,x)=>sum+x.asked,0)===n&&result.amounts.every(x=>x.asked>0&&x.giver_lost>=x.asked&&x.received>=x.asked);
   const byName=new Map();for(const item of gifts)byName.set(key(item.name),(byName.get(key(item.name))??0)+item.amount);
   const fresh=[...byName].every(([name,q])=>count(after.items,name)-count(mine.items,name)>=q&&count(theirs.items,name)-count(afterDonor.items,name)>=q);
   if(result?.supplied!==true||!(native||fresh))throw Object.assign(Error('arrow gift not confirmed'),{receipt:result});
   save(journal,{...intent,phase:'confirmed',quantity:n,result});received+=n;mine=after;
  }catch(e){save(journal,{...intent,phase:'uncertain',error:e.message,receipt:e.receipt});throw e;}
 }
 return{received,arrows:arrowCount(mine.items),journal};
}
