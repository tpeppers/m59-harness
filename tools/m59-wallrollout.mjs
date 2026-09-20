#!/usr/bin/env node
// IS THE NEW SAFE-WALL DEFINITION GOING WELL? ONE COMMAND, AND IT IS ALLOWED TO SAY NO.
//
//   node tools/m59-wallrollout.mjs              the verdict
//   node tools/m59-wallrollout.mjs --json       the same, for a tool
//   node tools/m59-wallrollout.mjs --verbose    every counterexample, not just the count
//
// WHAT WENT OUT, 2026-09-20, and therefore what could go wrong:
//
//   * `safeWalls()` dropped the `free_shots > 0` clause. Membership changed by FOUR squares
//     in 264 rooms, and all four turned out to be isolated islands with no walkable
//     neighbour, so the practical effect is nil. This is the least of it.
//   * The safe-spot ledger was retired: no reads, no writes, no per-square history.
//     `discredited()` was already `return false` beforehand, so admission did not change.
//   * THE ONE THAT ACTUALLY CHANGES BEHAVIOUR: m59-bt-combat now ranks shelters by
//     DISTANCE rather than by `free_shots`. Every shelter choice on that path can differ,
//     and "nearest" could be trading a good wall for a close one.
//
// So this does not try to prove the definition again — tools/m59-wallproof.mjs did that in
// play. It watches for the rollout going wrong, which is a different question, and it
// refuses to answer it from the wrong evidence.
//
// FOUR CHECKS, AND ONLY ONE OF THEM CAN FALSIFY THE MODEL.
//
//   1  EPOCH      Is the evidence about the code now running? A `safespots` epoch older
//                 than the change means restwatch is blending rows recorded under the old
//                 definition with rows under the new one, and every number below it is
//                 uninterpretable. This is reported FIRST because it invalidates the rest.
//   2  VIOLATIONS The falsification test, in production: damage taken while resting, not
//                 swinging, settled, not ailing. m59-restwatch.mjs already records exactly
//                 this and may never be read by anything that chooses a square — so it is
//                 read here, where nothing chooses anything.
//   3  DEATHS     Deaths on squares the new definition calls safe walls, split by whether
//                 the body had ever swung. A death on a wall is NOT a counterexample if it
//                 swung: that is the contract. A death on a wall by a body that never swung
//                 is the thing that would sink this.
//   4  REACH      The bake calls ~2.5% of real standing ground unwalkable, so those squares
//                 can never be offered as walls at all. Tracked because it caps how much
//                 good the definition can do, and because it is the likeliest explanation
//                 for a wall that "should" have been offered and was not.
//
// WHAT THIS DELIBERATELY DOES NOT DO: compare death RATE before and after. The fleet's
// death rate moves with what it is hunting, how many keepers are up, and which rooms
// `spread` chose that hour. Attributing a change in it to this rollout would be the same
// error the retired ledger made — reading an afternoon as a fact about geometry.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { geometryFor, safeWalls, hasAnyFooting } from './m59-safespots.mjs';
import { epochFor } from './m59-epoch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUB = join(HERE, '..', 'substrate');
const argv = process.argv.slice(2);
const has = f => argv.includes('--' + f);

// ── 1. EPOCH ──────────────────────────────────────────────────────────────────────────────
//
// The definition changed in 8da4210. If the `safespots` epoch predates that, restwatch is
// counting rows from before the change as though they were about the code now running —
// which is the exact disease m59-epoch.mjs exists to prevent, and it is easy to cause by
// tagging a commit `#movement` and forgetting that a safe wall is its own domain.
function epochCheck() {
  let spots = null, movement = null;
  try { spots = epochFor('safespots'); } catch {}
  try { movement = epochFor('movement'); } catch {}
  return { spots, movement, ok: !!spots };
}

