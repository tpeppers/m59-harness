#!/usr/bin/env node
// SCATTER THE FLEET ACROSS THE MAINLAND AND ASK HOW MANY GET HOME.
//
//   node tools/m59-pilgrimage.mjs --fleet shadow --to 2
//   node tools/m59-pilgrimage.mjs --fleet shadow --to 2 --seed 7 --timeout 600
//   node tools/m59-pilgrimage.mjs --dry-run
//
// `m59-solo-run.mjs` answers "can ONE character walk THIS road", one at a time, from one
// square, because twenty-one characters crossing together measure contention as much as
// they measure the road. This asks the other question, which is the one the fleet actually
// lives: everybody starts somewhere different and everybody goes to the same place.
//
// WHY THE FIVE INNS. They are the mainland's fixed points — the rooms the Underworld's
// portals land in (CITY_INNS in m59-underworld.mjs, RIDs from blakston.khd), so they are
// where a dead character comes back to and where a journey starts in practice. Scattering
// across all five means the run measures a spread of roads rather than one, and the report
// says which city's road is the bad one instead of averaging it away.
//
// LOOPBACK ONLY, and it refuses otherwise. This relocates bodies with the DM tools, which
// is a lab-server power; the same run against prod would need the fleet to walk to the inns
// first, and that is a different experiment.
//
// Everything it reports is measured from the character, not from the request: `arrived`
// means the room read back as the destination. See docs/m59-operations.md.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { rosterGameEndpoint } from './m59-fleetpath.mjs';
import { CITY_INNS } from './m59-underworld.mjs';
import {
  DISPATCH_MAX_ATTEMPTS,
  completeCycleArrival,
  dispatchDecision,
  keeperStatusOwnsMovement,
  keeperStatusVerificationFailure,
  newPendingDispatch,
  noteDispatchResult,
} from './m59-pilgrimage-cycle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const UNDERWORLD = 1;

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf('--' + name);
  return i < 0 ? fallback : argv[i + 1];
};
const has = name => argv.includes('--' + name);

const KNOWN = new Set(['fleet', 'to', 'port', 'timeout', 'seed', 'agents', 'inns', 'no-retry',
                       'dry-run', 'help', 'h', 'cycle', 'reverse']);
