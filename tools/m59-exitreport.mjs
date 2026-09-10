#!/usr/bin/env node
// CAN A BODY IN THIS ROOM REACH THAT DOOR — AND IF NOT, WHAT IS IN THE WAY?
//
// WRITTEN BY SESSION m59-harness-99, with m59-exitreport-test.mjs (42). Committed in fffa0c3
// by session m59-harness-31, which found it uncommitted in a shared working tree and wrote the
// commit body in the first person. The mistake was mine (m59-harness-31): a shared checkout
// means `git status` shows other people's work in progress, and "modified and not mine" is a
// question to ask rather than a file to sweep up.
//
//   node tools/m59-exitreport.mjs 599            one room: its doors, and which reach which
//   node tools/m59-exitreport.mjs 599 --from 598 the same, entered from a named neighbour
//   node tools/m59-exitreport.mjs 589 --to r45c32  can a body that lands here reach
//                                                that SQUARE? (a mana node is a point target)
//   node tools/m59-exitreport.mjs 27 --at r27c41 --to r23c53
//                                                I am standing HERE — can I reach THERE?
//                                                (the only form that works in a room the
//                                                world graph has no way INTO, like the
//                                                trigger-entered Icky Cave)
//   node tools/m59-exitreport.mjs 750 --to r25c23 --box 2
//                                                the same question when the target is a BOX
//                                                rather than a point — which is what a mana
//                                                node is, and what changes the answer
//   node tools/m59-exitreport.mjs 599 --json     for a script
//   node tools/m59-exitreport.mjs --one-way      every room in the world whose doors are
//                                                not mutually reachable, worst first
//
// "NO ROUTE" IS THE LEAST USEFUL TRUE ANSWER IN THIS REPOSITORY, and the second least
// useful is a trap entry written from one bad afternoon. This answers the question those
// two keep being asked instead of: FOR THIS ROOM, WHICH DOORS CAN THE MOVER ACTUALLY GET
// TO, FROM WHERE, AND BY WALKING OR BY FALLING.
//
// WHAT IT COST NOT TO HAVE THIS. Ukgoth (599) is the northern road to Castle Victoria and
// its mana node, and three separate sessions have now argued about whether the fleet can
// take it, from three sources that each answer a different question:
//
//   * `KNOWN_TRAPS[599]` in m59-fleetscript.mjs says "only the SOUTH one is real for us;
//     a plan through the north exit walks for ever";
//   * `substrate/m59-falljumps.json` declares that north crossing as a working fall jump
//     the operator has made, and says the Relic of Qor gates the CLIMB BACK, not the exit;
//   * the transit ledgers carry 313 arrivals in room 2 across 35 characters.
//
// All three are true. They disagree because the trap entry is about A PLAN THAT TREATS THE
// CROSSING AS A WALK, and nothing printed the difference. The bake has known it the whole
// time: room 599's baked route from the east anchor to the north anchor contains a `(dr,dc)`
// token, which is the notation for a fall — a move of more than one square with no
// direction letter. So this prints the trap claim BESIDE the measurement, and marks a door
// whose only baked approach jumps. A stale claim then looks stale instead of authoritative.
//
// IT RE-DERIVES NOTHING. Every number here is read out of the artifacts the mover plans on
// — `substrate/m59-routes.json` for anchors, directed reach, routes and gutters, and the
// map for the exits and the inbound arrival squares. A debugging view that computes its own
// geometry is a second opinion about the map rather than a look at the one in play.
//
// REACHABILITY IS DIRECTED AND THIS PRINTS IT AS A MATRIX FOR THAT REASON. A fall-jump is
// one-way, so an undirected component labelling welds the top of a drop to the bottom and
// reports a door nobody can take. In 599 the difference is the whole answer: from the
// gutter at r67c15 the ONLY door is south to 589, and every symmetric model says otherwise.
//
// COORDINATES ARE PRINTED `rNcM`, NEVER AS A BARE PAIR. `m59-routes.mjs --room` prints its
// anchors as `2,71` for the square this file calls `r71c2`; a bare pair cannot say which
// axis it leads with, and this repository has paid for that at least twice.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMap, movementMapFile, CHECKED_MAP_FILE } from './m59-map.mjs';
import { routesFor, anchorReachVia, stepMaskCurrent, attachStepMasks,
         reachableFrom } from './m59-routes.mjs';
