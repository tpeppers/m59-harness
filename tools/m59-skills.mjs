#!/usr/bin/env node
// Composite behaviours: the multi-step things a player does, done in one call.
//
// The primitive tools are faithful to the protocol, which makes them precise and
// tedious. Fighting one monster correctly is: find it, check you are armed, route to
// a square beside it, turn to face it, swing on the server's one-per-second clock,
// read your health between swings, decide whether to keep going, notice when it dies,
// then walk over the drops and pick them up. That is a dozen paced calls, and every
// one of them has a silent failure mode.
//
// A capable agent can drive that. A small one should not have to. Everything here is
// built from the same primitives and takes the same care — the difference is that the
// decisions are made in code instead of by the model, and reported afterwards so the
// model can still see what happened and disagree.
//
// The rule these follow: never fail silently, and never quietly do something the
// caller did not ask for. A skill that gives up says why, at which stage, and what
// the state was when it stopped.

import { OF, isTeleporter, describeObject, dropSpec, KOD_FINENESS } from './m59-parse.mjs';
// The Underworld's exits, and which city is nearest to any room. As a namespace,
// because escapeUnderworld re-exports most of it and a bare import would shadow.
import * as UW from './m59-underworld.mjs';
import { weighPack, isWeaponName, itemNameKey, foodValue } from './m59-items.mjs';
// A character's own buy/sell/keep list, when it has one. Imported for the two pure
// predicates only — this file does not go looking for the file, because the caller knows
// which character it is and this one does not.
import { keepTest as keepTestFor, sellTest as sellTestFor } from './m59-loadout.mjs';
import * as buyers from './m59-buyers.mjs';
import { readFileSync } from 'node:fs';
import { isTerminalMovementReason } from './m59-movement.mjs';

// The merchant index resolves a live object id to the class whose buying rule applies.
// Read once and kept: it is a built artefact that changes when somebody rebuilds it, and
// `sellAll` is on a town trip rather than a hot loop. A missing file is not an error —
// `classOf` falls back to the name, and an unresolved merchant means "offer everything",
// which is what this code did before the index existed.
let MERCHANT_INDEX;
function merchantIndex() {
  if (MERCHANT_INDEX !== undefined) return MERCHANT_INDEX;
  try {
    MERCHANT_INDEX = JSON.parse(readFileSync(
      new URL('../substrate/m59-merchants.json', import.meta.url), 'utf8'));
  } catch { MERCHANT_INDEX = null; }
  return MERCHANT_INDEX;
}

// Health fractions. Chosen from what the game does rather than taste: a monster that
// can take you from half to nothing in one exchange is common, and the server's
// one-action-per-second clock means fleeing takes several seconds during which you
// are still being hit.
export const DEFAULT_DISENGAGE_AT = 0.35;
export const DEFAULT_REST_UNTIL = 0.9;

// A FIGHT CAN MAKE REAL PROGRESS WITHOUT ENDING IN A KILL.
//
// Safe-wall fights are often interrupted when the quarry steps just outside melee
// reach. The keeper then pulls the same wounded object back and resumes it. Treating
// every such return as "no progress" makes five useful exchanges look like a stall and
// lets an external supervisor stop the keeper in the middle of a bounded pull cycle.
// The server's own combat text is the affirmative evidence. Generic attacks say
// "You hit ..." or "Your <weapon> hits ...", while Battler.GotHit uses the weapon's
// damage type and strength (for example, "Your short sword pokes the fungus beast.").
// These are all positive-damage branches; a zero-damage blow says "fails to damage".
// Keep the grammar anchored and the source-defined verbs explicit so misses, incoming
// attacks, and arbitrary prose cannot manufacture progress.
const PLAYER_DAMAGE_VERBS = [
  'runs through',
  'incinerates', 'electrocutes', 'brutalizes',
  'disfigures', 'dissolves', 'corrupts', 'purifies',
  'mortifies', 'cleanses', 'flattens', 'appalls',
  'pollutes', 'maligns', 'devours', 'thrashes',
  'mangles', 'pummels', 'cleaves', 'lacerates',
  'damages', 'wounds', 'nicks', 'slays',
  'burns', 'sears', 'scorches', 'chars', 'singes',
  'fries', 'shocks', 'jolts', 'freezes', 'frosts',
  'chills', 'cools', 'infuses', 'slams', 'buffets',
  'shakes', 'gnaws', 'bites', 'nips', 'shreds',
  'rends', 'rakes', 'claws', 'impales', 'pricks',
  'stings', 'irritates', 'slaps', 'maims', 'slashes',
  'cuts', 'smashes', 'crushes', 'bashes', 'stabs',
  'pokes', 'fells', 'pierces', 'grazes', 'hits',
];
const PLAYER_DAMAGE_VERB_PATTERN = PLAYER_DAMAGE_VERBS.join('|').replace(/ /g, '\\s+');
const regexpEscape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const combatNameKey = value => String(value ?? '').toLowerCase().trim()
  .replace(/^(?:the|an|a)\s+/, '').replace(/\s+/g, ' ');

export function landedHitSummary(messages = [], target = null) {
  let hits = 0, damage = 0, damageKnown = 0;
  // attackRounds may collect unrelated server messages during the same exchange.
  // Bind affirmative prose to the chosen foe rather than accepting any sentence
  // that happens to fit "Your <noun> <damage verb> <noun>." The source inserts
  // GetDef separately, so articles are allowed independently of the room name.
  const targetName = combatNameKey(target);
  if (!targetName) return { hits, damage: null, damage_known_hits: damageKnown };
  const targetPattern = `(?:the\\s+|an\\s+|a\\s+)?${regexpEscape(targetName).replace(/ /g, '\\s+')}`;
  const battlerDamageLine = new RegExp(
    `^\\s*Your\\s+.+?\\s+(?:${PLAYER_DAMAGE_VERB_PATTERN})\\s+${targetPattern}\\.\\s*$`, 'i');
  const genericDamageLine = new RegExp(
    `^\\s*You hit\\s+${targetPattern}(?:\\s+(?:with|for)\\b.*?)?\\.\\s*$`, 'i');
  for (const value of messages || []) {
    const line = String(value ?? '');
    if (!genericDamageLine.test(line) && !battlerDamageLine.test(line)) continue;
    hits++;
    const amount = /\bfor\s+(\d+)(?:\s+damage)?\b/i.exec(line);
    if (amount) { damage += Number(amount[1]); damageKnown++; }
  }
  return { hits, damage: damageKnown ? damage : null, damage_known_hits: damageKnown };
}

const pct = v => (v && v.max ? v.value / v.max : null);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// VIGOR IS NOT SHAPED LIKE HEALTH AND MANA, and reading it with `pct` above deadlocked
// the whole fleet.
//
// Health and mana report {value, max}. Vigor reports {value, scale_max, rest_threshold}
// and has no `max` at all, so `pct(vitals.vigor)` is null. In restUntil's `done()` that
// null became `?? 1` — "vigor is 100% satisfied, always" — so restUntil answered
// "already recovered" the instant health was high, whatever the vigor target.
//
// The keeper meanwhile reads vigor CORRECTLY (m59-autopilot.mjs:62 vigorPct) and sends
// anyone under restBelow here to rest. The two disagreed every pass: the keeper decided
// "too tired, sit down", restUntil returned "already recovered" without sitting, and the
// rest branch returned before reaching farming or errands. A character below the vigor
// threshold therefore did nothing at all, for ever, while reporting a healthy activity
// and a full health bar. That is what k0 kills across the fleet looked like from inside.
const vigorFrac = g => (!g || g.value == null) ? null : g.value / (g.scale_max ?? 200);
const vitalFrac = (v, which) => which === 'vigor' ? vigorFrac(v?.vigor) : pct(v?.[which]);

// ---------------------------------------------------------------- equipment

// Rough ordering of what is worth wielding. GetWeapon returns nothing for an empty
// hand and UserAttack then falls back to punch, so anything beats nothing.
const WEAPON_WORDS = [
  [/greatsword|two.?hand/i, 9], [/battle ?axe|halberd/i, 8], [/long ?sword/i, 7],
  [/broadsword|scimitar/i, 6], [/mace|morning ?star|war ?hammer/i, 5], [/axe/i, 5],
  [/short ?sword|falchion/i, 4], [/sword/i, 4], [/dagger|knife/i, 2],
  [/staff|club|cudgel/i, 2], [/bow|crossbow|sling/i, 3],
];
// A CURSED WEAPON CANNOT BE PUT DOWN, AND WIELDING ONE IS THE ONLY IRREVERSIBLE MISTAKE
// IN THIS FILE.
//
// `WeapAttCursed.ItemReqUnuse` (wacursed.kod:97) does not test anything — it returns FALSE
// unconditionally and says "%s%s seems to cling to your hand!". `ItemReqLeaveOwner` refuses
// the drop as well, for as long as the thing is in `getplayerusing`. So the moment a
// character wields one it is stuck with it: it cannot swap to a mace, cannot sell it,
// cannot hand it to a fleetmate, and cannot drop it. For the life of the character.
//
// AND IT IS A PENALTY WEAPON, NOT A PRIZE. Both `ModifyDamage` and `ModifyHitRoll` return
// `x - 2*power` — it is strictly worse than the bare hand it replaced, at hitting AND at
// hurting. A character that picks one up does not get a trade-off; it gets a downgrade it
// can never undo.
//
// This is not hypothetical. `AddToItemAttTreasureTable(#percent=10)` puts it at a tenth of
// the item-attribute treasure table, and this fleet loots weapons from every kill — Floyd
// was carrying fifteen swords it had picked up. Nothing else in the harness knows the
// attribute exists: the name is "cursed %s", so a cursed long sword matches /long ?sword/
// and scored SEVEN here, ahead of every mace in the pack.
//
// The guard is on WIELDING only, deliberately. One that is merely carried is harmless and
// still sellable — `ItemReqLeaveOwner` refuses only while it is in the use list — so this
// keeps it out of the candidate list and lets the ordinary sell rules shed it.
export const isCursed = (name) => /\bcursed\b/i.test(String(name || ''));

export const weaponScore = name => {
  if (isJunk(name)) return 0;
  for (const [re, n] of WEAPON_WORDS) if (re.test(name)) return n;
  // A REAL WEAPON MUST NEVER SCORE ZERO, because zero is what a helmet scores and it
  // means "punch things instead". The list above wanted "war hammer" and the server says
  // "hammer", so a hammer was indistinguishable from a hat: Clifford carried one all
  // session, fought with its fists, and equip_best reported nothing wieldable in the
  // pack while holding it. Falling through to the class tree costs one lookup and makes
  // the failure impossible rather than unlikely — the word list still does the ranking,
  // which is the part it is actually good at.
  if (isWeaponName(name)) return 1;
  return 0;
};

// JUNK THAT LOOKS LIKE GEAR. kod/object/item/passitem/junk.kod builds thirteen items
// whose whole design is to carry a real item's ICON and a worthless body, and one of
// them is called "broken mace". weaponScore matched it on /mace/ and gave it 5 — ahead
// of a real dagger at 2 — so a character holding both wielded the junk. Junk is a
// PassiveItem and not a Weapon, so the wield silently did nothing and the character
// punched things while this function reported it was holding a mace.
//
// Junk is not literally worthless (value 5-30, junk.kod:27-90) but it is 10-40 weight
// and 10-40 bulk for it, and the broken mace is the only one that corrupts a decision.
export const JUNK_NAMES = [
  'broken mace', 'undecipherable book', 'fake chalice', 'glass pendant',
  'surplus legion helmet', 'tanned kriipa leather', 'scrap metal',
  "bones of konima's original war party", 'ketchikan hoop', 'pamyan drapery',
  'toy ant mask', 'rusty armor', 'water finding arrow',
];
export const isJunk = (name) => JUNK_NAMES.includes(String(name || '').trim().toLowerCase());

// A BROKEN WEAPON IS NOT RENAMED. Only its icon group changes (weapon.kod:788-836,
// viBroken_group), so nothing about the name, and nothing this client can see in the
// inventory, distinguishes a working long sword from a shattered one. `piHits <= 0` is
// the whole of it and it is server-side.
//
// What IS visible is what the server says, and it says three different things:
export const WEAPON_SHATTERED = /shatters into pieces/i;          // it broke just now, mid-fight
export const WEAPON_IS_BROKEN = /is broken; you can'?t use it/i;  // weapon.kod:84
// THE ONE THE SERVER ACTUALLY SENDS WHEN YOU TRY TO WIELD ONE.
//
// There are two messages for this and only the first was known. weapon.kod:84 is
// "%s%s is broken; you can't use it!"; player.kod:127 is "You can't use %s%s--it's
// broken." — and the second is the one on the PLAYER's use path, which is the path a
// wield actually takes. Nothing matched it, so a refusal was never recorded as
// brokenness: the weapon stayed in the candidate list, equipBest offered it again next
// pass, and the character retried the same dead mace for ever while reporting itself
// unarmed. Zoot accumulated four of them and fought bare-handed with a full pack.
export const WEAPON_USE_BROKEN = /can'?t use .*--it'?s broken/i;  // player.kod:127
export const WEAPON_CONDITION = /shattered by a powerful blow/i;  // seen when examining it

// RUINED ARMOUR REFUSES IN COMPLETE SILENCE, AND ONLY THE DESCRIPTION SAYS SO.
//
// A broken weapon announces itself on the use path — player.kod:127, "You can't use
// X--it's broken." Armour does not. `use` on a ruined breastplate returns no message at
// all, the use list simply does not change, and wearBest could say no more than "the
// server never added it to the use list, and said nothing".
//
// So nothing condemned the piece. The character carried it, failed to wear it every
// pass, and — because an unworn item looks exactly like a spare — sold it on the next
// town trip. Beaker ran that loop with two leathers and finished unarmoured with 3,495
// in the bank. Reading the condition line is the only way to tell, and it is there:
//
//   armor.kod:24   " is useless.  It has been torn into several pieces…"
//   helmet.kod:24  " is useless, having been cleft in two by a forceful blow."
//
// against the sound reading, "without blemish or flaw". Confirmed live on Beaker: of two
// identical-looking leathers, the one described as useless was refused silently and the
// one without blemish went straight on.
export const ARMOUR_CONDITION = /is useless[.,]/i;                // armor.kod:24, helmet.kod:24
export const brokenGearText = (t) => ARMOUR_CONDITION.test(t || '');

export const brokenWeaponText = (t) => WEAPON_SHATTERED.test(t || '') || WEAPON_IS_BROKEN.test(t || '')
                                    || WEAPON_USE_BROKEN.test(t || '') || WEAPON_CONDITION.test(t || '')
                                    || ARMOUR_CONDITION.test(t || '');

// CONDITION LEVELS FROM LOOK_AT DESCRIPTIONS.
//
// The server appends one condition sentence to the item description when vbShow_condition
// is TRUE. Weapons and armour both have five levels (exc → good → med → poor → broken).
// "exc_mended" is treated the same as "exc" — a repaired piece is fully functional.
// These patterns are matched in priority order: broken first, then degrading, then good.
// An empty or null description returns null (never looked or item not found).
//
// Sources: weapon.kod:87-92, armor.kod:19-24, shield.kod:23-28, helmet.kod:19-24
//
// Level scale: 4=flawless, 3=good, 2=battle-worn, 1=poor (nearly broken), 0=broken
export function parseConditionLevel(desc) {
  if (!desc) return null;
  // Broken first — both weapon and armour
  if (/shattered by a powerful blow/i.test(desc)) return 0;
  if (/is useless[.,]/i.test(desc)) return 0;
  if (/shattered by a forceful blow/i.test(desc)) return 0;
  if (/cleft in two/i.test(desc)) return 0;
  // Poor / nearly broken
  if (/may not last much longer/i.test(desc)) return 1;
  if (/cracked in several places/i.test(desc)) return 1;
  if (/dented and worn nearly to the point/i.test(desc)) return 1;
  // Battle-worn but functional
  if (/notched and stained/i.test(desc)) return 2;
  if (/nicked and scarred/i.test(desc)) return 2;
  if (/deeply scarred from battle/i.test(desc)) return 2;
  if (/marked with the scars/i.test(desc)) return 2;
  // Good condition
  if (/slightly tarnished/i.test(desc)) return 3;
  if (/dent or two/i.test(desc)) return 3;
  if (/deep gouge/i.test(desc)) return 3;
  if (/stained with blood but otherwise/i.test(desc)) return 3;
  // Excellent / flawless (including mended)
  if (/flawless condition/i.test(desc)) return 4;
  if (/without blemish/i.test(desc)) return 4;
  if (/smooth perfection/i.test(desc)) return 4;
  if (/excellent condition/i.test(desc)) return 4;
  if (/great condition/i.test(desc)) return 4;
  return null; // description present but no condition phrase recognised
}

// Label for a condition level, for display.
export const CONDITION_LABEL = ['broken', 'poor', 'worn', 'good', 'flawless'];
export const CONDITION_CSS   = ['bad',    'bad',  'warn', '',     'good'];  // CSS class hints

// Learned, per client, because it cannot be read. A weapon enters this set the moment
// the server refuses it or announces it shattering, and leaves only when it leaves the
// pack. Without it every pass re-picks the same dead sword — it still scores highest.
// Null-safe for the same reason larderOf is: this is reached from the fleet row and from
// every equip path, and a character between sessions has no client at all. Four exported
// functions — armourOf, junkAndBroken, weaponRanking and this one — all failed on this
// single dereference.
export const brokenSet = (c) => c ? (c._brokenWeapons ??= new Set()) : new Set();

// A SWING THAT WAS REFUSED, AND THE ONE COMBAT FAILURE THE SERVER ACTUALLY ANNOUNCES.
//
// UserAttack (user.kod:4679) checks PFLAG_NO_FIGHT before it works out a stroke, and
// answers with this line instead of swinging. Resting sets that flag alongside
// PFLAG_NO_MOVE (player.kod:1162), so a character that sat down and never got back up
// swings at nothing for as long as anything keeps asking it to — and the combat lines
// read as a fight going badly rather than as a fight not happening.
//
// Worth knowing which way round the two refusals work: a MOVE from a resting player is
// bounced silently (user.kod:2988), an ATTACK is refused out loud. So movement has to be
// pre-empted by standing up first, and attacking can simply be believed.
export const CANNOT_SWING = /unable to lift your weapon/i;   // user.kod:119, user_no_fight
export const cannotSwingText = (t) => CANNOT_SWING.test(t || '');

// WHICH PROFICIENCY A WEAPON TRAINS. From viProficiency_Needed on each weapon class
// rather than from the skill names, because the two do not line up by spelling: every
// sword in the game routes to SKID_PROFICIENCY_SWORD (451) including the gold, mystic,
// nerudite and Riija swords, while the short sword has its own (457).
//
// THE NAMES ON THE RIGHT ARE THE SERVER'S, verbatim from each skill's own resource
// string, and seven of the eight used to be invented. "mace proficiency" is called
// "mace fighting"; the sword one is "fencing"; axe, scimitar and hammer are "wielding"
// rather than "proficiency"; the short sword is "short sword fighting". Only archery
// happened to be right.
//
// That mattered more than it looks, because the only consumer is a by-name lookup:
// every one of these returned a skill the character does not have, `abilityOf` gave
// null, and weaponRanking fell back to its crude name score. Both halves of the
// proficiency feature were broken at once and each hid the other — a wrong name looks
// exactly like a skill that has not been read.
export const WEAPON_PROFICIENCY = [
  [/short ?sword/i, 'short sword fighting'],         // profshsw.kod, SKID 457
  [/scimitar/i, 'scimitar wielding'],                // profscim.kod, SKID 453
  [/hammer/i, 'hammer wielding'],                    // profhamr.kod, SKID 454
  [/axe/i, 'axe wielding'],                          // profaxe.kod, SKID 455
  [/mace|morning ?star|club|cudgel/i, 'mace fighting'],        // profmace.kod, SKID 452
  [/bow|crossbow|sling|arrow/i, 'archery'],          // archery.kod, SKID 456
  [/sword|dagger|knife|falchion|blade/i, 'fencing'], // profswrd.kod, SKID 451
];

// The rest of the combat skills, by the server's names. Strokes are what you swing
// with and the defences are checked before their ability is even read — parry is zero
// without a weapon and block is zero without a shield (player.kod:4294).
export const STROKE_SKILLS = { slash: 'slash', thrust: 'thrust', fire: 'fire',
                               unarmed: 'Unarmed Combat' };
export const DEFENCE_SKILLS = { parry: 'parry', block: 'block', dodge: 'dodge' };
export const BRAWLING_SKILL = 'brawling';
export const proficiencyFor = (name) => {
  for (const [re, skill] of WEAPON_PROFICIENCY) if (re.test(name || '')) return skill;
  return null;
};

// The character's ability in a named skill. Returns null rather than 0 when it has
// simply not been read — "no skill" and "never asked" must not rank the same.
//
// THIS USED TO ALWAYS RETURN NULL, and nothing noticed because null is also the
// legitimate "not read yet" answer and weaponRanking falls back to the crude name
// score for it. Skill abilities are stat GROUP 4, and `statsById` indexes a stat by
// name only `if (s.name)` — but `name` comes from STAT_NAMES, which covers groups 1
// and 2 only. So a group-4 stat was filed under "4.7" and nothing else, and every
// by-name search of that map missed it. Proficiency-weighted weapon choice has
// therefore never actually run.
//
// The ability map is keyed by the skill's object id and carries its real name, which
// is what makes the by-name question answerable at all. The statsById scan stays as a
// fallback for clients that predate it.
export function abilityOf(c, skillName) {
  if (!skillName) return null;
  const fromMap = c?.abilityOf?.(skillName);
  if (Number.isFinite(fromMap)) return fromMap;
  const direct = c?.statsById?.get?.(skillName)?.value;
  if (Number.isFinite(direct)) return direct;
  for (const [k, v] of c?.statsById ?? []) {
    if (typeof k === 'string' && k.toLowerCase() === skillName.toLowerCase()
        && Number.isFinite(v?.value)) return v.value;
  }
  return null;
}

// WHAT TO WIELD, BEST FIRST.
//
// `priority` overrides the ordering with a list of name fragments — the point of it is
// training: a character with 90% sword and 11% axe will otherwise wield the sword for
// ever and never move the axe, because proficiency ranking is a feedback loop that
// rewards what you are already good at. Pass ['axe'] and it trains the axe.
export function weaponRanking(c, { priority = null } = {}) {
  const broken = brokenSet(c);
  const rows = (c.inventory || [])
    .map(o => ({ o, name: c.rsc.get(o.nameRsc) || '' }))
    // isCursed is checked here rather than in weaponScore, because scoring it zero would
    // also tell `sellable` and the equipment plan it is not a weapon — and selling it is
    // exactly what we want to happen to it. It must be unwieldable, not invisible.
    .filter(x => !isJunk(x.name) && !isCursed(x.name) &&
                 weaponScore(x.name) > 0 && !broken.has(x.o.id))
    .map(x => {
      const skill = proficiencyFor(x.name);
      return { ...x, skill, ability: abilityOf(c, skill), base: weaponScore(x.name) };
    });
  if (priority?.length) {
    const rank = (n) => {
      const i = priority.findIndex(p => n.toLowerCase().includes(String(p).toLowerCase()));
      return i === -1 ? priority.length : i;
    };
    return rows.sort((a, b) => rank(a.name) - rank(b.name) || b.base - a.base);
  }
  // Proficiency first — a weapon you are good with hits more often than a nominally
  // bigger one you are not. Unread abilities fall back to the crude name score rather
  // than sorting as zero, which would put the greatsword last on a fresh login.
  return rows.sort((a, b) => (b.ability ?? -1) - (a.ability ?? -1) || b.base - a.base);
}

