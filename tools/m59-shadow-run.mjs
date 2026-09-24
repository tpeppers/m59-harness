#!/usr/bin/env node
// RUN A FLEETSCRIPT AGAINST A FRESH SHADOW COPY OF PRODUCTION — the whole bring-up, in
// one command, so that a rehearsal is cheaper than a guess.
//
//   node tools/m59-shadow-run.mjs farm-loop-test               build a shadow fleet, run the pad
//   node tools/m59-shadow-run.mjs farm-loop-test laps=2 rounds=12
//   node tools/m59-shadow-run.mjs --list                       what can be run
//   node tools/m59-shadow-run.mjs farm-loop-test --dry         say what it would do, touch nothing
//   node tools/m59-shadow-run.mjs farm-loop-test --from run    the fleet is already up, just run it
//   node tools/m59-shadow-run.mjs farm-loop-test --no-skills   a bare body, to isolate geometry
//   node tools/m59-shadow-run.mjs farm-loop-test --no-items --no-guild   no pack, gear or guild
//   node tools/m59-shadow-run.mjs farm-loop-test --trim-items  also delete what prod does not carry
//
// WHAT THIS IS FOR. "Will twenty-three production characters survive this errand" is a
// question nobody should answer by running it on production. A shadow fleet is the answer:
// a disposable copy of prod's characters — same attributes, same max health, same gear,
// same abilities — standing on a loopback test server where a death costs nothing. The
// steps to get one have always existed. What did not exist was a command that does them in
// the right order, with the right flags, and refuses the arrangements that silently do not
// work. Every one of the notes below is a failure that has happened, most of them on
// 2026-09-16, and most of them presented as something else entirely.
//
// A SHADOW FLEET IS A REUSABLE TEST COPY, AND THAT IS A PROPERTY OF THIS FILE.
// Operator: *"You can always clone a new shadow fleet, they're meant to be reusable test
// copies from prod."* That is now true rather than aspirational — `build` resumes a
// half-made fleet instead of skipping it, and `dress` re-dresses one that already exists.
// Running this twice in a row is a supported thing to do, and the second run is the one
// that used to be impossible.
//
// ------------------------------------------------------------------ the five stages
//
//   preflight  prod is readable, the test server is up, the maintenance socket answers,
//              and the fleet about to be written is NOT prod.
//   snapshot   read production READ-ONLY: names, attributes, max health, abilities, the whole
//              pack with amounts, what is worn, the purse, guild + rank, the hall's chests.
//   build      a CONSTRUCTION broker (see below), then create, then dress.
//   play       swap to an ordinary broker and wait for the characters to reach the world.
//   run        compile the named FleetScript and drive the shadow fleet with it.
//
// `--from <stage>` starts partway in, which is what you want while iterating on a script:
// the fleet is already standing there and rebuilding it costs ten minutes for nothing.
//
// ------------------------------------------------------ THE FOUR THINGS THAT GO WRONG
//
// **1. A BROKER THAT IS BUILDING A FLEET MUST NOT BE PLAYING IT.** The broker resumes its
// roster at startup and spawns one keeper process per entry, and each keeper takes that
// account's single allowed connection. `reroll` has to log into the same account to send
// BP_NEW_CHARINFO, so it can never get in, and the 45-second rejoin sweep puts the keepers
// back for as long as the rebuild lasts. This only bites on a REBUILD — the first shadow
// fleet is built against an empty roster, which spawns no keepers and works perfectly — so
// it reads as "creation is broken now" rather than "creation is holding its own door shut".
// `build` therefore runs the broker with `--no-resume --no-rejoin` and `play` swaps it.
//
// **2. THE GAME SERVER IS NAMED EXPLICITLY, ALWAYS.** A broker with no roster to read falls
// back to its own default, which is `127.0.0.1:5959` — a DIFFERENT SERVER. It says so in
// its log, in one line, among thousands: *"game server 127.0.0.1:5959 (this process's
// default; the roster names none)"*. Characters were created there for an hour while the
// failure was read as a broken world. M59_HOST/M59_PORT are set on every broker this file
// starts, and `preflight` checks the port is actually listening first.
//
// **3. STOPPING A BROKER TAKES BOTH PORTS.** `m59-service.mjs stop` quiesces via the
// DASHBOARD port, which has an independent default — so `stop --http 8971` finds the right
// pid and sends the shutdown to 8902, which on this machine is PRODUCTION's dashboard.
// That took prod down for twenty-five minutes on 2026-09-16. Fixed on
// `fix-stop-dashboard-port`, unmerged at the time of writing, so this file passes both
// ports on every stop and will keep doing so — it costs nothing once the fix lands.
//
// **4. PRODUCTION IS READ, NEVER WRITTEN.** The only thing this file asks prod for is the
// snapshot, over the prod broker's own read path. It refuses outright if the fleet it is
// about to create into is named `prod`, and it never starts, stops or commands a broker on
// the production port. A shim that can write to prod is not a shim, it is a second way to
// break prod.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const STAGES = ['preflight', 'snapshot', 'build', 'play', 'run'];

