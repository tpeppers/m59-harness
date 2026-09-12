#!/usr/bin/env node
// SKIP TO / RUN UNTIL, AND PROMOTION. Offline: no broker, no server, no fleet.
//
//   node tools/m59-resume-test.mjs
//
// The case that matters most here is the REFUSAL: a skip past work nothing re-establishes has to
// fail, and it has to fail saying which steps would have been silently dropped. Everything else
// in this file is in service of that one not regressing.
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { marksOf, duplicateMarks, resolveRef, coveredMarks, resumeLimit,
         planSlice, formatSlice } from './m59-resume.mjs';
import { checkpoint } from './m59-establish.mjs';
import { recordRun, readRuns, evidenceFor, promotionBlockers, formatBlockers,
         carriedImports, boundNames, generate, promote, formatPromotion,
         PAD_ONLY } from './m59-promote.mjs';

const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};
const root = mkdtempSync(join(tmpdir(), 'm59-resume-'));

// An eleven-step raid, marked the way a pad author would mark one.
const STEPS = [
  { do: 'travel', to: 12 },
  { do: 'travel', to: 40, mark: 'at-the-hall' },
  { do: 'act', tool: 'equip_best', mark: 'armed' },
  { do: 'act', tool: 'enchant_weapon' },
  { do: 'fight', mark: 'engaged' },
  { do: 'travel', to: 12 },
];
const ARRIVED = checkpoint('the fleet is at the hall, armed', {
  holds: () => true,
  establish: { dm: () => {}, played: () => {} },
  covers: ['at-the-hall', 'armed'],
});

console.log(NL + 'a mark is a FIELD on a step, never a step of its own');
{
  ok('marks are found in order',
     marksOf(STEPS).map(m => m.mark).join(',') === 'at-the-hall,armed,engaged');
  ok('and carry the index they sit on', marksOf(STEPS)[1].index === 2);
  // The compiler must never see a mark as work. Nothing here adds an entry to steps[].
  ok('marking adds no steps', planSlice(STEPS, {}).steps.length === STEPS.length);
  ok('a step with no mark contributes none', marksOf([{ do: 'fight' }]).length === 0);
  ok('duplicates are caught, because a skip would silently pick the first',
     duplicateMarks([{ do: 'a', mark: 'x' }, { do: 'b', mark: 'x' }]).join() === 'x');
  const dup = planSlice([{ do: 'a', mark: 'x' }, { do: 'b', mark: 'x' }], { skipTo: 'x' });
  ok('and planning refuses rather than guessing', dup.ok === false);
  ok('naming the mark', /share the mark x/.test(dup.why), dup.why);
}

console.log(NL + 'THE REFUSAL THIS FILE EXISTS FOR — a skip past uncovered work');
{
  const covered = coveredMarks([ARRIVED]);
  ok('the checkpoint covers the two marks it declares',
     covered.get('at-the-hall') === ARRIVED.name && covered.has('armed'));
  ok('and nothing else', !covered.has('engaged'));

  const lim = resumeLimit(STEPS, [ARRIVED]);
  ok('the furthest covered step is the equip at index 2', lim.index === 2 && lim.mark === 'armed');
  ok('so the resume limit is one PAST it', lim.limit === 3);
  ok('and it names what vouches for it', lim.by === ARRIVED.name);

  const good = planSlice(STEPS, { skipTo: 'armed', setup: [ARRIVED] });
  ok('resuming AT a covered mark is allowed', good.ok === true, good.why);
  ok('and it really is shorter', good.steps.length === 4 && good.from === 2);
  ok('it is marked partial', good.partial === true);
  ok('and says which checkpoint stood in for the skipped steps',
     good.establishedBy === ARRIVED.name);

  // index 3 == limit: the last legal resume point, because the checkpoint covers step 2.
  ok('resuming at the limit itself is allowed',
     planSlice(STEPS, { skipTo: '3', setup: [ARRIVED] }).ok === true);

  // AND ONE PAST IT IS NOT. Step 3 (enchant) is unmarked and uncovered.
  const bad = planSlice(STEPS, { skipTo: 'engaged', setup: [ARRIVED] });
  ok('SKIPPING PAST UNCOVERED WORK IS REFUSED', bad.ok === false);
  ok('it names the furthest covered point', /furthest covered point is step 2/.test(bad.why), bad.why);
  ok('AND LISTS THE STEPS THAT WOULD HAVE BEEN DROPPED',
     /3\. act\('enchant_weapon'\)/.test(bad.why), bad.why);
  ok('and says what a skip that omits work actually is',
     /a different errand with the same name/.test(bad.why));
  ok('the refusal leaves the full list intact', bad.steps.length === STEPS.length);
}

