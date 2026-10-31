// #movement: A DECLARED JUMP'S PRECONDITIONS, AGAINST WHAT THE SERVER HAS SAID.
//
// Pure and dependency-light on purpose: Session.step imports it on every fall, and the proof
// half (m59-declared-jump.mjs) pulls in the router. See that file for the argument; the shape is
//
//     "requires": { "sectors": { "3": 800, "4": 510 } }     kod sector id -> kod height
//
// docs/falljump-audit-2026-10-31.md has the Brax lift that made it necessary.

import { fallJumpsIn } from './m59-falljump.mjs';

const sameSquare = (a, b) => a && b && Number(a.row) === Number(b.row) && Number(a.col) === Number(b.col);

/** The declaration for exactly this take-off and landing square, or null. */
export function declaredJumpFor(room, from, to, { jumps = null } = {}) {
  const list = jumps ?? fallJumpsIn(room);
  return list.find(j => Number(j.room) === Number(room) && sameSquare(j.from, from) && sameSquare(j.to, to)) ?? null;
}

/** `requires.sectors` as a list, kod sector id and kod height. Malformed entries are refused loudly. */
export function sectorRequirements(declaration) {
  const raw = declaration?.requires?.sectors;
  if (raw == null) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('requires.sectors must be an object of sector id -> kod height');
  return Object.entries(raw).map(([sector, height]) => {
    const s = Number(sector), h = Number(height);
    if (!Number.isInteger(s) || !Number.isFinite(h)) throw new Error(`requires.sectors: ${sector}=${height} is not a kod sector id and height`);
    return { sector: s, height: h };
  });
}

/**
 * IS THE WORLD IN THE STATE THIS JUMP NEEDS, ACCORDING TO WHAT THE SERVER HAS SENT.
 *
 * `observed` is `client.room.sectorHeights` (Map sector -> {height, type, ...}) or a plain object
 * sector -> height, the shape the keeper's `/state` reports as `doors.observed`. An entry the
 * server has not sent is UNKNOWN, not "as shipped": the .roo is not the world here (Brax's platform
 * ships at 264 and kod builds it at 250), so absence is refused rather than guessed.
 *
 * `ok` is true (met), false (a sector is at another height), or null (a sector is unobserved).
 */
export function livePreconditionState(declaration, observed) {
  const requires = sectorRequirements(declaration);
  const heightOf = sector => {
    const v = observed instanceof Map ? observed.get(sector) : observed?.[sector] ?? observed?.[String(sector)];
    const h = v != null && typeof v === 'object' ? v.height : v;
    return Number.isFinite(Number(h)) && h !== null ? Number(h) : null;
  };
  const sectors = requires.map(r => ({ ...r, observed: heightOf(r.sector) }));
  const unmet = sectors.find(s => s.observed != null && s.observed !== s.height);
  const unknown = sectors.find(s => s.observed == null);
  const ok = !requires.length ? true : unmet ? false : unknown ? null : true;
  // `code` is the terminal movement reason (m59-movement.mjs); `detail` says which sector and
  // what it was; `reason` is the two together, the sentence a caller shows a person.
  const code = ok === true ? null : unmet ? 'jump_precondition_unmet' : 'jump_precondition_unknown';
  const detail = ok === true ? null
    : unmet ? `sector ${unmet.sector} is ${unmet.observed}, needs ${unmet.height}`
    : `sector ${unknown.sector} has not been observed in this room, needs ${unknown.height}`;
  return { ok, code, detail, reason: code ? `${code}: ${detail}` : null, sectors };
}


/**
 * The declaration a fall from `from` to `to` is flying: the exact pair first, else a declaration
 * whose take-off is within one square of `from` and landing within two of `to` -- the jump verb's
 * neighbourhood (m59-broker.mjs `jump`, m59-keeper-process.mjs `case 'jump'`), which may fly a
 * declared jump from a step along the same ledge. Ranked as `selectDeclaredFall` ranks them.
 */
export function declaredJumpNear(room, from, to, { jumps = null } = {}) {
  if (!from || !to) return null;
  const list = jumps ?? fallJumpsIn(room);
  const exact = declaredJumpFor(room, from, to, { jumps: list });
  if (exact) return exact;
  let best = null, score = Infinity;
  for (const j of list) {
    if (Number(j.room) !== Number(room) || !j.from || !j.to) continue;
    const dFrom = Math.max(Math.abs(j.from.row - from.row), Math.abs(j.from.col - from.col));
    const dTo = Math.max(Math.abs(j.to.row - to.row), Math.abs(j.to.col - to.col));
    if (dFrom > 1 || dTo > 2) continue;
    const rank = Math.hypot(j.to.row - to.row, j.to.col - to.col) * 100 + Math.hypot(j.from.row - from.row, j.from.col - from.col);
    if (rank < score) { best = j; score = rank; }
  }
  return best;
}
