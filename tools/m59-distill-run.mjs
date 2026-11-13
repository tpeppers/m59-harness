#!/usr/bin/env node
// THE GOAP DISTILLER, LOOPED: observe the fleet, decide one next action per character toward its character plan,
// and — only with --apply — do it through the executors that already exist. DRY BY DEFAULT.
//
//   node tools/m59-distill-run.mjs --fleet prod --home 552                     # DRY, once: print the plan
//   node tools/m59-distill-run.mjs --fleet prod --home 552 --only practice     # just the practice pushes
//   node tools/m59-distill-run.mjs --fleet prod --home 552 --apply --once      # one pass, for real
//   node tools/m59-distill-run.mjs --fleet prod --home 552 --apply --interval 900 --exclude hk3
//
// The decisions are tools/m59-distill.mjs (pure; read its header for the priority order and the scheduler). This file
// is the loop around them and nothing else:
//
//   OBSERVE  read-only broker calls: `fleet` once (the rows carry learning, policy, pack, purse, bank, room, health,
//            piloted, committed), then per in-scope character with a plan `abilities` (spells) and `status` (karma).
//            The guild hall chests come from the chest cache (substrate/storage/chests), never from a walk.
//   DECIDE   m59-distill.mjs decide(), with this checkout's spawn index, merchant catalogue and spell catalogue.
//   ACT      --apply only, one action at a time, in-place actions first:
//              learn      the broker's own `buy_next_planned_skills` for that one agent — it re-reads the advancement
//                         numbers, keeps the burnt-purchase guard and spawns m59-learn-run.mjs with --fleet
//              practice   practice-plan's apply half: the distiller's own list pushed as `practice_spells` and read
//                         back (re-planning would restore the floor and the creature spells the distiller corrected)
//              make_space the make-space fleetscript (in place: drops only the keeper's own sale-plan rows)
//              supply     a fleetScript of one `supply` step (donor -> receiver, the donor's exact stack name, its keep
//                         floor), verified by the receiver's own count
//              hall_draw  the hall-draw fleetscript, wants=[{item, amount}] home=<home>
//              buy        the buy fleetscript, seller/room from the merchant catalogue, back=<home>
//              farm       ONLY an allow-listed source (--farm-allow): walk, `harvest`, walk home, and put the hunt /
//                         station back as they were. Everything else is a PROPOSAL, written to the ledger and printed.
//              train      always a proposal in v1.
//            Every order goes through fleetScript, so its guarantees (the run lock, liveStart's piloted/job refusal,
//            the health floor, fragileBody, the trap check) stand behind every decision here as a second net.
//   RECORD   substrate/distill-<fleet>.jsonl (gitignored): each pass's decisions, and a start and an outcome row per
//            action. The outcome rows are what the next pass's cooldowns and in-flight checks read.
//
// --fleet IS REQUIRED and never defaulted: a distiller pointed at the wrong roster sends the wrong characters on the
// roads. With --apply, `m59-which.mjs` is asked first and a mismatch or INDETERMINATE refuses the pass.
import { readFileSync, appendFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const flag = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; };
const has = name => argv.includes(`--${name}`);
const list = s => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean);

