// WHICH MACHINES COUNT AS THE OPERATOR'S, BESIDES THIS ONE.
//
//   substrate/operator-access.json   (this machine's; gitignored -- installed from the private
//                                     repository by its access/install.mjs)
//   {
//     "format": "m59-operator-access/1",
//     "listen":    { "addresses": ["100.114.254.65"], "ports": [8901, 8902, 3000] },
//     "operators": [ { "name": "steamdeck", "addresses": ["100.117.223.33"] } ]
//   }
//
// Every admin surface in this repository -- the broker's control API (8901), the fleet pages and
// their buttons (8902), the field command page (3000) -- decides "is the caller the operator" by
// asking whether the socket is loopback. About ten separate copies of that test exist, and every
// one is right to be strict. So nothing here widens them. Instead tools/m59-operator-gateway.mjs
// listens on THIS machine's tailnet address(es), admits only the addresses listed here, and
// forwards to loopback: the surfaces still see a loopback caller, exactly as they do for
// tools/m59-lend.mjs, and there is one gate to read instead of ten.
//
// THE IDENTITY IS THE TAILNET ADDRESS. WireGuard authenticates every packet on a Tailscale
// interface, so a 100.x source address on it is the device the tailnet says it is; nothing else
// is asked for (operator decision, 2026-10-01). A machine that is not listed is refused at the
// socket, before any byte reaches a surface.
//
// WHAT THIS IS NOT FOR: m59-dm.mjs's isLoopbackHost, which asks whether the GAME SERVER is local
// before touching its unauthenticated maintenance port. That is a different question and stays
// strict; nothing in this file is consulted for it.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

const HERE = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const OPERATOR_ACCESS_FILE = () =>
  process.env.M59_OPERATOR_ACCESS_FILE || join(HERE, 'substrate', 'operator-access.json');
export const DEFAULT_PORTS = Object.freeze([8901, 8902, 3000]);

/** The address as the socket reports it, without an IPv4-mapped prefix. */
export const normalizeAddress = a => String(a ?? '').trim().replace(/^::ffff:/i, '').toLowerCase();

export function isLoopbackAddress(a) {
  const n = normalizeAddress(a);
  if (n === '::1') return true;
  return isIP(n) === 4 && n.startsWith('127.');
}

const addressesOf = list => (Array.isArray(list) ? list : [])
  .map(normalizeAddress).filter(a => isIP(a));

/**
 * The config, or null when there is none. Refuses (throws) a file that will not parse, or that
 * names an address that is not an address: an access list read wrongly is worse than no list.
 */
export function loadOperatorAccess(file = OPERATOR_ACCESS_FILE()) {
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (raw?.format !== 'm59-operator-access/1') throw new Error(`${file}: not an m59-operator-access/1 file`);
  const listen = addressesOf(raw.listen?.addresses);
  const bad = (raw.listen?.addresses ?? []).length - listen.length;
  if (bad) throw new Error(`${file}: listen.addresses has ${bad} entr(y/ies) that are not IP addresses`);
  // Never listen on a wildcard or on loopback: the gateway exists to add ONE interface.
  for (const a of listen)
    if (a === '0.0.0.0' || a === '::' || isLoopbackAddress(a))
      throw new Error(`${file}: listen address ${a} is not a single non-loopback interface`);
  const ports = (Array.isArray(raw.listen?.ports) ? raw.listen.ports : DEFAULT_PORTS)
    .map(Number).filter(p => Number.isInteger(p) && p > 0 && p < 65536);
  const operators = (Array.isArray(raw.operators) ? raw.operators : []).map(o => ({
    name: String(o?.name ?? '').trim() || 'unnamed',
    addresses: addressesOf(o?.addresses),
  })).filter(o => o.addresses.length);
  return { file, listen, ports, operators, mtime: statSync(file).mtimeMs };
}

/** Which listed operator this remote address is, or null. Loopback is never "listed": it is local. */
export function operatorFor(cfg, remoteAddress) {
  const a = normalizeAddress(remoteAddress);
  for (const o of cfg?.operators ?? []) if (o.addresses.includes(a)) return o;
  return null;
}
