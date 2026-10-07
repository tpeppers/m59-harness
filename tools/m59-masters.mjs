#!/usr/bin/env node
// MASTERS: KEEP NAMED CHARACTERS STOCKED WITH WHAT THEIR TRAINING BURNS, FROM THE FLEET AROUND THEM.
//
//   node tools/m59-masters.mjs                    what each master holds, wants, and what would move
//   node tools/m59-masters.mjs --apply            move it (broker `supply`, verified by count)
//   node tools/m59-masters.mjs demand             just the outstanding demand, as written last run
//
// Operator, 2026-10-07: "These Qor disciples now rule the fleet from Castle Victoria ... their
// demands for progress should be broadcast out across the broker, e.g.: make sure they have a
// constant supply of purple mushrooms ... Other characters should be directed to bring them the
// reagents the Qor masters require to continue their trainings effectively (entroot berries, purple
// mushrooms, and faerie wings)." The masters stay where they are; the fleet comes to them.
//
// ONE PASS, IN THIS ORDER, PER ITEM:
//   1. masters first rebalance among themselves: anything a master holds above its own target is
//      offered to the master furthest below target. They stand together, and a pile of 130 fairy
//      wings on a caster who needs 60 beside one who has none is the cheapest fix there is.
//   2. then DONORS standing in the SAME ROOM as the master give, each keeping `donor_keep[item]`
//      (default 0 — a farmer's relay costs a Snack and create food costs elderberry + herb, so none
//      of the three Qor reagents is a farmer's own supply). Nobody is walked anywhere by this: a
//      same-room hand-over is the only kind it makes, because an unattended walk is how this fleet
//      dies, and fetching from far away is a courier errand's job (a FleetScript), not this loop's.
//   3. whatever is still short is the DEMAND, written to substrate/masters-demand.json with the
//      time, per master and per item. That file is the broadcast: couriers, town-stop rules and the
//      operator read it rather than re-deriving it.
//
// CONFIG, private (it names characters): substrate/masters.json
//   { "masters": { "t7": { "purple mushroom": 120, "fairy wing": 60, "entroot berry": 20 }, ... },
//     "donors": ["t1", ...],                 default: every t<N> on the roster that is not a master
//     "donor_keep": { "entroot berry": 0 },  what a donor never gives away
//     "min_transfer": 5,                     a hand-over smaller than this is not worth the trade window
//     "max_transfers": 12 }                  per pass
//
// Every hand-over is the broker's `supply`, which drives both ends of the trade and verifies the
// receiver's count rose. Its reply is checked, not trusted to be a success because it returned.

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const norm = s => String(s ?? '').trim().toLowerCase();

/** Count of one item in an inventory-shaped list. */
export const countOf = (items, name) => (items ?? [])
  .filter(i => norm(i?.name ?? i?.item) === norm(name)).reduce((n, i) => n + (Number(i.amount) || 1), 0);

/**
 * The hand-overs for one pass. Pure.
 *   holdings: { agent: { room, items: {item: n} } }
 *   masters:  { agent: { item: target } }
 * Returns { moves: [{from, to, item, amount, why}], demand: {agent: {item: short}} }.
 */
export function planMasters({ holdings, masters, donors, donorKeep = {}, minTransfer = 5, maxTransfers = 12 }) {
  const have = {};
  for (const [a, h] of Object.entries(holdings)) have[a] = { ...(h.items ?? {}) };
  const roomOf = a => holdings[a]?.room;
  const items = [...new Set(Object.values(masters).flatMap(t => Object.keys(t)))];
  const moves = [];
  const short = (m, item) => Math.max(0, (masters[m][item] ?? 0) - (have[m]?.[item] ?? 0));
  const give = (from, to, item, amount, why) => {
    have[from][item] -= amount; have[to][item] = (have[to][item] ?? 0) + amount;
    moves.push({ from, to, item, amount, why });
  };
  for (const item of items) {
    const needy = () => Object.keys(masters).filter(m => holdings[m] && short(m, item) > 0)
      .sort((a, b) => short(b, item) - short(a, item));
    // 1. Among the masters.
    for (const to of needy()) {
      for (const from of Object.keys(masters)) {
        if (moves.length >= maxTransfers) break;
        if (from === to || !holdings[from] || roomOf(from) !== roomOf(to)) continue;
        const spare = (have[from][item] ?? 0) - (masters[from][item] ?? 0);
        const n = Math.min(spare, short(to, item));
        if (n >= minTransfer) give(from, to, item, n, `master surplus above its own target of ${masters[from][item] ?? 0}`);
      }
    }
    // 2. Donors in the same room.
    for (const to of needy()) {
      for (const from of donors) {
        if (moves.length >= maxTransfers) break;
        if (masters[from] || !holdings[from] || roomOf(from) !== roomOf(to)) continue;
        const spare = (have[from][item] ?? 0) - (donorKeep[item] ?? 0);
        const n = Math.min(spare, short(to, item));
        if (n >= minTransfer) give(from, to, item, n, 'donor in the same room');
      }
    }
  }
  const demand = {};
  for (const m of Object.keys(masters)) for (const item of items) {
    const s = short(m, item);
    if (s > 0) (demand[m] ??= {})[item] = s;
  }
  return { moves, demand };
}

