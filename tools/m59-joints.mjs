#!/usr/bin/env node
// THE KEEPER'S JOINTS: NAMED PLACES WHERE A BEHAVIOUR CAN BE REPLACED, AND THE PAKS THAT REPLACE IT.
//
//   node tools/m59-joints.mjs                        every joint, and every pak this machine has
//   node tools/m59-joints.mjs joints                 the joint catalogue: where each is asked, its facts and answers
//   node tools/m59-joints.mjs check <pak>            load one pak and say what it handles
//   node tools/m59-joints.mjs dry <pak> [--facts f.json --joint j] [--json]
//                                                    run a pak's own scenarios (or your facts) and show every
//                                                    rule it considered, which fired, and what the keeper would do
//   node tools/m59-joints.mjs status --fleet prod    which paks each character would load
//
// The operator, 2026-10-25: behaviours should be "modularly replaceable for the major components" -- a
// mover, a router, each PvP behaviour -- "and not all in a single file", expressed along the joints the
// problem already has in RPG terms, so that precise orders covering most edge-cases stay human-reviewable.
//
// So: a JOINT is a moment the keeper already has -- a step about to cross a wall of fire, an approach that
// found no safe square, a creature's blow landing, our own blow landing on a player -- given a NAME, a
// frozen set of FACTS, and a CLOSED set of ANSWERS. The keeper asks; with nothing loaded the answer is
// null and the keeper does what it always did. That last sentence is the whole compatibility promise, and
// m59-joints-test.mjs pins it per joint: no pak, no change.
//
// A PAK is one file of behaviour, shareable on its own: it names the joints it answers, and its answers are
// either a function or a list of RULES in a small condition language that reads like a rulebook --
//
//     joints: {
//       'movement.hazard': [
//         { name: 'run the flames when resistant',
//           when: { all: [['effect.kind', '==', 'firewall'], ['self.resist.fire', '>=', 50], ['self.health_pct', '>=', 40]] },
//           then: { do: 'cross', why: 'resistant and healthy; one tick at most' } },
//       ],
//     }
//
// -- which is the Baldur's Gate AI-script shape (IF trigger THEN RESPONSE, first match wins) with the
// triggers named in this game's own terms (tools/rpg/: buffs, debuffs, resistances, a curse, the attack
// timer, a door between two rooms). The rules are DATA so a dry run can say which clause failed, and a
// person can review a pak without reading the keeper.
//
// THE RULES THIS FILE KEEPS (the policy rules, docs/m59-policy.md, applied to code):
//   1. SILENCE IS THE OLD BEHAVIOUR. No assignment file, an empty one, a pak that is not found, a pak that
//      throws: the joint answers null and the keeper does exactly what it did before joints existed.
//   2. A CLOSED SET OF ANSWERS. Every joint validates its decisions; an unknown verb is reported in status
//      and answered with silence. A pak cannot invent a capability by returning an object.
//   3. FAST AND SYNCHRONOUS. A joint is asked on the keeper's own clock (a step, a blow), so a handler that
//      throws, returns a promise, or takes longer than JOINT_BUDGET_MS is silence and a strike; three
//      strikes stand the pak down until its file changes. Loading is the only asynchronous part.
//   4. NEVER THE PROTECTED FOUR BY STEALTH. A joint is asked INSIDE the keeper and its answers are bounded
//      by the keeper's own guards: a `cross` still goes through the mover's collision checks, a `withdraw`
//      is the keeper's own flight, a `treat_as_player` still needs the server to let us swing. No answer
//      turns safety off, and none is a speech verb.
//   5. ORDERS ARE THIS MACHINE'S. Paks live in substrate/paks/ (gitignored) or a private repository's
//      directory; the committed shape is substrate/paks.example/. A fresh clone loads nothing.
//
// FOLLOW-UPS. Any decision may carry `also: [...]`, things the pak wants done besides its answer --
// `{ do: 'request', service: 'purge', target: 'Foeman', ttl_ms }` posts to the fleet's service board
// (tools/rpg/requests.mjs) for whoever runs that desk; `{ do: 'note', text }` writes one keeper journal
// line. The host performs them, so a pak never touches a file or the wire itself.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, delimiter, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBSTRATE = join(HERE, '..', 'substrate');

export const JOINT_BUDGET_MS = Number(process.env.M59_JOINT_MS || 25);
export const STRIKES = 3;
export const TRACE_KEEP = 40;

// ------------------------------------------------------------------------------------------------- the joints
//
// Each entry is the contract a pak is written against: WHERE the keeper asks it (so a reviewer can go and
// read the call site), on which CLOCK, the FACTS it is given, and the ANSWERS it accepts. `verbs` maps each
// accepted verb to a validator returning { decision } or { error }; `default` is always accepted and means
// "what the keeper does anyway".
const num = (v, lo, hi, dflt) => {
  if (v == null) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : NaN;
};
const why = d => (d.why == null ? null : String(d.why).slice(0, 200));
const ok = decision => ({ decision });
const bad = error => ({ error });
const names = v => [...new Set((Array.isArray(v) ? v : v == null ? [] : [v]).map(x => String(x).trim().toLowerCase()).filter(Boolean))];

