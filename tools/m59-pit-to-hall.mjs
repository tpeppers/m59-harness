// #movement: OUT OF THE ORC PIT COMPLEX, THROUGH THE CAVES TO KO'CATAN, AND INTO A GUILD HALL.
//
//   tools/fleetscripts/pit-to-hall.mjs is the fleetscript; this is its route, testable offline.
//
// THE PIT ROOMS DRAIN ONE WAY. Each antechamber's north part (2507: 762 squares, where 2506's
// west edge lands at r7c61; 2508: where its east edge lands at r8c4) reaches only its edge back to
// the lair, and the lair's way out is its west edge below row 42 to 2509, whose east edge below
// row 39 drops to 2500 on the cave chain (tools/m59-orc-pit-floors-test.mjs pins those floods).
//
// WHY EACH ROOM IS A FINE WALK TO AN APPROACH POINT, THEN A ONE-HOP TRAVEL. Live 2026-11-15
// 01:10-01:25Z, Zoot in 2507's north part: `travel 2500` sat "travelling" for 8 minutes without
// leaving the room, and `walk_to {fine:true}` toward points cut from ANOTHER start square drifted
// (fine walk_to is a straight chord; a chord from the wrong square is a slide along a wall).
// The cave controllers' own walker, `checkedIslandWalk`, cuts a fine rail from where the body
// actually is, re-reads it every chord and waits out live bodies; so each pit room is that walk to
// a point a few squares from its edge, then `ordinaryHop` for the one crossing -- the same shape
// as walkHollowsOut. The chain beyond is cave-walk-on's (admitted single transits, pool top-up).
import { loadMap } from './m59-map.mjs';
import { chamberReachers } from './m59-orc-pit-exit.mjs';

const kod = (row, col) => Object.freeze({ x: col * 64 + 32, y: row * 64 + 32 });
/** The cave chain after the mainland cave, ending on the island. */
export const CHAIN = Object.freeze([2500, 2501, 2502, 2503, 2504, 2505, 2000]);
/** Per pit room: the approach (KOD protocol, a square centre a few squares inside the edge) and the hop. */
export const PIT_OUT = Object.freeze({
  2507: Object.freeze({ approach: kod(6, 59), edgeTo: 2506, why: "2507's north part to its east edge" }),
  2508: Object.freeze({ approach: kod(8, 3), edgeTo: 2506, why: "2508's north part to its west edge" }),
  // 2506's way out west is through DOOR 1, a ceiling slab on the c14/c15 line at r56-58 that rests
  // shut (sector 2 ceiling 204 over floor 200) and opens for 9 s to a `go` from r56-57 c14-15
  // (orcpit1.kod:201-213, DOOR_RESET_TIME 9000). So: stand on the trigger's east square, go, through.
  2506: Object.freeze({ press: kod(57, 15), approach: kod(57, 3), edgeTo: 2509, why: '2506 through door 1 to its west edge below row 42' }),
});

/**
 * The next move out of the pit complex from (room, row, col): `{ walk, edgeTo }` (fine walk then
 * one hop), `{ hop }` (one hop, no walk), `'chain'` (on the cave chain or the island already), or
 * null (somewhere this route does not cover -- refuse rather than wander).
 */
export function pitOutNext(room, row, col) {
  if (CHAIN.includes(room)) return 'chain';
  if (room === 2507 && chamberReachers('A').has(`${row},${col}`)) return { hop: 2502, why: "chamber A's corridor to the Hollows" };
  if (room === 2508 && chamberReachers('B').has(`${row},${col}`)) return { hop: 2501, why: "chamber B's corridor to 2501" };
  if (room === 2510) return { hop: 2504, why: 'the spring back to 2504' };
  // 2509 is an ordinary one-hop crossing (cave-walk-on's side-room hop): its descent to the 2500 edge
  // has drops a slide-free fine rail will not take, and nothing about it has failed live.
  if (room === 2509) return { hop: 2500, why: '2509 down to its east edge below row 39' };
  const out = PIT_OUT[room];
  return out ? { walk: out.approach, edgeTo: out.edgeTo, why: out.why, ...(out.press ? { press: out.press } : {}) } : null;
}

