#!/usr/bin/env node
// WHEN WAS NOBODY DRIVING — and which deaths happened then.
//
//   node tools/m59-uptime.mjs            # outages, longest first
//   node tools/m59-uptime.mjs deaths     # deaths marked against them
//
// WHY THIS EXISTS. A keeper is the only thing that makes a character act: without it the
// character stands exactly where it was, in whatever room it was in, and everything that
// was already swinging at it carries on. So a stopped keeper is not a pause, it is a
// character being held still in a fight — and a broker restart stops all twenty-one at
// once, which is why deaths arrive in waves.
//
// None of that was measurable. The broker log carries no timestamps at all, and the
// postmortem records what the character was doing without recording whether anything was
// driving it. So every death got attributed to a hunting decision, including the ones
// where the last decision had been made minutes earlier by a keeper that no longer
// existed. That is a bad way to judge a strategy: it charges the strategy for the
// operator's restarts.
//
// This is deliberately a SEPARATE ledger from the journal. The journal lives in the
// keeper, and a keeper that is gone cannot write "I am gone".
import { appendFileSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const UPTIME_FILE = process.env.M59_UPTIME_FILE ||
  join(HERE, '..', 'substrate', 'keeper-uptime.jsonl');

// How long after a keeper comes back a death still counts as belonging to the outage.
// A character that has been standing still under attack for two minutes is usually
// already past saving when the keeper returns, and the first thing the keeper does is
// look around — so the death lands a few seconds after the resume, not before it.
export const GRACE_MS = 45_000;

// `file` is injectable so a test can write somewhere harmless. It matters more here
// than in most places: this is the file that decides which deaths were real, so a
// fixture leaking into it corrupts the one measurement it exists to provide.
export function record(agent, event, detail = {}, file = UPTIME_FILE) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ at: Date.now(), agent, event, ...detail }) + '\n');
  } catch { /* never let bookkeeping break a keeper */ }
}

export function readLedger(file = UPTIME_FILE) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .sort((a, b) => a.at - b.at);
}

// Every window during which a given agent had nothing driving it. An outage that never
// closed is still an outage — it is reported with `open: true` rather than dropped,
// because "the keeper never came back" is the worst case and the easiest to miss.
export function outages(agent, ledger = readLedger(), now = Date.now()) {
  const mine = ledger.filter(e => e.agent === agent);
  const out = [];
  let downAt = null, why = null;
  for (const e of mine) {
    // A KEEPER THAT WAS REVIVED IS DRIVING AGAIN, WHATEVER OPENED THE OUTAGE.
    //
    // This closed only on `start`, and the autopilot records four events, not two: a hard
    // stop writes `stop`, a soft one writes `inert`, and coming back writes `revive` or
    // `start` depending on which call did it. So a hard stop followed by revives — which
    // is the normal shape of a redeploy, and of every errand that holds a keeper — left
    // the outage open until the next literal `start`, hours later.
    //
    // Measured: Statler was charged an 8h13m outage running from a redeploy at 08:57 to
    // the next `start` at 17:10, during which it killed 27 things. Three deaths fell
    // inside windows like that and were reported as "nothing was driving the character",
    // which is the one number this file exists to get right — it is what deaths are
    // discounted by when judging the hunting strategy. Inflating it hides real failures
    // behind fake ones.
    if (e.event === 'stop' && downAt == null) { downAt = e.at; why = e.why ?? null; }
    else if ((e.event === 'start' || e.event === 'revive') && downAt != null) {
      out.push({ from: downAt, to: e.at, ms: e.at - downAt, why });
      downAt = null; why = null;
    }
  }
  if (downAt != null) out.push({ from: downAt, to: now, ms: now - downAt, why, open: true });
  return out;
}

// Was this character unattended when it died? Returns the outage it fell in, or null.
// Also catches deaths just AFTER a resume, for the reason in GRACE_MS.
// Was this outage somebody's decision, or a fault? A stop that named a reason was asked
// for; one that did not is either a crash or a keeper that fell over quietly. The
// distinction is the whole point of the ledger — an errand walking a character with its
// keeper held is the operator working, and charging its deaths to "nothing was driving"
// mixes the two things this exists to separate. Twenty-five minutes of one agent's
// downtime last night was a supply errand doing its job.
const DELIBERATE = /deliberate|held for|took the controls/i;
export function wasDeliberate(outage) {
  return !!outage && DELIBERATE.test(String(outage.why || ''));
}

