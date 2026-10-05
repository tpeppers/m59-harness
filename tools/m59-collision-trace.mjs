// Full disk debugging trace is off unless explicitly enabled. A small bounded
// attempt window stays in memory for movement incidents and death captures.
//
//   M59_COLLISION_TRACE=1 node tools/m59-service.mjs restart --fleet shadow --http 8971 ...
//   node tools/m59-collision-trace.mjs            read back what it caught
//   node tools/m59-collision-trace.mjs --clear
//
// THE QUESTION IT EXISTS TO ANSWER. A character reads `! NOT MOVING — travelling, same
// square two pulses apart` for four hundred seconds, and from outside there is no way to
// tell the two possibilities apart: it is either SENDING NOTHING — every candidate step
// refused by the local validator, so no packet ever leaves — or it is LOOPING, sending
// steps that go out and land nowhere. Those want opposite fixes, and every instrument in
// the harness reads the same for both, because both look like a body that has not moved.
//
// So this records the one event that separates them: every move attempt, whether a packet
// was SENT, and the validator's reason when it was not.
//
// WHY IT IS SAFE TO HAVE AT ALL. The server does no geometry check on a player move —
// room.kod's own comment on `UserMove` is "already been checked by client (HAHA!)" — so
// the refusals recorded here are entirely OUR OWN, produced locally by `validateFineTarget`
// against baked geometry. Tracing them costs one appended line and reaches no socket.
//
// ============================ IT MUST BE OFF WHEN COMMITTED ============================
//
// This writes a line per move attempt. A fleet of twenty-one crossing the map produces
// thousands a minute, and left on it is an unbounded file and a measurable cost inside the
// one loop that has to stay fast. `m59-collision-trace-test.mjs` fails if the default in
// this file is anything but off, so it cannot be left switched on by an edit — turning it
// on is a thing you do in the ENVIRONMENT, for one run, and never in the source.

