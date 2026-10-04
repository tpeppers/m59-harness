#!/usr/bin/env node
// m59-sightings-test.mjs -- EVERY LOGIN AND LOGOFF, EXACTLY ONCE, HOWEVER MANY KEEPERS HEAR IT.
//
//   node tools/m59-sightings-test.mjs
//
// Offline. Opens no socket, touches no roster and no real history: every directory is a scratch
// directory, and the classifier is a fake (no war or grudge book is read).
//
// The operator's requirement, 2026-10-04: "Ensure it also doesn't do duplicate entries, since all
// the bots should each get the same messages." Every keeper process holds its own socket, so every
// login is heard ~24 times, seconds apart. What this pins (m59-sightings.mjs):
//   - 24 simulated keepers with jittered delivery (0-5s, order preserved per socket, as TCP does),
//     +-3s clock skew, late joiners, a fast relog (logoff and logon 400ms apart, slower than some
//     keepers' lag) and a HANDOFF (old and new keeper process both alive for 20s) -> exactly one
//     ledger row per server event, none lost, and one alert line per enemy event;
//   - the same with REAL concurrency: 8 child processes racing for the lock on one directory;
//   - the UTC-midnight boundary (day file and any time bucket): one event heard at 23:59:59.9 and
//     00:00:00.3 is one row;
//   - fleet-mates (and the keeper itself) are never recorded; enemy classification and the alert
//     line; a logoff the client could not name is resolved through the open session's id;
//   - a busy lock DEFERS (nothing written, nothing lost) and a dead writer's stale lock is broken;
//   - a keeper reading a list seconds ahead of a lagging peer does not write `present`/`absent`
//     for what the peer's wire row explains;
//   - the reader: logon->logoff pairing with durations, an open session, a session of unknown start
//     (present), an unknown end across a watch gap (absent `between`), reader-side collapse of a
//     duplicate, `--player` last seen, and `watching: false` when no keeper heartbeat is fresh;
//   - the CLI runs against a directory and prints JSON.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, utimesSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createSightingsObserver, pathsFor, readRows, report, collapse, sessions, makeClassifier, SCHEMA,
  HEARTBEAT_GAP_MS,
} from './m59-sightings.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ENEMIES = { morpheus: { basis: 'war_book', why: 'remembered as a member of Human Resistance we are at war with' },
                  sasquatch: { basis: 'grudge_book', why: 'in the grudge book' } };
const classify = makeClassifier({
  hostileBasis: ({ name }) => ENEMIES[String(name).toLowerCase()] ?? null,
  membership: name => String(name).toLowerCase() === 'morpheus' ? { guild: 'Human Resistance' } : null,
  playerClassName: () => 'normal',
});
const scratch = tag => mkdtempSync(join(tmpdir(), 'm59-sightings-' + tag + '-'));
const alertLines = dir => { const f = pathsFor(dir).alerts; return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []; };

// ------------------------------------------------------------------ child mode (real concurrency)
if (process.argv[2] === '--child') {
  const [, , , dir, idx, startAt] = process.argv;
  const me = 'Fleet' + idx;
  const obs = createSightingsObserver({ dir, agent: 't' + idx, character: me, classify,
    isFleetmate: n => /^fleet\d+$/i.test(n) });
  const c = { me: { name: me } };
  const events = JSON.parse(process.env.SIGHT_EVENTS);
  const wait = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
  await wait(Number(startAt) - Date.now());
  obs.event({ kind: 'who', players: [{ id: 1000 + Number(idx), name: me }] }, c);
  let clock = Number(startAt) + 300;
  for (const e of events) {
    clock = Math.max(clock + 1, Number(startAt) + 300 + e.t + Math.floor(Math.random() * 1500));
    await wait(clock - Date.now());
    obs.event({ kind: e.kind === 'logon' ? 'logged-on' : 'logged-off', id: e.id, name: e.name, at: Date.now() }, c);
  }
  for (let i = 0; i < 200 && obs.status().queued; i++) { await wait(20); obs.tick(c); }
  process.stdout.write(JSON.stringify(obs.status()));
  process.exit(0);
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e?.message ?? e).slice(0, 1500).replace(/\n/g, '\n     ')); }
}

