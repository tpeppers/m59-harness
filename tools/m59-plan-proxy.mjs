// Upgrade MANAGE plumbing beside an older proxy. A game-listener connection would
// open a real upstream game session, so availability is checked by binding an idle
// loopback listener; readiness comes from the separate HTTP status endpoint.
import net from 'node:net';
import { join, resolve } from 'node:path';

const hostKey = host => ['localhost', '::1', '127.0.0.1'].includes(String(host).toLowerCase())
  ? '127.0.0.1' : String(host).toLowerCase();
export const sameProxyServer = (a, host, port) => !!a?.server &&
  hostKey(a.server.host) === hostKey(host) && Number(a.server.port) === Number(port);
const validPort = value => Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 65535;
export const clientContextForDesk = ({ explicit, local, desk } = {}) => explicit || desk?.elsewhere?.dir || local;
export function deskMatchesRoster(desk, { fleet, stateFile } = {}) {
  if (!desk || (desk.fleet || '') !== (fleet || '') || !stateFile) return false;
  // Older desks advertised their substrate. Infer only its conventional roster;
  // a current explicit state_file is authoritative even when it disagrees.
  const recorded = desk.state_file || (desk.substrate &&
    (fleet ? join(desk.substrate, 'fleets', `${fleet}.json`) : join(desk.substrate, 'fleet-state.json')));
  if (!recorded) return false;
  const key = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  return key(recorded) === key(stateFile);
}
export const ridealongCapable = a => Number(a?.ridealong) === 1 && validPort(a?.listen) &&
  validPort(a?.gate_control) && validPort(a?.attach ?? a?.attach_port);
export const compareProxyAdverts = (a, b) => Number(ridealongCapable(b)) - Number(ridealongCapable(a)) ||
  Number(!!b.gate_control) - Number(!!a.gate_control) || Number(b.at || 0) - Number(a.at || 0);

export const portAvailable = port => new Promise(resolve => {
  if (!validPort(port)) { resolve(false); return; }
  const server = net.createServer();
  server.unref();
  server.once('error', () => resolve(false));
  server.listen({ host: '127.0.0.1', port: Number(port), exclusive: true }, () => server.close(() => resolve(true)));
});
export async function chooseProxyPorts({ listen = 5962, gate = 8931, attach = 8932,
    explicit = {}, available = portAvailable, attempts = 24 } = {}) {
  for (const [key, value] of Object.entries({ listen, gate, attach }))
    if (explicit[key] && (!validPort(value) || !await available(Number(value)))) return null;
  for (let i = 0; i < attempts; i++) {
    const candidate = { listen: Number(listen) + (explicit.listen ? 0 : i),
      gate: Number(gate) + (explicit.gate ? 0 : 2 * i), attach: Number(attach) + (explicit.attach ? 0 : 2 * i) };
    const ports = Object.values(candidate);
    if (ports.some(p => !validPort(p)) || new Set(ports).size !== ports.length) continue;
    if ((await Promise.all(ports.map(available))).every(Boolean)) return candidate;
    if (explicit.listen && explicit.gate && explicit.attach) break;
  }
  return null;
}
const statusAt = async port => {
  const r = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(500) });
  return r.ok ? r.json() : null;
};
export function confirmsProxy(advert, status, host, port) {
  return ridealongCapable(advert) && ridealongCapable({ ...status, attach: status?.attach_port }) &&
    sameProxyServer(advert, host, port) && sameProxyServer(status, host, port) &&
    Number(status.pid) === Number(advert.pid) && Number(status.listen) === Number(advert.listen) &&
    Number(status.gate_control) === Number(advert.gate_control) && Number(status.attach_port) === Number(advert.attach);
}
async function ensureProxy({ host, port, listen = 5962, gate = 8931, attach = 8932, explicit = {},
    find, start, status = statusAt, available = portAvailable,
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)), polls = 20 } = {}) {
  const allowed = a => (!explicit.listen || Number(a.listen) === Number(listen)) &&
    (!explicit.gate || Number(a.gate_control) === Number(gate)) &&
    (!explicit.attach || Number(a.attach) === Number(attach));
  const ready = async a => {
    if (!ridealongCapable(a) || !allowed(a) || !sameProxyServer(a, host, port)) return false;
    try { return confirmsProxy(a, await status(a.gate_control), host, port); } catch { return false; }
  };
  const existing = find?.({ listen: explicit.listen ? listen : null,
    gate: explicit.gate ? gate : null, attach: explicit.attach ? attach : null });
  if (await ready(existing)) return { ok: true, started: false, listen: Number(existing.listen) };
  const tuple = await chooseProxyPorts({ listen, gate, attach, explicit, available });
  if (!tuple) return { ok: false, started: false, why: 'no free proxy, gate and attach ports; existing listeners were left running' };
  try { await start(tuple); }
  catch (e) { return { ok: false, started: false, why: e.message }; }
  for (let i = 0; i < polls; i++) {
    const advert = find?.(tuple);
    if (Number(advert?.listen) === tuple.listen && await ready(advert))
      return { ok: true, started: true, listen: tuple.listen };
    await wait(250);
  }
  return { ok: false, started: true, listen: tuple.listen, why: 'new proxy did not confirm its ridealong status' };
}

// L can start another character while the first launch awaits startup. Both must
// await one proxy rather than choosing the same temporarily free tuple twice.
const starting = new Map();
export function ensureRidealongProxy(options = {}) {
  const key = JSON.stringify([hostKey(options.host), Number(options.port), options.listen ?? 5962,
    options.gate ?? 8931, options.attach ?? 8932, !!options.explicit?.listen, !!options.explicit?.gate, !!options.explicit?.attach]);
  if (starting.has(key)) return starting.get(key);
  const operation = ensureProxy(options).finally(() => { if (starting.get(key) === operation) starting.delete(key); });
  starting.set(key, operation);
  return operation;
}
