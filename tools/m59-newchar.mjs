#!/usr/bin/env node
// MAKING A CHARACTER WORTH GROWING.
//
// `create automated` on the admin console makes an account and a character in one go,
// and the character it makes has ZERO in every attribute. Attributes are fixed at
// creation and never move, and stamina IS the max-health ceiling (101 + stamina), so
// such a character is permanently capped at 102 max health and permanently bad at
// everything. It is not a character, it is a placeholder.
//
// The ordinary game protocol can do better, and the client already knows how: a
// RESTART is suicide, reconnect, and BP_NEW_CHARINFO at the character list instead of
// BP_USE_CHARACTER. What was missing is the part that decides what to ask for.
//
// WHAT THE SERVER ACCEPTS (player.kod:1971, PlayerNewCharInfo):
//
//   * six stats, each 1..50, summing to AT MOST 200
//   * spells and skills costing at most 45 points: 10 for a level-1, 25 above that
//   * a face-part list of exactly five valid resources
//
// THE HAZARD IS THAT IT NEVER SAYS NO. Over budget, out of range, wrong list length —
// none of it is refused. The server silently stamps a junk character on you: stats
// 3/1/4/1/5/9, the default male face, no abilities. You find out weeks later when the
// thing cannot get past level 15. So everything here validates BEFORE sending, and
// refuses to send anything it is not sure of. A loud error beats a quiet cripple.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Group 2, slots 1..6 (m59-parse.mjs STAT_NAMES). Order is the wire order; slot 7 is
// karma, which is not allocated at creation.
import { resolveAppearance, checkAppearance, describeAppearance, isDefaultFace }
  from './m59-appearance.mjs';

export const STAT_ORDER = ['might', 'intellect', 'stamina', 'agility', 'mysticism', 'aim'];
export const STAT_BUDGET = 200;
export const STAT_MIN = 1;
export const STAT_MAX = 50;
export const ABILITY_BUDGET = 45;
const COST_LEVEL_1 = 10;
const COST_HIGHER = 25;

// STAMINA IS 50 IN EVERY PRESET, and that is not a preference.
//
// Max health is the level, the whole fleet is measured in max health gained per hour,
// and the lifetime ceiling is 101 + stamina. Fifty is the per-stat maximum, so fifty
// stamina buys the highest ceiling the game will ever allow — 151 — and any point
// spent elsewhere instead is a point off the number being farmed. The presets differ
// in how they spend the remaining 150.
export const STAT_PRESETS = {
  // What these characters actually do: walk up to something and hit it, from a wall.
  melee:    { might: 50, intellect: 10, stamina: 50, agility: 45, mysticism: 15, aim: 30 },
  // For a character meant to hold a school. Mysticism drives spell power; intellect
  // carries the mana pool that pays for it.
  caster:   { might: 15, intellect: 45, stamina: 50, agility: 30, mysticism: 50, aim: 10 },
  // Bow-first, for pulling things to a wall from further away than a sword reaches.
  archer:   { might: 25, intellect: 15, stamina: 50, agility: 40, mysticism: 20, aim: 50 },
  balanced: { might: 35, intellect: 30, stamina: 50, agility: 35, mysticism: 30, aim: 20 },
};

// SPELLS THAT FIX WHAT THE FLEET IS ACTUALLY SHORT OF.
//
// The two failures on the fleet board are both silent and both permanent-ish: a
// character with no weapon punches things instead of erroring, and one with no food
// never gets vigor above the resting cap of 80, so it farms at a fraction of the rate
// for ever. Twenty of twenty-five have no food.
//
// Both have a level-1 Kraanan answer, and — the part that makes it work — both are
// castable by ANYONE. Karma gates the schools that matter: Shal'ille needs karma at or
// above +10 and Qor at or below -10, so a fresh neutral character can cast NEITHER.
// Handing a new character `minor heal` is handing it something it cannot use until it
// has ground its karma somewhere. Kraanan and Faren ask for nothing.
export const SPELL_LOADOUTS = {
  // The default, and the one that answers the board.
  selfSufficient: {
    spells: ['create weapon', 'create food', 'zap', 'relay'],
    why: 'create weapon needs no reagents at all, so this character can never be unarmed; ' +
         'create food needs elderberries and herbs, which are exactly what it will be picking ' +
         'up anyway, so it can never be stuck at 80 vigor. Both are karma-free, so it can cast ' +
         'them from the day it is made. zap is a free ranged attack for pulling.',
  },
  // For a character intended to end up Shal'ille. The heal is unusable until its karma
  // climbs, which is a deliberate cost paid for having it early.
  healer: {
    spells: ['create food', 'minor heal', 'zap'],
    why: 'minor heal cannot be cast below +10 karma, so this only makes sense for a character ' +
         'that is going to be killing evil things on purpose',
  },
  none: { spells: [], why: 'stats only' },
};

