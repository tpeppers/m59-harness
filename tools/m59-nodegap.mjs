#!/usr/bin/env node
// WHAT IS MISSING FROM OUR MAP THAT WOULD PUT A CHARACTER ON EACH MANA STONE.
//
//   node tools/m59-nodegap.mjs                 every stone, the gap, and what would close it
//   node tools/m59-nodegap.mjs --node cave     one stone, with the candidate jumps listed
//   node tools/m59-nodegap.mjs --json          for a script
//
// "UNREACHABLE" IS A FACT ABOUT `substrate/m59-falljumps.json`, NOT ABOUT THE WORLD, and
// CLAUDE.md now says so outright. Every mana node stands where a person can walk to it in
// the retail client — they are easter eggs and players get them. So a stone the mover cannot
// reach means our model is missing an affordance: a jump, a ramp, a trigger, a passage. The
// errand is naming WHICH, and this is the tool that does the naming.
//
// The proof that this is the right frame, and the reason this file exists: room 27 was
// measured unreachable four different ways — a coarse flood, a fine flood, `route_fine`
// answering "no route within 4 jumps", and a live body that stopped eight squares out — on a
// night the operator had ALREADY MELDED IT. Not one of those measurements was wrong. Every
// one of them was a statement about the model.
//
// WHAT IT REPORTS PER STONE, and why each column earns its place:
//
//   room / routable   can the world graph even get a body into the room? A stone in a room
//                     with no inbound route is a DIFFERENT problem from one on a ledge.
//   walk gap          how close the mover gets, in Chebyshev squares, from the square a body
//                     actually LANDS ON coming in — against a meld box of 2 per axis. This is
//                     the number that says whether the gap is a rounding error or a cliff.
//   declared falls    what `m59-falljumps.json` says about that room. THE COLUMN THAT
//                     PREDICTS REACHABILITY IS NOT THE TERRAIN — it is whether somebody wrote
//                     the jump down.
//   candidates        pairs (take-off, landing) where a body could stand, the landing is
//                     inside the meld box, the drop is DOWNWARD (a fall, not a climb), and
//                     the span is jumpable. These are what a person would be asked to confirm.
//
// A CANDIDATE IS A QUESTION, NEVER AN ANSWER. `m59-falljumps.json` is operator-supplied and
// WALKED — somebody stood on the ledge and made the jump — and the file says so in its own
// header for a reason: inventing a fall that cannot be made is how a region gets reported as
// connected when it is not. So this prints candidates to be CONFIRMED, and writes nothing.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMap, movementMapFile, CHECKED_MAP_FILE } from './m59-map.mjs';
import { routesFor, attachStepMasks, reachableFrom, stepMaskCurrent } from './m59-routes.mjs';
import { sharedRoomGeometry } from './m59-roo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const flag = (n, d = null) => {
  const at = argv.indexOf('--' + n);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
};

const sq = (row, col) => `r${row}c${col}`;
const cheb = (a, b) => Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));

// mananode.kod:17 — MANANODE_RANGE is 3 and the test is exclusive per axis, so a body is in
// range at Chebyshev 2 or less. Sixteen squares finish the errand, not one.
const MELD_BOX = 2;

// The stones, in the KOD's own order — ROW FIRST. `tools/m59-mananode.mjs` and
// `tools/fleetscripts/mana-node.mjs` carry the same table; these are the only places this
// transposition is allowed to be got wrong.
export const NODES = Object.freeze({
  cave:      { room: 27,   node: 'NODE_ORCCAVES', row: 23, col: 53, where: 'A Deep, Dark, Spooky, Icky Cave' },
  victoria:  { room: 39,   node: 'NODE_VICTORIA', row: 13, col: 46, where: 'Upstairs in Castle Victoria' },
  badlands:  { room: 45,   node: 'NODE_BADLANDS', row: 63, col: 46, where: 'The Badlands' },
  peak:      { room: 515,  node: 'NODE_A5',       row: 20, col: 17, where: "Seafarer's Peak" },
  sentinel:  { room: 589,  node: 'NODE_H9',       row: 45, col: 32, where: 'Under the shadow of the Sentinel' },
  ice:       { room: 750,  node: 'NODE_ICECAVE1', row: 25, col: 23, where: 'The Dreaded Caves of Ice' },
  mausoleum: { room: 1006, node: 'NODE_GUEST',    row: 35, col:  5, where: 'Mausoleum' },
});

