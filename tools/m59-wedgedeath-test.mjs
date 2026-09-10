#!/usr/bin/env node
// TWO CHARACTERS DIED WEDGED IN UKGOTH WITH THE KEEPER AWAKE — offline, no socket, no roster.
//
//   node tools/m59-wedgedeath-test.mjs
//
// THE INCIDENT, prod 2026-09-10. Rizzo (t19) and Camilla (t9) died to trolls in room 599, 83
// seconds apart, both `doing: travelling`, both on the same two squares in the gutters, and
// NEITHER EVER SWUNG (`swung_ms: null`). The operator noticed the thing that matters about that:
//
//   "both of them just kinda sat there and died... both didn't really move or fight back -- not
//    that fighting back would've helped, but it would've shown a sign that it's not a
//    fall-through (broken, logged out, etc.)"
//
// It was not a fall-through. `during_keeper_outage` is null in both postmortems and both keepers
// were recording passes all the way down. It was worse than that: the keepers were awake, could
// see fifteen threats, and the two mechanisms that exist to save a wedged traveller both
// declined to fire, for two different reasons, in the same room, ninety seconds apart.
//
// This file pins those two reasons. It reads the source rather than driving a keeper, for the
// same reason m59-keeperaddress-test.mjs does: the failures are in the CONDITIONS, and a
// condition that cannot be true is invisible to a behaviour test that never sets it up.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (what, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '  — ' + extra : ''}`); }
};

const SRC = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');

// CODE, NOT PROSE. Twice in this session an assertion matched a phrase that appeared in the
// comment explaining the fix, and reported a false failure against itself. So every check below
// looks for a construct, and where a comment is genuinely the artefact worth pinning it says so.
const code = SRC.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

console.log('');
console.log('CAMILLA: "am I being hit" was decided by two adjacent samples');
{
  // Her health trail was 20 -> 15 -> 16 -> 11 -> 7 -> 3 of 60. The 15 -> 16 step is an INCREASE
  // — health regenerates between blows, and a sample can land in the gap — so the old
  // `last.health < prev.health` read FALSE while she lost seventeen health, and the rescue that
  // gates on it was never asked the other three questions.
  ok('the adjacent-pair-only test is gone',
     !/const takingHits = prev\.health != null && last\.health != null && last\.health < prev\.health;/
       .test(code));
  ok('the first blow of a fresh episode is still caught by the adjacent pair',
     /const hitNow = prev\.health != null && last\.health != null && last\.health < prev\.health;/
       .test(code));
  ok('and the episode carries the health it began at, which is the trend baseline',
     /health_at_start: last\.health \?\? null/.test(code));
  ok('so taking_hits is the trend across the episode ORed with the fresh blow',
     /const takingHits = hitNow \|\|/.test(code) &&
     /last\.health < startedAt/.test(code));
  // A regen tick inside an episode must not clear it. The OR against the baseline is what makes
  // that impossible, and this asserts the baseline is read from the EPISODE rather than resampled.
  ok('the baseline comes off the live episode, not from a fresh read',
     /const startedAt = w\.wedged\?\.health_at_start;/.test(code));
  ok('and the episode says how much it has cost, so a rescue can report what it saw',
     /w\.wedged\.health_lost = Math\.max\(0, w\.wedged\.health_at_start - last\.health\)/.test(code));
}

