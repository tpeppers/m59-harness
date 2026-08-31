#!/usr/bin/env node
// THE FLEET, IN A TERMINAL YOU CAN DRIVE.
//
//   node tools/m59-tui.mjs
//
// The dashboard answers "how is the fleet doing?" from a browser, and a browser is the
// wrong place to end that question. What you actually want to do next is start the
// game as one of these characters, and a web page cannot start a program — it can only
// offer you a script to copy somewhere else. A terminal has no such problem.
//
// So this is the same information with the last step joined on: arrow keys to pick a
// character, Enter for its full sheet, L to LAUNCH the client logged in as it with the
// agent DLL injected, C to open the COMPENDIUM with that character's real numbers in
// it. No copying, no pasting.
//
// THE CLIENT L STARTS IS THE PATCHED ONE WHEN THERE IS ONE. `m59-devclient.mjs` names the
// build tree's own meridian.exe — the binary with clientd3d/m59dbg.c in it and without
// the idle logoff — and `shortcuts/dev.bat` is the one file that knows how to start it.
// A launch from here goes through that file with the same five arguments the
// per-character dev-<name>.bat files use, so the terminal and the shortcuts cannot start
// two different clients. The Steam client is what you get when nothing is built, and
// M59_TUI_STOCK_CLIENT=1 asks for it on purpose.
//
// Zero dependencies and no framework. It draws with ANSI, reads raw keys, and repaints
// the whole screen on a timer — twenty-five rows is far too little to need anything
// cleverer, and a dependency here would be a dependency in the one tool you reach for
// when things are already broken.
import { stdin, stdout, env, exit, argv } from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { readFileSync, openSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFleet } from './m59-fleetpath.mjs';
import { findClient, findClientExe, isSteamInstall, clientArgs, STEAM_APPID }
  from './m59-shortcuts.mjs';
import { DEV_CLIENT, ensureUniversalLauncher, universalLauncherArgs } from './m59-devclient.mjs';
import { ensureServing, openBrowser, importUrl, COMPENDIUM_PORT } from './m59-compendium.mjs';
import * as webui from './m59-webui.mjs';
import { commitmentOf, stepSelection, firstSelectable, allCommitted } from './m59-commitment.mjs';
import { mergeTuiRow, fleetFreshness } from './m59-tui-state.mjs';
import { recentDeathsIn, DEATH_WINDOW_MS } from './m59-death-tally.mjs';
import {
  KEEPER_BAND_WIDTH,
  discoverKeeperStates,
  keeperBandPorts,
  resolveKeeperBand,
} from './runtime/keeper-discovery.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
// Which roster this TUI is looking at. Must match the broker it is talking to —
// pass --fleet <name> to both, or neither.
const { fleet: FLEET, label: FLEET_LABEL, stateFile: STATE_FILE } = resolveFleet();

const PORT = env.M59_BROKER_PORT || '8901';
const URL_ = `http://127.0.0.1:${PORT}/`;
// Each keeper is its own process with its own HTTP port. The band is an ownership boundary;
// the actual agent on each slot is still proved by the keeper itself. See keeperStates().
const KEEPER_BAND_OPTIONS = {
  ...(Object.hasOwn(env, 'M59_KEEPER_PORT_BASE')
    ? { override: env.M59_KEEPER_PORT_BASE }
    : {}),
  missing: 'null',
};
// A TUI may start just before a named broker allocates its first band. Keep "not assigned"
// as no data and retry the registry on refresh; never substitute the unnamed/prod range.
let KEEPER_BAND = resolveKeeperBand(FLEET, KEEPER_BAND_OPTIONS);
const REFRESH_MS = Number(env.M59_TUI_REFRESH_MS || 5000);

// ------------------------------------------------------------------ broker

async function call(name, args = {}, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(URL_, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                             params: { name, arguments: args } }),
    });
    const j = await r.json();
    if (j.result?.isError) return { __error: j.result.content[0].text };
    return JSON.parse(j.result.content[0].text);
  } catch (e) { return { __error: e.name === 'AbortError' ? 'timed out' : e.message }; }
  finally { clearTimeout(t); }
}

// ------------------------------------------------------------------ drawing

const ESC = '\x1b[';
const alt = on => stdout.write(on ? ESC + '?1049h' : ESC + '?1049l');
const cursor = on => stdout.write(on ? ESC + '?25h' : ESC + '?25l');
const home = () => stdout.write(ESC + 'H');
const clear = () => stdout.write(ESC + '2J' + ESC + 'H');

const c = {
  dim: s => `${ESC}2m${s}${ESC}0m`,
  bold: s => `${ESC}1m${s}${ESC}0m`,
  green: s => `${ESC}32m${s}${ESC}0m`,
  red: s => `${ESC}31m${s}${ESC}0m`,
  yellow: s => `${ESC}33m${s}${ESC}0m`,
  blue: s => `${ESC}34m${s}${ESC}0m`,
  cyan: s => `${ESC}36m${s}${ESC}0m`,
  inv: s => `${ESC}7m${s}${ESC}0m`,
};
// Width without the escape sequences, so padding lines up once colour is applied.
const wide = s => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - wide(s)));
const cut = (s, n) => (wide(s) <= n ? s : s.slice(0, n - 1) + '…');

// The same five-square bar the fleet page draws, for the same reason: fixed width so
// the column stays scannable, colour carrying the value.
function bar(value, max, blue = false) {
  if (!max || value == null) return c.dim('█████');
  const p = Math.max(0, Math.min(1, value / max));
  let out = '';
  for (let i = 1; i <= 5; i++) {
    const top = i / 5, bottom = (i - 1) / 5;
    out += p >= top ? (blue ? c.blue('█') : c.green('█'))
         : p > bottom ? c.yellow('█') : c.red('█');
  }
  return out;
}
const num = s => {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(s ?? ''));
  return m ? { v: +m[1], max: +m[2] } : { v: null, max: null };
};

// ------------------------------------------------------------------ state

const S = {
  view: 'list',          // 'list' | 'hero'
  sel: 0,
  rows: [],              // merged autopilot + fleet rows
  hero: null,
  detail: null,
  status: '',
  loading: true,
  lastError: null,
  // THE OVERRIDE, off by default. While off, characters the fleet is using for something
  // — a loot run, a signet ring being walked to its owner, a provisioning cast, a pairing
  // — are greyed and the cursor steps straight over them. That is the safe default: those
  // operations have another end, and taking one half of one abandons the other half in a
  // way nothing reports. While on, every row is reachable and X on a held one releases it.
  override: false,
  placed: false,         // has the cursor been put somewhere sensible yet?
};

