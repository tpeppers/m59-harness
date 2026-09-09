#!/usr/bin/env node
// THE FLEETBOOK — WHAT AN ERRAND ACHIEVES IN THE GAME, WHAT IT COSTS, AND WHAT IT NEEDS.
//
//   node tools/m59-fleetbook.mjs                 the whole book
//   node tools/m59-fleetbook.mjs mana-nodes      one recipe, in full
//   node tools/m59-fleetbook.mjs --undeclared    which scripts have no recipe yet
//
// WHY A COOKBOOK AND NOT A TOOL LIST. `tools/INDEX.md` answers "does this exist?" and
// `m59-fleet-repl.mjs list` answers "what can I type". Neither answers the question an
// operator actually has, which is the one a cookbook answers: **I want this to be true of my
// characters — what do I run, what will it cost me, and can these characters even do it?**
// "Walk characters back to a room" is a description of a mechanism. "Masters Shal'ille to
// level 4 in about seventeen hours, needs 40 intellect and a patient who will hold still" is
// a recipe, and only the second one lets somebody decide.
//
// IT IS GENERATED, FOR THE SAME REASON `tools/INDEX.md` IS. A hand-written index of
// capabilities is a document that is wrong within a fortnight and is then trusted anyway —
// the failure this repository has already had twice, with a supervisor that did not exist
// quoted in four documents. So a recipe lives on the SCRIPT, next to the steps it describes,
// and this only collects them. `--check` fails when a script has no recipe, so the book
// cannot quietly stop covering the fleet.
//
// AN UNDECLARED RECIPE IS NOT AN EMPTY ONE. A script with no `recipe` block is listed with
// its `describe` line and marked `(no recipe declared)` — never silently omitted and never
// given a plausible-looking guess. That distinction is the whole difference between a book
// you can plan from and one that has quietly stopped covering half the fleet.
//
// EVERY NUMBER IN A RECIPE IS EITHER MEASURED OR MARKED. `cost.measured` names when and on
// whom; a figure nobody has measured says `estimate` and says what it is derived from. This
// is not pedantry: "about an hour" repeated confidently is how a fleet gets promised to an
// operator by tomorrow morning, and tomorrow morning is when it is discovered to be
// seventeen hours.
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const has = n => argv.includes(`--${n}`);
const WANTED = argv.filter(a => !a.startsWith('--'));

const DIRS = [join(HERE, 'fleetscripts'), join(REPO, 'substrate', 'fleetscripts')];

async function loadAll() {
  const out = [];
  for (const dir of DIRS) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter(f => f.endsWith('.mjs')).sort()) {
      try {
        const mod = await import(pathToFileURL(join(dir, f)).href);
        const s = mod.script;
        if (s?.name) out.push({ ...s, _file: join(dir, f), _private: dir !== DIRS[0] });
      } catch (e) {
        out.push({ name: f.replace(/\.mjs$/, ''), _file: join(dir, f), _broken: e.message });
      }
    }
  }
  return out;
}

const wrap = (text, width, indent) => {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && (line.length + 1 + w.length) > width) { lines.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : indent + l)).join('\n');
};

function render(s, { full = false } = {}) {
  const r = s.recipe;
  const out = [];
  const tag = s._tool ? '   NOT A FLEETSCRIPT - run the tool directly'
            : s._private ? " (this machine's)" : '';
  if (s._broken) {
    out.push(`  ${s.name.padEnd(18)} !! will not load: ${s._broken}`);
    return out.join('\n');
  }
  if (!r) {
    out.push(`  ${s.name.padEnd(18)}${tag} (no recipe declared)`);
    if (s.describe) out.push(`    ${wrap(s.describe, 74, '    ')}`);
    return out.join('\n');
  }
  out.push(`  ${s.name}${tag}`);
  if (s._tool && typeof s._tool === 'string') out.push(`    backed by ${s._tool}`);
  out.push(`    ${wrap(r.effect, 74, '    ')}`);
  if (r.run) out.push(`    run    ${r.run}`);
  if (r.needs?.length) out.push(`    needs  ${wrap(r.needs.join('; '), 67, '           ')}`);
  if (r.cost) {
    const c = r.cost;
    const bits = [];
    if (c.time) bits.push(`time ${c.time}`);
    if (c.money) bits.push(`money ${c.money}`);
    if (c.reagents) bits.push(`reagents ${c.reagents}`);
    if (c.risk) bits.push(`risk ${c.risk}`);
    if (bits.length) out.push(`    cost   ${wrap(bits.join('; '), 67, '           ')}`);
    const prov = c.measured ? `measured ${c.measured}` : c.estimate ? `ESTIMATE — ${c.estimate}` : null;
    if (prov) out.push(`           (${wrap(prov, 65, '            ')})`);
  }
  if (full) {
    if (r.scales) out.push(`    scales ${wrap(r.scales, 67, '           ')}`);
    for (const n of r.notes ?? []) out.push(`    note   ${wrap(n, 67, '           ')}`);
  }
  return out.join('\n');
}

const scripts = await loadAll();

// Capabilities that are TOOLS rather than fleetscripts. They are in the book because leaving
// them out would make it wrong about what the fleet can do; they are marked because they have
// none of the guarantees a fleetscript gets.
try {
  const { recipes } = await import('./fleetbook-recipes.mjs');
  for (const r of recipes ?? []) scripts.push({ ...r, _tool: r.backed_by ?? true });
} catch { /* the book still works without them, and says nothing it cannot support */ }
scripts.sort((a, b) => a.name.localeCompare(b.name));

if (has('check')) {
  const missing = scripts.filter(s => !s.recipe && !s._broken).map(s => s.name);
  if (missing.length) {
    console.error(`fleetbook: ${missing.length} script(s) have no recipe: ${missing.join(', ')}`);
    console.error('Add a `recipe` block, or the book has quietly stopped covering the fleet.');
    process.exit(1);
  }
  console.log(`fleetbook: all ${scripts.length} script(s) carry a recipe`);
  process.exit(0);
}

if (has('undeclared')) {
  const missing = scripts.filter(s => !s.recipe && !s._broken);
  console.log(missing.length ? missing.map(s => `  ${s.name}  (${s._file})`).join('\n')
                             : '  every script carries a recipe');
  process.exit(0);
}

const chosen = WANTED.length ? scripts.filter(s => WANTED.includes(s.name)) : scripts;
if (WANTED.length && !chosen.length) {
  console.error(`no such recipe: ${WANTED.join(', ')}`);
  console.error(`the book holds: ${scripts.map(s => s.name).join(', ')}`);
  process.exit(1);
}

console.log('');
console.log('THE FLEETBOOK — what to run to make something true of your characters.');
console.log('Run one with:  node tools/m59-fleet-repl.mjs   then type the line under `run`.');
console.log('');
for (const s of chosen) { console.log(render(s, { full: WANTED.length > 0 })); console.log(''); }
if (!WANTED.length) console.log('One recipe in full:  node tools/m59-fleetbook.mjs <name>');
