import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolveFleet } from './m59-fleetpath.mjs';
import { hometownFrom, callTool } from './m59-describe.mjs';

// Beside the exact roster, so identically named characters on other servers cannot mix.
export const hometownDir = (stateFile = resolveFleet().stateFile) => stateFile + '.hometowns';
const fileFor = (dir, character) => path.join(dir, createHash('sha256').update(character).digest('hex') + '.json');
export function readHometown(character, { dir = hometownDir() } = {}) {
  try {
    const record = JSON.parse(fs.readFileSync(fileFor(dir, character), 'utf8'));
    if (record.character !== character || !record.current || !Array.isArray(record.changes)) return null;
    const parsed = hometownFrom(record.current.said);
    if (!parsed || parsed.town !== record.current.town || parsed.room !== record.current.room) return null;
    return record;
  } catch { return null; }
}
export function recordHometown(character, extra, { dir = hometownDir(), at = Date.now() } = {}) {
  const home = hometownFrom(extra);
  // Missing/unrecognised replies never erase a confirmed reading.
  if (!character || !home) return null;
  const old = readHometown(character, { dir });
  if (old && old.checked_at > at) return old;
  const changed = !old || old.current.town !== home.town || old.current.room !== home.room;
  const record = { character, current: home, checked_at: at,
    changed_at: changed ? at : old.changed_at,
    changes: changed ? [...(old?.changes || []), { ...home, at }] : old.changes };
  fs.mkdirSync(dir, { recursive: true });
  const file = fileFor(dir, character), tmp = file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n'); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return record;
}
export function hometownRoster(stateFile = resolveFleet().stateFile) {
  const roster = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return Object.entries(roster).flatMap(([agent, entry]) => entry?.credentials?.character
    ? [{ agent, character: entry.credentials.character }] : []);
}
// Explicit observation only. No speech, travel, rescue casts, or hometown assignment.
export async function refreshHometowns({ stateFile = resolveFleet().stateFile, port = 8901,
  force = false, call = (name, args) => callTool(name, args, { port }) } = {}) {
  const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
  if (!health.state || path.resolve(health.state).toLowerCase() !== path.resolve(stateFile).toLowerCase())
    throw new Error('Broker roster does not match the requested fleet');
  const results = [], dir = hometownDir(stateFile), roster = hometownRoster(stateFile);
  const observers = new Map();
  for (const row of roster) {
    const needsCheck = force || !readHometown(row.character, { dir });
    try {
      const status = await call('status', { agent: row.agent });
      if (status.character !== row.character) throw new Error('Character identity did not match');
      if (status.connected === false || status.in_game === false)
        throw new Error('No connected automated session; needs an observer');
      const scene = (await call('scene_capture', { agent: row.agent })).scene;
      for (const actor of scene?.actors ?? []) {
        if (actor.kind !== 'player' || !Number.isInteger(actor.object_at_capture)) continue;
        const sightings = observers.get(actor.name) ?? [];
        sightings.push({ agent: row.agent, id: actor.object_at_capture });
        observers.set(actor.name, sightings);
      }
      if (!needsCheck) continue;
      const self = scene?.actors?.find(a => a.mine && a.name === row.character);
      const id = self?.object_at_capture ?? status.you?.id;
      if (!Number.isInteger(id) || id <= 0) throw new Error('No live self object id');
      const look = await call('look_at', { agent: row.agent, target: id });
      if (look.id !== id || !look.is_player || !look.editable) throw new Error('No confirmed self-look reply');
      const saved = recordHometown(row.character, look.extra, { dir });
      results.push({ ...row, hometown: saved?.current ?? null, checked: !!saved });
    } catch (e) { if (needsCheck) results.push({ ...row, checked: false, error: e.message }); }
  }
  // A human keeps their connection. A connected fleetmate can look at them only
  // when a fresh scene proves the exact named player is in the same room.
  for (const result of results.filter(r => !r.checked)) {
    for (const observer of observers.get(result.character) ?? []) {
      if (observer.agent === result.agent) continue;
      try {
        const scene = (await call('scene_capture', { agent: observer.agent })).scene;
        const actor = scene?.actors?.find(a => a.kind === 'player' && a.name === result.character);
        if (!actor || !Number.isInteger(actor.object_at_capture)) continue;
        const look = await call('look_at', { agent: observer.agent, target: actor.object_at_capture });
        if (look.id !== actor.object_at_capture || !look.is_player) continue;
        const saved = recordHometown(result.character, look.extra, { dir });
        if (!saved) continue;
        Object.assign(result, { hometown: saved.current, checked: true, observed_by: observer.agent });
        delete result.error;
        break;
      } catch { /* Keep the gap explicit if a player zones before the look arrives. */ }
    }
  }
  return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const portIndex = process.argv.indexOf('--port');
  refreshHometowns({ force: process.argv.includes('--refresh'),
    port: Number(portIndex < 0 ? process.env.M59_BROKER_PORT || 8901 : process.argv[portIndex + 1]) })
    .then(rows => { console.log(JSON.stringify(rows, null, 2)); if (rows.some(r => !r.checked)) process.exitCode = 1; })
    .catch(e => { console.error(e.message); process.exitCode = 1; });
}