/** The declared falls for a room, read rather than derived. */
export function declaredFalls(room, repo = REPO) {
  try {
    const j = JSON.parse(readFileSync(join(repo, 'substrate', 'm59-falljumps.json'), 'utf8'));
    return (j.jumps || []).filter(x => Number(x.room) === Number(room));
  } catch { return []; }
}

/** Every square a body can LAND ON coming into this room, deduped by neighbour and square. */
export function arrivalsInto(map, roomNum) {
  const out = [], seen = new Set();
  for (const [id, r] of Object.entries(map.rooms)) {
    const add = (row, col, kind) => {
      const k = `${id}:${row},${col}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ from: Number(id), fromName: r.name, kind, row, col });
    };
    for (const e of (r.edgeExits ?? []))
      if (Number(e.to) === Number(roomNum)) add(e.arriveRow, e.arriveCol, 'edge');
    for (const g of (r.goExits ?? []))
      if (Number(g.to) === Number(roomNum)) add(g.arriveRow, g.arriveCol, 'go');
  }
  return out;
}

/**
 * CANDIDATE FALLS INTO THE MELD BOX.
 *
 * A fall is the affordance the mover cannot express: the one vertical rule it has gates
 * CLIMBING (`MAX_STEP_HEIGHT`), so a drop of any size is refused as a step however short the
 * span. That is exactly the shape of every stone we cannot reach.
 *
 * So: for every square a body CAN stand on, and every square inside the meld box, offer the
 * pair when the landing is BELOW the take-off (a fall, never a climb) and the span is short
 * enough to be one. Height comes from the BSP at the square's own stand point — the fine grid
 * is the reality and a square is a summary — and the pair is offered for a person to walk,
 * not written anywhere.
 */
export function candidateFalls(geo, reach, goal, { maxSpan = 6, maxStep = 384 } = {}) {
  const floorAt = (row, col) => {
    try {
      const p = geo.standPoint(row, col);
      return p ? geo.floorBaseAtClient(p.x, p.y) : null;
    } catch { return null; }
  };
  // Every square inside the box that a body could actually stand on.
  const landings = [];
  for (let dr = -MELD_BOX; dr <= MELD_BOX; dr++)
    for (let dc = -MELD_BOX; dc <= MELD_BOX; dc++) {
      const row = goal.row + dr, col = goal.col + dc;
      let standable = false;
      try { standable = geo.standable(row, col); } catch { standable = false; }
      if (!standable) continue;
      const h = floorAt(row, col);
      if (h != null) landings.push({ row, col, floor: h });
    }
  if (!landings.length) return { landings: [], candidates: [], why: 'no standable square inside the meld box' };

  const out = [];
  for (const key of reach) {
    const [row, col] = key.split(',').map(Number);
    for (const land of landings) {
      const span = cheb({ row, col }, land);
      if (span === 0 || span > maxSpan) continue;
      const from = floorAt(row, col);
      if (from == null) continue;
      // BOTH DIRECTIONS, AND THE DIRECTION IS THE FINDING.
      //
      // This asked for DOWNWARD pairs only, on the assumption that the missing affordance is
      // a fall — because `m59-falljumps.json` is the only affordance this repository can
      // declare. Measured 2026-09-10 across every stone the mover cannot reach, that
      // assumption is FALSE IN EVERY CASE: the stone is ABOVE the nearest reachable ground.
      //
      //   cave     +384   badlands +1664   peak +5024   sentinel +3984   ice +512
      //
      // So the errand was never "find the fall nobody wrote down". It is "find the CLIMB",
      // and 384 is `MAX_STEP_HEIGHT` — the one vertical rule the mover has, and it gates
      // climbing. A rise inside that cap is a step the mover should already take; a rise past
      // it needs an affordance this repository cannot currently express at all.
      const rise = land.floor - from;
      out.push({ from: { row, col, floor: from }, to: land, span, rise,
                 // THREE KINDS, NOT TWO, AND THE THIRD ONE IS THE ONE WE CANNOT DECLARE.
                 // A LEVEL gap — same floor, a few squares apart, nothing in between a body
                 // can stand on — is neither a climb nor a fall. `m59-falljumps.json` is a
                 // file of FALLS; it has no way to say "jump across". Room 27's best
                 // candidate is exactly this: r26c57 -> r23c54, three squares, zero rise.
                 kind: rise > 0 ? 'climb' : rise < 0 ? 'fall' : 'level',
                 withinStepCap: Math.abs(rise) <= maxStep });
    }
  }
  // Easiest first: a rise the step cap already allows, then the shortest span, then the
  // smallest rise — which is the order a person would try them in.
  out.sort((a, b) => (b.withinStepCap - a.withinStepCap) || a.span - b.span ||
                     Math.abs(a.rise) - Math.abs(b.rise));
  return { landings, candidates: out, why: null };
}

function reportFor(map, table, key) {
  const spot = NODES[key];
  const room = map.rooms[String(spot.room)];
  if (!room) return { key, ...spot, error: `room ${spot.room} is not in the map` };

  const geo = sharedRoomGeometry(room);
  const arrivals = arrivalsInto(map, spot.room);
  const falls = declaredFalls(spot.room);

  let best = null, reachUnion = new Set(), anyStandable = null;
  for (const a of arrivals) {
    const seen = reachableFrom(map, spot.room, a.row, a.col);
    if (!seen) { a.standable = false; continue; }
    a.standable = true;
    anyStandable = anyStandable ?? a;
    for (const k of seen) reachUnion.add(k);
    let near = null;
    for (const k of seen) {
      const [r, c] = k.split(',').map(Number);
      const d = cheb({ row: r, col: c }, spot);
      if (!near || d < near.away) near = { row: r, col: c, away: d };
    }
    a.nearest = near;
    a.reaches = near ? near.away <= MELD_BOX : false;
    if (!best || (near && near.away < best.away)) best = near;
  }

  const reachable = arrivals.some(a => a.reaches);
  const { landings, candidates, why } = reachUnion.size
    ? candidateFalls(geo, reachUnion, spot)
    : { landings: [], candidates: [], why: 'nothing arrives in this room that can stand' };

  return {
    key, ...spot, routable: arrivals.length > 0, arrivals, declaredFalls: falls,
    reachable, gap: best ? best.away : null, nearest: best,
    boxLandings: landings.length, candidates: candidates.slice(0, 8),
    candidateCount: candidates.length, whyNoCandidates: why,
  };
}

/** The one sentence that says what is missing, which is the whole point of the report. */
export function missingAffordance(r) {
  if (r.error) return r.error;
  if (!r.routable)
    return 'NO INBOUND ROUTE AT ALL — the world graph has no exit into this room. The missing ' +
           'affordance is a TRIGGER or a passage, not a jump. Room 27 was this until the bake ' +
           'learned h7.kod\'s region exit.';
  if (r.reachable)
    return 'nothing — the mover can already stand inside the meld box. If a live attempt still ' +
           'fails, the obstacle is BODIES or the last-twelve-squares mover, not the map.';
  if (!r.boxLandings)
    return 'NO STANDABLE SQUARE INSIDE THE MELD BOX at all, which is a geometry question ' +
           'before it is a routing one — re-measure the box at fine resolution before ' +
           'declaring anything.';
  if (r.declaredFalls.length && r.gap != null)
    return `${r.gap} squares short WITH ${r.declaredFalls.length} fall(s) already declared here ` +
           `— so the declared ones do not bridge THIS gap. Another jump, or a different ` +
           `approach, is missing.`;
  const best = r.candidates[0];
  if (!best)
    return `${r.gap} squares short, and no take-off within ${6} squares of the box that a body ` +
           `can even stand on. The gap is too wide for a jump of any kind — look for a ramp, a ` +
           `door or a trigger.`;
  if (best.kind === 'level')
    return `${r.gap} squares short, and the closest pair is LEVEL — ` +
           `${sq(best.from.row, best.from.col)} to ${sq(best.to.row, best.to.col)}, ` +
           `${best.span} squares apart at the SAME floor height, with nothing standable ` +
           `between them. That is a jump across a gap, and it is the one affordance this ` +
           `repository cannot express at all: substrate/m59-falljumps.json declares FALLS, ` +
           `and a level jump has no drop to declare. A player makes this jump without ` +
           `thinking about it.`;
  if (best.kind === 'climb' && best.withinStepCap)
    return `${r.gap} squares short, and the stone is only ${best.rise} units ABOVE the nearest ` +
           `ground a body can stand on — INSIDE the ${384} step cap. A step this size is one ` +
           `the mover should already take, so the refusal is a BUG rather than a missing ` +
           `affordance. Measure the fine floor at ${sq(best.from.row, best.from.col)} and ` +
           `${sq(best.to.row, best.to.col)} before believing either number.`;
  if (best.kind === 'climb')
    return `${r.gap} squares short, and the stone is ${best.rise} units ABOVE the nearest ` +
           `standable ground — past the ${384} step cap, so no step can reach it. THE MISSING ` +
           `AFFORDANCE IS A CLIMB, and this repository cannot declare one: ` +
           `substrate/m59-falljumps.json holds FALLS only. Either a staircase of treads each ` +
           `inside the cap exists and the walker cannot spell it, or the way up is somewhere ` +
           `else entirely.`;
  return `${r.gap} squares short and NO fall declared in this room. ${r.candidateCount} ` +
         `candidate pair(s) below — walk one and, if it works, add it to ` +
         `substrate/m59-falljumps.json.`;
}

function main() {
  const mapFile = has('checked') ? CHECKED_MAP_FILE : movementMapFile();
  const map = loadMap(mapFile);
  const table = routesFor(map.geometryManifestSha256);
  if (!table) {
    console.log('REFUSING: the baked routing table was not built from the map this checkout ' +
                'moves on.\n  map ' + mapFile + '\n  Try --checked, or rebake with ' +
                '`node tools/setup.mjs routes`.');
    process.exit(2);
  }
  if (!stepMaskCurrent(table))
    console.log('WARNING: this table carries no current step mask — it is a picture of a map ' +
                'the fleet is not walking on.\n');
  attachStepMasks(map);

  const only = flag('node', null);
  const keys = only ? [only.toLowerCase()] : Object.keys(NODES);
  for (const k of keys) if (!NODES[k]) { console.log(`no node called "${k}"`); process.exit(2); }

  const rows = keys.map(k => reportFor(map, table, k));
  if (has('json')) { console.log(JSON.stringify(rows, null, 1)); return; }

  console.log('WHAT IS MISSING FROM THE MAP, PER MANA STONE');
  console.log('the meld box is ' + MELD_BOX + ' squares per axis, so "gap" is how far OUTSIDE it ' +
              'the mover stops\n');
  for (const r of rows) {
    console.log(`${'='.repeat(78)}\n${r.key.toUpperCase()}  —  room ${r.room}, ${r.where}, stone at ${sq(r.row, r.col)}`);
    if (r.error) { console.log('  ' + r.error); continue; }
    console.log(`  routable: ${r.routable ? r.arrivals.length + ' inbound arrival(s)' : 'NO — nothing in the world graph leads here'}`);
    for (const a of r.arrivals) {
      if (!a.standable) { console.log(`    from ${a.from} lands ${sq(a.row, a.col)} — NOT STANDABLE (position and geometry may be from different rooms)`); continue; }
      console.log(`    from ${String(a.from).padEnd(5)} ${String(a.fromName).slice(0, 28).padEnd(29)}` +
                  `lands ${sq(a.row, a.col).padEnd(9)} ` +
                  (a.reaches ? 'REACHES THE BOX'
                             : `closest ${sq(a.nearest.row, a.nearest.col)}, ${a.nearest.away} out`));
    }
    console.log(`  declared falls here: ${r.declaredFalls.length
      ? r.declaredFalls.map(f => `${sq(f.from.row, f.from.col)} -> ${sq(f.to.row, f.to.col)} (${f.observed_by})`).join('; ')
      : 'NONE'}`);
    console.log(`  standable squares inside the meld box: ${r.boxLandings}`);
    console.log('\n  WHAT IS MISSING:');
    for (const line of String(missingAffordance(r)).match(/.{1,72}(\s|$)/g) ?? [])
      console.log('    ' + line.trim());
    if (r.candidates.length) {
      console.log(`\n  CANDIDATE PAIRS to confirm by walking (${r.candidateCount} found, best ${r.candidates.length}):`);
      for (const c of r.candidates)
        console.log(`    ${sq(c.from.row, c.from.col)} -> ${sq(c.to.row, c.to.col)}  ` +
                    `span ${c.span} square(s), ` +
                    `${c.kind === 'climb' ? 'RISE +' + c.rise : 'drop ' + (-c.rise)} units  ` +
                    `${c.withinStepCap ? '(inside the 384 step cap)' : '(past the step cap)'}`);
      console.log('    A CANDIDATE IS A QUESTION. m59-falljumps.json is operator-supplied and');
      console.log('    WALKED; inventing a fall that cannot be made reports a region as');
      console.log('    connected when it is not. Nothing here has been written anywhere.');
    }
    console.log('');
  }
}

if (process.argv[1] && /m59-nodegap\.mjs$/.test(process.argv[1])) main();
