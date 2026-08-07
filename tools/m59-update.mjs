#!/usr/bin/env node
// PUT THE FLEET DOWN GENTLY, THEN RESTART IT ON THE NEW CODE.
//
//   node tools/m59-update.mjs                      # park, wait, restart
//   node tools/m59-update.mjs --dry-run            # park and report, restart nothing
//   node tools/m59-update.mjs --timeout 300        # seconds to wait for the fleet, default 240
//   node tools/m59-update.mjs --no-wait            # restart immediately, the old way
//   node tools/m59-update.mjs --force              # park gently, but restart over a live errand
//
// --force PARKS THE FLEET AS USUAL and only overrides the errand guard in m59-service.mjs.
// It is NOT --no-wait: the characters still get behind walls first. What it gives up is a
// one-shot errand mid-walk, which dies with `fetch failed` and leaves what it was carrying
// undelivered. Without this flag the only ways past a running errand were to wait or to pass
// --no-wait — so anyone in a hurry reached for --no-wait and gave up the parking too, which
// is the half actually worth keeping.
//
// WHY THIS EXISTS.
//
// A broker restart stops every keeper at once, and a stopped keeper is NOT a paused
// character. It is a character held still in whatever fight it was in, in whatever room
// it was in, while everything already swinging at it carries on. That is why deaths
// arrive in waves after a restart — m59-uptime.mjs was written to measure exactly this,
// and it charges the outage to the strategy rather than to the operator unless somebody
// writes down which it was.
//
// The fix is not to restart faster. It is to restart when the fleet is standing behind
// walls, which is a thing the fleet can arrange for itself if it is asked in time.
//
// THE SEQUENCE, and why each step is where it is:
//
//   1. ASK EVERY KEEPER TO PARK. Parking takes effect at the next point the keeper
//      would have chosen a new action anyway — never mid-swing, never mid-route. Past
//      that point it takes no new fights, walks to a wall, and holds it. Death, danger
//      and flight handling all still run: a parked character still defends itself.
//   2. WAIT FOR EVERY ONE OF THEM TO SAY READY. This is the whole point of the tool.
//      A character mid-pull needs a few seconds; one crossing a room needs longer; one
//      that cannot find a wall gives up after ninety seconds and says so rather than
//      holding the fleet hostage. Reported per character, so an operator can see who is
//      about to take the outage in the open.
//   3. RESTART THE BROKER, which is what actually loads the new code. Every keeper runs
//      inside it, so this is the one restart that matters.
//
// WHAT ELSE HOLDS STATE, since "restart the broker" is not the whole answer:
//
//   * m59-supervise.mjs is a SEPARATE PROCESS running its own copy of the code, and it
//     survives a broker restart by design. If it changed, it needs restarting too, and
//     nothing here can do that safely — it has no pid file, and this repository's rule
//     against killing node processes by name exists because doing so once took down a
//     live broker from another checkout. So this DETECTS it and tells you.
//   * The safe-spot book is read into the broker at boot and written by the keepers, so
//     an out-of-band edit to it needs this same restart. That is handled.
//   * m59-tui.mjs, m59-compendium.mjs and the dashboard are read-only viewers. They
//     reconnect on their own and need nothing.
//   * The game server is NOT restarted. It holds the world; this holds the players.
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const PORT = Number(arg('port', 8901));
const DRY = !!arg('dry-run', false);
const NO_WAIT = !!arg('no-wait', false);
const FORCE = !!arg('force', false);
const TIMEOUT_MS = Number(arg('timeout', 240)) * 1000;
const FLEET = arg('fleet', null);
const RPC = `http://127.0.0.1:${PORT}/`;

let id = 0;
async function call(name, args = {}) {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
                           params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
  const text = j.result?.content?.[0]?.text;
  if (j.result?.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const here = rel => fileURLToPath(new URL(rel, import.meta.url));

function run(script, args) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [here(script), ...args], { stdio: 'inherit' });
    p.on('exit', code => code === 0 ? res(code) : rej(new Error(`${script} exited ${code}`)));
    p.on('error', rej);
  });
}