import { KNOWN_TRAPS } from './m59-fleetscript.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const flag = (n, d = null) => {
  const at = argv.indexOf('--' + n);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
};

/** The only spelling of a square this file emits. Named axes, row first, never a bare pair. */
const sq = (row, col) => `r${row}c${col}`;
const keyOf = a => `${a.row},${a.col}`;

/**
 * A baked route string spells an ordinary step as a direction letter and a FALL as `(dr,dc)`
 * — see `replay` in m59-routebake.mjs. So the presence of that token is the difference
 * between "walk out of this door" and "run off a ledge and stay in the air", which is
 * exactly the distinction three sessions have now got wrong about Ukgoth.
 */
export function jumpsIn(path) {
  const out = [];
  const re = /\((-?\d+),(-?\d+)\)/g;
  let m;
  while ((m = re.exec(String(path ?? '')))) out.push({ dr: Number(m[1]), dc: Number(m[2]) });
  return out;
}

/** The declared fall jumps this room has been walked with, for corroboration. */
function declaredFalls(room) {
  try {
    const j = JSON.parse(readFileSync(join(REPO, 'substrate', 'm59-falljumps.json'), 'utf8'));
    return (j.jumps || []).filter(x => Number(x.room) === Number(room));
  } catch { return []; }
}

export function roomReport(map, table, roomNum,
                           { reachFrom = reachableFrom, goal = null,
                             falls = declaredFalls, standingAt = null, box = 0 } = {}) {
  const room = map.rooms[String(roomNum)];
  if (!room) return { error: `room ${roomNum} is not in the map` };
  const baked = table?.rooms?.[String(roomNum)] ?? null;
  const anchors = (baked?.anchors ?? []).map(a => ({ ...a }));

  // WHERE A BODY LANDS COMING IN, which is the start of every real question. An anchor is
  // where you STAND TO LEAVE; it is not where you appear, and conflating the two is how a
  // reachability answer gets asked from the wrong square.
  const arrivals = [];
  for (const [id, r] of Object.entries(map.rooms)) {
    for (const e of (r.edgeExits ?? []))
      if (Number(e.to) === Number(roomNum))
        arrivals.push({ from: Number(id), fromName: r.name, kind: 'edge', via: e.leaveName,
                        row: e.arriveRow, col: e.arriveCol });
    for (const g of (r.goExits ?? []))
      if (Number(g.to) === Number(roomNum))
        arrivals.push({ from: Number(id), fromName: r.name, kind: 'go',
                        via: `door at ${sq(g.row, g.col)}`, row: g.arriveRow, col: g.arriveCol });
  }
  // One row per (neighbour, landing square): three doors that all drop you on the same
  // square are one arrival as far as this question is concerned.
  const seenArrival = new Set();
  const inbound = arrivals.filter(a => {
    const k = `${a.from}:${a.row},${a.col}`;
    if (seenArrival.has(k)) return false;
    seenArrival.add(k); return true;
  });
  // A ROOM THE WORLD GRAPH HAS NO WAY INTO STILL HAS BODIES IN IT. Room 27 is entered by
  // walking onto a trigger in another room, so it has zero inbound exits and the list above
  // is empty — and every question below would then have nothing to ask FROM. `standingAt`
  // is the general form: the square a body is actually on, whoever put it there.
  if (standingAt)
    inbound.unshift({ from: null, fromName: 'where the body is standing now', kind: 'here',
                      via: null, row: standingAt.row, col: standingAt.col });

  // AND THE QUESTION A STUCK CHARACTER IS ACTUALLY ASKING: I LANDED HERE — WHICH DOORS CAN
  // I TAKE, AND CAN I GET TO THAT SQUARE? An anchor-to-anchor matrix cannot answer either,
  // because an arrival square is not an anchor and is frequently not in the same region as
  // one. `reachableFrom` floods from the landing square with `moverStepLands` — the
  // predicate the mover enforces, IN THE DIRECTION OF TRAVEL — which is the only version of
  // this that is not a symmetric lie.
  //
  // Asked per ANCHOR rather than per exit, because exits are not doors and are not 1:1:
  // room 39 has four doorways all leading to room 38 and a per-exit answer prints "38" four
  // times with no way to tell which one it means.
  for (const a of inbound) {
    const seen = reachFrom(map, roomNum, a.row, a.col);
    if (!seen) { a.canTake = null; a.cannotTake = [];
                 a.why = `r${a.row}c${a.col} is not a standable square in room ${roomNum} — ` +
                         `usually the position and the geometry are from DIFFERENT ROOMS`;
                 a.reachesGoal = null; continue; }
    a.canTake = anchors.filter(x => seen.has(keyOf(x)));
    a.cannotTake = anchors.filter(x => !seen.has(keyOf(x)));
    a.why = null;
    // A TARGET IS OFTEN A BOX, NOT A POINT, and asking about the point gives the wrong
    // answer in both directions. The mana-node meld is `abs(drow) < 3 AND abs(dcol) < 3`
    // per axis (mananode.kod:177), so the square the stone stands on is frequently NOT
    // standable — the stone is on it — while four squares around it are, and the errand
    // succeeds from any of them. `--box 2` asks the question the errand has.
    a.reachesGoal = goal
      ? [...seen].some(k => {
          const [r, c] = k.split(',').map(Number);
          return Math.abs(r - goal.row) <= box && Math.abs(c - goal.col) <= box;
        })
      : null;
    // AND IF NOT BY WALKING, THEN BY WHICH FALL? A declared fall is a piece of ground the
    // step flood cannot cross, so a goal it cannot reach may still be one hop away: the
    // take-off has to be reachable from where the body landed, and the goal from where the
    // fall puts it. Both halves are directed, and the second one is the half a symmetric
    // model gets wrong.
    a.goalViaFall = null;
    a.nearestToGoal = null;
    // HOW CLOSE DOES IT GET? "No route" is the least useful true answer here, and for a
    // POINT TARGET it is usually not even the question — the mana-node meld is a 5x5 BOX
    // around the stone, so "unreachable by 4 squares" and "unreachable by 40" are different
    // findings and only one of them is a movement defect worth chasing. Chebyshev, because
    // that is the metric the server's own range test uses (per-axis, mananode.kod:177).
    if (goal && a.reachesGoal === false) {
      for (const k of seen) {
        const [r, c] = k.split(',').map(Number);
        const d = Math.max(Math.abs(r - goal.row), Math.abs(c - goal.col));
        if (!a.nearestToGoal || d < a.nearestToGoal.away) a.nearestToGoal = { row: r, col: c, away: d };
      }
    }
    if (goal && a.reachesGoal === false) {
      for (const j of falls(roomNum)) {
        if (!seen.has(`${j.from.row},${j.from.col}`)) continue;
        const after = reachFrom(map, roomNum, j.to.row, j.to.col);
        if (after?.has(`${goal.row},${goal.col}`)) { a.goalViaFall = j; break; }
      }
    }
  }

  // THE DIRECTED MATRIX. `anchorReachVia` is the router's own answer and returns the word
  // 'blink' rather than folding a spell into a boolean, because a caller that treats the
  // two as interchangeable plans a route that needs mana and reports it as a walk.
  const reach = [];
  for (const from of anchors) {
    for (const to of anchors) {
      if (from === to) continue;
      const how = anchorReachVia(table, roomNum, from, to);
      const path = baked?.routes?.[`${keyOf(from)}>${keyOf(to)}`] ?? null;
      const falls = jumpsIn(path);
      const pivots = baked?.pivots?.[`${keyOf(from)}>${keyOf(to)}`] ?? null;
      reach.push({ from, to, how, jumps: falls, hasRoute: !!path,
                   unverifiedPivots: pivots?.unverified ?? null });
    }
  }

  return {
    room: roomNum, name: room.name, rows: room.rows, cols: room.cols,
    baked: !!baked,
    regions: baked?.regions ?? null,
    mainRegion: baked?.main_region ?? null,
    mainRegionSquares: baked?.main_region_squares ?? null,
    walkable: baked?.walkable ?? null,
    anchors, inbound, reach, goal, box,
    gutters: baked?.gutters ?? [],
    blink: baked?.blink ?? null,
    trap: KNOWN_TRAPS[roomNum] ?? null,
    declaredFalls: falls(roomNum),
  };
}

