#!/usr/bin/env node
// IS THE FLEET BEING DRIVEN RIGHT NOW — and if not, for how long, and does that cost us yet?
//
//   node tools/m59-prodwatch.mjs                  one check. Exit 0 up, 1 down past the alert, 2 cannot tell
//   node tools/m59-prodwatch.mjs --watch          loop, and say something only when the answer CHANGES
//   node tools/m59-prodwatch.mjs --fleet prod --port 8901
//   node tools/m59-prodwatch.mjs --alert-s 180 --penalty-s 600
//
// WHY THIS EXISTS, AND WHY THE NUMBERS ARE NOT ROUND BY ACCIDENT.
//
// `m59-uptime.mjs` already records when nobody was driving, and it is the right ledger for
// "which deaths happened during an outage". What it cannot do is tell you while it is
// happening: it is read afterwards, by somebody who already suspects something. Prod went
// down on 2026-09-16 and stayed down for twenty-five minutes, and the only reason anybody
// found out was that an unrelated command failed with ECONNREFUSED on 8901.
//
// **AFTER TEN MINUTES DOWN, THE GAME STARTS CHARGING US.** Operator, 2026-09-16: in-game
// penalties are applied to characters once they have been left that long. That is the
// number this tool exists to stay ahead of, and it is why the alert fires at THREE — a
// third of the budget, which is enough time to read the line, decide, and run one command.
//
// A stopped keeper is not a pause. The character stands exactly where it was, in whatever
// room it was in, and everything that was already swinging at it carries on — so an outage
// is twenty-three characters being held still in a fight. See the header of m59-uptime.mjs.
//
// WHAT "UP" MEANS HERE IS THE SAME THING `m59-which.mjs` MEANS BY IT, and for the same
// reason: a broker is ours only when its own `/health` names OUR roster file as its state
// path. Two checkouts can each hold a fleet called `prod` and they are not the same
// twenty-three characters, so a matching LABEL proves nothing. This tool re-implements that
// rule rather than importing it because m59-which.mjs is a CLI with no exports; if it ever
// grows them, delete this copy rather than letting the two drift.
//
// AND HERE, UNLIKE IN `m59-which.mjs`, SILENCE IS NOT A QUESTION — IT IS AN ALARM.
//
// That tool answers "which fleet would my next command touch", where guessing wrong is
// worse than refusing, so a port that does not answer is INDETERMINATE and it stops. This
// one answers "is anybody driving", where the cost of a missed outage is measured in
// in-game penalties on twenty-three characters. So an unreachable port counts as DOWN for
// the purposes of the clock, and is reported as `unreachable` rather than `down` so the
// distinction survives into whatever reads it. The exit code still separates them: 2 is
// "could not ask", 1 is "asked, and nobody is there".
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName, stateFileFor } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

export const DEFAULT_ALERT_MS = 3 * 60_000;    // say something while there is still time to act
export const DEFAULT_PENALTY_MS = 10 * 60_000; // operator, 2026-09-16: in-game penalties land here

// ---------------------------------------------------------------- the decision, as a pure function
//
// Separated from the fetching so it can be tested without a socket, which is the only way a
// guard like this gets a test at all. `health` is whatever the port said (or null), `roster`
// is the absolute path we expect it to be holding.
export function verdict({ health, roster, downSince = null, now = Date.now(),
                          alertMs = DEFAULT_ALERT_MS, penaltyMs = DEFAULT_PENALTY_MS } = {}) {
  const same = (a, b) => a && b && resolve(String(a)).toLowerCase() === resolve(String(b)).toLowerCase();
  let state;
  if (health === null) state = 'unreachable';
  else if (!health || health.ok !== true) state = 'down';
  // THE STATE PATH IS THE IDENTITY, NEVER THE LABEL. A broker answering on our port while
  // holding a different roster is not our fleet being up — it is somebody else's fleet
  // wearing our port, which is worse than nothing there, because it reads as healthy.
  else if (!same(health.state, roster)) state = 'foreign';
  else state = 'up';

  const up = state === 'up';
  const since = up ? null : (downSince ?? now);
  const forMs = up ? 0 : Math.max(0, now - since);
  return {
    state, up, down_since: since, down_for_ms: forMs,
    alert: !up && forMs >= alertMs,
    penalty: !up && forMs >= penaltyMs,
    // The whole point of the 3/10 split: how long until it starts costing something.
    penalty_in_ms: up ? null : Math.max(0, penaltyMs - forMs),
    holder: state === 'foreign' ? (health?.state ?? null) : null,
    why: up ? 'the broker on this port is holding our roster'
       : state === 'unreachable' ? 'nothing answered on this port — counted as down, because a ' +
           'missed outage costs in-game penalties and a false alarm costs one command'
       : state === 'foreign' ? 'a broker answered but it is holding a different roster file'
       : 'the broker answered but did not report ok',
  };
}

