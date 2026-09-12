#!/usr/bin/env node
// A SCRATCHPAD FOR FLEET WORK — EDIT THE ERRAND WHILE THE SESSION STAYS UP.
//
//   node tools/m59-fleetscratch.mjs
//
//   > list                              every pad on disk, and what it says it needs
//   > watch on                          re-compile on save and SHOW the change. Never run it.
//   > check shalille-drill agents=t4     can these characters do this, and what is unknown
//   > dry shalille-drill agents=t4       the compiled steps, nothing sent
//   > go shalille-drill agents=t4        run it, through the same compiler as a real errand
//
// WHY THIS IS NOT THE SIXTH AD-HOC SCRIPT. m59-fleet-repl.mjs says, correctly, that a prompt
// able to send an unguarded `travel` would be exactly that with a nicer interface. So a pad's
// only output is a `steps[]` array: it never gets a socket, never calls the broker, and is
// executed by `fleetScript` like any committed errand, with the run lock, the held body, the
// health floor, the p90 budgets, the lease and the trap check all around it. What is new here
// is WHERE the steps came from (a file being edited right now) and WHEN (inside a session that
// does not exit between attempts). If a pad can do something a promoted fleetscript cannot,
// this file is wrong.
//
// AND WHY A PAD IS NOT A FLEETSCRIPT. A fleetscript is an answer. A pad is the work of finding
// one, and it wants the opposite defaults: it is expected to be broken, re-run, and rewritten
// between attempts, and it carries the notes and the throwaway helpers that a finished errand
// should not. Pads exist so that knowledge with nowhere else to live stops being recorded in
// the header of whatever file the author had open -- lines 12-88 of m59-fleetscript.mjs are 77
// lines of mana-node reachability with two same-day retractions, sitting in the header of a
// compiler, because there was no pad to put them in.
//
// PADS ARE FOR SOMEBODY WHO IS WATCHING. A pad may take more characters mid-session, which a
// fleetscript may not, and that freedom is only safe while an operator or an agent is present
// to see a contention refusal and decide. So a pad is reachable three ways and none of them is
// a keeper, a DUM bot, a cron job or the harness:
//
//   1. substrate/fleetscratch/ is not among the directories loadFleetScripts enumerates by
//      default, so nothing that runs errands BY NAME can see a pad at all;
//   2. this session refuses to start without an interactive stdin, or M59_SCRATCH_OPERATOR
//      set on purpose -- a keeper spawning it is refused rather than obeyed;
//   3. a promoted fleetscript may not import a pad, checked when it is promoted.
//
// WHAT RELOADS HERE, AND WHAT STILL NEEDS A RESTART. The headline is that editing an errand
// needs no restart, and that is true but NARROW, so it is written down rather than implied:
//
//   reloads with no restart   a pad's steps[] -- WHICH steps run, in what order, with what
//                             arguments. Nothing in any long-lived process imports this file or
//                             m59-fleetlib.mjs: no keeper, no broker, no supervisor, no service.
//                             The whole pad stack lives in this ephemeral session.
//   needs a BROKER restart    HOW a step behaves. `travel` and `fight` are broker tools, so
//                             changing what a walk does is a broker change and a pad editing
//                             around it is editing the caller of old code.
//   needs a KEEPER restart    anything in keeper process memory, and every substrate hook:
//                             m59-fleetscript.mjs says of the vault strategy "it is loaded ONCE
//                             and cached ... the same as every other substrate hook."
//
// A PEER SESSION LOST TWO FULL 21-CHARACTER RUNS TO EXACTLY THIS (2026-09-11): it restarted all
// 21 keepers, ran, failed, and only then found the broker still on old code. So the boundary is
// a line in this header rather than a thing to rediscover -- and it is why a pad's only output
// is steps[]. The narrower the pad's reach, the more of the reload story is actually true.
//
// AND DEADLOCK IS MADE IMPOSSIBLE RATHER THAN DISCOURAGED. Taking more characters mid-session
// is a NON-BLOCKING try-lock that fails immediately naming the holder. Nothing here ever waits
// for a lock, so there is no hold-and-wait, so there is no cycle -- which is a better answer
// than asking an agent to notice a deadlock, because judging one from inside is the thing
// agents are worst at. The operator's guidance, and it is right: do not ask for anything that
// is not already available.
import { createInterface } from 'node:readline';
import { watch, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fleetScript, formatGuarantees, observe, pack } from './m59-fleetscript.mjs';
import { loadFleetScripts, applyDefaults, checkParams, asAgents,
         auditUnsafe, formatUnsafeAudit } from './m59-fleetlib.mjs';
