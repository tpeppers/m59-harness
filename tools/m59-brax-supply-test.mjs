import assert from'node:assert/strict';import{BraxSupplyService,braxNeeds,braxCourierTarget,braxSaleCargo,braxProvisionReserve}from'./m59-brax-supply.mjs';import{trustedBuyer}from'./m59-skills.mjs';
const c={abilities:{spells:[{name:'minor heal',ability:40}]}};assert.deepEqual(braxNeeds(c,[]),{hammer:1,'loaf of bread':6,herb:20,elderberry:0});assert.equal(braxNeeds(c,[{name:'hammer',amount:0},{name:'herbs',amount:20}]).herb,0);assert(trustedBuyer("Zhieu B'hob"));assert(!trustedBuyer('Yevitan'));
assert.throws(()=>new BraxSupplyService({actors:[],runner:'x',couriers:['a','b']}));
// Separate workers may buy/return while the one upper runner is in use; no convoy barrier.
const actors=[{shadow_account:'r',role:'farmer'}],events=[],s=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call(){},read:async()=>({room:{num:350}}),runLeg:async()=>{},emit:async e=>events.push(e)});let current=0,peak=0,bought=0;s.procure=async()=>{bought++;};s.exchange=async(agent,{startLowerOut})=>{await startLowerOut();current++;peak=Math.max(peak,current);await new Promise(r=>setTimeout(r,5));current--;return{lowerBack:Promise.resolve()};};await s.run({maxCycles:2});assert.equal(peak,1);assert.equal(bought,4);assert.equal(events.filter(e=>e.kind==='cycle-complete').length,4);console.log('PASS role/demand accounting, trusted Jasper reagent buyer and independent courier workers with serialized upper handoffs');

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
laneService.procure=async()=>{};laneService.exchange=async(agent,{startLowerOut})=>{await startLowerOut();await new Promise(r=>setTimeout(r,2));laneBusy--;return{lowerBack:Promise.resolve()};};await laneService.run({maxCycles:2});assert.equal(lanePeak,1);
console.log('PASS retained native recovery observed once; changed life refused; lower approach included in exclusive lane');

// A save invalidates read handles transiently; only READs may be repeated here.
let inventoryReads=0;const saveService=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call:async name=>{assert.equal(name,'inventory');return{items:[],ids_stale:++inventoryReads<3};},read(){},runLeg(){},wait:async()=>{}});await saveService.pack('a');assert.equal(inventoryReads,3);
// A native receiver_full at the exact75bulk estimate refuted zero-margin hammers.
const hammer={name:'hammer',id:1,amount:0};let deliveredAmount=0;const capacityService=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call:async(name,args)=>{if(name==='inventory')return{items:[hammer],ids_as_of:1};deliveredAmount=args.what[0].amount;return{supplied:true,amounts:[{asked:1,giver_lost:1}]};},read:async()=>({carry:{known:true,load:{exact:true},room_for:{weight:660,bulk:91}}}),runLeg(){}});assert.equal((await capacityService.transfer('a','r',hammer,1)).quantity,1);assert.equal(deliveredAmount,1);
capacityService.read=async()=>({carry:{known:true,load:{exact:true},room_for:{weight:660,bulk:75}}});assert.equal((await capacityService.transfer('a','r',hammer,1)).deferred,true);
console.log('PASS autosave handle refresh repeats reads only; conservative hammer capacity admits91bulk and refuses the captured75bulk boundary');

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
const budgetSent=[];const budgetService=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call(){},read:async agent=>({room:{num:agent==='r'?578:350},you:{x:100,y:100},equipment_items:[],carry:{room_for:{weight:1000,bulk:1000}}}),runLeg:async()=>{},farmRunner:false});budgetService.pack=async agent=>({items:agent==='r'?[{id:10,name:'shilling',amount:6000}]:[]});budgetService.waitExchangeReady=async()=>{};budgetService.runnerMode=async()=>{};budgetService.collectLocal=async()=>{};budgetService.deliverLocal=async()=>{};budgetService.transfer=async(from,to,item,n)=>{budgetSent.push({from,to,n});return{quantity:n};};await budgetService.exchange('a');assert.equal(budgetSent[0].n,5000);assert.equal(budgetSent[0].to,'a');
console.log('PASS upper budget export funds a Jasper load while retaining its own reserve');

