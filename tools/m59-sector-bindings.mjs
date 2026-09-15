#!/usr/bin/env node
// Bind raw ROO server tags to an existing, byte-matching collision bake.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadRoo,bindSectorServerIds,DEFAULT_ROO_DIRS} from './m59-roo.mjs';

export function bindMapSectorIds(input,{dirs,rooms=null}={}) {
  const map=structuredClone(input),bound=[],errors=[];
  for(const [num,room] of Object.entries(map.rooms)) {
    if(!room.roo?.collision||(rooms&&!rooms.includes(Number(num))))continue;
    try {
      let raw,matched=null;const attempted=[];
      for(const dir of dirs??DEFAULT_ROO_DIRS)try {
        raw=loadRoo(path.basename(room.rooFile),[dir],{strict:true});
        if(!raw)continue;
        matched=bindSectorServerIds(room.roo,raw);break;
      }catch(e){attempted.push(e.message);}
      if(!matched)throw Error('no byte-matching room resource: '+[...new Set(attempted)].join('; '));
      room.roo=matched;
      bound.push({room:Number(num),file:raw.file,sectors:raw.sectors.length,
        collision_digest:room.roo.collision.digest});
    }catch(e){errors.push({room:Number(num),error:e.message});}
  }
  return {map,bound,errors};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),arg=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
  try {
    const file=arg('--map'),out=arg('--out');
    if(!file||!out)throw Error('usage: m59-sector-bindings.mjs --map MAP.json --out NEW_MAP.json [--roo-dir DIR] [--rooms 598,599]');
    if(path.resolve(file)===path.resolve(out))throw Error('write to a separate map and review the bindings before replacing the input');
    const rooms=arg('--rooms')?.split(',').map(Number)??null;
    if(rooms?.some(n=>!Number.isInteger(n)||n<1))throw Error('invalid room selection');
    const result=bindMapSectorIds(JSON.parse(await fs.readFile(file,'utf8')),
      {dirs:arg('--roo-dir')?[path.resolve(arg('--roo-dir'))]:undefined,rooms});
    console.log(JSON.stringify({bound:result.bound,errors:result.errors}));
    if(result.errors.length||!result.bound.length)throw Error('sector bindings incomplete; no output written');
    await fs.writeFile(out,JSON.stringify(result.map));
  }catch(e){console.error(e.message);process.exitCode=1;}
}
