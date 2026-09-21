#!/usr/bin/env node
// WHICH MAP ANSWERED, AND DOES THE SUITE SAY SO.
//
// m59-map-path.mjs decides which map every #movement consumer plans on, and it prefers the
// gitignored local bake over the committed reference. That preference is correct — the local
// artifact carries server-matched collision data — and it is also invisible, which cost two
// sessions an evening on 2026-09-21: m59-routing-test read 141/1/3-skipped on a checkout
// carrying substrate/m59-map.local.json and 158/0 in a fresh worktree at the identical
// commit, and the difference was attributed to a third session's edit before anyone measured
// it. The two maps disagree about a pocket at r1c16.
//
// So the selection is pinned, and so is the ANNOUNCEMENT — because the announcement is the
// part that was missing, and a helper nothing asserts on is a helper that quietly stops
// being printed.
//
// `exists` is injected throughout: these assertions are about the POLICY, and must not depend
// on whether the machine running them happens to carry a local bake.
import { movementMapFile, movementMapProvenance, announceMovementMap,
         geometryOutputFile, geometryRefreshBaseFile,
         CHECKED_MAP_FILE, LOCAL_MAP_FILE } from './m59-map-path.mjs';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; console.log(`  ok   ${what}`) }
  else { fail++; console.log(`  FAIL ${what}${extra ? '  — ' + extra : ''}`) } };

const withLocal = { explicit: undefined, exists: p => p === LOCAL_MAP_FILE };
const noLocal = { explicit: undefined, exists: () => false };

console.log('\nselection');
ok(movementMapFile(withLocal) === LOCAL_MAP_FILE, 'the local bake wins when it exists');
ok(movementMapFile(noLocal) === CHECKED_MAP_FILE, 'the committed reference answers when it does not');
ok(movementMapFile({ explicit: 'C:/tmp/other.json', exists: () => true }).endsWith('other.json'),
   'an explicit M59_MAP outranks both');

console.log('\nprovenance — the fact that was missing');
{
  const p = movementMapProvenance(withLocal);
  ok(p.kind === 'local', 'a local bake is reported as local');
  ok(p.portable === false, '  and is NOT portable — a result here will not match a clone');
  ok(/server-matched/.test(p.why), '  and says why it won', p.why);
}
{
  const p = movementMapProvenance(noLocal);
  ok(p.kind === 'committed', 'the committed reference is reported as committed');
  ok(p.portable === true, '  and IS portable — that is the whole point of the flag');
}
{
  const p = movementMapProvenance({ explicit: 'C:/tmp/other.json', exists: () => true });
  ok(p.kind === 'explicit', 'an explicit map is reported as explicit');
  ok(p.portable === false, '  and is not portable either — it is this invocation\'s opinion');
}

console.log('\nthe announcement, which is the part that was actually missing');
{
  const said = [];
  const p = announceMovementMap(s => said.push(String(s)), withLocal);
  const text = said.join('\n');
  ok(said.length === 1, 'it says exactly one thing');
  ok(/OVERRIDE/.test(text), 'a local bake is announced as an OVERRIDE, loudly', text.slice(0, 60));
  ok(/NOT comparable/i.test(text),
     '  and states that a pass or fail here does not travel — the sentence a reader needs');
  ok(p.kind === 'local', '  and hands the provenance back for a caller that wants it');
}
{
  const said = [];
  announceMovementMap(s => said.push(String(s)), noLocal);
  const text = said.join('\n');
  ok(!/OVERRIDE/.test(text), 'the committed reference is NOT announced as an override');
  ok(/comparable/i.test(text) && !/NOT comparable/i.test(text),
     '  it is announced as comparable instead — quiet when the answer travels');
}

console.log('\nthe suites actually call it');
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./m59-routing-test.mjs', import.meta.url), 'utf8');
  ok(/announceMovementMap\(\)/.test(src),
     'm59-routing-test announces its map before asserting',
     'without this the red-here/green-there problem comes straight back');
}

console.log('\nbuild paths are unchanged by any of the above');
ok(geometryOutputFile({ explicit: undefined }) === CHECKED_MAP_FILE,
   'a bare refresh still writes the committed reference, never the local bake');
ok(geometryRefreshBaseFile(LOCAL_MAP_FILE, { exists: () => true }) === CHECKED_MAP_FILE,
   'and a local refresh still starts from the committed graph');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