// ── 2. VIOLATIONS ─────────────────────────────────────────────────────────────────────────
function restwatch() {
  const f = join(SUB, 'restwatch.jsonl');
  if (!existsSync(f)) return { present: false };
  const rows = readFileSync(f, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean);
  const epoch = epochCheck().spots?.id ?? null;
  const mine = epoch ? rows.filter(r => (r.epoch?.id ?? r.epoch ?? null) === epoch) : rows;
  const by = {};
  for (const r of mine) by[r.outcome ?? 'unknown'] = (by[r.outcome ?? 'unknown'] ?? 0) + 1;
  // A VIOLATION IS ONLY EVIDENCE IF THE BODY WAS ON THE SQUARE THE ROW NAMES.
  //
  // Rows written before 2026-09-20 carry no `off_by`, because the writer recorded the
  // keeper's RESERVED square and never asked where the body was — the same defect that
  // retired the old safe-spot book. The first three violations after this rule reached prod
  // named 10,29 / 21,4 / 21,10 in room 554 while the body stood at 14,31. Those cannot be
  // counted against the model, and they cannot be waved away either; they are simply not
  // about squares. So they are separated here rather than summed.
  const v = mine.filter(r => r.outcome === 'violation');
  return { present: true, total: rows.length, thisEpoch: mine.length, by,
           violations: v.filter(r => r.off_by === 0),
           unattributable: v.filter(r => r.off_by !== 0),
           blindAiling: mine.filter(r => r.ailing_known === false).length };
}

// ── 3. DEATHS ON WALLS, SPLIT BY WHETHER THE BODY EVER SWUNG ──────────────────────────────
function deaths() {
  const dir = join(SUB, 'postmortems');
  if (!existsSync(dir)) return { present: false };
  const map = JSON.parse(readFileSync(join(SUB, 'm59-map.json'), 'utf8'));
  const byNum = new Map();
  for (const r of Object.values(map.rooms ?? map)) if (r?.num != null) byNum.set(Number(r.num), r);
  const cache = new Map();
  const wallsOf = n => {
    if (cache.has(n)) return cache.get(n);
    let set = null; const r = byNum.get(n);
    if (r) { let g; try { g = geometryFor(r) } catch {}
             if (g?.collisionReady) set = new Set(safeWalls(g).map(w => `${w.row},${w.col}`)); }
    cache.set(n, set); return set;
  };
  const out = { present: true, total: 0, placed: 0, onWall: 0,
                swung: 0, neverSwung: 0, unknown: 0, cases: [] };
  for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) {
    let j; try { j = JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch { continue }
    out.total++;
    const w = j.where; if (!w || w.num == null || w.col == null || w.row == null) continue;
    const set = wallsOf(w.num); if (!set) continue;
    out.placed++;
    if (!set.has(`${w.row},${w.col}`)) continue;
    out.onWall++;
    const was = j.was ?? {};
    // THE THREE-WAY SPLIT THIS ROLLOUT ADDED `ever_swung` FOR. Before it, `swinging:false`
    // with a null age meant either "never swung" or "no frame", and only the first is
    // evidence. A row that cannot say is counted as UNKNOWN and never as a counterexample.
    const ms = Number.isFinite(was.ms_since_swung) ? was.ms_since_swung : null;
    if (was.swinging === true || (ms != null && ms <= 12_000)) out.swung++;
    else if (was.ever_swung === false) {
      out.neverSwung++;
      out.cases.push({ who: j.character, room: w.num, at: `${w.col},${w.row}`,
                       killed_by: j.summary?.killed_by ?? null, ms_since_swung: ms });
    } else if (was.ever_swung === true && ms != null) out.swung++;
    else out.unknown++;
  }
  return out;
}

// ── 4. REACH: squares the bake cannot offer ───────────────────────────────────────────────
//
// Measured against real observed standing positions when a wallproof recording is present,
// because that is the only source that says where bodies ACTUALLY stood. Without one this
// reports absent rather than guessing.
function reach() {
  const f = join(SUB, 'wallproof.jsonl');
  if (!existsSync(f)) return { present: false };
  const map = JSON.parse(readFileSync(join(SUB, 'm59-map.json'), 'utf8'));
  const geo = {};
  for (const r of Object.values(map.rooms ?? map)) if (r?.num != null) { try { geo[Number(r.num)] = geometryFor(r) } catch {} }
  const stood = new Map();
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line) } catch { continue }
    if (r.type !== 'look' || r.room == null) continue;
    stood.set(`${r.room}:${r.col},${r.row}`, { room: r.room, col: r.col, row: r.row });
  }
  let bad = 0, checked = 0; const which = [];
  for (const s of stood.values()) {
    const g = geo[s.room]; if (!g) continue;
    checked++;
    let ok = true; try { ok = g.walkable(s.row, s.col) } catch { continue }
    if (!ok) { bad++; which.push(`${s.room}:${s.col},${s.row}`); }
  }
  return { present: true, checked, bad, pct: checked ? (100 * bad / checked) : 0, which };
}

