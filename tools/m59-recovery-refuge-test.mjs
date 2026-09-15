// Offline: real geometry, selectors and movement handoffs; no fleet or socket.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Autopilot, releaseSpot } from './m59-autopilot.mjs';
import { RoomGeometry } from './m59-roo.mjs';
import { geometryFor } from './m59-safespots.mjs';
import { OF, MOVEON } from './m59-parse.mjs';
import { recoveryRefugeReach } from './m59-recovery-refuge.mjs';
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

// Existing target-first combat is exercised independently by m59-pullspot-test.mjs.
console.log(`${passed} recovery refuge scenarios passed`);
