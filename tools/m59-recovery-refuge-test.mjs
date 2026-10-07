// Offline: real geometry, selectors and movement handoffs; no fleet or socket.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Autopilot, releaseSpot } from './m59-autopilot.mjs';
import { RoomGeometry } from './m59-roo.mjs';
import { geometryFor } from './m59-safespots.mjs';
import { OF, MOVEON } from './m59-parse.mjs';
import { recoveryRefugeReach, planDoorEscape } from './m59-recovery-refuge.mjs';
import { attachSurvivalTrace, survivalTraceSnapshot } from './m59-survival-trace.mjs';

let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }
const map = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url), 'utf8'));
function keeper(room = 39, from = { row: 8, col: 16 }) {
  const geo = geometryFor(map.rooms[room]);
  const c = { selfId: 1, self: { id: 1, ...from }, room: { objects: new Map() },
    vitals: () => ({ health: { value: 32, max: 50 }, vigor: { value: 80 } }) };
  const k = Object.assign(Object.create(Autopilot.prototype), { policy: { maxBotsPerSafeSpot: 5 },
    passes: 1, journal: [], tally: {}, mode: 'farm', claims: new Map(),
    book: { get: () => null, discredited: () => false }, safety: () => ({ fleeAt: 0.68 }),
    crossSameRoomIsland: async () => assert.fail('recovery must not cross a partition for quarry'),
    onwardExit: () => assert.fail('recovery must not choose the onward exit'),
    s: { name: null, client: c, movementGeneration: 0, need: () => c, standBeforeGo:async()=>{},
      world: { geometry: geo, room: map.rooms[room], map,
        reach(col,row) { const p=geo.path(c.self.row,c.self.col,row,col,{clearance:0});
          return { reachable:p.found,steps:p.steps?.length }; } } } });
  k.s.walkTo = k.s.approachFine = async (col,row) => {
    c.self = { ...c.self, col, row }; return { arrived: true };
  };
  attachSurvivalTrace(k.s, k);
  return k;
}

await test('recovery path rejects bodies and walls, but not walk-through corpses', () => {
  const make = () => new RoomGeometry({ rows: 1, cols: 5, grid: Buffer.alloc(5,255),
    flags: Buffer.alloc(5,1), monsterGrid: null, walls: [] });
  const from = { row: 1, col: 1 };
  const body = { id: 2, row: 1, col: 3, flags: OF.ATTACKABLE | MOVEON.NO };
  let reach = recoveryRefugeReach(make(), from, new Map([[2, body]]), 1);
  assert.equal(reach(5,1).reachable, false, 'body blocks the only corridor');
  assert.equal(reach(3,1).reachable, false, 'occupied goal is not exempt');
  const corpse = { ...body, flags: 0 };
  assert.equal(recoveryRefugeReach(make(),from,new Map([[2,corpse]]),1)(5,1).steps,4);
  const wall = make(); wall.grid[2]=0; wall.flags[2]=0;
  assert.equal(recoveryRefugeReach(wall,from,new Map(),1)(5,1).reachable,false);
  assert.equal(recoveryRefugeReach(null,from,new Map(),1)(5,1).reachable,false);
});

await test('healing ignores quarry across a partition and records only the chosen wall', async () => {
  const k = keeper();
  const quarry = { id: 10, row: 6, col: 16, flags: OF.ATTACKABLE | MOVEON.NO };
  k.s.client.room.objects.set(quarry.id, quarry);
  // Recovery must override even an accidentally supplied quarry, with no combat blacklist.
  k.noWallRooms = new Map([[39,'no combat wall for the previous target']]);
  const r = await k.takeSafeSpot('heal first', quarry, { recovery:true, source:'fight' });
  assert.equal(r.took, true);
  assert.deepEqual({ row:k.hold.row,col:k.hold.col }, {row:7,col:16});
  assert.equal(k.hold.quarry_id, null);
  const notes = k.journal.filter(n => n.what === 'taking the selected safe spot');
  assert.equal(notes.length,1);
  assert.deepEqual(notes[0].to,{col:16,row:7});
  const trace = survivalTraceSnapshot(k.s);
  const selection = trace.events.find(e=>e.kind==='refuge_selected');
  assert.equal(selection.detail.quarry,null);
  assert.equal(selection.detail.share_cap,1, 'recovery cannot share even with configured cap 5');
  assert.equal(trace.events.filter(e=>e.kind==='refuge_selected').length,1);
});

