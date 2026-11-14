// OFFLINE: the Sword of Riija phases -- tools/m59-riija.mjs (tables, manifest, pit puzzle, barrier) and
// the three FleetScripts riija-prep, riija-pitboss and riija-quester -- against a fake world. No socket,
// no broker, no roster. Run: node tools/m59-riija-test.mjs
//
// What it pins: the request line is read off Wulfgang's KARMA table and refused when it cannot be
// placed; the manifest for each side is the whole table plus the route's items; the pit ratio and
// the chamber squares; that a stale barrier mark from a dead run can neither open nor shut a gate;
// and, end to end on the real step lists, that the quester asks, persists, draws EXACTLY the named
// shipment from 713, delivers to the right NPC, resumes an open node without asking again, refuses a
// neutral character, does the evil feather by its own kill, and wields the bound sword -- and that the
// pit team stands, pulls, fights and stows the head, and stops together when one body is misplaced.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'm59-riija-test-'));
mkdirSync(join(temp, 'substrate'), { recursive: true });
process.env.M59_QUESTBOOK_DIR = join(temp, 'questbook');
process.env.M59_STORAGE_DIR = join(temp, 'storage');
const home = process.cwd();
process.chdir(temp);                 // posture files land in <cwd>/substrate -- keep them out of the repo

