import assert from'node:assert/strict';import{braxTrialObservation,braxTrialStages}from'./m59-brax-trial-observation.mjs';
const at=1000,agents=['head','follower','failed'],eventsByAgent={head:[{at:1100,event:'admitted',batch:'lift'},{at:1200,event:'aboard',batch:'lift'},{at:1400,event:'lift-raised',batch:'lift',raisedAt:1400},{at:1800,event:'lift-validated',batch:'lift',raisedAt:1400,observed:{3:800,4:510}},{at:2000,event:'objective',success:true,room:{num:827},hp:{value:1}}],follower:[{at:1150,event:'admitted',batch:'lift'},{at:1250,event:'aboard',batch:'lift'},{at:1801,event:'lift-validated',batch:'lift',raisedAt:1400,observed:{3:800,4:510}},{at:2100,event:'objective',success:true,room:{num:827},hp:{value:20}},{at:2200,event:'objective',success:true,room:{num:827},hp:{value:20}}],failed:[{at:1160,event:'admitted',batch:'lift'},{at:1260,event:'failure',reason:'jump failed'}]};
let r=braxTrialObservation({agents,startedAt:at,controllerStartedAt:500,eventsByAgent});assert.equal(r.arrivalCount,2);assert.equal(r.p90Ms,null);assert.equal(r.arrivedSubsetP90Ms,1100);assert.equal(r.liftTrips,1);assert.deepEqual(r.lifts[0].admitted,agents);assert.deepEqual(r.lifts[0].boardedBeforeLaunch,['head','follower']);assert.deepEqual(r.lifts[0].heightValidated,['head','follower']);assert.deepEqual(r.holdouts,['failed']);
eventsByAgent.failed=[{at:1160,event:'admitted',batch:'lift'},{at:1200,event:'aboard',batch:'lift'},{at:1300,event:'failure',reason:'died before launch'},{at:2300,event:'objective',success:true,room:{num:827},hp:{value:20}}];r=braxTrialObservation({agents,startedAt:at,controllerStartedAt:500,eventsByAgent});assert(r.allArrived);assert.equal(r.p90Ms,1300);assert.equal(r.orderToArrivalP90Ms,1800);assert.equal(r.preparationMs,500);assert(!r.lifts[0].boardedBeforeLaunch.includes('failed'),'aboard then failed before launch is not counted as a rider');
eventsByAgent.failed=[{at:900,event:'objective',success:true,room:{num:827},hp:{value:20}},{at:2300,event:'objective',success:true,room:{num:827},hp:{value:0}}];assert.equal(braxTrialObservation({agents,startedAt:at,eventsByAgent}).arrivalCount,2);
eventsByAgent.failed=[{at:1160,event:'admitted',batch:'lift'},{at:1800,event:'lift-validated',batch:'lift',raisedAt:1400,observed:{3:800,4:510}}];assert(!braxTrialObservation({agents,startedAt:at,eventsByAgent}).lifts[0].heightValidated.includes('failed'),'validation without prior boarding is not a verified ride');
console.log('admissions, positive boarding, personal validated rides and failures remain distinct; partial or duplicate arrivals cannot fabricate full-roster p90; preparation remains in the order-to-arrival clock');

eventsByAgent.failed=[{at:2300,event:'objective',success:true,room:{num:827},hp:{value:20}}];
r=braxTrialObservation({agents,startedAt:at,endedAt:2200,eventsByAgent});assert.equal(r.arrivalCount,2,'a later retry or another run cannot repair this completed failed trial');
r=braxTrialObservation({agents,startedAt:at,endedAt:2400,results:{head:{ok:true},follower:{ok:true},failed:{ok:false,why:'later control failure'}},eventsByAgent});assert(r.allArrived);assert.equal(r.qualified,false,'positive arrivals and per-actor operation outcomes remain distinct');assert.equal(r.resultFailures[0].reason,'later control failure');
console.log('completed trial end fences exclude later retries; aggregate dispatch success never overrides individual failed outcomes');

const stageEvents={one:[
 {at:900,event:'queued-entry',to:579,reply:{arrived:true}},
 {at:1100,event:'queued-city-exit',from:2,to:599,reply:{arrived:true}},
 {at:1200,event:'queued-entry',to:579,reply:{arrived:true}},
 {at:1300,event:'south-queue-ready'},
 {at:1400,event:'aboard',batch:'trip'},
 {at:1800,event:'lift-validated',batch:'foreign',raisedAt:1500,observed:{3:800,4:510}},
 {at:1900,event:'lift-validated',batch:'trip',raisedAt:1500,observed:{3:800,4:510}},
 {at:2000,event:'landing',floor_client:4000},
 {at:2100,event:'landing',floor_client:8160},
 {at:2200,event:'north-egress',reply:{arrived:true}},
 {at:2300,event:'queued-onward',to:826,reply:{arrived:true}},
 {at:2400,event:'objective',success:true,room:{num:827},hp:{value:1}},
 {at:3100,event:'objective',success:true,room:{num:827},hp:{value:1}}
],two:[{at:1100,event:'queued-city-exit',from:2,to:599,reply:{arrived:false}}]};
const stages=braxTrialStages({agents:['one','two'],startedAt:1000,endedAt:2500,eventsByAgent:stageEvents});
assert.equal(stages.actors[0].milestonesMs.ancient_entry,200);
assert.equal(stages.actors[0].milestonesMs.launch,500);
assert.equal(stages.actors[0].milestonesMs.north_landing,1100);
assert.equal(stages.actors[0].intervals.launch_to_height_validated,400);
assert.equal(stages.actors[1].milestonesMs.city_out,null);
assert.equal(stages.intervals.caverns_entry_to_graveyard.observed,1);
assert.equal(stages.intervals.caverns_entry_to_graveyard.expected,2);
assert.equal(stages.intervals.caverns_entry_to_graveyard.allObserved,false);
assert.equal(stages.intervals.caverns_entry_to_graveyard.observedSubsetP90Ms,100);
assert.equal(braxTrialStages({agents:['one'],startedAt:1000,endedAt:2350,eventsByAgent:stageEvents}).actors[0].milestonesMs.graveyard,null);
console.log('route stage intervals use positive, matching-trip, time-fenced receipts; missing intervals and observed-subset percentiles stay explicit');
