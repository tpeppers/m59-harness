#!/usr/bin/env node
// WALK THE FLEET'S REAL ITINERARY AND TIME IT, WITH THE COLLISION ROUTING ON.
//
//   node tools/m59-circuit.mjs --route tos-jasper --bots Alpha,Bravo
//   node tools/m59-circuit.mjs --route grand --laps 2 --bots all
//   node tools/m59-circuit.mjs --list                 the named routes
//   node tools/m59-circuit.mjs --book                 what previous runs measured
//
// THE QUESTION IS WHETHER COLLISION-AWARE ROUTING IS SAFE TO PUT BACK ON THE FLEET, and
// it has three parts, none of which the fleet board can answer:
//
//   time     does the same journey take materially longer than it used to?
//   arrival  does it still get there, or does it stall somewhere?
//   damage   does it get hit more on the way — either by being slower, or by being
//            stuck somewhere with something chewing on it?
//
// THE BASELINE IS COMPROMISED AND THIS SAYS SO ON EVERY RUN. `travel_estimate` reads
// recorded per-edge times, and 85.1% of that history was recorded BEFORE collision
// routing landed (2026-08-16 18:25) — by bots that were cutting corners through geometry
// no real client can cross. So the "old speed" is optimistic by an unknown amount, and a
// measured slowdown against it is an UPPER BOUND on the real regression rather than an
// estimate of it. Reported as a range, never as a single number.
//
// ATTACKS ARE COUNTED AS SWINGS, NOT DAMAGE. A swing is deterministic evidence that
// something reached us; damage is a second roll bounded to [10,95]%. Counting swings off the
// flight recorder gives many more events per journey and cannot be erased by healing. Same
// rule as m59-provewall — and, since 2026-09-20, the same PARSER: this file used to carry a
// copy of that tool's regex, which matched only `You dodge the ...'s attack.` and therefore
// counted incoming blows that MISSED while dropping every one that LANDED. Both now read
// fights through tools/m59-combatlog.mjs, which covers all four of battler.kod's templates.
//
// IT NEVER TOUCHES PROD. The broker port defaults to the arena's 8961 and every verb
// here is addressed to a named agent; there is no fleet-wide anything.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOK = HERE + '/../substrate/circuit-runs.json';
const load = () => { try { return JSON.parse(readFileSync(BOOK, 'utf8')); } catch { return { runs: [] }; } };
const save = b => { mkdirSync(dirname(BOOK), { recursive: true }); writeFileSync(BOOK, JSON.stringify(b, null, 1)); };

const PORT = Number(process.env.M59_BROKER_PORT || 8961);
const AGENTS = { TESTER: 't0', Alpha: 'arena1', Bravo: 'arena2', Charlie: 'arena3',
                 Delta: 'arena4', Echo: 'arena5' };
export const agentFor = n => AGENTS[n] ?? n;

// The itineraries the fleet actually walks, named so a run is repeatable and comparable.
export const ROUTES = {
  'tos-jasper':   { legs: [350], from: 50,  why: 'the one the operator asked for: Streets of Tos to East Jasper' },
  'jasper-tos':   { legs: [50],  from: 350, why: 'the return, which takes the same rooms reversed' },
  'bank-run':     { legs: [376, 50], from: 50, why: 'Tos out to the Royal Bank of Jasper and home' },
  'castle-sell':  { legs: [38, 101, 54], from: 50,
                    why: 'Castle Victoria, then Barloque to sell, then the Tos bank' },
  'grand':        { legs: [38, 350, 101, 50], from: 50,
                    why: 'Tos -> Castle Victoria -> Jasper -> Barloque -> Tos, the full lap' },
  // THE OPERATOR'S CYCLE, and the reason it is not `grand` with one room swapped: it is the
  // only named route that crosses Ukgoth (599) TWICE, once in each direction, because both
  // 50 -> 38 and 38 -> 150 route through it. Ukgoth is where the collision view is most
  // permissive in the wrong direction (m59-clipsweep.mjs) and the only room in the world
  // with a declared fall-jump (substrate/m59-falljumps.json), so a lap that does not go
  // through it twice is not testing the thing that has been breaking.
  'cor-noth-lap': { legs: [38, 150, 101, 50], from: 50,
                    why: 'Tos -> Castle Victoria -> Cor Noth -> Barloque -> Tos, both ways through Ukgoth' },
};

