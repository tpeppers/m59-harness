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

console.log('');
console.log('--- closeOnQuarry RETURNS on unreachable prey, and does not walk at a null ---');
{
  // THE GAP THIS CLOSES IS IN THE TEST, NOT THE CODE. Every assertion above exercised the
  // memory and none of them called `closeOnQuarry`, so a shipped edit that dropped the
  // `return` from the unreachable branch — leaving it to fall through to `approach.col` on a
  // null approach — passed the whole suite. The memory was written correctly and then the
  // function threw. A unit test of the bookkeeping is not a test of the branch.
  const k = keeper();
  const foe = { id: 7, col: 4, row: 9, nameRsc: 1 };
  let walked = 0;
  const s = {
    name: 'test',
    client: { room: { objects: new Map([[7, foe]]) }, rsc: { get: () => 'mummy' } },
    world: { room: { num: 1016 }, approachSquare: () => null },
    walkTo: async () => { walked++; return { arrived: true }; },
  };
  k.s = s;
  k.note = () => {};

  let threw = null, out = null;
  try { out = await k.closeOnQuarry({ id: 7 }); } catch (e) { threw = e; }

  ok('it does not throw', threw === null, threw ? threw.message : '');
  ok('it reports closed:false with a readable reason',
     out?.closed === false && /no square beside it/.test(out?.why ?? ''));
  ok('and it never asked the mover to walk anywhere', walked === 0,
     'falling through called walkTo(null.col) and threw before it could');
  ok('while still remembering the square for the next pass',
     k.unreachablePreyIn(1016)?.has('4,9') === true);
}

console.log('');
console.log('--- EVERY ban announces itself, because a silent one cannot be investigated ---');
{
  // 2026-09-18: a postmortem sweep for "ignoring prey we cannot walk to" came back 0 of 16
  // and was read as clearing this feature. It only ever covered the no-approach site — the
  // terminal-movement site banned squares silently, so the query could not see the half that
  // was likelier to be firing in a crowded room. The check was sound and the instrument had
  // a hole in it. This pins that both sites speak.
  const mk = (approach, walkResult) => {
    const k = keeper();
    const foe = { id: 7, col: 4, row: 9, nameRsc: 1 };
    const notes = [];
    k.s = {
      name: 'test',
      client: { room: { objects: new Map([[7, foe]]) }, rsc: { get: () => 'mummy' } },
      world: { room: { num: 1016 }, approachSquare: () => approach },
      walkTo: async () => walkResult,
    };
    k.note = (what) => notes.push(what);
    k.terminalMovement = () => ({ why: 'start_has_no_floor', terminal: true });
    return { k, notes };
  };

  const a = mk(null, { arrived: true });
  await a.k.closeOnQuarry({ id: 7 });
  ok('the no-approach site announces the ban',
     a.notes.includes('ignoring prey we cannot walk to'));

  const b = mk({ col: 5, row: 9, steps: 1 }, { arrived: false, reason: 'start_has_no_floor' });
  await b.k.closeOnQuarry({ id: 7 });
  ok('and so does the TERMINAL-movement site, which used to be silent',
     b.notes.includes('ignoring prey we cannot walk to'),
     `notes seen: ${JSON.stringify(b.notes)}`);
  ok('and it banned the square too, so note and ban agree',
     b.k.unreachablePreyIn(1016)?.has('4,9') === true);
}

// THE SELECTION HAS TO ASK THE SAME QUESTION fight() ASKS.
//
// Icky Cave (27), prod 2026-09-25: the nearest orc sat in the one-way pocket, was proved
// unreachable, and the pass kept SELECTING it — then pinned fight() to its exact id, which
// fight()'s own avoid filter removed. "nothing here matches — try one of the names above",
// no out_of_reach, so no pull and no close: `broke off` once a second, six characters, zero
// landed hits. A source check, because the filter is inline in pass() and the failure it
// guards is its deletion.
console.log('--- quarry selection skips proved-unreachable prey, as fight() does ---');
{
  const { readFileSync } = await import('node:fs');
  const AP = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const sel = AP.indexOf('const avoidPrey = this.preyAvoid(room?.num ?? null);');
  const rank = AP.indexOf('found = rankQuarries(this.s.name, room?.num, found, { preferId });');
  const pick = AP.indexOf('const selectedQuarry = found[0] ?? null;');
  ok('the pass builds the avoid predicate from the same seam fight() gets', sel > 0);
  ok('...before the quarries are ranked', sel > 0 && rank > sel);
  ok('...and before the quarry is chosen', sel > 0 && pick > sel);
  ok('it filters found by it', AP.slice(sel, sel + 400).includes('found.filter(o => !avoidPrey(o))'));

  // And the predicate agrees with fight()'s: the same object that fight() would drop is the
  // one selection now drops, and the one on our side survives both.
  const k = keeper();
  k.noteUnreachablePrey(27, 47, 31);
  const avoid = k.preyAvoid(27);
  const pocket = { id: 1, col: 47, row: 31 }, ours = { id: 2, col: 39, row: 34 };
  const selected = [pocket, ours].filter(o => !avoid(o));
  ok('the pocket orc is dropped from selection', !selected.includes(pocket));
  ok('the orc on our side is kept', selected.length === 1 && selected[0] === ours);

  // THE SECOND WAY fight() GETS PINNED TO NOTHING: a pending pull whose creature died to
  // somebody else. plannedQuarryId prefers the pull's id over the selection, and the only
  // check for a vanished pull lived under out_of_reach, which "nothing matches" never sets.
  const planned = AP.indexOf('const plannedQuarryId = this.pendingPull?.target_id');
  const guard = AP.lastIndexOf('const pulled = c.room.objects.get(this.pendingPull.target_id);', planned);
  ok('a pending pull is re-checked against the room before its id is used',
     guard > 0 && planned - guard < 1200);
  ok('...and dropped when its quarry is gone or no longer attackable',
     AP.slice(guard, planned).includes('!(pulled.flags & OF.ATTACKABLE)')
       && AP.slice(guard, planned).includes('this.pendingPull = null;'));
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
