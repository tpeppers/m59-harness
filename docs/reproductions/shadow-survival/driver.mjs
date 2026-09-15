// Live local-shadow experiment. No production writes; all mutations verify the broker/server.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dm, resolve, roomObject, relocate, relocateCmd, healthCmds, setProp, money, packOf, give } from '../../../tools/m59-dm.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
export const out = path.join(root, 'substrate/shadow-survival-2026-09-14');
fs.mkdirSync(out, {recursive:true});
export const sleep = ms => new Promise(r=>setTimeout(r,ms));
export function request(port, url, body, ms=30000) {
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:url,method:body?'POST':'GET',agent:false,
      headers:{'content-type':'application/json',connection:'close'}},res=>{
      let data='';res.on('data',d=>data+=d);res.on('end',()=>{
        try {const v=JSON.parse(data);if(res.statusCode>=400||v.error)reject(new Error(JSON.stringify(v)));else resolve(v);}
        catch(e){reject(e);}
      });
    });
    req.setTimeout(ms,()=>req.destroy(new Error('timeout '+port+url)));
    req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
}
export async function gate() {
  const h=await request(8971,'/health');
  if(h.fleet!=='shadow-ab'||h.game_server?.host!=='127.0.0.1'||h.game_server?.port!==15959
    || !h.root.replaceAll('\\','/').toLowerCase().includes('/shadow-survival/')) throw new Error('wrong shadow endpoint');
  return h;
}
export const port = agent => 9010+Number(agent.replace('shadow',''));
export const state = agent => request(port(agent),'/state');
export async function post(agent,endpoint,body={}) {
  await gate(); const who=await request(port(agent),'/live');
  if(who.agent!==agent)throw new Error('keeper identity mismatch');
  return request(port(agent),endpoint,{...body,agent,character:who.character,keeper_pid:who.pid},120000);
}
export const act=(agent,name,args={})=>post(agent,'/action',{name,args});
export async function hold(agent) {
  const existing=await act(agent,'hold_status');
  if(existing.hold?.token)return existing.hold.token;
  await act(agent,'cancel',{why:'shadow experiment between trials'});
  for(let n=0;n<30;n++) {
    const r=await act(agent,'hold',{why:'shadow experiment staging',max_ms:900000});
    if(r.held)return r.hold.token;
    await sleep(1000);
  }
  throw new Error('could not hold '+agent);
}
export const basePolicy={mode:'idle',assignedRoom:null,hunt:null,goals:[],roam:false,
  restBelow:.7,fleeBelow:.5,panicLogoff:true,breakOutViaLogoff:true,freezeMs:90000,
  travelVigorFloor:40,vigorFloor:80,fightAboveVigor:80,decideMs:1000,idleMs:1000,
  buyFood:false,buyWeapons:false,buyReagents:false,bankAbove:1e9,walkingMoney:400,
  dropJunk:false,clearWeak:false,retreatToInn:false,partner:null,buffAllies:null,
  farmCleanup:null,farmDelivery:null,poorFarming:false,vaultItems:[],protectedItems:[],
  loadout:null,tripAnnounce:null,doomedInSpotBelow:.35,doomedInOpenBelow:.35,
  escapeLadder:false,threatCeiling:{mode:'percent',value:150},
  travelGuard:{flee:false,fight_back:false,arm:false},
};
export async function parkAll() {
  const h=await gate();
  const held=[];
  for(const agent of h.sessions){
    await post(agent,'/policy',{...basePolicy,by:'shadow survival experiment'});
    const token=await hold(agent); held.push({agent,character:h.session_characters[agent],token});
    fs.writeFileSync(path.join(out,'holds.json'),JSON.stringify(held,null,2));
  }
  await relocate(held.map(x=>x.character),52,{row:5,col:5,verify:true});
  fs.writeFileSync(path.join(out,'holds.json'),JSON.stringify(held,null,2));
  console.log(JSON.stringify({parked:held.length}));
}
export const scenarios={
  flatlands:{room:584,row:35,col:27,to:106},
  wood:{room:587,row:25,col:42,to:52},
  crag:{room:598,row:35,col:25,to:52},
};
export async function fresh(agent) {
  let previous;
  try { previous=(await state(agent)).pid; await post(agent,'/stop'); } catch(e) { if(!String(e).includes('ECONNREFUSED'))throw e; }
  for(let n=0;n<120;n++) {
    await sleep(1000);
    try {
      const s=await state(agent);
      const h=await gate();
      if(s.pid!==previous&&s.in_game&&s.hp?.value>0&&s.room?.num!==1&&h.session_characters?.[agent]===s.character){
        await sleep(3000);
        await post(agent,'/policy',{...basePolicy,by:'shadow matched trial reset'});
        await hold(agent);return s.pid;
      }
    }catch{}
  }
  throw new Error('fresh keeper did not become ready: '+agent);
}
async function normalizeGear(agent,character) {
  const ids=await resolve([character]), id=ids[character];
  const shown=await dm([`show object ${id}`]);
  const list=/plUsing\s*= LIST (\d+)/.exec(shown)?.[1];
  if(list){
    const used=await dm([`show list ${list}`]);
    const items=[...used.matchAll(/^:\s+OBJECT (\d+)/gm)].map(x=>Number(x[1]));
    if(items.length)await dm(items.map(x=>`send object ${id} UserUnuseItem what OBJECT ${x}`));
  }
  await give(id,{each:1,stacking:[],singles:['Mace']});
  const pack=await dm([`show object ${id}`]);
  const passive=/plPassive\s*= LIST (\d+)/.exec(pack)?.[1];
  const contents=await dm([`show list ${passive}`]);
  for(const m of contents.matchAll(/^:\s+OBJECT (\d+)/gm)){
    const item=await dm([`show object ${m[1]}`]);
    if(/is CLASS Mace\b/.test(item)){
      await dm([`send object ${id} UserUseItem what OBJECT ${m[1]}`]);break;
    }
  }
  await money(id,400);
  await sleep(1200);
  // Refresh only during staging: a fresh read emits inventory packets and would
  // invalidate the outcome if used during an observed frozen interval.
  const s=await request(port(agent),'/state?fresh=1');
  if(s.equipment?.length!==1||s.equipment[0]!=='mace')throw new Error('gear normalization failed '+JSON.stringify(s.equipment));
}
export async function prepare(agent,scenario,{hp=50,max=50,vigor=160}={}) {
  await gate(); const character=(await state(agent)).character;
  if(!character)throw new Error('missing character identity');
  let hs=JSON.parse(fs.readFileSync(path.join(out,'holds.json'),'utf8'));
  let entry=hs.find(x=>x.agent===agent);
  const current=await act(agent,'hold_status');
  const token=current.hold?.token??await hold(agent);
  await normalizeGear(agent,character);
  const ids=await resolve([character]);const id=ids[character];
  await dm([...healthCmds(id,max),setProp(id,'piHealth',hp),setProp(id,'piVigor',vigor),
    `send object ${id} DrawHealth`,`send object ${id} DrawVigor`]);
  const placed=await relocate([character],scenario.room,{row:scenario.row,col:scenario.col,verify:true});
  await act(agent,'stand');
  await sleep(1200);
  const s=await request(port(agent),'/state?fresh=1');
  if(s.room?.num!==scenario.room||s.hp?.value<hp||s.hp?.value>hp+3||s.hp?.max!==max)throw new Error('staging failed '+JSON.stringify({placed,hp:s.hp}));
  fs.writeFileSync(path.join(out,`prepared-${agent}.json`),JSON.stringify(s,null,2));
  return {token,s,placed};
}
export function compact(s) {
  const k=s.autopilot_status??{};
  return {at:Date.now(),pid:s.pid,connected:s.connected,room:s.room?.num,hp:s.hp,vigor:s.vigor,
    you:s.you,job:s.job,inert:k.inert,guard:k.travel_guard,activity:k.activity,
    deaths:k.did?.deaths,tally:k.did,watchdog:k.watchdog,suspended:k.suspended_journey,
    recent:k.recent,refusals:s.refusals,hold:k.safe_spot,age:s.as_of_ms};
}
export async function spawnEncounter(agent,sc,count=2,kind='Troll') {
  const me=await state(agent), room=await roomObject(sc.room); const made=[];
  for(let i=0;i<count;i++) {
    const reply=await dm([`create object ${kind}`]);const obj=Number(/Created object (\d+)/.exec(reply)?.[1]);
    if(!obj)throw new Error('monster create failed');
    const marker=9140000+Number(agent.replace('shadow',''))*100+i;
    await money(obj,marker);
    const delta=[[-1,0],[0,1],[1,0],[0,-1],[-1,1],[1,-1]][i%6];
    await dm([`send object ${obj} ClearBasicTimers`,relocateCmd(obj,room,me.you.row+delta[0],me.you.col+delta[1]),
      `send object ${obj} ClearBasicTimers`,`set object ${obj} poTarget OBJECT ${me.you.id}`]);
    made.push({object:obj,marker,kind,room:sc.room});
  }
  return made;
}
export async function removeEncounter(made) {
  for(const m of made) {
    const room=await roomObject(m.room);
    const shown=await dm([`show object ${room}`]);
    const list=/plActive\s*= LIST (\d+)/.exec(shown)?.[1];
    if(!list)throw new Error('cannot enumerate trial room');
    const contents=await dm([`show list ${list}`]);
    const ids=[...contents.matchAll(/^:\s+OBJECT (\d+)/gm)].map(x=>Number(x[1]));
    let found=null;
    for(const id of ids){
      const head=await dm([`show object ${id}`]);
      if(!head.includes(`is CLASS ${m.kind}`))continue;
      const pack=await packOf(id);
      if(pack.Money===m.marker){found=id;break;}
    }
    if(!found){
      const old=await dm([`show object ${m.object}`]);
      // Deleted objects can remain addressable until GC. An unowned, empty
      // monster is already out of the world; do not issue a second Delete.
      if(old.includes(`is CLASS ${m.kind}`)&&/poOwner\s*= \$ 0/.test(old)&&/plPassive\s*= \$ 0/.test(old))continue;
      throw new Error('test monster marker not found; no deletion sent: '+m.marker);
    }
    await dm([`send object ${found} Delete`]);
  }
}
export async function trial(agent,scenarioName,arm,id,{hp=50,max=50,seconds=180,monsters=0,kind='Troll'}={}) {
  const sc=scenarios[scenarioName];if(!sc)throw new Error('unknown scenario');
  await fresh(agent);
  const p=await prepare(agent,sc,{hp,max});
  const guards={flee:arm==='extra'||arm==='flee',fight_back:arm==='extra'||arm==='rate',arm:arm==='arm'};
  await post(agent,'/policy',{...basePolicy,travelGuard:guards,by:'shadow survival '+id});
  const dir=path.join(out,id);fs.mkdirSync(dir,{recursive:true});
  const encounter=await spawnEncounter(agent,sc,monsters,kind);
  // Natural regeneration may add a point while staging. Reset at release, after
  // equipment, placement and enemy creation, and verify directly on the server.
  const player=(await resolve([p.s.character]))[p.s.character];
  const confirmation=await dm([setProp(player,'piHealth',hp),setProp(player,'piVigor',160),
    `send object ${player} DrawHealth`,`send object ${player} DrawVigor`,`show object ${player}`]);
  if(!new RegExp(`piHealth\\s*= INT ${hp}\\b`).test(confirmation))throw new Error('final health reset failed');
  const meta={id,agent,scenario:scenarioName,arm,guards,encounter,asked:{hp,max},serverHpAtRelease:hp,code:'e1c26da',startedAt:new Date().toISOString(),seconds,placement:p.placed,before:p.s};
  fs.writeFileSync(path.join(dir,'meta.json'),JSON.stringify(meta,null,2));
  await act(agent,'release',{token:p.token,why:'shadow trial starts'});
  const begun=await act(agent,'travel',{to:sc.to,run_errands:false});
  if(encounter.length)await dm(encounter.map(m=>`send object ${m.object} EnterStateAttack actnow INT 1`));
  fs.writeFileSync(path.join(dir,'start.json'),JSON.stringify(begun));
  const start=Date.now();let end,last,rows=0,minHp=Infinity;
  while(Date.now()-start<seconds*1000) {
    const s=await state(agent);last=s;const row=compact(s);rows++;
    fs.appendFileSync(path.join(dir,'samples.jsonl'),JSON.stringify(row)+'\n');
    minHp=Math.min(minHp,s.hp?.value??Infinity);
    if(s.room?.num===1||s.hp?.value===0||s.hp?.max<max){end='death';break;}
    if(s.room?.num===sc.to){end='arrived';break;}
    await sleep(1000);
  }
  const result={id,agent,scenario:scenarioName,arm,outcome:end??'timeout',seconds:(Date.now()-start)/1000,minHp,
    final:compact(last),samples:rows};
  fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({id,outcome:result.outcome,seconds:Math.round(result.seconds),minHp,finalHp:last.hp,room:last.room?.num}));
  await cleanupTrial(id);
  return result;
}
export async function cleanupTrial(id){
  const dir=path.join(out,id), meta=JSON.parse(fs.readFileSync(path.join(dir,'meta.json')));
  await gate();await removeEncounter(meta.encounter);
  try{await post(meta.agent,'/stop');}catch(e){if(!String(e).includes('ECONNREFUSED'))throw e;}
  const name=meta.before.character, ids=await resolve([name]);
  await dm([...healthCmds(ids[name],50),setProp(ids[name],'piVigor',160)]);
  await relocate([name],52,{row:5,col:5,verify:true});
  fs.writeFileSync(path.join(dir,'cleanup.json'),JSON.stringify({monsters_removed_or_already_deleted:true,keeper_stopped:true,staged_in_sanctuary:true}));
}
const cmd=process.argv[2];
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  if(cmd==='park')await parkAll();
  else if(cmd==='cleanup')await cleanupTrial(process.argv[3]);
  else if(cmd==='prepare')console.log(JSON.stringify(await prepare(process.argv[3],scenarios[process.argv[4]])));
  else if(cmd==='trial')await trial(process.argv[3],process.argv[4],process.argv[5],process.argv[6],{seconds:Number(process.argv[7]??180),hp:Number(process.argv[8]??50),monsters:Number(process.argv[9]??0),kind:process.argv[10]??'Troll'});
  else if(cmd==='status')console.log(JSON.stringify(compact(await state(process.argv[3])),null,2));
}
