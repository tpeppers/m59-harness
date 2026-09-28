#!/usr/bin/env node
// THE VAULT DESK — the guild hall vault brokers, working. The loop on top of m59-vault-broker.mjs.
//
//   node tools/m59-vault-desk.mjs run                 work the desk until Ctrl-C
//   node tools/m59-vault-desk.mjs run --once          one poll and whatever tickets it finds, then stop
//   node tools/m59-vault-desk.mjs run --no-yield      the disciples are not in a training run
//   touch substrate/history/<fleet>/vault-broker/STOP  stop it gracefully (manager to the chests, both released)
//
// Operator, 2026-09-27 (the spec is in m59-vault-broker.mjs and the vault-broker memory). In short:
//   * The CHEST MANAGER stands in the BOOTH (714 rows 2-3 col 25), the window whose offers and speech
//     reach the foyer. It walks booth -> chests -> booth for every store and fetch, through counter
//     door 58 and the password door. It never opens the main door (hall_post refuses to).
//   * The GO-BETWEEN stands in the Brownestone Inn (106) and carries for characters under 30 max
//     health, whom the guardian angel keeps out of every guild hall room, foyer included
//     (player.kod:11735-11757). It walks inn -> foyer, trades across the window, walks back.
//   * A customer of 30+ max health is served at the window directly: they stand in the foyer.
//   * Between customers both practise (m59-practice-once.mjs): one cast, never a walk.
//
// HOW A CUSTOMER ASKS. A bot files a ticket (m59-vault-broker.mjs `request`). A person tells either
// desk character the operator's format, the same UX as the chalice desk:
//     "[Service Request] 100 elders"          withdraw (several: "100 elders, 20 emeralds")
//     "[Service Request] deposit"             then offer the items; the desk counters with nothing
//     "[Service Request] services" / "cancel" / "status"
// Only a character on this fleet's roster is served; a stranger's tell is logged and ignored.
//
// ONE TICKET AT A TIME. The manager has one body and one pack, and every step is a walk or a trade
// that has to finish before the next. A queue answers "N ahead of you".
//
// OWNERSHIP OF THE TWO BODIES. They are m59-harness-3f's disciples. Before starting, this writes the
// training-yield requests (m59-keep-training.mjs) and waits for `<agent>.yielded`, keeps the requests
// fresh while it runs (a request older than 30 minutes is treated as abandoned), and deletes them on
// the way out. It holds a commander lease on both (work and movement) so the DUM leaves them alone.
import { existsSync, mkdirSync, writeFileSync, unlinkSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, gate, TicketBook, TICKETS_FILE, freeRoom, whatFits, PKILL_ENABLE_HP } from './m59-vault-broker.mjs';
import { checkItemName, weighItem } from './m59-items.mjs';
import { practiceOnce } from './m59-practice-once.mjs';
import { serviceReplyText, humanMark, chaliceStoreFor } from './m59-chalice.mjs';

export const HALL = 714, INN = 106;

// ------------------------------------------------------------------ what a person asked for

// What people call things, mapped to the item's name. Anything not here goes to the item datastore,
// which also accepts plurals ("emeralds"); a name it cannot place is asked about, never guessed.
export const ALIASES = Object.freeze({
  elder: 'elderberry', elders: 'elderberry', elderberries: 'elderberry', berries: 'elderberry', berry: 'elderberry',
  teeth: 'orc tooth', tooth: 'orc tooth', 'orc teeth': 'orc tooth',
  wings: 'fairy wing', 'fairy wings': 'fairy wing',
  inky: 'inky-cap mushroom', inkies: 'inky-cap mushroom', 'inky caps': 'inky-cap mushroom', 'inky cap': 'inky-cap mushroom',
  purples: 'purple mushroom', 'purple mushrooms': 'purple mushroom',
  herbs: 'herb', gold: 'shilling', coins: 'shilling', money: 'shilling', shillings: 'shilling',
  emmies: 'emerald', emeralds: 'emerald', sapphires: 'sapphire', rubies: 'ruby', diamonds: 'diamond',
});

/** The item a person meant: {item} or {why}. */
export function resolveWanted(name, check = checkItemName) {
  const raw = String(name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!raw) return { why: 'no item named' };
  if (ALIASES[raw]) return { item: ALIASES[raw] };
  const c = check(raw);
  if (c?.ok) return { item: c.canonical ?? raw };
  if (c?.suggestions?.length === 1) return { item: c.suggestions[0] };
  return { why: c?.suggestions?.length ? `"${raw}": did you mean ${c.suggestions.slice(0, 3).join(', ')}?`
                                       : `"${raw}" is not an item I know` };
}

const PREFIX = /^\s*\[\s*service\s+request\s*\]\s*/i;
/** Colour codes (~B, ~k, ~b ...) out, the operator's prefix recognised. */
export function cleanLine(text) {
  const t = String(text ?? '').replace(/~[A-Za-z]/g, '').trim();
  return { prefixed: PREFIX.test(t), body: t.replace(PREFIX, '').trim() };
}

/**
 * A request, or null when the line is not one. `items` are unresolved names: {name, amount}.
 *   menu | cancel | status | deposit | withdraw {items}
 */
