#!/usr/bin/env node
// A TRIPWIRE: A WATCHED CONDITION THAT PUTS A POSTURE ON BY ITSELF, AND TAKES IT OFF AFTER A FRESH QUIET.
//
//   node tools/m59-tripwire.mjs list                                  the tripwires this machine has
//   node tools/m59-tripwire.mjs check <tripwire>                      load it and say what is wrong with it
//   node tools/m59-tripwire.mjs try   <tripwire> [--who "A,B"] [--alarm Name@38] [--pvp-death t4:Name]
//                                                                     offline: would these observations fire it?
//   node tools/m59-tripwire.mjs look  --fleet prod                    one live observation, every armed tripwire
//                                                                     judged against it. READ-ONLY.
//   node tools/m59-tripwire.mjs watch --fleet prod [--dry]            the watcher (one per fleet). --dry logs what
//                                                                     it would do and pushes nothing
//   node tools/m59-tripwire.mjs fire  <tripwire> --fleet prod --why "..."   by hand, as if it had tripped
//   node tools/m59-tripwire.mjs stand-down <tripwire> --fleet prod    by hand, before the quiet has run out
//   node tools/m59-tripwire.mjs status --fleet prod
//
// WHY. The red-alert supervisor of 2026-10-17 locked the fleet into Castle Victoria when a named enemy appeared
// in `who`, and stood it down after fifteen minutes of fresh absence. It was right often enough to keep, and it
// was a 280-line private script that wrote its own lockdown, its own save and its own restore -- the very things
// that went wrong twice in hand-written stand-downs. Here the trigger is the only thing a tripwire says; the
// orders and the undo are a POSTURE (m59-posture.mjs: save first, read back both ways, a half-failed release
// stays active).
//
// OFF BY DEFAULT, TWICE. A tripwire does nothing unless (1) its fleet's substrate/tripwires-<fleet>.json names
// it in `enabled`, and (2) somebody is running `watch` for that fleet. A fresh clone has neither. The standing
// operator rule "no change just because an enemy logs in" is therefore still the default; arming a `who`
// tripwire is the operator overruling it for that fleet, on purpose, in a file.
//
// FAIL-SAFE RULES, each from the supervisor it replaces:
//   1. A STALE OBSERVATION IS NOT QUIET. A `who` that did not refresh resets the quiet clock instead of
//      advancing it; only fresh absence counts toward a stand-down.
//   2. IT ONLY TAKES OFF WHAT IT PUT ON. If the posture was already on when the tripwire fired (an operator
//      applied it by hand), the tripwire never releases it -- `owned: false`, and the stand-down says so.
//   3. TWO TRIPWIRES ON ONE POSTURE: the posture comes off when the LAST of them is quiet.
//   4. ONE WATCHER PER FLEET (a pid file), and it refuses to run while any pid named in the fleet file's
//      `exclusive_pids` is alive -- the private red-alert supervisor is the case: two of them would fight
//      over the same bodies.
//   5. Every trip, quiet, stand-down and refusal is a line in substrate/tripwire-state/<fleet>/events.jsonl.
//
// A TRIPWIRE IS AN ORDER, SO IT IS THIS MACHINE'S: substrate/tripwires/<name>.mjs (gitignored), or a private
// repository's directory (substrate/tripwire-dirs.json). The shape is substrate/tripwires.example/.
//
//   export default {
//     name: 'red-alert', about: 'a named enemy online locks the fleet into Castle Victoria',
//     when: [                                            // any one of these trips it
//       { who_online: ['Morpheus', 'Wenbo'] },           // exact name (case/space folded) in a fresh `who`
//       { war_alarm: { enemies: ['Morpheus'], rooms: [38, 39], within_ms: 60_000 } },   // a keeper's alarm
//       { pvp_death: { count: 2, within_ms: 600_000 } }, // fleet PvP deaths (the pvp-hold records)
//       obs => obs.who?.players?.length > 40 ? 'crowded' : null,                         // or a function
//     ],
//     then: { posture: 'lockdown-cv' },
//     quiet_ms: 15 * 60_000,                             // null: never stands down by itself
//     rearm_ms: 5 * 60_000,                              // after a stand-down, how long before it can trip again
//   };
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, appendFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SUBSTRATE = join(REPO, 'substrate');
export const tripwireDir = (env = process.env) => env.M59_TRIPWIRE_DIR || join(SUBSTRATE, 'tripwires');
export const EXAMPLE_DIR = join(SUBSTRATE, 'tripwires.example');
export const stateDir = (fleet, env = process.env) => env.M59_TRIPWIRE_STATE || join(SUBSTRATE, 'tripwire-state', fleet || 'default');
export const assignmentFile = (fleet, env = process.env) => env.M59_TRIPWIRE_ASSIGN || join(SUBSTRATE, `tripwires-${fleet || 'default'}.json`);