import {
  appendFileSync, closeSync, existsSync, fchmodSync, mkdirSync, openSync,
  readFileSync, unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
// OVERRIDABLE, SO A TEST NEVER TOUCHES A LIVE CAPTURE.
//
// `m59-collision-trace-test.mjs` proves that tracing writes NOTHING when it is off, and the
// only honest way to prove that is to check the file does not appear — which means deleting
// it first. Pointed at the real path, that test deletes an in-progress trace: it happened,
// mid-run, and took the movement record of a fleet crossing with it. The suite points this
// at a scratch file instead. Same pattern m59-collision-test.mjs already uses for the
// tactics and crossings books.
export const TRACE_FILE = process.env.M59_COLLISION_TRACE_FILE
  || join(REPO, 'substrate', 'collision-trace.jsonl');

// THE DEFAULT, AND THE ONLY THING THE TEST CARES ABOUT. Read once: this is consulted in a
// hot loop, and re-reading process.env per move is itself a cost worth not paying.
export const COLLISION_TRACE = process.env.M59_COLLISION_TRACE === '1';

// Always retain a small in-memory window for incident/death capture. The full
// disk trace remains opt-in. This records local attempts, not server arrivals.
const attemptWindows=new Map(),ATTEMPT_WINDOW=32,MAX_WINDOW_AGENTS=64;
const point=p=>p&&typeof p==='object'?Object.fromEntries(['row','col','x','y'].filter(k=>Number.isFinite(p[k])).map(k=>[k,p[k]])):null;
const finite=v=>Number.isFinite(v)?v:null;
function rememberAttempt(d,at) {
  if(typeof d?.agent!=='string'||!d.agent)return;
  const key=d.agent.slice(0,80);
  if(!attemptWindows.has(key)&&attemptWindows.size>=MAX_WINDOW_AGENTS)attemptWindows.delete(attemptWindows.keys().next().value);
  const w=attemptWindows.get(key)??{total:0,attempts:[]};
  w.attempts.push({at,seq:++w.total,kind:String(d.kind??'unknown').slice(0,40),
    room:finite(typeof d.room==='number'?d.room:d.room?.num),
    from:point(d.from??d.fine),square:point(d.square),requested:point(d.requested??d.aimed??d.target),
    to:point(d.to),sent:typeof d.sent==='boolean'?d.sent:null,
    reason:String(d.reason??d.validation?.reason??'').slice(0,160)||null,
    object_id:finite(d.objectId??d.validation?.objectId),
    movement_generation:finite(d.movement_generation),
    blocked:typeof d.validation?.blocked==='boolean'?d.validation.blocked:null,
    slid:typeof d.validation?.slid==='boolean'?d.validation.slid:null});
  if(w.attempts.length>ATTEMPT_WINDOW)w.attempts.shift();attemptWindows.set(key,w);
}
export function recentMoveAttempts(agent) {
  const w=attemptWindows.get(agent);
  return {scope:'process-local bounded local attempts; sent does not confirm arrival',
    units:'named square row/col; fine x/y in KOD/protocol units (64 per square)',
    evicted:w?w.total-w.attempts.length:0,attempts:structuredClone(w?.attempts??[])};
}

// THE ROW THE OFFLINE VERIFIER REPLAYS. Keep construction separate from writing so the
// contract can be exercised without a socket or a trace file. `room.num` is the stable map
// identity; `room.id` is deliberately retained only as diagnostic evidence because a save
// renumbers live objects. The security pair binds that stable number to both the room
// version announced by the server and the exact baked geometry used by the validator.
export const WIRE_MOVE_SCHEMA = 'm59-wire-move/1';

const wirePoint = point => ({ x: point?.x, y: point?.y });

export function wireMoveRow({
  agent, roomNum, roomId, liveSecurity, bakedSecurity,
  from, requested, to, speed, slide = false, fall = false, offMap = false,
  traceOptions = null, validation = null,
} = {}) {
  return {
    schema: WIRE_MOVE_SCHEMA,
    kind: 'wire_move',
    agent,
    room: {
      num: roomNum,
      id: roomId,
      live_security: liveSecurity,
      baked_security: bakedSecurity,
    },
    from: wirePoint(from),
    requested: wirePoint(requested),
    to: wirePoint(to),
    speed,
    mode: { off_map: offMap === true, slide: slide === true, fall: fall === true },
    // An outward boundary packet has a stricter fixed replay contract instead of the
    // ordinary dynamic options. Null makes that distinction explicit and machine-checkable.
    trace_options: offMap === true ? null : traceOptions,
    validation,
    sent: true,
  };
}

// A raw keeper/exit fallback is still a packet and therefore still belongs in the wire
// proof.  It must never be able to borrow the validated builder's shape, though: the
// offline verifier intentionally rejects either of these flags (and the reason) before it
// considers geometry.  Keep the failed validation which led to the bypass as evidence,
// but describe the packet itself as having had no sender-side validation.
export function unsafeWireMoveRow({
  unsafeReason = 'unvalidated_fallback', priorValidation = null, ...detail
} = {}) {
  const requested = wirePoint(detail.requested);
  const target = wirePoint(detail.to);
  return {
    ...wireMoveRow({
      ...detail,
      validation: {
        available: false,
        moved: false,
        arrived: false,
        // Null is evidence that no answer exists, rather than a false claim that the
        // bypassed packet was checked and found clear/non-sliding.
        blocked: null,
        slid: null,
        offMap: detail.offMap === true,
        requested,
        target,
        reason: unsafeReason,
      },
    }),
    unsafe: true,
    unvalidated: true,
    fallback: true,
    unsafe_reason: unsafeReason,
    prior_validation: priorValidation,
  };
}

// A bound, because an unbounded debug file on a machine that is also running the fleet is
// a way to fill a disk while looking like nothing is happening.
const configuredMaxLines = Number(process.env.M59_COLLISION_TRACE_MAX || 200_000);
const MAX_LINES = Number.isSafeInteger(configuredMaxLines) && configuredMaxLines > 0
  ? configuredMaxLines : 200_000;
// Reserve the final physical line for a durable cap marker. Without it, a file that stops
// cleanly at the configured bound is indistinguishable from a complete capture.
const MAX_ATTEMPTS = Math.max(0, MAX_LINES - 1);
// A failed destination must not turn this diagnostic into an unbounded memory sink. Keep
// the oldest rows: if this fills, their successors are represented by one loss marker on
// recovery, preserving the order on either side of the gap.
// Pending rows are process-local: a hard process death while the destination is unavailable
// can lose them before a marker is durable. Restart handling below preserves the numbering
// and cap of durable rows; it does not claim to reconstruct memory from a dead process.
const configuredPending = Number(process.env.M59_COLLISION_TRACE_PENDING_MAX || 4_096);
const MAX_PENDING = Number.isSafeInteger(configuredPending) && configuredPending > 0
  ? configuredPending : 4_096;
let attempted = 0;
let pending = [];
let loss = null;
let capLine = '';
let capWritten = false;
let resumeProblem = null;
let complained = false;
let complainedLoss = false;

// A trace file is one bounded capture even when the supervised broker restarts. Continue
// its logical sequence and remaining line budget instead of appending a second `seq: 1`
// run after an open-ended cap marker. A malformed/partial tail cannot be repaired safely by
// appending more bytes, so it fails closed until the operator clears the diagnostic file.
function resumeExistingCapture() {
  if (!COLLISION_TRACE) return;
  let text;
  try { text = readFileSync(TRACE_FILE, 'utf8'); }
  catch (error) {
    // A confirmed absence is a fresh capture. Anything else means bytes may already exist
    // behind a permission error, lock, directory, or device failure; assigning seq 1 there
    // would make a later recovery look complete while exceeding the prior capture's cap.
    if (error?.code === 'ENOENT') return;
    resumeProblem = 'existing trace could not be inspected; clear or repair it before tracing again';
    return;
  }
  if (!text) return;
  if (!text.endsWith('\n')) {
    resumeProblem = 'existing trace has a partial final line; clear it before tracing again';
    return;
  }
  const lines = text.split('\n').filter(Boolean);
  let highestSeq = 0;
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); }
    catch {
      resumeProblem = 'existing trace contains malformed JSON; clear it before tracing again';
      return;
    }
    if (Number.isSafeInteger(row?.seq) && row.seq > highestSeq) highestSeq = row.seq;
    if (Number.isSafeInteger(row?.lostThroughSeq) && row.lostThroughSeq > highestSeq)
      highestSeq = row.lostThroughSeq;
    if (row?.schema === 'm59-collision-trace-loss/1'
        && row?.reason === 'max_lines_reached' && row?.lostThroughSeq === null)
      capWritten = true;
  }
  // `lines.length` also handles captures written before sequence numbers existed and makes
  // a previously reset/duplicated sequence conservative rather than repeating it again.
  attempted = Math.max(highestSeq, lines.length);
  if (lines.length >= MAX_LINES) capWritten = true;
}

