#!/usr/bin/env node
// Do the tuning tool's REFUSALS actually fire?
//
//   node tools/m59-tune-farming-test.mjs
//
// Offline: no socket, no roster, no broker. A temp directory stands in for the ledger and
// another for the record file.
//
// The thing under test is not arithmetic. `m59-tune-farming.mjs` exists because a session
// (2026-09-18) drove this fleet from ~2.4 kills/min to 0.57 while reporting progress, and every
// step of that was permitted by the absence of a rule rather than by a wrong number. So what has
// to be pinned is the five places the tool says NO — because a refusal is the only part of an
// experiment harness that anybody is ever tempted to delete at 02:00.
//
// Each case below is one of those failures, reproduced.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIN_GAP_MS, GROW_MS, MIN_VERDICT_KILLS,
  load, save, lastApplied, openProposal, openExperiment,
  reviewWindow, mayChange, killsIn, summarise,
} from './m59-tune-farming.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
};

const DIR = mkdtempSync(join(tmpdir(), 'm59-tune-'));
const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);          // fixed, so the day files are deterministic
const m = (n) => n * 60_000;

// A record with the experiments given, each {at, change, verdict?} in minutes-ago.
const rec = (...exps) => ({
  version: 1, started_at: NOW - m(30), source: null,
  experiments: exps.map((e, i) => ({
    id: i + 1, why: 'because', change: e.change ?? `change ${i + 1}`,
    predict_kpm: e.predict ?? 3, baseline_kpm: 2,
    proposed_at: NOW - m(e.at ?? 0) - 1000,
    applied_at: e.at == null ? null : NOW - m(e.at),
    verdict: e.verdict ?? null, abandoned: e.abandoned ?? false,
  })),
});

console.log('\n1. A CHANGE NEEDS A NUMBER, and the record has to keep it');
{
  // The prediction is written at PROPOSE time, before the change exists, which is the entire
  // point: a number chosen after the result is a description, not a prediction.
  const r = rec({ at: null, change: 'add zombie to band 38', predict: 3.1 });
  const p = openProposal(r);
  ok('an unapplied proposal is findable', !!p);
  ok('...and carries its prediction', p.predict_kpm === 3.1);
  ok('...and is not counted as an applied change', lastApplied(r) === null);
  ok('...and predates the change it predicts', p.proposed_at < NOW);
}

console.log('\n2. ONE CHANGE PER WINDOW — the refusal that stops two variables at once');
{
  const fresh = mayChange(rec(), NOW);
  ok('nothing applied yet: allowed', fresh.ok, fresh.why);

  const justNow = mayChange(rec({ at: 0, change: 'band 38 zombie' }), NOW);
  ok('a change 0m ago: REFUSED', !justNow.ok);
  ok('...and the refusal carries the wait', justNow.wait_ms === MIN_GAP_MS,
     `${Math.round(justNow.wait_ms / 60000)}m`);
  ok('...and names the change it is protecting', justNow.why.includes('band 38 zombie'));

  const nearly = mayChange(rec({ at: 14 }), NOW);
  ok('14m later: still REFUSED', !nearly.ok);
  const after = mayChange(rec({ at: 16 }), NOW);
  ok('16m later: allowed', after.ok);

  // The one that actually bit: the gap is measured from the LAST applied change, not the first.
  const two = mayChange(rec({ at: 40 }, { at: 3 }), NOW);
  ok('an old change and a recent one: REFUSED on the recent', !two.ok);
}

console.log('\n3. THE WINDOW GROWS WITH EVERY CHANGE — earn your reading time');
{
  const w0 = reviewWindow(rec(), NOW);
  ok('no changes: one window', w0.ends_at - w0.started_at === GROW_MS);
  const w1 = reviewWindow(rec({ at: 10 }), NOW);
  ok('one change: two windows', w1.ends_at - w1.started_at === 2 * GROW_MS);
  const w3 = reviewWindow(rec({ at: 50 }, { at: 30 }, { at: 10 }), NOW);
  ok('three changes: four windows', w3.ends_at - w3.started_at === 4 * GROW_MS);
  ok('...counted from the history, not a stored number', w3.changes === 3);
  // A proposal nobody applied buys nothing. Otherwise the window is extended by typing.
  const wp = reviewWindow(rec({ at: null }), NOW);
  ok('an unapplied proposal extends nothing', wp.ends_at - wp.started_at === GROW_MS);
}

console.log('\n4. A MEASUREMENT MAY NOT SPAN A CHANGE');
{
  // killsIn is the measurement; the CLI is what refuses. What is pinned here is the input that
  // refusal is computed from: which applied changes fall inside the window being asked for.
  const r = rec({ at: 20, change: 'band 38 zombie' });
  const inside = r.experiments.filter(e => e.applied_at >= NOW - m(30) && e.applied_at <= NOW);
  ok('a 30m window over a change 20m ago contains it', inside.length === 1);
  const outside = r.experiments.filter(e => e.applied_at >= NOW - m(10) && e.applied_at <= NOW);
  ok('a 10m window over the same change does not', outside.length === 0);
}

