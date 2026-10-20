#!/usr/bin/env node
// THE GUILD CHEST, PLANNED AND SOLD FROM: what the compendium's Guild Chest page reads and writes.
//
//   node tools/m59-guild-sale.mjs board                 the chest board as JSON (what the page draws)
//   node tools/m59-guild-sale.mjs couriers [--bulk N]   who could carry a sale right now, ranked
//   node tools/m59-guild-sale.mjs run --job gs-3 [--dry]
//   node tools/m59-guild-sale.mjs due                   run the first due job (what the scheduler does)
//
// FOUR THINGS, AND ONLY ONE OF THEM IS NEW MACHINERY.
//
//   1. THE BOARD. Per chest: how much of its 24,000 bulk the plan reserves and for what, what is
//      held above target (surplus) and below it (under-reserve), what is held that no plan names,
//      and the order things would leave in (m59-chest-eviction evictionOrder — the same ranking
//      the broker's inventory page shows). Nothing here decides; it is the plan, read against
//      the chests' last readings.
//   2. THE SELL PLAN. A standing list of what to sell and WHERE THE MONEY GOES: the courier banks
//      it, it is handed to a named character at a bank who banks it, or it goes back into the hall
//      (as shillings in a chest, or as rent credit with Frular). Kept in substrate/guild-sales.json.
//   3. THE JOBS. "Sell now" and "sell at 21:30" are both a job in the same file with an `at`; the
//      compendium server's scheduler (m59-compendium.mjs) launches the first due one as
//      `node tools/m59-guild-sale.mjs run --job <id>`, one at a time. A job survives a restart of
//      the server because it is a line in a file, not a timer.
//   4. THE COURIER. Ranked, not guessed: it must be able to open the chests (rank sir in the vault
//      config, or seen opening them in the chest history), be over 30 max health, not be driven by
//      something else, and not be the vault desk's staff while the desk is open. Among those:
//      nearest to the hall first, a character that already has guild wants to drop off is
//      preferred (it was going anyway, and depositing them is what makes room), and one whose pack
//      cannot take the sale in a trip or two pays for the extra rounds.
//
// THE SELLING IS NOT NEW: it is m59-chest-evict-run.mjs runEviction, handed a plan made of the
// chosen lines instead of the cross-chest overstock. Draw what fits, walk to the merchant who stocks
// it, sell, repeat — with its worn-gear guard and its ledger. What is new is the courier choice and
// the money's last leg, which runEviction leaves in the runner's purse.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guildPlan, guildShortfall, guildStoreAvailable, contributionPlan, countWanted, entryNames } from './m59-guildwants.mjs';
import { StorageCache, CHEST_BULK_MAX, chestFullness, BOOKMAKERS_HALL_ROOM } from './m59-storage.mjs';
import { evictionOrder, tally, NEVER_EVICT } from './m59-chest-eviction.mjs';
import { freeRoom, loadConfig, readDeskOpen, RANK_SIR, PKILL_ENABLE_HP } from './m59-vault-broker.mjs';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const norm = s => String(s ?? '').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();

export const HALL = BOOKMAKERS_HALL_ROOM;      // 714
export const FRULAR_ROOM = 700;                // m59-tithe.mjs FRULAR_ROOM
// Both pay into bank 1 (blakston.khd:1275); Ko'catan's is bank 2 and is not offered: a deposit
// there is invisible at the other two. There is no banker in Barloque (broker `bank` tool notes).
export const BANKS = Object.freeze({ tos: { room: 54, name: 'Tos' }, jasper: { room: 376, name: 'Jasper' } });
export const PROCEEDS_MODES = Object.freeze(['courier', 'give', 'hall']);
export const HALL_MODES = Object.freeze(['chest', 'rent']);
export const SALES_FILE = process.env.M59_GUILD_SALES || here('../substrate/guild-sales.json');
const LOG_DIR = (fleet = 'prod') => here(`../substrate/history/${fleet}/guild-sale`);

// ------------------------------------------------------------------ the board

