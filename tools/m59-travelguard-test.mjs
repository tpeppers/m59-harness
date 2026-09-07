#!/usr/bin/env node
// ONE CHARACTER HAS ONE BODY — the contract test for travel's mutual exclusion.
//
//   node tools/m59-travelguard-test.mjs
//
// Offline. Nothing here opens a socket or takes the fleet lock.
//
// THE FAILURE THIS REPLACES, measured live on the arena fleet 2026-08-19: two travel
// calls on ONE character both ran. `substrate/transits/Alpha.json` recorded two journey
// ids — `arena3-mt0p7llh` and `arena3-mt0pf4pu` — walking the same character to the same
// destination, reporting the same crossings at identical timestamps. Each loop replanned
// against the other's steps, so every leg reported "kept ending up somewhere other than
// the planned square" (228 of those on disk, 20,313s of travel time).
//
// The cause was that `background: true` claimed a job slot and the FOREGROUND arm did
// not — it called `s.travel` directly, with no busy check at all. Two ways to run a
// travel, and only one of them honoured "one job at a time per session".
//
// It is reached by the ordinary path. A travel runs for minutes, longer than a default
// HTTP client timeout, so a caller that gives up and retries issues the second call
// believing the first is gone. It is not.
//
// And the cost is not a wasted walk. The travel tool stands the keeper DOWN for the whole
// journey — so while two loops fight over the character, whichever faculties it gave up
// are gone. Of 17 travelling deaths in one 30-minute window on prod, NOT ONE had a swing
// recorded against it.
//
// WHICH STAND-DOWN IT USES IS NOW PART OF THE CONTRACT, and this suite pins it. It used
// to be `goInert`, which switches the survival ladder off entirely, and that is the state
// Cccc died in on 2026-08-21: walked out of a sanctuary at 27% health against a 70% flee
// threshold and eaten over twenty-two seconds while the keeper watched every frame. It is
// `goTravelling` now — the character keeps its defensive faculties and each one is
// switchable per character. See TRAVEL_GUARD_DEFAULTS in m59-autopilot.mjs.
//
// The assertion below goes both ways on purpose: the wrapper must use the travelling state
// AND must not use the inert one. Only checking for the new call would let a future edit
// add `goInert` beside it and pass.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (what, cond) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}`); } };

// Overridable so the negative control can point at a copy with the OLD foreground path
// and prove this suite goes red on it. A structural assertion that has never been seen
// to fail is a structural assertion nobody has checked.
// TWO FILES SINCE 231ec65. `Session` — and with it `startJob` and `travelJob` — moved into
// m59-game.mjs when upstream's Session was ported; the `travel` TOOL stayed in the broker.
// This suite went silently red at that commit, reading the broker for methods no longer in
// it, and nothing noticed because it is not in `npm test`. Read both and search the
// concatenation: every pattern below occurs in exactly one of the two files.
const src = [
  readFileSync(process.env.M59_GAME_SRC || 'tools/m59-game.mjs', 'utf8'),
  readFileSync(process.env.M59_BROKER_SRC || 'tools/m59-broker.mjs', 'utf8'),
].join('\n');

