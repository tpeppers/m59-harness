#!/usr/bin/env node
// A FLEET POSTURE: ONE NAMED SET OF ORDERS, PUT ON WITH A SAVE AND TAKEN OFF FROM IT, BOTH READ BACK.
//
//   node tools/m59-posture.mjs list                                   the postures this machine has
//   node tools/m59-posture.mjs show   <posture> --fleet prod          what it would change, per character (reads only)
//   node tools/m59-posture.mjs apply  <posture> --fleet prod [--dry] [--agents t1,t2] [--why "..."]
//   node tools/m59-posture.mjs release <posture> --fleet prod [--dry]
//   node tools/m59-posture.mjs status --fleet prod                    which postures are on, since when, over whom
//
// WHY THIS EXISTS. "Lock the fleet down" is the commonest reactive order this fleet is given -- about ten
// incidents in a month, four different hand-rolled scripts -- and its undo is the commonest silent
// failure: one stand-down restored every mode as null and left the fleet in survive; another hard-coded
// what it "restored" (pvp_rooms: [38]) instead of reading what had been there; a two-hour return delay was
// accepted for all twenty-four characters and dropped by every keeper. Each was a script that pushed
// orders and believed the reply. So the rules here are about the save and the read-back, not the orders:
//
//   1. THE SAVE IS WRITTEN BEFORE ANYTHING IS PUSHED, and it holds exactly the keys the posture changes,
//      as the keeper reported them a moment before. A key the keeper did not have is saved as absent, and
//      releasing it sends null (the broker's "unset").
//   2. APPLYING A POSTURE THAT IS ALREADY ON NEVER OVERWRITES ITS SAVE. A second `apply` re-pushes the
//      orders and keeps the original "before" -- because the second save would record the lockdown as the
//      thing to go back to. `--fresh` is how to say otherwise, and it refuses while the save is unreleased.
//   3. EVERY KEY IS READ BACK, on apply and on release, and a key that does not read back is a FAILURE
//      named per character, with exit code 1. "The call returned" is not evidence.
//   4. THE JOB BOARD IS PART OF A LOCKDOWN. `pause_jobs: true` pauses every leased run (m59-jobs.mjs)
//      before the orders go, so a script holding a character cannot walk it back out; release resumes
//      what this posture paused, and nothing else.
//
// A POSTURE IS AN ORDER, SO IT IS THIS MACHINE'S: substrate/postures/<name>.mjs (gitignored) or a private
// repository's directory (substrate/posture-dirs.json). The committed shape is substrate/postures.example/.
//
//   export default {
//     name: 'lockdown-38', about: 'everyone over 30 max HP into Castle Victoria, nobody leaves',
//     who: { exclude: ['t15'], min_max_health: 30 },          // or (unit) => boolean
//     orders: unit => ({ assigned_room: 38, confine_rooms: [38, 39], town_trips: false }),   // or an object
//     pause_jobs: true,
//     read: { town_trips: 'townTrips' },                      // optional: a key whose policy name is not camelCase
//   };
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBSTRATE = join(HERE, '..', 'substrate');
export const postureDir = (env = process.env) => env.M59_POSTURE_DIR || join(SUBSTRATE, 'postures');
export const EXAMPLE_DIR = join(SUBSTRATE, 'postures.example');
export const saveDir = (fleet, env = process.env) => env.M59_POSTURE_SAVES || join(SUBSTRATE, 'posture-saves', fleet || 'default');

export function postureDirs({ env = process.env } = {}) {
  const out = [postureDir(env)];
  try { for (const d of JSON.parse(readFileSync(join(SUBSTRATE, 'posture-dirs.json'), 'utf8')).dirs ?? []) out.push(resolve(d)); } catch {}
  return out;
}
export function findPosture(name, { dirs = postureDirs(), examples = true } = {}) {
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(String(name ?? '')) || String(name).includes('..')) return null;
  for (const d of [...dirs, ...(examples ? [EXAMPLE_DIR] : [])]) {
    const f = join(d, `${name}.mjs`);
    if (existsSync(f)) return f;
  }
  return null;
}

