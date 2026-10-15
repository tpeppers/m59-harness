import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buyCourierGoods,courierOverhead} from './m59-courier-purchases.mjs';
const scratch=mkdtempSync(join(tmpdir(),'m59-courier-cargo-'));
let sequence=0;
const money=amount=>({name:'shillings',amount});
try{
 for(const mode of ['delayed','full','unreconciled','stale','bad_quote']){
  let submitted=0,afterReads=0;const asks=[];
  const ctx={agent:'cargo-'+(++sequence),state:{},call:async(name,args)=>{
   if(name==='shop'&&!args.buy_ids)return {items:[{id:10,name:'practice bow',cost:mode==='bad_quote'?0:1000,amount:1}]};
   if(name==='shop'){submitted++;asks.push(args.buy_ids[0]);return {clamped:[{id:10,buying:mode==='full'?0:7,limited_by:['bulk']}]};}
   assert.equal(name,'inventory');
   const before=[money(40000),{name:'practice bow',amount:0},{name:'practice bow',amount:0}];
   if(!submitted)return mode==='stale'?{ids_stale:true,items:before}:{items:before};
   if(mode==='full')return {items:before};
   if(mode==='delayed'&&++afterReads===1)return {items:[money(33000),...before.slice(1)]};
   return {items:[money(mode==='unreconciled'?39000:33000),...Array.from({length:9},()=>({name:'practice bow',amount:0}))]};
  }};
  const r=await buyCourierGoods(ctx,{seller:'fixture',item:'practice bow',maximize:true,evidenceDir:scratch,settleMs:15,pollMs:1});
  if(mode==='delayed'){assert.equal(r.status,'confirmed');assert.equal(r.quantity,7);assert.equal(r.spent,7000);assert.equal(asks[0].amount,40);}
  if(mode==='full'){assert.equal(r.status,'limited');assert.equal(r.quantity,0);assert.equal(r.spent,0);}
  if(mode==='unreconciled')assert.equal(r.status,'unreconciled');
  if(mode==='stale'||mode==='bad_quote'){assert.equal(submitted,0);assert.equal(r.status,'refused');}
  else assert.equal(submitted,1,'a purchase with delayed or ambiguous evidence is never resent');
  assert.equal(JSON.parse(readFileSync(ctx.state.courierPurchases.file)).purchases[0].status,r.status);
 }
 let ordered=false;
 const arrows={agent:'plural-arrows',state:{},call:async(name,args)=>{
  if(name==='shop'&&!args.buy_ids)return {items:[{id:11,name:'arrows',cost:2}]};
  if(name==='shop'){ordered=true;return {};}
  return {items:ordered?[money(39600),{name:'arrow',amount:200}]:[money(40000)]};
 }};
 const a=await buyCourierGoods(arrows,{seller:'fixture',item:'arrow',aliases:['arrows'],amount:200,evidenceDir:scratch});
 assert.equal(a.status,'confirmed');assert.equal(a.quantity,200);assert.equal(a.spent,400);
 const half=courierOverhead([{starting_value:800000,delivered_cash:100000,delivered_cargo_value:300000,lost_value:400000,delivered_bows:300}]);
 assert.equal(half.loss_overhead,1);assert.equal(half.cargo_loss_overhead,4/3);assert.equal(half.loss_per_delivered_bow,400000/300);
 const held=courierOverhead([{starting_value:800000,delivered_cash:400000,lost_value:40000,held_value:360000}]);
 assert.equal(held.loss_overhead,0.1);assert.equal(held.held_value,360000);
 assert.equal(courierOverhead([{starting_value:40000,held_value:40000}]).loss_overhead,null);
 assert.equal(courierOverhead([{starting_value:40000,delivered_cash:30000}]).loss_overhead,null,'unreconciled capital is not a precise overhead');
 assert.throws(()=>courierOverhead([{lost_value:-1}]),/invalid/);
 console.log('Courier purchases: capacity-clamped maxima, delayed pack/cash reconciliation, durable one-attempt receipts, refusal and acquisition-cost overhead passed.');
}finally{rmSync(scratch,{recursive:true,force:true});}
