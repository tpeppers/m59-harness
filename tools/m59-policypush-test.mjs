#!/usr/bin/env node
// DOES AN ORDER REACH THE PROCESS THAT WILL OBEY IT?
//
//   node tools/m59-policypush-test.mjs
//
// Offline. Reads source only — opens no socket, touches no roster, starts no broker.
//
// WHY THIS FILE EXISTS. `autopilot action=start` used to write exactly two places, and
// neither of them was the character:
//
//   1. the broker's own in-process Autopilot shell, which on a keeper-backed broker
//      drives nobody at all, and
//   2. the roster on disk, which a keeper reads ONCE, at startup.
//
// So an operator changed a policy, the call returned `running: true, mode: "farm"`, the
// roster on disk was correct — and the keeper went on running the orders it had booted
// with. Nothing errored anywhere.
//
// Measured on prod 2026-08-26: nine characters in Familiars were switched to
// farm / "fungus beast" / assigned_room 544 / confinement released. All nine were right on
// disk. All nine were still `survive` with the old confinement in the live keeper a minute
// later. That is the silent-success shape this repository keeps paying for, sitting in the
// path an operator uses most often.
//
// The second half of the bug is quieter and has a longer fuse. `join()` ends with
// `autopilot.mode = mode; Object.assign(autopilot.policy, policy)` — the roster snapshot
// the keeper process read at STARTUP, re-imposed on every reconnect. A push that updated
// only the live Autopilot object would therefore work, and then silently revert at the next
// rejoin sweep, phantom recovery or pilot hand-back. So the push has to move the boot
// orders too, and that is what most of the assertions below are about.
//
// These are source assertions rather than behavioural ones on purpose: the behaviour needs
// a live keeper and a live broker, and this has to be runnable any time, including on a
// clone with no fleet. It should fail the day somebody makes an order stop travelling.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const keeper = readFileSync(join(HERE, 'm59-keeper-process.mjs'), 'utf8');
const broker = readFileSync(join(HERE, 'm59-broker.mjs'), 'utf8');

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '  — ' + extra : ''}`); }
};

// The keeper's POST /policy handler, from its guard to the end of the block.
const policyHandler = (() => {
  const i = keeper.indexOf(`req.method === 'POST' && path === '/policy'`);
  return i === -1 ? "" : keeper.slice(i, i + 6000);
})();

console.log('\nthe keeper end — POST /policy');
ok('the handler exists at all', policyHandler.length > 0);

// A WRITE IS ADDRESSED. keeperPort() falls back to KEEPER_PORT_BASE + index whenever this
// broker never got its own keeper up on that slot, so an unaddressed write goes to whatever
// process is listening there. A policy is the least visible thing you can change on a
// stranger's character: no logout, no server log line, just somebody else's fleet quietly
// hunting the wrong creature in the wrong room.
ok('refuses an order addressed to another keeper identity',
   /!requireAddressedWrite\(req, body\)/.test(policyHandler));
ok('and refuses BEFORE applying anything',
   policyHandler.indexOf('refuseMisaddressed') < policyHandler.indexOf('Object.assign'));

// `mode` lives on the Autopilot object, not in `policy`. Object.assign-ing it into the
// policy would leave a `policy.mode` that looks authoritative and is read by nothing —
// which is exactly how `purpose` sat outside a schema for a year with every keeper's audit
// switched off. `agent` is the envelope and is not a setting either.
//
// THERE ARE THREE OF THEM NOW. `by` names the writer, and it is there because the one log
// line a policy change produced named nobody: twenty-one `policy updated` lines in a single
// keeper process could not answer "who reverted my spot policy", which was the whole
// question after three deaths were root-caused to that pair. It is subject to the same rule
// as the other two — stripped, never applied, because a `policy.by` that looks
// authoritative and is read by nothing is the `purpose` bug wearing a different hat.
ok('strips the reserved keys out of the body before applying',
   /const\s*\{\s*agent:\s*\w+,\s*character:\s*\w+,\s*keeper_pid:\s*\w+,\s*mode:\s*\w+,\s*by:\s*\w+,\s*\.\.\.\s*\w+\s*\}\s*=\s*body/.test(policyHandler));
ok('so no mode, identity, or writer envelope key can land in policy',
   !/Object\.assign\(autopilot\.policy,\s*body\)/.test(policyHandler));
ok('and the writer is what the log line reports, or naming it bought nothing',
   /by \$\{writtenBy \?\? 'unattributed/.test(policyHandler));

// THE DURABILITY HALF. join() re-imposes the boot orders on every reconnect.
ok('the boot orders are mutable, so a push can move them',
   /let policy = entry\.autopilot\?\.policy/.test(keeper) &&
   /let mode = entry\.autopilot\?\.mode/.test(keeper));
ok('and the push DOES move them, or it reverts at the next rejoin',
   /Object\.assign\(policy,\s*\w+\)/.test(policyHandler) &&
   /if \(wantMode\) mode = wantMode/.test(policyHandler));
ok('join() re-applies those same variables',
   /autopilot\.mode = mode;[\s\S]{0,80}Object\.assign\(autopilot\.policy, policy\)/.test(keeper));

// A bare `ok: true` would rebuild the original bug on the receiving side: a policy change
// that silently did nothing is indistinguishable from one that worked.
ok('the reply says what actually landed, not just ok',
   /json\(\{ ok: true, agent, applied/.test(policyHandler));

console.log('\nthe broker end — keeperPolicy');
const keeperPolicy = (() => {
  const i = broker.indexOf('async function keeperPolicy(');
  return i === -1 ? '' : broker.slice(i, i + 1400);
})();
ok('keeperPolicy exists', keeperPolicy.length > 0);
ok('it posts to the keeper\'s /policy', /fetch\(`http:\/\/127\.0\.0\.1:\$\{target\.port\}\/policy`/.test(keeperPolicy));
ok('identity-stamped like every other write path',
   /keeperIdentityHeaders\(target\.identity\)/.test(keeperPolicy) &&
   /keeperEnvelope\(target\.identity, body\)/.test(keeperPolicy));
ok('rolling old keepers receive no character/PID policy fields',
   /const keeperEnvelope = \(identity, body\) => JSON\.stringify\(\{ \.\.\.body, agent: identity\.agent \}\)/.test(broker));

// THE WIRE FORMAT IS FLAT, AND THAT IS A COMPATIBILITY DECISION, NOT A STYLE ONE. A keeper
// predating this change handles the body as `Object.assign(autopilot.policy, body)`. A flat
// body lands correctly there and the two reserved keys become inert extras; a `{policy:{…}}`
// wrapper would make every older keeper silently ignore the entire order — the exact
// failure this function was written to end.
ok('the body is flat, so an older keeper still applies the policy',
   /const body = \{ \.\.\.\(policy \|\| \{\}\) \};/.test(keeperPolicy) &&
   !/body:\s*keeperEnvelope\(agent,\s*\{\s*policy/.test(keeperPolicy));
ok('a reply without `applied` is reported as unconfirmed rather than as success',
   /confirmed: Array\.isArray\(j\.applied\)/.test(keeperPolicy));

console.log('\nthe call sites');
const pushHelper = (() => {
  const i = broker.indexOf('async function pushPolicyToKeeper(');
  return i === -1 ? '' : broker.slice(i, i + 500);
})();
ok('pushPolicyToKeeper exists', pushHelper.length > 0);
ok('and only pushes for a keeper-backed session',
   /if \(!\(s instanceof KeeperProxy\)\) return null/.test(pushHelper));

// Both places that persist an order must also deliver it. `spread`'s whole promise is
// "make the assignment STICK", which on a keeper-backed broker it could not do at all.
const remembers = [...broker.matchAll(/rememberAutopilot\((?!agent, config)/g)].length;
ok('every rememberAutopilot call site is followed by a push',
   remembers === [...broker.matchAll(/pushPolicyToKeeper\(/g)].length - 1,
   `${remembers} remember sites vs ${[...broker.matchAll(/pushPolicyToKeeper\(/g)].length - 1} pushes`);
ok('autopilot action=start pushes after persisting',
   /rememberAutopilot\(a\.agent[\s\S]{0,4000}?await pushPolicyToKeeper\(a\.agent, p\)/.test(broker));
ok('spread apply pushes after persisting',
   /rememberAutopilot\(o\.agent[\s\S]{0,4000}?await pushPolicyToKeeper\(o\.agent, p\)/.test(broker));

// An `await` inside a synchronous run() is not a slow push, it is a broken one: the tool
// would answer before the order left the building.
ok('the autopilot tool\'s run is async, so the await is real',
   /name: 'autopilot',[\s\S]{0,60000}?run: async \(a\) => \{/.test(broker));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
