#!/usr/bin/env node
// HOW WOULD YOU LIKE TO GET IT? — the sourcing planner, as a menu per item. Reads; never sends.
//
//   node tools/m59-sourcing.mjs --plan ghost                     the ghost raid's list and choices
//   node tools/m59-sourcing.mjs --wants '{"chain armor":4,"small round shield":6}'
//   node tools/m59-sourcing.mjs --wants '...' --choose 'chain armor=2,small round shield=1' --yes
//   ... --levels 75,74,72 (offline)  |  --control http://127.0.0.1:8901 (read the fleet live)
//   ... --out substrate/sourcing/ghost.json                       write the chosen jobs down
//
// For every item: "How would you like to get <item> (need N)?" and a numbered menu —
//   0) Don't farm it. Buy it (or: nobody sells it — go without)
//   1..) take it from the guild chests / the fleet's spare packs / create it / farm creature X in
//        rooms ... — every farm option graded against THIS fleet's levels (easy, in band, stretch,
//        above the fleet) and ranked easiest-then-fewest-kills.
// The menus are joins over the compendium's own tables (m59-sourcing-lib.mjs): treasure types x
// creatures x spawn rooms x merchants. Choosing is interactive by default; `--choose` answers some
// or all of it and `--yes` takes the default for the rest, so a script can drive it.
//
// What comes out is JOBS, merged where they share a place (chains and shields off the same
// skeletons are one trip), and the REPL lines that run them through the FleetScript compiler:
// farm-to for a creature, prefarm-equipment for soldiers, provision for the buying and the chests.
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadSourcingData, sourcingMenu, jobsFrom, GHOST_PLAN, preferredIndex } from './m59-sourcing-lib.mjs';

const argv = process.argv.slice(2);
const opt = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const has = f => argv.includes(f);
const control = opt('--control', process.env.M59_CONTROL_URL ?? 'http://127.0.0.1:8901');
const lower = s => String(s ?? '').toLowerCase().trim();

const plan = opt('--plan');
const wants = plan === 'ghost' ? { ...GHOST_PLAN.wants, ...JSON.parse(opt('--wants', '{}')) } : JSON.parse(opt('--wants', '{}'));
const prefs = plan === 'ghost' ? GHOST_PLAN.prefer : {};
if (!Object.keys(wants).length) { console.error('nothing wanted: pass --wants \'{"item": count}\' or --plan ghost'); process.exit(2); }

// ---- the fleet, read live (levels = max health; spare gear in packs), unless --levels is given.
const rpc = async (name, args = {}) => {
  const r = await fetch(new URL('/rpc', control), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(60_000) });
  return JSON.parse((await r.json()).result.content[0].text);
};
let fleetLevels = (opt('--levels') ?? '').split(',').map(Number).filter(n => n > 0);
const spare = {};
const fighters = [];
if (!fleetLevels.length && !has('--offline')) {
  try {
    for (const f of (await rpc('fleet', {}))?.fleet ?? []) {
      const s = await rpc('status', { agent: f.agent, brief: false }).catch(() => null);
      const lvl = Number(s?.hp?.max ?? s?.vitals?.health?.max ?? 0);
      if (lvl >= 30) { fleetLevels.push(lvl); fighters.push({ agent: f.agent, character: f.character, level: lvl }); }
      // Spare copies in packs (carried, not worn) that the loadout wants — the "put what we
      // already own in the chest" option.
      const worn = new Set((s?.equipment ?? []).map(lower));
      for (const it of (await rpc('inventory', { agent: f.agent }).catch(() => null))?.items ?? []) {
        const n = lower(it.name);
        if (Object.keys(wants).map(lower).includes(n) && !worn.has(n)) spare[n] = (spare[n] ?? 0) + (Number(it.amount) || 1);
      }
    }
  } catch (e) { console.log(`(could not read the fleet at ${control}: ${e.message} — grading against no levels)`); }
}
fighters.sort((a, b) => b.level - a.level);

// ---- the guild chests, from their last reading.
const chest = {};
const roster = process.env.M59_STATE_FILE;
const chestDir = roster ? path.join(path.dirname(path.dirname(roster)), 'storage', 'chests') : path.join('substrate', 'storage', 'chests');
if (fs.existsSync(chestDir))
  for (const f of fs.readdirSync(chestDir).filter(f => f.endsWith('.json')))
    for (const it of JSON.parse(fs.readFileSync(path.join(chestDir, f), 'utf8')).items ?? [])
      chest[lower(it.name)] = (chest[lower(it.name)] ?? 0) + (Number(it.amount) || 1);

