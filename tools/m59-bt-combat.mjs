#!/usr/bin/env node
// m59-bt-combat.mjs -- BT atomic and composed nodes for combat.
//
// Exports (atomics — GOAP-compatible pre/effects):
//   SelectTargetAction(opts)      pick nearest hostile, set has_target + target_id in ws
//   FightUntilDeadAction(opts)    loop: swing until target gone from room
//   FleeRoomAction(opts)          leave the current room via any safe exit
//   TakeSafeSpotAction(opts)      move to a free-shots square in this room
//
// Exports (composed):
//   EngageNearestAction(opts)     Sequence: select → safe-spot → fight-until-dead
//   CombatTree(opts)              Selector: fight if able, flee otherwise
//
// World-state keys:
//   has_target          bool   — a hostile is selected (targetId stored in ws._targetId)
//   target_dead         bool   — selected target gone from room
//   in_combat           bool   — currently in a fight
//   safe_spot_taken     bool   — standing on a free-shots square
//   fled_room           bool   — successfully left the room

import { Action, Sequence, Selector, Condition, SUCCESS, FAILURE, RUNNING } from './m59-bt.mjs';

// ---------------------------------------------------------------------------
// Shared constants / helpers
// ---------------------------------------------------------------------------

export const OF_ATTACKABLE = 0x0008;
export const OF_PLAYER     = 0x0004;
export const MELEE_REACH   = 3;        // disc radius, same as autopilot REACH

function _ws(bb)      { if (!bb.ws) bb.ws = {}; return bb.ws; }
function _client(bb)  { return bb.client ?? bb.session?.s?.client ?? null; }
function _session(bb) { return bb.session?.s ?? null; }