export const JOINTS = Object.freeze({
  'movement.hazard': {
    clock: 'step',
    asked_at: 'Session.groundEffectBlock (every step), safeCombatStep (combat approach squares)',
    when: 'a step, or a square a combat approach would use, lies on a ground effect -- a wall of fire, of lightning, a web, a cloud',
    facts: 'effect {kind,name,row,col,harmful,periodic,certainty}, purpose ("step"|"combat"), from, to, self (rpg/sheet: health_pct, resist, buffs, debuffs, carrying), hazard (rpg/hazards: element, max_hit, period_ms, expected_hit, resist_pct)',
    answers: 'default (refuse the step, as always) | cross { why } (this step may pass through that effect) | avoid { why }',
    verbs: {
      cross: d => ok({ do: 'cross', why: why(d) }),
      avoid: d => ok({ do: 'avoid', why: why(d) }),
    },
  },
  'combat.blocked': {
    clock: 'beat',
    asked_at: 'CombatMode.approachCombat, when the fight has a target and no safe approach square',
    when: 'the body cannot close on its target: every approach square is a hazard, a body, or off the floor',
    facts: 'reason, target {id,name,row,col,distance,player}, hazards [...], channels (rpg/channels: melee, bows, wands, attack spells, each with ready and timer), pvp, self (sheet), room, exits_here',
    answers: 'default (the approach fails, as always) | ranged { channel?, why } (fire a ranged channel instead of moving) | withdraw { room?, why } (leave the map: the keeper\'s own flight) | hold { ms, why } (stand and wait for the hazard)',
    verbs: {
      ranged: d => ok({ do: 'ranged', channel: d.channel == null ? null : String(d.channel).toLowerCase(), why: why(d) }),
      withdraw: d => {
        const room = d.room == null ? null : Number(d.room);
        if (room != null && !(Number.isInteger(room) && room > 1)) return bad('withdraw room is a room number above 1');
        return ok({ do: 'withdraw', room, why: why(d) });
      },
      hold: d => {
        const ms = num(d.ms, 0, 10_000, 1500);
        return Number.isNaN(ms) ? bad('hold ms is 0..10000') : ok({ do: 'hold', ms, why: why(d) });
      },
    },
  },
  'threat.classify': {
    clock: 'blow',
    asked_at: 'CombatMode.observeCreature, when a creature hits us, speaks, or appears with player-only marks',
    when: 'something the server sends as a creature has done something a creature cannot (rpg/suspicion.mjs)',
    facts: 'object {id,name,flags,row,col}, event ("hit"|"spoke"|"appeared"|"anonymous_hit"), evidence [{signal,detail,weight}], score, spawnable_here (true|false|null), room, self (sheet), pvp_allowed_here',
    answers: 'default (a creature, as always) | treat_as_player { label?, ttl_ms?, alarm?, why } (fight it as a player who attacked us, and raise the war alarm)',
    verbs: {
      treat_as_player: d => {
        const ttl = num(d.ttl_ms, 5_000, 30 * 60_000, 5 * 60_000);
        if (Number.isNaN(ttl)) return bad('treat_as_player ttl_ms is 5s..30min');
        return ok({ do: 'treat_as_player', label: d.label == null ? 'suspected_morph' : String(d.label).slice(0, 40),
          ttl_ms: ttl, alarm: d.alarm !== false, why: why(d) });
      },
    },
  },
  'combat.outcome': {
    clock: 'blow',
    asked_at: 'CombatMode.noteFightMessage, on every line reporting OUR blow or spell landing (or failing) on the target',
    when: 'the server has told us how our attack went: the verb band, the element, and whether the target resisted',
    facts: 'channel ("melee"|"wand:<name>"|"spell:<name>"|"bow"), outcome (rpg/damage: band 0..4, band_name, element, resisted ("laughs"|"shrugs"|null), weak), target {name,id,player}, text, self (sheet), room',
    answers: 'default | adjust { channel, weight, for_ms, why } (this pak\'s own opinion of that channel, read back at combat.channel)',
    verbs: {
      adjust: d => {
        const w = num(d.weight, -100, 100, NaN), ms = num(d.for_ms, 1_000, 30 * 60_000, 60_000);
        if (!Number.isFinite(w)) return bad('adjust weight is -100..100');
        if (Number.isNaN(ms)) return bad('adjust for_ms is 1s..30min');
        if (!d.channel) return bad('adjust names a channel');
        return ok({ do: 'adjust', channel: String(d.channel).toLowerCase(), weight: w, for_ms: ms, why: why(d) });
      },
    },
  },
  'combat.channel': {
    clock: 'beat',
    asked_at: 'CombatMode.advance, before the wand volley in a fight with a player',
    when: 'the keeper is about to pick how to attack this beat',
    facts: 'channels (rpg/channels), timer (rpg/timers: attack_ready_in_ms, free_channels), target, distance, pvp, self (sheet), weights (this pak\'s adjustments still in force)',
    answers: 'default (the built-in volley, then melee) | skip { channels: [...], why } (do not use these this beat) | prefer { channel, why } (the volley may only use this one)',
    verbs: {
      skip: d => { const c = names(d.channels ?? d.channel); return c.length ? ok({ do: 'skip', channels: c, why: why(d) }) : bad('skip names channels'); },
      prefer: d => d.channel ? ok({ do: 'prefer', channel: String(d.channel).toLowerCase(), why: why(d) }) : bad('prefer names a channel'),
    },
  },
  'upkeep.curse': {
    clock: 'pass',
    asked_at: 'Autopilot.passOnce, at most once a minute, after the gear sweep',
    when: 'the keeper has read its own body: what it wears, whether anything is cursed, what it can cast',
    facts: 'self (sheet; sheet.curse is {state,items,evidence} -- a curse is NOT an enchantment, see rpg/sheet.mjs), can_cast (spell names), room, fleet_room (fleet-mates here)',
    answers: 'default | request { service, why } (post a request for a service on ourselves, e.g. remove curse)',
    verbs: {
      request: d => d.service ? ok({ do: 'request', service: String(d.service).toLowerCase(), why: why(d) }) : bad('request names a service'),
    },
  },
});

