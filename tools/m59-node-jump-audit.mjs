#!/usr/bin/env node
// Explain node jump proposals, physical bounds, walls and integer-wire landings. Offline.
// node tools/m59-node-jump-audit.mjs 515 --from-client-x 31232 --from-client-y 50688 --to r20c17 --json
// A checked model fall is a candidate for a held local trial, never a live declaration.
import {pathToFileURL} from 'node:url';
import {fineRouter,proveCandidateFall} from './m59-fineroute.mjs';
import {parseNodeSquare} from './m59-node-route-audit.mjs';
export function auditNodeJumps(router,from,to) {
  const geo=router.geo,floor=p=>geo.floorBaseAtClient(p.x,p.y,geo.leafAtClient(p.x,p.y));
  if(!Number.isFinite(floor(from))||from.x<0||from.y<0||from.x>=router.room.cols*1024||from.y>=router.room.rows*1024)throw Error('explicit seed must stand on a floor inside this room');
  if(to.row<1||to.col<1||to.row>router.room.rows||to.col>router.room.cols)throw Error('target square outside room');
  const seen=router.closure(from),search={},proposals=router.candidateJumps(seen,router.footing(to.row,to.col),{audit:search,prove:false});
  const candidates=proposals.map((p,index)=>({index,...p,...proveCandidateFall(geo,p)}));
  const rejections={};for(const c of candidates)if(c.reason)rejections[c.reason]=(rejections[c.reason]??0)+1;
  return {format:'m59-node-jump-audit/1',room:router.room.num,units:'client/BSP (1024 per square); wire endpoints labeled separately',
    from:{...from,floor_client:floor(from)},to,walking_points:seen.size,search,proposals:candidates.length,
    model_proved:candidates.filter(c=>c.model_proved).length,rejections,candidates,
    scope:'One exact seed and sampled closure. A model proof does not establish a live fall, approach or return.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2),has=k=>args.includes('--'+k),flag=k=>args[args.indexOf('--'+k)+1];
  if(has('help')){console.log('ROOM --from-client-x N --from-client-y N --to rNcM [--json]');process.exit(0);}
  const room=Number(args[0]),from={x:Number(flag('from-client-x')),y:Number(flag('from-client-y'))};
  if(!Number.isInteger(room)||room<=0||!has('from-client-x')||!has('from-client-y')||!Object.values(from).every(Number.isFinite))throw Error('explicit room and both client coordinates required');
  const R=fineRouter(room,{exactWalk:true}),report=auditNodeJumps(R,from,parseNodeSquare(flag('to')));
  console.log(JSON.stringify(has('json')?report:{...report,candidates:report.candidates.filter(c=>c.model_proved)},null,2));
}