// ONE REQUEST, ONE SOCKET, CLOSED WHEN IT IS DONE — and this is not a style preference,
// it is what stops this tool crashing on the way out.
//
// This used `fetch`, which pools keep-alive sockets on undici's global agent and leaves an
// un-cancelled `AbortSignal.timeout` timer behind. `process.exit()` then tears those down
// mid-close and Node aborts:
//
//     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
//
// ...with exit 127, AFTER the run has printed perfectly correct output. Measured on this
// machine at a sharp, deterministic threshold — THREE or more connections still pooled at
// exit fails 60 times out of 60, two or fewer never fails:
//
//     0 live -> 0/15    1 live -> 0/15    2 live -> 0/15    3 live -> 15/15
//
// Which is exactly the shape this file runs in. `probe()` below issues TWO calls at once,
// and the lap loop wraps that in `Promise.all(bots.map(...))` — so any run with two or
// more bots is over the line, and every `process.exit()` in this file was a coin flip on
// whether the exit code meant anything. Found first in `m59-which.mjs`, whose entire
// contract is its exit code; the same pattern is here and in `m59-hoptest.mjs`, which
// imports this function.
//
// `agent: false` with `connection: close` leaves no pooled socket and needs no abort
// timer, so there is nothing in a closing state when the process ends. That is what makes
// the plain `process.exit()` calls further down safe, and it is the probe
// `m59-fleets.mjs` already documents for the same reason.
//
// ONE DIFFERENCE WORTH KNOWING: `timeout` here is a socket INACTIVITY timeout, where
// `AbortSignal.timeout` was a total deadline. For this caller they coincide — the broker
// sends nothing at all until the tool call finishes — but a future endpoint that streams
// progress would keep the socket alive past `timeoutMs` rather than being cut off at it.
function postJson(port, payload, timeoutMs) {
  return new Promise((done) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/', method: 'POST',
      headers: { 'content-type': 'application/json',
                 'content-length': Buffer.byteLength(body),
                 connection: 'close' },
      agent: false, timeout: timeoutMs,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => done({ status: res.statusCode, text }));
    });
    req.on('timeout', () => { req.destroy(); done({ error: `no reply within ${timeoutMs}ms` }); });
    req.on('error', e => done({ error: e.message }));
    req.end(body);
  });
}

export async function broker(name, args, { timeoutMs = 300000 } = {}) {
  {
    const r = await postJson(PORT, { jsonrpc: '2.0', id: 1, method: 'tools/call',
                                     params: { name, arguments: args } }, timeoutMs);
    // Every failure comes back as `{_error}` and nothing throws — `m59-hoptest.mjs`
    // imports this and turns `_error` into a failed leg, so a rejection here would be a
    // crash in a caller that has no catch.
    if (r.error) return { _error: r.error };
    if (r.status < 200 || r.status >= 300) return { _error: `broker ${r.status}` };
    let j;
    try { j = JSON.parse(r.text); }
    catch { return { _error: `broker sent non-JSON: ${String(r.text).slice(0, 200)}` }; }
    if (j.error) return { _error: j.error.message };
    const text = j.result?.content?.[0]?.text ?? '{}';
    // A REFUSAL COMES BACK AS PROSE, NOT AS JSON, and parsing it blindly turns a perfectly
    // clear message into a syntax error. `{"isError": true}` with a body of
    // `error: arena1 is busy: walk to Lake of Jala's Song` is the broker telling us
    // exactly what is wrong; the first version of this function reported it as
    // `Unexpected token 'e'` and lost the sentence entirely.
    if (j.result?.isError) return { _error: String(text).replace(/^error:\s*/, '') };
    try { return JSON.parse(text); }
    catch { return { _error: String(text).slice(0, 200) }; }
  }
}