// WHICH FLEET, BEFORE ANYTHING ELSE. m59-which.mjs exits non-zero when the running
// broker holds a fleet other than the one the next command would touch, and this
// command's next move is to restart that broker. Same check every /m59* command runs,
// and for the same reason: the failure it catches once took down a live 46-session
// broker while every step reported success.
async function whichFleet() {
  try {
    await run('./m59-which.mjs', FLEET ? ['--fleet', FLEET] : []);
    return true;
  } catch (e) {
    console.error(`\nrefusing to continue: ${e.message}`);
    console.error('The broker is holding a different fleet than this command would restart.');
    return false;
  }
}

// Is a supervisor running against this broker? It is a separate process with its own
// copy of the code, so a broker restart does not update it. Detected rather than
// managed — see the note at the top about killing by name.
function supervisorRunning() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      'Where-Object { $_.CommandLine -like \'*m59-supervise*\' } | ' +
      'Select-Object -ExpandProperty ProcessId'], { encoding: 'utf8', timeout: 15000 });
    const pids = out.split(/\s+/).filter(Boolean);
    return pids.length ? pids : null;
  } catch { return null; }
}

async function parkFleet() {
  const f = await call('fleet', {});
  const rows = (f.fleet || []).filter(r => r.in_game !== false);
  if (!rows.length) { console.log('nobody is in game — nothing to park'); return []; }
  console.log(`${stamp()} asking ${rows.length} keeper(s) to park`);
  for (const r of rows)
    await call('autopilot', { agent: r.agent, action: 'park',
                              why: 'a fleet update is about to restart the broker' })
      .catch(e => console.log(`   ${r.character}: could not park — ${e.message}`));
  return rows;
}

// Poll the fleet row rather than each keeper: one call a tick instead of twenty-one,
// during the one window we most want the fleet quiet. See the `parked` field in the
// broker's fleet tool.
async function waitForReady(expected) {
  const began = Date.now();
  let lastLine = '';
  while (Date.now() - began < TIMEOUT_MS) {
    const f = await call('fleet', {}).catch(() => null);
    const rows = (f?.fleet || []).filter(r => r.in_game !== false);
    const parked = rows.filter(r => r.parked);
    const ready = parked.filter(r => r.parked.ready);
    const line = `${stamp()} ${ready.length}/${rows.length} ready` +
                 (parked.length < rows.length ? `  (${rows.length - parked.length} not parking)` : '');
    if (line !== lastLine) { console.log(line); lastLine = line; }
    // Everyone who is in game has parked AND is ready. A character that dropped out
    // mid-update is not something to wait for — it is already not in a fight.
    if (rows.length && ready.length >= rows.length) {
      const open = ready.filter(r => !r.parked.holding);
      console.log(`\n${stamp()} the fleet is parked.`);
      for (const r of ready) {
        const h = r.parked.holding;
        console.log(`   ${String(r.character ?? r.agent).padEnd(12)} ` +
          (h ? `behind a wall at ${h.col},${h.row} (${h.proven ? 'proven' : 'untested'})` +
               `  in ${r.room ?? r.room_num ?? '?'}`
             : `IN THE OPEN — no wall found  in ${r.room ?? r.room_num ?? '?'}`));
      }
      if (open.length)
        console.log(`\n   ${open.length} of them could not find a wall. They are standing still and ` +
                    'awake, which is still better than being stopped mid-fight — but they are the ' +
                    'ones to look at first if the restart costs anybody.');
      return { ok: true, rows };
    }
    await sleep(3000);
  }
  const f = await call('fleet', {}).catch(() => null);
  const rows = (f?.fleet || []).filter(r => r.in_game !== false);
  const notReady = rows.filter(r => !r.parked?.ready);
  console.log(`\n${stamp()} TIMED OUT after ${Math.round(TIMEOUT_MS / 1000)}s with ` +
              `${notReady.length} still not ready:`);
  for (const r of notReady)
    console.log(`   ${String(r.character ?? r.agent).padEnd(12)} ${r.activity ?? '?'}`);
  return { ok: false, rows, notReady };
}

