// EVERY WAY IN AND OUT OF A ROOM, FROM ONE PLACE, WITH ITS PROVENANCE AND ITS RECORD.
//
//   import { unifiedRoom, exitsFor, inboundFor } from './m59-exits.mjs';
//   node tools/m59-exits.mjs 48          # what the unified view says about one room
//   node tools/m59-exits.mjs 48 --json
//   node tools/m59-exits.mjs --orphans        every room no route can end at, and what leaves
//                                             it — the missing-affordance work list
//
// WHY THIS EXISTS. Asked for by the operator, 2026-09-10: "is there a reason we don't have
// synthetic exits w/debugging/telemetry attached, generated for this to create a single unified
// view for our internal tools?" There was no reason. There were FIVE sources of "an exit" and
// the union was hand-written at every call site, so each tool had its own view of the same graph
// and every one of them was honest about its subset and wrong about the world.
//
// THE MOMENT THAT PROVED IT. Same room, same second, two tools:
//
//   m59-exitreport.mjs 48   ->  "NOTHING IN THE WORLD GRAPH ARRIVES HERE"
//   findPath(map, 38, 48)   ->  found: true, 14 hops, last hop kind: "region"
//
// The router unions declared + inferred + code exits (m59-map.mjs:816 and :1028). The
// diagnostic read `edgeExits` and `goExits` and nothing else. So the tool an operator reaches
// for to ask "how do I get in here?" had the narrowest view of any of them — and it is the tool
// that told a session the Temple of Shal'ille was unreachable, and told me its exit was
// "one-way". Neither was true. The temple is entered by a trigger, which that tool cannot see.
//
// THE FIVE SOURCES, and what each one actually is:
//
//   declared  `room.edgeExits` / `room.goExits` — the bake, from the .roo and the room's own kod.
//   inferred  the FAR room declares an edge into us and we declare nothing back. Asymmetric
//             bakes are the normal case, not a defect: "exits are not doors and are not 1:1".
//   trigger   `m59-codeexits.json` — a kod `UtilGoNearSquare` that moves you when you walk into
//             a region. There is nothing to press and no packet to send, so it is invisible to
//             anything looking for a door. This is the one that cost a month.
//   fall      `m59-falljumps.json` — and it is NOT an exit. It is an INTRA-ROOM affordance
//             (`{room: 599, from: r36c16, to: r38c10}`) that makes a door reachable which the
//             step-height rule otherwise forbids. Filed here because "can I get out of this
//             room?" cannot be answered without it, and because the standing rule is that
//             "unreachable" is a fact about that file rather than about the world.
//   telemetry `substrate/hoptests.json` — tries, successes and failure reasons per boundary.
//             A door that exists and has never once been crossed is a different object from a
//             door that works, and no view that omits this can tell them apart.
//
// DIRECTEDNESS IS THE POINT, NOT A DETAIL. Every record says which way it works, because the
// whole class of error tonight was reading an asymmetry in the MODEL as an asymmetry in the
// WORLD. The temple has one declared door OUT and a trigger IN: two mechanisms, both traversable,
// and "one-way" was my word rather than the game's.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeWhen, deadWhen, ambiguousWhen } from './m59-codeexits.mjs';
import { exitsOf, inferredExits, codeExits, loadMap, movementMapFile, hazardReason,
         AVOID_IN_TRANSIT } from './m59-map.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const readJson = (p, fallback) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
};

// ---------------------------------------------------------------- the record

/** Every kind of way through a boundary this repository knows about. */
// A FIFTH KIND, AND IT IS THE ONE THAT EXPLAINS THE ORPHANS. The bake writes a door it could
// not resolve as `{ to: -1, locked: true }` -- 362 of them across 50 rooms. Counted as
// `declared`, they make a room look better connected than it is: West Jasper (382) reports 33
// ways out and 15 of them go nowhere the graph knows. Counted as themselves, they are a work
// list -- and the shadow of that list is the 17 leavable rooms nothing arrives at. Fourteen of
// those seventeen leave into 382, which has 15 unresolved doors. That is not a coincidence and
// it is not a missing trigger: it is the same doors, seen from the other side.
export const KINDS = Object.freeze(['declared', 'unresolved', 'inferred', 'trigger', 'fall']);

