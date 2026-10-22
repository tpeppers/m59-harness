#!/usr/bin/env node
// ARCHIVING CANNOT BREAK A LIVE IMPORT, AND REVIVING AN OLD POSTURE PUTS ITS MODULES BACK.
//
//   node tools/m59-substrate-archive-test.mjs
//
// Offline: no broker, no socket, no fleet. Every case builds a scratch substrate in a temp
// directory and points m59-substrate-archive.mjs (and the loaders that use it) at that.
//
// THE INCIDENT, 2026-10-21: ~630 files moved out of prod-deploy/substrate/ with a bare `mv`.
// bastion.mjs's seven guard imports went with them (keepers ran FleeTA for hours reporting
// "bastion"), the courier lap would not import, chalice-farming read as "off", and cv-lockdown
// stayed broken. Each case below pins one half of the fix.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  parseImports, buildGraph, planMove, applyMove, checkSubstrate, planRestore, applyRestore,
  resolveRestoreTarget, importWithAutoRestore,
} from './m59-substrate-archive.mjs';
import { loadFleetScripts } from './m59-fleetlib.mjs';
import { PvpStrategyHost } from './m59-pvp-strategy.mjs';
import { load as loadStrategies } from './m59-strategies.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` -- ${extra}` : ''}`); }
};
const quiet = () => {};
const roots = [];
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), 'm59-subarch-'));
  roots.push(root);
  const sub = join(root, 'substrate');
  mkdirSync(sub, { recursive: true });
  const put = (rel, text) => { const p = join(sub, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); return p; };
  return { root, sub, put, has: rel => existsSync(join(sub, rel)) };
};
const ARCH = 'scratch/archive-2026-10-21/substrate';

// --- the parser -----------------------------------------------------------------------------
{
  // Fixture lines spell the quote as @ so m59-imports-test, which scans this file's TEXT, does not
  // read them as real imports of tools/multi.mjs and friends.
  const specs = parseImports([
    "import { a } from @../guard.mjs?v=8@;",
    "import def, {\n  b,\n  c as d } from @./multi.mjs@;",
    "import @./side.mjs@;",
    "export { x } from @./re.mjs@;",
    "export * from @./star.mjs@;",
    "const m = await import(@./dyn.mjs@);",
    "const n = await import(new URL(@../dyn2.mjs?v=1@, import.meta.url).href);",
    "const u = new URL(@urlref.mjs@, import.meta.url);",
    "// import { gone } from @./commented.mjs@;",
    " * import { gone } from @./jsdoc.mjs@;",
    "import fs from @node:fs@;",
    "const t = import(`./tpl-${name}.mjs`);",
  ].join('\n').replace(/@/g, "'")).map(i => i.spec);
  ok('a ?v= query import is an edge', specs.includes('../guard.mjs?v=8'));
  ok('a multi-line static import is an edge', specs.includes('./multi.mjs'));
  ok('a side-effect import is an edge', specs.includes('./side.mjs'));
  ok('export ... from is an edge (named and star)', specs.includes('./re.mjs') && specs.includes('./star.mjs'));
  ok('dynamic import of a literal is an edge', specs.includes('./dyn.mjs'));
  ok('dynamic import of new URL(literal, import.meta.url) is an edge', specs.includes('../dyn2.mjs?v=1'));
  ok('new URL(\'x.mjs\', import.meta.url) is an edge, made relative', specs.includes('./urlref.mjs'));
  ok('a commented-out import is not an edge', !specs.includes('./commented.mjs') && !specs.includes('./jsdoc.mjs'));
  ok('a template with ${} cannot be followed and is not invented', !specs.some(s => s.includes('tpl')));
}