// ------------------------------------------------------------------ the simulator
// A tiny seeded PRNG so a failure reproduces.
function rng(seed) { let x = seed >>> 0 || 1; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

function simulate({ seed = 1, keepers = 24, handoff = true, maxDelay = 5000 } = {}) {
  const R = rng(seed);
  const dir = scratch('sim' + seed);
  const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);
  const pool = ['Morpheus', 'Sasquatch', 'Wenbo', 'Kage', 'Roomba', 'Kermit', 'Gonzo'];   // Kermit, Gonzo = fleet
  const fleetNames = new Set(['kermit', 'gonzo', ...Array.from({ length: keepers + 1 }, (_, i) => 'fleet' + i)]);
  const isFleetmate = n => fleetNames.has(String(n).toLowerCase());
  const ids = Object.fromEntries(pool.map((n, i) => [n, 500 + i]));
  // Server truth: who is online, and the script of events.
  const online = new Set(['Morpheus', 'Wenbo', 'Kermit']);
  const initial = new Set(online);
  const script = [];
  let t = 10_000;
  for (let i = 0; i < 120; i++) {
    t += 500 + Math.floor(R() * 8000);
    const name = pool[Math.floor(R() * pool.length)];
    const kind = online.has(name) ? 'logoff' : 'logon';
    if (kind === 'logoff') online.delete(name); else online.add(name);
    script.push({ t, name, kind, id: ids[name] });
    // A FAST RELOG, now and then: logoff then logon 400ms later -- faster than the slow keepers.
    if (kind === 'logoff' && i % 9 === 0) { t += 400; online.add(name); script.push({ t, name, kind: 'logon', id: ids[name] }); }
  }
  const truthAt = time => {   // who the server would list at `time`
    const on = new Set(initial);
    for (const e of script) { if (e.t > time) break; if (e.kind === 'logon') on.add(e.name); else on.delete(e.name); }
    return on;
  };
  // Keepers: most join in the first 2s, three join late; one is handed off mid-run.
  const ks = [];
  for (let i = 0; i < keepers; i++) {
    const join = i < keepers - 3 ? Math.floor(R() * 2000) : [200_000, 400_000, 600_000][i - (keepers - 3)];
    ks.push({ i, name: 'Fleet' + i, join, leave: Infinity, skew: Math.floor(R() * 6000) - 3000 });
  }
  const H = 300_000;
  if (handoff) {   // the new half of a handoff: same character, a NEW process, fresh memory
    ks.push({ i: keepers, name: 'Fleet5', join: H, leave: Infinity, skew: ks[5].skew + 700 });
    ks[5].leave = H + 20_000;
  }
  let clock = T0;
  const deliveries = [];
  for (const k of ks) {
    k.client = { me: { name: k.name }, playersOnline: new Map() };
    k.obs = createSightingsObserver({ dir, agent: 't' + k.i, character: k.name, classify, isFleetmate,
                                      now: () => clock + k.skew });
    const players = [...truthAt(k.join)].map(n => ({ id: ids[n], name: n }));
    players.push({ id: 900 + k.i, name: k.name });
    deliveries.push({ at: T0 + k.join, k, ev: { kind: 'who', players } });
    let prev = k.join;
    for (const e of script) {
      if (e.t <= k.join) continue;
      const d = Math.max(prev + 1, e.t + Math.floor(R() * maxDelay));
      if (d > k.leave) break;
      prev = d;
      deliveries.push({ at: T0 + d, k, ev: { kind: e.kind === 'logon' ? 'logged-on' : 'logged-off', id: e.id, name: e.name } });
    }
    for (let tt = k.join + 30_000; tt < Math.min(k.leave, script.at(-1).t + 200_000); tt += 30_000)
      deliveries.push({ at: T0 + tt, k, tick: true });
  }
  deliveries.sort((a, b) => a.at - b.at);
  for (const d of deliveries) {
    clock = d.at;
    const c = d.k.client;
    if (d.tick) { d.k.obs.tick(c); continue; }
    const ev = { ...d.ev, at: clock + d.k.skew };
    // The client's own bookkeeping, exactly as m59-client.mjs does it: a logoff's name is whatever
    // this client's playersOnline held.
    if (ev.kind === 'who') { c.playersOnline.clear(); for (const p of ev.players) c.playersOnline.set(p.id, p); }
    else if (ev.kind === 'logged-on') c.playersOnline.set(ev.id, { id: ev.id, name: ev.name });
    else { ev.name = c.playersOnline.get(ev.id)?.name; c.playersOnline.delete(ev.id); }
    d.k.obs.event(ev, c);
  }
  const firstWatch = Math.min(...ks.map(k => k.join));
  const expected = script.filter(e => e.t > firstWatch && !isFleetmate(e.name));
  return { dir, script, expected, initial: [...initial].filter(n => !isFleetmate(n)), ks, isFleetmate };
}

