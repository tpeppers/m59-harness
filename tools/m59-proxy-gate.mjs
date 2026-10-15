// THE CONTROL GATE: who may steer a character whose client is plugged in through the proxy.
//
// A human watching their character in the dev client and a keeper driving it share ONE
// server connection — the server allows one per character (m59-proxy.mjs header). So
// "the keeper has the controls and you are spectating" cannot be two sessions taking
// turns. It has to be one session where the human's world-changing packets are not
// forwarded while somebody else holds the gate.
//
// Dropping a client packet is not free. Every in-game client packet advances the
// anti-spoof stream on both ends; a packet the server never sees is a step the server
// never takes, so the client's NEXT packet would arrive one step ahead and the server
// would hang up (game.c:184, `seeds_hacked`, once and silently). A gate is therefore
// only legal once the proxy owns the arithmetic — it must have CALIBRATED the stream
// (`session.locked`, which predates this file and means exactly that) and from the first
// drop onward it re-frames every client packet itself. That is what `owned` records.
//
// What passes while gated is an ALLOWLIST, not a blocklist. A new opcode we have never
// thought about is far more likely to be something the character does than something it
// merely asks, and the failure mode of an over-tight allowlist (a menu that does not
// refresh) is much cheaper than an over-loose blocklist (a spectator who can still buy).
//
// Opcode numbers: include/proto.h.
export const GATE_PASS = new Map([
  [2, 'resync'], [3, 'ping'], [4, 'roundtrip1'], [5, 'roundtrip2'], [6, 'system'],
  // LEAVING ALWAYS WORKS. Logging off is how a person hands the character back, and a
  // gate that could trap somebody in a session they want out of is a bug, not a lock.
  [20, 'logoff'], [54, 'req_quit'],
  // Asking for things to be (re)sent changes nothing in the world.
  [40, 'send_player'], [41, 'send_stats'], [42, 'send_room_contents'],
  [43, 'send_object_contents'], [44, 'send_players'], [49, 'send_charinfo'],
  [50, 'send_spells'], [51, 'send_skills'], [52, 'send_stat_groups'], [53, 'send_enchantments'],
  [81, 'req_get_mail'], [85, 'req_articles'], [86, 'req_article'], [88, 'req_lookup_names'],
  [116, 'req_look'], [117, 'req_inventory'],
]);
// Speech is allowed by default and switchable: the broker reads the piloted character's
// own speech as operator verbs (OPERATOR_VERBS), so muting the spectator would also take
// away the one channel they already have for talking to the fleet.
export const GATE_CHAT = new Map([[110, 'say_to'], [111, 'say_group']]);

export function gateRefusal(session) {
  if (!session.inGame) return 'not in game yet';
  if (!session.stream?.seeds) return 'no security seeds seen — the proxy attached after login';
  if (!session.locked) return 'stream not calibrated yet — the client must send a few in-game packets first';
  return null;
}

export function newGate({ holder, reason = '', chat = true, ttl_ms = null } = {}, now = Date.now()) {
  if (!holder || typeof holder !== 'string') throw Error('a gate needs a holder');
  const ttl = ttl_ms == null ? null : Math.max(5_000, Math.min(Number(ttl_ms), 3_600_000));
  return { holder: holder.slice(0, 80), reason: String(reason).slice(0, 200), chat: chat !== false,
           since: now, expires: ttl ? now + ttl : null, dropped: 0, last_dropped: null };
}

// A gate with a lease expires by itself. The holder is another process on another
// clock; one that dies mid-hold must not leave a person locked out of their character.
export function gateLive(gate, now = Date.now()) {
  return !!gate && (gate.expires == null || now < gate.expires);
}

// True when this client->server payload should NOT reach the server.
export function gateDrops(gate, payload, now = Date.now()) {
  if (!gateLive(gate, now) || !payload?.length) return false;
  const op = payload[0];
  if (GATE_PASS.has(op)) return false;
  if (gate.chat && GATE_CHAT.has(op)) return false;
  return true;
}

export function gateView(gate, now = Date.now()) {
  if (!gateLive(gate, now)) return null;
  return { holder: gate.holder, reason: gate.reason, chat: gate.chat, since: gate.since,
           expires: gate.expires, dropped: gate.dropped, last_dropped: gate.last_dropped };
}