// THE SERVER'S OWN LIST OF WHAT IS EQUIPPED, or null if this client does not keep one.
// Nothing below is allowed to infer the answer when this returns null — it says so
// instead. See M59Client.equipment().
export const equippedNow = (c) => (c?.using instanceof Set ? c.using : null);

// IS THERE A WEAPON IN OUR HAND — asked of the server, never of our own intentions.
//
// plUsing is the only authority (see M59Client.equipment()): "the last use we sent was
// not refused" has been wrong every time it mattered, because a weapon that shatters
// mid-fight leaves the use list without anything being sent at all. A character that
// cannot answer is treated as ARMED, because refusing to fight on a failed read would
// idle the whole fleet the first time an inventory request timed out — the guard is
// meant to catch the empty hand, not to become a new way to stop. Autopilot.armedForSure()
// is the same question failing the other way, for deciding whether to leave an inn.
//
// THIS TAKES A CLIENT, NOT A KEEPER, and that is the whole reason it lives here. It was
// Autopilot.armed(), so anything that wanted the answer had to hold a keeper to ask —
// and the code that tried to ask the client instead got it wrong in a way nothing
// caught: `m59-bt-nodes.mjs` guards its wielding_weapon condition on `client.armed()`,
// and `m59-autopilot.mjs`'s useBT branch on `typeof c.armed === 'function'`. A client
// has never had an armed(). So that condition answers false for every character and
// that branch has never executed at all. A predicate over the equipment list belongs
// with the equipment list, where there is one of it.
//
// Behaviour is byte-for-byte what Autopilot.armed() did — this is a move, not a fix.
export const isArmed = (c) => {
  const eq = c?.equipment?.();
  if (!eq || eq.known === false) return true;
  return (eq.equipped || []).some(o =>
    weaponScore(o.name ?? c.rsc?.get?.(o.nameRsc) ?? '') > 0);
};

// The refusal you get for wielding something you are already wielding. Re-`use` is not
// a toggle and not a no-op: TryUseItem runs CheckPosition, which counts the item
// against its own slot (player.kod:3235), finds no room, and answers this
// (player.kod:131). The old code sent it every single fight and read the refusal as
// success, because the only text it checked for was the broken-weapon one.
export const HANDS_FULL = /hands are too full/i;
export const handsFullText = (t) => HANDS_FULL.test(t || '');

export async function equipBest(s, { priority = null, maxTries = 4, refresh = true,
                                     beforeMutation = null, shouldCancel = null } = {}) {
  const c = s.need();
  if (refresh) {
    await s.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
  }
  const broken = brokenSet(c);
  const ranked = weaponRanking(c, { priority });
  if (!ranked.length)
    return { wielding: null, verified: false,
             ...(broken.size ? { known_broken: broken.size } : {}),
             note: 'nothing wieldable in the pack — you will fight with your fists, which ' +
                   'works but badly. Junk and weapons known to be broken are excluded.' };

  // ALREADY HOLDING THE RIGHT THING. `fight` calls this before every engagement, so
  // without the check the common case is a request spent on being told no — out of a
  // budget of five a second, in the second before a fight starts.
  const held = equippedNow(c);
  if (held?.has(ranked[0].o.id))
    return { wielding: ranked[0].name, id: ranked[0].o.id, verified: true,
             already_wielded: true, skill: ranked[0].skill, ability: ranked[0].ability,
             by: 'it was already in the server\'s use list — no request sent',
             considered: ranked.map(x => x.name) };

  // TRY, THEN CHECK. The previous version sent `use` and reported the name it had picked
  // without ever reading the reply, so a shattered weapon was reported as wielded for as
  // long as the character carried it. That is the whole of the "it never re-equips" bug:
  // nothing was wrong with the choosing, and nothing ever noticed the refusal.
  //
  // "Checked" now means the server put the id in plUsing and said so on BP_USE — not
  // merely that it did not complain. Those came apart in both directions: a refusal
  // with no text at all still read as success, and a hands-full refusal read as success
  // too because it is not the broken message.
  const rejected = [];
  for (const cand of ranked.slice(0, maxTries)) {
    if (typeof shouldCancel === 'function' && shouldCancel())
      return { wielding: null, cancelled: true, rejected,
               considered: ranked.map(x => x.name) };
    const before = c.evSeq;
    await s.pacer.submit('use', () => {
      if (typeof beforeMutation === 'function')
        beforeMutation('use', { item_id: cand.o.id, expected_name: cand.name, role: 'weapon' });
      return c.use(cand.o.id);
    });
    // Wait for whichever comes first: the use-list moving, or the server saying why not.
    const ev = await c.waitFor({ since: before, kinds: ['equipment', 'message'], timeoutMs: 3000 });
    const texts = ev.events.filter(e => e.text).map(e => e.text);
    if (texts.some(brokenWeaponText)) {
      broken.add(cand.o.id);
      rejected.push({ name: cand.name, id: cand.o.id, why: 'the server says it is broken' });
      continue;
    }
    const now = equippedNow(c);
    if (now && !now.has(cand.o.id)) {
      // A COMBAT MESSAGE IS NOT A REFUSAL.
      //
      // This took texts[0] — the first thing the server said in the wait window — as the
      // reason the wield failed. In a fight that window is full of other people's news:
      // Zoot's failed wield was reported as "The fungus beast nicks you with its attack",
      // which sent me looking for a wielding rule that does not exist. The wait is three
      // seconds long and a fight generates a line a second.
      //
      // So say only what can be attributed. A refusal is a message ABOUT the attempt —
      // hands full, broken, cannot use — and anything else is noise that happened to
      // arrive at the same time. Noise is still worth keeping, under a name that does not
      // claim it is the reason.
      const refusal = texts.find(t => handsFullText(t) || /can'?t use|cannot use|not able to use|too heavy|do not have/i.test(t));
      rejected.push({ name: cand.name, id: cand.o.id,
                      why: handsFullText(refusal || '')
                        ? 'refused: hands too full — something else is in the way, and it was ' +
                          'not this weapon (we checked the use list first)'
                        : refusal
                        || 'the server never added it to the use list and said nothing about why',
                      ...(texts.length && !refusal
                            ? { heard_meanwhile: texts.slice(0, 3),
                                note: 'those are what the server happened to say in the wait, not ' +
                                      'the reason — nothing it said was about this attempt' }
                            : {}) });
      continue;
    }
    return {
      wielding: cand.name, id: cand.o.id,
      verified: !!now,
      skill: cand.skill, ability: cand.ability,
      ...(priority ? { by: 'the priority list given' } : { by: 'proficiency, then weapon class' }),
      ...(now ? { confirmed_by: 'the server\'s use list (BP_USE)',
                  equipped: [...now] }
              : { note: 'NOT verified — this client keeps no use list, so all that is known ' +
                        'is that the server did not refuse out loud.' }),
      ...(rejected.length ? { rejected } : {}),
      considered: ranked.map(x => x.name),
      messages: texts,
    };
  }
  return { wielding: null, verified: false, rejected,
           considered: ranked.map(x => x.name),
           note: `every candidate was refused (${rejected.length}) — see \`rejected\` for which ` +
                 'were broken and which were blocked. Fighting bare-handed; the broken ones ' +
                 'should be dropped, see junkAndBroken().' };
}

// WHAT YOU ARE WEARING, WHICH NOTHING IN THIS FILE USED TO ASK ABOUT.
//
// equipBest ranks WEAPONS and nothing else, so a character could be carrying leather
// armour and a shield it had paid for and fight in its shirt for ever — the pack said
// it owned armour, the use list said it was wearing none, and only the second is what
// the server fights with.
//
// Armour, shields and helms are separate USE SLOTS from the weapon (viUse_type 16, 8
// and 4 against the weapon's own), so wearing them costs nothing a weapon needs, and
// wearing one does not refuse the others. What it does refuse is re-wearing something
// already worn: TryUseItem runs CheckPosition, counts the item against its own slot,
// finds no room, and answers "hands are too full" (player.kod:131) — the identical
// refusal a weapon gets, and the reason this checks the use list before sending.
//
// DEFENCE, NOT ARMOUR CLASS. Every one of these carries two numbers and they pull in
// opposite directions:
//
//   viDefense_base  changes how often you are hit at all — it feeds GetDefenseAbility
//   viDamage_base   absorbs a flat amount from each hit that lands
//
//   LeatherArmor  def  +50   absorb 0   spell   0
//   Robe          def  +20   absorb 0   spell +10
//   ChainArmor    def  -50   absorb 2   spell -15
//   ScaleArmor    def -100   absorb 4   spell -20
//   NeruditeArmor def -150   absorb 5   spell -20
//   PlateArmor    def -200   absorb 6   spell -30
//
// So the heavy armour in this game is not simply better, and for these characters it
// is worse. Plate absorbs six of a fungus beast's three-to-five damage — nearly all of
// it — but -200 defence on a scale where a monster's whole attack rating is 210 means
// being hit far more often, and -30 spell modifier costs the create food and create
// weapon this fleet lives on. Above all, the survival model here is a safe spot, where
// the goal is to be hit ZERO times; absorption is worth nothing against zero hits and
// defence is worth everything.
//
// Hence leather. The ranking below is robust to what absorption is worth — leather
// wins for any weighting under about 25 per point, and the real answer is well under
// that — but the weight is named rather than hidden so it can be argued with.
const ABSORB_IS_WORTH = 10;

// MATCH WHAT THE SERVER SAYS, NOT WHAT THE CLASS IS CALLED.
//
// This table was written from the kod FILE names, so five of its sixteen patterns
// matched nothing that ever arrives on the wire. The class is GuildShield and the
// server says "herald shield"; MetalShield says "small round shield"; GoldShield says
// "gold round shield"; Robe says "robes", which `\brobe\b` cannot match because the
// boundary fails on the s. Kermit and Janice each carried a small round shield for a
// whole session while wear_best answered "nothing of this kind in the pack".
//
// Worse, the two helmets had their numbers swapped. simphelm.kod is displayed as "helm"
// and is defence 20; helm.kod is displayed as "magic spirit helmet" and is defence 25.
// The old `\bhelm\b` scored 25 for the weaker of the two, and nothing matched the
// stronger one at all.
//
// Every name below is the vrName string read out of the cited file rather than inferred
// from the class, which is the same mistake WEAPON_PROFICIENCY was built on and the same
// one that made a hammer score zero.
export const ARMOUR = [
  { re: /leather armor|leather armour/i, slot: 'armour', defense: 50,   absorb: 0, spell: 0 },   // armor/leather.kod
  { re: /\brobes?\b/i,                   slot: 'armour', defense: 20,   absorb: 0, spell: 10 },  // armor/robe.kod:22 "robes"
  { re: /chain (armor|armour|mail)/i,    slot: 'armour', defense: -50,  absorb: 2, spell: -15 }, // armor/chain.kod
  { re: /scale (armor|armour)/i,         slot: 'armour', defense: -100, absorb: 4, spell: -20 }, // armor/scale.kod
  { re: /nerudite (armor|armour)/i,      slot: 'armour', defense: -150, absorb: 5, spell: -20 }, // armor/neruarmr.kod
  { re: /plate (armor|armour)/i,         slot: 'armour', defense: -200, absorb: 6, spell: -30 }, // armor/plate.kod
  { re: /herald shield/i,                slot: 'shield', defense: 20,   absorb: 2, spell: 0 },   // shield/guilshld.kod:21,115
  { re: /orc shield/i,                   slot: 'shield', defense: 20,   absorb: 2, spell: 0 },   // shield/orcshld.kod
  { re: /soldier'?s? shield/i,           slot: 'shield', defense: 20,   absorb: 2, spell: 0 },   // shield/soldshld.kod
  { re: /knight'?s? shield/i,            slot: 'shield', defense: 15,   absorb: 2, spell: 0 },   // shield/knhtshld.kod
  { re: /gold round shield/i,            slot: 'shield', defense: 10,   absorb: 1, spell: 0 },   // shield/goldshld.kod:19
  { re: /small round shield/i,           slot: 'shield', defense: 5,    absorb: 1, spell: 0 },   // shield/metlshld.kod:19,47
  { re: /magic spirit helmet/i,          slot: 'helm',   defense: 25,   absorb: 1, spell: -5 },  // helmet/helm.kod:19,49
  { re: /\bhelm\b/i,                     slot: 'helm',   defense: 20,   absorb: 1, spell: -5 },  // helmet/simphelm.kod:19,45
  { re: /ivy circlet/i,                  slot: 'helm',   defense: 10,   absorb: 0, spell: 0 },   // helmet/ivycircl.kod
  { re: /circlet/i,                      slot: 'helm',   defense: 5,    absorb: 0, spell: 0 },   // helmet/circlet.kod
];

export const ARMOUR_SLOTS = ['armour', 'shield', 'helm'];

// AN EMPTY SLOT IS NOT A NEUTRAL BASELINE, AND `score` ASKS THE WRONG QUESTION ABOUT ONE.
//
// armourScore is `defence + absorb * ABSORB_IS_WORTH` — a comparison against bare skin
// that prices one point of absorption at ten of defence. That is a fair ranking BETWEEN
// two pieces and the wrong test for whether to wear anything at all, because the two
// numbers do not degrade alike. Defence only sets the chance to be hit, and that chance
// is `offense * 55 / defence` BOUNDED TO [10,95] (battler.kod:331). Against anything
// hitting hard enough to pin us at 95%, more defence buys literally nothing, while
// absorption keeps working on every blow that lands.
//
// Worked against this fleet rather than argued: agility 45, base max health 50, block 90,
// no dodge or parry, so `iDefense = block + agility*4 + maxhp*3/2` = 345 (player.kod:4320).
// Against a fungus beast — offense 210, damage ~4 — the expected damage per enemy swing:
//
//     bare     33.5% x 4.0 = 1.34          chain    39.2% x 3.0 = 1.18
//     leather  29.2% x 4.0 = 1.17          scale    47.1% x 1.5 = 0.71
//
// Every one of them beats bare. And that is with absorption valued HONESTLY: it is
// `random(reduce/3, reduce)` bounded to `damage-1` (defmod.kod:108), so it is worth less
// than its face value and can never take a hit to zero. Bare skin has no defence bonus
// and no absorption; there is nothing in the table it is better than.
//
// So the floor is: WITH THE SLOT EMPTY, wear the best thing in the pack as long as it
// absorbs something. The ranking is untouched — leather still beats chain, and a
// positively-scoring piece still wins outright. This only decides what happens when the
// alternative is skin.
//
// DELIBERATELY NOT A RE-WEIGHTING OF ABSORB_IS_WORTH. Raising it past 25 flips
// leather-versus-scale for the whole fleet as a side effect, and the numbers above make
// that a genuinely open question rather than a settled one — it turns on block ability,
// on whether a shield is held, and on the spell modifier (-20 on scale) that this fleet's
// create food and create weapon run on. That one wants a measurement, not a constant.
//
// The condition is `absorb > 0` rather than a name list because it is the property that
// makes the trade real. Nothing currently in ARMOUR has negative defence and no
// absorption — the shape that WOULD be worse than bare — and this keeps the floor honest
// if something like it is ever added.
export const absorbsSomething = (kind) => (kind?.absorb ?? 0) > 0;

// What a name is, or null. Longest-pattern-first matters: "simple helm" must not be
// read as the plain "helm", which is a different and better item.
export function armourKind(name) {
  const n = String(name || '');
  let best = null;
  for (const a of ARMOUR) {
    if (!a.re.test(n)) continue;
    if (!best || a.re.source.length > best.re.source.length) best = a;
  }
  return best;
}

export const armourScore = (a) => a ? a.defense + a.absorb * ABSORB_IS_WORTH : -Infinity;

// Everything wearable in the pack, best first, grouped by slot. Broken items are
// excluded for the same reason weapons are: the server does not rename them, so the
// only record that a thing has been refused is the one we keep.
export function armourOf(c) {
  const broken = brokenSet(c);
  const out = { armour: [], shield: [], helm: [] };
  for (const o of c.inventory || []) {
    if (broken.has(o.id)) continue;
    const name = c.rsc.get(o.nameRsc) || '';
    const kind = armourKind(name);
    if (!kind) continue;
    out[kind.slot].push({ o, name, kind, score: armourScore(kind) });
  }
  for (const k of ARMOUR_SLOTS) out[k].sort((a, b) => b.score - a.score);
  return out;
}

// PUT THE BEST OF EACH ON, and confirm with the server rather than with hope.
//
// Same shape as equipBest and for the same reason: sending `use` and reporting what we
// meant to wear is how a fleet ends up believing it is armoured. `equipped` here means
// the id is in plUsing and the server said so, nothing weaker.
export async function wearBest(s, { slots = ARMOUR_SLOTS, refresh = true,
                                    beforeMutation = null, shouldCancel = null } = {}) {
  const c = s.need();
  if (refresh) {
    await s.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
  }
  const have = armourOf(c);
  const broken = brokenSet(c);
  const worn = [], skipped = [], rejected = [];

  // BARE IS AN OPTION, AND IT SCORES ZERO.
  //
  // This wore the best thing in each slot without ever asking whether it beat wearing
  // nothing, and for body armour that is a real question: scale is -100 defence for 4
  // absorb, which on this weighting is -60, and plate is -140. Kermit was walking around
  // at defense_total -95 — a hundred points easier to hit than bare skin — because
  // scale armor was the best armour it owned and "best" was the only test.
  //
  // On a scale where a monster's whole attack rating is about 210 (3*level + 60*difficulty)
  // a hundred points of defence is enormous, and absorption cannot pay for it: it takes
  // a few points off each blow that lands, while defence decides how many land at all.
  //
  // Something already worn gets the same test, because armour is picked up mid-session
  // and a character that put plate on before this rule existed is still wearing it.
  const stripped = [];
  const wornInSlot = (slot) => {
    const using = equippedNow(c);
    if (!using) return null;
    for (const o of c.inventory || []) {
      if (!using.has(o.id)) continue;
      const name = c.rsc.get(o.nameRsc) || '';
      const kind = armourKind(name);
      if (kind?.slot === slot) return { o, name, kind, score: armourScore(kind) };
    }
    return null;
  };

  for (const slot of slots) {
    if (typeof shouldCancel === 'function' && shouldCancel())
      return { worn, stripped, skipped, rejected, cancelled: true,
               confirmed_by: equippedNow(c) ? 'the server\'s use list (BP_USE)' : null };
    const best = have[slot]?.[0];
    const onNow = wornInSlot(slot);

    // Wearing something that is worse than nothing: take it off. But STRIPPING DOWN TO
    // BARE IS NOT AN IMPROVEMENT — see absorbsSomething. A negative piece comes off only
    // when something better is going on in its place, or when it is the one shape that
    // really is worse than skin: negative defence buying no absorption at all.
    const swapAvailable = !!(best && best.score > onNow?.score && best.score > 0);
    if (onNow && onNow.score < 0 && !swapAvailable && !absorbsSomething(onNow.kind)) {
      await s.pacer.submit('use', () => {
        if (typeof beforeMutation === 'function')
          beforeMutation('unuse', { item_id: onNow.o.id, expected_name: onNow.name,
                                     role: 'armor' });
        return c.unuse(onNow.o.id);
      });
      await c.waitFor({ kinds: ['equipment'], timeoutMs: 3000 }).catch(() => {});
      const after = equippedNow(c);
      stripped.push({ slot, name: onNow.name, defense: onNow.kind.defense,
                      absorb: onNow.kind.absorb, score: onNow.score,
                      off: after ? !after.has(onNow.o.id) : null,
                      why: `scores ${onNow.score} against 0 for bare skin — ${onNow.kind.defense} ` +
                           'defence is not bought back by absorption' });
      continue;
    }

    if (!best) { skipped.push({ slot, why: 'nothing of this kind in the pack' }); continue; }
    // THE FLOOR. A piece that loses to bare skin on score is still worn when the slot is
    // EMPTY and it absorbs something, because the thing it is being compared against
    // absorbs nothing and dodges nothing. Fourteen of twenty-one characters were walking
    // around with no body armour at all while carrying chain or scale they had been told
    // to leave off.
    const floored = best.score <= 0 && !onNow && absorbsSomething(best.kind);
    if (best.score <= 0 && !floored) {
      skipped.push({ slot, name: best.name, score: best.score,
                     why: onNow
                       ? 'the best in the pack is no better than what is already on'
                       : 'the best in the pack is no better than bare skin, and absorbs ' +
                         'nothing to trade for it, so it stays off' });
      continue;
    }
    // Already wearing it: the use list is the authority, and re-using is refused
    // rather than ignored, so this check saves a request AND a false failure.
    const using = equippedNow(c);
    if (using?.has(best.o.id)) {
      worn.push({ slot, name: best.name, already: true, defense: best.kind.defense });
      continue;
    }
    // A use slot is not a stack. The server refuses an upgrade while the old piece is
    // still in that slot (usually as "Your hands are full" for shields), so asking it
    // to wear the better item first can never work. This was especially visible with
    // knight's shields: characters carried one forever while continuing to wear the
    // small round shield named in their original loadout.
    //
    // Take the incumbent off only for a real upgrade, confirm that it came off, and put
    // it back if the replacement is refused. A failed upgrade must not leave a fighter
    // less protected than it was before the pass.
    let displaced = null;
    if (onNow && onNow.o.id !== best.o.id && best.score > onNow.score) {
      const beforeOff = c.evSeq;
      await s.pacer.submit('use', () => {
        if (typeof beforeMutation === 'function')
          beforeMutation('unuse', { item_id: onNow.o.id, expected_name: onNow.name,
                                    role: 'armor-upgrade' });
        return c.unuse(onNow.o.id);
      });
      await c.waitFor({ since: beforeOff, kinds: ['equipment', 'message'], timeoutMs: 3000 })
        .catch(() => ({ events: [] }));
      const afterOff = equippedNow(c);
      if (afterOff?.has(onNow.o.id)) {
        rejected.push({ slot, name: best.name, id: best.o.id,
                        why: `could not take off ${onNow.name}, so the upgrade was not attempted` });
        continue;
      }
      displaced = onNow;
    }
    const before = c.evSeq;
    await s.pacer.submit('use', () => {
      if (typeof beforeMutation === 'function')
        beforeMutation('use', { item_id: best.o.id, expected_name: best.name, role: 'armor' });
      return c.use(best.o.id);
    });
    const ev = await c.waitFor({ since: before, kinds: ['equipment', 'message'], timeoutMs: 3000 })
                      .catch(() => ({ events: [] }));
    const texts = (ev.events || []).filter(e => e.text).map(e => e.text);
    const now = equippedNow(c);
    if (now && !now.has(best.o.id)) {
      // ARMOUR BREAKS TOO, AND NOTHING WAS WRITING IT DOWN.
      //
      // equipBest condemns a weapon the moment the server refuses it as broken, which is
      // what puts it on junkAndBroken's list and gets it dropped. wearBest read the same
      // refusal — "You can't use the gold round shield--it's broken." — and only noted it
      // in `rejected`, which nothing acts on. So a broken breastplate sat in the pack for
      // ever: not renamed (the same trap as the weapons), refused every pass, occupying a
      // slot, and reported by every audit as a character with no armour rather than a
      // character carrying armour it cannot wear. Beaker had a dead leather AND a dead
      // gold shield and read as unarmoured for three passes.
      if (texts.some(brokenWeaponText)) broken.add(best.o.id);
      rejected.push({ slot, name: best.name, id: best.o.id,
                      ...(texts.some(brokenWeaponText) ? { broken: true } : {}),
                      why: texts.find(handsFullText)
                        ? 'refused: that slot is already full, and not by this item — we checked'
                        : texts[0] || 'the server never added it to the use list, and said nothing' });
      if (displaced) {
        await s.pacer.submit('use', () => {
          if (typeof beforeMutation === 'function')
            beforeMutation('use', { item_id: displaced.o.id, expected_name: displaced.name,
                                    role: 'armor-rollback' });
          return c.use(displaced.o.id);
        });
        await c.waitFor({ kinds: ['equipment', 'message'], timeoutMs: 3000 }).catch(() => {});
        rejected.at(-1).restored = !!equippedNow(c)?.has(displaced.o.id);
      }
      continue;
    }
    worn.push({ slot, name: best.name, defense: best.kind.defense, absorb: best.kind.absorb,
                ...(displaced ? { replaced: displaced.name } : {}), verified: !!now,
                // Said out loud, because "wearing scale" and "wearing scale ON PURPOSE,
                // having nothing better" are different states and one of them is a
                // shopping list. A silent floor reads as an endorsement.
                ...(floored ? { floor: true, score: best.score,
                                why: `scores ${best.score} against bare skin but absorbs ` +
                                     `${best.kind.absorb} and the slot was empty` } : {}) });
  }

  const total = worn.reduce((t, w) => t + (w.defense ?? 0), 0);
  return {
    worn, ...(stripped.length ? { stripped } : {}),
    ...(skipped.length ? { skipped } : {}), ...(rejected.length ? { rejected } : {}),
    defense_total: total,
    confirmed_by: equippedNow(c) ? 'the server\'s use list (BP_USE)' : null,
    ...(equippedNow(c) ? {} : {
      note: 'NOT verified — this client keeps no use list, so all that is known is that ' +
            'the server did not refuse out loud.' }),
  };
}

// What is in the pack that should not be: junk, and weapons the server has refused.
// Returned rather than dropped, because dropping is the caller's decision to make.
//
// Anything currently equipped is excluded whatever its name. A junk NAME on a worn item
// is not a reason to strip the character — and "broken mace" is a real junk item, so
// the name test alone would happily list the mace somebody is holding.
// IS THIS WEAPON ALREADY DEAD — ASKED BEFORE PICKING IT UP, NOT AFTER CARRYING IT HOME.
//
// Brokenness is `piHits <= 0` and lives on the server; the name never changes
// (weapon.kod:788 moves only the icon group). So there were exactly two ways to learn
// it, and until now the code only used the worse one: TRY TO WIELD IT, which teaches
// brokenSet one weapon per attempt, after the thing has already been carried across the
// world and taken a pack slot. Floyd was hauling six dead maces on that basis and Kermit
// eight, and handing two of them to an unarmed character taught us nothing we could not
// have known on the floor where they dropped.
//
// The other way is to LOOK at it. Examining says so in prose — "This mace has been
// shattered by a powerful blow", WEAPON_CONDITION — and that question can be asked about
// an object lying on the ground, before it costs anything.
//
// THE FIRST LOOK AFTER ANOTHER LOOK COMES BACK EMPTY. Measured against the live server,
// repeatedly and in both directions: examine two items back to back and the first
// returns null while a retry returns the real description. So each candidate gets a retry,
// and a null after that is UNKNOWN — never "sound" and never "broken". Guessing either
// way is worse than admitting it: guess broken and we throw away working weapons, guess
// sound and we are exactly where we started.
export async function inspectForBroken(s, ids, { retries = 1, timeoutMs = 3000 } = {}) {
  const c = s.need();
  const broken = brokenSet(c);
  const out = { broken: [], sound: [], unknown: [] };
  for (const id of ids) {
    // Already condemned — do not spend a round trip re-confirming it.
    if (broken.has(id)) { out.broken.push(id); continue; }
    let desc = null;
    for (let i = 0; i <= retries && desc == null; i++) {
      await s.pacer.submit('look', () => c.look(id));
      const { events } = await c.waitFor({ kinds: ['look'], timeoutMs });
      desc = events.find(e => e.id === id)?.description ?? null;
    }
    if (desc == null) { out.unknown.push(id); continue; }
    // Both phrasings: weapons say "shattered by a powerful blow", armour and helms say
    // "is useless" (armor.kod:24, helmet.kod:24). Checking only the first meant every
    // ruined breastplate on a corpse field was picked up and carried.
    if (WEAPON_CONDITION.test(desc) || ARMOUR_CONDITION.test(desc)) { broken.add(id); out.broken.push(id); }
    else out.sound.push(id);
  }
  return out;
}

// A SITTING CHARACTER'S CAST IS SWALLOWED WHOLE — no mana, no message, no effect.
//
// This cost most of an afternoon. Scooter cast create weapon forty times from an inn and
// produced nothing; the same call, after standing up, took mana 19 -> 4 on the first
// try. Resting sets PFLAG_NO_CAST alongside PFLAG_NO_MOVE (player.kod:1162) exactly as
// it sets PFLAG_NO_FIGHT — and the refusal is silent, so `cast` returned success every
// time and the keeper had no way to tell a swallowed cast from an unlucky one.
//
// Read the MANA, not the reply, to tell those apart: a cast that never happened costs
// nothing, a failed roll costs half (spell.kod:1163), and a successful one costs the
// full price. That is the only honest signal available here.
// Unconditional, because nothing on the wire says whether we are sitting — BP has no
// posture field — and standing while already standing costs one packet and does nothing.
// Guessing wrong in the other direction costs 15 mana and an afternoon.
export async function standToAct(s, { beforePacket = null } = {}) {
  const c = s.need();
  await s.pacer.submit('stand', () => {
    if (typeof beforePacket === 'function') beforePacket('stand');
    return c.stand();
  });
  await new Promise(r => setTimeout(r, 400));
  return { stood: true };
}

// HOW MUCH THIS CHARACTER CAN CARRY — and the honest edge of what we can know.
//
// The server refuses a pickup, and DELETES a spell-created weapon rather than handing
// it over, when `piWeight_hold + weight > GetWeightMax` or the same for bulk
// (holder.kod:259 ReqNewHold -> :281 CanHoldWeightAndBulk). Both ceilings are one
// formula, and it is computable from an attribute we already read:
//
//     GetWeightMax = GetBulkMax = 1700 + might * 20     player.kod:10456, :10461
//
// THE CURRENT LOAD IS NOT ON THE WIRE, so it is added up here. piWeight_hold lives on
// the server and is never sent, and no packet carries an item's weight or bulk either —
// but those weights are not secret, they are just static. m59-items.mjs lifts every item
// class's viWeight/viBulk out of the kod once, and weighPack adds up an inventory.
//
// `exact` is the field that decides whether the total means anything. A load of 900 with
// three unrecognised items in the pack is not a load of 900, it is a LOWER BOUND — so
// `room_for` is reported as null rather than as a number whenever anything was unknown.
// Underestimating the load is the direction that fails: it says there is room when there
// is not, which burns 15 mana on a create weapon the server then deletes.
export function carryCapacity(c) {
  const might = c?.stat?.('might') ?? null;
  const inv = c?.inventory || [];
  const items = inv.length;
  if (might == null)
    return { known: false, items, why: 'might has not been read yet — call stats first' };
  const max = 1700 + might * 20;
  // Names, because that is all the protocol gives us — an inventory entry carries no class.
  const named = inv.map(o => ({ name: c.rsc?.get?.(o.nameRsc) ?? o.name, amount: o.amount }));
  const load = weighPack(named);
  const spare = { weight: max - load.weight, bulk: max - load.bulk };
  return {
    known: true, might, weight_max: max, bulk_max: max, items,
    load: { weight: load.weight, bulk: load.bulk, exact: load.exact,
            ...(load.unknown.length ? { unweighed: load.unknown } : {}) },
    // How much more can go in, and null when we cannot honestly say.
    room_for: load.exact ? { weight: spare.weight, bulk: spare.bulk } : null,
    formula: '1700 + might * 20, weight and bulk alike (player.kod:10456, :10461)',
    ...(load.exact ? {} : {
      note: 'some items are not in the weight table, so the load is a LOWER BOUND and ' +
            'room_for is withheld. Treat that as "make room", never as "there is room". ' +
            'Rebuild the table with: node tools/m59-items.mjs build' }),
  };
}

// Would this fit? Only ever answered with certainty; `null` means we do not know, and a
// caller must treat that exactly as it treats false.
export function wouldFit(c, weight, bulk = weight) {
  const cap = carryCapacity(c);
  if (!cap.known || !cap.room_for) return null;
  return cap.room_for.weight >= weight && cap.room_for.bulk >= bulk;
}

// MAKE ROOM BEFORE ASKING FOR SOMETHING, because asking and being refused is expensive.
//
// create weapon costs its full 15 mana whether or not the weapon survives: the spell
// rolls, succeeds, builds the weapon, and only then asks ReqNewHold — and if that says
// no the weapon is Deleted and the caster is out the mana with nothing to show
// (creaweap.kod:116-129). Since the load cannot be read, the only reliable move is to
// shed what we already know is worthless first.
//
// Returns what it dropped. Dropping nothing is a perfectly good outcome — it means
// there was nothing dead to shed, not that there is room.
export async function freeRoomFor(s, { max = 4 } = {}) {
  const c = s.need();
  const dead = junkAndBroken(c).slice(0, max);
  const dropped = [];
  for (const d of dead) {
    // Same spec shape the keeper's pack-clearer uses: a bare id, or {id, amount} for a
    // stack. Passing {id} for a single item is refused as a partial-stack drop.
    await s.pacer.submit('drop', () => c.drop([dropSpec(d)]));
    dropped.push(d);
  }
  if (dropped.length) {
    await s.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
  }
  return { dropped, note: dropped.length ? undefined : 'nothing known-dead to shed' };
}

// GIVE THE STREET EVERYTHING THAT IS NOT NAILED DOWN.
//
// `freeRoomFor` above sheds what is known-dead to make room for one spell. This is the
// other shape: a character on a route that passes no merchant is hauling loot it will
// never sell, and the pack space is worth more than the loot. Operator's call, 2026-09-05:
// drop it in the Streets of Tos on the way to the Duke's tables, and yell about it, because
// on a shared server a pile of free equipment in the street is a gift rather than litter.
//
// THREE THINGS ARE NEVER DROPPED, AND ONLY ONE OF THEM IS A LIST.
//
//   * WHAT IS WORN. What you CARRY and what you are WEARING are two different lists and
//     `using` is the only answer — and when it is null it means UNKNOWN, not "nothing is
//     equipped". Dropping on an unknown equipment set is how a character puts its own
//     armour in the road, so unknown REFUSES the whole operation rather than proceeding
//     carefully. There is no safe partial answer to this question.
//   * MONEY. A purse in the street is gone, there is no undo, and no caller ever means it.
//     This is a floor under the keep list rather than an entry in it, because a caller that
//     forgets is the case it exists for.
//   * WHATEVER THE CALLER NAMED. Matched as case-insensitive substrings, the same way every
//     other keep list in this repository matches.
//
// AND IT IS JUDGED BY WHAT LEFT THE PACK. A drop is fire-and-forget on the wire; the server
// answers a refusal with prose or with nothing at all. So the pack is read before and after
// and the difference is the answer, exactly as the vault deposit is.
export async function dropAllExcept(s, { keep = [], max = 60 } = {}) {
  const c = s.need();
  const patterns = [].concat(keep ?? []).map(String).map(x => x.trim()).filter(Boolean);
  const kept = name => patterns.some(k => name.toLowerCase().includes(k.toLowerCase()));
  // Money, always. `shilling` is the only currency this game has.
  const isMoney = name => /shilling/i.test(name);

  await s.pacer.submit('read', () => c.requestInventory());
  await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => null);
  const worn = equippedNow(c);
  if (!worn)
    return { dropped: [], kept: [], refused: true,
             why: 'the equipment set is unknown, and unknown is not permission — a drop ' +
                  'planned against it would put the character\'s own armour in the road' };

  const carried = (c.inventory || []).map(o => ({ o, name: c.rsc.get(o.nameRsc) || '' }));
  const keeping = [];
  const going = [];
  for (const x of carried) {
    if (worn.has(x.o.id)) { keeping.push({ name: x.name, why: 'equipped' }); continue; }
    if (isMoney(x.name)) { keeping.push({ name: x.name, why: 'money' }); continue; }
    if (kept(x.name)) { keeping.push({ name: x.name, why: 'on the keep list' }); continue; }
    going.push(x);
  }
  if (!going.length)
    return { dropped: [], kept: keeping, nothing_to_drop: true,
             why: 'everything carried is worn, money, or on the keep list' };

  const before = new Map(carried.map(x => [x.o.id, x.o.amount ?? 1]));
  const offered = going.slice(0, max);
  for (const x of offered)
    await s.pacer.submit('drop', () => c.drop([dropSpec(x.o)])).catch(() => {});
  await s.pacer.submit('read', () => c.requestInventory());
  await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => null);

  const dropped = [];
  const refusedItems = [];
  for (const x of offered) {
    const still = (c.inventory || []).find(o => o.id === x.o.id);
    const left = still ? (still.amount ?? 1) : 0;
    const gone = Math.max(0, (before.get(x.o.id) || 0) - left);
    if (gone) dropped.push({ name: x.name, amount: gone });
    else refusedItems.push(x.name);
  }
  return {
    dropped, kept: keeping, refused_items: refusedItems,
    offered: offered.length,
    ...(going.length > offered.length ? { not_offered: going.length - offered.length } : {}),
  };
}

export function junkAndBroken(c) {
  const broken = brokenSet(c);
  const worn = equippedNow(c) ?? new Set();
  return (c.inventory || [])
    .map(o => ({ o, name: c.rsc.get(o.nameRsc) || '' }))
    .filter(x => !worn.has(x.o.id) && (isJunk(x.name) || broken.has(x.o.id)))
    .map(x => ({ id: x.o.id, name: x.name,
                 why: broken.has(x.o.id) ? 'broken — the server refuses to wield it' : 'junk' }));
}

// ---------------------------------------------------------------- resting

// HOW HEALTH ACTUALLY COMES BACK, because getting this wrong is expensive.
//
// It regenerates constantly, one point at a time, on a timer whose interval is set
// mostly by VIGOR (player.kod:5611, CalculateHealthTime):
//
//     ms_per_point = ((200 - vigor)^2 / 6 + 1000) * (125 - stamina) / 100
//                    * 100 / bound(max_health, 40, 100)     , clamped to [1000, 60000]
//
// At vigor 80 with 50 stamina and 26 max health that is about 6.4 seconds a point;
// at full vigor it is under 2. So resting IS the right move when hurt — not because
// resting heals, but because it restores vigor, and vigor is what sets the rate.
//
// THE GATE THAT CATCHES YOU: HealthTimer only awards the point if
// PFLAG_MOVED_SINCE_ENTRY is set (player.kod:2639) — "only gain health if we've
// moved since entry". Walk into a room, stand still, and you regenerate NOTHING, for
// ever. One of mine sat in an inn at 5 of 26 and rested twenty-nine times without
// recovering a single point, which looked exactly like a game with no regeneration
// in it. It is not. It is a game that wants you to take one step first.
//
// Flasks and heal spells are still worth carrying — they are the only way to get
// health back DURING a fight, when six seconds a point is far too slow to matter.
const HEALER_ITEM = /flask/i;
const HEAL_SPELL = /^(minor heal|heal|major heal|hospice)$/i;

export async function healUp(s, { target = 0.9, maxItems = 8 } = {}) {
  const c = s.need();
  const frac = () => { const h = c.vitals()?.health; return h && h.max ? h.value / h.max : null; };
  const before = frac();
  if (before === null || before >= target) return { healed: false, reason: 'already healthy', health: before };

  await s.pacer.submit('read', () => c.requestInventory());
  await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });

  const used = [];
  let flasks = c.inventory.filter(o => HEALER_ITEM.test(c.rsc.get(o.nameRsc) || ''));
  for (let i = 0; i < maxItems && flasks.length && (frac() ?? 1) < target; i++) {
    const f = flasks.shift();
    await s.pacer.submit('act', () => c.apply(f.id, c.selfId), 1050);
    await c.waitFor({ kinds: ['stat', 'message'], timeoutMs: 2500 });
    used.push('flask');
    await s.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 2000 });
    flasks = c.inventory.filter(o => HEALER_ITEM.test(c.rsc.get(o.nameRsc) || ''));
  }

  // A heal spell is free but costs mana, and a Shal'ille character has one.
  const spell = (c.spells || []).find(sp => HEAL_SPELL.test(c.rsc.get(sp.nameRsc) || ''));
  if (spell && (frac() ?? 1) < target) {
    for (let i = 0; i < 3 && (frac() ?? 1) < target; i++) {
      const before2 = frac();
      await s.pacer.submit('cast', () => c.cast(spell.id, [c.selfId]), 1050);
      await c.waitFor({ kinds: ['stat', 'message'], timeoutMs: 3000 });
      used.push(c.rsc.get(spell.nameRsc));
      if ((frac() ?? 0) <= (before2 ?? 0)) break;      // out of mana or reagents
    }
  }

  const after = frac();
  return {
    healed: after > before, used, health: { before, after },
    reached_target: after >= target,
    ...(after < target && !used.length ? {
      reason: 'nothing to heal with',
      note: 'no flask and no heal spell — but health does regenerate on its own, about ' +
            'once every few seconds, PROVIDED you have moved since entering this room ' +
            '(PFLAG_MOVED_SINCE_ENTRY). Take a step, then rest: resting raises vigor and ' +
            'vigor is what sets the regeneration rate.',
    } : {}),
  };
}

