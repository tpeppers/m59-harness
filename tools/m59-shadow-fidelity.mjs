#!/usr/bin/env node
// SHADOW FIDELITY — what a clone CARRIES, WEARS and BELONGS TO, as pure functions.
//
//   node tools/m59-shadow-fidelity.mjs --plan <snapshot.json>   what dress would create, per character
//
// `m59-shadow.mjs` (gitignored — it carries the shape of a real roster) snapshots production
// read-only and `dress`es the shadow copy over the lab's maintenance socket. Until
// 2026-09-24 `dress` copied attributes, max health, vigor and abilities, created only the
// wielded weapon, and placed the body. So a fresh clone had NO shillings, NO reagents, none
// of the pack (the fleet's one Chalice of the Rain included), no armour on, and no guild —
// and an errand rehearsed on it diverged at its first step: a guildless drinker of the
// chalice is Rescued to a random inn (rescue.kod `DoRescue` -> `AdminGoToSafety`), not to
// hall 714 where its production twin lands.
//
// Everything that DECIDES here is in this file and is pure, so it is pinned offline by
// `m59-shadow-fidelity-test.mjs`: which fields the snapshot reads off the broker's replies,
// which kod class a wire name becomes, and the exact maintenance-socket commands `dress`
// sends for a given snapshot and a given lab state. The gitignored tool only moves bytes.
//
// FOUR RULES, each of which is a bug this file exists because of:
//
// 1. `equipment` answers `equipped`, NOT `worn`. The snapshot read `eq.worn`, which the tool
//    has never returned, so every snapshot ever taken recorded an empty equipment list and
//    nobody noticed — an empty list looks exactly like a character wearing nothing.
//
// 2. A NAME IS RESOLVED BY `m59-itemclass.mjs` AND NEVER GUESSED. An unknown or ambiguous
//    name is REPORTED and nothing is created for it. `scroll` and `potion` resolve to their
//    base class but the thing prod carries has hidden state (which spell, identified or
//    not) the wire does not show; those are created and reported as APPROXIMATED.
//
// 3. A STACK IS A STATE, A NON-STACK IS A COUNT. A stack of herbs is set to prod's number
//    (piNumber), up or down, because a purse of 5,621 is the fact and topping up to it from
//    whatever a previous build left behind is not a copy. Non-stack items are topped up to
//    prod's count and the surplus is REPORTED; it is deleted only under `trim`, because
//    deleting objects out of a character is a destructive act somebody should ask for.
//
// 4. THE SHADOW <-> PROD MAPPING MUST NOT MOVE BETWEEN SNAPSHOTS. Slots were assigned by
//    FLEET ROW INDEX, and the fleet's row order is not stable (it is whatever order the
//    keepers came back in). Prod gained hk3 and reordered, so a fresh snapshot would have
//    re-pointed Aaaa — built as Statler — at Floyd, and `create` leaves an existing,
//    correctly named account alone. `assignShadowSlots` keeps every agent in the slot the
//    previous snapshot gave it and puts newcomers in the lowest free one.
import { readFileSync, existsSync } from 'node:fs';
import { resolveItemClass, itemClassIndex, KODDB } from './m59-itemclass.mjs';

// ---------------------------------------------------------------- the prod read gate
//
// PROD IS READ, NEVER WRITTEN — by TOOL and, for the one tool whose name covers both, by
// ACTION. `guild` answers `status` and also disbands, exiles and rents halls; its name alone
// would put all of those on the production side of a file whose whole promise is that it
// never writes there. A new action added upstream stays refused until somebody decides it
// is a read: the default is refusal.
export const PROD_READ_ONLY_TOOLS = new Set(['fleet', 'look', 'status', 'equipment', 'inventory',
                                             'abilities', 'guild']);
export const PROD_READ_ONLY_ACTIONS = { guild: new Set(['status', 'list', 'halls', 'may']) };

export function prodReadAllowed(name, args = {}) {
  if (!PROD_READ_ONLY_TOOLS.has(name))
    return { ok: false, why: `"${name}" is not a read-only tool — the prod side never writes` };
  const actions = PROD_READ_ONLY_ACTIONS[name];
  if (actions && !actions.has(String(args?.action ?? '')))
    return { ok: false, why: `"${name}" action "${args?.action}" is not a read — only ` +
                            `${[...actions].join('/')} may be asked of prod` };
  return { ok: true };
}

// ---------------------------------------------------------------- snapshot: reading replies

