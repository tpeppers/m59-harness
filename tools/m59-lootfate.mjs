#!/usr/bin/env node
// WHAT BECAME OF WHAT THE MONSTERS DROPPED: picked up, then sold, used, given, stored, thrown
// away or still carried — or left on the floor, and why.
//
//   node tools/m59-lootfate.mjs --fleet prod                 # drops in the last 30 minutes
//   node tools/m59-lootfate.mjs --fleet prod --minutes 120
//   node tools/m59-lootfate.mjs --fleet prod --item ring     # one kind, every subclass
//   node tools/m59-lootfate.mjs --fleet prod --creature troll
//   node tools/m59-lootfate.mjs --fleet prod --json
//
// THREE ROWS, READ TOGETHER, ALL BY OBJECT ID.
//   kill_drop  what was on the floor after a kill that was not there before it (m59-killdrop.mjs),
//              each piece marked taken or left with the loot pass's reason. The denominator.
//   looted     what entered a pack. A later sweep that picks up a drop counts here, by id.
//   left_pack  where it went: `after` is what we had asked for, `to` the trade's counterparty.
//
// THE ID IS FOLLOWED ACROSS HANDS. An item handed to a fleet-mate keeps its id, so a ring passed
// to the armourer and sold by him is SOLD, not "given". An object id is a handle and is renumbered
// by a server save (CLAUDE.md), so a fate that crosses a save reads as still carried — and that is
// why the window is short by default.
//
// WHAT IT CANNOT SAY, said rather than implied:
//   * A STACK MERGES. Elderberries picked up join the stack already carried and keep its id, not
//     the floor's, so a stackable's fate past the pickup is "merged into a stack".
//   * WEARING IS NOT LEAVING. A ring put on is still in the pack list; it reads "still carried".
//   * NOTHING BEFORE `kill_drop` SHIPPED. With no such rows this falls back to what was picked up,
//     and says so — the denominator cannot be invented afterwards.
//   * ATTRIBUTION IS BY ARRIVAL. Two kills in one room during one fight both claim the floor; an id
//     is counted once.
//
// UNIDENTIFIED ITEMS ARE SPLIT BY CLASS. Every ring is "ring" until revealed; its icon resource id
// names the class exactly (m59-item-signature.mjs), so "ring" is shown with its subclasses — a ring
// of lethargy beside the resistance rings it hides among.
//
// Reads only. Opens no socket, moves nobody, never starts a broker.

import { fileURLToPath } from 'node:url';
import { leftReason } from './m59-killdrop.mjs';

const lc = s => String(s ?? '').toLowerCase();
const STACK_MERGE = 'merged into a stack';

// What a departure means. `fleet` is the set of our characters' names, lowercased.
export function departureFate(row, fleet) {
  const after = row.after ?? null, to = lc(row.to);
  if (after === 'drop') return 'discarded';
  if (after === 'apply' || after === 'use' || after === 'cast') return 'used';
  if (after === 'deposit_items' || after === 'put') return 'stored';
  if (['accept_offer', 'offer', 'counteroffer', 'give', 'buy_items'].includes(after)) {
    if (!to) return 'traded (counterparty unrecorded)';
    return fleet.has(to) ? 'handed to a fleet-mate' : 'sold';
  }
  return 'left unexplained';
}

