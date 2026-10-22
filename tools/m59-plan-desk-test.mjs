#!/usr/bin/env node
// m59-plan-desk-test.mjs — THE PLAN TAB'S OTHER HALF, OFFLINE.
//
//   node tools/m59-plan-desk-test.mjs
//
// No broker, no proxy, no roster: a temp substrate with a copy of a courier lap, a fake
// client request file, and the real providers in tools/plans/. Pins the file protocol the
// client depends on, at-most-once execution, and that the courier rows are reflected from
// the lap's own tables rather than written down twice.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlanRequest, renderPlanView, parseArgs, createDesk, enc, liveDesk, yieldsTo, lastAck, whenHolds, runRequest, downgradeArg,
         checkoutRoots, clientFolders, serveStrays, STRAY_QUIET_MS, freshRequests } from './m59-plan-desk.mjs';
import { reflectShopping, reflectPool, itemOptions } from './plans/courier.mjs';
import { replLine, replValue, valuesFor, taskValue } from './plans/fleetscripts.mjs';
import { readHolds, reservedPercent, acceptGiftFrom, deliverTo } from './m59-human-handoff.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};
const HERE = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'plan-desk-'));
process.env.M59_EVIDENCE_DIR = join(tmp, 'evidence');   // no real proxy adverts
process.env.M59_FLEET = "test";                         // the fleetscript layer refuses to guess one

// A courier lap that looks like the real one where it matters: its tables.
const LAP_SRC = `
// usage: zheng-he-lap agents=hk2
const POOL = [
  { rx: /^red mushrooms?$/i, sell: { seller: 'Joguer', room: 104, bite: 50 } },
  { rx: /^diamonds?$/i, sell: { seller: 'Herbutte', room: 109, bite: 25 } },
];
const SHOPPING = [
  { item: 'elderberry', rx: /^elderberr(y|ies)$/i, seller: 'Joguer', room: 104, share: 0.5, max: 400, fill: 85 },
  { item: 'orc tooth', rx: /^orc (tooth|teeth)$/i, seller: "Ran er'Hoth", room: 200, share: 0.08, max: 0, say: 'orc teeth', fill: 90 },
];
export const script = { name: 'zheng-he-lap', describe: 'test lap', params: { agents: { type: 'agents', required: true } }, async steps() { return []; } };
`;

// ------------------------------------------------------------------ 1. protocol
{
  const now = Date.now();
  const text = [`M59PLANREQ\t1\t${now}\t4242\t${enc('76.214.42.186:5959')}\t${enc('t1')}\t${enc('Kermit')}\t99\t1`,
    `I\t11\t${enc('diamond')}\t40`, `I\t12\t${enc('red mushroom')}\t7`,
    `R\t5\tcourier.request\t${enc('item=elderberry&count=30&for=t1')}`, 'END', ''].join('\n');
  const r = parsePlanRequest(text, now);
  ok('a client request parses', r && r.pid === 4242 && r.account === 't1' && r.character === 'Kermit' && r.player_id === 99);
  ok('inventory rows come through', r?.inventory.length === 2 && r.inventory[0].name === 'diamond' && r.inventory[0].amount === 40);
  ok('a request carries its args', r?.requests[0]?.args.item === 'elderberry' && r.requests[0].args.count === '30');
  ok('a stale request file is ignored', parsePlanRequest(text, now + 10_000) === null);
  ok('a truncated file is ignored', parsePlanRequest(text.slice(0, -5), now) === null);
  ok('an unknown row type is refused, not guessed at', parsePlanRequest(text.replace('END', 'Z\tx\nEND'), now) === null);
  ok('args decode percent-escapes and drop bad keys', JSON.stringify(parseArgs('line=zheng-he-lap%20agents%3Dhk2&BAD KEY=1')) === '{"line":"zheng-he-lap agents=hk2"}');
  const v = renderPlanView({ pid: 1, ack: 5, control: 'keeper', status: 's t',
    entries: [{ id: 'a.b', group: 'G', icon: 'i', title: 'T\tab', running: true, args: [{ id: 'x', type: 'choice', title: 'X', options: [{ value: 'v', label: 'L' }] }] }],
    messages: [{ seq: 5, ok: true, message: 'done' }] }, 7);
  const lines = v.trimEnd().split('\n');
  ok('the view header says who has the controls', lines[0] === 'M59PLAN\t1\t7\t1\t5\tkeeper\ts%20t');
  ok('a tab inside a title cannot break the row', lines[1].split('\t').length === 7 && lines[1].includes('T%20ab'));
  const seven = renderPlanView({ pid: 1, ack: 0, entries: [{ id: 'fs.stock-desk', title: 'S',
    args: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => ({ id, type: 'text' })) }] }, 7);
  ok('a row never carries more arguments than the client accepts (a seventh dropped the whole reply)',
    seven.split('\n').filter(l => l.startsWith('A\t')).length === 6);
  ok('args and options follow their entry', lines[2].startsWith('A\ta.b\tx\tchoice') && lines[3].startsWith('O\ta.b\tx\tv\tL'));
  ok('results ride at the end', lines.at(-2) === 'M\t5\t1\tdone' && lines.at(-1) === 'END');
}

