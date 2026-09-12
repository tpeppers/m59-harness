#!/usr/bin/env node
// WHAT A PAD DECLARES IT NEEDS, AND HOW THAT IS ANSWERED. No session, no prompt, no top-level
// await -- on purpose, and the purpose is a bug.
//
//   import { knows, knowsAny, MET, UNKNOWN } from '../../tools/m59-padcheck.mjs';
//
// WHY THIS IS NOT IN m59-fleetscratch.mjs, WHERE IT STARTED. The session module runs the prompt,
// which means it loads the pads, which means a pad that imported the helpers from it closed a
// cycle: the pad waited for the session module to finish evaluating, and the session module was
// inside `await loadPads()` waiting for the pad. Node does not call that an error. It prints
//
//     Warning: Detected unsettled top-level await at .../m59-fleetscratch.mjs:460
//
// and exits 0 with NOTHING else on stdout -- no pads, no prompt, no reason. Found 2026-09-11 by
// the peer session running the raid, who copied the import straight out of the example pad,
// which is where it was wrong: the example told every future pad to do the one thing that breaks.
//
// The unit tests could not see it. They import loadPads directly, so the session's top-level
// await never runs and the cycle never closes -- the exact shape of bug a unit test misses and an
// integration test catches, which is why there is now a child-process case for it.
//
// So the rule this file exists to enforce: A PAD IMPORTS FROM HERE AND NEVER FROM THE SESSION.
// Nothing in this module awaits at the top level, and nothing in it imports m59-fleetscratch.mjs,
// so no pad can close that cycle again.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbilityName, abilityNames } from './m59-fleetscript.mjs';
import { fleetName, stateFileFor } from './m59-fleetpath.mjs';
import { loadBook } from './m59-abilities.mjs';
import { isLoopbackHost, adminTarget } from './m59-dm.mjs';
import { resolveControlUrl } from './m59-fleetpath.mjs';

// ------------------------------------------------------------------ what a pad says it needs
//
// THREE TIERS, BECAUSE "CAN THIS FLEET DO THIS" HAS THREE DIFFERENT ANSWERS AND ONLY ONE OF
// THEM IS A REFUSAL. The operator's framing, 2026-09-11, from two real errands:
//
//   requires    Structural. Without it the errand cannot progress AT ALL -- and the
//               characteristic failure is not an error, it is an infinite loop doing nothing.
//               A Shal'ille drill on a character with no Shal'ille spells and no intellect
//               left to learn any will try to buy, fail, and try again for ever. So an unmet
//               requirement REFUSES before anything walks.
//   capabilities Conditional. The pad has a branch for its absence and will route around it.
//               Fighting the Ghost of Far'nohl wants enchanted weapons, and either already
//               having them or having somebody who can cast it will do. Reported, never a
//               refusal.
//   suggests    Causal but not structural. The ghost resists non-magical weapons at 90%, so
//               the errand technically runs without enchantment and technically takes twenty
//               times as long. Advice, with the mechanism named.
//
// Each entry is `{ what, why, check }` where `check` is a predicate over one character's
// observed state. THE PREDICATE IS A FUNCTION AND NOT A NAME because the interesting
// requirements are not "has skill X" -- they are "has X, or the capacity to learn it", which
// is two reads and some arithmetic.
//
// A CHECK HAS THREE OUTCOMES AND THE THIRD IS THE IMPORTANT ONE. `true` is met, a string is unmet
// and the string is why; `null` is UNKNOWN -- we could not find out. Unknown is neither a refusal
// nor permission, and it has to be visible as itself, because an absent cache and a character that
// genuinely lacks the ability are the same silence from here.
//
// CORRECTED 2026-09-11, AND THE CORRECTION IS WORTH KEEPING. This comment used to justify itself
// with "the ability books cover 4 of the 37 characters in this fleet's roster, so scoring an absent
// book as 'does not know it' would report 33 of 37 ineligible". Both numbers were wrong: they came
// from reading substrate/fleet-state.json directly instead of resolving fleetName() ->
// stateFileFor(), which on this machine is substrate/fleets/prod.json -- 22 handles, of which 21
// have a book. The cold-cache problem is therefore much SMALLER here than the number claimed.
//
// The design does not change, and it is worth saying why it does not. Unknown-is-not-unmet is right
// on its own terms -- a cache that is one character short still produces one confident wrong answer,
// and the peer session running the raid hit exactly this case from a different direction, where the
// unreadable fact was a weapon's enchantment flag that NO cache holds. But a guarantee defended by a
// false measurement is one bad afternoon away from being deleted by somebody who checks. The real
// argument is the mechanism, not the count.
export const MET = true;
export const UNKNOWN = null;

/**
 * UNKNOWN, WITH THE REASON FROM THE ONLY CODE THAT KNOWS IT — the check itself.
 *
 * A bare `null` says "I cannot tell" and nothing else, which left the renderer guessing at the
 * cause. Guessing produced the bug this exists to end: every silent unknown was reported as a
 * missing ability book, including for entries that never touched abilities, and the summary then
 * advised refreshing books that could not have changed the answer.
 *
 * Gating on whether the entry declared `abilities` was the first fix and it was too crude --
 * `knows('bless')` reads the ability book whether or not its entry bothered to name the ability.
 * So the check says why, because the check is the only thing that can be right about it.
 *
 * `cause` is for the summary, which groups unknowns by what would actually resolve them:
 *   no-book       a cache exists for this and is missing       -> run m59-abilities.mjs
 *   no-roster     the handle is not ours                       -> nothing to run
 *   needs-live    no cache on disk holds this at all           -> a live read, no refresh helps
 */
export const unknownBecause = (why, cause = 'needs-live') =>
  ({ __padcheckUnknown: String(why), __padcheckCause: cause });

const asUnknown = (r) =>
  r && typeof r === 'object' && typeof r.__padcheckUnknown === 'string' ? r : null;

// ------------------------------------------------------------ letting a predicate read the world
//
// A WORLD PREDICATE THAT CANNOT READ THE WORLD IS BROKEN BY CONSTRUCTION.
//
// Reported by the Marco Polo session, 2026-09-12, and they are right. A checkpoint's `holds` is
// asked things like "is he in room 49, whole, and not travelling" -- and the setup ctx was
// `{ agents, params, pad, say }`, with no way to ask the broker anything. So their pad carried
// its own JSON-RPC helper, which as they put it "works and is wrong": every pad would copy it,
// and each copy would get the timeout, the error handling and the units boundary slightly
// differently. That is four bugs waiting in four pads instead of one shared answer.
//
// WHY THIS IS A READER AND NOT `call`. m59-fleetscript.mjs keeps its `call` private on purpose --
// "so a step cannot bypass the pacing or the timeout" -- and handing it to every pad would undo
// that decision by the back door. A predicate does not need to DO anything; it needs to LOOK. So
// this is an allowlist of reads and refuses everything else by name.
//
// The membership matches `PROD_READ_ONLY` in m59-shadow.mjs:84, which guards a different boundary
// (what may be read from production) with the same answer today. They are deliberately two sets
// rather than one import: "safe to read from prod" and "enough for a world predicate" are
// different questions that happen to agree, and coupling them would be wrong the first time
// either changes. If you add to one, look at the other.
export const WORLD_READ = Object.freeze([
  'fleet', 'look', 'status', 'equipment', 'inventory', 'abilities', 'map', 'describe',
  // NOT A BROKER CALL. The ledger is a local file (m59-ledger.mjs, readLedger), so this one is
  // dispatched locally — and every row comes back TAGGED, because a caller cannot tell an
  // observed row from a sampled one by looking at it.
  'ledger',
]);