const FLEET      = arg('--fleet', 'shadow');
const HTTP_PORT  = Number(arg('--http', 8971));
const DASH_PORT  = Number(arg('--dashboard', HTTP_PORT + 1));
const [GAME_HOST, GAME_PORT] = String(arg('--server', '127.0.0.1:15959')).split(':');
const [ADMIN_HOST, ADMIN_PORT] = String(arg('--admin', '127.0.0.1:19998')).split(':');
const PROD_PORT  = Number(arg('--prod-port', 8901));
const NEED       = Number(arg('--need', 0));            // 0 = "most of them", resolved later
const WAIT_MS    = Number(arg('--wait-m', 8)) * 60_000;
const DRY        = has('--dry');

// THE SHADOW TOOL IS NOT NECESSARILY IN THIS CHECKOUT, AND THAT IS DELIBERATE.
// `m59-shadow.mjs` is gitignored on purpose — it carries the shape of a real roster — so it
// lives in whichever checkout built the fleet and does NOT travel with a deploy. Looking for
// it beside this file and giving up is therefore wrong most of the time. Ask for it in the
// order that is actually true: this checkout, then an explicit override, then the deploy.
const SHADOW_TOOL = (() => {
  const named = arg('--shadow-tool') || process.env.M59_SHADOW_TOOL;
  if (named) return resolve(named);
  const mine = join(HERE, 'm59-shadow.mjs');
  if (existsSync(mine)) return mine;
  const deploy = 'C:/code/m59-lab/prod-deploy/tools/m59-shadow.mjs';
  if (existsSync(deploy)) return deploy;
  return null;
})();

// The roster this fleet's credentials live in. Named explicitly on every child process,
// because a child that resolves it differently operates on a different fleet in silence —
// which is the failure `m59-which.mjs` exists for, arriving through the back door.
const ROSTER = resolve(arg('--roster',
  process.env.M59_STATE_FILE || join(REPO, 'substrate', 'fleets', `${FLEET}.json`)));

// The roster IS the fleet: its keys are the slot names every tool addresses characters by.
// Read from disk rather than from a broker's /health, so this answers the same before the
// fleet is logged in as after — the shim has to know who it is building for at stage 1.
const rosterAgents = () => {
  try { return Object.keys(JSON.parse(readFileSync(ROSTER, 'utf8'))); } catch { return []; }
};

const say = (s = '') => console.log(s);
const stage = (n, s) => say(`\n=== ${n}/${STAGES.length} ${s} ${'='.repeat(Math.max(0, 58 - s.length))}`);

// ---------------------------------------------------------------- small helpers
const listening = (host, port, ms = 3000) => new Promise(res => {
  const s = net.connect(Number(port), host);
  const done = ok => { s.destroy(); res(ok); };
  s.setTimeout(ms, () => done(false));
  s.on('connect', () => done(true));
  s.on('error', () => done(false));
});

const getJson = (port, path, ms = 20000) => new Promise(res => {
  // 20s, NOT the 8s that reads like a sensible timeout. A busy broker's /health is measured
  // at 2573ms under load and has printed "took 7s to answer" twice in one session; a real
  // outage answers instantly with ECONNREFUSED rather than sitting there. An 8s cap against
  // a 7s reality is a coin toss, and every false negative here aborts a bring-up.
  const req = http.get({ host: '127.0.0.1', port, path, timeout: ms }, r => {
    let b = ''; r.setEncoding('utf8'); r.on('data', d => b += d);
    r.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } });
  });
  req.on('timeout', () => { req.destroy(); res(null); });
  req.on('error', () => res(null));
});

