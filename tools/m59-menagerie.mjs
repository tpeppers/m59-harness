#!/usr/bin/env node
// THE MENAGERIE: hosts that ride along on the fleet's broker and are not the fleet.
//
//   node tools/m59-menagerie.mjs status                 what the menagerie is, and doing
//   node tools/m59-menagerie.mjs run                    the driver — long-running
//   node tools/m59-menagerie.mjs run --once             one round, then exit
//   node tools/m59-menagerie.mjs scripts                every script on disk, validated
//   node tools/m59-menagerie.mjs enlist <agent> --script <name> --room <n> [--col N --row N]
//   node tools/m59-menagerie.mjs discharge <agent>
//
// A HOST is a character whose whole job is decided in advance: a merchant standing in Tos
// selling the fleet's excess gear, telling passers-by what it has, answering whoever
// answers back. It shares the fleet's broker, server, keeper band, safe-spot book and
// grudge book, and it is NOT the fleet — "send everyone to Castle Victoria" must never
// once mean a merchant.
//
// WHY THIS IS A SEPARATE PROCESS.
//
// It did not have to be. The hosts could have been ticked inside the broker, and it would
// have been less code. Three reasons it is not:
//
//   1. The broker's clock is one second and its job is survival. A host's clock is
//      minutes and its job is a shop. This repository's whole boundary doctrine is that
//      those do not share a process — the same argument that put the DUM bot outside.
//   2. A script is an operator's file, reloaded on change. Reloading operator files inside
//      the process that holds twenty-one sockets is how a bad edit logs out a fleet.
//   3. It is the honest shape of "not controllable by MCP". The broker refuses hosts to
//      every MCP caller; the thing that DOES drive them is visibly a different program
//      with a different door, rather than a flag inside the one everybody already has.
//
// It holds no credentials and no sockets. The broker holds those, for the fleet and the
// menagerie alike, because there is exactly one connection per character and duplicating
// the login path is how the second copy rots.
//
// THE DOOR. The broker mints a token at startup into
// `<roster>.menagerie.token` (0600) and accepts it in an `x-m59-menagerie` header on
// loopback. That is a capability, not a security boundary, and the difference matters:
// anything that can read a file here can drive a host, and the operator is supposed to be
// able to. What it stops is the ACCIDENT — a fleet-wide instruction sweeping up a
// merchant — because nothing in the fleet's path carries it.
//
// See docs/m59-menagerie.md. Guards: m59-menagerie-test.mjs, m59-menagerie-script-test.mjs.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFleet } from './m59-fleetpath.mjs';
import { menageriePathFor, loadMenagerie, hostConfig, splitRosters } from './m59-menagerie-roster.mjs';
import { parseScript, respondTo, stepAt, shopWarnings, EXAMPLE_MERCHANT } from './m59-menagerie-script.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_DIR = join(REPO, 'substrate', 'menagerie', 'scripts');
const EXAMPLE_DIR = join(REPO, 'substrate', 'menagerie', 'scripts.example');

const argv = process.argv.slice(2);
const flag = (name, d = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : d;
};
const has = name => argv.includes(`--${name}`);
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };

const { fleet: FLEET, label: FLEET_LABEL, stateFile: STATE_FILE, source: FLEET_SOURCE } =
  resolveFleet(argv, process.env);
const MENAGERIE_FILE = menageriePathFor(STATE_FILE);
const TOKEN_FILE = STATE_FILE.replace(/\.json$/i, '') + '.menagerie.token';

// ------------------------------------------------------------------ the broker