// ------------------------------------------------------ the dishonest answer, not the honest gap
//
// THREE-VALUED VERDICTS DO NOT CATCH A WRONGLY-TYPED RESULT THAT FORMATS PERFECTLY.
//
// `unknownBecause` handles the honest gap -- "I could not find out". This handles the other
// failure, which is worse because it never looks like a failure: an accessor confidently answers
// about a field that is not there, `undefined` formats fine, matches nothing, and the nothing
// reads as a finding.
//
// Three of these in one day, from two sessions (2026-09-11/12):
//
//   * `health.fleet` read as an agent list. It is a STRING -- "prod". Announced 0 of 4
//     characters in game.
//   * a spell ability read off a field that does not exist: `undefined`, nineteen times.
//   * `status.wielding` read for a weapon. `wielding` is on the EQUIPMENT reply, not the status
//     one -- m59-broker.mjs:11711 returns it, and :11674 already says so in its own note:
//     "wielding — a different list, and the server's own. Call `equipment` for it." The read
//     produced the literal string "undefined", matched no weapon, and concluded that every
//     raider carried mundane steel.
//
// Nothing was unknown in any of them. The accessor answered, and the answer was about nothing.
//
// The rule is one this repository already has twice under other names -- "status has two shapes"
// in m59-fleetscript's vitalsOf, and "a coordinate carries its unit, and a bare number is
// refused" in m59-coords -- so this is a third instance rather than a new idea: ASSERT THE SHAPE
// AT THE BOUNDARY AND REFUSE ONE YOU DO NOT RECOGNISE.

/**
 * One recognisable key from each allowlisted read.
 *
 * DELIBERATELY LOOSE. It asserts that a reply is RECOGNISABLE as that tool's output, not that it
 * matches a schema: a check that refused every added field would be switched off the first week
 * the broker grew one. What it catches is the reply being something else entirely -- a string, an
 * error object, another tool's answer -- which is the case that produced all three incidents.
 */
export const READ_SHAPES = Object.freeze({
  status:    ['hp', 'vitals', 'where', 'room', 'name', 'busy'],
  look:      ['room', 'objects', 'you', 'vitals'],
  equipment: ['wielding', 'worn', 'items'],
  inventory: ['items'],
  abilities: ['skills', 'spells'],
  fleet:     ['agents', 'fleet', 'characters'],
  map:       ['room', 'rooms', 'matches', 'route'],
  describe:  ['description', 'name', 'text'],
});

/**
 * Where a commonly-misread field actually lives. Each entry is an incident.
 *
 * TWO AXES, NOT ONE. A field can be on a different REPLY (`wielding` is on `equipment`, not
 * `status`) — and it can be on the right reply and still absent because of the PATH the reply
 * took. `KeeperProxy` rebuilds a keeper-backed character's equipment from names alone
 * (m59-broker.mjs, `KeeperProxy.equipment` — :1892 in this checkout, :1897 in prod-deploy,
 * which is why these citations name the SYMBOL: a harness line number is checkout-relative
 * and has no `repo_commit` to pin it the way a corpus citation does):
 *
 *     equipped: (s.equipment ?? []).map((name, i) => ({ id: -1 - i, name, nameRsc: name }))
 *
 * Every field the rebuild does not name is dropped, and the `id` is SYNTHESISED as a negative
 * counter — it is not an object id at all. Every prod character is keeper-backed, so that rebuild
 * is the path `equipment` actually takes for all of them: a field can exist in the serializer,
 * work when read straight off the keeper, and be missing for all twenty-three characters through
 * the broker.
 *
 * The remedy, which is the sentence to remember rather than the table:
 * **VERIFY A NEW FIELD THROUGH THE BROKER ON A KEEPER-BACKED CHARACTER, never only through the
 * keeper.** Reported by the deaths-analysis session, 2026-09-12.
 */
export const MISPLACED_FIELDS = Object.freeze({
  'status.wielding': 'the `equipment` reply — m59-broker.mjs:11711, and :11674 says so itself',
  'status.gold': 'nowhere: `status.gold` is ALWAYS null on this broker. Money is a shilling ' +
                 'stack in the pack — sum the inventory, or use purseOf',
  'look.exits': 'nowhere for a keeper-backed character: keeperView returns exits:[] ' +
                'unconditionally, so an empty list is an absence and not a measurement',
  'equipment.equipped.id': 'nowhere real: KeeperProxy synthesises it as `-1 - i` ' +
                '(m59-broker.mjs, KeeperProxy.equipment), so it is a negative counter and not an object id. ' +
                'Never address anything with it',
});

/**
 * Fields the KeeperProxy rebuild DROPS, so a reader knows the difference between "the server
 * does not have this" and "this path does not carry it".
 *
 * Deliberately short and deliberately not a schema: it lists what somebody has actually been
 * bitten by. A one-line fix follows from knowing which of the two it is, and the dead end that
 * precedes it costs an evening.
 */
export const PROXY_DROPS = Object.freeze({
  equipment: 'KeeperProxy rebuilds equipped items from NAMES only (m59-broker.mjs, KeeperProxy.equipment) — ' +
             'everything except name/nameRsc is dropped and the id is synthetic. If a field is ' +
             'in the serializer but missing here, it is the rebuild, not the server. Verify a ' +
             'new field through the BROKER on a keeper-backed character, never only the keeper',
});

export function assertShape(tool, reply, { where = 'a world read' } = {}) {
  const want = READ_SHAPES[tool];
  if (!want) return reply;                       // not a shape we claim to know
  if (reply == null || typeof reply !== 'object' || Array.isArray(reply))
    throw new Error(
      `${where}: "${tool}" answered with ${Array.isArray(reply) ? 'an array' : typeof reply}` +
      `${typeof reply === 'string' ? ` (${JSON.stringify(String(reply).slice(0, 40))})` : ''}, ` +
      `not an object. Reading a field off that gives undefined, which formats perfectly and ` +
      `means nothing — so this refuses instead.`);
  if (!want.some(k => k in reply))
    throw new Error(
      `${where}: "${tool}" answered with an object carrying none of ${want.join(', ')} — ` +
      `keys present: ${Object.keys(reply).slice(0, 8).join(', ') || '(none)'}. That is not a ` +
      `${tool} reply, and accessing it would produce confident nonsense.`);
  return reply;
}

// ------------------------------------------------------------------ an id is not a number
//
// AN OBJECT ID IS A HANDLE THAT EXPIRES, AND HANDING BACK A NUMBER LOSES THAT.
//
// m59-dm.mjs has said since it was written that "OBJECT IDS ARE NOT STABLE — the server renumbers
// objects when it garbage-collects, which it does around a save", and this repository already
// obeys that where it addresses things: `m59-scene.mjs` resolves names again at load rather than
// trusting a capture, and never addresses `object_at_capture`. What was missing is the same rule
// for a value a PAD is holding.
//
// Three facts, each independently unpleasant:
//
//   * ids recycle. Measured by the deaths-analysis session: 23% of sampled ids named a DIFFERENT
//     object three days later.
//   * `look_at` has been observed answering with the PREVIOUS call's object carrying its own
//     wrong id — two calls in nine, reproduced independently by two sessions on 2026-09-12. I
//     have not reproduced it here and record it as theirs, not as mine.
//   * some ids are not ids. KeeperProxy synthesises `id: -1 - i` for equipped items
//     (m59-broker.mjs, KeeperProxy.equipment), so a negative id is a counter and addressing anything with it is
//     meaningless.
//
// So `handle()` stamps an id with when it was read and what read it, and `usableHandle()` refuses
// one that has crossed a call boundary. A pad that holds an id across a read is doing the thing
// that silently acts on somebody else's property; it should be refused, not trusted.
// WHY THERE IS NO GENERAL READER-SIDE GUARD FOR A FABRICATED VALUE, and it is structural rather
// than a gap somebody will close later. The deaths-analysis session's argument, 2026-09-12:
//
//   Every guard on the READING side tests for ABSENCE or SHAPE. `unknownBecause` catches the
//   honest gap; `assertShape` catches the wrongly-typed reply; `PROXY_DROPS` catches the field a
//   path dropped. A fabricated value has none of those properties -- it is present, correctly
//   typed, in the right field, and internally consistent. There is nothing left for a reader to
//   test. `usableHandle` catches the synthetic id ONLY because negative is a tell, and a
//   synthesiser that counted upward would defeat it in one line.
//
//   So fabrication can only be refused at the point of MANUFACTURE. The rule is a constraint on
//   synthesisers, not a guard for readers: CODE THAT INVENTS A VALUE INTO A FIELD WHICH NORMALLY
//   CARRIES A SERVER VALUE MUST MARK IT AS INVENTED, OR MUST REFUSE TO FILL THE FIELD AT ALL.
//
// Concretely, `KeeperProxy.equipment` could return `id: null` with `synthetic: true` beside it,
// and every absence-guard above would then work -- because the fabricated case would have been
// converted into the absent case, which is the one class we can all detect.
//
// NOT PROPOSED AS A CHANGE. `armedForSure()` reads that field, every prod character takes that
// path, and a null where a number was expected fails in the direction of walking a fleet at a
// boss unarmed. That is an operator's call with a test behind it. It is written down here so the
// next person who goes looking for a reader-side answer finds out why there isn't one.

