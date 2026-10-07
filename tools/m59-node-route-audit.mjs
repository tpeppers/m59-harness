#!/usr/bin/env node
// Audit emitted node-route chords and integer-wire rounding. Offline; moves nobody.
// node tools/m59-node-route-audit.mjs 750 --from r46c25 --to r21c20 --exact-walk --json
// node tools/m59-node-route-audit.mjs 750 --plan /absolute/saved-plan.json --json
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {fineRouter} from './m59-fineroute.mjs';
import {quantizeRailPoint} from './m59-railfollow.mjs';
export function auditNodeWalk(plan,geo){
  const failures=[],legs=[];
  for(const [legIndex,leg] of (plan.legs??[]).entries()){
    if(leg.kind!=='walk')continue;
    const points=leg.waypoints??[],wires=[];
    for(const [index,p] of points.entries()){
      const wire=quantizeRailPoint(p,{floorAt:(x,y)=>geo.floorBaseAtClient(x,y,geo.leafAtClient(x,y)),
        edge:(a,b)=>geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:true})?.arrived===true});
      wires.push(wire);
      if(!wire.ok)failures.push({leg:legIndex,index,reason:wire.reason,point:p});
      if(index===0)continue;
      const from=points[index-1],trace=geo.traceFineMoveClient(from.x,from.y,p.x,p.y,{slide:true});
      if(trace?.arrived!==true)failures.push({leg:legIndex,index,reason:'unproved_chord',from,to:p,trace});
      const a=wires[index-1],b=wire;
      if(a.ok&&b.ok){const t=geo.traceFineMoveClient(a.client.x,a.client.y,b.client.x,b.client.y,{slide:true});
        if(t?.arrived!==true)failures.push({leg:legIndex,index,reason:'unproved_wire_chord',from:a.client,to:b.client,trace:t});}
    }
    legs.push({leg:legIndex,waypoints:points.length,wire_points:wires.filter(w=>w.ok).length});
  }
  return {ok:plan.ok===true&&failures.length===0,room:plan.room,planned:plan.ok===true,
    planning_failure:plan.ok?null:plan.why,jumps:plan.jumps??0,legs,failures,
    scope:'geometry and wire rounding only; live doors, bodies, arrival and return require a server trial'};
}
export const parseNodeSquare=s=>{const m=/^r(\d+)c(\d+)$/.exec(s??'');if(!m)throw Error('square must use rNcM');return {row:Number(m[1]),col:Number(m[2])};};
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2),flag=n=>args[args.indexOf('--'+n)+1],has=n=>args.includes('--'+n);
  if(has('help')){console.log('ROOM --from rNcM --to rNcM [--exact-walk] [--json], or ROOM --plan FILE');process.exit(0);}
  const room=Number(args[0]);if(!Number.isInteger(room)||room<=0)throw Error('room number required');
  const R=fineRouter(room,{exactWalk:has('exact-walk')});
  const plan=has('plan')?JSON.parse(readFileSync(flag('plan'),'utf8')):R.plan(parseNodeSquare(flag('from')),parseNodeSquare(flag('to')),{maxJumps:4});
  if(plan.room!=null&&Number(plan.room)!==room)throw Error('saved plan belongs to another room');
  const result=auditNodeWalk(plan,R.geo);
  console.log(has('json')?JSON.stringify({plan,audit:result},null,2):JSON.stringify(result,null,2));
  process.exitCode=result.ok?0:2;
}