const where = l => `${l?.room?.num} r${l?.you?.row}c${l?.you?.col}`;

/** Leave the pit complex for the cave chain. Throws `pit_out: <step> at <room rNcM>: <why>`. */
export async function walkOutOfPit(ctx, { look, fineWalk, hop, go = null, maxSteps = 8 } = {}) {
  const path = [];
  for (let i = 0; i < maxSteps; i++) {
    const l = await look();
    const room = Number(l?.room?.num), next = pitOutNext(room, Number(l?.you?.row), Number(l?.you?.col));
    if (next === 'chain') return { ok: true, room, path };
    if (next == null) throw Error(`pit_out: no route from ${where(l)} -- start in the orc pit complex, the caves or Ko'catan`);
    if (next.walk) {
      // A door on the way: walk onto its trigger, `go`, and walk through while it is up. A door
      // that came down first is pressed once more before this gives up.
      let tries = next.press ? 2 : 1, last = null;
      for (; tries > 0; tries--) {
        try {
          if (next.press) {
            await fineWalk(room, next.press, null);
            if (!go) throw Error('no go verb to open the door');
            await go();
          }
          await fineWalk(room, next.walk, next.edgeTo); last = null; break;
        } catch (e) { last = e; }
      }
      if (last) throw Error(`pit_out: walk ${next.why} at ${where(await look().catch(() => l))}: ${last.message}`);
    }
    const to = next.hop ?? next.edgeTo;
    const leg = await hop(to).catch(e => ({ ok: false, reason: e.message }));
    if (!leg?.ok) throw Error(`pit_out: hop ${room} -> ${to} at ${where(await look().catch(() => l))}: ${leg?.reason ?? 'failed'}`);
    path.push(to);
  }
  throw Error('pit_out: step budget');
}

/** From a room on CHAIN, the cave walk to Ko'catan. `transit(from, room, to)` serialises 2502/2505. */
export async function walkChainToIsland(ctx, { look, hop, transit, singles = [2502, 2505], onPool = null } = {}) {
  const done = [];
  for (let guard = 0; guard < 12; guard++) {
    const l = await look(), here = Number(l?.room?.num), i = CHAIN.indexOf(here);
    if (here === 2000) return { ok: true, path: done };
    if (i < 0) throw Error(`cave_walk: off the chain at ${where(l)}`);
    const to = CHAIN[i + 1];
    if (singles.includes(to)) {
      try { await transit(here, to, CHAIN[i + 2]); }
      catch (e) { throw Error(`cave_walk: transit ${here} -> ${to} -> ${CHAIN[i + 2]} at ${where(await look().catch(() => l))}: ${e.message}`); }
      done.push(to, CHAIN[i + 2]);
      continue;
    }
    const leg = await hop(to).catch(e => ({ ok: false, reason: e.message }));
    if (!leg?.ok) throw Error(`cave_walk: hop ${here} -> ${to} at ${where(await look().catch(() => l))}: ${leg?.reason ?? 'failed'}`);
    done.push(to);
    if (to === 2504 && onPool) await onPool().catch(() => null);
  }
  throw Error('cave_walk: hop budget');
}

/** Where the walk would start from, for a refusal before anything moves. */
export function pitToHallStart(room, row, col, hall) {
  if (room === hall) return 'hall';
  if (room === 2000 || CHAIN.includes(room) || pitOutNext(room, row, col)) return 'caves';
  const name = loadMap().rooms?.[room]?.name;
  return { refuse: `${room}${name ? ` (${name})` : ''} r${row}c${col} is not in the orc pit complex, the caves, Ko'catan or the hall` };
}
