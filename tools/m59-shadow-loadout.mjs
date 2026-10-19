// External per-character loadouts are part of a reproduction, alongside live policy.
import {clonePolicy} from './m59-shadow-policy.mjs';
export function cloneLoadout(source,{character,agent,identities={},overlay={}}={}){
 if(!character||!agent)throw Error('clone loadout requires character and agent identities');
 if(source!=null&&(!source||typeof source!=='object'||Array.isArray(source)))throw Error('source loadout must be an object or null');
 const base=source??{format:'m59-loadout/1',carry:[],gear:{weapon:[],slots:{}},policy:{}};
 // Wrap as a policy to reuse its recursive identity remap and declared overlay diff.
 const result=clonePolicy({policy:base},{identities,overlay:{...overlay,character,agent}});
 return{loadout:result.policy,changes:result.changes,sourcePresent:source!=null};
}
// Quantity floors protect loot eviction without excluding food from the larder.
export function withCarryFloors(carry=[],floors={}){
 const rows=structuredClone(carry),key=s=>String(s).trim().toLowerCase();
 for(const [item,min]of Object.entries(floors)){
  if(!Number.isFinite(min)||min<0)throw Error('invalid carry floor '+item);
  const row=rows.find(r=>key(r.item)===key(item));
  if(row){row.min=min;if(row.max!=null&&row.max<min)row.max=min;}
  else rows.push({item,min,max:null,match:'exact'});
 }
 return rows;
}
