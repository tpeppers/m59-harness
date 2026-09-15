import fs from 'node:fs';
import path from 'node:path';
import {trial,out,sleep} from './driver.mjs';
const route=process.argv[2];
if(!['flatlands','crag'].includes(route))throw new Error('choose flatlands or crag');
const agents=route==='flatlands'?['shadow01','shadow02']:['shadow09','shadow10'];
for(const [i,agent] of agents.entries())for(const arm of i%2?['extra','control']:['control','extra']){
 const id=`moderate-${route}-${agent}-${arm}`;
 if(fs.existsSync(path.join(out,id,'cleanup.json')))continue;
 console.log(JSON.stringify({starting:id,at:new Date().toISOString()}));
 await trial(agent,route,arm,id,{hp:35,max:50,seconds:300,monsters:2});
 await sleep(3000);
}
console.log(JSON.stringify({finished:route,cohort:'moderate'}));
