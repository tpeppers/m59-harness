// m59-hall-deposit.mjs -- what a guild-hall DEPOSIT list means, and how much of each stack goes in.
//
// `hall_withdraw`'s `deposit` used to put WHOLE stacks in: "elderberry" took all 432. The game
// itself has always been able to put part of a stack into a chest, and the client does it from
// the Put dialog's amount column:
//
//   - clientd3d/gameuser.c:339 UserPut asks for the objects with LD_AMOUNTS, the dialog stores the
//     typed quantity in obj->temp_amount (clientd3d/lookdlg.c, e.g. :313), and :366 sends one
//     RequestPut(obj, container) per object;
//   - clientd3d/protocol.c:42 declares BP_REQ_PUT as { PARAM_OBJECT, PARAM_ID }, and PARAM_OBJECT
//     (protocol.c:216-223) writes the id and, for a NUMBER-tagged id, the 4-byte temp_amount after it;
//   - blakserv/parsecli.c:362-388 reads a 4-byte TAG_OBJECT parm and, when its tag nibble is
//     CLIENT_TAG_NUMBER, takes the next 4 bytes as `number_stuff`;
//   - kod user.kod:1002-1006 hands it to UserPut as #number, and UserPut (user.kod:3882) Splits a
//     NumberItem by that number (numbitem.kod:253, `number >= 1 and number <= piNumber`) and offers
//     ONLY the split-off part to the chest (ReqNewOwner + ReqNewHold, StorageBox's ReqNewHold at
//     storebox.kod:153 checks only the room and CanBeStoredInVault). A refused part rejoins the pack.
//
// So a partial deposit is one BP_REQ_PUT with dropSpec(stack, n) -- the same number-tagged wire form
// the harness's put-back already uses (hallMove's putBack, the withdraw's surplus return). Nothing has
// to be split in the pack first. This module is the pure half: parsing the list and sizing each put.
//
// ENTRY FORMS (all old forms keep their meaning):
//   "elderberry"            every matching stack, whole               (substring of the item name)
//   "id:8123"               that one object, whole
//   "elderberry:150"        150 in total, across matching stacks, split where needed
//   "id:8123:150"           150 out of that one stack
//   { item: "elderberry", amount: 150 } / { id: 8123, amount: 150 }   the same, as objects
//   { item: "elderberry" } / { id: 8123 }                             whole, as objects
// An amount must be a positive whole number. A malformed entry is REFUSED, reported in `refused`, and
// matches nothing -- never read as "the whole stack", which is the opposite of what it asked for.

import { dropSpec } from './m59-parse.mjs';

const positive = n => Number.isInteger(n) && n >= 1;

function parseOne(d) {
  if (d && typeof d === 'object') {
    const amount = d.amount == null ? null : Number(d.amount);
    if (amount != null && !positive(amount)) return { refused: d, why: 'amount must be a positive whole number' };
    if (d.id != null) {
      const id = Number(d.id);
      if (!Number.isInteger(id) || id <= 0) return { refused: d, why: 'id must be a positive object id' };
      return { kind: 'id', id, amount, label: amount == null ? `id:${id}` : `id:${id}:${amount}` };
    }
    const name = String(d.item ?? d.name ?? '').toLowerCase().trim();
    if (!name) return { refused: d, why: 'an object entry needs `item` or `id`' };
    return { kind: 'name', name, amount, label: amount == null ? name : `${name}:${amount}` };
  }
  const s = String(d ?? '').toLowerCase().trim();
  if (!s) return { refused: d, why: 'empty entry' };
  let m = /^id:(\d+)$/.exec(s);
  if (m) return { kind: 'id', id: Number(m[1]), amount: null, label: s };
  m = /^id:(\d+):(\d+)$/.exec(s);
  if (m) {
    const amount = Number(m[2]);
    if (!positive(amount)) return { refused: d, why: 'amount must be a positive whole number' };
    return { kind: 'id', id: Number(m[1]), amount, label: s };
  }
  if (/^id:/.test(s)) return { refused: d, why: 'malformed id entry: use id:<n> or id:<n>:<amount>' };
  m = /^(.*\S)\s*:\s*(\d+)$/.exec(s);
  if (m) {
    const amount = Number(m[2]);
    if (!positive(amount)) return { refused: d, why: 'amount must be a positive whole number' };
    return { kind: 'name', name: m[1].trim(), amount, label: `${m[1].trim()}:${amount}` };
  }
  return { kind: 'name', name: s, amount: null, label: s };
}

/**
 * Parse a `deposit` list. Returns { entries, refused }. Each entry carries `remaining`, the budget
 * still to put in (null = whole stacks), which `depositPut` and the caller decrement.
 */
export function parseDeposit(deposit) {
  const entries = [], refused = [];
  for (const d of Array.isArray(deposit) ? deposit : []) {
    const e = parseOne(d);
    if (e.refused !== undefined) refused.push({ entry: e.refused, why: e.why });
    else entries.push({ ...e, remaining: e.amount });
  }
  return { entries, refused };
}

/**
 * The entry that governs pack row `o`, or null. An id entry wins over a name entry (it is the more
 * specific instruction), and an entry whose budget is spent matches nothing more.
 */
export function depositEntryFor(entries, o, nameOf) {
  const live = e => e.remaining == null || e.remaining > 0;
  const byId = entries.find(e => e.kind === 'id' && e.id === Number(o?.id) && live(e));
  if (byId) return byId;
  if (entries.some(e => e.kind === 'id' && e.id === Number(o?.id))) return null;   // its id entry is spent
  const name = String(nameOf(o) ?? '').toLowerCase();
  return entries.find(e => e.kind === 'name' && name.includes(e.name) && live(e)) ?? null;
}

/**
 * The BP_REQ_PUT object for pack row `o` under `entry`: the whole stack when the entry has no amount
 * (exactly the old dropSpec(o)), otherwise min(remaining, stack) number-tagged. A non-stack object is
 * one unit and goes as its bare id. Returns { spec, asked } or null when nothing should go.
 */
export function depositPut(o, entry, cap = Infinity) {
  if (!o) return null;
  if (!entry || entry.remaining == null) return { spec: dropSpec(o), asked: Number(o.amount) >= 1 ? Number(o.amount) : 1 };
  if (entry.remaining <= 0) return null;
  const stack = Number(o.amount) >= 1;
  if (!stack) return { spec: dropSpec(o), asked: 1 };
  const n = Math.max(1, Math.min(entry.remaining, Number(o.amount), Number(cap) || Infinity));
  return { spec: dropSpec(o, n), asked: n };
}

/** How many pack units the parsed list still wants per entry, for the reply (`deposit_short`). */
export function depositShort(entries) {
  return Object.fromEntries(entries.filter(e => e.amount != null && e.remaining > 0).map(e => [e.label, e.remaining]));
}

/** Count the inventory rows (`{id, name, amount}`) a deposit list matches -- the before/after reading. */
export function countDepositMatches(items, deposit) {
  const { entries } = parseDeposit(deposit);
  const ids = new Set(entries.filter(e => e.kind === 'id').map(e => e.id));
  const names = entries.filter(e => e.kind === 'name').map(e => e.name);
  return (items ?? []).filter(i => ids.has(Number(i.id)) || names.some(n => String(i.name ?? '').toLowerCase().includes(n)))
    .reduce((n, i) => n + (Number(i.amount) || 1), 0);
}
