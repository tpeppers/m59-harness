#!/usr/bin/env node
// THE STONE CENSUS — offline: no broker, no server, no roster. It reads the kod if it is here
// and says so if it is not.
//
//   node tools/m59-stones-test.mjs
//
// WHAT IT PINS. "There are seven mana nodes" was written in the node-runner skill; the bitmask
// in `kod/include/blakston.khd` declares THIRTEEN, and the two tables in this repository that
// enumerated them had six and seven, disagreed in both directions, and used different keys for
// room 515 so that `nodes/<key>.md` could never be found from both sides.
//
// Every assertion here is a way the first version of that census was wrong, and most of them
// were wrong in the direction that reads as a finding:
//
//   * A GREP FOR `Create(&ManaNode` MISSES SUBCLASSES. `FeyNode` and `AvarNode` are both
//     `is ManaNode`; the Vale of Sorrows stone is a FeyNode. And `CorpseNode` is `is Portal`
//     while carrying `piNode_num = NODE_CORPSENODE`, so it occupies a bit of the mask without
//     being a ManaNode at all — reported as "declared but unplaced" until the class discovery
//     learned to look for the node number as well as the hierarchy.
//   * FIVE STONES ARE CREATED WITH NO POSITION and placed later by the room. The condition is
//     the interesting half: one appears for one hour of the game day, one is the prize for a
//     faction war, one needs a lever, one disappears again on a 60-second timer.
//   * THE "ALREADY EXISTS, RETURN" GUARD IS NOT THE CONDITION. Both deferred rooms open with
//     `if poNode <> $ { return; }`, so the nearest guard above the appearance is the one case
//     in which it does NOT appear. The first version printed that as the condition — the exact
//     inverse — for NODE_Q.
//   * ONE .roo MAY BE BAKED AS SEVERAL ROOMS. `guest6.roo` is 1006 AND 1016, and a join to one
//     room silently kept whichever came last, which produced a missing stone and a spurious
//     room in the same report.
//   * AND A CONSUMER THAT READS THE TABLE HAS NOTHING TO DIFF. The differ reported the runner
//     as "has 0, missing every room" the moment it was repaired to import STONES — the
//     instrument punishing the fix it exists to prompt.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { STONES, attemptable, objectiveFor, approachWithin, stoneKeyed, stonesInSource,
         nodeEnum, nodeClasses, stones, drift,
         nodesFromRunner, nodesFromFleetscript, KOD_ROOT } from './m59-stones.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra !== undefined ? '  — ' + extra : ''}`); }
};