let catalogue = null;
function spells(file) {
  if (catalogue) return catalogue;
  const f = file || fileURLToPath(new URL('../substrate/m59-spells.json', import.meta.url));
  try { catalogue = JSON.parse(readFileSync(f, 'utf8')).spells || []; } catch { catalogue = []; }
  return catalogue;
}

export const abilityCost = level => (level > 1 ? COST_HIGHER : COST_LEVEL_1);

// Turn a request into something safe to send, or explain why it is not.
//
// Every check here exists because the server does NOT do it and does not complain: an
// invalid request is accepted and quietly replaced. This is the only place the mistake
// can still be caught.
// WHAT THE SERVER WILL ACTUALLY GRANT AT CREATION, read off its own source.
//
// This used to be a warning that said "a spell above level 1 was silently dropped when this
// was last tried". That was one observation and it named the wrong boundary. The rule is in
// the kod, it is exact, and it is worth having exactly:
//
//   player.kod:2173   if iPoints > 45  ->  "% they hacked their char.dll"  and the whole
//                     else-branch is skipped: EVERY spell AND skill is discarded, not
//                     trimmed. Over budget does not cost you the last one, it costs you all
//                     of them.
//   player.kod:2185   a spell is added only if `OfferToNewCharacters` AND level <= 2
//   player.kod:2209   a skill is added only if level <= 2 (no offer check on skills)
//
//   spell.kod:2261    OfferToNewCharacters: FALSE unless enabled and accessible; FALSE if
//                     level > 2; TRUE for Shal'ille, Qor, Kraanan and Faren; FALSE for
//                     everything else — so no Riija or Jala spell can ever be chosen at
//                     creation, whatever its level.
//
// Nine spells additionally override it to FALSE. They are PK and utility spells and the
// server treats asking for one as cheating.
const NOT_OFFERED = new Set([
  'fade', 'cloak', 'eagle eyes', 'eavesdrop', 'free action',
  'resist evil', 'resist good', 'resist poison', 'bramble wall',
]);
const OFFERED_SCHOOLS = new Set(['shal’ille', "shal'ille", 'qor', 'kraanan', 'faren']);
const MAX_INITIAL_LEVEL = 2;

// WILL THE SERVER GRANT THIS ONE? The whole point is that it does not say so either way —
// a refused spell is simply absent from a character that otherwise looks fine, and the
// points are spent regardless.
export function grantableAtCreation(sp) {
  const school = String(sp?.school_name ?? sp?.school ?? '').toLowerCase();
  if (!sp) return { ok: false, why: 'no such spell' };
  if (Number(sp.level) > MAX_INITIAL_LEVEL)
    return { ok: false, why: `level ${sp.level}; the server adds a spell only at level ` +
             `${MAX_INITIAL_LEVEL} or below (player.kod:2188). It must be LEARNED from a teacher` };
  if (NOT_OFFERED.has(String(sp.name ?? '').toLowerCase()))
    return { ok: false, why: 'the spell itself refuses new characters (OfferToNewCharacters ' +
             '-> FALSE); the server treats asking for it as cheating' };
  if (school && !OFFERED_SCHOOLS.has(school))
    return { ok: false, why: `${sp.school_name} is never offered at creation — only ` +
             `Shal'ille, Qor, Kraanan and Faren are (spell.kod:2276)` };
  return { ok: true };
}

// THE WAIVER, PARSED THE WAY FLEETSCRIPT PARSES ITS OWN.
//
// A reason is MANDATORY and is enforced here rather than at the call site, so a malformed
// waiver surfaces when the plan is made and not with a character already created. "I know
// this spell will be dropped" and "I forgot" have to look different on the page — that is
// the entire argument, and it is m59-fleetscript.mjs's, borrowed intact.
export const CREATION_GUARANTEES = Object.freeze({
  spellsGranted: 'every spell asked for is one the server will actually grant at creation',
  fullBudget: 'the whole 45-point ability budget is spent, since points do not carry',
});