/** Names of what a character is WEARING/WIELDING, from the `equipment` tool's reply. */
export function equippedNames(eq, inv = null) {
  // `equipped` is the field; `worn` is what the old snapshot read and was never sent. Both
  // are accepted so a snapshot of an older broker still reads, but `equipped` wins.
  const list = eq?.equipped ?? eq?.worn ?? eq?.equipment?.equipped ?? eq?.equipment?.worn ?? [];
  // A NAME THE BROKER COULD NOT RESOLVE COMES BACK AS `<rsc undefined>`. Measured on prod
  // 2026-09-24: Zoot's two worn items read `chain armor`/`hammer` at one call and
  // `<rsc undefined>` twice at the next. Such a row is repaired from the INVENTORY reply read
  // in the same pass — by the item's id when it is a real one (positive: a negative id is
  // an array index, see CLAUDE.md), else from that reply's own `equipped` name list — and
  // is otherwise dropped rather than recorded as a name nothing can resolve.
  const bad = n => !n || /^<rsc\b/i.test(String(n));
  const invRows = inv?.items ?? inv?.inventory ?? [];
  const invNames = Array.isArray(inv?.equipped) ? inv.equipped.filter(n => typeof n === 'string' && !bad(n)) : [];
  const rows = list.map(x => (typeof x === 'string' ? { name: x } : x ?? {}));
  if (rows.some(r => bad(r.name)) && invNames.length === rows.length) return invNames;
  return rows.map(r => {
    if (!bad(r.name)) return r.name;
    const byId = Number(r.id) > 0 ? invRows.find(i => Number(i.id) === Number(r.id)) : null;
    return byId && !bad(byId.name) ? byId.name : null;
  }).filter(Boolean);
}

/** The pack, row by row, from the `inventory` tool's reply. `amount: 0` = one non-stack. */
export function packRows(inv) {
  return (inv?.items ?? inv?.inventory ?? [])
    .filter(x => x?.name)
    .map(x => ({ name: x.name, amount: Number(x.amount ?? 0) || 0,
                 ...(x.rarity_name && x.rarity_name !== 'normal' ? { rarity: x.rarity_name } : {}) }));
}

const MONEY_NAMES = new Set(['shilling', 'shillings']);
export const purseOf = rows => (rows ?? [])
  .filter(r => MONEY_NAMES.has(String(r.name).toLowerCase()))
  .reduce((s, r) => s + (Number(r.amount) || 0), 0);

/** One character's guild, from `guild action=status`. Null when not in one; `unknown` when unread. */
export function guildOf(reply) {
  if (!reply || reply._error) return { unknown: true, why: reply?._error ?? 'no reply' };
  if (!reply.in_guild || !reply.guild) return null;
  const g = reply.guild;
  return { name: g.name ?? null, rank: g.rank ?? null, rank_title: g.rank_title ?? null };
}

/**
 * The fleet's guild, once: name, titles, the roster with ranks, and the hall — read from
 * the first member whose status carried a roster. `chests`, `rent` and `hallRoom` come from
 * the production broker's own storage cache (substrate/storage/), because a chest's
 * contents are never pushed and reading one live needs a body standing next to it.
 */
export function fleetGuild(statuses, { chests = [], rent = null, hallRoom = null } = {}) {
  const withRoster = (statuses ?? []).find(s => s?.in_guild && Array.isArray(s?.guild?.roster));
  if (!withRoster) return null;
  const g = withRoster.guild;
  const members = g.roster.map(m => ({ prod_character: m.name, rank: Number(m.rank) }));
  const master = members.find(m => m.rank === 5)?.prod_character ?? null;
  const room = hallRoom ?? chests.find(c => Number.isFinite(Number(c?.room)))?.room ?? null;
  return {
    name: g.name, prod_id: g.id ?? null,
    rank_titles: Array.isArray(g.rank_titles) && g.rank_titles.length === 10 ? g.rank_titles : null,
    master, members,
    // Never printed. Kept so the lab hall opens to the same spoken word.
    hall_password: g.hall_password ?? null,
    hall_room: room == null ? null : Number(room),
    hall_room_from: hallRoom != null ? 'argument' : (room != null ? 'chest cache' : null),
    rent_credit: rent && Number.isFinite(Number(rent.credit)) ? Number(rent.credit) : null,
    rent_observed_at: rent?.observed_at ?? null,
    chests: chests.map(chestRecord).filter(Boolean),
    read_at: g.read_at ?? null,
  };
}