export const describe = (v) => {
  const s = Math.round(v.down_for_ms / 1000);
  if (v.up) return 'UP — ' + v.why;
  const head = v.penalty ? 'DOWN, PAST THE PENALTY LINE' : v.alert ? 'DOWN, ALERT' : 'down';
  const tail = v.penalty
    ? `${s}s with nobody driving; in-game penalties apply from ${Math.round(DEFAULT_PENALTY_MS / 1000)}s`
    : `${s}s so far; penalties in ${Math.round(v.penalty_in_ms / 1000)}s`;
  return `${head} (${v.state}) — ${tail}. ${v.why}`;
};

// ---------------------------------------------------------------- cli
if (import.meta.filename === process.argv[1]) {
  const fleet = arg('--fleet') || (() => { try { return fleetName(); } catch { return 'prod'; } })();
  const port = Number(arg('--port', 8901));
  const alertMs = Number(arg('--alert-s', DEFAULT_ALERT_MS / 1000)) * 1000;
  const penaltyMs = Number(arg('--penalty-s', DEFAULT_PENALTY_MS / 1000)) * 1000;
  const roster = stateFileFor(fleet);

  // The down-since clock has to survive between invocations or a cron job can never measure
  // a duration — every run would see a fresh outage and never reach three minutes.
  const stateFile = arg('--state', join(REPO, 'substrate', `prodwatch-${fleet}.json`));
  const readSince = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')).down_since ?? null; } catch { return null; } };
  const writeSince = (v) => {
    try { mkdirSync(dirname(stateFile), { recursive: true });
          writeFileSync(stateFile, JSON.stringify({ down_since: v, at: Date.now() }) + '\n'); }
    catch { /* a watcher that cannot write its own clock must still report */ }
  };

  const ask = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(8000) });
      return await r.json();
    } catch { return null; }
  };

  const once = async (prev) => {
    const v = verdict({ health: await ask(), roster, downSince: prev, alertMs, penaltyMs });
    writeSince(v.down_since);
    return v;
  };

  if (!has('--watch')) {
    const v = await once(readSince());
    console.log(`${fleet} on ${port}: ${describe(v)}`);
    if (!existsSync(roster)) console.log(`  note: no roster at ${roster} — is --fleet right?`);
    process.exit(v.state === 'unreachable' ? 2 : v.up ? 0 : (v.alert ? 1 : 0));
  }

  // WATCH SAYS SOMETHING ONLY WHEN THE ANSWER CHANGES, or when a threshold trips. A watcher
  // that prints every tick is one nobody reads, which is the same failure as no watcher.
  let last = null, saidAlert = false, saidPenalty = false, since = readSince();
  for (;;) {
    const v = await once(since);
    since = v.down_since;
    if (v.state !== last) { console.log(`[${new Date().toISOString()}] ${fleet}: ${describe(v)}`); last = v.state; }
    if (v.alert && !saidAlert) { console.log(`[${new Date().toISOString()}] ALERT: ${describe(v)}`); saidAlert = true; }
    if (v.penalty && !saidPenalty) { console.log(`[${new Date().toISOString()}] PENALTY LINE: ${describe(v)}`); saidPenalty = true; }
    if (v.up) { saidAlert = false; saidPenalty = false; }
    await new Promise(r => setTimeout(r, Number(arg('--every-s', 20)) * 1000));
  }
}
