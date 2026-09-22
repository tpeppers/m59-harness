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
console.log(passed + ' room-caster cases passed');
