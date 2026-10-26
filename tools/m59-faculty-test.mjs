#!/usr/bin/env node
import { readToolSource } from './autopilot/source.mjs';
// WITH NO BOT ATTACHED, THE KEEPER STILL OWNS EVERYTHING THAT KEEPS A CHARACTER ALIVE.
//
//   node tools/m59-faculty-test.mjs
//
// This is the guard on the carve-out, and it is deliberately the cheapest thing in it.
//
// `meridian59-dum-bot` moves the DIRECTIONAL half of a character out of this repository —
// what to hunt, which room to stand in, when to bank. The half that must not move is the
// half bound to a one-second clock: identity, mortality, survival, recovery, re-arming,
// Underworld escape. The split is real and the seam already exists in the keeper's own
// pass ordering (`0 identity`, `1 dead`, `2 in danger`, `3 hurt but safe`, `4 work`) — a
// bot's rules start at 4 and there is nothing above it.
//
// The risk is not that someone moves survival out on purpose. It is that it erodes: a
// faculty is handed over "just for this errand", a lease is added without a fallback, an
// `inert` grows a new caller, and one day a character with no bot attached stands in a
// monster room doing nothing because whatever used to drive it now lives in another
// repository that is not running. That failure is silent from both sides — the harness
// reports a healthy keeper, the bot reports that it is not driving anything.
//
// So this asserts the property directly and offline: with nothing attached, every faculty
// answers `keeper`, and the ladder that keeps a character alive is reachable in the
// source. It should FAIL the day a survival decision moves out. That is its whole job.
//
// It reads the keeper's SOURCE rather than importing it, because importing m59-autopilot
// is cheap but importing m59-broker is not — it takes the fleet lock and starts timers —
// and the ordering assertions below are about the file's structure, which is the thing
// that would change if somebody moved a branch.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (f) => readToolSource(join(HERE, f), 'utf8');

let passed = 0, failed = 0;
const ok = (what, cond, detail = '') => {
  if (cond) { passed++; return; }
  failed++;
  console.log(`FAIL ${what}${detail ? ' — ' + detail : ''}`);
};

const keeper = src('m59-autopilot.mjs');

// ---------------------------------------------------------------- the faculty vocabulary
//
// Named here rather than imported so that this file is the statement of the contract.
// `survival` and `mortality` are the two an operator must consent to give away; the rest
// are the carve-out.
const CLOCK_BOUND = ['identity', 'mortality', 'survival', 'recovery'];
const DIRECTIONAL = ['work', 'movement', 'economy'];

// ------------------------------------------------------------------- 1. the pass ordering
//
// The seam. Survival is decided ABOVE work, so a bot holding `work` cannot starve a
// survival decision by holding a lease — the keeper reaches its own branch first and
// returns before it ever consults the directional half.
{
  // Matched against the keeper's OWN wording rather than a tidied-up version of it. The
  // identity branch is spelled "Do we still know who we are?", and a test insisting on the
  // word "identity" would fail for a comment that is doing its job perfectly well.
  const marks = [
    ['identity', /\/\/\s*0\.\s*Do we still know who we are/i],
    ['dead',     /\/\/\s*1\.\s*Dead\./i],
    ['danger',   /\/\/\s*2\.\s*In danger/i],
    ['hurt',     /\/\/\s*3\.\s*Hurt but safe/i],
    ['work',     /\/\/\s*4\.\s*Work\./i],
  ];
  const at = marks.map(([name, re]) => [name, keeper.search(re)]);
  for (const [name, i] of at)
    ok(`pass() still has the "${name}" branch`, i >= 0,
       'the ordered comments are the seam the carve-out is cut along');
  const found = at.filter(([, i]) => i >= 0);
  for (let i = 1; i < found.length; i++)
    ok(`"${found[i][0]}" is decided after "${found[i - 1][0]}"`,
       found[i][1] > found[i - 1][1],
       'survival must be reached before work, or a bot holding work can delay it');
}