let readyCalls=0;const readyService=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call:async name=>{if(name==='inventory')return{items:[hammer]};readyCalls++;return{supplied:false,reason:'stationary body not ready: body is not ready for a stationary exchange'};},read:async()=>({carry:{known:true,load:{exact:true},room_for:{weight:500,bulk:500}}}),runLeg(){}});assert((await readyService.transfer('a','r',hammer,1)).deferred);assert((await readyService.transfer('a','r',hammer,1)).deferred);assert.equal(readyCalls,1);
console.log('PASS pre-offer native readiness refusal defers without repeated calls or claiming delivery');

// stop() cannot release a queued ticket into a new trip after the deadline.
let release;const gate=new Promise(r=>{release=r}),legs=[];
const stopped=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call(){},read:async()=>({room:{num:350}}),runLeg:async(...args)=>legs.push(args)});stopped.upperGate=gate;stopped.procure=async()=>{};const worker=stopped.worker('a',{maxCycles:1});await new Promise(r=>setTimeout(r,0));stopped.stop();release();await worker;assert.equal(legs.length,0);console.log('PASS unstarted queued trips are cancelled by stop without touching accepted legs');

const roomExports=[];const roomService=new BraxSupplyService({actors:[...actors,{shadow_account:'f',role:'farmer'}],runner:'r',couriers:['a','b'],read:async()=>({carry:{known:true,load:{exact:true},room_for:{weight:20,bulk:-20}},equipment_items:[{id:1}],autopilot_status:{policy:{protectedItems:['sapphire']},loadout_retention:{carry_floors:{emerald:10}}}}),call(){},runLeg(){}});
roomService.pack=async()=>({items:[{id:1,name:'long sword',amount:0},{id:2,name:'sapphire',amount:100},{id:3,name:'emerald',amount:10},{id:4,name:'axe',amount:0}]});roomService.transfer=async(from,to,item,n)=>{roomExports.push({from,to,item:item.name,n});return{quantity:n};};await roomService.makeDeliveryRoom({shadow_account:'f'},'hammer');assert.deepEqual(roomExports,[{from:'f',to:'r',item:'axe',n:1}]);console.log('PASS kit-room export retains worn, protected and floored stock and sends only actual surplus loot');

assert.equal(braxNeeds(c,[{name:'mushroom',amount:50}],{protectedNames:['mushroom']})['loaf of bread'],6);assert.equal(braxNeeds(c,[{name:'loaf of bread',amount:6}],{protectedNames:['mushroom']})['loaf of bread'],0);console.log('PASS food held out of the native larder does not satisfy courier meal demand');

let free2={weight:20,bulk:-20};const room2=[];roomService.read=async()=>({carry:{known:true,load:{exact:true},room_for:free2},equipment_items:[],autopilot_status:{policy:{},loadout_retention:{carry_floors:{}}}});roomService.pack=async()=>({items:[{id:5,name:'diamond',amount:5},{id:6,name:'axe',amount:0}]});roomService.transfer=async(from,to,item,n)=>{room2.push(item.name);free2={weight:free2.weight+(item.name==='diamond'?5:90),bulk:free2.bulk+(item.name==='diamond'?5:90)};return{quantity:n};};await roomService.makeDeliveryRoom({shadow_account:'f'},'hammer');assert.deepEqual(room2,['diamond','axe']);assert(free2.bulk>=75);console.log('PASS capacity repair continues across distinct surplus stacks until one whole provision fits');

const restored=[];const failedService=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call:async(name,args)=>{restored.push(args);return{keeper_push:{confirmed:true}}},read:async()=>({in_game:true,connected:true,room:{num:827},hp:{value:50,max:70},job:null,movement:{order:null},autopilot_status:{mode:'idle',faculties:{work:'keeper'}}}),runLeg(){}});await failedService.failedUpper('a',Error('known-ended public leg'));assert.equal(restored.length,1);assert.equal(restored[0].mode,'farm');failedService.read=async()=>({in_game:true,connected:true,room:{num:827},hp:{value:70,max:70},movement:{order:{kind:'walk'}},autopilot_status:{mode:'idle',faculties:{work:'keeper'}}});await failedService.failedUpper('a',Error('transport uncertain'));assert.equal(restored.length,1);console.log('PASS ended home runner resumes requested farming; a pending or unknown movement receives no replacement control');

