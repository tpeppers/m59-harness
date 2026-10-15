// PLAN ROWS: WHO HAS THE CONTROLS. "Relinquish control to Keeper" / "Take control back".
//
// The lock is the proxy's control gate (m59-proxy-gate.mjs). It is the only place a lock
// can be enforced: the server allows one connection per character, the human's client is
// that connection, so "locked out" has to mean "your packets stop at the proxy". The
// client also refuses movement locally while the gate is held (clientcontext.c), but that
// is courtesy — a stock client through the same proxy is locked out just the same.
//
// The gate is a LEASE (ttl below), renewed by this desk while it runs. If the desk dies
// the person gets their character back within the ttl rather than being trapped.
//
// What drives while the gate is held is reported, not assumed: see `driver` below. Today
// that is honestly "nothing on this connection" unless something is injecting through the
// proxy, because the keeper PROCESS cannot share the human's socket. That gap is the main
// finding in docs/m59-client-vs-harness.md, and this row says so rather than pretending.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { evidenceDirFor } from '../m59-fleetpath.mjs';

const TTL_MS = 120_000, RENEW_MS = 30_000;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const holderFor = agent => `keeper:${agent}`;

export function gateProxies(dir = join(evidenceDirFor(), 'proxies')) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; }
  }).filter(a => a?.gate_control && a.pid && alive(a.pid));
}

async function http(port, path, body = null) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(3000) } : { signal: AbortSignal.timeout(3000) });
  return r.json();
}

// Find the gate-capable proxy session carrying THIS client: same player object id. The
// client's own server string names the real server when it went through a proxy
// (M59_INVENTORY_SERVER), so the advert's `server` must match it too.
export async function findSession(client, proxies = gateProxies()) {
  for (const a of proxies) {
    const srv = `${a.server?.host}:${a.server?.port}`.toLowerCase();
    if (client.server && client.server !== srv) continue;
    try {
      const g = await http(a.gate_control, '/gate');
      const s = (g.sessions ?? []).find(s => ((s.player_id ?? 0) & 0x0fffffff) === client.player_id);
      if (s) return { advert: a, session: s };
    } catch { /* a proxy that will not answer cannot hold a lock for anybody */ }
  }
  return null;
}

const renewals = new Map();   // pid -> timer

export const provider = {
  id: 'control',
  async entries(ctx) {
    const c = ctx.client;
    const found = await findSession(c);
    const gate = found?.session?.gate ?? null;
    ctx.control = !gate ? 'none' : gate.holder === holderFor(c.agent) ? 'keeper' : 'other';
    if (!found) {
      return [{ id: 'control.keeper', group: 'Control', icon: 'keeper', title: 'Relinquish control to Keeper', disabled: true,
        describe: 'No gate-capable proxy is carrying this client, so nothing can lock it. Start one with ' +
                  '`node tools/m59-proxy.mjs --observe --gate-control 8931 --listen <port> --server <host:port>` and ' +
                  'reconnect through it (dev.bat finds it by itself).' }];
    }
    if (!gate) {
      const why = found.session.gate_refusal;
      return [{ id: 'control.keeper', group: 'Control', icon: 'keeper', title: 'Relinquish control to Keeper',
        disabled: !!why || !c.agent,
        describe: why ? `Not yet: ${why}.` : !c.agent ? 'This account is not in the fleet roster.' :
          'Your movement, combat, trade and item packets stop at the proxy until you take control back; ' +
          'chat, looking and logging off still work. You spectate. Logging off always releases.' }];
    }
    if (gate.holder === holderFor(c.agent)) {
      return [{ id: 'control.take', group: 'Control', icon: 'keeper', title: 'Take control back from Keeper', running: true,
        describe: `Keeper has held the controls since ${new Date(gate.since).toLocaleTimeString()} ` +
          `(${gate.dropped} of your inputs dropped). Driver on this connection: none yet — the keeper process cannot ` +
          'share your socket (see the report); scripts that inject through the proxy can.' }];
    }
    return [{ id: 'control.take', group: 'Control', icon: 'keeper', title: `Controls held by ${gate.holder}`, disabled: true,
      describe: `${gate.reason || 'no reason given'} — only its holder can release it, or it lapses by itself.` }];
  },
  async run(entry, args, ctx) {
    const c = ctx.client;
    const found = await findSession(c);
    if (!found) return { ok: false, message: 'no gate-capable proxy carries this client' };
    const port = found.advert.gate_control, q = `?player=${found.session.player_id}`;
    if (entry === 'control.keeper') {
      const r = await http(port, '/gate' + q, { holder: holderFor(c.agent), reason: 'relinquished from the PLAN tab', ttl_ms: TTL_MS });
      if (!r.ok) return { ok: false, message: r.why ?? r.error };
      clearInterval(renewals.get(c.pid));
      renewals.set(c.pid, setInterval(() => http(port, '/gate' + q, { holder: holderFor(c.agent), reason: 'relinquished from the PLAN tab', ttl_ms: TTL_MS })
        .then(x => { if (!x.ok) { clearInterval(renewals.get(c.pid)); renewals.delete(c.pid); } }).catch(() => {}), RENEW_MS));
      return { ok: true, message: 'Keeper has the controls. You are spectating; take control back from this tab, or log off.' };
    }
    if (entry === 'control.take') {
      clearInterval(renewals.get(c.pid)); renewals.delete(c.pid);
      const r = await http(port, '/ungate' + q, { holder: holderFor(c.agent) });
      return r.ok ? { ok: true, message: `Controls are yours again (${r.was?.dropped ?? 0} inputs were dropped while Keeper held them).` }
                  : { ok: false, message: r.why ?? r.error };
    }
    return { ok: false, message: `unknown control entry ${entry}` };
  },
};
