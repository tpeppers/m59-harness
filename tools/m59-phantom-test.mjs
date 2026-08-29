#!/usr/bin/env node
// m59-phantom-test.mjs — A MISTYPED AGENT NAME COSTS ONE CALL, NOT A BROKER.
//
//   node tools/m59-phantom-test.mjs
//
// Offline. Opens no socket, starts no broker, touches no roster.
//
// ======================== WHAT THIS PINS ========================
//
// `session(name)` in m59-broker.mjs used to mint a bare `Session` for any non-empty string
// it was handed. The null-name half of that was already fixed, with a comment naming the
// cost — "a phantom keyed `undefined` — never in game, never doing anything, and counted
// … the kind of quiet miscount that makes a healthy fleet look broken and a broken one
// look fine". The other half, a name that is present and WRONG, went straight through it.
//
// Measured on fleet `lan`, 2026-08-29. Two calls one second apart, same broker, same
// character — agent `psycho`, whose character is named `JohnsSlave`:
//
//     status {agent: "psycho"}      -> in_game: true, hp 30/30, room 586
//     status {agent: "JohnsSlave"}  -> agent "JohnsSlave" is not in game — call join first
//
// The second minted a session that can NEVER be in game, because nothing will ever try to
// join a name the roster does not know. From then on, for the life of the broker process:
//
//   * every call against it threw a CONNECTION error for a NAMING fault, which sends a
//     reader — human or the monitoring layer this harness exists to be driven by — to
//     restart and rejoin a character that was never unwell;
//   * `fleet` grew a second row (`in_game: false`), and `sessions.size` grew with it;
//   * `m59-service.mjs status` printed "1 character(s) are not in game — the broker
//     rejoins them on its own; watch the log", which is structurally false: the 45s sweep
//     iterates the ROSTER, so it could never reach the phantom and would never log a line;
//   * only `leave` deletes a session, and `leave` is the one tool this fleet must never
//     call. So the blast radius of a typo was "until the next restart".
//
// Four claims are pinned here, in the order the fault travelled:
//   1. the resolver refuses an unknown name and says which name you probably meant;
//   2. `join` and `create_character` are still allowed to introduce a new one;
//   3. a session nobody ever tried to join stops reporting a connection problem;
//   4. `status` counts what the rejoin sweep can actually see.

import { readFileSync } from 'node:fs';
import { resolveAgentName, unknownAgentMessage, rosterRows } from './m59-agent-name.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

const BROKER  = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
const GAME    = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
const SERVICE = readFileSync(new URL('./m59-service.mjs', import.meta.url), 'utf8');

// The roster from the incident, in the shape the broker keeps it: agent -> entry.
const LAN = new Map([['psycho', { credentials: { account: 'a', character: 'JohnsSlave' } }]]);
const PROD = new Map(Array.from({ length: 21 }, (_, i) =>
  [`t${i + 1}`, { credentials: { character: ['Kermit', 'Piggy', 'Fozzie'][i % 3] + (i + 1) } }]));

// ------------------------------------------------------------------ 1. the resolver

console.log('\nan unknown agent name is refused, not minted');
{
  ok('a roster agent that has never joined still gets a bare session — that is what join fills',
     resolveAgentName('psycho', { inRoster: true, roster: LAN }).action === 'bare');
  ok('a keeper-backed name gets the proxy',
     resolveAgentName('psycho', { keeperBacked: true, inRoster: true, roster: LAN }).action === 'keeper');
  ok('a name already holding a session is handed back, whatever else is true of it',
     resolveAgentName('psycho', { held: true, roster: LAN }).action === 'held');

  const r = resolveAgentName('JohnsSlave', { roster: LAN });
  ok('THE BUG: a character name where an agent name goes is REFUSED', r.action === 'refuse');
  ok('and nothing about it says "not in game", because the fault is not a connection',
     !/not in game/.test(r.error), r.error);
  ok('and it says a session was not created, so a reader knows nothing was left behind',
     /no session was created/.test(r.error), r.error);

  // THE MESSAGE IS HALF THE FIX. The operator's next action is decided entirely by which
  // of three things this was, so the message answers all three rather than stopping at
  // "unknown agent".
  ok('it names the agent whose CHARACTER that is — the commonest cause by far',
     /is the CHARACTER of agent "psycho"/.test(r.error), r.error);
  ok('and gives the name to pass instead', /pass agent:"psycho"/.test(r.error), r.error);
  ok('and lists the roster, so a typo is visible without a second call',
     /Roster agents \(1\): psycho\./.test(r.error), r.error);

  const typo = unknownAgentMessage('psyco', LAN);
  ok('a plain typo gets the roster list and no false did-you-mean',
     /Roster agents \(1\): psycho\./.test(typo) && !/CHARACTER of agent/.test(typo), typo);
  ok('and is told how to introduce a genuinely new name',
     /`join` with account and password/.test(typo), typo);

  ok('a 21-character roster prints in full — the whole value is seeing the name you meant',
     (unknownAgentMessage('nobody', PROD).match(/t\d+/g) ?? []).length === 21);
  ok('an empty roster says so rather than printing "Roster agents (0):"',
     /holds no roster/.test(unknownAgentMessage('x', new Map())));

  // The null-name guard this generalises, still in place and still worded the same way.
  ok('no name at all is still its own refusal',
     resolveAgentName('', { roster: LAN }).error === 'no agent named — every fleet tool takes an `agent`');
  ok('and so is null', resolveAgentName(null, { roster: LAN }).action === 'refuse');
  ok('and a non-string is not coerced into one',
     resolveAgentName(7, { roster: LAN }).action === 'refuse');
}

