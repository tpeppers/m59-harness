#!/usr/bin/env node
// THE OFFLINE SUITES A `#movement` COMMIT HAS TO CLEAR.
//
//   node tools/m59-movement-suite.mjs            run them all, report, exit non-zero on a REGRESSION
//   node tools/m59-movement-suite.mjs --list     what it runs and why, without running anything
//   node tools/m59-movement-suite.mjs --strict   treat the known-red baseline as failures too
//
// Every suite here is offline: no socket, no broker, no roster, no fleet. Together they take
// a couple of minutes, which is the whole argument for running them on every commit that
// carries `#movement` rather than hoping somebody remembers which one guards what.
//
// ======================= WHY A RUNNER AND NOT A LINE IN package.json =======================
//
// Because SOME OF THESE ARE ALREADY RED, and a runner that cannot say so is a runner people
// switch off in a week. `m59-travelling-test` has four failing assertions at origin/main that
// nobody introduced today; a plain `&&` chain stops at the first one and reports nothing about
// the eleven suites behind it.
//
// SO THE BASELINE IS BY NAME, NEVER BY COUNT. `KNOWN_RED` lists the exact assertion text of
// every failure that is already there. A new failure fails the run even if the TOTAL is
// unchanged — which is the trap this file exists to close, and one I walked into on
// 2026-09-18: I compared "84 passed, 2 failed" against a remembered "84 passed, 2 failed",
// concluded I had broken nothing, and had in fact swapped two of somebody else's failures for
// two of my own.
//
// AND IT REPORTS A BASELINE ENTRY THAT HAS STARTED PASSING. A known-red list nobody prunes
// becomes a list of things that are allowed to fail for ever, so a fixed one is printed as
// `FIXED` and the run tells you to delete the line. Same churn discipline as
// `UNSAFE_GUARANTEES` in m59-fleetscript.mjs: the absence of movement in the list is itself
// the finding.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {resolve} from 'node:path';

