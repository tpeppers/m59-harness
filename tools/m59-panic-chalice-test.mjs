import assert from 'node:assert/strict';
process.env.M59_FLEET??='panic-chalice-offline-test';
const {panicChalice,allocateDesks,refillSafety}=await import('./m59-panic-chalice.mjs');
const {chargePossibilities}=await import('./m59-rescue.mjs');
const {panicSteps}=await import('./fleetscripts/panic-chalice.mjs');

// Discrete concurrent clock: parallel desks/landings do not add their sleeps.
function clock(){
  let time=0,scheduled=false;const queue=[];
  const pump=()=>{scheduled=false;if(!queue.length)return;queue.sort((a,b)=>a.at-b.at);time=queue[0].at;
    const due=queue.filter(t=>t.at===time);for(const t of due)queue.splice(queue.indexOf(t),1);for(const t of due)t.resolve();
    if(queue.length&&!scheduled){scheduled=true;setImmediate(pump);}
  };
  return {now:()=>time,sleep:ms=>new Promise(resolve=>{queue.push({at:time+ms,resolve});if(!scheduled){scheduled=true;setImmediate(pump);}})};
}
async function fixture({holders=7,borrowers=2,charges=3,capacity=3,enemy=true,enemyDistance=0,enemyAppears=false,refillRoom=true,getFails=false,dropUnknown=false,notRefilled=false,far=false,blinkFails=false,tradeFails=false,returnFails=false,unknownTrade=false,unknownSip=false,pvp=false,unknownCharge=false,tradeMs=4000,rpcMs=100,delay=25000,saveChanges=false,missingLanding=false,deadlineCheck=false}={}){
  const timer=clock(),calls=[],bodies={},cups=[],floor=[],cupName='Chalice of the Rain';let saveSeen=false,floorReceiptSaved=false;
  for(let i=0;i<holders+borrowers;i++){
    const a=i<holders?'h'+i:'b'+(i-holders),c=i<holders?{id:i+1,name:cupName,charges,capacity}:null;
    bodies[a]={id:100+i,row:far&&i>=holders?40:19,col:8,room:refillRoom?2125:39,cup:c};if(c)cups.push(c);
  }
  const label=c=>{const pct=Math.floor(100*c.charges/c.capacity);return pct>90?'filled to the brim':pct>65?'mostly full':pct>30?'a few sips':pct>0?'almost empty':'completely empty';};
  const update=b=>{if(!missingLanding&&b.sip!=null&&timer.now()-b.sip>=delay)b.room=2001;};
  const call=async(name,args)=>{
    const a=args.agent,b=bodies[a];calls.push({name,...args,time:timer.now()});
    await timer.sleep(name==='supply'?tradeMs:rpcMs);if(b)update(b);
    if(name==='fleet')return {fleet:Object.keys(bodies).map(a=>({agent:a,character:a,in_roster:true}))};
    if(name==='look')return {room:{num:b.room,size:{rows:49,cols:49}},you:{object_id:b.id,row:b.row,col:b.col},hp:{value:90,max:90},objects:[...Object.entries(bodies).filter(([n,o])=>n!==a&&o.room===b.room).map(([n,o])=>({id:o.id,name:n,is_player:true,row:o.row,col:o.col,can:['offer']})),...(enemy||enemyAppears&&Object.values(bodies).some(o=>o.sip!=null)?[{id:999,name:'Enemy',is_player:true,relation:'enemy',row:19+enemyDistance,col:8}]:[])],exits:[]};
    if(name==='inventory')return {items:b.cup?[{id:b.cup.id,name:cupName}]:[],ids_as_of:0};
    if(name==='look_at')return {id:args.target,description:unknownCharge?'unknown':label(b.cup)};
    if(name==='autopilot'||name==='rest'||name==='cancel_movement')return {ok:true};
    if(name==='safe_spots')return {spots:[{row:b.row,col:b.col,distance:0,can_reach_you:0}]};
    if(name==='walk_to')return {arrived:false};
    if(name==='cast'){if(!blinkFails){b.row=19;b.col=8;}return {keeper_said:{relocated:!blinkFails}};}
    if(name==='supply'){
      assert.equal(args.who_travels,'neither');assert.equal(args.stationary,true);
      const from=bodies[args.from],to=bodies[args.to];update(from);update(to);
      if(tradeFails||returnFails&&args.from.startsWith('b'))return {supplied:false,reason:'survival preempted'};
      if(from.room!==to.room)return {supplied:false,reason:'departed'};
      assert.ok(from.cup);assert.ok(!to.cup,'NEVER MERGE CUPS');assert.equal(from.cup.id,args.what[0]);
      to.cup=from.cup;from.cup=null;if(unknownTrade)throw Error('trade reply lost after delivery');return {supplied:true};
    }
    if(name==='act'){
      if(args.verb==='drop'){
        assert.ok(floorReceiptSaved,'persist exact floor recovery receipt BEFORE drop');
        assert.ok(refillRoom);assert.equal(b.cup.id,args.target);assert.ok(!enemy||enemyDistance>11,'NO DROP INSIDE THEFT GUARD');
        assert.ok(!enemyAppears||!Object.values(bodies).some(o=>o.sip!=null),'FRESH ENEMY ARRIVAL MUST BLOCK DROP');
        if(!notRefilled)b.cup.charges=b.cup.capacity;
        floor.push(b.cup);assert.ok(floor.length<=1,'SERIALIZE FLOOR EXPOSURE PER ROOM');b.cup=null;if(dropUnknown)throw Error('drop reply lost');return {messages:['Your chalice is refilled.']};
      }
      if(args.verb==='get'){
        if(getFails)return {messages:['You cannot get that.']};
        assert.ok(!b.cup,'NO CUP MERGE ON RECOVERY');const i=floor.findIndex(c=>c.id===args.target);assert.ok(i>=0);b.cup=floor.splice(i,1)[0];return {};
      }
      assert.equal(args.verb,'use');
      assert.ok(saveSeen,'persist pending receipt BEFORE sip');
      assert.equal(b.cup.id,args.target);assert.ok(b.cup.charges>=2,'NEVER CONSUME LAST CHARGE');
      if(deadlineCheck)assert.ok(timer.now()-rpcMs<=85000,'NO LATE RESCUE START');
      if(pvp&&a.startsWith('b'))return {messages:['Only those who have walked the path of peace may partake of the chalice']};
      b.cup.charges--;b.sip=timer.now();
      if(unknownSip&&a.startsWith('b'))throw Error('reply lost after accepted sip');
      return {messages:['You sip a bit of the water out of the chalice.']};
    }
    throw Error(name);
  };
  const receipt=await panicChalice({call,agents:Object.keys(bodies),now:timer.now,sleep:timer.sleep,log:()=>{},save:r=>{floorReceiptSaved=r.cups.some(c=>c.floor_pending);if(saveChanges){saveSeen=Object.values(r.agents).some(a=>a.pending);}else saveSeen=true;}});
  if(!getFails&&!dropUnknown)assert.equal(floor.length,0);assert.ok(cups.every(c=>c.charges>=1));
  assert.ok(!calls.some(c=>c.name==='travel'));
  return {receipt,calls,bodies,cups,floor};
}