const R = await import('./m59-riija.mjs');
const { script: quester, SHAMAN_ROOMS, queenNear, ledgerId } = await import('./fleetscripts/riija-quester.mjs');
const { script: pitboss, inBossArea } = await import('./fleetscripts/riija-pitboss.mjs');
const { script: prep, prepPlan } = await import('./fleetscripts/riija-prep.mjs');
const { resolveStep } = await import('./m59-fleetscript.mjs');
const { loadRun } = await import('./m59-questbook.mjs');

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`); }
};

// ---------------------------------------------------------------- a tiny runner with the real skip rule

async function runPlan(plan, ctxFor, exec) {
  let failure = null;
  const results = [];
  for (let i = 0; i < plan.length; i++) {
    const raw = plan[i];
    if (failure && !raw.always) continue;
    const s = resolveStep(raw, ctxFor().state);
    let r;
    try { r = await exec(s); } catch (e) { r = { ok: false, why: e.message }; }
    if (s.do === 'verify') {
      const said = r !== null && typeof r === 'object' && 'ok' in r;
      r = said ? r : { ok: !!r };
    }
    results.push({ at: i, do: s.do, ...r });
    if (!r.ok) {
      if (s.optional) {
        if (s.do === 'walk') while (i + 1 < plan.length && plan[i + 1].do !== 'walk' && !plan[i + 1].anywhere) i++;
        continue;
      }
      failure ??= { at: i, do: s.do, why: r.why };
    }
  }
  return { failure, results };
}

// ---------------------------------------------------------------- a fake Ko'catan for one quester

let nextId = 1000;
function island({ karma = 30, shipment = 'apples150', hallStock = null, character = 'Quest Tester', npcLines = true } = {}) {
  const W = { room: 2001, row: 5, col: 5, items: [], hall: [], said: [], offers: [], draws: [], deposits: [], pending: [],
    seq: 0, awarded: new Set(), queen: null, mastered: false, floor: {}, wield: new Set(), asked: [] };
  const add = (list, name, amount = 1) => {
    const it = list.find(i => i.name === name && amount > 0 && name !== 'shard of a sword');
    if (it) { it.amount += amount; return it; }
    const n = { id: ++nextId, name, amount, icon_rsc: 900000 + nextId };
    list.push(n); return n;
  };
  for (const [n, a] of Object.entries(hallStock ?? { 'orc pit boss head': 1, 'chunk of nerudite': 2, 'meat pie': 60,
    apple: 150, 'goblet of wine': 70, 'bunch of grapes': 200 })) add(W.hall, n, a);
  const npcs = { 2101: { id: 61, name: "Wulfgang zax'Ak" }, 2100: { id: 62, name: "Hanla zax'Ta" },
                 2141: { id: 63, name: 'The Bone Priestess' }, 2136: { id: 64, name: "Bahal zax'Ot" } };
  const award = key => {
    W.awarded.add(key);
    if (W.awarded.size === 4) {
      W.items = W.items.filter(i => i.name !== 'shard of a sword');
      add(W.items, 'sword of Riija');
    } else add(W.items, 'shard of a sword');
  };
  const shipmentLine = {
    apples150: 'bring me 150 apples',
    pies50: 'bring me fifty meat pies',
    wine70: 'bring me seventy goblets of wine',
    chess: 'bring me a chess board',
  }[shipment];
  const call = async (name, args) => {
    switch (name) {
      case 'status': return { character, karma: { value: karma }, hp: { value: 100, max: 100 } };
      case 'inventory': return { items: W.items.map(i => ({ ...i })) };
      case 'look': {
        const objects = [];
        if (npcs[W.room]) objects.push({ ...npcs[W.room], row: W.row + 1, col: W.col });
        if (W.room === 2111 && !W.mastered) objects.push({ id: 77, name: 'dragonfly queen', row: W.row + 3, col: W.col });
        if (W.mastered) objects.push({ id: 77, name: 'dragonfly queen', row: W.row + 1, col: W.col + 1 });
        for (const f of W.floor[W.room] ?? []) objects.push({ ...f, row: W.row, col: W.col });
        return { room: { num: W.room }, you: { name: character, row: W.row, col: W.col }, objects };
      }
      case 'look_at': {
        const i = W.items.find(x => x.id === args.target);
        return { description: i?.name === 'sword of Riija' ? `The runes say, "Let ${character} walk with faith."`
          : `This is one piece.  ${character}'s name is written in subtle, glowing eldritch script on the metal of the shard.` };
      }
      case 'walk_to': W.row = args.row; W.col = args.col; return { arrived: true };
      case 'wait_for_event': {
        if (args.timeout_ms === 1) return { cursor: W.seq };
        const events = W.pending.map(text => ({ text, seq: ++W.seq })); W.pending = [];
        return { cursor: W.seq, events, timed_out: true };
      }
      case 'say': {
        W.said.push({ room: W.room, text: args.text });
        if (!npcLines) return { said: true };
        const evil = karma <= -10;
        if (args.text === 'inventory' && W.room === 2101) W.pending.push(`I'm always looking for people to help replenish my inventory.  If you'd be willing to ${shipmentLine}, I can make it well worth your trip.`);
        if (args.text === 'arrows' && W.room === 2100) W.pending.push(evil
          ? 'I use special materials to make my best arrows.  Go, kill avar shamans until you find one which offers a suitably undamaged tailfeather.'
          : 'I use special materials.  Go, see if you can find an avar willing to trade a tailfeather for something they find precious.');
        if (args.text === 'riija' && W.room === 2141) W.pending.push('Wak-wak!  Hedd of Pit Boss!  Wak wak wa-ak!');
        if (args.text === 'kohuzotz' && W.room === 2136) {
          if (W.mastered) { W.mastered = false; award('B'); W.pending.push('Excellent.  Good work, fair apprentice.'); }
          else W.pending.push('I am always eager to experiment on my pets.  If you bring me a live specimen, I might have something interesting to give you in return.');
        }
        return { said: true };
      }
      case 'hall_withdraw': {
        if (W.room !== 713) return { ok: false, why: 'not in the hall' };
        const took = {};
        for (const w of args.wants ?? []) {
          const src = W.hall.find(i => i.name === w.item);
          const n = Math.min(src?.amount ?? 0, w.amount);
          if (n > 0) { src.amount -= n; add(W.items, w.item, n); took[w.item] = n; W.draws.push({ item: w.item, amount: n }); }
        }
        for (const d of args.deposit ?? []) {
          for (const it of W.items.filter(i => i.name.toLowerCase().includes(String(d).toLowerCase()))) {
            add(W.hall, it.name, it.amount); W.deposits.push({ item: it.name, amount: it.amount });
            W.items.splice(W.items.indexOf(it), 1);
          }
        }
        return { ok: true, took };
      }
      case 'loot': {
        const fl = W.floor[W.room] ?? [];
        for (const id of args.ids ?? []) { const f = fl.find(x => x.id === id); if (f) { add(W.items, f.name, 1); fl.splice(fl.indexOf(f), 1); } }
        return { taken: [] };
      }
      case 'equipment': return { known: true, equipped: [...W.wield].map(name => ({ id: -1, name })) };
      case 'act': { if (args.verb === 'use') { const i = W.items.find(x => x.id === args.target); if (i) W.wield.add(i.name); } return { ok: true }; }
      case 'autopilot': return args.action === 'status' ? { mode: 'farm', policy: { mode: 'survive' } } : { ok: true };
      default: throw Error(`unexpected broker call ${name}`);
    }
  };
  const keeper = async (name, args) => {
    assert.equal(name, 'trade'); assert.equal(args.op, 'offer');
    const it = W.items.find(i => i.id === args.items[0].id);
    assert.ok(it, 'offered an item the pack does not hold');
    const amount = args.items[0].amount;
    assert.ok(it.amount >= amount, 'offered more than the stack holds');
    W.offers.push({ room: W.room, to: args.to_id, item: it.name, amount });
    it.amount -= amount; if (!it.amount) W.items.splice(W.items.indexOf(it), 1);
    if (args.to_id === 77) { W.mastered = true; W.pending.push('The dragonfly queen looks at you with obvious adoration.'); }
    else if (args.to_id === 61) award('C');
    else if (args.to_id === 62 && it.name === 'feather of an avar shaman') award('D');
    else if (args.to_id === 63 && it.name === 'chunk of nerudite') { add(W.items, 'feather of an avar shaman'); W.pending.push('Nyuk nyuk uk ak a-ak!'); }
    else if (args.to_id === 63 && it.name === 'orc pit boss head') award('A');
    return { sent: true };
  };
  const ctx = { agent: `q${++nextId}`, fleet: 'offline', state: {}, call, keeper };
  const exec = async s => {
    switch (s.do) {
      case 'walk': if (s.to == null) return { ok: false, why: 'no destination' }; W.room = Number(s.to); W.row = 10; W.col = 10; return { ok: true };
      case 'walk_to': case 'crawl_to': if (s.col == null || s.row == null) return { ok: false, why: 'no square' }; W.row = s.row; W.col = s.col; return { ok: true };
      case 'harvest': {
        W.harvests = (W.harvests ?? 0) + 1;
        for (let i = 0; i < 5; i++) {
          const v = await s.until({ agent: ctx.agent, call, observe: async () => ({ room: W.room }), state: ctx.state });
          if (v === true || v?.done) return { ok: true };
          // the quester's own kill: the quest feather appears where the shaman fell
          if (s.quarry.includes('avar shaman') && !(W.floor[W.room] ?? []).length && i === 1)
            (W.floor[W.room] ??= []).push({ id: ++nextId, name: 'feather of an avar shaman' });
        }
        return { ok: false, why: 'goal not reached' };
      }
      case 'verify': return s.fn({ ...ctx, observe: async () => ({ room: W.room }) });
      default: throw Error(`unexpected step ${s.do}`);
    }
  };
  return { W, ctx, add, run: async (params = {}) => {
    const plan = await quester.steps({ agents: ctx.agent, agent: ctx.agent, shards: 'C,D,A,B', hall: 713, queenPies: 3,
      queenWaitMin: 0.01, shamanRooms: SHAMAN_ROOMS.join(','), huntMin: 1, wield: true, home: 0, reset: false,
      fleeBelow: 0.35, restBelow: 0.5, ...params }, ctx.state);
    return runPlan(plan, () => ctx, exec);
  } };
}