console.log('\n5. A VERDICT NEEDS A SAMPLE');
{
  // Reproduced live while building the tool: one minute after `applied`, three kills answered
  // "prediction HELD" against a prediction of 3.1. Three kills in a minute is 3.0/min, which is
  // inside a 20% band by accident. The floor is what makes that unsayable.
  const thin = summarise([{ room_num: 38, character: 'Camilla', creature: 'zombie' },
                          { room_num: 38, character: 'Camilla', creature: 'zombie' },
                          { room_num: 38, character: 'Pepe', creature: 'zombie' }], 1);
  ok('three kills in a minute reads as 3/min', thin.kpm === 3);
  ok('...and is below the verdict floor', thin.kills < MIN_VERDICT_KILLS,
     `${thin.kills} < ${MIN_VERDICT_KILLS}`);
  const fat = summarise(Array.from({ length: 79 }, () =>
    ({ room_num: 39, character: 'Scooter', creature: 'zombie' })), 30);
  ok('79 kills over 30m clears it', fat.kills >= MIN_VERDICT_KILLS);
  ok('...at the right rate', Math.abs(fat.kpm - 79 / 30) < 1e-9);
}

console.log('\n6. KILLS COME FROM THE LEDGER, and only the rows that are kills');
{
  const day = new Date(NOW).toISOString().slice(0, 10);
  const row = (t, extra = {}) => JSON.stringify({
    kind: 'killed', t, character: 'Camilla', creature: 'zombie', room_num: 38, ...extra });
  writeFileSync(join(DIR, `fleet-${day}.jsonl`), [
    row(NOW - m(45)),                                  // before the window
    row(NOW - m(20)),
    row(NOW - m(5), { creature: 'battered skeleton', room_num: 39, character: 'Scooter' }),
    JSON.stringify({ kind: 'cast', t: NOW - m(4), character: 'Loial the Ogier' }),
    '{ this line is not json',                          // a truncated write mid-append
    JSON.stringify({ kind: 'died', t: NOW - m(3), character: 'Rowlf' }),
    // The trap the savelog reader hit: a row whose TEXT contains "killed" but whose kind is not.
    JSON.stringify({ kind: 'note', t: NOW - m(2), text: 'Rowlf was just killed by a groundworm' }),
    '',
  ].join('\n'));

  const got = killsIn(NOW - m(30), NOW, { dir: DIR });
  ok('two kills inside a 30m window', got.length === 2, `got ${got.length}`);
  ok('...the older one excluded by time', !got.some(r => r.t === NOW - m(45)));
  ok('...a cast is not a kill', !got.some(r => r.kind === 'cast'));
  ok('...a death is not a kill', !got.some(r => r.kind === 'died'));
  ok('...a sentence CONTAINING "killed" is not a kill', !got.some(r => r.kind === 'note'));
  ok('...and an unparseable line does not stop the read', got.length === 2);

  const s = summarise(got, 30);
  // The savelog bug, reproduced: the field is `creature`, and reading `what` gives correct
  // totals with an empty breakdown and nothing anywhere saying so.
  ok('the breakdown is not empty', Object.keys(s.creatures).length === 2, JSON.stringify(s.creatures));
  ok('...and splits by room', s.rooms[38] === 1 && s.rooms[39] === 1);
  ok('...and by character', s.characters.Camilla === 1 && s.characters.Scooter === 1);

  const none = killsIn(NOW - m(30), NOW, { dir: join(DIR, 'nothing-here') });
  ok('a missing ledger day is empty, not a crash', none.length === 0);
}

console.log('\n7. AN UNREADABLE RECORD IS NOT AN EMPTY ONE');
{
  // The failure this guards: a corrupt record read as "no changes yet" hands back the rate limit
  // the tool exists to enforce — silently, at exactly the moment somebody is changing things.
  const f = join(DIR, 'broken.json');
  writeFileSync(f, '{ "experiments": [ ');
  let threw = null;
  try { load(f); } catch (e) { threw = e; }
  ok('a truncated record throws', !!threw);
  ok('...and says so in words that name the file', threw && threw.message.includes(f));
  ok('...rather than returning an empty record', threw && !threw.rec);

  const missing = load(join(DIR, 'not-written-yet.json'));
  ok('a record that does not exist IS empty', missing.experiments.length === 0);
  ok('...and is not mistaken for corrupt', missing.version === 1);
}

console.log('\n8. A ROUND TRIP KEEPS THE HISTORY');
{
  const f = join(DIR, 'roundtrip.json');
  const r = rec({ at: 40, change: 'first', verdict: { measured_kpm: 1.2, held: false } },
                { at: 10, change: 'second' });
  save(r, f);
  const back = load(f);
  ok('both experiments survive', back.experiments.length === 2);
  ok('the judged one keeps its verdict', back.experiments[0].verdict.measured_kpm === 1.2);
  ok('the open one is still open', openExperiment(back).change === 'second');
  ok('...and is the most recent, not the first', lastApplied(back).change === 'second');
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
