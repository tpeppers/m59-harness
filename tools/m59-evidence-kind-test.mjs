#!/usr/bin/env node
// WATCHED OR INFERRED — offline, no ledger, no socket, no fleet:
//
//   node tools/m59-evidence-kind-test.mjs
//
// WHAT THIS PINS, AND I AM THE INCIDENT. On 2026-09-12 I measured that `level_lost` rows lag
// the death that caused them by a median of 5.0 minutes, and concluded `level_lost` must have a
// second source. It does not. It has no death source either: it is a SAMPLED DIFF, fired when
// the polled `level` field is lower than it was last poll, and the lag IS the poll interval.
//
// Before catching that I had published "forty-nine deaths, forty-nine levels, no exceptions"
// off a three-day window that happened to sit entirely inside the period where the death
// penalty applies. Another session put that sentence into a code comment on the strength of my
// message. Two sessions, one unchecked generalisation, and the only thing that caught it was
// somebody re-deriving it from the whole ledger instead of the window I sampled.
//
// So the rule is executable here rather than resident in one tool's header: COUNT SAMPLED ROWS
// PER CHARACTER, NEVER JOIN THEM BY TIME.
import { evidenceKind, why, joinableByTime, deathFidelity, killerIsMeaningful,
         OBSERVED, SAMPLED, UNKNOWN, SAMPLE_MS } from './m59-evidence-kind.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
};
const eq = (label, got, want) =>
  ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

console.log('\nthe rows that are diffs, not events');
{
  eq('level_lost is sampled', evidenceKind('level_lost'), SAMPLED);
  eq('level_up too — same emitter, same line', evidenceKind('level_up'), SAMPLED);
  eq('and strategy_changed', evidenceKind('strategy_changed'), SAMPLED);
  ok('level_lost says it is not a death event', /NOT a death/.test(why('level_lost')), why('level_lost'));
}

console.log('\ndied is the one that fooled me');
{
  // Emitted on a poll like the others, so the CLOCK is the poller's — but its fields are
  // reconstructed by the keeper, so they mean something. Nothing distinguished those two
  // halves before, which is why I treated it as a reliable anchor and joined to it.
  eq('died is sampled, not observed', evidenceKind('died'), SAMPLED);
  ok('and says why the fields are still trustworthy',
     /reconstructed/.test(why('died')) && /TIMESTAMP/.test(why('died')));
}

console.log('\nthings actually written when they happened');
{
  for (const k of ['killed', 'looted', 'cast', 'fought_back', 'stuck_backed_up'])
    eq(`${k} is observed`, evidenceKind(k), OBSERVED);
  // Tonight's own instrument: an episode carries its own began/ended, so it is not a diff.
  eq('wall_contact is observed', evidenceKind('wall_contact'), OBSERVED);
  eq('shuffle is observed', evidenceKind('shuffle'), OBSERVED);
}

console.log('\nan unclassified kind is UNKNOWN, never observed');
{
  // THE COERCION RUNS ONE WAY AND IT IS THE EXPENSIVE WAY. Defaulting an unread kind to
  // `observed` would let the next analysis join it by time with no warning at all — the exact
  // mistake this file exists for, made by the file that exists to prevent it.
  eq('a kind nobody has read is unknown', evidenceKind('travel_journey'), UNKNOWN);
  eq('so is nonsense', evidenceKind('not_a_kind'), UNKNOWN);
  eq('and undefined', evidenceKind(undefined), UNKNOWN);
  ok('the reason names the remedy', /read its emitter/.test(why('whatever')), why('whatever'));
}

console.log('\nrefusing a time join — the sentence that would have stopped me');
{
  const bad = joinableByTime('died', 'level_lost');
  ok('died + level_lost is REFUSED', bad.ok === false);
  eq('and both are named', bad.kinds, ['died', 'level_lost']);
  ok('the refusal states the resolution', new RegExp(`${SAMPLE_MS / 60_000}m`).test(bad.why), bad.why.slice(0, 90));
  ok('and gives the alternative', /per character/.test(bad.why));

  ok('two observed kinds are allowed', joinableByTime('killed', 'looted').ok === true);
  ok('one sampled kind spoils the join', joinableByTime('killed', 'level_lost').ok === false);
  // An unknown kind is refused too — it is not observed, and that is the whole test.
  ok('an unknown kind is refused rather than assumed', joinableByTime('travel_journey').ok === false);
}

console.log('\nfifteen per cent of death rows are degraded');
{
  // Measured on prod: 895 rows, 758 reconstructed, 76 inferred, 61 thin. Nothing downstream
  // could tell them apart, and the difference decides whether a null killer is a fact.
  eq('a reconstructed row', deathFidelity({ kind: 'died', killed_by: 'troll', health_trail: [] }),
     'reconstructed');
  eq('an inferred row', deathFidelity({ kind: 'died', note: 'inferred from sampling' }), 'inferred');
  eq('a thin row', deathFidelity({ kind: 'died', detail_missing: true }), 'thin');
  eq('something that is not a death', deathFidelity({ kind: 'killed' }), UNKNOWN);
  eq('an empty row is unknown, not reconstructed', deathFidelity({}), UNKNOWN);
}

console.log('\na null killer is not the same fact twice');
{
  // THE RULE THIS PROTECTS. The critic will not accept a PVP verdict unless a named non-fleet
  // player is SHOWN — the mistake it exists for turned six trolls into a PVP death once. An
  // inferred row has no killer because nobody watched, and reading that absence as "killed by
  // nothing" is the same error wearing different clothes.
  const good = killerIsMeaningful({ kind: 'died', killed_by: 'troll', health_trail: [] });
  ok('a reconstructed killer may be used', good.ok === true);

  const inferred = killerIsMeaningful({ kind: 'died', note: 'inferred from sampling' });
  ok('an inferred one may NOT', inferred.ok === false);
  ok('and the reason distinguishes absence from emptiness',
     /nobody watched/.test(inferred.why) && /not the same fact/.test(inferred.why));

  const thin = killerIsMeaningful({ kind: 'died', detail_missing: true });
  ok('a thin row says the fields are absent, not empty', /absent, not empty/.test(thin.why));
  ok('an unclassifiable row refuses too', killerIsMeaningful({}).ok === false);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