try {
  // ---------------------------------------------------------------- the tables
  await test('karma side: +10 and -10 are inclusive; between is nobody', () => {
    assert.equal(R.karmaSide(10), 'good'); assert.equal(R.karmaSide(9), null); assert.equal(R.karmaSide(-9), null);
    assert.equal(R.karmaSide(-10), 'evil'); assert.equal(R.karmaSide('x'), null);
  });

  await test('every row of both of Wulfgang\'s tables is read back as the server phrases it', () => {
    const cardinal = { 50: 'fifty', 70: 'seventy', 100: 'a hundred' };
    for (const side of ['good', 'evil']) for (const row of R.SHIPMENTS[side]) {
      const it = R.ITEMS[row.key];
      const said = row.amount > 1 ? `${cardinal[row.amount] ?? row.amount} ${it.plural}` : `a ${it.name}`;
      const line = `I'm always looking for people to help replenish my inventory.  If you'd be willing to bring me ${said}, I can make it well worth your trip.`;
      const got = R.readShipment([line], side);
      assert.ok(got, `${side} ${said}`); assert.equal(got.key, row.key); assert.equal(got.amount, row.amount);
    }
  });

  await test('a shipment off the other table, a guide\'s chess board, a wrong count, or no line are refused', () => {
    const l = s => [`help replenish my inventory.  If you'd be willing to bring me ${s}, I can`];
    assert.equal(R.readShipment(l('seventy goblets of wine'), 'good'), null);
    assert.equal(R.readShipment(l('a chess board'), 'good'), null);
    assert.equal(R.readShipment(l('twenty meat pies'), 'good'), null);
    assert.equal(R.readShipment(['250 herbs'], 'good'), null);
    assert.equal(R.readShipment(l('seventy goblets of ale'), 'evil').key, 'ale');
  });

  await test('the manifest is the whole table for the side, plus the route items, pies summed once', () => {
    const good = R.prepManifest({ side: 'good', queenPies: 5 });
    const g = Object.fromEntries(good.map(m => [m.key, m.amount]));
    assert.equal(g.meatPie, 55); assert.equal(g.elderberry, 350); assert.equal(g.nerudite, 1); assert.equal(g.head, 1);
    assert.equal(good.filter(m => m.key === 'meatPie').length, 1);
    const evil = Object.fromEntries(R.prepManifest({ side: 'evil', queenPies: 2 }).map(m => [m.key, m.amount]));
    assert.equal(evil.meatPie, 2); assert.equal(evil.mugOfBrew, 100); assert.equal(evil.nerudite, 1); assert.equal(evil.ale, 70);
    assert.equal(evil.apple, undefined);
    assert.ok(!R.prepManifest({ side: 'good', skip: ['elderberry'] }).some(m => m.key === 'elderberry'));
    assert.throws(() => R.prepManifest({ side: 'neutral' }));
  });

  await test('shortfall reads chest rows (amount 0 is one item) and sources split by landmass', () => {
    const have = R.countByKey([{ name: 'meat pies', amount: 20 }, { name: 'meat pie', amount: 5 }, { name: 'plate armor', amount: 0 }, { name: 'goblet of wine', amount: 3 }]);
    assert.deepEqual([have.meatPie, have.plateArmor, have.wine, have.ale], [25, 1, 3, undefined]);
    const rows = R.shortfall(R.prepManifest({ side: 'evil', queenPies: 5 }), have);
    assert.equal(rows.find(r => r.key === 'plateArmor').short, 0);
    assert.equal(rows.find(r => r.key === 'wine').short, 67);
    assert.equal(R.pickSource('nerudite', { where: 'island' }).seller, 'Tepal');
    assert.equal(R.pickSource('nerudite', { where: 'island' }).trigger, 'precious stones');
    assert.equal(R.pickSource('herbs', { where: 'island' }), null);
    assert.equal(R.pickSource('herbs', { where: 'mainland' }).seller, 'Zhieu');
    assert.equal(R.pickSource('grapes', { where: 'mainland', kinds: ['dispense'] }).room, 953);
    assert.equal(R.ROOMS.trader, 2101, 'Wulfgang stands in 2101 (tpost1.kod), not 2144');
  });

  await test('prep plan reads the hall and names a source for every short row', () => {
    const plan = prepPlan({ side: 'good', chests: [{ items: [{ name: 'apple', amount: 150 }, { name: 'meat pie', amount: 10 }], age_min: 3 }] });
    const by = Object.fromEntries(plan.rows.map(r => [r.key, r]));
    assert.equal(by.apple.short, 0); assert.equal(by.meatPie.short, 45); assert.ok(by.herbs.sources.length);
    const both = prepPlan({ side: 'both', chests: [] });
    assert.ok(both.rows.some(r => r.key === 'ale') && both.rows.some(r => r.key === 'grapes'));
  });

  await test('prep buy on the island says Tepal\'s trigger before buying the ore, and deposits in 713', async () => {
    const steps = await prep.steps({ agents: 'c', agent: 'c', side: 'good', mode: 'buy', where: 'island', items: '', skip: '',
      queenPies: 5, cap: 250, fromHall: 714, hall: 713, home: 0 });
    const sayAt = steps.findIndex(s => s.do === 'say');
    assert.equal(steps[sayAt].text, 'precious stones');
    assert.equal(steps[sayAt + 1].do, 'shop'); assert.equal(steps[sayAt + 1].seller, 'Tepal');
    assert.equal(steps.at(-2).do, 'walk'); assert.equal(steps.at(-2).to, 713);
    assert.ok(steps.filter(s => s.do === 'shop').every(s => s.optional), 'a lap with nothing to buy is a skip, not a failure');
    const main = await prep.steps({ agents: 'c', agent: 'c', side: 'good', mode: 'buy', where: 'mainland', items: 'herbs', skip: '',
      queenPies: 5, cap: 250, fromHall: 714, hall: 713, home: 0 });
    assert.ok(!main.some(s => s.do === 'walk' && s.to === 713), 'mainland goods are carried, not walked to the island');
    assert.equal(main.find(s => s.do === 'shop').seller, 'Zhieu');
  });

  await test('prep deposit names stacks by id and exactly: a purple mushroom is not a mushroom', async () => {
    const steps = await prep.steps({ agents: 'c', agent: 'c', side: 'good', mode: 'deposit', items: '', skip: '',
      queenPies: 5, cap: 250, fromHall: 714, hall: 713, home: 0 });
    const pack = [{ id: 1, name: 'mushroom', amount: 200 }, { id: 2, name: 'purple mushroom', amount: 10 }, { id: 3, name: 'meat pie', amount: 5 }];
    let sent = null;
    const call = async (name, args) => {
      if (name === 'inventory') return { items: sent ? pack.filter(i => !sent.includes(`id:${i.id}`)) : pack };
      if (name === 'hall_withdraw') { sent = args.deposit; return { ok: true }; }
      throw Error(name);
    };
    const r = await steps.at(-1).fn({ agent: 'c', call, state: {} });
    assert.deepEqual(sent, ['id:1', 'id:3']);
    assert.equal(r.ok, true);
  });

  // ---------------------------------------------------------------- the pit
  await test('pit ratio, as the kod COMPUTES it: 1:3, 1:2 and 3:2 solve; 2:3 (what the comment says) and empty chambers do not', () => {
    for (const [a, b] of [[1, 3], [1, 2], [3, 2], [2, 4], [3, 9]]) assert.ok(R.pitSolves(a, b), `${a}:${b}`);
    for (const [a, b] of [[0, 0], [1, 1], [1, 4], [2, 3], [2, 5], [3, 1]]) assert.ok(!R.pitSolves(a, b), `${a}:${b}`);
  });

  await test('pit roles: four is 1 in A and 3 in B, every square in its chamber, the puller in reach of the lever', () => {
    const roles = R.pitRoles(['a', 'b', 'c', 'd']);
    assert.deepEqual(roles.map(r => r.side), ['A', 'B', 'B', 'B']);
    assert.ok(R.pitSolves(roles.filter(r => r.side === 'A').length, roles.filter(r => r.side === 'B').length));
    for (const r of roles) { assert.ok(R.inChamber(r, r.side), `${r.agent} r${r.row}c${r.col}`); assert.ok(!R.onMarked(r, r.side)); }
    const pull = roles.find(r => r.lever);
    assert.equal(pull.agent, 'b');
    assert.ok(Math.abs(pull.row - R.PIT.B.lever.row) <= 3 && Math.abs(pull.col - R.PIT.B.lever.col) <= 3);
    assert.equal(R.pitRoles(['a', 'b', 'c', 'd'], { lever: 'd' }).find(r => r.lever).agent, 'd');
    assert.throws(() => R.pitRoles(['a', 'b', 'c', 'd'], { lever: 'a' }), /chamber B/);
    assert.throws(() => R.pitRoles(['a', 'b']), /3, 4 or 5/);
    assert.throws(() => R.pitRoles(['a', 'b', 'c', 'd', 'e', 'f']), /3, 4 or 5/);
    const five = R.pitRoles(['a', 'b', 'c', 'd', 'e']);
    assert.equal(five.filter(r => r.side === 'A').length, 3);
    assert.ok(R.pitSolves(3, 2) && five.every(r => R.inChamber(r, r.side)));
    const sq = R.pitRoles(['a', 'b', 'c', 'd'], { solution: 'squares' });
    assert.ok(R.onMarked(sq[0], 'A'));
    assert.deepEqual(sq.filter(r => r.side === 'B' && R.onMarked(r, 'B')).length, 2);
    assert.throws(() => R.pitRoles(['a', 'b', 'c'], { solution: 'squares' }), /squares solution/);
  });

  await test('the team barrier: opens on all, shuts on an abort, and ignores marks from a dead run', async () => {
    let t = 1000; const now = () => t, sleep = async ms => { t += ms; };
    const key = 'k-' + Math.random();
    R.teamMark(key, 'a', 'ready', {}, now); R.teamMark(key, 'b', 'ready', {}, now);
    assert.equal((await R.teamWait(key, ['a', 'b'], 'ready', { now, sleep, budgetMs: 10_000 })).ok, true);
    // a stale abort and a stale ready from before this run started are ignored
    R.teamMark(key, 'c', 'abort', { why: 'old' }, now);
    t = 5000;
    const late = await R.teamWait(key, ['a', 'b', 'c'], 'ready', { since: 4000, now, sleep, budgetMs: 4000 });
    assert.equal(late.ok, false); assert.match(late.why, /waited/);
    R.teamMark(key, 'b', 'abort', { why: 'fell off the ledge' }, now);
    const ab = await R.teamWait(key, ['a', 'b'], 'go', { since: 4000, now, sleep, budgetMs: 4000 });
    assert.match(ab.why, /b aborted: fell off the ledge/);
  });

  // ---------------------------------------------------------------- the quester, end to end
  await test('good route: kit drawn first, then only the named shipment; four shards; sword proved and wielded', async () => {
    const g = island({ shipment: 'apples150' });
    const { failure } = await g.run();
    assert.equal(failure, null, JSON.stringify(failure));
    assert.ok(g.W.items.some(i => i.name === 'sword of Riija'));
    assert.ok(g.W.wield.has('sword of Riija'), 'the sword is wielded');
    assert.deepEqual(g.W.draws.slice(0, 3).map(d => d.item).sort(), ['chunk of nerudite', 'meat pie', 'orc pit boss head']);
    assert.deepEqual(g.W.draws.find(d => d.item === 'apple'), { item: 'apple', amount: 150 });
    assert.ok(!g.W.draws.some(d => d.item === 'bunch of grapes'), 'nothing that was not asked for leaves the hall');
    assert.deepEqual(g.W.offers.map(o => [o.to, o.item, o.amount]), [
      [61, 'apple', 150], [63, 'chunk of nerudite', 1], [62, 'feather of an avar shaman', 1],
      [63, 'orc pit boss head', 1], [77, 'meat pie', 1]]);
    assert.ok(g.W.offers.every(o => o.room === { 61: 2101, 62: 2100, 63: 2141, 77: o.room }[o.to]));
    const rec = loadRun(ledgerId(g.ctx.agent), { fleet: 'offline' });
    assert.equal(rec.outcome, 'ok'); assert.deepEqual(rec.open, {});
    assert.ok(rec.heard.some(h => h.key === 'C' && h.lines.some(l => /150 apples/.test(l))), 'the request line is in the questbook');
  });

  await test('a meat-pie shipment keeps a pie back for the queen', async () => {
    const g = island({ shipment: 'pies50' });
    const { failure } = await g.run();
    assert.equal(failure, null, JSON.stringify(failure));
    assert.deepEqual(g.W.offers.find(o => o.to === 61), { room: 2101, to: 61, item: 'meat pie', amount: 50 });
    assert.ok(g.W.offers.some(o => o.to === 77 && o.item === 'meat pie'));
  });

  await test('an open node resumes from the questbook without asking again', async () => {
    const g = island({ shipment: 'apples150', hallStock: { 'orc pit boss head': 1, 'chunk of nerudite': 1, 'meat pie': 5 } });
    const first = await g.run({ shards: 'C' });
    assert.match(first.failure?.why ?? '', /could not supply 150 apple/);
    assert.equal(g.W.said.filter(s => s.text === 'inventory').length, 1);
    g.add(g.W.hall, 'apple', 150);                      // riija-prep tops the hall up
    const again = await g.run({ shards: 'C' });
    assert.equal(again.failure, null, JSON.stringify(again.failure));
    assert.equal(g.W.said.filter(s => s.text === 'inventory').length, 1, 'Wulfgang is not asked twice');
    assert.deepEqual(g.W.offers.map(o => [o.to, o.item, o.amount]), [[61, 'apple', 150]]);
  });

  await test('a neutral character is refused before anybody is asked anything', async () => {
    const g = island({ karma: 3 });
    const { failure } = await g.run();
    assert.match(failure?.why ?? '', /between -10 and \+10/);
    assert.equal(g.W.said.length, 0); assert.equal(g.W.offers.length, 0);
  });

  await test('an unplaceable shipment is recorded and refused, never guessed', async () => {
    const g = island({ shipment: 'chess' });
    const { failure } = await g.run({ shards: 'C' });
    assert.match(failure?.why ?? '', /cannot place on the table/);
    assert.equal(g.W.offers.length, 0);
    const rec = loadRun(ledgerId(g.ctx.agent), { fleet: 'offline' });
    assert.ok(rec.heard[0].lines.some(l => /chess board/.test(l)));
  });

  await test('evil route: no ore; the feather comes from the quester\'s own shaman kill, picked off the floor', async () => {
    const g = island({ karma: -60, shipment: 'wine70' });
    const { failure } = await g.run();
    assert.equal(failure, null, JSON.stringify(failure));
    assert.ok(!g.W.draws.some(d => d.item === 'chunk of nerudite'), 'the evil route takes no ore');
    assert.ok(g.W.harvests >= 1);
    assert.deepEqual(g.W.offers.map(o => [o.to, o.item]), [[61, 'goblet of wine'], [62, 'feather of an avar shaman'],
      [63, 'orc pit boss head'], [77, 'meat pie']]);
    assert.ok(g.W.items.some(i => i.name === 'sword of Riija'));
  });

  await test('silence from an NPC is a stated refusal, with the lines heard kept', async () => {
    const g = island({ npcLines: false });
    const { failure } = await g.run({ shards: 'A' });
    assert.match(failure?.why ?? '', /assigned nothing recognisable/);
    assert.equal(g.W.offers.length, 0);
  });

  await test('the queen guard checks identity and symmetric distance', () => {
    const v = { you: { row: 30, col: 61 }, objects: [{ id: 5, name: 'dragonfly queen', row: 29, col: 60 }] };
    assert.ok(queenNear(v, 5)); assert.ok(!queenNear(v, 6));
    v.objects[0].row = 1; assert.ok(!queenNear(v, 5));
  });

  // ---------------------------------------------------------------- the pit team, four bodies in parallel
  function pitWorld({ misplace = null } = {}) {
    const P = { bodies: {}, floor: {}, hall: [], deposits: [], leverPulled: 0, killed: false, packs: {} };
    const team = ['ta', 'tb', 'tc', 'td'];
    for (const a of team) { P.bodies[a] = { room: 2501, row: 10, col: 10, pending: [], seq: 0 }; P.packs[a] = []; }
    const ctxOf = a => {
      const b = P.bodies[a];
      const call = async (name, args) => {
        switch (name) {
          case 'look': {
            const objects = [];
            if (b.room === 2508) objects.push({ id: 900, name: 'lever', row: 48, col: 29 });
            for (const f of P.floor[b.room] ?? []) objects.push({ ...f, row: b.row, col: b.col });
            return { room: { num: b.room }, you: { row: b.row, col: b.col }, objects };
          }
          case 'inventory': return { items: P.packs[a].map(i => ({ ...i })) };
          case 'wait_for_event': {
            if (args.timeout_ms === 1) return { cursor: b.seq };
            const events = b.pending.map(text => ({ text })); b.pending = []; return { cursor: ++b.seq, events, timed_out: true };
          }
          case 'act': if (args.verb === 'activate' && args.target === 900) { P.leverPulled++; b.pending.push('You switch the lever.'); } return { ok: true };
          case 'loot': for (const id of args.ids ?? []) { const fl = P.floor[b.room] ?? []; const f = fl.find(x => x.id === id); if (f) { P.packs[a].push({ id: f.id, name: f.name, amount: 0 }); fl.splice(fl.indexOf(f), 1); } } return { taken: [] };
          case 'hall_withdraw': {
            for (const d of args.deposit ?? []) for (const it of P.packs[a].filter(i => i.name.toLowerCase().includes(String(d).toLowerCase()))) {
              P.hall.push(it); P.packs[a].splice(P.packs[a].indexOf(it), 1); P.deposits.push(it.name);
            }
            return { ok: true };
          }
          case 'autopilot': return args.action === 'status' ? { mode: 'farm', policy: { mode: 'survive' } } : { ok: true };
          case 'status': return { hp: { value: 100, max: 100 } };
          default: throw Error(`unexpected pit call ${name}`);
        }
      };
      return { agent: a, fleet: 'offline', state: {}, call, keeper: async () => ({}) };
    };
    const runOne = async (a, params) => {
      const ctx = ctxOf(a), b = P.bodies[a];
      const plan = await pitboss.steps({ agents: team.join(','), agent: a, lever: '', holder: '', solution: 'plain', stow: 'hall', hall: 713,
        alsoStow: 'mystic sword', waitMin: 0.2, fightMin: 1, home: 0, fleeBelow: 0.3, restBelow: 0.4, ...params });
      return runPlan(plan, () => ctx, async s => {
        switch (s.do) {
          case 'walk': b.room = Number(s.to); if (b.room === 2506) { b.row = 30; b.col = 40; } return { ok: true };
          case 'walk_to': case 'crawl_to':
            if (misplace === a) { b.row = 5; b.col = 5; return { ok: true }; }
            b.row = s.row; b.col = s.col; return { ok: true };
          case 'harvest':
            for (let i = 0; i < 200; i++) {
              if (!P.killed && i === 1) { P.killed = true; (P.floor[2506] ??= []).push({ id: 4242, name: 'orc pit boss head' }, { id: 4243, name: 'mystic sword' }); }
              const v = await s.until({ agent: a, call: ctx.call, state: ctx.state });
              if (v?.done) return { ok: true };
              await new Promise(r => setTimeout(r, 20));
            }
            return { ok: false, why: 'goal not reached' };
          case 'verify': return s.fn({ ...ctx });
          default: throw Error(`unexpected pit step ${s.do}`);
        }
      });
    };
    return { P, team, runOne };
  }

  await test('pit: four stand, one pulls, all go through, the holder stows the head (and the mystic sword) in 713', async () => {
    const { P, team, runOne } = pitWorld();
    const out = await Promise.all(team.map(a => runOne(a)));
    for (const [i, o] of out.entries()) assert.equal(o.failure, null, `${team[i]}: ${JSON.stringify(o.failure)}`);
    assert.equal(P.leverPulled, 1, 'exactly one lever pull');
    assert.deepEqual(P.deposits.sort(), ['mystic sword', 'orc pit boss head'], JSON.stringify({ d: P.deposits, packs: P.packs }));
    assert.ok(!Object.values(P.packs).some(p => p.some(i => i.name === 'orc pit boss head')));
    assert.ok(inBossArea({ room: { num: 2506 }, you: { row: 30 } }) && !inBossArea({ room: { num: 2506 }, you: { row: 50 } }));
  });

  await test('pit: one body off its square stops the whole team before the lever', async () => {
    const { P, team, runOne } = pitWorld({ misplace: 'tc' });
    const out = await Promise.all(team.map(a => runOne(a)));
    assert.equal(P.leverPulled, 0);
    assert.match(out[2].failure?.why ?? '', /not inside chamber B/);
    for (const i of [0, 1, 3]) assert.match(out[i].failure?.why ?? '', /tc aborted/);
  });
} finally {
  process.chdir(home);
  rmSync(temp, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