export const fold = n => String(n ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export function tripwireDirs({ env = process.env } = {}) {
  const out = [tripwireDir(env)];
  try { for (const d of JSON.parse(readFileSync(join(SUBSTRATE, 'tripwire-dirs.json'), 'utf8')).dirs ?? []) out.push(resolve(REPO, d)); } catch {}
  return out;
}
export function findTripwire(name, { dirs = tripwireDirs(), examples = true } = {}) {
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(String(name ?? '')) || String(name).includes('..')) return null;
  for (const d of [...dirs, ...(examples ? [EXAMPLE_DIR] : [])]) {
    const f = join(d, `${name}.mjs`);
    if (existsSync(f)) return f;
  }
  return null;
}
export async function loadTripwire(name, opts) {
  const file = findTripwire(name, opts);
  if (!file) throw new Error(`no tripwire "${name}" in ${[...tripwireDirs(), EXAMPLE_DIR].join(', ')}`);
  const t = (await import(pathToFileURL(file).href)).default;
  const errors = checkTripwire(t);
  if (errors.length) throw new Error(`${name}: ${errors.join('; ')}`);
  return { ...t, file };
}

/** The fleet file: { enabled: [...], exclusive_pids: [...] }. Missing or unreadable is "nothing armed". */
export function readAssignment(fleet, env = process.env) {
  const f = assignmentFile(fleet, env);
  if (!existsSync(f)) return { enabled: [], exclusive_pids: [], file: f, present: false };
  try {
    const a = JSON.parse(readFileSync(f, 'utf8'));
    return { enabled: Array.isArray(a.enabled) ? a.enabled : [], exclusive_pids: Array.isArray(a.exclusive_pids) ? a.exclusive_pids : [], file: f, present: true };
  } catch (e) { return { enabled: [], exclusive_pids: [], file: f, present: true, error: `does not parse: ${e.message}` }; }
}

// ------------------------------------------------------------------------------------------- triggers
// Each trigger: needs (which observation it reads), check(spec, obs) -> [detail...] (empty = not tripped),
// and valid(spec) -> error | null. The set is closed; an unknown trigger is refused at load, not ignored.
const names = v => (Array.isArray(v) ? v : v?.names ?? []).map(fold).filter(Boolean);
const within = (spec, dflt) => Number.isFinite(spec?.within_ms) ? spec.within_ms : dflt;
export const TRIGGERS = {
  who_online: {
    needs: 'who',
    valid: s => names(s).length ? null : 'who_online needs at least one name',
    check: (s, obs) => {
      const want = new Set(names(s));
      return (obs.who?.players ?? []).filter(p => want.has(fold(p.name))).map(p => ({ trigger: 'who_online', name: p.name, by: obs.who.by ?? null }));
    },
  },
  war_alarm: {
    needs: 'alarms',
    valid: s => (s && typeof s === 'object') ? null : 'war_alarm needs an object ({} for any alarm)',
    check: (s, obs) => {
      const en = names(s.enemies ?? []), since = obs.now - within(s, 60_000);
      return (obs.alarms ?? []).filter(a => a.at >= since
          && (!en.length || en.includes(fold(a.enemy)))
          && (!s.rooms?.length || s.rooms.includes(Number(a.room)))
          && (!s.basis?.length || s.basis.includes(a.basis)))
        .map(a => ({ trigger: 'war_alarm', name: a.enemy, room: a.room, by: a.reporter ?? null, basis: a.basis ?? null }));
    },
  },
  pvp_death: {
    needs: 'deaths',
    valid: s => (s && typeof s === 'object') ? null : 'pvp_death needs an object ({} for any one PvP death)',
    check: (s, obs) => {
      const k = names(s.killers ?? []), since = obs.now - within(s, 30 * 60_000);
      const hits = (obs.pvp_deaths ?? []).filter(d => d.died_at >= since && (!k.length || (d.killers ?? []).some(x => k.includes(fold(x)))));
      return hits.length >= (s.count ?? 1) ? hits.map(d => ({ trigger: 'pvp_death', agent: d.agent, killers: d.killers ?? [], died_at: d.died_at })) : [];
    },
  },
};

