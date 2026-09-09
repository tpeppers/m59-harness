#!/usr/bin/env node
// PUT THE FLEET SOMEWHERE NOTHING CAN HIT IT, THEN RESTART THE KEEPERS.
//
//   node tools/m59-friendly-reboot.mjs                  # the plan, changes nothing
//   node tools/m59-friendly-reboot.mjs --go             # evacuate, then restart keepers
//   node tools/m59-friendly-reboot.mjs --go --seconds 10
//   node tools/m59-friendly-reboot.mjs --go --agents t4,t7
//
// WHY THIS EXISTS. A keeper restart is a LOGOFF: `POST /stop` closes the game socket and
// exits (m59-keeper-process.mjs), and the broker's 45s rejoin sweep brings the character
// back from the roster on disk. That is already safe while the keeper is down — a character
// that is not in the world cannot be hit.
//
// The danger is WHERE IT COMES BACK. It logs in exactly where it logged off, and if that is
// the middle of a monster room at a fifth of its health, the new keeper inherits a fight it
// did not choose, at the worst moment, with no idea what has been hitting it. So the useful
// thing to do before a restart is not to hurry — it is to spend a few seconds walking
// everybody somewhere nothing reaches, and let them come back standing in it.
//
// THE MEASUREMENT THAT MOTIVATED IT, and the honest version of it. Deaths within 15 minutes
// of each of three deploys on 2026-09-08, against a fleet baseline of 0.18 per 15 minutes:
// 0, then 2 (Waldorf and Animal), then 0. One spike in three, and it was the deploy that
// restarted keepers. That is suggestive and it is n=3; the demonstrated killer that day was
// resting in the open, which is fixed separately by the `safeRest` guarantee in
// m59-fleetscript.mjs. This tool narrows a window rather than closing a proven wound, and
// saying so is the difference between a safeguard and a superstition.
//
// WHAT IT WILL NOT DO. It does not fight. Reaching a safe spot is a walk, and if a character
// cannot make the walk in the time allowed it is logged off where it stands — which is
// strictly safer than leaving it in the world with no keeper, because a logged-off character
// takes no hits at all. It never stops the broker: the broker is what runs the sweep that
// brings everybody back, and stopping it turns a 45-second gap into a manual recovery.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const val = (flag, fallback = null) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const GO = has('--go');
// Five to ten seconds is the operator's range and the reason is the shape of the job: a
// safe spot is usually a few squares away, and a walk that has not landed in ten seconds is
// not going to land — it is blocked, and the character is better off logged off than stood
// in the open waiting for it.
const SECONDS = Math.min(30, Math.max(2, Number(val('--seconds', '8')) || 8));
const PORT = Number(val('--port', '8901')) || 8901;
const ONLY = (val('--agents', '') || '').split(',').map(s => s.trim()).filter(Boolean);