console.log(NL + 'with no covering checkpoint, the only legal resume point is the start');
{
  const lim = resumeLimit(STEPS, []);
  ok('the limit is zero', lim.limit === 0 && lim.index === -1);
  ok('running from the top is still fine', planSlice(STEPS, { setup: [] }).ok === true);
  const bad = planSlice(STEPS, { skipTo: 'armed', setup: [] });
  ok('and any skip at all is refused', bad.ok === false);
  ok('saying no checkpoint covers anything', /no checkpoint in this pad's setup covers any mark/
     .test(bad.why), bad.why);
  ok('AND SAYING HOW TO FIX IT', /covers: \['<mark>'\]/.test(bad.why), bad.why);

  // A checkpoint with no `covers` licenses nothing — that is the default and it is the safe one.
  const plain = checkpoint('somewhere', { holds: () => true, establish: { played: () => {} } });
  ok('a checkpoint declares covers:[] by default', plain.covers.length === 0);
  ok('so it licenses no skipping',
     planSlice(STEPS, { skipTo: 'armed', setup: [plain] }).ok === false);
}

console.log(NL + 'runUntil needs no coverage, because running FEWER steps breaks no guarantee');
{
  const r = planSlice(STEPS, { runUntil: 'armed', setup: [] });
  ok('stopping early is allowed with nothing covered', r.ok === true, r.why);
  ok('and a mark is INCLUSIVE — "run until armed" ends up armed',
     r.to === 3 && r.steps[r.steps.length - 1].tool === 'equip_best');
  ok('it is partial', r.partial === true);
  ok('and it says the fleet is left mid-errand',
     /left MID-ERRAND/.test(formatSlice(r)), formatSlice(r));
  ok('AND THAT IT IS NOT EVIDENCE FOR PROMOTION',
     /not evidence for promotion/.test(formatSlice(r)));

  // A bare index is exclusive: an index is a position between steps, not a name for one.
  ok('a numeric runUntil is exclusive', planSlice(STEPS, { runUntil: '3' }).to === 3);

  const both = planSlice(STEPS, { skipTo: 'armed', runUntil: 'engaged', setup: [ARRIVED] });
  ok('the two compose', both.ok === true && both.from === 2 && both.to === 5);
  ok('an empty window is refused',
     planSlice(STEPS, { skipTo: '4', runUntil: '2', setup: [] }).ok === false);
  ok('and a full run needs no explanation at all',
     formatSlice(planSlice(STEPS, {})) === null);
}

console.log(NL + 'an unknown mark says what the pad DOES mark');
{
  const r = resolveRef(STEPS, 'nowhere');
  ok('it is an error', !!r.error);
  ok('listing the real marks with their indices',
     /at-the-hall@1, armed@2, engaged@4/.test(r.error), r.error);
  ok('an out-of-range index is refused',
     /out of range/.test(resolveRef(STEPS, '99').error));
  const none = resolveRef([{ do: 'fight' }], 'x');
  ok('a pad that marks nothing is told how to start',
     /Add `mark: 'x'`/.test(none.error), none.error);
}

// ==================================================================== PROMOTION
const PAD_SOURCE = `import { walk } from '../m59-fleetscript.mjs';
import { worldReader } from './m59-padcheck.mjs';

export default { name: 'x' };
`;

