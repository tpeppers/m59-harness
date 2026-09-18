#!/usr/bin/env node
// BRING UP EVERYTHING, FROM A BARE CLONE. Zero dependencies, Windows and Linux.
//
//   node tools/setup.mjs doctor        what is present, what is missing, what to do
//   node tools/setup.mjs server        clone + build + run the server
//   node tools/setup.mjs client        find (or install) the Steam client
//   node tools/setup.mjs broker        start the MCP broker
//   node tools/setup.mjs fleet 10      create ten characters
//   node tools/setup.mjs rsc           copy the resource table out of the container
//   node tools/setup.mjs shortcuts     one click-to-play shortcut per character
//   node tools/setup.mjs routes        bake the routing table the mover agrees with (~13 min)
//   node tools/setup.mjs webui         install the browser command surface (its own repo)
//   node tools/setup.mjs all 10        all of the above, in order
//   node tools/setup.mjs shutdown      checkpoint the world, then stop everything
//
// Every step is idempotent: running it twice finds what the first run made and
// says so rather than making a second one.
//
// WHAT NEEDS A HUMAN, AND WHY. Two things here cannot be automated honestly:
//
//   * Steam will not install a game you do not own, and it will not log in for
//     you. `client` finds an existing install, and otherwise hands you the URL.
//   * Building the server natively on Windows needs Visual Studio and a
//     developer shell. The container path avoids that entirely, which is why it
//     is the default on both platforms.
//
// THE CLIENT IS OPTIONAL FOR A FLEET. Agents log in over the wire with
// tools/m59-client.mjs; no Meridian.exe is involved. You need the Steam client
// to *watch* the fleet with your own eyes, and for the compendium's sprites.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
// Client discovery lives with the thing that writes shortcuts to it, so that
// `doctor` and the shortcut writer can never disagree about where the client is.
import { findClient, findClientExe, roster, writeShortcuts, report, SHORTCUT_DIR }
  from './m59-shortcuts.mjs';
import * as webui from './m59-webui.mjs';
import { loadResources } from './m59-rsc.mjs';
import { loadMap, movementMapReadiness } from './m59-map.mjs';
import { LOCAL_MAP_FILE, movementMapFile } from './m59-map-path.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const WIN = process.platform === 'win32';
const LOCAL_MAP = LOCAL_MAP_FILE;

// Upstream is the default because it is the plainest thing that works. The Deck
// fork (github.com/tpeppers/Meridian59-deck) builds and runs here too and adds
// gamepad and Steam Deck support to the client; point M59_ROOT at it to use it.
// Both are tested end to end by the container path.
const SERVER_REPOS = [
  { url: 'https://github.com/Meridian59/Meridian59', name: 'Meridian59' },
];

const STEAM_APPID = '893390';

// ------------------------------------------------------------------ helpers

const c = {
  ok: s => `\x1b[32m${s}\x1b[0m`, bad: s => `\x1b[31m${s}\x1b[0m`,
  warn: s => `\x1b[33m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`,
};

// No `shell: true`. Everything spawned here is a real executable (git.exe,
// docker.exe, node.exe), so the shell buys nothing and would make every argument
// — including paths with spaces, which "C:/Program Files (x86)/..." always has —
// a quoting problem.
function have(cmd, args = ['--version']) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000 });
    if (r.error) return null;
    if (r.status !== 0 && !r.stdout) return null;
    return (r.stdout || r.stderr || '').split('\n')[0].trim();
  } catch { return null; }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) { console.error(`  cannot run ${cmd}: ${r.error.message}`); return false; }
  return r.status === 0;
}

function ensureLocalGeometry(src, { force = false } = {}) {
  if (!src) return false;
  if (!force && movementMapStatus(LOCAL_MAP)?.ok) return true;
  console.log('\nbaking collision geometry from the exact server room resources...');
  const roomDir = join(src, 'resource', 'rooms');
  const ok = run(process.execPath, [join(HERE, 'm59-map.mjs'), 'refresh-geometry'], {
    cwd: REPO,
    // An explicit room directory is exclusive during refresh. Never fill a missing
    // server room from an unrelated Steam/client install and mislabel the result.
    env: { ...process.env, M59_ROOT: src, M59_ROO_DIR: roomDir, M59_MAP: LOCAL_MAP },
  });
  if (!ok) console.error(c.bad('could not build a server-matched collision map; broker movement will not start'));
  if (!ok) return false;
  const ready = movementMapStatus(LOCAL_MAP);
  if (!ready?.ok) {
    console.error(c.bad(`the generated collision map validated only ${ready?.ready ?? 0}/` +
      `${ready?.total ?? 0} rooms; broker movement will not start`));
    return false;
  }
  return true;
}

