import {performance} from 'node:perf_hooks';
export function fastReplayReads(s) {
  if(s.replayFastReads!==true)return false;
  const c=s.client;
  if(!['127.0.0.1','localhost','::1'].includes(c?.host)||Number(c?.port)!==17959)
    throw Error('response-driven replay setup reads require the isolated scene server');
  return true;
}
export async function waitForReplayRead(predicate,{timeoutMs=4000}={}) {
  const began=performance.now();
  while(!predicate()) {
    if(performance.now()-began>=timeoutMs)throw Error('timed out waiting for complete replay setup replies');
    await new Promise(r=>setTimeout(r,10));
  }
}
