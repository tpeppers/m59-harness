// Ancient Place's moving floors, driven only by observed server sector packets.
// g9.kod:17-53,181-230; clientd3d/roomanim.c:487 (KOD height units/second).
import {sharedRoomGeometry,applySectorHeights} from './m59-roo.mjs';
import {forgetReach,noteDoorState} from './m59-routes.mjs';

export const BRAX_LIFT={room:579,sector:3,down:250,up:800,speed:15};
export const liftWaitMs=({down=250,up=800,speed=15}={})=>{
  if(!Number.isFinite(speed)||speed<=0)throw Error('positive lift speed required');
  return Math.ceil(Math.abs(up-down)*1000/speed)+1000;
};
// Sector 10 is a ceiling (skeleton cubbies), never a platform floor.
const ranges={2:[250,800],3:[250,800],4:[510,540],5:[200,340],6:[200,340],7:[200,340],8:[200,340],9:[510,540]};
const baselines=new WeakMap(), animations=new WeakMap();
export function applyAncientFloors(map,roomNum,observed,event=null,{geometryOf=sharedRoomGeometry,now=Date.now()}={}){
  if(Number(roomNum)!==579)return null;
  const geo=geometryOf(map.rooms[roomNum]);
  if(!geo?.sectors?.some(s=>s.serverId===3))return null;
  let base=baselines.get(geo);
  if(!base){base=geo.sectors.map(s=>s.floorHeight);baselines.set(geo,base);}
  const overrides=[];
  for(const [index,s]of geo.sectors.entries()){
    if(!ranges[s.serverId])continue;
    const seen=observed.get(s.serverId);
    // Replay is type 4 too; absent evidence means the actual shipped floor.
    const floor=seen?.type===4&&Number.isFinite(seen.height)&&seen.height>=0?seen.height*16:base[index];
    overrides.push({index,floor});
  }
  let changed=false;
  if(overrides.some(o=>geo.sectors[o.index].floorHeight!==o.floor)){
    const result=applySectorHeights(geo,overrides,{mask:new Uint8Array(geo.rows*geo.cols)});
    if(result.why)throw Error(result.why);
    if(!geo.attachStepMask(geo.buildStepMask()))throw Error('moving floor mask refused');
    geo._declaredJumps=null;geo._declaredReverse=null;
    forgetReach(roomNum);changed=true;
  }
  const state=overrides.map(o=>`${o.index}:${o.floor}`).join('|');
  noteDoorState(roomNum,state);
  const active=event?(animations.get(geo)??new Map()):new Map();
  for(const [id,a]of active)if(a.until<=now)active.delete(id);
  const range=event?.type===4?ranges[event.sector]:null;
  if(range&&Number.isFinite(event.speed)&&event.speed>=0){
    const until=now+(event.speed===0?0:Math.ceil((range[1]-range[0])*1000/event.speed)+1000);
    active.set(event.sector,{until,indices:overrides.filter(o=>geo.sectors[o.index].serverId===event.sector).map(o=>o.index)});
  }
  animations.set(geo,active);
  return {changed,state,settledAt:active.size?Math.max(...[...active.values()].map(a=>a.until)):null,
    sectorIndices:[...new Set([...active.values()].flatMap(a=>a.indices))]};
}
