import assert from 'node:assert/strict';
import {test} from 'node:test';
import {percentile,summarizeTour} from './m59-pilgrimage-report.mjs';
test('nearest-rank tail keeps the outlier and does not mutate evidence',()=>{
 const x=[1000,10,20,30,40,50,60,70,80,90];assert.equal(percentile(x,.9),90);assert.equal(percentile(x,.95),1000);
 assert.equal(x[0],1000);assert.equal(percentile([], .9),null);
});
test('unfinished and refused journeys remain in the tail with honest censoring',()=>{
 const r={schema:'m59-pilgrimage-result/v1',measurement_began_at:1000,finished_at:11000,ring:[{room:1},{room:2}],results:[
 {agent:'a',inn:1,legFrom:2,to:1,legBegan:10000,outcome:'cycling',deaths:1,deathsAtLegStart:1,legs:[{from:1,to:2,ms:1000,deaths:1}]},
 {agent:'b',inn:1,to:2,legBegan:1000,outcome:'refused',deaths:2,legs:[]}]};
 const s=summarizeTour(r);assert.equal(s.completed_legs,1);assert.equal(s.polled_deaths,3);assert.equal(s.unfinished,2);
 assert.equal(s.completed.p90_ms,1000);assert.equal(s.all_attempts_p90_lower_bound_ms,10000);
 assert.equal(s.unfinished_older_than_completed_p90,1);assert.equal(s.oldest_unfinished[0].agent,'b');
 assert.equal(s.pairs.find(p=>p.pair==='1>2').unfinished,1);assert.equal(s.actors_with_arrivals,1);
 assert.deepEqual(r.results[0].legs,[{from:1,to:2,ms:1000,deaths:1}]);
});
test('completed one-pass arrivals do not acquire a fabricated unfinished leg',()=>{
 const s=summarizeTour({schema:'m59-pilgrimage-result/v1',measurement_began_at:0,finished_at:5000,ring:[1],results:[
 {agent:'a',inn:1,to:2,legBegan:0,outcome:'arrived',legs:[{from:1,to:2,ms:2000}]}]});
 assert.equal(s.unfinished,0);assert.equal(s.completed_full_circuits,1);
});

test('refused dispatches stop aging at refusal and missing leg clocks stay unknown',()=>{
 const s=summarizeTour({schema:'m59-pilgrimage-result/v1',measurement_began_at:0,finished_at:90000,ring:[1],results:[
 {agent:'a',began:0,ms:5000,inn:1,to:2,legBegan:1000,outcome:'refused',legs:[]},
 {agent:'b',inn:1,to:2,legBegan:null,outcome:'cycling',legs:[]}]});
 assert.equal(s.unfinished,1);assert.equal(s.failed_dispatches,1);assert.equal(s.oldest_unfinished[0].ms,4000);
});
