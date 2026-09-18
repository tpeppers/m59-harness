#!/usr/bin/env node
// m59-raycast-test.mjs — THE PRUNED COLLISION RAYCAST ANSWERS EXACTLY WHAT THE FULL WALK DID.
//
//   node tools/m59-raycast-test.mjs
//   node tools/m59-raycast-test.mjs --rooms 578,557,599   # a different sample
//
// Offline. Opens no socket, joins nobody, needs no broker. It reads the shipped .roo files.
//
// ======================== WHAT THIS PINS ========================
//
// `RoomGeometry._blockingWall` walked EVERY internal BSP node on every collision query: the
// box test sat at the top of `intersectNode`, returned null, and the traversal then pushed
// both children anyway. So one step's collision test cost O(size of the whole room) instead
// of O(geometry near the body) — a BSP paid for and not used. Hoisting that test into the
// traversal lets a rejected box skip its subtree.
//
// That is a ~30x reduction in node visits on a hot path, which makes it exactly the kind of
// change that is worth nothing if it answers even one query differently: `_blockingWall`
// decides whether a wall stops a body, so a "faster" version that disagrees anywhere is a
// silent movement change, not an optimisation.
//
// SO THIS IS AN EQUIVALENCE TEST BEFORE IT IS A PERFORMANCE TEST. It loads the module TWICE —
// once with M59_RAYCAST_NO_PRUNE=1, which restores the exhaustive walk, and once normally —
// and runs both over the same queries, asserting the answers are identical field for field.
// The reference implementation is the shipped code itself under a flag rather than a
// reimplementation in the test, because a hand-copied reference is a second thing to get
// wrong.
//
// IT ALSO RE-RUNS THE SOUNDNESS SCAN. Pruning is only equivalent if an internal node's box
// contains its descendants' boxes; otherwise a child could sit near the destination while its
// parent's box did not. That is a property of the shipped room files, not of this code, so it
// is re-measured here across all of them rather than asserted once in a commit message.

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const ROO_DIR = process.env.M59_ROO_DIR || 'C:/code/Meridian59/resource/rooms';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  — ' + extra : '')); }
};

if (!existsSync(ROO_DIR)) {
  console.log(`\nno room files at ${ROO_DIR} — set M59_ROO_DIR. Skipping.`);
  process.exit(0);
}

const modUrl = pathToFileURL(join(HERE, 'm59-roo.mjs')).href;
// Two module instances, because the flag is read once at module scope. The query string is
// what makes the second import a distinct module rather than a cache hit.
process.env.M59_RAYCAST_NO_PRUNE = '1';
const slow = await import(modUrl + '?raycast=full');
delete process.env.M59_RAYCAST_NO_PRUNE;
const fast = await import(modUrl + '?raycast=pruned');

console.log('\nthe two builds are what they claim to be');
ok('the reference instance walks every node', slow.RAYCAST_PRUNE === false);
ok('the shipped instance prunes', fast.RAYCAST_PRUNE === true);
ok('and pruning is the DEFAULT, so production gets it without an env var',
   process.env.M59_RAYCAST_NO_PRUNE === undefined && fast.RAYCAST_PRUNE === true);

// ---------------------------------------------------------------- 1. soundness, re-measured
console.log('\nevery internal box contains its whole subtree — the premise pruning rests on');
{
  const files = readdirSync(ROO_DIR).filter(f => f.toLowerCase().endsWith('.roo'));
  let rooms = 0, internals = 0, violations = 0, unnormalised = 0;
  for (const f of files) {
    let geo;
    try { geo = fast.loadRoo(join(ROO_DIR, f), [ROO_DIR], { strict: true }); } catch { continue; }
    const nodes = geo?.nodes;
    if (!Array.isArray(nodes) || !nodes.length) continue;
    rooms++;
    const byId = new Map(nodes.map(n => [n.node, n]));
    const memo = new Map();
    const extent = id => {
      if (memo.has(id)) return memo.get(id);
      const n = byId.get(id);
      if (!n) return null;
      const b = Array.isArray(n.bbox) && n.bbox.length === 4 ? n.bbox : null;
      let e = b ? [Math.min(b[0], b[2]), Math.min(b[1], b[3]),
                   Math.max(b[0], b[2]), Math.max(b[1], b[3])] : null;
      memo.set(id, e);
      for (const child of [n.positive, n.negative]) {
        if (!child) continue;
        const c = extent(child);
        if (!c) continue;
        e = e ? [Math.min(e[0], c[0]), Math.min(e[1], c[1]),
                 Math.max(e[2], c[2]), Math.max(e[3], c[3])] : c.slice();
      }
      memo.set(id, e);
      return e;
    };
    for (const n of nodes) {
      if (n.type !== 'internal') continue;
      internals++;
      const b = n.bbox;
      if (!Array.isArray(b) || b.length !== 4) continue;
      if (b[0] > b[2] || b[1] > b[3]) unnormalised++;
      const sub = extent(n.node);
      if (!sub) continue;
      if (Math.max(b[0] - sub[0], b[1] - sub[1], sub[2] - b[2], sub[3] - b[3]) > 1e-6) violations++;
    }
  }
  ok(`scanned a real corpus (${rooms} rooms, ${internals} internal nodes)`,
     rooms > 100 && internals > 10000, `${rooms}/${internals}`);
  ok('no internal box is stored unnormalised', unnormalised === 0, String(unnormalised));
  ok('NO subtree escapes its parent box — so a rejected box cannot hide a hit',
     violations === 0, `${violations} violation(s)`);
}

