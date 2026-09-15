// Publish a credential-free bundle from explicit trial fields, not the private backup.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
const input=path.resolve(process.argv[2]??'substrate/shadow-survival-2026-09-14');
const output=path.resolve(process.argv[3]??'docs/reproductions/shadow-survival/evidence.json.gz');
const trials=[];
for(const id of fs.readdirSync(input).filter(x=>/^(matched|moderate|rate)-/.test(x)).sort()){
 const dir=path.join(input,id);if(!fs.existsSync(path.join(dir,'result.json')))continue;
 const m=JSON.parse(fs.readFileSync(path.join(dir,'meta.json')));
 const before=m.before;
 trials.push({meta:{id:m.id,agent:m.agent,scenario:m.scenario,arm:m.arm,guards:m.guards,
  encounter:m.encounter,asked:m.asked,serverHpAtRelease:m.serverHpAtRelease,code:m.code,
  startedAt:m.startedAt,seconds:m.seconds,placement:m.placement,before:{character:before.character,
   pid:before.pid,hp:before.hp,vigor:before.vigor,attributes:before.attributes,equipment:before.equipment,
   items:before.items,carry:before.carry,policy:before.autopilot_status?.policy,
   tally:before.autopilot_status?.did}},
  result:JSON.parse(fs.readFileSync(path.join(dir,'result.json'))),
  cleanup:JSON.parse(fs.readFileSync(path.join(dir,'cleanup.json'))),
  samples:fs.readFileSync(path.join(dir,'samples.jsonl'),'utf8').trim().split('\n').map(JSON.parse)});
}
const data=Buffer.from(JSON.stringify({schema:1,code:'e1c26da',sampleCadenceMs:1000,trials}));
// There is no reason for credentials to occur in any of the explicitly selected fields.
if(/"(?:password|credentials|token|authorization)"\s*:/i.test(data.toString()))throw new Error('sensitive field in export');
const packed=zlib.gzipSync(data,{level:9});fs.writeFileSync(output,packed);
console.log(JSON.stringify({trials:trials.length,bytes:packed.length,sha256:crypto.createHash('sha256').update(packed).digest('hex')}));
