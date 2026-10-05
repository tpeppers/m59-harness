#!/usr/bin/env node
// THE MOVEMENT TRACER IS OFF, AND THIS IS WHAT KEEPS IT OFF.
//
//   node tools/m59-collision-trace-test.mjs
//
// Offline. No socket, no broker, no roster.
//
// WHAT THIS GUARDS, AND WHY IT IS A TEST RATHER THAN A CONVENTION. `m59-collision-trace.mjs`
// writes one line per move attempt. Twenty-one characters crossing the map produce thousands
// a minute, and the write sits inside `Session.step` — the tightest loop in the harness, the
// one whose cost is measured in whether a character outruns what is chewing on it.
//
// It is meant to be switched on in the ENVIRONMENT, for one run, while somebody is watching:
//
//   M59_COLLISION_TRACE=1 node tools/m59-service.mjs restart --fleet shadow --http 8971 --dashboard 8972
//   node tools/m59-collision-trace.mjs
//
// The failure this exists to prevent is the ordinary one: somebody debugging flips the
// default in the source to save typing, it works, and it gets committed. Nothing would fail,
// nothing would look wrong, and every fleet from then on would pay for an instrument nobody
// was reading. So the DEFAULT is asserted, not trusted — turning it on has to be a thing you
// do to a shell, and it cannot be done to the repository.
//
// It should fail the day the trace is left on.

import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A SCRATCH PATH, AND IT MUST BE SET BEFORE THE TRACER IS IMPORTED — which it is, because
// the tracer is only ever loaded by the dynamic `import()` further down.
//
// Proving "off writes nothing" means deleting the file first and checking it does not come
// back. Pointed at the fleet's own trace, that deletes a capture that is IN PROGRESS: it
// happened mid-run and took the movement record of a fleet crossing with it. Same pattern
// m59-collision-test.mjs already uses for the tactics and crossings books.
process.env.M59_COLLISION_TRACE_FILE =
  join(tmpdir(), `m59-collision-trace-test-${process.pid}.jsonl`);

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};
let freshImport = 0;
const enabledTracer = async (traceFile, pendingMax, maxLines = 100) => {
  process.env.M59_COLLISION_TRACE = '1';
  process.env.M59_COLLISION_TRACE_FILE = traceFile;
  process.env.M59_COLLISION_TRACE_MAX = String(maxLines);
  process.env.M59_COLLISION_TRACE_PENDING_MAX = String(pendingMax);
  return import(`./m59-collision-trace.mjs?enabled=${process.pid}-${++freshImport}`);
};
const readRows = traceFile => readFileSync(traceFile, 'utf8').split('\n')
  .filter(Boolean).map(line => JSON.parse(line));

const SRC = readFileSync(join(HERE, 'm59-collision-trace.mjs'), 'utf8');
// THE SESSION MOVED. queueValidatedMove lives in m59-game.mjs in this checkout -- the
// keeper split took it out of the broker so a keeper process need not load the gateway.
// Upstream still has it in the broker, so this path is one of the few places our
// architecture is visible to a test of theirs. Same fix as m59-collision-test's, and the
// same failure shape: a suite bound to which FILE code lives in goes quiet when it moves.
const BROKER = readFileSync(join(HERE, 'm59-game.mjs'), 'utf8');
const WALK = readFileSync(join(HERE, 'm59-session-walk.mjs'), 'utf8');
const SESSION = BROKER + '\n' + WALK;
const BROKER_GATEWAY = readFileSync(join(HERE, 'm59-broker.mjs'), 'utf8');

console.log('');
console.log('the default is off, in the source');
{
  // Asserted against the SOURCE rather than the imported value, because this process could
  // itself be running with the variable set — a test that reads its own environment would
  // pass or fail on how it happened to be invoked, which is not a fact about the repository.
  const line = SRC.split('\n').find(l => /export const COLLISION_TRACE\s*=/.test(l)) ?? '';
  ok('COLLISION_TRACE is declared', !!line, JSON.stringify(line));
  ok('and it is decided by the ENVIRONMENT, not by a literal in the file',
     /process\.env\.M59_COLLISION_TRACE\s*===\s*'1'/.test(line), JSON.stringify(line));
  // The two ways it gets left on: `= true`, or an env test with a truthy fallback.
  ok('it is not hardcoded true', !/export const COLLISION_TRACE\s*=\s*true/.test(SRC));
  ok('and there is no default that makes an unset variable mean ON',
     !/M59_COLLISION_TRACE\s*(\?\?|\|\|)\s*(1|'1'|true)/.test(SRC), 'a fallback would switch it on everywhere');
}

