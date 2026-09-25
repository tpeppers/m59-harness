#!/usr/bin/env node
// WHY IS THIS KEEPER NOT DOING ITS JOB — read off the keeper itself, named, with the lever.
//
//   node tools/m59-keeperwhy.mjs                       every keeper on this fleet's band
//   node tools/m59-keeperwhy.mjs --agents t1,t11       just these
//   node tools/m59-keeperwhy.mjs --room 27             only characters standing in room 27
//   node tools/m59-keeperwhy.mjs --json                the same, for a pad or a launcher
//   node tools/m59-keeperwhy.mjs --band 9511           from a checkout without keeper-bands.json
//
// READ-ONLY. It asks each keeper `GET /health` and `GET /state?fresh=1` over loopback and sends
// nothing else, so it is safe on prod, safe mid-errand, and safe to run every minute.
//
// WHY IT EXISTS. On 2026-09-25 eight characters were stationed in the Icky Cave (27) and most of
// them sat on one wall earning nothing. Getting from "they're stuck" to the two defects behind it
// (52053aa, 41d2b73) took about forty tool calls, and almost none of them were thinking:
//
//   * FINDING THE KEEPERS. Ports drift across restarts (never assume 9510+N), so every probe began
//     with a scan of the band — hand-rolled four times in one session.
//   * READING WHAT THEY DECIDED. The decision journal is `autopilot_status.recent` on the keeper's
//     own /state, not the broker's `autopilot status` (whose `journal` came back empty), and not the
//     keeper's /log (which holds only loop-stall lines).
//   * RECOGNISING THE LOOP. "broke off" x12 with `why: "try one of the names above"` is a precise
//     signature — fight() was pinned to an id its own filters removed — and it reads like an
//     ordinary unlucky fight unless you already know it.
//
// This file is those three, done once. The CLASSIFIER is a pure function (`classify`) so it is
// tested offline and so a FleetScratch pad can import it to check a body before driving it.
//
// Every signature names its `stuck` entry (node tools/m59-stuck.mjs <id>) and the lever. A
// signature whose code fix has landed stays here: seeing it on a keeper that has picked up the fix
// means the fix did not reach that keeper, or did not cover the case — both worth knowing fast.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';
import { KEEPER_BAND_WIDTH } from './runtime/keeper-bands.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// ------------------------------------------------------------------------------ classification
//
// Input: the keeper's /state (or anything shaped like it). Output: a list of findings, most
// important first. Pure — no clock, no network — so every case below has a test.
const count = (recent, pred) => recent.filter(pred).length;

