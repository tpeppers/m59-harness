// Cross-process charge conservation, scoped to endpoint, room and player body.
// Immutable one-second buckets avoid a stale-lock takeover race. A partial
// competing write is treated as claimed, never as permission to spend again.
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const defaultDirectory = () => process.env.M59_FLEET_HEALTH_DIR
  ? join(process.env.M59_FLEET_HEALTH_DIR, 'heal-claims')
  : fileURLToPath(new URL('../substrate/fleet-health/heal-claims/', import.meta.url));
export function claimFleetHeal(identity, options) {
  return claimFleetAid(identity, options);
}

export function claimFleetAid(identity, { room, bodyId, now = Date.now(), directory = defaultDirectory(),
  kind = 'heal', scope = '', cooldownMs = 1000 } = {}) {
  if (!identity?.host || !identity.character || !(identity.port > 0) || !(room > 1) || !(bodyId > 0) || !Number.isFinite(now) || !Number.isInteger(cooldownMs) || cooldownMs < 1000) return false;
  const key = createHash('sha256').update(JSON.stringify([String(identity.host).toLowerCase(), Number(identity.port),
    String(identity.character).trim().toLowerCase(), room, bodyId,
    ...(kind === 'heal' && !scope ? [] : [kind, scope])])).digest('hex');
  const bucket = Math.floor(now / cooldownMs), name = n => join(directory, key + '-' + n + '.json');
  let fd;
  try {
    mkdirSync(directory, { recursive: true });
    fd = openSync(name(bucket), 'wx');
    writeFileSync(fd, JSON.stringify({ at: now })); closeSync(fd); fd = null;
    try {
      const previous = JSON.parse(readFileSync(name(bucket - 1), 'utf8'));
      if (!Number.isFinite(previous.at) || now - previous.at < cooldownMs) return false;
    } catch (e) { if (e.code !== 'ENOENT') return false; }
    // Clean only our own expired claim files; no roster or health reports.
    for (const file of readdirSync(directory)) {
      if (!file.startsWith(key + '-') || !file.endsWith('.json')) continue;
      const age = bucket - Number(file.slice(key.length + 1, -5));
      if (age > 60) try { unlinkSync(join(directory, file)); } catch {}
    }
    return true;
  } catch { return false; }
  finally { if (fd != null) closeSync(fd); }
}
