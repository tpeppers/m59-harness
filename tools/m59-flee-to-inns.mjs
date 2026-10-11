#!/usr/bin/env node
// FLEE TO INNS: BRING A DROPPED FLEET UP AND PUT EVERY CHARACTER IN AN INN, FASTEST AND SAFEST FIRST.
//
//   node tools/m59-flee-to-inns.mjs --fleet prod                 # PLAN: who goes where, from the last positions on disk
//   node tools/m59-flee-to-inns.mjs --fleet prod --start --apply # start the broker fragile-first, then run it
//   node tools/m59-flee-to-inns.mjs --fleet prod --apply         # the broker is already up: just run it
//
// Operator, 2026-10-11, after the prod server dropped the whole fleet where it stood (12 of 24 inside Ukgoth):
// "draft a recovery plan of 'flee to inns from where you are' ... that can be initiated from startup ... start
// Loial and the under 30hp characters first, ... see if they are where they're expected and start the chalice
// service station". Graded on how many reach the nearest inn safely, then on time.
//
// THREE KINDS OF JOURNEY, chosen per character from where it actually logs in:
//
//   RIDERS   take the CUP. The holder (`--cup`, Loial) stands at the station (`--station`, 38, Castle Victoria)
//            and every rider drinks the Chalice of the Rain there in turn: a Rescue, landing a guild member in the
//            guild hall (`--hall` 714, Barloque) and anyone else in their HOMETOWN, which the server requires to
//            be a hometown room -- an inn (user.kod AdminGoToSafety). From the hall it is 60 s to an inn
//            (`--hall-inn` 103). One ride is ~45 s. Riders are:
//              - the fragile (max health <= `--fragile`, 30): Raphael, Zheng He -- never on a road;
//              - anyone at the station or one hop from it (`--near-station`, rooms 38 and 2);
//              - anyone in Ukgoth (599) north of `--split-row` (36): Ukgoth's north edge is a 72 s exit to 2 and
//                12 s on to 38, where its south edge is a 284 s road to the nearest inn (Cor Noth, via 578). The
//                room itself is the danger (KNOWN_TRAPS[599]), so the short way out of it wins even in a queue.
//            Order at the cup: fragile first, then lowest health first. A rider whose ride fails three times
//            walks instead -- unless fragile, who keeps waiting.
//   HOLDER   last: drinks its own cup once nobody else is coming, and lands in its own hometown inn.
//   WALKERS  everyone else: `travel` to the inn with the lowest measured p90 from the room they are in
//            (`travel_estimate`, the fleet's own journeys), Ko'catan and Raza excluded. Re-issued if a journey
//            ends anywhere but an inn, up to four times.
//
// EVERY BODY IS PUT IN `survive` THE MOMENT IT IS SEEN IN THE WORLD, with its destination as its assigned room:
// a keeper's survival rung that hands the body back mid-walk then steers it toward the inn, not back to the troll
// it was farming. Survival, mortality, identity and recovery stay with the keeper throughout -- this tool only
// ever issues `travel`, `cancel_movement`, `autopilot configure` and the cup ride. On arrival the character is
// CONFINED to its inn (a 20-health caster whose keeper is free walks into open country -- Loial, 2026-09-09).
//
// --start brings the broker up with `M59_RESUME_FIRST` = holder, then the fragile, then Ukgoth, then the rest,
// so the keepers that matter come up in the first wave of six. Run the background drivers NOWHERE until this
// finishes: a DUM director, a supervisor or a lap loop will re-send a character to its station.
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName, stateFileFor } from './m59-fleetpath.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = n => argv.includes(`--${n}`);

// Every inn in the world we can walk to. Ko'catan's (2001) needs the cave route and Raza's are on the newbie
// island: neither is a place to flee to.
export const INNS = Object.freeze({ 52: 'Familiars, Tos', 103: 'The Bhrama & Falcon, Barloque', 106: 'Brownestone Inn, Barloque',
  153: 'Cibilo Creek Inn, Cor Noth', 202: 'The Limping Toad, Marion', 370: 'Yonder Inn of Jasper' });
export const isInn = room => Object.hasOwn(INNS, Number(room)) || Number(room) === 2001;

