#!/usr/bin/env node
// ATTACH AN MCP CLIENT TO THE BROKER THAT ALREADY HOLDS THE FLEET.
//
// `m59-broker.mjs` with no arguments serves MCP over stdio AND calls resumeFleet(),
// which tries to take substrate/fleet-state.json.lock. That is right when the stdio
// broker IS the fleet. It is wrong when one is already running: an MCP client
// configured to spawn the broker gets a SECOND process. Older brokers discovered the
// lock conflict after opening their transport and could serve a healthy-looking empty
// fleet. Current brokers atomically claim fleet and account ownership first, so the
// second process exits with status 3 before its listener opens. Either way, spawning a
// broker is not attaching to the process that owns the characters.
//
// This is the transport for that case: line-delimited MCP on stdio, forwarded to the
// broker's HTTP JSON-RPC port. It holds no sessions, resumes nothing and takes no
// lock, so it can never be the second owner.
//
//   node tools/m59-mcp-attach.mjs [--port 8901] [--host 127.0.0.1]
import process from 'node:process';

const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const HOST = arg('--host', process.env.M59_BROKER_HOST || '127.0.0.1');
const PORT = Number(arg('--port', process.env.M59_BROKER_PORT || 8901));
const URL_ = `http://${HOST}:${PORT}/`;

// A tool call can be a long walk across the world; the pacer runs at one action a
// second and travel is measured in minutes. No timeout here — the broker decides when
// it is done, and cutting it off would leave the character mid-errand.
// BORROWED CHARACTERS COME THROUGH HERE TOO. With `--token` this attaches to somebody
// else's `m59-lend.mjs` instead of a local broker, and the characters their grant covers
// appear as ordinary tools — that is the whole of "their fleet, in mine". The token is a
// revocable capability, never a password; see tools/m59-handoff.mjs.
//
// Taken from the environment as well as the flag, because a token on a command line ends
// up in the shell history and in `ps` output on a shared machine.
const TOKEN = arg('--token', process.env.M59_GRANT_TOKEN || '');

async function forward(msg) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify(msg),
  });
  if (res.status === 202) return null;             // notification, no body
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

// The broker is a separate process that can be restarted underneath us. Report that
// as a tool error the model can read and act on, rather than killing the transport.
const unreachable = (id, e) => id === undefined ? null : {
  jsonrpc: '2.0', id,
  result: {
    content: [{ type: 'text', text:
      `error: cannot reach the m59 broker at ${URL_} (${e.message}). ` +
      `Is it running? Start it with: node tools/m59-broker.mjs --http ${PORT} --dashboard 8902` }],
    isError: true,
  },
};

// Forwarding is async and stdin can end while a call is still in flight. Exiting on
// `end` alone loses the reply that was already on its way — the client sees a server
// that closed mid-handshake. Count what is outstanding and leave when it is drained.
// ONE PUMP, STRICTLY SERIAL, AND IT ONLY LEAVES WHEN THE BUFFER IS EMPTY.
//
// The obvious shape — an async `data` handler plus `exit()` on `end` — drops
// messages. Piped stdin ends while the first call is still awaiting, so the drain
// check fires the moment that one call returns and the lines still sitting in the
// buffer are never read. Draining has to mean "no complete line left", not "nothing
// currently in flight".
let buf = '', ended = false, pumping = false;

async function handleOne(msg) {
  // Answer `initialize` locally so the client still comes up when the broker is
  // down — otherwise the MCP handshake fails and none of the tools are ever listed,
  // which hides the real problem behind "server failed to start".
  if (msg.method === 'initialize') {
    let info = { name: 'meridian59', version: '0' };
    let protocolVersion = '2024-11-05';
    try {
      const up = await forward(msg);
      if (up?.result) { info = up.result.serverInfo ?? info; protocolVersion = up.result.protocolVersion ?? protocolVersion; }
    } catch { /* broker down; still complete the handshake */ }
    return { jsonrpc: '2.0', id: msg.id,
             result: { protocolVersion, capabilities: { tools: {} },
                       serverInfo: { ...info, name: `${info.name} (attached ${HOST}:${PORT})` } } };
  }
  try { return await forward(msg); }
  catch (e) { return unreachable(msg.id, e); }
}

async function pump() {
  if (pumping) return;
  pumping = true;
  for (;;) {
    const nl = buf.indexOf('\n');
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const out = await handleOne(msg);
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  }
  pumping = false;
  if (ended) process.exit(0);
}

process.stdin.on('data', chunk => { buf += chunk; pump(); });
process.stdin.on('end', () => { ended = true; if (!pumping) pump(); });
console.error(`m59 mcp attach -> ${URL_} (no sessions held here, no lock taken)`);