const data = loadSourcingData();
const menu = sourcingMenu(data, wants, { fleetLevels, chest, createable: ['hammer', 'long sword', 'mace', 'axe', 'short sword'] });
// The fleet's own spare copies, as an option after the chests.
for (const m of menu) {
  const n = spare[lower(m.item)] ?? 0;
  if (n > 0) m.options.splice(1, 0, { kind: 'chest', label: `Collect the fleet's own spares: ${n} carried and not worn — deposit them in the chests first`, count: Math.min(n, m.need), from: 'fleet' });
}

// ---- choose.
const given = Object.fromEntries((opt('--choose') ?? '').split(',').map(x => x.split('=')).filter(x => x.length === 2).map(([k, v]) => [lower(k.trim()), Number(v)]));
const choices = {};
const rl = has('--yes') ? null : createInterface({ input: process.stdin, output: process.stdout });
console.log(`fleet levels: ${fleetLevels.length ? `${Math.min(...fleetLevels)}-${Math.max(...fleetLevels)} (${fleetLevels.length} fighters)` : 'unknown'}`);
for (const m of menu) {
  const pref = preferredIndex(m, prefs[m.item]);
  const dflt = given[lower(m.item)] ?? pref ?? 0;
  console.log(`\nHow would you like to get ${m.item} (need ${m.need})?`);
  m.options.forEach((o, i) => console.log(`  ${i === dflt ? '*' : ' '}${i}) ${o.label}`));
  let pick = dflt;
  if (rl && given[lower(m.item)] == null) {
    const a = (await rl.question(`  choice [${dflt}]: `)).trim();
    if (a !== '' && Number.isInteger(Number(a)) && m.options[Number(a)]) pick = Number(a);
  }
  choices[m.item] = pick;
}
rl?.close();

// ---- the jobs, and how to run them.
const jobs = jobsFrom(menu, choices, prefs);
console.log('\n=== THE PLAN ===');
for (const j of jobs.farm)
  console.log(`  FARM ${j.creature} in room ${j.room} for ${j.items.map(i => `${i.count} ${i.item}`).join(' + ')} — ~${j.kills} kills`);
for (const b of jobs.buy) console.log(`  BUY  ${b.amount} ${b.item} at ${b.merchant} (room ${b.at}) ~${b.cost?.toLocaleString() ?? '?'}`);
for (const c of jobs.chest) console.log(`  TAKE ${c.amount} ${c.item} from the guild chests`);
for (const c of jobs.create) console.log(`  CREATE ${c.amount} ${c.item} (Kraanan create weapon — read the output back)`);
for (const s of jobs.skipped) console.log(`  SKIP ${s}`);
console.log(`  buying total ~${jobs.cost.toLocaleString()} sh`);

// A SQUAD PER JOB, NOT THE WHOLE FLEET: a room's spawn cap is the ceiling on kills, and more
// fighters than it feeds just stand there. --per-job (default 6).
const perJob = Math.max(1, Math.min(Number(opt('--per-job', 6)), Math.floor(fighters.length / Math.max(1, jobs.farm.length)) || 1));
console.log('\n=== TO RUN IT (fleet REPL: node tools/m59-fleet-repl.mjs) ===');
let k = 0;
for (const j of jobs.farm) {
  const who = fighters.slice(k, k + perJob).map(f => f.agent); k += perJob;
  if (j.kind === 'soldiers')
    console.log(`  prefarm-equipment agents=${who.join(',')} wants='${JSON.stringify(Object.fromEntries(j.items.map(i => [i.item, i.count])))}' faction=${j.faction}`);
  else for (const it of j.items)
    console.log(`  farm-to agents=${who.join(',')} room=${j.room} quarry="${j.creature}" want="${it.item}" count=${Math.ceil(it.count / Math.max(1, who.length))} to=guild minutes=${Math.max(20, Math.round(j.kills * 1.5 / Math.max(1, who.length)))}`);
}
const provisionList = [...jobs.chest, ...jobs.buy].map(x => ({ item: x.item, amount: x.amount }));
if (provisionList.length) console.log(`  provision agents=<riders + the cup holder> wants='${JSON.stringify(provisionList)}'`);

const out = opt('--out');
if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), wants, choices, jobs }, null, 1));
  console.log(`\nwritten: ${out}`);
}
