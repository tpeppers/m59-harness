import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PATCH_MANIFEST_SCHEMA = 'm59-simulation-clock-patch/v1';
export const SERVER_CLOCK_SCHEMA = 'm59-server-clock/v1';
export const SERVER_STATE_SCHEMA = 'm59-sim-server-state/v1';
export const SIMULATION_GUARD_TEXT = 'm59-lab-simulation-clock/v1';
export const PINNED_SOURCE_REPOSITORY = 'https://github.com/tpeppers/Meridian59-deck.git';
export const MIN_SCALE = 1;
export const MAX_SCALE = 100;

export const IMAGE_LABELS = Object.freeze({
  schema: 'org.openai.m59.sim-clock.schema',
  sourceCommit: 'org.openai.m59.sim-clock.source-commit',
  patchSha256: 'org.openai.m59.sim-clock.patch-sha256',
  scale: 'org.openai.m59.sim-clock.scale',
  labOnly: 'org.openai.m59.sim-clock.lab-only',
});

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, '..', '..');
export const DEFAULT_PATCH_DIRECTORY = join(REPOSITORY_ROOT, 'server-patches', 'simulation-clock');

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_SOURCE_PATH = /^blakserv\/[A-Za-z0-9._/-]+$/;
const LAB_ID = /^[a-z][a-z0-9-]{0,31}$/;
const PRODUCTION_LIKE = /prod|production|live/i;

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(record(value, label)).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new Error(`${label} fields must be exactly: ${wanted.join(', ')}`);
}

function artifactName(value, suffix, label) {
  if (typeof value !== 'string' || !SAFE_ARTIFACT_NAME.test(value) || !value.endsWith(suffix) ||
      basename(value) !== value || isAbsolute(value))
    throw new Error(`${label} must be one local ${suffix} artifact name`);
  return value;
}

export function validateScale(value, label = 'scale') {
  const scale = Number(value);
  if (!Number.isSafeInteger(scale) || scale < MIN_SCALE || scale > MAX_SCALE)
    throw new Error(`${label} must be an integer from ${MIN_SCALE} through ${MAX_SCALE}`);
  return scale;
}

export function validateLabId(value) {
  const id = String(value ?? '').trim();
  if (!LAB_ID.test(id))
    throw new Error('--id must start with a lowercase letter and use at most 32 lowercase letters, digits, or dashes');
  if (PRODUCTION_LIKE.test(id))
    throw new Error(`lab instance id ${JSON.stringify(id)} is production-like and is refused`);
  return id;
}

export function parsePatchManifest(source) {
  let manifest;
  try { manifest = typeof source === 'string' ? JSON.parse(source) : source; }
  catch { throw new Error('simulation-clock manifest is not valid JSON'); }
  exactKeys(manifest,
    ['schema', 'source', 'clock_schema', 'guard_text', 'scale', 'patch', 'source_hashes'],
    'simulation-clock manifest');
  exactKeys(manifest.source, ['repository', 'commit'], 'simulation-clock manifest source');
  exactKeys(manifest.scale, ['minimum', 'maximum', 'integer_only'],
    'simulation-clock manifest scale');

  if (manifest.schema !== PATCH_MANIFEST_SCHEMA)
    throw new Error(`unsupported simulation-clock patch schema ${JSON.stringify(manifest.schema)}`);
  if (manifest.clock_schema !== SERVER_CLOCK_SCHEMA)
    throw new Error(`unsupported server clock schema ${JSON.stringify(manifest.clock_schema)}`);
  if (manifest.guard_text !== SIMULATION_GUARD_TEXT)
    throw new Error('simulation-clock guard text does not match this controller');
  if (manifest.source.repository !== PINNED_SOURCE_REPOSITORY)
    throw new Error('simulation-clock source repository does not match this controller');
  if (!HEX_40.test(manifest.source.commit))
    throw new Error('simulation-clock source commit must be a lowercase 40-character SHA-1');
  if (manifest.scale.minimum !== MIN_SCALE || manifest.scale.maximum !== MAX_SCALE ||
      manifest.scale.integer_only !== true)
    throw new Error('simulation-clock scale contract does not match this controller');

  artifactName(manifest.patch, '.patch', 'simulation-clock patch');
  artifactName(manifest.source_hashes, '.sha256', 'simulation-clock source hash manifest');
  return Object.freeze({
    ...manifest,
    source: Object.freeze({ ...manifest.source }),
    scale: Object.freeze({ ...manifest.scale }),
  });
}