const sameSquare = (a, b) => a.row === b.row && a.col === b.col;

/**
 * A fall in words. The grid delta is NOT the height drop — the server is two-dimensional and
 * height is ours — so this says how far across the floor the body travels with no floor
 * under it, and never pretends to say how far down.
 */
export function fallWords({ dr, dc }) {
  const parts = [];
  if (dr) parts.push(`${Math.abs(dr)} row${Math.abs(dr) === 1 ? '' : 's'} ${dr > 0 ? 'south' : 'north'}`);
  if (dc) parts.push(`${Math.abs(dc)} col${Math.abs(dc) === 1 ? '' : 's'} ${dc > 0 ? 'east' : 'west'}`);
  return parts.join(' and ') || 'in place';
}

function wrap(text, width = 74) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && (line.length + 1 + w.length) > width) { lines.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines;
}

function printRoom(rep) {
  if (rep.error) { console.log(rep.error); return; }
  console.log(`room ${rep.room} — ${rep.name} — ${rep.rows}x${rep.cols} squares`);
  if (!rep.baked) {
    console.log('  NOTHING BAKED for this room. Every answer below would be a guess, so ' +
                'there are none. Run `node tools/setup.mjs routes`.');
    return;
  }
  console.log(`  ${rep.regions} region(s); the main one is ${rep.mainRegion} with ` +
              `${rep.mainRegionSquares} of ${rep.walkable} walkable squares`);

  if (rep.trap) {
    console.log('');
    console.log('  KNOWN_TRAPS SAYS:');
    for (const line of wrap(rep.trap)) console.log(`    ${line}`);
    console.log('    (that is a CLAIM. What follows is the measurement. Read both.)');
  }

  console.log('');
  console.log('  DOORS OUT — the square you stand on to leave, never where you arrive');
  if (!rep.anchors.length) console.log('    none baked');
  for (const a of rep.anchors) {
    const viaJump = rep.reach.some(r => sameSquare(r.to, a) && r.jumps.length);
    console.log(`    ${String(a.dir ?? a.kind).padEnd(6)} to ${String(a.to).padEnd(5)} ` +
                `${sq(a.row, a.col).padEnd(8)} region ${String(a.region).padEnd(3)} ` +
                `${a.from_body ? 'on the body' : 'OFF THE BODY'}` +
                `${viaJump ? '   at least one approach to it FALLS' : ''}`);
  }

  console.log('');
  console.log('  WHERE YOU LAND COMING IN');
  if (!rep.inbound.length) console.log('    NOTHING IN THE WORLD GRAPH ARRIVES HERE — ' +
    'this room is entered by a trigger or not at all');
  for (const a of rep.inbound) {
    const onDoor = rep.anchors.find(x => sameSquare(x, a));
    console.log(`    ${a.from == null ? 'HERE '.padEnd(10)
                    : ('from ' + String(a.from)).padEnd(10)}${String(a.fromName).slice(0, 30).padEnd(31)}` +
                `-> ${sq(a.row, a.col).padEnd(8)}${onDoor ? ` (on the ${onDoor.dir} door itself)` : ''}`);
    if (a.canTake === null)
      console.log(`             no opinion — ${a.why}`);
    else {
      const name = x => `${x.dir ?? x.kind} to ${x.to} at ${sq(x.row, x.col)}`;
      const yes = a.canTake.map(name).join(', ') || 'NONE';
      const no = a.cannotTake.map(name).join(', ');
      console.log(`             from that square you can WALK to: ${yes}`);
      if (no) console.log(`             and you CANNOT walk to: ${no}`);
      if (a.reachesGoal !== null) {
        console.log(`             and ${sq(rep.goal.row, rep.goal.col)}` +
                    `${rep.box ? ` (or within ${rep.box} of it)` : ' itself'} is ` +
                    `${a.reachesGoal ? 'REACHABLE' : 'NOT reachable'} by walking from there`);
        if (a.goalViaFall)
          console.log(`             but it IS reachable across the declared fall ` +
                      `${sq(a.goalViaFall.from.row, a.goalViaFall.from.col)} -> ` +
                      `${sq(a.goalViaFall.to.row, a.goalViaFall.to.col)} ` +
                      `(${a.goalViaFall.observed_by}) — walk to the take-off, then jump`);
        else if (a.reachesGoal === false) {
          if (a.nearestToGoal)
            console.log(`             the closest the mover gets is ` +
                        `${sq(a.nearestToGoal.row, a.nearestToGoal.col)}, ` +
                        `${a.nearestToGoal.away} square(s) off (Chebyshev, the metric the ` +
                        `server's own range tests use)`);
          console.log(`             and no DECLARED fall in this room bridges the gap`);
        }
      }
    }
  }

  // THE RECONCILIATION, AND THE REASON THIS FILE EXISTS.
  //
  // Two honest models answer this question differently and neither is wrong:
  //
  //   * `reachableFrom` floods with `moverStepLands` — ONE SQUARE AT A TIME, in the
  //     direction of travel. A fall of three columns is not a step, so it never appears.
  //   * the bake's anchor routes embed declared falls as `(dr,dc)`, so they cross ground
  //     the step flood cannot.
  //
  // A door in the gap between them is reachable ONLY BY A PLAN THAT KNOWS ABOUT THE FALL,
  // and a plan that treats it as a walk searches for ever. That is the whole content of the
  // Ukgoth argument, and until now nothing printed it.
  const gap = [];
  for (const a of rep.inbound) {
    if (!a.canTake) continue;
    const walkable = new Set(a.canTake.map(x => Number(x.to)));
    for (const door of rep.anchors) {
      if (walkable.has(Number(door.to))) continue;
      // Is there a baked route to it from an anchor we CAN walk to, and does it fall?
      const via = rep.reach.filter(r => sameSquare(r.to, door) && r.jumps.length &&
                                        walkable.has(Number(r.from.to)));
      if (via.length) gap.push({ arrival: a, door, via: via[0] });
    }
  }
  if (gap.length) {
    console.log('');
    console.log('  ONLY REACHABLE IF THE PLAN INCLUDES THE FALL');
    console.log('  (the step-by-step mover says no; the bake has a route, and it jumps)');
    for (const g of gap)
      console.log(`    landing ${sq(g.arrival.row, g.arrival.col)} from ${g.arrival.from}: ` +
                  `the ${g.door.dir} door to ${g.door.to} at ${sq(g.door.row, g.door.col)} ` +
                  `is NOT walkable,\n      but ${sq(g.via.from.row, g.via.from.col)} -> ` +
                  `${sq(g.door.row, g.door.col)} is baked with ` +
                  `${g.via.jumps.length} fall(s): ${g.via.jumps.map(fallWords).join('; ')}.` +
                  `\n      So a journey that treats this crossing as a WALK finds nothing and ` +
                  `loops. That is\n      the failure a trap entry usually describes — not a ` +
                  `door that does not exist.`);
  }

  console.log('');
  console.log('  DOOR TO DOOR, DIRECTED — a fall is one-way, so this matrix is not symmetric');
  // NAME THE SQUARE, because four doorways to room 38 print as `go->38` four times
  // otherwise. Exits are not doors and are not 1:1.
  const label = a => `${a.dir ?? a.kind}->${a.to}@${sq(a.row, a.col)}`;
  for (const r of rep.reach) {
    const how = r.how === 'walk' ? 'walk'
      : r.how === 'blink' ? 'BLINK ONLY — needs mana and a cast that can fail'
      : r.how === false ? 'NO'
      : 'the table cannot say';
    const jump = r.jumps.length
      ? `  via ${r.jumps.length} declared fall(s): ${r.jumps.map(fallWords).join('; ')}`
      : '';
    const unv = r.unverifiedPivots ? `  (${r.unverifiedPivots} unverified pivot leg)` : '';
    console.log(`    ${label(r.from).padEnd(12)} -> ${label(r.to).padEnd(12)} ${how}${jump}${unv}`);
  }

  if (rep.gutters.length) {
    console.log('');
    console.log('  GUTTERS — pockets you can fall into and not climb out of.');
    console.log('  Miss a jump and you are in one of these; the list is your ONLY way out.');
    for (const g of rep.gutters) {
      const outs = (g.reaches ?? []).map(k => {
        const [row, col] = k.split(',').map(Number);
        const a = rep.anchors.find(x => x.row === row && x.col === col);
        return a ? `${a.dir ?? a.kind} to ${a.to} at ${sq(row, col)}` : `${sq(row, col)} (another gutter)`;
      });
      console.log(`    ${sq(g.row, g.col).padEnd(9)} ${g.squares == null ? '?' : g.squares} squares` +
                  `  -> ${outs.join(', ') || 'NOWHERE'}`);
    }
  }

  if (rep.declaredFalls.length) {
    console.log('');
    console.log('  DECLARED FALL JUMPS for this room (substrate/m59-falljumps.json) — ' +
                'walked by a person, not derived');
    for (const j of rep.declaredFalls)
      console.log(`    ${sq(j.from.row, j.from.col)} -> ${sq(j.to.row, j.to.col)}` +
                  `  ${j.part_of_cycle ? 'part of a cycle' : 'ONE-WAY'}` +
                  `  (${j.observed_by})`);
  }

  if (rep.blink) {
    console.log('');
    console.log(`  BLINK lands at ${sq(rep.blink.row, rep.blink.col)} and can walk to ` +
                `${(rep.blink.reaches ?? []).length} of the doors from there`);
  }
}

