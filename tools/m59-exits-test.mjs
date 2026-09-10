#!/usr/bin/env node
// THE UNIFIED EXIT VIEW — offline, no socket, no roster, no fleet.
//
//   node tools/m59-exits-test.mjs
//
// WHAT IT PINS, and every one of these is an instrument that gave a confident wrong answer on
// 2026-09-10 rather than a hypothetical:
//
//  1. THE PREDICATE IS SAID BY THE FILE THAT EVALUATES IT. A kod trigger condition is a
//     conjunction of conditions, and a condition may be a disjunction: the two-square doorway
//     into the Temple of Shal'ille is `((new_row = 17) or (new_row = 18)) and (new_col = 12)`.
//     `inRegion` in m59-codeexits.mjs has always read same-axis equalities as ALTERNATIVES,
//     with the reason in its comment -- and it is the evaluator `World.exits()` uses to find
//     the square to stand on. Meanwhile THREE separate places that PRINTED a predicate joined
//     the whole list with ' and ', so the same doorway was described as
//     `row == 17 and row == 18 and col == 12`: an impossibility, about a trigger the fleet was
//     crossing perfectly well. A description that contradicts the evaluator sends a reader
//     hunting a defect in the world instead of in the sentence.
//
//     CORRECTED, hours after the first attempt: I wrote a syntactic checker in the view that
//     saw two `==` on one axis and called six of twenty-four triggers DEAD. It was the fourth
//     reader to get the same sentence wrong. Deadness is now measured by asking `inRegion`
//     whether any square of a room that size satisfies the predicate -- which cannot disagree
//     with the mover -- and the shape that half the readers got wrong is reported separately as
//     AMBIGUOUS, which is a defect in the data and not in the world. `values: [...]` is the
//     unambiguous shape, and `satisfies` had to learn it in the same commit that wrote it into
//     the data: without that, `v === c.value` against an absent `value` is false for every
//     square, and the mover would have found no way to stand on six live triggers.
////  2. "NOTHING ARRIVES HERE" HAS TO NAME WHAT IT LOOKED AT. `m59-exitreport.mjs` printed
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
import { describeWhen, deadWhen, ambiguousWhen, exitsFor, inboundFor, unifiedRoom, inboundVerdict, isUnresolved,
         mayArrive,
         KINDS } from './m59-exits.mjs';
import { loadMap, movementMapFile, findPath } from './m59-map.mjs';
// The evaluator itself, asked directly: the claim under test is that it and the sentence agree.
import { inRegion } from './m59-codeexits.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (what, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra !== undefined ? '  — ' + extra : ''}`); }
};

console.log('');
console.log('1. ONE PREDICATE LANGUAGE — the evaluator and the sentence must not disagree');
{
  const doorway = [{ axis: 'row', op: '==', values: [17, 18] },
                   { axis: 'col', op: '==', value: 12 }];
  const flat = [{ axis: 'row', op: '==', value: 17 }, { axis: 'row', op: '==', value: 18 },
                { axis: 'col', op: '==', value: 12 }];

  // THE TWO SHAPES MEAN THE SAME THING TO THE EVALUATOR. That is the fact the renderers were
  // contradicting, and it is why the file was never wrong about the world.
  for (const [name, w] of [['values', doorway], ['flat', flat]]) {
    ok(`${name}: r17c12 is in the region`, inRegion(w, 17, 12) === true);
    ok(`${name}: r18c12 is too — the doorway is two squares`, inRegion(w, 18, 12) === true);
    ok(`${name}: r19c12 is not`, inRegion(w, 19, 12) === false);
    ok(`${name}: and neither is r17c13`, inRegion(w, 17, 13) === false);
  }
  ok('and both are said the same way, unambiguously',
     describeWhen(doorway) === '(row == 17 or row == 18) and col == 12' &&
     describeWhen(flat) === describeWhen(doorway), describeWhen(flat));
  // The bracket is not decoration: `row == 17 or 18 and col == 12` reads as though the `or`
  // might reach across the `and`, and a misread predicate is the whole subject of this file.
  ok('a single value needs no bracket',
     describeWhen([{ axis: 'col', op: '==', value: 12 }]) === 'col == 12');
  ok('an inequality band is unchanged',
     describeWhen([{ axis: 'row', op: '<', value: 18 }, { axis: 'col', op: '<', value: 13 }]) ===
     'row < 18 and col < 13');
  ok('an empty predicate is the empty string, not a crash',
     describeWhen(undefined) === '' && describeWhen([]) === '');
}