const clauses = t => (Array.isArray(t.when) ? t.when : t.when ? [t.when] : []);
export function checkTripwire(t) {
  const errors = [];
  if (!t || typeof t !== 'object') return ['no default export'];
  if (!t.name) errors.push('no name');
  if (!t.then?.posture) errors.push('then.posture names no posture');
  const cs = clauses(t);
  if (!cs.length) errors.push('when names no trigger');
  for (const c of cs) {
    if (typeof c === 'function') continue;
    const keys = Object.keys(c ?? {});
    if (keys.length !== 1) { errors.push(`a clause has ${keys.length} keys; write one trigger per clause: ${JSON.stringify(c)}`); continue; }
    const tr = TRIGGERS[keys[0]];
    if (!tr) { errors.push(`unknown trigger "${keys[0]}" (known: ${Object.keys(TRIGGERS).join(', ')})`); continue; }
    const e = tr.valid(c[keys[0]]); if (e) errors.push(e);
  }
  if (t.quiet_ms != null && !(t.quiet_ms > 0)) errors.push('quiet_ms must be a positive number or null');
  return errors;
}

/** What a tripwire reads: 'who', 'alarms', 'deaths', or 'custom' for a function clause (which may read anything). */
export const needsOf = t => new Set(clauses(t).flatMap(c => typeof c === 'function' ? ['who', 'alarms', 'deaths'] : [TRIGGERS[Object.keys(c)[0]].needs]));

/** Every hit this observation gives the tripwire. A function clause that throws is a refusal, not a hit. */
export function evaluate(t, obs) {
  const hits = [];
  for (const c of clauses(t)) {
    if (typeof c === 'function') {
      let r = null; try { r = c(obs); } catch (e) { hits.push({ trigger: 'function', error: e.message, refused: true }); continue; }
      if (r) hits.push({ trigger: 'function', detail: typeof r === 'string' ? r : r });
      continue;
    }
    const k = Object.keys(c)[0];
    hits.push(...TRIGGERS[k].check(c[k], obs));
  }
  return hits.filter(h => !h.refused);
}

/** Is this observation good enough to count as quiet? Only if every source the tripwire reads was actually read. */
export function freshFor(t, obs) {
  const n = needsOf(t);
  if (n.has('who') && obs.who?.refreshed !== true) return false;
  if (n.has('alarms') && !Array.isArray(obs.alarms)) return false;
  if (n.has('deaths') && !Array.isArray(obs.pvp_deaths)) return false;
  return true;
}

/**
 * One tick, pure. state: { active, owned, fired_at, last_hit_at, quiet_since, released_at, hits }.
 * Returns { state, action: 'fire' | 'release' | null, hits, why }.
 */
export function step(t, state = {}, obs, now = obs.now ?? Date.now()) {
  const s = { ...state };
  const hits = evaluate(t, { ...obs, now });
  const fresh = freshFor(t, obs);
  if (!s.active) {
    if (!hits.length) return { state: s, action: null, hits, why: null };
    if (s.released_at && now - s.released_at < (t.rearm_ms ?? 0)) return { state: s, action: null, hits, why: 'rearming' };
    if (s.retry_at && now < s.retry_at) return { state: s, action: null, hits, why: 'retrying after a failed trip' };
    return { state: s, action: 'fire', hits, why: describe(hits) };
  }
  if (hits.length) { s.last_hit_at = now; s.quiet_since = null; s.hits = hits.slice(0, 8); return { state: s, action: null, hits, why: 'still tripped' }; }
  if (!fresh) { s.quiet_since = null; return { state: s, action: null, hits, why: 'observation not fresh; quiet clock reset' }; }
  s.quiet_since ??= now;
  if (t.quiet_ms != null && now - s.quiet_since >= t.quiet_ms) return { state: s, action: 'release', hits, why: `${Math.round((now - s.quiet_since) / 60_000)} min of fresh quiet` };
  return { state: s, action: null, hits, why: 'quiet' };
}
export const describe = hits => hits.map(h => [h.trigger, h.name ?? h.agent ?? h.detail, h.room ? `@${h.room}` : ''].filter(Boolean).join(' ')).join(', ');

