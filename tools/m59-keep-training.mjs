#!/usr/bin/env node
// KEEP A TRAINING RUN GOING THROUGH BROKER, KEEPER AND DUM RESTARTS, UNTIL ITS TARGETS ARE MET.
//
//   node tools/m59-keep-training.mjs --agent t2 --until "remove curse" \
//        -- node tools/m59-shalille-train.mjs --healer t2 --mode heal --room 48 --gather --apply
//
//   node tools/m59-keep-training.mjs --agent t3 --until "remove curse" --cwd C:/code/m59-lab/prod-deploy \
//        --stdin "disciple-drill agents=t3 rounds=40" -- node tools/m59-fleet-repl.mjs
//
//   # two commands in turn, training past the gate until minor heal is 99, with a training ledger:
//   node tools/m59-keep-training.mjs --agent t2 --until "remove curse" --until-ability "minor heal=99" \
//        --school "Shal'ille" --reagents "herb,elderberry,fairy wing,inky-cap mushroom" --cwd <prod> \
//        -- node <abs>/m59-shalille-train.mjs --healer t2 ... --- repl:disciple-drill agents=t2 rounds=40
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
// WHAT "DONE" MEANS IS ASKED OF THE BROKER, NEVER INFERRED FROM THE EXIT. Before every run it asks
// remaining_required_to_learn_new_skills — the broker's own reproduction of PlayerCanLearn — and the
// abilities it was told to raise. An exit code says how a process ended; it does not say whether
// the character can now buy the spell.
//
// PAST THE GATE. Operator, 2026-09-27: "Both disciples will want to get 99 in minor heal and the rest
// of the improves in the other spells". `--until-ability "minor heal=99"` keeps training after the
// gate opens until every named ability is at its target. The gate opening is announced every run
// ("is learnable — buy it") so whoever is watching buys the spell; it no longer ends the runner.
//
// SEVERAL COMMANDS, IN TURN. After `--`, commands separated by `---`; one starting `repl:` is a
// FleetScript line fed to the fleet REPL in --cwd. Run N uses command N mod count, so a disciple can
// alternate a heal loop with a drill without anybody switching them by hand.
//
// THE TRAINING LEDGER. Each run is bracketed by run_start / run_end records (m59-training-ledger.mjs):
// a snapshot of --school's abilities and --reagents, the code that ran (git sha, dirty, file hash),
// rooms travelled, and improves read off the two snapshots. The run id goes to the child as
// M59_TRAINING_RUN so its own cast and restock records join the same run. A ledger failure is said
// and never stops training. `node tools/m59-training-report.mjs --agent <a>` reads it back.
//
// IT HOLDS NOTHING AND DRIVES NOTHING. No lease, no roster, no socket to a keeper: it waits for the
// broker's /health, waits for the character to be in game, starts the command, and waits for it to
// end. The command owns the character. So stopping this is Ctrl-C; the child is stopped with it.
import { spawn } from 'node:child_process';
import process from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { trainingLedger, codeIdentity, snapshot, improvesBetween, brokerHealth } from './m59-training-ledger.mjs';

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const opts = dash >= 0 ? argv.slice(0, dash) : argv;
const command = dash >= 0 ? argv.slice(dash + 1) : [];
const arg = (n, d = null) => { const i = opts.indexOf(`--${n}`); return i >= 0 && opts[i + 1] ? opts[i + 1] : d; };
const die = (m) => { console.error(m); process.exit(2); };