/** What kind of journey this body takes. Pure, so it is testable. */
export function classify(b, cfg) {
  if (isInn(b.room)) return 'done';
  if (b.agent === cfg.cup) return 'holder';
  if (cfg.nearStation.includes(Number(b.room))) return 'rider';
  // THE FRAGILE RIDE ONLY FROM WHERE THE CUP IS THE SHORT WAY OUT. Zheng He (20 health) dropped on the West
  // Merchant Way, 73 s from the Limping Toad on a road rated 0; sending him to the cup would have walked him
  // through Ukgoth. Anywhere but the station or Ukgoth itself, the fragile walk to their nearest inn.
  if (Number(b.max) > 0 && Number(b.max) <= cfg.fragile) return Number(b.room) === 599 ? 'rider' : 'walker';
  if (Number(b.room) === 599 && Number.isFinite(Number(b.row)) && Number(b.row) < cfg.splitRow) return 'rider';
  return 'walker';
}
/** The next rider to hand the cup to, among those standing at the station. */
export function nextRider(waiting, cfg) {
  const frac = b => (Number(b.max) > 0 ? Number(b.hp) / Number(b.max) : 1);
  return [...waiting].sort((a, b) => {
    const fa = Number(a.max) <= cfg.fragile ? 0 : 1, fb = Number(b.max) <= cfg.fragile ? 0 : 1;
    return fa - fb || frac(a) - frac(b);
  })[0] ?? null;
}

// Run only when invoked, so the test can import the pure halves above.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
async function main() {
const FLEET = fleetName(argv);
const cfg = {
  cup: arg('cup', 'hk1'), station: Number(arg('station', 38)), hall: Number(arg('hall', 714)), hallInn: Number(arg('hall-inn', 103)),
  fragile: Number(arg('fragile', 30)), splitRow: Number(arg('split-row', 36)),
  nearStation: String(arg('near-station', '38,2')).split(',').map(Number),
  timeoutMin: Number(arg('timeout-min', 30)), http: Number(arg('http', 8901)), dashboard: Number(arg('dashboard', 8902)),
};
const CONTROL = `http://127.0.0.1:${cfg.http}/`;
const LOG = path.join(REPO, 'substrate', `flee-to-inns-${FLEET ?? 'default'}.log`);
const t0 = Date.now();
const stamp = () => `${new Date().toISOString().slice(11, 19)} +${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s`;
const say = m => { const line = `${stamp()} ${m}`; console.log(line); try { appendFileSync(LOG, line + '\n'); } catch {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(name, args = {}, ms = 60_000) {
  const r = await fetch(CONTROL, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(ms) });
  const t = (await r.json())?.result?.content?.[0]?.text ?? '';
  try { return JSON.parse(t); } catch { return { text: t }; }
}
const healthy = async () => { try { const r = await fetch(new URL('health', CONTROL), { signal: AbortSignal.timeout(4000) }); return r.ok; } catch { return false; } };

// ---------------------------------------------------------------- where everyone was when they dropped
const roster = (() => { try { return JSON.parse(readFileSync(stateFileFor(FLEET), 'utf8')); } catch { return {}; } })();
const AGENTS = Object.keys(roster).filter(a => roster[a]?.credentials?.character);   // never read further than that
const lastSeen = a => {
  const f = path.join(REPO, 'substrate', `keeper-${a}.json`);
  if (!existsSync(f)) return { agent: a };
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    const hp = j.hp ?? j.vitals?.health ?? {};
    return { agent: a, character: j.character, room: j.room?.num, roomName: j.room?.name, row: j.you?.row, col: j.you?.col, hp: hp.value, max: hp.max };
  } catch { return { agent: a }; }
};
const last = Object.fromEntries(AGENTS.map(a => [a, lastSeen(a)]));
const kindOf = Object.fromEntries(AGENTS.map(a => [a, classify(last[a], cfg)]));
const order = [...String(arg('first', '')).split(',').map(s => s.trim()).filter(Boolean), cfg.cup,
  ...AGENTS.filter(a => a !== cfg.cup && Number(last[a].max) > 0 && Number(last[a].max) <= cfg.fragile),
  ...AGENTS.filter(a => Number(last[a].room) === 599 && !(Number(last[a].max) <= cfg.fragile)),
  ...AGENTS].filter((a, i, all) => AGENTS.includes(a) && all.indexOf(a) === i);

say(`flee-to-inns: fleet ${FLEET ?? '(default)'}, ${AGENTS.length} characters; cup ${cfg.cup} at ${cfg.station}, hall ${cfg.hall} -> inn ${cfg.hallInn}`);
for (const a of order) {
  const b = last[a];
  say(`  ${a.padEnd(4)} ${String(b.character ?? '?').slice(0, 14).padEnd(14)} last ${String(b.room ?? '?').padEnd(4)} r${b.row ?? '?'}c${b.col ?? '?'} ` +
      `${b.hp ?? '?'}/${b.max ?? '?'} -> ${kindOf[a]}`);
}
if (!has('apply')) { say('PLAN ONLY (no --apply). Positions are re-read live when each character logs in.'); process.exit(0); }

// ---------------------------------------------------------------- the broker, fragile first
if (!(await healthy())) {
  if (!has('start')) { say(`no broker answers on ${cfg.http} -- pass --start to bring one up`); process.exit(2); }
  say(`starting the broker, resume order ${order.join(',')}`);
  const r = spawnSync(process.execPath, [path.join(REPO, 'tools', 'm59-service.mjs'), 'start', '--fleet', FLEET ?? '-',
    '--http', String(cfg.http), '--dashboard', String(cfg.dashboard)],
    { cwd: REPO, env: { ...process.env, M59_RESUME_FIRST: order.join(',') }, encoding: 'utf8', windowsHide: true });
  say(`  service: ${String(r.stdout || r.stderr || '').trim().split('\n').slice(-2).join(' | ')}`);
  for (let i = 0; i < 120 && !(await healthy()); i++) await sleep(1000);
  if (!(await healthy())) { say('the broker did not come up'); process.exit(2); }
}
// THE RIGHT FLEET, OR NOTHING: the same gate every /m59 command runs.
{
  const w = spawnSync(process.execPath, [path.join(REPO, 'tools', 'm59-which.mjs'), '--fleet', FLEET ?? '-', '--port', String(cfg.http)], { cwd: REPO, encoding: 'utf8', windowsHide: true });
  if (w.status !== 0) { say(`m59-which refused (exit ${w.status}): ${String(w.stdout || w.stderr).trim().split('\n').slice(-3).join(' | ')}`); process.exit(3); }
}

// ---------------------------------------------------------------- run
const st = Object.fromEntries(AGENTS.map(a => [a, { kind: null, target: null, tries: 0, rideFails: 0, done: false, startedAt: null, at: null, lastIssue: 0 }]));
const estimates = new Map();
async function nearestInn(room) {
  if (estimates.has(room)) return estimates.get(room);
  let best = null;
  for (const inn of Object.keys(INNS).map(Number)) {
    const e = await call('travel_estimate', { from: room, to: inn }).catch(() => null);
    if (e?.ms && (!best || e.ms < best.ms)) best = { inn, ms: e.ms };
  }
  estimates.set(room, best);
  return best;
}
const frac = r => { const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(r?.health ?? '')); return m ? { hp: +m[1], max: +m[2] } : { hp: null, max: null }; };
const posture = (a, room, why, confine = []) => call('autopilot', { agent: a, action: 'configure', mode: 'survive', assigned_room: room,
  confine_rooms: confine, roam: false, why: `flee-to-inns: ${why}` }).catch(() => null);
