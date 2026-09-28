// Promoted node-runner approaches, composed into a cache-aware room-2 circuit.
// Promotion is explicit: a STONES entry or an offline route alone is not a working recipe.
import {nodeBit} from './m59-node-memory.mjs';
import {STONES} from './m59-stones.mjs';
export const CIRCUIT_NODES=Object.freeze(['victoria','sentinel','ancient','badlands','cave']);
export const CIRCUIT_REVISION=1;
export function booleanOption(value=false){
  if(value===true||value==='true')return true;
  if(value===false||value==='false')return false;
  throw Error('getAll must be true or false');
}
export function selectCircuitNodes(memory,{getAll=false}={}){
  const force=booleanOption(getAll),selected=[],skipped=[];
  for(const stone of CIRCUIT_NODES){
    const bit=nodeBit(stone),present=!!(memory?.known_mask&bit)&&!!(memory?.mask&bit);
    if(present&&!force)skipped.push({stone,reason:'cached_present',bit,observation:memory.observations?.[bit]??null});
    else selected.push(stone);
  }
  return {get_all:force,selected,skipped,cache_revision:memory?.revision??0,
    mask:memory?.mask??0,known_mask:memory?.known_mask??0,catalog_revision:CIRCUIT_REVISION};
}
const travel=to=>({kind:'travel',to}),road=(...rooms)=>rooms.map(travel);
const rail=(node,exit,direction='to_node')=>({kind:'rail',node,...(direction==='to_node'?{}:{direction}),...(exit?{exit}:{})});
const meld=node=>({kind:'meld',node});
export function circuitPlan(selected=CIRCUIT_NODES){
  if(new Set(selected).size!==selected.length||selected.some(k=>!CIRCUIT_NODES.includes(k)))throw Error('unsupported or duplicate circuit node');
  const want=new Set(selected),p=[];
  if(want.has('victoria'))p.push(...road(38,39),rail('victoria','go:38:r8c27'),meld('victoria'),
    rail('victoria','go:38:r9c27','to_exit'),...road(38,2));
  if(want.has('sentinel')){
    p.push(...road(599,589),rail('sentinel','edge:599:r18c46'),meld('sentinel'),
      rail('sentinel','edge:579:r43c1','to_exit'),travel(579));
    if(want.has('ancient'))p.push(rail('ancient','edge:589:r38c74'),meld('ancient'),rail('ancient','edge:578:r1c17','to_exit'));
    else p.push(rail('ancient-transit','east-to-north')); // Transit only; never visit its cached stone.
    p.push(...road(578,576,587));
  }else if(want.has('ancient')){
    // Reuse the node-runner's checked north inbound rail, bypassing Sentinel entirely.
    p.push(...road(599,598,597,587,576,578,579),rail('ancient','edge:578:r1c17'),meld('ancient'),
      rail('ancient','edge:578:r1c17','to_exit'),...road(578,576,587));
  }else if(want.has('badlands')||want.has('cave'))p.push(...road(599,598,597,587));
  if(want.has('badlands'))p.push(...road(586,585,584,583,593,49),
    {kind:'cut',room:49,x:19488,y:26656,row:27,col:20},{kind:'cross',row:28,col:20,to:45},
    rail('badlands'),meld('badlands'),{kind:'cut',room:45,boxFlood:true,row:1,col:53},
    {kind:'cross',row:0,col:53,to:49},{kind:'cut',room:49,x:20544,y:512,row:1,col:21},
    {kind:'cross',row:0,col:21,to:593},...road(583,584,574,150,575,576,587));
  if(want.has('cave')){
    if(!want.has('sentinel')&&!want.has('ancient')&&!want.has('badlands'))p.push(...road(576,587));
    p.push(travel(27),{kind:'walk',row:23,col:53},meld('cave'),{kind:'walk',row:57,col:45},...road(587,576,587,597,598,599,2));
  }else if(want.has('sentinel')||want.has('ancient')||want.has('badlands'))p.push(...road(597,598,599,2));
  return p;
}
export function selectedCircuitComplete(r){
  const selected=r.selection?.selected;
  return Array.isArray(selected)&&r.from_step===0&&!r.recovery&&!r.failure&&r.start?.room===2&&r.end?.room===2&&
    r.nodes?.length===selected.length&&r.nodes.every((n,i)=>{
      const stone=STONES[n.stone],p=n.position;
      return n.stone===selected[i]&&['melded','already'].includes(n.status)&&p?.room===stone?.room&&
        Math.abs(p.row-stone.row)<3&&Math.abs(p.col-stone.col)<3;
    });
}