export function parseVaultRequest(text) {
  const t = String(text ?? '').toLowerCase().replace(/[.!?]+$/, '').replace(/(\d),(\d{3})/g, '$1$2')
    .replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (/^(services?|menu|help|what do you (offer|have)|vault)$/.test(t)) return { kind: 'menu' };
  if (/^(cancel|never ?mind|nvm|forget it)$/.test(t)) return { kind: 'cancel' };
  if (/^(status|where am i|queue)$/.test(t)) return { kind: 'status' };
  if (/^(deposit|store|stash|put away)( (it|this|these|them|stuff|my stuff))?$/.test(t)) return { kind: 'deposit' };
  const body = t.replace(/^(withdraw|get|fetch|give me|need|i need|want|i want)\s+/, '');
  const items = [];
  for (const piece of body.split(/\s*(?:,|\band\b|\+|&)\s*/).filter(Boolean)) {
    let m;
    if ((m = /^(\d+)\s*x?\s+(.+)$/.exec(piece))) items.push({ name: m[2], amount: Number(m[1]) });
    else if ((m = /^(.+?)\s+x?\s*(\d+)$/.exec(piece))) items.push({ name: m[1], amount: Number(m[2]) });
    else if ((m = /^(?:an?|one)\s+(.+)$/.exec(piece))) items.push({ name: m[1], amount: 1 });
    else return null;                                   // a bare word is chat, not an order
  }
  return items.length && items.every(i => i.amount > 0 && i.amount <= 100_000) ? { kind: 'withdraw', items } : null;
}

// ------------------------------------------------------------------ who is served, and where

const maxHealthOf = r => Number(String(r?.health ?? '').split('/')[1]) || Number(r?.max_health) || 0;
const same = (a, b) => a != null && b != null && String(a).toLowerCase().trim() === String(b).toLowerCase().trim();

/** The fleet row for an agent id or a character name. */
export const rowFor = (rows, who) => rows.find(r => same(r.agent, who) || same(r.character, who)) ?? null;

/**
 * WHERE A CUSTOMER IS SERVED. 30+ max health: at the window, standing in the hall's foyer. Under it:
 * at the inn, through the go-between — the angel refuses them the foyer.
 */
export const routeFor = row => (maxHealthOf(row) >= PKILL_ENABLE_HP ? 'window' : 'inn');

export function menuText(cfg, names) {
  return `vault desk: "[Service Request] 100 elderberry" withdraws (several: "100 elders, 20 emeralds"); ` +
    `"[Service Request] deposit" then offer me the items. Under ${PKILL_ENABLE_HP} max health: ${names.go_between} ` +
    `at the Brownestone Inn. ${PKILL_ENABLE_HP}+: the Bookmaker's hall foyer, by the booth (${names.manager}).`;
}

/** Stacks in a pack that make up `amount` of `item`, as supply/trade specs. */
export function specsFor(pack, item, amount) {
  const out = [];
  let left = amount;
  for (const o of (pack ?? []).filter(o => same(o.name, item))) {
    if (left <= 0) break;
    const n = Number(o.amount) || 1;                    // amount 0/absent is one non-stacking item
    if (!(Number(o.amount) > 0)) { out.push(o.id); left -= 1; continue; }
    const take = Math.min(n, left);
    out.push(take === n ? { id: o.id, amount: n } : { id: o.id, amount: take });
    left -= take;
  }
  return { specs: out, short: Math.max(0, left) };
}
export const countOf = (pack, item) => (pack ?? []).filter(o => same(o.name, item))
  .reduce((n, o) => n + (Number(o.amount) > 0 ? Number(o.amount) : 1), 0);

// ------------------------------------------------------------------ the desk

export class VaultDesk {
  /**
   * @param call   async (tool, args, timeoutMs) — the broker
   * @param cfg    loadConfig() output
   * @param book   a TicketBook
   * @param humans () -> the chalice store's human marks, or {} (who is a person right now)
   */
  constructor({ call, cfg, book, humans = () => ({}), log = console.log, sleep = ms => new Promise(r => setTimeout(r, ms)),
                now = Date.now, practice = practiceOnce, ledgers = {} }) {
    Object.assign(this, { call, cfg, book, humans, log, sleep, now, practice, ledgers });
    this.M = cfg.manager; this.G = cfg.go_between;
    this.cursor = {};                                   // chat seq per desk agent
    this.rowsAt = 0; this.rowsCache = [];
    this.practiceTurn = 0;
  }

  async rows(fresh = false) {
    if (fresh || this.now() - this.rowsAt > 5_000) {
      const f = await this.call('fleet', {}, 60_000).catch(() => null);
      if (Array.isArray(f?.fleet)) { this.rowsCache = f.fleet; this.rowsAt = this.now(); }
    }
    return this.rowsCache;
  }
  async row(who, fresh = false) { return rowFor(await this.rows(fresh), who); }
  async pack(agent) { return (await this.call('inventory', { agent }, 60_000).catch(() => null))?.items ?? null; }
  names() {
    const r = this.rowsCache;
    return { manager: rowFor(r, this.M)?.character ?? this.M, go_between: rowFor(r, this.G)?.character ?? this.G };
  }
  isHuman(character) { return !!humanMark(this.humans(), character, this.now()); }

  async tell(from, to, what) {
    await this.call('say', { agent: from, type: 'tell', to, text: serviceReplyText(what) }, 30_000)
      .catch(e => this.log(`  tell to ${to} failed: ${e.message}`));
  }

