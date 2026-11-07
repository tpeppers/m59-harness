// A debug client lends its proxy connection to the BROKER'S keeper. It remains an ordinary
// automated fleet member, including its HTTP actions, DUM leases and standing orders.
// The proxy gates packets; this controller coordinates ownership without ever logging in.
import { resolve, isAbsolute } from 'node:path';

const integer = (value, label, max = 0x7fffffff) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw Error(`${label} must be a positive integer`);
  return n;
};
export function ridealongRequest(args, stateFile) {
  if (typeof args.fleet_state !== 'string' || !isAbsolute(args.fleet_state) ||
      resolve(args.fleet_state).toLowerCase() !== resolve(stateFile).toLowerCase())
    throw Error('fleet_state must name this broker\'s exact absolute roster file');
  if (!/^[a-z0-9_-]{1,40}$/.test(args.agent ?? '')) throw Error('an exact fleet agent is required');
  return { agent: args.agent, client_pid: integer(args.pid, 'client pid'),
    player: integer(args.player, 'player', 0xffffffff),
    attach_port: integer(args.attach_port, 'attach_port', 65535),
    gate_control: integer(args.gate_control, 'gate_control', 65535) };
}
export function sameRidealong(a, b) {
  return !!a && !!b && ['agent', 'client_pid', 'player', 'attach_port', 'gate_control']
    .every(key => a[key] === b[key]);
}
// Object IDs can change during a save. The live attachment belongs to one agent
// on this exact local proxy even while its previous numeric player ID is stale.
export function ridealongSession(want, status) {
  const attached = status?.sessions?.filter(s => s.attached?.agent === want.agent) ?? [];
  if (attached.length === 1) return attached[0];
  return status?.sessions?.find(s => Number(s.player_id) === want.player) ?? null;
}
const endpointHost = value => ['localhost', '::1', '127.0.0.1'].includes(String(value).toLowerCase())
  ? '127.0.0.1' : String(value).toLowerCase();
export function verifyRidealongProxy(want, status, credentials, { requireGate = true } = {}) {
  if (Number(status?.attach_port) !== want.attach_port || Number(status?.gate_control) !== want.gate_control)
    throw Error('proxy does not confirm the requested attach and gate ports');
  if (endpointHost(status?.server?.host) !== endpointHost(credentials.host || '127.0.0.1') ||
      Number(status?.server?.port) !== Number(credentials.port || 5959))
    throw Error('proxy is connected to a different game server from this roster');
  const row = status?.sessions?.find(s => Number(s.player_id) === want.player);
  if (!row) throw Error('proxy does not hold the requested player');
  if (!row.in_game) throw Error('proxy player is not in game');
  if (requireGate && row.gate?.holder !== `keeper:${want.agent}`)
    throw Error('proxy control gate is not held by this keeper');
  if (row.attached && row.attached.agent !== want.agent)
    throw Error('proxy connection is attached to another keeper');
  return row;
}

