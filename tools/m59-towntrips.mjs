#!/usr/bin/env node
// TOWN TRIPS, ITEM BY ITEM: what each trip took to town, sold, bought, deposited and drew, and
// what it came home with — filterable, and summed.
//
//   node tools/m59-towntrips.mjs                         the last 24 h, newest first, and totals
//   node tools/m59-towntrips.mjs --item purple           only trips that moved purple mushrooms
//   node tools/m59-towntrips.mjs --agent t12 --since 7d
//   node tools/m59-towntrips.mjs --purpose food --sold   only trips that sold something
//   node tools/m59-towntrips.mjs --json                  rows + totals, for a page
//
// Reads `town_trip_opened` / `town_trip_completed` from the fleet's history, paired by agent and
// `trip_started_at`. The item fields exist from the keeper build that added them (2026-10-05,
// m59-towntrip-ledger.mjs); older trips show their cash and say "no item record".
// Read-only; touches no broker and no roster.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName, ledgerDirFor } from './m59-fleetpath.mjs';
import { tripTouches, TRADE_KINDS } from './m59-towntrip-ledger.mjs';

export function parseSince(v = '24h') {
  const m = /^(\d+(?:\.\d+)?)\s*([hdm])$/i.exec(String(v));
  if (!m) return 24 * 3600e3;
  return Number(m[1]) * ({ m: 60e3, h: 3600e3, d: 86400e3 }[m[2].toLowerCase()]);
}

/** Pair opened/completed rows into trips. Pure, for the tests and the page. */
export function pairTrips(events = []) {
  const open = new Map(), trips = [];
  for (const e of events) {
    const key = `${e.agent}|${e.trip_started_at}`;
    if (e.kind === 'town_trip_opened') open.set(key, e);
    else if (e.kind === 'town_trip_completed') {
      const o = open.get(key) ?? null;
      trips.push({ agent: e.agent, character: e.character ?? o?.character ?? null,
        started_at: e.trip_started_at, completed_at: e.completed_at ?? e.t,
        purpose: e.purpose ?? o?.purpose ?? null, trigger: e.trigger ?? o?.trigger ?? null,
        to: o?.to ?? null, to_name: o?.to_name ?? null, why: o?.why ?? null,
        net_shillings: e.net_shillings ?? null, vendor_sales: e.vendor_sales ?? null, purchases: e.purchases ?? null,
        pack_in: e.pack_in ?? o?.pack_in ?? null, pack_out: e.pack_out ?? null,
        pack_delta: e.pack_delta ?? null, trade: e.trade ?? null,
        itemised: !!(e.trade || e.pack_delta) });
      open.delete(key);
    }
  }
  return trips;
}

export function filterTrips(trips, { agent = null, item = null, purpose = null, sold = false } = {}) {
  return trips.filter(t => (!agent || t.agent === agent || String(t.character ?? '').toLowerCase() === String(agent).toLowerCase())
    && (!purpose || t.purpose === purpose)
    && (!item || tripTouches(t, item))
    && (!sold || Object.keys(t.trade?.sold ?? {}).length > 0));
}

/** Totals by item across trips (amounts per book, shillings for sold/bought). */
export function totalsByItem(trips, item = null) {
  const out = {};
  for (const t of trips) for (const kind of TRADE_KINDS)
    for (const [name, row] of Object.entries(t.trade?.[kind] ?? {})) {
      if (item && !name.includes(String(item).toLowerCase())) continue;
      const o = out[name] ??= { sold: 0, sold_sh: 0, bought: 0, bought_sh: 0, vaulted: 0, guild_deposited: 0, withdrawn: 0 };
      o[kind] += row.amount ?? 0;
      if (kind === 'sold') o.sold_sh += row.shillings ?? 0;
      if (kind === 'bought') o.bought_sh += row.shillings ?? 0;
    }
  return out;
}

/** Shillings across trips: earned, spent, banked, drawn from the bank. */
export function moneyTotals(trips) {
  const m = { earned: 0, spent: 0, banked: 0, bank_withdrawn: 0 };
  for (const t of trips) for (const k of Object.keys(m)) m[k] += Number(t.trade?.[k]) || 0;
  return m;
}

