// No rich snapshots on the command path. Map membership is checked atomically
// by each socket owner when it accepts the addressed order.
import { randomUUID } from 'node:crypto';
import { normalizeCombatOrder } from './m59-combat-mode.mjs';

const roomKey = text => String(text).toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
  .split(/ +/).filter(word => word && word !== 'in' && word !== 'the').join(' ');
export function resolveCombatMap(rooms, input) {
  if (Number.isSafeInteger(Number(input)) && Number(input) > 1 && rooms[String(Number(input))])
    return Number(input);
  const matches = Object.entries(rooms).filter(([, room]) => roomKey(room.name) === roomKey(input));
  if (matches.length !== 1) throw Error('combat: assigned room must resolve to exactly one known map');
  return Number(matches[0][0]);
}

export class CombatDispatch {
  constructor({ candidates, send, rooms, now = Date.now, receiptMs = 200 }) {
    Object.assign(this, { candidates, send, rooms, now, receiptMs });
    this.revision = 0; this.commands = new Map();
  }

  async run(input) {
    const { fleet_state, agents, room, rooms, command_id, action = 'kill', ...fields } = input;
    if (agents != null && (!Array.isArray(agents) || !agents.length ||
        agents.some(a => typeof a !== 'string' || !a.trim()))) throw Error('combat: invalid agents');
    const prior = command_id ? this.commands.get(command_id) : null;
    // A durable keeper watch can outlive the broker's in-memory receipt index.
    // Scoped reads/stops remain meaningful: ask recipients to match that ID.
    if (command_id && !prior && !['status', 'stop'].includes(action)) throw Error('combat: unknown command_id');
    const control = ['ready', 'status', 'stop'].includes(action);
    if (control && Object.keys(fields).length) throw Error('combat: unexpected control option');
    if (!control && command_id) throw Error('combat: command_id is for status or stop');
    if (!control && !agents?.length && room == null && rooms == null) throw Error('combat: specify agents or assigned room');
    if (rooms != null && (room != null || !Array.isArray(rooms) || !rooms.length || rooms.length > 32 ||
        control || fields.when_absent !== 'farm')) throw Error('combat: rooms needs a farm watch and cannot be combined with room');
    const map = room == null ? null : resolveCombatMap(this.rooms(), room);
    const watchMaps = rooms?.map(value => resolveCombatMap(this.rooms(), value)) ??
      (fields.when_absent === 'farm' && map != null ? [map] : null);
    const order = control ? { action } : normalizeCombatOrder({ action, ...fields,
      ...(watchMaps ? { watch_maps: [...new Set(watchMaps)] } : {}) });
    const roster = this.candidates();
    const selected = agents ?? prior?.agents ?? roster.map(r => r.agent);
    const candidates = [...new Set(selected)].map(agent => roster.find(r => r.agent === agent) ??
      { agent, unavailable: 'agent is not held by this broker' });
    const revision = this.revision = Math.max(this.now(), this.revision + 1);
    const id = control ? command_id ?? null : randomUUID();
    const record = { id, action, target: order.target ?? prior?.target, map: map ?? prior?.map, agents: candidates.map(r => r.agent),
      maps: watchMaps ?? prior?.maps,
      submitted_at: this.now(), results: [], done: null };
    if (!control) {
      this.commands.set(id, record);
      // Receipts only; keeper orders survive eviction. Unscoped stop always works.
      if (this.commands.size > 256) this.commands.delete(this.commands.keys().next().value);
    }
    const command = { ...order, revision, ...(map == null || order.when_absent === 'farm' ? {} : { select_map: map }),
      ...(!control ? { command_id: id } : ['stop', 'status'].includes(action) && command_id ? { order_id: command_id } : {}) };
    record.results = candidates.map(r => ({ agent: r.agent, pending: true }));
    // Start every request before awaiting any one keeper. A wedged keeper may
    // delay its own receipt; it cannot hold up healthy units or the chat reply.
    record.done = Promise.all(candidates.map(async (candidate, index) => {
      let result;
      try {
        if (candidate.unavailable) result = { skipped: true, reason: candidate.unavailable };
        else {
          result = await this.send(candidate.agent, command);
          if (!result || typeof result !== 'object') result = { error: 'invalid keeper receipt' };
        }
      } catch (e) { result = { error: e.message }; }
      record.results[index] = { ...result, agent: candidate.agent, pending: false,
        received_after_ms: this.now() - record.submitted_at };
    }));
    let timer;
    try {
      await Promise.race([record.done, new Promise(resolve => {
        timer = setTimeout(resolve, ['ready', 'status'].includes(action) ? 6000 : this.receiptMs);
      })]);
    } finally { clearTimeout(timer); }
    return this.receipt(record);
  }

  receipt(record) {
    const results = record.results.map(r => ({ ...r }));
    const pending = results.some(r => r.pending);
    return { command_id: record.id, action: record.action, target: record.target, map: record.map, maps: record.maps,
      dispatch_ms: this.now() - record.submitted_at, pending,
      // Dispatch acknowledgement is never represented as a completed attack.
      ok: results.length > 0 && !results.some(r => r.error ||
        (record.action === 'ready' && !r.skipped && !r.pending && (!r.ready || !r.in_game))), results };
  }
}
