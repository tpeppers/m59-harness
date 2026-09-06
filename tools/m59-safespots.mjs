// Where to stand so that nothing can hit you.
//
// Players call these "safe walls" and learn them by experiment and word of mouth.
// The mechanic, stated plainly by someone who uses them: in a working safe spot NO
// MONSTER CAN HIT YOU UNLESS YOU SWING AT IT FIRST. A monster can only retaliate
// while it is standing still — once it moves it cannot reach you again — so if you
// stop swinging, the damage stops. Fighting stops being something that happens to
// you and becomes something you choose, one exchange at a time.
//
// That single property is worth more than everything else in this file, because of
// what it does to the two worst moments in a fight:
//
//   LOSING      is no longer a race to walk out of reach while being hit. Stop
//               swinging, sit down, rest to full, and decide again from full health.
//               A fight you were going to lose becomes a draw you can re-take.
//   A SWARM     cannot pile onto you, because seven of the eight squares it needs to
//               stand on are wall — and the ones that do get in still cannot land a
//               blow unless you start it.
//
// The exact physics is finer than the movement grid — it lives in the BSP walls and
// probably the angles — and this module does NOT claim to reproduce it. It does two
// separate things, and the difference between them matters:
//
//   GUESSES  from the grid, which squares are likely to work: how many things can
//            stand next to you at once, and how much wall is at your back.
//   REMEMBERS which squares actually DID work, because a guess is a hypothesis and
//            standing in one under attack is the experiment. See SafeSpotBook.
//
// The guess alone is not a consolation prize. The fleet's deaths are overwhelmingly
// swarm deaths: every room a Qor character may hunt in is 50-75% baby spider, so it
// fights a centipede while three spiders it never chose surround it. A square with
// three open neighbours instead of eight cuts the number of things that can be
// hitting you at any moment by more than half, with no mechanic beyond geometry.
//
// The reference case: Varuka, standing untouched in a swarm at r23c25 of the Main
// Gate to the City of Tos. That square has five open neighbours — west, east and
// south — and the ENTIRE north arc is wall. Back to the wall, exactly as described.
//
// COORDINATE CONTRACT. Geometry-analysis functions take 1-based positional (row,col),
// and named geometry records carry {row,col}. Selector callbacks and SafeSpotBook
// methods use public (col,row); persisted book keys are "col,row". A book record's
// optional x/y is the exact protocol/KOD fine position, 64 units per square.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RoomGeometry } from './m59-roo.mjs';
import './m59-navgeom.mjs';   // installs the height model + lenient fine path onto RoomGeometry

// The eight neighbours, in clockwise order, so that a run of blocked ones can be
// recognised as a contiguous arc rather than eight independent facts.
const RING = [
  [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1],
];

// WHAT CAN ACTUALLY HIT YOU, TAKEN FROM THE SERVER'S OWN ARITHMETIC RATHER THAN GUESSED.
//
// Everything above was written against the assumption that melee is an adjacency
// relation — that the things which can hit you are the eight squares touching yours.
// It is not, and the kod is unambiguous. Both sides run the same two tests:
//
//   REACH   SquaredDistanceTo(what) <= GetAttackRange^2, where SquaredDistanceTo is
//           (piRow-row)^2 + (piCol-col)^2 on SQUARE coordinates (nomoveon.kod:121).
//           A monster's range is Bound(2 + viDifficulty/6, 2, 3) (monster.kod:1682);
//           ours is 2 for bludgeon and slash, 3 for thrust (weapon.kod:52-54).
//   SIGHT   Room.LineOfSight from the attacker's square to yours (monster.kod:1782).
//
// So the squares something can hit you from are a DISC OF RADIUS 3 — up to 28 of them —
// filtered by line of sight. Not the eight that touch you. That single mistake is why
// this module kept recommending squares that then failed under attack: a flat wall
// blocks three of eight neighbours and scores as a 62% improvement, while leaving
// twenty of the twenty-eight squares that can really reach you completely open.
//
// AND ONLY THE MONSTER CHECKS SIGHT. Player.TargetWithinSightAndRange (player.kod:4115)
// checks range and a facing cone and never calls LineOfSight. That asymmetry IS the
// mechanic players describe: from the right square you can hit it and it cannot hit you
// back, so the fight becomes something you choose one exchange at a time. It is a
// property of specific squares and it is computable, which is what `free_shots` counts
// below. Nothing in this repository was looking for it.
//
// Radius 3 is the worst case, and deliberately so: a spot chosen against a 3 is safe
// against the 2 that most things actually have.
const MONSTER_REACH = 3;
// Our own worst case, which is the pessimistic direction for a DIFFERENT reason — it is
// the range we are sure we can strike at, so it is the range a free shot must be within.
export const PLAYER_REACH = 2;

function disc(radius) {
  const out = [];
  for (let dr = -radius; dr <= radius; dr++)
    for (let dc = -radius; dc <= radius; dc++)
      if ((dr || dc) && dr * dr + dc * dc <= radius * radius) out.push([dr, dc]);
  return out;
}
const MONSTER_DISC = disc(MONSTER_REACH);      // 28 squares
const PLAYER_DISC = disc(PLAYER_REACH);        // 12 squares
export const MAX_ATTACKERS = MONSTER_DISC.length;

// Room.LineOfSight (room.kod:2125), transcribed rather than approximated.
//
// It is NOT Bresenham. It advances one axis per iteration — whichever is currently
// further from the target — and asks CanMoveInRoom for that single step, giving up on
// the first refusal. The line it traces is therefore a staircase, and it is directional:
// sight from A to B is not always sight from B to A. The direction that matters is the
// attacker's, so callers pass the attacker's square first.
export function lineOfSight(geo, fromRow, fromCol, toRow, toCol, { fine = false } = {}) {
  let r = fromRow, c = fromCol, r2 = r, c2 = c;
  const rs = toRow - fromRow >= 0 ? 1 : -1;
  const cs = toCol - fromCol >= 0 ? 1 : -1;
  // Bounded because the caller's squares come from a disc, so the walk is at most six
  // steps; the guard is against a malformed geometry, not against the algorithm.
  for (let guard = 0; (r !== toRow || c !== toCol) && guard < 64; guard++) {
    if (Math.abs(r - toRow) > Math.abs(c - toCol)) r2 += rs; else c2 += cs;
    if (!geo.canMove(r, c, r2, c2, { fine })) return false;
    r = r2; c = c2;
  }
  return true;
}

// How exposed one square is: how many squares something could hit you from, and how
// many you could hit it from while it could not answer.
export function exposureAt(geo, row, col, { fine = false } = {}) {
  let attackers = 0, freeShots = 0, ourGround = 0;
  for (const [dr, dc] of MONSTER_DISC) {
    const ar = row + dr, ac = col + dc;
    if (!geo.walkable(ar, ac)) continue;              // nothing can stand in a wall
    if (lineOfSight(geo, ar, ac, row, col, { fine })) attackers++;
  }
  for (const [dr, dc] of PLAYER_DISC) {
    const ar = row + dr, ac = col + dc;
    if (!geo.walkable(ar, ac)) continue;
    ourGround++;
    // Within our reach, and the wall between us stops its line but not ours.
    if (!lineOfSight(geo, ar, ac, row, col, { fine })) freeShots++;
  }
  return { attackers, free_shots: freeShots, our_ground: ourGround };
}

// WHERE THE TWO GRIDS DISAGREE ABOUT WALKABILITY — WHICH IS WHAT A SAFE WALL *IS*.
//
// Everything else in this file scores a square on the COARSE grid: how many of the disc
// squares are walkable, what has line of sight, how long the blocked arc behind is. That
// describes a wall as the server's own artifact sees it, and the server's artifact is the
// thing MONSTERS path on. It says nothing about whether an approach the coarse grid offers
// can actually be MADE.
//
// The safety is exactly that gap. A monster paths to a square the coarse grid says is
// adjacent to us; the BSP the real geometry is built from refuses the step; the monster
// mills about outside a wall it believes it is standing next to. So the measure of a good
// wall is not how enclosed it looks — it is HOW MANY WAYS IN THE GRID OFFERS THAT THE
// MOVER REFUSES.
//
// `refused` counts approaches into this square that a coarse-grid pather believes in and
// the mover will not make. `offered` is how many the grid believes in at all, so the pair
// can be read as a ratio rather than as a raw count — a square with two of two refused is
// better cover than one with two of eight.
//
// IT RETURNS NULL WHEN IT CANNOT TELL, AND THAT IS NOT THE SAME AS ZERO.
// `moverStepLands` answers TRUE for everything when `collisionReady` is false — it is
// designed to get out of the way rather than to veto steps it cannot check. Reading that
// as "no disagreement" would score every square in the world as ordinary floor and quietly
// turn this whole criterion off, which is the shape of failure this repository keeps
// finding: a measurement that degrades to a plausible number instead of to an absence.
export function gridDisagreementAt(geo, row, col) {
  if (!geo || !geo.collisionReady || typeof geo.moverStepLands !== 'function') return null;
  let offered = 0, refused = 0;
  for (const [dr, dc] of RING) {
    const ar = row + dr, ac = col + dc;
    // Not offered by the coarse grid either, so there is nothing to disagree about.
    if (!geo.walkable(ar, ac)) continue;
    offered++;
    // The step a thing standing there would have to make to close on us. Asked in the
    // monster's direction — INTO this square — because that is the move that has to fail
    // for the wall to be worth standing at.
    if (!geo.moverStepLands(ar, ac, row, col)) refused++;
  }
  return { offered, refused };
}