const rpc = async (name, params, ms = 30_000) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/`, {
    // The deadline goes WITH the call. Without it the broker finishes work this side has
    // already given up on — which is what made the first live run of this tool report
    // `unknown` for eleven of twenty-one characters against a broker that was recovering.
    method: 'POST', headers: { 'content-type': 'application/json',
                               'x-m59-deadline-ms': String(Math.max(250, Math.round(ms))) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                           params: { name, arguments: params } }),
    signal: AbortSignal.timeout(ms),
  });
  const j = await r.json();
  const text = j?.result?.content?.find(c => c.type === 'text')?.text;
  if (j?.error || j?.result?.isError) throw new Error(text || j?.error?.message || 'tool failed');
  try { return JSON.parse(text); } catch { return text; }
};

const health = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(20_000) })
  .then(r => r.json())
  .catch(() => null);
if (!health?.ok) {
  console.error(`no broker answers on 127.0.0.1:${PORT}. This tool never starts one.`);
  process.exit(2);
}
const agents = (health.sessions ?? []).filter(a => !ONLY.length || ONLY.includes(a));
if (!agents.length) { console.error('no sessions to move'); process.exit(2); }

console.log(`fleet "${health.fleet}" — ${agents.length} character(s), broker pid ${health.pid}`);
console.log(`${GO ? 'evacuating' : 'PLAN ONLY (pass --go to act)'}, ${SECONDS}s to reach a spot\n`);

// ---------------------------------------------------------------- the keeper ports
//
// Found once and reused by every phase. A keeper is discovered by ASKING each port in the
// fleet's band who it is, never by assuming an order: the band is a starting point, and a
// keeper that restarts lands wherever the broker puts it.
const band = (() => {
  try {
    const bands = JSON.parse(readFileSync(new URL('../substrate/keeper-bands.json', import.meta.url), 'utf8'));
    return bands[health.fleet] ?? null;
  } catch { return null; }
})();

async function keeperMap() {
  const found = new Map();
  if (!band) return found;
  await Promise.all(Array.from({ length: 30 }, async (_, i) => {
    const port = band + i;
    const h = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.json()).catch(() => null);
    if (h?.agent && agents.includes(h.agent)) found.set(h.agent, { port, ...h });
  }));
  return found;
}

// ---------------------------------------------------------------- phase 0: write it down
//
// WHAT EACH CHARACTER WAS DOING, BEFORE ANYTHING TOUCHES IT.
//
// Most of what a keeper is comes back on its own. Credentials and the autopilot policy live
// in the ROSTER — every `rememberAutopilot` is followed by a `saveFleetState` — so mode,
// hunt list, assigned room and every threshold survive a restart without help. What does NOT
// survive is transient work: a journey in flight, a hold, an errand halfway through.
//
// So this does not try to rebuild a keeper. It writes down what was true, which is the part
// that is otherwise unrecoverable, and the report afterwards names anything that was dropped.
// A restart that loses an errand silently is how "the fleet is behaving oddly" becomes a
// two-hour investigation with no starting point.
async function capture(keepers) {
  const rows = [];
  await Promise.all([...keepers.entries()].map(async ([agent, k]) => {
    const st = await fetch(`http://127.0.0.1:${k.port}/state?agent=${encodeURIComponent(agent)}`
        + `&character=${encodeURIComponent(k.character ?? '')}`, { signal: AbortSignal.timeout(8000) })
      .then(r => r.json()).catch(() => null);
    rows.push({
      agent, character: k.character ?? null, keeper_pid: k.pid ?? null, port: k.port,
      room: st?.room?.num ?? null, room_name: st?.room?.name ?? null,
      hp: st?.hp ?? null, in_game: st?.in_game ?? null,
      // The two that do not come back by themselves.
      job: st?.job ?? null, hold: st?.hold ?? null,
      // Policy is recorded for the diff afterwards, NOT to restore it: the roster already
      // carries it, and writing it back would fight whoever changed it while we were down.
      mode: st?.autopilot_status?.mode ?? null,
      assigned_room: st?.autopilot_status?.policy?.assignedRoom ?? null,
    });
  }));
  return rows.sort((a, b) => a.agent.localeCompare(b.agent));
}

