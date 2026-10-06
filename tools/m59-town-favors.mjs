// TOWN TRIPS ON DEMAND, AND THE FAVORS THAT RIDE ON THEM — the pure half.
//
// Operator, 2026-10-06, after Lew walked to Jasper and Barloque on a shopping trip with 28 shillings
// while the operator wanted him at Castle Victoria: "I'd like to be able to trigger OR drop town
// buying/selling trips, as well as add on an additional 'while you're in town' errand (e.g. 'bring
// back purple mushrooms to give Janice and Camilla when you come back')", so that strategies can
// later "trigger these in mutually beneficial ways -- when Janice and Camilla run low on reagents,
// the next person considering a town stop should just go and start it immediately, and also add on
// the errand/favor for Camilla and Janice of bringing reagents back for them".
//
// THREE THINGS, ALL SPOKEN TO THE KEEPER THROUGH `autopilot action=town_trip op=...`:
//
//   start   open a town trip now (the keeper's own trip machinery: bankRun -> openTownTrip ->
//           continueTownTrip), aimed at `town` = market | bank | food | supply. Clears a hold.
//   drop    end the current trip AND the set-aside one (deferredShoppingTrip), cancel the walk, and
//           HOLD new trips for `hold_ms` (default 30 min). The hold is the half that makes a drop
//           stick: Lew's trip came back because a broke character re-decides a sell trip on the next
//           pass, and a trip set aside under a lease resumes the moment the lease ends.
//   allow   lift the hold without starting anything.
//   favor   add a "while you're in town" errand: get `amount` of `item` -- from the guild hall chests
//           (`source` hall), a shop (`buy`, needs `shop_room`), or both (`any`, chests first) -- and on
//           the way back hand it, split evenly, to the characters in `deliver_to`, in `deliver_room`
//           (default: the courier's own assigned room).
//   drop_favor / status
//
// A strategy can do the same through the `townTrip` hook (m59-strategies.mjs): asked by a keeper
// considering a town stop, and again as one opens, it may answer { start: {why, town}, favors: [...] }.
//
// FAVORS AND HOLDS LIVE IN THE KEEPER'S MEMORY, like the trip itself: a keeper restart forgets them.
// That is the trip's existing contract (m59-autopilot.mjs holds townTrip in memory only), kept rather
// than half-solved here.

export const TOWNS = Object.freeze(['market', 'bank', 'food', 'supply']);
export const SOURCES = Object.freeze(['any', 'hall', 'buy']);
export const OPS = Object.freeze(['start', 'drop', 'allow', 'favor', 'drop_favor', 'status']);
export const DEFAULT_HOLD_MS = 30 * 60_000;
export const MAX_HOLD_MS = 24 * 3600_000;
export const MAX_FAVOR_AMOUNT = 1000;
export const MAX_RECIPIENTS = 8;
export const MAX_OPEN_FAVORS = 12;

const str = v => (v == null ? '' : String(v)).trim();
const list = v => (Array.isArray(v) ? v : str(v).split(',')).map(str).filter(Boolean);
const int = v => (v === '' || v == null ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);

/** A favor as the keeper keeps it, or { ok:false, why }. Never throws. */
export function normalizeFavor(raw = {}, { now = Date.now(), by = null, id = null } = {}) {
  const item = str(raw.item).toLowerCase();
  if (!item) return { ok: false, why: 'a favor needs an item' };
  const amount = int(raw.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_FAVOR_AMOUNT)
    return { ok: false, why: `amount must be a whole number from 1 to ${MAX_FAVOR_AMOUNT}` };
  const to = [...new Set(list(raw.deliver_to ?? raw.to))];
  if (!to.length) return { ok: false, why: 'a favor needs deliver_to: one or more character names' };
  if (to.length > MAX_RECIPIENTS) return { ok: false, why: `at most ${MAX_RECIPIENTS} recipients` };
  const source = str(raw.source || 'any').toLowerCase();
  if (!SOURCES.includes(source)) return { ok: false, why: `source must be one of ${SOURCES.join(', ')}` };
  const shopRoom = int(raw.shop_room);
  if (Number.isNaN(shopRoom) || (shopRoom != null && shopRoom < 1)) return { ok: false, why: 'shop_room must be a room number' };
  if (source === 'buy' && shopRoom == null) return { ok: false, why: 'source buy needs shop_room: where the item is sold' };
  const room = int(raw.deliver_room ?? raw.room);
  if (Number.isNaN(room) || (room != null && room < 1)) return { ok: false, why: 'deliver_room must be a room number' };
  return { ok: true, favor: {
    id: str(raw.id) || id || `f${now.toString(36)}`, key: str(raw.key) || null,
    item, amount, to, source, shop_room: shopRoom, room,
    why: str(raw.why) || null, by: str(raw.by) || by || null, created_at: now,
    status: 'open', loaded: 0, delivered: {}, notes: [],
  } };
}

