#!/usr/bin/env node
// WHO IS WORKING ON WHAT, BEFORE THE FILE EXISTS. Offline: a temp directory is the registry, and
// process liveness is injected.
//
//   node tools/m59-intent-test.mjs
//
// The case this file exists for is a real one, and it is the first test: on 2026-09-11/12 two
// sessions built a tool called FleetScratch, from one operator ask, all night, and found each
// other only because a third session happened to be talking to both. The registry must find that
// collision — and the first version of it did NOT, which is why the distinctive-term rule exists.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIntents, writeIntents, claim, release, sweep, nearby, claimState,
         overlap, terms, isDistinctive, formatNearby, formatIntents, intentFile,
         LIVE, EXPIRED, ABANDONED, COMMON, DEFAULT_TTL_HOURS,
         NEARBY_FLOOR } from './m59-intent.mjs';

const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};
const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
const root = mkdtempSync(join(tmpdir(), 'm59-intent-'));
const ENV = { M59_BOARD_DIR: root };
const HOUR = 3600_000;
// Liveness is injected so these tests never depend on what is running on this machine.
const alive = (t) => () => t;
const dead = () => null;

console.log(NL + 'THE COLLISION THIS EXISTS FOR — and the rule that a ratio alone gets wrong');
{
  const A = 'FleetScratch pads and the errand compiler';
  const B = 'FleetScratch: a REPL toolkit and debugging tools for fleet issues';

  const o = overlap(A, B);
  ok('the two topics share exactly one term', o.shared.length === 1, JSON.stringify(o.shared));
  ok('and it is the distinctive one', o.distinctive[0] === 'fleetscratch');
  // THE FIRST VERSION SCORED 1/7 AND MISSED IT. The proportion threw away the whole signal.
  // Asserted against the FLOOR rather than a hardcoded number: the claim being made is "the
  // ratio would have missed it", and that is a comparison with the threshold, not with 0.2.
  ok('the raw ratio falls under the floor, so a ratio alone would have missed it',
     o.ratio < NEARBY_FLOOR, `ratio ${o.ratio} vs floor ${NEARBY_FLOOR}`);
  ok('BUT A SHARED DISTINCTIVE TERM IS A HIT ANYWAY', o.score >= 1, String(o.score));
  ok('and the render says which rule fired',
     /shared distinctive term\(s\): fleetscratch/.test(o.matchedBy), o.matchedBy);

  // AND IT MUST NOT FIRE ON REPOSITORY-COMMON WORDS, or everything matches everything.
  const noise = overlap('a tool for the fleet', 'another tool for the fleet server');
  ok('sharing only common words is not distinctive', noise.distinctive.length === 0,
     JSON.stringify(noise.distinctive));
  ok('and "fleet" and "tool" are on the common list',
     COMMON.has('fleet') && COMMON.has('tool') && COMMON.has('server'));
  ok('a genuinely unrelated topic scores nothing',
     overlap(A, 'guild hall tithes and bank balances').score === 0);
  ok('a short distinctive word is not distinctive enough', !isDistinctive('pad'));
  ok('but a real noun is', isDistinctive('fleetscratch') && isDistinctive('wallgrind'));
}

console.log(NL + 'IT REPORTS. IT DOES NOT REFUSE.');
{
  let doc = readIntents(ENV);
  doc = claim(doc, { topic: 'fleetscratch pads', by: 'session A', why: 'scratchpad tooling',
                     startOf: alive(1000) });
  // A SECOND CLAIM ON THE SAME TOPIC IS ACCEPTED. Two sessions on one topic is where feedback
  // comes from; a registry that refused would have cost the collaboration and prevented nothing.
  doc = claim(doc, { topic: 'fleetscratch repl', by: 'session B', why: 'debugging surface',
                     startOf: alive(1000) });
  ok('both claims stand', doc.claims.length === 2);

  const res = nearby(doc, 'a fleetscratch debugging repl', { startOf: alive(1000) });
  ok('and each finds the other', res.hits.length === 2, JSON.stringify(res.hits.map(h => h.by)));
  ok('both are live', res.live.length === 2);
  const text = formatNearby(res, 'a fleetscratch debugging repl');
  ok('the render names the people, not the reason', /session A/.test(text) && /session B/.test(text), text);
  ok('AND SAYS THESE ARE PEOPLE TO TALK TO', /people to TALK TO, not a refusal/.test(text), text);
  ok('and says why two on one topic is fine',
     /where feedback\s+comes from/.test(text.replace(/\s+/g, ' ')) ||
     /where feedback/.test(text), text);
}

console.log(NL + 'A CLAIM DIES TWO WAYS, and a pid alone is not enough');
{
  const now = Date.now();
  const live = { topic: 't', by: 'a', until: now + HOUR, pid: 4242, startedAt: 1000 };
  ok('a claim inside its TTL with a live holder is live',
     claimState(live, { now, startOf: alive(1000) }).state === LIVE);

  ok('past its TTL it is expired',
     claimState({ ...live, until: now - 1 }, { now, startOf: alive(1000) }).state === EXPIRED);
  ok('and says so', /TTL ran out/.test(claimState({ ...live, until: now - 1 },
     { now, startOf: alive(1000) }).why));

  ok('a dead holder abandons it', claimState(live, { now, startOf: dead }).state === ABANDONED);
  ok('naming the pid', /pid 4242 is not running/.test(claimState(live, { now, startOf: dead }).why));

  // THE CHECKSUM: a live pid is not the same as OUR pid being alive.
  const recycled = claimState(live, { now, startOf: alive(999_000) });
  ok('A RECYCLED PID IS ABANDONED, not live', recycled.state === ABANDONED);
  ok('and the reason says recycled', /was recycled/.test(recycled.why), recycled.why);
  ok('a claim with no pid can still only expire',
     claimState({ topic: 't', by: 'a', until: now + HOUR }, { now, startOf: dead }).state === LIVE);
}

