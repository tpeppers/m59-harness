#!/usr/bin/env node
// Bake every combination of GuildHall14's five timed ceiling doors. Runtime
// never builds masks or guesses how independently moving doors compose.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { geometryWithSectorHeights, heightKodToClient, STEP_MASK_VERSION } from './m59-roo.mjs';

const here = p => new URL(p, import.meta.url);
const map = JSON.parse(readFileSync(here('../substrate/m59-map.json')));
const routes = JSON.parse(readFileSync(here('../substrate/m59-routes.json')));
const room = map.rooms[714];
const buf = readFileSync(join(process.env.M59_ROOT || 'C:/code/Meridian59', 'resource/rooms', room.rooFile));
const base = geometryWithSectorHeights(buf, {}, { mask: false }).geometry;
const baseline = Buffer.from(base.buildStepMask()).toString('base64');
if (baseline !== routes.rooms[714].stepMask) throw new Error('Guild hall baseline differs from the routing bake');
// guildh14.kod constants; five-second timer, speed 50 KOD height units/sec.
const doors = [[3,160,250],[53,160,240],[55,160,230],[58,100,190],[59,100,190]]
  .map(([id, closed, open]) => ({ id, closed, open,
    indices: base.sectors.flatMap((s, i) => s.serverId === id ? [i] : []) }));
if (doors.some(d => !d.indices.length)) throw new Error('Missing guild ceiling sector');
const states = {};
for (let bits = 0; bits < 32; bits++) {
  const heights = doors.map((d, i) => bits & (1 << i) ? d.open : d.closed);
  const overrides = Object.fromEntries(doors.map((d, i) => [d.id, { ceiling: heights[i] }]));
  const geometry = geometryWithSectorHeights(buf, overrides, { mask: false }).geometry;
  states[heights.join(',')] = {
    mask: Buffer.from(geometry.buildStepMask()).toString('base64'),
    sectors: doors.flatMap((d, i) => d.indices.map(index => ({ index, ceiling: heightKodToClient(heights[i]) }))),
  };
  console.log(`Guild ceiling state ${bits + 1}/32 baked`);
}
const table = { version: STEP_MASK_VERSION, rooms: { 714: { security: base.security, baseline, doors, states } } };
if (process.argv.includes('--write')) writeFileSync(here('../substrate/m59-ceiling-doors.json'), JSON.stringify(table) + '\n');
else console.log('Pass --write to save the verified masks.');