// Discover the keepers and write down what they were doing, BEFORE anything moves. Both
// phases below need this map, and capturing after the walk would record where we put them
// rather than where we found them.
const before = await keeperMap();
if (!band) { console.error('no keeper band for this fleet; not guessing ports'); process.exit(3); }
const handoff = await capture(before);
const handoffDir = new URL('../substrate/reboot-handoffs/', import.meta.url);
let handoffPath = '(not written — plan only)';
if (GO) {
  try {
    mkdirSync(handoffDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    handoffPath = new URL(`${health.fleet}-${stamp}.json`, handoffDir).pathname.replace(/^\//, '');
    writeFileSync(handoffPath, JSON.stringify(
      { at: Date.now(), iso: new Date().toISOString(), fleet: health.fleet,
        broker_pid: health.pid, seconds: SECONDS, characters: handoff }, null, 2));
  } catch (e) { handoffPath = `(could not write: ${e.message})`; }
}
const inFlight = handoff.filter(r => r.job || r.hold).length;
console.log(`${before.size} keeper(s) found, ${inFlight} with work in flight
`);

// ---------------------------------------------------------------- phase 1: get safe
//
// In parallel, because the deadline is wall-clock for the whole fleet rather than per
// character: twenty-one sequential walks would spend the budget on the first three.
// THE BUDGET IS FOR WALKING, NOT FOR ASKING. Spending it on the reads is how the first run
// of this reported `unknown` for eleven of twenty-one characters: twenty-one parallel
// safe_spots calls against a broker that was still coming back ate the whole eight seconds
// before anybody had been told where to go. The clock starts once we know the answers.
//
// The reads get their own generous timeout for the same reason the Quartermaster backs off:
// a broker measured at 1046ms idle and 2573ms under load is not being helped by a short
// deadline, it is just being asked a question it cannot finish.
const READ_MS = Math.max(20_000, SECONDS * 1000);
let deadline = Date.now() + READ_MS;
const left = () => Math.max(0, deadline - Date.now());
const startWalkClock = () => { deadline = Date.now() + SECONDS * 1000; };

// ONE SQUARE PER CHARACTER. Asked independently, every character picks the SAME best
// square — the first dry run put sixteen of twenty-one on r1c24. That is not a tie-break
// problem, it is the fleet crowding onto its own shelter, and `safe_spots` already records
// what it costs: 78% of the failure rows in the book are room 39, "the fleet crowding onto
// its own shelter, recorded as walls that leak". Piling the fleet onto one square would
// manufacture more of exactly that evidence while leaving most of them unprotected.
//
// So the reads happen in parallel and the ASSIGNMENT is sequential: each character takes
// the best square nobody has claimed yet. Deterministic, and it degrades honestly — when
// the spots run out the remainder are reported `nowhere-safe` rather than stacked.
async function look(agent) {
  const seen = await rpc('safe_spots', { agent, reachable_only: true }, READ_MS)
    .catch(e => ({ error: e.message }));
  return { agent, seen };
}

function assign(reads) {
  const claimed = new Set(), out = [];
  for (const { agent, seen } of reads) {
    if (seen?.error) { out.push({ agent, state: 'unknown', why: seen.error }); continue; }
    const here = seen.in_a_safe_spot_now;
    if (here && typeof here === 'object' && here.works !== false) {
      // Already standing in one: claim it so nobody is sent on top of them.
      if (here.at) claimed.add(`${here.at.col},${here.at.row}`);
      out.push({ agent, state: 'already-safe', at: here.at ?? null });
      continue;
    }
    // SAFETY IS `can_reach_you === 0`, NOT THE BOOK. The first live run walked nobody
    // anywhere useful because both halves of this were wrong.
    //
    // `can_reach_you` is how many of the 28 squares within melee reach something could
    // actually swing at you from, filtered by the server's own line-of-sight walk. Zero is
    // the property that matters and it is on every row, whoever has stood there.
    //
    // THE `tested` FIELD IS GONE AND NOTHING HERE MOURNS IT. It reported the retired book's
    // standing for a square, and both uses of it were wrong in the same direction: the
    // filter excluded squares on evidence that is 89% mis-recorded retaliation, and the
    // three-square handicap for `holds` preferred squares the fleet crowded onto in August.
    // Geometry is on every row and needs no history.
    //
    // AND DISTANCE IS THE OTHER HALF, because this is a TIMED walk. The first run picked
    // geometrically perfect squares 38 squares away and gave everybody ten seconds to reach
    // them; at roughly a square a second not one of twenty-one arrived. A near square that
    // nothing can reach beats a perfect one nobody gets to.
    const usable = (seen.spots ?? []).filter(x => x.can_reach_you === 0
      && Number.isInteger(x.col) && Number.isInteger(x.row)
      && !claimed.has(`${x.col},${x.row}`));
    // Ties break toward the square that is harder to walk INTO — the operator's definition
    // of a wall, and free to consult since `safeSpots()` already publishes it.
    const cost = (x) => (Number.isFinite(x.distance) ? x.distance : 999)
                      - Math.min(3, (x.refused_approaches ?? 0));
    const target = usable.sort((a, b) => cost(a) - cost(b))[0] ?? null;
    if (!target) { out.push({ agent, state: 'nowhere-safe', room: seen.room?.name ?? null,
                              why: `${(seen.spots ?? []).length} candidate(s), none unreachable-by-anything` }); continue; }
    claimed.add(`${target.col},${target.row}`);
    out.push({ agent, state: 'assigned', to: { col: target.col, row: target.row },
               tested: target.tested, distance: target.distance ?? null });
  }
  return out;
}

async function walkTo(row) {
  if (row.state !== 'assigned') return row;
  if (!GO) return { ...row, state: 'would-walk' };
  await rpc('walk_to', { agent: row.agent, col: row.to.col, row: row.to.row }, Math.max(2000, left()))
    .catch(() => null);
  // ARRIVING IS NOT ASSUMED. The whole point is that a character believing it is somewhere
  // it is not is what gets it killed, so ask the world again rather than the walk's reply.
  const after = await rpc('safe_spots', { agent: row.agent, reachable_only: true }, Math.max(2000, left()))
    .catch(() => null);
  // VERIFIED BY POSITION, NOT BY THE BOOK. `in_a_safe_spot_now` is derived from the book's
  // record for the square underfoot (m59-broker.mjs), so it is FALSE for every untested
  // square no matter how good it is — which is why the first live run reported nobody
  // arrived when some of them may well have. What we actually need to know is: are we
  // standing where we aimed, and can anything reach us there.
  const at = after?.standing_at;
  const arrived = at && at.col === row.to.col && at.row === row.to.row;
  const stillSafe = (after?.spots ?? []).find(x => x.col === row.to.col && x.row === row.to.row);
  const bookSays = after?.in_a_safe_spot_now;
  if (arrived && (stillSafe?.can_reach_you === 0
                  || (bookSays && typeof bookSays === 'object' && bookSays.works !== false)))
    return { ...row, state: 'moved-to-safety', at };
  return { ...row, state: arrived ? 'arrived-but-exposed' : 'did-not-reach',
           at: at ?? null };
}

const reads = await Promise.all(agents.map(a => look(a).catch(e => ({ agent: a, seen: { error: e.message } }))));
startWalkClock();
const results = await Promise.all(assign(reads)
  .map(r => walkTo(r).catch(e => ({ ...r, state: 'error', why: e.message }))));
for (const r of results.sort((a, b) => a.agent.localeCompare(b.agent)))
  console.log(`  ${r.agent.padEnd(5)} ${r.state.padEnd(16)}` +
    (r.at ? ` at r${r.at.row}c${r.at.col}` : '') +
    (r.to ? ` -> r${r.to.row}c${r.to.col}${r.distance != null ? ` (${r.distance} sq)` : ''}` : '') +
    (r.tested ? ` (${r.tested})` : '') + (r.why ? `  ${r.why}` : '') +
    (r.room ? `  in ${r.room}` : ''));

const safe = results.filter(r => r.state === 'already-safe' || r.state === 'moved-to-safety');
console.log(`\n${safe.length} of ${results.length} in a safe spot`);
if (!GO) { console.log('\nplan only — nothing was moved and no keeper was stopped'); process.exit(0); }

// ---------------------------------------------------------------- phase 2: restart
//
// EVERY keeper stops, safe or not. A character that could not reach a spot is logged off
// where it stands, and that is the better of the two available outcomes: out of the world
// entirely for ~45 seconds beats standing in the open with nothing watching it. The sweep
// respawns from the roster on disk, which is also how it picks up new code.
//
// ADDRESSED BY AGENT, CHARACTER AND EXACT PID, because a keeper refuses an order that names
// somebody else — two fleets on one machine is a working configuration and a stop sent to a
// guessed port would take down a character nobody asked about.
let stopped = 0, refused = 0;
for (const [agent, k] of before) {
  const ok = await fetch(`http://127.0.0.1:${k.port}/stop`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent, character: k.character, keeper_pid: k.pid }),
    signal: AbortSignal.timeout(8000),
  }).then(r => r.ok).catch(() => false);
  if (ok) stopped++; else refused++;
}
console.log(`\nstopped ${stopped} keeper(s)${refused ? `, ${refused} refused` : ''}`);

