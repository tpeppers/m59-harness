#!/usr/bin/env node
// Object-id GENERATIONS: when the server last saved, whether an id predates that save, and
// what a pre-save id names now.
//
// AN OBJECT ID IS A TEMPORARY HANDLE (CLAUDE.md). Every system save (GarbageCollecting,
// user.kod:2154/2182) renumbers object ids, and the server brackets it with BP_WAIT and
// BP_UNWAIT, which m59-client.mjs raises as `server-save`. So an id means something only
// together with the GENERATION it was read in — the stretch between two saves — and an id
// carried across a save either names nothing or, worse, names somebody else's thing and reads
// back as success.
//
// WHAT IT COST, 2026-10-04 22:37Z. A fleetscript `supply` step read Kermit's pack, took the
// shilling stack's id, and sent it — and was told "Kermit is carrying nothing matching those
// ids". A manual retry seconds later worked. The same day an equipment read said an amulet was
// not worn while it was. Two causes stacked: the broker's `inventory` and `equipment` tools on a
// keeper-backed character answered from the snapshot held BEFORE their own fresh read (they
// captured the client object, and KeeperProxy rebuilds that object per snapshot), and nothing
// anywhere recorded which save an id came from, so nothing could tell a stale id from a wrong one.
//
// THE OPERATOR'S REQUIREMENT, 2026-10-04: "track the rate/timing of system saves and mark IDs as
// stale if the ID was last read older than the most recent system save timing, via all tools,
// automatically." So this file has four parts, all pure, all pinned by m59-idgen-test.mjs:
//
//   SaveClock    — every save the fleet has seen, deduped across keepers (twenty-odd clients
//                  each see the same save), with the observed cadence and the next one predicted.
//   stampReply   — at the broker's one door (callTool), every reply carrying object ids gets
//                  `ids_as_of` and `ids_stale`, and stale entries are marked `id_stale: true`.
//   IdRegistry   — what id this broker handed out, to whom, under what name, and when — so a call
//                  that later passes one back can be judged without the caller saying anything.
//   judgeArgs / reresolveRefs — on the way IN, an id last handed out before the latest save is
//                  re-resolved by NAME from a fresh read when exactly one thing carries that name,
//                  and refused with a sentence that says so when not. Never acted on silently.
//
//   checkIds     — the same judgement for a list of pack ids against the client's own retired
//                  generations, for the exchange that walks for minutes (m59-supply.mjs): a save
//                  can land between the call and the offer.

/** How many retired generations a client keeps, and for how long. */
export const ID_GENERATIONS_KEPT = 3;
export const ID_GENERATION_MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** Two observations of a save closer than this are the same save seen by two keepers. */
export const SAVE_DEDUPE_MS = 90_000;

const normName = (n) => String(n ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
export const hhmmss = (ms) => Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 19) + 'Z' : '?';
const isObjectId = (v) => Number.isSafeInteger(v) && v > 0;

// ------------------------------------------------------------------ generations (one client)

/**
 * Retire the inventory as it stands at the START of a save. `items` are {id, name, amount}.
 * `since` is when this client began tracking: the first generation's window opens there, so an
 * id read before this process knew anything is 'unknown' rather than guessed at.
 */
export function retireGeneration(generations, { began, items, since = null, now = began }) {
  const kept = (Array.isArray(generations) ? generations : [])
    .filter(g => Number.isFinite(g?.began) && now - g.began <= ID_GENERATION_MAX_AGE_MS);
  const prev = kept[kept.length - 1];
  const gen = {
    // The window of reads whose ids this generation describes: [from, ended).
    from: prev ? (prev.ended ?? prev.began) : (Number.isFinite(since) ? since : null),
    began,
    ended: null,
    items: (items ?? []).filter(o => isObjectId(Number(o?.id)))
      .map(o => ({ id: Number(o.id), name: String(o.name ?? ''), amount: Number(o.amount) || 0 })),
  };
  return [...kept, gen].slice(-ID_GENERATIONS_KEPT);
}

/** Close the newest open generation at the save's END (BP_UNWAIT). */
export function closeGeneration(generations, ended) {
  const out = (Array.isArray(generations) ? generations : []).map(g => ({ ...g }));
  const open = [...out].reverse().find(g => g.ended == null);
  if (open) open.ended = ended;
  return out;
}