console.log('');
console.log('   DEADNESS IS MEASURED, NOT INFERRED — with the mover\'s own evaluator');
{
  const dims = { rows: 26, cols: 32 };
  ok('the temple doorway is live, in both shapes',
     deadWhen([{ axis: 'row', op: '==', values: [17, 18] },
               { axis: 'col', op: '==', value: 12 }], dims) === null &&
     deadWhen([{ axis: 'row', op: '==', value: 17 }, { axis: 'row', op: '==', value: 18 },
               { axis: 'col', op: '==', value: 12 }], dims) === null);
  // The case a syntactic checker misses and this one catches: inequalities on one axis DO
  // conjoin, so this really is a region no square can be in.
  const dead = deadWhen([{ axis: 'row', op: '<', value: 5 }, { axis: 'row', op: '>', value: 9 }], dims);
  ok('a genuinely impossible band is dead', typeof dead === 'string');
  ok('and it says it asked inRegion rather than reasoning about the conditions',
     /inRegion/.test(dead), dead);
  ok('a predicate off the end of a small room is dead there',
     typeof deadWhen([{ axis: 'row', op: '==', value: 90 }], { rows: 10, cols: 10 }) === 'string');
  ok('and live in a room big enough to hold it',
     deadWhen([{ axis: 'row', op: '==', value: 90 }], { rows: 99, cols: 99 }) === null);
  ok('an empty predicate is not dead', deadWhen([], dims) === null);
}