function movementMapStatus(file = movementMapFile()) {
  try { return movementMapReadiness(loadMap(file)); }
  catch { return null; }
}

// Is the daemon actually up? `docker info` talks to it; `docker --version` does not.
function dockerReady() {
  try {
    const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'],
                        { windowsHide: true, encoding: 'utf8', timeout: 25000 });
    return !r.error && r.status === 0 && !!(r.stdout || '').trim();
  } catch { return false; }
}

// The server runs in a plain `docker run` container — NO compose binary needed.
// A stock Docker install ships the CLI and daemon but not `docker compose` (the
// v2 plugin) or `docker-compose` (the v1 standalone), and requiring one turns a
// working build into a dead end at the last step. These args are the whole of
// docker/docker-compose.yml, spelled out: same container name, ports, mounts and
// restart policy. The compose file stays valid for anyone who prefers it, but
// nothing here depends on it — keep the two in sync if you change either.
//
//   * name m59, so shutdown and restart can find the container by name.
//   * 5959 open, so a client on the host or the LAN can reach the game; 9998 on
//     loopback only, because the admin socket is gated by IP mask with no
//     password and must never be reachable off-box.
//   * channel/ is where player chat lands once tracing is on; savegame/ is the
//     world. Absolute host paths, because `docker run` has no compose-style
//     working directory to resolve "./data" against.
//   * -it because blakserv writes to a tty; --restart so it survives a reboot.
const M59_CONTAINER = 'm59';
function serverRunArgs() {
  const data = join(REPO, 'docker', 'data');
  return [
    'run', '-d',
    '--name', M59_CONTAINER,
    '--restart', 'unless-stopped',
    '-p', '5959:5959',
    '-p', '127.0.0.1:9998:9998',
    '-v', `${join(data, 'channel')}:/m59/channel`,
    '-v', `${join(data, 'savegame')}:/m59/savegame`,
    '-i', '-t',
    'm59-blakserv:local',
  ];
}

// Idempotent start. `docker run --name m59` refuses if a container of that name
// already exists at all — even stopped — so reuse a stopped one with `docker
// start` rather than erroring out or, worse, orphaning its savegame in a second
// container. (This path is only reached when 5959 is closed, so a *running* m59
// has already short-circuited server() above; a container found here is stopped.)
function startServer() {
  const found = spawnSync('docker', ['ps', '-aq', '--filter', `name=^${M59_CONTAINER}$`],
                          { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  if (!found.error && (found.stdout || '').trim()) {
    return run('docker', ['start', M59_CONTAINER]);
  }
  return run('docker', serverRunArgs());
}

function portOpen(port, host = '127.0.0.1', ms = 2000) {
  return new Promise(resolve => {
    const s = net.connect({ port, host });
    const done = v => { s.destroy(); resolve(v); };
    s.setTimeout(ms);
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false));
    s.on('error', () => done(false));
  });
}

function findServerSrc() {
  const guesses = [
    process.env.M59_ROOT,
    join(REPO, '..', 'Meridian59-deck'),
    join(REPO, '..', 'Meridian59'),
    'C:/code/Meridian59',
    join(process.env.HOME || '', 'Meridian59'),
  ].filter(Boolean);
  for (const g of guesses) {
    // A source tree, not just any directory: these four are what the container build needs.
    if (existsSync(join(g, 'blakserv')) && existsSync(join(g, 'kod')) &&
        existsSync(join(g, 'common.mak.linux')) && existsSync(join(g, 'resource', 'rooms'))) {
      return g;
    }
  }
  return null;
}

// ------------------------------------------------------------------ doctor