// ------------------------------------------------------------------ 2. courier reflection
{
  const shop = reflectShopping(LAP_SRC);
  ok('SHOPPING is read from the lap source', shop.length === 2 && shop[1].seller === "Ran er'Hoth" && shop[1].room === 200 && shop[0].max === 400);
  const pool = reflectPool(LAP_SRC);
  ok('POOL is read from the lap source', pool.length === 2 && pool[1].rx.test('diamonds') && pool[0].room === 104);
  const mf = join(tmp, 'merchants.json');
  writeFileSync(mf, JSON.stringify({ merchants: [{ room: 104, cls: 'BarloqueApothecary', sells: [{ cls: 'ElderBerry' }, { cls: 'Herbs' }] }] }));
  const opts = itemOptions({ shopping: shop }, mf);
  ok('a lap line is offered as itself', opts.some(o => o.value === 'elderberry'));
  ok('town stock the lap cannot buy is offered as a WISH, not a request', opts.some(o => o.value === 'wish:herbs' && /NOT a lap line/.test(o.label)));
  ok('stock that IS a lap line is not offered twice', !opts.some(o => o.value === 'wish:elder berry'));
}

// ------------------------------------------------------------------ 3. the desk, end to end
const substrate = join(tmp, 'substrate'), dir = join(tmp, 'ctx');
mkdirSync(join(substrate, 'fleetscripts'), { recursive: true });
writeFileSync(join(substrate, 'fleetscripts', 'zheng-he-lap.mjs'), LAP_SRC);
mkdirSync(join(dir, 'plan', 'in'), { recursive: true });
const logs = [];
const desk = await createDesk({ fleet: 'test', dir, substrate, providerDirs: [join(HERE, 'plans')], log: m => logs.push(m),
  roster: () => [{ agent: 't1', account: 't1', character: 'Kermit' }, { agent: 'hk2', account: 'hk2', character: 'Zheng He' }] });
const writeReq = (reqs, inv = [['11', 'diamond', 40]]) => writeFileSync(join(dir, 'plan', 'in', '4242.tsv'),
  [`M59PLANREQ\t1\t${Date.now()}\t4242\t${enc('127.0.0.1:5959')}\t${enc('t1')}\t${enc('Kermit')}\t99\t1`,
   ...inv.map(([id, n, a]) => `I\t${id}\t${enc(n)}\t${a}`), ...reqs.map(([s, e, a]) => `R\t${s}\t${e}\t${enc(a)}`), 'END', ''].join('\n'));
const view = () => readFileSync(join(dir, 'plan', 'out', '4242.tsv'), 'utf8');
const said = () => view().split('\n').filter(l => l.startsWith('M\t')).map(l => { const f = l.split('\t'); return `${f[1]} ${f[2]} ${decodeURIComponent(f[3])}`; }).join('\n');

writeReq([]);
ok('the desk serves the client', await desk.tick() === 1 && existsSync(join(dir, 'plan', 'out', '4242.tsv')));
let v = view();
ok('the view binds to the fleet character', /M59PLAN\t1\t\d+\t4242\t0\tnone\tt1%20%28Kermit%29/.test(v), v.split('\n')[0]);
ok('the courier registers its rows', v.includes('\tcourier.request\t') && v.includes('\tcourier.carry\t') && v.includes('\tcourier.next\t'));
ok('the lock row explains why it cannot lock without a proxy', /E\tcontrol\.keeper\t[^\n]*\td\t[^\n]*gate-capable/.test(v));
ok('every FleetScript registers by reflection over its params', v.includes('\tfs.zheng-he-lap\t') && /A\tfs\.zheng-he-lap\tagents\ttext/.test(v));
ok('the one diamond-holder sees diamonds offered to carry', /O\tcourier\.carry\titem\tdiamond\t/.test(v));