// ── 5. ISLANDS: shelter with nowhere to step in from ──────────────────────────────────────
//
// A square whose eight neighbours are all void cannot be entered by anything that has to be
// standing somewhere first. The reachability flood does not catch these on its own —
// `moverStepLands` reports whether a STEP LANDS without asking whether the square it departs
// from is ground — so in Ukgoth, the fleet's worst room for deaths, r18c50 came back
// "reachable" from seven neighbours that are all void. Counted here so that the selector's
// refusal to offer them cannot regress silently.
function islands() {
  const map = JSON.parse(readFileSync(join(SUB, 'm59-map.json'), 'utf8'));
  let offered = 0, total = 0; const which = [];
  for (const r of Object.values(map.rooms ?? map)) {
    if (r?.num == null) continue;
    let g; try { g = geometryFor(r) } catch { continue }
    if (!g?.collisionReady) continue;
    for (const w of safeWalls(g)) {
      total++;
      if (!hasAnyFooting(g, w.row, w.col)) { offered++; which.push(`${r.num}:${w.col},${w.row}`); }
    }
  }
  return { total, offered, which };
}

// ── report ────────────────────────────────────────────────────────────────────────────────
const E = epochCheck(), R = restwatch(), D = deaths(), X = reach(), I = islands();
const CHANGED_IN = '8da4210';              // the commit that dropped the free-shot clause

const findings = [];
const stale = E.spots && E.movement && E.spots.at && E.movement.at &&
              new Date(E.spots.at) < new Date(E.movement.at);

if (has('json')) {
  console.log(JSON.stringify({ epoch: E, restwatch: R, deaths: D, reach: X, islands: I }, null, 1));
  process.exit(0);
}

console.log('SAFE-WALL ROLLOUT — is it going well?\n');

console.log('1. EPOCH — is the evidence about the code now running?');
console.log(`   safespots  ${E.spots?.id ?? '(none)'}  ${String(E.spots?.subject ?? '').slice(0, 58)}`);
console.log(`   movement   ${E.movement?.id ?? '(none)'}  ${String(E.movement?.subject ?? '').slice(0, 58)}`);
if (stale) {
  findings.push('BLOCKER: the safespots epoch predates the movement epoch, so the definition ' +
                'changed without the safe-wall evidence resetting. Every restwatch number below ' +
                'is blending two definitions. Commit with #safespots to roll it.');
  console.log('   ** STALE ** the definition changed after this epoch was declared.');
} else console.log('   ok — safe-wall evidence is scoped to the current definition.');

console.log('\n2. VIOLATIONS — damage while resting, not swinging, settled, not ailing');
if (!R.present) console.log('   no restwatch.jsonl on this machine — nothing to read yet.');
else {
  console.log(`   ${R.thisEpoch} row(s) in this epoch (${R.total} in the file)`);
  for (const [k, v] of Object.entries(R.by).sort((a, b) => b[1] - a[1]))
    console.log(`     ${String(v).padStart(5)}  ${k}`);
  if (!R.thisEpoch) findings.push('No restwatch rows in this epoch yet — the falsification ' +
                                  'test has no observations, so it is not passing, it is silent.');
  else {
    if (R.unattributable?.length) {
      console.log(`   ${R.unattributable.length} violation(s) NOT COUNTED: the body was not on the`);
      console.log('   square the row names, so the row is about a keeper\'s reservation and not');
      console.log('   about a square. Rows written before 2026-09-20 have no position at all.');
      for (const v of R.unattributable.slice(0, has('verbose') ? 50 : 3))
        console.log(`      room ${v.room ?? '?'} names ${v.col},${v.row}` +
                    (v.at ? `, body at ${v.at.col},${v.at.row} (off by ${v.off_by})` : ', position unrecorded'));
    }
    if (R.blindAiling) {
      findings.push(`${R.blindAiling} row(s) recorded ailing:false without being able to check — ` +
                    '`client.ailments()` is absent on this build, so poison cannot be excluded ' +
                    'from the violation column on those rows.');
    }
    if (R.violations.length) {
      findings.push(`${R.violations.length} VIOLATION(S) WITH THE BODY CONFIRMED ON THE SQUARE: ` +
                    'damage taken resting on a wall without swinging. That is the one ' +
                    'observation that sinks the model.');
      for (const v of R.violations.slice(0, has('verbose') ? 50 : 5))
        console.log(`   !! room ${v.room ?? '?'} ${v.col},${v.row}  damage ${v.damage}  rested ${v.rested_ms}ms`);
    }
  }
}

