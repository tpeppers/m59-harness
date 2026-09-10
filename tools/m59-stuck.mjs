#!/usr/bin/env node
// HELP, I'M STUCK — the recurring travel questions, the answer, and WHETHER IT IS FIXED YET.
//
//   node tools/m59-stuck.mjs                          every entry, worst-tallied first
//   node tools/m59-stuck.mjs ukgoth                   the entry, and record that it was needed
//   node tools/m59-stuck.mjs --room 599               by room
//   node tools/m59-stuck.mjs --tally                  what the fleet keeps asking, and the cost
//   node tools/m59-stuck.mjs --no-count <query>       look without adding to the tally
//
// WHY THIS EXISTS, in the operator's words, 2026-09-10:
//
//   "there are recurring travel themes like this where I keep answering the same questions. Why
//    shouldn't this be fixed in code (fleetscript or the rail being top priority for all travel,
//    etc.?) or something?.. It's frustrating for me to answer the same questions more than 5+
//    times, because I get the sense nothing's being done to actually fix the problem, which is,
//    again, our primary purpose in dealing with this repository at all."
//
// THIS FILE IS NOT THE FIX AND MUST NOT BECOME A PLACE TO PUT ANSWERS INSTEAD OF FIXES.
//
// That is the whole risk of writing it. A guide is cheaper than a fix, so a guide will get
// written every time and the fix never will, and the guide will look like progress. So every
// entry carries a `fix` field naming the code change that would make the entry unnecessary, and
// a `state`:
//
//   fixed     the code now handles it. The entry stays as the explanation of a past failure.
//   open      nobody has done it. The entry is a WORKAROUND and says so.
//   partial   the common case is handled and a named case is not.
//
// And it TALLIES. Every lookup appends a line to substrate/stuck-tally.jsonl, so
// `--tally` answers the question the operator actually asked -- which of these is still costing
// us, and how often -- with a number rather than a feeling. An entry that is `open` and heavily
// tallied is the next thing to build. An entry that is `fixed` and still being looked up means
// the fix did not reach the place people look.
//
// THE TWO-STEP THE OPERATOR NAMED, and where the step boundary actually falls:
//
//   Step 1: get the right answer at all -- once, for one character, by hand.
//   Step 2: operationalise it so no LLM and no bot ever has to ask again.
//
// His own struggle with step 2 is the useful part: "I want these gutters to be the robustness,
// but I'm just not seeing it. How do we make these bots actually retry the loop if they miss the
// jump in ukgoth?" The answer, measured tonight, is that the gutters ALREADY are the robustness
// and the harness was refusing to let them work. See the `ukgoth-gutters` entry.
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const TALLY = join(REPO, 'substrate', 'stuck-tally.jsonl');

