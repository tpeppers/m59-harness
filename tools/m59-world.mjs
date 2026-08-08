#!/usr/bin/env node
// The agent's world model: everything known about where it is standing, assembled
// into one thing it can read and act from.
//
// A protocol client gives you a list of objects with coordinates. That is not enough
// to play. An agent also needs to know which of those objects it can actually reach,
// which way is out, what the room is shaped like, and — because every request costs
// a second — which of the things it might do are possible at all before it spends a
// request finding out.
//
// So this module joins three sources that live in three different places:
//
//   perception   BP_ROOM_CONTENTS etc, from m59-parse — ids, names, positions, flags
//   the graph    substrate/m59-map.json, from m59-map — which rooms connect and how
//   geometry     the .roo walkability grid, from m59-roo — what is walkable, and paths
//
// and renders the join as a minimap with everything placed on it, which is the same
// picture the human client draws in its corner and the densest single artifact either
// a person or an agent can look at.

import { RoomGeometry } from './m59-roo.mjs';
import { exitsOf, findPath, inferredExits, codeExits, LEAVE } from './m59-map.mjs';
import { inRegion } from './m59-codeexits.mjs';
import { affordances, OF, isTeleporter, KOD_FINENESS } from './m59-parse.mjs';

// Marks used on the minimap. Chosen so the picture stays readable in a terminal and
// so the important things are the ones that stand out: you, then players, then
// whatever you can fight or trade with.
const MARK = {
  self: '@',
  player: 'P',
  exit: 'X',
  locked: 'x',
};
// Everything else gets a letter, and the legend says what each one is.
const OBJECT_MARKS = 'abcdefghijklmnopqrstuvwxyz0123456789';

// A portal announces itself after all: OF_MOVEON_TELEPORTER lives in the low two
// bits of the object flags (include/proto.h:417, "kod will move you elsewhere").
// That is authoritative, so the name is only used to LABEL what the flag found.
const PORTAL_NAME = /(portal|rip in space|gateway|vortex|moongate)/i;

const dirName = deg => {
  const names = ['east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north', 'northeast'];
  return names[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
};

// Inert furniture, as a tally rather than a list. Keeps the ids so an agent that
// wants to look at a tree still can, but spends one line on sixty plants instead
// of sixty. Only ever called with objects that have NO affordances — see snapshot.
function summariseScenery(list) {
  const kinds = {};
  for (const o of list) {
    const k = o.name || 'unknown';
    (kinds[k] ??= { count: 0, ids: [] }).count++;
    if (kinds[k].ids.length < 6) kinds[k].ids.push(o.id);
  }
  return {
    total: list.length,
    kinds: Object.fromEntries(Object.entries(kinds)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([k, v]) => [k, v.count === 1 ? { id: v.ids[0] } : { count: v.count, ids: v.ids }])),
    note: 'no affordances — decoration only. Everything you can act on, every ' +
          'player, and everything holding a quantity is in `objects` above, in full.',
  };
}

export class World {
  // `client` is an M59Client; `map` is the parsed substrate/m59-map.json.
  constructor(client, map) {
    this.c = client;
    this.map = map;
    this.geoCache = new Map();
  }

  // Which room are we in, as a room NUMBER? The protocol never says. BP_PLAYER
  // carries the room's name resource and room resource (User.ToCliPlayer sends
  // GetRoomResource and GetName), and both are unique per room across the whole
  // world, so either identifies it. Object ids would too, but only until the next
  // `save game` renumbers them — so they are the fallback, not the key.
  get room() {
    if (!this.map) return null;
    const c = this.c;
    const rooms = Object.values(this.map.rooms);
    if (c.roomNameRsc) {
      const hit = rooms.find(r => r.nameRsc === c.roomNameRsc);
      if (hit) return hit;
    }
    if (c.roomRsc) {
      const hit = rooms.find(r => r.roomRsc === c.roomRsc);
      if (hit) return hit;
    }
    if (c.room?.id != null) {
      const hit = rooms.find(r => r.objId === c.room.id);
      if (hit) return hit;
    }
    return null;
  }

  get geometry() {
    const room = this.room;
    if (!room?.roo) return null;
    if (!this.geoCache.has(room.num)) this.geoCache.set(room.num, RoomGeometry.fromJSON(room.roo));
    return this.geoCache.get(room.num);
  }

