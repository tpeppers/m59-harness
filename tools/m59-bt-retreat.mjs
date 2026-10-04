#!/usr/bin/env node
// m59-bt-retreat.mjs -- behavior-tree nodes for retreat-to-safety and withdraw.
//
// Decomposes retreatToSafety() and withdraw() into a tree of small, testable
// nodes. These are the "where do I go when I'm in danger" decisions that the
// flee/farm BT nodes call.
//
// retreatToSafety priority order:
//   1. already_safe   -- holding a working safe spot
//   2. quiet_retreat  -- in a monster-free room (not a true sanctuary)
//   3. sanctuary      -- in an inn
//   4. travel_refuge  -- walk to the nearest inn/retreat
//   5. local_wall     -- no route; fall back to a wall in this room
//
// withdraw priority order:
//   1. already_safe   -- holding a working safe spot (shared with retreat)
//   2. take_wall      -- find a wall in this room
//   3. walk_away      -- no wall; walk to a far square
//
// New node types introduced here:
//   - Fallback: a node that tries its children in order; if all fail, it
//     executes a fallback action. This is the pattern for "try the good
//     options first, then do the weak thing."
//
// No broker, no I/O -- the nodes call keeper methods that do the I/O.

import { keeperOrigin } from './m59-move-origin.mjs';
import {
  Selector, Sequence, Condition, Action,
  SUCCESS, FAILURE, RUNNING,
} from './m59-bt.mjs';

// ---------------------------------------------------------------------------
// AsyncAction (same pattern as m59-bt-farm.mjs and m59-bt-flee.mjs)
// ---------------------------------------------------------------------------

class AsyncAction {
  constructor(fn, opts = {}) {
    this.fn = fn;
    this.key = opts.key || `aa_${Math.random().toString(36).slice(2, 10)}`;
    this._name = opts.name || 'AsyncAction';
  }
  tick(bb) {
    if (!bb._bt) bb._bt = {};
    const slot = bb._bt[this.key];
    if (slot && slot.done) { delete bb._bt[this.key]; return slot.result; }
    if (slot && slot.promise) return RUNNING;
    const p = this.fn(bb, {});
    if (p && typeof p.then === 'function') {
      bb._bt[this.key] = { promise: p, done: false, result: null };
      p.then(r => { bb._bt[this.key].done = true; bb._bt[this.key].result = r; },
             e => { bb._bt[this.key].done = true; bb._bt[this.key].result = FAILURE; });
      return RUNNING;
    }
    return p ?? FAILURE;
  }
  async tickAsync(bb) {
    if (!bb._bt) bb._bt = {};
    const slot = bb._bt[this.key];
    if (slot && slot.promise) {
      try {
        const result = await slot.promise;
        delete bb._bt[this.key];
        return result;
      } catch {
        delete bb._bt[this.key];
        return FAILURE;
      }
    }
    const p = this.fn(bb, {});
    if (p && typeof p.then === 'function') {
      try { return await p; } catch { return FAILURE; }
    }
    return p ?? FAILURE;
  }
}

const asyncAction = (fn, opts) => new AsyncAction(fn, opts);

// ---------------------------------------------------------------------------
// Fallback node: try children in order, then do a fallback action
// ---------------------------------------------------------------------------

/**
 * A Fallback node tries its children in order. If any child returns SUCCESS,
 * the Fallback returns SUCCESS. If all children return FAILURE, it executes
 * the fallback action and returns its result.
 *
 * This is the pattern for "try the good options first, then do the weak
 * thing." For example: "try to travel to an inn; if no route, take a local
 * wall."
 */
export class Fallback {
  constructor(children, fallback, opts = {}) {
    this.children = children;
    this.fallback = fallback;
    this._name = opts.name || 'Fallback';
  }
  tick(bb) {
    for (const child of this.children) {
      const r = child.tick(bb);
      if (r === SUCCESS) return SUCCESS;
      if (r === RUNNING) return RUNNING;
    }
    return this.fallback ? this.fallback.tick(bb) : FAILURE;
  }
  async tickAsync(bb) {
    for (const child of this.children) {
      if (typeof child.tickAsync === 'function') {
        const r = await child.tickAsync(bb);
        if (r === SUCCESS) return SUCCESS;
        if (r === RUNNING) return RUNNING;
      } else {
        const r = child.tick(bb);
        if (r === SUCCESS) return SUCCESS;
        if (r === RUNNING) return RUNNING;
      }
    }
    return this.fallback
      ? (typeof this.fallback.tickAsync === 'function'
          ? await this.fallback.tickAsync(bb)
          : this.fallback.tick(bb))
      : FAILURE;
  }
}

// ---------------------------------------------------------------------------
// Node: already_safe (holding a working safe spot)
// ---------------------------------------------------------------------------

