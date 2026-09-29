// Retain incoming fleet communications independently of chat and reply policy.
import { mkdirSync, appendFileSync, readdirSync, readFileSync, statSync, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { evidenceDirFor } from './m59-fleetpath.mjs';
import { OF, stripCodes } from './m59-parse.mjs';

// Incoming communications, captured at receipt independently of chat/reply policy.
// One append-only file per receiver and UTC day; no automatic expiry. The roster's
// absolute path scopes fleets even when their character names or fleet labels match.
export function communicationsDirFor(stateFile, env = process.env) {
  if (!stateFile) throw new Error('communication archive requires an explicit fleet state file');
  let identity = resolve(stateFile);
  if (process.platform === 'win32') identity = identity.toLowerCase();
  return join(evidenceDirFor(env), 'communications', digest(identity));
}
const digest = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
const speech = new Set(['say', 'yell', 'broadcast', 'group', 'emote', 'group-one', 'dm', 'guild']);
export const SOURCE_TYPES = ['player', 'npc', 'system', 'unknown'];
export const PLAYER_COMMUNICATION_CHANNELS = ['dm', 'say', 'broadcast', 'yell', 'emote'];
export const retainedPlayerCommunication = row => row.source === 'player' && PLAYER_COMMUNICATION_CHANNELS.includes(row.channel);
const senderName = value => stripCodes(String(value ?? '')).trim().toLowerCase();
const fleetSenderCache = new Map();

// Fleet membership comes from the complete roster, not just online/bot-controlled
// sessions. Cache only names, never account credentials. Refresh on roster changes.
export function fleetCommunicationSenders(stateFile) {
  if (!stateFile) throw new Error('sender exclusion requires an explicit fleet state file');
  const path = resolve(stateFile), stat = statSync(path, {bigint:true});
  const revision = `${stat.mtimeNs}:${stat.size}`;
  const cached = fleetSenderCache.get(path);
  if (cached?.revision === revision) return cached.names;
  const roster = JSON.parse(readFileSync(path, 'utf8'));
  if (!roster || typeof roster !== 'object' || Array.isArray(roster)) throw new Error('invalid fleet roster for communication sender exclusion');
  const names = new Set(Object.values(roster).map(entry => senderName(entry?.credentials?.character)).filter(Boolean));
  fleetSenderCache.set(path, {revision, names});
  return names;
}


export function communicationSource(ev, c) {
  if (ev.kind === 'message') return { source: 'system', evidence: 'server-message' };
  // A handle can be recycled: a current name must agree before trusting its flags.
  const obj = c.room?.objects?.get(ev.speaker);
  const objName = obj && c.rsc?.get(obj.nameRsc);
  if (obj && objName && objName === ev.name) {
    return { source: obj.flags & OF.PLAYER ? 'player' : 'npc', evidence: 'room-object-flags' };
  }
  const online = c.playersOnline?.get(ev.speaker);
  if (online?.name && online.name === ev.name)
    return { source: 'player', evidence: 'online-player' };
  if (speech.has(ev.type)) return { source: 'player', evidence: 'speech-channel' };
  // Resource/message speech may come from a sign as well as an NPC. Absence from
  // the online roster is never proof of being an NPC.
  return { source: 'unknown', evidence: 'unresolved-speaker' };
}

export class CommunicationsArchive {
  constructor({ stateFile, agent, env, onError = e => console.error('[communications] ' + e.message) }) {
    this.dir = communicationsDirFor(stateFile, env);
    this.stateFile = stateFile;
    this.agent = agent;
    this.writer = randomUUID();
    this.seq = 0;
    this.onError = onError;
    this.errors = 0;
    this.lastErrorAt = null;
    this.lastReceivedAt = null;
    this.readyDay = null;
  }
  record(ev, c) {
    if (ev.kind !== 'said' || !PLAYER_COMMUNICATION_CHANNELS.includes(ev.type)) return null;
    const source = communicationSource(ev, c);
    if (source.source !== 'player') return null;
    if (ev.kind === 'said' && ((c.selfId != null && ev.speaker === c.selfId) ||
        (c.me?.name && ev.name === c.me.name))) return null;
    try {
      if (fleetCommunicationSenders(this.stateFile).has(senderName(ev.name))) return null;
      const at = Number.isFinite(ev.at) ? ev.at : Date.now();
      const day = new Date(at).toISOString().slice(0, 10);
      const row = {
        version: 1, id: `${this.writer}:${++this.seq}`, at,
        agent: this.agent, recipient: c.me?.name ?? c.wantName ?? this.agent,
        sender: ev.name ?? null, speaker_handle: ev.speaker ?? null,
        ...source, channel: ev.kind === 'said' ? ev.type : 'system',
        text: ev.text ?? '', host: c.host, port: c.port,
        ...(ev.transport ? {transport:ev.transport,connection_id:ev.connection_id,decoded:ev.decoded,
          ...(ev.decoded === false ? {packet_hex:ev.packet_hex} : {})} : {}),
      };
      const folder = join(this.dir, day);
      if (this.readyDay !== day) {
        mkdirSync(folder, { recursive: true });
        this.readyDay = day;
      }
      // Prefix a newline as well: a partial final write after a crash cannot swallow
      // the next valid record. Readers report malformed lines and keep going.
      appendFileSync(join(folder, `${digest(this.agent)}.jsonl`), '\n' + JSON.stringify(row) + '\n', { mode: 0o600 });
      this.lastReceivedAt = at;
      return row;
    } catch (e) {
      this.readyDay = null;
      this.errors++;
      this.lastErrorAt = Date.now();
      // Logging a failure must never stop the character's packet handler.
      try { this.onError(e); } catch {}
      return null;
    }
  }
}

export function communicationFilters(params = new URLSearchParams(), now = Date.now()) {
  const day = params.get('date') || new Date(now).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day)
    throw new Error('date must be a valid YYYY-MM-DD (UTC)');
  const requestedSource = params.get('source');
  if (requestedSource && requestedSource !== 'all' && !SOURCE_TYPES.includes(requestedSource)) throw new Error('invalid source filter');
  const source = 'player';
  const offset = Number(params.get('offset') || 0);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid page offset');
  return { day, source, recipient: params.get('recipient') || '', sender: params.get('sender') || '',
    channel: params.get('channel') || '', q: params.get('q') || '', offset, limit: 200 };
}