writeReq([[1, 'courier.request', 'item=elderberry&count=30']]);
await desk.tick();
const reqs = JSON.parse(readFileSync(join(substrate, 'courier-requests.json'), 'utf8'));
ok('a request becomes a standing courier request', reqs.t1?.elderberry === 30, JSON.stringify(reqs));
v = view();
ok('the request is acknowledged and reported', /\t4242\t1\t/.test(v.split('\n')[0]) && /^1 1 Standing request/m.test(said()));
ok('a cancel row now exists for it', v.includes('\tcourier.cancel.elderberry\t'));

writeReq([[1, 'courier.request', 'item=elderberry&count=99']]);
await desk.tick();
ok('the same sequence never runs twice', JSON.parse(readFileSync(join(substrate, 'courier-requests.json'), 'utf8')).t1.elderberry === 30);

writeReq([[2, 'courier.request', 'item=wish:herbs&count=10'], [3, 'courier.carry', 'item=diamond&count=40'], [4, 'courier.request', 'item=dragon&count=1']]);
await desk.tick();
ok('a wish goes to the wishlist, not the lap\'s requests', JSON.parse(readFileSync(join(substrate, 'courier-wishlist.json'), 'utf8')).t1?.herbs?.count === 10 &&
   !JSON.parse(readFileSync(join(substrate, 'courier-requests.json'), 'utf8')).t1.herbs);
const holds = readHolds(join(substrate, 'courier-holds.json'));
ok('carrying my diamonds becomes a hold the lap can read', holds.t1?.items?.diamond === 40 && holds.t1.character === 'Kermit');
ok('a choice that was never offered is refused', /^4 0 .*not one of the offered/m.test(said()));
ok('the hold reserves pack room', reservedPercent(holds) === 10 && reservedPercent({ a: { items: { x: 1000 } } }) === 40);

writeReq([[5, 'fs.zheng-he-lap', 'agents=t1']]);
await desk.tick();
ok('a FleetScript aimed at the character you are piloting is refused', /^5 0 .*piloting/m.test(said()));
writeReq([[6, 'courier.cancel.elderberry', '']]);
await desk.tick();
ok('cancel removes the standing request', !existsSync(join(substrate, 'courier-requests.json')) || !JSON.parse(readFileSync(join(substrate, 'courier-requests.json'), 'utf8')).t1);

// ------------------------------------------------------------------ 3b. Automated Courier: Full Auto
{
  // A fake gate-capable proxy, advertised the way m59-proxy.mjs advertises itself.
  const http = await import('node:http');
  const posts = [];
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'GET') return res.end(JSON.stringify({ sessions: [{ player_id: 99, in_game: true, gate: null, gate_refusal: null }] }));
      posts.push({ path: req.url, body: JSON.parse(b || '{}') }); res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  mkdirSync(join(tmp, 'evidence', 'proxies'), { recursive: true });
  writeFileSync(join(tmp, 'evidence', 'proxies', '5962.json'), JSON.stringify({ listen: 5962, server: { host: '127.0.0.1', port: 5959 }, pid: process.pid, gate_control: fake.address().port }));
  const writeRoom = (reqs, room) => writeFileSync(join(dir, 'plan', 'in', '4242.tsv'),
    [`M59PLANREQ\t1\t${Date.now()}\t4242\t${enc('127.0.0.1:5959')}\t${enc('t1')}\t${enc('Kermit')}\t99\t1`,
     `I\t11\t${enc('diamond')}\t40`, ...room.map(([id, n]) => `W\t${id}\t${enc(n)}`),
     ...reqs.map(([s, e, a]) => `R\t${s}\t${e}\t${enc(a)}`), 'END', ''].join('\n'));

  writeRoom([], []); await desk.tick();
  ok('the Automated Courier settings row is a settings form (flag c) with a dropdown and a checkbox',
     /E\tcourier\.settings\t[^\t]*\t[^\t]*\t[^\t]*\tc\t/.test(view()) && /A\tcourier\.settings\tinstructions\tboolean/.test(view()) && /A\tcourier\.settings\tmode\tchoice/.test(view()));
  ok('it defaults to Manual with instructions', /Automated%20Courier%3A%20Manual%2C%20with%20instructions/.test(view()));
  writeRoom([[20, 'courier.settings', 'mode=auto&instructions=false']], []); await desk.tick();
  ok('saving it writes courier-settings.json', JSON.parse(readFileSync(join(substrate, 'courier-settings.json'), 'utf8')).t1?.mode === 'auto');
  ok('a checkbox value that is not true/false is refused', (writeRoom([[21, 'courier.settings', 'mode=auto&instructions=maybe']], []), await desk.tick(), /^21 0 .*true or false/m.test(said())));
  posts.length = 0;
  writeRoom([], [[555, 'Someone Else']]); await desk.tick();
  ok('Full Auto does nothing while the courier is not in the room', posts.length === 0);
  writeRoom([], [[4242, 'Zheng He']]); await desk.tick();
  ok('with the courier in the room, the proxy is told to accept its offers', posts.some(p => p.path === '/trade/accept-from?player=99' && p.body.from_id === 4242), JSON.stringify(posts));
  ok('but offers nothing before the lap says it is ready', !posts.some(p => p.path.startsWith('/trade/give')));
  writeFileSync(join(substrate, 'courier-ready.json'), JSON.stringify({ t1: { at: Date.now(), courier: 'hk2' } }));
  await desk.tick(); await desk.tick();
  const gives = posts.filter(p => p.path.startsWith('/trade/give'));
  ok('once ready, the held diamonds are offered to the courier, once', gives.length === 1 && gives[0].body.to_id === 4242 && gives[0].body.items[0].id === 11 && gives[0].body.items[0].amount === 40, JSON.stringify(gives));
  const pres = JSON.parse(readFileSync(join(substrate, 'human-presence.json'), 'utf8'));
  ok('the desk publishes who is at a keyboard and with whom', pres.t1?.with?.[0]?.name === 'Zheng He' && pres.t1.player_id === 99);
  const { atKeyboardWith, courierSettings } = await import('./m59-human-handoff.mjs');
  ok('the lap can read that presence and the settings', atKeyboardWith(join(substrate, 'human-presence.json'), 't1', 'zheng he') &&
     !atKeyboardWith(join(substrate, 'human-presence.json'), 't1', 'Gonzo') && courierSettings(join(substrate, 'courier-settings.json'), 't1').instructions === false);
  fake.close();
}

