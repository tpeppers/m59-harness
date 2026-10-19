import assert from'node:assert/strict';import{BraxSupplyService,braxNeeds,braxCourierTarget,braxSaleCargo}from'./m59-brax-supply.mjs';import{trustedBuyer}from'./m59-skills.mjs';
const c={abilities:{spells:[{name:'minor heal',ability:40}]}};assert.deepEqual(braxNeeds(c,[]),{hammer:1,'loaf of bread':6,herb:20,elderberry:0});assert.equal(braxNeeds(c,[{name:'hammer',amount:0},{name:'herbs',amount:20}]).herb,0);assert(trustedBuyer("Zhieu B'hob"));assert(!trustedBuyer('Yevitan'));
assert.throws(()=>new BraxSupplyService({actors:[],runner:'x',couriers:['a','b']}));
// Separate workers may buy/return while the one upper runner is in use; no convoy barrier.
const actors=[{shadow_account:'r',role:'farmer'}],events=[],s=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call(){},read:async()=>({room:{num:350}}),runLeg:async()=>{},emit:async e=>events.push(e)});let current=0,peak=0,bought=0;s.procure=async()=>{bought++;};s.exchange=async()=>{current++;peak=Math.max(peak,current);await new Promise(r=>setTimeout(r,5));current--;return{lowerBack:Promise.resolve()};};await s.run({maxCycles:2});assert.equal(peak,1);assert.equal(bought,4);assert.equal(events.filter(e=>e.kind==='cycle-complete').length,4);console.log('PASS role/demand accounting, trusted Jasper reagent buyer and independent courier workers with serialized upper handoffs');

assert.equal(braxNeeds(c,[{name:'purple mushroom',amount:100}])['loaf of bread'],6,'reagents are not food');assert.equal(braxNeeds(c,[{name:'loaf of bread',amount:6}])['loaf of bread'],0);

// Follow a native keeper's existing same-owner recovery journey without a second POST.
let travelPosts=0,reads=0;const body={you:{id:7},pid:123,hp:{value:80},room:{num:350}};
const recoveryService=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call:async()=>{travelPosts++;return{ordered_by:'operator:test',arrived:false};},read:async()=>{reads++;return reads<3?{...body,autopilot_status:{suspended_journey:{to:374,ordered_by:'operator:test'}}}:{...body,room:{num:374}};},wait:async()=>{},runLeg:async()=>{}});
await recoveryService.townTravel('a',374);assert.equal(travelPosts,1);assert.equal(reads,3);
// A new life must never inherit the previous courier's objective.
reads=0;recoveryService.read=async()=>++reads===1?body:{...body,you:{id:8}};
await assert.rejects(recoveryService.townTravel('a',374),/body changed/);
// One occupied ledge lane includes the lower OUT leg, not merely its final trade.
let laneBusy=0,lanePeak=0;const laneService=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call(){},read:async()=>({room:{num:350}}),runLeg:async()=>{laneBusy++;lanePeak=Math.max(lanePeak,laneBusy);await new Promise(r=>setTimeout(r,2));},emit(){}});
laneService.procure=async()=>{};laneService.exchange=async()=>{await new Promise(r=>setTimeout(r,2));laneBusy--;return{lowerBack:Promise.resolve()};};await laneService.run({maxCycles:2});assert.equal(lanePeak,1);
console.log('PASS retained native recovery observed once; changed life refused; lower approach included in exclusive lane');

// A save invalidates read handles transiently; only READs may be repeated here.
let inventoryReads=0;const saveService=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call:async name=>{assert.equal(name,'inventory');return{items:[],ids_stale:++inventoryReads<3};},read(){},runLeg(){},wait:async()=>{}});await saveService.pack('a');assert.equal(inventoryReads,3);
// Exact known load can fit a critical hammer even with less than16spare units.
const hammer={name:'hammer',id:1,amount:0};let deliveredAmount=0;const capacityService=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call:async(name,args)=>{if(name==='inventory')return{items:[hammer],ids_as_of:1};deliveredAmount=args.what[0].amount;return{supplied:true,amounts:[{asked:1,giver_lost:1}]};},read:async()=>({carry:{known:true,load:{exact:true},room_for:{weight:660,bulk:90}}}),runLeg(){}});assert.equal((await capacityService.transfer('a','r',hammer,1)).quantity,1);assert.equal(deliveredAmount,1);
capacityService.read=async()=>({carry:{known:true,load:{exact:true},room_for:{weight:660,bulk:74}}});assert.equal((await capacityService.transfer('a','r',hammer,1)).deferred,true);
console.log('PASS autosave handle refresh repeats reads only; exact critical hammer capacity admits90bulk and refuses74');

