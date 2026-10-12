import assert from 'node:assert/strict';
import {createPublicKey,verify} from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import {createBrokerListenerIdentity,identityPipeName} from './broker-listener-identity.mjs';
let active=true;let port;
const id=createBrokerListenerIdentity({identity:()=>({pid:process.pid,fleet:'fixture',root:'C:/fixture',state:'C:/fixture/prod.json',port}),active:()=>active});
const server=http.createServer((req,res)=>{if(!id.http(req,res)){res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;
try{
 await id.start();
 if(process.platform!=='win32'){assert.equal(id.available(),false);console.log('Windows identity disabled on non-Windows: PASS');}
 else {
  const pipe=await new Promise((yes,no)=>{const s=net.connect(identityPipeName(process.pid));let text='';s.on('error',no);s.on('data',b=>{text+=b;if(text.endsWith('\n')){s.destroy();yes(JSON.parse(text));}});});
  assert.equal(pipe.pid,process.pid);
  const nonce='a'.repeat(64),url=`http://127.0.0.1:${port}/identity/v1?nonce=${nonce}`;
  let r=await fetch(url);assert.equal(r.status,200);const proof=await r.json();
  const key=createPublicKey({key:Buffer.from(pipe.public_key,'base64'),format:'der',type:'spki'}),payload=Buffer.from(proof.payload,'base64');
  assert(verify(null,payload,key,Buffer.from(proof.signature,'base64')));const p=JSON.parse(payload);assert.equal(p.nonce,nonce);assert.equal(p.port,port);assert.equal(p.instance,pipe.instance);
  for(const [path,options,status] of [[url,{headers:{origin:'http://evil'}},403],[url,{headers:{origin:''}},403],[url,{headers:{host:'foreign'}},403],[url,{method:'POST'},403],
   [url+'&extra=1',{},400],[url.replace(nonce,'wrong'),{},400]]){
    const statusCode=await new Promise((yes,no)=>{const req=http.request(path,options,res=>{res.resume();res.once('end',()=>yes(res.statusCode));});req.on('error',no);req.end();});
    assert.equal(statusCode,status,JSON.stringify(options));
   }
  active=false;assert.equal((await fetch(url)).status,503);active=true;
  // A forged listener cannot sign a different socket's port.
  const old=port;port++;assert.equal((await fetch(url)).status,503);port=old;
  let limited=false;for(let n=0;n<40;n++){r=await fetch(url);if(r.status===429){limited=true;break;}}assert(limited);
  id.close();assert.equal((await fetch(url)).status,503);
  console.log('Broker listener identity: bounded public pipe, Ed25519, strict loopback HTTP/nonce, inactive/foreign-port/rate refusal and close: PASS');
 }
}finally{id.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
