#!/usr/bin/env node
// DEEP TELEMETRY FOR A RUNNING FLEET — the instrument, so nobody has to infer from symptoms.
//
//   node tools/m59-trace.mjs                          60s at 5s, every character
//   node tools/m59-trace.mjs --seconds 300 --interval 2
//   node tools/m59-trace.mjs --agents t1,t13 --depth full
//   node tools/m59-trace.mjs --replay substrate/traces/<file>.jsonl
//
// WHY THIS EXISTS. A broker that is misbehaving was, until now, diagnosed by watching
// socket counts and room numbers change — which cannot distinguish "walking slowly" from
// "blocked in one await for nine minutes", and those have opposite fixes. Both of this
// session's wrong turns came from that gap: 86 log lines saying "something else may be
// holding this character" were read as another machine competing for the fleet when the
// real cause was a saturated event loop, and a fleet reporting "travelling" for fifteen
// minutes was read as a long walk when nobody was moving at all.
//
// READ-ONLY, AND THAT IS THE POINT. It calls exactly two broker tools — `fleet` and
// `autopilot action=status` — issues no orders, moves nobody, and needs no restart.
// Restarting the broker to observe it logs out twenty-one characters, which means the
// old instrument cost more than the fault on a shared server.
//
// The numbers that actually decide things, and why each is here rather than derived:
//
//   watchdog.blocked_now_ms   HOW LONG THE CURRENT PASS HAS BEEN INSIDE ONE await. The
//                             keeper is a long-await machine; a pass can block for
//                             minutes while the character stands still reporting
//                             "travelling". This is the single most diagnostic field on
//                             the broker and nothing else implies it.
//   watchdog.interrupts       whether the watchdog ever ACTED. Ticking is not helping:
//                             697 ticks with 0 interrupts against a 528s block is a
//                             watchdog watching a fault it is not configured to catch.
//   ms_since_moved            about the KEEPER, never the character. It climbs while an
//                             errand walks perfectly well, so it is recorded beside
//                             room_num rather than trusted alone — see CLAUDE.md.
//   refusals / waiting_on     the terminal movement reasons. A refusal that repeats with
//                             the same reason is a route that will never succeed.
//
// Traces land in substrate/traces/ (gitignored, like everything a running fleet writes).
import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TRACE_DIR = join(ROOT, 'substrate', 'traces');

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const has = name => argv.includes(`--${name}`);

const SECONDS  = Number(flag('seconds', 60));
const INTERVAL = Number(flag('interval', 5));
const DEPTH    = flag('depth', 'keeper');            // board | keeper | full
const CONTROL  = flag('control', 'http://127.0.0.1:8901');
const ONLY     = flag('agents') ? flag('agents').split(',').map(s => s.trim()) : null;

// ---------------------------------------------------------------------------
async function call(name, args = {}, timeoutMs = 30000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(CONTROL + '/', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                             params: { name, arguments: args } }),
    });
    const body = await res.json();
    const text = body?.result?.content?.[0]?.text;
    return text ? JSON.parse(text) : null;
  } catch (e) {
    // A TIMEOUT IS DATA, NOT AN ERROR. The fault this tool was written for makes the
    // broker unable to answer at all; recording that is the whole point, so it is
    // returned as an observation rather than thrown.
    return { _unreachable: true, _why: e.name === 'AbortError' ? `no answer in ${timeoutMs}ms` : e.message };
  } finally { clearTimeout(timer); }
}

const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o[k]]));

