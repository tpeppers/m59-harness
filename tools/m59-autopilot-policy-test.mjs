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
// character idling in an inn, and it is pinned in m59-combat-test.mjs.
import {
  Autopilot, applyFightAboveVigor, STRATEGIES, reachableFightFloor, reagentShopFor,
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
    fightAboveVigor: 100,
  };
  applyFightAboveVigor(policy, 100);

  ok('the legacy status field remains truthful', policy.fightAboveVigor === 100);
  ok('the effective provisioning floor is the explicit threshold', policy.vigorFloor === 100);
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

{
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { strategy: 'baseline', vigorFloor: 140 };
  ap.s = { client: {} };
  ap.vigor = { starved_passes: 0 };
  ap.larder = () => [{ food: { nutrition: 50 }, o: { amount: 1 } }];
  ok('fightFloor reads nutrition from larderOf food metadata',
     ap.fightFloor() === 130, `got ${ap.fightFloor()}`);
  ap.larder = () => [{ food: { nutrition: 30 }, o: { amount: 2 } }];
  ok('fightFloor counts every item in a food stack',
     ap.fightFloor() === 140, `got ${ap.fightFloor()}`);
}

// THE REAGENT SHOP IS ONE TOWN'S ANSWER. Unset keeps Joguer in Barloque; a positive room
// number in the keeper env moves the herb run, and a name is only for the journal.
ok('with nothing in the env the reagent shop is Joguer in 104',
   reagentShopFor({}).room === 104 && /Joguer/.test(reagentShopFor({}).name),
   JSON.stringify(reagentShopFor({})));
ok('M59_REAGENT_SHOP_ROOM=53 moves the run to Tos and names the room when no name is given',
   reagentShopFor({ M59_REAGENT_SHOP_ROOM: '53' }).room === 53
     && reagentShopFor({ M59_REAGENT_SHOP_ROOM: '53' }).name === 'apothecary (room 53)'
     && reagentShopFor({ M59_REAGENT_SHOP_ROOM: '53', M59_REAGENT_SHOP_NAME: 'Frisconar, Tos' }).name === 'Frisconar, Tos',
   JSON.stringify(reagentShopFor({ M59_REAGENT_SHOP_ROOM: '53' })));
ok('a value that is not a positive room number keeps Joguer rather than pointing at nowhere',
   reagentShopFor({ M59_REAGENT_SHOP_ROOM: 'Tos' }).room === 104
     && reagentShopFor({ M59_REAGENT_SHOP_ROOM: '0' }).room === 104
     && reagentShopFor({ M59_REAGENT_SHOP_ROOM: '-5' }).room === 104,
   'bad values must fall back');

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\n19 passed');
