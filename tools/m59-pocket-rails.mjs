// Fine-coordinate escape rails. A square is a label, never proof that a body can board.
import {readFileSync} from 'node:fs';
import {protocolToClient, STEP_MASK_VERSION} from './m59-roo.mjs';
import {blockingBodySnapshot, planBodyDetour} from './m59-body-detour.mjs';
import {bakedPath} from './m59-routes.mjs';
import {blocksMovement} from './m59-parse.mjs';

let book;
export function pocketRailBook() {
  if (book !== undefined) return book;
  try { book=JSON.parse(readFileSync(new URL('../substrate/m59-pocket-rails.json',import.meta.url))); }
  catch { book=null; }
  return book;
}
const square=p=>({row:Math.floor(p.y/64),col:Math.floor(p.x/64)});
const gap=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
export function bodySignature(objects,selfId) {
  return [...(objects?.values?.()??[])].filter(o=>o.id!==selfId&&blocksMovement(o.flags??0)&&Number.isFinite(o.x)&&Number.isFinite(o.y))
    .map(o=>[o.id,o.flags,o.x,o.y].join(':')).sort().join('|');
}
const state=v=>v instanceof Map?[...v.entries()].sort(([a],[b])=>String(a).localeCompare(String(b))):v??null;
export function quarryApproachSignature(s,foe) {
  const c=s?.client,p=c?.self;
  return JSON.stringify([s?.world?.room?.num,c?.room?.id,p?.x,p?.y,foe?.id,foe?.nameRsc,foe?.x,foe?.y,
    c?.room?.flags,state(c?.room?.overrideDepths),state(c?.room?.sectorHeights),bodySignature(c?.room?.objects,c?.selfId)]);
}
export function railBookRoom(geo,room,manifest=null) {
  const b=pocketRailBook(),r=b?.rooms?.[room];
  if(b?.format!=='m59-pocket-rails/1'||b.stepMaskVersion!==STEP_MASK_VERSION
    ||(manifest&&manifest!==b.geometryManifestSha256)||!r||r.security!==geo?.security
    ||r.rows!==geo.rows||r.cols!==geo.cols)return null;
  return r;
}
export function traceWireLeg(geo,from,to,{objects,selfId,roomFlags=0,overrideDepths=null,avoidSquares=null}={}) {
  const n=Math.max(1,Math.ceil(gap(from,to)/8));
  for(let i=1;i<=n;i++)if(avoidSquares?.has?.(`${square({x:from.x+(to.x-from.x)*i/n,y:from.y+(to.y-from.y)*i/n}).row},${square({x:from.x+(to.x-from.x)*i/n,y:from.y+(to.y-from.y)*i/n}).col}`))
    return {ok:false,reason:'mandatory_avoidance'};
  const t=geo.traceFineMoveClient(protocolToClient(from.x),protocolToClient(from.y),protocolToClient(to.x),protocolToClient(to.y),
    {slide:false,obstacles:blockingBodySnapshot(objects,selfId),roomFlags,overrideDepths});
  return {ok:!!t&&t.available!==false&&gap({x:t.x,y:t.y},{x:protocolToClient(to.x),y:protocolToClient(to.y)})<=16,
    reason:t?.reason,objectId:t?.objectId,from,to};
}
export function validateEscape(geo,from,legs,options={}) {
  let at=from;
  for(const to of legs){const r=traceWireLeg(geo,at,to,options);if(!r.ok)return r;at=to;}
  return {ok:true,last:at};
}