// SIGHT_SEEDS=200 SIGHT_DELAY=15000 widens the sweep (a soak, not part of the standard run).
const SEEDS = process.env.SIGHT_SEEDS ? Array.from({ length: Number(process.env.SIGHT_SEEDS) }, (_, i) => i + 1) : [1, 7, 42];
const MAX_DELAY = Number(process.env.SIGHT_DELAY || 5000);
for (const seed of SEEDS) {
  await test(`24 keepers, jitter + skew + late joiners + handoff (seed ${seed}): one row per event, none lost`, () => {
    const sim = simulate({ seed, maxDelay: MAX_DELAY });
    const rows = readRows(sim.dir);
    const wire = rows.filter(r => r.kind === 'logon' || r.kind === 'logoff');
    // Per name, the recorded sequence of kinds IS the server's sequence -- nothing lost, nothing doubled.
    for (const n of new Set(sim.expected.map(e => e.name))) {
      const want = sim.expected.filter(e => e.name === n);
      const got = wire.filter(r => r.name === n).sort((a, b) => a.seq - b.seq);
      if (process.env.SIGHT_DUMP && got.map(r => r.kind).join() !== want.map(e => e.kind).join())
        console.log(n, '\n want', want.map(e => `${e.kind}@${e.t}`).join(' '),
                    '\n got ', got.map(r => `${r.kind}@${r.at - Date.UTC(2026, 9, 4, 12)}:${r.agent}`).join(' '));
      assert.equal(got.map(r => r.kind).join(','), want.map(e => e.kind).join(','), `sequence for ${n}`);
    }
    assert.equal(wire.length, sim.expected.length, `wire rows ${wire.length} vs server events ${sim.expected.length}`);
    // The only reconciliation rows are the players already online when the watch began.
    const present = rows.filter(r => r.kind === 'present').map(r => r.name).sort();
    assert.deepEqual(present, sim.initial.sort());
    assert.equal(rows.filter(r => r.kind === 'absent').length, 0, 'no absent: every departure was heard on the wire');
    assert.equal(rows.filter(r => r.kind === 'watch_resumed').length, 1, 'one watch began, none resumed');
    assert.equal(collapse(rows).collapsed, 0, 'the reader found nothing to collapse');
    const absorbed = sim.ks.reduce((a, k) => a + k.obs.status().absorbed, 0);
    assert.ok(absorbed > sim.expected.length * 15, `the other keepers' copies were absorbed (${absorbed})`);
    // Exactly one alert line per enemy event, plus one PRESENT for Morpheus online at the start.
    const enemyEvents = sim.expected.filter(e => ENEMIES[e.name.toLowerCase()]).length;
    const lines = alertLines(sim.dir);
    assert.equal(lines.length, enemyEvents + 1, `alert lines ${lines.length}`);
    assert.ok(lines.every(l => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ ENEMY (ONLINE|OFFLINE|PRESENT|GONE) (Morpheus|Sasquatch) /.test(l)), lines[0]);
    assert.equal(lines.filter(l => / ENEMY PRESENT Morpheus \(Human Resistance; war_book\)/.test(l)).length, 1);
    assert.equal(rows.filter(r => r.schema !== SCHEMA).length, 0);
  });
}