// EATING IS HOW YOU GET VIGOR ABOVE THE RESTING CEILING.
//
// Resting only takes vigor to piVigor_rest_threshold — 80 on a 200 scale. Above that
// the only lever is food: EatSomething calls AddExertion(-10000 * nutrition), and
// less exertion is more vigor (player.kod:5734). Vigor in turn sets the health
// regeneration rate, so a well-fed character both survives longer and recovers
// faster between fights. Players describe not wanting to fight under 100 vigor, and
// the arithmetic agrees with them.
//
// THE CONSTRAINT IS THE STOMACH, NOT THE MONEY. ReqEatSomething refuses when
// piStomach + filling > 100, and the stomach empties only with time — so what
// matters is nutrition per unit of FILLING, not nutrition per shilling:
//
//     inky cap mushroom   50 nutrition / 25 filling = 2.00   250sh
//     wheel of cheese     30 / 40 = 0.75                      80sh
//     meat pie            30 / 50 = 0.60                      80sh
//     loaf of bread       20 / 40 = 0.50                      60sh
//     apple               10 / 24 = 0.42                      25sh
//
// An inky cap is 2.7x the vigor per sitting that cheese is, for about 3x the price —
// roughly break-even on cost and far better on the thing that is actually scarce.
// EVERY NUMBER HERE IS FROM THE KOD, not from tasting.
//
// Read out of kod/object/item/passitem/numbitem/food/*.kod - each item sets
// viNutrition and viFilling, and food.kod's base class defaults to 10/50. Taking
// that default for a real item is the mistake this table used to make: "edible
// mushroom" is snack.kod, which overrides to 5/15, so it was filed at 0.20 when it
// is really 0.33 - and several cheap meats were recorded at filling 25 where the kod
// says 20 or 30. Two entries also carried a literal backspace byte where  was
// meant, so /stew/ and /apple/ could never match at all.
//
// Sorted by nutrition per unit of FILLING, the only ranking that matters: the
// stomach caps at 100 and drains 0.12 a second, so filling is what is scarce and
// shillings are not.
//
//   Inky-cap mushroom   50/25 = 2.00   not sold in shops; late drop, hoarded for wars
//   chocolate mint       5/5  = 1.00   tiny, and perfectly efficient
//   wheel of cheese     30/40 = 0.75   the best thing a shop will sell you
//   turkey leg          15/20 = 0.75
//   mug of stout         6/8  = 0.75
//   meat pie            30/50 = 0.60
//   stew                15/25 = 0.60
//   loaf of bread       20/40 = 0.50
//   waterskin            3/6  = 0.50
//   slice of pork        9/20 = 0.45   also bowl of soup, spideye
//   bunch of grapes      7/16 = 0.44
//   apple               10/24 = 0.42
//   edible mushroom      5/15 = 0.33   poor, but it clears in 125s and can be free
//   drumstick            9/30 = 0.30
//   goblet               3/10 = 0.30
// THE TABLE ANSWERS THIS, AND A SECOND LIST HERE MATCHED THE WRONG NAMES FOR MONTHS.
//
// This was a private regex list, and two of its patterns were the kod CLASS names tested
// against the DISPLAY names the wire actually sends:
//
//     { re: /waterskin/i, ... }                              the wire says "water skin"
//     { re: /slice of pork|bowl of soup|spideye/i, ... }      the wire says "spider eye"
//
// `spideye` and `waterskin` are what the classes are called (Spideye, Waterskin — and the
// comment above still lists them that way); neither ever matched an inventory entry. So
// `larderOf` silently dropped every spider eye and every water skin in the fleet.
//
// WHAT THAT COST, measured on prod 2026-09-05. `has_food` is `larderOf(c).length > 0` and
// `larder_vigor` is its nutrition sum, so a character carrying nothing else read as having
// NO food. DUM's throttle rule reads `larder_vigor` and PREFERS it over its own regex — which
// does match "spider eye" — so it called them unfed and sent `fight_above_vigor: 80` (its
// no_food floor) instead of 200. Pinned at the resting cap, never eating, while carrying it:
// Gonzo 26 spider eyes reading larder_vigor 0 of a true 234, Clifford 16 of a true 156, Zoot
// seeing 50 of 224. 849 nutrition invisible across the fleet, and 9 characters stuck at 80.
//
// The items table is generated from the Food class tree and keys on the display name, which
// is the only name the protocol ever gives us. Use it. A second opinion about what food is,
// maintained by hand next to a generated table, is the bug — not the spelling.
//
// It is also strictly better than the regexes were: `/mug of/i` valued every mug at 6/8 when
// brew and pekonch are 3/10, and `/goblet/i` valued wine at 3/10 when it is 6/8. And it stops
// matching substrings, which is the rule this repository already states for item identity —
// "mushroom" is its own item and must never mean every item whose longer name contains it.

// THE STOMACH, MODELLED — because the protocol never sends it.
//
// piStomach is server-side and nothing reports it, but it is fully determined by two
// things we can see and one constant we can read:
//
//   EatSomething:   piStomach += filling                      (player.kod:5744)
//   UpdateStomach:  piStomach -= elapsed_seconds * 12 / 100   (player.kod:1347)
//   ReqEatSomething refuses when piStomach + filling > 100     (player.kod:5703)
//
// So it drains 0.12 a second — a full stomach takes 833 seconds, 13.9 minutes, which
// the kod states outright and then adds the line that matters most: "Need empty
// stomach to get vigor boost from food."
//
// Tracking it locally turns "eat and hope" into arithmetic: we know before asking
// whether a given food will fit, and how many seconds until it would. And the model
// is self-correcting — a refusal is itself a measurement, since being told no to a
// food of filling F proves the stomach is above 100 - F.
export const STOMACH_CAP = 100;
export const STOMACH_DRAIN_PER_SEC = 0.12;        // FOOD_USE_RATE 12, applied /100