for (const a of argv) {
  if (!a.startsWith('--')) continue;
  if (!KNOWN.has(a.slice(2))) {
    console.error(`m59-pilgrimage: unknown option ${a}`);
    console.error(`known: ${[...KNOWN].map(k => '--' + k).join(' ')}`);
    process.exit(2);
  }
}
if (has('help') || has('h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const FLEET = flag('fleet', process.env.M59_FLEET
  ?? (() => { try { return readFileSync(join(REPO, 'substrate', 'fleet-default'), 'utf8').trim(); }
              catch { return '-'; } })());
const PORT = Number(flag('port', 8971));
const TO = Number(flag('to', 2));
const TIMEOUT = Number(flag('timeout', 600)) * 1000;
// SEND THEM BACK OUT AFTER A DEATH, AND COUNT THE DEATHS. Default on: without it this tool
// measures the death rate rather than whether the road can be crossed — see the note in
// watchAll. `--no-retry` restores the old behaviour for comparison with earlier runs.
const RETRY = !has('no-retry');
const DRY = has('dry-run');
const ONLY = flag('agents') ? String(flag('agents')).split(',').map(s => s.trim()).filter(Boolean) : null;

// The mainland five, in the canonical table's own order. Ko'catan is across the sea and is
// not a mainland road, so it is left out unless somebody names it.
// SCATTER-AND-CONVERGE, OR KEEP GOING. Two different questions, and conflating them cost a
// day of reading one as the other.
//
// Without `--cycle` this measures ONE crossing per character: everybody starts somewhere
// different, everybody walks to one room, and a character that gets there is finished. That is
// the right shape for "can the fleet cross the map", and every earlier run used it, so it stays
// the default and stays comparable.
//
// It is NOT a loop, and it was being read as one. Characters that arrived stood at the
// destination for the rest of the window with no objective, which looks exactly like being
// stuck — thirteen of them at once — and it means a longer timeout buys nothing for anyone who
// arrives early. `--cycle` is the loop that reading assumed: arrive, then set off for the next
// place, until the clock stops. It measures sustained travel rather than one crossing, so the
// headline number becomes LEGS COMPLETED rather than characters arrived.
const CYCLE = has('cycle');
const MAINLAND = ['Tos', 'Barloque', 'Cornoth', 'Marion', 'Jasper'];
const CITIES = flag('inns') ? String(flag('inns')).split(',').map(s => s.trim()) : MAINLAND;
for (const c of CITIES) if (!CITY_INNS[c]) {
  console.error(`m59-pilgrimage: no inn known for "${c}". Known: ${Object.keys(CITY_INNS).join(', ')}`);
  process.exit(2);
}

// A SEEDED SHUFFLE, so a run can be repeated against a change rather than compared with a
// different draw. `--seed` is printed in the header for exactly that reason.
const SEED = Number(flag('seed', 1));
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

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
        let text = null;
        try { text = JSON.parse(t).result.content[0].text; }
        catch (e) { return done({ _error: `no result from ${name}: ${String(t).slice(0, 80)}` }); }
        // A TOOL THAT REFUSES ANSWERS IN PROSE. `travel` replies "error: <agent> is not in
        // game" as bare text, and parsing that as JSON reports a SyntaxError — which reads
        // like a broken tool instead of a refused request, and put three characters in the
        // first run's report as "Unexpected token 'e'".
        try { done(JSON.parse(text)); }
        catch { done({ _error: String(text).trim().slice(0, 120) }); }
      });
    });
    req.on('timeout', () => { req.destroy(); done({ _error: 'timeout' }); });
    req.on('error', e => done({ _error: e.message }));
    req.end(body);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A detached deployment checkout deliberately does not carry the gitignored roster. Honour
// the same explicit state-file override as the service tools so an operator can run this
// exact committed harness against the canonical roster without copying account state.
const configuredStateFile = String(process.env.M59_STATE_FILE ?? '').trim();
const rosterFile = configuredStateFile ? resolve(configuredStateFile)
  : FLEET === '-' ? join(REPO, 'substrate', 'fleet-state.json')
                  : join(REPO, 'substrate', 'fleets', `${FLEET}.json`);
const rostered = rosterGameEndpoint(rosterFile);
if (!rostered) {
  console.error(`m59-pilgrimage: ${rosterFile} does not name one game server.`);
  process.exit(2);
}
if (!LOOPBACK.has(rostered.host.toLowerCase())) {
  console.error(`m59-pilgrimage: REFUSING. Fleet "${FLEET}" is on ${rostered.host}:${rostered.port}, not loopback.`);
  console.error('          Relocating bodies is a lab-server power. On a real server the fleet');
  console.error('          has to WALK to the inns, which is a different experiment.');
  process.exit(2);
}

const fleet = await call('fleet', {});
if (fleet._error) { console.error(`m59-pilgrimage: broker on ${PORT} did not answer (${fleet._error})`); process.exit(1); }
let rows = (fleet.fleet ?? []).filter(r => r.agent && r.character);
if (ONLY) rows = rows.filter(r => ONLY.includes(r.agent) || ONLY.includes(r.character));
rows.sort((a, b) => a.agent.localeCompare(b.agent, 'en', { numeric: true }));
if (!rows.length) { console.error('m59-pilgrimage: no characters matched.'); process.exit(1); }

// Deal the cities round-robin over a shuffled roster rather than choosing independently at
// random per character: an independent draw over 21 characters routinely leaves a city with
// one traveller and another with seven, and then the per-city column is noise.
const draw = rng(SEED);
const order = rows.map((r, i) => ({ r, k: draw(), i }))
                  .sort((a, b) => a.k - b.k || a.i - b.i).map(x => x.r);
const assignment = new Map();
order.forEach((r, n) => assignment.set(r.agent, CITIES[n % CITIES.length]));

