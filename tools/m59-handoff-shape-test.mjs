// Offline SOURCE-SHAPE guard for the war-restart keeper handoff (86fb28f, fae8bd3).
//
// m59-keeper-process.mjs and m59-broker.mjs both RUN on import -- the keeper binds a port and logs
// a character in, the broker takes the fleet lock -- so neither can be imported by a test. These
// checks therefore read the source TEXT and pin its shape, the way m59-broker-demand-test.mjs and
// others do. They are NOT behaviour tests: they prove the guards are written where they must be,
// not that the handoff works. Opens no socket, touches no roster.
//
//   node tools/m59-handoff-shape-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const keeper = readFileSync(join(HERE, 'm59-keeper-process.mjs'), 'utf8').replace(/\r\n/g, '\n');
const broker = readFileSync(join(HERE, 'm59-broker.mjs'), 'utf8').replace(/\r\n/g, '\n');

let tests = 0;
async function test(name, fn) { await fn(); tests++; console.log(`ok ${name}`); }

/** The balanced {...} block that starts at the first `{` at or after `from`. */
function block(src, from) {
  const open = src.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error('unbalanced block');
}
const before = (hay, a, b, why) => {
  const i = hay.indexOf(a), j = hay.indexOf(b);
  assert.ok(i >= 0, `missing ${a}`); assert.ok(j >= 0, `missing ${b}`);
  assert.ok(i < j, why ?? `${a} must come before ${b}`);
};

// ---------------------------------------------------------------- the keeper side

await test('keeper: handoffActive is a deadline-bounded predicate over `handoff`', () => {
  assert.match(keeper, /\nlet handoff = null;/);
  assert.match(keeper, /\nconst handoffActive = \(\) => !!handoff && Date\.now\(\) < handoff\.deadline;/);
});

