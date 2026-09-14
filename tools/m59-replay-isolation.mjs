// A fresh engine process per trial prevents cached books and suspended old calls
// from carrying over. The parent resolves only after the worker has exited.
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export function isolatedReplayAdapter({configFile,attest}) {
  let active=null;
  const invoke=(operation,request={})=>new Promise((resolve,reject)=>{
    if(active)return reject(Error('a replay operation is already running'));
    if(request.onStarted||request.onPrepared)return reject(Error('callbacks require an explicitly in-process lab test'));
    const child=fork(fileURLToPath(new URL('./m59-replay-trial.mjs',import.meta.url)),[],{
      stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
    active=child;let result,error,tail='';
    const output=data=>{tail=(tail+String(data)).slice(-2000);};
    child.stdout.on('data',output);child.stderr.on('data',output);
    const timeout=setTimeout(()=>{error='trial process exceeded its bounded lifetime';child.kill();},(request.horizonMs??0)+120000);
    child.on('message',m=>{if(m.result!==undefined)result=m.result;if(m.error)error=m.error;});
    child.on('error',e=>{error=e.message;});
    child.on('exit',code=>{
      clearTimeout(timeout);active=null;
      if(error||code!==0||result===undefined)reject(Error(error??`trial process exited ${code}: ${tail}`));
      else resolve(result);
    });
    child.send({operation,configFile,request});
  });
  return {attest,run:request=>invoke('run',request),capture:()=>invoke('capture'),reset:()=>invoke('reset'),
    close:async()=>{
      if(!active)return;const child=active;
      await new Promise(resolve=>{child.once('exit',resolve);child.kill();});active=null;
    }};
}