const travel = async (a, to) => { st[a].lastIssue = Date.now(); st[a].tries++; return call('travel', { agent: a, to }, 30_000).catch(() => null); };
const arrive = async (a, room) => {
  const s = st[a]; s.done = true; s.at = Date.now();
  await posture(a, room, `arrived at ${INNS[room] ?? room}`, [room]);
  say(`ARRIVED ${a} in ${room} ${INNS[room] ?? ''} after ${Math.round((s.at - (s.startedAt ?? t0)) / 1000)}s`);
};
async function begin(a, row) {
  const s = st[a];
  const live = await call('status', { agent: a }, 30_000).catch(() => null);
  const b = { agent: a, room: Number(row.room_num), row: live?.you?.row, max: frac(row).max, hp: frac(row).hp };
  s.kind = classify(b, cfg); s.startedAt = Date.now();
  say(`IN ${a} at ${b.room} r${b.row ?? '?'} ${row.health} -> ${s.kind}`);
  if (s.kind === 'done') return arrive(a, b.room);
  await call('cancel_movement', { agent: a, why: 'flee-to-inns' }).catch(() => null);
  if (s.kind === 'holder' || s.kind === 'rider') {
    await posture(a, cfg.station, s.kind === 'holder' ? 'the cup station' : 'to the cup');
    if (b.room !== cfg.station) await travel(a, cfg.station);
    return;
  }
  const best = await nearestInn(b.room);
  s.target = best?.inn ?? 153;
  await posture(a, s.target, `fleeing to ${INNS[s.target]}`);
  await travel(a, s.target);
  say(`  ${a} walking ${b.room} -> ${s.target} ${INNS[s.target]} (p90 ${Math.round((best?.ms ?? 0) / 1000)}s)`);
}