// Ask the broker a question through its MCP door. Read-only here — `fleet` is the only tool
// this file calls, and it is how stage 4 finds out what the fleet is DOING rather than merely
// that it exists.
const tool = (name, args = {}, ms = 30000) => new Promise(res => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                                params: { name, arguments: args } });
  const req = http.request({ host: '127.0.0.1', port: HTTP_PORT, path: '/', method: 'POST', timeout: ms,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    r => { let b = ''; r.setEncoding('utf8'); r.on('data', d => b += d);
      r.on('end', () => { try { res(JSON.parse(JSON.parse(b).result.content[0].text)); }
                          catch { res(null); } }); });
  req.on('timeout', () => { req.destroy(); res(null); });
  req.on('error', () => res(null));
  req.end(body);
});

const sh = (cmd, args, { cwd = REPO, env = {}, label = '' } = {}) => new Promise((res) => {
  if (DRY) { say(`  [dry] ${label || cmd} ${args.join(' ')}`); return res({ code: 0, out: '' }); }
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, shell: false });
  let out = '';
  child.stdout.on('data', d => { out += d; process.stdout.write(d); });
  child.stderr.on('data', d => { out += d; });
  child.on('close', code => res({ code, out }));
  child.on('error', e => res({ code: 1, out: String(e.message) }));
});

const node = (tool, args, opts) => sh(process.execPath, [tool, ...args], opts);

// THE SHADOW TOOL IS TOLD WHICH ROSTER, TOO. It keeps its snapshot, its sheets and the
// credentials it writes beside the roster it is given, so a copy of it in a worktree still
// builds the fleet whose passwords it holds — rather than a fresh roster in the worktree that
// has none, where every existing account reads "exists, password not held" for ever.
const shadowToolEnv = () => ({ M59_STATE_FILE: ROSTER });

// Which dress flags this run passes through. Exported for the test: a flag the shim accepts
// and silently does not forward is a flag that does nothing while reading as though it did.
export const DRESS_FLAGS = ['--no-skills', '--no-items', '--trim-items', '--no-guild'];
export const dressFlags = (args) => ['dress', ...DRESS_FLAGS.filter(f => args.includes(f))];

// EVERY BROKER THIS FILE STARTS IS TOLD THREE THINGS, and leaving any of them out has cost
// a session: which roster (or it holds someone else's fleet), which game server (or it
// falls back to 5959), and which two ports (or `stop` quiesces production).
const brokerEnv = () => ({
  M59_STATE_FILE: ROSTER, M59_HOST: GAME_HOST, M59_PORT: String(GAME_PORT),
});

async function stopBroker() {
  return node(join(HERE, 'm59-service.mjs'),
    ['stop', '--fleet', FLEET, '--http', String(HTTP_PORT),
     '--dashboard', String(DASH_PORT), '--force'],
    { env: brokerEnv(), label: 'stop broker' });
}

async function startBroker({ construction }) {
  const extra = construction ? ['--no-resume', '--no-rejoin'] : [];
  return node(join(HERE, 'm59-service.mjs'),
    ['start', '--fleet', FLEET, '--http', String(HTTP_PORT),
     '--dashboard', String(DASH_PORT), ...extra],
    { env: { ...brokerEnv(), ...(construction ? { M59_REJOIN: '0' } : {}) },
      label: construction ? 'start CONSTRUCTION broker' : 'start playing broker' });
}