  // ---------------------------------------------------------------- taking requests
  /** Read both desk characters' tells and says; file what is a request. Returns the lines acted on. */
  async poll() {
    const rows = await this.rows(true);
    const acted = [];
    for (const agent of [this.M, this.G]) {
      const r = await this.call('chat', { agent, since: this.cursor[agent] ?? 0, include_self: false,
                                          channels: ['dm', 'say'] }, 30_000).catch(() => null);
      if (!r) continue;
      if (r.seq?.[agent] != null) this.cursor[agent] = r.seq[agent];
      for (const line of r.messages ?? []) {
        const { prefixed, body } = cleanLine(line.text);
        if (line.channel !== 'dm' && !prefixed) continue;           // in the room, only the operator's format
        const req = parseVaultRequest(body);
        if (!req) { if (prefixed) await this.tell(agent, line.name, `I did not understand "${body}". Say "[Service Request] services" for the menu.`); continue; }
        const who = rowFor(rows, line.name);
        if (!who) { this.log(`  ignored ${line.name} (not on this fleet): ${body}`); continue; }
        acted.push(await this.take(agent, who, req, body));
      }
    }
    return acted;
  }

  /** One parsed request from a fleet character: answer it, or file it as a ticket. */
  async take(heardBy, who, req, body) {
    const name = who.character;
    const mine = this.book.open(this.now()).filter(t => same(t.from, name) || same(t.from, who.agent));
    if (req.kind === 'menu') { await this.tell(heardBy, name, menuText(this.cfg, this.names())); return { name, kind: 'menu' }; }
    if (req.kind === 'status') {
      const q = this.book.open(this.now());
      await this.tell(heardBy, name, mine.length
        ? mine.map(t => `${t.id} ${t.kind} ${t.status}, ${q.indexOf(t)} ahead`).join('; ') : 'nothing open for you');
      return { name, kind: 'status' };
    }
    if (req.kind === 'cancel') {
      const gone = mine.filter(t => t.status === 'open');
      for (const t of gone) this.book.update(t.id, { status: 'cancelled' });
      await this.tell(heardBy, name, gone.length ? `cancelled ${gone.map(t => t.id).join(', ')}`
        : mine.length ? 'already being worked — it cannot be cancelled now' : 'nothing to cancel');
      return { name, kind: 'cancel', cancelled: gone.length };
    }
    let items = [];
    if (req.kind === 'withdraw') {
      const bad = [];
      for (const i of req.items) {
        const r = resolveWanted(i.name);
        if (r.item) items.push({ item: r.item, amount: i.amount }); else bad.push(r.why);
      }
      if (bad.length) { await this.tell(heardBy, name, bad.join(' ')); return { name, kind: 'unclear', why: bad }; }
    }
    const t = this.book.request({ kind: req.kind, from: name, items: req.kind === 'deposit' ? [{ item: '*', amount: 1 }] : items,
                                  where: routeFor(who) === 'window' ? HALL : INN, now: this.now(), ttlMs: this.cfg.ticket_ttl_ms });
    this.book.update(t.id, { human: this.isHuman(name), said: body });
    const ahead = this.book.open(this.now()).filter(x => x.id !== t.id).length;
    const where = routeFor(who) === 'window'
      ? `come to the Bookmaker's hall foyer and stand by the booth`
      : `meet ${this.names().go_between} at the Brownestone Inn`;
    await this.tell(heardBy, name, `${t.id}: ${req.kind === 'deposit' ? 'deposit' : items.map(i => `${i.amount} ${i.item}`).join(', ')}` +
      ` — ${where}${ahead ? `; ${ahead} ahead of you` : ''}.`);
    return { name, kind: req.kind, ticket: t.id };
  }

  // ---------------------------------------------------------------- moving things
  /** Hand `item` x `amount` from one of ours to another, standing together. Returns what arrived. */
  async hand(from, to, item, amount) {
    const fromPack = await this.pack(from);
    const { specs } = specsFor(fromPack, item, amount);
    if (!specs.length) return 0;
    const before = countOf(await this.pack(to), item);
    await this.call('supply', { from, to, what: specs, who_travels: 'neither' }, 200_000).catch(e => this.log(`  supply failed: ${e.message}`));
    return Math.max(0, countOf(await this.pack(to), item) - before);
  }

  /** Offer to a PERSON and wait for their counter; accept. Returns what left the pack, by item. */
  async offerToPerson(agent, person, lines) {
    const pack = await this.pack(agent);
    const specs = lines.flatMap(l => specsFor(pack, l.item, l.amount).specs);
    if (!specs.length) return {};
    const r = await this.call('trade', { agent, action: 'offer', to: person, items: specs }, 30_000).catch(() => null);
    if (!r?.offered) return {};
    await this.tell(agent, person, 'offering it now — counter with nothing to accept.');
    const until = this.now() + this.cfg.offer_ms;
    while (this.now() < until) {
      const st = await this.call('trade', { agent, action: 'status' }, 15_000).catch(() => null);
      if (!st?.trade) return {};                                    // they cancelled
      if (st.trade.mayAccept) { await this.call('trade', { agent, action: 'accept' }, 30_000).catch(() => null); break; }
      await this.sleep(2_000);
    }
    const st = await this.call('trade', { agent, action: 'status' }, 15_000).catch(() => null);
    if (st?.trade) await this.call('trade', { agent, action: 'cancel' }, 15_000).catch(() => null);
    const after = await this.pack(agent);
    return Object.fromEntries(lines.map(l => [l.item, Math.max(0, countOf(pack, l.item) - countOf(after, l.item))]));
  }