console.log('\n3. DEATHS ON SAFE WALLS — the contract says a death here means it swung');
if (!D.present) console.log('   no postmortems directory.');
else {
  console.log(`   ${D.onWall} of ${D.placed} placed deaths were on a square the definition calls a wall`);
  console.log(`     ${String(D.swung).padStart(5)}  had swung        — the contract, not a leak`);
  console.log(`     ${String(D.neverSwung).padStart(5)}  NEVER swung      — would be counterexamples`);
  console.log(`     ${String(D.unknown).padStart(5)}  cannot say       — written before ever_swung existed`);
  if (D.unknown > D.swung + D.neverSwung)
    console.log('   (most of the corpus predates the ever_swung flag, so this check gets sharper\n' +
                '    as deaths accumulate rather than being meaningful today)');
  if (D.neverSwung) {
    findings.push(`${D.neverSwung} death(s) on a safe wall by a body that NEVER swung. Each one ` +
                  'is a candidate counterexample and wants reading individually.');
    for (const c of D.cases.slice(0, has('verbose') ? 50 : 6))
      console.log(`   !! ${String(c.who).padEnd(8)} room ${String(c.room).padEnd(5)} ${c.at}  killed by ${c.killed_by ?? '?'}`);
  }
}

console.log('\n4. REACH — ground the bake cannot offer as a wall');
if (!X.present) console.log('   no wallproof recording; run m59-wallproof.mjs --collect to measure this.');
else {
  console.log(`   ${X.bad} of ${X.checked} observed standing squares fail geo.walkable() (${X.pct.toFixed(1)}%)`);
  if (X.bad) console.log('   these can never be offered as safe walls, whatever the definition says:');
  for (const w of X.which.slice(0, has('verbose') ? 50 : 6)) console.log(`      ${w}`);
  if (X.pct > 5) findings.push(`${X.pct.toFixed(1)}% of real standing ground is invisible to the ` +
                               'bake, which caps how much shelter can ever be offered.');
}

console.log('\n5. ISLANDS — safe walls with nowhere to step in from');
console.log(`   ${I.offered} of ${I.total} safe walls have no adjacent ground`);
for (const w of I.which.slice(0, has('verbose') ? 50 : 6)) console.log(`      ${w}`);
if (I.offered) {
  console.log('   (genuine walls — nothing can reach them, including us. The selector refuses');
  console.log('    to offer them; this line is here so that refusal cannot regress silently.)');
}

console.log('\n──────── VERDICT ────────');
if (!findings.length) {
  console.log('  NOTHING IS GOING WRONG that this can see.');
  console.log('  The model has not been falsified in production, and no death on a wall is');
  console.log('  unexplained by the swing contract.');
} else {
  for (const f of findings) console.log('  * ' + f);
}
console.log('\n  What this cannot tell you: whether ranking shelters by DISTANCE rather than');
console.log('  free_shots was an improvement. That is the one change with real behavioural');
console.log('  reach, and separating it from what the fleet happened to be hunting needs an');
console.log('  A/B on the shadow fleet, not a read of production.');
process.exit(findings.some(f => /BLOCKER|VIOLATION|NEVER swung/.test(f)) ? 1 : 0);
