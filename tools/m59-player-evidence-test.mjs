import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {OF} from './m59-parse.mjs';
import {PlayerEvidenceObserver,parsePlayerCombat,estimatePlayer,matchedDamage} from './m59-player-evidence.mjs';
import {appendEvidence,readEvidence,attachPlayerEvidence} from './m59-player-evidence-store.mjs';
import {modeledLoadout} from './m59-player-intel.mjs';
const context={server:'test:17959',room:39,observer:'Witness'};
const combat=text=>parsePlayerCombat(text,['Morpheus']);
assert.equal(combat('Morpheus maims you with his scimitar.').weapon,'scimitar');
assert.equal(combat("Morpheus’s scimitar cleaves you.").verb,'cleaves');
assert.equal(combat("You dodge Morpheus's attack.").outcome,'miss');
assert.equal(combat('Morpheus parries your attack.').defense,'parry');
assert.equal(combat('Your axe cleaves Morpheus.').direction,'outgoing');
for(const line of ['Morpheus says, "I maim you."','Morpheus slashes your side, leaving a nasty cut.',
  'The fungus beast maims you.','Morpheus avoids your attack!'])assert.equal(combat(line),null);
assert.equal(parsePlayerCombat('A+B dodges your attack.',['A+B']).character,'A+B');
function fixture() {
  const out=[],c={selfId:1,me:{name:'Witness'},self:{id:1,name:'Witness',flags:OF.PLAYER,row:8,col:8},
    room:{objects:new Map()},playersOnline:new Map(),vitals:()=>({health:{value:100,max:100}})};
  c.room.objects.set(1,c.self);c.room.objects.set(2,{id:2,name:'Morpheus',flags:OF.PLAYER,row:2,col:3,x:192,y:128});
  const o=new PlayerEvidenceObserver({emit:r=>out.push(r)}),event=(kind,data={},at=10000)=>o.event({kind,at,...data},c,context);
  event('room-contents',{},1);return {o,out,c,event};
}
{
  const {o,out,event}=fixture();event('stat',{name:'health',value:84,max:100},50000);
  event('message',{text:'Morpheus maims you with his scimitar.'},50001);o.flush(51000);
  assert.equal(matchedDamage(out[0]).lost,16,'retain baseline across a long quiet period');
  const e=estimatePlayer(out,{character:'Morpheus'});assert.equal(e.damage.hp_lost,16);assert.equal(e.offensive_skill_estimate,null);
}
{
  const {o,out,event}=fixture();event('stat',{name:'health',value:80},10000);
  event('message',{text:'Morpheus maims you with his scimitar.'},10001);
  event('message',{text:'The orc hits you.'},10010);o.flush(11000);
  assert.equal(matchedDamage(out[0]),null,'competing monster damage is not assigned to the player');
}
{
  const {o,out,c,event}=fixture();
  c.room.objects.set(90,{id:90,name:'old shield',flags:OF.GETTABLE,row:2,col:3});event('room-contents');
  event('message',{text:'### Morpheus was just killed by a rat.'});
  c.room.objects.set(91,{id:91,name:'scimitar',amount:1,rarity:200,flags:OF.GETTABLE,row:2,col:3});event('appeared',{id:91},10050);
  c.room.objects.delete(91);event('vanished',{id:91},10051);o.flush(12001,false,c);
  const drop=out[0].dropped_loadout;assert.equal(drop.items.length,1);assert.equal(drop.items[0].name,'scimitar');
  assert.equal(drop.items[0].gone_at,10051);assert.equal(drop.items[0].rarity,200);
  assert.equal(drop.complete_inventory,false);assert.equal(drop.room_snapshot.length,1);
}
{
  const {o,out,c,event}=fixture();
  c.room.objects.get(2).row=4;event('player-moved',{id:2},9999);
  c.room.objects.delete(2);event('vanished',{id:2});
  c.room.objects.set(91,{id:91,name:'ring',flags:OF.GETTABLE,row:4,col:3});event('appeared',{id:91},10001);
  event('message',{text:'### Morpheus has been murdered in cold blood.'},10002);o.flush(12003,false,c);
  assert.equal(out[0].dropped_loadout.items.length,1,'vanish, drop, announcement ordering is supported');
}
{
  const {o,out,c,event}=fixture();c.room.objects.set(3,{id:3,name:'Other',flags:OF.PLAYER,row:2,col:3});event('room-contents');
  event('message',{text:'### Morpheus was just killed by a rat.'});
  event('message',{text:'### Other was just killed by a rat.'},10001);
  c.room.objects.set(91,{id:91,name:'ring',flags:OF.GETTABLE,row:2,col:3});event('appeared',{id:91},10002);o.flush(13000,false,c);
  assert.ok(out.every(r=>r.dropped_loadout.association==='ambiguous_multiple_deaths'));
  assert.equal(out[0].dropped_loadout.items[0].candidate_characters.length,2);
}
{
  const {o,out,c,event}=fixture();event('message',{text:'### Absent was just killed by a rat.'});o.flush(13000,false,c);
  assert.equal(out.length,0,'global announcements alone do not count as witnessed deaths');
  event('said',{text:'### Morpheus was just killed by a rat.'});o.flush(13000,false,c);assert.equal(out.length,0,'chat cannot forge evidence');
  event('message',{text:'### Morpheus was just killed by a rat.'},20000);
  c.room.objects=new Map([[9,{id:9,name:'other room loot',flags:OF.GETTABLE,row:2,col:3}]]);
  o.event({kind:'room-entered',at:20100},c,{...context,room:40});
  assert.equal(out[0].dropped_loadout.room_snapshot.length,0);assert.equal(out[0].dropped_loadout.window_interrupted,true);
}
const rows=[...Array.from({length:55},(_,i)=>({type:'combat',...context,at:i,character:'Morpheus',direction:'incoming',outcome:'hit',weapon:'scimitar'})),
  ...Array.from({length:45},(_,i)=>({type:'combat',...context,at:i+55,character:'Morpheus',direction:'incoming',outcome:'miss'})),
  {type:'combat',...context,at:101,character:'Morpheus',direction:'outgoing',outcome:'miss',defense:'parry'},
  {type:'combat',...context,at:102,character:'Morpheus',direction:'outgoing',outcome:'miss',defense:'avoid'},
  {type:'operator_fact',...context,at:103,character:'Morpheus',fact:{item:'BerserkerRing'},source:'operator'}];