export function outageAround(agent, at, ledger = readLedger()) {
  for (const o of outages(agent, ledger)) {
    if (at >= o.from && at <= o.to + GRACE_MS)
      return { ...o, died_ms_into_outage: at - o.from,
               after_resume: at > o.to ? at - o.to : 0 };
  }
  return null;
}

// ------------------------------------------------- did it crash, and when

// A CRASH WRITES NOTHING. That is the hole in everything above: stop() records "I am
// going away" and a process that dies cannot. So the worst outages — the ones where
// twenty-one characters stood still until somebody noticed — are exactly the ones the
// ledger cannot see.
//
// The fix is a file that exists only while keepers are running, and is REMOVED on a
// clean shutdown. Find it with nothing running and the last run crashed. That much is
// an ordinary lock, and the broker already has one for fleet ownership.
//
// What a lock cannot tell you is WHEN. So this one is touched periodically, and the
// last touch is the estimate: the process was alive at that moment and not at the next
// beat, which brackets the crash to one interval. Cheap — one small write a minute —
// and it is the difference between "it crashed sometime today" and "it crashed at
// 21:47, during which these four deaths happened".
export const ACTIVE_FILE = process.env.M59_ACTIVE_FILE ||
  join(HERE, '..', 'substrate', 'keeper-active.json');
export const BEAT_MS = 30_000;

let beatTimer = null;

export function markRunning(agents = [], meta = {}) {
  try {
    mkdirSync(dirname(ACTIVE_FILE), { recursive: true });
    const write = () => {
      try {
        writeFileSync(ACTIVE_FILE, JSON.stringify({
          pid: process.pid, beat_at: Date.now(), started_at: meta.startedAt ?? Date.now(),
          agents, ...meta,
        }));
      } catch { /* a missed beat only widens the estimate */ }
    };
    write();
    if (beatTimer) clearInterval(beatTimer);
    beatTimer = setInterval(write, BEAT_MS);
    beatTimer.unref?.();                       // never hold the process open for this
  } catch { /* bookkeeping must not break a broker */ }
}

// Clean shutdown. The absence of this file is the whole signal, so it must be removed
// on every orderly path — exit, SIGINT, SIGTERM.
export function markStopped() {
  if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
  try { unlinkSync(ACTIVE_FILE); } catch { /* already gone, which is the same thing */ }
}

// Called at startup, BEFORE claiming anything. If an active file is present and its pid
// is not alive, the previous run died without cleaning up, and every agent it was
// driving was unattended from the last heartbeat until now. Those stops are written into
// the ledger so the outage is measurable, flagged as an estimate rather than a fact.
//
// Returns what it found, or null when the last shutdown was clean.
export function recoverCrash({ now = Date.now(), activeFile = ACTIVE_FILE,
                               ledgerFile = UPTIME_FILE } = {}) {
  let prev;
  try { prev = JSON.parse(readFileSync(activeFile, 'utf8')); } catch { return null; }
  if (!prev?.pid) { try { unlinkSync(activeFile); } catch {} return null; }
  // Still alive? Then this is a second broker starting, which is a different problem and
  // not ours to adjudicate — the fleet lock handles it. Leave the file alone.
  //
  // ANY live pid counts, including our own. recoverCrash runs BEFORE markRunning, so a
  // file bearing this process's pid can only be a dead predecessor whose pid was reused
  // — and calling that a crash on the strength of a recycled number would invent an
  // outage. Missing a rare one is the cheaper error: this file is evidence about which
  // deaths were real, and a false entry in it is worse than a missing one.
  try { process.kill(prev.pid, 0); return null; } catch { /* dead: carry on */ }
  const at = prev.beat_at ?? prev.started_at ?? now;
  for (const agent of prev.agents || [])
    record(agent, 'stop', { why: 'the broker crashed — no clean shutdown',
                            estimated: true, from_heartbeat: at, pid: prev.pid }, ledgerFile);
  try { unlinkSync(activeFile); } catch { /* fine */ }
  return { pid: prev.pid, agents: prev.agents || [], last_beat: at, silent_for_ms: now - at };
}