/**
 * The plan read against the chests. Pure: every input is passed in.
 *   chests: StorageCache.allChests() rows ({slot, items, observed_at, opened_by, room})
 *   plan:   guildPlan() (normalised; .chests is a Map slot -> [{item, target, also?}])
 *   bulk(name) / worth(name): per-unit bulk and sale value, null when unknown
 *   sellAt(name): {merchant, room} or null
 */
export function chestBoard({ chests = [], plan = null, bulk = () => null, worth = () => null,
                             sellAt = () => null, evictShown = 15 } = {}) {
  const want = plan?.chests ?? new Map();
  const slots = [...new Set([...chests.map(c => c.slot), ...want.keys()])].sort();
  return slots.map(slot => {
    const chest = chests.find(c => c.slot === slot) ?? null;
    const items = chest?.items ?? [];
    const entries = want.get(slot) ?? [];
    const held = tally(items);                                    // Map name -> n
    const claimed = new Set();
    const b = n => { const v = bulk(n); return Number.isFinite(v) ? v : null; };
    const planned = entries.map(e => {
      const have = countWanted(items, e);
      for (const n of entryNames(e)) claimed.add(norm(n));
      const each = b(e.item);
      return { item: e.item, also: e.also ?? null, target: e.target, held: have,
               surplus: Math.max(0, have - e.target), short: Math.max(0, e.target - have),
               bulk_each: each, value_each: worth(e.item) ?? null, sell_at: sellAt(e.item) };
    });
    const unplanned = [...held.entries()].filter(([n]) => !claimed.has(norm(n)))
      .map(([item, n]) => ({ item, held: n, bulk_each: b(item), value_each: worth(item) ?? null,
                             sell_at: sellAt(item), never_evict: NEVER_EVICT.includes(norm(item)) }))
      .sort((x, y) => (y.held * (y.bulk_each ?? 0)) - (x.held * (x.bulk_each ?? 0)));
    const sum = (rows, f) => rows.reduce((n, r) => n + (r.bulk_each == null ? 0 : f(r) * r.bulk_each), 0);
    const unknown = [...planned, ...unplanned].filter(r => r.bulk_each == null).map(r => r.item);
    const fullness = chest ? chestFullness(items) : null;
    const ev = chest ? evictionOrder(chest, entries) : { rows: [], freeable_bulk: 0, unknown_bulk: [] };
    return {
      slot, room: chest?.room ?? null, observed_at: chest?.observed_at ?? null, opened_by: chest?.opened_by ?? null,
      seen: !!chest, capacity: CHEST_BULK_MAX,
      counts: Object.fromEntries(held),          // name -> n, so an edited plan can be re-read in the page
      bulk: fullness?.bulk ?? null, percent: fullness?.percent ?? null,
      // The four parts of a chest, in bulk. `reserve` is room the plan is holding for stock that
      // has not arrived — space that looks free and is not.
      parts: {
        kept: sum(planned, r => Math.min(r.held, r.target)),
        surplus: sum(planned, r => r.surplus),
        unplanned: sum(unplanned, r => r.held),
        reserve: sum(planned, r => r.short),
      },
      planned_bulk: sum(planned, r => r.target),
      unknown_bulk: unknown,
      planned, unplanned,
      evictions: ev.rows.slice(0, evictShown).map(r => ({ ...r, sell_at: sellAt(r.name) })),
      evictions_more: Math.max(0, ev.rows.length - evictShown),
      freeable_bulk: ev.freeable_bulk,
    };
  });
}

/** Everything the page needs, read live from disk and the price/bulk tables. */
export async function liveBoard({ root = here('..') } = {}) {
  const { liveInputs } = await import('./m59-chest-evict.mjs');
  const inputs = await liveInputs({ root });
  const store = new StorageCache();
  const chests = store.allChests().filter(c => Number(c.room) === HALL || c.room == null);
  const rent = store.readRent();
  const plan = guildPlan();
  const sellAt = sellerFor(inputs);
  return {
    gate: guildStoreAvailable({ rent, chests }),
    rent: rent ? { credit: rent.credit ?? null, in_guild: rent.in_guild ?? null, hours_left: rent.hours_left ?? null,
                   observed_at: rent.observed_at ?? null } : null,
    desk: readDeskOpen('prod'),
    town: inputs.town?.name ?? null,
    chests: chestBoard({ chests, plan, bulk: inputs.bulk, worth: inputs.worth, sellAt }),
    shortfall: plan ? guildShortfall({ plan, chests, rent }) : [],
    problems: plan?.problems ?? [],
    has_plan: !!plan,
  };
}

