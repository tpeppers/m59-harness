// External fine planners get their own geometry and the same typed sector
// observations as the keeper. One character's door replay cannot mutate another.
import {RoomGeometry} from './m59-roo.mjs';
import {applyCeilingDoors} from './m59-ceiling-doors.mjs';
import {applyDoorState} from './m59-routes.mjs';
export function copyFineGeometry(source){
 if(!source)return null;
 const geo=RoomGeometry.fromJSON(source.toJSON({includeSurfaces:false,graphEntrySquares:[],edgeDirections:[]}));
 if(source._stepMask)geo.attachStepMask(Buffer.from(source._stepMask));
 return geo;
}
export function applyFineSectorObservations(map,room,geo,movements){
 const observed=new Map(),heights={};
 for(const [key,value]of movements instanceof Map?movements:Object.entries(movements??{})){
  const sector=Number(key);
  if(!Number.isInteger(sector)||!Number.isFinite(value?.height)||!Number.isFinite(value?.type))continue;
  observed.set(sector,{...value});heights[sector]=value.height;
 }
 // Match the keeper observer's precedence; ceiling masks are complete states.
 return applyCeilingDoors(map,room,observed,null,{geometryOf:()=>geo})
   ??applyDoorState(map,room,heights,{geometryOf:()=>geo});
}