/** A destination the bake could not resolve. Never a room number, so never routable. */
export const isUnresolved = (to) => !Number.isFinite(Number(to)) || Number(to) <= 0;

// ---------------------------------------------------------------- trigger predicates
//
// NOT DECIDED HERE. `m59-codeexits.mjs` owns the predicate language -- parsing, evaluating and
// writing down a kod trigger condition -- and this file asks it, for the same reason the router
// and the mover ask it: a diagnostic that forms its own opinion about a predicate is a second
// opinion rather than a look at the one in play.
//
// THIS IS A CORRECTION OF MY OWN FIRST ATTEMPT, hours old. I wrote a syntactic checker here
// that saw two `==` conditions on one axis, declared the trigger UNSATISFIABLE, and called six
// of twenty-four entries dead. The evaluator sitting in m59-codeexits.mjs -- the one
// `World.exits()` uses to find the square to stand on -- had always read same-axis equalities
// as ALTERNATIVES, with the reason in its comment. So those triggers were being crossed by the
// fleet while three separate renderers printed them as impossibilities, and my checker made it
// four. The defect was in the SENTENCE, not in the world: exactly the mistake this repository
// names as its own axiom -- "'unreachable' is a fact about the file, not about the world" -- and I
// made it about a predicate instead of a jump.
//
// What survives: `values: [...]` is still worth writing, because a shape two readers disagree
// about is a defect even when one of them is right (`ambiguousWhen` reports it). And DEADNESS
// is now measured the only way that cannot disagree with the mover: ask `inRegion` whether any
// square of a room that size satisfies it.
export { describeWhen, deadWhen, ambiguousWhen } from './m59-codeexits.mjs';
// ---------------------------------------------------------------- telemetry

let hopCache = null;
/**
 * Tries, successes and the last failure per `from->to`, aggregated from the hop ledger.
 *
 * A DOOR THAT HAS NEVER BEEN CROSSED IS NOT A DOOR YET, and that is the distinction the
 * geometry alone cannot make. CLAUDE.md's own example: Ukgoth's north door read
 * `refused 182, crossings 0` on a day it was crossing six times out of six — a counter that
 * could not come down. So this reports `tries`, `ok` and `last_failure` and lets the reader
 * judge, rather than computing a verdict nobody can audit.
 */
export function hopStats({ file = join(REPO, 'substrate', 'hoptests.json') } = {}) {
  if (hopCache) return hopCache;
  const runs = readJson(file, { runs: [] })?.runs ?? [];
  const by = new Map();
  for (const r of runs) {
    if (r?.from == null || r?.to == null) continue;
    const key = `${r.from}->${r.to}`;
    const cur = by.get(key) ?? { tries: 0, ok: 0, median_ms: null, last_failure: null, last_at: null };
    cur.tries += Number(r.tries ?? 0);
    cur.ok += Number(r.ok ?? 0);
    if (Number.isFinite(r.median_ms)) cur.median_ms = r.median_ms;
    if (r.at && (!cur.last_at || r.at > cur.last_at)) cur.last_at = r.at;
    const why = r.failures?.[0]?.why;
    if (why) cur.last_failure = String(why).slice(0, 160);
    by.set(key, cur);
  }
  hopCache = by;
  return by;
}

const telemetryFor = (from, to) => hopStats().get(`${from}->${to}`) ?? null;

// ---------------------------------------------------------------- falls

