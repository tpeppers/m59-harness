#!/usr/bin/env node
// ONE CHARACTER AT A TIME, TOS TO CASTLE VICTORIA, AND WHETHER IT LIVED.
//
//   node tools/m59-solo-run.mjs
//   node tools/m59-solo-run.mjs --wall-below 0.9 --hold-below 0.85
//   node tools/m59-solo-run.mjs --agents shadow01,shadow02 --timeout 240
//   node tools/m59-solo-run.mjs --tour 50,38,593,50 --stagger 30
//   node tools/m59-solo-run.mjs --random --legs 7 --stagger 30      a world tour, next stop drawn by lot
//   node tools/m59-solo-run.mjs --random --seed 1234 --dry-run      the itinerary that seed would walk
//   node tools/m59-solo-run.mjs --no-broadcast                      checkpoints not announced in game
//   node tools/m59-solo-run.mjs --dry-run
//
// WHY ONE AT A TIME. Twenty-one characters crossing together is a different experiment from
// one character crossing: they queue at the same doorway, stand on each other's squares, and
// the spawn they walk through is shared. Every fleet-wide run so far has measured contention
// as much as it measured the road. This sends them in sequence, from the same square, at full
// health, and asks the only question that matters — did it get there, and if not, what
// stopped it.
//
// THE KNOB THIS EXISTS TO TURN. `travel_wall_below` is the health fraction at which a
// traveller detours to a safe wall it is passing. Raise it and shelter is sought EARLIER,
// with more health left to reach the wall with; lower it and the character presses on.
// `travel_hold_below` is the same decision at a hop boundary. Both are per character and
// live, so a sweep is a matter of running this twice.
//
// A NOTE ON THE DEFAULT, because it is not what the schema says. `autopilot`'s description
// of `travel_wall_below` reads "Default 0.6". The code is `this.policy.travelWallBelow ?? 0.8`
// in both places that consult it, and a live character reads 0.8. The documented number has
// never been the one in force.
//
// IT REFUSES A GAME SERVER THAT IS NOT LOOPBACK. Asked of the ROSTER before anything is
// touched, because that can be answered with no broker up and because the answer decides
// whether it is acceptable to walk characters into a corridor until they die.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { rosterGameEndpoint } from './m59-fleetpath.mjs';
import { takeRunLock, inspectRunLock, releaseRunLock,
         exitWhenOutputIsGone } from './m59-runlock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const flag = (n, d = null) => {
  const at = argv.indexOf('--' + n);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
};
const PORT    = Number(flag('port', 8971));
const FLEET   = flag('fleet', 'shadow');
const FROM    = Number(flag('from', 50));     // The Streets of Tos
const TO      = Number(flag('to', 38));       // Castle Victoria
// A CIRCUIT, NOT A CROSSING. `--tour 50,38,593,50` walks Tos -> Castle Victoria -> Barloque
// -> Tos as three legs, one after another, without teleporting back to the start between
// them. That is a different question from `--from/--to` and a better one: a one-way crossing
// always starts from a relocated body at full health, which is the condition a fleet is
// almost never in. A tour asks whether a character can still be somewhere useful after it
// has already made one crossing under its own power.
//
// Each leg is timed separately and the arrival room of one is the departure room of the
// next, so a leg that ends short is REPORTED short rather than papered over by a relocate.
const TOUR = (flag('tour', '') || '').split(',').map(n => Number(n.trim())).filter(Number.isFinite);

