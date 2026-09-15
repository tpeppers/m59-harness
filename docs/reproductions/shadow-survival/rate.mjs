import fs from 'node:fs';
import path from 'node:path';
import {trial,out,sleep} from './driver.mjs';
for(const [i,agent] of ['shadow01','shadow02'].entries())for(const arm of i%2?['rate','control']:['control','rate']){
 const id=`rate-flatlands-${agent}-${arm}`;
 if(fs.existsSync(path.join(out,id,'cleanup.json')))continue;
 console.log(JSON.stringify({starting:id,at:new Date().toISOString()}));
 await trial(agent,'flatlands',arm,id,{hp:50,max:50,seconds:300,monsters:2});
 await sleep(3000);
}
console.log(JSON.stringify({finished:'rate isolation'}));
