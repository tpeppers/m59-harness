#!/usr/bin/env node
// KEEP A TRAINING RUN GOING THROUGH BROKER, KEEPER AND DUM RESTARTS, UNTIL A GATE OPENS.
//
//   node tools/m59-keep-training.mjs --agent t2 --until "remove curse" \
//        -- node tools/m59-shalille-train.mjs --healer t2 --mode heal --room 48 --gather --apply
//
//   node tools/m59-keep-training.mjs --agent t3 --until "remove curse" --cwd C:/code/m59-lab/prod-deploy \
//        --stdin "disciple-drill agents=t3 rounds=40" -- node tools/m59-fleet-repl.mjs
//
// Operator, 2026-09-27: "set up the shalille trainings to survive restarts of the dum/keeper".
//
// WHY A RUNNER AND NOT ONLY A TOUGHER LOOP. The loops were made tougher too (shalille-train now
// re-finds its keepers and re-takes its lease after an outage), but a run can still END for a
// reason that is not "the job is done": a FleetScript step that fails while the broker is down
// unwinds the whole run, a restart that outlasts the loop's patience finishes it, a Windows
// update reboots the machine under it. Each of those left a trainee standing idle in a temple
// until somebody noticed. This notices.
//
// WHAT "DONE" MEANS IS ASKED OF THE BROKER, NEVER INFERRED FROM THE EXIT. After every run it asks
// remaining_required_to_learn_new_skills — the broker's own reproduction of PlayerCanLearn — and
// stops only when the named ability is learnable (or already known). An exit code says how a
// process ended; it does not say whether the character can now buy the spell.
//
// IT HOLDS NOTHING AND DRIVES NOTHING. No lease, no roster, no socket: it waits for the broker's
// /health, waits for the character to be in game, starts the command, and waits for it to end.
// The command owns the character. So stopping this is Ctrl-C; the child is stopped with it.
import { spawn } from 'node:child_process';
import process from 'node:process';

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const opts = dash >= 0 ? argv.slice(0, dash) : argv;
const command = dash >= 0 ? argv.slice(dash + 1) : [];
const arg = (n, d = null) => { const i = opts.indexOf(`--${n}`); return i >= 0 && opts[i + 1] ? opts[i + 1] : d; };
const die = (m) => { console.error(m); process.exit(2); };

const AGENT = arg('agent') || die('--agent is required');
const UNTIL = arg('until') || die('--until "<ability>" is required: the gate that ends the training');
const STDIN = arg('stdin');                    // a line to feed the command (the fleet REPL), then EOF
const CWD = arg('cwd') || process.cwd();
const BROKER = `http://127.0.0.1:${Number(arg('broker') || 8901)}/`;
const MAX_RUNS = Number(arg('max-runs') || 500);
const PAUSE_MS = Math.max(5, Number(arg('pause') || 30)) * 1000;
if (!command.length) die('give the training command after --');

const stamp = () => new Date().toISOString().slice(11, 19);
const say = (...a) => console.log(stamp(), '[keep-training]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(tool, args, timeoutMs = 60_000) {
  const r = await fetch(BROKER, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json();
  const t = j?.result?.content?.[0]?.text;
  if (typeof t !== 'string' || t.startsWith('error:')) throw new Error(t ?? JSON.stringify(j?.error ?? j));
  return JSON.parse(t);
}

// THE BROKER IS UP AND HOLDS THIS CHARACTER IN GAME. Polled, not assumed: a restart is a window
// in which /health does not answer, then answers with no sessions, then with sessions still
// logging in. Starting the command in the middle of that is how the last run failed.
async function waitReady() {
  for (let i = 0; ; i++) {
    try {
      const h = await (await fetch(`${BROKER}health`, { signal: AbortSignal.timeout(15_000) })).json();
      if (h?.session_characters?.[AGENT]) {
        const st = await call('status', { agent: AGENT }, 45_000);
        if (st?.in_game !== false && st?.connected !== false) return;
      }
    } catch {}
    if (i % 10 === 0) say(`waiting for the broker to hold ${AGENT} in game…`);
    await sleep(15_000);
  }
}

async function gateOpen() {
  try {
    const r = await call('remaining_required_to_learn_new_skills', { agent: AGENT, name: UNTIL }, 60_000);
    const row = (r?.candidates ?? [])[0];
    if (!row) return { known: false };
    return { known: true, open: row.can_learn === true || row.already_known === true,
             have: row.have, need: row.need, gap: row.remaining_required };
  } catch (e) { return { known: false, why: e.message }; }
}

function runOnce() {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { cwd: CWD, stdio: [STDIN ? 'pipe' : 'ignore', 'inherit', 'inherit'] });
    if (STDIN) { child.stdin.write(`${STDIN}\n`); child.stdin.end(); }
    const stop = () => { try { child.kill(); } catch {} };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    child.on('exit', (code, signal) => {
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      resolve({ code, signal });
    });
  });
}

let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

say(`${AGENT}: training until "${UNTIL}" is learnable — ${command.join(' ')}${STDIN ? `  <<< ${STDIN}` : ''}`);
for (let run = 1; run <= MAX_RUNS && !stopping; run++) {
  await waitReady();
  const g0 = await gateOpen();
  if (g0.open) { say(`"${UNTIL}" is learnable (${g0.have}/${g0.need}) — done, buy it`); process.exit(0); }
  say(`run ${run}${g0.known ? ` — gate ${g0.have}/${g0.need}, gap ${g0.gap}` : ''}`);
  const r = await runOnce();
  if (stopping) break;
  say(`run ${run} ended (${r.signal ?? `exit ${r.code}`}); checking the gate before the next`);
  await sleep(PAUSE_MS);
}
say(stopping ? 'stopped' : `gave up after ${MAX_RUNS} runs`);
