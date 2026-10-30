// FLEET CLAIMS -- ONE OF US DOES IT, NOT EVERYONE WHO SAW THE NEED.
//
// Twenty keeper processes can each see that an ally lacks Magic Shield, and each would cast it. The claim is how
// exactly one does: whoever creates the claim file for (server, room, key, window) first owns that action for the
// window; everybody else is told no and moves on to the next thing. Same mechanism as m59-heal-claims.mjs (a file
// opened 'wx' is atomic on every platform node runs on), generalised from one heal to any action a pak names.
//
// The KEY is the pak's: it decides what counts as "the same action" (usually spell + target + round). The WINDOW is
// the claim's lifetime: a key claimed in one window can be claimed again in the next, which is how a fizzled cast is
// picked up by somebody else next round rather than never.
//
// A claim we cannot evaluate is NOT a claim granted: any failure answers false, so the worst case is that nobody
// casts this beat, never that everybody does.
import { mkdirSync, openSync, closeSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLAIM_DIR = fileURLToPath(new URL('../substrate/fleet-health/action-claims/', import.meta.url));
export const CLAIM_KEEP_MS = 120_000;

/**
 * Claim `key` in this server's room for the window of `ms` that `now` falls in. true only for the one claimant.
 * scope = { host, port, room }.
 */
export function claimFleetAction(scope, key, { now = Date.now(), ms = 2000, by = null,
  directory = process.env.M59_ACTION_CLAIM_DIR || CLAIM_DIR } = {}) {
  if (!scope?.host || !(Number(scope.port) > 0) || !(Number(scope.room) > 1) || !key) return false;
  if (!(Number.isFinite(ms) && ms > 0)) return false;
  const hash = createHash('sha256').update(JSON.stringify([String(scope.host).toLowerCase(), Number(scope.port),
    Number(scope.room), String(key).toLowerCase()])).digest('hex').slice(0, 32);
  const bucket = Math.floor(now / ms);
  let fd = null;
  try {
    mkdirSync(directory, { recursive: true });
    fd = openSync(join(directory, `${hash}-${ms}-${bucket}.json`), 'wx');
    writeFileSync(fd, JSON.stringify({ at: now, key: String(key), by }));
    closeSync(fd); fd = null;
    sweep(directory, now);
    return true;
  } catch { return false; }
  finally { if (fd != null) try { closeSync(fd); } catch {} }
}

let lastSweep = 0;
/** Drop claim files whose window ended more than CLAIM_KEEP_MS ago. At most once a minute per process. */
function sweep(directory, now) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  try {
    for (const f of readdirSync(directory)) {
      const m = /^[0-9a-f]{32}-(\d+)-(\d+)\.json$/.exec(f);
      if (m && (Number(m[2]) + 1) * Number(m[1]) < now - CLAIM_KEEP_MS) try { unlinkSync(join(directory, f)); } catch {}
    }
  } catch { /* a sweep is housekeeping, never a reason to refuse a claim */ }
}