console.log(NL + 'sweep retires the dead and says what it dropped');
{
  const now = Date.now();
  const doc = { schema: 'x', claims: [
    { topic: 'live one', by: 'a', until: now + HOUR, pid: 1, startedAt: 5 },
    { topic: 'expired one', by: 'b', until: now - HOUR, pid: 1, startedAt: 5 },
  ] };
  const s = sweep(doc, { now, startOf: alive(5) });
  ok('the live one is kept', s.doc.claims.length === 1 && s.doc.claims[0].topic === 'live one');
  ok('the dead one is dropped', s.dropped.length === 1 && s.dropped[0].topic === 'expired one');
  ok('and the drop carries its reason', /TTL ran out/.test(s.dropped[0].stateWhy));
}

console.log(NL + 'a dead claim is still SHOWN, because "somebody tried this and stopped" is useful');
{
  const now = Date.now();
  const doc = { schema: 'x', claims: [
    { topic: 'fleetscratch pads', by: 'a ghost', why: 'gave up', until: now + HOUR,
      pid: 7, startedAt: 5 },
  ] };
  const res = nearby(doc, 'fleetscratch', { now, startOf: dead });
  ok('it is returned', res.hits.length === 1);
  ok('marked abandoned rather than hidden', res.hits[0].state === ABANDONED);
  ok('and not counted as live', res.live.length === 0);
  const text = formatNearby(res, 'fleetscratch');
  ok('the render shows it with its state', /aband/.test(text) && /a ghost/.test(text), text);
  ok('and does NOT say talk to them', !/people to TALK TO/.test(text), text);
}

console.log(NL + 'a claim needs a topic and somebody to talk to');
{
  const doc = { schema: 'x', claims: [] };
  ok('no topic is refused', /needs a topic/.test(threw(() => claim(doc, { by: 'a' }))));
  const why = threw(() => claim(doc, { topic: 't' }));
  ok('no author is refused', !!why);
  ok('and says why that is the whole point',
     /who to talk to is the entire point/.test(why), why);

  let d = claim(doc, { topic: 't', by: 'a', startOf: alive(1) });
  d = claim(d, { topic: 't', by: 'a', why: 'second thoughts', startOf: alive(1) });
  ok('re-claiming the same topic replaces rather than duplicates', d.claims.length === 1);
  ok('with the new reason', d.claims[0].why === 'second thoughts');
  ok('releasing something nobody claimed is refused',
     /no live intent on "ghosts"/.test(threw(() => release(d, 'ghosts'))));
  ok('releasing works', release(d, 't').claims.length === 0);

  // A ONE-SHOT PROCESS MUST NOT BIND ITS OWN PID. The CLI wrote a claim and exited, and the
  // liveness check — correctly — called it abandoned before anyone could read it.
  const typed = claim(doc, { topic: 'typed at a prompt', by: 'an operator' });
  ok('a claim with no pid offered records none', typed.claims[0].pid === undefined,
     JSON.stringify(typed.claims[0]));
  ok('AND IT IS LIVE, not abandoned the moment the CLI exits',
     claimState(typed.claims[0], { startOf: dead }).state === LIVE);
  const bound = claim(doc, { topic: 'a running session', by: 'a session', pid: 4242,
                             startOf: alive(1000) });
  ok('a long-lived caller may still bind one', bound.claims[0].pid === 4242);
  ok('and it dies with that process',
     claimState(bound.claims[0], { startOf: dead }).state === ABANDONED);
  ok('the default TTL is a working day at most', DEFAULT_TTL_HOURS <= 12);
}

console.log(NL + 'empty HERE is not empty everywhere, and unreadable is not empty at all');
{
  const doc = readIntents({ M59_BOARD_DIR: join(root, 'nowhere') });
  const text = formatIntents(doc);
  ok('it says nothing is claimed HERE', /nothing is claimed HERE/.test(text), text);
  ok('and that this is not the same as nothing being claimed',
     /not the same as nothing being claimed/.test(text));
  ok('and names how two checkouts share one', /M59_BOARD_DIR/.test(text) && /M59_RUNLOCK_DIR/.test(text));

  writeFileSync(join(root, 'intents.json'), '{ not json');
  const broken = readIntents(ENV);
  ok('an unreadable registry has claims === null', broken.claims === null);
  ok('and says UNREADABLE, not empty', /UNREADABLE, not empty/.test(broken.why), broken.why);
  const res = nearby(broken, 'anything');
  ok('nearby refuses rather than reporting nobody', res.ok === false && res.hits.length === 0);
  ok('with the parse error', /will not parse/.test(res.why), res.why);
}

console.log(NL + 'it lives beside the cork board, and says which rule chose the directory');
{
  ok('the file sits in the board directory', intentFile(ENV).path.endsWith('intents.json'));
  ok('an explicit directory wins', intentFile({ M59_BOARD_DIR: '/x' }).dir === '/x');
  ok('and it falls through to the shared runlock directory',
     intentFile({ M59_RUNLOCK_DIR: '/y' }).dir === '/y');
  ok('naming which rule chose it', intentFile({ M59_RUNLOCK_DIR: '/y' }).by === 'M59_RUNLOCK_DIR');
}

rmSync(root, { recursive: true, force: true });
console.log(NL + `${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
