// THE BATTLE TIMERS, AND WHICH ATTACKS SHARE ONE.
//
// There is ONE player-wide attack timer, `ptAttackTimer` (player.kod:938), enforced by IsOkayAttackTime
// (player.kod:5305-5331). A busy timer refuses in silence. Everything that calls it shares it:
//
//   melee, punch, bow       1000 ms      TryAttack, player.kod:3973-3977 (bows go through TryAttack too)
//   every spell             viPostCast_time seconds (spell.kod:760; default 1 s, attack spells 2 s,
//                                         hold 2, shatter/swap/slitherbolt 5, truce 3)
//   SPELL-ITEM wands        the timer of the spell they cast (spelitem.kod:258-261 -> CanPayCosts with
//                           bItemCast; the timer check at spell.kod:760 sits outside the item exemption).
//                           A lightning wand is lightning bolt's 2 s. Busy: "You point your wand but
//                           nothing happens." (wand.kod:90-95), and no charge is spent.
//   the gnarled staff       3000 ms (joltstaf.kod:20,76)
//
// AND THREE WANDS HAVE NO TIMER AT ALL -- the old SpecialWand family (specwand.kod): wand of fire, wand of
// healing, wand of vampiric shock. Their apply path (TryApplyItem, player.kod:3562-3606) never asks the
// attack timer. So the answer to "can I use a heal wand between swings without losing the rhythm" is yes:
// a heal-wand apply does not start or wait on ptAttackTimer, and the next swing is due exactly when it
// would have been. (The movement/packet pacer still spaces our own packets; that is ours, not the server's.)
import { readFileSync } from 'node:fs';

export const ATTACK_TIMER = Object.freeze({ melee: 1000, bow: 1000, punch: 1000, staff: 3000, spell_default: 1000, attack_spell: 2000 });
export const UNTIMED_WANDS = Object.freeze(['wand of fire', 'wand of healing', 'wand of vampiric shock']);
// The spell each spell-item wand casts (spelitem/wand/*.kod viSpellEffect), by the label players see.
export const WAND_SPELLS = Object.freeze({
  'lightning wand': 'lightning bolt', 'wand of blinding': 'blind', 'wand of weapon weakening': 'brittle',
  'wand of dementia': 'dement', 'wand of weakness': 'enfeeble', 'wand of forgetfulness': 'forget',
  'wand of immobilization': 'hold', 'wand of rejuvenation': 'hospice', 'wand of identification': 'identify',
  'wand of branding': 'mark of dishonor', 'wand of magical cleansing': 'purify', 'wand of charming': 'seduce',
  'wand of destruction': 'shatter', 'wand of striking': 'slitherbolt', 'wand of filching': 'swap',
});

let spells = null;
function spellMs(name) {
  if (!spells) {
    spells = new Map();
    try {
      const j = JSON.parse(readFileSync(new URL('../../substrate/m59-spells.json', import.meta.url), 'utf8'));
      for (const sp of Array.isArray(j) ? j : j.spells ?? Object.values(j)) if (sp?.name) spells.set(String(sp.name).toLowerCase(), sp);
    } catch { /* no catalogue */ }
  }
  const sp = spells.get(String(name ?? '').toLowerCase());
  return Number.isFinite(sp?.post_cast_ms) ? sp.post_cast_ms : null;
}

/**
 * Which timer a channel uses and for how long: { timer: 'attack'|'none', ms, cite }.
 * A channel is 'melee' | 'bow' | 'punch' | 'spell:<name>' | 'wand:<name>' | 'staff'.
 */
export function timerOf(channel) {
  const c = String(channel ?? '').toLowerCase();
  if (c === 'melee' || c === 'bow' || c === 'punch') return { timer: 'attack', ms: ATTACK_TIMER[c], cite: 'player.kod:3973-3977' };
  if (c === 'staff' || c === 'wand:gnarled staff') return { timer: 'attack', ms: 3000, cite: 'joltstaf.kod:20,76' };
  if (c.startsWith('spell:')) {
    const n = c.slice(6);
    return { timer: 'attack', ms: spellMs(n) ?? ATTACK_TIMER.attack_spell, cite: 'spell.kod:760 viPostCast_time' };
  }
  if (c.startsWith('wand:')) {
    const n = c.slice(5);
    if (UNTIMED_WANDS.some(w => n.includes(w))) return { timer: 'none', ms: 0, cite: 'specwand.kod (SpecialWand: no timer)' };
    const sp = Object.entries(WAND_SPELLS).find(([w]) => n.includes(w))?.[1];
    return { timer: 'attack', ms: (sp && spellMs(sp)) ?? ATTACK_TIMER.attack_spell,
      cite: `spelitem.kod:258-261 -> ${sp ?? 'its spell'}'s viPostCast_time` };
  }
  return { timer: 'attack', ms: 1000, cite: 'unknown channel: assume the shared timer' };
}

/**
 * The beat: given when the shared timer frees (`attack_ready_at`) and the channels on hand, which can go
 * NOW. An untimed channel can always go (subject to its own target rules); a timed one only when the
 * shared timer is free, and using it pushes the next timed action out by its ms.
 */
export function beat({ now = Date.now(), attack_ready_at = 0, channels = [] } = {}) {
  const wait = Math.max(0, attack_ready_at - now);
  return {
    attack_ready_in_ms: wait,
    free_channels: channels.filter(ch => timerOf(ch).timer === 'none'),
    timed_ready: wait === 0 ? channels.filter(ch => timerOf(ch).timer === 'attack') : [],
    after: Object.fromEntries(channels.map(ch => [ch, timerOf(ch).timer === 'none' ? attack_ready_at : now + wait + timerOf(ch).ms])),
  };
}