/**
 * The generation a read at `callerAsOf` belongs to.
 *   'current'  — read after the last save ended
 *   a generation — read inside its window [from, ended): before that save, or during it
 *   'unknown'  — older than anything kept, or no time given
 */
export function generationOf(generations, callerAsOf) {
  const gens = Array.isArray(generations) ? generations : [];
  const t = Number(callerAsOf);
  if (callerAsOf == null || !Number.isFinite(t)) return 'unknown';
  for (const g of gens) {
    if (!Number.isFinite(g?.began)) continue;
    const lo = Number.isFinite(g.from) ? g.from : -Infinity;
    const hi = Number.isFinite(g.ended) ? g.ended : Infinity;
    if (t >= lo && t < hi) return g;
  }
  const last = gens[gens.length - 1];
  if (!last) return 'current';
  if (Number.isFinite(last.ended) && t >= last.ended) return 'current';
  return 'unknown';
}

/** Is this client's inventory read newer than the last save it saw? */
export function idsCurrent(asOf) {
  if (!asOf || typeof asOf !== 'object') return false;
  if (asOf.saving) return false;
  if (!Number.isFinite(asOf.inventory_at)) return false;
  return !Number.isFinite(asOf.last_save_at) || asOf.inventory_at >= asOf.last_save_at;
}

function normEntry(e) {
  if (e && typeof e === 'object')
    return { id: Number(e.id), amount: e.amount == null ? null : Number(e.amount),
             name: e.name == null ? null : String(e.name) };
  return { id: Number(e), amount: null, name: null };
}

/**
 * WHAT A LIST OF PACK IDS MEANS NOW.
 *
 * @param entries   bare ids, or {id, amount?, name?} — `name` is the caller saying what it
 *                  meant, which is what lets a recycled id be re-resolved instead of refused
 * @param inventory the CURRENT pack, rows {id, name, amount, ...} (the row is handed back)
 * @param generations retired generations, oldest first (see retireGeneration)
 * @param asOf      the current read's ids_as_of (inventory_at, last_save_at)
 * @param callerAsOf when the caller's ids were read, if known
 * @param elsewhere ids that exist now OUTSIDE the pack (room objects)
 * @returns {ok, items:[{asked_id,id,name,amount,row,how}], refused:[{asked_id,why}],
 *           reresolved:[{from,to,name,why}], absent:[id], notes:[...]}
 */
