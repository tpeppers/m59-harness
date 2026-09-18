#!/usr/bin/env node
// THE THING THAT NOTICES A TOWN STOP. Without it, every `atTownStop` stance is inert.
//
//   node tools/m59-townstop-watch.mjs                 # watch, plan only, say what it would do
//   node tools/m59-townstop-watch.mjs --once          # one pass and exit
//   node tools/m59-townstop-watch.mjs --commit        # and actually do it
//   node tools/m59-townstop-watch.mjs --every 30 --cooldown 600
//   node tools/m59-townstop-watch.mjs --agents t6,hk1 # only these
//
// WHY THIS EXISTS. `atTownStop` is consulted by `m59-townstop-run.mjs` and by NOTHING ELSE —
// the keeper never asks. So `substrate/strategies/` could hold a perfect stance and the fleet
// would never run it, and the stance would look armed on every board. That is this repository's
// oldest failure shape: a file that parses, a switch that reads ON, and no caller.
//
// Measured 2026-09-17: `restock-allies` was written, verified against prod's real packs, and
// could not fire, because nothing anywhere called the runner. The operator's ask it was written
// for — Loial standing in Barloque offering reveals and "never running out of orc teeth, because
// our farmers will be refilling him" — needed a driver more than it needed a stance.
//
// ---------------------------------------------------------------- what counts as a town stop
//
// TWO TRIGGERS, AND THE SECOND ONE IS THE POINT. A merchant in the room is the obvious one. The
// other is an ALLY in the room with a carry floor it has not met — which needs no merchant at
// all, and is the whole mechanism by which a service character gets supplied. A driver that
// fired only at counters would have left Loial exactly as short as before.
//
// A character standing in a town with no merchant and nobody short of anything is NOT at a town
// stop. Firing there would spend a pass per tick to be told there is nothing to do.
//
// ---------------------------------------------------------------- what it does NOT do
//
// IT DOES NOT MOVE ANYBODY. It watches for a character that is ALREADY somewhere useful. The
// meeting is somebody else's job — a keeper's town trip, a DUM errand, or a fleetscript. A
// watcher that walked characters to counters would be a second mover competing with the keeper
// for the same body, which is the contention `commander_claim` exists to prevent.
//
// IT DOES NOT RE-IMPLEMENT THE RUNNER. It SPAWNS `m59-townstop-run.mjs`, because that tool owns
// the arithmetic, the two never-sell-what-you-buy/give refusals, the keeper identity headers and
// the read-the-pack-back verification. A loop that reimplemented any of those would be a second
// opinion about whether a sale is safe. One process per stop is nothing at town-stop frequency.
//
// AND IT IS PLAN-ONLY BY DEFAULT, for the runner's own reason: selling is an allowlist, "buys
// anything" is usually a robbery, and a stop that reports success having moved nothing looks
// exactly like one that worked (docs/m59-economy.md). A driver is the wrong place to discover
// that.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMerchants } from './m59-merchants.mjs';
import { alliesInRoom } from './m59-townstop.mjs';
import { loadoutFor } from './m59-loadout.mjs';
import { resolveFleet, stateFileFor } from './m59-fleetpath.mjs';
import { discoverKeeperStates, resolveKeeperBand } from './runtime/keeper-discovery.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, 'm59-townstop-run.mjs');

const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const has = (n) => process.argv.includes('--' + n);

const COMMIT = has('commit');
const ONCE = has('once');
const EVERY_MS = Math.max(10, Number(arg('every', 30)) || 30) * 1000;
// A COOLDOWN, OR A CHARACTER PARKED IN A TOWN RUNS A STOP EVERY TICK. Ten minutes is longer
// than a keeper's own town trip and shorter than the gap between two of them.
const COOLDOWN_MS = Math.max(30, Number(arg('cooldown', 600)) || 600) * 1000;

const FLEET = resolveFleet().fleet;
// THE SAME BAND RESOLUTION THE RUNNER USES, override included. Two tools in one pass that
// disagreed about which band is this fleet's would probe two different sets of keepers, and the
// one that found nobody would report a quiet fleet.
//
// RESOLVED LAZILY, BECAUSE IMPORTING A MODULE MUST NOT DO WORK THAT CAN FAIL. This threw at
// import time on any checkout whose fleet has no band registered — which is every fresh clone —
// so `townStopReason` below, a pure function with no interest in ports at all, could not be
// imported to test without a broker having been started first. Same rule as 'do not import
// m59-broker.mjs to check it': the entry point does the work, the module only offers it.
let BAND = null;
const band = () => (BAND ??= resolveKeeperBand(FLEET, {
  ...(Object.hasOwn(process.env, 'M59_KEEPER_PORT_BASE')
    ? { override: process.env.M59_KEEPER_PORT_BASE }
    : {}),
}));