export const ALSO_VERBS = Object.freeze(['request', 'note']);

function validateAlso(list) {
  const out = [], errors = [];
  for (const a of Array.isArray(list) ? list : list == null ? [] : [list]) {
    if (!a || typeof a !== 'object') { errors.push(`also: not an action ${JSON.stringify(a)}`); continue; }
    if (a.do === 'request') {
      if (!a.service) { errors.push('also request names a service'); continue; }
      const ttl = num(a.ttl_ms, 5_000, 60 * 60_000, 5 * 60_000);
      out.push({ do: 'request', service: String(a.service).toLowerCase(), target: a.target == null ? null : String(a.target).slice(0, 64),
        ttl_ms: Number.isNaN(ttl) ? 5 * 60_000 : ttl, why: why(a) });
    } else if (a.do === 'note') out.push({ do: 'note', text: String(a.text ?? '').slice(0, 200) });
    else errors.push(`also: unknown action "${a.do}" (${ALSO_VERBS.join(', ')})`);
  }
  return { also: out, errors };
}

/** One answer, validated against its joint. Returns { decision, error }; decision null means default. */
export function validateJointDecision(joint, raw) {
  const spec = JOINTS[joint];
  if (!spec) return { decision: null, error: `no joint "${joint}"` };
  if (raw == null || raw === 'default') return { decision: null };
  if (typeof raw === 'string') raw = { do: raw };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { decision: null, error: `not a decision: ${JSON.stringify(raw)}` };
  const verb = String(raw.do ?? '');
  const { also, errors } = validateAlso(raw.also);
  if (verb === 'default') return { decision: also.length ? { do: 'default', also } : null, error: errors[0] ?? null };
  const v = spec.verbs[verb];
  if (!v) return { decision: null, error: `${joint}: unknown answer "${verb}" (default, ${Object.keys(spec.verbs).join(', ')})` };
  const r = v(raw);
  if (r.error) return { decision: null, error: `${joint} ${verb}: ${r.error}` };
  return { decision: { ...r.decision, ...(also.length ? { also } : {}) }, error: errors[0] ?? null };
}

// ------------------------------------------------------------------------------------- the condition language
//
// A condition is one of:
//   [path, op, value]          a fact compared: '==' '!=' '<' '<=' '>' '>=' 'in' (value is a list)
//                              'has' (the fact is a list or string containing value) 'matches' (regex)
//                              'exists' / 'missing' (no value)
//   { all: [c, ...] }  { any: [c, ...] }  { not: c }
//   (facts, ctx) => boolean    when a rule genuinely needs code; the dry run reports it as "code"
//
// A path is dotted ('self.resist.fire', 'target.name'); a list element is matched by index ('channels.0').
// `$options.x` reads the pak's options and `$memory.x` its per-character memory, so a threshold can be an
// option rather than a number baked into the rule.
export function factAt(facts, path, ctx = {}) {
  const parts = String(path).split('.');
  let v = parts[0] === '$options' ? ctx.options : parts[0] === '$memory' ? ctx.memory : facts;
  for (const p of parts[0].startsWith('$') ? parts.slice(1) : parts) {
    if (v == null) return undefined;
    v = v[p];
  }
  return v;
}
const OPS = {
  '==': (a, b) => a === b || (typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()),
  '!=': (a, b) => !OPS['=='](a, b),
  '<': (a, b) => Number(a) < Number(b), '<=': (a, b) => Number(a) <= Number(b),
  '>': (a, b) => Number(a) > Number(b), '>=': (a, b) => Number(a) >= Number(b),
  in: (a, b) => Array.isArray(b) && b.some(x => OPS['=='](a, x)),
  has: (a, b) => Array.isArray(a) ? a.some(x => OPS['=='](x, b) || (x && typeof x === 'object' && OPS['=='](x.name, b)))
    : typeof a === 'string' ? a.toLowerCase().includes(String(b).toLowerCase()) : false,
  matches: (a, b) => a != null && new RegExp(b, 'i').test(String(a)),
  exists: a => a !== undefined && a !== null,
  missing: a => a === undefined || a === null,
};
export const CONDITION_OPS = Object.freeze(Object.keys(OPS));