/** Where a name is sold: a merchant in the hall's town first, else the first that buys it at all. */
export function sellerFor(inputs) {
  return name => {
    const who = inputs.sellers.get(norm(name)) ?? inputs.sellers.get(String(name).toLowerCase()) ?? [];
    return who.find(x => (inputs.townRooms ?? []).includes(Number(x.room))) ?? who[0] ?? null;
  };
}

// ------------------------------------------------------------------ the sell plan and the jobs

export function blankSales() {
  return { sell_plan: { items: [], proceeds: { mode: 'courier', to: null, bank: 'nearest', hall: 'chest' } },
           jobs: [], next: 1 };
}

/** One shape for whatever came off disk or a form. Problems are reported, the rest is kept. */
export function normaliseSellPlan(raw = {}) {
  const problems = [];
  const items = [];
  const seen = new Map();
  for (const [i, r] of (Array.isArray(raw?.items) ? raw.items : []).entries()) {
    const item = norm(r?.item);
    const amount = Math.floor(Number(r?.amount));
    if (!item) { problems.push(`line ${i + 1} names no item`); continue; }
    if (!(amount > 0)) { problems.push(`${item}: amount must be a whole number above 0`); continue; }
    if (NEVER_EVICT.includes(item)) { problems.push(`${item} is never sold out of the chests (it is the money)`); continue; }
    if (seen.has(item)) { seen.get(item).amount += amount; problems.push(`${item} was listed twice; the amounts were added`); continue; }
    const row = { item, amount };
    seen.set(item, row); items.push(row);
  }
  const p = raw?.proceeds ?? {};
  const mode = PROCEEDS_MODES.includes(p.mode) ? p.mode : 'courier';
  if (p.mode && mode !== p.mode) problems.push(`proceeds "${p.mode}" is not one of ${PROCEEDS_MODES.join(', ')}; the courier banks it`);
  const to = p.to ? String(p.to).trim() : null;
  if (mode === 'give' && !to) problems.push('proceeds go to a named character, and none is named');
  const bank = ['nearest', ...Object.keys(BANKS)].includes(p.bank) ? p.bank : 'nearest';
  const hall = HALL_MODES.includes(p.hall) ? p.hall : 'chest';
  return { items, proceeds: { mode, to, bank, hall }, problems };
}

export function readSales(file = SALES_FILE) {
  try { if (existsSync(file)) { const j = JSON.parse(readFileSync(file, 'utf8')); return { ...blankSales(), ...j }; } }
  catch { /* an unreadable book is reported by the caller writing it back */ }
  return blankSales();
}
export function writeSales(book, file = SALES_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(book, null, 1));
  renameSync(tmp, file);
  return book;
}
export function saveSellPlan(raw, file = SALES_FILE) {
  const { items, proceeds, problems } = normaliseSellPlan(raw);
  const book = readSales(file);
  book.sell_plan = { items, proceeds, updated: new Date().toISOString() };
  writeSales(book, file);
  return { sell_plan: book.sell_plan, problems };
}

