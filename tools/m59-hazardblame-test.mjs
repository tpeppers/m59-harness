#!/usr/bin/env node
// A HAZARD IS BLAMED ONLY WHEN IT WAS IN THE WAY — offline, no socket, no roster, no fleet.
//
//   node tools/m59-hazardblame-test.mjs
//
// THE BUG. `findPath` appended "without crossing 555 (...)" and set `blocked_by_hazard` whenever
// the final search failed and the forbidden set was non-empty — without ever checking that a
// hazard was on any candidate route. So EVERY unroutable pair in the game got the same sentence,
// naming rooms that had nothing to do with it.
//
// MEASURED 2026-09-10. Asked for 38 -> 48 (Castle Victoria -> The Temple of Shal'ille) while the
// 534 -> 48 trigger was missing from m59-codeexits.json, it answered
//
//     found: false, blocked_by_hazard: [555, 40]
//     "no route from 38 to 48 in the graph without crossing 555 (The Forest Shrine — acid gas
//      puzzle, kills outright (e5.kod:452 PunishPlayer) ...)"
//
// The real reason was that NOTHING DECLARES AN EDGE INTO 48 — the temple's only inbound is that
// trigger — so there was no route for a hazard to be on at all. And 555 is a DEAD END: its whole
// exit list is `[556]`, so nothing can cross it, ever. Room 40 had been added to NEVER_ENTER
// hours earlier and was nowhere near.
//
// WHAT IT COST. A session tested fourteen origins, received this manufactured sentence fourteen
// times, and reported "room 48 is unreachable from all 14 origins I tested — every inbound path
// crosses 555". One bug repeated fourteen times reads exactly like corroboration. The operator
// broke it open from the shape alone: "It's my understanding that room 555 is a dead-end with a
// shrine and only one entrance/exit, why is it being routed along the planned paths?" It was not.
//
// This is the same family as the rest of tonight: an instrument that cannot produce the value
// that would show the problem, so it produces a confident wrong one instead.
import { findPath, NEVER_ENTER, hazardReason } from './m59-map.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '  — ' + extra : ''}`); }
};

// Synthetic maps, because the point is the DECISION and the real map cannot express both cases:
// the real 555 is a dead end, so on the live graph the "genuinely blocked in transit" branch has
// no natural example — which is itself part of the finding.
const room = (num, tos) => ({ num, name: 'synthetic ' + num, rows: 10, cols: 10,
                              edgeExits: tos.map(to => ({ to })), goExits: [] });

console.log('');
console.log('the real 555 is a DEAD END, which is why it can never be crossed');
{
  ok('555 is a declared hazard', NEVER_ENTER.has(555));
  ok('and its reason still cites the kod', /e5\.kod:452/.test(hazardReason(555) ?? ''));
  // The live map is asserted elsewhere; here we only need the claim that made the bug visible.
  ok('hazardReason answers null for an ordinary room', hazardReason(544) === null);
}

console.log('');
console.log('WHEN A HAZARD REALLY IS THE OBSTACLE, it is still named');
{
  // 900 -> 555 -> 901, and 555 is given two exits so it really is a corridor. This is the branch
  // that must not be lost while fixing the false blame.
  const map = { rooms: { 900: room(900, [555]), 555: room(555, [900, 901]), 901: room(901, [555]) } };
  const r = findPath(map, 900, 901, {});
  ok('the route is refused', r.found === false);
  ok('and the hazard is blamed, because it IS the obstacle',
     JSON.stringify(r.blocked_by_hazard) === JSON.stringify([555]));
  ok('the reason names the room and the mechanism',
     /555/.test(r.reason ?? '') && /acid gas/.test(r.reason ?? ''));
  ok('and it does NOT claim hazards were irrelevant',
     r.hazards_were_not_the_obstacle === undefined);
}

console.log('');
console.log('WHEN THERE WAS NO ROUTE AT ALL, no hazard is blamed');
{
  // 910 and 911 are simply not connected. Before the fix this produced
  // `blocked_by_hazard: [555, 40]` and a sentence about acid gas.
  const map = { rooms: { 910: room(910, []), 911: room(911, []) } };
  const r = findPath(map, 910, 911, {});
  ok('the route is refused', r.found === false);
  ok('and NOTHING is blamed', !r.blocked_by_hazard, JSON.stringify(r.blocked_by_hazard));
  // Saying "not a hazard" out loud is the part that sends the reader to the exits and the
  // trigger file instead of to a death room.
  ok('it says out loud that hazards were not the obstacle',
     Array.isArray(r.hazards_were_not_the_obstacle));
  ok('and points at the graph itself as the place to look',
     /NOT because of a hazard/.test(r.reason ?? '') &&
     /missing exit|trigger that is not|nothing arrives/.test(r.reason ?? ''), r.reason);
}

console.log('');
console.log('AND A CLEAN ALTERNATIVE IS TAKEN SILENTLY, with no hazard mentioned at all');
{
  const map = { rooms: { 900: room(900, [555, 902]), 555: room(555, [900, 901]),
                         902: room(902, [900, 901]), 901: room(901, [555, 902]) } };
  const r = findPath(map, 900, 901, {});
  ok('the route is found', r.found === true);
  ok('and it goes round the hazard rather than through it',
     !(r.hops ?? []).some(h => Number(h.to) === 555),
     (r.hops ?? []).map(h => h.to).join('->'));
  ok('with nothing blamed on a successful route', !r.blocked_by_hazard);
}

console.log('');
console.log('the destination check is untouched — going INTO one is still refused');
{
  // A separate and earlier branch: `allowHazardDestination` is the "are you sure?" that defaults
  // to no. It returns before any of the above and must keep doing so.
  const map = { rooms: { 556: room(556, [555]), 555: room(555, [556]) } };
  const r = findPath(map, 556, 555, {});
  ok('routing TO a hazard is refused', r.found === false);
  ok('and it says it is refusing the DESTINATION rather than a crossing',
     /refusing to route to 555/.test(r.reason ?? ''), r.reason);
  ok('but an operator may still ask for it by name',
     findPath(map, 556, 555, { allowHazardDestination: true }).found === true);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
