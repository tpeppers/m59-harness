// POISON, AS THE KEEPER NEEDS TO KNOW IT. Pure.
//
// player.kod: AddPoison raises piPoisonStrength and starts a 10-second PoisonTimer; each tick takes strength/1000 health and
// CLAMPS AT 1 -- poison cannot kill, it only leaves a body one hit from death. The timer re-arms only while the player is in
// the world, and UserLogonHook starts a fresh one whenever strength remains, so a relog inside ten seconds runs two. A
// black spider (dethspid.kod) poisons one bite in ten: 5000 = 0.5 HP/s for 180 s, stacking.
//
// Operator, 2026-10-27: "the correct solution to poison is to lock down in the nearest safe spot until the poison ends
// and healing occurs afterwards, not to flee through it and risk low-health travel. Shelter in place."
export const POISON_RELOG_OFFLINE_MS = 12_000;
/** Is this client poisoned now? The ailment enchantment the server pushes, by name. */
export function poisonedNow(c) {
  try { return (c?.ailments?.() ?? []).some(e => /poison|venom/i.test(String(e?.name ?? e ?? ''))); } catch { return false; }
}