// THE RING A CYCLING CHARACTER WALKS. The five city inns and the destination, which is the
// operator's "five towns and Castle Victoria" said as a list of rooms. Each character enters
// it at its own city, so twenty-one of them are spread around the ring rather than all walking
// the same leg at once — which would measure contention, not roads.
//
// AND ROOM 110, "A shadowy corner", ADDED 2026-08-28 ON PURPOSE.
//
// The other six stops are inns and a castle gate — the easy ends of roads. 110 is reached
// through the Sewers of Barloque, and row 27 of that sewer is the hardest ground the fleet
// walks: six giant rats one per square across columns 40-45, sixty-four apart, that do not
// move, in a pipe whose floor is ONE SQUARE WIDE at columns 39-41. It is the Twisted Wood
// claim again with the margin cut to half a unit, and it has a fall-jump in it.
//
// A ring made only of easy ends measures the roads nobody was worried about. This one is here
// because it is the leg we expect to fail, and a cycle that never attempts it cannot tell us
// whether any of today's work helped where it matters.
const SHADOWY_CORNER = { room: 110, name: 'A shadowy corner', city: null };
// AND `--reverse` WALKS THE SAME RING THE OTHER WAY, WHICH IS NOT THE SAME TEST.
//
// An exit is not a door and exits are not 1:1 — the map's own rule — so the road from A to B
// and the road from B to A are two roads, baked from two anchors, and only one of them has
// been measured by a forward cycle. Room 578 is the standing example: the operator walked
// 35,1 -> 49,12 and found the reverse baked straight through a mountain. A ring walked in one
// direction can report every leg green while half the world's doorways have never been tried.
//
// The first square each character starts from is unchanged, so the two runs are comparable
// leg for leg: `106 -> 153` forward is the same pair of rooms as `153 -> 106` reversed.
const RING_FORWARD = [...CITIES.map(c => ({ room: CITY_INNS[c].inn, name: CITY_INNS[c].innName, city: c })),
                      { room: TO, name: null, city: null },
                      SHADOWY_CORNER];
const REVERSE = has('reverse');
const RING = REVERSE ? RING_FORWARD.slice().reverse() : RING_FORWARD;

const destName = fleet.rooms?.[String(TO)]?.name ?? null;
console.log(`fleet "${FLEET}" -> ${rostered.host}:${rostered.port}`);
console.log(CYCLE
  ? `${rows.length} character(s) scattered over ${CITIES.length} inn(s), CYCLING the ring of ` +
    `${RING.length} rooms ${REVERSE ? 'REVERSED' : 'forward'} for ${TIMEOUT / 1000}s, seed ${SEED}`
  : `${rows.length} character(s) scattered over ${CITIES.length} inn(s), all bound for ` +
    `room ${TO}${destName ? ` (${destName})` : ''}, ${TIMEOUT / 1000}s each, seed ${SEED}`);
for (const c of CITIES) {
  const n = [...assignment.values()].filter(v => v === c).length;
  console.log(`  ${c.padEnd(10)} inn ${String(CITY_INNS[c].inn).padStart(4)}  ${CITY_INNS[c].innName.padEnd(34)} ${n} traveller(s)`);
}
console.log();
if (DRY) {
  for (const r of order) console.log(`  ${r.character.padEnd(8)} (${r.agent})  from ${assignment.get(r.agent)}`);
  process.exit(0);
}

const dm = await import('./m59-dm.mjs');

