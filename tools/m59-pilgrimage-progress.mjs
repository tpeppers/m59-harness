// Observes tour progress without taking movement ownership or changing recovery.
// Novel positions/rooms count as progress; circling through old ones does not.
import { pilgrimageHealth } from './m59-pilgrimage-cycle.mjs';

export class PilgrimageProgress {
  constructor({ stallMs = 180_000, legStallMs = 600_000, staleMs = 30_000 } = {}) {
    for (const n of [stallMs, legStallMs, staleMs])
      if (!Number.isFinite(n) || n <= 0) throw new Error('progress thresholds must be positive');
    this.options = { stallMs, legStallMs, staleMs };
    this.agents = new Map();
    this.events = [];
  }

  expect(agent, now) {
    if (!this.agents.has(agent)) this.agents.set(agent, {
      agent, began: now, observed: null, legBegan: now, lastNovel: now,
      lastRoom: now, lastGain: now, checkpoints: 0, rooms: new Set(), cells: new Set(),
      ever: false, episodes: 0, flagged: false, hp: null,
    });
    return this.agents.get(agent);
  }

  observe(row, { now = Date.now(), checkpoints = 0, target = null, done = false } = {}) {
    const a = this.expect(row.agent, now);
    // A missing/failed observation is not zero HP or a fresh stationary reading.
    if (row.error || row._error) return;
    const room = row.room_num ?? row.room?.num;
    const hp = row.hp?.value ?? pilgrimageHealth(row).hp;
    const known = Number.isInteger(room) && room > 0;
    if (!known && row.in_game !== false) return;
    a.character = row.character ?? a.character;
    a.observed = now;
    a.online = row.in_game !== false;
    a.activity = row.activity ?? null;
    a.target = target;
    a.done = done;
    if (checkpoints > a.checkpoints) {
      a.checkpoints = checkpoints;
      a.legBegan = a.lastNovel = a.lastRoom = a.lastGain = now;
      a.rooms.clear(); a.cells.clear();
    }
    if (known) {
      if (!a.rooms.has(room)) { a.rooms.add(room); a.lastNovel = a.lastRoom = now; }
      a.room = room;
      a.room_name = typeof row.room === 'string' ? row.room : row.room?.name ?? null;
      const position = row.position ?? row;
      if (Number.isFinite(position.row) && Number.isFinite(position.col)) {
        const key = `${room}:${Math.floor(position.row)}:${Math.floor(position.col)}`;
        if (!a.cells.has(key)) { a.cells.add(key); a.lastNovel = now; }
      }
    }
    if (Number.isFinite(hp)) {
      if (a.hp != null && hp > a.hp) a.lastGain = now;
      a.hp = hp;
    }
    // Observe every sample, so an episode that resolves between printed reports is kept.
    this.classify(a, now);
  }

  classify(a, now) {
    let reason = null;
    const unknown = !a.done && (a.observed == null || now - a.observed > this.options.staleMs);
    if (!unknown && !a.done) {
      if (now - a.lastNovel >= this.options.stallMs && now - a.lastGain >= this.options.stallMs)
        reason = a.online ? 'no_progress' : 'offline_without_progress';
      else if (now - a.legBegan >= this.options.legStallMs && now - a.lastRoom >= this.options.stallMs)
        reason = 'checkpoint_overdue';
    }
    // Losing telemetry must not count as resolving a previously observed stall.
    if (!unknown && !!reason !== a.flagged) {
      a.flagged = !!reason;
      if (reason) { a.ever = true; a.episodes++; a.flaggedAt = now; }
      this.events.push({ at: now, agent: a.agent, character: a.character,
        kind: reason ? 'stuck' : 'progress_resumed', reason,
        room: a.room, target: a.target, checkpoints: a.checkpoints });
    }
    return { agent: a.agent, character: a.character, room: a.room,
      room_name: a.room_name, target: a.target, activity: a.activity, hp: a.hp,
      status: unknown ? 'unknown' : a.done ? 'finished' : reason ? 'stuck' : 'progressing',
      reason, checkpoints: a.checkpoints, episodes: a.episodes, ever_stuck: a.ever,
      last_observed_at: a.observed, last_progress_at: a.lastNovel,
      seconds_without_progress: Math.max(0, now - a.lastNovel) / 1000,
      seconds_without_new_room: Math.max(0, now - a.lastRoom) / 1000,
      seconds_since_checkpoint: Math.max(0, now - a.legBegan) / 1000,
      seconds_since_hp_gain: Math.max(0, now - a.lastGain) / 1000 };
  }

  snapshot(now = Date.now()) {
    const actors = [...this.agents.values()].map(a => this.classify(a, now));
    return { schema: 'm59-pilgrimage-progress/v1', at: now, thresholds: this.options,
      stuck_count: actors.filter(a => a.status === 'stuck').length,
      ever_stuck_count: actors.filter(a => a.ever_stuck).length,
      unknown_count: actors.filter(a => a.status === 'unknown').length,
      stuck_episodes: actors.reduce((n,a) => n + a.episodes, 0), actors,
      events: [...this.events],
      meaning: 'Flags for investigation, not proof of a route defect. Healing can defer a stationary flag; repeated recovery cannot hide an overdue checkpoint. Missing telemetry stays unknown.' };
  }
}

// The same detector can audit a running legacy tour from its observer journal.
// Join receipts only up to each observation's timestamp, never future arrivals.
export function progressFromObservations({ observations, arrivals = [], start, end,
  agents = [], options = {} }) {
  const tracker = new PilgrimageProgress(options);
  for (const agent of agents) tracker.expect(agent, start);
  const receipts = arrivals.filter(e => e.t >= start && e.t <= end).sort((a,b) => a.t-b.t);
  const counts = new Map(); let next = 0;
  for (const o of observations.filter(o => o.at >= start && o.at <= end).sort((a,b) => a.at-b.at)) {
    while (next < receipts.length && receipts[next].t <= o.at) {
      const e = receipts[next++]; counts.set(e.character, (counts.get(e.character) ?? 0) + 1);
    }
    for (const row of o.rows) tracker.observe(row, { now: o.at,
      checkpoints: counts.get(row.character) ?? 0, target: row.suspended?.to ?? null });
  }
  return tracker.snapshot(end);
}