/** May this tripwire take its posture off? Only if it put it on, and no other active tripwire holds the same one. */
export function mayRelease(name, states, tripwires) {
  const me = states[name];
  if (!me?.owned) return { ok: false, why: 'the posture was already on when this tripped; it is not ours to take off' };
  const posture = tripwires[name]?.then?.posture;
  const other = Object.entries(states).find(([n, s]) => n !== name && s.active && tripwires[n]?.then?.posture === posture);
  return other ? { ok: false, why: `${other[0]} still holds ${posture}` } : { ok: true };
}

// ------------------------------------------------------------------------------------------- state
const stateFile = fleet => join(stateDir(fleet), 'state.json');
export function readState(fleet) { try { return JSON.parse(readFileSync(stateFile(fleet), 'utf8')); } catch { return {}; } }
function writeState(fleet, st) {
  mkdirSync(stateDir(fleet), { recursive: true });
  const f = stateFile(fleet); writeFileSync(`${f}.tmp`, JSON.stringify(st, null, 1)); renameSync(`${f}.tmp`, f);
}
function eventLog(fleet, { dry = false, quiet = false } = {}) {
  return (kind, data = {}) => {
    const row = { at: Date.now(), iso: new Date().toISOString(), kind, ...(dry ? { dry: true } : {}), ...data };
    if (!dry) { try { mkdirSync(stateDir(fleet), { recursive: true }); appendFileSync(join(stateDir(fleet), 'events.jsonl'), JSON.stringify(row) + '\n'); } catch {} }
    if (!quiet) console.log(`${row.iso} ${dry ? '[dry] ' : ''}${kind} ${JSON.stringify(data).slice(0, 300)}`);
  };
}

// ------------------------------------------------------------------------------------------- live
async function broker() { return import('./m59-fleetscript.mjs'); }
async function posture() { return import('./m59-posture.mjs'); }

async function fleetRows(call) {
  const f = await call('fleet', {});
  return Array.isArray(f) ? f : f?.agents ?? f?.fleet ?? [];
}

/** One observation, reading only what the armed tripwires need. `who` is asked of up to three in-game, unpiloted
 *  fleet characters until one comes back refreshed. Nothing here sends anything but the players-list request. */
export async function observe(call, needs, { alarmsSince = Date.now() - 10 * 60_000, now = Date.now() } = {}) {
  const obs = { now };
  if (needs.has('who')) {
    const rows = (await fleetRows(call)).filter(r => !r.host && !r.piloted && r.activity !== 'NOT IN GAME' && r.in_roster !== false);
    for (const r of rows.slice(0, 3)) {
      const agent = r.agent ?? r.name;
      const w = await call('who', { agent }, 20_000).catch(e => ({ error: e.message }));
      if (w?.error || !Array.isArray(w?.players)) continue;
      obs.who = { players: w.players.map(p => ({ name: p.name })), refreshed: !!w.refreshed, by: agent };
      if (w.refreshed) break;
    }
    obs.who ??= null;
  }
  if (needs.has('alarms')) { const war = await import('./m59-war.mjs'); obs.alarms = war.readAlarms({ since: alarmsSince }); }
  if (needs.has('deaths')) {
    const { readPvpDeath } = await import('./m59-pvp-return.mjs');
    obs.pvp_deaths = (await fleetRows(call)).map(r => r.agent ?? r.name)
      .map(agent => ({ agent, d: readPvpDeath(agent) })).filter(x => x.d)
      .map(x => ({ agent: x.agent, died_at: x.d.died_at, killers: x.d.killers ?? [] }));
  }
  return obs;
}

