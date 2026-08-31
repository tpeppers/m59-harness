#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_PATCH_DIRECTORY,
  IMAGE_LABELS,
  REPOSITORY_ROOT,
  SERVER_CLOCK_SCHEMA,
  SERVER_STATE_SCHEMA,
  expectedImageLabels,
  loadPatchArtifacts,
  parsePatchManifest,
  parseSimulationClock,
  parseSourceHashes,
  sha256File,
  validateImageLabels,
  validateLabId,
  validateServerState,
  verifySourceHashes,
} from './server-clock-contract.mjs';

let assertions = 0;
const ok = (value, message) => { assert.ok(value, message); assertions++; };
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  assertions++;
};
const throws = (fn, pattern, message) => {
  assert.throws(fn, pattern, message);
  assertions++;
};

const artifacts = loadPatchArtifacts(DEFAULT_PATCH_DIRECTORY);
equal(artifacts.manifest.clock_schema, SERVER_CLOCK_SCHEMA);
equal(artifacts.manifest.source.commit, '1fb1f51478d14a2a7fa37a2bb5899899c0115c44');
const entries = parseSourceHashes(readFileSync(artifacts.sourceHashesPath, 'utf8'));
equal(entries.length, 17, 'every touched source file has an independent preimage digest');
ok(/^[0-9a-f]{64}$/.test(sha256File(artifacts.patchPath)));
const patchText = readFileSync(artifacts.patchPath, 'utf8');
ok(!patchText.includes('GetSimulationTime() - 1534000000L'),
  'the Blakod GetTime builtin remains wall time, preserving packet and movement rate checks');
ok(patchText.includes('Reload game is disabled for a simulation-clock server'),
  'the unsafe unpaused reload-game path is explicitly closed');
ok(patchText.includes('Simulation or incompatible save failed validation; refusing to replace it with a new world'),
  'a rejected lab save cannot silently become a fresh world');
ok(patchText.includes('O_RDONLY | O_NOFOLLOW'),
  'the Linux guard cannot be redirected through a symlink');
ok(patchText.includes('SAVE_GAME_SIMULATION_END'),
  'a v2 save requires an explicit end record, so clean truncation is detectable');
ok(patchText.includes('fprintf(stderr,"Fatal Error File %s line %i'),
  'Linux fail-closed diagnostics use a defined format string before exit');

const labDockerfile = readFileSync(join(REPOSITORY_ROOT, 'docker', 'Dockerfile.sim-clock'), 'utf8');
ok(labDockerfile.includes('sha256sum -c /tmp/simulation-clock/source.sha256'),
  'the image build repeats source preimage verification');
ok(labDockerfile.includes("sed -i 's/\\r$//'"),
  'the verified Windows preimages are normalized before the Linux patch is applied');
ok(labDockerfile.includes('org.openai.m59.sim-clock.lab-only="true"'),
  'the image carries an explicit lab-only label');
ok(labDockerfile.includes('GuardFile            /m59/savegame/.m59-simulation-clock.guard'),
  'the image config uses the server-enforced guard path');
const ordinaryDockerfile = readFileSync(join(REPOSITORY_ROOT, 'docker', 'Dockerfile'), 'utf8');
ok(!ordinaryDockerfile.includes('m59-server-clock/v1'),
  'the normal production-compatible image flow has no simulation-clock schema');

const sourceRoot = process.env.M59_ROOT || 'C:/code/Meridian59';
verifySourceHashes(sourceRoot, entries);
assertions++;

const goodLine =
  'M59_SIM_CLOCK schema=m59-server-clock/v1 enabled=1 scale=10 paused=0 ' +
  'sim_ms=1788150123456 wall_s=1788150000 timer_late_ms=4';
const clock = parseSimulationClock(`> show simclock\r\n${goodLine}\r\n> `, { expectedScale: 10 });
equal(clock.scale, 10);
equal(clock.timer_late_ms, 4);
equal(clock.paused, false);
throws(() => parseSimulationClock('nothing here'), /exactly one/, 'absence is not attestation');
throws(() => parseSimulationClock(`${goodLine}\n${goodLine}`), /got 2/, 'ambiguity is refused');
throws(() => parseSimulationClock(goodLine.replace('enabled=1', 'enabled=0')), /not enabled/);
throws(() => parseSimulationClock(goodLine.replace('scale=10', 'scale=9'), { expectedScale: 10 }),
  /scale is 9/);
throws(() => parseSimulationClock(goodLine + ' surprise=1'), /fields must be exactly/);
throws(() => parseSimulationClock(goodLine.replace('sim_ms=1788150123456', 'sim_ms=01')), /unsigned decimal/);
throws(() => parseSimulationClock(goodLine.replace('schema=m59-server-clock/v1', 'schema=v2')), /unsupported/);

const patchSha256 = sha256File(artifacts.patchPath);
const labels = expectedImageLabels({ manifest: artifacts.manifest, patchSha256, scale: 10 });
equal(labels[IMAGE_LABELS.labOnly], 'true');
validateImageLabels({ ...labels, 'org.opencontainers.image.title': 'extra labels are allowed' },
  { manifest: artifacts.manifest, patchSha256, scale: 10 });
assertions++;
throws(() => validateImageLabels({ ...labels, [IMAGE_LABELS.scale]: '1' },
  { manifest: artifacts.manifest, patchSha256, scale: 10 }), /expected "10"/);
throws(() => validateImageLabels({},
  { manifest: artifacts.manifest, patchSha256, scale: 10 }), /image label/);

equal(validateLabId('clock-lab-1'), 'clock-lab-1');
for (const bad of ['Prod', 'production-test', 'livecanary', '../lab', 'UPPER', 'a'.repeat(33)])
  throws(() => validateLabId(bad), /refused|--id/);

const state = {
  schema: SERVER_STATE_SCHEMA,
  id: 'clock-lab-1',
  container: 'm59-sim-clock-lab-1',
  image: 'm59-blakserv-sim:clock-lab-1',
  scale: 10,
  game_port: 15959,
  admin_port: 19998,
  source_commit: artifacts.manifest.source.commit,
  patch_sha256: patchSha256,
  clock_schema: SERVER_CLOCK_SCHEMA,
  created_at: '2026-08-31T12:00:00.000Z',
};
equal(validateServerState(state, { expectedId: 'clock-lab-1' }).container,
  'm59-sim-clock-lab-1');
throws(() => validateServerState({ ...state, id: 'other' }, { expectedId: 'clock-lab-1' }),
  /belongs to/);
throws(() => validateServerState({ ...state, extra: true }), /fields must be exactly/);
throws(() => validateServerState({ ...state, admin_port: 15959 }), /ports must differ/);

const rawManifest = JSON.parse(readFileSync(`${DEFAULT_PATCH_DIRECTORY}/manifest.json`, 'utf8'));
throws(() => parsePatchManifest({ ...rawManifest, schema: 'future' }), /unsupported/);
throws(() => parsePatchManifest({ ...rawManifest, extra: true }), /fields must be exactly/);
throws(() => parseSourceHashes(`${'a'.repeat(64)}  ../outside\n`), /invalid source hash/);
throws(() => parseSourceHashes(
  `${'a'.repeat(64)}  blakserv/time.c\n${'b'.repeat(64)}  blakserv/time.c\n`), /duplicate/);

console.log(`server clock contract: PASS (${assertions} assertions)`);