  /** Wait for a PERSON's offer; counter with nothing. Returns what arrived: {item: n}. */
  async takeFromPerson(agent, person) {
    const before = await this.pack(agent);
    await this.tell(agent, person, 'offer me what goes in the chests; I will counter with nothing.');
    const until = this.now() + this.cfg.offer_ms;
    let countered = false;
    while (this.now() < until) {
      const st = await this.call('trade', { agent, action: 'status' }, 15_000).catch(() => null);
      const t = st?.trade;
      if (!countered && t?.role === 'recipient' && same(t.withName, person) && t.theirs?.length) {
        await this.call('trade', { agent, action: 'counter', items: [] }, 15_000).catch(() => null);
        countered = true;
      } else if (countered && !t) break;                           // they accepted, or cancelled
      await this.sleep(2_000);
    }
    return this.gained(before, await this.pack(agent));
  }

  gained(before, after) {
    const out = {};
    for (const o of after ?? []) {
      const n = countOf(after, o.name) - countOf(before, o.name);
      if (n > 0) out[o.name] = n;
    }
    return out;
  }

  /** Customer (a bot of ours) -> carrier. Everything the ticket lists, or all of it ('*' = unsupported for bots). */
  async takeFromBot(carrier, customerAgent, items) {
    const got = {};
    for (const i of items) {
      const room = freeRoom(await this.row(carrier, true), 0);
      const { take } = whatFits([i], room, weighItem);
      if (!take.length) continue;
      const n = await this.hand(customerAgent, carrier, i.item, take[0].amount);
      if (n) got[i.item] = n;
    }
    return got;
  }

