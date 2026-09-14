import { normalizeCombatOrder } from './m59-combat-mode.mjs';

export const attackPlayer = (target, options = {}) => ({ ...options, action: 'attack', target });
export const killPlayer = (target, options = {}) => ({ ...options, action: 'kill', target });
export const ambushPlayer = (target, map, position, options = {}) =>
  ({ ...options, action: 'ambush', target, map, position });

export function oneCombatOrder(steps) {
  if (!Array.isArray(steps) || steps.length !== 1)
    throw new Error('combat mode needs one order per agent; put attack/cast/wait actions in its sequence');
  return steps[0];
}

// Deliberately small grammar; quote multiword player names. Unknown options
// refuse before any order is sent, rather than quietly changing the ambush.
export function parseCombatCommand(line) {
  const words = String(line).match(/(?:[^\s"']+|"[^"\r\n]*"|'[^'\r\n]*')+/g) ?? [];
  const unquote = v => /^["']/.test(v) ? v.slice(1, -1) : v;
  if (words.shift()?.toLowerCase() !== 'combat') throw new Error('expected combat command');
  const action = words.shift()?.toLowerCase();
  if (!['kill', 'attack', 'ambush', 'stop', 'status'].includes(action))
    throw new Error('combat attack|ambush <player> agents=t1,t2 [map=38 at=r2c19 door=r8c28 ttl=600000] | combat stop|status agents=t1,t2');
  const target = ['kill', 'attack', 'ambush'].includes(action) ? unquote(words.shift() ?? '') : undefined;
  const options = {};
  for (const word of words) {
    const m = /^(agents|room|map|at|door|radius|ttl|order_id)=(.+)$/.exec(word);
    if (!m || Object.hasOwn(options, m[1])) throw new Error(`invalid or duplicate combat option: ${word}`);
    options[m[1]] = unquote(m[2]);
  }
  const agents = options.agents?.split(',').filter(Boolean);
  if (!agents?.length && !options.room) throw new Error('combat needs agents=t1,t2 or room="Room Name"');
  const allowed = new Set(action === 'ambush' ? ['agents', 'map', 'at', 'door', 'radius', 'ttl']
    : ['kill', 'attack'].includes(action) ? ['agents', 'ttl'] : action === 'stop' ? ['agents', 'order_id'] : ['agents']);
  allowed.add('room');
  if (Object.keys(options).some(key => !allowed.has(key)) || (options.radius && !options.door))
    throw new Error('invalid combat option for this action');
  const point = value => {
    const match = /^r(\d+),?c(\d+)$/i.exec(value ?? '');
    if (!match) throw new Error('combat coordinates use r30c61 (or r30,c61)');
    return { row: Number(match[1]), col: Number(match[2]) };
  };
  const selection = { ...(agents ? { agents } : {}), ...(options.room ? { room: options.room } : {}) };
  if (action === 'stop' || action === 'status') {
    if (options.room && options.order_id) throw new Error('use agents with order_id, or room without order_id');
    return { ...selection, order: { action, ...(options.order_id ? { order_id: options.order_id } : {}) } };
  }
  const order = { action, target, ...(options.ttl ? { ttl_ms: Number(options.ttl) } : {}) };
  if (action === 'ambush') {
    order.map = Number(options.map); order.position = point(options.at);
    if (options.door) order.door = { ...point(options.door), radius: Number(options.radius ?? 1) };
  }
  return { ...selection, order: normalizeCombatOrder(order) };
}

export async function dispatchCombatOrders({ agents, order, send, beforeDispatch = null }) {
  if (!Array.isArray(agents) || !agents.length || agents.some(a => typeof a !== 'string' || !a.trim()))
    throw new Error('combat needs explicit agent names');
  // All declarations compile before any body is touched. Acceptance is per
  // character; a disconnected fleetmate cannot delay the others.
  const compiled = await Promise.all([...new Set(agents)].map(async agent => {
    const requested = typeof order === 'function' ? await order(agent) : order;
    const normalized = ['stop', 'status'].includes(requested?.action)
      ? requested : normalizeCombatOrder(requested);
    return { agent, order: normalized };
  }));
  beforeDispatch?.(compiled.map(c => c.agent));
  const results = await Promise.all(compiled.map(async ({ agent, order }) => {
    try {
      const result = await send(agent, order);
      if (!result || typeof result !== 'object' || Array.isArray(result))
        return { agent, ok: false, error: String(result ?? 'no combat receipt') };
      if (result?.error || result?.isError) return { agent, ok: false, error: result.error ?? result };
      return { agent, ok: true, ...result };
    } catch (e) { return { agent, ok: false, error: e.message }; }
  }));
  return { ok: results.every(r => r.ok), results };
}
