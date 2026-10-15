// Prebaked fine walks are hints. Current geometry, mandatory avoidance and live
// bodies still decide whether each segment can execute. Coordinates are CLIENT.
import {readFileSync} from 'node:fs';
import {STEP_MASK_VERSION} from './m59-roo.mjs';
import {chordWalkable} from './m59-railcut.mjs';
let cached;
export function fineGuideBook(){
 if(cached!==undefined)return cached;
 try{cached=JSON.parse(readFileSync(new URL('../substrate/m59-fine-guides.json',import.meta.url)));}catch{cached=null;}
 return cached;
}
export function findFineGuide(geo,from,goal,{edge,book=fineGuideBook(),maxJoinSquares=2}={}){
 if(book?.format!=='m59-fine-guides/1'||book.stepMaskVersion!==STEP_MASK_VERSION||typeof edge!=='function')return null;
 const room=Object.values(book.rooms??{}).find(r=>r.security===geo?.security&&r.rows===geo.rows&&r.cols===geo.cols);
 if(!room)return null;
 const gap=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),candidates=[];
 for(const guide of room.guides??[]){
  const points=guide.waypoints,end=points?.at(-1);if(!end||gap(goal,end)>128)continue;
  for(let i=0;i<points.length;i++)if(gap(from,points[i])<=maxJoinSquares*1024)candidates.push({guide,i,distance:gap(from,points[i])});
 }
 for(const {guide,i} of candidates.sort((a,b)=>a.distance-b.distance||b.i-a.i)){
  const points=guide.waypoints.slice(i),first=points[0];
  if(!chordWalkable(from,first,{edge,lattice:128}).ok)continue;
  let previous=first,valid=true;
  for(const p of points.slice(1)){if(!chordWalkable(previous,p,{edge,lattice:128}).ok){valid=false;break;}previous=p;}
  if(!valid||!chordWalkable(previous,goal,{edge,lattice:128}).ok)continue;
  const waypoints=[{...from},...points,...(gap(previous,goal)>0?[{...goal}]:[])];
  return {ok:true,bridgeOk:true,waypoints,legs:waypoints.length-1,guide:guide.name,visited:0};
 }
 return null;
}
