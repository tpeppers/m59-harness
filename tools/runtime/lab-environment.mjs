// Process-wide environment boundary installed before the Meridian engine is imported.
// Static map/resources remain shared; mutable evidence is kept under the selected lab
// roster so an experiment cannot write production's books and ledgers.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUBSTRATE = fileURLToPath(new URL('../../substrate/', import.meta.url));

const DIRS = Object.freeze({
  M59_RECORD_DIR: 'recordings',
  M59_HITS_DIR: 'hits',
  M59_TRANSIT_DIR: 'transits',
  M59_POSTMORTEM_DIR: 'postmortems',
  M59_LEDGER_DIR: 'ledger',
  M59_STRATEGY_STATS_DIR: 'strategy-stats',
  M59_ABILITY_DIR: 'abilities',
  M59_BANK_DIR: 'bank',
  M59_FACTION_DIR: 'factions',
  M59_RUNLOCK_DIR: 'runlocks',
  M59_SHELTER_DIR: 'shelters',
  M59_TACTICS_DIR: 'tactics',
  M59_TITHE_DIR: 'tithes',
  M59_TOUGHER_DIR: 'tougher',
  M59_TRAILS_DIR: 'trails',
  M59_WALKS_DIR: 'walks',
  M59_TRIPS_DIR: 'trips',
  M59_DESC_DIR: 'descriptions',
  M59_INTEL_DIR: 'intel',
  M59_STORAGE_DIR: 'storage',
});

const FILES = Object.freeze({
  M59_BAD_EXITS: 'm59-badexits.json',
  // Session.rideTrack() calls strikeTrack()/clearStrikes(); the generated track book is
  // read-only in actor mode, but this rejection overlay is rewritten on every outcome.
  M59_TRACK_STRIKES: 'm59-track-strikes.json',
  M59_UPTIME_FILE: 'keeper-uptime.jsonl',
  M59_ACTIVE_FILE: 'keeper-active.json',
  M59_GRUDGE_FILE: 'grudges.json',
  M59_KEEPER_TRACE_FILE: 'keeper-trace.jsonl',
  M59_PREYSIDE_FILE: 'preyside.json',
  M59_SIGNAL_FILE: 'signals.json',
  M59_EXITGAP_FILE: 'exit-gaps.json',
  M59_COLLISION_TRACE_FILE: 'collision-trace.jsonl',
  M59_SCOUT_FILE: 'scouts.json',
});

// Universal movement evidence is useful as a starting point, but every subsequent write
// belongs to the lab. Operator policy/config books remain at their shared read-only paths
// and therefore do not need copying here.
const SEED_DEFAULTS = Object.freeze({
  M59_SAFESPOT_FILE: join(SUBSTRATE, 'm59-safespots.json'),
  M59_BAD_EXITS: join(SUBSTRATE, 'm59-badexits.json'),
  M59_PREYSIDE_FILE: join(SUBSTRATE, 'prey-sides.json'),
  M59_TRACK_STRIKES: join(SUBSTRATE, 'm59-track-strikes.json'),
});

export const LAB_MUTABLE_PATH_KEYS = Object.freeze([
  ...Object.keys(DIRS),
  ...Object.keys(FILES),
  'M59_SAFESPOT_FILE',
]);

function seedSources(env) {
  return Object.fromEntries(Object.entries(SEED_DEFAULTS).map(([key, fallback]) => [
    key,
    typeof env[key] === 'string' && env[key].trim() ? env[key] : fallback,
  ]));
}

function copySeedIfAbsent(source, destination) {
  if (existsSync(destination) || !existsSync(source)) return false;
  if (resolve(source) === resolve(destination)) return false;
  copyFileSync(source, destination);
  return true;
}

export function configureLabEnvironment(selection, env = process.env, { scope = null } = {}) {
  if (!selection?.fleet || !selection?.stateFile)
    throw new TypeError('configureLabEnvironment requires a fleet selection');
  if (scope != null && (typeof scope !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(scope)))
    throw new TypeError('lab environment scope must use 1-64 letters, digits, dash, or underscore');
  const rosterStem = basename(selection.stateFile).replace(/\.json$/i, '');
  const baseRuntimeDir = join(dirname(selection.stateFile), '.lab-runtime', rosterStem);
  // One-process mode retains its historical paths. Shards get independent writer trees:
  // most of these JSON books use replace/pretty-write semantics and are not safe merely
  // because their processes happen to share a parent. Only explicit coordination stores
  // live under the common directory below.
  const runtimeDir = scope == null
    ? baseRuntimeDir
    : join(baseRuntimeDir, 'shards', scope);
  const coordinationDir = join(baseRuntimeDir, 'coordination');
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(coordinationDir, { recursive: true });
  // Capture an operator-supplied baseline before replacing every writable destination.
  const sources = seedSources(env);

  env.M59_FLEET = selection.fleet;
  env.M59_STATE_FILE = selection.stateFile;
  env.M59_RUNTIME_PROFILE = 'lab';
  env.M59_TIME_SCALE = '1';
  // Shared-process actors still need keeper-specific validation/telemetry branches.
  env.M59_KEEPER = '1';
  env.M59_LAB_SHARDED = scope == null ? '0' : '1';
  env.M59_LAB_RUNTIME_DIR = runtimeDir;
  env.M59_LAB_COORDINATION_DIR = coordinationDir;
  env.M59_SPOT_CLAIMS_DIR = join(coordinationDir, 'spot-claims');
  env.M59_SPOT_CLAIMS_NAMESPACE = rosterStem;
  for (const [key, leaf] of Object.entries(DIRS)) env[key] = join(runtimeDir, leaf);
  for (const [key, leaf] of Object.entries(FILES)) env[key] = join(runtimeDir, leaf);

  const safespots = join(runtimeDir, 'm59-safespots.json');
  env.M59_SAFESPOT_FILE = safespots;
  const seeded = [];
  for (const [key, source] of Object.entries(sources)) {
    if (copySeedIfAbsent(source, env[key])) seeded.push(key);
  }
  return Object.freeze({
    baseRuntimeDir,
    runtimeDir,
    coordinationDir,
    scope,
    safespots,
    badExits: env.M59_BAD_EXITS,
    trackStrikes: env.M59_TRACK_STRIKES,
    seeded: Object.freeze(seeded),
  });
}