export class Stomach {
  constructor(value = 0) { this.value = value; this.at = Date.now(); }
  #settle() {
    const now = Date.now();
    this.value = Math.max(0, this.value - (now - this.at) / 1000 * STOMACH_DRAIN_PER_SEC);
    this.at = now;
  }
  get level() { this.#settle(); return this.value; }
  ate(filling) { this.#settle(); this.value = Math.min(STOMACH_CAP, this.value + filling); }
  // A refusal is evidence, not just a failure.
  refused(filling) { this.#settle(); this.value = Math.max(this.value, STOMACH_CAP - filling + 1); }
  roomFor(filling) { return this.level + filling <= STOMACH_CAP; }
  secondsUntilRoomFor(filling) {
    const over = this.level + filling - STOMACH_CAP;
    return over <= 0 ? 0 : Math.ceil(over / STOMACH_DRAIN_PER_SEC);
  }
}

// What is worth eating next, best nutrition per unit of filling first, and whether
// there is currently room for it. Lets a caller decide to WAIT rather than ask.
// A CHARACTER WITH NO CLIENT HAS AN EMPTY LARDER, NOT A CRASH.
//
// This dereferenced `c.inventory` directly while its sibling weaponsOf has always
// guarded with `(c.inventory || [])`, and the difference took out the whole fleet
// listing: `fleet: error: Cannot read properties of null (reading 'inventory')`, which
// aborted m59-rearm before it armed anybody and left Clifford hunting fungus beasts
// bare-handed. One character between sessions is enough to do it, because the fleet row
// builder asks every agent in turn and one throw ends the request.
//
// Of the seven callers, three pass `s.client` — which is null for any dropped session,
// and this fleet drops and rejoins constantly. Answering "nothing to eat" for a
// character that is not in the world is both true and harmless; throwing is neither.
export function larderOf(c) {
  if (!c) return [];
  return (c.inventory || [])
    .map(o => ({ o, name: c.rsc.get(o.nameRsc) || '', food: foodValue(c.rsc.get(o.nameRsc) || '') }))
    .filter(x => x.food)
    .sort((a, b) => (b.food.nutrition / b.food.filling) - (a.food.nutrition / a.food.filling));
}

// Exact canonical identity, after punctuation/plural normalisation. A configured
// "mushroom" protects the item actually named mushroom, not every longer mushroom
// name; the broker separately rejects settings that do not resolve in m59-items.json.
export { itemNameKey };
export function itemNameMatches(name, wanted) {
  const have = itemNameKey(name), ask = itemNameKey(wanted);
  return !!have && have === ask;
}
export const itemIsProtected = (name, wanted = []) =>
  [].concat(wanted || []).some(item => itemNameMatches(name, item));

// WHAT THE FLEET WANTS, so that nothing another character needs is ever sold to an NPC.
//
// A merchant buys low and sells high. A herb sold by one character and bought back by
// another pays that spread TWICE, and the fleet is a single owner — the only reason a
// reagent ever reached a shop counter is that neither end knew about the other. Worse
// than the money: `create food` refuses silently without 2 ElderBerry and 2 Herbs, so a
// character that sold its herbs cannot raise its vigor above the 80 that resting gives,
// and fights permanently tired next to someone carrying sixty of them.
//
// A process-wide board rather than anything on the wire — every keeper in this broker
// writes what it is short of and what it can spare, and the sell and drop paths read the
// aggregate before letting anything go. When the guild hall lands, its store is another
// holder to publish into this same board rather than a second mechanism.
export const interest = {
  byAgent: new Map(),          // agent -> wants, exact needs, spare, room and freshness

  declare(agent, { wants = [], needs = new Map(), spare = new Map(), room = null,
                   character = null, farming = false } = {}) {
    this.byAgent.set(agent, {
      wants: new Set(wants.map(w => String(w).toLowerCase())),
      needs: needs instanceof Map ? needs : new Map(Object.entries(needs)),
      spare: spare instanceof Map ? spare : new Map(Object.entries(spare)),
      room: room == null ? null : Number(room),
      character: character == null ? null : String(character),
      farming: !!farming,
      at: Date.now(),
    });
  },
  forget(agent) { this.byAgent.delete(agent); },

  // Who wants a thing by this name — matched loosely, because the server hands us
  // display names ("herb", "elderberry") and callers think in kinds.
  wantedBy(name, { except = null } = {}) {
    const n = String(name || '').toLowerCase();
    if (!n) return [];
    const out = [];
    for (const [agent, rec] of this.byAgent) {
      if (agent === except) continue;
      for (const w of rec.wants) if (n.includes(w) || w.includes(n)) { out.push(agent); break; }
    }
    return out;
  },
  anyoneWants(name, opts) { return this.wantedBy(name, opts).length > 0; },

  // Who is carrying spare of a thing, most first. Used to pair a giver with a needer.
  holdersOf(kind) {
    const k = String(kind || '').toLowerCase();
    return [...this.byAgent].filter(([, r]) => (r.spare.get(k) ?? 0) > 0)
      .map(([agent, r]) => ({ agent, count: r.spare.get(k) }))
      .sort((a, b) => b.count - a.count);
  },

  // Exact, fresh demand in one destination room. Farm delivery reads this instead of
  // guessing from the courier's own pack, so a town trip buys what the people still in
  // that room need. A stale or non-farming declaration is not a delivery order.
  demandsForRoom(room, opts = {}) {
    return this.demandsNear(new Map([[Number(room), 0]]), opts);
  },

  // THE SAME QUESTION ASKED OF A NEIGHBOURHOOD, which is what farm delivery actually wants
  // to know. `rooms` is a Map of room -> hop distance (see `roomsWithin` in m59-map.mjs);
  // the result is sorted nearest first, so a courier serves the room it is standing in
  // before it walks anywhere.
  //
  // This exists because a delivery addressed to ONE room is addressed to a snapshot of who
  // stood in it ninety seconds ago. Characters move constantly — the fleet's own record has
  // farmers crossing a room boundary between the poll and the arrival — and the old
  // behaviour reported that as "farmer left the room or is dead" and carried the goods
  // home. The neighbourhood is the unit that survives that.
  demandsNear(rooms, { except = null, maxAgeMs = 90_000 } = {}) {
    const within = rooms instanceof Map ? rooms
      : new Map([...rooms].map(r => [Number(r), 0]));
    const now = Date.now();
    return [...this.byAgent]
      .filter(([agent, rec]) => agent !== except && rec.farming && rec.room != null &&
        within.has(rec.room) && now - rec.at <= maxAgeMs)
      .map(([agent, rec]) => ({ agent, character: rec.character, room: rec.room,
        hops: within.get(rec.room) ?? 0,
        needs: Object.fromEntries([...rec.needs].map(([kind, amount]) =>
          [String(kind).toLowerCase(), Math.max(0, Math.floor(Number(amount) || 0))])), at: rec.at }))
      .filter(rec => Object.values(rec.needs).some(amount => amount > 0))
      .sort((a, b) => a.hops - b.hops || b.at - a.at);
  },

  board() {
    return [...this.byAgent].map(([agent, r]) => ({
      agent, character: r.character, room: r.room, farming: r.farming,
      wants: [...r.wants], needs: Object.fromEntries(r.needs), spare: Object.fromEntries(r.spare),
    }));
  },
};

// The things a fleet member is ever worth holding for somebody else. Deliberately short:
// the point is to stop reagents leaking to vendors, not to turn every character into a
// warehouse. Weight is the reason this is a list and not "anything anyone wants".
export const SHAREABLE = [
  { kind: 'elderberry', re: /elder\s?berry/i, why: 'create food, 2 per casting' },
  { kind: 'herb',       re: /^herbs?$/i,      why: 'create food, 2 per casting' },
];
export const shareKind = (name) => SHAREABLE.find(s => s.re.test(String(name || '')))?.kind ?? null;

// What in the pack could be swung at something, best first.
//
// The mirror of larderOf, and it exists for the same reason: "can this character
// actually fight?" and "can it actually keep fighting?" are the two questions a fleet
// page has to answer, and both of them are about what is in the pack rather than
// about any number the server reports. A character with no weapon is not hunting, it
// is standing in a monster room punching things — GetWeapon returns nothing for an
// empty hand and UserAttack quietly falls back to a punch, so nothing about it reads
// as broken from the outside.
export function weaponsOf(c) {
  // `(c.inventory || [])` guarded a null INVENTORY and not a null CLIENT, which is the
  // case that actually happens. This sits one line above larderOf in the fleet row, so
  // either of them could have been the throw that took out the whole listing.
  if (!c) return [];
  return (c.inventory || [])
    .map(o => ({ o, name: c.rsc.get(o.nameRsc) || '' }))
    .map(x => ({ ...x, score: weaponScore(x.name) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

// Vigor is capped at 200, and nutrition converts to it one for one: EatSomething
// calls AddExertion(-10000 * nutrition), and the rest timer awards a single point
// with RestAddExertion(-10000). So an inky cap is fifty vigor — and eating one at
// 190 throws forty of them away along with the stomach room, which is the resource
// that actually runs out. `maxWaste` is how much overshoot is tolerable.
export const VIGOR_MAX = 200;

export async function eat(s, { maxItems = 4, stomach = null, upToVigor = null,
                               maxWaste = 12, refresh = true,
                               exclude = [],
                               beforeMutation = null, shouldCancel = null } = {}) {
  const c = s.need();
  if (refresh) {
    await s.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
  }

  const vig = () => c.vitals()?.vigor?.value ?? null;
  const before = vig();

  // Best nutrition per unit of filling first — the stomach is what runs out.
  const larder = larderOf(c).filter(item => !itemIsProtected(item.name, exclude));

  if (!larder.length)
    return { ate: [], filling: 0, vigor: before, reason: 'carrying no food',
             note: 'vigor above the resting threshold of 80 comes only from eating; ' +
                   'inky cap mushrooms are the most stomach-efficient thing to carry' };

  const ate = [];
  let filling = 0, tooFull = false, wasteful = 0;
  for (const item of larder.slice(0, maxItems)) {
    if (typeof shouldCancel === 'function' && shouldCancel())
      return { ate, filling, tooFull, wasteful, cancelled: true,
               vigor: { before, after: vig() } };
    // Stop once we have what we came for; the rest of the larder keeps, and stomach
    // room spent now is room unavailable during the fight.
    if (upToVigor != null && (vig() ?? 0) >= upToVigor) break;
    // Do not spend a request on a mouthful we already know will be refused.
    if (stomach && !stomach.roomFor(item.food.filling)) { tooFull = true; continue; }
    // Do not spend fifty vigor of mushroom to gain five. Skip it and try something
    // smaller; the good stuff keeps, and the stomach room does not.
    if ((vig() ?? 0) + item.food.nutrition - VIGOR_MAX > maxWaste) { wasteful++; continue; }

    const b = c.evSeq;
    await s.pacer.submit('act', () => {
      if (typeof beforeMutation === 'function')
        beforeMutation('eat', { item_id: item.o.id, expected_name: item.name, role: 'food' });
      return c.apply(item.o.id, c.selfId);
    }, 1050);
    const ev = await c.waitFor({ since: b, kinds: ['message', 'stat'], timeoutMs: 2500 }).catch(() => ({ events: [] }));
    // "You are too full to eat" means the stomach is the binding constraint; stop
    // rather than spending the rest of the larder on refusals — and record what the
    // refusal just told us about how full we are.
    if (ev.events?.some(e => /too full/i.test(e.text || ''))) {
      stomach?.refused(item.food.filling);
      tooFull = true;
      break;
    }
    stomach?.ate(item.food.filling);
    filling += item.food.filling;
    ate.push(item.name);
  }
  await s.pacer.submit('read', () => c.stats(1));
  await c.waitFor({ kinds: ['stat'], timeoutMs: 2000 });
  return { ate, filling, tooFull, wasteful, vigor: { before, after: vig() },
           note: ate.length ? undefined
             : wasteful ? 'already near full vigor; not spending stomach room on overshoot'
             : 'too full to eat anything — the stomach empties with time' };
}

export const foodInInventory = (c) =>
  !c ? 0 : (c.inventory || []).filter(o => foodValue(c.rsc.get(o.nameRsc) || '')).length;

// Make sure the regeneration timer will actually pay out.
//
// HealthTimer refuses to award a point unless the player has moved since entering the
// room, so a character that walks in and stops recovers nothing at all no matter how
// long it waits. One step is enough to set the flag, and it is cheap — a second.
export async function nudge(s) {
  const c = s.need();
  const me = c.self;
  if (!me) return { moved: false, why: 'position unknown' };
  const before = { col: me.col, row: me.row };
  const geo = s.world?.geometry;
  if (!geo?.collisionReady) return { moved: false, reason: 'collision_geometry_unavailable',
                                      why: 'collision_geometry_unavailable' };
  const deltas = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  // TRY THE EMPTY SIDES FIRST. In a crowded inn the neighbouring squares are other
  // characters, and a step into one is refused — so a nudge that walks the ring in a
  // fixed order can burn all eight attempts against the pile it is standing in and
  // report "every neighbouring square refused". The flag stays unset, and the
  // character regenerates nothing for as long as the crowd lasts.
  const c2 = c.room?.objects;
  const taken = new Set(c2 ? [...c2.values()].filter(o => o.id !== c.selfId)
                              .map(o => `${o.col},${o.row}`) : []);
  deltas.sort((a, b) => (taken.has(`${before.col + a[0]},${before.row + a[1]}`) ? 1 : 0) -
                        (taken.has(`${before.col + b[0]},${before.row + b[1]}`) ? 1 : 0));
  for (const [dc, dr] of deltas) {
    const col = before.col + dc, row = before.row + dr;
    if (!geo.walkable(row, col) || !geo.canMove(before.row, before.col, row, col)) continue;
    const step = await s.step(col, row, { confirm: true });
    if (isTerminalMovementReason(step.reason))
      return { moved: false, reason: step.reason, why: step.note ?? step.reason, note: step.note };
    const now = c.self;
    if (step.moved || (now && (now.col !== before.col || now.row !== before.row)))
      return { moved: true, from: before,
               to: now ? { col: now.col, row: now.row } : { col, row },
               why: 'health regeneration is gated on having moved since entering the room' };
  }
  return { moved: false, why: 'every neighbouring square refused' };
}

// ARM THE SAME TIMER WITHOUT LEAVING THE SQUARE.
//
// nudge() steps, and a step is exactly what you must not do when you are standing in
// a safe spot: the spot is a place, and the moment you leave it the walls stop
// covering you. Turning sets PFLAG_MOVED_SINCE_ENTRY the same way a step does — the
// flag is about having acted, not about having travelled — so a character that has
// just reconnected can arm its own health regeneration, wake the monsters it is
// hiding from, and still be somewhere they cannot reach.
//
// REQ_TURN carries no coordinates, so this cannot move us even if the server
// disagrees with our idea of where we are. Verified anyway, because a "safe spot"
// that quietly drifted is worse than no safe spot at all.
export async function turnInPlace(s, { degrees = null, verify = true } = {}) {
  const c = s.need();
  const me = c.self;
  if (!me) return { turned: false, why: 'position unknown' };
  const from = me.degrees ?? 0;
  const to = degrees ?? Math.round((from + 90) % 360);
  const was = { col: me.col, row: me.row, x: me.x, y: me.y };
  await s.pacer.submit('turn', () => c.face(to));
  await sleep(300);
  if (!verify) return { turned: true, from, to, moved: false };
  await s.pacer.submit('read', () => c.roomContents());
  await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2000 });
  const now = c.self;
  const moved = !!now && (now.col !== was.col || now.row !== was.row);
  return {
    turned: true, from, to, moved,
    position: now ? { col: now.col, row: now.row, x: now.x, y: now.y } : null,
    why: 'turning arms the health regeneration timer without giving up the square',
  };
}

// Go back to an EXACT position, to the fine unit.
//
// moveToSquare aims at the centre of a square (col*64+32). A safe spot that works by
// hugging a wall can be most of a square off that centre, so "walk back to r23c25"
// is not the same request as "stand where I was standing", and the difference is the
// difference between a wall at your back and a wall nearby. Fine movement is the only
// way to say the second one.
// HOW CLOSE COUNTS AS "IN THE POCKET", where the fine mover owns the approach and the
// square walker becomes the fallback. Three squares: a safe wall's disagreement with the
// coarse grid is a local thing — it is the ring of neighbours around the square — so the
// handover wants to happen at about the radius of that ring rather than at some fraction
// of the whole trip, which would move with how far away the character happened to start.
const FINE_HANDOVER_SQUARES = Number(process.env.M59_FINE_HANDOVER_SQUARES || 3);

export async function returnToSpot(s, spot, { maxSteps = 20, tolerance = 12 } = {}) {
  const c = s.need();
  if (!spot) return { arrived: false, why: 'no spot given' };
  // A normal square walk is dead-reckoned for speed. That is appropriate while
  // crossing a room, but a predicted arrival is not evidence that we regained a
  // particular safe square: a delayed server position can still replace it and leave
  // the keeper holding a square it is not on. This exact race made pull() report that
  // it was back at the wall, only for observe() to release and reacquire the same wall
  // on the next pass forever.
  //
  // Pay for one authoritative read at this boundary. Fine movement already confirms
  // every step, so this is needed only while the current position is explicitly marked
  // as predicted. Test doubles and older sessions without confirmPosition retain the
  // old behaviour rather than becoming unusable.
  const confirmPrediction = async () => {
    if (c.self?.predicted && typeof s.confirmPosition === 'function')
      await s.confirmPosition();
    return c.self;
  };
  const at = () => {
    const me = c.self;
    if (!me) return null;
    // The hold belongs to the coarse square even when an exact fine position was
    // recorded. Requiring both keeps inconsistent/stale position fields from turning a
    // nearby square into a successful return that observe() must revoke one pass later.
    if (me.col !== spot.col || me.row !== spot.row) return Infinity;
    if (spot.x == null) return 0;
    return Math.hypot(me.x - spot.x, me.y - spot.y);
  };
  await confirmPrediction();
  const d0 = at();
  if (d0 !== null && d0 <= tolerance) return { arrived: true, already: true, off_by: d0 };

  // Get onto the right square first through the geometry, then close the last few
  // fine units directly — the square router cannot express the last bit.
  //
  // AND WHEN IT CANNOT EXPRESS THE FIRST BIT EITHER, ASK THE FINE GRID FOR THE WHOLE
  // APPROACH. A safe wall IS the coarse grid and the BSP disagreeing; that is what makes
  // it safe and it is also what makes the square router bad at reaching it. This used to
  // give up here — `could not walk back to the square` — with the fine tools sitting
  // unused two lines below, because they only ever ran once `walkTo` had already
  // succeeded. Measured live: a proved wall ten squares away in the Cragged Mountains,
  // abandoned at exactly this line, twice in one evening.
  //
  // WHICH FINE TOOL IS NOT THE ONE YOU WOULD PICK. Measured over 107 approaches in the
  // eleven rooms this fleet uses: the square walker reaches the wall 85% of the time, the
  // greedy sliding fan 69%, and A* on the quarter-square lattice 23%. The square walker is
  // the BEST of the three. `finePath` is worst because `moveLands` refuses any move whose
  // slide ends more than ARRIVE_WITHIN off its aim, and a pocket the BSP hems in is a place
  // where EVERY move slides — so the fine lattice has no edges at all in exactly the squares
  // that make a safe spot safe.
  //
  // So `Session.approachFine` is the sliding fan, and it is worth having only as a SECOND
  // attempt: it is worse on average and it reaches two walls in the Cragged Mountains that
  // the square walker loses, which is the room the whole road turns on. Free when the square
  // walk works, because it does not run.
  // THE LAST FEW SQUARES BELONG TO THE FINE GRID, AND THE HANDOVER USED TO COME TOO LATE.
  //
  // The order above is right for the HAUL — the square walker reaches the wall 85% of the
  // time against the sliding fan's 69% — and it is wrong for the ARRIVAL. A safe wall IS
  // the coarse grid and the BSP disagreeing about which neighbours exist; that is the whole
  // reason the square is worth standing on, and it is also the reason the square router is
  // at its worst in exactly the last two or three steps. Running it all the way in and only
  // reaching for the fine tools once it had failed the WHOLE approach meant the coarse
  // walker got to fail at the one part of the trip it cannot do, and `could not reach the
  // safe spot` was the commonest thing in the death records — 12 of 21 postmortems in one
  // window, with `fine approach did not arrive` under it.
  //
  // So the handover is by DISTANCE now. Far away, the square walker does what it is good
  // at. Once we are inside the pocket, the fine mover owns the approach and the square
  // walker is the fallback rather than the opener. The 85/69 measurement is not contradicted
  // by this — it compared whole approaches, and this changes which tool owns which part.
  if (c.self && (c.self.col !== spot.col || c.self.row !== spot.row)) {
    const away = Math.max(Math.abs(c.self.col - spot.col), Math.abs(c.self.row - spot.row));
    const fineOwnsIt = away <= FINE_HANDOVER_SQUARES && typeof s.approachFine === 'function';
    let w;
    if (fineOwnsIt) {
      w = await s.approachFine(spot.col, spot.row, { toX: spot.x, toY: spot.y })
                 .catch(e => ({ arrived: false, reason: e.message }));
      if (!w.arrived) {
        const square = await s.walkTo(spot.col, spot.row, { maxSteps })
                              .catch(e => ({ arrived: false, reason: e.message }));
        if (square.arrived) w = square;
        else w = { ...square, fine_tried: w.reason ?? 'fine approach did not arrive' };
      }
    } else {
      w = await s.walkTo(spot.col, spot.row, { maxSteps }).catch(e => ({ arrived: false, reason: e.message }));
      if (!w.arrived && typeof s.approachFine === 'function') {
        const fine = await s.approachFine(spot.col, spot.row, { toX: spot.x, toY: spot.y })
                            .catch(e => ({ arrived: false, reason: e.message }));
        if (fine.arrived) w = fine;
        else w = { ...w, fine_tried: fine.reason ?? 'fine approach did not arrive' };
      }
    }
    if (!w.arrived)
      return { arrived: false, why: w.reason || 'could not walk back to the square',
               ...(w.fine_tried ? { fine_tried: w.fine_tried } : {}) };
    await confirmPrediction();
  }
  if (spot.x != null && s.walkFine) {
    await s.walkFine(spot.x, spot.y, { maxSteps: 6, stride: 40, arriveWithin: tolerance })
           .catch(() => null);
  }
  const d = at();
  return { arrived: d !== null && d <= tolerance, off_by: d,
           position: c.self ? { col: c.self.col, row: c.self.row, x: c.self.x, y: c.self.y } : null };
}

// Sit until a vital comes back, or until nothing is improving. Resting is silent
// unless something changes, so "no reply" is the normal case and cannot be used as a
// stop condition — the stop condition has to be the numbers themselves.
// STOP RESTING IF THE RESTING IS NOT WORKING.
//
// `abortOnDamage` is on by default and is the difference between a rest and a
// beating. Resting restores health slowly and does nothing whatsoever to stop
// anything hitting you, so the only evidence that a rest is going badly is that
// health is going DOWN — and the loop below already reads vitals every three
// seconds to decide whether it is finished. It simply never asked.
//
// Zoot rested 61 seconds on a square proven safe while four mummies that the proof
// never covered took him from 17 health to 3. Every one of those reads saw the
// number falling and none of them was allowed to care. Three seconds of that is a
// bad break; a minute of it is nearly a death.
// `mana` defaults to 0 — no requirement — so every existing caller is unchanged. It is
// there for the one case that needs it: a character recovering after a death, whose only
// route back to a weapon is `create weapon` at 15 mana. Health and vigor can both be full
// while that character is still unable to arm itself, and sitting is the only place mana
// comes back at any speed.
export async function restUntil(s, { health = DEFAULT_REST_UNTIL, vigor = DEFAULT_REST_UNTIL,
                                     mana = 0,
                                     maxSeconds = 120, abortOnDamage = true,
                                     beforeMutation = null, beforeCleanup = null,
                                     shouldCancel = null } = {}) {
  const c = s.need();
  const read = async () => {
    await s.pacer.submit('read', () => c.stats(1));
    await c.waitFor({ kinds: ['stat'], timeoutMs: 2000 });
    return c.vitals();
  };
  let v = await read();
  const started = { ...v };
  const done = () => (vitalFrac(v, 'health') ?? 1) >= health && (vitalFrac(v, 'vigor') ?? 1) >= vigor
                  && (vitalFrac(v, 'mana') ?? 1) >= mana;
  if (done()) return { rested: false, note: 'already recovered', vitals: v };
  if (typeof shouldCancel === 'function' && shouldCancel())
    return { rested: false, cancelled: true, vitals: v };

  await s.pacer.submit('rest', () => {
    if (typeof beforeMutation === 'function') beforeMutation('rest');
    return c.rest();
  });
  const t0 = Date.now();
  let stalled = 0, last = -1, interrupted = null;
  let cleanupSkipped = null;
  // The best health seen SO FAR in this rest, not the health we sat down at: a rest
  // that climbs 12 -> 16 and is then hit back to 14 is being interrupted, and
  // comparing against the starting 12 would call that progress and sit through it.
  let peak = v?.health?.value ?? null;
  // How much poison has taken during this rest. Reported rather than acted on: a rest that
  // is not winning still ends on its own leash, and the caller deserves to know which.
  let poisonDrain = 0;
  try {
    while (Date.now() - t0 < maxSeconds * 1000 &&
           !(typeof shouldCancel === 'function' && shouldCancel())) {
      await sleep(3000);
      v = await read();
      const hp = v?.health?.value ?? null;
      if (abortOnDamage && hp != null) {
        if (peak == null || hp > peak) peak = hp;
        else if (hp < peak) {
          // Health only falls while resting if something is hitting us. Whatever the
          // caller believed about this square, it is wrong NOW — hand that back rather
          // than sitting out the remaining leash.
          // POISON IS NOT SOMETHING HITTING US. It drains with nobody adjacent and cannot
          // kill, so the inference this line rests on — "health only falls while resting if
          // something is hitting us" — is false for exactly as long as a character is
          // poisoned. Aborting there ends a rest that was never in danger, and upstream the
          // same reading discredits the square for good.
          const ailing = c.ailments?.() ?? [];
          if (ailing.length) {
            poisonDrain += peak - hp;
            peak = hp;                 // measure the next fall from here, not from before it
            continue;
          }
          interrupted = `took ${peak - hp} damage while resting — something is hitting us`;
          break;
        }
      }
      if (done()) break;
      // A room can prevent resting, and standing back up is silent too. If nothing has
      // moved for three checks, say so rather than sitting for the full timeout.
      // MANA COUNTS TOWARD "SOMETHING IS STILL MOVING" WHEN IT IS BEING WAITED ON. Without
      // it, a character sitting for mana alone — health and vigor already at their
      // ceilings, which is exactly the post-death case — reads as stalled after three
      // checks and stands up nine seconds in, every time.
      const now = (vitalFrac(v, 'health') ?? 0) + (vitalFrac(v, 'vigor') ?? 0)
                + (mana > 0 ? (vitalFrac(v, 'mana') ?? 0) : 0);
      if (Math.abs(now - last) < 0.001) { if (++stalled >= 3) break; } else stalled = 0;
      last = now;
    }
  } finally {
    // Standing is cleanup for a rest that already began. It is intentionally still
    // sent after cancellation or a failed status read: leaving the character sitting
    // would block both movement and combat after the owned job has stopped. RTS callers
    // supply a separate cleanup authority hook: it ignores this job's cancellation bit,
    // but still refuses when a keeper resumed or endpoint/room/ownership changed.
    let cleanupAuthorized = false;
    try {
      await s.pacer.submit('rest', () => {
        if (typeof beforeCleanup === 'function') beforeCleanup('cleanup-stand');
        cleanupAuthorized = true;
        return c.stand();
      });
    } catch (error) {
      if (cleanupAuthorized || typeof beforeCleanup !== 'function' ||
          !(typeof shouldCancel === 'function' && shouldCancel())) throw error;
      cleanupSkipped = String(error?.message || error);
    }
  }
  const cancelled = typeof shouldCancel === 'function' && shouldCancel();
  return {
    rested: true,
    ...(cancelled ? { cancelled: true } : {}),
    seconds: Math.round((Date.now() - t0) / 1000),
    from: started, vitals: v,
    reached_target: done(),
    ...(cleanupSkipped ? { cleanup_stand_skipped: cleanupSkipped } : {}),
    // Set when the rest was cut short by incoming damage. Callers should treat this
    // as "the square you trusted is not working", not as an ordinary short rest.
    interrupted,
    ...(poisonDrain ? { poison_drain: poisonDrain,
                        note: 'poison took health during this rest and was not treated as an ' +
                              'attack — it drains with nobody adjacent and cannot kill, so it ' +
                              'says nothing about the square' } : {}),
    note: interrupted ? interrupted
      : done() ? undefined
      : (stalled >= 3 ? 'nothing recovered for several checks — something may be preventing rest, or you are already at your ceiling'
                      : 'timed out before reaching the target'),
  };
}

// A CHARACTER THAT SAT DOWN AND WAS NOT STOOD BACK UP CAN DO NEITHER OF THE TWO THINGS
// IT MOST NEEDS TO DO.
//
// Resting sets PFLAG_NO_MOVE and PFLAG_NO_FIGHT together (player.kod:1162,
// ResetPlayerFlagList), and only standing up or logging off clears resting — not death,
// not being attacked, not changing room. So the state outlives whatever caused it: a
// character killed mid-rest wakes in the Underworld still sitting, and a keeper that
// rested in a safe spot and lost its stand goes on being unable to swing.
//
// The two refusals behave differently, which is why they need different handling:
//
//   move    bounced SILENTLY. user.kod:2988 puts you back on the square you are already
//           on and returns, so it looks like walls, not posture — pre-empt it.
//   attack  refused OUT LOUD, "unable to lift your weapon" (user.kod:4679) — believe it
//           and recover. See CANNOT_SWING above.
//
// Standing when already standing costs nothing: UC_STAND is StopResting, which returns
// immediately when there is no rest timer. Resting is silent in both directions, so there
// is no posture to read and nothing to be gained by asking first. Just stand.
export async function standUp(s) {
  const c = s.need();
  await s.pacer.submit('rest', () => c.stand());
  await sleep(300);
}

// ---------------------------------------------------------------- finding

// Resolve a creature by name against what is actually in the room, preferring things
// that can be attacked and are close. Takes a partial name, because an agent thinks
// "spider" and the world says "baby spider".
// CREATURES, NOT PEOPLE.
//
// Every character in the game is ATTACKABLE, so "the nearest attackable thing" happily
// resolves to another player — and this fleet stands its characters next to each other
// constantly, in inns and increasingly on the same safe walls. Left unfiltered it does
// not merely pick one occasionally: 131 of 132 "hit back at whatever is adjacent"
// decisions across the fleet were aimed at a FLEETMATE, and twenty-five characters
// produced three kills between them while swinging at each other all night. Guardian
// angels meant nobody actually died of it; nobody achieved anything either.
//
// Excluding players by default is right for every caller here — you hunt creatures —
// and PvP, if it is ever wanted, should have to say so out loud.
//
// THE SUBSTRING IS THE DEFAULT BECAUSE A PERSON TYPED IT, AND `match` IS HOW A KEEPER
// SAYS OTHERWISE. An agent asking for "spider" wants whatever spider is here, and that
// is the right answer for a one-shot tool call. A keeper acting on `policy.hunt` is not
// typing: its order came from the spawn catalogue, and answering it with a different
// creature whose name happens to contain the letters is how an `ant` keeper spent its
// day on giant rats. Callers with a catalogue pass `huntMatcher(spawns, want)` in.
export function findCreature(s, needle, { attackableOnly = true, includePlayers = false,
                                          match = null } = {}) {
  const c = s.need();
  const me = c.self;
  const low = String(needle ?? '').toLowerCase();
  let list = [...c.room.objects.values()].filter(o => o.id !== c.selfId);
  if (!includePlayers) list = list.filter(o => !(o.flags & OF.PLAYER));
  if (attackableOnly) list = list.filter(o => o.flags & OF.ATTACKABLE);
  if (match) list = list.filter(o => match(c.rsc.get(o.nameRsc) || ''));
  else if (low) list = list.filter(o => c.rsc.get(o.nameRsc).toLowerCase().includes(low));
  if (me) {
    const d = o => Math.hypot(o.col - me.col, o.row - me.row);
    list.sort((a, b) => d(a) - d(b));
  }
  return list;
}

// ---------------------------------------------------------------- fighting

// The whole engagement, from "there is a spider somewhere" to "the spider is dead and
// I picked up what it dropped".
//
// The safety rails are the point. A model that has never played this game does not
// know that a fey elhai will kill a twenty-hit-point character in two exchanges, that
// fleeing takes seconds it may not have, or that its own attacks are silently
// discarded if it swings twice in a second. So: read health every round, disengage on
// a threshold, and stop rather than dying — but report everything, so the caller can
// override next time.
export async function fight(s, {
  target,
  // The id of a creature we have already hurt. A kill scores nothing unless we
  // damaged it AND it was our current target, and every new attack resets those
  // flags (player.kod:7764-7816) — so breaking off a wounded creature and coming
  // back to whatever is nearest throws away the work AND leaves a half-dead monster
  // to heal. Prefer the one we were already fighting, whenever it is still here.
  preferId = null,
  // THE ROUND BUDGET IS NO LONGER THE ONLY WAY OUT. Until `controlToken` and
  // `fightGeneration` existed below, nothing outside this function could stop it — there
  // is no `cancelAttack` in the tree and the watchdog's only interrupt is
  // `cancelMovement`, which cancels walking. So the budget was carrying a job it was
  // never designed for, which is why the three call sites disagreed about it (3 by
  // omission, 10 and 30 by choice) and why none of them argued for a number.
  //
  // It stays as a bound on a single call — a caller that wants to re-decide is entitled
  // to say when — but it is no longer the mechanism that makes a fight abandonable.
  rounds = 3,
  swingsPerRound = 1,
  disengageAt = DEFAULT_DISENGAGE_AT,
  loot = true,
  equip = true,
  // FIGHT WITHOUT MOVING. In a safe spot the square IS the advantage, so approaching
  // is not a helpful convenience — it is throwing the fight's entire premise away to
  // save a few seconds. With this set, anything out of reach is reported as out of
  // reach and the caller decides what to do about it (pull it over, or wait).
  holdPosition = false,
  // STOPPING A FIGHT FROM OUTSIDE IT. Same shape as `travel` and `lootFloor`: the
  // generation is read at entry and compared each round, so anything that calls
  // `Session.cancelFight()` — a commander claim, an errand, a park, a shutdown, an
  // operator taking the wheel — ends the fight at the next swing boundary rather than
  // waiting out the budget. The token is the shared one, so a cancel aimed at a command
  // lease stops the walk and the fight together.
  controlToken = null,
  fightGeneration = s?.fightGeneration,
  // How far a swing carries. One square plus the diagonal; the caller can widen it
  // for a bow.
  reach = 1.5,
  // Name fragments overriding which weapon to reach for. See weaponRanking.
  weaponPriority = null,
  // PvP is opt-in and every existing caller remains creature-only. exactTargetId
  // prevents a name match from drifting to a different player after verification.
  includePlayers = false,
  exactTargetId = null,
  // AN ORDER MAY NAME SEVERAL CREATURES, and then `target` is not a string to substring
  // against. The caller passes the same predicate it used to choose the quarry, and this
  // uses it instead of the name. Without it a list order stringifies to
  // "battered skeleton,zombie", matches nothing in the room, and the whole fleet reports
  // "nothing here matches" while standing in a room full of both.
  match = null,
} = {}) {
  const c = s.need();
  const log = [];
  const say = (stage, detail) => { log.push({ stage, ...detail }); return detail; };

  // Refresh before choosing: an id from a stale look may be a corpse by now.
  // SKIP THE REFRESH when holding position OR when the target is far away:
  // the refresh costs 2.5s of paced I/O, and for a distance check or an
  // out_of_reach return it is wasted. The room state is kept current by
  // the server's push packets (BP_ROOM_CONTENTS arrives automatically).
  const needRefresh = !holdPosition;
  if (needRefresh) {
    await s.pacer.submit('read', () => c.roomContents());
    await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 });
  }

  let candidates = findCreature(s, target, { includePlayers, match });
  if (exactTargetId != null) candidates = candidates.filter(object => object.id === Number(exactTargetId));
  if (!candidates.length) {
    const present = [...c.room.objects.values()]
      .filter(o => o.id !== c.selfId && (o.flags & OF.ATTACKABLE))
      .map(o => c.rsc.get(o.nameRsc));
    return {
      fought: false,
      reason: target
        ? `nothing here matches "${Array.isArray(target) ? target.join('" or "') : target}"`
        : 'nothing here can be attacked',
      attackable_here: [...new Set(present)],
      note: present.length ? 'try one of the names above' : 'this room has nothing to fight — travel somewhere else',
    };
  }
  // Holding a position narrows the field to what we can hit from it. Choosing a foe
  // first and discovering afterwards that it is across the room wastes the pass;
  // worse, `preferId` would keep re-selecting the same unreachable creature forever.
  const me0 = c.self;
  const within = o => !me0 || Math.hypot(o.col - me0.col, o.row - me0.row) <= reach;
  // Sort candidates by distance so we always pick the NEAREST match,
  // not the first one in the room-contents list. Without this, a
  // character standing on top of a spider might be sent to walk to
  // a different spider 30 cells away.
  const sorted = [...candidates].sort((a, b) => {
    if (!me0) return 0;
    const da = Math.hypot((a.col ?? 0) - me0.col, (a.row ?? 0) - me0.row);
    const db = Math.hypot((b.col ?? 0) - me0.col, (b.row ?? 0) - me0.row);
    return da - db;
  });
  const inReach = holdPosition ? sorted.filter(within) : sorted;
  if (holdPosition && !inReach.length) {
    // Preserve the quarry the caller selected before choosing its wall. Returning the
    // room-list head here could validate a spot for one monster, then make pull() fetch a
    // different one. If the preferred quarry is still present, it owns this result.
    const nearest = (preferId != null && sorted.find(o => o.id === preferId)) || sorted[0];
    return {
      fought: false, out_of_reach: true,
      reason: 'holding position and nothing matching is within reach',
      nearest: nearest ? { id: nearest.id, name: c.rsc.get(nearest.nameRsc),
                           distance: me0 ? +Math.hypot(nearest.col - me0.col, nearest.row - me0.row).toFixed(1) : null,
                           col: nearest.col, row: nearest.row } : null,
      note: 'pull it to you, or give up the spot deliberately — do not drift off it',
    };
  }

  const resumed = preferId != null && inReach.find(o => o.id === preferId);
  const foe = resumed || inReach[0];
  const foeName = c.rsc.get(foe.nameRsc);
  say('chose', { target: describeObject(foe, c.lookup),
                 ...(resumed ? { resumed: 'the one we already damaged' } : {}),
                 ...(holdPosition ? { holding: 'fighting from where we stand' } : {}) });

  let wielded = null;
  if (equip) {
    const e = await equipBest(s, { priority: weaponPriority });
    wielded = e.id ?? null;
    say('equipped', { wielding: e.wielding, verified: e.verified, skill: e.skill,
                      ability: e.ability, rejected: e.rejected, note: e.note });
  } else {
    // `equip: false` forbids a use request, not observation. Remember a currently
    // verified weapon so a mid-fight shatter can retire its exact id before stopping;
    // deliberate bare-hand training simply leaves this null.
    const held = equippedNow(c);
    wielded = weaponRanking(c, { priority: weaponPriority })
      .find(candidate => held?.has(candidate.o.id))?.o.id ?? null;
  }

  // Health BEFORE, so the report can say what the fight cost.
  await s.pacer.submit('read', () => c.stats(1));
  await c.waitFor({ kinds: ['stat'], timeoutMs: 2000 });
  const before = c.vitals();
  const startPct = pct(before.health);
  if (startPct !== null && startPct < disengageAt)
    return { fought: false, reason: `starting health is ${Math.round(startPct * 100)}%, already below the disengage threshold`,
             vitals: before, note: 'rest first' };

  // Close and face. approachSquare routes to a square BESIDE it — you cannot stand
  // where a monster stands — and faceToward matters because an attack on something
  // behind you is refused with a message about view, not range.
  //
  // NEARBY TARGET: if the foe is within 2 cells, skip the walk entirely.
  // The coarse grid often can't find a path to a square that's 1-2 cells
  // away (elevation step, diagonal wall, door), but the attack range is
  // fine-grid and the target is close enough to hit. Just face and swing.
  const meBefore = c.self;
  const foeNearby = meBefore && foe.col != null && foe.row != null
    ? Math.hypot((foe.col ?? 0) - meBefore.col, (foe.row ?? 0) - meBefore.row) <= 2
    : false;

  const spot = (holdPosition || foeNearby) ? null : s.world?.approachSquare?.(foe.col, foe.row);
  if (spot && spot.steps > 0) {
    // CAP THE APPROACH: walking more than 8 grid steps (or 12 raw cells)
    // to close on a mob blocks the broker for 2-40s (coarse vs fine grid).
    // The GOAP re-plans every second; a long approach is better done across
    // multiple passes. Check both grid steps and raw distance because the
    // grid uses diagonal movement and can report fewer steps than the
    // actual distance.
    const rawDist = meBefore && foe.col != null ? Math.hypot(foe.col - meBefore.col, foe.row - meBefore.row) : spot.steps;
    if (spot.steps > 6 || rawDist > 8) {
      return { fought: false, out_of_reach: true, target: foeName,
               foe_id: foe.id, reason: `target ${rawDist.toFixed(0)} cells away — too far to approach this pass`,
               nearest: { distance: +rawDist.toFixed(1) }, log, note: 'the GOAP will travel closer on the next pass' };
    }
    let walk = await s.walkTo(spot.col, spot.row, { maxSteps: Math.min(10, Math.max(6, spot.steps * 2)), arriveWithin: KOD_FINENESS });
    say('approached', { arrived: walk.arrived, steps: walk.steps, reason: walk.reason });
    if (!walk.arrived) {
      // COARSE GRID FAILED — TRY FINE
      const half = KOD_FINENESS >> 1;
      const fx = spot.col * KOD_FINENESS + half;
      const fy = spot.row * KOD_FINENESS + half;
      // Scale maxSteps with distance: a winding forest path can be
      // 3-4x the straight-line distance. At stride 48, each step
      // covers 48 fine units. Cap at 40 steps (40s) — the GOAP
      // re-plans every second, so a longer walk is better done
      // across multiple passes.
      const distCells = spot.steps || 10;
      const fineMaxSteps = Math.min(10, Math.max(8, Math.ceil(distCells * KOD_FINENESS / 48)));
      say('fine_fallback', { to: [fx, fy], reason: walk.reason, maxSteps: fineMaxSteps });
      walk = await s.walkFine(fx, fy, { maxSteps: fineMaxSteps, stride: 48, arriveWithin: KOD_FINENESS })
                     .catch(e => ({ arrived: false, reason: e.message }));
      say('fine_result', { arrived: walk.arrived, steps: walk.steps, reason: walk.reason });
    }
    if (!walk.arrived) {
      if (foeNearby) {
        // Close enough to try attacking even if the walk failed.
        say('nearby_walk_failed', { reason: walk.reason });
      } else {
        return { fought: false, reason: walk.reason || 'could not get to it', log,
                 note: 'neither coarse-grid walkTo nor fine-grid walkFine could reach the target' };
      }
    }
  } else if (!holdPosition && !spot && !foeNearby) {
    // NO COARSE APPROACH SQUARE AT ALL AND NOT NEARBY — try fine grid
    const half = KOD_FINENESS >> 1;
    const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    let fineArrived = false;
    for (const [dc, dr] of dirs) {
      const fx = (foe.col + dc) * KOD_FINENESS + half;
      const fy = (foe.row + dr) * KOD_FINENESS + half;
      const distCells = Math.hypot((foe.col ?? 0) - (meBefore?.col ?? 0), (foe.row ?? 0) - (meBefore?.row ?? 0));
      const fineMaxSteps2 = Math.max(60, Math.ceil(distCells * KOD_FINENESS / 48) * 2);
      const r = await s.walkFine(fx, fy, { maxSteps: fineMaxSteps2, stride: 48, arriveWithin: KOD_FINENESS })
                     .catch(e => ({ arrived: false, reason: e.message }));
      if (r.arrived) { fineArrived = true; break; }
    }
    if (!fineArrived)
      return { fought: false, reason: 'no approach square and fine-grid walk failed', log,
               note: 'the coarse grid found no route beside the target, and the fine grid could not reach one either' };
  } else if (foeNearby) {
    // Nearby: skip all walking, just face and attack.
    say('nearby_skip_walk', { dist: Math.hypot((foe.col ?? 0) - (c.self?.col ?? 0), (foe.row ?? 0) - (c.self?.row ?? 0)) });
  }

  let killed = false, disengaged = null, roundsFought = 0, drifted = null, stoodUp = false;
  let weaponLoss = null;
  const combatLines = [];

  // FACE THE TARGET. An attack on something behind you is refused with a
  // message about view, not range. The walk may have turned us the wrong
  // way, or the target may have moved since we last faced it.
  const meNow = c.self;
  if (meNow && foe.col != null && foe.row != null) {
    const deg = (Math.atan2(foe.row - meNow.row, foe.col - meNow.col) * 180 / Math.PI + 360) % 360;
    await c.face(deg);
    say('faced target', { deg: Math.round(deg), target: foeName });
  }

  const fightCancelled = () =>
    typeof s?.fightWasCancelled === 'function' &&
    s.fightWasCancelled(fightGeneration, controlToken);

  for (let r = 0; r < rounds; r++) {
    // Asked before the round as well as inside it. A cancel that lands between rounds
    // must not buy another exchange.
    if (fightCancelled())
      return { fought: roundsFought > 0, killed: false, died: false, cancelled: true,
               rounds: roundsFought, target: foeName, foe_id: foe.id,
               combat: combatLines.slice(-8), log,
               note: `the fight was cancelled after ${roundsFought} round(s). The monster is ` +
                     `still there and still hostile — whatever cancelled this owns the ` +
                     `character now and has to decide what happens next.` };
    if (!c.room.objects.has(foe.id)) { killed = true; break; }
    // It backed off. Swinging at nothing is free, but the server refuses the swing
    // and the caller needs to know the creature broke contact rather than that we
    // are missing — those call for opposite responses.
    if (holdPosition) {
      const here = c.self, it = c.room.objects.get(foe.id);
      if (here && it && Math.hypot(it.col - here.col, it.row - here.row) > reach) {
        drifted = { distance: +Math.hypot(it.col - here.col, it.row - here.row).toFixed(1) };
        break;
      }
    }
    const b = c.evSeq;
    // The threshold goes DOWN into the round, not just around it. Checking after four
    // swings meant checking once every four seconds against a death that takes two.
    // Re-face the target each round — it may have moved.
    const itNow = c.room.objects.get(foe.id);
    const meRound = c.self;
    if (itNow && meRound && itNow.col != null && meRound.col != null) {
      const deg = (Math.atan2(itNow.row - meRound.row, itNow.col - meRound.col) * 180 / Math.PI + 360) % 360;
      await c.face(deg);
    }
    const res = await s.attackRounds(foe.id, swingsPerRound,
      { abortBelow: disengageAt, shouldCancel: fightCancelled });
    roundsFought++;
    combatLines.push(...res.messages);

    // Cancelled between swings. Reported rather than folded into "still alive after N
    // rounds", because a fight somebody STOPPED and a fight that ran out of budget call
    // for opposite responses from the caller.
    if (res.cancelled)
      return { fought: true, killed: false, died: false, cancelled: true,
               rounds: roundsFought, at_swing: res.cancelled.at_swing,
               target: foeName, foe_id: foe.id, combat: combatLines.slice(-8), log,
               note: `the fight was cancelled mid-round, after ${roundsFought} round(s). ` +
                     `The monster is still there and still hostile.` };

    // WE ARE STILL SITTING DOWN, AND THE SERVER JUST SAID SO.
    //
    // "You find yourself unable to lift your weapon." is PFLAG_NO_FIGHT, which resting
    // sets (player.kod:1162). Nothing clears resting but standing or logging off, so a
    // rest that was cut short, or a safe spot the keeper sat down in and never got back
    // up from, turns every swing from here on into that line — a fight that reads like
    // bad luck and is actually a posture. Stand and take the round again.
    //
    // Standing is not a cure for the rest of that flag's causes. Hold, Dazzle, Blind and
    // a DM freeze set it too, and for those the honest answer is to stop and name them,
    // not to spend eleven more rounds being refused.
    if (res.messages.some(cannotSwingText)) {
      if (stoodUp)
        return { fought: false, could_not_swing: true, stood_up: true,
                 target: foeName, foe_id: foe.id, rounds: roundsFought,
                 reason: 'every swing was refused: "unable to lift your weapon"',
                 combat: combatLines.slice(-8), log,
                 note: 'standing up did not clear it, so this is not resting. The same flag is set by ' +
                       'Hold, Dazzle, Blind and a DM freeze — wait for the enchantment to lapse. More ' +
                       'swings now cost packets and do nothing.' };
      stoodUp = true;
      await standUp(s);
      say('stood up', { because: 'every swing was refused — we were sitting down', round: roundsFought });
      continue;
    }

    // Record a shatter immediately, but do not mutate equipment until the exchange's
    // terminal results are known: a dead player cannot re-arm, and a killing shatter
    // does not need to. ReqWeaponAttack has already removed the broken item from use.
    const weaponBroke = res.messages.some(brokenWeaponText);
    const brokenId = weaponBroke ? wielded : null;
    if (weaponBroke) {
      if (brokenId != null) brokenSet(c).add(brokenId);
      say('weapon broke', { was: brokenId, round: roundsFought });
    }

    // Are we dead? "Our own object is missing from the room list" is NOT the test,
    // however obvious it looks. It is also true when a save-game renumbers object
    // ids underneath a live session, and then a character standing at full health
    // reports being killed on every single pass, forever. Corroborate it: the
    // Underworld is a named room, and a corpse has no health.
    const gone = !c.room.objects.has(c.selfId);
    const inUnderworld = /underworld/i.test(c.rsc.get(c.roomNameRsc) || '');
    const noHealth = (c.vitals()?.health?.value ?? 1) <= 0;
    if (gone && (inUnderworld || noHealth)) {
      return { fought: true, killed: false, died: true, rounds: roundsFought,
               combat: combatLines.slice(-8), log,
               note: 'we were killed. You are in the Underworld; the way out is a portal — see escape_underworld.' };
    }
    if (gone) {
      // Missing but alive and not in the Underworld: our id is stale, not our body.
      return { fought: true, killed: false, died: false, rounds: roundsFought,
               combat: combatLines.slice(-8), log, stale_identity: true,
               note: 'our own object id is not in the room contents but we are alive and not in the ' +
                     'Underworld — the server most likely renumbered ids in a save. Re-login to ' +
                      'resolve a fresh id; do NOT treat this as death.' };
    }

    // Resolve the exchange before recovery policy. A low-health killing blow is still
    // a kill, and neither it nor a lethal blow to us may send inventory/use traffic.
    if (!c.room.objects.has(foe.id)) { killed = true; break; }

    // A live fight may continue after a shatter only with a replacement the server's
    // use list verifies. Otherwise stop before another attack silently becomes a punch.
    if (weaponBroke) {
      if (equip) {
        const again = await equipBest(s, { priority: weaponPriority });
        const replacementVerified = again.verified === true && again.id != null;
        wielded = replacementVerified ? again.id : null;
        say(replacementVerified ? 're-armed' : 're-arm failed', {
          wielding: again.wielding, id: again.id ?? null, verified: again.verified,
          rejected: again.rejected, note: again.note,
        });
        if (!replacementVerified) {
          weaponLoss = {
            unarmed: true,
            weapon_id: brokenId,
            reason: 'the weapon shattered and no verified replacement could be equipped',
            replacement: { id: again.id ?? null, wielding: again.wielding ?? null,
                           verified: again.verified === true },
          };
        }
      } else {
        wielded = null;
        weaponLoss = {
          unarmed: true,
          weapon_id: brokenId,
          rearm_disabled: true,
          reason: 'the weapon shattered and automatic re-arming was disabled for this fight',
        };
        say('re-arm skipped', { because: 'equip=false', weapon: brokenId });
      }
    }

    // Equipping waits for server events; terminal state can change during that wait.
    // Reclassify before sending another attack or applying an ordinary health abort.
    if (weaponBroke && equip) {
      const goneAfterRearm = !c.room.objects.has(c.selfId);
      const underworldAfterRearm = /underworld/i.test(c.rsc.get(c.roomNameRsc) || '');
      const noHealthAfterRearm = (c.vitals()?.health?.value ?? 1) <= 0;
      if (goneAfterRearm && (underworldAfterRearm || noHealthAfterRearm)) {
        return { fought: true, killed: false, died: true, rounds: roundsFought,
                 combat: combatLines.slice(-8), log,
                 note: 'we were killed. You are in the Underworld; the way out is a portal — see escape_underworld.' };
      }
      if (goneAfterRearm) {
        return { fought: true, killed: false, died: false, rounds: roundsFought,
                 combat: combatLines.slice(-8), log, stale_identity: true,
                 note: 'our own object id is not in the room contents but we are alive and not in the ' +
                       'Underworld — the server most likely renumbered ids in a save. Re-login to ' +
                       'resolve a fresh id; do NOT treat this as death.' };
      }
      if (!c.room.objects.has(foe.id)) { killed = true; break; }
    }

    if (weaponLoss) {
      const hpAfterBreak = pct(res.vitals?.health ?? c.vitals()?.health);
      disengaged = {
        ...weaponLoss,
        at_health: Number.isFinite(hpAfterBreak)
          ? Math.round(hpAfterBreak * 100) + '%' : 'unknown',
        ...(res.aborted ? { mid_round: true, after_swing: res.aborted.swing } : {}),
      };
      say('disengaged unarmed', {
        target: foeName, at_health: disengaged.at_health, reason: disengaged.reason,
      });
      break;
    }

    // Mid-round abort first: attackRounds now watches health between swings, so this
    // is usually already decided by the time we get here — and decided seconds sooner.
    if (res.aborted) {
      disengaged = { at_health: Math.round(res.aborted.at_health * 100) + '%',
                     mid_round: true, after_swing: res.aborted.swing };
      break;
    }
    const v = c.vitals();
    const hp = pct(v.health);
    if (hp !== null && hp < disengageAt) {
      disengaged = { at_health: Math.round(hp * 100) + '%' };
      break;
    }
  }

  await s.pacer.submit('read', () => c.stats(1));
  await c.waitFor({ kinds: ['stat'], timeoutMs: 2000 });
  const after = c.vitals();
  const landed = landedHitSummary(combatLines, foeName);

  const out = {
    fought: true, target: foeName, killed, rounds: roundsFought,
    // Stable even when killed (foe_id deliberately becomes null on a kill). Callers that
    // monitor one exact pull need to know which object actually made contact.
    target_id: foe.id,
    landed_hits: landed.hits,
    damage_dealt: landed.damage,
    health: { before: before.health, after: after.health },
    // Worth saying out loud: it means a round went nowhere, and it means whatever sat
    // this character down is not doing so again by itself.
    ...(stoodUp ? { stood_up: 'the first round was refused — we were resting' } : {}),
    ...(weaponLoss ? { weapon_loss: weaponLoss } : {}),
    combat: combatLines.slice(-10),
    // Pass this back as preferId next time. A wounded creature we walk away from is
    // both credit we have already earned and a monster that will heal if left, so
    // the caller needs to be able to name it rather than re-pick the nearest.
    foe_id: killed ? null : foe.id,
    log,
  };

  if (disengaged) {
    out.disengaged = disengaged;
    out.held_position = holdPosition || undefined;
    // The advice inverts inside a safe spot, and getting it the wrong way round is
    // fatal. Out in the open, walking away is what stops the damage. In a safe spot,
    // walking away is what STARTS it: nothing can land a blow while you stand still
    // and do not swing, so the recovery move is to sit down where you are.
    out.note = disengaged.unarmed
      ? `${disengaged.reason}. No further attack was sent. The monster already engaged in ` +
        'this fight is still present and hostile even at a held wall; leave its reach before ' +
        'attempting recovery or re-arming.'
      : holdPosition
      ? `broke off at ${disengaged.at_health} health while holding a safe spot. Do NOT walk away — ` +
        `rest where you stand. Nothing can hit you here unless you swing first, so this is a ` +
        `free heal back to full and then the fight again from the top.`
      : `broke off at ${disengaged.at_health} health. The monster is still there and still hostile — ` +
        `walk away before resting, or it will keep hitting you.`;
    return out;
  }
  if (drifted) {
    out.drifted_out_of_reach = drifted;
    out.note = `it moved out of reach (${drifted.distance} squares) and we are holding position. ` +
               `Pull it back or wait — chasing it is what the spot is for not doing.`;
    return out;
  }
  if (!killed) {
    out.note = `still alive after ${roundsFought} rounds. Either it is too strong, or your attacks are missing — ` +
               `check the combat lines: "too far away" means the geometry moved you, "avoids/dodges" means you are just unlucky.`;
    return out;
  }

  if (loot) {
    const l = await s.lootFloor({ stayPut: holdPosition });
    out.looted = l.taken;
    out.refused = l.refused?.length ? l.refused : undefined;
    out.carrying = l.carrying;
  }
  return out;
}

// ---------------------------------------------------------------- escaping

// Getting out of the Underworld, which is where you wake up after dying and which has
// no exits in the room graph at all.
//
// Six teleporters, and the difference between them is the whole of this function:
//
//   FIVE FIXED PORTALS in a pentagram, each with a destination hard-coded at room
//   construction (uworld.kod:649-662). One or two are unlit at random (ResetPuzzle,
//   uworld.kod:460) and an unlit one is SILENT — Portal.SomethingMoved returns
//   immediately when it is not animating — so a dead portal and a portal you never
//   reached look identical unless you check which happened.
//
//   ONE SHIFTING PORTAL, the "rip in space", re-rolling every 5-10 seconds among the
//   same five inns and only saying where it leads if you LOOK at it.
//
// THIS USED TO ONLY KNOW ABOUT THE RIP. Asking for a named city meant standing beside
// the anomaly polling it for up to three minutes — while a portal that goes to that
// city every time, without waiting, stood a few squares away. Now a named city walks
// to its own portal, and the rip is the fallback rather than the plan.
//
// The tables, the descriptions and the nearest-city graph live in m59-underworld.mjs.
export { RIP_DESTINATIONS, readRipDestination, UNDERWORLD_PORTALS, nearestCity,
         citiesByDistance, CITY_INNS, KOCATAN_IS_DEATH_ONLY } from './m59-underworld.mjs';

// Which teleporters in this room are which. The rip announces itself by name, so it
// costs nothing; the fixed ones have to be looked at, and each look is a request out of
// a budget of five a second — so they are looked at in the order most likely to end the
// search, not all of them up front.
async function identifyPortals(s, found, { want = null, maxLooks = 6 } = {}) {
  const c = s.need();
  const rows = found.map(o => {
    const name = c.rsc.get(o.nameRsc) || '';
    const expected = UW.UNDERWORLD_PORTALS.find(
      p => p.clientCol === o.col && p.clientRow === o.row) ?? null;
    return { o, name, rip: UW.RIP_NAME.test(name), expected, city: null, desc: null };
  });

  // The rip needs no look to be identified, and looking at it here would be wasted —
  // its answer expires in seconds and is only useful immediately before stepping on.
  const toLook = rows.filter(r => !r.rip);

  // Best first: the portal whose square matches the one we want, then everything else
  // by how far it is to walk. The coordinates are only a hint — the description is what
  // decides — but a hint that is right most of the time saves four looks.
  toLook.sort((a, b) => {
    const aw = a.expected?.city === want ? 0 : 1;
    const bw = b.expected?.city === want ? 0 : 1;
    if (aw !== bw) return aw - bw;
    const ar = s.world?.reach?.(a.o.col, a.o.row)?.steps ?? 99;
    const br = s.world?.reach?.(b.o.col, b.o.row)?.steps ?? 99;
    return ar - br;
  });

  let looks = 0;
  for (const r of toLook) {
    if (looks >= maxLooks) break;
    looks++;
    const before = c.evSeq;
    await s.pacer.submit('look', () => c.look(r.o.id));
    const ev = await c.waitFor({ since: before, kinds: ['look'], timeoutMs: 3000 });
    r.desc = ev.events.find(e => e.id === r.o.id)?.description || '';
    const sign = UW.readPortalSign(r.desc, r.name);
    r.city = sign.city;
    r.shifting = sign.shifting;
    // A description that reads as the rip's, on an object not named "rip in space".
    // Believe the description: the name can be a resource we failed to resolve.
    if (sign.shifting) r.rip = true;
    if (want && r.city === want && !r.shifting) break;
  }
  return { rows, looked: looks };
}

// Walk onto a teleporter and say whether it fired. Factored out because getting the
// bookkeeping wrong here is what produced the two oldest wrong diagnoses in this file:
// a portal that fires on the LAST STEP of the walk reports arrived:false, and a cursor
// taken after the walk looks past the very event it is waiting for.
// WHAT AN ESCAPE WALK MAY SPEND, AND WHY IT IS SO MUCH MORE THAN THE ROUTE.
//
// Everywhere else in this repository a walk budget is "the route plus a little", because
// overspending costs an errand. Here the alternative is a character parked for ever in the
// one room with no graph exits, so the trade runs the other way entirely.
//
// And the route length is not the step count. The Underworld climbs hundreds of units over
// broken ground, every off-plan landing costs a replan and the replan walks again from
// somewhere else — measured, a 43-step route spent 83 steps and still had not arrived.
// Three times the route plus sixty is generous on purpose; it is bounded, and the walk
// still stops the moment it gets there.
const escapeBudget = steps => Math.max(150, (steps ?? 0) * 3 + 60);

// WHEN COARSE PATHING CANNOT PUT US ON A PORTAL, TRY FINE BEFORE BELIEVING IT.
//
// `leaveVia` has made this argument for `go` exits since the Marion crypt trapped six
// characters for half an hour: the square grid is one byte per square and the world under
// it is BSP at 64 fine units, so anything narrower than a square — or, here, anything
// whose height profile the offline predicate models differently from the live validator —
// reads as unreachable while stepping there in fine units works first time.
//
// The Underworld is where that matters most, because it is the ONE room in the world with
// no graph exits: a character that cannot reach a teleporter is not delayed, it is parked
// there until a human notices. Measured on the arena fleet, a keeper made ten consecutive
// escape attempts, every portal reporting "never got onto its square (kept ending up
// somewhere other than the planned square)" — while the offline router planned clean
// 50- and 65-step routes to two of them in which every step was one the mover accepts.
// The plan was right and the walk diverged, which is exactly the case fine movement
// exists to rescue.
//
// One extra attempt against a permanent trap. col/row are 1-based KOD squares in
// public (col,row) order; the fine fallback converts their centre to protocol x/y
// at 64 units per square.
async function walkOntoSquare(s, col, row, { maxSteps = 80 } = {}) {
  const walk = await s.walkTo(col, row, { maxSteps });
  if (walk.arrived || isTerminalMovementReason(walk.reason)) return walk;
  // A session that cannot walk in fine units simply reports what the coarse walk said —
  // this is a rescue, never a requirement.
  if (typeof s.walkFine !== 'function') return walk;
  const half = KOD_FINENESS >> 1;
  const fine = await s.walkFine(col * KOD_FINENESS + half, row * KOD_FINENESS + half,
                                { maxSteps }).catch(() => null);
  if (fine?.arrived) return { ...fine, via: 'fine movement after coarse pathing failed' };
  return walk;
}

async function stepOnto(s, o) {
  const c = s.need();
  const before = c.evSeq;
  const wasIn = c.room.id;
  const walk = await walkOntoSquare(s, o.col, o.row,
                                    { maxSteps: escapeBudget(s.world?.reach?.(o.col, o.row)?.steps) });
  const arr = await c.waitFor({ since: before, kinds: ['room-entered'],
                                timeoutMs: walk.arrived ? 3000 : 500 });
  const entered = arr.events.find(e => e.kind === 'room-entered');
  const now = { id: c.room.id, name: c.roomNameRsc ? c.rsc.get(c.roomNameRsc) : null };
  if (entered || now.id !== wasIn)
    return { left: true, arrived_in: entered?.roomName ?? now.name, room: now.id };
  if (isTerminalMovementReason(walk.reason))
    return { left: false, terminal: true, reason: walk.reason, note: walk.note,
             why: walk.note ?? walk.reason };
  return { left: false, walked: walk.arrived,
           why: walk.arrived
             ? 'stood on it and nothing happened — it is unlit; one or two of the five ' +
               'are, at random, and its brazier needs activating'
             : `never got onto its square (${walk.reason || walk.note || 'the walk did not arrive'})` };
}

// THE RIP IS THE ONE DOOR THAT IS NEVER UNLIT, SO IT IS THE ONE TO FALL BACK ON.
//
// `ResetPuzzle` (uworld.kod:460) lights all five pentagram portals and then turns one or
// two off at random. The rip is not in that rotation at all — it is a sixth teleporter
// that re-rolls its DESTINATION every 5-10s (hellport.kod:57,70) and is always open. So
// when every fixed portal has been tried and the character is still down here, the rip is
// not one more thing to try: it is the thing that works.
//
// ANY DESTINATION WILL DO, and that is the whole point of this path. Reading the rip
// matters only when a particular city was asked for; when the alternative is another
// spell in the Underworld, all five inns are the same answer — out. So this never looks,
// it steps.
//
// AND IT RETRIES, because a single step is not evidence. The rip re-rolls every 5-10
// seconds and a step that lands mid-roll does nothing at all — which the fallback loop
// below reports as "probably unlit; its brazier needs activating", a diagnosis that is
// simply never true of this object and sends the caller hunting for a brazier that does
// not exist.
async function ripOut(s, rip, { maxSeconds = 60 } = {}) {
  const c = s.need();
  // Stand next to it first. Stepping onto it IS the teleport, so the approach has to be
  // its own walk or a failure to arrive reads as a portal that did not fire.
  const spot = s.world.approachSquare(rip.col, rip.row);
  if (spot && spot.steps > 0) {
    const walk = await walkOntoSquare(s, spot.col, spot.row, { maxSteps: escapeBudget(spot.steps) });
    if (isTerminalMovementReason(walk.reason))
      return { left: false, terminal: true, reason: walk.reason, note: walk.note };
    if (!walk.arrived)
      return { left: false, why: 'could not get next to the rip in space (' +
                                 (walk.reason || walk.note || 'the walk did not arrive') + ')' };
  }
  const t0 = Date.now();
  let attempts = 0;
  while (Date.now() - t0 < maxSeconds * 1000) {
    attempts++;
    const before = c.evSeq;
    const wasIn = c.room.id;
    const move = await s.stepFine(rip.x, rip.y);
    if (isTerminalMovementReason(move.reason))
      return { left: false, terminal: true, reason: move.reason, note: move.note, attempts };
    const arr = await c.waitFor({ since: before, kinds: ['room-entered'], timeoutMs: 3000 });
    const entered = arr.events.find(e => e.kind === 'room-entered');
    const now = { id: c.room.id, name: c.roomNameRsc ? c.rsc.get(c.roomNameRsc) : null };
    if (entered || now.id !== wasIn)
      return { left: true, arrived_in: entered?.roomName ?? now.name, room: now.id, attempts };
    await sleep(1200);
  }
  return { left: false, attempts,
           why: `stepped onto the rip ${attempts} time(s) over ${maxSeconds}s and stayed put` };
}

export async function escapeUnderworld(s, { city = null, nearestTo = null,
                                            maxSeconds = 180, allowRip = true } = {}) {
  const c = s.need();
  const portals = () => [...c.room.objects.values()].filter(o => isTeleporter(o.flags));
  // Which room we are in, read from the client rather than from an event: c.room.id and
  // roomNameRsc are both set by the room packet the teleport sends, so this answers "did
  // that work" even when the event that announced it went past while we were walking.
  const whereAmI = () => ({ id: c.room.id, name: c.roomNameRsc ? c.rsc.get(c.roomNameRsc) : null });

  // Before anything is measured, and before a single step is taken: a character killed
  // mid-rest wakes up here still sitting, and a resting character's moves are bounced in
  // silence, so every portal in the pentagram would read as unlit. See standUp.
  await standUp(s);

  await s.pacer.submit('read', () => c.roomContents());
  await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 });
  const here = s.world?.room;
  const found = portals();
  if (!found.length)
    return { left: false, stood_up: true, reason: 'no teleporter in this room', room: here?.name };

  // WHICH CITY. An explicit one wins; otherwise, if the caller said where the character
  // died, the answer is almost always "put me back nearest to that" — the corpse and
  // everything it was carrying is lying there, and the walk back is the real cost of
  // dying. See m59-underworld.mjs for how the distance is worked out.
  let wanted = city ?? null, chosenBecause = city ? 'asked for' : null;
  let near = null;
  if (!wanted && nearestTo != null) {
    near = UW.nearestCity(nearestTo);
    if (near.city) { wanted = near.city; chosenBecause = `nearest to where it died (${near.hops} rooms)`; }
  }

  // The shifting one describes a destination; the fixed ones do not.
  const rip = found.find(o => UW.RIP_NAME.test(c.rsc.get(o.nameRsc) || ''));

  // ---- a named city: walk to its own portal, which goes there every time ----
  const cityAttempts = [];
  if (wanted && found.length > (rip ? 1 : 0)) {
    const { rows } = await identifyPortals(s, found, { want: wanted });
    const match = rows.find(r => !r.rip && r.city
                                 && r.city.toLowerCase() === String(wanted).toLowerCase());
    if (match) {
      const step = await stepOnto(s, match.o);
      if (step.left)
        return { left: true, stood_up: true, arrived_in: step.arrived_in, room: step.room,
                 wanted, city: wanted, chosen_because: chosenBecause,
                 via: `the fixed ${wanted} portal`,
                 ...(near ? { died_in_room: nearestTo, hops_from_death: near.hops } : {}),
                 note: 'a fixed portal, so this is repeatable — no waiting and no luck involved' };
      if (step.terminal)
        return { left: false, stood_up: true, reason: step.reason, note: step.note };
      cityAttempts.push({ portal: `fixed ${wanted}`, why: step.why });
    } else {
      cityAttempts.push({
        portal: `fixed ${wanted}`,
        why: rows.some(r => r.desc)
          ? `no portal here reads as ${wanted} — saw ` +
            JSON.stringify(rows.filter(r => !r.rip).map(r => r.city ?? 'unreadable'))
          : 'could not read any portal description',
      });
    }
  }

  // Ko'catan is not in the pentagram at all, so there was never a fixed portal to try.
  if (wanted && String(wanted).toLowerCase().startsWith("ko") && !UW.portalFor(wanted))
    cityAttempts.push({ portal: "fixed Ko'catan", why: UW.KOCATAN_IS_DEATH_ONLY });

  let ripUnreachable = false;
  if (wanted && rip && allowRip) {
    // Stand next to it FIRST. The window is 5-10 seconds and walking is a second a
    // square, so polling from across the room means reading a destination you can no
    // longer reach in time.
    const spot = s.world.approachSquare(rip.col, rip.row);
    if (spot && spot.steps > 0) {
      const walk = await walkOntoSquare(s, spot.col, spot.row,
                                        { maxSteps: escapeBudget(spot.steps) });
      if (isTerminalMovementReason(walk.reason))
        return { left: false, stood_up: true, reason: walk.reason, note: walk.note };
      // ONE PORTAL WE CANNOT WALK TO IS NOT A ROOM WE CANNOT LEAVE.
      //
      // This used to RETURN here, and that single line is why characters sat in the
      // Underworld indefinitely. There are SIX teleporters; failing to reach the one that
      // happens to be shifting says nothing about the other five, and the loop below tries
      // every reachable one in order for exactly that reason. Measured on the arena fleet:
      // a keeper made ten consecutive attempts, each one ending here with "could not get
      // next to the shifting portal", while three fixed portals stood reachable — it never
      // reached the code that would have walked to them.
      //
      // The Underworld is the one room in the world with NO graph exits, so an escape that
      // gives up is a character parked there until somebody notices. Fall through, and let
      // the ordered attempt on every reachable teleporter have its turn.
      if (!walk.arrived) {
        cityAttempts.push({ portal: 'rip in space',
                            why: `could not get next to it (${walk.reason || walk.note ||
                                  'the walk did not arrive'}) — trying the fixed portals` });
        ripUnreachable = true;
      }
    }
    // DECLARED OUTSIDE THE BLOCK BECAUSE THE FALL-THROUGH BELOW REPORTS IT. Scoping it to
    // the polling block made `seen` a ReferenceError on the path where the rip could not be
    // reached — which is the exact path this change exists to open, so every escape attempt
    // died with "pass failed: seen is not defined" instead of trying the fixed portals.
    const seen = [];
    const t0 = Date.now();
    // The condition lives on the loop rather than in a wrapper block, so that everything
    // below stays in one scope: `seen` is reported by the fall-through after it, and
    // scoping it into a block made it a ReferenceError on exactly the path this change
    // exists to open — every escape attempt died "pass failed: seen is not defined"
    // instead of going on to try the fixed portals.
    while (!ripUnreachable && Date.now() - t0 < maxSeconds * 1000) {
      const b = c.evSeq;
      await s.pacer.submit('look', () => c.look(rip.id));
      const ev = await c.waitFor({ since: b, kinds: ['look'], timeoutMs: 3000 });
      const desc = ev.events.find(e => e.id === rip.id)?.description || '';
      const dest = UW.readRipDestination(desc);
      if (dest) seen.push(dest);
      if (dest && dest.toLowerCase().includes(String(wanted).toLowerCase())) {
        const before = c.evSeq;
        const wasIn = c.room.id;
        const move = await s.stepFine(rip.x, rip.y);
        if (isTerminalMovementReason(move.reason))
          return { left: false, stood_up: true, reason: move.reason, note: move.note };
        const arr = await c.waitFor({ since: before, kinds: ['room-entered'], timeoutMs: 5000 });
        const entered = arr.events.find(e => e.kind === 'room-entered');
        const now = whereAmI();
        return (entered || now.id !== wasIn)
          ? { left: true, stood_up: true, arrived_in: entered?.roomName ?? now.name,
              wanted, city: wanted, chosen_because: chosenBecause, via: 'the rip in space',
              ...(near ? { died_in_room: nearestTo, hops_from_death: near.hops } : {}),
              ...(cityAttempts.length ? { fixed_portal_first: cityAttempts } : {}), saw: seen }
          : { left: false, stood_up: true,
              reason: 'stepped on it as it read right, but nothing happened — it may have swapped first',
              saw: seen, note: 'try again; the window is 5-10 seconds and unknown which' };
      }
      await sleep(1200);
    }
    // Out of patience on the rip. Do NOT stop here — the caller wanted OUT, and a city
    // it did not ask for is enormously better than another spell in the Underworld.
    // Fall through to the nearest working portal, and say plainly that the city was not
    // the one wanted so the walk back is not a surprise.
    cityAttempts.push({ portal: 'rip in space', why: `never showed ${wanted} in ${maxSeconds}s; saw ` +
                                                     JSON.stringify(seen) });
  }

  // No preference, or the preference could not be had: take whichever teleporter is
  // closest and actually works. One or two of the pentagram are unlit at random and an
  // unlit one is silent, so try in order rather than trusting any single portal.
  const reachable = found
    .map(o => ({ o, r: s.world.reach(o.col, o.row) }))
    .filter(x => x.r.reachable)
    .sort((a, b) => a.r.steps - b.r.steps);
  const tried = [];
  for (const { o, r: reach } of reachable) {
    const name = c.rsc.get(o.nameRsc);
    // Both markers go up BEFORE the walk. Stepping onto a live portal is itself the
    // last step of the walk, so the room packet can arrive while walkTo is still in
    // its loop — and a cursor taken afterwards looks past the very event it is for.
    const before = c.evSeq;
    const wasIn = c.room.id;
    // BUDGET BY THE ROUTE, NEVER BY A FIXED CAP — `leaveVia` learned this and the
    // Underworld is where it bites hardest. Its portals are 50 and 65 planned steps from
    // the lower floor, so a flat 80 is spent by the first handful of off-plan landings and
    // the walk reports "stopped after 80 steps" about a portal it was walking straight at.
    // Measured: with the cap, every attempt failed that way while the router had a clean
    // route to two of them.
    const walk = await walkOntoSquare(s, o.col, o.row,
                                      { maxSteps: escapeBudget(reach?.steps) });
    const arr = await c.waitFor({ since: before, kinds: ['room-entered'], timeoutMs: walk.arrived ? 3000 : 500 });
    const entered = arr.events.find(e => e.kind === 'room-entered');
    const now = whereAmI();
    // A walk that "failed" because it left the room is the walk that worked.
    if (entered || now.id !== wasIn) {
      const arrivedIn = entered?.roomName ?? now.name;
      // Which city we ACTUALLY came out in, so a caller that asked for one and got
      // another finds out here rather than after walking the wrong way for ten minutes.
      const landed = Object.entries(UW.CITY_INNS)
        .find(([, v]) => v.inn === now.id || (arrivedIn && v.innName === arrivedIn))?.[0] ?? null;
      return { left: true, stood_up: true, arrived_in: arrivedIn, room: now.id, via: name,
               ...(landed ? { city: landed } : {}), tried,
               ...(wanted ? {
                 wanted, chosen_because: chosenBecause,
                 got_what_was_wanted: landed === wanted,
                 ...(cityAttempts.length ? { could_not_use: cityAttempts } : {}),
                 ...(landed && landed !== wanted ? {
                   note: `OUT, but in ${landed} rather than ${wanted}. The corpse and everything ` +
                         `it was carrying is still where it died; check the walk before setting off.`,
                 } : {}),
               } : {}) };
    }
    if (isTerminalMovementReason(walk.reason))
      return { left: false, stood_up: true, reason: walk.reason, note: walk.note, tried };
    // Only blame the brazier if we actually got onto the square. Not arriving is a
    // different fault with a different fix, and reporting it as an unlit portal sends
    // the caller hunting for something to activate that was never the problem.
    tried.push({ name, why: walk.arrived
      ? 'stood on it and nothing happened — probably unlit; its brazier needs activating'
      : `never got onto its square (${walk.reason || walk.note || 'the walk did not arrive'})` });
  }
  // NOT OUT YET — TAKE THE RIP, WHEREVER IT HAPPENS TO GO.
  //
  // Everything above either wanted a particular city or trusted the pentagram, and the
  // pentagram is exactly what is unreliable: one or two are unlit at random and an unlit
  // one is silent. Measured on the arena fleet, a character sat in the Underworld
  // reporting "none of the teleporters here worked" while the rip stood open the whole
  // time, because the rip is only polled when a city was ASKED for.
  //
  // A city nobody chose beats another hour down here, and the caller is told plainly
  // which one it got so the walk back is not a surprise. This runs LAST so it can never
  // take a character somewhere arbitrary while a portal to the right place was available.
  if (rip && allowRip) {
    const out = await ripOut(s, rip, { maxSeconds: Math.max(20, Math.min(60, maxSeconds)) });
    if (out.left) {
      const landed = Object.entries(UW.CITY_INNS)
        .find(([, v]) => v.inn === out.room || (out.arrived_in && v.innName === out.arrived_in))?.[0] ?? null;
      return { left: true, stood_up: true, arrived_in: out.arrived_in, room: out.room,
               via: 'the rip in space', attempts: out.attempts, tried,
               ...(landed ? { city: landed } : {}),
               ...(wanted ? { wanted, chosen_because: chosenBecause,
                              got_what_was_wanted: landed === wanted,
                              ...(cityAttempts.length ? { could_not_use: cityAttempts } : {}) } : {}),
               note: 'the pentagram would not answer, so this took the shifting portal to ' +
                     (landed ?? 'whichever inn it was pointing at') + '. Out is out; the corpse ' +
                     'and everything it was carrying is still where it died.' };
    }
    if (out.terminal)
      return { left: false, stood_up: true, reason: out.reason, note: out.note, tried };
    tried.push({ name: 'the rip in space', why: out.why });
  }

  return { left: false, stood_up: true, reason: 'none of the teleporters here worked', tried,
           ...(wanted ? { wanted, could_not_use: cityAttempts } : {}),
           note: tried.some(t => /never got onto/.test(t.why))
             ? 'at least one was never reached, so this is not evidence that the portals are dead — ' +
               'we stood up before walking, so it is not resting either; check the route'
             : 'one or two of the five pentagram portals are unlit at random and an unlit one is ' +
               'silent (uworld.kod:460). If EVERY one is dead, look for the braziers — objects ' +
               'with "activate" — or wait for the room to reset, which it does when empty.' };
}

