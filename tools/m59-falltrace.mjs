// A bounded client-style fall: gravity advances while a low ceiling blocks XY.
// Each frame uses the ordinary BSP/object tracer; never waive a collision.
import {CLIENT_FINENESS,MAX_STEP_HEIGHT,FALL_V0,GRAVITY,RUN_SPEED} from './m59-falljump-physics.mjs';

export function traceFallMotion(geo,x0,y0,x1,y1,options={}) {
  const {dt=16,maxMs=5000,speed=RUN_SPEED,recordFrames=false,...collision}=options;
  const floor=(x,y)=>geo.floorBaseAtClient(x,y,geo.leafAtClient(x,y),collision);
  const startFloor=floor(x0,y0),frames=[];
  const no=(reason)=>({available:true,moved:false,arrived:false,blocked:true,x:x0,y:y0,reason});
  if(startFloor==null)return no('start_has_no_floor');
  if(![dt,maxMs,speed].every(Number.isFinite)||dt<1||dt>100||maxMs>5000||maxMs<dt||speed<=0||speed>RUN_SPEED)
    return no('invalid_fall_motion');
  const supplied=collision.motionZ;
  if(supplied&&Math.max(Math.abs(supplied.min-startFloor),Math.abs(supplied.max-startFloor))>1)
    return no('fall_start_unsettled');
  let at={x:x0,y:y0},z=startFloor,v=-Math.trunc(FALL_V0),elapsed=0,last=null;
  let slid=false,waited=0,blockedFrames=0;
  for(;elapsed<maxMs;){
    const ground=floor(at.x,at.y);
    if(ground==null)return no('fall_lost_floor');
    if(z>ground){z=Math.max(ground,z+Math.trunc(dt*v/1000));v-=Math.trunc(GRAVITY*dt/1000);}
    else{z=ground;v=-Math.trunc(FALL_V0);}
    const distance=Math.hypot(x1-at.x,y1-at.y),reach=Math.min(distance,speed*dt/1000);
    const aim=distance?{x:at.x+(x1-at.x)*reach/distance,y:at.y+(y1-at.y)*reach/distance}:at;
    const before=at;
    last=geo.traceFineMoveClient(at.x,at.y,aim.x,aim.y,{...collision,timedFall:false,
      fall:true,airborne:true,motionZ:{min:z,max:z},maxMicrostep:Math.max(1,CLIENT_FINENESS/40)});
    if(!last.available)return last;
    if(last.moved){at={x:last.x,y:last.y};slid ||= !!last.slid;blockedFrames=0;}
    else{waited+=dt;blockedFrames++;}
    const nextFloor=floor(at.x,at.y);
    if(nextFloor>z+MAX_STEP_HEIGHT)return no('fall_step_too_high');
    if(nextFloor>z){z=nextFloor;v=-Math.trunc(FALL_V0);}
    elapsed+=dt;
    if(recordFrames)frames.push({ms:elapsed,...at,z,floor:nextFloor,wall:last.wallIndex??null});
    if(Math.hypot(at.x-x1,at.y-y1)<1e-6&&z===nextFloor)break;
    // A grounded refusal cannot improve with more time. An airborne one can.
    if(blockedFrames>=2&&z===nextFloor)break;
    if(at.x===before.x&&at.y===before.y&&last.reason==='invalid_move_target')break;
  }
  const arrived=Math.hypot(at.x-x1,at.y-y1)<1e-6&&z===floor(at.x,at.y);
  // Timed falls are atomic proofs: never send an intermediate clipped landing.
  return {available:true,...at,moved:arrived&&Math.hypot(at.x-x0,at.y-y0)>1e-6,arrived,
    blocked:!arrived,slid,reason:arrived?null:(last?.reason??'fall_motion_incomplete'),
    motionZ:{min:z,max:z},destinationFloor:floor(at.x,at.y),
    fall_motion:{dt,elapsed_ms:elapsed,waited_ms:waited,...(recordFrames?{frames}:{})},
    ...(last?.wallIndex==null?{}:{wallIndex:last.wallIndex})};
}