// Each entry is one question that has been asked more than once. `symptom` is what the asker can
// see -- never what is actually wrong, because if they knew that they would not be asking.
export const ENTRIES = Object.freeze([
  {
    id: 'ukgoth-gutters',
    rooms: [599],
    asked: 5,                       // operator: "more than 5+ times"
    symptom: 'A character sits in Ukgoth (599) around r48c21 or r48c27 and never reaches ' +
             'Outside Castle Victoria (2). It may shuffle a square or two. Nothing errors.',
    answer:
      'It fell into the GUTTERS below the Ukgoth run, and from down there the north door at ' +
      'r1c27 cannot be walked to at all. The only way on is the south exit at r71c2 into 589, ' +
      'and then the whole loop back round: 589 -> 579 -> 578 -> 576 -> 587 -> 597 -> 598, ' +
      're-entering 599 from the east at r4c63, from which the east door r1c66 CAN be reached ' +
      'and a declared fall three columns west lands on the north door. Missing that fall drops ' +
      'you in the gutters again, which is the retry: go round once more.',
    measured:
      'Asked the keeper of a character standing in the gutters for a route to 2 on 2026-09-10. ' +
      'It answered those nine hops unprompted. The router is already right, and right ' +
      'POSITIONALLY -- it declines the north door three rows above the body.',
    fix: 'fleetScript stopped refusing it. `trapCheck` refused any errand begun in a KNOWN_TRAP ' +
         'and `routeCrossesTrap` refused any route through one -- and the only road to Castle ' +
         'Victoria goes through 599, so the check grounded the destination the hour it began ' +
         'working. Transit is now advisory and standing in a trap is not a refusal at all.',
    state: 'fixed',
    since: '2026-09-10',
    // The thing that makes the gutter self-clearing is that nothing has to notice. There is no
    // detector, no retry counter and no special case: the router plans out of the hole because
    // it plans positionally, and the walker now lets it.
    robustness:
      'THE GUTTER IS THE RETRY. It costs one lap and needs no code: fall in, the next route ' +
      'request is answered with the way round, walk it, arrive at the east side, try the fall ' +
      'again. What was missing was not a retry mechanism but permission.',
  },
  {
    id: 'trap-room-refusal',
    rooms: [599, 49],
    asked: 2,
    symptom: 'An errand refuses instantly with "is standing in room N ... Get it out first; an ' +
             'errand started from here will not finish", and no body moves.',
    answer: 'That refusal is gone. It was addressed to an operator, which is nobody at 01:00.',
    measured: 'Its first live run refused eight of twenty-one characters in about one second ' +
              '(four standing in 599, four whose route crossed it) during a guild gather.',
    fix: 'trapCheck returns null for `standingIn`; the router plans the way out.',
    state: 'fixed',
    since: '2026-09-10',
    robustness: 'A guarantee that can only be satisfied by a human is not a guarantee, it is a ' +
                'pause. If a check cannot say what the MACHINE should do next, it should log ' +
                'rather than refuse.',
  },
  {
    id: 'walk-to-plans',
    rooms: [39],
    asked: 3,
    symptom: 'walk_to inside one room sends the body the wrong way -- one step east from r13c40 ' +
             'arrives at r4c27, nineteen squares out -- and it looks like a teleport.',
    answer: '`walk_to` PLANS, and its planner believes the coarse grid, which claims steps the ' +
            'live mover refuses. It routes a one-square step as a forty-square loop. Use ' +
            '`short_hop`, which moves the body and does not plan, and ask /movecheck first.',
    measured: 'Room 39, 2026-09-10 (session m59-harness-99): connection_revision stayed 1 all ' +
              'night, so nothing logged off and nothing teleported. moverStepLands claims ' +
              'c34->c35 on rows 2-9 while validateFineTarget refuses it. Row 9 crosses; rows 3, ' +
              '6, 10, 11, 12 do not.',
    fix: 'NOT DONE. The tolerance bug in walk_to was fixed (2de4001) but the phantom ground its ' +
         'planner walks across was not. The planner should consult the same predicate the mover ' +
         'enforces -- `moverStepLands`, not the coarse grid -- which is the rule docs/m59-routing.md ' +
         'already states and this path does not follow.',
    state: 'open',
    robustness: 'Until then the workaround is per-errand and will be forgotten, which is exactly ' +
                'the shape of problem this file is supposed to make visible rather than absorb.',
  },
  {
    id: 'keeper-addressing',
    rooms: [],
    asked: 3,
    symptom: 'A keeper answers `{"error":"this keeper is \\"t9\\", not \\"t9\\""}` -- an error ' +
             'saying t9 is not t9 -- or `not "undefined"`, or a route comes back "to NaN".',
    answer: 'The identity tuple goes at the TOP level and the arguments go NESTED under `args`: ' +
            '{name, agent, character, keeper_pid, args:{...}}. `addressedToUs` needs all three ' +
            'of agent, character and pid; get them from GET /live on the keeper port.',
    measured: '2026-09-10, reproduced four ways while asking for one route. The message prints ' +
              'the field that MATCHED and never the one that mismatched, which is why "t9 is not ' +
              't9" is possible; and args at the top level are silently dropped, so `to: 2` was ' +
              'read as NaN and reported as a routing failure.',
    fix: 'NOT DONE. The refusal should name the field that actually mismatched, and an unknown ' +
         'top-level key that is a known ARGUMENT name should be refused loudly rather than ' +
         'dropped. This is the same class as routeTrapAhead sending `agent: undefined` for ' +
         'weeks: an addressing failure that presents as a domain failure.',
    state: 'open',
    robustness: 'm59-keeperaddress-test.mjs lints the call sites in this repository, so OUR calls ' +
                'are addressed. It cannot help a human or an LLM at a curl prompt, which is ' +
                'where all three of these were lost.',
  },
  {
    id: 'wedged-traveller-dies-awake',
    rooms: [599, 39, 578, 598],
    asked: 3,
    symptom: 'A character dies somewhere dangerous having apparently just SAT THERE. It did not ' +
             'move, did not fight back, and its keeper looks perfectly healthy. Operator: ' +
             "both of them just kinda sat there and died... didn't really move or fight back -- not that fighting back would've helped, but it would've shown a sign that it's not a fall-through (broken, logged out, etc.)",
    answer:
      'It is NOT a fall-through -- check `during_keeper_outage` in the postmortem, which will be ' +
      'null, and the frames, which keep arriving to the end. It is a WEDGED JOURNEY: `doing: ' +
      '"travelling"` with `ms_since_moved` in the hundreds of thousands. A journey deliberately ' +
      'suppresses work, so the body will not swing (`swung_ms: null`) -- that is the absence of ' +
      'fight-back, and it is by design, not a symptom of breakage. The survival ladder stays ' +
      'armed but needs a proven safe wall to play dead, and `at_a_safe_wall: null` in these ' +
      'rooms means it has nothing to reach for.',
    measured:
      'Rizzo and Camilla, room 599, 2026-09-10, 83 seconds apart, both to trolls, both at r50-51 ' +
      'in the gutters with 15 threats. Camilla: `ms_since_moved: 2029414` -- THIRTY-FOUR MINUTES ' +
      'on one square -- health 20 -> 15 -> 16 -> 11 -> 7 -> 3, and no rescue and no note ever ' +
      'fired. Rizzo WAS rescued at `was_inert_for_s: 74` because something still held his ' +
      'movement. Same room, same trolls, same code.',
    fix: 'BOTH CAUSES FIXED 2026-09-10. (1) `taking_hits` was `last.health < prev.health` -- one ' +
         'adjacent pair -- so the 15 -> 16 regen tick read as "not being attacked" and the rescue ' +
         'gated on it never fired; it is now the trend across the wedge episode. (2) The rescue ' +
         'AND the note both required `wedge.inert`, which is set only when the keeper stood ' +
         'itself down or another driver holds movement -- so an ordinary self-driven journey ' +
         'could never qualify. Dropped from both gates; the marker is still recorded as evidence.',
    state: 'partial',
    since: '2026-09-10',
    robustness:
      'STILL OPEN, and named so it is not forgotten: a wedged traveller being eaten does not ' +
      'SWING. The journey suppresses work ("it will not hunt, roam, shop or pick a room while ' +
      'the journey owns the" body) while CLAUDE.md says a hurt body that cannot move swings ' +
      'instead. Those two are in tension and nobody has resolved it. Fighting six trolls would ' +
      'not have saved either character -- but it is the difference between a decision and a ' +
      'fall-through, which is exactly what the operator could not tell from the outside.',
  },
  {
    id: 'castle-victoria-only-road',
    rooms: [2, 38, 39, 599],
    asked: 2,
    symptom: '"No route to Castle Victoria", or every journey there refuses, or a fragile ' +
             'character keeps dying on the way.',
    answer: 'The ONLY road to Castle Victoria runs through Ukgoth (599), a room with six trolls. ' +
            'That is not a routing defect and there is no way round it. A 20-max-health ' +
            'character should not be sent; a 60-health fighter crosses it daily.',
    measured: 'The router plans 382 -> ... -> 598 -> 599 -> 2 -> 38 -> 39. Loial the Ogier ' +
              '(20 max health) died there on 2026-09-09.',
    fix: 'PARTIAL. Transit is no longer refused, which was the wrong fix for the death. The ' +
         'right one is a per-character danger gate: the router already reports ' +
         '`blocked_by_hazard` (it volunteered 555, the Forest Shrine, unasked), so 599 belongs ' +
         'in that list for characters under a max-health floor rather than being refused for ' +
         'everyone.',
    state: 'partial',
    robustness: 'The health floor on every journey is the only protection a fragile character ' +
                'currently has, and it checks whether you set out whole -- not whether the road ' +
                'can kill you before it ends.',
  },
]);

