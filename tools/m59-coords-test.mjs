#!/usr/bin/env node
// THE UNIT ERRORS, PINNED. Offline: pure arithmetic, no broker, no server.
//
//   node tools/m59-coords-test.mjs
//
// Each case here is a real movement bug, named by the commit that fixed it. If one fails,
// that bug is available again.
import {
  square, squareCentre, protocolPoint, clientPoint,
  asClient, asProtocol, asSquare, expectUnit, unwrap, spaceOf,
  KOD_FINENESS, CLIENT_FINENESS, KOD_FINENESS_HALF,
} from './m59-coords.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};
const threw = fn => { try { fn(); return null; } catch (e) { return e.message; } };

console.log('\nthe constants match the game source');
ok('kod fineness is 64 (blakston.khd:1163)', KOD_FINENESS === 64);
ok('client fineness is 1024 (drawdefs.h:42)', CLIENT_FINENESS === 1024);
ok('and they differ by the 16x the client converts with', CLIENT_FINENESS / KOD_FINENESS === 16);
ok('half a square is 32, named once', KOD_FINENESS_HALF === 32);

console.log('\nthe square centre is said out loud (abec3ac)');
{
  const c = squareCentre(40, 32);
  ok('centre of row 40, col 32 is col*64+32, row*64+32',
     c.x === 32 * 64 + 32 && c.y === 40 * 64 + 32, `${c.x},${c.y}`);
  ok('and it knows it is a centre, not a chosen point', c.centre === true);
  // THE BUG: a declared jump wants a POINT, and got the centre because the centre was what
  // the arithmetic produced. A point built by hand is not marked as a centre, so code that
  // cares can tell the difference.
  ok('a declared landing point is not a centre', protocolPoint(2080, 2592).centre === undefined);
}

console.log('\nrow is y and col is x (server.c:176-184)');
{
  const s = square(40, 32);
  ok('square(row, col) puts row in y', s.y === 40 && s.row === 40);
  ok('and col in x', s.x === 32 && s.col === 32);
}

console.log('\nprotocol to client is 16x with a one-square origin shift');
{
  const c = asClient(protocolPoint(64, 64));
  ok('protocol 64 (square 1, offset 0) is client 0', c.x === 0 && c.y === 0, `${c.x},${c.y}`);
  const d = asClient(protocolPoint(128, 128));
  ok('protocol 128 (square 2) is client 1024 — one client square', d.x === 1024);
  ok('and the round trip returns the original',
     asProtocol(asClient(protocolPoint(2080, 2592))).x === 2080);
}

console.log('\nasSquare puts the 1-based origin back');
{
  const sq = asSquare(squareCentre(40, 32));
  ok('the centre of a square is in that square', sq.row === 40 && sq.col === 32,
     `${sq.row},${sq.col}`);
}

console.log('\nA BARE NUMBER IS REFUSED (the whole point)');
{
  const why = threw(() => asClient(2080));
  ok('a bare number will not convert', !!why);
  ok('and the refusal says why a number cannot work',
     /carries no unit/.test(why ?? ''), why ?? '');
  ok('and names the constructors to use', /protocolPoint|squareCentre/.test(why ?? ''));
  ok('an untagged {x,y} is refused too — it could be either space',
     !!threw(() => asClient({ x: 1, y: 2 })));
}

console.log('\nthe boundary assertion (9fb1ad3: kod units fed to a client-units function)');
{
  // THE BUG, EXACTLY: me.x/me.y are protocol units; floorBaseAtClient wants client ones.
  const me = protocolPoint(2080, 2592);
  const why = threw(() => expectUnit(me, 'client', 'floorBaseAtClient'));
  ok('protocol units offered where client units are wanted is refused', !!why);
  ok('and the refusal names both spaces', /client/.test(why ?? '') && /protocol/.test(why ?? ''));
  ok('and names the 16x and the origin shift',
     /16x/.test(why ?? '') && /origin/.test(why ?? ''), why ?? '');
  ok('and tells you the conversion to write', /asClient/.test(why ?? ''));
  ok('the converted value passes', !!expectUnit(asClient(me), 'client', 'floorBaseAtClient'));
}

console.log('\nunwrap is the visible end of the guarantee');
{
  const raw = unwrap(asClient(protocolPoint(64, 64)), 'client', 'legacy');
  ok('unwrap returns plain numbers for older code', raw.x === 0 && raw.y === 0);
  ok('but still refuses the wrong space',
     !!threw(() => unwrap(protocolPoint(64, 64), 'client', 'legacy')));
  ok('and an unwrapped value is no longer branded', spaceOf(raw) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