// A SHELTER YOU CANNOT LEAVE IS A TRAP, NOT A SHELTER.
//
// Measured in The Twisted Wood, 2026-08-23. The book held a square at row 5, col 35 marked
// as having HELD — and from it the mover can reach FIVE squares and none of the room's five
// exits. A character that sheltered there could never leave the room:
//
//     row  col   coarse   reaches   exit squares reachable
//       7    2   true       1092    5 of 5        <- the entry square
//       5   35   true          5    0 of 5        <- the trap
//      11   15   true       1092    5 of 5
//      21   14   false      1092    5 of 5
//
// That is the four hundred and fifty seconds this fleet kept losing in one room, and the
// transit book recorded it as "every square for that exit refused (4 tried)" — a sentence
// about the exit, describing a body on an island somewhere else entirely.
//
// AND THE BOOK CALLED IT PROVEN, which is the cruelest part: nothing could reach the
// character there, so it held, so it was remembered as good. A perfect shelter and a perfect
// prison are the same square until you try to leave.
//
// So a candidate has to be able to get OUT. A bounded flood — the cap is what keeps this
// affordable when it runs over every square in a room — and anything that cannot reach
// `minEscape` squares is an island rather than a wall. Real walls in these rooms reach a
// thousand or more; the trap reached five, so the threshold is not delicate.
//
// ============ THIS IS A GUARD, NOT A FIX. THE BUG IT HIDES IS UPSTREAM ============
//
// The operator's correction, and it is right: in this game you can leave any square you can
// enter. A five-square island is not a feature of the map, it is our model being wrong, and
// this filter only stops us walking into the consequences.
//
// Two measurements say where the wrongness is, and they compound:
//
//   THE PLANNER SAYS THE SQUARE CANNOT BE ENTERED AT ALL. A flood from the room's entry
//   square across `moverStepLands` reaches 1,092 squares and 5,35 is not one of them. Yet
//   the safe-spot book records a character having HELD there. Something walked a body into
//   a square the step predicate says is unreachable — which means the fine walker and the
//   step predicate do not agree about what is walkable, and CLAUDE.md's rule is that the
//   router must plan on the map the mover ENFORCES.
//
//   AND THE PREDICATE IS ONE-WAY. On the island's border, 3 of 40 ordered pairs disagree
//   with themselves:
//
//       5,35 -> 5,36   out=false  back=true
//       4,35 -> 5,36   out=false  back=true
//       6,35 -> 5,36   out=false  back=true
//
//   You may step in and not back out. The game has no such door. A step predicate that is
//   not symmetric will manufacture islands anywhere the geometry is tight, and this is the
//   first one anybody has looked at.
//
// Neither pocket — in the Twisted Wood or the Western border — is needed for any route this
// fleet cares about, so refusing them costs nothing today. What it costs later is the memory
// of why, which is what this comment is for. `node tools/m59-exitgap.mjs` is the instrument
// aimed at exactly this class of disagreement.
const ESCAPE_CAP = 40;
// EVERY SQUARE THE BODY CAN ACTUALLY WALK TO, FROM WHERE IT IS STANDING.
//
// The counterpart to `escapeRoom`, and the half that was missing. That one asks whether you
// could LEAVE a square; nothing asked whether you could GET to it, and a shelter you cannot
// reach is not shelter — it is a character standing still being hit while a walk it can
// never finish is retried.
//
// Measured live, 2026-08-23, a character at row 25 col 28 in The Twisted Wood:
//
//     the mover reaches 1092 squares from there
//     the shelter it was offered, 14,38:   NOT among them
//     nearest reachable real wall, 25,27:  ONE SQUARE AWAY
//
// The search offered a square in a disconnected component twelve squares off while a
// perfectly good wall sat adjacent, and `walk_to` answered "no route the mover can walk
// through this geometry". It was right to.
//
// There has always been an optional `reach` predicate for this and this call path never
// passed one. An optional correctness check is a correctness check that is off — so this is
// computed here, once per search, rather than left to callers to remember.
const REACH_CAP = 8192;
export function reachableFrom(geo, from, cap = REACH_CAP) {
  if (!geo || !from || typeof geo.moverStepLands !== 'function') return null;   // cannot tell
  const r0 = Number(from.row), c0 = Number(from.col);
  if (!Number.isFinite(r0) || !Number.isFinite(c0)) return null;
  const seen = new Set([`${r0},${c0}`]);
  const q = [[r0, c0]];
  while (q.length && seen.size < cap) {
    const [a, b] = q.shift();
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r = a + dr, c = b + dc, k = `${r},${c}`;
      if (seen.has(k) || !geo.inBounds(r, c)) continue;
      let ok = false;
      try { ok = geo.moverStepLands(a, b, r, c); } catch { ok = false; }
      if (!ok) continue;
      seen.add(k); q.push([r, c]);
    }
  }
  return seen;
}

// THE QUARRY'S COARSE COMPONENT, MEASURED ONCE PER WALL SEARCH.
//
// A wall can be two squares from a monster on the picture and still be on the other side
// of a door, cliff, or one-way grid edge. Straight-line distance cannot answer whether a
// pull can ever convert. Monsters on the stock server move on the coarse grid, so flood
// that directed graph from the selected quarry once, then answer each candidate by asking
// whether any reachable coarse square lies inside OUR combat disc around the wall.
//
// The returned function has the same `(col, row) -> reach result` shape nearestSafeSpot
// already accepts. `steps` is the shortest coarse walk to an attack position, not to the
// safe square itself — the monster never needs to stand on the player.
export function coarseCombatReachFrom(geo, from,
                                      { reach = PLAYER_REACH, cap = REACH_CAP } = {}) {
  if (!geo || !from || typeof geo.openDirections !== 'function'
      || typeof geo.walkable !== 'function' || typeof geo.inBounds !== 'function') return null;
  const r0 = Number(from.row), c0 = Number(from.col);
  if (!Number.isFinite(r0) || !Number.isFinite(c0) || !geo.inBounds(r0, c0)) return null;

  const distance = new Map([[`${r0},${c0}`, 0]]);
  const queue = [[r0, c0]];
  for (let at = 0; at < queue.length && distance.size < cap; at++) {
    const [row, col] = queue[at];
    const steps = distance.get(`${row},${col}`) ?? 0;
    let directions = [];
    try { directions = geo.openDirections(row, col, { fine: false }) || []; } catch { directions = []; }
    for (const d of directions) {
      const r = row + d.dr, c = col + d.dc, key = `${r},${c}`;
      if (distance.has(key) || !geo.inBounds(r, c) || !geo.walkable(r, c)) continue;
      distance.set(key, steps + 1);
      queue.push([r, c]);
    }
  }

  const combatDisc = disc(reach);
  return (col, row) => {
    let best = null;
    for (const [dr, dc] of combatDisc) {
      const attackRow = row + dr, attackCol = col + dc;
      const steps = distance.get(`${attackRow},${attackCol}`);
      if (steps == null || (best && steps >= best.steps)) continue;
      best = { steps, row: attackRow, col: attackCol };
    }
    return best
      ? { reachable: true, steps: best.steps, grid: 'coarse', combat_reach: reach,
          attack_position: { col: best.col, row: best.row } }
      : { reachable: false, steps: null, grid: 'coarse', combat_reach: reach,
          why: `the quarry's coarse component never comes within ${reach} squares of this spot` };
  };
}

export function escapeRoom(geo, row, col, minEscape = 24) {
  if (!geo || typeof geo.moverStepLands !== 'function') return true;   // cannot tell: allow
  const seen = new Set([`${row},${col}`]);
  const q = [[row, col]];
  while (q.length && seen.size < ESCAPE_CAP) {
    const [r0, c0] = q.shift();
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r = r0 + dr, c = c0 + dc, k = `${r},${c}`;
      if (seen.has(k) || !geo.inBounds(r, c)) continue;
      let ok = false;
      try { ok = geo.moverStepLands(r0, c0, r, c); } catch { ok = false; }
      if (!ok) continue;
      seen.add(k);
      if (seen.size >= minEscape) return true;      // out is out; stop counting
      q.push([r, c]);
    }
  }
  return seen.size >= minEscape;
}

