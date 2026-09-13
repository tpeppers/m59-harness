// Shared protocol client for human-operated FleetScratch and the broker chat UX.
import { validateValue } from './m59-policy-controls.mjs';

export async function controlRpc(brokerUrl, name, args) {
  const r = await fetch(brokerUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(45000) });
  const j = await r.json();
  if (!r.ok || j.error || j.result?.isError) throw new Error(j.error?.message ?? j.result?.content?.[0]?.text ?? `HTTP ${r.status}`);
  return JSON.parse(j.result.content[0].text);
}

export async function discoverControls({ brokerUrl = 'http://127.0.0.1:8901', fleet = null, url = null } = {}) {
  const health = await fetch(new URL('/health', brokerUrl), { signal: AbortSignal.timeout(4000) }).then(r => r.json());
  if (fleet && health.fleet !== fleet) throw new Error('broker is holding another fleet');
  const registered = url ? [{ url }] : (await controlRpc(brokerUrl, 'dum_controls', { action: 'list' })).controllers;
  const verified = [];
  for (const entry of registered) {
    const u = new URL(entry.url);
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) continue;
    try {
      const h = await fetch(new URL('/health', u), { signal: AbortSignal.timeout(4000) }).then(r => r.json());
      if (h.fleet === health.fleet && h.human_controls && (!entry.pid || h.pid === entry.pid)) verified.push({ url: u.origin, fleet: h.fleet, pid: h.pid });
    } catch { /* A stale registration is not a live controller. */ }
  }
  if (verified.length !== 1) throw new Error(verified.length ? 'multiple DUM controllers; select one with --url' : 'no verified DUM human controller; start or update DUM first');
  return verified[0];
}

export class ControlClient {
  constructor(binding) { this.binding = binding; }
  async request(path, body) {
    const r = await fetch(this.binding.url + path, { cache: 'no-store',
      ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60000) });
    const value = await r.json();
    if (!r.ok || value.error) throw new Error(value.error ?? `HTTP ${r.status}`);
    if (value.fleet !== this.binding.fleet || value.pid !== this.binding.pid) throw new Error('DUM process/fleet changed; reconnect before editing');
    return value;
  }
  read(agents = []) { return this.request('/controls?agents=' + encodeURIComponent(agents.join(','))); }
  save(draft) { return this.request('/controls', draft.payload()); }
}

const normalized = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
export class ControlDraft {
  constructor(snapshot) { this.reset(snapshot); }
  reset(snapshot) { this.snapshot = snapshot; this.patch = {}; this.inherit = []; }
  field(query) {
    const q = normalized(query);
    const direct = this.snapshot.fields.find(f => normalized(f.id) === q);
    if (direct) return direct;
    const matches = this.snapshot.fields.filter(f => normalized(f.title) === q || normalized(f.id.replace(/^order\./, '')) === q);
    if (matches.length !== 1) throw new Error(matches.length ? 'ambiguous setting; use its full ID' : `unknown setting: ${query}`);
    return matches[0];
  }
  set(query, raw) {
    const f = this.field(query);
    let value = raw;
    if (typeof raw === 'string') {
      if (/^(on|true)$/i.test(raw)) value = true;
      else if (/^(off|false)$/i.test(raw)) value = false;
      else { try { value = JSON.parse(raw); } catch { value = raw; } }
    }
    validateValue(f, value);
    this.patch[f.id] = value;
    this.inherit = this.inherit.filter(k => k !== f.id);
    return f;
  }
  inheritField(query) {
    const f = this.field(query);
    if (!f.id.startsWith('order.')) throw new Error('inherit applies to keeper orders; strategy templates already inherit their base settings');
    delete this.patch[f.id];
    if (!this.inherit.includes(f.id)) this.inherit.push(f.id);
    return f;
  }
  payload() { const { fleet, pid, revision, agents } = this.snapshot; return { fleet, pid, revision, agents, patch: this.patch, inherit: this.inherit }; }
  describe(f) {
    const lines = [f.id + ': ' + (f.description ?? f.title)];
    for (const agent of this.snapshot.agents) {
      const row = this.snapshot.rows[agent];
      const desired = Object.hasOwn(this.patch, f.id) ? this.patch[f.id] : row.current[f.id];
      const observed = side => row[side + '_unset']?.includes(f.id) ? 'unset (keeper default; see description)' : JSON.stringify(row[side][f.id]);
      lines.push(`${agent}: current=${observed('current')} restart=${observed('restart')} desired=${this.inherit.includes(f.id) ? 'inherit' : JSON.stringify(desired)}`);
    }
    return lines;
  }
  // Longest matching label makes "no food vigor floor 70" work without a command table.
  assignment(line) {
    const text = line.replace(/^set\s+/i, '').trim();
    for (let i = text.length - 1; i > 0; i--) if (text[i] === ' ' || text[i] === '=') {
      try { const f = this.field(text.slice(0, i).trim()); return this.set(f.id, text.slice(i + 1).trim()); }
      catch (e) { if (!/unknown setting|ambiguous setting/.test(e.message)) throw e; }
    }
    throw new Error('use set <setting ID or label> <value>; list shows the available settings');
  }
}
