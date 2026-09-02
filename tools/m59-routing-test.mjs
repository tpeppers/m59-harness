#!/usr/bin/env node
// THE CONTRACT TEST FOR PLANNING ON THE MAP THE MOVER ENFORCES.
//
//   node tools/m59-routing-test.mjs
//
// Movement is validated against the CLIENT's BSP; the router planned on the SERVER's
// coarse one-byte-a-square grid. Those disagree, and a router planning on a different map
// from the one the mover enforces does not produce a wrong route — it produces a character
// sliding along a wall, replanning into the same wall, and giving up. Measured offline
// against the twelve boundaries the exit-gap record complains about most, that killed 59%
// of all walks to an exit, and on prod it killed characters: several died in the Western
// border of the Twisted Wood with spiders on them while bouncing between two squares.
//
// WHAT IS PINNED HERE, AND WHY EACH ONE FAILS IN THE DANGEROUS DIRECTION IF INVERTED:
//
//   * `moverStepLands` is the MOVER's question, not `stepAllowedByCollision`'s. The second
//     asks whether a straight line between two square CENTRES arrives with no sliding —
//     which the player, a disc of radius 248 in a square of 1024, frequently cannot do
//     next to a wall. Measured, that predicate breaks room 150 into 159 pieces and room
//     578 into 214; the mover's own gives 15 and 2. Reverting to the strict one does not
//     look like a bug, it looks like a world full of walls.
//
//   * A step mask round-trips bit for bit. A mask read against a different direction
//     order is a confident map of the WRONG doors and nothing downstream could notice.
//
//   * With no mask attached, `path` plans exactly as it did before any of this existed.
//     That is what makes the change safe for a checkout that has never run the bake.
//
//   * `blockedEdges` removes an EDGE and not a SQUARE. A wall sits between two squares;
//     blaming the square removes a perfectly good place to stand that other neighbours
//     still reach, and that was the old behaviour.
//
//   * The bake's regions are STRONGLY CONNECTED COMPONENTS, and the tiny ones against the
//     walls are kept. They are not noise — they are the safe-spot signal, the same
//     geometric fact `substrate/m59-safespots.json` measures from the other side. A pass
//     that smoothed them away to make the count look tidy would throw that away.
//
//   * An exit anchor is chosen from a staging square the room's body can REACH, not the
//     first one the boundary happens to publish. Room 578 came out with all four exits
//     "unreachable" purely because the first square on each list was one the mover cannot
//     get to and the other ten were never considered.
//
// OFFLINE AND FIXTURE-FIRST. The geometry-backed half runs only when a baked map is
// present and reports itself skipped otherwise, because a suite that silently tests
// nothing is worse than one that says it did.

import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RoomGeometry, protocolToward, STEP_MASK_DIRS, KOD_FINENESS, CLIENT_FINENESS,
         sharedRoomGeometry, STEP_MASK_VERSION, elideLoops } from './m59-roo.mjs';
import { bakeRoom, components, compositionRisk, exitAnchors, replay } from './m59-routebake.mjs';
import { loadMap, selectedEdgeAt, findPath } from './m59-map.mjs';
import { World } from './m59-world.mjs';
import { crossingBook, WALKS_DIR } from './m59-crossings.mjs';
import { attachStepMasks, bakedPath, stepMaskCurrent } from './m59-routes.mjs';

// WHERE THE MAP IS, RESOLVED FROM THIS FILE AND NOT FROM THE SHELL'S CURRENT DIRECTORY.
//
// This was `existsSync(join('substrate', 'm59-map.json'))` -- a RELATIVE path -- while
// `loadMap()` beside it resolves absolutely. So the collision-backed blocks ran from the
// repo root and SILENTLY SKIPPED from anywhere else: 131 passed / 0 skipped here, 110
// passed / 5 skipped with the identical absolute test path run from one directory up.
//
// That is 21 assertions that vanish without a word, and they are not arbitrary ones -- the
// room 27 fixture is precisely the one that catches a stale routing table (with masks
// refused it starts FINDING a route it is supposed to refuse). A worktree or CI runner that
// does not cd into the repo first gets a green suite that never asked the question, and
// reports it as a baseline.
const MAP_ON_DISK = fileURLToPath(new URL('../substrate/m59-map.json', import.meta.url));