console.log(NL + 'a run is recorded, and a SLICED one is recorded as sliced');
{
  const file = join(root, 'runs.jsonl');
  recordRun({ pad: 'raid', ok: true, partial: false, agents: ['t4'] }, { file });
  recordRun({ pad: 'raid', ok: true, partial: true, from: 2, to: 5, of: 6 }, { file });
  recordRun({ pad: 'other', ok: true, partial: false }, { file });
  ok('all three land', readRuns({ file }).length === 3);
  ok('and they can be read per pad', readRuns({ file, pad: 'raid' }).length === 2);
  ok('each carries a timestamp', !!readRuns({ file })[0].at);

  // A TORN LINE MUST NOT LOSE THE HISTORY. The session can be killed mid-append.
  writeFileSync(file, readFileSync(file, 'utf8') + '{"pad":"raid","ok":tr');
  ok('a half-written last line is skipped, not fatal', readRuns({ file }).length === 3);
}

console.log(NL + 'A PARTIAL RUN IS NOT EVIDENCE — the whole point of recording the slice');
{
  const file = join(root, 'ev.jsonl');
  recordRun({ pad: 'raid', ok: true, partial: true, from: 2, to: 5, of: 6 }, { file });
  const e1 = evidenceFor({ name: 'raid' }, { file });
  ok('a pad with only sliced runs has no evidence', e1.ok === false);
  ok('and it says every run was sliced', /every one was SLICED/.test(e1.why), e1.why);
  ok('it counts them', e1.partial === 1 && e1.whole === 0);

  recordRun({ pad: 'raid', ok: false, partial: false }, { file });
  ok('a FAILED whole run is still not evidence', evidenceFor({ name: 'raid' }, { file }).ok === false);

  recordRun({ pad: 'raid', ok: true, partial: false, agents: ['t4'] }, { file });
  const e2 = evidenceFor({ name: 'raid' }, { file });
  ok('ONE whole successful run is', e2.ok === true);
  ok('and it is the one reported as the last', e2.last.agents[0] === 't4');

  const none = evidenceFor({ name: 'never-run' }, { file });
  ok('a pad never run says so plainly',
     /no record of it working at all/.test(none.why), none.why);
}

console.log(NL + 'what stands between a pad and a v1.0 file');
{
  const file = join(root, 'blockers.jsonl');
  recordRun({ pad: 'raid', ok: true, partial: false }, { file });
  const scriptDir = join(root, 'scripts');
  mkdirSync(scriptDir, { recursive: true });

  const bare = { name: 'raid', steps: () => STEPS };
  const r1 = promotionBlockers(bare, { source: '', file, scriptDir, steps: STEPS });
  const kinds = r1.blockers.map(b => b.what);
  ok('no provenance is a blocker', kinds.includes('provenance'));
  ok('and it says what a pin is for',
     /pins the code it was written against/.test(r1.blockers.find(b => b.what === 'provenance').why));

  // ---- the lab-only refusal: the deliverable is the prod walk
  const labOnly = checkpoint('spawns are off', {
    holds: () => true, establish: { dm: () => {} }, covers: ['at-the-hall'],
  });
  const r2 = promotionBlockers({ ...bare, setup: [labOnly] },
                               { source: '', file, scriptDir, steps: STEPS });
  const lab = r2.blockers.find(b => b.what === 'lab-only');
  ok('A CHECKPOINT WITH NO `played` ROUTE BLOCKS PROMOTION', !!lab);
  ok('it names the checkpoint', /"spawns are off"/.test(lab.why), lab.why);
  ok('and says the honest outcome rather than pretending it is fixable',
     /this pad is a diagnosis and should stay a pad/.test(lab.fix), lab.fix);
  ok('a checkpoint WITH a played route does not block',
     !promotionBlockers({ ...bare, setup: [ARRIVED] }, { source: '', file, scriptDir })
        .blockers.some(b => b.what === 'lab-only'));

  // ---- the operator-only stack must not travel
  const r3 = promotionBlockers(bare, { source: PAD_SOURCE, file, scriptDir });
  const imp = r3.blockers.find(b => b.what === 'pad import');
  ok('importing the pad stack blocks promotion', !!imp);
  ok('naming the module', /m59-padcheck\.mjs/.test(imp.why), imp.why);
  ok('and the reason it matters', /may be loaded by a keeper/.test(imp.fix));
  ok('every pad-only path is listed in one place', PAD_ONLY.length >= 3);

  // ---- an unsafe waiver does not inherit silently
  ok('an unsafe waiver blocks',
     promotionBlockers({ ...bare, unsafe: { why: 'testing' } }, { source: '', file, scriptDir })
       .blockers.some(b => b.what === 'unsafe'));

  // ---- and a name already on disk is never overwritten
  writeFileSync(join(scriptDir, 'raid.mjs'), '// already here');
  ok('a collision blocks rather than overwriting',
     promotionBlockers(bare, { source: '', file, scriptDir })
       .blockers.some(b => b.what === 'collision'));
  rmSync(join(scriptDir, 'raid.mjs'));

  // ---- and a clean one passes
  const clean = { name: 'raid', provenance: { kod: ['kod/x/y.kod:1'] }, steps: () => STEPS };
  const r4 = promotionBlockers(clean, { source: '', file, scriptDir, steps: STEPS });
  ok('a pad with provenance, evidence and no lab-only checkpoint is promotable', r4.ok === true,
     JSON.stringify(r4.blockers));
  ok('the render says so', /is promotable/.test(formatBlockers(r4, clean)));
  ok('and a mark nothing covers is reported without blocking',
     r4.deadMarks.join(',') === 'at-the-hall,armed,engaged', r4.deadMarks.join(','));
}

