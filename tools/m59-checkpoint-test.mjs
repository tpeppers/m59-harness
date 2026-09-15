#!/usr/bin/env node
// Offline. Opens no socket, touches no roster.
//
// Every case here is an incident from the boss-raid session of 2026-09-11, because the
// checkpoint rules are not preferences — each one is a way a raid already went wrong.
import { checkpoint, chain, reach, runUntil, survey, report,
         HELD, ESTABLISHED, UNKNOWN, FAILED, NO_ESTABLISH } from './m59-checkpoint.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};

console.log('a checkpoint refuses to exist without a postcondition');
{
  let threw = null;
  try { checkpoint('armed', {}); } catch (e) { threw = e.message; }
  ok('holds() is mandatory', /needs a holds/.test(threw ?? ''), threw);
  ok('and it says why a checkpoint without one is pointless',
     /steps are what we are trying not to replay/.test(threw ?? ''));
  ok('a duplicate name in a chain is refused', (() => {
    try { chain(checkpoint('a', { holds: () => true }), checkpoint('a', { holds: () => true })); return false; }
    catch (e) { return /duplicate/.test(e.message); }
  })());
}

console.log('\nan already-true checkpoint is held, not re-established');
{
  let established = 0;
  const c = chain(checkpoint('armed', { holds: () => true, establish: () => { established++; } }));
  const r = await reach(c, 'armed');
  ok('it is reached', r.reached === true);
  ok('and reported as held', r.steps[0].outcome === HELD);
  ok('and establish() was never called', established === 0);
}

console.log('\nestablish() is VERIFIED, never believed');
{
  // THE INCIDENT. castVerified decided a spell had landed because the mana and the reagents
  // were gone. enchant weapon charges up front and then holds a 30-second trance the keeper's
  // own resting broke every time: cost paid, nothing landed, three reported successes.
  // An establish() that returns success is making exactly that claim.
  let calls = 0;
  const liar = chain(checkpoint('armed', {
    holds: () => false,                       // never becomes true
    establish: () => { calls++; return { ok: true, definitely: 'worked' }; },
  }));
  const r = await reach(liar, 'armed');
  ok('a lying establish() does not reach the checkpoint', r.reached === false);
  ok('establish() was called exactly once, not retried blindly', calls === 1, String(calls));
  ok('and the refusal names the real reason',
     /still false/.test(r.steps[0].why ?? ''), r.steps[0].why);
}

console.log('\nunknown is a third answer and is never coerced to false');
{
  // The server does not rename an enchanted weapon, so no prod-safe read can say whether one
  // is enchanted. Coerced to false it re-casts every pass and burns reagents; coerced to true
  // it walks a fleet at a boss unarmed.
  let established = 0;
  const c = chain(checkpoint('weapon-enchanted', {
    holds: () => null, establish: () => { established++; },
  }));
  const r = await reach(c, 'weapon-enchanted');
  ok('an unknown postcondition stops the skip by default', r.reached === false);
  ok('it is reported as UNKNOWN rather than failed', r.steps[0].outcome === UNKNOWN);
  ok('and nothing was established on the strength of a guess', established === 0);
  ok('the reason says unknown is not false',
     /unknown is not false/.test(r.steps[0].why ?? ''), r.steps[0].why);

  const r2 = await reach(c, 'weapon-enchanted', {}, { allowUnknown: true });
  ok('allowUnknown lets an operator say "establish it anyway"', established === 1);
  ok('but a still-unknown answer afterwards is STILL not success', r2.reached === false);
  ok('and it says nothing could tell whether it worked',
     /still cannot tell/.test(r2.steps[0].why ?? ''), r2.steps[0].why);
}

console.log('\nit stops at the first unreachable checkpoint and attempts nothing after it');
{
  // A partial skip is how a raid walks into a boss room believing it is armed.
  const touched = [];
  const c = chain(
    checkpoint('mustered', { holds: () => true }),
    checkpoint('armed',    { holds: () => false }),                 // no establish
    checkpoint('buffed',   { holds: () => { touched.push('buffed'); return true; } }),
  );
  const r = await reach(c, 'buffed');
  ok('it does not reach the end', r.reached === false);
  ok('it stops exactly at the broken one', r.at === 'armed', String(r.at));
  ok('a checkpoint with no establish() says so', r.steps[1].outcome === NO_ESTABLISH);
  ok('and the LATER checkpoint was never even asked', touched.length === 0);
  ok('the report explains why a partial skip is worse than none',
     /partial skip/.test(report(r)));
}

console.log('\nholds() is re-evaluated every time — that is the whole difference from a snapshot');
{
  // The fleet decays on its own: conjured weapons evaporate on a 1-24h timer, taking any
  // enchantment with them. "Armed" was true at 00:10 and false at 01:30 with nothing run.
  let asked = 0, armed = true;
  const c = chain(checkpoint('armed', {
    holds: () => { asked++; return armed; }, establish: () => { armed = true; }, perishable: true,
  }));
  await reach(c, 'armed');
  ok('asked once when it held', asked === 1, String(asked));
  armed = false;                                  // the weapon evaporated between attempts
  const r = await reach(c, 'armed');
  ok('asked again on the next attempt rather than trusting the first', asked >= 2);
  ok('and it re-established the decayed postcondition', r.reached === true);
  ok('the report marks a perishable checkpoint as such', /perishable/.test(report(r)));
}

console.log('\na throwing predicate is a failure, not a crash');
{
  const c = chain(checkpoint('armed', { holds: () => { throw new Error('broker refused'); } }));
  const r = await reach(c, 'armed');
  ok('it fails cleanly', r.reached === false && r.steps[0].outcome === FAILED);
  ok('and carries the underlying message', /broker refused/.test(r.steps[0].why ?? ''));
}

