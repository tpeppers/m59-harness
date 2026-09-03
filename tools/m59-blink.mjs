#!/usr/bin/env node
// BLINK IS A ONE-WAY PORTAL AND EVERY ROOM HAS ONE.
//
//   node tools/m59-blink.mjs            # every room whose blink point opens a door walking cannot
//   node tools/m59-blink.mjs --save     # write substrate/m59-blink.json for the route bake
//   node tools/m59-blink.mjs --room 382 # one room, whatever it says
//
// `blink.kod` says "Teleports you to a central location in the room" and posts @Teleport to
// the room, which answers from `viTeleport_row` / `viTeleport_col` — a FIXED pair declared
// per room in the kod. So from anywhere a character can cast, it can reach that one square,
// and therefore everything that square can walk to.
//
// FOR MOST ROOMS THIS OPENS NOTHING, and that is the expected result rather than a
// disappointment: where a room is one connected body, the blink point was already reachable.
// It matters exactly where a room has a one-way ledge, and there it can save a whole map of
// travel. West Jasper is the worked example — entering from the north edge leaves a body in
// a 795-square pocket that reaches ONE of seven doors by walking, and the blink point at
// 37,25 sits outside that pocket and reaches ALL SEVEN.
//
// IT IS NOT FREE, AND NOTHING HERE MAY PRETEND IT IS. Casting costs mana, a character may
// have to rest to afford it, and a cast can fail and need repeating. So blink reachability
// is recorded SEPARATELY from walking and never merged into it: walking is what the router
// plans on, and blink is what a caller may fall back to when walking cannot answer at all.
//
// Coordinates are the kod's, which is what substrate/m59-map.json already uses — checked
// against jaswest.kod's `plExits = Cons([ 49, 36, ROOM_LOCKED_DOOR ])` and the same exit in
// the map, which agree exactly.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'substrate', 'm59-blink.json');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

export function kodRoot() {
  const guesses = [process.env.M59_ROOT, 'C:/code/Meridian59',
                   join(HERE, '..', '..', '..', 'Meridian59')].filter(Boolean);
  for (const g of guesses) {
    try { if (statSync(join(g, 'kod')).isDirectory()) return g; } catch { /* next */ }
  }
  return null;
}

function kodFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) kodFiles(p, out);
    else if (e.name.endsWith('.kod')) out.push(p);
  }
  return out;
}

/**
 * The blink point declared in one kod file, and which .roo it belongs to.
 *
 * A kod file is one class is one room, so a file naming exactly one .roo and declaring a
 * teleport pair is unambiguous. A file naming several is REFUSED rather than guessed at: a
 * blink point attached to the wrong room is worse than no blink point at all, because it
 * would claim exits a character cannot actually reach.
 */
export function blinkIn(text) {
  const row = /\bviTeleport_row\s*=\s*(-?\d+)/.exec(text);
  const col = /\bviTeleport_col\s*=\s*(-?\d+)/.exec(text);
  if (!row || !col) return null;
  const roos = [...new Set([...text.matchAll(/=\s*([\w.\-]+\.roo)\b/gi)].map(m => m[1].toLowerCase()))];
  if (roos.length !== 1) return { ambiguous: roos };
  const angle = /\bviTeleport_angle\s*=\s*(-?\d+)/.exec(text);
  return {
    roo: roos[0], row: Number(row[1]), col: Number(col[1]),
    ...(angle ? { angle: Number(angle[1]) } : {}),
  };
}

/**
 * WHERE A BODY CAN GET TO WITH THE TRAFFIC WHERE IT IS -- squares, body-aware.
 *
 * The router plans on an EMPTY room, which is right: bodies move, and baking them in would
 * make every route a photograph. But the question "would blinking help me right now" is
 * exactly the question the empty-room answer cannot address, so this one takes the bodies.
 *
 * A square holding a blocking body is impassable, and so is a step whose line passes within
 * MIN_NOMOVEON of one -- the fine lane (`lanePastBodies`) is the thing that beats that, and
 * it is tried before any of this. What is left here is the case where threading failed.
 */
export function reachableAround(geo, from, bodies, { rows, cols }) {
  const key = (r, c) => r * 1000 + c;
  const taken = new Set((bodies ?? [])
    .filter(b => Number.isFinite(b.row) && Number.isFinite(b.col))
    .map(b => key(b.row, b.col)));
  const D = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const step = (a, b, c, d) => { try { return geo.moverStepLands(a, b, c, d) === true; } catch { return false; } };
  const start = key(from.row, from.col);
  if (taken.has(start)) taken.delete(start);          // we are standing here; we are not our own wall
  const seen = new Set([start]); const q = [[from.row, from.col]];
  while (q.length) {
    const [r, c] = q.shift();
    for (const [dr, dc] of D) {
      const nr = r + dr, nc = c + dc;
      if (nr < 1 || nc < 1 || nr > rows || nc > cols) continue;
      if (seen.has(key(nr, nc)) || taken.has(key(nr, nc))) continue;
      if (!geo.standPoint?.(nr, nc) || !step(r, c, nr, nc)) continue;
      seen.add(key(nr, nc)); q.push([nr, nc]);
    }
  }
  return seen;
}