/** File a sale. `at` null or in the past means as soon as the scheduler next looks. */
export function addJob({ at = null, courier = 'auto', items, proceeds, borrow = false, by = 'compendium' } = {}, file = SALES_FILE, now = Date.now()) {
  const sp = normaliseSellPlan({ items, proceeds });
  if (!sp.items.length) throw new Error('a sale needs at least one line');
  if (sp.proceeds.mode === 'give' && !sp.proceeds.to) throw new Error('the proceeds are to be handed to a character, and none is named');
  const when = at == null || at === '' ? now : Number(new Date(at));
  if (!Number.isFinite(when)) throw new Error(`"${at}" is not a time`);
  const book = readSales(file);
  if (book.jobs.some(j => j.status === 'running' && courier !== 'auto' && j.courier_used === courier))
    throw new Error(`${courier} is already carrying a sale`);
  const job = { id: `gs-${book.next++}`, created: now, at: Math.max(when, now), courier: courier || 'auto',
                items: sp.items, proceeds: sp.proceeds, borrow: !!borrow, by, status: 'scheduled' };
  book.jobs.push(job);
  writeSales(book, file);
  return { job, problems: sp.problems };
}
export function updateJob(id, patch, file = SALES_FILE) {
  const book = readSales(file);
  const j = book.jobs.find(x => x.id === id);
  if (!j) return null;
  Object.assign(j, patch, { updated: Date.now() });
  writeSales(book, file);
  return j;
}
export function cancelJob(id, file = SALES_FILE) {
  const book = readSales(file);
  const j = book.jobs.find(x => x.id === id);
  if (!j) throw new Error(`no job ${id}`);
  if (j.status !== 'scheduled') throw new Error(`${id} is ${j.status}; only a scheduled sale can be cancelled`);
  j.status = 'cancelled'; j.updated = Date.now();
  writeSales(book, file);
  return j;
}
/** The first job that is due and nothing else running. One sale at a time: two couriers in the
 *  hall drawing from the same chests would each count stock the other is about to take. */
export function nextDue(book, now = Date.now()) {
  if (book.jobs.some(j => j.status === 'running')) return null;
  return book.jobs.filter(j => j.status === 'scheduled' && Number(j.at) <= now)
    .sort((a, b) => a.at - b.at)[0] ?? null;
}

// ------------------------------------------------------------------ the courier

const maxHealthOf = r => Number(String(r?.health ?? '').split('/')[1]) || Number(r?.max_health) || Number(r?.level) || 0;

/**
 * Rank every fleet row as a courier for a sale of `saleBulk`. Pure.
 *   access:  Set of lower-cased agent ids and character names known to open the chests
 *   cfg:     vault-broker config ({ranks, manager, go_between})
 *   desk:    readDeskOpen() result (staff are taken while it is open)
 *   eta:     Map agent -> ms to the hall (null unknown)
 *   dropoff: Map agent -> {bulk, items: [names]} of guild wants it carries
 * Returns rows sorted best first, each {agent, character, ok, why[], cost_ms, ...}.
 */
