// THE SERVER'S OPCODE TOKEN: what a proxy must track to read, or add to, a real client's stream.
//
// blakserv XORs the opcode byte of every message it sends with a per-session `secure_token`
// (commcli.c:162) and then walks the token along a "redbook" string, one character per message
// (commcli.c:164-177). The token is 0 and the walk is off until the client sends BP_PING: the
// server answers with BP_ECHO_PING [op][token ^ 0xED][redbook rsc id u32] and adopts the new token
// from the NEXT message on, starting the walk at the redbook's first character (game.c:370-402).
// The client mirrors this exactly (clientd3d/server.c DesecureByServerToken, HandleEchoPing).
//
// The harness's own client never pings, so its stream stays at token 0 and reads plainly
// (m59-client.mjs, the keepalive note). A real client pings every few seconds. So on a real
// client's connection:
//
//   - a keeper attached to it (spectate) read scrambled opcodes, acted on garbage, and the
//     session fell into resync and the character-select screen (2026-10-15, char.dll crash);
//   - the proxy's own parsing (BP_PLAYER, room contents, the trade view) misread messages;
//   - anything the proxy ADDED for the client (a mirrored move) or SWALLOWED (an automated
//     trade's window) shifted the client's walk by one, and every later message decoded wrong.
//
// So a proxy keeps TWO of these: one decoding what the server sent, one encoding what the client
// receives. They are byte-identical until the proxy forges or swallows a message, and both adopt
// the same new token from the next BP_ECHO_PING. The walk advances on the message that CARRIES
// the new token before it takes effect, on both ends, and `step` reproduces that order.

import { join } from 'node:path';
import { ResourceTable } from './m59-rsc.mjs';

export const BP_ECHO_PING = 1;
export const DEFAULT_REDBOOK = 'BLAKSTON: Greenwich Q Zjiria';   // both ends' fallback (game.c, server.c)

// The client looks the redbook up in ITS OWN resource files (server.c UpdateSecurityRedbook), and an
// id it cannot find means the default string, so the client's resource directory is the one that
// agrees with the client.
const RSC_DIRS = [process.env.M59_CLIENT_RSC_DIR, 'C:/code/Meridian59/run/localclient/resource',
  process.env.M59_ROOT && join(process.env.M59_ROOT, 'run/localclient/resource')].filter(Boolean);
let table = null;
export function clientRsc(id) {
  if (!table) { table = new ResourceTable(); for (const d of RSC_DIRS) { try { table.loadDir(d); } catch { /* absent */ } if (table.size) break; } }
  return table.map.get(id) ?? null;
}

export class OpcodeToken {
  constructor({ lookup = clientRsc } = {}) { this.lookup = lookup; this.token = 0; this.book = null; this.pos = 0; }

  // The step both ends take after XORing one message, given that message's PLAIN bytes.
  step(plain) {
    if (this.book) {
      this.token = (this.token + (this.book.charCodeAt(this.pos) & 0x7f)) & 0xff;
      if (++this.pos >= this.book.length) this.pos = 0;
    }
    if (plain[0] === BP_ECHO_PING && plain.length >= 6) {
      this.token = (plain[1] ^ 0xed) & 0xff;
      const id = plain.readUInt32LE(2);
      this.book = (id && this.lookup(id)) || DEFAULT_REDBOOK;
      this.pos = 0;
    }
  }

  // Server bytes -> what a token-0 reader expects.
  decode(wire) {
    if (!wire.length) return wire;
    const plain = Buffer.from(wire); plain[0] ^= this.token;
    this.step(plain);
    return plain;
  }

  // Plain bytes -> what this end's reader will decode back to them.
  encode(plain) {
    if (!plain.length) return plain;
    const wire = Buffer.from(plain); wire[0] ^= this.token;
    this.step(plain);
    return wire;
  }
}