/** Evaluate a condition. Returns { pass, why } where `why` is a human sentence about the first thing that decided it. */
export function evaluate(cond, facts, ctx = {}) {
  if (cond == null) return { pass: true, why: 'always' };
  if (typeof cond === 'function') {
    const pass = !!cond(facts, ctx);
    return { pass, why: `code ${pass ? 'passed' : 'failed'}` };
  }
  if (Array.isArray(cond)) {
    const [path, op, value] = cond;
    if (!OPS[op]) throw new Error(`unknown operator "${op}" (${CONDITION_OPS.join(' ')})`);
    const v = typeof value === 'string' && value.startsWith('$') ? factAt(facts, value, ctx) : value;
    const actual = factAt(facts, path, ctx);
    const pass = OPS[op](actual, v);
    return { pass, why: `${path} ${op}${op === 'exists' || op === 'missing' ? '' : ' ' + JSON.stringify(v)} (is ${JSON.stringify(actual)})` };
  }
  if (cond.all) {
    for (const c of cond.all) { const r = evaluate(c, facts, ctx); if (!r.pass) return { pass: false, why: r.why }; }
    return { pass: true, why: `all ${cond.all.length}` };
  }
  if (cond.any) {
    const whys = [];
    for (const c of cond.any) { const r = evaluate(c, facts, ctx); if (r.pass) return { pass: true, why: r.why }; whys.push(r.why); }
    return { pass: false, why: `none of: ${whys.join('; ')}` };
  }
  if ('not' in cond) { const r = evaluate(cond.not, facts, ctx); return { pass: !r.pass, why: `not (${r.why})` }; }
  throw new Error(`not a condition: ${JSON.stringify(cond)}`);
}

/**
 * Ask one pak's handler for one joint. A handler is a function or a list of rules; rules are tried in
 * order and the first whose `when` passes answers (`then` is a decision or a function returning one; a
 * rule answering null lets the next one try). Returns { raw, trace } where trace says what each rule did.
 */
export function runHandler(handler, facts, ctx = {}) {
  const trace = [];
  if (typeof handler === 'function') {
    const raw = handler(facts, ctx);
    trace.push({ rule: '(code)', fired: raw != null, answer: raw ?? null });
    return { raw, trace };
  }
  for (const [i, rule] of (Array.isArray(handler) ? handler : []).entries()) {
    const name = rule.name ?? `rule ${i + 1}`;
    const r = evaluate(rule.when, facts, ctx);
    if (!r.pass) { trace.push({ rule: name, fired: false, why: r.why }); continue; }
    const raw = typeof rule.then === 'function' ? rule.then(facts, ctx) : rule.then;
    trace.push({ rule: name, fired: raw != null, why: r.why, answer: raw ?? null });
    if (raw != null) return { raw, trace };
  }
  return { raw: null, trace };
}

// ------------------------------------------------------------------------------------------ finding paks
export const pakDir = (env = process.env) => env.M59_PAK_DIR || join(SUBSTRATE, 'paks');
export const pakDirsFile = (env = process.env) => env.M59_PAK_DIRS_FILE || join(SUBSTRATE, 'pak-dirs.json');
export const pakAssignmentFile = (fleet, env = process.env) => env.M59_PAK_FILE
  || join(SUBSTRATE, fleet && fleet !== 'default' ? `paks-${fleet}.json` : 'paks.json');
export const EXAMPLE_DIR = join(SUBSTRATE, 'paks.example');

export function pakDirs({ env = process.env } = {}) {
  const out = [];
  const add = d => {
    if (typeof d !== 'string' || !d.trim()) return;
    const r = resolve(d.trim());
    if (!out.some(o => o.toLowerCase() === r.toLowerCase())) out.push(r);
  };
  add(pakDir(env));
  for (const d of String(env?.M59_PAK_PATH ?? '').split(delimiter)) add(d);
  try {
    const j = JSON.parse(readFileSync(pakDirsFile(env), 'utf8'));
    for (const d of (Array.isArray(j?.dirs) ? j.dirs : [])) add(d);
  } catch { /* absent: only this machine's own directory */ }
  return out;
}

