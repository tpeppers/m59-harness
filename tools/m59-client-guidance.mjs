// Display-only guidance for a human-owned proxy connection. No game client,
// broker tool dispatcher, socket forwarding, or gameplay actions are imported.
// The proxy integration must supply an attested, current recipient. It must
// never resolve an absent recipient to the newest or only connected client.
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {performance} from 'node:perf_hooks';
import {perf} from './m59-perf.mjs';

const need=(ok,message)=>{if(!ok)throw Error(message);};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const int=(v,min=1,max=0x7fffffff)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const text=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const exact=(v,keys)=>{need(object(v),'object required');need(Object.keys(v).every(k=>keys.includes(k)),'unsupported field');};
const opaque=v=>typeof v==='string'&&/^[0-9a-f]{32,64}$/.test(v);
const fresh=(at,now,age)=>Number.isFinite(at)&&at<=now+1000&&now-at<=age;
const targetKeys=['fleet','broker_pid','agent','character','player_id','client_pid','connection_id',
  'room_object','room_resource_id','room_security_u32','room_generation'];
export function validateTarget(t) {
  exact(t,targetKeys);
  need(text(t.fleet,64)&&/^[a-zA-Z0-9_-]+$/.test(t.fleet)&&int(t.broker_pid)&&
    typeof t.agent==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(t.agent)&&text(t.character,100)&&
    int(t.player_id,1,0x0fffffff)&&int(t.client_pid)&&opaque(t.connection_id)&&
    int(t.room_object,1,0x0fffffff)&&int(t.room_resource_id,1,0xffffffff)&&
    int(t.room_security_u32,0,0xffffffff)&&int(t.room_generation),'invalid recipient binding');
  return t;
}
const sameTarget=(a,b)=>targetKeys.every(k=>a[k]===b[k]);
function instruction(body) {
  if(body.kind==='move') {
    exact(body,['kind','row','col']);
    need(int(body.row,1,1023)&&int(body.col,1,1023),'invalid named destination');
    return {kind:'move',row:body.row,col:body.col};
  }
  if(body.kind==='item-intent') {
    exact(body,['kind','item_id','item_name','purpose','revision']);
    need(int(body.item_id,1,0x0fffffff)&&text(body.item_name,256)&&int(body.revision,0)&&
      ['sell','vault','equipment','keep','withdraw','leave'].includes(body.purpose),'invalid item intention');
    // A notification of committed planning metadata, NEVER an equip/sell action.
    return {kind:body.kind,item_id:body.item_id,item_name:body.item_name,
      purpose:body.purpose,revision:body.revision};
  }
  throw Error('unsupported suggestion');
}

export class ClientGuidance {
  constructor({resolveRecipient,now=Date.now,maxRecipients=40}={}) {
    need(typeof resolveRecipient==='function','attested recipient resolver required');
    need(int(maxRecipients,1,40),'invalid recipient limit');
    this.resolveRecipient=resolveRecipient;this.now=now;this.limit=maxRecipients;
    this.mailboxes=new Map();this.sequence=0;
  }
  recipient(target) {
    validateTarget(target);const now=this.now(),live=this.resolveRecipient({...target});
    need(object(live)&&sameTarget(live,target)&&live.control==='human'&&live.in_game===true&&
      fresh(live.observed_at,now,6000),'recipient changed or is not a current human client');
    return live;
  }
  sweep() {
    const now=this.now();
    for(const [key,box] of this.mailboxes) {
      for(const [id,m] of box.messages)if(now>=m.expires_at)box.messages.delete(id);
      if(now-box.touched>60000)this.mailboxes.delete(key);
    }
  }
  suggest(request) {
    const start=performance.now();
    try {
      exact(request,['schema','request_id','clicked_at','target','instruction']);
      need(request.schema==='m59-client-guidance/1'&&opaque(request.request_id),'invalid suggestion envelope');
      const now=this.now();need(fresh(request.clicked_at,now,6000),'expired click');
      const live=this.recipient(request.target),body=instruction(request.instruction);
      if(body.kind==='item-intent')need(live.inventory_revision===body.revision&&Array.isArray(live.items)&&
        live.items.some(i=>i.id===body.item_id&&i.name===body.item_name&&i.purpose===body.purpose),
        'item intention is not the current committed metadata');
      this.sweep();const key=request.target.connection_id;
      let box=this.mailboxes.get(key);
      if(box&&!sameTarget(box.target,request.target)){this.mailboxes.delete(key);box=null;}
      if(!box){need(this.mailboxes.size<this.limit,'guidance recipient limit');
        box={target:{...request.target},messages:new Map(),seen:new Map(),touched:now,rateAt:now,rateCount:0};
        this.mailboxes.set(key,box);}
      const fingerprint=JSON.stringify(body),old=box.seen.get(request.request_id);
      if(old){need(old.fingerprint===fingerprint,'request id reused');
        return {ok:true,duplicate:true,sequence:old.sequence,expires_at:old.expires_at,executed:false};}
      if(now-box.rateAt>=1000){box.rateAt=now;box.rateCount=0;}
      need(box.rateCount<4,'guidance rate limit');box.rateCount++;
      need(box.messages.size<16,'guidance inbox full');
      const message={sequence:++this.sequence,request_id:request.request_id,created_at:now,
        expires_at:now+30000,instruction:body,status:'pending'};
      box.messages.set(message.sequence,message);box.touched=now;
      box.seen.set(request.request_id,{fingerprint,sequence:message.sequence,expires_at:message.expires_at});
      while(box.seen.size>64)box.seen.delete(box.seen.keys().next().value);
      perf('guidance.accepted');
      return {ok:true,sequence:message.sequence,expires_at:message.expires_at,executed:false};
    } catch(e){perf('guidance.refused');throw e;}
    finally{perf('guidance.suggest_ms',performance.now()-start);}
  }
  inbox(target) {
    this.recipient(target);this.sweep();const box=this.mailboxes.get(target.connection_id);
    return {schema:'m59-client-guidance/1',target:{...target},observed_at:this.now(),
      messages:box&&sameTarget(box.target,target)?structuredClone([...box.messages.values()]):[]};
  }
  feedback(request) {
    exact(request,['target','sequence','status']);this.recipient(request.target);
    need(int(request.sequence)&&['seen','dismissed'].includes(request.status),'invalid display feedback');
    this.sweep();const box=this.mailboxes.get(request.target.connection_id);
    need(box&&sameTarget(box.target,request.target),'recipient changed');
    const message=box.messages.get(request.sequence);need(message,'suggestion expired');
    if(message.status!=='dismissed')message.status=request.status;
    perf('guidance.feedback');return {ok:true,status:message.status,executed:false};
  }
  disconnect(connectionId){this.mailboxes.delete(connectionId);}
}

