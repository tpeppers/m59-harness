#!/usr/bin/env node
// PREY YOU CANNOT WALK TO, AND WHY FORGETTING IT IS A TOTAL FAILURE RATHER THAN A SLOW ONE.
//
// `closeOnQuarry` has always DETECTED unreachable prey -- a null `approachSquare` returns
// "no square beside it that we can reach" -- and has never remembered it. So the next pass
// ranks the same creature nearest, walks at it, breaks off, and ranks it again. Nothing
// degrades: the keeper reports `farm`, the board reports `hunting`, and the character takes
// no damage because it never arrives. Measured on prod 2026-09-18 in the Mausoleum (1016),
// mummies behind a locked-off corner: `stuck` repeats 23, lever null, 25 minutes, 0 kills,
// 0 damage taken, escalating to STALL_NO_LEVER -- correct, and useless, because the only
// lever was "stop choosing that one" and nothing could say it.
//
// Offline. Opens no socket and touches no roster.
import { Autopilot } from './m59-autopilot.mjs';
import { findCreature } from './m59-skills.mjs';
import { OF } from './m59-parse.mjs';

let failed = 0;
const ok = (label, condition, detail = '') => {
  console.log(`  ${condition ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!condition) failed++;
};

const keeper = (policy = {}) => new Autopilot({}, { mode: 'farm', policy: { hunt: 'mummy', ...policy } });

console.log('--- the memory is keyed by SQUARE, which is what survives a respawn ---');
{
  const k = keeper();
  k.noteUnreachablePrey(1016, 4, 9);
  const live = k.unreachablePreyIn(1016);
  ok('the square is remembered', live instanceof Set && live.has('4,9'));
  ok('and only for the room it happened in', k.unreachablePreyIn(27) === null);

  // THE POINT OF THE WHOLE DESIGN. An object id is a temporary handle: renumbered on every
  // system save and recycled within hours. A mummy killed or despawned behind that corner is
  // replaced by a DIFFERENT id standing in the same place, and an id-keyed memory would chase
  // each replacement in turn while reporting `hunting` throughout.
  const avoid = k.preyAvoid(1016);
  ok('an object at that square is avoided', avoid({ id: 8325, col: 4, row: 9 }) === true);
  ok('and so is a DIFFERENT object that respawned on it',
     avoid({ id: 9999, col: 4, row: 9 }) === true, 'the id changed, the corner did not');
  ok('while a creature one square over is still fair game',
     avoid({ id: 8326, col: 5, row: 9 }) === false);
}

console.log('\n--- "unreachable" expires, because it is a claim about our MODEL ---');
{
  const k = keeper();
  k.noteUnreachablePrey(1016, 4, 9);
  // Reach into the store and age the entry past the TTL rather than sleeping for five
  // minutes: the assertion is about the expiry rule, not about the clock.
  const ttl = k.policy.unreachableSpotMs ?? (5 * 60 * 1000);
  k.unreachablePreySpots.get(1016).set('4,9', Date.now() - ttl - 1);
  ok('an aged entry is gone', k.unreachablePreyIn(1016) === null,
     'a door opens, a body moves, a jump gets declared — so this is memory, never a verdict');
}

console.log('\n--- no memory means no filter at all, not an always-true one ---');
{
  ok('nothing remembered -> null', keeper().preyAvoid(1016) === null);
  const k = keeper({ ignoreUnreachablePrey: false });
  k.noteUnreachablePrey(1016, 4, 9);
  ok('switched off -> null even with something remembered', k.preyAvoid(1016) === null,
     'off is how you reproduce the stall on purpose when you suspect a missing jump');
}

console.log('\n--- it does not leak into the safe-spot selector ---');
{
  const k = keeper();
  k.noteUnreachablePrey(1016, 4, 9);
  ok('the wall book is untouched by an unreachable-prey note',
     k.unreachableIn(1016) === null,
     'a square something unreachable STANDS on may be a perfectly good square to stand on');
}

console.log('\n--- bounded, so a long session in a bad room cannot grow it forever ---');
{
  const k = keeper();
  for (let i = 0; i < 300; i++) k.noteUnreachablePrey(1016, i, 1);
  ok('the store stays bounded', k.unreachablePreySpots.get(1016).size <= 256);
}

console.log('\n--- `avoid` narrows the hunt and can never widen it ---');
{
  const names = new Map([[1, 'mummy'], [2, 'mummy'], [3, 'brazier']]);
  const objects = new Map([
    [1, { id: 1, col: 4, row: 9, nameRsc: 1, flags: OF.ATTACKABLE }],   // unreachable corner
    [2, { id: 2, col: 8, row: 11, nameRsc: 2, flags: OF.ATTACKABLE }],  // reachable
    [3, { id: 3, col: 9, row: 11, nameRsc: 3, flags: OF.ATTACKABLE }],  // not a mummy
  ]);
  const c = { selfId: 99, self: { col: 8, row: 12 }, room: { objects },
              rsc: { get: r => names.get(r) } };
  const s = { need: () => c };

  const all = findCreature(s, 'mummy');
  ok('without avoid, both mummies are candidates', all.length === 2);
  const avoid = o => o.col === 4 && o.row === 9;
  const some = findCreature(s, 'mummy', { avoid });
  ok('with avoid, the unreachable one is dropped', some.length === 1 && some[0].id === 2);
  ok('and the brazier is still excluded — avoid runs AFTER the name filter',
     findCreature(s, 'mummy', { avoid: () => false }).every(o => o.id !== 3),
     'an avoid that refuses nothing must not reintroduce what the name filter removed');
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
