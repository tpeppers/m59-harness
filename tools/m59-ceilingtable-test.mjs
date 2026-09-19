#!/usr/bin/env node
// THE BAKED CEILING-DOOR TABLE, CHECKED AS A FILE — offline, no kod, no .roo, no fleet.
//
//   node tools/m59-ceilingtable-test.mjs
//
// `m59-ceiling-doorbake.mjs` needs the Meridian 59 source tree and several seconds, so it
// cannot run in the offline suite. What CAN is the artifact it produces, and every keeper on
// every fleet reads that artifact directly: `applyCeilingDoors` looks up a state by a key it
// builds from the table's own `doors`, patches the live geometry with `state.sectors`, and
// swaps in `state.mask`. A malformed row there does not throw — it returns null and the room
// silently goes back to being a sealed warren, which is the exact failure the table exists to
// fix and is indistinguishable from not having the table at all.
import { readFileSync } from 'node:fs';
import { STEP_MASK_VERSION } from './m59-roo.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (detail ? ' — ' + detail : '')); }
};

const table = JSON.parse(readFileSync(new URL('../substrate/m59-ceiling-doors.json', import.meta.url), 'utf8'));
const rooms = Object.entries(table.rooms).map(([num, def]) => [Number(num), def]);

console.log('\nthe table as a whole');
// A VERSION MISMATCH IS A SILENT TOTAL DISABLE. `applyCeilingDoors` opens with
// `table.version === STEP_MASK_VERSION && table.rooms[roomNum]`, so a stale bake does not warn
// — every room in it just stops working, everywhere, at once.
ok('the mask version matches the one the runtime enforces',
   table.version === STEP_MASK_VERSION, `${table.version} vs ${STEP_MASK_VERSION}`);
ok('it covers more than the one hand-written room', rooms.length > 1, String(rooms.length));
ok('and room 714 is still in it', !!table.rooms[714]);
// The hand-written bake produced exactly these keys and prod has been running on them. A
// reordering of `doors` changes every key string, which the two readers survive but a rail
// with a stored `state_key` does not.
ok('714 still has its 32 states', Object.keys(table.rooms[714].states).length === 32);
ok('and 714 keeps the hand-written door order',
   table.rooms[714].doors.map(d => d.id).join(',') === '3,53,55,58,59',
   table.rooms[714].doors.map(d => d.id).join(','));

console.log('\nevery room');
// A DOOR'S POSITIONS ARE ITS TWO KOD HEIGHTS AND WHERE THE .roo SHIPS IT — sometimes three
// distinct values. 750's sector 2 animates between 380 and 510 and ships at 520.
const positions = d => [...new Set([d.closed, d.open, d.shipped].filter(h => Number.isFinite(h)))];