export const SIGNATURES = Object.freeze([
  {
    id: 'fight-pinned-to-nothing',
    stuck: 'fight-pinned-to-nothing',
    test: (s) => {
      const n = count(s.recent, e => e.what === 'broke off' && /try one of the names above/.test(e.why ?? ''));
      return n >= 3 ? { repeats: n } : null;
    },
    says: 'fight() was sent at an exact creature id that its own filters remove, so it finds nothing ' +
          'and no pull or close ever runs. Two causes are fixed: a quarry proved unreachable being ' +
          're-selected (52053aa) and a pulled quarry that died to somebody else (41d2b73).',
    lever: 'if the keeper predates deploy-2026-09-25-10, restart it (POST /stop, addressed). If it ' +
           'does not, this is a THIRD cause — read `recent` for the pull and the avoid set.',
  },
  {
    id: 'wall-vigil-off-station',
    stuck: 're-tasked-wall-holder',
    test: (s) => (/^holding a|^waiting at a/.test(s.activity ?? '')
                  && Number.isFinite(s.assignedRoom) && s.room != null && s.assignedRoom !== s.room)
      ? { room: s.room, assigned: s.assignedRoom } : null,
    says: 'holding a wall in a room that is not its station. The wall vigil used to return before ' +
          'the station walk; fixed in 52053aa.',
    lever: 'the keeper walks by itself after two empty passes on current code; `come-home` walks it now.',
  },
  {
    id: 'all-prey-unreachable',
    stuck: 'fight-pinned-to-nothing',
    test: (s) => count(s.recent, e => e.what === 'every visible quarry is somewhere we proved we cannot walk to') > 0
      ? {} : null,
    says: 'every creature it can see stands on a square it has already failed to reach. It waits ' +
          'at its wall for one on its side; the memory expires in minutes and is re-tested.',
    lever: 'nothing, if spawns on our side keep coming. If this persists, the room has a pocket the ' +
           'mover cannot enter — `node tools/m59-roomview.mjs <room>` and the waypoint rails.',
  },
  {
    // BEFORE stranded-dry-room, because it is the same symptom with a different lever. While a
    // bot leases movement the keeper picks NO destination ("movement is leased — not choosing
    // where to go", noted once per holder, so it scrolls out of `recent` within minutes and the
    // character looks like a keeper ignoring its station). The walk home is the bot's recall.
    id: 'stranded-movement-leased',
    stuck: 'stranded-while-a-bot-holds-movement',
    test: (s) => {
      const off = /^stranded in |^holding a |^waiting at a /.test(s.activity ?? '')
        && Number.isFinite(s.assignedRoom) && s.room != null && s.assignedRoom !== s.room;
      return off && s.movementOwner && s.movementOwner !== 'keeper'
        ? { room: s.room, assigned: s.assignedRoom, held_by: s.movementOwner } : null;
    },
    says: 'off its station while a bot holds its movement lease. The keeper does not choose ' +
          'destinations under a lease, so only the bot\'s recall can bring it home.',
    lever: 'check the bot\'s recall covers the station: for DUM, `node bin/dum.mjs plan --agent <a>` ' +
           'should say "walking back to <room>". If it does not, the room is missing from ' +
           '`station.rooms`, and a DUM that predates 27f93d2 needs a restart (not a reload) for it.',
  },
  {
    id: 'stranded-dry-room',
    stuck: null,
    test: (s) => /^stranded in /.test(s.activity ?? '')
      && !(s.movementOwner && s.movementOwner !== 'keeper' && s.assignedRoom !== s.room)
      ? { activity: s.activity } : null,
    says: 'standing in a room that cannot produce its quarry.',
    lever: 'usually a town trip in progress or just ended; the keeper walks back to its station. ' +
           'If it persists, check `assigned_room` and the spawn table for the hunt.',
  },
  {
    id: 'stall-no-lever',
    stuck: null,
    test: (s) => (s.stall && s.stall.repeats >= 20)
      ? { why: s.stall.why, repeats: s.stall.repeats, lever: s.stall.lever ?? null } : null,
    says: 'the keeper reports itself stuck on the same reason, pass after pass.',
    lever: 'the stall names its own lever; `null` means no keeper-side action fixes it (see ' +
           'docs/m59-keeper.md, stallLever).',
  },
  {
    id: 'not-in-game',
    stuck: null,
    test: (s) => s.in_game === false ? {} : null,
    says: 'the keeper is up and the character is not logged in.',
    lever: 'the broker rejoins within 45s; `connected:false` for longer usually means a human logged in.',
  },
]);

/** Normalise a keeper /state into the fields the signatures read. */
export function digest(state = {}) {
  const ap = state.autopilot_status ?? {};
  const room = state.room?.num ?? (Number.isFinite(state.room) ? state.room : null);
  return {
    agent: state.agent ?? null,
    character: state.character ?? null,
    in_game: state.in_game,
    room,
    at: state.you ? `r${state.you.row}c${state.you.col}` : null,
    hp: state.hp ? `${state.hp.value}/${state.hp.max}` : null,
    activity: ap.activity ?? null,
    assignedRoom: ap.policy?.assignedRoom ?? null,
    hunt: ap.policy?.hunt ?? null,
    kills: ap.did?.kills ?? null,
    // A faculty is either the string 'keeper' or `{owner, expires_in_ms, why}`.
    movementOwner: typeof ap.faculties?.movement === 'string'
      ? ap.faculties.movement : (ap.faculties?.movement?.owner ?? null),
    stall: ap.stuck ?? null,
    recent: Array.isArray(ap.recent) ? ap.recent : [],
  };
}

