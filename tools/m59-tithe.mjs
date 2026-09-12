// GUILD TITHES — exact payment plus the durable once-per-day book.
//
// The server provides no tithe ledger. Frular accepts shillings by cancelling an offer,
// so the only proof is that the payer's purse fell. The book therefore records only the
// verified purse delta, never the intended offer, and survives broker/keeper restarts.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';
import { SAY_RADIUS, squaredDistance, withinSayRange,
         sayApproachSquare } from './m59-sayrange.mjs';
import { StorageCache } from './m59-storage.mjs';

// WHICH FLEET'S BOOK, ANSWERED ONCE.
//
// The book is keyed `<fleet>-<agent>.json`, so two answers to "which fleet" are two books
// for the same character — and the failure is quiet in the expensive direction: a keeper
// writing to `default-t14` while a tool reads `prod-t14` sees `paid_today: 0` all day and
// tithes again every time it sells. The keeper derived the name from argv/env with a
// literal 'default' fallback while the broker resolved it properly, so a broker started
// with no `--fleet` but a `substrate/fleet-default` of `prod` split them. `fleetName()` is
// the same resolver every other fleet tool uses, in the same order.
export const titheFleet = (argv, env) => fleetName(argv, env) || 'default';

export const FRULAR_ROOM = 700;
export const FRULAR_NAME = 'Frular';

export function parseRentLine(lines) {
  for (const raw of [].concat(lines ?? [])) {
    const text = String(raw);
    if (/belongest to no guild/i.test(text))
      return { in_guild: false, due: null, credit: null, said: text };
    let match = text.match(/owes\s+(\d+)\s+coins?\s+in\s+rent/i);
    if (match) return { in_guild: true, due: Number(match[1]), credit: -Number(match[1]), said: text };
    match = text.match(/has a positive balance of\s+(\d+)\s+shillings?/i);
    if (match) return { in_guild: true, due: -Number(match[1]), credit: Number(match[1]), said: text };
    if (/owest\s+no\s+rent/i.test(text))
      return { in_guild: true, due: 0, credit: 0, said: text };
  }
  return null;
}

export function parseRentHours(lines) {
  for (const raw of [].concat(lines ?? [])) {
    const text = String(raw);
    if (/less than an hour/i.test(text)) return 0.5;
    if (/have an hour to pay/i.test(text)) return 1;
    const match = text.match(/have\s+(\d+)\s+hours?\s+to pay/i);
    if (match) return Number(match[1]);
  }
  return null;
}

export const TITHE_DIR = process.env.M59_TITHE_DIR ||
  fileURLToPath(new URL('../substrate/guild-tithes', import.meta.url));

const safe = value => String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64) || 'unnamed';

export function localDayKey(at = Date.now()) {
  const d = new Date(at);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')].join('-');
}

export function tithePaymentPlan({ dailyAmount, paidToday = 0, saleProceeds = 0,
                                   purse = 0, walkingMoney = 0 } = {}) {
  const target = Math.max(0, Math.floor(Number(dailyAmount) || 0));
  const paid = Math.max(0, Math.floor(Number(paidToday) || 0));
  const remaining = Math.max(0, target - paid);
  const proceeds = Math.max(0, Math.floor(Number(saleProceeds) || 0));
  const available = Math.max(0, Math.floor(Number(purse) || 0) -
    Math.max(0, Math.floor(Number(walkingMoney) || 0)));
  const amount = Math.min(remaining, proceeds, available);
  return { target, paid, remaining, proceeds, available, amount };
}

export class TitheBook {
  constructor({ agent, fleet = 'default', dir = TITHE_DIR } = {}) {
    this.agent = safe(agent);
    this.fleet = safe(fleet);
    this.dir = resolve(dir);
    this.path = join(this.dir, `${this.fleet}-${this.agent}.json`);
  }

  read() {
    if (!existsSync(this.path)) return { days: {} };
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value)
        ? { ...value, days: value.days && typeof value.days === 'object' ? value.days : {} }
        : { days: {} };
    } catch { return { days: {} }; }
  }

  paidToday(at = Date.now()) {
    return Math.max(0, Number(this.read().days[localDayKey(at)]?.paid) || 0);
  }

  record(paid, { at = Date.now(), detail = {} } = {}) {
    const amount = Math.max(0, Math.floor(Number(paid) || 0));
    if (!amount) return this.read();
    const all = this.read(), day = localDayKey(at);
    const was = all.days[day] ?? {};
    all.agent = this.agent;
    all.fleet = this.fleet;
    all.days[day] = { ...was, paid: (Number(was.paid) || 0) + amount,
      last_at: at, ...detail };
    // A year is more than this decision needs and bounds an unattended fleet's state.
    const keys = Object.keys(all.days).sort();
    for (const old of keys.slice(0, Math.max(0, keys.length - 370))) delete all.days[old];
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
    renameSync(tmp, this.path);
    return all;
  }
}