// ---------------------------------------------------------------- commerce

// SHOULD THIS ONE THING GO TO THE COUNTER? Four rules in a fixed order, pulled out as a
// pure function because it is the decision that can lose a character its armour, and
// because "which rule won" is the only useful thing to say when it gets one wrong.
//
// The order is the whole design:
//
//   1. WORN BEATS EVERYTHING. plUsing is the server's own answer, so nothing named on any
//      list can sell the shield off your arm. This used to be an empty Set that was never
//      filled, which made the guard decorative.
//   2. THE LOADOUT'S FLOOR. Counted against the pack, so a floor of twelve protects twelve
//      elderberry and releases the thirteenth.
//   3. THE LOADOUT'S SELL LIST, which beats the name guards below. Those protect anything
//      that LOOKS like equipment or money — right by default, and the reason a character
//      carrying fifty-six sapphires it will never cast with could not shed them without
//      editing a regex shared by twenty-one characters.
//   4. THE NAME GUARDS, as before, for everything nobody has said anything about.
//
// A null loadout skips 2 and 3 entirely, which is what makes this an overlay: the answer
// for a character with no loadout is the answer this function has always given.
// WHO IT IS SAFE TO SELL TO, and why this is an allowlist rather than a check.
//
// `buys_anything: true` in the merchant index, and the `buy` affordance on the object,
// both report a real property of the NPC and neither means it will pay you. Three kinds
// of NPC answer to "buys anything" and only one of them is a merchant:
//
//   THE SCAM.  Most of them. Skivlat the Tos banker is the type: hand him goods and he
//              takes them, thanks you, and gives nothing back. It is a trick played on
//              new players, and the flags cannot tell it from a sale.
//   THE VAULT. Two of them, one on the mainland (Barloque) and one on the island. They
//              "buy" anything and sell it back for about a shilling — they are STORAGE,
//              not a market, and storage that survives death, which is the only thing in
//              the game that does. Worth using deliberately (see the note in CLAUDE.md);
//              never worth selling into by accident.
//   THE REAL ONE. Roq, the only NPC known to buy an unlimited quantity of anything.
//              Izzio and the island vendor are close to it with rules of their own.
//
// So: an allowlist, and everything else is left alone. Being wrong about a buyer costs
// the whole pack; being wrong about a walk costs a walk.
export const SELL_TO = [
  /\broq\b/i,          // buys anything, unlimited — the one real general buyer
  /\bizzio\b/i,        // close to it, with rules of its own
  /herbutte/i,         // Sparkling Stone Shop, Barloque — gems. Verified: paid 856.
  /joguer/i,           // Joguer's Herbs and Roots, Barloque — mushrooms, herbs, elderberry
  /quintor/i,          // Quintor's Smithy, Jasper — weapons and armour
  /paddock|solomon|pietro/i,   // inns and grocers we have traded with
];
// NEVER. Named separately from "not on the allowlist" because these actively take goods.
export const NEVER_SELL_TO = [
  /skivlat|yevitan|setag|huital/i,   // bankers: they take it and thank you
  /vault/i,                          // the two vaults: storage, and they resell at ~1sh
];
// Body armour only — a shield is not what keeps a character alive here (leather is +50
// defense against a shield's 5 or 10), and shields are the piece the fleet has spares of.
export const ARMOUR_BODY = /leather armor|chain mail|scale armor|plate armor|breastplate|\barmor\b|\barmour\b/i;

