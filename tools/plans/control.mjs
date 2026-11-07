// The proxy gates input; the broker's normal keeper drives the shared connection.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { evidenceDirFor, stateFileFor } from '../m59-fleetpath.mjs';
import { createKeeperLogTail } from '../m59-plan-logs.mjs';

const TTL_MS = 120_000, RENEW_MS = 30_000;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const holderFor = agent => `keeper:${agent}`;
export function gateProxies(dir = join(evidenceDirFor(), 'proxies')) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; }
  }).filter(a => a?.gate_control && a.pid && alive(a.pid));
}
async function http(port, path, body = null, timeoutMs = 3000) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return r.json();
}
export async function findSession(client, proxies = gateProxies()) {
  for (const a of proxies) {
    const srv = `${a.server?.host}:${a.server?.port}`.toLowerCase();
    if (client.server && client.server !== srv && client.server !== `127.0.0.1:${a.listen}`) continue;
    try {
      const g = await http(a.gate_control, '/gate');
      const s = (g.sessions ?? []).find(s => ((s.player_id ?? 0) & 0x0fffffff) === client.player_id);
      if (s) return { advert: a, session: s };
    } catch { /* cannot establish this connection */ }
  }
  return null;
}
async function broker(args) {
  const port = Number(process.env.M59_PLAN_BROKER_PORT || process.env.M59_BROKER_PORT || 8901);
  const r = await http(port, '/', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pilot', arguments: args } }, 120_000);
  if (r.error) throw Error(r.error.message ?? 'broker refused the request');
  if (r.result?.content) {
    const text = r.result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    try { return JSON.parse(text); } catch { throw Error(text || 'empty broker response'); }
  }
  return r.result ?? { error: 'empty broker response' };
}

// Injection points exercise the real transition ordering without a production fleet.
export function createControlProvider({ find = findSession, callBroker = broker, proxy = http } = {}) {
  const params = (ctx, found) => ({ agent: ctx.client.agent, pid: ctx.client.pid,
    fleet_state: ctx.stateFile ?? stateFileFor(ctx.fleet), attach_port: found.advert.attach,
    gate_control: found.advert.gate_control, player: found.session.player_id });
  function matches(ctx, found, status) {
    const a = status?.attached;
    return !!(status?.automated && a && a.client_pid === ctx.client.pid &&
      a.player === found?.session.player_id && a.attach_port === found?.advert.attach &&
      a.gate_control === found?.advert.gate_control);
  }
  async function observe(ctx, found, refresh = false) {
    const st = ctx.desk;
    if (refresh || st.controlObservedAt !== ctx.now) {
      st.controlObservedAt = ctx.now; st.controlStatus = null;
      if (ctx.client.agent && found?.session?.gate?.holder === holderFor(ctx.client.agent)) {
        try { st.controlStatus = await callBroker({ action: 'control_status', agent: ctx.client.agent,
          fleet_state: ctx.stateFile ?? stateFileFor(ctx.fleet) }); }
        catch (e) { st.controlStatus = { error: e.message }; }
      }
    }
    ctx.keeperRegistered = matches(ctx, found, st.controlStatus);
    return st.controlStatus;
  }
  const logPath = ctx => join(ctx.substrate, `keeper-${ctx.client.agent}.log`);
  const logRow = ctx => ({ id: 'control.logs', group: 'Control', icon: 'keeper', configure: true,
    title: `Keeper debug log: ${ctx.desk.logTail?.enabled ? 'on' : 'off'}`,
    disabled: !ctx.client.capabilities?.logs || !ctx.client.agent,
    describe: ctx.client.capabilities?.logs
      ? 'Duplicate new output from this character\'s harness keeper log into this client\'s text window. The disk log continues normally. Starts at the end when enabled.'
      : 'Relaunch the updated debug client to display keeper logs here.',
    args: [{ id: 'enabled', title: 'Show keeper debug log in this client', type: 'boolean', default: String(!!ctx.desk.logTail?.enabled) }],
  });
  return {
    id: 'control',
    async entries(ctx) {
      const c = ctx.client, found = await find(c), gate = found?.session?.gate;
      ctx.control = !gate ? 'none' : gate.holder === holderFor(c.agent) ? 'keeper' : 'other';
      const status = await observe(ctx, found);
      let row;
      if (!found) row = { id: 'control.keeper', title: 'Release to Keeper', disabled: true,
        describe: 'No gate-capable proxy carries this client. Relaunch with the fleet terminal\'s L key.' };
      else if (!gate) {
        const why = found.session.gate_refusal || (!found.advert.attach ? 'proxy needs the keeper attach port' : !c.agent ? 'this account is not in the fleet roster' : null);
        row = { id: 'control.keeper', title: 'Release to Keeper', disabled: !!why,
          describe: why ? `Not yet: ${why}.` : 'The broker runs your normal keeper on this client\'s connection. DUM bots and FleetScripts can use it. You watch; reclaim to play.' };
      } else if (ctx.control === 'keeper') row = { id: 'control.take', title: 'Reclaim from Keeper', running: true,
        describe: ctx.keeperRegistered
          ? `Broker keeper ${status.attached.pid} is driving; ${found.session.attached?.injected ?? 0} packets sent, ${found.session.attached?.forged ?? 0} moves mirrored.`
          : `Waiting for the broker keeper. ${status?.error ?? 'Reclaim returns the controls to this client.'}` };
      else row = { id: 'control.take', title: `Controls held by ${gate.holder}`, disabled: true,
        describe: `${gate.reason || 'no reason given'}; only its holder can release it, or its lease expires.` };
      return [{ group: 'Control', icon: 'keeper', ...row }, logRow(ctx)];
    },
    async tick(ctx) {
      const st = ctx.desk, c = ctx.client;
      if (!c.agent) return;
      const found = await find(c), gate = found?.session?.gate;
      if (gate?.holder === holderFor(c.agent)) {
        await observe(ctx, found);
        if (ctx.keeperRegistered) {
          st.keeperMissingAt = null;
          if (!st.nextGateRenew || ctx.now >= st.nextGateRenew) {
            const r = await proxy(found.advert.gate_control, `/gate?player=${found.session.player_id}`,
              { holder: holderFor(c.agent), reason: 'released from the MANAGE tab', ttl_ms: TTL_MS });
            if (!r.ok) throw Error(r.error ?? r.why ?? 'could not renew keeper gate');
            st.nextGateRenew = ctx.now + RENEW_MS;
          }
        } else {
          st.keeperMissingAt ??= ctx.now;
          if (ctx.now - st.keeperMissingAt >= 20_000) {
            const r = await callBroker({ action: 'reclaim', ...params(ctx, found) });
            if (r.ok) {
              await proxy(found.advert.gate_control, `/ungate?player=${found.session.player_id}`, { holder: holderFor(c.agent) });
              st.messages.push({ seq: Date.now(), ok: false, message: 'The keeper stopped; controls returned to this client.' });
              st.keeperMissingAt = null;
            }
          }
        }
      } else { st.nextGateRenew = null; st.keeperMissingAt = null; }
      if (st.logTail?.enabled && c.capabilities?.logs) st.logs = [...st.logs ?? [], ...st.logTail.read(logPath(ctx))].slice(-64);
    },
    async run(entry, args, ctx) {
      if (entry === 'control.logs') {
        if (!ctx.client.capabilities?.logs || !ctx.client.agent) return { ok: false, message: 'This client cannot display keeper logs; relaunch the updated debug client.' };
        ctx.desk.logTail ??= createKeeperLogTail();
        const enabled = args.enabled === 'true';
        ctx.desk.logTail.setEnabled(enabled, logPath(ctx)); ctx.desk.logs = [];
        return { ok: true, message: `Keeper debug log ${enabled ? 'on' : 'off'} for this client.` };
      }
      const found = await find(ctx.client);
      if (!found || !ctx.client.agent) return { ok: false, message: 'No fleet client connection found.' };
      const port = found.advert.gate_control, q = `?player=${found.session.player_id}`, holder = holderFor(ctx.client.agent);
      if (entry === 'control.keeper') {
        if (!found.advert.attach) return { ok: false, message: 'Proxy has no keeper attach port; relaunch its updated version.' };
        const gate = await proxy(port, '/gate' + q, { holder, reason: 'released from the MANAGE tab', ttl_ms: TTL_MS });
        if (!gate.ok) return { ok: false, message: gate.why ?? gate.error };
        let r;
        try { r = await callBroker({ action: 'attach', ...params(ctx, found) }); }
        catch (e) {
          // A lost HTTP reply does not cancel the broker's ownership transfer.
          // Keep the gate until its status proves whether the transfer completed.
          try {
            const status = await callBroker({ action: 'control_status', agent: ctx.client.agent,
              fleet_state: ctx.stateFile ?? stateFileFor(ctx.fleet) });
            if (matches(ctx, found, status)) r = { ok: true, ...status };
            else if (status.piloted && !status.attached && !status.transitioning) r = { error: e.message };
            else return { ok: false, message: `Keeper release is unconfirmed: ${e.message}. Reclaim once the broker answers.` };
          } catch { return { ok: false, message: `Keeper release is unconfirmed: ${e.message}. The gate will expire if the desk cannot recover it.` }; }
        }
        if (!r.ok || !r.automated) {
          await proxy(port, '/ungate' + q, { holder });
          return { ok: false, message: `Keeper release failed: ${r.error ?? 'broker did not confirm an attached keeper'}` };
        }
        ctx.desk.nextGateRenew = ctx.now + RENEW_MS; ctx.desk.keeperMissingAt = null;
        ctx.control = 'keeper';
        await observe(ctx, found, true);
        return { ok: true, message: 'Released to the broker keeper. Bots and FleetScripts can run normally; reclaim to play.' };
      }
      if (entry === 'control.take') {
        if (found.session.gate?.holder !== holder) return { ok: false, message: 'This client does not own the keeper gate.' };
        // Establish the pilot hold and stop the keeper before opening native input.
        const r = await callBroker({ action: 'reclaim', ...params(ctx, found) });
        if (!r.ok) return { ok: false, message: r.error ?? 'Broker could not reclaim this client.' };
        const released = await proxy(port, '/ungate' + q, { holder });
        if (!released.ok) return { ok: false, message: released.why ?? released.error };
        ctx.desk.nextGateRenew = null; ctx.keeperRegistered = false; ctx.control = 'none';
        return { ok: true, message: 'Controls are yours again.' };
      }
      return { ok: false, message: `Unknown control entry ${entry}` };
    },
  };
}
export const provider = createControlProvider();