export const purseAmount = c => (c.inventory || [])
  .filter(i => (c.rsc.get(i.nameRsc) || '').toLowerCase() === 'shilling')
  .reduce((n, i) => n + (i.amount ?? 1), 0);

// FRULAR CANNOT HEAR YOU FROM ACROSS THE ROOM, AND THE SERVER SAYS NOTHING ABOUT IT.
//
// `Holder.SomeoneSaid` (holder.kod:585) does not broadcast speech to a monster unconditionally
// — it gates every hearer on `SayRangeCheck` (holder.kod:604), and for a USER talking to a
// MONSTER that is not `IsFullTalk` it drops the message entirely when
// `SquaredDistanceTo > SAY_RADIUS`. SAY_RADIUS is 50 (blakston.khd:1299) and it is compared
// against a SQUARED distance, so the real reach is about seven squares. Frular's attributes
// are `MOB_NOMOVE | MOB_NOFIGHT | MOB_LISTEN | MOB_RECEIVE` (gcreator.kod:74) — no
// MOB_FULL_TALK — so he is range-limited like any other monster.
//
// Dropped speech is not refused speech. Nothing is sent back, the word is not echoed to him,
// and from this side it is indistinguishable from Frular having no answer. THAT is why the
// rent balance has never once been read on this fleet: `credit_after` is null on all eleven
// tithes in the book, from 2026-08-12 onward, and a guildmaster standing in room 700 on
// 2026-08-12 said "rent" twice and got only his own echo. Measured again 2026-09-11 on a
// guild that HAD a hall and a large credit, where a real answer was due: Gonzo asked from
// twelve squares away (squared 148, against a limit of 50) and heard nothing.
//
// AND THE TITHE ITSELF IS NOT AFFECTED, which is exactly what made this so hard to see. An
// offer is a trade, not speech, and `ReqOffer` has only a same-room check (gcreator.kod:331).
// So paying works from anywhere in the room and reading the balance does not — the money
// moves, the question vanishes, and the record says the payment succeeded with an unknown
// balance. Every time.
// The rule itself lives in m59-sayrange.mjs, because FleetScript's `say` step needs the
// same one and a game rule with two homes is how one of them goes quietly wrong.
// Re-exported so existing callers and m59-tithe-test.mjs keep their import.
export { SAY_RADIUS, squaredDistance, withinSayRange, sayApproachSquare };

async function askRent(s, c) {
  // STAND CLOSE ENOUGH TO BE HEARD FIRST. Without this the say is swallowed by SayRangeCheck
  // and the caller records "no answer" as though it were a fact about the guild's rent.
  const frular = [...(c.room?.objects?.values() ?? [])]
    .find(o => (c.rsc.get(o.nameRsc) || '') === FRULAR_NAME);
  const me = c.self ?? null;
  let approached = null;
  if (frular && withinSayRange(me, frular) === false) {
    const near = s.world?.approachSquare?.(frular.col, frular.row);
    if (near) {
      approached = await s.walkTo(near.col, near.row, { maxSteps: near.steps + 8 })
        .catch(error => ({ arrived: false, reason: error.message }));
    } else {
      approached = { arrived: false, reason: 'no approach square to Frular' };
    }
  }

  const before = c.evSeq;
  await s.pacer.submit('say', () => c.say('rent'));
  const { events } = await c.waitFor({ since: before, timeoutMs: 4000 });
  const said = events.filter(e => e.text).map(e => String(e.text));

  // SAY WHY IT WAS SILENT, rather than reporting silence as an answer. A reading taken from
  // out of earshot is a question nobody asked, and it must not be filed as "no rent due".
  const heardFrom = frular ? withinSayRange(c.self ?? me, frular) : null;
  const out_of_earshot = heardFrom === false;
  return { said, rent: parseRentLine(said), hours_left: parseRentHours(said),
           ...(approached ? { approached } : {}),
           ...(out_of_earshot ? { out_of_earshot: true,
             why: `too far from ${FRULAR_NAME} to be heard — SayRangeCheck drops a user's ` +
                  `speech to a non-MOB_FULL_TALK monster beyond SAY_RADIUS ${SAY_RADIUS} ` +
                  `(squared, holder.kod:604). Silence here is NOT evidence about the rent.` }
            : {}) };
}

