// CAN THESE CHARACTERS ACTUALLY GET TO THE ROOMS THIS ERRAND NAMES?
//
// Asked BEFORE the lock and before anything walks, per character, from where that character
// is standing right now. That is a different question from the `reachable` guarantee, which
// FleetScript already has: `reachable` asks the unified exit view whether ANYTHING arrives at
// a room, once, globally. This asks whether THIS BODY has a route from THIS ROOM — and the
// two disagree all the time, because a room the world can reach is not a room a particular
// character can reach from wherever a death or an errand left it.
//
// WHAT PROMPTED IT, 2026-09-17 — AND THIS CHECK WOULD HAVE PRINTED GREEN ON IT, which is
// worth stating plainly rather than letting the date imply otherwise. Three characters were
// assigned to room 27 and every board and every keeper status read `assigned_room: 27` for
// forty minutes while none of them moved and not one travel to 27 was issued — seventeen
// travel calls in that window, all to 38, 39 or 544. The cause was a DUM doctrine allowlist
// (`station.rooms`) that the assignment did not share, and the route 38 -> 27 exists and
// always did; no preflight here could have seen it, because FleetScript does not drive DUM.
//
// What it DOES catch is the other door into the same room: an errand that names a room THIS
// body has no planned route to from wherever it is standing. 25 of 264 rooms have nothing
// arriving in the unified exit view, and a walk to one burns three attempts and the whole
// budget before saying so. The shared lesson is the one worth carrying: an order can land
// perfectly and still be unreachable, and that failure is silent in the direction that looks
// healthy.
//
// **AN UNREACHABLE DESTINATION IS SILENT IN THE DIRECTION THAT LOOKS HEALTHY**, which is why
// this is worth a preflight rather than a runtime refusal. By the time a walk fails you have
// already taken the lock, claimed the faculties, healed a body to full and spent a budget.
//
// WARN, DO NOT REFUSE — BY DEFAULT. Same argument as `provenance`: most of the time a route
// the bake cannot plan is a gap in the bake rather than a fact about the world, and this
// repository's own axiom is that "unreachable" is a fact about a FILE and never about the
// map. A check that grounded the fleet every time the router was pessimistic would be
// switched off inside a week. So it says so loudly and runs. `warnings: 'error'` on the
// script — or `M59_FLEETSCRIPT_WARNINGS=error` — promotes every advisory to a refusal, for
// the errands where being wrong is expensive.
//
// PURE. Everything it needs is injected: the rooms, where each body is, and a `route`
// function. No broker, no map load, no fetch — so `m59-routecheck-test.mjs` can put a
// character in a room with no exits without stranding a real one.

/** How an advisory should be treated. `warn` prints and continues; `error` refuses. */
export const WARNING_MODES = Object.freeze(['warn', 'error']);

/**
 * Resolve the warning mode, most explicit first.
 *
 * The env override exists so an operator can tighten a script they did not write, without
 * editing it — the same reason `M59_FLEET` exists beside `--fleet`.
 */
export function warningMode({ script = null, env = process.env } = {}) {
  const fromEnv = String(env.M59_FLEETSCRIPT_WARNINGS ?? '').trim().toLowerCase();
  if (WARNING_MODES.includes(fromEnv)) return { mode: fromEnv, from: 'M59_FLEETSCRIPT_WARNINGS' };
  const fromScript = String(script ?? '').trim().toLowerCase();
  if (WARNING_MODES.includes(fromScript)) return { mode: fromScript, from: 'the script' };
  // AN UNRECOGNISED VALUE IS REPORTED AND NOT APPLIED, never silently dropped — docs/m59-policy.md.
  if (fromScript) return { mode: 'warn', from: 'the default',
    rejected: `warnings: ${JSON.stringify(script)} is not one of ${WARNING_MODES.join(', ')}` };
  return { mode: 'warn', from: 'the default' };
}

/**
 * Every room this errand's steps name, in order, without duplicates.
 *
 * READS THE STEPS RATHER THAN ASKING THE AUTHOR, so it costs a script nothing and cannot
 * drift from what the script actually does. `walk` and `graze` carry `to`; `harvest` and the
 * farm template carry `room`; both spellings are accepted because both are already on disk.
 */