// THE ROSTER IS THE CREDENTIAL STORE, so only its KEYS are read. `discoverKeeperStates` refuses
// to look at all without an expected-agent set — it will not probe a band and believe whatever
// answers — so the slot names have to come from somewhere, and this is the only local source.
// Nothing here reads, logs or passes on a value from that file.
function rosterAgents() {
  const only = (arg('agents') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (only.length) return only;
  try {
    const raw = JSON.parse(readFileSync(stateFileFor(FLEET), 'utf8'));
    return Object.keys(raw).filter(k => /^[a-z]+[0-9]+$/i.test(k));
  } catch (e) {
    console.error(`cannot read the roster for "${FLEET}": ${e.message}`);
    return [];
  }
}

// Merchants by room. One read: the catalogue is a built file, not a live query.
function merchantsByRoom() {
  const by = new Map();
  try {
    const cat = loadMerchants();
    for (const m of (cat?.merchants ?? [])) {
      if (m?.room == null || !m?.name) continue;
      if (!by.has(m.room)) by.set(m.room, []);
      by.get(m.room).push(m.name);
    }
  } catch { /* no catalogue: the ally trigger still works, which is the one that matters here */ }
  return by;
}

/**
 * WHY THIS CHARACTER IS AT A TOWN STOP, OR NULL.
 *
 * Pure, so the decision can be tested without a fleet and read without running one. Returns the
 * reason rather than a boolean, because "the driver fired and the stop declined" and "the driver
 * never fired" are different faults and the log has to tell them apart.
 */
export function townStopReason(agent, states, merchants) {
  const st = states.get(agent);
  if (!st?.__identity) return null;                    // no verified keeper: not our business
  const room = st.room?.num ?? null;
  if (room == null) return null;                       // unknown room proves nothing is here

  const counters = merchants.get(room) ?? [];

  // Every discovered keeper is offered, hosts included — restocking lands on the WIDE side of
  // "is this one of ours", which is `alliesInRoom`'s own argument. No tool NAMES a host: the
  // giver drives itself and the host's own acceptDonations accepts.
  const others = [...states.values()].map(s => ({
    agent: s.__identity?.agent ?? null,
    character: s.character,
    room: s.room?.num ?? null,
    items: (s.items || []).map(i => ({ name: i.name, amount: i.amount ?? 1 })),
    loadout: s.character ? loadoutFor(s.character) : null,
  }));
  const allies = alliesInRoom({ character: st.character, room }, others);

  if (!counters.length && !allies.length) return null;
  return {
    agent, character: st.character, room, room_name: st.room?.name ?? null,
    merchant: counters[0] ?? null, merchants: counters,
    allies: allies.map(a => ({ who: a.character, wants: a.wants.map(w => `${w.item} x${w.short}`) })),
    why: [counters.length ? `a counter here (${counters.join(', ')})` : null,
          allies.length ? `${allies.length} ally/allies here short of something` : null]
      .filter(Boolean).join(' and '),
  };
}

function runOnce(reason) {
  return new Promise((resolve) => {
    const argv = [RUNNER, '--agent', reason.agent];
    if (reason.merchant) argv.push('--merchant', reason.merchant);
    if (COMMIT) argv.push('--commit');
    const p = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'],
                                              windowsHide: true });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', code => resolve({ code, out }));
    p.on('error', e => resolve({ code: -1, out: String(e.message) }));
  });
}

const lastRun = new Map();

async function pass() {
  const agents = rosterAgents();
  if (!agents.length) return;
  const merchants = merchantsByRoom();
  const { states } = await discoverKeeperStates({
    band: band(), expectedAgents: agents, liveTimeoutMs: 1500, stateTimeoutMs: 8000,
  });

  const reasons = agents.map(a => townStopReason(a, states, merchants)).filter(Boolean);
  const now = Date.now();
  const fresh = reasons.filter(r => (now - (lastRun.get(r.agent) ?? 0)) >= COOLDOWN_MS);
  const cooling = reasons.length - fresh.length;

  const stamp = new Date().toISOString().slice(11, 19);
  if (!reasons.length) {
    console.log(`${stamp}  ${states.size} keeper(s) answering, nobody at a town stop`);
    return;
  }
  console.log(`${stamp}  ${reasons.length} at a town stop` +
              (cooling ? `, ${cooling} still cooling down` : '') +
              (COMMIT ? '' : '  (plan only — pass --commit to act)'));

  // SERIALLY, NOT IN PARALLEL. Two characters selling at one counter share the server's
  // one-packet-per-second budget, and the runner reads its pack back afterwards — overlapping
  // two of those makes both read-backs meaningless.
  for (const r of fresh) {
    console.log(`  ${r.character} (${r.agent}) in ${r.room} ${r.room_name ?? ''} — ${r.why}`);
    for (const a of r.allies) console.log(`      ally: ${a.who} wants ${a.wants.join(', ')}`);
    lastRun.set(r.agent, Date.now());
    const { code, out } = await runOnce(r);
    for (const line of out.split(/\r?\n/)) if (line.trim()) console.log(`      | ${line}`);
    if (code !== 0) console.log(`      runner exited ${code}`);
  }
}

const isMain = !!process.argv[1] &&
  import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;

if (isMain) {
  if (has('help')) {
    console.log(readFileSync(new URL(import.meta.url)).toString()
      .split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
    process.exit(0);
  }
  console.log(`town-stop watcher · fleet "${FLEET}" · band ${band().base}-${band().end}` +
              ` · every ${EVERY_MS / 1000}s · cooldown ${COOLDOWN_MS / 1000}s` +
              (COMMIT ? ' · COMMITTING' : ' · plan only'));
  await pass();
  if (!ONCE) setInterval(() => { pass().catch(e => console.error('pass failed: ' + e.message)); },
                         EVERY_MS);
}
