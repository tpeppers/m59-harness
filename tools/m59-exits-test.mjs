#!/usr/bin/env node
// THE UNIFIED EXIT VIEW — offline, no socket, no roster, no fleet.
//
//   node tools/m59-exits-test.mjs
//
// WHAT IT PINS, and every one of these is an instrument that gave a confident wrong answer on
// 2026-09-10 rather than a hypothetical:
//
//  1. A KOD `OR` IS NOT AN `AND`. `m59-codeexits.json` stored `((row = 17) or (row = 18)) and
//     (col = 12)` as a flat condition list, which every reader joins with AND — so the predicate
//     became `row == 17 and row == 18 and col == 12`, which nothing can satisfy, and the trigger
//     was DEAD while looking perfectly healthy on the page. Six of twenty-four entries were in
//     that state, including a second way into the Temple of Shal'ille and one into Marion.
//     `values: [...]` is the repaired shape; `unsatisfiableWhen` is the check that finds the
//     next one. THE GENERATOR STILL HAS THIS BUG — see the room-48 case below, which is what
//     will fail if the file is regenerated without fixing it.
//
//  2. "NOTHING ARRIVES HERE" HAS TO NAME WHAT IT LOOKED AT. `m59-exitreport.mjs` printed
//     "NOTHING IN THE WORLD GRAPH ARRIVES HERE" about room 48 — a room the router was planning
//     fifteen-hop journeys into — because it scanned `edgeExits`/`goExits` and a trigger is in
//     neither. There are five sources of "an exit" and every tool asked a different subset.
//
//  3. THE VERDICT AGREES WITH THE MOVER, WHICH IS WHAT MAKES IT SAFE TO REFUSE ON. fleetScript
//     refuses a walk to a room the view says nothing arrives at (guarantee 15). That is only
//     honest if the router would have refused it too, so the equivalence is asserted here
//     across the WHOLE map rather than argued in a comment.
//
//  4. AND IT IS STILL A FACT ABOUT THE FILE. Seventeen of the rooms nothing arrives at have a
//     way OUT, and a room a person can leave is a room a person got into. The refusal must name
//     the file to add the trigger to and must never call the place unreachable.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeWhen, unsatisfiableWhen, exitsFor, inboundFor, unifiedRoom, inboundVerdict, mayArrive,
         KINDS } from './m59-exits.mjs';
import { loadMap, movementMapFile, findPath } from './m59-map.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (what, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra !== undefined ? '  — ' + extra : ''}`); }
};

console.log('');
console.log('1. A CONDITION MAY BE AN OR, and rendering one as an AND states an impossibility');
{
  ok('a single value renders as itself',
     describeWhen([{ axis: 'col', op: '==', value: 12 }]) === 'col == 12');
  ok('`values` renders as an OR',
     describeWhen([{ axis: 'row', op: '==', values: [17, 18] }]) === 'row == 17 or 18');
  ok('and the conjunction between conditions is still AND',
     describeWhen([{ axis: 'row', op: '==', values: [17, 18] },
                   { axis: 'col', op: '==', value: 12 }]) === 'row == 17 or 18 and col == 12');
  ok('an empty predicate is the empty string, not a crash',
     describeWhen(undefined) === '' && describeWhen([]) === '');
}

console.log('');
console.log('   and the flattened form is REPORTED rather than silently carried');
{
  const dead = unsatisfiableWhen([{ axis: 'row', op: '==', value: 17 },
                                  { axis: 'row', op: '==', value: 18 },
                                  { axis: 'col', op: '==', value: 12 }]);
  ok('two different == values on one axis is unsatisfiable', typeof dead === 'string');
  ok('and it says which axis, and both values', /row/.test(dead) && /17 and 18/.test(dead), dead);
  // A refusal that cannot say what to do instead gets deleted by the next person in a hurry.
  ok('and it names the repaired shape to write',
     /values: \[17,18\]/.test(dead), dead);

  ok('the repaired shape is satisfiable',
     unsatisfiableWhen([{ axis: 'row', op: '==', values: [17, 18] },
                        { axis: 'col', op: '==', value: 12 }]) === null);
  ok('one value per axis is satisfiable',
     unsatisfiableWhen([{ axis: 'row', op: '==', value: 17 },
                        { axis: 'col', op: '==', value: 12 }]) === null);
  ok('the SAME value twice on one axis is satisfiable, merely redundant',
     unsatisfiableWhen([{ axis: 'row', op: '==', value: 17 },
                        { axis: 'row', op: '==', value: 17 }]) === null);
  // Deliberately NOT detected: a general satisfiability checker is a bigger thing than this
  // file can justify, and one that reports more than it can prove sends readers hunting a
  // defect that is not there.
  ok('an inequality pair is left alone, even an impossible one',
     unsatisfiableWhen([{ axis: 'row', op: '<', value: 5 },
                        { axis: 'row', op: '>', value: 9 }]) === null);
  ok('a null predicate is satisfiable', unsatisfiableWhen(null) === null);
}