failedService.stop();failedService.read=async()=>({in_game:true,connected:true,room:{num:827},hp:{value:70,max:70},movement:{order:null},autopilot_status:{mode:'idle',faculties:{work:'keeper'}}});await failedService.failedUpper('a',Error('post-deadline failure'));assert.equal(restored.length,1);console.log('PASS an ended service cannot restart farming after the measurement has stopped');

// A save between sequential cargo rows is NOT permission to relabel an old
// handle with the fresh read stamp. No offer has been sent for this row.
const staleEvents=[];let staleOffers=0;
const staleCargo=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call:async(name)=>{if(name==='inventory')return{items:[{id:12,name:'herb',amount:20}],ids_as_of:{inventory_at:300,last_save_at:200}};staleOffers++;throw Error('must not submit stale cargo');},read:async()=>({}),runLeg(){},emit:async e=>staleEvents.push(e)});
assert((await staleCargo.transfer('a','r',{id:1,name:'herb',amount:20},10,{inventory_at:100})).unsubmitted);
assert((await staleCargo.transfer('a','r',{id:12,name:'herb',amount:20},10,{inventory_at:100})).unsubmitted,'a recycled same-name handle still predates the save');
const objectStampCall=staleCargo.call;
staleCargo.call=async name=>{if(name==='inventory')return{items:[{id:12,name:'herb',amount:20}],ids_as_of:300,last_save_at:200};staleOffers++;throw Error('must not send scalar-stamped stale cargo');};
assert((await staleCargo.transfer('a','r',{id:12,name:'herb'},10,100)).unsubmitted,'actual native scalar inventory stamp also rejects a same-name recycled handle');
staleCargo.call=objectStampCall;
assert.equal(staleOffers,0);assert(staleEvents.every(e=>e.submission.attempted===false));
// A fresh next intent may send once; an ambiguous accepted result still stops.
staleCargo.call=async(name)=>name==='inventory'?{items:[{id:12,name:'herb',amount:20}],ids_as_of:{inventory_at:300,last_save_at:200}}:(staleOffers++,{supplied:true,amounts:[{asked:10,giver_lost:10}]});staleCargo.read=async()=>({carry:{known:true,load:{exact:true},room_for:{weight:1000,bulk:1000}}});assert.equal((await staleCargo.transfer('a','r',{id:12,name:'herb'},10,{inventory_at:300})).quantity,10);assert.equal(staleOffers,1);
staleCargo.call=async(name)=>name==='inventory'?{items:[{id:12,name:'herb',amount:20}]}:{supplied:false,partial:true,reason:'unknown receiver delta'};await assert.rejects(staleCargo.transfer('a','r',{id:12,name:'herb'},10),/not verified/);
console.log('PASS saved/consumed planned cargo defers before any submission; fresh new intent sends once and ambiguous accepted transfers remain fatal');

// The measured gap: a stationary room-wide gift never approached the farmer.
const localCalls=[],localEvents=[];
const localSupply=new BraxSupplyService({actors:[...actors,{shadow_account:'f',role:'farmer'}],runner:'r',couriers:['a','b'],
 call:async(name,args)=>{if(name==='inventory')return{items:[{id:45,name:'herb',amount:30}]};localCalls.push(args);return{supplied:true,amounts:[{asked:2,giver_lost:2,received:2}]};},
 read:async()=>({room:{num:827},carry:{known:true,load:{exact:true},room_for:{weight:1000,bulk:1000}}}),runLeg(){},emit:async e=>localEvents.push(e)});
