import assert from 'node:assert/strict';import{mkdtempSync,writeFileSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{BraxSupplyService}from'./m59-brax-supply.mjs';import{weighItem}from'./m59-items.mjs';
const directory=mkdtempSync(join(tmpdir(),'m59-brax-procure-'));try{
 const actor={shadow_account:'a',role:'courier',abilities:{spells:[]}},stock=new Map([['shilling',20000]]),buys=[],events=[];
 const sizes=()=>{let weight=0,bulk=0;for(const [name,n]of stock){if(name==='shilling')continue;const u=weighItem(name);weight+=u.weight*n;bulk+=u.bulk*n;}return{weight:1000-weight,bulk:1000-bulk};};
 const names=['loaf of bread','hammer','herb','elderberry'];
 const call=async(name,args)=>{
  if(name==='inventory')return{items:[...stock].map(([name,amount],id)=>({name,amount,id:id+20}))};
  assert.equal(name,'shop');if(!args.buy_ids)return{items:names.map((name,i)=>({id:i+1,name,cost:1}))};
  const row=args.buy_ids[0],item=names[row.id-1],unit=weighItem(item),room=sizes();assert(row.amount*unit.weight<=room.weight-16);assert(row.amount*unit.bulk<=room.bulk-16);
  if(item==='hammer')assert((stock.get('loaf of bread')??0)>=6,'own food is bought before heavy weapons');
  assert.notEqual(item,'elderberry','an earlier unresolved elderberry intent must never repeat');
  buys.push({item,quantity:row.amount});stock.set(item,(stock.get(item)??0)+row.amount);stock.set('shilling',stock.get('shilling')-row.amount);return{clamped:[{id:row.id,buying:row.amount}]};
 };
 // A previous process died after submission. Keep that purchase unresolved,
 // while still filling the kit and transporting independently confirmed cargo.
 writeFileSync(join(directory,'a-crash.json'),JSON.stringify({agent:'a',purchases:[{seller:"Zhieu B'hob",item:'elderberry',status:'submitted'}]}));
 const service=new BraxSupplyService({actors:[{shadow_account:'r',role:'farmer'},actor,{...actor,shadow_account:'b'}],runner:'r',couriers:['a','b'],call,read:async()=>({carry:{known:true,load:{exact:true},room_for:sizes()}}),runLeg(){},emit:async e=>events.push(e),evidenceDir:directory});
 const visits=[];service.townTravel=async(agent,to)=>visits.push(to);service.sell=async()=>{};service.needs=async()=>[{needs:{hammer:3,'loaf of bread':80,herb:20,elderberry:10}}];
 await service.procure('a');assert.equal(buys[0].item,'loaf of bread');assert.equal(buys[0].quantity,6);assert.equal(stock.get('hammer'),4);assert.equal(stock.get('herb'),20);assert.equal(stock.get('elderberry'),undefined);assert.equal(visits.at(-1),350);assert(sizes().weight>=256&&sizes().bulk>=256,'pool purchases reserve real export capacity for upper loot');assert(events.some(e=>e.kind==='purchase-needs-reconciliation'&&e.receipt.status==='blocked'));
 console.log('PASS actual procurement buys own food before bulk weapons, respects a real capacity margin, blocks an unresolved item without replay, and returns confirmed cargo for delivery');
}finally{rmSync(directory,{recursive:true,force:true});}