console.log('');
console.log('2. THE TEMPLE OF SHAL\'ILLE — the room an exit report called unreachable');
const map = loadMap(movementMapFile());
{
  const u = unifiedRoom(map, 48);
  ok('the map has it', u.name === 'The Temple of Shal\'ille', u.name);
  ok('SOMETHING arrives, which is the answer that was being got wrong', u.summary.reachable);
  ok('and it arrives ONLY by a trigger — no door, in either data source',
     u.summary.entered_only_by_trigger);
  ok('both inbound triggers are alive after the OR repair',
     u.summary.dead_triggers_in === 0, JSON.stringify(u.inbound.map(e => e.unsatisfiable)));
  // THE REGENERATION CANARY. Room 6 -> 48 is one of the six entries that had the OR flattened.
  // If somebody regenerates m59-codeexits.json with the generator as it stands, this fails.
  const from6 = u.inbound.find(e => e.from === 6);
  ok('room 6 declares a trigger into the temple', !!from6);
  ok('and its predicate is the OR, not the impossible AND',
     from6?.trigger === 'row == 17 or 18 and col == 12', from6?.trigger);
  ok('every inbound carries where it came from',
     u.inbound.every(e => e.provenance?.source === 'substrate/m59-codeexits.json'));
  ok('and a citation into the kod', u.inbound.every(e => !!e.provenance?.cite),
     JSON.stringify(u.inbound.map(e => e.provenance?.cite)));
}

console.log('');
console.log('   the view is a UNION, and each exit says which source it came from');
{
  // Room 38 (Castle Victoria) is the busiest declared junction in the bake.
  const out = exitsFor(map, 38, { telemetry: false });
  ok('it has declared exits', out.some(e => e.kind === 'declared'));
  ok('every exit names a kind from the closed set', out.every(e => KINDS.includes(e.kind)));
  ok('every exit names its source', out.every(e => !!e.provenance?.source));
  ok('a declared exit is attributed to the bake',
     out.filter(e => e.kind === 'declared').every(e => /edgeExits/.test(e.provenance.source)));
  ok('inbound is the same shape as outbound', inboundFor(map, 38, { telemetry: false })
     .every(e => KINDS.includes(e.kind) && Number.isFinite(e.from)));
  ok('a room that is not in the map is not a crash',
     exitsFor(map, 999999, { telemetry: false }).length === 0);
}

console.log('');
console.log('3. THE VERDICT AGREES WITH THE MOVER — which is what makes refusing on it honest');
{
  ok('a room that is not in the bake says so',
     inboundVerdict(map, 999999).code === 'no_such_room');
  const v48 = inboundVerdict(map, 48);
  ok('the temple is reachable, by a trigger', v48.ok && v48.kinds.join() === 'trigger');
  ok('and it names every source it consulted, not just the one that answered',
     v48.consulted.length === 3 && v48.consulted.some(c => /codeexits/.test(c)),
     JSON.stringify(v48.consulted));

  const orphans = Object.keys(map.rooms).map(Number)
    .filter(n => inboundVerdict(map, n).code === 'nothing_arrives');
  ok('the map really does have rooms nothing arrives at', orphans.length > 0);
  // THE EQUIVALENCE. The router's BFS expands the same three sources this view unions, so a
  // room with no inbound cannot be the end of any route the mover could take. Asserted over
  // every one of them, because guarantee 15 refuses a journey on the strength of it.
  const disagree = orphans.filter(n => findPath(map, 39, n, {}).found);
  ok(`no route exists into any of the ${orphans.length} of them, from 39`,
     disagree.length === 0, disagree.join(', '));
  // And the other direction on a sample: a reachable room the router can plan into.
  ok('while a reachable room IS plannable', findPath(map, 39, 48, {}).found === true);

  const why = inboundVerdict(map, orphans[0]).why;
  ok('the refusal names the file where the missing trigger goes',
     /m59-codeexits\.json/.test(why), why);
  // 4. AND IT IS A FACT ABOUT THE FILE. Every mana node stands where a person can walk.
  ok('and it never says the room cannot be reached',
     !/(unreachable|impossible|cannot be reached)/i.test(why), why);
  ok('it says out loud that everything was consulted, so it is not one tool\'s blind spot',
     /not one tool/.test(why), why);

  const leavable = orphans.filter(n => exitsFor(map, n, { telemetry: false }).length > 0);
  ok(`${leavable.length} of them have a way OUT — a room a person can leave, they got into`,
     leavable.length > 0);
}