export function loadPatchArtifacts(directory = DEFAULT_PATCH_DIRECTORY) {
  const root = resolve(directory);
  let manifestText;
  try { manifestText = readFileSync(join(root, 'manifest.json'), 'utf8'); }
  catch (error) {
    throw new Error(`cannot read simulation-clock manifest (${error?.code ?? 'read failed'})`);
  }
  const manifest = parsePatchManifest(manifestText);
  const patchPath = join(root, manifest.patch);
  const sourceHashesPath = join(root, manifest.source_hashes);
  return Object.freeze({ root, manifest, patchPath, sourceHashesPath });
}

export function parseSourceHashes(source) {
  if (typeof source !== 'string') throw new Error('source hash manifest must be text');
  const lines = source.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length) throw new Error('source hash manifest is empty');
  const seen = new Set();
  const entries = lines.map((line, index) => {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match || !SAFE_SOURCE_PATH.test(match[2]) || match[2].includes('//') ||
        match[2].split('/').includes('..'))
      throw new Error(`invalid source hash manifest line ${index + 1}`);
    if (seen.has(match[2])) throw new Error(`duplicate source hash path ${match[2]}`);
    seen.add(match[2]);
    return Object.freeze({ sha256: match[1], path: match[2] });
  });
  return Object.freeze(entries);
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function verifySourceHashes(sourceRoot, entries) {
  const root = resolve(sourceRoot);
  const failures = [];
  for (const entry of entries) {
    const path = resolve(root, ...entry.path.split('/'));
    if (path !== root && !path.startsWith(root + '\\') && !path.startsWith(root + '/')) {
      failures.push(`${entry.path}: resolves outside source root`);
      continue;
    }
    let actual;
    try { actual = sha256File(path); }
    catch (error) {
      failures.push(`${entry.path}: ${error?.code ?? 'cannot read'}`);
      continue;
    }
    if (actual !== entry.sha256) failures.push(`${entry.path}: sha256 mismatch`);
  }
  if (failures.length)
    throw new Error(`source tree does not match the pinned simulation-clock inputs:\n  ${failures.join('\n  ')}`);
  return true;
}

export function expectedImageLabels({ manifest, patchSha256, scale }) {
  parsePatchManifest(manifest);
  if (!HEX_64.test(String(patchSha256 ?? '')))
    throw new Error('patch sha256 must be a lowercase 64-character digest');
  const checkedScale = validateScale(scale);
  return Object.freeze({
    [IMAGE_LABELS.schema]: SERVER_CLOCK_SCHEMA,
    [IMAGE_LABELS.sourceCommit]: manifest.source.commit,
    [IMAGE_LABELS.patchSha256]: patchSha256,
    [IMAGE_LABELS.scale]: String(checkedScale),
    [IMAGE_LABELS.labOnly]: 'true',
  });
}

export function validateImageLabels(labels, expected) {
  record(labels, 'image labels');
  const wanted = expectedImageLabels(expected);
  for (const [name, value] of Object.entries(wanted)) {
    if (labels[name] !== value)
      throw new Error(`image label ${name} is ${JSON.stringify(labels[name])}, expected ${JSON.stringify(value)}`);
  }
  return wanted;
}

function unsignedDecimal(value, label) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be an unsigned decimal integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds JavaScript's safe integer range`);
  return number;
}