await test('a keeper 5s behind a fast relog (logoff, logon 400ms later) records neither twice', () => {
  const dir = scratch('relog');
  let clock = Date.UTC(2026, 9, 4, 1, 0, 0);
  const mk = (name, skew = 0) => ({ c: { me: { name } }, o: createSightingsObserver({ dir, character: name, classify,
    isFleetmate: n => /^fleet/i.test(n), now: () => clock + skew }) });
  const A = mk('FleetA'), B = mk('FleetB', 2500);
  for (const k of [A, B]) k.o.event({ kind: 'who', players: [{ id: 1, name: k.c.me.name }] }, k.c);
  const ev = (k, kind, at) => k.o.event({ kind, id: 77, name: 'Morpheus', at }, k.c);
  const t0 = clock + 1000;
  // A hears everything promptly.
  clock = t0;        ev(A, 'logged-on', clock);
  clock = t0 + 9000; ev(A, 'logged-off', clock);
  clock = t0 + 9400; ev(A, 'logged-on', clock);
  // B hears the same three, 5s late each, with its clock 2.5s ahead.
  clock = t0 + 5000;  ev(B, 'logged-on', clock + 2500);
  clock = t0 + 14000; ev(B, 'logged-off', clock + 2500);
  clock = t0 + 14400; ev(B, 'logged-on', clock + 2500);
  const rows = readRows(dir).filter(r => r.name === 'Morpheus');
  assert.deepEqual(rows.map(r => r.kind), ['logon', 'logoff', 'logon']);
  assert.equal(B.o.status().absorbed, 3);
  assert.equal(alertLines(dir).length, 3);
  // ...and a genuinely NEW logoff after that, heard by B first, IS recorded.
  clock = t0 + 60_000; ev(B, 'logged-off', clock + 2500);
  clock = t0 + 61_000; ev(A, 'logged-off', clock);
  assert.deepEqual(readRows(dir).filter(r => r.name === 'Morpheus').map(r => r.kind), ['logon', 'logoff', 'logon', 'logoff']);
});

await test('a keeper AHEAD of the ledger holds an out-of-order event until the late peer writes the one before it', () => {
  // Found by the 15s soak: a handoff's new process logged in just after Morpheus did, heard his
  // logoff before any lagging peer had written his logon, and wrote the logoff first -- the peer
  // then wrote the logon AND, finding no logoff after its own row, the logoff again.
  const dir = scratch('hold');
  let clock = Date.UTC(2026, 9, 4, 12, 0, 0);
  const mk = name => ({ c: { me: { name } }, o: createSightingsObserver({ dir, character: name, classify,
    isFleetmate: n => /^fleet/i.test(n), now: () => clock }) });
  const A = mk('FleetA');
  A.o.event({ kind: 'who', players: [{ id: 1, name: 'FleetA' }] }, A.c);
  const T = clock + 60_000;
  // Morpheus logs on at T and off at T+3s. B logs in at T+1s (its list has him) and hears the
  // logoff promptly; A is 10s behind on both.
  const B = mk('FleetB');
  clock = T + 1000; B.o.event({ kind: 'who', players: [{ id: 2, name: 'FleetB' }, { id: 7, name: 'Morpheus' }] }, B.c);
  clock = T + 3000; B.o.event({ kind: 'logged-off', id: 7, name: 'Morpheus', at: clock }, B.c);
  assert.equal(readRows(dir).filter(r => r.name).length, 0, 'held: the ledger has no logon for him yet');
  assert.equal(B.o.status().held, 1);
  clock = T + 10_000; A.o.event({ kind: 'logged-on', id: 7, name: 'Morpheus', at: clock }, A.c);
  clock = T + 13_000; A.o.event({ kind: 'logged-off', id: 7, name: 'Morpheus', at: clock }, A.c);
  clock = T + 40_000; B.o.tick(B.c); A.o.tick(A.c);
  assert.deepEqual(readRows(dir).filter(r => r.name).map(r => `${r.kind}:${r.name}`), ['logon:Morpheus', 'logoff:Morpheus']);
  assert.equal(alertLines(dir).length, 2);
  // ALONE, the same logoff is still recorded once the wait runs out -- marked, never lost.
  const dir2 = scratch('hold-alone');
  const C = { c: { me: { name: 'FleetC' } } };
  C.o = createSightingsObserver({ dir: dir2, character: 'FleetC', classify, isFleetmate: n => /^fleet/i.test(n), now: () => clock });
  C.o.event({ kind: 'who', players: [{ id: 3, name: 'FleetC' }] }, C.c);
  clock += 1000; C.o.event({ kind: 'logged-off', id: 9, name: 'Kage', at: clock }, C.c);
  assert.equal(readRows(dir2).filter(r => r.name).length, 0);
  clock += 31_000; C.o.tick(C.c);
  const rows = readRows(dir2).filter(r => r.name);
  assert.deepEqual(rows.map(r => r.kind), ['logoff']); assert.match(rows[0].inconsistent, /logon was missed/);
});

