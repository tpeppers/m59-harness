// WHERE IS THIS BODY, ACTUALLY — and never ask a movement verb.
//
//   node tools/m59-finepos.mjs hk2                 one body, every source, side by side
//   node tools/m59-finepos.mjs hk2 --watch 2       every 2s, with the delta between samples
//
// THE MOST LOAD-BEARING PRIMITIVE IN FINE MOVEMENT IS ALSO THE EASIEST TO GET WRONG, and a whole
// night of movement debugging went into learning how. Four sources answer "where is hk2", they do
// not agree, and three of them are wrong in ways that read as right:
//
//   status.you        NULL on a keeper-backed session — which is every character. Not an error,
//                     not a refusal: a null that reads as "no position" when the truth is "this
//                     endpoint does not carry one". A peer's /health flap and my NaN aim were the
//                     same absent field seen from two sides.
//   look.you          a SQUARE. Fine for talking to humans, and on a ledge it is a false summary:
//                     the centre of r23c17 is 362 units from where Marco was standing, which is
//                     what made a follower aim from a place the body was not.
//   walk_to reply     carries true fine x/y in PROTOCOL units — but getting one means SENDING A
//                     WALK. A zero-step walk_to as a position read came back with no position at
//                     all after a long leg, and using the mover to measure the mover perturbs
//                     exactly what is being measured.
//   keeper /state     `self` with fine x/y, in protocol units, and it MOVES NOTHING. This is the
//                     answer.
//
// So: read the keeper. The port is discovered from the fleet's band rather than assumed, because a
// keeper restart changes the pid and a band change changes the port — and a band change happened
// on this machine the same day, which is why this does not hard-code 9533.
//
// UNITS. The keeper answers in KOD PROTOCOL units (64 to the square, offset by one square). The
// geometry speaks CLIENT units (1024 to the square). Both are returned, named, because a bare
// number cannot say which it is and that ambiguity has cost this repository two commits.
import { probeRange } from './m59-bands.mjs';
import http from 'node:http';

export const CLIENT_PER_SQUARE = 1024;
export const PROTOCOL_PER_SQUARE = 64;

/** protocol -> client. The one boundary, in one place. */
export const protocolToClient = (p) => ({ x: (p.x - 64) * 16, y: (p.y - 64) * 16 });
/** client -> protocol, matching standPointWire. */
export const clientToProtocol = (p) => ({ x: Math.round(p.x / 16 + 64), y: Math.round(p.y / 16 + 64) });
/** The centre of a 1-based square, in client units. A SUMMARY — see the header. */
export const squareCentreClient = (row, col) =>
  ({ x: (col - 1) * CLIENT_PER_SQUARE + 512, y: (row - 1) * CLIENT_PER_SQUARE + 512 });

const getJson = (port, path, timeoutMs = 9000) => new Promise((res) => {
  const r = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (x) => {
    let b = ''; x.on('data', (d) => b += d);
    x.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } });
  });
  r.on('error', () => res(null));
  r.on('timeout', () => { r.destroy(); res(null); });
});

/** Which keeper port is this agent on? Discovered, never assumed. */
// 9411 is lab-canary-eff's band — the one-character clean room this repository keeps for movement
// experiments. Listed explicitly rather than scanned, because a probe that sweeps unknown ports is
// how one fleet's tooling ends up talking to another fleet's keepers.
export async function keeperPortFor(agent, { bands = [[9511, 9560], [9011, 9060],
                                                      [9111, 9160], [9411, 9460]],
                                             probe = probeRange } = {}) {
  for (const [lo, hi] of bands) {
    const occ = await probe(lo, hi).catch(() => []);
    const hit = (occ ?? []).find((o) => o.agent === agent);
    if (hit) return hit.port;
  }
  return null;
}

/**
 * The body's fine position, read from the keeper. Never a walk, never a square centre.
 *
 * Returns null ONLY when the position genuinely could not be read — and says which step failed, so
 * "no keeper" and "keeper answered without a position" stay different facts. They are different
 * problems and conflating them is how a working run gets thrown away.
 */
export async function finePosition(agent, { port = null, fetchState = getJson,
                                            probe = undefined } = {}) {
  // THE PROBE IS INJECTABLE OR THIS CANNOT BE TESTED OFFLINE. Its own test asked for the "no
  // keeper" case with port:null and no probe, so it fell through to the LIVE band, found Marco's
  // real keeper on 9533 and failed. A tool that cannot be isolated gets tested in production.
  const p = port ?? await keeperPortFor(agent, probe ? { probe } : {});
  if (!p) return { ok: false, why: 'no keeper answering for this agent in any known band' };
  const j = await fetchState(p, '/state');
  if (!j) return { ok: false, why: `keeper on ${p} did not answer /state`, port: p };
  const you = j.self ?? j.you ?? null;
  if (!you || !Number.isFinite(you.x) || !Number.isFinite(you.y))
    return { ok: false, why: `keeper on ${p} answered without a fine position`, port: p,
             room: j.room?.num ?? null };
  const client = protocolToClient({ x: you.x, y: you.y });
  return {
    ok: true, port: p, agent,
    // THE PORT IS THE BAND; THE PID IS THE BUILD. A keeper restart changes the pid and keeps the
    // port, which is the whole reason `port` cannot stand in for it — and `/state` has carried the
    // pid all along. Omitting it here made a caller reach for `port` as the nearest thing to a
    // build stamp, so `m59-stepbench`'s compareBenches saw 9411 on both sides of a genuine keeper
    // respawn and answered SAME BUILD? for ever. A guard that can only abstain is not a guard, and
    // it fails in the direction nobody checks: it never fires falsely, so nobody notices it never
    // fires at all. Eighth instance of two shapes for one idea.
    pid: Number.isFinite(j.pid) ? j.pid : null,
    protocol: { x: you.x, y: you.y },
    client,
    square: { row: you.row, col: you.col },
    // HOW FAR THE SQUARE CENTRE WOULD HAVE LIED, which is the number that made this tool exist.
    centreError: Math.round(Math.hypot(
      client.x - squareCentreClient(you.row, you.col).x,
      client.y - squareCentreClient(you.row, you.col).y)),
    room: j.room?.num ?? null,
    character: j.character ?? null,
    // HOW OLD THIS READ IS, AS THE KEEPER ITSELF RECKONS IT. `/state` has carried `as_of_ms` and
    // `fresh` all along and every caller here ignored them, which is how a position read gets
    // treated as a fact about now rather than a fact about some moment.
    asOfMs: Number.isFinite(j.as_of_ms) ? j.as_of_ms : null,
    fresh: j.fresh ?? null,
  };
}

