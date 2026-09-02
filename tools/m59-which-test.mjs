#!/usr/bin/env node
// CAN `m59-which.mjs` EVER NAME THE WRONG FLEET?
//
//   node tools/m59-which-test.mjs
//
// Offline. It builds a throwaway checkout in TEMP — its own tools/ and substrate/ — and
// runs the REAL m59-which.mjs inside it against fake brokers on ephemeral ports. Nothing
// here touches this machine's rosters, and the child is given a --port that is closed so
// the default 8901 candidate cannot reach the live prod broker.
//
// WHY THIS FILE EXISTS. m59-which.mjs is the gate every `/m59*` command runs first, and
// its exit code is the only thing those commands read. It chose "the" broker like this:
//
//     const chosen = live.find(x => (x.health.fleet||'default') === fleet.label) ?? live[0];
//
// Two defects in one line. The `?? live[0]` fallback means that when the broker for OUR
// roster fails to answer, an UNRELATED broker is picked up and reported as though it were
// the answer to the question asked. Measured on this machine: the prod broker's /health
// takes 1046ms idle and 2573ms under load (it is the busy one — that is what makes it the
// one that matters), the shadow broker answers in 4ms, and a probe that missed prod printed
//
//     MISMATCH: the broker is holding "shadow" but this command would act on "prod".
//
// naming a fleet of 21 entirely different characters, about one run in four. And the `find`
// matches on the fleet LABEL, which CLAUDE.md says outright is not an identity: two
// checkouts can each hold a fleet called "prod" and they are not the same characters.
//
// The label case is the dangerous direction, because it fails to an ALL-CLEAR rather than
// to a refusal. So the assertions below care less about the wording than about two things:
// the tool must never make a positive statement about a fleet it could not reach, and it
// must never accept a broker as ours on the strength of a matching name.
import { mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(process.env.TEMP || '/tmp', `m59-which-test-${process.pid}`);
const SUB = join(ROOT, 'substrate');
const FLEETS = join(SUB, 'fleets');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
};

// ------------------------------------------------------------------ the fake checkout

mkdirSync(join(ROOT, 'tools', 'runtime'), { recursive: true });
mkdirSync(FLEETS, { recursive: true });
for (const f of ['m59-which.mjs', 'm59-fleetpath.mjs'])
  copyFileSync(join(HERE, f), join(ROOT, 'tools', f));
copyFileSync(join(HERE, 'runtime', 'fleet-lock.mjs'),
  join(ROOT, 'tools', 'runtime', 'fleet-lock.mjs'));

// Two rosters that exist on disk. Content only has to parse and have keys — this tool
// counts characters and never logs in.
const roster = names => JSON.stringify(Object.fromEntries(names.map(n => [n, { character: n }])));
writeFileSync(join(FLEETS, 'prod.json'), roster(['t1', 't2', 't3']));
writeFileSync(join(FLEETS, 'shadow.json'), roster(['s1', 's2']));
const PROD_ROSTER = join(FLEETS, 'prod.json');
const SHADOW_ROSTER = join(FLEETS, 'shadow.json');

// ------------------------------------------------------------------ fake brokers

const servers = [];
function listen(server) {
  return new Promise(done => server.listen(0, '127.0.0.1', () => {
    servers.push(server);
    done(server.address().port);
  }));
}
// A broker that answers /health, exactly as m59-broker.mjs does for the fields read here.
function fakeBroker({ pid, fleet, state, sessions = [], root = ROOT }) {
  return listen(http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid, fleet, state, sessions, root }));
  }));
}
// A port that ACCEPTS and never answers. This is the failure being reproduced: not a dead
// port (which is instant and definite) but a live broker too busy to reply in time.
function hungPort() {
  return listen(net.createServer(socket => { socket.on('error', () => {}); }));
}
// A port that is closed, so probing it is a definite "nothing there".
async function closedPort() {
  const s = net.createServer();
  const port = await listen(s);
  servers.pop();
  await new Promise(done => s.close(done));
  return port;
}

// ------------------------------------------------------------------ running the real tool