/** Parse an `autopilot action=town_trip` call. Never throws. */
export function normalizeTripCommand(args = {}) {
  const op = str(args.op || 'status').toLowerCase();
  if (!OPS.includes(op)) return { ok: false, why: `op must be one of ${OPS.join(', ')}` };
  const why = str(args.why) || null;
  if (op === 'start') {
    const town = str(args.town || 'market').toLowerCase();
    if (!TOWNS.includes(town)) return { ok: false, why: `town must be one of ${TOWNS.join(', ')}` };
    return { ok: true, op, town, why };
  }
  if (op === 'drop') {
    const holdMs = args.hold_ms == null || args.hold_ms === '' ? DEFAULT_HOLD_MS : Number(args.hold_ms);
    if (!Number.isFinite(holdMs) || holdMs < 0 || holdMs > MAX_HOLD_MS)
      return { ok: false, why: `hold_ms must be 0 to ${MAX_HOLD_MS} (default ${DEFAULT_HOLD_MS})` };
    return { ok: true, op, holdMs, why };
  }
  if (op === 'drop_favor') {
    const id = str(args.favor_id ?? args.id);
    if (!id) return { ok: false, why: 'drop_favor needs favor_id' };
    return { ok: true, op, id, why };
  }
  return { ok: true, op, why };
}

/** Is a hold in force? */
export const holdActive = (hold, now = Date.now()) => !!hold && Number(hold.until) > now;

/**
 * What each recipient gets now. `have` is what the courier is carrying for this favor; the favor's
 * amount is split as evenly as whole items allow (the first recipients get the remainder), less what
 * each has already been given. Never promises more than is carried.
 */
export function sharesFor(favor, have) {
  const n = favor.to.length;
  const base = Math.floor(favor.amount / n), extra = favor.amount % n;
  const out = {};
  let left = Math.max(0, Math.floor(Number(have) || 0));
  favor.to.forEach((name, i) => {
    const due = Math.max(0, base + (i < extra ? 1 : 0) - (favor.delivered?.[name] ?? 0));
    const give = Math.min(due, left);
    if (give > 0) { out[name] = give; left -= give; }
  });
  return out;
}

/** True when every recipient has had its share, or nothing more can arrive. */
export function favorDone(favor) {
  const given = Object.values(favor.delivered ?? {}).reduce((a, b) => a + b, 0);
  return given >= Math.min(favor.amount, favor.loaded);
}

/** A strategy's `townTrip` answer, checked. Unknown keys are reported, never applied. */
export function normalizeTownAnswer(answer, { now = Date.now(), by = null } = {}) {
  if (!answer || typeof answer !== 'object') return { start: null, favors: [], problems: [] };
  const problems = [];
  const unknown = Object.keys(answer).filter(k => !['start', 'favors', 'why'].includes(k));
  if (unknown.length) problems.push(`unknown keys: ${unknown.join(', ')}`);
  let start = null;
  if (answer.start) {
    const c = normalizeTripCommand({ op: 'start', ...(typeof answer.start === 'object' ? answer.start : {}) });
    if (c.ok) start = { town: c.town, why: c.why ?? str(answer.why) ?? null };
    else problems.push(`start: ${c.why}`);
  }
  const favors = [];
  for (const [i, raw] of (Array.isArray(answer.favors) ? answer.favors : []).entries()) {
    const f = normalizeFavor(raw, { now, by, id: `${by ?? 's'}-${now.toString(36)}-${i}` });
    if (f.ok) favors.push(f.favor); else problems.push(`favor ${i}: ${f.why}`);
  }
  return { start, favors, problems };
}

/** Add favors, refusing duplicates by `key` and capping how many are open. Returns what was added. */
export function addFavors(existing, incoming) {
  const added = [], refused = [];
  for (const f of incoming) {
    const open = existing.filter(x => !['delivered', 'dropped'].includes(x.status));
    if (f.key && open.some(x => x.key === f.key)) { refused.push({ id: f.id, why: `a favor with key ${f.key} is already open` }); continue; }
    if (open.length >= MAX_OPEN_FAVORS) { refused.push({ id: f.id, why: `already ${MAX_OPEN_FAVORS} open favors` }); continue; }
    existing.push(f); added.push(f.id);
  }
  return { added, refused };
}

/** The favors as the status board shows them. */
export const favorSummary = favors => (favors ?? []).map(f => ({
  id: f.id, item: f.item, amount: f.amount, to: f.to, source: f.source, shop_room: f.shop_room,
  room: f.room, status: f.status, loaded: f.loaded, delivered: f.delivered, by: f.by, why: f.why,
  notes: (f.notes ?? []).slice(-3),
}));