// WHICH PORT IS WHOSE KEEPER — ASKED, NEVER COMPUTED.
//
// A keeper's port is not treated as an agent name. Historical brokers shared one range
// and walked forward around collisions, so arithmetic once read a stranger's keeper and
// put shadow vitals on prod rows. Current brokers own disjoint fixed bands, but discovery
// still proves the process identity because a stale process or explicit override can make
// a port number alone lie.
//
// So sweep this fleet's complete band with cheap `/live` requests. Only an expected agent
// with a complete agent/character/PID tuple earns the richer `/state` request, and that
// reply must repeat the tuple. Same doctrine as m59-which.mjs one layer down: two fleets
// on one machine are not the same fleet, and identity is checked rather than inferred.
// The old scan-width escape hatch could truncate a fleet or run into the adjacent fleet's
// band. It remains accepted only at the one safe value so stale service configuration fails
// loudly rather than changing the ownership boundary.
if (Object.hasOwn(env, 'M59_TUI_KEEPER_SCAN') &&
    Number(env.M59_TUI_KEEPER_SCAN) !== KEEPER_BAND_WIDTH) {
  throw new RangeError(`M59_TUI_KEEPER_SCAN must be exactly ${KEEPER_BAND_WIDTH}`);
}
let _ports = null;                       // agent -> port, learned by asking
// `mine` is this fleet's agent names. Anything else answering is another fleet's keeper
// and is dropped here rather than carried around — a map that holds `shadow13` is one
// stray lookup away from putting a stranger's vitals on a prod row.
async function sweep(band, ports, mine) {
  const { states } = await discoverKeeperStates({
    band,
    expectedAgents: mine,
    ports,
    liveTimeoutMs: 1500,
    stateTimeoutMs: 6000,
  });
  return states;
}
// Fast path is the ports we already know. A keeper that respawns can land somewhere else
// entirely now that allocation is dynamic, so any agent we expected and did not hear from
// triggers ONE full re-scan — otherwise a moved keeper silently drops off the board for
// as long as the process lives, which is the failure this whole comment block is about.
async function keeperStates(expected = []) {
  const mine = new Set(expected.filter(Boolean).map(String));
  KEEPER_BAND ??= resolveKeeperBand(FLEET, KEEPER_BAND_OPTIONS);
  if (!KEEPER_BAND) {
    _ports = null;
    return new Map();
  }
  const full = () => keeperBandPorts(KEEPER_BAND);
  let seen = await sweep(KEEPER_BAND,
                         _ports ? [...new Set(_ports.values())] : full(), mine);
  if (_ports) {
    const missing = new Set([...mine].filter(agent => !seen.has(agent)));
    if (missing.size) {
      // The complete re-scan still uses cheap liveness for all 100 ports, but only missing
      // expected agents receive a rich state request. Keep good fast-path states already read.
      const recovered = await sweep(KEEPER_BAND, full(), missing);
      for (const [agent, state] of recovered) seen.set(agent, state);
    }
  }
  _ports = new Map([...seen].map(([a, m]) => [a, m.__port]));
  return seen;
}

// EVERY CHARACTER IN THE FLEET IS A ROW, AND ITS KEEPER IS READ FROM ITS OWN PROCESS.
//
// This used to enumerate `autopilot action=list` — the broker's IN-PROCESS Autopilot
// registry — and join the fleet onto it. Since keepers moved into their own processes
// that registry is a shell: it holds an entry only for characters something happened to
// call `autopilot action=start` on inside the broker, and `running` on those entries
// describes the shell rather than the keeper. Measured on prod: the list held 20 of 21
// agents and reported 2 running, so the board read "2/20 keepers up" and WALDORF WAS
// SIMPLY ABSENT — alive on the server, farming, answering on its own port, and missing
// from the fleet board because no shell object happened to bear its name.
//
// A character that exists is a row. Anything that enumerates keepers to find characters
// will drop the ones whose keeper the broker did not personally start.
async function refresh() {
  // Refreshes the loopback keeper snapshots only; the broker explicitly guarantees this
  // option sends no Meridian packets.  That removes its independent two-second cache from
  // a manual/periodic TUI refresh without turning a five-second repaint into fleet traffic.
  const f = await call('fleet', { refresh: true }, 15000);
  if (f?.__error) { S.lastError = 'broker: ' + f.__error; S.loading = false; return; }
  S.lastError = null;
  const rows = f?.fleet || [];
  // `running` is the keeper's own ground truth, off its own HTTP port. Failing to reach
  // one leaves `ap` as it was, which every consumer below already treats as "no keeper".
  const keepers = await keeperStates(rows.map(r => r.agent));
  // Read the same durable evidence locally as the new broker.  This fallback matters
  // during rolling deployment: the TUI can show a death immediately even while the live
  // broker/keeper processes are still running the preceding binary.  Rows restrict the
  // result to this selected fleet's character names.
  const deaths = recentDeathsIn(join(REPO, 'substrate', 'postmortems'), {
    sinceMs: DEATH_WINDOW_MS,
  });
  S.rows = rows.map(r => {
    const durable = deaths.get(r.character ?? '');
    return mergeTuiRow({
      ...r,
      deaths_24h: r.deaths_24h ?? durable?.count ?? 0,
      deaths_in_safe_spot: durable?.in_safe_spot ?? r.deaths_in_safe_spot ?? 0,
      deaths_in_proven_safe_spot: durable?.in_proven_safe_spot ??
        r.deaths_in_proven_safe_spot ?? 0,
      last_death: r.last_death ?? durable?.last ?? null,
    }, keepers.get(r.agent));
  })
    .sort((x, y) => (y.level ?? 0) - (x.level ?? 0));
  if (S.sel >= S.rows.length) S.sel = Math.max(0, S.rows.length - 1);
  // The first draw should not open on a character you are not allowed to pick. After
  // that the cursor is the operator's and a refresh must not move it — a board that
  // re-homes the selection every five seconds is unusable.
  if (!S.placed && S.rows.length) { S.sel = firstSelectable(S.rows, S); S.placed = true; }
  S.loading = false;
}

async function loadHero(row) {
  S.detail = { loading: true };
  draw();
  const [inv, ab] = await Promise.all([
    call('inventory', { agent: row.agent }, 8000),
    call('abilities', { agent: row.agent }, 8000),
  ]);
  S.detail = { loading: false, inv: inv?.items || [], skills: ab?.skills || [], spells: ab?.spells || [] };
}

// ------------------------------------------------------------------ views