export function checkIds(entries, { inventory = [], generations = [], asOf = null,
                                    callerAsOf = null, elsewhere = null } = {}) {
  const inv = (inventory ?? []).map(r => ({ row: r, id: Number(r.id), name: String(r.name ?? ''),
                                            amount: Number(r.amount) || 0 }));
  const byId = new Map(inv.map(r => [r.id, r]));
  const gens = Array.isArray(generations) ? generations : [];
  const callerGen = callerAsOf == null ? null : generationOf(gens, Number(callerAsOf));
  const lastSave = gens.length ? gens[gens.length - 1] : null;
  const saveWord = (g) => `the ${hhmmss(g?.ended ?? g?.began)} save`;
  const items = [], refused = [], reresolved = [], absent = [], notes = [];
  const used = new Set();

  const byName = (name, preferId) => {
    const want = normName(name);
    const hits = inv.filter(r => normName(r.name) === want);
    if (hits.length <= 1) return { hit: hits[0] ?? null, hits };
    return { hit: hits.find(r => r.id === preferId) ?? null, hits };
  };

  for (const raw of entries ?? []) {
    const e = normEntry(raw);
    if (!isObjectId(e.id)) {
      refused.push({ asked_id: raw?.id ?? raw, why: `${JSON.stringify(raw)} is not an object id` });
      continue;
    }
    const cur = byId.get(e.id) ?? null;
    // WHAT THE ID NAMED WHEN THE CALLER READ IT.
    //   caller said when -> that generation's record, exactly
    //   caller did not   -> the newest retired record of this id, if any (a guess, so a
    //                       disagreement with the present is refused rather than picked)
    let old = null, oldGen = null, exact = false;
    if (callerGen && callerGen !== 'current' && callerGen !== 'unknown') {
      oldGen = callerGen; exact = true;
      old = callerGen.items.find(o => o.id === e.id) ?? null;
      if (!old && !e.name) {
        refused.push({ asked_id: e.id, why: `id ${e.id} was not in the pack before ${saveWord(oldGen)}, ` +
          'the generation it was read in — ids are renumbered by every save; re-read the inventory' });
        continue;
      }
    } else if (callerGen === 'unknown' && callerAsOf != null && !e.name) {
      refused.push({ asked_id: e.id, why: `id ${e.id} was read at ${hhmmss(Number(callerAsOf))}, older than ` +
        'every save this character remembers — ids are renumbered by every save; re-read the inventory' });
      continue;
    } else if (callerGen == null) {
      for (const g of [...gens].reverse()) {
        const o = g.items.find(x => x.id === e.id);
        if (o) { old = o; oldGen = g; break; }
      }
    }
    const meant = e.name ?? old?.name ?? null;
    const finish = (row, how, why) => {
      if (used.has(row.id)) {
        refused.push({ asked_id: e.id, why: `id ${e.id} resolves to ${row.id} (${row.name}), which another entry ` +
          'in this list already names — a duplicate in an offer cancels the trade' });
        return;
      }
      used.add(row.id);
      let amount = e.amount;
      // A BARE ID MEANT "THE STACK I SAW". After a re-resolve the stack may have grown; hand
      // over what the caller saw, not what is there now.
      if (amount == null && how === 'reresolved' && old?.amount > 0 && row.amount > 0)
        amount = Math.min(old.amount, row.amount);
      items.push({ asked_id: e.id, id: row.id, name: row.name, amount, row: row.row, how });
      if (how === 'reresolved') reresolved.push({ from: e.id, to: row.id, name: row.name, why });
    };
    const reresolve = (why) => {
      if (!meant) {
        refused.push({ asked_id: e.id, why: `${why}, and nothing says what it named — pass {id, name} or re-read the inventory` });
        return;
      }
      const { hit, hits } = byName(meant, e.id);
      if (hit) { finish(hit, hit.id === e.id ? 'current' : 'reresolved', why); return; }
      if (!hits.length) {
        refused.push({ asked_id: e.id, why: `${why}; "${meant}" is no longer carried` });
        return;
      }
      refused.push({ asked_id: e.id, why: `${why}; "${meant}" now names ${hits.length} items ` +
        `(ids ${hits.map(h => h.id).join(', ')}) — pick one from a fresh inventory` });
    };

    if (exact) {
      if (cur && old && normName(cur.name) === normName(old.name)) { finish(cur, 'current'); continue; }
      reresolve(`id ${e.id} predates ${saveWord(oldGen)}${old ? ` (it was ${old.name})` : ''}`);
      continue;
    }
    if (cur) {
      if (e.name && normName(e.name) !== normName(cur.name)) {
        reresolve(`id ${e.id} is now ${cur.name}, not ${e.name}`);
        continue;
      }
      if (!e.name && old && normName(old.name) !== normName(cur.name)) {
        refused.push({ asked_id: e.id, why: `id ${e.id} named ${old.name} before ${saveWord(oldGen)} and names ` +
          `${cur.name} now — ids are renumbered by every save, so this will not guess which you meant. ` +
          'Re-read the inventory, or pass {id, name}' });
        continue;
      }
      finish(cur, 'current');
      continue;
    }
    if (elsewhere?.has?.(e.id) && (old || e.name)) {
      reresolve(`id ${e.id}${old ? ` was ${old.name} before ${saveWord(oldGen)} and` : ''} now names something ` +
        'that is not in the pack');
      continue;
    }
    if (old) { reresolve(`id ${e.id} predates ${saveWord(oldGen)} (it was ${old.name})`); continue; }
    if (e.name) { reresolve(`id ${e.id} is not in the pack`); continue; }
    absent.push(e.id);
  }
  if (lastSave && !idsCurrent(asOf))
    notes.push(`this pack read may predate ${saveWord(lastSave)}`);
  return { ok: refused.length === 0, items, refused, reresolved, absent, notes,
           ids_as_of: asOf ?? null };
}

/** One sentence for a refusal list, for a tool's `reason`. */
export function refusalText(result) {
  return (result?.refused ?? []).map(r => r.why).join('; ');
}

