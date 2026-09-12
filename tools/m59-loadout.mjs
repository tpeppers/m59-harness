#!/usr/bin/env node
// WHAT ONE CHARACTER IS SUPPOSED TO BE CARRYING, WRITTEN DOWN WHERE THE KEEPER CAN READ IT.
//
//   node tools/m59-loadout.mjs                      # every loadout on this machine
//   node tools/m59-loadout.mjs Kermit               # one, and what it asks for
//   node tools/m59-loadout.mjs Kermit --check       # ...against what Kermit is holding now
//   node tools/m59-loadout.mjs --check-all          # the whole fleet, one line each
//   node tools/m59-loadout.mjs Kermit --init        # write a starter file from the sheet
//   node tools/m59-loadout.mjs Kermit --json        # the file, normalised
//   node tools/m59-loadout.mjs Kermit --gear-to-fleet          # preview shared gear + carry
//   node tools/m59-loadout.mjs Kermit --gear-to-fleet --apply  # give both to the whole fleet
//
// WHY THIS EXISTS. Every buy, sell, keep and drop decision in this repository was a
// constant somewhere in a tool: WANTS in m59-outfit.mjs, KEEP in m59-reagents.mjs, the
// `keep` regex in makeRoom, REAGENT_TARGET in the keeper. Twenty-one characters, one
// answer each. So a caster that needs forty herbs and a fighter that needs none are told
// the same number, and the only way to change it for one character is to edit a tool and
// restart the broker — which logs out the fleet.
//
// A loadout is that answer per character, in a file, edited in the compendium's planner
// and read by the keeper. It is the same shape whichever end wrote it.
//
// IT IS AN OVERLAY, NOT A REPLACEMENT, and that is the single most important thing about
// it. Silence means "carry on as before". A loadout that says nothing but "twenty-four
// elderberry" must not cause a character to start selling its armour, because everything
// that used to protect the armour is still there and this only adds to it. Every helper
// below is written so that an EMPTY loadout produces exactly the behaviour that existed
// before loadouts did — which is also why `null` is a real answer everywhere and not a
// reason to substitute a default.
//
// NAMES ARE EXACT BY DEFAULT, AND THAT IS DELIBERATE. This repository has already paid
// for substring matching twice: `keep: ['mace']` protected the item literally called
// "broken mace" so every character hauled its shattered weapons around for ever, and a
// junk list containing "mushroom" would have sold the edible ones, which are food. So an
// entry matches the display name the server sends, exactly, unless it asks for something
// looser — and asking is a decision somebody makes on purpose.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
// Overridable so the tests can point it at a scratch directory. They must: a loadout is
// the file a live keeper reads every pass, and a test that writes into the real directory
// is a test that changes what twenty-one characters are trying to carry.
export const LOADOUT_DIR = process.env.M59_LOADOUT_DIR || path.join(REPO, 'substrate', 'loadouts');
export const LOADOUT_FORMAT = 'm59-loadout/1';

// ------------------------------------------------------------------ names

// The wire's spelling, flattened. Display names arrive with whatever punctuation and
// casing the resource happened to use, and "Small Round Shield" and "small round shield"
// are the same object.
export const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

// A FILENAME IS NOT A CHARACTER NAME, AND THIS IS THE ONLY PLACE THAT DECIDES SO.
// The planner posts a character name over a socket, and the socket is on loopback but the
// name still lands on the filesystem. Everything outside the allowed set is dropped
// rather than escaped, so there is no encoding to get wrong and no `..` to normalise
// away — a name that does not survive this is refused by the caller instead of being
// quietly written somewhere else. Meridian character names are letters, and the fleet's
// agent handles are letters and digits.
export function slugOf(character) {
  const s = String(character ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, 48) || null;
}

export const loadoutPath = (character) => {
  const slug = slugOf(character);
  return slug ? path.join(LOADOUT_DIR, slug + '.json') : null;
};

// ------------------------------------------------------------------ the catalogue
//
// Used only to CHECK a loadout, never to build one. An item the catalogue has never heard
// of is reported as a problem and then honoured anyway: the catalogue is a snapshot of
// one source tree and the server is the authority, so refusing an unknown name would be
// this file deciding it knows the game better than the person typing.
let CATALOGUE = null, SPELLBOOK = null, LEARNING = null;
function loadPlannerData() {
  if (CATALOGUE) return;
  let j = {};
  try { j = JSON.parse(fs.readFileSync(path.join(REPO, 'compendium', 'data', 'planner.json'), 'utf8')); }
  catch { /* every reader below treats an empty table as "cannot check", not as "empty" */ }
  CATALOGUE = new Map((j.items || []).map(i => [norm(i.name), i]));
  SPELLBOOK = new Map((j.spells || []).map(s => [norm(s.name), s]));
  LEARNING = j.learning ?? {};
}
export function catalogue() { loadPlannerData(); return CATALOGUE; }
// WHICH SCHOOL AND WHICH LEVEL A SPELL IS. Not on the wire and not in a character sheet:
// BP_SPELLS gives a name, a target count and a school, and the LEVEL — the number the
// whole learning cost is computed from — is declared in kod and never sent.
export function spellbook() { loadPlannerData(); return SPELLBOOK; }
export function learningConstants() { loadPlannerData(); return LEARNING; }

// ------------------------------------------------------------------ the shape

export function blank(character, agent = null) {
  return {
    format: LOADOUT_FORMAT,
    character: String(character ?? ''),
    agent: agent ?? null,
    updated: null,
    note: '',
    plan: { schools: {}, weapon_level: null, learning_target: null,
            learning_queue: [], abilities: [] },
    // `from` is provenance and nothing else reads it: a gear stanza that arrived from a
    // fleet-wide apply looks exactly like one somebody typed for this character, and the
    // difference is the whole reason to open the file.
    gear: { weapon: [], slots: {}, from: null },
    carry: [],
    sell: [],
    keep: [],
    purse: { float: null, bank_above: null },
    // WHAT THIS CHARACTER'S KEEPER SHOULD BE SET TO, so that it survives a broker restart.
    // Empty by default and empty means "whatever the keeper already had" — see
    // POLICY_KEYS and applyLoadoutPolicyOverlay for why an absent block must never read
    // as a block full of defaults.
    policy: {},
  };
}

// THE ONLY POLICY FIELDS A LOADOUT MAY SET, and their types.
//
// A closed set, for the same reason the playbook's verbs are: a typo in a hand-edited file
// must disable its own line rather than becoming a setting nobody can find. Everything
// here is a STANDING preference about one character — what it hunts, where it stands, what
// it is allowed to spend — and deliberately not a survival threshold. `flee_below`,
// `rest_below` and the threat ceiling stay out: they are the protected faculties, they are
// argued about in policy.local.json where they can be reviewed as a block, and a per-
// character file that could quietly raise one is exactly the file nobody would think to
// check after a death.
export const POLICY_KEYS = {
  hunt:                    { type: 'string',  as: 'hunt' },
  assigned_room:           { type: 'number',  as: 'assignedRoom' },
  karma:                   { type: 'number',  as: 'karma' },
  buy_reagents:            { type: 'boolean', as: 'buyReagents' },
  pulls_before_moving_on:  { type: 'number',  as: 'pullsBeforeMovingOn' },
  fight_rounds:            { type: 'number',  as: 'fightRounds' },
  use_bt:                  { type: 'boolean', as: 'useBT' },
  conflict_response_hops:  { type: 'number',  as: 'conflict_response_hops' },
  // WHETHER THIS CHARACTER MAY BEG IN PUBLIC. Off since 2026-08-27 (askForHelp in
  // m59-autopilot.mjs): a fleet on a shared server does not broadcast for a flask. The
  // same name the `autopilot` tool and tuning.json use, and here for the same reason as
  // trip_announce below — a broadcast costs mana and is seen by everyone, and a runtime
  // set is lost at the next broker restart while the file is not.
  ask_for_help:            { type: 'boolean', as: 'askForHelp' },
  // WHETHER THIS CHARACTER NARRATES ITS OWN ARRIVALS, and on which channel.
  //
  // `M59_TRIP_ANNOUNCE` is the machine's default and is all-or-nothing: it lives on the
  // broker process and every keeper inherits it, so turning it on to watch ONE character
  // do an errand loop makes twenty-one of them broadcast. That matters because a broadcast
  // costs a percentage of maximum mana per line and `create food` costs 15 a casting — the
  // only way past the vigor rest cap of 80. A whole fleet narrating pays for the telemetry
  // out of the larder.
  //
  // Here it is per character, in the file that is already this character's standing plan,
  // applied on the next pass after the file is saved. No restart, no second broker, and no
  // separate fleet — which was the alternative and is a great deal of machinery for one
  // character's commentary.
  //
  //   "broadcast"  the whole server; what a watcher on another account sees. Costs mana.
  //   "yell"       this room and its neighbours. Free.
  //   "say"        this room only. Free.
  //   "off"        silent, even when the environment variable is on.
  trip_announce:           { type: 'string',  as: 'tripAnnounce' },
};

