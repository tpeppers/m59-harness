// Shared, observational telemetry for FleetScripts and direct broker callers.
// Recording never sends a game packet and must never change a tool's result.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { classifyCast } from './m59-castoutcomes.mjs';

export const ACTIVITY_FORMAT = 'm59-activity/1';
const short = (s, max = 180) => typeof s === 'string' ? s.slice(0, max) : null;
const number = n => n != null && Number.isFinite(Number(n)) ? Number(n) : null;
const positive = n => number(n) != null && Number(n) >= 0 ? Number(n) : null;
const cleanName = n => short(n)?.replaceAll('_', ' ').trim().toLowerCase() ?? null;
const validAgent = n => typeof n === 'string' && /^[a-z0-9_-]{1,80}$/i.test(n);
const safeKinds = new Set(['run_start', 'run_plan', 'run_heartbeat', 'run_end', 'step_start', 'step_end']);

export function telemetryContext(value) {
  if (!value || typeof value !== 'object' || !short(value.run) || !short(value.script)) return null;
  return { run: short(value.run, 120), script: short(value.script),
    source: short(value.source), code: short(value.code, 80), parent_run: short(value.parent_run, 120) };
}

export function scriptDomains({ name = '', description = '', steps = [], domains = [] } = {}) {
  const text = [name, description, ...steps.map(s => `${s?.do ?? ''} ${s?.why ?? ''} ${s?.label ?? ''}`)].join(' ');
  const found = new Set(domains.filter(d => ['courier', 'practice'].includes(d)));
  if (/courier|deliver|resuppl|restock|supply|shopping|arrow.*buy|buy.*arrow/i.test(text)) found.add('courier');
  if (/practice|drill|train.*spell|spell.*train/i.test(text)) found.add('practice');
  return [...found];
}

export function castTelemetry(reply, error = null, info = null) {
  const messages = [reply?.reason, reply?.error, ...(reply?.messages ?? []), ...(reply?.keeper_said?.said ?? []), ...(reply?.said ?? [])].filter(s => typeof s === 'string');
  const failure = classifyCast(messages);
  const raw = failure?.outcome;
  let outcome = raw === 'failed_roll' ? 'fizzle' : raw === 'interrupted' ? 'broken' : raw ? 'refused' : 'unknown';
  const spent = number(reply?.mana_spent ?? reply?.mana_cost);
  // A queued/accepted cast and a timed-out request are not confirmed success.
  const instantPaid = info?.cast_time_ms === 0 && Number(info?.mana) > 0 && spent >= Number(info.mana);
  if (!failure && !error && !reply?.error && reply?.cast !== false && reply?.queued !== true && reply?.keeper_said?.queued !== true &&
      (instantPaid || reply?.created?.some(i => i.amount > 0) || /give part of your magical energy/i.test(messages.join(' ')))) outcome = 'success';
  if (error || reply?.error || reply?.cast === false) outcome = 'refused';
  return { outcome, mana_spent: spent, cast_time_ms: number(info?.cast_time_ms), reason: short(error?.message ?? reply?.reason ?? reply?.error ?? failure?.why), evidence: failure ? 'server failure' : outcome === 'success' ? 'instant spell payment or observed spell result' : 'no conclusive outcome' };
}