/** Wording a fleetscript retry recognises as "the id went stale", not "the goods are gone". */
export const STALE_ID_REASON = /carrying nothing matching those ids|predates .*save|renumbered by (every|each) save|no longer carried|stale object id/i;

// ------------------------------------------------------------------ the save clock (fleet)

/**
 * EVERY SAVE THE FLEET HAS SEEN, ONCE. Each logged-in client receives BP_WAIT/BP_UNWAIT for
 * the same save, so twenty-odd keepers report one event twenty-odd times, seconds apart. The
 * sightings ledger (m59-sightings.mjs) has the same exactly-once problem for logins and solves
 * it by keying on the event, not the reporter; a save has no id, so this keys on TIME: two
 * observations whose start (or, lacking one, end) lie within SAVE_DEDUPE_MS are one save.
 *
 * The earliest END any observer saw is the boundary: a keeper that got BP_UNWAIT at :05 and
 * re-read its pack at :06 must not be called stale because another keeper's UNWAIT came at :07.
 * The per-keeper `ids_as_of.current` covers the other direction (a keeper still paused).
 */
export class SaveClock {
  constructor({ dedupeMs = SAVE_DEDUPE_MS, keep = 48 } = {}) {
    this.dedupeMs = dedupeMs;
    this.keep = keep;
    this.saves = [];          // oldest first: {began, ended, observers}
  }

  /** Feed one observation: {began?, ended?} (ms), or a client event {phase, at, began}. */
  observe(o, source = null) {
    if (!o || typeof o !== 'object') return null;
    let began = Number.isFinite(o.began) ? o.began : null;
    let ended = Number.isFinite(o.ended) ? o.ended : null;
    if (o.phase === 'begin' && Number.isFinite(o.at)) began = o.at;
    if (o.phase === 'end' && Number.isFinite(o.at)) ended = o.at;
    if (began == null && ended == null) return null;
    const key = began ?? ended;
    // Same save: the starts (or ends) agree within the window, or an end-only report lands
    // within ten minutes after a known start (a save that long is a server in trouble, but it
    // is still one save).
    let hit = this.saves.find(s =>
      Math.abs((s.began ?? s.ended) - key) <= this.dedupeMs ||
      (began == null && s.began != null && ended >= s.began && ended - s.began <= 10 * 60_000) ||
      (began != null && s.began == null && s.ended >= began && s.ended - began <= 10 * 60_000));
    if (!hit) {
      hit = { began, ended, observers: 0 };
      this.saves.push(hit);
      this.saves.sort((a, b) => (a.began ?? a.ended) - (b.began ?? b.ended));
      if (this.saves.length > this.keep) this.saves.splice(0, this.saves.length - this.keep);
    } else {
      if (began != null) hit.began = hit.began == null ? began : Math.min(hit.began, began);
      if (ended != null) hit.ended = hit.ended == null ? ended : Math.min(hit.ended, ended);
    }
    hit.observers++;
    if (source != null) (hit.sources ??= new Set()).add(String(source));
    return hit;
  }

  /** Feed a list (a keeper's recent `saves`). */
  observeAll(list, source = null) {
    for (const o of Array.isArray(list) ? list : []) this.observe(o, source);
  }

  get latest() { return this.saves[this.saves.length - 1] ?? null; }

  /** The moment after which ids are post-save: the earliest observed end; while a save is in
   *  progress (begun, not ended) there is no safe moment yet, so Infinity. */
  boundary() {
    const s = this.latest;
    if (!s) return null;
    if (s.ended == null) return s.began != null && Date.now() - s.began < 10 * 60_000 ? Infinity : s.began;
    return s.ended;
  }

  /** Was something read at `t` read before the most recent save finished? */
  isStale(t) {
    const b = this.boundary();
    if (b == null || !Number.isFinite(t)) return false;
    return t < b;
  }