  get self() { return this.c.self; }

  // ------------------------------------------------------------------ reach

  // Where to measure distances FROM.
  //
  // Normally that is simply where you are standing, but you can be standing
  // somewhere the movement grid calls solid rock. Arriving by teleport does it — a
  // character killed and sent to the Underworld landed on (11,32) of a 32-row room,
  // a square with no floor — and so does fine movement along a ledge, where the real
  // geometry is finer than the one-byte-per-square grid.
  //
  // A search rooted on an unwalkable square expands to nothing, so EVERY object came
  // back unreachable and the Underworld escape concluded that none of the portals
  // worked, when it had never taken a step toward one. Measuring from the nearest
  // real floor instead is honest — walkTo steps off the bad square by itself — and
  // it is what exits() has always done. Reachability of objects should not disagree
  // with reachability of exits about where the character is.
  origin() {
    const me = this.self, geo = this.geometry;
    if (!me || !geo) return me ?? null;
    if (geo.walkable(me.row, me.col)) return me;
    const near = geo.nearestWalkable(me.row, me.col);
    return near ? { ...me, row: near.row, col: near.col, offGrid: true } : me;
  }

  // Can we get there, and in how many steps? This is the question the raw protocol
  // cannot answer and an agent most needs answered, because the cost of finding out
  // by walking is one second per step and a wrong guess is a wasted minute.
  reach(toCol, toRow) {
    const me = this.origin(), geo = this.geometry;
    if (!me) return { reachable: null, why: 'own position unknown' };
    if (!geo) return { reachable: null, why: 'no geometry for this room' };
    if (me.col === toCol && me.row === toRow) return { reachable: true, steps: 0, path: [] };
    const r = geo.path(me.row, me.col, toRow, toCol);
    if (!r.found) return { reachable: false, why: r.reason };
    return { reachable: true, steps: r.steps.length, path: r.steps.map(s => ({ col: s.col, row: s.row, dir: s.dir })),
             ...(me.offGrid ? { from_nearest_floor: { col: me.col, row: me.row },
                                note: 'you are standing off the movement grid; steps are counted from the nearest floor square' }
                            : {}) };
  }

