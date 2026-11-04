#!/usr/bin/env node
// Local legacy Kasa bulbs (KL125): UDP discovery, length-prefixed TCP/XOR commands.
// Protocol reference: python-kasa/kasa/transports/xortransport.py and iot/iotbulb.py.
import dgram from 'node:dgram';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export function authenticatedRequest(op, spec, state = null, { env = process.env } = {}) {
  const credentials = spec.credential_file ?? env.M59_KASA_CREDENTIALS ?? resolve(ROOT, 'substrate/kasa-credentials.json');
  if (!existsSync(credentials) && !(env.KASA_USERNAME && env.KASA_PASSWORD)) throw new Error('TP-Link login required: run tools/m59-kasa-setup.ps1 locally');
  const python = env.M59_KASA_PYTHON ?? resolve(ROOT, 'substrate/kasa-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!existsSync(python)) throw new Error('Authenticated Kasa needs python-kasa: run tools/m59-kasa-setup.ps1 locally');
  return new Promise((done, fail) => {
    const child = spawn(python, [fileURLToPath(new URL('./m59-kasa-auth.py', import.meta.url))], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = false;
    const timer = setTimeout(() => { child.kill(); fail(new Error('Authenticated Kasa timed out')); }, 20_000);
    child.on('error', () => { clearTimeout(timer); fail(new Error('Could not start the authenticated Kasa helper')); });
    child.stdout.on('data', b => { output += b; if (output.length > 65536) { error = true; child.kill(); } });
    child.stderr.resume(); // Library diagnostics can include authentication payloads. Never relay them.
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || error) return fail(new Error('Authenticated Kasa helper failed'));
      try { const result = JSON.parse(output); if (result.error) fail(new Error(result.error)); else done(result); }
      catch { fail(new Error('Authenticated Kasa helper returned no valid result')); }
    });
    child.stdin.end(JSON.stringify({ op, spec, state, credentials }));
  });
}