// Turn both halves of the planner into the ORDERED STAGES a learning errand can buy.
// A queue row names either one ability or one exact level of a track. Exact levels are
// load-bearing: a Weaponcraft 2 row must become empty before Weaponcraft 3 is considered,
// even when PlayerCanLearn happens to offer a level-3 skill early. Old loadouts without a
// queue retain their meaning: explicit abilities come first, then school goals, then the
// weapon goal, with each level forming one inferred stage.
// ---------------------------------------------------------------------------
// CROSS-SCHOOL PURCHASES ARE REFUSED, AND `create food` IS THE CASE THAT MATTERS
// ---------------------------------------------------------------------------
//
// `create food` is Kraanan level 1 (compendium/data/planner.json: school Kraanan,
// 10 mana, 2 ElderBerry + 2 Herbs) -- and so is `create weapon`, which is why the
// board reads "does not know create weapon" for exactly the characters that are not
// Kraanan casters.
//
// A CHARACTER THAT IS NOT ALREADY A CASTER OF A SCHOOL MUST NOT BUY INTO IT to solve
// a supply problem. Operator constraint, recorded 2026-08-18: doing so leaves the
// character confused. This is NOT derived from the kod -- M59_ROOT is unset on this
// machine and nothing here has read the mechanic -- so it is written down as what it
// is, a standing instruction, rather than dressed up as a citation.
//
// It is worth a guard rather than a note because the pull is real and immediate: the
// planner's route to `vigor_ok` is `cast create food -> eat`, a character that never
// learned the spell simply has no plan, and "then buy it the spell" is the obvious
// next move for anyone reading that dead end. The act layer already refuses BY
// CONSTRUCTION -- m59-act/cast is built only from spells the client says it knows, so
// no plan can ever contain a spell the character lacks -- but nothing stopped the
// purchase path, and that is the one this closes.
//
// THE EXPLICIT PLAN IS THE OPT-IN. `plan.schools` naming a school is an operator
// deciding to start it on purpose, and that is honoured. Everything else -- an
// inferred queue, an explicit single ability, a future planner reaching for a meal --
// is refused with a reason, never dropped silently.
export function knowsSchool(known = [], school) {
  if (!school) return false;
  return (known || []).some(r => r?.kind === 'spell' && norm(r.school) === norm(school));
}

// One predicate, two consumers -- the filter below and the report beside it -- because
// a rule with two implementations is how this repository gets two answers.
export function crossSchoolRefusal(row, known = [], plan = null) {
  if (!row || row.kind !== 'spell') return null;         // skills are not schooled
  const school = row.school ?? null;
  if (!school) return null;                              // unknown school: not our call
  if (knowsSchool(known, school)) return null;           // already a caster of it
  const chosen = Object.keys(plan?.schools ?? {}).some(k => norm(k) === norm(school));
  if (chosen) return null;                               // the operator asked for it
  return `${row.name} is a ${school} spell and this character is not a ${school} ` +
         `caster. Buying into a school it does not cast leaves it confused. Name ` +
         `"${school}" in the loadout's plan.schools if that is genuinely intended.`;
}

// What the guard WOULD refuse, for a report, without building a queue.
export function crossSchoolRefusals(plan, abilities = [], known = []) {
  return (abilities || [])
    .map(row => ({ row, why: crossSchoolRefusal(row, known, plan) }))
    .filter(x => x.why)
    .map(x => ({ name: x.row.name, school: x.row.school ?? null, why: x.why }));
}

export function plannedAbilities(plan, abilities = [], known = []) {
  const out = [];
  const refusals = [];
  const key = row => `${row?.kind ?? ''}:${norm(row?.name)}`;
  const knownKeys = new Set((known || []).map(key));
  const outKeys = new Set();
  let stage = 0;
  const add = (row, why) => {
    const exact = `${row.kind ?? ''}:${norm(row.name)}`, generic = `:${norm(row.name)}`;
    if (!row.name || knownKeys.has(exact) || outKeys.has(exact) || outKeys.has(generic)) return;
    // A school this character does not cast is refused here, at the one place every
    // purchase path passes through. Reported on the row rather than dropped, so a
    // queue that came back short says why it did.
    const refused = crossSchoolRefusal(row, known, plan);
    if (refused) { refusals.push({ name: row.name, school: row.school ?? null, why: refused }); return; }
    out.push({ ...row, why: row.why ?? why ?? null, queue_stage: stage });
    outKeys.add(exact);
  };
  const rowsAt = (track, level) => (abilities || []).filter(row => {
    if (track === 'weaponcraft')
      return row.kind === 'skill' && row.learnable !== false && row.for_sale !== false &&
        Number(row.level) === Number(level);
    return row.kind === 'spell' && norm(row.school) === norm(track) &&
      Number(row.level) === Number(level);
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const addTrackLevel = (track, level) => {
    stage++;
    for (const row of rowsAt(track, level)) add({ name: row.name, kind: row.kind,
      level: row.level, school: row.school ?? null, track }, `${track} level ${level} queue`);
  };
  const addAbility = entry => {
    stage++;
    const kinds = entry.kind ? [entry.kind] : ['skill', 'spell'];
    const matches = (abilities || []).filter(row => kinds.includes(row.kind) &&
      norm(row.name) === norm(entry.name));
    const row = matches.length === 1 ? matches[0] : entry;
    add({ ...entry, kind: row.kind ?? entry.kind ?? null, level: row.level ?? entry.level ?? null,
      school: row.school ?? entry.school ?? null }, entry.why ?? 'explicit ability queue');
  };

  const queue = Array.isArray(plan?.learning_queue) ? plan.learning_queue : [];
  if (queue.length) {
    for (const entry of queue) {
      if (entry?.name) addAbility(entry);
      else if (entry?.track && entry?.level) addTrackLevel(entry.track, entry.level);
    }
    return withRefusals(out, refusals);
  }

  for (const entry of (plan?.abilities ?? [])) addAbility(entry);
  for (const [school, targetLevel] of Object.entries(plan?.schools ?? {})
    .sort(([a], [b]) => a.localeCompare(b))) {
    for (let level = 1; level <= Number(targetLevel); level++) addTrackLevel(school, level);
  }
  if (Number(plan?.weapon_level) > 0) {
    for (let level = 1; level <= Number(plan.weapon_level); level++) addTrackLevel('weaponcraft', level);
  }
  return withRefusals(out, refusals);
}

// The queue is still a plain array -- every existing caller iterates it and must keep
// working -- so what the guard turned away rides along as a non-enumerable property.
// A queue that came back short can then say why without anybody having to ask.
function withRefusals(out, refusals) {
  Object.defineProperty(out, 'refusals', { value: refusals, enumerable: false });
  return out;
}

function normaliseLearningQueue(raw, problems) {
  const out = [];
  for (const [i, value] of (Array.isArray(raw) ? raw : []).entries()) {
    const entry = typeof value === 'string' ? { track: value } : (value || {});
    if (entry.name) {
      const name = String(entry.name).trim();
      if (!name) { problems.push(`plan.learning_queue[${i}] has no ability name`); continue; }
      out.push({ name, kind: entry.kind === 'skill' || entry.kind === 'spell' ? entry.kind : null });
      continue;
    }
    const track = String(entry.track ?? entry.school ?? '').trim();
    const level = numOr(entry.level, null);
    if (!track || level === null || level < 1 || level > 6) {
      problems.push(`plan.learning_queue[${i}] must name a track and a level from 1 to 6`);
      continue;
    }
    out.push({ track: ['weapon', 'weapons', 'skills', 'weapon skills']
      .includes(norm(track)) ? 'weaponcraft' : track, level: Math.round(level) });
  }
  return out;
}

// The slots the keeper's wearBest knows about, plus the hand. Anything else in `slots` is
// carried through untouched and reported — a slot this file has not heard of is a fact
// about the loadout, not an error to swallow.
export const GEAR_SLOTS = ['body', 'shield', 'head', 'hands', 'feet', 'neck', 'finger', 'cloak'];

const numOr = (v, d = null) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))
  ? d : Number(v));

