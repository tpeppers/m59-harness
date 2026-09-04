#!/usr/bin/env node
// BAKE THE DOORS OPEN — one step mask per gating sector state, merged into the routing table.
//
//   node tools/m59-doorbake.mjs                 # what it would bake, and whether it can
//   node tools/m59-doorbake.mjs --write         # merge the variants into substrate/m59-routes.json
//   node tools/m59-doorbake.mjs --room 951      # just one
//
// Needs the .roo files (M59_ROOT, or the usual checkout beside this one).
//
// WHY A SEPARATE TOOL RATHER THAN PART OF m59-routebake. The route bake reads
// `m59-map.json`, and the baked collision payload does not carry a sector's SERVER ID —
// the number the kod and the wire both use to name a door. Adding it means bumping
// COLLISION_VERSION and rebuilding the world's geometry to change nothing anybody reads
// yet. Reading the .roo files here gets the same answer without that, and pays for itself
// by being able to CHECK: the baseline mask this tool computes must reproduce the one
// already in the table, byte for byte, or the variants would be from a different model of
// the same room and worse than nothing. That check is the point of the tool.
//
// WHAT A VARIANT IS, AND WHAT IT IS KEYED ON. `m59-varsectors.mjs` lists the sectors this
// world MOVES and marks the floors that cross MAX_STEP_HEIGHT — those are doors: the same
// square is passable at one height and not at the other. For each, this bakes the room
// again with that sector at each height the kod ever sets it to.
//
// The key is `sector<N>@<kodHeight>`, stored UNDER THE ROOM. The room is the container, so
// it is not in the key; the sector is, because a room can have several independent doors —
// Blackstone Keep has three, east, west and the feast door, and "room 951 at height 356"
// could not say which one moved. `N` is the sector's id inside the .roo (our parser calls
// the field `serverId`, which is a poor name: it is not about which server, it is the
// number the kod writes as `#sector=3` and the number BP_SECTOR_MOVE puts on the wire).
//
// ONLY THE STATES THAT DIFFER ARE STORED. One height of every pair is whatever the .roo
// shipped, which is already `stepMask` — keeping it too would store the baseline again
// once per door. And some predicted doors move nothing at all. Of sixteen states across
// three rooms, six differ and ten were the baseline under another name.
//
// The runtime already learns the live height from BP_SECTOR_MOVE (m59-client.mjs), so
// picking the matching mask is a lookup rather than a trace.
//
// WHAT IT IS WORTH. Blackstone Keep's feast exits are stranded in a 38-square island as
// shipped and part of a 682-square body with the door open — that is the whole difference
// between the Duke's Feast Hall being reachable and a fleet walking eleven hops to stand
// next to a door it cannot open. Ukgoth's is worth 85 squares in a room this fleet crosses
// daily.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geometryWithSectorHeights, STEP_MASK_VERSION } from './m59-roo.mjs';

const HERE = (p) => fileURLToPath(new URL(p, import.meta.url));
const ROUTES = HERE('../substrate/m59-routes.json');
const VARSECTORS = HERE('../substrate/m59-variable-sectors.json');
const ROOMS_DIR = process.env.M59_ROOT
  ? join(process.env.M59_ROOT, 'resource/rooms')
  : 'C:/code/Meridian59/resource/rooms';

const b64 = (mask) => Buffer.from(mask).toString('base64');

/**
 * Every (sector, height) a room's doors can be in — the states worth a mask.
 *
 * Only `gates` sectors: a floor that never crosses the step limit changes nothing a mask
 * can express, and baking it would double the table for no answer. A moving CEILING is
 * excluded for the opposite reason — `headroom_risk` says we do not know, and this tool
 * would be inventing an answer rather than computing one.
 */
export function doorStates(roomEntry) {
  const out = [];
  for (const sector of roomEntry.sectors ?? []) {
    if (!sector.gates) continue;
    for (const height of sector.heights) out.push({ sector: sector.serverId ?? sector.sector, height, name: sector.name });
  }
  return out;
}

