// General fine-scale refuge routing. Expensive room searches run off the keeper
// event loop so survival and ownership changes remain observable during planning.
import {Worker,parentPort,workerData} from 'node:worker_threads';
import {RoomGeometry,protocolToClient,clientToProtocol} from './m59-roo.mjs';
import {cutRail,threatEdgeCost,chordWalkable} from './m59-railcut.mjs';
import {legWalls} from './m59-safelegs.mjs';
import {planBodyDetour,blockingBodySnapshot} from './m59-body-detour.mjs';
import {findFineGuide} from './m59-fine-guides.mjs';

export function planFineRailRefuge(geo,from,goal,{maxLeg=20,occupied=null,unreachable=null,
  avoidSquares=null,objects=null,selfId=null,roomFlags=0,overrideDepths=null,
  threats=[],threatWeight=6,threatRadius=4,maxMs=10000,goalFine=null,goalFineAlternates=[]}={}){
  const started=performance.now(),point=p=>({x:protocolToClient(p.x),y:protocolToClient(p.y)});
  if(!geo?.collisionReady||![from?.x,from?.y].every(Number.isFinite))return {found:false,reason:'fine_rail_geometry_unavailable'};
  const exactGoal=Number.isFinite(goalFine?.x)&&Number.isFinite(goalFine?.y);
  let target=exactGoal?{x:Math.round(goalFine.x),y:Math.round(goalFine.y)}:geo.standPointWire(goal.row,goal.col);
  if(!target)return {found:false,reason:'fine_rail_goal_unavailable'};
  // Only this prefix is executed. A distant body blocking a later doorway
  // cannot disprove the first refuge; its position will be re-read there.
  const localObjects=new Map([...(objects?.values?.()??[])].filter(o=>
    Number.isFinite(o.x)&&Number.isFinite(o.y)&&Math.hypot(o.x-from.x,o.y-from.y)<=(maxLeg+2)*64).map(o=>[o.id,o]));
  const obstacles=blockingBodySnapshot(localObjects,selfId);
  const edge=(a,b)=>{
    const row=Math.floor(clientToProtocol(b.y)/64),col=Math.floor(clientToProtocol(b.x)/64);
    if(avoidSquares?.has(`${row},${col}`))return false;
    const t=geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false,obstacles,roomFlags,overrideDepths});
    return t?.arrived===true&&t.blocked!==true;
  };
  const danger=threats.map(p=>point({x:Number.isFinite(p.x)?p.x:p.col*64+32,y:Number.isFinite(p.y)?p.y:p.row*64+32}));
  const cost=threatEdgeCost(danger,{radius:threatRadius*1024,weight:threatWeight,spacing:128,cacheSize:65536});
  let rail;const candidates=[target,...(exactGoal?goalFineAlternates:[])].filter(p=>Number.isFinite(p?.x)&&Number.isFinite(p?.y));
  const usedTargets=new Set();
  for(const p of candidates.slice(0,8)){
    const candidate={x:Math.round(p.x),y:Math.round(p.y)},key=candidate.x+','+candidate.y;
    if(usedTargets.has(key))continue;usedTargets.add(key);
    const remaining=maxMs-(performance.now()-started);if(remaining<=0)break;
    target=candidate;
    // Discard a sealed fine opening on geometry alone before spending the
    // threat-priced search budget on its entire unreachable component.
    if(exactGoal&&candidates.length>1){
      rail=cutRail(point(from),point(target),{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},lattice:128});
      if(!rail.ok||!rail.bridgeOk)continue;
      if(!danger.length)break;
    }
    rail=cutRail(point(from),point(target),{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},
      lattice:128,cost:danger.length?cost:null,maxMs:Math.max(0,maxMs-(performance.now()-started))});
    if(rail.ok&&rail.bridgeOk)break;
  }
  if(!rail)return {found:false,reason:'fine_rail_search_budget'};
  if((!rail.ok||!rail.bridgeOk)&&obstacles.length){
    const geometryEdge=(a,b)=>{
      const row=Math.floor(clientToProtocol(b.y)/64),col=Math.floor(clientToProtocol(b.x)/64);
      if(avoidSquares?.has(`${row},${col}`))return false;
      const t=geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false,roomFlags,overrideDepths});
      return t?.arrived===true&&t.blocked!==true;
    };
    const guide=cutRail(point(from),point(target),{edge:geometryEdge,bounds:{w:geo.cols*1024,h:geo.rows*1024},
      lattice:128,cost:danger.length?cost:null,maxMs:Math.max(0,maxMs-(performance.now()-started))});
    if(guide.ok&&guide.bridgeOk&&edge(point(from),guide.waypoints[0])){
      const checked=[guide.waypoints[0]];let previous=checked[0];
      for(const p of guide.waypoints.slice(1)){if(!edge(previous,p))break;checked.push(p);previous=p;}
      if(checked.length>1)rail={...guide,waypoints:checked,partial:checked.length<guide.waypoints.length};
    }
  }
  if(!rail.ok||!rail.bridgeOk)return {found:false,reason:rail.why??'fine_rail_bridge_unproved',visited:rail.visited};
  if(exactGoal&&!rail.partial){
    const end=rail.waypoints.at(-1),raw=point(target);
    if(Math.hypot(end.x-raw.x,end.y-raw.y)>0.01){
      if(!edge(end,raw)||!chordWalkable(end,raw,{edge,lattice:128}).ok)return {found:false,reason:'fine_rail_goal_bridge_unproved'};
      rail.waypoints.push(raw);
    }
  }
  const walls=legWalls(geo,{occupied,unreachable}),keys=new Set(walls.map(w=>w.row+','+w.col));
  const points=rail.waypoints.slice(1).map(p=>({x:clientToProtocol(p.x),y:clientToProtocol(p.y)}));
  let at=from,used=0,stop=null;const prefix=[];
  for(const p of points){
    used+=Math.hypot(p.x-at.x,p.y-at.y)/64;at=p;
    if(used>maxLeg)break;
    prefix.push({...p,distance:used});
    const row=Math.floor(p.y/64),col=Math.floor(p.x/64);
    if((row!==from.row||col!==from.col)&&keys.has(row+','+col))stop={row,col,steps:used,waypoints:prefix.map(({x,y})=>({x,y}))};
    if(exactGoal?Math.hypot(p.x-target.x,p.y-target.y)<=1:row===goal.row&&col===goal.col){
      stop={kind:'exit',row,col,steps:used,waypoints:prefix.map(({x,y})=>({x,y}))};break;
    }
  }
  // A shortest lane may pass beside a wall without entering its safe square.
  // Ask the body mover for a short side approach, charged to the same leg budget.
  if(!stop)for(let i=prefix.length-1;i>=0;i-=8){
    if(performance.now()-started>maxMs+500)break;
    const p=prefix[i],near=walls.filter(w=>Math.hypot(w.col-Math.floor(p.x/64),w.row-Math.floor(p.y/64))<=2
      &&(w.row!==from.row||w.col!==from.col)).sort((a,b)=>Math.hypot(a.row-goal.row,a.col-goal.col)-Math.hypot(b.row-goal.row,b.col-goal.col));
    for(const w of near.slice(0,4)){
      const side=planBodyDetour(geo,p,geo.standPointWire(w.row,w.col),{objects,selfId,roomFlags,overrideDepths,
        goalSquare:w,avoidSquares,marginSquares:2,maxRangeSquares:8,maxNodes:768,maxMs:35,threats,threatWeight,threatRadius});
      if(!side.found)continue;
      let q=p,extra=0;for(const n of side.waypoints){extra+=Math.hypot(n.x-q.x,n.y-q.y)/64;q=n;}
      if(p.distance+extra>maxLeg)continue;
      stop={row:w.row,col:w.col,steps:p.distance+extra,waypoints:[...prefix.slice(0,i+1).map(({x,y})=>({x,y})),...side.waypoints]};break;
    }
    if(stop)break;
  }
  if(!stop&&obstacles.length&&legWalls(geo).some(w=>w.row===from.row&&w.col===from.col)){
    // A preferred rail can end at a body choke while another covered lane is
    // still open. Search actual reachable refuges before waiting at this one.
    // The caller excludes visited stops, so this cannot oscillate between them.
    const candidates=walls.filter(w=>(w.row!==from.row||w.col!==from.col)&&
      Math.hypot(w.row-from.row,w.col-from.col)<=Math.min(12,maxLeg))
      .sort((a,b)=>(Math.hypot(a.row-goal.row,a.col-goal.col)+.25*Math.hypot(a.row-from.row,a.col-from.col))-
                  (Math.hypot(b.row-goal.row,b.col-goal.col)+.25*Math.hypot(b.row-from.row,b.col-from.col)));
    for(const w of candidates.slice(0,24)){
      if(performance.now()-started>maxMs+500)break;
      const side=planBodyDetour(geo,from,geo.standPointWire(w.row,w.col),{objects,selfId,roomFlags,overrideDepths,
        goalSquare:w,avoidSquares,marginSquares:3,maxRangeSquares:14,maxNodes:6000,maxMs:80,threats,threatWeight,threatRadius});
      if(!side.found||!side.waypoints.length)continue;
      let previous=from,distance=0;for(const p of side.waypoints){distance+=Math.hypot(p.x-previous.x,p.y-previous.y)/64;previous=p;}
      if(distance>maxLeg||Math.floor(previous.y/64)!==w.row||Math.floor(previous.x/64)!==w.col)continue;
      stop={row:w.row,col:w.col,steps:distance,waypoints:side.waypoints,alternative_refuge:true};break;
    }
  }
  if(stop){
    const pulled=[];let source=point(from);
    for(let i=0;i<stop.waypoints.length;){
      let last=i,total=0,previous=source;
      for(let j=i;j<stop.waypoints.length;j++){
        const p=point(stop.waypoints[j]);total+=cost(previous,p);previous=p;
        if(Math.hypot(p.x-source.x,p.y-source.y)>2048||!edge(source,p)||!chordWalkable(source,p,{edge,lattice:128}).ok)break;
        if(cost(source,p)<=total+0.01)last=j;
      }
      pulled.push(stop.waypoints[last]);source=point(stop.waypoints[last]);i=last+1;
    }
    stop.waypoints=pulled;
  }
  if(!stop&&obstacles.length&&legWalls(geo).some(w=>w.row===from.row&&w.col===from.col))
    return {found:false,reason:'body_traffic_at_refuge',waiting_refuge:{row:from.row,col:from.col},body_obstacles:obstacles.length,visited:rail.visited,ms:performance.now()-started};
  return stop?{found:true,kind:'wall',...stop,visited:rail.visited,ms:performance.now()-started}:
    {found:false,reason:'no_refuge_on_fine_rail',visited:rail.visited,ms:performance.now()-started};
}