function listView() {
  const L = [];
  const up = S.rows.filter(r => r.ap?.running).length;
  const walls = S.rows.filter(r => r.ap?.safe_spot?.works).length;
  const dead = S.rows.filter(r => r.in_game === false).length;
  const spotDeaths = S.rows.reduce((n, r) => n + (r.ap?.did?.deaths_in_safe_spot ?? 0), 0);
  const recentDeaths = S.rows.reduce((n, r) => n + (r.ap?.did?.deaths_24h ?? 0), 0);
  const heldCount = S.rows.filter(r => commitmentOf(r)).length;
  const freshness = fleetFreshness(S.rows);

  L.push(c.bold(c.cyan('  MERIDIAN 59 FLEET')) + '   ' + c.dim([
    `${up}/${S.rows.length} keepers up`,
    walls ? c.green(`${walls} proven walls`) : c.dim('0 proven walls'),
    dead ? c.red(`${dead} NOT IN GAME`) : c.green('all in game'),
    recentDeaths ? c.red(`${recentDeaths} deaths/24h`) : c.green('0 deaths/24h'),
    spotDeaths ? c.red(`${spotDeaths} died in a spot`) : c.green('0 spot deaths'),
    freshness.stale.length
      ? c.red(`${freshness.stale.length} STALE SNAPSHOT${freshness.stale.length === 1 ? '' : 'S'}`)
      : freshness.unknown
        ? c.yellow(`${freshness.unknown} snapshot ages unknown`)
        : c.dim(`newest evidence ≤${Math.ceil((freshness.max_age_ms ?? 0) / 1000)}s old`),
    // Said out loud rather than left to be inferred from the colour of some rows. A
    // person who does not know the skipping exists reads a cursor jumping two rows as a
    // bug, and the count is the shortest possible explanation of it.
    heldCount ? (S.override ? c.yellow(`${heldCount} on fleet work — OVERRIDE ON`)
                            : c.dim(`${heldCount} on fleet work, skipped`)) : '',
  ].filter(Boolean).join(' · ')));
  L.push('');
  L.push(c.dim('  ' + pad('character', 11) + pad('lvl', 4) + pad('health', 14) +
               pad('mana', 13) + pad('vigor', 14) + pad('w/f', 5) + pad('spot', 7) +
               pad('k/30m', 7) + 'doing'));

  for (let i = 0; i < S.rows.length; i++) {
    const r = S.rows[i];
    const hp = num(r.health), mp = num(r.mana), vg = num(r.vigor_of);
    const spot = r.ap?.safe_spot
      ? (r.ap.safe_spot.works ? c.green('WALL ') : c.yellow('test '))
      : c.dim('  -  ');
    const wf = (r.has_weapon ? c.green('w') : c.red('w')) + (r.has_food ? c.green('f') : c.red('f'));
    // THE ONE A CLIENT IS HOLDING. Worth marking because everything else on this row
    // reads as a fault when it is true: the keeper is deliberately stopped while a person
    // plays, so "no keeper", zero kills and a stalled activity are all correct and none
    // of them are a problem to go and fix.
    const mine = !!r.piloted;
    // SPOKEN FOR BY THE FLEET, which is a different thing from being played by a person
    // and must not look like one. A piloted character is where YOU are; a committed one
    // is somewhere you should not casually go. So one is cyan and marked ◆, and the other
    // is greyed out and stepped over.
    const held = commitmentOf(r);
    const k30 = r.kills_30m ?? r.ap?.did?.kills_30m ?? 0;
    const line =
      pad(mine ? c.cyan(r.character ?? r.agent)
        : held ? c.dim(r.character ?? r.agent) : (r.character ?? r.agent), 11) +
      pad(String(r.level ?? '?'), 4) +
      pad(bar(hp.v, hp.max) + ' ' + c.dim(pad(r.health ?? '—', 7)), 14) +
      pad(bar(mp.v, mp.max, true) + ' ' + c.dim(pad(r.mana ?? '—', 6)), 13) +
      pad(bar(vg.v, vg.max) + ' ' + c.dim(pad(String(vg.v ?? '—'), 7)), 14) +
      pad(wf, 5) + pad(spot, 7) +
      // KILLS IN THE LAST HALF HOUR, not since the keeper started. The lifetime count is
      // reset by every restart and this fleet's keepers get restarted constantly, so it
      // largely measures uptime — a character with forty kills and none this hour looks
      // exactly like one that is earning. Zero is the interesting value, so it is the one
      // that gets a colour; a piloted character is exempt, because a person playing is
      // not farming and a red nought there is noise.
      // A committed character is not farming either, and a red nought against a
      // character that is deliberately walking a ring across the map is the same noise
      // the piloted exemption exists to remove.
      pad(k30 > 0 ? c.green(String(k30)) : (mine || held ? c.dim('—') : c.red('0')), 7) +
      (mine ? c.cyan('YOU — ') : '') +
      // THE COMMITMENT REPLACES THE ACTIVITY, because it IS the activity and it is the
      // half worth reading. A keeper on a loot run reports "inert — a loot run is
      // driving"; the operation is what the board should say.
      c.dim(cut((held ? held.label : r.ap?.activity) ?? '', mine ? 22 : 28));
    // Three different marks in one gutter: ▸ is where the cursor is, ◆ is where the
    // person is, and · is a character the fleet is using. They are independent — you can
    // be scrolled somewhere else entirely — so none must hide another. The committed mark
    // is the faintest because it is the one that means "not here".
    const gutter = i === S.sel ? c.inv(mine ? '◆ ' : held ? '! ' : '▸ ')
                 : mine ? c.cyan('◆ ') : held ? c.dim('· ') : '  ';
    L.push(gutter + line);
  }
  L.push('');
  // WHAT X DOES DEPENDS ON WHERE THE CURSOR IS, so the footer says which of the two it is
  // about to do rather than describing both and leaving you to work it out. One key with
  // a stated meaning beats two keys nobody remembers.
  const cur = S.rows[S.sel];
  const curHeld = cur ? commitmentOf(cur) : null;
  const xSays = !S.override
    ? c.bold(c.yellow('X')) + c.dim(' override (reach the greyed ones)')
    : curHeld
      ? c.bold(c.yellow('X')) + c.dim(' TAKE ') + c.yellow(cur.character ?? cur.agent) +
        c.dim(' off ' + cut(curHeld.label ?? 'fleet work', 24))
      : c.bold(c.yellow('X')) + c.dim(' leave override');
  L.push(c.dim('  ↑↓/jk move · ⏎ open · L launch · ') + c.cyan('S swarm') + c.dim(' · ') +
         c.cyan('B board') + c.dim(' · ') + c.cyan('F field cmd') +
         c.dim(' · C compendium · P plan · ') + xSays +
         c.dim(' · r refresh · q quit'));
  if (S.status) L.push('  ' + S.status);
  if (S.lastError) L.push('  ' + c.red(S.lastError));
  return L;
}

function heroView() {
  const r = S.hero;
  const a = r.ap || {};
  const L = [];
  const hp = num(r.health), mp = num(r.mana), vg = num(r.vigor_of);
  L.push(c.bold(c.cyan('  ' + (r.character ?? r.agent))) + '  ' +
         c.dim(`${r.agent} · ${a.policy?.strategy ?? '—'} · ${r.room ?? '?'} [room ${r.room_num ?? '?'}]`));
  L.push('');
  L.push('  ' + pad('health', 9) + bar(hp.v, hp.max) + '  ' + pad(r.health ?? '—', 10) +
         c.dim('max health is the level'));
  L.push('  ' + pad('mana', 9) + bar(mp.v, mp.max, true) + '  ' + pad(r.mana ?? '—', 10));
  L.push('  ' + pad('vigor', 9) + bar(vg.v, vg.max) + '  ' + pad(r.vigor_of ?? '—', 10) +
         c.dim('resting alone stops at 80'));
  L.push('');
  L.push('  ' + c.dim('doing    ') + (a.activity ?? '—'));
  // WHY THIS CHARACTER IS NOT YOURS TO TAKE, spelled out on the sheet rather than only
  // implied by a greyed row on the board. The board has one line and can say what; this
  // has room to say what it would cost.
  const held = commitmentOf(r);
  if (held) {
    L.push('  ' + c.dim('fleet    ') + c.yellow(held.label ?? held.kind) +
           (held.since ? c.dim(`  (${Math.round((Date.now() - held.since) / 60000)}m)`) : ''));
    if (held.detail) L.push('  ' + c.dim('         ') + c.dim(held.detail));
  }
  L.push('  ' + c.dim('weapon   ') + (r.has_weapon ? c.green('yes') : c.red('NO — punching things')) +
         c.dim('   food  ') + (r.has_food ? c.green('yes') : c.red('NO — vigor capped at 80')));
  L.push('  ' + c.dim('carrying ') + `${r.carrying ?? '?'} / ${a.policy?.maxCarry ?? '?'}`);
  L.push('');

  const s = a.safe_spot;
  L.push(c.bold('  SAFE SPOT'));
  if (s) {
    L.push('  ' + c.dim('at       ') + `${s.at.col},${s.at.row}  ` +
           (s.works ? c.green('holds under attack') : c.yellow('untested')));
    L.push('  ' + c.dim('evidence ') + cut(s.evidence, 68));
    L.push('  ' + c.dim('on us    ') +
           `${a.threat?.in_swing_range ?? 0} in range, ${a.threat?.camped_on_us ?? 0} camped ` +
           c.dim((a.threat?.what || []).join(', ')));
  } else L.push(c.dim('  not holding one'));
  L.push('');

  L.push(c.bold('  SURVIVAL') + c.dim(`   ${a.did?.deaths_24h ?? 0} deaths/24h · ` +
    `${a.did?.deaths ?? 0} since keeper start · ` +
    `${a.did?.deaths_in_safe_spot ?? 0} in a safe spot · ${a.did?.mulligans ?? 0} mulligans · ` +
    `${a.did?.logoffs ?? 0} logoffs`));
  const lastDeath = a.last_death ?? r.last_death;
  if (lastDeath) {
    const ago = lastDeath.at ? Math.max(0, Math.round((Date.now() - lastDeath.at) / 60000)) : null;
    L.push('  ' + c.dim('last died ') +
      c.red(`${lastDeath.died_in ?? lastDeath.where?.room ?? 'unknown room'}`) +
      (ago != null ? c.dim(` · ${ago}m ago`) : '') +
      (lastDeath.hunting ? c.dim(` · hunting ${lastDeath.hunting}`) : ''));
  }
  if (r.snapshot_age_ms == null) L.push('  ' + c.yellow('snapshot age unknown'));
  else L.push('  ' + c.dim(`snapshot ${Math.round(r.snapshot_age_ms)}ms old`));
  L.push('');

  const d = S.detail;
  if (d?.loading) L.push(c.dim('  loading pack…'));
  else if (d) {
    L.push(c.bold('  CARRYING') + '  ' +
      c.dim(d.inv.length ? d.inv.map(i => i.name + (i.amount ? ` x${i.amount}` : '')).join(', ') : 'nothing'));
    const ab = [...d.skills.map(x => x.name), ...d.spells.map(x => x.name)];
    L.push(c.bold('  KNOWS   ') + '  ' + c.dim(ab.length ? ab.join(', ') : 'nothing'));
  }
  L.push('');
  L.push(c.bold('  READINGS') + c.dim('  the safe-spot experiment, newest last'));
  for (const t of (a.trials || []).slice(-6))
    L.push('   ' + (t.counted ? (/HIT/.test(t.verdict) ? c.red('counted') : c.green('counted'))
                              : c.dim('skipped')) + ' ' + c.dim(cut(t.verdict, 66)));
  L.push('');
  L.push(c.bold('  RECENT'));
  for (const e of (a.recent || []).slice(-8)) L.push('   ' + c.dim(cut(e.what, 74)));
  L.push('');
  L.push(c.dim('  ⏎/q back · ') + c.bold(c.yellow('L')) + c.dim(' LAUNCH the client as this character · ') +
         c.bold(c.cyan('S')) + c.dim(' SWARM — launch and the fleet follows · ') +
         c.bold(c.cyan('B')) + c.dim(` BOARD — the whole ${FLEET_LABEL} fleet in the commander · `) +
         c.bold(c.cyan('F')) + c.dim(' FIELD COMMAND — the same fleet on a map, in a browser · ') +
         (held ? c.bold(c.yellow('X')) + c.dim(' take it off ' + cut(held.label ?? 'fleet work', 22)) + c.dim(' · ') : '') +
         c.dim('r refresh'));
  if (S.status) L.push('  ' + S.status);
  return L;
}