// Proxy-owned LOCAL side channel. Intentionally separate from the game's TCP
// stream: none of these bytes may reach the Meridian server. Separate operator
// and native-reader capabilities prevent an inbox reader from submitting orders.
// The launch integration distributes capabilities; health never discloses them.
export async function startGuidanceServer({guidance,port=0,clientTokenFor,
  operatorToken=randomBytes(32).toString('hex')}={}) {
  need(guidance instanceof ClientGuidance&&int(port,0,65535),'invalid guidance listener');
  need(opaque(operatorToken)&&typeof clientTokenFor==='function','per-connection capabilities required');
  const authorized=(req,token)=>{const got=Buffer.from(String(req.headers['x-m59-guidance-token']||'')),want=Buffer.from(token);
    return got.length===want.length&&timingSafeEqual(got,want);};
  const server=createServer((req,res)=>{
    const reply=(code,value)=>{if(!res.destroyed&&!res.writableEnded){res.writeHead(code,
      {'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}};
    if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.origin){req.resume();return reply(403,{error:'local clients only'});}
    if(req.method==='GET'&&req.url==='/health')return reply(200,
      {kind:'client-guidance',schema:1,pid:process.pid,display_only:true,game_writes:false});
    if(req.method!=='POST'||!['/suggest','/inbox','/feedback'].includes(req.url)||
      !/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')){req.resume();return reply(404,{error:'unsupported request'});}
    if(req.url==='/suggest'&&!authorized(req,operatorToken)){req.resume();return reply(403,{error:'capability required'});}
    let size=0,chunks=[],tooLarge=false;
    req.on('data',chunk=>{size+=chunk.length;if(size>8192){if(!tooLarge)reply(413,{error:'request too large'});tooLarge=true;chunks=[];}
      else if(!tooLarge)chunks.push(chunk);});
    req.on('end',()=>{if(tooLarge)return;try {
      const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
      if(req.url!=='/suggest') {
        const target=req.url==='/inbox'?body:body?.target;
        need(object(target)&&opaque(target.connection_id),'invalid connection');
        const token=clientTokenFor(target.connection_id);
        if(!opaque(token)||token===operatorToken||!authorized(req,token))return reply(403,{error:'connection capability required'});
      }
      const result=req.url==='/suggest'?guidance.suggest(body):req.url==='/inbox'?guidance.inbox(body):guidance.feedback(body);
      reply(200,result);
    }catch{reply(409,{error:'guidance refused; refresh recipient and retry'});}});
    req.on('error',()=>{});
  });
  server.requestTimeout=5000;server.headersTimeout=5000;server.maxConnections=16;
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',done);});
  return {server,port:server.address().port,operatorToken,
    close:()=>{server.closeAllConnections();server.close();}};
}