// ---------------------------------------------------------------- phase 3: see them back
//
// A HANDLE YOU TURN ONCE. Stopping keepers and walking away leaves somebody else to find out
// later whether the fleet came back, which is exactly the position this whole day started
// from. The sweep runs every 45s, so this waits a couple of cycles and then says what it
// sees — INCLUDING THE PIDS, because a pid that did not change is a keeper that never
// restarted and therefore never picked up the new code. Waiting on `in_game` alone would
// wait for nothing: the old process reports it right up until it goes.
const waitMs = Math.max(60_000, (Number(val('--wait-seconds', '150')) || 150) * 1000);
const until = Date.now() + waitMs;
process.stdout.write('waiting for the rejoin sweep');
let back = new Map();
while (Date.now() < until) {
  await new Promise(r => setTimeout(r, 5000));
  process.stdout.write('.');
  back = await keeperMap();
  const fresh = [...back.entries()].filter(([a, k]) => k.in_game && k.pid !== before.get(a)?.pid);
  if (fresh.length >= before.size) break;
}
console.log('');

let restarted = 0, sameProcess = [], missing = [];
for (const [agent, was] of before) {
  const now = back.get(agent);
  if (!now) { missing.push(agent); continue; }
  if (now.pid !== was.pid) restarted++; else sameProcess.push(agent);
}
const inGame = [...back.values()].filter(k => k.in_game).length;
console.log(`${restarted} of ${before.size} keeper(s) came back on a NEW pid, ${inGame} in game`);
if (sameProcess.length)
  console.log(`  STILL ON THE OLD PID (did not restart, so did not pick up new code): ${sameProcess.join(', ')}`);
if (missing.length)
  console.log(`  not answering yet (the sweep may still be working): ${missing.join(', ')}`);

// ANYTHING THAT WAS IN FLIGHT AND IS NOT COMING BACK. Named rather than lost: the roster
// restores the orders, but a journey or a hold is transient and dies with the process.
const dropped = handoff.filter(r => r.job || r.hold);
if (dropped.length) {
  console.log(`\n${dropped.length} character(s) had work in flight that a restart drops:`);
  for (const r of dropped)
    console.log(`  ${r.agent.padEnd(5)} ${r.job ? 'job ' + JSON.stringify(r.job).slice(0, 90) : ''}`
      + `${r.hold ? '  hold ' + JSON.stringify(r.hold).slice(0, 60) : ''}`);
  console.log('  re-issue these if they mattered; the handoff file has the rest.');
} else {
  console.log('\nnothing was in flight, so nothing was dropped.');
}
console.log(`\nhandoff: ${handoffPath}`);
