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
import { parsePlanRequest, renderPlanView, parseArgs, createDesk, enc, liveDesk, yieldsTo, lastAck,
         checkoutRoots, clientFolders, serveStrays, STRAY_QUIET_MS, freshRequests } from './m59-plan-desk.mjs';
import { reflectShopping, reflectPool, itemOptions } from './plans/courier.mjs';
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
