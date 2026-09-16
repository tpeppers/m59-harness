import { loadMap } from './tools/m59-map.mjs';
import { attachStepMasks } from './tools/m59-routes.mjs';
import { World, spreadEdges } from './tools/m59-world.mjs';
import { orderExits } from './tools/m59-game.mjs';
import { sharedRoomGeometry } from './tools/m59-roo.mjs';

const ROOM = Number(process.argv[2] || 583);
const TO   = Number(process.argv[3] || 593);

const map = loadMap();
const masks = attachStepMasks(map);
const room = map.rooms[String(ROOM)];
const geo = sharedRoomGeometry(room);
console.log('room', ROOM, room.name, '| masks attached:', masks.attached, '| hasStepMask:', geo.hasStepMask);

const fake = { roomNameRsc: room.nameRsc, roomRsc: room.roomRsc, room: { id: room.objId }, self: null };
const w = new World(fake, map);

// Sample several starting squares across the room's walkable body.
const starts = [];
for (let r = 2; r < 60; r += 6) for (let c = 2; c < 60; c += 6) {
  try { if (geo.walkable(r, c)) starts.push({ row: r, col: c }); } catch {}
}
console.log('sampling', starts.length, 'start squares\n');

const seen = new Map();
for (const me of starts.slice(0, 40)) {
  let exits;
  try { exits = w._computeExits(room, geo, me, { row: me.row, col: me.col }); } catch (e) { continue; }
  const mine = exits.filter(e => Number(e.to) === TO);
  const spread = spreadEdges(mine);
  const ordered = orderExits(spread);
  const squares = ordered.map(e => 'r' + e.stand_on?.row + 'c' + e.stand_on?.col);
  const first3 = squares.slice(0, 3).join(' ');
  const key = mine.length + ' entr | first3: ' + first3 + ' | distinct ' + new Set(squares).size + '/' + squares.length;
  seen.set(key, (seen.get(key) || 0) + 1);
}
for (const [k, n] of [...seen].sort((a,b)=>b[1]-a[1]))
  console.log(String(n).padStart(3), 'x  ', k);