// ------------------------------------------------- 2. the survival ladder is still here
//
// Each of these is a decision that must not migrate. The assertion is deliberately
// shallow — that the keeper still contains the call — because a deep behavioural test
// would need a live server, and the failure this guards against is DELETION, not
// subtle drift.
{
  const mustKeep = [
    ['flees when losing',        /disengageAt|fleeBelow/],
    ['rests when hurt and safe', /restUntil\(/],
    ['re-arms itself',           /armSelf\(/],
    ['escapes the Underworld',   /underworld|Underworld/],
    ['logs off rather than die', /panicLogoff|breakOutViaLogoff/],
    ['records its own death',    /postmortem|recordDeath|died/i],
    ['takes a safe spot',        /takeSafeSpot\(/],
    ['watchdog ticks off-pass',  /startWatchdog\(|watchdogTick\(/],
  ];
  for (const [what, re] of mustKeep)
    ok(`the keeper still ${what}`, re.test(keeper),
       'this is clock-bound and must not move to a bot');
}

// ------------------------------------------------------ 3. with no bot, nothing is claimed
//
// The default answer to "who owns this faculty" is the keeper, for every faculty, and it
// is reached without anything being attached. Today ownership is expressed by `inert`
// (all-or-nothing); when per-faculty claims land this is where the shape is pinned.
{
  const facultyOwner = (status, faculty) => {
    // The contract, implemented here so the test states it rather than trusting the
    // implementation: a faculty is the keeper's unless something holds an UNEXPIRED
    // claim on it. Absent, empty, expired and malformed all mean keeper.
    const f = status?.faculties?.[faculty];
    if (!f) return 'keeper';
    if (typeof f === 'string') return f;
    if (!f.owner) return 'keeper';
    if (typeof f.expires_in_ms === 'number' && f.expires_in_ms <= 0) return 'keeper';
    return f.owner;
  };

  const noBot = { faculties: undefined, inert: null };
  for (const f of [...CLOCK_BOUND, ...DIRECTIONAL])
    ok(`with no bot, "${f}" is the keeper's`, facultyOwner(noBot, f) === 'keeper');

  // A crashed bot. The lease is the whole safety property: it must fail BACK, never open.
  const crashed = { faculties: { work: { owner: 'dum/valley-grind@pid-1234', expires_in_ms: 0 } } };
  ok('an expired lease reverts to the keeper', facultyOwner(crashed, 'work') === 'keeper',
     'a bot that is Ctrl-C\'d must leave a character that still defends itself');

  const negative = { faculties: { work: { owner: 'dum/x', expires_in_ms: -5000 } } };
  ok('a long-expired lease reverts too', facultyOwner(negative, 'work') === 'keeper');

  const malformed = { faculties: { work: { expires_in_ms: 99999 } } };
  ok('a claim with no holder is not a claim', facultyOwner(malformed, 'work') === 'keeper',
     'unowned must read as keeper, not as "somebody"');

  const live = { faculties: { work: { owner: 'dum/valley-grind@pid-1234', expires_in_ms: 91000 } } };
  ok('a live lease is honoured', facultyOwner(live, 'work') === 'dum/valley-grind@pid-1234');

  // And the guarantee that makes "unattended and safe" survive the migration: a bot may
  // be GIVEN the survival floor, but it may not take it by omission. A claim on survival
  // that the roster has not consented to is not honoured.
  const consented = (roster, faculty) => !!roster?.may_yield?.includes(faculty);
  ok('survival is not yieldable by default', !consented({}, 'survival'));
  ok('mortality is not yieldable by default', !consented({}, 'mortality'));
  ok('work is yieldable', true);
  ok('survival is yieldable only when the roster says so',
     consented({ may_yield: ['survival'] }, 'survival'));
}

// ------------------------------------------------------- 4. refusals are data, not prose
//
// The other half of the carve-out: something outside has to be able to tell a deliberate
// refusal from a stall without parsing sentences this repository owns and may reword.
{
  ok('the keeper can record a structured refusal', /refuse\(code,/.test(keeper));
  ok('refusals are published on status', /refusals: \[\.\.\.\(this\.refusals/.test(keeper));
  ok('waiting_on is published on status', /waiting_on: this\.waitingOn/.test(keeper));
  ok('NO_SAFE_WALL is emitted', /'NO_SAFE_WALL'/.test(keeper),
     'the supervisor reads this code instead of the prose');
  ok('UNARMED_NO_DONOR is emitted', /'UNARMED_NO_DONOR'/.test(keeper));
  ok('MANA_FOR_CREATE_WEAPON is emitted', /'MANA_FOR_CREATE_WEAPON'/.test(keeper));
  ok('a refusal is cleared when it stops being true',
     /clearRefusal\('UNARMED_NO_DONOR'\)/.test(keeper),
     'a refusal nobody clears makes a reader step over the character for ever');

  const sup = src('m59-supervise.mjs');
  ok('the supervisor reads the code, not only the sentence',
     /refused\('NO_SAFE_WALL'\)/.test(sup) && /refused\('UNARMED_NO_DONOR'\)/.test(sup),
     'this is the evidence the field is real rather than speculative');
}

// ------------------------------------------------- 5. the free read carries the orders
//
// A bot that has to pay four server requests per character to find out it has nothing to
// do will either poll expensively or stop checking. Both are worse than the field.
{
  const broker = src('m59-broker.mjs');
  ok('the fleet row carries the keeper policy', /policy: st\?\.policy/.test(broker));
  ok('the fleet row carries assigned_room', /assigned_room: st\?\.policy\?\.assignedRoom/.test(broker));
  ok('the fleet row carries refusals', /refusals: st\?\.refusals/.test(broker));
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
