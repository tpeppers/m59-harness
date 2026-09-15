import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
const output=path.resolve(process.argv[2]??'substrate/shadow-survival-replay');
if(fs.existsSync(output))throw new Error('Choose a new output directory; refusing to overwrite evidence.');
const data=JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL('./evidence.json.gz',import.meta.url))));
for(const t of data.trials){
 const id=t.meta.id;if(!/^(matched|moderate|rate)-[a-z0-9-]+$/.test(id))throw new Error('invalid trial path');
 const dir=path.join(output,id);fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'meta.json'),JSON.stringify(t.meta));
 fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(t.result));
 fs.writeFileSync(path.join(dir,'cleanup.json'),JSON.stringify(t.cleanup));
 fs.writeFileSync(path.join(dir,'samples.jsonl'),t.samples.map(x=>JSON.stringify(x)).join('\n')+'\n');
}
console.log(JSON.stringify({trials:data.trials.length,output}));
