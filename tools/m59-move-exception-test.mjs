#!/usr/bin/env node
// A JOURNEY THAT CARRIES AN EXCEPTION -- offline, no socket, no roster.
//
//   node tools/m59-move-exception-test.mjs
//
// Operator, 2026-10-27: "the watcher should only cancel trips that don't have exception permissions and the Loial
// refresh should be tagged as an intentional exception flagged for the chalice refresh (for traceability in case he
// dies)". What this pins (m59-move-origin.mjs normalizeException / exceptionCancelRefusal):
//   * an origin keeps a well-formed exception and drops a malformed one; the order view shows it;
//   * an outside cancel of a tagged journey is refused unless it names cancel_exception; an untagged one is not;
//   * the refill trip is tagged, the keeper /action cancel and the broker's cancel_movement both ask, and the
//     postmortem records the journey and its exception.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};
const O = await import('./m59-move-origin.mjs');
const { HAZARDS } = await import('./m59-hazards.mjs');

console.log('the tag');
const ex = { name: 'chalice_refresh', permission: 'allow_exit_confinement_for_refresh', granted_by: 'chalice strategy chalice-farming', why: 'refilling at 568' };
const o = O.keeperOrigin('chalice_refill', { exception: ex });
ok('an origin keeps its exception', o.exception?.name === 'chalice_refresh' && o.exception.permission === 'allow_exit_confinement_for_refresh', JSON.stringify(o));
ok('a malformed exception is dropped, not invented', !('exception' in O.keeperOrigin('x', { exception: { permission: 'y' } })));
ok('an origin without one has none', !('exception' in O.keeperOrigin('shelter')));
const s = { moveOrder: { kind: 'travel', to: 568, origin: o, at: Date.now() } };
ok('movement.order shows it', O.movementReport(s).order?.exception?.name === 'chalice_refresh', JSON.stringify(O.movementReport(s).order));
ok('the journey ledger\'s provenance carries it', O.journeyProvenance({ origin: o }).origin.exception?.name === 'chalice_refresh');

console.log('an outside cancel has to name it');
const r = O.exceptionCancelRefusal(s, null);
ok('refused without accept, saying which exception and how to mean it', r?.refused === 'cancel_exception' && /accept: \["cancel_exception"\]/.test(r.why), JSON.stringify(r));
ok('allowed with accept: ["cancel_exception"]', O.exceptionCancelRefusal(s, ['cancel_exception']) === null);
ok('an untagged journey is cancelled as before', O.exceptionCancelRefusal({ moveOrder: { to: 2, origin: O.keeperOrigin('town') } }, null) === null);
ok('no journey: nothing to refuse', O.exceptionCancelRefusal({}, null) === null);
ok('cancel_exception is a named hazard', typeof HAZARDS.cancel_exception === 'string');

console.log('the bindings');
{
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('the refill trip is tagged chalice_refresh', /keeperOrigin\('chalice_refill', \{ exception \}\)/.test(src) && /name: 'chalice_refresh'/.test(src));
  ok('and so is the walk back', /keeperOrigin\('chalice_refill_return', \{ exception:/.test(src));
  ok('a postmortem records the journey and its exception', /journey: \{ to: o\.to \?\? null/.test(src) && /exception: o\.origin\?\.exception \?\? o\.exception/.test(src));
  const kp = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
  ok('the keeper /action cancel asks first', /const exRefusal = exceptionCancelRefusal\(session, args\.accept \?\? null\);/.test(kp));
  const broker = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  ok('cancel_movement takes accept and forwards it to the keeper', /'"cancel_exception": cancel even a journey tagged/.test(broker)
     && /\.\.\.\(opts\?\.accept \? \{ accept: opts\.accept \} : \{\}\)/.test(broker));
  ok('a policy push names the tool and its caller on the keeper\'s log line (practiceSpells -> null, 2026-10-27)',
     /via \$\{String\(via\)\.slice\(0, 160\)\}/.test(broker) && /`autopilot \$\{a\.action\}\$\{a\.origin \? ` <- \$\{originLabel\(mcpOrigin\(a\)\)\}`/.test(broker));
  const fs2 = readFileSync(new URL('./m59-fleetscript.mjs', import.meta.url), 'utf8');
  ok('a FleetScript\'s autopilot call carries its origin', /'cancel_movement',[\s\S]{0,300}'autopilot'\]\);/.test(fs2));
  const pm = readFileSync(new URL('./m59-postmortems.mjs', import.meta.url), 'utf8');
  ok('the postmortem reader shows it', /pm\.was\?\.exception \? \{ exception: pm\.was\.exception \}/.test(pm));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
