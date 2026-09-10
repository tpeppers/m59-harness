#!/usr/bin/env node
// EVERY WIRE VERB THE CLIENT CAN SPEAK, THE BROKER'S PROXY CAN FORWARD.
//
//   node tools/m59-keeperproxy-test.mjs
//
// Offline and static: it reads the two files as text. It must NOT import m59-broker.mjs —
// importing runs it, taking the fleet lock and starting rejoin timers (see CLAUDE.md), so
// the one check that would be easiest is the one nobody may run.
//
// WHAT THIS EXISTS FOR. Since the keeper-process migration the World lives in the KEEPER and
// the broker holds a SNAPSHOT. A snapshot can answer questions; it cannot send a packet. So
// every mutation has to be forwarded to the process that owns the socket, and when one is
// not, the failure is this:
//
//     guild action=status  ->  "c.requestGuildInfo is not a function"
//
// That was the state of the ENTIRE guild surface on 2026-09-10: seventeen verbs, every one
// called straight on the snapshot, so founding a guild was impossible fleet-wide — and
// nothing said so until somebody tried it. `M59Client` had all seventeen the whole time
// (m59-client.mjs:1238-1292). The capability was never missing; it was on the wrong side of
// a process boundary.
//
// IT IS THE THIRD TIME. `sellOne` was missing the same way (sell_all failed keeper-backed),
// and `buyItems` before that — "this fleet has zero successful purchases in its recorded
// history while selling always worked." A class of bug that has recurred three times with no
// guard is the definition of one worth a test.
//
// AND IT CANNOT BE CAUGHT BY RUNNING THINGS. A missing forward is a TypeError at the moment
// of use, on a live fleet, in a verb nobody exercises often — guild founding happens once.
// The offline suites drive fakes, and a fake has whatever methods the test gave it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(TOOLS, f), 'utf8');

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};

const client = read('m59-client.mjs');
const broker = read('m59-broker.mjs');

// The proxy's class body, taken by brace-matching from `class KeeperProxy {` so a later
// class in the file cannot leak methods into this set.
function classBody(src, name) {
  const start = src.indexOf(`class ${name} {`);
  if (start < 0) return null;
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(i + 1, j); }
  }
  return null;
}

const proxyBody = classBody(broker, 'KeeperProxy');
ok('KeeperProxy is still a class in m59-broker.mjs', !!proxyBody,
   'the brace matcher found nothing — this test is blind until that is fixed');

// Method and getter names the proxy defines.
const proxyMethods = new Set();
if (proxyBody) {
  for (const m of proxyBody.matchAll(/^\s{2}(?:async\s+)?(?:get\s+)?([A-Za-z_$][\w$]*)\s*\(/gm))
    proxyMethods.add(m[1]);
}

console.log('\nthe guild surface — seventeen verbs, all of which were unreachable');
{
  // Taken from the CLIENT, not from a hand-written list: if somebody adds a guild verb to
  // m59-client.mjs and does not forward it, this fails the day they add it rather than the
  // day somebody tries to use it on prod.
  const clientGuild = new Set();
  for (const m of client.matchAll(/^\s{2}(?:async\s+)?((?:guild|requestGuild)[A-Za-z]*)\s*\(/gm))
    clientGuild.add(m[1]);

  ok('the client still declares a guild surface to forward',
     clientGuild.size >= 15, `found ${clientGuild.size}`);

  const missing = [...clientGuild].filter(n => !proxyMethods.has(n)).sort();
  ok(`all ${clientGuild.size} guild verb(s) are forwarded by KeeperProxy`,
     missing.length === 0,
     missing.length
       ? `NOT forwarded, so each throws "c.<name> is not a function" on a keeper-backed `
         + `session: ${missing.join(', ')}`
       : '');

  // `c.guild` is read by the tool after every round trip; a forward that cannot answer it
  // would report every character guildless, which reads as a clean "no guild" rather than
  // as a fault.
  ok('and the roster itself is exposed, so `c.guild` is not silently undefined',
     proxyMethods.has('guild'), 'KeeperProxy needs a `guild` getter');
}

console.log('\nthe verbs that had this bug BEFORE, kept as regressions');
{
  // Each of these was the same failure discovered the expensive way. They pass today; they
  // are here so that a refactor which drops one is caught by a test rather than by a fleet.
  for (const [name, incident] of [
    ['shopList',   'buyItems: "zero successful purchases in its recorded history"'],
    ['shopBuy',    'the same, on the mutation half'],
    ['walkTo',     'movement has always had to be keeper-side'],
    ['fight',      'as has fighting'],
    ['travel',     'and journeys'],
  ]) ok(`${name} is forwarded (${incident})`, proxyMethods.has(name));
}

console.log('\nthe forward has to REACH the keeper, not merely exist');
{
  // A method that returns a plausible object without touching keeperAction would satisfy
  // the name check above and still send no packet — which is precisely the failure mode
  // this whole file is about, reintroduced one level down. So the guild forwards must
  // actually go through the one function that crosses the process boundary.
  const act = proxyBody?.match(/_guildAct\s*\([\s\S]{0,400}?keeperAction\(/);
  ok('the guild forwards go through keeperAction', !!act,
     '_guildAct must call keeperAction — a local stub would send nothing and report success');

  // And the keeper must actually implement the op it is sent.
  const keeper = read('m59-keeper-process.mjs');
  ok("the keeper's /action handles a 'guild' case", /case 'guild':/.test(keeper),
     "m59-keeper-process.mjs has no `case 'guild':`, so every forward would 404");

  // SILENCE IS THE REFUSAL HERE, so the reply must always carry what was said. A guild
  // command the caller lacks the bit for produces no message, no packet, and only a
  // Debug() line in the SERVER log (user.kod:4848) — so a caller that reads "no error" as
  // "it worked" is wrong fourteen different ways.
  const guildCase = keeper.slice(keeper.indexOf("case 'guild':"),
                                 keeper.indexOf("case 'guild':") + 4000);
  ok('and it returns `said`, because a guild refusal IS silence',
     /said:/.test(guildCase));
  ok('and the roster, so the broker can populate c.guild',
     /guild:\s*c\.guild/.test(guildCase));
}

console.log(`\nkeeper proxy: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
