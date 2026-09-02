#!/usr/bin/env node
// Build the source-pinned, lab-only simulation-clock server image.
//
// `--check` is deliberately the default and never calls Docker. `--build` is an
// explicit operator boundary: it repeats every source/patch/schema check, builds
// the separate Dockerfile, then reads the labels back from the resulting image.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  REPOSITORY_ROOT,
  loadPatchArtifacts,
  parseSourceHashes,
  sha256File,
  validateImageLabels,
  validateScale,
  verifySourceHashes,
} from './runtime/server-clock-contract.mjs';

export const HELP = `Usage:
  node tools/m59-sim-server-build.mjs --check [options]
  node tools/m59-sim-server-build.mjs --build [options]

Options:
  --source PATH   Meridian59 source checkout (M59_ROOT or C:/code/Meridian59)
  --scale N       fixed simulation scale for this image (default 10, max 100)
  --tag IMAGE     output image tag (generated from the verified inputs by default)
  --help          show this text

This command never starts a container. The ordinary docker/Dockerfile is not used or changed.
`;

const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?$/;

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (value == null || String(value).startsWith('--')) throw new Error(`${flag} needs a value`);
  return String(value);
}

export function parseBuildArgs(argv = process.argv.slice(2), env = process.env) {
  const out = {
    action: null,
    source: env.M59_ROOT || 'C:/code/Meridian59',
    scale: 10,
    tag: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') { out.help = true; continue; }
    if (flag === '--check' || flag === '--build') {
      const action = flag.slice(2);
      if (out.action && out.action !== action) throw new Error('--check and --build are mutually exclusive');
      out.action = action;
      continue;
    }
    if (flag === '--source') { out.source = valueAfter(argv, index++, flag); continue; }
    if (flag === '--scale') { out.scale = valueAfter(argv, index++, flag); continue; }
    if (flag === '--tag') { out.tag = valueAfter(argv, index++, flag); continue; }
    throw new Error(`unknown option ${flag}`);
  }
  if (out.help) return Object.freeze(out);
  out.action ??= 'check';
  out.source = resolve(out.source);
  out.scale = validateScale(out.scale, '--scale');
  if (out.tag != null && !IMAGE_REFERENCE.test(out.tag))
    throw new Error('--tag must be one lowercase Docker repository name with an optional valid tag');
  return Object.freeze(out);
}

function run(executable, args, {
  cwd = REPOSITORY_ROOT, stdio = 'pipe', timeout = 30000, trim = true,
} = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', stdio, timeout });
  if (result.error) throw new Error(`${executable} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(-1000);
    throw new Error(`${executable} ${args[0] ?? ''} failed with exit ${result.status}${detail ? `:\n${detail}` : ''}`);
  }
  const output = String(result.stdout || '');
  return trim ? output.trim() : output;
}

function git(source, args, options) {
  const safe = source.replaceAll('\\', '/');
  return run('git', ['-c', `safe.directory=${safe}`, '-C', source, ...args], options);
}

function assertSourceWorktreeSafe(source) {
  const status = git(source, ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { trim: false });
  if (!status) return;
  const unsafe = status.split('\0').filter(Boolean).filter(line => {
    const path = line.slice(3).split(' -> ').at(-1).replaceAll('\\', '/');
    // This directory is excluded by the pinned source .dockerignore and is the
    // only known local edit in the source checkout used to author this artifact.
    return !path.startsWith('run/localclient/');
  });
  if (unsafe.length)
    throw new Error(`source checkout has build-visible changes; refusing an unrepeatable image:\n  ${unsafe.join('\n  ')}`);
}

export function preflightBuild(config) {
  if (!existsSync(config.source)) throw new Error(`source checkout does not exist: ${config.source}`);
  const artifacts = loadPatchArtifacts();
  const { manifest } = artifacts;

  const head = git(config.source, ['rev-parse', 'HEAD']);
  if (head !== manifest.source.commit)
    throw new Error(`source HEAD is ${head || '(unknown)'}, expected ${manifest.source.commit}`);
  const origin = git(config.source, ['remote', 'get-url', 'origin']);
  if (origin !== manifest.source.repository)
    throw new Error(`source origin is ${JSON.stringify(origin)}, expected ${JSON.stringify(manifest.source.repository)}`);
  assertSourceWorktreeSafe(config.source);

  const entries = parseSourceHashes(readFileSync(artifacts.sourceHashesPath, 'utf8'));
  verifySourceHashes(config.source, entries);
  const patchSha256 = sha256File(artifacts.patchPath);
  git(config.source, [
    'apply', '--check', '--whitespace=error-all', artifacts.patchPath.replaceAll('\\', '/'),
  ]);

  const tag = config.tag ||
    `m59-blakserv-sim:${config.scale}x-${manifest.source.commit.slice(0, 12)}-${patchSha256.slice(0, 12)}`;
  return Object.freeze({
    source: config.source,
    scale: config.scale,
    tag,
    artifacts,
    patchSha256,
    sourceFiles: entries.length,
  });
}

function inspectImageLabels(image) {
  const raw = run('docker', ['image', 'inspect', '--format', '{{json .Config.Labels}}', image],
    { timeout: 30000 });
  try { return JSON.parse(raw); }
  catch { throw new Error('docker returned malformed image label JSON'); }
}

export function buildImage(checked) {
  const dockerfile = resolve(REPOSITORY_ROOT, 'docker', 'Dockerfile.sim-clock');
  if (!existsSync(dockerfile)) throw new Error(`lab Dockerfile is missing: ${dockerfile}`);
  run('docker', ['info', '--format', '{{json .ServerVersion}}'], { timeout: 30000 });
  run('docker', [
    'build',
    '--file', dockerfile,
    '--build-context', `m59_harness=${REPOSITORY_ROOT}`,
    '--build-arg', `SOURCE_COMMIT=${checked.artifacts.manifest.source.commit}`,
    '--build-arg', `PATCH_SHA256=${checked.patchSha256}`,
    '--build-arg', `SIMULATION_SCALE=${checked.scale}`,
    '--tag', checked.tag,
    checked.source,
  ], { stdio: 'inherit', timeout: 30 * 60 * 1000 });
  const labels = inspectImageLabels(checked.tag);
  validateImageLabels(labels, {
    manifest: checked.artifacts.manifest,
    patchSha256: checked.patchSha256,
    scale: checked.scale,
  });
  return Object.freeze({ ...checked, labels });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const config = parseBuildArgs(argv, env);
  if (config.help) { process.stdout.write(HELP); return 0; }
  const checked = preflightBuild(config);
  console.log(`simulation-clock patch: verified ${checked.sourceFiles} source preimages`);
  console.log(`source commit:          ${checked.artifacts.manifest.source.commit}`);
  console.log(`patch sha256:           ${checked.patchSha256}`);
  console.log(`clock:                  ${checked.artifacts.manifest.clock_schema} at ${checked.scale}x`);
  console.log(`image:                  ${checked.tag}`);
  if (config.action === 'check') {
    console.log('check only: Docker was not called.');
    return 0;
  }
  buildImage(checked);
  console.log(`built and re-attested lab-only image ${checked.tag}`);
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`m59-sim-server-build: ${error.message}`);
    process.exitCode = 1;
  });
}
