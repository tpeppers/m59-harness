import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const scratch=mkdtempSync(join(tmpdir(),'m59-deviation-routing-'));
for(const [k,v]of Object.entries({M59_LEDGER_DIR:'ledger',M59_TACTICS_DIR:'tactics',M59_TRAILS_DIR:'trails',M59_SPOT_CLAIMS_DIR:'claims',M59_SHELTER_DIR:'shelter',M59_CROSSINGS_LEARNED:'crossings.json'}))process.env[k]=join(scratch,v);
process.env.M59_RUNTIME_PROFILE='lab';process.env.M59_EXIT_FALLBACK='0';process.env.M59_EXIT_DEBUG='0';
const {Session}=await import('./m59-game.mjs'),{geometryFor}=await import('./m59-safespots.mjs');
const {World}=await import('./m59-world.mjs');
const {bakedPath,routesFor}=await import('./m59-routes.mjs');
const {configureSpotClaimStore}=await import('./m59-spotclaims.mjs');configureSpotClaimStore({enabled:false});
const map=JSON.parse(readFileSync(new URL('../substrate/m59-map.json',import.meta.url)));
function fixture(room=599,x=3166,y=1799){
 const geo=geometryFor(map.rooms[room]),packets=[];
 const self={id:1,flags:4,x,y,row:Math.floor(y/64),col:Math.floor(x/64),predicted:false};
 const c={selfId:1,self,evSeq:0,rsc:new Map(),room:{id:room,security:geo.security,flags:0,objects:new Map([[1,self]])},
  vitals:()=>({health:{value:76,max:76},vigor:{value:200,max:200}}),face(){},stand(){},roomContents(){return 1;},async waitFor(){return {events:[]};},
  predictSelf(p){this.self={...this.self,...p,predicted:true};this.room.objects.set(1,this.self);},moveTo(x,y){packets.push({x,y});this.predictSelf({x,y,row:Math.floor(y/64),col:Math.floor(x/64)});}};
 const s=Object.assign(Object.create(Session.prototype),{client:c,world:{map,room:map.rooms[room],geometry:geo},movementGeneration:0,name:'offline-deviation-routing',
  need:()=>c,moveSpeed:()=>18,movementWasCancelled:g=>g!==s.movementGeneration,pacer:{async submit(_k,run){return run();}},
  async confirmPosition(){c.self.predicted=false;return c.self;},async _askStrategies(){return null;},_blinkPointHere:()=>null,_blockingBodies:()=>[],
  noteTransit(){},planSameRoomDoors:()=>null,async rideTrack(){return {rode:false};}});
 Object.defineProperty(s,'live',{value:true});s.threatsHere=()=>[];return {s,c,geo,packets};
}
const exits=()=>[1,2,3,4].map(col=>({kind:'edge',to:2,direction:'north',stand_on:{row:1,col}}));
const refused=f=>({left:false,reason:'movement_deviation',deviation:{confirmed:true,room:f.s.world.room.num,position:{...f.c.self},requested:{row:1,col:27}}});