async function armed(fleet, log) {
  const a = readAssignment(fleet);
  if (a.error) log('assignment_unreadable', { file: a.file, error: a.error });
  const out = {};
  for (const n of a.enabled) {
    try { out[n] = await loadTripwire(n); }
    catch (e) { log('tripwire_refused', { tripwire: n, error: e.message }); }
  }
  return { assignment: a, tripwires: out };
}

async function trip(name, t, st, { fleet, dry, why, log }) {
  const P = await posture();
  const before = P.readSave(fleet, t.then.posture);
  const owned = !before?.active;
  if (dry) { log('would_fire', { tripwire: name, posture: t.then.posture, owned, why }); return { ...st, active: true, owned, fired_at: Date.now(), dry: true }; }
  log('tripped', { tripwire: name, posture: t.then.posture, owned, why });
  try {
    const r = await P.apply(t.then.posture, { fleet, why: `tripwire ${name}: ${why}`, log: line => log('posture', { tripwire: name, line }) });
    if (r.failed?.length) log('posture_partial', { tripwire: name, failed: r.failed.map(f => f.agent) });
    return { ...st, active: true, owned, fired_at: Date.now(), last_hit_at: Date.now(), quiet_since: null, retry_at: null };
  } catch (e) {
    log('trip_failed', { tripwire: name, error: e.message });
    // A save written before the throw means the posture is (partly) on: hold it as active so the quiet can take it off.
    const after = P.readSave(fleet, t.then.posture);
    return after?.active && owned ? { ...st, active: true, owned, fired_at: Date.now(), quiet_since: null }
      : { ...st, active: false, retry_at: Date.now() + 60_000 };
  }
}