// The suites, worst-consequence first, each with the question it answers. A suite that does
// not touch movement does not belong here — `npm test` is the place for the rest.
const SUITES = [
  ['m59-survival-decision-test.mjs','real keeper recovery transitions, explicit protected handoffs, cancellation and replacement chains remain executable'],
  ['m59-active-recovery-state-test.mjs','actual keeper active logoff activation remains owned across native/public gates and interrupted-rest replacements'],
  ['m59-brax-boarding-lanes-test.mjs','separate landing columns overlap parking while shared alignment/flight and same-column clearance remain exclusive'],
  ['m59-brax-city-recovery-budget-test.mjs','known owned city recovery stays inside the original route deadline without an arbitrary three-minute cutoff'],
  ['m59-fineclimb-convoy-test.mjs','public cliff wrapper, CLI and native action retain the exact owner and shared cohort while malformed or foreign metadata refuses'],
  ['m59-brax-cliff-confirmation-test.mjs','a returned stopped cliff walk can follow its owned recovery or confirmed ready body, while stale child rows and ambiguous transports never resume'],
  ['m59-sentinel-exit-input-test.mjs','the exact NPC-blocked Sentinel input crosses from a nearby proved boundary stage without walking backward through its anchor'],
  ['m59-brax-south-queue-test.mjs','a reached south-ledge goal is recognized independently of lift readiness while nearby lower shelves remain refused'],
  ['m59-jump-ownership-test.mjs','actual native jump owns posture and step, public script issuer and yielded recovery semantics survive the handoff'],
  ['m59-vital-evidence-test.mjs','transient over-ceiling resources retain observed values without inventing an administrative cause'],
  ['m59-recovery-cast-posture-test.mjs','real paced recovery heals stand first and prequeued rest or running cannot fizzle the healing trance'],
  ['m59-error-evidence-test.mjs','movement transport errors retain bounded non-enumerable socket causes without serializing arbitrary request payloads'],
  ['m59-queued-exit-async-test.mjs','22 actual unreachable platform searches preserve controller heartbeats and exact terrain results off the event loop'],
  ['m59-fine-recovery-gate-test.mjs','actual fineclimb wrapper permits completed healthy recovery but still respects wounded recovery and protected trips'],
  ['m59-queued-coalesce-test.mjs','geometry-checked shortened castle approaches retain exact published GO cells and legal native packets'],
  ['m59-brax-coalesced-onward-test.mjs','shortened Sentinel and onward approaches retain captured monster collision and intended room crossings'],
  ['m59-recovery-cure-test.mjs','known source-costed poison cure retains current body/resource guards and distinguishes weakening from removal'],
  ['m59-active-self-heal-test.mjs','ordinary known self healing protects wounded road and reconnect bodies while preserving final-send ownership and one pending cast'],
  ['m59-native-doorway-queue-test.mjs','the actual packed sixteen-player doorway drains through native packets without walking the front backward through its follower'],
  ['m59-north-exit-recovery-test.mjs','fourteen actual north bodies with real file-backed incumbent claims drain after an ended head confirmation failure'],
  ['m59-west-opening-queue-test.mjs','the actual western spider-blocked opening queue selects a published clear adjacent opening and shares physical boundary admission'],
  ['m59-brax-native-onward-test.mjs','captured cavern monster bodies and the actual legal mountain component complete bounded native outbound exits'],
  ['m59-rail-coalesce-test.mjs','same-height stock-traced chords reduce native cliff packets while retaining exit avoidance and declared jump boundaries'],
  ['m59-farm-vigor-work-test.mjs','healthy farmers may reach the existing effective combat floor instead of a conflicting higher rest target'],
  ['m59-edge-return-queue-test.mjs','actual nine-body Graveyard jam crosses physical published tuples independently of coarse boarding anchors'],
  ['m59-go-alias-queue-test.mjs','actual six-body GO jam clears only through unlocked same-arrival aliases; other arrival branches stay exact'],
  ['m59-convoy-travel-gear-test.mjs','captured unarmed axe carrier equips own stock before shared staging, with recovery and client guards'],
  ['m59-convoy-provision-test.mjs','independent meals and one cached stock scan retain donor reserves and serialize actual trades'],
  ['m59-traffic-resume-test.mjs','only the same ended native body-only traffic operation can use the ordinary road reserve'],
  ['m59-traffic-resume-native-test.mjs','actual healthy low-vigor body-only suspended journeys resume without relaxing wounds, exhaustion or authority'],
  ['m59-death-location-test.mjs','fatal own-socket HP and personal death messages recover an observed room without guessing across offline gaps'],
  ['m59-rest-timing-test.mjs','ordinary health and mana ticks can take 60s without proving a stall; genuine ceilings, deadlines and damage still stop rest'],
  ['m59-queued-exit-recovery-test.mjs','only returned ended native failures can replan from a fresh owned body; ambiguous POSTs and foreign leases never retry'],
  ['m59-queued-body-egress-test.mjs','stationary skeletons and shared native bodies permit bounded ordinary detours to later checked bends without changing exact shelf queues'],
  ['m59-travel-pause-origin-test.mjs','actual keeper takeback captures the script issuer and guard before canceling an unarmed journey'],
  ['m59-return-cliff-queue-test.mjs','all17 captured real cliff bodies queue north with their actual IDs, flags and NPCs'],
  ['m59-victoria-cohort-queue-test.mjs','all24 actual Victoria poses cross castle GO queues and outside exit with real file-backed passage admission'],
  ['m59-queued-go-test.mjs','published castle GO exits reach valid activation cells without requiring blocked cell centers'],
  ['m59-brax-work-staging-test.mjs','corner operators pre-position on unchanged platform floor while lever activation retains strict puzzle readiness'],
  ['m59-castle-alignment-queue-test.mjs','actual offset corridor bodies advance clear prefixes past proved old aims under delayed peer snapshots'],
  ['m59-rail-input-evidence-test.mjs','durable consumed movement requests and observed scenes retain exact IDs without credentials, transport retries or stale-scene promotion'],
  ['m59-brax-member-failure-test.mjs','post-lift member failures remain individual without skipping solved or partial reset readiness'],
  ['m59-go-emission-test.mjs','native GO counts actual emission and fences pre-send cast feedback without retrying ambiguous writes'],
  ['m59-npc-takeoff-test.mjs','proved within-lane takeoff adjustments avoid known NPCs while player and actual-only flight blockers keep waiting'],
  ['m59-exit-candidate-budget-test.mjs','each bounded published exit candidate gets its terrain proof despite a slow unreachable nearer opening'],
  ['m59-queued-room-exit-test.mjs','published fine doorway crossings retain their actual cells even when a legacy coarse anchor names the adjacent square'],
  ['m59-session-evidence-test.mjs','reconnect and handoff combat evidence retains independent socket histories without cross-writer data loss'],
  ['m59-death-notices-test.mjs','fleet socket death witnesses retain authoritative causes through a victim disconnect while refusing ambiguous multiple-death gaps'],
  ['m59-recovery-heal-test.mjs','active recovery can cast known affordable heals without stale ally observations or stale movement authority'],
  ['m59-brax-entry-test.mjs','actual Temple arrivals complete the correct road entrance and clipped crowd arrivals join only through proved ordinary ground'],
  ['m59-queued-takeoff-test.mjs','twenty-five movers retain collision bodies through the legal north exit; an actual jam recovers with checked convoy admission'],
  ['m59-brax-staging-test.mjs','selected convoy bodies disperse through bounded collision-proved ordinary walks without controlling foreign bodies'],
  ['m59-moving-platform-masks-test.mjs','Ancient live floor updates use fingerprinted native masks without blocking or admitting unknown states'],
  ['m59-road-journey-test.mjs', 'owned road queues wait for actual body gaps and source health floors'],
  ['m59-fine-posture-test.mjs', 'fine movement stands after rest and preserves queued cancellation'],
  ['m59-rail-traffic-report-test.mjs','cached queue diagnosis identifies moving fronts, cycles, foreign blockers and geometry/reservation stalls without steering bodies'],
  ['m59-postmortem-ledger-test.mjs','ESM postmortems append durable death summaries as well as individual detailed records'],
  ['m59-rail-walk-test.mjs','native checked legs retain collision, posture, shelf and generation fences with local body queues'],
  ['m59-survival-yield-test.mjs','inactive survival intents remain yielded across movement claims; active recovery and explicit new danger stay protected'],
  ['m59-keeper-test.mjs','common keeper band scans share concurrent probes and refresh completed process identities'],
  ['m59-conditional-anchor-test.mjs','conditional edges retain compatible anchors and cross from the actual prepared eastern Brax exit without mixing branch coordinates'],
  ['m59-rail-action-http-test.mjs','native long actions use an explicit absolute HTTP budget and never repeat ambiguous writes'],
  ['m59-rail-observer-test.mjs','ordered rail own-body reads, keeper identity, refused writes and actual multi-leg shelf resumption'],
  ['m59-world-cached-exits-test.mjs', 'status reads use exact-origin cached exits without synchronous route planning'],
  ['m59-spotclaims-lock-test.mjs','Windows sharing races retry atomic acquisition without removing live owners or bypassing persistent permission errors'],
  ['m59-courier-purchases-test.mjs','courier maximum loads use live quotes, preserve one-attempt purchase evidence and reconcile delivered, lost and held acquisition value'],
  ['m59-recovery-pacer-test.mjs','active recovery stands and moves ahead of background reads without changing pacing, cancellation, combat authority or concentration'],
  ['m59-keeper-discovery-test.mjs','cached admission hints use verified keeper identities without gameplay reads; stale, duplicate and changed identities refuse'],
  ['m59-replay-provenance-test.mjs','executing movement provenance includes routing/guide content and dirty navigation data, without relabelling historical decisions'],
  ['m59-traversal-admission-test.mjs','shared map admission keeps queued travelers outside until a confirmed exit; stopped bodies and dead drivers cannot release it'],
  ['m59-recovery-preemption-test.mjs','keeper shelter invalidates an in-flight FleetScript walk before issuing its own packets and preserves the recovery decision'],
  ['m59-survival-switch-test.mjs','explicit operator stand-down preserves PvP/fallback and clears old autonomous recovery'],
  ['m59-combat-approach-test.mjs','blocked Cragged melee approaches rotate instead of grinding; bounded fine-region approaches and deviation/cancellation evidence preserve movement ownership and Bastion escape'],
  ['m59-entry-recovery-test.mjs','healthy body-blocked arrivals may retreat through a reversible entry and retry under the original deadline and cancellation'],
  ['m59-walk-avoidance-dispatch-test.mjs','forbidden squares survive MCP movement dispatch, proxy JSON and keeper execution'],
  ['m59-position-read-test.mjs','fine observations require an ordered server read tied to this client and room'],
  ['m59-jump-takeoff-test.mjs','declared ledge variations retain stock timed gravity, ordinary takeoff approaches and running/occupied-landing guards'],
  ['m59-rest-dispatch-test.mjs','journey recovery delegates one bounded rest to the keeper rather than nesting its default rest in a proxy loop'],
  ['m59-fine-safeleg-test.mjs','safe legs from the actual fine body stop at proved refuges within the travelled distance allowance'],
  ['m59-safeleg-policy-test.mjs','live safe-leg policy accepts required and advisory modes without dropping the transport constraint'],
  ['m59-falljump-choice-test.mjs', 'adjacent declared falls prefer the requested landing while retaining eligible variation fallback'],
  ['m59-moving-platform-test.mjs', 'Ancient Place lift heights and timing retain legal running falls and reject wrong lift states'],
  ['m59-brax-puzzle-test.mjs', 'server reentrant reset reproduces the late lever lock; observed baseline and phase fences prevent premature pulls'],
  ['m59-brax-test.mjs', '25-player platform stations, divided levers, endpoint-keyed atomic group journal and live-room objective'],
  ['m59-rail-animation-test.mjs', 'rail aims wait for room animation without advancing, changing rooms, ignoring cancellation or waiving collisions'],
  ['m59-deviation-routing-test.mjs', 'confirmed rail bends take bounded local detours; exit-candidate exhaustion reaches the journey replanner without relaxing unknown-position or ownership guards'],
  ['m59-cragged-pocket-test.mjs', 'fine pocket escape rails, distant goals, persistent refusal evidence, choke admission, survival ownership and quarry approach invalidation'],
  // The full corpus retains stock-gravity settlement waits. Its individual
  // scenes remain bounded; allow the expanded file ten minutes on busy hosts.
  ['m59-bastion-fallback-test.mjs', 'recent PvP death and last-stuck origins reach Castle Victoria through real walkers and modeled declared crossings; suffix boarding, square goals and paced ownership/body guards',600_000],
  ['m59-deviation-test.mjs', 'recorded Cragged departure, early atomic deviation, authoritative failure evidence, ownership and mandatory avoidance'],
  ['m59-wall-thread-test.mjs', 'a wall in the way is threaded along, not slid into; a refused slide does not end leaving before the doorway fallbacks (109, 2026-10-13)'],
  ['m59-edge-stage-test.mjs', 'a body refusing an exit stage defers its neighbours: the budget tries elsewhere on the wall (596 -> 61, 2026-10-14)'],
  ['m59-ukgoth-north-door-test.mjs', 'a confirmed geometry slide is learned and re-planned, and a departure onto a broken rail head boards past it (599 -> 2, 2026-10-14)'],

  ['m59-tos-refuge-review-test.mjs', 'Tos refuge square goals and revoked predictions; recovery departure preserves shelter and health-loss uncertainty'],
  ['m59-travel-crowd-test.mjs', 'passive pursuit estimates, bounded live-body detours and short pressure recovery retain uncertainty and movement ownership'],
  ['m59-shadow-journey-test.mjs', 'shadow replay resumes yielded or ended journey ownership and preserves active recovery'],
  ['m59-pivot-crowd-test.mjs', 'real optimized rail and pivot routes detour before confirmation waits; paced blockers and ownership remain guarded'],
  ['m59-travel-continuity-test.mjs', 'a recovering walk retains its objective, refused edges, mandatory avoidance and survival ownership'],
  ['m59-passage-admission-test.mjs', 'narrow passages exclude unrelated traffic, share explicit same-destination convoys across processes, and release only confirmed individual exits'],
  ['m59-island-composition-test.mjs', 'Island work compiles before departure and required safe chains refuse direct fallback'],
  ['m59-pvp-readiness-test.mjs', 'PvP wand holds retain pursuit; sight, facing and shared cooldown are rechecked at dispatch; Castle chamber doors are shared'],
  ['m59-death-prevention-test.mjs', 'poisoned recovery and refuge approaches, including exits, retain confirmed progress and cancel stalled movement'],
  ['m59-escape-test.mjs', 'a missed shifting portal window still tries other fixed portals'],
  ['m59-travel-test.mjs', 'entry memory separates source doors from destination landings; failed hops retain evidence'],
  ['m59-island-test.mjs', 'island health and safe-leg policy guards; full chalice, observed landings and exclusive recoverable jungle cargo'],
  ['m59-fine-recovery-test.mjs', 'a fresh keeper interruption recovers an offline fine-action reply and confirms the original fine goal'],
  ['m59-refuge-leg-test.mjs', 'recent confirmed progress retains a short proved route to cover; stale, blocked or cancelled legs restore emergency recovery'],
  ['m59-vertical-motion-test.mjs', 'ordinary walking falls age a conservative height envelope across packets and floor changes; unmodelled flights retain their uncertainty'],
  ['m59-fine-refuge-reach-test.mjs', 'recorded Konima recovery supplements coarse reach with bounded reversible live-body fine approaches and retains occupied goals'],
  ['m59-covered-cut-test.mjs', 'a body-blocked fine cut tries a proved nearby alternative refuge before waiting at existing cover and retains visited-stop exclusions'],
  ['m59-fine-guides-test.mjs', 'baked directional fine walks retain live geometry, body, boarding, endpoint and closed-door checks'],
  ['m59-observed-geometry-test.mjs', 'typed room door observations update an external fine planner without mutating another character or the baked source'],
  ['m59-konima-crossing-test.mjs', 'distinct stock-gravity crossings and one-at-a-time admission send missed landings through the southbound gutter'],
  ['m59-fine-traffic-refuge-test.mjs', 'a live-body cut waits at a proved fine refuge and moves only after a fresh scene admits the route'],
  ['m59-selfheal-test.mjs', 'fresh named player identity replaces a reused self id and refuses another character position after saves'],
  ['m59-recovery-driver-age-test.mjs', 'both real watchdogs retain new or confirmed progressing keeper approaches while bounding stalled-driver rescue and ownership'],
  ['m59-refuge-activation-test.mjs', 'rest at confirmed cover uses a normal activation turn after rejoin, with identity, cancellation and cleanup guards'],
  ['m59-covered-traffic-test.mjs', 'a body-constrained refuge gap wakes the room and waits at confirmed cover before re-proving the required route'],
  ['m59-survival-escalation-test.mjs', 'local retreats use an observed landing in this room; cancellation forbids further rungs'],
  ['m59-survival-jam-test.mjs', 'blocked travel recovery preserves the objective and exact body identity'],
  ['m59-passorder-test.mjs', 'an unfinished Underworld escape retains ownership while its stage age remains visible'],
  ['m59-travel-recovery-arm-test.mjs', 'suspended travel respects its original arming guard without requiring a weapon factory'],
  ['m59-rejoin-test.mjs', 'concurrent survival reconnects share one login and release the next attempt on success or failure'],
  ['m59-pilgrimage-report-test.mjs', 'tail reports retain censored attempts and stop aging terminal refusals'],
  ['m59-underworld-node-test.mjs',
   'Underworld checked activation approaches avoid portal triggers; the unlit-only puzzle solver and special node verdict agree with source'],
  ['m59-node-path-test.mjs',
   'node routes preserve narrow bends and wire rounding; final-step arrivals require server confirmation'],
  ['m59-movement-recovery-test.mjs',
   'failed shelter recovery and terminal approaches stop retrying; incident clocks and bounded attempt evidence survive'],
  ['m59-collision-trace-test.mjs',
   'move attempts preserve time and loss markers; full disk tracing stays opt-in'],
  ['m59-death-prevention-test.mjs',
   'poison cannot mask attacks, arsenic is not medicine, and refuge retries need confirmed progress'],
  ['m59-blockedpath-test.mjs',
   'can a weak creature indefinitely block a fully built character — the 584 southeast corridor'],
  ['m59-unarmed-blocker-test.mjs',
   'a refusal never names a precondition that is already satisfied — the seven-hour stall'],
  ['m59-clearblockers-test.mjs',
   'the rung that swings at what is in the way, and the gates that keep it from becoming "fight everything"'],
  ['m59-needle-test.mjs',
   'a one-square corridor with bodies in it is threaded by routing WITHIN squares, not around them'],
  ['m59-lane-test.mjs',
   'two characters in a one-square pipe keep right and pass instead of stalling nose to nose'],
  ['m59-thoroughfare-test.mjs',
   'an idle body never rests in a one-lane passage, and steps out of one when a player is behind it'],
  ['m59-traffic-continuation-test.mjs',
   'traffic partitions, pre-cast progress and nested recovery cannot undo a journey unnoticed'],
  ['m59-wallstop-test.mjs',
   'where a journey is allowed to stop, on the wall book this fleet actually learned'],
  ['m59-collision-test.mjs',
   'every in-room move validated against the same rules the stock client enforces'],
  ['m59-routing-test.mjs',
   'the router plans on the map the mover enforces, and the bake matches it'],
  ['m59-travelling-test.mjs',
   'travel_guard: what a journey may interrupt itself for, on which clock'],
  ['m59-safespot-test.mjs',
   'a wall is the two grids disagreeing, and the spot book stays a book'],
  ['m59-impossible-test.mjs',
   'a move that cannot be validated is refused rather than retried'],
  ['m59-coords-test.mjs',
   'three coordinate spaces and the boundaries between them'],
  ['m59-recordjam-test.mjs',
   'every committed jam fixture is still roles and not player names'],
  ['m59-leverpuzzle-test.mjs',
   'room 2600 on the way to 2601 is worked by two keepers on one beat, judged by the door, never by a stale read'],
  ['m59-qor-temple-test.mjs',
   'a code exit is a transit only from a door that walks to its trigger, and a shut lift is waited for'],
  ['m59-move-origin-test.mjs',
   'every move order names its issuer, a cancel names whose move it took, and a failure leaves one replayable incident'],
  ['m59-body-held-square-test.mjs',
   'a monster standing on the next square\'s stand point is walked round into that square, not re-aimed at for ever (Rowlf, Ukgoth r19c35)'],
];

