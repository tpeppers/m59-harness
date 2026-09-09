// Local-only inventory planning. This service NEVER sends a game order.
import {readFileSync,readdirSync,existsSync,writeFileSync,mkdirSync,renameSync,statSync,unlinkSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual,randomUUID} from 'node:crypto';
import {INTENT_DIR,identityOf,identityKey,itemIdentity,readIntent,setIntent,planInventory,atomicJson} from './m59-inventory-intent.mjs';
import {rosterFor} from './m59-devclient.mjs';
import {estimateItemSellValue} from './m59-item-value.mjs';
const need=(ok,why)=>{if(!ok)throw Error(why);};
const samePath=(a,b)=>resolve(a).replaceAll('\\','/').toLowerCase()===resolve(b).replaceAll('\\','/').toLowerCase();
const fresh=(at,now)=>Number.isFinite(at)&&at<=now+1000&&now-at<=6000;
export const encode=s=>encodeURIComponent(String(s)).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
const numeric=s=>/^\d{1,16}$/.test(s)&&Number.isSafeInteger(Number(s))?Number(s):NaN;
export function parseClientPack(text,now=Date.now()) {
  need(typeof text==='string'&&text.length<=262144&&text.endsWith('\nEND\n'),'incomplete client inventory');
  const lines=text.trimEnd().split('\n').map(l=>l.split('\t')),h=lines.shift();
  need(h.length===11&&h[0]==='M59PACK'&&h[1]==='1'&&fresh(numeric(h[2]),now),'stale client inventory');
  const identity=identityOf({server:decodeURIComponent(h[4]),account:decodeURIComponent(h[5]),
    character:decodeURIComponent(h[6]),player_id:numeric(h[7])});
  const pid=numeric(h[3]),room_object=numeric(h[8]),resource=numeric(h[9]),security=numeric(h[10]);
  need(pid>0&&pid<=0x7fffffff&&room_object>0&&room_object<=0x0fffffff&&resource>0&&resource<=0xffffffff&&security>=0&&security<=0xffffffff,'invalid client binding');
  const items=[],seen=new Set();need(lines.pop()?.join('\t')==='END','missing client end');
  for(const f of lines) {
    need(f.length===7&&f[0]==='I'&&items.length<2048,'invalid client item');
    const item={id:numeric(f[1]),name:decodeURIComponent(f[2]),amount:numeric(f[3]),equipped:f[4]==='1',
      name_rsc:numeric(f[5]),flags:numeric(f[6])};itemIdentity(item);
    need(!seen.has(item.id)&&item.amount>0&&item.amount<=0x7fffffff&&['0','1'].includes(f[4])&&
      item.name_rsc>0&&item.name_rsc<=0xffffffff&&item.flags>=0&&item.flags<=0xffffffff,'invalid client item fields');
    seen.add(item.id);items.push(item);
  }
  return {schema:'m59-inventory-plan/1',at:numeric(h[2]),pid,identity,room_object,
    room_wire:{room_resource_id:resource,room_security_u32:security},items,paused:true};
}
export function clientView(plan,now=Date.now()) {
  const rows=[['M59SELL',1,now,plan.pid,encode(plan.identity.account),plan.identity.player_id].join('\t')];
  for(const item of plan.items)if(['sell','keep','blocked'].includes(item.state))
    rows.push(['I',item.id,encode(item.name),item.state].join('\t'));
  return rows.join('\n')+'\nEND\n';
}
export function viewerText(plans,{fleet,broker_pid,now=Date.now()}) {
  const rows=[['M59SELLPLAN',1,encode(fleet),broker_pid,now].join('\t')];
  for(const p of plans) {
    const w=p.room_wire;if(!w?.room_resource_id||!Number.isInteger(w.room_security_u32))continue;
    rows.push(['A',encode(p.agent),p.identity.player_id,encode(p.identity.character),p.room||0,
      w.room_resource_id,w.room_security_u32,p.revision,p.paused?1:0].join('\t'));
    for(const i of p.items)rows.push(['I',encode(p.agent),i.id,encode(i.name),i.amount,i.equipped?1:0,
      encode(i.role||'other'),encode((i.actions||[]).join(',')),i.state,encode(i.source||''),encode(i.reason||'')].join('\t'));
  }
  return rows.join('\n')+'\nEND\n';
}
function writeText(path,text) {
  mkdirSync(dirname(path),{recursive:true});const temp=path+'.'+randomUUID()+'.tmp';
  try{writeFileSync(temp,text,{flag:'wx'});renameSync(temp,path);}finally{if(existsSync(temp))unlinkSync(temp);}
}
function readBounded(path,max=1048576) {need(statSync(path).size<=max,'file too large');return readFileSync(path,'utf8');}
export function checkedChange(plans,body,identity,{dir=INTENT_DIR(),now=Date.now()}={}) {
  need(body?.fleet===identity.fleet&&body.broker_pid===identity.broker_pid&&fresh(body.clicked_at,now),'stale or wrong broker');
  const plan=plans.find(p=>p.agent===body.agent&&p.identity.player_id===body.player_id&&p.identity.character===body.character);
  need(plan&&fresh(plan.at,now),'inventory is not current');
  const item=plan.items.find(i=>i.id===body.item_id&&i.name===body.item_name);need(item,'item is no longer carried');
  need(['sell','keep','auto'].includes(body.state)&&['operator','ai'].includes(body.source||'operator'),'invalid intent action');
  need(Number.isSafeInteger(body.revision)&&body.revision===plan.revision,'inventory plan changed');
  const result=setIntent(plan.identity,item,{dir,state:body.state,source:body.source||'operator',
    reason:body.reason||((body.source||'operator')==='operator'?'operator decision':'AI recommendation'),revision:body.revision});
  const effective=planInventory([item],result,{paused:plan.paused})[0];
  return {ok:true,revision:result.revision,state:effective.state,blocked:effective.state==='blocked',item:item.name};
}
export async function startService({fleet='prod',dir=INTENT_DIR(),port=8913,broker='http://127.0.0.1:8901',
                                   brokerRoot,roster=rosterFor(fleet).entries}={}) {
  need(new URL(broker).hostname==='127.0.0.1','loopback broker required');
  need(roster.length>0&&roster.length<=40,'explicit fleet required');
  const identities=new Map(roster.map(r=>[r.agent,{agent:r.agent,server:(r.host+':'+r.port).toLowerCase(),
    account:r.account.toLowerCase(),character:r.character}]));
  const token=randomBytes(32).toString('hex');let plans=[],health=null,busy=false,lastError='starting',lastTick=0;
  // DO NOT KEEP ASKING A BROKER THAT IS ALREADY STRUGGLING.
  //
  // This polled every second, flat, for ever. Each tick costs the broker a full `/health`
  // — which for a 21-character fleet enumerates every session — plus a `pilot status` RPC,
  // and both are ABORTED at 2.5s/3.5s by AbortSignal.timeout. An abort does not cancel the
  // work: the broker computes the whole answer and finds nobody listening.
  //
  // That is precisely backwards during the times it matters. m59-cnc's own launcher warns
  // that "a rejoin sweep can stall the broker for most of a minute", and prod's /health was
  // measured at 1046ms idle against 2573ms under load — so under load this timed out, threw
  // the answer away, and asked again a second later. A minute-long stall took roughly sixty
  // rounds of that, all of it work the broker did for nothing while it was least able to.
  //
  // So failure widens the gap and success closes it. The fleet is not more interesting when
  // it is unreachable, and the one thing a slow broker does not need is to be asked faster.
  const BASE_MS=1000,MAX_MS=30000;
  let failures=0,waitMs=BASE_MS;
  // Keep policy assessments through the login gap, where neither the keeper nor
  // native inventory is current. They never supply carried items or sale authority.
  const assessments=new Map();
  const identityMatches=(p,r)=>r&&p.identity.server===r.server&&p.identity.account===r.account&&p.identity.character===r.character;
  async function rpc(name,args) {
    const r=await fetch(broker+'/',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}),signal:AbortSignal.timeout(3500)});
    need(r.ok,'broker read failed');const j=await r.json();need(!j.error&&!j.result?.isError,'broker tool failed');
    return JSON.parse(j.result.content.find(c=>c.type==='text').text);
  }
  async function tick() {
    if(busy)return;busy=true;const now=Date.now();
    try {
      const response=await fetch(broker+'/health',{signal:AbortSignal.timeout(2500)});need(response.ok,'broker health failed');
      const h=await response.json();need(h.ok&&h.fleet===fleet&&(!brokerRoot||samePath(h.root,brokerRoot)),'broker identity changed');
      const pilot=await rpc('pilot',{action:'status'});need(Array.isArray(pilot.piloted),'pilot status unavailable');
      const paused=new Map(pilot.piloted.filter(p=>p.alive).map(p=>[p.agent,p]));
      for(const [agent,p] of paused) {
        const r=identities.get(agent);if(!r||r.character!==p.character)continue;
        try {
          process.kill(p.pid,0);const identity=identityOf({...r,player_id:p.object_id});
          atomicJson(join(dir,'pilots',identityKey(identity)+'.json'),{identity,pid:p.pid,expires_at:now+10000});
        }catch{}
      }
      const selected=new Map(),observed=join(dir,'observed');
      for(const file of existsSync(observed)?readdirSync(observed).filter(f=>/^bot-\d+\.json$/.test(f)).slice(0,1000):[])try {
        const p=JSON.parse(readBounded(join(observed,file))),r=identities.get(p.agent);
        const pilot=paused.get(p.agent);
        need(p.schema==='m59-inventory-plan/1'&&identityMatches(p,r)&&
          (pilot?(Number.isFinite(p.at)&&p.at<=now+1000&&now-p.at<=600000):fresh(p.at,now))&&
          (h.sessions.includes(p.agent)||pilot),'unbound report');
        need(file==='bot-'+p.pid+'.json'&&(pilot?.object_id??h.session_object_ids?.[p.agent])===p.identity.player_id&&
          (pilot?.character??h.session_characters?.[p.agent])===p.identity.character&&!p.error,'unbound bot identity');
        if(!pilot)process.kill(p.pid,0);need(Array.isArray(p.items)&&p.items.length<=2048,'invalid report');
        const seen=new Set();for(const item of p.items){itemIdentity(item);need(!seen.has(item.id)&&
          Number.isInteger(item.amount)&&item.amount>0&&item.amount<=0x7fffffff,'invalid report item');seen.add(item.id);}
        const key=identityKey(p.identity);
        if(!assessments.has(key)||assessments.get(key).at<p.at)assessments.set(key,{at:p.at,items:p.items});
        if(pilot)continue;
        p.paused=false;if(!selected.has(p.agent)||selected.get(p.agent).at<p.at)selected.set(p.agent,p);
      }catch{}
      const clients=join(dir,'clients');
      for(const file of existsSync(clients)?readdirSync(clients).filter(f=>/^\d+\.tsv$/.test(f)).slice(0,1000):[])try {
        const p=parseClientPack(readBounded(join(clients,file),262144),now);
        const match=[...identities.values()].find(r=>identityMatches(p,r)&&paused.get(r.agent)?.pid===p.pid);
        need(file===p.pid+'.tsv'&&match&&paused.get(match.agent).character===p.identity.character&&
          paused.get(match.agent).object_id===p.identity.player_id,'unclaimed client');
        process.kill(p.pid,0);p.agent=match.agent;
        // Retain exact per-object bot recommendations through possession. Do not
        // invent recommendations for new pickups while the bot is suspended.
        const old=assessments.get(identityKey(p.identity));
        p.items=p.items.map(item=>{
          const prior=old?.items.find(i=>i.id===item.id&&i.name===item.name);
          return {...prior,...item,recommended:prior?.recommended===true,blocked:prior?.blocked||null,reason:prior?.reason||'awaiting bot assessment'};
        });
        atomicJson(join(dir,'pilots',identityKey(p.identity)+'.json'),{identity:p.identity,pid:p.pid,expires_at:now+10000});
        selected.set(p.agent,p);
      }catch{}
      const next=[];
      for(const p of selected.values()) {
        const doc=readIntent(p.identity,{dir});p.items=planInventory(p.items,doc,{paused:p.paused});p.revision=doc.revision;
        for(const item of p.items)try{item.value=estimateItemSellValue(item.name,{quantity:item.amount}).sell_value;}catch{item.value=null;}
        next.push(p);if(p.paused)writeText(join(dir,'views',p.pid+'.tsv'),clientView(p,now));
      }
      plans=next;health=h;lastError=null;lastTick=now;
      writeText(join(dir,'viewer.tsv'),viewerText(plans,{fleet,broker_pid:h.pid,now}));
      failures=0;waitMs=BASE_MS;
    }catch(e){
      lastError=e.message;plans=[];
      failures++;
      // Exponential, capped, with jitter so a fleet of these cannot resynchronise into a
      // thundering herd against one broker after a restart.
      waitMs=Math.min(MAX_MS,BASE_MS*2**Math.min(failures,5));
      waitMs=Math.round(waitMs*(0.85+Math.random()*0.3));
    }finally{busy=false;}
  }
  const server=createServer((req,res)=>{
    const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    if(req.headers.origin||req.socket.remoteAddress!=='127.0.0.1'){req.resume();reply(403,{error:'local clients only'});return;}
    // `poll_ms` and `failures` are reported because a service that has quietly backed off to
    // 30s looks identical to one that is keeping up, and the difference is the whole point.
    if(req.method==='GET'&&req.url==='/health'){reply(200,{kind:'inventory-intent',schema:1,fleet,pid:process.pid,broker_pid:health?.pid,plans:plans.length,clients:plans.filter(p=>p.paused).length,at:lastTick,error:lastError,poll_ms:waitMs,failures});return;}
    if(req.method==='GET'&&req.url==='/plans'){reply(200,{fleet,broker_pid:health?.pid,at:lastTick,plans});return;}
    if(req.method!=='POST'||req.url!=='/intent'||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')){req.resume();reply(404,{error:'unsupported request'});return;}
    const supplied=Buffer.from(String(req.headers['x-m59-intent-token']||'')),expected=Buffer.from(token);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){req.resume();reply(403,{error:'intent token required'});return;}
    let body='';req.on('data',b=>{body+=b;if(body.length>8192)req.destroy();});
    req.on('end',()=>{try{
      need(!lastError&&fresh(lastTick,Date.now()),'service is not current');
      const result=checkedChange(plans,JSON.parse(body),{fleet,broker_pid:health.pid},{dir});reply(200,result);
      for(const p of plans){const doc=readIntent(p.identity,{dir});p.items=planInventory(p.items,doc,{paused:p.paused});p.revision=doc.revision;if(p.paused)writeText(join(dir,'views',p.pid+'.tsv'),clientView(p));}
      writeText(join(dir,'viewer.tsv'),viewerText(plans,{fleet,broker_pid:health.pid}));
    }catch(e){if(!res.writableEnded)reply(409,{error:e.message});}});
    req.on('error',()=>{});
  });
  server.requestTimeout=10000;server.headersTimeout=5000;
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',done);});
  atomicJson(join(dir,'service.json'),{kind:'inventory-intent',pid:process.pid,port:server.address().port,fleet,token});
  // SELF-SCHEDULING, because a fixed setInterval cannot widen. Each tick books the next one
  // at the interval the LAST result earned.
  await tick();
  let timer=null,stopped=false;
  const arm=()=>{if(stopped)return;timer=setTimeout(async()=>{await tick();arm();},waitMs);timer.unref?.();};
  arm();
  return {server,tick,pollMs:()=>waitMs,
    close:()=>{stopped=true;if(timer)clearTimeout(timer);server.closeAllConnections();server.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),get=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
  await startService({fleet:get('--fleet','prod'),dir:get('--dir',INTENT_DIR()),port:Number(get('--port',8913)),brokerRoot:get('--broker-root',undefined)});
}