function draw() {
  const lines = S.loading ? [c.dim('  talking to the broker…')]
              : S.view === 'hero' ? heroView() : listView();
  const rows = stdout.rows || 40;
  home();
  const out = [];
  for (let i = 0; i < rows - 1; i++) out.push((lines[i] ?? '') + ESC + 'K');
  stdout.write(out.join('\n'));
}

// ------------------------------------------------------------------ launching
//
// THE POINT OF BEING IN A TERMINAL. A web page can offer a script; a terminal can run
// it. This starts the real client already logged in as the selected character and then
// injects the agent DLL, so the same character is playable by hand AND drivable by the
// MCP — which is the thing that was worth five minutes of copy-paste every time.
// launch() is async, so a throw in it lands on a promise rather than in the key
// handler. Unhandled, that is a silent no-op on a keypress — the one failure mode this
// key has already had once. Put it on the status line instead.
const fail = (e) => { S.status = c.red('launch failed: ' + (e?.message ?? e)); draw(); };
// The same landing pad for the keys that are not a launch. Without one, a throw inside an
// async key handler is an unhandled rejection and the key looks like it did nothing —
// which is the exact failure L already had once.
const oops = (e) => { S.status = c.red('failed: ' + (e?.message ?? e)); draw(); };

// The 5961 shim. Swarm launches go through it so the broker keeps its own view of the
// leader — and, more importantly, so the proxy can read the leader's REQ_ATTACK and tell
// the swarm what to focus on. Nothing else in the system can see that.
const PROXY_PORT = Number(env.M59_PROXY_PORT || 5961);

// Start the proxy if it is not already up, and wait until it is actually accepting — a
// client launched at a port nothing is listening on sits at a dead login screen, which
// reads as "the swarm key did nothing".
async function ensureProxy(host, port) {
  const listening = await new Promise(res => {
    const s = net.connect(PROXY_PORT, '127.0.0.1');
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
    setTimeout(() => { s.destroy(); res(false); }, 800);
  });
  if (listening) return { started: false, ok: true };
  const proxy = join(REPO, 'tools', 'm59-proxy.mjs');
  // --observe: forward and rewrite, inject nothing. A swarm only needs to WATCH the
  // leader; taking over its stream buys nothing and risks the operator's own session.
  const child = spawn(process.execPath,
    [proxy, '--listen', String(PROXY_PORT), '--server', `${host}:${port}`, '--observe'],
    { stdio: 'ignore', detached: false, windowsHide: true });
  child.unref();
  for (let i = 0; i < 20; i++) {
    const up = await new Promise(res => {
      const s = net.connect(PROXY_PORT, '127.0.0.1');
      s.once('connect', () => { s.destroy(); res(true); });
      s.once('error', () => res(false));
      setTimeout(() => { s.destroy(); res(false); }, 300);
    });
    if (up) return { started: true, ok: true };
    await new Promise(r => setTimeout(r, 250));
  }
  return { started: true, ok: false };
}