// Dependencies are injected so all failure paths can be exercised against a fake supervisor.
export class RidealongControls {
  constructor(io) { this.io = io; this.records = new Map(); this.transitions = new Set(); }
  status(agent) {
    const rec = this.records.get(agent), keeper = this.io.keeper(agent);
    const ready = !!rec?.keeper_ready;
    return { agent, automated: !!rec && rec.phase === 'active' && ready && !this.io.pilot(agent), keeper_ready: ready,
      attached: rec ? { ...rec, pid: keeper?.pid ?? null, log_path: this.io.logPath(agent) } : null,
      piloted: !!this.io.pilot(agent), transitioning: this.transitions.has(agent) };
  }
  async attach(args) {
    const io = this.io;
    let want;
    try { want = ridealongRequest(args, io.stateFile); } catch (e) { return { ok: false, error: e.message }; }
    const agent = want.agent;
    if (this.transitions.has(agent)) return { ok: false, error: 'a control transfer is already in progress', ...this.status(agent) };
    this.transitions.add(agent);
    let changed = false;
    try {
      const credentials = io.credentials(agent);
      if (!credentials) throw Error('agent is not in this broker\'s fleet');
      if (!io.pidAlive(want.client_pid)) throw Error('client process is no longer running');
      const prior = this.records.get(agent);
      if (prior && !sameRidealong(prior, want)) throw Error('another client connection is already released; reclaim it first');
      const proxy = await io.proxyStatus(want);
      verifyRidealongProxy(want, proxy, credentials);
      if (prior?.phase === 'active' && !io.pilot(agent)) {
        prior.keeper_ready = !!await io.ready(agent, want);
        if (!prior.keeper_ready) throw Error('registered keeper attachment is not ready');
        return { ok: true, ...this.status(agent) };
      }
      const pilot = io.pilot(agent);
      if (!pilot || pilot.lease || pilot.pid !== want.client_pid)
        throw Error('the current local pilot claim must belong to this exact client pid');
      if (!await io.stop(agent)) throw Error('previous keeper did not stop; refusing a second keeper');
      const rec = { ...want, proxy_pid: Number(proxy.pid) || null,
        phase: 'starting', since: Date.now(), keeper_was_running: pilot.keeperWasRunning };
      this.records.set(agent, rec); changed = true;
      if (!await io.start(agent)) throw Error('attached keeper did not start');
      if (!await io.ready(agent, want)) throw Error('attached keeper did not confirm this player and proxy');
      // No generic pilot release here: it schedules a LOGIN and marks the client as gone.
      // The same native connection is still in the world; only its driver has changed.
      io.unclaim(agent, pilot);
      rec.phase = 'active'; rec.keeper_ready = true;
      return { ok: true, ...this.status(agent) };
    } catch (e) {
      if (changed) {
        const stopped = await io.stop(agent).catch(() => false);
        if (stopped) this.records.delete(agent);
        else { const rec = this.records.get(agent); if (rec) rec.phase = 'failed'; }
      }
      return { ok: false, error: e.message, ...this.status(agent) };
    } finally { this.transitions.delete(agent); }
  }
  async reclaim(args) {
    const io = this.io;
    let want;
    try { want = ridealongRequest(args, io.stateFile); } catch (e) { return { ok: false, error: e.message }; }
    const agent = want.agent;
    if (this.transitions.has(agent)) return { ok: false, error: 'a control transfer is already in progress', ...this.status(agent) };
    this.transitions.add(agent);
    try {
      const rec = this.records.get(agent);
      if (rec && !sameRidealong(rec, want)) throw Error('reclaim does not match the released client connection');
      if (!io.credentials(agent)) throw Error('agent is not in this broker\'s fleet');
      if (!io.pidAlive(want.client_pid)) throw Error('client process is no longer running');
      verifyRidealongProxy(want, await io.proxyStatus(want), io.credentials(agent), { requireGate: false });
      // This MUST precede the stop. Otherwise the reconciler can reconnect between dropping
      // the attachment and returning the proxy gate, bumping the native client off the server.
      io.claim(agent, want.client_pid, { keeperWasRunning: rec?.keeper_was_running ?? true });
      if (rec && !await io.stop(agent)) throw Error('attached keeper did not stop; pilot claim retained');
      this.records.delete(agent);
      return { ok: true, reclaimed: true, ...this.status(agent) };
    } catch (e) { return { ok: false, error: e.message, ...this.status(agent) }; }
    finally { this.transitions.delete(agent); }
  }
  async suspend(agent, why) {
    if (this.transitions.has(agent)) return false;
    const rec = this.records.get(agent);
    if (!rec) return true;
    this.transitions.add(agent);
    try {
      // Gate expiry or a dead desk returns control to the native client immediately.
      // Hold its identity before touching the attachment, just as explicit reclaim does.
      if (this.io.pidAlive(rec.client_pid))
        this.io.claim(agent, rec.client_pid, { keeperWasRunning: rec.keeper_was_running ?? true });
      rec.phase = 'suspended'; rec.keeper_ready = false; rec.reason = why;
      if (!await this.io.stop(agent)) return false;
      this.records.delete(agent);
      return true;
    } finally { this.transitions.delete(agent); }
  }
}
