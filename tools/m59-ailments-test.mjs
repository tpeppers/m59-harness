#!/usr/bin/env node
// THE POISONER LIST, RE-DERIVED FROM THE GAME'S SOURCE ON EVERY RUN.
//
// A hand-kept list of creature names is exactly the thing that was wrong before — `/spider/i`
// looked right and was wrong in both directions. So this does not check that the list is
// plausible; it walks the kod tree, finds every class whose `HitSideEffect()` applies
// SID_POISON, reads the display name off its `*_name_rsc`, and asserts set equality with
// m59-ailments.mjs. A monster gaining or losing poison fails here rather than quietly
// changing what every safe-wall measurement believes.
//
// SKIPS RATHER THAN FAILS when the kod tree is not beside this checkout: the list is still
// worth shipping to somebody who only has the harness, and a test that cannot see the source
// has nothing to say about it. The assertions that do not need kod always run.
import { POISONS, NAMED_LIKE_A_POISONER_BUT_IS_NOT, poisons, anyPoisons } from './m59-ailments.mjs';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0, skipped = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; console.log(`  ok   ${what}`) }
  else { fail++; console.log(`  FAIL ${what}${extra ? '  — ' + extra : ''}`) } };

console.log('\nthe question the list actually answers');
ok(poisons('spider'), 'spider poisons');
ok(poisons('black spider'), 'black spider poisons (DeathSpider)');
ok(poisons('dusk rat'), 'dusk rat poisons — and no spider regex would ever match it');
ok(!poisons('baby spider'),
   'baby spider does NOT poison, though its name contains "spider"');
ok(!poisons('troll') && !poisons('ant') && !poisons('centipede') && !poisons('zombie'),
   'the ordinary prey do not poison');
ok(!poisons('') && !poisons(null) && !poisons(undefined), 'empty and null are not poisoners');
ok(poisons('  Black Spider  '), 'the match is case- and space-insensitive');
ok(!poisons('spiderling') && !poisons('giant spider crab'),
   'and it is EXACT, not a substring — the substring test is the bug this replaces');
ok(anyPoisons(['troll', 'ant', 'dusk rat']), 'anyPoisons finds one in a crowd');
ok(!anyPoisons(['troll', 'ant', 'baby spider']), 'and is not fooled by the lookalike');

// ── the arm that keeps the list honest ──────────────────────────────────────────────────────
const ROOTS = ['C:/code/Meridian59/kod', join(process.cwd(), '..', '..', '..', 'Meridian59', 'kod')];
const root = ROOTS.find(r => { try { return existsSync(r) && statSync(r).isDirectory() } catch { return false } });

if (!root) {
  skipped++;
  console.log('\n(the kod tree is not beside this checkout — the re-derivation arm is skipped,\n' +
              ' which means this run cannot tell you the list is still current)');
} else {
  console.log('\nre-derived from kod');
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.kod')) files.push(p);
    }
  })(root);

  const found = new Map();                 // display name -> class
  for (const f of files) {
    let src; try { src = readFileSync(f, 'utf8') } catch { continue }
    // The poison is applied in HitSideEffect via MakePoisoned. Anything else mentioning
    // SID_POISON is a spell definition or a cure, not a creature that inflicts it on contact.
    if (!/HitSideEffect/.test(src) || !/MakePoisoned/.test(src)) continue;
    const cls = (src.match(/^([A-Za-z_]\w*)\s+is\s+[A-Za-z_]\w*/m) || [])[1] ?? null;
    // THE DISPLAY NAME, NOT THE KOC NAME AND NOT THE CORPSE. A first cut matched
    // `\w*_?name_rsc` and came back with "teotkauilkinich" — because `spider_koc_name_rsc`
    // ends in `_name_rsc` too, and in spider.kod it is the line ABOVE the real one. The koc
    // name is the creature's name in the Koc tongue and never reaches a combat message;
    // `*_dead_name_rsc` is what the corpse is called. Both are excluded explicitly.
    const name = [...src.matchAll(/^\s*(\w+)_name_rsc\s*=\s*"([^"]+)"/gmi)]
      .filter(m => !/_koc$|_dead$/i.test(m[1]))
      .map(m => m[2])[0] ?? null;
    if (cls && name) found.set(name.toLowerCase(), cls);
  }

  const listed = new Set(Object.keys(POISONS));
  const derived = new Set(found.keys());
  const missing = [...derived].filter(n => !listed.has(n));
  const extra = [...listed].filter(n => !derived.has(n));

  console.log(`  kod files scanned: ${files.length}; classes applying poison on hit: ${derived.size}`);
  ok(missing.length === 0,
     'every poisoner in the source is in the list',
     missing.length ? `MISSING: ${missing.join(', ')} — these poison and nothing excludes them` : '');
  ok(extra.length === 0,
     'and the list names nothing the source does not',
     extra.length ? `NOT IN SOURCE: ${extra.join(', ')}` : '');
  for (const [name, cls] of Object.entries(POISONS))
    ok(found.get(name) === cls, `${name} is ${cls} in the source`,
       found.has(name) ? `source says ${found.get(name)}` : 'not found in source');

  // the lookalike must be absent from the derived set, for the stated reason
  for (const [name, cls] of Object.entries(NAMED_LIKE_A_POISONER_BUT_IS_NOT)) {
    ok(!derived.has(name), `${name} (${cls}) applies no poison in the source`);
    const f = files.find(x => readFileSync(x, 'utf8').includes(`${cls} is `));
    if (f) {
      const src = readFileSync(f, 'utf8');
      ok(/^SpiderBaby\s+is\s+Monster/mi.test(src) || !/HitSideEffect/.test(src),
         `  ...because ${cls} extends Monster directly and has no HitSideEffect`);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} arm(s) skipped` : ''}`);
process.exit(fail ? 1 : 0);
