// Arrival distributions shared by the explorer and the travel selector. No game I/O.
import {findPath, AVOID_IN_TRANSIT, NEVER_ENTER} from './m59-map.mjs';
import {predictedRescueRoom} from './m59-rescue.mjs';
export const quantile=(xs,p=.9)=>{const a=[...xs].sort((a,b)=>a-b);return a.length?a[Math.max(0,Math.ceil(a.length*p)-1)]:null;};
export function transitEvidence(books,{since=Infinity}={}) {
 const edges=new Map();
 for(const book of books)for(const t of book.transits??[]) {
  if(t.at<since||!Number.isFinite(t.ms)||t.ms<0)continue;
  const k=`${t.room}>${t.to}`,e=edges.get(k)??{times:[],failed:0,total:0};e.total++;
  if(t.ok===true)e.times.push(t.ms);else e.failed++;edges.set(k,e);
 }
 return edges;
}
function random(seed=739391){return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}
// This is a conditional simulation, not a sum of edge P90s. Unknown edges are
// explicit deterministic user assumptions; failures remain visible separately.
export function estimateRoute(legs,edges=new Map(),{fallbackMs=20000,samples=1024,overheadMs=0}={}){
 const rng=random(),draws=[],walking=legs.flatMap(l=>l.kind==='walk'?l.hops:[]);
 const known=walking.filter(h=>edges.get(`${h.from}>${h.to}`)?.times.length>=5).length;
 let failed=0,attempts=0;for(const h of walking){const e=edges.get(`${h.from}>${h.to}`);failed+=e?.failed??0;attempts+=e?.total??0;}
 for(let n=0;n<samples;n++){
  let ms=overheadMs;
  for(const leg of legs)if(leg.kind==='walk')for(const h of leg.hops){const e=edges.get(`${h.from}>${h.to}`);ms+=e?.times.length>=5?e.times[Math.floor(rng()*e.times.length)]:fallbackMs;}
  else {const base=15000-Math.floor(15000*(leg.power??1)/100/4);ms+=base+(rng()<.5?5000+rng()*5000:0)+(leg.action_ms??1000);}
  draws.push(ms);
 }
 return {p50_ms:quantile(draws,.5),p90_ms:quantile(draws),draws,known_hops:known,walking_hops:walking.length,failed_attempts:failed,attempts,
  basis:known===walking.length?'modeled from current-epoch samples and native timers':'model includes assumed walking times',fallback_ms:fallbackMs};
}
export function arrivalOptions({map,from,to,guildHall=null,homeRoom=null,methods=[],maxRescues=2,blocked=[],confine=[],edges=new Map(),fallbackMs=20000,overheadMs=0,staging=true}){
 if(!Number.isInteger(from)||!Number.isInteger(to))return [];
 const banned=new Set([...AVOID_IN_TRANSIT,...blocked]);
 const legal=n=>!NEVER_ENTER.has(n)&&!blocked.includes(n)&&(!confine.length||confine.includes(n));
 const walk=(a,b)=>{if(a===b)return {kind:'walk',from:a,to:b,hops:[]};if(!legal(b))return null;const p=findPath(map,a,b,{avoid:banned});return p.found&&p.hops.every(h=>legal(Number(h.to)))?{kind:'walk',from:a,to:b,hops:p.hops}:null;};
 const options=[],seen=new Set();
 const name=n=>`${map.rooms[n]?.name??'Map'} [${n}]`;
 function add(legs){const key=JSON.stringify(legs);if(seen.has(key))return;seen.add(key);options.push({legs,...estimateRoute(legs,edges,{fallbackMs,overheadMs:from===to?0:overheadMs}),label:legs.filter(l=>l.kind!=='walk'||l.hops.length).map(l=>l.kind==='walk'?`Walk ${name(l.from)} → ${name(l.to)}`:`${l.kind==='chalice'?'Chalice':'Rescue'} → ${name(l.to)}`).join(' · ')||'Already there'});}
 const direct=walk(from,to);if(direct)add([direct]);
 if(!methods.length||from===to)return options;
 const starts=[from,...(staging?[2500,2510,59,...(guildHall?[guildHall]:[])]:[])];
 for(const start of new Set(starts)){
  const approach=walk(from,start);if(!approach)continue;
  function visit(room,legs,used,visited){
   if(used.length>=maxRescues)return;
   const landing=predictedRescueRoom(room,{guildHall,homeRoom});if(!landing||landing===room||visited.has(landing)||!legal(landing))return;
   for(const method of methods){
    const count=used.filter(x=>x===method.kind).length+1;if(count>method.uses)continue;
    const leg={kind:method.kind,from:room,to:landing,power:method.power??1,action_ms:method.action_ms??1000};
    const next=[...legs,leg],tail=walk(landing,to);if(tail)add([...next,tail]);
    visit(landing,next,[...used,method.kind],new Set([...visited,landing]));
   }
  }
  visit(start,[approach],[],new Set([start]));
 }
 return options.sort((a,b)=>a.p90_ms-b.p90_ms);
}
