#!/usr/bin/env node
// SHUT DOWN WITHOUT LOSING THE AFTERNOON. Zero dependencies.
//
//   node tools/m59-shutdown.mjs                 checkpoint, then stop broker and server
//   node tools/m59-shutdown.mjs --keep-server   checkpoint and stop the broker only
//   node tools/m59-shutdown.mjs --checkpoint    checkpoint only, stop nothing
//   node tools/m59-shutdown.mjs --label "before the raid"
//   node tools/m59-shutdown.mjs --broker 8905   a broker on a non-default port
//   node tools/m59-shutdown.mjs --list          what checkpoints exist
//   node tools/m59-shutdown.mjs --restore <id>  put one back
//
// WHY THIS EXISTS. blakserv installs no SIGTERM handler — the only signal it
// touches is SIGPIPE (blakserv/osd_epoll.c) — so `docker stop` terminates it
// outright, and [Auto] SavePeriod defaults to 180 minutes. A hard stop is a hard
// stop and that is fine; what is not fine is a *deliberate* shutdown throwing
// away three hours because nobody typed `save game` first.
//
// TWO THINGS ARE KEPT, NOT ONE.
//
//   standing/    the save that was already on disk when you asked to shut down,
//                copied aside untouched. This is the last known-good state of a
//                server nobody was in the middle of changing.
//   checkpoint/  a fresh `save game` taken now, so nothing since that standing
//                save is lost.
//
// Keeping both matters because the fresh save is the one that can be bad. If the
// fleet has just walked into something, or a re-roll went wrong, or the world is
// mid-errand, the checkpoint faithfully preserves that — and the standing save is
// then the thing you actually want. Saving over the only copy is how you find out
// which one you needed.
//
// A save set is four files sharing a timestamp suffix (gameuser, accounts,
// striings, dynarscs) plus lastsave.txt, whose `LASTSAVE <ts>` line is what
// blakserv reads to decide which set to load. Restoring is copying the four back
// and rewriting that line.

import net from 'node:net';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const ADMIN_HOST = process.env.M59_HOST || '127.0.0.1';
const ADMIN_PORT = Number(process.env.M59_ADMIN_PORT || 9998);
const SAVE_PARTS = ['gameuser', 'accounts', 'striings', 'dynarscs'];

const c = {
  ok: s => `\x1b[32m${s}\x1b[0m`, bad: s => `\x1b[31m${s}\x1b[0m`,
  warn: s => `\x1b[33m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`,
};

// ------------------------------------------------------------------ admin socket

function admin(cmds, settle = 1500, timeoutMs = 180000) {
  const list = Array.isArray(cmds) ? cmds : [cmds];
  return new Promise((resolve, reject) => {
    const s = net.connect(ADMIN_PORT, ADMIN_HOST);
    let buf = '';
    const bail = setTimeout(() => { s.destroy(); resolve(buf); }, timeoutMs);
    s.on('connect', () => {
      let i = 0;
      const t = setInterval(() => {
        if (i < list.length) s.write(list[i++] + '\r\n');
        else { clearInterval(t); setTimeout(() => s.end(), settle); }
      }, 400);
    });
    s.on('data', d => { buf += d; });
    s.on('close', () => { clearTimeout(bail); resolve(buf); });
    s.on('error', e => { clearTimeout(bail); reject(e); });
  });
}

// ------------------------------------------------------------------ locating things