await localSupply.transfer('r','f',{id:45,name:'herb'},2);assert.equal(localCalls[0].who_travels,'from');assert.equal(localCalls[0].stationary,false);assert.equal(localEvents.filter(e=>e.kind==='farmer-delivery-confirmed').length,1);
await localSupply.transfer('f','r',{id:45,name:'herb'},2);assert.equal(localCalls[1].who_travels,'to','runner collects, patient does not leave post');
localSupply.read=async()=>({room:{num:578},carry:{known:true,load:{exact:true},room_for:{weight:1000,bulk:1000}}});await localSupply.transfer('a','r',{id:45,name:'herb'},2);assert.equal(localCalls[2].stationary,true);assert.equal(localCalls[2].who_travels,'neither');
localSupply.call=async name=>name==='inventory'?{items:[{id:45,name:'herb',amount:30}]}:{supplied:true,amounts:[{asked:2,giver_lost:2,received:0}]};await assert.rejects(localSupply.transfer('r','f',{id:45,name:'herb'},2),/not verified/);
console.log('PASS local distribution moves only runner, ledge stays stationary, delivery requires reconciled receiver gain');
let recoveryLegs=0,home=false;failedService.stopped=false;failedService.runLeg=async(agent,role,direction)=>{assert.equal(role,'farmer');assert.equal(direction,'back');recoveryLegs++;home=true;};failedService.read=async()=>({in_game:true,connected:true,room:{num:home?827:578},hp:{value:70,max:70},movement:{order:null},autopilot_status:{mode:'idle',faculties:{work:'keeper'}}});await failedService.failedUpper('a',Error('ended pre-offer failure'));assert.equal(recoveryLegs,1);assert.equal(restored.length,2);
console.log('PASS ended upper failure returns carried cargo home before restoring farm mode');

const cook={abilities:{spells:[{name:'create food',ability:40}]}},warrior={abilities:{spells:[]}};
assert.equal(braxProvisionReserve(cook,'herb'),6);assert.equal(braxProvisionReserve(cook,'elderberry'),10);assert.equal(braxProvisionReserve(warrior,'herb'),0);assert.equal(braxProvisionReserve(c,'herb'),20);assert.equal(braxProvisionReserve(warrior,'herb',{carryFloors:{herb:12}}),12);assert.equal(braxCourierTarget('herb',10,80,6),16);
// Captured first load: the cooking runner received19herbs and incorrectly
// hoarded all of it behind a hard-coded20herb healer reserve.
const reserveTransfers=[],reserveService=new BraxSupplyService({actors:[{shadow_account:'r',role:'farmer',...cook},{shadow_account:'f',role:'farmer',...c}],runner:'r',couriers:['a','b'],call(){},runLeg(){},read:async()=>({room:{num:827},hp:{value:70,max:70},equipment_items:[],autopilot_status:{loadout_retention:{carry_floors:{herb:6}}}})});
reserveService.pack=async agent=>({items:agent==='r'?[{id:42,name:'herb',amount:19}]:[{id:43,name:'hammer',amount:0},{id:44,name:'loaf of bread',amount:6}]});reserveService.makeDeliveryRoom=async()=>{};reserveService.transfer=async(from,to,item,n)=>{reserveTransfers.push({from,to,item:item.name,n});return{quantity:n};};await reserveService.deliverLocal();assert.deepEqual(reserveTransfers,[{from:'r',to:'f',item:'herb',n:13}]);
console.log('PASS cooking runner distributes13of19herbs while retainingits6, healer retains20, noncasters do not hoard unusable medicine, explicit source floors win');