let jumpCache = null;
/**
 * The declared intra-room falls, indexed by room.
 *
 * These are not exits and are deliberately not presented as such. They answer a different
 * question — "can a body standing here reach that door at all" — and the mover's one vertical
 * rule (MAX_STEP_HEIGHT) is why they have to be written down rather than derived.
 */
export function fallsIn(roomNum, { file = join(REPO, 'substrate', 'm59-falljumps.json') } = {}) {
  if (!jumpCache) {
    jumpCache = new Map();
    for (const j of readJson(file, { jumps: [] })?.jumps ?? []) {
      const k = Number(j?.room);
      if (!Number.isFinite(k)) continue;
      if (!jumpCache.has(k)) jumpCache.set(k, []);
      jumpCache.get(k).push(j);
    }
  }
  return jumpCache.get(Number(roomNum)) ?? [];
}

// ---------------------------------------------------------------- out

/**
 * Every way OUT of `roomNum`, from all sources, each saying where it came from.
 *
 * The union that was hand-written at four call sites, written once. `m59-map.mjs`'s router
 * already unions the same three for pathfinding; this exists so a DIAGNOSTIC cannot disagree
 * with the router about what a room is connected to.
 */
export function exitsFor(map, roomNum, { telemetry = true } = {}) {
  const num = Number(roomNum);
  const room = map?.rooms?.[num] ?? map?.rooms?.[String(num)] ?? null;
  const out = [];
  const add = (rec) => {
    out.push({ from: num, ...rec,
               hazard: hazardReason(rec.to) ?? null,
               avoid_in_transit: AVOID_IN_TRANSIT.has(Number(rec.to)),
               telemetry: telemetry ? telemetryFor(num, rec.to) : null });
  };

  // A PARTIAL ROOM IS NOT AN ERROR HERE. `exitsOf` iterates both lists unguarded, so a room
  // object carrying only `edgeExits` -- which is what every synthetic fixture in the offline
  // tests builds, and what a hand-written map has -- threw `room.goExits is not iterable` and
  // took the whole report down. A diagnostic must survive the shapes a debugger hands it.
  for (const e of (room ? exitsOf({ ...room, edgeExits: room.edgeExits ?? [],
                                    goExits: room.goExits ?? [] }) : []))
    add({ to: Number(e.to), kind: isUnresolved(e.to) ? 'unresolved' : 'declared', directed: 'out',
          direction: e.direction ?? e.dir ?? null,
          stand_on: e.stand_on ?? null, arrive: null, trigger: null,
          provenance: { source: 'bake.edgeExits/goExits', cite: null } });

  for (const e of inferredExits(map, num) ?? [])
    add({ to: Number(e.to), kind: 'inferred', directed: 'out',
          direction: e.direction ?? null, stand_on: e.stand_on ?? null,
          arrive: null, trigger: null,
          provenance: { source: 'inferred from the far room declaring an edge in', cite: null } });

  for (const e of codeExits(num) ?? [])
    add({ to: Number(e.to), kind: 'trigger', directed: 'out',
          direction: null, stand_on: null,
          arrive: e.arrive ?? null,
          trigger: describeWhen(e.when) || null,
          // A TRIGGER NO SQUARE OF THIS ROOM CAN SATISFY IS A DEAD CONNECTION, and it looks
          // exactly like a live one to anything that does not check. Measured against the room
          // the trigger is IN -- its condition is about this room's coordinates -- with the
          // mover's own evaluator, so this cannot disagree with what the mover will do.
          unsatisfiable: deadWhen(e.when, { rows: room?.rows ?? 64, cols: room?.cols ?? 64 }),
          // And a shape two readers read differently, which is a defect even though `inRegion`
          // is the one that is right. Six of twenty-four entries; reported, never a refusal.
          ambiguous: ambiguousWhen(e.when),
          trigger_targets: e.trigger_targets ?? null,
          provenance: { source: 'substrate/m59-codeexits.json', cite: e.rid ?? null,
                        // The name a person would use for the room they are standing in. The
                        // file records it; nothing downstream was carrying it.
                        from_name: e.from_name ?? null } });

  return out;
}