async function launch(r) {
  const city = assignment.get(r.agent);
  const inn = CITY_INNS[city].inn;
  // A CYCLING CHARACTER ENTERS THE RING AT ITS OWN CITY and walks to the next room along, so
  // twenty-one of them are spread around it rather than all on one leg. `legs` is the record
  // of every completed crossing; it is what the cycle is measured on.
  const at = Math.max(0, RING.findIndex(x => x.room === inn));
  const out = { character: r.character, agent: r.agent, city, inn,
                began: Date.now(), rooms: new Set(), low: null, outcome: 'running',
                ring: at, to: CYCLE ? RING[(at + 1) % RING.length].room : TO,
                legBegan: Date.now(), legs: [], pendingDispatch: null,
                dispatchRetries: 0 };
  // Idle, unparked and NOT roaming: a character that wanders off to hunt is not measuring
  // the road, and `roam` is the one setting that quietly reintroduces that.
  await call('autopilot', { agent: r.agent, mode: 'idle', roam: false, confine_rooms: [] });
  await call('autopilot', { agent: r.agent, action: 'unpark' });
  await dm.relocate([r.character], inn, { verify: false }).catch(() => null);

  // WHOLE, AND ALL THREE VITALS. `recoverUntilWhole` is set by a death and stays set until
  // health, mana AND vigor are back; while it is up, the first rung of the ladder ends every
  // tick and `travel` is refused the instant it is asked. A leg that starts under that hold
  // measures the hold. See the same argument in m59-solo-run.mjs.
  try {
    const ids = await dm.resolve([r.character]);
    // THE MAX IS IN THE HEALTH STRING, NOT IN A FIELD. A fleet row carries
    // `health: "53/53"` and `max_health: undefined` -- which the report below already knows
    // and this did not, so `max` was null, the guard failed, and the heal was SILENTLY
    // SKIPPED on every leg since it was written. Characters started each run at whatever
    // health the last one left them at, and a `recoverUntilWhole` hold from a death was
    // still up, which by the note above makes travel refuse instantly. Every run-to-run
    // comparison made tonight rests on a reset that never happened.
    const max = Number(r.max_health ?? r.maxHealth
                       ?? String(r.health ?? '').split('/')[1]) || null;
    if (ids?.[r.character] != null && max) {
      const cmds = [...dm.healthCmds(ids[r.character], max)];
      if (typeof dm.manaCmds === 'function') cmds.push(...dm.manaCmds(ids[r.character], 50));
      await dm.dm(cmds, { timeoutMs: 60000 });
    }
  } catch { /* healing is a courtesy; the leg is still a leg without it */ }

  const sent = await call('travel', { agent: r.agent, to: out.to, max_hops: 30, background: true,
                                      run_errands: false });
  out.pendingDispatch = noteDispatchResult(
    newPendingDispatch(out.to, 'initial', out.legBegan), sent, Date.now());
  return out;
}

async function submitPendingDispatch(o) {
  const pending = o.pendingDispatch;
  if (!pending) return;

  // The fleet row is the cheap first gate. A detailed status read happens only when a
  // handoff is otherwise ready to send, and catches a dormant suspended journey that the
  // compact fleet row intentionally does not publish. Failure to verify defers movement;
  // uncertainty is not permission to put a second driver on the character.
  const status = await call('autopilot', { agent: o.agent, action: 'status' }, 15000);
  const verificationFailure = keeperStatusVerificationFailure(status);
  if (verificationFailure) {
    const failures = Number(pending.verification_failures ?? 0) + 1;
    o.pendingDispatch = {
      ...pending,
      verification_failures: failures,
      retry_at: Date.now() + 5000,
      ...(failures >= DISPATCH_MAX_ATTEMPTS
        ? { attempts: DISPATCH_MAX_ATTEMPTS,
            last_refusal: `could not verify keeper state: ${verificationFailure}` } : {}),
    };
    return;
  }
  if (keeperStatusOwnsMovement(status)) {
    o.pendingDispatch = { ...pending, retry_at: Date.now() + 5000 };
    return;
  }

  const sent = await call('travel', { agent: o.agent, to: pending.to, max_hops: 30,
                                      background: true, run_errands: false });
  const next = noteDispatchResult(pending, sent, Date.now());
  if (next.attempts > 1) o.dispatchRetries++;
  o.pendingDispatch = next;
}

