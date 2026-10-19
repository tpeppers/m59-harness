// A hard per-body movement boundary, checked again at the wire mutation boundary.
// Named coordinates here are protocol fine units (64 per square).
import {BP} from './m59-client.mjs';
import {roomGeometry,edgeOf} from './m59-ground.mjs';
import {protocolToClient,squareCentreClient} from './m59-finepos.mjs';
import {flood} from './m59-railcut.mjs';
import {selectedEdgeAt,codeExits} from './m59-map.mjs';
import {inRegion} from './m59-codeexits.mjs';
const compiled=new WeakMap();
export function movementRegionSpec(value){
 if(value==null)return null;
 if(typeof value!=='object'||Array.isArray(value)||value.version!==1||typeof value.id!=='string'||!value.id.trim()||!Array.isArray(value.rooms)||!value.rooms.length)throw Error('movement_region needs version1, id and nonempty rooms');
 const rooms=[...new Set(value.rooms)];if(rooms.some(n=>!Number.isInteger(n)||n<1))throw Error('movement_region rooms must be positive integers');
 const anchors={};for(const [room,p]of Object.entries(value.anchors??{})){
  if(!rooms.includes(Number(room))||!p||![p.x,p.y].every(n=>Number.isInteger(n)&&n>=64&&n<=65535))throw Error('movement_region anchor must name a permitted room and protocol fine x/y');
  anchors[room]={x:p.x,y:p.y};
 }
 if(Object.keys(value).some(k=>!['version','id','rooms','anchors'].includes(k)))throw Error('unknown movement_region field');
 return{version:1,id:value.id,rooms,anchors};
}
function component(geo,anchor){
 let cache=compiled.get(geo);if(!cache)compiled.set(geo,cache=new Map());const key=anchor.x+','+anchor.y;if(cache.has(key))return cache.get(key);
 const edge=edgeOf(geo),both=(a,b)=>edge(a,b)&&edge(b,a),seed=protocolToClient(anchor);
 // Keep the anchor's lattice phase; all candidates connect by an actual reversible trace.
 const points=flood(seed,{edge:both,bounds:{w:geo.cols*1024,h:geo.rows*1024},lattice:256,cap:100000});
 if(points.size>=100000)throw Error('movement_region component budget exhausted');
 const result={points,both,seed};cache.set(key,result);return result;
}
export function regionContains(geo,anchor,point){
 if(!geo||!point||![point.x,point.y].every(Number.isFinite))return false;
 const c=component(geo,anchor),p=protocolToClient(point),step=256;
 const nx=c.seed.x+Math.round((p.x-c.seed.x)/step)*step,ny=c.seed.y+Math.round((p.y-c.seed.y)/step)*step;
 for(const dx of [-step,0,step])for(const dy of [-step,0,step]){const q={x:nx+dx,y:ny+dy};if(c.points.has(q.x+','+q.y)&&c.both(p,q))return true;}return false;
}
export function regionSegmentAllowed(geo,anchor,from,to){
 if(!regionContains(geo,anchor,from)||!regionContains(geo,anchor,to))return false;
 const a=protocolToClient(from),b=protocolToClient(to),n=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/64));
 if(n>4096)return false;const both=component(geo,anchor).both;let prev=a;
 for(let i=1;i<=n;i++){const p={x:a.x+(b.x-a.x)*i/n,y:a.y+(b.y-a.y)*i/n};if(!both(prev,p)||!regionContains(geo,anchor,{x:p.x/16+64,y:p.y/16+64}))return false;prev=p;}return true;
}
const u16=b=>Buffer.isBuffer(b)&&b.length>=2?b.readUInt16LE(0):NaN;
const u32=b=>Buffer.isBuffer(b)&&b.length>=4?b.readUInt32LE(0)&0x0fffffff:NaN;
function refusal(s,contract,reason,detail={}){
 const old=s.movementRegionStatus??{};s.movementRegionStatus={id:contract.id,at:Date.now(),reason,count:(old.count??0)+1,...detail};
 throw Object.assign(new Error('movement_region: '+reason),{code:'MOVEMENT_REGION_BLOCKED',region:s.movementRegionStatus});
}
export function guardRegionPacket(s,value,op,parts=[]){
 if(!value)return;let contract;try{contract=movementRegionSpec(value);}catch(e){return refusal(s,{id:'invalid'},e.message);}
 const room=Number(s.world?.room?.num),c=s.client,me=c?.self;
 // Death/Underworld escape is involuntary and must remain possible. Once outside,
 // stay quarantined: never manufacture a new migration as a farming return.
 if(room===1)return;
 if(op===BP.REQ_ACTIVATE)return refusal(s,contract,'activation destination not proved',{room});
 const moving=[BP.REQ_MOVE,BP.REQ_GO,BP.REQ_CAST,BP.REQ_USE,BP.REQ_APPLY,BP.REQ_ACTIVATE].includes(op);if(!moving)return;
 if([BP.REQ_MOVE,BP.REQ_GO].includes(op)&&!contract.rooms.includes(room))return refusal(s,contract,'outside permitted rooms',{room});
 const anchor=contract.anchors[room],geo=anchor?(s.world?.geometry??roomGeometry(room)):null;
 if(anchor&&[BP.REQ_MOVE,BP.REQ_GO].includes(op)&&!regionContains(geo,anchor,me))return refusal(s,contract,'outside permitted component or position unknown',{room});
 if(op===BP.REQ_MOVE){
  const target={x:u16(parts[1]),y:u16(parts[0])};if(![target.x,target.y].every(Number.isFinite)||!me)return refusal(s,contract,'move position unknown',{room});
  const row=Math.floor(target.y/64),col=Math.floor(target.x/64),r=s.world.room;
  const dir=row<1?'north':row>r.rows?'south':col<1?'west':col>r.cols?'east':null;
  const e=dir?selectedEdgeAt(r,dir,{row,col}):null;
  const triggers=dir?[e]:codeExits(room).filter(e=>inRegion(e.when,row,col));
  if(triggers.some(e=>!e||!contract.rooms.includes(Number(e.to))))return refusal(s,contract,'exit outside permitted rooms',{room,target});
  if(dir){if(anchor&&(Math.hypot(target.x-me.x,target.y-me.y)>96||!edgeOf(geo)(protocolToClient(me),protocolToClient(target))))return refusal(s,contract,'off-map segment not proved',{room,target});if(!e)return refusal(s,contract,'unknown edge exit',{room,target});return;}
  if(anchor&&!regionSegmentAllowed(geo,anchor,me,target))return refusal(s,contract,'segment leaves returnable component',{room,from:{x:me.x,y:me.y},target});
 }
 if(op===BP.REQ_GO){
  const exits=(s.world?.exits?.()??[]).filter(e=>e.kind==='go'&&e.stand_on&&Math.hypot(e.stand_on.row-me?.row,e.stand_on.col-me?.col)<=1.5);
  if(!exits.length||exits.some(e=>!contract.rooms.includes(Number(e.to))))return refusal(s,contract,'go destination outside region or unknown',{room});
 }
 if(op===BP.REQ_CAST||op===BP.REQ_USE||op===BP.REQ_APPLY){
  const id=u32(parts[0]),items=op===BP.REQ_CAST?c.spells:[...(c.inventory??[]),...(c.items??[])];
  const item=items?.find(o=>(o.id&0x0fffffff)===id),name=String(item?.name??c.rsc?.get(item?.nameRsc)??'').toLowerCase();
  if(!name||/blink|rescue|teleport|portal|recall|warp|chalice|phase|shadow amulet|amulet of shadows/i.test(name))return refusal(s,contract,'transport or unknown item/spell blocked',{room,name,op});
 }
}