console.log('');
console.log('THE TABLE — thirteen stones, and which of them are errands');
{
  ok('thirteen', Object.keys(STONES).length === 13, Object.keys(STONES).length);
  ok('every one names a room, a node number and a square',
     Object.values(STONES).every(s => Number.isFinite(s.room) && /^NODE_/.test(s.node) &&
                                      Number.isFinite(s.row) && Number.isFinite(s.col)));
  // The operator's two rulings, and the game's own. A stone that is exempt must never be
  // ATTEMPTED, and the reason travels with it so nobody re-litigates it at 02:00.
  ok('Ukgoth is exempt from attempt', !!STONES.ukgoth.exempt);
  ok('the guest demonstration stone is never attempted', !!STONES.mausoleum.never);
  ok('and each refusal says who said so',
     /operator/.test(STONES.ukgoth.exempt) && /design/.test(STONES.mausoleum.never));
  // THREE ANSWERS, NOT TWO. Operator, 2026-09-10: "the Dreaded Caves of Ice node requires
  // killing the Yeti to get access... so while we can include it in 'the walk', for both the
  // Fey Node and the Yeti Cave, the goal should actually just be to walk to within a few coarse
  // squares away from the mana node." So "do not try to meld it" and "do not go there" are
  // separate instructions — collapsing them is what left the Ice Caves off every list when the
  // useful errand was always to walk to it and stop.
  ok('the ice cave is an APPROACH errand, not a meld', objectiveFor(STONES.ice) === 'approach');
  ok('and so is the Fey stone', objectiveFor(STONES.fey) === 'approach');
  ok('both are still worth SENDING somebody to',
     attemptable(STONES.ice) && attemptable(STONES.fey));
  ok('an ordinary stone is a meld errand', objectiveFor(STONES.victoria) === 'meld');
  ok('and each gated stone says what the meld is behind',
     /yeti/i.test(STONES.ice.gate ?? '') && /karma/i.test(STONES.fey.gate ?? ''));
  ok('the ice gate cites the kod, not a memory', /icecave1\.kod/.test(STONES.ice.gate ?? ''));
  ok('an approach is looser than the meld box, and says how much',
     approachWithin(STONES.ice) === 5 && approachWithin(STONES.victoria) === 2);
  // The guest stone is a THIRD thing: not gated, not exempt by ruling — not there for us.
  ok('the guest stone has no objective at all', objectiveFor(STONES.mausoleum) === null);
  ok('and Ukgoth still has none either, on the operator\'s ruling',
     objectiveFor(STONES.ukgoth) === null);
  ok('the lever and the timed swing are CONDITIONAL, not exempt — a different claim',
     STONES.martyr.conditional === true && STONES.avar.conditional === true &&
     !STONES.martyr.exempt && !STONES.avar.exempt);
  ok('attemptable() refuses every kind that has no objective',
     !attemptable(STONES.ukgoth) && !attemptable(STONES.mausoleum) &&
     !attemptable(STONES.martyr) && !attemptable(STONES.avar));
  ok('and permits an ordinary walk-and-stand stone',
     attemptable(STONES.ice) && attemptable(STONES.victoria) && attemptable(STONES.badlands));
  ok('every stone that is not a plain walk says what makes it appear',
     Object.values(STONES).filter(s => s.exempt || s.never || s.conditional)
       .every(s => !!s.appears));

  // THE KEY COLLISION THAT MADE A DOSSIER UNFINDABLE. Room 515 was `peak` to the errand and
  // `seafarer` to the circuit, so the critic reported `no_dossier` for a stone whose dossier
  // would have been sitting under the other name.
  ok('room 515 has one key', stoneKeyed('peak')?.room === 515);
  ok('and the old name still resolves to it', stoneKeyed('seafarer')?.key === 'peak');
  ok('an unknown name is null, not a guess', stoneKeyed('nowhere') === null);
  ok('the instanced Mausoleum carries both of its baked rooms',
     JSON.stringify(STONES.mausoleum.rooms) === '[1006,1016]');
}

console.log('');
console.log('THE PARSE — both placement shapes, and the guard that is not the condition');
{
  const staticSrc = [
    'resources:', '   room_name_x = "Somewhere"', '   room_x = x.roo', 'messages:',
    '   Constructor()', '   {',
    '      Send(self,@NewHold,#what=Create(&ManaNode,#node_num=NODE_TEST),',
    '           #new_row=20,#new_col=17,#fine_row=0,#fine_col=0);', '   }',
  ].join('\n');
  const [st] = stonesInSource(staticSrc, { file: 'x.kod', classes: ['ManaNode'] });
  ok('a static placement is read off the same statement',
     st?.row === 20 && st?.col === 17 && st?.placement === 'static', JSON.stringify(st));
  ok('and it carries the .roo, which is the only exact key to the bake', st?.roo === 'x.roo');
  ok('and the room name the file declares', st?.room_name === 'Somewhere');

  const deferredSrc = [
    'resources:', '   room_name_y = "Elsewhere"', '   room_y = y.roo', 'messages:',
    '   Constructor()', '   {',
    '      Create(&ManaNode,#node_num=NODE_LEVER,#iRoomNum=piRoom_num);', '   }', '',
    '   ActivatePortal()', '   {',
    '      if poNode <> $', '      {', '         return;', '      }',
    '      poNode = Send(SYS,@FindNodeByNum,#num=NODE_LEVER);',
    '      Send(poNode,@NodeAppear,#where=self,#row=57,#col=45);', '   }',
  ].join('\n');
  const [df] = stonesInSource(deferredSrc, { file: 'y.kod', classes: ['ManaNode'] });
  ok('a deferred placement is found through NodeAppear',
     df?.placement === 'deferred' && df?.row === 57 && df?.col === 45, JSON.stringify(df));
  ok('and the method is named, which IS the condition for a lever',
     df?.when_method === 'ActivatePortal', df?.when_method);
  // The inverse-condition bug: `poNode <> $` is the guard for "already here, do nothing".
  ok('the already-exists guard is NOT reported as the condition',
     df?.when === null || !/poNode <> \$/.test(df.when), JSON.stringify(df?.when));

  const clockSrc = [
    'resources:', '   room_name_z = "Late"', '   room_z = z.roo', 'messages:',
    '   Constructor()', '   {',
    '      Create(&ManaNode,#node_num=NODE_CLOCK,#iRoomNum=piRoom_num);', '   }', '',
    '   RecalcLightAndWeather(ihour=0)', '   {',
    '      if ihour = 0 AND poNode = $', '      {',
    '         poNode = Send(SYS,@findnodebynum,#num=NODE_CLOCK);',
    '         Send(poNode,@NodeAppear,#where=self,#row=27,#col=61);', '      }', '   }',
  ].join('\n');
  const [ck] = stonesInSource(clockSrc, { file: 'z.kod', classes: ['ManaNode'] });
  ok('a real condition IS reported when there is one',
     /ihour = 0/.test(ck?.when ?? ''), JSON.stringify(ck?.when));

  ok('a subclass is only found when the class list includes it',
     stonesInSource('   Create(&FeyNode,#node_num=NODE_F,#karma=0);', { classes: ['ManaNode'] })
       .length === 0 &&
     stonesInSource('   Create(&FeyNode,#node_num=NODE_F,#karma=0);',
                    { classes: ['ManaNode', 'FeyNode'] }).length === 1);
  ok('a file with no stone yields none', stonesInSource('messages:\n   Foo() { }').length === 0);
}