const { cupRide } = await import('./m59-inventory.mjs');
let rows = [], riding = false, holderDrank = false;
const deadline = t0 + cfg.timeoutMin * 60_000;
while (Date.now() < deadline) {
  rows = (await call('fleet', {}, 60_000).catch(() => null))?.fleet ?? rows;
  const byAgent = Object.fromEntries(rows.map(r => [r.agent, r]));
  for (const a of AGENTS) {
    const r = byAgent[a], s = st[a];
    if (!r || r.in_game === false || s.done) continue;
    if (!s.kind) { await begin(a, r); continue; }
    const room = Number(r.room_num);
    if (isInn(room)) { await arrive(a, room); continue; }
    if (s.kind === 'walker' && Date.now() - s.lastIssue > 45_000 && !/travelling|walking/i.test(String(r.activity ?? ''))) {
      if (s.tries >= 5) continue;
      say(`  ${a} not travelling at ${room} (${String(r.activity ?? '').slice(0, 40)}) -- re-issuing to ${s.target}`);
      if (room === cfg.hall) s.target = cfg.hallInn;
      await travel(a, s.target);
    }
    if ((s.kind === 'rider' || s.kind === 'holder') && room !== cfg.station && room !== cfg.hall && Date.now() - s.lastIssue > 45_000
        && !/travelling|walking/i.test(String(r.activity ?? ''))) await travel(a, cfg.station);
  }
  // THE CUP: one ride at a time, holder and rider both standing at the station.
  const holderRow = byAgent[cfg.cup];
  const holderHere = holderRow && holderRow.in_game !== false && Number(holderRow.room_num) === cfg.station;
  if (!riding && holderHere) {
    const waiting = AGENTS.filter(a => st[a].kind === 'rider' && !st[a].done && Number(byAgent[a]?.room_num) === cfg.station)
      .map(a => ({ agent: a, ...frac(byAgent[a]) }));
    const pick = nextRider(waiting, cfg);
    if (pick) {
      riding = true;
      const a = pick.agent;
      say(`CUP ${a} (${byAgent[a]?.health}) drinks at ${cfg.station}`);
      const res = await cupRide(a, cfg.cup, { hall: cfg.hall, waitMs: 60_000 }).catch(e => ({ ok: false, why: e.message }));
      await sleep(3000);
      const now = Number((await call('status', { agent: a }, 30_000).catch(() => null))?.room?.num ?? NaN);
      if (isInn(now)) await arrive(a, now);
      else if (now === cfg.hall) { st[a].kind = 'walker'; st[a].target = cfg.hallInn; await posture(a, cfg.hallInn, 'hall to inn'); await travel(a, cfg.hallInn);
        say(`  ${a} in the hall -> ${cfg.hallInn} ${INNS[cfg.hallInn]}`); }
      else {
        st[a].rideFails++;
        say(`  ${a} ride failed (${res?.why ?? 'no landing'}) -- ${st[a].rideFails} of 3`);
        if (st[a].rideFails >= 3 && !(pick.max <= cfg.fragile)) {
          const best = await nearestInn(now); st[a].kind = 'walker'; st[a].target = best?.inn ?? 153;
          await posture(a, st[a].target, 'the cup failed: walking'); await travel(a, st[a].target);
          say(`  ${a} walks instead -> ${st[a].target}`);
        }
      }
      riding = false;
    } else if (!holderDrank) {
      // NOBODY LEFT FOR THE CUP: every rider is done, walking, or not in the game at all.
      const pending = AGENTS.filter(a => a !== cfg.cup && st[a].kind === 'rider' && !st[a].done);
      const unseen = AGENTS.filter(a => a !== cfg.cup && !st[a].kind && kindOf[a] === 'rider');
      if (!pending.length && !unseen.length) {
        holderDrank = true;
        say(`CUP ${cfg.cup} drinks its own cup (last)`);
        await call('act', { agent: cfg.cup, verb: 'eat', target: 'Chalice of the Rain' }, 60_000).catch(() => null);
        for (let i = 0; i < 12; i++) { await sleep(5000); const n = Number((await call('status', { agent: cfg.cup }, 30_000).catch(() => null))?.room?.num ?? NaN); if (n !== cfg.station) break; }
      }
    }
  }
  const left = AGENTS.filter(a => !st[a].done);
  if (!left.length) break;
  await sleep(1500);
}

// ---------------------------------------------------------------- the score
const done = AGENTS.filter(a => st[a].done);
say(`DONE ${done.length} of ${AGENTS.length} in an inn; slowest ${Math.max(0, ...done.map(a => Math.round((st[a].at - (st[a].startedAt ?? t0)) / 1000)))}s, ` +
    `all in by +${Math.round((Math.max(t0, ...done.map(a => st[a].at)) - t0) / 1000)}s`);
for (const a of AGENTS.filter(a => !st[a].done)) say(`  NOT IN AN INN: ${a} (${st[a].kind ?? 'never logged in'}) at ${rows.find(r => r.agent === a)?.room_num ?? '?'}`);
say('The rejoin sweep stays on. Restart the background drivers only after reading this.');
process.exit(done.length === AGENTS.length ? 0 : 1);
}