  // Adjacent to a target rather than on top of it: the square next to it that is
  // cheapest to reach. Melee needs this — you cannot stand where the monster is.
  approachSquare(toCol, toRow) {
    const me = this.origin(), geo = this.geometry;
    if (!me || !geo) return null;
    let best = null;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r = toRow + dr, c = toCol + dc;
      if (!geo.walkable(r, c)) continue;
      if (me.row === r && me.col === c) return { col: c, row: r, steps: 0, path: [] };
      const p = geo.path(me.row, me.col, r, c);
      if (!p.found) continue;
      if (!best || p.steps.length < best.steps) best = { col: c, row: r, steps: p.steps.length, path: p.steps };
    }
    return best;
  }

  // ------------------------------------------------------------------ exits

  // Every way out, with what it costs to get to it from here. An edge exit is
  // reached by walking to the boundary square and stepping past it; a `go` exit
  // requires standing on an EXACT square (Room.SomethingTryGo matches row and col
  // exactly), which is why the square is reported rather than a direction.
  exits() {
    const room = this.room, geo = this.geometry, me = this.self;
    if (!room) return [];
    const out = [];
    // Reachability is measured from where we are standing, and if that square has no
    // floor then every answer is "unreachable" for a reason that has nothing to do
    // with the exits. Measure from the nearest solid square instead, and let walkTo
    // handle stepping onto it.
    const origin = this.origin();

    // Include the reverse of edge exits that only the other side declares. The
    // planner already routes through these (see inferredExits); without them here
    // the EXECUTOR cannot walk what the planner just planned, and travel reports
    // "cannot find the exit to X from here" one hop into a perfectly good route.
    // That is worse than not knowing the route at all, because it looks like a
    // geometry problem rather than a bookkeeping one.
    const inferred = this.map ? inferredExits(this.map, room.num) : [];
    for (const e of [...room.edgeExits,
                     ...inferred.map(x => ({ leave: x.leave, to: x.to, leaveName: x.direction,
                                             arriveRow: null, arriveCol: null, inferred: true }))]) {
      // The boundary square to aim for. Walking past row 0 or piRows+1 is what
      // triggers StandardLeaveDir, so the target is one step outside the grid, and
      // the square to stand on first is the last one inside it.
      let approach = null, alternates = [], viableCount = 0;
      if (geo && me) {
        const cands = [];
        if (e.leave === LEAVE.NORTH) for (let c = 1; c <= geo.cols; c++) cands.push([1, c]);
        if (e.leave === LEAVE.SOUTH) for (let c = 1; c <= geo.cols; c++) cands.push([geo.rows, c]);
        if (e.leave === LEAVE.WEST)  for (let r = 1; r <= geo.rows; r++) cands.push([r, 1]);
        if (e.leave === LEAVE.EAST)  for (let r = 1; r <= geo.rows; r++) cands.push([r, geo.cols]);
        // A conditional exit only leads here from part of the boundary, and the
        // condition is checked against the position you are standing on when you
        // cross (StandardLeaveDir reads GetRow/GetCol, not the destination).
        const ok = ([r, c]) => {
          if (!e.condition) return true;
          const { type, threshold } = e.condition;
          if (type === 1) return r > threshold;
          if (type === 2) return r < threshold;
          if (type === 3) return c > threshold;
          if (type === 4) return c < threshold;
          return true;                       // NO_OTHER_CONDITIONS is the fallback
        };
        // KEEP THE WHOLE BOUNDARY, NOT JUST THE NEAREST SQUARE.
        //
        // This found every viable square along the edge and then threw all but one
        // away. StandardLeaveDir fires on crossing the boundary ANYWHERE the condition
        // allows, so the discarded ones were not worse routes — they were equally good
        // doors. With two declared exits to a destination that meant exactly two squares
        // were ever tried, and "every square for that exit refused (2 tried)" was the
        // commonest way a multi-room errand died: the outfitting trip, four money
        // transfers and the reagent bridging all failed on it in one afternoon, against
        // boundaries fifty squares wide.
        //
        // A refusal is usually LOCAL — something standing on the square, or no floor on
        // the far side of that column — so the alternates are SPREAD along the boundary
        // rather than taken in distance order. Trying (1,5) then (1,6) then (1,7) mostly
        // re-asks the same question; sampling across the width asks a different one.
        const viable = [];
        for (const [r, c] of cands) {
          if (!ok([r, c]) || !geo.walkable(r, c)) continue;
          const p = (origin.row === r && origin.col === c) ? { found: true, steps: [] } : geo.path(origin.row, origin.col, r, c);
          if (!p.found) continue;
          viable.push({ col: c, row: r, steps: p.steps.length });
        }
        viable.sort((a, b) => a.steps - b.steps);
        approach = viable[0] ?? null;
        // Nearest first — it is still the cheapest thing to try — then a spread of the
        // rest, each at least MIN_APART from everything already chosen so the tries are
        // genuinely different parts of the wall. Capped because each attempt is a walk.
        const MIN_APART = 4, MAX_ALTS = 7;
        const along = s => (e.leave === LEAVE.NORTH || e.leave === LEAVE.SOUTH) ? s.col : s.row;
        const picked = approach ? [approach] : [];
        for (const s of viable) {
          if (picked.length > MAX_ALTS) break;
          if (picked.some(p => Math.abs(along(p) - along(s)) < MIN_APART)) continue;
          picked.push(s);
        }
        // Anything left over is still better than giving up, so keep them as a tail in
        // distance order for the case where the spread found nothing.
        for (const s of viable) {
          if (picked.length > MAX_ALTS) break;
          if (!picked.includes(s)) picked.push(s);
        }
        alternates = picked.slice(1).map(s => ({ col: s.col, row: s.row, steps: s.steps }));
        viableCount = viable.length;
      }
      out.push({
        kind: 'edge',
        direction: e.leaveName,
        to: e.to,
        to_name: this.map.rooms[e.to]?.name ?? `room ${e.to}`,
        stand_on: approach ? { col: approach.col, row: approach.row } : null,
        steps_away: approach ? approach.steps : null,
        // OTHER WAYS THROUGH THE SAME WALL. Not second-best routes — the boundary is
        // one exit and any square on it crosses. leaveViaAny works through these when
        // the nearest is blocked, which is what makes a wide edge reliable instead of a
        // coin flip on whichever square happened to be closest.
        ...(alternates.length ? { alternates } : {}),
        ...(viableCount ? { standable_on_this_boundary: viableCount } : {}),
        how: approach
          ? `walk_to (${approach.col},${approach.row}) then one more step ${e.leaveName}` +
            (alternates.length ? ` — ${alternates.length} other square(s) on that boundary also cross` : '')
          : `walk ${e.leaveName} past the room edge`,
        condition: e.condition ? `${e.condition.name}${e.condition.threshold}` : null,
        reachable: approach ? true : (geo && me ? false : null),
        // Flagged so leaveVia can tell a declared boundary from a guessed one, and
        // retire the guess when the server refuses it.
        ...(e.inferred ? { inferred: true } : {}),
      });
    }

    // Exits the room class implements in code: walking into a region of the floor
    // makes the room hand you across. Nothing to press, and no way to see it at
    // runtime — see m59-codeexits.mjs. Turn the coordinate test into a concrete
    // square by asking the geometry for the nearest walkable one that satisfies it,
    // because "row > 83 and col > 48" is not something a caller can walk to.
    for (const ce of codeExits(room.num)) {
      let best = null;
      if (geo && me) {
        for (let r = 1; r <= geo.rows; r++) {
          for (let c = 1; c <= geo.cols; c++) {
            if (!inRegion(ce.when, r, c) || !geo.walkable(r, c)) continue;
            const p = this.reach(c, r);
            if (!p.reachable) continue;
            if (!best || p.steps < best.steps) best = { col: c, row: r, steps: p.steps };
          }
        }
      }
      out.push({
        kind: 'region',
        to: ce.to,
        to_name: this.map.rooms[ce.to]?.name ?? `room ${ce.to}`,
        stand_on: best ? { col: best.col, row: best.row } : null,
        steps_away: best ? best.steps : null,
        reachable: best ? true : (geo && me ? false : null),
        how: best
          ? `walk_to (${best.col},${best.row}) — the room moves you across as you arrive`
          : ce.how,
        trigger: ce.when.map(x => `${x.axis} ${x.op} ${x.value}`).join(' and '),
      });
    }

    for (const g of room.goExits) {
      const rr = (geo && me && !g.locked) ? this.reach(g.col, g.row) : { reachable: null };
      out.push({
        kind: g.locked ? 'locked_door' : 'go',
        to: g.locked ? null : g.to,
        to_name: g.locked ? null : (this.map.rooms[g.to]?.name ?? `room ${g.to}`),
        stand_on: { col: g.col, row: g.row },
        steps_away: rr.steps ?? null,
        reachable: rr.reachable,
        how: g.locked
          ? `locked door at (${g.col},${g.row})`
          : `walk_to EXACTLY (${g.col},${g.row}) then act go — the match is on that one square`,
      });
    }
    // Portal objects, which are neither an edge exit nor a `go` exit. The room graph
    // cannot know about them — they are runtime objects, and rooms like the
    // Underworld have NO graph exits at all and are reachable only by dying, so an
    // agent that ignores these is stuck there permanently.
    for (const o of this.c.room.objects.values()) {
      if (o.id === this.c.selfId) continue;
      const name = this.c.rsc.get(o.nameRsc);
      if (!isTeleporter(o.flags)) continue;
      const rr = (geo && me) ? this.reach(o.col, o.row) : { reachable: null };
      out.push({
        kind: 'portal',
        to: null,
        to_name: null,
        name,
        id: o.id,
        stand_on: { col: o.col, row: o.row },
        steps_away: rr.steps ?? null,
        reachable: rr.reachable,
        // The flag is certain; where it goes is not. Some portals are fixed and some
        // change their destination on a timer, and the only way to find out is to
        // look at it — the description names the place in prose.
        destination_known: false,
        how: `walk_to (${o.col},${o.row}) — stepping onto this square teleports you. ` +
             `Use look_at first: a shifting portal describes where it currently leads.`,
      });
    }

    return out;
  }

  // ------------------------------------------------------------------ objects

  objects() {
    const c = this.c, me = this.self;
    const list = [...c.room.objects.values()].filter(o => o.id !== c.selfId);
    return list.map(o => {
      const straight = me ? Math.round(Math.hypot(o.col - me.col, o.row - me.row)) : null;
      const can = affordances(o.flags);
      const out = {
        id: o.id,
        name: c.rsc.get(o.nameRsc),
        col: o.col, row: o.row,
        distance: straight,
        facing: o.degrees != null ? dirName(o.degrees) : null,
        can,
        is_player: !!(o.flags & OF.PLAYER),
        teleporter: isTeleporter(o.flags) || undefined,
      };
      if (o.amount) out.amount = o.amount;
      if (o.flags & OF.PLAYER) {
        // Who is safe to be near. These bits come straight from the server's own
        // view of the relationship, so they are more trustworthy than a name.
        out.relation = (o.flags & OF.ENEMY) ? 'enemy'
          : (o.flags & OF.GUILDMATE) ? 'guildmate'
          : (o.flags & OF.FRIEND) ? 'friend' : 'neutral';
        out.safety_on = !!(o.flags & OF.SAFETY);
      }
      return out;
    }).sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));
  }

  // ------------------------------------------------------------------ minimap

  // The whole state as one picture. Objects are placed on the walkability grid, so a
  // glance answers "is that monster behind a wall", "which way is out", and "can I
  // get there" — none of which the object list alone can tell you.
  minimap({ path = null, maxWidth = 200 } = {}) {
    const geo = this.geometry;
    if (!geo) return { text: null, legend: {}, note: 'no geometry for this room' };
    const me = this.self;
    const marks = [];
    const legend = {};

    // Exits first, so an object standing in a doorway does not hide the way out
    // — later marks win, and objects are added after.
    for (const e of this.exits()) {
      if (!e.stand_on) continue;
      const ch = e.kind === 'locked_door' ? MARK.locked : MARK.exit;
      marks.push({ row: e.stand_on.row, col: e.stand_on.col, ch });
      legend[ch] = e.kind === 'locked_door' ? 'locked door' : 'exit (stand here)';
    }

    // A planned route, if the caller has one, so the agent can see its own plan.
    if (path) for (const s of path) marks.push({ row: s.row, col: s.col, ch: ':' });
    if (path?.length) legend[':'] = 'planned route';

    // Objects, nearest first so the interesting ones get the early letters.
    let next = 0;
    for (const o of this.objects()) {
      const ch = o.is_player ? MARK.player : OBJECT_MARKS[next++ % OBJECT_MARKS.length];
      marks.push({ row: o.row, col: o.col, ch });
      const desc = `${o.name} (id ${o.id})${o.can.length ? ' [' + o.can.filter(x => x !== 'look').join('/') + ']' : ''}`;
      legend[ch] = legend[ch] && legend[ch] !== desc ? `${legend[ch]}; ${desc}` : desc;
    }

    if (me) { marks.push({ row: me.row, col: me.col, ch: MARK.self }); legend[MARK.self] = 'you'; }

    // Two pictures, because they answer different questions and neither subsumes
    // the other. The GRID map is the movement graph — one character per square, and
    // what it calls floor is what you can stand on. The WALL map is what the client
    // actually draws (clientd3d/map.c): line segments at twice the resolution, so a
    // wall BETWEEN two floor squares is visible, and doorways are distinguishable
    // from walls. An agent deciding where to step wants the first; an agent working
    // out the shape of the place wants the second.
    const walls = geo.walls?.length ? geo.renderWalls({ marks }) : null;
    return {
      text: geo.render({ marks, legend: false }),
      walls,
      legend,
      key: '# no floor   . floor   + floor with no exits',
      walls_key: walls ? '| - / \ wall   · doorway you can walk through   . floor' : undefined,
      size: { rows: geo.rows, cols: geo.cols, walkable: geo.walkableCount },
      wall_summary: geo.wallSummary || undefined,
      truncated: geo.cols > maxWidth,
    };
  }

  // ------------------------------------------------------------------ snapshot

  // One call, everything. This is what an agent should read at the start of a turn.
  //
  // THE MINIMAP IS OPT-IN. It is two full ASCII pictures of the room — the
  // walkability grid and the wall map at double resolution — and for a big outdoor
  // room that is ~8KB, which dwarfs everything else in the reply. It answers
  // "is that behind a wall" and "what shape is this place", which are real
  // questions, but not ones an agent asks on most turns. Ask for it when you need
  // it; do not pay for it when you do not.
  snapshot({ includeMinimap = false, plannedPath = null } = {}) {
    const c = this.c, room = this.room, geo = this.geometry, me = this.self;
    const all = this.objects();
    const allExits = this.exits();

    // Locked doors get the same treatment as scenery, for the same reason: a town
    // can publish seventeen of them, each a full record naming a destination it does
    // not know and a square you cannot use, and none of it is actionable. Keep the
    // squares — a key changes the answer — but say it in one line.
    const exits = allExits.filter(e => e.kind !== 'locked_door');
    const locked = allExits.filter(e => e.kind === 'locked_door');

    // SCENERY IS SUMMARISED. NOTHING THAT COULD MATTER IS EVER DROPPED.
    //
    // A town room returns eighty-odd objects and most of them are browncorn plants
    // and dung: no affordances, nothing you can do with them, pure furniture. They
    // are worth a count, not a paragraph each.
    //
    // But this must NEVER become a cap on the list, and the reason is specific:
    // everything dies onto the floor in this game, so the rooms where the object
    // list is longest are exactly the dangerous ones — a battlefield thick with
    // corpses and their loot. A truncated list there would omit the loot you came
    // for, or the murderer walking in behind it. So the split is by AFFORDANCE, not
    // by count: anything with something you can do to it, anything holding a
    // quantity, every player, and every teleporter is reported in full however many
    // there are. Only the genuinely inert collapses.
    const inert = o => !o.is_player && !o.teleporter && o.amount == null
                       && (!o.can || o.can.length === 0);
    const objects = all.filter(o => !inert(o));
    const scenery = all.filter(inert);

    // Reachability is an A* per object, so it is budgeted rather than unconditional —
    // but the budget is generous, because "can I get to that" is the question an
    // agent most often needs answered and guessing wrong costs a minute of walking.
    // Nearest first, so if the budget runs out it runs out on the far things.
    const REACH_BUDGET = 40;
    for (const o of objects.slice(0, REACH_BUDGET)) {
      const a = this.approachSquare(o.col, o.row);
      o.reachable = a ? true : (geo && me ? false : null);
      if (a) { o.steps_to_reach = a.steps; o.stand_on = { col: a.col, row: a.row }; }
      // A portal is a THIRD way out of a room, and nothing in the protocol says so:
      // Portal.SomethingMoved fires when your square equals its square and teleports
      // you (kod/object/active/portal.kod:97). It carries no distinguishing object
      // flag — the Underworld's read `can: ["look"]` like scenery — so the only
      // signal available to a client is the name. Flagged as a GUESS, because that
      // is what it is; walking onto the square is how you find out.
      if (o.teleporter) {
        o.how = `walk_to (${o.col},${o.row}) — stepping onto this square teleports you elsewhere.`;
      }
    }

    return {
      room: room
        ? { num: room.num, name: room.name, size: { rows: room.rows, cols: room.cols },
            resource: room.rooFile, object_id: c.room.id }
        : { num: null, name: c.roomNameRsc ? c.rsc.get(c.roomNameRsc) : null, object_id: c.room.id,
            note: 'this room is not in substrate/m59-map.json — rebuild the map' },
      you: me
        ? { object_id: c.selfId, col: me.col, row: me.row,
            facing: dirName(me.degrees ?? 0), facing_degrees: me.degrees,
            on_walkable: geo ? geo.walkable(me.row, me.col) : null,
            can_step: geo ? geo.openDirections(me.row, me.col).map(d => d.name) : null }
        : { object_id: c.selfId, note: 'not present in room contents yet — call look' },
      vitals: c.vitals(),
      carrying: c.inventory.length,
      objects,
      ...(scenery.length ? { scenery: summariseScenery(scenery) } : {}),
      exits,
      ...(locked.length ? { locked_doors: {
        count: locked.length,
        squares: locked.map(e => `${e.stand_on.col},${e.stand_on.row}`),
        note: 'shut to you now; listed in case you find a key',
      } } : {}),
      ...(includeMinimap ? { minimap: this.minimap({ path: plannedPath }) } : {})
      ,
      ...(includeMinimap ? {} : { minimap_note: 'omitted — pass minimap:true for the room picture' }),
    };
  }

  // ------------------------------------------------------------------ travel

  // A route to another room, expressed as things to do rather than rooms to be in.
  // Each leg says which square to stand on and which mechanism to use, because the
  // two mechanisms are not interchangeable and getting it wrong produces silence.
  route(toRoomNum) {
    const room = this.room;
    if (!room) return { found: false, reason: 'current room is not in the graph' };
    const r = findPath(this.map, room.num, toRoomNum);
    if (!r.found) return r;
    return {
      found: true,
      hops: r.hops.map(h => ({
        from: h.from, from_name: h.fromName, to: h.to, to_name: h.toName,
        kind: h.kind,
        // For an edge hop the square to aim for depends on which room you are in at
        // the time, so only the first leg can be resolved to a square here. The rest
        // are resolved as the agent arrives.
        stand_on: h.kind === 'go' ? { col: h.col, row: h.row } : null,
        direction: h.direction ?? null,
        how: h.how,
      })),
    };
  }
}