// Ask the container where its savegame directory is bound, so this keeps working
// when someone changes the mount rather than silently checkpointing an empty
// directory that looks fine.
function savegameFromContainer() {
  try {
    const r = spawnSync('docker', ['inspect', 'm59', '--format',
      '{{range .Mounts}}{{.Destination}}={{.Source}}\n{{end}}'], { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) return null;
    for (const line of (r.stdout || '').split('\n')) {
      const [dest, src] = line.split('=');
      if (dest === '/m59/savegame' && src) {
        // Docker Desktop reports host paths in its own form; only take it if we
        // can actually see it from here.
        const win = src.replace(/^\/host_mnt\/([a-z])\//i, (_, d) => `${d.toUpperCase()}:/`)
                       .replace(/^\/run\/desktop\/mnt\/host\/([a-z])\//i, (_, d) => `${d.toUpperCase()}:/`);
        if (existsSync(win)) return win;
        if (existsSync(src)) return src;
      }
    }
  } catch { /* docker absent or not running */ }
  return null;
}

function findSavegame(explicit) {
  const guesses = [
    explicit,
    process.env.M59_SAVEGAME,
    savegameFromContainer(),
    join(REPO, 'docker', 'data', 'savegame'),
    process.env.M59_ROOT && join(process.env.M59_ROOT, 'run', 'server', 'savegame'),
    'C:/code/Meridian59/run/server/savegame',
  ].filter(Boolean);
  for (const g of guesses) if (existsSync(g)) return g;
  return null;
}

const checkpointRoot = savegame => join(dirname(savegame), 'checkpoints');

// ------------------------------------------------------------------ save sets

function lastSaveStamp(savegame) {
  const f = join(savegame, 'lastsave.txt');
  if (!existsSync(f)) return null;
  const m = readFileSync(f, 'utf8').match(/^LASTSAVE\s+(\d+)/m);
  return m ? m[1] : null;
}

function saveSetFiles(savegame, stamp) {
  const out = [];
  for (const p of SAVE_PARTS) {
    const f = join(savegame, `${p}.${stamp}`);
    if (existsSync(f)) out.push(f);
  }
  return out;
}

// Copy a save set into its own directory, with a manifest saying what it is.
// ABSENCE IS NOT SUCCESS: a set missing gameuser is not a save, and writing a
// directory that looks like a checkpoint but cannot be restored is worse than
// refusing, because it is only discovered when it is needed.
function archive(savegame, stamp, dest, kind, label) {
  const files = saveSetFiles(savegame, stamp);
  const missing = SAVE_PARTS.filter(p => !files.some(f => basename(f).startsWith(`${p}.`)));
  if (missing.length) {
    return { ok: false, why: `save set ${stamp} is missing ${missing.join(', ')}` };
  }
  mkdirSync(dest, { recursive: true });
  let bytes = 0;
  for (const f of files) {
    copyFileSync(f, join(dest, basename(f)));
    bytes += statSync(f).size;
  }
  const lastsave = join(savegame, 'lastsave.txt');
  if (existsSync(lastsave)) copyFileSync(lastsave, join(dest, 'lastsave.txt'));
  writeFileSync(join(dest, 'manifest.json'), JSON.stringify({
    kind, label: label || null, stamp,
    saved_at: new Date(Number(stamp) * 1000).toISOString(),
    archived_at: new Date().toISOString(),
    files: files.map(f => basename(f)),
    bytes,
    restore: `node tools/m59-shutdown.mjs --restore ${basename(dest)}`,
  }, null, 2));
  return { ok: true, files: files.length, bytes, stamp };
}

// ------------------------------------------------------------------ list / restore

function list(savegame) {
  const root = checkpointRoot(savegame);
  if (!existsSync(root)) { console.log('no checkpoints yet.'); return 0; }
  const dirs = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  if (!dirs.length) { console.log('no checkpoints yet.'); return 0; }
  console.log(`checkpoints in ${root}\n`);
  for (const d of dirs) {
    let m = {};
    try { m = JSON.parse(readFileSync(join(root, d, 'manifest.json'), 'utf8')); } catch { /* ignore */ }
    console.log(`  ${d.padEnd(34)} ${String(m.kind || '?').padEnd(11)} ` +
      `saved ${m.saved_at ? m.saved_at.replace('T', ' ').slice(0, 19) : '?'}` +
      (m.label ? `  ${c.dim(m.label)}` : ''));
  }
  console.log(`\nrestore with:  node tools/m59-shutdown.mjs --restore <name>`);
  return 0;
}

async function restore(savegame, id) {
  const src = join(checkpointRoot(savegame), id);
  if (!existsSync(src)) { console.error(c.bad(`no checkpoint called ${id}`)); return 1; }
  let m;
  try { m = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8')); }
  catch { console.error(c.bad(`${id} has no manifest.json; refusing to guess`)); return 1; }

  // Restoring into a live server does nothing useful: it holds the world in
  // memory and will write over these files at its next save.
  if (await reachable()) {
    console.error(c.bad('the server is still running.'));
    console.error('  stop it first, or it will overwrite the restore at its next save:');
    console.error('    docker stop m59');
    return 1;
  }

  for (const f of m.files) copyFileSync(join(src, f), join(savegame, f));
  writeFileSync(join(savegame, 'lastsave.txt'),
    `#\n# Restored from checkpoint ${id} at ${new Date().toISOString()}\n#\n\nLASTSAVE ${m.stamp}\n`);
  console.log(c.ok(`restored ${id} (${m.files.length} files, saved ${m.saved_at}).`));
  console.log('start the server and it will load this state.');
  return 0;
}

function reachable() {
  return new Promise(resolve => {
    const s = net.connect({ port: ADMIN_PORT, host: ADMIN_HOST });
    const done = v => { s.destroy(); resolve(v); };
    s.setTimeout(2500);
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false));
    s.on('error', () => done(false));
  });
}

// ------------------------------------------------------------------ stopping

function cmdlineOf(pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: 'utf8', timeout: 20000 });
    return (r.stdout || '').trim();
  }
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); }
  catch {
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 15000 });
    return (r.stdout || '').trim();
  }
}