console.log('');
console.log('and with it off, tracing costs nothing and writes nothing');
{
  // Imported fresh with the variable explicitly cleared, so this is the real function.
  delete process.env.M59_COLLISION_TRACE;
  const mod = await import('./m59-collision-trace.mjs?off=' + Date.now());
  ok('COLLISION_TRACE reads false with the variable unset', mod.COLLISION_TRACE === false);
  // The point is that it returns before touching the filesystem. If it did not, this would
  // create the trace file as a side effect of running the test suite.
  let threw = null;
  try { mod.traceMove({ agent: 'nobody', room: 1, sent: false, reason: 'test' }); }
  catch (e) { threw = e.message; }
  ok('traceMove is a silent no-op rather than a throw', threw === null, String(threw));
  try { mod.traceWireMove(null); }
  catch (e) { threw = e.message; }
  ok('the production wire emitter is also a silent no-op before row construction',
     threw === null, String(threw));
  const poison = new Proxy({}, { get() { throw new Error('detail object was inspected'); } });
  try { mod.traceUnsafeWireMove(poison); }
  catch (e) { threw = e.message; }
  ok('the unsafe wire emitter is the same cheap no-op before touching its detail object',
     threw === null, String(threw));
  // Cleared FIRST, then asserted. Reading a file a previous run may have left behind makes
  // this assert on the machine's history rather than on the code, and it fails in the
  // confusing direction — the guard looks broken when what actually happened is that it
  // worked earlier. Found by flipping the default on to check this suite catches it: the
  // flipped run wrote a line, and the restored run then failed on the leftover.
  const { existsSync, unlinkSync } = await import('node:fs');
  if (existsSync(mod.TRACE_FILE)) unlinkSync(mod.TRACE_FILE);
  mod.traceMove({ agent: 'nobody', room: 1, sent: false, reason: 'test' });
  ok('and it wrote no trace file at all', !existsSync(mod.TRACE_FILE));
}