// ------------------------------------------------------------------- cli

// RUN THE CLI ONLY WHEN THIS FILE *IS* THE PROGRAM.
//
// This compared `import.meta.url.endsWith(argv[1])`, and argv[1] is EMPTY under
// `node -e` and in some embeddings — where endsWith('') is true of every string. So the
// module printed its outage report the moment anything imported it, the broker included.
// Comparing whole URLs has no such edge, and the argv[1] guard keeps it false when there
// is no script at all.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ledger = readLedger();
  if (!ledger.length) { console.log('no uptime ledger yet — it starts filling once a keeper stops or starts'); process.exit(0); }
  const agents = [...new Set(ledger.map(e => e.agent))];
  if (process.argv[2] === 'deaths') {
    const dir = join(HERE, '..', 'substrate', 'postmortems');
    const fs = await import('node:fs');
    const files = existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
    let marked = 0, total = 0, heldInstead = 0;
    // ONLY JUDGE THE DEATHS THIS LEDGER COULD HAVE SEEN.
    //
    // The first version counted every postmortem on disk and reported "0 of 264
    // unattended (0%)" — which reads as a finding and is nothing of the kind, because
    // 263 of them happened before the ledger existed. A denominator that includes
    // unmeasurable cases makes a young ledger look like an exoneration.
    const ledgerBegan = Math.min(...ledger.map(e => e.at));
    let tooOld = 0;
    for (const f of files) {
      const d = JSON.parse(fs.readFileSync(join(dir, f), 'utf8'));
      if (d.reason !== 'died' || !d.at || !d.agent) continue;
      if (d.at < ledgerBegan) { tooOld++; continue; }
      total++;
      const o = outageAround(d.agent, d.at, ledger);
      if (o) {
        // A HELD KEEPER IS NOT A DROPPED ONE. An errand walking the character with its
        // keeper deliberately stopped is the operator working, and counting those against
        // the hunting strategy is the same mistake as counting them for it.
        const held = wasDeliberate(o);
        if (held) heldInstead++; else marked++;
        console.log(`${held ? '·' : '*'} ${d.character} ${new Date(d.at).toISOString().slice(11, 19)} — ` +
          `${Math.round(o.died_ms_into_outage / 1000)}s into an outage of ${Math.round(o.ms / 1000)}s` +
          (o.after_resume ? ` (${Math.round(o.after_resume / 1000)}s after the keeper came back)` : '') +
          (held ? `  [deliberate: ${String(o.why).slice(0, 40)}]` : '')); }
    }
    console.log(`\n${marked} of ${total} judgeable deaths happened with nothing driving ` +
      `the character${total ? ` (${(100 * marked / total).toFixed(0)}%)` : ''}`);
    if (heldInstead)
      console.log(`${heldInstead} more died while a keeper was DELIBERATELY held — an errand was ` +
        'driving that character. Those are the operator, not the strategy, and not a fault.');
    console.log(`the ledger starts at ${new Date(ledgerBegan).toISOString().slice(0, 19)}Z; ` +
      `${tooOld} earlier death(s) cannot be judged and are excluded.`);
    if (total < 20)
      console.log(`NOT YET A RESULT — ${total} death(s) is too few to conclude anything either way.`);
  } else {
    const all = agents.flatMap(a => outages(a).map(o => ({ ...o, agent: a })))
                      .sort((x, y) => y.ms - x.ms);
    console.log(`${all.length} outages across ${agents.length} agents, longest first:`);
    for (const o of all.slice(0, 20))
      console.log(`  ${o.agent.padEnd(4)} ${Math.round(o.ms / 1000).toString().padStart(5)}s  ` +
                  `${new Date(o.from).toISOString().slice(11, 19)}${o.open ? '  STILL DOWN' : ''}  ${o.why ?? ''}`);
  }
}