async function launch(row, { viaProxy = false } = {}) {
  const creds = rosterFor(row.agent);
  if (!creds) { S.status = c.red('no credentials on file for ' + row.agent); return; }
  // THE PATCHED CLIENT FIRST — see the header. Its directory has no `steamapps` in it, so
  // isSteamInstall says no and `/S` stays off, which is right: it is a build, not a
  // Steam install that would try to patch itself.
  const devExe = WIN && !env.M59_TUI_STOCK_CLIENT && existsSync(DEV_CLIENT()) ? DEV_CLIENT() : null;
  // Otherwise FIND THE CLIENT THE WAY doctor AND THE SHORTCUTS FIND IT. This was a
  // hardcoded `C:\Program Files (x86)\...`, which on Linux is not a path at all — and on
  // a Windows box with Steam installed anywhere else was simply wrong.
  const clientDir = devExe ? dirname(devExe) : findClient();
  const exe = devExe || findClientExe(clientDir);
  if (!exe) {
    S.status = c.red('no Meridian 59 client found') + ' ' +
      c.dim('· set M59_CLIENT to its folder · store.steampowered.com/app/' + STEAM_APPID);
    return;
  }
  // THE CHARACTER'S OWN SERVER, not this machine's.
  //
  // A roster entry records the host and port it was joined against, because a fleet is
  // per-server and one broker can hold characters on several. Reading the environment
  // instead sent the client to 127.0.0.1 for every character in it — fine while the
  // only server was local, and silently wrong the moment one was not. It does not fail
  // cleanly either: the client opens, finds nothing on that port, and sits there, which
  // reads as the launch key doing nothing rather than as connecting to the wrong place.
  //
  // The environment stays as the fallback for a roster written before host and port
  // were recorded.
  const realHost = creds.host || env.M59_HOST || '127.0.0.1';
  const realPort = String(creds.port || env.M59_PORT || '5959');
  // A swarm launch points the client at the proxy instead of the game server. Same
  // credentials, same everything else — the only difference is who is in the middle.
  let host = realHost, port = realPort;
  if (viaProxy) {
    const p = await ensureProxy(realHost, realPort);
    if (!p.ok) {
      S.status = c.red(`proxy would not come up on ${PROXY_PORT} — launching direct, ` +
                       `the swarm will not be able to see this character`);
      draw();
    } else {
      host = '127.0.0.1'; port = String(PROXY_PORT);
      S.status = c.dim(p.started ? `started the proxy on ${PROXY_PORT}… ` : `proxy already up… `);
    }
  }
  const steam = isSteamInstall(clientDir);
  // The same list m59-shortcuts.mjs bakes into a .desktop/.lnk, from the same function,
  // so /S cannot go missing from one of them alone. host and port are passed ON THE
  // ENTRY because they are already resolved above — a swarm launch points them at the
  // proxy, and clientArgs prefers the entry's own over the fallback.
  const args = clientArgs({ ...creds, host, port }, { host, port }, steam);
  // KEEP THE OUTPUT. Throwing it away is what made a failed launch indistinguishable
  // from a slow one — the injector reports its verdict on stdout and exits 1 on trouble.
  const logPath = join(REPO, 'substrate', 'm59-launch.log');
  let stdio = 'ignore';
  try { const fd = openSync(logPath, 'a'); stdio = ['ignore', fd, fd]; } catch { /* keep going */ }

  if (!WIN) return launchViaSteam({ row, creds, clientDir, steam, args, stdio, viaProxy });

  const inject = join(REPO, 'tools', 'm59-inject.ps1');
  // LAUNCH IT FROM ITS OWN DIRECTORY. The client resolves `resource\` relative to the
  // working directory, so started from the repo it cannot find the module DLLs it is
  // told to load and takes an access violation shortly after BP_LOAD_MODULE — which
  // reads as a stall, because the last thing on the wire is a healthy ping exchange.
  // Start-Process inherits OUR cwd unless told otherwise, so it has to be told.
  //
  // Start-Process wants one PowerShell-quoted string per argument; doubling an embedded
  // quote is the whole of PowerShell's single-quote escaping.
  const psArgs = args.map(a => `'${String(a).replace(/'/g, "''")}'`);
  // Start the client, give it time to come up, then inject. Done in one detached
  // PowerShell so closing this TUI does not take the client with it.
  const ps = [
    `Write-Output "=== $(Get-Date -Format o) launching `
      + `${row.character ?? row.agent} (${creds.account}) ==="`,
    ...(devExe ? devStartLines(creds, host, port, row.character ?? row.agent) : [
      `if (-not (Test-Path '${exe}')) { Write-Output 'NO CLIENT AT THAT PATH'; exit 1 }`,
      `$p = Start-Process -FilePath '${exe}' -WorkingDirectory '${dirname(exe)}' `
        + `-ArgumentList ${psArgs.join(',')} -PassThru`,
    ]),
    // WAIT FOR THE WINDOW RATHER THAN GUESSING AT IT. A fixed sleep was the reason this
    // key looked broken: a cold Steam start takes upwards of fifteen seconds to become
    // a process with a window, the injector ran at six, found nothing, and exited 1 —
    // leaving a client that is perfectly playable by hand and invisible to the MCP,
    // which is the exact failure that is easiest to misread as "L did nothing".
    // Wait on OUR pid, not on "any Meridian": several clients run at once here, and
    // waiting for any of them returns instantly when one is already up, injecting into
    // the old client and leaving the new one bare. Injection itself is idempotent —
    // m59-inject.ps1 skips a client that already carries the module — so the sweep it
    // does afterwards is safe.
    // CLAIM THE CHARACTER THE MOMENT THE CLIENT EXISTS, and do it from here rather
    // than from the TUI: this script already holds the pid, and it runs whether or not
    // the terminal is still open. The claim stops the keeper and tells the reconciler
    // to leave the character alone; the broker then polls this pid and gives the
    // character back on its own when the client is closed.
    `$body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"pilot",'`
      + `+ '"arguments":{"action":"claim","agent":"${row.agent}","pid":' + $p.Id + '}}}'`,
    `try { Invoke-RestMethod -Uri 'http://127.0.0.1:${PORT}/' -Method Post `
      + `-ContentType 'application/json' -Body $body -TimeoutSec 10 | Out-Null; `
      + `Write-Output "claimed ${row.agent} for pid $($p.Id)" } `
      + `catch { Write-Output "pilot claim FAILED: $_" }`,
    `$t=0; while ($t -lt 120 -and -not $p.HasExited -and $p.MainWindowHandle -eq 0) `
      + `{ Start-Sleep -Milliseconds 500; $p.Refresh(); $t++ }`,
    `Write-Output "waited $($t*0.5)s for a window; pid $($p.Id); exited $($p.HasExited)"`,
    // A window exists; give it a moment to finish coming up before writing to it.
    'Start-Sleep -Seconds 3',
    `& powershell -NoProfile -ExecutionPolicy Bypass -File '${inject}'`,
  ].join('; ');
  // NOT detached — that is what made this key do nothing at all. `detached: true` on
  // Windows means DETACHED_PROCESS, which gives the child no console; powershell.exe
  // needs one and dies on the spot, before running a single statement. With stdio
  // ignored as well, it failed in perfect silence. Verified directly: a detached
  // PowerShell told to write a file never wrote it, while the same command attached
  // ran fine.
  //
  // Nothing is lost by staying attached. The client is started by Start-Process, which
  // makes it a process of its own that outlives all of this regardless, and unref lets
  // the TUI exit whenever it likes. Only the ~20s launcher is tied to us now.
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
                      { stdio, windowsHide: true });
  child.unref();
  child.on('error', e => { S.status = c.red('could not start powershell: ' + e.message); draw(); });
  S.status = c.green(`launching ${row.character ?? row.agent}…`) + ' ' +
             c.dim((devExe ? 'patched client via shortcuts/dev.bat' : 'Steam client') +
                   ' · ~20s · log: substrate/m59-launch.log · keep the client focused or it drops movement');
  // The pilot claim stops the keeper, which leaves an errand sitting there to resume when
  // the client closes — that is fine and deliberate. A PAIRING is not: the other half is
  // now waiting in a room for a character that is in a client window, and it will not
  // start a fight without it. Neither is announced anywhere else.
  noteCommitment(row);

  // TELL THE BROKER TO LOOK. It does not hunt for clients on a timer — scanning costs a
  // process spawn, so it goes quiet once it has seen no client and waits to be told.
  // This IS the telling, and without it the character launched here comes up unclaimed:
  // the operator stands in the room with none of the privileges the launch was for, and
  // the only sign is that spoken commands are heard and ignored. That exact failure is
  // why the automatic claim exists at all — see m59-localclient.mjs.
  const r = await call('pilot', { action: 'rearm', why: `the terminal launched ${row.agent}` }, 4000);
  if (r?.__error) {
    S.status += ' ' + c.red('· broker not told to watch (' + r.__error + ') — `pilot claim` by hand');
    draw();
  }
  // Handed back for --launch, which has to outlive it — see there.
  return child;
}

