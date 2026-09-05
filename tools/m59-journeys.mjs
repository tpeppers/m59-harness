#!/usr/bin/env node
// EVERY JOURNEY, INCLUDING THE ONES THAT ENDED BADLY.
//
//   node tools/m59-journeys.mjs              # survivors against casualties, by route
//   node tools/m59-journeys.mjs --route 39,953
//   node tools/m59-journeys.mjs --hours 6 --json
//
// WHY THIS EXISTS. The operator's reading of the deaths, 2026-09-05: "they died trying to run
// through walls going to the wrong destinations. Other bots that survived picked the right
// destinations." That is a comparison, and nothing here could make it — because the two halves
// of it were recorded by different machinery with opposite biases:
//
//   * postmortems are written ONLY FOR THE DEAD. Rich — frames, decisions, hits — and a
//     sample of exactly one outcome, so nothing in them can say what the survivors did.
//   * m59-tripbook records walks THAT WORKED, for replay. Survivor-biased by design, and it
//     keeps no failures at all.
//
// So the fleet had a detailed account of every death and a clean library of every success and
// no way to put one beside the other. This is the row that both halves share.
//
// AND THE FIELD THE HYPOTHESIS TURNS ON WAS NOT BEING RECORDED ANYWHERE. A keeper frame says
// `doing: "travelling"` and never says travelling TO WHAT, so even a postmortem cannot answer
// "where did this character think it was going" — the question the operator is actually
// asking. `to` and `to_name` are the first two fields here for that reason.
//
// ONE ROW PER JOURNEY, WRITTEN WHEN IT ENDS, however it ends. Arrived, gave up, cancelled,
// or died on the road: the outcome is a field rather than a reason to skip the row.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readLedger } from './m59-ledger.mjs';
import { fleetName, ledgerDirFor } from './m59-fleetpath.mjs';

/**
 * Every journey the fleet finished in the window, newest last.
 *
 * IT READS THE LEDGER THAT ALREADY EXISTS. `travel_journey` has been written once per journey
 * for a long time — the row that exists so "deaths per journey" has a denominator. It was
 * missing three things a comparison needs, and those are now on it rather than in a second
 * file: `from` (a destination is not a route), `ended_in` (asked for 953, ended in 950), and
 * `arrived`/`reason` (a denominator you cannot split by outcome is a count of attempts).
 *
 * A second ledger would have been the easy thing and the wrong one: two records of the same
 * journey disagree eventually, and then neither can be trusted.
 */
export function readJourneys({ sinceMs = 24 * 3600 * 1000 } = {}) {
  const { events } = readLedger({ sinceMs });
  return events
    .filter(e => e.kind === 'travel_journey')
    .sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}

/**
 * The comparison: for each route, what the arrivals did and what the failures did.
 *
 * GROUPED BY ROUTE, NOT BY CHARACTER, because "this character dies a lot" and "this road
 * loses people" are different findings and only the second one is fixable. A character with
 * bad luck shows up spread across every route; a bad road shows up in one row.
 */
export function compareJourneys(rows = []) {
  const byRoute = new Map();
  for (const r of rows) {
    const key = `${r.from ?? '?'}>${r.to ?? '?'}`;
    if (!byRoute.has(key)) byRoute.set(key, { route: key, ok: [], bad: [], unknown: [] });
    // UNKNOWN IS NOT FAILED, and getting this wrong makes the tool lie about its own history.
    // `arrived` was added to this row on 2026-09-05; every journey written before that has no
    // opinion about whether it worked. Treating absent as false reported a 0% arrival rate
    // across 14,367 real journeys, most of which plainly arrived. Same rule as everywhere
    // else here: a model that cannot say must say so.
    const bucket = r.arrived === true ? 'ok' : r.arrived === false ? 'bad' : 'unknown';
    byRoute.get(key)[bucket].push(r);
  }
  const avg = (xs, f) => {
    const v = xs.map(f).filter(Number.isFinite);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const hpLost = r => (Number.isFinite(r.hp_start) && Number.isFinite(r.hp_end))
    ? r.hp_start - r.hp_end : null;
  return [...byRoute.values()].map(g => {
    const n = g.ok.length + g.bad.length + g.unknown.length;
    // WHERE THE FAILURES STOPPED. If they all stop in the same room, and it is not the room
    // they asked for, that is the finding — it is the exact shape "went to the wrong
    // destination" leaves behind.
    const stops = {};
    for (const f of g.bad) stops[String(f.ended_in ?? '?')] = (stops[String(f.ended_in ?? '?')] || 0) + 1;
    const reasons = {};
    for (const f of g.bad) if (f.reason) reasons[String(f.reason).slice(0, 44)] =
      (reasons[String(f.reason).slice(0, 44)] || 0) + 1;
    // WHO CANCELLED IT. `reason` names the mechanism ("cancelled by a newer command") and
    // this names the caller, which is the difference between knowing a journey was
    // interrupted and knowing what to go and change.
    const by = {};
    for (const f of g.bad) if (f.cancelled_by) by[String(f.cancelled_by).slice(0, 50)] =
      (by[String(f.cancelled_by).slice(0, 50)] || 0) + 1;
    return {
      route: g.route, n, arrived: g.ok.length, failed: g.bad.length,
      unknown: g.unknown.length,
      // Out of the ones that can answer. A route with nothing but pre-field rows reports
      // null rather than zero.
      rate: (g.ok.length + g.bad.length) ? g.ok.length / (g.ok.length + g.bad.length) : null,
      ms_ok: avg(g.ok, r => r.ms), ms_bad: avg(g.bad, r => r.ms),
      legs_ok: avg(g.ok, r => r.legs), legs_bad: avg(g.bad, r => r.legs),
      planned_ok: avg(g.ok, r => r.planned_legs), planned_bad: avg(g.bad, r => r.planned_legs),
      hp_ok: avg(g.ok, hpLost), hp_bad: avg(g.bad, hpLost),
      stops_ok: avg(g.ok, r => r.shelter_stops), stops_bad: avg(g.bad, r => r.shelter_stops),
      stopped_in: Object.entries(stops).sort((a, b) => b[1] - a[1]).slice(0, 4),
      reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3),
      cancelled_by: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 3),
    };
  }).filter(g => g.arrived + g.failed > 0 || g.unknown > 0)
    .sort((a, b) => (b.failed - a.failed) || (b.n - a.n));
}