console.log('\nthe roster is read in whatever shape the caller holds it');
{
  ok('the broker\'s Map of agent -> { credentials }',
     rosterRows(LAN)[0].character === 'JohnsSlave');
  ok('an array of rows', rosterRows([{ agent: 'a', character: 'B' }])[0].character === 'B');
  ok('an array of pairs', rosterRows([['a', { character: 'B' }]])[0].agent === 'a');
  ok('and nothing at all is not a crash', rosterRows(null).length === 0);
  ok('a character match is case-insensitive, because the fleet page prints it capitalised',
     /CHARACTER of agent "psycho"/.test(unknownAgentMessage('johnsslave', LAN)));
}

// ------------------------------------------------------------------ 2. the exemption

console.log('\nthe two tools whose job is to introduce a new name are still allowed to');
{
  ok('`create` is the only way past the refusal',
     resolveAgentName('brand-new', { create: true, roster: LAN }).action === 'bare');
  ok('the broker\'s session() takes it as an option rather than a positional flag',
     /const session = \(name, \{ create = false \} = \{\}\) => \{/.test(BROKER));
  ok('it asks the shared resolver rather than restating the rule',
     /const r = resolveAgentName\(name, \{[\s\S]{0,220}roster: fleetState,/.test(BROKER));
  ok('and the roster is what decides "known", not the sessions map',
     /inRoster: fleetState\.has\(name\),/.test(BROKER));
  ok('`join` passes create — recovering a dropped character must still work by name alone',
     /const s = session\(a\.agent, \{ create: true \}\);\n      \/\/ A CHARACTER EXISTS ON ONE SERVER/.test(BROKER));
  ok('and so does making a character',
     /making a character is exactly[\s\S]{0,120}const s = session\(a\.agent, \{ create: true \}\);/.test(BROKER));
  // Everything else must NOT: a tool that acts on a character it has never heard of is a typo.
  const exempt = (BROKER.match(/session\([^)]*\{ create: true \}\)/g) ?? []).length;
  ok('and nothing else claims the exemption', exempt === 2, `${exempt} call sites`);
}

// ------------------------------------------------------------------ 3. the throw

console.log('\na session nobody ever joined stops blaming the connection');
{
  ok('need() separates "never joined" from "joined and dropped"',
     /if \(!this\.client && !this\.joining && !this\.credentials\)/.test(GAME));
  ok('and says the name is probably wrong, which is what it actually is',
     /the agent name is probably wrong/.test(GAME));
  ok('the old sentence survives for the case it was true of — a session that DID drop',
     /is not in game — call join first/.test(GAME));
  ok('and "call join first" is no longer advice given to an unjoinable name',
     !/never joined[\s\S]{0,200}call join first`\)/.test(GAME));
}

// ------------------------------------------------------------------ 4. the health story

console.log('\nthe fleet board and status count what the rejoin sweep can reach');
{
  ok('a not-in-game row says whether the roster has it',
     /in_roster: fleetState\.has\(name\),\n {22}stalled: fleetState\.has\(name\) \? 'not in game'/.test(BROKER));
  ok('and an orphan row says outright that nothing will rejoin it',
     /not in the roster either — nothing will rejoin this/.test(BROKER));
  ok('an in-game row carries the same field, so one reader handles both',
     /\/\/ See the not-in-game row above: whether the rejoin sweep can see this one\.\n {10}in_roster: fleetState\.has\(name\),/.test(BROKER));

  ok('status counts in-game out of roster rows only',
     /const mine = rows\.filter\(r => r\.in_roster !== false\);/.test(SERVICE));
  // FAIL OPEN. A broker predating `in_roster` sends undefined, and treating that as "not
  // mine" would report an empty fleet — the opposite bug and a louder one.
  ok('and an older broker, which sends no such field, reads exactly as it did before',
     /r\.in_roster !== false/.test(SERVICE) && !/r\.in_roster === true/.test(SERVICE));
  ok('an orphan gets its own line rather than being counted as a dropped character',
     /session\(s\) are not roster characters/.test(SERVICE));
  ok('and that line does not promise a rejoin the sweep cannot perform',
     /the rejoin sweep iterates the roster and cannot see these\./.test(SERVICE));
  ok('while a genuine drop keeps the remediation that is true of it',
     /the broker rejoins them on its own; watch the log/.test(SERVICE));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
