// Proxy-owned READ-ONLY side channel. Never puts metadata into the game stream.
import {createServer} from 'node:http';
import {attachProxyObservation} from './m59-proxy-observation.mjs';
import {perf} from './m59-perf.mjs';
export function proxyContext({host,port,listen,now=Date.now,maxSessions=40}={}) {
  const sessions=new Map();
  return {
    attach(session){
      if(sessions.size>=maxSessions)throw Error('proxy observation capacity reached');
      const observer=attachProxyObservation(session,{now});sessions.set(session,observer);
      session.once('closed',()=>sessions.delete(session));
    },
    snapshot(playerId=null){return {schema:'m59-proxy-context/1',pid:process.pid,observe:true,
      server:{host,port},listen,at:now(),sessions:playerId===-1?[]:[...sessions.values()].map(s=>s.snapshot()).filter(s=>playerId==null||s.player?.id===playerId)};},
    close(){for(const s of sessions.values())s.close();sessions.clear();},
  };
}
export function serveProxyContext(context,port=0) {
  const server=createServer((req,res)=>{
    const reply=(code,value)=>{const body=JSON.stringify(value);if(Buffer.byteLength(body)>16*1024*1024){res.writeHead(503);res.end();return;}
      perf('proxy.context.tx_body_bytes',Buffer.byteLength(body));res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(body);};
    if(req.headers.origin||req.socket.remoteAddress!=='127.0.0.1'){req.resume();reply(403,{error:'loopback only'});return;}
    if(req.method!=='GET'){req.resume();reply(405,{error:'observation only; no injection'});return;}
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/health'){const s=context.snapshot(-1);reply(200,{...s,sessions:undefined});return;}
    if(url.pathname!=='/v1/observations'){reply(404,{error:'not found'});return;}
    const id=url.searchParams.get('player_id');if(id!==null&&!/^[1-9]\d{0,8}$/.test(id)){reply(400,{error:'invalid player ID'});return;}
    perf('proxy.context.reads');reply(200,context.snapshot(id===null?null:Number(id)));
  });
  server.maxConnections=16;server.requestTimeout=5000;server.headersTimeout=5000;
  server.listen(port,'127.0.0.1');return server;
}
