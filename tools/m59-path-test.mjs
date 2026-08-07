#!/usr/bin/env node
// FILE URLS ARE NOT FILESYSTEM PATHS.
//
// URL.pathname leaves spaces percent-encoded and needs hand-written drive-letter
// repair on Windows. Node already owns both conversions: fileURLToPath for paths and
// pathToFileURL for direct-execution comparisons. Keep the old idioms from creeping
// back into standalone tools as new ledgers and reports are added.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (what, condition, detail = '') => {
  if (condition) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ''}`); }
};

const offenders = [];
for (const name of readdirSync(HERE).filter(name => name.endsWith('.mjs'))) {
  if (name === 'm59-path-test.mjs') continue;
  const source = readFileSync(join(HERE, name), 'utf8');
  const compact = source.replace(/\s+/g, '');
  if (/newURL\([^;]*import\.meta\.url\)\.pathname/.test(compact))
    offenders.push(`${name}: uses import.meta.url pathname as a filesystem path`);
  if (compact.includes('file://${process.argv[1]}') ||
      compact.includes('file:///${String(process.argv[1])'))
    offenders.push(`${name}: manually constructs a file URL from process.argv[1]`);
}

console.log('\nportable file URL conversion');
ok('no standalone tool manually converts import.meta.url', offenders.length === 0,
   offenders.join('; '));

const spaced = fileURLToPath(new URL('../M59%20path%20fixture/', import.meta.url));
ok('fileURLToPath decodes spaces into a native path',
   spaced.includes('M59 path fixture') && !spaced.includes('%20'), spaced);

const script = join(HERE, 'm59-items.mjs');
const roundTrip = fileURLToPath(pathToFileURL(script));
ok('pathToFileURL round-trips a native direct-execution path', roundTrip === script,
   `${roundTrip} != ${script}`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