export const ROUND_TRIP_MS = 4 * 60_000;       // hall -> merchant -> hall, Barloque, roughly
export const DROPOFF_BONUS_MS = 3 * 60_000;    // a character going anyway costs the fleet less
export function rankCouriers({ rows = [], saleBulk = 0, access = new Set(), cfg = {}, desk = null,
                               eta = new Map(), dropoff = new Map(), weighBulk = 0 } = {}) {
  const staff = desk ? new Set([cfg.manager, cfg.go_between].filter(Boolean)) : new Set();
  return rows.filter(r => r?.agent && r.character).map(r => {
    const why = [];
    const hp = maxHealthOf(r);
    if (hp && hp < PKILL_ENABLE_HP) why.push(`${hp} max health: under ${PKILL_ENABLE_HP} the guardian angel keeps it out of the hall`);
    const rank = cfg.ranks?.[r.agent];
    const seen = access.has(norm(r.agent)) || access.has(norm(r.character));
    if (rank != null && rank < RANK_SIR) why.push(`guild rank ${rank}; the chests need rank ${RANK_SIR} (sir)`);
    else if (rank == null && !seen) why.push('never seen opening the chests, and its guild rank is not recorded');
    if (r.busy) why.push(`busy: ${typeof r.busy === 'string' ? r.busy : r.busy.label ?? r.busy.kind ?? 'driven'}`);
    if (r.committed) why.push(`committed: ${r.committed.label ?? r.committed.kind ?? 'driven'}`);
    if (staff.has(r.agent)) why.push('vault desk staff, and the desk is open');
    if (!Number.isFinite(Number(r.room_num))) why.push('where it is is not known');
    const room = freeRoom(r, 0.05);
    const drop = dropoff.get(r.agent) ?? { bulk: 0, items: [] };
    const free = room ? room.bulk + drop.bulk : null;
    if (free == null) why.push('its pack load is not known');
    const rounds = free > 0 && saleBulk > 0 ? Math.ceil(saleBulk / free) : (saleBulk > 0 ? Infinity : 1);
    if (Number.isFinite(rounds) && rounds > 6) why.push(`its pack would need ${rounds} trips (the runner stops at 6)`);
    if (free === 0 && saleBulk > 0) why.push('no room in its pack, even after its own drop-off');
    const t = eta.get(r.agent);
    const cost = (t == null ? 30 * 60_000 : t) + Math.max(0, (Number.isFinite(rounds) ? rounds : 6) - 1) * ROUND_TRIP_MS
      - (drop.bulk > 0 ? DROPOFF_BONUS_MS : 0);
    return { agent: r.agent, character: r.character, room: r.room ?? null, room_num: r.room_num ?? null,
             ok: why.length === 0, why, cost_ms: cost, eta_ms: t ?? null, free_bulk: room?.bulk ?? null,
             dropoff_bulk: drop.bulk, dropoff_items: drop.items, rounds: Number.isFinite(rounds) ? rounds : null,
             purse: r.purse ?? null, rank: rank ?? null, seen_opening: seen };
  }).sort((a, b) => (b.ok - a.ok) || (a.cost_ms - b.cost_ms) || a.character.localeCompare(b.character));
}

/** Everyone the chest readings and their history show opening a chest. */
export function chestOpeners(store = new StorageCache()) {
  const out = new Set();
  for (const c of store.allChests()) {
    if (c.opened_by) out.add(norm(c.opened_by));
    try { for (const h of store.readChestHistory(c.slot, { limit: 2000 })) if (h?.by) out.add(norm(h.by)); } catch { /* no history */ }
  }
  return out;
}

/** Live: read the fleet, estimate each row's way to the hall, look in its pack for drop-offs. */
export async function liveCouriers({ call, saleBulk = 0, inspect = 8 } = {}) {
  const rows = (await call('fleet', {}, 60_000))?.fleet ?? [];
  const store = new StorageCache();
  const chests = store.allChests().filter(c => Number(c.room) === HALL);
  const rent = store.readRent();
  const plan = guildPlan();
  const cfg = loadConfig();
  const desk = readDeskOpen('prod');
  const access = chestOpeners(store);
  const eta = new Map();
  await Promise.all(rows.filter(r => Number.isFinite(Number(r.room_num))).map(async r => {
    const e = await call('travel_estimate', { from: Number(r.room_num), to: HALL }, 15_000).catch(() => null);
    eta.set(r.agent, Number.isFinite(e?.ms) ? e.ms : null);
  }));
  // Packs are read only for the nearest few that pass the cheap checks: an inventory read is a
  // broker round trip per character, and the far end of the list will not be chosen anyway.
  const dropoff = new Map();
  const first = rankCouriers({ rows, saleBulk, access, cfg, desk, eta }).filter(c => c.ok || c.why.every(w => /trips|no room/.test(w)));
  const { weighItem } = await import('./m59-items.mjs');
  for (const c of first.slice(0, inspect)) {
    const pack = (await call('inventory', { agent: c.agent }, 30_000).catch(() => null))?.items ?? [];
    const cp = contributionPlan({ plan, chests, pack: pack.map(o => ({ name: o.name, amount: o.amount })), rent });
    const items = [], seen = new Set();
    let bulk = 0;
    for (const ch of cp.chests ?? []) for (const g of ch.give ?? []) {
      if (!(g.amount > 0)) continue;
      bulk += (weighItem(g.item)?.bulk ?? 0) * g.amount;
      if (!seen.has(g.item)) { seen.add(g.item); items.push(g.item); }
    }
    dropoff.set(c.agent, { bulk, items });
  }
  return { couriers: rankCouriers({ rows, saleBulk, access, cfg, desk, eta, dropoff }), desk: !!desk, rows };
}

