#!/usr/bin/env node
// THE NEXT DEPLOY TAG IS MAX+1, NEVER THE FIRST FREE SLOT — offline, no socket, no roster.
//
//   node tools/m59-deploytag-test.mjs
//
// WHAT THIS PINS. `m59-deploy.mjs --cut` chose the next tag by walking upward until it found a
// name nothing was using. On 2026-09-10 the tags were deploy-2026-09-10, -1, -2, -4, -5, -6,
// production was on -6, and -3 had been deleted at some point in the night. Asked for the next
// tag it answered -3: numerically BELOW the running deploy, pointing at a commit six ahead.
//
// Why that is worse than a cosmetic mis-numbering. Rolling back is "check out the previous
// tag", and which one is previous is decided by reading the numbers. A tag numbered below the
// running one but containing newer code makes that reading wrong, so the rollback rolls
// FORWARD — onto the code you were trying to escape, in the middle of the incident that made
// you want to. Nothing errors at cut time; it reads as a successful deploy either way.
//
// The function lives in its own module because m59-deploy.mjs RUNS ON IMPORT — it reads
// process.argv at the top level and calls process.exit at the bottom — so a test that imported
// it would execute the modes that move production. A pure decision buried in an un-importable
// script is a decision nobody can check, which is how this survived to be cut.
import { nextDeployTag, deployTagNumber } from './m59-deploytag.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '  — ' + extra : ''}`); }
};
const D = '2026-09-10';

console.log('');
console.log('THE INCIDENT: a gap must not be filled');
{
  // The exact tag list from the night this was found, prod on -6, -3 deleted.
  const real = ['deploy-2026-09-10', 'deploy-2026-09-10-1', 'deploy-2026-09-10-2',
                'deploy-2026-09-10-4', 'deploy-2026-09-10-5', 'deploy-2026-09-10-6'];
  const got = nextDeployTag(real, D);
  ok('the gap at -3 is NOT reused', got !== 'deploy-2026-09-10-3', `got ${got}`);
  ok('and the answer is one above the highest that exists',
     got === 'deploy-2026-09-10-7', `got ${got}`);
  // The property that actually matters, stated as a property rather than a value: whatever it
  // returns must sort above every tag already cut, so "the previous tag" stays readable.
  const n = deployTagNumber(got, D);
  ok('so the new number is above every existing one, which is what makes a rollback readable',
     real.every(t => deployTagNumber(t, D) < n));
}

console.log('');
console.log('the ordinary cases');
{
  ok('an untagged day gets the bare name', nextDeployTag([], D) === `deploy-${D}`);
  ok('a day with only the bare name gets -2, because the bare name IS the first deploy',
     nextDeployTag([`deploy-${D}`], D) === `deploy-${D}-2`);
  ok('and it counts up from there',
     nextDeployTag([`deploy-${D}`, `deploy-${D}-2`], D) === `deploy-${D}-3`);
  ok('order in the list does not matter',
     nextDeployTag([`deploy-${D}-6`, `deploy-${D}`, `deploy-${D}-2`], D) === `deploy-${D}-7`);
}

console.log('');
console.log('NUMERIC, NOT LEXICAL — a day can have more than nine deploys');
{
  // This fleet had six in one night, so ten is not a hypothetical. As strings, '-10' < '-9'.
  const many = Array.from({ length: 11 }, (_, i) => i === 0 ? `deploy-${D}` : `deploy-${D}-${i + 1}`);
  ok('eleven tags give -12, not -10', nextDeployTag(many, D) === `deploy-${D}-12`,
     nextDeployTag(many, D));
  ok('and a lexical sort would have got this wrong',
     [...many].sort().pop() !== `deploy-${D}-12` &&
     [...many].sort().pop() === `deploy-${D}-9`);
}

console.log('');
console.log('what it must ignore, because `git tag -l` is given a GLOB');
{
  const noise = [`deploy-${D}`, 'deploy-2026-09-09-4', 'deploy-2026-09-100-9',
                 `deploy-${D}-nope`, 'max-efficiency', 'v1.2.3', ''];
  ok('another day is not this day', nextDeployTag(noise, D) === `deploy-${D}-2`,
     nextDeployTag(noise, D));
  // The glob `deploy-2026-09-10*` matches deploy-2026-09-100-9, which is a DIFFERENT DAY.
  // Anchoring the pattern is the only thing that stops a far-future tag poisoning today.
  ok('and a longer date that the glob still matches is not this day either',
     deployTagNumber('deploy-2026-09-100-9', D) === null);
  ok('a non-numeric suffix is not a deploy number',
     deployTagNumber(`deploy-${D}-nope`, D) === null);
  ok('an unrelated tag is ignored rather than refused', deployTagNumber('v1.2.3', D) === null);
}

console.log('');
console.log('it accepts what git actually hands it');
{
  // `git tag -l` output: newline separated, possibly CRLF on this platform, possibly with a
  // trailing blank line. Any of those becoming an entry would read as an unparsable tag.
  const raw = `deploy-${D}\r\ndeploy-${D}-2\r\ndeploy-${D}-6\r\n`;
  ok('CRLF output from git tag -l parses', nextDeployTag(raw, D) === `deploy-${D}-7`,
     nextDeployTag(raw, D));
  ok('LF output parses too',
     nextDeployTag(`deploy-${D}\ndeploy-${D}-3\n`, D) === `deploy-${D}-4`);
  ok('empty output is an untagged day, not a crash', nextDeployTag('', D) === `deploy-${D}`);
  ok('and so is null — git() returns null when the command fails, and a FAILED LOOKUP MUST ' +
     'NOT read as "no tags", so the caller defaults it before we see it',
     nextDeployTag(null, D) === `deploy-${D}`);
}

console.log('');
console.log('the tool is wired to this module rather than keeping its own copy');
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./m59-deploy.mjs', import.meta.url), 'utf8');
  ok('m59-deploy.mjs imports it', /from '\.\/m59-deploytag\.mjs'/.test(src));
  ok('and calls it', /nextDeployTag\(/.test(src));
  ok('and no longer walks upward to the first free slot',
     !/for \(let n = 2; git\(HARNESS, 'rev-parse'/.test(src));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