console.log('');
console.log('THE CONSUMERS — a list that reads the table has nothing to drift');
{
  ok('a hand-written runner list is parsed',
     nodesFromRunner("const NODES = [\n  { key: 'ice', room: 750, x: 1 },\n];").ice?.room === 750);
  ok('a frozen errand table is parsed',
     nodesFromFleetscript("export const NODES = Object.freeze({\n  ice: { room: 750 },\n});")
       .ice?.room === 750);
  ok('and neither invents entries from an empty file',
     Object.keys(nodesFromRunner('')).length === 0 &&
     Object.keys(nodesFromFleetscript('')).length === 0);
}

console.log('');
if (!existsSync(join(KOD_ROOT, 'include', 'blakston.khd'))) {
  console.log(`THE KOD — not present at ${KOD_ROOT}, so the live half is skipped (set M59_ROOT)`);
} else {
  console.log('THE KOD — the enum is the authority, and the table matches it');
  const en = nodeEnum();
  ok('the enum declares thirteen node numbers', en.length === 13, en.length);
  ok('and NODE_MAX_VALUE is not one of them', !en.some(e => /MAX_VALUE/.test(e.node)));
  // The game states the guest exemption in a comment on the enum line. An operator ruling
  // corroborated by the source is worth more than either alone.
  const guest = en.find(e => e.node === 'NODE_GUEST');
  ok('the kod itself says the guest node is not normally attainable',
     /not attainable except by guests/i.test(guest?.kod_note ?? ''), guest?.kod_note);

  const classes = nodeClasses();
  ok('the class list finds the ManaNode subclasses',
     classes.includes('FeyNode') && classes.includes('AvarNode'), classes.join(','));
  ok('and the class that carries a node number without being one',
     classes.includes('CorpseNode'), classes.join(','));

  const all = stones();
  ok('every node number in the enum has a placement in the kod',
     en.every(e => all.some(s => s.node.toUpperCase() === e.node.toUpperCase())),
     en.filter(e => !all.some(s => s.node.toUpperCase() === e.node.toUpperCase()))
       .map(e => e.node).join(','));
  ok('the Fey stone is in the Vale of Sorrows, on a karma outcome',
     all.some(s => s.node === 'NODE_FAERIE' && s.room === 532 && /KVERY/.test(s.when ?? '')),
     JSON.stringify(all.find(s => s.node === 'NODE_FAERIE')));
  ok('the Ukgoth stone is in room 599, on the game clock',
     all.some(s => s.node.toUpperCase() === 'NODE_I9' && s.room === 599 &&
                   /ihour = 0/.test(s.when ?? '')),
     JSON.stringify(all.find(s => s.node.toUpperCase() === 'NODE_I9')));

  const d = drift();
  ok('the tracked table names every stone the enum declares',
     !d.enum.missing_from_table.length, d.enum.missing_from_table.join(','));
  ok('and claims none the enum does not',
     !d.enum.in_the_table_but_not_the_enum.length,
     d.enum.in_the_table_but_not_the_enum.join(','));
  ok('the circuit reads the table rather than keeping a copy',
     d.runner.reads_the_table === true, JSON.stringify(d.runner));
  ok('so the census is green', d.ok === true, JSON.stringify(d));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