export const trustedBuyer = (name) => {
  const n = String(name || '');
  if (!n || NEVER_SELL_TO.some(re => re.test(n))) return false;
  return SELL_TO.some(re => re.test(n));
};

export function sellable({ name, worn, keepRe, loadout = null, pack = [], armoured = true }) {
  if (worn) return { sell: false, why: 'the server lists it as worn or wielded' };
  // NEVER SELL THE ARMOUR YOU ARE NOT WEARING IF YOU ARE NOT WEARING ANY.
  //
  // `worn` protects what is ON the character, and everything else read as a spare — so a
  // character that salvaged leather, failed to put it on, and then made a town trip sold
  // the very thing it needed. Beaker did exactly that: picked two leathers off a corpse
  // field, wear_best was refused with no message, and the next trip turned both into
  // coin, leaving it unarmoured with 3,495 in the bank.
  //
  // A refusal to wear is not proof the piece is worthless — the broken message is
  // distinct and is condemned separately. Until this character is wearing SOMETHING, its
  // spare armour is not spare.
  if (!armoured && ARMOUR_BODY.test(name)) {
    return { sell: false, why: 'this character has no body armour on, so this is not a spare' };
  }
  const mustKeep = keepTestFor(loadout, pack);
  const kept = mustKeep?.(name);
  if (kept) return { sell: false, why: `this character's loadout: ${kept}` };
  const mustSell = sellTestFor(loadout);
  if (mustSell?.(name)) return { sell: true, why: 'this character\'s loadout puts it on the sell list' };
  if (keepRe.test(name)) return { sell: false, why: 'the keep list' };
  if (weaponScore(name) > 0) return { sell: false, why: 'it is a weapon' };
  return { sell: true, why: 'nothing protects it' };
}