const nap = ms => new Promise(r => setTimeout(r, ms));

const samePath = (a, b) => {
  const norm = p => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
};

// STOP THIS CHECKOUT'S BROKER, AND NOTHING ELSE.
//
// The obvious version — kill every node process with "m59-broker" in its command
// line — is wrong, and wrong in a way that does real damage. More than one
// checkout can be running at once, and a shutdown run here reached into another
// repository and logged out 36 characters that had nothing to do with this one.
//
// So the broker is asked who it is first. /health reports its pid and the
// checkout it was started from, and nothing is signalled unless that checkout is
// this one. An unidentified broker is left alone and said so, because the cost of
// killing the wrong one is much higher than the cost of leaving one running.
async function stopBroker(port) {
  let who = null;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) who = await r.json();
  } catch { /* nothing listening */ }

  if (!who) return `no broker answering on ${port}`;
  if (!who.pid || !who.root)
    return `the broker on ${port} does not report which checkout it is — left it alone`;
  if (!samePath(who.root, REPO))
    return `the broker on ${port} belongs to ${who.root} — left it alone`;

  const pid = who.pid;
  try { process.kill(pid, 'SIGTERM'); }
  catch (e) { return `could not stop broker ${pid}: ${e.message}`; }

  for (let i = 0; i < 40; i++) {
    try { process.kill(pid, 0); } catch { break; }
    await nap(250);
  }

  let gone = false;
  try { process.kill(pid, 0); } catch { gone = true; }
  // Never unlink the roster claim here. On Windows the broker can die while its keeper
  // children and account sockets survive; their PIDs are the guards that let an exact
  // successor adopt safely and make every alias fail closed. If every child is dead the
  // shared lock code will reclaim the claim after positive liveness checks. Deleting it
  // here would erase both the evidence and the safe restart lineage.
  return gone ? `stopped broker (pid ${pid})` : `broker ${pid} did not exit`;
}

function stopServer() {
  // The server is a plain `docker run` container named m59 (see setup.mjs), so
  // stopping it is `docker stop m59` — no compose binary in the picture. blakserv
  // has no SIGTERM handler, so the checkpoint above is what actually saved the
  // world; this just ends the process.
  const r = spawnSync('docker', ['stop', 'm59'], { encoding: 'utf8', timeout: 120000 });
  if (!r.error && r.status === 0) return 'stopped the server container';
  return 'no container to stop (a native server must be stopped by hand)';
}