const load = () => {
  try {
    return readFileSync(TALLY, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};

// THE TALLY IS APPEND-ONLY AND IT IS THIS MACHINE'S. A count of how often our own fleet got
// stuck is an observation about this fleet, not a fact about the game, so it lives beside the
// other runtime state under substrate/ and is not committed.
const record = (id, query) => {
  try {
    mkdirSync(dirname(TALLY), { recursive: true });
    appendFileSync(TALLY, JSON.stringify({ at: new Date().toISOString(), id, query }) + '\n');
  } catch { /* a tally that cannot be written must not break the answer */ }
};

const show = (e, counted) => {
  const badge = { fixed: 'FIXED', open: 'OPEN — WORKAROUND ONLY', partial: 'PARTIAL' }[e.state];
  console.log('');
  console.log(`  ${e.id}${e.rooms.length ? '   rooms ' + e.rooms.join(', ') : ''}`);
  console.log(`  ${'-'.repeat(Math.max(8, e.id.length))}`);
  console.log(`  LOOKS LIKE   ${e.symptom}`);
  console.log(`  IT IS        ${e.answer}`);
  console.log(`  MEASURED     ${e.measured}`);
  console.log(`  FIX [${badge}]${e.since ? ' since ' + e.since : ''}`);
  console.log(`               ${e.fix}`);
  if (e.robustness) console.log(`  ROBUSTNESS   ${e.robustness}`);
  if (counted != null) console.log(`  tallied      ${counted} lookup(s) on this machine` +
                                  `, operator says asked ~${e.asked}+ times`);
};

const args = process.argv.slice(2);
const noCount = args.includes('--no-count');
const roomIdx = args.indexOf('--room');
const room = roomIdx >= 0 ? Number(args[roomIdx + 1]) : null;
const q = args.filter(a => !a.startsWith('--') && a !== String(room)).join(' ').toLowerCase();

if (args.includes('--tally')) {
  const rows = load();
  const by = new Map();
  for (const r of rows) by.set(r.id, (by.get(r.id) ?? 0) + 1);
  console.log('');
  console.log('WHAT THE FLEET KEEPS GETTING STUCK ON — lookups recorded on this machine');
  console.log('');
  const ranked = ENTRIES.map(e => ({ e, n: by.get(e.id) ?? 0 }))
    .sort((a, b) => (b.n - a.n) || (b.e.asked - a.e.asked));
  for (const { e, n } of ranked)
    console.log(`  ${String(n).padStart(4)}  ${e.state.padEnd(8)}  ${e.id}` +
                `${e.state === 'open' ? '   <- costing us, and not fixed' : ''}`);
  console.log('');
  console.log(`  ${rows.length} lookup(s) total in substrate/stuck-tally.jsonl`);
  // THE POINT OF THE NUMBER. An open entry with a high count is the next thing to build; a
  // fixed entry with a high count means the fix did not reach where people look.
  const worst = ranked.find(r => r.e.state !== 'fixed');
  if (worst) console.log(`  next thing to actually FIX: ${worst.e.id} — ${worst.e.fix.slice(0, 90)}...`);
  process.exit(0);
}

const hits = ENTRIES.filter(e =>
  (room != null && e.rooms.includes(room)) ||
  (q && (e.id.includes(q) || e.symptom.toLowerCase().includes(q) ||
         e.answer.toLowerCase().includes(q))));

if (!q && room == null) {
  const rows = load();
  const by = new Map();
  for (const r of rows) by.set(r.id, (by.get(r.id) ?? 0) + 1);
  console.log('');
  console.log("HELP, I'M STUCK — recurring travel failures, what they really are, and whether");
  console.log('the code has been fixed so nobody has to ask again.');
  for (const e of [...ENTRIES].sort((a, b) => (by.get(b.id) ?? 0) - (by.get(a.id) ?? 0)))
    show(e, by.get(e.id) ?? 0);
  console.log('');
  console.log('  node tools/m59-stuck.mjs <word|--room N>   one entry, and tally it');
  console.log('  node tools/m59-stuck.mjs --tally           what is still costing us');
  console.log('');
  process.exit(0);
}

if (!hits.length) {
  console.log('');
  console.log(`nothing here matches ${JSON.stringify(q || room)}.`);
  console.log('');
  console.log('THAT IS WORTH RECORDING RATHER THAN SHRUGGING AT. If you are stuck on something');
  console.log('this file does not cover, and you work out the answer, add the entry -- with the');
  console.log('MEASUREMENT that settled it and the code change that would make it unnecessary.');
  console.log('An entry with no `fix` field is not finished; the fix is the deliverable and the');
  console.log('entry is the receipt.');
  console.log('');
  record('unmatched', q || `room ${room}`);
  process.exit(1);
}

for (const e of hits) {
  if (!noCount) record(e.id, q || `room ${room}`);
  show(e, null);
}
console.log('');