async function sample(tick) {
  const at = new Date().toISOString();
  const board = await call('fleet');
  if (board?._unreachable)
    return { at, tick, unreachable: true, why: board._why, rows: [] };

  const rows = (board.fleet || []).filter(r => !ONLY || ONLY.includes(r.agent));
  const out = [];
  for (const r of rows) {
    const row = pick(r, ['agent', 'character', 'room', 'room_num', 'health', 'vigor',
                         'activity', 'kills_30m', 'stalled', 'committed', 'parked',
                         'waiting_on', 'refusals', 'has_weapon', 'purse']);
    if (DEPTH !== 'board') {
      const st = await call('autopilot', { agent: r.agent, action: 'status' }, 20000);
      if (st?._unreachable) row.status_unreachable = st._why;
      else {
        row.watchdog = st?.watchdog ?? null;
        Object.assign(row, pick(st, ['running', 'inert', 'passes', 'running_for_seconds',
                                     'last_error', 'last_error_age_s', 'last_error_live',
                                     'failing_passes', 'stalled', 'yield_check', 'waiting_on',
                                     'refusals', 'denied_rooms', 'safe_spot', 'threat']));
        if (DEPTH === 'full') Object.assign(row, pick(st, ['did', 'recent', 'trials',
                                                          'coordination', 'placement', 'policy']));
      }
    }
    out.push(row);
  }
  return { at, tick, agents: out.length, stalled_count: board.stalled_count,
           needs_attention: board.needs_attention, rows: out };
}

// ---------------------------------------------------------------------------
// THE SUMMARY IS THE PRODUCT. A JSONL nobody reads is not an instrument, so the
// questions that actually get asked are answered here directly.
function summarise(samples) {
  const per = new Map();
  for (const s of samples) {
    for (const r of s.rows || []) {
      if (!per.has(r.agent)) per.set(r.agent, {
        agent: r.agent, character: r.character, rooms: [], blocked: [], interrupts: [],
        activities: new Set(), refusals: new Set(), waiting: new Set(), kills: [], passes: [],
        // THE BODY, NOT THE KEEPER. Everything else on this row measures the keeper, and
        // a wedged character has a keeper that is working hard — replanning into the same
        // wall — so `passes` advances and `blocked_now_ms` stays small while nobody moves.
        // See PULSE_MS in m59-autopilot.mjs.
        wedged: [], wedges: [],
      });
      const p = per.get(r.agent);
      if (r.room_num !== undefined && p.rooms.at(-1) !== r.room_num) p.rooms.push(r.room_num);
      if (r.watchdog?.blocked_now_ms !== undefined) p.blocked.push(r.watchdog.blocked_now_ms);
      if (r.watchdog?.interrupts !== undefined) p.interrupts.push(r.watchdog.interrupts);
      if (r.watchdog?.wedges !== undefined) p.wedges.push(r.watchdog.wedges);
      if (r.watchdog?.wedged) p.wedged.push(r.watchdog.wedged);
      if (r.activity) p.activities.add(String(r.activity).split(/[:—]/)[0].trim());
      for (const x of (r.refusals || [])) p.refusals.add(typeof x === 'string' ? x : JSON.stringify(x).slice(0, 60));
      if (r.waiting_on) p.waiting.add(typeof r.waiting_on === 'string' ? r.waiting_on : JSON.stringify(r.waiting_on).slice(0, 60));
      if (r.kills_30m !== undefined) p.kills.push(r.kills_30m);
      if (r.passes !== undefined) p.passes.push(r.passes);
    }
  }

  const secs = ms => (ms / 1000).toFixed(0) + 's';
  console.log(`\n  ${samples.length} sample(s) over ${SECONDS}s at ${INTERVAL}s, depth=${DEPTH}\n`);
  console.log('  agent  character   moved  maxblock  intr  passes  kills  !  activity / stuck on');
  const stuck = [], notMoving = [];
  for (const p of per.values()) {
    const maxBlock = p.blocked.length ? Math.max(...p.blocked) : null;
    const intr = p.interrupts.length ? Math.max(...p.interrupts) - Math.min(...p.interrupts) : null;
    const passes = p.passes.length ? Math.max(...p.passes) - Math.min(...p.passes) : null;
    const kills = p.kills.length ? Math.max(...p.kills) : 0;
    const moved = Math.max(0, p.rooms.length - 1);
    // A PASS COUNT THAT DOES NOT ADVANCE IS THE REAL STALL SIGNAL — a character can look
    // busy, hold a room, and never complete a keeper pass.
    if (maxBlock !== null && maxBlock > 60000 && passes === 0) stuck.push(p.character);
    // A SECOND, INDEPENDENT STALL SIGNAL, and it catches the case the one above cannot:
    // the keeper completing passes normally while the character never changes square.
    const wedgeEpisodes = p.wedges.length ? Math.max(...p.wedges) - Math.min(...p.wedges) : 0;
    const stillWedged = p.wedged.at(-1) ?? null;
    if (stillWedged || wedgeEpisodes) notMoving.push({ character: p.character, stillWedged, wedgeEpisodes });
    console.log(`  ${String(p.agent).padEnd(6)} ${String(p.character).padEnd(11)} ` +
      `${String(moved).padStart(5)} ${String(maxBlock === null ? '?' : secs(maxBlock)).padStart(9)} ` +
      `${String(intr ?? '?').padStart(5)} ${String(passes ?? '?').padStart(7)} ${String(kills).padStart(6)}  ` +
      `${(stillWedged ? '!' : wedgeEpisodes ? '·' : ' ')}  ` +
      `${[...p.activities].join(',').slice(0, 26)}` +
      (p.waiting.size ? ` | waiting: ${[...p.waiting].join(',').slice(0, 40)}` : '') +
      (p.refusals.size ? ` | refused: ${[...p.refusals].join(',').slice(0, 40)}` : ''));
  }

  if (stuck.length) {
    console.log(`\n  WEDGED — blocked over 60s inside one await AND completed no keeper pass:`);
    console.log(`    ${stuck.join(', ')}`);
    console.log(`    That is not slow travel. The pass is not running; the watchdog ticks but`);
    console.log(`    does not interrupt unless health crosses the flee line.`);
  }
  if (notMoving.length) {
    console.log(`
  ! NOT MOVING — the position pulse says the CHARACTER did not change`);
    console.log(`    square for two samples a second apart, while having somewhere to be.`);
    console.log(`    Resting, holding a safe wall and inert are all excluded, so this is`);
    console.log(`    standing still with an errand outstanding — which is what the pocket`);
    console.log(`    trap looks like from outside, and what no keeper-side number can say.`);
    for (const n of notMoving)
      console.log(`    ${n.character}: ${n.stillWedged
        ? `STILL WEDGED at ${n.stillWedged.at?.col},${n.stillWedged.at?.row} in room ` +
          `${n.stillWedged.at?.room} for ${secs(n.stillWedged.for_ms ?? 0)} while ` +
          `${n.stillWedged.doing}` + (n.stillWedged.taking_hits ? ' AND TAKING HITS' : '')
        : `${n.wedgeEpisodes} episode(s) during this trace, moving again now`}`);
  }
  const unreachable = samples.filter(s => s.unreachable).length;
  if (unreachable)
    console.log(`\n  ${unreachable}/${samples.length} sample(s) got NO ANSWER from the broker — ` +
                `a saturated event loop cannot serve its own board.`);
}