// THE WAY BACK. A dry run, an abandoned update, or a timeout all leave the fleet parked
// and doing nothing, and a parked fleet earns nothing — so the undo has to be one
// obvious command rather than twenty-one calls. Referenced from every message that
// leaves the fleet in that state.
async function unparkFleet() {
  const f = await call('fleet', {});
  const rows = (f.fleet || []).filter(r => r.in_game !== false);
  let n = 0;
  for (const r of rows) {
    if (!r.parked) continue;
    await call('autopilot', { agent: r.agent, action: 'unpark', why: 'the update was called off' })
      .then(() => n++)
      .catch(e => console.log(`   ${r.character}: ${e.message}`));
  }
  console.log(`${stamp()} unparked ${n} keeper(s) — back to their orders`);
  return n;
}

(async () => {
  if (arg('unpark', false)) { await unparkFleet(); process.exit(0); }
  if (!await whichFleet()) process.exit(2);

  const sup = supervisorRunning();

  if (!NO_WAIT) {
    const rows = await parkFleet();
    if (rows.length) {
      const r = await waitForReady(rows.length);
      if (!r.ok) {
        // NOT AN AUTOMATIC OVERRIDE. The whole value of this tool is that the restart
        // lands on a quiet fleet; restarting anyway on a timeout would silently give
        // that up and reintroduce exactly the deaths it exists to prevent. Say what is
        // holding it and let a person decide.
        console.log('\nNot restarting. Either wait and run this again, or force it with --no-wait ' +
                    'if you are happy for those characters to take the outage where they stand.');
        console.log('To put the fleet back to work without restarting anything:');
        console.log('  node tools/m59-update.mjs --unpark');
        process.exit(1);
      }
    }
  }

  if (DRY) {
    console.log('\ndry run — the fleet is parked and NOTHING has been restarted.');
    console.log('Put it back to work with:  node tools/m59-update.mjs --unpark');
    process.exit(0);
  }

  console.log(`\n${stamp()} restarting the broker — this is what loads the new code`);
  // The parking flags live in the broker's memory and die with it, so nothing needs
  // unparking: the keepers on the far side are new objects that were never parked.
  await run('./m59-service.mjs', ['restart', ...(FLEET ? ['--fleet', FLEET] : []),
                                  ...(FORCE ? ['--force'] : [])]);

  if (sup) {
    console.log(`\nA supervisor is running (pid ${sup.join(', ')}) and a broker restart does NOT`);
    console.log('update it — it is a separate process with its own copy of the code. If');
    console.log('tools/m59-supervise.mjs changed, stop that pid and start it again:');
    console.log('  node tools/m59-supervise.mjs --graduate 30 --every 90');
    console.log('Stop it by pid, not by name — see CLAUDE.md.');
  }
  console.log('\nDone. The fleet page will fill back in over a minute or so as characters rejoin.');
})().catch(e => {
  console.error('update failed: ' + e.message);
  // THE FLEET IS PROBABLY STILL PARKED. Everything that can throw here happens after
  // parkFleet(), and a parked fleet earns nothing — it stands behind a wall taking no
  // fights until something unparks it. The timeout path says this; the throw path did
  // not, so a restart refused by the errand guard left twenty-one characters idle with
  // the error message giving no hint that anything needed undoing.
  console.error('\nThe fleet is most likely still parked and earning nothing. Put it back:');
  console.error('  node tools/m59-update.mjs --unpark' + (FLEET ? ` --fleet ${FLEET}` : ''));
  process.exit(1);
});
