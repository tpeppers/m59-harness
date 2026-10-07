#!/usr/bin/env node
// VIDEO OF A PVP FIGHT, FROM A CHARACTER'S OWN CLIENT, INCLUDING THE MINUTES BEFORE IT.
//
//   node tools/m59-pvp-capture.mjs --agent hk3 --rooms 38,39            # run until stopped
//   node tools/m59-pvp-capture.mjs --agent hk3 --rooms 38,39 --once     # stop after one clip
//   node tools/m59-pvp-capture.mjs --stop                               # stop a running one
//   node tools/m59-pvp-capture.mjs --status
//
// Operator, 2026-10-06: record the next PvP in Castle Victoria from Raphael's client. The NVIDIA
// app's recorder is hooked into Meridian (nvspcap64.dll loads into the client), but it ignores
// software key presses — Alt+F9 and Alt+F1, sent as virtual keys and as scan codes, saved nothing —
// and it has no command line. So this records with ffmpeg on the same NVENC encoder instead.
//
// HOW IT WORKS
//
// ffmpeg grabs the client's window by its handle (gdigrab hwnd=, which does not need the window in
// front) into a RING of short segments (-segment_wrap), so the disk used is bounded even if this
// process dies and leaves ffmpeg running. A watcher reads the fleet's PvP evidence:
//   * substrate/pvp/<fleet>/<day>.jsonl  — deaths and return-fire milestones (tools/m59-pvp.mjs)
//   * war-alarms-<fleet>.jsonl           — an engagement or an attack anywhere in the fleet
// When one lands in one of --rooms, a capture opens at (event - --pre) and stays open until
// --post seconds after the LAST event. Every finished segment in that span is copied aside as it
// completes, so the ring can wrap under a long fight, and the copies are joined into one mp4 under
// Videos\NVIDIA\Meridian 59\, beside a .json naming the events that opened and extended it.
// A 'sighted' alarm is not PvP and never opens a capture.
//
// THE CLIENT MUST BE OPEN AND NOT MINIMISED. A minimised window has nothing to grab. When the
// client is not running, the recorder waits for it and says so once.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync,
         rmSync, unlinkSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pvpDirFor } from './m59-pvp.mjs';
import { ALARM_FILE } from './m59-war.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..', '..');
const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const AGENT = arg('--agent', 'hk3');
const ROOMS = new Set(String(arg('--rooms', '38,39')).split(',').map(Number).filter(Number.isFinite));
const PRE_S = Number(arg('--pre', 120));
const POST_S = Number(arg('--post', 120));
const SEG_S = Number(arg('--segment', 10));
const FPS = Number(arg('--fps', 30));
const OUT = arg('--out', join(homedir(), 'Videos', 'NVIDIA', 'Meridian 59'));
const WORK = arg('--work', join(HERE, 'substrate', 'pvp-capture', AGENT));
const PVP_DIR = arg('--pvp-dir', pvpDirFor());
const ALARMS = arg('--alarms', ALARM_FILE());
const ONCE = argv.includes('--once');
const RING = join(WORK, 'ring');
const PIDFILE = join(WORK, 'capture.pid');
const LOG = join(WORK, 'capture.log');
// The ring holds pre + post + a margin, so a capture can always reach back to its start.
const WRAP = Math.ceil((PRE_S + POST_S) / SEG_S) + 12;

// THE REAL BINARY, NOT A SHIM. Chocolatey's `ffmpeg` on PATH is a launcher that starts the real
// ffmpeg.exe as a child, so killing the pid we spawned left the real one recording for ever — found
// on the first test run. Resolved once: --ffmpeg, M59_FFMPEG, or the shim's own target.
function resolveFfmpeg() {
  const given = arg('--ffmpeg', process.env.M59_FFMPEG);
  if (given) return given;
  const where = spawnSync('where', ['ffmpeg'], { encoding: 'utf8', windowsHide: true });
  const first = String(where.stdout ?? '').split(/\r?\n/).find(Boolean)?.trim();
  if (first && /chocolatey[\\/]bin/i.test(first)) {
    const lib = join(first, '..', '..', 'lib');
    try {
      for (const d of readdirSync(lib).filter(d => /^ffmpeg/i.test(d))) {
        const real = join(lib, d, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe');
        if (existsSync(real)) return real;
      }
    } catch {}
  }
  return first || 'ffmpeg';
}
const FFMPEG = resolveFfmpeg();
// Always the whole tree, and never conditional on the parent still being alive.
const killTree = pid => { if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); };

