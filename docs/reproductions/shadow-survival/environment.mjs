import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {request,gate,out} from './driver.mjs';
const shadow=await gate(),prod=await request(8901,'/health');
const files=['tools/m59-autopilot.mjs','tools/m59-game.mjs','tools/m59-movement.mjs','tools/m59-keeper-process.mjs'];
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const prodStates=await Promise.all(Array.from({length:23},(_,i)=>request(9511+i,'/state')));
const data={at:new Date().toISOString(),production:{pid:prod.pid,root:prod.root,fleet:prod.fleet,
 commit:execFileSync('git',['-c','safe.directory=C:/code/m59-lab/prod-deploy','-C',prod.root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
 server:prod.game_server,keepers:prodStates.map(s=>({pid:s.pid,in_game:s.in_game}))},
 shadow:{pid:shadow.pid,root:shadow.root,fleet:shadow.fleet,server:shadow.game_server,
 commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()},
 files:files.map(f=>({file:f,shadow:hash(path.join(shadow.root,f)),production:hash(path.join(prod.root,f))}))};
fs.writeFileSync(path.join(out,'environment.json'),JSON.stringify(data,null,2));
console.log(JSON.stringify({productionCommit:data.production.commit,productionBroker:prod.pid,
 inGame:prodStates.filter(s=>s.in_game).length,sourceMatches:data.files.every(f=>f.shadow===f.production)}));
