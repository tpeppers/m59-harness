// WHO SWUNG AT WHOM, AND DID IT LAND — READ OFF THE SERVER'S OWN PROSE.
//
//   import { classifyCombatLine, isMySwing, isEnemySwing, isEnemyHit, isEnemyMiss }
//     from './m59-combatlog.mjs';        // or from './m59-fleetscript.mjs'
//
//   classifyCombatLine('The troll wounds you with its attack.')
//     -> { kind: 'enemy-swing', landed: true, other: 'troll', verb: 'wounds',
//          tier: 'wound', element: 'normal', weapon: 'attack' }
//
// WHY THIS IS A SHARED MODULE AND NOT ANOTHER REGEX AT THE CALL SITE.
//
// Damage arrives as a stat packet that names nobody. The prose that names an attacker is a
// separate message with no id tying the two together, so anything that wants to know "was I
// attacked, by what, and did it connect" has to read the words. Four places in this repository
// were doing that independently and NONE of them was complete:
//
//   m59-provewall.mjs   /^You\s+\w+\s+.+'s attack\.?$/i   incoming MISSES only
//   m59-circuit.mjs     the identical regex, copied        incoming MISSES only
//   m59-game.mjs        /^(?:The|An?) (...) (?:[a-z]+s) you\b/i   incoming HITS only
//   m59-wallproof.mjs   an enumerated verb list            missed "Your mace CRUSHES the spider"
//
// The first two count every blow that MISSED and silently drop every blow that LANDED, which
// is the wrong half for a tool asking whether a square is dangerous. The third is the exact
// complement. The fourth enumerated verbs by hand and dropped 22 of the body's own swings in
// a 20-minute sample — scoring them as "not swinging", which is the direction that
// manufactures a safe-looking answer.
//
// ── THE VOCABULARY IS THE GAME'S, NOT AN OBSERVED SAMPLE ──────────────────────────────────
//
// Every pattern below is the format string from `battler.kod`, with the worked examples its
// own comments give (kod/object/active/holder/nomoveon/battler.kod:37-48):
//
//   battler_attacker_hit  = "%sYour %s %s %s%s."        Your scimitar wounds Psychochild.
//   battler_attacker_miss = "%s%s%s %s your attack."    Psychochild blocks your attack.
//   battler_defender_hit  = "%s%s%s %s you with %s %s." Psychochild wounds you with his scimitar.
//   battler_defender_miss = "%sYou %s %s%s's attack."   You block Psychochild's attack.
//
// The leading `%s` is a colour code (`battler_blue_text = "~b"`, or empty), so codes are
// stripped before matching.
//
// THE VERBS ARE A CLOSED SET AND THAT IS WHAT MAKES THIS SAFE. `%s` in the verb slot is filled
// from a fixed table of 81 resources in the same file — nicks/wounds/damages/slays crossed with
// eleven damage elements, plus the four evade verbs. Matching against that table instead of
// `\w+` is what stops "Your weapon takes on a duller cast." and "Your body is possessed by the
// spirit of the warrior Kara'hol..." from being read as attacks. A hand-written verb list is
// how the fourth parser above went wrong; this one is transcribed from source and asserted
// against it in m59-combatlog-test.mjs.

// ── the closed verb table, transcribed from battler.kod ──────────────────────────────────────
// tier order is the damage the blow did: nick < wound < damage < slay. `fails to damage` is a
// blow that connected and did nothing, which is NOT a miss — the distinction matters to anything
// counting whether a square let something reach you.
const DAMAGE = {
  normal:   { nick: 'nicks',      wound: 'wounds',   damage: 'damages',    slay: 'slays' },
  acid:     { nick: 'burns',      wound: 'sears',    damage: 'disfigures', slay: 'dissolves' },
  fire:     { nick: 'singes',     wound: 'chars',    damage: 'scorches',   slay: 'incinerates' },
  shock:    { nick: 'jolts',      wound: 'shocks',   damage: 'fries',      slay: 'electrocutes' },
  cold:     { nick: 'cools',      wound: 'chills',   damage: 'frosts',     slay: 'freezes' },
  holy:     { nick: 'infuses',    wound: 'cleanses', damage: 'mortifies',  slay: 'purifies' },
  unholy:   { nick: 'maligns',    wound: 'pollutes', damage: 'appalls',    slay: 'corrupts' },
  quake:    { nick: 'shakes',     wound: 'buffets',  damage: 'slams',      slay: 'flattens' },
  bite:     { nick: 'nips',       wound: 'bites',    damage: 'gnaws',      slay: 'devours' },
  claw:     { nick: 'claws',      wound: 'rakes',    damage: 'rends',      slay: 'shreds' },
  sting:    { nick: 'irritates',  wound: 'stings',   damage: 'pricks',     slay: 'impales' },
  punch:    { nick: 'slaps',      wound: 'pummels',  damage: 'mangles',    slay: 'thrashes' },
  slash:    { nick: 'cuts',       wound: 'slashes',  damage: 'maims',      slay: 'cleaves' },
  bludgeon: { nick: 'bashes',     wound: 'crushes',  damage: 'smashes',    slay: 'brutalizes' },
  thrust:   { nick: 'pokes',      wound: 'stabs',    damage: 'impales',    slay: 'runs through' },
  pierce:   { nick: 'grazes',     wound: 'pierces',  damage: 'lacerates',  slay: 'fells' },
};
const FAIL_VERB = 'fails to damage';                      // battler_fail
// battler_block/dodge/parry/avoid and their -s forms. The defender template uses the bare form
// ("You block ...") and the attacker template the inflected one ("Psychochild blocks ...").
const EVADE = ['block', 'blocks', 'dodge', 'dodges', 'parry', 'parries', 'avoid', 'avoids'];

