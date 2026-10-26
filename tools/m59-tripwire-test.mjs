#!/usr/bin/env node
// TRIPWIRES (tools/m59-tripwire.mjs). Offline: opens no socket, joins nobody.
//
// What it pins: nothing is armed unless a fleet file says so; a stale `who` never counts as quiet; a tripwire
// never takes off a posture it did not put on; two tripwires on one posture release on the last; an unknown
// trigger is refused at load rather than ignored.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTripwire, evaluate, step, freshFor, mayRelease, needsOf, readAssignment, watch } from './m59-tripwire.mjs';
import example from '../substrate/tripwires.example/example-enemy-online.mjs';

let passed = 0, failed = 0;
const ok = (what, cond) => { if (cond) { passed++; console.log('  ok  ', what); } else { failed++; console.log('  FAIL', what); } };
const section = t => console.log(`\n${t}`);
const T0 = 1_800_000_000_000, MIN = 60_000;
const who = (names, refreshed = true) => ({ players: names.map(name => ({ name })), refreshed, by: 't1' });

section('off by default');
{
  const dir = mkdtempSync(join(tmpdir(), 'tripwire-'));
  process.env.M59_TRIPWIRE_ASSIGN = join(dir, 'missing.json');
  ok('no fleet file: nothing enabled', readAssignment('prod').enabled.length === 0 && !readAssignment('prod').present);
  const lines = []; const log = console.log; console.log = l => lines.push(String(l));
  await watch({ fleet: 'prod', once: true }); console.log = log;
  ok('watch with nothing armed says so and returns without asking the broker anything', lines.some(l => /nothing armed/.test(l) && /off by default/.test(l)));
  writeFileSync(join(dir, 'bad.json'), '{ not json');
  process.env.M59_TRIPWIRE_ASSIGN = join(dir, 'bad.json');
  const a = readAssignment('prod');
  ok('a fleet file that does not parse arms nothing and says why', a.enabled.length === 0 && /does not parse/.test(a.error));
  delete process.env.M59_TRIPWIRE_ASSIGN;
}

section('loading');
ok('the example is valid', checkTripwire(example).length === 0);
ok('an unknown trigger is refused, not ignored', checkTripwire({ name: 'x', when: [{ who_offline: ['A'] }], then: { posture: 'p' } }).some(e => /unknown trigger/.test(e)));
ok('two triggers in one clause are refused', checkTripwire({ name: 'x', when: [{ who_online: ['A'], war_alarm: {} }], then: { posture: 'p' } }).some(e => /one trigger per clause/.test(e)));
ok('no posture is refused', checkTripwire({ name: 'x', when: [{ who_online: ['A'] }], then: {} }).some(e => /posture/.test(e)));
ok('who_online with no names is refused', checkTripwire({ name: 'x', when: [{ who_online: [] }], then: { posture: 'p' } }).length === 1);
ok('the example reads who and alarms', [...needsOf(example)].sort().join() === 'alarms,who');

section('triggers');
ok('who_online: exact name, case and spacing folded', evaluate(example, { now: T0, who: who(['example   ENEMY']), alarms: [] }).length === 1);
ok('who_online: a name that merely contains it does not trip', evaluate(example, { now: T0, who: who(['Example Enemy2']), alarms: [] }).length === 0);
ok('war_alarm: fresh alarm about the named enemy trips', evaluate(example, { now: T0, who: who([]), alarms: [{ at: T0 - 5000, enemy: 'Example Enemy', room: 38 }] })[0]?.room === 38);
ok('war_alarm: an alarm older than within_ms does not', evaluate(example, { now: T0, who: who([]), alarms: [{ at: T0 - 2 * MIN, enemy: 'Example Enemy', room: 38 }] }).length === 0);
const deaths = { name: 'd', when: [{ pvp_death: { count: 2, within_ms: 10 * MIN, killers: ['Morph'] } }], then: { posture: 'p' } };
ok('pvp_death: below count does not trip', evaluate(deaths, { now: T0, pvp_deaths: [{ agent: 't1', died_at: T0 - MIN, killers: ['Morph'] }] }).length === 0);
ok('pvp_death: count reached trips', evaluate(deaths, { now: T0, pvp_deaths: [{ agent: 't1', died_at: T0 - MIN, killers: ['Morph'] }, { agent: 't2', died_at: T0 - 2 * MIN, killers: ['morph'] }] }).length === 2);
ok('pvp_death: other killers do not count', evaluate(deaths, { now: T0, pvp_deaths: [{ agent: 't1', died_at: T0, killers: ['X'] }, { agent: 't2', died_at: T0, killers: ['Y'] }] }).length === 0);
const fn = { name: 'f', when: [obs => obs.who?.players?.length > 2 ? 'crowded' : null, () => { throw new Error('boom'); }], then: { posture: 'p' } };
ok('a function clause trips by returning a reason', evaluate(fn, { now: T0, who: who(['a', 'b', 'c']) })[0]?.detail === 'crowded');
ok('a function clause that throws is not a hit', evaluate(fn, { now: T0, who: who(['a']) }).length === 0);