// ---------------------------------------------------------------------------
if (has('replay')) {
  const file = flag('replay');
  summarise(readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)));
  process.exit(0);
}

if (!existsSync(TRACE_DIR)) mkdirSync(TRACE_DIR, { recursive: true });
const OUT = flag('out', join(TRACE_DIR, `trace-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`));
writeFileSync(OUT, '');

const ticks = Math.max(1, Math.floor(SECONDS / INTERVAL));
console.log(`tracing ${ONLY ? ONLY.join(',') : 'every character'} — ${ticks} tick(s), ` +
            `${INTERVAL}s apart, depth=${DEPTH}\n  -> ${OUT}`);

const samples = [];
for (let i = 0; i < ticks; i++) {
  const s = await sample(i);
  samples.push(s);
  appendFileSync(OUT, JSON.stringify(s) + '\n');
  const flag_ = s.unreachable ? 'NO ANSWER' :
    `${s.agents} agent(s), ${s.stalled_count ?? '?'} stalled`;
  process.stdout.write(`  ${String(i + 1).padStart(3)}/${ticks}  ${s.at.slice(11, 19)}  ${flag_}\n`);
  if (i < ticks - 1) await new Promise(r => setTimeout(r, INTERVAL * 1000));
}

summarise(samples);
console.log(`\n  trace: ${OUT}`);
