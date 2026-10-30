#!/usr/bin/env node
// PREFLIGHT A MUSTER: who can go, what stands in the way, what we have, and the plan that closes the gap. Reads only.
//
//   node tools/m59-preflight.mjs avar-village --fleet shadow      the shadow rehearsal (M59_CONTROL_URL names its broker)
//   node tools/m59-preflight.mjs avar-village --fleet prod        the same questions of production
//   node tools/m59-preflight.mjs avar-village --fleet prod --json the whole plan, for the executor or a page
//   node tools/m59-preflight.mjs --list                           the musters this machine has
//
// Operator, 2026-10-29: "It should be trivial to do the 'preflight' that we're doing here, a single command:
// 'Preflight the avar village for us'." This is that command. It writes NOTHING to any fleet: keeper caches (GET
// /state), the broker's `fleet` and `jobs` reads, the posture saves, the vault and chest caches, the game's spell
// table and the room graph. What it prints is the whole launch, decided:
//
//   1. WHO   every candidate the muster spec names, ready / gaps / OUT and why (m59-muster-lib assess)
//   2. SETTLE what has to happen first: jobs to retire, lockdowns to leave (to a hold), survival back on, fight floors
//   3. WHAT  each need (meals by the game's Food tree, reagents of every spell the spec wants cast, by kod class) against
//            what the participants carry, what is within `maxHops` rooms (packs, vaults, chests), and the shortfall
//   4. HOW   the transfers, each naming who hands what to whom and where — the shrink-wrapped plan an executor fires
//            when the parties are together — and whoever a REQUIRED shortfall leaves out, by name
//
// The plan is written to substrate/scratch/preflight/<muster>-<fleet>.json. The muster SPEC is this machine's
// (substrate/musters/<name>.mjs, from the private repo): which characters, which rooms, which thresholds, which spells
// how many times. A spec is orders, so it is not committed here; substrate/musters.example/ carries the shape.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unitFromState, assess, needsOf, sourcesFrom, planSupply, holdingsTable, hopsFrom, readinessReport, DEFAULT_TARGET }
  from './m59-muster-lib.mjs';
import { resolveKeeperBand, discoverKeeperStates } from './runtime/keeper-discovery.mjs';
import { itemClassIndex, resolveItemClass } from './m59-itemclass.mjs';
import { foodValue } from './m59-items.mjs';
import { roomGraph } from './m59-secret-travel.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SUB = process.env.M59_SUBSTRATE || join(REPO, 'substrate');
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = n => argv.includes(n);
const readJson = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const MUSTER_DIRS = [join(SUB, 'musters'), join(SUB, 'musters.example')];

export async function loadSpec(name) {
  for (const d of MUSTER_DIRS) {
    const f = join(d, `${name}.mjs`);
    if (existsSync(f)) return { spec: (await import(pathToFileURL(f).href)).default, file: f };
  }
  return null;
}

// The broker, read-only. A non-prod fleet must NAME its broker: the default is 8901, and a "shadow" preflight read
// from prod's broker would describe the wrong twenty-four characters while every line looked right.
function brokerFor(fleet) {
  const url = process.env.M59_CONTROL_URL || (fleet === 'prod' ? 'http://127.0.0.1:8901/' : null);
  if (!url) throw new Error(`fleet ${fleet}: set M59_CONTROL_URL to that fleet's broker (the default is prod's 8901)`);
  if (fleet !== 'prod' && /:8901\b/.test(url)) throw new Error(`fleet ${fleet} with M59_CONTROL_URL ${url}: that is prod's broker`);
  return async (name, args = {}) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const j = await r.json(); const t = j?.result?.content?.[0]?.text;
    if (j?.error || j?.result?.isError) throw new Error(`${name}: ${j?.error?.message ?? t}`);
    return JSON.parse(t);
  };
}

// For a clone fleet, prod's names: the vault cache and a spec's exclusions are written in them.
function cloneNames(fleet) {
  if (fleet === 'prod') return null;
  const snap = readJson(join(SUB, `${fleet}-snapshot.json`)) ?? readJson(join(SUB, 'shadow-snapshot.json'));
  if (!snap?.characters) return null;
  return { agent: new Map(snap.characters.map(c => [c.prod_agent, c.shadow_account])),
           character: new Map(snap.characters.map(c => [c.prod_character, c.shadow_name])) };
}

