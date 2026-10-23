#!/usr/bin/env node
// m59-secret-travel.mjs — TRAVEL ONLY WHILE NOBODY IS WATCHING. A journey that a stranger sees is stopped where it is.
//
//   node tools/m59-secret-travel.mjs --fleet prod --to 615 --agents t2,t3,... [--concurrency 3] [--pvp-strategy secret-flee]
//   node tools/m59-secret-travel.mjs --fleet prod --report            # what the incident log says, no world action
//
// Operator, 2026-10-23, after the Brax bastion was found within an hour: "make a new 'secret travel' plan that only
// travels when no non-fleet people are in the room, and a watchdog interrupts travel (records the incident) and locks
// down the discovered traveler in a room if it sees anyone (auto flees PvP)."
//
// Per traveler:
//   1. WAIT until its room holds no non-fleet player. A stranger at the start is a sighting, not an incident: the
//      character has not set out, so there is nothing to give away.
//   2. CONFINE it to the rooms of its own route (an empty confine list is ignored by the keeper push, and a survival
//      rung that hands the body back mid-walk must not steer it anywhere off the road), then issue ONE travel.
//   3. WATCH the keeper's own /state over loopback every WATCH_MS — 7 ms a read, so no broker load — and on the first
//      non-fleet player in the room: cancel the journey, write an incident, and lock the character in that room
//      (survive, confined, assigned). It is not resumed: the next step would show the stranger where it was going.
//   4. On arrival: lock it in the destination.
//
// "Non-fleet" is every player the fleet roster AND its menagerie do not name: a host is ours for "do not shoot", so it
// is ours for "nobody saw". NPCs are not players (is_player false) and never count — Tendrath wandering through is
// not a witness.
//
// PvP: with --pvp-strategy, every traveler is assigned that strategy in substrate/pvp-strategy-<fleet>.json with
// `options.flee` = the nearest inn to each room on its route (breadth-first over substrate/m59-map.json). The
// strategy module is this machine's orders and is not committed; the decision it is meant to make is
// `attacked_by_player -> flee_to options.flee[room]`. The file is backed up before it is written.
//
// The incident log is substrate/history/secret-travel-<fleet>.jsonl; --report reads it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WATCH_MS = 500;

// ---------------------------------------------------------------------------------------------- pure helpers (tested)

/** The non-fleet players in a keeper /state `objects` list. `fleet` is a Set of lower-cased names (agents + characters). */
export function strangersIn(objects, fleet, self = null) {
  const me = String(self ?? '').toLowerCase();
  return (objects ?? [])
    .filter(o => o && o.is_player === true)
    .filter(o => { const n = String(o.name ?? '').trim().toLowerCase(); return n && n !== me && !fleet.has(n); })
    .map(o => ({ name: String(o.name).trim(), col: o.col ?? null, row: o.row ?? null }));
}

/** Room graph out of the baked map: edge and go exits, plus `extra` [[from,to],...] the bake is known to miss. */
export function roomGraph(map, extra = []) {
  const g = new Map();
  const add = (a, b) => { if (!(a > 1) || !(b > 1)) return; if (!g.has(a)) g.set(a, new Set()); g.get(a).add(b); };
  for (const [k, r] of Object.entries(map?.rooms ?? {})) {
    for (const e of r.edgeExits ?? []) add(Number(k), Number(e.to));
    for (const e of r.goExits ?? []) add(Number(k), Number(e.to));
  }
  for (const [a, b] of extra) add(Number(a), Number(b));
  return g;
}

/** Nearest room in `targets` from each of `rooms`, by hop count. Unreachable rooms are left out. */
export function nearestOf(graph, rooms, targets) {
  const want = new Set(targets.map(Number)), out = {};
  for (const start of rooms.map(Number)) {
    const seen = new Set([start]); let frontier = [start], hops = 0, hit = null;
    while (frontier.length && hit == null) {
      hit = frontier.find(r => want.has(r)) ?? null;
      if (hit != null) break;
      const next = [];
      for (const r of frontier) for (const n of graph.get(r) ?? []) if (!seen.has(n)) { seen.add(n); next.push(n); }
      frontier = next; hops++;
    }
    if (hit != null) out[start] = { room: hit, hops };
  }
  return out;
}

