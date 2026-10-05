// Bounded process-local evidence, independent of trace files and environment setup.
const windows = new Map(), WINDOW = 32, MAX_AGENTS = 64;
const finite = v => Number.isFinite(v) ? v : null;
const point = p => p && typeof p === 'object'
  ? Object.fromEntries(['row','col','x','y'].filter(k => Number.isFinite(p[k])).map(k => [k,p[k]]))
  : null;
export function rememberMoveAttempt(d, at) {
  if (typeof d?.agent !== 'string' || !d.agent) return;
  const key = d.agent.slice(0,80);
  if (!windows.has(key) && windows.size >= MAX_AGENTS) windows.delete(windows.keys().next().value);
  const w = windows.get(key) ?? {total:0, attempts:[]};
  w.attempts.push({at, seq:++w.total, kind:String(d.kind ?? 'unknown').slice(0,40),
    room:finite(typeof d.room === 'number' ? d.room : d.room?.num),
    from:point(d.from ?? d.fine), square:point(d.square), requested:point(d.requested ?? d.aimed ?? d.target),
    to:point(d.to), sent:typeof d.sent === 'boolean' ? d.sent : null,
    reason:String(d.reason ?? d.validation?.reason ?? '').slice(0,160) || null,
    object_id:finite(d.objectId ?? d.validation?.objectId),
    movement_generation:finite(d.movement_generation),
    blocked:typeof d.validation?.blocked === 'boolean' ? d.validation.blocked : null,
    slid:typeof d.validation?.slid === 'boolean' ? d.validation.slid : null});
  if (w.attempts.length > WINDOW) w.attempts.shift();
  windows.set(key,w);
}
export function recentMoveAttempts(agent) {
  const w = windows.get(typeof agent === 'string' ? agent.slice(0,80) : agent);
  return {scope:'process-local bounded local attempts; sent does not confirm arrival',
    units:'named square row/col; fine x/y in KOD/protocol units (64 per square)',
    evicted:w ? w.total-w.attempts.length : 0, attempts:structuredClone(w?.attempts ?? [])};
}