// START THE PATCHED CLIENT THROUGH dev.bat, AND FIND THE PROCESS IT MADE.
//
// A .bat that `start`s something cannot hand a pid back, and everything after this line
// in the launcher — the pilot claim, the wait for a window, the injection — needs one.
// So the client is found afterwards, by the account on its command line (the same thing
// m59-localclient.mjs matches clients on) and by having been created after we asked. The
// timestamp is what excludes a second window somebody left open on the same account; a
// client that never appears is reported rather than waited on for ever.
//
// dev.bat is (re)written first, so the file on disk is always the current tool's opinion.
// Each argument is double-quoted for cmd inside PowerShell's single quotes — a password
// with a space in it survives, one with a double quote does not, and no roster here has
// either.
function devStartLines(creds, host, port, character) {
  const { path: bat } = ensureUniversalLauncher();
  const args = universalLauncherArgs({ ...creds, character }, { host, port })
    .map(a => `'"${String(a).replace(/'/g, "''")}"'`);
  return [
    `$t0 = (Get-Date).AddSeconds(-2)`,
    `if (-not (Test-Path '${bat}')) { Write-Output 'NO dev.bat AT ${bat}'; exit 1 }`,
    `Start-Process -FilePath '${bat}' -ArgumentList ${args.join(',')} -WindowStyle Hidden`,
    `$c = $null; $t = 0`,
    `while ($t -lt 60 -and -not $c) { $c = Get-CimInstance Win32_Process -Filter "Name='meridian.exe'" `
      + `| Where-Object { $_.CommandLine -like '*/U:${creds.account} *' -and $_.CreationDate -ge $t0 } `
      + `| Select-Object -First 1; if (-not $c) { Start-Sleep -Milliseconds 250; $t++ } }`,
    `if (-not $c) { Write-Output 'NO CLIENT APPEARED within 15s of dev.bat — run shortcuts\\dev.bat by hand to see why'; exit 1 }`,
    `$p = Get-Process -Id $c.ProcessId`,
  ];
}

// SAY WHAT THIS INTERRUPTS — shared by both platforms, because what a character is in the
// middle of has nothing to do with which operating system is starting the client.
function noteCommitment(row) {
  const held = commitmentOf(row);
  if (held) S.status += ' ' + c.yellow(`· still ${held.label}`) +
    c.dim(held.kind === 'partner' ? ' — its partner is now waiting on a client window; X releases it'
                                  : ' — resumes when the client closes; X cancels it');
}

// ------------------------------------------------------------------ launching, Linux
//
// The client is a Windows binary and Proton belongs to Steam, so `steam -applaunch <appid>
// <args>` is the one supported way to start it with arguments of our own — the same
// command m59-shortcuts.mjs bakes into every .desktop file. Running the .exe directly
// would mean assembling a Proton prefix by hand, which is not a shortcut.
//
// TWO THINGS THE WINDOWS PATH DOES THAT THIS ONE CANNOT, and both are said out loud
// rather than left to be discovered:
//
//   * NO DLL INJECTION. m59-inject.ps1 is Win32 CreateRemoteThread against a local
//     process; from this side the client lives inside a Proton prefix and there is no
//     equivalent reach into it. So the character is playable BY HAND only.
//   * THE PILOT CLAIM IS NOT MADE FROM HERE, but it is no longer absent. The launcher
//     cannot make it — that needs the client's pid, and `steam -applaunch` returns
//     immediately with the game a Proton grandchild — so it is the broker's own scan that
//     answers, and that scan now has a POSIX branch: `/proc/<pid>/cmdline` carries the
//     `/U:` Proton passed straight through. So the claim arrives within one scan (8s)
//     rather than never, and `pilot claim` by hand remains the way to have it at once.
//
// Logging in bumps the broker off the character, one connection per character, so until
// that scan lands the 45s rejoin sweep can still fight the client for it. Launch with S
// (via the proxy) rather than L when even a few seconds of that matters.
function launchViaSteam({ row, clientDir, steam, args, stdio }) {
  if (!steam) {
    S.status = c.red('that client is not a Steam install') + ' ' +
      c.dim(`· ${clientDir} · on Linux only \`steam -applaunch\` can start it`);
    return;
  }
  // Detached, unlike the Windows branch: there is no console to inherit and nothing to
  // stay attached for, so quitting the TUI never takes the client with it.
  const child = spawn('steam', ['-applaunch', STEAM_APPID, ...args], { stdio, detached: true });
  child.unref();
  child.on('error', e => {
    S.status = e.code === 'ENOENT'
      ? c.red('steam is not on PATH') + ' ' + c.dim('· it is what starts a Proton client')
      : c.red('could not start steam: ' + e.message);
    draw();
  });
  S.status = c.green(`launching ${row.character ?? row.agent}…`) + ' ' +
             c.dim('~20s via Steam · log: substrate/m59-launch.log') + ' ' +
             c.yellow('· claim within ~8s') +
             c.dim(' — the broker reads /U: off /proc; `pilot claim` for it now. No DLL' +
                   ' injection on Linux, so this character is playable BY HAND only');
  noteCommitment(row);
  draw();
}

// S — LAUNCH AS THE SWARM LEADER. The same launch as L, plus handing the rest of the
// fleet over to whatever is running the swarm.
//
// IT DOES NOT START A PROXY, and that is the interesting part. The obvious design routes
// the leader through `m59-proxy.mjs` so the broker can still see it — the server allows
// one connection per character, so an ordinary login takes the broker's. But `L` already
// injects `m59agent.dll`, which exists expressly to drive a client "without a proxy in
// the path", and it already answers `pos` with `{room,x,y,angle}` read from the client's
// own player struct (m59agent.c:169). That is the CLIENT's own room id, so it changes the
// instant a new map loads: the swarm follows through doors with no proxy, no rewritten
// security stream, and no guessing which exit somebody took.
//
// WHAT IT HANDS OVER, AND WHAT IT KEEPS. `movement` and `work` go to the swarm — where to
// stand and what to hit are exactly what following a leader means. `survival`, `mortality`
// and `recovery` STAY WITH THE KEEPER, so a follower walked into something it cannot beat
// still breaks off and still walks itself out of the Underworld. A swarm is a decision
// about work, never about whether a character may die.
async function swarm(row) {
  // THROUGH THE PROXY, ALWAYS. It is what lets the broker keep seeing this character
  // once the client takes the connection, and it is the only thing in the system that can
  // read the operator REQ_ATTACK and tell the swarm what to focus fire on.
  await launch(row, { viaProxy: true });
  const others = S.rows.filter(x => x.agent !== row.agent && x.in_game !== false);
  let took = 0, failed = [];
  for (const o of others) {
    const res = await call('autopilot', {
      agent: o.agent, action: 'claim',
      faculties: ['movement', 'work'],
      by: `swarm/${row.agent}@terminal`,
      // Leases fail BACK to the keeper rather than open, so a swarm whose driver dies
      // returns each character to the thing that knows how to keep it alive.
      lease_ms: 120000,
    }, 6000);
    if (res?.__error) failed.push(o.agent); else took++;
  }
  S.status += ' ' + c.bold(c.cyan(`· SWARM: ${took} following ${row.character ?? row.agent}`)) +
    (failed.length ? c.red(` · ${failed.length} refused (${failed.slice(0, 3).join(',')})`) : '') +
    c.dim(' · movement+work only; the keeper keeps the survival floor');
}

// ------------------------------------------------------------- the commander
//
// B — ALL OF THEM AT ONCE, ON A BOARD.
//
// `L` gives you one character in the real client, and that is the one thing it cannot
// scale: twenty-one windows is not a view of a fleet. `maps/m59-boswars` is a Bos Wars
// build converted into a Meridian 59 commander — an RTS board that reads this same
// broker's RTS endpoints and draws the whole roster at once — and this is the key that
// opens it already pointed at the fleet this terminal is showing.
//
// WHICH FLEET IS THE ENTIRE POINT OF THE KEY. Opened by hand, the commander discovers
// every roster this machine holds and asks you to pick one, so picking wrong opens a
// board of characters nobody is watching — and a board of the wrong fleet looks exactly
// like a board that works. The label goes through, so the two are never a different
// fleet. The broker port goes with it for the same reason: this terminal may be talking
// to a broker the commander's own discovery would not have looked on.
//
// IT IS A SEPARATE REPOSITORY AND IT MAY NOT BE HERE. The harness has to keep working
// for someone who cloned it on its own, so this reports what is missing rather than
// depending on it. `M59_BOSWARS` names it when it does not live beside us.
//
// NOT `-Yes`. The commander's menu confirms before it would start a server or a broker,
// and a keypress in a full-screen app is the worst place for that decision to be made
// silently. If this terminal is drawing characters then a broker is already holding
// this fleet and the prompt never appears; if it is not, being asked is correct.
const BOSWARS = env.M59_BOSWARS || join(REPO, '..', 'm59-boswars');