/**
 * Every way IN to `roomNum` — THE QUESTION THAT WAS BEING ANSWERED WRONG.
 *
 * `m59-exitreport.mjs` asked it by scanning other rooms' `edgeExits` and `goExits`, which
 * cannot see a trigger, and so printed "NOTHING IN THE WORLD GRAPH ARRIVES HERE" about a room
 * the router was planning fourteen-hop journeys into. There is no cheap index for this — it is a
 * scan of every room's exits — so it is done once, here, where the cost is paid in one place.
 */
export function inboundFor(map, roomNum, { telemetry = true } = {}) {
  const want = Number(roomNum);
  const found = [];
  for (const key of Object.keys(map?.rooms ?? {})) {
    const from = Number(key);
    if (from === want) continue;
    for (const e of exitsFor(map, from, { telemetry })) if (Number(e.to) === want) found.push(e);
  }
  return found;
}

// ---------------------------------------------------------------- both

/**
 * One answer for one room: how you leave, how you arrive, what the falls afford, and what the
 * ledger says about each boundary.
 */
export function unifiedRoom(map, roomNum) {
  const num = Number(roomNum);
  const room = map?.rooms?.[num] ?? map?.rooms?.[String(num)] ?? null;
  const out = exitsFor(map, num);
  const inbound = inboundFor(map, num);
  const falls = fallsIn(num);
  const byKind = (list) => Object.fromEntries(
    KINDS.map(k => [k, list.filter(e => e.kind === k).length]).filter(([, n]) => n));
  return {
    room: num, name: room?.name ?? null,
    out, inbound, falls,
    // The summary a human reads first, and the one that would have prevented tonight: a room
    // with no DECLARED inbound but a trigger inbound is reachable, and saying "nothing arrives
    // here" about it is false.
    summary: {
      out_by_kind: byKind(out),
      inbound_by_kind: byKind(inbound),
      reachable: inbound.length > 0,
      // A trigger-entered room is the case that reads as unreachable to anything looking for a
      // door, so it is called out by name rather than left to be inferred from the counts.
      entered_only_by_trigger: inbound.length > 0 && inbound.every(e => e.kind === 'trigger'),
      leaves_only_by_trigger: out.length > 0 && out.every(e => e.kind === 'trigger'),
      falls_declared: falls.length,
      // The count that matters for trust: a room whose only way in is a DEAD trigger is
      // reachable on paper and unreachable in fact.
      dead_triggers_in: inbound.filter(e => e.unsatisfiable).length,
      dead_triggers_out: out.filter(e => e.unsatisfiable).length,
      // Separately counted, because it is a defect in the DATA rather than in the world: the
      // trigger works and the file says it in a shape half its readers get wrong.
      ambiguous_triggers_in: inbound.filter(e => e.ambiguous).length,
      ambiguous_triggers_out: out.filter(e => e.ambiguous).length,
      hazard: hazardReason(num) ?? null,
      avoid_in_transit: AVOID_IN_TRANSIT.has(num),
    },
  };
}

/**
 * Is there any way in at all, and if not, what was consulted?
 *
 * fleetScript's enforcement point. The value is the NAMED SOURCES: "no inbound" is only useful
 * if it says what it looked at, because the answer has been wrong twice by looking at less than
 * everything.
 */