// A WORLD TOUR WITH NO FIXED ORDER. `--random` is `--tour` with the next checkpoint drawn by
// lot: the character sets off from `--from`, and on reaching each checkpoint the next one is
// chosen from WORLD_TOUR — any of the seven but the room it is standing in — for `--legs`
// legs. A fixed circuit asks the same doorways in the same order every lap, so a boundary
// that only breaks when approached from the other side, or with a crowd already through it,
// is never asked about. A drawn itinerary asks every pair eventually, and twenty-one
// characters drawing separately spread across the world instead of arriving at one gate as
// a queue.
//
// THE DRAW IS SEEDED, PER CHARACTER, SO IT CAN BE WALKED AGAIN. `--seed` fixes every
// character's itinerary regardless of who set off first or how long a leg took — a random
// tour nobody can repeat is an anecdote, not a measurement. The seed in force is printed on
// every run, and `--dry-run` prints the itinerary each character would draw from it.
const WORLD_TOUR = [
  { room: 38,  name: 'Castle Victoria' },
  { room: 200, name: 'Marion' },
  { room: 350, name: 'East Jasper' },
  { room: 150, name: 'Cor Noth' },
  { room: 50,  name: 'The Streets of Tos' },
  { room: 101, name: 'North Barloque' },
  { room: 110, name: 'A shadowy corner' },
];
const RANDOM = has('random');
const LEGS   = Number(flag('legs', 7));
const SEED   = Number(flag('seed', Date.now() % 1000000));
// mulberry32, seeded from the run's seed and the character's name, so two characters on the
// same seed walk different roads and the same character on the same seed walks the same one.
function rngFor(name) {
  let h = SEED >>> 0;
  for (const ch of String(name)) h = Math.imul(h ^ ch.charCodeAt(0), 2654435761) >>> 0;
  return () => {
    h = (h + 0x6D2B79F5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function nextStop(rng, current) {
  const choices = WORLD_TOUR.filter(s => s.room !== Number(current));
  return choices[Math.floor(rng() * choices.length)].room;
}
function drawItinerary(name) {
  const rng = rngFor(name), legs = [FROM];
  for (let i = 0; i < LEGS; i++) legs.push(nextStop(rng, legs[legs.length - 1]));
  return legs;
}
const stopName = n => WORLD_TOUR.find(s => s.room === Number(n))?.name ?? ('room ' + n);

// ANNOUNCED AT EVERY CHECKPOINT UNLESS TOLD NOT TO. The broadcast is how somebody standing
// in the world knows the tour is running and how far round each character is, so it is on
// by default; `--no-broadcast` is for a run where twenty-one lap reports an hour would be
// noise for everybody else in the game.
const BROADCAST = !has('no-broadcast');

// How long to wait for a leftover recovery hold before timing a leg anyway. Generous,
// because vigor is the slowest of the three bars to come back and the alternative is a leg
// that silently measures nothing.
const RECOVERY_WAIT_MS = Number(flag('recovery-wait', 60)) * 1000;
// HOW LONG A LEG MAY TAKE BEFORE IT IS A FAILURE RATHER THAN A JOURNEY.
//
// 240s was below the human reference — the operator walks Tos to Castle Victoria in under
// five minutes — so a character doing everything right was still scored as having failed.
// It cost a real result: a run reported 0 arrivals while one of its two characters was, at
// that moment, standing in Ukgoth having crossed the Twisted Wood. The leg had been scored
// and the journey was still going, because `travel` runs in the background and nothing
// stopped it.
//
// Ten minutes, and the rest credit is still counted SEPARATELY on top of it — a character
// getting well at a wall is not a slow road, and conflating the two is what this column
// exists to prevent.
const TIMEOUT = Number(flag('timeout', 600)) * 1000;
const WALL    = flag('wall-below', null);
const HOLD    = flag('hold-below', null);
const ONLY    = flag('agents', null)?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
const DRY     = has('dry-run');

// HOW MUCH HEALING A LEG MAY CHARGE TO SOMETHING OTHER THAN THE ROAD. Generous, because a
// character that walks into the Twisted Wood at 30% genuinely does need a couple of minutes
// on a wall — and bounded, because an unbounded pause is a hang. Past this the leg ends as
// `rested out`, which is its own finding: the road was never the thing that was slow.
const REST_CREDIT_MS = Number(flag('rest-credit', 180)) * 1000;

// ONLY ONE OF THESE MAY DRIVE A FLEET, AND A DEAD ONE MUST NOT KEEP DRIVING IT.
//
// Both halves were learned the same afternoon. Three copies of this script were live against
// the same twenty-one characters — one sixty-five minutes after it had been "stopped" through
// a wrapper that took the shell and left the node process, one killed at launch by a `tee`
// that could not open its file and never noticed the broken pipe. They fought for the same
// bodies and every collision reached the transit book as `movement cancelled by a newer
// command`, which is the same sentence a real survival interrupt produces. The travel bug
// being investigated was, in part, three copies of the investigation.
//
// So the run claims the fleet, a second one is refused by name, and a run whose output has
// gone away stops rather than continuing in silence. `--stop` clears a holder; `--force`
// overrides the refusal for somebody who knows what they are doing.
// AN UNRECOGNISED FLAG IS NOT A REQUEST TO DO THE DEFAULT THING TO A LIVE FLEET.
//
// Measured 2026-08-23, and it was this file's own watcher that did it: a script ran
//
//     node tools/m59-solo-run.mjs --help
//
// to check the tool was there. There was no `--help`, the flag was ignored, every other
// setting fell back to its default, and the tool did what it does — took the fleet lock and
// walked two characters from Tos to Castle Victoria. One of them died in Ukgoth. The real
// run, started a second later, was then REFUSED because the fleet was already being driven,
// which is the run lock working exactly as designed and reporting a holder whose command
// line read `--help`.
//
// Two rules, and the second is the general one:
//
//   `--help` PRINTS AND EXITS, BEFORE THE LOCK. A tool that drives a live fleet must have a
//   way to ask what it does that does not do it.
//
//   AN UNKNOWN FLAG IS REFUSED. Silently ignoring one turns a typo — `--agent` for
//   `--agents`, `--stagger 60s` for `--stagger 60` — into a full-fleet run with defaults,
//   against a shared server, with no error anywhere. This is the same failure this
//   repository already documents everywhere else: no error has never meant success here.
const KNOWN = new Set(['port', 'fleet', 'from', 'to', 'tour', 'recovery-wait', 'timeout',
                       'wall-below', 'hold-below', 'agents', 'dry-run', 'rest-credit',
                       'stagger', 'stop', 'force', 'help', 'on-shared-server',
                       'random', 'legs', 'seed', 'broadcast', 'no-broadcast']);
if (has('help') || argv.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8')
    .split('\n').slice(1).filter(l => l.startsWith('//'))
    .map(l => l.replace(/^\/\/ ?/, '')).join('\n').split('\n\n').slice(0, 3).join('\n\n'));
  process.exit(0);
}
{
  const unknown = argv.filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')[0])
                      .filter(a => !KNOWN.has(a));
  if (unknown.length) {
    console.error(`solo-run: unknown option(s): ${unknown.map(u => '--' + u).join(', ')}`);
    console.error('          Refused rather than ignored: this tool drives a live fleet, and');
    console.error('          ignoring a flag means running the DEFAULT experiment instead of');
    console.error('          the one that was asked for. `--help` lists what it takes.');
    process.exit(2);
  }
}
if (RANDOM && has('tour')) {
  console.error('solo-run: --random and --tour are two different itineraries; pick one.');
  process.exit(2);
}
if (RANDOM && !(Number.isInteger(LEGS) && LEGS > 0)) {
  console.error('solo-run: --legs must be a whole number of legs greater than zero.');
  process.exit(2);
}
if (RANDOM && !Number.isInteger(SEED)) {
  console.error('solo-run: --seed must be an integer.');
  process.exit(2);
}
if (RANDOM && !WORLD_TOUR.some(s => s.room === FROM)) {
  console.error(`solo-run: --from ${FROM} is not one of the world tour's stops: ` +
                WORLD_TOUR.map(s => s.room).join(', '));
  process.exit(2);
}

exitWhenOutputIsGone();

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const UNDERWORLD = 1;

function call(name, args, ms = 90000) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                                params: { name, arguments: args } });
  return new Promise(done => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/', method: 'POST',
      headers: { 'content-type': 'application/json',
                 'content-length': Buffer.byteLength(body), connection: 'close' },
      agent: false, timeout: ms }, res => {
      let t = ''; res.setEncoding('utf8');
      res.on('data', c => { t += c; });
      res.on('end', () => {
        // A TOOL REFUSAL IS PROSE, NOT JSON, AND THE PARSE ERROR HID IT TWICE.
        // `error: Aaaa is busy: walk to ...` came back as
        // `Unexpected token 'e', "error: sha"... is not valid JSON`, which reads like a
        // broken broker and is actually the broker answering clearly. Report what it said.
        try {
          const text = JSON.parse(t)?.result?.content?.[0]?.text ?? t;
          if (typeof text === 'string' && text.startsWith('error: ')) { done({ _error: text.slice(7) }); return; }
          done(JSON.parse(text));
        }
        catch (e) { done({ _error: e.message }); }
      });
    });
    req.on('timeout', () => { req.destroy(); done({ _error: 'timeout' }); });
    req.on('error', e => done({ _error: e.message }));
    req.end(body);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// IS THIS CHARACTER DELIBERATELY STOPPED? Resting at a wall or in a sanctuary is the