/**
 * ONE WATCH TICK. `obs` is what the keeper says now; `t` is the traveler's record. Returns what to do:
 *   { act: 'discovered', strangers }  a non-fleet player shares the room while travelling -> stop and lock
 *   { act: 'arrived' }                 in the destination
 *   { act: 'died' }                    the Underworld, or no health
 *   { act: 'stalled' }                 no journey running and not there
 *   { act: 'continue' }
 */
export function watchTick(t, obs, fleet) {
  const room = Number(obs?.room?.num);
  const hp = Number(obs?.hp?.value);
  if (room === 1 || (Number.isFinite(hp) && hp <= 0)) return { act: 'died', room };
  const strangers = strangersIn(obs?.objects, fleet, obs?.character);
  if (strangers.length) return { act: 'discovered', room, strangers };
  if (room === Number(t.to)) return { act: 'arrived', room };
  // A survival rung (rest, a fight) suspends a journey and the order reads null meanwhile, so "stalled" is a null
  // order held for STALL_MS, never one reading: re-sending into a rest is how a journey is re-issued into itself.
  // A LIVE ORDER IS NOT PROGRESS. The keeper's resume_journey re-arms a failed journey every couple of minutes on
  // the same square, so the order never reads null and the body never moves: Waldorf, 22 minutes at the south edge
  // of Kardde's Canyon (49) on 2026-10-23 while `route_progressing_exits_exhausted` repeated. Under two squares in
  // WEDGE_MS, in one room, is wedged.
  const row = Number(obs?.you?.row), col = Number(obs?.you?.col), now = Date.now();
  if (Number.isFinite(row) && Number.isFinite(col)) {
    const a = t.anchor;
    if (!a || a.room !== room || Math.hypot(a.row - row, a.col - col) >= 2) t.anchor = { room, row, col, at: now };
    else if (now - a.at >= (t.wedgeMs ?? 240_000) && now - (t.sentAt ?? 0) >= (t.wedgeMs ?? 240_000)) { t.anchor = null; return { act: 'wedged', room }; }
  }
  const idle = obs?.movement && obs.movement.order == null;
  if (!idle) { t.idleSince = null; return { act: 'continue', room }; }
  t.idleSince ??= Date.now();
  if (Date.now() - (t.sentAt ?? 0) > 15_000 && Date.now() - t.idleSince >= (t.stallMs ?? 45_000)) return { act: 'stalled', room };
  return { act: 'continue', room };
}

