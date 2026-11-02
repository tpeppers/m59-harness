// Offline SOURCE-SHAPE guard for keeper dormancy (m59-dormancy.mjs). The behaviour of the model is
// m59-dormancy-test.mjs; this file pins that the keeper process and the broker actually CONSULT it,
// in the places where forgetting to is the bug. Both files run on import, so -- like
// m59-handoff-shape-test.mjs -- these read the source text. Opens no socket, touches no roster.
//
//   node tools/m59-dormancy-shape-test.mjs
//
// The incident each one guards: a person who logged off to survive was logged straight back in by
// the broker's rejoin sweep onto the attacker's square, and a piloted character's keeper could not
// be put onto new code at all (2026-10-07, t20).
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
  assert.ok(from >= 0, 'anchor not found');
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
const handler = (src, path) => block(src, src.indexOf(`path === '${path}'`));

// ---------------------------------------------------------------- the keeper

await test('keeper: a dormancy handed over at spawn is read before the join intent is set', () => {
  before(keeper, 'let dormancy = decodeDormancy(process.env[DORMANCY_ENV]);', 'let joinWanted = !dormancy;');
});

await test('keeper: join() refuses while dormant, first, before any await', () => {
  const j = block(keeper, keeper.indexOf('\nasync function join()'));
  before(j, 'if (dormancy) throw', 'if (!joinWanted) throw');
  before(j, 'if (dormancy) throw', 'await ');
});

await test('keeper: the autopilot\'s own reconnect (session.rejoin) refuses while dormant', () => {
  const wrap = block(keeper, keeper.indexOf('session.rejoin = async (...args) =>'));
  before(wrap, 'if (dormancy) throw', 'return rejoinOriginal(...args)');
});

await test('keeper: /join and /rejoin refuse a dormant keeper before they change the join intent', () => {
  for (const p of ['/join', '/rejoin']) {
    const h = handler(keeper, p);
    before(h, 'refuseWhileDormant()', 'changeJoinIntent(true)', `${p} refuses before it wants in`);
  }
});

await test('keeper: the refusal is 423, never 409 (a broker retires a port that answers /rejoin with 409)', () => {
  const at = keeper.indexOf('const refuseWhileDormant = () =>');
  const fn = block(keeper, at);
  assert.match(fn, /\}, 423\);/);
  assert.doesNotMatch(fn, /409/);
});

await test('keeper: spawned dormant, it does not log in at startup', () => {
  const tail = keeper.slice(keeper.lastIndexOf('server.listen(port'));
  before(tail, 'if (dormancy) {', 'join().catch(', 'the dormant branch returns before the startup join');
  assert.match(block(tail, tail.indexOf('if (dormancy) {')), /return;/);
});