const log = (...a) => {
  const line = `${new Date().toISOString()} ${a.join(' ')}`;
  console.log(line);
  try { appendFileSync(LOG, line + '\n'); } catch {}
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ------------------------------------------------------------------ control commands
if (argv.includes('--stop') || argv.includes('--status')) {
  let st = null;
  try { st = JSON.parse(readFileSync(PIDFILE, 'utf8')); } catch {}
  if (!st) { console.log('no capture is running for ' + AGENT); process.exit(0); }
  const up = { node: alive(st.pid), ffmpeg: st.ffmpeg ? alive(st.ffmpeg) : false };
  if (argv.includes('--status')) { console.log(JSON.stringify({ ...st, alive: up }, null, 1)); process.exit(0); }
  // ffmpeg first: an orphaned ffmpeg is the one that keeps writing.
  for (const pid of [st.ffmpeg, st.pid].filter(Boolean)) if (alive(pid)) killTree(pid);
  try { unlinkSync(PIDFILE); } catch {}
  console.log(`stopped capture for ${AGENT} (node ${st.pid}, ffmpeg ${st.ffmpeg ?? '-'})`);
  process.exit(0);
}

// ------------------------------------------------------------------ the client window
//
// Found by the account on the client's command line — the same way the launcher finds the client
// it started (docs/m59-operations.md). The command line carries the password, so it is matched
// here and never printed.
function clientWindow(agent) {
  const ps = `$p = Get-CimInstance Win32_Process -Filter "Name='meridian.exe'" | Where-Object { $_.CommandLine -match '/U:${agent.replace(/[^A-Za-z0-9_-]/g, '')}(\\s|$)' } | Sort-Object CreationDate -Descending | Select-Object -First 1;` +
    ` if ($p) { $g = Get-Process -Id $p.ProcessId; "$($p.ProcessId) $($g.MainWindowHandle.ToInt64())" }`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  const [pid, hwnd] = String(r.stdout ?? '').trim().split(/\s+/).map(Number);
  return pid && hwnd ? { pid, hwnd } : null;
}

// ------------------------------------------------------------------ the ring
let ff = null, ffWindow = null, waitingSaid = false;
function startRing() {
  const w = clientWindow(AGENT);
  if (!w) {
    if (!waitingSaid) { log(`waiting: no Meridian client is logged in as ${AGENT}`); waitingSaid = true; }
    return;
  }
  waitingSaid = false;
  mkdirSync(RING, { recursive: true });
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'gdigrab', '-framerate', String(FPS),
    '-i', `hwnd=0x${w.hwnd.toString(16)}`,
    '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23', '-pix_fmt', 'yuv420p',
    '-g', String(FPS * 2), '-force_key_frames', `expr:gte(t,n_forced*${SEG_S})`,
    '-f', 'segment', '-segment_time', String(SEG_S), '-segment_wrap', String(WRAP),
    '-reset_timestamps', '1', join(RING, 'seg%03d.mp4')];
  ff = spawn(FFMPEG, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  ffWindow = w;
  ff.stderr.on('data', d => log('ffmpeg:', String(d).trim().slice(0, 300)));
  ff.on('exit', code => { log(`ffmpeg exited (${code}); restarting when the client is back`); ff = null; writePid(); });
  log(`recording ${AGENT}'s client (pid ${w.pid}) into a ${WRAP}-segment ring of ${SEG_S}s`);
  writePid();
}
function writePid() {
  mkdirSync(WORK, { recursive: true });
  writeFileSync(PIDFILE, JSON.stringify({ pid: process.pid, ffmpeg: ff?.pid ?? null, agent: AGENT,
    rooms: [...ROOMS], client_pid: ffWindow?.pid ?? null, started: new Date().toISOString(), out: OUT }));
}

/** Finished segments with their wall-clock span. The newest file is still being written. */
function segments() {
  let files = [];
  try { files = readdirSync(RING).filter(f => /^seg\d+\.mp4$/.test(f)).map(f => ({ f, m: statSync(join(RING, f)).mtimeMs })); } catch { return []; }
  files.sort((a, b) => a.m - b.m);
  return files.slice(0, -1).map(x => ({ file: x.f, start: x.m - SEG_S * 1000, end: x.m }));
}

// ------------------------------------------------------------------ the evidence
const offsets = new Map();
function newLines(file) {
  let size = 0;
  try { size = statSync(file).size; } catch { return []; }
  if (!offsets.has(file)) { offsets.set(file, size); return []; }  // start at the end: old fights are not news
  let off = offsets.get(file);
  if (size < off) off = 0;                                          // truncated (the alarm file rolls at 256KB)
  if (size === off) return [];
  const buf = readFileSync(file).subarray(off, size).toString('utf8');
  const cut = buf.lastIndexOf('\n');
  if (cut < 0) return [];
  offsets.set(file, off + Buffer.byteLength(buf.slice(0, cut + 1)));
  return buf.slice(0, cut).split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function pvpEvents() {
  const day = new Date().toISOString().slice(0, 10);
  const rows = newLines(join(PVP_DIR, `${day}.jsonl`))
    .filter(r => r.kind === 'death' || (r.kind === 'combat' && r.event !== 'finished'))
    .map(r => ({ at: r.at, room: r.room, what: r.kind === 'death' ? `${r.victim} killed by ${r.killer ?? '?'}` : `${r.observer}: ${r.event} ${r.target ?? ''}`.trim() }));
  const alarms = newLines(ALARMS).filter(a => a.basis !== 'sighted')
    .map(a => ({ at: a.at, room: a.room, what: `${a.reporter} alarm: ${a.enemy} (${a.basis})`, enemy: a.enemy }));
  return [...rows, ...alarms].filter(e => ROOMS.has(Number(e.room)));
}

// ------------------------------------------------------------------ a capture
let cap = null;   // { start, until, events, dir, copied:Set }
function openOrExtend(evs) {
  const last = Math.max(...evs.map(e => e.at));
  if (!cap) {
    const first = Math.min(...evs.map(e => e.at));
    const stamp = new Date(first).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    cap = { start: first - PRE_S * 1000, first, until: last + POST_S * 1000, events: [], copied: new Set(),
            dir: join(WORK, `cap-${stamp}`), stamp };
    mkdirSync(cap.dir, { recursive: true });
    log(`PvP in room ${evs[0].room}: ${evs[0].what} — capturing from ${PRE_S}s before`);
  } else cap.until = Math.max(cap.until, last + POST_S * 1000);
  cap.events.push(...evs);
}
function collect() {
  if (!cap) return;
  for (const s of segments()) {
    if (s.end < cap.start || s.start > cap.until) continue;
    const key = `${s.file}@${Math.round(s.end)}`;
    if ([...cap.copied].some(k => k.endsWith(`@${Math.round(s.end)}`))) continue;
    const dest = join(cap.dir, `${Math.round(s.end)}.mp4`);
    try { copyFileSync(join(RING, s.file), dest); cap.copied.add(key); } catch {}
  }
}
function finish() {
  collect();
  const parts = readdirSync(cap.dir).filter(f => /^\d+\.mp4$/.test(f)).sort((a, b) => Number(a.slice(0, -4)) - Number(b.slice(0, -4)));
  mkdirSync(OUT, { recursive: true });
  const enemy = cap.events.find(e => e.enemy)?.enemy ?? cap.events[0]?.what?.split(' ')[0] ?? 'pvp';
  const name = `pvp-${cap.stamp}Z-room${cap.events[0].room}-${String(enemy).replace(/[^A-Za-z0-9]+/g, '_')}`;
  const out = join(OUT, `${name}.mp4`);
  if (!parts.length) { log('capture closed with no video segments — was the client minimised or closed?'); }
  else {
    const list = join(cap.dir, 'list.txt');
    writeFileSync(list, parts.map(p => `file '${join(cap.dir, p).replace(/\\/g, '/')}'`).join('\n'));
    const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out], { windowsHide: true, encoding: 'utf8' });
    if (r.status === 0) {
      writeFileSync(join(OUT, `${name}.json`), JSON.stringify({ agent: AGENT, rooms: [...ROOMS],
        video_from: new Date(Number(parts[0].slice(0, -4)) - SEG_S * 1000).toISOString(),
        video_to: new Date(Number(parts.at(-1).slice(0, -4))).toISOString(),
        first_event: new Date(cap.first).toISOString(), events: cap.events.map(e => ({ ...e, iso: new Date(e.at).toISOString() })) }, null, 1));
      log(`saved ${out} (${parts.length} segments, ${cap.events.length} events)`);
      rmSync(cap.dir, { recursive: true, force: true });
    } else log(`concat failed: ${String(r.stderr).slice(0, 300)} — the parts are kept in ${cap.dir}`);
  }
  cap = null;
  if (ONCE) { shutdown(0); }
}