// Captured phase gap: lower-first loading fills upper, then upper exports loot,
// but the old code left without loading into the newly freed space.
const {weighItem}=await import('./m59-items.mjs');
const loads={r:{weight:56,bulk:56},a:{weight:1,bulk:1}},rooms={r:827,a:578};
const packs={r:[{id:90,name:'diamond',amount:30}],a:[{id:91,name:'hammer',amount:0},{id:92,name:'hammer',amount:0},{id:93,name:'herb',amount:30}]},accepted=[],localOrder=[];
const reload=new BraxSupplyService({actors:[...actors,{shadow_account:'a',role:'courier',abilities:{spells:[]}}],runner:'r',couriers:['a','b'],farmRunner:false,
 read:async agent=>({room:{num:rooms[agent]},you:{x:100,y:100},equipment_items:agent==='a'?[{id:91}]:[],carry:{known:true,load:{exact:true},room_for:{...loads[agent]}}}),
 call:async(name,args)=>{if(name==='inventory')return{items:packs[args.agent].map(i=>({...i}))};assert.equal(name,'supply');const row=args.what[0],item=packs[args.from].find(i=>i.id===row.id),unit=weighItem(item.name),n=row.amount;assert(item);assert(n<=(item.amount>0?item.amount:1));accepted.push({from:args.from,item:item.name,n});
 item.amount-=n;if(item.amount<=0)packs[args.from]=packs[args.from].filter(i=>i!==item);const recipient=packs[args.to].find(i=>i.name===item.name);if(recipient)recipient.amount+=n;else packs[args.to].push({id:args.to==='r'?200:201,name:item.name,amount:n});
 for(const key of ['weight','bulk']){loads[args.from][key]+=unit[key]*n;loads[args.to][key]-=unit[key]*n;}return{supplied:true,amounts:[{asked:n,giver_lost:n,received:n}]};},
 runLeg:async(agent,role,direction)=>{rooms[agent]=role==='farmer'?(direction==='out'?578:827):350;}});
reload.waitExchangeReady=async()=>{};reload.needs=async()=>[{needs:{herb:30,hammer:0}}];reload.runnerMode=async()=>{};reload.collectLocal=async()=>localOrder.push('collect');reload.deliverLocal=async()=>localOrder.push('deliver');
await reload.exchange('a');assert.deepEqual(localOrder.slice(0,2),['deliver','collect']);assert.deepEqual(accepted,[{from:'a',item:'herb',n:10},{from:'r',item:'diamond',n:5},{from:'a',item:'herb',n:1}]);assert.equal(packs.r.find(i=>i.name==='herb').amount,11);assert.equal(packs.a.find(i=>i.name==='herb').amount,19);
console.log('PASS real exchange sends medicine before spare weapons, distributes before collecting, then reloads only fresh remaining cargo after verified exports free space');

// Native qualification sold seven delivery hammers despite keep:['hammer']:
// the copied source loadout ceiling outranks keep. Native keeper skip_names is
// applied to planned names before offers, without ignoring the rest of loadout.
let saleArgs;const cargoSale=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],read(){},runLeg(){},call:async(name,args)=>{assert.equal(name,'sell_all');saleArgs=args;return{sold:[]};}});
cargoSale.townTravel=async()=>{};cargoSale.pack=async()=>({items:[]});await cargoSale.sell('a',374,'Quintor');
for(const cargo of ['hammer','herb','herbs','elderberry','loaf of bread'])assert(saleArgs.skip_names.includes(cargo));assert.notEqual(saleArgs.ignore_loadout,true,'source gear/floors remain active');assert.equal(saleArgs.max_weapons,1,'other spare weapons remain sale cargo');
console.log('PASS source sale ceilings cannot resell courier provision names; other loadout and equipment protections remain active');

// A native refusal is stronger evidence than an apparently sufficient model.
// The same unchanged pack cannot repeat; verified loot export changes it first.
let receiverFree={weight:100,bulk:100},diamonds=200,attempts=0;const repaired=[];
const adaptive=new BraxSupplyService({actors:[...actors,{shadow_account:'f',role:'farmer'}],runner:'r',couriers:['a','b'],runLeg(){},
 read:async agent=>({room:{num:827},equipment_items:[],autopilot_status:{policy:{},loadout_retention:{carry_floors:{}}},carry:{known:true,load:{exact:true},room_for:agent==='f'?{...receiverFree}:{weight:2000,bulk:2000}}}),
 call:async(name,args)=>{if(name==='inventory')return{items:args.agent==='a'?[{id:500,name:'hammer',amount:0}]:args.agent==='f'?[{id:501,name:'diamond',amount:diamonds}]:[]};
  assert.equal(name,'supply');if(args.from==='f'){const n=args.what[0].amount;diamonds-=n;receiverFree.weight+=n;receiverFree.bulk+=n;repaired.push(n);return{supplied:true,amounts:[{asked:n,received:n,giver_lost:n}]};}
  if(++attempts===1)return{supplied:false,partial:false,reason_code:'receiver_full',amounts:[],not_received:[{received:0,giver_lost:0}]};
  assert.equal(repaired.length,1);return{supplied:true,amounts:[{asked:1,received:1,giver_lost:1}]};}});