/** snake_case order key -> the camelCase policy key the keeper reports (the broker's own convention). */
export const policyKeyOf = (k, read = {}) => read[k] ?? k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/** Equality as the broker normalises: [] and null are both "none"; numbers to 1e-9; arrays by value. */
export function sameValue(a, b) {
  const none = v => v === undefined || v === null || (Array.isArray(v) && v.length === 0);
  if (none(a) && none(b)) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Who a posture covers, from a fleet list [{ agent, character, max_health, host }]. */
export function selectUnits(posture, units, { only = null } = {}) {
  const who = posture.who ?? {};
  return units.filter(u => {
    if (u.host) return false;                                   // a menagerie host is never "the fleet"
    if (u.piloted) return false;                                // a person at the controls is not given orders
    if (only && !only.includes(u.agent)) return false;
    if (typeof who === 'function') return !!who(u);
    if (Array.isArray(who.agents) && !who.agents.includes(u.agent)) return false;
    if ((who.exclude ?? []).some(x => x === u.agent || String(x).toLowerCase() === String(u.character ?? '').toLowerCase())) return false;
    if (Number.isFinite(who.min_max_health) && !(u.max_health >= who.min_max_health)) return false;
    return true;
  });
}

export const ordersFor = (posture, unit) => (typeof posture.orders === 'function' ? posture.orders(unit) : { ...(posture.orders ?? {}) });

/**
 * The plan: per unit, the keys it changes, what the keeper has now, and what it will have. Pure, given the
 * keeper's current policy for each unit ({ agent -> policy }). The dry run prints exactly this.
 */
export function planPosture(posture, units, policies, { only = null } = {}) {
  return selectUnits(posture, units, { only }).map(u => {
    const orders = ordersFor(posture, u), pol = policies[u.agent] ?? {};
    const keys = Object.keys(orders);
    return { agent: u.agent, character: u.character ?? null, orders,
      before: Object.fromEntries(keys.map(k => { const pk = policyKeyOf(k, posture.read); return [k, pk in pol ? pol[pk] : { absent: true }]; })),
      changes: keys.filter(k => !sameValue(pol[policyKeyOf(k, posture.read)], orders[k])) };
  });
}

/** Read-back: which keys did not take. [{ key, wanted, got }] */
export function readBack(posture, orders, policy) {
  return Object.entries(orders).filter(([k, v]) => !sameValue(policy?.[policyKeyOf(k, posture.read)], v))
    .map(([k, v]) => ({ key: k, wanted: v, got: policy?.[policyKeyOf(k, posture.read)] ?? null }));
}

// A KEY THE KEEPER DID NOT REPORT BEFORE IS NOT RESTORED AS null: the broker may coerce null into a value (a
// boolean `roam: null` is false) and that would be a silent change dressed as a restore. It is left as the posture
// set it and named, so a person decides.
export const restoreOrders = before => Object.fromEntries(Object.entries(before).filter(([, v]) => !(v && typeof v === 'object' && v.absent)));
export const unrestorable = before => Object.entries(before).filter(([, v]) => v && typeof v === 'object' && v.absent).map(([k]) => k);

function saveFile(fleet, name) { return join(saveDir(fleet), `${name}.json`); }
export function readSave(fleet, name) { try { return JSON.parse(readFileSync(saveFile(fleet, name), 'utf8')); } catch { return null; } }
function writeSave(fleet, name, save) {
  mkdirSync(saveDir(fleet), { recursive: true });
  const f = saveFile(fleet, name), tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(save, null, 1));
  renameSync(tmp, f);
}

// ----------------------------------------------------------------------------------------------- live
async function broker() { return import('./m59-fleetscript.mjs'); }

async function fleetUnits(call) {
  const f = await call('fleet', {});
  const rows = Array.isArray(f) ? f : f?.agents ?? f?.fleet ?? [];
  return rows.map(r => ({ agent: r.agent ?? r.name, character: r.character ?? r.me ?? null,
    max_health: r.max_health ?? r.hp?.max ?? r.vitals?.health?.max ?? null, host: !!r.host, piloted: !!r.piloted,
    room: Number(r.room?.num ?? r.room ?? NaN) || null, in_game: r.activity !== 'NOT IN GAME' && r.in_roster !== false }));
}
async function policyOf(call, agent) {
  const st = await call('autopilot', { agent, action: 'status' });
  if (st?.error) throw new Error(`${agent}: status refused -- ${st.error}`);
  return st?.policy ?? {};
}