export const HANDLE_TTL_MS = 0;     // zero on purpose: see usableHandle

let READ_EPOCH = 0;
/** Called by every world read. One tick per read is what "crossed a call boundary" means. */
export const bumpEpoch = () => ++READ_EPOCH;
export const currentEpoch = () => READ_EPOCH;

export function handle(id, { from = 'a read', at = Date.now() } = {}) {
  return Object.freeze({
    __handle: true, id, from, at, epoch: READ_EPOCH,
    synthetic: typeof id === 'number' && id < 0,
  });
}
export const isHandle = (h) => !!(h && typeof h === 'object' && h.__handle === true);

/**
 * May this handle still be used to address something?
 *
 * THE TTL IS ZERO AND THAT IS THE DESIGN. A time-based window would be a guess about how long the
 * server takes to garbage-collect, and the failure it is guarding is not slow — `look_at` handing
 * back the previous call's object is one call wide. So the rule is the epoch: a handle read before
 * the most recent world read has crossed a boundary and is refused. Re-read to get a fresh one.
 */
export function usableHandle(h, { where = 'addressing an object' } = {}) {
  if (!isHandle(h))
    throw new Error(`${where}: that is a bare id (${JSON.stringify(h)}), not a handle. Object ids ` +
                    `are renumbered around every save and 23% named a different object within ` +
                    `three days — read it through a world read so it carries when it was read.`);
  if (h.synthetic)
    throw new Error(`${where}: id ${h.id} is SYNTHETIC — KeeperProxy numbers equipped items ` +
                    `-1, -2, -3 (m59-broker.mjs, KeeperProxy.equipment) because it rebuilt them from names. It is ` +
                    `a counter, not an object id, and nothing can be addressed with it.`);
  if (h.epoch !== READ_EPOCH)
    throw new Error(`${where}: this handle was read ${READ_EPOCH - h.epoch} world read(s) ago ` +
                    `(from ${h.from}). Ids recycle, and look_at has been seen answering with the ` +
                    `PREVIOUS call's object carrying its own wrong id — so an id held across a ` +
                    `call boundary may now name somebody else's property. Read it again.`);
  return h.id;
}

/**
 * A COUNT MAY NOT BE PRINTED CLEAN IF ANY INPUT WAS UNSHAPED.
 *
 * The sharper half of the rule, from the session that made the mistake: asserting at the boundary
 * stops the read, but the damage is done by the FORMATTER, which prints "0 of 4 in game" and
 * makes a wrongly-typed input look like a measurement. Their sentence, which is the design:
 *
 *     "0 of 4 in game (4 unknown: health.fleet is a string, not an agent list)"
 *     — is a sentence I would have caught at a glance.
 *
 * So a tally carries its bad inputs, and rendering one refuses to hide them. This is the same
 * discipline as `sceneConfidence` counting estimates and `formatPreflight` counting unknowns: a
 * number whose denominator includes things nobody could read is not a number yet.
 */
export function tally(items = [], classify) {
  const out = { total: 0, counted: 0, unshaped: [] };
  for (const item of items) {
    out.total++;
    try {
      const v = classify(item);
      if (v) out.counted++;
    } catch (e) {
      out.unshaped.push({ item: typeof item === 'string' ? item : (item?.name ?? '?'),
                          why: e.message });
    }
  }
  return out;
}

export function formatTally(t, what = 'counted') {
  const head = `${t.counted} of ${t.total} ${what}`;
  if (!t.unshaped.length) return head;
  // NEVER THE BARE COUNT WHEN SOMETHING COULD NOT BE READ. The count is still shown, because
  // hiding it would be its own lie, but it arrives with the reason it is incomplete attached.
  const reasons = [...new Set(t.unshaped.map(u => u.why))];
  return `${head} (${t.unshaped.length} unshaped: ${reasons[0]}` +
         (reasons.length > 1 ? `; and ${reasons.length - 1} other reason(s)` : '') + ')';
}

/**
 * Read a field, and REFUSE a path the object does not have.
 *
 * The direct counter to the three incidents: `fieldOf(status, 'wielding')` throws, and names
 * where `wielding` actually lives, instead of handing back `undefined` for somebody to match
 * against and conclude something from.
 *
 * `orNull` is for a field that is genuinely optional — it returns null, which is a value a
 * three-valued check can carry as UNKNOWN. The default is to throw, because the common case is
 * that a missing field means the READER is wrong, not the world.
 */
export function fieldOf(obj, path, { where = 'a world read', orNull = false, from = null } = {}) {
  const parts = String(path).split('.');
  let cur = obj;
  for (const [i, k] of parts.entries()) {
    if (cur == null || typeof cur !== 'object' || !(k in cur)) {
      if (orNull) return null;
      const so_far = parts.slice(0, i).join('.') || '(the reply)';
      // Keyed by `tool.field` where the incident had a tool, so a caller that says which reply
      // it is reading gets the pointer; a bare path still matches an unambiguous entry.
      const hint = (from ? MISPLACED_FIELDS[`${from}.${path}`] : null) ?? MISPLACED_FIELDS[path]
        ?? Object.entries(MISPLACED_FIELDS)
             .filter(([k]) => k.endsWith(`.${path}`))
             .map(([k, v]) => `${v} (looked up as ${k})`)[0] ?? null;
      // AND THE SECOND AXIS: the reply may be right and the PATH may have dropped it.
      const dropped = from ? PROXY_DROPS[from] : null;
      throw new Error(
        `${where}: "${path}" is not there — ${so_far} carries ` +
        `${cur && typeof cur === 'object' ? Object.keys(cur).slice(0, 8).join(', ') || '(no keys)'
                                          : JSON.stringify(cur)}.` +
        (hint ? ` It lives in ${hint}.` : '') +
        (dropped ? ` And note the PATH: ${dropped}.` : '') +
        ` Returning undefined here is how a read about nothing becomes a finding.`);
    }
    cur = cur[k];
  }
  return cur;
}

