// Offline quest scenarios: real FleetScript plan and quest callbacks, fake game replies.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const temp = mkdtempSync(join(tmpdir(), 'm59-riija-test-'));
process.env.M59_QUESTBOOK_DIR = temp;
const { script, readShipment, SHIPMENTS, queenNear, refresh, offer, ROOMS, NPCS } =
  await import('./fleetscripts/riija-sword.mjs');
const { resolveStep } = await import('./m59-fleetscript.mjs');
const { listRuns, saveRun } = await import('./m59-questbook.mjs');
let tests = 0;
const test = async (name, fn) => { await fn(); tests++; console.log(`ok ${name}`); };
let nextId = 100;
function game({ supplies = true, head = true, foreign = false, noReward = false } = {}) {
  let room = 2011, row = 10, col = 10, pending = [], seq = 0;
  const items = [], offers = [], sayings = [];
  const add = (name, amount = 1, icon_rsc = ++nextId + 900000) => {
    const i = { id: ++nextId, name, amount, icon_rsc }; items.push(i); return i;
  };
  if (head) add('orc pit boss head');
  add('chunk of nerudite'); add('meat pies', 5);
  if (supplies) add('herbs', 250);
  const q = { id: 44, name: 'dragonfly queen', row, col };
  let mastered = false, rewarded = new Set();
  const npcs = Object.entries(NPCS).map(([key, name], i) => ({ id: 60 + i, name, key, row, col }));
  const npcRoom = { trader: ROOMS.trader, bowmaker: ROOMS.bowmaker,
    priestess: ROOMS.priestess, scientist: ROOMS.scientist };
  const award = key => {
    if (noReward) return;
    rewarded.add(key);
    if (rewarded.size === 4) {
      for (let i = items.length - 1; i >= 0; i--) if (items[i].name === 'shard of a sword') items.splice(i, 1);
      add('sword of Riija');
    } else add('shard of a sword');
  };
  const ctx = { agent: `test${++nextId}`, fleet: 'offline', state: {},
    call: async (name, args) => {
      if (name === 'status') return { character: 'Quest Tester' };
      if (name === 'inventory') return { items: items.map(i => ({ ...i })) };
      if (name === 'look') return { room: { num: room }, you: { name: 'Quest Tester', row, col }, objects: [
        ...npcs.filter(n => npcRoom[n.key] === room).map(n => ({ ...n, row, col })),
        ...(room === ROOMS.hive || mastered ? [{ ...q, row, col }] : []),
      ] };
      if (name === 'look_at') {
        const i = items.find(i => i.id === args.target);
        return { description: i?.name === 'sword of Riija'
          ? `Some of the runes say, "Let ${foreign ? 'Someone Else' : 'Quest Tester'} walk with faith."`
          : `${foreign ? 'Someone Else' : 'Quest Tester'}'s name is written in subtle, glowing eldritch script on the metal of the shard.` };
      }
      if (name === 'walk_to') { row = args.row; col = args.col; return { arrived: true }; }
      if (name === 'wait_for_event') {
        if (args.timeout_ms === 1) return { cursor: seq };
        const events = pending.map(text => ({ text, seq: ++seq })); pending = [];
        return { cursor: seq, events, timed_out: true };
      }
      if (name === 'say') {
        sayings.push({ room, text: args.text });
        if (args.text === 'inventory') pending = ["I'm always looking for people to help replenish my inventory. If you'd be willing to bring me 250 herbs, I can make it well worth your trip."];
        if (args.text === 'arrows') pending = ['Go, see if you can find an avar willing to trade a tailfeather for something they find precious.'];
        if (args.text === 'riija') pending = ['Wak-wak! Hedd of Pit Boss! Wak wak wa-ak!'];
        if (args.text === 'kohuzotz') {
          if (mastered && room === ROOMS.scientist) { award('B'); pending = ['Excellent. Good work, fair apprentice.']; }
          else pending = ['If you bring me a live specimen, I might have something interesting to give you in return.'];
        }
        return { said: true };
      }
      throw Error(`Unexpected broker call ${name}`);
    },
    keeper: async (name, args) => {
      assert.equal(name, 'trade');
      const offered = items.find(i => i.id === args.items[0].id);
      assert.ok(offered);
      offers.push({ room, name: offered.name, amount: args.items[0].amount, to: args.to_id });
      offered.amount -= args.items[0].amount;
      if (!offered.amount) items.splice(items.indexOf(offered), 1);
      if (args.to_id === q.id) mastered = true;
      else if (room === ROOMS.trader) award('C');
      else if (room === ROOMS.bowmaker) award('D');
      else if (offered.name === 'chunk of nerudite') add('feather of an avar shaman');
      else if (offered.name === 'orc pit boss head') award('A');
      return { sent: true };
    },
  };
  return { ctx, items, offers, sayings, add, setRoom(n) { room = n; },
    async run(plan, { stopAt = Infinity } = {}) {
      let i = 0;
      for (const raw of await plan) {
        if (i++ >= stopAt) break;
        const s = resolveStep(raw, ctx.state);
        if (s.do === 'walk') { room = s.to; continue; }
        if (s.do === 'walk_to') { if (s.col != null) { row = s.row; col = s.col; } continue; }
        const r = await s.fn(ctx);
        assert.equal(r.ok, true, s.why);
      }
    },
  };
}
try {
  await test('all eight good-karma shipment quantities and unknown asks', async () => {
    for (const s of SHIPMENTS) {
      const p = readShipment([`help replenish my inventory: ${s.amount} ${s.name}`]);
      assert.equal(p.amount, s.amount); assert.equal(p.name, s.name);
    }
    assert.equal(readShipment(['help replenish my inventory: a chess board']), null);
    assert.equal(readShipment(['250 herbs']), null);
  });
  await test('queen guard checks identity, position and symmetric distance', async () => {
    const v = { you: { row: 30, col: 61 }, objects: [{ id: 5, name: 'dragonfly queen', row: 29, col: 60 }] };
    assert.ok(queenNear(v, 5)); assert.ok(!queenNear(v, 6));
    v.objects[0].row = 1; assert.ok(!queenNear(v, 5));
    v.objects[0].row = undefined; assert.ok(!queenNear(v, 5));
  });
  await test('delivery requires read-back proximity and preserves the stack on failure', async () => {
    let sent = false;
    const ctx = { agent: 'distance-test', state: {},
      call: async name => name === 'inventory' ? { items: [{ id: 1, name: 'herbs', amount: 250 }] }
        : name === 'look' ? { room: { num: ROOMS.trader }, you: { row: 1, col: 1 },
          objects: [{ id: 2, name: NPCS.trader, row: 30, col: 61 }] } : { arrived: true },
      keeper: async () => { sent = true; return { sent: true }; },
    };
    await assert.rejects(() => offer(ctx, NPCS.trader, /^herbs$/, 250), /five squares/);
    assert.equal(sent, false);
    await assert.rejects(() => offer(ctx, NPCS.trader, /^herbs$/, 251), /one stack/);
  });
  await test('compile has no broker calls; exactly one agent and valid home required', async () => {
    const steps = await script.steps({ agents: ['one'], home: 2011 });
    assert.equal(steps.at(-1).do, 'walk'); assert.equal(steps.at(-1).always, true);
    await assert.rejects(() => script.steps({ agents: ['one', 'two'] }), /exactly one/);
    await assert.rejects(() => script.steps({ agents: ['one'], home: 0 }), /positive room/);
  });
  await test('four quest callbacks, exact offers, queen escort and owned final sword', async () => {
    const g = game();
    await g.run(await script.steps({ agents: [g.ctx.agent] }));
    assert.ok(g.ctx.state.complete);
    assert.deepEqual(g.offers.map(o => [o.name, o.amount]), [
      ['herbs', 250], ['chunk of nerudite', 1], ['feather of an avar shaman', 1],
      ['orc pit boss head', 1], ['meat pies', 1],
    ]);
    assert.ok(g.items.some(i => i.name === 'sword of Riija'));
    assert.equal(listRuns({ fleet: 'offline' }).runs.find(r => r.agent === g.ctx.agent).outcome, 'ok');
    const before = g.sayings.length;
    await g.run(await script.steps({ agents: [g.ctx.agent] }));
    assert.equal(g.sayings.length, before, 'completed rerun must say nothing');
  });
  await test('missing raid head refuses before speech or movement', async () => {
    const g = game({ head: false });
    await assert.rejects(() => g.run(awaitPlan(g)), /Stage an orc pit boss head/);
    assert.equal(g.sayings.length, 0); assert.equal(g.offers.length, 0);
  });
  await test('missing shipment is recorded and resumes without asking again', async () => {
    const g = game({ supplies: false });
    await assert.rejects(() => g.run(awaitPlan(g)), /Need one stack of 250/);
    assert.equal(g.offers.length, 0);
    const saved = listRuns({ fleet: 'offline' }).runs.find(r => r.agent === g.ctx.agent);
    assert.deepEqual(saved.open.C.shipment.name, 'herbs');
    g.add('herbs', 250);
    g.ctx.state = {};
    await g.run(await script.steps({ agents: [g.ctx.agent] }));
    assert.equal(g.sayings.filter(s => s.text === 'inventory').length, 1);
    assert.ok(g.ctx.state.complete);
  });
  await test('expired assignments do not send another trigger or offer', async () => {
    const g = game({ supplies: false });
    await assert.rejects(() => g.run(awaitPlan(g)), /Need one stack/);
    const saved = listRuns({ fleet: 'offline' }).runs.find(r => r.agent === g.ctx.agent);
    saved.open.C.deadline = Date.now() - 1;
    saveRun(saved, { fleet: 'offline' });
    const said = g.sayings.length;
    g.ctx.state = {};
    await assert.rejects(() => g.run(awaitPlan(g)), /deadline expired/);
    assert.equal(g.sayings.length, said); assert.equal(g.offers.length, 0);
  });
  await test('an offer acknowledgment without a reward is a failure', async () => {
    const g = game({ noReward: true });
    await assert.rejects(() => g.run(awaitPlan(g)), /No verified C shard/);
    assert.ok(!g.ctx.state.complete);
    assert.ok(listRuns({ fleet: 'offline' }).runs.find(r => r.agent === g.ctx.agent).open.C);
    g.add('herbs', 250); g.ctx.state = {};
    await assert.rejects(() => g.run(awaitPlan(g)), /earlier delivery was sent/);
    assert.equal(g.offers.length, 1, 'uncertain deliveries must not be resent');
  });
  await test('foreign sword and unreadable inventory never prove completion', async () => {
    const g = game({ foreign: true }); g.add('sword of Riija');
    await assert.rejects(() => g.run(awaitPlan(g)), /belonging to this character/);
    g.ctx.call = async () => ({ error: 'disconnected' });
    await assert.rejects(() => refresh(g.ctx), /unreadable or stale/);
  });
  await test('a removed sword clears an earlier success reading', async () => {
    const g = game(); g.ctx.state.record = { character: 'Quest Tester', icons: {}, open: {}, heard: [] };
    const sword = g.add('sword of Riija'); await refresh(g.ctx); assert.ok(g.ctx.state.complete);
    g.items.splice(g.items.indexOf(sword), 1); await refresh(g.ctx); assert.equal(g.ctx.state.complete, false);
  });
  console.log(`${tests} offline scenario groups passed. No live game was contacted.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

// Promise-to-plan adapter is deliberately outside the fake runner's broker API.
async function awaitPlan(g) { return script.steps({ agents: [g.ctx.agent] }); }
