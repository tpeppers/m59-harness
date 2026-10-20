// The checked fine cut inside one room (m59-fine-cut-walk.mjs), offline, on Ukgoth (599)'s real geometry: the squares
// the 2026-10-20 lockdown recall actually landed bodies on, walked to the NE-corner post.
import assert from 'node:assert/strict';
import { roomGeometry } from './m59-ground.mjs';
import { planFineCutWalk, parseSquare, squareCentreClient, cutRailFile } from './m59-fine-cut-walk.mjs';
import { script, NE_POST } from './fleetscripts/ukgoth-walk.mjs';

let count = 0;
const test = (name, fn) => { fn(); count++; console.log('ok ' + name); };
const geo = roomGeometry(599);
const at = (row, col, dx = 0, dy = 0) => { const c = squareCentreClient({ row, col }); return { x: c.x + dx, y: c.y + dy }; };

test('squares parse as rNcM or {row,col}, and nothing else', () => {
  assert.deepEqual(parseSquare('r4c61'), { row: 4, col: 61 });
  assert.deepEqual(parseSquare({ row: 2, col: 27 }), { row: 2, col: 27 });
  assert.throws(() => parseSquare('4,61'), /not a square/);
});
test('the centre of a square: col is x, row is y, 1024 client units a square', () => {
  assert.deepEqual(squareCentreClient({ row: 4, col: 61 }), { x: 61952, y: 3584 });
});
for (const [row, col, who] of [[2, 27, 'the room-2 entrance square, on the north edge (where the recall lands everyone)'],
                                [3, 27, 'the front of the 15:2xZ stack (Sweetums walked from here in 131 s)'],
                                [9, 38, 'mid-room (Kermit, second try)']]) {
  test(`a checked cut from ${who} to the NE post`, () => {
    const p = planFineCutWalk(geo, at(row, col), NE_POST, { room: 599 });
    assert.equal(p.ok, true, p.why);
    assert.equal(p.route.rail_complete, true); assert.equal(p.check.ok, true); assert.equal(p.route.to, NE_POST);
    const end = p.points.at(-1); assert.ok(Math.hypot(end.x - 61952, end.y - 3584) <= 128, JSON.stringify(end));
  });
}
test('a target outside the room and a body with no fine position are refused, not guessed', () => {
  assert.equal(planFineCutWalk(geo, at(2, 27), 'r400c400').ok, false);
  assert.match(planFineCutWalk(geo, {}, NE_POST).why, /no fine position/);
});
test('the rail file holds the one route under the stone name fineclimb is asked for', () => {
  const p = planFineCutWalk(geo, at(3, 27), NE_POST, { room: 599 });
  assert.deepEqual(Object.keys(cutRailFile(599, p.route).stones[0]), ['node', 'room', 'routes']);
  assert.equal(cutRailFile(599, p.route).stones[0].node, 'cut');
});
// Awaited at top level: the runner above is synchronous, and an unawaited rejection would pass vacuously.
await assert.rejects(script.steps({ agents: 't1,t2', to: NE_POST }), /one character at a time/);
await assert.rejects(script.steps({ agents: 't1', to: 'nowhere' }), /not a square/);
count++; console.log('ok the errand takes one character at a time and refuses a malformed target before anything walks');
console.log(count + ' fine cut walk checks passed');