// ------------------------------------------------------------------ running a job

/** The runEviction plan for a set of lines: `total` rows with where each is sold. */
export function salePlan(lines, sellAt) {
  const total = [], unsellable = [];
  for (const l of lines) {
    const at = sellAt(l.item);
    if (!at) { unsellable.push(l.item); continue; }
    total.push({ item: l.item, amount: l.amount, tier: 'chosen', sell_at: at });
  }
  return { plan: { total, moves: [] }, unsellable };
}

/**
 * One sale, start to finish. Steps, each recorded:
 *   courier -> (borrow) -> runEviction (its own drop-off goes in first) -> the money's last leg.
 * `dry` reads everything and moves nothing: no borrow, no travel, no trade, no bank.
 */
export async function runSaleJob(job, { call, log = console.log, dry = false, root = here('..'),
                                        estimate = null } = {}) {
  const { liveInputs } = await import('./m59-chest-evict.mjs');
  const { runEviction } = await import('./m59-chest-evict-run.mjs');
  const { weighItem } = await import('./m59-items.mjs');
  const inputs = await liveInputs({ root });
  const sellAt = sellerFor(inputs);
  const steps = [];
  const note = (kind, detail) => { steps.push({ at: Date.now(), kind, ...detail }); };

  const saleBulk = job.items.reduce((n, l) => n + (weighItem(l.item)?.bulk ?? 0) * l.amount, 0);
  // 1. WHO CARRIES IT.
  const { couriers, rows } = await liveCouriers({ call, saleBulk });
  let c = job.courier && job.courier !== 'auto'
    ? couriers.find(x => x.agent === job.courier || norm(x.character) === norm(job.courier)) : couriers.find(x => x.ok);
  if (!c) throw new Error(job.courier && job.courier !== 'auto' ? `${job.courier} is not in the fleet` : 'no character can carry this sale now: ' +
    couriers.slice(0, 3).map(x => `${x.character} (${x.why.join('; ')})`).join(', '));
  // A NAMED COURIER STILL HAS TO BE ABLE TO DO IT. Being busy is the one refusal a borrow can lift.
  const blockers = c.why.filter(w => !(job.borrow && /^busy/.test(w)));
  if (blockers.length) throw new Error(`${c.character} cannot carry it: ${blockers.join('; ')}`);
  log(`courier: ${c.character} (${c.agent}) — ${c.eta_ms == null ? 'distance unknown' : `${Math.round(c.eta_ms / 60000)} min to the hall`}` +
      `, ${c.free_bulk ?? '?'} bulk free${c.dropoff_bulk ? `, dropping off ${c.dropoff_items.join(', ')} (${c.dropoff_bulk} bulk)` : ''}`);
  note('courier', { agent: c.agent, character: c.character, eta_ms: c.eta_ms, dropoff: c.dropoff_items });

  const { plan, unsellable } = salePlan(job.items, sellAt);
  if (unsellable.length) { log(`no merchant buys ${unsellable.join(', ')}: left in the chests`); note('unsellable', { items: unsellable }); }
  if (!plan.total.length) throw new Error('nothing in this sale has a merchant who buys it');

  let loan = null;
  try {
    if (job.borrow && !dry && rows.find(r => r.agent === c.agent)?.busy) {
      const { borrow } = await import('./m59-yield.mjs');
      log(`borrowing ${c.agent} from its training runner…`);
      loan = await borrow({ dir: here('../substrate/history/prod/training-yield'), agent: c.agent,
                            why: `guild-sale:${job.id}`, timeoutMs: 5 * 60_000 });
    }
    const purseBefore = await purseOf(call, c.agent);
    // 2. THE SALE. Its own guild drop-off goes in first (runEviction's `own`): that is the room.
    const res = await runEviction({ plan, agent: c.agent, dry, log, call, own: c.dropoff_items,
                                    ledgerFile: here('../substrate/history/prod/chest-evict.jsonl') });
    note('sold', { sold: res.sold });
    const purseAfter = await purseOf(call, c.agent);
    let gain = dry ? estimateValue(job.items, inputs) : Math.max(0, (purseAfter ?? 0) - (purseBefore ?? 0));
    log(`${dry ? 'would raise about' : 'raised'} ${gain} shillings`);
    note('proceeds', { gain, purse_before: purseBefore, purse_after: purseAfter, estimated: dry });
    // 3. THE MONEY'S LAST LEG.
    if (gain > 0) await settle({ call, log, dry, agent: c.agent, gain, proceeds: job.proceeds, rows, note });
    return { courier: c.agent, character: c.character, sold: res.sold, gain, steps, dry };
  } finally { loan?.release(); }
}