/**
 * WOULD BLINKING GET ME PAST THIS? The predicate the escape strategy is built on.
 *
 * True when the blink point is on the FAR side of the traffic: the goal is unreachable from
 * where the body is standing with the bodies where they are, and reachable from the blink
 * point with those same bodies where they are. Both halves matter --
 *
 *   - without the first, it fires when nothing is wrong and spends 15 mana and ten seconds
 *     to arrive somewhere it could have walked;
 *   - without the second, it fires into a blink point on the SAME side of the jam, which is
 *     the ~half of the time the operator expects this to be useless. Here it is not merely
 *     useless, it is a wasted cast and a character standing in the open for ten seconds.
 *
 * IT IS CONSERVATIVE ABOUT THE LANE, ON PURPOSE. The flood treats an occupied square as
 * impassable, so it does not know that `lanePastBodies` can often thread a body at fine
 * resolution -- which means it can answer `true` for a jam the walker could still have
 * walked out of. On the recorded sewer jam it reports a character boxed into ONE square,
 * and the lane threads that jam for free.
 *
 * SO THIS MUST NOT BECOME A CRUTCH FOR NOT WRITING GOOD PATHING AND MOVEMENT. Every jam
 * this answers `true` for is a question about the mover, and blinking out of it retires the
 * symptom while leaving the cause -- a fleet that blinks past everything it cannot walk past
 * stops generating the evidence that would have fixed the walking. That is the reason for
 * the observation record below, and for `min_stuck_ms` in the escape strategy: the cheap
 * movement answers get their chance first, and what blink rescues is written down so the
 * pathing work has a queue.
 *
 * It is NOT an argument for asking this late in principle. For a scenario that is genuinely
 * impassable -- geometry no lane can thread, a corridor narrower than a body, a room whose
 * only door is behind something that will not move -- the right behaviour is to recognise it
 * and blink IMMEDIATELY rather than spend twenty seconds proving it again. Recognising those
 * scenarios is the work; until it exists, the delay is a stand-in for the recognition.
 *
 * IT ANSWERS FOR THIS INSTANT ONLY. Bodies move; a `true` here is a fact about the room as
 * it was sampled and nothing more, which is why the caller re-reads rather than caching.
 */
/**
 * `stalled` — WHEN "YOU COULD WALK IT" HAS STOPPED BEING A REASON.
 *
 * The third check below is the one that declines almost everything: 1,349 of ~2,300 recorded
 * asks, and 226 of the 233 in the Cragged Mountains, are "the goal is already reachable on
 * foot; blink would gain nothing". As a predicate about the MAP that is correct — the flood
 * counts the bodies where they are and the goal really is on our side of them.
 *
 * It is not a claim about whether we are getting there, and it was being read as one. A body
 * that has been in a room for two minutes shuffling between the same few squares is refuted
 * by its own history: whatever the reachability flood says, walking is not working, and the
 * ledger cannot tell that from a room being crossed in twenty seconds. The operator's rule,
 * 2026-09-03: past two minutes and oscillating, open blink up regardless of what the body
 * thinks it can reach.
 *
 * ONLY THE THIRD CHECK IS DROPPED. The fourth — the goal must be reachable FROM the blink
 * point, with those same bodies — still stands, because the failure it prevents is the whole
 * reason this predicate exists: fifteen mana and ten seconds to arrive somewhere just as
 * stuck. `stalled` says "walking is not working here"; it does not say "anywhere is better".
 */
// How much more of the room the blink point must open before "I cannot reach my goal from
// either end" counts as being STRANDED rather than merely badly aimed. Four: measured on
// room 567, where the sealed characters reached 17, 26 and 55 squares against the blink
// point's 835 (15x to 49x), and a body standing in the main region with a bad goal reaches
// several hundred and does not come close.
const UNSTRAND_FACTOR = Number(process.env.M59_BLINK_UNSTRAND_FACTOR || 4);

