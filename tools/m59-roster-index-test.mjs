#!/usr/bin/env node
// Offline. No socket, no roster on disk — every case is a fake `read`.
//
// WHAT THIS PINS, and why each one is here rather than being obvious:
//
//   * A SECRET NEVER LEAVES THE MODULE. The roster IS the password store and there is no
//     reset and no email on those accounts, so "it doesn't print them" is not good enough —
//     the index must not CARRY them. Asserted by walking every value in the result.
//   * A NAME THAT IS NOT UNIQUE IS REFUSED. Two rosters can each hold a "Kermit" and they are
//     different bodies on different servers. Picking one silently moves somebody else's
//     character, which is the failure the whole module exists to prevent.
//   * ONE ERRAND CANNOT SPAN TWO FLEETS, for the same reason the broker matches on the state
//     path rather than the fleet label.
import assert from 'node:assert';

const { indexRosters, resolveHeroes, oneFleetOnly } = await import('./m59-roster-index.mjs');

let n = 0, bad = 0;
const ok = (what, cond) => { n++; if (!cond) { bad++; console.log(`  FAIL ${what}`); } else console.log(`  ok   ${what}`); };

// ---------------------------------------------------------------- fixtures
const PROD = {
  t1: { credentials: { account: 'a1', password: 'SECRET-ONE', character: 'Kermit', host: '10.0.0.1', port: 5959 } },
  t2: { credentials: { account: 'a2', password: 'SECRET-TWO', character: 'Gonzo', host: '10.0.0.1', port: 5959 } },
};
const SHADOW = {
  s1: { credentials: { account: 'b1', password: 'SECRET-THREE', character: 'Kermit', host: '127.0.0.1', port: 15959 } },
  s2: { credentials: { account: 'b2', password: 'SECRET-FOUR', character: 'Alpha', host: '127.0.0.1', port: 15959 } },
};
const FILES = {
  'd/prod.json': JSON.stringify(PROD),
  'd/shadow.json': JSON.stringify(SHADOW),
  // A menagerie file is not a fleet and must not be indexed as one.
  'd/prod.menagerie.json': JSON.stringify({ hk9: { credentials: { account: 'x', password: 'S', character: 'Host', host: '10.0.0.1', port: 5959 } } }),
};
const read = (p) => {
  const key = String(p).replace(/\\/g, '/');
  const hit = Object.keys(FILES).find(f => key.endsWith(f));
  if (!hit) throw new Error('ENOENT');
  return FILES[hit];
};

// THE REAL FUNCTION, DRIVEN THROUGH INJECTED `read` AND `list`.
//
// The first version of this file built its own index by hand and asserted against that. A
// mutation check exposed it as decoration: making `indexRosters` carry the entire
// `credentials` object -- passwords included -- still passed 27 of 27, because nothing here
// ever called the function under test. `list` was made injectable so this line can exist,
// and every assertion below now runs against the module rather than against a copy of it.
const built = indexRosters({
  dirs: ['d'],
  read,
  list: () => Object.keys(FILES).map(f => f.split('/').pop()),
});

console.log('\nTHE INDEX CARRIES NO SECRET — not "does not print", does not HOLD');
{
  const blob = JSON.stringify({ fleets: built.fleets, heroes: [...built.heroes.values()].flat() });
  ok('no password anywhere in the index', !/SECRET-/.test(blob));
  ok('no account anywhere in the index', !/"a1"|"b1"|"a2"|"b2"/.test(blob));
  const one = built.heroes.get('gonzo')[0];
  ok('an entry carries exactly fleet/file/agent/character/server',
     JSON.stringify(Object.keys(one).sort()) === JSON.stringify(['agent', 'character', 'file', 'fleet', 'server']));
  ok('and it is frozen, so a caller cannot staple a secret onto it', Object.isFrozen(one));
}

console.log('\nA UNIQUE NAME RESOLVES; A DUPLICATED ONE IS REFUSED');
{
  const r = resolveHeroes(['Gonzo'], built);
  ok('unique name resolves', r.resolved.length === 1 && r.resolved[0].agent === 't2');
  ok('and names its fleet', r.resolved[0].fleet === 'prod');
  ok('and its server', r.resolved[0].server === '10.0.0.1:5959');

  const d = resolveHeroes(['Kermit'], built);
  ok('a name in two rosters resolves to NOTHING', d.resolved.length === 0);
  ok('it is reported ambiguous rather than guessed', d.ambiguous.length === 1);
  ok('and the refusal lists both candidates', d.ambiguous[0].found.length === 2);
  ok('and tells you how to qualify it', /prod:Kermit/.test(d.ambiguous[0].why) &&
                                        /shadow:Kermit/.test(d.ambiguous[0].why));
}

console.log('\nQUALIFIERS: by fleet, and by server');
{
  ok('fleet-qualified picks one', resolveHeroes(['prod:Kermit'], built).resolved[0]?.agent === 't1');
  ok('the other fleet picks the other', resolveHeroes(['shadow:Kermit'], built).resolved[0]?.agent === 's1');
  ok('server-qualified works too',
     resolveHeroes(['127.0.0.1:15959/Kermit'], built).resolved[0]?.agent === 's1');
  // The slash is what tells `host:port/Name` from `fleet:Name`. A colon alone is not enough.
  ok('a server qualifier is not mistaken for a fleet',
     resolveHeroes(['10.0.0.1:5959/Kermit'], built).resolved[0]?.fleet === 'prod');
  ok('a wrong qualifier resolves to nothing rather than the wrong body',
     resolveHeroes(['shadow:Gonzo'], built).unknown.length === 1);
}

console.log('\nAGENT IDS ARE ACCEPTED, because that is what the tools speak');
{
  ok('a bare agent id resolves', resolveHeroes(['t2'], built).resolved[0]?.character === 'Gonzo');
  ok('an unknown one is unknown, not a crash', resolveHeroes(['t99'], built).unknown.length === 1);
}

console.log('\nA MENAGERIE FILE IS NOT A FLEET');
{
  ok('prod.menagerie.json is not indexed', !built.fleets.some(f => f.fleet.includes('menagerie')));
  ok('and its host is not addressable as a hero', !built.heroes.has('host'));
}

console.log('\nONE ERRAND CANNOT SPAN TWO FLEETS');
{
  const mixed = [...resolveHeroes(['prod:Kermit'], built).resolved,
                 ...resolveHeroes(['shadow:Alpha'], built).resolved];
  const v = oneFleetOnly(mixed);
  ok('two rosters is refused', v.ok === false);
  ok('and the refusal names both', /prod/.test(v.why) && /shadow/.test(v.why));
  ok('one roster is allowed', oneFleetOnly(resolveHeroes(['Gonzo'], built).resolved).ok === true);
  ok('and an empty set does not throw', oneFleetOnly([]).ok === true);
}

console.log('\nJUNK IN, REFUSAL OUT');
{
  ok('empty list is empty, not an error', resolveHeroes([], built).resolved.length === 0);
  ok('blank strings are dropped', resolveHeroes(['', '  '], built).unknown.length === 0);
  ok('null is survivable', resolveHeroes(null, built).resolved.length === 0);
}

console.log(`\n${n - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