// WHICH LAUNCHER. `m59.mjs` is the portable one and is preferred everywhere; `m59.ps1`
// is the Windows toolchain's and is the fallback only where PowerShell exists. Choosing
// by what is on disk rather than by platform means a checkout carrying only one of them
// still works, and a Linux box is never handed the .ps1 — which is how this key used to
// fail, with `spawn cmd ENOENT`, since there is no cmd.exe to start powershell with.
function commanderLauncher() {
  const portable = join(BOSWARS, 'm59.mjs');
  if (existsSync(portable)) return { kind: 'node', path: portable };
  const windows = join(BOSWARS, 'm59.ps1');
  if (existsSync(windows) && process.platform === 'win32') return { kind: 'ps1', path: windows };
  return null;
}

function commander() {
  const launcher = commanderLauncher();
  if (!launcher) {
    S.status = c.red('no commander beside this checkout') +
      c.dim(` · looked for ${join(BOSWARS, 'm59.mjs')} · it is its own repository` +
            ' (maps/m59-boswars); set M59_BOSWARS if it lives elsewhere');
    return;
  }
  // The label becomes a command-line argument. resolveFleet() already refuses anything
  // that is not a name, and 'default' is the only other thing it can produce — so this
  // can only trip if that changes, and stopping here beats passing it on.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(FLEET_LABEL)) {
    S.status = c.red(`refusing to hand ${JSON.stringify(FLEET_LABEL)} over as a fleet name`);
    return;
  }
  // A WINDOW OF ITS OWN, because this one is a full-screen app. The menu prints which
  // fleets it found and whether this one is COMMAND or SPECTATE, then the launcher
  // prints twenty seconds of gateway and client startup — none of which can land here
  // without taking the board apart.
  //
  // ON WINDOWS `cmd /c start` is what makes that console and `-NoExit` keeps it after a
  // failure, which is the only time you need to read it. ON LINUX THERE IS NO `cmd`, and
  // spawning it is exactly the `spawn cmd ENOENT` this key used to die with. There is
  // also no one terminal emulator to depend on, so the terminals are tried in turn and
  // the last resort is to run detached with the output on a log — a launcher you can
  // read afterwards beats a window that never opened.
  let file, args;
  if (process.platform === 'win32') {
    const inner = launcher.kind === 'node'
      ? ['node', launcher.path, '--choice', FLEET_LABEL]
      : ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit',
         '-File', launcher.path, '-Choice', FLEET_LABEL];
    // Only when it is not the port the commander would have tried anyway, so this key
    // still works against a boswars checkout that predates the parameter.
    if (PORT !== '8901') inner.push(launcher.kind === 'node' ? '--broker-port' : '-BrokerPort', PORT);
    file = 'cmd';
    args = ['/c', 'start', '', ...inner];
  } else {
    const inner = [process.execPath, launcher.path, '--choice', FLEET_LABEL];
    if (PORT !== '8901') inner.push('--broker-port', PORT);
    const term = ['x-terminal-emulator', 'konsole', 'gnome-terminal', 'xfce4-terminal', 'xterm']
      .find(t => { try { return spawnSync('command', ['-v', t], { shell: true }).status === 0; } catch { return false; } });
    if (term) {
      file = term;
      args = term === 'gnome-terminal' ? ['--', ...inner] : ['-e', ...inner];
    } else {
      file = inner[0];
      args = inner.slice(1);
    }
  }
  const child = spawn(file, args, { cwd: BOSWARS, stdio: 'ignore', detached: true });
  child.unref();
  child.on('error', e => { S.status = c.red('could not open the commander: ' + e.message); draw(); });
  S.status = c.green(`opening the commander on ${FLEET_LABEL}…`) + ' ' +
    c.dim('· its own window · it says COMMAND or SPECTATE before it connects · Start Game there');
}