export function readTripEvents({ fleet = fleetName(), sinceMs = 24 * 3600e3, now = Date.now() } = {}) {
  const dir = ledgerDirFor(fleet);
  if (!existsSync(dir)) return [];
  const from = now - sinceMs;
  const days = readdirSync(dir).filter(f => /^fleet-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .filter(f => Date.parse(f.slice(6, 16) + 'T23:59:59Z') >= from - 86400e3).sort();
  const out = [];
  for (const f of days) for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
    if (!line.includes('"town_trip_')) continue;
    try { const e = JSON.parse(line); if ((e.t ?? 0) >= from - 6 * 3600e3) out.push(e); } catch { /* a torn line */ }
  }
  return out;
}

const top = (obj, k = 3) => Object.entries(obj ?? {}).sort((a, b) => (b[1].amount ?? 0) - (a[1].amount ?? 0))
  .slice(0, k).map(([name, r]) => `${name} ${r.amount}${r.shillings ? ` (${r.shillings}sh)` : ''}`).join(', ');

async function main(argv) {
  const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const sinceMs = parseSince(arg('--since') ?? '24h');
  const item = arg('--item');
  const trips = filterTrips(pairTrips(readTripEvents({ fleet: arg('--fleet') ?? fleetName(), sinceMs })),
    { agent: arg('--agent'), item, purpose: arg('--purpose'), sold: argv.includes('--sold') })
    .filter(t => (t.completed_at ?? 0) >= Date.now() - sinceMs)
    .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));
  const totals = totalsByItem(trips, item);
  const money = moneyTotals(trips);
  if (argv.includes('--json')) { console.log(JSON.stringify({ trips, totals, money }, null, 1)); return 0; }
  const itemised = trips.filter(t => t.itemised).length;
  console.log(`${trips.length} town trip(s), ${itemised} with an item record${item ? `, touching "${item}"` : ''}`);
  for (const t of trips) {
    const when = new Date(t.completed_at).toISOString().slice(5, 16).replace('T', ' ');
    console.log(`\n${when}  ${t.agent} ${t.character ?? ''}  ${t.purpose ?? '?'}/${t.trigger ?? '?'} -> ${t.to_name ?? t.to ?? '?'}  net ${t.net_shillings ?? '?'}`);
    if (!t.itemised) { console.log('  (no item record — trip predates the ledger)'); continue; }
    const tr = t.trade ?? {};
    for (const kind of TRADE_KINDS)
      if (Object.keys(tr[kind] ?? {}).length) console.log(`  ${kind.padEnd(15)} ${top(tr[kind], 5)}`);
    if (tr.banked || tr.bank_withdrawn) console.log(`  bank            in ${tr.banked ?? 0}, out ${tr.bank_withdrawn ?? 0}`);
    if (item) {
      const d = Object.entries(t.pack_delta ?? {}).filter(([n]) => n.includes(item.toLowerCase()));
      if (d.length) console.log(`  pack      ${d.map(([n, v]) => `${n} ${v > 0 ? '+' : ''}${v}`).join(', ')}`);
    }
  }
  if (Object.keys(totals).length) {
    console.log('\nTOTALS by item (sold / bought / vaulted / into the hall / out of the hall):');
    for (const [name, o] of Object.entries(totals).sort((a, b) => b[1].sold_sh - a[1].sold_sh).slice(0, 30))
      console.log(`  ${name.padEnd(24)} ${o.sold} (${o.sold_sh}sh) / ${o.bought} (${o.bought_sh}sh) / ${o.vaulted} / ${o.guild_deposited} / ${o.withdrawn}`);
  }
  console.log(`\nSHILLINGS: earned ${money.earned}, spent ${money.spent}, banked ${money.banked}, drawn from the bank ${money.bank_withdrawn}`);
  return 0;
}

// Run only as the entry point: the page imports the pure helpers above.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then(code => process.exit(code));