async function standDown(name, t, st, { fleet, dry, why, log, states, tripwires }) {
  const may = mayRelease(name, { ...states, [name]: st }, tripwires);
  if (!may.ok) { log('stand_down_without_release', { tripwire: name, why: may.why }); return { ...st, active: false, released_at: Date.now(), quiet_since: null }; }
  if (dry) { log('would_release', { tripwire: name, posture: t.then.posture, why }); return { ...st, active: false, released_at: Date.now(), quiet_since: null }; }
  const P = await posture();
  if (!P.readSave(fleet, t.then.posture)?.active) {
    log('already_released', { tripwire: name, posture: t.then.posture });
    return { ...st, active: false, released_at: Date.now(), quiet_since: null };
  }
  log('standing_down', { tripwire: name, posture: t.then.posture, why });
  try {
    const r = await P.release(t.then.posture, { fleet, log: line => log('posture', { tripwire: name, line }) });
    if (r.failed?.length) { log('release_partial', { tripwire: name, failed: r.failed.map(f => f.agent) }); return st; }   // stays active: posture's own rule
    return { ...st, active: false, released_at: Date.now(), quiet_since: null };
  } catch (e) { log('release_failed', { tripwire: name, error: e.message }); return st; }
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const pidIn = f => { try { return Number(String(readFileSync(f, 'utf8')).match(/\d+/)?.[0]) || null; } catch { return null; } };

export async function watch({ fleet, dry = false, everyMs = 15_000, once = false, call: injected = null } = {}) {
  const log = eventLog(fleet, { dry });
  const { assignment, tripwires } = await armed(fleet, log);
  if (!Object.keys(tripwires).length) {
    console.log(`nothing armed for ${fleet}: ${assignment.present ? `${assignment.file} enables nothing loadable` : `no ${assignment.file}`}. Tripwires are off by default.`);
    return;
  }
  for (const rel of assignment.exclusive_pids) {
    const pid = pidIn(resolve(REPO, rel));
    if (pid && alive(pid)) throw new Error(`refusing: ${rel} names a live process (pid ${pid}) that owns the same job`);
  }
  const pidFile = join(stateDir(fleet), 'watch.pid');
  if (!dry) {
    const other = pidIn(pidFile);
    if (other && other !== process.pid && alive(other)) throw new Error(`a tripwire watcher already runs for ${fleet}: pid ${other}`);
    mkdirSync(stateDir(fleet), { recursive: true }); writeFileSync(pidFile, String(process.pid));
    process.on('exit', () => { try { if (pidIn(pidFile) === process.pid) unlinkSync(pidFile); } catch {} });
  }
  const call = injected ?? (await broker()).call;
  const needs = new Set(Object.values(tripwires).flatMap(t => [...needsOf(t)]));
  let states = dry ? structuredClone(readState(fleet)) : readState(fleet);
  let lastObs = Date.now() - 10 * 60_000;
  log('watch_start', { pid: process.pid, armed: Object.keys(tripwires), needs: [...needs], every_ms: everyMs });
  const tick = async () => {
    const now = Date.now();
    const obs = await observe(call, needs, { alarmsSince: lastObs - 60_000, now }).catch(e => { log('observation_failed', { error: e.message }); return { now }; });
    lastObs = now;
    for (const [name, t] of Object.entries(tripwires)) {
      const wasQuiet = states[name]?.quiet_since;
      const r = step(t, states[name] ?? {}, obs, now);
      states[name] = r.state;
      if (r.action === 'fire') states[name] = await trip(name, t, r.state, { fleet, dry, why: r.why, log });
      else if (r.action === 'release') states[name] = await standDown(name, t, r.state, { fleet, dry, why: r.why, log, states, tripwires });
      else if (states[name].active && !wasQuiet && states[name].quiet_since) log('quiet_started', { tripwire: name });
      else if (states[name].active && wasQuiet && !states[name].quiet_since) log('quiet_reset', { tripwire: name, why: r.why, hits: describe(r.hits) });
      states[name].last_observation = { at: now, fresh: freshFor(t, obs), hits: r.hits.length, by: obs.who?.by ?? null };
    }
    if (!dry) writeState(fleet, states);
  };
  await tick();
  if (once) return states;
  let busy = false;
  setInterval(async () => { if (busy) return; busy = true; try { await tick(); } catch (e) { log('tick_error', { error: e.message }); } finally { busy = false; } }, everyMs);
}

// ------------------------------------------------------------------------------------------- CLI
function parseTry(argv, flag) {
  const out = []; for (let i = 0; i < argv.length; i++) if (argv[i] === flag) out.push(argv[i + 1]); return out;
}
async function main(argv) {
  const [cmd = 'list', name] = argv;
  const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const fleet = flag('--fleet') ?? process.env.M59_FLEET ?? null;
  const needFleet = () => { if (!fleet) throw new Error('name the fleet: --fleet <name> (a tripwire never guesses which characters it is for)'); process.env.M59_FLEET = fleet; };
  if (cmd === 'list') {
    for (const d of [...tripwireDirs(), EXAMPLE_DIR]) {
      let fs = []; try { fs = readdirSync(d).filter(f => f.endsWith('.mjs')); } catch { continue; }
      for (const f of fs) {
        let about = ''; try { about = (await import(pathToFileURL(join(d, f)).href)).default?.about ?? ''; } catch (e) { about = `! ${e.message}`; }
        console.log(`  ${f.slice(0, -4).padEnd(24)} ${d === EXAMPLE_DIR ? '(example) ' : ''}${about}`);
      }
    }
    if (fleet) { const a = readAssignment(fleet); console.log(`armed for ${fleet}: ${a.enabled.length ? a.enabled.join(', ') : 'nothing'}${a.error ? ` (! ${a.error})` : ''}`); }
    return;
  }
  if (cmd === 'check') {
    const t = await loadTripwire(name);
    console.log(`${t.name}: ok -- ${clauses(t).length} clause(s), reads ${[...needsOf(t)].join('+')}, posture ${t.then.posture}, quiet ${t.quiet_ms == null ? 'never (manual stand-down)' : `${t.quiet_ms / 60_000} min`}`);
    const P = await posture();
    if (!P.findPosture(t.then.posture)) { console.log(`  ! posture ${t.then.posture} is not on this machine`); process.exitCode = 1; }
    return;
  }
  if (cmd === 'try') {
    const t = await loadTripwire(name), now = Date.now();
    const who = flag('--who');
    const obs = { now, who: who != null ? { players: who.split(',').map(n => ({ name: n.trim() })).filter(p => p.name), refreshed: !argv.includes('--stale'), by: 'try' } : null,
      alarms: parseTry(argv, '--alarm').map(s => { const [enemy, room] = s.split('@'); return { at: now, enemy, room: Number(room), reporter: 'try', basis: 'attacked' }; }),
      pvp_deaths: parseTry(argv, '--pvp-death').map(s => { const [agent, k] = s.split(':'); return { agent, died_at: now, killers: k ? k.split('+') : [] }; }) };
    const r = step(t, {}, obs, now);
    console.log(r.action === 'fire' ? `TRIPS: ${r.why} -> posture ${t.then.posture}` : `does not trip${r.why ? ` (${r.why})` : ''}`);
    const q = step(t, { active: true, owned: true }, { now, who: { players: [], refreshed: true, by: 'try' }, alarms: [], pvp_deaths: [] }, now);
    console.log(`with all of that gone: ${q.why}${t.quiet_ms != null ? `; stands down after ${t.quiet_ms / 60_000} min of it` : ''}`);
    return;
  }
  needFleet();
  if (cmd === 'status') {
    const a = readAssignment(fleet), st = readState(fleet), pid = pidIn(join(stateDir(fleet), 'watch.pid'));
    console.log(`armed: ${a.enabled.join(', ') || 'nothing (off by default)'}; watcher: ${pid && alive(pid) ? `pid ${pid}` : 'not running'}`);
    for (const [n, s] of Object.entries(st)) console.log(`  ${n.padEnd(20)} ${s.active ? 'TRIPPED' : 'quiet  '} ${s.active ? `since ${new Date(s.fired_at).toISOString()}${s.owned ? '' : ' (posture was already on; not ours to release)'}${s.quiet_since ? `, quiet ${Math.round((Date.now() - s.quiet_since) / 60_000)} min` : ''}` : s.released_at ? `released ${new Date(s.released_at).toISOString()}` : ''}`);
    return;
  }
  if (cmd === 'look') {
    const log = eventLog(fleet, { dry: true, quiet: true });
    const { tripwires } = await armed(fleet, log);
    if (!Object.keys(tripwires).length) { console.log(`nothing armed for ${fleet}`); return; }
    const { call } = await broker();
    const needs = new Set(Object.values(tripwires).flatMap(t => [...needsOf(t)]));
    const obs = await observe(call, needs);
    console.log(`observed: who ${obs.who ? `${obs.who.players.length} online via ${obs.who.by}${obs.who.refreshed ? '' : ' (NOT fresh)'}` : needs.has('who') ? 'FAILED' : '-'}, alarms ${obs.alarms?.length ?? '-'}, pvp deaths ${obs.pvp_deaths?.length ?? '-'}`);
    const st = readState(fleet);
    for (const [n, t] of Object.entries(tripwires)) { const r = step(t, st[n] ?? {}, obs); console.log(`  ${n.padEnd(20)} ${r.action ?? '-'}  ${r.why ?? ''}`); }
    return;
  }
  if (cmd === 'watch') return void await watch({ fleet, dry: argv.includes('--dry'), everyMs: Number(flag('--every-ms')) || 15_000, once: argv.includes('--once') });
  if (cmd === 'fire' || cmd === 'stand-down') {
    const t = await loadTripwire(name), log = eventLog(fleet, { dry: argv.includes('--dry') });
    const states = readState(fleet);
    if (cmd === 'fire') states[name] = await trip(name, t, states[name] ?? {}, { fleet, dry: argv.includes('--dry'), why: `by hand: ${flag('--why') ?? 'no reason given'}`, log });
    else {
      if (!states[name]?.active) throw new Error(`${name} is not tripped; to take ${t.then.posture} off anyway: node tools/m59-posture.mjs release ${t.then.posture} --fleet ${fleet}`);
      const all = { ...(await armed(fleet, log)).tripwires, [name]: t };
      states[name] = await standDown(name, t, states[name], { fleet, dry: argv.includes('--dry'), why: 'by hand', log, states, tripwires: all });
    }
    if (!argv.includes('--dry')) writeState(fleet, states);
    return;
  }
  throw new Error('usage: m59-tripwire.mjs list | check|try <tripwire> | look|watch|status --fleet <name> | fire|stand-down <tripwire> --fleet <name>');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
}