if (has('help') || has('h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).slice(0, 36).map(l => l.slice(3)).join('\n'));
  console.log(`
flags: --fleet <name> (required)  --home <room>  --away-limit <n> (1)  --exclude a,b  --only kinds
       --once | --interval <seconds>  --apply  --hall <room>  --farm-allow "creature@room[:item],..."
       --ignore-confine  --config <file.json>  --record (write the decisions of a DRY pass too)  --json
kinds: learn, practice, supply, hall_draw, farm, buy, train`);
  process.exit(0);
}

const FLEET = flag('fleet');
if (!FLEET || FLEET === '-') { console.error('--fleet <name> is required: the distiller never guesses which roster it is driving'); process.exit(2); }
process.env.M59_FLEET = FLEET;
const APPLY = has('apply');
const ONCE = has('once') || !flag('interval');
const INTERVAL_S = Math.max(60, Number(flag('interval', 600)) || 600);
const LEDGER = join(REPO, 'substrate', `distill-${FLEET}.jsonl`);

// Imported after M59_FLEET is set, so every module resolves the same fleet.
const { decide, observation, formatDecision, config: mkConfig, KINDS } = await import('./m59-distill.mjs');
const { loadSpawns } = await import('./m59-spawns.mjs');
const { loadSourcingData } = await import('./m59-sourcing-lib.mjs');
const { loadCatalogue } = await import('./m59-deskpractice.mjs');
const fs = await import('./m59-fleetscript.mjs');
const { call, fleetScript, KNOWN_TRAPS, supply, walk, harvest, verify } = fs;
const { loadFleetScripts, runNamed } = await import('./m59-fleetlib.mjs');
const { loadoutFor } = await import('./m59-loadout.mjs');
const { roomGraph } = await import('./m59-secret-travel.mjs');

// ------------------------------------------------------------------------------------------- configuration

function parseFarmAllow(s) {
  return list(s).map(t => {
    const m = /^(.+?)@(\d+)(?::(.+))?$/.exec(t);
    if (!m) throw new Error(`--farm-allow "${t}": want creature@room or creature@room:item`);
    return { creature: m[1].trim(), room: Number(m[2]), ...(m[3] ? { item: m[3].trim() } : {}) };
  });
}
const fileConfig = flag('config') ? JSON.parse(readFileSync(flag('config'), 'utf8')) : {};
const only = flag('only') ? list(flag('only')) : fileConfig.only ?? null;
for (const k of only ?? []) if (!KINDS.includes(k)) { console.error(`--only ${k}: not one of ${KINDS.join(', ')}`); process.exit(2); }
const cfg = mkConfig({
  ...fileConfig,
  home: flag('home') != null ? Number(flag('home')) : fileConfig.home,
  away_limit: flag('away-limit') != null ? Number(flag('away-limit')) : fileConfig.away_limit,
  exclude: flag('exclude') ? list(flag('exclude')) : fileConfig.exclude,
  no_hall: flag('no-hall') ? list(flag('no-hall')) : fileConfig.no_hall,
  only,
  hall_room: flag('hall') != null ? Number(flag('hall')) : fileConfig.hall_room,
  farm_allow: flag('farm-allow') ? parseFarmAllow(flag('farm-allow')) : fileConfig.farm_allow,
  respect_confine: has('ignore-confine') ? false : fileConfig.respect_confine,
  trap_rooms: [...new Set([...(fileConfig.trap_rooms ?? [599]), ...Object.keys(KNOWN_TRAPS ?? {}).map(Number)])],
});
if (APPLY && cfg.home == null) { console.error('--apply needs --home <room>: road actions start and end there'); process.exit(2); }

// ------------------------------------------------------------------------------------------- the ledger

const readLedger = () => {
  if (!existsSync(LEDGER)) return [];
  const out = [];
  for (const line of readFileSync(LEDGER, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.phase === 'start' || r.phase === 'outcome') out.push(r); } catch { /* a torn line */ }
  }
  return out;
};
const record = (row) => {
  mkdirSync(dirname(LEDGER), { recursive: true });
  appendFileSync(LEDGER, JSON.stringify({ at: Date.now(), fleet: FLEET, ...row }) + '\n');
};
const keyOf = a => a.kind === 'learn' ? a.skill : a.kind === 'practice' ? 'practice' : a.key ?? a.item ?? null;

// ------------------------------------------------------------------------------------------- observation

function readChests() {
  const dir = join(REPO, 'substrate', 'storage', 'chests');
  const out = [];
  const take = (f, roomHint) => {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      out.push({ room: j.room ?? roomHint, items: j.items ?? [], observed_at: j.observed_at ?? null });
    } catch { /* a cache being rewritten */ }
  };
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e.endsWith('.json')) take(p, null);
    else if (/^\d+$/.test(e) && statSync(p).isDirectory())
      for (const f of readdirSync(p)) if (f.endsWith('.json')) take(join(p, f), Number(e));
  }
  return out;
}

