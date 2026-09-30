// Compile recharge terrain from KOD, never from room names. No admin connection.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadMap} from './m59-map.mjs';
const root=path.resolve(process.argv[2]??process.env.M59_ROOT??'C:/code/Meridian59');
const classes=new Map();
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,e.name);if(e.isDirectory())walk(file);else if(e.name.endsWith('.kod')){
    const text=fs.readFileSync(file,'utf8').replace(/%[^\r\n]*/g,'');
    const cls=/^\s*(\w+)\s+is\s+(\w+)/im.exec(text);
    if(cls)classes.set(cls[1].toLowerCase(),{parent:cls[2].toLowerCase(),
      terrain:/^\s*viTerrain_type\s*=\s*([^\r\n]+)/im.exec(text)?.[1]?.trim(),
      override:/^\s*GetTerrainType\s*\(/im.test(text),file:path.relative(root,file).replaceAll('\\','/')});
  }
}}
walk(path.join(root,'kod/object'));
function terrain(cls,seen=new Set()){
  const c=classes.get(cls?.toLowerCase());if(!c||seen.has(c))return null;seen.add(c);
  if(c.override&&cls.toLowerCase()!=='room')return null;
  return c.terrain?{expression:c.terrain,source:c.file}:terrain(c.parent,seen);
}
const rooms={};
for(const r of Object.values(loadMap().rooms)){
  const t=terrain(r.cls);
  // KA0 consumes shrine offerings on drop. Do not use any part of that room.
  if(t&&/\bTERRAIN_(FOREST|JUNGLE)\b/i.test(t.expression)&&r.cls?.toLowerCase()!=='ka0')
    rooms[r.num]={name:r.name,cls:r.cls,shalille_bonus:25,...t};
}
const out={schema:'m59-rescue-terrain/v1',source_commit:execFileSync('git',['-c','safe.directory='+root,'-C',root,'rev-parse','HEAD'],{ windowsHide: true,encoding:'utf8'}).trim(),
  rule:'Room.GetShalilleBonus > 20; forest/jungle, excluding the KA0 offering room',rooms};
fs.writeFileSync(new URL('../substrate/m59-rescue-terrain.json',import.meta.url),JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify({rooms:Object.keys(rooms).length,source_commit:out.source_commit}));
