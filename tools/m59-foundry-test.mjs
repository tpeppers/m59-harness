#!/usr/bin/env node
// Offline tests for m59-foundry.mjs — the spell-power model and the roll bands (creaweap.kod).
import { spellPowerEstimate, outcomeOdds, bluntOdds, lifetimeMin, isWeaponOut } from './m59-foundry.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const near = (a, b, e = 0.02) => Math.abs(a - b) <= e;

ok(spellPowerEstimate({ ability: 99, active: 22, health: 75, maxHealth: 75 }) === 49 + 22 + 10, 'ability/2 + bodies + health/10');
ok(spellPowerEstimate({ ability: 99, active: 60, health: 75, maxHealth: 75 }) === 49 + 30 + 10, 'the room bonus is capped at 30');
ok(spellPowerEstimate({ ability: 90, active: 1, health: 30, maxHealth: 60 }) === 45 + 1 + 5, 'a hurt caster alone');

const s = Object.values(outcomeOdds(85)).reduce((a, b) => a + b, 0);
ok(near(s, 1, 1e-9), 'the odds sum to one');
ok(near(outcomeOdds(85).hammer, 15 / 58), 'P 85 (a crowded stage room): about a quarter hammers');
ok(!outcomeOdds(85).mace, 'and never a mace: the roll cannot go below 28');
ok(bluntOdds(46) > 0.6, 'P 46 (alone, a little hurt): hammer or mace about two times in three');
ok(bluntOdds(46) > 2 * bluntOdds(85), 'stepping out of the crowd more than doubles the blunt odds');
ok(outcomeOdds(20).mace > 0.5, 'a very low P mostly makes maces');
ok(lifetimeMin(46) === 92, 'a weapon lasts 2 x P minutes');
ok(isWeaponOut('long sword') && isWeaponOut('Hammer') && !isWeaponOut('chain armor'), 'the outputs are recognised by name');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
