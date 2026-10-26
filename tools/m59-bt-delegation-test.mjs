#!/usr/bin/env node
import { readToolSource } from './autopilot/source.mjs';
// m59-bt-delegation-test.mjs -- THE TEST THAT TELLS A DECOMPOSITION FROM A WRAPPER.
//
// A behavior-tree node that calls back into m59-autopilot.mjs has not replaced
// anything. The behaviour still lives in the monolith; only the call moved. That
// distinction is invisible to every other test in this repository, because a
// wrapper is behaviour-preserving BY CONSTRUCTION -- it passes precisely because
// it changed nothing. So a suite of green tests is exactly what a stalled
// migration looks like, and it is what this one looked like for forty commits:
//
//   ae350a2  m59-autopilot.mjs  11,909 lines   (before the BT effort)
//   a4a8eca  m59-autopilot.mjs  13,359 lines   (after 12,941 lines of BT modules)
//
// The monolith GREW by 1,450 lines during the project meant to retire it, while
// 613 BT assertions passed. Seventeen `_btFarm*`/`_btFlee*` methods were added to
// m59-autopilot.mjs to feed the trees -- new monolith code written to support the
// thing replacing the monolith. Nothing failed, because nothing was asking.
//
// This asks. `provisionNode` is the shape it exists to catch:
//
//     export function provisionNode(keeper) {
//       return asyncAction(async (bb) => {
//         const plan   = keeper._btFarmStrategy();
//         const result = await keeper.provision(plan, vitals(bb));
//         if (result === 'ate' || result === 'waiting') return SUCCESS;
//         return FAILURE;
//       });
//     }
//
// Three lines, all of them translating a legacy return value into a BT status.
// Delete `Autopilot.provision()` and this node stops working, which is the whole
// point: the delegation IS the dependency, and you cannot remove what is still
// being called. Every such call is a pointer back into the file you are trying
// to delete, and today there are 272 of them.
//
// ── THE SEAM ────────────────────────────────────────────────────────────────
//
// "Do not call the keeper" is too blunt to be true. Some coupling is correct and
// permanent, so the allowlist below is the actual architectural claim:
//
//   ALLOWED -- services. The keeper owns the session, the journal and the
//   configuration, and a node that could not report what it did would be worse,
//   not purer. `note`/`progress`/`noProgress` are the journal. `s`, `policy` and
//   `tally` are data, reached as properties rather than called.
//
//   REFUSED -- decisions and actions. `provision`, `travel`, `takeSafeSpot`,
//   `makeRoom`, `withdraw`, `safety`, `fightFloor`. These are the behaviour. A
//   node that calls one has not extracted it, and the extraction is the work.
//
// ── WHY A RATCHET AND NOT A RED BUILD ───────────────────────────────────────
//
// Enforced absolutely this test fails on every file today, which makes it noise
// that gets skipped rather than a signal that gets fixed. So it is a RATCHET: the
// baseline records what each file owes right now, and the test fails only when a
// file gets WORSE. Wrapping is refused from today; the existing debt is paid down
// on its own schedule and can never quietly grow back.
//
// A file that IMPROVES also fails -- loudly, asking for the baseline to be
// lowered. A ratchet nobody tightens is just a comment.
//
//   node tools/m59-bt-delegation-test.mjs            # check the ratchet
//   node tools/m59-bt-delegation-test.mjs --queue    # the extraction work queue
//   node tools/m59-bt-delegation-test.mjs --bless    # rewrite the baseline
//
// Opens no socket, needs no broker, touches no fleet.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE     = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, 'm59-bt-delegation-baseline.json');

// Services, not behaviour. See THE SEAM above -- this list is the architectural
// claim and should be argued with directly rather than grown by convenience.
const ALLOWED = new Set(['note', 'progress', 'noProgress']);

// The keeper arrives under both spellings: `keeper` in the farm/flee nodes, and
// aliased to `k` in the town/recover ones (`const k = keeper;`). Counting only the
// first is how the town module was once reported as having zero callbacks when it
// has twenty-seven.
//
// BUT `k` IS ALSO THE COMMONEST LOOP VARIABLE IN THE LANGUAGE, and counting it
// unconditionally is a false positive with a straight face: m59-goap-planner.mjs
// was flagged as having "gained delegation" purely on `k.startsWith('!')` and
// `k.slice(1)`, where k is a world-state KEY and there is no keeper in the file at
// all. That matters more than the miscount — A RATCHET THAT CRIES WOLF GETS BLESSED
// AWAY, and then it is a comment rather than a check.
//
// So `k` is counted only in a file that actually binds it to the keeper.
const keeperAliased = (src) => /\bk\s*=\s*(keeper|this\.k)\b/.test(src);
const receiversFor  = (src) => (keeperAliased(src) ? ['keeper', 'k'] : ['keeper']);