// ------------------------------------------- THE REFUSALS, AS A PURE FUNCTION
//
// Separated from the socket checks so they can be tested without opening anything, which is
// the only way a guard like this gets a test at all — and a guard with no test is one the
// next person in a hurry deletes. These are the refusals that need no network to decide:
// every one of them is about WHERE this command is pointed, and being wrong about that is
// the failure the whole file exists to prevent.
export function refusals({ fleet, httpPort, dashPort, prodPort = 8901, shadowTool = null } = {}) {
  const out = [];
  // THE ONE THAT IS NOT NEGOTIABLE. This command CREATES and REROLLS characters — `reroll`
  // suicides the existing one and has no undo. Pointed at a fleet somebody plays, it is not
  // a rehearsal, it is the incident.
  if (/^prod/i.test(String(fleet ?? '')))
    out.push(`REFUSING: --fleet "${fleet}" looks like production. This command CREATES ` +
             `and REROLLS characters; it must never be pointed at a fleet anyone plays.`);
  if (Number(httpPort) === Number(prodPort) || Number(dashPort) === Number(prodPort))
    out.push(`REFUSING: ${prodPort} is the production broker's port.`);
  // Both ports must differ, or `stop` quiesces whatever else is on the one they share.
  if (Number(httpPort) === Number(dashPort))
    out.push(`REFUSING: --http and --dashboard are both ${httpPort}.`);
  if (!shadowTool)
    out.push('no m59-shadow.mjs found. It is gitignored and lives only in the checkout ' +
             'that built the fleet — pass --shadow-tool <path> or set M59_SHADOW_TOOL.');
  return out;
}

// ---------------------------------------------------------------- 1. preflight
async function preflight() {
  stage(1, 'preflight');
  const problems = refusals({ fleet: FLEET, httpPort: HTTP_PORT, dashPort: DASH_PORT,
                              prodPort: PROD_PORT, shadowTool: SHADOW_TOOL });

  if (!await listening(GAME_HOST, GAME_PORT))
    problems.push(`the test server is not listening on ${GAME_HOST}:${GAME_PORT}. ` +
                  `Nothing can be created without it, and a broker with no server to talk to ` +
                  `falls back to its own default (5959) rather than failing.`);
  else say(`  test server   ${GAME_HOST}:${GAME_PORT} listening`);

  if (!await listening(ADMIN_HOST, ADMIN_PORT))
    problems.push(`no maintenance socket on ${ADMIN_HOST}:${ADMIN_PORT}. \`dress\` writes ` +
                  `attributes, max health and abilities through it; without it a shadow is a ` +
                  `blank body and every survival result it produces is about the wrong thing.`);
  else say(`  admin socket  ${ADMIN_HOST}:${ADMIN_PORT} listening`);

  // Prod is only ever READ, and only for the snapshot. A prod broker that is down is not a
  // reason to stop if we are not snapshotting.
  const prod = await getJson(PROD_PORT, '/health');
  say(prod?.ok ? `  production    up on ${PROD_PORT} (read-only; snapshot source)`
               : `  production    not answering on ${PROD_PORT} — --skip-snapshot or bring it up`);

  say(`  fleet         ${FLEET}  roster ${ROSTER}`);
  say(`  shadow tool   ${SHADOW_TOOL ?? '(none)'}`);

  if (problems.length) { say(); for (const p of problems) say(`  ${p}`); return false; }
  return true;
}

// ---------------------------------------------------------------- 2. snapshot
async function snapshot() {
  stage(2, 'snapshot production (READ ONLY)');
  if (has('--skip-snapshot')) { say('  skipped (--skip-snapshot): using the snapshot on disk'); return true; }
  const r = await node(SHADOW_TOOL, ['snapshot'], { cwd: dirname(dirname(SHADOW_TOOL)), env: shadowToolEnv() });
  return r.code === 0;
}

// ---------------------------------------------------------------- 3. build
async function build() {
  stage(3, 'build the shadow fleet');
  // See note 1 at the top: this broker must not be playing the fleet it is building.
  await stopBroker();
  const up = await startBroker({ construction: true });
  if (up.code !== 0) return false;

  const cwd = dirname(dirname(SHADOW_TOOL));
  const made = await node(SHADOW_TOOL, ['create'], { cwd, env: shadowToolEnv() });
  // `create` exits non-zero when ANY character failed, including ones that were already
  // there and correct. Read the fleet back instead of trusting the exit code — that is this
  // repository's own rule, and the reason `verify` is handed `call` at run time.
  if (made.code !== 0) say('  note: create reported failures — see the lines above');

  const dressArgs = dressFlags(argv);
  const dressed = await node(SHADOW_TOOL, dressArgs, { cwd, env: shadowToolEnv() });
  if (dressed.code !== 0) { say('  dress FAILED'); return false; }
  return true;
}