// ONE POLL FOR THE WHOLE FLEET, NOT ONE PER CHARACTER.
//
// The first version asked `autopilot action=status` per character every five seconds — 21
// requests a cycle into a broker whose event loop the same 21 keepers are already sharing,
// to answer a question that one `fleet` call answers for everybody. It also read the wrong
// field: a fleet row's `room` is the room's NAME and `room_num` is the number, so every
// reading came back NaN and the whole first run reported "timed out ... NaN".
async function watchAll(outs) {
  const live = new Map(outs.filter(o => o.outcome === 'running').map(o => [o.agent, o]));
  const began = Date.now();
  while (live.size && Date.now() - began < TIMEOUT) {
    await sleep(5000);
    const snap = await call('fleet', {}, 60000);
    if (snap?._error) continue;
    for (const row of (snap.fleet ?? [])) {
      const o = live.get(row.agent);
      if (!o) continue;
      const room = Number(row.room_num ?? NaN);
      if (Number.isFinite(room)) { o.rooms.add(room); o.ended = room; o.endedName = row.room ?? null; }
      // A FLEET ROW'S `health` IS THE STRING "53/53", AND `max_health` IS NULL.
      //
      // `Number("53/53")` is NaN, so `low` was never recorded and the report's `low` column
      // was blank on every row of every run this tool has ever produced. Worse than cosmetic:
      // the death-retry gate below needs `hp / max >= 0.95`, and with both NaN it is always
      // false — so a character that died, walked itself to an inn and rested to full was never
      // sent out again. That is very likely the fourteen characters found sitting in inns at
      // full health at the end of the 1800s run, read at the time as an unexplained stall.
      //
      // The same comment two screens up says a fleet row's `room` is the NAME and `room_num`
      // is the number. The health pair has the same shape and was missed.
      const [hpRaw, maxRaw] = String(row.health ?? '').split('/');
      const hp = Number(hpRaw);
      const max = Number(row.max_health ?? row.health_max ?? maxRaw);
      if (Number.isFinite(hp)) o.low = o.low === null ? hp : Math.min(o.low, hp);
      if (Number.isFinite(max)) o.max = max;
      // THE UNDERWORLD IS A DEATH, and it is the only honest way to see one from here: the
      // journey does not report it, the room read does.
      //
      // A DEATH IS NOT THE END OF THE MEASUREMENT ANY MORE, AND THAT WAS THIS TOOL'S BIGGEST
      // DISTORTION. It used to record `died` and `live.delete` the character — walking away
      // for the rest of the window. So the headline number was never "can the fleet cross the
      // map"; it was "how often does somebody cross WITHOUT DYING EVEN ONCE", which is the
      // death rate wearing a different hat. Measured 2026-08-27: raising the clock from 10 to
      // 40 minutes moved arrivals 4 -> 8 and then flat for 28 minutes, because the twelve who
      // had died were sitting in inns at full health with nothing left to do.
      //
      // The keeper's own `travel_deaths_allowed` is a DIFFERENT question — whether the keeper
      // resumes on its own — and at its default of 0 it does not. Nothing marks the character
      // defective either way: the counter is cleared with the objective, so a fresh `travel`
      // is a completely clean attempt. So the harness re-issues one.
      if (room === UNDERWORLD) {
        if (o.state !== 'dead') {
          o.state = 'dead';
          o.pendingDispatch = null;
          o.deaths = (o.deaths ?? 0) + 1;
          o.diedAt = (o.diedAt ?? []); o.diedAt.push(Math.round((Date.now() - o.began) / 1000));
          if (!RETRY) { o.outcome = 'died'; o.ms = Date.now() - o.began; live.delete(row.agent); }
        }
        continue;
      }
      // OUT OF THE UNDERWORLD AND WHOLE AGAIN — send it off once more.
      //
      // Both conditions matter. The keeper walks itself out to the nearest city inn (the one
      // thing above the inert gate) and then rests; re-issuing before that is asking a
      // character to set off at 2 of 37, and `recoverUntilWhole` refuses `travel` outright
      // while it is up, so an early retry measures the hold rather than the road.
      if (o.state === 'dead' && room !== UNDERWORLD) {
        const whole = Number.isFinite(hp) && Number.isFinite(max) ? hp / max >= 0.95 : false;
        if (!whole) continue;
        o.state = 'dispatching';
        o.retries = (o.retries ?? 0) + 1;
        o.pendingDispatch = newPendingDispatch(o.to, 'death', Date.now());
        if (dispatchDecision(o.pendingDispatch, row, Date.now(), {
          underworld: UNDERWORLD, maxAttempts: DISPATCH_MAX_ATTEMPTS,
        }).action === 'send') await submitPendingDispatch(o);
        continue;
      }

      // A BACKGROUND ACKNOWLEDGEMENT IS NOT PROOF OF A JOB. The keeper can still be winding
      // down the leg that just arrived; it refuses the next one as busy, while the broker's
      // proxy has historically answered {started:true} before seeing that refusal. Four
      // characters accumulated in room 110 in one run through exactly that race.
      //
      // A pending handoff therefore advances only on a later fleet snapshot: the exact new
      // busy label (or a target-specific resumed journey) confirms it. Broad recovery and an
      // unrelated job merely keep the handoff waiting. A masked no-start gets three bounded
      // attempts and then becomes an explicit result instead of silent parking.
      if (o.pendingDispatch) {
        const decision = dispatchDecision(o.pendingDispatch, row, Date.now(), {
          underworld: UNDERWORLD, maxAttempts: DISPATCH_MAX_ATTEMPTS,
        });
        if (decision.action === 'arrived') {
          o.pendingDispatch = null;
          o.state = 'running';
          // Fall through: this is a very short leg that arrived before a busy snapshot.
        } else if (decision.action === 'confirmed') {
          o.pendingDispatch = null;
          o.state = 'running';
          continue;
        } else if (decision.action === 'send') {
          await submitPendingDispatch(o);
          continue;
        } else if (decision.action === 'exhausted') {
          o.pendingDispatch = null;
          o.outcome = 'refused';
          o.why = decision.why;
          o.ms = Date.now() - o.began;
          live.delete(row.agent);
          continue;
        } else {
          continue;
        }
      }

      if (room === o.to) {
        // ONE LEG DONE. Recorded either way — in cycle mode it is a row in a series, and
        // without it, it is the whole measurement. Death recovery is handled above so an
        // Underworld portal landing at the target inn cannot masquerade as a completed road.
        if (!CYCLE) {
          o.legs.push({ from: o.legFrom ?? o.inn, to: o.to, ms: Date.now() - o.legBegan,
                        deaths: (o.deaths ?? 0) - (o.deathsAtLegStart ?? 0) });
          o.outcome = 'arrived'; o.ms = Date.now() - o.began; live.delete(row.agent); continue;
        }
        // RECORD NOW, DISPATCH ONLY WHEN CLEAR. `o.to` advances exactly once, so another
        // poll cannot double-count the arrival. The pending state asks a detailed keeper
        // status before sending, or waits for the old job to unwind when this row says busy.
        completeCycleArrival(o, RING, Date.now());
        if (dispatchDecision(o.pendingDispatch, row, Date.now(), {
          underworld: UNDERWORLD, maxAttempts: DISPATCH_MAX_ATTEMPTS,
        }).action === 'send') await submitPendingDispatch(o);
        continue;
      }
    }
  }
  for (const o of live.values()) {
    o.outcome = CYCLE ? 'cycling' : (o.deaths ? 'still trying' : 'timed out');
    o.ms = Date.now() - o.began;
  }
  return outs;
}