console.log(NL + 'the generated file: imports carried, pad stack dropped');
{
  const kept = carriedImports(PAD_SOURCE);
  ok('the harness import survives', kept.some(l => /m59-fleetscript\.mjs/.test(l)));
  ok('THE PAD STACK IMPORT DOES NOT', !kept.some(l => /m59-padcheck/.test(l)));

  // AND AN IMPORT NOTHING USES IS DROPPED — the common case is `checkpoint`, imported by a pad
  // for its setup, which is exactly what promotion leaves behind.
  const withCp = PAD_SOURCE + "import { checkpoint } from './m59-establish.mjs';";
  const used = carriedImports(withCp, 'steps: () => [walk(40)]');
  ok('an import the body uses is kept', used.some(l => /m59-fleetscript/.test(l)));
  ok('AN IMPORT THE BODY NEVER MENTIONS IS DROPPED', !used.some(l => /m59-establish/.test(l)),
     used.join(' | '));
  ok('with no body given, nothing is dropped for being unused',
     carriedImports(withCp).some(l => /m59-establish/.test(l)));
  ok('named, renamed, default and namespace bindings are all found',
     boundNames("import a, { b, c as d } from 'x';").join() === 'b,d,a' &&
     boundNames("import * as ns from 'x';").join() === 'ns');

  const pad = {
    name: 'raid', describe: 'raid the hall',
    provenance: { kod: ['kod/object/x.kod:1'] },
    notes: ['the enchant must precede the fight'],
    composites: {
      // A named function keeps its name; an arrow gets one.
      approach: function approach(to) { return { do: 'travel', to }; },
      armUp: (t) => ({ do: 'act', tool: t }),
    },
    steps: ({ agent }) => [{ do: 'fight', agent }],
  };
  const text = generate(pad, { source: PAD_SOURCE, shape: ['0. fight'],
                               evidence: { whole: 2, last: { at: 'then', agents: ['t4'] } } });
  ok('it says where it came from', /PROMOTED FROM A PAD/.test(text));
  ok('it records the evidence that justified it', /2 whole run\(s\) recorded/.test(text));
  ok('it records the step shape, to be diffed later', /\/\/   0\. 0\. fight/.test(text) ||
     /0\. fight/.test(text));
  ok('it keeps the pad notes, because they explain the order',
     /the enchant must precede the fight/.test(text));
  ok('A NAMED COMPOSITE IS EMITTED AS A FUNCTION DECLARATION',
     /export function approach\(to\)/.test(text), text.slice(0, 400));
  ok('AND AN ARROW AS A CONST', /export const armUp = \(t\) =>/.test(text));
  ok('it says what was deliberately left behind',
     /WHAT WAS LEFT BEHIND: the pad's setup, teardown and checkpoints/.test(text));
  ok('and the steps come across verbatim', /steps: \(\{ agent \}\) =>/.test(text));
  // The named export, because that is what the other fifteen files in tools/fleetscripts/ use.
  ok('IT EXPORTS `script`, LIKE EVERY OTHER FLEETSCRIPT', /^export const script = \{/m.test(text));
  ok('and carries the describe line the pad had', /describe: "raid the hall"/.test(text));
  ok('the three declaration tiers survive if the pad had them',
     /requires: \["a weapon"\]/.test(generate({ ...pad, requires: ['a weapon'] }, { source: '' })));
}

console.log(NL + 'PROMOTION IS VERIFIED BY RE-COMPILING, and refuses to leave a broken file');
{
  const file = join(root, 'promote.jsonl');
  recordRun({ pad: 'raid', ok: true, partial: false }, { file });
  const scriptDir = join(root, 'out');
  const pad = { name: 'raid', provenance: { kod: ['kod/x.kod:1'] },
                steps: () => [{ do: 'fight' }] };

  // ---- the failure this verification exists for: a helper that lived in the pad's scope
  const closed = { ...pad, steps: () => [{ do: 'travel', to: /* a pad-scope helper */ 0 }] };
  const bad = await promote(closed, {
    source: '', steps: [{ do: 'travel', to: 0 }], file, scriptDir,
    load: async () => ({ error: 'helperName is not defined' }),
  });
  ok('a generated file that will not load is NOT promoted', bad.ok === false);
  ok('and the error explains the closure trap',
     /Function\.toString\(\) carries source but not closure/.test(bad.why), bad.why);
  ok('AND NAMES THE FIX', /composites: \{ \.\.\. \}/.test(bad.why));
  ok('nothing is left in the errand directory',
     !existsSync(join(scriptDir, '.promoting-raid.mjs')) &&
     !existsSync(join(scriptDir, 'raid.mjs')));

  // ---- a file that loads but compiles to something else is also refused
  const drifted = await promote(pad, {
    source: '', steps: [{ do: 'fight' }], file, scriptDir,
    render: s => s.do,
    load: async () => ({ steps: [{ do: 'travel' }] }),
  });
  ok('a file that compiles to DIFFERENT steps is refused', drifted.ok === false);
  ok('and the diff is shown', /became travel/.test(drifted.why), drifted.why);

  // ---- and the happy path leaves exactly one file
  const good = await promote(pad, {
    source: '', steps: [{ do: 'fight' }], file, scriptDir, render: s => s.do,
    load: async (path) => { ok('the loader is handed the STAGING path, not the destination',
                               /\.promoting-raid\.mjs$/.test(path), path);
                            return { steps: [{ do: 'fight' }] }; },
  });
  ok('it promotes', good.ok === true, good.why);
  ok('the file is where a fleetscript lives', existsSync(join(scriptDir, 'raid.mjs')));
  ok('AND THE STAGING FILE IS GONE — listDir would have loaded it as a real errand',
     !existsSync(join(scriptDir, '.promoting-raid.mjs')));
  ok('the render says it was verified', /verified: the generated file was loaded back/
     .test(formatPromotion(good, pad)));
  ok('and that the pad survives promotion', /promotion copies, it does not consume/
     .test(formatPromotion(good, pad)));

  const unverified = await promote({ ...pad, name: 'raid2' },
    { source: '', steps: [{ do: 'fight' }], file: join(root, 'p2.jsonl'), scriptDir,
      runs: [{ pad: 'raid2', ok: true, partial: false }] });
  ok('with no loader supplied it still writes', unverified.ok === true, unverified.why);
  ok('BUT SAYS NOBODY HAS CHECKED IT', /NOT verified/.test(formatPromotion(unverified, pad)));
}

rmSync(root, { recursive: true, force: true });
console.log(NL + `${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