console.log('');
console.log('   AND THE AMBIGUOUS SHAPE IS REPORTED — a defect in the data, not in the world');
{
  const amb = ambiguousWhen([{ axis: 'row', op: '==', value: 17 },
                             { axis: 'row', op: '==', value: 18 },
                             { axis: 'col', op: '==', value: 12 }]);
  ok('two == conditions on one axis is ambiguous', typeof amb === 'string');
  ok('and it names both readings, so the reader knows which one is right',
     /ALTERNATIVES/.test(amb) && /AND/.test(amb), amb);
  // A refusal that cannot say what to write instead gets deleted by the next person in a hurry.
  ok('and it names the shape to write', /values: \[17,18\]/.test(amb), amb);
  ok('the repaired shape is not ambiguous',
     ambiguousWhen([{ axis: 'row', op: '==', values: [17, 18] }]) === null);
  ok('one value per axis is not ambiguous',
     ambiguousWhen([{ axis: 'row', op: '==', value: 17 },
                    { axis: 'col', op: '==', value: 12 }]) === null);
  ok('the SAME value twice is not ambiguous, merely redundant',
     ambiguousWhen([{ axis: 'row', op: '==', value: 17 },
                    { axis: 'row', op: '==', value: 17 }]) === null);
  ok('an inequality band is not ambiguous — those really do conjoin',
     ambiguousWhen([{ axis: 'row', op: '>', value: 14 },
                    { axis: 'row', op: '<', value: 18 }]) === null);
  ok('a null predicate is not ambiguous', ambiguousWhen(null) === null);
}
console.log('2. THE TEMPLE OF SHAL\'ILLE — the room an exit report called unreachable');
const map = loadMap(movementMapFile());
{
  const u = unifiedRoom(map, 48);
  ok('the map has it', u.name === 'The Temple of Shal\'ille', u.name);
  ok('SOMETHING arrives, which is the answer that was being got wrong', u.summary.reachable);
  ok('and it arrives ONLY by a trigger — no door, in either data source',
     u.summary.entered_only_by_trigger);
  ok('both inbound triggers are live', u.summary.dead_triggers_in === 0,
     JSON.stringify(u.inbound.map(e => e.unsatisfiable)));
  ok('and neither is written in the shape half the readers get wrong',
     u.summary.ambiguous_triggers_in === 0,
     JSON.stringify(u.inbound.map(e => e.ambiguous)));
  // THE TEMPLE IS WHERE A FALSE REFUSAL IS MOST EXPENSIVE: room 48 holds the priestess who
  // teaches 21 of the 22 Shal'ille spells, so a gate that sealed it would simply stop the fleet
  // learning that school, and nobody would connect it to a deploy.
  const from6 = u.inbound.find(e => e.from === 6);
  ok('room 6 declares a trigger into the temple', !!from6);
  ok('and its predicate is said as the two-square doorway it is',
     from6?.trigger === '(row == 17 or row == 18) and col == 12', from6?.trigger);
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

  // TWO FIXTURES, both through the FILE and in a child process, because that is the whole
  // chain: the data shape, the loader, the evaluator, the union and the verdict.
  // `M59_CODE_EXITS` is the same lever the A/B used to establish that the 534 -> 48 trigger is
  // what makes the temple plannable at all.
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
  // A: the file exactly as it was before the `values` repair. The trigger STILL WORKS -- this
  // is the correction to my first attempt, which called this state dead.
  const flat = write('flattened.json', e => { e.when = flatten(e.when); });
  // B: genuinely impossible. Inequalities on one axis DO conjoin, so no square can be in this
  // region under anybody's reading. Synthesised: no regeneration produces it, but the
  // ROOM-level verdict only changes when the last live way in goes, and that transition is what
  // fleetScript and the broker refuse on.
  const sealed = write('sealed.json', e => {
    e.when = [{ axis: 'row', op: '<', value: 5 }, { axis: 'row', op: '>', value: 9 }];
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
                                   ambiguous_in: u.summary.ambiguous_triggers_in,
                                   cites: u.inbound.map(e => e.provenance?.cite ?? null),
                                   plannable: M.findPath(map, 39, ${room}, {}).found }));
    });
  `], { cwd: join(HERE, '..'), env: { ...process.env, M59_CODE_EXITS: file },
        encoding: 'utf8' }).trim().split('\n').pop());

  const now = askIn(join(HERE, '..', 'substrate', 'm59-codeexits.json'), 48);
  ok('with the file as it stands, the temple is reachable', now.ok && now.code === 'reachable');
  ok('with nothing dead and nothing ambiguous',
     now.dead_in === 0 && now.ambiguous_in === 0, JSON.stringify(now));
  ok('and plannable', now.plannable === true);
  ok('and each inbound trigger cites the kod resource it was read out of',
     now.cites.every(c => !!c), JSON.stringify(now.cites));

  const a = askIn(flat, 48);
  ok('with the ORs flattened back, the temple is STILL REACHABLE — the state it was in all ' +
     'along, and my first attempt called it sealed',
     a.ok && a.code === 'reachable' && a.dead_in === 0, JSON.stringify(a));
  ok('and the shape is reported as ambiguous instead',
     a.ambiguous_in === 1, JSON.stringify(a));

  const b = askIn(sealed, 48);
  ok('with every inbound region genuinely impossible, nothing can arrive',
     b.code === 'only_dead_triggers', JSON.stringify(b));
  ok('and it is named as a DATA defect rather than a missing route',
     /data defect in substrate\/m59-codeexits\.json/.test(b.why ?? ''), b.why);
  ok('and it quotes the measurement back',
     /no square in a/.test(b.why ?? ''), b.why);
  // The room stays PLANNABLE with dead triggers, and that is exactly the trap: the router has
  // no opinion about a predicate, so the path looks fine and the body never crosses.
  ok('while the router still happily plans into it — which is why this check exists',
     b.plannable === true);
}
console.log('');
console.log('4. ONE DECISION, ASKED BY BOTH — a gate one caller consults is a gate the other walks past');
{
  ok('a reachable room is permitted', mayArrive(map, 38).ok === true);
  // THE PAIR THAT MATTERS, asked for by the session that had just been burned by the absence
  // of this gate: a learn-skill errand issued walk 39 -> 48, the router gave no hops, and the
  // script walked a 490s budget, failed with "did not arrive, and gave no reason", and
  // RE-ISSUED the identical walk. Twenty minutes, one character held throughout. The gate has
  // to refuse the impossible destination WITHOUT refusing this one -- room 48 is the priestess
  // who teaches 21 of the 22 Shal'ille spells, so a false refusal here would quietly stop the
  // fleet learning that school and nobody would connect it to a deploy.
  ok('the temple is plannable AND permitted — the two must agree',
     findPath(map, 39, 48, {}).found === true && mayArrive(map, 48).ok === true);
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

console.log('');
console.log('5. AN UNRESOLVED DOOR IS ITS OWN KIND — and it is where the orphans came from');
{
  ok('a real room number is resolved', isUnresolved(382) === false);
  ok('the bake\'s unresolved marker is not', isUnresolved(-1) === true);
  ok('and neither is a missing or non-numeric one',
     isUnresolved(null) && isUnresolved(undefined) && isUnresolved('door'));
  ok('zero is not a room either', isUnresolved(0) === true);

  // West Jasper is the worked example: 33 declared ways out, 15 of which go nowhere the graph
  // knows. Counted as `declared` they made the room look better connected than it is.
  const out382 = exitsFor(map, 382, { telemetry: false });
  const unresolved = out382.filter(e => e.kind === 'unresolved');
  ok('West Jasper holds doors the bake could not resolve', unresolved.length > 0);
  ok('and every one of them is separated from the routable exits',
     unresolved.every(e => isUnresolved(e.to)) &&
     out382.filter(e => e.kind === 'declared').every(e => !isUnresolved(e.to)));
  ok('the summary counts them as their own kind',
     (unifiedRoom(map, 382).summary.out_by_kind.unresolved ?? 0) === unresolved.length);

  // THE ORPHANS ARE THEIR SHADOW. Old Granary's only way out is into West Jasper, and a door
  // is two-sided -- so the way in is one of West Jasper's unresolved doors rather than an
  // undeclared trigger. Getting that advice right is the difference between resolving 362 doors
  // and hand-writing seventeen triggers that may not exist.
  const granary = inboundVerdict(map, 351);
  ok('nothing arrives at the Old Granary', granary.code === 'nothing_arrives');
  ok('and the verdict names the neighbour to look in',
     (granary.unresolved_doors_next_door ?? []).some(x => x.room === 382 && x.doors > 0),
     JSON.stringify(granary.unresolved_doors_next_door));
  ok('the sentence says a door is two-sided rather than telling you to write a trigger',
     /door is two-sided/.test(granary.why) && !/add it to m59-codeexits/.test(granary.why),
     granary.why);
  // A room with no way out at all gets the OTHER advice, because there is no door to resolve.
  const sealed = Object.keys(map.rooms).map(Number).find(n =>
    inboundVerdict(map, n).code === 'nothing_arrives' &&
    exitsFor(map, n, { telemetry: false }).length === 0);
  if (sealed != null)
    ok('a room with no way out either is told to look for a trigger',
       /trigger nobody has declared/.test(inboundVerdict(map, sealed).why),
       inboundVerdict(map, sealed).why);
  else ok('a room with no way out either is told to look for a trigger', false, 'no such room');
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
