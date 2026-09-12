#!/usr/bin/env node
// DRESS AS A FILTERED SCENE LOAD. Offline: no server, no snapshot on disk, no DM socket.
//
//   node tools/m59-shadowscene-test.mjs
//
// The claim under test is an EQUIVALENCE: the commands dressPlan emits are the commands cmdDress
// used to build inline. If that drifts, the shadow fleet quietly stops being a mirror, and the
// symptom is a dry run that answers a question about a fleet production does not have.
import { statCmds, healthCmds, setProp } from './m59-dm.mjs';
import { snapshotToScene, filterActors, unmatched, dressPlan, dressConfidence,
         formatDress, shadowRunner } from './m59-shadowscene.mjs';
import { SCENE_SCHEMA } from './m59-scene.mjs';

const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};
const threw = async (f) => { try { await f(); return null; } catch (e) { return e.message; } };

const SNAP = {
  taken_at: '2026-09-12T00:00:00.000Z', source: 'prod broker :9998',
  characters: [
    { shadow_name: 'hk2', shadow_account: 'shadow2', prod_character: 'Hackem',
      attributes: { might: 40, intellect: 10, stamina: 30, agility: 20, mysticism: 5, aim: 25 },
      level: 44, max_health: 440, vigor: 137, room: 40, row: 12, col: 34, wielding: 'long sword' },
    { shadow_name: 'hk3', shadow_account: 'shadow3', prod_character: 'Slashem',
      attributes: { might: 35, intellect: 12, stamina: 28, agility: 22, mysticism: 8, aim: 20 },
      level: 41, max_health: 410, vigor: 90, room: 40, row: 14, col: 30, wielding: 'axe' },
    // NO SHEET, no vigor, nowhere in particular — the degraded row every real snapshot has.
    { shadow_name: 'hk9', shadow_account: 'shadow9', prod_character: 'Latecomer',
      attributes: null, level: null, max_health: null, vigor: null,
      room: 199, row: null, col: null, wielding: null },
  ],
};

console.log(NL + 'a shadow snapshot IS a scene — same schema, same observed/unknown marking');
{
  const sc = snapshotToScene(SNAP);
  ok('it carries the scene schema', sc.schema === SCENE_SCHEMA);
  ok('every character became an actor', sc.actors.length === 3);
  ok('and every one is ours', sc.actors.every(a => a.mine === true && a.kind === 'player'));
  ok('it keeps the line back to the character it copies', sc.actors[0].mirrors === 'Hackem');
  ok('the capture time is the snapshot time, not now', sc.captured.at === SNAP.taken_at);

  const hk2 = sc.actors[0], hk9 = sc.actors[2];
  ok('a sheet that exists is OBSERVED', hk2.stats.how === 'observed' && hk2.stats.v.might === 40);
  ok('A SHEET THAT DOES NOT IS UNKNOWN, NOT ZEROED', hk9.stats.how === 'unknown');
  ok('max health is recorded as health, because in this game it IS the level',
     hk2.vitals.hp.v.value === 440);
  ok('a missing max health is unknown', hk9.vitals.hp.how === 'unknown');
  ok('vigor is carried', hk2.vitals.vigor.v.value === 137);
  ok('and a missing vigor is unknown rather than 0', hk9.vitals.vigor.how === 'unknown');
  ok('a fine position is observed', hk2.at.v.col === 34);
  ok('and a missing one is unknown — the bug where all 21 recorded null and nobody noticed',
     hk9.at.how === 'unknown');

  // The scene's room is the MAJORITY room; the outliers carry their own.
  ok('the scene room is where most of the fleet stands', sc.room.num === 40);
  ok('and an outlier keeps its own room on the actor', hk9.room === 199);
  ok('the notes say which, and how many', /2 of 3 characters stand/.test(sc.notes.join(' ')),
     sc.notes.join(' | '));
  ok('and that no credential is in here', /never a password/.test(sc.notes.join(' ')));

  ok('an empty snapshot is refused rather than yielding an empty scene',
     /no characters is not a scene/.test(String(
       (() => { try { snapshotToScene({ characters: [] }); } catch (e) { return e.message; } })())));
}

console.log(NL + 'filterActors — the half executeLoad was missing');
{
  const sc = snapshotToScene(SNAP);
  ok('NO OPTIONS CHANGES NOTHING, which is the safe default',
     filterActors(sc, {}).actors.length === 3 && filterActors(sc, {}).filtered === null);

  const two = filterActors(sc, { only: ['hk2', 'hk3'] });
  ok('only narrows to the named', two.actors.map(a => a.name).join() === 'hk2,hk3');
  ok('and says what it dropped and why',
     two.filtered.dropped === 1 && /only/.test(two.filtered.by), JSON.stringify(two.filtered));
  ok('an account name matches as well as a character name',
     filterActors(sc, { only: ['shadow9'] }).actors[0].name === 'hk9');
  ok('except is the inverse', filterActors(sc, { except: 'hk9' }).actors.length === 2);
  ok('mine:true keeps ours', filterActors(sc, { mine: true }).actors.length === 3);
  ok('AND mine:false LEAVES OUR FLEET ALONE — load the room, not the characters',
     filterActors(sc, { mine: false }).actors.length === 0);
  ok('kinds narrows by kind', filterActors(sc, { kinds: ['monster'] }).actors.length === 0);
  ok('the filters compose by intersection',
     filterActors(sc, { only: ['hk2', 'hk3'], except: 'hk3' }).actors.length === 1);

  // A NAME THAT MATCHES NOTHING MUST NOT BE SILENTLY DROPPED. That is how a load half-lands.
  ok('unmatched names are reported', unmatched(sc, ['hk2', 'nobody']).join() === 'nobody');
  ok('and an empty filter reports none', unmatched(sc, null).length === 0);
}