async function doctor() {
  const rows = [];
  const add = (name, val, hint) => rows.push({ name, val, hint });

  add('node', have('node'), 'https://nodejs.org — 22 or newer; 24 LTS recommended');
  add('git', have('git'), 'https://git-scm.com');
  add('python', have('python3') || have('python'), 'only for the sprite puller and source analysis');
  // `docker --version` only proves the CLI is on the path. The daemon is a
  // separate thing that is very often not running, and reporting "ok" for a
  // stopped Docker Desktop sends you off to debug the wrong layer entirely.
  add('docker', dockerReady() ? have('docker') : null,
      have('docker') ? 'the CLI is installed but the daemon is not responding — start Docker Desktop'
                     : 'https://docs.docker.com/get-docker/ — the portable server path');

  const src = findServerSrc();
  add('server source', src, `node tools/setup.mjs server  (clones one)`);

  const mapFile = movementMapFile();
  const mapStatus = movementMapStatus(mapFile);
  add('collision map', mapStatus?.ok
    ? `${mapStatus.ready}/${mapStatus.total} rooms (${mapFile === LOCAL_MAP ? 'server-local' : 'reference'})`
    : null,
  'node tools/setup.mjs server  (or set M59_MAP to an exact, validated map)');

  const client = findClient();
  add('steam client', client, `node tools/setup.mjs client  (finds or explains)`);

  const sprites = existsSync(join(REPO, 'compendium', 'assets', 'img'));
  add('compendium sprites', sprites ? 'present' : null, 'python tools/pull-client-assets.py');

  // Reported because an empty table is invisible from the game side: names come
  // back as "<rsc 29949>" and every name-matched thing — weapons, food — reads
  // absent rather than erroring. See the note above setup.mjs's rsc step.
  let rscFiles = 0;
  try { rscFiles = loadResources().size; } catch { /* no table anywhere */ }
  add('resource table', rscFiles ? `${rscFiles} strings` : null, 'node tools/setup.mjs rsc');

  // Only worth reporting once there is both a client to launch and someone to log
  // in as; before that "MISS" would be telling you off for a step you cannot take.
  const chars = roster().length;
  if (client && chars) {
    let made = 0;
    try { made = readdirSync(SHORTCUT_DIR).filter(f => /^m59-.*\.(desktop|lnk|cmd)$/.test(f)).length; }
    catch { /* never written */ }
    add('client shortcuts', made ? `${made} of ${chars}` : null, 'node tools/setup.mjs shortcuts');
  }

  // REPORTED BECAUSE ITS ABSENCE IS SILENT AND EXPENSIVE. Without a routing table the
  // broker plans on the server's coarse grid while the mover enforces the client's BSP,
  // and the fleet walks into walls — not with an error, but by sliding along one,
  // replanning into it, and giving up. `attachStepMasks` says the same thing at broker
  // start; this says it before anybody has started one.
  let routes = null;
  try {
    const { readFileSync } = await import('node:fs');
    const { movementMapFile } = await import('./m59-map-path.mjs');
    const { loadMap } = await import('./m59-map.mjs');
    const { ROUTES_FILE } = await import('./m59-routebake.mjs');
    const table = JSON.parse(readFileSync(ROUTES_FILE(), 'utf8'));
    const rooms = Object.values(table.rooms ?? {});
    // COUNT THE MASKS, NOT THE ROOMS. The payload is the step mask; the routes and region
    // labels beside it are useful and change nothing. A table baked before masks existed
    // has all 264 rooms in it, matches the manifest, and leaves the broker planning on the
    // coarse grid — so counting rooms reported a green tick over exactly the failure this
    // line exists to catch.
    const masked = rooms.filter(r => typeof r?.stepMask === 'string').length;
    const manifest = loadMap(movementMapFile()).geometryManifestSha256 ?? null;
    const current = table.geometryManifestSha256 && manifest
      && table.geometryManifestSha256 === manifest;
    routes = current && masked
      ? `${masked} rooms` + (table.complete === false ? ', INCOMPLETE' : '')
      : null;
  } catch { routes = null; }
  add('routing table', routes, 'node tools/setup.mjs routes');

  const game = await portOpen(5959);
  add('server :5959', game ? 'listening' : null, 'node tools/setup.mjs server');
  const adminSock = await portOpen(9998);
  add('admin :9998', adminSock ? 'listening' : null, 'published by node tools/setup.mjs server');
  const broker = await portOpen(8901);
  add('broker :8901', broker ? 'listening' : null, 'node tools/setup.mjs broker');

  const w = Math.max(...rows.map(r => r.name.length));
  console.log('');
  for (const r of rows) {
    const mark = r.val ? c.ok('  ok  ') : c.bad(' MISS ');
    console.log(`${mark} ${r.name.padEnd(w)}  ${r.val ? c.dim(String(r.val).slice(0, 60)) : c.warn(r.hint)}`);
  }
  const missing = rows.filter(r => !r.val);
  console.log('');
  if (!missing.length) {
    console.log(c.ok('everything is up. `node tools/setup.mjs fleet 10` makes characters.'));
    return 0;
  }
  console.log(`${missing.length} thing(s) not ready. \`node tools/setup.mjs all 10\` does the rest.`);
  return 0;
}

