#!/usr/bin/env node
// Build from an immutable git archive, never the source checkout's working files.
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2),arg=(n,d)=>{const i=args.indexOf(n);return i>=0?args[i+1]:d;};
const source=path.resolve(arg('--source',process.env.M59_ROOT??'C:/code/Meridian59'));
const dir=path.join(root,'server-patches/scene-hold'),manifest=JSON.parse(readFileSync(path.join(dir,'manifest.json')));
const hash=b=>createHash('sha256').update(b).digest('hex');
const patchHash=hash(readFileSync(path.join(dir,manifest.patch)));
const tag=arg('--tag',`m59-scene:lab-${patchHash.slice(0,12)}`);
if(!/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_.-]+$/.test(tag))throw Error('invalid image tag');
const git=a=>execFileSync('git',['-c',`safe.directory=${source.replaceAll('\\','/')}`,'-C',source,...a],{maxBuffer:64*1024*1024});
const commit=manifest.source.commit;
for(const line of readFileSync(path.join(dir,manifest.source_hashes),'utf8').trim().split(/\r?\n/)) {
  const [want,file]=line.split(/\s+/);
  const normalized=git(['show',commit+':'+file]).toString('utf8').replaceAll('\r\n','\n');
  if(hash(normalized)!==want)throw Error(`source mismatch: ${file}`);
}
const build=path.join(root,'substrate/scene-build',patchHash.slice(0,12));mkdirSync(build,{recursive:true});
const archive=path.join(build,'source.tar'),context=path.join(build,'source');mkdirSync(context,{recursive:true});
if(!existsSync(archive))git(['archive','--format=tar','-o',archive,commit]);
execFileSync('tar',['-xf',archive,'-C',context]);
execFileSync('git',['apply','--check','--whitespace=error-all',path.join(dir,manifest.patch)],{cwd:context});
console.log(JSON.stringify({source:commit,patch_sha256:patchHash,tag,action:args.includes('--build')?'build':'check'}));
if(args.includes('--build')) {
  execFileSync('docker',['build','--progress=plain','--build-context',`m59_harness=${root}`,
    '--build-arg',`SOURCE_COMMIT=${commit}`,'--build-arg',`PATCH_SHA256=${patchHash}`,
    '-f',path.join(root,'docker/Dockerfile.scene'),'-t',tag,context],{stdio:'inherit',timeout:1800000});
  const labels=JSON.parse(execFileSync('docker',['image','inspect','--format','{{json .Config.Labels}}',tag],{encoding:'utf8'}));
  if(labels['org.openai.m59.scene-hold.patch-sha256']!==patchHash||labels['org.openai.m59.scene-hold.source-commit']!==commit)
    throw Error('built image attestation differs');
  console.log(JSON.stringify({built:true,tag,labels}));
}
