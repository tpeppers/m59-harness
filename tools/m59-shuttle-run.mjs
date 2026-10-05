#!/usr/bin/env node
// RESET THE SHUTTLE TEST TO ITS STARTING LINE AND RUN IT AGAIN.
//
//   node tools/m59-shuttle-run.mjs                 one lap
//   node tools/m59-shuttle-run.mjs --laps 3
//   node tools/m59-shuttle-run.mjs --no-restart    reuse the broker that is already up
//   node tools/m59-shuttle-run.mjs --dry-run       say what it would do, touch nothing
//
// The point of this file is REPEATABILITY. We are going to run this until everybody
// survives their journey, and a run that starts from wherever the last one left the fleet
// is not comparable to the one before it — half the characters begin hurt, in the wrong
// half of the map, or dead in the Underworld, and the arrival rate measures that instead
// of measuring the road.
//
// So every run starts from the same five things:
//
//   1. A BROKER ON THE CURRENT CODE. Restarted first, always, because the keepers run
//      INSIDE the broker — editing m59-autopilot.mjs changes nothing at all until it is
//      restarted, and a test that silently exercises the previous version is worse than
//      no test. `--no-restart` exists for a second run against unchanged code.
//   2. NOTHING FIGHTING. `mode: idle`, `roam: false`. The question is whether they can
//      cross the map, not whether they can farm on the way.
//   3. NO CONFINEMENT. `confine_rooms: []`, or the journeys are refused before they start
//      and the run measures the policy rather than the mover.
//   4. BOTH ENDS OCCUPIED. Alternating by roster index, so the split is identical every
//      time and both directions get the same number of attempts from the same bodies —
//      exits are not 1:1 here and a route that works one way often fails the other.
//   5. FULL HEALTH. Written straight to the server, because resting twenty-one characters
//      to full takes longer than the test does.
//
// IT REFUSES A GAME SERVER THAT IS NOT LOOPBACK, for the same reason m59-shuttle.mjs does:
// this walks a fleet in circles until it stops dying, which is a fine thing to do to a lab
// server and not a thing to do to one with other people on it.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rosterGameEndpoint } from './m59-fleetpath.mjs';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const flag = (n, d = null) => {
  const at = argv.indexOf('--' + n);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
};
const PORT  = Number(flag('port', 8971));
const DASH  = Number(flag('dashboard', 8972));
const FLEET = flag('fleet', 'shadow');
const LAPS  = Number(flag('laps', 1));
const MAXMS = Number(flag('max-ms', 900000));
const A = Number(flag('a', 38));     // Castle Victoria
const B = Number(flag('b', 50));     // The Streets of Tos
const DRY = has('dry-run');
const NO_RESTART = has('no-restart');

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const NODE = process.execPath;

function getJson(path, timeoutMs = 5000) {
  return new Promise(done => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path, method: 'GET',
      headers: { connection: 'close' }, agent: false, timeout: timeoutMs }, res => {
      let t = ''; res.setEncoding('utf8');
      res.on('data', c => { t += c; });
      res.on('end', () => { try { done(JSON.parse(t)); } catch { done(null); } });
    });
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
    req.end();
  });
}

function call(name, args, timeoutMs = 90000) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                                params: { name, arguments: args } });
  return new Promise(done => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/', method: 'POST',
      headers: { 'content-type': 'application/json',
                 'content-length': Buffer.byteLength(body), connection: 'close' },
      agent: false, timeout: timeoutMs }, res => {
      let t = ''; res.setEncoding('utf8');
      res.on('data', c => { t += c; });
      res.on('end', () => {
        try { done(JSON.parse(JSON.parse(t).result.content[0].text)); }
        catch (e) { done({ _error: e.message }); }
      });
    });
    req.on('timeout', () => { req.destroy(); done({ _error: 'timeout' }); });
    req.on('error', e => done({ _error: e.message }));
    req.end(body);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForFleet(want, deadlineMs = 300000) {
  const until = Date.now() + deadlineMs;
  let last = 0;
  while (Date.now() < until) {
    const h = await getJson('/health');
    const n = (h?.sessions ?? []).length;
    if (n !== last) { process.stdout.write(`\r   ${n}/${want} in game   `); last = n; }
    if (n >= want) { console.log(); return n; }
    await sleep(5000);
  }
  console.log();
  return last;
}

// ---------------------------------------------------------------- 0. WHICH FLEET
//
// ASKED OF THE ROSTER, BEFORE ANYTHING IS RESTARTED. This used to lean entirely on the
// /health check further down, and that check runs AFTER the restart — so
// `--fleet prod --port 8901` would have stopped and restarted the live prod broker,
// logging twenty-one real characters out, and only then refused to run the test. The
// refusal was correct and far too late.
//
// A roster names the server its characters are on, and it can be read with no broker up at
// all, which is exactly the moment this question has to be answered. `--fleet shadow` and
// port 8971 are only DEFAULTS; this is the guard.
const rosterFile = FLEET === '-' ? join(REPO, 'substrate', 'fleet-state.json')
                                 : join(REPO, 'substrate', 'fleets', `${FLEET}.json`);