const NAME_OK = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;
export function findPak(name, { env = process.env, dirs = null } = {}) {
  if (!NAME_OK.test(String(name ?? '')) || String(name).includes('..')) return null;
  for (const d of dirs ?? pakDirs({ env })) {
    for (const f of [join(d, `${name}.mjs`), join(d, name, 'pak.mjs')]) if (existsSync(f)) return f;
  }
  return null;
}

/** Every pak file in the search path (first directory wins on a name), plus the committed examples. */
export function listPaks({ env = process.env, examples = false } = {}) {
  const seen = new Map();
  for (const d of [...pakDirs({ env }), ...(examples ? [EXAMPLE_DIR] : [])]) {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const name = e.isFile() && e.name.endsWith('.mjs') && !e.name.startsWith('_') ? e.name.slice(0, -4)
        : e.isDirectory() && existsSync(join(d, e.name, 'pak.mjs')) ? e.name : null;
      if (!name || seen.has(name)) continue;
      seen.set(name, e.isDirectory() ? join(d, e.name, 'pak.mjs') : join(d, e.name));
    }
  }
  return [...seen].map(([name, file]) => ({ name, file, example: file.startsWith(EXAMPLE_DIR) }));
}

/** A pak module, checked: { pak, errors }. Unknown joints are reported, never asked. */
export function checkPak(mod, file = '') {
  const pak = mod?.default ?? mod?.pak ?? mod;
  const errors = [];
  if (!pak || typeof pak !== 'object') return { pak: null, errors: [`${file} exports no pak`] };
  if (typeof pak.name !== 'string' || !pak.name) errors.push('a pak has a name');
  if (!pak.joints || typeof pak.joints !== 'object') errors.push('a pak has joints: { "<joint>": handler }');
  for (const [j, h] of Object.entries(pak.joints ?? {})) {
    if (!JOINTS[j]) errors.push(`unknown joint "${j}" (${Object.keys(JOINTS).join(', ')}) -- reported, never asked`);
    if (typeof h !== 'function' && !Array.isArray(h)) errors.push(`${j}: a handler is a function or a list of rules`);
    for (const r of Array.isArray(h) ? h : []) {
      if (!r || typeof r !== 'object' || !('then' in r)) errors.push(`${j}: a rule is { name?, when?, then }`);
      try { if (r?.when && typeof r.when !== 'function') evaluate(r.when, {}, { options: {}, memory: {} }); }
      catch (e) { errors.push(`${j} ${r?.name ?? ''}: ${e.message}`); }
    }
  }
  return { pak, errors };
}

// -------------------------------------------------------------------------------------------- assignment
//
// substrate/paks-<fleet>.json:
//   { "enabled": ["firewall-doctrine", { "pak": "wand-feedback", "options": { "floor": -40 } }],
//     "agents":     { "t9":    { "disable": ["firewall-doctrine"] } },
//     "characters": { "Bravo": { "disable": "*" }, "Alpha": { "enable": ["door-watch"] } } }
//
// Order is precedence: the first enabled pak with an answer wins a joint. A character's own entry can add
// paks (`enable`, after the fleet's) or remove them (`disable`, a list or "*"). A menagerie host loads none.
export function normalizePakEntry(e) {
  if (typeof e === 'string' && e.trim()) return { pak: e.trim(), options: {} };
  if (e && typeof e === 'object' && typeof e.pak === 'string') {
    if (e.options != null && (typeof e.options !== 'object' || Array.isArray(e.options))) throw new Error(`${e.pak}: options must be an object`);
    return { pak: e.pak.trim(), options: e.options ?? {} };
  }
  throw new Error(`a pak entry is "name" or { pak, options }, not ${JSON.stringify(e)}`);
}

export function resolvePaks(book, { agent = null, character = null } = {}) {
  if (!book || typeof book !== 'object') return [];
  const pick = (table, key) => {
    if (!table || typeof table !== 'object' || key == null) return null;
    const hit = Object.keys(table).find(k => k.toLowerCase() === String(key).toLowerCase());
    return hit === undefined ? null : table[hit];
  };
  let list = (Array.isArray(book.enabled) ? book.enabled : []).map(normalizePakEntry);
  for (const own of [pick(book.characters, character), pick(book.agents, agent)]) {
    if (!own) continue;
    if (own.disable === '*') list = [];
    else for (const d of names(own.disable)) list = list.filter(p => p.pak.toLowerCase() !== d);
    for (const e of (Array.isArray(own.enable) ? own.enable : [])) {
      const n = normalizePakEntry(e);
      if (!list.some(p => p.pak.toLowerCase() === n.pak.toLowerCase())) list.push(n);
    }
  }
  return list;
}