function estimateValue(lines, inputs) {
  return lines.reduce((n, l) => n + (Number(inputs.worth(l.item)) || 0) * l.amount, 0);
}
async function purseOf(call, agent) {
  const r = (await call('fleet', {}, 60_000).catch(() => null))?.fleet?.find(x => x.agent === agent);
  return Number.isFinite(Number(r?.purse)) ? Number(r.purse) : null;
}
async function nearestBank(call, from, choice) {
  if (BANKS[choice]) return BANKS[choice];
  let best = BANKS.tos, bestMs = Infinity;
  for (const b of Object.values(BANKS)) {
    const e = await call('travel_estimate', { from, to: b.room }, 15_000).catch(() => null);
    if (Number.isFinite(e?.ms) && e.ms < bestMs) { best = b; bestMs = e.ms; }
  }
  return best;
}
const travel = (call, agent, to) => call('travel', { agent, to, background: false }, 900_000);

/** Where the money goes. Only the sale's gain moves; the courier keeps the purse it came with. */
async function settle({ call, log, dry, agent, gain, proceeds, rows, note }) {
  const p = proceeds ?? { mode: 'courier' };
  const from = Number(rows.find(r => r.agent === agent)?.room_num) || HALL;
  if (p.mode === 'hall' && p.hall === 'rent') {
    log(`${dry ? 'would pay' : 'paying'} ${gain} to Frular as rent (room ${FRULAR_ROOM})`);
    if (!dry) {
      await travel(call, agent, FRULAR_ROOM);
      const t = await call('tithe', { agent, action: 'pay', amount: gain }, 120_000);
      note('rent', { amount: gain, reply: t?.paid ?? t?.ok ?? null });
    }
    return;
  }
  if (p.mode === 'hall') {
    // EXACTLY THE GAIN INTO A CHEST. hall_withdraw deposits whole stacks by name, so the purse goes
    // in and what the courier came with is drawn straight back out — the counted get is exact.
    log(`${dry ? 'would put' : 'putting'} ${gain} shillings into the guild chests`);
    if (!dry) {
      await travel(call, agent, HALL);
      const purse = await purseOf(call, agent);
      const keep = Math.max(0, (purse ?? gain) - gain);
      await call('hall_withdraw', { agent, wants: [], deposit: ['shilling'] }, 620_000);
      if (keep > 0) await call('hall_withdraw', { agent, wants: [{ item: 'shilling', amount: keep }] }, 620_000);
      note('hall', { amount: gain, kept: keep });
    }
    return;
  }
  // From where the sale ended (the merchant), not where the courier started.
  const bank = await nearestBank(call, (await call('fleet', {}, 60_000).catch(() => null))?.fleet
    ?.find(r => r.agent === agent)?.room_num ?? from, p.bank);
  if (p.mode === 'give') {
    const to = rows.find(r => norm(r.character) === norm(p.to) || r.agent === p.to);
    if (!to) { log(`${p.to} is not in the fleet: ${agent} banks it instead`); note('give_fallback', { why: 'recipient not in fleet' }); }
    else if (to.busy || to.committed) { log(`${to.character} is busy: ${agent} banks it instead`); note('give_fallback', { why: 'recipient busy' }); }
    else {
      log(`${dry ? 'would meet' : 'meeting'} ${to.character} at the ${bank.name} bank (room ${bank.room}) to hand over ${gain}`);
      if (dry) return;
      await Promise.all([travel(call, agent, bank.room), travel(call, to.agent, bank.room)]);
      const inv = await call('inventory', { agent }, 60_000);
      const stacks = (inv?.items ?? []).filter(o => norm(o.name) === 'shilling');
      let rest = gain;
      const what = stacks.map(o => { const n = Math.min(Number(o.amount) || 0, rest); rest -= n; return n > 0 ? { id: o.id, amount: n, name: o.name } : null; }).filter(Boolean);
      const s = await call('supply', { from: agent, to: to.agent, what, who_travels: 'neither', ids_as_of: inv?.ids_as_of }, 300_000);
      note('give', { to: to.agent, amount: gain, reply: s?.ok ?? null });
      const d = await call('bank', { agent: to.agent, action: 'deposit', amount: gain }, 120_000);
      note('deposit', { agent: to.agent, amount: gain, balance: d?.balance ?? null });
      log(`${to.character} banked ${gain}`);
      return;
    }
  }
  log(`${dry ? 'would bank' : 'banking'} ${gain} at the ${bank.name} bank (room ${bank.room})`);
  if (dry) return;
  await travel(call, agent, bank.room);
  const d = await call('bank', { agent, action: 'deposit', amount: gain }, 120_000);
  note('deposit', { agent, amount: gain, balance: d?.balance ?? null });
}