export function roomsNamedBy(steps = []) {
  const out = [];
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || typeof s !== 'object') continue;
    for (const key of ['to', 'room', 'home']) {
      const n = Number(s[key]);
      if (Number.isFinite(n) && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

/**
 * Can each character reach each room?
 *
 * @param {object}   opts
 * @param {string[]} opts.agents   the characters this errand controls
 * @param {number[]} opts.rooms    the rooms its steps name
 * @param {object}   opts.where    agent -> room number it is standing in right now
 * @param {Function} opts.route    (from, to) -> truthy for a route, or { ok, why }
 * @returns {{ checked, problems, unknown, ok }}
 */
export function routePreflight({ agents = [], rooms = [], where = {}, route } = {}) {
  if (typeof route !== 'function') throw new Error('routePreflight needs a route(from, to) function');
  const problems = [], unknown = [];
  let checked = 0;

  for (const agent of agents) {
    const from = Number(where?.[agent]);
    // NOT KNOWING WHERE A BODY IS IS NOT EVIDENCE THAT IT IS STUCK. A character whose room
    // could not be read is reported separately and never counted as a problem: grounding an
    // errand because one status call timed out is the failure mode this check must not add.
    if (!Number.isFinite(from)) {
      unknown.push({ agent, why: 'its current room could not be read, so no route can be planned from it' });
      continue;
    }
    for (const to of rooms) {
      if (to === from) continue;          // already there; a room has no route to itself
      checked++;
      let verdict;
      try { verdict = route(from, to); }
      catch (e) { unknown.push({ agent, from, to, why: `the router threw: ${e?.message ?? e}` }); continue; }
      if (verdict === null || verdict === undefined) {
        unknown.push({ agent, from, to, why: 'the router gave no answer' });
        continue;
      }
      const ok = typeof verdict === 'object' ? verdict.ok !== false : Boolean(verdict);
      if (!ok)
        problems.push({ agent, from, to,
          why: (typeof verdict === 'object' && verdict.why) ||
               `no route from ${from} to ${to} that the mover can plan` });
    }
  }
  return { checked, problems, unknown, ok: problems.length === 0 };
}

/**
 * The lines a human reads. Kept here so the wiring in m59-fleetscript.mjs stays thin and so
 * the test can assert the sentence rather than the shape.
 */
export function formatRoutePreflight(result, { mode = 'warn', scriptName = 'this errand' } = {}) {
  const lines = [];
  if (result.problems.length) {
    const head = mode === 'error' ? 'ROUTES: REFUSING' : 'ROUTES: WARNING';
    lines.push(`${head} — ${result.problems.length} of ${result.checked} character/room ` +
               `pair(s) have no route the mover can plan:`);
    for (const p of result.problems.slice(0, 12))
      lines.push(`    ${p.agent}: ${p.from} -> ${p.to} — ${p.why}`);
    if (result.problems.length > 12)
      lines.push(`    ...and ${result.problems.length - 12} more`);
    // THE AXIOM, IN THE REFUSAL ITSELF. "Unreachable" is a fact about the bake, so the message
    // names the file to fix rather than declaring the place unreachable.
    lines.push('  "no route" is a fact about the BAKE, not about the world: a room a person can');
    lines.push('  walk to in the retail client is a room this fleet is missing an exit, a jump or');
    lines.push('  a trigger for. Re-bake with `node tools/setup.mjs routes`, or add the missing');
    lines.push('  affordance — and if you are going anyway, say so with');
    lines.push(`    unsafe: { reason: '...', waives: ['routeCheck'] }`);
    if (mode === 'warn')
      lines.push('  Running anyway (warnings are advisory). `warnings: \'error\'` on the script, or');
    if (mode === 'warn')
      lines.push('  M59_FLEETSCRIPT_WARNINGS=error, makes this refuse instead.');
  }
  if (result.unknown.length) {
    lines.push(`  ${result.unknown.length} pair(s) could not be checked — an unanswerable question`);
    lines.push('  is not a failed one, so these never refuse:');
    for (const u of result.unknown.slice(0, 6))
      lines.push(`    ${u.agent}${u.from != null ? `: ${u.from} -> ${u.to}` : ''} — ${u.why}`);
  }
  if (!lines.length && result.checked)
    lines.push(`routes: green — every one of ${result.checked} character/room pair(s) has a route`);
  return lines;
}
