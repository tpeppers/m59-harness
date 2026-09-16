#!/usr/bin/env node
// Offline RTS packet-authority regression. This imports only pure helpers and reads
// source text; it opens no broker, fleet, roster, gateway, or Meridian connection.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rtsCleanupAuthorityCheck, rtsJobReport, rtsPacketAuthorityCheck,
         rtsCallerIsLocal, requireRtsLocalCaller } from './m59-rts-safety.mjs';

const callbacks = (calls, { isCancelled = false } = {}) => ({
  endpoint: () => calls.push('endpoint'),
  keeper: () => calls.push('keeper'),
  room: () => calls.push('room'),
  owner: () => calls.push('owner'),
  cancelled: () => { calls.push('cancelled'); return isCancelled; },
  validate: (packet, detail) => calls.push(`validate:${packet}:${detail?.id ?? ''}`),
});

{
  const calls = [];
  const cancelled = rtsPacketAuthorityCheck({
    packet: 'attack', detail: { id: 900 }, ...callbacks(calls, { isCancelled: true }),
  });
  assert.equal(cancelled, true);
  assert.deepEqual(calls, ['endpoint', 'keeper', 'room', 'owner', 'cancelled'],
    'owned cancellation wins only after endpoint/keeper/room/owner and before action validation');
}

{
  const calls = [];
  const stopped = rtsPacketAuthorityCheck({
    packet: 'get', detail: { id: 901 }, ...callbacks(calls),
  });
  assert.equal(stopped, false);
  assert.deepEqual(calls,
    ['endpoint', 'keeper', 'room', 'owner', 'cancelled', 'validate:get:901'],
    'an authorized packet reaches its action-specific identity validator last');
}

{
  const calls = [];
  const hooks = callbacks(calls);
  hooks.keeper = () => { calls.push('keeper'); throw new Error('keeper resumed'); };
  assert.throws(() => rtsPacketAuthorityCheck({ packet: 'move', ...hooks }), /keeper resumed/);
  assert.deepEqual(calls, ['endpoint', 'keeper'],
    'a resumed keeper fails closed before room, owner, cancellation, or action checks');
}

{
  const calls = [];
  const hooks = callbacks(calls);
  hooks.endpoint = () => { calls.push('endpoint'); throw new Error('endpoint changed'); };
  assert.throws(() => rtsPacketAuthorityCheck({ packet: 'cast', ...hooks }), /endpoint changed/);
  assert.deepEqual(calls, ['endpoint'], 'a changed endpoint is the first fail-closed boundary');
}

{
  const calls = [];
  const hooks = callbacks(calls);
  hooks.owner = () => { calls.push('owner'); throw new Error('token replaced'); };
  assert.throws(() => rtsPacketAuthorityCheck({ packet: 'use', ...hooks }), /token replaced/);
  assert.deepEqual(calls, ['endpoint', 'keeper', 'room', 'owner'],
    'a replaced token owner blocks before cancellation or item validation');
}

{
  const calls = [];
  const hooks = callbacks(calls, { isCancelled: true });
  rtsCleanupAuthorityCheck({ packet: 'cleanup-stand', ...hooks });
  assert.deepEqual(calls, ['endpoint', 'keeper', 'room', 'owner'],
    'recovery cleanup ignores cancellation but retains every other authority boundary');
}

const baseJob = {
  label: 'fixture action', startedAt: 1000, finishedAt: 5000, done: true,
};
assert.deepEqual(rtsJobReport({ ...baseJob, cancelled: true, error: 'cleanup lost authority' }, 5000),
  { last_action: 'fixture action', took_s: 4, cancelled: true },
  'explicit cancellation outranks a cleanup error');
assert.deepEqual(rtsJobReport({ ...baseJob, cancelRequestedAt: 2000, result: { ok: true } }, 5000),
  { last_action: 'fixture action', took_s: 4, cancelled: true },
  'a completed attack that returned normally still reports its requested cancellation');
assert.deepEqual(rtsJobReport({ ...baseJob, result: { recovery: { cancelled: true } } }, 5000),
  { last_action: 'fixture action', took_s: 4, cancelled: true },
  'nested recovery cancellation is promoted to ACTION telemetry');
assert.deepEqual(rtsJobReport({ ...baseJob, error: 'ordinary failure' }, 5000),
  { last_action: 'fixture action', took_s: 4, failed: 'ordinary failure' });
assert.deepEqual(rtsJobReport({ ...baseJob,
  result: { committed: false, verification_failed: true } }, 5000),
  { last_action: 'fixture action', took_s: 4,
    failed: 'server outcome could not be verified; no success was claimed' },
  'ambiguous economic silence is never promoted to ok telemetry');