// The longest run of blocked directions, treating the ring as circular. A square
// with four blocked neighbours scattered around it is exposed from every side; one
// with four in a row has its back covered, which is the thing players describe.
function backCover(blocked) {
  const n = blocked.length;
  if (blocked.every(Boolean)) return n;
  let best = 0, run = 0;
  for (let i = 0; i < n * 2; i++) {
    run = blocked[i % n] ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

// THE SAFE WALLS ARE THE RED SQUARES IN THE DEBUG CLIENT. THAT IS THE DEFINITION.
//
// Corrected 2026-08-27, by the operator, against the picture: the squares the client paints
// red on its minimap were checked by eye, room by room, and they are right. So the keeper
// chooses from EXACTLY that set, computed by EXACTLY this function, and the overlay paints
// EXACTLY this function. If the picture and the choice ever differ again, this file is
// wrong — not the eye.
//
// What a red square is, in the terms of the two grids:
//
//   * it is a square the COARSE grid admits — the grid monsters path and see on;
//   * from no square within a monster's reach (MONSTER_DISC, radius 3) does the coarse
//     line of sight — Room.LineOfSight, transcribed in lineOfSight() — arrive at it, so
//     `attackers` is 0: as far as the monster's grid is concerned, nothing can ever get a
//     swing at a body standing here;
//   * and at least one square within OUR reach (PLAYER_DISC, radius 2) can be hit from
//     here while its line back is blocked, so `free_shots` is above 0: we can fight from it.
//
// That is the coarse grid and the fine one disagreeing about the same square — the
// monster's grid says "cannot reach", ours says "can hit" — and it is the whole of the
// mechanism. Nothing else is a candidate, and nothing else removes one: not escape room,
// not exposure, not standability, not the outer ring. Those are all still MEASURED, and
// they ORDER the list (see safeSpots), because a wall you cannot leave or one on the room's
// rim is a worse wall; they no longer decide what is a wall.
//
// This replaced a scan that admitted only squares the coarse grid REFUSED (2026-08-23),
// which was the opposite set and disjoint from the picture by construction — 506
// candidates in the Valley of Ileria and not one of them a red square. The fleet stood next
// to hundreds of verified walls and was told there were none it could use.
export function safeWalls(geo, { los = 0 } = {}) {
  if (!geo) return [];
  // Which grid governs the thing trying to hit us. LOS_OLD is the server default, so
  // monsters move and see on the COARSE grid — see RoomGeometry.LOS.
  const fine = RoomGeometry.monsterUsesFine(los);
  const out = [];
  for (let r = 1; r <= geo.rows; r++)
    for (let c = 1; c <= geo.cols; c++) {
      if (!geo.walkable(r, c)) continue;
      let ex = null;
      try { ex = exposureAt(geo, r, c, { fine }); } catch { continue; }
      if (!ex || ex.attackers !== 0 || (ex.free_shots ?? 0) <= 0) continue;
      out.push({ row: r, col: c, ...ex });
    }
  return out;
}

// Every safe wall in a room, DESCRIBED and ORDERED. Membership is safeWalls() and nothing
// here narrows it; everything computed below is for ranking and for the book.
export function safeSpots(geo, { limit = 8, mustReach = null, los = 0,
                                // How many squares a shelter has to be able to reach before
                                // it counts as somewhere you can leave. See escapeRoom.
                                // Measured and scored, never a gate.
                                minEscape = 24 } = {}) {
  if (!geo) return [];
  const out = [];
  for (const w of safeWalls(geo, { los })) {
    const { row: r, col: c, attackers, free_shots, our_ground } = w;
    const blocked = RING.map(([dr, dc]) => !geo.walkable(r + dr, c + dc));
    const open = blocked.filter(b => !b).length;
    const cover = backCover(blocked);
    // LEDGE EDGE: if any orthogonal neighbour is a drop (floor falls more than one step),
    // a spot here is one mistimed step from a fall. Ranked down hard; a clifftop corner
    // must not score well. Only matters in multi-level rooms.
    let ledge = false;
    if (typeof geo.heightStepOk === 'function') {
      if (!geo.heightStepOk(r, c, r + 1, c) || !geo.heightStepOk(r, c, r - 1, c) ||
          !geo.heightStepOk(r, c, r, c + 1) || !geo.heightStepOk(r, c, r, c - 1))
        ledge = true;
    }
    // WHICH WAY THE WALL IS, so a character can be put against it rather than in the
    // middle of the square. The sum of the blocked directions points into the wall,
    // normalised to at most one step on each axis because it is a direction.
    let dr = 0, dc = 0;
    for (let i = 0; i < RING.length; i++) {
      if (!blocked[i]) continue;
      dr += RING[i][0]; dc += RING[i][1];
    }
    const wall = (dr || dc) ? { dr: Math.sign(dr), dc: Math.sign(dc) } : null;
    // Approaches the coarse grid offers and the mover refuses — reported, ranked on, and
    // null where collision is not baked ("cannot tell", never "none"). See gridDisagreementAt.
    const disagree = gridDisagreementAt(geo, r, c);
    // A wall you cannot leave is a worse wall (see escapeRoom for the five-square island in
    // The Twisted Wood); the room's outermost ring ejects you (StandardLeaveDir). Both are
    // ranked down, neither is struck: the picture is the definition.
    const escapes = escapeRoom(geo, r, c, minEscape);
    const rim = r <= 1 || c <= 1 || r >= geo.rows || c >= geo.cols;
    out.push({
      col: c, row: r,
      refused_approaches: disagree ? disagree.refused : null,
      offered_approaches: disagree ? disagree.offered : null,
      // The old field name is kept because it is written into the book and the fleet page;
      // it counts the monster disc, so it runs 0..28. For a safe wall it is always 0.
      can_reach_you: attackers,
      free_shots,
      open_neighbours: open,
      back_cover: cover,
      wall,
      attackers_avoided: MAX_ATTACKERS - attackers,
      escapes,
      rim,
      ledge,
    });
  }
  // NEAREST FIRST, AND NOTHING ELSE. THERE IS NO SUCH THING AS A MORE DEFENSIBLE WALL.
  //
  // This used to carry a `score` — attackers avoided, plus free shots, plus back cover,
  // plus grid disagreement, minus penalties for ledges and rims — and everything that
  // chose a wall sorted on it. It was a composite of five guesses presented as a number,
  // and it decided where hurt characters walked.
  //
  // Measured, it was killing them. Over one 30-minute world tour: 80 runs for cover, 18
  // arrivals. The room that worked picked a wall 3.4 squares away and got there 11 times
  // in 20; the rooms that never once arrived picked walls 17.4, 18.0 and 24.4 squares
  // away. A marginally better corner across the room beat a plain wall edge beside you,
  // and a character at 58% health walked eighteen squares to reach it. One arrived at 4%.
  //
  // Membership is `safeWalls()` and it is binary: the two grids disagree about a square
  // or they do not. Every square that passes is the same kind of thing, so the only
  // honest question left is which one is closest. The descriptive fields below are kept —
  // they are written into the book and the fleet page and they are facts about a square —
  // but nothing ranks on them any more.
  const picked = [];
  for (const s of out) {
    if (mustReach) {
      const p = mustReach(s.col, s.row);
      if (!p?.reachable) continue;
      s.steps_away = p.steps;
    }
    picked.push(s);
  }
  // Row/col breaks the tie so the answer is stable between passes; a wall that changes
  // identity every time it is asked for is one nothing can learn about.
  picked.sort((a, b) => (a.steps_away ?? Infinity) - (b.steps_away ?? Infinity)
                     || a.row - b.row || a.col - b.col);
  return limit === Infinity ? picked : picked.slice(0, limit);
}

/**
 * The squares from which `to` can be walked back to — reverse reachability, one BFS.
 *
 * A SAFE SPOT YOU CANNOT COME BACK FROM IS A TRAP, NOT A SHELTER. The nearest wall by
 * step count is sometimes over a one-way drop: the mover will happily walk a character
 * off a ledge it cannot climb, the character rests, and then the journey it interrupted
 * has no route left. Distance alone cannot see that, because the step down is cheap and
 * it is the step back up that does not exist.
 *
 * Edges are followed BACKWARDS — `moverStepLands(neighbour, here)` asks whether the
 * neighbour can step to us, not whether we can step to it — so what comes back is every
 * square that can reach `to`, which is exactly the question.
 *
 * A geometry that cannot answer says so by returning null, and a throw inside the walk
 * counts as passable: no opinion means carry on, the same rule the step mask follows,
 * because a bake must never be the thing that makes a wall disappear.
 */
export function returnReachableTo(geo, to, { cap = 20000 } = {}) {
  if (!geo || typeof geo.moverStepLands !== 'function') return null;
  const r0 = Number(to?.row), c0 = Number(to?.col);
  if (!Number.isInteger(r0) || !Number.isInteger(c0)) return null;
  const seen = new Set([`${r0},${c0}`]);
  const queue = [[r0, c0]];
  for (let i = 0; i < queue.length && seen.size < cap; i++) {
    const [r, c] = queue[i];
    for (const [dr, dc] of RING) {
      const nr = r + dr, nc = c + dc;
      const k = `${nr},${nc}`;
      if (seen.has(k)) continue;
      if (typeof geo.inBounds === 'function' && !geo.inBounds(nr, nc)) continue;
      let ok = true;
      try { ok = geo.moverStepLands(nr, nc, r, c); } catch { ok = true; }
      if (!ok) continue;
      seen.add(k);
      queue.push([nr, nc]);
    }
  }
  return seen;
}

// The best spot near where we are standing now, rather than the best in the room —
// walking thirty squares across a monster room to reach a marginally better corner
// is how you die on the way to safety.
//
// `book` is the memory of what has actually been tried here, and it OUTRANKS the
// geometry, because the geometry is a hypothesis and the book is a result. A square
// that held under attack is worth more than a better-looking square that has never
// been stood on, and a square that failed is worth nothing at all however good it
// looks — which is the whole reason for keeping the book.
// `toward` is where the fight has to happen — the prey. Without it this picks the
// most defensible square near US, which in a big outdoor room is a wall on the far
// side of the field from anything worth killing: the keeper walks to a perfect corner,
// discovers the nearest centipede is twelve steps away and cannot be fetched, gives
// the corner up, and picks the same one again next pass. A safe spot nothing can be
// brought to is not a safe spot, it is a bench. But the room grid is only a prediction
// of that fact: it ranks predicted-reachable squares first and still offers a doubtful
// square when none remain. Repeated live pulls are the veto.
// THE SPOT MUST ULTIMATELY BE ONE THE FIGHT CAN REACH, and that is a different question
// from whether we can reach it. A clifftop scores beautifully on defensibility — almost
// nothing can stand next to you, which is the whole metric — and we can walk up to it.
//
// `quarryReach(col,row)` answers "could the thing we came to fight get here", on the
// grid that governs MONSTERS (see RoomGeometry.LOS — the stock server puts them on the
// coarse grid). Null means the caller cannot say. False lowers a square behind every
// predicted-reachable option; it no longer suppresses the live experiment.
// WHAT A SAFE WALL ACTUALLY IS, AND WHY THE DISC METRICS ARE NOT IT.
//
// `attackers_avoided` and `free_shots` are transcriptions of the server's reach and
// sight tests, and both are correct about what they compute. Neither is what a player
// means by a safe wall, and the book says so once the evidence is cleaned:
//
//   attackers_avoided   r = 0.294, and NOT monotone — the 20-24 band holds 19.7% of the
//                       time against 39.1% for 15-19. The threshold sat in a trough.
//   free_shots          r = 0.241
//   blocked neighbours  r = 0.251
//   back_cover          r = 0.291, and back_cover >= 5 holds 89.7% of the time
//
// Four weak predictors in the same band, and the strongest single rule in the whole set
// is the one closest to the plain description: get a run of wall behind you.
//
// The old numbers looked far better than that (84.7% for avoided >= 20) because they
// were measured against a ledger where 27% of the failures were phantoms written by
// restBroken() with nothing adjacent — see the note there. Those phantoms are all open
// floor, so they inflated every metric that rewards enclosure.
//
// So the filter is now the requirement a person would state: A WALL YOU CAN PUT YOUR
// BACK TO. Ranked by how much of it there is, with the disc score kept as a tie-break
// rather than a gate, because it is weakly informative and free to compute.
//
// `rule` selects between them. 'disc' is the previous behaviour, kept because it is the
// thing this is being measured against and a claim nobody can re-run is not a finding.
export const SPOT_RULES = ['wall', 'disc'];

// TEST THE CORNERS FIRST, BECAUSE THE CLIFF IS NOT A SLOPE.
//
// back_cover is scored linearly above, which spreads the difference between a flat wall
// and a corner over six points — and that is not the shape of the evidence. On the
// cleaned ledger:
//
//   back_cover 0      23.5% held   (n=17)
//   back_cover 1-2    20.0% held   (n=60)
//   back_cover 3-4    38.6% held   (n=456)
//   back_cover 5-6    88.9% held   (n=27)
//   back_cover 7-8   100.0% held   (n=2)
//
// Everything from 0 to 4 is a coin-flip at best. At 5 it more than doubles. That is a
// step, so it is priced as one.
//
// SIZED TO OUTRANK ONE HOLD, DELIBERATELY. The proof bonus gives a square that has held
// once 21 points, which under the linear score alone means an untested corner (15) loses
// to a once-held flat wall (9 + 21 = 30) every time — so the 88.9% band never gets
// explored anywhere a mediocre square has already been proven, which is nearly
// everywhere. That is the wrong bet on our own numbers: an untested corner at 88.9%
// prior beats a flat wall measured at 38.6%. At 24 the ordering comes out:
//
//   untested corner            15 + 24 = 39
//   once-held flat wall         9 + 21 = 30      -> the corner is tried first
//   five-times-held flat wall   9 + 25 = 34      -> still the corner
//   VERIFIED flat wall          9 + 60 = 69      -> a person's judgement still wins
//   once-held corner           39 + 21 = 60      -> and proof still compounds
//
// So this changes which HYPOTHESIS is tested next and never overrules a human. It costs
// a walk when it is wrong, which is the cheap direction — see discredited().
const CORNER = 5;
const CORNER_BONUS = 24;
/**
 * THE SHELTERS ALONG A ROUTE, WORKED OUT BEFORE THE ROUTE IS WALKED.
 *
 * You do not add a fuel stop to a journey by braking in the middle of the road, unfolding a
 * map and re-planning from a standstill. You work out where the stops are while you are
 * still driving, and when you need one you change the road ahead. That is the whole idea
 * here, and the thing it replaces is exactly the braking version: the mid-hop wall rung used
 * to cancel the journey, hand the character back, search the room from where it happened to
 * be standing, and walk to whatever it found. Measured, that is the wrong shape — health
 * leaves at a median of 4.7 a second once something starts, and the average maximum on this
 * fleet is 45, so a full bar is nine and a half seconds. Stopping to think is most of it.
 *
 * So this is asked ONCE, when the crossing is planned, and the answer travels with the plan.
 * Each entry says which step of the route it hangs off and how far off the road it is, which
 * is what lets a caller take the next one AHEAD of it rather than the nearest one in any
 * direction — behind is where it has already been bitten.
 *
 * Costs nothing at runtime: a route that never needs a stop never looks at the list.
 */
export function sheltersAlong(geo, steps, {
  within = 6, book = null, room = null, minBackCover = 1, limit = 24,
} = {}) {
  if (!geo || !Array.isArray(steps) || !steps.length) return [];
  const out = [];
  const seen = new Set();
  // ONE FLOOD FOR THE WHOLE PATH. Every step of a plan is in the same connected component,
  // so asking per step is the same answer computed fifty times — and it froze the walker for
  // up to twenty-eight seconds at a stretch when the reachability filter was added.
  const reachable = reachableFrom(geo, { row: steps[0].row, col: steps[0].col });
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (!Number.isFinite(st?.row) || !Number.isFinite(st?.col)) continue;
    let spot = null;
    try {
      spot = nearestSafeSpot(geo, { row: st.row, col: st.col },
                             { within, book, room, minBackCover, reachable });
    } catch { spot = null; }
    if (!spot) continue;
    const k = `${spot.col},${spot.row}`;
    if (seen.has(k)) continue;          // one entry per square, at the first step that reaches it
    seen.add(k);
    out.push({
      col: spot.col, row: spot.row,
      // WHICH STEP IT HANGS OFF. A caller walking the plan knows how far along it is, so this
      // is what makes "ahead" answerable at all.
      atStep: i,
      detour: spot.steps_away ?? Math.max(Math.abs(spot.row - st.row), Math.abs(spot.col - st.col)),
      proven: !!spot.proven,
      backCover: spot.back_cover ?? null,
      // WHAT MAKES IT A WALL AT ALL — the approaches the coarse grid offers and the mover
      // refuses. Carried through from the candidate so `shelterAhead` can rank on the
      // mechanism rather than on whether we happen to have stood here before. null means
      // the room is not baked and the question could not be asked; see gridDisagreementAt.
      refused_approaches: spot.refused_approaches ?? null,
      offered_approaches: spot.offered_approaches ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The next shelter AHEAD on a route, or null.
 *
 * `atStep` is where the walker has got to. Behind is not offered: a character that is being
 * hurt got that way somewhere, and sending it back through the place it was bitten to reach
 * a wall it has already passed is worse than carrying on. `maxDetour` is the real gate — a
 * wall twelve squares off the road is not shelter when there are nine seconds of health
 * left, it is a longer way to die.
 */
export function shelterAhead(shelters, atStep,
                             { maxDetour = 4, requireDisagreement = true, unreachable = null,
                               exitable = null,
                               // NEARLY DEAD: take the BEST wall ahead, not the next one.
                               emergency = false,
                               // How much further along the route an emergency will walk to
                               // get a better wall. Steps, not squares off the road.
                               emergencyWithin = 8 } = {}) {
  if (!Array.isArray(shelters) || !shelters.length) return null;
  let ahead = shelters.filter(s => s.atStep >= atStep && s.detour <= maxDetour);
  // A REFUGE YOU CANNOT LEAVE IS A COFFIN, AND THIS ASKED ONLY WHETHER WE COULD GET IN.
  //
  // `unreachable` above is the walk TO the wall failing. Nothing asked about the walk back
  // out, and a safe spot is BY DEFINITION a square the two grids disagree about — which is
  // the same property that makes some of them impossible to leave. Measured in 587, three
  // deaths inside six minutes, all three on the same pair of squares:
  //
  //     44,29   walkable false   3 mover steps out
  //     45,29   walkable false   0 mover steps out
  //
  // Each character diverted there at around 90% health, stopped moving, and was eaten over
  // 65 to 80 seconds by twelve spiders and centipedes while the keeper watched — health
  // trails that sit flat at full and then fall to 3 without the character ever moving a
  // square. The guard was armed and fleeing needs somewhere to flee to.
  //
  // NULL IS NOT ZERO here either: a caller with no geometry passes nothing and every
  // candidate stands, because a missing map must never be the thing that empties the list.
  if (exitable) ahead = ahead.filter(s => exitable(s.col, s.row) !== false);
  // The same exclusion the room search applies: a planned stop we have just failed to walk
  // to is not a stop. Applied before the ranking below rather than after, so a shelter that
  // cannot be reached does not win on disagreement and then fail again.
  if (unreachable) ahead = ahead.filter(s => !unreachable.has(`${s.col},${s.row}`));
  if (!ahead.length) return null;

  // A WALL IS THE TWO GRIDS DISAGREEING, AND THAT IS THE ONLY THING ASKED ABOUT HERE.
  //
  // `preferProven` used to break ties, and it was the wrong question twice over. It ranked
  // by whether this fleet had happened to stand somewhere before — which is a fact about
  // where it has been, not about the square — and on a road nobody has walked yet it is
  // simply absent, so the tie-break did nothing exactly where a stop matters most.
  //
  // The mechanism is available instead: `refused_approaches` counts the ways in that the
  // coarse grid offers and the mover refuses. That is what stops a monster reaching us, it
  // is computable for a square nobody has ever visited, and it does not decay when the book
  // is discredited.
  //
  // NULL IS NOT ZERO. An unbaked room cannot answer, and dropping those would empty the
  // list in exactly the rooms where collision has not been baked yet — so a null is kept
  // and sorted last, never filtered out. Only a square that CAN answer and answers "no
  // disagreement" is refused, because that square is plain floor wearing a wall's name.
  if (requireDisagreement) {
    const answerable = ahead.filter(s => s.refused_approaches != null);
    const disagreeing = answerable.filter(s => s.refused_approaches > 0);
    // Everything that could answer said no: fall through to the unanswerable ones rather
    // than returning null, since "not baked" is not evidence against a square.
    ahead = disagreeing.length || answerable.length < ahead.length
      ? [...disagreeing, ...ahead.filter(s => s.refused_approaches == null)]
      : [];
    if (!ahead.length) return null;
  }

  // Nearest along the route first, so the stop is the next one rather than the best one —
  // the best one may be forty squares further on, which is the same mistake as searching.
  //
  // EXCEPT WHEN THE NEAREST ONE WILL NOT DO. `atStep` being the first key means quality
  // breaks exact ties only, and two walls are almost never at the same step — so the wall
  // taken is simply the next one, whatever it is. That is right while a character is merely
  // hurt and wrong when it is nearly dead, because the walls in these rooms are not
  // interchangeable: 587 offers eight, one of which refuses seven approaches and the rest
  // refuse one or two.
  //
  // Measured, one character, one crossing: three refuges taken at 48%, 38% and 27% health,
  // every one of them `taking_hits: true`, each rest aborted by the damage it was meant to
  // escape, dead on the fourth. It had unlimited shelter below 30% and spent it on the
  // three nearest squares rather than the one that would have held.
  //
  // So `emergency` ranks by how many ways in the mover refuses, and falls back to distance
  // only to break THAT tie. The candidate set is unchanged — still ahead of us, still
  // inside `maxDetour` — so this cannot send anybody across the room for a better wall.
  // AND A BETTER WALL IS ONLY BETTER IF WE REACH IT. The original objection to ranking by
  // quality stands — "the best one may be forty squares further on" — and a character at
  // 27% health walking eighteen extra squares through what is already hitting it has not
  // been helped. So an emergency looks at the walls it can actually get to first, and only
  // widens to the whole route if there are none.
  //
  //     587, ranked by quality alone:   refused_approaches 1 -> 7, but atStep 0 -> 18
  //     587, bounded to the next 8:     the best wall inside reach, whatever that is
  if (emergency) {
    const soon = ahead.filter(s => s.atStep <= atStep + (emergencyWithin ?? 8));
    if (soon.length) ahead = soon;
  }
  ahead.sort(emergency
    ? (a, b) => ((b.refused_approaches ?? -1) - (a.refused_approaches ?? -1))
             || (a.atStep - b.atStep) || (a.detour - b.detour)
    : (a, b) => (a.atStep - b.atStep)
             || ((b.refused_approaches ?? -1) - (a.refused_approaches ?? -1))
             || (a.detour - b.detour));
  return ahead[0];
}

// TARGET-FIRST WALL ORDERING. Eligibility is settled before this comparison: the square
// is a safe wall, the player can reach it, nobody is standing there, and (when supplied)
// the selected quarry's coarse component reaches our combat disc. Among those valid
// answers, "closest to the monster" is literal. Existing defensibility/proof/path value
// only breaks a tie; it can no longer buy a wall thirty squares across the room.
export function preferSafeSpotCandidate(candidate, current, { closestToToward = false } = {}) {
  if (!current) return true;
  if (closestToToward) {
    const candidateDistance = Number.isFinite(candidate?.target_distance)
      ? candidate.target_distance : Infinity;
    const currentDistance = Number.isFinite(current?.target_distance)
      ? current.target_distance : Infinity;
    if (candidateDistance !== currentDistance) return candidateDistance < currentDistance;

    // Equal geometric distance can still hide a long route around an internal wall. Both
    // candidates have passed the hard reach check; prefer the shorter coarse approach.
    const candidateSteps = Number.isFinite(candidate?.quarry_steps)
      ? candidate.quarry_steps : Infinity;
    const currentSteps = Number.isFinite(current?.quarry_steps)
      ? current.quarry_steps : Infinity;
    if (candidateSteps !== currentSteps) return candidateSteps < currentSteps;
  }
  return (candidate?.value ?? -Infinity) > (current?.value ?? -Infinity);
}

export function nearestSafeSpot(geo, from, {
  within = 12, minAvoided = 20, reach = null, book = null, room = null, toward = null,
  quarryReach = null, strictQuarryReach = false, stats = null, los = 0,
  rule = 'wall', minBackCover = 1, fromFightWeight = 0.3,
  closestToToward = false,
  allowExit = true,
  // false withholds every wall and leaves the exit (when a journey names one): the crowd
  // rule — see Autopilot.crowded — because a wall in a room of thirteen trolls is not one.
  wallsAllowed = true,
  // SQUARES WE COULD NOT GET TO. A different fact from a square that failed to HOLD, which
  // is what `discredited` records — this one is about the walk, not about the wall.
  // See `unreachableSpots` on the keeper for why it is session-scoped and expires.
  unreachable = null,
  // THE REACHABLE SET, WHEN THE CALLER ALREADY HAS ONE — because computing it is expensive
  // and a whole path shares one answer. See `canWalkThere` below.
  reachable = null,
  // A JOURNEY HAS A DIRECTION, AND A WALL ON THE ROAD AHEAD IS WORTH MORE THAN ONE BEHIND.
  //
  // `onward` is the square the character is trying to leave the room by. When it is given
  // the bar changes in two ways the operator asked for on 2026-09-01, after Bbbb died in
  // The border of the Badlands with the only offered wall 31 squares back down a road it
  // had already been bitten on:
  //
  //   - DISTANCE STOPS BEING A REASON. `within` is not applied. What is asked instead is
  //     that the wall be reachable from here AND that the exit be reachable from the wall
  //     — bidirectional in the direction that matters, not "can I get back to where I am
  //     standing", which is the question `canComeBack` asks when there is no journey.
  //   - FORWARD IS PREFERRED, HARD. `forwardBias` multiplies the progress a wall makes
  //     toward the exit (squares closer than we are now), and a backtrack is charged at the
  //     same rate. At eight, a wall twenty squares on that brings the exit fifteen closer
  //     scores +100 and a wall three squares behind scores -27: the road ahead wins whenever
  //     it offers anything at all, and only a road with nothing ahead falls back to the
  //     nearest refuge behind. Without `onward` nothing here changes.
  onward = null,
  forwardBias = 1,
} = {}) {
  if (!geo || !from) return null;
  const onwardSquare = onward && Number.isFinite(onward.row) && Number.isFinite(onward.col) ? onward : null;
  const distanceMatters = !onwardSquare;
  const cheb = (a, b) => Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));
  const hereToExit = onwardSquare ? cheb(from, onwardSquare) : 0;
  // EVERY QUALIFYING SQUARE, NOT THE TOP FEW HUNDRED BY SCORE.
  //
  // This asked for the 400 best-scoring squares in the room and then filtered THOSE by
  // distance and by the book. Both of those orderings are wrong way round, and in a
  // big outdoor room the effect is severe: score rewards enclosure, so a tight alcove
  // scores roughly twice a plain wall edge and the 400 slots fill up with alcoves
  // before a single edge is considered. Discredit the alcoves — which is
  // what happens after a few hours in a room, 95 of them at the Tos gate — and this
  // returns null, reporting "nothing here is more defensible than open floor" about a
  // room with hundreds of perfectly good walls in it.
  //
  // MINAVOIDED IS 20 OF 28, AND IT IS SET FROM THE BOOK RATHER THAN FROM TASTE.
  //
  // It was 3 of 8, which sounded like "a wall at your back" and was in practice no
  // filter at all: of the 826 recorded squares with an outcome, 777 — 94% of them —
  // scored 3 or 4 on the ring, so the cutoff admitted almost everything and the model
  // could not tell a good square from a bad one. Those 777 held 39.5% of the time.
  //
  // On the reach disc the same squares separate properly, and the separation is sharp:
  //
  //   avoided 10-14   26.8% held        free_shots 0     30.6% held
  //   avoided 15-19   39.2% held        free_shots 1-2   42.4% held
  //   avoided 20+     84.7% held        free_shots 3+    89.4% held
  //
  // 20 is where that cliff is. It is affordable: across the 107 rooms the fleet hunts
  // in or has a book entry for, 106 have squares clearing it, and the busy ones have
  // between 43 and 404 of them. So this refuses far more than it used to and still
  // leaves every real hunting room hundreds of candidates.
  //
  // The cap bought nothing anyway — the loop below already narrows by `within` long
  // before anything expensive happens. Scoring every square is one pass over the room.
  const all = safeSpots(geo, { limit: Infinity, los });
  // WHAT THE BODY CAN ACTUALLY WALK TO. Computed once, here, rather than left to whichever
  // caller remembered to pass `reach` — see reachableFrom. Null when it cannot be measured,
  // and null means every candidate is allowed through, because refusing them all would turn
  // a checkout with no collision baked into a fleet that never shelters.
  // SUPPLIED BY THE CALLER WHEN THERE IS ONE, BECAUSE THIS IS EXPENSIVE AND SHARED.
  //
  // The flood is up to 8,192 squares of `moverStepLands` traces. `sheltersAlong` calls this
  // once per STEP of a plan, so a fifty-step crossing of a 2,700-square room ran fifty of
  // them — and the walker froze while it did. Measured in Ukgoth after the reachability
  // filter went in: median gap between moves 468ms, p90 2,648ms, WORST 27,847ms, and a
  // character that could not cross the room before something killed it.
  //
  // Every step of one path is in the same connected component by construction, so one flood
  // answers for all of them.
  const canWalkThere = reachable ?? reachableFrom(geo, from);
  // THE OTHER DIRECTION, WHICH NOTHING USED TO ASK. `canWalkThere` is "can we get to it";
  // this is "could we get back", and they are different sets wherever the world has a
  // one-way step in it — a drop, a ledge, a grid edge that ejects you. One BFS, shared by
  // every candidate. See returnReachableTo.
  // With a journey a wall that can reach ITS DOOR is wanted too — that is what lets the
  // forward preference reach past the distance cap — but it is an ADDITION to the walls we
  // can walk back from, never a replacement. Corrected 2026-09-01: for a day this asked only
  // "can it reach the exit", and from a pocket that cannot reach the exit at all (the Cragged
  // Mountains from r30c25: 185 of 196 walls unreachable, two eligible) every wall was then
  // "one-way" and a character under attack was told there was nothing to take.
  const canComeBack = returnReachableTo(geo, from);
  const reachesOnward = onwardSquare ? returnReachableTo(geo, onwardSquare) : null;
  const known = book && room != null ? book.recall(room) : null;
  let best = null;
  let bestPredictedUnreachable = null;
  let unreachableByQuarry = 0;
  let reachableByQuarry = 0;
  let eligible = 0;
  let unreachableToUs = 0;
  let oneWay = 0;
  let reachesOnwardCount = 0;
  let exitConsidered = false;
  let partitionRejected = 0;
  for (const s of (wallsAllowed ? all : [])) {
    const seen = known?.get(key(s.col, s.row)) || null;
    // NO SQUARE IS DISQUALIFIED BY ITS HISTORY. `discredited` is unconditionally false now
    // — see the argument on it — so this filter is a no-op and is kept only so the shape of
    // the loop still says where the question used to be asked. Geometry has already decided
    // that everything in `all` is a wall; what follows filters on REACHABILITY, which is
    // about this walk rather than about the square.
    if (seen && book.discredited(seen)) continue;
    // NOR TO ONE WE HAVE JUST FAILED TO WALK TO. A wall that cannot be reached is not
    // shelter, and offering it again is how a hurt character spends a whole room choosing
    // the same unreachable square: measured in the Western border of the Twisted Wood, the
    // decision trail read "could not reach the safe spot" / "will not rest in the open here"
    // / "leaving the room to recover safely" / "could not leave", and then the character
    // died. Nothing recorded the failure, so every pass made the identical choice.
    if (unreachable?.has(key(s.col, s.row))) continue;
    // AND NOT ONE THE MOVER CANNOT GET TO AT ALL. The measured case is a shelter offered in
    // a disconnected component while a real wall sat one square from the character.
    if (canWalkThere && !canWalkThere.has(`${s.row},${s.col}`)) { unreachableToUs++; continue; }
    // NOR ONE WE COULD NOT COME BACK FROM. Now that distance is the whole ranking, the
    // nearest wall is sometimes over a one-way drop — the mover walks a character off a
    // ledge it cannot climb, the character rests, and the journey that diverted has no
    // route onward. Getting there was never the hard half of a rest stop.
    const returnsToUs = !canComeBack || canComeBack.has(`${s.row},${s.col}`);
    const towardExit = !!reachesOnward?.has(`${s.row},${s.col}`);
    if (!returnsToUs && !towardExit) { oneWay++; continue; }
    if (towardExit) reachesOnwardCount++;
    // CHEAP TESTS FIRST. Distance and the defensibility cutoff are arithmetic on two
    // integers; quarryReach and reach are pathfinds. With the candidate list no longer
    // capped this ordering is the difference between one pass over the room and a
    // pathfind per square in it — the far corners of a 58x44 room were being routed to
    // and then discarded for being out of range.
    const d = Math.max(Math.abs(s.col - from.col), Math.abs(s.row - from.row));
    if (distanceMatters && d > within) continue;
    // A proven square is allowed to be less defensible on paper than the cutoff: it
    // has passed the only test that counts.
    //
    // 'wall' asks only for a wall to stand against, which is a far wider net: room 544
    // goes from 113 candidates to about 1300. That is the point — the disc rule was
    // rejecting most of the room on a number that does not predict holding, and a wider
    // net with an honest ranking beats a narrow one built on a trough.
    // MEMBERSHIP IS THE DEFINITION — see safeWalls. `rule`, `minAvoided` and
    // `minBackCover` used to gate here and are still accepted so callers need not change;
    // they no longer remove a wall the picture shows. Corrected 2026-08-27.
    void rule; void minAvoided; void minBackCover;
    // `retest` keeps a REINSTATED square eligible without making it trusted. A square
    // put back by m59-safespot-retest.mjs has had its held count zeroed — it is being
    // asked to prove itself again from nothing — and zeroing it would otherwise drop any
    // square that qualified only BECAUSE it had held, so the reassessment could never
    // happen. It grants no proof bonus below, and it does not survive discredited()
    // above: fail again and the square is out for good, exactly as before.
    eligible++;

    // THE MONSTER GRID IS A PRIOR, NOT A VERDICT.
    //
    // This used to `continue` on one coarse-grid miss. That made a stale quarry position,
    // an imperfect .roo movement mask, or a server setting we had inferred incorrectly
    // sufficient to declare every wall in the room a clifftop — before a character had
    // stood on even one of them. The live observation is cheaper and stronger: take the
    // best predicted-reachable wall first, but if none exists take the best predicted-
    // unreachable wall and actually try to pull the quarry there. There is no empirical veto
    // any more: `barrenSpots` used to be one, and it was removed on 2026-08-27 because there
    // is no such thing as a safe wall that does not work — see Autopilot.pullDidNotConvert.
    let predictedUnreachable = false;
    let quarryPrediction = null;
    if (quarryReach) {
      quarryPrediction = quarryReach(s.col, s.row);
      if (quarryPrediction?.reachable === false) {
        predictedUnreachable = true;
        unreachableByQuarry++;
      } else if (quarryPrediction?.reachable === true) {
        reachableByQuarry++;
      }
    }
    // Some rooms contain player-operated doors whose two sides share a room number.
    // The coarse movement grid is the server's monster graph there, not merely a prior:
    // a monster cannot operate the door, so offering a wall in another component creates
    // a pull that can never convert. Keep the ordinary loose, test-it-live rule everywhere
    // else; only callers that know the room has player-only internal portals opt in.
    if (strictQuarryReach && predictedUnreachable) {
      partitionRejected++;
      continue;
    }
    const p = reach ? reach(s.col, s.row) : { reachable: true, steps: d };
    if (!p?.reachable) {
      unreachableToUs++;
      continue;
    }
    // Prefer defensibility, then closeness. A spot two squares further away that
    // halves the number of attackers is worth the two squares. Proof is worth more
    // than either — a square that has held under attack beats any amount of
    // promising-looking wall.
    // A marked square outranks any amount of promising-looking wall, and outranks a
    // square that merely held — holding is our own measurement, marking is somebody's
    // judgement made from inside the game.
    // `proof` — 60 points for a marked square, up to 30 for one that had held — used to be
    // added to the ranking. It is gone with the rest of it: a wall that held is not a
    // better wall, it is a wall that was stood on, and grading them is the thing being
    // removed here. The book still discredits squares outright above, which is a fact
    // about a square rather than a grade.
    void seen;
    // Distance from the fight is a TIE-BREAK, not a filter.
    //
    // This was 1.2 a square, which is heavier than it sounds: at that weight a wall
    // eight squares further from the quarry loses to open floor beside it, and the
    // quarryReach prediction above already supplies the primary partition. Any spot in
    // its predicted-reachable partition is good enough; if that partition is empty, the
    // best doubtful one is tested live instead of being forbidden by the map.
    const fromFight = toward ? Math.max(Math.abs(s.col - toward.col), Math.abs(s.row - toward.row)) : 0;
    const targetDistance = toward ? Math.hypot(s.col - toward.col, s.row - toward.row) : 0;
    // THE NEAREST ONE. See safeSpots: every square that qualifies is the same kind of
    // thing, so distance is the whole of the ranking and `value` is just its negation.
    //
    // What used to be here was `defensibility + proof - steps * 0.5 - fromFight * 0.3`,
    // where defensibility was a composite of back cover and a disc score and proof was
    // worth up to 90 points. Against that, half a point per square meant distance could
    // not win: a wall 30 squares away with 20 points of back cover beat a plain edge two
    // squares away, every time, and the character walked it while bleeding.
    // Progress is measured to the EXIT, in squares, and weighted by the bias; the walk's
    // own length still counts against a wall, so between two walls equally far forward
    // the nearer one wins, as it always did.
    const progress = onwardSquare ? hereToExit - cheb(s, onwardSquare) : 0;
    const value = -(p.steps ?? d);
    // ...AND NOTHING ELSE, UNLESS A JOURNEY NAMES ITS EXIT. The distance-only ranking above
    // is pinned by m59-safespot-test because a composite score once sent hurt characters
    // across rooms; the one adjustment allowed is progress toward a named exit, and it is
    // gated on `onwardSquare` so a fight or a rest still ranks on distance alone.
    const ranked = onwardSquare && towardExit ? value + forwardBias * progress : value;
    const candidate = {
      ...s, steps_away: p.steps ?? d, value: ranked, from_fight: toward ? fromFight : null,
      progress: onwardSquare ? progress : null,
      target_distance: toward ? targetDistance : null,
      quarry_steps: quarryPrediction?.reachable && Number.isFinite(quarryPrediction.steps)
        ? quarryPrediction.steps : null,
      quarry_attack_position: quarryPrediction?.reachable
        ? quarryPrediction.attack_position ?? null : null,
      // This is an invitation to TEST the prediction, not a statement that the square
      // works. The empirical pull detector is the authority after arrival.
      predicted_unreachable_by_quarry: predictedUnreachable || undefined,
      quarry_prediction: predictedUnreachable ? quarryPrediction : undefined,
      // PROVEN MEANS IT IS A WALL. It used to mean "held before and never failed", which
      // made a brand-new geometric wall read as unproven and a square with one unlucky
      // afternoon read as disproved for ever. There is one kind of safe wall now and the
      // geometry above has already established this is one, so anything asking "can I
      // trust this" gets the same answer the selection just gave itself.
      proven: true, held_before: seen?.held ?? 0,
      // The fine coordinate is what we actually want to stand on; see SafeSpotBook.
      // The square is only how we get there.
      fine: seen?.x != null ? { x: seen.x, y: seen.y } : null,
    };
    if (predictedUnreachable) {
      if (preferSafeSpotCandidate(candidate, bestPredictedUnreachable, { closestToToward }))
        bestPredictedUnreachable = candidate;
    } else if (preferSafeSpotCandidate(candidate, best, { closestToToward })) {
      best = candidate;
    }
  }
  // A reachable prediction always wins. The fallback is deliberately visible in the
  // returned record so the keeper can say it is testing a doubtful map rather than
  // presenting the map's guess as a fact.
  best ??= bestPredictedUnreachable;
  // Keep the map prediction and the live verdict separate in the diagnostics. A doubtful
  // square is not dropped merely for being doubtful — it is offered, and tried.
  // THE EXIT IS A WALL. Operator, 2026-09-01: crossing a room boundary breaks every attack
  // on you, which is the property a safe wall is chosen for; what it lacks is a place to
  // heal, and the first wall in the next room supplies that. So on a journey the onward
  // exit joins the candidates on the same terms as a wall — reachable from here, ranked by
  // its walk and by progress, of which it has the most — and `kind: 'exit'` tells the taker
  // to cross rather than to stand. It never joins a fight's or a rest's search: no onward,
  // no exit. `allowExit: false` withholds it, which is what the search on the far side of a
  // crossing uses so a retreat cannot chain room to room.
  if (onwardSquare && allowExit) {
    const exitKey = `${onwardSquare.row},${onwardSquare.col}`;
    if (!canWalkThere || canWalkThere.has(exitKey)) {
      const d = cheb(from, onwardSquare);
      const p = reach ? reach(onwardSquare.col, onwardSquare.row) : { reachable: true, steps: d };
      if (p?.reachable !== false) {
        exitConsidered = true;
        const exitCandidate = {
          row: onwardSquare.row, col: onwardSquare.col, kind: 'exit',
          steps_away: p.steps ?? d, value: -(p.steps ?? d) + forwardBias * hereToExit,
          progress: hereToExit, from_fight: null, target_distance: null,
          quarry_steps: null, quarry_attack_position: null,
          proven: false, held_before: 0, fine: null,
        };
        if (preferSafeSpotCandidate(exitCandidate, best, { closestToToward })) best = exitCandidate;
      }
    }
  }
  if (stats) {
    stats.considered = all.length;
    stats.eligible = eligible;
    stats.exit_considered = exitConsidered;
    stats.walls_withheld = !wallsAllowed;
    // Reported rather than silent: "there were walls but every one of them was a one-way
    // trip" is a different room from "there were no walls", and a keeper that cannot tell
    // them apart writes the wrong thing in the ledger.
    stats.one_way = oneWay;
    stats.reaches_onward = reachesOnwardCount;
    stats.unreachable_by_quarry = unreachableByQuarry;
    stats.reachable_by_quarry = reachableByQuarry;
    stats.unreachable_to_us = unreachableToUs;
    stats.partition_rejected = partitionRejected;
    stats.used_predicted_unreachable = !!best?.predicted_unreachable_by_quarry;
  }
  if (best && unreachableByQuarry) best.rejected_unreachable_by_quarry = unreachableByQuarry;
  return best;
}

export function geometryFor(mapRoom) {
  return mapRoom?.roo ? RoomGeometry.fromJSON(mapRoom.roo) : null;
}

// ---------------------------------------------------------------- the book
//
// Persistent square keys use the public, 1-based "col,row" order.

const key = (col, row) => `${col},${row}`;

// WHAT ACTUALLY WORKED, WRITTEN DOWN.
//
// Everything above this line is inference from a one-byte-per-square movement grid,
// and the real mechanic is not in that grid. So the grid proposes and experience
// disposes: stand somewhere, be attacked, and see whether anything lands. That test
// is cheap, it is unambiguous, and until it is run the answer is genuinely unknown.
//
// Two things make it worth persisting rather than keeping in a process:
//
//   * a proven square is durable. Walls do not move, so a spot that held last week
//     holds today, and a character arriving in a room it has never seen can inherit
//     what another character learned there.
//   * a DISPROVED square is worth more than a proven one, because the geometry will
//     keep recommending it. The top-scoring square in a room can be one where the
//     BSP walls do not line up with the grid at all, and without a memory the keeper
//     walks back to it every time it wants to feel safe.
//
// The unit of memory is the FINE coordinate, not the square. moveToSquare puts you
// at the square's centre (col*64+32); a spot that works by hugging a wall may be
// forty fine units off that centre, and a square-move to "the same place" quietly
// lands you somewhere else. So the book records where we were standing to the fine
// unit and hands that back.
export class SafeSpotBook {
  constructor(file = null) {
    this.file = file;
    this.rooms = new Map();          // room number -> Map(key -> record)
    this.dirty = false;
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [num, spots] of Object.entries(raw.rooms || {}))
        this.rooms.set(Number(num), new Map(Object.entries(spots)));
    } catch { /* no book yet, or unreadable — start empty rather than fail */ }
  }

  save() {
    if (!this.file || !this.dirty) return false;
    const rooms = {};
    for (const [num, spots] of this.rooms) rooms[num] = Object.fromEntries(spots);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ rooms }));
      this.dirty = false;
      return true;
    } catch { return false; }   // a read-only substrate must not break a fight
  }

  recall(room) { return this.rooms.get(Number(room)) || null; }

  get(room, col, row) { return this.recall(room)?.get(key(col, row)) || null; }

  // ONE FAILURE IS ENOUGH. A spot that has ever let something through is out, for good,
  // however many times it held first.
  //
  // The old rule wanted two failures AND more failures than holds, on the reasoning that
  // poison or a stray archer can look like a spot that does not work and a good corner
  // is expensive to throw away. That has the cost backwards. Godfrey stood on a square
  // recorded held:1 — "proven" — and died there: it had been tested against two
  // attackers and met six, and went 24/24 to 9/24 in a single pass. Under the old rule
  // that square stayed proven and stayed recommended, to him and to everyone who
  // inherited the book.
  //
  // The asymmetry is the point. Being wrong about a bad spot costs a character; being
  // wrong about a good one costs a walk to the next corner. Spots seem safe at first and
  // turn out not to be — a crowd big enough simply reaches around the wall — and the
  // number of squares in a room is large. So a failure is permanent and there is no
  // route back into the recommendations.
  // A HUMAN STOOD HERE AND SAYS IT WORKS.
  //
  // Ground truth, and it outranks everything this file infers. The model reasons from a
  // one-byte-per-square grid and a transcription of the server's reach test; a person
  // playing the character sees the actual geometry and, more to the point, has fought
  // from the square. Every automatic judgement in this book has been wrong at least once
  // — the reach model condemned 560 squares it should not have, including all 132 in the
  // Valley of Ileria — and a marked square is the one kind of record that was not
  // produced by a model that might be wrong.
  //
  // Failures are still COUNTED on a verified square, because a human can be wrong too
  // and the record should say so. They just do not retire it: unmarking is a human's job.
  verify(room, { col, row, by = null, note = null }) {
    const rec = this.touch(room, col, row);
    rec.verified = true;
    rec.verified_by = by;
    rec.verified_at = Date.now();
    if (note) rec.verified_note = note;
    this.dirty = true;
    return rec;
  }

  unverify(room, { col, row }) {
    const rec = this.touch(room, col, row);
    delete rec.verified; delete rec.verified_by; delete rec.verified_at; delete rec.verified_note;
    this.dirty = true;
    return rec;
  }

  // WHAT JUDGED THIS SQUARE. A failure is permanent and that stays true however it was
  // found — a square that let a blow through is a bad square whether the character was
  // fighting from it or resting at it part-way through a journey, and the conservative
  // direction is the cheap one: being wrong about a bad square costs a character, being
  // wrong about a good one costs a walk to the next corner.
  //
  // But the two are not the same evidence. A travel hold is taken in a room nobody chose,
  // with whatever followed you through the door, on a wall derived from geometry that has
  // never been stood on. So the provenance is written down: `failed_via` is the most recent
  // judge and `failed_by` counts them, which is enough to fish the travel-only rejections
  // back out later without having to reconstruct anything.
  // GEOMETRY OUTRANKS THE LEDGER, AND A FAILURE IS ABOUT THE FIGHT RATHER THAN THE WALL.
  //
  // The comment above is the reasoning from when this book existed to DISCOVER what a safe
  // wall is. That question is settled: a safe wall is a square where nothing can stand
  // within melee reach — `can_reach_you === 0`, off the .roo, against the server's own
  // reach test (SquaredDistanceTo <= range^2, range 2-3, monster.kod:1682). Once geometry
  // can answer, a failure row cannot overrule it, because a failure records only that
  // something went wrong WHILE WE STOOD THERE. A crowd on the square, a swing we took
  // first, an archer, a poison tick, a blow resolved before we arrived — none of those are
  // facts about the wall, and none of them make an unreachable square reachable.
  //
  // What that mistake cost, measured on prod 2026-09-02: room 39 had 185 squares with
  // can_reach_you === 0 and 142 of them were discredited, including r3c17 with 431
  // failures and r3c27 with 410 — squares nothing can physically reach, recorded as having
  // failed hundreds of times. Nearly all of it accrued while max_bots_per_safe_spot was 21
  // and the whole fleet was entitled to one square, which is a crowd standing on the wall
  // rather than a wall that leaks. With the south row believed again, fleet kills went from
  // 20 per 30 minutes to 48 and deaths from about 4 an hour to 0.6.
  //
  // SO THERE ARE TWO VERDICTS, AND ONLY ONE OF THEM IS PERMANENT.
  //
  //   * as a place to HEAL — to stop swinging, sit, and let the room mill about outside
  //     reach — a square is condemned only by geometry. This is the one that must never be
  //     revoked by a failure: it is the whole mechanism by which a losing fight becomes a
  //     draw, and taking it away is what leaves a character dying in the open.
  //   * as a place to FIGHT FROM against a particular area, a failure is still decisive.
  //     `discreditedForPull` keeps the old strict rule, unchanged and still permanent,
  //     because "I could not hold this while swinging at that" is a real observation about
  //     the pull even when the wall is sound.
  //
  // `reachable` is the geometric verdict when the caller has it and null when it does not.
  // Absent it, the old behaviour stands — this must not quietly believe squares nobody has
  // any evidence about.
  discredited(rec, { reachable = null } = {}) {
    // THERE IS ONLY ONE KIND OF SAFE WALL, AND GEOMETRY DECIDES IT. Operator, 2026-09-06.
    //
    // This used to be an experiential verdict with a geometric override bolted on. The
    // override kept winning, which was the clue: room 39 had 142 squares nothing could
    // physically reach recorded as having FAILED, one of them 431 times. Believing the
    // geometry again took fleet kills from 20 per 30 minutes to 48 and deaths from about
    // four an hour to 0.6. Square 24,7 in that room carries 309 failures, all of them
    // `failed_via: "fight"`, on a square an operator had verified by hand.
    //
    // A failure row never recorded a fact about the WALL. It recorded that something went
    // wrong while we stood there — a crowd on the square, a blow resolved before we
    // arrived, an archer, a poison tick, another character's swing. None of those make an
    // unreachable square reachable, and all of them are things the wall was never going
    // to stop. So the ledger was measuring the afternoon, not the geometry, and then
    // condemning the geometry for it. PERMANENTLY: one bad tick burned a good wall for
    // the life of the fleet.
    //
    // So the answer is unconditional now. What makes a square a safe wall is that nothing
    // can reach it, and that is a property of the .roo and the melee disc — a calculation,
    // repeatable, with no history in it. Nothing that happens while a character stands
    // there can change whether a monster can reach the square.
    //
    // The ledger is kept loadable so old files still parse and the boards still render,
    // and it is no longer consulted by anything that decides.
    return false;
  }

  // The strict, permanent rule, for choosing somewhere to fight FROM. Unchanged: being
  // wrong about a bad pull spot costs a character and being wrong about a good one costs
  // a walk to the next corner, and that asymmetry still holds for the fighting question.
  discreditedForPull(rec) {
    // AND THE FIGHTING QUESTION IS THE SAME QUESTION. This kept the old strict rule on the
    // argument that "I could not hold this while swinging at that" is a real observation
    // about the pull even when the wall is sound. It is not a separate law, and the
    // operator's reason is the one that settles it:
    //
    //   A safe spot is the only place THE LOGOFF TRICK WORKS. You log off so the monster
    //   disengages and you do not die; you reconnect, turn so the server registers the
    //   move, and heal to full before re-engaging. That only works somewhere nothing can
    //   reach you — which is the geometric test and nothing else.
    //
    // So "somewhere to fight from" is not a second property a square earns by surviving
    // fights. It is the FIRST property, used for a second purpose: a wall you can pull to
    // is a wall you can log off at, and both are `can_reach_you === 0`. A square that
    // "failed a pull" failed because a fight went badly on it, which is what fights do.
    return false;
  }

  // NOTHING DECIDES ON THESE ANY MORE — see `discredited`. They still record, because a
  // read-only history is worth having for the boards and for asking after the fact whether
  // the geometry was right; what they may never do again is gate a shelter.
  //
  // If this branch's A/B holds, the next step is deleting the writes as well: a ledger
  // nobody reads is a file that will eventually be believed by somebody.
  held(room, { col, row, x = null, y = null, seconds = 0, attackers = 0, source = null }) {
    const rec = this.touch(room, col, row);
    rec.held++;
    if (source) mark(rec, 'held', source);
    rec.held_seconds = (rec.held_seconds || 0) + Math.round(seconds);
    rec.most_attackers = Math.max(rec.most_attackers || 0, attackers);
    if (x != null) { rec.x = x; rec.y = y; }     // the exact place that worked
    rec.at = Date.now();
    this.dirty = true;
    return rec;
  }

  // We stood here under attack and were hit anyway. The spot does not work, or does
  // not work from the angle we were standing at.
  failed(room, { col, row, damage = 0, attackers = 0, settledMs = null, source = null }) {
    const rec = this.touch(room, col, row);
    rec.failed++;
    if (source) mark(rec, 'failed', source);
    rec.damage_taken = (rec.damage_taken || 0) + damage;
    rec.most_attackers = Math.max(rec.most_attackers || 0, attackers);
    // HOW SETTLED WE WERE WHEN THE WINDOW THAT CONDEMNED THIS SQUARE OPENED.
    //
    // A failure is permanent, so the one way this book can be quietly wrong is by
    // blaming a square for a blow that was resolved before we reached it and only
    // arrived afterwards. SETTLE_GRACE_MS in m59-autopilot.mjs is what stops that, and
    // this is the evidence for whether it is wide enough: the tightest margin any real
    // failure was recorded at. If that number sits just above the grace, the grace is
    // too narrow and squares are still being retired by packet timing.
    if (settledMs != null && Number.isFinite(settledMs)) {
      rec.settled_ms = Math.max(0, Math.round(settledMs));
      rec.min_settled_ms = Math.min(rec.min_settled_ms ?? Infinity, rec.settled_ms);
    }
    rec.at = Date.now();
    this.dirty = true;
    return rec;
  }

  touch(room, col, row) {
    const num = Number(room);
    if (!this.rooms.has(num)) this.rooms.set(num, new Map());
    const spots = this.rooms.get(num);
    const k = key(col, row);
    if (!spots.has(k)) spots.set(k, { col, row, held: 0, failed: 0 });
    return spots.get(k);
  }

  // Everything known about a room, best first, for reporting.
  list(room) {
    const spots = this.recall(room);
    if (!spots) return [];
    return [...spots.values()]
      // THE VERDICT IS A HISTORY NOW, NOT A JUDGEMENT. `does not work` is gone with the
      // concept: geometry decides whether a square is a wall, and this list is a record of
      // what happened on squares that were already walls. `stood_on` and `never_stood_on`
      // say what the rows actually contain without implying a square is disqualified.
      .map(r => ({ ...r, verdict: r.held > 0 ? 'stood_on'
                                : r.failed > 0 ? 'stood_on' : 'never_stood_on' }))
      .sort((a, b) => (a.failed - b.failed) || (b.held - a.held));
  }
}