// Clearance of the body centre across a neck, not the server's coarse floor cells.
export function fineChokeWidth(geo,p) {
  if(!geo?.collisionReady)return null;
  const spans=[];
  for(const [dx,dy] of [[1,0],[0,1],[Math.SQRT1_2,Math.SQRT1_2],[Math.SQRT1_2,-Math.SQRT1_2]]) {
    let width=0;
    for(const sign of [-1,1])for(let d=2;d<=64;d+=2){
      const q={x:Math.round(p.x+sign*dx*d),y:Math.round(p.y+sign*dy*d)};
      if(!traceWireLeg(geo,p,q).ok)break;width+=2;
    }
    spans.push(width);
  }
  const width=Math.min(...spans),longitudinal=Math.max(...spans);
  // Admission is conservative at a recorded obstruction: up to one square of
  // centre clearance can still strand two bodies at a bend. This is not a claim
  // that no two players can pass; the stock collision predicate still decides.
  return {width,longitudinal,narrow:width>0&&width<=64&&longitudinal>=64};
}
export function fineChokesFor(geo) {
  const b=pocketRailBook();if(b?.stepMaskVersion!==STEP_MASK_VERSION)return [];
  const r=Object.values(b.rooms??{}).find(r=>r.security===geo?.security&&r.rows===geo.rows&&r.cols===geo.cols);
  return (r?.chokes??[]).filter(p=>fineChokeWidth(geo,p)?.narrow);
}
export function isFinePassageStop(geo,p) {
  return fineChokesFor(geo).some(q=>Math.abs(q.x-p.x)<=32&&Math.abs(q.y-p.y)<=32);
}

