#!/usr/bin/env node
// GUILD HALL VAULT BROKERS — a chest manager at the booth, a go-between at the inn.
//
//   node tools/m59-vault-broker.mjs gate                               can this fleet run it?
//   node tools/m59-vault-broker.mjs request deposit  --from <agent> --items "emerald:40,long sword:1"
//   node tools/m59-vault-broker.mjs request withdraw --from <agent> --items "elderberry:100"
//   node tools/m59-vault-broker.mjs status                             the open tickets
//
// Operator, 2026-09-27: a private strategy, runnable only by a fleet that owns the Bookmaker's hall,
// and only by two characters who can both enter it. One, the CHEST MANAGER, stays inside at the
// booth next to the foyer and walks to the chest room and back to store and withdraw. The other, the
// GO-BETWEEN, stands at the Brownestone Inn and carries deposits and withdrawals for characters who
// cannot enter the hall, handing them across the window to the manager. Anyone who can enter deals
// with the manager directly. The external doors never open for the traffic: a follower through the
// main door within 8 seconds becomes a "legal entry" who may take from the chests
// (ghall.kod:1252-1391), so every walked-in visit is a door held open to whoever is in the foyer.
//
// WHAT THE KOD SAYS, which is what makes it work:
//   * The whole hall is ONE room, RID_GUILDH14 = 714 (blakston.khd:670); the foyer, booth, main
//     hall and chest room are zones of it (guildh14.kod InZone :593-615).
//   * An offer needs only the same room (user.kod:5134-5142), so the booth trades with the foyer.
//   * Speech crosses the foyer boundary only to or from the BOOTH, rows 2-3 col 25
//     (guildh14.kod:227-229): the booth is the window.
//   * Taking from a chest needs Manhattan distance 7 (user.kod:3634); the chests are at r18c2,
//     r18c6, r20c4 (guildh14.kod:518-523), behind the password door (guildh14.kod:242-247).
//   * Nobody without PFLAG_PKILL_ENABLE enters ANY guild hall room, foyer included: the guardian
//     angel refuses them in the room they are leaving (player.kod:11735-11757 UserReqNewOwner,
//     room.kod:2796). An unguilded character under 30 base max health never has the flag
//     (player.kod:11061-11097). So the foyer itself is 30+ only, and the inn is where the rest meet.
//   * The main door opens only for members of rank SIR (2) or above (ghall.kod:1039-1061).
//
// This file is the pure half — config, the gate, the ticket book, how much fits — plus the CLI that
// files a ticket. The walking and trading loop sits on top of it.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));

export const RANK_SIR = 2;                    // blakston.khd:2293
export const PKILL_ENABLE_HP = 30;            // blakston.khd:2094
export const DEFAULTS = Object.freeze({
  enabled: true,
  hall: 714,                                  // RID_GUILDH14
  inn: 106,                                   // the Brownestone Inn, Barloque
  booth: Object.freeze([2, 25]),              // guildh14.kod:604-607
  window: Object.freeze([2, 26]),             // the foyer square beside the booth
  manager: null,                              // agent id: stays inside, works the chests
  go_between: null,                           // agent id: posted at the inn
  keep_free: 0.35,                            // share of the manager's pack kept empty for customers
  ticket_ttl_ms: 6 * 3600_000,
});

export const CONFIG_FILE = process.env.M59_VAULT_BROKER || here('../substrate/strategies/vault-broker.json');

/** The private config, over the defaults. Unknown keys are reported, never applied. */
export function loadConfig(file = CONFIG_FILE) {
  const problems = [];
  let raw = null;
  try { raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; }
  catch (e) { problems.push(`could not read ${file}: ${e.message}`); }
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (k.startsWith('_')) continue;
    if (!Object.hasOwn(DEFAULTS, k)) { problems.push(`unrecognised key ${k}, not applied`); continue; }
    out[k] = v;
  }
  if (!raw) problems.push(`no config at ${file}: the strategy is private and names its two characters there`);
  return { ...out, problems };
}

const maxHealthOf = r => Number(String(r?.health ?? '').split('/')[1]) || Number(r?.max_health) || 0;

/**
 * Can this fleet run the brokers? Pure. `facts`: {hallOwned, passwordKnown, ranks: {agent: n}}, each
 * read by the caller; null means "not known", which refuses — a gate that guesses open is no gate.
 */
export function gate(cfg, rows = [], facts = {}) {
  const why = [];
  if (cfg?.enabled === false) why.push('switched off in its config');
  const { manager, go_between: go } = cfg ?? {};
  if (!manager || !go) why.push('the config must name a manager and a go-between');
  else if (manager === go) why.push('the manager and the go-between must be two characters');
  if (facts.hallOwned !== true) why.push(facts.hallOwned === false
    ? `the fleet does not own hall ${cfg?.hall}` : `could not confirm the fleet owns hall ${cfg?.hall}`);
  if (facts.passwordKnown !== true) why.push('the chest password is not recorded for this fleet');
  for (const [role, agent] of [['manager', manager], ['go-between', go]]) {
    if (!agent) continue;
    const r = rows.find(x => x.agent === agent);
    if (!r) { why.push(`${role} ${agent} is not in the fleet reading`); continue; }
    if (maxHealthOf(r) < PKILL_ENABLE_HP)
      why.push(`${role} ${agent} is under ${PKILL_ENABLE_HP} max health: the guardian angel keeps it out of the hall`);
    const rank = facts.ranks?.[agent];
    if (rank == null) why.push(`${role} ${agent}: guild rank unknown`);
    else if (rank < RANK_SIR) why.push(`${role} ${agent} is rank ${rank}; the main door opens from rank ${RANK_SIR} (sir)`);
  }
  return { ok: why.length === 0, why };
}

