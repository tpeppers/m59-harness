import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {configureSpotClaimStore,reserveFilePassage,releaseFilePassage} from './m59-spotclaims.mjs';
import {narrowPassages,claimPassageMove,releaseConfirmedPassage,passageExitNeedsConfirmation} from './m59-passage-admission.mjs';
import {Session} from './m59-session.mjs';
if(process.argv[2]==='worker'){
  configureSpotClaimStore({directory:process.argv[3],namespace:'trial'});
  process.on('message', command=>process.send(command==='claim'
    ? reserveFilePassage(process.argv[4],99,'pipe') : releaseFilePassage(process.argv[4])));
}else{
  const geo={rows:5,cols:9,collisionReady:true,walkable:(r,c)=>
    (r>=2&&r<=4&&((c>=1&&c<=3)||(c>=7&&c<=9)))||(r===3&&c>=4&&c<=6)};
  configureSpotClaimStore({enabled:false});
  const zones=narrowPassages(geo);
  assert.equal(zones.get('3,4'),zones.get('3,6'));
  assert(!zones.has('3,2'));
  const point=(row,col,predicted=false)=>({x:col*64+32,y:row*64+32,row,col,predicted});
  const body=(name,col)=>({name,client:{host:'lab',port:9,selfId:name,self:point(3,col),room:{id:999,objects:new Map()}},world:{room:{num:99},geometry:geo}});
  const a=body('a',3),b=body('b',7);
  assert.equal(claimPassageMove(a,point(3,4)),null);
  assert.equal(claimPassageMove(b,point(3,6)).traffic,'passage_admission');
  a.client.self=point(3,5);assert.equal(claimPassageMove(a,point(3,7)),null);
  assert(passageExitNeedsConfirmation(a,point(3,7)));
  a.client.self=point(3,7,true);assert.equal(releaseConfirmedPassage(a),false);
  assert(claimPassageMove(b,point(3,6)));
  a.client.self.predicted=false;assert(releaseConfirmedPassage(a));
  assert.equal(claimPassageMove(b,point(3,6)),null);
  b.client.self=point(3,3);assert(releaseConfirmedPassage(b));
  // A human occupant is respected even without a keeper claim.
  a.client.self=point(3,3);a.client.room.objects.set('human',{id:'human',flags:4,...point(3,5)});
  assert.equal(claimPassageMove(a,point(3,4)).objectId,'human');
  a.client.room.objects.clear();
  // Exercise the real ordinary movement send boundary, with no socket. An
  // opposing keeper must send zero packets before the incumbent clears.
  const sent=[], wire=body('wire-a',3), opposing=body('wire-b',7);
  for(const s of [wire,opposing]){
    s.need=()=>s.client;
    s.pacer={submit:async(_kind,fn)=>fn()};
    s.client.moveTo=()=>sent.push(s.name);
    s.validateFineTarget=(x,y)=>({available:true,moved:true,target:{x,y}});
    s.claimPassageMove=target=>claimPassageMove(s,target);
  }
  assert((await Session.prototype.queueValidatedMove.call(wire,288,224)).sent);
  const refused=await Session.prototype.queueValidatedMove.call(opposing,416,224);
  assert.equal(refused.sent,false);assert.equal(refused.validation.traffic,'passage_admission');
  assert.deepEqual(sent,['wire-a']);
  wire.client.self=point(3,7);assert(releaseConfirmedPassage(wire));
  assert((await Session.prototype.queueValidatedMove.call(opposing,416,224)).sent);
  opposing.client.self=point(3,3);releaseConfirmedPassage(opposing);
  // Both sides race in separate OS processes before either body is visible.
  const dir=mkdtempSync(join(tmpdir(),'m59-passage-'));
  const workers=['a','b'].map(name=>fork(fileURLToPath(import.meta.url),['worker',dir,name],{stdio:['ignore','ignore','inherit','ipc']}));
  const ask=(worker,command)=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.send(command);});
  try{
    const answers=await Promise.all(workers.map(p=>ask(p,'claim')));
    assert.equal(answers.filter(r=>r.ok).length,1);
    const winner=answers.findIndex(r=>r.ok),loser=1-winner;
    assert(!(await ask(workers[loser],'claim')).ok);
    await ask(workers[winner],'release');assert((await ask(workers[loser],'claim')).ok);
  }finally{
    await Promise.all(workers.map(p=>new Promise(resolve=>{p.once('exit',resolve);p.kill();})));
    rmSync(dir,{recursive:true,force:true});
  }
  console.log('Passage admission: geometry, opposing traffic, confirmed exits, human occupancy and cross-process race passed.');
}