// TURN WHATEVER WAS ON DISK INTO THE ONE SHAPE EVERY READER EXPECTS, and say what was
// wrong with it rather than throwing. A loadout is hand-editable and comes off a web
// form; the failure mode that matters is not a malformed file, it is a file that parses
// and means something slightly different from what its author intended.
export function normalise(raw, { character = null } = {}) {
  const problems = [];
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = blank(character ?? src.character ?? '', src.agent ?? null);

  if (src.format && src.format !== LOADOUT_FORMAT)
    problems.push(`format is "${src.format}", not "${LOADOUT_FORMAT}" — reading it anyway`);
  out.character = String(character ?? src.character ?? '').trim();
  out.agent = src.agent ? String(src.agent) : null;
  out.updated = src.updated ?? null;
  out.note = typeof src.note === 'string' ? src.note.slice(0, 2000) : '';
  if (!out.character) problems.push('no character name');

  // ---- the plan half: what the character is trying to become.
  const schools = {};
  for (const [k, v] of Object.entries(src.plan?.schools ?? {})) {
    const lvl = numOr(v, null);
    if (lvl === null || lvl < 0) { problems.push(`school "${k}": ${JSON.stringify(v)} is not a level`); continue; }
    // Six is the length of vlLevelPoints (system.kod:414). A seventh level is not a
    // stretch goal, it is a number the server has no entry for.
    if (lvl > 6) { problems.push(`school "${k}": level ${lvl} — the game has six`); continue; }
    schools[k] = Math.round(lvl);
  }
  out.plan.schools = schools;
  out.plan.weapon_level = numOr(src.plan?.weapon_level, null);
  const learningTarget = src.plan?.learning_target;
  if (learningTarget !== null && learningTarget !== undefined && learningTarget !== '') {
    const raw = typeof learningTarget === 'string' ? learningTarget
      : learningTarget && typeof learningTarget === 'object'
        ? learningTarget.track ?? learningTarget.school ?? learningTarget.name
        : null;
    if (!raw || !String(raw).trim()) problems.push('plan.learning_target is not a track name');
    else out.plan.learning_target = String(raw).trim().slice(0, 80);
  }
  out.plan.learning_queue = normaliseLearningQueue(src.plan?.learning_queue, problems);
  out.plan.abilities = (Array.isArray(src.plan?.abilities) ? src.plan.abilities : [])
    .map(a => (typeof a === 'string' ? { name: a } : a))
    .filter(a => a && a.name)
    .map(a => ({
      name: String(a.name).trim(),
      kind: a.kind === 'spell' || a.kind === 'skill' ? a.kind : null,
      // The game's own price, 250 * 2^level with no markup (monster.kod:4880). Recorded
      // by the planner so an errand can withdraw before setting off; recomputed rather
      // than trusted when it is missing.
      level: numOr(a.level, null),
      why: a.why ? String(a.why).slice(0, 200) : null,
    }));

  // ---- the carrying half: what the keeper acts on.
  const seen = new Set();
  for (const e of (Array.isArray(src.carry) ? src.carry : [])) {
    const item = typeof e === 'string' ? { item: e } : (e || {});
    const name = String(item.item ?? item.name ?? '').trim();
    if (!name) { problems.push('a carry entry with no item name'); continue; }
    const key = norm(name);
    if (seen.has(key)) { problems.push(`"${name}" is listed twice — the later one wins`); }
    seen.add(key);
    let min = numOr(item.min, 0);
    let max = numOr(item.max, null);
    if (min < 0) { problems.push(`"${name}": min ${min} is below zero, read as 0`); min = 0; }
    // A MAX BELOW A MIN IS A TRAP THAT NEVER SETTLES: the keeper buys up to min and then
    // sells back down to max, for ever, paying the vendor spread on every lap. Raise the
    // max to the min and say so, rather than honouring a pair of numbers that cannot both
    // be satisfied.
    if (max !== null && max < min) {
      problems.push(`"${name}": max ${max} is below min ${min} — raised to ${min}, ` +
                    'or the keeper would buy and sell the same item for ever');
      max = min;
    }
    const known = catalogue().get(key);
    if (!known && catalogue().size)
      problems.push(`"${name}" is not in the item catalogue — kept, but check the spelling ` +
                    '(names are the game\'s own display names)');
    out.carry.push({
      item: name, min, max,
      match: item.match === 'contains' || item.match === 'prefix' ? item.match : 'exact',
      why: item.why ? String(item.why).slice(0, 200) : (known?.reagent_for?.length
        ? `reagent for ${known.reagent_for.slice(0, 3).map(r => r.spell).join(', ')}` : null),
      weight: known?.weight ?? null,
      kind: known?.kind ?? null,
    });
  }

  const nameList = (v, label) => (Array.isArray(v) ? v : [])
    .map(x => String(typeof x === 'string' ? x : x?.item ?? '').trim())
    .filter(x => { if (!x) problems.push(`an empty entry in ${label}`); return !!x; });
  out.sell = nameList(src.sell, 'sell');
  out.keep = nameList(src.keep, 'keep');

  // BOTH LISTS AT ONCE IS NOT A PREFERENCE, IT IS A CONTRADICTION, and it has a safe
  // direction: keeping something we should have sold costs a slot, selling something we
  // meant to keep costs the item. So keep wins, loudly.
  for (const s of out.sell) if (out.keep.some(k => norm(k) === norm(s)))
    problems.push(`"${s}" is on both the sell and keep lists — kept`);
  // And an item with a floor under it cannot also be sell-fodder, for the same reason.
  for (const s of out.sell) {
    const c = out.carry.find(x => norm(x.item) === norm(s));
    if (c && c.min > 0) problems.push(`"${s}" is sell-on-sight but ${c.min} are wanted — the floor wins`);
  }

  const weapons = nameList(src.gear?.weapon, 'gear.weapon');
  out.gear.weapon = weapons;
  for (const [slot, v] of Object.entries(src.gear?.slots ?? {})) {
    const list = nameList(v, `gear.slots.${slot}`);
    if (!list.length) continue;
    if (!GEAR_SLOTS.includes(slot))
      problems.push(`slot "${slot}" is not one this repository knows (${GEAR_SLOTS.join(', ')}) — carried through`);
    out.gear.slots[slot] = list;
  }
  out.gear.from = src.gear?.from ? String(src.gear.from).slice(0, 200) : null;

  out.purse.float = numOr(src.purse?.float, null);
  out.purse.bank_above = numOr(src.purse?.bank_above, null);

  // ---- the policy half: what this character's keeper should be set to after a restart.
  //
  // AN UNRECOGNISED KEY IS REPORTED AND DROPPED, NEVER CARRIED THROUGH. Carrying it would
  // put a setting on disk that reads as configuration and does nothing — which is exactly
  // how `purpose` sat outside the autopilot schema for a year while every keeper in the
  // fleet ran with an audit switched off that everybody believed was on.
  //
  // AN UNUSABLE VALUE IS REPORTED AND DROPPED TOO, rather than being coerced. `karma: "no"`
  // becoming 0 is a policy nobody wrote.
  const rawPolicy = (src.policy && typeof src.policy === 'object' && !Array.isArray(src.policy))
    ? src.policy : {};
  if (src.policy && typeof src.policy !== 'object')
    problems.push('policy is not an object — ignored');
  for (const [k, v] of Object.entries(rawPolicy)) {
    const spec = POLICY_KEYS[k];
    if (!spec) {
      problems.push(`policy."${k}" is not a setting a loadout may make ` +
                    `(${Object.keys(POLICY_KEYS).join(', ')}) — dropped`);
      continue;
    }
    if (v === null || v === undefined || v === '') continue;   // silence means "leave it"
    if (spec.type === 'number') {
      const n = numOr(v, null);
      if (n === null) { problems.push(`policy.${k}: ${JSON.stringify(v)} is not a number — dropped`); continue; }
      out.policy[k] = n;
    } else if (spec.type === 'boolean') {
      if (typeof v !== 'boolean') { problems.push(`policy.${k}: ${JSON.stringify(v)} is not true or false — dropped`); continue; }
      out.policy[k] = v;
    } else {
      const str = String(v).trim();
      if (!str) { problems.push(`policy.${k} is empty — dropped`); continue; }
      out.policy[k] = str.slice(0, 120);
    }
  }

  return { loadout: out, problems };
}

// ------------------------------------------------------------------ disk

