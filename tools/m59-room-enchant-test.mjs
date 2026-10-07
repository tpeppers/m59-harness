import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { Autopilot: A } = await import(pathToFileURL((process.argv[2] || process.cwd()) + '/tools/m59-autopilot.mjs'));
let passed = 0;
async function test(name, f) { await f(); passed++; console.log('ok ' + name); }
function post() {
  const a = Object.create(A.prototype);
  a.mode = 'idle'; a.policy = { assignedRoom: 38, roomEnchant: { enabled: true, spells: ['forces of light'] } };
  a.s = { world: { room: { num: 38 } }, client: { vitals: () => ({ health: { value: 20, max: 20 }, mana: { value: 65, max: 65 } }) } };
  a.busyStatus = () => null; a.facultyHeld = () => false; a.holdWorks = () => true;
  a.threat = () => ({ landing: 0 }); a.roomEnchant = async () => { a.casts = (a.casts || 0) + 1; };
  return a;
}
await test('idle caster at assigned room is a post', () => assert.equal(post().isRoomEnchantPost(), true));
for (const [name, mutate] of [
  ['wrong room', a => a.s.world.room.num = 39], ['farmer', a => a.mode = 'farm'],
  ['disabled enchantment', a => a.policy.roomEnchant.enabled = false],
  ['human or external operation', a => a.inert = { why: 'pilot' }],
  ['travelling', a => a.suspendedJourney = {}], ['busy', a => a.busyStatus = () => ({})],
  ['movement lease', a => a.facultyHeld = f => f === 'movement'],
]) await test(name + ' is not eligible', () => { const a = post(); mutate(a); assert.equal(a.isRoomEnchantPost(), false); });
await test('full health does not release the caster refuge', async () => {
  const a = post(); a.hold = {}; a.leaveHold = () => { throw Error('must not leave'); };
  assert.equal(await a.releaseRestedHold(), false);
});
await test('acquires shelter before doing anything at full health', async () => {
  const a = post(); a.holdWorks = () => false; a.takeRecoverySpot = async () => { a.acquired = true; };
  await a.passErrand({}); assert.equal(a.acquired, true); assert.equal(a.casts, undefined);
});
await test('casts while holding a healthy refuge', async () => { const a = post(); await a.maintainRoomEnchantPost(); assert.equal(a.casts, 1); });
await test('recent damage prevents optional casting', async () => { const a = post(); a.threat = () => ({ landing: 1 }); await a.maintainRoomEnchantPost(); assert.equal(a.casts, undefined); });
await test('hurt caster saves mana for survival', async () => { const a = post(); a.s.client.vitals = () => ({health:{value:5,max:20}}); await a.maintainRoomEnchantPost(); assert.equal(a.casts, undefined); });
await test('frozen refuge is not interrupted', async () => { const a = post(); a.frozenUntil = Date.now()+10000; await a.maintainRoomEnchantPost(); assert.equal(a.casts, undefined); });
function caster(paid) {
  const a = post(); delete a.roomEnchant;
  const events = [], reagents = {elderberry:10,emerald:10};
  const c = { spells:[{id:1,nameRsc:1}], rsc:{get:()=> 'forces of light'}, room:{id:38}, abilities:new Map([[1,{ability:80}]]),
    vitals:()=>({mana:{value:65,max:65}}), stand:()=>events.push('stand'),
    cast:()=>{events.push('cast');if(paid){reagents.elderberry-=2;reagents.emerald--; }},
    waitFor:async()=>({events:[]}) };
  a.s.client = c; a.s.need=()=>c; a.s.pacer={submit:async(_k,f)=>f()};
  a.reagentOnHand=n=>reagents[n]; a.tally={}; a.note=()=>{}; a.declinedCast=()=>{};
  return {a,events};
}
await test('stands before cast and records a paid cast', async()=>{const {a,events}=caster(true);await a.roomEnchant();assert.deepEqual(events,['stand','cast']);assert.equal(a.tally.room_enchants,1);const at=a._enchantedAt.get('38:forces of light');assert.ok(Date.now()-at<1000);});
await test('unpaid renewal retries without claiming a full duration', async()=>{const {a}=caster(false);await a.roomEnchant();assert.equal(a.tally.room_enchants,undefined);assert.ok(Date.now()-a._enchantedAt.get('38:forces of light')>10000);});
await test('no cast in another room after evacuation',async()=>{const {a,events}=caster(true);a.s.world.room.num=106;await a.roomEnchant();assert.deepEqual(events,[]);});
// ROOMS LIMIT (operator, 2026-10-07: "limit Loial's forces of light to only being cast in map 38").
await test('rooms limit: casts in a named room', async()=>{const {a,events}=caster(true);a.policy.roomEnchant.rooms=[38];await a.roomEnchant();assert.deepEqual(events,['stand','cast']);});
await test('rooms limit: a post outside the list casts nothing', async()=>{const {a,events}=caster(true);a.policy.assignedRoom=2;a.s.world.room.num=2;a.policy.roomEnchant.rooms=[38];await a.roomEnchant();assert.deepEqual(events,[]);});
await test('rooms limit: a remote (chalice) cast outside the list is refused with a reason', async()=>{const {a,events}=caster(true);a.s.world.room.num=599;a.policy.roomEnchant.rooms=[38];const r=await a.roomEnchant({remote:true});assert.deepEqual(events,[]);assert.equal(r.cast,false);assert.match(r.why,/room 599 is not in room_enchant.rooms/);});
await test('rooms limit: absent or empty means any room, as before', async()=>{for(const rooms of [undefined,[]]){const {a,events}=caster(true);a.mode='farm';a.s.world.room.num=106;if(rooms)a.policy.roomEnchant.rooms=rooms;await a.roomEnchant();assert.deepEqual(events,['stand','cast']);}});
await test('rooms limit: a forces-of-light visit to a forbidden room is never walked', async()=>{
  const a=post(); a.policy.roomEnchant.rooms=[38]; a.s.world.room.num=2;
  a.chaliceFit=()=>true; a.hereRoom=()=>2; a.note=()=>{}; const ev=[]; a.chaliceEvent=(w,d)=>ev.push([w,d]);
  a.travel=async()=>assert.fail('must not walk to a room its orders forbid');
  const marked=[]; const store={mark:(t,st,x)=>marked.push([t,st,x])};
  a._chaliceServe={};
  const st={kind:'fol',stage:'go',room:599,ticket:'tk'};
  await a.chaliceStep({fol_room:599,fol_rooms:[]},st,store,'Loial');
  assert.equal(marked[0][1],'abandoned'); assert.match(marked[0][2].note,/599/);
  assert.equal(ev[0][0],'fol_refused'); assert.equal(a._chaliceServe,null);
});
await test('rooms limit: a visit to a named room still walks', async()=>{
  const a=post(); a.policy.roomEnchant.rooms=[38];
  a.chaliceFit=()=>true; a.hereRoom=()=>2; a.note=()=>{};
  let went=null; a.travel=async(room)=>{went=room;return {arrived:true};};
  const st={kind:'fol',stage:'go',room:38,ticket:'tk'};
  await a.chaliceStep({fol_room:38,fol_rooms:[]},st,{mark(){}},'Loial');
  assert.equal(went,38); assert.equal(st.stage,'cast');
});
console.log(passed + ' room-caster cases passed');
