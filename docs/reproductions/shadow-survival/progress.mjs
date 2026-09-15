import fs from 'node:fs';
import path from 'node:path';
const root=process.argv[2]??'substrate/shadow-survival-2026-09-14';
for(const id of fs.readdirSync(root).filter(x=>/^(matched|moderate|rate)-/.test(x)).sort()){
 const p=path.join(root,id);if(!fs.existsSync(path.join(p,'meta.json')))continue;
 const m=JSON.parse(fs.readFileSync(path.join(p,'meta.json')));
 if(fs.existsSync(path.join(p,'result.json'))){const r=JSON.parse(fs.readFileSync(path.join(p,'result.json')));console.log(JSON.stringify({id,outcome:r.outcome,seconds:Math.round(r.seconds),hp:r.final.hp,room:r.final.room}));continue;}
 const s=JSON.parse(fs.readFileSync(path.join(p,'samples.jsonl'),'utf8').trim().split('\n').at(-1));
 console.log(JSON.stringify({id,elapsed:Math.round((s.at-Date.parse(m.startedAt))/1000),hp:s.hp,room:s.room,activity:s.activity,last:s.recent?.at(-1),logoffs:s.tally?.logoffs}));
}