const AGENT = arg('agent') || die('--agent is required');
const UNTIL = arg('until');
// A GOAL THAT IS NOT A SPELL. --until-said "<text>" ends the runner after a run whose output contains
// that text — so a script that knows its own goal (a karma target, a count of berries) says so in one
// line and the runner needs no idea what it means. Added 2026-09-28 for tree-farm. Either this or
// --until is required; with both, whichever comes first ends it.
const UNTIL_SAID = arg('until-said');
if (!UNTIL && !UNTIL_SAID) die('--until "<ability>" or --until-said "<text>" is required: the goal that ends the training');
const STDIN = arg('stdin');                    // a line to feed a single command (the fleet REPL), then EOF
const CWD = arg('cwd') || process.cwd();
// A FleetScript line run through the fleet REPL (in --cwd) BEFORE every run — a restock, say. The
// script decides for itself whether there is anything to do; one that compiles to no steps costs a
// read. Added 2026-09-27 when Pepe's heal loop ran its pack dry of herbs and could only stop.
const PRE = arg('pre');
const TARGETS = (arg('until-ability') || '').split(',').map(x => x.trim()).filter(Boolean)
  .map(x => { const [name, n] = x.split('='); return { name: name.trim(), to: Number(n) }; });
const SCHOOL = arg('school');
const UNTIL_KNOWN = opts.includes('--until-known');
const REAGENTS = (arg('reagents') || '').split(',').map(x => x.trim()).filter(Boolean);
const BROKER = `http://127.0.0.1:${Number(arg('broker') || 8901)}/`;
const MAX_RUNS = Number(arg('max-runs') || 500);
const PAUSE_MS = Math.max(5, Number(arg('pause') || 30)) * 1000;
if (!command.length) die('give the training command after --');

const ENTRIES = (() => {
  const groups = []; let cur = [];
  for (const tok of command) { if (tok === '---') { if (cur.length) groups.push(cur); cur = []; } else cur.push(tok); }
  if (cur.length) groups.push(cur);
  return groups.map(e => e[0].startsWith('repl:')
    ? { cmd: ['node', 'tools/m59-fleet-repl.mjs'], stdin: [e[0].slice(5), ...e.slice(1)].join(' ').trim() }
    : { cmd: e, stdin: groups.length === 1 ? STDIN : null });
})();

// WHICH FILE RAN, for the ledger's code identity: a REPL line names a FleetScript (local first, as the
// REPL resolves it); anything else is its script argument.
function toolFile(entry) {
  if (entry.stdin && entry.cmd.join(' ').includes('m59-fleet-repl')) {
    const name = entry.stdin.split(/\s+/)[0];
    for (const d of ['substrate/fleetscripts', 'tools/fleetscripts']) {
      const f = join(CWD, d, `${name}.mjs`); if (existsSync(f)) return f;
    }
    return null;
  }
  const f = entry.cmd.find(a => /\.mjs$/.test(a));
  return f ? (isAbsolute(f) ? f : join(CWD, f)) : null;
}

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
  if (!UNTIL) return { known: false, open: false, none: true };
  try {
    const r = await call('remaining_required_to_learn_new_skills', { agent: AGENT, name: UNTIL }, 60_000);
    const row = (r?.candidates ?? [])[0];
    if (!row) return { known: false };
    // AN UNREAD INTELLECT IS NOT ZERO. A keeper that came up without its attribute read publishes
    // `attributes: null`, and the formula then subtracts nothing for intellect — measured on Pepe
    // 2026-09-27: need 255 instead of 171. That errs strict, so it could never stop a run early,
    // but it would keep one training past the real gate. Report it and decide nothing from it.
    if (!(Number(r?.intellect) > 0))
      return { known: false, why: `intellect unread (${JSON.stringify(r?.intellect)}); need ${row.need} is not trustworthy` };
    // --until-known: done only when the character KNOWS the ability, not when it could buy it. The
    // Qor-disciple order buys its spells inside the run, so "learnable" there means "not yet".
    return { known: true, open: UNTIL_KNOWN ? row.already_known === true : (row.can_learn === true || row.already_known === true),
             have: row.have, need: row.need, gap: row.remaining_required };
  } catch (e) { return { known: false, why: e.message }; }
}