// ------------------------------------------------------------------------------------- cli
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  const has = n => argv.includes(`--${n}`);
  const root = resolve(flag('root', join(HERE, '..')));
  const fleet = flag('fleet', process.env.M59_FLEET || 'prod');
  const configFile = join(root, 'substrate', 'masters.json');
  const demandFile = join(root, 'substrate', 'masters-demand.json');
  if (argv[0] === 'demand') {
    console.log(existsSync(demandFile) ? readFileSync(demandFile, 'utf8') : 'no demand written yet');
    process.exit(0);
  }
  if (!existsSync(configFile)) { console.error(`no ${configFile}`); process.exit(2); }
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const roster = JSON.parse(readFileSync(join(root, 'substrate', 'fleets', `${fleet}.json`), 'utf8'));
  const nameOf = a => roster[a]?.credentials?.character ?? a;
  const masters = config.masters ?? {};
  const donors = config.donors ?? Object.keys(roster).filter(a => /^t\d+$/.test(a) && !masters[a]);
  const items = [...new Set(Object.values(masters).flatMap(t => Object.keys(t)))];
  const { call } = await import('./m59-fleetscript.mjs');
  const parse = r => typeof r === 'string' ? (() => { try { return JSON.parse(r); } catch { return { text: r }; } })() : r;

  const holdings = {};
  for (const a of [...Object.keys(masters), ...donors]) {
    try {
      const inv = parse(await call('inventory', { agent: a }, 60_000));
      const st = parse(await call('status', { agent: a }, 60_000));
      const list = inv?.items ?? inv?.inventory ?? inv?.carrying ?? [];
      const room = st?.room_num ?? st?.room?.num ?? st?.where?.num ?? null;
      if (room == null) { console.log(`${a} ${nameOf(a)}: room unreadable — left out`); continue; }
      holdings[a] = { room, items: Object.fromEntries(items.map(i => [i, countOf(list, i)])) };
    } catch (e) { console.log(`${a} ${nameOf(a)}: ${e.message} — left out`); }
  }
  const plan = planMasters({ holdings, masters, donors, donorKeep: config.donor_keep ?? {},
    minTransfer: config.min_transfer ?? 5, maxTransfers: config.max_transfers ?? 12 });

  for (const m of Object.keys(masters)) {
    const h = holdings[m];
    console.log(`${m.padEnd(4)} ${nameOf(m).padEnd(9)} room ${h?.room ?? '?'}  ` +
      items.map(i => `${i} ${h?.items[i] ?? '?'}/${masters[m][i] ?? 0}`).join('  '));
  }
  console.log(plan.moves.length ? '\nhand-overs:' : '\nno hand-overs this pass');
  for (const mv of plan.moves) console.log(`  ${nameOf(mv.from)} -> ${nameOf(mv.to)}: ${mv.amount} ${mv.item} (${mv.why})`);

  const done = [];
  if (has('apply')) for (const mv of plan.moves) {
    try {
      const r = parse(await call('supply', { from: mv.from, to: mv.to, what: mv.item, amount: mv.amount }, 180_000));
      const got = r?.amounts?.find(x => norm(x.name) === norm(mv.item))?.received ?? 0;
      done.push({ ...mv, received: got, ok: r?.supplied === true });
      console.log(`  ${r?.supplied ? 'ok  ' : 'FAIL'} ${nameOf(mv.from)} -> ${nameOf(mv.to)} ${got}/${mv.amount} ${mv.item}` +
                  (r?.supplied ? '' : `: ${r?.reason ?? r?.error ?? JSON.stringify(r).slice(0, 160)}`));
    } catch (e) { console.log(`  FAIL ${nameOf(mv.from)} -> ${nameOf(mv.to)}: ${e.message}`); }
  }
  const demand = Object.fromEntries(Object.entries(plan.demand).map(([a, d]) => [nameOf(a), d]));
  console.log('\ndemand still open:', Object.keys(demand).length ? JSON.stringify(demand) : 'none');
  if (has('apply')) {
    const out = { at: new Date().toISOString(), note: 'what the masters are still short of after the last pass ' +
      '(tools/m59-masters.mjs); couriers and town-stop rules read this', demand, last_pass: done };
    writeFileSync(demandFile + '.tmp', JSON.stringify(out, null, 2) + '\n');
    renameSync(demandFile + '.tmp', demandFile);
  } else console.log('(dry run — nothing moved; --apply)');
  process.exit(0);
}
