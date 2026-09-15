// Walk the Bookmakers hall's timed doors from their reachable trigger sides.
// The closed-state geometry identifies which section the character occupies;
// actual movement always uses the live, collision-checked session geometry.
import { readFileSync } from 'node:fs';
import { RoomGeometry, applySectorHeights } from './m59-roo.mjs';
import { loadMap } from './m59-map.mjs';

let closed;
const anchors = [[2,32],[5,28],[17,10],[7,8],[18,4]];
const doors = [
  { sector: 59, inward: [[3,28],[5,28]], outward: [[4,28],[2,28]] },
  { sector: 55, inward: [[19,10],[17,10]], outward: [[18,10],[20,10]] },
  { sector: 53, inward: [[13,13],[11,13]], outward: [[11,13],[13,13]] },
  { sector: 3, inward: [[7,7],[7,4]], outward: [[7,4],[7,8]], secret: true },
];
export function guildSection(row, col) {
  if (!closed) {
    const data = JSON.parse(readFileSync(new URL('../substrate/m59-ceiling-doors.json', import.meta.url))).rooms[714];
    closed = RoomGeometry.fromJSON(loadMap().rooms[714].roo);
    const state = data.states[data.doors.map(d => d.closed).join(',')];
    applySectorHeights(closed, state.sectors, { mask: Buffer.from(state.mask, 'base64') });
    closed.attachStepMask(Buffer.from(state.mask, 'base64'));
  }
  return anchors.findIndex(([r,c]) => closed.path(row, col, r, c).found && closed.path(r, c, row, col).found);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function guildPassage(k, destination, isInterrupted) {
  const s = k.s, c = s.need();
  const guard = () => { if (isInterrupted()) throw new Error('guild passage paused for survival'); };
  for (let leg = 0; leg < 8; leg++) {
    if (isInterrupted()) throw new Error('guild passage paused for survival');
    const section = guildSection(c.self.row, c.self.col);
    if (section === destination) return;
    if (section < 0) throw new Error('guild position is outside the known passage');
    const inward = section < destination, door = doors[inward ? section : section - 1];
    const [trigger, across] = inward ? door.inward : door.outward;
    await s.walkTo(trigger[1], trigger[0], { maxSteps: 80, beforeMutation: guard });
    if (c.self.row !== trigger[0] || c.self.col !== trigger[1])
      throw new Error(`guild door ${door.sector} trigger not reached`);
    let crossed = false;
    for (let attempt = 0; attempt < 3 && !crossed; attempt++) {
      if (isInterrupted()) throw new Error('guild passage paused for survival');
      const since = c.evSeq;
      if (door.secret) {
        if (!(await k.sayHallPassword()).ok) throw new Error('guild chest key unavailable');
      } else await s.pacer.submit('move', () => { guard(); return c.go(); });
      await c.waitFor({ since, kinds: ['sector-height'], timeoutMs: 350 });
      // Known ceiling animations settle in at most 1.9s. Never wait out a
      // generic 8s invalidation: that would miss this door's five-second window.
      const until = Math.min(Date.now() + 2200, c.room.collisionInvalidated?.until ?? Date.now());
      while (Date.now() < until && !isInterrupted()) await sleep(Math.min(100, until - Date.now()));
      if (isInterrupted()) throw new Error('guild passage paused for survival');
      await s.walkTo(across[1], across[0], { maxSteps: 5, beforeMutation: guard });
      crossed = guildSection(c.self.row, c.self.col) === section + (inward ? 1 : -1);
      if (!crossed && attempt < 2) {
        // GO while a door is already open does not restart its five-second
        // timer. Let that cycle finish, then request a fresh opening.
        const retryAt = Date.now() + 5200;
        while (Date.now() < retryAt && !isInterrupted()) await sleep(100);
      }
    }
    if (!crossed) throw new Error(`guild door ${door.sector} could not be crossed`);
  }
  throw new Error('guild passage exceeded its door limit');
}