// survival ladder doing its job, and it is NOT the road being slow. Counted against the
// leg's clock it produced the wrong verdict twice over: thirteen of fourteen legs ended in
// a timeout rather than a death, and a character that spent two minutes healing on a proven
// safe spot was recorded as having failed to cross — when what it actually did was survive.
const RESTING = /rest|holding a (proven|untested) safe spot|healing|recovering/i;
const isResting = ap => RESTING.test(String(ap?.activity ?? ''));

// ---------------------------------------------------------------- who is driving
if (has('stop')) {
  const found = inspectRunLock(FLEET);
  if (found.state === 'none') { console.log(`nothing holds fleet "${FLEET}"`); process.exit(0); }
  const pid = Number(found.lock?.pid);
  console.log(`fleet "${FLEET}" is ${found.state} by pid ${pid}` +
              (found.why ? ` (${found.why})` : '') +
              (found.lock?.at ? `, since ${new Date(found.lock.at).toISOString()}` : ''));
  if (found.state === 'held' && Number.isInteger(pid) && pid !== process.pid) {
    // BY PID, NEVER BY NAME. Matching `node` or `m59-*` across every process once killed a
    // live broker belonging to a different checkout and logged out its whole fleet.
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`  signalled pid ${pid}`);
    } catch (e) { console.log(`  could not signal pid ${pid}: ${e.message}`); }
  }
  releaseRunLock(FLEET);
  console.log('  lock cleared');
  process.exit(0);
}

const claim = takeRunLock(FLEET, {
  label: RANDOM ? `solo-run random x${LEGS} seed ${SEED}`
       : TOUR.length >= 2 ? `solo-run tour ${TOUR.join('>')}`
       : `solo-run ${FROM}->${TO}`,
  force: has('force') });
if (!claim.ok) {
  const h = claim.holder ?? {};
  console.error(`solo-run: REFUSING — fleet "${FLEET}" is already being driven.`);
  console.error(`          pid ${h.pid}, "${h.label ?? '?'}", since ` +
                `${h.at ? new Date(h.at).toISOString() : '?'}`);
  console.error(`          ${h.argv ?? ''}`);
  console.error(`          Two runs on one fleet fight for the same bodies and both report`);
  console.error(`          "movement cancelled by a newer command". Stop that one first:`);
  console.error(`            node tools/m59-solo-run.mjs --stop --fleet ${FLEET}`);
  process.exit(3);
}
if (claim.tookOverFrom)
  console.log(`(took over a stale lock: ${claim.tookOverFrom.why})`);

// ---------------------------------------------------------------- which fleet
const rosterFile = FLEET === '-' ? join(REPO, 'substrate', 'fleet-state.json')
                                 : join(REPO, 'substrate', 'fleets', `${FLEET}.json`);