import { isEnemySwing } from './m59-combatlog.mjs';
export const isIncomingSwing = t => isEnemySwing(t);

/** Where a character is, and how much it has been swung at since `mark`. */
export async function probe(agent, mark = 0) {
  const [st, rec] = await Promise.all([
    broker('status', { agent }, { timeoutMs: 30000 }),
    broker('recording', { agent, action: 'tail', limit: 400 }, { timeoutMs: 30000 }),
  ]);
  const tail = Array.isArray(rec?.tail) ? rec.tail : [];
  const fresh = tail.filter(e => (e.seq ?? 0) > mark);
  const swings = fresh.filter(e => e.kind === 'message' && isIncomingSwing(e.text)).length;
  const seq = tail.length ? Math.max(...tail.map(e => e.seq ?? 0)) : mark;
  const w = st?.where ?? {};
  return { room: w.num ?? null, name: w.name ?? null, busy: !!st?.busy,
           // WHAT THE KEEPER SAYS ABOUT ITSELF, rather than what this end infers from a
           // missing field. See the give-up rule below for why `busy` cannot carry it.
           stuck: st?.stuck ?? null,
           health: st?.vitals?.health?.value ?? null, max: st?.vitals?.health?.max ?? null,
           swings, seq, last: st?.last_action ?? null, error: st?._error ?? null };
}

// IS THIS PROBE LOOKING AT A DEAD CHARACTER.
//
// By NAME first, with the number as the fallback, which is how `passUnderworld` asks the
// same question — the room the game names "The Underworld" is what a death puts you in,
// and matching the string survives a server whose room numbering is not this one's.
// Room 1 is kept because a probe that timed out mid-name still carries the number.
export const isDead = p =>
  /underworld/i.test(p?.name ?? '') || p?.room === 1 ||
  (p?.health != null && p.health <= 0);

/**
 * One leg: send a character to a room and watch until it arrives or gives up.
 *
 * BACKGROUND PLUS POLLING, not a blocking call. `travel` in the foreground holds the
 * request open for the whole walk — minutes — and with several characters that serialises
 * the entire experiment for no reason. It also means a hung leg hangs the runner, which
 * is precisely the failure being measured.
 *
 * THE STALL DETECTOR IS THE CHARACTER, NOT THE KEEPER. `ms_since_moved` measures when the
 * KEEPER last moved somebody and climbs while an errand walks perfectly well; this watches
 * the character's own room and square, which is the question actually being asked.
 */
/**
 * The `travel` arguments a leg sends, and nothing else.
 *
 * `run_errands` IS THE CALLER'S CHOICE, AND SILENCE IS THE BROKER'S DEFAULT. On a journey
 * it defaults to true — a character sent across the world banks and stocks up on the way —
 * which is right for the fleet and wrong for a timed measurement of the road: shadow02 spent a
 * whole ten-minute leg in the First Royal Bank of Tos with a live objective in hand, and the
 * leg was scored as a failure to cross when what it had done was go shopping
 * (`m59-solo-run.mjs`). Left unset, the packet is exactly the one every caller always sent;
 * a caller that says `runErrands: false` gets a leg that measures only the walk.
 */
export function travelArgs(agent, to, { runErrands = null } = {}) {
  const args = { agent, to, background: true, max_hops: 30 };
  if (runErrands !== null && runErrands !== undefined) args.run_errands = runErrands === true;
  return args;
}

