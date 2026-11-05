#!/usr/bin/env node
// THE REAGENT AUTOBALANCER, AT A KEYBOARD: see every loop, tune one by hand, or run one as a supervisor.
//
//   node tools/m59-autobalance.mjs status [--fleet prod] [--json]       every loop: plan inputs, learned state, last lap
//   node tools/m59-autobalance.mjs plan <Character> --agent t21 --fleet prod   plan the next lap from the live character
//   node tools/m59-autobalance.mjs set <Character> <key> <value> --by <who> --why "<reason>"
//   node tools/m59-autobalance.mjs clear <Character> <key> --by <who> --why "<reason>"
//   node tools/m59-autobalance.mjs reset <Character> [--mode practice]  forget what the learner learned (kept as .bak)
//   node tools/m59-autobalance.mjs run <Character> --agent t21 --fleet prod     the supervisor (pid, stop file, log)
//   node tools/m59-autobalance.mjs stop <Character> --fleet prod
//
// Operator, 2026-11-04: "runnable and hand-tunable ... show every running loop's current plan, learned state, last
// discrepancy and trigger, and let a person tweak any single loop's knobs by hand ... with every hand edit recorded with
// who/when/why and honoured over the learner until cleared." The maths is all in m59-reagent-autobalance.mjs; this file
// only reads, writes the orders file, and drives a body.
//
// KEYS for set/clear: any loop key (mode, practice, maintain, kills_per_minute, trigger, drop_priority, cancel_on_empty,
// vigor, room, hunt, loot_only, deposit, hall, full_percent, farm, margin, max_lap_minutes, driver ...) and the per-item
// forms `pinned.<item>`, `multipliers.<item>`, `durations.<spell>`. A list value is comma-separated; anything else is read
// as JSON when it parses ("true", "1.5", "{...}") and as a string otherwise. An edit that leaves the loop with a problem
// is still written and the problem is printed -- a refusal here would only make the person edit the file by hand.
//
// THE SUPERVISOR (`run`) is the generalised scooter-cave loop (prod substrate/scratch/scooter-cave.mjs): farm orders from the
// loop's `farm` (autopilot args) with the practice list laid in; every 60 s the pack is read and the lap observed; at the
// loop's trigger it banks in `hall` -- deposit every planned reagent and every `deposit` item by id, withdraw the plan's
// totals (planned + PvP reserve, named in the log), record the lap, walk back to `room`, and restore the farm orders.
// Nothing is sent while the character is piloted. Under trigger `reagents` the farm orders carry overfarm with
// `avoid: drop_priority` and overfarm_percent 400, so the pack sifts rather than forcing a trip. `cancel_on_empty` stops the
// supervisor when the reagents run out. It talks only to the broker named by --broker and refuses one holding another fleet.
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as ab from './m59-reagent-autobalance.mjs';
import { readReserve, reserveFile, resolveReserve, reagentKey } from './m59-reagent-reserve.mjs';
import { loadSpawns } from './m59-spawns.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const LIST_KEYS = new Set(['practice', 'maintain', 'hunt', 'loot_only', 'drop_priority', 'deposit']);

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v == null || v.startsWith('--')) out[k] = true; else { out[k] = v; i++; } }
    else out._.push(a);
  }
  return out;
}
export function parseValue(key, raw) {
  const head = String(key).split('.')[0];
  if (LIST_KEYS.has(head)) return String(raw).split(',').map(s => s.trim()).filter(Boolean);
  try { return JSON.parse(raw); } catch { return String(raw); }
}
const fleetOf = a => a.fleet ?? process.env.M59_FLEET ?? (() => { try { return readFileSync(join(REPO, 'substrate', 'fleet-default'), 'utf8').trim(); } catch { return 'default'; } })();
export const runFiles = (fleet, character) => {
  const d = ab.learnedDir(fleet), s = String(character).replace(/[^A-Za-z0-9_'-]/g, '_');
  return { dir: d, pid: join(d, `run-${s}.pid`), stop: join(d, `run-${s}.stop`), log: join(d, `run-${s}.log`) };
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ------------------------------------------------------------------------------------------- status
export function statusRows(fleet) {
  const file = ab.ordersFile(fleet);
  const book = ab.readOrders(file);
  const rows = [];
  for (const [character, raw] of Object.entries(book?.loops ?? {})) {
    const problems = [];
    const loop = ab.normalizeLoop(raw, problems);
    const learned = ab.readLearned(ab.learnedFile(fleet, character));
    const L = loop ? learned.state?.loops?.[loop.mode] ?? null : null;
    const rf = runFiles(fleet, character);
    const pid = existsSync(rf.pid) ? Number(readFileSync(rf.pid, 'utf8')) : null;
    rows.push({ character, enabled: !!loop, driver: loop?.driver ?? null, mode: loop?.mode ?? null, trigger: loop?.trigger ?? null,
      cancel_on_empty: loop?.cancel_on_empty ?? null, kills_per_minute: loop?.kills_per_minute ?? null,
      spells: loop ? (loop.mode === 'practice' ? loop.practice : loop.maintain) : [], pinned: loop?.pinned ?? {}, multipliers: loop?.multipliers ?? {},
      learned: L ? { laps_seen: L.laps_seen ?? 0, pack_minutes: L.pack_minutes ?? null, use_per_minute: L.use_per_minute ?? {} } : null,
      last_lap: L?.last ? { ended_at: new Date(L.last.ended_at).toISOString(), minutes: L.last.minutes, ended_by: L.last.ended_by,
                            discrepancy: L.last.discrepancy } : null,
      supervisor: pid ? { pid, alive: alive(pid) } : null,
      last_edit: loop?.edits?.at?.(-1) ?? null, problems: [...problems, ...(learned.error ? [learned.error] : [])] });
  }
  return { file, error: ab.ordersError(file), couriers: Object.keys(book?.couriers ?? {}), rows };
}

// ------------------------------------------------------------------------------------------- the broker
export async function rpc(broker, name, args = {}, timeoutMs = 60_000) {
  const r = await fetch(broker, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const j = await r.json();
  if (j.error || j.result?.isError) throw new Error(j.error?.message ?? j.result?.content?.[0]?.text ?? 'broker error');
  const t = j.result?.content?.[0]?.text;
  try { return JSON.parse(t); } catch { return t; }
}
async function assertFleet(broker, fleet) {
  const h = await fetch(new URL('/health', broker), { signal: AbortSignal.timeout(10_000) }).then(r => r.json());
  if (fleet && h.fleet !== fleet) throw new Error(`the broker at ${broker} is holding "${h.fleet}", not "${fleet}" -- refusing`);
}

/** Everything planLap needs, read live. */
export async function livePlan({ broker, fleet, agent, character, loop, learned }) {
  const s = await rpc(broker, 'status', { agent });
  const inv = await rpc(broker, 'inventory', { agent });
  const items = (inv?.items ?? []).map(i => ({ name: i.name, amount: i.amount > 0 ? i.amount : 1, id: i.id }));
  const reserve = resolveReserve(readReserve(reserveFile(fleet)), { agent, character });
  const known = (s?.spells ?? []).map(x => x.name);
  const cap = s?.carry?.known ? { weight_max: s.carry.weight_max, bulk_max: s.carry.bulk_max } : null;
  const plan = ab.planLap({ loop, known, mana: { max: s?.vitals?.mana?.max ?? s?.mana?.max }, mysticism: s?.attributes?.mysticism?.value ?? 25,
    reserve, capacity: cap, startLoad: learned?.start_load ?? s?.carry?.load ?? { weight: 0, bulk: 0 }, held: ab.countsOf(items), learned,
    spawns: loop.room != null && !loop.loot_per_kill ? loadSpawns(join(REPO, 'substrate', 'm59-spawns.json')) : null });
  return { plan, items, status: s };
}

// ------------------------------------------------------------------------------------------- the supervisor
// THE PRACTICE LIST ROTATES (Scooter, 2026-11-04): the keeper's desk practice (m59-deskpractice.mjs choosePractice) casts the
// FIRST affordable spell in list order, and a character that only ever regains one cast's worth of mana practises the head
// of the list and nothing else -- in the guild hall, haste and super strength went 1.5 h uncast behind resist poison. The
// supervisor re-pushes the list rotated by `turn` every ROTATE_MS, so each spell leads in turn and the lap's reagent use is
// the whole list's, not one spell's.
export const ROTATE_MS = 5 * 60_000;
export const rotated = (list, turn = 0) => { const k = list.length ? ((turn % list.length) + list.length) % list.length : 0; return list.slice(k).concat(list.slice(0, k)); };
export function farmArgs(loop, why, { turn = 0 } = {}) {
  const args = { ...(loop.farm ?? {}), mode: loop.farm?.mode ?? 'farm' };
  if (loop.mode === 'practice' && loop.practice.length)
    args.practice_spells = { enabled: true, rooms: loop.room != null ? [loop.room] : [], spells: rotated(loop.practice, turn).map(name => ({ name, target: 'self' })),
                             mana_floor: 0, reserve_casts: 0, rest_seconds: 60, refused_ms: 60_000, ...(loop.farm?.practice_spells ?? {}) };
  if (loop.trigger === 'reagents')
    args.overfarm = { enabled: true, overfarm_percent: 400, avoid: loop.drop_priority, ...(loop.farm?.overfarm ?? {}) };
  if (loop.trigger !== 'pack' || loop.driver === 'script') args.town_trips = false;
  return { ...args, why };
}

async function supervise({ character, agent, fleet, broker }) {
  const rf = runFiles(fleet, character);
  mkdirSync(rf.dir, { recursive: true });
  if (existsSync(rf.pid) && alive(Number(readFileSync(rf.pid, 'utf8')))) throw new Error(`a supervisor for ${character} is already running (pid ${readFileSync(rf.pid, 'utf8')})`);
  if (existsSync(rf.stop)) rmSync(rf.stop);
  writeFileSync(rf.pid, String(process.pid));
  const log = m => appendFileSync(rf.log, `${new Date().toISOString()} ${m}\n`);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const call = (n, a, t) => rpc(broker, n, { agent, ...a }, t);
  const orders = () => ab.loopFor(ab.readOrders(ab.ordersFile(fleet)), { character, agent });
  const lfile = ab.learnedFile(fleet, character);
  const repl = line => spawnSync(process.execPath, [join(HERE, 'm59-fleet-repl.mjs'), '--fleet', fleet], { cwd: REPO, input: line + '\n',
    encoding: 'utf8', env: { ...process.env, M59_FLEET: fleet }, timeout: 40 * 60_000, maxBuffer: 64 << 20 }).stdout ?? '';
  const roomOf = async () => Number((await call('look', {}, 30_000).catch(() => null))?.room?.num);
  const walk = async to => {
    for (let i = 0; i < 3; i++) {
      repl(`go-to agents=${agent} room=${to}`);
      for (let k = 0; k < 4; k++) { if (await roomOf() === to) return true; await sleep(5000); }
    }
    return false;
  };
  const row = async () => (await rpc(broker, 'fleet', {}, 60_000).catch(() => null))?.fleet?.find(x => x.agent === agent) ?? null;
  const ap = a => rpc(broker, 'autopilot', { agent, action: 'start', ...a }, 60_000).catch(e => ({ error: e.message }));
  /** Planned totals not in the pack now: { item: missing } (exact names, as reagentKey folds them). */
  const shortfall = async totals => {
    const have = ab.countsOf(((await call('inventory', {}, 60_000).catch(() => null))?.items ?? []).map(i => ({ name: i.name, amount: i.amount > 0 ? i.amount : 1 })));
    return Object.fromEntries(Object.entries(totals ?? {}).map(([i, t]) => [i, t - (Number(have[i]) || 0)]).filter(([, n]) => n > 0));
  };

  let { loop, problems } = orders();
  if (!loop) throw new Error(`no autobalance loop for ${character} in ${ab.ordersFile(fleet)}`);
  if (problems.length) log(`orders problems: ${problems.join('; ')}`);
  if (loop.hall == null || loop.room == null) throw new Error('the supervisor needs the loop\'s hall and room');
  log(`up: ${character} (${agent}) ${loop.mode} ${(loop.mode === 'practice' ? loop.practice : loop.maintain).join('/')}, trigger ${loop.trigger}, bank in ${loop.hall}`);
  let lap = null, turn = 0, rotatedAt = Date.now();

  async function bankTrip(verdict) {
    log(`lap over (${verdict.by}): ${verdict.why} -> bank trip to ${loop.hall}`);
    const r = await row();
    const fullness = r?.pack?.percent != null ? r.pack.percent / 100 : null;
    const items0 = ((await call('inventory', {}, 60_000).catch(() => null))?.items ?? []).map(i => ({ name: i.name, amount: i.amount > 0 ? i.amount : 1 }));
    await ap({ mode: 'survive', farm_strategy: null, confine_rooms: null, assigned_room: loop.hall, town_trips: false, practice_spells: null, why: 'autobalance: bank trip' });
    if (!await walk(loop.hall)) { log(`could not reach ${loop.hall}; back to the farm, lap NOT recorded`); await walk(loop.room); await ap(farmArgs(loop, 'autobalance: back to farming')); return; }
    const { state } = ab.readLearned(lfile);
    state.loops ??= {};
    if (lap?.plan) {
      const res = ab.recordLap({ lap, end: items0, endedAt: Date.now(), endedBy: verdict.by, fullnessEnd: fullness, learned: state.loops[loop.mode] ?? null,
                                 sellAtLoad: (loop.full_percent ?? 90) / 100 });
      state.loops[loop.mode] = res.learned;
      log(`lap: ${res.discrepancy?.verdict} | per item ${JSON.stringify(res.per_item)}`);
    }
    // Deposit by ID, exact names (hall_withdraw's deposit matches substrings: "mushroom" would take red mushrooms too).
    const planNow = (await livePlan({ broker, fleet, agent, character, loop, learned: state.loops[loop.mode] ?? null })).plan;
    const keys = new Set([...Object.keys(planNow.wants ?? {}), ...loop.deposit.map(reagentKey)]);
    const inv = (await call('inventory', {}, 60_000).catch(() => null))?.items ?? [];
    const ids = inv.filter(i => keys.has(reagentKey(i.name))).map(i => `id:${i.id}`);
    const dep = ids.length ? await call('hall_withdraw', { wants: [], deposit: ids }, 600_000).catch(e => ({ error: e.message })) : { deposited: 'nothing' };
    log(`deposited: ${JSON.stringify(dep?.deposited ?? dep?.error ?? dep).slice(0, 220)}`);
    if (planNow.ok) {
      const take = await call('hall_withdraw', { wants: Object.entries(planNow.totals).map(([item, amount]) => ({ item, amount })) }, 600_000).catch(e => ({ error: e.message }));
      log(`withdrew: ${JSON.stringify(take?.took ?? take?.error ?? take).slice(0, 220)}${take?.short && Object.keys(take.short).length ? ' short ' + JSON.stringify(take.short) : ''}`);
      // THE TOWN LAP: what the chest could not supply is BOUGHT at the loop's shop for that item (operator 2026-11-05: "buy
      // mushrooms at Joguer's herb shop"), then the body walks back to the hall so the trip resumes from one place. A
      // purchase is the buy fleetscript (find the seller, buy, verify by count); a refusal or a thin purse is logged and
      // the lap goes out with what it has -- the learner sees the shortfall either way.
      const shortNow = await shortfall(planNow.totals);
      for (const [item, need] of Object.entries(shortNow)) {
        const shop = loop.shops?.[item];
        if (!shop || need <= 0) continue;
        const purse = Number((await row())?.purse) || 0;
        const fund = shop.withdraw && purse < shop.withdraw ? ` withdraw=${shop.withdraw - purse} bank=${shop.bank}` : '';
        const out = repl(`buy agents=${agent} seller=${encodeURIComponent(shop.seller)} item=${encodeURIComponent(item)} amount=${need}${shop.room ? ` room=${shop.room}` : ''}${fund} back=${loop.hall}`);
        if (fund) log(`town lap: purse ${purse} under ${shop.withdraw}: withdrawing ${shop.withdraw - purse} at ${shop.bank} first`);
        const done = /buy \(\w+\): 1\/1 completed/.test(out);
        log(`town lap: ${item} short ${need} -> bought at ${shop.seller}: ${done ? 'ok' : 'NOT completed ' + (out.split('\n').filter(l => /REFUS|failed|cannot|afford/i.test(l)).pop() ?? '').slice(0, 160)}`);
      }
      if (Object.keys(shortNow).some(i => loop.shops?.[i])) { const still = await shortfall(planNow.totals); if (Object.keys(still).length) log(`still short after the town lap: ${JSON.stringify(still)}`); }
      log(`plan (${planNow.lap_source} lap ${planNow.lapMinutes} min): ${planNow.lines.join(' | ')}`);
      for (const u of planNow.unplannable ?? []) log(`unplannable ${u.spell}: ${u.why}`);
    } else log(`no plan: ${planNow.why}`);
    if (lap?.plan || state.loops[loop.mode]) ab.writeLearned(lfile, state);
    await ap({ assigned_room: loop.room, why: 'autobalance: back to the farm' });
    await walk(loop.room);
    const after = ((await call('inventory', {}, 60_000).catch(() => null))?.items ?? []).map(i => ({ name: i.name, amount: i.amount > 0 ? i.amount : 1 }));
    const r2 = await row();
    lap = ab.startLap({ plan: planNow, pack: after, fullness: r2?.pack?.percent != null ? r2.pack.percent / 100 : null });
    const o = await ap(farmArgs(loop, 'autobalance: farming'));
    log(`back in ${await roomOf()}, farm orders ${o?.error ?? 'ok'}`);
  }

  while (!existsSync(rf.stop)) {
    ({ loop } = orders());
    if (!loop) { log('the loop was removed from the orders: stopping'); break; }
    const r = await row();
    if (r && !r.piloted && r.health) {
      const items = ((await call('inventory', {}, 60_000).catch(() => null))?.items ?? []).map(i => ({ name: i.name, amount: i.amount > 0 ? i.amount : 1 }));
      const fullness = r.pack?.percent != null ? r.pack.percent / 100 : null;
      if (!lap) {
        const { state } = ab.readLearned(lfile);
        lap = ab.startLap({ plan: (await livePlan({ broker, fleet, agent, character, loop, learned: state.loops?.[loop.mode] ?? null })).plan, pack: items, fullness });
        log(`first lap opened from the pack as it stands`);
        const o = await ap(farmArgs(loop, 'autobalance: farming')); if (o?.error) log(`orders: ${o.error}`);
      } else ab.observeLap(lap, { pack: items, fullness });
      if (loop.mode === 'practice' && loop.practice.length > 1 && Date.now() - rotatedAt >= ROTATE_MS) {
        rotatedAt = Date.now(); turn++;
        const o = await ap({ practice_spells: farmArgs(loop, '', { turn }).practice_spells, why: `autobalance: practice rotation (${rotated(loop.practice, turn)[0]} first)` });
        if (o?.error) log(`rotation: ${o.error}`);
      }
      const v = ab.lapVerdict({ loop, lap, fullness });
      if (v.cancel) { log(`CANCELLED: ${v.why}`); break; }
      if (v.end) await bankTrip(v);
    }
    for (let i = 0; i < 60 && !existsSync(rf.stop); i++) await sleep(1000);
  }
  log('supervisor exits');
  try { rmSync(rf.pid); } catch {}
}

// ------------------------------------------------------------------------------------------- main
async function main(argv) {
  const a = parseArgs(argv);
  const [cmd, character, key, value] = a._;
  const fleet = fleetOf(a);
  const broker = a.broker ?? 'http://127.0.0.1:8901';
  const file = ab.ordersFile(fleet);
  if (!cmd || cmd === 'status') {
    const st = statusRows(fleet);
    if (a.json) return console.log(JSON.stringify(st, null, 1));
    console.log(`orders: ${st.file}${st.error ? `  !! ${st.error}` : ''}${st.rows.length ? '' : '  (no loops: nothing is autobalanced)'}`);
    for (const r of st.rows) {
      console.log(`\n${r.character}  ${r.enabled ? `${r.driver} ${r.mode} [${r.spells.join(', ')}] trigger=${r.trigger}${r.cancel_on_empty ? ' cancel_on_empty' : ''} kills/min=${r.kills_per_minute}` : 'DISABLED'}`);
      if (r.supervisor) console.log(`  supervisor pid ${r.supervisor.pid} ${r.supervisor.alive ? 'running' : 'NOT running (stale pid file)'}`);
      if (Object.keys(r.pinned).length || Object.keys(r.multipliers).length) console.log(`  by hand: pinned ${JSON.stringify(r.pinned)} multipliers ${JSON.stringify(r.multipliers)}`);
      if (r.learned) console.log(`  learned: ${r.learned.laps_seen} laps, pack ${r.learned.pack_minutes ?? '?'} min, use/min ${JSON.stringify(r.learned.use_per_minute)}`);
      if (r.last_lap) console.log(`  last lap ${r.last_lap.ended_at}: ${r.last_lap.minutes} min, ended by ${r.last_lap.ended_by}; ${r.last_lap.discrepancy?.verdict} (${r.last_lap.discrepancy?.minutes} min)`);
      if (r.last_edit) console.log(`  last edit ${r.last_edit.at} by ${r.last_edit.by}: ${r.last_edit.key} = ${JSON.stringify(r.last_edit.value)}${r.last_edit.why ? ` (${r.last_edit.why})` : ''}`);
      for (const p of r.problems) console.log(`  problem: ${p}`);
    }
    if (st.couriers.length) console.log(`\ncourier balance on: ${st.couriers.join(', ')}`);
    return;
  }
  if (!character) throw new Error(`${cmd} needs a character name`);
  if (cmd === 'set' || cmd === 'clear') {
    if (!key) throw new Error(`${cmd} needs a key`);
    if (ab.ordersError(file) || (existsSync(file) && ab.readOrders(file) == null)) throw new Error(`${file} does not parse; fix it by hand first`);
    const book = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { format: 'm59-reagent-autobalance/1', loops: {} };
    const { problems } = ab.editLoop(book, character, { key, value: cmd === 'set' ? parseValue(key, value) : null, clear: cmd === 'clear',
      by: a.by ?? process.env.USERNAME ?? 'operator', why: a.why ?? null });
    ab.writeOrders(file, book);
    console.log(`${cmd} ${character} ${key}${cmd === 'set' ? ` = ${JSON.stringify(parseValue(key, value))}` : ''} -> ${file}`);
    for (const p of problems) console.log(`  problem: ${p}`);
    return;
  }
  if (cmd === 'reset') {
    const lf = ab.learnedFile(fleet, character);
    if (!existsSync(lf)) return console.log('nothing learned yet');
    copyFileSync(lf, `${lf}.${Date.now()}.bak`);
    const { state } = ab.readLearned(lf);
    if (a.mode) delete state.loops?.[a.mode]; else state.loops = {};
    ab.writeLearned(lf, state);
    return console.log(`learned state for ${character}${a.mode ? ` (${a.mode})` : ''} cleared; backup beside it`);
  }
  if (cmd === 'stop') { const rf = runFiles(fleet, character); mkdirSync(rf.dir, { recursive: true }); writeFileSync(rf.stop, 'stop'); return console.log(`stop file written: ${rf.stop}`); }
  const agent = a.agent;
  if (!agent) throw new Error(`${cmd} needs --agent <slot>`);
  await assertFleet(broker, fleet);
  const { loop, problems } = ab.loopFor(ab.readOrders(file), { character, agent });
  if (!loop) throw new Error(`no autobalance loop for ${character} in ${file}`);
  if (cmd === 'plan') {
    const learned = ab.readLearned(ab.learnedFile(fleet, character)).state?.loops?.[loop.mode] ?? null;
    const { plan } = await livePlan({ broker, fleet, agent, character, loop, learned });
    if (a.json) return console.log(JSON.stringify({ plan, problems }, null, 1));
    for (const p of problems) console.log(`problem: ${p}`);
    if (!plan.ok) return console.log(`no plan: ${plan.why}`);
    console.log(`${character}: ${plan.mode}, ${plan.lap_source} lap ${plan.lapMinutes} min, trigger ${plan.trigger}`);
    for (const l of plan.lines) console.log(`  ${l}`);
    for (const u of plan.unplannable) console.log(`  unplannable ${u.spell}: ${u.why}`);
    for (const w of plan.why) console.log(`  - ${w}`);
    return;
  }
  if (cmd === 'run') return supervise({ character, agent, fleet, broker });
  throw new Error(`unknown command ${cmd}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1); });