const rostered = rosterGameEndpoint(rosterFile);
if (!rostered) {
  console.error(`solo-run: ${rosterFile} does not name one game server.`);
  process.exit(2);
}
// A SHARED SERVER IS STILL REFUSED — BUT NAMING ONE VOLUNTEER IS NOT THE SAME REQUEST.
//
// The blanket refusal is right for what this tool normally does: it walks a WHOLE FLEET
// into a corridor until it dies, and doing that where other people play is not a
// configuration choice. What it cannot express is the one experiment we actually need —
// send ONE expendable character down a road we suspect is broken, on the server whose
// movement code we are trying to judge, because the lab server does not reproduce it.
//
// So the exemption is deliberately awkward to reach and cannot widen by accident:
//   --on-shared-server  says out loud that you know where this is pointed, AND
//   --agents <list>     must name every character, at most MAX_SHARED of them.
// No flag combination reaches a shared server without an explicit roll-call. Without
// --agents this still refuses, so a stray flag in a shell history cannot walk the fleet
// off a cliff. `--dry-run` never needed any of this.
const MAX_SHARED = 2;
if (!LOOPBACK.has(rostered.host.toLowerCase())) {
  const named = ONLY ?? [];
  if (!has('on-shared-server') || !named.length) {
    console.error(`solo-run: REFUSING. Fleet "${FLEET}" is on ${rostered.host}:${rostered.port}, not loopback.`);
    console.error(`          This walks characters into a corridor until they die. Lab servers only.`);
    console.error(`          To send named volunteers anyway: --on-shared-server --agents <a,b>`);
    process.exit(2);
  }
  if (named.length > MAX_SHARED) {
    console.error(`solo-run: REFUSING. --on-shared-server allows at most ${MAX_SHARED} named ` +
                  `character(s); you named ${named.length}.`);
    process.exit(2);
  }
  console.error(`solo-run: SHARED SERVER (${rostered.host}:${rostered.port}). ` +
                `Running only: ${named.join(', ')}. Everyone else is untouched.`);
}

const fleet = await call('fleet', {});
let rows = (fleet.fleet ?? []).filter(r => r.agent && r.character);
if (ONLY) rows = rows.filter(r => ONLY.includes(r.agent) || ONLY.includes(r.character));
rows.sort((a, b) => a.agent.localeCompare(b.agent, 'en', { numeric: true }));
if (!rows.length) { console.error('solo-run: no characters matched.'); process.exit(1); }

console.log(`fleet "${FLEET}" -> ${rostered.host}:${rostered.port}`);
if (RANDOM)
  console.log(`${rows.length} character(s), a world tour of ${LEGS} leg(s) each from ${FROM}, ` +
              `next stop drawn by lot (seed ${SEED}), ${TIMEOUT / 1000}s per leg`);
else if (TOUR.length >= 2)
  console.log(`${rows.length} character(s), tour ${TOUR.join(' -> ')}, ${TIMEOUT / 1000}s per leg`);
else
  console.log(`${rows.length} character(s), one at a time, ${FROM} -> ${TO}, ${TIMEOUT / 1000}s each`);
if (RANDOM) console.log('stops: ' + WORLD_TOUR.map(s => `${s.room} ${s.name}`).join(', '));
console.log(`shelter: travel_wall_below ${WALL ?? '(unchanged)'}, travel_hold_below ${HOLD ?? '(unchanged)'}`);
console.log(BROADCAST ? 'checkpoints are broadcast to the whole server on arrival'
                      : 'checkpoints are NOT announced in game (--no-broadcast)');
console.log('');
if (DRY) {
  for (const r of rows)
    console.log(`  ${String(r.character).padEnd(12)} (${r.agent})` +
                (RANDOM ? '  ' + drawItinerary(r.character).join(' -> ') : ''));
  process.exit(0);
}

const dm = await import('./m59-dm.mjs');
const snap = JSON.parse(readFileSync(join(REPO, 'substrate', 'shadow-snapshot.json'), 'utf8'));

// SAYING IT OUT LOUD, IN THE GAME, WHERE THE OPERATOR IS WATCHING.
//
// A run that only reports to a terminal is invisible to somebody standing in Castle
// Victoria watching characters arrive. So each checkpoint is announced on the wire as well
// as recorded: which lap, which checkpoint, and how long that leg took.
//
// THE LAP COUNT LIVES ON DISK BECAUSE THE PROCESS DOES NOT. A continuous circuit is one
// solo-run invocation per lap, so an in-memory counter would announce "1st lap" for ever
// and the number would be a lie rather than a measurement. Keyed by character, reset to
// zero by a death — which is what makes it "since dying" and not "since the script started".
const LAPFILE = join(REPO, 'substrate', 'circuit-laps.json');
const readLaps = () => { try { return JSON.parse(readFileSync(LAPFILE, 'utf8')); } catch { return {}; } };
const writeLaps = o => { try { writeFileSync(LAPFILE, JSON.stringify(o, null, 1)); } catch { /* a lost count is not a lost run */ } };
const lapsOf = who => Number(readLaps()[who] ?? 0);
const setLaps = (who, n) => { const o = readLaps(); o[who] = n; writeLaps(o); };
// 1st, 2nd, 3rd, 4th ... and 11th/12th/13th, which the naive rule gets wrong.
const ordinal = n => {
  const t = n % 100;
  if (t >= 11 && t <= 13) return n + 'th';
  return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
};
const ROOM_NAMES = (() => {
  try {
    const w = JSON.parse(readFileSync(join(REPO, 'substrate', 'm59-map.json'), 'utf8'));
    const out = {};
    for (const [num, room] of Object.entries(w.rooms ?? {})) if (room?.name) out[Number(num)] = room.name;
    return out;
  } catch { return {}; }
})();
const roomName = n => ROOM_NAMES[Number(n)] ?? ('room ' + n);