// Provenance for one outcome — the most recent judge, and a count per judge. Kept tiny and
// additive so an old book without it reads exactly as it always did.
function mark(rec, kind, source) {
  rec[`${kind}_via`] = source;
  const by = rec[`${kind}_by`] ?? {};
  by[source] = (by[source] || 0) + 1;
  rec[`${kind}_by`] = by;
}

let theBook = null;
export function safeSpotBook(file = null) {
  if (!theBook) theBook = new SafeSpotBook(file);
  return theBook;
}

// PUTTING BACK A SQUARE THAT WAS RETIRED BY A PACKET RATHER THAN BY A WALL.
//
// These two live here, next to discredited(), rather than in m59-safespot-retest.mjs
// where they are used: that file is a script with no entry-point guard, so importing it
// to test the rule would run it against the real book. The rule is the part worth
// pinning, so the rule lives with the data it describes.
//
// The subset is narrow on purpose. A square that HELD and was then retired on at most a
// point of damage is the shape a single late packet makes — see SETTLE_GRACE_MS in
// m59-autopilot.mjs, which did not exist when these were judged. A square that lost six
// is one something genuinely reached, and stays out.
export function selectForRetest(rooms, { maxDamage = 1 } = {}) {
  const picked = [];
  for (const [room, spots] of Object.entries(rooms || {})) {
    for (const [k, r] of Object.entries(spots || {})) {
      // A mark already outranks our arithmetic, so a verified square is not discredited
      // and needs no rescuing. Zeroing a person's held record to fix a problem they do
      // not have would be a loss rather than a repair.
      if (r.verified) continue;
      if (!((r.held || 0) > 0)) continue;
      if (!((r.failed || 0) > 0)) continue;
      if ((r.damage_taken || 0) > maxDamage) continue;
      picked.push({ room: Number(room), key: k, rec: r });
    }
  }
  return picked;
}

