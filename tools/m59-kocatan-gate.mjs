// CLEARING THE KO'CATAN GATE BEFORE THE WALK BACK, NOT AFTER THE REFUSAL.
//
// The captain in the East Tower (2013) refuses anyone stepping out to the jungle (2115) with more than two weapons, a
// second armour, shield, helmet or gauntlets, alcohol or raw nerudite (kocatwn.kod CanPass; m59-island-chalice.mjs
// jungleStashPlan is the rule). An island farmer loots exactly those things, sells at the island counters, and walks
// back -- and an ordinary sale keeps them: `maxWeapons` is six and the protected list keeps long swords and hammers.
// So the walk back was refused, and the refusal ladder (a sell trip, then the vault an hour later) has no last rung for
// what neither the smithy nor the vaultman will take. Prod 2026-10-29: Robin held a conjured long sword (protected, so
// not sold; conjured, so the vaultman "could not bear to part with" it) and stood in town from 07:51Z to 14:00Z.
//
// Operator, 2026-10-29: "Have island sell trips by default automatically sell/vault/drop loot to be able to return to
// farming according to the guard rules." So the island town trip ends by clearing the gate, in that order:
//   SELL  at the smithy (Ixla, 2003) what is plain loot -- not protected, not unidentified or magic
//   VAULT at Itzal (2005) what is worth keeping, and whatever the smithy would not buy
//   DROP  what is still over the limit and not worn: the vaultman refuses a conjured weapon, and it is worth nothing
// Worn pieces are never touched; the guard rule keeps worn protection before spares.
//
// NOT BUILT, ON PURPOSE: the bribe. The captain on duty is sometimes the corrupt one, who can be paid to look away
// (kocatwn.kod; a time check and a wait for his shift). The operator wants it available as an option one day and NOT
// enabled for the current farming, so nothing here pays anyone.
//
// Policy `kocatanGateClear` (broker `kocatan_gate_clear`): true by default; false restores the old refusal ladder only.

export const KOCATAN_SMITHY = 2003;
const norm = s => String(s ?? '').trim().toLowerCase();

/** The jungle room a farmer is going back to: its assigned room, else the first confined room past the gate. */
export function gateStation(policy) {
  const assigned = Number(policy?.assignedRoom);
  if (assigned >= 2100 && assigned <= 2699) return assigned;
  const confined = (policy?.confineRooms ?? []).map(Number).find(r => r >= 2100 && r <= 2699);
  return confined ?? null;
}

/**
 * What to sell and what to vault, of the items the guard refuses (`over`, from kocatanGateRefusal). Pure.
 * `protect`: names the character keeps (saleProtectedNames). `rarity`: the item's grade -- above 0 is unidentified or
 * magic, which goes to the vault rather than a counter (unread magic is worth revealing). Worn items are left alone.
 * Whatever the vault then refuses is dropped by the caller; the plan does not decide drops in advance, because only the
 * vaultman's answer says which ones he will not take.
 */
export function gateClearPlan(over, { protect = [] } = {}) {
  const kept = new Set(protect.map(norm));
  const sell = [], vault = [];
  for (const item of over ?? []) {
    if (item?.was_equipped || item?.id == null) continue;
    if (kept.has(norm(item.name)) || Number(item.rarity) > 0) vault.push(item);
    else sell.push(item);
  }
  return { sell, vault };
}
