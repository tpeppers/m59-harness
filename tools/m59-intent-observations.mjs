// Passive, process-local execution telemetry. No timers, game reads, or orders.
import {AsyncLocalStorage} from 'node:async_hooks';
const context=new AsyncLocalStorage(),latest=new WeakMap();
const number=x=>typeof x==='number'&&Number.isFinite(x);
const point=p=>p&&number(p.col)&&number(p.row)&&p.col>=0&&p.row>=0&&p.col<=65536&&p.row<=65536;
export function withIntent(session,target,run){
  const parent=context.getStore();
  const nested=parent?.session===session&&parent.active;
  const root=nested?parent.root:{session,client:session.client,room:session.client?.room?.id,
    player:session.client?.selfId,generation:session.movementGeneration,fightGeneration:session.fightGeneration,leaf:null};
  const scope={session,root,parent:nested?parent:null,target,active:true};
  if(!nested)latest.set(session,root);
  root.leaf=scope;
  return context.run(scope,async()=>{try{return await run();}finally{
    scope.active=false;
    if(root.leaf===scope)root.leaf=scope.parent?.active?scope.parent:null;
  }});
}
export function setIntentTarget(session,target){
  const scope=context.getStore();if(scope?.session===session&&scope.active)scope.target=target;
}
export function intentObservation(session,now=Date.now()){
  const c=session.client,root=latest.get(session);
  const result={schema:'m59-intent/1',at:now,connected:!!session.live,player_id:c?.selfId??null,
    room_object_id:c?.room?.id??null,target:null};
  if(!result.connected||!root||root.client!==c||root.room!==c?.room?.id||root.player!==c?.selfId||
    root.generation!==session.movementGeneration)return result;
  let scope=root.leaf;
  if(!scope?.active)return result;
  // A walk inside a pickup or doorway crossing retains that semantic target;
  // an independent survival action becomes a new root and supersedes it.
  for(let p=scope.parent;scope.target?.kind==='move'&&p?.active;p=p.parent)
    if(p.target)scope=p;
  const t=scope.target;
  if(!t||!['move','exit','attack','pickup','approach'].includes(t.kind))return result;
  if(t.kind==='attack'&&root.fightGeneration!==session.fightGeneration)return result;
  if(Number.isSafeInteger(t.object_id)&&t.object_id>0&&t.object_id<=0x0fffffff){
    const o=c.room?.objects?.get(t.object_id);
    if(o&&point(o))result.target={kind:t.kind,object_id:t.object_id,col:o.col,row:o.row};
  }else if(point(t)&&['move','exit'].includes(t.kind)){
    result.target={kind:t.kind,col:t.col,row:t.row};
    if(t.kind==='exit'&&Number.isSafeInteger(t.destination_room)&&t.destination_room>0)
      result.target.destination_room=t.destination_room;
  }
  return result;
}
// Explicitly wrap only execution boundaries. Preserve receiver/arguments/results
// and exceptions. Original method bodies remain independently testable.
export function installIntentObservers(prototype){
  const selectors={
    walkTo:(col,row)=>({kind:'move',col,row}),
    walkFine:(x,y)=>({kind:'move',col:x/64-0.5,row:y/64-0.5}),
    approachFine:(col,row)=>({kind:'move',col,row}),
    leaveVia:e=>({kind:'exit',col:e?.stand_on?.col,row:e?.stand_on?.row,destination_room:e?.to}),
    attackRounds:object_id=>({kind:'attack',object_id}),
    lootFloor:()=>null,
  };
  for(const [name,select] of Object.entries(selectors)){
    const original=prototype[name];if(typeof original!=='function')continue;
    prototype[name]=function(...args){return withIntent(this,select(...args),()=>original.apply(this,args));};
  }
}
