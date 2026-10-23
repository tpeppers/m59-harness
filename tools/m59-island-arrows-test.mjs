// Offline: m59-carry's fill arithmetic, and island-arrows end to end against a fake world —
// stash at the East Tower, buy sized from the STARTING pack, pick the stash up, re-equip, warn.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fillPlan, loadOf, carryMax, unitOf } from './m59-carry.mjs';
import { script, receiptFile } from './fleetscripts/island-arrows.mjs';

let passed = 0;
const ok = (name, cond, extra) => { assert.ok(cond, name + (extra === undefined ? '' : ' ' + JSON.stringify(extra))); passed++; };

// ---- arithmetic
ok('ceiling is 1700 + 20*might', carryMax(50) === 2700);
ok('plural and singular stacks both weigh', unitOf('herbs')?.weight === 2 && unitOf('arrow')?.weight === 4);
ok('a count of zero is one item', loadOf([{ name: 'long sword', amount: 0 }]).weight === 80);
{
  const p = fillPlan({ items: [{ name: 'chain armor', amount: 0 }], max: 1000, item: 'arrows' });   // 200w/250b
  ok('bulk binds when it is the tighter', p.fit === 187 && p.binding === 'bulk', p);
  const q = fillPlan({ items: [{ name: 'chain armor', amount: 0 }], max: 1000, item: 'arrows', unitCost: 2, purse: 101, keep: 1 });
  ok('purse after keep', q.amount === 50 && q.limited_by.includes('purse'), q);
  ok('purse-limited fill warns under 70%', q.warn === true && q.fullness_after < 0.7, q);
  ok('cap', fillPlan({ items: [], max: 1000, item: 'arrows', cap: 10 }).amount === 10);
  const u = fillPlan({ items: [{ name: 'mystery orb', amount: 1 }], max: 1000, item: 'arrows' });
  ok('an unweighed item refuses rather than guesses', u.fit === null && /mystery orb/.test(u.why), u);
}