/** A cached chest file (substrate/storage/chests/<slot>.json) as the snapshot keeps it. */
export function chestRecord(c) {
  if (!c || !Array.isArray(c.items)) return null;
  const row = Number(c.row), col = Number(c.col);
  if (!Number.isFinite(row) || !Number.isFinite(col)) return null;
  return { slot: c.slot ?? `r${row}c${col}`, row, col, room: c.room ?? null,
           items: c.items.filter(x => x?.name).map(x => ({ name: x.name, amount: Number(x.amount ?? 0) || 0 })),
           observed_at: c.observed_at ?? null };
}

// ---------------------------------------------------------------- stable slots
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
export const shadowName = (i) => {
  const a = LETTERS[i % LETTERS.length];
  return a.toUpperCase() + a.repeat(3) + a.repeat(Math.floor(i / LETTERS.length));
};
export const shadowAcct = i => `shadow${String(i + 1).padStart(2, '0')}`;
const slotIndexOfAcct = a => { const m = /^shadow(\d+)$/.exec(String(a ?? '')); return m ? Number(m[1]) - 1 : null; };

/**
 * agents (in fleet order) + the previous snapshot's characters -> Map agent -> slot index.
 * An agent the previous snapshot knew keeps its slot; a new one takes the lowest free slot.
 */
export function assignShadowSlots(agents, previous = []) {
  const prior = new Map();
  for (const c of previous ?? []) {
    const i = slotIndexOfAcct(c?.shadow_account);
    if (c?.prod_agent && i != null && !prior.has(c.prod_agent)) prior.set(c.prod_agent, i);
  }
  const out = new Map(), taken = new Set();
  // Every previously held slot stays reserved, even for an agent that has left prod: the
  // account still exists and still holds that character, and handing its slot to somebody
  // else would dress the old body as a new person.
  for (const i of prior.values()) taken.add(i);
  for (const a of agents) if (prior.has(a)) out.set(a, prior.get(a));
  let next = 0;
  for (const a of agents) {
    if (out.has(a)) continue;
    while (taken.has(next)) next++;
    out.set(a, next); taken.add(next);
  }
  return out;
}

// ---------------------------------------------------------------- dress: what is wanted
let INDEX = null;
export const defaultIndex = () => (INDEX ??= itemClassIndex());
const lc = s => String(s ?? '').toLowerCase();

// Rarities under which the CLASS is right and the object is not: an uncommon long sword
// carries attributes the wire does not show, and is recreated as a plain LongSword.
const APPROX_RARITY = new Set(['unidentified', 'uncommon', 'rare', 'legendary', 'cursed', 'magic']);

// AN UNIDENTIFIED NAME CAN BE A FAMILY, NOT A CLASS. `scroll` resolves to Scroll — but every
// real scroll is one of fifteen subclasses (DarknessScroll, HeatScroll, …) that name
// themselves through `_label_name_rsc` only once identified, and the base Scroll is a scroll
// of LIGHT (spelitem/scroll.kod: viSpellEffect = SID_LIGHT). So an unidentified row whose
// class has item subclasses is REPORTED, never created: creating it would be a guess wearing
// a class name. An unidentified hammer (no subclasses) is still a Hammer, approximated.
//
// And a chest reading carries no grade at all, so the same family is also recognised by its
// SHAPE: a class whose subclasses name themselves only by `_label_name_rsc` is one whose bare
// name on the wire never identifies the subclass — `scroll` in a chest is refused the same way.
let SUBCLASSES = null, LABELLED = null;
function loadFamilies() {
  SUBCLASSES = new Map(); LABELLED = new Map();
  try {
    const db = JSON.parse(readFileSync(KODDB, 'utf8'));
    for (const c of Object.values(db.classes ?? {})) {
      const p = lc(c.parent);
      if (!p) continue;
      SUBCLASSES.set(p, (SUBCLASSES.get(p) ?? 0) + 1);
      if (Object.keys(c.resources ?? {}).some(k => /_label_name_rsc$/i.test(k)))
        LABELLED.set(p, (LABELLED.get(p) ?? 0) + 1);
    }
  } catch { /* no koddb: every count reads 0, and nothing is refused on this ground */ }
}
export function itemSubclassCount(cls) { if (SUBCLASSES == null) loadFamilies(); return SUBCLASSES.get(lc(cls)) ?? 0; }
export function labelledSubclassCount(cls) { if (LABELLED == null) loadFamilies(); return LABELLED.get(lc(cls)) ?? 0; }

/**
 * What one holder should end up with, by CLASS. `rows` are {name, amount, rarity?};
 * `wear` is a list of names that must also be worn/wielded. Returns
 *   { want: [{class, stack, count, wear, names}], unknown: [{name, why, candidates}],
 *     approximated: [{name, class, rarity}] }
 * `wear` counts only against items that are also in `rows` (the inventory lists worn
 * items too) — except a worn name the rows do not carry, which is ADDED, so an old snapshot
 * with only `wielding` still arms its shadow.
 */
