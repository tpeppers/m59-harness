#!/usr/bin/env node
// EVERY ADDRESSED KEEPER WRITE CARRIES ALL THREE PARTS. Offline: opens no socket, touches no
// roster, moves nobody. Safe any time.
//
//   node tools/m59-keeperaddress-test.mjs
//
// WHY THIS IS A LINT AND NOT A BEHAVIOUR TEST.
//
// A keeper refuses a partially addressed write BEFORE it will answer anything, with a 409 and
// `this keeper is "t16", not "undefined"`. That is a good refusal — it is what stops a broker
// that lost a port from commanding whoever answers. But it means a caller that forgets one
// part gets a refusal that looks like the QUESTION failing rather than the ADDRESS failing,
// and every such caller reports it in its own words.
//
// `routeTrapAhead` forgot one part. `keeperPorts` returns a Map keyed BY AGENT whose values
// are `{ port, character, pid }` — the agent is the key, not a field — so
// `ports.get(agent)` handed `keeperCall` an object with no `agent` on it, and the resulting
// 409 was reported as `router gave no hops`. Which reads as "the map cannot plan this route",
// so two sessions went looking at the routing table.
//
// It had been that way since it was written, and what it disarmed is guarantee 12: the
// refusal added after a character was walked into room 599 and died there. Every fleetScript
// walk logged one advisory line and went anyway. 154 offline assertions stayed green through
// all of it, because not one of them asks whether a call is addressed.
//
// So this asserts the SHAPE at every call site rather than the behaviour at one of them: an
// object handed to `keeperCall` must have acquired an `agent` somewhere. `holdKeeper` does it
// with `{ ...entry, agent }`; the fixed `routeTrapAhead` does the same. A new call site that
// forgets will fail here rather than in production, quietly, months later.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, 'm59-fleetscript.mjs');
const src = readFileSync(FILE, 'utf8');

let passed = 0, failed = 0;
const ok = (cond, what) => {
  if (cond) { console.log('  ok   ' + what); passed++; }
  else { console.log('  FAIL ' + what); failed++; }
};

// Comments describe the bug at length in this very file, so they must not be scanned — the
// ledger-space lint learned that the expensive way by quoting its own documentation back.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

console.log('every keeperCall site is handed an object that carries an agent');
{
  // `keeperCall(who, 'route', ...)` -> the identifier in argument position 1.
  const sites = [...code.matchAll(/keeperCall\(\s*([A-Za-z_$][\w$]*)\s*,/g)]
    .map(m => ({ name: m[1], at: code.slice(0, m.index).split('\n').length }));
  ok(sites.length >= 4, `found ${sites.length} keeperCall site(s) to check`);

  for (const site of sites) {
    // Where did that identifier come from? Look for its declaration anywhere in the file and
    // require that the expression mentions `agent`. Deliberately loose: `{ ...entry, agent }`,
    // `{ ...e, agent: a }` and a parameter named `who` built by the caller all pass, and the
    // one thing that fails is `ports.get(agent)` used raw — which is the actual bug.
    const decl = new RegExp(`const\\s+${site.name}\\s*=\\s*([^;]+);`, 'g');
    const found = [...code.matchAll(decl)];
    if (!found.length) {
      // A function parameter (holdKeeper's `who`) — its caller is checked at its own site.
      ok(new RegExp(`\\(\\s*${site.name}\\b|,\\s*${site.name}\\b`).test(code),
         `${site.name} at line ~${site.at} is a parameter, addressed by its caller`);
      continue;
    }
    for (const d of found) {
      const expr = d[1];
      ok(/\bagent\b/.test(expr),
         `${site.name} (line ~${code.slice(0, d.index).split('\n').length}) carries an agent: ${expr.replace(/\s+/g, ' ').slice(0, 60)}`);
    }
  }
}

console.log('\nthe raw port-map value is never passed straight to keeperCall');
{
  // THE EXACT BUG, pinned as its own assertion so the failure names itself. `keeperPorts`
  // is keyed by agent and its values do not carry one.
  const raw = /const\s+(\w+)\s*=\s*ports\??\.?\s*\.?get\??\.?\(\s*agent\s*\)\s*;[\s\S]{0,400}?keeperCall\(\s*\1\s*,/;
  ok(!raw.test(code),
     'no `const who = ports.get(agent)` is handed to keeperCall without adding the agent');
}

console.log('\nkeeperCall still sends all three identity parts');
{
  const body = code.match(/async function keeperCall[\s\S]{0,900}?\n\}/)?.[0] ?? '';
  ok(/agent:\s*who\.agent/.test(body), 'agent');
  ok(/character:\s*who\.character/.test(body), 'character');
  ok(/keeper_pid:\s*who\.pid/.test(body), 'keeper_pid');
  ok(/\bname\b/.test(body), '...and the action name, at the TOP level beside them');
}

console.log('\nan addressing failure is not reported as a routing failure');
{
  const fn = code.match(/async function routeTrapAhead[\s\S]{0,2000}?\n\}/)?.[0] ?? '';
  ok(/r\?\.error/.test(fn),
     'routeTrapAhead distinguishes a refused REQUEST from a route that does not exist');
  ok(/no keeper port/.test(fn), '...and still says when there was no keeper to ask at all');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