// ------------------------------------------------------------------ 4. the human half of a trade
{
  const calls = []; let t = null, step = 0;
  const call = async (name, a) => {
    calls.push(`${name}:${a.action ?? ''}`);
    if (name !== 'trade') return {};
    if (a.action === 'status') { step++; if (step === 2) t = { role: 'recipient', withName: 'Kermit', theirs: [{ name: 'diamond', amount: 40 }] }; return { trade: t }; }
    if (a.action === 'counter') { setTimeout(() => { t = null; }, 5); return { countered: true }; }
    if (a.action === 'cancel') { t = null; return { cancelled: true }; }
    return {};
  };
  const r = await acceptGiftFrom(call, 'hk2', 'kermit', { pollMs: 10, timeoutMs: 2000 });
  ok('a person\'s offer is accepted as a gift by countering with nothing', r.received[0]?.name === 'diamond' && calls.includes('trade:counter'), JSON.stringify(r));

  let d = null; const dcalls = [];
  const dcall = async (name, a) => {
    dcalls.push(a.action);
    if (a.action === 'offer') { d = { role: 'offerer', mayAccept: false }; setTimeout(() => { if (d) d.mayAccept = true; }, 30); return { offered: true, on_the_table: [{ id: 1 }] }; }
    if (a.action === 'status') return { trade: d };
    if (a.action === 'accept') { const was = d?.mayAccept; d = null; return { accepted: !!was }; }
    if (a.action === 'cancel') { d = null; return {}; }
    return {};
  };
  const dr = await deliverTo(dcall, 'hk2', 'Kermit', [{ id: 1, amount: 30 }], { pollMs: 10, timeoutMs: 2000 });
  ok('a delivery is accepted only after the person counters', dr.delivered && dcalls.indexOf('accept') > dcalls.indexOf('offer'), JSON.stringify(dr));

  let n = null; const ncall = async (name, a) => { if (a.action === 'status') return { trade: n }; if (a.action === 'offer') { n = { role: 'offerer', mayAccept: false }; return { offered: true }; } if (a.action === 'cancel') { n = null; return { cancelled: true }; } return {}; };
  const nr = await deliverTo(ncall, 'hk2', 'Kermit', [{ id: 1 }], { pollMs: 10, timeoutMs: 80 });
  ok('a person who never counters leaves no open trade behind', !nr.delivered && n === null, JSON.stringify(nr));
}