  // ---------------------------------------------------------------- the manager's walks
  // THREE TRIES. A walk inside the hall can stop short and say so ("counter door trigger (2,19) not
  // reached", prod 2026-09-28 01:54, the manager left at (7,8)); the same route had just been walked.
  // A refusal that names the main door is final: that is the rule, not a stumble.
  async post(where) {
    let r = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await this.call('hall_post', { agent: this.M, where }, 300_000).catch(e => ({ ok: false, why: e.message }));
      if (r?.ok !== false) return r;
      if (/main door/i.test(r.why ?? '')) break;
      this.log(`  manager -> ${where}: ${r.why}; trying again`);
      await this.sleep(3_000);
    }
    throw new Error(`manager could not reach the ${where}: ${r?.why}`);
  }

  /** The manager stores `got` ({item: n}) and draws `wants`, in one chest visit, back at the booth. */
  async chestVisit({ deposit = {}, wants = [] }) {
    await this.post('chests');
    const pack = await this.pack(this.M);
    const depIds = Object.keys(deposit).flatMap(item => (pack ?? []).filter(o => same(o.name, item)).map(o => `id:${o.id}`));
    // The manager's own practice reagents merge into a deposited stack; draw them back in the same visit.
    const keep = this.cfg.practice ? Object.entries(this.cfg.practice_keep ?? {})
      .map(([item, n]) => ({ item, amount: Object.hasOwn(deposit, item) ? n : Math.max(0, n - countOf(pack, item)) }))
      .filter(w => w.amount > 0) : [];
    const draw = [...wants];
    for (const k of keep) { const w = draw.find(d => same(d.item, k.item)); if (w) w.amount += k.amount; else draw.push({ ...k }); }
    const r = await this.call('hall_withdraw', { agent: this.M, wants: draw, ...(depIds.length ? { deposit: depIds } : {}) }, 620_000)
      .catch(e => ({ ok: false, why: e.message }));
    await this.post('booth');
    if (r?.ok === false) throw new Error(`chest visit failed: ${r.why}`);
    // The kit's top-up is the desk's own, drawn last: what came goes to the customer first, and only
    // what the CUSTOMER asked for can be short.
    const took = { ...(r?.took ?? {}) }, short = {};
    for (const k of keep) {
      const want = wants.find(w => same(w.item, k.item))?.amount ?? 0;
      took[k.item] = Math.min(want, took[k.item] ?? 0);
    }
    for (const w of wants) {
      const n = Math.max(0, w.amount - (took[w.item] ?? 0));
      if (n) short[w.item] = n;
    }
    return { took, short };
  }

  // ---------------------------------------------------------------- the go-between's walks
  async goTo(agent, room) {
    const here = (await this.row(agent, true))?.room_num;
    if (Number(here) === room) return true;
    // THE JOURNEY'S OWN ANSWER FIRST. The fleet row lags a journey's end: on prod 2026-09-28 01:43:36
    // the go-between arrived (arrived:true, ended_in 106) while the row still read 101, and the desk
    // closed "could not reach the inn". Then the row, for up to 20 s.
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await this.call('travel', { agent, to: room, background: false }, 900_000).catch(() => null);
      if (r?.arrived === true || Number(r?.ended_in) === room) return true;
      for (let i = 0; i < 4; i++) {
        if (Number((await this.row(agent, true))?.room_num) === room) return true;
        await this.sleep(5_000);
      }
    }
    return false;
  }

  async waitFor(name, room) {
    const until = this.now() + this.cfg.meet_ms;
    while (this.now() < until) {
      if (Number((await this.row(name, true))?.room_num) === room) return true;
      await this.sleep(5_000);
    }
    return false;
  }

  // ---------------------------------------------------------------- one ticket, start to finish
  async work(t) {
    const rows = await this.rows(true);
    const who = rowFor(rows, t.from);
    if (!who) return this.close(t, 'abandoned', `${t.from} is not on this fleet`);
    const person = !!t.human || this.isHuman(who.character);
    const route = routeFor(who);
    const carrier = route === 'window' ? this.M : this.G;
    const meet = route === 'window' ? HALL : INN;
    this.book.update(t.id, { status: 'working', route, carrier });
    this.log(`${t.id}: ${t.kind} for ${who.character} (${person ? 'a person' : 'a bot'}) via the ${route}`);
    try {
      return t.kind === 'withdraw' ? await this.withdraw(t, who, person, carrier, meet)
                                   : await this.deposit(t, who, person, carrier, meet);
    } catch (e) {
      this.log(`  ${t.id} failed: ${e.message}`);
      await this.tell(this.G, who.character, `${t.id} could not be finished: ${e.message}`);
      return this.close(t, 'failed', e.message);
    }
  }

  close(t, status, note = null, extra = {}) {
    this.book.update(t.id, { status, note, ...extra });
    this.log(`  ${t.id}: ${status}${note ? ` — ${note}` : ''}`);
    return { id: t.id, status, note, ...extra };
  }

  async deliver(from, who, person, lines) {
    if (person) return this.offerToPerson(from, who.character, lines);
    const out = {};
    for (const l of lines) out[l.item] = await this.hand(from, who.agent, l.item, l.amount);
    return out;
  }

  async withdraw(t, who, person, carrier, meet) {
    const wants = t.items.map(i => ({ ...i }));
    const moved = {}, shortAll = {};
    for (let round = 0; round < 6 && wants.some(w => w.amount > 0); round++) {
      // AS MUCH AS BOTH PACKS HOLD: the manager's, and the go-between's when it carries.
      let room = freeRoom(await this.row(this.M, true), this.cfg.keep_free);
      if (carrier === this.G) {
        const g = freeRoom(await this.row(this.G, true), 0);
        room = room && g ? { weight: Math.min(room.weight, g.weight), bulk: Math.min(room.bulk, g.bulk) } : null;
      }
      const { take } = whatFits(wants.filter(w => w.amount > 0), room, weighItem);
      if (!take.length) throw new Error('nothing fits in the carrier\'s pack (or its weight is unknown)');
      const { took, short } = await this.chestVisit({ wants: take });
      Object.assign(shortAll, short);
      const got = take.map(l => ({ item: l.item, amount: Number(took[l.item] ?? 0) })).filter(l => l.amount > 0);
      if (!got.length) break;
      if (carrier === this.G) {
        if (!(await this.goTo(this.G, HALL))) throw new Error('the go-between could not reach the foyer');
        for (const l of got) l.amount = await this.hand(this.M, this.G, l.item, l.amount);
        if (!(await this.goTo(this.G, INN))) throw new Error('the go-between could not get back to the inn');
      }
      // THE GO-BETWEEN'S OWN TICKET: it is its own customer, so it walks to the window itself.
      const selfServe = same(who.agent, this.G);
      if (selfServe && !(await this.goTo(this.G, HALL))) throw new Error('the go-between could not reach the foyer');
      if (!(await this.waitFor(who.character, meet))) {
        // THE CARRIER KEEPS IT until they come: nothing is put back, the ticket stays open.
        await this.tell(carrier, who.character, `${t.id} is ready: ${got.map(l => `${l.amount} ${l.item}`).join(', ')} — ` +
          `${meet === INN ? 'come to the Brownestone Inn' : "come to the Bookmaker's hall foyer"}; it is held for you.`);
        return this.close(t, 'waiting', `${who.character} did not come to room ${meet} within ${Math.round(this.cfg.meet_ms / 60000)} min; ${carrier} is holding it`,
                          { held_by: carrier, holding: got, meet, moved });
      }
      const gave = await this.deliver(carrier, who, person, got);
      for (const [item, n] of Object.entries(gave)) {
        moved[item] = (moved[item] ?? 0) + n;
        const w = wants.find(x => same(x.item, item)); if (w) w.amount -= n;
      }
      if (selfServe) await this.goTo(this.G, INN);
      for (const l of got) if ((gave[l.item] ?? 0) < l.amount)
        return this.close(t, 'partial', `${who.character} did not take all of it; ${carrier} is holding the rest`, { moved });
      if (Object.keys(short).length) break;             // the chests are out: another round finds nothing
    }
    const shortText = Object.entries(shortAll).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ');
    await this.tell(carrier, who.character, `${t.id} done: ${Object.entries(moved).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing'}` +
      (shortText ? ` (the chests were short ${shortText})` : '') + '.');
    return this.close(t, shortText ? 'short' : 'done', shortText || null, { moved });
  }

  async deposit(t, who, person, carrier, meet) {
    if (!person && t.items.some(i => i.item === '*')) throw new Error('a bot deposit must list its items');
    if (carrier === this.G && !(await this.goTo(this.G, INN))) throw new Error('the go-between could not reach the inn');
    if (!(await this.waitFor(who.character, meet))) return this.close(t, 'abandoned', `${who.character} never came to room ${meet}`);
    const got = person ? await this.takeFromPerson(carrier, who.character) : await this.takeFromBot(carrier, who.agent, t.items);
    if (!Object.keys(got).length) return this.close(t, 'abandoned', 'nothing was handed over');
    if (carrier === this.G) {
      if (!(await this.goTo(this.G, HALL))) throw new Error('the go-between could not reach the foyer');
      for (const [item, n] of Object.entries(got)) {
        const arrived = await this.hand(this.G, this.M, item, n);
        if (arrived < n) this.log(`  only ${arrived} of ${n} ${item} crossed the window`);
      }
      await this.goTo(this.G, INN);
    }
    await this.chestVisit({ deposit: got });
    const text = Object.entries(got).map(([k, n]) => `${n} ${k}`).join(', ');
    await this.tell(carrier === this.G ? this.G : this.M, who.character, `${t.id} done: ${text} are in the chests.`);
    return this.close(t, 'done', null, { moved: got });
  }

  // ---------------------------------------------------------------- the shift
  async startShift() {
    // The manager: inside, at the booth. From the street or the foyer the ONE entry of the shift
    // goes through the main door (hall_withdraw with nothing wanted), then never again.
    const m = await this.row(this.M, true);
    if (Number(m?.room_num) !== HALL) {
      if (!(await this.goTo(this.M, HALL))) throw new Error('the manager could not reach the hall');
    }
    const r = await this.call('hall_post', { agent: this.M, where: 'booth' }, 300_000).catch(e => ({ ok: false, why: e.message }));
    if (r?.ok === false && /main door|foyer/i.test(r.why ?? '')) {
      this.log('manager is in the foyer: walking in once, to the chests');
      const w = await this.call('hall_withdraw', { agent: this.M, wants: [] }, 620_000).catch(e => ({ ok: false, why: e.message }));
      if (w?.ok === false) throw new Error(`manager could not get inside: ${w.why}`);
      await this.post('booth');
    } else if (r?.ok === false) await this.post('booth');
    // ROOM FOR CUSTOMERS: with shift_stash, whoever of the two is inside empties its pack into the
    // chests and keeps only the kit. The go-between does it only if already inside — it never walks in
    // for this. The manager does it from the chests and goes back to the booth.
    if (this.cfg.shift_stash) {
      const kitOf = agent => {
        const k = this.cfg.shift_kit ?? {};
        const mine = k[agent] && typeof k[agent] === 'object' ? k[agent] : k;
        return Object.entries(mine).filter(([, n]) => typeof n === 'number' && n > 0).map(([item, amount]) => ({ item, amount }));
      };
      for (const agent of [this.G, this.M]) {
        const kit = kitOf(agent);
        const row = await this.row(agent, true);
        if (Number(row?.room_num) !== HALL) continue;
        if (agent === this.M) await this.post('chests');
        else if (row?.position && row.position.row <= 4 && row.position.col >= 26) continue;   // in the foyer: not inside
        const s = await this.call('hall_withdraw', { agent, wants: [], stash: ['shilling'] }, 620_000).catch(e => ({ ok: false, why: e.message }));
        const d = await this.call('hall_withdraw', { agent, wants: kit, deposit: [...(this.cfg.shift_deposit ?? [])] }, 620_000)
          .catch(e => ({ ok: false, why: e.message }));
        this.log(`  ${agent} emptied its pack into the chests: ${s?.ok === false ? `stash FAILED ${s.why}` : `stashed ${s?.stashed ?? '?'}`}; ` +
                 `${d?.ok === false ? `deposit FAILED ${d.why}` : `protected reagents in, kit back ${JSON.stringify(d?.took ?? {})}`}`);
        if (agent === this.M) await this.post('booth');
      }
    }
    if (!(await this.goTo(this.G, INN))) throw new Error('the go-between could not reach the inn');
    this.log(`desk open: ${this.names().manager} at the booth, ${this.names().go_between} at the Brownestone Inn`);
  }

  /** Between customers: one practice cast, alternating characters. */
  async idle() {
    if (!this.cfg.practice) return this.sleep(this.cfg.poll_ms);
    const agent = this.practiceTurn++ % 2 ? this.G : this.M;
    const r = await this.practice({ call: this.call, agent, ledger: this.ledgers[agent] ?? null }).catch(e => ({ cast: false, why: e.message }));
    // THE MANAGER RE-DRAWS between customers: a chest visit tops practice_keep back up. At most every
    // ten minutes, so an empty chest is not walked to on every idle turn. The go-between cannot.
    if ((r?.restock || r?.foodRestock) && agent === this.M && this.now() - (this.redrewAt ?? 0) > 10 * 60_000) {
      this.redrewAt = this.now();
      await this.chestVisit({}).catch(e => this.log(`  practice re-draw failed: ${e.message}`));
      return r;
    }
    // THE GO-BETWEEN CANNOT REACH THE CHESTS, so its food is a ticket like any customer's: it walks to
    // the foyer and the manager hands bread across the window. One open at a time.
    if (r?.foodRestock && agent === this.G) {
      const g = (await this.row(this.G))?.character ?? this.G;
      const open = this.book.open(this.now()).some(t => (same(t.from, g) || same(t.from, this.G)) && t.kind === 'withdraw');
      const want = Number((this.cfg.shift_kit?.[this.G] ?? this.cfg.shift_kit ?? {})['loaf of bread']) || 10;
      if (!open) { this.book.request({ kind: 'withdraw', from: g, items: [{ item: 'loaf of bread', amount: want }], where: HALL,
                                       now: this.now(), ttlMs: this.cfg.ticket_ttl_ms });
                   this.log(`  ${g} is short of food: a ticket for ${want} bread from the chests`); }
    }
    if (!r?.cast) await this.sleep(Math.min(this.cfg.poll_ms, r?.retryInMs ?? this.cfg.poll_ms));
    return r;
  }

  /** A withdrawal held for a customer who did not come: handed over once they are there. */
  async resumeWaiting() {
    const book = this.book.read();
    for (const t of book.tickets.filter(x => x.status === 'waiting' && x.holding?.length)) {
      const who = await this.row(t.from, true);
      if (!who || Number(who.room_num) !== Number(t.meet)) continue;
      const gave = await this.deliver(t.held_by, who, !!t.human || this.isHuman(who.character), t.holding);
      const moved = { ...(t.moved ?? {}) };
      for (const [k, n] of Object.entries(gave)) moved[k] = (moved[k] ?? 0) + n;
      const all = t.holding.every(l => (gave[l.item] ?? 0) >= l.amount);
      if (all) await this.tell(t.held_by, who.character, `${t.id} done.`);
      return this.close(t, all ? 'done' : 'waiting', all ? null : 'not all of it was taken',
                        all ? { moved, holding: [] } : { moved, holding: t.holding.map(l => ({ ...l, amount: l.amount - (gave[l.item] ?? 0) })) });
    }
    return null;
  }

  /** One turn: take requests, hand over what is held, work the oldest open ticket, else practise. */
  async turn() {
    await this.poll();
    const resumed = await this.resumeWaiting();
    if (resumed) return { worked: resumed };
    const next = this.book.open(this.now()).filter(t => t.status === 'open')
      .sort((a, b) => a.at - b.at)[0];
    if (next) return { worked: await this.work(next) };
    return { idle: await this.idle() };
  }

  async endShift() {
    // Never leave anyone in the booth: a keeper without 7263b8f cannot find its way out of it.
    await this.call('hall_post', { agent: this.M, where: 'chests' }, 300_000).catch(() => null);
  }
}