// ---------------------------------------------------------------------------
// Comment stripping. These files carry more prose than code and the prose NAMES
// the methods -- this very header mentions `keeper.provision()` twice. Counting
// documentation as delegation would make the ratchet unfixable by writing about
// it, so comments come out before anything is counted.
// ---------------------------------------------------------------------------
// ORDER MATTERS, AND GETTING IT WRONG ATE HALF A FILE. Blocks were stripped first,
// which meant a LINE comment containing "/*" opened a block comment that ran to the
// next "*/" -- swallowing every line between. m59-plan.mjs says "m59-act/*" in its
// header, so its imports vanished and the orphan check reported m59-goap-planner as
// imported by nothing while m59-plan.mjs was importing it three lines down.
//
// Line comments therefore come out FIRST, which removes the fake opener with the
// line it sits on. The residual risk is the mirror case -- a "//" inside a real
// block comment truncating that one line -- which cannot hide code, because there is
// no code inside a block comment to hide.
function stripComments(src) {
  return src
    .replace(/(^|[^:])\/\/.*$/gm, '$1')    // line comments FIRST, sparing http://
    .replace(/\/\*[\s\S]*?\*\//g, '');     // then real block comments
}

function btModules(dir) {
  return readdirSync(dir)
    .filter(f => /^m59-(bt-|keeper-bt|goap)/.test(f))
    .filter(f => f.endsWith('.mjs'))
    .filter(f => !f.includes('-test'))
    // The BT primitives themselves have no keeper and never should.
    .filter(f => f !== 'm59-bt.mjs')
    .sort();
}

// Every call into the keeper that is not a service. Returns the method names,
// with duplicates kept -- the count is the debt and the set is the work queue.
function delegations(src) {
  const clean = stripComments(src);
  const out = [];
  for (const recv of receiversFor(clean)) {
    // keeper.foo(   keeper.foo?.(   k.foo(   k.foo?.(
    const re = new RegExp(`\\b${recv}\\.([a-zA-Z_][a-zA-Z_0-9]*)(?:\\?\\.)?\\(`, 'g');
    for (const m of clean.matchAll(re)) {
      if (!ALLOWED.has(m[1])) out.push(m[1]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

const argv    = process.argv.slice(2);
const BLESS   = argv.includes('--bless');
const QUEUE   = argv.includes('--queue');

const files   = btModules(HERE);
const report  = new Map();          // file -> { count, methods: Map<name, n> }

for (const f of files) {
  const calls   = delegations(readToolSource(join(HERE, f), 'utf8'));
  const methods = new Map();
  for (const c of calls) methods.set(c, (methods.get(c) ?? 0) + 1);
  report.set(f, { count: calls.length, methods });
}

// ── --queue: the extraction work queue ─────────────────────────────────────
if (QUEUE) {
  console.log('\nEXTRACTION QUEUE -- every legacy method a BT module still calls.');
  console.log('Each line is one method that must move out of m59-autopilot.mjs.\n');

  const owed = new Map();           // method -> Set<file>
  for (const [f, r] of report)
    for (const name of r.methods.keys())
      (owed.get(name) ?? owed.set(name, new Set()).get(name)).add(f);

  const rows = [...owed.entries()]
    .map(([name, fs]) => ({ name, files: fs.size,
                            calls: [...report.values()]
                              .reduce((t, r) => t + (r.methods.get(name) ?? 0), 0) }))
    .sort((a, b) => b.files - a.files || b.calls - a.calls || a.name.localeCompare(b.name));

  console.log('  calls  files  method');
  for (const r of rows)
    console.log(`  ${String(r.calls).padStart(5)}  ${String(r.files).padStart(5)}  ${r.name}`);

  // A method only one module calls is a clean lift; one that several call has to
  // land somewhere shared first, so the order is not the same as the size.
  const solo = rows.filter(r => r.files === 1).length;
  console.log(`\n  ${rows.length} methods, ${solo} called by exactly one module ` +
              '(those are the cheap ones -- lift straight into that module).');
  console.log(`  ${rows.length - solo} called by several (extract to a shared module first).\n`);
  process.exit(0);
}

// ── --bless: rewrite the baseline ──────────────────────────────────────────
if (BLESS) {
  const out = {};
  for (const [f, r] of report) out[f] = r.count;
  writeFileSync(BASELINE, JSON.stringify({
    note: 'Delegation debt per BT module: calls into the legacy keeper that are ' +
          'not journal services. This file may only ever go DOWN. See ' +
          'm59-bt-delegation-test.mjs for why.',
    generated: new Date().toISOString().slice(0, 10),
    total: [...report.values()].reduce((t, r) => t + r.count, 0),
    files: out,
  }, null, 2) + '\n');
  console.log(`baseline written: ${basename(BASELINE)}`);
  for (const [f, r] of report) console.log(`  ${String(r.count).padStart(4)}  ${f}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// ORPHANS. A module nothing imports is not neutral: it is code that looks
// available, tests green, and runs never -- and the next person to need that
// behaviour writes it again rather than finding it.
//
// This was not hypothetical. m59-bt-farming.mjs was imported by nothing, and it
// transitively kept m59-bt-combat, m59-bt-shop and m59-bt-atomics reachable-only-
// from-an-orphan: 3,966 lines of module and test, including the entire ten-node
// atomic library, none of it executed by any keeper. Two of the four carried
// conditions that were always false against a real client. 613 assertions passed
// throughout.
//
// Reported, never failed: an orphan is sometimes deliberate (a module kept as the
// base for the next phase, which is exactly why bt-nav and bt-walk survive today).
// The point is that the choice is visible rather than discovered a year later.
// ---------------------------------------------------------------------------
// A module that can be RUN is not an orphan even if nothing imports it --
// m59-goap.mjs is a CLI. The tell is a main guard.
const isEntryPoint = (src) => /import\.meta\.url|process\.argv\[1\]/.test(src);

// NOTE THE LIMIT: this is "imported by nothing live", one level deep, not true
// reachability from a running keeper. A module imported only by another orphan
// still reads as fine here -- which is exactly how m59-bt-atomics stayed
// invisible behind m59-bt-shop. Walking the graph from m59-broker.mjs would be
// stricter; it is not done yet, so read a clean report as "no NEW orphan" rather
// than as "everything is wired".
function orphans(dir, files) {
  const importedBy = new Map(files.map(f => [f, []]));
  for (const f of readdirSync(dir).filter(x => x.endsWith('.mjs'))) {
    const src = stripComments(readToolSource(join(dir, f), 'utf8'));
    for (const target of files) {
      if (f === target) continue;
      if (f === target.replace(/\.mjs$/, '-test.mjs')) continue;   // its own test
      if (src.includes(`./${target}`)) importedBy.get(target).push(f);
    }
  }
  return files.filter(f =>
    !isEntryPoint(readToolSource(join(dir, f), 'utf8')) &&
    importedBy.get(f).every(x => x.includes('-test')));
}

// ── the ratchet ────────────────────────────────────────────────────────────
if (!existsSync(BASELINE)) {
  console.error(`no baseline at ${basename(BASELINE)} -- run with --bless to create one`);
  process.exit(1);
}
const base = JSON.parse(readToolSource(BASELINE, 'utf8'));

let failed = 0, improved = 0, total = 0;
console.log('\ndelegation ratchet -- calls from BT modules into the legacy keeper\n');
console.log('  now  base  file');

for (const [f, r] of report) {
  total += r.count;
  const b = base.files?.[f];
  const mark = b === undefined ? 'NEW'
             : r.count > b      ? 'WORSE'
             : r.count < b      ? 'better'
             : '';
  if (b === undefined && r.count > 0) failed++;
  else if (r.count > b) failed++;
  else if (r.count < b) improved++;
  console.log(`  ${String(r.count).padStart(3)}  ${String(b ?? '-').padStart(4)}  ${f}` +
              (mark ? `   <-- ${mark}` : ''));
}

console.log(`\n  total ${total} (baseline ${base.total})`);

const orphaned = orphans(HERE, files);
if (orphaned.length) {
  console.log('\n  ORPHANED -- imported by nothing but their own tests:');
  for (const f of orphaned) console.log(`    ${f}`);
  console.log('  Deliberate or forgotten? An orphan that is neither wired nor deleted\n' +
              '  is how 3,966 lines of always-false code passed 613 assertions.');
}

if (failed) {
  console.error(
    `\nFAIL: ${failed} file(s) gained delegation.\n\n` +
    'A new call into m59-autopilot.mjs means the behaviour did not move -- only\n' +
    'the call did. Extract the method instead: its body moves into the BT module\n' +
    'and it is DELETED from m59-autopilot.mjs, so that file gets shorter. If it\n' +
    'cannot move because another caller needs it, extract it to a shared module\n' +
    'both call. Do not add a _bt* shim; that is the wrapper wearing a hat.\n');
  process.exit(1);
}

if (improved) {
  console.error(
    `\n${improved} file(s) improved -- lower the baseline with --bless and commit it.\n` +
    'A ratchet nobody tightens is just a comment.\n');
  process.exit(1);
}

console.log('\nok -- no module gained delegation.\n');
