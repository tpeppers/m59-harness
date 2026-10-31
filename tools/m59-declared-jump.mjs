// #movement: ONE DECLARED JUMP, AS EVERY CHECK AND THE LIVE MOVER SEE IT.
//
//   node tools/m59-declared-jump.mjs            prove every declared jump the way the mover sends it
//   node tools/m59-declared-jump.mjs --json
//
// Three things that each had a different answer in a different file, which is how seven of the
// eighteen declared jumps read as refused while characters were landing them
// (docs/falljump-audit-2026-10-31.md):
//
//   THE TRACE OPTIONS. Session.step sends a declared jump with slide on, fall on, timed
//   (`queueValidatedMove`, `unclipped`), so an offline proof with `slide:false` is a proof about a
//   move nobody makes. 579 r40c33 > r40c32 and r38c31 > r42c30 were refused for that alone, and the
//   lab landed each of them 3/3. `LIVE_FALL_TRACE` is the one copy.
//
//   THE PRECONDITION. Brax's north jumps take off from a platform that is only there after the
//   lever puzzle: g9.kod raises sector 3 to 800 and lowers sector 4 to 510. The static .roo has the
//   platform down, so the jump read 4416 units UPHILL to every offline check -- while prod landed it
//   19/19 on 2026-10-23. A declaration now says so in machine-readable form,
//
//       "requires": { "running": true, "timed_fall": true, "sectors": { "3": 800, "4": 510 } }
//
//   keyed by the kod sector id (`#sectorID`, the .roo's serverId) and valued in KOD heights, the
//   numbers g9.kod writes -- the same shape `geometryWithSectorHeights` takes. Offline, a proof
//   applies it to a FRESH geometry before tracing (never the shared one: the keeper and the router
//   read that). Live, the executor compares it with the heights the server has actually sent
//   (`client.room.sectorHeights`) and refuses a mismatch or an absence by name.
//
//   THE SPAN GATE, which is `proveCandidateFall`'s and now measures the air (see `airPhases`).
//
// Nothing here moves a body or opens a socket.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RoomGeometry, applySectorHeights, sharedRoomGeometry, heightKodToClient } from './m59-roo.mjs';
import { loadFallJumps } from './m59-falljump.mjs';
import { proveCandidateFall } from './m59-fineroute.mjs';

/** The options the live mover sends a declared jump with. Offline proofs use these, not their own. */
export const LIVE_FALL_TRACE = Object.freeze({ slide: true, fall: true, timedFall: true });

export { declaredJumpFor, sectorRequirements, livePreconditionState } from './m59-jump-precondition.mjs';
import { sectorRequirements } from './m59-jump-precondition.mjs';

/**
 * The geometry a declared jump has to be proved on: the room as shipped, with `requires.sectors`
 * applied. A FRESH geometry when anything moves, so the shared one the router and keepers read
 * is never left in a lift's state; the shared one, untouched, when nothing does.
 */
export function geometryForDeclaration(room, declaration) {
  const requires = sectorRequirements(declaration);
  if (!requires.length) return { geometry: sharedRoomGeometry(room), applied: [] };
  const geometry = RoomGeometry.fromJSON(room.roo ?? room);
  const want = new Map(requires.map(r => [r.sector, heightKodToClient(r.height)]));
  const overrides = geometry.sectors.flatMap((s, index) => want.has(s.serverId) ? [{ index, floor: want.get(s.serverId) }] : []);
  const missing = requires.filter(r => !geometry.sectors.some(s => s.serverId === r.sector));
  if (missing.length) throw new Error(`room has no sector ${missing.map(m => m.sector).join(',')} for this declaration`);
  // The mask is not consulted by a fine trace; an empty one satisfies `applySectorHeights`'s
  // refusal to move a floor without one, and this geometry is never routed on.
  const result = applySectorHeights(geometry, overrides, { mask: new Uint8Array(geometry.rows * geometry.cols) });
  if (result.why && result.why !== 'already at that height') throw new Error(result.why);
  return { geometry, applied: requires };
}

/**
 * PROVE ONE DECLARED JUMP THE WAY IT IS FLOWN: its fine points (stand points when it has none),
 * its preconditions applied, the live mover's trace options, integer wire endpoints and the air
 * span gate -- `proveCandidateFall`, on the right geometry.
 */
export function proveDeclaredJump(room, declaration) {
  const { geometry, applied } = geometryForDeclaration(room, declaration);
  const a = declaration.from_fine ?? geometry.standPoint(declaration.from.row, declaration.from.col);
  const b = declaration.to_fine ?? geometry.standPoint(declaration.to.row, declaration.to.col);
  if (!a || !b) return { proved: false, reason: 'no_stand_point', fine: !!declaration.from_fine, applied };
  const proof = proveCandidateFall(geometry, { fromFine: a, toFine: b });
  return { proved: proof.model_proved, reason: proof.reason, fine: !!declaration.from_fine, applied,
           from: a, to: b, proof };
}

const isMain = (process.argv[1] ?? '').replaceAll('\\', '/').endsWith('/m59-declared-jump.mjs');
if (isMain) {
  const { loadMap } = await import('./m59-map.mjs');
  const map = loadMap(), rows = [];
  for (const j of loadFallJumps().jumps ?? []) {
    const room = map.rooms[j.room];
    if (!room) continue;
    const r = proveDeclaredJump(room, j);
    const p = r.proof;
    rows.push({ room: j.room, from: `r${j.from.row}c${j.from.col}`, to: `r${j.to.row}c${j.to.col}`, fine: r.fine,
      sectors: r.applied.map(s => `${s.sector}=${s.height}`).join(',') || null, proved: r.proved, reason: r.reason,
      drop: p ? p.from_floor_client - p.to_floor_client : null, air_span: p ? Math.round(p.span_client) : null,
      max_span: p ? Math.round(p.max_span_client) : null, chord: p ? Math.round(p.chord_span_client) : null,
      air_ms: p?.trace?.fall_motion?.elapsed_ms ?? null });
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 1));
  else for (const r of rows) console.log(`${r.room} ${r.from}->${r.to}${r.fine ? '' : ' (stand points)'}${r.sectors ? ' [' + r.sectors + ']' : ''}: ` +
    `${r.proved ? 'PROVED' : 'REFUSED ' + r.reason}; drop ${r.drop}, air span ${r.air_span}/${r.max_span} (chord ${r.chord}), ${r.air_ms} ms`);
  process.exitCode = rows.every(r => r.proved) ? 0 : 1;
}
