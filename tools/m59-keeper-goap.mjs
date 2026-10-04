#!/usr/bin/env node
// m59-keeper-goap.mjs -- THE GOAP KEEPER. A planner-driven loop that replaces
// the sequential pass() for one character.
//
// WHAT THIS IS: a thin driver that, on each pass(), reads the world state,
// plans toward a goal, executes one step, and lets the next pass() re-plan.
// The planner is m59-plan.mjs (A* over preconditions/effects in the closed
// vocabulary). The atomics are tools/m59-act/*.mjs. The world state is
// m59-worldstate.mjs.
//
// WHAT THIS IS NOT:
//   NOT A REPLACEMENT FOR THE SAFETY LADDER. Underworld, arming, and the
//   engagement ceiling are PRECONDITIONS in the vocabulary, not goals. A
//   character that is dead, in the Underworld, or unarmed cannot plan its
//   way out of those states — the legacy safety shell (passUnderworld,
//   passArm) still runs before the planner, the same way the BT keeper
//   routed them before the trees.
//
//   NOT A BROKER CLIENT. It runs inside the broker's existing session, which
//   means it has the fine-coordinate mover (session.step) that the standalone
//   m59-goap-run.mjs deliberately lacks.
//
//   NOT A FLEET-WIDE CHANGE. The policy.useGOAP flag is per-character. The
//   fleet stays on the proven sequential code unless somebody flipped the
//   lever on a specific character.
//
// THE GOAL IS CONFIGURABLE. The default is vigor_ok: keep the character
// fed. That is the goal the fleet actually lives on — resting stops at 80
// of 200, so everything above it has to be eaten, and a character that is
// not fed will not fight, farm, or travel.
//
// REPLANNING IS EVERY PASS. A plan is a claim about a world that will not
// hold still. The planner re-runs from the current world state on every
// pass, so a character that eats and is now fed re-plans toward the next
// goal rather than repeating a completed step.

import { evaluate, unknowns, SYMBOL_NAMES } from './m59-worldstate.mjs';
import { planFor, stepPlan } from './m59-plan.mjs';
import * as watchdog from './m59-watchdog.mjs';

// The step's own name, however it is carried. `doing` is derived from it, and a wrong
// answer makes the position pulse either blind or a false-alarm generator.
const actionNameOf = (step, p) => step?.atomic ?? step?.action ?? p?.names?.[0] ?? null;
import { safetyFor } from './m59-skills.mjs';
import { loadMap, findPath } from './m59-map.mjs';
import { objIdToNum } from './m59-hunt-room.mjs';
import { readFileSync, existsSync } from 'node:fs';

// Compendium spawn data for level lookups.
let _spawns = null;
function _loadSpawns() {
  if (_spawns) return _spawns;
  const file = 'substrate/m59-spawns.json';
  if (!existsSync(file)) return null;
  try { _spawns = JSON.parse(readFileSync(file, 'utf8')); } catch { _spawns = null; }
  return _spawns;
}
function _compendiumLevel(roomNum, mobName) {
  const spawns = _loadSpawns();
  if (!spawns?.rooms) return null;
  const name = String(mobName).toLowerCase();
  // First try the specific room.
  const entries = spawns.rooms[String(roomNum)] ?? null;
  if (entries) {
    const match = entries.find(e => e.creature?.toLowerCase() === name);
    if (match) return match.level;
  }
  // Fall back to a global search: the compendium may not list this
  // mob for this specific room, but it might be listed for a
  // neighbouring room. The level is the same regardless of room.
  for (const entries2 of Object.values(spawns.rooms)) {
    const match2 = entries2.find(e => e.creature?.toLowerCase() === name);
    if (match2) return match2.level;
  }
  return null;
}
import { affordances, OF } from './m59-parse.mjs';
import { keeperOrigin } from './m59-move-origin.mjs';
import './m59-navgeom.mjs';   // installs the height model + lenient fine path onto RoomGeometry

// ROOMS THAT HAVE SHOPS. A shop is any room where a merchant with a buy
// list can be found. We use room names as a proxy: inns, taverns, shops,
// banks, smithies, and apothecaries all have merchants.
const SHOP_RE = /inn|tavern|shop|store|market|apothecary|smith|armourer|jeweller|bank|pawn|general|pub/i;

let _shopRooms = null;
function shopRooms() {
  if (_shopRooms) return _shopRooms;
  try {
    const map = loadMap();
    const rooms = map?.rooms ?? {};
    _shopRooms = [];
    for (const [num, r] of Object.entries(rooms)) {
      if (SHOP_RE.test(r?.name ?? '')) {
        _shopRooms.push(Number(num));
      }
    }
  } catch {
    _shopRooms = [];
  }
  return _shopRooms;
}

// Find the nearest shop from a given room.
// Returns { to, hops } or null if no shop is reachable.
//
// Room IDs in the live server can differ from the movement map (the
// server reassigns IDs on each startup). This helper resolves the
// live room ID to a map room ID by name before calling findPath.
let _roomNameToMapNum = null;
function roomNameToMapNum() {
  if (_roomNameToMapNum) return _roomNameToMapNum;
  _roomNameToMapNum = new Map();
  try {
    const map = loadMap();
    for (const [num, r] of Object.entries(map?.rooms ?? {})) {
      if (r?.name) _roomNameToMapNum.set(r.name, Number(num));
    }
  } catch { _roomNameToMapNum = new Map(); }
  return _roomNameToMapNum;
}

// Resolve a live room ID to a movement-map room ID.
// If the live ID is already in the map, return it as-is.
// Otherwise, look up by room name.
function resolveMapRoom(liveNum, roomName) {
  try {
    const map = loadMap();
    if (map?.rooms?.[liveNum]) return liveNum;
  } catch {}
  if (roomName) {
    const nameMap = roomNameToMapNum();
    const mapNum = nameMap.get(roomName);
    if (mapNum != null) return mapNum;
  }
  // LAST RESORT: try objIdToNum. The live room id (e.g. 1548) may not be a map
  // key, but objIdToNum knows the mapping from the server's object ids to map
  // numbers. This covers the case where the room name hasn't been resolved yet
  // (RSC timing) but the objId mapping is known.
  try {
    const mapped = objIdToNum(liveNum);
    if (mapped != null) return mapped;
  } catch {}
  return liveNum;
}

