#!/usr/bin/env node
// ONE CHARACTER, ONE BRAIN.
//
//   node tools/m59-ghostkeeper-test.mjs
//
// Offline. Reads source, opens no socket, touches no roster.
//
// ======================== WHAT THIS PINS ========================
//
// Every keeper is a child process of the broker, and the broker talks to it through a
// `KeeperProxy` — a Session-shaped object whose client is, in m59-broker.mjs's own words,
// "rebuilt from each /state snapshot… a picture, not a wire". It has no `eventsSince`, no
// `roomContents`; its world has no `exits`.
//
// So an Autopilot started on a KeeperProxy cannot complete a single pass. It throws:
//
//     pass failed — c.eventsSince is not a function
//     pass failed — c.roomContents is not a function
//     pass failed — s.world?.exits is not a function
//
// The `autopilot` tool did exactly that. Measured 2026-08-28: twenty-one of twenty-one
// shadow characters had one running, and prod did too. It never drove anything — the real
// keeper process did — but IT WROTE THE FRAMES AND THE POSTMORTEMS. So every death record of
// that day was authored by a blind observer that had never finished a pass: `doing` was null
// in all of them, which prints as "stalled", and `governed_by` reported the ordinary ladder
// because a travel state is entered by a pass and no pass ever completed. Both were read as
// facts about the character. Neither was.
//
// The distinction was already known — `resumeFleet` drops the in-process autopilot for
// keeper-backed characters, and the reconciler tests `!(s instanceof KeeperProxy)`. The tool
// an operator or a harness actually calls never got the same check.
//
// THE FIX IS A REFUSAL, NOT A TEARDOWN, and that is the second half of this file. The obvious
// cleanup is `dropAutopilot`, which stops the shell hard — and a hard stop calls
// `releaseSpot(name)`, whose claims are FILE-BACKED and therefore shared with the keeper
// process. The ghost holds no wall, but the release is by character name, so it would drop the
// claim the real keeper is standing on. A fix for a two-brains bug that reaches across a
// process boundary to unclaim a live wall is a worse bug than the one it fixes.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

const BROKER = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
const AUTOPILOT = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
const FLEET_LOCK = readFileSync(new URL('./runtime/fleet-lock.mjs', import.meta.url), 'utf8');

console.log('\nA KEEPER-BACKED CHARACTER GETS NO SECOND BRAIN IN THE BROKER');
{
  // The tool assembles a policy on a shell and pushes it; what it must not do is run a pass
  // loop on a proxy. `p.start()` has to be behind the proxy test.
  const started = BROKER.indexOf('const started = proxied');
  ok('the autopilot tool decides whether to start on the proxy test', started > 0);
  ok('and it names the proxy class the rest of the file uses',
     /const proxied = sessions\.get\(a\.agent\) instanceof KeeperProxy;/.test(BROKER));
  ok('and a proxied character is told plainly that its keeper owns it',
     /started: false, keeper_backed: true/.test(BROKER));
  // THE ORDER STILL LANDS. Refusing to run a shell is only correct because the instruction
  // reaches the process that obeys it by another road — the roster, and a direct push.
  const remember = BROKER.indexOf("rememberAutopilot(a.agent, { mode: p.mode, policy: { ...p.policy } });");
  const push = BROKER.indexOf('const keeper_push = await pushPolicyToKeeper(a.agent, p);');
  ok('the order is written to the roster before the decision', remember > 0 && remember < started);
  ok('and pushed to the keeper process after it', push > started);
}

console.log('\nAND THE REFUSAL DOES NOT REACH ACROSS THE PROCESS BOUNDARY');
{
  // `dropAutopilot` stops hard, and a hard stop releases spot and quarry claims by NAME.
  ok('a hard stop is what dropAutopilot does', /if \(p\) p\.stop\('the keeper is being discarded', \{ hard: true \}\);/.test(AUTOPILOT));
  ok('and a hard stop releases the spot claim', /releaseSpot\(this\.s\.name\);/.test(AUTOPILOT));
  // FILE-BACKED, which is what makes it a cross-process hazard rather than a tidy-up.
  ok('and spot claims can be file-backed, so that release is shared with the keeper',
     /releaseFileSpot\(agent\)/.test(AUTOPILOT));
  ok('so the guard refuses instead of dropping',
     !/const proxied = sessions\.get\(a\.agent\) instanceof KeeperProxy;\s*\n\s*if \(proxied\) dropAutopilot/.test(BROKER));
  ok('and says why, because the next reader will reach for the teardown',
     /would drop the claim the real\n\s*\/\/ keeper is standing on/.test(BROKER));
}

