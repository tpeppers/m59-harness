// Compile existing declared traversal affordances into a mesh. This module is
// authoring-only; it never declares a new jump, changes a sector, or sends one.
import {loadFallJumps} from './m59-falljump.mjs';
import {proveCandidateFall} from './m59-fineroute.mjs';
import {heightKodToClient} from './m59-roo.mjs';
import {proveNavMeshWalk} from './m59-navmesh.mjs';

const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
export function addDeclaredNavMeshLinks(geo,mesh,{declarations=loadFallJumps().jumps??[],attachRange=2048}={}){
  const nodes=mesh.nodes,stats={considered:0,proved:0,attached:0,refused:[]};
  const floor=p=>{const l=geo.leafAtClient(p.x,p.y);return l?.sector?geo.floorBaseAtClient(p.x,p.y,l):null;};
  const add=p=>{const prior=nodes.findIndex(n=>n.x===p.x&&n.y===p.y);if(prior>=0)return prior;const id=nodes.length;nodes.push({x:p.x,y:p.y,floor:floor(p),source:'declared-jump',edges:[]});return id;};
  const attach=id=>{
    const p=nodes[id],near=nodes.map((n,i)=>({i,d:distance(n,p)})).filter(n=>n.i!==id&&n.d<=attachRange).sort((a,b)=>a.d-b.d).slice(0,24);
    let joined=0;
    for(const n of near)for(const [from,to]of [[id,n.i],[n.i,id]]){
      if(nodes[from].edges.some(e=>e.to===to&&e.kind==='walk'))continue;
      const proof=proveNavMeshWalk(geo,[nodes[from],nodes[to]],{stride:96});
      if(proof.ok){nodes[from].edges.push({to,kind:'walk',points:proof.points,cost:proof.distance});joined++;}
    }
    return joined;
  };
  for(const declaration of declarations.filter(j=>Number(j.room)===Number(mesh.room))){
    stats.considered++;
    const unmet=Object.entries(declaration.requires?.sectors??{}).some(([id,height])=>!geo.sectors.some(s=>s.serverId===Number(id)&&s.floorHeight===heightKodToClient(height)));
    if(unmet){stats.refused.push({from:declaration.from,to:declaration.to,reason:'declared_sector_state_unmet'});continue;}
    const from=declaration.from_fine??geo.standPoint(declaration.from.row,declaration.from.col),to=declaration.to_fine??geo.standPoint(declaration.to.row,declaration.to.col);
    if(!from||!to){stats.refused.push({from:declaration.from,to:declaration.to,reason:'declared_footing_unavailable'});continue;}
    const proof=proveCandidateFall(geo,{fromFine:from,toFine:to});
    if(!proof.model_proved||!proof.from_wire?.client||!proof.to_wire?.client){stats.refused.push({from:declaration.from,to:declaration.to,reason:proof.reason});continue;}
    const a=proof.from_wire.client,b=proof.to_wire.client,source=add(a),target=add(b);
    nodes[source].edges.push({to:target,kind:'jump',points:[],cost:distance(a,b),action:{declared:true,
      room:mesh.room,from:{...declaration.from},to:{...declaration.to},fromFine:{...a},toFine:{...b},
      declaredFrom:{...from},declaredTo:{...to},requires:declaration.requires??null}});
    stats.proved++;stats.attached+=attach(source)+attach(target);
  }
  mesh.provenance={...mesh.provenance,declaredActions:stats,edges:nodes.reduce((n,p)=>n+p.edges.length,0)};
  return mesh;
}