// A rejected upper exchange must not erase the physically occupied lower lane.
const laneFailure=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call(){},read:async()=>({room:{num:578},you:{x:2256,y:2208}}),runLeg(){}});laneFailure.lastLaneCourier='a';await assert.rejects(laneFailure.admitLane('b'),/still occupies/);laneFailure.read=async()=>({room:{num:578},you:{x:2100,y:2208}});await laneFailure.admitLane('b');assert.equal(laneFailure.lastLaneCourier,'b');
console.log('PASS an exchange failure cannot silently free an occupied ledge lane');

assert.equal(braxCourierTarget('hammer',1,8),2,'a courier retaining its own hammer must buy another for the last unarmed farmer');assert.equal(braxCourierTarget('herb',2,80),7);assert.equal(braxCourierTarget('loaf of bread',1,48),5);

// Object handles renumber on save; identity-fenced same character/PID is not a new life.
reads=0;recoveryService.read=async()=>++reads===1?{...body,character:'Courier A'}:{...body,character:'Courier A',you:{id:8},room:{num:374}};await recoveryService.townTravel('a',374);
reads=0;recoveryService.read=async()=>++reads===1?{...body,character:'Courier A'}:{...body,character:'Courier A',you:{id:8},room:{num:374},autopilot_status:{last_death:{at:Date.now()}}};await assert.rejects(recoveryService.townTravel('a',374),/body changed/);
console.log('PASS a save handle change preserves the fenced courier identity; an observed death refuses');

for(const name of ["shield of the Princess' army","shield of the Duke's guard",'shield of the rebel militia','guild shield','wand of healing','quest sword'])assert(!braxSaleCargo(name));for(const name of ['knight shield','axe','sapphire'])assert(braxSaleCargo(name));console.log('PASS faction-bound and protected gear never selected as sale cargo');

// A definite server capacity refusal with both deltas0 is a deferral, not a lost transfer.
let refusedPosts=0;const fullService=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call:async(name,args)=>{if(name==='inventory')return{items:args.agent==='a'?[{id:5,name:'loaf of bread',amount:1}]:[{id:6,name:'axe',amount:0}]};refusedPosts++;return{supplied:false,partial:false,reason_code:'receiver_full',amounts:[],not_received:[{received:0,giver_lost:0}]};},read:async()=>({carry:{known:true,load:{exact:true},room_for:{weight:100,bulk:100}}}),runLeg(){}});
assert((await fullService.transfer('a','r',{id:5,name:'loaf of bread'},1)).deferred);assert((await fullService.transfer('a','r',{id:5,name:'loaf of bread'},1)).deferred);assert.equal(refusedPosts,1,'unchanged rejected inventory cannot trigger another offer');
console.log('PASS confirmed zero-transfer capacity refusal defers, records disagreement and cannot repeat against unchanged inventory');

// A budget handoff must fund actual shop loads, not inherit the100-unit cargo cap.
const budgetSent=[];const budgetService=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call(){},read:async agent=>({room:{num:agent==='r'?578:350},you:{x:100,y:100},equipment_items:[],carry:{room_for:{weight:1000,bulk:1000}}}),runLeg:async()=>{},farmRunner:false});budgetService.pack=async agent=>({items:agent==='r'?[{id:10,name:'shilling',amount:6000}]:[]});budgetService.runnerMode=async()=>{};budgetService.collectLocal=async()=>{};budgetService.deliverLocal=async()=>{};budgetService.transfer=async(from,to,item,n)=>{budgetSent.push({from,to,n});return{quantity:n};};await budgetService.exchange('a');assert.equal(budgetSent[0].n,5000);assert.equal(budgetSent[0].to,'a');
console.log('PASS upper budget export funds a Jasper load while retaining its own reserve');

let readyCalls=0;const readyService=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call:async name=>{if(name==='inventory')return{items:[hammer]};readyCalls++;return{supplied:false,reason:'stationary body not ready: body is not ready for a stationary exchange'};},read:async()=>({carry:{known:true,load:{exact:true},room_for:{weight:500,bulk:500}}}),runLeg(){}});assert((await readyService.transfer('a','r',hammer,1)).deferred);assert((await readyService.transfer('a','r',hammer,1)).deferred);assert.equal(readyCalls,1);
console.log('PASS pre-offer native readiness refusal defers without repeated calls or claiming delivery');
