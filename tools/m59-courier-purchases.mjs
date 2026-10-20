// Verified, one-attempt purchases for couriers. Capacity decisions stay in shop.
import {mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';

const count=(items,match)=>items.filter(i=>match.test(i.name??'')).reduce((n,i)=>n+(i.amount>0?i.amount:1),0);
const cash=items=>items.filter(i=>/^shillings?$/i.test(i.name??'')).reduce((n,i)=>{
 if(!Number.isSafeInteger(i.amount)||i.amount<0)throw Error('courier cash unconfirmed');
 return n+i.amount;
},0);
export function pendingCourierPurchase({agent,seller,item,aliases=[],evidenceDir='substrate/courier-purchases'}){
 const directory=resolve(evidenceDir);if(!existsSync(directory))return null;
 const prefix=String(agent).replace(/[^a-z0-9_-]/gi,'_')+'-',names=new Set([item,...aliases].map(n=>String(n).toLowerCase()));
 for(const name of readdirSync(directory).filter(n=>n.startsWith(prefix)&&n.endsWith('.json'))){
  const journal=JSON.parse(readFileSync(resolve(directory,name),'utf8'));if(journal.agent!==agent)continue;
  const pending=journal.purchases?.find(p=>['submitted','unreconciled'].includes(p.status)&&String(p.seller).toLowerCase()===String(seller).toLowerCase()&&names.has(String(p.item).toLowerCase()));
  if(pending)return{file:resolve(directory,name),status:pending.status,at:pending.at,item:pending.item,seller:pending.seller};
 }return null;
}
export async function buyCourierGoods(ctx,{seller,item,aliases=[],amount=1,maximize=false,evidenceDir='substrate/courier-purchases',settleMs=15000,pollMs=1000}={}){
 if(!seller||!item||!Number.isSafeInteger(amount)||amount<0)throw Error('invalid courier purchase');
 const pending=pendingCourierPurchase({agent:ctx.agent,seller,item,aliases,evidenceDir});
 if(pending)return{at:new Date().toISOString(),seller,item,requested:amount,status:'blocked',quantity:0,pending_previous:pending,note:'An earlier submitted purchase is unresolved; no quote or new buy was sent.'};
 const names=new Set([item,...aliases].map(n=>n.toLowerCase()));
 const match={test:name=>names.has(String(name).toLowerCase())};
 const ledger=ctx.state.courierPurchases??={format:'m59-courier-purchases/1',agent:ctx.agent,at:new Date().toISOString(),purchases:[]};
 if(!ledger.file){
  mkdirSync(resolve(evidenceDir),{recursive:true});
  ledger.file=resolve(evidenceDir,String(ctx.agent).replace(/[^a-z0-9_-]/gi,'_')+'-'+Date.now()+'-'+randomUUID()+'.json');
 }
 const entry={at:new Date().toISOString(),seller,item,maximize,requested:amount,status:'preparing'};
 ledger.purchases.push(entry);
 const save=()=>writeFileSync(ledger.file,JSON.stringify(ledger,null,2));
 const pack=async()=>{const p=await ctx.call('inventory',{agent:ctx.agent});if(!Array.isArray(p?.items)||p.ids_stale===true)throw Error('courier inventory unconfirmed');return p.items;};
 save();
 try{
  const menu=await ctx.call('shop',{agent:ctx.agent,seller}),row=menu?.items?.find(i=>match.test(i.name??''));
  if(!row||!(row.id>0)||!Number.isSafeInteger(row.cost)||row.cost<=0)throw Error('courier quote unconfirmed');
  const before=await pack();
  Object.assign(entry,{unit_cost:row.cost,cash_before:cash(before),count_before:count(before,match)});
  entry.requested=maximize?Math.floor(entry.cash_before/row.cost):amount;
  if(entry.requested===0){entry.status='limited';entry.quantity=0;entry.spent=0;entry.limited_by=['purse'];save();return entry;}
  // Persist intent before sending. Never repeat an ambiguous purchase.
  entry.status='submitted';save();
  const reply=await ctx.call('shop',{agent:ctx.agent,seller,buy_ids:[{id:row.id,amount:entry.requested}]},600000);
  entry.clamped=reply?.clamped??[];entry.reply_note=reply?.note??reply?.error??null;entry.shop_receipt=reply;save();
  const deadline=Date.now()+settleMs;
  do{
   const after=await pack();
   Object.assign(entry,{cash_after:cash(after),count_after:count(after,match)});
   entry.quantity=entry.count_after-entry.count_before;entry.spent=entry.cash_before-entry.cash_after;
   if(entry.quantity>0&&entry.spent===entry.quantity*entry.unit_cost){entry.status='confirmed';save();return entry;}
   if(entry.quantity===0&&entry.spent===0&&entry.clamped.some(c=>c.id===row.id&&c.buying===0)){
    entry.status='limited';entry.limited_by=entry.clamped.find(c=>c.id===row.id)?.limited_by??[];save();return entry;
   }
   if(Date.now()>=deadline)break;
   await new Promise(r=>setTimeout(r,Math.min(pollMs,deadline-Date.now())));
  }while(true);
  entry.status='unreconciled';
 }catch(e){entry.error=e.message;entry.status=entry.status==='preparing'?'refused':'unreconciled';}
 save();return entry;
}

// Cash + cargo are valued at acquisition cost. Held capital is never called lost.
export function courierOverhead(rows){
 const totals={starting_value:0,delivered_cash:0,delivered_cargo_value:0,lost_value:0,held_value:0,delivered_bows:0,delivered_arrows:0};
 for(const row of rows)for(const key of Object.keys(totals)){
  const n=row[key]??0;if(!Number.isFinite(n)||n<0)throw Error('invalid courier accounting '+key);totals[key]+=n;
 }
 const delivered=totals.delivered_cash+totals.delivered_cargo_value;
 const unaccounted=totals.starting_value-delivered-totals.lost_value-totals.held_value;
 const reconciled=Math.abs(unaccounted)<0.000001;
 return {...totals,delivered_value:delivered,unaccounted_value:unaccounted,reconciled,
  loss_overhead:reconciled&&delivered>0?totals.lost_value/delivered:null,
  cargo_loss_overhead:reconciled&&totals.delivered_cargo_value>0?totals.lost_value/totals.delivered_cargo_value:null,
  loss_per_delivered_bow:reconciled&&totals.delivered_bows>0?totals.lost_value/totals.delivered_bows:null};
}
