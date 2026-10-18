// WHAT A KILL DROPPED, AND WHAT THE LOOT PASS DID WITH EACH PIECE. Pure; no socket, no ledger.
//
// `looted` says what entered a pack and `left_pack` where it went, and nothing said what was ON
// THE FLOOR — so "what share of the drops did we pick up" had no denominator. fight() already
// snapshots the gettable ids before the first swing (`kill.before`, for loot_only attribution);
// whatever is gettable after the kill and was not there before is this kill's drop. lootFloor
// writes one `kill_drop` row per kill from this, and m59-lootfate.mjs reads it.
//
// ATTRIBUTION IS BY ARRIVAL, NOT BY CORPSE. A fleet-mate's kill landing in the same room during
// the fight is counted in both rows; the reader counts an id once.
//
// UNIDENTIFIED IS RECORDED AS SUCH, WITH ITS ICON. Every ring is "ring" until revealed, and the
// icon resource id names the class exactly (m59-item-signature.mjs) — a ring of lethargy and a
// fire-resistance ring are different ids under one name.

const lc = s => String(s ?? '').toLowerCase();

// floor: the gettable objects after the kill, as {id, name, amount, icon_rsc, unrevealed}.
// before: the Set of ids gettable when the fight began. taken / refused: lootFloor's own lists
// (refused rows carry an id, or only `item`/`name` for the name-based filters).
export function killDropItems({ floor = [], before = null, taken = [], refused = [], cancelled = false } = {}) {
  if (!(before instanceof Set)) return null;
  const drop = floor.filter(o => o && !before.has(o.id));
  const took = new Set(taken.map(t => t.id));
  const byId = new Map(), byName = [];
  for (const r of refused) {
    if (r?.id != null) byId.set(r.id, r.why);
    else byName.push({ name: lc(r?.item ?? r?.name).replace(/ \(.*$/, ''), why: r?.why, used: false });
  }
  return drop.map(o => {
    const row = { id: o.id, name: o.name ?? null,
                  ...(o.amount > 1 ? { amount: o.amount } : {}),
                  ...(o.icon_rsc != null ? { icon_rsc: o.icon_rsc } : {}),
                  ...(o.unrevealed ? { unrevealed: true } : {}) };
    if (took.has(o.id)) return { ...row, taken: true };
    let why = byId.get(o.id);
    if (why == null) {
      const n = byName.find(b => !b.used && b.name === lc(o.name));
      if (n) { n.used = true; why = n.why; }
    }
    return { ...row, taken: false,
             why: why ?? (cancelled ? 'the loot pass was cancelled before reaching it'
                                    : 'not attempted (past maxItems, or filtered before ranking)') };
  });
}

// The short label a reader groups refusals by: the first clause, without its explanation.
export const leftReason = why => {
  const s = String(why ?? 'unknown');
  const m = s.match(/^[A-Z][A-Z' -]{2,}(?=\b)/);       // CURSED —, IGNORED —, BROKEN —
  if (m) return m[0].trim().toLowerCase();
  return s.split(/ — |: |; |, /)[0].slice(0, 60);
};