export async function apply(name, { fleet, dry = false, only = null, why = null, fresh = false, log = console.log } = {}) {
  const file = findPosture(name);
  if (!file) throw new Error(`no posture "${name}" in ${[...postureDirs(), EXAMPLE_DIR].join(', ')}`);
  const posture = (await import(pathToFileURL(file).href)).default;
  const { call } = await broker();
  const units = await fleetUnits(call);
  const policies = {};
  for (const u of selectUnits(posture, units, { only })) policies[u.agent] = await policyOf(call, u.agent);
  const plan = planPosture(posture, units, policies, { only });
  const prior = readSave(fleet, name);
  const reapply = prior?.active && !fresh;
  if (prior?.active && fresh) throw new Error(`${name} is on since ${prior.applied_at}; release it before --fresh`);
  log(`${name}: ${plan.length} character(s)${reapply ? ' -- ALREADY ON; re-pushing, keeping the original save' : ''}`);
  for (const p of plan) log(`  ${p.agent.padEnd(5)} ${String(p.character ?? '').padEnd(14)} ${p.changes.length ? 'changes ' + p.changes.join(', ') : 'already so'}`);
  if (dry) return { dry: true, plan };
  // 1. THE SAVE FIRST (and never over an active one's "before").
  const save = reapply ? prior : { name, fleet, active: true, applied_at: new Date().toISOString(), why, file, units: {}, paused_jobs: [] };
  for (const p of plan) save.units[p.agent] ??= { character: p.character, before: p.before };
  save.active = true; save.last_applied_at = new Date().toISOString();
  writeSave(fleet, name, save);
  // 2. THE JOB BOARD.
  if (posture.pause_jobs) {
    const r = await call('job_pause', { all: true, by: `posture:${name}`, why: why ?? `posture ${name}` }).catch(e => ({ error: e.message }));
    if (r?.error) log(`  ! job_pause: ${r.error}`);
    else { save.paused_jobs = [...new Set([...(save.paused_jobs ?? []), ...(r?.paused ?? []).map(x => x.id ?? x)])]; writeSave(fleet, name, save); }
  }
  // 3. THE ORDERS, then 4. THE READ-BACK.
  const failed = [];
  for (const p of plan) {
    const r = await call('autopilot', { agent: p.agent, action: 'start', ...p.orders, why: why ?? `posture ${name}` }).catch(e => ({ error: e.message }));
    if (r?.error) { failed.push({ agent: p.agent, error: r.error }); continue; }
    const miss = readBack(posture, p.orders, await policyOf(call, p.agent).catch(() => ({})));
    if (miss.length) failed.push({ agent: p.agent, did_not_take: miss });
  }
  save.apply_failures = failed; writeSave(fleet, name, save);
  for (const f of failed) log(`  FAILED ${f.agent}: ${f.error ?? f.did_not_take.map(m => `${m.key} wanted ${JSON.stringify(m.wanted)} got ${JSON.stringify(m.got)}`).join('; ')}`);
  log(failed.length ? `${name}: ${failed.length} character(s) did NOT take the posture` : `${name}: on, and read back on every character`);
  return { plan, failed };
}