function nearestShop(fromNum, roomName, { avoid } = {}) {
  const shops = shopRooms();
  if (!shops.length) return null;
  try {
    const map = loadMap();
    let best = null;
    const mapFrom = resolveMapRoom(fromNum, roomName);
    for (const to of shops) {
      if (to === mapFrom) continue;
      const p = findPath(map, mapFrom, to, { avoid });
      if (p?.found && p.hops?.length) {
        if (!best || p.hops.length < best.hops.length) {
          best = { to, hops: p.hops };
        }
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * The GOAP keeper. One instance per character, created by the autopilot
 * when policy.useGOAP is true.
 *
 * pass() is called by the autopilot's loop, the same way the legacy
 * sequential pass() is called. It reads the world state, plans toward the
 * current goal, executes one step, and returns. The next pass() re-plans
 * from the new world state.
 */
export class GOAPKeeper {
  /**
   * @param {object} opts
   * @param {object} opts.client  - the M59Client for this character
   * @param {object} opts.session - the broker session (has .step for movement)
   * @param {object} opts.policy  - the character's policy (includes useGOAP)
   * @param {string} [opts.goal='vigor_ok'] - the world-state symbol to plan toward
   * @param {function} [opts.note] - logging function (keeper.note)
   */
  _roomName() {
    try { return this.client?.rsc?.get?.(this.client?.roomNameRsc) ?? null; }
    catch { return null; }
  }

  constructor({ client, session, policy, goal = 'vigor_ok', note = () => {} }) {
    if (!client) throw new Error('GOAPKeeper: no client');
    if (!session) throw new Error('GOAPKeeper: no session');
    this.client = client;
    this.session = session;
    this.policy = policy ?? {};
    this.goal = goal;
    this.note = note;
    this._lastPlan = null;
    this._passCount = 0;
    this._passBracket = 0;
    this._pullTargetCooldowns = new Map();

    // ── THE OUT-OF-BAND GUARD ───────────────────────────────────────────────
    //
    // The planner is in-band: it assumes pass() returns and that the next pass will
    // re-read the world. Measured on this fleet, that assumption fails on 3.2% of
    // passes -- p99 16.6s, worst 207s -- and the long ones are FIGHTS, where the fight
    // path checks health once on entry and then trusts "the next pass", which can be
    // two minutes away. The watchdog is the only thing sampling health during those.
    //
    // These fields ARE the host interface in m59-watchdog.mjs. They live here rather
    // than in an adapter object so there is one place to look when the guard reports
    // something, and so `doing` can be written by the executor as the plan runs.
    this.doing = null;          // what the current step is -- the pulse reads this
    this.hold = null;           // set while holding a safe spot: still ON PURPOSE
    this.inert = false;         // this keeper IS the driver; nothing else owns it
    this.passes = 0;            // the interrupt fires once per pass, keyed on this
    this.passStartedAt = null;  // null between passes: blindness is measured from it
    this.lastFrameAt = 0;
    this.tally = {};
    this.frames = [];           // a small ring, so a death here can still be placed
    watchdog.start(this);
    this._shopDest = null; // cached shop destination room num
    this._levelTracker = { lastMaxHp: null, targetMaxHp: policy?.levelTargetMaxHp ?? 30, lastLevelUpPass: null, name: null };
  }

  _agentName() {
    if (this._levelTracker.name) return this._levelTracker.name;
    const n = this.policy?.agent ?? this.session?.s?.name ?? this.session?.name ?? this.client?.me?.name ?? '?';
    this._levelTracker.name = n;
    return n;
  }

  /**
   * Track max_health as a level proxy. Log when the character
   * levels up (max_health increases) and track progress toward
   * the target. Called once per pass.
   */
  _trackLevel(maxHp) {
    if (maxHp == null) return;
    const lt = this._levelTracker;
    const who = this._agentName();
    if (lt.lastMaxHp == null) {
      lt.lastMaxHp = maxHp;
      console.error(`[level] ${who} starting max_hp=${maxHp}, target=${lt.targetMaxHp}`);
      return;
    }
    if (maxHp > lt.lastMaxHp) {
      const remaining = lt.targetMaxHp - maxHp;
      const status = maxHp >= lt.targetMaxHp ? 'TARGET REACHED' : remaining + ' to go';
      console.error(`[level] ${who} LEVEL UP: max_hp ${lt.lastMaxHp} -> ${maxHp} (pass ${this._passCount}, ${status})`);
      lt.lastLevelUpPass = this._passCount;
    }
    lt.lastMaxHp = maxHp;
  }

  /**
   * Current plan and goal, for the dashboard / hero page. A visible
   * plan is the only plan you can argue with. Returns null when no
   * pass has run yet.
   */
  state() {
    return this._lastPlan ?? null;
  }

  /**
   * Check if any shop is reachable from the character's current room.
   * Returns true if at least one shop has a valid path. Used by the
   * goal stack to decide whether the has_money goal is actionable:
   * if no shop is reachable, selling is impossible and the goal
   * falls through to the next one.
   */
  _shopReachable() {
    const c = this.client;
    const hereRaw = c?.room?.num ?? c?.room?.id;
    if (hereRaw == null) return false;
    // Dynamic import to avoid circular dependency at module load time.
    let objIdToNum, loadMap, findPath;
    try {
      ({ objIdToNum } = require_esm('./m59-hunt-room.mjs'));
      ({ loadMap, findPath } = require_esm('./m59-map.mjs'));
    } catch { return false; }
    const here = objIdToNum(hereRaw) ?? hereRaw;
    // If we're already at a shop, it's reachable.
    if (this._shopDest === here) return true;
    // Check if the cached shop dest is still reachable.
    if (this._shopDest) {
      try {
        const { loadMap, findPath } = require('./m59-map.mjs');
        const map = loadMap();
        const p = findPath(map, resolveMapRoom(here, this._roomName()), this._shopDest);
        return p?.found === true;
      } catch { return false; }
    }
    // No cached dest: check if any shop is reachable.
    return nearestShop(here, this._roomName()) != null;
  }

  /**
   * Take one hop toward a destination room. Uses the legacy router to
   * find the next exit and the session to walk it. This is the travel
   * primitive the planner uses: one room at a time, re-planning after
   * each hop.
   */
  async _travelOneHop(to) {
    const c = this.client;
    const hereRaw = c?.room?.num ?? c?.room?.id;
    if (hereRaw == null)
      return { sent: false, arrived: false, reason: 'unknown room' };

    // Convert objId to map num.
    const { objIdToNum } = await import('./m59-hunt-room.mjs');
    const here = objIdToNum(hereRaw) ?? hereRaw;
    if (here === to)
      return { sent: false, arrived: false, reason: 'already there' };

    // Use the broker's travel() first. The broker handles routing
    // internally (BFS, hazard avoidance, exit walking, etc.).
    let travelResult;
    try {
      // maxHops: 1 — move to the NEXT room only. The GOAP keeper re-plans from the new
      // room on the next pass (the _travelInFlight guard clears when the room changes),
      // so a multi-room journey is a chain of single-hop travels, each re-planned. This
      // is how we get past the broker's maxHops limit: we don't ask it to route the whole
      // journey, we ask it for one room at a time.
      travelResult = await this.session.travel(to, { origin: keeperOrigin('goap'), maxHops: 1 });
      // BOTH NAMES, ON PURPOSE. This returned only `sent`, and the idle-wander caller
      // tested `r?.arrived` -- which is never present, so a hop that WORKED reported
      // "no wander" and the keeper scored the pass as nothing happening. JayB stood in
      // Raza picking an exit and reporting failure every pass. Callers here are split
      // between the atomic contract (`sent`) and the travel contract (`arrived`), so
      // this states both rather than making the next caller guess which one it is.
      if (travelResult?.arrived)
        return { sent: true, arrived: true, reason: null };
    } catch (e) {
      travelResult = { arrived: false, reason: e.message };
    }

    // Broker travel failed. Try a brute force exit: send raw
    // moveToSquare commands toward and PAST the room boundary.
    // The server clips movement to the wall and triggers the
    // room change when the character crosses an edge opening.
    //
    // The brute force exit needs the NEXT room (first hop), not
    // the final destination. The broker's travel() routes multi-hop
    // and fails on the first hop, so we need to find what that
    // first hop is.
    let nextHop = to;
    try {
      const { loadMap, findPath } = await import('./m59-map.mjs');
      const map = loadMap();
      const p = findPath(map, resolveMapRoom(here, this._roomName()), to);
      if (p?.found && p.hops?.length > 1)
        nextHop = p.hops[0].to;
    } catch {}
    const bruteResult = await this._bruteForceExit(nextHop);
    if (bruteResult?.sent)
      return { arrived: false, ...bruteResult };

    return { sent: false, arrived: false, reason: travelResult?.reason ?? 'travel refused' };
  }

  /**
   * Brute force exit: when the broker's travel() can't get the
   * character to an exit square (local grid says wall), send raw
   * moveToSquare commands toward and past the boundary. The
   * server handles collision and will trigger the room change
   * when the character crosses an edge opening.
   */
  async _bruteForceExit(to) {
    const c = this.client;
    const world = this.session?.world;
    const room = world?.room;
    if (!room || !c)
      return { sent: false, reason: 'no room data' };

    // Find an exit from the current room to the destination.
    // Use the map's edge exits (more reliable than world.exits()
    // which requires the character to be in a valid position).
    const { loadMap } = await import('./m59-map.mjs');
    const map = loadMap();
    const roomNum = room.num ?? room.id;
    const mapRoom = map?.rooms?.[roomNum];
    let exit = null;
    if (mapRoom) {
      exit = (mapRoom.edgeExits ?? []).find(e => e.to === to);
    } else {
      // Unmapped room: use the broker's world.exits() which reads the room's actual
      // geometry (edgeOpenings). This works for rooms not in the movement map.
      const exits = this.session?.world?.exits?.() ?? [];
      exit = exits.find(e => e.to === to || e.to === Number(to));
      if (exit) {
        // world.exits() gives us the exit but not the map-style fields. Adapt.
        // exit has: to, kind, leaveName (direction), approach (square to stand on)
      }
    }
    if (!exit)
      return { sent: false, reason: `no exit to room ${to}` };

    // Get the character's current position (kod 1-based).
    const me = c.self;
    const myCol = me?.col ?? 1;
    const myRow = me?.row ?? 1;
    // For mapped rooms, use the map dimensions. For unmapped rooms, use the live room
    // dimensions from the client (c.room.cols/rows) or the geometry.
    const rows = mapRoom?.rows ?? c.room?.rows ?? 1;
    const cols = mapRoom?.cols ?? c.room?.cols ?? 1;
    // Direction: map edgeExits use leaveName; world.exits() may use a different field.
    const dir = exit.leaveName ?? exit.dir ?? exit.direction ?? '';
    if (!dir) {
      // No explicit direction: try to infer from the exit's approach square or
      // fall back to a simple heuristic (which edge the exit is near).
      if (exit.approach) {
        const ap = exit.approach;
        const midC = cols / 2, midR = rows / 2;
        if (ap.col >= cols - 2) dir = 'east';
        else if (ap.col <= 1) dir = 'west';
        else if (ap.row <= 1) dir = 'north';
        else if (ap.row >= rows - 2) dir = 'south';
      }
      if (!dir) return { sent: false, reason: 'no exit direction available' };
    }

    // Determine the target square: one past the boundary.
    // The server clips movement to the wall and triggers the
    // room change when the character crosses the edge opening.
    let targetCol, targetRow;
    if (dir === 'east') {
      targetCol = cols;       // one past the last col (0-based: cols-1)
      targetRow = myRow;      // stay on the same row
    } else if (dir === 'west') {
      targetCol = 0;          // or -1, but 0 is the first col
      targetRow = myRow;
    } else if (dir === 'north') {
      targetCol = myCol;
      targetRow = 0;
    } else if (dir === 'south') {
      targetCol = myCol;
      targetRow = rows;
    } else {
      return { sent: false, reason: `unknown exit direction: ${dir}` };
    }

    // Check the exit condition (row> or row<).
    // The condition is on the row where the character exits.
    if (exit.condition) {
      const { name, threshold } = exit.condition;
      const exitRow = targetRow; // the row we'll be at when exiting
      if (name === 'row>' && exitRow <= (threshold ?? 0))
        return { sent: false, reason: `exit condition row>${threshold} not met (row ${exitRow})` };
      if (name === 'row<' && exitRow >= (threshold ?? 999))
        return { sent: false, reason: `exit condition row<${threshold} not met (row ${exitRow})` };
    }

    console.error(`[goap] brute force exit: ${dir} to room ${to}, from (${myCol},${myRow}) to (${targetCol},${targetRow})`);

    try {
      // Send the move command. The server will clip the movement
      // and trigger the room change if the character crosses an
      // edge opening.
      c.moveToSquare(targetCol, targetRow, 18);

      // Wait for the room to change (up to 10 seconds).
      const startRoom = c.room?.id;
      const { events } = await c.waitFor({
        kinds: 'room-entered',
        timeoutMs: 10000,
      });

      const entered = events.find(e => e.kind === 'room-entered');
      if (entered && c.room?.id !== startRoom) {
        console.error(`[goap] brute force exit SUCCESS: entered ${c.room?.name ?? 'new room'}`);
        return { sent: true, reason: null };
      }

      // Room didn't change. Try one more step further past the boundary.
      console.error(`[goap] brute force exit: room didn't change, trying further`);
      let target2Col = targetCol, target2Row = targetRow;
      if (dir === 'east') target2Col = cols + 1;
      else if (dir === 'west') target2Col = 0;
      else if (dir === 'north') target2Row = 0;
      else if (dir === 'south') target2Row = rows + 1;

      c.moveToSquare(target2Col, target2Row, 18);
      const { events: events2 } = await c.waitFor({
        kinds: 'room-entered',
        timeoutMs: 10000,
      });
      const entered2 = events2.find(e => e.kind === 'room-entered');
      if (entered2 && c.room?.id !== startRoom) {
        console.error(`[goap] brute force exit SUCCESS (2nd try): entered ${c.room?.name ?? 'new room'}`);
        return { sent: true, reason: null };
      }

      return { sent: false, reason: `brute force exit failed: room didn't change after moving to (${targetCol},${targetRow}) and (${target2Col},${target2Row})` };
    } catch (e) {
      return { sent: false, reason: 'brute force exit error: ' + e.message };
    }
  }

  /**
   * One pass: evaluate, plan, execute one step.
   *
   * Returns { acted: boolean, action: string|null, reason: string|null }
   * so the autopilot can log what happened.
   */
  // ── host interface for m59-watchdog.mjs ────────────────────────────────
  // Every one of these answers harmlessly rather than throwing: an exception inside a
  // watchdog tick would kill the timer and take the guard down silently, which is the
  // one failure this control cannot have.
  get s() { return this.session; }
  safety() { return safetyFor(this.client, this.policy); }
  recordFrame(why = null) {
    this.lastFrameAt = Date.now();
    this.frames.push({ at: this.lastFrameAt, why, doing: this.doing,
                       health: this.client?.vitals?.()?.health?.value ?? null,
                       room: this.client?.room?.id ?? null });
    if (this.frames.length > 64) this.frames.shift();
  }
  // The planner has no notion of "progress" -- it replans from the world every pass, so
  // there is no stall counter here to reset. Accepted and ignored on purpose.
  progress() {}
  stopWatchdog() { watchdog.stop(this); }

  // THE BRACKET. `passStartedAt` is how the watchdog measures blindness, so it is set
  // before any await and cleared in a finally -- null exactly when no pass is running.
  // A wrapper rather than a try inside the body: the body has many returns, and a
  // hand-placed finally around them is how a guard ends up not covering one of them.
  async pass(wsOverride = null) {
    this.passes = ++this._passBracket;
    this.passStartedAt = Date.now();
    try {
      return await this._pass(wsOverride);
    } finally {
      this.passStartedAt = null;
      this.doing = null;
    }
  }

  async _pass(wsOverride = null) {
    const c = this.client;
    if (!c) {
      return { acted: false, action: null, reason: 'no client' };
    }

    this._passCount++;
    // WHAT THE WATCHDOG MEASURES BLINDNESS FROM. Set before any await and cleared in
    // the finally below, so `passStartedAt` is null exactly when no pass is running.

    // TRACK LEVEL: log max_health changes (level ups)
    const _maxHp = c.vitals?.()?.health?.max;
    this._trackLevel(_maxHp);

    // STUCK DETECTION: if the character's position hasn't changed in
    // the last 10 passes (~10 seconds), the character is stuck.
    // Force a travel to a nearby room to reset the position.
    // EXCEPTION: if the character has a target in reach, they're
    // fighting, not stuck. Don't count passes during combat.
    {
      const me = c.self;
      // If position is unknown, wait for the server to send a
      // position update. The server pushes BP_PLAYER on every tick,
      // so this should resolve within a few passes.
      if (!me || me.col == null || me.row == null) {
        this._noPosCount = (this._noPosCount ?? 0) + 1;
        if (this._noPosCount === 5) {
          console.error(`[goap] ${this.policy.agent ?? '?'} position unknown for ${this._noPosCount} passes`);
        }
        return { acted: false, action: null, reason: 'position unknown, waiting' };
      }
      this._noPosCount = 0;
      // inCombat is checked after ws is defined below; for now just track position
      if (me && me.col != null && me.row != null) {
        // Round to 2-cell blocks so small oscillations (walkTo bounces)
        // don't reset the counter. The character is stuck if it's been
        // in the same 2x2 block for 10 passes.
        const posKey = `${Math.floor(me.col / 2)},${Math.floor(me.row / 2)}`;
        if (this._lastPosKey === posKey && !this._inCombatLastPass) {
          this._stuckCount = (this._stuckCount ?? 0) + 1;
          if (this._stuckCount === 10) {
            console.error(`[goap] ${this.policy.agent} STUCK at (${me.col},${me.row}) for ${this._stuckCount} passes`);
          }
        } else if (!this._inCombatLastPass) {
          this._stuckCount = 0;
          this._lastPosKey = posKey;
        }
        if (this._stuckCount >= 10) {
          console.error(`[goap] ${this.policy.agent} forcing room change to unstick`);
          this._stuckCount = 0;
          this._lastPosKey = null;
          // First: try to travel to a nearby room
          try {
            const { nearestHuntRoom } = await import('./m59-hunt-room.mjs');
            const here = c.room?.num ?? c.room?.id;
            const resolved = resolveMapRoom(here, this._roomName());
            // Find a hunt room that is NOT the current room
            const allRooms = await import('./m59-hunt-room.mjs').then(m => m.huntRoomsAtOrBelow(999));
            const otherRooms = allRooms.filter(r => r.room !== resolved);
            const neighbors = otherRooms.length > 0 ? nearestHuntRoom(resolved, 999, otherRooms[0].level) : null;
            // If the nearest hunt room IS the current room, pick the next closest
            if (neighbors && neighbors.room === resolved && otherRooms.length > 0) {
              const next = otherRooms[0];
              const travelResult = await this.session.travel(next.room, { origin: keeperOrigin('goap_explore'), maxHops: 1 });
              if (travelResult?.arrived) {
                console.error(`[goap] ${this.policy.agent} unstuck: moved to room ${next.room} (${next.creature} lv${next.level})`);
                this._travelInFlight = true;
                this._travelFromRoom = here;
                this._travelStartedAt = Date.now();
                return { acted: true, action: 'unstuck_travel', reason: 'stuck detection: moved to different hunt room' };
              }
            } else if (neighbors) {
              const travelResult = await this.session.travel(neighbors.room, { origin: keeperOrigin('goap_explore'), maxHops: 1 });
              if (travelResult?.arrived) {
                console.error(`[goap] ${this.policy.agent} unstuck: arrived in room ${neighbors.room}`);
                this._travelInFlight = true;
                this._travelFromRoom = here;
                this._travelStartedAt = Date.now();
                return { acted: true, action: 'unstuck_travel', reason: 'stuck detection: forced room change' };
              }
            }
          } catch (e) {
            console.error(`[goap] ${this.policy.agent} travel failed: ${e.message}`);
          }
          // Travel failed (character can't move from no-floor position).
          // Try: cast blink to teleport to a random nearby position.
          // Blink may be in spells OR skills depending on the server.
          // Check both lists.
          try {
            const blinkSpell = (c.spells ?? []).find(sp => {
              const n = c.rsc?.get?.(sp.nameRsc) ?? sp.name ?? '';
              return n.toLowerCase() === 'blink';
            });
            const blinkSkill = (c.skills ?? []).find(sp => {
              const n = c.rsc?.get?.(sp.nameRsc) ?? sp.name ?? '';
              return n.toLowerCase() === 'blink';
            });
            const blink = blinkSpell ?? blinkSkill;
            if (blink) {
              await c.cast(blink.id, []);
              await new Promise(res => setTimeout(res, 1500));
              const newMe = c.self;
              if (newMe && (newMe.col !== me.col || newMe.row !== me.row)) {
                console.error(`[goap] ${this.policy.agent} unstuck by blink: now at (${newMe.col},${newMe.row})`);
                return { acted: true, action: 'unstuck_blink', reason: 'stuck detection: blinked to new position' };
              }
              console.error(`[goap] ${this.policy.agent} blink cast but position unchanged`);
            } else {
              console.error(`[goap] ${this.policy.agent} blink not found in spells (${(c.spells??[]).length}) or skills (${(c.skills??[]).length})`);
            }
          } catch (e) {
            console.error(`[goap] ${this.policy.agent} blink error: ${e.message}`);
          }
          // Last resort: the character is truly stuck. Log it and let
          // the rejoin mechanism handle it (broker will rejoin the session
          // which resets the position to the last valid saved position).
          console.error(`[goap] ${this.policy.agent} TRULY STUCK at (${me.col},${me.row}) — all unstuck methods failed`);
          return { acted: false, action: null, reason: 'truly stuck: no valid position' };
        }
      }
    }

    // TRAVEL IN PROGRESS: if the last action was a travel_to that
    // hasn't completed yet (the character is still moving between
    // rooms), don't re-plan. Each new travel_to cancels the previous
    // one, so re-planning every pass causes the character to cancel
    // its own movement and never complete a room transition.
    // Let the movement finish, then re-plan on the next pass.
    if (this._travelInFlight) {
      // Check if the character is still moving (room hasn't changed
      // since we started the travel, or the broker reports movement
      // in progress).
      const c = this.client;
      const curRoom = c?.room?.num ?? c?.room?.id;
      const elapsed = Date.now() - (this._travelStartedAt ?? 0);
      if (curRoom === this._travelFromRoom && elapsed < 60000) {
        // Still in the same room and less than 60s elapsed —
        // movement might still be in progress. Don't block ALL GOAP
        // activity (the character still needs to flee, fight, etc).
        // Instead, set a flag so the planner filters out travel_to.
        this._blockTravel = true;
      } else {
        // Room changed (travel completed) or 60s elapsed (timeout).
        this._travelInFlight = false;
        this._travelFromRoom = null;
        this._travelStartedAt = null;
        this._blockTravel = false;
      }
    } else {
      this._blockTravel = false;
    }

    // 1. Read the world state. The caller can override symbols that
    //    the client cannot see yet (e.g. in_underworld after a
    //    reconnect, when the client's room is stale but the broker's
    //    room tracking is authoritative).
    const who = this.policy.agent ?? this.session?.s?.name ?? this.session?.name ?? '?';
    const ws = { ...evaluate({ client: c, policy: this.policy, agent: this.policy.agent }), ...(wsOverride ?? {}) };

    // Set the combat flag for the stuck detection (which ran before ws was defined)
    this._inCombatLastPass = ws.has_target === true && ws.in_reach === true;

    // 1b. TARGET DETECTION. The GOAP keeper must set _targetId so
    //     that has_target, in_reach, and target_in_band are produced
    //     from the actual room contents.
    //     _targetId is persisted on `this` so the character sticks with
    //     a target across passes instead of re-picking the nearest one
    //     every 2 seconds (which whiplashes between mummies).
    {
      // Restore persisted target from last pass
      if (this._persistedTargetId != null) {
        ws._targetId = this._persistedTargetId;
        ws._targetLevel = this._persistedTargetLevel;
        ws._threatCeiling = this._persistedThreatCeiling;
        ws._targetIsPlayer = this._persistedTargetIsPlayer;
        // Re-derive has_target and in_reach from the restored target.
        // evaluate() ran without _targetId, so has_target is stale (false).
        ws.has_target = !!c?.room?.objects?.has?.(ws._targetId);
        if (ws.has_target) {
          const tgt = c.room.objects.get(ws._targetId);
          const myPos = c.self;
          if (tgt && myPos) {
            const dx = (tgt.col ?? 0) - (myPos.col ?? 0);
            const dy = (tgt.row ?? 0) - (myPos.row ?? 0);
            ws.in_reach = Math.hypot(dx, dy) <= 2;
          } else { ws.in_reach = false; }
          ws.target_in_band = ws._targetLevel != null ? ws._targetLevel <= ws._threatCeiling : false;
          ws._fight = !ws.target_in_band;
          // Re-check aggro from the live object — the mob may have
          // lost interest (de-aggro) or just noticed us (aggro).
          ws.target_aggro = !!(tgt?.flags & OF.ENEMY);
          // Out-of-band and not aggroed: ignore it.
          if (!ws.target_in_band && !ws.target_aggro) {
            this._persistedTargetId = null;
            this._persistedTargetLevel = null;
            this._persistedThreatCeiling = null;
            this._persistedTargetIsPlayer = null;
            this._persistedTargetAggro = null;
            ws.has_target = false;
            ws.in_reach = false;
            ws._fight = true;
            ws.flee_danger = true;
            ws.target_aggro = false;
          } else {
            ws.flee_danger = ws.target_in_band || !ws.target_aggro;
          }
        } else {
          ws.in_reach = false;
          ws.target_in_band = false;
          ws._fight = true;
          ws.flee_danger = true; // no target = no danger
        }
      }
      const room = c.room;
      if (room?.objects) {
        const list = room.objects instanceof Map
          ? [...room.objects.values()]
          : Array.isArray(room.objects) ? room.objects : [];
        // The engagement ceiling is based on the character's ACTUAL
        // level (max HP), NOT a hardcoded huntLevel. The game level IS
        // the max HP. As the character levels up, the ceiling goes up
        // with it, and he can fight stronger mobs.
        //
        // The huntLevel from the loadout can override this (for
        // specific farming targets), but the default is the character's
        // own level — fight mobs at or near your level.
        const charLevel = c.vitals?.()?.health?.max ?? 20;
        const huntLevel = this.policy.huntLevel ?? charLevel;
        const fullBand = this.policy?.threatBand ?? Math.floor(charLevel / 2);
        // Unarmed characters deal less damage, so halve the band.
        const eq = c?.equipment?.();
        const isArmedNow = !eq || eq.known === false
          ? true
          : (eq.equipped || []).some(o => {
              const nm = o.name ?? c.rsc?.get?.(o.nameRsc) ?? '';
              return /sword|mace|hammer|staff|club|axe|dagger|spear|bow|crossbow|weapon/i.test(nm);
            });
        const band = isArmedNow ? fullBand : Math.floor(fullBand / 2);
        const ceiling = huntLevel + band;

        const cooldowns = (this._pullTargetCooldowns ??= new Map());
        const targetNow = Date.now();
        for (const [id, until] of cooldowns)
          if (until <= targetNow) cooldowns.delete(id);
        const hostiles = list.filter(o => {
          // Raw room objects have o.flags (bit flags), NOT o.can (action list).
          // The action list is derived from flags via affordances(). Using o.can
          // directly was the bug: it was always undefined, so no hostile was ever
          // found, and the GOAP never saw any mobs in the room.
          const can = affordances(o.flags ?? 0);
          const name = c.rsc?.get?.(o.nameRsc) ?? '';
          // Decoration objects (trees, flagpoles, etc.) have the attack
          // affordance in their flags but are not hostiles. "Living tree"
          // is a good creature, not a hostile — exclude it too.
          if (/^(tree|living tree|flagpole|fence|wall|door|window|rock|boulder|bush|grass|flower|mushroom|log|stump)/i.test(name)) return false;
          const cooling = cooldowns.has(Number(o.id ?? o.obj_id));
          const me = c.self;
          const urgent = me
            && Math.hypot((o.col ?? 0) - me.col, (o.row ?? 0) - me.row) <= 2;
          return (!cooling || urgent) && can.includes('attack')
            && !/friendly|pet|tame/i.test(name)
            && !(o.flags & OF.PLAYER); // players are handled separately by the PVP gate
        });



        if (hostiles.length && !ws._targetId) {
          // Pick the target: when hurt, the NEAREST threat is the one
          // eating us — not the weakest one in the corner. When healthy,
          // pick the weakest (safest prey). This is the difference between
          // "a rat is biting my leg" and "I'm choosing what to hunt."
          const me0 = c.self;
          // ELEVATION FILTER: skip targets on a different floor level.
          // The pathfinder cannot walk down a cliff, so a target 3 cells
          // away on the 2D grid but on a lower ledge is unreachable.
          const geo0 = this.session?.world?.geometry;
          const myH = (me0 && geo0?.floorHeightAtCell) ? geo0.floorHeightAtCell(me0.row, me0.col) : null;
          const elevHostiles = myH != null
            ? hostiles.filter(t => {
                const th = geo0.floorHeightAtCell(t.row, t.col);
                return th == null || Math.abs(myH - th) <= 384;
              })
            : hostiles;
          const pool = elevHostiles.length > 0 ? elevHostiles : hostiles;
          if (elevHostiles.length < hostiles.length) {
            console.error(`[goap] ${who} elevation filter: ${hostiles.length} hostiles, ${elevHostiles.length} same-level (myH=${myH})`);
          }
          let target;
          if (ws.hurt && me0) {
            // NEAREST first: the mob actually attacking us
            target = pool.sort((a, b) => {
              const da = Math.hypot((a.col ?? 0) - me0.col, (a.row ?? 0) - me0.row);
              const db = Math.hypot((b.col ?? 0) - me0.col, (b.row ?? 0) - me0.row);
              return da - db;
            })[0];
          } else {
            // WEAKEST first: safest prey for hunting.
            const liveNum0 = c.room?.num ?? c.room?.id ?? null;
            const mapNum0 = liveNum0 != null ? resolveMapRoom(liveNum0, this._roomName()) : null;
            target = pool.sort((a, b) => {
              const nameA = c.rsc?.get?.(a.nameRsc) ?? '';
              const nameB = c.rsc?.get?.(b.nameRsc) ?? '';
              const lvlA = (mapNum0 != null ? _compendiumLevel(mapNum0, nameA) : null) ?? 999;
              const lvlB = (mapNum0 != null ? _compendiumLevel(mapNum0, nameB) : null) ?? 999;
              return lvlA - lvlB;
            })[0];
          }
          const targetName = c.rsc?.get?.(target.nameRsc) ?? target.name ?? 'creature';
          const isPlayer = !!(target.flags & OF.PLAYER);

          // The wire protocol does not send mob HP/level. Use the
          // compendium (m59-spawns.json) to look up the target's level.
          // Without this, targetLevel is always null and target_in_band
          // is always false — the 3D view shows a FLEE ring for every
          // mob, even ones the character can fight.
          //
          // The compendium is keyed by MAP room number, not the live
          // objId. Resolve the live ID to the map num first.
          const liveRoomNum = c.room?.num ?? c.room?.id ?? null;
          const mapRoomNum = liveRoomNum != null ? resolveMapRoom(liveRoomNum, this._roomName()) : null;
          const compLevel = mapRoomNum != null ? _compendiumLevel(mapRoomNum, targetName) : null;
          const targetLevel = target.max_health ?? target.health ?? compLevel ?? null;

          ws._targetId = target.id ?? target.obj_id;
          ws._targetLevel = targetLevel;
          ws._threatCeiling = ceiling;
          ws._targetIsPlayer = isPlayer;

          // A NEW TARGET IS A NEW OPPORTUNITY. Reset the has_loot fail
          // count so the goal-skip doesn't block a fresh target that
          // was unreachable in a different part of the room.
          if (this._goalFailCount?.has_loot) delete this._goalFailCount.has_loot;

          // Re-derive the target-dependent symbols now that _targetId is set.
          // evaluate() already ran without it, so has_target/in_reach/
          // target_in_band are stale. Update them manually.
          ws.has_target = !!c?.room?.objects?.has?.(ws._targetId);
          // in_reach: check distance to target
          if (ws.has_target) {
            const tgt = c.room.objects.get(ws._targetId);
            const myPos = c.self;
            if (tgt && myPos) {
              const dx = (tgt.col ?? 0) - (myPos.col ?? 0);
              const dy = (tgt.row ?? 0) - (myPos.row ?? 0);
              ws.in_reach = Math.hypot(dx, dy) <= 2;
            } else {
              ws.in_reach = false;
            }
          } else {
            ws.in_reach = false;
          }
          ws.target_in_band = targetLevel != null ? targetLevel <= ceiling : false;
          // _fight: false when a fight is needed (target in band), true otherwise
          ws._fight = !ws.target_in_band;
          // Aggro check: the server sets OF.ENEMY when a mob targets us.
          // An out-of-band mob that is NOT aggro is not a threat — we can
          // walk past it. Only flee when the mob is actively hostile.
          ws.target_aggro = !!(target.flags & OF.ENEMY);
          // flee_danger: false when an out-of-band AND aggroed hostile is present
          ws.flee_danger = ws.target_in_band || !ws.target_aggro; // true=safe

          console.error(`[goap] ${who} target detected: ${targetName} (lv${targetLevel ?? '?'}, ${isPlayer ? 'PLAYER' : 'npc'}, hunt lv${huntLevel}, ceiling ${ceiling}, aggro=${ws.target_aggro})`);
          // Persist the target across passes so the character sticks
          // with it instead of re-picking the nearest every 2 seconds.
          this._persistedTargetId = ws._targetId;
          this._persistedTargetLevel = targetLevel;
          this._persistedThreatCeiling = ceiling;
          this._persistedTargetIsPlayer = isPlayer;
          this._persistedTargetAggro = ws.target_aggro;
          // An out-of-band mob that is NOT aggroed is not a threat.
          // Clear it so the character can walk past it and the planner
          // doesn't waste cycles on a mob that's ignoring us.
          if (!ws.target_in_band && !ws.target_aggro) {
            console.error(`[goap] ${who} ignoring out-of-band ${targetName} (not aggroed)`);
            delete ws._targetId;
            delete ws._targetLevel;
            delete ws._threatCeiling;
            delete ws._targetIsPlayer;
            this._persistedTargetId = null;
            this._persistedTargetLevel = null;
            this._persistedThreatCeiling = null;
            this._persistedTargetIsPlayer = null;
            this._persistedTargetAggro = null;
            ws.has_target = false;
            ws.in_reach = false;
            ws.target_in_band = false;
            ws._fight = true;
            ws.flee_danger = true;
            ws.target_aggro = false;
          }
        } else if (!hostiles.length && ws._targetId) {
          // All hostiles are gone. Clear the target.
          delete ws._targetId;
          delete ws._targetLevel;
          delete ws._threatCeiling;
          delete ws._targetIsPlayer;
          this._persistedTargetId = null;
          this._persistedTargetLevel = null;
          this._persistedThreatCeiling = null;
          this._persistedTargetIsPlayer = null;
          ws.has_target = false;
          ws.in_reach = false;
          ws.target_in_band = false;
          ws._fight = true; // no target = no fight needed
          ws.flee_danger = true; // no target = no danger
        } else if (ws._targetId && hostiles.length) {
          // Target is set but may be dead. Check if it's still in the room.
          if (!c?.room?.objects?.has?.(ws._targetId)) {
            // The target died. Clear it so a new one gets picked next pass.
            console.error(`[goap] ${who} target ${ws._targetId} died, clearing for re-target`);
            delete ws._targetId;
            delete ws._targetLevel;
            delete ws._threatCeiling;
            delete ws._targetIsPlayer;
            this._persistedTargetId = null;
            this._persistedTargetLevel = null;
            this._persistedThreatCeiling = null;
            this._persistedTargetIsPlayer = null;
            ws.has_target = false;
            ws.in_reach = false;
            ws.target_in_band = false;
            ws._fight = true; // will be re-evaluated next pass with new target
            ws.flee_danger = true;
          }
        }
      }
    }

    // Visible log: every GOAP pass is logged to the broker console so the
    // journal (in-memory, lost on restart) is not the only record.
    const wsSummary = Object.entries(ws).filter(([,v]) => v !== null)
      .map(([k,v]) => `${k}=${v}`).join(' ');

    // 2. GOAL STACK. Try goals in priority order. The first goal that
    //    is NOT satisfied becomes the effective goal. This is the
    //    "what should I be doing right now" question.
    //
    //    Priority: survival (underworld) > safety (armed) > sustenance
    //    (has_food) > primary goal (vigor_ok or configured).
    const goalStack = [
      { goal: '!in_underworld', when: ws.in_underworld === true },
      // EAT_TO_COMFORTABLE: if the character has food and vigor < 180,
      // eat before fighting. This uses the vigor_comfortable symbol (>=180)
      // as the planning target, so the planner chains eat actions until
      // vigor reaches the ideal fight threshold.
      { goal: 'vigor_comfortable', when: ws.has_food === true && ws.vigor_comfortable === false },
      // FIGHT: if there's a target in band, fight it.
      // Vigor requirements:
      //   - Hurt + in-band target: fight regardless of vigor (defend)
      //   - Not hurt + has food + vigor < 180: eat first
      //   - Not hurt + has food + vigor >= 180: fight freely
      //   - Not hurt + no food: fight (need money for food)
      // CRITICAL (< 30% HP): run from everything.
      { goal: '_fight',        when: ws.has_target === true && ws.target_in_band === true && ws.critical !== true && (ws.hurt === true || (ws.has_food === true ? ws.vigor_comfortable !== false : ws.vigor_floor !== false)) },
      // FLEE_DANGER: an out-of-band hostile is in the room. Do not
      // fight it — run. But if the character is already traveling for
      // a task (sell, bank, buy), the task takes priority: flee the
      // spider AND keep going to the destination. The flee action
      // produces !has_target, which clears the danger, and the travel
      // action continues on the next pass.
      { goal: 'flee_danger',   when: ws.has_target === true && ws.target_in_band === false && !this._shopDest },
      // HEALTHY: if the character is hurt, stop what it's doing,
      // flee from combat if there's a target, and rest to recover.
      { goal: 'healthy',       when: ws.hurt === true },
      // ARMED: try to get a weapon, but don't block combat or food.
      // An unarmed character can still punch, scavenge for money,
      // and buy a weapon later. This is a convenience goal, not a
      // hard prerequisite.
      { goal: 'armed',         when: ws.armed === false },
      // has_food: only try when the character CAN get food (has
      // reagents to cast create food, or has money to buy).
      // Higher priority when vigor is low — a tired character with
      // no food should provision before fighting.
      { goal: 'has_food',      when: ws.has_food === false && (ws.has_reagents === true || ws.has_money === true) && !(this.goal === 'has_loot' && ws.has_loot === false && ws.has_target === false) },
      // pack_room: if the pack is full (or nearly), go to a town to sell.
      // This is higher priority than has_money because a full pack means
      // the character can't loot, pick up, or buy anything.
      { goal: 'pack_room',     when: ws.pack_room === false && ws.has_loot === true && ws.has_target === false },
      // has_money: earn or sell. The character needs money whether
      // it has loot to sell or not. But only trigger when the
      // character CAN make money: it has loot to sell and a shop
      // is reachable, or it's armed (can scavenge for gold).
      // When the shop is unreachable (blocked by a hazard), selling
      // is impossible, so the goal falls through to the next one.
      { goal: 'vigor_rested',   when: ws.vigor_rested === false },
      { goal: 'vigor_ok',       when: ws.vigor_ok === false && ws.has_food === true },
      { goal: 'has_money',     when: ws.has_money === false && (ws.has_loot === true && this._shopReachable() || ws.has_target === true) },
      { goal: this.goal,       when: ws[this.goal] !== true && (this.goal !== 'vigor_ok' || ws.has_food === true) },
    ];
    // Goal-skip: if a goal's action has failed 5+ times in a row,
    // skip it for 30 passes. This prevents infinite loops when the
    // shop is empty or the action is otherwise impossible.
    const active = goalStack.find(g => g.when && (this._goalFailCount?.[g.goal] ?? 0) < 5);

    if (!active) {
      // All goals satisfied. But if there's no target in the room,
      // the character should go find one. Treat as '_fight' so the
      // hunt travel injection fires and the character moves to a
      // room with in-band prey.
      if (ws.has_target === false && ws.in_underworld === false) {
        console.error(`[goap] ${who} pass ${this._passCount} goal=_fight (idle, no target, hunting) ${wsSummary}`);
        // Fall through to planning with '_fight' as the goal.
        const effectiveGoal = '_fight';
        const _roomName = c?.roomNameRsc ? (c.rsc?.get?.(c.roomNameRsc) ?? '?') : (c.room?.name ?? '?');
        console.error(`[goap] ${who} pass ${this._passCount} room=${_roomName}(${c.room?.id ?? '?'}) goal=${effectiveGoal} [idle→hunt] ${wsSummary}`);
        // Inject hunt travel
        const here = c.room?.num ?? c.room?.id;
        if (here != null) {
          try {
            const { nearestHuntRoom } = await import('./m59-hunt-room.mjs');
            const resolvedHere = resolveMapRoom(here, this._roomName());
            const level = this.policy.huntLevel ?? c.vitals?.()?.health?.max ?? 20;
            const eqH = c?.equipment?.();
            const isArmedH = !eqH || eqH.known === false
              ? true
              : (eqH.equipped || []).some(o => {
                  const nm = o.name ?? c.rsc?.get?.(o.nameRsc) ?? '';
                  return /sword|mace|hammer|staff|club|axe|dagger|spear|bow|crossbow|weapon/i.test(nm);
                });
            const fullBandH = this.policy?.threatBand ?? Math.floor(level / 2);
            const bandH = isArmedH ? fullBandH : Math.floor(fullBandH / 2);
            const ceilingH = level + bandH;
            const hunt = nearestHuntRoom(resolvedHere, ceilingH);
            if (hunt && hunt.hops > 0) {
              const dest = hunt.path?.[0] ?? hunt.room;
              const travelToHunt = (client, session) => this._travelOneHop(dest);
              travelToHunt.atomic = 'travel_to';
              travelToHunt.pre = [];
              travelToHunt.effects = ['has_target', 'has_money', 'has_loot'];
              travelToHunt.cost = hunt.hops;
              const p = planFor(c, '_fight', { session: this.session, policy: this.policy, agent: this.policy.agent, ws, extra: [travelToHunt] });
              if (p.found) {
                const step = p.names?.[0];
                if (step === 'travel_to') {
                  this._travelInProgress = true;
                  const r = await this._travelOneHop(dest);
                  this._travelInProgress = false;
                  return { acted: true, action: 'travel_to', reason: `idle→hunt: travelling to ${hunt.creature ?? 'prey'} in room ${dest}` };
                }
              }
            }
          } catch (e) {
            console.error(`[goap] ${who} idle→hunt failed: ${e.message}`);
          }
        }
        // WANDER FALLBACK: no hunt room found (or already in one with
        // no in-band prey). Pick a random adjacent room and walk there.
        // This keeps the character moving and exploring, so the next
        // pass might find a room with in-band mobs.
        try {
          const map = loadMap();
          const roomNum = c.room?.num ?? c.room?.id;
          const resolvedHere = resolveMapRoom(roomNum, this._roomName());
          const roomData = resolvedHere != null ? map.rooms?.[String(resolvedHere)] : null;
          if (roomData) {
            const { exitsOf } = await import('./m59-map.mjs');
            const allExits = exitsOf(roomData).filter(e => e.to != null && e.kind !== 'locked');
            // Prefer edge exits (room boundaries) over go exits (doors).
            // Go exits are only used when there are no edge exits,
            // because the character is trapped in a room with only doors.
            const exits = allExits.filter(e => e.kind === 'edge').length > 0
              ? allExits.filter(e => e.kind === 'edge')
              : allExits;
            if (exits.length > 0) {
              // Pick a random exit (deterministic by pass count to avoid
              // the character bouncing back and forth)
              const idx = this._passCount % exits.length;
              const dest = exits[idx].to;
              console.error(`[goap] ${who} idle→wander: no hunt room, wandering to room ${dest} (exit ${exits[idx].direction ?? exits[idx].kind ?? '?'})`);
              // WHAT THE POSITION PULSE READS. This branch returns before the plan
              // step, so without it `doing` stays null and the pulse excuses a wedged
              // character as "not going anywhere" -- the one case it exists to catch.
              this.doing = 'travelling';
              const r = await this._travelOneHop(dest);
              // A hop that was SENT is progress even if the room has not changed yet;
              // arrival is confirmed on the next pass, from the room itself.
              if (r?.arrived || r?.sent) {
                return { acted: true, action: 'wander',
                         reason: r.arrived ? `idle→wander: moved to room ${dest}`
                                           : `idle→wander: stepped toward room ${dest}` };
              }
              console.error(`[goap] ${who} idle→wander: hop to ${dest} refused — ${r?.reason ?? '?'}`);
            }
          }
        } catch (e) {
          console.error(`[goap] ${who} idle→wander failed: ${e.message}`);
        }
        this.note('goap idle-hunt', { reason: 'no goal matched, no target, no hunt room, wander failed', pass: this._passCount });
        return { acted: false, action: null, reason: 'all goals satisfied, no hunt room, no wander' };
      }
      this.note('goap idle', { goal: this.goal, reason: 'all goals satisfied', pass: this._passCount });
      console.error(`[goap] ${who} pass ${this._passCount} goal=${this.goal} ${wsSummary} [idle: all goals satisfied]`);
      return { acted: false, action: null, reason: 'all goals satisfied' };
    }

    const effectiveGoal = active.goal;
    const _roomName = c?.roomNameRsc ? (c.rsc?.get?.(c.roomNameRsc) ?? '?') : (c.room?.name ?? '?');
    console.error(`[goap] ${who} pass ${this._passCount} room=${_roomName}(${c.room?.id ?? '?'}) goal=${effectiveGoal} ${wsSummary}`);

    // 3. Plan.
    // 3a. Inject travel_to when the goal requires at_shop but we're not
    //     at a shop. Find the nearest shop and create a parameterized
    //     travel_to action with the destination pre-set.
    let extra = [];
    // Inject withdraw when at a bank and the character needs money.
    // The planner chains: at_bank -> withdraw -> has_money -> buy -> armed.
    if (ws.at_bank === true && ws.has_money === false) {
      const { withdraw } = await import('./m59-act/bank.mjs');
      extra.push(withdraw);
    }
    // Inject travel_to bank when the character needs money but is not at a bank.
    // Chain: at_bank -> withdraw -> has_money -> at_shop -> buy -> armed.
    if (ws.has_money === false && ws.at_bank === false && ws.at_shop === false) {
      const here = c.room?.num ?? c.room?.id;
      if (here != null) {
        const { objIdToNum } = await import('./m59-hunt-room.mjs');
        const mapNum = objIdToNum(here) ?? here;
        const { loadMap, findPath } = await import('./m59-map.mjs');
        const map = loadMap();
        const resolved = resolveMapRoom(here, this._roomName());
        // Find the nearest room with a bank
        let bestBank = null;
        for (const [num, r] of Object.entries(map.rooms ?? {})) {
          if (Number(num) === mapNum) continue;
          if (!/bank/i.test(r.name ?? '')) continue;
          const p = findPath(map, resolved, Number(num));
          if (!p.found || p.hops.length === 0) continue;
          if (!bestBank || p.hops.length < bestBank.hops.length) {
            bestBank = { num: Number(num), hops: p.hops };
          }
        }
        if (bestBank) {
          const dest = bestBank.hops[0]?.to ?? bestBank.num;
          const travelToBank = (client, session) => {
            return this._travelOneHop(dest);
          };
          travelToBank.atomic = 'travel_to';
          travelToBank.pre = [];
          travelToBank.effects = ['at_bank'];
          travelToBank.cost = 1;
          extra.push(travelToBank);
          console.error(`[goap] ${who} bank travel injected: ${mapNum} -> ${dest} (nearest bank: ${bestBank.num})`);
        }
      }
    }
    if (ws.in_underworld === true) {
      // Inject the escape_underworld atomic.
      const { escapeUnderworldAtomic } = await import('./m59-act/escape-underworld.mjs');
      extra.push(escapeUnderworldAtomic);
    } else {
      // Inject combat atomics. The character needs these whenever
      // there's a hostile in the room (has_target), OR when the
      // goal is healthy (flee/rest to recover), OR when the
      // character is armed and the goal is has_money/has_loot
      // (scavenge to earn gold).
      const combatGoal = effectiveGoal === 'has_money' || effectiveGoal === 'has_loot';
      // Only inject scavenge when there's actually a target to fight, or when we're
      // hurt (and might need to engage), OR when we're in the hunt room (hops=0, mobs
      // respawning). When we're armed, far from the hunt room, and have no target,
      // scavenge is a dead action (no hostiles here) and the planner will pick it over
      // travel_to because it directly achieves has_money — trapping the character in a
      // mobless room. The travel_to injection below is the right action in that case.
      const here = c.room?.num ?? c.room?.id;
      const level = this.policy.huntLevel ?? c.vitals?.()?.health?.max ?? 20;
      const eq2 = c?.equipment?.();
      const isArmed2 = !eq2 || eq2.known === false
        ? true
        : (eq2.equipped || []).some(o => {
            const nm = o.name ?? c.rsc?.get?.(o.nameRsc) ?? '';
            return /sword|mace|hammer|staff|club|axe|dagger|spear|bow|crossbow|weapon/i.test(nm);
          });
      const fullBand2 = this.policy?.threatBand ?? Math.floor(level / 2);
      const band2 = isArmed2 ? fullBand2 : Math.floor(fullBand2 / 2);
      const levelCeiling2 = level + band2;

      let inHuntRoom = false;
      if (ws.armed === true && combatGoal && ws.has_target === false && here != null) {
        try {
          const { nearestHuntRoom } = await import('./m59-hunt-room.mjs');
          const resolvedHere = resolveMapRoom(here, this._roomName());
          const hunt = nearestHuntRoom(resolvedHere, levelCeiling2);
          inHuntRoom = !!(hunt && hunt.hops === 0);
        } catch {}
      }
      // When the target is out of band (too high level) and the character
      // is NOT hurt, scavenge is a dead action (it will refuse every pass).
      // Don't inject it — let the planner use travel_to to find a room
      // with in-band prey. When hurt, still inject scavenge + flee so the
      // character can disengage.
      const targetEngageable = ws.has_target === true && (ws.target_in_band === true || ws.hurt === true);
      // Unarmed characters can still scavenge (punch) to earn money
      // for a weapon, so don't gate the inHuntRoom case on armed.
      // Also include flee_danger: an out-of-band hostile is present,
      // the character needs flee (but not scavenge/attack).
      const needsFlee = effectiveGoal === 'flee_danger' || effectiveGoal === 'healthy' || (this._shopDest && ws.has_target === true && ws.target_in_band === false);
      if (targetEngageable || ws.hurt === true || (combatGoal && inHuntRoom) || needsFlee) {
        const { attackOf } = await import('./m59-act/attack.mjs');
        const { scavenge } = await import('./m59-act/scavenge.mjs');
        const { takeSafeSpot } = await import('./m59-act/take-safe-spot.mjs');
        const { flee } = await import('./m59-act/flee.mjs');
        // For flee_danger: only inject flee, not attack/scavenge.
        // The character should run, not fight.
        if (effectiveGoal === 'flee_danger') {
          extra.push(flee);
          // Block scavenge and attack so the planner can't pick them.
          this._fleeDangerFilter = new Set(['scavenge', 'attack', 'take_safe_spot']);
        } else {
          extra.push(attackOf(ws), scavenge, takeSafeSpot, flee);
        }

        // When the goal is 'healthy', inject a composite 'recover'
        // atomic. The strategy depends on the threat:
        //   1. Under attack by a PLAYER: flee, then rest. Do not
        //      engage — a player can one-shot.
        //   2. Under attack by a MOB: take a safe spot (wall/corner),
        //      then rest there. A proven wall holds under attack.
        //   3. NOT under attack: travel to the nearest inn and rest
        //      there. Resting in the open is how characters die.
        if (effectiveGoal === 'healthy') {
          const { rest } = await import('./m59-act/rest.mjs');

          if (ws.has_target === true && ws._targetIsPlayer) {
            // Case 1: under attack by a player. Flee, then rest.
            const recover = async (client, session) => {
              const fleeResult = await flee(client, session);
              if (!fleeResult?.sent && fleeResult?.reason !== 'no target') {
                return { acted: false, reason: 'flee failed: ' + (fleeResult?.reason ?? 'unknown') };
              }
              await takeSafeSpot(client, session).catch(() => {});
              const restResult = await rest(client, session);
              return { acted: restResult?.sent === true || fleeResult?.sent === true, reason: restResult?.reason ?? null };
            };
            recover.atomic = 'recover';
            recover.pre = [];
            recover.effects = ['healthy'];
            recover.cost = 2;
            extra.push(recover);
          } else if (ws.has_target === true) {
            // Case 2: under attack by a mob. If the mob is out of band
            // (too high level), flee first — taking a safe spot against
            // a mob 10+ levels above is a death sentence.
            //
            // If we're ALREADY at a wall and still being hit, the wall
            // is not saving us (the mob is adjacent and the wall blocks
            // our escape). In that case, break off the wall and run
            // into the open — a damaged character in the open can still
            // outrun a mob, but one pinned at a wall cannot.
            const shouldFleeFirst = ws.target_in_band === false || ws.hurt === true;
            const recover = async (client, session) => {
              if (shouldFleeFirst) {
                const fleeResult = await flee(client, session);
                if (fleeResult?.sent === true) {
                  // Successfully fled. Now take a safe spot and rest.
                  await takeSafeSpot(client, session).catch(() => {});
                  const restResult = await rest(client, session);
                  return { acted: true, reason: restResult?.reason ?? null };
                }
                // Flee failed (e.g. 'no hostiles' or 'could not move').
                // If we're at a wall, try to break away from it.
                if (fleeResult?.reason?.includes('no hostiles')) {
                  // No hostiles found — just rest.
                  const restResult = await rest(client, session);
                  return { acted: restResult?.sent === true, reason: restResult?.reason ?? null };
                }
              }
              const spotResult = await takeSafeSpot(client, session).catch(() => (null));
              const restResult = await rest(client, session);
              return { acted: restResult?.sent === true, reason: restResult?.reason ?? (spotResult?.reason ?? null) };
            };
            recover.atomic = 'recover';
            recover.pre = [];
            recover.effects = ['healthy'];
            recover.cost = 2;
            extra.push(recover);
          } else {
            // Case 3: not under attack. Travel to nearest inn and rest.
            const here = c.room?.num ?? c.room?.id;
            let alreadyInn = false;
            if (here != null) {
              const { objIdToNum } = await import('./m59-hunt-room.mjs');
              const mapNum = objIdToNum(here) ?? here;
              const { loadMap } = await import('./m59-map.mjs');
              const map = loadMap();
              const room = map.rooms?.[mapNum];
              if (room && /inn|tavern/i.test(room.name ?? '')) {
                alreadyInn = true;
              } else {
                // Find the nearest reachable inn.
                const { findPath } = await import('./m59-map.mjs');
                let bestInn = null;
                for (const [num, r] of Object.entries(map.rooms ?? {})) {
                  if (!/inn|tavern/i.test(r.name ?? '')) continue;
                  if (num === String(mapNum)) continue;
                  const resolvedFrom = resolveMapRoom(mapNum, this._roomName());
                  const p = findPath(map, resolvedFrom, Number(num));
                  if (!p.found) continue;
                  if (!bestInn || p.hops.length < bestInn.hops.length) {
                    bestInn = { num: Number(num), name: r.name, hops: p.hops };
                  }
                }
                if (bestInn) {
                  this._innDest = bestInn.num;
                  console.error(`[goap] ${who} recovering to inn: ${mapNum} -> ${bestInn.num} (${bestInn.name}) hops=${bestInn.hops.length}`);
                  const travelToInn = (client, session) => {
                    return this._travelOneHop(bestInn.hops[0]?.to ?? bestInn.num);
                  };
                  travelToInn.atomic = 'travel_to';
                  travelToInn.pre = [];
                  travelToInn.effects = ['at_inn'];
                  travelToInn.cost = 1;
                  extra.push(travelToInn);

                  const restAtInn = async (client, session) => {
                    const restResult = await rest(client, session);
                    return { acted: restResult?.sent === true, reason: restResult?.reason ?? null };
                  };
                  restAtInn.atomic = 'rest_at_inn';
                  restAtInn.pre = ['at_inn'];
                  restAtInn.effects = ['healthy'];
                  restAtInn.cost = 1;
                  extra.push(restAtInn);
                } else {
                  // No reachable inn. Rest in place.
                  const recover = async (client, session) => {
                    const restResult = await rest(client, session);
                    return { acted: restResult?.sent === true, reason: restResult?.reason ?? null };
                  };
                  recover.atomic = 'recover';
                  recover.pre = [];
                  recover.effects = ['healthy'];
                  recover.cost = 1;
                  extra.push(recover);
                }
              }
            }
            if (alreadyInn) {
              const recover = async (client, session) => {
                const restResult = await rest(client, session);
                return { acted: restResult?.sent === true, reason: restResult?.reason ?? null };
              };
              recover.atomic = 'recover';
              recover.pre = [];
              recover.effects = ['healthy'];
              recover.cost = 1;
              extra.push(recover);
            }
          }
        }
      }
      // HUNT ROOM TRAVEL: when there's no target in the room and the
      // character is in a hunting zone (not a town), travel to the
      // nearest room that has in-band mobs. This prevents the character
      // from sitting in an empty room waiting for prey that won't spawn.
      // Only inject when:
      //   - No target in the room (has_target=false)
      //   - Not at a shop/bank/inn (those goals handle their own travel)
      //   - Not already traveling (travel in progress)
      //   - The current room is NOT already a hunt room (hops > 0)
      //   - The goal is a combat/economy goal (has_money, has_loot, _fight)
      if (ws.has_target === false && !this._shopDest && !this._travelInProgress &&
          !this._blockTravel && ws.in_underworld === false) {
        const combatOrEconGoal = effectiveGoal === 'has_money' || effectiveGoal === 'has_loot' || effectiveGoal === '_fight';
        if (combatOrEconGoal) {
          const here = c.room?.num ?? c.room?.id;
          if (here != null) {
            try {
              const { nearestHuntRoom } = await import('./m59-hunt-room.mjs');
              const resolvedHere = resolveMapRoom(here, this._roomName());
              const level = this.policy.huntLevel ?? c.vitals?.()?.health?.max ?? 20;
              const eqH = c?.equipment?.();
              const isArmedH = !eqH || eqH.known === false
                ? true
                : (eqH.equipped || []).some(o => {
                    const nm = o.name ?? c.rsc?.get?.(o.nameRsc) ?? '';
                    return /sword|mace|hammer|staff|club|axe|dagger|spear|bow|crossbow|weapon/i.test(nm);
                  });
              const fullBandH = this.policy?.threatBand ?? Math.floor(level / 2);
              const bandH = isArmedH ? fullBandH : Math.floor(fullBandH / 2);
              const ceilingH = level + bandH;
              const hunt = nearestHuntRoom(resolvedHere, ceilingH);
              if (hunt && hunt.hops > 0) {
                const dest = hunt.path?.[0] ?? hunt.room;
                const travelToHunt = (client, session) => {
                  return this._travelOneHop(dest);
                };
                travelToHunt.atomic = 'travel_to';
                travelToHunt.pre = [];
                travelToHunt.effects = ['has_target', 'has_money', 'has_loot'];
                travelToHunt.cost = hunt.hops;
                extra.push(travelToHunt);
                console.error(`[goap] ${who} hunt travel injected: ${resolvedHere} -> ${dest} (${hunt.creature ?? '?'} lv${hunt.level ?? '?'}) hops=${hunt.hops}`);
              }
            } catch (e) {
              console.error(`[goap] ${who} hunt travel failed: ${e.message}`);
            }
          }
        }
      }
      // Rest is already in ALWAYS (the standard action set), so
      // no need to inject it here. The can_rest_higher goal
      // already has rest available.
      // Force room change: scavenge failed 3+ times in this room.
      // The geometry is broken — leave and come back later.
      if (this._forceRoomChange) {
        this._forceRoomChange = false;
        const here = c.room?.num ?? c.room?.id;
        if (here != null) {
          const { objIdToNum } = await import('./m59-hunt-room.mjs');
          const mapNum = objIdToNum(here) ?? here;
          const { loadMap, findPath } = await import('./m59-map.mjs');
          const map = loadMap();
          const resolved = resolveMapRoom(here, this._roomName());
          // Find the nearest reachable room that ISN'T the current one
          let best = null;
          for (const [num, r] of Object.entries(map.rooms ?? {})) {
            if (Number(num) === mapNum) continue;
            const p = findPath(map, resolved, Number(num));
            if (!p.found || p.hops.length === 0) continue;
            if (!best || p.hops.length < best.hops.length) {
              best = { num: Number(num), hops: p.hops };
            }
          }
          if (best) {
            const forceTravel = (client, session) => {
              return this._travelOneHop(best.hops[0]?.to ?? best.num);
            };
            forceTravel.atomic = 'travel_to';
            forceTravel.pre = [];
            forceTravel.effects = ['!has_target', 'flee_danger', 'has_money', 'has_loot'];
            forceTravel.cost = 1;
            extra.push(forceTravel);
            console.error(`[goap] ${who} force room change: ${mapNum} -> ${best.hops[0]?.to ?? best.num} (nearest reachable)`);
          }
        }
      }
      // Inject travel_to a hunt room when the character has no target.
      // Works armed or unarmed — an unarmed character still needs to
      // fight something to earn money for a weapon.
      if (ws.has_target === false || ws.target_in_band === false) {
        const here = c.room?.num ?? c.room?.id;
        const level = this.policy.huntLevel ?? c.vitals?.()?.health?.max ?? 20;
        // Use the same reduced band for unarmed characters as the
        // target detection, so the hunt room matches what he can fight.
        const eq3 = c?.equipment?.();
        const isArmed3 = !eq3 || eq3.known === false
          ? true
          : (eq3.equipped || []).some(o => {
              const nm = o.name ?? c.rsc?.get?.(o.nameRsc) ?? '';
              return /sword|mace|hammer|staff|club|axe|dagger|spear|bow|crossbow|weapon/i.test(nm);
            });
        const fullBand3 = this.policy?.threatBand ?? Math.floor(level / 2);
        const band3 = isArmed3 ? fullBand3 : Math.floor(fullBand3 / 2);
        const levelCeiling3 = level + band3;
        if (here != null) {
          const { nearestHuntRoom } = await import('./m59-hunt-room.mjs');
          const resolvedHere = resolveMapRoom(here, this._roomName());
          const hunt = nearestHuntRoom(resolvedHere, levelCeiling3);
          if (hunt && hunt.hops > 0) {
            // Travel to a hunt room with mobs.
            const travelToHunt = (client, session) => {
              return this._travelOneHop(hunt.path[0] ?? hunt.room);
            };
            travelToHunt.atomic = 'travel_to_hunt';
            travelToHunt.pre = [];
            // Reaching the hunt room is a step toward both has_target (mobs are there)
            // and has_money (we scavenge there). Declaring both lets the planner chain
            // travel_to directly for the has_money goal without needing scavenge to be
            // injected in the destination room (the planner is room-local).
            travelToHunt.effects = ['has_target', 'has_money', 'has_loot'];
            travelToHunt.cost = 1;
            extra.push(travelToHunt);
            console.error(`[goap] ${who} hunting: room=${here} -> hunt=${hunt.room} (${hunt.creature} lv${hunt.level}) hops=${hunt.hops}`);
          } else {
            console.error(`[goap] ${who} hunting: room=${here} resolved=${resolvedHere} hunt=${hunt ? `hops=${hunt.hops} room=${hunt.room}` : 'null'} ceiling=${levelCeiling3}`);
          }
          // If hunt.hops === 0, we're already in a hunt room.
          // Mobs may be respawning; inject scavenge so the planner
          // can plan scavenge -> has_money. When mobs respawn, scavenge
          // finds a target and fights. When there are none, it returns
          // { acted: false, reason: 'no target' } and the character
          // waits for the next pass.
          if (hunt && hunt.hops === 0) {
            const { scavenge } = await import('./m59-act/scavenge.mjs');
            extra.push(scavenge);
            console.error(`[goap] ${who} in hunt room ${hunt.room} (${hunt.creature} lv${hunt.level}), waiting for mobs`);
          }
        }
      }
      // Inject travel_to a shop when the character needs to buy
      // something (food or money) but isn't at a shop. Armed
      // characters earn money by scavenging, but they still need
      // to buy food.
      if ((effectiveGoal === 'has_money' && ws.armed === false) || effectiveGoal === 'has_food' || effectiveGoal === 'pack_room' || effectiveGoal === 'armed') {
        const here = c.room?.num ?? c.room?.id;
        if (here != null && ws.at_shop === false) {
          const { objIdToNum } = await import('./m59-hunt-room.mjs');
          const mapNum = objIdToNum(here) ?? here;
          // Use cached shop destination if we have one, otherwise
          // pick the nearest shop and cache it. This prevents
          // oscillation where the character bounces between rooms
          // because the nearest shop changes direction each pass.
          if (!this._shopDest || this._shopDest === mapNum) {
            const shop = nearestShop(mapNum, this._roomName());
            if (shop) {
              this._shopDest = shop.to;
              console.error(`[goap] ${who} shop dest cached: room=${mapNum} -> shop=${shop.to} hops=${shop.hops.length}`);
            } else {
              // No reachable shop. Clear any stale cache so the
              // character can fall through to other goals.
              if (this._shopDest) {
                console.error(`[goap] ${who} no reachable shop from ${mapNum}, clearing shop cache`);
                this._shopDest = null;
              }
            }
          }
          if (this._shopDest && this._shopDest !== mapNum) {
            const dest = this._shopDest;
            const travelToShop = (client, session) => {
              return this._travelOneHop(dest);
            };
            travelToShop.atomic = 'travel_to';
            travelToShop.pre = [];
            travelToShop.effects = ['at_shop'];
            travelToShop.cost = 1;
            extra.push(travelToShop);
          }
          // Clear the cache when we arrive at the shop.
          if (ws.at_shop === true) this._shopDest = null;
        }
      }
    }

    // When a hostile is present and the goal is 'healthy', remove plain `rest`
    // from the action set so the planner is forced to use `recover` (which
    // includes fleeing / safe-spot before resting). Resting in the open while
    // a mob is in reach is how characters die.
    const planFilter = new Set();
    if (effectiveGoal === 'healthy' && ws.has_target === true) planFilter.add('rest');
    if (effectiveGoal === 'flee_danger') {
      // When fleeing a dangerous mob, block everything except flee.
      // The character should run, not fight, rest, or scavenge.
      planFilter.add('scavenge');
      planFilter.add('attack');
      planFilter.add('take_safe_spot');
      planFilter.add('rest');
      planFilter.add('recover');
    }
    // When CRITICAL and a hostile is present, block scavenge. The
    // character should flee, not fight. But a merely hurt character
    // (HP > 30%) can still fight an in-band target — fleeing from a
    // rat you can kill is worse than taking a few hits.
    if (ws.critical === true && ws.has_target === true) planFilter.add('scavenge');
    if (this._blockTravel) planFilter.add('travel_to');
    const p = planFor(c, { [effectiveGoal]: true }, { session: this.session, policy: this.policy, agent: this.policy.agent, extra, filter: planFilter.size ? planFilter : null, ws });
    // Record the plan for the dashboard / hero page. A visible plan is
    // the only plan you can argue with.
    this._lastPlan = {
      goal: effectiveGoal,
      found: p.found,
      names: p.names ?? [],
      reason: p.reason ?? null,
      ws: wsSummary,
      pass: this._passCount,
      at: Date.now(),
      // Target info for the 3D view: which object is being engaged,
      // whether it's in band, and whether it's a player.
      target: ws._targetId ? {
        id: ws._targetId,
        in_band: ws.target_in_band,
        is_player: ws._targetIsPlayer,
      } : null,
    };
    console.error(`[goap] ${who} pass ${this._passCount} PLAN found=${p.found} names=[${(p.names ?? []).join(', ')}] steps=${p.steps?.length ?? 0} problems=${(p.problems ?? []).length} reason=${p.reason ?? 'n/a'}`);

    if (p.problems?.length) {
      console.error(`[goap] ${who} pass ${this._passCount} PROBLEMS: ${p.problems.join('; ')}`);
      this.note('goap plan problems', { problems: p.problems });
      return { acted: false, action: null, reason: p.problems.join('; ') };
    }

    if (!p.found) {
      // No plan. That is an ANSWER -- something the plan needs is absent -- but it is
      // also the clearest possible evidence that THIS GOAL is unreachable right now,
      // and it was the one outcome that never counted toward the goal-skip. The counter
      // lives after the execute step, and this path returns before it, so a goal that
      // could not be planned was re-selected on every pass for ever while every other
      // kind of failure was counted after five.
      //
      // Watched live: JayB, standing in Raza, goal has_food, "exhausted 13 nodes without
      // finding a plan", every pass, not moving. The keeper was being honest and still
      // going nowhere.
      this._goalFailCount = this._goalFailCount ?? {};
      this._goalFailCount[active.goal] = (this._goalFailCount[active.goal] ?? 0) + 1;
      if (this._goalFailCount[active.goal] === 5)
        console.error(`[goap] ${who} goal ${active.goal} has no plan 5 times, skipping for 30 passes`);
      this.note('goap no plan', { goal: this.goal, reason: p.reason ?? 'goal not reachable', pass: this._passCount, fails: this._goalFailCount[active.goal] });
      console.error(`[goap] ${this.policy.agent ?? this.session?.s?.name ?? '?'} pass ${this._passCount} NO PLAN: ${p.reason ?? 'goal not reachable'}`);
      return { acted: false, action: null, reason: `no plan: ${p.reason ?? 'goal not reachable'}` };
    }

    // 4. Execute one step.
    if (!p.steps?.length) {
      console.error(`[goap] ${who} pass ${this._passCount} PLAN EMPTY: found=${p.found} names=[${(p.names ?? []).join(', ')}]`);
      return { acted: false, action: null, reason: 'plan is empty' };
    }

    console.error(`[goap] ${who} pass ${this._passCount} EXEC step=${p.steps[0]?.atomic ?? '?'}`);
    // Pass the threat ceiling to atomics that need it (scavenge uses it
    // for its band check). Without this, the scavenge uses myLevel*2
    // which is looser than the GOAP's myLevel+threatBand, and the
    // character walks toward a mob it should be running from.
    const charLevel2 = c.vitals?.()?.health?.max ?? 20;
    const mapRoomNum = resolveMapRoom(c.room?.num ?? c.room?.id ?? null, this._roomName());
    const execArgs = {
      threatCeiling: ws._threatCeiling ?? null,
      targetInBand: ws.target_in_band ?? null,
      targetId: ws._targetId ?? null,
      huntLevel: this.policy.huntLevel ?? charLevel2,
      threatBand: this.policy.threatBand ?? Math.floor(charLevel2 / 2),
      mapRoomNum,
    };
    // MAX PASS GUARD: if this step takes longer than 8s, the broker's
    // event loop has been monopolised for too long. We cannot abort the
    // atomic mid-flight (it's awaiting socket I/O), but we log the
    // offence so the offending atomic can be found and fixed. The reduced
    // fight params (3 rounds, 1 swing) should keep passes well under this.
    // WHAT THE POSITION PULSE READS. It flags only a character that is NOT MOVING while
    // it has somewhere to be -- 'travelling' is in its GOING set and everything else is
    // excused as standing still on purpose. So anything that walks maps to travelling;
    // a fight or a rest deliberately does not, because standing still IS those.
    const _stepName = actionNameOf(p.steps?.[0], p);
    this.doing = /travel|walk|scavenge|approach|flee/i.test(String(_stepName))
      ? 'travelling' : (_stepName || null);
    const passStart = Date.now();
    const result = await stepPlan(c, this.session, p, { index: 0, args: execArgs });
    const passMs = Date.now() - passStart;
    if (passMs > 8000) {
      console.error(`[goap] ${who} pass ${this._passCount} SLOW: step=${p.steps[0]?.atomic} took ${passMs}ms (>8000ms) — broker was unresponsive during this time`);
    }
    console.error(`[goap] ${who} pass ${this._passCount} EXEC done acted=${result.acted} reason=${result.reason ?? 'none'} (${passMs}ms)`);

    const stepName = p.names?.[0] ?? result.action ?? '';

    // A quarry that stopped closing is a target/aggro failure, not bad geometry and not
    // a bad wall. Cool that exact id briefly, clear the persisted choice, and let the
    // next pass choose another quarry before recomputing its safe spot.
    if (stepName === 'scavenge' && result.result?.pull_stalled) {
      const stalled = result.result;
      const stalledId = Number(stalled.stalled_target_id ?? this._persistedTargetId);
      if (Number.isFinite(stalledId))
        (this._pullTargetCooldowns ??= new Map()).set(
          stalledId, Date.now() + Math.max(3_000, Number(this.policy.pullTargetCooldownMs ?? 30_000)));
      console.error(`[goap] ${who} quarry ${stalledId} stopped closing; cooling it and re-picking target+wall`);
      this.note('disengaging from a quarry that stopped following', {
        target_id: stalledId, wall: stalled.wall ?? null,
        last_position: stalled.last_position ?? null,
        last_distance: stalled.last_distance ?? null,
        best_distance: stalled.best_distance ?? null,
        doing_instead: 'selecting another target, then its closest coarse-valid safe spot',
      });
      this._persistedTargetId = null;
      this._persistedTargetLevel = null;
      this._persistedThreatCeiling = null;
      this._persistedTargetIsPlayer = null;
      this._persistedTargetAggro = null;
      this._scavFailCount = 0;
      this._scavFailRoom = null;
    // If scavenge failed because targets were unreachable, clear the
    // persisted target so the next pass picks a different one. Without
    // this, the GOAP keeps re-picking the same unreachable target every
    // pass and the character stands still.
    } else if (stepName === 'scavenge' && /could not reach|could not get|could not pull|unreachable|no approach|ran out of steps|nothing here matches|selected target .* no longer available|no target-valid safe spot|could not establish a pull/i.test(result.reason ?? '')) {
      console.error(`[goap] ${who} scavenge unreachable, clearing target ${this._persistedTargetId} for re-pick`);
      this._persistedTargetId = null;
      this._persistedTargetLevel = null;
      this._persistedThreatCeiling = null;
      this._persistedTargetIsPlayer = null;
      this._persistedTargetAggro = null;
      // Track scavenge failures per room. After 3 failures in the
      // same room, the geometry is broken — force a room change.
      const roomNum = c.room?.num ?? c.room?.id;
      if (this._scavFailRoom === roomNum) {
        this._scavFailCount = (this._scavFailCount ?? 0) + 1;
      } else {
        this._scavFailRoom = roomNum;
        this._scavFailCount = 1;
      }
      if (this._scavFailCount >= 3) {
        console.error(`[goap] ${who} scavenge failed ${this._scavFailCount}x in room ${roomNum}, forcing room change`);
        this._scavFailCount = 0;
        this._scavFailRoom = null;
        // Force travel to a different room on the next pass
        this._forceRoomChange = true;
      }
    } else {
      // Successful action resets the fail counter
      this._scavFailCount = 0;
      this._scavFailRoom = null;
    }

    // Track travel in progress: if this step WAS a travel_to
    // Only track travel in progress when the travel ACTUALLY SENT A PACKET
    // (acted=true). If the travel was refused (acted=false), do NOT set the guard —
    // let the next pass re-plan immediately, possibly with a different approach.
    // A refused travel means nothing is in motion, so there is no movement to protect.
    if (stepName === 'travel_to' && result.acted === true) {
      this._travelInFlight = true;
      this._travelFromRoom = c?.room?.num ?? c?.room?.id;
      this._travelStartedAt = Date.now();
      console.error(`[goap] ${who} travel in flight from room=${this._travelFromRoom}`);
    } else if (stepName === 'travel_to' && result.acted !== true) {
      // Travel refused: clear any stale guard so the next pass re-plans.
      this._travelInFlight = false;
      this._travelFromRoom = null;
      this._travelStartedAt = null;
    }

    const actionName = result.action ?? p.names?.[0] ?? 'unknown';
    // Track goal failures: if the action was refused, increment the
    // fail count for the current goal. If it acted, reset the count.
    if (!result.acted) {
      this._goalFailCount = this._goalFailCount ?? {};
      this._goalFailCount[active.goal] = (this._goalFailCount[active.goal] ?? 0) + 1;
      if (this._goalFailCount[active.goal] === 5) {
        console.error(`[goap] ${who} goal ${active.goal} failed 5 times, skipping for 30 passes`);
      }
    } else {
      if (this._goalFailCount?.[active.goal]) {
        this._goalFailCount[active.goal] = 0;
      }
    }
    // Decay the fail count over time so skipped goals retry eventually.
    if (this._goalFailCount) {
      for (const g of Object.keys(this._goalFailCount)) {
        if (g !== active.goal && this._goalFailCount[g] > 0) {
          this._goalFailCount[g]--;
        }
      }
    }
    this.note('goap step', {
      action: actionName,
      result: result.result,
      acted: result.acted,
      pass: this._passCount,
      plan: p.names ?? [],
    });
    console.error(`[goap] ${this.policy.agent ?? this.session?.s?.name ?? '?'} pass ${this._passCount} ACTION=${actionName} plan=[${(p.names ?? []).join(' -> ')}] ${result.acted ? 'acted' : 'refused: ' + (result.reason ?? '?')}`);

    return {
      acted: result.acted === true,
      action: actionName,
      reason: result.reason ?? null,
    };
  }
}