await test('the UTC midnight boundary: one event heard either side of it is ONE row', () => {
  const dir = scratch('midnight');
  const mid = Date.UTC(2026, 9, 5, 0, 0, 0);
  let clock = mid - 60_000;
  const A = { c: { me: { name: 'FleetA' } } }, B = { c: { me: { name: 'FleetB' } } };
  for (const k of [A, B]) {
    k.o = createSightingsObserver({ dir, character: k.c.me.name, classify, isFleetmate: n => /^fleet/i.test(n), now: () => clock });
    k.o.event({ kind: 'who', players: [{ id: 1, name: k.c.me.name }] }, k.c);
  }
  clock = mid - 100; A.o.event({ kind: 'logged-on', id: 9, name: 'Kage', at: clock }, A.c);
  clock = mid + 300; B.o.event({ kind: 'logged-on', id: 9, name: 'Kage', at: clock }, B.c);
  const files = readdirSync(dir).filter(f => f.startsWith('sightings-2026'));
  const rows = readRows(dir).filter(r => r.name === 'Kage');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].iso.slice(0, 10), '2026-10-04', 'filed under the first writer\'s day');
  assert.ok(files.includes('sightings-2026-10-04.jsonl'));
});

await test('fleet-mates (and the keeper itself) are never recorded; strangers are', () => {
  const dir = scratch('mates');
  const c = { me: { name: 'Kermit' } };
  const o = createSightingsObserver({ dir, character: 'Kermit', classify, isFleetmate: n => ['kermit', 'gonzo', 'loial'].includes(n.toLowerCase()) });
  o.event({ kind: 'who', players: [{ id: 1, name: 'Kermit' }, { id: 2, name: 'Gonzo' }, { id: 3, name: 'Wenbo' }] }, c);
  o.event({ kind: 'logged-on', id: 4, name: 'Loial' }, c);          // a menagerie host: ours
  o.event({ kind: 'logged-off', id: 2, name: 'Gonzo' }, c);         // a relog of ours
  o.event({ kind: 'logged-on', id: 5, name: 'Roomba' }, c);
  const rows = readRows(dir).filter(r => r.name);
  assert.deepEqual(rows.map(r => `${r.kind}:${r.name}`).sort(), ['logon:Roomba', 'present:Wenbo']);
  assert.equal(o.status().excluded, 2);
  assert.equal(alertLines(dir).length, 0, 'strangers raise no alert');
});

await test('enemy classification on the row, and the alert lines say who, why and how long', () => {
  const dir = scratch('enemy');
  let clock = Date.UTC(2026, 9, 4, 12, 0, 0);
  const c = { me: { name: 'Kermit' } };
  const o = createSightingsObserver({ dir, character: 'Kermit', classify, isFleetmate: n => n === 'Kermit', now: () => clock });
  o.event({ kind: 'who', players: [{ id: 1, name: 'Kermit' }] }, c);
  clock += 1000; o.event({ kind: 'logged-on', id: 7, name: 'Morpheus', flags: 4, at: clock }, c);
  clock += 1000; o.event({ kind: 'logged-on', id: 8, name: 'Sasquatch', at: clock }, c);
  clock += 27 * 60_000 + 14_000; o.event({ kind: 'logged-off', id: 7, name: 'Morpheus', at: clock }, c);
  const rows = readRows(dir).filter(r => r.name);
  const m = rows.find(r => r.name === 'Morpheus' && r.kind === 'logon');
  assert.equal(m.class, 'war_book'); assert.equal(m.enemy, true); assert.equal(m.guild, 'Human Resistance');
  assert.equal(rows.find(r => r.name === 'Sasquatch').class, 'grudge_book');
  const off = rows.find(r => r.name === 'Morpheus' && r.kind === 'logoff');
  assert.equal(off.session_ms, 27 * 60_000 + 15_000);
  const lines = alertLines(dir);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '2026-10-04T12:00:01Z ENEMY ONLINE Morpheus (Human Resistance; war_book) seen by Kermit');
  assert.equal(lines[2], '2026-10-04T12:27:16Z ENEMY OFFLINE Morpheus (Human Resistance; war_book) after 27m15s seen by Kermit');
});