export function listLoadouts() {
  let files = [];
  try { files = fs.readdirSync(LOADOUT_DIR).filter(f => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files.sort()) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(LOADOUT_DIR, f), 'utf8'));
      const { loadout, problems } = normalise(raw);
      out.push({ file: f, path: path.join(LOADOUT_DIR, f), loadout, problems,
                 mtime: fs.statSync(path.join(LOADOUT_DIR, f)).mtimeMs });
    } catch (e) {
      out.push({ file: f, path: path.join(LOADOUT_DIR, f), loadout: null,
                 problems: [`could not read it: ${e.message}`], mtime: 0 });
    }
  }
  return out;
}

export function readLoadout(character) {
  const p = loadoutPath(character);
  if (!p || !fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { ...normalise(raw, { character: raw.character ?? character }), path: p };
}

export function writeLoadout(character, raw, { force = false } = {}) {
  const p = loadoutPath(character);
  if (!p) throw new Error(`"${character}" is not a usable character name`);
  const { loadout, problems } = normalise(raw, { character: raw?.character ?? character });
  // TWO NAMES CAN SLUG TO ONE FILE, AND THE LOSER IS OVERWRITTEN SILENTLY. `slugOf` drops
  // everything that is not a letter or a digit, so "Kermit" and "Kermit the Frog!" differ
  // by punctuation and land on the same path — and the second save would replace the
  // first character's whole loadout while reporting success. Refuse instead, unless the
  // caller means it.
  if (!force && fs.existsSync(p)) {
    let held = null;
    try { held = JSON.parse(fs.readFileSync(p, 'utf8')).character ?? null; } catch { /* unreadable: let the write fix it */ }
    if (held && norm(held) !== norm(loadout.character))
      throw new Error(`${path.basename(p)} already holds "${held}", not "${loadout.character}" — ` +
                      'two names that differ only by punctuation share one file');
  }
  loadout.updated = new Date().toISOString();
  fs.mkdirSync(LOADOUT_DIR, { recursive: true });
  // Written whole and renamed into place. The keeper reads this file on a timer, and a
  // half-written one parses as a syntax error at exactly the moment somebody is changing
  // what a live character is supposed to carry.
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(loadout, null, 1));
  fs.renameSync(tmp, p);
  return { path: p, loadout, problems };
}

// ------------------------------------------------------------------ one answer, every character
//
// THE GEAR HALF IS THE ONE PART OF A LOADOUT THAT IS ABOUT THE FLEET RATHER THAN ABOUT A
// CHARACTER. How many reagents this caster burns, which schools it is heading for, what its
// purse floor is — all of that is one character's business. "Fight with a short sword, wear
// leather, carry a shield" is a decision about how the fleet plays, and the only way to give
// it to twenty-one characters was to type it twenty-one times.
//
// So this copies the GEAR AND NOTHING ELSE. Every other field of an existing loadout is left
// exactly as it was found — that is what makes it safe to run across characters somebody has
// already planned by hand, and it is the property the tests pin hardest.
//
// AN EMPTY GEAR IS REFUSED, because it is not a request. A loadout with no gear in it is the
// ordinary state of one nobody has filled in yet, so a fleet-wide write of it would silently
// clear twenty-one characters' weapon preferences and report success — which is exactly the
// shape of every failure this repository has already paid for. `allowEmpty` is how somebody
// says they meant it.

const cloneGear = (g) => ({
  weapon: [...(g?.weapon ?? [])],
  slots: Object.fromEntries(Object.entries(g?.slots ?? {}).map(([k, v]) => [k, [...v]])),
  from: g?.from ?? null,
});

const cloneCarry = (carry) => (carry ?? []).map(c => ({ ...c }));

export const gearIsEmpty = (gear) =>
  !(gear?.weapon?.length) && !Object.values(gear?.slots ?? {}).some(v => v?.length);

// Two gear stanzas are the same answer when they name the same things IN THE SAME ORDER.
// The order is the preference — first choice first — so a list reordered is a different
// instruction, and reporting it as "no change" would hide the only edit somebody made.
// `from` is provenance, not preference, and is deliberately not compared.
export function sameGear(a, b) {
  const key = (g) => JSON.stringify([
    (g?.weapon ?? []).map(norm),
    Object.keys(g?.slots ?? {}).filter(s => (g.slots[s] ?? []).length).sort()
      .map(s => [norm(s), g.slots[s].map(norm)]),
  ]);
  return key(a) === key(b);
}

// Carry-list order is useful to a reader, so reordering it is a real edit just as
// reordering a gear preference is. `weight` and `kind` are derived catalogue annotations,
// not instructions to the keeper, and are deliberately not compared.
export function sameCarry(a, b) {
  const key = (carry) => JSON.stringify((carry ?? []).map(c => [
    norm(c?.item), Number(c?.min ?? 0), c?.max == null ? null : Number(c.max),
    c?.match ?? 'exact', c?.why ?? null,
  ]));
  return key(a) === key(b);
}

// Run a gear stanza through the same normalise() everything else goes through, so a
// fleet-wide write cannot mean something a single save would not.
export function normaliseGear(gear) {
  const { loadout, problems } = normalise({ character: 'x', gear }, { character: 'x' });
  return { gear: loadout.gear, problems };
}

// Gear and carry go through the same normaliser as a one-character save. Presence matters:
// an omitted section means "leave this section alone"; an explicitly supplied empty
// section means "clear it" and requires allowEmpty when the entire shared plan is empty.
export function normaliseFleetInventory(raw = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(raw, key);
  const sections = { gear: has('gear'), carry: has('carry') };
  const src = { character: 'x' };
  if (sections.gear) src.gear = raw.gear;
  if (sections.carry) src.carry = raw.carry;
  const { loadout, problems } = normalise(src, { character: 'x' });
  return {
    sections,
    gear: sections.gear ? loadout.gear : null,
    carry: sections.carry ? loadout.carry : null,
    problems,
  };
}

// Plan and apply are the same function, called twice. `characters` is
// [{character, agent}] or plain names; the caller decides whether that is a checked subset
// or the live fleet. Nothing here asks a broker because this layer only knows about files.
export function applyInventoryToAll(raw, characters,
                                    { from = null, apply = false, allowEmpty = false } = {}) {
  const want = normaliseFleetInventory(raw);
  if (!want.sections.gear && !want.sections.carry)
    throw new Error('no gear or carry list was supplied - nothing to apply');
  if ((!want.sections.gear || gearIsEmpty(want.gear)) &&
      (!want.sections.carry || !want.carry.length) && !allowEmpty)
    throw new Error('this plan has no gear or carry list on it - nothing to apply. Empty shared ' +
                    'inventory is not an instruction to clear every selected loadout.');

  const stamp = from
    ? `${String(from).slice(0, 120)}${apply ? `, ${new Date().toISOString().slice(0, 16).replace('T', ' ')}` : ''}`
    : null;
  const rows = [];
  for (const c of characters ?? []) {
    const character = String((typeof c === 'string' ? c : c?.character) ?? '').trim();
    const agent = typeof c === 'string' ? null : (c?.agent ?? null);
    const row = {
      character, agent, had: false, created: false, changed: false,
      gear_changed: false, carry_changed: false,
      before: null, after: null, path: null, error: null,
    };
    rows.push(row);

    if (!slugOf(character)) { row.error = 'not a usable character name'; continue; }

    let existing = null;
    try { existing = readLoadout(character); }
    catch (e) {
      // A file that will not parse is left alone. Replacing it with only the shared fields
      // would erase rules nobody can currently inspect and make the loss look intentional.
      row.error = `${loadoutPath(character)} could not be read (${e.message}) - left alone`;
      continue;
    }
    if (existing && norm(existing.loadout.character) !== norm(character)) {
      row.error = `${path.basename(existing.path)} holds "${existing.loadout.character}", not ` +
                  `"${character}" - two names that differ only by punctuation share one file`;
      continue;
    }

    const beforeGear = existing ? cloneGear(existing.loadout.gear) : cloneGear(null);
    const beforeCarry = existing ? cloneCarry(existing.loadout.carry) : [];
    row.had = !!existing;
    row.created = !existing;
    row.before = existing ? { gear: beforeGear, carry: beforeCarry } : null;
    row.gear_changed = want.sections.gear && (!existing || !sameGear(beforeGear, want.gear));
    row.carry_changed = want.sections.carry && (!existing || !sameCarry(beforeCarry, want.carry));
    row.changed = !existing || row.gear_changed || row.carry_changed;

    const afterGear = want.sections.gear && row.gear_changed
      ? { ...cloneGear(want.gear), from: stamp }
      : beforeGear;
    const afterCarry = want.sections.carry ? cloneCarry(want.carry) : beforeCarry;
    row.after = { gear: afterGear, carry: afterCarry };
    if (!apply || !row.changed) { if (existing) row.path = existing.path; continue; }

    const next = existing ? { ...existing.loadout } : blank(character, agent);
    if (want.sections.gear && row.gear_changed) next.gear = afterGear;
    if (want.sections.carry) next.carry = afterCarry;
    if (!next.agent && agent) next.agent = agent;
    try {
      const out = writeLoadout(character, next);
      row.path = out.path;
      row.after = { gear: cloneGear(out.loadout.gear), carry: cloneCarry(out.loadout.carry) };
    } catch (e) {
      row.error = e.message;
      row.changed = false;
      row.gear_changed = false;
      row.carry_changed = false;
    }
  }

  return {
    applied: !!apply,
    gear: want.gear ? cloneGear(want.gear) : null,
    carry: want.carry ? cloneCarry(want.carry) : null,
    sections: want.sections,
    from: from ?? null,
    problems: want.problems,
    rows,
    counts: {
      total: rows.length,
      changed: rows.filter(r => r.changed && !r.error).length,
      unchanged: rows.filter(r => !r.changed && !r.error).length,
      created: rows.filter(r => r.created && !r.error).length,
      failed: rows.filter(r => r.error).length,
    },
  };
}

