// Walk the Bookmakers hall's timed doors from their reachable trigger sides.
// The closed-state geometry identifies which section the character occupies;
// actual movement always uses the live, collision-checked session geometry.
import { readFileSync } from 'node:fs';
import { RoomGeometry, applySectorHeights } from './m59-roo.mjs';
import { loadMap } from './m59-map.mjs';
import { doorsFor } from './m59-doorplan.mjs';
import { waitForDoorOpen } from './m59-door-wait.mjs';

let closed;
export const anchors = [[2,32],[5,28],[17,10],[7,8],[18,4]];
// EVERY DOOR IN THIS HALL IS SPOKEN, NOT PRESSED — INCLUDING ON THE WAY OUT.
//
// Operator, 2026-09-20: "It's not a traditional 'press space' door, you have to say the guild
// CORRECTED 2026-09-20 by the operator, and the earlier note here was overboard.
//
// It read "every door in this hall is SPOKEN, not pressed" and set `secret: true` on 59, 55
// and 53 as well as 3. That is wrong and it is the expensive direction of wrong: it makes a
// character SAY THE GUILD PASSWORD at three ordinary doors, out loud, in a hall on a shared
// server, to open something that only needed a press and a wait.
//
// What is actually true, in the operator's words: "not EVERY door is a secret door in the
// hall. The west-most door in that hall is the secret door. The rest of the doors are normal
// doors but open slow: all guild hall doors open slow, only the chest room requires the
// password."
//
// So the failure the earlier note was chasing -- `guild door 59 could not be crossed` after
// three attempts -- is a door that had not finished opening yet, not a door listening for a
// word. The verb was right and the patience was not. This matches the kod: `m59-doors.mjs`
// derives 59, 55, 53 and 58 from `SomethingTryGo` handlers, and only sector 3 -- SECRET_DOOR
// in guildh14.kod -- is reached through `SomeoneSaid` comparing against the guild password.
//
// `secret` therefore stays a per-door flag and sector 3 is the only door that carries it.
// The old note follows, kept because the reagent_coop consequence it records is real:
// hall password to open it (even to get out!)". Only sector 3 carried `secret: true`, so the
// crossing below sent `c.go()` for 59, 55 and 53 — the branch is literally
// `if (door.secret) sayHallPassword() else c.go()`. Pressing space at a door that answers only
// to a word does nothing, three times over, and then reports `guild door 59 could not be
// crossed` — which reads as geometry and is a verb.
//
// WHAT IT COST. `reagent_coop` is the ONLY caller of `getFromContainer` in this repository, and
// its `approach()` crosses these doors to get within the 7 squares `user.kod UserGet` wants. So
// this one flag is the whole reason a character standing in its own guild hall cannot draw on
// it: 543 elderberry, 446 mushroom and 490 red mushroom sitting in the chests, none reachable.
// DEPOSITS WERE EQUALLY DEAD — `transfer()` runs the same `approach()` for both directions and
// only then branches on `put` vs `getFromContainer` — so "contribute" never worked either.
// Nobody had noticed because nothing had asked it to.
//
// It also re-reads the older sighting this file already records: Zoot spending an hour on door
// 59's OUTWARD trigger with the hall's only exit two squares away, logged at the time as a
// geometry race. The trigger was reached every pass. The door was never asked to open.
//
// `secret` stays a per-door flag rather than becoming a hall-wide assumption, so a hall with a
// genuinely pressed door can still say so.
export const doors = [
  { sector: 59, inward: [[3,28],[5,28]], outward: [[4,28],[2,28]] },
  { sector: 55, inward: [[19,10],[17,10]], outward: [[18,10],[20,10]] },
  { sector: 53, inward: [[13,13],[11,13]], outward: [[11,13],[13,13]] },
  { sector: 3, inward: [[7,8],[7,4]], outward: [[7,4],[7,8]], secret: true },
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

// THE BAKED LINE ACROSS EACH DOOR, AND WHY THERE IS ONE.
//
// The live plan below asks `s.world.geometry.path(...)` inside a 350ms wait for a `sector-height`
// event, in a window the door holds open for about five seconds. When the event has not arrived
// yet, the geometry it plans across is the SHUT hall, `path` reports not-found, and the crossing
// records `no live path across the open door` — which reads exactly like "there is no way out of
// this room". Zoot spent an hour on door 59's outward trigger answering that every pass, with the
// hall's only exit two squares away, and `come-home` gave up with route_progressing_exits_exhausted.
//
// The hall's geometry is ENUMERABLE — all 32 ceiling states are in substrate/m59-ceiling-doors.json
// — so the line across an open door is a fact that can be cut in advance. m59-guildrails.mjs cuts
// it against the state where that one door is up, verifies it with the mover's own trace, and
// writes substrate/rail-714.json. This reads it.
//
// IT IS A FALLBACK, NOT A REPLACEMENT. The live geometry is the only thing that knows about
// BODIES, and a rail knows only about the ceiling — so the live plan still goes first and the rail
// answers only when the live plan has nothing. That way this can fix the race and cannot cause one.
let RAILS = null;
function bakedRails() {
  if (RAILS === null) {
    try {
      RAILS = JSON.parse(readFileSync(new URL('../substrate/rail-714.json', import.meta.url)));
    } catch { RAILS = false; }          // false, not null: asked once, absent, do not re-read
  }
  return RAILS || null;
}

/**
 * The baked crossing from one square to another, as SQUARES, deduped.
 *
 * The rail is cut on a 64-unit client lattice because that is what the mover enforces; `s.step`
 * takes a square. So the waypoints are collapsed to the square transitions they represent, which
 * is the same line expressed in the units the caller can act on. A COORDINATE CARRIES ITS UNIT:
 * waypoints are CLIENT (1024 to a square), the result is grid.
 */
export function bakedCrossing(from, to, sector) {
  const baked = bakedRails();
  if (!baked) return null;
  const name = ([r, c]) => `r${r}c${c}`;
  const leg = baked.legs?.find(l => l.ok && l.from === name(from) && l.to === name(to) &&
                                    (l.doors_open ?? []).includes(sector));
  if (!leg?.waypoints?.length) return null;
  const out = [];
  for (const p of leg.waypoints) {
    const col = Math.floor(p.x / 1024) + 1, row = Math.floor(p.y / 1024) + 1;
    const last = out[out.length - 1];
    if (!last || last.row !== row || last.col !== col) out.push({ row, col });
  }
  // Drop the square we are already standing on; what is wanted is where to go NEXT.
  if (out.length && out[0].row === from[0] && out[0].col === from[1]) out.shift();
  return out.length ? out : null;
}
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
    const approach = await s.walkTo(trigger[1], trigger[0], { maxSteps: 50, hardCap: 60, beforeMutation: guard });
    await s.confirmPosition?.();
    if (c.self.row !== trigger[0] || c.self.col !== trigger[1]) {
      k.note?.('guild door trigger not reached', { sector: door.sector, reason: approach?.reason,
        at: { row: c.self.row, col: c.self.col }, target: { row: trigger[0], col: trigger[1] } });
      throw new Error(`guild door ${door.sector} trigger not reached`);
    }
    let crossed = false;
    for (let attempt = 0; attempt < 3 && !crossed; attempt++) {
      if (isInterrupted()) throw new Error('guild passage paused for survival');
      const since = c.evSeq;
      if (door.secret) {
        if (!(await k.sayHallPassword()).ok) throw new Error('guild chest key unavailable');
      } else await s.pacer.submit('move', () => { guard(); return c.go(); });
      const plans = doorsFor(714, { row: c.self.row, col: c.self.col });
      // The password-operated door is not in SomethingTryGo's table.
      const definition = [...plans.on, ...plans.others].find(p => p.sector === door.sector)
        ?? JSON.parse(readFileSync(new URL('../substrate/m59-ceiling-doors.json', import.meta.url)))
          .rooms[714].doors.find(d => d.id === door.sector);
      const plan = definition?.to_height != null ? definition : {
        sector: door.sector, from_height: definition?.closed, to_height: definition?.open,
        within_ms: 8000,
      };
      const opening = await waitForDoorOpen(c, plan, { since, cancelled: isInterrupted });
      if (isInterrupted()) throw new Error('guild passage paused for survival');
      if (!opening.opened) {
        k.note?.('guild door opening not verified', { sector: door.sector, reason: opening.reason });
        if (attempt < 2) {
          const retryAt = Date.now() + 5200;
          while (Date.now() < retryAt && !isInterrupted()) await sleep(100);
        }
        continue;
      }
      // Do not coalesce across the entrance: its first and second hotplates
      // occupy consecutive squares and must be crossed in order. Confirm each
      // short step, then plan from the body's actual position.
      let result, usedRail = false;
      if (s.step && s.world?.geometry) {
        for (let step = 0; step < 6; step++) {
          guard();
          if (c.self.row === across[0] && c.self.col === across[1]) break;
          const path = s.world.geometry.path(c.self.row, c.self.col, across[0], across[1]);
          let next = path.steps?.[0];
          if (!path.found || !next) {
            // The live geometry has nothing. That is USUALLY the ceiling not having arrived yet
            // rather than a wall, so ask the baked line for this door before giving up on it.
            const rail = bakedCrossing([c.self.row, c.self.col], across, door.sector) ??
                         bakedCrossing(trigger, across, door.sector);
            next = rail?.[0] ?? null;
            usedRail = !!next;
            if (!next) { result = { reason: 'no live path across the open door, and nothing baked' }; break; }
          }
          result = await s.step(next.col, next.row, { confirm: true, beforeMutation: guard });
          if (!result.moved) break;
        }
      } else result = await s.walkTo(across[1], across[0], { maxSteps: 5, hardCap: 6, beforeMutation: guard });
      crossed = guildSection(c.self.row, c.self.col) === section + (inward ? 1 : -1);
      k.note?.('guild door passage', { sector: door.sector, inward, crossed,
        at: { row: c.self.row, col: c.self.col }, reason: result?.reason,
        // A FALLBACK NOBODY CAN COUNT IS A FALLBACK NOBODY WILL MAINTAIN. If the rail is carrying
        // this hall, that has to be visible in the log rather than inferred from the absence of
        // the old refusal.
        ...(usedRail ? { via: 'baked rail' } : {}) });
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