export const planFineRailRefugeAsync=(geo,from,goal,options={},settings={})=>
  runFineRailWorker(geo,from,goal,options,{...settings,task:'refuge'});
// Inputs are KOD; the returned rail retains the cutter's CLIENT coordinates.
export const cutFineRailAsync=(geo,from,goal,options={},settings={})=>
  runFineRailWorker(geo,from,goal,options,{...settings,task:'cut'});
async function runFineRailWorker(geo,from,goal,options,{cancelled=()=>false,timeoutMs=12000,task}={}){
  if(cancelled())return {found:false,cancelled:true,reason:'movement_cancelled'};
  if(options.avoidSquares!=null&&!(options.avoidSquares instanceof Set))throw TypeError('avoidSquares must be a Set of row,col keys');
  if(options.bodyRangeSquares!==undefined&&(!Number.isFinite(options.bodyRangeSquares)||options.bodyRangeSquares<=0))throw RangeError('bodyRangeSquares must be positive and finite');
  const geometry=geo.toJSON({includeSurfaces:false,graphEntrySquares:[],edgeDirections:[]});
  const copy={...options,threats:(options.threats??[]).map(o=>({row:o.row,col:o.col,x:o.x,y:o.y})),
    objects:[...(options.objects?.values?.()??[])].map(o=>({id:o.id,x:o.x,y:o.y,flags:o.flags}))};
  const pose={row:from.row,col:from.col,x:from.x,y:from.y};
  return new Promise(resolve=>{
    const worker=new Worker(new URL('./m59-fine-rail.mjs',import.meta.url),{
      execArgv:[],resourceLimits:{maxOldGenerationSizeMb:256},
      workerData:{kind:'m59-fine-rail/1',task,geometry,stepMask:geo._stepMask??null,from:pose,goal,options:copy}});
    // Every search is bounded and sends no packets. Let its isolate exit
    // naturally even after cancellation: forcibly terminating a compiling
    // worker crashed the containing keeper in Windows Node 25 (V8 !is_null).
    let done=false;const finish=result=>{if(done)return;done=true;clearInterval(check);clearTimeout(timer);resolve(result);};
    const check=setInterval(()=>{if(cancelled())finish({found:false,cancelled:true,reason:'movement_cancelled'});},25);
    const timer=setTimeout(()=>finish({found:false,reason:'fine_rail_worker_budget'}),timeoutMs);
    worker.once('message',finish);worker.once('error',error=>finish({found:false,reason:'fine_rail_worker_error',error:error.message}));
    worker.once('exit',code=>{if(!done)finish({found:false,reason:'fine_rail_worker_exit',code});});
  });
}
if(parentPort&&workerData?.kind==='m59-fine-rail/1'){
  const geo=RoomGeometry.fromJSON(workerData.geometry),o=workerData.options;
  if(workerData.stepMask)geo.attachStepMask(workerData.stepMask);
  o.objects=new Map(o.objects.map(p=>[p.id,p]));
  if(workerData.task==='cut'){
    const point=p=>({x:protocolToClient(p.x),y:protocolToClient(p.y)});
    const cost=threatEdgeCost((o.threats??[]).map(point),{radius:(o.threatRadius??8)*1024,weight:o.threatWeight??12,spacing:128,cacheSize:65536});
    const scopedObjects=Number.isFinite(o.bodyRangeSquares)?new Map([...o.objects].filter(([,p])=>
      Math.hypot(p.x-workerData.from.x,p.y-workerData.from.y)<=o.bodyRangeSquares*64)):o.objects;
    const obstacles=blockingBodySnapshot(scopedObjects,o.selfId);
    const allowed=b=>!o.avoidSquares?.has?.(Math.floor(clientToProtocol(b.y)/64)+','+Math.floor(clientToProtocol(b.x)/64));
    const edge=(a,b)=>{if(!allowed(b))return false;const t=geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false,obstacles,
      roomFlags:o.roomFlags??0,overrideDepths:o.overrideDepths});return t?.arrived===true&&t.blocked!==true;};
    const settings={
      bounds:{w:geo.cols*1024,h:geo.rows*1024},lattice:128,cost:o.threats?.length?cost:null,maxMs:o.maxMs??4000,
      floorAt:(x,y)=>{const l=geo.leafAtClient(x,y);return l?.sector?geo.floorBaseAtClient(x,y,l):null;}};
    const geometryEdge=(a,b)=>{if(!allowed(b))return false;const t=geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false,
      roomFlags:o.roomFlags??0,overrideDepths:o.overrideDepths});return t?.arrived===true&&t.blocked!==true;};
    const baked=findFineGuide(geo,point(workerData.from),point(workerData.goal),{edge:geometryEdge});
    const clearBaked=baked&&baked.waypoints.slice(1).every((p,i)=>edge(baked.waypoints[i],p));
    let cut=clearBaked?baked:cutRail(point(workerData.from),point(workerData.goal),{...settings,edge});
    let waitingRefuge=null;
    if((!cut.ok||!cut.bridgeOk)&&obstacles.length&&o.allowBodyPrefix===true){
      const geometryEdge=(a,b)=>{if(!allowed(b))return false;const t=geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false,
        roomFlags:o.roomFlags??0,overrideDepths:o.overrideDepths});return t?.arrived===true&&t.blocked!==true;};
      const guide=baked??cutRail(point(workerData.from),point(workerData.goal),{...settings,edge:geometryEdge});
      if(guide.ok&&guide.bridgeOk){
        // A full geometry route blocked by this scene is traffic evidence.
        // The body may wait only at an existing proved refuge; this result
        // authorizes no movement and does not pretend to reach the goal.
        const held=legWalls(geo).find(w=>w.row===workerData.from.row&&w.col===workerData.from.col);
        if(held)waitingRefuge={row:held.row,col:held.col};
        const prefix=[guide.waypoints[0]];let previous=prefix[0],distance=0;
        for(const p of guide.waypoints.slice(1)){
          if(!edge(previous,p))break;
          distance+=Math.hypot(p.x-previous.x,p.y-previous.y);prefix.push(p);previous=p;
          if(distance>=(o.prefixSquares??4)*1024)break;
        }
        let waypoints=prefix,refuge=null;
        if(o.requirePrefixRefuge===true){
          const walls=legWalls(geo),from=workerData.from,limit=(o.prefixSquares??4),started=performance.now();
          waypoints=null;
          for(let i=prefix.length-1;i>=0&&!waypoints;i-=4){
            if(performance.now()-started>1000)break;
            const p={x:clientToProtocol(prefix[i].x),y:clientToProtocol(prefix[i].y)};
            const used=prefix.slice(1,i+1).reduce((n,q,j)=>n+Math.hypot(q.x-prefix[j].x,q.y-prefix[j].y)/1024,0);
            const near=walls.filter(w=>(w.row!==from.row||w.col!==from.col)&&!o.excludedPrefixStops?.has?.(w.row+','+w.col)
              &&Math.hypot(w.row-Math.floor(p.y/64),w.col-Math.floor(p.x/64))<=2)
              .sort((a,b)=>Math.hypot(a.row-workerData.goal.y/64,a.col-workerData.goal.x/64)-Math.hypot(b.row-workerData.goal.y/64,b.col-workerData.goal.x/64));
            for(const w of near.slice(0,4)){
              const side=planBodyDetour(geo,p,geo.standPointWire(w.row,w.col),{objects:scopedObjects,selfId:o.selfId,
                avoidSquares:o.avoidSquares,
                roomFlags:o.roomFlags??0,overrideDepths:o.overrideDepths,goalSquare:w,marginSquares:2,maxRangeSquares:8,
                maxNodes:768,maxMs:35,threats:o.threats??[],threatWeight:o.threatWeight??12,threatRadius:o.threatRadius??8});
              if(!side.found)continue;
              let previous=p,extra=0;for(const q of side.waypoints){extra+=Math.hypot(q.x-previous.x,q.y-previous.y)/64;previous=q;}
              if(used+extra>limit)continue;
              waypoints=[...prefix.slice(0,i+1),...side.waypoints.map(q=>{const p=point(q);return {...p,f:settings.floorAt(p.x,p.y)};})];
              refuge={row:w.row,col:w.col};break;
            }
          }
        }
        if(!waypoints&&o.requirePrefixRefuge===true){
          // A new obstruction can appear after the last proved chord. Reach
          // nearby cover, including behind the body, before waiting. Every
          // retreat still uses the same live-body and mandatory-edge proof.
          const from=workerData.from,limit=(o.prefixSquares??4)+2;
          const candidates=legWalls(geo).filter(w=>(w.row!==from.row||w.col!==from.col)
            &&!o.excludedPrefixStops?.has?.(w.row+','+w.col)&&Math.hypot(w.row-from.row,w.col-from.col)<=limit)
            .sort((a,b)=>Math.hypot(a.row-from.row,a.col-from.col)-Math.hypot(b.row-from.row,b.col-from.col));
          for(const w of candidates.slice(0,16)){
            const side=planBodyDetour(geo,from,geo.standPointWire(w.row,w.col),{objects:scopedObjects,selfId:o.selfId,
              avoidSquares:o.avoidSquares,roomFlags:o.roomFlags??0,overrideDepths:o.overrideDepths,goalSquare:w,
              marginSquares:2,maxRangeSquares:limit+2,maxNodes:2000,maxMs:60,
              threats:o.threats??[],threatWeight:o.threatWeight??12,threatRadius:o.threatRadius??8});
            if(!side.found||!side.waypoints.length)continue;
            let previous=from,distance=0;for(const q of side.waypoints){distance+=Math.hypot(q.x-previous.x,q.y-previous.y)/64;previous=q;}
            if(distance>limit||Math.floor(previous.y/64)!==w.row||Math.floor(previous.x/64)!==w.col)continue;
            const first=point(from);
            waypoints=[{...first,f:settings.floorAt(first.x,first.y)},...side.waypoints.map(q=>{const p=point(q);return {...p,f:settings.floorAt(p.x,p.y)};})];
            refuge={row:w.row,col:w.col};break;
          }
        }
        if(waypoints?.length>1)cut={...guide,waypoints,legs:waypoints.length-1,partial:true,refuge,
          blocked_route_reason:cut.why??'body route bridge unavailable'};
      }
    }
    parentPort.postMessage({...cut,body_obstacles:obstacles.length,
      ...(!cut.ok&&waitingRefuge?{traffic_blocked:true,waiting_refuge:waitingRefuge}:{}),
      ...(Number.isFinite(o.bodyRangeSquares)?{body_scope_squares:o.bodyRangeSquares}:{})});
  }else parentPort.postMessage(planFineRailRefuge(geo,workerData.from,workerData.goal,o));
}