const maxOf = name => snap.characters.find(c => c.shadow_name === name)?.max_health ?? null;

console.log('  character    outcome     s   from -> ended   low  rest  rooms');
const results = [];
// ONE LEG, AS A FUNCTION, SO IT CAN BE RUN ALONE OR ALONGSIDE OTHERS.
//
// Sequential is the honest way to measure a ROAD: twenty-one characters crossing together
// queue at the same doorway, stand on each other's squares, and share the spawn they walk
// through, so a fleet run measures contention as much as it measures the route.
//
// Staggered is the honest way to measure a FLEET, which is a different question and the one
// an operator actually has: if I send everybody, how many arrive. `--stagger <seconds>` sets
// them off that far apart and polls them all, which keeps them from leaving as one crowd
// without pretending they are alone.
async function runLeg(r, { from = FROM, to = TO, place = true, heal = true, leg = null, next = null } = {}) {
  // Same starting conditions for every one of them, or the run measures who went first.
  await call('autopilot', { agent: r.agent, mode: 'idle', roam: false, confine_rooms: [] });
  await call('autopilot', { agent: r.agent, action: 'unpark' });
  if (WALL !== null) await call('autopilot', { agent: r.agent, travel_wall_below: Number(WALL) });
  if (HOLD !== null) await call('autopilot', { agent: r.agent, travel_hold_below: Number(HOLD) });
  // ON A TOUR, ONLY THE FIRST LEG IS PLACED AND HEALED. Relocating between legs would throw
  // away the thing the tour is asking about — whether the character is still in a state to
  // go on — and healing between them would turn three legs into three first legs.
  // STOP WHATEVER THE LAST LAP LEFT RUNNING. A travel job lives in the BROKER, so killing
  // this script does not end it — the character walks on, and the next lap is refused with
  // "is busy: walk to ..." before it measures anything. Four laps in a row were lost to
  // that. Cancel is best-effort and harmless when there is nothing to cancel.
  if (place) {
    // `cancel_movement`, NOT `autopilot action=cancel`. The second one returns a healthy
    // status and leaves the walk running, so the next lap is still refused with
    // "is busy: walk to Castle Victoria" — a cancel that reports success and cancels
    // nothing, which is the failure mode this repository keeps meeting.
    await call('cancel_movement', { agent: r.agent }, 20000).catch(() => null);
    await call('autopilot', { agent: r.agent, action: 'cancel' }, 20000).catch(() => null);
    await new Promise(done => setTimeout(done, 1500));
  }
  if (place) await dm.relocate([r.character], from, { verify: false }).catch(() => null);
  const ids = await dm.resolve([r.character]);
  const max = maxOf(r.character);
  if (heal && ids[r.character] != null && max) {
    // ALL THREE VITALS, BECAUSE THE RECOVERY HOLD ASKS FOR ALL THREE.
    //
    // This restored HEALTH only, and `recovered()` wants health, mana AND vigor. So a
    // character that died in the previous run started the next one at full health with an
    // empty mana bar, `recoverUntilWhole` still set, and `passUnderworld` — the FIRST rung —
    // ending every tick while it sat in an inn. Caught by the ladder tracer:
    //
    //     Aaaa  15 passes  room 586  passUnderworld  idle/?  100%->100%
    //
    // Fifteen passes, full health, going nowhere. The leg was measuring a hold, not a road.
    //
    // CONSECUTIVE RUNS WERE NOT INDEPENDENT, which is worse than any single wrong number: a
    // run's result depended on how the one before it ended, and today's runs alternated
    // between "0 deaths" and "2 deaths" partly for that reason. A measurement whose result
    // depends on the previous measurement is not a measurement.
    // AND VIGOR, WHICH IS THE ONE THAT DECIDES HOW LONG THE CHARACTER IS IN THE ROOM.
    //
    // `healthCmds` fills health and `manaCmds` fills mana; neither touches vigor, so every
    // leg started at whatever resting had delivered — and resting stops at 80 of 200. Vigor
    // is what pays for running, running is roughly five squares a second against a walk,
    // and TIME IN THE ROOM is the dominant risk on this road: the same Ukgoth crossing runs
    // 30s uncontended and 155-230s when it goes wrong, and the deaths are all in the long
    // ones. Starting every measured leg at the rest cap measured a fleet that cannot run.
    //
    // `dm.heal` already does all three — health and mana to their real ceilings, piVigor to
    // MAX_VIGOR, piExertion to 0 — and pushes NewHealth/NewMana/NewVigor, because a bar set
    // behind the game's back is not redrawn and a reset the client cannot see is one the
    // operator will do again.
    await dm.heal([r.character], { timeoutMs: 60000 }).catch(() => null);
  }

  // A LEG THAT STARTS UNDER A RECOVERY HOLD IS NOT A MEASUREMENT OF ANYTHING.
  //
  // `recoverUntilWhole` is set when a character comes back from the dead and stays set until
  // health, mana AND vigor are all back. While it is up, `passUnderworld` — the FIRST rung —
  // ends every tick, and `travel` is refused the instant it is asked. Healing the body with
  // the DM tools does not clear it: the flag is the keeper's, the clock is its own, and mana
  // and vigor come back at their own pace.
  //
  // Measured here: leg B of the 597 investigation reported `refused` at zero seconds and
  // `597 -> 597`, which reads exactly like a room that cannot be left. It was a character
  // that had died two legs earlier and was still mending. The crossing itself, asked for
  // directly a minute later, took 16 seconds.
  //
  // So wait for it, bounded, and SAY SO rather than producing a zero-second leg that looks
  // like a routing failure.
  let heldBack = null;
  for (let waited = 0; waited <= RECOVERY_WAIT_MS; waited += 5000) {
    const ap = await call('autopilot', { agent: r.agent, action: 'status' }, 30000);
    if (!ap?.recovering_from_death) { heldBack = null; break; }
    heldBack = ap.recovering_from_death?.until ?? 'recovering after a death';
    if (waited >= RECOVERY_WAIT_MS) break;
    await sleep(5000);
  }
  if (heldBack)
    console.log(`  ${String(r.character).padEnd(12)} still recovering after ` +
                `${Math.round(RECOVERY_WAIT_MS / 1000)}s — ${heldBack}; ` +
                `this leg is not a measurement of the road`);

  const started = Date.now();
  // NO ERRANDS ON A TIMED LEG. `run_errands` defaults to true on a journey — a character
  // sent across the world should bank and stock up before it goes — and that is exactly
  // what this experiment must not measure. shadow02 spent a whole ten-minute leg in the
  // First Royal Bank of Tos with a live objective in hand, and the leg was scored as a
  // failure to cross when what it had actually done was go shopping.
  const sent = await call('travel', { agent: r.agent, to, max_hops: 30, background: true,
                                       run_errands: false }, 60000);
  let ended = null, low = null, died = false, restedMs = 0, refusedWhy = null;
  const FROM = from, TO = to;              // the rest of this body reads these two names
  const rooms = new Set([FROM]);
  const perRoom = {};                 // room number -> seconds spent in it
  // POISON RUINS A TIMING AND LOOKS EXACTLY LIKE A SLOW ROAD.
  //
  // It takes a character to 1 health and then makes it rest to full once the enchantment
  // ends, so a poisoned leg spends minutes standing still through no fault of the route. The
  // keeper has seen this all along — `client.ailments()` comes off BP_ADD_ENCHANTMENT, and
  // the safe-spot book already refuses to discredit a wall for poison damage — but nothing
  // carried it into the travel record, so a poisoned leg has been indistinguishable from a
  // bad one. A state rather than an event: the leg either met it or it did not.
  const ailments = new Set();
  // WHAT THE KEEPER SAID IT WAS DOING, MINUTE BY MINUTE.
  //
  // The keeper's own journal is an in-memory ring and keepers restart about once a minute, so
  // it never reaches back far enough to explain anything: a post-mortem taken after a death in
  // Ukgoth held twenty-six seconds of decisions, and the episode worth reading was ten minutes
  // earlier in The Streets of Tos.
  //
  // This poll already asks `autopilot action=status` every five seconds and threw the answer
  // away. Keeping the CHANGES — not every sample — is a per-leg record of what the character
  // thought it was doing and where, which is exactly the question a 204-second walk across a
  // town room raises and nothing could answer.
  const activity = [];
  let roomNow = FROM;
  if (sent?._error || sent?.refused) {
    // A REFUSAL WITH NO REASON IS THE THING THIS REPOSITORY KEEPS PAYING FOR. The reason was
    // being computed by the broker, returned over the wire, and dropped on this line — so a
    // leg that never started looked identical to one that started and got nowhere.
    ended = 'refused';
    refusedWhy = sent?._error ?? sent?.reason ?? sent?.refused ?? 'no reason given';
    if (heldBack) refusedWhy += ` (and it was still ${heldBack})`;
  } else {
    for (;;) {
      await sleep(5000);
      const [st, ap] = await Promise.all([
        call('status', { agent: r.agent }, 30000),
        call('autopilot', { agent: r.agent, action: 'status' }, 30000),
      ]);
      // THE CLOCK PAUSES WHILE IT RESTS, and the time is kept rather than discarded — a leg
      // that spent most of its budget healing is a different animal from one that spent it
      // walking, and only reporting both tells them apart.
      // A PAUSED CLOCK NEEDS A CEILING, OR IT IS NOT A PAUSE, IT IS A HANG.
      //
      // Every 5s poll that reads as resting used to add 5s of credit, with nothing bounding
      // the total — so a character that rests and never stops cancels its own timeout and
      // the leg runs for ever. It did: one run sat on its first character for ten minutes
      // and printed no rows at all, and from outside that is indistinguishable from a
      // hung broker. The instrument has to be able to fail.
      //
      // So rest still buys time, but only up to REST_CREDIT_MS. Past that the leg ends and
      // says WHY it ended — `rested out` is a different finding from `timed out`, and
      // conflating them is what this whole column exists to prevent.
      if (isResting(ap)) restedMs = Math.min(restedMs + 5000, REST_CREDIT_MS);
      for (const e of (st?.ailments ?? [])) if (e?.name) ailments.add(e.name);
      const room = st?.where?.num ?? null;
      // SECONDS PER ROOM, because a journey that fails is usually a journey that was slow
      // somewhere specific, and a room total hides it. The operator crosses Ukgoth in under a
      // minute; a leg that spends six hundred seconds getting through has spent them
      // somewhere, and "which room" is the whole question.
      if (room != null) {
        if (roomNow !== room) roomNow = room;
        perRoom[room] = (perRoom[room] ?? 0) + 5;
      }
      const doing = String(ap?.activity ?? '').slice(0, 60);
      if (doing && doing !== activity[activity.length - 1]?.what)
        activity.push({ what: doing, at: Date.now(), room });
      const hp = st?.vitals?.health?.value ?? null;
      if (room != null) rooms.add(room);
      if (hp != null && (low === null || hp < low)) low = hp;
      // THE UNDERWORLD IS THE DEATH, and it is the only reliable sign of one: a 5s poll
      // almost never lands on the frame where health reads zero.
      if (room === UNDERWORLD) { died = true; ended = 'DIED'; break; }
      if (room === TO) { ended = 'arrived'; break; }
      if (Date.now() - started - restedMs > TIMEOUT) {
        ended = restedMs >= REST_CREDIT_MS ? 'rested out' : 'timed out';
        break;
      }
    }
  }
  const secs = Math.round((Date.now() - started) / 1000);
  const restSecs = Math.round(restedMs / 1000);

  // ANNOUNCED ON ARRIVAL, AND A DEATH RESETS THE COUNT RATHER THAN INTERRUPTING IT.
  // `say` is best-effort on purpose: a broadcast that fails must not turn an arrival into
  // a failed leg, because the leg is the measurement and this is only the commentary.
  // AND ONLY WHEN ASKED TO BE — on by default, off with `--no-broadcast`. The reply is kept
  // so a broadcast the server swallowed (a refusal is prose, and `echoed` is null) shows on
  // the leg's line rather than looking like a checkpoint nobody reached.
  let said = null;
  if (died) setLaps(r.character, 0);
  else if (ended === 'arrived' && BROADCAST) {
    const lap = lapsOf(r.character) + 1;
    const text = `I'm on my ${ordinal(lap)} lap since dying, I've just reached the checkpoint ` +
                 `${roomName(TO)}. Total travel time since last leg: ${secs} seconds.` +
                 (next != null ? ` Next stop: ${roomName(next)}.` : '');
    said = await call('say', { agent: r.agent, text, type: 'broadcast' }, 20000).catch(() => null);
  }
  const at = await call('status', { agent: r.agent }, 30000);
  results.push({ character: r.character, ended, secs, restSecs, died, low,
                 endedIn: at?.where?.num ?? null, rooms: [...rooms], perRoom, ailments: [...ailments], activity });
  console.log(`  ${String(r.character).padEnd(12)} ${String(ended).padEnd(10)} ${String(secs).padStart(3)}   ` +
              `${String(FROM).padStart(4)} -> ${String(at?.where?.num ?? '?').padStart(5)}   ` +
              `${String(low ?? '?').padStart(3)}  ${String(restSecs).padStart(4)}r  ${[...rooms].join(',')}`);
  // WHERE THE TIME WENT, worst room first. Sampled at the poll interval, so it is coarse —
  // but a room holding a character for minutes shows up unmistakably, and that is the
  // question this answers.
  // SAID ON THE LEG'S OWN LINE, because a timing without it is a number nobody can trust.
  if (refusedWhy)
    console.log('               REFUSED: ' + refusedWhy);
  if (ended === 'arrived' && BROADCAST && !said?.echoed)
    console.log('               (checkpoint broadcast may not have gone out: ' +
                String(said?._error ?? JSON.stringify(said?.messages ?? said ?? null)).slice(0, 160) + ')');
  if (ailments.size)
    console.log('               AILING: ' + [...ailments].join(', ') +
                " — this leg's time is not a measurement of the road");
  // Printed when the leg did not simply arrive, because that is when anybody asks.
  if (ended !== 'arrived' && activity.length) {
    const t0 = activity[0].at;
    console.log('               what it thought it was doing:');
    for (const a of activity.slice(0, 12))
      console.log('                 +' + String(Math.round((a.at - t0) / 1000)).padStart(3) + 's  room ' +
                  String(a.room ?? '?').padStart(4) + '  ' + a.what);
    if (activity.length > 12) console.log('                 ... and ' + (activity.length - 12) + ' more');
  }
  const spent = Object.entries(perRoom).sort((x, y) => y[1] - x[1]).filter(([, sec]) => sec >= 10);
  if (spent.length)
    console.log('               time by room: ' +
                spent.map(([num, sec]) => num + '=' + sec + 's').join('  '));
  // HANDED BACK AS WELL AS RECORDED. A tour has to know whether this leg arrived before it
  // decides to start the next one from wherever the body ended up — and `results` is the
  // report, not a channel for that.
  return { character: r.character, ended, secs, died, endedIn: at?.where?.num ?? null };
}