// WHICH BROKER, AND IS IT THE ONE HOLDING OUR ROSTER.
//
// The same doctrine m59-which.mjs exists for, applied here because it applies here: a
// broker is ours only when its /health STATE PATH is our roster file — never when its
// fleet LABEL matches, because two checkouts can each hold a fleet called `prod` and they
// are not the same characters. A menagerie driver that talked to the wrong broker would
// be told, politely, that it has no hosts.
async function findBroker() {
  const explicit = Number(flag('port', 0));
  const ports = explicit ? [explicit] : [8901, 8971, 8899, 8911, 8981];
  const tried = [];
  for (const port of ports) {
    let health;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
      health = await r.json();
    } catch (e) { tried.push(`${port}: ${String(e.message ?? e).slice(0, 40)}`); continue; }
    if (health?.state !== STATE_FILE) {
      tried.push(`${port}: holds ${health?.state ?? 'something else'}`);
      continue;
    }
    return { port, health };
  }
  die(`no broker on this machine is holding ${STATE_FILE}.\n` +
      tried.map(t => '  ' + t).join('\n') +
      `\nA broker is ours only when its /health state path IS our roster file — a matching\n` +
      `fleet LABEL is not the same question. Start one:\n` +
      `  node tools/m59-service.mjs start --fleet ${FLEET_LABEL}`);
}

function readToken() {
  if (!existsSync(TOKEN_FILE))
    die(`no menagerie token at ${TOKEN_FILE}.\n` +
        `The broker writes it at startup, and only when it actually loaded a menagerie.\n` +
        `If ${MENAGERIE_FILE} has hosts in it, restart the broker so it picks them up:\n` +
        `  node tools/m59-service.mjs restart --fleet ${FLEET_LABEL}`);
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}

let rpcId = 0;
function makeCall(port, token) {
  return async function call(tool, args = {}, { timeoutMs = 45_000 } = {}) {
    const body = JSON.stringify({
      jsonrpc: '2.0', id: ++rpcId, method: 'tools/call',
      params: { name: tool, arguments: args },
    });
    const r = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-m59-menagerie': token },
      body, signal: AbortSignal.timeout(timeoutMs),
    });
    const out = await r.json();
    if (out?.error) throw new Error(`${tool}: ${out.error.message ?? JSON.stringify(out.error)}`);
    const content = out?.result?.content?.[0]?.text;
    if (typeof content !== 'string') return out?.result ?? null;
    try { return JSON.parse(content); } catch { return content; }
  };
}

// ------------------------------------------------------------------ scripts on disk

// A SCRIPT THAT WILL NOT LOAD LEAVES THE HOST DOING WHAT IT WAS ALREADY DOING.
//
// The standing rule for every file in this repository that carries orders: silence means
// the behaviour that was already there, never an empty policy. A merchant whose script was
// saved mid-edit must keep selling with the last good version, not stand mute — because a
// mute merchant is indistinguishable from a healthy one to everything except the players
// standing in front of it.
const loaded = new Map();   // script name -> { at, mtime, script }

function loadScript(name) {
  const path = join(SCRIPT_DIR, `${name}.json`);
  let mtime = 0;
  try { mtime = statSync(path).mtimeMs; }
  catch {
    const had = loaded.get(name);
    if (had) return had.script;
    return { ok: false, name, problems: [`no script at ${path}`], dialogue: [], routine: [], broadcast: { every_s: 999, lines: [] }, shop: null, greeting: [] };
  }
  const had = loaded.get(name);
  if (had && had.mtime === mtime) return had.script;
  const parsed = parseScript(readFileSync(path, 'utf8'), name);
  if (!parsed.ok && had) {
    console.error(`[menagerie] ${name}.json: ${parsed.problems.join('; ')}`);
    console.error(`[menagerie] keeping the last good version of ${name} — the host keeps working`);
    loaded.set(name, { ...had, mtime });     // do not re-report every tick
    return had.script;
  }
  if (!parsed.ok) console.error(`[menagerie] ${name}.json: ${parsed.problems.join('; ')}`);
  loaded.set(name, { mtime, script: parsed });
  return parsed;
}

function listScripts() {
  if (!existsSync(SCRIPT_DIR)) return [];
  return readdirSync(SCRIPT_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
}

function seedExample() {
  mkdirSync(EXAMPLE_DIR, { recursive: true });
  const path = join(EXAMPLE_DIR, 'merchant-tos.json');
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(EXAMPLE_MERCHANT, null, 2) + '\n');
  return path;
}

// ------------------------------------------------------------------ the roster

function hosts({ required = false } = {}) {
  const m = loadMenagerie(MENAGERIE_FILE, { required });
  return m;
}

function readFleetRoster() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

