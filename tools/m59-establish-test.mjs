#!/usr/bin/env node
// ONE CHECKPOINT, SEVERAL WAYS TO REACH IT. Offline: no server, no DM socket, no broker.
//
//   node tools/m59-establish-test.mjs
//
// The three things that make a shortcut trustworthy, each pinned here:
//
//   1. IF IT ALREADY HOLDS, NOTHING RUNS. Re-running an establish that was not needed is how a
//      scene gets clobbered by its own setup.
//   2. `holds` IS ASKED AGAIN AFTERWARDS. The server never says no, so "the command succeeded"
//      and "the world is as I asked" are different facts. Only the second is the checkpoint, and
//      it is the only thing that makes a DM shortcut evidence about the played route.
//   3. UNKNOWN REFUSES UNLESS ESTABLISHING IS FREE — and `free` requires a citation, because it
//      is the only value that changes behaviour.
import { checkpoint, reach, formatReach, strategyAvailable,
         HOLDS, UNKNOWN, COSTS, STRATEGIES } from './m59-establish.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};
const LAB = { M59_ADMIN_HOST: '127.0.0.1' };
const REMOTE = { M59_ADMIN_HOST: '10.0.0.7' };

console.log('\na malformed checkpoint is refused at CONSTRUCTION, not in a boss room');
{
  const threw = f => { try { f(); return null; } catch (e) { return e.message; } };
  ok('no name is refused', /needs a name/.test(threw(() => checkpoint('', { holds: () => true }))));
  ok('a non-function holds is refused',
     /never a saved blob/.test(threw(() => checkpoint('x', { holds: { armed: true } }))));
  ok('no way to establish it is refused',
     /declares no way to establish/.test(threw(() => checkpoint('x', { holds: () => true }))));
  ok('and the refusal says what that shape actually wants',
     /wants a verify step/.test(threw(() => checkpoint('x', { holds: () => true }))));
  ok('an unknown strategy is refused',
     /unknown strategy "telepathy"/.test(threw(() =>
       checkpoint('x', { holds: () => true, establish: { telepathy: () => {} } }))));
  ok('an unknown cost is refused',
     /unknown cost "trivial"/.test(threw(() =>
       checkpoint('x', { holds: () => true, establish: { dm: () => {} }, cost: { dm: 'trivial' } }))));

  // 3b. FREE REQUIRES A CITATION.
  const why = threw(() => checkpoint('x', {
    holds: () => true, establish: { dm: () => {} }, cost: { dm: 'free' } }));
  ok("cost 'free' without a citation is refused", /citation\.dm/.test(why), why);
  ok('and the refusal explains that free is the value that changes behaviour',
     /only value that/.test(why) && /optimism/.test(why), why);
  ok("'free' WITH a citation is accepted", !threw(() => checkpoint('x', {
    holds: () => true, establish: { dm: () => {} },
    cost: { dm: 'free' }, citation: { dm: 'persench.kod:76' } })));
}

console.log('\n1. IF IT ALREADY HOLDS, NOTHING RUNS');
{
  let ran = 0;
  const cp = checkpoint('armed', { holds: () => HOLDS, establish: { dm: () => { ran++; } } });
  const r = await reach(cp, {}, { env: LAB });
  ok('it succeeds', r.ok === true);
  ok('AND THE ESTABLISH NEVER RAN', ran === 0, String(ran));
  ok('it says nothing was needed', r.establishedBy === null && /already holds/.test(r.log.join()));
}

console.log('\n2. `holds` IS ASKED AGAIN, AND A FAILED SHORTCUT IS CAUGHT');
{
  let asked = 0, ran = 0;
  // The DM command "succeeds" and changes nothing — the exact failure the second ask exists for.
  const cp = checkpoint('placed', {
    holds: () => { asked++; return 'the body is not on that square'; },
    establish: { dm: () => { ran++; } },
  });
  const r = await reach(cp, {}, { env: LAB });
  ok('the establish ran', ran === 1);
  ok('holds was asked TWICE — before and after', asked === 2, String(asked));
  ok('and the whole thing is REFUSED', r.ok === false);
  ok('the refusal says it ran and still does not hold',
     /ran "dm" and it STILL does not hold/.test(r.why), r.why);

  // The nastier case: it becomes unreadable after the shortcut.
  let n = 0;
  const cp2 = checkpoint('enchanted', {
    holds: () => (++n === 1 ? 'no' : UNKNOWN),
    establish: { dm: () => {} },
  });
  const r2 = await reach(cp2, {}, { env: LAB });
  ok('an unreadable result after the shortcut also refuses', r2.ok === false);
  ok('and it names the reason the shortcut cannot be trusted',
     /server never says no/.test(r2.why), r2.why);
}