await test('a logoff the client could not name (it carries only an id) is resolved through the open session', () => {
  const dir = scratch('noname');
  const A = { me: { name: 'FleetA' } }, B = { me: { name: 'FleetB' } };
  const mk = name => createSightingsObserver({ dir, character: name, classify, isFleetmate: n => /^fleet/i.test(n) });
  const a = mk('FleetA'), b = mk('FleetB');
  a.event({ kind: 'logged-on', id: 31, name: 'Wenbo' }, A);
  b.event({ kind: 'logged-off', id: 31, name: undefined }, B);   // B joined after his logon
  const rows = readRows(dir).filter(r => r.name);
  assert.deepEqual(rows.map(r => `${r.kind}:${r.name}`), ['logon:Wenbo', 'logoff:Wenbo']);
  b.event({ kind: 'logged-off', id: 99, name: undefined }, B);   // nobody we know: counted, not written
  assert.equal(b.status().unnamed, 1);
});

await test('a busy lock DEFERS (nothing written, nothing lost); a dead writer\'s stale lock is broken', () => {
  const dir = scratch('lock');
  mkdirSync(dir, { recursive: true });
  const p = pathsFor(dir);
  const c = { me: { name: 'FleetA' } };
  const o = createSightingsObserver({ dir, character: 'FleetA', classify, isFleetmate: n => /^fleet/i.test(n), lock: { waitMs: 20 } });
  writeFileSync(p.lock, JSON.stringify({ pid: process.pid, at: Date.now() }));   // a live holder
  o.event({ kind: 'logged-on', id: 3, name: 'Kage' }, c);
  o.event({ kind: 'logged-off', id: 3, name: 'Kage' }, c);
  assert.equal(readRows(dir).length, 0);
  assert.equal(o.status().queued, 2);
  unlinkSync(p.lock);
  o.tick(c);
  // In the order heard: a deferred job is never overtaken (the matched cursor depends on it).
  assert.deepEqual(readRows(dir).map(r => `${r.kind}:${r.name}`), ['logon:Kage', 'logoff:Kage']);
  assert.equal(o.status().queued, 0);
  // A lock left by a process that no longer exists, and old: broken, not waited on for ever.
  writeFileSync(p.lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: 0 }));
  const old = (Date.now() - 60_000) / 1000; utimesSync(p.lock, old, old);
  o.event({ kind: 'logged-on', id: 4, name: 'Roomba' }, c);
  assert.deepEqual(readRows(dir).map(r => r.name), ['Kage', 'Kage', 'Roomba']);
});

await test('a list seconds AHEAD of a lagging peer writes no present/absent the peer\'s wire row explains', () => {
  const dir = scratch('ahead');
  let clock = Date.UTC(2026, 9, 4, 12, 0, 0);
  const mk = name => ({ c: { me: { name } }, o: createSightingsObserver({ dir, character: name, classify,
    isFleetmate: n => /^fleet/i.test(n), now: () => clock }) });
  const A = mk('FleetA');
  A.o.event({ kind: 'who', players: [{ id: 1, name: 'FleetA' }, { id: 7, name: 'Wenbo' }] }, A.c);   // watch begins
  clock += 60_000; A.o.tick(A.c);
  // Wenbo logs off and Kage logs on at T. A is slow: it hears both 4s later. B logs in at T+1s
  // and its list already reflects both.
  const T = clock + 1000;
  const B = mk('FleetB');
  clock = T + 1000; B.o.event({ kind: 'who', players: [{ id: 2, name: 'FleetB' }, { id: 8, name: 'Kage' }] }, B.c);
  clock = T + 4000; A.o.event({ kind: 'logged-off', id: 7, name: 'Wenbo', at: clock }, A.c);
  A.o.event({ kind: 'logged-on', id: 8, name: 'Kage', at: clock }, A.c);
  clock = T + 120_000; A.o.tick(A.c); B.o.tick(B.c);
  const rows = readRows(dir).filter(r => r.name);
  assert.deepEqual(rows.map(r => `${r.kind}:${r.name}`), ['present:Wenbo', 'logoff:Wenbo', 'logon:Kage']);
  // ...but a disagreement NOTHING explains is committed, with the list's time.
  clock += 1000; const tl = clock;
  B.o.event({ kind: 'who', players: [{ id: 2, name: 'FleetB' }] }, B.c);   // Kage gone, no logoff heard
  clock += 61_000; B.o.tick(B.c);
  const absent = readRows(dir).find(r => r.kind === 'absent');
  assert.equal(absent?.name, 'Kage'); assert.equal(absent.at, tl); assert.equal(absent.between[1], tl);
});

