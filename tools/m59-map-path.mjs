// One map-selection policy for every broker launch path.
//
// Setup bakes server-matched collision data into a gitignored local artifact. A
// service restart, foreground broker, and diagnostic CLI must all keep using that
// artifact; silently falling back to the portable reference map can make every move
// fail its room-security check after an otherwise healthy restart.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHECKED_MAP_FILE = path.join(REPO, 'substrate', 'm59-map.json');
export const LOCAL_MAP_FILE = path.join(REPO, 'substrate', 'm59-map.local.json');

export function movementMapFile({ explicit = process.env.M59_MAP, exists = existsSync } = {}) {
  if (explicit) return path.resolve(explicit);
  return exists(LOCAL_MAP_FILE) ? LOCAL_MAP_FILE : CHECKED_MAP_FILE;
}

/**
 * WHICH MAP ANSWERED, AND WHETHER THAT ANSWER TRAVELS.
 *
 * The selection above is right and must stay silent for the broker — see the header. But
 * seven #movement SUITES plan on whatever it hands them and then report a bare pass or
 * fail, and those two facts together make a gate that means different things on different
 * machines.
 *
 * MEASURED 2026-09-21, bisected by a peer from 124 live substrate files down to one:
 * `m59-routing-test.mjs` reads 141 passed / 1 failed / 3 skipped on a checkout that has
 * `substrate/m59-map.local.json`, and 158 passed / 0 failed in a fresh worktree at the
 * IDENTICAL COMMIT. The failing assertion is which exit `exits()` offers from a pocket at
 * r1c16, and the two maps genuinely disagree about that pocket.
 *
 * NEITHER VERDICT IS WRONG. The local bake is what this server actually has; the committed
 * reference is what a clone gets. What is wrong is that nothing says which one answered, so
 * the run that reads red here reads green everywhere else and no one can tell why. A gate
 * like that gets ignored, which is worse than one that fails — and it cost two sessions an
 * evening, including a wrong attribution written into two commit messages.
 *
 * Returns the provenance rather than printing it. A resolver with side effects is its own
 * problem: `movementMapFile()` is on every broker launch path and does not need chatter.
 */
export function movementMapProvenance({ explicit = process.env.M59_MAP,
                                        exists = existsSync } = {}) {
  const file = movementMapFile({ explicit, exists });
  const isExplicit = !!explicit;
  const isLocal = !isExplicit && file === LOCAL_MAP_FILE;
  return {
    file,
    kind: isExplicit ? 'explicit' : isLocal ? 'local' : 'committed',
    // TRUE only for the committed reference — the one map another checkout is guaranteed to
    // have. Anything else means a result here cannot be compared with a result there.
    portable: !isExplicit && !isLocal,
    why: isExplicit
      ? `M59_MAP points at ${file}`
      : isLocal
      ? 'substrate/m59-map.local.json is present and the local bake wins, because it carries ' +
        'server-matched collision data the committed reference does not'
      : 'no local bake on this checkout, so the committed reference answered',
  };
}

/**
 * The one line a #movement suite prints before it asserts anything.
 *
 * Quiet when the answer travels, loud when it does not — that asymmetry is the whole point.
 * A committed-reference run is comparable with anybody's; a local or explicit one is this
 * machine's opinion, and CLAUDE.md's rule is that this checkout's opinion does not get to be
 * the shared answer without saying so.
 */
export function announceMovementMap(log = console.log, opts = {}) {
  const p = movementMapProvenance(opts);
  if (p.portable) log(`map: committed reference (${path.basename(p.file)}) — comparable with a fresh clone`);
  else log(`map: ${p.kind.toUpperCase()} OVERRIDE — ${path.basename(p.file)}\n` +
           `     ${p.why}.\n` +
           '     A pass or fail here is NOT comparable with a fresh clone of this commit.');
  return p;
}

// Build/refresh is maintenance, not runtime selection. A bare refresh updates the
// committed reference; an explicit M59_MAP writes exactly there.
export function geometryOutputFile({ explicit = process.env.M59_MAP } = {}) {
  return explicit ? path.resolve(explicit) : CHECKED_MAP_FILE;
}

// A setup-local refresh always starts from the current committed graph. Otherwise an
// old local artifact can preserve obsolete exits forever while only its geometry is
// replaced. Custom explicit map destinations retain their own graph by design.
export function geometryRefreshBaseFile(output, { exists = existsSync } = {}) {
  const resolved = path.resolve(output);
  if (resolved === path.resolve(LOCAL_MAP_FILE)) return CHECKED_MAP_FILE;
  return exists(resolved) ? resolved : CHECKED_MAP_FILE;
}
