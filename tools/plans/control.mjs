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

import { readdirSync, readFileSync, existsSync, openSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
    // ...or the proxy's own listen address: a client the fleet terminal points at the proxy names
    // where it connected (127.0.0.1:5962), not the server behind it.
    if (client.server && client.server !== srv && client.server !== `127.0.0.1:${a.listen}`) continue;
    try {
      const g = await http(a.gate_control, '/gate');
      const s = (g.sessions ?? []).find(s => ((s.player_id ?? 0) & 0x0fffffff) === client.player_id);
      if (s) return { advert: a, session: s };
    } catch { /* a proxy that will not answer cannot hold a lock for anybody */ }
  }
  return null;
}

const renewals = new Map();   // pid -> timer

// SPECTATE (tools/m59-spectate-keeper.mjs): the keeper that drives while the gate is held, attached
// to the person's own connection through the proxy's attach port. Started here, one per agent;
// its heartbeat is <harness>/substrate/spectate/<agent>.json.
const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const spectateBeat = agent => { try { return JSON.parse(readFileSync(join(HARNESS, 'substrate', 'spectate', `${agent}.json`), 'utf8')); } catch { return null; } };
const spectateAlive = agent => { const h = spectateBeat(agent); if (!h || Date.now() - h.at > 10_000 || /^stopped/.test(h.state)) return null;
  try { process.kill(h.pid, 0); return h; } catch { return null; } };
function logFd(agent) {
  try { const d = join(HARNESS, 'substrate', 'spectate'); mkdirSync(d, { recursive: true }); return openSync(join(d, `${agent}.log`), 'a'); }
  catch { return 'ignore'; }
}
function startSpectate(ctx, advert, playerId) {
  if (spectateAlive(ctx.client.agent)) return { ok: true, already: true };
  if (!advert.attach) return { ok: false, why: 'this proxy has no attach port (start it with --attach), so no keeper can drive' };
  const child = spawn(process.execPath, [join(HARNESS, 'tools', 'm59-spectate-keeper.mjs'), '--fleet', ctx.fleet === '' ? '-' : ctx.fleet,
    '--agent', ctx.client.agent, '--attach-port', String(advert.attach), '--player', String(playerId)],
    // ITS OUTPUT GOES TO substrate/spectate/<agent>.log. It was discarded, and the first live failure
    // (a scrambled stream, see m59-proxy-token.mjs) had to be reconstructed from crash dumps instead.
    { cwd: HARNESS, detached: true, stdio: ['ignore', logFd(ctx.client.agent), logFd(ctx.client.agent)], windowsHide: true });
  child.unref();
  return { ok: true, pid: child.pid };
}
function stopSpectate(agent) {
  const h = spectateBeat(agent);
  if (h?.pid) { try { process.kill(h.pid, 'SIGTERM'); } catch { /* already gone */ } }
}
const gaveUp = new Map();   // agent -> when the keeper was found dead while holding the gate

export const provider = {
  id: 'control',
  // A KEEPER THAT DIED WHILE HOLDING THE CONTROLS GIVES THEM BACK. Locked out with nobody driving is
  // the one state this must never leave a person in for long: after 20s without a live spectate
  // keeper, the gate is released and the person is told.
  async tick(ctx) {
    const c = ctx.client;
    if (!c.agent) return;
    const found = await findSession(c);
    const gate = found?.session?.gate;
    if (!gate || gate.holder !== holderFor(c.agent)) { gaveUp.delete(c.agent); return; }
    if (spectateAlive(c.agent) || found.session.attached) { gaveUp.delete(c.agent); return; }
    if (!gaveUp.has(c.agent)) { gaveUp.set(c.agent, ctx.now); return; }
    if (ctx.now - gaveUp.get(c.agent) < 20_000) return;
    clearInterval(renewals.get(c.pid)); renewals.delete(c.pid);
    await http(found.advert.gate_control, `/ungate?player=${found.session.player_id}`, { holder: holderFor(c.agent) }).catch(() => {});
    gaveUp.delete(c.agent);
    const st = ctx.desk; st.messages.push({ seq: Date.now(), ok: false, message: 'The keeper stopped, so the controls are yours again.' });
    ctx.log(`[plan ${c.agent}] spectate keeper gone while holding the gate -- released`);
  },
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
          `(${gate.dropped} of your inputs dropped). ` + (found.session.attached
            ? `Keeper ${found.session.attached.agent} is driving on your connection: ${found.session.attached.injected} of its packets sent, ` +
              `${found.session.attached.forged} moves mirrored to your screen.`
            : spectateAlive(c.agent) ? 'Keeper is starting and attaching to your connection…'
            : 'No keeper is attached yet.') }];
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
      const sp = startSpectate(ctx, found.advert, found.session.player_id);
      gaveUp.delete(c.agent);
      return { ok: true, message: sp.ok ? 'Keeper has the controls and is attaching to your connection. You are spectating; take control back from this tab, or log off.'
                                        : `Keeper has the controls, but cannot drive: ${sp.why}. Take control back to play.` };
    }
    if (entry === 'control.take') {
      clearInterval(renewals.get(c.pid)); renewals.delete(c.pid);
      // Ungate FIRST: from this packet on the keeper's frames are dropped at the proxy, so stopping it can be slow.
      const r = await http(port, '/ungate' + q, { holder: holderFor(c.agent) });
      stopSpectate(c.agent);
      return r.ok ? { ok: true, message: `Controls are yours again (${r.was?.dropped ?? 0} inputs were dropped while Keeper held them).` }
                  : { ok: false, message: r.why ?? r.error };
    }
    return { ok: false, message: `unknown control entry ${entry}` };
  },
};