assert((await adaptive.transfer('a','f',{id:500,name:'hammer'},1)).deferred);assert((await adaptive.transfer('a','f',{id:500,name:'hammer'},1)).deferred);assert.equal(attempts,1);
await adaptive.makeDeliveryRoom({shadow_account:'f'},'hammer');assert.deepEqual(repaired,[80]);assert.equal((await adaptive.transfer('a','f',{id:500,name:'hammer'},1)).quantity,1);assert.equal(attempts,2);
console.log('PASS a proved capacity refusal forces extra ordinary loot export despite adequate estimates; only the changed pack permits a fresh gift');

// Essential arms outrank optional pool supplies while any farmer is unarmed.
// Once armed, only one upper spare is wanted, not the courier's whole pack.
accepted.length=0;localOrder.length=0;loads.r={weight:200,bulk:200};loads.a={weight:1,bulk:1};rooms.r=827;rooms.a=578;
packs.r=[{id:90,name:'diamond',amount:30}];packs.a=[{id:91,name:'hammer',amount:0},{id:92,name:'hammer',amount:0},{id:94,name:'hammer',amount:0},{id:93,name:'herb',amount:30}];
reload.needs=async()=>[{needs:{hammer:2,herb:30}}];await reload.exchange('a');assert.deepEqual(accepted[0],{from:'a',item:'hammer',n:1});assert.deepEqual(accepted[1],{from:'a',item:'hammer',n:1});
accepted.length=0;loads.r={weight:1000,bulk:1000};loads.a={weight:1000,bulk:1000};rooms.r=827;rooms.a=578;packs.r=[{id:99,name:'hammer',amount:2}];packs.a=[{id:91,name:'hammer',amount:4}];reload.needs=async()=>[{needs:{hammer:0,herb:0}}];await reload.exchange('a');assert(!accepted.some(x=>x.item==='hammer'),'one upper personal hammer plus a spare already satisfies buffer');
console.log('PASS unarmed farmer demand loads hammers before optional medicine; already stocked upper runner does not hoard courier spares');

const cashOnlyTransfers=[],cashOnly=new BraxSupplyService({actors:[...actors,{shadow_account:'f',role:'farmer'}],runner:'r',couriers:['a','b'],call(){},runLeg(){},read:async()=>({room:{num:827},hp:{value:70,max:70},equipment_items:[],autopilot_status:{policy:{}}})});
cashOnly.pack=async agent=>({items:agent==='r'?[]:[{id:600,name:'shilling',amount:2500},{id:601,name:'diamond',amount:100}]});cashOnly.transfer=async(from,to,item,n)=>{cashOnlyTransfers.push({from,to,item:item.name,n});return{quantity:n};};await cashOnly.collectLocal({cargo:false});assert.deepEqual(cashOnlyTransfers,[{from:'f',to:'r',item:'shilling',n:1500}]);
const collectionOptions=[];reload.collectLocal=async options=>collectionOptions.push(options);reload.needs=async()=>[{needs:{hammer:1}}];rooms.r=827;rooms.a=578;packs.r=[];packs.a=[];await reload.exchange('a');assert.equal(collectionOptions[0].cargo,false);
console.log('PASS unmet provisions preserve upper pack headroom; ordinary cash collection still funds deliveries without hauling new heavy loot');