// UNTESTED, NOT TRUSTED, AND THAT DISTINCTION IS THE WHOLE POINT.
//
// The pardon in m59-safespot-retest.mjs clears `failed` and keeps `held`, on the sound
// reasoning that holding is holding wherever you stood. Applied here that would be
// exactly wrong: takeSafeSpot inherits `proven` from a clean held record, so the keeper
// would go and REST on these squares — trusting a judgement we have just decided was
// unreliable, without ever re-testing it. So `held` goes too, and the square has to earn
// its twelve quiet seconds again from nothing.
// `from` is the record the DECISION was made against, which is not always the record
// being rewritten. The failures that identify this subset were cleared out of the live
// book by the pardon in m59-safespot-retest.mjs before this ran, so the selection has to
// be made against an older snapshot — and the history worth keeping is that snapshot's,
// not the pardoned record's zeroes. Defaults to the record itself, which is the ordinary
// case.
export function reinstateUntested(rec, { why = 'retired before SETTLE_GRACE_MS existed',
                                         from = rec } = {}) {
  const out = { ...rec, held: 0, failed: 0 };
  delete out.damage_taken;
  delete out.held_seconds;
  // Keeps it eligible where the geometry cutoff alone would not offer it — see the gate
  // in nearestSafeSpot. Grants no proof bonus, and does not survive a fresh failure.
  out.retest = true;
  out.retest_at = Date.now();
  out.retest_why = why;
  out.retest_from = {
    held: from.held || 0, failed: from.failed || 0,
    damage_taken: from.damage_taken || 0,
    held_seconds: from.held_seconds || 0,
    most_attackers: from.most_attackers || 0,
    at: from.at ?? null,
  };
  return out;
}
