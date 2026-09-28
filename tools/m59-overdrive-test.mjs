#!/usr/bin/env node
// OFFLINE. Vigor OVERDRIVE (operator, 2026-09-28): sit and eat to 200 on the stomach clock at a natural
// stop, then go back to the task — rather than leaving at the fighting floor and stopping again forty
// vigor later. overdriveSettings reads the policy; shouldWaitForProvision is the one rule it changes.
import { overdriveSettings, overdriveDigest, overdriveReachable, shouldWaitForProvision, Autopilot } from './m59-autopilot.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

ok(overdriveSettings({}) === null, 'off by default: silence is the behaviour that was already there');
ok(overdriveSettings({ overdrive: { enabled: false, target: 200 } }) === null, 'enabled:false is off');
ok(overdriveSettings({ overdrive: { enabled: true } })?.target === 200, 'on: the target defaults to 200');
ok(overdriveSettings({ overdrive: { enabled: true, target: 500 } })?.target === 200, 'the target never exceeds the game cap of 200');
ok(overdriveSettings({ overdrive: { enabled: true, target: 40 } })?.target === 81, 'nor sits below the resting cap (resting gets there free)');

// A fed character above its fighting floor with a long digestion ahead used to set out at once.
const base = { vigor: 170, floor: 160, wait: 400, hurt: false };
ok(shouldWaitForProvision(base) === false, 'without overdrive: above the floor with a long wait, it sets out (the old rule)');
ok(shouldWaitForProvision({ ...base, overdrive: { active: true, target: 200 } }) === true,
   'with overdrive: it waits out the stomach toward 200');
ok(shouldWaitForProvision({ ...base, vigor: 196, overdrive: { active: true, target: 200 } }) === false,
   'at the target (within the last bite) it is released');
ok(shouldWaitForProvision({ ...base, wait: 2000, overdrive: { active: true, target: 200 } }) === false,
   'a wait longer than a full digestion is a wrong stomach model, and is not waited on');
ok(shouldWaitForProvision({ ...base, vigor: 150 }) === true, 'below the floor it waits either way, as before');

// start / end write one ledger row with what the sitting bought.
const k = new Autopilot({}, { mode: 'farm', policy: { overdrive: { enabled: true } } });
const rows = [];
k.note = () => {}; k.ledgerEvent = (kind, d) => rows.push({ kind, ...d });
k.tally.meals = 3;
k.startOverdrive({ target: 200 }, 90, 'test');
k.tally.meals = 9;
k.endOverdrive(198, 'reached the target');
ok(rows.length === 1 && rows[0].kind === 'overdrive' && rows[0].gained === 108 && rows[0].meals === 6,
   `one ledger row: +108 vigor over 6 meals (${JSON.stringify(rows[0])})`);
k.endOverdrive(198, 'again');
ok(rows.length === 1, 'ending twice writes once');


// THE DIGEST PHASE (operator addendum, 2026-09-28): at 200, keep sitting until the stomach has room for
// a full sitting again, so the fight begins both fed AND able to top up.
{
  const od = overdriveSettings({ overdrive: { enabled: true } });
  ok(od.digestTo === 20 && od.digestMaxMinutes === 15, 'digest defaults: down to 20 of 100, at most 15 min');
  ok(overdriveDigest({ od, stomachLevel: 70, digestingForMs: 0 }).hold === true, 'stomach at 70: keep sitting');
  ok(overdriveDigest({ od, stomachLevel: 18, digestingForMs: 0 }).released_by === 'digested: room to eat again', 'at 18: released, room to eat again');
  ok(overdriveDigest({ od, stomachLevel: 70, digestingForMs: 0, danger: true }).released_by === 'something in reach', 'danger releases at once');
  ok(overdriveDigest({ od, stomachLevel: 70, digestingForMs: 0, leased: true }).released_by === 'a lease wanted the body', 'a lease (DUM, an order) releases at once');
  ok(overdriveDigest({ od, stomachLevel: 70, digestingForMs: 15 * 60_000 }).hold === false, 'the digest cap releases');
  ok(overdriveSettings({ overdrive: { enabled: true, digestTo: 100 } }).digestTo === 100, 'digestTo 100 switches the digest phase off (release at the target)');
}


// WHAT THE LARDER CAN REACH (Kermit, 2026-09-28: 188 -> 188, 29.5 min, 0 meals — bread is +20, so no bite fit).
{
  const bread = [{ food: { nutrition: 20 } }], mixed = [{ food: { nutrition: 20 } }, { food: { nutrition: 5 } }];
  ok(overdriveReachable(200, bread) === 185, 'bread only: 185 counts as there (no bite of 20 fits above 180)');
  ok(188 >= overdriveReachable(200, bread) - 5, 'so Kermit at 188 is released, not left waiting 30 min');
  ok(overdriveReachable(200, mixed) === 200, 'an edible mushroom (+5) aboard: 200 is reachable');
  ok(overdriveReachable(200, []) === 200, 'an empty larder leaves the target alone (out of food ends it anyway)');
  ok(shouldWaitForProvision({ vigor: 188, floor: 130, wait: 400, hurt: false, overdrive: { active: true, target: 200, reach: 185 } }) === false,
     'the waiting rule uses the reachable target');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