// ENLIST — THE CONVERSION, AND IT IS A MOVE BETWEEN TWO FILES.
//
// The operator's path: a character is created into the FLEET, commanded normally until it
// is out of the newbie area and standing where it will live, and only then converted. So
// enlist takes an entry out of the fleet roster and puts it into the menagerie's, in one
// direction, with a backup of both.
//
// IT REFUSES WHILE A BROKER IS HOLDING THE FLEET. The broker keeps both rosters in memory
// and writes them back; editing either underneath it means the next write puts the
// character back where it was, and the only symptom is a conversion that silently undid
// itself. The same reason m59-restore.mjs refuses while a broker holds the fleet.
async function enlist() {
  const agent = argv[1];
  if (!agent || agent.startsWith('--')) die('usage: enlist <agent> --script <name> --room <n> [--col N --row N]');
  const script = String(flag('script', '') || '');
  const room = Number(flag('room', 0));
  if (!script) die('--script is required: which behaviour does this host run?');
  if (!room) die('--room is required: where does this host live?');
  if (!listScripts().includes(script))
    die(`no script "${script}" in ${SCRIPT_DIR}\n  have: ${listScripts().join(', ') || '(none)'}`);

  await refuseWhileBrokerHolds();

  const fleet = readFleetRoster();
  const men = hosts();
  if (!fleet[agent]) {
    const known = Object.keys(fleet);
    die(`"${agent}" is not in the fleet roster ${STATE_FILE}.\n` +
        (men.names.has(agent) ? `  It is ALREADY a menagerie host.\n`
                              : `  Roster agents: ${known.join(', ')}`));
  }
  const entry = fleet[agent];
  const next = {
    ...entry,
    host: {
      script, label: String(flag('label', '') || '') || null,
      station: {
        room,
        ...(flag('col') != null ? { col: Number(flag('col')) } : {}),
        ...(flag('row') != null ? { row: Number(flag('row')) } : {}),
      },
    },
  };
  const check = hostConfig(next, agent);
  if (!check.ok) die(`refusing: ${check.why}`);

  // Backups first, both files, because between the two writes the character exists in
  // neither roster — and a roster is the only record of an account's password.
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  writeFileSync(`${STATE_FILE}.before-enlist-${stamp}`, JSON.stringify(fleet, null, 2));
  const before = Object.fromEntries(men.hosts);
  if (men.present) writeFileSync(`${MENAGERIE_FILE}.before-enlist-${stamp}`, JSON.stringify(before, null, 2));

  // THE MENAGERIE IS WRITTEN FIRST. If the process dies between the two writes, the
  // character is in BOTH files — which the broker refuses to resume, loudly, naming both
  // paths. The other order loses it from both, which is a password gone.
  mkdirSync(dirname(MENAGERIE_FILE), { recursive: true });
  writeFileSync(MENAGERIE_FILE, JSON.stringify({ ...before, [agent]: next }, null, 2));
  delete fleet[agent];
  writeFileSync(STATE_FILE, JSON.stringify(fleet, null, 2));

  console.log(`enlisted ${agent} (${entry.credentials?.character ?? '?'}) as a menagerie host`);
  console.log(`  script   ${script}`);
  console.log(`  station  room ${room}${check.station.col != null ? ` at c${check.station.col}r${check.station.row}` : ''}`);
  console.log(`  roster   ${MENAGERIE_FILE}`);
  console.log(`  backups  *.before-enlist-${stamp}`);
  console.log(`\nIt is no longer reachable from the fleet's tools. Restart the broker so it`);
  console.log(`picks the split up, then drive it with:  node tools/m59-menagerie.mjs run`);
  console.log(`  node tools/m59-service.mjs restart --fleet ${FLEET_LABEL}`);
}