export function wantedHoldings(rows = [], wear = [], index = defaultIndex(), subclasses = itemSubclassCount) {
  const byClass = new Map(), unknown = [], approximated = [];
  const add = (name, n, rarity) => {
    const r = resolveItemClass(name, index);
    if (!r.ok) { if (!unknown.some(u => lc(u.name) === lc(name))) unknown.push({ name, why: r.why, candidates: r.candidates ?? [] }); return null; }
    const k = lc(r.class);
    const cur = byClass.get(k) ?? { class: r.class, stack: r.stack, count: 0, wear: 0, names: [] };
    cur.count += r.stack ? Math.max(0, n) : Math.max(1, n);
    if (!cur.names.includes(name)) cur.names.push(name);
    byClass.set(k, cur);
    if (rarity && APPROX_RARITY.has(lc(rarity))) approximated.push({ name, class: r.class, rarity });
    return k;
  };
  for (const row of rows) {
    const amt = Number(row.amount) || 0;
    const r = resolveItemClass(row.name, index);
    const family = r.ok ? Math.max(labelledSubclassCount(r.class),
                                   lc(row.rarity) === 'unidentified' ? subclasses(r.class) : 0) : 0;
    if (family > 0) {
      const name = `${row.name}${row.rarity ? ` (${row.rarity})` : ''}`;
      if (!unknown.some(u => u.name === name))
        unknown.push({ name, why: `names a family of ${family} ${r.class} subclasses, and the wire does not say which`,
                       candidates: [] });
      continue;
    }
    // amount 0 = "not a stack" = ONE. A non-stack reported with a count is that many.
    add(row.name, r.ok && r.stack ? amt : Math.max(1, amt), row.rarity);
  }
  for (const name of wear) {
    const r = resolveItemClass(name, index);
    if (!r.ok) { add(name, 1); continue; }
    const k = lc(r.class);
    if (!byClass.has(k)) add(name, 1);
    const cur = byClass.get(k);
    cur.wear += 1;
    if (!r.stack && cur.count < cur.wear) cur.count = cur.wear;
  }
  return { want: [...byClass.values()], unknown, approximated };
}

// ---------------------------------------------------------------- dress: reading the lab
//
// The lab's state is read over the maintenance socket with `show` commands only, so these
// parse `show object` and `show list` text. Pure: the socket is the caller's.

/**
 * A batch's reply, one block per command, matched on the ECHO LINE EXACTLY and in order.
 * m59-dm's `split` finds each command with indexOf, and `show object 123` is a prefix of
 * `show object 1234`, so a batch over item ids can hand one object's block to another.
 * The server echoes each command on a line of its own (`> show name Aaaa`, or the bare
 * command after a lone `> ` prompt), so an exact line match in sequence cannot misalign.
 */
export function splitReplies(out, cmds) {
  const blocks = cmds.map(() => null);
  let k = -1;
  for (const raw of String(out ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^>\s?/, '').trim();
    if (k + 1 < cmds.length && line === cmds[k + 1].trim()) { k++; blocks[k] = ''; continue; }
    if (k >= 0 && blocks[k] != null) blocks[k] += raw + '\n';
  }
  return blocks;
}

/** One `show object` block -> the fields dress uses. */
export function parseShowObject(block) {
  const b = String(block ?? '');
  const num = (re) => { const m = re.exec(b); return m ? Number(m[1]) : null; };
  const cls = /is CLASS (\w+)/.exec(b)?.[1] ?? null;
  const obj = (prop) => {
    const m = new RegExp(`${prop}\\s+= (?:OBJECT (\\d+)|\\$)`).exec(b);
    return m ? (m[1] ? Number(m[1]) : null) : undefined;
  };
  const list = (prop) => {
    const m = new RegExp(`${prop}\\s+= (?:LIST (\\d+)|\\$)`).exec(b);
    return m ? (m[1] ? Number(m[1]) : null) : undefined;
  };
  return {
    id: num(/OBJECT (\d+) is CLASS/), class: cls,
    number: num(/piNumber\s+= INT (-?\d+)/),
    passive: list('plPassive'), active: list('plActive'), using: list('plUsing'),
    members: list('plMembers'),
    guild: obj('poGuild'), owner: obj('poOwner'), guildOwner: obj('poGuild_owner'),
    roomNum: num(/piRoom_num\s+= INT (\d+)/), mature: num(/piMature\s+= INT (-?\d+)/),
  };
}