export function classify(state) {
  const s = digest(state);
  const findings = [];
  for (const sig of SIGNATURES) {
    let hit = null;
    try { hit = sig.test(s); } catch { hit = null; }
    if (hit) findings.push({ id: sig.id, stuck: sig.stuck, says: sig.says, lever: sig.lever, ...hit });
  }
  const tally = {};
  for (const e of s.recent) tally[e.what] = (tally[e.what] || 0) + 1;
  const { recent, ...rest } = s;
  return { ...rest, tally, findings };
}

// ------------------------------------------------------------------------------ discovery
//
// THE BAND, NOT A GUESS. substrate/keeper-bands.json names each fleet's base port, and a keeper
// sits somewhere in [base, base+width). Scan all of it in parallel and believe /health's `agent`,
// never the port number.
export function bandFor(fleet, repo = REPO) {
  try {
    const bands = JSON.parse(readFileSync(join(repo, 'substrate', 'keeper-bands.json'), 'utf8'));
    const base = Number(bands[fleet]);
    if (Number.isFinite(base)) return { base, end: base + KEEPER_BAND_WIDTH - 1 };
  } catch { /* fall through */ }
  return null;
}

async function getJson(url, ms) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  return r.json();
}

export async function discover({ base, end }, ms = 3000) {
  const found = {};
  await Promise.all(Array.from({ length: end - base + 1 }, (_, i) => base + i).map(async port => {
    try {
      const h = await getJson(`http://127.0.0.1:${port}/health`, ms);
      if (h?.agent) found[h.agent] = { port, pid: h.pid, character: h.character ?? null };
    } catch { /* nothing on this port */ }
  }));
  return found;
}

// ------------------------------------------------------------------------------ CLI
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] ?? d) : d; };
  const fleet = arg('fleet') ?? fleetName() ?? 'prod';
  // --band <base> for a checkout that does not carry the fleet's keeper-bands.json (a worktree:
  // the file is machine-local and gitignored). Refusing is right without it; guessing is not.
  const band = arg('band') ? { base: Number(arg('band')), end: Number(arg('band')) + KEEPER_BAND_WIDTH - 1 }
                           : bandFor(fleet);
  if (!band) {
    console.error(`no keeper band for fleet "${fleet}" in substrate/keeper-bands.json — cannot find its keepers.`);
    process.exit(2);
  }
  const want = arg('agents') ? new Set(arg('agents').split(',')) : null;
  const roomOnly = arg('room') != null ? Number(arg('room')) : null;
  const keepers = await discover(band);
  const rows = [];
  for (const [agent, k] of Object.entries(keepers).sort((a, b) => a[1].port - b[1].port)) {
    if (want && !want.has(agent)) continue;
    let state;
    try { state = await getJson(`http://127.0.0.1:${k.port}/state?fresh=1`, 8000); }
    catch (e) { rows.push({ agent, port: k.port, error: e.message }); continue; }
    const c = classify({ agent, ...state });
    if (roomOnly != null && c.room !== roomOnly) continue;
    rows.push({ port: k.port, pid: k.pid, ...c });
  }
  if (argv.includes('--json')) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }
  console.log(`fleet ${fleet} · band ${band.base}-${band.end} · ${Object.keys(keepers).length} keeper(s) found`);
  for (const r of rows) {
    if (r.error) { console.log(`\n${r.agent} :${r.port}  UNREADABLE — ${r.error}`); continue; }
    console.log(`\n${r.agent} ${r.character ?? ''} :${r.port}  room ${r.room} ${r.at ?? ''}  hp ${r.hp ?? '?'}  kills ${r.kills ?? '?'}`);
    console.log(`  ${r.activity ?? '(no activity)'}${r.assignedRoom != null && r.assignedRoom !== r.room ? `   [station ${r.assignedRoom}]` : ''}`);
    const top = Object.entries(r.tally).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w, n]) => `${w} x${n}`);
    if (top.length) console.log(`  recent: ${top.join(' · ')}`);
    for (const f of r.findings) {
      console.log(`  >> ${f.id}${f.stuck ? `  (m59-stuck ${f.stuck})` : ''}`);
      console.log(`     ${f.says}`);
      console.log(`     lever: ${f.lever}`);
    }
  }
  const flagged = rows.filter(r => r.findings?.length).length;
  console.log(`\n${flagged} of ${rows.length} flagged.`);
}
