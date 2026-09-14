import {existsSync,readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {join,basename} from 'node:path';
import {createHash} from 'node:crypto';
export const SAVE_PARTS=['gameuser','accounts','striings','dynarscs'];
export function lastSaveStamp(dir) {
  const file=join(dir,'lastsave.txt');
  return existsSync(file)?/^LASTSAVE\s+(\d+)/m.exec(readFileSync(file,'utf8'))?.[1]??null:null;
}
export function saveSetFiles(dir,stamp) {
  if(!/^\d+$/.test(String(stamp)))return [];
  return SAVE_PARTS.map(p=>join(dir,`${p}.${stamp}`)).filter(existsSync);
}
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
export function captureServerSave(source,destination,{provenance={}}={}) {
  const stamp=lastSaveStamp(source),files=saveSetFiles(source,stamp);
  if(files.length!==SAVE_PARTS.length)throw Error('native server save is missing a required part');
  const before=Object.fromEntries(files.map(f=>[basename(f),sha(f)]));
  mkdirSync(destination,{recursive:true});
  for(const f of files)copyFileSync(f,join(destination,basename(f)));
  // Write a portable control file, without host-specific commented paths.
  writeFileSync(join(destination,'lastsave.txt'),`LASTSAVE ${stamp}\n`);
  if(lastSaveStamp(source)!==stamp||files.some(f=>sha(f)!==before[basename(f)]))throw Error('server save changed during capture; retry');
  const manifest={schema:'m59-native-save/v1',stamp,captured_at:new Date().toISOString(),provenance,
    files:{...before,'lastsave.txt':sha(join(destination,'lastsave.txt'))},
    privacy:'private world/account state; never publish or commit',
    fidelity:'native world state includes hidden properties and lists; runtime RNG, sockets and client controllers still require separate evidence'};
  writeFileSync(join(destination,'manifest.json'),JSON.stringify(manifest,null,2));
  verifyServerSave(destination);return manifest;
}
export function verifyServerSave(dir) {
  const m=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));
  if(m.schema!=='m59-native-save/v1'||!/^\d+$/.test(m.stamp))throw Error('unsupported native save manifest');
  const wanted=[...SAVE_PARTS.map(p=>`${p}.${m.stamp}`),'lastsave.txt'];
  if(Object.keys(m.files).length!==wanted.length||wanted.some(f=>!m.files[f]||sha(join(dir,f))!==m.files[f]))throw Error('native save checksum or file-set mismatch');
  if(lastSaveStamp(dir)!==m.stamp)throw Error('native save control file mismatch');return m;
}
