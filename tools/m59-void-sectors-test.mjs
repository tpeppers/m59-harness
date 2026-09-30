// Offline guard for VOID SECTORS (substrate/m59-void-sectors.json, RoomGeometry.voidSectors,
// tools/m59-void-sectors.mjs), against the live map of room 537, Faronath. Opens no socket.
//
//   node tools/m59-void-sectors-test.mjs
import assert from 'node:assert/strict';
import { loadMap } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { sharedRoomGeometry } from './m59-roo.mjs';
import { voidCandidates } from './m59-void-sectors.mjs';

const map = loadMap();
const masks = attachStepMasks(map);
const geo = sharedRoomGeometry(map.rooms[537]);
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${name}`); };

ok('the detector finds the filler: sector 1 is entered from nowhere', () => {
  // (Its stand-point count is zero now that it is declared: that is the declaration working.
  // Before it, sector 1 held the stand points of 1,629 of the room's 2,450 squares.)
  const v = voidCandidates(map, 537);
  assert.ok(v.reached.length > 10, 'the bulbs are reached from the entries');
  assert.ok(!v.reached.includes(1), 'the filler is not');
  assert.ok(!v.candidates.some(c => c.sector === 1), 'and nothing stands in it any more');
});

ok('the declared void is never a stand point', () => {
  assert.deepEqual([...geo.voidSectors()], [1]);
  assert.equal(geo.standPoint(34, 22), null, 'r34c22 is the gap between two bulbs');
  assert.equal(geo.standPoint(36, 19), null);
  const sp = geo.standPoint(34, 24);
  assert.ok(sp && geo.leafAtClient(sp.x, sp.y).sectorNum !== 1, 'the bulb square keeps its ground');
});

ok('the wall at r34c24 is one-way, which is the whole mechanism', () => {
  const inside = { x: 24064, y: 34304 }, outside = { x: 22016, y: 34304 };
  const out = geo.traceFineMoveClient(inside.x, inside.y, outside.x, outside.y, { slide: false });
  const back = geo.traceFineMoveClient(outside.x, outside.y, inside.x, inside.y, { slide: false });
  assert.ok(!out || Math.hypot(out.x - outside.x, out.y - outside.y) > 512, 'bulb -> filler is refused');
  assert.ok(back && Math.hypot(back.x - inside.x, back.y - inside.y) < 64, 'filler -> bulb is free');
});

// The rest needs the rebaked mask: a table baked before the declaration still joins the gap.
if (masks?.ok && geo.hasStepMask) {
  for (const [a, b] of [[[34, 24], [42, 12]], [[34, 24], [14, 17]], [[42, 12], [14, 17]]]) {
    ok(`r${a[0]}c${a[1]} -> r${b[0]}c${b[1]} goes AROUND, and every step lands`, () => {
      const p = geo.path(a[0], a[1], b[0], b[1]);
      assert.ok(p.found);
      let sp = geo.standPoint(a[0], a[1]);
      for (const s of p.steps) {
        const to = geo.standPoint(s.row, s.col);
        assert.ok(to, `r${s.row}c${s.col} is on the route but has no stand point`);
        const t = geo.traceFineMoveClient(sp.x, sp.y, to.x, to.y, { slide: true });
        assert.ok(t && Math.hypot(t.x - to.x, t.y - to.y) <= 512, `r${s.row}c${s.col} does not land`);
        sp = to;
      }
      assert.ok(!p.steps.some(s => s.row === 34 && s.col === 22), 'not through the gap');
    });
  }
} else console.log('skip route checks: no current step mask (run node tools/m59-routebake.mjs --rooms 537 --resume)');

console.log(`\n${n} passed`);
