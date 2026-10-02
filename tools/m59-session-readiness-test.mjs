#!/usr/bin/env node

import { joinSessionOnce, sessionReadiness } from './m59-session-readiness.mjs';

let passed = 0;
let failed = 0;
const check = (name, condition) => {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}`);
};

{
  let starts = 0;
  let finish;
  const session = {
    live: false,
    joining: null,
    snapshot: note => ({ note }),
  };
  const start = () => {
    starts += 1;
    return new Promise(resolve => { finish = resolve; });
  };
  const first = joinSessionOnce(session, { character: 'MANIAC' }, start);
  const second = joinSessionOnce(session, { character: 'MANIAC' }, start);
  await Promise.resolve();
  check('concurrent callers start only one login', starts === 1);
  finish({ joined: true });
  const [a, b] = await Promise.all([first, second]);
  check('concurrent callers receive the same successful result', a.joined && b.joined);
  check('the in-flight marker clears after success', session.joining === null);

  await joinSessionOnce(session, {}, async () => {
    starts += 1;
    return { joined: true };
  });
  check('a later request can start a new login', starts === 2);
}

{
  const session = {
    live: true,
    joining: null,
    snapshot: note => ({ note }),
  };
  let started = false;
  const result = await joinSessionOnce(session, {}, async () => {
    started = true;
  });
  check('a live session returns without starting another login', !started);
  check('the live-session response is a snapshot', result.note === 'already in game');
}

{
  const readiness = sessionReadiness(new Map([
    ['live', { live: true }],
    ['joining', { live: false }],
  ]));
  check('health sessions contains only live characters',
    JSON.stringify(readiness.sessions) === JSON.stringify(['live']));
  check('health known_sessions retains joining identities',
    JSON.stringify(readiness.known_sessions) === JSON.stringify(['live', 'joining']));
}

{
  // A HALF-BUILT JOIN IS NOT "ALREADY IN GAME" (prod, 2026-10-02): joinOnce installs the client, so
  // `live` is true, before its login reads and combat readiness. A second caller must wait for it.
  let finish;
  const session = { live: false, joining: null, snapshot: note => ({ note }) };
  const first = joinSessionOnce(session, {}, () => new Promise(resolve => { session.live = true; finish = resolve; }));
  await Promise.resolve(); await Promise.resolve();
  let settled = false;
  const second = joinSessionOnce(session, {}, () => { throw new Error('must not start a second login'); })
    .then(r => { settled = true; return r; });
  await new Promise(r => setTimeout(r, 10));
  check('a caller during an in-progress join waits, even though the session already reads live', settled === false);
  finish({ joined: true, complete: true });
  const b = await second;
  check('and receives the completed join, not an already-in-game snapshot', b.complete === true);
  await first;
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
