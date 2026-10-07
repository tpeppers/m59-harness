#!/usr/bin/env node
// A CAMERAMAN: ONE CHARACTER STANDS STILL AND KEEPS ITS VIEW ON THE ENEMY.
//
//   node tools/m59-cameraman.mjs --agent hk3 --rooms 38,39                # client on M59_ANNOTATE_PORT 8919
//   node tools/m59-cameraman.mjs --agent hk3 --rooms 38,39 --dry-run     # print, turn nothing
//   node tools/m59-cameraman.mjs --agent hk3 --follow Statler             # a live test with no war on
//   node tools/m59-cameraman.mjs --agent hk3 --stop                       # stop a running one
//
// The fleet terminal's V key starts this, the patched client and m59-pvp-capture.mjs together.
//
// Operator, 2026-10-06: Raphael is the camera for the PvP recordings (tools/m59-pvp-capture.mjs)
// — "just sit still and function as camera man from a safe spot", rotating to follow the combat
// target while it is in Castle Victoria.
//
// IT ONLY EVER TURNS. No move, no attack, no cast: the one thing it sends is a loopback UDP
// datagram, `turn=<0..4095>`, to the PATCHED client's annotation socket (M59_ANNOTATE_PORT,
// clientd3d/m59dbg.c). The client sets its own angle and sends its own BP_REQ_TURN, exactly as if
// the player had turned, so the picture and the server agree and nothing is forged.
//
// FORGING IT KILLED THE CLIENT. The first version drove the turn through m59-proxy.mjs's /turn,
// which injects BP_REQ_TURN upstream and forges BP_TURN towards the client. On prod, 2026-10-06,
// the client died on the first forged packet, twice — the second time with the pilot claimed,
// so it was not the keeper bumping it. The client-side command replaced it the same evening.
//
// WHERE THE POSITIONS COME FROM. The client knows where everybody is but has no way to say so,
// and a proxy keeps no table of who stands where. A fleet keeper standing
// in the SAME room does keep one — `/state` lists every object with x/y in kod fine units — so
// that keeper is the eye, and both the camera and the target are read from one snapshot, in one
// coordinate space, which is the only way the angle between them means anything.
//
// WHO IS THE TARGET. A player the server marks OF.ENEMY (a mutual guild war, user.kod:2418), or a
// remembered member of a guild in the war book. The current target is kept while it stays in the
// room — a camera that jumps between two enemies every frame is unwatchable — and otherwise the
// nearest one is taken. No enemy in the room: the camera holds its last angle.
//
// ANGLES. kod: 0 is east and they increase CLOCKWISE as rows grow downward, which is
// atan2(dy, dx) in screen coordinates (m59-game.mjs faceToward); the wire wants 0..4095
// (MAX_ANGLE, m59-parse.mjs).

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanKeepers } from './m59-keeper.mjs';
import { MAX_ANGLE } from './m59-parse.mjs';
import { WAR_FILE, normName, normGuild } from './m59-war.mjs';
import { fleetName } from './m59-fleetpath.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..', '..');
/** Where a camera for `agent` keeps its pid — beside m59-pvp-capture.mjs's, so one key can stop both. */
export const cameraPidFile = agent => join(HERE, 'substrate', 'pvp-capture', String(agent).replace(/[^A-Za-z0-9_-]/g, '_'), 'cameraman.pid');

export const ENEMY_FLAG = 0x02000000;

/** kod angle (0..4095) from `me` to `them`, both in one fine-unit space. */
export function angleTo(me, them) {
  const deg = (Math.atan2(them.y - me.y, them.x - me.x) * 180 / Math.PI + 360) % 360;
  return Math.round(deg * MAX_ANGLE / 360) & (MAX_ANGLE - 1);
}
/** Smallest difference between two wire angles, in wire units. */
export const angleDelta = (a, b) => { const d = Math.abs(a - b) % MAX_ANGLE; return Math.min(d, MAX_ANGLE - d); };

/** Pick the target from one room snapshot. Pure, for the test. */
export function chooseTarget(objects, { me, current = null, isEnemyName = () => false } = {}) {
  const enemies = objects.filter(o => o.is_player && o.id !== me.id &&
    (((o.flags >>> 0) & ENEMY_FLAG) !== 0 || isEnemyName(o.name)));
  if (!enemies.length) return null;
  const kept = current != null ? enemies.find(o => o.id === current || normName(o.name) === normName(current)) : null;
  if (kept) return kept;
  const d = o => Math.hypot(o.x - me.x, o.y - me.y);
  return enemies.sort((a, b) => d(a) - d(b))[0];
}

function warEnemyNames(file = WAR_FILE()) {
  try {
    const book = JSON.parse(readFileSync(file, 'utf8'));
    const guilds = new Set(Object.keys(book.enemy_guilds ?? {}).map(normGuild));
    return new Set(Object.values(book.members ?? {}).filter(m => m.guild && guilds.has(normGuild(m.guild))).map(m => normName(m.name)));
  } catch { return new Set(); }
}