// --- move is refused while imported --------------------------------------------------------
{
  const t = fresh();
  t.put('production-guard.mjs', 'export const g = 1;\n');
  t.put('pvp-strategies/bastion.mjs', "import { g } from '../production-guard.mjs?v=3';\nexport default { decide() { return null; } };\n");
  t.put('fleetscripts/lap.mjs', "export const script = {}; const p = () => import('../production-dyn.mjs');\n");
  t.put('production-dyn.mjs', 'export const d = 1;\n');
  t.put('clutter.log', 'old\n');
  let p = planMove(t.sub, ['production-guard.mjs', 'clutter.log']);
  ok('move refused when a live file imports (via ?v=) one of the set', !p.ok && p.blockers.length === 1);
  ok('the refusal names the importer', p.blockers[0]?.importers.some(i => /bastion\.mjs$/.test(i)));
  p = planMove(t.sub, ['production-dyn.mjs']);
  ok('move refused when the only importer is a dynamic import()', !p.ok && p.blockers[0]?.importers.some(i => /lap\.mjs$/.test(i)));
  ok('a refused plan cannot be applied', (() => { try { applyMove(p); return false; } catch { return true; } })());
  ok('a refused move moved nothing', t.has('production-guard.mjs') && t.has('production-dyn.mjs'));

  p = planMove(t.sub, ['clutter.log']);
  ok('an unreferenced file may move', p.ok);
  applyMove(p);
  ok('it moved keeping its relative path, MOVED.txt and README written',
    !t.has('clutter.log') && existsSync(join(p.dest, 'substrate', 'clutter.log'))
    && /substrate\/clutter\.log/.test(readFileSync(join(p.dest, 'MOVED.txt'), 'utf8')) && existsSync(join(p.dest, 'README.txt')));

  // --with-importers: the whole closure goes, and the file that stays behind is still whole.
  p = planMove(t.sub, ['production-guard.mjs'], { withImporters: true, to: 'scratch/archive-2026-10-22' });
  ok('--with-importers archives the closure (the guard and bastion)', p.ok && p.closure.length === 2
    && p.closure.some(f => /bastion\.mjs$/.test(f)));
  // ...unless a strategy assignment names the importer by name.
  t.put('pvp-strategy-prod.json', JSON.stringify({ default: { strategy: 'bastion', options: {} } }));
  p = planMove(t.sub, ['production-guard.mjs'], { withImporters: true, to: 'scratch/archive-2026-10-22' });
  ok('a closure member named by a pvp assignment is refused, and the config is named',
    !p.ok && p.blockers.some(b => b.configs.some(c => c.kind === 'pvp' && c.name === 'bastion')));
  rmSync(join(t.sub, 'pvp-strategy-prod.json'));
  p = planMove(t.sub, ['production-guard.mjs'], { withImporters: true, to: 'scratch/archive-2026-10-22' });
  applyMove(p);
  ok('the closure moved together', !t.has('production-guard.mjs') && !t.has('pvp-strategies/bastion.mjs'));
  ok('after a closure move, check finds nothing broken', checkSubstrate({ substrate: t.sub }).broken.length === 0);
  ok('--to outside scratch/archive-* is refused', !planMove(t.sub, ['production-dyn.mjs'], { to: 'elsewhere' }).ok);
}

// --- farm strategy assignment and extra strategy directories -------------------------------
{
  const t = fresh();
  const priv = join(t.root, 'private', 'pvp-strategies');
  mkdirSync(priv, { recursive: true });
  writeFileSync(join(priv, 'fleeta.mjs'), "import { x } from '../../substrate/production-shared.mjs';\nexport default {};\n");
  t.put('pvp-strategy-dirs.json', JSON.stringify({ dirs: [priv] }));
  t.put('production-shared.mjs', 'export const x = 1;\n');
  t.put('farm-strategies/trolls.mjs', 'export default {};\n');
  t.put('keeper-t1.json', JSON.stringify({ policy: { farm_strategy: 'trolls' } }));
  let p = planMove(t.sub, ['production-shared.mjs']);
  ok('an importer in an extra strategy directory (pvp-strategy-dirs.json) blocks the move',
    !p.ok && p.blockers[0]?.importers.some(i => /fleeta\.mjs$/.test(i)));
  p = planMove(t.sub, ['farm-strategies/trolls.mjs']);
  ok('a farm strategy named by a farm_strategy value blocks the move',
    !p.ok && p.blockers[0]?.configs.some(c => c.kind === 'farm' && c.name === 'trolls'));
  p = planMove(t.sub, ['production-shared.mjs'], { withImporters: true });
  ok('--with-importers cannot take an importer outside the substrate, so it still refuses', !p.ok);
}

