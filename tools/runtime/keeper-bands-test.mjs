#!/usr/bin/env node
// Offline keeper-band registry tests.  Child mode is used only to prove that separate
// processes racing for the short-lived registry claim cannot receive overlapping bands.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { claimFleetLock, FLEET_LOCK_KIND } from './fleet-lock.mjs';

import {
  FIRST_NAMED_KEEPER_BAND_BASE,
  KEEPER_BAND_WIDTH,
  KeeperBandRegistryError,
  UNNAMED_KEEPER_BAND_BASE,
  allocateKeeperBand,
  lookupKeeperBand,
} from './keeper-bands.mjs';

const childMode = process.argv[2] === '--allocate-child';
if (childMode) {
  const [, , , registryPath, fleet] = process.argv;
  const result = allocateKeeperBand(fleet, { registryPath, lockTimeoutMs: 15_000 });
  process.stdout.write(JSON.stringify(result));
} else {
  await runTests();
}

async function runTests() {
  const scratch = mkdtempSync(join(tmpdir(), 'm59-keeper-bands-test-'));
  const resolvedScratch = resolve(scratch);
  const resolvedTemp = resolve(tmpdir());
  if (!resolvedScratch.startsWith(resolvedTemp + sep))
    throw new Error(`refusing unsafe test directory ${resolvedScratch}`);
  const file = name => join(resolvedScratch, name);
  const writeRegistry = (path, value) =>
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  const expectCode = (fn, code) => assert.throws(fn, error => {
    assert.equal(error instanceof KeeperBandRegistryError, true);
    assert.equal(error.code, code);
    return true;
  });

  try {
    assert.equal(KEEPER_BAND_WIDTH, 100);

    // The unnamed compatibility band is read-only and exactly 100 inclusive ports.
    {
      const path = file('unnamed.json');
      assert.deepEqual(lookupKeeperBand(null, { registryPath: path }), {
        base: UNNAMED_KEEPER_BAND_BASE,
        end: UNNAMED_KEEPER_BAND_BASE + 99,
        width: 100,
      });
      assert.deepEqual(allocateKeeperBand('', { registryPath: path }), {
        base: UNNAMED_KEEPER_BAND_BASE,
        end: UNNAMED_KEEPER_BAND_BASE + 99,
        width: 100,
      });
      assert.equal(existsSync(path), false, 'unnamed lookup and allocation do not write');
      assert.equal(existsSync(`${path}.lock`), false, 'unnamed lookup takes no claim');
    }

    // Read-only lookup accepts the legacy numeric-base format but never invents a missing
    // named fleet or modifies bytes on disk.
    {
      const path = file('legacy.json');
      const raw = '{"prod":9011,"shadow":9111}';
      writeRegistry(path, raw);
      assert.deepEqual(lookupKeeperBand('prod', { registryPath: path }), {
        base: 9011, end: 9110, width: 100,
      });
      assert.equal(lookupKeeperBand('absent', { registryPath: path }), null);
      assert.equal(readFileSync(path, 'utf8'), raw);
      assert.equal(existsSync(`${path}.lock`), false);
    }

    // Allocation is stable, preserves numeric legacy values, and releases its claim.
    {
      const path = file('allocate.json');
      assert.deepEqual(allocateKeeperBand('alpha', { registryPath: path }), {
        base: FIRST_NAMED_KEEPER_BAND_BASE,
        end: FIRST_NAMED_KEEPER_BAND_BASE + 99,
        width: 100,
      });
      assert.deepEqual(allocateKeeperBand('beta', { registryPath: path }), {
        base: FIRST_NAMED_KEEPER_BAND_BASE + 100,
        end: FIRST_NAMED_KEEPER_BAND_BASE + 199,
        width: 100,
      });
      assert.equal(allocateKeeperBand('alpha', { registryPath: path }).base,
        FIRST_NAMED_KEEPER_BAND_BASE);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
        alpha: FIRST_NAMED_KEEPER_BAND_BASE,
        beta: FIRST_NAMED_KEEPER_BAND_BASE + 100,
      });
      assert.equal(existsSync(`${path}.lock`), false);
      assert.equal(readdirSync(scratch).some(name => name.includes('.tmp-')), false,
        'atomic replacements leave no temporary files');
    }

    // Arbitrarily positioned legacy bands are accepted when disjoint; allocation skips
    // every canonical candidate they touch rather than comparing bases only.
    {
      const path = file('unaligned.json');
      writeRegistry(path, { old: 9050 }); // occupies 9050-9149
      const allocated = allocateKeeperBand('new', { registryPath: path });
      assert.deepEqual(allocated, { base: 9211, end: 9310, width: 100 });
    }

    // Every entry is validated before either lookup or allocation.  No invalid file is
    // rewritten or treated as an empty registry.
    for (const [label, value, code] of [
      ['invalid-json', '{broken', 'REGISTRY_MALFORMED'],
      ['duplicate-name', '{"prod":9011,"prod":9111}', 'REGISTRY_DUPLICATE_FLEET'],
      ['array', '[]', 'REGISTRY_MALFORMED'],
      ['null', 'null', 'REGISTRY_MALFORMED'],
      ['string-base', { prod: '9011' }, 'REGISTRY_INVALID_BASE'],
      ['null-base', { prod: null }, 'REGISTRY_INVALID_BASE'],
      ['fraction-base', { prod: 9011.5 }, 'REGISTRY_INVALID_BASE'],
      ['zero-base', { prod: 0 }, 'REGISTRY_INVALID_BASE'],
      ['overflow-base', { prod: 65437 }, 'REGISTRY_INVALID_BASE'],
      ['empty-name', { '': 9011 }, 'REGISTRY_INVALID_FLEET'],
      ['space-name', { ' prod': 9011 }, 'REGISTRY_INVALID_FLEET'],
      ['control-name', { 'bad\nname': 9011 }, 'REGISTRY_INVALID_FLEET'],
      ['unnamed-overlap', { prod: 9000 }, 'REGISTRY_BANDS_OVERLAP'],
      ['same-base', { prod: 9011, shadow: 9011 }, 'REGISTRY_BANDS_OVERLAP'],
      ['partial-overlap', { prod: 9011, shadow: 9110 }, 'REGISTRY_BANDS_OVERLAP'],
    ]) {
      const path = file(`${label}.json`);
      writeRegistry(path, value);
      const before = readFileSync(path, 'utf8');
      expectCode(() => lookupKeeperBand('prod', { registryPath: path }), code);
      expectCode(() => allocateKeeperBand('another', { registryPath: path }), code);
      assert.equal(readFileSync(path, 'utf8'), before, `${label} was not rewritten`);
      assert.equal(existsSync(`${path}.lock`), false, `${label} claim was released`);
    }

    // A symlink is not followed, and an unverifiable allocation claim blocks mutation.
    {
      const target = file('symlink-target.json');
      const path = file('symlink.json');
      writeRegistry(target, { prod: 9011 });
      let symlinkSupported = true;
      try { symlinkSync(target, path, 'file'); }
      catch (error) {
        if (error?.code === 'EPERM') symlinkSupported = false;
        else throw error;
      }
      if (symlinkSupported) {
        assert.equal(lstatSync(path).isSymbolicLink(), true);
        expectCode(() => lookupKeeperBand('prod', { registryPath: path }),
          'REGISTRY_NOT_REGULAR');
      }

      const locked = file('bad-lock.json');
      writeRegistry(`${locked}.lock`, '{not-a-claim');
      expectCode(() => allocateKeeperBand('prod', { registryPath: locked }),
        'REGISTRY_LOCK_UNVERIFIABLE');
      assert.equal(existsSync(locked), false, 'unverifiable claim fails before registry write');
    }

    // A live claim really serializes another process rather than causing it to guess a
    // band or treat the current registry as empty.
    {
      const path = file('wait-for-claim.json');
      const held = claimFleetLock(`${path}.lock`, {
        kind: FLEET_LOCK_KIND,
        subject: 'keeper-band-registry',
      });
      assert.equal(held.ok, true);
      const waiting = childAllocate(path, 'waited');
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
      assert.equal(existsSync(path), false, 'contender cannot write through a live claim');
      assert.equal(held.release().released, true);
      assert.deepEqual(await waiting, {
        base: FIRST_NAMED_KEEPER_BAND_BASE,
        end: FIRST_NAMED_KEEPER_BAND_BASE + 99,
        width: 100,
      });
      assert.equal(existsSync(`${path}.lock`), false);
    }

    // Fill every canonical candidate and prove exhaustion fails without changing the file.
    {
      const path = file('full.json');
      const full = {};
      let number = 0;
      for (let base = FIRST_NAMED_KEEPER_BAND_BASE; base + 99 <= 65535; base += 100)
        full[`fleet-${String(number++).padStart(3, '0')}`] = base;
      writeRegistry(path, full);
      const before = readFileSync(path, 'utf8');
      expectCode(() => allocateKeeperBand('one-too-many', { registryPath: path }),
        'NO_AVAILABLE_KEEPER_BAND');
      assert.equal(readFileSync(path, 'utf8'), before);
      assert.equal(existsSync(`${path}.lock`), false);
    }

    // Cross-process contention: each distinct fleet gets one non-overlapping band, while
    // all contenders for the same fleet converge on exactly one persisted assignment.
    {
      const path = file('concurrent.json');
      const distinctNames = Array.from({ length: 18 }, (_, index) => `parallel-${index}`);
      const results = await Promise.all(distinctNames.map(name => childAllocate(path, name)));
      assert.equal(new Set(results.map(value => value.base)).size, distinctNames.length);
      const ordered = [...results].sort((left, right) => left.base - right.base);
      for (let index = 1; index < ordered.length; index++)
        assert.equal(ordered[index].base > ordered[index - 1].end, true);

      const same = await Promise.all(Array.from({ length: 12 }, () =>
        childAllocate(path, 'one-shared-fleet')));
      assert.equal(new Set(same.map(value => value.base)).size, 1);

      const persisted = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(Object.keys(persisted).length, distinctNames.length + 1);
      assert.equal(new Set(Object.values(persisted)).size, distinctNames.length + 1);
      assert.equal(existsSync(`${path}.lock`), false);
      assert.equal(readdirSync(scratch).some(name => name.includes('.tmp-')), false);
    }

    assert.throws(() => lookupKeeperBand(' padded ', { registryPath: file('x.json') }),
      /trimmed/);
    assert.throws(() => allocateKeeperBand('ok', {
      registryPath: file('x.json'), lockTimeoutMs: -1,
    }), /lockTimeoutMs/);

    console.log('keeper bands: PASS');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function childAllocate(registryPath, fleet) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url),
      '--allocate-child', registryPath, fleet], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('close', code => {
      if (code !== 0) {
        rejectPromise(new Error(`allocation child exited ${code}: ${stderr}`));
        return;
      }
      try { resolvePromise(JSON.parse(stdout)); }
      catch (error) { rejectPromise(new Error(`invalid allocation child output: ${error.message}`)); }
    });
  });
}