// events: ledger rows, oldest first. classOf(icon_rsc) -> a class name or null.
export function lootFate(events, { sinceMs = 0, item = null, creature = null, classOf = () => null } = {}) {
  const rows = [...events].sort((a, b) => a.t - b.t);
  const fleet = new Set(rows.map(r => lc(r.character)).filter(Boolean));
  const deaths = rows.filter(r => r.kind === 'died');
  const kills = rows.filter(r => r.kind === 'killed' && r.t >= sinceMs
                                 && (!creature || lc(r.creature).includes(lc(creature)))).length;

  // 1. THE DROPS, once per id.
  const drops = new Map();
  let dropRows = 0;
  for (const r of rows) {
    if (r.kind !== 'kill_drop' || r.t < sinceMs) continue;
    if (creature && !lc(r.creature).includes(lc(creature))) continue;
    dropRows++;
    for (const i of r.items ?? []) {
      if (item && !lc(i.name).includes(lc(item))) continue;
      const had = drops.get(i.id);
      if (had) { if (i.taken && !had.taken) Object.assign(had, { taken: true, by: r.character }); continue; }
      drops.set(i.id, { ...i, t: r.t, creature: r.creature ?? null, room: r.room ?? null,
                        by: i.taken ? r.character : null });
    }
  }

  // 2. PICKED UP, by id, from any looting row at or after the drop.
  const looted = rows.filter(r => r.kind === 'looted');
  for (const d of drops.values()) {
    const got = looted.find(r => r.t >= d.t - 1000 && (r.items ?? []).some(i => i.id === d.id));
    if (got) { d.taken = true; d.by = got.character; d.picked_t = got.t;
               if (d.icon_rsc == null) d.icon_rsc = got.items.find(i => i.id === d.id)?.icon_rsc; }
  }

  // 3. WHERE IT WENT, following the id from hand to hand.
  const departures = rows.filter(r => r.kind === 'left_pack');
  for (const d of drops.values()) {
    if (!d.taken) { d.fate = 'left on the floor'; d.left_why = leftReason(d.why); continue; }
    if ((d.amount ?? 1) > 1) { d.fate = STACK_MERGE; continue; }
    const from = d.picked_t ?? d.t;
    const chain = departures.filter(r => r.t >= from && (r.items ?? []).some(i => i.id === d.id));
    if (!chain.length) { d.fate = 'still carried'; continue; }
    const last = chain.at(-1);
    let fate = departureFate(last, fleet);
    if (fate === 'left unexplained'
        && deaths.some(x => lc(x.character) === lc(last.character) && Math.abs(x.t - last.t) < 30_000))
      fate = 'lost on a death';
    if (fate === 'handed to a fleet-mate') fate = 'held by a fleet-mate';
    d.fate = fate;
    d.hands = chain.length;
  }

  // 4. GROUPED: the name, and for unidentified items the class under it.
  const groups = new Map();
  const bump = (key, d) => {
    const g = groups.get(key) ?? { key, dropped: 0, taken: 0, fates: {}, left: {}, sub: new Map() };
    groups.set(key, g);
    return g;
  };
  const add = (g, d) => {
    g.dropped++; if (d.taken) g.taken++;
    g.fates[d.fate] = (g.fates[d.fate] ?? 0) + 1;
    if (d.left_why) g.left[d.left_why] = (g.left[d.left_why] ?? 0) + 1;
  };
  for (const d of drops.values()) {
    const name = lc(d.name) || '(unnamed)';
    const key = d.unrevealed ? `${name} (unidentified)` : name;
    const g = bump(key, d); add(g, d);
    if (d.unrevealed) {
      const cls = (d.icon_rsc != null && classOf(d.icon_rsc)) || 'class unknown';
      const s = g.sub.get(cls) ?? { key: cls, dropped: 0, taken: 0, fates: {}, left: {} };
      g.sub.set(cls, s); add(s, d);
    }
  }
  const out = [...groups.values()].sort((a, b) => b.dropped - a.dropped)
    .map(g => ({ ...g, sub: [...g.sub.values()].sort((a, b) => b.dropped - a.dropped) }));
  const total = { key: 'ALL DROPS', dropped: 0, taken: 0, fates: {}, left: {} };
  for (const d of drops.values()) add(total, d);

  // Nothing to divide by: say what was picked up instead, and why that is not the answer.
  const pickupsOnly = dropRows ? null
    : looted.filter(r => r.t >= sinceMs).flatMap(r => r.items ?? [])
        .filter(i => !item || lc(i.name).includes(lc(item)))
        .reduce((m, i) => (m[lc(i.name)] = (m[lc(i.name)] ?? 0) + 1, m), {});
  return { kills, drop_rows: dropRows, total, groups: out, pickups_only: pickupsOnly,
           items: [...drops.values()] };
}

// ------------------------------------------------------------------------------------- CLI

const FATE_ORDER = ['sold', 'used', 'stored', 'held by a fleet-mate', 'discarded', 'still carried',
  STACK_MERGE, 'traded (counterparty unrecorded)', 'lost on a death', 'left unexplained',
  'left on the floor'];
const pct = (n, d) => d ? `${Math.round(100 * n / d)}%` : '-';

function printGroup(g, indent = '') {
  const fates = FATE_ORDER.filter(f => g.fates[f]).map(f => `${f} ${g.fates[f]}`).join(', ');
  console.log(`${indent}${g.key.padEnd(34 - indent.length)} ${String(g.dropped).padStart(4)}  ` +
              `picked ${pct(g.taken, g.dropped).padStart(4)}   ${fates}`);
  const left = Object.entries(g.left).sort((a, b) => b[1] - a[1]);
  if (left.length && !indent)
    console.log(`${' '.repeat(42)}left because: ${left.map(([k, n]) => `${k} ${n}`).join(', ')}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (n, d = null) => { const i = argv.indexOf('--' + n);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  const minutes = Number(opt('minutes', 30)) || 30;
  const { readLedger } = await import('./m59-ledger.mjs');
  let classOf = () => null;
  try { const sig = await import('./m59-item-signature.mjs'); const t = sig.iconTable();
        classOf = id => sig.classOfIcon(id, t); } catch { /* no client resources: classes unknown */ }
  const now = Date.now(), sinceMs = now - minutes * 60_000;
  const { events } = readLedger({ sinceMs: sinceMs - 60_000 });
  const r = lootFate(events, { sinceMs, item: opt('item'), creature: opt('creature'), classOf });
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ minutes, ...r, items: undefined,
      groups: r.groups.map(g => ({ ...g })) }, null, 1));
    return;
  }
  console.log(`last ${minutes} min: ${r.kills} kills, ${r.drop_rows} with a recorded drop, ` +
              `${r.total.dropped} items dropped`);
  if (r.pickups_only) {
    console.log('\nNO kill_drop ROWS IN THIS WINDOW — the keepers writing them have not been restarted onto ' +
                'the code that records drops, so there is no denominator. Picked up, by name:');
    for (const [k, n] of Object.entries(r.pickups_only).sort((a, b) => b[1] - a[1])) console.log(`  ${k} ${n}`);
    return;
  }
  console.log(`\n${'item'.padEnd(34)} drop  picked        fate of every drop`);
  printGroup(r.total); console.log('');
  for (const g of r.groups) { printGroup(g); for (const s of g.sub) printGroup(s, '    -> '); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