  /** The cadence: last save, median interval between the starts of recent saves, and the
   *  next one that interval predicts. Null fields when there is not enough to say. */
  summary(now = Date.now()) {
    const starts = this.saves.map(s => s.began ?? s.ended).filter(Number.isFinite);
    const gaps = [];
    for (let i = 1; i < starts.length; i++) gaps.push(starts[i] - starts[i - 1]);
    const recent = gaps.slice(-6).sort((a, b) => a - b);
    const interval = recent.length ? recent[Math.floor((recent.length - 1) / 2)] : null;
    const last = this.latest;
    const lastStart = last ? (last.began ?? last.ended) : null;
    let next = interval && lastStart != null ? lastStart + interval : null;
    // A prediction already in the past rolls forward rather than claiming a save is overdue
    // forever; the honest answer to "when is the next one" is still one interval on.
    while (next != null && interval > 0 && next < now - interval) next += interval;
    return {
      count: this.saves.length,
      last_at: last ? (last.ended ?? last.began) : null,
      last_began_at: last?.began ?? null,
      in_progress: !!(last && last.ended == null),
      held_ms: last && last.began != null && last.ended != null ? last.ended - last.began : null,
      interval_ms: interval,
      next_expected_at: next,
      last_at_iso: last ? new Date(last.ended ?? last.began).toISOString() : null,
      next_expected_at_iso: next != null ? new Date(next).toISOString() : null,
      observed_intervals: gaps.length,
    };
  }
}

// ------------------------------------------------------------------ the reply boundary

const NAME_KEYS = ['name', 'what', 'character', 'nameRsc'];
// Where an object id lives in each tool's ARGUMENTS. Per tool, because the same key means
// different things: `to` is a player for `trade` and a ROOM NUMBER for `travel`, and a room
// number judged as an object id would be "re-resolved" into a refusal. A tool absent from this
// table is not judged on the way in (its replies are still stamped). Under a listed key the id
// is the value itself, an element of an array, or the `id` field of an object — never some
// other number beside it (`amount: 5` is not object 5).
export const ID_ARGS_BY_TOOL = Object.freeze({
  act: ['target'], look_at: ['target'], cast: ['target'], attack: ['target'], approach: ['target'],
  face: ['target'], combat: ['target'], attack_intent: ['target'],
  context_intent: ['target', 'targets'],
  trade: ['to', 'items'], sell: ['to', 'items'], supply: ['what'], sell_all: ['merchant'],
  shop: ['seller', 'buy_ids'], loot: ['ids'],
  commerce_catalog: ['merchant'], commerce_prepare: ['merchant', 'counterparty', 'item', 'items'],
});

/** Every {id, name} the reply carries. Bounded, so a huge reply costs a bounded walk. */
export function collectIds(reply, { maxNodes = 5000, maxDepth = 6 } = {}) {
  const out = [];
  let nodes = 0;
  const walk = (v, depth) => {
    if (v == null || typeof v !== 'object' || depth > maxDepth || ++nodes > maxNodes) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (isObjectId(v.id)) {
      const nk = NAME_KEYS.find(k => typeof v[k] === 'string' && v[k]);
      out.push({ id: v.id, name: nk ? v[nk] : null, node: v });
    }
    for (const [k, x] of Object.entries(v)) if (x && typeof x === 'object' && k !== 'ids_reresolved') walk(x, depth + 1);
  };
  walk(reply, 0);
  return out;
}

/**
 * STAMP A REPLY. Adds `ids_as_of` (ms), `ids_stale`, and `last_save_at` / `next_save_expected_at`
 * to any plain-object reply that carries object ids, and marks each entry `id_stale: true` when
 * stale. Mutates and returns the reply; a reply with no ids is returned untouched.
 */
export function stampReply(reply, { readAt, stale, clock = null } = {}) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return { reply, ids: [] };
  const ids = collectIds(reply);
  if (!ids.length) return { reply, ids };
  const sum = clock?.summary?.() ?? null;
  reply.ids_as_of = Number.isFinite(readAt) ? readAt : null;
  reply.ids_stale = !!stale;
  if (sum) {
    reply.last_save_at = sum.last_at;
    reply.next_save_expected_at = sum.next_expected_at;
  }
  if (stale) {
    for (const { node } of ids) node.id_stale = true;
    reply.ids_note = `these ids were read before the ${hhmmss(sum?.last_at)} server save, which renumbers ` +
      'every object id — re-read before acting on them (a call that passes one back is re-resolved by ' +
      'name, or refused, automatically)';
  }
  return { reply, ids };
}