await test('occupied closest wall loses; adjacent body alone does not veto a clear approach', () => {
  const k = keeper(), geo = k.s.world.geometry, from=k.s.client.self;
  const choose = () => k.searchSafeSpot(geo,from,k.s.world.room,{ within:80,los:0,
    recovery:true,exclusiveClaim:true,shareCap:1 });
  let s=choose(); assert.deepEqual({row:s.row,col:s.col},{row:7,col:16});
  k.s.client.room.objects.set(5,{id:5,row:s.row,col:s.col,flags:OF.PLAYER|MOVEON.NO});
  s=choose(); assert.ok(s); assert.notDeepEqual({row:s.row,col:s.col},{row:7,col:16});
  k.s.client.room.objects.set(5,{id:5,row:7,col:17,flags:OF.PLAYER|MOVEON.NO});
  s=choose(); assert.deepEqual({row:s.row,col:s.col},{row:7,col:16});
});

await test('distant monster count cannot change the nearest recovery wall', async () => {
  for (const monsters of [0, 1, 5, 6, 14]) {
    const k = keeper();
    for (let i = 0; i < monsters; i++) k.s.client.room.objects.set(i + 10,
      { id:i+10,row:1,col:i+1,flags:OF.ATTACKABLE|MOVEON.NO });
    const result = await k.takeRecoverySpot('recover regardless of room population');
    assert.equal(result.took,true);
    assert.deepEqual({row:k.hold.row,col:k.hold.col},{row:7,col:16});
  }
});

await test('zero-step recovery confirms a predicted wall before logging off there', async () => {
  const k=keeper(39,{row:7,col:16,predicted:true}),calls=[];
  k.s.confirmPosition=async()=>{
    calls.push('confirm');k.s.client.self={...k.s.client.self,predicted:false};
    return {row:7,col:16};
  };
  k.playDead=async()=>{calls.push('logoff');assert.ok(k.currentRecoveryWall());return true;};
  k.s.standBeforeGo=async()=>assert.fail('a confirmed current wall must not be left');
  k.s.walkTo=k.s.approachFine=async()=>assert.fail('already at the refuge');
  const result=await k.takeRecoverySpot('recover at the apparent current wall');
  assert.equal(result.took,true);
  assert.deepEqual(calls,['confirm','logoff']);
  assert.equal(k.s.client.self.predicted,false);
});

await test('unconfirmed zero-step recovery cannot claim arrival or discredit the wall', async () => {
  const k=keeper(39,{row:7,col:16,predicted:true});
  let confirms=0;
  k.s.confirmPosition=async()=>{confirms++;return null;};
  k.playDead=async()=>assert.fail('cannot claim a confirmed safe-wall logoff');
  k.noteUnreachableSpot=()=>assert.fail('an unanswered position read does not prove a blocked wall');
  const result=await k.takeRecoverySpot('recover at the apparent current wall');
  assert.equal(confirms,1);
  assert.equal(result.took,false);
  assert.equal(result.unconfirmed,true);
  assert.equal(k.hold,undefined);
});

await test('a corrected zero-step prediction walks back to the selected wall before logoff', async () => {
  const k=keeper(39,{row:7,col:16,predicted:true}),calls=[];
  k.s.confirmPosition=async()=>{
    calls.push('confirm');k.s.client.self={...k.s.client.self,row:8,predicted:false};
    return {row:8,col:16};
  };
  k.s.standBeforeGo=async()=>calls.push('stand');
  k.s.approachFine=async()=>assert.fail('recovery must use the clear route first');
  k.s.walkTo=async(col,row,options)=>{
    calls.push('route');assert.deepEqual({row,col},{row:7,col:16});
    assert.ok(options.avoidSquares instanceof Set);
    k.s.client.self={...k.s.client.self,row,col,predicted:false};return {arrived:true};
  };
  k.playDead=async()=>{calls.push('logoff');assert.ok(k.currentRecoveryWall());return true;};
  const result=await k.takeRecoverySpot('recover after a corrected prediction');
  assert.equal(result.took,true);
  assert.deepEqual(calls,['confirm','stand','route','logoff']);
});