// ------------------------------------------------------------------ server

async function server() {
  if (await portOpen(5959)) {
    console.log(c.ok('a server is already listening on 5959; leaving it alone.'));
    return 0;
  }

  let src = findServerSrc();
  if (!src) {
    if (!have('git')) { console.error(c.bad('git is required to fetch the server source.')); return 1; }
    const parent = join(REPO, '..');
    for (const r of SERVER_REPOS) {
      const dest = join(parent, r.name);
      if (existsSync(dest)) continue;
      console.log(`\ncloning ${r.url} ...`);
      if (run('git', ['clone', '--depth', '1', r.url, dest])) { src = dest; break; }
      console.log(c.warn(`  could not clone ${r.name} — trying the next one`));
    }
    if (!src) src = findServerSrc();
  }
  if (!src) {
    console.error(c.bad('\nno server source, and none could be cloned.'));
    console.error('  clone it yourself and set M59_ROOT:');
    console.error('    git clone https://github.com/Meridian59/Meridian59');
    return 1;
  }
  console.log(`server source: ${src}`);

  // The broker must collide against the same .roo revisions the server announces.
  // A checked snapshot inevitably drifts as upstream source changes, so generate a
  // local, gitignored artifact before building this source tree.
  if (!ensureLocalGeometry(src, { force: true })) return 1;

  if (!dockerReady()) {
    if (have('docker')) {
      console.error(c.bad('\ndocker is installed but its daemon is not responding.'));
      console.error('  start Docker Desktop (Windows/Mac) or `sudo systemctl start docker` (Linux),');
      console.error('  wait for it to finish starting, and run this again.');
    } else {
      console.error(c.bad('\ndocker is not installed.'));
      console.error('  it is the only server path that is the same on Windows and Linux.');
      console.error('  https://docs.docker.com/get-docker/');
    }
    console.error('\n  to build natively instead, see docs/INSTALL.md — Windows needs');
    console.error('  Visual Studio and `nmake`; Linux needs `make -C blakserv -f makefile.linux`.');
    return 1;
  }

  console.log('\nbuilding the server image (first run takes a few minutes)...');
  if (!run('docker', ['build', '-f', join(REPO, 'docker', 'Dockerfile'),
                      '-t', 'm59-blakserv:local', src])) {
    console.error(c.bad('the image build failed. The output above is the reason.'));
    return 1;
  }

  mkdirSync(join(REPO, 'docker', 'data', 'channel'), { recursive: true });
  mkdirSync(join(REPO, 'docker', 'data', 'savegame'), { recursive: true });

  console.log('\nstarting it...');
  if (!startServer()) {
    console.error(c.bad('could not start the server container. The output above is the reason.'));
    return 1;
  }

  // The server takes a moment to load the kod and open its ports; reporting
  // success before it listens would be a lie the next step trips over.
  process.stdout.write('waiting for :5959 ');
  for (let i = 0; i < 60; i++) {
    if (await portOpen(5959)) {
      console.log(c.ok('\nserver is up: game 5959, admin 9998 (loopback only).'));
      return 0;
    }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 2000));
  }
  console.error(c.bad('\nthe container started but nothing is listening on 5959.'));
  console.error(`  docker logs ${M59_CONTAINER}`);
  return 1;
}

// ------------------------------------------------------------------ client