console.log('launching…');
const launched = [];
for (const r of order) {
  launched.push(await launch(r));
  await sleep(400);           // the pacer is per character; this is only to be kind to the DM port
}
const results = await watchAll(launched);

// ------------------------------------------------------------------ the report
const pad = (s, n) => String(s ?? '').padEnd(n);

// A CYCLE IS JUDGED ON LEGS, NOT ON ARRIVALS.
//
// "Nine of twenty-one arrived" is the right headline for one crossing each and a meaningless
// one for a loop, where a character that walked six legs and one that walked none both end the
// window mid-journey. So the cycle prints what it actually measured: how many crossings the
// fleet completed, how long they took, and how many deaths it cost — per road, because the
// per-road column is the one that has been carrying the finding every time.
if (CYCLE) {
  const legs = results.flatMap(o => o.legs.map(l => ({ ...l, who: o.character })));
  const deaths = results.reduce((a, o) => a + (o.deaths ?? 0), 0);
  const dispatchRetries = results.reduce((a, o) => a + (o.dispatchRetries ?? 0), 0);
  const dispatchFailures = results.filter(o => o.outcome === 'refused');
  const mins = TIMEOUT / 60000;
  console.log(`\nTHE CYCLE`);
  console.log(`  legs completed  ${legs.length}   by ${results.filter(o => o.legs.length).length} of ${results.length} characters`);
  console.log(`  deaths          ${deaths}`);
  console.log(`  handoff retries ${dispatchRetries}`);
  console.log(`  handoff failures ${dispatchFailures.length}`);
  console.log(`  legs per character  min ${Math.min(...results.map(o => o.legs.length))}, ` +
              `max ${Math.max(...results.map(o => o.legs.length))}, ` +
              `avg ${(legs.length / results.length).toFixed(1)} over ${mins.toFixed(0)} minutes`);
  if (legs.length) {
    const t = legs.map(l => l.ms).sort((a, b) => a - b);
    console.log(`  a completed leg took  fastest ${Math.round(t[0] / 1000)}s, ` +
                `median ${Math.round(t[t.length >> 1] / 1000)}s, ` +
                `slowest ${Math.round(t[t.length - 1] / 1000)}s`);
    console.log(`  legs per death        ${deaths ? (legs.length / deaths).toFixed(1) : '∞'}`);
  }
  console.log('\n  BY THE ROAD THEY WALKED');
  const byRoad = new Map();
  for (const l of legs) {
    const k = `${l.from} -> ${l.to}`;
    const e = byRoad.get(k) ?? { n: 0, ms: 0, deaths: 0 };
    e.n++; e.ms += l.ms; e.deaths += l.deaths ?? 0; byRoad.set(k, e);
  }
  // AND THE ROADS NOBODY FINISHED. A road that never appears above is the interesting one and
  // it is invisible in a table of completions, which is how "Marion 0/4" nearly got averaged
  // away the first time.
  const attempted = new Map();
  for (const o of results) if (o.outcome === 'cycling' || o.outcome === 'refused') {
    const k = `${o.legFrom ?? o.inn} -> ${o.to}`;
    attempted.set(k, (attempted.get(k) ?? 0) + 1);
  }
  const roads = new Set([...byRoad.keys(), ...attempted.keys()]);
  console.log('    road                 done   avg    deaths   unfinished at the bell');
  for (const k of [...roads].sort()) {
    const e = byRoad.get(k) ?? { n: 0, ms: 0, deaths: 0 };
    console.log('    ' + pad(k, 20) + String(e.n).padStart(5)
      + (e.n ? String(Math.round(e.ms / e.n / 1000) + 's').padStart(7) : '      —')
      + String(e.deaths).padStart(9) + String(attempted.get(k) ?? 0).padStart(9));
  }
  console.log('\n  WHERE EACH CHARACTER GOT TO');
  for (const o of results.sort((a, b) => b.legs.length - a.legs.length))
    console.log('    ' + pad(o.character, 9) + String(o.legs.length).padStart(3) + ' leg(s)'
      + String(o.deaths ?? 0).padStart(4) + ' death(s)   '
      + pad(String(o.ended ?? '?') + (o.endedName ? ' ' + o.endedName : ''), 26)
      + (o.low === null ? '' : `  low ${o.low}${o.max ? '/' + o.max : ''}`)
      + (o.why ? `  — ${o.why}` : ''));
  console.log('');
  process.exit(dispatchFailures.length ? 1 : 0);
}
console.log('\n  character  from        outcome      s  died  ended            low');
for (const o of results.sort((a, b) => a.city.localeCompare(b.city) || a.character.localeCompare(b.character)))
  console.log('  ' + pad(o.character, 10) + pad(o.city, 11) + pad(o.outcome, 11) +
              String(Math.round(o.ms / 1000)).padStart(4) +
              String(o.deaths ?? 0).padStart(6) + '  ' +
              pad(String(o.ended ?? '?') + (o.endedName ? ' ' + o.endedName : ''), 17) +
              (o.low === null ? '' : ' ' + o.low + (o.max ? '/' + o.max : '')) +
              (o.why ? '  — ' + o.why : ''));

