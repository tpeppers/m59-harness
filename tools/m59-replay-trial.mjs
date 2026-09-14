// Internal child entry point. Never receives credentials over IPC.
import {createShadowReplayAdapter} from './m59-shadow-replay.mjs';
process.once('message',async({operation,configFile,request})=>{
  let adapter,result,error;
  try {
    if(!['run','capture','reset'].includes(operation))throw Error('unsupported trial operation');
    adapter=await createShadowReplayAdapter({configFile,isolate:false,terminateAfterTrial:true});
    result=await adapter[operation](request);result??={ok:true};
  }catch(e){error=e.message;
  }finally{
    try{await adapter?.close();}catch(e){error??=e.message;}
    // The socket and ownership leases have been closed. Exiting also destroys any
    // old resurrection/travel continuation that did not cooperate with cancellation.
    process.send({result,error},()=>process.exit(error?1:0));
  }
});
