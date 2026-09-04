#!/usr/bin/env node
// THE RESUPPLY ERRAND, FROM A COMMAND LINE.
//
//   node tools/m59-resupply.mjs --couriers <agent>,<agent>,<agent> --each 120
//   node tools/m59-resupply.mjs --couriers <agent> --dry
//
// ONE DEFINITION, TWO FRONT DOORS. This used to carry its own copy of the steps, and the
// REPL loaded a different copy from tools/fleetscripts/resupply.mjs. They drifted within the
// hour: the library copy learned to route by cargo (m59-smartloot — sell weapons at the
// Barloque smith, vault on the same trip, skip the leg entirely when the pack is only
// reagents) and this one did not, so the same command through two doors sent a character to
// two different towns. Running it produced a courier walking to the bank carrying twenty-two
// swords it had no intention of selling.
//
// That is the same mistake as the duplicated travel loop inside m59-reagents, found the same
// day: a fix lands in one copy and the other keeps the bug. So this file is a FRONT DOOR and
// nothing else — it parses a command line and hands off to the named script.
import { fleetScript } from './m59-fleetscript.mjs';
import { loadFleetScripts, runNamed, applyDefaults, checkParams, asAgents } from './m59-fleetlib.mjs';

const argv = process.argv.slice(2);
// NO `= null` DEFAULT HERE, AND THAT IS THE WHOLE BUG THIS COMMENT EXISTS FOR.
//
// A default parameter fires on an explicitly passed `undefined`, so `arg('home', undefined)`
// returned NULL rather than undefined. The cleanup below drops `=== undefined`, null survived
// it, and `applyDefaults` only fills keys that are undefined — so `home` reached the script as
// null and the errand compiled a final step of "walk to null". On 2026-09-03 that stranded a
// courier at Frisconar's counter with 120 elderberry and 120 herbs it had just bought and no
// way home, after a run that had already cost a death and a bank refusal.
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };

const params = {
  agents: arg('couriers', arg('agents', '')),
  each: arg('each', undefined),
  home: arg('home', undefined),
  alwaysVault: argv.includes('--always-vault') ? true : undefined,
  // --buy-only: no smith, no vault, no Barloque. A Tos round trip for reagents alone.
  buyOnly: argv.includes('--buy-only') ? true : undefined,
};
// Null as well as undefined: "the operator did not say" must reach applyDefaults as an
// ABSENCE, or the script's own default never gets a chance to answer.
for (const k of Object.keys(params)) if (params[k] == null) delete params[k];

const { scripts, problems } = await loadFleetScripts();
for (const p of problems) console.error(`script would not load: ${p.file}: ${p.why}`);

const script = scripts.get('resupply');
if (!script) { console.error('no `resupply` script found in tools/fleetscripts or substrate/fleetscripts'); process.exit(2); }

if (!asAgents(params.agents).length) {
  console.error('usage: node tools/m59-resupply.mjs --couriers <agent>,<agent> [--each 120] [--buy-only] [--dry]');
  console.error(`  ${script.describe ?? ''}`);
  process.exit(2);
}

// SAY WHAT IT WOULD DO AND STOP. The same contract m59-restore and the DUM planner keep, and
// the right default habit when the other end is live characters on a shared server.
if (argv.includes('--dry')) {
  const withDefaults = applyDefaults(script, params);
  const bad = checkParams(script, withDefaults);
  if (bad.length) { console.error('bad parameters:\n  ' + bad.join('\n  ')); process.exit(2); }
  const agents = asAgents(withDefaults.agents);
  console.log(`resupply: ${agents.length} agent(s) — ${agents.join(', ')}`);
  for (const agent of agents) {
    // Per agent, because the ROUTE is per agent: what each is carrying decides whether it
    // needs the smith town at all.
    const steps = await script.steps({ ...withDefaults, agent, agents });
    console.log(`  ${agent}:`);
    for (const [i, s] of steps.entries())
      console.log(`    ${i}. ${s.do}${s.to != null ? ` -> room ${s.to}` : ''}` +
        `${s.merchant ? ` at ${s.merchant}` : ''}${s.seller ? ` at ${s.seller}` : ''}` +
        // An amount can be a function of live state (the bank withdrawal is, because a
        // death empties the purse mid-errand). Printing its SOURCE at an operator is
        // noise; printing what it depends on is the useful half.
        `${s.action ? ` ${s.action} ${typeof s.amount === 'function'
            ? '(computed from the purse at the counter)' : s.amount}` : ''}` +
        `${s.lines ? ` [${s.lines.map(l => `${l.match} x${l.amount}`).join(', ')}]` : ''}`);
  }
  console.log('  (nothing was sent)');
  // `process.exit()` from here tears down a loop that still has handles open and trips a
  // libuv assertion (UV_HANDLE_CLOSING) — the same crash the REPL hit on quit. Setting the
  // code and letting the module end drains cleanly. The whole live run therefore has to sit
  // in an `else`: an early `return` is not available at the top level of a module, and the
  // first attempt at this left the run UNGUARDED, so `--dry` went on to drive the fleet and
  // was stopped only by the run lock.
  process.exitCode = 0;
} else {
  const result = await runNamed('resupply', params, { scripts, fleetScript });
  if (result.refused) process.exitCode = 3;
  else {
    if (result.why) console.error(result.why);

    for (const [agent, r] of Object.entries(result.results ?? {}))
      console.log(`${agent}: ${r.ok ? 'delivered'
        : `stopped at step ${r.at} (${r.step}) — ${r.why}` +
          (r.unsold ? ' [still carrying the cargo]' : '') + (r.dead ? ' [died]' : '')}`);

    console.log('');
    console.log('Now spread it, or the reagents sit on the couriers:');
    console.log('  node tools/m59-almoner.mjs --amount 40 --keep 40 --max-deliveries 20 --max-hops 1');
    process.exitCode = result.ok ? 0 : 1;
  }
}