export function parseCreationWaiver(unsafe) {
  if (unsafe == null) return new Set();
  const reason = typeof unsafe.reason === 'string' ? unsafe.reason.trim() : '';
  if (!reason)
    throw new Error('unsafe creation needs a `reason` — a waiver nobody can read is just a hole');
  const named = unsafe.waives === '*' || (Array.isArray(unsafe.waives) && unsafe.waives.includes('*'))
    ? Object.keys(CREATION_GUARANTEES)
    : (Array.isArray(unsafe.waives) ? unsafe.waives : []);
  const unknown = named.filter(w => !(w in CREATION_GUARANTEES));
  if (unknown.length)
    throw new Error(`unknown creation waiver(s): ${unknown.join(', ')}. ` +
      `Known: ${Object.keys(CREATION_GUARANTEES).join(', ')}, or '*' for all of them.`);
  return new Set(named);
}

// ------------------------------------------------------------------ the name rule
//
// THE SERVER'S RULE IS IN system.kod, NOT player.kod. Three comments in this repository
// used to send you to player.kod; that file holds the STATS rule, and the two have
// opposite failure modes, which is how the confusion survived. Read the real branch
// before touching anything here:
//
//   kod/util/system.kod:3733   ReceiveClient, the BP_NEW_CHARINFO branch
//     StringLength(sName) < MIN_CHAR_NAME_LEN OR > MAX_CHAR_NAME_LEN    -> 3..30
//                                (blakston.khd:2958-2959)
//     StringConsistsOf(sName,
//       "A-Za-z0-9_ '!@$^&*()+=:[]{};/?|<>")                            -> and nothing else
//     ...then a refusal is ONE packet: AddPacket(1,BP_CHARINFO_NOT_OK), nothing created,
//     no reason on the wire. The name that passes is written verbatim by SetResource.
//
// A BAD NAME IS REFUSED; A BAD STAT LIST IS SUBSTITUTED. That is the whole distinction the
// old comments lost. player.kod:2081 stamps 3/1/4/1/5/9 on a character it has ALREADY
// created and told you was fine — so the stats have to be verified afterwards, while the
// name simply never happens. Nothing about a name is ever silently replaced.
//
// OURS IS A SUBSET ON PURPOSE, AND THE DIRECTION IS THE WHOLE POINT. The requirement is
// that nothing we accept can be refused by the server — never that we accept everything it
// would. So the LENGTH is the server's own 3..30 exactly, because a ceiling we invent is a
// name the operator cannot have for a reason nobody can cite; and the CHARACTER SET is
// letters, apostrophe and space, which is strictly inside the legal set. Digits, `_` and
// the punctuation the server permits are refused here. They would be accepted by the game,
// and the cost of admitting them is paid somewhere else entirely: a character name is a
// key in a roster, a token in a log line, a thing `m59-roomview.mjs` redacts by matching,
// and `|` or `<>` or `/` in one is a parser bug waiting for a quiet night. Widen it if
// somebody wants a digit; do not widen it by accident.
//
// WHAT THIS REPLACED WAS WRONG IN BOTH DIRECTIONS. `/^[A-Za-z][A-Za-z' -]{1,15}$/`:
//
//   * SIXTEEN was ours and uncitable. "Raphael son of Mephistopheles" is twenty-nine
//     characters and the server takes it; we refused it, from a comment that claimed to be
//     quoting a rule file that does not contain one.
//   * THE HYPHEN IS NOT IN THE SERVER'S SET AT ALL. So "Jean-Luc" passed our gate, went out
//     on the wire, and came back as a bare BP_CHARINFO_NOT_OK. A gate that admits what the
//     server refuses is worse than no gate: it moves the refusal to the one place that
//     cannot say why it fired.
export const CHAR_NAME_MIN = 3;    // MIN_CHAR_NAME_LEN, kod/include/blakston.khd:2958
export const CHAR_NAME_MAX = 30;   // MAX_CHAR_NAME_LEN, kod/include/blakston.khd:2959
export const CHAR_NAME_RE =
  new RegExp(`^[A-Za-z][A-Za-z' ]{${CHAR_NAME_MIN - 1},${CHAR_NAME_MAX - 1}}$`);