export function canBlinkOut({ geo, blink, from, goal, bodies, rows, cols,
                              room = null, route = null, observe = null, stalled = false }) {
  const key = (r, c) => r * 1000 + c;
  // ONE EXIT, SO EVERY VERDICT IS OBSERVABLE. Written this way rather than as four returns
  // because a record that only covers the interesting branch cannot answer "how often did it
  // decline, and why" -- which is the question that tells us whether the strategy is worth
  // its mana at all.
  const say = (verdict, extra = {}) => {
    const out = { ...verdict, ...extra };
    if (typeof observe === 'function') {
      // THE SEAM, AND NOTHING BEHIND IT SHIPS. This function writes no file and knows no
      // directory: the observation record is one machine's evidence about one server, so the
      // recorder lives in that machine's private strategies and is passed in. A harness
      // cloned by somebody else gets the predicate and no bookkeeping.
      //
      // It is called INSIDE a try: a recorder that throws must not turn a movement decision
      // into an exception on an already-stuck walk.
      try {
        observe({
          room: room ?? null,
          from: from ? { row: from.row, col: from.col } : null,
          goal: goal ? { row: goal.row, col: goal.col } : null,
          blink: blink ? { row: blink.row, col: blink.col } : null,
          route: route ?? null,
          bodies: (bodies ?? []).map(b => ({ row: b.row, col: b.col,
                                             kind: b.kind ?? null, name: b.name ?? null })),
          verdict: out,
        });
      } catch { /* the record is evidence, not a dependency */ }
    }
    return out;
  };

  if (!geo || !blink || !from || !goal)
    return say({ can: false, why: 'missing geometry, blink point, position or goal' });
  if (!geo.standPoint?.(blink.row, blink.col))
    return say({ can: false, why: 'the blink point is not standable' });
  const here = reachableAround(geo, from, bodies, { rows, cols });
  const walkable = here.has(key(goal.row, goal.col));
  if (walkable && !stalled)
    return say({ can: false, why: 'the goal is already reachable on foot; blink would gain nothing' },
                { from_here: here.size });
  const there = reachableAround(geo, blink, bodies, { rows, cols });
  if (!there.has(key(goal.row, goal.col))) {
    // A GOAL NOBODY CAN REACH IS NOT EVIDENCE THAT BLINKING IS POINTLESS.
    //
    // This check is right when it means "the blink point is on our side of the jam". It is
    // wrong when the GOAL is the unreachable thing, and in a fragmented room that is the
    // commoner case: 567 has 59 regions, its north boundary is standable at cols 10-17 and
    // 44-47, and those are two DIFFERENT pockets — cols 45-47 are the room's body and cols
    // 10-17 are an 81-square island. The fleet spent 536 of 707 asks there aiming at r1c16
    // and r1c13, both on the island, so the goal was unreachable from the blink point too
    // and every ask died on this line.
    //
    // Meanwhile Kermit could reach 17 squares, Animal 26 and Scooter 55, none of them able
    // to reach ANY exit of that room, while the blink point reaches 835. Blinking does not
    // complete their journey and it is still the whole answer: it puts a stranded body back
    // in the room's body, where the ordinary router has something to work with. The operator
    // was about to rescue those three by hand, 2026-09-03.
    //
    // Gated on being genuinely sealed in — the blink point must reach at least four times
    // what we can — so this cannot fire for a body that merely has a bad goal while standing
    // in the main region. 55 against 835 passes it; 400 against 835 does not.
    if (here.size * UNSTRAND_FACTOR <= there.size)
      return say({ can: true, unstrands: true,
                   why: `stranded: ${here.size} square(s) from here and the goal is reachable from ` +
                        `neither, but the blink point opens ${there.size} — blinking to get unstuck ` +
                        `rather than to arrive` },
                 { from_here: here.size, from_blink: there.size, ...(stalled ? { stalled } : {}) });
    return say({ can: false, why: 'the blink point is on the same side of the traffic as we are' },
                { from_here: here.size, from_blink: there.size, stalled });
  }
  return say({ can: true,
               why: walkable
                 ? `the goal is reachable on foot (${here.size} squares) and we are not reaching ` +
                   `it — ${stalled}; the blink point is clear (${there.size} squares)`
                 : `blocked from here (${here.size} squares) and clear from the blink ` +
                   `point (${there.size} squares)`,
               ...(walkable ? { despite_walkable: true } : {}) },
             { from_here: here.size, from_blink: there.size, ...(stalled ? { stalled } : {}) });
}

export function collectBlinks(root = kodRoot()) {
  if (!root) return { points: {}, ambiguous: [], declared: 0, root: null };
  const points = {};
  const ambiguous = [];
  let declared = 0;
  for (const f of kodFiles(join(root, 'kod'))) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const b = blinkIn(text);
    if (!b) continue;
    declared++;
    if (b.ambiguous) { ambiguous.push({ file: f.slice(root.length + 1), roos: b.ambiguous }); continue; }
    points[b.roo] = { row: b.row, col: b.col, ...(b.angle != null ? { angle: b.angle } : {}) };
  }
  return { points, ambiguous, declared, root };
}