console.log(NL + 'THE EQUIVALENCE: dressPlan emits the commands cmdDress used to build inline');
{
  const sc = filterActors(snapshotToScene(SNAP), { only: 'hk2' });
  const steps = dressPlan(sc, { objectFor: () => 7218 });
  const cmds = steps.map(s => s.cmd);

  // Built from the SAME helpers, so this asserts "one operation" rather than "two that agree".
  const want = [...statCmds(7218, SNAP.characters[0].attributes),
                ...healthCmds(7218, 440),
                setProp(7218, 'piVigor', 137), setProp(7218, 'piExertion', 0),
                'send object 7218 NewVigor'];
  ok('the commands match, in order', cmds.join('|') === want.join('|'),
     `${cmds.length} vs ${want.length}`);
  ok('MAX HEALTH TAKES ALL THREE PROPERTIES — piHealth alone gets refigured back down',
     healthCmds(7218, 440).length >= 3, String(healthCmds(7218, 440).length));
  ok('and the plan says why it is writing health at all',
     /which IS the level/.test(steps.find(s => /Health/i.test(s.cmd))?.why ?? ''),
     steps.find(s => /Health/i.test(s.cmd))?.why);
  ok('VIGOR AND EXERTION GO TOGETHER, or the copy drains at a rate the original does not',
     cmds.some(c => /piVigor/.test(c)) && cmds.some(c => /piExertion/.test(c)));
  ok('and NewVigor applies it', cmds[cmds.length - 1] === 'send object 7218 NewVigor');
  ok('it is pure — nothing but strings came back', steps.every(s => typeof s.cmd === 'string'));

  // ---- the degraded row writes NOTHING it was not told
  const late = filterActors(snapshotToScene(SNAP), { only: 'hk9' });
  ok('A CHARACTER WITH NO SHEET AND NO VIGOR GETS NO COMMANDS AT ALL',
     dressPlan(late, { objectFor: () => 9 }).length === 0);

  // ---- addressing by name when nothing resolved it, which is what `plan` prints
  ok('with no resolver it addresses by name, like loadPlan',
     dressPlan(filterActors(snapshotToScene(SNAP), { only: 'hk2' }))[0].cmd.includes('hk2'));
  ok('vigor can be left out', !dressPlan(sc, { objectFor: () => 1, vigor: false })
     .some(s => /piVigor/.test(s.cmd)));
}

console.log(NL + 'how much of this dress is measured, and how much we simply do not have');
{
  const sc = snapshotToScene(SNAP);
  const c = dressConfidence(sc);
  ok('it counts fields, not characters', c.total === 15);
  ok('the two full rows are mostly observed', c.observed === 10, String(c.observed));
  ok('AND THE DEGRADED ONE IS COUNTED AS UNKNOWN RATHER THAN MISSING', c.unknown === 5,
     String(c.unknown));
  const text = formatDress(filterActors(sc, { only: ['hk2', 'hk3'] }), dressPlan(sc));
  ok('the render says what was filtered out', /1 of 3 actor\(s\) dropped/.test(text), text);
  ok('and how much of it is observed', /10 observed/.test(text), text);
}

console.log(NL + 'the runner reach() hands `establish: { shadow: ... }` to');
{
  let got = null;
  const run = shadowRunner({
    readSnapshot: async () => SNAP,
    execute: async (scene, opts) => { got = { scene, opts }; return { ok: true }; },
  });

  const r = await run('shadow', 'prod-mirror', { agents: ['hk2', 'hk3'] });
  ok('it executes', r.ok === true);
  ok('with the fleet it was asked for', got.scene.actors.map(a => a.name).join() === 'hk2,hk3');
  ok('under the name the checkpoint declared', got.scene.name === 'prod-mirror');
  // A PLAYER IS NOT FROZEN. ClearBasicTimers is for monsters in a tableau.
  ok('AND PAUSE IS OFF — there is nothing to freeze when the actors are our own characters',
     got.opts.pause === false);

  const miss = await threw(() => run('shadow', 'x', { agents: ['hk2', 'ghost'] }));
  ok('an agent the snapshot does not have refuses the whole dress', !!miss);
  ok('naming it', /no actor for ghost/.test(miss), miss);
  ok('and saying why a partial dress is worse than none',
     /the part that landed looks like the whole/.test(miss), miss);

  ok('it refuses a strategy that is not its own',
     /handed strategy "dm"/.test(await threw(() => run('dm', 'x', {}))));
  const none = shadowRunner({ readSnapshot: async () => SNAP, execute: async () => ({}),
                              only: ['hk2'], mine: false });
  ok('a filter that leaves nothing refuses rather than sending an empty batch',
     /nothing to dress/.test(await threw(() => none('shadow', 'x', {}))));
}

console.log(NL + `${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
