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
import { readFileSync } from 'node:fs';

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
    method: 'POST', headers: { 'content-type': 'application/json' },
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

// ---------------------------------------------------------------- phase 1: get safe
//
// In parallel, because the deadline is wall-clock for the whole fleet rather than per
// character: twenty-one sequential walks would spend the budget on the first three.
const deadline = Date.now() + SECONDS * 1000;
const left = () => Math.max(0, deadline - Date.now());

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
  const seen = await rpc('safe_spots', { agent, reachable_only: true }, Math.max(2000, left()))
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
    const usable = (seen.spots ?? []).filter(x => x.tested !== 'does not work'
      && Number.isInteger(x.col) && Number.isInteger(x.row)
      && !claimed.has(`${x.col},${x.row}`));
    const target = usable.find(x => x.tested === 'holds') ?? usable[0] ?? null;
    if (!target) { out.push({ agent, state: 'nowhere-safe', room: seen.room?.name ?? null }); continue; }
    claimed.add(`${target.col},${target.row}`);
    out.push({ agent, state: 'assigned', to: { col: target.col, row: target.row }, tested: target.tested });
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
  const now = after?.in_a_safe_spot_now;
  return (now && typeof now === 'object' && now.works !== false)
    ? { ...row, state: 'moved-to-safety', at: now.at ?? null }
    : { ...row, state: 'did-not-reach' };
}

const reads = await Promise.all(agents.map(a => look(a).catch(e => ({ agent: a, seen: { error: e.message } }))));
const results = await Promise.all(assign(reads)
  .map(r => walkTo(r).catch(e => ({ ...r, state: 'error', why: e.message }))));
for (const r of results.sort((a, b) => a.agent.localeCompare(b.agent)))
  console.log(`  ${r.agent.padEnd(5)} ${r.state.padEnd(16)}` +
    (r.at ? ` at r${r.at.row}c${r.at.col}` : '') +
    (r.to ? ` -> r${r.to.row}c${r.to.col}` : '') +
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
const band = (() => {
  try {
    const bands = JSON.parse(readFileSync(new URL('../substrate/keeper-bands.json', import.meta.url), 'utf8'));
    return bands[health.fleet] ?? null;
  } catch { return null; }
})();
if (!band) { console.error('\nno keeper band for this fleet; not guessing ports'); process.exit(3); }

let stopped = 0, refused = 0;
for (let i = 0; i < 30; i++) {
  const port = band + i;
  const h = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) })
    .then(r => r.json()).catch(() => null);
  if (!h?.agent) continue;
  if (ONLY.length && !ONLY.includes(h.agent)) continue;
  if (!agents.includes(h.agent)) continue;
  const ok = await fetch(`http://127.0.0.1:${port}/stop`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: h.agent, character: h.character, keeper_pid: h.pid }),
    signal: AbortSignal.timeout(8000),
  }).then(r => r.ok).catch(() => false);
  if (ok) stopped++; else refused++;
}
console.log(`\nstopped ${stopped} keeper(s)${refused ? `, ${refused} refused` : ''}`);
console.log('the broker\'s 45s rejoin sweep will bring them back on the code now on disk,');
console.log('standing where this left them.');