// ------------------------------------------------------------------ 3c. protocol 2: the MANAGE tab's pickers
{
  const now = Date.now();
  const req2 = `M59PLANREQ\t2\t${now}\t4243\t${enc('127.0.0.1:5959')}\t${enc('t1')}\t${enc('Kermit')}\t99\t1\nEND\n`;
  ok('a protocol-2 request parses and says so', parsePlanRequest(req2, now)?.version === 2 && parsePlanRequest(req2.replace('\t2\t', '\t1\t'), now)?.version === 1);
  ok('a protocol-3 request is refused, not guessed at', parsePlanRequest(req2.replace('\t2\t', '\t3\t'), now) === null);
  const entry = { id: 'fs.buy', title: 'buy', args: [
    { id: 'agents', type: 'agents', title: 'agents', help: 'who buys', options: [{ value: 'hk2', label: 'hk2 · Zheng He' }] },
    { id: 'seller', type: 'choice', title: 'seller', options: [{ value: 'A' }, { value: 'B' }] },
    { id: 'item', type: 'choice', title: 'item', options: [{ value: 'x', when: 'seller=A' }, { value: 'y', when: 'seller=B' }] },
    { id: 'withdraw', type: 'number', title: 'withdraw', default: '0', bounds: [{ min: 0, max: 5000, when: 'bank=376' }, { min: 0, max: 0, when: 'bank=0' }] },
    { id: 'bank', type: 'choice', title: 'bank', default: '0', options: [{ value: '0' }, { value: '376' }] },
    { id: 'back', type: 'combo', title: 'back', optional: true, options: [{ value: '38', label: '38 — Tos' }] },
    { id: 'task', type: 'task', title: 'task', optional: true, options: [{ value: '' }, { value: 'fs.come-home' }] },
    ...['h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q'].map(id => ({ id, type: 'text', optional: true })) ] };
  const v2 = renderPlanView({ version: 2, pid: 1, ack: 0, entries: [entry] }, 7).split('\n');
  ok('a protocol-2 view says protocol 2', v2[0].startsWith('M59PLAN\t2\t'));
  ok('its A rows carry the help text', v2.some(l => l === 'A\tfs.buy\tagents\tagents\tagents\t\twho%20buys'));
  ok('its O rows carry the condition', v2.some(l => l === 'O\tfs.buy\titem\tx\tx\tseller%3DA'));
  ok('a number carries its ranges, one per condition', v2.filter(l => l.startsWith('N\tfs.buy\twithdraw\t')).length === 2 &&
     v2.includes('N\tfs.buy\twithdraw\t0\t5000\tbank%3D376'));
  ok('sixteen arguments, not six', v2.filter(l => l.startsWith('A\t')).length === 16);
  const v1 = renderPlanView({ version: 1, pid: 1, ack: 0, entries: [entry] }, 7).split('\n');
  ok('a protocol-1 view has only rows an old client knows', v1[0].startsWith('M59PLAN\t1\t') && !v1.some(l => /^N\t/.test(l)) &&
     v1.filter(l => l.startsWith('O\t')).every(l => l.split('\t').length === 5) && v1.filter(l => l.startsWith('A\t')).every(l => l.split('\t').length === 6));
  ok('and six arguments, the new types as text', v1.filter(l => l.startsWith('A\t')).length === 6 &&
     v1.some(l => l.startsWith('A\tfs.buy\tagents\ttext\t')) && v1.some(l => l.startsWith('A\tfs.buy\twithdraw\ttext\t')));
  ok('a choice that depends on another argument goes to an old client as text', downgradeArg(entry.args[2]).type === 'text' && downgradeArg(entry.args[1]).type === 'choice');
  ok('a condition holds on a value, or on a member of a list', whenHolds('seller=A', { seller: 'A' }) && !whenHolds('seller=A', { seller: 'B' }) &&
     whenHolds('agents=hk2', { agents: 't3,hk2' }) && whenHolds('', {}));
  const g = { entries: [entry], owner: new Map([['fs.buy', { run: async (id, args) => ({ ok: true, message: JSON.stringify(args) }) }]]) };
  const run = async args => runRequest({ entry: 'fs.buy', args: { ...args } }, g, {});
  let r = await run({ agents: 'hk2', seller: 'A', item: 'x', withdraw: '4000', bank: '376' });
  ok('a full protocol-2 request runs, an empty optional argument let through', r.ok && JSON.parse(r.message).back === '', r.message);
  r = await run({ agents: 'hk2', seller: 'A', item: 'y', bank: '0' });
  ok('an option offered only under another seller is refused', !r.ok && /not one of the offered/.test(r.message));
  r = await run({ agents: 'hk2', seller: 'A', item: 'x', withdraw: '6000', bank: '376' });
  ok('a number outside the range its condition selects is refused', !r.ok && /outside 0–5000/.test(r.message), r.message);
  r = await run({ agents: 'hk2', seller: 'A', item: 'x', withdraw: '100', bank: '0' });
  ok('the range follows the other argument (no bank, no withdrawal)', !r.ok && /outside 0–0/.test(r.message));
  r = await run({ agents: 'hk2, t9', seller: 'A', item: 'x' });
  ok('an agent not on the offered list is refused by name', !r.ok && /t9 is not on the list/.test(r.message));
  r = await run({ agents: 'hk2', seller: 'A', item: 'x', task: 'fs.come-home?home=52' });
  ok('a nested script is checked by its row id, its own args riding along', r.ok && JSON.parse(r.message).task === 'fs.come-home?home=52');
  ok('a nested script nobody offered is refused', !(await run({ agents: 'hk2', seller: 'A', item: 'x', task: 'fs.nope' })).ok);
}