// PLANNING AND APPLYING ARE THE SAME FUNCTION, called twice. A preview computed by different
// code from the write it previews is a preview of something else — and this one writes to
// every character at once, which is the worst possible place for that gap.
//
// `characters` is [{character, agent}] or plain names. Nothing here asks a broker who the
// fleet is: the caller decides that, because "the fleet" is a live question and this file
// only knows about files.
export function applyGearToAll(gear, characters, { from = null, apply = false, allowEmpty = false } = {}) {
  const { gear: want, problems } = normaliseGear(gear);
  if (gearIsEmpty(want) && !allowEmpty)
    throw new Error('this plan has no gear on it — nothing to apply. An empty gear list is not ' +
                    'an instruction to strip the fleet, it is a loadout nobody has filled in yet.');

  const stamp = from ? `${String(from).slice(0, 120)}${apply ? `, ${new Date().toISOString().slice(0, 16).replace('T', ' ')}` : ''}` : null;
  const rows = [];
  for (const c of characters ?? []) {
    const character = String((typeof c === 'string' ? c : c?.character) ?? '').trim();
    const agent = typeof c === 'string' ? null : (c?.agent ?? null);
    const row = { character, agent, had: false, created: false, changed: false,
                  before: null, after: null, path: null, error: null };
    rows.push(row);

    if (!slugOf(character)) { row.error = 'not a usable character name'; continue; }

    let existing = null;
    try { existing = readLoadout(character); }
    catch (e) {
      // A FILE THAT WILL NOT PARSE IS LEFT ALONE. Overwriting it would replace a loadout
      // whose contents nobody can now see with one holding only gear, and the carry list
      // that went missing would look like something nobody ever wrote.
      row.error = `${loadoutPath(character)} could not be read (${e.message}) — left alone`;
      continue;
    }
    // Two names that differ only by punctuation share one file (see writeLoadout). Across a
    // whole fleet that is a collision waiting to happen, and the loser would be overwritten
    // with somebody else's gear.
    if (existing && norm(existing.loadout.character) !== norm(character)) {
      row.error = `${path.basename(existing.path)} holds "${existing.loadout.character}", not ` +
                  `"${character}" — two names that differ only by punctuation share one file`;
      continue;
    }

    row.had = !!existing;
    row.created = !existing;
    row.before = existing ? cloneGear(existing.loadout.gear) : null;
    row.changed = !existing || !sameGear(existing.loadout.gear, want);
    // An unchanged row is not rewritten, so what it will hold afterwards is what it holds
    // now — including its own provenance. Restamping a file the keeper is reading, to record
    // that nothing about it changed, is a write with no reader.
    row.after = row.changed ? { ...cloneGear(want), from: stamp } : cloneGear(existing.loadout.gear);
    if (!apply || !row.changed) { if (existing) row.path = existing.path; continue; }

    const raw = existing ? { ...existing.loadout } : blank(character, agent);
    raw.gear = { ...cloneGear(want), from: stamp };
    if (!raw.agent && agent) raw.agent = agent;
    try {
      const out = writeLoadout(character, raw);
      row.path = out.path;
      row.after = cloneGear(out.loadout.gear);
    } catch (e) { row.error = e.message; row.changed = false; }
  }

  return {
    applied: !!apply,
    gear: cloneGear(want),
    from: from ?? null,
    problems,
    rows,
    counts: {
      total: rows.length,
      changed: rows.filter(r => r.changed && !r.error).length,
      unchanged: rows.filter(r => !r.changed && !r.error).length,
      created: rows.filter(r => r.created && !r.error).length,
      failed: rows.filter(r => r.error).length,
    },
  };
}

// WHAT THE KEEPER CALLS, EVERY PASS, FOR TWENTY-ONE CHARACTERS. So it caches on mtime and
// costs a stat() when nothing has changed — and it never throws, because a keeper that
// dies on a malformed loadout is a character that stops playing because somebody typed a
// stray comma into a web form.
const CACHE = new Map();       // slug -> { mtime, loadout, problems }
export function loadoutFor(character) {
  const slug = slugOf(character);
  if (!slug) return null;
  const p = path.join(LOADOUT_DIR, slug + '.json');
  let mtime = 0;
  try { mtime = fs.statSync(p).mtimeMs; } catch { CACHE.delete(slug); return null; }
  const hit = CACHE.get(slug);
  if (hit && hit.mtime === mtime) return hit.loadout;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const { loadout, problems } = normalise(raw, { character: raw.character ?? character });
    CACHE.set(slug, { mtime, loadout, problems });
    return loadout;
  } catch {
    // A broken file is remembered as broken so it is not re-read and re-parsed every pass.
    CACHE.set(slug, { mtime, loadout: null, problems: ['unparseable'] });
    return null;
  }
}
export const forgetLoadouts = () => CACHE.clear();

// WHEN THIS CHARACTER'S LOADOUT WAS LAST WRITTEN, or 0 if there is not one.
//
// The policy overlay needs this rather than the loadout's contents: it re-applies when
// somebody EDITS the file, and leaves a runtime setting alone in between. Reading the
// mtime directly rather than diffing the parsed policy is deliberate — a file saved with
// no change to the policy block is still somebody opening the planner and pressing save,
// which is as clear a statement of "make it say this" as an edit to the block itself.
export function loadoutMtime(character) {
  const slug = slugOf(character);
  if (!slug) return 0;
  try { return fs.statSync(path.join(LOADOUT_DIR, slug + '.json')).mtimeMs; }
  catch { return 0; }
}

// ------------------------------------------------------------------ matching

// Does this display name satisfy this entry? Exact unless the entry asked otherwise.
export function entryMatches(entry, name) {
  const n = norm(name), want = norm(entry.item ?? entry);
  if (!n || !want) return false;
  const how = entry.match ?? 'exact';
  if (how === 'contains') return n.includes(want);
  if (how === 'prefix') return n.startsWith(want);
  return n === want;
}

const countIn = (items, entry) => (items || [])
  .filter(i => entryMatches(entry, i.name))
  .reduce((t, i) => t + (i.amount ?? i.count ?? 1), 0);

// ------------------------------------------------------------------ what the keeper asks