function pidFile(fleet, http_, at, pid = process.pid) {
  writeFileSync(join(SUB, `broker-${fleet}.pid`), JSON.stringify({ pid, fleet, at, http: http_ }));
}
function lockFile(fleet, rec) {
  writeFileSync(join(FLEETS, `${fleet}.json.lock`), JSON.stringify(rec));
}
function clearRecords() {
  for (const f of ['broker-prod.pid', 'broker-shadow.pid'])
    rmSync(join(SUB, f), { force: true });
  for (const f of ['prod.json.lock', 'shadow.json.lock'])
    rmSync(join(FLEETS, f), { force: true });
}

let DEAD_PORT;
// SPAWN, NOT execFileSync. The fake brokers above live in THIS process, and execFileSync
// blocks this process's event loop until the child exits — so every fake broker would
// refuse to answer for exactly as long as the tool was asking. That produced four
// beautifully plausible failures in an earlier draft of this file, all of them the test
// breaking rather than the tool.
function which(args = []) {
  return new Promise(done => {
    const child = spawn(process.execPath,
      [join(ROOT, 'tools', 'm59-which.mjs'), '--port', String(DEAD_PORT), ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // A CLEAN environment. M59_FLEET or M59_STATE_FILE leaking in from the shell that
        // ran the test would silently retarget the child at this machine's real roster.
        env: {
          PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP, TMP: process.env.TMP,
          M59_WHICH_TIMEOUT_MS: '400',      // so a hung port costs 0.4s, not 15s
        },
      });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => done({ code, out }));
  });
}

// ------------------------------------------------------------------ the cases

const now = Date.now();
DEAD_PORT = await closedPort();

// 1. THE HAPPY PATH. A broker whose /health names our roster path.
{
  clearRecords();
  const port = await fakeBroker({ pid: process.pid, fleet: 'prod', state: PROD_ROSTER, sessions: ['t1', 't2', 't3'] });
  pidFile('prod', port, now);
  lockFile('prod', { pid: process.pid, at: now });
  const r = await which(['--fleet', 'prod']);
  ok('a broker serving our roster is reported, exit 0', r.code === 0 && /holding prod/.test(r.out), `exit ${r.code}`);
  ok('and pid/start-time corroboration is either performed or explicitly unavailable',
     /corroborated: pid|process start time unavailable/.test(r.out));
}

// 2. THE REGRESSION. Our broker is up but too slow to answer; an unrelated broker is fast.
//    The old code picked the fast one and announced a fleet. There is no fallback now.
{
  clearRecords();
  const slow = await hungPort();
  const fast = await fakeBroker({ pid: process.pid, fleet: 'shadow', state: SHADOW_ROSTER, sessions: ['s1', 's2'] });
  pidFile('prod', slow, now);
  pidFile('shadow', fast, now);
  lockFile('prod', { pid: process.pid, at: now });        // a live pid genuinely holds prod
  const r = await which(['--fleet', 'prod']);
  ok('a slow broker for our fleet does NOT get reported as the other one', !/MISMATCH/.test(r.out), r.out.trim().split('\n').pop());
  ok('it says the answer is indeterminate instead', /INDETERMINATE/.test(r.out));
  ok('and refuses (exit 1)', r.code === 1, `exit ${r.code}`);
  ok('the unreachable port is named rather than passed over', /did not answer|did not answer|not answering/.test(r.out));
}

// 3. Same slow broker, but no lock at all — the other branch into "I do not know".
{
  clearRecords();
  const slow = await hungPort();
  const fast = await fakeBroker({ pid: process.pid, fleet: 'shadow', state: SHADOW_ROSTER });
  pidFile('prod', slow, now);
  pidFile('shadow', fast, now);
  const r = await which(['--fleet', 'prod']);
  ok('an unreachable port is never turned into a verdict about a fleet', /INDETERMINATE/.test(r.out) && !/MISMATCH/.test(r.out));
  ok('and that refuses too', r.code === 1, `exit ${r.code}`);
}

