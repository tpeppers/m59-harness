#!/usr/bin/env node
// WHAT THIS PINS: that the walking half still has everything it needs from m59-game.mjs.
//
//   node tools/m59-session-walk-test.mjs
//
// Offline. No socket, no roster, no fleet.
//
// WHY IT EXISTS. The movement methods were extracted from m59-game.mjs as a mixin whose
// module-scope dependencies are passed in as parameters. Nothing about that arrangement is
// checked by the compiler: a name the methods use and the factory does not receive is
// syntactically perfect and throws `X is not defined` the first time a character walks down
// that branch. `node --check` passes. The offline suites passed. The failure surfaced as a
// live keeper answering HTTP 500 mid-walk, and only because somebody was walking.
//
// Fifteen names were missing on the first extraction — protocolToClient alone is used
// thirty-five times — and a sixteenth was subtler: `fallPhysics` is imported by m59-game.mjs
// as `physics as fallPhysics`, so copying the NAME without the alias produced a module that
// imports a symbol its source does not export. That one took the whole broker down at
// startup rather than mid-walk, which is the lucky version.
//
// So this asks the question directly: for every name m59-game.mjs defines or imports, if the
// walk file's method bodies use it, is it either imported there or passed in? And it loads
// the module, because an import naming a symbol that is not exported is a different failure
// that only shows up on load.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const ok = (cond, what) => { if (cond) { passed++; console.log(`  ok   ${what}`); }
                             else { failed++; console.log(`  FAIL ${what}`); } };

const game = readFileSync(join(HERE, 'm59-game.mjs'), 'utf8');
const walk = readFileSync(join(HERE, 'm59-session-walk.mjs'), 'utf8');

// Every name a module declares at module scope or brings in by import, under the LOCAL name
// the code would use — which is the alias when there is one.
const declaredIn = (src) => {
  const out = new Set();
  for (const m of src.matchAll(/^(?:export\s+)?(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm))
    out.add(m[1]);
  for (const m of src.matchAll(/^import\s*\{([\s\S]*?)\}\s*from/gm))
    for (const part of m[1].split(','))
      { const n = part.trim().split(/\s+as\s+/).pop()?.trim(); if (n) out.add(n); }
  for (const m of src.matchAll(/^import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from/gm)) out.add(m[1]);
  return out;
};

console.log('\nthe seam');
const body = walk.split('class SessionWalk {')[1];
ok(!!body, 'the walk file still holds its methods in a class body');
const depBlock = /const \{\n([\s\S]*?)\n  \} = deps;/.exec(walk);
ok(!!depBlock, 'and still takes its module-scope dependencies as parameters');

const deps = new Set((depBlock?.[1] ?? '').split(',').map(x => x.trim()).filter(Boolean));
const provided = declaredIn(walk);
const fromGame = declaredIn(game);

console.log('\nevery name the methods use is provided');
const missing = [];
for (const n of fromGame) {
  if (provided.has(n) || deps.has(n)) continue;
  // Not after a dot, and not inside a quote — a property or a word in a comment is not a
  // free variable. Crude, and crude in the safe direction: it over-reports rather than under.
  const re = new RegExp(`(^|[^\\w$.'"\`])${n}\\s*[(.\\[,;)=<>!?:+\\-*/}\\]]`, 'm');
  if (re.test(body ?? '')) missing.push(n);
}
ok(missing.length === 0,
   missing.length ? `${missing.length} name(s) used but not provided: ${missing.slice(0, 8).join(', ')}`
                  : 'no name is used that the factory does not receive or the file import');

console.log('\nthe install side agrees with the factory side');
const inst = /const walk = sessionWalkPrototype\(\{\n([\s\S]*?)\n  \}\);/.exec(game);
ok(!!inst, 'm59-game.mjs still installs the mixin');
const passedIn = new Set((inst?.[1] ?? '').split(',').map(x => x.trim()).filter(Boolean));
const notPassed = [...deps].filter(d => !passedIn.has(d));
ok(notPassed.length === 0,
   notPassed.length ? `the factory destructures ${notPassed.join(', ')} but nothing passes them`
                    : `all ${deps.size} declared dependencies are actually passed`);

console.log('\nit loads, and the methods land on Session');
const m = await import('./m59-game.mjs');
const S = m.Session;
ok(!!S, 'm59-game.mjs still exports Session');
for (const name of ['walkTo', 'walkFine', 'step', 'followRail', 'leaveVia', 'leaveViaAny', 'railAcross'])
  ok(typeof S?.prototype?.[name] === 'function', `Session.prototype.${name} is installed`);
ok(Object.getOwnPropertyDescriptor(S.prototype, 'walkTo')?.enumerable === false,
   'and is non-enumerable, exactly as a class body would have left it');
ok(typeof S?.prototype?.attackRounds === 'function',
   'attackRounds stayed in m59-game.mjs — the seam is walking, not combat');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
