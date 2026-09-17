// OFFLINE. Pins the per-character route preflight: the incident it exists for, the promotion
// of warnings to errors, and the three things it must NOT do.
//
// The case worth reading is the first: a character assigned to a room with no route from
// where it is standing. That is not hypothetical — it is 2026-09-17, three characters, forty
// minutes, seventeen travel calls and not one of them to the room every board said they were
// assigned to. The check is cheap; the failure was silent in the direction that looks healthy.
//
// No socket, no roster, no map load: the router is injected. `node tools/m59-routecheck-test.mjs`.
import { readFileSync } from 'node:fs';
import { routePreflight, roomsNamedBy, formatRoutePreflight, warningMode, WARNING_MODES }
  from './m59-routecheck.mjs';

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${what}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), `${what} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);
const section = s => console.log(`\n${s}`);

// A router that knows about a castle cluster and an isolated cave.
const EDGES = { 38: [39], 39: [38, 544], 544: [39] };     // 27 is in NOBODY's edge list
const route = (from, to) => {
  const seen = new Set([from]); const q = [from];
  while (q.length) {
    const at = q.shift();
    if (at === to) return true;
    for (const n of EDGES[at] ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); }
  }
  return false;
};

// ---------------------------------------------------------------------------------------
section('the incident: assigned to a room nothing can walk them to');
{
  const r = routePreflight({ agents: ['t3', 't8', 't9'], rooms: [27],
                             where: { t3: 38, t8: 39, t9: 39 }, route });
  eq(r.ok, false, 'the preflight is not ok');
  eq(r.problems.length, 3, 'all three characters are reported, not just the first');
  eq(r.checked, 3, 'and all three pairs were actually checked');
  eq(r.unknown.length, 0, 'nothing was unanswerable');
  ok(r.problems.every(p => p.to === 27), 'every problem names the room that cannot be reached');
  ok(/no route from 38 to 27/.test(r.problems.find(p => p.agent === 't3').why),
     'and says which leg it is');

  const lines = formatRoutePreflight(r, { mode: 'warn' }).join('\n');
  ok(/ROUTES: WARNING/.test(lines), 'in warn mode it warns');
  ok(/waives: \['routeCheck'\]/.test(lines), 'and names the waiver, because going anyway is legitimate');
  ok(/fact about the BAKE, not about the world/.test(lines),
     'and keeps the axiom: "unreachable" is a fact about a file');
  ok(/setup\.mjs routes/.test(lines), 'and names the thing to run');
  ok(/M59_FLEETSCRIPT_WARNINGS=error/.test(lines), 'and says how to make it refuse');
  ok(/ROUTES: REFUSING/.test(formatRoutePreflight(r, { mode: 'error' }).join('\n')),
     'in error mode the heading changes');
}

// ---------------------------------------------------------------------------------------
section('a reachable room is green and silent');
{
  const r = routePreflight({ agents: ['t3', 't8'], rooms: [544],
                             where: { t3: 38, t8: 39 }, route });
  eq(r.ok, true, 'both can reach 544');
  eq(r.problems.length, 0, 'so there are no problems');
  ok(/routes: green/.test(formatRoutePreflight(r, {}).join('\n')), 'and it says green');
}

// ---------------------------------------------------------------------------------------
section('the three things it must not do');
{
  // 1. A BODY ALREADY IN THE ROOM IS NOT A FAILED ROUTE. A room has no route to itself, so a
  //    naive check flags exactly the characters that have already arrived.
  const here = routePreflight({ agents: ['t8'], rooms: [39], where: { t8: 39 }, route });
  eq(here.problems.length, 0, 'a character standing in the room is not a problem');
  eq(here.checked, 0, 'and the pair is not even checked — there is nothing to plan');

  // 2. AN UNREADABLE POSITION IS NOT EVIDENCE OF BEING STUCK. One timed-out status call must
  //    not ground an errand.
  const blind = routePreflight({ agents: ['t3', 't8'], rooms: [544],
                                 where: { t8: 39 }, route });
  eq(blind.problems.length, 0, 'an unknown position produces no problem');
  eq(blind.unknown.length, 1, 'it is reported separately');
  eq(blind.ok, true, 'and the preflight still passes');
  ok(/current room could not be read/.test(blind.unknown[0].why), 'saying why');

  // 3. A ROUTER THAT THROWS IS A QUESTION, NOT AN ANSWER.
  const angry = routePreflight({ agents: ['t3'], rooms: [39], where: { t3: 38 },
                                 route: () => { throw new Error('bake is missing'); } });
  eq(angry.problems.length, 0, 'a throwing router produces no problem');
  eq(angry.unknown.length, 1, 'only an unknown');
  ok(/the router threw: bake is missing/.test(angry.unknown[0].why), 'and it carries the message');

  const mute = routePreflight({ agents: ['t3'], rooms: [39], where: { t3: 38 }, route: () => null });
  eq(mute.unknown.length, 1, 'a router that answers null is also a question');
  eq(mute.problems.length, 0, 'never a problem');
}

// ---------------------------------------------------------------------------------------
section('a router may answer with a reason');
{
  const r = routePreflight({ agents: ['t3'], rooms: [27], where: { t3: 38 },
                             route: () => ({ ok: false, why: 'the north door is a jump nobody declared' }) });
  eq(r.problems.length, 1, 'an { ok: false } verdict is a problem');
  eq(r.problems[0].why, 'the north door is a jump nobody declared', "and the router's own reason survives");
  eq(routePreflight({ agents: ['t3'], rooms: [39], where: { t3: 38 },
                      route: () => ({ ok: true }) }).problems.length, 0, 'and { ok: true } is fine');
}

// ---------------------------------------------------------------------------------------
section('the rooms come from the steps, so a script declares nothing');
{
  const steps = [{ do: 'walk', to: 27 }, { do: 'verify' }, { do: 'harvest', room: 27, quarry: 'orc' },
                 { do: 'walk', to: 39 }, { do: 'graze', to: 544 }, { do: 'sell', home: 70 }];
  const rooms = roomsNamedBy(steps);
  ok(rooms.includes(27), 'a walk `to` is read');
  ok(rooms.includes(27) && rooms.filter(r => r === 27).length === 1, 'and de-duplicated');
  ok(rooms.includes(39) && rooms.includes(544), 'walk and graze both count');
  ok(rooms.includes(70), '`home` counts too — the trip back is a journey like any other');
  eq(roomsNamedBy([{ do: 'verify' }]).length, 0, 'a step with no room names none');
  eq(roomsNamedBy(null).length, 0, 'and a missing step list is not an exception');
  // `harvest` carries `room`, which is the farm template's spelling — the reason this reads
  // both is that both are already on disk.
  eq(roomsNamedBy([{ do: 'harvest', room: 27 }])[0], 27, 'a harvest `room` is read');
}

// ---------------------------------------------------------------------------------------
section('warn by default, and an operator can tighten a script they did not write');
{
  eq(warningMode({ script: null, env: {} }).mode, 'warn', 'the default is warn');
  eq(warningMode({ script: 'error', env: {} }).mode, 'error', 'a script may ask for error');
  eq(warningMode({ script: 'error', env: {} }).from, 'the script', 'and it says where that came from');
  eq(warningMode({ script: null, env: { M59_FLEETSCRIPT_WARNINGS: 'error' } }).mode, 'error',
     'the environment can promote it');
  eq(warningMode({ script: 'warn', env: { M59_FLEETSCRIPT_WARNINGS: 'error' } }).mode, 'error',
     'and the environment beats the script, so an operator can tighten one they did not write');
  eq(warningMode({ script: null, env: { M59_FLEETSCRIPT_WARNINGS: 'error' } }).from,
     'M59_FLEETSCRIPT_WARNINGS', 'naming the source, so a surprising refusal can be traced');
  // AN UNRECOGNISED VALUE IS REPORTED AND NOT APPLIED — docs/m59-policy.md. Silently treating
  // `warnings: 'strict'` as the default is how a setting that does nothing survives for a year.
  const bad = warningMode({ script: 'strict', env: {} });
  eq(bad.mode, 'warn', 'an unrecognised mode keeps the default');
  ok(/not one of/.test(bad.rejected ?? ''), 'and is reported rather than dropped');
  eq(warningMode({ script: null, env: { M59_FLEETSCRIPT_WARNINGS: 'loud' } }).mode, 'warn',
     'an unrecognised env value is ignored too');
  eq(WARNING_MODES.length, 2, 'there are exactly two modes');
}

// ---------------------------------------------------------------------------------------
section('the guarantee is declared, waivable, and wired into the preflight');
{
  const fs = readFileSync(new URL('./m59-fleetscript.mjs', import.meta.url), 'utf8');
  ok(/routeCheck: \{/.test(fs), 'routeCheck is in UNSAFE_GUARANTEES');
  ok(/since: '2026-09-17'/.test(fs), 'with the date it was bought');
  ok(/seventeen travel calls in that window/.test(fs), 'and the incident that bought it');
  ok(/if \(!waived\.has\('routeCheck'\)\)/.test(fs), 'and it is waivable by name');
  ok(/warningMode\(\{ script: warnings \}\)/.test(fs), 'the script option is read');
  ok(/plan on the map the mover enforces/i.test(fs), 'and it plans on the mover\'s own map');
  // THE PREDICATE THAT COULD NOT FAIL. `findPath` answers `{ found, hops, reason }` and is
  // ALWAYS truthy, so the first version — `p && p.length > 0` — was true for every pair in
  // the game, including 38 -> 999 where 999 is not a room. Same shape as
  // `Boolean({ok:false})` passing a read-it-back guarantee. Pinned as source text because
  // the bug is in the WIRING, which no amount of testing the pure function would have caught.
  ok(/p\?\.found === true/.test(fs), "the wiring reads findPath's `found`, not its truthiness");
  ok(!/p && \(Array\.isArray\(p\)/.test(fs), 'and the vacuous truthiness test is gone');
  ok(/why: p\?\.reason/.test(fs), "and the router's own reason is passed through");

  // It must run BEFORE the lock: an errand that could never arrive should not take one.
  ok(fs.indexOf("waived.has('routeCheck')") < fs.indexOf('takeRunLock'),
     'and it runs before the run lock is taken');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
