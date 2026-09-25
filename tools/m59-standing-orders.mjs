#!/usr/bin/env node
// STANDING ORDERS: ONE-TIME TASKS A CHARACTER DOES ON ITS NEXT TOWN TRIP.
//
//   node tools/m59-standing-orders.mjs                 what is ordered, and where each character is
//   node tools/m59-standing-orders.mjs watch --fleet prod
//                                                     run the teacher leg for every funded order
//
// The operator's order of 2026-09-24: every character who can learn Parry buys it from Rook
// (Cor Noth, room 154, 4,000 shillings) at its next town stop, paying from the guild chest if
// its purse is short. Written as a general mechanism because "at your next town stop, do X"
// is the shape of a lot of operator orders, and doing each by hand means pulling characters
// off their farm in the middle of a lap.
//
// TWO HALVES, BECAUSE THEY BELONG TO TWO DIFFERENT OWNERS.
//
//   FUNDING is the keeper's, on the town trip itself: a step after selling and banking tops
//   the purse up from the guild's chests (`withdrawFromStockpile`), and the bank step keeps
//   the price back rather than depositing it (`standingOrderReserve`). A character that rode
//   the chalice home is already standing beside the chests.
//
//   THE TEACHER LEG is the `learn-skill` FleetScript's, run by `watch` once the character has
//   finished that town trip: it walks to the teacher, buys, VERIFIES against the ability list
//   (a silent merchant is what success looks like for a skill, and once it was also what a
//   charge-for-nothing looked like), and walks home. Re-implementing that inside the keeper
//   would be a second copy of the one purchase path in this repository that is known to be
//   able to take money for nothing.
//
// THE ORDERS FILE IS PRIVATE (`substrate/town-orders.json`, gitignored): it names characters.
//   { "orders": [ { "id": "parry-2026-09-24", "characters": ["Kermit", ...],
//                   "learn": "parry", "teacher": "Rook", "teacher_room": 154, "price": 4000 } ] }
//
// Per-character progress lives in `substrate/town-orders-state/<character>.json`, one file per
// character so no two keeper processes ever write the same file.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ORDERS_FILE = join(HERE, '..', 'substrate', 'town-orders.json');
export const STATE_DIR = join(HERE, '..', 'substrate', 'town-orders-state');

const slug = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

let cache = { mtime: -1, orders: [] };
/** Every order in the file, re-read only when it changes. A missing file is no orders. */
export function loadOrders(file = ORDERS_FILE) {
  try {
    const m = statSync(file).mtimeMs;
    if (m !== cache.mtime) {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      cache = { mtime: m, orders: Array.isArray(j.orders) ? j.orders.filter(validOrder) : [] };
    }
    return cache.orders;
  } catch { return []; }
}

// ONE SKILL OR SEVERAL FROM THE SAME TEACHER. `learn` may be a list, and `price` is then PER
// SKILL — the operator's order of 2026-09-25 bought all three Weaponcraft 3 skills from Rook
// in one visit, and three orders would have been three round trips across the world.
export const orderSkills = (o) => [].concat(o?.learn ?? []).map(String).filter(Boolean);
export const orderPrice = (o) => (Number(o?.price) || 0) * orderSkills(o).length;

export const validOrder = (o) => o && o.id && Array.isArray(o.characters) && orderSkills(o).length > 0
  && o.teacher && Number.isInteger(o.teacher_room) && Number(o.price) > 0;

export function readState(character, dir = STATE_DIR) {
  try { return JSON.parse(readFileSync(join(dir, slug(character) + '.json'), 'utf8')); }
  catch { return {}; }
}

export function writeState(character, id, patch, dir = STATE_DIR) {
  mkdirSync(dir, { recursive: true });
  const state = readState(character, dir);
  state[id] = { ...(state[id] ?? {}), ...patch, at: Date.now() };
  const path = join(dir, slug(character) + '.json');
  writeFileSync(path + '.tmp', JSON.stringify(state, null, 1));
  renameSync(path + '.tmp', path);
  return state[id];
}

/** The first order for this character that is not finished. `done` and `failed` are final. */
export function pendingOrderFor(character, { orders = loadOrders(), dir = STATE_DIR } = {}) {
  const state = readState(character, dir);
  for (const o of orders) {
    if (!o.characters.some(c => same(c, character))) continue;
    const st = state[o.id]?.status;
    if (st === 'done' || st === 'failed') continue;
    return { order: o, state: state[o.id] ?? null };
  }
  return null;
}