// -------------------------------------------------------------------------------------------- the host
//
// One per keeper (m59-keeper-process.mjs creates it beside the PvP strategy host and refreshes it on the
// same 2 s timer). `ask` is the keeper's whole interface: synchronous, never throws, null for default.
export class JointHost {
  constructor({ fleet = null, agent = null, character = null, isHost = false, env = process.env,
                now = Date.now, log = () => {}, importer = url => import(url), effects = {} } = {}) {
    Object.assign(this, { fleet, agent, character, isHost, env, now, log, importer });
    // `record` receives every answer (and every branch a pak recorded): the keeper writes it to its combat
    // log and the PvP decisions stream, so a decision is always traceable to its facts and its rule.
    this.effects = { request: effects.request ?? null, note: effects.note ?? null, record: effects.record ?? null };
    this.paks = [];            // [{ name, file, key, pak, options, memory, strikes, error, answered }]
    this.assignmentKey = null; this.assignment = []; this.error = null;
    this.trace = [];           // the last TRACE_KEEP answers, newest last, for status and the fleet pages
    this.asked = 0;
  }

  /** Install paks directly (tests, a dry run). Each entry is { pak, options?, name? }. */
  use(entries) {
    this.paks = entries.map(e => ({ name: e.name ?? e.pak.name, file: e.file ?? null, key: null, pak: e.pak,
      options: { ...(e.pak.options ?? {}), ...(e.options ?? {}) }, memory: {}, strikes: 0, error: null, answered: 0 }));
    return this;
  }

  handles(joint) { return this.paks.some(p => p.strikes < STRIKES && p.pak.joints?.[joint]); }

  /** Re-read the assignment and (re)load any pak whose file changed. Never throws. */
  async refresh() {
    try {
      if (this.isHost) { this.paks = []; return this.status(); }
      const file = pakAssignmentFile(this.fleet, this.env);
      let akey = 'absent';
      try { const st = statSync(file); akey = `${st.mtimeMs}:${st.size}`; } catch { /* absent: silence */ }
      if (akey !== this.assignmentKey) {
        this.assignmentKey = akey;
        this.assignment = akey === 'absent' ? [] : resolvePaks(JSON.parse(readFileSync(file, 'utf8')),
          { agent: this.agent, character: this.character });
        this.error = null;
      }
      const next = [];
      for (const entry of this.assignment) {
        const where = findPak(entry.pak, { env: this.env });
        const old = this.paks.find(p => p.name === entry.pak);
        if (!where) { next.push({ ...(old ?? {}), name: entry.pak, file: null, pak: null, error: `no pak "${entry.pak}" in ${pakDirs({ env: this.env }).join(', ')}`, strikes: STRIKES }); continue; }
        const st = statSync(where), key = `${where}:${st.mtimeMs}`;
        const options = entry.options;
        if (old?.pak && old.key === key) { next.push({ ...old, options: { ...(old.pak.options ?? {}), ...options } }); continue; }
        try {
          const { pak, errors } = checkPak(await this.importer(`${pathToFileURL(where).href}?v=${st.mtimeMs}`), where);
          if (!pak || errors.some(e => !/reported, never asked/.test(e))) throw new Error(errors.join('; '));
          next.push({ name: entry.pak, file: where, key, pak, options: { ...(pak.options ?? {}), ...options }, memory: {},
            strikes: 0, error: errors[0] ?? null, answered: 0 });
          this.log(`[joints] ${this.character ?? this.agent}: ${entry.pak} loaded from ${where}`);
        } catch (e) {
          next.push({ name: entry.pak, file: where, key, pak: old?.pak ?? null, options, memory: old?.memory ?? {},
            strikes: old?.pak ? old.strikes : STRIKES, error: `load: ${e.message}`, answered: old?.answered ?? 0 });
          this.log(`[joints] LOUD ${this.character ?? this.agent}: ${entry.pak} did not load -- ${e.message}`);
        }
      }
      this.paks = next;
    } catch (e) { this.error = `refresh: ${e.message}`; this.log(`[joints] LOUD ${this.character ?? this.agent}: ${this.error}`); }
    return this.status();
  }

  /**
   * The answer for one joint: a validated decision (with `pak` naming who answered), or null for default.
   * `facts` is frozen before any pak sees it. Follow-ups (`also`) are performed here, never by the caller.
   */
  ask(joint, facts = {}) {
    if (!JOINTS[joint] || !this.paks.length) return null;
    this.asked++;
    const frozen = deepFreeze(structuredCloneSafe({ ...facts, joint }));
    for (const p of this.paks) {
      const handler = p.pak?.joints?.[joint];
      if (!handler || p.strikes >= STRIKES) continue;
      const t0 = this.now();
      let raw, trace;
      const branches = [];
      try {
        ({ raw, trace } = runHandler(handler, frozen, { options: Object.freeze({ ...p.options }), memory: p.memory,
          now: this.now(), agent: this.agent, character: this.character, branch: branchRecorder(branches) }));
      } catch (e) { p.strikes++; p.error = `${joint} threw: ${e.message}`; continue; }
      const took = this.now() - t0;
      if (raw && typeof raw.then === 'function') { p.strikes++; p.error = `${joint} returned a promise; a joint answers synchronously`; continue; }
      if (took > JOINT_BUDGET_MS) { p.strikes++; p.error = `${joint} took ${took}ms (budget ${JOINT_BUDGET_MS})`; continue; }
      const { decision, error } = validateJointDecision(joint, raw);
      if (error) p.error = error;
      if (!decision) { if (branches.length) this.record({ joint, pak: p.name, answer: null, rule: null, facts: frozen, branches }); continue; }
      p.answered++;
      const answer = { ...decision, pak: p.name };
      const rule = trace.findLast?.(t => t.fired)?.rule ?? null;
      this.remember({ at: this.now(), joint, pak: p.name, answer, rule, facts: summarize(frozen) });
      this.record({ joint, pak: p.name, answer, rule, facts: frozen, branches });
      for (const a of decision.also ?? []) this.perform(a, p.name, joint);
      return decision.do === 'default' ? null : answer;
    }
    return null;
  }