async function discharge() {
  const agent = argv[1];
  if (!agent || agent.startsWith('--')) die('usage: discharge <agent>');
  await refuseWhileBrokerHolds();
  const men = hosts();
  if (!men.names.has(agent))
    die(`"${agent}" is not a menagerie host.\n  hosts: ${[...men.names].join(', ') || '(none)'}`);
  const fleet = readFleetRoster();
  if (fleet[agent]) die(`"${agent}" is in BOTH rosters already — fix that before discharging.`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const before = Object.fromEntries(men.hosts);
  writeFileSync(`${MENAGERIE_FILE}.before-discharge-${stamp}`, JSON.stringify(before, null, 2));
  writeFileSync(`${STATE_FILE}.before-discharge-${stamp}`, JSON.stringify(fleet, null, 2));

  const entry = { ...before[agent] };
  delete entry.host;                    // it stops being a host; the block goes with it
  fleet[agent] = entry;
  writeFileSync(STATE_FILE, JSON.stringify(fleet, null, 2));
  delete before[agent];
  writeFileSync(MENAGERIE_FILE, JSON.stringify(before, null, 2));
  console.log(`discharged ${agent} back into the fleet roster ${STATE_FILE}`);
  console.log(`Restart the broker for it to be commandable again:`);
  console.log(`  node tools/m59-service.mjs restart --fleet ${FLEET_LABEL}`);
}

async function refuseWhileBrokerHolds() {
  if (has('force')) {
    console.error('[menagerie] --force: not checking whether a broker holds this roster.');
    return;
  }
  for (const port of [8901, 8971, 8899, 8911, 8981]) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
      const h = await r.json();
      if (h?.state === STATE_FILE)
        die(`refusing: a broker (pid ${h.pid}) on port ${port} is holding ${STATE_FILE}.\n` +
            `It keeps both rosters in memory and writes them back, so a conversion made\n` +
            `underneath it is undone by the next write and nothing says so.\n` +
            `  node tools/m59-service.mjs stop --fleet ${FLEET_LABEL}\n` +
            `...then enlist, then start it again. (--force overrides; do not.)`);
    } catch { /* not a broker, or not answering — neither is a reason to refuse */ }
  }
}

// ------------------------------------------------------------------ status

async function status() {
  const m = hosts();
  console.log(`fleet     ${FLEET_LABEL}   <- ${FLEET_SOURCE}`);
  console.log(`roster    ${STATE_FILE}`);
  console.log(`menagerie ${MENAGERIE_FILE}${m.present ? '' : '   (none yet)'}`);
  if (!m.names.size) {
    console.log('\nNo hosts. Create one by making a character in the fleet, walking it to where');
    console.log('it will live, and then converting it:');
    console.log('  node tools/m59-menagerie.mjs enlist <agent> --script merchant-tos --room 54');
    return;
  }
  const overlap = splitRosters(Object.keys(readFleetRoster()), [...m.names]).overlap;
  if (overlap.length)
    console.log(`\n!! ${overlap.length} agent(s) are in BOTH rosters: ${overlap.join(', ')}\n` +
                `   The broker refuses to resume like this. One of the two files is wrong.`);

  let call = null, port = null;
  try {
    const b = await findBrokerQuietly();
    if (b) { port = b.port; call = makeCall(b.port, readTokenQuietly()); }
  } catch { /* reported below */ }

  console.log(`\n${m.names.size} host(s)${port ? ` — broker on ${port}` : ' — no broker holding this roster'}`);
  for (const [agent, entry] of m.hosts) {
    const cfg = hostConfig(entry, agent);
    const script = cfg.ok ? loadScript(cfg.script) : null;
    const line = [`  ${agent}`, `(${entry.credentials?.character ?? '?'})`];
    if (!cfg.ok) { console.log(line.join(' '), `-- ${cfg.why}`); continue; }
    line.push(`script=${cfg.script}${script?.ok === false ? ' [INVALID]' : ''}`);
    line.push(`home=room ${cfg.station.room}`);
    if (call) {
      try {
        const st = await call('status', { agent }, { timeoutMs: 15000 });
        const room = st?.where?.room ?? st?.room?.name ?? st?.room ?? '?';
        const hp = st?.vitals?.health ? `${st.vitals.health.value}/${st.vitals.health.max}` : '?';
        line.push(`at=${room}`, `hp=${hp}`);
      } catch (e) { line.push(`(${String(e.message).slice(0, 50)})`); }
    }
    console.log(line.join('  '));
    if (script?.problems?.length) for (const p of script.problems) console.log(`      ! ${p}`);
  }
  console.log(`\nThese are NOT the fleet. The fleet's tools refuse them by name; this is what reaches them.`);
}

