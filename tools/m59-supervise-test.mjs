#!/usr/bin/env node
// THE UNSTICK MUST NOT MANUFACTURE THE STALL IT EXISTS TO CLEAR.
//
// Offline: no socket, no broker, no roster. `m59-supervise.mjs` guards its main loop on being
// the entry point, so it can be imported for its pure helpers — which is the whole reason
// `fallbackHunt` is exported.
//
// THE INCIDENT, 2026-09-19. Six prod characters were pinned on `hunt: 'living tree'` and
// re-pinned every 90 seconds. Raphael was the clean proof: geofenced into the Raza maps
// (1011-1018), hunting mummy at 1016, restarted by the stall sweep onto 'living tree' — which
// spawns only in 536 and 556, where he can never walk. That leaves him stranded, and a stranded
// character has no LIVE hunting activity, so the next sweep does it again. It survived three
// direct policy pushes and a full keeper restart before anybody looked at the supervisor.
//
// Two independent defects produced it and both are pinned here.
import { fallbackHunt } from './m59-supervise.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
};

// The engagement ceiling this fleet scales by, CLAUDE.md: floor(level/2) above own level when
// armed. It is not a safety net — it is the outer bound of what is even arguable.
const ceiling = (l) => l + Math.floor(l / 2);

console.log('--- a fallback must never exceed the engagement ceiling ---');
{
  // Every CAVE row is level 50, so `g.level > l` alone was TRUE for every character below 50
  // and the level ladder underneath was unreachable for exactly them. All six victims were
  // under 50 (20, 20, 21, 46, 47, 48); not one character over 50 carried it.
  const LIVING_TREE = 50;
  for (const l of [10, 20, 21, 25, 29, 30, 33]) {
    const got = fallbackHunt(l);
    ok(`level ${l} is not handed a level-50 tree`, got !== 'living tree', `got "${got}"`);
    ok(`  ...and level ${l}'s ceiling (${ceiling(l)}) is below 50`, ceiling(l) < LIVING_TREE);
  }
}

console.log('\n--- the ladder under CAVE is reachable again ---');
{
  // It was dead code for every character below 50. `giant rat` is the entry that was never
  // once returned, and it is the right answer for a nursery character.
  ok('a level-21 character gets giant rat', fallbackHunt(21) === 'giant rat',
     `got "${fallbackHunt(21)}"`);
  ok('a level-10 character gets giant rat', fallbackHunt(10) === 'giant rat');
  ok('a level-30 character gets fungus beast', fallbackHunt(30) === 'fungus beast',
     'ceiling 45 excludes the tree, so the ladder answers');
}

console.log('\n--- but CAVE is still used where it is genuinely in band ---');
{
  // This is not a removal. A level-47 character has a ceiling of 70 and living tree at 50 both
  // pays (50 > 47) and is survivable, which is what CAVE was written for.
  ok('a level-47 character may still be sent to living tree', fallbackHunt(47) === 'living tree',
     `ceiling ${ceiling(47)}`);
  ok('a level-49 character too', fallbackHunt(49) === 'living tree');
}

console.log('\n--- and nothing returned can fail to advance the character ---');
{
  // AdvancementCheck rolls only when monster level > base max health, so a fallback at or below
  // the character's own level is prey that cannot pay however safe it is.
  const LEVEL_OF = { 'giant rat': 30, 'fungus beast': 50, 'living tree': 50, zombie: 55,
                     'battered skeleton': 60, skeleton: 75, troll: 90 };
  let bad = [];
  for (let l = 5; l <= 95; l += 1) {
    const got = fallbackHunt(l);
    const lv = LEVEL_OF[got];
    if (lv == null) { bad.push(`${l}->${got} (unknown)`); continue; }
    if (lv <= l && l < 90) bad.push(`${l}->${got}(${lv}) cannot advance`);
  }
  ok('every fallback from 5 to 95 names prey above the character', bad.length === 0,
     bad.slice(0, 3).join('; ') || 'none');
}

console.log('\n--- the stall restart carries the policy hunt rather than inventing one ---');
{
  // `r.hunting` is the LIVE hunting activity and is empty exactly when the character is
  // stranded, which is the only time that line runs — so "we genuinely do not know" was never
  // true. The deliberate placement was in the policy the block had already read back, and
  // `hunt` is the one field KEEP_ACROSS_RESTART does not carry. Asserted against the source,
  // because the call is inside an async round that needs a live broker to exercise.
  const HERE = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(HERE, 'm59-supervise.mjs'), 'utf8');
  ok('the restart falls back to the policy hunt before fallbackHunt',
     /hunt:\s*r\.hunting\s*\|\|\s*cur\?\.policy\?\.hunt\s*\|\|\s*fallbackHunt/.test(src),
     'a deliberate placement must survive the 90s stall sweep');
  ok('fallbackHunt applies the ceiling to CAVE',
     /g\.level\s*>\s*l\s*&&\s*g\.level\s*<=\s*ceiling/.test(src));

  // A FAILED READ IS NOT PERMISSION TO INVENT ORDERS, AND THIS ONE IS SELF-AMPLIFYING.
  //
  // 2026-09-20: carrying the policy only helps when the policy can be READ. The status
  // call fails exactly when the broker is blocked, and `carriedPolicy(null)` is {} while
  // `cur?.policy?.hunt` is undefined — so the restart rebuilt from DEFAULTS plus a
  // level-guessed hunt, which is the thing the carry exists to prevent. Beaker took 232
  // hunt flips against 56 for the next worst, each one two full 128KB roster writes
  // (rememberAutopilot AND saveFleetState). The broker hit a 2.5GB working set, 1481s of
  // CPU in 28 minutes, an 85s /health, and could no longer reach keepers that answered a
  // direct probe in 72ms. The storm starves the reads that would have stopped it.
  ok('a restart is SKIPPED when the policy could not be read back',
     /if\s*\(!cur\?\.policy\)\s*\{[\s\S]{0,400}?continue;/.test(src),
     'no read, no restart — guessing costs the placement AND feeds the thing that broke the read');
  ok('and it says why rather than skipping silently',
     /could not read its policy back/.test(src));
  // lastIndexOf, not indexOf: `ensureKeeper` carries an EARLIER `action: 'start'` and the
  // first match is that one, which made this assert the wrong ordering entirely.
  ok('the skip comes BEFORE the start call, not after',
     src.indexOf('could not read its policy back') <
     src.lastIndexOf("action: 'start', mode: 'farm'"),
     'a guard after the write is not a guard');

  // AND THE OTHER CALLER HAD THE SAME HOLE, found only because the ordering test tripped
  // over it. `ensureKeeper` read status, and on a null read `st?.running` is undefined —
  // falsy — so it started a keeper it could not confirm was stopped, from
  // `carriedPolicy(null)` === {}, i.e. defaults. A blocked broker turned the unstick into
  // "restart everything from scratch", which is the load that blocked it.
  ok('ensureKeeper also refuses to start from an unread policy',
     /if\s*\(!st\?\.policy\)\s*return false;/.test(src),
     'not knowing whether it is running is a reason to leave it alone, not to start it');
  ok('...and that guard is before ITS start call too',
     src.indexOf('if (!st?.policy) return false;') <
     src.indexOf("{ agent, action: 'start', mode: 'farm'"));
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
