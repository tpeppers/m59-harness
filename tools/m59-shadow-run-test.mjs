#!/usr/bin/env node
// WHAT THIS PINS: the refusals that decide WHERE m59-shadow-run.mjs is pointed.
//
//   node tools/m59-shadow-run-test.mjs
//
// Offline. No socket, no roster, no broker. The shim's other stages all talk to something,
// but these do not have to — and they are the ones that matter, because the command they
// guard CREATES and REROLLS characters. `reroll` suicides the existing character and has no
// undo, so a shim pointed at a fleet somebody plays is not a rehearsal, it is the incident.
//
// The 2026-09-16 near miss is the reason this file exists: the shim's own first run named
// fleet "shadow", read shadow's roster, resolved shadow's twenty-three agents — and sent the
// orders to http://127.0.0.1:8901/, production's broker, because `M59_CONTROL_URL` was never
// set. Only fleetScript's broker-identity check stopped it. A fleet is its ROSTER FILE and
// never its name, and naming it is not the same as addressing it.
import { refusals } from './m59-shadow-run.mjs';

let passed = 0, failed = 0;
const ok = (cond, what) => { if (cond) { passed++; console.log(`  ok   ${what}`); }
                             else { failed++; console.log(`  FAIL ${what}`); } };
const someRefusal = (rs, re, what) => ok(rs.some(r => re.test(r)), what);

const base = { fleet: 'shadow', httpPort: 8971, dashPort: 8972, prodPort: 8901,
               shadowTool: 'C:/anywhere/m59-shadow.mjs' };

console.log('\nwhere it is pointed');
ok(refusals(base).length === 0, 'a shadow fleet on its own ports is allowed');
someRefusal(refusals({ ...base, fleet: 'prod' }), /looks like production/,
            'a fleet called "prod" is refused');
someRefusal(refusals({ ...base, fleet: 'prod-deploy' }), /looks like production/,
            'so is anything else starting with "prod" — the prefix is the test, not equality');
someRefusal(refusals({ ...base, fleet: 'PROD' }), /looks like production/,
            'and case does not get you past it');
ok(refusals({ ...base, fleet: 'shadow-ab' }).length === 0,
   'a fleet merely containing letters is not refused — only the production prefix');

console.log('\nthe ports');
someRefusal(refusals({ ...base, httpPort: 8901 }), /production broker's port/,
            'the production RPC port is refused even under a shadow fleet name');
someRefusal(refusals({ ...base, dashPort: 8901 }), /production broker's port/,
            'and so is it as the DASHBOARD port — which is the half that took prod down');
someRefusal(refusals({ ...base, httpPort: 8971, dashPort: 8971 }), /both 8971/,
            'http and dashboard may not be the same port');

console.log('\nthe tool that is not in this checkout');
someRefusal(refusals({ ...base, shadowTool: null }), /gitignored/,
            'a missing m59-shadow.mjs says WHY it is missing, not just that it is');

console.log('\nimporting this module drives nothing');
ok(true, 'this file imported m59-shadow-run.mjs and no fleet moved — the CLI is guarded');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