// A convenience for the broker: the shared map, loaded once.
let sharedMap = null;
export function sharedWorldMap(loader) {
  if (sharedMap === null) {
    try { sharedMap = loader(); } catch { sharedMap = false; }
  }
  return sharedMap || null;
}

// EXPAND EACH EDGE INTO EVERY SQUARE THAT CROSSES IT.
//
// An edge exit is a whole boundary, not a doorway: StandardLeaveDir fires wherever the
// condition allows you to step past it, so every standable square on that wall is the
// same exit. exits() reports the ones it used to discard as `alternates`; this turns
// each into a candidate of its own, so a caller working through a list tries the wall
// rather than one square of it.
//
// Kept here, beside the code that builds the alternates, so it can be tested — importing
// the broker starts a broker.
export function spreadEdges(candidates) {
  const out = [];
  for (const e of candidates || []) {
    out.push(e);
    for (const alt of e.alternates || [])
      out.push({ ...e, stand_on: { col: alt.col, row: alt.row }, steps_away: alt.steps,
                 alternates: undefined, from_alternate: true });
  }
  return out;
}

// A `go` sent immediately after the last movement update can disappear without either
// a refusal or a room transition. Retry only that silent case, once by default. A
// spoken refusal or a room change is authoritative, and the bound prevents a dead exit
// from becoming a loop.
export function retrySilentGo({ attempt = 0, maxAttempts = 2, entered = false, messages = [] } = {}) {
  return entered !== true && (!Array.isArray(messages) || messages.length === 0)
    && attempt < maxAttempts;
}

