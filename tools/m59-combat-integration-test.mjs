// Offline integration: real sender and compiler, fixture packets, fake RPC.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { Session } from './m59-game.mjs';
import { M59Client, BP } from './m59-client.mjs';
import { CombatMode } from './m59-combat-mode.mjs';
import { TickLoop } from './m59-tick.mjs';
import { Autopilot } from './m59-autopilot.mjs';
import { OF } from './m59-parse.mjs';
import { bodyAuthority, withBodyCommand } from './m59-body-command.mjs';
import { readBoard, post, writeBoard } from './m59-board.mjs';

// A hazard can arrive AFTER planning and while waiting in the actual sender's
// queue. Exercise the real queueValidatedMove boundary rather than its helper.
{
  const objects = new Map(); let queued, wire = 0;
  const c = { self: { row: 4, col: 4, x: 288, y: 288 }, room: { id: 40, objects }, evSeq: 0,
    rsc: new Map([[9, 'wall of fire']]), moveTo() { wire++; } };
  const s = { client: c, need: () => c, world: { room: { num: 38 } },
    validateFineTarget: (x, y) => ({ available: true, moved: true, arrived: true, target: { x, y } }),
    groundEffectBlock: Session.prototype.groundEffectBlock,
    pacer: { submit(_kind, fn) { return new Promise(resolve => { queued = () => resolve(fn()); }); } } };
  const pending = Session.prototype.queueValidatedMove.call(s, 480, 288);
  objects.set(9, { id: 9, nameRsc: 9, row: 4, col: 6, flags: 67 });
  queued(); const result = await pending;
  assert.equal(result.sent, false); assert.equal(result.validation.reason, 'ground_effect_blocked');
  assert.equal(wire, 0);
  objects.clear();
  const clear = Session.prototype.queueValidatedMove.call(s, 480, 288); queued();
  assert.equal((await clear).sent, true); assert.equal(wire, 1);
}
console.log('PASS real Session sender rejects newly appeared ground effects after pacing');

// Even direct protocol sends (the alternate tick driver's fast path) cannot
// escape the active body owner. Keepalive/observation remain available.
{
  let wire = 0;
  const s = { combatEpoch: 1, combat: { active: { id: 'order' } } };
  const c = { state: 'game', seeds: null, sock: { write() { wire++; } },
    _outboundActivity() {}, beforeGameMutation: () => bodyAuthority(s).guard() };
  assert.throws(() => M59Client.prototype.send.call(c, BP.REQ_ATTACK, Buffer.alloc(5)), /preempted/);
  M59Client.prototype.send.call(c, BP.REQ_INVENTORY);
  withBodyCommand(s, () => M59Client.prototype.send.call(c, BP.REQ_ATTACK, Buffer.alloc(5)), 'order');
  assert.equal(wire, 2);
}
console.log('PASS direct protocol actions honor combat authority while reads remain available');

// The original death loop bypassed the pacer by destroying the socket. Exercise
// the real Session.rejoin and keeper recovery dispatch after hostile player fire.
{
  let destroyed = 0, attacks = 0, resume;
  const c = { state:'game', selfId:1, self:{id:1,row:5,col:5},
    room:{id:3900,objects:new Map([[2,{id:2,name:'Assailant',row:5,col:6,flags:OF.PLAYER|OF.ATTACKABLE}]])},
    vitals:()=>({health:{value:1,max:51}}), stand(){},face(){},attack(){attacks++;},
    sock:{destroy(){destroyed++;}} };
  const s = Object.assign(Object.create(Session.prototype), {name:'recovery-fixture',client:c,
    credentials:{character:'Victim'},world:{room:{num:39}},combatEpoch:0,
    cancelMovement(){},pacer:{wake(){},submit:async(_kind,fn)=>{bodyAuthority(s).guard();return fn();}}});
  const k = Object.assign(Object.create(Autopilot.prototype), {s,policy:{},
    revive(){},adoptRecoveryWall(){assert.fail('PvP cannot choose a healing wall');}});
  s.combat = new CombatMode(s,{keeper:()=>k,schedule:()=>1,unschedule(){}});
  const staleRecovery = withBodyCommand(s,async()=>{
    await new Promise(r=>{resume=r;});await s.rejoin();
  });
  const rejected = assert.rejects(staleRecovery,/preempted/);
  s.combat.event({kind:'message',text:'Assailant hits you.'});
  resume();await rejected;
  await k.playDead('low HP');await k.continueSurvivalDecision();
  assert.equal(destroyed,0);assert.equal(attacks,1);assert.equal(s.combat.pvpStatus().active,true);
  s.combat.issue({action:'stop'});
}
console.log('PASS real recovery dispatch and stale raw reconnect cannot interrupt low-HP return fire');

