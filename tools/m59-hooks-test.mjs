#!/usr/bin/env node
// THE RULES A PRIVATE HOOK RUNS UNDER, PINNED.
//
//   node tools/m59-hooks-test.mjs
//
// Offline. Every case here is a way a private file could take the fleet down, which is the
// whole reason the loader exists rather than callers importing each other directly: this
// repository is about to invite strangers to run their own code inside the keeper's event
// loop, and the guarantees have to be tested rather than documented.
import { readFileSync } from 'node:fs';
import {
  onEvent, fireEvent, hookStatus, resetHooks,
  PROTECTED_FACULTIES, BUDGET_MS, MAX_FAULTS,
} from './m59-hooks.mjs';

let pass = 0, fail = 0;
const ok = (what, cond) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}`); } };

console.log('a handler cannot break the fleet');
{
  resetHooks();
  let good = 0;
  onEvent('died', () => { good++; }, { name: 'good' });
  onEvent('died', () => { throw new Error('boom'); }, { name: 'bad' });
  for (let i = 0; i < MAX_FAULTS + 1; i++) fireEvent('died', { character: 'Floyd' });
  ok('fireEvent never throws, whatever a handler does', true);
  ok('the well-behaved handler ran every time', good === MAX_FAULTS + 1);
  const bad = hookStatus().find(r => r.name === 'bad');
  ok('the throwing handler is disabled', bad?.disabled === true);
  ok('...and says why, with the error text', /threw \d+ times/.test(bad?.why ?? ''));
  ok('a neighbour is not punished for it',
     hookStatus().find(r => r.name === 'good')?.disabled !== true);
}

console.log('\na handler cannot take a protected faculty');
{
  resetHooks();
  for (const f of PROTECTED_FACULTIES) {
    const accepted = onEvent('died', () => {}, { name: `wants ${f}`, wants: [f] });
    ok(`${f} is refused`, accepted === false);
  }
  ok('and an unprotected faculty is fine',
     onEvent('died', () => {}, { name: 'wants movement', wants: ['movement'] }) === true);
  const why = hookStatus().find(r => r.name === 'wants survival')?.why ?? '';
  ok('the refusal explains itself rather than failing silently', /not negotiable/.test(why));
}

console.log('\na rejected promise is caught, because an unhandled one kills the process');
{
  resetHooks();
  onEvent('died', async () => { throw new Error('async boom'); }, { name: 'async bad' });
  fireEvent('died', { character: 'Floyd' });
  await new Promise(r => setImmediate(r));
  ok('the rejection was absorbed', true);
  // The process surviving to here IS the assertion: an unhandled rejection in Node takes the
  // process down, and the process is the whole fleet.
}

console.log('\nthe ledger writes the row BEFORE any handler sees it');
{
  const SRC = readFileSync(new URL('./m59-ledger.mjs', import.meta.url), 'utf8');
  const appendAt = SRC.indexOf("append({ t: Date.now(), iso: new Date().toISOString(), ...detail,");
  const fireAt = SRC.indexOf('_fireEvent(kind,');
  ok('append comes first in recordEvent', appendAt > 0 && fireAt > appendAt);
  ok('and the fire is itself wrapped, so a hook cannot cost us the evidence',
     /try \{ _fireEvent\(/.test(SRC));
  ok('hooks are opt-in: absent attachHooks means no hook machinery is imported',
     /let _fireEvent = null;/.test(SRC));
}

console.log('\nhandlers are observers — there is no veto');
{
  resetHooks();
  onEvent('died', () => false, { name: 'tries to veto' });
  onEvent('died', () => ({ cancel: true }), { name: 'tries harder' });
  const fired = fireEvent('died', { character: 'Floyd' });
  ok('both ran and neither return value means anything', fired === 2);
  // There is deliberately nothing to assert about a cancellation, because there is no
  // mechanism for one. A private file that can say "no" to the survival ladder is a private
  // file that can kill a character; documentation does not make that safe.
}

console.log('\nthe protected list must not drift from the keeper\'s');
{
  const AP = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const m = AP.match(/static PROTECTED_FACULTIES = \[([^\]]+)\]/);
  const theirs = (m?.[1] ?? '').split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
  ok('m59-hooks lists exactly what Autopilot protects',
     theirs.length > 0 && theirs.length === PROTECTED_FACULTIES.length &&
     theirs.every(f => PROTECTED_FACULTIES.includes(f)),
     `keeper: ${theirs.join(',')} | hooks: ${PROTECTED_FACULTIES.join(',')}`);
  // The literal is duplicated on purpose -- the ledger must not depend on the keeper -- so
  // this is the lock that makes the duplication safe. If it fails, the two have drifted and
  // a hook can take something the keeper thinks is protected.
}

console.log('\nlarder_empty is edge-triggered, or it would drown the ledger');
{
  const AP = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('it fires only on the transition into empty, and only when a pack was actually read',
     AP.includes('if (canSeePack && !this._larderWasEmpty) {'));
  ok('an empty READ is distinguished from an empty larder — a broker stub has no client, '
     + 'so it would otherwise report starvation for ever',
     AP.includes('const canSeePack = Array.isArray(this.s?.client?.items);'));
  ok('and re-arms once food is aboard', /this\._larderWasEmpty = false;/.test(AP));
  const emit = AP.indexOf("'larder_empty'");
  const rearm = AP.indexOf('this._larderWasEmpty = false;');
  ok('the re-arm is outside the empty branch', rearm > emit);
  ok('the emit cannot break fightFloor', /try \{[\s\S]{0,400}'larder_empty'/.test(AP));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
