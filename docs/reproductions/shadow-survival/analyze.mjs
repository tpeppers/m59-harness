// Offline: summarize completed runs; never opens a game or broker connection.
import fs from 'node:fs';
import path from 'node:path';
const input=path.resolve(process.argv[2]??'substrate/shadow-survival-2026-09-14');
const trials=[];
const prefix=process.argv[4]??'matched-';
for(const id of fs.readdirSync(input).filter(x=>x.startsWith(prefix)).sort()){
  const dir=path.join(input,id);
  if(!fs.existsSync(path.join(dir,'result.json')))continue;
  const result=JSON.parse(fs.readFileSync(path.join(dir,'result.json')));
  const meta=JSON.parse(fs.readFileSync(path.join(dir,'meta.json')));
  const samples=fs.readFileSync(path.join(dir,'samples.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const unique=new Map();
  for(const s of samples)for(const n of s.recent??[])if(n.at>=Date.parse(meta.startedAt))unique.set(`${n.at}:${n.what}`,n);
  const notes=[...unique.values()].sort((a,b)=>a.at-b.at);
  trials.push({id,agent:result.agent,route:result.scenario,arm:result.arm,
    outcome:result.outcome,seconds:result.seconds,minHp:result.minHp,finalHp:result.final.hp,
    finalRoom:result.final.room,startedAt:meta.startedAt,initialHp:{value:meta.serverHpAtRelease??meta.asked.hp,max:meta.asked.max},
    equipment:meta.before.equipment,attributes:meta.before.attributes,placement:meta.placement,
    guards:meta.guards,notes,cleanup:fs.existsSync(path.join(dir,'cleanup.json'))});
}
const counts={};
const treatment=prefix==='rate-'?'rate':'extra';
for(const arm of ['control',treatment]){
  const rows=trials.filter(t=>t.arm===arm);
  counts[arm]={n:rows.length,death:rows.filter(t=>t.outcome==='death').length,
    arrived:rows.filter(t=>t.outcome==='arrived').length,timeout:rows.filter(t=>t.outcome==='timeout').length};
}
const pairs=[];
for(const agent of [...new Set(trials.map(t=>t.agent))]){
  const c=trials.find(t=>t.agent===agent&&t.arm==='control');
  const e=trials.find(t=>t.agent===agent&&t.arm===treatment);
  if(c&&e)pairs.push({agent,route:c.route,control:c.outcome,extra:e.outcome});
}
const summary={counts,pairs,trials:trials.map(t=>({...t,notes:t.notes.filter(n=>n.what!=='frozen').map(n=>{
  const {at,what,trigger,health,why,held_s}=n;return {at,what,trigger,health,why,held_s};
})}))};
if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({counts,pairs,rows:trials.map(({notes,...t})=>({...t,noteCount:notes.length}))},null,2));