import { fleetName } from './m59-fleetpath.mjs';
import { isCheckpoint, reach, formatReach } from './m59-establish.mjs';
import { planSlice, formatSlice, marksOf } from './m59-resume.mjs';
import { recordRun, promote, promotionBlockers, formatBlockers,
         formatPromotion, evidenceFor } from './m59-promote.mjs';
import { readBoard, isPosted, formatBoard, checkBoard } from './m59-board.mjs';
import { readIntents, nearby, formatNearby, claim, writeIntents, sweep } from './m59-intent.mjs';
// The declaration machinery lives in its own module so that a PAD can import the helpers without
// closing a cycle through this one -- see the header of m59-padcheck.mjs for what that cost.
import { preflight, formatPreflight, checkDeclaredAbilities,
         actHazards, formatActHazards, declarationsOf,
         consultCorpus, formatConsults,
         worldReader, brokerReachingSteps, formatBrokerReach } from './m59-padcheck.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
export const PAD_DIR = process.env.M59_FLEETSCRATCH_DIR ||
  join(REPO, 'substrate', 'fleetscratch');

// ------------------------------------------------------------------ the pads on disk
export async function loadPads({ dir = PAD_DIR } = {}) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const { scripts, problems } = await loadFleetScripts({ dirs: [['pad', dir]] });
  // The ability-name check is a LOAD-time problem, for the same reason a malformed waiver is:
  // a misspelling that reports the whole fleet ineligible must surface on `list`, not in the
  // middle of deciding whether the fleet is capable of an errand.
  const pads = new Map();
  for (const [name, pad] of scripts) {
    const bad = checkDeclaredAbilities(pad);
    if (bad.length) { problems.push({ file: pad.file, why: bad.join('; ') }); continue; }
    pads.set(name, pad);
  }
  return { pads, problems };
}