export async function readCommunications({ dir, stateFile = null, day, source = 'all', recipient = '', sender = '', channel = '', q = '', offset = 0, limit = 200 }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('invalid archive date');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0)
    throw new Error('invalid archive pagination');
  const fleetSenders = stateFile ? fleetCommunicationSenders(stateFile) : new Set();
  const folder = join(dir, day);
  let files;
  try { files = readdirSync(folder).filter(f => /^[a-f0-9]{24}\.jsonl$/.test(f)).sort(); }
  catch (e) { if (e.code === 'ENOENT') files = []; else throw e; }
  const counts = Object.fromEntries(SOURCE_TYPES.map(s => [s, 0]));
  const recipients = new Set(), channels = new Set();
  const rows = [];
  let total = 0, malformed = 0;
  const includes = (a, b) => String(a ?? '').toLowerCase().includes(b.toLowerCase());
  // Streaming keeps a busy fleet's system text from loading an entire day into RAM.
  // Stable file/receipt order makes every receipt reachable without heuristic dedupe.
  for (const file of files) {
    const input = createReadStream(join(folder, file), { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let row;
        try {
          row = JSON.parse(line);
          if (row.version !== 1 || !SOURCE_TYPES.includes(row.source) || typeof row.text !== 'string' || !Number.isFinite(row.at)) throw new Error('invalid record');
        } catch { malformed++; continue; }
        // Also hide historical noise written by earlier releases, before pagination.
        if (!retainedPlayerCommunication(row) || fleetSenders.has(senderName(row.sender))) continue;
        counts[row.source]++;
        recipients.add(row.recipient);
        channels.add(row.channel);
        if (source !== 'all' && row.source !== source || recipient && row.recipient !== recipient ||
            sender && !includes(row.sender, sender) || channel && row.channel !== channel ||
            q && !includes(stripCodes(row.text), q)) continue;
        if (total >= offset && rows.length < limit) rows.push(row);
        total++;
      }
    } finally { lines.close(); input.destroy(); }
  }
  return { day, total, counts, malformed, rows, recipients: [...recipients].sort(), channels: [...channels].sort(),
    offset, limit, next_offset: offset + rows.length < total ? offset + rows.length : null };
}
