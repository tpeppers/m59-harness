// ACTS THAT ARE ALLOWED BUT HAVE TO BE SAID OUT LOUD: ONE LIST, AND ONE WAY TO SAY IT.
//
// Operator, 2026-10-26: "easy things should be easy, simple things should be simple, but it should be hard to make
// mistakes without getting a warning or having to pass a --confirm". Each entry below is an act that is sometimes
// exactly what the operator wants and is otherwise a mistake that costs a character: an order carrying it is refused
// unless it names the hazard in `accept` (`--accept <id>` on a CLI, `accept: ['<id>']` on an MCP call or in a
// FleetScript's call). The refusal names the flag, so the next attempt is one word longer, not a code search.
//
// Where each is enforced:
//   survival_off, no_flee, travel_unguarded   m59-posture.mjs apply (a posture that sets them)
//   survival_off_move                          the broker's tool door (callTool): a journey for a survival-off body to a
//                                              room that is not NO_COMBAT
//   go_red                                     m59-combat-mode.mjs needsSafetyOff: striking an innocent with safety off
//   reroll                                     the broker's reroll tool, which already wants confirm:true
//   requires_unmet                             the broker's autopilot tool: assigning a farm strategy whose `requires`
//                                              this body does not meet (m59-strategy-gate.mjs)
//
// AND SURVIVAL OFF IS A LEASE. `survival_enabled:false` carries `survivalOffUntil` (default 30 min, at most 12 h,
// `survival_off_ms` to choose); after it the keeper treats survival as ON whatever the stored flag says. The night of
// 2026-10-25 a drill's restore left six troll-crew keepers with survival off until morning, and seven deaths in Ukgoth
// followed: no flee, no frames, every hit heard and ignored.
import { readFileSync } from 'node:fs';

export const HAZARDS = {
  survival_off: 'survival_enabled:false stops ALL ordinary keeper work, practice included, and the flee ladder; it logs no decline (six keepers for a day, prod 2026-10-26)',
  no_flee: 'a flee or rest line under 10% means the character fights to death; the keeper will not run',
  travel_unguarded: 'a journey with its guard off walks on at any health: a character was walked out of a sanctuary at 27% and eaten (2026-08-21)',
  survival_off_move: 'this character has survival OFF: it will not flee, rest or fight back, so sending it anywhere but a no-combat room (an inn, a shop, a bank) is how three troll-crew characters died seven times in Ukgoth (2026-10-26)',
  go_red: 'striking an innocent (not a murderer, outlaw, morph or war enemy) with safety off makes this character an outlaw, and killing one makes it a murderer: merchants refuse it and the karma does not come back',
  reroll: 'reroll deletes the character and cannot be undone',
  requires_unmet: 'this farm strategy requires something this character does not have, so it would stand at its post killing nothing (a troll crew ground six hours with weapons that could not hurt a troll, 2026-10-26). Accepted, the strategy is assigned and waits, stood down, until the requirement is met',
};

export const accepts = (accept, id) => Array.isArray(accept) ? accept.includes(id) : accept === id;
export function refusal(id, detail = '') {
  return `${id}: ${HAZARDS[id] ?? 'a named hazard'}${detail ? ` (${detail})` : ''}. Nothing was done. If this is meant, say so: accept: ["${id}"] (CLI: --accept ${id})`;
}

// ------------------------------------------------------------------------------------- survival as a lease
export const SURVIVAL_OFF_DEFAULT_MS = 30 * 60_000;
export const SURVIVAL_OFF_MAX_MS = 12 * 3_600_000;
/** The lease length for a survival-off order: the caller's, clamped; the default when none was given. */
export function survivalOffLeaseMs(ms) {
  if (ms == null) return SURVIVAL_OFF_DEFAULT_MS;
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 60_000) throw new Error('survival_off_ms must be at least 60000 (one minute)');
  return Math.min(n, SURVIVAL_OFF_MAX_MS);
}
/** Is survival EFFECTIVELY off? Off only while the flag is false and its lease has not run out. A flag with no lease
 *  (set before leases existed, or pushed straight to a keeper) stays off, as it always did. A plain function of the
 *  policy, not a method: heal and survival paths run on bare objects borrowing the keeper's prototype. */
