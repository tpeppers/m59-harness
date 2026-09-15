// Run only after all trials and an orderly stop of the experimental shadow broker.
// The caller must verify that no shadow keeper still owns a game socket.
import fs from 'node:fs';
import path from 'node:path';
import {dm,resolve,relocate,healthCmds,setProp,give,money} from '../../../tools/m59-dm.mjs';
const root=path.resolve(process.argv[2]??'substrate/shadow-survival-2026-09-14');
if(process.argv[3]!=='--shadow-broker-stopped')throw new Error('requires stopped-shadow assertion');
const saved=JSON.parse(fs.readFileSync(path.join(root,'states-before.private.json')));
if(saved.length!==21||saved.some(x=>!/^shadow\d\d$/.test(x.agent)))throw new Error('wrong backup');
const classes={'axe':'Axe','mace':'Mace','hammer':'Hammer','short sword':'ShortSword',
 'long sword':'LongSword','leather armor':'LeatherArmor',"knight's shield":'Knightshield',
 herb:'Herbs',elderberry:'ElderBerry',emerald:'Emerald','orc tooth':'OrcTooth',
 'red mushroom':'RedMushroom',heartstone:'HeartStone',apple:'Apple','water skin':'Waterskin',shilling:'Money'};
const results=[];
for(const s of saved){
 const id=(await resolve([s.character]))[s.character];
 if(!id)throw new Error('missing '+s.character);
 const shown=await dm([`show object ${id}`]);
 const using=/plUsing\s*= LIST (\d+)/.exec(shown)?.[1];
 if(using){const list=await dm([`show list ${using}`]);const used=[...list.matchAll(/^:\s+OBJECT (\d+)/gm)].map(x=>x[1]);
  if(used.length)await dm(used.map(x=>`send object ${id} UserUnuseItem what OBJECT ${x}`));}
 const wanted={};for(const item of s.items??[]){const cls=classes[item.name];if(!cls)throw new Error('unmapped item '+item.name);wanted[cls]=(wanted[cls]??0)+Math.max(1,item.amount??1);}
 for(const [cls,amount] of Object.entries(wanted)){
  if(cls==='Money')continue;
  const stacking=['Herbs','ElderBerry','Emerald','OrcTooth','RedMushroom','Apple','Waterskin'].includes(cls);
  await give(id,{each:amount,stacking:stacking?[cls]:[],singles:stacking?[]:[cls]});
 }
 await money(id,wanted.Money??0);
 const pack=await dm([`show object ${id}`]);const passive=/plPassive\s*= LIST (\d+)/.exec(pack)?.[1];
 if(passive){
  const contents=await dm([`show list ${passive}`]);const equip=new Set(s.equipment.map(x=>classes[x].toLowerCase()));
  for(const m of contents.matchAll(/^:\s+OBJECT (\d+)/gm)){
   const item=await dm([`show object ${m[1]}`]);const cls=/is CLASS (\w+)/.exec(item)?.[1];
   if(equip.has(cls?.toLowerCase())){await dm([`send object ${id} UserUseItem what OBJECT ${m[1]}`]);equip.delete(cls.toLowerCase());}
  }
 }
 await dm([...healthCmds(id,s.hp.max),setProp(id,'piHealth',s.hp.value),setProp(id,'piVigor',s.vigor.value),
   setProp(id,'piKarma',Math.round(s.attributes.karma*100))]);
 const placed=await relocate([s.character],s.room.num,{row:s.you.row,col:s.you.col,verify:true});
 results.push({agent:s.agent,character:s.character,hp:s.hp,vigor:s.vigor,restoredEquipment:s.equipment,
  inventoryTopUp:wanted,placed,limits:'Item quantities are topped up; item condition and ability percentages are not restored.'});
 console.log(JSON.stringify({restored:s.agent,room:s.room.num,hp:s.hp.max}));
}
fs.writeFileSync(path.join(root,'restoration.json'),JSON.stringify(results,null,2));