/** A flat `show list` -> the object ids in it (top level and nested alike). */
export const parseListObjects = out => [...String(out ?? '').matchAll(/^:\s+OBJECT (\d+)/gm)].map(m => Number(m[1]));

/**
 * A `show list` of NESTED entries -> one array of values per entry. A room's plActive entry
 * is [OBJECT id, INT angle, INT row, INT col, INT fine_row, INT fine_col, ...] (measured on
 * the lab: chest 2578 in hall 714 is [2578, 2048, 18, 6, 32, 32]); a guild's plMembers entry
 * is [OBJECT who, INT rank, OBJECT vote].
 */
export function parseNestedList(out) {
  const lines = String(out ?? '').split(/\r?\n/).map(l => l.replace(/^:\s?/, '').trim());
  const entries = []; let depth = 0, cur = null;
  for (const l of lines) {
    if (l === '[') { depth++; if (depth === 2) cur = []; continue; }
    if (l === ']') { if (depth === 2 && cur) { entries.push(cur); cur = null; } depth--; continue; }
    if (depth !== 2 || !cur) continue;
    let m;
    if ((m = /^OBJECT (\d+)$/.exec(l))) cur.push({ tag: 'OBJECT', v: Number(m[1]) });
    else if ((m = /^INT (-?\d+)$/.exec(l))) cur.push({ tag: 'INT', v: Number(m[1]) });
    else if (/^\$/.test(l)) cur.push({ tag: 'NIL', v: null });
    else if ((m = /^(\w+) (\S+)$/.exec(l))) cur.push({ tag: m[1], v: m[2] });
  }
  return entries;
}

export const placedEntries = out => parseNestedList(out)
  .filter(e => e[0]?.tag === 'OBJECT')
  .map(e => ({ id: e[0].v, angle: e[1]?.v ?? null, row: e[2]?.v ?? null, col: e[3]?.v ?? null }));

export const memberEntries = out => parseNestedList(out)
  .filter(e => e[0]?.tag === 'OBJECT')
  .map(e => ({ id: e[0].v, rank: e[1]?.tag === 'INT' ? e[1].v : null }));

/** `:   == "..."` — the string a `send` returned (AdminSendObject prints resources so). */
export const returnedString = out => /^:\s+== "(.*)"$/m.exec(String(out ?? ''))?.[1] ?? null;

/**
 * `create resource X` answers `<id> (dynamic) = X`. With `value`, the echo must match it —
 * the same confirmation m59-scene-guilds.mjs demands before it trusts the id.
 */
export const createdResource = (out, value = null) => {
  const m = /^[>:\s]*(\d+)\s+\(dynamic\)\s+=\s?([^\r\n]*)$/m.exec(String(out ?? ''));
  if (!m) return null;
  if (value != null && m[2].trim() !== String(value).trim()) return null;
  return Number(m[1]);
};
export const createdObjects = out => [...String(out ?? '').matchAll(/Created object (\d+)/g)].map(m => Number(m[1]));

// ---------------------------------------------------------------- dress: the plan

/**
 * want (from wantedHoldings) + have ([{id, class, number, using}]) -> the changes.
 *   create   [{class, number|null, wear}]  one entry per object to make
 *   setNumber[{id, class, from, to}]      stacks moved to prod's number
 *   wear     [{id, class}]                existing items to put on
 *   unwear   [{id, class}]                worn items prod is not wearing (stay in the pack)
 *   surplus  [{id, class, number}]        carried and not wanted; deleted only under trim
 */