// A TOUR IS RUN PER CHARACTER, LEG AFTER LEG, AND STOPS AT THE FIRST LEG THAT DOES NOT
// ARRIVE. Carrying on from a body that is dead or stranded would measure a relocate rather
// than a road, and the interesting number is how far round the circuit it got.
async function runTour(r) {
  const legs = [];
  for (let i = 0; i + 1 < TOUR.length; i++) {
    const out = await runLeg(r, { from: TOUR[i], to: TOUR[i + 1],
                                  place: i === 0, heal: i === 0, leg: i + 1 });
    legs.push(out);
    if (out.ended !== 'arrived') break;
  }
  // A LAP IS THE WHOLE CIRCUIT, NOT A LEG. Only a tour that arrived at every checkpoint
  // advances the count, so "my 3rd lap" means three complete circuits and not three
  // arrivals somewhere.
  const done = legs.filter(l => l.ended === 'arrived').length;
  if (done === TOUR.length - 1) setLaps(r.character, lapsOf(r.character) + 1);
  console.log(`  ${String(r.character).padEnd(12)} completed ${done} of ${TOUR.length - 1} leg(s) ` +
              `— ${legs.map(l => `${l.ended}@${l.endedIn ?? '?'}`).join(' -> ')}`);
  return legs;
}