async function abilitiesMet() {
  if (!TARGETS.length) return { met: true, short: [] };
  const a = await call('abilities', { agent: AGENT, kind: 'both', refresh: true }, 60_000).catch(() => null);
  if (!a) return { met: false, short: ['abilities unreadable'] };
  const have = Object.fromEntries([...(a.spells ?? []), ...(a.skills ?? [])].map(x => [String(x.name).toLowerCase(), x.ability]));
  const short = TARGETS.filter(t => !(Number(have[t.name.toLowerCase()]) >= t.to))
    .map(t => `${t.name} ${have[t.name.toLowerCase()] ?? '?'}/${t.to}`);
  return { met: short.length === 0, short };
}

// ROOMS TRAVELLED during a run, from the fleet ledger's own zone_change events for this agent.
function roomsBetween(h, t0, t1) {
  let n = 0;
  for (const day of new Set([t0, t1].map(t => new Date(t).toISOString().slice(0, 10)))) {
    let text = '';
    try { text = readFileSync(join(h.root, 'substrate', 'history', h.fleet, `fleet-${day}.jsonl`), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes(`"${AGENT}"`) || !line.includes('zone_change')) continue;
      try { const e = JSON.parse(line); if (e.agent === AGENT && e.kind === 'zone_change' && e.t >= t0 && e.t <= t1) n++; } catch {}
    }
  }
  return n;
}

function runOnce(cmd, stdinLine = null, env = {}, { watch = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd: CWD, env: { ...process.env, ...env },
      stdio: [stdinLine ? 'pipe' : 'ignore', watch ? 'pipe' : 'inherit', 'inherit'] });
    if (stdinLine) { child.stdin.write(`${stdinLine}\n`); child.stdin.end(); }
    // Tee, so the log reads exactly as before, and remember whether the goal line went past.
    let said = false;
    if (watch) child.stdout.on('data', d => { process.stdout.write(d); if (!said && String(d).includes(watch)) said = true; });
    const stop = () => { try { child.kill(); } catch {} };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    child.on('exit', (code, signal) => {
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      resolve({ code, signal, said });
    });
  });
}

let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

const describe = e => e.stdin ? `repl<<< ${e.stdin}` : e.cmd.join(' ');
say(`${AGENT}: training until ` + [UNTIL && `"${UNTIL}" is ${UNTIL_KNOWN ? 'known' : 'learnable'}`,
    UNTIL_SAID && `a run says "${UNTIL_SAID}"`].filter(Boolean).join(' or ') +
    (TARGETS.length ? ` and ${TARGETS.map(t => `${t.name}>=${t.to}`).join(', ')}` : '') +
    ` — ${ENTRIES.map(describe).join('  |  ')}`);
// YIELDING THE CHARACTER TO ANOTHER ERRAND, BETWEEN RUNS. Operator, 2026-09-27: a Shal'ille disciple
// is to act as the guild hall's door-man for a courier who cannot enter it. The errand writes
//     <broker root>/substrate/history/<fleet>/training-yield/<agent>   (content: who wants it, and why)
// and this runner, at the next run boundary — never mid-run — writes `<agent>.yielded` beside it
// and waits until the request file is gone, then deletes its acknowledgement and carries on. The
// errand waits for the acknowledgement before it claims the character, so nothing contends for the
// body: a heal loop holds a commander lease no other claim could take. A request older than
// --yield-max minutes (default 30) is treated as abandoned and training resumes.
async function honourYield() {
  let h = null; try { h = await brokerHealth(); } catch { return; }
  const dir = join(h.root, 'substrate', 'history', h.fleet, 'training-yield');
  const req = join(dir, AGENT), ack = join(dir, `${AGENT}.yielded`);
  // AN ACK THAT OUTLIVED ITS RUNNER IS A LIE. This runner deletes its ack only while it is alive and
  // sees the request go, so a killed or restarted runner leaves one behind — and an errand that
  // waits only for the ack to EXIST then drives a character this runner still owns (2026-09-28,
  // two eviction runs drove Statler while disciple-drill held him). With no request standing, any
  // ack on disk is stale; this runner never leaves one unless it is actually standing aside.
  if (!existsSync(req)) { try { (await import('node:fs')).unlinkSync(ack); } catch {} return; }
  const maxMs = Math.max(1, Number(arg('yield-max') || 30)) * 60_000;
  const why = (() => { try { return readFileSync(req, 'utf8').trim().slice(0, 200); } catch { return '?'; } })();
  say(`yielding ${AGENT} between runs: ${why}`);
  const { writeFileSync, unlinkSync, statSync } = await import('node:fs');
  try { writeFileSync(ack, `${new Date().toISOString()} keep-training pid ${process.pid}\n`); } catch {}
  while (existsSync(req) && !stopping) {
    let age = 0; try { age = Date.now() - statSync(req).mtimeMs; } catch {}
    if (age > maxMs) { say(`yield request is ${Math.round(age / 60000)} min old — treating it as abandoned`); break; }
    await sleep(10_000);
  }
  try { unlinkSync(ack); } catch {}
  say(`${AGENT} is back from the yield`);
}