// ------------------------------------------------------------------------------- cli
if (process.argv[1]?.endsWith('m59-standing-orders.mjs')) {
  const argv = process.argv.slice(2);
  const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const fleet = flag('fleet', process.env.M59_FLEET || 'prod');
  const orders = loadOrders();
  const roster = (() => {
    try { return JSON.parse(readFileSync(join(HERE, '..', 'substrate', 'fleets', `${fleet}.json`), 'utf8')); }
    catch { return {}; }
  })();
  const agentOf = (character) => Object.entries(roster)
    .find(([, v]) => same(v?.credentials?.character, character))?.[0] ?? null;
  const homeOf = (agent) => Number(roster[agent]?.autopilot?.policy?.assignedRoom) || 38;

  if (argv[0] !== 'watch') {
    if (!orders.length) { console.log(`no orders in ${ORDERS_FILE}`); process.exit(0); }
    for (const o of orders) {
      console.log(`\n${o.id}: learn ${orderSkills(o).map(x => `"${x}"`).join(', ')} from ${o.teacher} (${o.teacher_room}) for ${o.price} each`);
      for (const c of o.characters) {
        const st = readState(c)[o.id];
        console.log(`  ${c.padEnd(24)} ${agentOf(c) ?? '?'.padEnd(4)}  ${st?.status ?? 'waiting for a town trip'}` +
                    (st?.why ? `  — ${st.why}` : ''));
      }
    }
    process.exit(0);
  }

  // WATCH. One teacher leg at a time — fleetScript takes one lock per fleet — for any order
  // that is FUNDED and whose character has finished the town trip it was funded on.
  const { spawnSync } = await import('node:child_process');
  const ledgerDir = join(HERE, '..', 'substrate', 'history', fleet);
  const tripDoneSince = (character, since) => {
    const day = new Date().toISOString().slice(0, 10);
    const files = [`fleet-${day}.jsonl`, `fleet-${new Date(Date.now() - 86400e3).toISOString().slice(0, 10)}.jsonl`];
    for (const f of files) {
      const p = join(ledgerDir, f);
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, 'utf8').split('\n').reverse()) {
        if (!line.includes('town_trip_completed') || !line.includes(character)) continue;
        try { const r = JSON.parse(line); if (same(r.character, character) && r.t >= since) return true; } catch {}
      }
    }
    return false;
  };
  const untilMs = Date.now() + Number(flag('hours', 24)) * 3600e3;
  console.log(`watching ${orders.length} order(s) for fleet ${fleet} until ${new Date(untilMs).toISOString()}`);
  while (Date.now() < untilMs) {
    let pending = 0;
    for (const o of loadOrders()) for (const c of o.characters) {
      const st = readState(c)[o.id];
      if (st?.status === 'done' || st?.status === 'failed') continue;
      pending++;
      if (st?.status !== 'funded' || !tripDoneSince(c, st.at - 1)) continue;
      const agent = agentOf(c);
      if (!agent) { writeState(c, o.id, { status: 'failed', why: 'not on the roster' }); continue; }
      // SEVERAL SKILLS, ONE VISIT: every leg but the last names the teacher's own room as
      // "home", so the character stays at the counter and the walk back happens once.
      const learned = new Set((st.learned ?? []).map(x => x.toLowerCase()));
      const todo = orderSkills(o).filter(x => !learned.has(x.toLowerCase()));
      let carrying = Number(st.purse ?? orderPrice(o));
      for (const [i, skill] of todo.entries()) {
        const last = i === todo.length - 1;
        console.log(`${new Date().toISOString()} ${c} (${agent}): to ${o.teacher} for ${skill}`);
        const r = spawnSync(process.execPath, [join(HERE, 'm59-learn-run.mjs'), '--agent', agent,
          '--skill', skill, '--price', String(o.price), '--teacher', o.teacher,
          '--teacher-room', String(o.teacher_room),
          '--home', String(last ? homeOf(agent) : o.teacher_room),
          '--carrying', String(Math.max(0, carrying))], { encoding: 'utf8', timeout: 45 * 60_000 });
        const said = String(r.stdout ?? '').split('\n')[0];
        console.log(`  -> exit ${r.status}: ${said}`);
        if (r.status === 0) {
          learned.add(skill.toLowerCase());
          carrying = Math.max(0, carrying - Number(o.price));
          writeState(c, o.id, last ? { status: 'done', learned: [...learned], why: said }
                                    : { learned: [...learned], purse: carrying });
          continue;
        }
        if (r.status === 1)
          writeState(c, o.id, { status: 'failed', learned: [...learned],
            why: `${skill}: attempted and not verified — money may have moved; NOT retried: ` + said });
        else
          writeState(c, o.id, { status: 'funded', learned: [...learned],
            why: `${skill}: teacher leg did not start, will retry: ` + said, retries: (st.retries ?? 0) + 1 });
        break;
      }
    }
    if (!pending) { console.log('every order is finished'); break; }
    await new Promise(r => setTimeout(r, 60_000));
  }
}