  perform(action, pak, joint) {
    try {
      if (action.do === 'request') this.effects.request?.({ ...action, pak, joint, from: this.character ?? this.agent });
      else if (action.do === 'note') this.effects.note?.(`[${pak}] ${action.text}`);
    } catch (e) { this.log(`[joints] ${pak} ${action.do} failed: ${e.message}`); }
  }

  record(row) {
    try { this.effects.record?.({ at: this.now(), agent: this.agent, character: this.character, ...row, facts: summarize(row.facts ?? {}) }); }
    catch (e) { this.log(`[joints] record failed: ${e.message}`); }
  }

  remember(row) { this.trace.push(row); if (this.trace.length > TRACE_KEEP) this.trace.splice(0, this.trace.length - TRACE_KEEP); }

  status() {
    return {
      assignment_file: pakAssignmentFile(this.fleet, this.env), error: this.error, asked: this.asked,
      paks: this.paks.map(p => ({ name: p.name, file: p.file, loaded: !!p.pak && p.strikes < STRIKES,
        joints: Object.keys(p.pak?.joints ?? {}), options: p.options, strikes: p.strikes, error: p.error, answered: p.answered })),
      last: this.trace.slice(-10),
    };
  }
}

// A pak's own decision point, recorded with the data that decided it: `ctx.branch('chase_or_guard',
// { quarry_hp: 'ouch3', allies_near: 1 })`. Bounded, so a pak cannot flood the log from one ask.
function branchRecorder(list) {
  return (name, data = {}) => {
    if (list.length >= 8) return;
    try { list.push({ name: String(name).slice(0, 60), data: JSON.parse(JSON.stringify(data ?? {}).slice(0, 2000)) }); }
    catch { list.push({ name: String(name).slice(0, 60), data: null }); }
  };
}

function structuredCloneSafe(v) { try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v ?? null)); } }
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}
function summarize(facts) {
  const out = {};
  for (const [k, v] of Object.entries(facts)) {
    if (k === 'self' && v && typeof v === 'object') out.self = { health_pct: v.health_pct ?? null };
    else if (v == null || typeof v !== 'object') out[k] = v;
    else if (Array.isArray(v)) out[k] = `[${v.length}]`;
    else out[k] = v.name ?? v.kind ?? v.id ?? '{…}';
  }
  return out;
}

// ------------------------------------------------------------------------------------------- the dry run
//
// A pak may carry `scenarios`: { name: { joint, facts, options?, memory?, expect? } }. `dry` runs each one
// through the same `runHandler` and validator the keeper uses, and prints every rule considered. With
// --facts it runs your facts instead, so "what would the fleet do if Foeman walked through the firewall
// right now" is a file you write and a command you run, not a live experiment.
export function dryRun(pak, { scenarios = null, options = {} } = {}) {
  const rows = [];
  for (const [name, sc] of Object.entries(scenarios ?? pak.scenarios ?? {})) {
    const handler = pak.joints?.[sc.joint];
    if (!handler) { rows.push({ scenario: name, joint: sc.joint, error: `${pak.name} does not answer ${sc.joint}` }); continue; }
    const memory = structuredCloneSafe(sc.memory ?? {});
    const branches = [];
    let raw = null, trace = [], error = null;
    try {
      ({ raw, trace } = runHandler(handler, deepFreeze(structuredCloneSafe({ ...sc.facts, joint: sc.joint })),
        { options: { ...(pak.options ?? {}), ...options, ...(sc.options ?? {}) }, memory, now: Date.now(), branch: branchRecorder(branches) }));
    } catch (e) { error = e.message; }
    const v = error ? { decision: null } : validateJointDecision(sc.joint, raw);
    const answer = v.decision ?? null;
    const expected = sc.expect === undefined ? undefined : sc.expect;
    const pass = expected === undefined ? null
      : expected === null ? answer === null || answer.do === 'default'
        : !!answer && Object.entries(expected).every(([k, val]) => JSON.stringify(answer[k]) === JSON.stringify(val));
    rows.push({ scenario: name, joint: sc.joint, trace, answer, branches, error: error ?? v.error ?? null, expect: expected, pass, memory });
  }
  return rows;
}