for (let run = 1; run <= MAX_RUNS && !stopping; run++) {
  await honourYield();
  await waitReady();
  const g0 = await gateOpen();
  const want = await abilitiesMet();
  if (g0.open) say(UNTIL_KNOWN ? `"${UNTIL}" is known` : `"${UNTIL}" is learnable (${g0.have}/${g0.need}) — buy it`);
  if (g0.open && want.met) { say('every target met — done'); process.exit(0); }
  const entry = ENTRIES[(run - 1) % ENTRIES.length];
  say(`run ${run}${g0.known ? ` — gate ${g0.have}/${g0.need}, gap ${g0.gap}` : g0.why ? ` — gate UNKNOWN: ${g0.why}` : ''}` +
      (want.short.length ? ` — still short: ${want.short.join(', ')}` : '') + ` — ${describe(entry)}`);
  if (PRE) {
    say(`before run ${run}: ${PRE}`);
    await runOnce(['node', 'tools/m59-fleet-repl.mjs'], PRE);
    if (stopping) break;
  }
  const file = toolFile(entry);
  let led = null, before = null, h = null;
  try {
    h = await brokerHealth();
    led = await trainingLedger({ agent: AGENT, code: file ? codeIdentity(file) : null, health: h });
    before = await snapshot((t, a) => call(t, a), AGENT, { school: SCHOOL, reagentNames: REAGENTS });
    await led.record({ kind: 'run_start', school: SCHOOL, command: describe(entry), gate: g0, snapshot: before });
  } catch (e) { say(`training ledger unavailable: ${e.message}`); led = null; }
  const t0 = Date.now();
  const r = await runOnce(entry.cmd, entry.stdin, led ? { M59_TRAINING_RUN: led.run } : {}, { watch: UNTIL_SAID });
  if (led) {
    try {
      const after = await snapshot((t, a) => call(t, a), AGENT, { school: SCHOOL, reagentNames: REAGENTS });
      for (const imp of improvesBetween(before, after)) await led.record({ ...imp, school: SCHOOL });
      await led.record({ kind: 'run_end', school: SCHOOL, exit: r.signal ?? r.code, snapshot: after,
                         rooms_travelled: roomsBetween(h, t0, Date.now()) });
    } catch (e) { say(`training ledger could not close run ${led.run}: ${e.message}`); }
  }
  if (stopping) break;
  if (r.said) { say(`run ${run} said "${UNTIL_SAID}" — done`); process.exit(0); }
  say(`run ${run} ended (${r.signal ?? `exit ${r.code}`}); checking the gate before the next`);
  await sleep(PAUSE_MS);
}
say(stopping ? 'stopped' : `gave up after ${MAX_RUNS} runs`);