/** What the incident log says: travellers, sightings, distinct strangers, watchdog trips, deaths, arrivals. */
export function summarise(rows) {
  const out = { runs: 0, travellers: new Set(), arrived: new Set(), discovered: [], died: [], waited: [], strangers: new Map() };
  for (const r of rows) {
    if (r.what === 'run start') out.runs++;
    if (r.agent) out.travellers.add(r.agent);
    if (r.what === 'arrived') out.arrived.add(r.agent);
    if (r.what === 'DISCOVERED') out.discovered.push(r);
    if (r.what === 'died') out.died.push(r);
    if (r.what === 'waiting: stranger in the room') out.waited.push(r);
    for (const s of r.strangers ?? []) {
      const k = s.name;
      if (!out.strangers.has(k)) out.strangers.set(k, { name: k, rooms: new Set(), by: new Set(), triggered: 0 });
      const e = out.strangers.get(k); e.rooms.add(r.room); e.by.add(r.agent);
      if (r.what === 'DISCOVERED') e.triggered++;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------ driver

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

async function main() {
  const fleetName = arg('--fleet') ?? process.env.M59_FLEET;
  if (!fleetName) { console.error('--fleet is required'); process.exit(2); }
  process.env.M59_FLEET = fleetName;
  const LOG = path.join(REPO, 'substrate', 'history', `secret-travel-${fleetName}.jsonl`);
  fs.mkdirSync(path.dirname(LOG), { recursive: true });

  if (argv.includes('--report')) {
    const rows = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    const since = arg('--since'); const s = summarise(since ? rows.filter(r => r.at >= since) : rows);
    console.log(`runs ${s.runs}, travellers ${s.travellers.size}, arrived ${s.arrived.size}, watchdog trips ${s.discovered.length}, deaths ${s.died.length}, waits at the start ${s.waited.length}`);
    console.log(`distinct non-fleet players seen: ${s.strangers.size}`);
    for (const e of s.strangers.values()) console.log(`  ${e.name}: rooms ${[...e.rooms].join(',')}; seen by ${[...e.by].join(',')}; tripped the watchdog ${e.triggered}x`);
    for (const d of s.discovered) console.log(`  TRIP ${d.at} ${d.agent} in ${d.room}: ${d.strangers.map(x => x.name).join(', ')}`);
    return;
  }

  const { call, knownCharacters, hostsAmong } = await import('./m59-fleetscript.mjs');
  const { lookupKeeperBand } = await import('./runtime/keeper-bands.mjs');
  const to = Number(arg('--to'));
  if (!(to > 1)) { console.error('--to <room> is required'); process.exit(2); }
  const agents = String(arg('--agents') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!agents.length) { console.error('--agents is required'); process.exit(2); }
  const concurrency = Math.max(1, Number(arg('--concurrency', 3)));
  const strategy = arg('--pvp-strategy');
  const STOP = path.join(REPO, 'substrate', 'scratch', `secret-travel-${fleetName}.stop`);
  const log = (what, x = {}) => { const l = JSON.stringify({ at: new Date().toISOString(), what, ...x }); fs.appendFileSync(LOG, l + '\n'); console.log(l); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // who is ours: roster agents + characters, and the menagerie's
  const fleet = new Set([...knownCharacters(fleetName).keys()]);
  try {
    const { stateFileFor } = await import('./m59-fleetpath.mjs');
    const { menageriePathFor } = await import('./m59-menagerie-roster.mjs');
    const m = JSON.parse(fs.readFileSync(menageriePathFor(stateFileFor(fleetName)), 'utf8'));
    for (const [a, e] of Object.entries(m ?? {})) { fleet.add(a.toLowerCase()); if (e?.credentials?.character) fleet.add(String(e.credentials.character).toLowerCase()); }
  } catch {}   // no menagerie file is the ordinary case
  if (fleet.size < 2) { console.error('could not read the fleet roster names; refusing (every player would look like a stranger)'); process.exit(1); }
  if (hostsAmong(agents, fleetName).length) { console.error(`refusing menagerie hosts: ${hostsAmong(agents, fleetName).join(',')}`); process.exit(1); }

  // keepers over loopback, rescanned when a pid moves
  const band = lookupKeeperBand(fleetName);
  if (!band) { console.error(`no keeper band for ${fleetName}`); process.exit(1); }
  let ports = new Map(), portsAt = 0;
  async function scan() {
    const found = new Map();
    await Promise.all(Array.from({ length: band.end - band.base + 1 }, (_, i) => band.base + i).map(port =>
      fetch(`http://127.0.0.1:${port}/live`, { signal: AbortSignal.timeout(700) }).then(r => r.ok ? r.json() : null)
        .then(v => { if (v?.agent) found.set(String(v.agent), { port, agent: v.agent, character: v.character, pid: v.pid }); }).catch(() => {})));
    ports = found; portsAt = Date.now();
  }
  async function state(agent) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!ports.has(agent) || Date.now() - portsAt > 60_000 || attempt) await scan();
      const k = ports.get(agent); if (!k) continue;
      const q = new URLSearchParams({ agent: k.agent, character: k.character ?? '', keeper_pid: String(k.pid ?? '') });
      const s = await fetch(`http://127.0.0.1:${k.port}/state?${q}`, { signal: AbortSignal.timeout(3000) }).then(r => r.ok ? r.json() : null).catch(() => null);
      if (s?.agent === agent) return s;
    }
    return null;
  }
  async function route(agent, dest) {
    if (!ports.has(agent)) await scan();
    const k = ports.get(agent); if (!k) return null;
    return fetch(`http://127.0.0.1:${k.port}/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'route', agent: k.agent, character: k.character, keeper_pid: k.pid, args: { to: dest } }),
      signal: AbortSignal.timeout(20_000) }).then(r => r.json()).catch(() => null);
  }
  const piloted = async agent => {
    const f = await call('fleet', {}, 60_000).catch(() => null);
    const row = (f?.fleet ?? []).find(r => r.agent === agent);
    return row ? row.piloted ?? null : 'unread';
  };
  const lock = (agent, room, why) => call('autopilot', { agent, action: 'start', mode: 'survive', assigned_room: room, confine_rooms: [room],
    roam: false, farm_strategy: null, why }, 60_000).catch(e => ({ error: e.message }));

  // nearest inn for every room the fleet might walk, for the PvP flight
  const map = JSON.parse(fs.readFileSync(path.join(REPO, 'substrate', 'm59-map.json'), 'utf8'));
  // k5.kod StandardLeaveDir: leaving 615 west lands in 45 (r3c80); the bake records no exit out of 615.
  const graph = roomGraph(map, [[615, 45]]);
  const inns = Object.entries(map.rooms).filter(([, r]) => /\binn\b/i.test(r.name ?? '')).map(([k]) => Number(k)).filter(n => n < 1000);

  log('run start', { to, agents, concurrency, strategy, fleet_names: fleet.size });
  const plans = new Map();
  for (const agent of agents) {
    const s = await state(agent);
    const here = Number(s?.room?.num);
    if (!s) { log('skipped: keeper unread', { agent }); continue; }
    if (here === to) { plans.set(agent, { agent, rooms: [to], here }); continue; }
    const r = await route(agent, to);
    if (!r?.found) { log('skipped: no route', { agent, room: here, reason: r?.reason ?? null }); continue; }
    plans.set(agent, { agent, here, rooms: [here, ...r.hops.map(h => Number(h.to))] });
  }
  if (strategy) {
    const file = path.join(REPO, 'substrate', `pvp-strategy-${fleetName}.json`);
    let cur = {}; try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const bak = path.join(REPO, 'substrate', 'history', `pvp-strategy-${fleetName}.json.bak-secret-travel-${Date.now()}`);
    if (fs.existsSync(file)) fs.copyFileSync(file, bak);
    cur.agents ??= {};
    for (const p of plans.values()) {
      const flee = Object.fromEntries(Object.entries(nearestOf(graph, p.rooms, inns)).map(([k, v]) => [k, v.room]));
      cur.agents[p.agent] = { strategy, options: { flee, why: 'secret travel: flee a player\'s attack to the nearest inn' } };
    }
    cur.why = `secret travel to ${to} ${new Date().toISOString()} (backup ${path.basename(bak)})`;
    fs.writeFileSync(file, JSON.stringify(cur, null, 1));
    log('pvp strategy assigned', { strategy, agents: [...plans.keys()], backup: bak });
  }

  async function travel(p) {
    const { agent } = p;
    if (p.here === to) { const r = await lock(agent, to, 'secret travel: already there'); log('arrived', { agent, room: to, already: true, locked: r?.keeper_push?.ok ?? r?.error ?? null }); return; }
    const pil = await piloted(agent);
    if (pil) { log('skipped: piloted', { agent, piloted: pil }); return; }
    // 1. nobody in the room before setting out
    for (let waited = 0; ; waited++) {
      if (fs.existsSync(STOP)) { log('stop file: not started', { agent }); return; }
      const s = await state(agent);
      const strangers = strangersIn(s?.objects, fleet, s?.character);
      if (s && !strangers.length) break;
      if (waited % 20 === 0) log('waiting: stranger in the room', { agent, room: Number(s?.room?.num), strangers });
      await sleep(3000);
    }
    // 2. confined to its road, one travel
    let tries = 0;
    const t = { to, sentAt: 0 };
    const send = async () => {
      tries++;
      await call('autopilot', { agent, action: 'start', mode: 'survive', assigned_room: to, confine_rooms: p.rooms, roam: false, farm_strategy: null,
        why: `secret travel to ${to}` }, 60_000).catch(() => null);
      const r = await call('travel', { agent, to, run_errands: false }, 30_000).catch(e => ({ error: e.message }));
      t.sentAt = Date.now();
      log('travel sent', { agent, from: Number((await state(agent))?.room?.num), to, try: tries, reply: r?.error ?? r?.started ?? r?.ok ?? null });
    };
    await send();
    // 3. the watchdog
    let lastRoom = null;
    for (;;) {
      await sleep(WATCH_MS);
      if (fs.existsSync(STOP)) {
        const s = await state(agent); const room = Number(s?.room?.num);
        await call('cancel_movement', { agent, why: 'secret travel: stop file' }, 30_000).catch(() => null);
        await lock(agent, room, 'secret travel stopped');
        log('stopped and locked', { agent, room }); return;
      }
      const s = await state(agent);
      if (!s) continue;
      const v = watchTick(t, s, fleet);
      if (v.room !== lastRoom) { if (lastRoom != null) log('hop', { agent, room: v.room, name: s.room?.name }); lastRoom = v.room; }
      if (v.act === 'continue') continue;
      if (v.act === 'discovered') {
        const c = await call('cancel_movement', { agent, why: `secret travel: seen by ${v.strangers.map(x => x.name).join(', ')}` }, 30_000).catch(e => ({ error: e.message }));
        const l = await lock(agent, v.room, `secret travel: discovered in ${v.room}`);
        log('DISCOVERED', { agent, character: s.character, room: v.room, room_name: s.room?.name, strangers: v.strangers,
          position: { col: s.you?.col ?? null, row: s.you?.row ?? null }, hp: s.hp, cancelled: c?.error ?? !!c, locked: l?.keeper_push?.ok ?? l?.error ?? null });
        return;
      }
      if (v.act === 'arrived') {
        const l = await lock(agent, to, 'secret travel: arrived');
        log('arrived', { agent, room: to, hp: s.hp, locked: l?.keeper_push?.ok ?? l?.error ?? null }); return;
      }
      if (v.act === 'died') { log('died', { agent, room: v.room, last_room: lastRoom }); return; }
      if (v.act === 'wedged') {
        await call('cancel_movement', { agent, why: `secret travel: no progress in ${v.room} for 4 min` }, 30_000).catch(() => null);
        log('wedged: cancelled, re-sending', { agent, room: v.room, position: { row: s.you?.row ?? null, col: s.you?.col ?? null } });
        if (tries >= 6) { await lock(agent, v.room, 'secret travel: gave up'); log('gave up: wedged', { agent, room: v.room }); return; }
        await sleep(5000);
        await send();
        continue;
      }
      if (v.act === 'stalled') {
        if (tries >= 4) { await lock(agent, v.room, 'secret travel: gave up'); log('gave up: journey keeps stopping', { agent, room: v.room, last: s.movement?.last_cancel?.summary ?? null }); return; }
        log('journey stopped, re-sending', { agent, room: v.room, last: s.movement?.last_cancel?.summary ?? s.job?.last_action ?? null });
        await sleep(5000);
        await send();
      }
    }
  }

  const queue = [...plans.values()];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async (_, i) => {
    await sleep(i * 20_000);   // a column, not a crowd
    while (queue.length) await travel(queue.shift()).catch(e => log('error', { error: e.message }));
  });
  await Promise.all(workers);
  log('run end', { to });
}

if (isMain) main().catch(e => { console.error(e); process.exit(1); });
