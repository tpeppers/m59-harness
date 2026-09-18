// Restore the private, attested scene container. Warm resets retain account
// definitions but reload game objects/lists/strings/timers from the same save.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {dm,rejections} from './m59-dm.mjs';
import {verifyServerSave,SAVE_PARTS} from './runtime/server-save-set.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
export function inspectSceneContainer(exec=execFileSync) {
  const [info]=JSON.parse(exec('docker',['inspect','m59-replay-lab'],{ windowsHide: true,encoding:'utf8',timeout:10000}));
  const ports=info.NetworkSettings?.Ports;
  if(!info.State?.Running||info.Config?.Labels?.['org.openai.m59.scene-lab']!=='true'||
    !ports?.['5959/tcp']?.some(p=>p.HostIp==='127.0.0.1'&&p.HostPort==='17959')||
    !ports?.['9998/tcp']?.some(p=>p.HostIp==='127.0.0.1'&&p.HostPort==='17998'))
    throw Error('isolated scene container identity/ports did not attest');
  return info;
}
export function matchesReloadCache(cache,info,manifest) {
  return cache?.schema==='m59-scene-reset-cache/v1'&&cache.container_id===info.Id&&
    cache.image_id===info.Image&&cache.started_at===info.State.StartedAt&&
    cache.stamp===manifest.stamp&&JSON.stringify(cache.files)===JSON.stringify(manifest.files);
}
export function verifyInstalledSave(output,manifest) {
  const sums=new Map(String(output).trim().split(/\r?\n/).map(line=>{
    const match=/^([a-f0-9]{64})\s+(.+)$/.exec(line);return match?[path.posix.basename(match[2]),match[1]]:[null,null];
  }));
  return SAVE_PARTS.every(part=>sums.get(part+'.'+manifest.stamp)===manifest.files[part+'.'+manifest.stamp]);
}
export async function resetNativeScene({snapshot,mode='auto',env,info=null,exec=execFileSync,dmFn=dm}={}) {
  if(!['auto','restart','reload'].includes(mode))throw Error('native_restore must be auto, restart or reload');
  if(env?.M59_ADMIN_HOST!=='127.0.0.1'||Number(env?.M59_ADMIN_PORT)!==17998)throw Error('native reset requires isolated scene maintenance port 17998');
  info??=inspectSceneContainer(exec);
  const manifest=verifyServerSave(snapshot),file=path.join(snapshot,'.reload-cache.json');
  let cached;try{cached=JSON.parse(readFileSync(file,'utf8'));}catch{}
  const start=performance.now();
  const supportsReload=info.Config.Labels['org.openai.m59.scene-reload.ack']==='v1';
  if(mode==='reload'&&!supportsReload)throw Error('native reload requires the lab image with acknowledged reload support');
  const validCache=mode!=='restart'&&supportsReload&&matchesReloadCache(cached,info,manifest);
  if(validCache) {
    // Byte verification is retained on every loop. lastsave.txt changes whenever
    // the server saves; the explicit timestamp chooses these four immutable parts.
    const output=exec('docker',['exec','m59-replay-lab','sha256sum',
      ...SAVE_PARTS.map(part=>'/m59/savegame/'+part+'.'+manifest.stamp)],{ windowsHide: true,encoding:'utf8',timeout:10000});
    if(!verifyInstalledSave(output,manifest))throw Error('installed native checkpoint checksum mismatch');
    const response=await dmFn(['reload game '+manifest.stamp],{env,timeoutMs:10000});
    if(rejections(response).length||/Cannot reload|system dead|couldn.t reload/i.test(response)||
      !/Loading game\.\.\.[\s\S]*done\./.test(response))throw Error('native world reload did not confirm completion; a connected player may still own the lab');
    return {manifest,method:'world-reload',elapsed_ms:performance.now()-start,
      account_state:'retained from the verified cold bootstrap; account administration requires restart mode'};
  }
  // A new snapshot, container start or image gets one complete restore, including
  // accounts. Never apply a cached warm-reload claim to a different server lifetime.
  await dmFn(['terminate save'],{env});
  exec('docker',['wait','m59-replay-lab'],{ windowsHide: true,timeout:20000,stdio:'pipe'});
  exec(process.execPath,[path.join(root,'tools/m59-scene-server-save.mjs'),'restore',snapshot,'--container','m59-replay-lab'],{ windowsHide: true,timeout:30000,stdio:'pipe'});
  exec('docker',['start','m59-replay-lab'],{ windowsHide: true,timeout:20000,stdio:'pipe'});
  exec('docker',['exec','--user','root','m59-replay-lab','chown','-R','blak:blak','/m59/savegame'],{ windowsHide: true,timeout:10000,stdio:'pipe'});
  let ready=false;
  for(let i=0;i<30;i++) {
    try{if((await dmFn(['show status'],{env,timeoutMs:1000})).includes('System Status')){ready=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,200));
  }
  if(!ready)throw Error('isolated server did not return after native restore');
  const fresh=inspectSceneContainer(exec);
  const cache={schema:'m59-scene-reset-cache/v1',container_id:fresh.Id,image_id:fresh.Image,
    started_at:fresh.State.StartedAt,stamp:manifest.stamp,files:manifest.files};
  writeFileSync(file+'.tmp',JSON.stringify(cache));renameSync(file+'.tmp',file);
  return {manifest,method:'container-restart',elapsed_ms:performance.now()-start,account_state:'restored'};
}
