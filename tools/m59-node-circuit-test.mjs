// Cache states, route omissions, and no-travel acquisition tested without a game server.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {CIRCUIT_NODES,CIRCUIT_REVISION,selectCircuitNodes,circuitPlan,booleanOption,selectedCircuitComplete} from './m59-node-circuit.mjs';
import {nodeBit,updateNodeMemory} from './m59-node-memory.mjs';
import {runTour,tourComplete} from './m59-node-tour.mjs';
import {tourObjectiveComplete} from './m59-node-tour-policy.mjs';
import {railsNeedRefresh} from './m59-node-tour-rails.mjs';
import {script} from './fleetscripts/get-all-nodes.mjs';
import {script as alias} from './fleetscripts/mana-node-tour.mjs';
import {fineRouter} from './m59-fineroute.mjs';
import {bakeOne,checkRoute,fineEdge,exactFloor} from './m59-noderails.mjs';
import {STONES} from './m59-stones.mjs';
let count=0;const test=(name,fn)=>{fn();console.log('ok '+name);count++;};
test('all 243 present/absent/unknown combinations select exactly absent and unknown nodes',()=>{
  for(let code=0;code<3**CIRCUIT_NODES.length;code++){
    let n=code,mask=0,known_mask=0;const expected=[];
    for(const node of CIRCUIT_NODES){const state=n%3;n=Math.floor(n/3);const bit=nodeBit(node);
      if(state)known_mask|=bit;if(state===2)mask|=bit;else expected.push(node);}
    const selection=selectCircuitNodes({mask,known_mask,revision:7});
    assert.deepEqual(selection.selected,expected);assert.equal(selection.cache_revision,7);
    const p=circuitPlan(selection.selected);
    assert.deepEqual(p.filter(s=>s.kind==='meld').map(s=>s.node),expected);
    for(const s of selection.skipped)assert.ok(!p.some(step=>step.node===s.stone),'cached stone has no approach, exit detour, or activation');
    if(expected.length)assert.deepEqual(p.at(-1),{kind:'travel',to:2});else assert.deepEqual(p,[]);
    assert.deepEqual(selectCircuitNodes({mask,known_mask},{getAll:true}).selected,CIRCUIT_NODES);
  }
});
test('a positive bit without knowledge is still unknown',()=>assert.deepEqual(selectCircuitNodes({mask:31,known_mask:0}).selected,CIRCUIT_NODES));
test('REPL false is false and invalid overrides fail closed',()=>{
  assert.equal(booleanOption('false'),false);assert.equal(booleanOption('true'),true);
  assert.throws(()=>booleanOption('yes'),/true or false/);
  assert.deepEqual(selectCircuitNodes({mask:31,known_mask:31},{getAll:'false'}).selected,[]);
});
test('unpromoted and duplicate nodes cannot sneak into acquisition',()=>{
  assert.throws(()=>circuitPlan(['peak']),/unsupported/);assert.throws(()=>circuitPlan(['cave','cave']),/duplicate/);
});
test('cave-only omits both ledge rooms, canyon, and castle detour',()=>{
  const p=circuitPlan(['cave']);for(const room of [38,39,589,579,49,45])assert.ok(!p.some(s=>s.to===room||s.room===room));
  const at=p.findIndex(s=>s.to===27);assert.deepEqual(p.slice(at-2,at).map(s=>s.to),[576,587]);
});
test('Ancient-only enters from north without travelling to Sentinel',()=>{
  const p=circuitPlan(['ancient']);assert.ok(!p.some(s=>s.to===589));
  assert.equal(p.find(s=>s.kind==='rail').exit,'edge:578:r1c17');
});
test('Sentinel-only traverses Ancient Place without its stone detour',()=>{
  const p=circuitPlan(['sentinel']);assert.ok(p.some(s=>s.node==='ancient-transit'));
  assert.ok(!p.some(s=>s.node==='ancient'));assert.deepEqual(p.filter(s=>s.kind==='meld').map(s=>s.node),['sentinel']);
});
test('movement epoch or catalog promotion invalidates the rail bake',()=>{
  const b={tour:{format:'m59-node-circuit-rails/1',catalog_revision:CIRCUIT_REVISION,movement_epoch:'epoch-a'}};
  assert.equal(railsNeedRefresh(b,'epoch-a'),false);assert.equal(railsNeedRefresh(b,'epoch-b'),true);
  assert.equal(railsNeedRefresh({},'epoch-a'),true);assert.equal(railsNeedRefresh(b,null),true);
  assert.equal(railsNeedRefresh({tour:{...b.tour,catalog_revision:0}},'epoch-a'),true);
});
test('cache-covered completion never claims the full circuit was walked',()=>{
  const r={from_step:0,start:{room:2},end:{room:2},nodes:[],selection:selectCircuitNodes({mask:31,known_mask:31})};
  r.selected_complete=selectedCircuitComplete(r);assert.equal(r.selected_complete,true);
  assert.equal(tourObjectiveComplete(r),true);assert.equal(tourComplete(r),false);
  r.failure='interrupted';assert.equal(selectedCircuitComplete(r),false);assert.equal(tourObjectiveComplete(r),false);
});
test('dead or unknown interactions cannot fulfill selected acquisition',()=>{
  const r={from_step:0,start:{room:2},end:{room:2},nodes:[{stone:'cave',status:'dead_node'}],selection:{selected:['cave']}};
  assert.equal(selectedCircuitComplete(r),false);r.nodes[0].status='unknown';assert.equal(selectedCircuitComplete(r),false);
});
test('selected first meld requires an actual node position',()=>{
  const r={from_step:0,start:{room:2},end:{room:2},nodes:[{stone:'cave',status:'melded',position:STONES.cave}],selection:{selected:['cave']}};
  assert.equal(selectedCircuitComplete(r),true);r.nodes[0].position={...STONES.cave,room:2};assert.equal(selectedCircuitComplete(r),false);
});
test('Ancient transit passes checked geometry without visiting the skipped meld box',()=>{
  const router=fineRouter(579),geo=router.geo,edge=fineEdge(geo);
  const r=bakeOne(router,{x:72192,y:39424},{row:1,col:17},{edge,floorAt:exactFloor(geo),
    bounds:{w:router.room.cols*1024,h:router.room.rows*1024}});
  assert.equal(r.rail_complete,true);assert.equal(checkRoute(r,{edge}).ok,true);assert.equal(r.jumps,0);
  for(const p of r.legs.flatMap(l=>l.waypoints??[]))assert.ok(Math.abs(p.row-52)>=3||Math.abs(p.col-30)>=3);
});
await assert.rejects(script.steps({agents:'a,b'}),/one character/);
assert.equal(alias.name,'mana-node-tour');assert.equal(alias.params.getAll.default,false);
console.log('ok FleetScript and compatibility name share cache defaults and refuse parallel collectors');count++;