// ---------------------------------------------------------------- 2. equivalence
const argRooms = (() => {
  const at = process.argv.indexOf('--rooms');
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1].split(',').map(Number) : null;
})();
// Rooms chosen for what they are, not at random: the two worst by measured stalls/min, the
// room the stall COUNT wrongly called second-worst, a big town room, and a farming room that
// stalls zero times. Plus whatever the caller asks for.
const WANT = argRooms ?? [578, 557, 599, 38, 39];

console.log('\nthe pruned walk and the full walk agree, query for query');
{
  const mapFile = join(REPO, 'substrate', 'm59-map.json');
  const map = existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, 'utf8')) : { rooms: {} };
  const { CLIENT_FINENESS, PLAYER_RADIUS } = fast;
  const opts = { playerRadius: PLAYER_RADIUS, playerHeight: 0,
                 roomFlags: 0, overrideDepths: null, motionZ: null };
  // Eight headings at three distances — the shape a mover's fan actually asks.
  const STEPS = [];
  for (let h = 0; h < 8; h++)
    for (const d of [64, 256, 1024])
      STEPS.push([Math.round(Math.cos(h * Math.PI / 4) * d), Math.round(Math.sin(h * Math.PI / 4) * d)]);

  let roomsTested = 0, queries = 0, mismatches = 0, blockedSeen = 0;
  const firstMismatch = [];
  for (const num of WANT) {
    const rooFile = map.rooms?.[String(num)]?.rooFile;
    if (!rooFile || !existsSync(join(ROO_DIR, rooFile))) continue;
    const gSlow = slow.loadRoo(join(ROO_DIR, rooFile), [ROO_DIR], { strict: true });
    const gFast = fast.loadRoo(join(ROO_DIR, rooFile), [ROO_DIR], { strict: true });
    if (!gSlow?.bspRoot || !gFast?.bspRoot) continue;
    roomsTested++;
    const scale = CLIENT_FINENESS / 64;
    for (let row = 1; row <= gFast.rows; row += 2)
      for (let col = 1; col <= gFast.cols; col += 2) {
        const x = (col * 64 + 32 - 64) * scale, y = (row * 64 + 32 - 64) * scale;
        const leafF = gFast.leafAtClient(x, y);
        if (!leafF) continue;
        const leafS = gSlow.leafAtClient(x, y);
        for (const [dx, dy] of STEPS) {
          const from = { x, y }, to = { x: x + dx, y: y + dy };
          const a = gSlow._blockingWall(from, to, leafS, opts);
          const b = gFast._blockingWall(from, to, leafF, opts);
          queries++;
          const norm = h => h ? { reason: h.reason ?? null, index: h.index ?? null } : null;
          const na = norm(a), nb = norm(b);
          if (na) blockedSeen++;
          if (JSON.stringify(na) !== JSON.stringify(nb)) {
            mismatches++;
            if (firstMismatch.length < 3)
              firstMismatch.push({ room: num, from, to, full: na, pruned: nb });
          }
        }
      }
  }
  ok(`exercised a real corpus of queries (${roomsTested} rooms, ${queries} queries)`,
     roomsTested >= 3 && queries > 20000, `${roomsTested} rooms / ${queries} queries`);
  ok('...and enough of them actually hit a wall to be worth something',
     blockedSeen > 1000, `${blockedSeen} blocked`);
  ok('EVERY query agrees: same verdict, same reason, same wall index',
     mismatches === 0, `${mismatches} mismatch(es) ${JSON.stringify(firstMismatch).slice(0, 300)}`);
}

// ---------------------------------------------------------------- 3. it is actually faster
console.log('\nand it visits far fewer nodes, which is the whole point');
{
  const mapFile = join(REPO, 'substrate', 'm59-map.json');
  const map = existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, 'utf8')) : { rooms: {} };
  const rooFile = map.rooms?.['578']?.rooFile;
  if (!rooFile || !existsSync(join(ROO_DIR, rooFile))) {
    console.log('  (room 578 unavailable; skipping the timing check)');
  } else {
    const { CLIENT_FINENESS, PLAYER_RADIUS } = fast;
    const opts = { playerRadius: PLAYER_RADIUS, playerHeight: 0,
                   roomFlags: 0, overrideDepths: null, motionZ: null };
    const gSlow = slow.loadRoo(join(ROO_DIR, rooFile), [ROO_DIR], { strict: true });
    const gFast = fast.loadRoo(join(ROO_DIR, rooFile), [ROO_DIR], { strict: true });
    const scale = CLIENT_FINENESS / 64;
    const pts = [];
    for (let row = 1; row <= gFast.rows; row += 3)
      for (let col = 1; col <= gFast.cols; col += 3) {
        const x = (col * 64 + 32 - 64) * scale, y = (row * 64 + 32 - 64) * scale;
        if (gFast.leafAtClient(x, y)) pts.push([x, y]);
      }
    const run = (geo, reps) => {
      const t0 = process.hrtime.bigint();
      for (let r = 0; r < reps; r++)
        for (const [x, y] of pts) {
          const leaf = geo.leafAtClient(x, y);
          geo._blockingWall({ x, y }, { x: x + 256, y: y + 256 }, leaf, opts);
        }
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };
    run(gFast, 2); run(gSlow, 2);                       // warm both
    const msFast = run(gFast, 10), msSlow = run(gSlow, 10);
    const speedup = msSlow / msFast;
    console.log(`  room 578, ${pts.length} squares x10: full ${msSlow.toFixed(0)}ms, ` +
                `pruned ${msFast.toFixed(0)}ms, ${speedup.toFixed(1)}x`);
    ok('the pruned walk is meaningfully faster, not merely different',
       speedup > 3, `${speedup.toFixed(2)}x`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
