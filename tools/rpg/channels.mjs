// WHAT CAN I ATTACK WITH? Every offensive channel a character has right now, named the way joints and
// paks name them: 'melee', 'bow', 'wand:<name>', 'spell:<name>'. Each says its timer (rpg/timers.mjs),
// whether it reaches past melee range, and its element (rpg/damage.mjs) when the game gives it one.
//
// Read from the client's own lists -- the wielded set, the pack, the spells known -- and nothing else.
// A channel listed here is POSSIBLE, not READY: whether the target is in sight, whether the timer is free,
// and whether the server will let the blow land are the fight's questions, answered where the fight is.
import { timerOf } from './timers.mjs';
import { elementOf } from './damage.mjs';

const lower = s => String(s ?? '').trim().toLowerCase();
const BOW = /\b(bow|longbow|shortbow|crossbow)\b/;
const WAND = /\b(wand|staff|bonkstick)\b/;
// Attack spells: the catalogue's AttackSpell family. Kept as names so this file needs no catalogue.
export const ATTACK_SPELLS = Object.freeze(['lightning bolt', 'fireball', 'blast of fire', 'explosive frost', 'splash of acid',
  'shocking fury', 'zap', 'holy touch', 'unholy touch', 'vampiric drain', 'flame', 'slitherbolt', 'earthquake']);

export function channelsOf(c) {
  const name = o => lower(o?.name ?? c?.rsc?.get?.(o?.nameRsc));
  const eq = safe(() => c.equipment?.()) ?? null;
  const worn = (eq?.equipped ?? []).map(e => lower(e.name));
  const out = [];
  const weapon = worn.find(n => BOW.test(n)) ?? worn.find(n => /\b(sword|mace|axe|hammer|scimitar|dagger|spear|club|blade|cutlass|kriss)\b/.test(n));
  if (weapon && BOW.test(weapon)) out.push(row('bow', weapon, true));
  out.push(row('melee', weapon && !BOW.test(weapon) ? weapon : 'fists', false));
  for (const o of Array.isArray(c?.inventory) ? c.inventory : []) {
    const n = name(o);
    if (n && WAND.test(n) && !out.some(x => x.channel === `wand:${n}`)) out.push(row(`wand:${n}`, n, true, o.id));
  }
  for (const sp of Array.isArray(c?.spells) ? c.spells : []) {
    const n = name(sp);
    if (ATTACK_SPELLS.includes(n)) out.push(row(`spell:${n}`, n, true, sp.id));
  }
  return out;
}

function row(channel, what, ranged, id = null) {
  const t = timerOf(channel);
  return { channel, what, id, ranged, timer: t.timer, timer_ms: t.ms, element: elementOf(what) };
}
function safe(f) { try { return f(); } catch { return null; } }
