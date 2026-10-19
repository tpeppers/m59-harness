import assert from'node:assert/strict';import{BraxSupplyService,braxNeeds,braxCourierTarget}from'./m59-brax-supply.mjs';import{trustedBuyer}from'./m59-skills.mjs';
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