await test('keeper: /dormant and /wake exist and go through the addressed-write check', () => {
  for (const p of ['/dormant', '/wake']) assert.match(handler(keeper, p), /requireAddressedWrite\(req, asked\)/, p);
  assert.match(handler(keeper, '/dormant'), /goDormant\(rec\)/);
  assert.match(handler(keeper, '/wake'), /wakeFromDormancy\(/);
});

await test('keeper: a logoff from inside the world is recorded with the server\'s penalty window', () => {
  const g = block(keeper, keeper.indexOf('async function goDormant(rec)'));
  assert.match(g, /withLogoff\(rec, \{ at: Date\.now\(\), room, lastLoginAt, prior: lastPenalty \}\)/);
  before(g, 'const room = session.world?.room?.num', 'session.client.close()', 'the room is read before the socket goes');
});

await test('keeper: its own clock never ends a pilot wait (only the broker knows who is at the controls)', () => {
  assert.match(keeper, /dormancyVerdict\(dormancy, \{ pilotHeld: dormancy\.wake === 'pilot_released' \}\)/);
});

await test('keeper: /live carries the dormancy record, which is how the broker sees a dormant replacement', () => {
  const live = handler(keeper, '/live');
  assert.match(live, /\n\s+dormancy,\n/);
});

// ---------------------------------------------------------------- the broker

await test('broker: every keeper spawn hands over a held character\'s dormancy', () => {
  const inner = block(broker, broker.indexOf('async function spawnKeeperInner('));
  assert.match(inner, /\.\.\.dormancyEnvFor\(agent\)/);
});

await test('broker: the rejoin sweep consults dormancy before any /rejoin, and wakes only through /wake', () => {
  const sweep = block(broker, broker.indexOf('async function reconcileFleet()'));
  before(sweep, 'dormant = dormancyStore().all()', 'livenessProofs.set(', 'read before the liveness preflight runs');
  before(sweep, 'const dorm = dormant[agent];', '/rejoin`', 'the dormancy gate precedes the rejoin');
  const gate = block(sweep, sweep.indexOf('if (dorm) {'));
  assert.match(gate, /dormancyVerdict\(dorm/);
  assert.match(gate, /wakeDormant\(agent, v\.why/);
  assert.match(gate, /continue;/);
  assert.doesNotMatch(gate, /\/rejoin/);
});

await test('broker: an unreadable dormancy store stops the lap rather than rejoining blind', () => {
  const sweep = block(broker, broker.indexOf('async function reconcileFleet()'));
  assert.match(sweep, /catch \(e\) \{ console\.error\(`\[dormancy\] \$\{e\.message\} -- no rejoins this lap`\); return; \}/);
});

await test('broker: restart-keepers no longer skips a piloted character outright', () => {
  const w = block(broker, broker.indexOf(') {', broker.indexOf('async function warRestartKeeper(')));
  assert.doesNotMatch(w, /if \(pilotOf\(agent\)\) return \{ agent, ok: false, why: 'being played by a person' \};/);
  assert.match(w, /if \(piloted \|\| dormancyOf\(agent\)\)/);
});

await test('broker: a dormant swap starts dormant, is ready when dormant and OUT, and stops the old keeper', () => {
  const w = block(broker, broker.indexOf(') {', broker.indexOf('async function warRestartKeeper(')));
  // A pending successor is a dormant swap that is not swapped in: it starts dormant on a record of its
  // OWN (pendingSuccessorEnv), never the shared store's, so nothing but its take-over can wake it.
  assert.match(w, /\.\.\.\(dormantSwap \? \(pending \? pendingSuccessorEnv\(pendingDeadline\) : dormancyEnvFor\(agent\)\) : \{\}\)/,
               'only a dormant swap starts dormant');
  assert.match(w, /dormantSwap \? \(reply\.value\.dormancy && !reply\.value\.in_game\)/);
  assert.match(w, /if \(legacy \|\| dormantSwap\) await post\('\/stop', \{\}\);/);
  before(w, 'if (!dormantSwap && !(await tell(', 'const band = keeperPortBand()', 'no handoff is told on a dormant swap');
});

await test('broker: a person playing THROUGH the keeper\'s own connection is refused or deferred, never swapped', () => {
  const w = block(broker, broker.indexOf(') {', broker.indexOf('async function warRestartKeeper(')));
  // The decision is pilotedRestartPlan (runtime/pending-successors.mjs, behaviour-tested there); here, that
  // a refusal returns before anything is touched and a deferral never addresses the old keeper.
  assert.match(w, /const plan = pilotedRestartPlan\(\{ occupied: piloted, dormant: !!dormancyOf\(agent\), connected, defer: deferPiloted \}\);/);
  before(w, "if (plan.action === 'refuse') return { agent, ok: false, why: plan.why };", 'verifiedKeeperWriteTarget(agent, index)',
         'refused before anything is touched');
  assert.match(w, /const target = pending \? null : await verifiedKeeperWriteTarget\(agent, index\);/,
               'a pending successor never addresses the old keeper while it is staged');
  before(w, 'if (pending) {', 'keeperProcesses.set(agent, { pid: child.pid, port',
         'a pending successor is registered and returned BEFORE the swap, so no record ever names it');
});

await test('broker: a pending successor is invisible to the rejoin sweep and to every port allocation', () => {
  const sweep = block(broker, broker.indexOf('async function reconcileFleet()'));
  before(sweep, 'if (pendingSuccessors.has(agent)) continue;', '/rejoin`',
         'the sweep never /rejoins the OLD keeper while a successor waits for the same body');
  const alloc = block(broker, broker.indexOf(') {', broker.indexOf('async function allocateKeeperPort(')));
  assert.match(alloc, /for \(const port of pendingSuccessors\.ports\(\)\) taken\.add\(port\);/, 'its port is never offered');
  const w = block(broker, broker.indexOf(') {', broker.indexOf('async function warRestartKeeper(')));
  assert.match(w, /for \(const p of pendingSuccessors\.ports\(\)\) t\.add\(p\);/, 'nor to a handoff replacement');
  const inner = block(broker, broker.indexOf('async function spawnKeeperInner('));
  before(inner, 'live?.pending_successor', 'adopted guarded surviving', 'an orphaned successor is never adopted as a survivor');
});

await test('broker: a released pilot wakes its successor at once; only the committed owner may', () => {
  const r = block(broker, broker.indexOf('function releasePilot('));
  assert.match(r, /if \(pendingSuccessors\.has\(agent\)\) \{[\s\S]*?setImmediate\(tickPendingSuccessors\)/);
  const t = block(broker, broker.indexOf('function tickPendingSuccessors('));
  assert.match(t, /!pendingTakeoversArmed \|\| brokerStopping \|\| brokerRetired/);
  assert.match(t, /if \(!fleetClaimStillOurs\(\)\) return;/);
  assert.match(broker, /let pendingTakeoversArmed = !successorOf\(\);/, 'a warm successor broker waits for started()');
  const started = block(broker, broker.indexOf('started() {'));
  assert.match(started, /pendingTakeoversArmed = true;/);
  assert.match(broker, /put\('pendingSuccessors', pendingSuccessors\.exportSnapshot\(\)\);/, 'a live handover carries the book');
  assert.match(block(broker, broker.indexOf('async function killAllKeepers(')), /pendingSuccessors\.teardownAll\(reason\)/);
});

await test('keeper: a pending successor that never held the body leaves nothing behind in its name', () => {
  assert.match(block(keeper, keeper.indexOf('function writeAssignmentCarry(')), /if \(neverHeldBody\(\)\) return;/, 'no carry');
  assert.match(block(keeper, keeper.indexOf('function saveFinalState(')), /if \(neverHeldBody\(\)\) return false;/, 'no snapshot');
  assert.match(keeper, /if \(!neverHeldBody\(\)\) releaseSpot\(agent\);/, 'and never the OLD keeper\'s wall claim');
  const join = block(keeper, keeper.indexOf('async function joinGenerationOnce('));
  before(join, 'inGame = true;', 'everJoined = true;');
  const wake = handler(keeper, '/wake');
  before(wake, 'refreshPendingOrders()', 'wakeFromDormancy(', 'orders are re-read before the login, not after');
  assert.match(keeper, /pending_successor: neverHeldBody\(\) \? \{ deadline: PENDING_SUCCESSOR\.deadline \} : null,/);
});

await test('broker: a person logging off under a hold starts the penalty clock', () => {
  const r = block(broker, broker.indexOf('function releasePilot('));
  assert.match(r, /withLogoff\(held, \{ at: Date\.now\(\), room: null, safe: null \}\)/);
  assert.match(r, /held\.wake !== 'pilot_released'/);
});

await test('broker: the dormancy tool reads no keeper snapshot (its subject has no world)', () => {
  const list = broker.slice(broker.indexOf('const SNAPSHOT_OPTIONAL_TOOLS'), broker.indexOf('async function callTool('));
  assert.match(list, /'dormancy'/);
});

// ---------------------------------------------------------------- the staged start
// Operator, 2026-10-14: bring prod up with every keeper warm and NOBODY logged in, scout with one
// character, then log the fleet on. The whole mode is an operator dormancy written before the spawns.

await test('staged: the holds are written BEFORE the first keeper spawn, and never on an adoption', () => {
  const r = block(broker, broker.indexOf(') {', broker.indexOf('async function resumeFleet(')));
  assert.match(r, /if \(STAGED_START && !adopting\) \{/);
  before(r, 'stageRoster(', 'await Promise.all(Array.from({ length: Math.min(CONCURRENCY', 'held before any keeper starts');
});

await test('staged: an existing dormancy is never overwritten by a staged hold', () => {
  const s = block(broker, broker.indexOf('function stageRoster('));
  before(s, 'if (dormancyStore().get(agent)) continue;', 'dormancyStore().set(agent', 'look before writing');
  assert.match(s, /reason: 'operator', wake: 'manual', by: STAGED_BY/);
});

await test('staged: start_all wakes only staged holds, through wakeDormant, and never bumps a pilot', () => {
  const s = block(broker, broker.indexOf(') {', broker.indexOf('async function startStaged(')));
  assert.match(s, /rec\?\.by === STAGED_BY/);
  assert.match(s, /wakeDormant\(agent, /);
  assert.doesNotMatch(s, /\/rejoin/);
  // A spectate keeper holding the body (m59-spectate-route.mjs) is occupied the same way as a pilot.
  assert.match(s, /const work = staged\.filter\(agent => !pilotOf\(agent\)(?: && !spectateHolds\(agent\))?\);/);
  assert.match(s, /reason: 'pilot'/, 'a piloted staged hold becomes a pilot wait');
  assert.match(s, /M59_KEEPER_CONCURRENCY/, 'woken in lanes, not all at once');
});

await test('staged: the dormancy tool offers start_all, and /health says how many are still staged', () => {
  assert.match(broker, /enum: \['list', 'hold', 'wake', 'start_all'\]/);
  assert.match(broker, /if \(a\.action === 'start_all'\) return startStaged\(/);
  assert.match(block(broker, broker.indexOf('function brokerHealth(')), /staged: \{ requested: STAGED_START, held: stagedCount\(\) \}/);
});

console.log(`\n${tests} passed, 0 failed`);