resumeExistingCapture();

function lossLine() {
  if (!loss) return '';
  const reasons = [...loss.reasons];
  return JSON.stringify({
    schema: 'm59-collision-trace-loss/1',
    kind: 'trace_loss',
    reason: reasons.length === 1 ? reasons[0] : 'multiple',
    lossReasons: reasons,
    lostFromSeq: loss.fromSeq,
    lostThroughSeq: loss.throughSeq,
    lostCount: loss.count,
    at: loss.at,
    // The marker occupies the first unavailable sequence. A range longer than one also
    // leaves a numeric gap before the next move row; either form is unambiguously incomplete.
    seq: loss.fromSeq,
  }) + '\n';
}

function rememberLoss(seq, at, reason) {
  if (!loss) {
    loss = { fromSeq: seq, throughSeq: seq, count: 1, at, reasons: new Set([reason]) };
  } else {
    loss.throughSeq = seq;
    loss.count++;
    loss.reasons.add(reason);
  }
}

// One append is the commit boundary. Never dequeue a retry before the entire ordered batch
// has landed: a later call can then retry the same serialized bytes without intentionally
// duplicating them. As with every append-only diagnostic, a filesystem that partially writes
// before throwing can still leave a malformed tail; the next process detects and refuses it.
function appendBatch(current = '') {
  const marker = lossLine();
  const batch = pending.join('') + marker + capLine + current;
  if (!batch) return true;
  let fd = null;
  try {
    mkdirSync(dirname(TRACE_FILE), { recursive: true });
    // O_APPEND binds permission repair and the write to the same opened file.  Passing a
    // mode to appendFileSync alone only protects a newly created file; it leaves an old
    // world-readable capture world-readable.  fchmod repairs that existing mode on POSIX
    // before any more identity/position evidence is appended.  Windows ignores POSIX mode
    // bits and relies on its ACLs, so do not pretend chmod is meaningful there.
    fd = openSync(TRACE_FILE, 'a', 0o600);
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    appendFileSync(fd, batch, 'utf8');
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* a diagnostic must never break movement */ }
    }
  }
  pending = [];
  loss = null;
  if (capLine) capWritten = true;
  capLine = '';
  return true;
}