function shutdown(code) {
  killTree(ff?.pid);
  try { unlinkSync(PIDFILE); } catch {}
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// ------------------------------------------------------------------ main loop
mkdirSync(WORK, { recursive: true });
try {
  const prior = JSON.parse(readFileSync(PIDFILE, 'utf8'));
  if (prior.pid !== process.pid && alive(prior.pid)) { console.error(`a capture for ${AGENT} is already running (pid ${prior.pid}); --stop it first`); process.exit(2); }
  if (prior.ffmpeg && alive(prior.ffmpeg)) killTree(prior.ffmpeg);
} catch {}
log(`ffmpeg: ${FFMPEG}`);
log(`watching rooms ${[...ROOMS].join(',')} via ${PVP_DIR} and ${ALARMS}; pre ${PRE_S}s, post ${POST_S}s → ${OUT}`);
pvpEvents();             // prime the offsets at the files' current ends
startRing();
let tick = 0;
setInterval(() => {
  tick++;
  if (!ff && tick % 10 === 0) startRing();
  if (ff && tick % 15 === 0) {
    // The client was closed and reopened: its window handle changed, so the grab must move with it.
    const w = clientWindow(AGENT);
    if (!w || w.hwnd !== ffWindow?.hwnd) { log('client window changed; restarting the grab'); killTree(ff.pid); }
  }
  const evs = pvpEvents();
  if (evs.length) openOrExtend(evs);
  if (cap) {
    collect();
    // Close once the post-window has passed AND the segment covering it has finished.
    if (Date.now() > cap.until + (SEG_S + 3) * 1000) finish();
  }
}, 1000);
