#!/usr/bin/env node
// Local metadata only. No broker/game order endpoint or character credentials.
import {readFileSync,statSync} from 'node:fs';
import {resolve,join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {INTENT_DIR} from './m59-inventory-intent.mjs';
const need=(ok,message)=>{if(!ok)throw Error(message);};
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&resolve(a).toLowerCase()===resolve(b).toLowerCase();
const read=(path,max)=>{need(isAbsolute(path)&&!/^\\\\/.test(path),'local absolute path required');
  const st=statSync(path);need(st.isFile()&&st.size>0&&st.size<=max,'invalid local file');return readFileSync(path);};
export function attestViewer(body,{sessionPath=process.env.M59_CNC_SESSION_MANIFEST}={}) {
  need(sessionPath&&samePath(sessionPath,body.session),'viewer session mismatch');
  const session=JSON.parse(read(sessionPath,1048576));
  need(session.schema==='m59-cnc-view-session/v1'&&session.mode==='live_cached_read'&&
    session.authority?.writes_enabled===false&&session.authority?.launch_policy==='observe-only','live observer session required');
  need(session.identity?.expected?.fleet===body.fleet&&session.identity.expected.broker_pid===body.broker_pid,'viewer broker mismatch');
  const dll=join(session.package.install_root,'Data','RedAlert.dll');
  const hash=createHash('sha256').update(read(dll,100*1024*1024)).digest('hex');
  need(hash===session.package.redalert_dll_sha256?.toLowerCase(),'viewer build changed');
  return session;
}
export async function sendIntent(body,{dir=INTENT_DIR(),viewer=true,sessionPath}={}) {
  if(viewer)attestViewer(body,{sessionPath});
  const service=JSON.parse(read(join(resolve(dir),'service.json'),4096));
  need(service.kind==='inventory-intent'&&service.fleet===body.fleet&&Number.isInteger(service.pid)&&
    Number.isInteger(service.port)&&service.port>0&&service.port<=65535&&/^[a-f0-9]{64}$/.test(service.token),'invalid local service');
  process.kill(service.pid,0);
  const base='http://127.0.0.1:'+service.port;
  const h=await fetch(base+'/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.json());
  need(h.kind===service.kind&&h.pid===service.pid&&h.fleet===body.fleet&&h.broker_pid===body.broker_pid&&
    !h.error&&Date.now()-h.at<=6000,'inventory service is not current');
  const response=await fetch(base+'/intent',{method:'POST',headers:{'Content-Type':'application/json',
    'X-M59-Intent-Token':service.token},body:JSON.stringify(body),signal:AbortSignal.timeout(3000)});
  const result=await response.json();need(response.ok&&result.ok,'inventory change refused');
  return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const hex=process.argv[2];
    need(typeof hex==='string'&&hex.length<=16384&&/^(?:[a-f0-9]{2})+$/i.test(hex),'bounded request required');
    const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(hex,'hex')));
    const result=await sendIntent(body);process.exitCode=result.blocked?10:0;
  }catch {process.stderr.write('Inventory change refused; refresh and retry.\n');process.exitCode=4;}
}