// ------------------------------------------------------------------ 3d. FleetScripts as pickers, and the line they become
{
  mkdirSync(join(substrate, 'banks'), { recursive: true });
  writeFileSync(join(substrate, 'banks', 'ZhengHe.json'), JSON.stringify({ accounts: { 'jasper-tos-barloque': { balance: 7000, at: 1 } } }));
  writeFileSync(join(dir, 'plan', 'in', '4244.tsv'), [`M59PLANREQ\t2\t${Date.now()}\t4244\t${enc('127.0.0.1:5959')}\t${enc('t1')}\t${enc('Kermit')}\t99\t1`, 'END', ''].join('\n'));
  await desk.tick();
  const out = readFileSync(join(dir, 'plan', 'out', '4244.tsv'), 'utf8').split('\n');
  const rowsOf = id => out.filter(l => l.split('\t')[1] === id);
  const buy = rowsOf('fs.buy');
  ok('a protocol-2 client is answered in protocol 2', out[0].startsWith('M59PLAN\t2\t'));
  ok('agents are a multi-select of the fleet, without the piloted character', buy.some(l => l.startsWith('A\tfs.buy\tagents\tagents\t')) &&
     buy.some(l => /^O\tfs\.buy\tagents\thk2\t/.test(l)) && !buy.some(l => /^O\tfs\.buy\tagents\tt1\t/.test(l)));
  ok('the bank balance is on the agent\'s label', buy.some(l => /^O\tfs\.buy\tagents\thk2\t[^\t]*7%2C000%20banked/.test(l)));
  ok('the seller is a dropdown of the catalogue', buy.some(l => /^O\tfs\.buy\tseller\tZhieu%20B%27hob\t/.test(l)));
  ok('the item list is that seller\'s shelf, by display name, conditioned on him',
     buy.some(l => l.startsWith('O\tfs.buy\titem\tpurple%20mushroom\t') && l.endsWith('\tseller%3DZhieu%20B%27hob')));
  ok('a wanderer\'s abilities are offered as learn: rows', buy.some(l => /^O\tfs\.buy\titem\tlearn%3Acurse%20weapon\t[^\t]*\tseller%3DMaleval$/.test(l)));
  ok('withdraw is capped at the most anyone has banked, per bank', buy.includes('N\tfs.buy\twithdraw\t0\t7000\tbank%3D376') &&
     buy.includes('N\tfs.buy\twithdraw\t0\t0\tbank%3D0') && !buy.some(l => /^N\tfs\.buy\twithdraw\t[^\n]*bank%3D2005/.test(l)));
  ok('a room param is a combo of every room', buy.some(l => l.startsWith('A\tfs.buy\tback\tcombo\t')) && buy.some(l => /^O\tfs\.buy\tback\t376\t376%20%E2%80%94%20The%20Royal%20Bank/.test(l)));
  ok('a fixed list is a choice', buy.some(l => l.startsWith('A\tfs.buy\tsearch\tchoice\t')));
  const trip = rowsOf('fs.island-trip');
  ok('island-trip\'s task is a nested-script picker and taskParams is not shown',
     trip.some(l => l.startsWith('A\tfs.island-trip\ttask\ttask\t')) && trip.some(l => /^O\tfs\.island-trip\ttask\tfs\.buy\t/.test(l)) &&
     !trip.some(l => /^A\tfs\.island-trip\ttaskparams\t/.test(l)) && !trip.some(l => /^O\tfs\.island-trip\ttask\tfs\.island-home\t/.test(l)));
  ok('required arguments come first', /^A\tfs\.buy\tagents\t/.test(buy.find(l => l.startsWith('A\t'))));

  const { loadFleetScripts } = await import('./m59-fleetlib.mjs');
  const { scripts } = await loadFleetScripts({ dirs: [['public', join(HERE, 'fleetscripts')]] });
  const t = taskValue("fs.buy?agents=t9&seller=Zhieu%20B'hob&item=purple%20mushroom&amount=30&back=", scripts);
  ok('a nested script\'s args become its name and typed JSON, its agents dropped', t.name === 'buy' && t.params.amount === 30 &&
     t.params.seller === "Zhieu B'hob" && !('agents' in t.params) && !('back' in t.params), JSON.stringify(t));
  const values = valuesFor(scripts.get('island-trip'), { agents: 'hk2', task: 'fs.buy?item=herbs&amount=5', departspacingms: '60000', outbound: 'walk' }, scripts);
  ok('the nested script lands in task + taskParams; a value equal to its default is left to the default',
     values.task === 'buy' && values.taskParams === '{"item":"herbs","amount":5}' && !('departSpacingMs' in values) && values.outbound === 'walk', JSON.stringify(values));
  const line = replLine('island-trip', values);
  ok('a value with a space travels as one %20 token', replValue("Zhieu B'hob") === "Zhieu%20B'hob" && replValue('50%') === '50%25' && replValue('38') === '38' &&
     line.split(' ').length === 5, line);
}