const rostered = rosterGameEndpoint(rosterFile);
if (!rostered) {
  console.error(`shuttle-run: ${rosterFile} does not name one game server, so this cannot`);
  console.error(`             tell whether it is safe to walk that fleet in circles.`);
  process.exit(2);
}
if (!LOOPBACK.has(rostered.host.toLowerCase())) {
  console.error(`shuttle-run: REFUSING. Fleet "${FLEET}" is on ${rostered.host}:${rostered.port}, which is`);
  console.error(`             not loopback. This walks a fleet back and forth until it stops dying`);
  console.error(`             and restarts its broker to do it — that is for a lab server.`);
  process.exit(2);
}
console.log(`fleet "${FLEET}" -> ${rostered.host}:${rostered.port} (loopback), broker :${PORT}\n`);

// ---------------------------------------------------------------- 1. the broker
if (!NO_RESTART && !DRY) {
  console.log(`restarting the broker for "${FLEET}" — the keepers run inside it, so this is`);
  console.log(`what makes the run test the code that is on disk right now`);
  const r = spawnSync(NODE, [join(HERE, 'm59-service.mjs'), 'restart',
                             '--fleet', FLEET, '--http', String(PORT), '--dashboard', String(DASH)],
                      { cwd: REPO, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    console.error(r.stdout ?? ''); console.error(r.stderr ?? '');
    console.error('shuttle-run: the broker would not restart. Nothing was changed.');
    process.exit(1);
  }
  console.log('   waiting for the roster to come back');
}

const health = await getJson('/health');
if (!health?.ok) {
  console.error(`shuttle-run: no broker answering on 127.0.0.1:${PORT}.`);
  process.exit(1);
}

// HOW MANY TO WAIT FOR COMES FROM THE ROSTER, NOT FROM /health.
//
// The first version asked the broker how many sessions it KNEW about, immediately after
// restarting it — and a broker three seconds into its resume knows about one. So it waited
// for one, found two, and ran the whole test on two characters while reporting "2/1 in
// game" and looking perfectly successful. The roster file is the only thing that knows how
// many characters there are before any of them have logged in.
const rosterPath = FLEET === '-' ? join(REPO, 'substrate', 'fleet-state.json')
                                 : join(REPO, 'substrate', 'fleets', `${FLEET}.json`);
let expected = 0;
try { expected = Object.keys(JSON.parse(readFileSync(rosterPath, 'utf8'))).length; }
catch { expected = (health.known_sessions ?? []).length; }
if (!expected) {
  console.error(`shuttle-run: could not read a roster size from ${rosterPath}.`);
  process.exit(1);
}
if (!NO_RESTART && !DRY) {
  const got = await waitForFleet(expected);
  if (got < expected) {
    console.error(`shuttle-run: only ${got} of ${expected} came back. A partial fleet is not a`);
    console.error(`             comparable run — fix the fleet first, or pass --no-restart to`);
    console.error(`             deliberately test with what is up.`);
    process.exit(1);
  }
}

// The refusal, on the endpoint the sessions actually terminate at rather than the label.
const endpoints = Object.values((await getJson('/health'))?.session_game_servers ?? {});
const hosts = [...new Set(endpoints.map(e => String(e.host).toLowerCase()))];
if (!hosts.length) { console.error('shuttle-run: nothing is logged in.'); process.exit(1); }
const offside = hosts.filter(h => !LOOPBACK.has(h));
if (offside.length) {
  console.error(`shuttle-run: REFUSING — these characters are on ${offside.join(', ')}, not loopback.`);
  process.exit(2);
}

// ---------------------------------------------------------------- 2/3/4. the starting line
const fleet = await call('fleet', {});
const rows = (fleet.fleet ?? []).filter(r => r.agent && r.character)
  .sort((x, y) => x.agent.localeCompare(y.agent, 'en', { numeric: true }));
console.log(`\n${rows.length} character(s) on ${hosts.join(', ')}`);

// Alternating by roster order, so run N and run N+1 put the same character at the same end.
const startFor = i => (i % 2 === 0 ? A : B);
if (DRY) {
  rows.forEach((r, i) => console.log(`  ${String(r.character).padEnd(6)} -> start at ${startFor(i)}`));
  console.log('\n--dry-run: nothing was changed and no test was run.');
  process.exit(0);
}

console.log('standing them down: mode=idle, roam=false, confinement removed, unparked');
let stood = 0;
for (const r of rows) {
  const out = await call('autopilot', { agent: r.agent, mode: 'idle', roam: false, confine_rooms: [] });
  if (!out?._error) stood++;
  await call('autopilot', { agent: r.agent, action: 'unpark' });
}
console.log(`   ${stood}/${rows.length}`);

const dm = await import('./m59-dm.mjs');

// ONE SQUARE EACH, NOT ONE SQUARE FOR ALL OF THEM.
//
// `relocate` computes a single stand point for the whole batch — it snaps ONE square to
// walkable floor and sends every character in the list to it. That is right for its usual
// job and completely wrong for a starting line: it stacked eleven bodies on one square in
// Castle Victoria and ten on one square in the Streets of Tos, and a character inspected
// afterwards was missing three of its eight directions from `can_step`.
//
// That is the shape of the failure this run produced. Ten legs never left room 50 — busy,
// travelling, `! NOT MOVING — same square two pulses apart`, for four hundred seconds —
// with no take-back, no diversion and no safe-spot attempt anywhere in the record. A pile
// of characters that cannot step off their own square looks exactly like that.
//
// So they are spread. Two squares apart, spiralling out from the middle, and `relocate`
// still snaps each one to floor — so a spread square that lands in rock is corrected
// rather than becoming a character standing in a wall, which cannot be routed from at all.
const SPREAD = [];
for (let ring = 0; SPREAD.length < 64; ring++) {
  for (let dr = -ring; dr <= ring; dr++) {
    for (let dc = -ring; dc <= ring; dc++) {
      if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
      SPREAD.push([dr * 2, dc * 2]);
    }
  }
}
console.log('putting them on the starting line, one square each');
for (const room of [A, B]) {
  const who = rows.filter((_, i) => startFor(i) === room).map(r => r.character);
  if (!who.length) continue;
  const geom = dm.roomGeometry(room) ?? {};
  const midRow = Math.round((geom.rows || 20) / 2);
  const midCol = Math.round((geom.cols || 20) / 2);
  let placed = 0;
  for (let i = 0; i < who.length; i++) {
    const [dr, dc] = SPREAD[i] ?? [0, 0];
    const res = await dm.relocate([who[i]], room,
                                  { row: midRow + dr, col: midCol + dc, verify: false })
                        .catch(e => ({ error: e.message }));
    if (!res?.error) placed++;
  }
  console.log(`   room ${room}: ${placed}/${who.length} sent, spread over ${who.length} square(s)`);
}

// ---------------------------------------------------------------- 5. full health
// Object ids resolved fresh, in one batch, and never kept: they are renumbered on every
// system save alongside garbage collection, so a cached id is a different object later.
console.log('healing to full');
const snap = JSON.parse(readFileSync(join(REPO, 'substrate', 'shadow-snapshot.json'), 'utf8'));
const ids = await dm.resolve(snap.characters.map(c => c.shadow_name));
const cmds = [];
for (const c of snap.characters) {
  const id = ids[c.shadow_name];
  if (id != null && c.max_health) cmds.push(...dm.healthCmds(id, c.max_health));
}
const bad = dm.rejections(await dm.dm(cmds, { timeoutMs: 120000 }));
console.log(`   ${cmds.length} command(s)${bad.length ? `, ${bad.length} rejection(s)` : ', ok'}`);

// Read it back rather than trusting the write — a DM write does not push to the live
// session, so the broker's own view can lag it. This is about the SERVER being right.
const after = await call('fleet', {});
const notFull = (after.fleet ?? []).filter(r => {
  const m = /^(\d+)\/(\d+)/.exec(r.health || '');
  return m && Number(m[1]) < Number(m[2]);
});
console.log(`   at full health: ${(after.fleet ?? []).length - notFull.length}/${(after.fleet ?? []).length}` +
            (notFull.length ? ` — ${notFull.map(r => r.character).join(', ')} still short` : ''));

// PROVE THE SPREAD, because the whole point of it is a thing that cannot be seen from the
// send. `relocate` reports what it sent, not where the body ended up, and a spread square
// that snapped back onto an occupied one is silently a stack again.
const squares = new Map();
for (const r of (after.fleet ?? [])) {
  const look = await call('look', { agent: r.agent }, 30000);
  const you = look?.you;
  if (!you) continue;
  const k = `${look.room?.num}:${you.col},${you.row}`;
  squares.set(k, (squares.get(k) ?? 0) + 1);
}
const shared = [...squares].filter(([, n]) => n > 1);
console.log(`   standing on ${squares.size} distinct square(s)` +
  (shared.length ? ` — SHARED: ${shared.map(([k, n]) => `${k} x${n}`).join(', ')}` : ', none shared'));

// ---------------------------------------------------------------- and go
console.log(`\n=== running the shuttle: ${A} <-> ${B}, ${LAPS} lap(s), ${MAXMS / 1000}s per leg ===\n`);
const run = spawnSync(NODE, [join(HERE, 'm59-shuttle.mjs'),
                             '--laps', String(LAPS), '--max-ms', String(MAXMS),
                             '--port', String(PORT), '--a', String(A), '--b', String(B)],
                      { cwd: REPO, stdio: 'inherit', windowsHide: true });
process.exit(run.status ?? 0);
