import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {proxyContext,serveProxyContext} from './m59-proxy-context.mjs';
const context=proxyContext({host:'127.0.0.1',port:15959,listen:15960,maxSessions:1});
const session=new EventEmitter();session.observe=true;session.inGame=true;
session.client={write:()=>assert.fail('native context wrote game bytes')};session.server={write:()=>assert.fail('native context wrote game bytes')};
session.inject=()=>assert.fail('native context injected');context.attach(session);
assert.throws(()=>context.attach(session));
const http=serveProxyContext(context,0);await once(http,'listening');const base='http://127.0.0.1:'+http.address().port;
try{
  let response=await fetch(base+'/v1/observations');const data=await response.json();assert.equal(data.observe,true);assert.equal(data.sessions.length,1);assert.equal(data.sessions[0].player,null);
  response=await fetch(base+'/inject',{method:'POST',body:'fake'});assert.equal(response.status,405);
  response=await fetch(base+'/v1/observations',{headers:{origin:'https://example.test'}});assert.equal(response.status,403);
  response=await fetch(base+'/v1/observations?player_id=no');assert.equal(response.status,400);
  assert.equal((await (await fetch(base+'/health')).json()).sessions,undefined);
  session.emit('closed');assert.equal(context.snapshot().sessions.length,0);
  console.log('PASS proxy-owned context: bounded sessions, read-only loopback API, no injection, disconnect cleanup');
}finally{context.close();http.closeAllConnections();await new Promise(done=>http.close(done));}
