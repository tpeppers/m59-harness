import assert from 'node:assert/strict';
import {travelMetrics} from './m59-guild-defense-metrics.mjs';
const fixture=n=>({completed:true,validation:{status:'exploratory'},runs:[{team_experiment:{
  events:[...Array.from({length:4},(_,i)=>({kind:'response_order',actor:String(i),ms:0})),
    ...Array.from({length:n},(_,i)=>({kind:'hall_foyer_arrival',actor:String(i),ms:(i+1)*1000}))],trace:[]}}]});
assert.equal(travelMetrics(fixture(1)).successful_only_p50_ms,1000);
assert.equal(travelMetrics(fixture(1)).fleet_p50_ms,null);
assert.equal(travelMetrics(fixture(2)).fleet_p50_ms,null);
assert.equal(travelMetrics(fixture(3)).fleet_p50_ms,2500);
const r=fixture(3);r.runs[0].team_experiment.events.push({kind:'rescue_waiting',actor:'0'});
assert.equal(travelMetrics(r).road_responders,3);
assert.equal(travelMetrics(r).road_arrived,2);
assert.equal(travelMetrics(r).fleet_p50_ms,3000);
r.completed=false;assert.equal(travelMetrics(r).valid,false);
console.log('Travel metrics: missing arrivals, middle ranks, Rescue exclusion and validity passed');
