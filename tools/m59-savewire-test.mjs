#!/usr/bin/env node
// Offline. Opens no socket, touches no roster, writes into no fleet's history.
//
//   node tools/m59-savewire-test.mjs
//
// THE WIRE HALF OF THE SAVE BOUNDARY, driven by the real dispatcher.
//
// `m59-savelog-test.mjs` pins the ledger and the reader. This pins the link above them: that
// a BP_WAIT off the wire becomes a `server-save` event, and BP_UNWAIT closes it with the
// duration. Without this the chain is verified at both ends and assumed in the middle — and
// the middle is the part that only runs against a live server, so nothing would have caught a
// break in it until somebody went looking for a window boundary that was never written.
//
// IT WAS VERIFIED BY ACCIDENT THAT THE OBVIOUS CHECK DOES NOT WORK. Taking a checkpoint with
// `m59-shutdown.mjs --checkpoint` issues `save game`, and `save game` does raise this for every
// logged-in player: AdminSaveGame sends SYSEVENT_SAVE, SendBlakodBeginSystemEvent relays every
// system event as GARBAGE_MSG (commcli.c:242), and the system object's GarbageCollecting()
// sends each user BP_WAIT (user.kod:2154). But the prod fleet plays on a REMOTE server
// (76.214.42.186), and the checkpoint went to a local one the fleet is not connected to. It
// produced files, reported success, and could not possibly have produced a marker. So prod's
// boundary can only be waited for, and this is the only check that can be run on demand.
//
// AND THE OPCODES OVERLAP. AP_* and BP_* share numbers and are told apart only by connection
// state, so this drives `onGameMessage` specifically — the game-state dispatcher — rather than
// calling a handler directly. A test that bypassed the switch would still pass if BP.WAIT were
// shadowed by another case in it.
import assert from 'node:assert/strict';
import { M59Client } from './m59-client.mjs';

let n = 0;
const eq = (a, b, why) => { n++; assert.deepEqual(a, b, why); };
const ok = (c, why) => { n++; assert.ok(c, why); };

// A client that has never opened a socket. Nothing below sends, so none of the transport is
// touched; `onGameMessage` is a pure function of (op, body) and this object's own state.
function bench() {
  const c = new M59Client({ host: '127.0.0.1', port: 1 });
  const seen = [];
  c.onEvent = ev => seen.push(ev);
  return { c, seen };
}

// The opcodes, read from the client's own table rather than written as numbers here — a test
// carrying its own copy of 21 and 22 would keep passing after the table was corrected.
//
// AND WITH NO FALLBACK, deliberately. The first draft read `BP?.WAIT ?? 21`, which meant that
// if the export ever went away the test would assert its own hardcoded number against itself
// and pass while checking nothing. That is the failure this whole file is insurance against,
// committed inside the insurance.
const { BP } = await import('./m59-client.mjs');
ok(BP && typeof BP.WAIT === 'number' && typeof BP.UNWAIT === 'number',
   'm59-client.mjs must export its BP table; without it this test has no opcodes to drive');
const WAIT = BP.WAIT, UNWAIT = BP.UNWAIT;
ok(WAIT === 21 && UNWAIT === 22,
   `BP_WAIT/BP_UNWAIT are 21/22 in blakston.khd; this build says ${WAIT}/${UNWAIT}`);

// ---------------------------------------------------------------- the pair
{
  const { c, seen } = bench();
  c.onGameMessage(WAIT, Buffer.alloc(0));
  const begin = seen.filter(e => e.kind === 'server-save');
  eq(begin.length, 1, 'BP_WAIT off the wire raises exactly one server-save');
  eq(begin[0].phase, 'begin', 'and it is the BEGIN phase — the field boundaries() filters on');
  ok(typeof begin[0].at === 'number' && begin[0].at > 0, 'carrying when the pause started');

  c.onGameMessage(UNWAIT, Buffer.alloc(0));
  const all = seen.filter(e => e.kind === 'server-save');
  eq(all.length, 2, 'BP_UNWAIT closes it');
  eq(all[1].phase, 'end', 'as the END phase');
  ok(typeof all[1].held_ms === 'number' && all[1].held_ms >= 0,
     'with how long the world was held — a save that takes unusually long is a server under '
     + 'strain, which is a confounder for every rate measured around it');
}

// ---------------------------------------------------------------- an unpaired UNWAIT
{
  // A keeper that reconnects mid-save sees the UNWAIT and never saw the WAIT. It must still
  // report the event rather than throw or invent a duration, because a boundary half-seen is
  // still a boundary seen — and `boundaries()` only reads `begin`, so a lone `end` is inert.
  const { c, seen } = bench();
  c.onGameMessage(UNWAIT, Buffer.alloc(0));
  const ev = seen.filter(e => e.kind === 'server-save');
  eq(ev.length, 1, 'an UNWAIT with no WAIT before it is still reported');
  eq(ev[0].phase, 'end', 'as an end');
  eq(ev[0].held_ms, null, 'with a NULL duration rather than a made-up one');
  eq(ev[0].began, null, 'and no start it did not witness');
}

// ---------------------------------------------------------------- the payload cannot rename it
{
  // `emit(kind, data)` spreads data over the event, so a payload field called `kind` silently
  // wins — the trap CLAUDE.md names, which has cost this repository an afternoon twice. This
  // payload must never grow one.
  const { c, seen } = bench();
  c.onGameMessage(WAIT, Buffer.alloc(0));
  eq(seen[seen.length - 1].kind, 'server-save',
     'the save payload must not carry a `kind` of its own, or emit files it as something else');
}

// ---------------------------------------------------------------- two saves in a row
{
  const { c, seen } = bench();
  for (let i = 0; i < 2; i++) {
    c.onGameMessage(WAIT, Buffer.alloc(0));
    c.onGameMessage(UNWAIT, Buffer.alloc(0));
  }
  const phases = seen.filter(e => e.kind === 'server-save').map(e => e.phase);
  eq(phases, ['begin', 'end', 'begin', 'end'],
     'the pause state resets, so the second save is a second boundary and not a continuation');
}

console.log(`m59-savewire-test: ${n} assertions passed`);
