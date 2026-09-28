#!/usr/bin/env node
// OFFLINE. karma_strict (Autopilot.karmaForbids, and refuseEngagement consulting it): a character
// farming living trees for NEGATIVE karma must never strike a spider — not to clear the cap, not
// to hit back, not to fight back — because one spider (karma -30) undoes several trees. Operator,
// 2026-09-28: "It will also have to avoid (and not kill!) the spiders when being run for -karma
// goals". And the switch must be OFF by default: everywhere else, refusing to hit back is how
// these characters die (the Qor students in the baby-spider rooms, m59-autopilot passFarm).
import { Autopilot } from './m59-autopilot.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const keeper = (policy = {}) => new Autopilot({}, { mode: 'farm', policy: { hunt: 'living tree', ...policy } });

let k = keeper({ karma: 'evil', karmaStrict: true });
ok(k.karmaForbids('spider')?.karma_strict === true, 'strict evil: a spider (karma -30) is forbidden');
ok(k.karmaForbids('baby spider'), 'strict evil: a baby spider (karma -10) is forbidden');
ok(k.karmaForbids('living tree') === null, 'strict evil: the living tree (karma +40) is allowed');
ok(k.karmaForbids('centipede') === null, 'strict evil: a centipede (karma +15) is allowed');
ok(k.refuseEngagement('spider')?.karma_strict === true,
   'refuseEngagement refuses it too — so fight-back, the lone-attacker rung and wedged swings skip it');
ok(k.karmaForbids('no such creature') === null, 'a creature with no known karma is not refused on karma');

k = keeper({ karma: 'evil' });
ok(k.karmaForbids('spider') === null, 'karma without karma_strict narrows hunting only — hitting back is unchanged');
ok(!k.refuseEngagement('spider')?.karma_strict, 'and refuseEngagement is the level band alone');

k = keeper({ karmaStrict: true });
ok(k.karmaForbids('spider') === null, 'karma_strict with no karma school refuses nothing');

k = keeper({ karma: 'good', karmaStrict: true });
ok(k.karmaForbids('living tree') && k.karmaForbids('spider') === null,
   'strict good: the tree is forbidden and the spider is fine — the berry farmer\'s mirror image');

k = keeper();
ok(k.karmaForbids('spider') === null && !k.policy.karmaStrict, 'off by default');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