console.log('\nTHE DISTINCTION WAS ALREADY MADE ELSEWHERE, AND STILL IS');
{
  // These two are the prior art. If either disappears, the argument above has lost its
  // footing and this file should be re-read rather than re-passed.
  ok('resumeFleet still drops an in-process autopilot for a proxied character',
     /if \(s instanceof KeeperProxy\) dropAutopilot\(agent\);/.test(BROKER));
  ok('and the reconciler still refuses to restore one',
     /if \(s\?\.live && p\.keeperWasRunning && !\(s instanceof KeeperProxy\)\)/.test(BROKER));
}

console.log('\nWHY A PROXY CANNOT RUN A PASS — the three methods it does not have');
{
  // Named individually so that a proxy which later grows one of them does not quietly make
  // this suite's premise half-true.
  for (const m of ['eventsSince', 'roomContents'])
    ok(`the pass ladder calls c.${m}, which lives on the real client`,
       new RegExp(`c\\.${m}\\(`).test(AUTOPILOT));
  ok('and the pass ladder calls s.world.exits()', /s\.world\?\.exits\(\)|world\.exits\(\)/.test(AUTOPILOT));
  // The proxy puts roomContents on the SESSION on purpose — the comment there is the whole
  // reason the client cannot have it — so the mismatch is by design and permanent.
  ok('while the proxy carries roomContents on the session, not the client',
     /async roomContents\(opts = \{\}\) \{ return keeperAction\(this\.name, this\._index, 'room_contents', opts\); \}/
       .test(BROKER));
  ok('and says why: the client is a picture, not a wire',
     /The client is\s*\n\s*\/\/ rebuilt from each `\/state` snapshot and is a picture, not a wire/.test(BROKER));
}

console.log('\nA KEEPER THAT DID NOT ANSWER IS A QUESTION, NOT A CORPSE');
{
  // The 45s sweep POSTs /rejoin to each keeper and used to respawn on ANY failure of that
  // fetch — a 30s timeout as readily as a refused connection. Respawning kills the running
  // keeper's journey, so a keeper that was merely BUSY lost its leg and the character stopped
  // where it stood.
  //
  // Measured on the 30-minute cycle of 2026-08-28: 135 rejoin events, around twenty respawns,
  // and thirteen of twenty-one characters ending the run stacked in room 568 at full health
  // with one road showing twelve unfinished crossings — five of them inside a single 64-unit
  // square. It reads as a movement failure and it is a supervision failure: the sweep was
  // pulling the rug out from under keepers that were working. It leaked ports too — 9111..9137
  // in use for a 21-port band — because every respawn allocates a new one.
  //
  // m59-which.mjs already learned this about BROKERS: "a port that does not answer is a
  // question, not a fleet", with prod's /health measured at 1046ms idle and 2573ms under load,
  // so the busiest one is the most likely to be missed and it is always the one that matters.
  // Nobody carried it across to keepers. One postmortem here shows a pass blocked in a single
  // await for 15,856ms, which is a keeper worth NOT killing.
  ok('the sweep asks whether the pid is alive before condemning a keeper',
     /const rec = keeperProcesses\.get\(agent\);[\s\S]{0,200}recordedKeeperAlive\(rec\)/.test(BROKER));
  ok('and a busy keeper is left alone rather than respawned',
     /keeper did not answer in time but pid \$\{rec\.pid\} is /.test(BROKER));
  ok('and only a pid that is genuinely gone earns a respawn',
     /is gone, respawning[\s\S]{0,120}await spawnKeeper\(agent, index, credentials\)/.test(BROKER));
  // An exact ChildProcess handle is stronger than a numeric signal probe. Adopted survivors
  // do not have one, so their fallback is still signal 0; only ESRCH proves death, while
  // EPERM and unexpected errors fail closed as live. A /health round trip here would
  // reintroduce exactly the timeout this exists to survive.
  ok('spawned keepers use their exact child handle before the numeric fallback',
     /return record\.child \? !spawnedChildExited\(record\.child\) : isProcessLive\(record\.pid\)/
       .test(BROKER));
  ok('the adopted-keeper liveness fallback is a signal, not another request',
     /kill\(pid, 0\);[\s\S]{0,120}error\?\.code === 'ESRCH'[\s\S]{0,120}error\?\.code === 'EPERM'/
       .test(FLEET_LOCK));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