// ------------------------------------------------------------------ the ticket book
export const TICKETS_FILE = (fleet = 'prod') =>
  process.env.M59_VAULT_TICKETS || here(`../substrate/history/${fleet}/vault-broker/tickets.json`);

const KINDS = new Set(['deposit', 'withdraw']);
export const parseItems = (s = '') => String(s).split(',').map(x => x.trim()).filter(Boolean).map(x => {
  const m = /^(.+?)(?::(\d+))?$/.exec(x);
  return { item: m[1].trim(), amount: m[2] ? Number(m[2]) : 1 };
}).filter(x => x.item && x.amount > 0);

export class TicketBook {
  constructor(file) { this.file = file; }
  read() {
    try { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { next: 1, tickets: [] }; }
    catch { return { next: 1, tickets: [] }; }
  }
  write(book) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(book, null, 1));
    renameSync(tmp, this.file);
  }
  /** File a request. `where` is the room the customer will wait in (the inn by default). */
  request({ kind, from, items, where = null, now = Date.now(), ttlMs = DEFAULTS.ticket_ttl_ms }) {
    if (!KINDS.has(kind)) throw new Error(`kind must be deposit or withdraw, not ${kind}`);
    if (!from) throw new Error('a ticket needs --from <agent>');
    if (!items?.length) throw new Error('a ticket needs --items');
    const book = this.read();
    const t = { id: `vb-${book.next++}`, kind, from, items, where, status: 'open', at: now,
                expires: now + ttlMs, moved: [] };
    book.tickets.push(t);
    this.write(book);
    return t;
  }
  open(now = Date.now()) {
    return this.read().tickets.filter(t => t.status === 'open' || t.status === 'working')
      .filter(t => !(t.expires < now && t.status === 'open'));
  }
  update(id, patch) {
    const book = this.read();
    const t = book.tickets.find(x => x.id === id);
    if (!t) return null;
    Object.assign(t, patch, { updated: Date.now() });
    this.write(book);
    return t;
  }
}

// ------------------------------------------------------------------ what fits
/** Free weight and bulk from a fleet row's `pack` ({weight, bulk, max}), keeping `keepFree` spare. */
export function freeRoom(row, keepFree = 0) {
  const p = row?.pack;
  if (!p || !Number.isFinite(Number(p.max)) || p.exact === false) return null;   // unknown is no room
  const max = Number(p.max), spare = max * keepFree;
  return { weight: Math.max(0, max - Number(p.weight) - spare), bulk: Math.max(0, max - Number(p.bulk) - spare) };
}

/**
 * Split a deposit into what the carrier can take now and what waits, by weight and bulk.
 * `weigh(name)` -> {weight, bulk} per unit, or null when unknown (unknown is refused, not guessed).
 */
export function whatFits(items, room, weigh) {
  const take = [], leave = [];
  if (!room) return { take, leave: items.slice(), why: 'the carrier\'s pack is not known' };
  let w = room.weight, b = room.bulk;
  for (const it of items) {
    const u = weigh(it.item);
    if (!u || !Number.isFinite(u.weight) || !Number.isFinite(u.bulk)) { leave.push(it); continue; }
    const n = Math.min(it.amount, u.weight > 0 ? Math.floor(w / u.weight) : it.amount,
                       u.bulk > 0 ? Math.floor(b / u.bulk) : it.amount);
    if (n > 0) { take.push({ item: it.item, amount: n }); w -= n * u.weight; b -= n * u.bulk; }
    if (n < it.amount) leave.push({ item: it.item, amount: it.amount - n });
  }
  return { take, leave };
}

// ------------------------------------------------------------------ CLI
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const fleet = arg('fleet', 'prod');
  const book = new TicketBook(TICKETS_FILE(fleet));
  const [verb, kind] = argv;
  if (verb === 'request') {
    const t = book.request({ kind, from: arg('from'), items: parseItems(arg('items', '')),
                             where: arg('at') ? Number(arg('at')) : null });
    console.log(`filed ${t.id}: ${t.kind} for ${t.from}: ${t.items.map(i => `${i.amount} ${i.item}`).join(', ')}`);
  } else if (verb === 'status') {
    const open = book.open();
    if (!open.length) console.log('no open tickets');
    for (const t of open) console.log(`${t.id} ${t.status.padEnd(7)} ${t.kind.padEnd(8)} ${t.from}: ` +
      t.items.map(i => `${i.amount} ${i.item}`).join(', '));
  } else if (verb === 'gate') {
    const cfg = loadConfig();
    for (const p of cfg.problems) console.log(`config: ${p}`);
    console.log(JSON.stringify({ manager: cfg.manager, go_between: cfg.go_between, hall: cfg.hall, inn: cfg.inn }));
    console.log('(the live gate needs broker facts; the runner checks it before every shift)');
  } else {
    console.log('usage: gate | request deposit|withdraw --from <agent> --items "name:n,..." [--at <room>] | status');
    process.exit(2);
  }
}