// The fixed refusals from the same branch. Both server predicates are FUZZY
// (blakserv/ccode.c, FuzzyCollapseString): ends trimmed, then uppercased — so these are
// case-insensitive, and " qor " is Qor. `CHAR_NAME_RESERVED` is StringEqual (system.kod's
// lBadNameIs, plus its separate "guild" test); `CHAR_NAME_RESERVED_IN` is StringContain.
export const CHAR_NAME_RESERVED = Object.freeze([
  'Faren', "Shal'ille", 'Qor', 'Kraanan', 'Riija', 'Jala',   // the gods
  'You', 'An Administrator',                                 // system_hidden_admin, :233
  'guild',                                                   // the gmail-your-own-guild name
]);
export const CHAR_NAME_RESERVED_IN = Object.freeze(['guardian angel', 'guardianangel']);

// WHAT THIS STILL CANNOT PROMISE, because the answer lives on the server: a name already
// taken by a user, a monster, an NPC or a guild; "a"/"an" wrapped around a monster's true
// name; and the profanity list, which `AddNaughtyWord` extends at RUNTIME and which
// therefore no copy here could ever be. Those are still refused the way every refusal
// here looks — one blank packet — which is why creation reads its result back rather than
// trusting this. What this closes is the half decidable from the string, which is every
// failure a typo or a template can cause on its own.
export function checkCharacterName(name) {
  if (typeof name !== 'string' || name === '')
    return { ok: false, why: 'no character name was given' };
  // Legal on the server, refused here: the client trims it (module/char/charname.c,
  // VerifyCharName) and the server does not, so "Raphael " and "Raphael" are one character
  // to a person and two to a roster.
  if (name !== name.trim())
    return { ok: false, why: `"${name}" starts or ends with a space` };
  if (name.length < CHAR_NAME_MIN)
    return { ok: false, why: `"${name}" is ${name.length} characters; the server's minimum ` +
      `is ${CHAR_NAME_MIN} (MIN_CHAR_NAME_LEN)` };
  if (name.length > CHAR_NAME_MAX)
    return { ok: false, why: `"${name}" is ${name.length} characters; the server's ceiling ` +
      `is ${CHAR_NAME_MAX} (MAX_CHAR_NAME_LEN)` };
  // NAME THE CHARACTER, NOT THE PATTERN. "does not match /^[A-Za-z].../" tells the operator
  // to go and read a regex; "a comma is not a legal character" tells them what to type next.
  if (!CHAR_NAME_RE.test(name)) {
    const bad = [...name].find((ch, i) => !(i === 0 ? /[A-Za-z]/ : /[A-Za-z' ]/).test(ch));
    if (bad === undefined || !/[A-Za-z]/.test(name[0]))
      return { ok: false, why: `"${name}" must begin with a letter` };
    // A DIGIT IS SAID IN WORDS as well as quoted, because it is the one illegal character
    // a template produces by itself — `bot{n}` — and the fix is to change the template
    // rather than the character.
    const what = /[0-9]/.test(bad) ? `a digit (${JSON.stringify(bad)})` : JSON.stringify(bad);
    const known = /[0-9_!@$^&*()+=:[\]{};/?|<>]/.test(bad)
      ? ' — the server allows it, this repository does not'
      : ' — the server does not allow it either';
    return { ok: false, why: `"${name}" contains ${what}, which is not one of ` +
      `the letters, apostrophes and spaces a character name may use${known}` };
  }
  const fuzzy = name.trim().toUpperCase();
  for (const r of CHAR_NAME_RESERVED)
    if (fuzzy === r.toUpperCase())
      return { ok: false, why: `"${name}" is a name the server reserves` };
  for (const r of CHAR_NAME_RESERVED_IN)
    if (fuzzy.includes(r.toUpperCase()))
      return { ok: false, why: `"${name}" contains "${r}", which the server refuses` };
  return { ok: true, why: null };
}

export function planCharacter({
  name, stats = 'melee', loadout = 'selfSufficient', skills = [], gender = 1,
  spellsFile = null,
  // FLEETSCRIPT'S SHAPE, because the operator asked for it and because it is the right
  // one: a named waiver with a MANDATORY reason, never a boolean. `waives: ['*']` is the
  // total waiver and is deliberately ugly to type. A creation that is deliberately
  // suboptimal and one that is a mistake have to look different on the page.
  unsafe = null,
  // NOTHING CHOSEN MEANS A RANDOM FACE, not the same man again. See m59-appearance.mjs:
  // a face-part list that is not exactly five long is the server's "hacking the protocol"
  // branch, which stamps the default male face — so every character this repository has
  // ever made has been identical, because nobody passed one and the silence read as a
  // preference. `appearance: 'default'` asks for the old face deliberately.
  appearance = null, rng = Math.random,
} = {}) {
  const waived = parseCreationWaiver(unsafe);
  const problems = [];
  // REPORTED, NEVER REFUSED. A problem means the request is illegal and the server would
  // quietly replace the character; a warning means the request is legal and something about
  // it is known to disappoint. Folding the second into the first turns a note into a wall,
  // and a wall somebody did not ask for is a wall they route around.
  const warnings = [];
  const named = checkCharacterName(name);
  if (!named.ok) problems.push(named.why);

  const chosen = typeof stats === 'string' ? STAT_PRESETS[stats] : stats;
  if (!chosen) problems.push(`no stat preset called "${stats}"`);

  let statList = [];
  if (chosen) {
    statList = STAT_ORDER.map(k => Number(chosen[k] ?? 0));
    const total = statList.reduce((a, b) => a + b, 0);
    if (statList.length !== 6) problems.push('there must be exactly six stats');
    for (let i = 0; i < statList.length; i++) {
      const v = statList[i];
      if (!Number.isInteger(v) || v < STAT_MIN || v > STAT_MAX)
        problems.push(`${STAT_ORDER[i]} is ${v}; every stat must be a whole number from ${STAT_MIN} to ${STAT_MAX}`);
    }
    if (total > STAT_BUDGET)
      problems.push(`the stats total ${total}, over the budget of ${STAT_BUDGET} — ` +
                    'the server would silently replace the whole character with 3/1/4/1/5/9');
    // Under budget is legal and always a mistake: the points do not carry, and they
    // cannot be added later because attributes never move.
    if (total < STAT_BUDGET)
      problems.push(`the stats total ${total}, leaving ${STAT_BUDGET - total} unspent. ` +
                    'Attributes are fixed at creation and never move, so those points are gone for good');
  }

  const want = typeof loadout === 'string' ? SPELL_LOADOUTS[loadout] : loadout;
  if (!want) problems.push(`no loadout called "${loadout}"`);

  const cat = spells(spellsFile);
  const picked = [];
  let cost = 0;
  for (const n of (want?.spells ?? [])) {
    const sp = cat.find(x => x.name === n);
    if (!sp) { problems.push(`no spell called "${n}" in the catalogue`); continue; }
    // REFUSED, NOT WARNED. The operator's instruction: error rather than create the
    // nerfed character. A spell the server will silently drop still costs its points, so
    // the character comes back both missing the ability AND having paid for it — the
    // worst of the two outcomes, and invisible until somebody tries to cast.
    const grant = grantableAtCreation(sp);
    if (!grant.ok && !waived.has('spellsGranted'))
      problems.push(`"${n}" will NOT be granted: ${grant.why}. It still costs `+
        `${abilityCost(sp.level)} of the ${ABILITY_BUDGET} ability points. Drop it, or waive `+
        `\`spellsGranted\` with a reason if you mean to spend them anyway.`);
    else if (!grant.ok) warnings.push(`"${n}" will not be granted (${grant.why}) — waived`);
    const c = abilityCost(sp.level);
    picked.push({ num: sp.num, name: sp.name, level: sp.level, cost: c,
                  school: sp.school_name, mana: sp.mana,
                  required_karma: sp.required_karma,
                  castable_when_new: (sp.required_karma ?? 0) <= 0,
                  reagents: (sp.reagents || []).map(r => `${r.count}x${r.item}`) });
    cost += c;
  }
  // Skills are passed through as numbers: there is no skill-number catalogue in this
  // repository yet — the server reports skills by session object id, which is not the
  // same thing — so this cannot name-check them the way it does spells.
  for (const n of skills) cost += COST_LEVEL_1;
  // POINTS DO NOT CARRY AND ABILITIES CANNOT BE ADDED LATER FOR FREE, so an under-spent
  // budget is the same permanent loss as an under-spent stat budget — which this file
  // already refuses. It was silent about the ability half.
  if (cost < ABILITY_BUDGET && !waived.has('fullBudget'))
    problems.push(`abilities cost ${cost} of ${ABILITY_BUDGET}, leaving ${ABILITY_BUDGET - cost} `+
      `unspent. They do not carry. Add another level-1 spell or skill (10 points each), or `+
      `waive \`fullBudget\` with a reason.`);
  else if (cost < ABILITY_BUDGET) warnings.push(`${ABILITY_BUDGET - cost} ability point(s) left unspent — waived`);
    if (cost > ABILITY_BUDGET)
    problems.push(`abilities cost ${cost}, over the budget of ${ABILITY_BUDGET} — ` +
                  'the server would silently discard all of them — player.kod:2173 skips the whole ' +
                  'branch that adds spells AND skills, so going over does not cost you the last ' +
                  'one, it costs you every one');

  // THE SCHOOL YOU PICK SETS YOUR STARTING KARMA, so `castable_when_new` cannot be read
  // off the spell alone. player.kod:2233 — choosing a Shal'ille spell and no Qor one
  // starts you at piKarma = 2000 (which the client shows as 20 on its -100..100 scale);
  // choosing Qor and no Shal'ille starts you at -2000. Picking both, or neither, leaves
  // it at 0. Without this the plan told you a level-1 Shal'ille spell was uncastable on a
  // character the server was about to hand exactly enough karma to cast it.
  const schools = new Set(picked.map(x => String(x.school ?? '').toLowerCase()));
  const shal = [...schools].some(x => x.includes('shal'));
  const qor = schools.has('qor');
  const startingKarma = shal && !qor ? 20 : qor && !shal ? -20 : 0;
  for (const x of picked) x.castable_when_new = (x.required_karma ?? 0) <= startingKarma;

  const face = resolveAppearance(appearance, gender, rng);
  const faceCheck = checkAppearance(face, gender);
  for (const why of faceCheck.problems) problems.push(why);
  if (isDefaultFace(face.faceparts) && appearance !== 'default')
    warnings.push('this is the default face every character here already has — pass ' +
      'appearance to choose, or leave it out to randomise');

  return {
    ok: problems.length === 0,
    problems, warnings,
    name, gender,
    stats: chosen ? Object.fromEntries(STAT_ORDER.map((k, i) => [k, statList[i]])) : null,
    stat_list: statList,
    stat_total: statList.reduce((a, b) => a + b, 0),
    max_health_ceiling: chosen ? 101 + (chosen.stamina ?? 0) : null,
    spells: picked,
    spell_nums: picked.map(p => p.num),
    skills,
    ability_cost: cost, ability_budget: ABILITY_BUDGET,
    starting_karma: startingKarma,
    appearance: face,
    appearance_text: describeAppearance(face),
    why: want?.why,
    uncastable_at_first: picked.filter(p => !p.castable_when_new).map(p => p.name),
  };
}

// THE RESTART, which is an ordinary in-game action and not an admin one.
//
//   1. UC_SUICIDE while logged in. PerformSuicide (user.kod:1447) sets
//      piLastLoginTime = 0, and IsFirstTime() is exactly that test — the gate
//      system.kod:3726 checks before it will accept a new character.
//   2. Reconnect. At the character list, send BP_NEW_CHARINFO instead of
//      BP_USE_CHARACTER.
//   3. BP_CHARINFO_OK carries the new object id, which is then USEd.
//
// This is destructive and there is no undo: the old character is gone the moment step
// one lands. The caller is expected to have decided that already.
export async function rerollCharacter(session, plan, { onStep = () => {} } = {}) {
  if (!plan?.ok) throw new Error('refusing to reroll on an invalid plan: ' + (plan?.problems || []).join('; '));
  const c = session.need();

  onStep({ step: 'suicide', note: 'this is the irreversible one' });
  await session.pacer.submit('suicide', () => c.suicide());
  await new Promise(r => setTimeout(r, 1500));

  onStep({ step: 'reconnect', note: 'the character list is where a new character can be asked for' });
  const made = await session.joinAsNewCharacter(plan);
  onStep({ step: 'created', ...made });
  return made;
}