function printDry(pak, rows) {
  console.log(`${pak.name}${pak.about ? ' -- ' + pak.about : ''}`);
  for (const r of rows) {
    const mark = r.pass === true ? 'ok  ' : r.pass === false ? 'FAIL' : '    ';
    console.log(`\n${mark} ${r.scenario}  [${r.joint}]`);
    for (const t of r.trace ?? []) console.log(`       ${t.fired ? '->' : '  '} ${t.rule}: ${t.why ?? ''}${t.fired ? '  => ' + JSON.stringify(t.answer) : ''}`);
    for (const b of r.branches ?? []) console.log(`       branch ${b.name}: ${JSON.stringify(b.data)}`);
    console.log(`       answer: ${r.answer ? JSON.stringify(r.answer) : 'default (the keeper does what it always did)'}`);
    if (r.error) console.log(`       error: ${r.error}`);
    if (r.pass === false) console.log(`       expected: ${JSON.stringify(r.expect)}`);
  }
}

// -------------------------------------------------------------------------------------------------- CLI
async function main(argv) {
  const [cmd = 'list', ...rest] = argv;
  const flag = n => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : null; };
  const json = rest.includes('--json');
  const load = async name => {
    const file = findPak(name) ?? findPak(name, { dirs: [EXAMPLE_DIR] });
    if (!file) throw new Error(`no pak "${name}" in ${[...pakDirs(), EXAMPLE_DIR].join(', ')}`);
    const { pak, errors } = checkPak(await import(pathToFileURL(file).href), file);
    return { pak, errors, file };
  };
  if (cmd === 'joints') {
    if (json) return console.log(JSON.stringify(Object.fromEntries(Object.entries(JOINTS).map(([k, v]) => [k, { ...v, verbs: Object.keys(v.verbs) }])), null, 2));
    for (const [name, j] of Object.entries(JOINTS)) {
      console.log(`${name}   (${j.clock})\n  asked at: ${j.asked_at}\n  when:     ${j.when}\n  facts:    ${j.facts}\n  answers:  ${j.answers}\n`);
    }
    return;
  }
  if (cmd === 'check') {
    const { pak, errors, file } = await load(rest[0]);
    console.log(`${pak?.name ?? rest[0]}  ${file}\n  joints: ${Object.keys(pak?.joints ?? {}).join(', ') || '(none)'}`);
    for (const e of errors) console.log(`  ! ${e}`);
    return process.exitCode = errors.length ? 1 : 0;
  }
  if (cmd === 'dry') {
    const { pak, errors } = await load(rest[0]);
    if (!pak) throw new Error(errors.join('; '));
    let scenarios = null;
    const facts = flag('--facts');
    if (facts) scenarios = { [basename(facts)]: { joint: flag('--joint') ?? Object.keys(pak.joints)[0], facts: JSON.parse(readFileSync(facts, 'utf8')) } };
    const rows = dryRun(pak, { scenarios });
    if (json) console.log(JSON.stringify(rows, null, 2)); else printDry(pak, rows);
    return process.exitCode = rows.some(r => r.pass === false || r.error) ? 1 : 0;
  }
  if (cmd === 'status') {
    const fleet = flag('--fleet');
    const file = pakAssignmentFile(fleet);
    let book = null;
    try { book = JSON.parse(readFileSync(file, 'utf8')); } catch { /* absent */ }
    console.log(`${file}: ${book ? 'present' : 'absent -- every joint answers default'}`);
    if (book) console.log(`  fleet: ${resolvePaks(book).map(p => p.pak).join(', ') || '(none)'}`);
    for (const [k, v] of Object.entries({ ...(book?.agents ?? {}), ...(book?.characters ?? {}) }))
      console.log(`  ${k}: ${resolvePaks(book, { agent: k, character: k }).map(p => p.pak).join(', ') || '(none)'}${v ? '' : ''}`);
    return;
  }
  // list
  console.log('JOINTS'); for (const [k, j] of Object.entries(JOINTS)) console.log(`  ${k.padEnd(18)} ${j.when}`);
  console.log('\nPAKS (search path: ' + pakDirs().join(', ') + ')');
  const all = listPaks({ examples: true });
  if (!all.length) console.log('  none');
  for (const p of all) {
    let line = `  ${p.name.padEnd(22)} ${p.example ? '(example) ' : ''}${p.file}`;
    try { const { pak, errors } = checkPak(await import(pathToFileURL(p.file).href), p.file); line += `\n      ${Object.keys(pak?.joints ?? {}).join(', ')}${errors.length ? '  ! ' + errors.join('; ') : ''}`; }
    catch (e) { line += `\n      ! does not load: ${e.message}`; }
    console.log(line);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
}
