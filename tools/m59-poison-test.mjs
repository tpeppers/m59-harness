#!/usr/bin/env node
// POISON: SHELTER IN PLACE -- offline, no socket, no roster.
//
//   node tools/m59-poison-test.mjs
//
// Operator, 2026-10-27: "the correct solution to poison is to lock down in the nearest safe spot until the poison ends and
// healing occurs afterwards, not to flee through it and risk low-health travel. Shelter in place." What this pins:
//   * poisonedNow reads the server's ailment by name, and nothing else;
//   * a poisoned keeper takes the NEAREST safe spot (takeRecoverySpot), not a wall forward on the route, in any mode;
//   * the hold is NOT released while the poison lasts, however full health reads between ticks; once it ends, the
//     ordinary floor makes it heal before it leaves;
//   * a poisoned relog stays out long enough for the old poison timer to stop (player.kod: a relog inside 10 s runs two),
//     and there is only one of it a healing session (m59-healing-session-test.mjs).
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};
const P = await import('./m59-poison.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');

console.log('is it poisoned');
const client = names => ({ ailments: () => names.map(name => ({ name })) });
ok('the poison enchantment is poison', P.poisonedNow(client(['poison'])));
ok('nothing is nothing', !P.poisonedNow(client([])) && !P.poisonedNow(null));
ok('a disease is not poison', !P.poisonedNow(client(['disease'])));

console.log('the hold is kept until the poison ends');
function keeper({ poisoned = true, hp = 46, max = 46 } = {}) {
  const c = { ...client(poisoned ? ['poison'] : []), vitals: () => ({ health: { value: hp, max }, vigor: { value: 80, scale_max: 200 } }) };
  const notes = [];
  return Object.assign(Object.create(Autopilot.prototype), { s: { client: c }, hold: { col: 1, row: 1 }, mode: 'survive',
    policy: { holdResumeAbove: 0.9 }, note: (w, d) => notes.push({ w, d }), restVigorCeiling: () => 0,
    leaveHold: async () => ({ left: true }), inert: null, suspendedJourney: null, _notes: notes });
}
{
  const k = keeper({ poisoned: true, hp: 46 });
  ok('at FULL health between ticks, still poisoned: the wall is kept', await k.releaseRestedHold() === false
     && k._notes.some(n => n.w === 'keeping the wall while poisoned'));
  const k2 = keeper({ poisoned: false, hp: 46 });
  ok('the poison over and healed: the wall is left', await k2.releaseRestedHold() === true);
  const k3 = keeper({ poisoned: false, hp: 20 });
  ok('the poison over but still hurt: it heals first', await k3.releaseRestedHold() === false);
}

console.log('a poisoned relog stays out long enough');
{
  const seen = [];
  const k = Object.assign(Object.create(Autopilot.prototype), { s: { client: client(['poison']),
    rejoin: async (_why, { offlineMs }) => { seen.push(offlineMs); } }, note: () => {} });
  await k.reconnect('logging off rather than dying').catch(() => {});
  ok(`poisoned: offline at least ${P.POISON_RELOG_OFFLINE_MS} ms (a relog inside 10 s doubles the poison)`, seen[0] >= P.POISON_RELOG_OFFLINE_MS, String(seen[0]));
  const seen2 = [];
  const k2 = Object.assign(Object.create(Autopilot.prototype), { s: { client: client([]),
    rejoin: async (_why, { offlineMs }) => { seen2.push(offlineMs); } }, note: () => {} });
  await k2.reconnect('x').catch(() => {});
  ok('not poisoned: unchanged', seen2[0] === 0);
}

console.log('the shelter is the nearest safe spot');
{
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('a poisoned keeper takes the nearest recovery spot', /if \(poisonedNow\(this\.s\?\.client\) && !sheltered && !this\.hold[\s\S]{0,300}takeRecoverySpot\('poisoned: sheltering in place/.test(src));
  ok('no second logoff after a poisoned relog, whatever is adjacent (one per healing session: m59-healing-session-test)',
     !/poisoned, a hostile adjacent after the relog/.test(src));
  ok('and the forward-on-the-route shelter no longer fires for poison', /const poisonedAndFading = ailingNow && !poisonedNow\(this\.s\?\.client\)/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