// FAILURES THAT ARE ALREADY THERE, BY EXACT ASSERTION TEXT.
//
// Recorded 2026-09-19 against origin/main. Each one is somebody's open problem, not a licence:
// if you are touching the code a line here guards, fix it and delete the line.
const KNOWN_RED = {
  // Reproduced unchanged on main b2d26f6, 2026-09-25. These older freeze
  // expectations are independent of the poison and refuge-approach fixes.
  'm59-safespot-test.mjs': [
    'the first freeze is allowed — rejoined 0x',
    'and it says why rather than looping quietly',
    'freezing is allowed again once health has moved',
  ],
  'm59-needle-test.mjs': [
    "and PLAYER_HEIGHT is still the client's own figure, imported rather than written out",
    "clearance is measured against MIN_NOMOVEON in wire units, not 1.5 squares",
    "a blocked line tries a lane before it tries a different landing",
    "and a lane is only taken when both of its ends still have floor",
    "the lane is what the fall actually aims at",
    "the lane search exists",
    "and it is OUTSIDE the declared-jump gate, so an ordinary fall reaches it",
    "the WAIT stays declared-only \u2014 three seconds on every fall is not affordable",
    "and so does clearestLanding, which moves the destination and measured 1/10",
    "a blocked ordinary fall refuses with a named reason",
    "the refusal is only raised after the lane has been tried",
    "it is recorded, so \"nothing happened\" can be told from \"it was refused\"",
  ],
  'm59-travelling-test.mjs': [
    'and one that is not rests to FULL health and the resting cap',
    'bounded, so a refuge that cannot heal cannot hold a crossing for ever',
    'and it says both arriving and leaving, so a long leg can be read afterwards',
    'and the refuge mend already asked for the cap unconditionally',
  ],
};