console.log('');
console.log('the broker calls it, and calls it where it is safe to');
{
  ok('the broker imports the tracer', /from '\.\/m59-collision-trace\.mjs'/.test(BROKER));
  ok('and traces move attempts', /traceMove\(\{/.test(SESSION));
  // THE PLACEMENT RULE. `queueValidatedMove` and `validateFineTarget` are lifted out of the
  // broker BY TEXT and evaluated by m59-collision-test.mjs, so a call inside either of them
  // becomes a free identifier in that eval and throws ReferenceError there while working in
  // the broker. Tracing therefore happens at the CALL SITES. This is not hypothetical: the
  // first wiring of this tracer put a call inside `Session.step`'s reach and the dependency
  // map caught it immediately.
  const queueStart = BROKER.indexOf('async queueValidatedMove');
  const queueEnd = BROKER.indexOf('\n  // ONE SQUARE', queueStart);
  const inside = BROKER.slice(queueStart, queueEnd);
  ok('but never from inside queueValidatedMove, which is lifted by text elsewhere',
     !/traceMove\(/.test(inside));
  const sends = [...inside.matchAll(/\bc\.moveTo\(/g)].map(match => match.index);
  const wireRows = [...inside.matchAll(/this\.recordValidatedWireMove\?\.\(\{/g)]
    .map(match => match.index);
  ok('both validated packet branches emit one wire row after their synchronous send',
     sends.length === 2 && wireRows.length === 2 &&
       wireRows.every((offset, index) => offset > sends[index]),
     JSON.stringify({ sends, wireRows }));
  ok('the non-lifted Session helper owns the production wire emitter import',
     /recordValidatedWireMove\([\s\S]{0,1600}?traceWireMove\(\{/.test(BROKER));
  ok('a separate Session helper owns the unsafe emitter and cannot use the validated one',
     /recordUnsafeWireMove\([\s\S]{0,1800}?traceUnsafeWireMove\(\{/.test(BROKER));

  // SOURCE-WIDE SEND ACCOUNTING. The queue test above protects the two ordinary branches,
  // but keeper mode and the explicit exit fallback have their own raw socket writes. A new
  // moveTo anywhere in Session must make this count/pairing fail until its post-send row is
  // classified. Looking only inside queueValidatedMove is how those two bypasses went dark.
  const sendSites = [...SESSION.matchAll(/\.moveTo\(/g)]
    .map(match => ({ offset: match.index, line: SESSION.slice(0, match.index).split('\n').length,
      call: match[0] }));
  const emitters = [...SESSION.matchAll(
    /this\.(recordValidatedWireMove|recordUnsafeWireMove)(?:\?\.)?\(\{/g)]
    .map(match => ({ offset: match.index,
      kind: match[1] === 'recordValidatedWireMove' ? 'validated' : 'unsafe' }));
  const accounting = sendSites.map((send, index) => {
    const nextSend = sendSites[index + 1]?.offset ?? SESSION.length;
    const after = emitters.filter(emitter => emitter.offset > send.offset && emitter.offset < nextSend);
    return { line: send.line, call: send.call, rows: after.map(emitter => emitter.kind) };
  });
  ok('every actual moveTo send has exactly one explicit post-send wire row',
     sendSites.length === 3 && emitters.length === 3 &&
       accounting.every(entry => entry.rows.length === 1), JSON.stringify(accounting));
  ok('only the two validator-owned sends claim validation; the exit fallback is unsafe',
     accounting.map(entry => entry.rows[0]).join(',') ===
       'validated,validated,unsafe', JSON.stringify(accounting));
  ok('raw send rows carry stable machine-rejectable fallback reasons',
     /c\.moveTo\([\s\S]{0,900}?unsafeReason:\s*'exit_unvalidated_fallback'/.test(WALK));
  ok('successful validation retains the exact dynamic trace options for offline replay',
     /trace_options:\s*traceOptions/.test(BROKER));
  // Whatever it does record must not be a live object id — those are renumbered on every
  // system save, so a trace keyed on one is unreadable by the time anybody reads it.
  const calls = SESSION.match(/traceMove\(\{[\s\S]*?\}\);/g) ?? [];
  ok('there is at least one traced call site', calls.length >= 1, String(calls.length));
  ok('and every one records the ROOM NUMBER, never the room object id',
     calls.every(c => /room:\s*this\.world\?\.room\?\.num/.test(c)),
     calls.find(c => !/room:\s*this\.world\?\.room\?\.num/.test(c)) ?? '');
  // A post-run verifier cannot trust a flag typed after the capture.  The broker's
  // health record must publish the effective process setting so a saved matrix report
  // can prove the permissive fallback was off while the packets were sent.
  ok('and health publishes the broker process\'s effective exit-fallback setting',
     /movement_policy:\s*\{[\s\S]{0,200}exit_fallback_enabled:\s*process\.env\.M59_EXIT_FALLBACK\s*===\s*'1'/.test(BROKER_GATEWAY));
}

console.log('');
console.log('the production emitter writes the replayable wire schema');
{
  const scratch = mkdtempSync(join(tmpdir(), 'm59-collision-trace-wire-'));
  const traceFile = join(scratch, 'trace.jsonl');
  writeFileSync(traceFile, '');
  const mod = await enabledTracer(traceFile, 8);
  const traceOptions = {
    slide: true,
    fall: false,
    obstacles: [{ id: 901, x: 320, y: 448 }],
    roomFlags: 17,
    overrideDepths: [0, 64],
    motionZ: { min: 128, max: 256 },
  };
  const validation = {
    available: true,
    moved: true,
    arrived: true,
    blocked: false,
    slid: false,
    requested: { x: 832, y: 960 },
    target: { x: 800, y: 960 },
    trace_options: traceOptions,
  };
  const fixture = {
    agent: 'route-01',
    roomNum: 587,
    roomId: 7424,
    liveSecurity: 0x1234567,
    bakedSecurity: 0x1234567,
    from: { x: 704, y: 960 },
    requested: validation.requested,
    to: validation.target,
    speed: 18,
    slide: true,
    fall: false,
    offMap: false,
    traceOptions,
    validation,
  };
  const built = mod.wireMoveRow(fixture);
  ok('the pure builder identifies a sent m59-wire-move/1 row',
     built.schema === 'm59-wire-move/1' && built.kind === 'wire_move' && built.sent === true,
     JSON.stringify(built));
  ok('it records the stable room number, transient id, and live/baked security pair',
     built.room?.num === 587 && built.room?.id === 7424 &&
       built.room?.live_security === 0x1234567 && built.room?.baked_security === 0x1234567,
     JSON.stringify(built.room));
  ok('it records exact from, requested, and wire endpoint coordinates',
     JSON.stringify([built.from, built.requested, built.to]) ===
       JSON.stringify([fixture.from, fixture.requested, fixture.to]));
  ok('it records actual speed, movement mode, dynamic options, and sender validation',
     built.speed === 18 && built.mode?.off_map === false && built.mode?.slide === true &&
       built.mode?.fall === false && built.trace_options === traceOptions &&
       built.validation === validation, JSON.stringify(built));

  mod.traceWireMove(fixture);
  const rows = readRows(traceFile);
  ok('the same production emitter used by Session writes that schema to the real tracer',
     rows.length === 1 && rows[0]?.schema === 'm59-wire-move/1' &&
       rows[0]?.kind === 'wire_move' && rows[0]?.seq === 1 &&
       rows[0]?.room?.num === 587 && rows[0]?.room?.id === 7424,
     JSON.stringify(rows));

  const offMap = mod.wireMoveRow({
    ...fixture,
    requested: { x: 0, y: 960 },
    to: { x: 0, y: 960 },
    speed: 0,
    slide: false,
    offMap: true,
    traceOptions,
    validation: {
      ...validation,
      requested: { x: 0, y: 960 },
      target: { x: 0, y: 960 },
      offMap: true,
    },
  });
  ok('off-map rows expose the fixed zero-speed/no-slide contract and no dynamic options',
     offMap.speed === 0 && offMap.mode?.off_map === true && offMap.mode?.slide === false &&
       offMap.mode?.fall === false && offMap.trace_options === null &&
       offMap.validation?.offMap === true, JSON.stringify(offMap));

  const unsafeFixture = {
    ...fixture,
    requested: { x: 0, y: 960 },
    to: { x: 0, y: 960 },
    speed: 0,
    slide: false,
    offMap: true,
    unsafeReason: 'exit_unvalidated_fallback',
    // Even a prior successful-looking object may only be context. It must never become the
    // packet's validation merely because a caller supplied it.
    priorValidation: validation,
  };
  const unsafe = mod.unsafeWireMoveRow(unsafeFixture);
  ok('the unsafe builder emits an explicit sent wire row which the verifier rejects',
     unsafe.schema === 'm59-wire-move/1' && unsafe.kind === 'wire_move' &&
       unsafe.sent === true && unsafe.unsafe === true && unsafe.unvalidated === true &&
       unsafe.fallback === true && unsafe.unsafe_reason === 'exit_unvalidated_fallback',
     JSON.stringify(unsafe));
  ok('an unsafe row can never inherit a validated label from the bypassed attempt',
     unsafe.validation?.available === false && unsafe.validation?.moved === false &&
       unsafe.validation?.arrived === false &&
       unsafe.validation?.reason === 'exit_unvalidated_fallback' &&
       unsafe.validation !== validation && unsafe.prior_validation === validation,
     JSON.stringify(unsafe));
  ok('the unsafe row preserves the exact packet endpoint, speed, and off-map mode',
     JSON.stringify(unsafe.from) === JSON.stringify(fixture.from) &&
       JSON.stringify(unsafe.requested) === JSON.stringify(unsafeFixture.requested) &&
       JSON.stringify(unsafe.to) === JSON.stringify(unsafeFixture.to) &&
       unsafe.speed === 0 && unsafe.mode?.off_map === true &&
       unsafe.mode?.slide === false && unsafe.mode?.fall === false,
     JSON.stringify(unsafe));
  mod.traceUnsafeWireMove(unsafeFixture);
  const unsafeRows = readRows(traceFile);
  ok('the production unsafe emitter appends that rejecting row after the validated row',
     unsafeRows.length === 2 && unsafeRows[1]?.seq === 2 &&
       unsafeRows[1]?.unsafe === true && unsafeRows[1]?.unvalidated === true &&
       unsafeRows[1]?.fallback === true, JSON.stringify(unsafeRows));
  rmSync(scratch, { recursive: true, force: true });
}

console.log('');
console.log('trace captures are private on POSIX');
{
  const scratch = mkdtempSync(join(tmpdir(), 'm59-collision-trace-mode-'));
  const created = join(scratch, 'created.jsonl');
  const createTracer = await enabledTracer(created, 2);
  createTracer.traceMove({ agent: 'created', kind: 'step', sent: true });
  const createdMode = process.platform === 'win32' ? null : statSync(created).mode & 0o777;
  ok('a newly created capture is mode 0600 on POSIX',
     process.platform === 'win32' || createdMode === 0o600,
     process.platform === 'win32' ? 'POSIX mode bits do not apply on Windows' : createdMode.toString(8));

  const existing = join(scratch, 'existing.jsonl');
  writeFileSync(existing, '');
  if (process.platform !== 'win32') chmodSync(existing, 0o666);
  const appendTracer = await enabledTracer(existing, 2);
  appendTracer.traceMove({ agent: 'appended', kind: 'step', sent: true });
  const existingMode = process.platform === 'win32' ? null : statSync(existing).mode & 0o777;
  ok('appending repairs an existing permissive capture to mode 0600 on POSIX',
     process.platform === 'win32' || existingMode === 0o600,
     process.platform === 'win32' ? 'POSIX mode bits do not apply on Windows' : existingMode.toString(8));
  ok('privacy repair does not lose the appended row',
     readRows(existing).map(row => row.agent).join(',') === 'appended');
  rmSync(scratch, { recursive: true, force: true });
}

console.log('');
console.log('failed appends recover the original rows, once and in order');
{
  const scratch = mkdtempSync(join(tmpdir(), 'm59-collision-trace-recovery-'));
  const traceFile = join(scratch, 'trace.jsonl');
  const mod = await enabledTracer(traceFile, 8);
  // The trace pathname itself is a directory, so appendFileSync fails with EISDIR while
  // mkdirSync(dirname(traceFile)) still succeeds. Create it AFTER initialization proved the
  // capture absent: an already-existing unreadable path may hide old rows and must fail closed.
  mkdirSync(traceFile);
  const realNow = Date.now;
  const times = [1_001, 1_002, 1_003];
  try {
    Date.now = () => times.shift();
    mod.traceMove({ agent: 'first', kind: 'step', at: 'caller', seq: 91 });
    mod.traceMove({ agent: 'second', kind: 'step', at: 'caller', seq: 92 });
    // Replace the failing destination with the file an operator would have repaired.
    rmSync(traceFile, { recursive: true, force: true });
    writeFileSync(traceFile, '');
    mod.traceMove({ agent: 'third', kind: 'step', at: 'caller', seq: 93 });
  } finally {
    Date.now = realNow;
  }
  const rows = readRows(traceFile);
  ok('two failed writes and the recovery produce exactly three rows', rows.length === 3,
     JSON.stringify(rows));
  ok('recovery preserves attempt order and writes every row exactly once',
     rows.map(r => r.agent).join(',') === 'first,second,third', JSON.stringify(rows));
  ok('the sequence is monotonic and cannot be supplied by the caller',
     rows.map(r => r.seq).join(',') === '1,2,3', JSON.stringify(rows.map(r => r.seq)));
  ok('queued rows retain their original timestamps rather than recovery time',
     rows.map(r => r.at).join(',') === '1001,1002,1003', JSON.stringify(rows.map(r => r.at)));
  rmSync(scratch, { recursive: true, force: true });
}

console.log('');
console.log('bounded recovery makes an overflow durably visible');
{
  const scratch = mkdtempSync(join(tmpdir(), 'm59-collision-trace-overflow-'));
  const traceFile = join(scratch, 'trace.jsonl');
  const mod = await enabledTracer(traceFile, 2);
  mkdirSync(traceFile);
  const realNow = Date.now;
  const times = [2_001, 2_002, 2_003, 2_004, 2_005];
  try {
    Date.now = () => times.shift();
    for (const agent of ['one', 'two', 'three', 'four'])
      mod.traceMove({ agent, kind: 'step', sent: true });
    rmSync(traceFile, { recursive: true, force: true });
    writeFileSync(traceFile, '');
    mod.traceMove({ agent: 'five', kind: 'step', sent: true });
  } finally {
    Date.now = realNow;
  }
  const rows = readRows(traceFile);
  const marker = rows[2];
  ok('the bounded queue retains its two oldest rows and the recovery row once',
     rows.map(r => r.agent ?? r.kind).join(',') === 'one,two,trace_loss,five',
     JSON.stringify(rows));
  ok('the loss marker replaces the first unavailable sequence and exposes the whole gap',
     marker?.schema === 'm59-collision-trace-loss/1'
       && marker?.seq === 3 && marker?.at === 2_003 && marker?.lostFromSeq === 3
       && marker?.lostThroughSeq === 4 && marker?.lostCount === 2
       && marker?.reason === 'pending_queue_overflow', JSON.stringify(marker));
  ok('the next durable row leaves the matching monotonic sequence gap',
     rows.map(r => r.seq).join(',') === '1,2,3,5', JSON.stringify(rows.map(r => r.seq)));
  rmSync(scratch, { recursive: true, force: true });
}

console.log('');
console.log('an unreadable existing capture fails closed');
{
  const scratch = mkdtempSync(join(tmpdir(), 'm59-collision-trace-unreadable-'));
  const traceFile = join(scratch, 'trace.jsonl');
  // A directory at the exact pathname is a portable EISDIR stand-in for existing bytes the
  // tracer cannot inspect. Repairing it later must not cause a fresh seq 1 append behind the
  // unknown capture.
  mkdirSync(traceFile);
  const mod = await enabledTracer(traceFile, 2);
  rmSync(traceFile, { recursive: true, force: true });
  writeFileSync(traceFile, '');
  mod.traceMove({ agent: 'must-not-append', kind: 'step', sent: true });
  ok('repairing an unreadable existing path does not start an ambiguous capture',
     readFileSync(traceFile, 'utf8') === '');
  rmSync(scratch, { recursive: true, force: true });
}

console.log('');
console.log('the physical line cap ends with a durable open loss range');
{
  const scratch = mkdtempSync(join(tmpdir(), 'm59-collision-trace-cap-'));
  const traceFile = join(scratch, 'trace.jsonl');
  writeFileSync(traceFile, '');
  const mod = await enabledTracer(traceFile, 2, 3);
  const realNow = Date.now;
  const times = [3_001, 3_002, 3_003];
  try {
    Date.now = () => times.shift();
    mod.traceMove({ agent: 'one', kind: 'step', sent: true });
    mod.traceMove({ agent: 'two', kind: 'step', sent: true });
    mod.traceMove({ agent: 'omitted', kind: 'step', sent: true });
    // Further attempts retry a failed marker if necessary, but may never duplicate it.
    mod.traceMove({ agent: 'also-omitted', kind: 'step', sent: true });
  } finally {
    Date.now = realNow;
  }
  const rows = readRows(traceFile);
  const marker = rows[2];
  ok('the configured maximum remains a physical line bound', rows.length === 3,
     JSON.stringify(rows));
  ok('the last line explicitly marks every attempt from the cap onward as unavailable',
     marker?.schema === 'm59-collision-trace-loss/1' && marker?.kind === 'trace_loss'
       && marker?.reason === 'max_lines_reached' && marker?.seq === 3
       && marker?.at === 3_003 && marker?.lostFromSeq === 3
       && marker?.lostThroughSeq === null && marker?.lostCount === null,
     JSON.stringify(marker));
  ok('calls beyond the cap cannot duplicate its durable marker',
     rows.filter(r => r.reason === 'max_lines_reached').length === 1, JSON.stringify(rows));
  rmSync(scratch, { recursive: true, force: true });
}

console.log('');
console.log('a supervised restart resumes one bounded capture');
{
  const scratch = mkdtempSync(join(tmpdir(), 'm59-collision-trace-restart-'));
  const traceFile = join(scratch, 'trace.jsonl');
  writeFileSync(traceFile, '');
  const first = await enabledTracer(traceFile, 2, 4);
  first.traceMove({ agent: 'one', kind: 'step', sent: true });
  first.traceMove({ agent: 'two', kind: 'step', sent: true });

  const restarted = await enabledTracer(traceFile, 2, 4);
  restarted.traceMove({ agent: 'three', kind: 'step', sent: true });
  restarted.traceMove({ agent: 'omitted', kind: 'step', sent: true });

  // A later restart sees the durable open-ended marker and cannot append behind it.
  const afterCap = await enabledTracer(traceFile, 2, 4);
  afterCap.traceMove({ agent: 'also-omitted', kind: 'step', sent: true });
  const rows = readRows(traceFile);
  ok('a restart continues the existing monotonic sequence',
     rows.map(row => row.seq).join(',') === '1,2,3,4', JSON.stringify(rows));
  ok('the cap remains a physical bound across process restarts',
     rows.length === 4 && rows[3]?.reason === 'max_lines_reached', JSON.stringify(rows));
  ok('nothing is appended after the open-ended cap marker',
     rows.filter(row => row.agent === 'also-omitted').length === 0, JSON.stringify(rows));
  rmSync(scratch, { recursive: true, force: true });
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
