// AN ERRAND'S KEEPER POSTURE: SAVED ONCE, POINTED AT EACH LEG, PUT BACK HOWEVER THE RUN ENDS.
//
// Lifted from fleetscripts/disciple-robes.mjs, where every part of it was learned on prod on
// 2026-10-16 (that file keeps its own copy and the incident notes). The short version:
//
//   * A keeper assigned and CONFINED somewhere else fights the errand's first walk, and any
//     survival rung that hands the body back mid-errand steers it home to its station.
//   * A desk character's flee/rest points (90%/95%) walk it out of the room at the first bite.
//   * A keeper's own errands (town trips) cancel the script's.
//   * The keeper's fight-back edict makes a body standing still beside a monster attack it.
//
// So: read the policy once and WRITE IT TO DISK the moment it is read (a killed run never
// reaches its restore step, and the next run must not mistake the errand's posture for the
// original); point the keeper at the room this leg is about (survive mode, no confinement, no
// town trips, no roaming, flee/rest points the errand can live with, fight-back off); and put the
// original back in an `always` step, deleting the file once that succeeds. A refusal is reported,
// never fatal: an errand with the wrong posture is worse than one with the right posture, and
// better than none.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { verify } from './m59-fleetscript.mjs';

const POSTURE_KEYS = Object.freeze({ assignedRoom: 'assigned_room', confineRooms: 'confine_rooms', mode: 'mode',
  fleeBelow: 'flee_below', restBelow: 'rest_below', townTrips: 'town_trips', hunt: 'hunt', roam: 'roam' });

const fileOf = (tag, agent) => join(process.cwd(), 'substrate', `${tag}-posture-${String(agent).replace(/[^a-z0-9]+/gi, '_')}.json`);
const load = (tag, agent) => { try { return JSON.parse(readFileSync(fileOf(tag, agent), 'utf8')); } catch { return null; } };

/**
 * Point the keeper at `roomOf(state)` for `label`. `tag` names the errand (the file prefix), so two
 * different errands never restore each other's saved posture. Skipped when the room resolves to
 * nothing, or is the room the posture already points at.
 */
export function postureStep(tag, roomOf, { fleeBelow = 0.3, restBelow = 0.4, fightBack = false } = {}, label = 'the errand') {
  return { ...verify(async ({ agent, call, state }) => {
    const room = Number(typeof roomOf === 'function' ? roomOf(state) : roomOf);
    if (!Number.isFinite(room) || room <= 0) return { ok: true, skipped: true };
    if (state.postureRoom === room) return { ok: true, skipped: `already pointed at ${room}` };
    if (!state.postureBefore) state.postureBefore = load(tag, agent);
    if (!state.postureBefore) {
      const st = await call('autopilot', { agent, action: 'status' }, 40_000).catch(() => null);
      const pol = st?.policy;
      if (!pol) return { ok: true, warning: `policy unreadable, so the posture was left alone for ${label}` };
      const before = {};
      for (const [k, arg] of Object.entries(POSTURE_KEYS)) if (pol[k] !== undefined) before[arg] = pol[k];
      if (before.confine_rooms == null) before.confine_rooms = [];
      // The policy holds milliseconds; the setter takes seconds (0 = off).
      before.fight_back_after_s = pol.fightBackAfterMs ? pol.fightBackAfterMs / 1000 : 0;
      state.postureBefore = before;
      try { writeFileSync(fileOf(tag, agent), JSON.stringify(before, null, 1)); } catch {}
    }
    const want = { mode: 'survive', assigned_room: room, confine_rooms: [], town_trips: false, roam: false,
      ...(fightBack ? {} : { fight_back_after_s: 0 }), flee_below: Number(fleeBelow), rest_below: Number(restBelow) };
    const r = await call('autopilot', { agent, action: 'start', ...want, why: `${tag}: ${label}` }, 40_000)
      .catch(e => ({ error: e.message }));
    if (r?.error) return { ok: true, warning: `posture not set for ${label}: ${r.error}` };
    state.postureSet = true; state.postureRoom = room;
    return { ok: true, home: room, for: label };
  }, `point the keeper at ${label}`), optional: true };
}

/** Put the saved posture back. `always`, so it runs however the run ended. */
export function restorePostureStep(tag) {
  return { ...verify(async ({ agent, call, state }) => {
    if (!state.postureBefore) state.postureBefore = load(tag, agent);
    if (!state.postureBefore || (!state.postureSet && !load(tag, agent))) return { ok: true, skipped: true };
    const r = await call('autopilot', { agent, action: 'start', ...state.postureBefore,
      why: `${tag}: run over, posture restored` }, 40_000).catch(e => ({ error: e.message }));
    if (r?.error) return { ok: true, warning: `could not restore ${JSON.stringify(state.postureBefore)}: ${r.error} -- set it by hand` };
    state.postureSet = false; state.postureRoom = null;
    try { unlinkSync(fileOf(tag, agent)); } catch {}
    return { ok: true, restored: state.postureBefore };
  }, "could not put the keeper's posture back"), always: true };
}
