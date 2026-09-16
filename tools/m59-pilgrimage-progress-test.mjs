import assert from 'node:assert/strict';
import { PilgrimageProgress, progressFromObservations } from './m59-pilgrimage-progress.mjs';
const make = () => new PilgrimageProgress({ stallMs: 100, legStallMs: 300, staleMs: 50 });
const row = (room=108, hp=20, extra={}) => ({ agent:'tour01',character:'Aaaa',room_num:room,health:`${hp}/50`,...extra });
const sample = (t, now, r=row(), options={}) => t.observe(r,{now,...options});
let t=make(); sample(t,0); sample(t,100);
assert.equal(t.snapshot(100).stuck_count,1,'one stalled actor is counted without a fleet-wide failure');
sample(t,120); assert.equal(t.snapshot(120).stuck_episodes,1,'repeated flags are one episode');
sample(t,130,row(109)); assert.equal(t.snapshot(130).stuck_count,0);
assert.equal(t.snapshot(130).ever_stuck_count,1,'resolved stalls remain in history');
t=make(); sample(t,0); sample(t,90,row(109)); sample(t,180,row(108)); sample(t,210,row(109));
assert.equal(t.snapshot(210).stuck_count,1,'oscillating between old rooms cannot reset progress forever');
t=make(); sample(t,0); sample(t,90,row(108,21)); sample(t,150,row(108,22));
assert.equal(t.snapshot(150).stuck_count,0,'actual healing gets a grace period');
sample(t,250,row(108,23)); sample(t,310,row(108,24));
assert.equal(t.snapshot(310).actors[0].reason,'checkpoint_overdue','recovery loops still get flagged');
t=make(); sample(t,0,row(108,20,{position:{row:1,col:1}})); sample(t,90,row(108,20,{position:{row:1,col:2}}));
sample(t,150,row(108,20,{position:{row:1,col:3}})); assert.equal(t.snapshot(150).stuck_count,0,'new squares are progress');
sample(t,260,row(108,20,{position:{row:1,col:2}})); assert.equal(t.snapshot(260).stuck_count,1,'revisited squares do not count as progress');
sample(t,270,row(),{checkpoints:1}); assert.equal(t.snapshot(270).stuck_count,0,'a completed leg resets the progress window');
t=make(); sample(t,0); assert.equal(t.snapshot(100).unknown_count,1);
assert.equal(t.snapshot(100).stuck_count,0,'missing telemetry is not a fabricated stall');
sample(t,100,{agent:'tour01',error:'timeout'});assert.equal(t.snapshot(100).unknown_count,1);
sample(t,110,{agent:'tour01',in_game:false});assert.equal(t.snapshot(110).actors[0].reason,'offline_without_progress');
sample(t,120,row(),{done:true});assert.equal(t.snapshot(120).stuck_count,0,'a completed one-pass actor is not stuck');
assert.throws(()=>new PilgrimageProgress({stallMs:NaN}));
assert.equal(t.snapshot(1000).unknown_count,0,'finished actors never become missing telemetry');

t=make(); t.expect('tour02',0); sample(t,0); sample(t,100);
assert.equal(t.snapshot(100).stuck_count,1);
assert.equal(t.snapshot(100).unknown_count,1,'one missing bot does not hide another stalled bot');
const audited = progressFromObservations({start:0,end:150,agents:['tour01'],
  options:{stallMs:100,legStallMs:300,staleMs:50},
  observations:[{at:0,rows:[row()]},{at:100,rows:[row()]},{at:150,rows:[row()]}],
  arrivals:[{t:140,character:'Aaaa'},{t:200,character:'Aaaa'}]});
assert.equal(audited.ever_stuck_count,1,'a future arrival cannot erase an earlier stall');
assert.equal(audited.stuck_count,0,'the receipt resets the current leg');
assert.equal(audited.actors[0].checkpoints,1,'receipts after the audit window are excluded');
console.log('pilgrimage progress: individual stalls, healing, oscillation, telemetry and historical joins passed');