async function findBrokerQuietly() {
  for (const port of [Number(flag('port', 0)) || 0, 8901, 8971, 8899, 8911, 8981].filter(Boolean)) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) });
      const h = await r.json();
      if (h?.state === STATE_FILE) return { port, health: h };
    } catch { /* keep looking */ }
  }
  return null;
}
const readTokenQuietly = () => { try { return readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; } };

// ------------------------------------------------------------------ scripts command

function scripts() {
  const example = seedExample();
  const names = listScripts();
  console.log(`scripts   ${SCRIPT_DIR}`);
  console.log(`example   ${example}   (committed; copy it to start)`);
  if (!names.length) {
    console.log('\nNo scripts yet. Copy the example:');
    console.log(`  cp "${example}" "${join(SCRIPT_DIR, 'merchant-tos.json')}"`);
    return;
  }
  let bad = 0;
  for (const n of names) {
    const s = loadScript(n);
    const warn = shopWarnings(s.shop);
    console.log(`\n  ${n}  ${s.ok ? 'ok' : 'INVALID'}  kind=${s.kind} ` +
                `dialogue=${s.dialogue.length} routine=${s.routine.length} ` +
                `broadcast=${s.broadcast.lines.length}`);
    for (const p of s.problems ?? []) { bad++; console.log(`      ! ${p}`); }
    for (const w of warn) console.log(`      ~ ${w}`);
  }
  if (bad) process.exitCode = 1;
}

// THE POSTURE A HOST KEEPS, AND WHY IT IS NOT THE FLEET'S.
//
// A host arrives from the fleet still wearing a fleet character's orders: `goap`, hunting,
// roaming, buying weapons. Left alone its keeper does exactly what it is told and walks the
// merchant out of the shop to go and kill things — and the driver, seeing it in the wrong
// room, walks it back. That is a livelock in which both halves are working perfectly, and
// it is the shape of failure this repository names most often: nothing errors.
//
// So being a host IS a posture, and it is three settings:
//
//   mode: 'survive'      never picks a fight the owner did not ask for (m59-autopilot.mjs:18).
//                        Identity, mortality, survival and recovery stay with the keeper —
//                        an unattended merchant still runs from a fight it is losing, which
//                        is the protected-faculty rule and is not ours to switch off.
//   roam: false          it has a shop; it does not wander.
//   assigned_room        where the shop is, so the keeper's own idea of "home" and the
//                        driver's are the same number rather than two opinions.
//
// CONVERGED EVERY ROUND, NOT SET ONCE. A keeper re-applies its boot orders on every rejoin
// (see m59-keeper-process.mjs), so a posture written once at enlist is silently reverted by
// the next drop — on a longer fuse and far harder to catch. Pushed only when it differs,
// because anything writing orders every tick is writing them for ever.
const HOST_POSTURE = { mode: 'survive', roam: false };

async function keepPosture(call, agent, cfg, { dry = false } = {}) {
  let st = null;
  try { st = await call('autopilot', { agent, action: 'status' }, { timeoutMs: 20_000 }); }
  catch { return null; }
  const now = st?.status ?? st;
  const wrong = [];
  if (now?.mode !== HOST_POSTURE.mode) wrong.push(`mode ${now?.mode} -> ${HOST_POSTURE.mode}`);
  if (now?.policy?.roam !== false) wrong.push('roam -> false');
  if (Number(now?.policy?.assignedRoom) !== cfg.station.room)
    wrong.push(`assigned_room -> ${cfg.station.room}`);
  if (!wrong.length) return null;
  if (dry) return `would set posture: ${wrong.join(', ')}`;
  try {
    await call('autopilot', {
      agent, action: 'start', mode: HOST_POSTURE.mode,
      roam: false, assigned_room: cfg.station.room,
    }, { timeoutMs: 30_000 });
    return `posture: ${wrong.join(', ')}`;
  } catch (e) { return `posture refused: ${String(e.message).slice(0, 60)}`; }
}

// ------------------------------------------------------------------ the driver