export function createActivityRecorder({ dir, fleet = '', characterOf = () => null, roomOf = () => null, spellOf = () => null, now = Date.now,
  append = appendFileSync, mkdir = mkdirSync } = {}) {
  const inventory = new Map(), pendingShops = new Map();
  function write(agent, kind, payload = {}, context = null, at = now()) {
    try {
      if (!dir || !validAgent(agent)) return null;
      const character = characterOf(agent);
      if (!character) return null; // no guessed identity or foreign agent
      const row = { format: ACTIVITY_FORMAT, id: randomUUID(), t: at, at, fleet: fleet || 'default', agent, character,
        kind, ...telemetryContext(context), ...payload };
      mkdir(dir, { recursive: true });
      append(join(dir, `${new Date(at).toISOString().slice(0, 10)}.jsonl`), JSON.stringify(row) + '\n');
      return row;
    } catch { return null; }
  }
  function lifecycle(input = {}) {
    if (!input || !safeKinds.has(input.kind) || !telemetryContext(input)) return false;
    const at = number(input.at);
    const payload = { domains: [].concat(input.domains ?? []).filter(d => ['courier', 'practice'].includes(d)),
      ...(input.kind === 'run_end' ? { ok: input.ok === true, interrupted: input.interrupted === true, why: short(input.why), duration_ms: positive(input.duration_ms) } : {}),
      ...(input.kind.startsWith('step_') ? { step: short(input.step, 40), index: positive(input.index), ok: input.kind === 'step_end' ? input.ok === true : null, duration_ms: positive(input.duration_ms), to: positive(input.to), why: short(input.why) } : {}),
      ...(['run_start', 'run_plan'].includes(input.kind) ? { room: positive(input.room) } : {}),
      ...(input.kind === 'run_start' ? { goals: cleanGoals(input.goals), school: cleanName(input.school) } : {}) };
    return !!write(input.agent, input.kind, payload, input, at != null && Math.abs(now() - at) < 60_000 ? at : now());
  }
  function observe(tool, args, reply, { context = null, started = now(), error = null } = {}) {
    try {
      if (inventory.size > 500 || pendingShops.size > 500) { inventory.clear(); pendingShops.clear(); }
      const agent = tool === 'supply' ? (args.who_travels === 'to' ? args.to : args.from) : args.agent;
      const common = { started, duration_ms: Math.max(0, now() - started), room: roomOf(agent) };
      if (tool === 'cast') return write(agent, 'cast', { ...common, spell: cleanName(reply?.spell ?? args.spell), target: typeof args.target === 'string' ? short(args.target) : number(args.target), ...castTelemetry(reply, error, spellOf(reply?.spell ?? args.spell)) }, context);
      if (tool === 'supply') {
        const received = Array.isArray(reply?.received) ? reply.received : Array.isArray(reply?.handed_over) ? reply.handed_over : [];
        return write(agent, 'transfer', { ...common, from: short(args.from, 80), to: short(args.to, 80), item: typeof args.what === 'string' ? short(args.what) : 'specified stacks', asked: positive(args.amount),
          moved: number(reply?.moved ?? reply?.amount_received), ok: !error && reply?.supplied === true,
          received: received.slice(0, 30).map(r => typeof r === 'string' ? { name: short(r), amount: null } : { name: short(r.name), amount: positive(r.arrived ?? r.amount) }),
          travels: ['from', 'to', 'neither'].includes(args.who_travels) ? args.who_travels : 'from', why: short(error?.message ?? reply?.reason ?? reply?.error) }, context);
      }
      const scope = `${context?.run ?? 'direct'}|${agent}`;
      if (tool === 'inventory' && Array.isArray(reply?.items)) {
        const counts = new Map();
        for (const i of reply.items) { const name = cleanName(i.name); if (name) counts.set(name, (counts.get(name) ?? 0) + (positive(i.amount) ?? 1)); }
        const prior = inventory.get(scope), pending = pendingShops.get(scope);
        inventory.set(scope, counts);
        if (pending) {
          const gained = [...counts].filter(([name, count]) => prior && count > (prior.get(name) ?? 0)).map(([name, count]) => ({ name, amount: count - (prior.get(name) ?? 0) }));
          pendingShops.delete(scope);
          return write(agent, 'purchase_observed', { ...common, purchase: pending.id, gained, verified: !!prior, seller: pending.seller }, context);
        }
      }
      if (tool === 'shop' && (args.buy_ids?.length || args.buy?.length)) {
        const row = write(agent, 'purchase', { ...common, seller: short(args.seller), error: short(error?.message ?? reply?.error),
          received: (reply?.received ?? []).slice(0, 30).map(r => ({ name: short(r.name), amount: positive(r.arrived) })), verified: Array.isArray(reply?.received) }, context);
        if (row) pendingShops.set(scope, { id: row.id, seller: short(args.seller) });
        return row;
      }
      if (['hall_withdraw', 'vault', 'bank', 'loot'].includes(tool)) {
        const observed = Array.isArray(reply?.took) ? reply.took : reply?.took && typeof reply.took === 'object'
          ? Object.entries(reply.took).map(([item, amount]) => ({ item, amount })) : Array.isArray(reply?.withdrawn) ? reply.withdrawn : [];
        return write(agent, 'stock', { ...common, tool, action: short(args.action, 40),
          ok: error || reply?.error || reply?.ok === false ? false : reply?.ok === true ? true : null,
          items: observed.slice(0, 30).map(r => ({ name: short(r.item ?? r.name), amount: positive(r.took ?? r.got ?? r.amount) })),
          asked: (args.wants ?? []).slice(0, 30).map(r => ({ name: short(r.item), amount: positive(r.amount) })),
          why: short(error?.message ?? reply?.why ?? reply?.error) }, context);
      }
      if (tool === 'remaining_required_to_learn_new_skills' && Number(reply?.intellect) > 0 && reply?.candidates?.[0]) {
        const g = reply.candidates[0];
        return write(agent, 'gate', { ...common, goal: cleanName(args.name), have: number(g.have), need: number(g.need), gap: number(g.remaining_required), open: g.can_learn === true || g.already_known === true }, context);
      }
    } catch { /* observation cannot break a game action */ }
    if (inventory.size > 500) { inventory.clear(); pendingShops.clear(); }
    return null;
  }
  return { lifecycle, observe };
}

export function cleanGoals(value = {}) {
  return { until: cleanName(value?.until ?? value?.nextSpell),
    until_known: value?.until_known === true,
    abilities: [].concat(value?.abilities ?? []).filter(t => cleanName(t?.name) && positive(t?.to) != null && Number(t.to) <= 100).slice(0, 30).map(t => ({ name: cleanName(t.name), to: Number(t.to) })) };
}

/** Queued in order; no step waits for a telemetry RPC. Flush only after releasing bodies. */
export function createRunTelemetry({ call, run, script, source = null, code = null, parentRun = process.env.M59_TRAINING_RUN, now = Date.now, flushMs = 2000 } = {}) {
  const context = { run, script, source, code, parent_run: parentRun };
  let queue = Promise.resolve(), pending = 0, enabled = true;
  return { context,
    event(agent, kind, data = {}) {
      if (!enabled || pending >= 64) return;
      const event = { ...data, ...context, agent, kind, at: now() }; pending++;
      queue = queue.then(() => enabled ? call('activity_telemetry', { event }, 1000) : null).catch(() => {}).finally(() => { pending--; });
    },
    async flush() {
      let timer;
      try { await Promise.race([queue, new Promise(r => { timer = setTimeout(() => { enabled = false; r(); }, flushMs); })]); }
      finally { clearTimeout(timer); }
    },
  };
}