const e=estimatePlayer(rows,{character:'Morpheus',room:39,defense:700,aim:50,maxHp:100});
assert.equal(e.offensive_skill_estimate.ability,99,'55 percent corresponds to equal offense/defense; ring penalty is included');
assert.equal(e.defensive_skills.length,1);assert.equal(e.defensive_skills[0].ability,99);
assert.equal(estimatePlayer(rows,{character:'Morpheus',room:544}).defensive_skills[0].name,'parry','skills persist across room filters');
assert.equal(estimatePlayer(rows,{character:'Morpheus',room:544}).operator_facts.length,0,'ring scoped to room 39');
assert.equal(estimatePlayer(rows,{character:'Morpheus',defense:600,aim:50,maxHp:100}).offensive_skill_estimate.ability,50,'unscoped query does not presume the ring everywhere');
const template={schema:'m59-player-loadout/v1',complete:true,gaps:[],items:[{key:'weapon',class:'Scimitar',equipped:true,fields:{pihits:80},attributes:[]},
  {key:'ring',class:'BerserkerRing',equipped:true,fields:{pihits:80},attributes:[]}],skills:[43050],spells:[]};
assert.equal(modeledLoadout(e,template,{offense:70}).skills.includes(45370),true);
assert.equal(modeledLoadout(e,template,{offense:70}).skills.includes(40299),true);
assert.throws(()=>modeledLoadout(e,template,{}),/explicit offensive/);
assert.throws(()=>modeledLoadout({...e,room:544},template,{offense:99}),/room-scoped/);
assert.throws(()=>modeledLoadout({...e,defensive_skills:[{name:'block',id:404,ability:99}]},template,{offense:99}),/equipped shield/);
const boundary=estimatePlayer(rows.slice(0,2),{character:'Morpheus',defense:100});
assert.equal(boundary.offensive_skill_estimate.ability,null);assert.equal(boundary.offensive_skill_estimate.range[1],99);
const dir=await mkdtemp(path.join(tmpdir(),'m59-evidence-'));
try {
  await appendEvidence(rows,{dir});await appendEvidence([{...rows[0],server:'another:17959'}],{dir});
  assert.equal((await readEvidence({dir,server:context.server,character:'morpheus'})).length,rows.length);
  const {c}=fixture(),s={name:'test',client:c,credentials:{host:'test',port:17959},world:{room:{num:39}}};
  const writer=attachPlayerEvidence(s,{dir});writer.event({kind:'room-contents',at:Date.now()},c);
  writer.event({kind:'message',text:'Morpheus maims you with his scimitar.',at:Date.now()},c);
  assert.equal(await writer.flush(),true);assert.equal(writer.status().persisted,1);assert.equal(writer.status().errors,0);
  await writer.close();assert.equal(s.playerEvidence,null);
}finally{await rm(dir,{recursive:true,force:true});}
const {c,o}=fixture();for(let i=100;i<300;i++)c.room.objects.set(i,{id:i,name:'object',flags:OF.GETTABLE,row:1,col:1});
const began=performance.now();for(let i=0;i<10000;i++)o.event({kind:'stat',name:'health',value:99,at:10000+i},c,context);
console.log(JSON.stringify({passed:true,passive_events:10000,ms:performance.now()-began}));