function client() {
  const found = findClient();
  if (found) {
    console.log(c.ok(`steam client: ${found}`));
    console.log(c.dim(`  ${findClientExe(found) || 'no Meridian.exe in it — is the install complete?'}`));
    console.log(`\n  watch a character:  node tools/m59-fleet.mjs spec <name>`);
    console.log(`  click-to-play:      node tools/setup.mjs shortcuts`);
    if (!existsSync(join(REPO, 'compendium', 'assets', 'img')))
      console.log(`  decode its sprites: python tools/pull-client-assets.py`);
    return 0;
  }
  console.log(c.warn('no Meridian 59 client install found.'));
  console.log('\nThe client is on Steam, and Steam will not install a game you do not');
  console.log('own or log in on your behalf, so this part is yours:');
  console.log(`\n  https://store.steampowered.com/app/${STEAM_APPID}/Meridian_59/`);
  console.log(`\n  already own it?   steam://install/${STEAM_APPID}`);
  console.log('  on Linux, it runs under Proton — enable it for the title in Steam.');
  console.log('\nThen re-run this. Or point at an install directly:');
  console.log('  M59_CLIENT="/path/to/Meridian 59" node tools/setup.mjs client');
  console.log(c.dim('\nA fleet does not need this. Agents speak the protocol directly;'));
  console.log(c.dim('the client is for watching them, and for the compendium art.'));
  return 0;
}

// ------------------------------------------------------------------ broker

async function broker() {
  if (await portOpen(8901)) {
    console.log(c.ok('a broker is already listening on 8901; leaving it alone.'));
    return 0;
  }
  if (!await portOpen(5959)) {
    console.error(c.bad('no server on 5959 — start it first: node tools/setup.mjs server'));
    return 1;
  }
  let movementMap = process.env.M59_MAP ? movementMapFile() : null;
  if (!movementMap) {
    const src = findServerSrc();
    if (src) {
      if (!ensureLocalGeometry(src)) return 1;
      movementMap = LOCAL_MAP;
    } else movementMap = movementMapFile();
  }
  const mapStatus = existsSync(movementMap) ? movementMapStatus(movementMap) : null;
  if (!mapStatus?.ok) {
    console.error(c.bad('no server-matched collision map is available.'));
    console.error('  set M59_ROOT to the source tree used by this server, or M59_MAP to a map');
    console.error('  baked from its exact room resources; unchecked movement is intentionally disabled.');
    if (mapStatus) console.error(`  validation: ${mapStatus.ready}/${mapStatus.total} rooms; ` +
      `manifest ${mapStatus.manifest_matches ? 'matches' : 'does not match'}`);
    return 1;
  }
  console.log('starting the supervised broker...');
  return run(process.execPath, [join(HERE, 'm59-service.mjs'), 'start'], {
    cwd: REPO, env: { ...process.env, M59_MAP: movementMap },
  }) ? 0 : 1;
}

// ------------------------------------------------------------------ fleet

async function fleet(n) {
  if (!await portOpen(8901)) {
    const rc = await broker();
    if (rc) return rc;
  }
  return run(process.execPath, [join(HERE, 'm59-makefleet.mjs'), '--count', String(n)],
             { cwd: REPO }) ? 0 : 1;
}

// ------------------------------------------------------------------ rsc
//
// COPY THE RESOURCE TABLE OUT OF THE CONTAINER. Nothing in the protocol carries
// an object name as text — `name_res` is an integer into this table — so without
// it an agent perceives its own pack as a list of numbers.
//
// This is a step rather than a mount because the table is built into the image
// by blakcomp and never written at runtime: only channel/ and savegame/ are bind
// mounted, and a native build has run/server/rsc on disk already (m59-rsc.mjs
// looks there under M59_ROOT, and stops if it finds it).
//
// The failure it prevents is silent and expensive. `weaponsOf` and `larderOf`
// match on names, so an empty table makes every weapon and every loaf invisible:
// `has_weapon` and `has_food` read false for a character holding both, autopilot
// farms bare-fisted, and vigor never leaves the resting cap.
function rsc() {
  const dest = join(REPO, 'docker/data/rsc');
  if (existsSync(dest) && readdirSync(dest).some(f => f.endsWith('.rsc'))) {
    console.log(`  ok    resource table    ${readdirSync(dest).length} files in docker/data/rsc`);
    return 0;
  }
  const found = spawnSync('docker', ['ps', '-aq', '--filter', `name=^${M59_CONTAINER}$`],
                          { windowsHide: true, encoding: 'utf8' }).stdout.trim();
  if (!found) {
    console.log('  --    resource table    no container yet; run `setup.mjs server` first');
    return 0;
  }
  mkdirSync(dirname(dest), { recursive: true });
  if (!run('docker', ['cp', `${M59_CONTAINER}:/m59/rsc`, dest])) {
    console.error('  MISS  resource table    docker cp failed');
    return 0;               // never fail the install over it
  }
  console.log(`  ok    resource table    ${readdirSync(dest).length} files -> docker/data/rsc`);
  return 0;
}