// Captured native47/82 courier: no offer while hurt or while recovery is moving.
// A completed older approach may be resumed only after native quiet readiness.
let readyClock=0,readyReads=0;const reapproaches=[],readinessEvents=[];
const readiness=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call(){},wait:async ms=>{readyClock+=ms;},phase:async()=>{},emit:async e=>readinessEvents.push(e),
 read:async agent=>{if(agent==='a')readyReads++;const recovering=agent==='a'&&readyReads<3;return{pid:agent==='a'?2:1,character:agent,in_game:true,connected:true,hp:{value:recovering?47:82,max:82},room:{num:578},you:agent==='r'?{x:2352,y:2208}:readyReads<4?{x:2180,y:2208}:{x:2256,y:2208},movement:{order:recovering?{kind:'shelter'}:null},autopilot_status:{faculties:{work:'keeper'}}};},
 runLeg:async(agent,role,direction)=>reapproaches.push({agent,role,direction})});
await readiness.waitExchangeReady('a',{now:()=>readyClock,timeoutMs:10000});assert.equal(reapproaches.length,1);assert.deepEqual(reapproaches[0],{agent:'a',role:'courier',direction:'out'});assert(readyClock>=2000);assert(readinessEvents.some(e=>e.kind==='exchange-native-ready'));
readiness.stopped=true;await assert.rejects(readiness.waitExchangeReady('a'),/service stopped/);assert.equal(reapproaches.length,1);
console.log('PASS hurt courier waits for native protected recovery, then only a released known-ended approach resumes; stop prevents new work');
// Lower approach and upper preparation overlap, but the exclusive lane remains
// held until both approaches are confirmed. An early lower failure is observed.
let releaseLower,upperEntered=false;const lowerPending=new Promise(r=>releaseLower=r),parallel=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call(){},farmRunner:false,read:async agent=>({room:{num:agent==='r'?827:350},you:{x:0,y:0},carry:{room_for:{weight:1000,bulk:1000}},equipment_items:[]}),runLeg:async(agent,role,direction)=>{if(agent==='r'&&direction==='out'){upperEntered=true;releaseLower();}}});parallel.runnerMode=parallel.collectLocal=parallel.deliverLocal=parallel.waitExchangeReady=async()=>{};parallel.needs=async()=>[];parallel.pack=async()=>({items:[]});await parallel.exchange('a',{lowerOut:lowerPending});assert(upperEntered);
console.log('PASS upper approach proceeds concurrently with the existing lower approach, without issuing a duplicate lower trip');

let otherApproachEnded=false;parallel.runLeg=async(agent,role,direction)=>{if(role==='farmer'&&direction==='out'){await new Promise(r=>setTimeout(r,10));otherApproachEnded=true;}};const rejectedApproach=Promise.reject(Error('lower approach failed'));rejectedApproach.catch(()=>{});await assert.rejects(parallel.exchange('a',{lowerOut:rejectedApproach}),/lower approach failed/);assert(otherApproachEnded,'cleanup cannot abandon the other accepted approach');
console.log('PASS one approach failure observes the other accepted approach to completion before failure cleanup');

let presendCalls=0;const presend=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],runLeg(){},read:async()=>({carry:{known:true,load:{exact:true},room_for:{weight:1000,bulk:1000}}}),call:async name=>{if(name==='inventory')return{items:[{id:700,name:'hammer',amount:0}]};presendCalls++;return{supplied:false,reason:'native offer submission refused',submission:{error:'stationary exchange expired or preempted by survival'}};}});
const unsent=await presend.transfer('a','r',{id:700,name:'hammer'},1);assert(unsent.unsubmitted&&unsent.deferred);await presend.transfer('a','r',{id:700,name:'hammer'},1);assert.equal(presendCalls,1,'cooldown cannot blindly resubmit the old packet');
presend.notReadyUntil.clear();presend.call=async name=>name==='inventory'?{items:[{id:700,name:'hammer',amount:0}]}:{supplied:false,reason:'native offer submission refused',submission:{error:'transport timed out'}};await assert.rejects(presend.transfer('a','r',{id:700,name:'hammer'},1),/not verified/);
console.log('PASS exact native pre-send stationary guard defers with no offer; generic transport failure remains ambiguous and fatal');