export async function preflight(name, { fleet, log = console.log } = {}) {
  const loaded = await loadSpec(name);
  if (!loaded) throw new Error(`no muster "${name}" in ${MUSTER_DIRS.join(' or ')}`);
  const { spec, file } = loaded;
  const call = brokerFor(fleet);
  const names = cloneNames(fleet);
  const asFleet = a => names?.agent.get(a) ?? a;

  // ---- read the world (all of it read-only)
  const band = resolveKeeperBand(fleet, { registryPath: join(SUB, 'keeper-bands.json'), missing: 'null' });
  const rows = (await call('fleet', {}))?.fleet ?? [];
  const { states } = band ? await discoverKeeperStates({ band, expectedAgents: rows.map(r => r.agent) }) : { states: new Map() };
  const jobs = (await call('jobs', { action: 'list' }).catch(() => ({ jobs: [] })))?.jobs ?? [];
  const postureDir = join(SUB, 'posture-saves', fleet);
  const postures = (() => { try { return readdirSync(postureDir).filter(f => f.endsWith('.json')).map(f => readJson(join(postureDir, f))).filter(s => s?.active); } catch { return []; } })();
  const map = readJson(join(SUB, 'm59-map.json'), {});
  const graph = roomGraph(map);
  const hopCache = new Map();
  const distance = (a, b) => { if (a == null || b == null) return Infinity; if (!hopCache.has(a)) hopCache.set(a, hopsFrom(graph, a)); return hopCache.get(a).get(Number(b)) ?? Infinity; };
  const spells = (() => { const s = readJson(join(SUB, 'm59-spells.json'), []); return Array.isArray(s) ? s : (s.spells ?? Object.values(s)); })();
  const index = itemClassIndex();
  const classOf = n => { const r = resolveItemClass(String(n), index); return r.ok ? r.class : String(n); };
  const isFood = n => !!foodValue(n);

  // ---- who
  const exclude = new Set((spec.exclude ?? []).map(asFleet));
  const candidates = rows.filter(r => !exclude.has(r.agent) && (!spec.rooms || spec.rooms(Number(r.room_num))));
  const units = candidates.map(r => {
    const st = states.get(r.agent) ?? { agent: r.agent, character: r.character, in_game: false };
    const u = unitFromState(st, { row: r, jobs, postures: postures.filter(p => p.units?.[r.agent]).map(p => p.name) });
    return { ...u, spells: (st.spells ?? []).map(s => s.name) };
  });
  const target = { ...DEFAULT_TARGET, ...(spec.target ?? {}) };
  const assessed = units.map(u => assess(u, target, { startRooms: spec.startRooms ?? null }));
  let participants = units.filter((u, i) => !assessed[i].exclude);

  // ---- what: needs, sources, the plan (and whoever a REQUIRED shortfall leaves out, then plan again without them)
  // A VAULT READ BEFORE ROOMS WERE RECORDED IS PLACED BY EVIDENCE OR NOT AT ALL: the owner's fleet sample nearest the
  // reading (history/<fleet>/fleet-<day>.jsonl, five-minute rows with room_num), if one lands within three minutes.
  // Measured 2026-10-29: every cached vault was read on the mainland (106/107/114/714...), none at Ko'catan's (2005) --
  // so "the island vaults" held nothing anybody had looked at, and a planner guessing 2005 would have walked people there.
  const samples = new Map();
  const inferRoom = (character, at) => {
    if (!character || !(at > 0)) return null;
    const day = new Date(at).toISOString().slice(0, 10);
    if (!samples.has(day)) {
      const rows = [];
      try { for (const l of readFileSync(join(SUB, 'history', 'prod', `fleet-${day}.jsonl`), 'utf8').split('\n'))
        if (l.includes('"sample"')) { try { const r = JSON.parse(l); rows.push({ c: r.character, t: r.t, room: Number(r.room_num) || null }); } catch {} } } catch {}
      samples.set(day, rows);
    }
    let best = null;
    for (const r of samples.get(day)) if (r.c === character && r.room && (!best || Math.abs(r.t - at) < Math.abs(best.t - at))) best = r;
    return best && Math.abs(best.t - at) <= 180_000 ? best.room : null;
  };
  const vaults = (() => {
    const dir = join(SUB, 'storage', 'vaults');
    let files = []; try { files = readdirSync(dir).filter(f => f.endsWith('.json')); } catch {}
    const out = [];
    for (const f of files) {
      const v = readJson(join(dir, f)); if (!v?.character) continue;
      const who = names?.character.get(v.character) ?? v.character;
      const entries = v.by_room ? Object.entries(v.by_room).map(([room, e]) => ({ room: Number(room), ...e }))
        : [{ room: v.room ?? inferRoom(v.character, v.observed_at), inferred: v.room == null, items: v.items, observed_at: v.observed_at }];
      for (const e of entries) out.push({ character: who, room: e.room ?? null, inferred: !!e.inferred && e.room != null, items: e.items ?? [],
                                          observed_at: e.observed_at ?? null, simulated: !!names });
    }
    return out;
  })();
  const chests = (() => { const dir = join(SUB, 'storage', 'chests'); try { return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => readJson(join(dir, f))).filter(Boolean); } catch { return []; } })();
  const allUnits = rows.map(r => { const st = states.get(r.agent); return st ? { agent: r.agent, character: st.character, room: Number(st.room?.num) || null, items: st.items ?? [] } : null; }).filter(Boolean);
  const keepOf = (s, key) => (spec.keep?.[key] ?? 0);
  const required = new Set(spec.require ?? ['meal']);
  let plan, needs, out = [];
  for (let round = 0; round < 4; round++) {
    needs = Object.fromEntries(participants.map(u => [u.agent, needsOf(u, spec, { spells, classOf })]));
    // Sources are EVERYONE's packs (a non-participant in the same room can hand over), the vaults and the chests.
    plan = planSupply(needs, participants, sourcesFrom({ units: allUnits, vaults, chests }), { classOf, isFood, distance, maxHops: spec.maxHops ?? 3, keep: keepOf });
    const left = [...new Set(plan.shortfalls.filter(s => required.has(s.key)).map(s => s.agent))];
    if (!left.length) break;
    out.push(...left.map(a => ({ agent: a, why: plan.shortfalls.filter(s => s.agent === a && required.has(s.key)).map(s => `${s.short} ${s.key} short`).join(', ') })));
    participants = participants.filter(u => !left.includes(u.agent));
  }

  // ---- settle
  const settle = participants.map(u => ({ agent: u.agent,
    cancel_jobs: u.jobs.map(j => j.id), release: u.postures, survival_on: u.survivalOff,
    fight_floor: Number(u.policy?.fightAboveVigor) < target.fightAboveVigor ? target.fightAboveVigor : null }));
  const hazards = [...new Set(assessed.filter(a => participants.some(p => p.agent === a.agent)).flatMap(a => a.gaps.map(g => g.hazard).filter(Boolean)))];
  const keys = [...new Set(Object.values(needs).flat().map(n => n.key))];
  const report = {
    muster: name, fleet, at: new Date().toISOString(), spec: file,
    target, max_hops: spec.maxHops ?? 3, hazards_to_accept: hazards,
    readiness: assessed, excluded_for_supply: out,
    participants: participants.map(u => u.agent),
    settle, needs, transfers: plan.transfers, shortfalls: plan.shortfalls,
    holdings: holdingsTable(keys, sourcesFrom({ units: allUnits, vaults, chests }), { classOf, isFood }),
    vaults_simulated: !!names && vaults.length > 0,
    operation: spec.operation ?? null,
  };

  // ---- say it
  log(`PREFLIGHT ${name} on fleet ${fleet} — ${report.at}`);
  log(`  spec ${file}`);
  log(`\n1. WHO (${assessed.length} candidates; ${participants.length} go)`);
  for (const l of readinessReport(assessed)) log('   ' + l);
  if (out.length) { log(`   left out for supply (redistribute-only, required: ${[...required].join(', ')}):`); for (const o of out) log(`     ${o.agent}: ${o.why}`); }
  log(`\n2. SETTLE${hazards.length ? `  (accept: ${hazards.join(', ')})` : ''}`);
  const sum = k => settle.filter(s => (Array.isArray(s[k]) ? s[k].length : s[k])).length;
  log(`   retire jobs over ${sum('cancel_jobs')}, leave a lockdown (to a hold) ${sum('release')}, survival back on ${sum('survival_on')}, fight floor ${sum('fight_floor')}`);
  log(`\n3. WHAT (within ${report.max_hops} rooms)`);
  for (const key of keys) {
    const want = Object.values(needs).flat().filter(n => n.key === key).reduce((s, n) => s + n.amount, 0);
    const moved = plan.transfers.filter(t => t.key === key).reduce((s, t) => s + t.amount, 0);
    const short = plan.shortfalls.filter(s => s.key === key).reduce((s, x) => s + x.short, 0);
    const top = (report.holdings[key] ?? []).slice(0, 4).map(h => `${h.source}@${h.room ?? '?'}:${h.amount}`).join(' ');
    log(`   ${key.padEnd(12)} need ${String(want).padStart(4)}  moved ${String(moved).padStart(4)}  short ${String(short).padStart(4)}   held most by ${top || 'nobody'}`);
    // WHAT EXISTS BUT IS OUT OF REACH, said rather than dropped: "it is in a vault on the mainland" is a decision for the
    // operator (a trip, or a lower target), and a planner that only prints what it could use hides it.
    const far = (report.holdings[key] ?? []).filter(h => !participants.some(p => distance(p.room, h.room) <= report.max_hops));
    if (far.length) log(`   ${''.padEnd(12)} beyond ${report.max_hops} rooms: ${far.reduce((n, h) => n + h.amount, 0)} (${far.slice(0, 5).map(h => `${h.source}@${h.room ?? 'unknown room'}:${h.amount}`).join(' ')}${far.length > 5 ? ' ...' : ''})`);
  }
  if (report.vaults_simulated) log('   (vaults: prod\'s cached contents under clone names — the lab\'s own vaults are NOT mirrored yet)');
  log(`\n4. HOW (${plan.transfers.length} transfers)`);
  for (const t of plan.transfers) log(`   ${t.kind === 'pack' ? `${t.holder} hands` : t.kind === 'vault' ? `${t.holder} withdraws from its vault` : 'a member draws from the chest'} ` +
    `${t.amount} ${t.name} -> ${t.to}  @${t.room ?? '?'}${t.hops ? ` (${t.hops} room${t.hops > 1 ? 's' : ''} away)` : ''}`);
  for (const s of plan.shortfalls) log(`   SHORT ${s.agent}: ${s.short} ${s.key} (${s.why})`);
  return report;
}

async function main() {
  if (has('--list')) {
    for (const d of MUSTER_DIRS) { let fs = []; try { fs = readdirSync(d).filter(f => f.endsWith('.mjs')); } catch { continue; }
      for (const f of fs) { const s = (await import(pathToFileURL(join(d, f)).href)).default; console.log(`  ${f.slice(0, -4).padEnd(20)} ${s?.about ?? ''}`); } }
    return;
  }
  const name = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--fleet');
  const fleet = flag('--fleet') ?? process.env.M59_FLEET;
  if (!name || !fleet) throw new Error('usage: m59-preflight.mjs <muster> --fleet <name> [--json]   (or --list)');
  const report = await preflight(name, { fleet, log: has('--json') ? () => {} : console.log });
  const dir = join(SUB, 'scratch', 'preflight'); mkdirSync(dir, { recursive: true });
  const f = join(dir, `${name}-${fleet}.json`);
  writeFileSync(f, JSON.stringify(report, null, 1));
  if (has('--json')) console.log(JSON.stringify(report)); else console.log(`\nplan written: ${f}`);
}
if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(e => { console.error(`preflight: ${e.message}`); process.exitCode = 1; });
