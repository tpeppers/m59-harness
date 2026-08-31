#!/usr/bin/env node
// Shared static route/exit caches. Offline: no broker, socket, or game server.
//
//   node tools/m59-route-exit-cache-test.mjs

// The bad-inferred book is redirected before importing m59-map: this test retires a
// fixture edge and must never teach a running fleet anything about it.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
function ok(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function same(name, actual, expected) {
  try { assert.deepEqual(actual, expected); ok(name, true); }
  catch { ok(name, false, `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`); }
}

const scratch = mkdtempSync(join(tmpdir(), 'm59-route-exit-cache-'));
const oldBadExits = process.env.M59_BAD_EXITS;
const oldWorldExitCap = process.env.M59_WORLD_EXIT_CACHE_CAP;
process.env.M59_BAD_EXITS = join(scratch, 'bad-exits.json');
// A small configured cap makes LRU eviction observable without hundreds of fixtures.
process.env.M59_WORLD_EXIT_CACHE_CAP = '24';
writeFileSync(process.env.M59_BAD_EXITS, JSON.stringify({ refused: [] }));

try {
  const mapModule = await import('./m59-map.mjs');
  const { World } = await import('./m59-world.mjs');
  const { findPath, forgetInferredExit, passableExits } = mapModule;

  const A = 910001, B = 910002, C = 910003, D = 910004, E = 910005;
  function graph({ connectDestination = true } = {}) {
    const reads = new Map();
    const targets = new Map([
      [A, [B, C]], [B, connectDestination ? [D] : []], [C, [E]], [D, []], [E, []],
    ]);
    const rooms = {};
    for (const [num, to] of targets) {
      const go = to.map((dest, index) => ({
        to: dest, row: index + 1, col: index + 1,
        arriveRow: 1, arriveCol: 1, locked: false,
      }));
      rooms[num] = {
        num, name: `room ${num}`, cls: 'CacheFixture', edgeExits: [],
        get goExits() {
          reads.set(num, (reads.get(num) ?? 0) + 1);
          return go;
        },
      };
    }
    const map = { rooms };
    Object.defineProperty(map, '__reverse', { value: new Map(), enumerable: false });
    return { map, reads };
  }

  console.log('different route destinations share already-projected room exits');
  {
    const fixture = graph();
    const first = findPath(fixture.map, A, D, { danger: false, avoid: null });
    ok('the first fixture route is found', first.found && first.hops.at(-1)?.to === D);
    const afterFirst = new Map(fixture.reads);
    const second = findPath(fixture.map, A, E, { danger: false, avoid: null });
    ok('a different destination is found through the same explored prefix',
       second.found && second.hops.at(-1)?.to === E);
    same('rooms seen by the first BFS do not recompute exitsOf for the second destination',
         [...fixture.reads], [...afterFirst]);
    const immutable = passableExits(fixture.map, A);
    let mutationBlocked = false;
    try { immutable[0].to = D; } catch { mutationBlocked = true; }
    ok('shared passable exits cannot be mutated by a caller',
       Object.isFrozen(immutable) && Object.isFrozen(immutable[0]) && mutationBlocked);
    let routeMutationBlocked = false;
    try { first.hops[0].to = E; } catch { routeMutationBlocked = true; }
    ok('shared cached route answers cannot be mutated by a caller',
       Object.isFrozen(first) && Object.isFrozen(first.hops) &&
       Object.isFrozen(first.hops[0]) && routeMutationBlocked);

    // Function-dependent searches may reuse static exit lists, but never a whole BFS answer.
    let allowedCalls = 0, refusedCalls = 0;
    const allowed = findPath(fixture.map, A, D, {
      danger: false, avoid: null, strictTransit: true,
      transitOk: () => { allowedCalls++; return true; },
    });
    const refused = findPath(fixture.map, A, D, {
      danger: false, avoid: null, strictTransit: true,
      transitOk: () => { refusedCalls++; return false; },
    });
    ok('function-dependent transit searches execute each caller predicate',
       allowedCalls > 0 && refusedCalls > 0);
    ok('function-dependent transit results are not confused by route-cache hits',
       allowed.found === true && refused.found === false);
  }

  console.log('\nmap variants keep both exit and route answers separate');
  {
    const first = graph();
    const variant = graph({ connectDestination: false });
    const found = findPath(first.map, A, D, { danger: false, avoid: null });
    const absent = findPath(variant.map, A, D, { danger: false, avoid: null });
    ok('the first map has its declared route', found.found === true);
    ok('the same room pair on another map does not inherit that cached route',
       absent.found === false);
    passableExits(first.map, A);
    passableExits(variant.map, A);
    ok('each map variant computes its own room-exit projection',
       (first.reads.get(A) ?? 0) > 0 && (variant.reads.get(A) ?? 0) > 0);
  }

  // World.exits() has a cheap dynamic portal tail. A goExits getter counts the real static
  // projection without loading a .roo fixture or overriding any World methods.
  const WORLD_ROOM = 930001;
  function makeWorldMap(onStaticRead = () => {}) {
    const go = [{ locked: true, to: null, row: 1, col: 1 }];
    const room = {
      num: WORLD_ROOM, name: 'Shared cache room', cls: 'CacheFixture', nameRsc: WORLD_ROOM,
      edgeExits: [],
      get goExits() { onStaticRead(); return go; },
    };
    const map = { rooms: { [WORLD_ROOM]: room } };
    Object.defineProperty(map, '__reverse', { value: new Map(), enumerable: false });
    return map;
  }
  function makeWorld(map, { portalId = null, portalName = null } = {}) {
    const objects = new Map();
    if (portalId != null)
      objects.set(portalId, { id: portalId, nameRsc: portalId, flags: 2, col: 9, row: 9 });
    return new World({
      roomNameRsc: WORLD_ROOM,
      selfId: 1,
      self: { id: 1, row: 4, col: 4 },
      room: { objects },
      rsc: { get: id => id === portalId ? portalName : `resource ${id}` },
    }, map);
  }
  let worldStaticReads = 0;
  const worldMap = makeWorldMap(() => worldStaticReads++);

  console.log('\nWorld instances share static exits but never portal observations');
  let firstWorld, secondWorld;
  {
    firstWorld = makeWorld(worldMap, { portalId: 101, portalName: 'Alpha portal' });
    secondWorld = makeWorld(worldMap, { portalId: 202, portalName: 'Beta portal' });
    const first = firstWorld.exits();
    const second = secondWorld.exits();
    ok('the first World computes the static room/origin projection once',
       worldStaticReads === 1);
    ok('another World on the same map/room/origin reuses the static projection',
       worldStaticReads === 1);
    same('each actor still receives only its own dynamic portal id and label',
         [first.find(row => row.kind === 'portal')?.id,
          second.find(row => row.kind === 'portal')?.id,
          first.find(row => row.kind === 'portal')?.name,
          second.find(row => row.kind === 'portal')?.name],
         [101, 202, 'Alpha portal', 'Beta portal']);
    let staticMutationBlocked = false;
    try { first.find(row => row.kind === 'locked_door').stand_on.col = 99; }
    catch { staticMutationBlocked = true; }
    ok('shared static World exits cannot be mutated through an actor result',
       staticMutationBlocked && Object.isFrozen(first.find(row => row.kind === 'locked_door')));

    let variantReads = 0;
    const variantMap = makeWorldMap(() => variantReads++);
    const variantWorld = makeWorld(variantMap);
    variantWorld.exits();
    ok('a World backed by another map object computes independently',
       variantReads === 1);
  }

  console.log('\nretiring an inferred edge invalidates exits, routes, and World projections');
  {
    const X = 920001, Y = 920002;
    let exitReads = 0;
    const inferredMap = { rooms: {
      [X]: {
        num: X, name: 'inferred from', cls: 'CacheFixture', edgeExits: [],
        get goExits() { exitReads++; return []; },
      },
      [Y]: { num: Y, name: 'inferred to', cls: 'CacheFixture', edgeExits: [], goExits: [] },
    } };
    Object.defineProperty(inferredMap, '__reverse', {
      value: new Map([[X, [{
        kind: 'edge', to: Y, direction: 'north', leave: 2, inferred: true,
        how: 'fixture inferred reverse',
      }]]]),
      enumerable: false,
    });

    const beforeRevision = mapModule.routingRevision;
    ok('the inferred edge is initially passable',
       passableExits(inferredMap, X).some(exit => exit.to === Y));
    ok('a route through the inferred edge is initially cached as found',
       findPath(inferredMap, X, Y, { danger: false, avoid: null }).found === true);
    const readsBeforeForget = exitReads;

    forgetInferredExit(X, Y);
    ok('a newly refused inferred edge advances the exported routing revision',
       mapModule.routingRevision === beforeRevision + 1);
    ok('passableExits is recomputed and removes the retired edge',
       !passableExits(inferredMap, X).some(exit => exit.to === Y) &&
         exitReads === readsBeforeForget + 1);
    ok('the cached BFS answer is cleared with the retired edge',
       findPath(inferredMap, X, Y, { danger: false, avoid: null }).found === false);

    // World caches carry the same live revision, even when the retired edge belongs to a
    // different map: badInferred is process-global and can affect every map variant.
    secondWorld.exits();
    ok('the shared World static projection recomputes after routing revision changes',
       worldStaticReads === 2);
    forgetInferredExit(X, Y);
    ok('retiring the same edge twice is a no-op revision-wise',
       mapModule.routingRevision === beforeRevision + 1);
  }

  console.log('\nthe shared World cache remains bounded with LRU eviction');
  {
    let lruReads = 0;
    const lruMap = makeWorldMap(() => lruReads++);
    const world = makeWorld(lruMap);
    for (let row = 0; row <= 24; row++) {
      world.c.self.row = row;
      world.exits();
    }
    ok('25 distinct origins each compute once', lruReads === 25);
    world.c.self.row = 0;
    world.exits();
    ok('the oldest origin is evicted from the 24-entry shared per-map LRU',
       lruReads === 26 && world._exitCache.size <= 1);
  }
} finally {
  if (oldBadExits === undefined) delete process.env.M59_BAD_EXITS;
  else process.env.M59_BAD_EXITS = oldBadExits;
  if (oldWorldExitCap === undefined) delete process.env.M59_WORLD_EXIT_CACHE_CAP;
  else process.env.M59_WORLD_EXIT_CACHE_CAP = oldWorldExitCap;
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nroute/exit caches: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
