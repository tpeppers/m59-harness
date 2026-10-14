import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const broker=readFileSync(new URL('./m59-broker.mjs',import.meta.url),'utf8');
const block=broker.slice(broker.indexOf("name: 'rest_up'"),broker.indexOf("name: 'equip_best'"));
const first=block.indexOf('run: ')+5,last=block.lastIndexOf('\n    },');
assert(first>=5&&last>first);
const calls=[];
class KeeperProxy{async rest(options){calls.push({via:'keeper',options:{...options}});return {rested:true};}}
const keeper=new KeeperProxy(),local={name:'local'};
const run=runInNewContext('('+block.slice(first,last)+'\n    })',{
 KeeperProxy,session:name=>name==='keeper'?keeper:local,num:(value,fallback)=>value==null?fallback:Number(value),
 skills:{restUntil:async(s,options)=>{assert.equal(s,local);calls.push({via:'local',options:{...options}});return {rested:true};}}
});
await run({agent:'keeper',to:1,max_seconds:30});
await run({agent:'local',to:0.95,max_seconds:12});
await run({agent:'keeper'});
assert.deepEqual(calls,[{via:'keeper',options:{health:1,vigor:1,max_seconds:30}},
 {via:'local',options:{health:0.95,vigor:0.95,maxSeconds:12}},
 {via:'keeper',options:{health:0.9,vigor:0.9,max_seconds:120}}]);
console.log('rest_up delegates one bounded rest to the keeper and preserves the local-session path.');
