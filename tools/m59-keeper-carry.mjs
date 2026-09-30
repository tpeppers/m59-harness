// A CHARACTER'S ASSIGNMENTS OUTLIVE ITS KEEPER PROCESS.
//
// Rolling keepers -- the no-logout handoff (tools/m59-war-restart.mjs, broker `warRestartKeeper`),
// a POST /stop and the 45s sweep, a SIGTERM -- replaces the process that holds the character, and
// everything that process was TOLD lived only in its memory:
//
//   * faculty claims (Autopilot.claims): a FleetScript lease, the DUM bot, a swarm. The new keeper
//     started with none, so until the holder's next heartbeat the keeper took the character back
//     and did its own thing -- and an errand in flight was overwritten.
//   * the busy declaration (Autopilot.busy), which every stall detector steps over.
//   * live POST /policy pushes and the mode: the new process boots from the ROSTER, so an order
//     pushed live (an assigned room, a hunt, a confine) silently reverted.
//
// So the old keeper writes them here the moment it is told it is being replaced, and again as it
// exits; the new one reads them before its first pass. The file is keyed to the ROSTER FILE and the
// agent, beside the roster (substrate/fleets/ is gitignored and so is this), because a carry
// adopted by the wrong fleet's keeper is somebody else's orders.
//
// WHAT IS CARRIED, AND WHAT IS NOT:
//   * a claim or busy lease keeps its own expiry: an expired one is not revived, and a live one is
//     not extended -- the holder still has to heartbeat, exactly as before the roll.
//   * a policy override is carried only if the ROSTER STILL SAYS WHAT IT SAID when the old keeper
//     booted. Editing the roster and rolling keepers to apply it is the normal way to change an
//     order, and a carried override must never undo that. The same rule for `mode`.
//   * nothing older than CARRY_MAX_AGE_MS, and nothing for a different character.
//   * no in-flight journey or combat order: re-issuing movement on somebody's behalf after a
//     restart is a decision, not a memory, and combat watches already persist on their own.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

export const CARRY_FORMAT = 'm59-keeper-carry/1';
export const CARRY_MAX_AGE_MS = 10 * 60_000;

export const carryFile = (fleetPath, agent) =>
  join(dirname(fleetPath), '.keeper-carry', `${basename(fleetPath)}-${agent}.json`);

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * What a keeper was told, relative to what it booted with.
 * `claims` is the Autopilot's Map (faculty -> {owner, until, at, why}); `busy` its object or null.
 */
export function captureCarry({ agent, character, pid, reason, claims, busy, bootPolicy = {}, livePolicy = {},
                               bootMode = null, liveMode = null, now = Date.now() }) {
  const overrides = {};
  for (const k of new Set([...Object.keys(bootPolicy ?? {}), ...Object.keys(livePolicy ?? {})]))
    if (!same(bootPolicy?.[k], livePolicy?.[k])) overrides[k] = { boot: bootPolicy?.[k] ?? null, live: livePolicy?.[k] ?? null };
  return {
    format: CARRY_FORMAT, agent, character, pid, at: now, reason,
    claims: [...(claims?.entries?.() ?? [])].filter(([, c]) => c && c.until > now)
      .map(([faculty, c]) => ({ faculty, owner: c.owner, until: c.until, at: c.at ?? null, why: c.why ?? null })),
    busy: busy && busy.until > now ? { ...busy } : null,
    policy_overrides: overrides,
    mode: same(bootMode, liveMode) ? null : { boot: bootMode, live: liveMode },
  };
}

export function writeCarry(file, carry) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(carry, null, 2));
  renameSync(tmp, file);
}

/** The carry for this character, or null: absent, unreadable, another character, our own, or too old. */
export function readCarry(file, { agent, character, pid = null, now = Date.now(), maxAgeMs = CARRY_MAX_AGE_MS } = {}) {
  if (!existsSync(file)) return null;
  let c;
  try { c = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  if (c?.format !== CARRY_FORMAT || c.agent !== agent) return null;
  if (character && c.character && String(c.character).toLowerCase() !== String(character).toLowerCase()) return null;
  if (pid != null && c.pid === pid) return null;
  if (!(now - Number(c.at) <= maxAgeMs)) return null;
  return c;
}

/** Remove it once adopted, so a later restart does not adopt the same orders twice. */
export function consumeCarry(file) { try { unlinkSync(file); } catch {} }

/** The policy fields and mode to apply at boot: each only where the roster has not moved since. */
export function policyToAdopt(carry, rosterPolicy = {}, rosterMode = null) {
  const fields = {}, skipped = [];
  for (const [k, o] of Object.entries(carry?.policy_overrides ?? {})) {
    if (same(rosterPolicy?.[k], o.boot)) fields[k] = o.live;
    else skipped.push(k);                                  // the roster changed it: the roster wins
  }
  const mode = carry?.mode && same(rosterMode, carry.mode.boot) ? carry.mode.live : null;
  return { fields, mode, skipped };
}

/** Claims and busy still inside their own leases, ready to be set on a fresh Autopilot. */
export function leasesToAdopt(carry, now = Date.now()) {
  const claims = new Map();
  for (const c of carry?.claims ?? [])
    if (c?.faculty && c.until > now) claims.set(c.faculty, { owner: c.owner, until: c.until, at: c.at ?? now, why: c.why ?? null });
  const busy = carry?.busy && carry.busy.until > now && [...claims.values()].some(c => c.owner === carry.busy.by)
    ? { ...carry.busy } : null;                             // busy needs a live claim by the same owner
  return { claims, busy };
}
