// Native DUM/PLAN metadata companion. No Meridian connection or game-order API.
import {readFileSync,readdirSync,statSync,writeFileSync,mkdirSync,renameSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {performance} from 'node:perf_hooks';
import {perf} from './m59-perf.mjs';
const need=(ok,s)=>{if(!ok)throw Error(s);};
const fresh=(at,now)=>Number.isSafeInteger(at)&&at<=now+1000&&now-at<=6000;
const num=s=>/^\d{1,16}$/.test(s)&&Number.isSafeInteger(Number(s))?Number(s):NaN;
const id=s=>/^[a-z0-9_-]{1,100}$/.test(s);
const clean=s=>String(s??'').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,4000);
const enc=s=>encodeURIComponent(clean(s)).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
const dec=s=>{const x=decodeURIComponent(s);need(x.length<=4096&&!/[\x00-\x1f\x7f]/.test(x),'invalid text');return x;};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const loopback=url=>{const u=new URL(url);need(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password,'loopback HTTP required');return u.origin;};
export function parseNativeContext(text,now=Date.now()) {
  need(typeof text==='string'&&Buffer.byteLength(text)<=262144&&text.endsWith('\nEND\n'),'incomplete native context');
  const rows=text.trimEnd().split('\n').map(s=>s.split('\t')),h=rows.shift();
  need(h.length===18&&h[0]==='M59CTXREQ'&&h[1]==='1'&&fresh(num(h[2]),now),'stale native context');
  const r={at:num(h[2]),pid:num(h[3]),server:dec(h[4]).toLowerCase(),account:dec(h[5]).toLowerCase(),character:dec(h[6]),
    player_id:num(h[7]),room_object:num(h[8]),room_resource_id:num(h[9]),room_security_u32:num(h[10]),
    pane:h[11],sequence:num(h[12]),token:h[13],op:h[14],strategy:h[15],field:h[16],value:dec(h[17]),binding:h.slice(3,11).join('\t'),conditions:[],stats:[],position:null};
  need(r.pid>0&&r.pid<=0x7fffffff&&r.player_id>0&&r.player_id<=0x0fffffff&&r.room_object>0&&r.room_object<=0x0fffffff&&
    r.room_resource_id>0&&r.room_resource_id<=0xffffffff&&r.room_security_u32>=0&&r.room_security_u32<=0xffffffff&&
    ['DUM','PLAN','hidden'].includes(r.pane)&&r.sequence>=0,'invalid native identity');
  need(r.op===''||(fresh(r.sequence,now)&&/^[a-f0-9]{48}$/.test(r.token)&&['toggle','setting'].includes(r.op)&&id(r.strategy)&&(!r.field||id(r.field))),'invalid or stale native command');
  need(rows.pop()?.join('\t')==='END','missing end');const seen=new Set();
  const signed=s=>/^-?\d{1,10}$/.test(s)&&Number(s)>=-2147483648&&Number(s)<=2147483647?Number(s):NaN;
  const statKeys=new Set();
  for(const f of rows){
    if(f[0]==='P'){
      const x=signed(f[1]),y=signed(f[2]),angle=num(f[3]);need(f.length===4&&!r.position&&x>=0&&y>=0&&x<1024*1023&&y<1024*1023&&angle>=0&&angle<=4095,'invalid native position');
      r.position={source:'native-client-cache',units:'client-fineness-1024',x,y,row:Math.floor(y/1024)+1,col:Math.floor(x/1024)+1,angle,observed_at:r.at};continue;
    }
    if(f[0]==='N'){
      const group=num(f[1]),ordinal=num(f[2]),name=dec(f[3]),value=signed(f[4]),min=signed(f[5]),max=signed(f[6]),current_max=signed(f[7]),observed_at=num(f[8]),key=group+':'+ordinal;
      need(f.length===9&&group>=1&&group<=4&&ordinal>=0&&ordinal<=255&&!statKeys.has(key)&&r.stats.length<256&&
        [value,min,max,current_max].every(Number.isFinite)&&observed_at>0&&observed_at<=now+1000,'invalid cached stat');
      statKeys.add(key);r.stats.push({group,ordinal,name,value,min,max,current_max,observed_at,source:'native-stat-cache'});continue;
    }
    const c={id:num(f[1]),name:dec(f[2]??''),level:num(f[3]),observed_at:num(f[4])};
    need(f.length===5&&f[0]==='C'&&c.id>0&&c.id<=0x0fffffff&&!seen.has(c.id)&&r.conditions.length<2048&&
      c.level>=0&&c.level<=4&&c.observed_at>0&&c.observed_at<=now+1000,'invalid condition observation');
    seen.add(c.id);r.conditions.push(c);}
  return r;
}
export function bindNative(r,plans,{fleet,brokerPid,now=Date.now()}) {
  need(plans.fleet===fleet&&plans.broker_pid===brokerPid&&fresh(plans.at,now),'wrong or stale Quartermaster');
  const p=plans.plans?.find(p=>p.pid===r.pid&&p.paused===true&&p.identity?.player_id===r.player_id&&
    p.identity.server?.toLowerCase()===r.server&&p.identity.account?.toLowerCase()===r.account&&p.identity.character===r.character);
  need(p&&fresh(p.at,now)&&p.room_object===r.room_object&&p.room_wire?.room_resource_id===r.room_resource_id&&
    p.room_wire.room_security_u32===r.room_security_u32,'native client is not a current claimed human');
  const conditions=r.conditions.filter(c=>p.items.some(i=>i.id===c.id&&i.name===c.name));
  return {...r,agent:p.agent,plan:p,conditions};
}
export function settingValue(field,text) {
  let value;try{value=JSON.parse(text);}catch{throw Error('value must be a number, true/false, or JSON list');}
  if(field.type==='boolean')need(typeof value==='boolean','expected true or false');
  else if(field.type==='integer'||field.type==='number')need(typeof value==='number'&&Number.isFinite(value)&&
    (field.type!=='integer'||Number.isInteger(value))&&(field.min==null||value>=field.min)&&(field.max==null||value<=field.max),'number outside setting bounds');
  else if(field.type==='number-list')need(Array.isArray(value)&&value.length<=(field.max_items??24)&&value.every(v=>Number.isInteger(v)&&
    (field.min==null||v>=field.min)&&(field.max==null||v<=field.max)),'invalid numeric list');
  else if(field.type==='item-list')need(Array.isArray(value)&&value.length<=(field.max_items??24)&&value.every(v=>typeof v==='string'&&v.trim().length>0&&v.length<=80&&!/[\x00-\x1f\x7f]/.test(v)),'invalid item list');
  else throw Error('unsupported setting type');return value;
}
export function changeFor(r,state) {
  const s=state.data.catalogue.find(s=>s.id===r.strategy);need(s,'strategy no longer available');
  const base={agents:[r.agent],expected_revision:state.data.revision,expected_pid:state.data.pid,expected_fleet:state.fleet};
  need(state.data.strategy_cas===1&&typeof base.expected_revision==='string','DUM needs the compare-and-set update before editing');
  if(r.op==='toggle'){need(['true','false'].includes(r.value),'invalid switch');return {...base,changes:{[s.id]:r.value==='true'}};}
  const field=s.settings?.find(f=>f.id===r.field);need(field,'setting no longer available');
  return {...base,settings:{[s.id]:{[field.id]:settingValue(field,r.value)}}};
}
export function nativeView(r,state,now=Date.now()) {
  const lines=[['M59CTX',1,now,r.binding,state.token,state.ack,'human',enc(state.status)].join('\t')];
  const text=s=>lines.push('T\t'+enc(s));
  text('Native context N2. Human control. Bot execution is paused during possession.');
  text('PLAN: inventory intentions and configured behavior. This is not a live DUM execution trace.');
  text('Native observation age: '+Math.max(0,now-r.at)+' ms; inventory age: '+Math.max(0,now-r.plan.at)+' ms.');
  text('DUM configuration age: '+(state.data?Math.max(0,now-state.readAt)+' ms':'unavailable')+'. Hidden tabs do not refresh DUM.');
  for(const n of r.stats)text(`${n.name}: ${n.value} / ${n.current_max} (observed ${Math.floor((now-n.observed_at)/1000)}s ago)`);
  text('Condition pips: green flawless / yellow tarnished / orange notched / red worn or broken.');
  text('Pips show the last inspection, not a durability guarantee. Hollow after 60 seconds. No pip = unknown.');
  for(const c of r.conditions)text(`${c.name}: ${['broken','heavily worn','notched','tarnished','flawless'][c.level]}, inspected ${Math.floor((now-c.observed_at)/1000)}s ago`);
  for(const i of r.plan.items.slice(0,256)){const purpose=i.purpose||i.state;if(purpose&&purpose!=='auto')text(`${i.name} x${i.amount}: ${purpose}${i.reason?' — '+i.reason:''}`);}
  const data=state.data;
  if(data)for(const s of data.catalogue.slice(0,64)){
    need(id(s.id),'invalid catalogue');const st=data.states[s.id];if(!st)continue;
    lines.push(['S',s.id,enc(s.title),st.state==='all'?1:0,enc(s.description||s.purpose)].join('\t'));
    for(const f of (s.settings||[]).slice(0,32))if(id(f.id))lines.push(['F',s.id,f.id,enc(f.title),f.type,
      enc(JSON.stringify(st.settings?.[f.id]??f.default)),enc(f.description)].join('\t'));
  }
  const result=lines.join('\n')+'\nEND\n';need(Buffer.byteLength(result)<=262144,'native view too large');return result;
}
function read(path){const start=performance.now();need(statSync(path).size<=262144,'local report too large');const data=readFileSync(path,'utf8');perf('context.ipc.read_bytes',Buffer.byteLength(data));perf('context.ipc.read_ms',performance.now()-start);return data;}
function write(path,data){const start=performance.now();mkdirSync(dirname(path),{recursive:true});writeFileSync(path+'.tmp',data);renameSync(path+'.tmp',path);perf('context.ipc.write_bytes',Buffer.byteLength(data));perf('context.ipc.write_ms',performance.now()-start);}
export async function startClientContext({dir,fleet,brokerPid,quartermaster='http://127.0.0.1:8913',dum='http://127.0.0.1:8916',
  proxy=null,port=8918,fetcher=fetch,now=Date.now,alive=pid=>{process.kill(pid,0);},schedule=true}={}) {
  need(dir&&fleet&&Number.isSafeInteger(brokerPid)&&brokerPid>0,'explicit context directory, fleet and broker PID required');
  dir=resolve(dir);quartermaster=loopback(quartermaster);dum=loopback(dum);mkdirSync(join(dir,'native'),{recursive:true});
  if(proxy)proxy=loopback(proxy);
  const states=new Map();let stopped=false,busy=false,timer,plans=null,planRead=0,failures=0,lastError=null,demandUntil=0;
  async function get(url,options={}){const begin=performance.now();perf('context.http.requests');perf('context.http.tx_body_bytes',Buffer.byteLength(options.body||''));
    try{const response=await fetcher(url,{...options,signal:AbortSignal.timeout(3500),headers:{...options.headers,'x-m59-deadline-ms':'3500'}});
      const reader=response.body.getReader();let size=0,chunks=[];for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2097152){await reader.cancel();throw Error('context response too large');}chunks.push(value);}
      perf('context.http.rx_body_bytes',size);need(response.ok,'context endpoint refused request ('+response.status+')');return JSON.parse(Buffer.concat(chunks).toString());
    }finally{perf('context.http.elapsed_ms',performance.now()-begin);}}
  async function tick(){if(busy||stopped)return;busy=true;const start=performance.now(),at=now();
    try{
      const reports=[];for(const f of readdirSync(join(dir,'native')).filter(f=>/^\d+\.tsv$/.test(f)).slice(0,1000))try{
        const r=parseNativeContext(read(join(dir,'native',f)),at);need(f===r.pid+'.tsv','PID filename mismatch');alive(r.pid);if(reports.length<40)reports.push(r);
      }catch{perf('context.native.ignored');}
      if(!reports.length){states.clear();return;} // No clients = no HTTP polling.
      if(!plans||at-planRead>=2000){plans=await get(quartermaster+'/plans');planRead=at;}
      const live=new Set();
      for(const report of reports)try{
        const r=bindNative(report,plans,{fleet,brokerPid,now:now()});live.add(r.pid);
        let state=states.get(r.pid);if(!state||state.binding!==r.binding){state={binding:r.binding,token:randomBytes(24).toString('hex'),ack:0,data:null,readAt:0,fleet,status:'Connecting to DUM...',last:r};states.set(r.pid,state);}
        state.last=r;
        // Supplemental mirror: only the exact server/player/ROOM_WIRE connection.
        // Never present a guessed or incomplete proxy domain as authoritative.
        if(proxy&&(r.pane!=='hidden'||now()<demandUntil)){
          state.proxy=null;
          try{const observation=await get(proxy+'/v1/observations?player_id='+r.player_id);
            need(observation.schema==='m59-proxy-context/1'&&observation.observe===true&&
              (observation.server.host+':'+observation.server.port).toLowerCase()===r.server&&fresh(observation.at,now()),'wrong proxy');
            const matches=observation.sessions.filter(s=>s.connection_current&&s.player?.id===r.player_id&&s.player.roomId===r.room_object&&
              s.player.roomRsc===r.room_resource_id&&s.player.security===r.room_security_u32);
            need(matches.length===1,'no unique current proxy connection');state.proxy=matches[0];
          }catch{perf('context.proxy.unavailable');}
        }
        if(r.op&&r.sequence>state.ack){
          state.ack=r.sequence; // A timeout must NEVER replay a mutation.
          try{
            need(!state.dataStale&&r.token===state.token&&fresh(r.at,now())&&now()-state.readAt<=6000,'stale native click');
            // Re-attest the human immediately before a policy write (cached read, no game request).
            const current=await get(quartermaster+'/plans');bindNative(r,current,{fleet,brokerPid,now:now()});
            const body=changeFor(r,state);await get(dum+'/strategies',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
            state.status='Saved. Configuration applies when bot control resumes.';state.dataStale=true;state.lastAttempt=0;perf('context.command.saved');
          }catch(e){state.status=clean(e.message)+'; no automatic retry.';perf('context.command.refused');}
          state.token=randomBytes(24).toString('hex');
        }
        if(r.pane!=='hidden'&&now()-(state.lastAttempt||0)>=5000){
          state.lastAttempt=now();
          try{const health=await get(dum+'/health');need(health.ok&&health.fleet===fleet,'DUM fleet mismatch');
            const data=await get(dum+'/strategies?agents='+encodeURIComponent(r.agent));
            need(data.selected===1&&Array.isArray(data.catalogue)&&data.catalogue.length<=64&&data.states,'invalid DUM catalogue');
            if(data.strategy_cas===1)need(data.fleet===fleet&&data.pid===health.pid,'DUM identity changed');
            if(hash(state.data)!==hash(data))state.token=randomBytes(24).toString('hex');state.data=data;state.readAt=now();state.dataStale=false;
            if(data.strategy_cas!==1)state.status='Read-only: DUM needs the native compare-and-set update.';
            else if(state.status==='Connecting to DUM...'||state.status.startsWith('Cached DUM'))state.status='Ready. Click behavior to configure; right-click for settings.';
          }catch(e){state.dataStale=true;state.status='Cached DUM configuration; changes paused. '+clean(e.message);state.token=randomBytes(24).toString('hex');}
        }
        write(join(dir,'views',r.pid+'.tsv'),nativeView(r,state,now()));
      }catch{perf('context.native.unbound');states.delete(report.pid);}
      for(const pid of states.keys())if(!live.has(pid))states.delete(pid);
      failures=0;lastError=null;
    }catch(e){states.clear();plans=null;failures++;lastError=clean(e.message);perf('context.tick.error');}
    finally{busy=false;perf('context.tick.elapsed_ms',performance.now()-start);}
  }
  const server=createServer((req,res)=>{
    const reply=(code,data)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
    if(req.headers.origin||req.socket.remoteAddress!=='127.0.0.1'){req.resume();reply(403,{error:'loopback only'});return;}
    if(req.method!=='GET'){req.resume();reply(405,{error:'read-only context surface'});return;}
    if(req.url==='/health'){reply(200,{kind:'native-client-context',schema:1,pid:process.pid,fleet,broker_pid:brokerPid,clients:states.size,error:lastError,failures});return;}
    if(req.url==='/v1/clients'){demandUntil=now()+6000;reply(200,{schema:'m59-native-context/1',fleet,broker_pid:brokerPid,at:now(),clients:[...states.values()].filter(s=>fresh(s.last.at,now())).map(s=>({
      agent:s.last.agent,pid:s.last.pid,player_id:s.last.player_id,character:s.last.character,at:s.last.at,control:'human',
      room_object:s.last.room_object,room_wire:{room_resource_id:s.last.room_resource_id,room_security_u32:s.last.room_security_u32},
      conditions:s.last.conditions.map(c=>({...c,source:'native-look-cache',stale:now()-c.observed_at>60000})),
      position:s.last.position,stats:s.last.stats,
      inventory:s.last.plan.items,inventory_at:s.last.plan.at,
      proxy:s.proxy&&fresh(s.proxy.observed_at,now())?s.proxy:null,
      dum_configured:s.data?.states??null,dum_at:s.readAt,status:s.status}))});return;}
    reply(404,{error:'not found'});
  });
  server.maxConnections=16;server.requestTimeout=5000;server.headersTimeout=5000;
  await new Promise((yes,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',yes);});
  const arm=()=>{if(!stopped&&schedule){timer=setTimeout(async()=>{await tick();arm();},Math.min(30000,1000*2**Math.min(failures,5)));timer.unref();}};
  await tick();arm();return {server,tick,close(){stopped=true;clearTimeout(timer);server.closeAllConnections();server.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
  for(const key of ['--dir','--fleet','--broker-pid'])need(args.includes(key),'required '+key);
  await startClientContext({dir:arg('--dir'),fleet:arg('--fleet'),brokerPid:Number(arg('--broker-pid')),
    ...(args.includes('--port')?{port:Number(arg('--port'))}:{}),...(args.includes('--dum')?{dum:arg('--dum')}:{ }),
    ...(args.includes('--proxy')?{proxy:arg('--proxy')}:{})});
}