const dir=mkdtempSync(join(tmpdir(),'m59-node-circuit-')),oldFetch=globalThis.fetch;
const envNames=['M59_NODE_MEMORY_DIR','M59_STATE_FILE','M59_CONTROL_URL'],oldEnv=Object.fromEntries(envNames.map(k=>[k,process.env[k]]));
try{
  process.env.M59_NODE_MEMORY_DIR=join(dir,'memory');process.env.M59_STATE_FILE=join(dir,'roster.json');
  process.env.M59_CONTROL_URL='http://127.0.0.1:1/';
  writeFileSync(process.env.M59_STATE_FILE,JSON.stringify({a:{credentials:{host:'127.0.0.1',port:15959}}}));
  await updateNodeMemory({server:'127.0.0.1:15959',character:'Test'}, {kind:'set',mask:31,evidence:'offline fixture'});
  globalThis.fetch=async()=>({json:async()=>({fleet:'test',game_server:{host:'127.0.0.1',port:15959},session_characters:{a:'Test'}})});
  const calls=[],state={},look={room:{num:2},you:{row:19,col:8,x:544,y:1248},hp:{value:25,max:25}};
  const ok=await runTour({agent:'a',state,call:async name=>{calls.push(name);if(name==='look')return look;if(name==='cancel_movement')return {};throw Error('Unexpected gameplay '+name);}},
    {useCache:true,evidenceDir:join(dir,'receipts'),railFile:join(dir,'missing-rails.json')});
  assert.equal(ok,true);assert.ok(calls.every(n=>['look','cancel_movement'].includes(n)));
  const receipt=JSON.parse(readFileSync(state.tourFile));assert.equal(receipt.complete,false);assert.equal(receipt.selected_complete,true);
  assert.equal(receipt.selection.skipped.length,5);assert.equal(receipt.legs.length,0);assert.equal(receipt.rail_sha256,null);
  console.log('ok persisted all-present cache executes zero travel/meld calls, needs no rail file, and writes an honest receipt');count++;
}finally{
  globalThis.fetch=oldFetch;for(const k of envNames)if(oldEnv[k]===undefined)delete process.env[k];else process.env[k]=oldEnv[k];
  assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));
  rmSync(dir,{recursive:true,force:true});
}
console.log(count+' cache-aware circuit checks passed');