// ---------------------------------------------------------------------------- CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const AGENT = arg('--agent', 'hk3');
  const ROOMS = new Set(String(arg('--rooms', '38,39')).split(',').map(Number));
  const PORT = Number(arg('--annotate-port', process.env.M59_ANNOTATE_PORT || 8919));
  const RESEND_MS = 2000;   // UDP has no reply, and a person may turn the client by hand: say it again
  const sock = dgram.createSocket('udp4');
  const DRY = argv.includes('--dry-run');
  const EVERY_MS = Number(arg('--every', 300));
  const MIN_TURN = Math.round(Number(arg('--min-degrees', 3)) * MAX_ANGLE / 360);
  const FLEET = arg('--fleet', null) ?? (fleetName() || 'default');
  const PIDFILE = cameraPidFile(AGENT);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  if (argv.includes('--stop')) {
    let pid = null;
    try { pid = JSON.parse(readFileSync(PIDFILE, 'utf8')).pid; } catch {}
    if (pid && alive(pid)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    try { unlinkSync(PIDFILE); } catch {}
    console.log(pid ? `stopped the camera for ${AGENT} (pid ${pid})` : `no camera running for ${AGENT}`);
    process.exit(0);
  }
  try {
    const prior = JSON.parse(readFileSync(PIDFILE, 'utf8')).pid;
    if (prior && prior !== process.pid && alive(prior)) { console.error(`a camera for ${AGENT} is already running (pid ${prior}); --stop it first`); process.exit(2); }
  } catch {}
  // --follow <name>: also treat this one player as the target. For a live test with no war on,
  // pointed at a fleetmate; never needed in a real fight.
  const FOLLOW = arg('--follow', null);
  const bandArg = arg('--band', null);
  const band = bandArg ? { base: Number(bandArg.split('-')[0]), end: Number(bandArg.split('-')[1]) } : null;
  const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
  const getJson = async (url, ms = 2500) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return r.json();
  };

  let keepers = new Map(), character = null, eye = null, lastScan = 0, lastAngle = null, lastSent = 0, target = null;
  let enemyNames = warEnemyNames(), lastBook = Date.now(), saidIdle = null;

  async function rescan() {
    keepers = await scanKeepers({ fleet: FLEET, band });
    lastScan = Date.now();
    character ??= [...keepers.values()].find(k => k.agent === AGENT)?.character ?? null;
  }
  // The eye: any OTHER in-game keeper in a watched room that can see the camera.
  async function findEye() {
    for (const k of keepers.values()) {
      if (k.agent === AGENT || !k.in_game) continue;
      try {
        const s = await getJson(`http://127.0.0.1:${k.port}/state`);
        if (!ROOMS.has(s.room?.num)) continue;
        if ((s.objects ?? []).some(o => normName(o.name) === normName(character))) return { ...k, room: s.room.num };
      } catch {}
    }
    return null;
  }
  async function turn(angle) {
    if (DRY) return { ok: true, dry: true };
    await new Promise((ok, no) => sock.send(Buffer.from(`turn=${angle}`), PORT, '127.0.0.1', e => e ? no(e) : ok()));
    return { ok: true };
  }
  const idle = why => { if (saidIdle !== why) { log('idle:', why); saidIdle = why; } };

  async function frame() {
    if (!keepers.size || Date.now() - lastScan > 60_000) await rescan();
    if (!character) return idle(`no keeper answers as ${AGENT}, so the camera's name is unknown`);
    if (Date.now() - lastBook > 60_000) { enemyNames = warEnemyNames(); lastBook = Date.now(); }
    if (!eye) { eye = await findEye(); if (!eye) return idle(`no fleet keeper can see ${character} in rooms ${[...ROOMS].join(',')}`); log(`eye: ${eye.character} (${eye.agent}) in room ${eye.room}`); }
    let s;
    try { s = await getJson(`http://127.0.0.1:${eye.port}/state`); } catch { eye = null; return; }
    if (s.agent && s.agent !== eye.agent) { eye = null; return; }          // the port moved to somebody else
    if (!ROOMS.has(s.room?.num)) { eye = null; return; }
    const me = (s.objects ?? []).find(o => normName(o.name) === normName(character));
    if (!me) { eye = null; return; }
    const t = chooseTarget(s.objects, { me, current: target, isEnemyName: n => enemyNames.has(normName(n)) || (FOLLOW && normName(n) === normName(FOLLOW)) });
    if (!t) { if (target) log(`target gone: ${target}`); target = null; return idle('no enemy in the room'); }
    saidIdle = null;
    if (target !== t.name) log(`target: ${t.name} at r${t.row}c${t.col}`);
    target = t.name;
    const a = angleTo(me, t);
    if (lastAngle != null && angleDelta(a, lastAngle) < MIN_TURN && Date.now() - lastSent < RESEND_MS) return;
    const r = await turn(a).catch(e => ({ ok: false, why: e.message }));
    if (r.ok) { lastAngle = a; lastSent = Date.now(); }
    else log(`turn refused: ${r.why ?? r.error ?? JSON.stringify(r)}`);
    if (DRY) log(`would turn to ${Math.round(a * 360 / MAX_ANGLE)}° toward ${t.name}`);
  }

  if (!DRY) {
    mkdirSync(join(PIDFILE, '..'), { recursive: true });
    writeFileSync(PIDFILE, JSON.stringify({ pid: process.pid, agent: AGENT, port: PORT, rooms: [...ROOMS], started: new Date().toISOString() }));
    const bye = () => { try { if (JSON.parse(readFileSync(PIDFILE, 'utf8')).pid === process.pid) unlinkSync(PIDFILE); } catch {} process.exit(0); };
    process.on('SIGINT', bye); process.on('SIGTERM', bye);
  }
  log(`cameraman for ${AGENT} in rooms ${[...ROOMS].join(',')}${DRY ? ' (dry run)' : ` via udp :${PORT}`}`);
  let busy = false;
  setInterval(async () => {
    if (busy) return; busy = true;
    try { await frame(); } catch (e) { log('frame failed:', e.message); } finally { busy = false; }
  }, EVERY_MS);
}