let badOrder = [], badArity = [], badHeights = [], badCount = [], badSectors = [], badMask = [];
for (const [num, def] of rooms) {
  const ids = def.doors.map(d => d.id);
  // The key is built by joining heights in door-array order, so the order IS the contract.
  if (JSON.stringify(ids) !== JSON.stringify([...ids].sort((a, b) => a - b))) badOrder.push(num);
  if (def.doors.some(d => !(d.open > d.closed))) badHeights.push(num + ':open<=closed');
  if (def.doors.some(d => !Array.isArray(d.indices) || !d.indices.length)) badSectors.push(num + ':no indices');

  const keys = Object.keys(def.states);
  // A full room holds the product of each door's positions; a partial one holds the resting
  // state, all-open, all-shut and each door moved alone from rest — deduped, so the count is
  // a ceiling rather than an equality. The flag is what a reader uses to decide whether a
  // missing key is a gap or an impossibility, so the two must not disagree.
  const full = def.doors.reduce((n, d) => n * positions(d).length, 1);
  if (!def.partial && keys.length !== full)
    badCount.push(`${num}: ${keys.length} states, expected ${full}`);
  if (def.partial && (full <= 64 || keys.length > 3 + def.doors.reduce((n, d) => n + positions(d).length, 0)))
    badCount.push(`${num}: partial with ${keys.length} of ${full}`);

  for (const key of keys) {
    const hs = key.split(',').map(Number);
    if (hs.length !== def.doors.length) { badArity.push(`${num}:${key}`); continue; }
    // Every height in a key must be a position THAT door can be in. A key carrying a height
    // no door reaches can never be looked up, so it is dead weight that reads as coverage.
    if (hs.some((h, i) => !positions(def.doors[i]).includes(h))) badHeights.push(`${num}:${key}`);
    const st = def.states[key];
    if (typeof st?.mask !== 'string' || st.mask.length < 8) badMask.push(`${num}:${key}`);
    if (!Array.isArray(st?.sectors) || !st.sectors.length
        || st.sectors.some(s => !Number.isInteger(s.index) || !Number.isFinite(s.ceiling)))
      badSectors.push(`${num}:${key}`);
  }
}
ok('doors are sorted by sector id in every room', !badOrder.length, badOrder.join(', '));
ok('every state key names one height per door', !badArity.length, badArity.slice(0, 4).join(', '));
ok('and every height is one that door can actually be at', !badHeights.length, badHeights.slice(0, 4).join(', '));
ok('the state count matches what `partial` claims', !badCount.length, badCount.slice(0, 4).join(', '));
ok('every state carries a mask', !badMask.length, badMask.slice(0, 4).join(', '));
ok('and a sector patch with a real index and ceiling', !badSectors.length, badSectors.slice(0, 4).join(', '));

console.log('\nthe RESTING state — the one a room is in when nobody has touched it');
// THIS IS THE ASSERTION THAT CAUGHT THE BUG, and it is deliberately not "the all-shut state".
// `applyCeilingDoors` falls back to a door's resting height for any door it has not SEEN
// move, and on entering a room that is most of them — so the resting key is the one every
// keeper looks up first, and its mask must be the baseline the routing table already holds.
// Asserting `closed` instead passes on room 714, where the .roo does ship all five shut, and
// fails on 380, 598 and 750, which ship a door OPEN. Baking those as shut would have applied
// a sealed mask to a standing-open passage — the router calling it no route, which is the
// exact failure this table exists to end, reintroduced by the fix for it.
let missingRest = [], restNotBaseline = [], missingShut = [];
for (const [num, def] of rooms) {
  const rest = def.doors.map(d => d.shipped ?? d.closed).join(',');
  if (!def.states[rest]) { missingRest.push(num); continue; }
  if (def.states[rest].mask !== def.baseline) restNotBaseline.push(num);
  if (!def.states[def.doors.map(d => d.closed).join(',')]) missingShut.push(num);
}
ok('every room has the state it rests in', !missingRest.length, missingRest.join(', '));
ok('and that state\'s mask IS the routing bake\'s baseline', !restNotBaseline.length, restNotBaseline.join(', '));
ok('every room also has its all-shut state', !missingShut.length, missingShut.join(', '));
// Three rooms rest with a door open, which is why the fallback cannot be `closed`. If this
// ever reads zero, either the .roo changed or the bake stopped reading the shipped height —
// and the second would be silent.
const restOpen = rooms.filter(([, d]) => d.doors.some(x => x.shipped != null && x.shipped !== x.closed));
ok('and some rooms genuinely rest with a door open', restOpen.length >= 3,
   restOpen.map(([n]) => n).join(', '));

console.log('\nthe rooms that made this worth generalising');
// 802 is the Temple of Qor, whose entrance has been an unexplained alternating sector; 598 is
// the Cragged Mountains, where the fleet has died repeatedly. Neither was reachable by the
// hand-written bake, and both have exactly one moving ceiling.
for (const room of [802, 598, 60, 1006]) ok(`room ${room} is now baked`, !!table.rooms[room]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