assert.deepEqual(rtsJobReport({ ...baseJob, kind: 'commerce:buy', cancelled: true,
  result: { kind: 'buy', quote_id: 'quote-visible-id', committed: true,
    evidence: { gained_quantity: 2, purse_spent: 12 } } }, 5000), {
  last_action: 'fixture action', took_s: 4, cancelled: true,
  commerce_result: { kind: 'buy', quote_id: 'quote-visible-id', committed: true,
    verification_failed: false, state: null,
    evidence: { gained_quantity: 2, purse_spent: 12 } },
}, 'a late cancellation does not hide evidence that an economic packet already committed');
assert.deepEqual(rtsJobReport({ ...baseJob, done: false, finishedAt: undefined,
  cancelled: true }, 5000),
  { busy: 'fixture action', running_for_s: 4, stopping: true });

const brokerPath = fileURLToPath(new URL('./m59-broker.mjs', import.meta.url));
const skillsPath = fileURLToPath(new URL('./m59-skills.mjs', import.meta.url));
// Session moved to m59-game.mjs and the mover verbs went with it. This reads the broker
// for its own sections and the game module for the Session ones; a suite that greps only
// one does not fail, it matches an empty haystack and passes.
const gamePath = fileURLToPath(new URL('./m59-game.mjs', import.meta.url));
const broker = readFileSync(brokerPath, 'utf8') + '\n' + readFileSync(gamePath, 'utf8');
const skills = readFileSync(skillsPath, 'utf8');
const section = (start, end) => {
  const from = broker.indexOf(start);
  const to = broker.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `source section ${start} .. ${end} exists`);
  return broker.slice(from, to);
};

