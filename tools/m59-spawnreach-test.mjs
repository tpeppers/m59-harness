#!/usr/bin/env node
// SPAWN REACH (m59-spawnreach.mjs), offline: the kod parse, the graph arithmetic on a toy room, and the Icky Cave (27)
// on the real map -- every spawn point at home, and the r35c46-r35c48 trap that was a stand point on a ledge edge.
//
//   node tools/m59-spawnreach-test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMap } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { sharedRoomGeometry } from './m59-roo.mjs';
import { auditReach, components, loadGenerators, parseGenerators, proposeRegion, stepGraph } from './m59-spawnreach.mjs';

const W = (row, col) => ({ row, col });
const sq = p => `r${p.row}c${p.col}`;

test('plGenerators parse as [row, col], across lines, and a class without one is null', () => {
  const kod = `Cave2 is MonsterRoom\n  plGenerators = [ [51, 14], [50, 34],\n                   [35, 58] ];\n`;
  assert.deepEqual(parseGenerators(kod), [W(51, 14), W(50, 34), W(35, 58)]);
  assert.equal(parseGenerators('Inn is Room\n'), null);
});

test('the shipped generator table carries the Icky Cave\'s thirteen, as cave2.kod writes them', () => {
  const g = loadGenerators();
  assert.ok(g?.rooms?.['27'], 'substrate/m59-generators.json: run m59-spawnreach.mjs --extract');
  assert.equal(g.rooms['27'].generators.length, 13);
  assert.deepEqual(g.rooms['27'].generators[0], W(51, 14));
  assert.ok(Object.keys(g.rooms).length > 100);
});

// A toy room: 1 x 6, steps east everywhere, west everywhere except out of square 5 -- so 5..6 is a trap.
function toy() {
  const rows = 1, cols = 6;
  const westBlocked = new Set([5]);
  return { rows, cols, standable: () => true,
    neighbors(r, c) {
      const out = [];
      if (c < cols) out.push({ row: r, col: c + 1 });
      if (c > 1 && !westBlocked.has(c)) out.push({ row: r, col: c - 1 });
      return out;
    } };
}

test('reach on a toy room: home, a trap you can enter and not leave, and the spawn statuses', () => {
  const geo = toy();
  const a = auditReach(geo, { generators: [W(1, 2), W(1, 6)], anchors: [{ kind: 'edge', row: 1, col: 1 }] });
  assert.equal(a.home_size, 4);
  assert.deepEqual(a.generators.map(g => g.status), ['ok', 'trap']);
  assert.equal(a.regions.length, 1);
  assert.deepEqual(a.regions[0].squares.map(sq).sort(), ['r1c5', 'r1c6']);
  assert.deepEqual(a.regions[0].generators, ['r1c6']);
  assert.ok(a.regions[0].entered_from.includes('r1c4->r1c5'));
  assert.equal(a.regions[0].own_exit, false);
});

test('a region holding its own exit is another part of the room, never a fault', () => {
  const a = auditReach(toy(), { generators: [W(1, 6)], anchors: [{ kind: 'edge', row: 1, col: 1 }, { kind: 'edge', row: 1, col: 6 }] });
  assert.equal(a.regions[0].own_exit, true);
  assert.equal(a.generators[0].status, 'own_exit');
});

test('components: strongly connected, one id per mutual-reach set', () => {
  const g = stepGraph(toy());
  const comp = components(g);
  assert.equal(new Set([0, 1, 2, 3].map(k => comp[k])).size, 1);
  assert.notEqual(comp[4], comp[3]);
});

// --- the real cave ----------------------------------------------------------------------------------------------
const map = loadMap(); attachStepMasks(map);
const geo = sharedRoomGeometry(map.rooms['27']);
let routes = null;
try { routes = (await import('node:fs')).readFileSync(new URL('../substrate/m59-routes.json', import.meta.url), 'utf8'); routes = JSON.parse(routes); } catch { routes = null; }
const anchors = routes?.rooms?.['27']?.anchors ?? [];

test('Icky Cave: every one of its thirteen spawn points is at home, and no trap region is left', () => {
  const a = auditReach(geo, { generators: loadGenerators().rooms['27'].generators, anchors });
  assert.deepEqual(a.generators.filter(g => g.status !== 'ok').map(sq), []);
  assert.deepEqual(a.regions.filter(r => !r.own_exit).map(r => r.squares.map(sq)), [],
    'the r35c46-r35c48 trap is gone since its stand points were declared and the room re-baked');
});

test('the proposal machinery re-finds the fix: with the declared points masked back to centres, the trap reappears and its proposals verify', () => {
  // Undo the declared stand points in memory only, and decide steps by trace rather than the (fixed) baked mask.
  const memo = (geo._standPoint ??= new Array(geo.rows * geo.cols));
  const trapSquares = [W(35, 46), W(35, 47), W(35, 48), W(36, 47), W(36, 48)];
  const saved = trapSquares.map(s => [s, memo[(s.row - 1) * geo.cols + (s.col - 1)]]);
  const centres = trapSquares.map(s => ({ x: (s.col - 1) * 1024 + 512, y: (s.row - 1) * 1024 + 512 }));
  trapSquares.forEach((s, i) => { memo[(s.row - 1) * geo.cols + (s.col - 1)] = centres[i]; });
  geo._moverStepCache = new Map();
  const near = new Set(trapSquares.flatMap(s => [-1, 0, 1].flatMap(dr => [-1, 0, 1].map(dc => `r${s.row + dr}c${s.col + dc}`))));
  try {
    const graph = stepGraph(geo, { stepOk: (r, c, rr, cc) =>
      near.has(`r${r}c${c}`) || near.has(`r${rr}c${cc}`) ? geo._traceMoverStep(r, c, rr, cc) : geo.moverStepLands(r, c, rr, cc) });
    const a = auditReach(geo, { anchors, graph });
    const trap = a.regions.find(r => r.squares.some(s => s.row === 35 && s.col === 48));
    assert.ok(trap, 'centre stand points recreate the trap');
    assert.equal(trap.kind, 'trap');
    const homeKey = a.comp.findIndex(c => c === a.home);
    const r = proposeRegion(geo, { anchors, homeSquare: graph.at(homeKey) }, trap);
    assert.equal(r.verified, true);
    assert.ok(r.proposals.some(p => p.row === 35 && p.col === 46 && p.after.out > p.before.out), 'r35c46 is the square that lets the region out');
  } finally {
    for (const [s, was] of saved) memo[(s.row - 1) * geo.cols + (s.col - 1)] = was;
    geo._moverStepCache = new Map();
  }
});
