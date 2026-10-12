// Independent, read-only identity for Windows inherited TCP listeners.
// TCP's owner table may retain the original socket creator after IPC handover.
// A verifier obtains THIS process's public key over a kernel-PID-checked pipe,
// then verifies a fresh signed HTTP challenge. No history or saved key is trusted.
import net from 'node:net';
import {generateKeyPairSync,randomBytes,sign} from 'node:crypto';

export const IDENTITY_SCHEMA='m59-broker-listener-identity/1';
export const identityPipeName=pid=>`\\\\.\\pipe\\m59-broker-identity-v1-${pid}`;
const loopback=a=>a==='127.0.0.1'||a==='::1'||a==='::ffff:127.0.0.1';

export function createBrokerListenerIdentity({identity,active,platform=process.platform,now=Date.now}) {
  // The key and instance are never persisted, exported privately, or carried
  // through handover. The successor constructs its own module/process instance.
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const public_key=publicKey.export({type:'spki',format:'der'}).toString('base64');
  const instance=randomBytes(32).toString('hex');
  let server=null,starting=null,ready=false,closed=false,windowAt=0,used=0;
  const sockets=new Set();
  const available=()=>ready&&!closed&&active();
  function start() {
    if(starting)return starting;
    if(platform!=='win32'||closed)return Promise.resolve(false);
    starting=new Promise((resolve,reject)=>{
      server=net.createServer(socket=>{
        if(sockets.size>=16||!available()){socket.destroy();return;}
        sockets.add(socket);
        const deadline=setTimeout(()=>socket.destroy(),1500);deadline.unref();
        socket.once('close',()=>{sockets.delete(socket);clearTimeout(deadline);});
        socket.on('error',()=>{});
        // Fixed public response, no request parser, token, game data or file IO.
        // Keep the instance alive until the reader closes it so the reader can
        // check the kernel server PID both before and after reading the key.
        socket.write(JSON.stringify({schema:IDENTITY_SCHEMA,pid:process.pid,instance,public_key})+'\n');
      });
      server.maxConnections=16;
      server.on('error',error=>{ready=false;reject(error);});
      server.listen(identityPipeName(process.pid),()=>{ready=true;server.unref();resolve(true);});
    });
    return starting;
  }
  function http(req,res) {
    if(!/^\/identity\/v1(?:\?|$)/.test(req.url||''))return false;
    const reply=(code,value)=>{const body=JSON.stringify(value);res.writeHead(code,{
      'content-type':'application/json','cache-control':'no-store','content-length':Buffer.byteLength(body)});res.end(body);return true;};
    if(req.method!=='GET'||!loopback(req.socket?.remoteAddress)||Object.hasOwn(req.headers,'origin')||
       Object.hasOwn(req.headers,'sec-fetch-site')||req.headers.host!==`127.0.0.1:${req.socket?.localPort}`)
      return reply(403,{error:'local identity read required'});
    const match=/^\/identity\/v1\?nonce=([a-f0-9]{64})$/.exec(req.url);
    if(!match)return reply(400,{error:'invalid identity challenge'});
    if(!available())return reply(503,{error:'identity unavailable during startup or handover'});
    const at=now();if(at-windowAt>=1000){windowAt=at;used=0;}
    if(++used>32)return reply(429,{error:'identity read budget exceeded'});
    const id=identity();
    // Sign the actual serving port, not a caller-provided or saved PID-file port.
    if(!id||id.pid!==process.pid||id.port!==req.socket.localPort||!active())
      return reply(503,{error:'listener not owned by the active broker'});
    const payload=Buffer.from(JSON.stringify({schema:IDENTITY_SCHEMA,nonce:match[1],
      pid:process.pid,fleet:id.fleet,root:id.root,state:id.state,port:id.port,instance,issued_at:at}));
    return reply(200,{payload:payload.toString('base64'),signature:sign(null,payload,privateKey).toString('base64')});
  }
  function close(){closed=true;ready=false;for(const socket of sockets)socket.destroy();if(server?.listening)server.close();}
  return {start,http,close,available};
}