// ---------------------------------------------------------------- 4. play
async function play() {
  stage(4, 'log the shadow fleet in');
  await stopBroker();
  const up = await startBroker({ construction: false });
  if (up.code !== 0) return false;
  if (DRY) return true;

  const roster = (() => { try { return Object.keys(JSON.parse(readFileSync(ROSTER, 'utf8'))).length; }
                          catch { return 0; } })();
  // "MOST OF THEM", NOT "ALL OF THEM". Waiting for every last character is waiting for the
  // slowest failure in the fleet, and a rehearsal with twenty-one of twenty-three bodies is
  // the same rehearsal. An exact number is still available with --need.
  const want = NEED || Math.max(1, Math.floor(roster * 0.8));
  const until = Date.now() + WAIT_MS;
  let n = 0;
  say(`  waiting for ${want} of ${roster} to reach the world (up to ${Math.round(WAIT_MS / 60000)} min)`);
  while (Date.now() < until) {
    const h = await getJson(HTTP_PORT, '/health');
    // COUNT THE ONES WEARING THEIR OWN NAME, not the ones holding a socket. `sessions` goes
    // up the moment a keeper logs in, and a keeper that logged into an account holding the
    // wrong character is a session too — that is exactly the state a half-built fleet sits
    // in, where every account answers and not one of them is the character the roster names.
    // `session_characters` is the only reading that can tell those apart.
    const named = Object.values(h?.session_characters ?? {}).filter(Boolean);
    n = named.length || Number(h?.sessions ?? 0);
    if (n >= want) {
      say(`  ${n} in game: ${named.slice(0, 6).join(', ')}${named.length > 6 ? ', …' : ''}`);
      return await settle();
    }
    await new Promise(r => setTimeout(r, 10_000));
  }
  say(`  TIMED OUT with ${n} of ${want} in game after ${Math.round(WAIT_MS / 60000)} min`);
  return false;
}