/** verb -> { element, tier }. `impales` is thrust/damage and sting/slay; first wins, and the
 *  ambiguity is real in the game too — nothing downstream should lean on element alone. */
export const VERB_TABLE = Object.freeze((() => {
  const t = {};
  for (const [element, tiers] of Object.entries(DAMAGE))
    for (const [tier, verb] of Object.entries(tiers))
      if (!(verb in t)) t[verb] = Object.freeze({ element, tier });
  t[FAIL_VERB] = Object.freeze({ element: 'normal', tier: 'fail' });
  return t;
})());

export const DAMAGE_VERBS = Object.freeze(Object.keys(VERB_TABLE));
export const EVADE_VERBS = Object.freeze([...EVADE]);

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// longest-first so "runs through" and "fails to damage" win over any prefix
const alt = xs => [...xs].sort((a, b) => b.length - a.length).map(esc).join('|');
const DMG = alt(DAMAGE_VERBS);
const EVD = alt(EVADE_VERBS);

// Colour codes: `~b` (battler_blue_text), `~I`, `~k` and friends are inline markup, not text.
export const stripCodes = s => String(s ?? '').replace(/~[a-zA-Z]/g, '').trim();

// ── the four canonical templates ─────────────────────────────────────────────────────────────
const MY_HIT      = new RegExp(`^Your (.+?) (${DMG}) (?:the |an? )?(.+?)\\.$`, 'i');
const MY_MISS     = new RegExp(`^(?:The |An? )?(.+?) (${EVD}) your attack\\.$`, 'i');
const ENEMY_HIT   = new RegExp(`^(?:The |An? )?(.+?) (${DMG}) you with (?:its|his|her|their|the|an?) (.+?)\\.$`, 'i');
const ENEMY_MISS  = new RegExp(`^You (${EVD}) (?:the |an? )?(.+?)'s attack\\.$`, 'i');

// player.kod — outcomes of MY blow that are not the standard hit line
const MY_KILL     = /^You killed (?:the |an? )?(.+?)\.$/i;                     // player_killed_something
const MY_RESISTED = /^(?:The |An? )?(.+?) shrugs off your attack\.$/i;         // player_hit_resisted
const MY_STAGGER  = /^(?:The |An? )?(.+?) staggers backwards from the blow\.$/i; // player_hit_anti_resisted
const MY_LAUGHED  = /^(?:The |An? )?(.+?) laughs off your pitiful blow\.$/i;
const MY_TOOFAR   = /^(?:The |An? )?(.+?) is too far away to hit with/i;
const MY_UNPROVOKED = /^Shal'ille frowns upon your unprovoked attack\.$/i;     // player_aggressor

// A monster with bespoke prose (thrasher.kod: "The thrasher spins, damaging you with its
// attack."). Deliberately last and deliberately loose: it is flagged `loose: true` so a caller
// that needs only template-exact evidence can drop it.
const ENEMY_LOOSE = /^(?:The |An? )?(.+?)\b.* you with (?:its|his|her|their) attack\.$/i;

// POISON IS NOT AN ATTACK. A tick reaches a body through any geometry ever built, so counting
// it as an attack makes a perfect safe wall look like it leaked. It is classified, not dropped,
// so callers can SHOW it was excluded rather than merely assert it.
const POISON = /^(?:Fresh poison courses through your veins|You feel the poison|The poison )/i;