export async function runLeg(agent, to, { pollMs = 5000, maxMs = 900000, onTick = null,
                                          runErrands = null } = {}) {
  const start = Date.now();
  const first = await probe(agent);
  let mark = first.seq, swings = 0, lowest = first.health ?? null, deaths = 0;
  const from = first.room;
  // Started dead? Then arriving in the Underworld is not news, and counting it would
  // blame this leg for the previous one's death.
  let wasDead = isDead(first);

  const sent = await broker('travel', travelArgs(agent, to, { runErrands }), { timeoutMs: 60000 });
  if (sent?._error) return { agent, to, from, arrived: false, ms: 0, why: 'travel refused: ' + sent._error };

  let lastRoom = first.room, lastSeen = Date.now(), rooms = [first.room];
  for (;;) {
    await new Promise(r => setTimeout(r, pollMs));
    const p = await probe(agent, mark);
    mark = p.seq;
    swings += p.swings;
    if (p.health != null && (lowest == null || p.health < lowest)) lowest = p.health;
    // A death shows as health at or below zero, or as an unheralded arrival in the
    // Underworld. Both are worth counting; neither is worth stopping for.
    //
    // ONLY THE FIRST HALF WAS EVER IMPLEMENTED, and the half that was missing is the one
    // that happens. A 5s poll almost never lands on the frame where health reads zero —
    // the server moves the body to the Underworld and refills it — so the check that was
    // here caught almost nothing. Measured: a shuttle run in which NINE of twenty-one
    // characters died reported `0 death(s)`, with five of them still standing in room 1
    // when the leg gave up. The comment had described the right rule the whole time.
    //
    // COUNTED ON THE EDGE, NEVER ON THE STATE. A corpse stays in the Underworld across
    // many polls — one leg here spent 903 seconds there — so counting presence would
    // report a death per poll, and health can read <= 0 on two consecutive samples for
    // one death. The transition into being dead is the event; being dead is not.
    const dead = isDead(p);
    if (dead && !wasDead) deaths++;
    wasDead = dead;
    if (p.room !== lastRoom) { rooms.push(p.room); lastRoom = p.room; lastSeen = Date.now(); }
    onTick?.({ agent, ...p, elapsed: Date.now() - start });

    if (p.room === to && !p.busy)
      return { agent, to, from, arrived: true, ms: Date.now() - start, rooms, swings, lowest, deaths };
    // A PROBE THAT FAILED IS NOT A CHARACTER THAT STOPPED.
    //
    // `probe` reads `status`, and under twenty-one walking characters that call times out —
    // the broker is one event loop and a busy fleet is exactly when it is slowest. On a
    // timeout it answered `{ room: null, busy: false }`, which is indistinguishable from
    // "arrived nowhere and gave up", so the leg was abandoned WHILE EVERY CHARACTER WAS
    // STILL WALKING: measured, 0/21 arrived after 200s wall, and the very next leg was
    // refused for all twenty-one with `is busy: walk to North Barloque`. The fleet was
    // fine; the instrument gave up on it. `STUCK in ?` — a null room — is the tell.
    if (p.error) continue;
    // AND `!busy` IS NOT EVIDENCE OF ANYTHING, WHICH IS THE SECOND TIME THIS RULE HAS LIED.
    //
    // The note above records the first: a timed-out probe answered `{busy:false}` and the
    // leg was abandoned while everyone was still walking. It happened again for a different
    // reason. `KeeperProxy.jobReport()` returned a hardcoded null, so `busy` was ABSENT from
    // every status on a keeper-backed broker — which is every broker — and absent reads as
    // false here. Measured: 0/21 arrived declared after 62 seconds of a 900-second budget,
    // on twenty-one characters every one of which was walking to Castle Victoria.
    //
    // Publishing the job fixed the absence but not the inference, and that is the part worth
    // writing down: `rtsJobReport` returns `undefined` when there is no job, so `busy` is
    // LEGITIMATELY absent most of the time. A rule that reads absence as "it stopped" is
    // still wrong afterwards — it just fails rarely, which is worse, because a rule that
    // fails one run in twenty gets believed.
    //
    // So the give-up is asked of the keeper instead. `stuck` is non-null only when a live
    // keeper has a character that has stopped getting anywhere, it carries why and for how
    // long, and it CLEARS on its own when the character gets going again. It is slower to
    // fire than three polls of stillness, which is correct: this rule was too eager, and
    // being late costs a few seconds where being early costs the whole measurement.
    if (p.stuck && Date.now() - lastSeen > pollMs * 3)
      return { agent, to, from, arrived: p.room === to, ms: Date.now() - start, rooms, swings, lowest,
               deaths, why: `keeper reports stuck: ${p.stuck.why ?? 'no reason given'} (${p.stuck.seconds}s)`,
               note: p.last?.note ?? p.last?.reason ?? null, stuck_in: p.room };
    if (Date.now() - start > maxMs)
      return { agent, to, from, arrived: false, ms: Date.now() - start, rooms, swings, lowest,
               deaths, why: 'timed out', stuck_in: p.room };
  }
}