// ------------------------------------------------------------------ the runner
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  const has = n => argv.includes(`--${n}`);
  const BROKER = process.env.M59_CONTROL_URL || 'http://127.0.0.1:8901';
  // hall_post is a KEEPER op; a broker started before it existed has no tool for it, so it goes to the
  // keeper directly (the 2026-09-27 probe did the same).
  const { discover, bandFor } = await import('./m59-keeperwhy.mjs');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const keeperAct = async (agent, name, args, ms) => {
    const k = (await discover(bandFor('prod', root)))[agent];
    if (!k) throw new Error(`no keeper for ${agent}`);
    const r = await fetch(`http://127.0.0.1:${k.port}/action`, { method: 'POST', headers: { 'content-type': 'application/json',
      'x-m59-agent': agent, 'x-m59-character': k.character, 'x-m59-keeper-pid': String(k.pid) },
      body: JSON.stringify({ name, args, agent }), signal: AbortSignal.timeout(ms) });
    return r.json();
  };
  let brokerHasHallPost = null;
  const call = async (name, args, ms = 60_000) => {
    if (name === 'hall_post') {
      if (brokerHasHallPost == null) {
        const l = await (await fetch(BROKER.replace(/\/?$/, '/'), { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })).json().catch(() => null);
        brokerHasHallPost = !!l?.result?.tools?.some(t => t.name === 'hall_post');
      }
      if (!brokerHasHallPost) {
        const r = await keeperAct(args.agent, 'hall_post', { where: args.where }, ms);
        return r?.result ?? r;
      }
    }
    const r = await fetch(BROKER.replace(/\/?$/, '/'), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(ms) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
    const t = j.result?.content?.[0]?.text ?? '';
    try { return JSON.parse(t); } catch { return t; }
  };
  const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  if (argv[0] !== 'run') { console.log('usage: run [--once] [--no-yield]'); process.exit(2); }

  const cfg = loadConfig();
  for (const p of cfg.problems) say(`config: ${p}`);
  const health = await (await fetch(`${BROKER.replace(/\/?$/, '/')}health`)).json();
  const fleet = health.fleet ?? 'prod';
  const rows = (await call('fleet', {})).fleet ?? [];
  const g = gate(cfg, rows, { hallOwned: cfg.hall_owned, passwordKnown: cfg.password_known, ranks: cfg.ranks });
  if (!g.ok) { say('the desk cannot open:'); for (const w of g.why) say(`  - ${w}`); process.exit(1); }

  // BORROW THE TWO BODIES from their training runner, by its own protocol.
  const ydir = join(health.root, 'substrate', 'history', fleet, 'training-yield');
  const agents = [cfg.manager, cfg.go_between];
  if (!has('no-yield')) {
    mkdirSync(ydir, { recursive: true });
    for (const a of agents) writeFileSync(join(ydir, a), `vault-desk:${process.pid} — working the guild hall vault desk\n`);
    say(`asked ${agents.join(', ')} to yield; waiting for their training runners`);
    const until = Date.now() + 15 * 60_000;
    while (!agents.every(a => existsSync(join(ydir, `${a}.yielded`)))) {
      if (Date.now() > until) { say('no yield after 15 min — is a training runner holding them? (--no-yield if none is)'); process.exit(1); }
      await new Promise(r => setTimeout(r, 5_000));
    }
    setInterval(() => { for (const a of agents) try { const f = join(ydir, a); utimesSync(f, new Date(), new Date()); } catch {} }, 10 * 60_000).unref();
  }

  // HOLD THEM against the DUM: a commander lease on both, beaten every 10 s.
  const pinOf = h => ({ fleet: h.fleet, broker_pid: h.pid,
    server_host: h.session_game_servers?.[cfg.manager]?.host ?? h.game_server?.host,
    server_port: Number(h.session_game_servers?.[cfg.manager]?.port ?? h.game_server?.port) });
  let pin = pinOf(health), lease = null;
  const leased = agents.map(a => ({ agent: a, character: health.session_characters?.[a] ?? rowFor(rows, a)?.character }));
  const owner = `vault-desk:${process.pid}`;
  const claim = async () => {
    const out = await call('commander_lease', { action: 'acquire', ...pin, agents: leased, owner, lease_ms: 30_000 }, 30_000).catch(e => ({ error: e.message }));
    lease = out?.lease_token ?? out?.token ?? null;
    if (!lease) say(`lease NOT held: ${JSON.stringify(out).slice(0, 200)}`);
  };
  const beat = async () => {
    if (lease) {
      const r = await call('commander_lease', { action: 'heartbeat', ...pin, agents: leased, lease_token: lease, owner, lease_ms: 30_000 }, 20_000)
        .catch(e => ({ error: e.message }));
      if (r?.error || [...(r?.agents ?? []), ...(r?.outcomes ?? [])].some(x => x?.granted === false)) lease = null;
    }
    if (!lease) {
      const h = await (await fetch(`${BROKER.replace(/\/?$/, '/')}health`)).json().catch(() => null);
      if (h?.pid) pin = pinOf(h);
      await claim();
    }
  };
  await claim();
  let beating = false;
  const beatTimer = setInterval(() => { if (beating) return; beating = true; beat().catch(() => {}).finally(() => { beating = false; }); }, 10_000);

  let chalice = null;
  try { chalice = chaliceStoreFor({ fleet }); } catch {}
  const { trainingLedger } = await import('./m59-training-ledger.mjs');
  const ledgers = {};
  for (const a of agents) ledgers[a] = await trainingLedger({ agent: a }).catch(() => null);
  const desk = new VaultDesk({ call, cfg, book: new TicketBook(TICKETS_FILE(fleet)), humans: () => chalice?.read()?.human ?? {},
                               log: say, ledgers });
  let stopping = false;
  const stop = async (why) => {
    if (stopping) return; stopping = true;
    say(`closing the desk: ${why}`);
    clearInterval(beatTimer);
    await desk.endShift().catch(() => {});
    if (lease) await call('commander_lease', { action: 'release', ...pin, agents: leased, lease_token: lease, owner }, 20_000).catch(() => {});
    if (!has('no-yield')) for (const a of agents) { try { unlinkSync(join(ydir, a)); } catch {} }
    process.exit(0);
  };
  process.on('SIGINT', () => stop('interrupted'));
  process.on('SIGTERM', () => stop('terminated'));
  // A STOP ALWAYS SAYS WHY (m59-harness-3f, 2026-09-28): a crash and a hard kill used to leave the
  // log ending at "desk open", which reads exactly like a desk still working.
  process.on('uncaughtException', e => { say(`CRASHED: ${e?.stack ?? e}`); stop('crashed').catch(() => process.exit(1)); });
  process.on('unhandledRejection', e => say(`unhandled rejection (still running): ${e?.message ?? e}`));
  process.on('exit', code => { if (!stopping) say(`exited (code ${code}) without closing — killed from outside? ` +
    'If so the manager may be in the booth and the training-yield requests may still be on disk'); });

  await desk.rows(true);
  await desk.startShift().catch(e => stop(`could not open: ${e.message}`));
  if (has('once')) { await desk.turn(); await stop('--once'); }
  // A GRACEFUL STOP FROM OUTSIDE: on Windows a background process cannot be sent Ctrl-C, and a hard
  // kill leaves the manager in the booth and the yield requests on disk. Touch this file instead;
  // the desk finishes its turn, walks the manager to the chests, releases both and deletes it.
  const stopFile = join(dirname(TICKETS_FILE(fleet)), 'STOP');
  for (;;) {
    if (stopping) break;
    if (existsSync(stopFile)) { try { unlinkSync(stopFile); } catch {} await stop(`stop file ${stopFile}`); break; }
    await desk.turn().catch(e => say(`turn failed: ${e.message}`));
  }
}