/**
 * Classify one line of server prose.
 * @returns {null|{kind:string, landed:(boolean|null), other:(string|null), verb?:string,
 *                 tier?:string, element?:string, weapon?:string, loose?:boolean}}
 *   kind: 'my-swing'   — I attacked something (`landed` says whether it connected)
 *         'enemy-swing'— something attacked me (`landed` says whether it connected)
 *         'kill'       — I killed something
 *         'poison'     — a poison tick; NOT an attack
 *         'karma'      — Shal'ille's unprovoked-attack scolding; proves I swung
 *   null when the line is not about combat at all.
 */
export function classifyCombatLine(text) {
  const s = stripCodes(text);
  if (!s) return null;
  let m;
  if (POISON.test(s)) return { kind: 'poison', landed: null, other: null };

  if ((m = s.match(MY_HIT))) {
    const v = VERB_TABLE[m[2].toLowerCase()] ?? {};
    return { kind: 'my-swing', landed: true, other: m[3], weapon: m[1],
             verb: m[2].toLowerCase(), tier: v.tier, element: v.element };
  }
  if ((m = s.match(ENEMY_HIT))) {
    const v = VERB_TABLE[m[2].toLowerCase()] ?? {};
    return { kind: 'enemy-swing', landed: true, other: m[1], weapon: m[3],
             verb: m[2].toLowerCase(), tier: v.tier, element: v.element };
  }
  if ((m = s.match(ENEMY_MISS)))
    return { kind: 'enemy-swing', landed: false, other: m[2], verb: m[1].toLowerCase() };
  if ((m = s.match(MY_MISS)))
    return { kind: 'my-swing', landed: false, other: m[1], verb: m[2].toLowerCase() };
  if ((m = s.match(MY_KILL)))    return { kind: 'kill', landed: true, other: m[1] };
  if ((m = s.match(MY_RESISTED)))return { kind: 'my-swing', landed: true, other: m[1], tier: 'fail' };
  if ((m = s.match(MY_LAUGHED))) return { kind: 'my-swing', landed: true, other: m[1], tier: 'fail' };
  if ((m = s.match(MY_STAGGER))) return { kind: 'my-swing', landed: true, other: m[1], tier: 'damage' };
  if ((m = s.match(MY_TOOFAR)))  return { kind: 'my-swing', landed: false, other: m[1], verb: 'out of range' };
  if (MY_UNPROVOKED.test(s))     return { kind: 'karma', landed: null, other: null };
  if ((m = s.match(ENEMY_LOOSE)))return { kind: 'enemy-swing', landed: true, other: m[1], loose: true };
  return null;
}

// ── the four questions callers actually ask ──────────────────────────────────────────────────
//
// `isMySwing` is TRUE for a swing that missed, was resisted, or was out of range, because the
// question it answers is "did this body swing", not "did it do damage". Anything deciding
// whether a safe wall's no-swinging contract was honoured wants it that way: a whiffed swing
// provokes exactly as a landed one does.
export const isMySwing    = t => classifyCombatLine(t)?.kind === 'my-swing';
export const isEnemySwing = t => classifyCombatLine(t)?.kind === 'enemy-swing';
export const isEnemyHit   = t => { const c = classifyCombatLine(t); return c?.kind === 'enemy-swing' && c.landed === true };
export const isEnemyMiss  = t => { const c = classifyCombatLine(t); return c?.kind === 'enemy-swing' && c.landed === false };
export const isPoisonTick = t => classifyCombatLine(t)?.kind === 'poison';

/** The name on the other side of the blow, or null. */
export const combatCounterparty = t => classifyCombatLine(t)?.other ?? null;

/**
 * Tally a stream of lines. The shape every caller in this repo was rolling by hand.
 * @param {Iterable<string|{text:string}>} lines
 */
export function tallyCombat(lines) {
  const out = { mySwings: 0, myLanded: 0, enemySwings: 0, enemyHits: 0, enemyMisses: 0,
                kills: 0, poison: 0, byAttacker: {}, unclassified: [] };
  for (const raw of lines) {
    const text = typeof raw === 'string' ? raw : raw?.text;
    if (typeof text !== 'string') continue;
    const c = classifyCombatLine(text);
    if (!c) { out.unclassified.push(text); continue }
    if (c.kind === 'my-swing') { out.mySwings++; if (c.landed) out.myLanded++ }
    else if (c.kind === 'enemy-swing') {
      out.enemySwings++; c.landed ? out.enemyHits++ : out.enemyMisses++;
      if (c.other) out.byAttacker[c.other] = (out.byAttacker[c.other] ?? 0) + 1;
    } else if (c.kind === 'kill') out.kills++;
    else if (c.kind === 'poison') out.poison++;
  }
  return out;
}
