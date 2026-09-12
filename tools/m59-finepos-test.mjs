// THE GUARD FOR m59-finepos.mjs — offline, no keeper, no socket. The state reader is injected.
//
//   node tools/m59-finepos-test.mjs
//
// Every case is one of the four ways "where is this body" answered wrongly on 2026-09-11/12.
import { finePosition, settledPosition, keeperPortFor, movedBetween, protocolToClient, clientToProtocol,
         squareCentreClient } from './m59-finepos.mjs';

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${what}`); } };
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);

// ---- the units boundary, in both directions ---------------------------------------------
eq(protocolToClient({ x: 1167, y: 1519 }), { x: 17648, y: 23280 },
   'protocol (1167,1519) is client (17648,23280) — Marco\'s measured position');
eq(clientToProtocol({ x: 17648, y: 23280 }), { x: 1167, y: 1519 }, 'and the inverse round-trips');
eq(clientToProtocol(protocolToClient({ x: 1000, y: 2000 })), { x: 1000, y: 2000 },
   'the round trip is stable');
eq(squareCentreClient(1, 1), { x: 512, y: 512 }, 'squares are 1-BASED: r1c1 centres at 512,512');
eq(squareCentreClient(23, 17), { x: 16896, y: 23040 }, 'r23c17 centres at 16896,23040');

// THE NUMBER THAT MADE THIS TOOL EXIST: the centre of Marco's square was 362 units from Marco.
{
  const real = protocolToClient({ x: 1167, y: 1519 });
  const centre = squareCentreClient(23, 18);
  eq(Math.round(Math.hypot(real.x - centre.x, real.y - centre.y)), 363,
     'the square centre of r23c18 is 363 units from where the body actually stood');
}

// ---- keeperPortFor: discovered, never assumed -------------------------------------------
{
  const probe = async (lo) => (lo === 9511 ? [{ port: 9533, agent: 'hk2' }] : []);
  eq(await keeperPortFor('hk2', { probe }), 9533, 'the agent is found in the prod band');
  eq(await keeperPortFor('shadow01', { probe }), null, 'and an absent agent yields null, not a guess');
}
{
  // Found in a LATER band: a band change happened on this machine the same day, which is why
  // nothing here hard-codes 9533.
  const probe = async (lo) => (lo === 9011 ? [{ port: 9029, agent: 'hk2' }] : []);
  eq(await keeperPortFor('hk2', { probe }), 9029, 'a moved band is still found');
}
{
  const probe = async () => { throw new Error('band probe exploded'); };
  eq(await keeperPortFor('hk2', { probe }), null, 'a probe that throws yields null rather than killing the caller');
}

// ---- finePosition: the failures stay DIFFERENT failures ---------------------------------
{
  const r = await finePosition('hk2', { port: null, probe: async () => [],
                                        fetchState: async () => null });
  ok(!r.ok, 'no keeper is a failure');
  ok(/no keeper answering/.test(r.why), 'and says so specifically');
}
{
  const r = await finePosition('hk2', { port: 9533, fetchState: async () => null });
  ok(!r.ok && /did not answer/.test(r.why), 'a silent keeper is its own failure');
  eq(r.port, 9533, 'naming the port it asked');
}
{
  // THE status.you CASE: a keeper that answers but carries no position. This must NOT read as
  // "not in a room" or as a position of zero.
  const r = await finePosition('hk2', { port: 9533,
    fetchState: async () => ({ self: null, room: { num: 49 } }) });
  ok(!r.ok && /without a fine position/.test(r.why),
     'answered-but-positionless is a THIRD distinct failure, not the same as silence');
  eq(r.room, 49, 'and the room it did carry is still reported');
}
{
  const r = await finePosition('hk2', { port: 9533,
    fetchState: async () => ({ self: { x: 'nope', y: 1519, row: 23, col: 18 } }) });
  ok(!r.ok, 'a non-numeric coordinate is not a position');
}
{
  const r = await finePosition('hk2', { port: 9533,
    fetchState: async () => ({ self: { x: 1167, y: 1519, row: 23, col: 18 },
                               room: { num: 49 }, character: 'Marco Polo', pid: 1452 }) });
  ok(r.ok, 'a keeper with a position answers');
  // THE PORT IS THE BAND AND THE PID IS THE BUILD, and a caller with only the port reaches for it as
  // a build stamp. m59-stepbench's compareBenches did exactly that and answered SAME BUILD? on both
  // sides of a real keeper respawn — a guard that could only ever abstain.
  eq(r.pid, 1452, 'the keeper\'s PID comes back, because a restart changes it and the port does not');
  eq(r.protocol, { x: 1167, y: 1519 }, 'protocol units as the keeper gave them');
  eq(r.client, { x: 17648, y: 23280 }, 'and client units converted once');
  eq(r.square, { row: 23, col: 18 }, 'with the square for talking to humans');
  eq(r.centreError, 363, 'and how far the square centre WOULD have lied');
  eq(r.character, 'Marco Polo', 'and who it is');
  eq(r.port, 9533, 'and where that came from');
}
{
  // `you` is accepted as well as `self`, because the two shapes exist in this codebase.
  const r = await finePosition('hk2', { port: 9533,
    fetchState: async () => ({ you: { x: 1167, y: 1519, row: 23, col: 18 } }) });
  ok(r.ok, 'the `you` shape is read too');
  // A KEEPER THAT DID NOT SAY MUST NOT BE GIVEN A PLAUSIBLE PID. null is checkable; the port is not.
  eq(r.pid, null, 'a state without a pid reports null rather than substituting the port');
}

// ---- settledPosition: a read of a MOVING body is not a position ------------------------
{
  // The shape that caused it: 426 units recorded for a 128-unit step, because the body was still
  // in flight when `after` was read.
  const track = [{ x: 1100, y: 1100 }, { x: 1108, y: 1100 }, { x: 1116, y: 1100 },
                 { x: 1116, y: 1100 }, { x: 1116, y: 1100 }];
  let i = 0;
  const r = await settledPosition('hk2', { port: 9533, gapMs: 0, sleep: async () => {},
    fetchState: async () => ({ self: { ...track[Math.min(i++, track.length - 1)], row: 23, col: 18 },
                               pid: 1452 }) });
  ok(r.ok && r.settled, 'it waits for the body to stop and then answers');
  eq(r.protocol, { x: 1116, y: 1100 }, 'and the answer is where it STOPPED, not where it was passing');
  eq(r.reads, 4, 'having read until two consecutive reads agreed');
}
{
  // A body that never stops must not be reported as though it had.
  let n = 0;
  const r = await settledPosition('hk2', { port: 9533, gapMs: 0, maxMs: 0, sleep: async () => {},
    fetchState: async () => ({ self: { x: 1100 + 8 * n++, y: 1100, row: 23, col: 18 } }) });
  eq(r.settled, false, 'a body still in flight is NOT reported as settled');
  ok(/in flight, not a place/.test(r.why), '...and says so, rather than handing back the last read');
}
{
  // The failures finePosition already distinguishes have to survive the wrapper.
  const r = await settledPosition('hk2', { port: 9533, fetchState: async () => null });
  ok(!r.ok && r.settled === false, 'a keeper that does not answer stays a failure');
  eq(r.reads, 1, 'and it did not retry a dead keeper into a timeout');
}

// ---- movedBetween: the receipt, because `arrived` is not one ----------------------------
{
  const at = (x, y, row, col) => ({ ok: true, client: { x, y }, square: { row, col } });
  const a = at(17648, 23280, 23, 18), b = at(17648, 23280, 23, 18);
  eq(movedBetween(a, b).moved, false, 'the same position did not move');
  ok(movedBetween(a, b).sameSquare, 'and is the same square');
  eq(movedBetween(a, b).distance, 0, 'zero distance');

  // 52 units is the exact amount walkFine called "as close as fine movement gets" while
  // reporting arrived:true with the body stationary. It must NOT count as movement.
  eq(movedBetween(a, at(17700, 23280, 23, 18)).moved, false,
     '52 units is not movement — that is the distance walkFine called arrival');
  eq(movedBetween(a, at(17712, 23280, 23, 18)).moved, true, '64 units — one lattice step — is');
  ok(!movedBetween(a, at(16624, 23280, 23, 17)).sameSquare, 'a square change is reported');
  eq(movedBetween(a, { ok: false }).known, false, 'a failed read makes the answer UNKNOWN');
  ok(/one of the two reads failed/.test(movedBetween({ ok: false }, b).why),
     'and says why rather than returning false');
}

console.log(`\nm59-finepos: ${pass} assertion(s) passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