export function parseSimulationClock(output, { expectedScale = null } = {}) {
  const lines = String(output ?? '').split(/\r?\n/).map(line => line.trim())
    .filter(line => line.startsWith('M59_SIM_CLOCK '));
  if (lines.length !== 1)
    throw new Error(`expected exactly one M59_SIM_CLOCK attestation line, got ${lines.length}`);

  const fields = {};
  for (const token of lines[0].slice('M59_SIM_CLOCK '.length).split(/\s+/)) {
    const match = /^([a-z_]+)=([^\s=]+)$/.exec(token);
    if (!match) throw new Error(`malformed simulation-clock attestation token ${JSON.stringify(token)}`);
    if (Object.hasOwn(fields, match[1]))
      throw new Error(`duplicate simulation-clock attestation field ${match[1]}`);
    fields[match[1]] = match[2];
  }
  exactKeys(fields,
    ['schema', 'enabled', 'scale', 'paused', 'sim_ms', 'wall_s', 'timer_late_ms'],
    'simulation-clock attestation');
  if (fields.schema !== SERVER_CLOCK_SCHEMA)
    throw new Error(`server reported unsupported clock schema ${JSON.stringify(fields.schema)}`);
  if (fields.enabled !== '1') throw new Error('server simulation clock is not enabled');
  if (fields.paused !== '0' && fields.paused !== '1')
    throw new Error('server simulation-clock paused field must be 0 or 1');

  const parsed = Object.freeze({
    schema: fields.schema,
    enabled: true,
    scale: validateScale(unsignedDecimal(fields.scale, 'server clock scale'), 'server clock scale'),
    paused: fields.paused === '1',
    sim_ms: unsignedDecimal(fields.sim_ms, 'server simulation time'),
    wall_s: unsignedDecimal(fields.wall_s, 'server wall time'),
    timer_late_ms: unsignedDecimal(fields.timer_late_ms, 'server timer lateness'),
  });
  if (expectedScale != null && parsed.scale !== validateScale(expectedScale, 'expected scale'))
    throw new Error(`server clock scale is ${parsed.scale}, expected ${expectedScale}`);
  return parsed;
}

export function validateServerState(value, { expectedId = null } = {}) {
  exactKeys(value, [
    'schema', 'id', 'container', 'image', 'scale', 'game_port', 'admin_port',
    'source_commit', 'patch_sha256', 'clock_schema', 'created_at',
  ], 'simulation server state');
  if (value.schema !== SERVER_STATE_SCHEMA) throw new Error('unsupported simulation server state schema');
  const id = validateLabId(value.id);
  if (expectedId != null && id !== validateLabId(expectedId))
    throw new Error(`simulation server state belongs to ${JSON.stringify(id)}, not ${JSON.stringify(expectedId)}`);
  if (value.container !== `m59-sim-${id}`) throw new Error('simulation server state container identity is invalid');
  if (typeof value.image !== 'string' || !value.image.trim() || /[\x00-\x1f]/.test(value.image))
    throw new Error('simulation server state image is invalid');
  const scale = validateScale(value.scale, 'simulation server state scale');
  for (const field of ['game_port', 'admin_port']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 1024 || value[field] > 65535)
      throw new Error(`simulation server state ${field} must be a port from 1024 through 65535`);
  }
  if (value.game_port === value.admin_port) throw new Error('simulation server ports must differ');
  if (!HEX_40.test(value.source_commit)) throw new Error('simulation server source commit is invalid');
  if (!HEX_64.test(value.patch_sha256)) throw new Error('simulation server patch digest is invalid');
  if (value.clock_schema !== SERVER_CLOCK_SCHEMA) throw new Error('simulation server clock schema is invalid');
  if (typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at)))
    throw new Error('simulation server created_at is invalid');
  return Object.freeze({ ...value, id, scale });
}