console.log('');
console.log('   A DEAD TRIGGER IS REACHABLE ON PAPER AND UNREACHABLE IN FACT');
{
  // Proved through the FILE, in a child process, because that is the whole chain: the data
  // shape, the loader, the union and the verdict. `M59_CODE_EXITS` is the same lever the A/B
  // used to establish that the 534 -> 48 trigger is what makes the temple plannable at all.
  const dir = mkdtempSync(join(tmpdir(), 'm59exits-'));
  const real = JSON.parse(readFileSync(join(HERE, '..', 'substrate', 'm59-codeexits.json'), 'utf8'));

  // TWO FIXTURES, because the partial case is the one that actually happened and it is the
  // one that stays silent. The 6 -> 48 predicate is an OR; the 534 -> 48 one is a pair of
  // inequalities, so flattening the ORs kills the first trigger and leaves the second alive.
  const flatten = (when) => (when ?? []).flatMap(c => Array.isArray(c.values)
    ? c.values.map(v => ({ axis: c.axis, op: '==', value: v }))
    : [c]);
  const write = (name, mut) => {
    const copy = JSON.parse(JSON.stringify(real));
    for (const list of Object.values(copy.rooms))
      for (const e of list) if (Number(e.to) === 48) mut(e);
    const f = join(dir, name);
    writeFileSync(f, JSON.stringify(copy));
    return f;
  };
  // A: the file exactly as it was before tonight's repair.
  const partial = write('flattened.json', e => { e.when = flatten(e.when); });
  // B: every way in dead. Synthesised -- no single regeneration produces it -- because the
  // ROOM-level verdict only changes when the last live trigger goes, and that transition is
  // what fleetScript refuses on.
  const sealed = write('sealed.json', e => {
    e.when = [{ axis: 'row', op: '==', value: 17 }, { axis: 'row', op: '==', value: 18 },
              { axis: 'col', op: '==', value: 12 }];
  });

  const askIn = (file, room) => JSON.parse(execFileSync(process.execPath, ['-e', `
    import('./tools/m59-map.mjs').then(async M => {
      const X = await import('./tools/m59-exits.mjs');
      const map = M.loadMap(M.movementMapFile());
      const v = X.inboundVerdict(map, ${room});
      const u = X.unifiedRoom(map, ${room});
      console.log(JSON.stringify({ code: v.code, ok: v.ok, why: v.why ?? null,
                                   dead_triggers: v.dead_triggers ?? 0,
                                   dead_in: u.summary.dead_triggers_in,
                                   cites: u.inbound.map(e => e.provenance?.cite ?? null),
                                   plannable: M.findPath(map, 39, ${room}, {}).found }));
    });
  `], { cwd: join(HERE, '..'), env: { ...process.env, M59_CODE_EXITS: file },
        encoding: 'utf8' }).trim().split('\n').pop());

  const now = askIn(join(HERE, '..', 'substrate', 'm59-codeexits.json'), 48);
  ok('with the file as it stands, the temple is reachable', now.ok && now.code === 'reachable');
  ok('with nothing dead', now.dead_in === 0 && now.dead_triggers === 0, JSON.stringify(now));
  ok('and plannable', now.plannable === true);
  ok('and each inbound trigger cites the kod resource it was read out of',
     now.cites.every(c => !!c), JSON.stringify(now.cites));

  const a = askIn(partial, 48);
  ok('with the ORs flattened back, the room is STILL reachable — the state it was in all along',
     a.ok && a.code === 'reachable', JSON.stringify(a));
  ok('but the dead trigger is counted rather than passed over silently',
     a.dead_in === 1 && a.dead_triggers === 1, JSON.stringify(a));

  const b = askIn(sealed, 48);
  ok('with every inbound predicate impossible, nothing can arrive',
     b.code === 'only_dead_triggers', JSON.stringify(b));
  ok('and it is named as a DATA defect rather than a missing route',
     /data defect in substrate\/m59-codeexits\.json/.test(b.why ?? ''), b.why);
  ok('and it quotes the impossible predicate back',
     /required to equal 17 and 18/.test(b.why ?? ''), b.why);
  // The room stays PLANNABLE with dead triggers, and that is exactly the trap: the router has
  // no opinion about a predicate, so the path looks fine and the body never crosses.
  ok('while the router still happily plans into it — which is why this check exists',
     b.plannable === true);
}
console.log('');
console.log('4. ONE DECISION, ASKED BY BOTH — a gate one caller consults is a gate the other walks past');
{
  ok('a reachable room is permitted', mayArrive(map, 38).ok === true);
  const trigger = mayArrive(map, 48);
  ok('a trigger-entered room is permitted, and says how it is entered',
     trigger.ok === true && trigger.code === 'trigger_only');
  ok('and warns that arriving at the boundary is the FAILURE there',
     /arriving at the boundary is the FAILURE/.test(trigger.note ?? ''), trigger.note);

  const orphan = Object.keys(map.rooms).map(Number)
    .find(n => inboundVerdict(map, n).code === 'nothing_arrives');
  const no = mayArrive(map, orphan);
  ok('a room nothing arrives at is refused', no.ok === false);
  ok('and the refusal says a caller may go anyway WITH A REASON',
     /must say so with a reason/.test(no.why ?? ''), no.why);
  // THE ESCAPE HATCH IS THE POINT. This gate must never be the thing that stops the world
  // model improving: the errand that FINDS the missing trigger has to be able to aim at the
  // room nothing arrives at.
  const anyway = mayArrive(map, orphan, { waiver: { reason: 'looking for the missing door' } });
  ok('a waiver with a reason permits it', anyway.ok === true);
  ok('and the reason is quoted back rather than merely accepted',
     /looking for the missing door/.test(anyway.note ?? ''), anyway.note);
  ok('a bare string is accepted as the reason too', mayArrive(map, orphan, { waiver: 'because' }).ok);
  // A waiver with NO reason is not a waiver -- the same rule as fleetScript's `unsafe`.
  ok('a waiver with no reason does NOT permit it',
     mayArrive(map, orphan, { waiver: {} }).ok === false);
  ok('and neither does an empty one', mayArrive(map, orphan, { waiver: '' }).ok === false);
  ok('a room that is not in the map is refused, with the sentence closed',
     mayArrive(map, 999999).ok === false &&
     /baked map\. A caller/.test(mayArrive(map, 999999).why ?? ''), mayArrive(map, 999999).why);
}