/**
 * THE BODY'S POSITION ONCE IT HAS STOPPED MOVING — read until two consecutive reads agree.
 *
 * A single read straight after a walk returns is a read of a body that may still be in flight, and
 * the error is not small. MEASURED, room 576, 2026-09-12: a bench cell that asked for a 128-unit
 * step recorded 426 units of movement, which ONE step cannot produce — walkFine sizes a step
 * `max(8, min(stride, remaining))`, so 128 units in is 128 units out. The position pair was racing
 * the body, and the same race is what made 44% of cells read as "did not move".
 *
 * DELIBERATELY NOT A STALENESS THRESHOLD. Every threshold in this toolchain has been wrong once —
 * seven of them tonight — because a threshold encodes a guess about a scale that later changes.
 * "Has it stopped?" is OBSERVABLE: read twice and compare. Exact equality is the right test, because
 * protocol coordinates are integers and a stationary body reports the same pair for ever.
 *
 * AND IT SAYS WHEN IT DID NOT SETTLE, rather than returning the last read as though it had. A body
 * the keeper is still recovering never settles, and a caller that cannot tell will average a moving
 * body into its measurement.
 */
export async function settledPosition(agent, { gapMs = 120, maxMs = 3000, sleep = null,
                                               ...opts } = {}) {
  const nap = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  let prev = await finePosition(agent, opts);
  if (!prev.ok) return { ...prev, settled: false, reads: 1 };
  for (let reads = 2; ; reads++) {
    if (Date.now() - started >= maxMs)
      return { ...prev, settled: false, reads: reads - 1, waitedMs: Date.now() - started,
               why: `still moving after ${maxMs}ms — this position is a body in flight, not a place` };
    await nap(gapMs);
    const next = await finePosition(agent, opts);
    if (!next.ok) return { ...next, settled: false, reads };
    if (next.protocol.x === prev.protocol.x && next.protocol.y === prev.protocol.y)
      return { ...next, settled: true, reads, waitedMs: Date.now() - started };
    prev = next;
  }
}

/** Did the body actually move between two reads? The receipt, since `arrived` is not one. */
// ONE LATTICE STEP IS THE FLOOR FOR "MOVED", and the number is not arbitrary: walkFine reports
// `arrived: true` with the note "as close as fine movement gets — 52 units, inside one square"
// while the body is stationary, so any threshold at or below 52 scores that slide as movement.
// Its own test caught this: the default was 48.
export const MOVED_AT_LEAST = 64;
export function movedBetween(a, b, { atLeast = MOVED_AT_LEAST } = {}) {
  if (!a?.ok || !b?.ok) return { known: false, why: 'one of the two reads failed' };
  const d = Math.hypot(b.client.x - a.client.x, b.client.y - a.client.y);
  return { known: true, moved: d >= atLeast, distance: Math.round(d),
           sameSquare: a.square.row === b.square.row && a.square.col === b.square.col };
}

async function main(argv) {
  const agent = argv.find((a) => !a.startsWith('--'));
  if (!agent) { console.log('usage: node tools/m59-finepos.mjs <agent> [--watch <seconds>]'); return 2; }
  const wi = argv.indexOf('--watch');
  const every = wi >= 0 ? Math.max(1, Number(argv[wi + 1]) || 2) : 0;

  let last = null;
  for (;;) {
    const r = await finePosition(agent);
    if (!r.ok) { console.log(`${agent}: CANNOT READ — ${r.why}`); if (!every) return 1; }
    else {
      const c = squareCentreClient(r.square.row, r.square.col);
      const delta = last ? movedBetween(last, r) : null;
      console.log(`${agent}${r.character ? ` (${r.character})` : ''} room ${r.room} ` +
                  `r${r.square.row}c${r.square.col}` +
                  `  protocol (${r.protocol.x},${r.protocol.y})` +
                  `  client (${r.client.x},${r.client.y})` +
                  `  square centre would say (${c.x},${c.y}) — off by ${r.centreError}u` +
                  (delta?.known ? `   moved ${delta.distance}u since last` : ''));
      last = r;
    }
    if (!every) return 0;
    await new Promise((res) => setTimeout(res, every * 1000));
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('m59-finepos.mjs'))
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