// ---------------------------------------------------------------------------- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  // Top-level await: this block asks a running broker where its ledger is.
  const argv = process.argv.slice(2);
  const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
  const hours = Number(arg('hours', 24)) || 24;
  const all = readJourneys({ sinceMs: hours * 3600 * 1000 });
  const route = arg('route');
  const rows = route ? all.filter(r => `${r.from}>${r.to}` === route.replace(/[, ]+/g, '>')) : all;

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ hours, journeys: rows.length, routes: compareJourneys(rows) }, null, 2));
    process.exit(0);
  }
  // SAY WHICH LEDGER THIS IS, ALWAYS. There is more than one checkout of this repository on
  // a machine that runs fleets, and reading the wrong one is THE mistake here — it is why
  // m59-which.mjs exists and exits non-zero. A reporting tool that answers "nothing" without
  // naming what it looked in is the same failure wearing a friendlier face: the operator ran
  // this from a checkout whose substrate has no prod ledger, got a confident empty result,
  // and the two explanations it offered were both wrong.
  const fleet = fleetName();
  const dir = ledgerDirFor(fleet);
  const where = `fleet ${fleet ?? '(unnamed)'} · ${dir}`;

  if (!rows.length) {
    console.log(`\nno journeys recorded in the last ${hours}h.`);
    console.log(`  looked in: ${where}`);
    console.log(`  that directory ${existsSync(dir) ? 'exists and holds no matching rows' : 'DOES NOT EXIST'}.`);
    // The likeliest cause first, and it is checkable rather than a guess: if a broker is
    // answering and its root is somewhere else, this is the wrong checkout and the command
    // to run is the same one over there.
    try {
      const health = await fetch('http://127.0.0.1:8901/health', { signal: AbortSignal.timeout(3000) })
        .then(r => r.json());
      const root = health?.root ?? health?.checkout ?? null;
      if (root && !dir.startsWith(String(root))) {
        console.log('');
        console.log(`  A BROKER IS RUNNING AND ITS LEDGER IS SOMEWHERE ELSE. It holds ` +
                    `"${health.fleet ?? '?'}" from:`);
        console.log(`      ${root}`);
        console.log('  This is almost certainly the wrong checkout. Run it there:');
        // Joined with the platform's own separator: a path that mixes them is a path
        // somebody has to fix before they can paste it.
        console.log(`      node "${path.join(String(root), 'tools', 'm59-journeys.mjs')}" ` +
                    `--hours ${hours}`);
      } else if (health?.fleet && String(health.fleet) !== String(fleet)) {
        console.log('');
        console.log(`  The running broker holds "${health.fleet}" and this checkout reads ` +
                    `"${fleet ?? '(unnamed)'}" — different fleets keep different ledgers.`);
      }
    } catch { /* no broker to ask; the directory line above is still the answer */ }
    console.log('');
    console.log('  Otherwise: `travel_journey` is written as each journey ENDS, so an empty');
    console.log('  result means nothing has finished a journey yet, or the keepers predate');
    console.log('  the code that writes the row.\n');
    process.exit(0);
  }

  const pad = v => (v == null ? '   -' : String(v).padStart(4));
  console.log(`\n${rows.length} journey(s) in the last ${hours}h — arrivals first, failures second`);
  console.log(`${where}\n`);
  console.log('route        arrived/n  rate    ms         legs      hp lost   stops');
  console.log('-'.repeat(76));
  for (const r of compareJourneys(rows)) {
    console.log(
      `${r.route.padEnd(12)} ${String(r.arrived).padStart(3)}/${String(r.n).padEnd(4)} ` +
      `${r.rate == null ? '  - ' : (r.rate * 100).toFixed(0).padStart(3) + '%'}  ` +
      `${pad(r.ms_ok)}/${pad(r.ms_bad)} ${pad(r.legs_ok)}/${pad(r.legs_bad)} ` +
      `${pad(r.hp_ok)}/${pad(r.hp_bad)} ${pad(r.stops_ok)}/${pad(r.stops_bad)}`);
    if (r.unknown)
      console.log(`             ${r.unknown} row(s) predate the outcome field and are not counted`);
    if (r.stopped_in.length)
      console.log(`             failures stopped in: ` +
        r.stopped_in.map(([room, n]) => `${room} x${n}`).join(', ') +
        `  (asked for ${r.route.split('>')[1]})`);
    for (const [why, n] of r.reasons) console.log(`             x${n}  ${why}`);
    for (const [who, n] of r.cancelled_by)
      console.log(`             x${n}  cancelled by: ${who}`);
  }
  console.log('\nA route where the two columns differ is one where they were not making the same');
  console.log('trip. `failures stopped in` is the column the wrong-destination theory lives in:');
  console.log('if the casualties all stop in one room that is not the one they asked for, that');
  console.log('room is the finding.\n');
}