export function planHoldings({ want = [], have = [], wearable = true } = {}) {
  const plan = { create: [], setNumber: [], wear: [], unwear: [], surplus: [] };
  const haveBy = new Map();
  for (const h of have) {
    const k = lc(h.class);
    if (!haveBy.has(k)) haveBy.set(k, []);
    haveBy.get(k).push(h);
  }
  const wanted = new Map(want.map(w => [lc(w.class), w]));

  for (const w of want) {
    const k = lc(w.class);
    const mine = haveBy.get(k) ?? [];
    if (w.stack) {
      const [first, ...extra] = mine;
      if (!first) { if (w.count > 0) plan.create.push({ class: w.class, number: w.count, wear: false }); }
      else if ((first.number ?? 1) !== w.count) plan.setNumber.push({ id: first.id, class: w.class, from: first.number ?? 1, to: w.count });
      for (const e of extra) plan.surplus.push({ id: e.id, class: w.class, number: e.number ?? 1 });
      continue;
    }
    // Non-stacks: keep what is worn first (so a correct outfit is left alone), then the rest.
    const ordered = [...mine].sort((a, b) => Number(!!b.using) - Number(!!a.using));
    const keep = ordered.slice(0, w.count), extra = ordered.slice(w.count);
    for (const e of extra) plan.surplus.push({ id: e.id, class: w.class, number: 1 });
    const wearWant = wearable ? w.wear : 0;
    const wornNow = keep.filter(x => x.using).length;
    let wearLeft = Math.max(0, wearWant - wornNow);
    // Worn beyond what prod wears: take off (never delete — it stays in the pack).
    if (wornNow > wearWant) for (const x of keep.filter(x => x.using).slice(wearWant)) plan.unwear.push({ id: x.id, class: w.class });
    for (const x of keep) if (!x.using && wearLeft > 0) { plan.wear.push({ id: x.id, class: w.class }); wearLeft--; }
    for (let i = keep.length; i < w.count; i++) {
      plan.create.push({ class: w.class, number: null, wear: wearLeft > 0 });
      if (wearLeft > 0) wearLeft--;
    }
  }
  for (const [k, list] of haveBy) {
    if (wanted.has(k)) continue;
    for (const h of list) {
      if (h.using && wearable) plan.unwear.push({ id: h.id, class: h.class });
      plan.surplus.push({ id: h.id, class: h.class, number: h.number ?? 1 });
    }
  }
  return plan;
}

// The command vocabulary. Every live failure in this repository's history has been "the
// command we sent was not the command we meant", so these are strings a test can read.
export const createCmd = (cls, number = null) =>
  `create object ${cls}${number != null ? ` number INT ${number}` : ''}`;
export const holdCmd = (holder, id) => `send object ${holder} NewHold what OBJECT ${id}`;
// UserUseItem's own path (user.kod:4629): the same checks a player's click goes through, so
// a slot conflict or a cursed-already-worn refusal is the game's, not ours.
export const useCmd = (who, id) => `send object ${who} TryUseItem what OBJECT ${id}`;
export const unuseCmd = (who, id) => `send object ${who} TryUnuseItem what OBJECT ${id}`;
export const setNumberCmd = (id, n) => `set object ${id} piNumber INT ${n}`;
export const deleteCmd = id => `send object ${id} Delete`;

export const createCmds = plan => plan.create.map(c => createCmd(c.class, c.number));

/**
 * The second batch, once `created` (ids, in create order) is known. Order matters: take off
 * first (hands free), then correct stacks, then hand over, then put on.
 */
export function holdingCmds(plan, { holder, wearer = null, created = [], trim = false } = {}) {
  if (created.length !== plan.create.length)
    throw new Error(`created ${created.length} object(s) for ${plan.create.length} create(s) — ` +
                    `the ids would not line up, so nothing is handed over`);
  const cmds = [];
  if (wearer != null) for (const u of plan.unwear) cmds.push(unuseCmd(wearer, u.id));
  for (const s of plan.setNumber) cmds.push(setNumberCmd(s.id, s.to));
  plan.create.forEach((c, i) => cmds.push(holdCmd(holder, created[i])));
  if (wearer != null) {
    for (const w of plan.wear) cmds.push(useCmd(wearer, w.id));
    plan.create.forEach((c, i) => { if (c.wear) cmds.push(useCmd(wearer, created[i])); });
  }
  if (trim) for (const s of plan.surplus) cmds.push(deleteCmd(s.id));
  return cmds;
}

/** One line for a human: what a plan does. */
export function describePlan(plan) {
  const n = (a) => a.length;
  const parts = [];
  if (n(plan.create)) parts.push(`create ${n(plan.create)}`);
  if (n(plan.setNumber)) parts.push(`restack ${n(plan.setNumber)}`);
  if (n(plan.wear) + plan.create.filter(c => c.wear).length) parts.push(`wear ${n(plan.wear) + plan.create.filter(c => c.wear).length}`);
  if (n(plan.unwear)) parts.push(`take off ${n(plan.unwear)}`);
  if (n(plan.surplus)) parts.push(`surplus ${n(plan.surplus)}`);
  return parts.length ? parts.join(', ') : 'already matches';
}