// ------------------------------------------------------------------ the session
// Only run as a session when invoked directly; the exports above are for the tests and for
// whatever promotes a pad later.
// Compared as URLs, not by name: a test imports this module and must get the exports without
// a prompt opening on its stdin, and matching on the basename would have made
// m59-fleetscratch-test.mjs a near miss rather than a clean one.
const invokedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
// AND THE SESSION IS A FUNCTION, NOT A TOP-LEVEL AWAIT. Splitting the helpers out removes the one
// cycle we know about; this removes the silent-hang FAILURE MODE for the ones we do not. With no
// top-level await anywhere in this module's graph, a future accidental cycle surfaces as a real
// error instead of an exit 0 with an empty stdout.
async function main() {
  const FLEET = fleetName();

  // SOMEBODY HAS TO BE WATCHING. Refused rather than downgraded: a pad's freedom to take more
  // characters mid-session is only safe with a person or a working agent present, so a keeper
  // or a cron job that spawns this gets a refusal it cannot mistake for success.
  if (!process.stdin.isTTY && !process.env.M59_SCRATCH_OPERATOR) {
    console.error(
      'm59-fleetscratch: refusing to run without an operator.\n' +
      '  A pad may take more characters mid-session, and that is only safe while somebody is\n' +
      '  watching for a contention refusal. Nothing automated may drive a pad: not a keeper,\n' +
      '  not a DUM bot, not cron, not the harness.\n' +
      '  Interactively this just works. For a piped session, set M59_SCRATCH_OPERATOR=<who>\n' +
      '  and own the consequence.');
    process.exit(3);
  }

  let { pads, problems } = await loadPads();
  const say = (...a) => console.log(...a);

  const listPads = () => {
    for (const p of pads.values()) {
      const marks = [p.lab ? 'LAB' : null,
                     typeof p.setup === 'function' ? 'setup' : null].filter(Boolean);
      const tiers = ['requires', 'capabilities', 'suggests']
        .map(t => [t, [].concat(p[t] ?? []).length]).filter(([, n]) => n)
        .map(([t, n]) => `${n} ${t}`).join(', ');
      say(`  ${p.name.padEnd(20)} ${p.describe ?? ''}` +
          `${marks.length ? `   <${marks.join(' ')}>` : ''}${tiers ? `   [${tiers}]` : ''}`);
    }
    if (!pads.size) say(`  (no pads — put a .mjs in ${PAD_DIR})`);
    for (const p of problems) say(`  ${p.file}: ${p.why}`);
  };

  function parseArgs(rest) {
    const out = {};
    for (const tok of rest) {
      const at = tok.indexOf('=');
      if (at < 0) { out._ = [...(out._ ?? []), tok]; continue; }
      out[tok.slice(0, at)] = tok.slice(at + 1);
    }
    return out;
  }

  // ONE PLACE THAT CALLS steps(), so sync and async pads cannot diverge again.
  const stepsOf = async (pad, params, agents) => {
    try {
      return [].concat(await Promise.resolve(
        pad.steps({ ...params, agent: agents[0], agents })) ?? []);
    } catch (e) {
      say(`steps() threw: ${e.message}`);
      return [];
    }
  };

  // Resolve a pad and its parameters once, for check/dry/go alike.
  //
  // THE BOARD IS A GATE ON RUNNING, NOT ON LOOKING. `list` and `describe` work on an unpinned pad
  // — you have to be able to read the thing before you can sensibly pin it — and `check` and `dry`
  // do too, because both send nothing and refusing them would just make people pin blind. `go` is
  // where it bites, because `go` is where the fleet moves.
  async function resolve(rest, { mustBePosted = false } = {}) {
    const name = rest[0];
    const pad = pads.get(name);
    if (!pad) return { why: `no pad named "${name ?? ''}" — try: list` };
    if (mustBePosted) {
      const posted = isPosted(readBoard(FLEET), name);
      if (!posted.ok) return { why: posted.why };
    }
    const params = applyDefaults(pad, parseArgs(rest.slice(1)));
    const bad = checkParams(pad, params);
    if (bad.length) return { why: `bad parameters:\n  ${bad.join('\n  ')}` };
    const agents = asAgents(params.agents);
    if (!agents.length) return { why: 'no agents — this is a pad, it needs somebody to drive' };
    return { pad, params, agents };
  }

  say(`fleetscratch — fleet "${FLEET}"`);
  say(`  pads ${PAD_DIR}`);
  say('');
  say('pads:');
  listPads();
  // WHICH OF THESE MAY ACTUALLY RUN. Finding out at `go` is finding out late — and the board is
  // also where another session's note to you is sitting, which is worth seeing before you start
  // rather than after you have repeated their afternoon.
  {
    const b = readBoard(FLEET);
    const pinned = new Set((b.pads ?? []).map(p => p.name));
    const unpinned = [...pads.keys()].filter(n => !pinned.has(n));
    if (b.pads === null) say(`  board: ${b.why}`);
    else if (unpinned.length)
      say(`  not on the board, so \`go\` will refuse: ${unpinned.join(', ')}`);
    const c = b.pads ? checkBoard(b) : { stale: [], collisions: [], unanswered: [] };
    for (const x of c.collisions)
      say(`  COLLISION on the board: ${x.agent} is claimed by ${x.names.join(' and ')}`);
    if (c.stale.length) say(`  ${c.stale.length} pad(s) on the board are 21+ days old — promote or strike`);
    for (const p of c.unanswered)
      for (const n of p.notes ?? []) say(`  note on ${p.name} · ${n.by}: ${n.text}`);
  }
  // AND WHO ELSE IS NEAR WHAT IS ALREADY HERE. A pad author arriving at a session should learn
  // about a neighbour before starting, not after repeating their afternoon.
  {
    const doc = readIntents();
    const me = process.env.M59_SCRATCH_OPERATOR || `fleetscratch session (pid ${process.pid})`;
    const topic = [...pads.keys()].join(' ') || 'scratchpads';
    const near = nearby(doc, topic);
    const others = (near.hits ?? []).filter(h => h.by !== me && h.state === 'live');
    for (const h of others)
      say(`  someone else is nearby: ${h.by} — ${h.topic}  (${h.matchedBy})`);
  }
  say('');
  say('commands: list | board | nearby <topic> | intend <topic> | reload | watch on|off |');
  say('          describe <pad> | check <pad> k=v… | dry <pad> k=v… | go <pad> k=v… |');
  say('          promote <pad> | guarantees | unsafe | quit');
  say('  on dry/go:  skipTo=<mark|n>   runUntil=<mark|n>   — a skip must be covered by a checkpoint');

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });

  // ONE COMMAND AT A TIME, AND `quit` WAITS ITS TURN. Copied from m59-fleet-repl.mjs with its
  // reason, because the reason applies identically here: readline fires 'line' as input
  // arrives, not as work finishes, so an async handler lets two commands run at once and the
  // second is usually `quit`, whose exit kills the first mid-errand -- abandoning characters
  // marked busy, which is the leak that left six of them stuck "driven".
  let chain = Promise.resolve();
  let closing = false;
  const queue = fn => { chain = chain.then(fn, fn); return chain; };

  // ------------------------------------------------------ the watcher: RENDER, NEVER RUN
  //
  // A watcher that ran the pad on save would be the worst tool in this repository. An editor's
  // autosave, or a formatter on write, would drive twenty-one live characters on a file the
  // author had not finished typing. So a save re-compiles and shows what CHANGED, and running
  // stays an explicit `go` -- the same "say what it would do and stop" default m59-restore and
  // the DUM planner keep, for the same reason.
  let watcher = null;
  let lastShape = new Map();          // pad name -> rendered steps, to diff against
  const shapeOf = async (pad) => {
    try {
      const steps = await Promise.resolve(
        pad.steps({ ...applyDefaults(pad, {}), agent: '<agent>', agents: [] }));
      return [].concat(steps ?? []).map(renderStep).join('\n');
    } catch (e) { return `(steps() threw: ${e.message})`; }
  };
  const onSave = () => queue(async () => {
    const before = new Map(pads);
    ({ pads, problems } = await loadPads());
    const lines = [];
    for (const [name, pad] of pads) {
      const shape = await shapeOf(pad);
      if (lastShape.get(name) !== shape) {
        lines.push(`  ${name}:`);
        for (const l of shape.split('\n')) lines.push(`    ${l}`);
        lastShape.set(name, shape);
      }
    }
    for (const name of before.keys()) if (!pads.has(name)) lines.push(`  ${name}: gone`);
    for (const p of problems) lines.push(`  ${p.file}: ${p.why}`);
    if (lines.length) {
      say(`\n[saved — recompiled, nothing sent]`);
      for (const l of lines) say(l);
      if (!closing) rl.prompt();
    }
  });

  const renderStep = (step) =>
    // NAME THE act VERB. `act` rendered as the bare word "act" told the author nothing about
    // which tool was about to be called, which is the one thing that matters about an act step.
    `${step.do === 'act' ? `act('${step.tool}')` : step.do}` +
    `${step.to != null ? ` -> room ${step.to}` : ''}` +
    `${step.seller ? ` at ${step.seller}` : ''}` +
    `${step.merchant ? ` at ${step.merchant}` : ''}` +
    `${step.teacher ? ` from ${step.teacher}` : ''}` +
    `${step.ability ? ` ${step.ability}` : ''}` +
    `${step.action ? ` ${step.action} ${step.amount}` : ''}` +
    `${step.text ? ` "${step.text}"` : ''}` +
    `${step.col != null ? ` -> r${step.row}c${step.col}` : ''}` +
    `${step.lines ? ` [${step.lines.map(l => `${l.match} x${l.amount}`).join(', ')}]` : ''}` +
    `${step.why ? `   (${step.why})` : ''}`;

  rl.on('line', (line) => queue(async () => {
    const [verb, ...rest] = line.trim().split(/\s+/).filter(Boolean);
    try {
      if (!verb) { /* blank */ }
      else if (verb === 'quit' || verb === 'exit') { rl.close(); return; }
      else if (verb === 'list') listPads();
      else if (verb === 'reload') {
        ({ pads, problems } = await loadPads());
        say(`reloaded — ${pads.size} pad(s)`);
        for (const p of problems) say(`  ${p.file}: ${p.why}`);
      }
      else if (verb === 'watch') {
        const on = rest[0] !== 'off';
        if (watcher) { watcher.close(); watcher = null; }
        if (on) {
          for (const [name, pad] of pads) lastShape.set(name, await shapeOf(pad));
          // Debounced: an editor writes a file more than once per save, and recursive is off
          // because a pad is one file and a pad's notes are not worth recompiling for.
          let timer = null;
          watcher = watch(PAD_DIR, () => {
            clearTimeout(timer); timer = setTimeout(onSave, 120);
          });
          say(`watching ${PAD_DIR} — a save re-compiles and shows the change. It does NOT run.`);
        } else say('not watching');
      }
      else if (verb === 'board') say(formatBoard(readBoard(FLEET)));
      // WHO ELSE IS IN THIS. Asked before you build, answered from the registry rather than from
      // whoever happens to be talking to you — which is how the last collision was found.
      else if (verb === 'nearby') {
        const topic = rest.join(' ');
        if (!topic) say('nearby <what you are about to work on>');
        else say(formatNearby(nearby(readIntents(), topic), topic));
      }
      else if (verb === 'intend') {
        const topic = rest.filter(r => !r.startsWith('--')).join(' ');
        const who = process.env.M59_SCRATCH_OPERATOR || `fleetscratch session (pid ${process.pid})`;
        if (!topic) say('intend <what you are about to work on>');
        else {
          const swept = sweep(readIntents());
          // THE SESSION IS THE ONE CALLER THAT CAN OFFER A PID: it is still sitting here. A
          // claim bound this way dies when the session does, so quitting retires it without
          // anyone having to remember to `release`.
          const doc = claim(swept.doc, { topic, by: who, why: `pads in ${PAD_DIR}`,
                                         pid: process.pid });
          writeIntents(doc);
          say(`claimed "${topic}" as ${who}`);
          const near = nearby(doc, topic);
          const others = { ...near, hits: near.hits.filter(h => h.by !== who) };
          others.live = others.hits.filter(h => h.state === 'live');
          if (others.hits.length) say(formatNearby(others, topic));
        }
      }
      // ScratchToScript(). `check` half is free and says what is in the way; the write half
      // generates, RE-LOADS what it generated, and only then leaves a file behind.
      else if (verb === 'promote') {
        const r = await resolve(rest);
        if (r.why) { say(r.why); }
        else {
          const steps = await stepsOf(r.pad, r.params, r.agents);
          const dryRun = r.params.write !== '1' && r.params.write !== true;
          if (dryRun) {
            const res = promotionBlockers(r.pad, {
              source: r.pad.file && existsSync(r.pad.file) ? readFileSync(r.pad.file, 'utf8') : '',
              steps });
            say(formatBlockers(res, r.pad));
            if (res.ok) say(`  \`promote ${r.pad.name} write=1\` to generate it.`);
          } else {
            // THE VERIFICATION USES THE REAL LOADER. Anything less proves nothing: the failure
            // it catches is a helper that lived in the pad's module scope, and only an actual
            // import of the generated file finds that.
            const res = await promote(r.pad, {
              steps, render: renderStep,
              load: async (path) => {
                try {
                  const { scripts, problems } = await loadFleetScripts({
                    dirs: [['promoted', dirname(path)]], only: [basename(path, '.mjs')] });
                  // BY NAME, not "the first one". The staging file lives in the errand
                  // directory (it has to — its imports only resolve from there), so this load
                  // returns every committed fleetscript alongside it.
                  const got = scripts.get(r.pad.name);
                  if (!got) return { error: problems.map(x => x.why).join('; ') || 'it loaded nothing' };
                  return { steps: await Promise.resolve(
                    got.steps({ ...r.params, agent: r.agents[0], agents: r.agents })) };
                } catch (e) { return { error: e.message }; }
              },
            });
            say(formatPromotion(res, r.pad));
          }
        }
      }
      else if (verb === 'guarantees') say(formatGuarantees());
      else if (verb === 'unsafe') say(formatUnsafeAudit(auditUnsafe(pads), { total: pads.size }));
      else if (verb === 'describe') {
        const pad = pads.get(rest[0]);
        if (!pad) { say(`no pad named "${rest[0] ?? ''}"`); }
        else {
          say(`${pad.name} — ${pad.describe ?? ''}`);
          say(`  file ${pad.file}`);
          if (pad.unsafe)
            say(`  UNSAFE waives ${(pad.unsafe.waives ?? []).join(', ')} — ${pad.unsafe.reason}`);
          for (const [k, spec] of Object.entries(pad.params ?? {}))
            say(`  ${k.padEnd(12)} ${spec.required ? 'REQUIRED' : `default ${JSON.stringify(spec.default)}`}` +
                `  ${spec.describe ?? ''}`);
          // Say what this pad does to the WORLD before listing what it needs — a reader
          // deciding whether to run something wants "it reconfigures the lab" first.
          const phases = ['setup', 'teardown']
            .filter(k => [].concat(pad[k] ?? []).filter(Boolean).length);
          for (const st of [].concat(pad.setup ?? []).filter(isCheckpoint))
            say(`  checkpoint   ${st.name}  — reachable by ${st.ways.join(', ')}`);
          if (pad.lab) say(`  LAB ONLY — declares REQUIRES: LOCALADMIN`);
          if (phases.length) say(`  phases      ${phases.join(', ')} (run around the steps, not as steps)`);
          if (pad.consults) say(`  consults    ${[].concat(pad.consults).join(', ')}`);
          for (const tier of ['requires', 'capabilities', 'suggests'])
            for (const e of [].concat(declarationsOf(pad)[tier] ?? []))
              say(`  ${tier.padEnd(12)} ${e.what}${e.why ? ` — ${e.why}` : ''}`);
          if (pad.notes) for (const n of [].concat(pad.notes)) say(`  note: ${n}`);
        }
      }
      else if (verb === 'check') {
        const r = await resolve(rest);
        if (r.why) { say(r.why); }
        else {
          say(`${r.pad.name}: ${r.agents.length} agent(s) — ${r.agents.join(', ')}`);
          const cps = [].concat(r.pad.setup ?? []).filter(isCheckpoint);
          say(formatPreflight(preflight(r.pad, r.agents),
                              { agents: r.agents, checkpoints: cps.length,
                                all: r.params.all === '1' || r.params.all === true }));
          for (const cp of cps)
            say(`  checkpoint   ${cp.name}  — reachable by ${cp.ways.join(', ')}`);
          // The hazards are about the VERBS the pad uses, so they are asked of the compiled
          // steps rather than of the characters -- one render, not one per agent.
          // `steps()` MAY BE SYNCHRONOUS. A fleetscript's steps may return an array directly --
          // several committed ones do -- and calling `.catch` on that array threw
          // "r.pad.steps(...).catch is not a function" AFTER the check had already printed, so
          // the useful output was followed by an error that looked like the check failing.
          // Promise.resolve normalises both. Found 2026-09-11 by the peer session.
          const steps = await stepsOf(r.pad, r.params, r.agents);
          const haz = formatActHazards(actHazards(steps));
          if (haz) { say(''); say(haz); }
          const reach = formatBrokerReach(brokerReachingSteps(steps));
          if (reach) { say(''); say(reach); }
          // ASK THE CORPUS LAST, so it reads as the next thing to do rather than a preamble.
          const corpus = formatConsults(consultCorpus(r.pad));
          if (corpus) { say(''); say(corpus); }
        }
      }
      else if (verb === 'dry') {
        const r = await resolve(rest);
        if (r.why) { say(r.why); }
        else {
          const steps = await stepsOf(r.pad, r.params, r.agents);
          say(`${r.pad.name}: ${r.agents.length} agent(s) — ${r.agents.join(', ')}`);
          // THE SLICE IS SHOWN, NOT APPLIED. `dry` prints the whole errand with the omitted
          // steps struck through, because the question a skip raises is "what am I not doing",
          // and a list that simply starts at step 9 cannot answer it.
          const plan = planSlice(steps, { skipTo: r.params.skipTo, runUntil: r.params.runUntil,
                                          setup: r.pad.setup });
          for (const [i, step] of [].concat(steps ?? []).entries()) {
            const inRun = !plan.ok || (i >= plan.from && i < plan.to);
            const mark = step?.mark ? `  <${step.mark}>` : '';
            say(`  ${inRun ? ' ' : '~'}${i}. ${renderStep(step)}${mark}`);
          }
          if (!plan.ok) say(`  ${formatSlice(plan)}`);
          else {
            const sl = formatSlice(plan, { render: renderStep, name: `"${r.pad.name}"` });
            if (sl) say(sl);
          }
          say('  (nothing was sent)');
          const haz = formatActHazards(actHazards(plan.ok ? plan.steps : steps));
          if (haz) say(haz);
        }
      }
      else if (verb === 'go') {
        const r = await resolve(rest, { mustBePosted: true });
        if (r.why) { say(r.why); }
        else {
          // THE PREFLIGHT IS NOT ADVISORY FOR A REQUIREMENT. An unmet requirement is the case
          // whose failure mode is an infinite loop achieving nothing, so it refuses here and
          // names itself. Unknown never refuses -- see the note on the three outcomes.
          const rows = preflight(r.pad, r.agents);
          const refused = [...new Set(rows.filter(x => x.refuse).map(x => x.agent))];
          if (refused.length) {
            say(formatPreflight(rows, { agents: r.agents }));
            say(`refusing: ${refused.join(', ')} do not meet a REQUIREMENT of this pad.`);
            say(`  Drop them from agents=, or fix the pad's declaration if it is wrong.`);
          } else {
            const unknown = rows.filter(x => x.verdict === 'unknown').length;
            if (unknown) say(`note: ${unknown} check(s) unknown — running anyway, as asked.`);
            // THE SKIP IS JUDGED BEFORE SETUP RUNS, not inside the steps closure.
            //
            // fleetScript calls steps(agent) once per character, so a refusal raised in there
            // would surface after the bodies were held and the setup had already forced the
            // world — the most expensive possible moment to learn that the skip was not allowed.
            // So the slice is planned once up front, against the first agent's compiled steps.
            //
            // AND ONLY WHEN A SLICE WAS ASKED FOR. Probing unconditionally compiled steps()
            // before setup for every pad, which broke a setup-only pad outright (an empty list
            // read as "nothing to run" and the errand was refused before its setup had a chance)
            // and reordered steps() ahead of the setup it may depend on. Compiling early is a
            // cost the author opted into by typing skipTo=; nobody else should pay it.
            const slicing = !!(r.params.skipTo || r.params.runUntil);
            let plan = { ok: true, partial: false, from: 0, to: null, all: [] };
            if (slicing) {
              const probe = await stepsOf(r.pad, r.params, r.agents);
              plan = planSlice(probe, { skipTo: r.params.skipTo, runUntil: r.params.runUntil,
                                        setup: r.pad.setup });
              if (!plan.ok) { say(formatSlice(plan)); if (!closing) rl.prompt(); return; }
              const sl = formatSlice(plan, { render: renderStep, name: `"${r.pad.name}"` });
              if (sl) say(sl);
            }
            // SETUP, ERRAND, TEARDOWN -- and teardown runs whatever happened.
            //
            // `setup` is NOT a step and must not become one. A pad's steps[] go to the broker;
            // setup configures the world over the DM socket, which is a different socket with a
            // different authority. Smuggling it into steps() would also break the one rule that
            // makes a pad safe to LIST: steps is a pure function of its parameters and does no
            // work, so that merely enumerating the pads cannot drive anything.
            //
            // Teardown is in a finally for the same reason fleetScript frees a held body in one:
            // the failure that leaves a lab wedged is the one where the errand threw. A teardown
            // that throws is reported and swallowed -- it must not mask the errand's own error,
            // which is the thing the author actually needs to read.
            // A PREDICATE HAS TO BE ABLE TO LOOK. `read` is the allowlisted world reader and
            // `observe`/`pack` are the compiler's own helpers, so a checkpoint asking "is he in
            // room 49, whole" uses the same code the steps do rather than a JSON-RPC helper it
            // carried itself. See worldReader in m59-padcheck.mjs for why this is not `call`.
            const ctx = { agents: r.agents, params: r.params, pad: r.pad, say,
                          read: worldReader(), observe, pack };
            let setupOk = true;
            // SETUP IS EITHER A PROCEDURE OR A CHECKPOINT, and the checkpoint is the better one.
            //
            // A plain `setup(ctx)` is a list of things to do. A `checkpoint()` is the STATE you
            // want plus one or more ways to get there -- DM-forced, played out, or a captured
            // scene rebuilt -- and `reach()` asks `holds` first (so it runs nothing when the world
            // is already right) and asks AGAIN afterwards (so a shortcut that silently landed
            // somewhere else is caught). The operator's framing: forcing a configuration and
            // playing your way into it are two routes to the same place, and the shared predicate
            // is the only thing that makes the fast one evidence about the slow one.
            const setups = [].concat(r.pad.setup ?? []).filter(Boolean);
            for (const st of setups) {
              if (!setupOk) break;
              if (isCheckpoint(st)) {
                say(`setup: reaching "${st.name}"${r.pad.lab ? ' [lab]' : ''}`);
                const got = await reach(st, ctx, { prefer: r.params.via ?? null,
                                                   allowUnknown: r.params.allowUnknown === '1' });
                say(formatReach(got));
                if (!got.ok) setupOk = false;
              } else if (typeof st === 'function') {
                say(`setup: ${r.pad.name}${r.pad.lab ? ' [lab]' : ''}`);
                try { await st(ctx); }
                catch (e) { setupOk = false; say(`setup FAILED: ${e.message}`); }
              } else {
                setupOk = false;
                say(`setup FAILED: a pad's setup must be a function or a checkpoint(), got ` +
                    `${typeof st}. A scene name on its own is not a setup — wrap it in a ` +
                    `checkpoint so there is something to verify it landed.`);
              }
            }
            if (!setupOk) {
              say('refusing to run the errand: its setup did not finish, so the world is not ' +
                  'in the state the pad was written against.');
            } else {
              try {
                const res = await fleetScript({
                  name: `${r.pad.name} (pad)`,
                  agents: r.agents,
                  // SLICED PER AGENT, because steps() is a function of the character and two
                  // characters can compile different lists. Re-planning here rather than reusing
                  // the probe means a mark resolves against the list this body will actually
                  // run; the probe above is what decides whether the skip is ALLOWED at all.
                  steps: async (agent) => {
                    const mine = [].concat(await Promise.resolve(
                      r.pad.steps({ ...r.params, agent, agents: r.agents })) ?? []);
                    if (!slicing) return mine;
                    const p = planSlice(mine, { skipTo: r.params.skipTo,
                                                runUntil: r.params.runUntil, setup: r.pad.setup });
                    if (!p.ok) throw new Error(`${agent}: ${p.why}`);
                    return p.steps;
                  },
                  minHealth: r.params.minHealth,
                  unsafe: r.pad.unsafe ?? null,
                  provenance: r.pad.provenance ?? null,
                });
                if (res && res.ok === false && res.why) say(res.why);
                // WRITTEN DOWN AT THE MOMENT IT HAPPENED, and marked partial when it was.
                // m59-promote.mjs will not promote on the strength of a sliced run, so the
                // slice has to travel with the record rather than be reconstructed from a log.
                recordRun({
                  pad: r.pad.name, fleet: FLEET, agents: r.agents,
                  ok: !(res && res.ok === false),
                  partial: plan.partial, from: plan.from,
                  to: plan.to ?? plan.all.length, of: plan.all.length,
                  params: Object.fromEntries(Object.entries(r.params)
                    .filter(([k]) => k !== 'agents').map(([k, v]) => [k, String(v)])),
                  by: process.env.M59_SCRATCH_OPERATOR || `session (pid ${process.pid})`,
                });
              } finally {
                for (const td of [].concat(r.pad.teardown ?? []).filter(Boolean)) {
                  if (typeof td !== 'function') continue;
                  say(`teardown: ${r.pad.name}`);
                  try { await td(ctx); }
                  catch (e) { say(`teardown failed (the errand's own result stands): ${e.message}`); }
                }
              }
            }
          }
        }
      }
      else say(`unknown command "${verb}" — try: list`);
    } catch (e) {
      say(`error: ${e.message}`);
    }
    if (!closing) rl.prompt();
  }));

  rl.on('close', () => {
    closing = true;
    if (watcher) { watcher.close(); watcher = null; }
    // NO process.exit. Same libuv assertion m59-fleet-repl.mjs documents: exiting from inside a
    // promise continuation while readline is releasing stdin trips
    // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)". Set a code and let the loop
    // drain -- the queue above has already waited for any running pad to finish, and
    // fleetScript frees every body it held in its own finally.
    queue(async () => { say('bye'); process.exitCode = 0; });
  });

  rl.prompt();
}

if (invokedDirectly) {
  main().catch((e) => {
    console.error(`m59-fleetscratch: ${e?.stack ?? e?.message ?? e}`);
    process.exitCode = 1;
  });
}