function markCap(at) {
  if (!capWritten && !capLine) {
    const seq = attempted + 1;
    capLine = JSON.stringify({
      schema: 'm59-collision-trace-loss/1',
      kind: 'trace_loss',
      reason: 'max_lines_reached',
      lossReasons: ['max_lines_reached'],
      lostFromSeq: seq,
      // The tracer cannot know how many future calls this cap will omit. Null is deliberate:
      // consumers must treat the range as open-ended, never as one missing move.
      lostThroughSeq: null,
      lostCount: null,
      at,
      seq,
    }) + '\n';
  }
  appendBatch();
}

// Production's validated send boundary calls this wrapper, not the row builder directly.
// Check the immutable environment decision BEFORE constructing the row: with tracing off,
// no JSON object is built and no filesystem state is observed or changed.
export function traceWireMove(detail) {
  if (!COLLISION_TRACE) return;
  traceMove(wireMoveRow(detail));
}

// Check the immutable switch before even reading the detail object. Raw fallback sends are
// rare, but tracing disabled must remain a genuinely cheap no-op at every packet boundary.
export function traceUnsafeWireMove(detail) {
  if (!COLLISION_TRACE) return;
  traceMove(unsafeWireMoveRow(detail));
}

/**
 * One move attempt. Retains a bounded in-memory window; disk writes are opt-in.
 *
 * `sent` is the whole point: false means the local validator refused and NOTHING went to
 * the wire, true means a packet left and the body still did not arrive. Everything else is
 * context for reading a run back afterwards.
 */