await test('forward recovery never computes a preview or requires a precomputed route shelter', async () => {
  const k=keeper(598,{row:40,col:22});
  Object.defineProperty(k.s,'activeShelter',{get(){assert.fail('throwaway preview read');}});
  let calls=0;
  k.takeSafeSpot=async(why,quarry,options)=>{
    calls++; assert.equal(quarry,null); assert.equal(options.recovery,true);
    assert.equal(options.nearestOnly,true); return {took:true};
  };
  assert.equal(await k.shelterForwardAndMend('recover'),true);
  assert.equal(calls,1); assert.equal(k.journal.length,0,'caller must not announce another target');
});

await test('travel recovery chooses nearby cover without exit/progress bias', async () => {
  const k=keeper(598,{row:40,col:22});
  k.s.activeShelter={atStep:0,spots:[{row:51,col:22,atStep:5,detour:5}]};
  k.inert={travelling:true,to:599};
  assert.equal(await k.shelterForwardAndMend('recover'),true);
  assert.deepEqual({row:k.hold.row,col:k.hold.col},{row:39,col:22});
  assert.ok(!k.journal.some(n=>/next wall on the route|FORWARD/.test(n.what)));
  assert.deepEqual(k.journal.find(n=>n.what==='taking the selected safe spot').to,{row:39,col:22});
});

await test('withdrawal searches once, even when no local wall can be reached', async () => {
  const k=keeper(); let calls=0;
  k.takeRecoverySpot=async()=>{calls++;return {took:false};};
  Object.defineProperty(k.s,'activeShelter',{get(){assert.fail('discarded forward selection');}});
  k.takeSafeSpot=async()=>assert.fail('second selector');
  await k.withdraw([{id:10,row:6,col:16}]);
  assert.equal(calls,1);
});

await test('concurrent recovery claims remain exclusive before either walker arrives', async () => {
  const a=keeper(), b=keeper(); a.s.name='offline-recovery-a'; b.s.name='offline-recovery-b';
  const release=[];
  for(const k of [a,b]) k.s.walkTo=k.s.approachFine=async(col,row)=>new Promise(resolve=>{
    release.push(()=>{ k.s.client.self={...k.s.client.self,col,row}; resolve({arrived:true}); });
  });
  try {
    const first=a.takeRecoverySpot('heal'), second=b.takeRecoverySpot('heal');
    for(let i=0;i<20 && release.length<2;i++) await Promise.resolve();
    assert.equal(release.length,2);
    const selected=k=>survivalTraceSnapshot(k.s).events.find(e=>e.kind==='refuge_selected').detail.selected;
    assert.notDeepEqual({row:selected(a).row,col:selected(a).col},{row:selected(b).row,col:selected(b).col});
    release.forEach(r=>r()); await Promise.all([first,second]);
    assert.equal(a.hold.quarry_id,null); assert.equal(b.hold.quarry_id,null);
  } finally { release.forEach(r=>r()); releaseSpot(a.s.name); releaseSpot(b.s.name); }
});

// ---- OUT THROUGH AN INTERNAL DOOR. Waldorf, Statler, Sweetums, Zoot and Gonzo, 2026-10-06/07:
// room 38's east chamber (r4-8 c30-34), standing on r7c32 with the door out at r8c32 one square
// south, and the recovery search answering "eligible 0" once a second until they died.

await test('door escape plan: our side only, onto new ground, clear to walk, wall beyond, nearest total', () => {
  const doors = [
    { row: 8, col: 32, arriveRow: 10, arriveCol: 32 },   // ours, lands outside: the way out
    { row: 9, col: 32, arriveRow: 7, arriveCol: 32 },    // the other side's door: not ours
    { row: 5, col: 30, arriveRow: 6, arriveCol: 31 },    // ours, but lands on our own ground
    { row: 4, col: 34, arriveRow: 20, arriveCol: 20 },   // ours, lands outside, further walk
  ];
  const component = new Set(['8,32', '5,30', '6,31', '4,34', '7,32']);
  const reach = (col, row) => ({ reachable: true, steps: Math.abs(row - 7) + Math.abs(col - 32) });
  const farRefuge = l => ({ spot: { row: l.row, col: l.col + 1 }, steps: l.row === 10 ? 2 : 1 });
  let r = planDoorEscape({ doors, component, reach, farRefuge });
  assert.deepEqual({ row: r.escape.door.row, col: r.escape.door.col }, { row: 8, col: 32 });
  assert.equal(r.escape.total, 3);
  assert.deepEqual(r.counts, { doors: 4, on_our_side: 3, in_reach: 2, onto_new_ground: 2, with_refuge: 2 });
  // A body on the near door: the further door wins rather than nothing.
  r = planDoorEscape({ doors, component, farRefuge,
    reach: (col, row) => row === 8 ? { reachable: false } : reach(col, row) });
  assert.deepEqual({ row: r.escape.door.row, col: r.escape.door.col }, { row: 4, col: 34 });
  // No free wall beyond any door: no escape, and the counts say which filter emptied it.
  r = planDoorEscape({ doors, component, reach, farRefuge: () => null });
  assert.equal(r.escape, null); assert.equal(r.counts.with_refuge, 0); assert.equal(r.counts.in_reach, 2);
});

