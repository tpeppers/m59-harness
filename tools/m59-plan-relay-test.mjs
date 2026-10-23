// Offline: the MANAGE tab relayed to a desk on another machine. A real desk (createDesk) with a
// stub provider, the broker's handler (servePlanRelay) on a loopback HTTP server, and the relay
// between two folders standing in for the Deck and Vecna.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesk, enc } from './m59-plan-desk.mjs';
import { servePlanRelay, exchange, createRelay, remotePid, localPid, slotFor, restamp, REMOTE_PID_BASE, PLAN_RELAY_PATH } from './m59-plan-relay.mjs';
import { winePath } from './m59-proton.mjs';

let passed = 0;
const ok = (name, cond, extra) => { assert.ok(cond, name + (extra === undefined ? '' : ' ' + JSON.stringify(extra))); passed++; };

const root = mkdtempSync(join(tmpdir(), 'plan-relay-'));
const vecna = join(root, 'vecna', 'client-context'), deck = join(root, 'deck', 'client-context'), provDir = join(root, 'providers');
mkdirSync(provDir, { recursive: true });
writeFileSync(join(provDir, 'stub.mjs'), `
export const provider = { id: 'stub',
  entries: ctx => [{ id: 'stub.run', group: 'Test', icon: '', title: 'Run the stub for ' + (ctx.client.agent ?? '?'), describe: 'test',
                     args: [{ id: 'who', title: 'who', type: 'text', default: '' }] }],
  run: async (id, args, ctx) => { globalThis.RUNS = [...(globalThis.RUNS ?? []), { id, args, agent: ctx.client.agent, pid: ctx.client.pid }];
                                  return { ok: true, message: 'ran for ' + args.who }; } };`);
const desk = await createDesk({ fleet: 'prod', dir: vecna, substrate: null, providerDirs: [provDir], log: () => {},
                                roster: () => [{ agent: 'pepe', account: 'acct9', character: 'Pepe' }] });
// The desk's heartbeat, as m59-plan-desk.mjs writes it, so `exchange` sees a live desk.
mkdirSync(join(vecna, 'plan'), { recursive: true });
writeFileSync(join(vecna, 'plan', 'desk.json'), JSON.stringify({ pid: process.pid, at: Date.now(), since: Date.now(), fleet: 'prod', dir: vecna }));

const request = ({ pid = 123, at = Date.now(), rows = [] } = {}) =>
  ['M59PLANREQ\t2\t' + at + '\t' + pid + '\t' + enc('76.214.42.186:5959') + '\tacct9\tPepe\t777\t1', ...rows, 'END', ''].join('\n');

// ---- pure parts
const slot = slotFor('steamdeck');
ok('slot is stable and in range', slot === slotFor('steamdeck') && slot >= 0 && slot < 1000);
ok('pid round-trips', localPid(remotePid(4321, slot), slot) === 4321 && remotePid(4321, slot) >= REMOTE_PID_BASE);
ok('restamp rewrites at and pid only', restamp('M59PLAN\t2\t5\t6\t7\tnone\tx\nEND\n', { at: 9, pid: 8 }) === 'M59PLAN\t2\t9\t8\t7\tnone\tx\nEND\n');
ok('winePath maps / to Z:', winePath('/home/deck/a b/c') === 'Z:\\home\\deck\\a b\\c');
ok('a local pid is refused (cannot overwrite a client on the desk machine)', exchange({ dir: vecna, text: request({ pid: 123 }) }).status === 400);
{
  const skewed = exchange({ dir: vecna, text: request({ pid: remotePid(55, slot), at: Date.now() - 3_600_000 }) });
  ok('a request from a clock an hour behind is accepted (the broker stamps it)', skewed.status === 200, skewed);
}

// ---- the broker's handler on loopback
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === PLAN_RELAY_PATH)
    return servePlanRelay(req, res, { dir: vecna, local: req.headers['x-test-remote'] !== '1' });
  res.writeHead(404); res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}${PLAN_RELAY_PATH}`;
try {
  const refused = await fetch(url, { method: 'POST', headers: { 'x-test-remote': '1' }, body: request({ pid: remotePid(1, slot) }) });
  ok('non-loopback is refused', refused.status === 403);

  const relay = createRelay({ dir: deck, url, slot });
  const inFile = join(deck, 'plan', 'in', '123.tsv'), outFile = join(deck, 'plan', 'out', '123.tsv');
  mkdirSync(join(deck, 'plan', 'in'), { recursive: true });
  const write = rows => writeFileSync(inFile, request({ rows }));

  write([]);
  await relay.tick();                       // request reaches the desk folder
  ok('the request lands in the desk folder under the remote pid', existsSync(join(vecna, 'plan', 'in', `${remotePid(123, slot)}.tsv`)));
  await desk.tick();                        // desk answers
  await relay.tick();                       // answer comes back
  const view = readFileSync(outFile, 'utf8');
  const h = view.split('\n', 1)[0].split('\t');
  ok('the reply comes back under the local pid', h[0] === 'M59PLAN' && h[3] === '123', h);
  ok('restamped fresh by this clock', Math.abs(Date.now() - Number(h[2])) < 3000, h);
  ok('the desk knew which character it was', /Run the stub for pepe/.test(decodeURIComponent(view)));

  // Run a row: once, and only once.
  write([`R\t1\tstub.run\t${enc('who=arrows')}`]);
  await relay.tick(); await desk.tick(); await relay.tick();
  await relay.tick(); await desk.tick(); await relay.tick();   // the client keeps the row until it sees the ack
  ok('the row ran exactly once', (globalThis.RUNS ?? []).length === 1, globalThis.RUNS);
  ok('as the remote pid, for pepe', globalThis.RUNS[0].agent === 'pepe' && globalThis.RUNS[0].pid === remotePid(123, slot));
  const after = readFileSync(outFile, 'utf8');
  ok('the ack and the result reach the client', after.split('\n', 1)[0].split('\t')[4] === '1' && /\nM\t1\t1\tran%20for%20arrows/.test(after), after.split('\n', 1)[0]);
} finally { server.close(); }

// ---- a broker that does not answer, and one too old to have the route
{
  const dead = createRelay({ dir: deck, url: 'http://127.0.0.1:9/' + PLAN_RELAY_PATH.slice(1), slot });
  writeFileSync(join(deck, 'plan', 'in', '123.tsv'), request());
  await dead.tick();
  const v = decodeURIComponent(readFileSync(join(deck, 'plan', 'out', '123.tsv'), 'utf8'));
  ok('an unreachable broker is said in the tab', /PLAN RELAY: the broker at .* did not answer/.test(v), v.slice(0, 200));
  const old = http.createServer((q, s) => { s.writeHead(404); s.end('no'); });
  await new Promise(r => old.listen(0, '127.0.0.1', r));
  try {
    await createRelay({ dir: deck, url: `http://127.0.0.1:${old.address().port}${PLAN_RELAY_PATH}`, slot }).tick();
    const w = decodeURIComponent(readFileSync(join(deck, 'plan', 'out', '123.tsv'), 'utf8'));
    ok('a broker without the route says to deploy and restart it', /older than this relay; deploy and restart it/.test(w));
  } finally { old.close(); }
}
console.log(`plan relay: ${passed} passed`);