async function observe() {
  const reply = await call('fleet', {}, 120_000);
  if (!Array.isArray(reply?.fleet)) throw new Error(`the fleet list is unreadable: ${JSON.stringify(reply).slice(0, 200)}`);
  const chars = [];
  for (const row of reply.fleet) {
    const cheap = observation(row);
    const worthReading = cheap.in_game && cheap.in_roster && !cheap.piloted && !cfg.exclude.includes(cheap.agent)
      && cheap.learning?.planned?.configured;
    if (!worthReading) { chars.push(cheap); continue; }
    // Sequential, on purpose: the live fleet shares the broker and the cores.
    const ab = await call('abilities', { agent: row.agent, kind: 'spells' }, 60_000).catch(() => null);
    const st = await call('status', { agent: row.agent, brief: true }, 60_000).catch(() => null);
    let loadout = null;
    try { loadout = row.character ? loadoutFor(row.character)?.policy ?? null : null; } catch { /* no loadout */ }
    chars.push(observation(row, { spells: Array.isArray(ab?.spells) ? ab.spells : null, karma: st?.karma?.value ?? null, loadout }));
  }
  return chars;
}

// ------------------------------------------------------------------------------------------- execution

let SCRIPTS = null;
const scripts = async () => (SCRIPTS ??= (await loadFleetScripts()).scripts);
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const firstWhy = r => r?.why ?? Object.values(r?.results ?? {}).map(x => x?.why).find(Boolean) ?? null;

