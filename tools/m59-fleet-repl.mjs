#!/usr/bin/env node
// COMMAND THE FLEET BY NAME, ONE LINE AT A TIME.
//
//   node tools/m59-fleet-repl.mjs
//
//   > list
//   > describe resupply
//   > resupply agents=t16,t17 each=200
//   > come-home agents=t3 home=39
//   > dry resupply agents=t16          # print the compiled steps, send nothing
//
// WHY A REPL AND NOT A FLAG ON EVERY TOOL. The errands an operator actually wants are
// composed on the spot — "these three, to the shop, then home" — and the alternative is
// writing a script each time. Five of those written in one afternoon each re-implemented the
// same safeties and each got a different one wrong, which is what m59-fleetscript.mjs exists
// to end. This is that compiler behind a prompt.
//
// EVERY LINE STILL GOES THROUGH THE COMPILER. There is no raw-command escape hatch here, on
// purpose: a REPL that could send an unguarded `travel` would be the sixth ad-hoc script,
// with a nicer interface. What you get is the named scripts, with the run lock, the body
// held, the health floor, the p90 budgets and the read-back verification already around them.
//
// `dry` prints what would run. It resolves parameters, loads the script and renders its
// steps WITHOUT taking the lock or touching the fleet — the "say what it would do and stop"
// contract m59-restore and the DUM planner both keep, and the right default habit when the
// thing on the other end is twenty-one live characters on a shared server.
import { createInterface } from 'node:readline';
import { fleetScript } from './m59-fleetscript.mjs';
import { loadFleetScripts, runNamed, applyDefaults, checkParams, asAgents,
         PUBLIC_DIR, LOCAL_DIR } from './m59-fleetlib.mjs';
import { fleetName } from './m59-fleetpath.mjs';

const FLEET = fleetName();
let { scripts, problems } = await loadFleetScripts();

const say = (...a) => console.log(...a);
const listScripts = () => {
  for (const s of scripts.values())
    say(`  ${s.name.padEnd(16)} ${s.source.padEnd(7)} ${s.describe ?? ''}` +
        (s.overrides ? '   (overrides the committed one)' : ''));
  if (!scripts.size) say('  (none — put a .mjs in tools/fleetscripts or substrate/fleetscripts)');
};

// key=value, with everything after the name. Quoting is deliberately not supported: a value
// that needs quotes wants a script, not a prompt.
function parseArgs(rest) {
  const out = {};
  for (const tok of rest) {
    const at = tok.indexOf('=');
    if (at < 0) { out._ = [...(out._ ?? []), tok]; continue; }
    out[tok.slice(0, at)] = tok.slice(at + 1);
  }
  return out;
}

say(`fleet REPL — fleet "${FLEET}"`);
say(`  public ${PUBLIC_DIR}`);
say(`  local  ${LOCAL_DIR}`);
if (problems.length) {
  say('scripts that would not load:');
  for (const p of problems) say(`  ${p.file}: ${p.why}`);
}
say('');
say('scripts:');
listScripts();
say('');
say('commands: list | reload | describe <name> | dry <name> k=v… | <name> k=v… | quit');

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
rl.prompt();

// ONE COMMAND AT A TIME, AND `quit` WAITS ITS TURN.
//
// readline fires 'line' as input arrives, not as work finishes, so an async handler means
// two commands can be in flight at once — and the second is usually `quit`, whose
// process.exit kills the first mid-errand. Piped input showed it immediately (the steps of a
// `dry` never printed because exit won the race), but the interactive case is worse: typing
// quit while a script is walking would abandon characters marked `busy`, which is the exact
// leak that left six of them stuck "driven" earlier today.
//
// So lines are queued and drained in order, and `close` awaits the queue before exiting.
let chain = Promise.resolve();
let closing = false;
const queue = fn => { chain = chain.then(fn, fn); return chain; };

rl.on('line', (line) => queue(async () => {
  const [verb, ...rest] = line.trim().split(/\s+/).filter(Boolean);
  try {
    if (!verb) { /* blank */ }
    else if (verb === 'quit' || verb === 'exit') { rl.close(); return; }
    else if (verb === 'list') listScripts();
    else if (verb === 'reload') {
      ({ scripts, problems } = await loadFleetScripts());
      say(`reloaded — ${scripts.size} script(s)`);
      for (const p of problems) say(`  ${p.file}: ${p.why}`);
    }
    else if (verb === 'describe') {
      const s = scripts.get(rest[0]);
      if (!s) say(`no script named "${rest[0] ?? ''}"`);
      else {
        say(`${s.name} (${s.source}) — ${s.describe ?? ''}`);
        say(`  file ${s.file}`);
        for (const [k, spec] of Object.entries(s.params ?? {}))
          say(`  ${k.padEnd(12)} ${spec.required ? 'REQUIRED' : `default ${JSON.stringify(spec.default)}`}` +
              `  ${spec.describe ?? ''}`);
      }
    }
    else if (verb === 'dry') {
      const name = rest[0];
      const s = scripts.get(name);
      if (!s) { say(`no script named "${name ?? ''}"`); }
      else {
        const params = applyDefaults(s, parseArgs(rest.slice(1)));
        const bad = checkParams(s, params);
        if (bad.length) say('bad parameters:\n  ' + bad.join('\n  '));
        else {
          const agents = asAgents(params.agents);
          say(`${name}: ${agents.length} agent(s) — ${agents.join(', ')}`);
          // One agent's steps are enough to show the shape; they differ only in the numbers
          // each computes for itself, and rendering twenty-one copies helps nobody.
          const steps = await s.steps({ ...params, agent: agents[0], agents });
          for (const [i, step] of steps.entries())
            say(`  ${i}. ${step.do}${step.to != null ? ` -> room ${step.to}` : ''}` +
                `${step.seller ? ` at ${step.seller}` : ''}` +
                `${step.action ? ` ${step.action} ${step.amount}` : ''}` +
                `${step.lines ? ` [${step.lines.map(l => `${l.match} x${l.amount}`).join(', ')}]` : ''}`);
          say('  (nothing was sent)');
        }
      }
    }
    else if (scripts.has(verb)) {
      const r = await runNamed(verb, parseArgs(rest), { scripts, fleetScript, onLog: say });
      if (!r.ok && r.why) say(r.why);
    }
    else say(`unknown command "${verb}" — try: list`);
  } catch (e) {
    say(`error: ${e.message}`);
  }
  if (!closing) rl.prompt();
}));

rl.on('close', () => {
  closing = true;
  // Whatever is running finishes first. fleetScript frees every body it holds in its own
  // finally, so letting it finish is what keeps a Ctrl-D from stranding a character.
  // setImmediate, not a bare exit: calling process.exit from inside a promise continuation
  // while readline is still tearing its handles down trips libuv
  // ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"). Letting the loop turn once
  // lets those handles finish closing, and a REPL that crashes on quit teaches an operator
  // to distrust the tool.
  // NO process.exit AT ALL. Calling it while readline is tearing its handles down trips
  // libuv ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"), and a setImmediate was
  // not enough — the race is with the stdin handle, not the tick. Setting an exit CODE and
  // letting the loop drain exits cleanly once readline has released stdin, which is what we
  // actually want: the queue above has already waited for any running script to finish.
  queue(async () => { say('bye'); process.exitCode = 0; });
});