console.log('');
console.log('CAMILLA AGAIN: the rescue required a driver, and nobody was driving her');
{
  // `wedge.inert` is set only when THIS keeper stood itself down, or when another driver holds
  // movement. Camilla's faculties had been released minutes earlier when a fleet errand refused
  // her, so neither was true and the clause could not be satisfied — which meant the other three
  // conditions were never evaluated at all. She sat on one square for 2,029,414 ms.
  //
  // Rizzo died 83 seconds earlier in the same room and WAS rescued (`was_inert_for_s: 74`),
  // because something still held his movement. Same room, same trolls, same code: the difference
  // was who owned the body, which has nothing to do with whether it should be saved.
  ok('the rescue no longer requires the inert marker',
     !/if \(travelling && wedge\?\.inert && wedge\.taking_hits/.test(code));
  ok('it fires on a wedge that exists at all',
     /if \(travelling && wedge && wedge\.taking_hits/.test(code));
  // The three remaining conditions are what make it specific, so none of them may be dropped:
  // travelling, still for long enough, losing health, and below this character's own flee line.
  // TWO SITES SHARE THIS CONDITION and only one of them is the rescue: the other is the note
  // that records a wedge while deliberately letting the journey stand. Pick the rescue by the
  // line that follows it, not by position -- the first version of this test sliced from the
  // first match, got the note, and reported the rescue as missing its own flee-line check.
  // The rescue is the LATER of the two, so take the last match. Character offsets are not a
  // safe way to pick between them: this string is comment-stripped, so distances in it do
  // not match the file and a windowed search silently landed on the note instead.
  const gate = code.slice(code.lastIndexOf('if (travelling && wedge && wedge.taking_hits'));
  ok('it still requires the character to be travelling', /travelling &&/.test(gate.slice(0, 120)));
  ok('it still requires the wedge to have lasted INERT_RESCUE_MS',
     /\(now - wedge\.since\) >= INERT_RESCUE_MS/.test(gate.slice(0, 260)));
  ok('it still requires health to be below the flee line',
     /frac < this\.safety\(\)\.fleeAt/.test(gate.slice(0, 700)));
  ok('it still rescues at most once a pass', /w\.rescuedPass !== this\.passes/.test(gate.slice(0, 260)));
  // And the journey is SUSPENDED, never cancelled — the standing rule that cancelling a trip is
  // worse than riding it out is intact; this is the dying exception to it.
  ok('and the journey is suspended with its destination kept, not cancelled outright',
     /this\.suspendedJourney = \{/.test(gate.slice(0, 900)));
}

console.log('');
console.log('the inert marker is still RECORDED — it is evidence, just not a precondition');
{
  // Knowing which driver was holding a dying character is exactly what a postmortem wants. The
  // fix removes it from the gate without removing it from the record.
  ok('a wedge still records who was driving, when somebody was',
     /\.\.\.\(drivenByOther \? \{ inert: drivenByOther \} : \{\}\)/.test(code));
  ok('and it is still derived from both the keeper and a held movement faculty',
     /this\.facultyHeld\('movement'\)/.test(code));
}

console.log('');
console.log('THE WEDGE COMES FIRST, AND THE BODY IS HEALTHY IN IT');
{
  // THE SAMPLE THAT REFRAMED THIS, from hk2 in room 598, one pulse every ~16s, all at r42c26:
  //
  //     13/20, 13, 13, 13, 6, 1, 1, 1, 1  ->  The Underworld
  //
  // Four consecutive samples STATIONARY AT FULL HEALTH before any damage began. So the wedge is
  // the antecedent condition and not a consequence of being attacked -- which means every gate
  // in this file that keys on health can only fire once the runway is gone. Displacement fires
  // while the body is still whole: it would have caught Sweetums nine minutes before she died
  // (ms_since_moved 546611) and Camilla thirty-four (2029414).
  const WD = readFileSync(new URL('./m59-watchdog.mjs', import.meta.url), 'utf8');
  const wcode = WD.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

  // THIRD VARIANT OF ONE BUG, AND THE TWO GATES POINTED OPPOSITE WAYS. The healthy-wedge pin
  // required `!host.inert` -- so a body an errand held could never be pinned -- while the wedge
  // RESCUE required `wedge.inert`, so it only fired when somebody else was driving. Between
  // them a held body was pinned and never noticed, and an unheld one noticed and never rescued.
  ok('a body under a lease can now be pinned at all',
     !/const eligible = GOING\.includes\(host\.doing \?\? null\) && !host\.inert/.test(wcode));
  ok('and the pin still only counts while something claims it is GOING somewhere',
     /const eligible = GOING\.includes\(host\.doing \?\? null\) && !host\.hold && spot;/.test(wcode));
  // Detection and intervention are different rights: yanking movement from a lease holder is
  // how two drivers fight for one body, which this repository has already paid for.
  ok('but the CANCEL is still only taken when nobody else is driving',
     /const cancelling = pinnedFor >= WATCHDOG_HEALTHY_CANCEL_MS && !host\.inert;/.test(wcode));
  ok('and the note names the holder, so a stuck errand is distinguishable from a stuck keeper',
     /held_by: host\.inert \?/.test(wcode));
  // hk2 was the stacked case: a journey AND an errand lease AND survival with the keeper.
  ok('GOING is still the honest filter — a body at a shop counter is not travelling',
     /export const GOING = \['travelling', 'pulling', 'converging', 'zoning'\]/.test(WD));
}
console.log('');
console.log('WHAT IS STILL NOT FIXED, asserted so it cannot be quietly forgotten');
{
  // NEITHER CHARACTER EVER SWUNG. `swung_ms: null` in both postmortems, with six trolls in melee
  // reach. That is the journey's documented behaviour — Rizzo's own decision log says the keeper
  // "will not hunt, roam, shop or pick a room while the journey owns the" body — and CLAUDE.md
  // says a hurt body that cannot move should swing instead. Those two are in tension and the
  // tension is unresolved: this test asserts only that the claim in the decision log is real, so
  // that whoever fixes it can find the sentence rather than rediscovering the behaviour.
  ok('a journey does still suppress work, which is why a wedged traveller does not fight',
     /will not hunt, roam, shop or pick a room/.test(SRC));
  // The gutters themselves are not a bug and must not be "fixed" by banning the room: the only
  // road to Castle Victoria runs through 599. See m59-stuck.mjs `ukgoth-gutters`.
  ok('and the stuck guide carries the entry for this room',
     /ukgoth-gutters/.test(readFileSync(new URL('./m59-stuck.mjs', import.meta.url), 'utf8')));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