export function inboundVerdict(map, roomNum) {
  const num = Number(roomNum);
  if (!(map?.rooms?.[num] ?? map?.rooms?.[String(num)]))
    return { ok: false, code: 'no_such_room', why: `room ${num} is not in the baked map.`,
             consulted: [] };
  const inbound = inboundFor(map, num, { telemetry: false });
  const consulted = ['bake.edgeExits/goExits', 'inferred', 'substrate/m59-codeexits.json'];
  if (!inbound.length) {
    // WHERE TO LOOK, NOT JUST WHAT IS MISSING. A door is two-sided, so if this room's only way
    // OUT is into room Y, the way IN is a door in Y -- and Y usually has doors the bake could
    // not resolve. Naming them turns "write a trigger" (which may be wrong) into "resolve one of
    // these 15 doors" (which is where the answer actually is).
    const neighbours = [...new Set(exitsFor(map, num, { telemetry: false })
      .map(e => Number(e.to)).filter(t => !isUnresolved(t)))];
    const unresolvedNear = neighbours
      .map(t => ({ room: t, name: map.rooms[t]?.name ?? map.rooms[String(t)]?.name ?? null,
                   doors: exitsFor(map, t, { telemetry: false })
                     .filter(e => e.kind === 'unresolved').length }))
      .filter(x => x.doors > 0);
    const hint = unresolvedNear.length
      ? ` This room LEAVES into ${unresolvedNear.map(x => `${x.room} (${x.name})`).join(', ')}, ` +
        `and ${unresolvedNear.length === 1 ? 'that room has' : 'those rooms have'} ` +
        `${unresolvedNear.reduce((n, x) => n + x.doors, 0)} door(s) the bake could not resolve ` +
        `(\`to: -1\`). A door is two-sided, so the way in is very likely one of THOSE rather ` +
        `than an undeclared trigger — resolve them and this room stops being an orphan.`
      : ` If the game has a way in, it is a trigger nobody has declared: add it to ` +
        `m59-codeexits.json.`;
    return { ok: false, code: 'nothing_arrives', consulted,
             ...(unresolvedNear.length ? { unresolved_doors_next_door: unresolvedNear } : {}),
             why: `nothing in the unified exit view arrives at room ${num}. All of ` +
                  `${consulted.join(', ')} were consulted, so this is not one tool's blind ` +
                  `spot — it is a room with no recorded way in.${hint}` };
  }
  // A DEAD TRIGGER IS REACHABLE ON PAPER AND UNREACHABLE IN FACT, and this is the one place
  // that can tell the difference. If every way in is a predicate nothing can satisfy, the
  // honest answer is 'no way in' -- and the refusal names the file and the entry, because the
  // remedy is a data fix rather than a route.
  const live = inbound.filter(e => !e.unsatisfiable);
  if (!live.length)
    return { ok: false, code: 'only_dead_triggers', consulted,
             dead: inbound.map(e => ({ from: e.from, cite: e.provenance?.cite ?? null,
                                       why: e.unsatisfiable })),
             why: `every recorded way into room ${num} is a trigger whose predicate cannot be ` +
                  `satisfied, so nothing can arrive: ` +
                  `${inbound.map(e => `${e.from} -> ${num} (${e.unsatisfiable})`).join('; ')}. ` +
                  `This is a data defect in substrate/m59-codeexits.json, not a missing route.` };
  return { ok: true, code: 'reachable', consulted,
           kinds: [...new Set(live.map(e => e.kind))], count: live.length,
           // Named even on the OK path: a room reachable only because ONE of its two triggers
           // is alive is one bad regeneration away from being sealed.
           ...(live.length < inbound.length
             ? { dead_triggers: inbound.length - live.length } : {}) };
}

/**
 * MAY A JOURNEY TO THIS ROOM BE STARTED AT ALL? The one decision, for every caller.
 *
 * `m59-travelgate.mjs` is the same idea for the BODY -- is it well enough to set out -- and this
 * is the idea for the DESTINATION. Both exist for the reason the operator gave: "the way an LLM
 * responds to 'send Statler to Marion' needs to be fundamentally the same as the way the
 * localhost:3000 field command sends units to Marion". A gate that only fleetScript consults is a
 * gate a bot walks straight past, and a journey no script would have permitted then starts
 * anyway.
 *
 * Returns `{ ok: true }`, `{ ok: true, note }` when the way in is unusual enough to say out
 * loud, or `{ ok: false, code, why }`. A WAIVER IS ALWAYS AVAILABLE and needs a reason, because
 * the errand that finds the missing trigger has to be able to aim at the room nothing arrives
 * at -- refusing that would make this gate the thing that stops the world model improving.
 */