section('the cycle: trip, stale, quiet, stand down, rearm');
{
  let s = {}, r;
  r = step(example, s, { who: who(['Bystander']), alarms: [] }, T0);
  ok('nobody named: nothing', r.action === null);
  r = step(example, s, { who: who(['Example Enemy']), alarms: [] }, T0);
  ok('named enemy in a fresh who: fire', r.action === 'fire' && /Example Enemy/.test(r.why));
  s = { active: true, owned: true, fired_at: T0 };
  r = step(example, s, { who: who([]), alarms: [] }, T0 + MIN); s = r.state;
  ok('gone from a fresh who: the quiet clock starts', s.quiet_since === T0 + MIN && r.action === null);
  r = step(example, s, { who: who([], false), alarms: [] }, T0 + 5 * MIN); s = r.state;
  ok('a STALE who resets the quiet clock rather than advancing it', s.quiet_since === null && /not fresh/.test(r.why));
  r = step(example, s, { who: null, alarms: [] }, T0 + 6 * MIN); s = r.state;
  ok('no who at all is not quiet either', s.quiet_since === null);
  ok('freshFor: alarms alone do not make a who-tripwire fresh', !freshFor(example, { who: null, alarms: [] }));
  r = step(example, s, { who: who([]), alarms: [] }, T0 + 7 * MIN); s = r.state;
  r = step(example, s, { who: who([]), alarms: [] }, T0 + 21 * MIN);
  ok('14 min of fresh quiet: not yet', r.action === null);
  r = step(example, s, { who: who([]), alarms: [] }, T0 + 22 * MIN);
  ok('15 min of fresh quiet: release', r.action === 'release');
  r = step(example, r.state, { who: who(['Example Enemy']), alarms: [] }, T0 + 22 * MIN);
  ok('back before the stand-down: still tripped, quiet reset', r.action === null && r.state.quiet_since === null);
  const after = { active: false, released_at: T0 };
  ok('just stood down: rearming, does not fire', step(example, after, { who: who(['Example Enemy']), alarms: [] }, T0 + MIN).why === 'rearming');
  ok('after rearm_ms it can fire again', step(example, after, { who: who(['Example Enemy']), alarms: [] }, T0 + 6 * MIN).action === 'fire');
  ok('quiet_ms null never stands down by itself', step({ ...example, quiet_ms: null }, { active: true, owned: true, quiet_since: T0 }, { who: who([]), alarms: [] }, T0 + 600 * MIN).action === null);
  ok('a failed trip waits for its retry', step(example, { active: false, retry_at: T0 + MIN }, { who: who(['Example Enemy']), alarms: [] }, T0).action === null);
}

section('releasing only what it put on');
{
  const tw = { a: { then: { posture: 'lock' } }, b: { then: { posture: 'lock' } }, c: { then: { posture: 'other' } } };
  ok('owned and alone: may release', mayRelease('a', { a: { active: true, owned: true } }, tw).ok);
  ok('the posture was on before it tripped: may not', !mayRelease('a', { a: { active: true, owned: false } }, tw).ok);
  ok('another tripwire still holds the same posture: may not', /b still holds lock/.test(mayRelease('a', { a: { active: true, owned: true }, b: { active: true } }, tw).why));
  ok('another tripwire on a different posture does not matter', mayRelease('a', { a: { active: true, owned: true }, c: { active: true } }, tw).ok);
}

section('a dry watch: observes through the broker, pushes nothing');
{
  const dir = mkdtempSync(join(tmpdir(), 'tripwire-'));
  writeFileSync(join(dir, 'assign.json'), JSON.stringify({ enabled: ['example-enemy-online'] }));
  Object.assign(process.env, { M59_TRIPWIRE_ASSIGN: join(dir, 'assign.json'), M59_TRIPWIRE_STATE: join(dir, 'state'), M59_POSTURE_SAVES: join(dir, 'saves'), M59_WAR_ALARM_FILE: join(dir, 'alarms.jsonl') });
  const calls = [];
  const call = async (name, args) => {
    calls.push(name);
    if (name === 'fleet') return { fleet: [{ agent: 't1', piloted: true }, { agent: 't2', host: true }, { agent: 't3' }] };
    if (name === 'who') return { players: [{ name: 'Example Enemy' }], here: [], refreshed: true, asked: args.agent };
    throw new Error(`a dry watch called ${name}`);
  };
  const lines = []; const log = console.log; console.log = l => lines.push(String(l));
  const st = await watch({ fleet: 'prod', dry: true, once: true, call }); console.log = log;
  ok('a dry watch trips in memory', st['example-enemy-online']?.active === true && st['example-enemy-online'].dry);
  ok('and says what it would do', lines.some(l => /would_fire/.test(l) && /example-stay-put/.test(l)));
  ok('who was asked of the unpiloted, non-host character', st['example-enemy-online'].last_observation?.by === 't3');
  ok('it only read the fleet and who -- no autopilot, no job_pause', calls.every(c => c === 'fleet' || c === 'who'));
  for (const k of ['M59_TRIPWIRE_ASSIGN', 'M59_TRIPWIRE_STATE', 'M59_POSTURE_SAVES', 'M59_WAR_ALARM_FILE']) delete process.env[k];
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
