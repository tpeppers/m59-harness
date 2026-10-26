// HOW HARD DID THAT LAND? The server never sends a damage number to the attacker. It sends a sentence,
// and the verb in it is a BAND, chosen by damage and element (battler.kod GetDamageDesc, 414-815):
//
//     damage 0      "fails to damage"                         band 0
//     1..5          nick    (shock "jolts",   fire "singes")  band 1
//     6..15         wound   (shock "shocks",  fire "chars")   band 2
//     16+           damage  (shock "fries",   fire "scorches") band 3
//     killed        slay    (shock "electrocutes", ...)       band 4
//
// (DAMAGE_THRESHOLD_WOUND = 5, DAMAGE_THRESHOLD_DAMAGE = 15, battler.kod:26-27. Against a PLAYER, a blow of
// at least a third of their maximum health forces the top verb, battler.kod:927-933.) The line is
// "Your <weapon or spell> <verb> <target>." (battler_attacker_hit, battler.kod:42).
//
// AND A SEPARATE LINE SAYS THE TARGET RESISTED (player.kod MsgPlayerHitResisted, 9686-9729):
//     resistance > 60   "<target> laughs off your pitiful blow."
//     resistance > 20   "<target> shrugs off your attack."
//     <= -20            "<target> staggers backwards from the blow."
//     <= -60            "<target> convulses and seems to be suffering badly."
// A resist buff (withstand fire, resist shock, resist magic...) is an ENCHANTMENT, and `purge` removes
// enchantments -- so "laughs off" against a player is a reason to ask for a purge (purge.kod:211-247).
// A resistance RING is not an enchantment and purge does not touch it.
export const BANDS = Object.freeze(['fail', 'nick', 'wound', 'damage', 'slay']);
export const VERBS = Object.freeze({
  generic: ['fails to damage', 'nicks', 'wounds', 'damages', 'slays'],
  acid: [null, 'burns', 'sears', 'disfigures', 'dissolves'],
  fire: [null, 'singes', 'chars', 'scorches', 'incinerates'],
  shock: [null, 'jolts', 'shocks', 'fries', 'electrocutes'],
  cold: [null, 'cools', 'chills', 'frosts', 'freezes'],
  holy: [null, 'infuses', 'cleanses', 'mortifies', 'purifies'],
  unholy: [null, 'maligns', 'pollutes', 'appalls', 'corrupts'],
  quake: [null, 'shakes', 'buffets', 'slams', 'flattens'],
  bite: [null, 'nips', 'bites', 'gnaws', 'devours'],
  claw: [null, 'claws', 'rakes', 'rends', 'shreds'],
  sting: [null, 'irritates', 'stings', 'pricks', 'impales'],
  punch: [null, 'slaps', 'pummels', 'mangles', 'thrashes'],
  slash: [null, 'cuts', 'slashes', 'maims', 'cleaves'],
  bludgeon: [null, 'bashes', 'crushes', 'smashes', 'brutalizes'],
  thrust: [null, 'pokes', 'stabs', 'impales', 'runs through'],
  pierce: [null, 'grazes', 'pierces', 'lacerates', 'fells'],
});
// The element of the common attack spells and spell-wands, so a caller can say "my lightning wand".
export const SPELL_ELEMENTS = Object.freeze({
  'lightning bolt': 'shock', 'lightning wand': 'shock', 'shocking fury': 'shock', 'zap': 'shock',
  'fireball': 'fire', 'blast of fire': 'fire', 'fire wand': 'fire', 'wand of fire': 'fire', 'flame': 'fire',
  'explosive frost': 'cold', 'frost': 'cold', 'splash of acid': 'acid', 'acid': 'acid',
  'holy touch': 'holy', 'unholy touch': 'unholy', 'vampiric drain': 'unholy', 'earthquake': 'quake',
});
export const RESISTED = Object.freeze([
  { re: /laughs off your pitiful blow/i, resisted: 'laughs', min_resist: 61 },
  { re: /shrugs off your attack/i, resisted: 'shrugs', min_resist: 21 },
  { re: /convulses and seems to be suffering badly/i, weak: 'badly', max_resist: -60 },
  { re: /staggers backwards from the blow/i, weak: 'staggers', max_resist: -20 },
]);

const clean = t => String(t ?? '').replace(/~[a-zA-Z]/g, '').replace(/\s+/g, ' ').trim();
const ALL = Object.entries(VERBS).flatMap(([element, list]) => list.map((verb, band) => verb && { verb, band, element }).filter(Boolean))
  .sort((a, b) => b.verb.length - a.verb.length);

/**
 * Read one server line about OUR attack. Returns null when the line is not one, else
 * { kind: 'hit'|'resisted', band, band_name, element, verb, with, target, resisted, weak, min_resist, max_resist }.
 * `element` is the verb's element; for a generic verb it is null (the attack's own element may still be
 * known to the caller). A verb two elements share ("impales") is reported with the first one listed.
 */
export function readOurBlow(text) {
  const t = clean(text);
  for (const r of RESISTED) {
    if (!r.re.test(t)) continue;
    const target = t.replace(r.re, '').replace(/\.$/, '').trim() || null;
    return { kind: 'resisted', band: null, band_name: null, element: null, verb: null, with: null, target,
      resisted: r.resisted ?? null, weak: r.weak ?? null, min_resist: r.min_resist ?? null, max_resist: r.max_resist ?? null };
  }
  const m = /^Your (.+?) (.+)\.$/.exec(t);
  if (!m) return null;
  const rest = m[1] + ' ' + m[2];
  for (const v of ALL) {
    const i = (' ' + rest + ' ').indexOf(' ' + v.verb + ' ');
    if (i <= 0) continue;
    const withWhat = rest.slice(0, i - 1).trim(), target = rest.slice(i - 1 + v.verb.length + 1).trim();
    if (!withWhat || !target) continue;
    return { kind: 'hit', band: v.band, band_name: BANDS[v.band], element: v.element === 'generic' ? null : v.element,
      verb: v.verb, with: withWhat.toLowerCase(), target, resisted: null, weak: null, min_resist: null, max_resist: null };
  }
  return null;
}

/** The element an attack named by its weapon, spell or wand does, or null. */
export function elementOf(name) {
  const n = String(name ?? '').toLowerCase().trim();
  if (SPELL_ELEMENTS[n]) return SPELL_ELEMENTS[n];
  for (const [k, v] of Object.entries(SPELL_ELEMENTS)) if (n.includes(k)) return v;
  return null;
}