let passed = 0, failed = 0, skipped = 0;
function ok(what, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${what}`); }
  else { failed++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
}
function skip(what, why) { skipped++; console.log(`  --   ${what} — ${why}`); }

// ---------------------------------------------------------------- the quantizer
// One home, two callers: Session.validateFineTarget decides what to SEND and
// moverStepLands decides what to PLAN. Two answers here is a router planning steps the
// mover will not make, which is the entire bug.
console.log('\nprotocolToward — one answer for "which integer square is this"');
{
  const scale = CLIENT_FINENESS / KOD_FINENESS;
  // The broker's inline arithmetic, spelled out, so a drift between them is a failure here
  // rather than a fleet walking into walls.
  const broker = (value, fromValue) => {
    const wire = value / scale + KOD_FINENESS;
    if (value > fromValue) return Math.floor(wire + 1e-9);
    if (value < fromValue) return Math.ceil(wire - 1e-9);
    return Math.round(wire);
  };
  let agree = true;
  for (let from = -2048; from <= 2048; from += 97)
    for (let v = -2048; v <= 2048; v += 31)
      if (protocolToward(v, from) !== broker(v, from)) agree = false;
  ok('it agrees with the arithmetic inside validateFineTarget everywhere', agree);
  ok('it rounds back toward the start when moving forward',
     protocolToward(1000, 0) <= 1000 / scale + KOD_FINENESS);
  ok('it rounds back toward the start when moving backward',
     protocolToward(-1000, 0) >= -1000 / scale + KOD_FINENESS);
  ok('a zero-length move is nearest-rounded rather than biased',
     protocolToward(512, 512) === Math.round(512 / scale + KOD_FINENESS));
}

// ---------------------------------------------------------------- the mask, on a fixture
console.log('\nthe step mask — bit order, round trip, and what an absent one means');
{
  // A tiny room with no collision payload at all. `moverStepLands` must answer "no
  // opinion" there rather than "refused": a room whose collision could not be baked still
  // has a usable coarse grid and must not become unroutable because of this.
  const bare = RoomGeometry.fromJSON({
    rows: 3, cols: 3,
    flags: [1, 1, 1, 1, 1, 1, 1, 1, 1],
    grid: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    moveGrid: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  });
  ok('a room with no collision payload is not collisionReady', !bare.collisionReady);
  ok('and it therefore has no opinion about a step rather than refusing one',
     bare.moverStepLands(2, 2, 1, 1) === true);
  ok('it reports no step mask', bare.hasStepMask === false);
  ok('and `path` therefore defaults to the coarse grid, exactly as before',
     bare.path(1, 1, 3, 3).found === true);

  // Bit order is the one thing a mask cannot survive getting wrong, because nothing
  // downstream can detect it. Pin the order itself, and the round trip through base64.
  ok('the mask has exactly eight directions', STEP_MASK_DIRS.length === 8);
  ok('and they are the DIR table in its own order, so there is one table and not two',
     STEP_MASK_DIRS.map(d => d.name).join(',') ===
     'north,northeast,east,southeast,south,southwest,west,northwest');

  const made = new Uint8Array(bare.rows * bare.cols);
  for (let i = 0; i < made.length; i++) made[i] = (i * 37) & 0xff;
  const b64 = Buffer.from(made).toString('base64');
  const back = new Uint8Array(Buffer.from(b64, 'base64'));
  ok('a mask survives base64 byte for byte',
     back.length === made.length && made.every((v, i) => back[i] === v));
  ok('a mask of the right size is accepted', bare.attachStepMask(back) === true);
  ok('and the geometry then says so', bare.hasStepMask === true);
  ok('a mask of the WRONG size is refused rather than mis-indexed',
     bare.attachStepMask(new Uint8Array(made.length + 1)) === false);
  ok('and refusing one leaves the geometry with none rather than a bad one',
     bare.hasStepMask === false);
  ok('a non-mask is refused', bare.attachStepMask([1, 2, 3]) === false);
}

// ---------------------------------------------------------------- blockedEdges
console.log('\nblockedEdges — a wall is between two squares, not on one of them');
{
  // Three squares in a row, all mutually adjacent through the grid. Blocking the edge
  // 2,2 -> 2,3 must not make 2,3 unreachable: 1,3 still reaches it.
  const flags = new Array(9).fill(1);
  const open = new Array(9).fill(0xff);
  const g = RoomGeometry.fromJSON({ rows: 3, cols: 3, flags, grid: open, moveGrid: open });
  const edge = new Set(['2,2>2,3']);
  ok('the blocked edge is gone from that square\'s neighbours',
     !g.neighbors(2, 2, { blockedEdges: edge }).some(n => n.row === 2 && n.col === 3));
  ok('but the square is still reachable from elsewhere — an edge is not a square',
     g.neighbors(1, 3, { blockedEdges: edge }).some(n => n.row === 2 && n.col === 3));
  ok('and the reverse edge is untouched, because refusals really are one-way',
     g.neighbors(2, 3, { blockedEdges: edge }).some(n => n.row === 2 && n.col === 2));
  const around = g.path(2, 2, 2, 3, { blockedEdges: edge });
  ok('a route to it still exists, going round', around.found === true);
  ok('and it is longer than the single step it replaced', (around.steps?.length ?? 0) > 1);

  const walled = new Set();
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++)
    if (!(r === 2 && c === 3)) walled.add(`${r},${c}>2,3`);
  const none = g.path(1, 1, 2, 3, { blockedEdges: walled });
  ok('when every way in is refused, the answer is no route', none.found === false);
  ok('and it says WHICH view refused, so a caller can fall back to the grid',
     none.blocked_edges === walled.size &&
     /mover/.test(none.reason ?? ''), JSON.stringify(none));
  ok('while the same search with no refusals still finds the step',
     g.path(1, 1, 2, 3).found === true);
}

// ---------------------------------------------------------------- against the real map
console.log('\nagainst the baked world map');
const { movementMapFile } = await import('./m59-map-path.mjs');
const mapFile = movementMapFile();
if (!existsSync(mapFile)) {
  skip('the mover view keeps a room in one piece', 'no baked map on this machine');
  skip('a baked mask agrees with the live predicate', 'ditto');
  skip('exit anchors prefer a staging square the body can reach', 'ditto');
} else {
  const { loadMap } = await import('./m59-map.mjs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const map = loadMap(mapFile);
  const room = map.rooms[578] ?? map.rooms['578'];      // the Cragged Mountains
  const geo = room?.roo ? sharedRoomGeometry(room) : null;
  if (!geo?.collisionReady) {
    skip('the mover view keeps a room in one piece', 'room 578 has no collision geometry');
    skip('a baked mask agrees with the live predicate', 'ditto');
    skip('exit anchors prefer a staging square the body can reach', 'ditto');
  } else {
    // THE MEASUREMENT THAT TURNED THE ROUTER BACK ON. Under the strict centre-to-centre
    // predicate this room is 214 pieces; under the mover's own it is a room.
    let strictRefused = 0, moverRefused = 0, pairs = 0;
    for (let r = 1; r <= geo.rows; r++) for (let c = 1; c <= geo.cols; c++) {
      if (!geo.walkable(r, c)) continue;
      for (const n of geo.neighbors(r, c)) {
        pairs++;
        if (!geo.stepAllowedByCollision(r, c, n.row, n.col)) strictRefused++;
        if (!geo.moverStepLands(r, c, n.row, n.col)) moverRefused++;
      }
    }
    ok('the mover refuses strictly fewer adjacent pairs than the centre-to-centre test',
       moverRefused < strictRefused, `mover ${moverRefused}, strict ${strictRefused}, of ${pairs}`);
    // MEASURED OVER THE POPULATION THE CLAIM IS ABOUT. `neighbors` now offers `standable`
    // squares, so this denominator gained every fringe square the BSP knows and the coarse
    // grid wrote off — squares that are real ground with very few legal steps off them.
    // Counting those made the rate jump 5% -> 10.8% without the mover having become one
    // bit stricter about anything it was already asked. So the small-minority claim is
    // asserted where it was always meant: between squares the coarse grid itself accepts.
    let gridPairs = 0, gridRefused = 0;
    for (let r = 1; r <= geo.rows; r++) for (let c = 1; c <= geo.cols; c++) {
      if (!geo.walkable(r, c)) continue;
      for (const n of geo.neighbors(r, c)) {
        if (!geo.walkable(n.row, n.col)) continue;
        gridPairs++;
        if (!geo.moverStepLands(r, c, n.row, n.col)) gridRefused++;
      }
    }
    ok('and between squares the coarse grid accepts it refuses only a small minority',
       gridRefused / gridPairs < 0.05,
       `${(100 * gridRefused / gridPairs).toFixed(1)}% of ${gridPairs}`);
    ok('while the ground the grid wrote off is tighter, as it should be',
       moverRefused / pairs > gridRefused / gridPairs,
       `all ${(100 * moverRefused / pairs).toFixed(1)}% vs grid-only ` +
       `${(100 * gridRefused / gridPairs).toFixed(1)}%`);

    const comp = components(geo, { collision: true });
    const biggest = Math.max(...comp.sizes);
    const walkable = comp.sizes.reduce((n, s) => n + s, 0);
    // A TERRACED MOUNTAIN IS NOT ONE BODY OF FLOOR, AND THIS USED TO INSIST IT WAS.
  // The threshold was 0.6 and room 578 now comes out at 745/2450 in 139 regions, because
  // the climb rule finally refuses its 1600-unit terrace faces. That is the room the
  // operator walked on 2026-08-17: arriving from The King's Way you are in the basin and
  // cannot reach any other exit on foot; blink puts you on top and then they are all
  // reachable. A room that models as one body is a room where that is not true.
  //
  // So the property is the FLOOR, not the fraction: the largest region must still be a
  // usable body rather than a scatter of ledges, and the room must not have dissolved.
  ok('the mover view still leaves a usable body of floor rather than a scatter',
     biggest >= 500 && comp.count < walkable / 10,
     `${biggest}/${walkable} in ${comp.count} region(s)`);
    ok('and the pockets against the walls are KEPT, because they are the safe spots',
       comp.count > 1 && comp.sizes.filter(s => s === 1).length > 0,
       `${comp.sizes.filter(s => s === 1).length} single-square pocket(s)`);

    // A MASK IS ONLY WORTH HAVING IF IT IS THE SAME ANSWER. This is the assertion that
    // catches a reordered bit table, an off-by-one row stride, or a predicate that drifted
    // between the bake and the runtime.
    const mask = geo.buildStepMask();
    ok('the mask is one byte for every square', mask.length === geo.rows * geo.cols);
    const fresh = RoomGeometry.fromJSON(room.roo);
    fresh.attachStepMask(mask);
    let agree = true, checked = 0;
    for (let r = 1; r <= geo.rows && agree; r++) for (let c = 1; c <= geo.cols && agree; c++) {
      if (!geo.walkable(r, c)) continue;
      for (const d of STEP_MASK_DIRS) {
        const nr = r + d.dr, nc = c + d.dc;
        if (!geo.inBounds(nr, nc) || !geo.walkable(nr, nc)) continue;
        checked++;
        if (fresh.moverStepLands(r, c, nr, nc) !== geo.moverStepLands(r, c, nr, nc)) agree = false;
      }
    }
    ok('reading the mask gives the same answer as tracing, on every pair in the room',
       agree, `${checked} pair(s) compared`);

    // AND THE ANCHOR CHOICE. A boundary publishes many staging squares; taking the first
    // is how this room reported all four exits unreachable.
    const bodySeed = (() => {
      let best = -1, id = -1;
      for (let i = 0; i < comp.sizes.length; i++) if (comp.sizes[i] > best) { best = comp.sizes[i]; id = i; }
      for (let r = 1; r <= geo.rows; r++) for (let c = 1; c <= geo.cols; c++)
        if (geo.walkable(r, c) && comp.label[comp.at(r, c)] === id) return { r, c };
      return null;
    })();
    const body = new Set();
    if (bodySeed) {
      const stack = [bodySeed];
      body.add(`${bodySeed.r},${bodySeed.c}`);
      while (stack.length) {
        const at = stack.pop();
        for (const n of geo.neighbors(at.r, at.c, { collision: true })) {
          const k = `${n.row},${n.col}`;
          if (body.has(k)) continue;
          body.add(k); stack.push({ r: n.row, c: n.col });
        }
      }
    }
    const naive = exitAnchors(room, geo);
    const chosen = exitAnchors(room, geo, { reachable: body });
    const reach = list => list.filter(a => body.has(`${a.row},${a.col}`)).length;
    ok('choosing anchors with the body in hand reaches at least as many exits',
       reach(chosen) >= reach(naive),
       `first-offered ${reach(naive)}/${naive.length}, body-aware ${reach(chosen)}/${chosen.length}`);
    // THIS USED TO ASSERT A STRICT IMPROVEMENT AND NOW ASSERTS THE PROPERTY, because the
    // gap it measured was closed from the other end. Anchors are now chosen per EXIT
    // (`edgeCandidatesOf`, which runs `selectedEdgeAt`) rather than per DIRECTION, so the
    // candidate list no longer contains squares that would fire a different exit — and on
    // this room that alone puts a reachable square first, leaving the body-aware pass
    // nothing to rescue. A delta is only a contract while the baseline stays bad; what
    // actually has to hold is that the body can reach these exits, so assert THAT.
    //
    // Three of four, and the fourth is not a defect: entering the Cragged Mountains by the
    // north-west makes the south-west and south-east exits a one-way trip unless you blink
    // up the cliff. It is the one place in the world genuinely joined only by blink.
    // AND IT REACHES ALL FIVE, WHICH CONTRADICTS THIS REPOSITORY'S OWN PROSE — recorded
    // rather than asserted away. CLAUDE.md calls this cliff "the one place in the world
    // genuinely joined only by blink": enter by the north-west and the south-west and
    // south-east exits are said to be a one-way trip. The model does not agree and never
    // has. Checked directly with the OLD predicate (grid gate, centre aiming), every
    // ordered anchor pair here already had a route — 35,1 -> 1,13 in 60 steps, 1,13 ->
    // 35,1 in 59 — so this is not something the standable/stand-point work introduced; it
    // only made the same routes shorter (36 and 34). Either a player really can walk it
    // and the prose is wrong, or our vertical rules are too generous here and have been
    // all along. `m59-impossible-test` still refuses every checked-in trace in both
    // Cragged Mountains rooms, so whatever it is, it is not the traversals anybody has
    // written down. Worth an hour in the client; not worth a test that lies either way.
    // AND ON THE CRAGGED MOUNTAINS THE BODY REACHES EXACTLY ONE EXIT, WHICH IS THE FINDING.
  // This assertion has now been wrong twice in opposite directions. It first demanded a
  // strict improvement over first-offered; then, when the anchor work closed that gap, it
  // demanded that the body reach EVERY exit — which the model happily satisfied because it
  // believed a character could climb a 1600-unit cliff face. It cannot. The operator
  // walked it: from the basin you reach the north exit to The King's Way and nothing else,
  // and blink is what puts you on top.
  //
  // One exit from the basin is therefore the correct answer, and it is asserted as an
  // EXACT count rather than a floor, because "reaches at least one" would pass again the
  // day the cliff reopens.
  ok('and on the Cragged Mountains the basin reaches exactly one exit — the rest need blink',
     reach(chosen) === 1 && chosen.length >= 4,
     `first-offered ${reach(naive)}, body-aware ${reach(chosen)} of ${chosen.length}`);
    ok('an anchor it cannot reach is still OFFERED rather than deleted — a bake must ' +
       'never be the reason a doorway disappears',
       chosen.length === naive.length);

    // ------------------------------------------------ clearance: do not hug the wall
    //
    // A safe spot is a square the geometry hems in, which is what makes it worth
    // STANDING on and the last thing worth ROUTING THROUGH. With a flat step cost A* is
    // indifferent between the middle of a gap and the tight side of it, and the tight
    // side is where a step slides, the mover lands off plan, and the walker starts
    // bouncing. The preference is COST, so it can shape a route and can never remove one.
    const CLEARANCE = 0.6;                    // what leaveVia asks for
    const masked = RoomGeometry.fromJSON(room.roo);
    masked.attachStepMask(geo.buildStepMask());
    const tightness = at => {
      let open = 0;
      for (const d of STEP_MASK_DIRS) {
        const r = at.row + d.dr, c = at.col + d.dc;
        // `standable`, because that is what `clearanceField` counts. Measuring openness
        // one way while the router optimises it another does not weaken the test, it
        // points it at a different quantity: with `walkable` here the preference read as
        // making routes WORSE (3.69 -> 3.89) while doing exactly what it was asked.
        if (masked.inBounds(r, c) && masked.standable(r, c)
            && masked.moverStepLands(at.row, at.col, r, c)) open++;
      }
      return STEP_MASK_DIRS.length - open;
    };
    const floor = [];
    for (let r = 1; r <= masked.rows; r++) for (let c = 1; c <= masked.cols; c++)
      if (masked.walkable(r, c)) floor.push({ row: r, col: c });
    let seed = 7, routes = 0, hugged = 0, cleared = 0, lenFlat = 0, lenClear = 0;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 400 && routes < 40; i++) {
      const a = floor[(rnd() * floor.length) | 0], b = floor[(rnd() * floor.length) | 0];
      const flat = masked.path(a.row, a.col, b.row, b.col, { clearance: 0 });
      const clear = masked.path(a.row, a.col, b.row, b.col, { clearance: CLEARANCE });
      if (!flat.found || !clear.found || flat.steps.length < 8) continue;
      routes++;
      const mean = p => p.steps.reduce((n, s) => n + tightness(s), 0) / p.steps.length;
      hugged += mean(flat); cleared += mean(clear);
      lenFlat += flat.steps.length; lenClear += clear.steps.length;
    }
    ok('the clearance preference routes further from the walls',
       routes > 10 && cleared < hugged,
       `${routes} routes, ${(hugged / routes).toFixed(2)} -> ${(cleared / routes).toFixed(2)} ` +
       'blocked neighbours per step');
    ok('and pays for it in a little length rather than in refusals',
       lenClear >= lenFlat && lenClear < lenFlat * 1.25,
       `${(lenFlat / routes).toFixed(1)} -> ${(lenClear / routes).toFixed(1)} steps`);
    // IT MAY ONLY EVER PREFER. Same rule as the mask itself: being wrong about a wall
    // costs a walk, refusing costs the errand, silently.
    let bothFound = true;
    for (let i = 0; i < 200 && bothFound; i++) {
      const a = floor[(rnd() * floor.length) | 0], b = floor[(rnd() * floor.length) | 0];
      if (masked.path(a.row, a.col, b.row, b.col, { clearance: 0 }).found
          !== masked.path(a.row, a.col, b.row, b.col, { clearance: CLEARANCE }).found)
        bothFound = false;
    }
    ok('a route that exists without the preference still exists with it', bothFound);
    // THE DESTINATION IS EXEMPT, because walking to a wall corner is the whole point of
    // a safe spot and taxing it would price the fleet out of the move that keeps it alive.
    const corner = floor.filter(p => tightness(p) >= 5)
      .find(p => masked.path(floor[0].row, floor[0].col, p.row, p.col,
                             { clearance: CLEARANCE }).found);
    ok('a tight corner is still routed to', !!corner,
       corner ? `${corner.col},${corner.row}` : 'no reachable corner in this room');
    ok('and with no mask there is nothing to measure clearance against',
       RoomGeometry.fromJSON(room.roo).clearanceField({ weight: CLEARANCE }) === null);
    ok('the field itself is off unless a weight is asked for, exactly as `path` is',
       masked.clearanceField() === null && typeof masked.clearanceField({ weight: CLEARANCE }) === 'function');
    // OFF UNLESS ASKED, which is the property that keeps a safe wall reachable on the
    // terms the safe-spot ranking measured it on. `world.reach` and every tactical walk
    // take this default; only leaveVia opts in.
    {
      const a = floor[0], b = floor[floor.length - 1];
      const plain = masked.path(a.row, a.col, b.row, b.col);
      const zero = masked.path(a.row, a.col, b.row, b.col, { clearance: 0 });
      ok('the default really is the zero-weight route, step for step',
         JSON.stringify(plain.steps) === JSON.stringify(zero.steps));
    }
  }
}

// ------------------------------------------------- one wall, two rooms, two anchors
// A BOUNDARY IS NOT AN EXIT, AND THE FAILURE IS ARRIVING SOMEWHERE ELSE RATHER THAN NOT
// ARRIVING. Western border of the Twisted Wood declares BOTH `east -> 586 row<19` and
// `east -> 597 row>20` — one wall, split by row. The bake asked
// `edgeApproachCandidates(dir)`, which is the per-DIRECTION question, took the first
// square it offered, and gave both exits the anchor 9,67. That satisfies `row<19`, so a
// character asked to walk to The Twisted Wood was routed to a square that puts it in Main
// gate to the city of Tos. Every leg reports success; the character is simply in the wrong
// room, and nothing downstream compares where it meant to go with where it went.
//
// So the property is not "an anchor exists" and not "the walk arrives" — it is that
// crossing AT the anchor fires the exit the anchor was baked FOR. `selectedEdgeAt` is the
// authority, because it simulates StandardLeaveDir's own ordered scan of plEdge_Exits
// rather than testing the one condition in isolation: a default entry is remembered but
// does not stop the scan, so a square can satisfy a condition and still lose to a later
// unconditional edge.
console.log('\nexit anchors — a shared wall gives each DESTINATION its own square');
if (!existsSync(movementMapFile())) {
  skip('per-destination exit anchors', 'no baked map');
} else {
  const map = loadMap();

  // The worked example, named, because it is the one the fleet walks and the one the
  // operator watched fail.
  const wbottw = map.rooms['587'];
  const geo = wbottw?.roo ? sharedRoomGeometry(wbottw) : null;
  if (!geo?.collisionReady) {
    skip('Western border of the Twisted Wood splits its east wall', 'no geometry for 587');
  } else {
    const anchors = exitAnchors(wbottw, geo);
    const toTos = anchors.find(a => a.to === 586), toWood = anchors.find(a => a.to === 597);
    ok('both east exits get an anchor at all', !!toTos && !!toWood,
       anchors.map(a => `${a.to}@${a.row},${a.col}`).join(' '));
    if (toTos && toWood) {
      ok('and they are DIFFERENT squares', toTos.row !== toWood.row || toTos.col !== toWood.col,
         `${toTos.row},${toTos.col} vs ${toWood.row},${toWood.col}`);
      // The conditions, asserted as the game states them rather than as the anchors
      // happen to have come out: a fix that moved both anchors to the same wrong side
      // would still satisfy "different" above if the two rooms swapped.
      ok('Main gate to the city of Tos is reached from row < 19', toTos.row < 19, `row ${toTos.row}`);
      ok('The Twisted Wood is reached from row > 20', toWood.row > 20, `row ${toWood.row}`);
    }
  }

  // The general property, over every room that has geometry. This is the one that would
  // have caught it without anybody knowing which wall to look at.
  let checked = 0, wrongRoom = 0, offBoundary = 0;
  const offenders = [];
  for (const room of Object.values(map.rooms)) {
    if (!room?.roo || room.rooDimensionMismatch) continue;
    let g = null;
    try { g = sharedRoomGeometry(room); } catch { continue; }
    if (!g?.collisionReady) continue;
    let anchors = [];
    try { anchors = exitAnchors(room, g); } catch { continue; }
    for (const a of anchors) {
      if (a.kind !== 'edge') continue;
      // A staging square inland of the wall is legitimate — the condition is evaluated
      // where you LEAVE from, so only a square actually on that boundary can be asked.
      const onBoundary = (a.dir === 'west' && a.col === 1) || (a.dir === 'east' && a.col === room.cols)
                      || (a.dir === 'north' && a.row === 1) || (a.dir === 'south' && a.row === room.rows);
      if (!onBoundary) { offBoundary++; continue; }
      const sel = selectedEdgeAt(room, a.dir, a);
      if (!sel) continue;
      checked++;
      if (Number(sel.to) !== Number(a.to)) {
        wrongRoom++;
        if (offenders.length < 6)
          offenders.push(`${room.num} ${a.dir} ${a.row},${a.col} baked->${a.to} fires->${sel.to}`);
      }
    }
  }
  ok(`crossing at an anchor fires the exit it was baked for (${checked} anchors)`,
     checked > 0 && wrongRoom === 0, offenders.join(' | ') || `${wrongRoom} wrong`);
  ok('and the check had real coverage rather than passing by finding nothing',
     checked >= 200, `${checked} on-boundary anchors, ${offBoundary} staged inland`);

  // CROSS-VALIDATION AGAINST REALITY, which is the only thing here that is not derived
  // from the same .roo the anchors came from. A walk log records the square a real client
  // last stood on and the room it turned up in; the model has to agree with both.
  const book = crossingBook();
  let agree = 0, disagree = 0;
  const contradictions = [];
  for (const key of Object.keys(book)) {
    const [from, to] = key.split('>').map(Number);
    const room = map.rooms[String(from)];
    if (!room?.roo) continue;
    for (const obs of book[key]) {
      for (const d of ['west', 'east', 'north', 'south']) {
        const on = (d === 'west' && obs.col === 1) || (d === 'east' && obs.col === room.cols)
                || (d === 'north' && obs.row === 1) || (d === 'south' && obs.row === room.rows);
        if (!on) continue;
        const sel = selectedEdgeAt(room, d, obs);
        if (!sel) continue;
        if (Number(sel.to) === to) agree++;
        else {
          disagree++;
          if (contradictions.length < 4)
            contradictions.push(`${from} ${d} ${obs.row},${obs.col} model->${sel.to} walked->${to}`);
        }
      }
    }
  }
  if (!agree && !disagree) skip('the condition model against recorded crossings', 'no crossing book');
  else ok(`the condition model reproduces every recorded crossing (${agree})`,
          disagree === 0, contradictions.join(' | '));
}

// ------------------------------------------- the grid is not the authority on standing
// THE SERVER ENFORCES NOTHING ABOUT WHERE A PLAYER STANDS. `UserMove` bypasses
// `ReqSomethingMoved` — room.kod's own comment is "already been checked by client (HAHA!)"
// — so `ROOM_FLAG_WALKABLE` is a server-side convenience that nothing consults when a
// person walks. The client's BSP is the only collision detector there is.
//
// Letting that grid veto a step the BSP allows deleted real ground, and it deleted it
// exactly where the rooms are tightest. A byte cannot describe a 1024-unit square that is
// 41% floor, and Western border of the Twisted Wood — 54.9% of its wall length not
// axis-aligned, a 1-2 square wide diagonal corridor — has 61 squares that are more than
// half floor and called wall.
//
// The failure was not "a step is refused". `buildStepMask` gated on `walkable` for the
// square being LEFT as well, so such a square carried a mask byte of ZERO: a character
// standing in one had no legal step in any direction, no route anywhere, and replanned for
// ever. On the board that reads as `travelling`, next to the door it is trying to use.
console.log('\nstandable — BSP floor, not the server grid');
if (!existsSync(movementMapFile())) {
  skip('standable never removes ground', 'no baked map');
} else {
  const map = loadMap();
  const rooms = Object.values(map.rooms).filter(r => r?.roo && !r.rooDimensionMismatch);

  // 1. IT CAN ONLY EVER ADD. The grid's yes is honoured unconditionally, so nothing that
  //    planned before can stop planning. This is the assertion that keeps the change safe
  //    in the restrictive direction, and it is checked over the whole world.
  let walkableSquares = 0, notStandable = 0, added = 0, checkedRooms = 0;
  for (const room of rooms) {
    let geo = null;
    try { geo = sharedRoomGeometry(room); } catch { continue; }
    if (!geo?.collisionReady) continue;
    checkedRooms++;
    for (let r = 1; r <= room.rows; r++)
      for (let c = 1; c <= room.cols; c++) {
        if (geo.walkable(r, c)) { walkableSquares++; if (!geo.standable(r, c)) notStandable++; }
        else if (geo.standable(r, c)) added++;
      }
  }
  ok(`every walkable square is standable (${walkableSquares} across ${checkedRooms} rooms)`,
     walkableSquares > 0 && notStandable === 0, `${notStandable} walkable squares went missing`);
  ok('and it genuinely adds ground rather than being a rename',
     added > 0, `${added} squares have BSP floor the coarse grid calls wall`);

  // 2. AND IT IS NOT "EVERYTHING". A predicate that answered yes everywhere would pass the
  //    assertion above and be worthless — worse, it would send the router into solid rock.
  {
    const room = map.rooms['587'];
    const geo = room?.roo ? sharedRoomGeometry(room) : null;
    if (!geo?.collisionReady) skip('Western border of the Twisted Wood', 'no geometry for 587');
    else {
      let stand = 0, total = 0;
      for (let r = 1; r <= room.rows; r++)
        for (let c = 1; c <= room.cols; c++) { total++; if (geo.standable(r, c)) stand++; }
      ok('most of a room is still NOT standable — this is not a blanket yes',
         stand < total * 0.75, `${stand}/${total} standable`);
    }
  }

  // 3. THE OPERATOR'S OWN EVIDENCE, and the only assertion here not derived from the same
  //    .roo as the predicate. A real client stood in every one of these squares; 137 of
  //    them are squares the coarse grid calls wall. If any is not standable, the predicate
  //    is still deleting ground somebody walks on.
  {
    const walksDir = WALKS_DIR;
    const byObj = new Map();
    for (const [n, r] of Object.entries(map.rooms)) if (r.objId) byObj.set(r.objId, n);
    let stood = 0, notStood = 0, gridSaidWall = 0;
    const offenders = [];
    if (existsSync(walksDir)) {
      for (const f of readdirSync(walksDir)) {
        if (!f.endsWith('.jsonl')) continue;
        for (const line of readFileSync(join(walksDir, f), 'utf8').split('\n')) {
          if (!line) continue;
          let p; try { p = JSON.parse(line); } catch { continue; }
          const num = byObj.get(p.room); if (!num) continue;
          const room = map.rooms[num];
          if (p.row < 1 || p.col < 1 || p.row > room.rows || p.col > room.cols) continue;
          let geo = null; try { geo = sharedRoomGeometry(room); } catch { continue; }
          if (!geo?.collisionReady) continue;
          stood++;
          if (!geo.walkable(p.row, p.col)) gridSaidWall++;
          if (!geo.standable(p.row, p.col)) {
            notStood++;
            if (offenders.length < 5) offenders.push(`${num} ${p.row},${p.col}`);
          }
        }
      }
    }
    if (!stood) skip('every square a person stood in is standable', 'no walk logs here');
    else {
      ok(`every square a real client stood in is standable (${stood} positions)`,
         notStood === 0, offenders.join(' '));
      ok('and the grid would have refused a real chunk of them',
         gridSaidWall > 0, `${gridSaidWall} of ${stood} are squares the coarse grid calls wall`);
    }
  }

  // 4. A MASK FROM THE OLD PREDICATE MUST NOT BE ATTACHED. The manifest hashes GEOMETRY and
  //    cannot see the predicate change, so without this a table baked by older code
  //    verifies perfectly and encodes the wrong doors — silently, which is the one outcome
  //    this repository keeps paying for.
  ok('a table stamped with an older step-mask predicate is refused',
     stepMaskCurrent({ stepMaskVersion: STEP_MASK_VERSION }) === true
     && stepMaskCurrent({ stepMaskVersion: STEP_MASK_VERSION - 1 }) === false
     && stepMaskCurrent({}) === false,
     'an unstamped table must read as v1, not as current');
}

// ------------------------------------------------ a loop is obvious once it is in space
// NOTHING SURPRISES A WALKER IN THIS GAME. The walls are in the .roo before anybody logs
// in and they are there tomorrow, so a route that leaves a square and comes back to it
// learned nothing in between — the whole detour is waste. That is trivial to see when the
// route is laid out in SPACE and nearly invisible while it is being lived one step at a
// time, which is how the fleet bounced `4,15 -> 5,15` / `5,15 -> 4,16` eight times and
// reported itself travelling throughout.
console.log('\nelideLoops — remove the round trips, never invent a step');
{
  const sq = (row, col) => ({ row, col });
  const path = a => a.map(([r, c]) => sq(r, c));
  const same = (a, b) => a.length === b.length &&
    a.every((p, i) => p.row === b[i].row && p.col === b[i].col);

  ok('a route with no repeat is returned unchanged',
     same(elideLoops(path([[1, 1], [1, 2], [1, 3]])), path([[1, 1], [1, 2], [1, 3]])));
  ok('an empty route survives', elideLoops([]).length === 0);
  ok('a null route is not a crash', elideLoops(null).length === 0);

  // The bounce, exactly as the trail recorded it.
  ok('a two-square bounce collapses to the square it never left',
     same(elideLoops(path([[4, 15], [5, 15], [4, 15], [5, 15], [4, 15], [4, 16]])),
          path([[4, 15], [4, 16]])));

  // A long excursion that returns is removed whole, and the step across the join is one
  // the route already contained — which is the entire safety argument.
  {
    const before = path([[1, 1], [1, 2], [2, 2], [3, 2], [2, 2], [1, 2], [1, 3]]);
    const after = elideLoops(before);
    ok('an excursion that comes back is removed down to the return point',
       same(after, path([[1, 1], [1, 2], [1, 3]])));
    const wasAdjacentInInput = after.every((p, i) => {
      if (!i) return true;
      const q = after[i - 1];
      for (let k = 1; k < before.length; k++)
        if (before[k - 1].row === q.row && before[k - 1].col === q.col
            && before[k].row === p.row && before[k].col === p.col) return true;
      return false;
    });
    ok('and every surviving step was a step the original route already made',
       wasAdjacentInInput);
    ok('it never returns more than it was given', after.length <= before.length);
  }

  // THE BREADCRUMB KEY, which is a different question and the one that can lose an escape.
  // A crumb chains `to` -> the next crumb's `from`, and the retreat drops a broken trail
  // WHOLE rather than skipping, so an elision that leaves the chain unjoined does not
  // shorten the escape — it deletes it.
  {
    const crumb = (fx, fy, tx, ty) => ({ roomId: 7, from: { x: fx, y: fy }, to: { x: tx, y: ty } });
    const trail = [crumb(0, 0, 10, 0), crumb(10, 0, 20, 0), crumb(20, 0, 10, 0),
                   crumb(10, 0, 30, 0)];
    const key = cr => `${cr.roomId}:${cr.to.x},${cr.to.y}`;
    const cut = elideLoops(trail, key);
    ok('a crumb trail that returns to the same POINT loses the round trip',
       cut.length === 2 && cut[0].to.x === 10 && cut[1].to.x === 30);
    let joins = true;
    for (let i = 1; i < cut.length; i++)
      if (cut[i].from.x !== cut[i - 1].to.x || cut[i].from.y !== cut[i - 1].to.y) joins = false;
    ok('and the surviving trail still chains end to end, exactly',
       joins, 'a broken chain is dropped whole by the retreat, so this must hold');
    ok('a trail with no repeated landing point is untouched',
       elideLoops([crumb(0, 0, 10, 0), crumb(10, 0, 20, 0)], key).length === 2);
  }
}


// ---------------------------------------------- the last step into the goal
// A PLAN WHOSE FINAL STEP THE MOVER REFUSES IS NOT A ROUTE, IT IS A LOOP.
//
// `neighbors` exempts the goal square from `moverStepLands` so that a doorway the model
// dislikes is never deleted from the map — 346 of the exit anchors this bake cannot reach
// are `go` exits whose square IS the door tile. That is right, and on its own it is also
// how a walker is handed a route it can never finish: A* sees all eight approaches to the
// goal as equal, takes the cheapest, and ends on a step the mover will not make. `walkTo`
// re-sends it, lands elsewhere, replans into the same corner, and reports "kept ending up
// somewhere other than the planned square".
//
// Measured live in Deep Forest of Farol: the exit square 2,30 is reachable from FIVE of
// its eight neighbours, the planner chose the one refused diagonal (3,29), and Delta stood
// 21 steps short of a door it could see. Asking strictly first found the same 12-step
// route approached from 3,30, every step walkable. Across the world: 21,348 anchor pairs,
// 2,323 unwalkable plans repaired, and ZERO routes lost.
//
// Both halves are pinned, because each fails in a different dangerous direction — dropping
// the strict pass brings the loop back, and dropping the fallback deletes doorways.
console.log('\nthe last step into the goal — strict first, exemption as a fallback');
{
  const mk = (refuse) => {
    const g = RoomGeometry.fromJSON({
      rows: 4, cols: 4,
      flags: new Array(16).fill(1),
      grid: new Array(16).fill(0xff),
      moveGrid: new Array(16).fill(0xff),
    });
    g.standable = (r, c) => r >= 1 && r <= 4 && c >= 1 && c <= 4;
    g.moverStepLands = (fr, fc, tr, tc) => !refuse.has(`${fr},${fc}>${tr},${tc}`);
    return g;
  };
  const GOAL = '1,2';
  // Every approach to the goal is refused EXCEPT straight north from 2,2.
  const onlyNorth = new Set();
  for (let r = 1; r <= 4; r++) for (let c = 1; c <= 4; c++)
    if (`${r},${c}` !== '2,2') onlyNorth.add(`${r},${c}>${GOAL}`);

  const g1 = mk(onlyNorth);
  const p1 = g1.path(4, 4, 1, 2, { collision: true });
  const lastFrom1 = p1.steps && p1.steps.length > 1
    ? p1.steps[p1.steps.length - 2] : { row: 4, col: 4 };
  ok('it plans a route to the goal', p1.found === true);
  ok('and approaches it from the one square the mover accepts',
     lastFrom1.row === 2 && lastFrom1.col === 2,
     `approached from ${lastFrom1.row},${lastFrom1.col}`);
  ok('so no planned step is one the mover refuses',
     (p1.steps || []).every((st, i) => {
       const prev = i ? p1.steps[i - 1] : { row: 4, col: 4 };
       return g1.moverStepLands(prev.row, prev.col, st.row, st.col);
     }));
  ok('and it does not report itself as having used the exemption',
     p1.goal_exempt === undefined);

  // NOW THE FALLBACK: refuse EVERY approach. The doorway must not disappear.
  const all = new Set();
  for (let r = 1; r <= 4; r++) for (let c = 1; c <= 4; c++) all.add(`${r},${c}>${GOAL}`);
  const g2 = mk(all);
  const p2 = g2.path(4, 4, 1, 2, { collision: true });
  ok('a goal no approach can reach is STILL routed to — a bake never deletes a doorway',
     p2.found === true, 'this is the half that keeps `go` exits usable');
  ok('and it says so, so a caller can make a fine-positioned correction',
     p2.goal_exempt === true);
  ok('an ordinary goal is unaffected by either pass',
     g2.path(4, 4, 3, 3, { collision: true }).found === true);
}

// The measured case, on the real bake — skipped rather than silently passed without one.
{
  const realMap = existsSync(MAP_ON_DISK) ? await loadMap() : null;
  // The masks are what `path` plans on; without attaching them this asserts nothing.
  if (realMap) attachStepMasks(realMap, {});
  const raw556 = realMap?.rooms?.['556'] ?? realMap?.rooms?.[556];
  const g556 = raw556 ? sharedRoomGeometry(raw556) : null;
  if (!g556?.hasStepMask) {
    skip('Deep Forest of Farol plans a walkable last step into its 545 exit',
         'no baked step mask on disk — run tools/m59-routebake.mjs');
  } else {
    const p = g556.path(12, 35, 2, 30);
    let refused = 0, prev = { row: 12, col: 35 };
    for (const st of (p.steps || [])) {
      if (!st.recovered && !g556.moverStepLands(prev.row, prev.col, st.row, st.col)) refused++;
      prev = st;
    }
    ok('Deep Forest of Farol still reaches its 545 exit square', p.found === true);
    ok('and every step of that plan is one the mover will actually make', refused === 0,
       `${refused} refused — this is the walk that stalled Delta 21 steps from the door`);
  }
}

// ---------------------------------------------- crossing a room, not merely entering it
// THE ROUTER PLANNED OVER ROOMS, WHICH ASSUMES ANY TWO DOORS OF A ROOM ARE JOINED BY FLOOR.
//
// Often they are not. The Cragged Mountains basin reaches exactly one of its five exits on
// foot. West Merchant Way is the same shape inverted, and the operator walked it: you enter
// from Marion at the TOP, walk down, and cannot climb back — and unlike the Cragged
// Mountains, blink does not help. Their words: "some exits aren't reachable from others".
//
// A route planned in ignorance of that is not a long route. It is a plan that walks a
// character into a hole. The regions needed to see it were already baked per anchor.
//
// Measured across fourteen town-to-town journeys with the predicate supplied: TWO change —
// Jasper<->Barloque stops threading the impossible 545/556 crossing and goes round for two
// extra hops — and ZERO are lost.
console.log('\ncrossing a room — planning over doors rather than over rooms');
{
  const realMap = existsSync(MAP_ON_DISK) ? await loadMap() : null;
  const table = realMap ? (await import('./m59-routes.mjs')).routesFor(realMap.geometryManifestSha256) : null;
  const { anchorFor: aFor, sameRegion: sameReg } = await import('./m59-routes.mjs');
  const { findPath: fp } = await import('./m59-map.mjs');
  if (!table) {
    skip('a transit the room cannot walk is routed around', 'no usable routing table on disk');
  } else {
    const transitOk = (room, cameFrom, goingTo) => {
      const a = aFor(table, room, cameFrom), b = aFor(table, room, goingTo);
      if (!a || !b) return null;
      return sameReg(table, room, a, b);
    };
    // The measured pair. 545 cannot be crossed from its Marion side to its 556 door.
    const before = fp(realMap, 382, 101);
    const after = fp(realMap, 382, 101, { transitOk });
    const rooms = p => [382, ...p.hops.map(h => h.to)];
    ok('the old plan threaded West Merchant Way straight into Deep Forest of Farol',
       (() => { const r = rooms(before); const i = r.indexOf(556);
                return i >= 0 && r[i + 1] === 545; })(), JSON.stringify(rooms(before)));
    ok('the transit-aware plan does not', after.found &&
       (() => { const r = rooms(after); const i = r.indexOf(556);
                return i < 0 || r[i + 1] !== 545; })(), JSON.stringify(rooms(after)));
    ok('and it still gets there', after.found === true);
    ok('and says the crossings were checked', after.transit_checked === true);

    // NOTHING IS LOST. A bake must never be the reason a journey becomes impossible — the
    // same rule the step mask follows, and the one that matters most here because this
    // constraint is applied to EVERY route the fleet plans.
    const TOWNS = [50, 382, 350, 101, 102, 150, 200];
    let lost = 0, checked = 0;
    for (const a of TOWNS) for (const b of TOWNS) {
      if (a === b) continue;
      checked++;
      if (fp(realMap, a, b).found && !fp(realMap, a, b, { transitOk }).found) lost++;
    }
    ok(`no town-to-town journey is lost to the constraint (${checked} pairs)`, lost === 0,
       `${lost} lost — a bake must never make a journey impossible`);

    // AND AN UNKNOWN NEVER REFUSES. A predicate that answers null for everything has to
    // leave the route exactly as it was, or an unbaked room silently severs the world.
    const blind = fp(realMap, 382, 101, { transitOk: () => null });
    ok('a predicate that knows nothing changes no route',
       blind.found && JSON.stringify(rooms(blind)) === JSON.stringify(rooms(before)),
       JSON.stringify({ blind: rooms(blind), before: rooms(before) }));

    // AND IT FALLS BACK RATHER THAN REFUSING. With every crossing denied there is no legal
    // route at all, and the answer must still be the old one, flagged.
    const denied = fp(realMap, 382, 101, { transitOk: () => false });
    ok('with every crossing denied it falls back instead of refusing',
       denied.found === true && denied.transit_unverified === true,
       JSON.stringify({ found: denied.found, flag: denied.transit_unverified }));
  }
}

// ---------------------------------------------- a one-way room, and a jump across a gap
// THE QUESTION A ROUTER ASKS IS DIRECTED, AND `sameRegion` ANSWERS A STRICTER ONE.
//
// Regions are strongly connected components — each door reaching the OTHER. Where a room
// contains a one-way drop the two answers come apart, and the mutual one is wrong in the
// direction the fleet actually travels: measured in Ukgoth, the Castle Victoria door
// reaches the Sentinel door in 136 steps while the reverse has no route at all. Asked the
// mutual question the transit was refused and every Castle Victoria route fell back to an
// unverified plan; asked the directed one, the real asymmetric route appears — out through
// the Cragged Mountains, home by the Sentinel.
//
// AND A JUMP IS A TRAVERSAL THE WALK CANNOT DECOMPOSE. HIGH -> LOW -> MEDIUM is a drop and
// then an impossible climb, square by square, and a body in the air never stands on the low
// ground. `fallTargets` offers those landings; `enforceStepHeight` still refuses the climb.
console.log('\none-way transits, and the jumps the square walk cannot express');
{
  const realMap = existsSync(MAP_ON_DISK) ? await loadMap() : null;
  const { routesFor: rf, anchorFor: aFor, sameRegion: sameReg, anchorReach: reaches } =
    await import('./m59-routes.mjs');
  const table = realMap ? rf(realMap.geometryManifestSha256) : null;
  if (!table) {
    skip('a one-way transit is offered in the direction that works', 'no routing table on disk');
  } else {
    const { findPath: fp } = await import('./m59-map.mjs');
    // THE SAME THREE LINES `m59-world.mjs` USES, and they ask `anchorReach` rather than
    // `bakedPath` for a reason this room is the proof of. A baked ROUTE is one letter per
    // step in the eight unit directions; a FALL is one move of two or three squares, so a
    // route containing one cannot be spelled and used to produce no entry at all. Ukgoth's
    // 83-step route from the Castle Victoria doorway to the Sentinel doorway BEGINS with a
    // fall, 2,26 -> 5,23, and this assertion went red the moment the north anchor moved off
    // the rock island onto the real door. `reach` is the BFS answer, kept either way.
    const directed = (room, from, to) => {
      const x = aFor(table, room, from), y = aFor(table, room, to);
      if (!x || !y) return null;
      if (reaches(table, room, x, y)) return true;
      return sameReg(table, room, x, y);
    };
    // Ukgoth: the two doors are NOT mutually reachable, and that must not refuse the
    // direction that is.
    const cv = aFor(table, 599, 2), sentinel = aFor(table, 599, 589);
    ok('Ukgoth’s Castle Victoria and Sentinel doors are in different components',
       cv && sentinel && sameReg(table, 599, cv, sentinel) === false,
       JSON.stringify({ cv: cv && cv.region, sentinel: sentinel && sentinel.region }));
    ok('but the directed answer still offers the way that works',
       directed(599, 2, 589) === true);

    // The whole journey, both ways, with every crossing checked rather than fallen back on.
    const out = fp(realMap, 50, 39, { transitOk: directed });
    const home = fp(realMap, 39, 50, { transitOk: directed });
    ok('Tos reaches Upstairs in Castle Victoria with every crossing checked',
       out.found && out.transit_checked === true, JSON.stringify({ found: out.found }));
    ok('and Castle Victoria gets home with every crossing checked',
       home.found && home.transit_checked === true, JSON.stringify({ found: home.found }));
    // THE TWO ROUTES ARE NOT THE SAME, and that is the point rather than a curiosity.
    const rooms = p => [...p.hops.map(h => h.to)].join(',');
    ok('and the way home is a DIFFERENT route from the way out',
       rooms(out) !== rooms(home), rooms(out) + '  vs  ' + rooms(home));
    ok('out goes by the Cragged Mountains', rooms(out).includes('598'), rooms(out));
    ok('home goes by Under the shadow of the Sentinel', rooms(home).includes('589'), rooms(home));
  }
}

// A jump is downhill, over a real gap, and only where the walk cannot go.
{
  const realMap = existsSync(MAP_ON_DISK) ? await loadMap() : null;
  const raw = realMap?.rooms?.['578'] ?? realMap?.rooms?.[578];
  const g = raw ? RoomGeometry.fromJSON(raw.roo ?? raw) : null;
  if (!g?.collisionReady) {
    skip('a fall is offered only downhill, over a gap, where the walk cannot go', 'no geometry');
  } else {
    const fl = (r, c) => { const p = g.standPoint(r, c);
      return p ? g.floorBaseAtClient(p.x, p.y, g.leafAtClient(p.x, p.y)) : null; };
    let edges = 0, uphill = 0, alreadyWalkable = 0;
    for (let r = 1; r <= g.rows; r++) for (let c = 1; c <= g.cols; c++) {
      if (!g.standable(r, c)) continue;
      for (const f of g.fallTargets(r, c)) {
        edges++;
        if (fl(f.row, f.col) > fl(r, c)) uphill++;
        // one square at a time along the same line must NOT already work
        let at = { r, c }, walk = true;
        const dr = Math.sign(f.row - r), dc = Math.sign(f.col - c);
        for (let k = 1; k <= f.distance && walk; k++) {
          const nr = r + dr * k, nc = c + dc * k;
          if (!g.moverStepLands(at.r, at.c, nr, nc)) walk = false;
          at = { r: nr, c: nc };
        }
        if (walk) alreadyWalkable++;
      }
    }
    ok(`the Cragged Mountains offer falls at all (${edges})`, edges > 0);
    ok('and not one of them is uphill — gravity is the whole mechanism', uphill === 0,
       `${uphill} uphill`);
    ok('and not one of them is ground the walk could already cover', alreadyWalkable === 0,
       `${alreadyWalkable} already walkable`);
  }
}

// -------------------------------------------------- proof-first rails in west Cragged
// ONE SLID STEP DOES NOT COMPOSE WITH THE NEXT ONE. `moverStepLands` quite correctly says
// r47c14 can reach square r46c15 by sliding along wall 679, but the next baked edge starts
// again from the IDEAL centre of r46c15. The old west and north rails therefore shared the
// fictional prefix r47c14 -> r46c15 -> r45c16 through that wall. Reversing the inbound
// rail wholesale is not safe either: two of its diagonals genuinely refuse in reverse.
//
// The bake now asks for a proof-first alternative only after stringPull reports evidence of
// an unverified leg, and adopts it only when that measured count improves. Pin both sides of
// the contract here: the westbound rail follows the real bidirectional corridor without a
// jump, while the northbound rail may retain a declared directed fall away from this wall.
console.log('\nroom 578 proof-first rails — symmetric corridor, no wall jump');
{
  const realMap = existsSync(MAP_ON_DISK) ? await loadMap() : null;
  const raw = realMap?.rooms?.['578'] ?? realMap?.rooms?.[578];
  const geometry = raw ? sharedRoomGeometry(raw) : null;
  if (!geometry?.collisionReady) {
    skip('room 578 proof-first rails are baked from real collision geometry', 'no geometry');
  } else {
    const baked = bakeRoom(raw);
    const evidence = (fromRow, fromCol, path) => {
      const steps = replay(fromRow, fromCol, path);
      const pts = [{ row: fromRow, col: fromCol }, ...steps]
        .map(s => ({ x: (s.col - 0.5) * CLIENT_FINENESS,
                     y: (s.row - 0.5) * CLIENT_FINENESS }));
      const pulled = geometry.stringPull(pts, { onWalkable: true });
      const squares2 = pulled.points.map(pt =>
        [Math.round(pt.y / CLIENT_FINENESS - 0.5) + 1,
         Math.round(pt.x / CLIENT_FINENESS - 0.5) + 1]);
      const fallEdges = new Set();
      let prev = { row: fromRow, col: fromCol };
      for (const step of steps) {
        if (Math.abs(step.row - prev.row) > 1 || Math.abs(step.col - prev.col) > 1)
          fallEdges.add(`${prev.row},${prev.col}>${step.row},${step.col}`);
        prev = step;
      }
      return { steps: steps.length, pivots: squares2.length, unverified: pulled.unverified,
               risk: compositionRisk(pulled.proved, squares2), fallEdges };
    };
    const squares = (fromRow, fromCol, key) => {
      const p = baked.routes[key];
      return p == null ? null : [{ row: fromRow, col: fromCol }, ...replay(fromRow, fromCol, p)];
    };
    const west = squares(49, 12, '49,12>35,1');
    const east = squares(35, 1, '35,1>49,12');
    const north = squares(49, 12, '49,12>1,13');
    const materializedWest = bakedPath({ rooms: { 578: baked } }, 578,
      { row: 49, col: 12 }, { row: 35, col: 1 });
    const materializedNorth = bakedPath({ rooms: { 578: baked } }, 578,
      { row: 49, col: 12 }, { row: 1, col: 13 });
    const oldWest = evidence(49, 12, 'aaaaddadddaddwd(-2,-2)cccdcd');
    const oldNorth = evidence(49, 12,
      'aaaaddadddadaaaaddnnadadwddwwcwddaadndadddndadanabbebaaaaanad');
    const westEvidence = evidence(49, 12, baked.routes['49,12>35,1']);
    const northEvidence = evidence(49, 12, baked.routes['49,12>1,13']);
    const name = q => `r${q.row}c${q.col}`;
    const edge = (a, b) => `${name(a)}>${name(b)}`;
    const falls = route => route ? route.slice(1).filter((q, i) =>
      Math.abs(q.row - route[i].row) > 1 || Math.abs(q.col - route[i].col) > 1) : [];
    const invalid = route => route ? route.slice(1).filter((q, i) =>
      !geometry.neighbors(route[i].row, route[i].col, { collision: true })
        .some(n => n.row === q.row && n.col === q.col)) : [];
    const unproved = route => route ? route.slice(1).flatMap((q, i) => {
      const from = route[i];
      if (Math.abs(q.row - from.row) > 1 || Math.abs(q.col - from.col) > 1) return [];
      return geometry.stepAllowedByCollision(from.row, from.col, q.row, q.col) === true
        ? [] : [edge(from, q)];
    }) : [];
    const keys = route => new Set((route ?? []).map(q => `${q.row},${q.col}`));

    ok('both routes out of southwest Cragged are present', !!west && !!north);
    ok('the west rail begins along the safe reverse corridor',
       west?.slice(0, 4).map(name).join(',') === 'r49c12,r48c13,r47c14,r47c15'
         && west.some(q => q.row === 45 && q.col === 18),
       west?.slice(0, 8).map(name).join(','));
    ok('the west rail stays on ordinary ground and every step is a mover edge',
       falls(west).length === 0 && invalid(west).length === 0,
       JSON.stringify({ falls: falls(west).map(name), invalid: invalid(west).map(name) }));
    const eastSet = keys(east), shared = (west ?? []).filter(q => eastSet.has(`${q.row},${q.col}`)).length;
    ok('the two west-corridor directions substantially share the same ground',
       !!west && !!east && shared >= Math.floor(Math.min(west.length, east.length) * 0.7),
       JSON.stringify({ shared, west: west?.length, east: east?.length }));
    ok('neither southwest route uses the fictional wall squares',
       [west, north].every(route => route && !route.some(q =>
         (q.row === 46 && q.col === 15) || (q.row === 45 && q.col === 16))));
    const avoidsWall = route => Array.isArray(route) && !route.some(q =>
      (q.row === 46 && q.col === 15) || (q.row === 45 && q.col === 16));
    ok('the serialized pivot rails also exclude the fictional wall squares',
       ['49,12>35,1', '49,12>1,13'].every(key =>
         avoidsWall(baked.pivots[key]?.squares?.map(([row, col]) => ({ row, col })) ?? null)));
    ok('bakedPath materializes both repaired rails without reintroducing the wall',
       avoidsWall(materializedWest) && avoidsWall(materializedNorth),
       JSON.stringify({ west: materializedWest?.slice(0, 8).map(name),
                        north: materializedNorth?.slice(0, 8).map(name) }));
    ok('only non-terminal ordinary unproved pivots count as composition risk',
       compositionRisk([false], [[1, 1], [1, 2]]) === 0
         && compositionRisk([false, true], [[1, 1], [1, 2], [1, 3]]) === 1
         && compositionRisk([false, true], [[1, 1], [3, 3], [3, 4]]) === 0);
    ok('both repaired rails strictly lower the old composition risk',
       oldWest.risk === 2 && westEvidence.risk === 0
         && oldNorth.risk === 4 && northEvidence.risk < oldNorth.risk,
       JSON.stringify({ west: [oldWest.risk, westEvidence.risk],
                        north: [oldNorth.risk, northEvidence.risk] }));
    ok('the repaired rails introduce no new directed fall',
       [...westEvidence.fallEdges].every(e => oldWest.fallEdges.has(e))
         && [...northEvidence.fallEdges].every(e => oldNorth.fallEdges.has(e)),
       JSON.stringify({ west: [...westEvidence.fallEdges], north: [...northEvidence.fallEdges] }));
    const diameter = Math.max(geometry.rows, geometry.cols);
    ok('the global detour guard admits both repairs within one room diameter per risk removed',
       westEvidence.steps <= oldWest.steps + (oldWest.risk - westEvidence.risk) * diameter
         && westEvidence.pivots <= oldWest.pivots + (oldWest.risk - westEvidence.risk) * diameter
         && northEvidence.steps <= oldNorth.steps + (oldNorth.risk - northEvidence.risk) * diameter
         && northEvidence.pivots <= oldNorth.pivots + (oldNorth.risk - northEvidence.risk) * diameter);
    ok('the north rail does not turn that southern wall into a fall',
       !!north && invalid(north).length === 0 && north.slice(1).every((q, i) => {
         const from = north[i];
         return Math.min(from.row, q.row) < 40
           || (Math.abs(q.row - from.row) <= 1 && Math.abs(q.col - from.col) <= 1);
       }), JSON.stringify({ invalid: invalid(north).map(name), falls: falls(north).map(name) }));
    ok('proof-first materially lowers the remaining unverified evidence',
       baked.pivots['49,12>35,1']?.unverified <= 1
         && baked.pivots['49,12>1,13']?.unverified <= 2
         && unproved(west).length <= 1 && unproved(north).length <= 2,
       JSON.stringify({ westPivot: baked.pivots['49,12>35,1']?.unverified,
                        northPivot: baked.pivots['49,12>1,13']?.unverified,
                        westEdges: unproved(west), northEdges: unproved(north) }));

    const room38 = realMap?.rooms?.['38'] ?? realMap?.rooms?.[38];
    const control = room38 ? bakeRoom(room38) : null;
    ok('a one-edge terminal slide remains byte-for-byte instead of becoming a detour',
       control?.routes?.['6,19>6,18'] === 'w'
         && control?.pivots?.['6,19>6,18']?.unverified === 1,
       JSON.stringify({ route: control?.routes?.['6,19>6,18'],
                        pivot: control?.pivots?.['6,19>6,18'] }));
  }
}


// ------------------------------------------ the live first hop is an execution constraint
// A permissive transit fallback is allowed to distrust an OFFLINE region model. It is not
// allowed to invent an action missing from an authoritative LIVE exit list. The distinction
// matters in room 27: the raw graph declares 2500, but the collision-aware executor offers
// only 587 and 5 from the body that arrived there.
console.log('\nthe executable first hop — hard through fallbacks, local to expansion zero');
{
  const START = 91001, SHORT = 91002, LONG = 91003, MID = 91004, GOAL = 91005;
  const room = (num, destinations) => ({
    num, name: `fixture ${num}`, cls: `Fixture${num}`,
    nameRsc: num, roomRsc: num + 100000, objId: num + 200000,
    edgeExits: [],
    goExits: destinations.map((to, index) => ({
      row: 1, col: index + 1, to, locked: false,
      arriveRow: 1, arriveCol: 1,
    })),
  });
  const map = { rooms: {
    [START]: room(START, [SHORT, LONG]),
    [SHORT]: room(SHORT, [GOAL]),
    [LONG]: room(LONG, [MID]),
    [MID]: room(MID, [GOAL]),
    [GOAL]: room(GOAL, []),
  } };
  const rooms = result => result.hops.map(hop => hop.to);

  const unconstrained = findPath(map, START, GOAL,
    { danger: false, availableFirstHops: null });
  ok('null leaves the first expansion unconstrained',
     unconstrained.found && rooms(unconstrained)[0] === SHORT,
     JSON.stringify(rooms(unconstrained)));

  // Deny every strict in-room transit so the answer MUST come from the loose recursive
  // pass. If that recursion drops the allowlist, BFS takes the unavailable two-hop route.
  const fallback = findPath(map, START, GOAL, {
    danger: false,
    transitOk: () => false,
    availableFirstHops: new Set([LONG]),
  });
  ok('the permissive transit fallback preserves the executable first-hop allowlist',
     fallback.found && fallback.transit_unverified === true
       && rooms(fallback).join(',') === [LONG, MID, GOAL].join(','),
     JSON.stringify({ rooms: rooms(fallback), unverified: fallback.transit_unverified }));

  const none = findPath(map, START, GOAL,
    { danger: false, availableFirstHops: new Set() });
  ok('an authoritative empty allowlist means there is no executable route',
     none.found === false, JSON.stringify(none));

  // World.route is the producer. A published but all-false destination remains a SOFT
  // block: prefer the verified longer way when it exists. Count the call too; two reads can
  // span different ROOM_CONTENTS generations and must not be combined.
  const client = {
    roomNameRsc: START,
    roomRsc: START + 100000,
    room: { id: START + 200000, objects: new Map() },
    selfId: 1,
    self: { id: 1, row: 1, col: 1 },
    rsc: { get: () => '' },
  };
  const world = new World(client, map);
  Object.defineProperty(world, 'geometry', { value: { inBounds: () => true } });
  world.origin = () => client.self;
  world.transitOk = () => () => true;
  let exitReads = 0;
  world.exits = () => {
    exitReads++;
    return [
      { kind: 'go', to: SHORT, row: 1, col: 1, reachable: false, verified: false },
      { kind: 'go', to: LONG, row: 1, col: 2, reachable: true, verified: true },
    ];
  };
  const wired = world.route(GOAL);
  ok('World.route caches one authoritative read and avoids an all-false direct hop',
     exitReads === 1 && wired.found && wired.hops[0]?.to === LONG,
     JSON.stringify({ exitReads, found: wired.found, first: wired.hops[0]?.to }));

  // A self/origin pair outside the current RoomGeometry is the characteristic stale
  // ROOM_CONTENTS case. Its empty exits() answer is not authoritative and must fail open
  // to the raw graph rather than manufacturing an empty hard allowlist.
  const staleWorld = new World(client, map);
  Object.defineProperty(staleWorld, 'geometry', { value: { inBounds: () => false } });
  staleWorld.origin = () => client.self;
  staleWorld.transitOk = () => null;
  let staleExitReads = 0;
  staleWorld.exits = () => { staleExitReads++; return []; };
  const staleRoute = staleWorld.route(GOAL);
  ok('an out-of-bounds origin is not authority for a hard empty allowlist',
     staleExitReads === 0 && staleRoute.found && staleRoute.hops[0]?.to === SHORT,
     JSON.stringify({ exitReads: staleExitReads, found: staleRoute.found,
                      first: staleRoute.hops[0]?.to }));

  // `origin()` can project a stale raw position back onto nearby floor. That projection is
  // useful for ordinary reachability, but it cannot turn previous-room coordinates into
  // authority for a hard absence claim about this room's exits.
  const projectedClient = {
    ...client,
    self: { ...client.self, row: 99, col: 99 },
  };
  const projectedWorld = new World(projectedClient, map);
  Object.defineProperty(projectedWorld, 'geometry', { value: {
    inBounds: (row, col) => row === 1 && col === 1,
    walkable: () => false,
    nearestWalkable: () => ({ row: 1, col: 1 }),
  } });
  projectedWorld.transitOk = () => null;
  let projectedExitReads = 0;
  projectedWorld.exits = () => { projectedExitReads++; return []; };
  const projectedRoute = projectedWorld.route(GOAL);
  ok('a projected in-bounds origin does not authorize exits for an out-of-bounds raw self',
     projectedExitReads === 0 && projectedRoute.found
       && projectedRoute.hops[0]?.to === SHORT,
     JSON.stringify({ exitReads: projectedExitReads, found: projectedRoute.found,
                      first: projectedRoute.hops[0]?.to }));

  // But that soft block must still fall through when it is the only executable answer. The
  // hard allowlist survives the loose recursion, so proving this also proves that the
  // all-false offered destination was INCLUDED rather than mistaken for an absent one.
  const fallbackMap = { rooms: {
    [START]: room(START, [SHORT]),
    [SHORT]: room(SHORT, [GOAL]),
    [GOAL]: room(GOAL, []),
  } };
  const fallbackClient = {
    ...client,
    room: { id: START + 200000, objects: new Map() },
  };
  const fallbackWorld = new World(fallbackClient, fallbackMap);
  Object.defineProperty(fallbackWorld, 'geometry', { value: { inBounds: () => true } });
  fallbackWorld.origin = () => fallbackClient.self;
  fallbackWorld.transitOk = () => null;
  fallbackWorld.exits = () => [
    { kind: 'go', to: SHORT, row: 1, col: 1, reachable: false, verified: false },
  ];
  const softFallback = fallbackWorld.route(GOAL);
  ok('an all-false published hop remains executable through the loose fallback',
     softFallback.found && softFallback.hops[0]?.to === SHORT,
     JSON.stringify({ found: softFallback.found, first: softFallback.hops[0]?.to }));
}

{
  const START = 91101, ALLOWED = 91102, LATER = 91103, GOAL = 91104;
  const room = (num, destinations) => ({
    num, name: `re-entry fixture ${num}`, cls: `Reentry${num}`,
    edgeExits: [],
    goExits: destinations.map((to, index) => ({
      row: 1, col: index + 1, to, locked: false,
      arriveRow: 1, arriveCol: 1,
    })),
  });
  const map = { rooms: {
    [START]: room(START, [ALLOWED, LATER]),
    [ALLOWED]: room(ALLOWED, [START]),
    [LATER]: room(LATER, [GOAL]),
    [GOAL]: room(GOAL, []),
  } };
  const reentered = findPath(map, START, GOAL, {
    danger: false,
    transitOk: () => true,
    availableFirstHops: new Set([ALLOWED]),
  });
  const path = reentered.hops.map(hop => hop.to);
  ok('the allowlist applies only initially and does not block a later re-entry expansion',
     reentered.found && path.join(',') === [ALLOWED, START, LATER, GOAL].join(','),
     JSON.stringify(path));
}

// The preserved production fixture. This is the raw/live disagreement that made four
// mainland -> Ko'catan legs stop in the Icky Cave: west -> 2500 exists in m59-map.json but
// has no collision-reachable live candidate from the room's body.
{
  const realMap = existsSync(MAP_ON_DISK) ? loadMap() : null;
  const cave = realMap?.rooms?.['27'] ?? realMap?.rooms?.[27];
  if (!cave?.roo) {
    skip('room 27 refuses a route to 2001 when 2500 is not offered',
         'no room 27 collision fixture on disk');
  } else {
    const self = { id: 1, row: 57, col: 45 };
    const client = {
      roomNameRsc: cave.nameRsc,
      roomRsc: cave.roomRsc,
      room: { id: cave.objId, objects: new Map([[self.id, self]]) },
      selfId: self.id,
      self,
      rsc: { get: () => '' },
    };
    const world = new World(client, realMap);
    const offered = [...new Set(world.exits()
      .filter(exit => exit.to != null).map(exit => Number(exit.to)))].sort((a, b) => a - b);
    const route = world.route(2001);
    ok('room 27 live exits offer 5 and 587 but not the stranded 2500 boundary',
       offered.includes(5) && offered.includes(587) && !offered.includes(2500),
       JSON.stringify(offered));
    ok('room 27 therefore refuses the raw-graph route to 2001',
       route.found === false, JSON.stringify(route));
  }
}


console.log('');
console.log('A HOP CAN BE BANNED — BUT ONLY BY WHOEVER IS DRIVING');
{
  // `blockedHops` is a real thing to want — a road somebody is being hunted on, an exit under
  // a guard — and `findPath` has honoured it all along. What it must NOT be is something the
  // walker discovers about itself mid-journey.
  //
  // It was, briefly, and it cascaded: a crossing that landed in the wrong room banned the hop,
  // and in one leg ten of those banned SIX GOOD HOPS — 586->585, 50->61, 587->576, 587->597,
  // 586->596, 586->50. The first hop of a perfectly good road out of Tos, the way BACK to
  // Tos, and both ways onward from the Main gate. The router had almost nothing left and set
  // off for the border of the Badlands; hops that took twenty seconds started taking four
  // hundred. None of those edges is false — the body drifts across a boundary whose exit is
  // chosen by ROW and fires the neighbour's door.
  //
  // So the set stays, the automatic learning is gone, and a ban comes from whoever is driving:
  // explicit, and temporary.
  const map = loadMap();
  const roomsPresent = [586, 587, 596, 597, 598].every(n => map?.rooms?.[n] || map?.rooms?.[String(n)]);
  if (!roomsPresent) {
    // NOTHING TO CHECK is not a pass. Say so rather than reporting a green line about a
    // map this checkout does not have.
    console.log('  --   skipped: this map does not carry rooms 586/587/596/597/598');
  } else {
    const plain = findPath(map, 586, 598, {});
    const viaPlain = plain.found ? plain.hops.map(h => h.to) : null;
    ok('a route from the Tos gate to 598 exists at all', plain.found, JSON.stringify(viaPlain));

    const rerouted = findPath(map, 586, 598, { blockedHops: new Set(['587>597']) });
    const viaRe = rerouted.found ? rerouted.hops.map(h => h.to) : null;
    ok('and it still exists with the 587 -> 597 crossing blocked',
       rerouted.found, JSON.stringify(viaRe));
    ok('but it no longer goes through that crossing',
       !!viaRe && !viaRe.some((to, n) => to === 597 && (n === 0 ? 586 : viaRe[n - 1]) === 587),
       JSON.stringify(viaRe));
    // THE POINT: there is another way of the same length — 596 — so blocking the bad hop
    // costs nothing. A journey that has watched the crossing fail takes it immediately.
    // AND A WRONG-ROOM LANDING NEVER PUTS ANYTHING IN THAT SET ITSELF. Candidate-set
    // exhaustion now blocks one exact hop for one journey; this older `badHops` mechanism
    // learned from landing somewhere unexpected and poisoned good crossings.
    // BOTH SIDES OF THE SPLIT. The journey loop moved to m59-game.mjs, so reading only
    // m59-broker.mjs made this negative assertion pass on an empty haystack.
    const walker = [new URL('./m59-game.mjs', import.meta.url),
                    new URL('./m59-broker.mjs', import.meta.url)]
      .map(u => { try { return readFileSync(u, 'utf8'); } catch { return ''; } }).join('\n');
    ok('the journey loop no longer learns hop bans from wrong-room landings',
       !/badHops/.test(walker), 'badHops');
    ok('while route() still accepts them from a caller', /blockedHops/.test(walker));
    ok('it goes by the Outskirts of Tos instead, which is the same number of hops',
       !!viaRe && viaRe.includes(596) && viaRe.length <= (viaPlain?.length ?? 0) + 1,
       JSON.stringify({ plain: viaPlain, rerouted: viaRe }));
  }
}


console.log('');
console.log('A BOUNDARY CAN CARRY TWO EXITS, AND THE ROW DECIDES WHICH ONE FIRES');
{
  // This is the shape that cost every journey a wasted excursion, and it is ordinary map
  // data rather than anything exotic. The Western border of the Twisted Wood publishes two
  // exits on ONE edge, separated by a condition the server evaluates on the crossing row:
  //
  //     east -> 586  Main gate to the city of Tos   when row < 19
  //     east -> 597  The Twisted Wood               when row > 20
  //
  // Both anchors are therefore ON the boundary and only nineteen rows apart, and standing on
  // the wrong one and slipping a single square east does not waste a step — it goes to the
  // wrong room. "crossed into 586 instead of 597", every journey, on a crossing that is
  // perfectly good.
  const map = loadMap();
  const room = map?.rooms?.[587] ?? map?.rooms?.['587'];
  if (!room) {
    console.log('  --   skipped: this map does not carry room 587');
  } else {
    const east = (room.edgeExits ?? []).filter(e => (e.leaveName ?? '') === 'east');
    ok('room 587 really does publish two exits on its east edge', east.length === 2,
       JSON.stringify(east.map(e => ({ to: e.to, cond: e.condition }))));
    const toTos = east.find(e => Number(e.to) === 586);
    const toWood = east.find(e => Number(e.to) === 597);
    ok('one of them is the Tos gate, gated on a LOW row',
       toTos?.condition?.name === 'row<' && toTos.condition.threshold === 19,
       JSON.stringify(toTos?.condition));
    ok('and the other is the Twisted Wood, gated on a HIGH row',
       toWood?.condition?.name === 'row>' && toWood.condition.threshold === 20,
       JSON.stringify(toWood?.condition));

    // AND THE SERVER'S OWN ORDERED SCAN AGREES ABOUT EACH ANCHOR. `selectedEdgeAt` simulates
    // StandardLeaveDir, so this is the same question the server answers on the crossing step.
    const atTos  = selectedEdgeAt(room, 'east', { row: 9,  col: 67 });
    const atWood = selectedEdgeAt(room, 'east', { row: 46, col: 67 });
    ok('crossing east at row 9 fires the exit to Tos', Number(atTos?.to) === 586, JSON.stringify(atTos?.to));
    ok('crossing east at row 46 fires the exit to the Twisted Wood',
       Number(atWood?.to) === 597, JSON.stringify(atWood?.to));

    // THE BUG THIS PINS. The baked line to 597 starts AT the Tos anchor, because railAcross
    // picks the nearest other anchor — so getting on used to mean standing in the doorway to
    // the room we did not want. There is no false route here and nothing to blacklist; the
    // fix is to board one square inland.
    const baked = JSON.parse(readFileSync(new URL('../substrate/m59-routes.json', import.meta.url), 'utf8'));
    ok('the line to the Twisted Wood is baked from the Tos anchor, which is why boarding matters',
       !!baked?.rooms?.['587']?.routes?.['9,67>46,67']);
  }
}


console.log('');
console.log('ARRIVING NEXT TO A DOOR IS ARRIVING IN IT — THE MARGIN HAS TO BE MORE THAN ZERO');
{
  // The whole failure in one line of map data: entering the Western border of the Twisted
  // Wood from the Main gate to the city of Tos puts the character at row 8, column 66, in a
  // room 55 rows by 67 columns. The east boundary is ONE square away, and it carries two
  // exits split on the crossing row — row < 19 goes back to Tos, row > 20 goes on to the
  // Twisted Wood. Row 8 is in the first band.
  //
  // So the body arrives one slide from the door it just came through, and the tracer shows
  // it: 586->587 followed immediately by 587->586. Stepping merely OFF the boundary does
  // nothing here, because the arrival square is already off it. That bounce cost a 44s
  // excursion plus a 195s reroute through the Outskirts, every single journey.
  const map = loadMap();
  const from = map?.rooms?.[586] ?? map?.rooms?.['586'];
  const into = map?.rooms?.[587] ?? map?.rooms?.['587'];
  if (!from || !into) {
    console.log('  --   skipped: this map does not carry rooms 586/587');
  } else {
    const west = (from.edgeExits ?? []).find(e => (e.leaveName ?? '') === 'west' && Number(e.to) === 587);
    ok('the Tos gate really does drop us into 587', !!west, JSON.stringify(west));
    ok('and it lands at row 8, column 66',
       west?.arriveRow === 8 && west?.arriveCol === 66,
       JSON.stringify({ row: west?.arriveRow, col: west?.arriveCol }));

    const cols = Number(into.cols ?? into.roo?.cols ?? 0);
    ok('which is ONE square from that east boundary',
       cols - Number(west?.arriveCol ?? 0) === 1, JSON.stringify({ cols, at: west?.arriveCol }));

    // And crossing east from the arrival ROW fires the exit we just came through.
    const fires = selectedEdgeAt(into, 'east', { row: west.arriveRow, col: cols });
    ok('so a slide east from the arrival row goes straight back to the Tos gate',
       Number(fires?.to) === 586, JSON.stringify(fires?.to));

    // ...whereas the door we actually want is nineteen rows further south.
    const wanted = selectedEdgeAt(into, 'east', { row: 46, col: cols });
    ok('while the door we want needs row 46', Number(wanted?.to) === 597, JSON.stringify(wanted?.to));

    // THE MARGIN. One square of clearance still leaves the body on col 66 — the arrival
    // square itself — so it has to be at least two before a single slide stops mattering.
    ok('a margin of one would not have moved it at all',
       cols - Number(west.arriveCol) <= 1);
    const src = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
    ok('so the broker asks for more than one square of clearance',
       /INLAND_MARGIN[\s\S]{0,80}\|\| 2\)/.test(src) || /INLAND_MARGIN_SQUARES = Number\([^)]*\|\| 2\)/.test(src),
       'INLAND_MARGIN_SQUARES');
  }
}


console.log('');
console.log('SAME NUMBER OF ROOMS IS NOT THE SAME JOURNEY');
{
  // `findPath` counts ROOMS, so two routes of equal length were indistinguishable and it
  // returned whichever exit order reached the destination first. On the ground they are not
  // equal at all: crossing a room is tens of squares of walking, and the baked table already
  // knows how many for every exit pair.
  //
  // Tos to Castle Victoria, both ways seven rooms:
  //   via the Main gate   587 Western border of the Twisted Wood  65 steps   total 310
  //   via East Ende       596 Outskirts of Tos                    55 steps   total 298
  const map = loadMap();
  const have = [50, 61, 586, 587, 596, 597].every(n => map?.rooms?.[n] || map?.rooms?.[String(n)]);
  if (!have) {
    console.log('  --   skipped: this map does not carry the Tos rooms');
  } else {
    const baked = JSON.parse(readFileSync(new URL('../substrate/m59-routes.json', import.meta.url), 'utf8'));
    const anchorTo = (room, to) => {
      const a = (baked.rooms[String(room)]?.anchors ?? []).filter(x => Number(x.to) === Number(to));
      return a.find(x => x.from_body) ?? a[0] ?? null;
    };
    const cost = (room, cameFrom, goingTo) => {
      const inA = anchorTo(room, cameFrom), outA = anchorTo(room, goingTo);
      if (!inA || !outA) return null;
      const p = baked.rooms[String(room)]?.routes?.[`${inA.row},${inA.col}>${outA.row},${outA.col}`];
      return typeof p === 'string' ? p.length : null;
    };
    // Both routes exist and are the same length, which is what makes this a TIE rather than
    // a preference — the planner is not being asked to accept a longer road.
    const viaBorder = findPath(map, 586, 598, { blockedHops: new Set(['586>596']) });
    const viaOutskirts = findPath(map, 586, 598, { blockedHops: new Set(['586>587']) });
    ok('both ways out of the Tos gate reach the Cragged Mountains',
       viaBorder.found && viaOutskirts.found);
    ok('and they are the same number of rooms',
       viaBorder.hops.length === viaOutskirts.hops.length,
       JSON.stringify({ border: viaBorder.hops.map(h => h.to), outskirts: viaOutskirts.hops.map(h => h.to) }));

    // WITH NO COST FUNCTION THE PLANNER IS UNCHANGED — that is the safety property. It can
    // only ever choose between equals, never accept a longer road.
    const blind = findPath(map, 586, 598, {});
    ok('a planner with no cost function still returns a route of that length',
       blind.found && blind.hops.length === viaBorder.hops.length);

    // AND WITH ONE, IT TAKES THE SHORTER WALK.
    // A TRANSIT PREDICATE IS WHAT MAKES THE STATE (ROOM, DOOR YOU CAME IN BY). Without one
    // the search keys on the room alone, so the first approach to the Twisted Wood closes it
    // off for the second and the alternative is never even considered — which is a property
    // of the search, not of the map. The broker always supplies one; a fixture that omits it
    // is testing a configuration the fleet never runs.
    const noOpinion = () => null;
    const costed = findPath(map, 586, 598, { crossCost: cost, transitOk: noOpinion });
    const through = costed.hops.map(h => h.to);
    ok('given the baked crossing lengths it goes by the Outskirts of Tos',
       through.includes(596) && !through.includes(587), JSON.stringify(through));
    ok('and it reports what the walk cost', Number.isFinite(costed.walk_cost), String(costed.walk_cost));
  }
}


console.log('');
console.log('A SPLIT BOUNDARY HAS SQUARES THAT LEAD SOMEWHERE ELSE, AND THEY ARE KNOWN IN ADVANCE');
{
  // The failure this ends, measured in one leg: `587 -> 597` reported the crossing and landed
  // in 586 THIRTEEN CONSECUTIVE TIMES, a hundred and eighty seconds in one room without ever
  // leaving it. Keeping AWAY from the boundary was the wrong shape of fix, because the
  // arrival square is already beside it — a character entering from Tos lands at 8,66, one
  // column from an edge whose row<19 band is the door back to Tos.
  //
  // `selectedEdgeAt` simulates the server's own ordered scan, so which squares fire which
  // door is knowable before the walk starts. They are few, and the router can route around
  // them.
  const map = loadMap();
  const room = map?.rooms?.[587] ?? map?.rooms?.['587'];
  if (!room) { console.log('  --   skipped: this map does not carry room 587'); }
  else {
    const W = await import('./m59-world.mjs');
    const w = Object.create(W.World.prototype);
    w.map = map;
    Object.defineProperty(w, 'room', { value: { num: 587 }, configurable: true });
    Object.defineProperty(w, 'geometry', { value: { rows: 55, cols: 67 }, configurable: true });

    const avoid = w.wrongExitSquares({ direction: 'east', to: 597 });
    ok('heading east to the Twisted Wood, some of that edge is off limits', avoid.size > 0, String(avoid.size));
    ok('the band that fires the Tos door is avoided', avoid.has('8,67'), '8,67');
    ok('including the row we ARRIVE on from Tos', avoid.has('8,67') && avoid.has('18,67'));
    // THE DOOR WE WANT IS NOT AVOIDED. A guard that blocked the destination would be worse
    // than the bug.
    ok('and the door we actually want stays open', !avoid.has('46,67'), '46,67');
    ok('as does everything past the threshold', !avoid.has('21,67') && !avoid.has('55,67'));

    // AN ORDINARY BOUNDARY COSTS NOTHING. Only a split edge has anything to avoid.
    const plain = w.wrongExitSquares({ direction: 'west', to: 576 });
    ok('a boundary carrying one exit yields nothing to avoid', plain.size === 0, String(plain.size));

    // The inland strip is where a slide starts AND where the baked line runs, so it is opt-in.
    const withInland = w.wrongExitSquares({ direction: 'east', to: 597 }, { includeInland: true });
    ok('the inland strip is available but not the default', withInland.size > avoid.size);
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
