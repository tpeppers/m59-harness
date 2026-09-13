// Reflection boundary for human policy editors. No sockets or roster credentials here.
import { createHash } from 'node:crypto';

export const revisionOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const camel = key => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const aliases = { protect_items: 'protectedItems', require_safe_wall: 'pullToSafeWall', fight_back_after_s: 'fightBackAfterMs' };
const obsolete = new Set(['require_safe_wall', 'max_threat_over', 'use_safe_spots']);

export function reflectPolicy(tool, policies = []) {
  const source = tool.run.toString();
  const keys = [...new Set([...policies.flatMap(Object.keys), ...[...source.matchAll(/p\.policy\.([a-zA-Z0-9]+)/g)].map(m => m[1])])];
  return Object.entries(tool.schema.properties).flatMap(([key, spec]) => {
    const policy = aliases[key] ?? keys.find(p => p.toLowerCase() === key.replaceAll('_', '')) ?? camel(key);
    if (obsolete.has(key) || (key !== 'mode' && !policies.some(p => Object.hasOwn(p, policy)) &&
        !source.includes(`p.policy.${policy}`))) return [];
    // Controls describe standing orders, not one-shot actions/leases/debug switches.
    if (['action', 'agent', 'why', 'by', 'full_journal'].includes(key)) return [];
    return [{ ...spec, id: key, policy, title: key.replaceAll('_', ' '), group: 'Keeper orders' }];
  });
}

export function validateValue(spec, value, label = spec.id ?? 'value') {
  if (spec.anyOf) {
    if (!spec.anyOf.some(s => { try { validateValue(s, value, label); return true; } catch { return false; } }))
      throw new Error(`${label}: does not match an allowed type`);
    return value;
  }
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const types = [].concat(spec.type ?? []);
  if (types.length && !types.includes(type) && !(type === 'number' && types.includes('integer') && Number.isInteger(value)))
    throw new Error(`${label}: expected ${types.join(' or ')}`);
  if (spec.enum && !spec.enum.includes(value)) throw new Error(`${label}: choose ${spec.enum.join(', ')}`);
  if (type === 'number' && (!Number.isFinite(value) ||
      (spec.minimum != null && value < spec.minimum) || (spec.maximum != null && value > spec.maximum)))
    throw new Error(`${label}: outside the allowed range`);
  if (type === 'array') {
    if (value.length > (spec.maxItems ?? 100)) throw new Error(`${label}: too many entries`);
    for (const v of value) validateValue(spec.items ?? {}, v, label);
  }
  if (type === 'object') {
    for (const required of spec.required ?? []) if (!Object.hasOwn(value, required)) throw new Error(`${label}: needs ${required}`);
    for (const [k, v] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(k)) throw new Error('reserved key');
      if (spec.additionalProperties === false && !Object.hasOwn(spec.properties ?? {}, k)) throw new Error(`${label}: unknown ${k}`);
      validateValue(spec.properties?.[k] ?? {}, v, `${label}.${k}`);
    }
  }
  return value;
}

export class PolicyControls {
  constructor({ fleet, agents, tool, read, write, pid = process.pid }) {
    Object.assign(this, { fleet, agents, tool, read, write, pid });
    this.queue = Promise.resolve();
  }
  async snapshot(who = this.agents()) {
    if (!Array.isArray(who) || !who.length || who.some(a => !this.agents().includes(a))) throw new Error('select existing fleet agents');
    who = [...new Set(who)].sort();
    const rows = Object.fromEntries(await Promise.all(who.map(async agent => [agent, await this.read(agent)])));
    const schema = reflectPolicy(this.tool(), Object.values(rows).map(r => r.live.policy));
    for (const r of Object.values(rows)) for (const side of ['live', 'restart']) {
      r[side].values = Object.fromEntries(schema.map(s => [s.id,
        s.id === 'mode' ? r[side].mode : s.id === 'fight_back_after_s' && r[side].policy[s.policy] != null
          ? r[side].policy[s.policy] / 1000 : r[side].policy[s.policy] ?? null]));
      r[side].unset = schema.filter(s => s.id !== 'mode' && !Object.hasOwn(r[side].policy, s.policy)).map(s => s.id);
    }
    return { fleet: this.fleet, pid: this.pid, agents: who, schema, rows,
      revision: revisionOf({ pid: this.pid, rows: Object.fromEntries(Object.entries(rows).map(([a, r]) =>
        [a, { keeper_pid: r.keeper_pid, live: r.live, restart: r.restart }])) }) };
  }
  save(body) {
    const run = async () => {
      const before = await this.snapshot(body.agents);
      if (body.expected_fleet !== before.fleet || body.expected_pid !== before.pid || body.expected_revision !== before.revision)
        throw new Error('live policy changed; reset to current before saving');
      const patch = body.patch;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) throw new Error('empty policy patch');
      for (const [key, v] of Object.entries(patch)) {
        const spec = before.schema.find(s => s.id === key);
        if (!spec) throw new Error(`unknown policy ${key}`);
        validateValue(spec, v, key);
      }
      const results = {};
      for (const agent of before.agents) {
        try { results[agent] = { ok: true, result: await this.write(agent, patch) }; }
        catch (e) { results[agent] = { ok: false, error: e.message }; }
      }
      const after = await this.snapshot(before.agents);
      // A successful RPC is not proof that the requested policy reached the keeper.
      for (const [agent, result] of Object.entries(results)) {
        result.actual = after.rows[agent].live.values;
        result.changed = Object.keys(patch).filter(k => JSON.stringify(result.actual[k]) !== JSON.stringify(before.rows[agent].live.values[k]));
      }
      return { ...after, ok: Object.values(results).every(r => r.ok), results };
    };
    const next = this.queue.then(run, run); this.queue = next.catch(() => {}); return next;
  }
}
