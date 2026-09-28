// Offline reproduction of the remaining 2026-09-28 four-node defects.
// node tools/m59-node-defect-audit.mjs ancient|peak > ignored-receipt.json
// No network, server placement, or live reachability claim.
import {roomGeometry,traceReport,floorAt,edgeOf} from './m59-ground.mjs';
import {flood} from './m59-railcut.mjs';

const node=process.argv[2];
if(node==='ancient'){
  const geo=roomGeometry(579),takeoff={x:30720,y:39168},landing={x:30320,y:42000};
  console.log(JSON.stringify({format:'m59-node-defect-audit/1',node,room:579,
    caveat:'Offline exact-point model, not a live fall or arrival.',
    walk:traceReport(geo,{x:30720,y:38400},takeoff,{stride:64}),
    takeoff:{...takeoff,floor_client:floorAt(geo,takeoff.x,takeoff.y)},
    requested_landing:{...landing,floor_client:floorAt(geo,landing.x,landing.y)},
    fall:geo.traceFineMoveClient(takeoff.x,takeoff.y,landing.x,landing.y,{fall:true,slide:true})},null,2));
}else if(node==='peak'){
  const geo=roomGeometry(515),from={x:25552,y:38304},results=[];
  for(const lattice of [64,32]){
    const parent=flood(from,{edge:edgeOf(geo),bounds:{w:geo.cols*1024,h:geo.rows*1024},lattice,cap:1500000});
    let highest=-Infinity,nearest=null,distance=Infinity,box=0;
    for(const key of parent.keys()){
      const [x,y]=key.split(',').map(Number),row=Math.floor(y/1024)+1,col=Math.floor(x/1024)+1;
      const f=floorAt(geo,x,y),d=Math.max(Math.abs(row-20),Math.abs(col-17));highest=Math.max(highest,f??-Infinity);
      if(d<distance){distance=d;nearest={x,y,row,col,floor_client:f};}if(d<3)box++;
    }
    results.push({lattice,phase:{x:from.x%lattice,y:from.y%lattice},visited:parent.size,capped:parent.size>=1500000,
      highest_floor_client:highest,nearest,box_samples:box});
  }
  console.log(JSON.stringify({format:'m59-node-defect-audit/1',node,room:515,from,
    boarding:traceReport(geo,from,{x:24704,y:38016},{stride:64}),results,
    caveat:'Offline model; actual body seed without snapping. Zero samples do not prove impossibility.'},null,2));
}else throw Error('Choose ancient or peak');