export async function release(name, { fleet, dry = false, log = console.log } = {}) {
  const save = readSave(fleet, name);
  if (!save?.active) throw new Error(`${name} is not on for ${fleet ?? 'the unnamed fleet'} (no active save in ${saveDir(fleet)})`);
  const file = findPosture(name);
  const posture = file ? (await import(pathToFileURL(file).href)).default : { read: save.read ?? {} };
  const rows = Object.entries(save.units).map(([agent, u]) => ({ agent, character: u.character, orders: restoreOrders(u.before), unknown: unrestorable(u.before) }));
  log(`${name}: releasing ${rows.length} character(s) to what they had at ${save.applied_at}`);
  for (const r of rows) {
    log(`  ${r.agent.padEnd(5)} ${String(r.character ?? '').padEnd(14)} ${Object.entries(r.orders).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`);
    if (r.unknown.length) log(`        ! NOT RESTORED (the keeper reported no value before the posture): ${r.unknown.join(', ')}`);
  }
  if (dry) return { dry: true, rows };
  const { call } = await broker();
  const failed = [];
  for (const r of rows) {
    const res = await call('autopilot', { agent: r.agent, action: 'start', ...r.orders, why: `release posture ${name}` }).catch(e => ({ error: e.message }));
    if (res?.error) { failed.push({ agent: r.agent, error: res.error }); continue; }
    const miss = readBack(posture, r.orders, await policyOf(call, r.agent).catch(() => ({})));
    if (miss.length) failed.push({ agent: r.agent, did_not_take: miss });
  }
  if (save.paused_jobs?.length) {
    for (const id of save.paused_jobs) {
      const res = await call('job_resume', { id, by: `posture:${name}` }).catch(e => ({ error: e.message }));
      if (res?.error) log(`  ! job_resume ${id}: ${res.error}`);
    }
  }
  for (const f of failed) log(`  FAILED ${f.agent}: ${f.error ?? f.did_not_take.map(m => `${m.key} wanted ${JSON.stringify(m.wanted)} got ${JSON.stringify(m.got)}`).join('; ')}`);
  // The save stays ACTIVE while anything did not take: a release that half-worked is not released.
  if (!failed.length) { save.active = false; save.released_at = new Date().toISOString(); }
  save.release_failures = failed; writeSave(fleet, name, save);
  log(failed.length ? `${name}: ${failed.length} character(s) did NOT come back; the save is kept and still active` : `${name}: released, and read back on every character`);
  return { rows, failed };
}

export function status({ fleet } = {}) {
  let files = [];
  try { files = readdirSync(saveDir(fleet)).filter(f => f.endsWith('.json')); } catch {}
  return files.map(f => JSON.parse(readFileSync(join(saveDir(fleet), f), 'utf8')))
    .map(s => ({ name: s.name, active: !!s.active, applied_at: s.applied_at, released_at: s.released_at ?? null,
      units: Object.keys(s.units ?? {}).length, failures: (s.apply_failures ?? []).length + (s.release_failures ?? []).length }));
}

async function main(argv) {
  const [cmd = 'list', name] = argv;
  const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const fleet = flag('--fleet') ?? process.env.M59_FLEET ?? null;
  const needFleet = () => { if (!fleet) throw new Error('name the fleet: --fleet <name> (a posture never guesses which characters it is for)'); process.env.M59_FLEET = fleet; };
  if (cmd === 'list') {
    for (const d of [...postureDirs(), EXAMPLE_DIR]) {
      let fs = []; try { fs = readdirSync(d).filter(f => f.endsWith('.mjs')); } catch { continue; }
      for (const f of fs) {
        let about = ''; try { about = (await import(pathToFileURL(join(d, f)).href)).default?.about ?? ''; } catch (e) { about = `! ${e.message}`; }
        console.log(`  ${f.slice(0, -4).padEnd(24)} ${d === EXAMPLE_DIR ? '(example) ' : ''}${about}`);
      }
    }
    return;
  }
  if (cmd === 'status') { needFleet(); for (const s of status({ fleet })) console.log(`  ${s.name.padEnd(24)} ${s.active ? 'ON ' : 'off'} ${s.units} unit(s) since ${s.applied_at}${s.released_at ? ', released ' + s.released_at : ''}${s.failures ? `, ${s.failures} failure(s)` : ''}`); return; }
  needFleet();
  const only = flag('--agents')?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
  if (cmd === 'show') return void await apply(name, { fleet, dry: true, only });
  if (cmd === 'apply') { const r = await apply(name, { fleet, dry: argv.includes('--dry'), only, why: flag('--why'), fresh: argv.includes('--fresh') }); process.exitCode = r.failed?.length ? 1 : 0; return; }
  if (cmd === 'release') { const r = await release(name, { fleet, dry: argv.includes('--dry') }); process.exitCode = r.failed?.length ? 1 : 0; return; }
  throw new Error('usage: m59-posture.mjs list | show|apply|release <posture> --fleet <name> | status --fleet <name>');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
}