// ------------------------------------------------------ ledger rows, and how far to trust each
//
// THREE KINDS OF ROW WEARING ONE TYPE. The ledger's own `type` field does NOT separate them, and
// that is the trap: `recordSample` derives events and writes them through `recordEvent`, so a row
// stamped `type: 'event'` may have a poller's clock. Verified in m59-ledger.mjs:
//
//   killed       m59-autopilot.mjs, `ledgerEvent('killed', ...)` — written when the autopilot
//                SAW the kill. OBSERVED: safe to count and to bucket by time.
//   level_up     m59-ledger.mjs, inside recordSample: `now.level !== was.level` compares TWO
//   level_lost   POLLS. SAMPLED: safe to NET per character, unsafe below the poll interval.
//   died         TWO PATHS SHARING ONE NAME, which is why this tags rows and not kinds:
//                  - death_sig changed at a poll -> the keeper RECONSTRUCTS where, at what
//                    health, against what. Trustworthy fields on a sampled clock.
//                  - the room became Underworld between samples -> `note: 'inferred from
//                    sampling'`, with no killer, no room and no health trail. INFERRED.
//
// The deaths-analysis session measured the split on prod: of 895 death rows, 758 reconstructed,
// 76 carrying that note, 61 detail_missing — about 15% degraded. On an inferred row a null killer
// means NOBODY WATCHED rather than "nothing killed it", and the critic's unbendable rule is that
// PVP must be SHOWN.
//
// THE TAG BELONGS AT THE SEAM, NOT IN THE CALLER, because a caller cannot see which it got: all
// three arrive as objects with a `kind` and a `t`. So the reader tags, and `joinable()` refuses
// the correlation that would otherwise read as a finding.
export const LEDGER_TRUST = Object.freeze({
  killed: { trust: 'observed',
            why: 'written when the autopilot saw the kill (m59-autopilot.mjs, ledgerEvent)' },
  level_up: { trust: 'sampled',
              why: 'derived by comparing two polls (m59-ledger.mjs, recordSample)' },
  level_lost: { trust: 'sampled',
                why: 'derived by comparing two polls (m59-ledger.mjs, recordSample)' },
  died: { trust: 'sampled',
          why: 'fired when the death signature changed AT A POLL — the keeper reconstructs the ' +
               'fields, so they are trustworthy, but the clock is the poller\'s' },
});

/** Tag one row. Per ROW, because `died` splits on its own note. */
export function tagRow(row) {
  const base = LEDGER_TRUST[row?.kind];
  if (!base) return { ...row, trust: 'unknown',
                      trust_why: `no trust rule for kind "${row?.kind}" — treat it as unread ` +
                                 `rather than assuming, and add it to LEDGER_TRUST when you know` };
  if (row.kind === 'died' && /inferred from sampling/i.test(row.note ?? ''))
    return { ...row, trust: 'inferred',
             trust_why: 'the room became Underworld between two samples. No killer, no room, no ' +
                        'health trail — a null killer here means NOBODY WATCHED, not "nothing ' +
                        'killed it"' };
  return { ...row, trust: base.trust, trust_why: base.why };
}

/** Is a killer field on this row worth reading at all? */
export const killerIsMeaningful = (row) =>
  row?.trust !== 'inferred' && !row?.detail_missing;

/**
 * May these two row kinds be correlated in time?
 *
 * THE REFUSAL IS THE WHOLE POINT. "X happened, then Y happened" about two sampled kinds is a
 * causal claim with an error bar of one poll interval, and it reads as a finding. The
 * deaths-analysis session published one and caught it; this is that refusal, moved to where a
 * pad meets the data.
 */
export function joinable(kindA, kindB, { pollMs = 5 * 60_000 } = {}) {
  const a = LEDGER_TRUST[kindA], b = LEDGER_TRUST[kindB];
  if (!a || !b)
    return { ok: false, why: `no trust rule for "${!a ? kindA : kindB}" — refusing rather than ` +
                             `guessing at its clock` };
  if (a.trust === 'observed' && b.trust === 'observed') return { ok: true, why: null };
  const sampled = [[kindA, a], [kindB, b]].filter(([, x]) => x.trust !== 'observed');
  return { ok: false,
           why: `refusing to correlate ${kindA} with ${kindB}: ` +
                sampled.map(([k, x]) => `${k} is ${x.trust} (${x.why})`).join('; ') +
                `. The resolution is one poll — about ${Math.round(pollMs / 60000)} minutes — so ` +
                `"${kindA} then ${kindB}" is a claim about ordering the data cannot support. ` +
                `Count per character over a window instead, which is what a sampled row is for.` };
}

/**
 * A read-only broker reader for a pad's setup, teardown and checkpoints.
 *
 * `read(tool, args)` -> the parsed reply. Refuses any tool not on the list, by name, before it
 * opens a socket -- so a pad that reaches for `travel` inside a `holds` finds out immediately
 * rather than by moving somebody during a question.
 */