// ONE DESK PER CLIENT FOLDER (the broker's, or the terminal's, never both).
{
  const dir = join(tmp, 'guard-client'), subA = join(tmp, 'guard-a'), subB = join(tmp, 'guard-b');
  mkdirSync(join(dir, 'plan'), { recursive: true }); mkdirSync(subA, { recursive: true }); mkdirSync(subB, { recursive: true });
  const alive = pid => pid !== 999;
  ok('no heartbeat, no desk', liveDesk({ dir, substrate: subA }, { alive }) === null);
  writeFileSync(join(dir, 'plan', 'desk.json'), JSON.stringify({ pid: 4242, at: Date.now(), since: 1, substrate: subB, dir }));
  ok('a desk on ANOTHER substrate still holds the client folder', liveDesk({ dir, substrate: subA }, { alive })?.pid === 4242);
  ok('a desk does not see itself', liveDesk({ dir, substrate: subA }, { alive, exceptPid: 4242 }) === null);
  writeFileSync(join(dir, 'plan', 'desk.json'), JSON.stringify({ pid: 4242, at: Date.now() - 60_000, since: 1 }));
  ok('a stale heartbeat holds nothing', liveDesk({ dir, substrate: subA }, { alive }) === null);
  writeFileSync(join(dir, 'plan', 'desk.json'), JSON.stringify({ pid: 999, at: Date.now(), since: 1 }));
  ok('a dead pid holds nothing', liveDesk({ dir, substrate: subA }, { alive }) === null);
  writeFileSync(join(subA, 'plan-desk.json'), JSON.stringify({ pid: 4343, at: Date.now() }));
  ok('an older desk that beats only in the substrate is still seen', liveDesk({ dir, substrate: subA }, { alive })?.pid === 4343);
  ok('of two that started together, the later steps aside',
     yieldsTo({ pid: 5, since: 100 }, { pid: 6, since: 200 }) && !yieldsTo({ pid: 6, since: 200 }, { pid: 5, since: 100 }));
  ok('a tie goes to the lower pid',
     yieldsTo({ pid: 5, since: 100 }, { pid: 6, since: 100 }) && !yieldsTo({ pid: 6, since: 100 }, { pid: 5, since: 100 }));
  mkdirSync(join(dir, 'plan', 'out'), { recursive: true });
  writeFileSync(join(dir, 'plan', 'out', '77.tsv'), renderPlanView({ pid: 77, ack: 12 }));
  ok('a restarted desk resumes from the ack its predecessor wrote', lastAck(dir, 77) === 12 && lastAck(dir, 78) === 0);
}