const argv = process.argv.slice(2);
const strict = argv.includes('--strict');

if (argv.includes('--list')) {
  console.log('\nOffline suites a #movement commit has to clear:\n');
  for (const [file, why] of SUITES) {
    const red = KNOWN_RED[file]?.length ?? 0;
    console.log('  ' + file.padEnd(30) + why + (red ? `   [${red} known-red]` : ''));
  }
  console.log('\n--strict fails the run on the known-red baseline too.\n');
  process.exit(0);
}

// Both failure shapes this repository writes: `  FAIL <what>` and `  NO   <what>`.
const failureNames = (out) => out.split('\n')
  .map(l => {
    const m = /^\s*(?:FAIL|NO)\s+(.+?)\s*$/.exec(l);
    if (!m) return null;
    // Detail is appended after two spaces by several suites; the assertion text is the stable part.
    return m[1].split('  ')[0].trim();
  })
  .filter(Boolean);

console.log('\n=== #movement suites ===\n');
let regressions = 0, fixed = 0, missing = 0, ran = 0;
const summary = [];
// Keep complete failure evidence: the last three lines can be route startup
// notices while the actual node:test assertion was printed much earlier.
const failureDirectory=resolve('substrate/movement-suite-reports',Date.now()+'-'+process.pid);

for (const [file, why, timeoutMs=300_000] of SUITES) {
  const path = 'tools/' + file;
  if (!existsSync(path)) {
    console.log('  ????  ' + file.padEnd(30) + 'NOT FOUND — a suite named here must exist');
    missing++; summary.push([file, 'MISSING', '']); continue;
  }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path], { windowsHide: true, encoding: 'utf8', timeout: timeoutMs });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  ran++;
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const names = failureNames(out);
  const known = KNOWN_RED[file] ?? [];
  const isKnown = (n) => known.some(k => n === k || n.startsWith(k) || k.startsWith(n));
  const newFails = names.filter(n => !isKnown(n));
  const nowFixed = known.filter(k => !names.some(n => n === k || n.startsWith(k) || k.startsWith(n)));

  // A suite that died without printing a failure line — a throw, a timeout, a missing import —
  // is a regression too, and the exit code is the only thing that catches it.
  const crashed = names.length === 0 && r.status !== 0;

  let verdict;
  if (crashed) { verdict = 'CRASHED'; regressions++; }
  else if (newFails.length) { verdict = 'REGRESSED'; regressions++; }
  else if (strict && names.length) { verdict = 'RED (strict)'; regressions++; }
  else if (names.length) verdict = `ok (${names.length} known-red)`;
  else verdict = 'ok';

  const mark = verdict.startsWith('ok') ? '  ok  ' : '  XX  ';
  console.log(mark + file.padEnd(30) + verdict.padEnd(20) + secs + 's');
  for (const n of newFails) console.log('          NEW FAILURE: ' + n);
  if(crashed||newFails.length){mkdirSync(failureDirectory,{recursive:true});const evidence=resolve(failureDirectory,file+'.log');writeFileSync(evidence,out);console.log('          full failure output: '+evidence);}
  if (crashed) {
    console.log('          exit ' + r.status + (r.error ? ' — ' + r.error.message : ''));
    console.log('          ' + out.trim().split('\n').slice(-3).join('\n          '));
  }
  for (const k of nowFixed) { console.log('          FIXED, delete it from KNOWN_RED: ' + k); fixed++; }
  summary.push([file, verdict, why]);
}

console.log('\n' + '-'.repeat(72));
console.log(`${ran} suite(s) run, ${regressions} regressed, ${fixed} baseline entr(ies) now passing` +
            (missing ? `, ${missing} missing` : ''));
if (fixed) console.log('Prune KNOWN_RED — a baseline nobody prunes becomes a permission slip.');
if (regressions) {
  console.log('\nA #movement commit does not land with a regression here. The suites above name ' +
              'the assertion, and each one is a measured incident rather than a style rule.');
}
process.exit(regressions ? 1 : 0);