console.log('\nrunUntil stops BEFORE the named checkpoint');
{
  const done = [];
  const c = chain(
    checkpoint('mustered', { holds: () => done.includes('m'), establish: () => done.push('m') }),
    checkpoint('armed',    { holds: () => done.includes('a'), establish: () => done.push('a') }),
    checkpoint('engaged',  { holds: () => done.includes('e'), establish: () => done.push('e') }),
  );
  const r = await runUntil(c, 'engaged');
  ok('everything before it is established', r.reached === true && done.includes('m') && done.includes('a'));
  ok('and the fight itself was NOT started', !done.includes('e'), JSON.stringify(done));
}

console.log('\ndry run establishes nothing');
{
  let established = 0;
  const c = chain(checkpoint('armed', { holds: () => false, establish: () => { established++; } }));
  const r = await reach(c, 'armed', {}, { dryRun: true });
  ok('it reports what it would do', r.steps[0].outcome === ESTABLISHED && r.steps[0].dry === true);
  ok('and does none of it', established === 0);
}

console.log('\nsurvey answers "where is this fleet in the chain" without changing anything');
{
  let established = 0;
  const c = chain(
    checkpoint('mustered', { holds: () => true, describe: 'everyone at the door' }),
    checkpoint('armed',    { holds: () => null, establish: () => { established++; }, perishable: true }),
    checkpoint('engaged',  { holds: () => false }),
  );
  const rows = await survey(c);
  ok('it reports one row per checkpoint', rows.length === 3);
  ok('held, unknown and not-yet are distinguished',
     rows[0].state === HELD && rows[1].state === UNKNOWN && rows[2].state === 'not yet',
     JSON.stringify(rows.map(r => r.state)));
  ok('it says which ones can be established', rows[1].can_establish === true && rows[2].can_establish === false);
  ok('and it established nothing', established === 0);
}

console.log('\nan unknown checkpoint name is refused with the list of real ones');
{
  const c = chain(checkpoint('armed', { holds: () => true }));
  const r = await reach(c, 'enchanted');
  ok('it does not silently do nothing', r.reached === false);
  ok('and it names the checkpoints that DO exist', /this chain has: armed/.test(r.why ?? ''), r.why);
}

console.log('\nunknown establishes when establishing is FREE, and refuses when it is not');
{
  // The FleetScratch session's sharpening, and it is right: unknown only has to refuse when
  // establishing is expensive. For a personal enchantment the game refuses an already-in-effect
  // cast inside CanPayCosts, BEFORE taking payment (persench.kod:76) — so asking when the
  // answer is already yes costs nothing, and the cast is a better answer than the read that
  // could not tell.
  let freeCalls = 0, dearCalls = 0, landed = false;
  const free = chain(checkpoint('armed', {
    holds: () => (landed ? true : null),
    establish: () => { freeCalls++; landed = true; },
    establishCost: 'free', cites: 'persench.kod:76 — refused in CanPayCosts, before cost',
  }));
  const r1 = await reach(free, 'armed');
  ok('a free establish runs on an unknown postcondition', freeCalls === 1, String(freeCalls));
  ok('and the checkpoint is reached without anybody being asked', r1.reached === true);

  const dear = chain(checkpoint('armed', {
    holds: () => null, establish: () => { dearCalls++; }, establishCost: 'expensive',
  }));
  const r2 = await reach(dear, 'armed');
  ok('an expensive establish does NOT run on a guess', dearCalls === 0);
  ok('it refuses instead', r2.reached === false && r2.steps[0].outcome === UNKNOWN);
  ok('and the refusal names the cost, so the operator knows what they are authorising',
     /Establishing this is expensive/.test(r2.steps[0].why ?? ''), r2.steps[0].why);

  const r3 = await reach(dear, 'armed', {}, { allowUnknown: true });
  ok('allowUnknown is still the override for the expensive case', dearCalls === 1);
  ok('and an expensive establish that still cannot be verified is not success', r3.reached === false);
}

console.log('\na claim of "free" has to be citable');
{
  let threw = null;
  try { checkpoint('armed', { holds: () => null, establish: () => {}, establishCost: 'free' }); }
  catch (e) { threw = e.message; }
  ok('free without a citation is refused at construction', /needs a cites/.test(threw ?? ''), threw);
  ok('and it says why an uncited claim of free is dangerous',
     /unsupported claim of free/.test(threw ?? ''), threw);

  let bad = null;
  try { checkpoint('x', { holds: () => true, establishCost: 'quick' }); }
  catch (e) { bad = e.message; }
  ok('an unrecognised cost is refused rather than treated as expensive',
     /must be one of/.test(bad ?? ''), bad);
  ok('and the refusal lists the vocabulary', /free, cheap, expensive, irreversible/.test(bad ?? ''));

  const c = chain(checkpoint('armed', {
    holds: () => null, establishCost: 'free', cites: 'persench.kod:76',
  }));
  const r = await reach(c, 'armed');
  ok('free with no establish() still cannot reach the checkpoint', r.reached === false);
}

console.log('\nsurvey reports the cost and the citation, so a chain can be audited on paper');
{
  const c = chain(checkpoint('armed', {
    holds: () => null, establish: () => {}, establishCost: 'free',
    cites: 'persench.kod:76', describe: 'every raider wielding a magic weapon',
  }));
  const rows = await survey(c);
  ok('the cost is reported', rows[0].establish_cost === 'free');
  ok('and so is the citation that backs it', /persench\.kod:76/.test(rows[0].cites ?? ''));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