// All non-player attackable objects in room, within optional radius.
function _hostiles(c, radius = Infinity) {
  if (!c?.room?.objects) return [];
  const me = c.self;
  return [...c.room.objects.values()].filter(o => {
    if (o.id === c.selfId) return false;
    if (!(o.flags & OF_ATTACKABLE)) return false;
    if (o.flags & OF_PLAYER) return false;
    if (radius < Infinity && me) {
      const d = Math.hypot((o.col ?? 0) - (me.col ?? 0), (o.row ?? 0) - (me.row ?? 0));
      if (d > radius) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// SelectTargetAction(opts)
//
// Scans room.objects for the nearest non-player attackable object and stores
// its id in bb.ws._targetId. Synchronous — returns immediately.
//
// opts:
//   radius   number   max distance to consider (default: Infinity — whole room)
//   nameRe   RegExp   only target creatures matching this name
//   ceiling  number   ignore creatures whose level > ceiling (reads from bb.ws._threatCeiling)
//
// Pre:  []
// Effects: ['has_target']
// ---------------------------------------------------------------------------
export function SelectTargetAction(opts = {}) {
  const key    = 'at_select_target';
  const radius  = opts.radius  ?? Infinity;
  const nameRe  = opts.nameRe  ?? null;

  const node = new Action((bb) => {
    // If a target is already selected this engagement, don't re-pick.
    if (bb.ws?.has_target && bb.ws?._targetId != null) return SUCCESS;

    const c  = _client(bb);
    const me = c?.self;
    if (!c || !me) return FAILURE;

    const ceiling = bb.ws?._threatCeiling ?? opts.ceiling ?? Infinity;
    const candidates = _hostiles(c, radius)
      .filter(o => {
        if (nameRe && !nameRe.test(String(o.name ?? ''))) return false;
        // Honour threat ceiling: object carries level in o.level when present.
        if (o.level != null && ceiling < Infinity && o.level > ceiling) return false;
        return true;
      })
      .map(o => ({
        o,
        dist: Math.hypot((o.col ?? 0) - me.col, (o.row ?? 0) - me.row),
      }))
      .sort((a, b) => a.dist - b.dist);

    if (!candidates.length) return FAILURE;

    const ws = _ws(bb);
    ws._targetId    = candidates[0].o.id;
    ws.has_target   = true;
    ws.target_dead  = false;
    ws.in_combat    = true;
    return SUCCESS;
  }, { key, name: 'select_target' });

  node.pre     = [];
  node.effects = ['has_target', 'in_combat', '!target_dead'];
  return node;
}
SelectTargetAction._key = 'at_select_target';

// ---------------------------------------------------------------------------
// FightUntilDeadAction(opts)
//
// Swings at bb.ws._targetId repeatedly until the target is gone from
// room.objects or the swing budget is exhausted.
//
// One tick = one swing attempt. Returns RUNNING while the foe lives,
// SUCCESS when it leaves the room, FAILURE on budget exhaustion or no target.
//
// opts:
//   maxSwings  number   safety cap (default 60)
//   pacerDelay number   ms between swings (default 1050 — server swing timer)
//
// Pre:  ['armed', 'has_target']
// Effects: ['target_dead', '!has_target', '!in_combat']
// ---------------------------------------------------------------------------
export function FightUntilDeadAction(opts = {}) {
  const key       = 'at_fight_until_dead';
  const maxSwings = opts.maxSwings  ?? 60;
  const delay     = opts.pacerDelay ?? 1050;

  const node = new Action((bb, slot) => {
    const c = _client(bb);
    const s = _session(bb);
    if (!c || !s) return FAILURE;

    const targetId = bb.ws?._targetId ?? null;
    if (!targetId) return FAILURE;

    // Initialise slot.
    if (!slot || slot.done === undefined) {
      slot = { swings: 0, swingInFlight: false, done: false, ok: false };
      bb._bt[key] = slot;
    }

    if (slot.done) {
      const ok = slot.ok;
      delete bb._bt[key];
      if (ok) {
        const ws = _ws(bb);
        ws.target_dead = true;
        ws.has_target  = false;
        ws.in_combat   = false;
      }
      return ok ? SUCCESS : FAILURE;
    }

    // Check if target already gone.
    if (!c.room?.objects?.has?.(targetId)) {
      slot.ok = true; slot.done = true;
      return RUNNING;  // resolve on next tick via done path
    }

    if (slot.swings >= maxSwings) {
      slot.done = true;
      return RUNNING;
    }

    // Fire one swing if none in flight.
    if (!slot.swingInFlight) {
      slot.swingInFlight = true;
      slot.swings++;
      const since = c.evSeq ?? 0;

      s.pacer.submit('attack', () => c.attack(targetId), delay)
        .catch(() => {})
        .then(async () => {
          // Wait briefly for hit/room-contents events.
          await c.waitFor({ since, kinds: ['hit', 'room-contents', 'message'],
                            timeoutMs: delay + 200 }).catch(() => {});
        })
        .then(() => { slot.swingInFlight = false; })
        .catch(() => { slot.swingInFlight = false; });
    }

    return RUNNING;
  }, { key, name: 'fight_until_dead' });

  node.pre     = ['armed', 'has_target', 'safe_spot_taken'];
  node.effects = ['target_dead', '!has_target', '!in_combat'];
  return node;
}
FightUntilDeadAction._key = 'at_fight_until_dead';

// ---------------------------------------------------------------------------
// TakeSafeSpotAction(opts)
//
// Picks a free-shots square in the current room (one where the character can
// hit hostiles but they cannot return fire through walls) and walks there.
//
// Uses bb.ws._safeSpots when available — the keeper populates this from the
// m59-safespots.mjs scored list. Falls back to the character's current square
// (i.e. succeeds immediately, just marks the flag) when no scored spots exist.
//
// opts:
//   key       string
//
// Pre:  []
// Effects: ['safe_spot_taken']
// ---------------------------------------------------------------------------
export function TakeSafeSpotAction(opts = {}) {
  const key = opts.key ?? 'at_take_safe_spot';

  const node = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false };
      bb._bt[key] = slot;

      const s = _session(bb);
      const c = _client(bb);
      if (!s || !c) { slot.done = true; return RUNNING; }

      Promise.resolve()
        .then(async () => {
          const spots = bb.ws?._safeSpots;
          if (!spots?.length) {
            // No scored spots — stay put, mark taken.
            return true;
          }
          // Walk to the best spot (highest free_shots, then lowest steps_away).
          const best = spots
            .filter(sp => sp.col != null && sp.row != null)
            .sort((a, b) =>
              (b.free_shots ?? 0) - (a.free_shots ?? 0) ||
              (a.steps_away ?? 0) - (b.steps_away ?? 0)
            )[0];
          if (!best) return true;

          const me = c.self;
          if (me?.col === best.col && me?.row === best.row) return true;

          // Use s.walkTo when available (broker method), else succeed in place.
          if (typeof s.walkTo === 'function') {
            const r = await s.walkTo(best.col, best.row, { maxSteps: 20 }).catch(() => null);
            return !!(r?.arrived);
          }
          return true;
        })
        .then(ok => {
          if (ok) _ws(bb).safe_spot_taken = true;
          slot.ok = ok; slot.done = true;
        })
        .catch(() => { slot.done = true; });

      return RUNNING;
    }

    if (!slot.done) return RUNNING;
    const ok = slot.ok;
    delete bb._bt[key];
    return ok ? SUCCESS : FAILURE;
  }, { key, name: 'take_safe_spot' });

  node.pre     = [];
  node.effects = ['safe_spot_taken'];
  return node;
}
TakeSafeSpotAction._key = 'at_take_safe_spot';

