// A chalice handoff is an ordinary, two-sided gift. It never spends a charge.
// Rescue itself belongs to the player; a caller may keep awaiting that timer.
import {isChalice} from './m59-rescue.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function handoffChalice(giver,receiver,itemId,{stopped=()=>false}={}){
  const g=giver.need(),r=receiver.need();
  const guard=()=>{
    if(stopped()||giver.client!==g||receiver.client!==r||!giver.live||!receiver.live
      ||giver.world?.room?.num!==receiver.world?.room?.num)throw Error('chalice handoff preempted');
    if(r.inventory.some(i=>isChalice(r,i)))throw Error('recipient already holds a chalice; merging is refused');
    if(!g.inventory.some(i=>i.id===itemId&&isChalice(g,i)))throw Error('giver no longer holds the chalice');
  };
  guard();
  if(g.trade||r.trade)throw Error('another trade is already open');
  let offered=false;
  try{
    const before=r.evSeq;
    await giver.pacer.submit('trade',()=>{guard();g.offer(r.selfId,[itemId]);offered=true;});
    await r.waitFor({since:before,kinds:['offered-to-us','trade-ended'],timeoutMs:3000});
    if(r.trade?.withId!==g.selfId||r.trade.theirs.length!==1||r.trade.theirs[0].id!==itemId)
      throw Error('recipient did not observe the exact chalice offer');
    const counter=g.evSeq;
    await receiver.pacer.submit('trade',()=>{guard();r.counterOffer([]);});
    await g.waitFor({since:counter,kinds:['countered','trade-ended'],timeoutMs:3000});
    if(g.trade?.withId!==r.selfId||!g.trade.mayAccept||g.trade.theirs?.length)
      throw Error('empty counteroffer was not verified');
    await giver.pacer.submit('trade',()=>{guard();g.acceptOffer();});
    for(let i=0;i<30;i++){
      if(!g.inventory.some(x=>x.id===itemId)&&r.inventory.some(x=>x.id===itemId&&isChalice(r,x))){
        if(giver.chaliceErrand?.item_id===itemId)giver.chaliceErrand=null;
        return {ok:true,item_id:itemId,from:g.selfId,to:r.selfId};
      }
      await sleep(100);
    }
    throw Error('chalice ownership did not confirm on both inventories');
  }finally{
    if(offered&&g.trade?.withId===r.selfId)await giver.pacer.submit('trade',()=>g.cancelOffer()).catch(()=>{});
  }
}
