import{parentPort,workerData}from'node:worker_threads';
import{RoomGeometry}from'./m59-roo.mjs';
import{planQueuedRoomExit}from'./m59-queued-exit-plan.mjs';
if(parentPort&&workerData?.kind==='m59-queued-exit-planner/1')parentPort.on('message',job=>{
 try{const geometry=RoomGeometry.fromJSON(job.geometry);if(job.stepMask)geometry.attachStepMask(job.stepMask);
  const result=planQueuedRoomExit(job.state,job.to,{geometry,map:{rooms:{[job.state.room.num]:job.room}},branch:job.branch});parentPort.postMessage({id:job.id,result});
 }catch(error){parentPort.postMessage({id:job.id,result:{found:false,reason:'exit_planner_search_error',error:String(error.message).slice(0,400)}});}
});
