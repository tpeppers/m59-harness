import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {crossingAdmissionConflict} from './m59-crossing-queue.mjs';
import {configureSpotClaimStore,reserveFilePassage,confirmFilePassageEntry,releaseFilePassage} from './m59-spotclaims.mjs';
import {narrowPassages,passageEntryKey,claimPassageMove,releaseConfirmedPassage,passageQueueAdvance,passageExitNeedsConfirmation} from './m59-passage-admission.mjs';
import {setRosterSource} from './m59-party.mjs';
import {lineQueuePredecessor,queueLineGuard} from './m59-rail-traffic.mjs';
if(process.argv[2]==='worker'){
 configureSpotClaimStore({directory:process.argv[3],namespace:'generic-entrance'});
 const agent=process.argv[4];
 process.on('message',m=>process.send(m.action==='claim'?reserveFilePassage(agent,99,'pipe',{flow:m.flow,entry:m.entry,entryPending:true}):m.action==='confirm'?confirmFilePassageEntry(agent,99,'pipe'):releaseFilePassage(agent)));
}else{
 const point=(row,col,predicted=false)=>({x:col*64+32,y:row*64+32,row,col,predicted});
 const geo={rows:5,cols:9,collisionReady:true,walkable:(r,c)=>(r>=2&&r<=4&&((c>=1&&c<=3)||(c>=7&&c<=9)))||(r===3&&c>=4&&c<=6)};
 const single={rows:5,cols:5,collisionReady:true,standPointWire:(row,col)=>point(row,col),traceFineMoveClient:()=>({arrived:true,blocked:false}),walkable:(r,c)=>r>=2&&r<=4&&(c<=2||c>=4)||r===3&&c===3};
 assert(narrowPassages(single).has('3,3'),'even a one-cell-long bottleneck receives admission');
 const pocket={rows:5,cols:3,collisionReady:true,standPointWire:(row,col)=>point(row,col),traceFineMoveClient:()=>({arrived:true,blocked:false}),walkable:(r,c)=>r>=2&&r<=4&&c<=2||r===3&&c===3};
 assert(!narrowPassages(pocket).has('3,3'),'a one-ended wall pocket is not a crossing');
 const zone=narrowPassages(geo).get('3,4');
 assert.equal(passageEntryKey(geo,zone,point(3,3),point(3,4)),passageEntryKey(geo,zone,{...point(3,3),x:251},point(3,4)));
 assert.notEqual(passageEntryKey(geo,zone,point(3,3),point(3,4)),passageEntryKey(geo,zone,point(3,7),point(3,6)));
 const names=Array.from({length:25},(_,i)=>'Ordinary '+i);setRosterSource(()=>new Set([...names,'Opposing']));configureSpotClaimStore({enabled:false});
 const body=(name,id,col)=>({name,client:{host:'ordinary-test',port:9,selfId:id,me:{name},self:{id,flags:5,...point(3,col)},room:{id:999,objects:new Map()}},world:{room:{num:99},geometry:geo}});
 const convoy=names.map((name,i)=>body(name,100+i,3)),opposing=body('Opposing',200,7);
 // No explicit script, convoy object, run id or special map number is provided.
 for(let i=0;i<convoy.length;i++){
  const a=convoy[i];assert.equal(claimPassageMove(a,point(3,4)),null);
  assert(passageExitNeedsConfirmation(a,point(3,4)),'first packet needs an observed entrance');
  if(i+1<convoy.length){assert(claimPassageMove(convoy[i+1],point(3,4)),'a second entrance cannot race an unconfirmed packet');}
  a.client.self={...a.client.self,...point(3,4,true)};releaseConfirmedPassage(a);
  if(i+1<convoy.length)assert(claimPassageMove(convoy[i+1],point(3,4)),'prediction cannot release the next entrance');
  a.client.self.predicted=false;releaseConfirmedPassage(a);
  assert(claimPassageMove(opposing,point(3,6)),'a known fleetmate coming from the opposite mouth still waits');
 }
 for(const a of convoy){a.client.self={...a.client.self,...point(3,7)};assert(releaseConfirmedPassage(a));}
 assert.equal(claimPassageMove(opposing,point(3,6)),null);opposing.client.self=point(3,3);releaseConfirmedPassage(opposing);
 const openField=body(names[0],100,1);openField.client.room.objects.set(101,{id:101,name:names[1],flags:5,...point(3,2)});
 assert.equal(passageQueueAdvance(openField,point(3,8)),null,'a distant neck does not turn open-ground traffic into a strict lane');
 const twinA=body('duplicate-label',301,3),twinB=body('duplicate-label',302,7);
 assert.equal(claimPassageMove(twinA,point(3,4)),null);assert(claimPassageMove(twinB,point(3,6)),'a duplicate agent label is not the same local Session owner');twinA.client.self=point(3,7);releaseConfirmedPassage(twinA);
 // A visible incumbent without a matching claim is unknown traffic, even if a
 // roster name matches. It can always leave, but cannot be silently adopted.
 const a=body(names[0],100,3);a.client.room.objects.set(101,{id:101,name:names[1],flags:5,...point(3,5)});
 assert.equal(claimPassageMove(a,point(3,4)).objectId,101);
 // Case-folded roster membership and raw name resources both participate.
 const follower=body(names[1],101,3),leader=body(names[0],100,3);assert.equal(claimPassageMove(leader,point(3,4)),null);leader.client.self=point(3,5);releaseConfirmedPassage(leader);
 follower.client.rsc=new Map([[777,names[0].toUpperCase()]]);follower.client.room.objects.set(100,{id:100,nameRsc:777,flags:5,...point(3,5)});
 assert.equal(claimPassageMove(follower,point(3,4)),null);
 follower.client.self=point(3,7);releaseConfirmedPassage(follower);leader.client.self=point(3,7);releaseConfirmedPassage(leader);
 const me={id:1,x:320,y:224},front={id:2,flags:5,name:'friend',x:380,y:224},objects=new Map([[1,me],[2,front],[3,{id:3,flags:5,name:'other lane',x:340,y:270}]]);
 assert.equal(lineQueuePredecessor(me,{x:512,y:224},{objects,isConvoy:n=>n==='friend'}).id,2);
 assert.equal(lineQueuePredecessor(me,{x:512,y:224},{objects,isConvoy:()=>false}),null);
 assert.equal(queueLineGuard(me,{x:512,y:224},{x:350,y:224}),null);
 assert(queueLineGuard(me,{x:512,y:224},{x:350,y:228}),'a paced sideways slide is refused');
 assert.equal(queueLineGuard(me,{x:512,y:224},{x:350,y:228}).traffic,'convoy_queue','native callers must retain the queue after a refused paced slide');
 assert(queueLineGuard(me,{x:512,y:224},{x:310,y:224}),'never back up into the follower');
 assert(crossingAdmissionConflict({agent:'a',flow:'east',entry:'left',entryPending:false},{agent:'b',flow:'east',entry:'right'}));
 // Run real Session movement and native collision in a non-Brax map: the
 // one-square Western border of the Twisted Wood (587), no named route script.
 {
  const {bastionHarness}=await import('./fixtures/bastion-fallback-client.mjs'),h=await bastionHarness(),{withBodyCommand}=await h.imp('m59-body-command.mjs');
  setRosterSource(()=>new Set(['Walker','Front']));
  const front={id:2,flags:5,name:'Front',x:2976,y:1888,row:29,col:46};
  const f=h.fixture({from:{room:587,x:2912,y:1888},bodies:[front]},{bodies:true,wireNames:true,maxPackets:50,maxMs:15000});f.c.me={name:'Walker'};f.s.name='Walker';
  const first=await withBodyCommand(f.s,()=>f.s.walkFine(3104,1888,{exactArrival:true,bodyDetour:true,maxSteps:20}),'ordinary-narrow-queue');
  assert(!first.arrived);assert.equal(first.traffic,'convoy_queue');assert.equal(first.reason,'object_blocked');assert(f.packets.length>0);
  assert(f.packets.every(p=>p.y===1888&&p.x<=front.x-32),'native fine walk takes only the straight available prefix');
  const before=f.packets.length;
  const blocked=await withBodyCommand(f.s,()=>f.s.step(46,29),'ordinary-square-queue');assert.equal(blocked.traffic,'convoy_queue');assert.equal(f.packets.length,before,'square walker never threads around its predecessor');
  f.c.room.objects.delete(2);
  const finished=await withBodyCommand(f.s,()=>f.s.walkFine(3104,1888,{exactArrival:true,bodyDetour:true,maxSteps:20}),'ordinary-queue-clear');assert(finished.arrived,JSON.stringify(finished));
  console.log('PASS actual Session fine and square walks queue on the room587 line and continue when the body clears');
 }
 // Shared file store: two independent keeper processes race the same entrance.
 const dir=mkdtempSync(join(tmpdir(),'m59-generic-convoy-'));
 configureSpotClaimStore({directory:dir,namespace:'different-zone-proof'});setRosterSource(()=>new Set(names));
 const wrong=body(names[1],101,3),entry=passageEntryKey(geo,zone,point(3,3),point(3,4));
 reserveFilePassage('elsewhere',99,'different-zone',{flow:'fleet-entry:'+entry,entry,character:names[0]});
 wrong.client.room.objects.set(100,{id:100,name:names[0],flags:5,...point(3,5)});
 assert.equal(claimPassageMove(wrong,point(3,4)).objectId,100,'a matching name/flow from another zone is not entrance evidence');
 releaseFilePassage('elsewhere');configureSpotClaimStore({enabled:false});
 const workers=['a','b'].map(name=>fork(fileURLToPath(import.meta.url),['worker',dir,name],{stdio:['ignore','ignore','inherit','ipc']}));
 const ask=(p,m)=>new Promise((resolve,reject)=>{const done=v=>{p.off('error',fail);resolve(v);},fail=e=>{p.off('message',done);reject(e);};p.once('message',done);p.once('error',fail);p.send(m);});
 try{
  const m={action:'claim',flow:'east',entry:'left'},answers=await Promise.all(workers.map(w=>ask(w,m)));assert.equal(answers.filter(x=>x.ok).length,1);
  const win=answers.findIndex(x=>x.ok),lose=1-win;
  configureSpotClaimStore({directory:dir,namespace:'generic-entrance'});
  assert.equal(reserveFilePassage(['a','b'][win],99,'pipe',{flow:'east',entry:'left'}).reason,'passage_owner_process_changed','an identically named owner in another process cannot adopt a live ticket');
  configureSpotClaimStore({enabled:false});assert(!(await ask(workers[lose],m)).ok);assert(await ask(workers[win],{action:'confirm'}));assert((await ask(workers[lose],m)).ok);
  await ask(workers[lose],{action:'release'});assert(!(await ask(workers[lose],{...m,entry:'right'})).ok,'same declared flow cannot admit opposing mouths');
 }finally{await Promise.all(workers.map(w=>new Promise(resolve=>{w.once('exit',resolve);w.kill();})));rmSync(dir,{recursive:true,force:true});setRosterSource(null);}
 console.log('PASS ordinary 25-member inferred convoys, confirmed single-entry admission, opposite mouths, unknown incumbents, raw names, strict line endpoints and OS-process races');
}