// ONE ROUND FOR ONE HOST.
//
// Ordered so that the thing a player is waiting for happens first. A merchant that walks
// its patrol before answering the person standing in front of it is a merchant that reads
// as broken, and answering is nearly free.
async function serveHost(call, agent, entry, startedAt, { dry = false } = {}) {
  const cfg = hostConfig(entry, agent);
  if (!cfg.ok) return { agent, skipped: cfg.why };
  const script = loadScript(cfg.script);
  const did = [];

  // 0. BE A HOST, not a fleet character wearing a merchant's script.
  const posture = await keepPosture(call, agent, cfg, { dry });
  if (posture) did.push(posture);

  // 1. ANSWER ANYBODY WHO SPOKE.
  //
  // Through `inbox`, never `say`. The distinction is m59-chat-tools.mjs's and it is the
  // whole of the injection story: `reply` derives the recipient, the channel and the rate
  // limit from the item the broker already holds, so a host holding only this cannot
  // broadcast, cannot reach anyone who has not spoken to it first, and cannot be talked
  // into addressing somebody else. Every utterance below was typed by a stranger; it is
  // matched against a table an operator wrote and is never interpreted.
  let box = null;
  try { box = await call('inbox', { agent, action: 'read', state: 'escalated', limit: 10 }); }
  catch (e) { did.push(`inbox unreadable: ${String(e.message).slice(0, 60)}`); }
  for (const item of (box?.items ?? box?.inbox ?? [])) {
    const said = item?.utterance ?? item?.text ?? '';
    const answer = respondTo(script, said, { turn: item?.turn ?? 0 });
    if (!answer) continue;                     // leave it escalated; an operator may want it
    if (dry) { did.push(`would answer ${item.id}: ${answer.intent}`); continue; }
    try {
      await call('inbox', { agent, action: 'reply', id: item.id, text: answer.say });
      did.push(`answered ${answer.intent}`);
    } catch (e) { did.push(`reply failed: ${String(e.message).slice(0, 60)}`); }
  }

  // 2. BE WHERE IT LIVES.
  //
  // Checked every round and acted on rarely. A host that has been moved — by a death, by
  // a monster, by the keeper's own survival ladder doing exactly what it should — walks
  // home, and that is the only travel a host ever does. It is the survival ladder that
  // decides whether walking home right now is sane; this only ever asks.
  let where = null;
  try { where = await call('status', { agent }, { timeoutMs: 20_000 }); }
  catch (e) { did.push(`status unreadable: ${String(e.message).slice(0, 60)}`); }
  // `where.num` IS THE ROOM NUMBER, and reading the wrong field here is not a small bug.
  //
  // The first version of this line read `where.room_id ?? where.room`, neither of which the
  // status tool returns. That produced NaN, the `Number.isSafeInteger` guard below sent it
  // straight past the walk-home branch, and the driver printed "nothing to do" for two
  // hosts that were both in the wrong town. A host standing in the wrong place looks
  // exactly like a host standing in the right one from here — which is why the unreadable
  // case is now SAID rather than treated as "at home".
  //
  // The repository's own standing example of this is m59-outfit.mjs's arrival check reading
  // `status.where.num` when the tool did not return it; the field has since become exactly
  // that, and the lesson survives the reversal: READ THE SHAPE, do not remember it.
  const room = Number(where?.where?.num ?? where?.room?.num ?? NaN);
  if (!Number.isSafeInteger(room)) {
    if (where) did.push('could not read which room it is in — NOT assuming it is home');
    return { agent, did, home: null };
  }
  if (room !== cfg.station.room) {
    // A JOURNEY IN FLIGHT IS NOT A JOURNEY THAT NEEDS STARTING.
    //
    // This is the guarantee FleetScript compiles in — "travel issued once and never
    // re-issued while walking" — and the first version of this loop broke it, on a 30
    // second round, live on shadow. Re-issuing a travel into itself is one of the three
    // silent failures that broke m59-outfit.mjs: a walk that was going fine reads as
    // refused and is sent again, and the character spends its time being re-planned
    // instead of walking. A journey across the world takes minutes; a round takes seconds.
    const busy = String(where?.job?.busy ?? '');
    if (/^walk to /i.test(busy)) {
      did.push(`walking home (${busy}, ${where.job.running_for_s ?? '?'}s)`);
      return { agent, did, home: false };
    }
    if (dry) did.push(`would walk home: ${room} -> ${cfg.station.room}`);
    else {
      try {
        await call('travel', { agent, to: cfg.station.room, background: true }, { timeoutMs: 20_000 });
        did.push(`walking home to ${cfg.station.room} from ${room}`);
      } catch (e) { did.push(`travel refused: ${String(e.message).slice(0, 60)}`); }
    }
    return { agent, did, home: false };        // nothing else until it is home
  }

  // 3. THE ROUTINE, which only runs when the host is where it belongs.
  const step = stepAt(script, Date.now() - startedAt);
  if (step.do === 'broadcast' && script.broadcast.lines.length) {
    const line = script.broadcast.lines[Math.floor((Date.now() - startedAt) /
      (script.broadcast.every_s * 1000)) % script.broadcast.lines.length];
    if (dry) did.push(`would broadcast: ${line}`);
    else {
      try { await call('say', { agent, text: line }); did.push('broadcast'); }
      catch (e) { did.push(`say refused: ${String(e.message).slice(0, 60)}`); }
    }
  }
  return { agent, did, home: true, step: step.do };
}