// Raw tick movement bypasses Session.queueValidatedMove but must still honor
// the late movement hook before a packet or a sent breadcrumb is produced.
{
  let wire = 0;
  const c = { send() { wire++; }, room: { id: 38 },
    beforeMove(point) { assert.deepEqual(point, { x: 480, y: 288 }); throw Error('ground_effect_blocked'); } };
  assert.throws(() => M59Client.prototype.moveTo.call(c, 480, 288), /ground_effect_blocked/);
  assert.equal(wire, 0);
}
console.log('PASS raw tick movement honors the ground-effect hook before sending');

// Exercise the real alternate farming scheduler: passive watch permits decide;
// active combat owns the body; disappearance returns it to decide automatically.
{
  let farmTicks = 0;
  const c = { selfId:1, self:{id:1,row:5,col:5}, room:{id:3900,objects:new Map()},
    rsc:new Map([[2,'Fixture Target']]), vitals:()=>({health:{value:100,max:100}}), stand(){}, face(){}, attack(){} };
  const s = {name:'fixture', client:c, live:true, combatEpoch:0, need:()=>c, world:{room:{num:39}},
    cancelMovement(){}, pacer:{wake(){}, submit:async(_kind,fn)=>fn()}};
  const keeper = {mode:'farm',running:true,policy:{}};
  s.combat = new CombatMode(s,{keeper:()=>keeper,schedule:()=>1,unschedule(){}});
  const loop = new TickLoop({session:s,decide:()=>{bodyAuthority(s).guard();farmTicks++;}});
  loop.sensor.read = () => ({in_game:true,room:{num:39},position:{row:5,col:5}});
  loop._lastGuardLogAt = Date.now(); loop._lastBeatAt = Date.now();
  s.combat.issue({action:'kill',target:'Fixture Target',when_absent:'farm',watch_maps:[39,544]});
  loop.tick(); assert.equal(farmTicks,1);
  c.room.objects.set(2,{id:2,nameRsc:2,row:5,col:6,flags:OF.PLAYER|OF.ATTACKABLE});
  s.combat.event({kind:'appeared',id:2}); loop.tick(); assert.equal(farmTicks,1);
  c.room.objects.delete(2); s.combat.event({kind:'vanished',id:2});
  loop.tick(); assert.equal(farmTicks,2); s.combat.issue({action:'stop'});
  await new Promise(resolve=>setImmediate(resolve));
}
console.log('PASS real TickLoop farms during a passive watch and resumes after target disappearance');

const fleetEnv = process.env.M59_FLEET, urlEnv = process.env.M59_CONTROL_URL, realFetch = globalThis.fetch;
try {
  process.env.M59_FLEET = 'combat-offline-fixture';
  process.env.M59_CONTROL_URL = 'http://127.0.0.1:1/';
  const calls = [];
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body.params);
    assert.equal(body.params.name, 'combat', 'no status, health, lease or inventory preflight');
    return { json: async () => ({ result: { content: [{ type: 'text', text: JSON.stringify({ accepted: true, order_id: 'fixture' }) }] } }) };
  };
  const { fleetScript, attackPlayer, fleetCombat, killPlayer } = await import('./m59-fleetscript.mjs');
  const result = await fleetScript({ name: 'fast path', mode: 'combat', agents: ['a', 'b'], steps: [attackPlayer('Target')] });
  assert.equal(result.ok, true); assert.equal(calls.length, 2);
  assert.ok(calls[0].arguments.fleet_state.endsWith('combat-offline-fixture.json'));
  globalThis.fetch = async (_url, opts) => {
    const p = JSON.parse(opts.body).params; calls.push(p);
    assert.equal(p.name, 'combat_order');
    assert.equal(p.arguments.room, 'Upstairs Castle Victoria');
    assert.equal(p.arguments.action, 'kill');
    return {json: async () => ({result: {content: [{type:'text', text:JSON.stringify({ok:true, results:[]})}]}})};
  };
  await fleetCombat({room:'Upstairs Castle Victoria', order:killPlayer('Target')});
  assert.equal(calls.length, 3, 'room selection must use one RPC, without fleet inspection');
  globalThis.fetch = async (_url, opts) => {
    const p = JSON.parse(opts.body).params; calls.push(p);
    assert.equal(p.name,'combat_order'); assert.deepEqual(p.arguments.rooms,[39,544]);
    assert.equal(p.arguments.when_absent,'farm');
    return {json:async()=>({result:{content:[{type:'text',text:JSON.stringify({ok:true,results:[]})}]}})};
  };
  await fleetCombat({rooms:[39,544],order:killPlayer('Target',{when_absent:'farm'})});
  assert.equal(calls.length,4);
  globalThis.fetch = async () => ({ json: async () => ({ result: { isError: true,
    content: [{ type: 'text', text: 'error: WRONG BROKER' }] } }) });
  const refusal = await fleetScript({ mode: 'combat', agents: ['a'], steps: [attackPlayer('Target')] });
  assert.equal(refusal.ok, false); assert.match(refusal.results[0].error, /WRONG BROKER/);
} finally {
  globalThis.fetch = realFetch;
  if (fleetEnv == null) delete process.env.M59_FLEET; else process.env.M59_FLEET = fleetEnv;
  if (urlEnv == null) delete process.env.M59_CONTROL_URL; else process.env.M59_CONTROL_URL = urlEnv;
}
console.log('PASS real FleetScript combat path sends only addressed combat RPC and reports refusals');