// EVERYTHING THIS LOADOUT PROTECTS, as one test. Returns null when the loadout has nothing
// to say, and null is the answer that means "use the behaviour that was already there" —
// callers must not read it as "protects nothing".
// THE SAME PROTECTION, FLATTENED TO NAMES, FOR A DOOR THAT ONLY TAKES NAMES.
//
// `keepTest` is a predicate and the right answer everywhere it fits. It does not fit the
// keeper: `sell_all` on a keeper-backed character is an HTTP action whose `keep` argument is
// an array of name fragments, and a predicate does not cross that wire. Every character on
// prod is keeper-backed, so without this the loadout was consulted on the branch nothing uses
// and dropped on the branch everything uses — see the incident in m59-broker.mjs.
//
// WHAT IS LOST, said plainly rather than discovered later: a FLOOR becomes a name. A carry
// entry of `{item: 'sapphire', min: 24, max: 120}` protects the first 24 in `keepTest` and
// protects every sapphire here. That is the direction `keepTest` itself already declares safe
// when it has no inventory — "it declines to sell something it might need rather than selling
// something it does" — and the cost is income rather than a silent caster. A `max` overflow is
// not sold by this path either; that needs the pack, and the pack is in the keeper.
//
// AND THE MATCHING CHANGES HANDS AT THE SAME SEAM. `entryMatches` honours a carry entry's
// `match: exact|contains|prefix`; the keeper tests `name.toLowerCase().includes(k)`, always a
// substring. So an EXACT entry for `mushroom` arrives at the counter protecting `red mushroom`
// too. That is wider than the loadout asked for and it is the direction this fleet wants —
// four of the five mushrooms are bless reagents — but it is a real difference, not a detail:
// `keep: ['mace']` has twice protected the thing called "broken mace" through this same rule.
//
// Returns [] rather than null when a loadout protects nothing by name, because the caller
// concatenates: null would have to be handled by every one of them and [] cannot be misread.
export function protectedNames(loadout) {
  if (!loadout) return [];
  const out = [];
  for (const k of loadout.keep ?? []) out.push(k);
  for (const w of loadout.gear?.weapon ?? []) out.push(w);
  for (const list of Object.values(loadout.gear?.slots ?? {})) for (const g of list) out.push(g);
  // A floor of zero is not a floor — it is the absence of one — and m59-loadout has said so
  // since the graveyard shift zeroed nineteen of them. Only a real floor protects.
  for (const c of loadout.carry ?? []) if (c.min > 0) out.push(c.item);
  const seen = new Set();
  return out.filter(n => {
    const k = String(n).trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function keepTest(loadout, items = null) {
  if (!loadout) return null;
  const rules = [];
  for (const k of loadout.keep) rules.push({ entry: { item: k }, why: 'on the keep list' });
  for (const w of loadout.gear.weapon) rules.push({ entry: { item: w }, why: 'a weapon this character is meant to fight with' });
  for (const [slot, list] of Object.entries(loadout.gear.slots))
    for (const g of list) rules.push({ entry: { item: g }, why: `this character's ${slot}` });
  // A CARRIED ITEM IS PROTECTED ONLY UP TO ITS FLOOR, WHICH MEANS THE TEST NEEDS THE PACK.
  // Twelve elderberry with a floor of twelve are all protected; the thirteenth is not, and
  // a keep test that cannot count cannot tell them apart. Without an inventory the floor
  // is treated as protecting the whole stack, which is the safe direction: it declines to
  // sell something it might need rather than selling something it does.
  for (const c of loadout.carry) {
    if (c.min <= 0) continue;
    const have = items ? countIn(items, c) : null;
    rules.push({ entry: c, why: have === null ? `wanted, ${c.min} minimum`
                                              : `${have} held against a floor of ${c.min}`,
                 floor: c.min, have });
  }
  if (!rules.length) return null;
  const test = (name) => {
    for (const r of rules) {
      if (!entryMatches(r.entry, name)) continue;
      // Above the floor the surplus is fair game — that is what a maximum is for.
      if (r.floor != null && r.have != null && r.have > r.floor) continue;
      return r.why;
    }
    return null;
  };
  test.rules = rules;
  return test;
}

// THINGS THIS CHARACTER HAS SAID IT DOES NOT WANT. Separate from "not protected", because
// the two lead to different actions: unprotected loot is sold when a shop happens to be
// there, and sell-fodder is why the trip is worth making.
export function sellTest(loadout) {
  if (!loadout || !loadout.sell.length) return null;
  const keep = keepTest(loadout);
  return (name) => {
    if (keep && keep(name)) return null;            // keep always wins; normalise said so
    for (const s of loadout.sell) if (entryMatches({ item: s }, name)) return 'on the sell list';
    return null;
  };
}

// WHAT IS SHORT AND WHAT IS SURPLUS, in the vocabulary the fleet's interest board speaks.
// This is what lets one character's shopping list stop another character selling the thing
// it needs, which the board already does for elderberry and herbs and could not do for
// anything else because nothing else had a target.
// `needs` is the QUANTITY half of `wants`, and the two are deliberately both returned.
// `wants` answers "may somebody sell this", which only needs a name; `needs` answers "how
// many should a courier buy", which a name cannot. Farm delivery reads the second, and
// until it existed the board could only ever state a shortfall of elderberry or herbs —
// so a caster short of forty mushrooms was invisible to the one mechanism that fetches
// things. A want with no quantity is not a delivery order.
export function wantsOf(loadout, items) {
  if (!loadout) return null;
  const wants = [], needs = new Map(), spare = new Map();
  for (const c of loadout.carry) {
    const have = countIn(items, c);
    if (have < c.min) { wants.push(norm(c.item)); needs.set(norm(c.item), c.min - have); }
    else if (c.max !== null && have > c.max) spare.set(norm(c.item), have - c.max);
  }
  return { wants, needs, spare };
}

// ------------------------------------------------------------------ reconcile
//
// The whole loadout against a real pack: what to buy, what to sell, what not to touch, and
// in what order to give things up when the bags are full.
export function reconcile(loadout, { items = [], equipped = [] } = {}) {
  if (!loadout) return null;
  const wornNames = new Set((equipped || []).map(e => norm(e.name ?? e)));
  const buy = [], sell = [], keep = [];

  for (const c of loadout.carry) {
    const have = countIn(items, c);
    if (have < c.min)
      buy.push({ item: c.item, have, want: c.min, short: c.min - have, why: c.why,
                 weight: c.weight, kind: c.kind });
    else if (c.max !== null && have > c.max)
      sell.push({ item: c.item, have, keep_back: c.max, over: have - c.max,
                  why: `above the ${c.max} this character asked for` });
    if (c.min > 0) keep.push({ item: c.item, upto: c.min, have, why: c.why ?? 'wanted' });
  }

  for (const s of loadout.sell) {
    const have = countIn(items, { item: s });
    if (have > 0) sell.push({ item: s, have, keep_back: 0, over: have, why: 'on the sell list' });
  }
  for (const k of loadout.keep) keep.push({ item: k, upto: null, why: 'on the keep list' });

  // GEAR IS A PREFERENCE LIST AND THE ANSWER IS "THE BEST ONE WE HAVE", not "the first
  // one". A character that owns its second choice is not missing its gear; it is one
  // upgrade short, and reporting those the same way is how an outfitting run buys a mace
  // for somebody already carrying one.
  const gearFor = (list) => {
    const held = list.map((n, i) => ({ n, i, have: countIn(items, { item: n }) })).filter(x => x.have > 0);
    const best = held.length ? held.reduce((a, b) => (a.i <= b.i ? a : b)) : null;
    return {
      want: list,
      have: best ? best.n : null,
      worn: best ? wornNames.has(norm(best.n)) : false,
      missing: !best,
      // Only a real upgrade, and only when something better is actually listed above it.
      upgrade_to: best && best.i > 0 ? list.slice(0, best.i) : null,
    };
  };
  const gear = { weapon: loadout.gear.weapon.length ? gearFor(loadout.gear.weapon) : null, slots: {} };
  for (const [slot, list] of Object.entries(loadout.gear.slots)) gear.slots[slot] = gearFor(list);
  for (const g of [gear.weapon, ...Object.values(gear.slots)]) {
    if (!g) continue;
    if (g.missing) buy.push({ item: g.want[0], have: 0, want: 1, short: 1, why: 'gear this character is missing', gear: true });
    for (const n of g.want) keep.push({ item: n, upto: null, why: 'gear' });
  }

  const purse = (items || []).filter(i => /shilling/i.test(i.name ?? ''))
    .reduce((t, i) => t + (i.amount ?? 1), 0);

  return {
    character: loadout.character,
    buy, sell, keep, gear,
    purse: { have: purse, float: loadout.purse.float,
             spendable: loadout.purse.float === null ? null : Math.max(0, purse - loadout.purse.float),
             bank_above: loadout.purse.bank_above },
    // The one number an outfitting run needs before it sets off, and it is knowable: item
    // values are viValue_average and a skill is 250*2^level with no markup. Null for
    // anything the catalogue cannot price, and stated as a floor rather than a total, so
    // nobody withdraws against it as though it were exact.
    at_least: buy.reduce((t, b) => {
      const v = catalogue().get(norm(b.item))?.value;
      return v == null ? t : t + v * (b.short ?? 1);
    }, 0),
    ok: !buy.length && !sell.length,
    summary: buy.length || sell.length
      ? [buy.length ? `${buy.length} short` : null, sell.length ? `${sell.length} to shed` : null]
        .filter(Boolean).join(', ')
      : 'as asked',
  };
}

// ------------------------------------------------------- is this run closing the gap?
//
// THE EQUIPMENT HALF OF yieldCheck, AND THE REASON IT HAS TO EXIST AT ALL.
//
// `purpose: 'advance'` asks whether the thing being killed can still raise what the
// character is trying to raise, and says so out loud when it cannot — because a keeper
// grinding worthless prey looks EXACTLY like a healthy one: it kills something every
// pass, so progress() fires, so the stall detector never trips.
//
// Equipment farming has that same shape and none of that protection. Ten characters here
// are at max health 50 and a level-50 fungus beast cannot advance them, so they farm for
// gear and coin instead — which is a perfectly good reason to be out, and one the board
// had no way to distinguish from a keeper achieving nothing. Worse, `yieldCheck` returned
// null for any purpose other than 'advance', so declaring `equip` would have PROTECTED the
// run by switching the instrument off rather than by pointing it at the right question.
//
// So this is the right question: is what we are killing able to drop what this character
// is still short of? Two ways for the answer to be no, and they need different words —
// **nothing left to want** is finished, **wanting things this creature never drops** is
// the afternoon of worthless grinding wearing a different hat.
//
// It reads the loadout gap rather than a constant, because "what this character needs" is
// exactly what a loadout is for, and a second definition of it would drift from the first.

// Kod class names ("LeatherArmor") against display names ("leather armour"). Fold case,
// punctuation and the two spellings of armour; everything in these tables is one word or
// two, so this is enough and a fuzzy match would be worse than none.
const dropKey = (s) => String(s ?? '').toLowerCase()
  .replace(/[^a-z0-9]/g, '').replace(/armour/g, 'armor');

/** Everything a creature row says it can leave behind, however it says it. */
export function droppablesOf(creature) {
  const out = [];
  // Carried gear, dropped per item on its own roll. This is a real per-kill probability.
  for (const i of creature?.equipment_drops?.items ?? [])
    if ((i.per_kill_percent ?? 0) > 0)
      out.push({ item: i.item, how: 'equipment', per_kill_percent: i.per_kill_percent });
  // A TREASURE SHARE IS NOT A PER-KILL CHANCE and must not be rendered as one: the table
  // is rolled `1 + level/55 + random(0, difficulty/3)` times, so `per_roll_percent` is one
  // roll's share. Carried under its own name so nobody averages the two columns together.
  for (const i of creature?.loot?.items ?? [])
    out.push({ item: i.item, how: 'treasure', per_roll_percent: i.per_roll_percent });
  return out;
}

/**
 * `plan` is a reconcile() result; `creature` is a row from the spawn index.
 * Returns null when it cannot know — never "fine".
 */
export function equipYield(plan, creature) {
  if (!plan || !creature) return null;
  const short = plan.buy ?? [];
  if (!short.length)
    return { pays: false, done: true, creature: creature.name,
             why: 'this character already has everything on its list, so an equipment ' +
                  'run has nothing left to fetch' };

  const droppable = droppablesOf(creature);
  const byKey = new Map(droppable.map(d => [dropKey(d.item), d]));
  const hits = [];
  for (const b of short) {
    const d = byKey.get(dropKey(b.item));
    if (d) hits.push({ item: b.item, short: b.short ?? 1, gear: !!b.gear, ...d });
  }
  if (hits.length) return { pays: true, creature: creature.name, for: hits };

  return {
    pays: false, creature: creature.name,
    short_of: short.map(b => b.item),
    drops: droppable.length ? droppable.map(d => d.item) : null,
    why: droppable.length
      ? `${creature.name} drops none of the ${short.length} thing(s) this character is short of`
      : `${creature.name} has neither an equipment drop nor a treasure table — it leaves ` +
        'nothing behind at all',
    hint: 'this keeper is working and fetching nothing. Re-target it, or clear ' +
          '`purpose` if it is out there for coin rather than for kit.',
  };
}

// THE ORDER TO GIVE THINGS UP IN WHEN THE BAGS ARE FULL. Lowest first. Returns null when
// the loadout has nothing to say about a pack, so the keeper's own ranking stands.
export function dropRank(loadout, items = []) {
  if (!loadout) return null;
  const keep = keepTest(loadout, items);
  const sell = sellTest(loadout);
  // A FUNCTION THAT ALWAYS ANSWERS null IS NOT THE SAME AS NO FUNCTION. The caller tests
  // this for existence to decide whether the loadout has anything to say about a pack, so
  // an empty loadout has to be indistinguishable from an absent one here.
  if (!keep && !sell) return null;
  return (name) => {
    if (sell?.(name)) return -1;              // asked for this to go: before anything else
    if (keep?.(name)) return 3;               // protected: only if there is nothing else
    return null;                              // no opinion — let the caller's ranking decide
  };
}

// ------------------------------------------------------------------ a starter file
//
// WHAT THE CHARACTER IS ALREADY DOING, WRITTEN DOWN. A blank loadout is a page nobody
// fills in; one seeded from the sheet is a page somebody edits. It claims nothing beyond
// the observation: the gear is what the character is wearing, the reagents are the ones
// the fleet already runs on, and both are wrong for somebody and easy to change.
export function starterFrom(sheet) {
  const l = blank(sheet?.character ?? '', sheet?.agent ?? null);
  l.note = 'Seeded from the character sheet — this is what it was carrying, not a plan yet.';
  const worn = (sheet?.equipment?.worn ?? []).map(w => w.name).filter(Boolean);
  const cat = catalogue();
  for (const n of worn) {
    const item = cat.get(norm(n));
    if (item?.kind === 'weapon') l.gear.weapon.push(n);
    else if (item?.kind === 'shield') (l.gear.slots.shield ??= []).push(n);
    else if (item?.kind === 'armour') (l.gear.slots.body ??= []).push(n);
  }
  // The two the whole fleet turns on. REAGENT_TARGET in m59-autopilot.mjs is 20 and this
  // is the same 20 written where one character can disagree with it.
  for (const item of ['elderberry', 'herb'])
    l.carry.push({ item, min: 20, max: 40, match: 'exact', why: 'create food, 2 per casting',
                   weight: cat.get(item)?.weight ?? null, kind: 'reagent' });
  for (const [school, lvl] of Object.entries(schoolLevels(sheet))) l.plan.schools[school] = lvl;
  return l;
}

// The highest level known in each school, which is exactly what PlayerCanLearn sums to
// price the next one (player.kod:10813). Blink is excluded there and excluded here: the
// server does not count it toward a school's level, so neither may a planner.
export function schoolLevels(sheet, spellData = null) {
  const levelOf = spellData
    ? new Map(spellData.map(s => [norm(s.name), s]))
    : spellbook();
  const out = {};
  for (const sp of (sheet?.spells ?? [])) {
    if (norm(sp.name) === 'blink') continue;
    const known = levelOf.get(norm(sp.name));
    // The SCHOOL can come off the wire; the LEVEL cannot, so a spell the compiled table
    // has never heard of contributes nothing rather than a guessed level. Dropping it is
    // the safe direction: it understates the character's progress, and the alternative
    // understates the cost of its next level, which is the number people act on.
    const school = sp.school ?? known?.school;
    const lvl = sp.level ?? known?.level;
    if (!school || !lvl) continue;
    out[school] = Math.max(out[school] ?? 0, lvl);
  }
  return out;
}

// The seventh track: the highest level of any SKILL known, all of them pooled. Skills have
// levels too and PlayerCanLearn sums them into the same total (player.kod:10822), which is
// why a character with a level-3 proficiency pays more for its next spell.
export function weaponTrackLevel(sheet, skillData = null) {
  loadPlannerData();
  const bySkill = skillData ? new Map(skillData.map(s => [norm(s.name), s])) : null;
  let top = 0;
  for (const sk of (sheet?.skills ?? [])) {
    const lvl = sk.level ?? bySkill?.get(norm(sk.name))?.level ?? null;
    if (lvl) top = Math.max(top, lvl);
  }
  return top;
}

// ------------------------------------------------------------------ the learning cost
//
// PlayerCanLearn, as arithmetic, so the planner can answer "can this character learn that"
// without asking the server — which will not answer anyway: a skill it cannot learn is
// simply ABSENT from the shop list, with no message of any kind (monster.kod:4855).
//
// RE-EXPORTED, NOT REIMPLEMENTED. The planner page needs the same arithmetic in a browser,
// so it lives in compendium/tools/learn.mjs, which has no imports and is inlined into
// assets/learn.js by the page's build. Two copies of a formula in this repository have
// always become two answers to a question.
export { learnCost, canLearn, trackPoints, levelPointsAt,
         RemainingRequiredToLearnNewSkills, remainingRequiredToLearnNewSkills,
         PointsToNextLevelOfTarget, pointsToNextLevelOfTarget }
  from '../compendium/tools/learn.mjs';

// ---------------------------------------------------------------------- cli
if (import.meta.filename === process.argv[1]) {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes('--' + n);
  // `indexOf` of a missing flag is -1, and -1+1 is 0 — which is the character name. That
  // read the port as `Number("Kermit")`, NaN, and the failure surfaced as the broker not
  // answering on port NaN rather than as a bad argument.
  const pi = argv.indexOf('--port');
  const PORT = Number(pi >= 0 ? argv[pi + 1] : 8901) || 8901;
  const who = argv.filter((a, i) => !a.startsWith('--') && !(pi >= 0 && i === pi + 1))[0] ?? null;

  const broker = async (name, args = {}) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const j = await r.json();
    const text = j.result?.content?.[0]?.text;
    if (j.error || j.result?.isError) throw new Error(text ?? JSON.stringify(j.error));
    return JSON.parse(text);
  };

  const show = (rec) => {
    const l = rec.loadout;
    if (!l) { console.log(`  ${rec.file}: ${rec.problems.join('; ')}`); return; }
    console.log(`${l.character}${l.agent ? ` (${l.agent})` : ''}` +
                `${l.updated ? '  updated ' + l.updated.slice(0, 16).replace('T', ' ') : ''}`);
    if (l.note) console.log(`  ${l.note}`);
    if (l.gear.weapon.length) console.log(`  weapon   ${l.gear.weapon.join(' > ')}`);
    for (const [s, v] of Object.entries(l.gear.slots)) console.log(`  ${s.padEnd(8)} ${v.join(' > ')}`);
    for (const c of l.carry)
      console.log(`  carry    ${c.item} ${c.min}${c.max === null ? '+' : '–' + c.max}` +
                  `${c.why ? '   (' + c.why + ')' : ''}`);
    if (l.sell.length) console.log(`  sell     ${l.sell.join(', ')}`);
    if (l.keep.length) console.log(`  keep     ${l.keep.join(', ')}`);
    const schools = Object.entries(l.plan.schools);
    if (schools.length) console.log(`  schools  ${schools.map(([k, v]) => `${k} ${v}`).join(', ')}`);
    if (l.plan.abilities.length) console.log(`  learn    ${l.plan.abilities.map(a => a.name).join(', ')}`);
    for (const p of rec.problems) console.log(`  ! ${p}`);
  };

  if (who && flag('init')) {
    const sheetPath = path.join(REPO, 'substrate', 'sheets', who + '.json');
    if (!fs.existsSync(sheetPath)) {
      console.error(`no sheet at ${sheetPath} — run tools/m59-sheet.mjs first, or write the file by hand`);
      process.exit(1);
    }
    const sheet = JSON.parse(fs.readFileSync(sheetPath, 'utf8'));
    const p = loadoutPath(who);
    if (fs.existsSync(p) && !flag('force')) {
      console.error(`${p} already exists — --force to overwrite it`);
      process.exit(1);
    }
    const res = writeLoadout(who, starterFrom(sheet));
    console.log(`wrote ${res.path}`);
    show({ file: path.basename(res.path), loadout: res.loadout, problems: res.problems });
    process.exit(0);
  }

  // The planner's "Apply gear + carry to fleet" button, on the command line. Plans by default and
  // needs --apply, for the same reason m59-restore.mjs does: it writes one file per
  // character, and a fleet-wide write that happens before you have read what it would do is
  // one you find out about from the keeper.
  if (who && flag('gear-to-fleet')) {
    const rec = readLoadout(who);
    if (!rec) { console.error(`no loadout for "${who}" — nothing to copy gear from`); process.exit(1); }
    let fleet = null;
    try { fleet = await broker('fleet', {}); }
    catch (e) {
      console.error(`the broker on ${PORT} is not answering (${e.message}) — and "the fleet" is a ` +
                    'live question. The saved loadouts on this machine are a different set of ' +
                    'characters and are deliberately not substituted for it.');
      process.exit(1);
    }
    const chars = (fleet.fleet || []).filter(r => r.character)
      .map(r => ({ character: r.character, agent: r.agent }));
    let res;
    try {
      res = applyInventoryToAll({ gear: rec.loadout.gear, carry: rec.loadout.carry }, chars,
                                { from: rec.loadout.character, apply: flag('apply'),
                                  allowEmpty: flag('force') });
    } catch (e) { console.error(e.message); process.exit(1); }
    const g = res.gear;
    console.log(`${flag('apply') ? 'applied' : 'would apply'} ${rec.loadout.character}'s gear and carry list to ` +
                `${chars.length} character(s):`);
    if (g.weapon.length) console.log(`  weapon   ${g.weapon.join(' > ')}`);
    for (const [s, v] of Object.entries(g.slots)) console.log(`  ${s.padEnd(8)} ${v.join(' > ')}`);
    for (const c of res.carry ?? [])
      console.log(`  carry    ${c.item} ${c.min}${c.max === null ? '+' : '-' + c.max}`);
    for (const p of res.problems) console.log(`  ! ${p}`);
    for (const r of res.rows) {
      const what = r.error ? `! ${r.error}`
        : !r.changed ? 'already has it'
        : r.created ? (flag('apply') ? 'new loadout written' : 'would get a new loadout')
        : (flag('apply') ? 'inventory plan replaced' : 'would be changed') +
          (r.before?.gear && !gearIsEmpty(r.before.gear)
            ? ` (was ${r.before.gear.weapon.join(' > ') || 'no weapon'})` : ' (had no gear)');
      console.log(`  ${r.character.padEnd(12)} ${what}`);
    }
    console.log(`${res.counts.changed} changed, ${res.counts.unchanged} already as asked` +
                (res.counts.failed ? `, ${res.counts.failed} refused` : ''));
    if (!flag('apply')) console.log('nothing was written — add --apply');
    process.exit(res.counts.failed ? 1 : 0);
  }

  if (flag('check-all') || (who && flag('check'))) {
    const rows = who ? [readLoadout(who)].filter(Boolean) : listLoadouts().filter(r => r.loadout);
    if (!rows.length) { console.log('no loadouts to check'); process.exit(0); }
    let fleet = null;
    try { fleet = await broker('fleet', {}); }
    catch (e) { console.error(`the broker on ${PORT} is not answering (${e.message}) — nothing to check against`); process.exit(1); }
    for (const rec of rows) {
      const l = rec.loadout;
      const row = (fleet.fleet || []).find(r => norm(r.character) === norm(l.character));
      if (!row) { console.log(`${l.character}: not in the fleet`); continue; }
      let inv = { items: [] }, eq = { equipped: [] };
      try { inv = await broker('inventory', { agent: row.agent }); } catch { /* reported below */ }
      try { eq = await broker('equipment', { agent: row.agent }); } catch { /* worn is optional */ }
      const r = reconcile(l, { items: inv.items || [], equipped: eq.equipped || [] });
      console.log(`${l.character.padEnd(10)} ${r.summary}` +
                  (r.at_least ? `   at least ${r.at_least}sh` : ''));
      for (const b of r.buy) console.log(`   buy   ${b.item} x${b.short}${b.why ? '   (' + b.why + ')' : ''}`);
      for (const s of r.sell) console.log(`   shed  ${s.item} x${s.over}   (${s.why})`);
      for (const [slot, g] of Object.entries(r.gear.slots))
        if (g.upgrade_to) console.log(`   ${slot}: holding ${g.have}, wants ${g.upgrade_to.join(' or ')}`);
      if (r.gear.weapon?.upgrade_to)
        console.log(`   weapon: holding ${r.gear.weapon.have}, wants ${r.gear.weapon.upgrade_to.join(' or ')}`);
    }
    process.exit(0);
  }

  if (who) {
    const rec = readLoadout(who);
    if (!rec) {
      console.error(`no loadout for "${who}" — ${loadoutPath(who) ?? 'that name cannot be a filename'}`);
      console.error('write one in the compendium planner, or: node tools/m59-loadout.mjs ' + who + ' --init');
      process.exit(1);
    }
    if (flag('json')) console.log(JSON.stringify(rec.loadout, null, 1));
    else show({ file: path.basename(rec.path), ...rec });
    process.exit(0);
  }

  const all = listLoadouts();
  if (!all.length) {
    console.log(`no loadouts in ${LOADOUT_DIR}`);
    console.log('One per character. Write them in the compendium planner ' +
                '(node tools/m59-compendium.mjs --open --to /planner/), or seed one from a sheet:');
    console.log('  node tools/m59-loadout.mjs Kermit --init');
    process.exit(0);
  }
  console.log(`${all.length} loadout(s) in ${LOADOUT_DIR}`);
  for (const rec of all) { console.log(''); show(rec); }
}