async function run() {
  const dry = has('dry-run') || has('dry');
  const once = has('once');
  const everyMs = Math.max(5000, Number(flag('every', 20)) * 1000);
  const m = hosts();
  if (!m.names.size) die(`no hosts in ${MENAGERIE_FILE} — nothing to drive.\n` +
                         `  node tools/m59-menagerie.mjs enlist <agent> --script <name> --room <n>`);

  const { port, health } = await findBroker();
  const token = readToken();
  const call = makeCall(port, token);

  // PROVE THE DOOR BEFORE DRIVING ANYTHING. A driver that discovers its token is stale
  // one host at a time produces a log full of refusals that look like a broken menagerie.
  const probe = [...m.names][0];
  try { await call('status', { agent: probe }, { timeoutMs: 20_000 }); }
  catch (e) {
    if (/MENAGERIE HOST/.test(String(e.message)))
      die(`the broker refused a host to this driver — the token in ${TOKEN_FILE} is not the\n` +
          `one that broker minted. Restart the broker, or re-read the token.\n  ${e.message}`);
    console.error(`[menagerie] probe on ${probe} said: ${String(e.message).slice(0, 120)}`);
  }

  console.log(`[menagerie] driving ${m.names.size} host(s) on broker ${port} ` +
              `(pid ${health.pid}) every ${everyMs / 1000}s${dry ? ' — DRY RUN' : ''}`);
  console.log(`[menagerie] fleet ${FLEET_LABEL} is NOT driven from here.`);

  const startedAt = Date.now();
  let stop = false;
  process.on('SIGINT', () => { stop = true; console.log('\n[menagerie] stopping'); });

  for (let round = 1; !stop; round++) {
    const current = hosts();               // re-read: enlist may have added one
    const lines = [];
    for (const [agent, entry] of current.hosts) {
      try {
        const r = await serveHost(call, agent, entry, startedAt, { dry });
        if (r.skipped) lines.push(`${agent}: ${r.skipped}`);
        else if (r.did?.length) lines.push(`${agent}: ${r.did.join('; ')}`);
      } catch (e) { lines.push(`${agent}: ${String(e.message).slice(0, 80)}`); }
    }
    // PRINT EVERY ROUND, like m59-supervise.mjs. A driver that only speaks when something
    // is wrong is a driver nobody can tell is running, and "is it running" is the question
    // asked about it most.
    console.log(`[${new Date().toISOString().slice(11, 19)}] round ${round}` +
                (lines.length ? '\n  ' + lines.join('\n  ') : '  (nothing to do)'));
    if (once) break;
    await new Promise(r => setTimeout(r, everyMs));
  }
}

// ------------------------------------------------------------------

const cmd = argv[0];
const main = {
  status, scripts, run,
  enlist, discharge,
}[cmd];

if (!main) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8')
    .split('\n').slice(1, 9).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd ? 1 : 0);
}
Promise.resolve(main()).catch(e => { console.error(String(e?.stack ?? e)); process.exit(1); });
