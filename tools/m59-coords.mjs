#!/usr/bin/env node
// A COORDINATE CARRIES ITS UNIT. Three spaces, one number type, no way to tell them apart.
//
//   import { squareCentre, asClient, asProtocol, expectUnit } from './m59-coords.mjs';
//
// WHY THIS EXISTS, AND WHY IT IS NOT ANOTHER CONVERSION HELPER. The conversions are already
// here and already right — `protocolToClient` in m59-roo.mjs matches clientd3d/drawdefs.h to
// the bit. Nothing has ever been wrong with the arithmetic. What goes wrong is that a bare
// number does not say which space it is in, so the wrong one type-checks perfectly:
//
//   9fb1ad3  "CLIENT UNITS IN, ALWAYS. me.x/me.y are kod PROTOCOL units and
//             floorBaseAtClient wants client ones — 16 to a kod unit with a +64 origin."
//   abec3ac  a declared jump aimed at `col * KOD_FINENESS + 32` — the square CENTRE —
//             when the whole point of declaring it was to land on a specific point.
//
// Both are unit errors. Neither is an arithmetic error. This module makes the unit part of
// the value, so the mistake becomes unrepresentable rather than merely documented.
//
// THREE SPACES, from the game source (see m59-research reports/coordinate-systems.md):
//
//   square     row/col, 1-BASED. What kod calls a grid square.
//   protocol   row*64 + fine, 1-based origin. What the WIRE carries. kod FINENESS is 64.
//   client     (protocol - 64) * 16, 0-BASED. What .roo geometry and collision use.
//              The client's own FINENESS is 1024 — the SAME IDENTIFIER, a different number.
//
// AND THE AXES ARE NOT THE SAME LETTERS. The wire sends row first, and the client stores it
// as y: row IS y, col IS x (clientd3d/server.c:176-184, ExtractCoordinates). A pair read in
// order as (x, y) is transposed. So the constructors here take (row, col) or (x, y)
// explicitly and never a bare pair.

import { KOD_FINENESS, CLIENT_FINENESS, protocolToClient, clientToProtocol }
  from './m59-roo.mjs';

export { KOD_FINENESS, CLIENT_FINENESS };
export const KOD_FINENESS_HALF = KOD_FINENESS >> 1;   // 32 — the centre offset, named once

// A symbol, so a branded point cannot be forged by an object literal that happens to have
// the right keys — which is exactly how a plain {x, y} from some other layer would sneak in.
const UNIT = Symbol.for('m59.coord.unit');

export const SPACES = Object.freeze({
  square: 'row/col grid squares, 1-based',
  protocol: 'kod wire units, row*64+fine, 1-based origin',
  client: 'client fine units, 1024 per square, 0-based origin',
});

function brand(space, x, y, extra = {}) {
  return Object.freeze({ [UNIT]: space, x, y, ...extra });
}

export const spaceOf = p => (p && typeof p === 'object' ? p[UNIT] ?? null : null);
export const isPoint = p => spaceOf(p) != null;

// ------------------------------------------------------------------- constructors

// row/col, 1-based, as kod means them. Named parameters because (row, col) and (col, row)
// are both plausible and only one is right.
export const square = (row, col) => brand('square', col, row, { row, col });

// THE SQUARE CENTRE, SAID OUT LOUD. `col * 64 + 32` appears all over this repo and is
// correct every time it means "the middle of the square" — the bug in abec3ac was that it
// also appeared where a specific landing point was meant. A caller that wants the centre
// now has to name it, and a caller that wants a point cannot get the centre by accident.
export const squareCentre = (row, col) => brand(
  'protocol',
  col * KOD_FINENESS + KOD_FINENESS_HALF,
  row * KOD_FINENESS + KOD_FINENESS_HALF,
  { fromSquare: { row, col }, centre: true },
);

// An arbitrary point on the wire — a declared landing, a door opening, an observed position.
export const protocolPoint = (x, y) => brand('protocol', x, y);
export const clientPoint = (x, y) => brand('client', x, y);

// ------------------------------------------------------------------- conversion

export function asClient(p) {
  const s = requirePoint(p, 'asClient');
  if (s === 'client') return p;
  if (s === 'protocol') return brand('client', protocolToClient(p.x), protocolToClient(p.y));
  if (s === 'square') return asClient(squareCentre(p.row, p.col));
  throw new Error(`asClient: unknown space "${s}"`);
}

export function asProtocol(p) {
  const s = requirePoint(p, 'asProtocol');
  if (s === 'protocol') return p;
  if (s === 'client') return brand('protocol', clientToProtocol(p.x), clientToProtocol(p.y));
  if (s === 'square') return squareCentre(p.row, p.col);
  throw new Error(`asProtocol: unknown space "${s}"`);
}

// Which square a point falls in. The +1 is the 1-based origin and is the third of the four
// traps: forget it and everything is off by exactly one square, which reads as a rounding
// error rather than a bug.
export function asSquare(p) {
  const s = requirePoint(p, 'asSquare');
  if (s === 'square') return p;
  const w = asProtocol(p);
  return square(Math.floor(w.y / KOD_FINENESS), Math.floor(w.x / KOD_FINENESS));
}

// ------------------------------------------------------------------- the refusal

function requirePoint(p, where) {
  const s = spaceOf(p);
  if (s) return s;
  if (typeof p === 'number')
    throw new Error(
      `${where}: got a bare number (${p}), which carries no unit. ` +
      `Wrap it: protocolPoint(x, y), clientPoint(x, y), or squareCentre(row, col). ` +
      `A number cannot say whether it is 1, 64 or 1024 units to the square.`);
  throw new Error(
    `${where}: expected a branded coordinate, got ${p === null ? 'null' : typeof p}. ` +
    `Known spaces: ${Object.keys(SPACES).join(', ')}.`);
}

// THE ASSERTION AT A BOUNDARY. `expectUnit(p, 'client', 'floorBaseAtClient')` is the line
// that would have turned 9fb1ad3 from an afternoon into a stack trace.
export function expectUnit(p, wanted, where = 'expectUnit') {
  const got = requirePoint(p, where);
  if (got !== wanted)
    throw new Error(
      `${where}: wants ${wanted} units (${SPACES[wanted]}) but was given ${got} ` +
      `(${SPACES[got]}). They differ by ${
        (wanted === 'client' && got === 'protocol') ||
        (wanted === 'protocol' && got === 'client')
          ? '16x and a one-square origin shift'
          : 'a change of space'
      }. Convert explicitly: as${wanted[0].toUpperCase()}${wanted.slice(1)}(p).`);
  return p;
}

// Hand the raw numbers to code that predates this module. Deliberately verbose to call: an
// unwrap is where the guarantee stops, so it should be visible in review.
export function unwrap(p, wanted, where = 'unwrap') {
  const q = expectUnit(p, wanted, where);
  return { x: q.x, y: q.y };
}