// --- check, restore -------------------------------------------------------------------------
{
  const t = fresh();
  t.put('fleetscripts/cv-lockdown.mjs', "import { CV_FARM } from '../cv-lockdown-farm.mjs';\nexport const script = {};\n");
  t.put(`${ARCH}/cv-lockdown-farm.mjs`, "import { y } from './lib/farm-helper.mjs?v=2';\nexport const CV_FARM = 1;\n");
  t.put(`${ARCH}/lib/farm-helper.mjs`, 'export const y = 2;\n');
  t.put('scratch/archive-2026-10-20/substrate/cv-lockdown-farm.mjs', 'export const CV_FARM = 0; // older\n');
  t.put('fleetscripts/orphan.mjs', "import { z } from '../never-archived.mjs';\n");
  t.put('pvp-strategy-prod.json', JSON.stringify({ agents: { t9: 'oldposture' } }));
  t.put(`scratch/archive-2026-10-21/substrate/pvp-strategies/oldposture.mjs`, 'export default { decide() { return null; } };\n');
  const r = checkSubstrate({ substrate: t.sub });
  const cv = r.broken.find(b => b.spec === '../cv-lockdown-farm.mjs');
  ok('check finds the broken import', !!cv);
  ok('check names the newest archived copy first', /archive-2026-10-21/.test(cv?.archived[0]?.path ?? '') && cv?.archived.length === 2);
  ok('check reports an import with no archived copy as such', r.broken.some(b => b.spec === '../never-archived.mjs' && !b.archived.length));
  ok('check reports a pvp assignment naming an archived strategy', r.configs.some(c => c.name === 'oldposture' && c.archived.length === 1));

  const target = resolveRestoreTarget(t.sub, 'cv-lockdown-farm').target;
  ok('restore resolves a bare module name', target === join(t.sub, 'cv-lockdown-farm.mjs'));
  const plan = planRestore(t.sub, [target]);
  ok('restore is transitive: the module and its own archived import', plan.moves.length === 2
    && plan.moves.some(m => /farm-helper\.mjs$/.test(m.to)));
  ok('restore takes from the newest archive', plan.moves.every(m => /archive-2026-10-21/.test(m.from)));
  const done = applyRestore(t.sub, plan);
  ok('restore put both back at their original paths', done.restored.length === 2 && t.has('cv-lockdown-farm.mjs') && t.has('lib/farm-helper.mjs'));
  ok('restore removed the archived copy and logged RESTORED.txt',
    !existsSync(join(t.sub, ARCH, 'cv-lockdown-farm.mjs')) && existsSync(join(t.sub, 'scratch/archive-2026-10-21/RESTORED.txt')));
  // Refuses to overwrite: the older archive still holds a copy; restoring it again must not clobber.
  const again = planRestore(t.sub, [target]);
  ok('restore of a live file plans nothing', again.moves.length === 0 && again.exists.length === 1);
  const forced = applyRestore(t.sub, { moves: [{ from: join(t.sub, 'scratch/archive-2026-10-20/substrate/cv-lockdown-farm.mjs'),
    to: target, archive: join(t.sub, 'scratch/archive-2026-10-20') }] });
  ok('restore refuses to overwrite an existing file', forced.restored.length === 0 && /overwrite/.test(forced.refused[0]?.why ?? '')
    && !/older/.test(readFileSync(target, 'utf8')));
  const outside = applyRestore(t.sub, { moves: [{ from: join(t.root, 'elsewhere.mjs'), to: join(t.sub, 'x.mjs'), archive: t.root }] });
  ok('restore refuses a source outside scratch/archive-*', outside.restored.length === 0 && /outside/.test(outside.refused[0]?.why ?? ''));
  ok('check is clean of the restored import afterwards', !checkSubstrate({ substrate: t.sub }).broken.some(b => b.spec === '../cv-lockdown-farm.mjs'));
}

// --- importWithAutoRestore: the shared core ------------------------------------------------
{
  const t = fresh();
  const entry = t.put('fleetscripts/x.mjs', "import { a } from '../a.mjs';\nimport { b } from '../b.mjs';\nexport const v = a + b;\n");
  t.put(`${ARCH}/a.mjs`, 'export const a = 1;\n');
  t.put(`${ARCH}/b.mjs`, 'export const b = 2;\n');
  const logs = [];
  const { mod, restored } = await importWithAutoRestore(new URL(`file:///${entry.replace(/\\/g, '/')}`).href, { log: m => logs.push(m) });
  ok('every missing import is restored in one pass, not only the first the error named', mod?.v === 3 && restored?.restored.length === 2);
  ok('the restore is logged loudly', logs.filter(l => /AUTO-RESTORED/.test(l)).length === 2);
}

// --- fleetlib: a fleetscript whose import was archived loads after an automatic restore -----
{
  const t = fresh();
  t.put('fleetscripts/zheng-he-lap.mjs',
    "import { posture } from '../production-robin-guild-posture.mjs';\n" +
    "export const script = { name: 'zheng-he-lap', steps: () => [], posture };\n");
  t.put(`${ARCH}/production-robin-guild-posture.mjs`, "export const posture = 'guild';\n");
  t.put('fleetscripts/hopeless.mjs', "import { q } from '../gone-for-good.mjs';\nexport const script = { steps: () => [] };\n");
  const logs = [];
  const r = await loadFleetScripts({ dirs: [['local', join(t.sub, 'fleetscripts')]], log: m => logs.push(m) });
  ok('fleetlib: the script imports after the auto-restore and retry', r.scripts.get('zheng-he-lap')?.posture === 'guild');
  ok('fleetlib: the restored module is back at its original path', t.has('production-robin-guild-posture.mjs'));
  ok('fleetlib: the restore is reported and logged', r.restored.length === 1 && logs.some(l => /AUTO-RESTORED/.test(l)));
  const h = r.problems.find(p => /hopeless/.test(p.file));
  ok('fleetlib: with no archived copy the error stands, with the check hint', !!h && /will not import/.test(h.why) && /substrate-archive\.mjs check/.test(h.why));
}