export function traceMove(detail) {
  const at = Date.now();
  rememberAttempt(detail,at);
  if (!COLLISION_TRACE) return;
  if (resumeProblem) {
    if (!complained) {
      complained = true;
      console.error(`[collision-trace] ${resumeProblem} — ${TRACE_FILE}`);
    }
    return;
  }
  if (capWritten) {
    if (!complained) {
      complained = true;
      console.error(`[collision-trace] capture already ended at its line cap — ${TRACE_FILE}`);
    }
    return;
  }
  if (attempted >= MAX_ATTEMPTS) {
    // A cap reached during an outage must not strand already accepted rows forever. Calls
    // after the cap retry both those rows and the durable, open-ended cap marker.
    markCap(at);
    if (!complained) {
      complained = true;
      console.error(`[collision-trace] stopped at ${MAX_LINES} lines — ${TRACE_FILE}`);
    }
    return;
  }

  const seq = ++attempted;
  let line;
  try {
    // SPREAD FIRST, CLOCK AND SEQUENCE LAST, so caller fields can never take their names.
    // It already did: the step call site passed `at: {col,row}` for the body's square, which
    // overwrote `at: Date.now()` and made every interval in the file read NaN. That is the
    // `emit(kind, data)` trap this repository already documents — a payload field silently
    // winning because it was spread over the thing it collided with — and it cost the timing
    // on the first capture of the bounce.
    line = JSON.stringify({ ...detail, at, seq }) + '\n';
  } catch {
    // A malformed diagnostic payload must still leave durable evidence that continuity was
    // lost, and must never break the walk it was meant to observe.
    rememberLoss(seq, at, 'serialization_error');
    appendBatch();
    return;
  }

  if (appendBatch(line)) return;

  if (!loss && pending.length < MAX_PENDING) {
    // Store the already serialized bytes: retries retain the event's original clock and seq.
    pending.push(line);
    return;
  }

  // Once a gap begins, later failures join it rather than being queued behind it. That keeps
  // the recovery order pending -> marker -> first newly writable row while memory stays flat.
  rememberLoss(seq, at, 'pending_queue_overflow');
  if (!complainedLoss) {
    complainedLoss = true;
    console.error(`[collision-trace] pending queue full; loss will be marked on recovery — ${TRACE_FILE}`);
  }
}

// ------------------------------------------------------------------ reading it back
if (process.argv[1]?.endsWith('m59-collision-trace.mjs')) {
  if (process.argv.includes('--clear')) {
    if (existsSync(TRACE_FILE)) unlinkSync(TRACE_FILE);
    console.log('cleared');
    process.exit(0);
  }
  if (!existsSync(TRACE_FILE)) {
    console.log(`no trace at ${TRACE_FILE}`);
    console.log('turn it on for one run:  M59_COLLISION_TRACE=1 node tools/m59-service.mjs restart --fleet shadow --http 8971 --dashboard 8972');
    process.exit(0);
  }
  let malformed = 0;
  const rows = readFileSync(TRACE_FILE, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { malformed++; return null; } }).filter(Boolean);
  const byAgent = new Map();
  const reasons = {};
  let sent = 0, refused = 0, lost = 0, openLosses = 0, lossMarkers = 0;
  for (const r of rows) {
    if (r.kind === 'trace_loss') {
      lossMarkers++;
      if (r.lostCount == null) openLosses++;
      else lost += Number(r.lostCount) || 0;
      continue;
    }
    if (r.sent) sent++; else { refused++; reasons[r.reason ?? '?'] = (reasons[r.reason ?? '?'] ?? 0) + 1; }
    const a = byAgent.get(r.agent) ?? { sent: 0, refused: 0, rooms: new Set() };
    if (r.sent) a.sent++; else a.refused++;
    if (r.room != null) a.rooms.add(r.room);
    byAgent.set(r.agent, a);
  }
  console.log(`${sent + refused} recorded move attempt(s): ${sent} sent, ${refused} refused by our own validator\n`);
  if (lossMarkers) {
    const open = openLosses ? `; ${openLosses} open-ended loss range(s)` : '';
    console.log(`TRACE INCOMPLETE: ${lost} known move attempt(s) unavailable${open} (${lossMarkers} durable loss marker(s))\n`);
  }
  if (malformed)
    console.log(`TRACE INCOMPLETE: ${malformed} malformed line(s) could not be read\n`);
  // THE ANSWER, IN ONE LINE PER CHARACTER. All-refused is "sending nothing"; a high sent
  // count with no progress is "looping". They are different bugs.
  console.log('  agent        sent  refused  rooms');
  for (const [agent, a] of [...byAgent].sort((x, y) => y[1].refused - x[1].refused))
    console.log(`  ${String(agent).padEnd(12)} ${String(a.sent).padStart(4)}  ${String(a.refused).padStart(7)}  ${[...a.rooms].join(',')}`);
  if (refused) {
    console.log('\nwhy the validator refused:');
    for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1]))
      console.log(`  ${String(v).padStart(6)}  ${k}`);
  }
}