test('the recorded rail bend detours from the confirmed fine pose and reaches its waypoint',async()=>{
 const f=fixture(),r=await f.s.followRail([{row:28,col:49},{row:32,col:34}]);
 assert.equal(r.railed,true,JSON.stringify(r));assert.equal(f.c.self.row,32);assert.equal(f.c.self.col,34);assert.equal(f.c.self.predicted,false);
 assert.ok(f.packets.length>1);assert.ok(f.packets[0].x>3166,'the route must first go around the wall to the east');
});
test('a local rail recovery avoids the observed nearby troll',async()=>{
 const f=fixture();f.c.room.objects.set(2,{id:2,flags:9,x:3168,y:1760,row:27,col:49});
 const r=await f.s.followRail([{row:28,col:49},{row:32,col:34}]);assert.equal(r.railed,true,JSON.stringify(r));
 assert.ok(f.packets.every(p=>Math.hypot(p.x-3168,p.y-1760)>=31));
});
test('mandatory avoidance and unknown confirmation cannot earn local recovery packets',async()=>{
 const f=fixture(),failure=await f.s.step(34,32),before=f.packets.length;
 assert.equal(failure.reason,'movement_deviation');
 assert.equal((await f.s.recoverDeviationWaypoint(failure,{avoidSquares:new Set(['32,34'])})).arrived,false);
 failure.deviation.confirmed=false;await f.s.recoverDeviationWaypoint(failure);assert.equal(f.packets.length,before);
});
test('survival, paced takeover and a newly entering blocker retain ownership of local recovery',async()=>{
 for(const mode of ['survival','takeover','blocker']){
  const f=fixture(),failure=await f.s.step(34,32),before=f.packets.length;
  if(mode==='survival')f.s.shelterPolicy={onFallback:async()=>true};
  else f.s.pacer.submit=async(k,run)=>{if(k==='move'){if(mode==='takeover')f.s.movementGeneration++;else f.c.room.objects.set(2,{id:2,flags:9,x:3198,y:1831});}return run();};
  const r=await f.s.recoverDeviationWaypoint(failure);assert.equal(r.arrived,false);assert.equal(f.packets.length,before,mode);
  if(mode!=='blocker')assert.equal(r.cancelled,true);
 }
});
test('reaching a repaired local waypoint does not certify the original distant destination',async()=>{
 const f=fixture(),failure=await f.s.step(34,32),target={row:1,col:27};
 const local=await f.s.departureDetour(failure,{to:target});assert.equal(local.arrived,true);assert.equal(local.via,'fine_waypoint_departure');
 f.s.walkTo=async(col,row)=>{assert.equal(col,target.col);assert.equal(row,target.row);return {arrived:false,reason:'remaining approach refused'};};
 const r=await f.s.continueDeparture(local,target.col,target.row,{maxSteps:80});assert.equal(r.arrived,false);
});
test('a confirmed deviation buys a different exit candidate within the same bounded batch',async()=>{
 const f=fixture();let calls=0;f.s.leaveVia=async()=>++calls===1?refused(f):{left:true};
 const r=await f.s.leaveViaAny(exits(),{exact:true});assert.equal(r.left,true);assert.equal(calls,2);assert.equal(r.tried[0].movement_deviation.confirmed,true);
});
test('confirmed deviations exhaust candidates with position evidence for travel to replan',async()=>{
 const f=fixture();f.s.leaveVia=async()=>refused(f);
 const r=await f.s.leaveViaAny(exits(),{exact:true});assert.equal(r.outcome,'exit_candidates_exhausted');assert.equal(r.attempts,3);
 assert.equal(r.tried.length,3);assert.ok(r.tried.every(t=>t.movement_deviation.position.x===3166));
});
test('unconfirmed, stale-position and terminal failures still stop after one candidate',async()=>{
 for(const mode of ['unknown','stale','terminal']){
  const f=fixture();let calls=0;f.s.leaveVia=async()=>{calls++;const r=refused(f);if(mode==='unknown')r.deviation.confirmed=false;
   if(mode==='stale')r.deviation.position.x++;if(mode==='terminal')r.reason='collision_geometry_unavailable';return r;};
  const r=await f.s.leaveViaAny(exits(),{exact:true});assert.equal(r.left,false);assert.equal(calls,1);assert.equal(r.outcome,undefined);
 }
});
test('a room transition following a deviation stops all source-room candidates',async()=>{
 const f=fixture();let calls=0;f.s.refreshRoomIdentity=async()=>({confirmed:true});
 f.s.leaveVia=async()=>{calls++;const r=refused(f);f.c.room.id=2;f.s.world.room=map.rooms[2];return r;};
 const r=await f.s.leaveViaAny(exits(),{exact:true});assert.equal(r.left,true);assert.equal(calls,1);
});
test('the real travel loop uses an alternate room route after a confirmed approach is exhausted',async()=>{
 const f=fixture(599,1072,2304);let room=599,northAttempts=0;const blocked=[];
 f.s.world={get room(){return {num:room,name:'offline room '+room};},get self(){return f.c.self;},
  route(_to,{blockedHops}={}){blocked.push([...(blockedHops??[])]);return {found:true,hops:[{to:room===599?(blockedHops?.has('599>2')?589:2):2}]};},
  exits(){return room===599?[...exits(),{kind:'edge',to:589,stand_on:{row:70,col:2}}]:exits();}};
 f.s.leaveVia=async e=>{if(room===599&&e.to===2){northAttempts++;return refused(f);}room=e.to;f.c.room.id=room;return {left:true};};
 const r=await f.s.travel(2,{maxStumbles:2,maxHops:4});assert.equal(r.arrived,true,JSON.stringify(r));assert.equal(northAttempts,3);
 assert.ok(blocked.some(h=>h.includes('599>2')));assert.ok(r.log.some(l=>l.unreachable_exit===2));
});
test('the real router retains exhausted first hops on its permissive pass and finds a detour',()=>{
 for(const [room,x,y,to,refusedHop]of [[599,1072,2304,38,'599>2'],[596,128,240,61,'596>61']]){
  const f=fixture(room,x,y);f.c.roomNameRsc=map.rooms[room].nameRsc;f.c.roomRsc=map.rooms[room].roomRsc;
  const w=new World(f.c,map),r=w.route(to,{blockedHops:new Set([refusedHop])});
  if(room===596)assert.equal(r.found,true,JSON.stringify(r));
  assert.notEqual(r.hops?.length?`${room}>${r.hops[0].to}`:null,refusedHop);
  const fresh=w.route(to);assert.equal(`${room}>${fresh.hops[0].to}`,refusedHop,'a new journey must not inherit the refusal');
 }
});
test('the recorded declared cliff jump uses timed gravity and reaches the intended shelf',async()=>{
 for(const [x,y]of [[1072,2304],[1056,2336]]){
  const f=fixture(599,x,y),r=await f.s.followRail([{row:36,col:16},{row:38,col:10}]);
  assert.equal(r.railed,true,JSON.stringify(r));assert.equal(f.c.self.row,38);assert.equal(f.c.self.col,10);
  assert.equal(f.packets.length,1);assert.notEqual(f.s.finePositionUnknown,true);
 }
 const f=fixture(599,1072,2304),table=routesFor(map.geometryManifestSha256);
 const rail=bakedPath(table,599,{row:1,col:66},{row:1,col:27}),at=rail.findIndex(p=>p.row===36&&p.col===16);
 const r=await f.s.followRail(rail.slice(at));assert.equal(r.railed,true,JSON.stringify(r));
 assert.equal(f.c.self.row,1);assert.equal(f.c.self.col,27);
});
test('a declared running jump still refuses low vigor and an intervening live blocker',async()=>{
 const low=fixture(599,1072,2304);low.c.vitals=()=>({vigor:{value:11,max:200}});
 const r=await low.s.step(10,38,{fall:true});assert.equal(r.reason,'jump_needs_run');assert.equal(low.packets.length,0);
 const f=fixture(599,1072,2304);f.c.room.objects.set(2,{id:2,flags:9,x:864,y:2384,row:37,col:13});
 // Use the send boundary directly so this negative case does not wait for a
 // pursuing monster. Timed flight must still validate every collision microstep.
 const blocked=await f.s.queueValidatedMove(672,2464,{fall:true,timedFall:true,speed:18,slide:false});
 assert.equal(blocked.sent,false);assert.equal(f.packets.length,0);
 const paced=fixture(599,1072,2304);paced.s.pacer.submit=async(k,run)=>{if(k==='move')paced.c.room.objects.set(2,{id:2,flags:9,x:672,y:2464,row:38,col:10});return run();};
 const changed=await paced.s.step(10,38,{fall:true});assert.equal(changed.moved,false);assert.equal(paced.packets.length,0,'a newly blocked jump must not be clipped into the gully');
});