// WHICH EQUIPMENT EARNS A PLACE BACK OUT OF TOWN.
//
// This is identity-based, not name-based. A loadout saying "mace" used to protect every
// mace in the pack, so a character could arrive with six and leave with six. The same
// happened to spare armour: if no body piece was equipped, every body piece was kept.
// A merchant trip is the point at which those duplicates should become money.
//
// Equipped objects are untouchable. `maxWeapons` counts them, then the remaining places
// go to the best sound weapons under the active priority. Armour gets one carried piece
// only when that slot is currently empty; once a slot is filled, its unworn pieces are
// surplus. If the client cannot provide the server's equipment set, this declines to
// force any equipment sale rather than guessing which object is in use.
export function merchantEquipmentPlan(c, { maxWeapons = null, weaponPriority = null } = {}) {
  const equipped = equippedNow(c);
  const keep = new Map(), sell = new Map();
  if (!equipped) return { keep, sell, verified: false };

  const pack = (c.inventory || []).map(o => ({ o, name: c.rsc.get(o.nameRsc) || '' }));
  const weapons = pack.filter(x => weaponScore(x.name) > 0);
  const equippedWeapons = weapons.filter(x => equipped.has(x.o.id));
  for (const x of equippedWeapons) keep.set(x.o.id, 'equipped weapon');

  if (Number.isFinite(maxWeapons)) {
    const limit = Math.max(0, Math.floor(maxWeapons));
    const places = Math.max(0, limit - equippedWeapons.length);
    const ranked = weaponRanking(c, { priority: weaponPriority })
      .filter(x => !equipped.has(x.o.id));
    for (const x of ranked.slice(0, places)) keep.set(x.o.id, 'best spare weapon within max_weapons');
    for (const x of weapons) {
      if (!equipped.has(x.o.id) && !keep.has(x.o.id))
        sell.set(x.o.id, `weapon beyond max_weapons=${limit}`);
    }
  } else {
    for (const x of weapons) keep.set(x.o.id, 'no weapon limit is configured');
  }

  const soundArmour = armourOf(c);
  for (const slot of ARMOUR_SLOTS) {
    const all = pack.filter(x => armourKind(x.name)?.slot === slot);
    const worn = all.filter(x => equipped.has(x.o.id));
    for (const x of worn) keep.set(x.o.id, `equipped ${slot}`);
    // An empty slot needs one usable future piece. armourOf excludes gear already known
    // broken and ranks the rest by the same score wearBest uses.
    if (!worn.length) {
      const future = soundArmour[slot]?.find(x => !equipped.has(x.o.id));
      if (future) keep.set(future.o.id, `best ${slot} available for the empty slot`);
    }
    for (const x of all) {
      if (!equipped.has(x.o.id) && !keep.has(x.o.id))
        sell.set(x.o.id, worn.length ? `spare ${slot}; that slot is already equipped`
                                    : `surplus or unusable ${slot}`);
    }
  }
  return { keep, sell, verified: true };
}

// Sell everything a merchant will take, keeping what you are using.
//
// `loadout` is this character's own list, or null. See `sellable` above for the order the
// rules apply in and why. A caller that passes null gets the behaviour this function has
// always had, which is what every existing caller relies on.
export async function sellAll(s, { merchant, keep = [], protect = [], minPrice = 1,
                                   loadout = null, maxWeapons = null,
                                   weaponPriority = null } = {}) {
  const c = s.need();
  await s.pacer.submit('read', () => c.requestInventory());
  await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });

  const keepRe = new RegExp([...keep, 'shilling', 'coin'].join('|'), 'i');
  // ANYTHING WE ARE WEARING IS NOT FOR SALE. This set used to be constructed empty and
  // never filled, so the guard below was decorative: the armour on your back and the
  // ring on your finger were as sellable as a rat pelt, protected only by whether their
  // names happened to match `keep`. It is the server's use list now, so it is right by
  // construction rather than by a name pattern somebody has to maintain.
  const wielded = equippedNow(c) ?? new Set();
  const pack = c.inventory.map(o => ({ o, name: c.rsc.get(o.nameRsc) }));

  // Is this character wearing body armour at all? If not, nothing armour-shaped in the
  // pack counts as a spare — see sellable.
  const armoured = pack.some(x => wielded.has(x.o.id) && ARMOUR_BODY.test(x.name) && !/shield/i.test(x.name));

  const equipment = merchantEquipmentPlan(c, { maxWeapons, weaponPriority });

  let items = pack.filter(x => equipment.sell.has(x.o.id) ||
    (!equipment.keep.has(x.o.id) && sellable({
      name: x.name, worn: wielded.has(x.o.id), keepRe, loadout, armoured,
      pack: pack.map(y => ({ name: y.name, amount: y.o.amount || 1 })),
    }).sell));
  items = items.filter(x => !itemIsProtected(x.name, protect));

  // DO NOT SELL WHAT A CRewMATE IS SHORT OF. The merchant buys low and sells high, so
  // this round trip costs the fleet twice over, and the thing being round-tripped is
  // usually the reagent that decides whether somebody can eat.
  const held = [];
  items = items.filter(x => {
    // max_weapons and the armour slot rules are hard pack limits. A fleetmate's broad
    // equipment interest must not turn one character back into the fleet warehouse.
    if (equipment.sell.has(x.o.id)) return true;
    if (!interest.anyoneWants(x.name, { except: s.name })) return true;
    held.push({ name: x.name, wanted_by: interest.wantedBy(x.name, { except: s.name }) });
    return false;
  });

  // DO NOT OFFER A SMITH A MUSHROOM. Every merchant class declares what it deals in
  // (`ObjectDesired`), a refusal is a sentence spoken to the room rather than an error,
  // and each wasted offer costs a full offer/cancel round trip plus 900ms of pacing —
  // so a trip to a smith carrying reagents used to collect a column of silences with the
  // one real sale buried in it. `m59-buyers.mjs` holds the table and its citations.
  //
  // IT ONLY EVER HOLDS THINGS BACK. An unknown merchant class, or an item missing from
  // the index, answers "cannot say" and is offered exactly as before — silence means the
  // behaviour that was already there, never a seller that has stopped selling.
  const merchantId = typeof merchant === 'object' && merchant !== null ? merchant.id : merchant;
  const merchantObj = c.room?.objects?.get?.(Number(merchantId)) ?? null;
  const merchantName = (typeof merchant === 'object' && merchant?.name) ||
    (merchantObj ? c.rsc.get(merchantObj.nameRsc) : null);
  const plan = buyers.partition(items.map(x => ({ ...x, name: x.name })),
    { id: Number(merchantId), name: merchantName, index: merchantIndex() });
  const notOffered = plan.not_offered;
  items = plan.offer;

  if (!items.length) return { sold: [], kept_for_the_fleet: held,
    ...(notOffered.length ? { not_offered: notOffered, merchant: plan.merchant } : {}),
    ...(loadout ? { loadout: loadout.character } : {}),
    note: notOffered.length
      ? `nothing here that ${plan.merchant.class || 'this merchant'} deals in — it buys ` +
        `${plan.merchant.buys?.join(', ') || 'nothing known'}; ask who_buys for a counter that takes these`
      : held.length
      ? 'nothing left to sell — what is in the pack is either yours to keep or wanted by another character'
      : 'nothing to sell that is not money, equipment you are wearing, or a weapon you are carrying' };

  const sold = [], refused = [];
  let total = 0;
  for (const it of items) {
    const q = await s.sellOne(merchant, it.o, false);
    if (!q.offered_price || q.offered_price < minPrice) {
      refused.push({ name: it.name, why: q.merchant_said?.join(' ') || q.note || 'no price offered' });
      await sleep(900);
      continue;
    }
    const done = await s.sellOne(merchant, it.o, true);
    if (done.sold) { sold.push({ name: it.name, price: q.offered_price }); total += q.offered_price; }
    else refused.push({ name: it.name, why: done.note || 'accept failed' });
    await sleep(900);
  }
  return { sold, refused, total_received: total, kept_for_the_fleet: held,
           merchant: plan.merchant,
           // WHAT WAS NEVER OFFERED, AND WHY. Distinct from `refused`, which is what the
           // merchant turned down after we asked: these were held back before the walk to
           // the counter, so a bot reading this knows the goods are still in the pack and
           // still saleable — somewhere else. `whoBuys` names where.
           ...(notOffered.length ? { not_offered: notOffered } : {}),
           note: refused.length
             ? 'these were offered and refused anyway — a merchant with a real inventory ' +
               'can be full, and condition or stack size can also draw a no'
             : undefined };
}