/** Every room whose doors are not all mutually reachable — the world's one-way rooms. */
export function oneWayRooms(map, table, { reachVia = anchorReachVia } = {}) {
  const rows = [];
  for (const id of Object.keys(map.rooms)) {
    const baked = table?.rooms?.[id];
    if (!baked?.anchors || baked.anchors.length < 2) continue;
    let pairs = 0, no = 0, jumps = 0;
    for (const from of baked.anchors) for (const to of baked.anchors) {
      if (from === to) continue;
      pairs++;
      if (reachVia(table, Number(id), from, to) !== 'walk') no++;
      if (jumpsIn(baked.routes?.[`${keyOf(from)}>${keyOf(to)}`]).length) jumps++;
    }
    if (no) rows.push({ room: Number(id), name: map.rooms[id].name, pairs, no, jumps,
                        gutters: (baked.gutters ?? []).length,
                        trap: KNOWN_TRAPS[Number(id)] ? 'in KNOWN_TRAPS' : '' });
  }
  return rows.sort((a, b) => (b.no / b.pairs) - (a.no / a.pairs) || b.no - a.no);
}

function main() {
  // WHICH MAP, SAID OUT LOUD. `loadMap()` prefers this checkout's LEARNED map over the
  // committed one, and a learned map that has moved ahead of the bake refuses every answer
  // below — correctly, since the router must plan on the map the mover enforces. But
  // "missing or different" is the same unhelpful sentence as "no route": it does not say
  // WHICH of the two files moved, and that is the only thing the operator needs.
  const mapFile = has('checked') ? CHECKED_MAP_FILE : movementMapFile();
  const map = loadMap(mapFile);
  const table = routesFor(map.geometryManifestSha256);
  if (!table) {
    const checked = has('checked') ? null : (() => {
      try { return loadMap(CHECKED_MAP_FILE); } catch { return null; }
    })();
    console.log('REFUSING: the baked routing table was not built from the map this checkout ' +
                'moves on, so every answer below would be about a different world.');
    console.log(`  map in play  ${mapFile}`);
    console.log(`               manifest ${map.geometryManifestSha256}`);
    console.log(`  the table    substrate/m59-routes.json`);
    if (checked && routesFor(checked.geometryManifestSha256))
      console.log('\n  BUT THE COMMITTED MAP DOES MATCH IT. So the thing that moved is this ' +
                  'checkout\'s\n  LEARNED map, not the bake. Either rebake against it ' +
                  '(`node tools/setup.mjs routes`)\n  or ask about the committed one with ' +
                  '`--checked`, knowing that is not what the mover walks.');
    else
      console.log('\n  Run `node tools/setup.mjs routes`.');
    process.exit(2);
  }
  if (!stepMaskCurrent(table))
    console.log('WARNING: this table has no current step mask, so it is a picture of a map ' +
                'the fleet is not walking on. Rebake before believing a refusal.\n');
  // ATTACH THE MASKS BEFORE MEASURING ANY GEOMETRY, or the flood falls back to the COARSE
  // grid — which is symmetric and will happily walk a body back UP a cliff. Measured in
  // Ukgoth: 4,673 squares against the mover's 319, including the Castle Victoria door.
  // `reachableExits` also reads the attached table for its anchors, so this is not optional.
  attachStepMasks(map);

  if (has('one-way')) {
    const rows = oneWayRooms(map, table);
    console.log(`${rows.length} room(s) where at least one door cannot be WALKED to from ` +
                `another — worst first.\nA fall, a blink or a one-way drop all land here; ` +
                `the per-room report says which.\n`);
    console.log('  room  unreachable/pairs  falls  gutters  name');
    for (const r of rows.slice(0, Number(flag('limit', 40))))
      console.log(`  ${String(r.room).padStart(4)}  ${String(r.no + '/' + r.pairs).padStart(17)}` +
                  `  ${String(r.jumps).padStart(5)}  ${String(r.gutters).padStart(7)}  ` +
                  `${r.name}${r.trap ? '  [' + r.trap + ']' : ''}`);
    return;
  }

  const asked = argv.find(a => /^\d+$/.test(a));
  if (!asked) {
    console.log('name a room:  node tools/m59-exitreport.mjs 599');
    console.log('or ask the world:  node tools/m59-exitreport.mjs --one-way');
    process.exit(2);
  }
  // `--to r23c53` — CAN A BODY THAT LANDS HERE REACH THAT SQUARE? Arriving in the room is
  // not arriving at the stone, and a mana node is a POINT target: the meld test is a 5x5
  // box around one square (mananode.kod:177). The door question and the square question are
  // different, and the second is the one a node run actually has.
  const toArg = flag('to', null);
  let goal = null;
  if (toArg) {
    const m = /^r(\d+)c(\d+)$/i.exec(String(toArg));
    if (!m) { console.log('--to takes a square as rNcM, e.g. --to r23c53'); process.exit(2); }
    goal = { row: Number(m[1]), col: Number(m[2]) };
  }
  const atArg = flag('at', null);
  let standingAt = null;
  if (atArg) {
    const m = /^r(\d+)c(\d+)$/i.exec(String(atArg));
    if (!m) { console.log('--at takes a square as rNcM, e.g. --at r27c41'); process.exit(2); }
    standingAt = { row: Number(m[1]), col: Number(m[2]) };
  }
  // `--box 2` is the mana-node rule; the default 0 is the literal square.
  const box = Math.max(0, Math.trunc(Number(flag('box', 0)) || 0));
  const rep = roomReport(map, table, Number(asked), { goal, standingAt, box });
  const from = flag('from', null);
  if (from && !rep.error) {
    rep.inbound = rep.inbound.filter(a => a.from === Number(from));
    if (!rep.inbound.length)
      console.log(`NOTE: the world graph has no exit from room ${from} into ${asked}. ` +
                  `Showing the room anyway.\n`);
  }
  if (has('json')) { console.log(JSON.stringify(rep, null, 1)); return; }
  printRoom(rep);
}

// Importable for its pure halves; running it is opt-in, the same guard m59-supervise.mjs
// grew after `import` to check a file turned out to start it.
if (process.argv[1] && /m59-exitreport\.mjs$/.test(process.argv[1])) main();
