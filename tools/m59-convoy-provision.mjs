import{foodValue}from'./m59-items.mjs';
export function carriedFoodShare(items,{reserve=80,wanted=100}={}){const food=items.filter(i=>foodValue(i.name)?.nutrition>0),total=food.reduce((n,i)=>n+foodValue(i.name).nutrition*(i.amount||1),0);let spare=Math.max(0,total-reserve),given=0;const share=[];for(const i of food.sort((a,b)=>foodValue(b.name).nutrition-foodValue(a.name).nutrition)){const nutrition=foodValue(i.name).nutrition,amount=Math.min(i.amount||1,Math.floor(spare/nutrition),Math.ceil((wanted-given)/nutrition));if(amount>0){share.push({id:i.id,name:i.name,amount});spare-=amount*nutrition;given+=amount*nutrition;}if(given>=wanted)break;}return share;}
// Parallel independent self-meals, one cached fleet stock scan, then serialized
// actual trades. A donor is never controlled by a concurrent consumer task.
export async function feedConvoyBeforeDeparture(contexts,{read,skipRoom=()=>false,minVigor=80,targetVigor=120,maxBites=12,wait=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,budgetMs=60000,log=()=>{}}={}){
 const deadline=now()+budgetMs,states=new Map(),stocks=new Map(),pack=async c=>{const p=await c.call('inventory',{agent:c.agent});stocks.set(c.agent,p);return p;};
 await Promise.all(contexts.map(async c=>states.set(c.agent,await read(c))));
 const hungry=contexts.filter(c=>!skipRoom(states.get(c.agent).room.num)&&states.get(c.agent).vigor?.value<minVigor);
 if(!hungry.length)return{hungry:0,trades:0};
 const eat=async c=>{for(let bite=0;bite<maxBites&&now()<deadline; bite++){let s=states.get(c.agent);if(!(s.vigor?.value<targetVigor))break;const p=await pack(c),meal=p.items?.find(i=>foodValue(i.name)?.nutrition>0);if(!meal)break;const before=s.vigor.value,room=s.room.num;await c.call('act',{agent:c.agent,verb:'eat',target:meal.id});await wait(2500);s=await read(c);states.set(c.agent,s);if(s.room.num!==room)throw Error('convoy meal room changed');if(!(s.vigor?.value>before))break;}};
 await Promise.all(hungry.map(eat));
 const missing=hungry.filter(c=>states.get(c.agent).vigor?.value<minVigor);let trades=0;
 if(missing.length){await Promise.all(contexts.filter(c=>!stocks.has(c.agent)).map(pack));
  for(const actor of missing){if(now()>=deadline)break;let s=await read(actor);states.set(actor.agent,s);if(!(s.vigor?.value<minVigor))continue;
   const donors=contexts.filter(d=>d!==actor&&states.get(d.agent).room.num===s.room.num&&carriedFoodShare(stocks.get(d.agent)?.items??[]).length);
   for(const donor of donors){if(now()>=deadline)break;const other=await read(donor);if(other.room.num!==s.room.num||['pending','selected','approaching','activated','recovering'].includes(other.autopilot_status?.survival_decisions?.current?.status))continue;
    const stock=await pack(donor),share=carriedFoodShare(stock.items??[]);if(!share.length)continue;
    const reply=await donor.call('supply',{from:donor.agent,to:actor.agent,what:share,ids_as_of:stock.ids_as_of,who_travels:'neither'},60000);log({kind:'convoy-food-share',from:donor.agent,to:actor.agent,supplied:reply.supplied,reason:reply.reason});
    await Promise.all([pack(donor),pack(actor)]);if(reply.supplied){trades++;await eat(actor);break;}
   }
  }
 }
 for(const actor of hungry)log({kind:'convoy-prepared-vigor',agent:actor.agent,vigor:states.get(actor.agent).vigor?.value});
 return{hungry:hungry.length,trades};
}