// ------------------------------------ IN GAME IS NOT THE SAME AS AVAILABLE
//
// **A FRESHLY DRESSED SHADOW FLEET GOES SHOPPING THE MOMENT IT LOGS IN, AND THAT RACE IS
// WHAT THE FIRST VERSION OF THIS FILE LOST.**
//
// A shadow is created minutes old. It has no elderberry and no herbs, its loadout carries a
// reagent floor like every other character's, and the floor is in the LOADOUT rather than in
// the policy — so `buy_reagents:false` does not stop it. The first thing twenty-three keepers
// do on login is therefore set off for the apothecary, all of them, together.
//
// Stage 4 used to wait only for characters to be IN GAME. They were: walking to a shop. The
// errand then started into a fleet that was already busy, and a claim takes the FACULTIES,
// not the BODY — a journey or town trip already in flight is a JOB and keeps running through
// a successful claim. Measured 2026-09-16: ten of twenty-three characters completed a reagent
// town trip (about sixty purchases each, elderberry and herb from Joguer, "the posted
// shopping list") DURING the run, standing in room 104 with `committed: -` while the other
// thirteen walked the circuit. The first purchase is timestamped seven minutes before the
// script started. Nothing was stalled, nothing was refused, and half the fleet simply had
// other plans.
//
// So: wait for the fleet to be QUIET, not merely present. The wait is expected and bounded —
// a reagent run is a few minutes — and it is reported rather than silent, because "why is
// this sitting here" has a right answer and it should be on the screen.
async function settle() {
  if (has('--no-settle')) { say('  settle: skipped (--no-settle) — the errand will race the keepers'); return true; }
  const budget = Number(arg('--settle-m', 10)) * 60_000;
  const quietFor = Number(arg('--quiet-s', 45)) * 1000;
  const until = Date.now() + budget;

  // ASK WHETHER ANYTHING IS CHANGING, NOT WHAT THE FLEET SAYS IT IS DOING.
  //
  // The obvious implementation — match `activity` against travel/buy/shop — is WRONG here,
  // and measurably so. A character standing at Joguer's counter working through a sixty-item
  // shopping list reports `activity: "waiting"`, exactly like an idle one: measured on Aaaa
  // at 22:14 with `town_service_at` set and sixty purchases in the ledger. A verb list would
  // have declared the fleet quiet on the first poll and changed nothing.
  //
  // So this is a quiescence detector rather than a busy-ness detector: fingerprint what MOVES
  // — the room a character is in, and `town_service_at`, which advances across a town trip —
  // and call the fleet settled when nothing has changed for a while. It needs no list of
  // verbs and no knowledge of the keeper's policy, so a keeper errand nobody has thought of
  // still reads as activity.
  const print = (rows) => rows.map(r => `${r.agent}:${r.room_num ?? '?'}:${r.town_service_at ?? 0}`).join('|');

  let prev = null, steadySince = null, lastSaid = null;
  say(`  settling: waiting for ${Math.round(quietFor / 1000)}s of no movement ` +
      `(up to ${Math.round(budget / 60000)} min). A fleet this new always shops first — ` +
      `it has no reagents and the floor is in the loadout.`);
  for (;;) {
    const t = await tool('fleet');
    const rows = t?.fleet ?? [];
    if (!rows.length) { say('  settle: the fleet read came back empty — going ahead'); return true; }

    const now = print(rows);
    const changed = prev === null ? rows.length
      : rows.filter(r => !prev.includes(`${r.agent}:${r.room_num ?? '?'}:${r.town_service_at ?? 0}`)).length;
    if (now === prev) { steadySince ??= Date.now(); }
    else { steadySince = null; prev = now; }

    const note = `${changed} of ${rows.length} moved since the last look`;
    if (note !== lastSaid) { say(`  settle: ${note}`); lastSaid = note; }

    if (steadySince && Date.now() - steadySince >= quietFor) {
      say(`  settle: the fleet has been still for ${Math.round((Date.now() - steadySince) / 1000)}s — going`);
      return true;
    }
    if (Date.now() >= until) {
      // NOT A FAILURE. Going ahead with a busy fleet is what the old behaviour did, and it
      // drove thirteen of twenty-three perfectly well. What was missing was anybody SAYING
      // so, which is the difference between a confusing result and a readable one.
      say(`  settle: TIMED OUT still moving — going ahead anyway. Characters still on their ` +
          `own errand will ignore this one until it finishes: a claim takes the faculties, ` +
          `not the body, and a job already in flight keeps running.`);
      return true;
    }
    await new Promise(r => setTimeout(r, 15_000));
  }
}