// --------------------------------------------------------------------------- cli
if (process.argv[1]?.endsWith('m59-circuit.mjs')) {
  const argv = process.argv.slice(2);
  const has = n => argv.includes('--' + n);
  const flag = (n, d = null) => {
    const at = argv.indexOf('--' + n);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
  };

  if (has('list')) {
    for (const [k, v] of Object.entries(ROUTES))
      console.log(`  ${k.padEnd(14)} from ${String(v.from).padStart(4)} -> ${v.legs.join(' -> ').padEnd(18)} ${v.why}`);
    process.exit(0);
  }
  if (has('book')) {
    for (const r of load().runs.slice(-30))
      console.log(`${new Date(r.at).toISOString().slice(0, 16)}  ${String(r.route).padEnd(13)} ` +
                  `${r.bots} bot(s)  ${r.arrived}/${r.attempts} arrived  median ${Math.round((r.median_ms || 0) / 1000)}s  ` +
                  `baseline ${Math.round((r.baseline_ms || 0) / 1000)}s  swings ${r.swings}  deaths ${r.deaths}`);
    process.exit(0);
  }

  const routeName = flag('route', 'tos-jasper');
  // AN ITINERARY THE TABLE DOES NOT NAME. A named route is what makes two runs comparable
  // and is the right default, but a cycle can be entered anywhere and the fleet is rarely
  // standing at a route's `from`. `--legs 150,101,50,38` walks the operator's lap starting
  // from Cor Noth instead of repositioning twenty-one bodies to Tos first, which is itself
  // an hour of the thing being measured.
  const legsArg = flag('legs');
  const route = legsArg
    ? { legs: legsArg.split(',').map(Number).filter(Number.isFinite), from: null,
        why: 'an itinerary given on the command line' }
    : ROUTES[routeName];
  if (!route || !route.legs?.length) { console.error(`unknown route "${routeName}" — try --list`); process.exit(2); }
  const laps = Number(flag('laps', 1));
  // A leg's patience. The 15-minute default was measured with five bots on one boundary;
  // twenty-one bodies queueing through a one-square aperture legitimately take longer, and
  // a timeout shorter than the walk reports "stuck" for a character that was still moving.
  const maxLegMs = Number(flag('max-leg', 900)) * 1000;
  const botArg = flag('bots', 'Alpha,Bravo,Charlie,Delta,Echo');
  // `all` is the ARENA's six throwaway characters, which is what this tool was written for.
  // `fleet` is whoever the broker on this port is actually holding — the only form that
  // works against a roster this file has never heard of, and the shadow fleet is one.
  // Asked for by name it stays exact: an agent id passes through `agentFor` untouched.
  const bots = botArg === 'all'   ? Object.keys(AGENTS).filter(n => n !== 'TESTER')
             : botArg === 'fleet' ? await (async () => {
                 const f = await broker('fleet', {}, { timeoutMs: 60000 });
                 const list = (f?.fleet ?? []).map(a => a.agent).filter(Boolean);
                 if (!list.length) { console.error('the broker is holding nobody — is it up on ' + PORT + '?'); process.exit(2); }
                 return list;
               })()
             : botArg.split(',').map(s => s.trim()).filter(Boolean);

  // The baseline the fleet's own history predicts, so the slowdown is stated against
  // something rather than asserted. Its provenance is printed with it.
  let baseline = 0;
  if (route.from != null) {
    let at = route.from;
    for (const leg of route.legs) {
      const e = await broker('travel_estimate', { from: at, to: leg }, { timeoutMs: 30000 });
      baseline += Number(e?.ms ?? 0);
      at = leg;
    }
  }

  console.log(`route ${legsArg ? 'given on the command line' : routeName}: ${route.why}`);
  console.log(`  ${route.from ?? 'wherever they are'} -> ${route.legs.join(' -> ')}   ` +
              `x${laps} lap(s)   bots: ${bots.join(', ')}`);
  console.log(`  baseline from recorded history: ${Math.round(baseline / 1000)}s per lap`);
  console.log('  NOTE: 85.1% of that history predates collision routing, so it is optimistic;');
  console.log('  a measured slowdown against it is an UPPER BOUND on the real regression.\n');

  const results = [];
  for (let lap = 1; lap <= laps; lap++) {
    for (const leg of route.legs) {
      process.stdout.write(`lap ${lap}  -> ${leg}  `);
      const t0 = Date.now();
      // ALL BOTS AT ONCE, because that is how the fleet travels and because bodies
      // blocking bodies is one of the things being measured. Serialising them would
      // measure a world with one character in it.
      const legs = await Promise.all(bots.map(b => runLeg(agentFor(b), leg, { maxMs: maxLegMs })));
      const ok = legs.filter(r => r.arrived).length;
      const times = legs.filter(r => r.arrived).map(r => r.ms).sort((a, b) => a - b);
      const med = times.length ? times[Math.floor(times.length / 2)] : 0;
      const sw = legs.reduce((s, r) => s + (r.swings || 0), 0);
      console.log(`${ok}/${legs.length} arrived, median ${Math.round(med / 1000)}s, ` +
                  `${sw} swing(s) taken, ${Math.round((Date.now() - t0) / 1000)}s wall`);
      for (const r of legs.filter(x => !x.arrived))
        console.log(`     ${r.agent} STUCK in ${r.stuck_in ?? '?'} — ${r.why}${r.note ? ': ' + r.note : ''}`);
      results.push({ lap, leg, legs });
    }
  }

  const all = results.flatMap(r => r.legs);
  const arrived = all.filter(r => r.arrived);
  const times = arrived.map(r => r.ms).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : 0;
  const swings = all.reduce((s, r) => s + (r.swings || 0), 0);
  const deaths = all.reduce((s, r) => s + (r.deaths || 0), 0);

  console.log(`\n=== ${routeName} ===`);
  console.log(`  arrived      ${arrived.length}/${all.length}`);
  console.log(`  median leg   ${Math.round(median / 1000)}s`);
  console.log(`  swings taken ${swings}   deaths ${deaths}`);
  if (baseline > 0 && median > 0) {
    const perLeg = baseline / Math.max(1, route.legs.length);
    const pct = 100 * (median - perLeg) / perLeg;
    console.log(`  vs baseline  ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% (upper bound; the baseline is optimistic)`);
  }

  const b = load();
  b.runs.push({ at: Date.now(), route: legsArg ? `legs:${route.legs.join('/')}` : routeName, laps, bots: bots.length,
                attempts: all.length, arrived: arrived.length, median_ms: median,
                baseline_ms: baseline, swings, deaths,
                stuck: all.filter(r => !r.arrived).map(r => ({ agent: r.agent, in: r.stuck_in, why: r.why })) });
  save(b);
  console.log(`\nrecorded in ${BOOK}`);
}