console.log('');
console.log('   and BOTH callers really do ask it — the structural claim, not the comment');
{
  // MATCH THE CALL, NEVER THE PROSE. An earlier test in this repository asserted against a
  // comment explaining a removal and passed for the wrong reason twice, so every line that
  // is a comment is stripped before looking.
  const code = (f) => readFileSync(join(HERE, f), 'utf8')
    .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const fs = code('m59-fleetscript.mjs');
  const broker = code('m59-broker.mjs');
  ok('fleetScript asks mayArrive', /mayArrive\(/.test(fs));
  ok('and imports it from the unified view', /m59-exits\.mjs/.test(fs));
  ok('the broker asks mayArrive', /mayArrive\(/.test(broker));
  ok('and asks it about the map it is already holding, not a second copy',
     /mayArrive\(worldMap,/.test(broker));
  // The health gate is the other half of the same arrangement, and the reason this one is
  // shaped like it: `m59-travelgate.mjs` decides for the BODY, `mayArrive` for the DESTINATION.
  ok('and both still ask the shared HEALTH gate as well',
     /mayStartJourney\(/.test(fs) && /mayStartJourney\(/.test(broker));
  ok('the exit report reads the view too, rather than scanning exits itself',
     /inboundFor\(/.test(code('m59-exitreport.mjs')));
  // GUARANTEE 15 has to be REGISTERED as well as wired, or `unsafe` cannot name it and the
  // banner cannot count it -- the same failure as a setting that silently does nothing.
  ok('the guarantee is registered under the name the waiver uses',
     /reachable: \{/.test(fs) && /waived\.has\('reachable'\)/.test(fs));
}

console.log('');console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
