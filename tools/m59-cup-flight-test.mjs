// A PVP FLIGHT MAY SIP THE CHALICE FIRST. Offline: the decision validator and the flight's source, no socket.
//
//   node tools/m59-cup-flight-test.mjs
//
// Operator, 2026-10-27: islanders who see a known enemy enter their map "can simply sip the chalice and run away ...
// they'll chalice to the inn and be safe". `flee_to` takes `cup: true`; the flight sips the Chalice of the Rain once
// before its walk (Rescue at power 1 lands 15-25 s later, so the walk keeps the body moving meanwhile), and never sips
// inside the ten-minute ban a player attack starts (chalice.kod:168).
import fs from 'node:fs';
import { validateDecision } from './m59-pvp-strategy.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}`); } };

const withCup = validateDecision({ do: 'flee_to', room: 2001, hold_ms: 600000, cup: true });
ok(withCup?.decision?.cup === true && withCup.decision.room === 2001, 'flee_to keeps cup: true');
const noCup = validateDecision({ do: 'flee_to', room: 2001 });
ok(noCup?.decision && !('cup' in noCup.decision), 'flee_to without cup carries no cup field');
const truthy = validateDecision({ do: 'flee_to', room: 2001, cup: 'yes' });
ok(truthy?.decision && !('cup' in truthy.decision), 'only a literal true asks for the cup');

const src = fs.readFileSync(new URL('./m59-combat-mode.mjs', import.meta.url), 'utf8');
ok(/\.\.\.\(d\.cup === true && !sortie \? \{ cup: true \} : \{\}\)/.test(src), 'beginFlight carries cup into the flight (never on a sortie)');
const adv = src.slice(src.indexOf('async advanceFlight(o)'));
const sipAt = adv.indexOf('this.sipCupForFlight(o)'), walkAt = adv.indexOf('await this.stand(o)');
ok(sipAt > 0 && walkAt > sipAt, 'the sip comes before the walk');
ok(/if \(f\.cup && !f\.cup_result && s\.world\.room\.num !== f\.room\)/.test(adv), 'sips once, and only when not already in the room');
const sip = src.slice(src.indexOf('async sipCupForFlight(o)'), src.indexOf('async advanceFlight(o)'));
ok(/lastPlayerAttackAt[\s\S]{0,40}600_000/.test(sip), 'no sip inside the ten-minute ban after attacking a player');
ok(/\/\^chalice of the rain\$\/i/.test(sip) && /c\.use\(cup\.id\)/.test(sip), 'the sip is a use of the Chalice of the Rain itself');

console.log(`m59-cup-flight-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