const n = results.length;
const arrived = results.filter(o => o.outcome === 'arrived');
const died = results.filter(o => o.outcome === 'died');
const refused = results.filter(o => o.outcome === 'refused');
const out = results.filter(o => o.outcome === 'timed out');
console.log('\nFLEET');
console.log(`  set off   ${n}`);
console.log(`  arrived   ${arrived.length}  (${Math.round(100 * arrived.length / n)}%)`);
console.log(`  died      ${died.length}`);
console.log(`  timed out ${out.length}`);
if (refused.length) console.log(`  refused   ${refused.length}`);
const stillTrying = results.filter(o => o.outcome === 'still trying');
if (stillTrying.length) console.log(`  still trying when the window closed  ${stillTrying.length}`);
if (arrived.length) {
  const t = arrived.map(o => o.ms).sort((a, b) => a - b);
  console.log(`  of those that arrived: fastest ${Math.round(t[0] / 1000)}s, ` +
              `median ${Math.round(t[t.length >> 1] / 1000)}s, slowest ${Math.round(t[t.length - 1] / 1000)}s`);
}

// WHAT THE ROAD COST, WHICH IS THE HALF AN ARRIVAL RATE CANNOT SHOW.
//
// With retries on, "arrived" stops being a proxy for "never died" and the two become separate
// facts: a character that arrived after three deaths and one that walked it clean are both
// arrivals, and the difference between them IS the road.
//
// Per character as well as in total, because one character dying nine times and nine
// characters dying once give the same total and are completely different problems — the first
// is one stuck character, the second is a dangerous corridor. Both happened here.
const deathCounts = results.map(o => o.deaths ?? 0);
const totalDeaths = deathCounts.reduce((a, b) => a + b, 0);
console.log('\nWHAT IT COST');
console.log(`  total deaths            ${totalDeaths}` +
            (RETRY ? '' : '   (--no-retry: at most one each, then abandoned)'));
