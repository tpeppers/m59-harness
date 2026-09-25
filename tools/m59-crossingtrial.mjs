#!/usr/bin/env node
// HOW DOES THE FLEET CROSS ONE DANGEROUS ROOM — MEASURED, NOT ARGUED.
//
//   node tools/m59-crossingtrial.mjs --agents shadow01,shadow03,... --trials 4 --label baseline
//   node tools/m59-crossingtrial.mjs --agents ... --trials 3 --dir both --label legs
//   node tools/m59-crossingtrial.mjs --report                 # read the ledger back
//   node tools/m59-crossingtrial.mjs --report --label baseline,legs
//
// Written for Ukgoth (599), the room that has killed this fleet more than any other: 218
// recorded deaths on prod, and a 2026-09-24 convoy rehearsal that lost five of twenty
// characters standing "inert — travelling to Outside Castle Victoria" inside it. The defaults
// are that crossing — 598 -> 599 -> 2, and back 2 -> 599 -> 598 — but every one is a flag,
// because the next dangerous room is a different number and the same question.
//
// ONE TRIAL IS A CONVOY. K characters are placed (DM relocate, lab only) a few squares short
// of the start room's door into the danger room, healed to full, and all told `travel` to the
// far room at once — the way an operator sends a group, and the way the rehearsal died. The
// harness then only WATCHES: one `fleet` read a second, until every character has arrived,
// died, left for somewhere else, or run out of time.
//
// WHAT IS RECORDED, PER CHARACTER PER TRIAL (substrate/crossingtrials.jsonl, one line each):
//
//   outcome        arrived | died | timeout | elsewhere (ended in a room that is neither)
//   in_room_s      seconds between the first and last sample inside the danger room
//   hp_start/min   health on entering the danger room, and the lowest seen inside it
//   damage         the sum of every health DROP seen inside the room (regeneration does not
//                  cancel it — a character that lost 30 and healed 10 took 30)
//   stalls         keeper event-loop blocks while in the danger room, from the keeper's own
//                  `[loop]` profiler lines (count, total ms, worst ms, and the top caller).
//                  The keeper only logs blocks over M59_LOOP_STALL_MS (1500 by default) —
//                  start the broker with M59_LOOP_STALL_MS=200 or this column undercounts,
//                  and the record says which threshold was in force.
//
// THE LAB BARGAIN (docs/m59-fleetscratch.md). Placement and healing remove NOISE — the walk
// from wherever a character happened to be, and the damage it brought with it. Nothing here
// touches the thing measured: not the room, not its monsters, not the mover. A trial on this
// harness is a trial the prod fleet could repeat without a DM, only slower to set up. It
// refuses any fleet whose game server is not loopback.
//
// It never records a character's NAME in the ledger — agents only (shadowNN), which are
// roster slots, not people.
import { readFileSync, appendFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import * as dm from './m59-dm.mjs';
import { rosterGameEndpoint } from './m59-fleetpath.mjs';
// FleetScript's hold, not a copy of it: a claim takes the FACULTIES and not the BODY, and the
// keeper's own agenda (a town trip, its assigned room) otherwise re-takes the character
// mid-crossing — the first smoke run measured exactly that, twice in two characters.
let holdKeeper = null;     // loaded in main(), so the pure helpers import cheaply

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const sub = (...p) => join(REPO, 'substrate', ...p);

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const has = n => argv.includes('--' + n);
const KNOWN = new Set(['port', 'fleet', 'agents', 'trials', 'dir', 'label', 'timeout-s', 'report',
                       'danger', 'a', 'b', 'a-at', 'b-at', 'keeper-logs', 'out', 'dry-run',
                       'settle-s', 'help', 'h', 'no-heal-between', 'restall']);
for (const a of argv) if (a.startsWith('--') && !KNOWN.has(a.slice(2))) {
  console.error(`m59-crossingtrial: unknown option ${a}\nknown: ${[...KNOWN].map(k => '--' + k).join(' ')}`);
  process.exit(2);
}
if (has('help') || has('h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 40)
    .map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const PORT = Number(flag('port', 8971));
const DANGER = Number(flag('danger', 599));
const ROOM_A = Number(flag('a', 598));
const ROOM_B = Number(flag('b', 2));
// row,col a few squares inside A and B short of their doors into the danger room. Defaults
// are Ukgoth's: 598's baked anchor to 599 is r65c19 and 2's is r20c1.
const parseAt = s => { const [r, c] = String(s).split(',').map(Number); return { row: r, col: c }; };
const AT_A = parseAt(flag('a-at', '62,19'));
const AT_B = parseAt(flag('b-at', '20,4'));
const TRIALS = Number(flag('trials', 3));
const DIR = flag('dir', 'both');                   // forward | back | both
const LABEL = flag('label', 'unlabelled');
const TIMEOUT_S = Number(flag('timeout-s', 360));
const SETTLE_S = Number(flag('settle-s', 6));
const OUT = flag('out', sub('crossingtrials.jsonl'));
const LOGS = flag('keeper-logs', sub());
const FLEET = flag('fleet', process.env.M59_FLEET
  ?? (() => { try { return readFileSync(sub('fleet-default'), 'utf8').trim(); } catch { return '-'; } })());

// ---------------------------------------------------------------- pure helpers (tested)

// `[loop] shadow21 event loop was blocked ~2964ms, resumed 2026-09-24T21:52:24.693Z (room 599,
// doing zoning, travelling to 2) hot: ... | callers: sheltersAlong m59-safespots.mjs:667 2549ms, ...`
const LOOP_RE = /^\[loop\] (\S+) event loop was blocked ~(\d+)ms, resumed (\S+) \(room (\S+),/;
export function parseLoopLine(line) {
  const m = LOOP_RE.exec(line);
  if (!m) return null;
  const callers = /\| callers: ([^,]+?) (\d+)ms/.exec(line);
  const hot = / hot: ([^,|]+?) \d+ms/.exec(line);
  const idle = /\(idle\) :0 (\d+)ms/.exec(line);
  // WHOSE TIME WAS IT. The monitor reports how late its 500ms timer fired, and on a machine
  // running two fleets that lateness is often not ours at all: the profiler's samples inside
  // the window read `(idle)` — the process was descheduled or collecting, not computing. The
  // inclusive time of the heaviest frame from OUR files is what this code actually spent, and
  // it is the number a planning fix can move. `code_ms` is that; `ms` is the raw lateness.
  return { agent: m[1], ms: Number(m[2]), at: Date.parse(m[3]),
           room: m[4] === '?' ? null : Number(m[4]),
           caller: callers ? callers[1].trim() : null,
           code_ms: callers ? Number(callers[2]) : 0,
           idle_ms: idle ? Number(idle[1]) : null,
           // The profiler's own analysis shows up as a stall right after a stall it reported.
           self_report: !!callers && /m59-keeper-process\.mjs:48\d\d$/.test(callers[1].trim()),
           hot: hot ? hot[1].trim() : null };
}

// Every stall one agent logged inside [from, to] while in `room`.
export function stallsIn(lines, { agent, room, from, to }) {
  const out = [];
  for (const l of lines) {
    const s = typeof l === 'string' ? parseLoopLine(l) : l;
    if (!s || s.agent !== agent) continue;
    if (!(s.at >= from && s.at <= to)) continue;
    if (room != null && s.room !== room) continue;
    out.push(s);
  }
  const callers = new Map();
  const ours = out.filter(s => !s.self_report);
  for (const s of ours) if (s.caller) callers.set(s.caller, (callers.get(s.caller) ?? 0) + s.code_ms);
  const top = [...callers.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  return { count: out.length, total_ms: out.reduce((a, s) => a + s.ms, 0),
           worst_ms: out.reduce((a, s) => Math.max(a, s.ms), 0),
           // What OUR code spent inside those windows (see parseLoopLine), and how many windows
           // it spent 250ms or more of — the bound this harness exists to check.
           code_ms: ours.reduce((a, s) => a + s.code_ms, 0),
           worst_code_ms: ours.reduce((a, s) => Math.max(a, s.code_ms), 0),
           code_over_250: ours.filter(s => s.code_ms >= 250).length,
           top_caller: top ? top[0] : null };
}

// Reduce one character's sample stream to the crossing record. Samples are
// { t, room, hp, max, deaths } in time order. `dest` is where it was sent.
export function summarise(samples, { danger, dest, start, timedOut = false }) {
  const inside = samples.filter(s => s.room === danger);
  const deaths0 = samples[0]?.deaths ?? 0;
  const died = samples.some(s => (s.deaths ?? 0) > deaths0) || samples.some(s => s.room === 1);
  const last = samples.at(-1) ?? null;
  let damage = 0, min = null;
  for (let i = 0; i < inside.length; i++) {
    const s = inside[i];
    if (Number.isFinite(s.hp)) min = min == null ? s.hp : Math.min(min, s.hp);
    const prev = i > 0 ? inside[i - 1] : samples[samples.indexOf(s) - 1];
    if (prev && Number.isFinite(prev.hp) && Number.isFinite(s.hp) && s.hp < prev.hp) damage += prev.hp - s.hp;
  }
  const outcome = died ? 'died'
    : last?.room === dest ? 'arrived'
    : timedOut ? 'timeout'
    : last?.room === start || last?.room === danger ? 'timeout' : 'elsewhere';
  return {
    outcome,
    entered: inside.length > 0,
    in_room_s: inside.length ? Math.round((inside.at(-1).t - inside[0].t) / 100) / 10 : 0,
    entered_at: inside[0]?.t ?? null, left_at: inside.at(-1)?.t ?? null,
    hp_start: inside[0]?.hp ?? null, hp_min: min, max_hp: inside[0]?.max ?? last?.max ?? null,
    damage,
    end_room: last?.room ?? null,
  };
}

// ---------------------------------------------------------------- report

// THE WINDOW A ROW WAS IN THE DANGER ROOM, from its own fields or, for rows written before
// those existed, from its trace (seconds from the order, one entry per change).
export function windowOf(row) {
  const t0 = Date.parse(row.at);
  if (row.entered_at) return { from: Date.parse(row.entered_at),
                              to: Date.parse(row.left_at ?? row.entered_at) + 1500 };
  const tr = row.trace ?? [];
  const i = tr.findIndex(x => x[1] === row.danger);
  if (i < 0) return null;
  const j = tr.findIndex((x, k) => k > i && x[1] !== row.danger && x[1] != null);
  const end = j >= 0 ? tr[j][0] : (row.total_s ?? tr.at(-1)[0]);
  return { from: t0 + tr[i][0] * 1000, to: t0 + end * 1000 + 1500 };
}

// Re-read the keeper logs for every row in the ledger and rewrite its stall figures. The
// logs are the evidence; the ledger's stall columns are a summary of them, and a better
// summary (see parseLoopLine) should not need the crossings run again.
function restall() {
  const rows = readFileSync(OUT, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
  const logs = String(flag('keeper-logs', sub())).split(',');
  const lines = [];
  for (const dir of logs) {
    let files = [];
    try { files = readdirSync(dir).filter(f => /^keeper-.*\.log$/.test(f)); } catch { continue; }
    for (const f of files) for (const line of readFileSync(join(dir, f), 'utf8').split(/\r?\n/))
      if (line.startsWith('[loop]')) { const s = parseLoopLine(line); if (s) lines.push(s); }
  }
  for (const r of rows) {
    const w = windowOf(r);
    if (!w) continue;
    const st = stallsIn(lines, { agent: r.agent, room: r.danger, from: w.from, to: w.to });
    r.stalls = { ...st, over_250: lines.filter(l => l.agent === r.agent && l.room === r.danger
      && l.at >= w.from && l.at <= w.to && l.ms >= 250).length };
  }
  writeFileSync(OUT, rows.map(r => JSON.stringify(r) + '\n').join(''));
  console.log(`re-read stalls for ${rows.length} rows from ${lines.length} [loop] lines`);
}

function report() {
  if (!existsSync(OUT)) { console.log(`no ledger at ${OUT}`); return; }
  const rows = readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const labels = flag('label') ? String(flag('label')).split(',') : [...new Set(rows.map(r => r.label))];
  const pct = (a, b) => b ? (100 * a / b).toFixed(0) + '%' : '-';
  const med = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  console.log('label        dir      n  arrived  died  timeout  elsewh  in-room med/p90 s   dmg med   stalls/crossing  worst stall ms  code>=250ms  worst code ms');
  for (const label of labels) for (const dir of ['forward', 'back']) {
    // ONLY CROSSINGS THAT HAPPENED. A character that never entered the danger room — placed
    // while a previous journey was still dying, or refused at the door — is not evidence
    // about the room, and counting it as a death or a timeout would be the harness's fault.
    const rs = rows.filter(r => r.label === label && r.dir === dir && r.entered);
    if (!rs.length) continue;
    const n = rs.length;
    const k = o => rs.filter(r => r.outcome === o).length;
    const times = rs.filter(r => r.entered).map(r => r.in_room_s).sort((a, b) => a - b);
    const p90 = times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.9))] : null;
    const st = rs.reduce((a, r) => a + (r.stalls?.count ?? 0), 0);
    const worst = rs.reduce((a, r) => Math.max(a, r.stalls?.worst_ms ?? 0), 0);
    const over = rs.reduce((a, r) => a + (r.stalls?.code_over_250 ?? 0), 0);
    const worstCode = rs.reduce((a, r) => Math.max(a, r.stalls?.worst_code_ms ?? 0), 0);
    console.log(`${label.padEnd(12)} ${dir.padEnd(8)} ${String(n).padStart(2)}  ` +
      `${pct(k('arrived'), n).padStart(7)}  ${pct(k('died'), n).padStart(4)}  ${pct(k('timeout'), n).padStart(7)}  ` +
      `${pct(k('elsewhere'), n).padStart(6)}  ${String(med(times)).padStart(8)}/${String(p90).padEnd(8)}  ` +
      `${String(med(rs.filter(r => r.entered).map(r => r.damage))).padStart(7)}   ` +
      `${(st / n).toFixed(1).padStart(8)}         ${String(worst).padStart(8)}   ${String(over).padStart(9)}   ${String(worstCode).padStart(9)}`);
  }
}

// ---------------------------------------------------------------- plumbing

function call(name, args, ms = 60000) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return new Promise(done => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
                 connection: 'close', 'x-m59-deadline-ms': String(ms) },
      agent: false, timeout: ms }, res => {
      let t = ''; res.setEncoding('utf8');
      res.on('data', c => { t += c; });
      res.on('end', () => {
        let text = null;
        try { text = JSON.parse(t).result.content[0].text; } catch { return done({ _error: `no result from ${name}` }); }
        try { done(JSON.parse(text)); } catch { done({ _error: String(text).trim().slice(0, 200) }); }
      });
    });
    req.on('timeout', () => { req.destroy(); done({ _error: 'timeout' }); });
    req.on('error', e => done({ _error: e.message }));
    req.end(body);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOLDS = new Map();
const DIED = new Set();
const hpOf = s => { const m = /^(\d+)\/(\d+)$/.exec(String(s ?? '')); return m ? { hp: Number(m[1]), max: Number(m[2]) } : { hp: null, max: null }; };

function loopLines() {
  const out = [];
  let files = [];
  try { files = readdirSync(LOGS).filter(f => /^keeper-.*\.log$/.test(f)); } catch { return out; }
  for (const f of files) {
    let text = '';
    try { text = readFileSync(join(LOGS, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) if (line.startsWith('[loop]')) {
      const s = parseLoopLine(line); if (s) out.push(s);
    }
  }
  return out;
}

async function fleetRows() {
  const f = await call('fleet', {}, 20000);
  if (!Array.isArray(f?.fleet)) return null;
  return new Map(f.fleet.map(a => [a.agent, a]));
}

async function place(agents, byAgent, room, at) {
  const names = agents.map(a => byAgent.get(a)?.character).filter(Boolean);
  for (const a of agents) {
    await HOLDS.get(a)?.cancelJourney?.('crossing trial: placing for the next crossing').catch(() => {});
    await call('cancel_movement', { agent: a }, 15000);
  }
  const moved = await dm.relocate(names, room, at, {}).catch(e => ({ ok: false, why: e.message }));
  await dm.heal(names).catch(() => null);
  // AND RETIRE WHATEVER JOURNEY IS STILL RUNNING. A crossing that timed out is still a travel
  // job in the keeper, and cancelling it does not stop it re-planning from the square it was
  // relocated to — two squares from the door it was trying to walk through, so it walked back
  // into the danger room before the next trial began (baseline, trials 2-3). A travel to the
  // room the body is already in replaces it and arrives at once.
  await Promise.all(agents.map(a => call('travel', { agent: a, to: room, health_floor: 0,
    run_errands: false, background: true }, 20000)));
  return moved;
}

async function trial(agents, { from, fromAt, to, dir, index }) {
  // A HOLD THAT OUTLIVES THE TRIAL, AND A FRESH ONE AFTER A DEATH. FleetScript's hold lets go
  // the moment its body dies (so the keeper can walk out of the Underworld), and a trial after a
  // death would otherwise run on a character the keeper has taken back — measured on the first
  // smoke run. But releasing and re-taking a LIVE hold is worse: in the gap the keeper starts a
  // journey of its own (a town trip), the re-take cancels it into a SUSPENDED journey, and a
  // suspended journey resumes under a claim — the baseline's first run lost three of six
  // characters to 101, 102 and 583 that way. Only the trial's own `travel` retires one.
  const ctx = { name: 'crossingtrial', log: (a, m) => console.log(`  [${a}] ${m}`) };
  for (const a of agents) {
    if (HOLDS.has(a) && !DIED.has(a)) continue;
    await HOLDS.get(a)?.release?.().catch?.(() => {});
    HOLDS.set(a, await holdKeeper(ctx, a, FLEET).catch(() => null));
    DIED.delete(a);
  }
  let rows = await fleetRows();
  if (!rows) throw new Error('fleet read failed — is the broker on ' + PORT + ' up?');
  // PLACED, AND READ BACK, UP TO THREE TIMES. A relocate that races a death lands the body in
  // the Underworld after all; a relocate is only evidence once the room reads back.
  let notThere = agents;
  for (let tryNo = 0; tryNo < 3 && notThere.length; tryNo++) {
    const moved = await place(notThere, rows, from, fromAt);
    if (!moved?.ok) console.log(`  place: ${moved?.why ?? 'failed'}`);
    await sleep(SETTLE_S * 1000);
    rows = await fleetRows() ?? rows;
    notThere = agents.filter(a => rows.get(a)?.room_num !== from);
  }
  // Heal again after the settle: a keeper that re-read its vitals mid-teleport can have
  // started a rest, and a trial must start every body at the same health.
  if (!has('no-heal-between')) await dm.heal(agents.map(a => rows.get(a)?.character).filter(Boolean)).catch(() => null);
  await sleep(1500);
  rows = await fleetRows() ?? rows;
  notThere = agents.filter(a => rows.get(a)?.room_num !== from);
  if (notThere.length) console.log(`  not in ${from} after placing, sitting this trial out: ` +
    notThere.map(a => `${a} (in ${rows.get(a)?.room_num ?? '?'}: ${String(rows.get(a)?.activity ?? '').slice(0, 40)})`).join(', '));
  agents = agents.filter(a => !notThere.includes(a));
  if (!agents.length) return [];
  const started = Date.now();
  // SENT, AND SEEN TO START. A keeper still walking a journey of its own answers `is busy`, and
  // a trial that polls a body which never set out measures the wrong journey — the smoke runs
  // recorded a whole "crossing" that was a town trip to 113. FleetScript's answer: cancel the
  // job in flight and re-issue at once.
  const send = a => call('travel', {
    agent: a, to, background: true, run_errands: false,
    despite_hazard: { reason: `crossing trial: measuring the ${DANGER} crossing on the lab server` },
    health_floor: 0,
  }, 30000);
  const sent = await Promise.all(agents.map(async a => {
    let r = await send(a);
    for (let tryNo = 0; tryNo < 3 && r?.started !== true; tryNo++) {
      await HOLDS.get(a)?.cancelJourney?.('crossing trial: clearing the way for the trial walk').catch(() => {});
      await call('cancel_movement', { agent: a }, 15000);
      await sleep(2500);
      r = await send(a);
    }
    return r;
  }));
  sent.forEach((r, i) => { if (r?.started !== true) console.log(`  travel ${agents[i]} NOT STARTED: ${JSON.stringify(r).slice(0, 240)}`); });
  const samples = new Map(agents.map(a => [a, []]));
  const done = new Set();
  const deaths0 = new Map(agents.map(a => [a, rows.get(a)?.deaths ?? 0]));
  while (done.size < agents.length && Date.now() - started < TIMEOUT_S * 1000) {
    const t = Date.now();
    const now = await fleetRows();
    if (now) for (const a of agents) {
      if (done.has(a)) continue;
      const r = now.get(a);
      if (!r) continue;
      const { hp, max } = hpOf(r.health);
      samples.get(a).push({ t, room: r.room_num ?? null, hp, max, deaths: r.deaths ?? 0,
                            activity: r.activity ?? null, pos: r.position ?? null });
      if (r.room_num === to || r.room_num === 1 || (r.deaths ?? 0) > deaths0.get(a)) done.add(a);
      // Left the danger room for somewhere that is neither end: stop following it after it
      // has been there a little while (a fall into the gutter routes out south to 589).
      const s = samples.get(a);
      if (s.some(x => x.room === DANGER) && r.room_num !== DANGER && r.room_num !== from && r.room_num !== to
          && s.slice(-5).every(x => x.room === r.room_num) && s.length > 5) done.add(a);
    }
    const spent = Date.now() - t;
    if (spent < 1000) await sleep(1000 - spent);
  }
  const ended = Date.now();
  await sleep(2500);                 // let the last profiler lines land in the logs
  const lines = loopLines();
  const out = [];
  for (const a of agents) {
    const s = samples.get(a);
    const sum = summarise(s, { danger: DANGER, dest: to, start: from, timedOut: !done.has(a) });
    const window = { agent: a, room: DANGER, from: sum.entered_at ?? started, to: (sum.left_at ?? ended) + 1500 };
    const st = stallsIn(lines, window);
    const over = lines.filter(l => l.agent === a && l.room === DANGER && l.at >= window.from && l.at <= window.to && l.ms >= 250).length;
    const all = stallsIn(lines, { agent: a, room: null, from: started, to: ended + 1500 });
    const row = { at: new Date(started).toISOString(), label: LABEL, dir, trial: index, agent: a,
                  from, to, danger: DANGER, convoy: agents.length,
                  loop_stall_threshold_ms: Number(process.env.M59_LOOP_STALL_MS || 0) || null,
                  ...sum, stalls: { ...st, over_250: over }, stalls_whole_trip: all,
                  total_s: Math.round(((sum.outcome === 'arrived' ? s.find(x => x.room === to)?.t : ended) - started) / 100) / 10 };
    row.entered_at = sum.entered_at ? new Date(sum.entered_at).toISOString() : null;
    row.left_at = sum.left_at ? new Date(sum.left_at).toISOString() : null;
    // WHAT IT WAS DOING, at every change — the part of a crossing a number cannot say. One
    // entry per change of (room, activity), seconds from the order, with the square.
    row.trace = [];
    for (const x of s) {
      const prev = row.trace.at(-1);
      const act = String(x.activity ?? '').slice(0, 60);
      if (prev && prev[1] === x.room && prev[2] === act) continue;
      row.trace.push([Math.round((x.t - started) / 1000), x.room, act,
                      x.pos ? `r${x.pos.row}c${x.pos.col}` : null, x.hp]);
    }
    if (row.trace.length > 80) row.trace = [...row.trace.slice(0, 40), ...row.trace.slice(-40)];
    out.push(row);
    if (row.outcome === 'died') DIED.add(a);
    appendFileSync(OUT, JSON.stringify(row) + '\n');
    console.log(`  ${a.padEnd(9)} ${row.outcome.padEnd(9)} in ${DANGER} ${String(row.in_room_s).padStart(6)}s  ` +
                `hp ${row.hp_start}->${row.hp_min}/${row.max_hp}  dmg ${row.damage}  ` +
                `stalls ${st.count} (worst ${st.worst_ms}ms, code worst ${st.worst_code_ms}ms${st.top_caller ? ', ' + st.top_caller : ''})  end ${row.end_room}`);
  }
  return out;
}

async function main() {
  if (has('restall')) { restall(); return report(); }
  if (has('report')) return report();
  if (!process.env.M59_CONTROL_URL) process.env.M59_CONTROL_URL = `http://127.0.0.1:${PORT}/`;
  ({ holdKeeper } = await import('./m59-fleetscript.mjs'));
  const rosterFile = FLEET === '-' ? sub('fleet-state.json') : (process.env.M59_STATE_FILE || sub('fleets', `${FLEET}.json`));
  const rostered = rosterGameEndpoint(rosterFile);
  if (!rostered || !dm.isLoopbackHost(rostered.host)) {
    console.error(`m59-crossingtrial: REFUSING — fleet "${FLEET}" (${rosterFile}) is not on a loopback game server.`);
    console.error('  This places and heals characters with DM powers; it is a LAB tool.');
    process.exit(2);
  }
  const agents = String(flag('agents', '')).split(',').map(s => s.trim()).filter(Boolean);
  if (!agents.length) { console.error('m59-crossingtrial: --agents a,b,c is required'); process.exit(2); }
  const health = await call('fleet', {}, 20000);
  if (!Array.isArray(health?.fleet)) { console.error(`no fleet on ${PORT}: ${JSON.stringify(health).slice(0, 200)}`); process.exit(1); }
  const known = new Set(health.fleet.map(a => a.agent));
  const missing = agents.filter(a => !known.has(a));
  if (missing.length) { console.error(`not in this fleet: ${missing.join(', ')}`); process.exit(2); }
  if (has('dry-run')) { console.log(`would run ${TRIALS} trial(s) ${DIR} with ${agents.join(',')}`); return; }
  console.log(`crossing trial "${LABEL}": ${agents.length} characters, ${TRIALS} trial(s), ${DIR}, ` +
              `${ROOM_A} -> ${DANGER} -> ${ROOM_B}; stall threshold ${process.env.M59_LOOP_STALL_MS || '(keeper default)'}`);
  // THE KEEPER'S OWN AGENDA OFF FOR THE TRIAL. A hold takes the faculties, but a keeper in
  // `farm` mode still RESUMES a suspended journey of its own (passFarm puts the resume ahead of
  // the claim check), and that journey then runs as a SECOND travel on the same body — the first
  // legs run logged two crossings of 599 interleaved in one keeper, one to Castle Victoria and
  // one to 589 for a town trip. `survive` keeps the whole survival ladder and runs no errands.
  // Restored at the end.
  const modes = new Map();
  for (const a of agents) {
    const st = await call('status', { agent: a }, 30000);
    modes.set(a, st?.autopilot_status?.mode ?? null);
    await call('autopilot', { agent: a, action: 'start', mode: 'survive' }, 30000);
  }
  console.log(`  keepers set to survive for the trial (were: ${[...modes].map(([a, m]) => `${a}=${m}`).join(', ')})`);
  try {
  for (let i = 1; i <= TRIALS; i++) {
    if (DIR === 'forward' || DIR === 'both') {
      console.log(`trial ${i} forward ${ROOM_A} -> ${ROOM_B}`);
      await trial(agents, { from: ROOM_A, fromAt: AT_A, to: ROOM_B, dir: 'forward', index: i });
    }
    if (DIR === 'back' || DIR === 'both') {
      console.log(`trial ${i} back ${ROOM_B} -> ${ROOM_A}`);
      await trial(agents, { from: ROOM_B, fromAt: AT_B, to: ROOM_A, dir: 'back', index: i });
    }
  }
  } finally {
    for (const h of HOLDS.values()) await h?.release?.().catch?.(() => {});
    for (const [a, m] of modes) if (m && m !== 'survive')
      await call('autopilot', { agent: a, action: 'start', mode: m }, 30000);
  }
  report();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