const step = section('async step(col, row,', '\n  // ------------------------------------------------------- fine movement');
assert.match(step, /pacer[.]submit[(]'turn'.*beforeMutation[(]'turn'.*c[.]face/s,
  'RTS movement can guard the turn packet inside its pacer callback');
assert.match(step, /queueValidatedMove.*beforeMutation:.*beforeMutation[(]'move'/s,
  'RTS square movement threads its final-packet hook into validated movement');

const queuedMove = section('async queueValidatedMove(x, y,', '\n  // ONE SQUARE');
assert.match(queuedMove, /pacer[.]submit[(]'move'.*beforeMutation[(]'move'.*c[.]moveTo/s,
  'queueValidatedMove guards the exact locally-clipped move packet inside its pacer callback');
assert.match(queuedMove, /validateFineTarget.*beforeMutation.*c[.]moveTo/s,
  'authority is checked only after the final live collision revalidation and before send');

const walk = section('async walkTo(col, row,', '\n  // Leave the room');
assert.match(walk, /beforeMutation = null/);
// `[,}]` rather than a closing brace, because what is being asserted is that the hook is
// THREADED, not that it is the only option threaded. Written as `\{ beforeMutation \}` this
// went red the day `step` grew a `fall` flag — an assertion about authority failing over an
// unrelated argument, which teaches the next reader to loosen it rather than to look.
assert.match(walk, /this[.]step[(]next[.]col, next[.]row, \{ beforeMutation[,}]/,
  'walkTo threads its final-packet mutation hook through the shared validated step');

const loot = section('async lootFloor({', '\n  // Offer one item to a merchant');
assert.match(loot, /this[.]walkTo[\s\S]*beforeMutation:/,
  'loot movement carries the selected item id into the packet hook');
assert.match(loot, /pacer[.]submit[(]'get'.*beforeMutation[(]'get'.*c[.]get/s,
  'loot revalidates exact item safety inside the get pacer callback');

const attack = section("name: 'attack',", "name: 'attack_intent',");
assert.match(attack, /faceToward\(o,[\s\S]*beforeRtsMutation\(a, packet\)/,
  'RTS attack turns use the same final authority hook');
assert.match(attack, /pacer[.]submit[(]'attack'.*beforeRtsMutation[(]a, 'attack'[)].*c[.]attack/s,
  'the final attack callback guards immediately before c.attack');

const attackIntent = section("name: 'attack_intent',", "name: 'move_intent',");
assert.match(attackIntent, /rtsPacketAuthority[(]\{/);
assert.match(attackIntent, /sameRtsIdentity.*OF[.]ATTACKABLE/s);
assert.match(attackIntent, /current[.]flags & OF[.]PLAYER/);
assert.match(attackIntent, /fraction > 0[.]35/,
  'multi-swing HP must still exceed 35% at the final callback');
assert.match(attackIntent, /\[RTS_MUTATION_GUARD\]: guard/);

const moveIntent = section("name: 'move_intent',", "name: 'context_intent',");
assert.match(moveIntent, /rtsPacketAuthority[(]\{/);
assert.match(moveIntent, /walkTo\(col, row,[\s\S]*beforeMutation/,
  'move intent threads authority into every walk packet');

const context = section("name: 'context_intent',", "name: 'cancel_action',");
for (const expected of [
  /rtsPacketAuthority[(]\{/,
  /sameRtsIdentity/,
  /OF[.]GETTABLE/,
  /CURSED_ITEMS[.]test/,
  /outside pickup range/,
  /brokenSet[(]c[)]/,
  /rtsSafeSpellRule/,
  /rtsSpellTargetAllowed/,
  /beforeCleanup/,
  /beforeMutation,/,
]) assert.match(context, expected);
assert.match(context, /lootFloor\([\s\S]*beforeMutation/,
  'context loot passes the packet guard into movement and get');

const cancel = section("name: 'cancel_action',", "name: 'shop',");
assert.match(cancel, /requireControlEndpoint[(]s,/,
  'cancel still verifies the exact endpoint');
assert.match(cancel, /requireRtsLocalCaller[(]caller[)]/,
  'cancel still requires a caller on this machine');
assert.doesNotMatch(cancel, /requireControlSession|requireRtsKeeperInactive/,
  'owned cancellation remains available after a keeper resumes');
assert.match(cancel, /job[.]controlToken !== token/,
  'cancel retains exact token ownership');

assert.match(skills, /beforeMutation[(]'use', \{ item_id: cand[.]o[.]id/,
  'weapon helpers expose their chosen cached item to final validation');
assert.match(skills, /beforeMutation[(]'eat', \{ item_id: item[.]o[.]id/,
  'food helpers expose their chosen cached item to final validation');
assert.match(skills, /beforeCleanup[(]'cleanup-stand'[)]/,
  'recovery cleanup has its own authority hook inside the pacer callback');

// THE CALLER IS THE THING THAT HAS TO BE LOCAL.
//
// The game server may be anywhere — prod is remote and shared. What may not be remote
// is whoever asked for the packet, because this transport is unauthenticated and
// M59_BIND can bind it past loopback. Absent or malformed context is refused: a control
// tool that cannot tell where it came from has no authority to send anything.
assert.equal(rtsCallerIsLocal({ transport: 'stdio', local: true }), true);
assert.equal(rtsCallerIsLocal({ transport: 'http', local: true }), true);
assert.equal(rtsCallerIsLocal({ transport: 'http', local: false }), false);
assert.equal(rtsCallerIsLocal(undefined), false, 'a missing caller is not local');
assert.equal(rtsCallerIsLocal(null), false);
assert.equal(rtsCallerIsLocal({}), false, 'an empty caller is not local');
assert.equal(rtsCallerIsLocal({ transport: 'http', local: 'true' }), false,
  'a truthy string must not stand in for a locality decision');
assert.equal(rtsCallerIsLocal({ transport: 'http', local: 1 }), false);
assert.equal(rtsCallerIsLocal({ local: true }), false, 'locality must name its transport');
// batch.map(handleRpc) would pass the array index here, which is truthy and has no
// .local — the refusal below is what makes that mistake fail closed rather than open.
assert.equal(rtsCallerIsLocal(0), false);
assert.equal(rtsCallerIsLocal(1), false);
assert.throws(() => requireRtsLocalCaller({ transport: 'http', local: false }),
  /only from this machine/);
assert.throws(() => requireRtsLocalCaller(undefined), /only from this machine/);
assert.deepEqual(requireRtsLocalCaller({ transport: 'stdio', local: true }),
  { transport: 'stdio', local: true });

// Both transports must decide locality themselves and hand it down; neither may let a
// tool infer it. The HTTP path derives it at the socket, before a body is parsed.
assert.match(broker, /const caller = \{ transport: 'http', local: brokerLoopbackRequest\(req\) \}/,
  'the HTTP transport does not derive caller locality from the socket');
assert.match(broker, /handleRpc\(msg, CALLER_STDIO\)/,
  'the stdio transport does not declare itself local');
assert.match(broker, /batch\.map\(m => handleRpc\(m, caller\)\)/,
  'the JSON-RPC batch path must not pass handleRpc point-free: map would supply the index as caller');
assert.doesNotMatch(broker, /Promise\.all\(batch\.map\(handleRpc\)\)/,
  'batch.map(handleRpc) hands each call the array index as its caller');
assert.match(broker, /async function callTool\(name, args, caller\)/,
  'callTool drops the caller before it reaches a tool');
assert.match(broker, /t\.run\(args \|\| \{\}, caller\)/,
  'tools are invoked without their caller');

// Every RTS control tool takes the caller and checks it. A new one that forgets is the
// failure this guards: it would be reachable from any host that can open the port.
for (const [tool, next] of [["name: 'attack_intent',", "name: 'move_intent',"],
                            ["name: 'move_intent',", "name: 'context_intent',"],
                            ["name: 'context_intent',", "name: 'cancel_action',"]]) {
  const body = section(tool, next);
  assert.match(body, /run: (?:async )?\(a, caller\) =>/, `${tool} does not receive its caller`);
  assert.match(body, /requireControlSession\(\s*s, caller,/, `${tool} does not check its caller`);
}
// And the endpoint check itself no longer decides locality — it binds to one server.
assert.doesNotMatch(broker, /requireLocalControlEndpoint\(/,
  'the endpoint check still carries the old conflated name');
assert.match(broker, /function requireControlEndpoint\(s, hostValue, portValue\)/,
  'the endpoint check is missing');

console.log('m59 RTS final-packet authority, caller locality, and cancellation telemetry passed');