// 4. A FLEET LABEL IS NOT AN IDENTITY. Another checkout's broker, calling its fleet "prod",
//    serving a different roster file. The old `find` matched on the label and accepted it.
{
  clearRecords();
  const other = await fakeBroker({
    pid: process.pid, fleet: 'prod', sessions: ['x1'],
    state: join(ROOT, 'elsewhere', 'substrate', 'fleets', 'prod.json'),
    root: join(ROOT, 'elsewhere'),
  });
  pidFile('shadow', other, now);          // reachable, just not ours
  const r = await which(['--fleet', 'prod']);
  ok('a broker calling its fleet "prod" but serving another roster is NOT accepted as ours',
     r.code === 1, `exit ${r.code}`);
  ok('and it is called a mismatch, not a hold', /MISMATCH/.test(r.out) && !/corroborated/.test(r.out));
}

// 5. THE ORDINARY MISMATCH the file was written for: everything answered, nobody has ours.
{
  clearRecords();
  const port = await fakeBroker({ pid: process.pid, fleet: 'shadow', state: SHADOW_ROSTER, sessions: ['s1'] });
  pidFile('shadow', port, now);
  const r = await which(['--fleet', 'prod']);
  ok('a real mismatch is still loud and still exits 1', r.code === 1 && /MISMATCH/.test(r.out), `exit ${r.code}`);
}

// 6. NOTHING RUNNING. Every candidate port refused, definitely. This is the one all-clear,
//    and it must stay exit 0 or `./m59.sh up` can never start a fleet.
{
  clearRecords();
  const gone = await closedPort();
  pidFile('prod', gone, now);
  const r = await which(['--fleet', 'prod']);
  ok('nothing listening anywhere is an all-clear, exit 0', r.code === 0 && /nothing is holding a fleet/.test(r.out), `exit ${r.code}`);
}

// 7. A DEAD PRE-GUARD BROKER. Its pid being gone cannot prove that Windows also killed the
//    child keepers, so the read-only gate must agree with startup's explicit migration rule.
{
  clearRecords();
  const gone = await closedPort();
  pidFile('prod', gone, now);
  lockFile('prod', { pid: 999001, at: now - 400 * 24 * 3600 * 1000 });
  const r = await which(['--fleet', 'prod']);
  ok('a pre-guard lock never becomes an all-clear merely because its broker pid is dead',
     r.code === 1 && /pre-guard|keeper children/.test(r.out), `exit ${r.code}`);
  ok('and the reason is stated rather than silently dropped', /cannot prove|cannot be ruled out/.test(r.out));
}

// 8. A DEAD GUARDED BROKER WITH A LIVE KEEPER. The broker endpoint is down, but the
//    character socket can still be alive on Windows. That is ownership, not a stale lock.
{
  clearRecords();
  const gone = await closedPort();
  pidFile('prod', gone, now, 999001);
  lockFile('prod', {
    pid: 999001, at: now, kind: 'broker-runtime', token: 'guarded-owner-token',
    guards: [process.pid],
  });
  const r = await which(['--fleet', 'prod']);
  ok('a live keeper guard prevents the read-only fleet gate from issuing an all-clear',
     r.code === 1 && /keeper pid/.test(r.out), `exit ${r.code}`);
  ok('and lock deletion is not offered as a remedy', !/delete the lock only/.test(r.out));
}

// 9. THE RECORDS DISAGREE WITH THE SOCKET. A broker is serving our roster, but the lock names
//    a different pid — the shape of a second broker on one fleet, which reads healthy line by
//    line and is the failure CLAUDE.md is most emphatic about.
{
  clearRecords();
  const port = await fakeBroker({ pid: 999001, fleet: 'prod', state: PROD_ROSTER, sessions: ['t1'] });
  pidFile('prod', port, now, 999002);
  lockFile('prod', { pid: process.pid, at: now });
  const r = await which(['--fleet', 'prod']);
  ok('a broker whose pid disagrees with this fleet\'s records is called inconsistent',
     /INCONSISTENT/.test(r.out), r.out.trim().split('\n').pop());
  ok('and that refuses (exit 1)', r.code === 1, `exit ${r.code}`);
}

// ------------------------------------------------------------------

for (const s of servers) s.close();
try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* TEMP will get it */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