export function mayArrive(map, roomNum, { waiver = null } = {}) {
  const num = Number(roomNum);
  const reason = typeof waiver === 'string' ? waiver : (waiver?.reason ?? null);
  const verdict = inboundVerdict(map, num);
  if (!verdict.ok) {
    if (reason) return { ok: true, waived: reason, code: verdict.code, note:
      `room ${num}: ${verdict.why} GOING ANYWAY, because: ${reason}` };
    return { ok: false, code: verdict.code,
             why: `${verdict.why} A caller that means to go anyway -- to find the missing ` +
                  `trigger, or because a body is already there -- must say so with a reason.` };
  }
  // Reachable, but say HOW when the answer is unusual: eight rooms are entered ONLY by a kod
  // trigger, and a reader watching a walk that never aims at a door needs to know that is
  // correct rather than a mover fault.
  const u = unifiedRoom(map, num);
  if (u.summary.entered_only_by_trigger)
    return { ok: true, code: 'trigger_only', note:
      `room ${num} is entered ONLY by a kod trigger (${verdict.count} of them) -- there is no ` +
      `door, and the mover has to stand on the square that moves it. At a trigger, arriving at ` +
      `the boundary is the FAILURE and being moved across is the success.` };
  if (verdict.dead_triggers)
    return { ok: true, code: 'partly_dead', note:
      `room ${num} is reachable, but ${verdict.dead_triggers} of its inbound triggers carry an ` +
      `unsatisfiable predicate -- it is one regeneration of substrate/m59-codeexits.json away ` +
      `from being sealed.` };
  return { ok: true, code: verdict.code };
}
// ---------------------------------------------------------------- CLI

const IS_ENTRY = !!process.argv[1] &&
  join(process.argv[1]) === join(fileURLToPath(import.meta.url));