// The courier must remain in Jasper while upper distribution is still running.
// Only the independent physical approaches start together after that work ends.
let upperPrepared=false,lowerDepartures=0;parallel.procure=async()=>{};parallel.collectLocal=async()=>{await new Promise(r=>setTimeout(r,5));upperPrepared=true;};parallel.runLeg=async(agent,role,direction)=>{if(role==='courier'&&direction==='out'){assert(upperPrepared,'lower waits in town for upper local preparation');lowerDepartures++;}};
await parallel.worker('a',{maxCycles:1});assert.equal(lowerDepartures,1);
console.log('PASS lower courier stays in town during upper local preparation, then departs exactly once concurrently with upper travel');

const afterStopLegs=[];parallel.stopped=false;parallel.collectLocal=async()=>parallel.stop();parallel.runLeg=async(...args)=>afterStopLegs.push(args);await assert.rejects(parallel.worker('a',{maxCycles:1}),/service stopped/);assert.equal(afterStopLegs.length,0);
console.log('PASS a stop during upper local preparation cannot dispatch either new approach after the measured window');

// Native idle restBelow=.6 leaves75/88 belowtrade90% with no recovery active.
// An explicit ordinary safe-rest callback closes that deadband without changing policy.
let healthGoalCalls=0;const deadband=new BraxSupplyService({actors,runner:'r',couriers:['a','b'],call(){},runLeg:async()=>{},wait:async()=>{},read:async agent=>({pid:agent==='a'?2:1,character:agent,in_game:true,connected:true,hp:{value:agent==='a'&&!healthGoalCalls?75:88,max:88},room:{num:578},you:{x:agent==='a'?2256:2352,y:2208},job:null,movement:{order:null},autopilot_status:{faculties:{work:'keeper'},policy:{restBelow:.6}}}),recover:async(agent,goal)=>{assert.equal(agent,'a');assert.equal(goal.health,1);healthGoalCalls++;}});
await deadband.waitExchangeReady('a');assert.equal(healthGoalCalls,1);
const {script:restScript}=await import('./fleetscripts/brax-service-rest.mjs'),{script:legScript}=await import('./fleetscripts/brax-ledge-leg.mjs');const recoverSteps=await restScript.steps({health:1});assert.equal(recoverSteps[0].do,'rest');assert.equal(recoverSteps[0].health,1);assert.equal(recoverSteps[0].unsafe,undefined);assert.equal((await legScript.steps({role:'courier',direction:'out',minHealth:.9}))[0].health,.9);
console.log('PASS explicit guarded service health goal closes the90%-trade/60%-idle deadband; public ledge minHealth is actually enforced');

// A running ArcherPlus owns its receiver: the upper runner cannot collect from,
// deliver to, or floor-cache on behalf of that actor. Its task pulls supplies.
const leasedActors=[...actors,{shadow_account:'bowman',role:'farmer',archery:{bow:'practice bow',arrows:160}}];
const leased=new BraxSupplyService({actors:leasedActors,runner:'r',couriers:['a','b'],call(){},runLeg(){},
 read:async()=>({in_game:true,connected:true,room:{num:827},hp:{value:70,max:70},equipment_items:[],autopilot_status:{policy:{},loadout_retention:{carry_floors:{}}}}),
 cacheDelivery:async()=>{throw Error('leased archer cannot receive runner cache');}});
leased.pack=async agent=>({items:agent==='r'?[{id:910,name:'herb',amount:100}]:[{id:911,name:'shilling',amount:5000}]});
leased.makeDeliveryRoom=leased.transfer=async()=>{throw Error('leased archer cannot be commandeered');};
await leased.deliverLocal();await leased.collectLocal();assert.equal((await leased.needs()).find(r=>r.agent==='bowman').needs.arrows,160);
// Import silver arrows across the actual exchange in the existing capacity fixture.
accepted.length=0;loads.r={weight:1000,bulk:1000};loads.a={weight:1000,bulk:1000};rooms.r=827;rooms.a=578;
packs.r=[];packs.a=[{id:920,name:'silver arrows',amount:60}];reload.needs=async()=>[{needs:{arrows:160}}];
await reload.exchange('a');assert(accepted.some(i=>i.from==='a'&&i.item==='silver arrows'&&i.n===60));
assert.equal(packs.r.find(i=>i.name==='silver arrows').amount,60);
console.log('PASS imported silver arrows cross the ordinary ledge exchange; leased archers request their own stock instead of being commandeered');
