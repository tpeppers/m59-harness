#!/usr/bin/env node
// Complete native world checkpoints, shared with ordinary server save-set handling.
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {captureServerSave,verifyServerSave} from './runtime/server-save-set.mjs';
const [action,source,...args]=process.argv.slice(2),arg=n=>args[args.indexOf(n)+1];
try {
  if(action==='capture') {
    if(!args.includes('--out'))throw Error('--out is required');
    const m=captureServerSave(resolve(source),resolve(arg('--out')));
    console.log(JSON.stringify({captured:true,stamp:m.stamp,files:Object.keys(m.files),privacy:m.privacy}));
  }else if(action==='verify') {
    const m=verifyServerSave(resolve(source));console.log(JSON.stringify({verified:true,stamp:m.stamp}));
  }else if(action==='restore') {
    const container=arg('--container');if(!args.includes('--container')||!/^m59-[a-z0-9-]+$/.test(container))throw Error('explicit lab container name required');
    const m=verifyServerSave(resolve(source));
    const [info]=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'}));
    if(info.State.Running)throw Error('stop the isolated lab with terminate save before restoring');
    if(info.Config.Labels?.['org.openai.m59.scene-lab']!=='true')throw Error('container is not marked as an isolated scene lab');
    for(const name of Object.keys(m.files))execFileSync('docker',['cp',join(resolve(source),name),`${container}:/m59/savegame/${name}`]);
    console.log(JSON.stringify({restored:true,stamp:m.stamp,container,started:false}));
  }else throw Error('usage: m59-scene-server-save.mjs capture SAVE_DIR --out DIR | verify DIR | restore DIR --container LAB');
}catch(e){console.error(e.message);process.exitCode=1;}