// A RANDOM TOUR IS A TOUR WHOSE NEXT CHECKPOINT IS DRAWN ON ARRIVAL. Same rules as a fixed
// one — first leg placed and healed, later legs from wherever the last one ended, stop at
// the first leg that does not arrive, a lap only when every leg did. The stop AFTER the one
// being walked to is drawn before the leg starts, so the arrival broadcast can say where the
// character is going next; the draw comes off the character's own seeded stream either way,
// so the road walked is exactly the one `--dry-run` printed for that seed.
async function runRandomTour(r) {
  const rng = rngFor(r.character);
  const legs = [];
  let at = FROM;
  let to = nextStop(rng, at);
  for (let i = 0; i < LEGS; i++) {
    const after = i + 1 < LEGS ? nextStop(rng, to) : null;
    const out = await runLeg(r, { from: at, to, place: i === 0, heal: i === 0, leg: i + 1, next: after });
    legs.push(out);
    if (out.ended !== 'arrived') break;
    at = to; to = after;
  }
  const done = legs.filter(l => l.ended === 'arrived').length;
  if (done === LEGS) setLaps(r.character, lapsOf(r.character) + 1);
  console.log(`  ${String(r.character).padEnd(12)} completed ${done} of ${LEGS} leg(s) ` +
              `— ${FROM} -> ${legs.map(l => `${l.ended}@${l.endedIn ?? '?'}`).join(' -> ')}`);
  return legs;
}