// ---------------------------------------------------------------- the guild mirror
//
// HOW A GUILD IS MADE, FROM THE KOD, BECAUSE NOTHING ON THE WIRE CAN DO IT FOR A SHADOW.
// A player founds one through UC_CREATE_GUILD: user.kod:1695 runs
// `Create(&Guild,#master=self,#guildname=<string>, …titles…)`. Guild's Constructor
// (guild.kod:492) makes the master a member at RANK_MASTER, calls SetGuild on him, starts
// the maintenance timer and registers with System.NewGuild. So over the maintenance socket:
//
//   create resource <name>                     a DYNAMIC resource — the admin `create` can
//                                              pass only ONE quoted string and it must be
//                                              last, and it is a TEMP string that the next
//                                              temp string overwrites; a resource persists
//                                              (player names are dynamic resources too)
//   create object Guild master OBJECT m guildname RESOURCE r
//                                              at most 9 blakod parms: the admin parser has
//                                              no bound check on its 10-slot array
//                                              (adminfn.c:45, :849) — so titles go after
//   set object g prMaster RESOURCE t …         the ten titles, as properties
//   set object g piMature INT 0                a real guild takes 30 six-minute ticks, and a
//                                              hall refuses an immature guild (ghall.kod:354)
//   send object g InductNewMember who OBJECT x joins as apprentice (guild.kod:1314), after
//                                              piGuildRejoinTimestamp is cleared
//
// m59-scene-guilds.mjs already founds TEMPORARY guilds this way for the scene lab (and
// deletes them afterwards); this is the persistent, prod-shaped version of that sequence.
//
//   send object g ChangeRank who OBJECT x newrank INT r
//                                              ranks 1..4, no promoter, so no cap check —
//                                              prod's own ranks are the cap (guild.kod:1671)
//   set object g piRentDue INT -<credit>       prod's rent credit (guild.kod:776 AccrueRent)
//   send object <hall> ClaimGuildHall oGuild OBJECT g rep OBJECT m password RESOURCE p
//                                              exactly what renting does once paid
//                                              (user.kod:1827, ghall.kod:329); SetGuildHall
//                                              refuses a nil password (guild.kod:925)
//   create object <item> … ; send object <chest> NewHold what OBJECT i
//                                              the three chests are Chest (StorageBox)
//                                              objects in the hall's plActive at r20c4,
//                                              r18c2, r18c6 (ghall/guildh14.kod:518-523)
export const TITLE_PROPS = ['prApprentice_Male', 'prApprentice_Female', 'prSir', 'prMadame',
  'prLord', 'prLady', 'prLieutenant_Male', 'prLieutenant_Female', 'prMaster', 'prMistress'];
export const RANK_MASTER = 5;

/** Resources the guild needs, in order. The caller runs each and reads the id back. */
export function guildResourceCmds(guild) {
  const out = [{ key: 'name', cmd: `create resource ${guild.name}` }];
  (guild.rank_titles ?? []).forEach((t, i) => out.push({ key: TITLE_PROPS[i], cmd: `create resource ${t}` }));
  // A hall needs a password (SetGuildHall refuses $). Prod's is used when it was read.
  out.push({ key: 'password', cmd: `create resource ${guild.hall_password ?? 'shadow'}`,
             invented: guild.hall_password == null });
  return out;
}

export const guildCreateCmd = ({ masterId, nameRsc }) =>
  `create object Guild master OBJECT ${masterId} guildname RESOURCE ${nameRsc}`;

/**
 * Which shadow is which member. `characters` are snapshot records (prod_character ->
 * shadow_name); `ids` maps shadow_name -> lab object id. A member with no shadow, or a
 * shadow the lab does not have, is reported rather than skipped silently.
 */
export function guildMembers(guild, characters, ids) {
  const byProd = new Map((characters ?? []).map(c => [c.prod_character, c]));
  const members = [], missing = [];
  for (const m of guild?.members ?? []) {
    const c = byProd.get(m.prod_character);
    if (!c) { missing.push({ prod_character: m.prod_character, why: 'no shadow in the snapshot' }); continue; }
    const id = ids?.[c.shadow_name];
    if (id == null) { missing.push({ prod_character: m.prod_character, shadow: c.shadow_name, why: 'not on the lab server' }); continue; }
    members.push({ prod_character: m.prod_character, shadow: c.shadow_name, id, rank: m.rank });
  }
  const master = members.find(m => m.rank === RANK_MASTER) ?? null;
  return { members, missing, master };
}

/**
 * Setting a guild up once it exists. `current` is the lab's own roster [{id, rank}] (empty
 * for a guild just made — its master is already in at 5). `others` maps shadow id -> the
 * guild object it already belongs to, if a DIFFERENT one: that shadow cannot be inducted
 * (InductNewMember refuses a guilded character) and is reported.
 */