export function worldReader({ url = null, timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  return async function read(tool, args = {}) {
    if (tool === 'ledger') {
      bumpEpoch();
      const { readLedger } = await import('./m59-ledger.mjs');
      const rows = readLedger({ sinceMs: args.sinceMs ?? 24 * 3600 * 1000 });
      const list = (Array.isArray(rows) ? rows : rows?.events ?? [])
        .filter(r => !args.agent || r.character === args.agent)
        .filter(r => !args.kind || r.kind === args.kind)
        .map(tagRow);
      return { rows: list, tagged: true,
               note: 'every row carries `trust` — observed | sampled | inferred | unknown. Use ' +
                     'joinable() before correlating two kinds in time.' };
    }
    if (!WORLD_READ.includes(tool))
      throw new Error(
        `"${tool}" is not a world read. A checkpoint may LOOK and may not ACT — the step ` +
        `vocabulary is where things happen, and a predicate that moves somebody is not a ` +
        `predicate. Allowed: ${WORLD_READ.join(', ')}.`);
    let target = url;
    if (!target) {
      const r = resolveControlUrl();
      if (!r.url) throw new Error(`no broker named: ${r.why}`);
      target = r.url;
    }
    const res = await fetchImpl(target, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
                             params: { name: tool, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    bumpEpoch();          // one tick per world read — see usableHandle
    const d = await res.json();
    let reply;
    try { reply = JSON.parse(d.result.content[0].text); }
    catch { reply = d.result?.content?.[0]?.text ?? d; }
    // ASSERTED AT THE BOUNDARY. This is the one place every pad's world read passes through, so
    // it is the one place a wrongly-shaped reply can be stopped before a predicate reads a field
    // off it and answers confidently about nothing.
    return assertShape(tool, reply, { where: `read('${tool}')` });
  };
}

// ------------------------------------------------------------ where the guarantees stop
//
// A `verify(fn)` BODY CAN DO ANYTHING, AND THAT IS NOT FIXABLE BY POLICY.
//
// The Marco Polo session named this precisely: the invariant holds for the SHAPE -- a pad still
// only emits steps[] -- and leaks through the BODIES, because a verify closure is arbitrary code
// and a fine rail genuinely needs a loop that reads a position, computes an aim and sends a walk
// forty times. There is no step vocabulary for that which would not just be a worse loop.
//
// Their conclusion, which I agree with: do not try to close it, AUDIT it. "Better an audited hole
// than an assumed floor." So this is a heuristic, clearly labelled as one, in the same spirit as
// `unsafe` being countable: a hole nobody can enumerate is just a hole.
//
// IT READS SOURCE TEXT, so it is fooled by indirection and says so. A pad that reaches the broker
// through a helper it imported will not be spotted, and that is a limit of the method rather than
// a claim that the pad is clean.
const BROKER_REACH = /\b(call|rpc|fetch)\s*\(|tools\/call/;

export function brokerReachingSteps(steps = []) {
  const hits = [];
  for (const [i, step] of [].concat(steps ?? []).entries()) {
    for (const key of ['fn', 'verify']) {
      const f = step?.[key];
      if (typeof f !== 'function') continue;
      let src = '';
      try { src = Function.prototype.toString.call(f); } catch { continue; }
      if (BROKER_REACH.test(src))
        hits.push({ index: i, kind: step.do ?? key, why: step.why ?? null });
    }
  }
  return hits;
}

export function formatBrokerReach(hits) {
  if (!hits.length) return '';
  return [
    `  ${hits.length} step body(ies) appear to reach the broker directly:`,
    ...hits.map(h => `    step ${h.index} (${h.kind})${h.why ? ` — ${h.why}` : ''}`),
    `  Below the step boundary the compiler's guarantees do not apply: no cancel-before-send, no`,
    `  health floor, no read-back. That is sometimes exactly right — a fine rail needs a loop the`,
    `  step vocabulary does not have — so this is an AUDIT, not a refusal. Better an audited hole`,
    `  than an assumed floor.`,
    `  (Heuristic: it reads source text, so a broker call made through an imported helper is not`,
    `  spotted. Absence here is not evidence of absence.)`,
  ].join('\n');
}

// ------------------------------------------------------------------ REQUIRES: LOCALADMIN
//
// A pad that sets the world up by fiat -- teleporting a body, freezing a monster, granting a
// stat -- is doing it over the maintenance socket, which is unauthenticated and IP-masked. That
// is a lab instrument and nothing else, so a pad says so:
//
//   export const script = { lab: true, async setup(ctx) { ... }, ... }
//
// `lab: true` injects the requirement below, so `check` refuses on a machine with no lab
// BEFORE anything is half-configured, with a sentence rather than a socket error.
//
// THIS IS FOR LEGIBILITY, NOT FOR SAFETY, and the difference matters. m59-dm.mjs refuses a
// non-loopback host at connect time and always will; that is the guard. This one exists so the
// refusal arrives at `check`, naming the pad, instead of forty seconds into a setup that has
// already moved four characters. A pad author who uses DM without declaring `lab: true` is not
// unsafe, just less legible -- and the backstop underneath them does not move.
export const LAB_REQUIREMENT = Object.freeze({
  what: 'a loopback lab server (REQUIRES: LOCALADMIN)',
  why: 'this pad configures the world over the DM maintenance socket, which is unauthenticated ' +
       'and exists only for a server on this machine',
  scope: 'fleet',
  check: () => {
    const t = adminTarget();
    return isLoopbackHost(t.host) ? MET
      : `the admin socket points at ${t.host}:${t.port}, which is not this machine — ` +
        `you do not have DM rights there and should not try to take them`;
  },
});

/** A pad's declarations, with the lab requirement folded in when it asked for one. */
export function declarationsOf(pad) {
  if (!pad?.lab) return pad ?? {};
  return { ...pad, requires: [LAB_REQUIREMENT, ...[].concat(pad.requires ?? [])] };
}

/**
 * Handle -> character name, from the roster. Null when the handle is not in it.
 *
 * ALSO RETURNS WHICH ROSTER IT READ, because "not in this fleet's roster" and "not in the roster
 * THIS CHECKOUT can see" are the same sentence about two very different facts.
 *
 * Reported by the Marco Polo session, 2026-09-12, correcting me: I said hk2 was in no roster on
 * this machine. True of the mindmap checkout's prod.json (22 agents, stale since a band
 * collision); false of the live one, where prod-deploy's prod.json has 23 and hk2's keeper was
 * answering on port 9533 as they typed. `check` reads whichever checkout it is run from, and
 * saying so is the difference between "this character does not exist" and "you are pointed at
 * the wrong file". That exact confusion cost this machine a prod outage the same day via
 * keeper-bands.json.
 */
export function rosterFor(fleet = fleetName()) {
  const path = stateFileFor(fleet);
  try { return { path, roster: JSON.parse(readFileSync(path, 'utf8')) ?? {}, why: null }; }
  catch (e) { return { path, roster: null, why: e.code === 'ENOENT' ? 'does not exist' : e.message }; }
}

export function characterFor(agent, fleet = fleetName()) {
  return rosterFor(fleet).roster?.[agent]?.credentials?.character ?? null;
}

/**
 * What one character is known to have, for a check to read.
 *
 * Offline by default: the ability book on disk is a cache written by m59-abilities.mjs, and
 * `read_at` is how stale it is. A check that needs the truth asks for a refresh, which needs a
 * broker; this is the cheap answer that can be given while deciding whether to bother.
 */
export function observedFor(agent, { fleet = fleetName() } = {}) {
  const { path: rosterPath, roster, why: rosterWhy } = rosterFor(fleet);
  const character = roster?.[agent]?.credentials?.character ?? null;
  // A HANDLE THAT DOES NOT RESOLVE IS A REFUSAL, NEVER AN EMPTY BOOK. loadBook('t4') returns
  // an empty book for a handle, because books are keyed by CHARACTER name -- so looking one up
  // by handle answers "knows nothing" about a character that may know everything. The same
  // shape of mistake as a skill named "short sword" instead of "short sword fighting", which
  // reported 0 of 21 and looked like a result.
  if (!character)
    return { agent, character: null, known: null, readAt: null, rosterPath, rosterWhy,
             rosterSize: roster ? Object.keys(roster).length : null };
  const book = loadBook(character);
  const known = new Map();
  for (const group of ['skills', 'spells'])
    for (const [name, value] of Object.entries(book[group] ?? {}))
      known.set(String(name).toLowerCase(), { group, value });
  const readAt = book.read_at ?? null;
  return { agent, character, known: known.size ? known : null, readAt, book, rosterPath };
}

// The two book readers say so when the book is absent, rather than returning a bare null and
// letting the renderer guess. See unknownBecause.
const rosterMiss = (obs) =>
  obs.rosterWhy
    ? `the roster this checkout reads (${obs.rosterPath}) ${obs.rosterWhy}`
    // An observer that supplies no path at all (a test double, or a caller with its own source)
    // still gets a sentence that does not pretend to name a file.
    : !obs.rosterPath
    ? `"${obs.agent}" is not in this fleet's roster — and the observer did not say which file ` +
      `that was, so the answer is about whatever roster it read`
    : `"${obs.agent}" is not in ${obs.rosterPath}` +
      (obs.rosterSize != null ? ` (${obs.rosterSize} handles)` : '') +
      ` — which is the roster THIS CHECKOUT reads, not necessarily the one the fleet is ` +
      `running from. Set M59_STATE_FILE if you meant another.`;

const noBook = (obs) => unknownBecause(
  obs.character
    ? `no ability book for ${obs.character} — run m59-abilities.mjs, or accept the risk`
    : rosterMiss(obs),
  obs.character ? 'no-book' : 'no-roster');

/** A check: does this character know this ability by name? */
export const knows = (name) => (obs) => {
  if (obs.known == null) return noBook(obs);
  return obs.known.has(String(name).toLowerCase()) ? MET
    : `${obs.character} does not know "${name}"`;
};

/** A check: does this character know ANY of these? The Shal'ille case. */
export const knowsAny = (names) => (obs) => {
  if (obs.known == null) return noBook(obs);
  const want = [].concat(names).map(n => String(n).toLowerCase());
  return want.some(n => obs.known.has(n)) ? MET
    : `${obs.character} knows none of: ${want.join(', ')}`;
};

/**
 * EVERY ABILITY A DECLARATION NAMES MUST BE AN ABILITY THE GAME HAS.
 *
 * Checked separately from running the checks, and at LOAD rather than at run, because a
 * misspelled ability name does not fail -- it evaluates to false for every character and
 * reports the whole fleet ineligible. `isAbilityName` reads the game's own skill and spell
 * tree out of koddb.json, so "shalille" is refused and "shal'ille" is not guessed at.
 *
 * A declaration may name an ability with `abilities: [...]` beside its `check` to get this.
 * It is not derived from the predicate, because a predicate is a function and cannot be read.
 */
export function checkDeclaredAbilities(rawPad) {
  const pad = declarationsOf(rawPad);
  const bad = [];
  const table = abilityNames().length;
  for (const tier of ['requires', 'capabilities', 'suggests'])
    for (const entry of [].concat(pad[tier] ?? []))
      for (const name of [].concat(entry?.abilities ?? []))
        if (!isAbilityName(name))
          bad.push(`${tier}: "${name}" is not a skill or spell this game has` +
                   (table ? '' : ' (and the ability table could not be read, so this is a guess)'));
  return bad;
}

/**
 * The feasibility matrix: what every named character can and cannot do, before anything walks.
 *
 * Returns rows per agent per declared entry. `refuse` is true only for an unmet REQUIREMENT --
 * a capability is a branch the pad takes care of and a suggestion is advice, and neither may
 * stop an errand an operator asked for.
 */
// SOME FACTS ARE ABOUT THE FLEET AND NOT ABOUT A CHARACTER, and a per-character render of one is
// wrong in a way that looks authoritative. "The fleet contains somebody who can cast enchant
// weapon" is true or false for the whole roster; printed per agent it reads as "19 of 21
// satisfied", which invents a distribution for a fact that has none.
//
// So an entry may declare `scope: 'fleet'` and its check is handed { agents, observations } ONCE.
// One evaluation, one row, agent null.
//
// Reported by the peer session running the raid, 2026-09-11, out of the two halves of `armed`: a
// raider wielding a magic weapon is per character, the fleet having a caster at all is not, and
// they measured the gap between them -- four raiders knew the spell and the fleet could still arm
// only about four weapons per mana cycle, so "has somebody who can cast it" was TRUE on every
// attempt that went in with mundane steel.
const entriesOf = (pad, tier) => [].concat(pad[tier] ?? []);
const scopeOf = (entry) => (entry && entry.scope === 'fleet' ? 'fleet' : 'agent');

// AND SOME FACTS DESTROY THE ANSWER TO ANOTHER ONE RATHER THAN BEING AN ANSWER THEMSELVES.
//
// The case, from the same raid: `equipment()` answers by weapon NAME only, so a pack holding two
// swords of one name -- one enchanted, one not -- makes "is this raider wielding a MAGIC weapon"
// unanswerable rather than false. A raider went in with the mundane twin of the sword that had
// just been enchanted, and the ghost "laughed off your pitiful blow".
//
// The peer asked whether that belongs in `requires`, and wondered whether it wanted a fourth tier
// named something like "this makes another declaration unreadable". IT IS NOT A FOURTH TIER. A
// tier says what an unmet entry costs the ERRAND -- refuse, branch, or advise. This is a statement
// about what it costs the CHECK. Two different axes, and collapsing them makes both mean less.
//
// It is `breaks`, and it needs no new verdict either, because the three already say it: a broken
// entry becomes UNKNOWN with the breaker named as the reason. Which is the literal truth -- we no
// longer know -- and it produces the render the peer said they wanted at 01:00 and did not have:
// the blank with its cause beside it rather than a bare "unsatisfied".
//
// WHAT THIS DELIBERATELY DOES NOT DO is make the broken entry refuse; unknown never refuses. If
// the breaking condition should stop the errand, declare IT as a `requires` -- which is the right
// answer for the duplicate-weapon case anyway, because it is structural, per character, and fixed
// by collapsing the duplicates. The two fields answer two questions and one entry may use both.
function breakersAmong(pad) {
  const out = [];
  for (const tier of ['requires', 'capabilities', 'suggests'])
    for (const entry of entriesOf(pad, tier))
      if ([].concat((entry && entry.breaks) || []).length) out.push({ tier, entry });
  return out;
}

function verdictOf(entry, arg) {
  try {
    const r = typeof entry.check === 'function' ? entry.check(arg) : UNKNOWN;
    if (r === MET) return { verdict: 'met', why: null, cause: null };
    const u = asUnknown(r);
    if (u) return { verdict: 'unknown', why: u.__padcheckUnknown, cause: u.__padcheckCause };
    if (r === UNKNOWN || r === undefined) return { verdict: 'unknown', why: null, cause: null };
    return { verdict: 'unmet', why: String(r), cause: null };
  } catch (e) {
    // A CHECK THAT THROWS IS UNKNOWN, NOT UNMET. It told us nothing about the character.
    return { verdict: 'unknown', why: `check threw: ${e.message}`, cause: 'check-threw' };
  }
}

export function preflight(rawPad, agents, { observer = observedFor } = {}) {
  const pad = declarationsOf(rawPad);
  const rows = [];
  const observations = new Map(agents.map(a => [a, observer(a)]));

  // Fleet-scoped entries first: one evaluation each, before anything per-character.
  for (const tier of ['requires', 'capabilities', 'suggests']) {
    for (const entry of entriesOf(pad, tier)) {
      if (scopeOf(entry) !== 'fleet') continue;
      const { verdict, why, cause } = verdictOf(entry, { agents, observations });
      rows.push({ agent: null, character: null, scope: 'fleet', tier, what: entry.what,
                  whyDeclared: entry.why ?? null, verdict,
                  why: verdict === 'unknown' && !why
                    ? 'nothing on disk could answer this about the fleet' : why,
                  cause: verdict === 'unknown' ? (cause ?? 'needs-live') : null,
                  refuse: tier === 'requires' && verdict === 'unmet' });
    }
  }

  for (const agent of agents) {
    const obs = observations.get(agent);
    for (const tier of ['requires', 'capabilities', 'suggests']) {
      for (const entry of entriesOf(pad, tier)) {
        if (scopeOf(entry) === 'fleet') continue;
        const scored = verdictOf(entry, obs);
        let { verdict } = scored;
        let why = scored.why;
        let cause = scored.cause;
        // AN UNKNOWN MUST CARRY ITS OWN CAUSE, AND THIS USED TO INVENT ONE.
        //
        // Every silent unknown got "no ability book for X — run m59-abilities.mjs", whether or
        // not the entry had anything to do with abilities. The peer session's raid declared "a
        // weapon in hand" and "the throne room is enterable" -- no `abilities` on either -- and
        // both rendered 21 rows blaming a missing ability book, with a footer telling the reader
        // to refresh books that would not have changed either answer.
        //
        // That is worse than an unknown with no reason at all, and it is precisely the failure
        // three-valued checks exist to prevent: it sends the reader to a fix that cannot work,
        // with the confidence of a diagnosis. Reported 2026-09-11, and it was the first thing
        // they said to fix after the hang.
        //
        // So the ability-book explanation is offered ONLY where the entry named abilities, and
        // a check that returns null without saying why is reported as exactly that.
        if (verdict === 'unknown' && !why) {
          // A bare null from a check that did not use the helpers. The honest answer is that we do
          // not know why, and saying so beats naming a fix at random.
          why = !obs.character
            ? rosterMiss(obs)
            : `this check returned no verdict and no reason — it reads something no cache on ` +
              `disk holds, so only a live read can answer it`;
          cause = obs.character ? 'needs-live' : 'no-roster';
        }
        rows.push({ agent, character: obs.character, scope: 'agent', tier, what: entry.what,
                    whyDeclared: entry.why ?? null, verdict, why, cause,
                    refuse: tier === 'requires' && verdict === 'unmet' });
      }
    }
  }

  // APPLY `breaks` LAST, over the finished rows, so the order entries were declared in does not
  // matter. A broken row goes to unknown carrying the breaker's name. An already-unknown row keeps
  // its own reason: the first cause is the useful one.
  for (const { entry } of breakersAmong(pad)) {
    const targets = new Set([].concat(entry.breaks));
    for (const b of rows.filter(r => r.what === entry.what && r.verdict === 'unmet')) {
      for (const r of rows) {
        if (!targets.has(r.what)) continue;
        // A fleet-scoped breaker breaks every row; an agent-scoped one breaks only its own agent.
        if (b.scope === 'agent' && r.scope === 'agent' && r.agent !== b.agent) continue;
        if (r.verdict !== 'met' && r.verdict !== 'unmet') continue;
        r.verdict = 'unknown';
        r.refuse = false;
        r.cause = 'broken';
        r.why = `unanswerable: ${entry.what}` + (b.why ? ` (${b.why})` : '');
      }
    }
  }
  return rows;
}

// THE SUMMARY, THEN THE EXCEPTIONS. A full matrix is 8 entries x 21 characters = 201 lines, and
// printing every character that is FINE is what buries the two that are not. The line the peer
// session wanted at 01:00 and did not get was the count plus the names that failed it. So: at most
// `maxRows` exceptions per entry, the rest behind `all`.
const DEFAULT_MAX_ROWS = 4;

export function formatPreflight(rows, { agents = [], all = false, checkpoints = 0,
                                        maxRows = DEFAULT_MAX_ROWS } = {}) {
  // A PAD WHOSE RISK IS GEOMETRIC HAS NOTHING TO PUT IN `requires`, AND SAYING "no requirements"
  // READS LIKE IT FORGOT. Reported by the Marco Polo session, 2026-09-12: a rail-following pad
  // declares nothing about what a character KNOWS, because the thing that can go wrong is the
  // ground. Its checkpoint's `holds` is doing that job, and the render should say so.
  if (!rows.length)
    return checkpoints
      ? `  no ability requirements — ${checkpoints} checkpoint(s) will be asked at run time, ` +
        `which is where this pad's risk actually is (${agents.length} agent(s))`
      : `  this pad declares no requirements and no checkpoints — nothing will be checked before ` +
        `it runs (${agents.length} agent(s))`;
  const mark = { met: 'ok  ', unmet: 'NO  ', unknown: '?   ' };
  const out = [];
  const byTier = t => rows.filter(r => r.tier === t);
  for (const [tier, label] of [['requires', 'REQUIRED — unmet refuses before anything walks'],
                               ['capabilities', 'capability — the pad routes around its absence'],
                               ['suggests', 'suggested — advice, with the mechanism']]) {
    const tierRows = byTier(tier);
    if (!tierRows.length) continue;
    out.push(`  ${label}`);
    for (const what of [...new Set(tierRows.map(r => r.what))]) {
      const mine = tierRows.filter(r => r.what === what);
      const n = v => mine.filter(r => r.verdict === v).length;
      // A fleet-scoped entry is ONE fact, so it says so rather than "1 of 1", which reads as a
      // roster with one character in it.
      out.push(mine.length === 1 && mine[0].scope === 'fleet'
        ? `    ${what}  —  ${mine[0].verdict.toUpperCase()} for the fleet`
        : `    ${what}  —  ${n('met')} met, ${n('unmet')} unmet, ${n('unknown')} unknown` +
          ` of ${mine.length}`);
      const why = mine.find(r => r.whyDeclared)?.whyDeclared;
      if (why) out.push(`      why: ${why}`);
      const bad = mine.filter(r => r.verdict !== 'met');
      const shown = all ? bad : bad.slice(0, maxRows);
      for (const r of shown)
        out.push(`      ${mark[r.verdict]}${r.scope === 'fleet' ? 'THE FLEET' : r.agent}` +
                 `${r.character ? ` (${r.character})` : ''}` +
                 `${r.why ? ` — ${r.why}` : ''}`);
      if (bad.length > shown.length)
        out.push(`      ... and ${bad.length - shown.length} more like it — add all=1 for every row`);
    }
  }
  const refused = rows.filter(r => r.refuse);
  out.push('');
  out.push(refused.length
    ? `  ${refused.length} REFUSAL(S): ` +
      [...new Set(refused.map(r => r.agent))].join(', ') + ' cannot run this.'
    : '  nothing here refuses this errand.');
  const unknownRows = rows.filter(r => r.verdict === 'unknown');
  if (unknownRows.length) {
    out.push(`  ${unknownRows.length} check(s) could not be answered. Unknown is not permission; ` +
             `it is also not a refusal.`);
    // NAME THE FIX ONLY WHERE IT IS THE FIX. Telling a reader to refresh ability books for an
    // unknown that has nothing to do with abilities is the misattribution above, relocated into
    // the summary, where it reads as the tool's considered advice.
    const byCause = (c) => unknownRows.filter(r => r.cause === c).length;
    const advice = [];
    if (byCause('no-book'))
      advice.push(`${byCause('no-book')} want an ability book — run m59-abilities.mjs`);
    if (byCause('no-roster'))
      advice.push(`${byCause('no-roster')} name a handle that is not in this fleet's roster`);
    if (byCause('needs-live'))
      advice.push(`${byCause('needs-live')} read something no cache on disk holds — these need ` +
                  `a live read, and no refresh will help`);
    if (byCause('check-threw'))
      advice.push(`${byCause('check-threw')} threw — that is a bug in the pad, not a fact ` +
                  `about the fleet`);
    if (byCause('broken'))
      advice.push(`${byCause('broken')} were made unanswerable by another declaration`);
    // A CHECK THAT CAN ONLY BE ANSWERED IN CONTACT IS NOT A FIFTH TIER. The peer session asked
    // whether "swing once and read the sentence" needed a new concept, because it cannot run until
    // the fleet is already in the boss's room -- after the checkpoint that would gate entry.
    // It does not: it is an unknown with a cause, which the three verdicts already carry. What is
    // new is only that the summary can say these WILL resolve rather than leaving a reader to
    // wonder whether to chase them.
    if (byCause('needs-contact'))
      advice.push(`${byCause('needs-contact')} can only be answered in contact — they resolve ` +
                  `during the errand, and chasing them beforehand is wasted effort`);
    for (const a of advice) out.push(`    ${a}`);
  }
  return out.join('\n');
}

// ------------------------------------------------------------ where `act` looks like it worked
//
// `act(tool, args)` IS THE ONLY GENERAL HATCH A PAD HAS, AND IT IS THE ONE STEP WITH NO
// SAFETIES OF ITS OWN. Every other step kind has an executor in the compiler that knows what
// its layer does wrong; `act` forwards the call and scores the reply. So the reply is the
// outcome, which is the oldest thing this repository knows to be false.
//
// Shaped like KNOWN_TRAPS and for the same reason: these are learned by losing a run, no
// amount of reasoning about the code finds them, and the only way they stop costing us is
// being written where the tool reads them rather than where somebody has to remember them.
//
// A WARNING HERE, NOT A GUARANTEE IN THE COMPILER. The entry criterion for UNSAFE_GUARANTEES is
// a mistake somebody made TWICE; each of these has been made once, by one session, on one
// night. When one of them recurs it graduates into m59-fleetscript.mjs and refuses rather than
// warns. Until then a pad author gets told, and the telling is cheap.
//
// THIS IS ADVICE ABOUT A VERB, NOT ABOUT A CHARACTER -- deliberately, though not for the reason
// first given here.
//
// WHAT WAS WRITTEN HERE AND WAS WRONG, corrected 2026-09-11: "there is NO offline signal for
// keeper-backed: substrate/keeper-*.json is named by keeper LABEL, not by agent handle, and 0 of
// this roster's 37 handles has a matching file." That came from reading the wrong roster file.
// Against the one stateFileFor() actually resolves -- substrate/fleets/prod.json -- **21 of 22
// handles have a matching substrate/keeper-<handle>.json**. The signal exists.
//
// The decision stands, on the argument that should have been given first: the file says a keeper was
// CONFIGURED for that handle, not that one is holding the body right now, and the hazard is a
// property of the broker tool either way. A warning that fires on the verb cannot be wrong about
// which characters are keeper-backed, because it does not claim to know -- and that is worth more
// than a precise warning that guesses quietly from a file's presence. If a live "is a keeper holding
// this body" read ever lands, narrowing these to it is an improvement; inferring it from a filename
// is not.
export const ACT_HAZARDS = Object.freeze({
  fight: {
    what: 'returns ok, returns a combat transcript, and may have done nothing at all',
    why: 'The broker tool is `skills.fight(session(agent))` (m59-broker.mjs:9643), so the fight ' +
         "runs against the BROKER's session object -- and since the fleet moved to the " +
         'keeper-process driver the World lives in the KEEPER and the broker holds a snapshot. ' +
         'The swing then cannot find its own object id in a room map nobody refreshed and ' +
         'returns `stale_identity` (m59-skills.mjs:2429,2484), which m59-autopilot.mjs:17772 and ' +
         'm59-bt-farm.mjs:696 both handle and a bare `act` does not.',
    measured: 'Peer session "Test server shadow fleet control", 2026-09-11: 17 raiders each ' +
              'chose the target, faced it, swung once, returned stale_identity and stopped. All ' +
              "17 reported the action phase COMPLETE. The ghost of Far'Nohl finished on 233 of " +
              "233 health. `look` showed every raider in the room the whole time.",
    instead: "Swing through the keeper's own path -- m59-keeper-process.mjs:1861 serves " +
             '`fight` inside the keeper, which is what m59-simulate.mjs uses and what was ' +
             'measured working against the queen spider.',
  },
  walk_to: {
    what: 'gets none of the cancel-before-send that the `walk` step has',
    why: "compiledWalk cancels the keeper's journey before EVERY send and races an `is busy` " +
         'refusal twice (m59-fleetscript.mjs:1530-1560). `act` does none of that, and it also ' +
         "passes its own 120s timeout against the broker's 60s cap on its RPC to the keeper.",
    measured: 'm59-fleetscript.mjs, 2026-09-10 06:18:57Z: Marco Polo walked across room 587 ' +
              "with act('walk_to'), the broker's 60s cap fired while the keeper was still " +
              'walking, `act` scored it a step failure, the script unwound and handed the lease ' +
              'back in the middle of the Twisted Wood at 12 of 20 health.',
    instead: 'Use the `walkTo` step, which is the same move with the arrival read back.',
  },
});

// ------------------------------------------------------- has somebody already answered this?
//
// KNOWLEDGE THAT LIVES SOMEWHERE AN AGENT DOES NOT THINK TO LOOK GETS REDISCOVERED AT FULL PRICE.
//
// The m59-research corpus had the Ghost of Far'Nohl's resistance table, pinned and citation-checked,
// from 2026-09-04. On 2026-09-10 a peer session spent a night deriving it from kod -- not because
// the corpus was wrong or hard to search, but because they did not know it existed as a thing to
// look in. They told us so afterwards, and called it the strongest argument for pads they had seen,
// "and it is mine rather than theoretical".
//
// So `check` asks, from whatever a pad declares it is about:
//
//   consults: ["ghost of far'nohl", 'enchant weapon']
//
// That turns the corpus's own first rule -- "Search first, always" -- from a thing an agent has to
// remember into a thing the tool does. It is the cheapest feature in this file and the one with a
// measured value: one night.
//
// NO DEFAULT PATH. M59_RESEARCH_DIR or nothing, because a committed tool that hardcodes one
// machine's checkout is the thing this repository separates tools from orders to avoid. Unset, the
// lookup is skipped with one line saying how to turn it on -- never an error, because a pad must
// work on a machine that has no corpus at all.
export const RESEARCH_DIR = process.env.M59_RESEARCH_DIR || null;

// THE COVERAGE RULE IS THE CORPUS'S OWN, AND IT IS NOT THE SCORE. Measured there: true hits land at
// 59-99 with ALL query terms covered, and a question the corpus does not cover scored 34 with 1 of
// 3 terms. One shared word with a big report inflates the score, so partial coverage is a miss no
// matter how high it ranks. Surfacing a false hit is worse than surfacing nothing: it sends a reader
// to a report that does not answer them and teaches them the lookup lies.
const COVERAGE_FLOOR = 0.8;
const SCORE_FLOOR = 40;

/** Parse `m59.py find` output into rows. Exported for the test, which must not need a corpus. */
export function parseFindOutput(text) {
  const rows = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(\d+)\s+(\d+)\/(\d+)\s+terms?\s+(\S+)\s*$/);
    if (!m) continue;
    const [, score, covered, total, file] = m;
    rows.push({ score: Number(score), covered: Number(covered), total: Number(total), file,
                title: (lines[i + 1] ?? '').trim(),
                stale: /STALE/i.test(lines[i]) });
  }
  return rows;
}

/** Which of those rows the corpus's own coverage rule calls a hit. */
export const hitsAmong = (rows) => rows.filter(
  r => r.total > 0 && r.covered / r.total >= COVERAGE_FLOOR && r.score > SCORE_FLOOR);

/**
 * Ask the corpus about everything a pad says it is about.
 *
 * `run` is injected so the test does not need a corpus, the same reason runNamed takes fleetScript.
 * Returns one entry per consulted term; `hits` may be empty and `why` says why when it could not ask.
 */
export function consultCorpus(pad, { dir = RESEARCH_DIR, run = null } = {}) {
  const terms = [].concat(pad?.consults ?? []).map(t => String(t).trim()).filter(Boolean);
  if (!terms.length) return { asked: false, why: 'this pad declares no `consults`', rows: [] };
  if (!run && !dir)
    return { asked: false, rows: [],
             why: 'M59_RESEARCH_DIR is not set, so the corpus was not asked. Point it at an ' +
                  'm59-research checkout and `check` will say whether somebody has already ' +
                  'written this down.' };
  if (!run && !existsSync(dir))
    return { asked: false, rows: [], why: `M59_RESEARCH_DIR is set to ${dir}, which does not exist` };

  const ask = run ?? ((term) => execFileSync('python', ['bin/m59.py', 'find', term],
                                             { cwd: dir, encoding: 'utf8',
                                               stdio: ['ignore', 'pipe', 'ignore'] }));
  const rows = [];
  for (const term of terms) {
    let out = '';
    try { out = ask(term); }
    catch (e) { rows.push({ term, failed: e.message, hits: [] }); continue; }
    rows.push({ term, hits: hitsAmong(parseFindOutput(out)) });
  }
  return { asked: true, why: null, rows };
}

export function formatConsults(result) {
  if (!result.asked) return result.why ? `  corpus: ${result.why}` : '';
  const withHits = result.rows.filter(r => r.hits.length);
  if (!withHits.length)
    return `  corpus: nothing written down about ${result.rows.map(r => `"${r.term}"`).join(', ')}` +
           ` — you are the first, so file what you learn`;
  const out = ['  THE CORPUS ALREADY HAS SOMETHING ABOUT THIS — read it before deriving it again:'];
  for (const r of withHits) {
    out.push(`    "${r.term}"`);
    for (const h of r.hits)
      out.push(`      ${h.file}${h.stale ? '  [STALE]' : ''}  (${h.score}, ${h.covered}/${h.total} terms)` +
               (h.title ? `\n        ${h.title}` : ''));
  }
  // A TERM THAT FOUND NOTHING IS STILL A RESULT. Listing only the hits would leave a reader unsure
  // whether the other terms were asked or quietly dropped -- the same absence-of-evidence mistake
  // the three-valued verdict exists to avoid, one layer out.
  const misses = result.rows.filter(r => !r.failed && !r.hits.length);
  if (misses.length)
    out.push(`    nothing for ${misses.map(r => `"${r.term}"`).join(', ')} — ` +
             `you are the first, so file what you learn`);
  const failed = result.rows.filter(r => r.failed);
  for (const f of failed) out.push(`    "${f.term}" could not be asked: ${f.failed}`);
  return out.join('\n');
}

/** Every hazard a compiled step list walks into. Static: no world read, no broker. */
export function actHazards(steps = []) {
  const hits = [];
  for (const [i, step] of [].concat(steps ?? []).entries()) {
    if (step?.do !== 'act') continue;
    const h = ACT_HAZARDS[step.tool];
    if (h) hits.push({ index: i, tool: step.tool, ...h });
  }
  return hits;
}

export function formatActHazards(hits) {
  if (!hits.length) return '';
  const out = [`  ${hits.length} act() step(s) with a known hazard:`];
  for (const h of hits) {
    out.push(`    step ${h.index}  act('${h.tool}') — ${h.what}`);
    out.push(`      why:      ${h.why}`);
    out.push(`      measured: ${h.measured}`);
    out.push(`      instead:  ${h.instead}`);
  }
  out.push('  These WARN rather than refuse: each has happened once. A second time and it ' +
           'belongs in UNSAFE_GUARANTEES.');
  return out.join('\n');
}