// A CLIENT WITH NO DESK IS TOLD WHERE ONE IS (serveStrays).
{
  const roots = checkoutRoots('x', () => 'worktree C:/a\nHEAD 1\nbranch refs/heads/main\n\nworktree C:/b\nHEAD 2\ndetached\n');
  ok('every checkout is listed from git worktree list', roots.length === 2 && roots[1].replace(/\\/g, '/').endsWith('C:/b'), JSON.stringify(roots));
  ok('a client folder named twice is listed once',
     clientFolders(['C:/a'], ['C:/a/substrate/client-context', 'C:/z']).length === 2);
  const deskDir = join(tmp, 'stray-desk', 'cc'), strayDir = join(tmp, 'stray-client', 'cc'), quietDir = join(tmp, 'stray-quiet', 'cc');
  for (const d of [deskDir, strayDir, quietDir]) mkdirSync(join(d, 'plan', 'in'), { recursive: true });
  const alive = pid => pid === 5151;
  writeFileSync(join(deskDir, 'plan', 'desk.json'), JSON.stringify({ pid: 5151, at: Date.now(), fleet: 'prod', dir: deskDir,
    substrate: join(tmp, 'stray-desk', 'substrate'), root: 'C:\\code\\m59-lab\\prod-deploy' }));
  const req = (dirX, reqs) => writeFileSync(join(dirX, 'plan', 'in', '777.tsv'),
    [`M59PLANREQ\t1\t${Date.now()}\t777\t${enc('127.0.0.1:5959')}\t${enc('t1')}\t${enc('Kermit')}\t99\t1`,
     ...reqs.map(([q, e]) => `R\t${q}\t${e}\t`), 'END', ''].join('\n'));
  req(strayDir, [[3, 'courier']]); req(quietDir, []); req(deskDir, []);
  // quietDir's own desk beat moments ago (a handover): it must be left alone.
  writeFileSync(join(quietDir, 'plan', 'desk.json'), JSON.stringify({ pid: 9999, at: Date.now() }));
  const state = new Map();
  const n = serveStrays({ ownDir: deskDir, folders: [deskDir, strayDir, quietDir], state, alive });
  const out = join(strayDir, 'plan', 'out', '777.tsv');
  const text = existsSync(out) ? readFileSync(out, 'utf8') : '';
  const head = text.split('\n')[0].split('\t');
  ok('a client nobody serves is answered', n === 1 && head[0] === 'M59PLAN' && Date.now() - Number(head[2]) < 5000, text.slice(0, 200));
  ok('and told where the desk runs and what to launch',
     decodeURIComponent(head[6]).includes('C:\\code\\m59-lab\\prod-deploy') && decodeURIComponent(head[6]).includes('m59-tui.mjs') &&
     /\nE\tdesk\.elsewhere\t[^\n]*\td\t/.test(text));
  ok('a request typed there is refused and acknowledged, never left pending', head[4] === '3' && /\nM\t3\t0\tnot%20run/.test(text));
  ok('the desk does not answer its own folder this way', !existsSync(join(deskDir, 'plan', 'out', '777.tsv')));
  ok('a folder whose desk beat moments ago (a handover) is left alone', !existsSync(join(quietDir, 'plan', 'out', '777.tsv')));
  const old = (Date.now() - STRAY_QUIET_MS - 5000) / 1000; utimesSync(join(quietDir, 'plan', 'desk.json'), old, old);
  serveStrays({ ownDir: deskDir, folders: [deskDir, strayDir, quietDir], state, alive });
  ok('once that desk has been gone a minute, its client is told too', existsSync(join(quietDir, 'plan', 'out', '777.tsv')));
  ok('a refused request is refused once', (readFileSync(out, 'utf8').match(/\nM\t3\t/g) ?? []).length === 1);
  writeFileSync(join(deskDir, 'plan', 'desk.json'), JSON.stringify({ pid: 5151, at: 0 }));
  ok('with no desk anywhere, nothing is written', serveStrays({ ownDir: deskDir, folders: [deskDir, strayDir], state: new Map(), alive }) === 0);
}

// AN IDLE DESK READS NOTHING: a closed client's request file is skipped on its timestamp alone.
{
  const idleDir = join(tmp, 'idle', 'cc'), inDir = join(idleDir, 'plan', 'in');
  mkdirSync(inDir, { recursive: true });
  writeFileSync(join(inDir, '5.tsv'), 'not even a request');            // would fail to parse if it were read
  const old = (Date.now() - 3600_000) / 1000; utimesSync(join(inDir, '5.tsv'), old, old);
  ok('a closed client\'s file is not fresh', freshRequests(inDir).length === 0);
  let loaded = 0;
  const idle = await createDesk({ fleet: 'test', dir: idleDir, substrate: join(tmp, 'idle', 'sub'),
    providerDirs: [], roster: () => { loaded++; return []; } });
  ok('with no client open, a tick neither loads the roster nor serves anyone', await idle.tick() === 0 && loaded === 0);
  ok('and says once that nobody is at a keyboard', readFileSync(join(tmp, 'idle', 'sub', 'human-presence.json'), 'utf8') === '{}');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