async function execute(a) {
  const named = async (name, params) => {
    const r = await runNamed(name, params, { scripts: await scripts(), fleetScript, onLog: say });
    return { ok: r?.ok === true, refused: r?.refused === true, why: firstWhy(r) };
  };
  switch (a.kind) {
    case 'learn': {
      const r = await call('buy_next_planned_skills', { agents: [a.agent] }, 120_000);
      const row = (r?.results ?? []).find(x => x.agent === a.agent) ?? null;
      // QUEUED IS NOT LEARNED. The broker's errand runs on; its exit is the broker's to record (the burnt-purchase
      // guard), and the next pass reads the result off the fleet row. A wrong ability queued is a mismatch to report.
      if (row?.queued && row.ability && row.ability.toLowerCase() !== String(a.skill).toLowerCase())
        return { ok: true, queued: true, why: `the broker queued ${row.ability}, not ${a.skill} (its fresh preflight chose differently)` };
      return { ok: !!row?.queued, queued: !!row?.queued, why: row?.reason ?? (row?.queued ? `errand pid ${row.pid}` : 'no reply for this agent') };
    }
    case 'practice': {
      // THE PLAN THE DISTILLER MADE, PUSHED AS IT IS. The practice-plan fleetscript would re-plan and put back what
      // the distiller corrected (a 17 floor for an enchanter, a zap at the head of an inn's list), so this is that
      // fleetscript's apply half — one `autopilot start practice_spells`, keeperLease waived as it waives it, and
      // the value read back from the keeper rather than trusted from the reply.
      let before = null;
      const names = p => (p?.spells ?? []).map(e => String(e?.name ?? e).toLowerCase()).join(',');
      const r = await fleetScript({
        name: 'distill-practice', agents: [a.agent], mode: 'errand',
        unsafe: { reason: "Writes one autopilot setting (practice_spells) and moves nobody; holding the keeper would cancel the farmer's journey for nothing.",
                  waives: ['keeperLease'] },
        steps: () => [verify(async ({ call: c }) => {
          const ap = await c('autopilot', { agent: a.agent, action: 'status' }, 60_000).catch(() => null);
          before = ap?.policy?.practiceSpells ?? null;
          const res = await c('autopilot', { agent: a.agent, action: 'start', ...(ap?.mode ? { mode: ap.mode } : {}),
            practice_spells: a.practice, why: 'distill: the next school level\'s gate spells' }, 60_000).catch(e => ({ error: e.message }));
          if (res?.error) return { ok: false, why: res.error };
          const back = await c('autopilot', { agent: a.agent, action: 'status' }, 60_000).catch(() => null);
          const live = back?.policy?.practiceSpells ?? null;
          if (names(live) === names(a.practice) && Number(live?.mana_floor ?? live?.manaFloor ?? 0) === Number(a.practice.mana_floor ?? 0)) return true;
          if (names(back?.policy_orders?.practiceSpells) === names(a.practice))
            return { ok: true, why: 'ordered, but a strategy overlay shadows it' };
          return { ok: false, why: `the keeper holds ${JSON.stringify(live).slice(0, 200)}` };
        }, 'push the practice list and read it back')],
      });
      return { ok: r?.ok === true, refused: r?.refused === true, why: firstWhy(r), before };
    }
    case 'make_space':
      return named('make-space', { agents: a.agent, bulk: a.bulk });
    case 'hall_draw':
      return named('hall-draw', { agents: a.agent, wants: JSON.stringify([{ item: a.item, amount: a.amount }]), home: a.home, holder: '' });
    case 'buy':
      return named('buy', { agents: a.agent, seller: a.merchant, item: a.item, amount: a.amount, withdraw: a.withdraw,
                            bank: a.bank, room: a.room, back: a.home });
    case 'supply': {
      const r = await fleetScript({
        name: 'distill-supply', agents: [a.agent], mode: 'errand',
        unsafe: { reason: 'A same-room hand-over moves nobody; holding the receiver would cancel its work for a trade.',
                  waives: ['keeperLease'] },
        steps: () => [supply(a.from, a.agent, a.item, { amount: a.amount, keep: a.keep, exact: true })],
      });
      return { ok: r?.ok === true, refused: r?.refused === true, why: firstWhy(r) };
    }
    case 'farm': {
      // THE STANDING ORDERS GO BACK. `harvest` sets hunt + assigned_room + farm mode and leaves them; a distiller
      // that farmed once must not leave a character's station rewritten.
      const was = {};
      const r = await fleetScript({
        name: 'distill-farm', agents: [a.agent], mode: 'errand',
        steps: () => [
          verify(async ({ call: c }) => {
            const ap = await c('autopilot', { agent: a.agent, action: 'status' }, 60_000).catch(() => null);
            Object.assign(was, { mode: ap?.mode ?? null, hunt: ap?.policy?.hunt ?? null,
                                 room: ap?.policy?.assignedRoom ?? null, roam: ap?.policy?.roam ?? null });
            return !!ap;
          }, 'read the standing orders to put back'),
          walk(a.room, { why: `farm ${a.item} off ${a.creature}` }),
          harvest({ quarry: [a.creature], want: a.item, count: a.amount, room: a.room, minutes: a.minutes }),
          { ...walk(a.home, { why: 'home' }), always: true },
          { ...verify(async ({ call: c }) => {
            if (!was.mode) return { ok: false, why: 'the standing orders were never read, so nothing is restored' };
            const back = await c('autopilot', { agent: a.agent, action: 'start', mode: was.mode,
              ...(was.hunt != null ? { hunt: was.hunt } : {}), ...(was.room != null ? { assigned_room: was.room } : {}),
              ...(was.roam != null ? { roam: was.roam } : {}), why: 'distill-farm: restore the standing orders' }, 60_000)
              .catch(e => ({ error: e.message }));
            return back?.error ? { ok: false, why: back.error } : true;
          }, 'put the hunt and the station back'), always: true },
        ],
      });
      return { ok: r?.ok === true, refused: r?.refused === true, why: firstWhy(r) };
    }
    default:
      return { ok: false, why: `${a.kind} is not executable` };
  }
}

function whichOk() {
  const r = spawnSync(process.execPath, [join(HERE, 'm59-which.mjs'), '--fleet', FLEET], { encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' / ') };
}

// ------------------------------------------------------------------------------------------- one pass