// Recover to the real goal when local, or to a proved suffix of a compatible rail.
// Failed waypoints are never substituted for a distant destination.
const searchProgress=new WeakMap();
export function planRailDeparture(geo,from,to,{room,table,manifest=null,objects,selfId,
  roomFlags=0,overrideDepths=null,sectorHeights=null,avoidSquares=null,seedOnly=false,maxNodes=16000,maxMs=500,
  threats=[],threatWeight=0,threatRadius=4}={}) {
  if(!geo?.collisionReady||typeof geo.traceFineMoveClient!=='function'||![from?.x,from?.y,to?.row,to?.col].every(Number.isFinite))
    return {found:false,reason:'departure geometry or position unavailable'};
  if(manifest&&table?.geometryManifestSha256!==manifest)return {found:false,reason:'departure table geometry mismatch'};
  from={...from,...square(from)};
  const options={objects,selfId,roomFlags,overrideDepths,avoidSquares,threats,threatWeight,threatRadius},r=table?.rooms?.[room];
  const anchor=r?.anchors?.find(a=>a.row===to.row&&a.col===to.col)
    ??r?.anchors?.filter(a=>(a.row===to.row&&(a.row===1||a.row===geo.rows))
      ||(a.col===to.col&&(a.col===1||a.col===geo.cols)))
      .sort((a,b)=>Math.hypot(a.row-to.row,a.col-to.col)-Math.hypot(b.row-to.row,b.col-to.col))[0]
    ??r?.anchors?.filter(a=>a.kind==='edge'&&Math.max(Math.abs(a.row-to.row),Math.abs(a.col-to.col))<=2
      &&(a.dir==='west'&&to.col<=3||a.dir==='east'&&to.col>=geo.cols-2
        ||a.dir==='north'&&to.row<=3||a.dir==='south'&&to.row>=geo.rows-2))
      .sort((a,b)=>Math.hypot(a.row-to.row,a.col-to.col)-Math.hypot(b.row-to.row,b.col-to.col))[0];
  let obstruction=null;
  const rb=railBookRoom(geo,room,manifest);
  for(const rail of [...(rb?.rails??[])].sort((a,b)=>gap(from,a.from)-gap(from,b.from))) {
    if(!anchor||rail.exit.row!==anchor.row||rail.exit.col!==anchor.col||gap(from,rail.from)>64)continue;
    const line=bakedPath(table,room,rail.line_from,rail.exit);
    const index=line?.findIndex(q=>q.row===rail.board.row&&q.col===rail.board.col);
    if(index==null||index<0)continue;
    const legs=gap(from,rail.from)<=1?rail.legs:[rail.from,...rail.legs];
    const staticProof=validateEscape(geo,from,legs,{roomFlags,overrideDepths,avoidSquares});
    if(!staticProof.ok)continue;
    const proof=validateEscape(geo,from,legs,options);
    if(proof.ok)return {found:true,waypoints:legs,square:rail.board,rail:{from:rail.board,squares:line.slice(index)},via:'baked_pocket_rail'};
    obstruction??=proof;
  }
  const candidates=[];
  if(!seedOnly&&Math.max(Math.abs(to.row-from.row),Math.abs(to.col-from.col))<=24)candidates.push({square:to});
  if(anchor)for(const key of Object.keys(r.routes??{}).filter(k=>k.endsWith(`>${anchor.row},${anchor.col}`))) {
    const [row,col]=key.split('>')[0].split(',').map(Number),line=bakedPath(table,room,{row,col},anchor);
    for(const [index,q] of (line??[]).entries())if(Math.max(Math.abs(q.row-from.row),Math.abs(q.col-from.col))<=(seedOnly?1:24))
      candidates.push({square:q,rail:{from:q,squares:line.slice(index)},distance:Math.hypot(q.row-from.row,q.col-from.col)});
  }
  const progressKey=JSON.stringify([room,table?.geometryManifestSha256,from.x,from.y,to.row,to.col,roomFlags,state(overrideDepths),state(sectorHeights),
    bodySignature(objects,selfId),[...(avoidSquares??[])].sort()]);
  const progress=searchProgress.get(geo)??new Map();searchProgress.set(geo,progress);
  const done=seedOnly?new Set():(progress.get(progressKey)??new Set());
  if(!seedOnly){if(progress.size>=64&&!progress.has(progressKey))progress.delete(progress.keys().next().value);progress.set(progressKey,done);}
  const seen=new Set(),started=performance.now();let searchIncomplete=false;
  const budget=seedOnly?Math.min(35,maxMs):maxMs;
  for(const candidate of candidates.sort((a,b)=>(a.distance??-1)-(b.distance??-1))) {
    const q=candidate.square,next=candidate.rail?.squares?.[1];
    const k=`${q.row},${q.col}>${next?.row??''},${next?.col??''}`;
    if(seen.has(k)||done.has(k))continue;seen.add(k);
    const remaining=budget-(performance.now()-started);if(remaining<=0){searchIncomplete=true;break;}
    const goal=geo.standPointWire(q.row,q.col);if(!goal){done.add(k);continue;}
    const plan=planBodyDetour(geo,from,goal,{...options,goalSquare:q,marginSquares:seedOnly?2:12,maxRangeSquares:24,
      spacingUnits:16,maxNodes:seedOnly?Math.min(512,maxNodes):maxNodes,maxMs:remaining});
    if(plan.reason==='body detour budget exhausted')searchIncomplete=true;
    else if(!plan.found)done.add(k);
    if(plan.found){
      const next=candidate.rail?.squares?.[1];
      if(next){
        const at=plan.waypoints.at(-1)??from,point=geo.standPointWire(next.row,next.col);
        const onward=point&&planBodyDetour(geo,at,point,{...options,goalSquare:next,marginSquares:seedOnly?2:12,maxRangeSquares:24,
          spacingUnits:16,maxNodes:seedOnly?512:maxNodes,maxMs:Math.max(1,budget-(performance.now()-started))});
        if(!onward?.found){if(onward?.reason==='body detour budget exhausted')searchIncomplete=true;else done.add(k);continue;}
        plan.waypoints.push(...onward.waypoints);candidate.square=next;
        candidate.rail={from:next,squares:candidate.rail.squares.slice(1)};
      }
      progress.delete(progressKey);return {...plan,...candidate,via:'fine_rail_departure'};
    }
  }
  return {found:false,reason:obstruction?.reason==='object_blocked'?'departure_object_blocked':searchIncomplete?'departure_search_budget':'no reachable departure waypoint',obstruction,searchIncomplete};
}

const refusals=new WeakMap();
export function departureContext(s,to,avoidSquares=null) {
  const c=s.client,me=c?.self;
  return JSON.stringify([s.world?.room?.num,c?.room?.id,me?.x,me?.y,to?.row,to?.col,c?.room?.flags,
    state(c?.room?.overrideDepths),state(c?.room?.sectorHeights),s.world?.map?.geometryManifestSha256,
    bodySignature(c?.room?.objects,c?.selfId),[...(avoidSquares??[])].sort()]);
}
export function rememberedDeparture(s,to,avoid) {const r=refusals.get(s);return r?.geometry===s.world?.geometry&&r?.key===departureContext(s,to,avoid)?r:null;}
export function rememberDeparture(s,to,avoid,failure) {refusals.set(s,{key:departureContext(s,to,avoid),geometry:s.world?.geometry,failure});}
export function forgetDeparture(s) {refusals.delete(s);}