// Drive the real terminal while an ordinary pad's setup is still awaiting.
// No game/broker socket: the child's fetch is replaced by a deterministic import.
const root = mkdtempSync(join(tmpdir(), 'm59-combat-integration-'));
let child;
try {
  const pads = join(root, 'pads'), board = join(root, 'board');
  mkdirSync(pads); mkdirSync(board);
  writeFileSync(join(pads, 'slow.mjs'), `export const script = {
    name:'slow', describe:'offline slow setup', params:{agents:{required:true}},
    setup:async()=>{console.log('FIXTURE_SLOW_STARTED'); await new Promise(r=>setTimeout(r,600));
      console.log('FIXTURE_SLOW_FINISHED'); throw new Error('fixture ends before any errand');}, steps:()=>[]};`);
  writeFileSync(join(pads, 'ambush.mjs'), `export const script = {
    name:'ambush', mode:'combat', describe:'offline combat pad', params:{agents:{required:true}},
    steps:()=>[{action:'ambush',target:'Target',map:38,position:{row:4,col:12}}]};`);
  const env = { ...process.env, M59_BOARD_DIR: board, M59_FLEET: 'combat-fixture',
    M59_FLEETSCRATCH_DIR: pads, M59_SCRATCH_OPERATOR: 'offline combat test', M59_CONTROL_URL: 'http://127.0.0.1:1/' };
  let record = readBoard('combat-fixture', env);
  for (const name of ['slow', 'ambush']) record = post(record, { name, by: 'test', purpose: 'offline integration', agents: ['a'] });
  writeBoard({ ...record, fleet: 'combat-fixture' }, env);
  const mock = join(root, 'mock.mjs');
  writeFileSync(mock, `globalThis.fetch=async(url,opts)=>{
    const p=JSON.parse(opts.body).params;
    if(p.name!=='combat')throw Error('unexpected RPC '+p.name);
    console.log('FIXTURE_COMBAT_SENT:'+p.arguments.action);
    if(p.arguments.action==='attack'){
      await new Promise(r=>setTimeout(r,500));console.log('FIXTURE_ATTACK_REPLY');
    }
    return {json:async()=>({result:{content:[{type:'text',text:JSON.stringify({accepted:true,order_id:'fixture'})}]}})};
  };`);
  child = spawn(process.execPath, ['--import', pathToFileURL(mock).href, fileURLToPath(new URL('./m59-fleetscratch.mjs', import.meta.url))],
    { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', sent = false, stopped = false;
  child.stdout.on('data', chunk => {
    output += chunk;
    if (!sent && output.includes('FIXTURE_SLOW_STARTED')) {
      sent = true;
      child.stdin.write('combat attack "Target" agents=a\ncombat run ambush agents=a\n');
    }
    if (!stopped && output.includes('FIXTURE_COMBAT_SENT:attack') && output.includes('FIXTURE_COMBAT_SENT:ambush')) {
      stopped = true; child.stdin.end('combat stop agents=a\nquit\n');
    }
  });
  child.stderr.on('data', chunk => { output += chunk; });
  child.stdin.write('go slow agents=a\n');
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`terminal fixture timed out: ${output}`)), 10000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? done() : reject(new Error(output)); });
  });
  assert.ok(output.includes('FIXTURE_COMBAT_SENT:attack'), output);
  assert.ok(output.includes('FIXTURE_COMBAT_SENT:ambush'), output);
  assert.ok(output.includes('FIXTURE_COMBAT_SENT:stop'), output);
  assert.ok(output.indexOf('FIXTURE_COMBAT_SENT:stop') < output.indexOf('FIXTURE_ATTACK_REPLY'), output);
  assert.ok(output.indexOf('FIXTURE_COMBAT_SENT:attack') < output.indexOf('FIXTURE_SLOW_FINISHED'), output);
  assert.ok(output.indexOf('FIXTURE_COMBAT_SENT:ambush') < output.indexOf('FIXTURE_SLOW_FINISHED'), output);
  console.log('PASS FleetScratch combat and stop bypass both ordinary work and pending combat receipts');
} finally {
  if (child && child.exitCode === null) child.kill();
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith('m59-combat-integration-'));
  rmSync(root, { recursive: true, force: true });
}
