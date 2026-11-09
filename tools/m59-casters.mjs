// MONSTERS THAT CAST, AND WHY A SAFE SPOT DOES NOT HOLD AGAINST THEM.
//
// A safe spot is a square no monster can REACH: m59-safespots scores it against melee reach, a disc of radius
// Bound(2 + difficulty/6, 2, 3) filtered by line of sight. A caster does not need to reach. monster.kod's chase timer
// calls MonsterCastSpell exactly when the monster cannot get to its target -- which is what a safe spot arranges -- and
// MonsterCanCastSpell checks only AI_NOFIGHT: no range, no line of sight. The avar shaman (avshaman.kod) also raises its
// attack range to 5 and keeps 6-12 squares off, and its spells are Hold, Mana Bomb, Sandstorm, Shatter and Earthquake.
// A mollusk's override throws a rock only within ten squares and with line of sight (mollusk.kod:228-238).
//
// Prod 2026-10-27, Lew (t20), room 2133 r57c7: relogged at 52/90 onto a "proven" spot with avar warriors adjacent and a
// shaman and a chieftain in the room, 43/90 thirty seconds later; the one-logoff rule held him there. Operator, the same
// day: a hostile caster in the room means the room has no safe spot -- leave it by the nearest exit, no logoff.
//
// The classes are every monster whose kod overrides MonsterCastSpell (towns/ and the battler tree, M59_ROOT kod).
// Pure.

import { lineOfSight } from './m59-safespots.mjs';
export const CASTER_CLASSES = Object.freeze(new Set([
  'AvarShaman', 'AvarChieftain', 'DarkAngel', 'OrcWizard', 'Ent', 'EvilEnt', 'Ghost', 'Yeti',
  'MolluskMonster', 'Iceperson', 'Xeochicatl',
]));

/** Is this creature (a spawn-index row, or its class name) one that casts? */
export const isCasterClass = cls => CASTER_CLASSES.has(String(cls ?? ''));

/**
 * The casters among the monsters in a room. `monsters` are [{ id, name }]; `classOf(name)` answers the kod class
 * (m59-spawns creatureByName(...).cls), or null when unknown -- an unknown name is not called a caster.
 */
export function castersAmong(monsters = [], classOf = () => null) {
  return monsters.filter(m => isCasterClass(classOf(m?.name)));
}

function rockGeometryReady(geo) {
  const squares = geo?.rows * geo?.cols;
  return geo?.collisionReady && typeof geo.inBounds === 'function' && typeof geo.canMove === 'function' &&
    geo.grid?.length === squares && geo.monsterGrid?.length === squares;
}

const knownSquare = (geo, p) => !p?.predicted && Number.isSafeInteger(p?.row) && Number.isSafeInteger(p?.col) &&
  geo.inBounds(p.row, p.col);

const rockLine = (geo, at, caster) => (at.row - caster.row) ** 2 + (at.col - caster.col) ** 2 <= 100 &&
  (lineOfSight(geo, caster.row, caster.col, at.row, at.col) ||
   lineOfSight(geo, caster.row, caster.col, at.row, at.col, { fine: true }));

/** A visible rock line from beyond ordinary melee reach. */
export function molluskRockThreatAt(geo, at, casters) {
  return rockGeometryReady(geo) && knownSquare(geo, at) && casters.some(caster =>
    caster.name?.toLowerCase() === 'mollusk creature' && knownSquare(geo, caster) &&
    Math.hypot(at.row - caster.row, at.col - caster.col) > 3 && rockLine(geo, at, caster));
}

/** Prove that every observed caster here is a mollusk whose rock cannot reach this square. */
export function mollusksBlockedAt(geo, at, casters) {
  if (!rockGeometryReady(geo) || !knownSquare(geo, at) || !casters.length) return false;
  // GetLOS is a server setting. Require both grids to block the attacker-to-player line.
  return casters.every(caster => caster.name?.toLowerCase() === 'mollusk creature' &&
    knownSquare(geo, caster) && !rockLine(geo, at, caster));
}

/**
 * Which exit to leave by. Prefer, in order: a room inside the confinement, a room whose spawn list has no caster, the
 * nearest. `exits` are world.exits() rows ({ to, row, col, reachable }); only reachable ones are considered.
 * -> the chosen exit row, or null.
 */
export function casterExit(exits = [], { here = null, from = null, confine = null, roomHasCaster = () => false } = {}) {
  const usable = exits.filter(e => e?.reachable !== false && e?.to != null && Number(e.to) !== Number(here));
  if (!usable.length) return null;
  const dist = e => (from && Number.isFinite(e.row) && Number.isFinite(e.col)) ? Math.hypot(e.row - from.row, e.col - from.col) : 0;
  const inConfine = e => (confine?.length ? (confine.map(Number).includes(Number(e.to)) ? 0 : 1) : 0);
  const casterRoom = e => (roomHasCaster(Number(e.to)) ? 1 : 0);
  return [...usable].sort((a, b) => inConfine(a) - inConfine(b) || casterRoom(a) - casterRoom(b) || dist(a) - dist(b))[0];
}