// ------------------------------------------------------------------ shortcuts
//
// One desktop shortcut per character, each carrying that character's host, port,
// account and password on the client's command line. Written last because it
// needs both halves — a client to launch and a roster to read.
//
// It never fails the install. No client, or no fleet yet, means there is nothing
// to make a shortcut out of, and neither is a reason to stop: see the note in the
// header about the client being optional.
function shortcuts(opts = {}) {
  const res = writeShortcuts(opts);
  report(res, opts);
  return 0;
}

// ------------------------------------------------------------------ main

const [cmd = 'doctor', arg] = process.argv.slice(2);
const n = Number(arg) || 10;

const commands = {
  doctor,
  server,
  client: async () => client(),
  broker,
  fleet: () => fleet(n),
  rsc: async () => rsc(),
  // THE ROUTER'S HALF OF THE COLLISION CONTRACT. About thirteen minutes, all CPU, no
  // network and no server — it reads the baked map and writes a table of the steps the
  // MOVER will actually make, so the router stops planning routes that end with a
  // character sliding along a wall. `--resume` because a killed bake should cost a minute
  // rather than the lot, and because rerunning it after `server` refreshes the map is then
  // nearly free for the rooms that did not change.
  //
  // NEVER FATAL. Without the table the broker plans on the coarse grid exactly as it did
  // before any of this existed, which is worse and is not a reason to fail a setup that
  // has otherwise produced a working fleet.
  routes: async () => {
    const ok = run(process.execPath, [join(HERE, 'm59-routebake.mjs'), '--resume'], { cwd: REPO });
    if (!ok) console.error(c.warn('the routing table did not bake; the broker will plan on ' +
      'the coarse grid. Rerun with node tools/setup.mjs routes when you can.'));
    return 0;
  },
  shortcuts: async () => shortcuts({ desktop: process.argv.includes('--desktop') }),
  // THE BROWSER COMMAND SURFACE, WHICH IS ITS OWN REPOSITORY AND MAY NOT BE HERE.
  // `npm install` in maps/m59-strategy-game, once, so that m59-service.mjs can start it
  // with the broker from then on. Absent is reported and is NOT a failure — the harness
  // has to keep working for somebody who cloned it on its own.
  webui: async () => {
    const s = webui.state();
    if (s.absent) { console.log(s.why); return 0; }
    if (s.installed) { console.log(`field command already installed at ${s.dir}`); return 0; }
    return webui.install().ok ? 0 : 1;
  },
  all: async () => {
    let rc = await server(); if (rc) return rc;
    client();
    // Before the broker, so the first session it opens can already read names.
    rsc();
    // Also before the broker, because the table is read once at startup: bake it after and
    // the fleet spends its first session planning on the wrong map.
    await commands.routes();
    rc = await broker(); if (rc) return rc;
    rc = await fleet(n); if (rc) return rc;
    // After the fleet exists, so the first page it serves has characters on it. Never
    // fatal: `all` has produced a working fleet by this point and a web page failing to
    // install is not a reason to report that it did not.
    await commands.webui();
    console.log('');
    return shortcuts();
  },
  // Deliberate shutdown keeps two snapshots and then stops. A `docker stop` is a
  // hard stop with no save at all — see tools/m59-shutdown.mjs.
  shutdown: async () =>
    run(process.execPath, [join(HERE, 'm59-shutdown.mjs')], { cwd: REPO }) ? 0 : 1,
};

if (!commands[cmd]) {
  console.error(`unknown command: ${cmd}`);
  console.error('usage: node tools/setup.mjs ' +
                '[doctor|server|client|broker|fleet N|rsc|routes|shortcuts|webui|all N|shutdown]');
  process.exit(2);
}
process.exit(await commands[cmd]());