await test('8 child processes racing for the lock on one directory: exactly one row per event', async () => {
  const dir = scratch('procs');
  const events = [];
  const names = ['Morpheus', 'Wenbo', 'Kage', 'Roomba', 'Sasquatch'];
  const on = new Set();
  let t = 0;
  for (let i = 0; i < 40; i++) {
    const name = names[i % names.length];
    const kind = on.has(name) ? 'logoff' : 'logon';
    if (kind === 'logoff') on.delete(name); else on.add(name);
    events.push({ t, name, kind, id: 100 + names.indexOf(name) });
    t += i % 10 === 9 ? 100 : 300;   // every tenth gap is a fast relog-sized gap
  }
  const startAt = Date.now() + 1500;
  const kids = Array.from({ length: 8 }, (_, i) => new Promise((res, rej) => {
    const ch = spawn(process.execPath, [join(HERE, 'm59-sightings-test.mjs'), '--child', dir, String(i), String(startAt)],
      { env: { ...process.env, SIGHT_EVENTS: JSON.stringify(events) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    ch.stdout.on('data', d => out += d); ch.stderr.on('data', d => err += d);
    ch.on('exit', code => code === 0 ? res(JSON.parse(out)) : rej(new Error(`child ${i} exit ${code}: ${err}`)));
  }));
  const stats = await Promise.all(kids);
  const rows = readRows(dir).filter(r => r.kind === 'logon' || r.kind === 'logoff');
  assert.equal(rows.length, events.length, `rows ${rows.length} vs events ${events.length}`);
  for (const n of names)
    assert.equal(rows.filter(r => r.name === n).sort((a, b) => a.seq - b.seq).map(r => r.kind).join(),
                 events.filter(e => e.name === n).map(e => e.kind).join(), n);
  assert.equal(stats.reduce((a, s) => a + s.recorded, 0) - readRows(dir).filter(r => r.kind === 'watch_resumed').length, events.length);
  assert.equal(stats.reduce((a, s) => a + s.absorbed, 0), events.length * 7);
  assert.equal(alertLines(dir).length, events.filter(e => ENEMIES[e.name.toLowerCase()]).length);
  assert.ok(!existsSync(pathsFor(dir).lock), 'no lock left behind');
});

// ------------------------------------------------------------------ the reader
function writeRows(dir, rows, { heartbeat = null } = {}) {
  mkdirSync(dir, { recursive: true });
  let seq = 0;
  for (const r of rows) {
    const row = { schema: SCHEMA, seq: ++seq, ...r, iso: new Date(r.at).toISOString() };
    const f = pathsFor(dir).day(r.at);
    writeFileSync(f, (existsSync(f) ? readFileSync(f, 'utf8') : '') + JSON.stringify(row) + '\n');
  }
  if (heartbeat != null) writeFileSync(pathsFor(dir).state, JSON.stringify({ v: 1, epoch: 'x', seq, heartbeat, recent: [], open: {} }));
}
const H0 = Date.UTC(2026, 9, 4, 10, 0, 0), MIN = 60_000;

await test('reader: pairing, open sessions, unknown start, unknown end across a watch gap, last seen', () => {
  const dir = scratch('reader');
  writeRows(dir, [
    { kind: 'watch_resumed', at: H0, gap_from: null, gap_to: H0 },
    { kind: 'present', at: H0, name: 'Wenbo', class: 'stranger' },
    { kind: 'logon', at: H0 + 5 * MIN, name: 'Morpheus', class: 'war_book', enemy: true, guild: 'Human Resistance' },
    { kind: 'logoff', at: H0 + 35 * MIN, name: 'Morpheus', class: 'war_book', enemy: true },
    { kind: 'logon', at: H0 + 40 * MIN, name: 'Morpheus', class: 'war_book', enemy: true },
    { kind: 'logon', at: H0 + 50 * MIN, name: 'Kage', class: 'stranger' },
    // nobody watching from 60 to 120 minutes
    { kind: 'watch_resumed', at: H0 + 120 * MIN, gap_from: H0 + 60 * MIN, gap_to: H0 + 120 * MIN },
    { kind: 'absent', at: H0 + 120 * MIN, name: 'Kage', between: [H0 + 60 * MIN, H0 + 120 * MIN] },
    { kind: 'logon', at: H0 + 130 * MIN, name: 'Sasquatch', class: 'grudge_book', enemy: true },
  ], { heartbeat: H0 + 150 * MIN });
  const r = report(dir, { now: H0 + 151 * MIN, sinceMs: 24 * 36e5 });
  assert.equal(r.watching, true);
  // Enemies first, then strangers.
  assert.deepEqual(r.online.map(s => s.name), ['Morpheus', 'Sasquatch', 'Wenbo']);
  const m2 = r.online.find(s => s.name === 'Morpheus');
  assert.equal(m2.start, H0 + 40 * MIN); assert.equal(m2.gaps.length, 1, 'his session spans the gap: may have relogged');
  const w = r.online.find(s => s.name === 'Wenbo');
  assert.equal(w.start_known, false); assert.equal(w.online_before, H0);
  const m1 = r.sessions.find(s => s.name === 'Morpheus' && !s.open);
  assert.equal(m1.duration_ms, 30 * MIN);
  const k = r.sessions.find(s => s.name === 'Kage');
  assert.equal(k.end_known, false); assert.deepEqual(k.end_between, [H0 + 60 * MIN, H0 + 120 * MIN]);
  assert.equal(k.duration_ms, null, 'an end nobody saw is not invented');
  assert.equal(k.at_least_ms, 10 * MIN);
  assert.deepEqual(r.gaps.filter(g => g.from != null).map(g => g.to - g.from), [60 * MIN]);
  const pr = report(dir, { now: H0 + 151 * MIN, player: 'morpheus' });
  assert.equal(pr.sessions.length, 2); assert.equal(pr.last_seen.at, H0 + 40 * MIN);
  const er = report(dir, { now: H0 + 151 * MIN, enemyOnly: true });
  assert.ok(er.sessions.every(s => s.enemy)); assert.ok(er.online.every(s => s.enemy));
});

await test('reader: no fresh heartbeat -> watching:false; a duplicate row is collapsed and counted', () => {
  const dir = scratch('stale');
  writeRows(dir, [
    { kind: 'logon', at: H0, name: 'Kage' },
    { kind: 'logon', at: H0 + 3000, name: 'Kage' },        // a writer bug's second copy
    { kind: 'logoff', at: H0 + 10 * MIN, name: 'Kage' },
  ], { heartbeat: H0 + 10 * MIN });
  const r = report(dir, { now: H0 + 10 * MIN + HEARTBEAT_GAP_MS + 1000 });
  assert.equal(r.watching, false);
  assert.equal(r.collapsed, 1);
  assert.equal(r.sessions.length, 1); assert.equal(r.sessions[0].duration_ms, 10 * MIN);
  const { sessions: ss } = sessions(collapse(readRows(dir)).rows);
  assert.equal(ss.length, 1);
});

await test('the CLI reads a directory and prints JSON (and text)', () => {
  const dir = scratch('cli');
  writeRows(dir, [{ kind: 'logon', at: Date.now() - 5 * MIN, name: 'Morpheus', enemy: true, class: 'war_book', guild: 'Human Resistance' }],
            { heartbeat: Date.now() });
  const cli = join(HERE, 'm59-sightings.mjs');
  const j = spawnSync(process.execPath, [cli, '--dir', dir, '--online', '--json'], { encoding: 'utf8' });
  assert.equal(j.status, 0, j.stderr);
  const out = JSON.parse(j.stdout);
  assert.equal(out.online[0].name, 'Morpheus');
  const txt = spawnSync(process.execPath, [cli, '--dir', dir, '--player', 'Morpheus'], { encoding: 'utf8' });
  assert.equal(txt.status, 0, txt.stderr);
  assert.match(txt.stdout, /ENEMY Morpheus <Human Resistance> \[war_book\]/);
  assert.match(txt.stdout, /last seen/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