// ------------------------------------------------------------------ running from the book

export function jobLogFile(id, fleet = 'prod') { return join(LOG_DIR(fleet), `${id}.log`); }

export async function runFromBook(id, { dry = false, file = SALES_FILE, call } = {}) {
  const book = readSales(file);
  const job = book.jobs.find(j => j.id === id);
  if (!job) throw new Error(`no job ${id}`);
  const logFile = jobLogFile(id);
  mkdirSync(dirname(logFile), { recursive: true });
  const log = (...a) => { const line = `${new Date().toISOString()} ${a.join(' ')}`; console.log(line); try { appendFileSync(logFile, line + '\n'); } catch {} };
  if (!dry) updateJob(id, { status: 'running', started: Date.now(), pid: process.pid }, file);
  try {
    const res = await runSaleJob(job, { call, log, dry });
    if (!dry) updateJob(id, { status: 'done', finished: Date.now(), result: res, courier_used: res.courier }, file);
    return res;
  } catch (e) {
    log(`FAILED: ${e.message}`);
    if (!dry) updateJob(id, { status: 'failed', finished: Date.now(), error: e.message }, file);
    throw e;
  }
}

// ------------------------------------------------------------------ CLI
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const { brokerCall } = await import('./m59-chest-evict-run.mjs');
  const call = brokerCall();
  const verb = argv[0];
  try {
    if (verb === 'board') console.log(JSON.stringify(await liveBoard(), null, 1));
    else if (verb === 'couriers') {
      const { couriers } = await liveCouriers({ call, saleBulk: Number(arg('bulk', 0)) });
      for (const c of couriers) console.log(`${c.ok ? 'OK ' : '-- '} ${c.character.padEnd(24)} ${String(c.eta_ms == null ? '?' : Math.round(c.eta_ms / 60000) + 'm').padStart(5)}` +
        `  free ${String(c.free_bulk ?? '?').padStart(5)}${c.dropoff_bulk ? `  drop-off ${c.dropoff_bulk}` : ''}${c.why.length ? '  — ' + c.why.join('; ') : ''}`);
    } else if (verb === 'run') await runFromBook(arg('job'), { dry: argv.includes('--dry'), call });
    else if (verb === 'due') {
      const j = nextDue(readSales());
      if (!j) console.log('nothing due'); else await runFromBook(j.id, { call });
    } else { console.log('usage: board | couriers [--bulk N] | run --job <id> [--dry] | due'); process.exit(2); }
  } catch (e) { console.error(e.message); process.exit(1); }
}