await test('keeper: join() refuses while handoffActive, before it touches any in-flight join', () => {
  const join = block(keeper, keeper.indexOf('\nasync function join()'));
  assert.match(join, /if \(handoffActive\(\)\) throw new Error\(/);
  before(join, 'if (handoffActive()) throw', 'keeperJoinInFlight', 'the refusal precedes the in-flight join');
  before(join, 'if (handoffActive()) throw', 'await ', 'the refusal precedes the first await');
});

await test('keeper: session.rejoin is wrapped, and the wrapper refuses during a handoff before calling through', () => {
  const at = keeper.indexOf('session.rejoin = async (...args) =>');
  assert.ok(at > 0, 'the rejoin wrapper exists');
  const wrap = block(keeper, at);
  before(wrap, 'if (handoffActive()) throw', 'return rejoinOriginal(...args)');
  // The original is captured BOUND, before the replacement is assigned.
  before(keeper, 'const rejoinOriginal = typeof session.rejoin === \'function\' ? session.rejoin.bind(session) : null;',
    'session.rejoin = async (...args) =>');
});

await test('keeper: a 250ms watcher exits on a dropped connection during a handoff and never reconnects', () => {
  const at = keeper.indexOf('\nsetInterval(() => {\n  if (!handoff) return;');
  assert.ok(at > 0, 'the handoff watcher exists');
  const body = block(keeper, at);
  const tail = keeper.slice(at + 1 + body.length + 'setInterval(() => '.length, at + 1 + body.length + 60);
  assert.match(tail, /^, 250\)/, `interval is 250ms, got ${JSON.stringify(tail.slice(0, 12))}`);
  assert.match(body, /if \(!handoffActive\(\)\) \{[\s\S]*?handoff = null;[^\n]*return;/, 'a lapsed handoff clears and carries on');
  assert.match(body, /if \(inGame && !session\.live\) \{/, 'the cue is the drop of a connection that was in game');
  before(body, 'handoff = null;\n    try { autopilot?.stop(', 'saveFinalState()');
  before(body, 'saveFinalState()', 'process.exit(0)');
  assert.doesNotMatch(body, /join\(|rejoin|connect\(/, 'the watcher itself never reconnects');
});

await test('keeper: POST /handoff is addressed-write gated; cancel withdraws; the timeout is clamped', () => {
  const at = keeper.indexOf("if (req.method === 'POST' && path === '/handoff')");
  assert.ok(at > 0, 'the endpoint exists');
  const body = block(keeper, at);
  before(body, 'requireAddressedWrite(req, asked)', 'handoff = null', 'identity is checked before any change');
  before(body, 'requireAddressedWrite(req, asked)', 'handoff = { since');
  assert.match(body, /if \(asked\.cancel\) \{\s*handoff = null;/);
  assert.match(body, /Math\.min\(600_000, Math\.max\(10_000, Number\(asked\.timeout_ms\) \|\| 120_000\)\)/);
  assert.match(body, /cancelInitialJoinRetry\(\);/, 'a pending initial-join retry is cancelled');
});

// ---------------------------------------------------------------- the broker side

const reconcile = block(broker, broker.indexOf('\nasync function reconcileFleet()'));

await test('broker: every reconcileFleet gate that checks keeperSpawning.has(agent) also checks keeperHandoffs.has(agent)', () => {
  const lines = reconcile.split('\n').filter(l => l.includes('keeperSpawning.has(agent)'));
  assert.ok(lines.length >= 4, `expected the four reconcile gates, found ${lines.length}`);
  for (const l of lines) assert.ok(l.includes('keeperHandoffs.has(agent)'), `unpaired gate: ${l.trim()}`);
  // And the pairing has the same polarity: `!a && !b` or `a || b`.
  for (const l of lines) assert.ok(/!keeperSpawning\.has\(agent\) && !keeperHandoffs\.has\(agent\)/.test(l) ||
    /keeperSpawning\.has\(agent\) \|\| keeperHandoffs\.has\(agent\)/.test(l), `mixed polarity: ${l.trim()}`);
});

await test('broker: the same pairing holds for every keeperSpawning.has(agent) in the whole file', () => {
  const lines = broker.split('\n').filter(l => l.includes('keeperSpawning.has(agent)'));
  for (const l of lines) assert.ok(l.includes('keeperHandoffs.has(agent)'), `unpaired: ${l.trim()}`);
});

// The body, not the destructured `{ timeoutMs }` parameter: start at the `) {` after the header.
const war = block(broker, broker.indexOf(') {', broker.indexOf('\nasync function warRestartKeeper(')) + 1);

await test('broker: warRestartKeeper refuses a busy agent, then marks it before its first await', () => {
  before(war, 'if (keeperSpawning.has(agent) || keeperHandoffs.has(agent)) return', 'keeperHandoffs.add(agent)');
  before(war, 'keeperHandoffs.add(agent)', 'await ', 'the mark is taken before the first await');
  // A PILOTED CHARACTER IS STILL NEVER HANDED OFF -- the replacement's login would bump the person.
  // Since 2026-10-07 it is not skipped either: it is replaced DORMANT (no /handoff is told), and one
  // played through the keeper's own connection is refused (m59-dormancy-shape-test.mjs pins both).
  assert.match(war, /if \(!dormantSwap && !\(await tell\(/, 'a dormant swap (every piloted character) is never told to hand off');
  assert.match(war, /if \(piloted \|\| dormancyOf\(agent\)\)/, 'and a piloted character always takes that path');
});

await test('broker: the replacement port is reserved in handoffPorts before the probe await, and taken() sees reservations', () => {
  const loopAt = war.indexOf('for (let p = band.base;');
  assert.ok(loopAt > 0, 'the port scan exists');
  const loop = block(war, loopAt);
  before(loop, 'handoffPorts.add(p);', 'await ', 'reserved before the first await in the scan');
  assert.match(loop, /else handoffPorts\.delete\(p\);/, 'a port that answers or will not bind is released at once');
  assert.match(war, /const t = new Set\(\[old\.port, \.\.\.handoffPorts\]\);/, 'taken() excludes reserved and the old port');
  before(war, 'for (let p = band.base;', 'reservedPort = port;');
});

await test('broker: the reservation and the handoff mark are released in finally', () => {
  const fin = war.lastIndexOf('} finally {');
  assert.ok(fin > 0);
  const tail = block(war, fin + 2);
  assert.match(tail, /keeperHandoffs\.delete\(agent\);/);
  assert.match(tail, /if \(reservedPort != null\) handoffPorts\.delete\(reservedPort\);/);
  // The try the finally closes opens immediately after the mark, so nothing escapes it.
  assert.match(war, /keeperHandoffs\.add\(agent\);\n\s*let child = null, reservedPort = null;\n\s*try \{/);
});

await test('broker: a replacement that is not in the world is stopped and the old keeper\'s handoff undone', () => {
  assert.match(war, /if \(!ready\) \{[\s\S]*?child\.kill\('SIGTERM'\)[\s\S]*?await undo\(\);[\s\S]*?return \{ agent, ok: false/);
  assert.match(war, /reply\.value\.in_game && reply\.value\.connected/, 'ready means in_game AND connected');
  before(war, 'if (!ready)', 'keeperProcesses.set(agent, { pid: child.pid, port', 'the swap happens only after ready');
});

await test('broker: war_restart tool requires the absolute roster path to match', () => {
  const at = broker.indexOf("name: 'war_restart'");
  assert.ok(at > 0);
  const tool = broker.slice(at, broker.indexOf("name: 'combat_order'", at));
  assert.match(tool, /required: \['fleet_state'\]/);
  assert.match(tool, /resolve\(a\.fleet_state\) !== resolve\(STATE_FILE\)/);
});

console.log(`\n${tests} passed (source-shape checks, not behaviour tests)`);