export const LIGHT = 'smartlife.iot.smartbulb.lightingservice';
export function encrypt(value, framed = false) {
  const plain = Buffer.from(JSON.stringify(value)), body = Buffer.alloc(plain.length);
  let key = 171;
  for (let i = 0; i < plain.length; i++) body[i] = key = plain[i] ^ key;
  if (!framed) return body;
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
export function decrypt(body) {
  let key = 171; const plain = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i++) { plain[i] = body[i] ^ key; key = body[i]; }
  return JSON.parse(plain.toString('utf8'));
}
export const macKey = mac => String(mac ?? '').replace(/[:-]/g, '').toLowerCase();
export function bulbInfo(reply, host) {
  const s = reply?.system?.get_sysinfo;
  if (!s || s.err_code || !s.light_state) return null;
  return { host, alias: s.alias, model: s.model, mac: s.mic_mac ?? s.mac, device_id: s.deviceId, light_state: s.light_state };
}
export function broadcastTargets(interfaces = networkInterfaces()) {
  const targets = new Set(['255.255.255.255']);
  for (const list of Object.values(interfaces)) for (const a of list ?? []) {
    if (a.internal || a.family !== 'IPv4') continue;
    const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
    if (mask.every(x => x === 255)) continue;
    targets.add(ip.map((v, i) => v | (255 ^ mask[i])).join('.'));
  }
  return [...targets];
}
export async function discover({ targets = broadcastTargets(), timeoutMs = 2500 } = {}) {
  return new Promise((done, fail) => {
    const socket = dgram.createSocket('udp4'), found = new Map();
    const retries = [];
    const cleanup = () => { clearTimeout(timer); for (const t of retries) clearTimeout(t); socket.close(); };
    const timer = setTimeout(() => { cleanup(); done([...found.values()]); }, timeoutMs);
    socket.on('error', e => { cleanup(); fail(e); });
    socket.on('message', (buf, remote) => {
      try {
        const info = remote.port === 20002
          ? (() => { const s = JSON.parse(buf.subarray(16).toString()).result; return s && { host: remote.address, model: s.device_model, mac: s.mac, protocol: 'authenticated', needs_credentials: true }; })()
          : bulbInfo(decrypt(buf), remote.address);
        if (info) found.set(info.mac ?? info.host, info);
      } catch {}
    });
    socket.bind(0, '0.0.0.0', () => {
      socket.setBroadcast(true);
      const send = () => {
        for (const target of targets) {
          socket.send(encrypt({ system: { get_sysinfo: {} } }), 9999, target);
          socket.send(Buffer.from('020000010000000000000000463cb5d3', 'hex'), 20002, target);
        }
      };
      send();
      for (const fraction of [1 / 3, 2 / 3]) retries.push(setTimeout(send, Math.floor(timeoutMs * fraction)));
    });
  });
}
export async function request(host, value, { port = 9999, timeoutMs = 2000 } = {}) {
  return new Promise((done, fail) => {
    const socket = net.createConnection({ host, port }); let data = Buffer.alloc(0), settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (error) fail(error); else done(result);
    };
    const timer = setTimeout(() => finish(new Error(`Kasa ${host}: timed out`)), timeoutMs);
    socket.on('error', e => finish(e));
    socket.on('end', () => finish(new Error('Kasa closed before a complete reply')));
    socket.on('connect', () => socket.write(encrypt(value, true)));
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 4) return;
      const len = data.readUInt32BE();
      if (len > 128 * 1024) return finish(new Error('Kasa reply exceeds limit'));
      if (data.length < len + 4) return;
      try {
        const reply = decrypt(data.subarray(4, len + 4));
        for (const service of Object.values(reply)) for (const result of Object.values(service ?? {})) {
          if (result?.err_code) throw new Error(`Kasa error ${result.err_code}: ${result.err_msg ?? 'command refused'}`);
        }
        finish(null, reply);
      } catch (e) { finish(e); }
    });
  });
}
export function matchesBulb(info, spec) {
  return !!info && (!spec.mac || macKey(info.mac) === macKey(spec.mac))
    && (!spec.alias || info.alias?.trim().toLowerCase() === spec.alias.trim().toLowerCase())
    && (!spec.model || info.model?.toLowerCase().startsWith(spec.model.toLowerCase()));
}
export async function resolveBulb(spec, { query = request, scan = discover } = {}) {
  if (!spec.alias && !spec.mac) throw new Error('Kasa needs an alias or MAC identity');
  if (spec.protocol === 'authenticated') return authenticatedRequest('read', spec);
  if (spec.host) {
    try {
      const info = bulbInfo(await query(spec.host, { system: { get_sysinfo: {} } }), spec.host);
      if (matchesBulb(info, spec)) return info;
    } catch { /* DHCP may have changed: rediscover, then verify identity. */ }
  }
  const found = await scan();
  const modern = found.filter(info => info.protocol === 'authenticated' && spec.mac && macKey(info.mac) === macKey(spec.mac));
  if (modern.length === 1) return authenticatedRequest('read', { ...spec, host: modern[0].host, protocol: 'authenticated' });
  const matches = found.filter(info => info.light_state && matchesBulb(info, spec));
  if (matches.length !== 1) throw new Error(`Kasa ${spec.alias ?? spec.mac}: ${matches.length ? 'ambiguous discovery' : 'not found on the local network'}`);
  return matches[0];
}
export function checkLight(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['then.kasa needs an object'];
  if (!(typeof spec.alias === 'string' && spec.alias.trim()) && !/^[a-f0-9]{12}$/i.test(macKey(spec.mac))) errors.push('then.kasa needs an alias or MAC');
  if (spec.mac && !/^[a-f0-9]{12}$/i.test(macKey(spec.mac))) errors.push('then.kasa MAC must contain 12 hexadecimal digits');
  for (const [key, max, min] of [['hue', 360, 0], ['saturation', 100, 0], ['brightness', 100, 1]]) {
    if (spec[key] != null && (!Number.isInteger(spec[key]) || spec[key] < min || spec[key] > max)) errors.push(`then.kasa ${key} must be ${min}..${max}`);
  }
  if (spec.clear != null && !['restore', 'leave'].includes(spec.clear)) errors.push('then.kasa clear must be restore or leave');
  if (spec.protocol != null && !['legacy', 'authenticated'].includes(spec.protocol)) errors.push('then.kasa protocol must be legacy or authenticated');
  for (const key of ['alias', 'model', 'host', 'credential_file']) if (spec[key] != null && typeof spec[key] !== 'string') errors.push(`then.kasa ${key} must be text`);
  return errors;
}
export const redState = spec => ({ on_off: 1, hue: spec.hue ?? 0, saturation: spec.saturation ?? 100, brightness: spec.brightness ?? 100, color_temp: 0 });
export function restorableLight(state) {
  const source = state.on_off === 0 ? { ...state.dft_on_state, on_off: 0 } : state;
  return Object.fromEntries(['on_off', 'hue', 'saturation', 'brightness', 'color_temp', 'mode'].filter(k => source[k] != null).map(k => [k, source[k]]));
}
export async function setLight(info, state, { query = request } = {}) {
  if (info.protocol === 'authenticated') return authenticatedRequest('set', info, state);
  const reply = await query(info.host, { [LIGHT]: { transition_light_state: { ignore_default: 1, transition_period: 0, ...state } } });
  if (reply?.[LIGHT]?.transition_light_state?.err_code !== 0) throw new Error('Kasa did not acknowledge light change');
  const after = bulbInfo(await query(info.host, { system: { get_sysinfo: {} } }), info.host);
  if (!after || macKey(after.mac) !== macKey(info.mac)) throw new Error('Kasa identity changed during read-back');
  const actual = restorableLight(after.light_state);
  if (Object.entries(state).some(([k, v]) => k !== 'mode' && !(state.color_temp && ['hue', 'saturation'].includes(k)) && actual[k] !== v)) throw new Error('Kasa light state did not read back');
  return after;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), [cmd = 'discover'] = args;
    const value = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
    if (cmd === 'discover') console.log(JSON.stringify(await discover(), null, 2));
    else if (cmd === 'status' || cmd === 'test') {
      const spec = Object.fromEntries(['alias', 'mac', 'host', 'protocol', 'model'].map(k => [k, value(k)]).filter(([, v]) => v));
      const errors = checkLight(spec); if (errors.length) throw new Error(errors.join('; '));
      const info = await resolveBulb(spec);
      if (cmd === 'status') console.log(JSON.stringify(info, null, 2));
      else {
        const before = restorableLight(info.light_state);
        try { await setLight(info, redState({})); console.log('Red verified; restoring the previous light setting.'); }
        finally { await setLight(info, before); }
        console.log('Previous light setting verified. No fleet orders were sent.');
      }
    } else throw new Error('usage: node tools/m59-kasa.mjs discover | status|test --alias <name> [--mac <mac>] [--host <ip>] [--protocol authenticated]');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