export function bakeRoomDoors(roomNum, rooFile, states, { baselineMask = null } = {}) {
  const path = join(ROOMS_DIR, rooFile);
  if (!existsSync(path)) return { room: roomNum, skipped: `no ${rooFile} under ${ROOMS_DIR}` };
  const buf = readFileSync(path);

  // THE CHECK THAT MAKES THE REST TRUSTWORTHY. If the mask this tool computes for the room
  // AS SHIPPED is not the one already in the routing table, then the two are modelling the
  // room differently and a variant from here would be a confident map of the wrong doors —
  // exactly the failure STEP_MASK_VERSION exists to prevent, arriving by another door.
  const base = geometryWithSectorHeights(buf, {}, { file: rooFile });
  const baseB64 = b64(base.geometry.buildStepMask());
  if (baselineMask != null && baseB64 !== baselineMask)
    return { room: roomNum, refused: 'the baseline mask does not reproduce the routing table\'s — ' +
             'this tool and the route bake disagree about the room, so no variant from here is safe' };

  const variants = {};
  let inert = 0;
  for (const state of states) {
    const { geometry, moved } = geometryWithSectorHeights(buf, { [state.sector]: state.height },
                                                          { file: rooFile });
    if (!moved) continue;                 // a sector this room does not actually have
    const mask = b64(geometry.buildStepMask());
    // A VARIANT THAT EQUALS THE BASELINE IS NOT A VARIANT. Two reasons it happens, and
    // both are common:
    //
    //   * the .roo ships the door in THAT state already, so one height of every pair is
    //     the baseline by definition — storing it means storing the shipped mask again
    //     under a second name, once per door;
    //   * the sector's movement changes no step at all. `m59-varsectors` predicts `gates`
    //     from the kod, which can only see the heights and not the room; in room 532 five
    //     of six predicted doors turn out to move nothing. The bake is the arbiter and
    //     this is where it arbitrates.
    //
    // So the table holds the baseline once, as `stepMask`, and only the states that
    // genuinely differ from it. Measured: room 951 goes from eight variants to four,
    // 532 from six to one.
    if (mask === baseB64) { inert++; continue; }
    variants[`sector${state.sector}@${state.height}`] = mask;
  }
  return { room: roomNum, baseline_matches: baselineMask == null ? null : true,
           variants, count: Object.keys(variants).length, inert };
}

// ---------------------------------------------------------------------------- cli
const argv = process.argv.slice(2);
const only = argv.includes('--room') ? Number(argv[argv.indexOf('--room') + 1]) : null;

const table = JSON.parse(readFileSync(ROUTES, 'utf8'));
const varsectors = JSON.parse(readFileSync(VARSECTORS, 'utf8'));

let baked = 0, refused = 0, skipped = 0, variants = 0, inert = 0;
const results = [];
for (const entry of varsectors.rooms) {
  if (entry.room == null) continue;
  if (only != null && entry.room !== only) continue;
  const states = doorStates(entry);
  if (!states.length) continue;
  const roomTable = table.rooms?.[String(entry.room)];
  if (!roomTable) { skipped++; results.push({ room: entry.room, skipped: 'not in the routing table' }); continue; }
  // The .roo name lives on the baked room; fall back to the kod file's stem, which is the
  // convention this world follows (duke2.kod -> duke2.roo).
  const rooFile = entry.file.split('/').pop().replace(/\.kod$/, '.roo');
  const out = bakeRoomDoors(entry.room, rooFile, states, { baselineMask: roomTable.stepMask ?? null });
  results.push(out);
  if (out.refused) refused++;
  else if (out.skipped) skipped++;
  else { baked++; variants += out.count; inert += out.inert ?? 0; if (argv.includes('--write')) {
    if (out.count) {
      roomTable.stepMaskVariants = out.variants;
      roomTable.stepMaskVariantVersion = STEP_MASK_VERSION;
    } else {
      delete roomTable.stepMaskVariants;
      delete roomTable.stepMaskVariantVersion;
    }
  } }
}

console.log('room   result');
for (const r of results) {
  console.log(String(r.room).padEnd(6),
    r.refused ? `REFUSED — ${r.refused}`
    : r.skipped ? `skipped — ${r.skipped}`
    : `${r.count} variant(s): ${Object.keys(r.variants).join(' ') || '(none — every state is the baseline)'}` +
      (r.inert ? `   [${r.inert} dropped: identical to the baseline]` : ''));
}
console.log('');
console.log(`${baked} room(s) baked, ${variants} variant mask(s) that actually differ, ` +
            `${inert} dropped for being the baseline again, ${refused} refused, ${skipped} skipped.`);

if (argv.includes('--write') && baked) {
  writeFileSync(ROUTES, JSON.stringify(table) + '\n');
  console.log(`wrote ${ROUTES}`);
} else if (!argv.includes('--write')) {
  console.log('(nothing written — pass --write to merge these into the routing table)');
}