// ---- the errand, against a fake world
function world({ might = 50, purse = 5000, cost = 2, extra = [] } = {}) {
  let nextId = 100;
  const w = { room: 2000, pos: { row: 10, col: 10 }, floor: [], log: [], might, cost };
  const item = (name, amount = 0) => ({ id: nextId++, name, amount });
  w.pack = [item('shillings', purse), item('long sword'), item('long sword'), item('mace'),
            item('chain armor'), item('plate armor'), item('apple', 5), ...extra.map(([n, a]) => item(n, a))];
  w.worn = new Set([w.pack[1].id, w.pack[4].id]);           // one long sword and the chain armour
  w.startIds = w.pack.map(i => i.id);
  w.passGuard = () => {                                      // kocatwn.kod CanPass, by name
    const n = s => w.pack.filter(i => s.test(i.name)).length;
    return n(/sword|mace|axe|hammer|bow/) < 3 && n(/armor/) < 2;
  };
  w.walk = to => {
    if (w.room === 2013 && to !== 2000 && to !== 2013 && !w.passGuard()) throw Error('the guard refused');
    w.log.push(to); w.room = to; w.pos = { row: 10, col: 10 };
  };
  w.call = async (tool, a) => {
    if (tool === 'look') return { room: { num: w.room }, you: { ...w.pos }, hp: { value: 50, max: 50 },
      objects: w.room === 2013 ? w.floor.map(o => ({ ...o, can: ['get'] })) : [] };
    if (tool === 'inventory') return { items: w.pack.map(i => ({ ...i })), carry: { known: true, might: w.might, weight_max: carryMax(w.might) } };
    if (tool === 'equipment') return { known: true, equipped: w.pack.filter(i => w.worn.has(i.id)).map(i => ({ id: i.id, name: i.name })) };
    if (tool === 'walk_to') { w.pos = { row: a.row, col: a.col }; return { arrived: true }; }
    if (tool === 'act' && a.verb === 'unuse') { w.worn.delete(a.target); return {}; }
    if (tool === 'act' && a.verb === 'use') { w.worn.add(a.target); return {}; }
    if (tool === 'act' && a.verb === 'drop') {
      const i = w.pack.find(x => x.id === a.target); w.pack = w.pack.filter(x => x !== i);
      w.floor.push({ ...i, id: nextId++, row: w.pos.row, col: w.pos.col }); return {};
    }
    if (tool === 'act' && a.verb === 'get') {
      const o = w.floor.find(x => x.id === a.target); w.floor = w.floor.filter(x => x !== o);
      w.pack.push({ id: nextId++, name: o.name, amount: o.amount }); return {};
    }
    if (tool === 'shop' && !a.buy_ids) return { items: [{ id: 7, name: 'arrows', cost: w.cost }] };
    if (tool === 'shop') {
      const n = a.buy_ids[0].amount; w.bought = n;
      const cash = w.pack.find(i => i.name === 'shillings'); cash.amount -= n * w.cost;
      const have = w.pack.find(i => i.name === 'arrows');
      if (have) have.amount += n; else w.pack.push({ id: nextId++, name: 'arrows', amount: n });
      return { bought: [{ id: 7, amount: n }] };
    }
    throw Error('unexpected tool ' + tool);
  };
  return w;
}
async function run(w, params = {}, { failAt = null } = {}) {
  const agent = 'fixture' + Math.random().toString(36).slice(2, 7);
  const steps = await script.steps({ agent, agents: agent, ...params });
  const out = []; let failure = null;
  for (const [i, s] of steps.entries()) {
    if (failure && !s.always) continue;
    let r;
    try {
      if (i === failAt) throw Error('injected failure');
      if (s.do === 'walk') { const to = typeof s.to === 'function' ? s.to({}) : s.to; if (to !== w.room) w.walk(to); r = true; }
      else r = await s.fn({ agent, call: w.call, state: {} });
    } catch (e) { r = { ok: false, why: e.message }; }
    const good = r === true || r?.ok === true;
    out.push({ do: s.do, label: s.label, ok: good, why: r?.why });
    if (!good && !failure) failure = { at: i, why: r?.why };
  }
  return { steps, out, failure, agent };
}
const kinds = steps => steps.map(s => s.do + (s.always ? '!' : '')).join(' ');
const dir = mkdtempSync(join(tmpdir(), 'island-arrows-'));
process.chdir(dir);
const quiet = console.log; console.log = () => {};
try {
  // A full pack round trip: 1 long sword and the plate armour must be stashed and come back.
  const w = world();
  const startLoad = loadOf(w.pack), max = carryMax(50);
  const expected = Math.floor(Math.min(max - startLoad.weight, max - startLoad.bulk) / 4);
  const r = await run(w);
  ok('compiles: plan, tower, stash, hut, buy, then the always-legs', kinds(r.steps) ===
     'verify walk verify walk verify walk! verify! walk! verify!', kinds(r.steps));
  ok('every step passed', !r.failure, r.out);
  ok('walked town -> tower -> hut -> tower -> town', w.log.join('>') === '2013>2100>2013>2000', w.log);
  ok('bought exactly the starting pack\'s room, not the stash\'s', w.bought === expected, { bought: w.bought, expected });
  const names = w.pack.map(i => i.name).sort();
  ok('came home with everything it left with', ['long sword', 'long sword', 'mace', 'chain armor', 'plate armor', 'apple']
     .every(n => names.includes(n)) && names.filter(n => n === 'long sword').length === 2, names);
  ok('nothing left on the tower floor', w.floor.length === 0, w.floor);
  ok('the worn armour is worn again', w.pack.some(i => i.name === 'chain armor' && w.worn.has(i.id)));
  const end = loadOf(w.pack);
  ok('home load is within one arrow of full, and never over', Math.max(end.weight, end.bulk) <= max && max - Math.max(end.weight, end.bulk) < 4, end);

  // Only shillings and one weapon: no stash, no lock, nothing dropped.
  const light = world();
  light.pack = light.pack.filter(i => /shillings|long sword/.test(i.name)).slice(0, 2); light.worn = new Set([light.pack[1].id]);
  let dropped = 0; const lc = light.call; light.call = async (t, a) => { if (t === 'act' && a.verb === 'drop') dropped++; return lc(t, a); };
  const lr = await run(light);
  ok('a light pack drops nothing', !lr.failure && dropped === 0, lr.out);

  // Purse-limited: buys what it can afford, and warns.
  const poor = world({ purse: 200 });
  console.log = (...a) => poor.lines = [...(poor.lines ?? []), a.join(' ')];
  const pr = await run(poor);
  console.log = () => {};
  ok('purse-limited buys 100', !pr.failure && poor.bought === 100, poor.bought);
  ok('and warns under 70%', poor.lines.some(l => /WARNING: under 70%/.test(l) && /purse/.test(l)), poor.lines);

  // A failure at the hut still brings the stash home.
  const f = world();
  const fr = await run(f, {}, { failAt: 4 });
  ok('a failed purchase still walks back and picks the stash up', fr.failure?.at === 4 && f.floor.length === 0 &&
     f.pack.some(i => i.name === 'plate armor') && f.room === 2000, { failure: fr.failure, floor: f.floor, room: f.room });
  ok('and buys nothing', f.bought === undefined);

  // An unweighed item refuses before anything walks.
  const odd = world({ extra: [['mystery orb', 0]] });
  const or = await run(odd);
  ok('an unweighed item stops it in town', or.failure?.at === 0 && odd.log.length === 0, { f: or.failure, log: odd.log });
} finally { console.log = quiet; }
console.log(`island-arrows: ${passed} passed`);