if (totalDeaths) {
  const bitten = deathCounts.filter(d => d > 0).sort((a, b) => a - b);
  console.log(`  characters that died    ${bitten.length} of ${n}`);
  console.log(`  deaths per character    min ${bitten[0]}, max ${bitten[bitten.length - 1]}, ` +
              `avg ${(totalDeaths / n).toFixed(2)} over the fleet, ` +
              `${(totalDeaths / bitten.length).toFixed(2)} among those that died`);
  console.log(`  arrived without dying   ${arrived.filter(o => !o.deaths).length} of ${arrived.length} arrivals`);
  const worst = results.filter(o => (o.deaths ?? 0) > 0)
    .sort((a, b) => (b.deaths ?? 0) - (a.deaths ?? 0)).slice(0, 5);
  console.log('  worst hit: ' + worst.map(o => `${o.character} x${o.deaths}` +
    (o.diedAt?.length ? ` (at ${o.diedAt.join('s, ')}s)` : '')).join('; '));
}

console.log('\nBY THE ROAD THEY TOOK');
for (const c of CITIES) {
  const mine = results.filter(o => o.city === c);
  if (!mine.length) continue;
  const ok = mine.filter(o => o.outcome === 'arrived').length;
  // WHO DIED ON THIS ROAD, not who ENDED as a death — with retries on those are different
  // numbers and the first is the one about the road.
  const d = mine.filter(o => (o.deaths ?? 0) > 0).length;
  console.log(`  ${pad(c, 10)} ${ok}/${mine.length} arrived` + (d ? `, ${d} died` : '') +
              '   ' + '#'.repeat(ok) + '.'.repeat(mine.length - ok));
}

const stuck = {};
for (const o of results) {
  if (o.outcome === 'arrived') continue;
  const k = (o.ended ?? '?') + (o.endedName ? ' ' + o.endedName : '');
  stuck[k] = (stuck[k] || 0) + 1;
}
if (Object.keys(stuck).length) {
  console.log('\nWHERE THE REST ENDED UP');
  for (const [k, v] of Object.entries(stuck).sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(v).padStart(3)}  ${k}`);
}