const STAGGER = Number(flag('stagger', 0));
if (RANDOM) {
  if (STAGGER > 0) {
    await Promise.all(rows.map((r, i) =>
      new Promise(done => setTimeout(done, i * STAGGER * 1000)).then(() => runRandomTour(r))));
  } else {
    for (const r of rows) await runRandomTour(r);
  }
} else if (TOUR.length >= 2) {
  if (STAGGER > 0) {
    await Promise.all(rows.map((r, i) =>
      new Promise(done => setTimeout(done, i * STAGGER * 1000)).then(() => runTour(r))));
  } else {
    for (const r of rows) await runTour(r);
  }
} else if (STAGGER > 0) {
  console.log(`(staggered: one every ${STAGGER}s, all polled together)
`);
  await Promise.all(rows.map((r, i) =>
    new Promise(done => setTimeout(done, i * STAGGER * 1000)).then(() => runLeg(r))));
} else {
  for (const r of rows) await runLeg(r);
}

// AND THE SAME QUESTION ACROSS THE WHOLE RUN. One slow room costs every character, so the
// total per room is the thing to attack; a single leg's figure is one sample of it.
const totals = {};
for (const r of results) for (const [num, sec] of Object.entries(r.perRoom ?? {}))
  totals[num] = (totals[num] ?? 0) + sec;
const worst = Object.entries(totals).sort((x, y) => y[1] - x[1]).slice(0, 8);
if (worst.length) {
  console.log('');
  console.log('seconds spent per room, worst first (all legs):');
  for (const [num, sec] of worst) console.log('  ' + String(sec).padStart(5) + 's  room ' + num);
}

// THE FLEET QUESTION, WHICH IS NOT THE ROAD QUESTION. How many of everybody who set off got
// there, how long it took the ones that did, and what stopped the rest.
if (results.length > 2) {
  const arr = results.filter(r => r.ended === 'arrived');
  const times = arr.map(r => r.secs).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : null;
  const ail = results.filter(r => (r.ailments ?? []).length).length;
  console.log('');
  console.log('FLEET');
  console.log(`  set off        ${results.length}`);
  console.log(`  arrived        ${arr.length}  (${Math.round(arr.length / results.length * 100)}%)`);
  console.log(`  died           ${results.filter(r => r.died).length}`);
  console.log(`  ailing at all  ${ail}   — those legs are not measurements of the road`);
  if (times.length)
    console.log(`  arrival time   fastest ${times[0]}s   median ${median}s   slowest ${times[times.length - 1]}s`);
  const stopped = {};
  for (const r of results) if (r.ended !== 'arrived') stopped[r.ended] = (stopped[r.ended] ?? 0) + 1;
  if (Object.keys(stopped).length)
    console.log('  and the rest   ' + Object.entries(stopped).map(([k, v]) => `${v} ${k}`).join(', '));
}

const arrived = results.filter(r => r.ended === 'arrived').length;
const dead = results.filter(r => r.died).length;
console.log(`\n${results.length} run(s): ${arrived} arrived, ${dead} died, ` +
            `${results.length - arrived - dead} neither`);
const stops = {};
for (const r of results) if (r.ended !== 'arrived') stops[r.endedIn ?? '?'] = (stops[r.endedIn ?? '?'] ?? 0) + 1;
if (Object.keys(stops).length) {
  console.log('\nwhere the ones that did not arrive ended up:');
  for (const [k, v] of Object.entries(stops).sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(v).padStart(3)}  room ${k}`);
}