// ---------------------------------------------------------------------------
// PART 1 — the mechanism. `startJob` lifted out of the broker and driven directly,
// the same way m59-travel-test lifts `travel`: the broker cannot be imported without
// taking the fleet lock, and reimplementing the thing under test would test the copy.
// ---------------------------------------------------------------------------
console.log('startJob is the one slot, and it can be awaited');
{
  const start = src.indexOf('  startJob(kind, label, fn, {');
  ok('the startJob method was located', start > 0);
  const SIG_END = '} = {}) {';
  const sigAt = src.indexOf(SIG_END, start);
  let depth = 0, end = -1;
  for (let i = sigAt + SIG_END.length - 1; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const startJobSrc = src.slice(start, end);
  ok('and it is a whole method', startJobSrc.trim().endsWith('}'));

  const make = () => {
    const o = new Function(`return ({ ${startJobSrc} })`)();
    o.name = 'tester';
    o.movementGeneration = 0;
    o.job = null;
    return o;
  };

  // A second job while the first is in flight is REFUSED, and says what is holding it.
  {
    const s = make();
    let release;
    s.startJob('travel', 'walk to Barloque', () => new Promise(r => { release = r; }));
    let threw = null;
    try { s.startJob('travel', 'walk to Tos', async () => 'second'); }
    catch (e) { threw = e.message; }
    ok('a second job is refused while the first is in flight', threw != null);
    ok('and the refusal names what is holding the body',
       /busy/.test(threw || '') && /walk to Barloque/.test(threw || ''));
    release('done');
  }

  // The promise is the foreground caller's way to wait for the slot it just claimed.
  {
    const s = make();
    const job = s.startJob('travel', 'walk to Tos', async () => ({ arrived: true, hops: 6 }));
    const hasPromise = typeof job.promise?.then === 'function';
    ok('startJob exposes a promise', hasPromise);
    // Guarded so the negative control REPORTS rather than throws. A suite that dies on
    // the first missing thing hides every assertion after it, which is exactly the
    // information the control is being run for.
    const r = hasPromise ? await job.promise : null;
    ok('and it resolves with the work\'s own result', r?.arrived === true && r?.hops === 6);
    await new Promise(res => setTimeout(res, 10));
    ok('while job.result still carries it for pollers', job.result?.arrived === true);
    ok('and the job is marked done', job.done === true);
  }

  // Once it is done, the slot is free again — a guard that never releases is a deadlock.
  {
    const s = make();
    const first = s.startJob('travel', 'first', async () => 'a');
    await (first.promise ?? new Promise(res => setTimeout(res, 10)));
    let threw = null;
    try {
      const second = s.startJob('travel', 'second', async () => 'b');
      await (second.promise ?? new Promise(res => setTimeout(res, 10)));
    } catch (e) { threw = e.message; }
    ok('a finished job releases the slot', threw === null);
  }

  // A FAILURE REACHES BOTH KINDS OF CALLER, and neither is starved by the other.
  {
    const s = make();
    const job = s.startJob('travel', 'doomed', async () => { throw new Error('no route'); });
    let threw = null;
    try { await (job.promise ?? Promise.resolve()); } catch (e) { threw = e.message; }
    await new Promise(res => setTimeout(res, 10));
    ok('the promise rejects so a foreground caller learns of it', threw === 'no route');
    ok('and job.error still carries it for a background poller', job.error === 'no route');
    ok('and a failed job still releases the slot', job.done === true);
  }

  // AND AN UNAWAITED FAILURE MUST NOT TAKE THE BROKER DOWN. A background caller never
  // touches `promise`, so an unhandled rejection here would kill a process holding
  // twenty-one irreplaceable sessions.
  {
    const s = make();
    const seen = [];
    const onUnhandled = e => seen.push(e);
    process.on('unhandledRejection', onUnhandled);
    s.startJob('travel', 'doomed and ignored', async () => { throw new Error('ignored'); });
    await new Promise(r => setTimeout(r, 50));
    process.off('unhandledRejection', onUnhandled);
    ok('an unawaited failing job raises no unhandled rejection', seen.length === 0);
  }
}

// ---------------------------------------------------------------------------
// PART 2 — the structure, which is what actually stops the regression coming back.
//
// Part 1 proves the slot works. It would have passed on the broken code too, because
// the bug was never in `startJob` — it was that one arm of the travel tool did not USE
// it. So assert the shape of the tool itself.
// ---------------------------------------------------------------------------
console.log('both arms of the travel tool go through that slot');
{
  const at = src.indexOf("    name: 'travel',");
  ok('the travel tool was located', at > 0);
  // Its `run:` body, brace-matched from the arrow.
  const runAt = src.indexOf('run: async (a) => {', at);
  ok('the travel tool has a run body', runAt > at);
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', runAt + 'run: async (a) =>'.length); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const body = src.slice(runAt, end);
  ok('and it is a whole body', end > runAt);

  // THE LOAD-BEARING ASSERTION. The walk may be spelled ONCE. Two spellings is how the
  // foreground arm drifted into having no busy check while the background one had one.
  const starts = (body.match(/s\.travelJob\(/g) || []).length;
  ok('the walk itself is written exactly once', starts === 1);

  // And never by reaching past the wrapper to the hop loop underneath it.
  ok('the tool does not call the hop loop directly', !/s\.travel\(/.test(body));

  // The background arm returns at once; the foreground arm awaits the SAME job.
  ok('the foreground arm awaits the job it claimed', /await\s+startTravel\(\)\.promise/.test(body));
  ok('the background arm still returns at once', /started: true/.test(body));

  // The keeper hold must still wrap the walk — losing it is how travel and the keeper
  // end up driving one character, which is the same failure by another route.
  ok('the keeper is still held for the journey', /travelJob\(/.test(body));
}

// ---------------------------------------------------------------------------
// PART 3 — NOBODY GOES ROUND THE SIDE.
//
// Fixing the tool fixed the callers that came through the tool. Five others in this file
// — the two faction errands, the Raza exit and its onward hop, and the follow loop —
// called `travel()` directly and so got neither the slot nor the keeper hold. A sixth
// hand-rolled a `startJob` and thereby got the slot but NOT the hold, and dropped the
// movement generation so `cancel_movement` could not reach it.
//
// So the invariant is file-wide, not tool-local: the hop loop is entered only from inside
// the one wrapper. This is the assertion that makes the next such caller fail here rather than on
// prod, and it is cheap to satisfy — `travelJob` / `travelExclusive` are right there.
// ---------------------------------------------------------------------------
console.log('the hop loop is entered only from inside the one wrapper');
{
  // Every `.travel(` that is not itself the wrapper's name.
  //
  // TWO OF THEM NOW, AND BOTH INSIDE THE WRAPPER. `travelJob` prefers the KEEPER's travel
  // — which is what carries the pre-departure rest, the hop hook and the ledger row — and
  // falls back to the session's raw hop loop when the session has no autopilot to ask.
  // The invariant was never "one call site"; it was "no caller outside this wrapper
  // reaches the hop loop", and counting was only ever a cheap way to say that. Counting
  // is what broke when the wrapper legitimately grew a second branch, so the test now
  // says the thing it means.
  const sites = [...src.matchAll(/(\w+)\.travel\(/g)].map(m => m.index);
  ok('the hop loop is reached at all', sites.length >= 1);

  {
    // ...and it is inside `travelJob`, not beside it. Brace-match from the BODY brace,
    // not from the destructured options in the signature — that one balances on its own
    // and would close the match before the body starts. Same trap m59-travel-test names.
    const jobAt = src.indexOf('  travelJob(dest, {');
    ok('the wrapper exists', jobAt > 0);
    const SIG_END = '} = {}) {';
    const sigAt = src.indexOf(SIG_END, jobAt);
    let depth = 0, end = -1;
    for (let i = sigAt + SIG_END.length - 1; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    ok('EVERY direct call sits inside travelJob',
       end > 0 && sites.every(at => at > jobAt && at < end));
  }

  // The wrapper has to do BOTH jobs, or a caller reaching for it gets half a guarantee.
  //
  // BRACE-MATCHED, NOT A FIXED SLICE. This read `jobAt + 2600` and every assertion below it
  // was really asking "is this in the first 2,600 characters of travelJob" — so growing the
  // method by a paragraph of comment silently moved the release line out of the window and
  // turned a passing assertion into a failing one about nothing. A window that depends on
  // how much you wrote is not a window.
  const jobAt = src.indexOf('  travelJob(dest, {');
  const wrapper = (() => {
    const SIG = '} = {}) {';
    const sigAt = src.indexOf(SIG, jobAt);
    let depth = 0;
    for (let i = sigAt + SIG.length - 1; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(jobAt, i + 1); }
    }
    return src.slice(jobAt);
  })();
  ok('the wrapper is a whole method', wrapper.trim().endsWith('}') && wrapper.length > 500);
  ok('the wrapper claims the job slot', /startJob\('travel'/.test(wrapper));
  ok('the wrapper stands the keeper down as TRAVELLING', /goTravelling\(/.test(wrapper));
  // The other half, and the one that catches a regression rather than a rename: a journey
  // must never take the state that switches the survival ladder off.
  ok('and never as inert — that state is for errands', !/goInert\(/.test(wrapper));
  // BY IDENTITY, not by "is it travelling". A take-back can end this journey and a second
  // one can start before the release runs, and the boolean version would then revive
  // somebody else's hold — which is the contention this whole file is about.
  // ON ONE LINE UNTIL 231ec65, and the port put a 140-line comment between the guard and
  // the call — so a regex that wanted them adjacent went red about formatting while the
  // guarantee was intact. Assert the shape instead: the identity guard exists, and EVERY
  // release in the wrapper is reached through it.
  const guardAt = wrapper.indexOf('if (ours && keeper?.inert === ours)');
  ok('the wrapper releases only the very hold it took',
     guardAt > 0 && [...wrapper.matchAll(/keeper\.revive\(/g)].every(m => m.index > guardAt));
  // The travelling guard can END the journey from under this wrapper — that is what a
  // take-back is — and the re-assert timer must not then put the character straight back
  // into the state the guard just left.
  ok('the re-assert stands down once the movement has been cancelled',
     /movementWasCancelled\(movementGeneration\)/.test(wrapper));
  ok('the wrapper passes the movement generation', /movementGeneration/.test(wrapper));
  // A stood-down keeper wakes on INERT_MAX_MS, so a hold that is asserted once and never
  // again lapses mid-journey and the keeper starts steering under the walk.
  ok('the keeper hold is re-asserted rather than set once', /setInterval\(assert_/.test(wrapper));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