if (IS_ENTRY) {
  const argv = process.argv.slice(2);

  // THE WORK LIST: every room no route can end at, and what leaves it.
  //
  // A room a person can LEAVE is a room a person got into, so a leavable room with nothing
  // arriving is not a fact about the world — it is a missing affordance, and this is the list of
  // them. Printed as a list rather than a count because a count is the kind of finding that
  // sits in a commit message and dies there; the standing rule is to name the missing
  // affordance or name the tool that would find it, and this is that tool.
  if (argv.includes('--orphans')) {
    const map = loadMap(movementMapFile());
    const rows = [];
    for (const key of Object.keys(map.rooms)) {
      const n = Number(key);
      const v = inboundVerdict(map, n);
      if (v.ok) continue;
      const out = exitsFor(map, n, { telemetry: false });
      rows.push({ room: n, name: map.rooms[key]?.name ?? null, code: v.code,
                  leaves: out.filter(e => e.kind !== 'unresolved')
                            .map(e => `${e.kind[0]}->${e.to}`),
                  near: v.unresolved_doors_next_door ?? [] });
    }
    // Leavable first: those are the ones with evidence that a way in exists.
    rows.sort((a, b) => b.leaves.length - a.leaves.length || a.room - b.room);
    if (argv.includes('--json')) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }
    console.log('');
    console.log(`${rows.length} of ${Object.keys(map.rooms).length} rooms: NOTHING ARRIVES, in any ` +
                `of the five sources. No route the mover could take ends in one of these.`);
    console.log('');
    const leavable = rows.filter(r => r.leaves.length);
    console.log(`  ${leavable.length} of them HAVE A WAY OUT — so a person got in, and there is`);
    console.log(`  an affordance nobody has written down. Where to look is on the right:`);
    for (const r of leavable)
      console.log(`    ${String(r.room).padStart(5)}  ${String(r.name).slice(0, 32).padEnd(33)}` +
                  `leaves by ${r.leaves.join(', ')}` +
                  `${r.near.length ? `   <- look in ${r.near.map(x => `${x.room} (${x.doors} ` +
                    `unresolved door(s))`).join(', ')}` : ''}`);
    const sealed = rows.filter(r => !r.leaves.length);
    if (sealed.length) {
      console.log('');
      console.log(`  ${sealed.length} with no way out either — a room the bake knows the shape of`);
      console.log(`  and nothing else. Not evidence of anything until somebody stands in one:`);
      console.log('    ' + sealed.map(r => r.room).join(', '));
    }
    console.log('');
    const doors = rows.reduce((n, r) => n + r.near.reduce((m, x) => m + x.doors, 0), 0);
    if (doors) {
      let holders = 0, total = 0;
      for (const key of Object.keys(map.rooms)) {
        const u = exitsFor(map, Number(key), { telemetry: false })
          .filter(e => e.kind === 'unresolved').length;
        if (u) { holders++; total += u; }
      }
      console.log('');
      console.log(`  MOST OF THIS IS ONE BUG, NOT ${leavable.length}. The bake writes a door it`);
      console.log('  could not resolve as `to: -1, locked: true`, and a door is two-sided — so');
      console.log('  the way into these rooms is very likely one of those doors rather than an');
      console.log(`  undeclared trigger. Map-wide there are ${total} of them, in ${holders} rooms.`);
    }
    console.log('');    console.log('  See docs/m59-routing.md. fleetScript and the broker both REFUSE a journey to');
    console.log('  any of these, waivable with a reason — that waiver is how you go and look.');
    process.exit(0);
  }

  const num = Number(argv.find(a => /^\d+$/.test(a)));
  if (!Number.isFinite(num)) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8')
      .split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(argv.length ? 1 : 0);
  }
  const map = loadMap(movementMapFile());
  const u = unifiedRoom(map, num);
  if (argv.includes('--json')) { console.log(JSON.stringify(u, null, 2)); process.exit(0); }

  const line = (e) => `    ${String(e.kind).padEnd(9)} ${String(e.from).padStart(4)} -> ` +
    `${String(e.to).padEnd(5)} ${(e.direction ?? '').padEnd(6)} ` +
    (e.trigger ? `[${e.trigger}] ` : '') +
    (e.telemetry ? `(${e.telemetry.ok}/${e.telemetry.tries} crossed)` : '(never measured)') +
    (e.hazard ? '  HAZARD' : '') + (e.avoid_in_transit ? '  avoid-in-transit' : '') +
    (e.unsatisfiable ? '  DEAD TRIGGER' : '') + (e.ambiguous ? '  AMBIGUOUS SHAPE' : '');

  console.log(`\nroom ${u.room} — ${u.name ?? '(unnamed)'}`);
  console.log(`\n  OUT (${u.out.length})`);
  for (const e of u.out) console.log(line(e));
  console.log(`\n  IN (${u.inbound.length})`);
  if (!u.inbound.length) console.log('    nothing in the unified view arrives here');
  for (const e of u.inbound) console.log(line(e));
  if (u.falls.length) {
    console.log(`\n  DECLARED FALLS INSIDE THIS ROOM (${u.falls.length}) — affordances, not exits`);
    for (const f of u.falls)
      console.log(`    r${f.from?.row}c${f.from?.col} -> r${f.to?.row}c${f.to?.col}` +
                  (f.requires?.running ? '  (running)' : ''));
  }
  console.log('');
  if (u.summary.entered_only_by_trigger)
    console.log('  NOTE: this room is entered ONLY by a trigger. Anything looking for a door ' +
                'will report it unreachable, and be wrong.');
  if (u.summary.hazard) console.log(`  HAZARD: ${u.summary.hazard}`);
  console.log('');
}