console.log('\n3. UNKNOWN REFUSES — UNLESS ESTABLISHING IS FREE');
{
  let ran = 0;
  const expensive = checkpoint('armed', {
    holds: () => UNKNOWN,
    establish: { played: () => { ran++; } },
    cost: { played: 'expensive' },
  });
  const r = await reach(expensive, {}, { env: LAB });
  ok('an unknown with an expensive establish REFUSES', r.ok === false);
  ok('and nothing was spent', ran === 0);
  ok('the refusal names the cost so the operator knows what they are authorising',
     /is expensive rather than free/.test(r.why), r.why);
  ok('and it names the override', /allowUnknown/.test(r.why));

  const forced = await reach(expensive, {}, { env: LAB, allowUnknown: true });
  ok('allowUnknown spends it anyway', ran === 1);
  ok('though it still refuses when holds stays unknown afterwards', forced.ok === false);

  // The enchant-weapon case: asking is impossible, writing is free and idempotent.
  let cast = 0, state = UNKNOWN;
  const free = checkpoint('weapon enchanted', {
    holds: () => state,
    establish: { dm: () => { cast++; state = HOLDS; } },
    cost: { dm: 'free' },
    citation: { dm: 'persench.kod:76 — already-in-effect is raised in CanPayCosts, before cost' },
  });
  const r2 = await reach(free, {}, { env: LAB });
  ok('an unknown with a FREE establish just establishes', r2.ok === true && cast === 1);
  ok('and the log records the citation that permitted it',
     /persench\.kod:76/.test(r2.log.join('\n')), r2.log.join('\n'));
}

console.log('\nstrategy availability: dm/scene/shadow need a lab, played runs anywhere');
{
  for (const w of ['dm', 'scene', 'shadow']) {
    ok(`${w} is available on loopback`, strategyAvailable(w, LAB).ok === true);
    const av = strategyAvailable(w, REMOTE);
    ok(`${w} is NOT available against a remote admin host`, av.ok === false);
    ok(`and ${w} says why`, /not this machine/.test(av.why), av.why);
  }
  ok('played is available anywhere — it is the errand', strategyAvailable('played', REMOTE).ok);
}

console.log('\nit falls back to a strategy that IS available, and prefers what it is told to');
{
  const calls = [];
  const cp = checkpoint('at the hall', {
    holds: () => (calls.length ? HOLDS : 'not yet'),
    establish: { dm: () => calls.push('dm'), played: () => calls.push('played') },
  });
  const r = await reach(cp, {}, { env: REMOTE });
  ok('with no lab it falls back to played', r.ok && r.establishedBy === 'played', JSON.stringify(calls));

  calls.length = 0;
  const r2 = await reach(cp, {}, { env: LAB });
  ok('with a lab it takes the first declared — dm', r2.establishedBy === 'dm', JSON.stringify(calls));

  calls.length = 0;
  const r3 = await reach(cp, {}, { env: LAB, prefer: 'played' });
  ok('and prefer overrides that', r3.establishedBy === 'played', JSON.stringify(calls));
}

console.log('\nno way to establish it HERE is a refusal that lists every reason');
{
  const cp = checkpoint('lab only', { holds: () => 'no', establish: { dm: () => {} } });
  const r = await reach(cp, {}, { env: REMOTE });
  ok('it refuses', r.ok === false);
  ok('it says no way is available here', /no way to establish it here/.test(r.why), r.why);
  ok('and names the reason for the one that was declared',
     /not this machine/.test(r.why), r.why);
}

console.log('\na declarative strategy needs a runner, and says so rather than silently skipping');
{
  const cp = checkpoint('scene', { holds: () => 'no', establish: { scene: 'feast-hall' } });
  const noRunner = await reach(cp, {}, { env: LAB });
  ok('without run() it refuses', noRunner.ok === false);
  ok('and explains that the strategy is declarative',
     /declarative/.test(noRunner.why) && /no run\(\)/.test(noRunner.why), noRunner.why);

  const seen = [];
  let held = false;
  const cp2 = checkpoint('scene', {
    holds: () => (held ? HOLDS : 'no'),
    establish: { scene: 'feast-hall' },
  });
  const r = await reach(cp2, {}, { env: LAB,
    run: (which, value) => { seen.push([which, value]); held = true; } });
  ok('with run() the declared value is handed over', r.ok === true);
  ok('and the runner got the strategy name and its value',
     seen[0][0] === 'scene' && seen[0][1] === 'feast-hall', JSON.stringify(seen));
}

console.log('\na holds that throws is unknown, never a pass');
{
  const cp = checkpoint('x', { holds: () => { throw new Error('socket closed'); },
                               establish: { dm: () => {} } });
  const r = await reach(cp, {}, { env: LAB });
  ok('it refuses rather than treating a bug as a pass', r.ok === false);
  ok('and it says holds threw before anything ran',
     /holds threw before anything ran: socket closed/.test(r.why), r.why);
}

console.log('\nthe render leads with the verdict');
{
  const cp = checkpoint('armed', { holds: () => HOLDS, establish: { dm: () => {} } });
  const text = formatReach(await reach(cp, {}, { env: LAB }));
  ok('a pass says what happened', /^ok — already held/.test(text), text);
  const bad = formatReach(await reach(
    checkpoint('y', { holds: () => 'nope', establish: { dm: () => {} } }), {}, { env: LAB }));
  ok('a refusal leads with REFUSED', /^REFUSED —/.test(bad), bad);
}

console.log('\nthe vocabularies are closed sets, so a typo cannot become a new concept');
{
  ok('four costs, cheapest first',
     COSTS.join(',') === 'free,cheap,expensive,irreversible', COSTS.join(','));
  ok('four strategies', STRATEGIES.length === 4 && STRATEGIES.includes('shadow'));
  ok('and shadow is one of them — it is a scene load scoped to characters',
     STRATEGIES.includes('shadow') && STRATEGIES.includes('scene'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