let tests=0;
async function test(name,fn){await fn();tests++;console.log('ok',name);}
await test('nine-person hostile-room evacuation: no floor, no empty cup, parallel desks under 60s',async()=>{
  const r=await fixture({saveChanges:true});assert.equal(r.receipt.ok,true);assert.ok(r.receipt.elapsed_ms<60000);
  const s=r.calls.filter(c=>c.name==='act'),firstBorrow=s.find(c=>c.agent.startsWith('b'));
  assert.ok(s.some(c=>c.agent==='h2'&&c.time<firstBorrow.time),'independent holders escape first');
  const firstTrades=r.calls.filter(c=>c.name==='supply'&&c.from.startsWith('h'));assert.equal(firstTrades.length,2);assert.ok(Math.abs(firstTrades[0].time-firstTrades[1].time)<1000);
  assert.ok(Object.values(r.bodies).filter(b=>b.cup).length===7);console.log('  simulated normal ms:',r.receipt.elapsed_ms);
});
await test('30-second gather fallback with slow trades remains below 120s',async()=>{
  const r=await fixture({far:true,tradeMs:8000,rpcMs:200});assert.equal(r.receipt.ok,true);assert.ok(r.receipt.elapsed_ms<120000);
  assert.ok(r.calls.filter(c=>c.name==='cast').every(c=>c.time>=30000));console.log('  simulated fallback ms:',r.receipt.elapsed_ms);
});
await test('one full three-charge cup serves one borrower, preserves owner escape and last charge',async()=>{
  const r=await fixture({holders:1,borrowers:3});assert.equal(r.receipt.ok,false);assert.equal(r.cups[0].charges,1);
  assert.equal(r.calls.filter(c=>c.name==='act').length,2);assert.equal(Object.values(r.receipt.agents).filter(a=>a.arrived).length,2);
});
await test('native pickup diamond and movement buffer: axial, diagonal, unknown, and enemy relation',async()=>{
  const l={room:{num:2125},you:{object_id:1,row:20,col:20},objects:[]};
  for(const [row,col,expected] of [[27,20,false],[24,23,false],[24,24,false],[31,20,false],[32,20,true],[26,26,true]]){
    l.objects=[{id:2,name:'Enemy',is_player:true,row,col}];assert.equal(refillSafety(l).ok,expected,JSON.stringify({row,col}));
  }
  l.objects=[{id:2,name:'Friend',is_player:true}];assert.equal(refillSafety(l).ok,false);
  assert.equal(refillSafety(l,new Set(['friend'])).ok,true);
  l.objects[0].relation='enemy';assert.equal(refillSafety(l,new Set(['friend'])).ok,false);
  l.objects=[];l.room.num=39;assert.equal(refillSafety(l).ok,false);
  l.room.num=2125;l.ids_stale=true;assert.equal(refillSafety(l).ok,false);
  delete l.ids_stale;delete l.objects;assert.equal(refillSafety(l).ok,false);
});
await test('one cup is safely renewable for several borrowers when jungle is clear',async()=>{
  const r=await fixture({holders:1,borrowers:3,enemy:false});assert.equal(r.receipt.ok,true);
  assert.equal(r.calls.filter(c=>c.name==='act'&&c.verb==='drop').length,2);assert.equal(r.cups[0].charges,1);
  for(let i=0;i<r.calls.length;i++)if(r.calls[i].name==='act'&&r.calls[i].verb==='drop'){
    const next=r.calls.slice(i+1).find(c=>c.agent===r.calls[i].agent);assert.equal(next.name,'act');assert.equal(next.verb,'get','NO READ/SLEEP BEFORE RECLAIM');
  }
});
await test('a last-charge cup refreshes before its owner drinks; no cup is emptied',async()=>{
  const r=await fixture({holders:1,borrowers:0,charges:1,enemy:false});assert.equal(r.receipt.ok,true);assert.equal(r.cups[0].charges,2);assert.equal(r.receipt.events.filter(e=>e.kind==='refilled').length,1);
});
await test('enemy beyond guard allows refill; one inside guard blocks it',async()=>{
  let r=await fixture({holders:1,borrowers:0,charges:1,enemyDistance:12});assert.equal(r.receipt.ok,true);
  r=await fixture({holders:1,borrowers:0,charges:1,enemyDistance:7});assert.equal(r.receipt.ok,false);assert.equal(r.calls.filter(c=>c.name==='act').length,0);
});
await test('enemy arriving after initial planning blocks a later refill',async()=>{
  const r=await fixture({holders:1,borrowers:3,enemy:false,enemyAppears:true});assert.equal(r.calls.filter(c=>c.name==='act'&&c.verb==='drop').length,0);assert.equal(r.receipt.ok,false);assert.ok(r.receipt.agents.h0.arrived);
});
await test('unknown/non-refill room never drops even when empty of enemies',async()=>{
  const r=await fixture({holders:1,borrowers:0,charges:1,enemy:false,refillRoom:false});assert.equal(r.receipt.ok,false);assert.equal(r.calls.filter(c=>c.name==='act').length,0);
});
await test('failed pickup freezes cup and preserves recovery receipt without a sip',async()=>{
  const r=await fixture({holders:1,borrowers:0,charges:1,enemy:false,getFails:true});assert.equal(r.receipt.ok,false);assert.equal(r.calls.filter(c=>c.name==='act'&&c.verb==='use').length,0);assert.ok(r.receipt.cups[0].floor_pending);assert.equal(r.receipt.cups[0].command_uncertain,true);
});
await test('concurrent owners serialize refills and never place two cups on the same floor',async()=>{
  const r=await fixture({holders:2,borrowers:0,charges:1,enemy:false});assert.equal(r.receipt.ok,true);assert.equal(r.receipt.events.filter(e=>e.kind==='refilled').length,2);
});
await test('one unresolved floor recovery prevents additional drops in that room',async()=>{
  const r=await fixture({holders:2,borrowers:0,charges:1,enemy:false,getFails:true});assert.equal(r.receipt.ok,false);assert.equal(r.calls.filter(c=>c.name==='act'&&c.verb==='drop').length,1);
});
await test('unknown drop is never blindly followed by get/retry',async()=>{
  const r=await fixture({holders:1,borrowers:0,charges:1,enemy:false,dropUnknown:true});assert.equal(r.receipt.ok,false);assert.deepEqual(r.calls.filter(c=>c.name==='act').map(c=>c.verb),['drop']);assert.ok(r.receipt.cups[0].floor_pending);
});
await test('room eligibility is not enough: refill must be proved full after recovery',async()=>{
  const r=await fixture({holders:1,borrowers:0,charges:1,enemy:false,notRefilled:true});assert.equal(r.receipt.ok,false);assert.equal(r.calls.filter(c=>c.name==='act'&&c.verb==='use').length,0);
});
await test('every native possible final charge is protected, including ambiguous few-sips condition',async()=>{
  for(const capacity of [3,4,5])for(let charges=1;charges<=capacity;charges++){
    const r=await fixture({holders:1,borrowers:0,charges,capacity});assert.ok(r.cups[0].charges>=1);
    if(charges===1)assert.equal(r.calls.filter(c=>c.name==='act').length,0);
  }
});
await test('unknown charge condition refuses all sips',async()=>{
  const r=await fixture({holders:1,borrowers:0,unknownCharge:true});assert.equal(r.calls.filter(c=>c.name==='act').length,0);assert.equal(r.receipt.ok,false);
});
await test('failed trade is never retried or replaced by a floor drop; owner escapes',async()=>{
  const r=await fixture({holders:1,borrowers:1,tradeFails:true});assert.equal(r.calls.filter(c=>c.name==='supply').length,1);assert.equal(r.receipt.agents.h0.arrived,true);assert.equal(r.receipt.agents.b0.arrived,undefined);
});
await test('lost trade reply freezes both parties despite a snapshot showing delivery',async()=>{
  const r=await fixture({holders:1,borrowers:1,unknownTrade:true});assert.equal(r.calls.filter(c=>c.name==='supply').length,1);assert.equal(r.calls.filter(c=>c.name==='act').length,0);assert.ok(r.bodies.b0.cup);assert.equal(r.receipt.cups[0].command_uncertain,true);assert.deepEqual(r.receipt.cups[0].uncertain_agents,['h0','b0']);
});
await test('failed return leaves cup with escaping borrower, never merges or spends it twice',async()=>{
  const r=await fixture({holders:1,borrowers:1,returnFails:true});assert.equal(r.receipt.agents.b0.arrived,true);assert.ok(r.bodies.b0.cup);assert.equal(r.calls.filter(c=>c.name==='act').length,1);
});
await test('unknown accepted sip is never repeated/traded while in flight; borrower keeps cup and lands',async()=>{
  const r=await fixture({holders:1,borrowers:1,unknownSip:true});assert.equal(r.receipt.ok,false);assert.equal(r.calls.filter(c=>c.name==='act'&&c.agent==='b0').length,1);assert.ok(r.receipt.agents.b0.arrived);assert.ok(r.bodies.b0.cup);assert.equal(r.calls.filter(c=>c.name==='supply').length,1);
});
await test('PvP refusal recovers borrowed cup, preserves all charges for that refusal',async()=>{
  const r=await fixture({holders:1,borrowers:1,pvp:true});assert.equal(r.receipt.ok,false);assert.equal(r.cups[0].charges,2);assert.equal(r.receipt.agents.h0.arrived,true);assert.match(r.receipt.agents.b0.failure,/PvP/);
});
await test('Blink failure reports stranded borrower, independent holders still escape',async()=>{
  const r=await fixture({far:true,blinkFails:true});assert.equal(r.receipt.ok,false);assert.ok(r.receipt.agents.h2.arrived);assert.ok(!r.calls.some(c=>c.name==='supply'));
});
await test('missing landing yields bounded manual-help failure with no repeat sip',async()=>{
  const r=await fixture({holders:1,borrowers:0,missingLanding:true});assert.equal(r.receipt.ok,false);assert.ok(r.receipt.elapsed_ms<60000);assert.equal(r.calls.filter(c=>c.name==='act').length,1);
});
await test('slow reads cannot bypass final rescue-start deadline',async()=>{
  const r=await fixture({holders:1,borrowers:0,rpcMs:10000,deadlineCheck:true});assert.equal(r.calls.filter(c=>c.name==='act').length,0);assert.equal(r.receipt.ok,false);
});
await test('early teleport during a slow return keeps cup with borrower and alerts owner',async()=>{
  const r=await fixture({holders:1,borrowers:1,tradeMs:18000,delay:15000});assert.equal(r.receipt.agents.b0.arrived,true);assert.ok(r.bodies.b0.cup);assert.ok(!r.receipt.agents.h0.arrived);
});
await test('per-agent catalog compilation shares one run',async()=>{
  const agents=['a','b','c'];let executions=0;
  const execute=async()=>{executions++;return {agents:Object.fromEntries(agents.map(a=>[a,{arrived:true}]))};};
  const plans=await Promise.all(agents.map(agent=>panicSteps({agents,agent},{execute})));
  const results=await Promise.all(plans.map((steps,i)=>steps[0].fn({agent:agents[i],call:()=>{throw Error('unexpected RPC');}})));
  assert.equal(executions,1);assert.ok(results.every(r=>r.ok));
  const second=await Promise.all(agents.map(agent=>panicSteps({agents,agent},{execute})));
  await Promise.all(second.map((steps,i)=>steps[0].fn({agent:agents[i],call:()=>{throw Error('unexpected RPC');}})));
  assert.equal(executions,2,'same agent array can run a new operation after finishing');
});
console.log(`${tests} panic-chalice scenarios passed`);
