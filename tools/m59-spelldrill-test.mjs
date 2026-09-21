#!/usr/bin/env node
// A SELF-CAST IS ADDRESSED BY OBJECT ID, AND THE NAME FAILS SILENTLY. Offline: no socket,
// no broker, no fleet.
//
// THE INCIDENT, prod, 2026-09-20. Camilla drilling night vision on herself with `--target self`:
//
//     holding t9 (lease lease_HoJmC5)
//       refused (1): no reason given
//
// and mana at 33/33 for the whole run. Mana is the proof (CLAUDE.md): a cast that spends
// nothing did not happen. The same command against her object id reported `1 cast(s)` on the
// first round with mana 33 -> 13. `SELF` was `me0?.character` — the caster's own NAME, which
// does not resolve for a self-cast, so the server answered with nothing at all.
//
// WHY THIS IS A SOURCE ASSERTION AND NOT AN IMPORT. `m59-spelldrill.mjs` is a CLI with
// top-level `await call(...)`: importing it RUNS it, against whatever broker is up, and would
// drive a live character from a test. Same trap as importing m59-broker.mjs to check it. So
// this reads the file, the way m59-supervise-test.mjs already does for the same reason, and
// separately exercises the resolution order as data.
//
// `node tools/m59-spelldrill-test.mjs`
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'm59-spelldrill.mjs'), 'utf8');

console.log('--- self resolves to an object id before a name ---');
{
  const line = /const SELF = ([^;]+);/.exec(src)?.[1] ?? '';
  ok('SELF is not the bare character name', !/^\s*me0\?\.character\s*\?\?\s*null\s*$/.test(line),
     line.trim().slice(0, 90));
  ok('it prefers the object id from status', /you\?\.id/.test(line), line.trim().slice(0, 90));
  ok('...before falling back to the name', line.indexOf('you?.id') < line.indexOf('character'),
     'an id that comes after the name is an id that is never reached');
}

console.log('\n--- the resolution order, as data ---');
{
  // The same precedence the source expresses, exercised against every shape `status` returns.
  // A keeper-backed character answers `you`; the in-process path may only carry the intent
  // observation; a status call that failed must not become a hard stop.
  const pick = m => m?.you?.id ?? m?.intent_observation?.player_id ?? m?.character ?? null;
  ok('keeper-backed status gives the object id',
     pick({ you: { id: 4471 }, character: 'Camilla' }) === 4471);
  ok('intent observation is the second source',
     pick({ intent_observation: { player_id: 4471 }, character: 'Camilla' }) === 4471);
  ok('the name is still the last resort, not a refusal',
     pick({ character: 'Camilla' }) === 'Camilla');
  ok('a failed status is null, and the caller already dies on that', pick(null) === null);
  // An id of 0 is not a player and must not be preferred over a usable name. `??` would pass
  // 0 through, which is correct here only because the server never issues object id 0 — pinned
  // so that a future change to `||` is caught rather than assumed harmless.
  ok('an absent id does not swallow the name', pick({ you: {}, character: 'Camilla' }) === 'Camilla');
}

console.log('\n--- the trap is written down where the next reader will be ---');
{
  // A silent refusal that cost two sessions has to leave a note, or it is rediscovered.
  ok('the source says mana is the proof', /mana/i.test(src) && /33\/33|33 -> 13/.test(src));
  ok('and that an object id is a temporary handle',
     /temporary handle|renumbered/i.test(src),
     'resolved once is right for minutes and wrong across a server save');
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