// ---------------------------------------------------------------------------
// FleeRoomAction(opts)
//
// Leaves the current room via the nearest exit that isn't blocked by hostiles.
// Prefers exits that lead away from the highest concentration of foes.
//
// opts:
//   key       string
//
// Pre:  []
// Effects: ['fled_room', '!in_combat', '!has_target']
// ---------------------------------------------------------------------------
export function FleeRoomAction(opts = {}) {
  const key = opts.key ?? 'at_flee_room';

  const node = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false };
      bb._bt[key] = slot;

      const s = _session(bb);
      const c = _client(bb);
      if (!s || !c) { slot.done = true; return RUNNING; }

      Promise.resolve()
        .then(async () => {
          const exits  = s.world?.exits?.() ?? [];
          const me     = c.self;
          const foes   = _hostiles(c);

          // Score exits: prefer ones that move AWAY from the centre of foe mass.
          const foeCentre = foes.length
            ? {
                col: foes.reduce((t, o) => t + (o.col ?? 0), 0) / foes.length,
                row: foes.reduce((t, o) => t + (o.row ?? 0), 0) / foes.length,
              }
            : null;

          const scored = exits
            .filter(e => e.stand_on != null)
            .map(e => {
              const sp = e.stand_on;
              // Higher score = better escape direction.
              const distFromFoes = foeCentre
                ? Math.hypot(sp.col - foeCentre.col, sp.row - foeCentre.row)
                : 0;
              return { exit: e, score: distFromFoes - (e.steps_away ?? 0) };
            })
            .sort((a, b) => b.score - a.score);

          for (const { exit } of scored) {
            const r = await s.leaveVia(exit).catch(() => null);
            if (r?.left) return true;
            // The live room identity changed but has not been confirmed as a crossing yet.
            // End this flee pass so it is rebuilt from the published room; every remaining
            // `exit` in this array belongs to the old room.
            if (r?.room_changed) return false;
          }
          // No exit succeeded — try any exit without stand_on as last resort.
          for (const exit of exits.filter(e => !e.stand_on)) {
            const r = await s.leaveVia(exit).catch(() => null);
            if (r?.left) return true;
            if (r?.room_changed) return false;
          }
          return false;
        })
        .then(ok => {
          if (ok) {
            const ws = _ws(bb);
            ws.fled_room   = true;
            ws.in_combat   = false;
            ws.has_target  = false;
          }
          slot.ok = ok; slot.done = true;
        })
        .catch(() => { slot.done = true; });

      return RUNNING;
    }

    if (!slot.done) return RUNNING;
    const ok = slot.ok;
    delete bb._bt[key];
    return ok ? SUCCESS : FAILURE;
  }, { key, name: 'flee_room' });

  node.pre     = [];
  node.effects = ['fled_room', '!in_combat', '!has_target'];
  return node;
}
FleeRoomAction._key = 'at_flee_room';

// ---------------------------------------------------------------------------
// EngageNearestAction(opts)
//
// Composed Sequence: select nearest target → take safe spot → fight until dead.
// The planner sees this as one unit via the chained pre/effects on each node.
//
// Returns a Sequence node.
// ---------------------------------------------------------------------------
export function EngageNearestAction(opts = {}) {
  const select = SelectTargetAction(opts);
  const spot   = TakeSafeSpotAction(opts);
  const fight  = FightUntilDeadAction(opts);

  // Chain effects so the planner enforces the ordering.
  // safe_spot_taken is a required pre on fight: the planner will not skip the spot step.
  spot.pre  = ['has_target'];
  fight.pre = ['armed', 'has_target', 'safe_spot_taken'];

  return new Sequence([select, spot, fight], { name: 'engage_nearest' });
}

// ---------------------------------------------------------------------------
// CombatTree(opts)
//
// Selector: try to fight if able, flee if not.
//
//   Branch 1: Condition(armed) → EngageNearestAction
//   Branch 2: FleeRoomAction
//
// Returns a Selector node. Wire this into a character's pass() BT where the
// monolith currently calls passThreatAndRest.
// ---------------------------------------------------------------------------
export function CombatTree(opts = {}) {
  const canFight = new Condition(
    bb => {
      const c = _client(bb);
      if (!c) return false;
      // armed: any weapon in plUsing, or bb.ws.armed if already computed.
      if (bb.ws?.armed != null) return bb.ws.armed;
      const eq = new Set([...(c.equipment?.keys?.() ?? [])]);
      return [...(c.inventory ?? [])].some(o =>
        eq.has(o.id) && /mace|sword|axe|hammer|scimitar/i.test(String(o.name ?? ''))
      );
    },
    { name: 'can_fight' },
  );

  const hostilePresent = new Condition(
    bb => _hostiles(_client(bb)).length > 0,
    { name: 'hostile_present' },
  );

  const engage = EngageNearestAction(opts);
  const flee   = FleeRoomAction(opts);

  // Inner Selector for the armed branch: engage or flee if engagement fails.
  const armedBranch = new Sequence(
    [canFight, new Selector([engage, flee], { name: 'engage_or_flee' })],
    { name: 'armed_branch' },
  );

  return new Selector(
    [
      // If no hostiles, skip the whole tree immediately.
      new Sequence(
        [hostilePresent, armedBranch],
        { name: 'combat_if_hostile' },
      ),
      // Fall-through: flee anyway if unarmed but hostiles present.
      flee,
    ],
    { name: 'combat_tree' },
  );
}