// ------------------------------------------------------------------ main

function parseArgs(argv) {
  const a = { keepServer: false, checkpointOnly: false, label: null, savegame: null, broker: 8901 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--keep-server') a.keepServer = true;
    else if (v === '--checkpoint') a.checkpointOnly = true;
    else if (v === '--label') a.label = argv[++i];
    else if (v === '--savegame') a.savegame = argv[++i];
    else if (v === '--broker') a.broker = Number(argv[++i]);
    else if (v === '--list') a.list = true;
    else if (v === '--restore') a.restore = argv[++i];
    else if (v === '--help' || v === '-h') a.help = true;
    else { console.error(`unknown argument: ${v}`); process.exit(2); }
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n').filter(l => l.startsWith('//')).slice(0, 9).join('\n'));
    return 0;
  }

  const savegame = findSavegame(a.savegame);
  if (!savegame) {
    console.error(c.bad('cannot find a savegame directory.'));
    console.error('  pass --savegame <dir>, or set M59_SAVEGAME.');
    return 1;
  }

  if (a.list) return list(savegame);
  if (a.restore) return restore(savegame, a.restore);

  console.log(`savegame:    ${savegame}`);
  const root = checkpointRoot(savegame);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // 1. SET THE STANDING SAVE ASIDE FIRST, before anything can overwrite it.
  const standing = lastSaveStamp(savegame);
  if (standing) {
    const dest = join(root, `${stamp}-standing`);
    const r = archive(savegame, standing, dest, 'standing', a.label);
    if (r.ok) console.log(c.ok(`standing:    kept save from ${new Date(Number(standing) * 1000).toISOString()} → ${basename(dest)}`));
    else console.log(c.warn(`standing:    not kept — ${r.why}`));
  } else {
    console.log(c.warn('standing:    no previous save on disk to keep'));
  }

  // 2. Fresh checkpoint, but only if the server is actually up to make one.
  const up = await reachable();
  if (!up) {
    console.log(c.warn(`checkpoint:  server is not answering on ${ADMIN_HOST}:${ADMIN_PORT} — nothing new to save`));
  } else {
    process.stdout.write('checkpoint:  saving... ');
    let out = '';
    try { out = await admin('save game', 2000); }
    catch (e) { console.log(c.bad(`failed: ${e.message}`)); return 1; }

    // The server says "Save time is (<stamp>)" when it has finished. Anything
    // else means the save did not complete, and treating that as success would
    // archive whatever stale set happened to be on disk.
    const m = out.match(/Save time is \((\d+)\)/);
    if (!m) {
      console.log(c.bad('the server did not confirm the save'));
      console.log(c.dim(`  reply: ${out.trim().slice(-200) || '(silence)'}`));
      console.log(c.warn('  the standing save above is intact; not stopping anything.'));
      return 1;
    }
    const dest = join(root, `${stamp}-checkpoint`);
    const r = archive(savegame, m[1], dest, 'checkpoint', a.label);
    if (!r.ok) { console.log(c.bad(`saved, but could not archive: ${r.why}`)); return 1; }
    console.log(c.ok(`done → ${basename(dest)} (${r.files} files, ${(r.bytes / 1024).toFixed(0)} KB)`));
  }

  if (a.checkpointOnly) {
    console.log('\n--checkpoint: nothing was stopped.');
    return 0;
  }

  console.log('');
  console.log(`broker:      ${await stopBroker(a.broker)}`);
  if (!a.keepServer) console.log(`server:      ${stopServer()}`);
  else console.log('server:      left running (--keep-server)');

  console.log(`\ncheckpoints: ${root}`);
  console.log('  node tools/m59-shutdown.mjs --list');
  return 0;
}

main().then(c2 => process.exit(c2)).catch(e => { console.error(e); process.exit(1); });