// Run the complete bounded request sequence without owning any broker state. Keeping
// the sequencing here makes the late-entry and cancellation races executable in the
// offline suite instead of leaving them as comments around Session.goThrough.
export async function boundedSilentGo({
  sequence,
  eventsSince,
  send,
  waitForEntry,
  cancelled = () => false,
  maxAttempts = 2,
} = {}) {
  if (![sequence, eventsSince, send, waitForEntry, cancelled].every(fn => typeof fn === 'function'))
    throw new TypeError('boundedSilentGo requires sequence, eventsSince, send, waitForEntry, and cancelled functions');
  const before = sequence();
  let attempts = 0, entered = null;
  const messages = [];
  while (attempts < maxAttempts) {
    if (cancelled())
      return { cancelled: true, entered: null, messages, attempts };
    // An entry can land after the prior wait timed out but before the retry. Observe
    // the whole request window here; never send a second go after a late success.
    const lateEntry = eventsSince(before).find(event => event.kind === 'room-entered');
    if (lateEntry) { entered = lateEntry; break; }

    const attemptBefore = sequence();
    await send();
    attempts++;
    entered = await waitForEntry(attemptBefore) ?? null;
    // Only messages produced after this go count. A stand-up acknowledgement or
    // unrelated event before the request must not suppress the one allowed retry.
    const attemptMessages = eventsSince(attemptBefore)
      .filter(event => event.text)
      .map(event => event.text);
    messages.push(...attemptMessages);
    if (!retrySilentGo({
      attempt: attempts,
      maxAttempts,
      entered: !!entered,
      messages: attemptMessages,
    })) break;
  }
  return { cancelled: false, entered, messages, attempts };
}
