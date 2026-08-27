#!/usr/bin/env node
// THE PUBLIC KEEPER ARGUMENTS, AND WHICH END OF THE BAND EACH ONE OWNS.
//
// `fight_above_vigor` is the FLOOR. It must beat the selected strategy, because every
// strategy in the table declares `vigorFloor` and fightFloor() reads the legacy field
// last — which made the advertised broker argument decide nothing at all.
//
// It must NOT become the ceiling. See applyFightAboveVigor: a ceiling equal to the
// floor collapses provisioning's band into a threshold and gives up the health
// regeneration the food was bought for. shouldWaitForProvision is what stops a fed
// character idling in an inn, and its inclusive floor semantics are pinned below.
import {
  applyFightAboveVigor,
  Autopilot,
  reachableFightFloor,
  shouldWaitForProvision,
  STRATEGIES,
} from './m59-autopilot.mjs';

let failed = 0;
const ok = (label, condition, detail = '') => {
  console.log(`  ${condition ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!condition) failed++;
};

console.log('--- explicit fight vigor overrides strategy provisioning ---');
{
  const policy = {
    strategy: 'baseline',
    fightAboveVigor: 80,
  };
  applyFightAboveVigor(policy, 80);

  ok('the legacy status field remains truthful', policy.fightAboveVigor === 80);
  ok('the effective provisioning floor is the explicit threshold', policy.vigorFloor === 80);
  ok('and the strategy ceiling is left where it was — the band is not collapsed',
     policy.vigorCeiling === undefined,
     `baseline default is ${STRATEGIES.baseline.vigorCeiling}`);
}

console.log('\n--- invalid thresholds fail at the broker boundary ---');
for (const value of [undefined, 'not-a-number', Infinity, -1, 201]) {
  let rejected = false;
  try { applyFightAboveVigor({}, value); } catch { rejected = true; }
  ok(`rejects ${String(value)}`, rejected);
}

console.log('\n--- the fight floor is capped at what the character can actually reach ---');
// Resting caps at 80 of a 200 bar; vigor above that comes only from food. A floor
// above rest-cap + carried-food is unreachable and would idle the character forever.
//
// The Lee deadlock: baseline floor 140, one mushroom carried (+50). The old empty-larder
// escape hatch never fired (larder non-empty), so the floor stayed 140, but 80+50=130
// < 140 -- unreachable, and the character looped "too tired to start a fight".
ok('a single mushroom raises the reachable floor from the 80 resting cap to 130',
   reachableFightFloor(140, 200, 50) === 130,
   `got ${reachableFightFloor(140, 200, 50)}`);
ok('an empty larder caps the floor at the 80 resting ceiling, not the configured 140',
   reachableFightFloor(140, 200, 0) === 80,
   `got ${reachableFightFloor(140, 200, 0)}`);
ok('a well-stocked larder keeps the full 140 floor (food can bridge it)',
   reachableFightFloor(140, 200, 200) === 140,
   `got ${reachableFightFloor(140, 200, 200)}`);
ok('a floor already below the resting cap is never raised by food',
   reachableFightFloor(80, 200, 50) === 80,
   `got ${reachableFightFloor(80, 200, 50)}`);
ok('a floor above the cap with no food drops to the cap (100 -> 80)',
   reachableFightFloor(100, 200, 0) === 80,
   `got ${reachableFightFloor(100, 200, 0)}`);
ok('the resting cap scales with the vigor bar, not a hard-coded 200',
   reachableFightFloor(140, 100, 50) === 90,   // 0.4*100=40 + 50 = 90 -> min(140,90)=90
   `got ${reachableFightFloor(140, 100, 50)}`);

console.log('\n--- the keeper counts real larder entries and accepts the floor itself ---');
const effectiveFloorState = (vigorFloor, larder, plan = undefined) => {
  const keeper = {
    policy: { vigorFloor },
    s: { client: {} },
    larder: () => larder,
    vigor: { starved_passes: 0 },
  };
  return {
    floor: Autopilot.prototype.fightFloor.call(keeper, plan),
    starved: keeper.vigor.starved_passes,
  };
};
const effectiveFloor = (vigorFloor, larder, plan = undefined) =>
  effectiveFloorState(vigorFloor, larder, plan).floor;
const ration = (nutrition, amount = 1) => ({
  name: 'test ration',
  food: { nutrition, filling: 1 },
  o: { amount },
});

ok('an empty larder falls back exactly to the rest-reachable 80',
   effectiveFloor(80, []) === 80,
   `got ${effectiveFloor(80, [])}`);
ok('an explicit resting-cap floor remains 80 even when food is carried',
   effectiveFloor(80, [ration(20)]) === 80,
   `got ${effectiveFloor(80, [ration(20)])}`);
ok('an explicit zero floor remains zero with or without food',
   effectiveFloor(0, []) === 0 && effectiveFloor(0, [ration(20)]) === 0,
   `empty=${effectiveFloor(0, [])}, fed=${effectiveFloor(0, [ration(20)])}`);
ok('an empty larder at an explicit reachable floor is not reported as starvation',
   effectiveFloorState(80, []).starved === 0,
   JSON.stringify(effectiveFloorState(80, [])));
ok('the internal food-backed minimum still applies when no explicit floor was supplied',
   effectiveFloor(undefined, [ration(20)]) === 100,
   `got ${effectiveFloor(undefined, [ration(20)])}`);
ok('a sub-100 strategy default is still raised to the internal default floor',
   effectiveFloor(undefined, [ration(20)], { vigorFloor: 90 }) === 100,
   `got ${effectiveFloor(undefined, [ration(20)], { vigorFloor: 90 })}`);
ok('the baseline strategy still requests 140 when no explicit floor was supplied',
   effectiveFloor(undefined, [ration(100)], STRATEGIES.baseline) === 140,
   `got ${effectiveFloor(undefined, [ration(100)], STRATEGIES.baseline)}`);
ok('stack quantities contribute every carried serving',
   effectiveFloor(140, [ration(20, 3)]) === 140,
   `got ${effectiveFloor(140, [ration(20, 3)])}`);
ok('one 50-vigor item makes a configured 140 floor reachable only to 130',
   effectiveFloor(140, [ration(50)]) === 130,
   `got ${effectiveFloor(140, [ration(50)])}`);
ok('exactly meeting the floor does not keep provisioning',
   !shouldWaitForProvision({ vigor: 80, floor: 80, wait: 120, hurt: false }));
ok('one point below the floor does keep provisioning',
   shouldWaitForProvision({ vigor: 79, floor: 80, wait: 120, hurt: false }));

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\n26 passed');
