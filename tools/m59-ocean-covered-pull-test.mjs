import './m59-test-ledger.mjs';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fight } from './m59-skills.mjs';
import { Session } from './m59-game.mjs';
import { chooseSurvivalDecision } from './m59-survival-decision.mjs';
import { OF } from './m59-parse.mjs';
import { Autopilot } from './m59-autopilot.mjs';

const source = readFileSync(new URL('./autopilot/pass-farm.mjs', import.meta.url), 'utf8');
let checks = 0;
function test(label, run) {
  run();
  console.log('ok ' + label);
  checks++;
}
function fixture(){
 const me={row:8,col:8};
 const old={id:81,nameRsc:2,row:8,col:14,flags:OF.ATTACKABLE};
 const close={id:82,nameRsc:1,row:8,col:9,flags:OF.ATTACKABLE};
 const names=new Map([[1,'mollusk creature'],[2,'frogman'],[3,'dark angel']]);
 const hp={value:121,max:121},vigor={value:165,max:200};
 const geo={collisionReady:true,security:31,rows:18,cols:18,grid:new Uint8Array(324),monsterGrid:new Uint8Array(324),
   canMove:()=>true,inBounds:(r,c)=>r>=1&&r<=18&&c>=1&&c<=18};
 const c={self:me,selfId:1,idGenerations:new Map(),room:{id:1416,security:31,objects:new Map([[81,old],[82,close]])},
   rsc:names,vitals:()=>({health:hp,vigor}),ailments:()=>[]};
 const s={world:{room:{num:552},geometry:geo},client:c,movementGeneration:2,lifeBoundary:4,damagedAt:0};
 const ap=Object.assign(Object.create(Autopilot.prototype),{
   s,mode:'farm',policy:{assignedRoom:552,molluskCoverRecovery:true},hold:{room:552,row:8,col:8,proven:true,failures:0},
   pendingPull:{target_id:81,wall:{room:552,row:8,col:8},waitUntil:12345,best_distance:6,progress_samples:4},
   oceanRangedRecoveryEnabled:()=>true,huntMatch:()=>n=>/^(frogman|mollusk creature)$/.test(n),
   cooperativeTargetAllowed:()=>true,playerThreatPresent:()=>false,facultyHeld:()=>false,busyStatus:()=>null,
   fightFloor:()=>140,armedForSure:()=>true,wallHere:()=>({ok:true}),restSpotRefused:()=>false,
   casterScene:()=>({complete:true,casters:[{...close,name:'mollusk creature'}]}),pendingPullWait:()=>({distance:6,missing:false,stalled:false})
 });
 return {ap,c,s,geo,hp,vigor,me,old,close,find:()=>ap.oceanCoveredPullAlternate([old,close])};
}
test('nearby legal quarry gets a stationary candidate while pull identity and clock are intact',()=>{
 const f=fixture(),p=f.ap.pendingPull,a=f.find();
 assert.equal(a.alternate.target.id,82);assert.equal(a.alternate.pullId,81);
 assert.equal(a.alternate.allowed(f.close),true);assert.equal(f.ap.pendingPull,p);assert.equal(p.waitUntil,12345);
});
test('absent or distant alternate leaves the original hunt path intact',()=>{
 const f=fixture();f.close.col=11;assert.equal(f.find(),null);assert.equal(f.ap.oceanCoveredPullAlternate([f.old]),null);
});
test('pull already in reach takes priority',()=>{
 const f=fixture();f.old.col=10;assert.equal(f.find(),null);
});
test('an already stalled or missing pull is returned to ordinary rotation',()=>{
 for(const flag of ['missing','stalled']){
  const f=fixture(),follow={[flag]:true};f.ap.pendingPullWait=()=>follow;
  assert.deepEqual(f.find(),{follow,alternate:null});
 }
});
test('requires full health, fight-ready vigor, proven arm, and exact validated cover',()=>{
 for(const change of [f=>f.hp.value--,f=>f.vigor.value=139,f=>f.ap.armedForSure=()=>false,
   f=>f.ap.hold.proven=false,f=>f.ap.wallHere=()=>({ok:false}),f=>f.ap.restSpotRefused=()=>true,
   f=>f.me.predicted=true,f=>f.s.damagedAt=Date.now(),f=>f.geo.security++,f=>f.geo.canMove=()=>false]){
  const f=fixture();change(f);assert.equal(f.find(),null);
 }
});
test('a caster with a rock line beyond melee vetoes the alternate',()=>{
 const f=fixture();f.ap.casterScene=()=>({complete:true,casters:[{row:8,col:13,name:'mollusk creature'}]});assert.equal(f.find(),null);
 const unknown=fixture();unknown.ap.casterScene=()=>({complete:false,casters:[]});assert.equal(unknown.find(),null);
});
test('a missing quorum, disallowed quarry, or a player ID cannot be fought',()=>{
 const f=fixture();f.ap.cooperativeTargetAllowed=()=>false;assert.equal(f.find(),null);
 const wrong=fixture();wrong.close.nameRsc=3;assert.equal(wrong.find(),null);
 const player=fixture();player.close.flags|=OF.PLAYER;assert.equal(player.find(),null);
});
test('other farm rooms, unassigned actors, partners, or off profiles keep current behavior',()=>{
 for(const change of [f=>f.s.world.room.num=546,f=>f.ap.policy.assignedRoom=546,f=>f.ap.mode='survive',
   f=>f.ap.oceanRangedRecoveryEnabled=()=>false,f=>f.ap.policy.partner='keeper',f=>f.ap.clearing='mollusk creature']){
  const f=fixture();change(f);assert.equal(f.find(),null);
 }
});
test('recovery, PvP, external orders, or an active rite veto the extra swing',()=>{
 for(const change of [f=>f.ap.recoverUntilWhole=true,f=>f.ap.wantsForwardShelter=true,
   f=>chooseSurvivalDecision(f.s,{strategy:'rest_safe'}),f=>f.ap.playerThreatPresent=()=>true,f=>f.s.combat={active:{pvp:true}},f=>f.s.job={busy:'trade'},
   f=>f.s.moveOrder={kind:'walk'},f=>f.ap.facultyHeld=()=>true,
   f=>f.s._rite={},f=>f.ap.stopping=true,f=>f.s.pacer={holdStatus:()=>({active:true})}]){
  const f=fixture();change(f);assert.equal(f.find(),null);
 }
});
test('revalidates after capture before issuing the exact stationary swing',()=>{
 for(const change of [f=>f.close.col=13,f=>f.close.nameRsc=2,f=>f.me.col++,
   f=>f.s.movementGeneration++,f=>f.s.lifeBoundary++,f=>f.old.col=10,
   f=>f.c.room.id++,f=>f.ap.policy.neverAttack=true,f=>f.ap.mode='idle',f=>f.ap.pendingPull.target_id=99,f=>f.ap.cooperativeTargetAllowed=()=>false]){
  const f=fixture(),a=f.find().alternate;change(f);assert.equal(a.allowed(f.close),false);
 }
});
test('existing fight path pins the exact candidate, holds one round, and does not retag the pull', () => {
  assert.match(source, /exactTargetId: claimedSwing,\n\s*targetAllowed: alternate\?\.allowed/);
  assert.match(source, /if \(!alternate && sameGroupTarget && this.hold/);
  assert.match(source, /holdPosition: holding, reach: PLAYER_REACH/);
  assert.match(source, /rounds: alternate \? 1 : training.rounds/);
  assert.match(source, /if \(f.out_of_reach\) \{\n\s*if \(alternate\) return HANDLED/);
  assert.match(source, /if \(!alternate\) \{\s*if \(\(f.landed_hits[\s\S]*?this.pullConverted\([\s\S]*?this.foeId/);
  assert.match(source, /coveredPull\?\.follow \?\? this.pendingPullWait/);
});

async function fightSocketless({ switchDuringEquip, stopAtPacket, kill } = {}) {
 const f=fixture(), { c,s,ap,close,me }=f;
 const alternate=f.find().alternate, oldPull=ap.pendingPull, attacks=[], walks=[], loot=[];
 c.room.objects.set(c.selfId,{...me,id:c.selfId,flags:OF.PLAYER});
 c.rsc.set(4,'axe');
 c.inventory=[{id:123,nameRsc:4}];c.using=new Set([123]);c.evSeq=0;
 c.requestInventory=()=>{ if(switchDuringEquip)ap.policy.neverAttack=true; };
 c.stats=()=>{};
 c.face=()=>{};
 c.attack=id=>{attacks.push(id);if(kill)c.room.objects.delete(id);};
 c.waitFor=async({kinds})=>({events:kinds?.includes('message')&&attacks.length
   ? [{kind:'message',seq:++c.evSeq,text:'Your axe crushes the mollusk creature.'},
      ...(kill?[{kind:'vanished',seq:++c.evSeq,id:close.id}]:[])] : []});
 s.combat={active:null};
 s.need=()=>c;
 s.faceToward=Session.prototype.faceToward;
 s.attackRounds=Session.prototype.attackRounds;
 s.pacer={submit:async(kind,send)=>{if(kind==='attack'&&stopAtPacket)ap.mode='idle';return send();}};
 s.walkTo=s.walkFine=s.walkToMeleeRange=()=>{walks.push(true);throw Error('stationary burst tried to walk');};
 s.lootFloor=async opts=>{loot.push(opts);return {taken:[]};};
 const receipt=await fight(s,{target:'mollusk creature',exactTargetId:alternate.target.id,
   targetAllowed:alternate.allowed,holdPosition:true,rounds:1,loot:true,equip:true,reach:2});
 assert.equal(s.combat.active,null);
 assert.equal(ap.pendingPull,oldPull);
 assert.deepEqual(walks,[]);
 return {attacks,receipt,loot};
}
const killReceipt=await fightSocketless({kill:true});
test('real fight and Session.attackRounds issue one exact swing and stationary loot',()=>{
 assert.deepEqual(killReceipt.attacks,[82]);assert.equal(killReceipt.receipt.killed,true);
 assert.equal(killReceipt.loot.length,1);assert.equal(killReceipt.loot[0].stayPut,true);
});
const cancelledForPolicy=await fightSocketless({switchDuringEquip:true});
const cancelledAtWire=await fightSocketless({stopAtPacket:true});
test('real fight vetoes an order change during equip or at the attack packet',()=>{
 assert.deepEqual(cancelledForPolicy.attacks,[]);assert.deepEqual(cancelledAtWire.attacks,[]);
 assert.match(cancelledForPolicy.receipt.reason,/no longer eligible/);
 assert.match(cancelledAtWire.receipt.reason,/no longer eligible/);
});
console.log(checks+' covered pull alternate checks passed');