// The same path the L key takes, without the terminal:
//
//   node tools/m59-tui.mjs --launch q4
//
// A full-screen app is the worst place from which to diagnose a launch, because the
// thing that went wrong is on a stream the app is not showing. This runs the identical
// function and prints where the log is.
const li = argv.indexOf('--launch');
if (li >= 0) {
  const agent = argv[li + 1];
  if (!agent) { console.error('usage: m59-tui.mjs --launch <agent>'); exit(2); }
  // AWAITED, or the process exits before the broker has been told to watch for the
  // client this just started — and the automatic claim silently never happens.
  const logPath = join(REPO, 'substrate', 'm59-launch.log');
  let before = 0;
  try { before = readFileSync(logPath, 'utf8').length; } catch { /* no log yet */ }
  const child = await launch({ agent });
  console.log(S.status.replace(/\x1b\[[0-9;]*m/g, ''));
  // AND THEN WAIT FOR THE LAUNCHER, or it dies with us. On Windows, node puts a child it
  // did not detach into a job object that is killed when node exits — and the launcher
  // is deliberately not detached, because a detached powershell has no console and dies
  // before its first statement. Interactively the terminal stays up for the ~20s the
  // launcher needs; here nothing did, so the client was started, or not, and the log
  // stopped at its header line. This waits, then prints what the launcher wrote, which
  // is the whole point of running it from a command line.
  // ref() undoes the unref() launch() did for the terminal's sake: an unref'd child is
  // not a reason for node to keep running, and this await would otherwise be reported
  // as unsettled and the process would exit anyway.
  if (child?.pid) { child.ref(); await new Promise(r => { child.on('exit', r); child.on('error', r); }); }
  try {
    const tail = readFileSync(logPath, 'utf8').slice(before).trimEnd();
    if (tail) console.log(tail);
  } catch { /* nothing written */ }
  exit(0);
}

// The roster is the only place the passwords live, and it is read here rather than
// fetched, because the broker deliberately does not serve them over the network.
function rosterFor(agent) {
  try {
    // Resolved from this file and the --fleet flag, never from cwd. The TUI is often
    // launched from somewhere else entirely — from a parent repository that vendors
    // this one, or by a shortcut with no working directory set. Reading cwd gave a
    // missing file, which this reports as "no credentials" — indistinguishable from
    // a character that genuinely has none.
    const f = STATE_FILE;
    const s = JSON.parse(readFileSync(f, 'utf8'));
    return s[agent]?.credentials ?? null;
  } catch { return null; }
}

// ------------------------------------------------------------- the compendium
//
// The compendium's bestiary already recalculates every row against a reference
// character — but that character is a preset you type in by hand, and the real one is
// on the line above the cursor. So C hands it over: it starts the loopback server if
// nothing is serving, then opens the browser at an endpoint that reads the character
// out of the broker, sets a cookie with it, and redirects to the bestiary.
//
// P IS THE SAME HANDOVER POINTED THE OTHER WAY. C asks "what can this character survive";
// P opens the planner, which asks "what should it be carrying", and writes the answer to
// substrate/loadouts/<name>.json where the keeper reads it. One key each, because they are
// the two directions of the same import and neither is a submenu of the other.
//
// A character not in game gets the compendium anyway, without the import. The pages
// are worth reading on their own, and an error page would be a worse answer to a key
// than a working one with a note.
async function compendium(row, to = '/creatures/') {
  const live = row?.in_game !== false && row?.agent;
  const what = to === '/planner/' ? 'planner' : 'compendium';
  S.status = c.dim(`opening the ${what}…`);
  draw();
  try {
    const how = await ensureServing(COMPENDIUM_PORT);
    const url = live ? importUrl(row.agent, to, COMPENDIUM_PORT)
                     : `http://127.0.0.1:${COMPENDIUM_PORT}${to}`;
    openBrowser(url);
    S.status = c.green(how.already ? `${what} already serving` : `started the ${what}`)
      + ' ' + c.dim(`· 127.0.0.1:${COMPENDIUM_PORT} · `)
      + (live ? c.cyan(to === '/planner/'
                        ? `planning ${row.character ?? row.agent}`
                        : `bestiary computed for ${row.character ?? row.agent}`)
              : c.yellow('no character imported — that one is not in game'));
  } catch (e) {
    S.status = c.red(`${what}: ` + e.message);
  }
  draw();
}

// F — THE FIELD COMMAND PAGE, WHICH IS THE BROWSER HALF OF THIS TERMINAL.
//
// `maps/m59-strategy-game` is a command surface for the fleet this broker already holds:
// a world map, the roster on it, and a small set of orders that become ordinary broker
// calls. It is the view this terminal cannot give — a map — and the terminal is the view
// it cannot give, which is why both exist and why this is one key rather than a rewrite.
//
// ENSURES, THEN OPENS. Same contract as `C`: if it is not running, start it and wait for
// it to answer before pointing a browser at it, because a browser opened at a port that
// is still compiling shows a connection error and teaches the operator the key is broken.
//
// IT IS A SEPARATE REPOSITORY AND IT MAY NOT BE HERE. Absent, uninstalled, and somebody
// else's server on the port are three different answers and this says which — the same
// arrangement `B` has with maps/m59-boswars.
async function fieldCommand() {
  S.status = c.dim('opening field command…');
  draw();
  try {
    const before = await webui.status();
    if (before.absent) {
      S.status = c.yellow('field command: not installed beside this checkout') + ' ' +
                 c.dim(`· ${before.why}`);
      return draw();
    }
    if (!before.installed && !before.running) {
      S.status = c.yellow('field command is not installed') + ' ' +
                 c.dim('· run: node tools/m59-webui.mjs install');
      return draw();
    }
    const r = before.running ? before : await webui.start({ log: () => {} });
    if (!r.ok && !r.running) {
      S.status = c.red('field command did not come up') + ' ' +
                 c.dim(`· read substrate/webui.log`);
      return draw();
    }
    const url = `http://127.0.0.1:${r.port ?? 3000}`;
    openBrowser(url);
    S.status = c.green(before.running ? 'field command already serving' : 'started field command') +
               ' ' + c.dim(`· ${url}`) +
               (before.running && before.ours === false
                 ? ' ' + c.yellow('(this checkout did not start it)') : '');
  } catch (e) {
    S.status = c.red('field command: ' + e.message);
  }
  draw();
}

// ------------------------------------------------------------------ keys

// THE OVERRIDE KEY, and what it does depends on where the cursor is — which is why the
// footer says which of the two it is about to do.
//
//   cursor on a character the fleet is using   TAKE IT. Cancel the errand, drop the
//                                              pairing, revive the keeper, and say so.
//   anywhere else                              toggle whether the greyed rows are
//                                              reachable at all.
//
// Taking is one key rather than a confirmation dialog on purpose. The reason to reach for
// it is that something is going wrong right now — a runner walking into a room it will
// not survive, a partner that needs its pair back — and a board that asks "are you sure?"
// during that is a board you stop using. What it does is reversible: dispatch the errand
// again, or set the partner again. What it interrupts is not.
async function override(row) {
  if (!row) { S.override = !S.override; return; }
  const held = commitmentOf(row);
  if (!held) { S.override = !S.override; S.status = S.override
    ? c.yellow('override ON — every character reachable; X on a busy one takes it')
    : c.dim('override off — characters on fleet work are skipped again'); return; }
  const who = row.character ?? row.agent;
  S.status = c.dim(`taking ${who} off ${held.label ?? 'fleet work'}…`);
  draw();
  const r = await call('autopilot', { agent: row.agent, action: 'release',
                                      why: `an operator took ${who} back from the terminal` }, 8000);
  if (r?.__error) { S.status = c.red(`could not release ${who}: ${r.__error}`); return; }
  // Say what it actually undid rather than "done". Releasing a pairing and cancelling a
  // signet run are both "released" and they cost completely different things.
  S.status = r.released
    ? c.green(`took ${who} back`) + ' ' + c.dim('· ' + (r.undone?.join(' · ') || 'nothing to undo'))
    : c.dim(`${who} was not being used for anything`);
  // The row is free now, so it stops being skipped on its own; keep the override on so
  // the cursor does not jump away from the character just taken.
  S.override = true;
  await refresh();
}

function onKey(str, key) {
  if (key.ctrl && key.name === 'c') return quit();
  if (S.view === 'list') {
    if (key.name === 'q' || key.name === 'escape') return quit();
    // ↑↓ STEP OVER THE CHARACTERS THE FLEET IS USING. A step that finds nothing to land
    // on leaves the cursor where it was, which would look exactly like a dead key — so
    // that case says why, and names the key that fixes it.
    if (key.name === 'down' || key.name === 'j' || key.name === 'up' || key.name === 'k') {
      const delta = (key.name === 'down' || key.name === 'j') ? 1 : -1;
      const next = stepSelection(S.rows, S.sel, delta, S);
      if (next === S.sel && !S.override && allCommitted(S.rows))
        S.status = c.yellow('every character is on fleet work — press X to reach them anyway');
      S.sel = next;
    }
    else if (key.name === 'return') {
      S.hero = S.rows[S.sel]; S.view = 'hero'; S.status = '';
      loadHero(S.hero).then(draw);
    } else if (str === 'X' || str === 'x') override(S.rows[S.sel]).then(draw, oops);
    else if (str === 'L' || str === 'l') launch(S.rows[S.sel]).then(draw, fail);
    else if (str === 'S' || str === 's') swarm(S.rows[S.sel]).then(draw, fail);
    // B is about the FLEET, not the row under the cursor — the board draws all of them.
    else if (str === 'B' || str === 'b') commander();
    else if (str === 'F' || str === 'f') fieldCommand();
    else if (str === 'C' || str === 'c') compendium(S.rows[S.sel]);
    else if (str === 'P' || str === 'p') compendium(S.rows[S.sel], '/planner/');
    else if (str === 'r') { S.status = c.dim('refreshing…'); refresh().then(draw); }
  } else {
    if (key.name === 'q' || key.name === 'escape' || key.name === 'return') {
      S.view = 'list'; S.detail = null; S.status = '';
    } else if (str === 'X' || str === 'x') override(S.hero).then(draw, oops);
    else if (str === 'L' || str === 'l') launch(S.hero).then(draw, fail);
    else if (str === 'S' || str === 's') swarm(S.hero).then(draw, fail);
    else if (str === 'B' || str === 'b') commander();
    else if (str === 'F' || str === 'f') fieldCommand();
    else if (str === 'C' || str === 'c') compendium(S.hero);
    else if (str === 'P' || str === 'p') compendium(S.hero, '/planner/');
    else if (str === 'r') { refresh().then(() => { S.hero = S.rows.find(r => r.agent === S.hero.agent) ?? S.hero; draw(); }); }
  }
  draw();
}

function quit() {
  clearInterval(timer);
  cursor(true); alt(false);
  exit(0);
}

// ------------------------------------------------------------------ go

alt(true); cursor(false); clear();
const readline = await import('node:readline');
readline.emitKeypressEvents(stdin);
if (stdin.isTTY) stdin.setRawMode(true);
stdin.on('keypress', onKey);
stdout.on('resize', draw);

draw();
await refresh();
draw();
const timer = setInterval(async () => {
  await refresh();
  if (S.view === 'hero') S.hero = S.rows.find(r => r.agent === S.hero?.agent) ?? S.hero;
  draw();
}, REFRESH_MS);