// --- pvp strategy: refresh restores, and a stale module is loud ----------------------------
{
  const t = fresh();
  const dir = join(t.sub, 'pvp-strategies');
  const file = join(t.sub, 'pvp-strategy-prod.json');
  const env = { M59_PVP_STRATEGY_DIR: dir, M59_PVP_STRATEGY_FILE: file, M59_PVP_STRATEGY_DIRS_FILE: join(t.sub, 'none.json') };
  t.put('pvp-strategies/fleeta.mjs', "export default { decide() { return { do: 'flee_to', room: 38 }; } };\n");
  t.put('pvp-strategies/bastion.mjs', "import { ROOM } from '../production-bastion-guard.mjs?v=8';\nexport default { decide() { return { do: 'flee_to', room: ROOM }; } };\n");
  t.put(`${ARCH}/production-bastion-guard.mjs`, 'export const ROOM = 599;\n');
  t.put('pvp-strategies/doomed.mjs', "import { Q } from '../production-never-archived.mjs';\nexport default { decide() { return null; } };\n");
  let now = 1000;
  const logs = [];
  const host = new PvpStrategyHost({ fleet: 'prod', agent: 't1', character: 'Tester', env, now: () => now++, log: m => logs.push(m) });
  const assign = name => { writeFileSync(file, JSON.stringify({ default: name })); now += 10; };
  assign('fleeta');
  let s = await host.refresh();
  ok('pvp: fleeta loads', s.loaded && s.loaded_strategy === 'fleeta' && !s.stale);
  await new Promise(r => setTimeout(r, 20));
  assign('bastion');
  s = await host.refresh();
  ok('pvp: bastion loads after its archived guard is auto-restored', s.loaded && s.loaded_strategy === 'bastion' && !s.error,
    JSON.stringify(s.error));
  ok('pvp: status says what was restored', /production-bastion-guard\.mjs/.test(s.last_restore?.summary ?? ''));
  ok('pvp: the guard is back in the substrate', t.has('production-bastion-guard.mjs'));
  ok('pvp: the restored module answers', host.decide('attacked_by_player', { player: 'X' })?.room === 599);
  await new Promise(r => setTimeout(r, 20));
  assign('doomed');
  s = await host.refresh();
  ok('pvp: with nothing archived, the configured and LOADED strategies differ, and status says so',
    s.strategy === 'doomed' && s.loaded_strategy === 'bastion' && s.stale === true && /CONFIGURED "doomed" BUT RUNNING "bastion"/.test(s.warning ?? ''));
  ok('pvp: the error names what is missing', /production-never-archived\.mjs/.test(s.error ?? '') && /substrate-archive\.mjs check/.test(s.error ?? ''));
  ok('pvp: the stale state is logged loudly', logs.some(l => /LOUD/.test(l) && /RUNNING "bastion"/.test(l)));
  const d = host.decide('attacked_by_player', { player: 'X' });
  ok('pvp: a decision made by the stale module carries the module that answered', d?.strategy === 'bastion' && d?.configured_strategy === 'doomed');
}

// --- m59-strategies.mjs: chalice-farming's archived import comes back --------------------
{
  const t = fresh();
  t.put('strategies/chalice-farming.mjs',
    "import { posture } from '../production-robin-guild-posture.mjs';\n" +
    "export default { name: 'chalice-farming', kind: 'town', enabled: true, describe: posture, chalice() { return null; } };\n");
  t.put(`${ARCH}/production-robin-guild-posture.mjs`, "export const posture = 'guild';\n");
  t.put('strategies/broken.mjs', "import { q } from '../never.mjs';\nexport default {};\n");
  const g = buildGraph({ substrate: t.sub });
  ok('substrate/strategies/ is in the import graph', [...g.nodes.values()].some(n => n && /chalice-farming\.mjs$/.test(n.file)));
  const logs = [];
  const r = await loadStrategies({ dir: join(t.sub, 'strategies'), log: m => logs.push(m) });
  const ch = r.strategies.find(s => s.name === 'chalice-farming');
  ok('strategies: chalice-farming loads after the auto-restore', ch?.describe === 'guild',
    JSON.stringify(r.problems));
  ok('strategies: the restore is recorded', r.restored.some(x => /chalice/.test(x.file)) && t.has('production-robin-guild-posture.mjs'));
  ok('strategies: a load that still fails is logged loudly, not only listed', logs.some(l => /broken\.mjs DID NOT LOAD/.test(l)));
}

for (const r of roots) rmSync(r, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