function chamberKeeper() {
  const k = keeper(38, { row: 7, col: 32 });
  k.s.name = 'offline-door-escape';
  const objects = k.s.client.room.objects;
  // The four chamber walls, each with an undead on it, and two more on the floor beside us.
  [[8,30],[8,31],[8,33],[8,34],[6,31],[7,33]].forEach(([row, col], i) =>
    objects.set(100 + i, { id: 100 + i, row, col, flags: OF.ATTACKABLE | MOVEON.NO }));
  return k;
}

await test('chamber with every wall taken: crosses the internal door and takes a wall in the hall', async () => {
  const k = chamberKeeper(), crossed = [];
  k.s.crossSameRoomDoor = async door => {
    crossed.push({ row: door.row, col: door.col });
    k.s.client.self = { ...k.s.client.self, row: door.arriveRow, col: door.arriveCol };
    return { crossed: true, at: { row: door.arriveRow, col: door.arriveCol } };
  };
  try {
    const r = await k.takeSafeSpot('below the flee line in the east chamber', null,
      { recovery: true, source: 'recovery', nearestOnly: true });
    assert.deepEqual(crossed, [{ row: 8, col: 32 }], 'the door one square south');
    assert.equal(r.took, true, r.why);
    assert.ok(k.hold.row >= 9, `a wall outside the chamber, got r${k.hold.row}c${k.hold.col}`);
    assert.ok(k.journal.some(n => n.what === 'no wall on this side — leaving through an internal door'));
    const planned = survivalTraceSnapshot(k.s).events.find(e => e.kind === 'refuge_door_planned');
    assert.deepEqual(planned.detail.escape.door, { row: 8, col: 32 });
  } finally { releaseSpot(k.s.name); }
});

await test('a body on the door square: no crossing, and the refusal names the door filter', async () => {
  const k = chamberKeeper();
  k.s.client.room.objects.set(200, { id: 200, row: 8, col: 32, flags: OF.ATTACKABLE | MOVEON.NO });
  k.s.crossSameRoomDoor = async () => assert.fail('the door is occupied');
  try {
    const r = await k.takeSafeSpot('below the flee line', null, { recovery: true, source: 'recovery' });
    assert.equal(r.took, false);
    assert.match(r.why, /more defensible than open floor/);
    assert.match(r.why, /no internal door leads to a free wall .*clear to walk 0/);
  } finally { releaseSpot(k.s.name); }
});

await test('a failed crossing reports why and takes no second door', async () => {
  const k = chamberKeeper(); let tries = 0;
  k.s.crossSameRoomDoor = async () => { tries++; return { crossed: false, reason: 'not_on_door_square' }; };
  try {
    const r = await k.takeSafeSpot('below the flee line', null, { recovery: true, source: 'recovery' });
    assert.equal(tries, 1); assert.equal(r.took, false);
    assert.match(r.why, /internal-door escape did not complete: not_on_door_square/);
  } finally { releaseSpot(k.s.name); }
});

await test('combat (non-recovery) searches never take an internal door for shelter', async () => {
  const k = chamberKeeper();
  k.s.crossSameRoomDoor = async () => assert.fail('only recovery escapes through a door');
  try {
    // Whatever it settles on, it settles on it from this side of the door.
    await k.takeSafeSpot('a wall for the next quarry', null, { source: 'fight' });
    assert.ok(!survivalTraceSnapshot(k.s).events.some(e => e.kind === 'refuge_door_planned'));
  } finally { releaseSpot(k.s.name); }
});

// Existing target-first combat is exercised independently by m59-pullspot-test.mjs.
console.log(`${passed} recovery refuge scenarios passed`);