export function survivalOffOf(policy, now = Date.now()) {
  if (policy?.survivalEnabled !== false) return false;
  const until = Number(policy.survivalOffUntil);
  return !(Number.isFinite(until) && now >= until);
}

// ------------------------------------------------------------------------------------- where nothing can hit you
// THE ROOMS WHERE THE SERVER LETS NOBODY SWING: the room's own NO_COMBAT flag (blakston.khd, checked first in room.kod
// ReqSomethingAttack), as baked into substrate/m59-map.json. 73 rooms: every inn, the shops, banks and halls, Marion.
// One table from the game's own data, not a hand list: the harness had 52/106/153/202/370/2001 and prod's lockdown
// tooling 103/106/153/202/370/1001/1011, and each was missing inns the other had (2026-10-26).
export const ROOM_NO_COMBAT = 0x0002;
let noCombat = null;
export function noCombatRooms(file = new URL('../substrate/m59-map.json', import.meta.url)) {
  if (noCombat) return noCombat;
  noCombat = new Map();
  try {
    const m = JSON.parse(readFileSync(file, 'utf8'));
    for (const r of Array.isArray(m.rooms) ? m.rooms : Object.values(m.rooms ?? m))
      if (r && Number.isFinite(r.num) && (r.flags & ROOM_NO_COMBAT)) noCombat.set(r.num, r.name ?? null);
  } catch { /* no map: nothing is known safe, so the guard allows nothing but an explicit accept */ }
  return noCombat;
}
/** Is this destination (a room number or name) a room where nothing can attack? */
export function isNoCombatRoom(to, rooms = noCombatRooms()) {
  if (to == null || to === '') return false;
  if (rooms.has(Number(to))) return true;
  const want = String(to).trim().toLowerCase();
  for (const name of rooms.values()) if (String(name ?? '').trim().toLowerCase() === want) return true;
  return false;
}

/** Is the room this session stands in NO_COMBAT? The live room's flags first, the baked map's second. */
export function roomIsNoCombat(s) {
  const num = s?.world?.room?.num;
  const f = s?.world?.map?.rooms?.[String(num)]?.flags ?? s?.world?.room?.flags;
  if (Number.isFinite(Number(f))) return (Number(f) & ROOM_NO_COMBAT) !== 0;
  return num != null && noCombatRooms().has(Number(num));
}

// ------------------------------------------------------------------------------------- the broker's door
// Tools that put a body somewhere else. `walk_to`/`crawl_to` stay in the room, so they are left alone; a combat order
// is left alone too, because combat mode keeps its own stop_below whatever survival says, and an operator's kill order
// is the one thing that must not wait.
const MOVES = new Set(['travel']);
/**
 * Refuse a journey for a survival-off character, unless it accepts `survival_off_move`. A journey to a NO_COMBAT room
 * (an inn, a shop, a bank) is allowed: that is where a character with survival off belongs. `policyOf(agent)` reads
 * the stored policy; `safe(to)` says whether a destination is a no-combat room (default: the baked map).
 */
export function survivalOffConflict({ tool, args = {}, policyOf, safe = isNoCombatRoom, now = Date.now() }) {
  if (!MOVES.has(tool)) return null;
  if (accepts(args.accept, 'survival_off_move')) return null;
  const agents = [args.agent, ...(Array.isArray(args.agents) ? args.agents : [])].filter(Boolean);
  const off = agents.filter(a => survivalOffOf(policyOf(a), now));
  if (!off.length) return null;
  const to = args.to;
  if (safe(to)) return null;
  return { id: 'survival_off_move', agents: off, error: refusal('survival_off_move', `${off.join(', ')} -> ${to}`) };
}