export function alreadySafeNode(keeper) {
  return asyncAction(async (bb) => {
    if (!keeper.hold || !keeper.holdWorks()) return FAILURE;

    keeper.note('staying behind the wall instead of running', {
      spot: { col: keeper.hold.col, row: keeper.hold.row },
      why: 'this square has held under attack, so nothing here can land a blow unless we ' +
           'swing -- leaving it would trade the only thing keeping us alive for distance ' +
           'we do not need',
    });
    bb._result = { arrived: true, held_spot: true };
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: quiet_retreat (in a monster-free room)
// ---------------------------------------------------------------------------

export function quietRetreatNode(keeper) {
  return asyncAction(async (bb) => {
    const s = keeper.s;
    const here = s.world?.room?.num ?? null;
    const PREFERRED_QUIET_RETREATS = keeper.constructor.PREFERRED_QUIET_RETREATS || {};

    const inQuietRetreat = Object.values(PREFERRED_QUIET_RETREATS)
      .some(x => x.room === here);
    if (!inQuietRetreat) return FAILURE;

    keeper.note('already in a monster-free retreat', {
      room: here,
      player_safe: false,
      safety: 'no monsters spawn here; another player can still attack',
    });
    bb._result = { arrived: true, already: true, room: here, player_safe: false };
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: sanctuary (in an inn)
// ---------------------------------------------------------------------------

export function sanctuaryNode(keeper) {
  return asyncAction(async (bb) => {
    const s = keeper.s;
    const here = s.world?.room?.num ?? null;
    const CITY_INNS = keeper.constructor.CITY_INNS || {};
    const inns = Object.entries(CITY_INNS).map(([city, v]) => ({ city, ...v }));

    if (here == null || !inns.some(i => i.inn === here)) return FAILURE;

    keeper.note('already in a sanctuary', { room: here });
    bb._result = { arrived: true, already: true };
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: travel_refuge (walk to nearest inn/retreat)
// ---------------------------------------------------------------------------

export function travelRefugeNode(keeper) {
  return asyncAction(async (bb) => {
    const s = keeper.s, c = s.client;
    const here = s.world?.room?.num ?? null;
    const CITY_INNS = keeper.constructor.CITY_INNS || {};
    const inns = Object.entries(CITY_INNS).map(([city, v]) => ({ city, ...v }));

    // Rank inns by hops, nearest first
    const rankedInns = inns
      .map(i => ({ ...i, hops: s.world?.route?.(i.inn)?.hops?.length ?? Infinity }))
      .filter(i => Number.isFinite(i.hops))
      .sort((a, b) => a.hops - b.hops)
      .map(i => ({ ...i, preferred: false, safety: 'true sanctuary', playerSafe: true }));

    // Preferred quiet retreat wins over a farther inn
    const preferredQuietRetreat = keeper.constructor.preferredQuietRetreat;
    const quiet = preferredQuietRetreat?.(s.world, { maxHops: 6 });
    const ranked = [
      ...(quiet ? [{ city: null, inn: quiet.room, innName: quiet.name, ...quiet }] : []),
      ...rankedInns.filter(i => i.inn !== quiet?.room),
    ];

    if (!ranked.length) return FAILURE; // no route to any refuge

    // Try the two nearest
    for (const dest of ranked.slice(0, 2)) {
      keeper.note('running all the way to safety', {
        to: dest.innName, room: dest.inn, hops: dest.hops,
        safety: dest.safety,
        player_safe: dest.playerSafe,
        health: (() => {
          const h = c?.vitals?.()?.health;
          return h?.max ? Math.round(100 * h.value / h.max) + '%' : null;
        })(),
        why_not_local: 'a few squares from a crowd is still inside its vision and its chase',
      });

      const r = await keeper.travel(dest.inn, { origin: keeperOrigin('bt_retreat'), reason: 'retreat' })
                         .catch(e => ({ arrived: false, error: String(e) }));
      if (r?.arrived) {
        keeper.progress(`reached ${dest.preferred ? 'monster-free retreat' : 'safety'} at ${dest.innName}`);
        keeper.fledInARow = 0;
        bb._result = { arrived: true, at: dest.innName, room: dest.inn, hops: dest.hops,
                       preferred: dest.preferred, player_safe: dest.playerSafe };
        return SUCCESS;
      }
    }

    // Both attempts failed
    return FAILURE;
  });
}

// ---------------------------------------------------------------------------
// Node: local_wall (fallback to a wall in this room)
// ---------------------------------------------------------------------------

export function localWallNode(keeper) {
  return asyncAction(async (bb) => {
    const threats = keeper.inReachOfUs?.() ?? [];
    keeper.note('no refuge is routable from here -- falling back to a local wall', {
      why: 'the inn is not reachable from this room; a wall is better than nothing',
    });
    await keeper.withdraw(threats).catch(() => {});
    bb._result = { arrived: false, fell_back: true, no_route: true };
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: take_wall (find a wall in this room)
// ---------------------------------------------------------------------------

export function takeWallNode(keeper) {
  return asyncAction(async (bb, threats) => {
    const spot = await keeper.takeSafeSpot(
      'withdrawing from a fight we are losing -- to a wall, not into the open',
      threats[0] ?? null
    ).catch(() => ({ took: false }));

    if (!spot.took) return FAILURE;

    keeper.tally.withdrawals_to_a_wall = (keeper.tally.withdrawals_to_a_wall || 0) + 1;
    keeper.note('withdrew to a defensible square', {
      to: { col: keeper.hold?.col, row: keeper.hold?.row },
      threats: threats.length,
      why: 'a spot that holds ends the fight on our terms and makes the logoff-and-turn ' +
           'heal available, which open ground does not',
    });
    bb._result = { took: true };
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: walk_away (no wall; walk to a far square)
// ---------------------------------------------------------------------------

export function walkAwayNode(keeper) {
  return asyncAction(async (bb, threats) => {
    const s = keeper.s, c = s.client;
    const me = c.self, geo = s.world?.geometry;
    if (!me || !geo) return FAILURE;

    keeper.note('no wall to withdraw to', {
      threats: threats.length,
      consequence: 'falling back to walking away, which buys seconds rather than safety',
    });

    // Leave the hold -- we have nowhere better
    await keeper.leaveHold('withdrawing from a fight we are losing', { force: true });

    const away = (r, col) => Math.min(...threats.map(t => Math.hypot(col - t.col, r - t.row)));

    let best = null;
    for (let r = 1; r <= geo.rows; r++) {
      for (let col = 1; col <= geo.cols; col++) {
        if (!geo.walkable(r, col)) continue;
        const d = away(r, col);
        if (d < 6) continue;
        const p = geo.path(me.row, me.col, r, col);
        if (!p.found) continue;
        if (!best || p.steps.length < best.steps) best = { row: r, col, steps: p.steps.length, dist: d };
      }
    }

    if (!best) {
      keeper.note('nowhere to withdraw to', { why: 'no reachable square far enough away' });
      return FAILURE;
    }

    const walk = await s.walkTo(best.col, best.row, { maxSteps: Math.max(30, best.steps + 10) });
    keeper.note('withdrew', { to: { col: best.col, row: best.row }, steps: walk.steps, arrived: walk.arrived });
    bb._result = { walked: true, arrived: walk.arrived };
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// The retreat tree
// ---------------------------------------------------------------------------

/**
 * Build the retreat-to-safety behavior tree.
 *
 * @param {object} opts
 * @param {object} opts.session - the keeper instance
 * @returns {{ tick: Function, tickAsync: Function }} the retreat tree root
 */
export function getRetreatTree(opts = {}) {
  const keeper = opts.session?.keeper;
  if (!keeper) throw new Error('getRetreatTree: no keeper supplied');

  const children = [
    alreadySafeNode(keeper),
    quietRetreatNode(keeper),
    sanctuaryNode(keeper),
    travelRefugeNode(keeper),
    localWallNode(keeper),
  ];

  return {
    tick: (bb) => {
      for (const child of children) {
        const r = child.tick(bb);
        if (r === SUCCESS || r === RUNNING) return r;
      }
      return FAILURE;
    },
    tickAsync: async (bb) => {
      for (const child of children) {
        if (typeof child.tickAsync === 'function') {
          const r = await child.tickAsync(bb);
          if (r === SUCCESS || r === RUNNING) return r;
        } else {
          const r = child.tick(bb);
          if (r === SUCCESS || r === RUNNING) return r;
        }
      }
      return FAILURE;
    },
  };
}

// ---------------------------------------------------------------------------
// The withdraw tree
// ---------------------------------------------------------------------------

/**
 * Build the withdraw behavior tree.
 *
 * @param {object} opts
 * @param {object} opts.session - the keeper instance
 * @returns {{ tick: Function, tickAsync: Function }} the withdraw tree root
 */
export function getWithdrawTree(opts = {}) {
  const keeper = opts.session?.keeper;
  if (!keeper) throw new Error('getWithdrawTree: no keeper supplied');

  const children = [
    alreadySafeNode(keeper),
    takeWallNode(keeper),
    walkAwayNode(keeper),
  ];

  return {
    tick: (bb) => {
      for (const child of children) {
        const r = child.tick(bb);
        if (r === SUCCESS || r === RUNNING) return r;
      }
      return FAILURE;
    },
    tickAsync: async (bb) => {
      for (const child of children) {
        if (typeof child.tickAsync === 'function') {
          const r = await child.tickAsync(bb);
          if (r === SUCCESS || r === RUNNING) return r;
        } else {
          const r = child.tick(bb);
          if (r === SUCCESS || r === RUNNING) return r;
        }
      }
      return FAILURE;
    },
  };
}