const direct = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (direct) {
  const { points, ambiguous, declared, root } = collectBlinks();
  if (!root) {
    console.error('no Meridian 59 source tree found — set M59_ROOT to it');
    process.exit(2);
  }
  const { loadMap } = await import('./m59-map.mjs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const { attachStepMasks } = await import('./m59-routes.mjs');
  const map = await loadMap();
  try { attachStepMasks(map); } catch { /* coarse, as everywhere */ }

  const only = arg('--room') ? Number(arg('--room')) : null;
  const byRoom = {};
  const rows = [];
  let matched = 0;

  for (const key of Object.keys(map.rooms)) {
    const room = map.rooms[key];
    const file = String(room?.roo?.file ?? room?.rooFile ?? '').toLowerCase();
    const p = points[file];
    if (!p) continue;
    matched++;
    byRoom[room.num] = { row: p.row, col: p.col, ...(p.angle != null ? { angle: p.angle } : {}) };
    if (only && room.num !== only) continue;

    let g = null;
    try { g = sharedRoomGeometry(room); } catch { /* no geometry */ }
    if (!g?.collisionReady) continue;
    const exits = [...(room.edgeExits ?? []), ...(room.goExits ?? [])]
      .filter(e => Number.isFinite(e.row) && Number.isFinite(e.col));
    if (!exits.length) continue;

    const flood = (sr, sc) => {
      if (!g.walkable(sr, sc)) return null;
      const seen = new Set([`${sr},${sc}`]);
      const st = [[sr, sc]];
      while (st.length) {
        const [y, x] = st.pop();
        for (const n of g.neighbors(y, x, { collision: true }) ?? []) {
          const k = `${n.row},${n.col}`;
          if (seen.has(k)) continue;
          seen.add(k); st.push([n.row, n.col]);
        }
      }
      return seen;
    };

    const fromBlink = flood(p.row, p.col);
    if (!fromBlink) { rows.push([room.num, room.name, 'not walkable', 0, 0]); continue; }
    const blinkDoors = exits.filter(e => fromBlink.has(`${e.row},${e.col}`)).length;
    // The WORST any single doorway manages by walking is the number that matters: that is
    // the body a character gets stranded in when it arrives through the wrong door.
    // AND HOW BIG THE PLACE IT STRANDS YOU IN IS, which is the difference between a finding
    // and an artefact. An exit anchor is very often a one-square pocket BY DESIGN -- you step
    // into a doorway and cannot step back off it -- and such a doorway reaching one door is
    // the system working, not a trap. A doorway that drops you into EIGHT HUNDRED squares
    // with one way out is a trap, and that is West Jasper.
    let worst = Infinity, strandedIn = 0;
    for (const e of exits) {
      const f = flood(e.row, e.col);
      if (!f) continue;
      const doors = exits.filter(x => f.has(`${x.row},${x.col}`)).length;
      if (doors < worst) { worst = doors; strandedIn = f.size; }
    }
    if (!Number.isFinite(worst)) worst = 0;
    rows.push([room.num, room.name, `${blinkDoors}/${exits.length}`, worst,
               blinkDoors - worst, strandedIn]);
  }

  const gained = rows.filter(r => r[4] > 0).sort((a, b) => b[4] - a[4]);
  console.log(`${declared} kod room file(s) declare a blink point; ${matched} matched a room in the map` +
              (ambiguous.length ? `; ${ambiguous.length} skipped as ambiguous` : ''));
  console.log(`\n${gained.length} room(s) where blinking reaches doors the worst-off doorway cannot walk to:\n`);
  console.log('room  name                             blink reaches  worst walk  gained  stranded in');
  for (const [num, name, reach, worst, gain, stranded] of (only ? rows : gained).slice(0, 40)) {
    console.log(String(num).padStart(4) + '  ' + String(name).slice(0, 30).padEnd(32) +
                String(reach).padStart(9) + String(worst).padStart(12) +
                String(gain > 0 ? '+' + gain : gain).padStart(8) +
                String(stranded).padStart(13) + (stranded >= 20 ? '  <- a real trap' : ''));
  }
  const traps = gained.filter(r => r[5] >= 20);
  console.log(`
${traps.length} of those strand a body in 20+ squares rather than a one-square ` +
              `doorway pocket, which is the difference between a trap and the system working.`);

  if (argv.includes('--save')) {
    writeFileSync(OUT, JSON.stringify({
      note: 'viTeleport_row/col per room, from the kod. Blink teleports the caster to this ' +
            'square from anywhere in the room, so anything that square can walk to is ' +
            'reachable from anywhere a character can cast. It costs mana and can fail, so it ' +
            'is recorded separately from walking and must never be merged into it.',
      written: new Date().toISOString(), source: root, rooms: byRoom,
    }, null, 1) + '\n');
    console.log('\nwrote ' + OUT);
  }
}
