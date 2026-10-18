import assert from'node:assert/strict';import{deathLocationFromSessions as locate}from'./m59-death-location.mjs';
const at=10000,e=(room,kind='stat',time=9999)=>({room,kind,name:'health',value:0,at:time,position:{row:3,col:7},text:'You are dead, poor soul.  Go now, and take revenge on the zombie!'}),wrap=events=>({sessions:[{id:'second-socket',events}]});
assert.equal(locate(wrap([e(827)]),{at}).num,827);
assert.equal(locate(wrap([e(39,'message')]),{at}).num,39);
assert.equal(locate(wrap([e(1)]),{at}),null);
assert.equal(locate(wrap([e(827,'stat',1000)]),{at}),null);
assert.equal(locate(wrap([e(827),e(39)]),{at}),null);
assert.equal(locate(wrap([{...e(827),kind:'connection',phase:'closed',value:12}]),{at}),null);
assert.equal(locate(wrap([e(827),e(1,'message',10001)]),{at}).session_id,'second-socket');
console.log('7 socket death-location cases pass: fatal/personal evidence, no offline guesses, no Underworld attribution, conflicts refuse');

{const{Autopilot}=await import('./m59-autopilot.mjs');const time=Date.now(),evidence={sessions:[{id:'logged-on-to-die',events:[{kind:'stat',name:'health',value:0,at:time-20,room:39,position:{row:14,col:15}}]}]};const pilot={s:{name:'Offline Death Fixture',client:{me:{name:'Offline Death Fixture'}},sessionEvidence:{snapshot:()=>evidence}},policy:{},recent5:[],journal:[],healthRate:()=>null,recentText:()=>[]};const pm=Autopilot.prototype.postMortem.call(pilot);assert.equal(pm.where.num,39);assert.equal(pm.where.source,'socket_fatal_health');assert.equal(pm.where.session_id,'logged-on-to-die');assert.equal(pm.vitals.last_health,null);assert.equal(pm.frames.length,0);console.log('real frame-less keeper postmortem uses fatal own-socket location while retaining unknown frame vitals');}

assert.equal(locate({sessions:[{id:'bounded-fatal-anchor',events:[],fatalEvidence:[e(827)]}]},{at}).session_id,'bounded-fatal-anchor');