// Deposit matching inventory into a VAULTMAN in one server transaction. Success is
// established by the post-request inventory delta because this protocol deliberately
// sends no OFFERED/ACCEPT result. A refusal remains visible with the server's messages.
export async function depositInVault(s, { vaultman, items = [] } = {}) {
  const c = s.need();
  const wanted = [...new Set([].concat(items || []).map(String).map(x => x.trim()).filter(Boolean))];
  if (!wanted.length) return { deposited: [], protected: [], reason: 'no protected items configured' };
  await s.pacer.submit('read', () => c.requestInventory());
  await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
  const before = (c.inventory || []).filter(o => itemIsProtected(c.rsc.get(o.nameRsc) || '', wanted));
  if (!before.length) return { deposited: [], protected: wanted, reason: 'none of the protected items are carried' };

  const quantities = new Map(before.map(o => [o.id, o.amount || 1]));
  const names = new Map(before.map(o => [o.id, c.rsc.get(o.nameRsc) || 'unknown item']));
  const specs = before.map(o => o.amount != null ? { id: o.id, amount: o.amount } : o.id);
  const since = c.evSeq;
  await s.pacer.submit('trade', () => c.depositItems(vaultman, specs));
  const response = await c.waitFor({ since, kinds: ['message'], timeoutMs: 2500 })
    .catch(() => ({ events: [] }));
  await s.pacer.submit('read', () => c.requestInventory());
  await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });

  const deposited = [];
  for (const o of before) {
    const left = (c.inventory || []).find(now => now.id === o.id)?.amount ??
      ((c.inventory || []).some(now => now.id === o.id) ? 1 : 0);
    const amount = Math.max(0, (quantities.get(o.id) || 0) - left);
    if (amount) deposited.push({ name: names.get(o.id), amount });
  }
  return {
    deposited,
    protected: wanted,
    refused: before.filter(o => !deposited.some(d => d.name === names.get(o.id)))
      .map(o => names.get(o.id)),
    said: (response.events || []).filter(e => e.text).map(e => e.text).slice(0, 4),
    verified: deposited.length > 0,
  };
}

// ------------------------------------------------------- returning signet rings

// A SIGNET RING IS UP TO 1500 SHILLINGS LYING IN THE PACK, AND ONLY FOR SOME OF US.
//
// Monsters drop them and the fleet hauls them around as loot. They are not loot: each one
// belongs to a named NPC, and handing it back pays the ring's value TEN TIMES OVER to a
// character that has not enabled player-killing, and its plain value to one that has
// (ringsgnt.kod:94, RewardReturner). Statler was carrying six.
//
// WHICH CHARACTER HANDS IT BACK IS WORTH A FACTOR OF TEN, and the fleet was choosing at
// random. The gate is PFLAG_PKILL_ENABLE, and nobody here sets that deliberately —
// EvaluatePKStatus (player.kod:11047) sets it for you the moment
//
//     piBase_Max_health >= PKILL_ENABLE_HP    (30, blakston.khd:2094)
//     OR you join a guild
//     OR you are a murderer or an outlaw
//
// and clears it again if all of those stop being true. Max health IS the level here, so
// in the fleet's own terms: A RING RETURNED BY A CHARACTER UNDER LEVEL 30 PAYS TEN TIMES
// WHAT THE SAME RING PAYS RETURNED BY ANYONE ELSE. The small ones should be holding them.
//
// Two honest caveats on that number. The gate reads piBase_Max_health, which is the
// UNBOOSTED ceiling; `level` on a fleet row is piMax_health, which a potion can lift
// above it temporarily without changing PK status either way. And nothing on the wire
// reports guild membership, so a guilded character under 30 will quietly pay 1x — the
// fleet has no guilds, which is an assumption and not an observation.
//
// AND 1500 IS THE CEILING, NOT THE PRICE. GetValue (item.kod:408) scales viValue_average
// (150, ringsgnt.kod:39) by condition — 100*piHits_init*piHits/viHits_init_max^2, with
// hits rolled into [30,70] against a max of 70 — so a battered ring is worth a fraction of
// a pristine one and the floor is 10. The payout to a newbie is therefore anywhere from
// 100 to 1500, and vbShow_condition is FALSE on this class (:31), so THE CONDITION CANNOT
// BE READ before handing it over. Do not report a predicted figure as though it were the
// price; read what the purse did afterwards.
//
// WHO IT BELONGS TO IS READABLE, which is the part that makes this cheap. The ring
// describes itself as "the family crest of <name>" (ringsgnt.kod:22), so one look names
// the owner.
//
// I SAID THERE WAS NO NPC-LOCATION TABLE TO BUILD AND THAT NONE WOULD HELP BECAUSE THE
// OWNERS WANDER. Three quarters of them do not. CreateSignetRing (library.kod:4245) draws
// the owner at random from the hinter list — MOB_RANDOM|MOB_LISTEN, monster.kod:466 —
// filtered to MOB_RECEIVE, not MOB_NOQUEST, and belonging to one of exactly six classes:
// BarloqueTown, CorNothTown, JasperTown, MarionTown, TosTown, Wanderer. That is nineteen
// NPCs in the whole game, of which FIFTEEN STAND IN A FIXED ROOM IN A TOWN and four are
// Wanderers with no home. So a ring names a destination fifteen times out of nineteen,
// and the fleet was walking past those rooms all day without knowing to stop. The four
// that roam are still handled the old way, by asking wherever we happen to be — which
// remains free, and remains the only thing that can work for them.
//
// AND THEY EXPIRE. The library keeps at most twenty signets in the world; registering a
// twenty-first DELETES THE OLDEST and tells whoever was holding it that it is gone
// (library.kod:4288). Hoarding one is not neutral, it is a decaying asset.
//
// The handover is a trade. Monster.CheckWhyWanted (monster.kod:3994) fires when the ring
// is offered: if it is the right mob it takes it, pays, and says so; if it is the wrong
// one it refuses and NAMES the correct owner, which is a free correction if our reading
// of the description was ever wrong.
const SIGNET_NAME = /signet ring/i;
const SIGNET_CREST = /family crest of ([^.]+)\./i;

// The nineteen. Extracted from the source tree by the filter above and cross-checked
// against the room each one was actually observed in (substrate/m59-merchants.json), so
// `room` is where a character has to walk, not where a class file says it might live.
//
// Two of the nineteen are not in this table at all, and that is the point of checking:
// BarloqueBanker (Setag'lib) and JealousGeneral (Jonas D'Accor) are declared in the kod
// and CREATED BY NOTHING — no room places either — so neither can ever be in the hinter
// list and neither can ever own a ring. A table built from the class filter alone would
// have sent a character to look for them.
//
// `roams: true` means there is no room to walk to. The four Wanderers are made in
// godroom.kod and move; the room they were last seen in is not a destination.
export const SIGNET_OWNERS = {
  // Barloque — barlqtwn/
  "joguer":          { town: 'Barloque', room: 104, where: "Joguer's Herbs and Roots",     is: 'apothecary', kod: 'bqapoth.kod' },
  "meidei":          { town: 'Barloque', room: 103, where: 'The Bhrama & Falcon',          is: 'bartender',  kod: 'bqbart.kod' },
  "pritchett":       { town: 'Barloque', room: 106, where: 'Brownestone Inn',              is: 'innkeeper',  kod: 'bqinnk.kod' },
  "madelia":         { town: 'Barloque', room: 856, where: "Madelia's Fine Peacockeries",  is: 'tailor',     kod: 'bqtailor.kod' },
  // Cor Noth — crnthtwn/
  "solomon":         { town: 'Cor Noth', room: 151, where: "Solomon's Edibles",            is: 'grocer',     kod: 'cngrocer.kod' },
  "d'franco":        { town: 'Cor Noth', room: 153, where: 'Cibilo Creek Inn',             is: 'innkeeper',  kod: 'cninnk.kod' },
  "rook":            { town: 'Cor Noth', room: 154, where: "The Weapon Master's Abode",    is: 'sergeant',   kod: 'cnsarge.kod' },
  "hester gilk":     { town: 'Cor Noth', room: 155, where: 'The Spindle and the Spinster', is: 'tailor',     kod: 'cntailor.kod' },
  // Jasper — jasprtwn/. Yevitan stands IN the bank, which makes a Jasper ring the best
  // one to hold: the payout and the place to put it are the same room.
  "yevitan":         { town: 'Jasper',   room: 376, where: 'The Royal Bank of Jasper',     is: 'banker',     kod: 'jsbanker.kod' },
  "pietro":          { town: 'Jasper',   room: 371, where: "Pietro's Wicked Brews",        is: 'bartender',  kod: 'jsbart.kod' },
  "afiera d'xor":    { town: 'Jasper',   room: 375, where: 'The Home of the Wise Man',     is: 'elder',      kod: 'jselder.kod' },
  "widow qesino":    { town: 'Jasper',   room: 370, where: 'Yonder Inn of Jasper',         is: 'innkeeper',  kod: 'jsinnk.kod' },
  // Marion — marntwn/
  "tova":            { town: 'Marion',   room: 202, where: 'The Limping Toad Inn and Tavern', is: 'bartender', kod: 'mrbart.kod' },
  "ran er'hoth":     { town: 'Marion',   room: 200, where: 'Marion',                       is: 'elder',      kod: 'MrElder.kod' },
  // Tos — tostwn/. Two rooms from the bank at 54.
  "paddock":         { town: 'Tos',      room: 52,  where: 'Familiars',                    is: 'innkeeper',  kod: 'TsInnK.kod' },
  // The four with no address — wanderer/
  "maleval":         { town: null, room: null, roams: true, is: 'dark wizard',     kod: 'dkwizard.kod' },
  "miriana":         { town: null, room: null, roams: true, is: 'heretic',         kod: 'heretic.kod' },
  "tendrath":        { town: null, room: null, roams: true, is: 'hunter ghost',    kod: 'huntghst.kod' },
  "parrin aragone":  { town: null, room: null, roams: true, is: 'minstrel',        kod: 'minstrel.kod' },
};

// The description gives us the name the server spells, and the table is keyed on a folded
// version of it. Apostrophes are the whole reason this is a function: "Afiera D'xor" and
// "Ran er'Hoth" both carry one, and a straight lowercase compare is fine for those — but
// an unknown name must come back as a miss rather than as an exception, because "we have
// never heard of this owner" is a legitimate answer for a ring whose look timed out.
export function signetOwnerOf(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase().replace(/\s+/g, ' ');
  return SIGNET_OWNERS[key] ?? null;
}

// The level at or above which a character stops being paid ten times over.
export const SIGNET_NEWBIE_LEVEL = 30;      // PKILL_ENABLE_HP, blakston.khd:2094

// WHAT THIS RING IS WORTH IN THIS CHARACTER'S HANDS, as a multiplier and a range rather
// than a figure — see the condition arithmetic above for why a single number would be a
// lie. `level` is max health. `guilded` is an input rather than something read, because
// nothing on the wire reports it; the caller says what it knows.
export function signetPayout({ level = null, guilded = false } = {}) {
  const newbie = !guilded && level != null && level < SIGNET_NEWBIE_LEVEL;
  return {
    multiplier: newbie ? 10 : 1,
    newbie,
    // 10 and 150 are the bounds GetValue can return for this class; everything in
    // between depends on a condition we are not allowed to see.
    range: newbie ? [100, 1500] : [10, 150],
    why: level == null ? 'level unknown — cannot tell which side of 30 this is'
       : guilded ? 'in a guild, so player-killing is enabled and the ring pays plain value'
       : newbie ? `under ${SIGNET_NEWBIE_LEVEL} max health, so the ring pays ten times over`
       : `at or over ${SIGNET_NEWBIE_LEVEL} max health, so player-killing is enabled and the ring pays plain value`,
  };
}

// Cached per client and per object id, because a ring's owner never changes and looking
// costs a round trip. Cleared naturally when the ring leaves the pack.
const signetOwners = (c) => (c._signetOwners ??= new Map());

// Every signet ring in the pack, with whoever it names, looking only at the ones we have
// not already read. Unknown owners are reported rather than guessed.
export async function signetRings(s) {
  const c = s.need();
  const known = signetOwners(c);
  const out = [];
  for (const o of c.inventory || []) {
    const name = c.rsc.get(o.nameRsc) || '';
    if (!SIGNET_NAME.test(name)) continue;
    if (!known.has(o.id)) {
      // Same retry as inspectForBroken: the first look after another look comes back
      // empty, reproducibly.
      let desc = null;
      for (let i = 0; i < 2 && desc == null; i++) {
        await s.pacer.submit('look', () => c.look(o.id));
        const { events } = await c.waitFor({ kinds: ['look'], timeoutMs: 3000 });
        desc = events.find(e => e.id === o.id)?.description ?? null;
      }
      known.set(o.id, desc ? (desc.match(SIGNET_CREST)?.[1]?.trim() ?? null) : null);
    }
    // WHERE IT HAS TO GO, on the ring rather than looked up again by every caller. Three
    // outcomes and they are not the same: a room to walk to, a known owner that roams
    // (nothing to route to, keep asking wherever we are), and an owner we could not read
    // or do not recognise. Only the first is dispatchable.
    const owner = known.get(o.id);
    const at = signetOwnerOf(owner);
    out.push({
      id: o.id, owner,
      town: at?.town ?? null, room: at?.room ?? null, where: at?.where ?? null,
      roams: at ? !!at.roams : null,
      routable: !!at?.room,
      unknown_owner: !!owner && !at,
    });
  }
  return out;
}

// Hand back any ring whose owner is standing in this room. Returns what it managed to
// give away; an empty list is the overwhelmingly common answer and costs one look per
// ring the first time and nothing after that.
export async function returnSignetRings(s, { max = 3 } = {}) {
  const c = s.need();
  const rings = await signetRings(s);
  if (!rings.length) return { returned: [], carrying: 0 };
  const here = [...c.room.objects.values()]
    .filter(o => o.id !== c.selfId)
    .map(o => ({ id: o.id, name: c.rsc.get(o.nameRsc) || '' }));
  const returned = [], refused = [];
  for (const ring of rings) {
    if (returned.length >= max) break;
    if (!ring.owner) continue;                       // never read — leave it alone
    const npc = here.find(o => o.name.toLowerCase() === ring.owner.toLowerCase());
    if (!npc) continue;
    const before = c.evSeq;
    await s.pacer.submit('trade', () => c.offer(npc.id, [ring.id]));
    const ev = await c.waitFor({ since: before, kinds: ['message', 'trade-ended', 'offer-sent'], timeoutMs: 4000 });
    // The ring leaving the pack is the only proof that matters — the NPC takes it
    // outright rather than countering, so there is no accept step to wait for.
    await s.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
    const gone = !(c.inventory || []).some(o => o.id === ring.id);
    if (gone) { returned.push({ to: ring.owner, ring: ring.id }); signetOwners(c).delete(ring.id); }
    else refused.push({ to: ring.owner, ring: ring.id,
                        said: ev.events.filter(e => e.text).map(e => e.text).slice(0, 2) });
  }
  return { returned, ...(refused.length ? { refused } : {}), carrying: rings.length - returned.length };
}

// ------------------------------------------------------- who actually killed you

// THE SERVER ANNOUNCES THE KILLER. NOTHING WAS READING IT.
//
// Every death is broadcast to the whole world, and the broadcast names the creature that
// struck the killing blow — not the crowd, the killer (system.kod:49-57). The postmortem
// was instead reporting `killed_by` as "everything standing next to us at the end", which
// is a different question and answers it badly: checked against 249 deaths that DO have a
// matching broadcast, the crowd's most-common member was the real killer only 51% of the
// time. A coin flip was being written into the record as a cause of death.
//
// It also invented a villain. Twelve deaths at the border of the Badlands were attributed
// to "soldier of the Duke's army" because soldiers were standing there; the broadcasts say
// groundworm nine times and troll four, and no soldier at all. Faction soldiers do not
// start fights with the unaligned, which is exactly why they were there to be blamed.
//
// The seven forms, all from system.kod. %q is a name, %s an article.
const DEATH_FORMS = [
  // "### Kermit was just killed by a giant rat."
  { re: /^###\s+(.+?)\s+was just killed by\s+(?:an?\s+|the\s+)?(.+?)\.?$/i,
    how: 'killed', who: 1, killer: 2 },
  // "### The notorious murderer, X, has been killed by a troll."
  { re: /^###\s+The notorious murderer,\s*(.+?),\s*has been killed by\s+(?:an?\s+|the\s+)?(.+?)\.?$/i,
    how: 'killed as a murderer', who: 1, killer: 2 },
  // "### The feared outlaw, X, has just met justice at Y's hands."
  { re: /^###\s+The feared outlaw,\s*(.+?),\s*has just met justice at\s+(?:an?\s+|the\s+)?(.+?)'s hands\.?$/i,
    how: 'killed as an outlaw', who: 1, killer: 2 },
  // "### X has been murdered in cold blood."  — a player killed them, and is NOT named
  { re: /^###\s+(.+?)\s+has been murdered in cold blood\.?$/i,
    how: 'murdered by a player', who: 1, killer: null },
  // "### X was just slain by his own folly."
  { re: /^###\s+(.+?)\s+was just slain by\s+\S+\s+own folly\.?$/i,
    how: 'own folly', who: 1, killer: null },
  // "### X met an untimely end."  — the room did it: lava, a fall, a trap
  { re: /^###\s+(.+?)\s+met an untimely end\.?$/i,
    how: 'the room itself', who: 1, killer: null },
];

// Parse one broadcast. Returns null for anything that is not a death — notably the
// "lost a token to" line, which is the same ### channel and is not a death at all.
export function parseDeathBroadcast(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('###')) return null;
  for (const f of DEATH_FORMS) {
    const m = f.re.exec(t);
    if (!m) continue;
    return { who: m[f.who].trim(), killer: f.killer ? m[f.killer].trim() : null, how: f.how, text: t };
  }
  return null;
}

// The broadcast naming this character, nearest in time to when they died. Returns null
// rather than the wrong one: a fleet of twenty-one dies often enough that "the most
// recent ### line" is frequently about somebody else entirely.
// `at` NULL MEANS "THE LATEST ONE IN THE BUFFER", AND THAT IS THE USEFUL MODE.
//
// This only ever ran windowed, +/-30s around the moment the keeper NOTICED the death —
// and noticing is the slow part. Death is inferred from standing in the Underworld, which
// is seen on the next pass, and a pass can be a whole journey behind. Measured over 443
// attended post-mortems: the death line is in the record 94% of the time and the killer
// was attributed 31% of the time, and the difference is entirely this window. The gap
// between the last frame and the death ran to a median of 6s but a 90th percentile of
// 67s and a maximum of 365s, and 114 records had the gap NEGATIVE — a frame written after
// the death, so even the sign could not be relied on.
//
// The window was buying precision the match does not need: every candidate has already
// been filtered to a broadcast naming THIS character. Searching the whole retained buffer
// and taking the most recent is right, and `dt` comes back with it so a caller can see
// how stale the answer is rather than being told a confident wrong one.
//
// The windowed form is kept, because a caller that knows when the death happened should
// still say so, and the tests pin both.
export function deathBroadcastFor(name, events, at, { withinMs = 30_000 } = {}) {
  if (!name) return null;
  const unwindowed = at == null;
  let best = null;
  for (const e of events || []) {
    const p = parseDeathBroadcast(e.text);
    if (!p || p.who.toLowerCase() !== String(name).toLowerCase()) continue;
    if (unwindowed) {
      // Most recent wins. A character can only have died once at the end of a buffer,
      // and an older broadcast in the same buffer is a previous death, not this one.
      if (!best || (e.at ?? 0) > (best.at ?? 0)) best = { ...p, at: e.at, dt: null };
      continue;
    }
    const dt = Math.abs((e.at ?? 0) - at);
    if (dt > withinMs) continue;
    if (!best || dt < best.dt) best = { ...p, at: e.at, dt };
  }
  return best;
}

// WHEN TO WITHDRAW, AND WHEN NOT TO START. One home, because both keepers need it and a
// survival threshold with two definitions is two opinions about when to run.
//
// Lifted verbatim from Autopilot.safety(); behaviour is unchanged. It takes a CLIENT and
// a POLICY rather than a keeper, for the same reason isArmed does: whoever is driving,
// the arithmetic is the same.
export function safetyFor(client, policy = {}) {
  const v = client?.vitals?.();
  const max = v?.health?.max ?? 0;
  if (!max) return { fleeAt: policy.fleeBelow, engageAt: 0.85, maxHit: null };
  const maxHit = Math.min(30, Math.floor((max + 2) / 3));
  // Two hits of margin, not three. (base+2)/3 is the CAP on a single blow rather
  // than what a giant rat typically lands, so budgeting three of them leaves so
  // little of the bar to fight in that the character spends its life healing.
  // Two is the number that survives the realistic bad case -- one hit landing as
  // the withdraw begins, and one more before it is out of reach -- while still
  // leaving a usable window to actually fight in.
  const fleeAt = Math.max(policy.fleeBelow, Math.min(0.7, (2 * maxHit) / max));
  return {
    maxHit, fleeAt,
    // Do not start a fight that cannot be finished. Below this, heal or rest
    // first -- going in at half health is how a survivable creature kills you.
    engageAt: max < 30 ? 0.9 : 0.75,
  };
}
