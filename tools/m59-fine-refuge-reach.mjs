import {planBodyDetour} from './m59-body-detour.mjs';
import {blocksMovement,OF} from './m59-parse.mjs';

// Keep a short, collision-checked escape while optimizing monster exposure.
// A time-limited price search is not evidence that this clear approach vanished.
// Both plans use the same body snapshot and all ordinary collision/avoidance rules.
export function planRecoveryApproach(geo,from,goal,options={},
 {plan=planBodyDetour,now=performance.now.bind(performance)}={}){
 const target=options.goalSquare??{row:Math.floor(goal?.y/64),col:Math.floor(goal?.x/64)};
 for(const body of options.objects?.values?.()??[]){
  if(body.id===options.selfId)continue;
  if(body.row===target.row&&body.col===target.col&&
      (blocksMovement(body.flags??0)||(body.flags&(OF.ATTACKABLE|OF.PLAYER))))
   return {found:false,reason:'recovery spot occupied'};
 }
 const threats=options.threats??[];
 if(!(options.threatWeight>0)||!threats.length)return plan(geo,from,goal,options);
 const started=now(),budget=Math.max(0,options.maxMs??80);
 const seed=plan(geo,from,goal,{...options,threats:[],threatWeight:0,maxMs:Math.min(25,budget/3)});
 let length=0,previous=from;
 for(const point of seed.waypoints??[]){length+=Math.hypot(point.x-previous.x,point.y-previous.y)/64;previous=point;}
 const incumbent=seed.found&&length<=8?seed:null;
 const remaining=Math.max(0,budget-(now()-started));
 const priced=remaining>0?plan(geo,from,goal,{...options,maxMs:remaining}):
  {found:false,reason:'body detour budget exhausted'};
 if(priced.found)return priced;
 if(incumbent&&priced.reason==='body detour budget exhausted')return {...incumbent,
  checked_short_fallback:true,price_refusal:priced.reason};
 return priced;
}

// One synchronous refuge scan has a shared allowance. Fine proof can supplement
// a coarse component only near this confirmed body, never across a distant room.
export function fineRefugeReach(geo,from,objects,selfId,{budgetMs=300}={}){
 const started=performance.now(),cache=new Map(),remaining=()=>Math.max(0,budgetMs-(performance.now()-started));
 const usable=geo?.collisionReady&&from&&!from.predicted&&[from.x,from.y,from.row,from.col].every(Number.isFinite);
 const snapshot=new Map([...(objects?.entries?.()??[])].map(([id,o])=>[id,{...o}]));
 const complete=[...snapshot.values()].every(o=>o.id===selfId||!blocksMovement(o.flags??0)||
  [o.x,o.y].every(Number.isFinite)||Math.hypot(o.row-from?.row,o.col-from?.col)>8);
 return (col,row)=>{
  const key=row+','+col;if(cache.has(key))return cache.get(key);
  const refuse=why=>{const r={reachable:false,why};cache.set(key,r);return r;};
  if([...snapshot.values()].some(o=>o.id!==selfId&&o.row===row&&o.col===col&&
    (blocksMovement(o.flags??0)||(o.flags&(OF.ATTACKABLE|OF.PLAYER)))))return refuse('recovery spot occupied');
  if(!usable||!complete||Math.max(Math.abs(row-from.row),Math.abs(col-from.col))>6||remaining()<=0)
   return refuse('nearby confirmed fine refuge proof unavailable');
  const goal=geo.standPointWire?.(row,col);if(!goal)return refuse('refuge footing unavailable');
  const options={objects:snapshot,selfId,marginSquares:4,maxRangeSquares:8,maxNodes:6000,maxMs:Math.min(80,remaining())};
  const p=planBodyDetour(geo,from,goal,{...options,goalSquare:{row,col}});
  if(!p.found)return refuse(p.reason??'fine refuge approach unproved');
  const end=p.waypoints.at(-1);let previous=from,length=0;
  for(const point of p.waypoints){length+=Math.hypot(point.x-previous.x,point.y-previous.y)/64;previous=point;}
  if(length>8)return refuse('fine refuge approach exceeds short recovery allowance');
  const back=remaining()>0?planBodyDetour(geo,end,from,{...options,maxMs:Math.min(80,remaining())}):null;
  const result={reachable:true,steps:length,fine_proved:true,returnable:back?.found===true,
   fine:{x:end.x,y:end.y},waypoints:p.waypoints};cache.set(key,result);return result;
 };
}