/** What this broker handed out: agent -> id -> {name, at}. Last issue wins. */
export class IdRegistry {
  constructor({ maxPerAgent = 4000, maxAgeMs = 12 * 60 * 60 * 1000 } = {}) {
    this.maxPerAgent = maxPerAgent;
    this.maxAgeMs = maxAgeMs;
    this.byAgent = new Map();
  }
  note(agent, id, { name = null, at = Date.now() } = {}) {
    if (!agent || !isObjectId(id)) return;
    let m = this.byAgent.get(agent);
    if (!m) this.byAgent.set(agent, m = new Map());
    m.delete(id);
    m.set(id, { name, at });
    if (m.size > this.maxPerAgent) m.delete(m.keys().next().value);
  }
  noteAll(agent, collected, at) {
    for (const { id, name } of collected ?? []) this.note(agent, id, { name, at });
  }
  get(agent, id, now = Date.now()) {
    const r = this.byAgent.get(agent)?.get(Number(id)) ?? null;
    if (r && now - r.at > this.maxAgeMs) return null;
    return r;
  }
}

/**
 * THE INPUT SIDE. Every object id in a call's arguments (at the tool's keys in ID_ARGS_BY_TOOL)
 * that this broker last handed to this agent BEFORE the latest save. Each ref carries a `path`
 * so the call can be rewritten.
 */
export function judgeArgs(args, { tool, agent, registry, clock, now = Date.now(), keys = null } = {}) {
  const refs = [];
  const idKeys = keys ?? ID_ARGS_BY_TOOL[tool] ?? null;
  if (!idKeys || !args || typeof args !== 'object' || !registry || !clock) return refs;
  const judge = (v, path) => {
    const id = typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN);
    if (!isObjectId(id)) return;
    const issued = registry.get(agent, id, now);
    if (issued && clock.isStale(issued.at))
      refs.push({ path, id, name: issued.name, read_at: issued.at });
  };
  const visit = (v, path, depth = 0) => {
    if (depth > 3 || v == null) return;
    if (typeof v !== 'object') { judge(v, path); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => visit(x, [...path, i], depth + 1)); return; }
    if ('id' in v) judge(v.id, [...path, 'id']);
  };
  for (const k of idKeys) if (k in args) visit(args[k], [k]);
  return refs;
}

/**
 * Re-resolve stale refs against a FRESH view: `candidates` are {id, name, where} rows (pack and
 * room). The same id still carrying the same name is kept; otherwise exactly one carrier of the
 * name is substituted; anything else is refused with a sentence.
 */
export function reresolveRefs(refs, { candidates = [], clock = null } = {}) {
  const subs = [], refused = [];
  const when = hhmmss(clock?.summary?.().last_at);
  for (const r of refs ?? []) {
    const saw = `id ${r.id} was read at ${hhmmss(r.read_at)}, before the ${when} save that renumbers every object id`;
    if (!r.name) {
      refused.push({ id: r.id, path: r.path, why: `${saw}, and it was handed out without a name — re-read and pass the new id` });
      continue;
    }
    const want = normName(r.name);
    const same = candidates.find(c => c.id === r.id && normName(c.name) === want);
    if (same) { subs.push({ path: r.path, from: r.id, to: r.id, name: same.name, how: 'unchanged' }); continue; }
    const hits = candidates.filter(c => normName(c.name) === want);
    if (hits.length === 1) {
      subs.push({ path: r.path, from: r.id, to: hits[0].id, name: hits[0].name, how: 'reresolved',
                  why: `${saw}; "${r.name}" is now id ${hits[0].id}` });
      continue;
    }
    refused.push({ id: r.id, path: r.path, why: hits.length
      ? `${saw}; "${r.name}" now names ${hits.length} things (ids ${hits.map(h => h.id).slice(0, 8).join(', ')}) — pick one from a fresh read`
      : `${saw}; nothing called "${r.name}" is in the pack or the room now` });
  }
  return { ok: refused.length === 0, subs, refused };
}

/** A copy of `args` with each substitution's path set to its new id (keeping a string a string). */
export function rewriteArgs(args, subs) {
  const out = structuredClone(args);
  for (const s of subs ?? []) {
    if (s.from === s.to) continue;
    let o = out;
    for (let i = 0; i < s.path.length - 1; i++) o = o?.[s.path[i]];
    const last = s.path[s.path.length - 1];
    if (o && last in o) o[last] = typeof o[last] === 'string' ? String(s.to) : s.to;
  }
  return out;
}