export function guildSetupCmds({ guildId, guild, members, current = [], titleRscs = {},
                                  others = {}, setTitles = true }) {
  const cmds = [], refused = [];
  if (setTitles) for (const p of TITLE_PROPS) if (titleRscs[p] != null) cmds.push(`set object ${guildId} ${p} RESOURCE ${titleRscs[p]}`);
  cmds.push(`set object ${guildId} piMature INT 0`);
  if (guild.rent_credit != null) cmds.push(`set object ${guildId} piRentDue INT ${-Math.round(guild.rent_credit)}`);
  const have = new Map(current.map(m => [m.id, m.rank]));
  const master = members.find(m => m.rank === RANK_MASTER);
  const curMaster = current.find(m => m.rank === RANK_MASTER)?.id ?? null;
  for (const m of members) {
    if (others[m.id] != null && others[m.id] !== guildId) { refused.push({ ...m, why: `already in guild object ${others[m.id]}` }); continue; }
    // The rejoin cooldown first: InductNewMember refuses a character that left a guild
    // recently (HasLeftAGuildTooRecently), and a shadow rerolled out of a previous build's
    // guild has exactly that stamp. m59-scene-guilds.mjs clears it for the same reason.
    if (!have.has(m.id)) {
      cmds.push(`set object ${m.id} piGuildRejoinTimestamp INT 0`,
                `send object ${guildId} InductNewMember who OBJECT ${m.id}`);
      have.set(m.id, 1);
    }
  }
  // The master first, because NewGuildMaster demotes whoever held it to SIR — and then the
  // rank loop below puts the old master back where prod has him.
  if (master && curMaster !== master.id && !refused.some(r => r.id === master.id)) {
    cmds.push(`send object ${guildId} NewGuildMaster who OBJECT ${master.id}`);
    have.set(master.id, RANK_MASTER);
    if (curMaster != null) have.set(curMaster, 2);
  }
  for (const m of members) {
    if (m.rank === RANK_MASTER || refused.some(r => r.id === m.id)) continue;
    const r = Math.max(1, Math.min(4, Number(m.rank) || 1));
    if (have.get(m.id) !== r) cmds.push(`send object ${guildId} ChangeRank who OBJECT ${m.id} newrank INT ${r}`);
  }
  return { cmds, refused };
}

export const hallClaimCmd = ({ hallId, guildId, repId, passwordRsc }) =>
  `send object ${hallId} ClaimGuildHall oGuild OBJECT ${guildId} rep OBJECT ${repId} password RESOURCE ${passwordRsc}`;

/** Which lab chest is which prod chest: the same square in the same hall. */
export function matchChests(prodChests, labPlaced, labClassOf) {
  const out = [], missing = [];
  for (const c of prodChests ?? []) {
    const hit = labPlaced.find(p => p.row === c.row && p.col === c.col && lc(labClassOf(p.id)) === 'chest');
    if (hit) out.push({ ...c, id: hit.id }); else missing.push(c);
  }
  return { chests: out, missing };
}

// ---------------------------------------------------------------- cli: a dry plan
if (import.meta.filename === process.argv[1]) {
  const i = process.argv.indexOf('--plan');
  const file = i >= 0 ? process.argv[i + 1] : null;
  if (!file || !existsSync(file)) {
    console.log('usage: node tools/m59-shadow-fidelity.mjs --plan <shadow-snapshot.json>');
    process.exit(file ? 1 : 0);
  }
  const snap = JSON.parse(readFileSync(file, 'utf8'));
  const unknown = new Map(), approx = new Map();
  for (const c of snap.characters ?? []) {
    const w = wantedHoldings(c.inventory ?? [], (c.equipment?.length ? c.equipment : (c.wielding ? [c.wielding] : [])));
    const items = w.want.reduce((s, x) => s + (x.stack ? 1 : x.count), 0);
    const worn = w.want.filter(x => x.wear).map(x => x.class).join('+') || '-';
    console.log(`${String(c.shadow_name).padEnd(6)} <- ${String(c.prod_character).padEnd(30)} ` +
                `${String(items).padStart(3)} object(s)  purse ${purseOf(c.inventory)}  wears ${worn}`);
    for (const u of w.unknown) unknown.set(u.name, u.why);
    for (const a of w.approximated) approx.set(`${a.name} (${a.rarity})`, a.class);
  }
  if (snap.guild) console.log(`\nguild "${snap.guild.name}": ${snap.guild.members.length} member(s), hall ${snap.guild.hall_room ?? '?'}, ` +
                              `${snap.guild.chests?.length ?? 0} chest(s), rent credit ${snap.guild.rent_credit ?? '?'}`);
  else console.log('\nno guild in this snapshot');
  if (unknown.size) console.log(`\nNOT CREATED, no single class: ${[...unknown].map(([n, w]) => `${n} — ${w}`).join('; ')}`);
  if (approx.size) console.log(`APPROXIMATED (class only): ${[...approx.keys()].join(', ')}`);
}