// ---------------------------------------------------------------- 5. run
async function run(name, params) {
  stage(5, `run "${name}" against ${FLEET}`);
  // The fleet has to be decided BEFORE the compiler is imported: `m59-fleetscript.mjs` and
  // everything under it resolve the fleet at module scope, so setting this afterwards would
  // compile an errand for whichever fleet this checkout defaults to. That is the quiet
  // version of pointing a command at the wrong twenty-three characters.
  process.env.M59_FLEET = FLEET;
  process.env.M59_STATE_FILE = ROSTER;
  // AND THE CONTROL URL, WHICH IS THE ONE THAT WOULD HAVE DRIVEN PRODUCTION.
  //
  // Naming the fleet and the roster is not enough: the compiler sends its orders to
  // `M59_CONTROL_URL`, which DEFAULTS TO 8901 — the production broker on this machine. So a
  // run correctly labelled "shadow", with shadow's roster and shadow's agents, addresses
  // twenty-three live production characters and walks them into a cave.
  //
  // The first run of this file did exactly that and was stopped by fleetScript's own
  // identity check: *"You named fleet shadow but http://127.0.0.1:8901/ is holding
  // prod.json. A fleet is its ROSTER FILE and never its name."* That guard is the only
  // thing between this shim and the incident it exists to prevent, which is why the port
  // is set here from the same number the brokers were started on rather than inherited.
  process.env.M59_CONTROL_URL = `http://127.0.0.1:${HTTP_PORT}/`;

  const { loadFleetScripts, runNamed } = await import('./m59-fleetlib.mjs');
  const { fleetScript } = await import('./m59-fleetscript.mjs');

  // A PAD IS INVISIBLE UNLESS SOMETHING ASKS FOR IT BY NAME, and that invisibility is what
  // keeps a half-written scratch pad away from a keeper. So pads are included here — this
  // command's whole purpose is to rehearse one — and nowhere else.
  const padDir = resolve(arg('--pads', join(REPO, 'substrate', 'fleetscratch')));
  const { scripts, problems } = await loadFleetScripts({
    dirs: [['public', join(REPO, 'tools', 'fleetscripts')],
           ['local', join(REPO, 'substrate', 'fleetscripts')],
           ['pad', padDir]],
  });
  // A SCRIPT THAT FAILED TO LOAD AND A SCRIPT THAT IS NOT THERE LOOK IDENTICAL FROM A MENU,
  // and only one of them is the operator's fault — so say which file and why, never
  // `[object Object]`.
  for (const p of problems ?? [])
    say(`  note: ${typeof p === 'string' ? p : `${p.file ?? p.name ?? '?'} — ${p.why ?? p.error ?? JSON.stringify(p)}`}`);

  if (has('--list') || !name) {
    say(`  runnable scripts (pads from ${padDir}):`);
    for (const [n, s] of scripts) say(`    ${n.padEnd(28)} ${s.source.padEnd(7)} ${s.describe ?? ''}`);
    return true;
  }
  if (!scripts.has(name)) {
    say(`  no script named "${name}". Run with --list to see what is here.`);
    return false;
  }
  // "THE FLEET" IS THE DEFAULT, BECAUSE THAT IS WHAT THIS COMMAND IS FOR.
  //
  // Every FleetScript requires `agents` and refuses without it, which is right when the
  // caller is choosing three characters out of twenty-three on production. Here the whole
  // point is the opposite — rehearse the errand against a copy of the WHOLE fleet — and
  // making the operator paste twenty-three slot names is how a rehearsal ends up being run
  // against four of them and read as though it covered everything. An explicit
  // `agents=shadow01,shadow02` still wins.
  const withFleet = { ...params };
  if (withFleet.agents == null) {
    withFleet.agents = rosterAgents().join(',');
    say(`  agents: the whole ${FLEET} fleet (${rosterAgents().length}) — pass agents=… to narrow it`);
  }

  if (DRY) { say(`  [dry] would run ${name} with ${JSON.stringify(withFleet)}`); return true; }

  const r = await runNamed(name, withFleet, { scripts, fleetScript, onLog: say });
  if (r?.ok === false) { say(`  REFUSED: ${r.why}`); return false; }
  return true;
}

// ---------------------------------------------------------------- cli
//
// GUARDED, BECAUSE IMPORTING THIS FILE MUST NOT DRIVE A FLEET. `m59-broker.mjs` has the same
// rule for the same reason — importing it to check it took the fleet lock and started rejoin
// timers — and the test below imports this module for `refusals`.
if (import.meta.filename === process.argv[1]) {
const positional = argv.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') &&
                           !['--dry', '--list', '--skip-snapshot', '--down', '--no-settle', ...DRESS_FLAGS].includes(argv[i - 1])));
const name = positional.find(a => !a.includes('=')) ?? null;
const params = Object.fromEntries(positional.filter(a => a.includes('='))
  .map(a => { const i = a.indexOf('='); return [a.slice(0, i), a.slice(i + 1)]; }));

const from = arg('--from', 'preflight');
if (!STAGES.includes(from)) {
  console.error(`--from must be one of: ${STAGES.join(', ')}`);
  process.exit(2);
}
const at = (s) => STAGES.indexOf(s) >= STAGES.indexOf(from);

say(`m59-shadow-run — "${name ?? '(list)'}" against fleet "${FLEET}" on ${GAME_HOST}:${GAME_PORT}`);
if (DRY) say('DRY RUN: nothing is started, created, dressed or driven.');

let ok = true;
if (ok && at('preflight')) ok = await preflight();
if (ok && at('snapshot') && !has('--list')) ok = await snapshot();
if (ok && at('build') && !has('--list')) ok = await build();
if (ok && at('play') && !has('--list')) ok = await play();
if (ok && at('run')) ok = await run(name, params);

if (has('--down')) { say(); await stopBroker(); }
say(`\n${ok ? 'done' : 'STOPPED — see above'}`);
process.exit(ok ? 0 : 1);
}