// THE ROOM PATH, for the route-risk check: fewest hops over the baked room graph (edge and go exits). An
// approximation of the mover's route, and the only one available without asking a keeper. No map, no check.
function routeFinder() {
  let graph;
  try { graph = roomGraph(JSON.parse(readFileSync(process.env.M59_MAP_FILE || join(REPO, 'substrate', 'm59-map.json'), 'utf8'))); }
  catch { return null; }
  const cache = new Map();
  return (from, to) => {
    const k = `${from}>${to}`;
    if (cache.has(k)) return cache.get(k);
    const prev = new Map([[Number(from), null]]), q = [Number(from)];
    while (q.length && !prev.has(Number(to))) { const r = q.shift(); for (const n of graph.get(r) ?? []) if (!prev.has(n)) { prev.set(n, r); q.push(n); } }
    let path = null;
    if (prev.has(Number(to))) { path = []; for (let r = Number(to); r != null; r = prev.get(r)) path.unshift(r); }
    cache.set(k, path);
    return path;
  };
}

const DATA = {
  spawns: loadSpawns(process.env.M59_SPAWN_FILE || join(REPO, 'substrate', 'm59-spawns.json')),
  sourcing: loadSourcingData(),
  catalogue: loadCatalogue(),
  route: routeFinder(),
};
if (!DATA.route) console.log('note: no substrate/m59-map.json, so routes are not checked for the Cragged Mountains / Ancient Place');

async function pass() {
  const t0 = Date.now();
  if (APPLY) {
    const w = whichOk();
    if (!w.ok) { say(`m59-which refused (${w.out}) — nothing applied this pass`); return; }
  }
  const characters = await observe();
  const out = decide({ characters, config: cfg, data: { ...DATA, chests: readChests() }, history: readLedger(), now: Date.now() });
  const pass_id = `${t0.toString(36)}`;
  if (has('json')) console.log(JSON.stringify(out));
  else {
    say(`distill ${FLEET}: ${APPLY ? 'APPLY' : 'DRY'} pass ${pass_id} — home ${cfg.home ?? '(none)'}, away ${out.away.now}+${out.away.granted}/${out.away.limit}` +
        `${cfg.only ? `, only ${[...cfg.only].join(',')}` : ''}`);
    for (const d of out.decisions) console.log('  ' + formatDecision(d));
  }
  if (APPLY || has('record'))
    for (const d of out.decisions)
      record({ phase: 'decision', pass: pass_id, dry: !APPLY, agent: d.agent, character: d.character, action: d.action,
               why: d.why, notes: d.notes, proposals: d.proposals });
  if (!APPLY) return;

  // In-place first (they move nobody), then the road; one at a time — fleetScript holds one run lock per fleet.
  const todo = out.decisions.map(d => d.action).filter(a => a && a.executable !== false)
    .sort((x, y) => (x.road ? 1 : 0) - (y.road ? 1 : 0));
  for (const a of todo) {
    const id = `${pass_id}-${a.agent}-${a.kind}`;
    record({ phase: 'start', id, agent: a.agent, kind: a.kind, key: keyOf(a), action: a });
    say(`${a.agent}: ${a.kind} ${keyOf(a) ?? ''} ...`);
    let r;
    try { r = await execute(a); } catch (e) { r = { ok: false, why: e.message }; }
    record({ phase: 'outcome', id, agent: a.agent, kind: a.kind, key: keyOf(a), ok: !!r.ok, refused: !!r.refused,
             queued: r.queued ?? undefined, code: r.code ?? undefined, why: r.why ?? null,
             ...(r.before !== undefined ? { before: r.before } : {}) });
    say(`${a.agent}: ${a.kind} ${r.ok ? 'ok' : r.refused ? 'REFUSED' : 'FAILED'}${r.why ? ` -- ${r.why}` : ''}`);
  }
}

// ------------------------------------------------------------------------------------------- the loop

let stop = false;
process.on('SIGINT', () => { if (stop) process.exit(130); stop = true; say('stopping after this pass (Ctrl-C again to quit now)'); });
do {
  try { await pass(); } catch (e) { say(`pass failed: ${e.message}`); if (ONCE) process.exitCode = 1; }
  if (ONCE || stop) break;
  for (let i = 0; i < INTERVAL_S && !stop; i++) await new Promise(r => setTimeout(r, 1000));
} while (!stop);
