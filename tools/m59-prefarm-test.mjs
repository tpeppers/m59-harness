#!/usr/bin/env node
// Offline tests for the prefarm arithmetic (m59-prefarm-lib.mjs). No socket, no roster.
import { planPrefarm, describePrefarm, SOLDIER_DROPS } from './m59-prefarm-lib.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };

ok(Math.abs(SOLDIER_DROPS['chain armor'] - 0.07) < 1e-9, 'chain drops 7% of kills (35% carried x 20%)');
ok(Math.abs(SOLDIER_DROPS.hammer - 0.02) < 1e-9, 'a hammer drops 2% of kills');

const a = planPrefarm({ wants: { 'chain armor': 4 }, hall: 714, fleetLevels: [75, 64] });
ok(a.faction === 'princess' && a.rooms.join() === '593,583,603', "Barloque's hall farms the Princess' rooms");
ok(a.kills === 58 && a.per_hour === 36, 'four chain: ~58 kills, 36 soldiers an hour from three poles');
ok(a.hours === 1.6, '~1.6 hours of flagpole output');
ok(a.saves === 7200, 'four chain would cost 7,200 at a counter');
ok(a.warnings.some(w => /upper half/.test(w)), 'a level-75 fleet is warned the upper half is above it');

const b = planPrefarm({ wants: { hammer: 18, 'chain armor': 4 }, hall: 714 });
ok(b.kills === 900, 'the rarest line decides: eighteen hammers at 2% is 900 kills');
ok(b.warnings.some(w => /hours of flagpole output/.test(w)), 'and a list that long says so');

const c = planPrefarm({ wants: { 'soldier shield': 2 }, hall: 714 });
ok(c.warnings.some(w => /never drop/.test(w)) && c.kills === 0, 'a soldier shield never drops — buy it');

const d = planPrefarm({ wants: { 'long sword': 2 }, hall: 705 });
ok(d.keep_not_deposit && d.warnings.some(w => /island/.test(w)), 'an island hall warns and keeps the gear');

const e = planPrefarm({ wants: { 'chain armor': 1 }, hall: 714, fleetLevels: [50] });
ok(e.warnings.some(w => /DO NOT FARM SOLDIERS/.test(w)), 'a fleet below every soldier gets the combat doc warning verbatim');

const f = planPrefarm({ wants: { 'leather armor': 2 }, hall: 701 });
ok(f.smith === 201 && f.byproduct >= 0, "Cor Noth sells to Marion's smith, which takes no armour — byproducts count weapons only");

ok(/kills/.test(describePrefarm(a)), 'the description reads');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
