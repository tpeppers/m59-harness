import assert from 'node:assert/strict';
import fs from 'node:fs';
import {BP,M59Client} from './m59-client.mjs';
import {roomGeometry} from './m59-ground.mjs';
import {movementRegionSpec,regionContains,guardRegionPacket} from './m59-movement-region.mjs';
import {holdStationaryTrade,stationaryTradeActive,requireStationaryTrade,observeStationaryMutation,releaseStationaryTrade} from './m59-stationary-trade.mjs';
const map=JSON.parse(fs.readFileSync(new URL('../substrate/m59-map.json',import.meta.url))),geo=roomGeometry(578);
const upper={x:2352,y:2208},lower={x:2256,y:2208};
const lock=movementRegionSpec({version:1,id:'upper',rooms:[578,826,827],anchors:{578:upper}});
assert.throws(()=>movementRegionSpec({version:1,id:'bad',rooms:[578.5]}));
assert.throws(()=>movementRegionSpec({...lock,typo:true}));
assert(regionContains(geo,upper,upper));assert(!regionContains(geo,upper,lower));
assert(regionContains(geo,lower,lower));assert(!regionContains(geo,lower,upper));
let wire=0,hp=100;const c={state:'game',combatReady:true,self:{...upper,row:34,col:36},room:{id:578},seeds:null,sock:{write(){wire++;}},_outboundActivity(){},vitals:()=>({health:{value:hp,max:100}}),spells:[{id:1,name:'blink'},{id:2,name:'minor heal'}],inventory:[{id:3,name:'hammer'}]};
const s={client:c,world:{room:map.rooms[578],geometry:geo,exits:()=>[{kind:'go',to:579,stand_on:{row:34,col:36}}]}};
c.beforeGameMutation=(op,parts)=>guardRegionPacket(s,lock,op,parts);
const u16=n=>{const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;},u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const send=(op,...parts)=>M59Client.prototype.send.call(c,op,...parts);
assert.throws(()=>send(BP.REQ_MOVE,u16(lower.y),u16(lower.x),Buffer.from([18]),u32(578)),/returnable component/);assert.equal(wire,0);
send(BP.REQ_MOVE,u16(upper.y),u16(upper.x+1),Buffer.from([18]),u32(578));assert.equal(wire,1);
assert.throws(()=>send(BP.REQ_GO),/go destination/);assert.throws(()=>send(BP.REQ_CAST,u32(1)),/transport/);
send(BP.REQ_CAST,u32(2));send(BP.REQ_INVENTORY);send(BP.REQ_USE,u32(3));assert.equal(wire,4);
// Unknown location and a reconnect on the other side fail closed.
c.self=null;assert.throws(()=>send(BP.REQ_MOVE,u16(upper.y),u16(upper.x)),/position unknown/);
c.self={...lower};assert.throws(()=>send(BP.REQ_MOVE,u16(upper.y),u16(upper.x)),/outside permitted component/);
s.world.room={num:50};send(BP.REQ_CAST,u32(2));assert.throws(()=>send(BP.REQ_MOVE,u16(100),u16(100)),/outside permitted rooms/);
s.world.room={num:1};send(BP.REQ_MOVE,u16(100),u16(100));
// A separate stationary lease suppresses work only; survival packets invalidate it.
s.world.room=map.rooms[578];c.self={...upper};const h=holdStationaryTrade(s,'unit exchange',20000);assert(h.held);assert(stationaryTradeActive(s));
assert(!holdStationaryTrade(s,'someone else',20000).held);requireStationaryTrade(s,h.hold.token);
hp=99;assert(!stationaryTradeActive(s));assert.throws(()=>requireStationaryTrade(s,h.hold.token),/preempted/);hp=100;
assert(releaseStationaryTrade(s,h.hold.token).released);const h2=holdStationaryTrade(s,'second',20000);assert(h2.held);observeStationaryMutation(s,BP.REQ_MOVE);assert(!stationaryTradeActive(s));assert.throws(()=>requireStationaryTrade(s,h2.hold.token),/preempted/);
assert(!releaseStationaryTrade(s,'wrong').released);assert(releaseStationaryTrade(s,h2.hold.token).released);
console.log('PASS native Cragged components, direct wire falls/exits/transports, unknown/reconnect quarantine, Underworld escape and survival-preemptible stationary ownership');

// A timed-out ordinary rung retains its own stage through the real authority binding.
const {withBodyStage,withRecoveryCommand,bodyAuthority}=await import('./m59-body-command.mjs');
const pendingWork=withBodyStage(s,'passErrand',()=>bodyAuthority(s).bind(()=>observeStationaryMutation(s,BP.REQ_MOVE)));
const h3=holdStationaryTrade(s,'stale errand fence',20000);assert(h3.held);assert.throws(pendingWork,e=>e.code==='STATIONARY_WORK_HELD');assert(stationaryTradeActive(s),'ordinary delayed work must not destroy the trade lease');
withBodyStage(s,'passFleeAndRest',()=>observeStationaryMutation(s,BP.REQ_MOVE));assert(!stationaryTradeActive(s),'actual survival may still move and preempt');assert(releaseStationaryTrade(s,h3.hold.token).released);
const h4=holdStationaryTrade(s,'priority recovery',20000);assert(h4.held);withBodyStage(s,'passErrand',()=>withRecoveryCommand(s,()=>observeStationaryMutation(s,BP.REQ_CAST)));assert(!stationaryTradeActive(s),'protected priority recovery keeps its send authority');assert(releaseStationaryTrade(s,h4.hold.token).released);
console.log('PASS paced stale errand stage cannot cancel stationary trade; protected survival/recovery still preempts');