export async function guildRentStatus(s) {
  const c = s.need(), room = s.world?.room?.num ?? null;
  const frular = [...(c.room?.objects?.values() ?? [])]
    .find(o => (c.rsc.get(o.nameRsc) || '') === FRULAR_NAME);
  if (!frular) return { ok: false, reason: `${FRULAR_NAME} is not in this room`, room,
    go_to: FRULAR_ROOM,
    note: `travel to ${FRULAR_ROOM} (The Guildmaster's Hall, Barloque)` };
  const r = await askRent(s, c);

  // WRITE IT DOWN, because until this line nothing ever did.
  //
  // `guildStoreAvailable` gates the entire guild stockpile on a cached rent reading, and
  // `StorageCache.writeRent` had exactly one caller in the repository: its own test. So the
  // gate asked for a fact no production path could produce, and every character's
  // `guildWants` sat enabled and inert behind "nobody has asked Frular about the guild yet".
  // Same shape as the chest cache, and invisible for the same reason — the feature does not
  // fail, it declines.
  //
  // ONLY A LINE WE ACTUALLY PARSED. `askRent` argues at length that silence from out of
  // earshot is not evidence about the rent; caching that silence would promote a question
  // nobody heard into a durable fact, and the gate would read it as an answer for ever. An
  // unparsed reply is the same case: Frular said something we do not understand, which is
  // not a rent.
  if (r.rent && !r.out_of_earshot) {
    try {
      new StorageCache().writeRent({
        due: r.rent.due, credit: r.rent.credit, in_guild: r.rent.in_guild,
        hours_left: r.hours_left, said: r.rent.said,
        by: c.me?.name ?? s.name ?? null,
      });
    } catch { /* the record is a convenience; never let it interrupt the errand */ }
  }

  return { action: 'status', room, purse: purseAmount(c), due: r.rent?.due ?? null,
    credit: r.rent?.credit ?? null, hours_until_arrears: r.hours_left,
    frular_said: r.said,
    // SAY WHETHER IT WAS RECORDED, so a caller can tell "asked and cached" from "asked and
    // the answer was unusable" without re-reading the file.
    recorded: !!(r.rent && !r.out_of_earshot),
    ...(r.out_of_earshot ? { out_of_earshot: true, why: r.why } : {}),
    ...(!r.rent && !r.out_of_earshot
      ? { why: 'nothing in the reply parsed as a rent line, so nothing was cached — ' +
               'an answer we cannot read is not an answer about the rent' }
      : {}) };
}

export async function payGuildTithe(s, { amount = 0, all = false } = {}) {
  const c = s.need(), room = s.world?.room?.num ?? null;
  const frular = [...(c.room?.objects?.values() ?? [])]
    .find(o => (c.rsc.get(o.nameRsc) || '') === FRULAR_NAME);
  if (!frular) return { ok: false, reason: `${FRULAR_NAME} is not in this room`, room,
    go_to: FRULAR_ROOM };

  await s.pacer.submit('read', () => c.requestInventory());
  await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
  const stack = (c.inventory || [])
    .find(i => (c.rsc.get(i.nameRsc) || '').toLowerCase() === 'shilling');
  const have = stack ? (stack.amount ?? 1) : 0;
  if (!stack || have < 1) return { ok: false, reason: 'carrying no shillings', purse: 0 };
  const asked = all ? have : Math.floor(Number(amount) || 0);
  if (!(asked > 0)) throw new Error('pay needs a positive `amount`, or all:true');
  const offered = Math.min(asked, have);

  const before = c.evSeq;
  await s.pacer.submit('trade', () => c.offer(frular.id, [{ id: stack.id, amount: offered }]));
  const { events } = await c.waitFor({ since: before, timeoutMs: 5000 });
  const said = events.filter(e => e.text).map(e => String(e.text));
  await s.pacer.submit('trade', () => c.cancelOffer()).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 800));
  await s.pacer.submit('read', () => c.requestInventory());
  await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
  const after = purseAmount(c), paid = have - after;
  const r = await askRent(s, c);
  return { action: 'pay', room, offered, purse_before: have, purse_after: after,
    paid, ok: paid > 0, thanked: said.some(x => /thank thee for thy payment/i.test(x)),
    frular_said: said, due: r.rent?.due ?? null, credit: r.rent?.credit ?? null,
    hours_until_arrears: r.hours_left };
}
