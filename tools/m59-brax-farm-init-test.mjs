// Offline only: task composition, raw source retention, broker fencing and the
// actual managed-worker lifecycle with injected ordinary game operations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {braxFarmPlan,braxTaskOrders,braxTaskLoadout,braxPolicyMismatches,qorCaster,requireAutomatedBraxActors,completeBraxInitialization,requireBraxArcherScript} from './m59-brax-farm.mjs';
import {reserveBraxService,releaseBraxReservation,startBraxService,stopBraxService,braxServiceStatus,runBraxSupplyWorker,localBraxBroker} from './m59-brax-service.mjs';
import {script} from './fleetscripts/brax-farm.mjs';
import {script as migration} from './fleetscripts/walk-to-brax.mjs';
import {runNamed} from './m59-fleetlib.mjs';
import {normalise,spellbook} from './m59-loadout.mjs';
import {withCallOrigin,currentCallOrigin} from './m59-fleetscript.mjs';
let passed=0;const test=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const dir=mkdtempSync(join(tmpdir(),'m59-brax-init-')),params={agents:['farmer'],couriers:['courierA','courierB'],runner:'farmer'};
try{
await test('explicit farmer/runner/mainland roles, cohort bounds, duplicate and wildcard refusals',()=>{
 const p=braxFarmPlan(params);assert.deepEqual(p.agents,['farmer','courierA','courierB']);
 assert.throws(()=>braxFarmPlan({...params,runner:'courierA'}));assert.throws(()=>braxFarmPlan({...params,agents:['all']}));
 assert.throws(()=>braxFarmPlan({...params,couriers:['courierA','courierA']}));assert.throws(()=>braxFarmPlan({...params,agents:['farmer','farmer']}));
 assert.throws(()=>braxFarmPlan({...params,agents:Array.from({length:26},(_,i)=>'f'+i),runner:'f0'}));
});
await test('a human-piloted or unobservable role is refused before the runner can claim anyone',()=>{
 requireAutomatedBraxActors([{agent:'f',piloted:null}],['f']);
 for(const rows of [null,[],[{agent:'f'}],[{agent:'f',piloted:{holder:'person'}}]])assert.throws(()=>requireAutomatedBraxActors(rows,['f']));
});
await test('mixed roles retain the upper hammer runner and require an installed confinement/supply/stop capable archer script',()=>{
 const mixed={...params,agents:['farmer','archer'],archers:'archer'},plan=braxFarmPlan(mixed);assert.deepEqual(plan.archers,['archer']);
 assert.throws(()=>braxFarmPlan({...mixed,runner:'archer'}));assert.throws(()=>requireBraxArcherScript(new Map([['archerplus',{name:'archerplus'}]])));
 assert(requireBraxArcherScript(new Map([['archerplus',{integration:{version:1,stationarySupply:true,allowedRooms:true,cooperativeStop:true}}]])));
 const archery={bow:'practice bow',arrows:160},orders=braxTaskOrders('farmer',{archery});assert.equal(orders.training_weapon,'practice bow');assert.equal(orders.training_weapon_only,false);assert.equal(orders.assigned_room,827);
 const load=braxTaskLoadout(null,{character:'Archer',agent:'archer',role:'farmer',abilities:{spells:[]},archery,arrived:true});
 assert.deepEqual(load.gear.weapon,['practice bow','hammer']);assert(load.carry.some(r=>r.item==='practice bow'&&r.min===1));
 assert(load.carry.some(r=>r.item==='arrows'&&r.min===160));assert.equal(plan.archerMode,'snipe');
});
await test('whole raw source loadout survives except documented weapon, stock and task-policy overlays',()=>{
 const source={character:'Farmer',plan:{school:false,custom:0},gear:{weapon:['mace'],slots:{body:['robe']},why:'keep this long operator note'},
  carry:[{item:'herb',min:35,max:50,why:'original'},{item:'loaf of bread',min:0,max:2}],sell:['axe'],keep:['quest ring'],policy:{heal_wand_below:0,buy_reagents:true},unknown:{retain:false}};
 const before=structuredClone(source),load=braxTaskLoadout(source,{character:'Farmer',agent:'farmer',role:'farmer',abilities:{spells:[{name:'minor heal',ability:10}]},arrived:true});
 assert.deepEqual(source,before);assert.deepEqual(load.plan,source.plan);assert.deepEqual(load.unknown,{retain:false});assert.equal(load.gear.why,source.gear.why);
 assert.deepEqual(load.gear.weapon,['hammer']);assert.equal(load.carry.find(r=>r.item==='herb').min,35);assert.equal(load.carry.find(r=>r.item==='loaf of bread').max,6);
 assert.equal(load.policy.heal_wand_below,0);assert.equal(load.policy.assigned_room,827);assert.equal(load.policy.buy_reagents,false);assert.deepEqual(load.sell,['axe']);
 assert.equal(normalise(load).loadout.carry.find(r=>r.item==='herb').min,35);
 assert.throws(()=>braxTaskLoadout(source,{character:'Someone Else',agent:'f',role:'farmer',abilities:{}}),/another character/);
});
await test('Qor identification uses known spell metadata and hammer farming retains distinct priorities and ledge components',()=>{
 const spell=[...spellbook().values()].find(s=>s.school==='Qor');assert(spell);
 assert(qorCaster({spells:[{name:spell.name,ability:1}]}));assert(!qorCaster({spells:[{name:spell.name,ability:0}]}));
 const f=braxTaskOrders('farmer',{qor:true,protectedItems:['quest ring','bread']}),c=braxTaskOrders('courier');
 assert.equal(f.hunt_priority[0],'narthyl worm');assert.equal(braxTaskOrders('farmer').hunt_priority[0],'daemon skeleton');
 assert.deepEqual(f.movement_region.anchors[578],{x:2352,y:2208});assert.deepEqual(c.movement_region.anchors[578],{x:2256,y:2208});
 assert(!c.confine_rooms.includes(827));assert(!f.confine_rooms.includes(579));assert.deepEqual(f.protect_items,['quest ring']);
 assert.equal(f.training_weapon,'hammer');assert.equal(f.training_weapon_only,true);assert.equal(f.town_trips,false);
 assert.deepEqual(braxPolicyMismatches({assignedRoom:827},{assigned_room:827}),[]);assert.deepEqual(braxPolicyMismatches({assignedRoom:38},{assigned_room:827}),['assigned_room']);
});
await test('local initializer refuses the wrong broker roster, deployment root, fleet and nonlocal URL before changing anything',async()=>{
 const options={root:dir,stateFile:join(dir,'roster.json'),url:'http://127.0.0.1:9999/',fetchImpl:async()=>({ok:true,json:async()=>({fleet:'fixture',root:dir,state:join(dir,'roster.json')})})};
 assert.equal((await localBraxBroker('fixture',options)).fleet,'fixture');
 await assert.rejects(localBraxBroker('other',options),/does not match/);await assert.rejects(localBraxBroker('fixture',{...options,stateFile:join(dir,'wrong.json')}),/does not match/);
 await assert.rejects(localBraxBroker('fixture',{...options,url:'http://remote.invalid/'}),/locally/);
});
await test('couriers have no lift; a farmer cohort compiles the existing static route once, preserving one shared group',async()=>{
 const courier=await script.steps({...params,agent:'courierA'});assert.deepEqual(courier.map(s=>s.do),['verify','walk','verify']);assert.equal(courier[1].to,350);
 const previous=migration.steps;let compiled=0;migration.steps=async p=>{compiled++;return previous(p);};
 try{const cohort={...params,agents:['farmer','farmer2']},[a,b]=await Promise.all(['farmer','farmer2'].map(agent=>script.steps({...cohort,agent})));
  assert.equal(a.length,4);assert(a.every(s=>s.do==='verify'));assert.equal(compiled,1);assert.equal(a[1],b[1]);assert.equal(a[2],b[2]);
 }finally{migration.steps=previous;}
});
await test('afterRun is called once after the real library runner returns, receives partial failures and cannot turn a callback exception into success',async()=>{
 let released=false,finished=0;
 const template={name:'fixture',source:'public',params:{agents:{required:true}},steps:async()=>[],afterRun:async({result})=>{assert(released);finished++;return{ok:Object.values(result.results).every(r=>r.ok),standing:true};}};
 const run=()=>runNamed('fixture',{agents:['a','b']},{scripts:new Map([['fixture',template]]),fleetScript:async()=>{released=true;return{ok:true,results:{a:{ok:true},b:{ok:false}}};},onLog:()=>{}});
 const r=await run();assert.equal(finished,1);assert.equal(r.ok,false);assert.equal(r.standing,true);assert.equal(r.results.b.ok,false);
 template.afterRun=()=>{throw Error('unconfirmed worker');};assert.match((await run()).why,/unconfirmed worker/);
});
await test('overlapping courier legs retain their own movement issuer through awaits and nested scripts',async()=>{
 let release;const barrier=new Promise(r=>release=r),seen=[];
 await withCallOrigin({source:'bot',name:'supply-parent'},async()=>{
  await Promise.all([
   withCallOrigin({source:'fleetscript',name:'courierA',run_id:'A'},async()=>{await barrier;seen.push(currentCallOrigin().run_id);}),
   withCallOrigin({source:'fleetscript',name:'courierB',run_id:'B'},async()=>{seen.push(currentCallOrigin().run_id);release();await Promise.resolve();seen.push(currentCallOrigin().run_id);})]);
  assert.equal(currentCallOrigin().name,'supply-parent');
 });assert.deepEqual(seen,['B','A','B']);
});
const reserve=(name)=>reserveBraxService({fleet:name,stateFile:join(dir,name+'.json'),root:dir,url:'http://127.0.0.1:9999/',...braxFarmPlan(params),
 actors:[{agent:'farmer',role:'farmer',character:'Farmer'},{agent:'courierA',role:'courier',character:'Courier A'},{agent:'courierB',role:'courier',character:'Courier B'}]}, {directory:dir});
const markStarting=r=>{const p=r.paths.lock,v=JSON.parse(fs.readFileSync(p));fs.writeFileSync(p,JSON.stringify({...v,phase:'starting'}));};
const native=a=>({character:a.character,in_game:true,connected:true,room:{num:a.role==='farmer'?827:350},hp:{value:100,max:100},equipment_items:[{name:'hammer'}],
 autopilot_status:{faculties:{work:'keeper'},policy:{movementRegion:{id:a.role==='farmer'?'brax-farmer':'brax-mainland-courier'}}}});
await test('an existing or unknown controller reservation is never replaced and only its initializing owner can release it',()=>{
 const r=reserve('lock');assert.throws(()=>reserve('lock'),/already reserved/);assert.equal(releaseBraxReservation({...r,token:'wrong'}),false);
 assert.equal(braxServiceStatus('lock',{directory:dir,stateFile:r.stateFile}).reserved,true);assert(releaseBraxReservation(r));
 assert.throws(()=>reserve('lock'),/needs reconciliation/);
});
await test('partial arrivals never start farming or supply; an unconfirmed mode frees only an unused reservation',async()=>{
 const plan=braxFarmPlan(params),results=Object.fromEntries(plan.agents.map(a=>[a,{ok:true}]));let launches=0,orders=[];
 const deps={rpc:async(_,args)=>{orders.push(args);return{keeper_push:{confirmed:true}};},start:async()=>{launches++;return{phase:'running'};}};
 const partial=reserve('partial');assert.equal((await completeBraxInitialization(partial,plan,{results:{...results,farmer:{ok:false}}},deps)).ok,false);
 assert.equal(launches,0);assert.equal(orders.length,0);assert(!fs.existsSync(partial.paths.lock));
 const failed=reserve('mode-refusal');await assert.rejects(completeBraxInitialization(failed,plan,{results},{...deps,rpc:async()=>({keeper_push:{confirmed:false}})}),/mode not confirmed/);
 assert.equal(launches,0);assert(!fs.existsSync(failed.paths.lock));
 const good=reserve('complete');const out=await completeBraxInitialization(good,plan,{results},deps);
 assert.equal(out.ok,true);assert.equal(launches,1);assert.deepEqual(orders,[{agent:'farmer',action:'start',mode:'farm'}]);releaseBraxReservation(good);
 const uncertain=reserve('uncertain-complete');await assert.rejects(completeBraxInitialization(uncertain,plan,{results},{...deps,start:async r=>{markStarting(r);throw Error('unknown launch');}}),/unknown launch/);
 assert(fs.existsSync(uncertain.paths.lock));
 const mixed=reserve('mixed-complete');mixed.actors.push({agent:'archer',role:'farmer',archery:{bow:'practice bow'}});orders=[];
 const mixedPlan=braxFarmPlan({...params,agents:['farmer','archer'],archers:'archer'});
 await completeBraxInitialization(mixed,mixedPlan,{results:{...results,archer:{ok:true}}},deps);
 assert.deepEqual(orders,[{agent:'farmer',action:'start',mode:'farm'}],'archer remains idle until its task acquires the receiver lease');releaseBraxReservation(mixed);
});
await test('uncertain child startup is persisted before spawn and cannot be retried or released as an unused reservation',async()=>{
 const r=reserve('unknown');let spawns=0;
 const spawnImpl=()=>{spawns++;const c=new EventEmitter();c.pid=999999;c.unref=()=>{};queueMicrotask(()=>c.emit('spawn'));return c;};
 await assert.rejects(startBraxService(r,{spawnImpl,timeoutMs:0}),/outcome unknown/);
 await assert.rejects(startBraxService(r,{spawnImpl,timeoutMs:0}),/reservation changed/);assert.equal(spawns,1);assert.equal(releaseBraxReservation(r),false);
});
await test('actual worker qualification fences actor identity, region, equipment and foreign work before any courier starts',async()=>{
 for(const fault of ['identity','region','hammer','work']){
  const r=reserve('bad-'+fault);markStarting(r);let starts=0;
  const out=await runBraxSupplyWorker(r,{readActor:async agent=>{const s=native(r.actors.find(a=>a.agent===agent));if(fault==='identity')s.character='Other';if(fault==='region')s.autopilot_status.policy.movementRegion.id='Elsewhere';if(fault==='hammer')s.equipment_items=[];if(fault==='work')s.autopilot_status.faculties.work='foreign';return s;},
   serviceFactory:()=>{starts++;},rpc:async()=>{throw Error('no calls');}});
  assert.equal(out.phase,'needs-attention');assert.equal(starts,0);assert(!fs.existsSync(r.paths.lock));
 }
});
await test('human takeover or changed assignment refuses the next service command and route before submission',async()=>{
 const r=reserve('takeover');markStarting(r);let submitted=0,pilot=false,changed=false;
 const out=await runBraxSupplyWorker(r,{readActor:async a=>{const s=native(r.actors.find(x=>x.agent===a));if(changed)s.autopilot_status.policy.movementRegion.id='new-task';return s;},
  rpc:async()=>{submitted++;return{};},verifyActors:async()=>{if(pilot)throw Error('human-piloted');},runLeg:async()=>{submitted++;},serviceFactory:opts=>({cycles:{},stop(){},async run(){
   pilot=true;await assert.rejects(opts.call('shop',{agent:'courierA'}),/human-piloted/);await assert.rejects(opts.runLeg('courierA','courier','out'),/human-piloted/);
   pilot=false;changed=true;await assert.rejects(opts.call('autopilot',{agent:'farmer',action:'start',mode:'idle'}),/assignment changed/);return[];
  }})});assert.equal(out.phase,'stopped');assert.equal(submitted,0);
});
await test('the managed worker reports deliveries/cycles, rejects undeclared or nonlogistics operations, and honors its token-bound stop',async()=>{
 const r=reserve('worker');markStarting(r);let service;
 const out=await runBraxSupplyWorker(r,{readActor:async a=>native(r.actors.find(x=>x.agent===a)),rpc:async()=>({ok:true}),serviceFactory:opts=>service={cycles:{courierA:1},stopped:false,
  stop(){this.stopped=true;},async run(){await assert.rejects(opts.call('reroll',{agent:'farmer'}),/non-logistics/);await assert.rejects(opts.call('inventory',{agent:'stranger'}),/outside/);
   await opts.emit({kind:'farmer-delivery-confirmed',to:'farmer',quantity:4});await opts.emit({kind:'cycle-complete',agent:'courierA',cycles:1});return[{status:'fulfilled'}];}}});
 assert.equal(out.phase,'stopped');assert.equal(out.deliveries,1);assert.equal(out.cycles.courierA,1);assert(!fs.existsSync(r.paths.lock));
 const stop=reserve('stop');markStarting(stop);stopBraxService('stop',{directory:dir,stateFile:stop.stateFile});
 const ended=await runBraxSupplyWorker(stop,{readActor:async a=>native(stop.actors.find(x=>x.agent===a)),rpc:async()=>({}),serviceFactory:()=>({stopped:false,cycles:{},stop(){this.stopped=true;},async run(){assert(this.stopped);return[];}})});
 assert.equal(ended.phase,'stopped');
});
await test('the managed worker runs the archer separately and waits for its cooperative stop before releasing the controller',async()=>{
 const r=reserve('mixed-worker');r.actors[0].archery={bow:'practice bow',arrows:160,hours:4};markStarting(r);let launched=0;
 const out=await runBraxSupplyWorker(r,{readActor:async a=>{const actor=r.actors.find(x=>x.agent===a),s=native(actor);if(actor.archery)s.equipment_items=[{name:'practice bow'}];return s;},rpc:async()=>({}),
  runTask:async actor=>{launched++;assert.equal(actor.agent,'farmer');assert(!fs.existsSync(r.paths.stop));await new Promise(ok=>setTimeout(ok,5));assert.equal(JSON.parse(fs.readFileSync(r.paths.stop)).token,r.token);return{ok:true};},
  serviceFactory:()=>({cycles:{},stopped:false,stop(){this.stopped=true;},async run(){return[];}})});
 assert.equal(launched,1);assert.equal(out.tasks.farmer.phase,'completed');assert(!fs.existsSync(r.paths.lock));
});
await test('an unexpected courier exception settles its archer before controller unlock',async()=>{
 const r=reserve('mixed-exception');r.actors[0].archery={bow:'practice bow'};markStarting(r);let ended=false;
 const out=await runBraxSupplyWorker(r,{readActor:async a=>{const actor=r.actors.find(x=>x.agent===a),s=native(actor);if(actor.archery)s.equipment_items=[{name:'practice bow'}];return s;},
  runTask:async()=>{await new Promise(ok=>setTimeout(ok,5));assert(fs.existsSync(r.paths.lock));assert.equal(JSON.parse(fs.readFileSync(r.paths.stop)).token,r.token);ended=true;return{ok:true};},
  serviceFactory:()=>({cycles:{},stop(){},async run(){throw Error('unexpected service failure');}})});
 assert(ended);assert.equal(out.phase,'needs-attention');assert.match(out.error,/unexpected/);assert(!fs.existsSync(r.paths.lock));
});
console.log(`${passed} Brax initialization scenarios passed`);
}finally{rmSync(dir,{recursive:true,force:true});}
