#!/usr/bin/env node
// EVERY MANA NODE THE GAME PLACES, READ OUT OF THE KOD — and what this repository's own lists
// are missing. Offline: no broker, no server, no roster.
//
//   node tools/m59-stones.mjs                 every stone, joined to the bake
//   node tools/m59-stones.mjs --diff          what each hand-written list is missing
//   node tools/m59-stones.mjs --check         exit 1 when a list has drifted (for CI)
//   node tools/m59-stones.mjs --json
//
// WHY THIS EXISTS. "There are seven mana nodes" is written in the node-runner skill. The
// authority is a bitmask enumeration in `kod/include/blakston.khd`, and it declares THIRTEEN:
// every node is one bit of the player's `piNodelist`, which `ComputeMaxMana` sums on login. So
// the count was never a matter of opinion — nobody had read the enum.
//
// The two tables in this repository that enumerate the stones had 6 and 7, disagreed with each
// other in BOTH directions, and used different keys for room 515 (`peak` against `seafarer`) so
// that `nodes/<key>.md` could never be found from both sides. Neither was checkable.
//
// WHAT A GREP FOR `Create(&ManaNode` STILL MISSES, and this is the reason the census is built
// from the ENUM and not from the placements:
//
//   * SUBCLASSES. `FeyNode` and `AvarNode` are both `is ManaNode`, and the Fey stone in the
//     Vale of Sorrows is `Create(&FeyNode, ...)`. The class list is read out of the kod, so a
//     new subclass appears here without anybody editing this file.
//   * DEFERRED PLACEMENT. Five stones are created with no position at all and placed later by
//     the room, which is where the interesting half of the answer lives:
//       - NODE_I9   (599, Ukgoth) appears at r27c61 only while the game hour is 0.
//       - NODE_Q    (47, Martyr's Battleground) at r57c45, only after ActivatePortal() runs.
//       - NODE_FAERIE (532, The Vale of Sorrows) at r23c30, when the room's karma reaches
//         KVERY_GOOD or KVERY_EVIL — a faction outcome, not a walk.
//       - NODE_AVAR (2154, Avar Village) at r34c52 when the node value swings past 2000, and
//         it DISAPPEARS again on a 60s timer.
//       - NODE_CORPSENODE (1, The Underworld) at r16c16.
//
// WHICH ONES ARE NOT ERRANDS. Three, and two of them are the operator's own ruling:
//
//   * NODE_GUEST — "The 'Hazar' mana node is unreachable for normal players, by the way, it's
//     meant to demo the mana node existence for guest players." (operator, 2026-09-10). The kod
//     says the same thing in a comment on the enum line: "Guest node is normally not attainable
//     except by guests." Its absent route IS the design.
//   * NODE_I9 and NODE_FAERIE — "The Ukgoth nodes and Fey nodes should also be exempt from
//     attempt, because they're not casually obtainable (usually take planning or coordination
//     across multiple people)" (operator, 2026-09-10). The measurements agree: one exists for
//     one hour of the game day and the other is the prize for a faction war.
//
// NODE_Q and NODE_AVAR are the same SHAPE — a lever and a timed faction swing — and are marked
// `conditional` rather than exempt, because the operator named two and extending a ruling is
// not this file's job. Neither is a walk-and-stand errand and the runner will not attempt one.
//
// Room 599 is in `KNOWN_TRAPS`. It is the gutter every Castle Victoria run crosses and it
// killed two characters on 2026-09-10, and it has a stone in it that nothing here knew about.
//
// (I first read `canyon2.kod` as Kardde's Canyon — room 49, the room that burned a session on
// eleven refused departures — because the file name says canyon and the coincidence was neat.
// It is room 47, and 47 is not adjacent to 49. Checking the .roo join instead of the name is
// the only reason that did not ship as a finding.)
//// THE JOIN IS THE .roo FILE, NOT THE NAME. `i9.kod` declares `room_i9 = i9.roo`, and the bake
// carries `rooFile` per room, so the two sides join exactly. Matching on the room NAME would
// have been a guess: two rooms are called "The Badlands" and only one has the stone, and
// `canyon2.kod` is called "Martyr's Battleground" — I read it as Kardde's Canyon at first
// glance, which would have filed a real finding against the wrong room.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMap, movementMapFile } from './m59-map.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

export const KOD_ROOT = process.env.M59_ROOT
  ? join(process.env.M59_ROOT, 'kod')
  : 'C:/code/Meridian59/kod';

// ---------------------------------------------------------------- the ten, as one tracked table
//
// THE SINGLE SOURCE, AND IT LIVES HERE BECAUSE HERE IS TRACKED. The errand's own copy is in
// `tools/fleetscripts/mana-node.mjs`, which is UNTRACKED on this machine — so a clone has the
// critic reading a file it does not have, and `m59-node-run.mjs` could not be pointed at it
// without breaking in production. `stones()` below derives the same set from the kod and
// `drift()` checks this table against it, so the hand-written list cannot rot silently again.
//
// `alias` exists because room 515 was `peak` to one list and `seafarer` to the other, which
// meant `nodes/<key>.md` could never be found by both and the critic reported a missing dossier
// for a stone whose dossier was sitting there under the other name. Old names keep working.
export const STONES = Object.freeze({
  // ---- the seven that are ordinary errands: walk there, stand in the 5x5 box, activate
  cave:     { room: 27,   node: 'NODE_ORCCAVES', row: 23, col: 53,
              where: 'A Deep, Dark, Spooky, Icky Cave' },
  victoria: { room: 39,   node: 'NODE_VICTORIA', row: 13, col: 46,
              where: 'Upstairs in Castle Victoria' },
  badlands: { room: 45,   node: 'NODE_BADLANDS', row: 63, col: 46, where: 'The Badlands' },
  peak:     { room: 515,  node: 'NODE_A5',       row: 20, col: 17,
              where: "Seafarer's Peak", alias: ['seafarer'] },
  ancient:  { room: 579,  node: 'NODE_G9',       row: 52, col: 30,
              where: 'An ancient place, its origin forgotten' },
  sentinel: { room: 589,  node: 'NODE_H9',       row: 45, col: 32,
              where: 'Under the shadow of the Sentinel' },
  // THE MELD IS BEHIND A YETI AND A TWO-SECOND CEILING. Operator, 2026-09-10: "the Dreaded
  // Caves of Ice node requires killing the Yeti to get access... the goal should actually just
  // be to walk to within a few coarse squares away from the mana node (in the dreaded caves
  // this means the biggest room)." The kod is more specific than that and worse:
  //
  //   SomethingKilled: if IsClass(victim,&yeti) -> setsector MANA_DOOR ANIMATE_CEILING_LIFT
  //                                               height=510, then LowerManaDoorTimer at 2000ms
  //
  // So a yeti kill lifts a ceiling sector for TWO SECONDS — and not at all if the node's own
  // attack made the kill (icecave1.kod SomethingKilled). That is a kill and a two-second
  // window, not a walk, so the errand here is the APPROACH and the meld is a separate question
  // for somebody who means to fight for it.
  ice:      { room: 750,  node: 'NODE_ICECAVE1', row: 25, col: 23,
              where: 'The Dreaded Caves of Ice',
              objective: 'approach', approach_within: 5,
              gate: 'killing a yeti lifts the MANA_DOOR ceiling sector for 2s ' +
                    '(icecave1.kod), and not at all if a node attack made the kill',
              note: 'the approach target is the big chamber — the room bakes as one region ' +
                    'holding 2114 of its 2115 walkable squares' },

  // ---- the Underworld's own, which every character visits by dying
  corpse:   { room: 1,    node: 'NODE_CORPSENODE', row: 16, col: 16, where: 'The Underworld',
              appears: 'placed by uworld.kod maintenance; a CorpseNode rather than a stone on ' +
                       'a hill' },

  // ---- CONDITIONAL: there is nothing to stand on until something else happens
  martyr:   { room: 47,   node: 'NODE_Q',        row: 57, col: 45,
              where: "Martyr's Battleground", conditional: true,
              appears: 'only after canyon2.kod ActivatePortal() has run — a lever, not a walk',
              note: 'the room is unrouted too: its only inbound is room 32 and the bake has no ' +
                    'route to either from town' },
  avar:     { room: 2154, node: 'NODE_AVAR',     row: 34, col: 52, where: 'Avar Village',
              conditional: true,
              appears: 'only while the village node value has swung past 2000 (ke4.kod), and it ' +
                       'disappears again on a 60-second timer' },

  // ---- EXEMPT FROM ATTEMPT. Two by the operator's ruling, one by the design of the game.
  // Operator, 2026-09-10: "The Ukgoth nodes and Fey nodes should also be exempt from attempt,
  // because they're not casually obtainable (usually take planning or coordination across
  // multiple people)."
  // A KEY, A PASSWORD, A TEN-SECOND FLOOR AND A CLOCK. Operator, 2026-09-10: "Ukgoth requires
  // a 'Relic of Qor' to get it, let's make it 'skip' when we run the node run unless the runner
  // has the item. If the runner does have the relic they should go at that time and say the
  // words to open the door." The kod says exactly how (i9.kod SomeoneSaid):
  //
  //   i9_qor = "Qor the Vile"                  the words, matched with StringEqual
  //   for each object in the SPEAKER's pack:      the key must be carried, not in the room
  //     if IsClass(each_obj,&Scepter)             `relic of Qor` (scepter.kod:19)
  //        SetSector SECTOR_DOOR ANIMATE_FLOOR_LIFT height=340 speed=16
  //        CreateTimer(DoorCloseTimer, DOORWAY_DELAY)   10 seconds, then back to 440
  //        Send(each_obj,@Delete)                 THE RELIC IS CONSUMED
  //
  // The relic's own inscription is the errand: "The true servant shall bring this to the barren
  // place and speak my name." (scepter.kod). One relic opens the floor once, for ten seconds,
  // and only for whoever is holding it — so a run that sets out without one cannot arrive, and
  // a run that sets out with one and mistimes the hour has spent it.
  ukgoth:   { room: 599,  node: 'NODE_I9',       row: 27, col: 61,
              where: 'Ukgoth, Holy Land of Trolls',
              requires: { item: 'relic of Qor', kod_class: 'Scepter', consumed: true },
              say: 'Qor the Vile', door_open_ms: 10_000,
              appears: 'only while the game hour is 0 (i9.kod RecalcLightAndWeather) — the room ' +
                       'deletes it for the rest of the day' },
  // AN APPROACH RATHER THAN AN ATTEMPT, on the same ruling as the ice cave: the stone is the
  // prize for a faction war and is not there to be walked up to, but the WALK is still a walk.
  fey:      { room: 532,  node: 'NODE_FAERIE',   row: 23, col: 30,
              where: 'The Vale of Sorrows',
              objective: 'approach', approach_within: 5,
              gate: "the room's karma has to reach KVERY_GOOD or KVERY_EVIL before the stone " +
                    'appears at all (c2.kod AppearNode) — planning or coordination across ' +
                    'several people, not an errand',
              appears: "only when the room's karma reaches KVERY_GOOD or KVERY_EVIL — the " +
                       'prize for a faction war (c2.kod AppearNode), and a FeyNode rather than ' +
                       'a plain ManaNode' },

  // And the one the game itself calls unattainable, on the enum line in blakston.khd.
  mausoleum:{ room: 1006, node: 'NODE_GUEST',    row: 35, col:  5, where: 'Mausoleum',
              rooms: [1006, 1016], guest_demo: true, never: 'by design — operator, 2026-09-10',
              appears: 'for GUEST players, as a demonstration — unreachable by design' },
});

/**
 * MAY ANYTHING BE SENT TO THIS STONE, AND WHAT WOULD SUCCESS BE?
 *
 * Three answers, not two, because "do not try to meld it" and "do not go there" are different
 * instructions and collapsing them cost the Ice Caves a run: the stone was on nobody's list at
 * all, when the useful errand was always to walk to it and stop.
 *
 *   'meld'      walk, stand in the 5x5 box, activate, and prove MAX MANA rose
 *   'approach'  walk to within `approach_within` coarse squares and stop. The meld is behind
 *               something that is not a walk — a yeti and a two-second ceiling, a faction war
 *   null        do not send anybody: exempt by the operator's ruling, conditional on a lever
 *               or a clock, or unreachable by the design of the game
 */
export function objectiveFor(s) {
  if (!s || s.never || s.exempt || s.conditional) return null;
  return s.objective === 'approach' ? 'approach' : 'meld';
}

/**
 * WHAT THIS STONE NEEDS CARRIED, or null. A key is not an exemption: the errand is real and it
 * is conditional on the pack, which is a question only a live character can answer.
 *
 * Ukgoth's relic is CONSUMED by the door, so the difference between "skip" and "try" here is the
 * difference between keeping a one-use key and burning it on a walk that was never going to
 * arrive.
 */
export const requiredItem = (s) => s?.requires?.item ?? null;

/** Does this pack hold the key? `items` is whatever the inventory tool returned. */
export function holdsRequired(s, items) {
  const want = requiredItem(s);
  if (!want) return true;
  const names = (Array.isArray(items) ? items : [])
    .map(i => String(i?.name ?? i?.item ?? i ?? '').toLowerCase());
  // MATCHED ON THE GAME'S OWN NAME, loosely on case and on the article. The kod tests the
  // CLASS (&Scepter) and we cannot see a class over the wire, so the name is the best
  // available proxy — and it is worth saying that out loud rather than implying the check is
  // as strong as the server's.
  const w = want.toLowerCase();
  return names.some(n => n === w || n.includes(w) || n.includes('relic of qor'));
}

/** Is this a stone anything should be SENT to? */
export const attemptable = (s) => objectiveFor(s) !== null;

/** How close counts, in coarse squares. The meld box is +/-2; an approach is looser. */
export const approachWithin = (s) => Number(s?.approach_within ?? 2);
/** A stone by key or by any name a previous list used for it. */
export function stoneKeyed(name) {
  const k = String(name ?? '').toLowerCase();
  if (STONES[k]) return { key: k, ...STONES[k] };
  for (const [key, s] of Object.entries(STONES))
    if ((s.alias ?? []).includes(k)) return { key, ...s };
  return null;
}

// ---------------------------------------------------------------- the kod side

function kodFiles(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) kodFiles(p, out);
    else if (e.endsWith('.kod')) out.push(p);
  }
  return out;
}

/**
 * THE AUTHORITY ON WHICH NODES EXIST: the bitmask in kod/include/blakston.khd.
 *
 * Every node is one bit of the player's `piNodelist`, and `ComputeMaxMana` sums them on login.
 * So "how many nodes are there" has a definitive answer in the source and never needed to be
 * maintained by hand in this repository at all.
 */
export function nodeEnum({ kodRoot = KOD_ROOT } = {}) {
  const khd = readFileSync(join(kodRoot, 'include', 'blakston.khd'), 'utf8');
  const out = [];
  for (const m of khd.matchAll(/^\s*(NODE_[A-Za-z0-9_]+)\s*=\s*(0x[0-9a-fA-F]+|\d+)/gm)) {
    if (/^NODE_MAX_VALUE$/.test(m[1])) continue;
    // The kod comments its own exceptions on the enum line above the entry, and one of them is
    // the guest node. Carried through, because a ruling written in the source outranks any
    // table here.
    const before = khd.slice(Math.max(0, m.index - 200), m.index).split('\n').filter(Boolean);
    const note = (before[before.length - 1] ?? '').trim();
    out.push({ node: m[1], bit: Number(m[2]),
               kod_note: note.startsWith('%') ? note.replace(/^%+\s*/, '') : null });
  }
  return out;
}

/**
 * Every class a stone can be created as — `ManaNode` and everything declared `is ManaNode`.
 *
 * Read rather than listed, because the two subclasses that exist (`FeyNode`, `AvarNode`) are
 * exactly what a grep for `Create(&ManaNode` cannot see, and the next one would be too.
 */
export function nodeClasses({ kodRoot = KOD_ROOT } = {}) {
  const classes = new Set(['ManaNode']);
  for (const f of kodFiles(kodRoot)) {
    const src = readFileSync(f, 'utf8');
    const decl = src.match(/^([A-Za-z][A-Za-z0-9_]*) is ([A-Za-z][A-Za-z0-9_]*)\b/m);
    if (!decl) continue;
    // A SUBCLASS OF ManaNode, or ANYTHING THAT CARRIES A NODE NUMBER. The second half is not
    // tidiness: `CorpseNode` is `is Portal` and sets `piNode_num = NODE_CORPSENODE`, so it
    // occupies a bit of piNodelist while not being a ManaNode at all. A class list built only
    // from the hierarchy reported NODE_CORPSENODE as declared-but-unplaced, which is a true
    // sentence about the parse and a false one about the game.
    if (decl[2] === 'ManaNode' || /piNode_num\s*=\s*NODE_[A-Za-z0-9_]+/.test(src))
      classes.add(decl[1]);
  }
  return [...classes];
}

/** The room's own .roo, which is the only exact key between a kod file and the bake. */
const rooOf = (src) => (src.match(/room_[A-Za-z0-9_]+\s*=\s*([A-Za-z0-9_]+\.roo)/) ?? [])[1] ?? null;
const nameOf = (src) => (src.match(/room_name_[A-Za-z0-9_]+\s*=\s*"([^"]*)"/) ?? [])[1] ?? null;

/** The method a source offset sits inside — kod methods are `Name(args)` at 3-space indent. */
function methodAt(src, index) {
  const before = src.slice(0, index);
  const ms = [...before.matchAll(/^ {3}([A-Za-z][A-Za-z0-9_]*)\s*\(/gm)];
  return ms.length ? ms[ms.length - 1][1] : null;
}

/**
 * Every stone one kod file places, with where it stands and what has to happen first.
 *
 * Two placement shapes, and the second is the one both hand-written lists missed:
 *   static   — `Send(self,@NewHold,#what=Create(&ManaNode,#node_num=X), #new_row=.., #new_col=..)`
 *   deferred — `Create(&ManaNode,#node_num=X,#iRoomNum=piRoom_num)` and then, elsewhere in the
 *              same class, `Send(poNode,@NodeAppear,#where=self,#row=..,#col=..)`
 */
export function stonesInSource(src, opts = {}) {
  const { file = null } = opts;
  const out = [];
  const classes = (opts.classes ?? ['ManaNode']).join('|');
  const re = new RegExp(`Create\\(&(${classes})\\s*,([\\s\\S]{0,240}?)\\)`, 'g');
  for (const m of src.matchAll(re)) {
    const cls = m[1];
    const args = m[2];
    const num = (args.match(/#node_num\s*=\s*([A-Za-z0-9_]+)/) ?? [])[1] ?? null;
    if (!num) continue;
    // The whole statement, so a position on the continuation line is still in scope.
    const stmtEnd = src.indexOf(';', m.index);
    const stmt = src.slice(m.index, stmtEnd < 0 ? m.index + 400 : stmtEnd);
    const row = Number((stmt.match(/#new_row\s*=\s*(\d+)/) ?? [])[1]);
    const col = Number((stmt.match(/#new_col\s*=\s*(\d+)/) ?? [])[1]);
    const rec = { node: num, cls, file: file ? basename(file) : null,
                  roo: rooOf(src), room_name: nameOf(src) };
    if (Number.isFinite(row) && Number.isFinite(col)) {
      out.push({ ...rec, row, col, placement: 'static', when: null, when_method: null });
      continue;
    }
    // DEFERRED. Find the appearance, and say what gates it — a stone that only exists at
    // midnight is not the same errand as a stone that is always there, and a list that cannot
    // express the difference will send somebody to stand on nothing.
    const app = [...src.matchAll(/@NodeAppear\s*,([\s\S]{0,200}?)\)/g)]
      .find(a => {
        const near = src.slice(Math.max(0, a.index - 300), a.index);
        return new RegExp(num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(near);
      });
    if (!app) { out.push({ ...rec, row: null, col: null, placement: 'deferred', when: null,
                           when_method: null }); continue; }
    const arow = Number((app[1].match(/#row\s*=\s*(\d+)/) ?? [])[1]);
    const acol = Number((app[1].match(/#col\s*=\s*(\d+)/) ?? [])[1]);
    const method = methodAt(src, app.index);
    // The nearest guard above the appearance, which is as much of the condition as a regex can
    // honestly claim. It is a POINTER INTO THE KOD, not a predicate anybody should evaluate.
    //
    // AND THE "ALREADY EXISTS, RETURN" GUARD IS NOT THE CONDITION. Both deferred stones open
    // their method with `if poNode <> $ { return; }`, so the nearest guard above the appearance
    // is the one case in which it does NOT appear. Reporting that as the condition printed the
    // exact inverse of the truth for NODE_Q. Guards that only test the node's own existence are
    // skipped, and when nothing else remains the METHOD is the honest answer: `ActivatePortal`
    // says a lever, and no regex is going to do better than the method name there.
    const guards = [...src.slice(Math.max(0, app.index - 400), app.index)
      .matchAll(/\n\s*if ([^\n{]{1,120})/g)].map(g => g[1].trim());
    const guard = guards.filter(g => !/^poNode\s*<>\s*\$$/.test(g) &&
                                     !/^oNode\s*<>\s*\$$/.test(g)).pop() ?? null;
    out.push({ ...rec, row: Number.isFinite(arow) ? arow : null,
               col: Number.isFinite(acol) ? acol : null,
               placement: 'deferred', when: guard, when_method: method });
  }
  return out;
}

/** Every stone in the kod tree, joined to the baked map by .roo file. */
export function stones({ kodRoot = KOD_ROOT, map = null } = {}) {
  const m = map ?? loadMap(movementMapFile());
  // A .roo MAY BE BAKED AS SEVERAL ROOMS, and this used to be a Map to ONE — so the last room
  // in the file quietly won. `guest6.roo` is baked as both 1006 and 1016 (the Mausoleum is
  // instanced), which made the diff report room 1016 as missing from both lists and room 1006
  // as a room the kod places no stone in. Both sentences were artefacts of my own join keeping
  // one arbitrary side of an ambiguity: exactly the failure this tool was written to catch,
  // committed by the tool. An ambiguity is REPORTED, never resolved by insertion order.
  const byRoo = new Map();
  for (const [num, r] of Object.entries(m.rooms ?? {}))
    if (r?.rooFile) {
      const k = String(r.rooFile).toLowerCase();
      if (!byRoo.has(k)) byRoo.set(k, []);
      byRoo.get(k).push(Number(num));
    }

  const found = [];
  const classes = nodeClasses({ kodRoot });
  for (const f of kodFiles(kodRoot))
    for (const s of stonesInSource(readFileSync(f, 'utf8'), { file: f, classes })) {
      const rooms = (s.roo ? byRoo.get(s.roo.toLowerCase()) : null) ?? [];
      const room = rooms.length ? rooms[0] : null;
      found.push({ ...s, room, rooms,
                   // A stone in a room the bake does not carry is a REAL stone and an absent
                   // room, which is a different problem from a missing stone. Said, not dropped.
                   in_the_bake: room != null,
                   instanced: rooms.length > 1,
                   bake_name: room != null ? m.rooms[room]?.name ?? null : null });
    }
  return found.sort((a, b) => (a.room ?? 1e9) - (b.room ?? 1e9));
}

// ---------------------------------------------------------------- this repository's own lists

/** `export const NODES = Object.freeze({...})` out of the fleetscript, without importing it. */
export function nodesFromFleetscript(src) {
  const m = String(src).match(/export const NODES = Object\.freeze\((\{[\s\S]*?\n\s*\})\);/);
  if (!m) return {};
  try { return Function(`"use strict"; return (${m[1]});`)(); } catch { return {}; }
}

/** `const NODES = [ { key, room, ... }, ... ]` out of the runner, by its key/room pairs only. */
export function nodesFromRunner(src) {
  const out = {};
  const block = String(src).match(/const NODES = \[([\s\S]*?)\n\];/);
  if (!block) return out;
  for (const m of block[1].matchAll(/\{\s*key:\s*'([a-z0-9_]+)',\s*room:\s*(\d+)/g))
    out[m[1]] = { room: Number(m[2]) };
  return out;
}

const readIf = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

/**
 * What each list is missing, and where two lists name one stone differently.
 *
 * The key collision is reported as loudly as a missing entry, because its symptom is worse: a
 * dossier that exists under one name and is reported absent under the other reads as work
 * nobody has done.
 */
export function drift({ kodRoot = KOD_ROOT, map = null } = {}) {
  const truth = stones({ kodRoot, map });
  // Keyed by every room an instanced stone lives in, so naming EITHER instance counts as
  // having it — a list that says 1006 and a list that says 1016 are both right about the
  // Mausoleum, and calling one of them wrong would be this tool inventing a defect.
  const byRoom = new Map();
  for (const s of truth) for (const r of (s.rooms?.length ? s.rooms : [s.room]))
    if (r != null) byRoom.set(r, s);
  const stoneKey = (s) => s.node;
  const stonesByRoom = (rooms) => new Set([...rooms.keys()]
    .map(r => byRoom.get(r)).filter(Boolean).map(stoneKey));

  const errandSrc = readIf(join(HERE, 'fleetscripts', 'mana-node.mjs'));
  const runnerSrc = readIf(join(HERE, 'm59-node-run.mjs'));
  // A CONSUMER THAT IMPORTS THE TABLE HAS NO LIST TO DIFF, AND THAT IS THE GOAL STATE.
  // The first version reported the runner as `has 0 — MISSING every room` the moment it was
  // fixed to read STONES, which is the differ punishing the repair it exists to prompt.
  const reads = (src) => /from '\.\/m59-stones\.mjs'/.test(src) ||
                         /from '\.\.\/m59-stones\.mjs'/.test(src);
  const errand = nodesFromFleetscript(errandSrc);
  const runner = nodesFromRunner(runnerSrc);
  // And THIS file's table, which is the one everything else should be reading. Checked against
  // the kod like the others: a source of truth nobody verifies is just a fourth opinion.
  const tracked = Object.fromEntries(Object.entries(STONES).map(([k, v]) => [k, { room: v.room }]));
  // AND AGAINST THE ENUM, which is the only authority on how many stones exist. A node number
  // with no placement my parse can find is reported as its own thing: not a missing stone and
  // not a healthy one, just a bit of the mask nothing here explains.
  const enumerated = (() => { try { return nodeEnum({ kodRoot }); } catch { return []; } })();
  const up = (x) => String(x).toUpperCase();
  const placed = new Set(truth.map(s => up(s.node)));
  const inTable = new Set(Object.values(STONES).map(s => up(s.node)));
  const enumMissingFromTable = enumerated.filter(e => !inTable.has(up(e.node))).map(e => e.node);
  const enumUnplaced = enumerated.filter(e => !placed.has(up(e.node))).map(e => e.node);
  const tableNotInEnum = enumerated.length
    ? [...inTable].filter(n => !enumerated.some(e => up(e.node) === n)) : [];

  const roomsOf = (list) => new Map(Object.entries(list).map(([k, v]) => [Number(v.room), k]));
  const eRooms = roomsOf(errand), rRooms = roomsOf(runner), tRooms = roomsOf(tracked);

  // MISSING is asked per STONE and not per room, because one stone may be reachable through
  // several baked rooms. Asking per room reported the Mausoleum as both missing and spurious.
  // ONE ENTRY PER STONE, not per placement: the corpse node is created at two points in
  // uworld.kod, and listing room 1 twice reads as two missing stones.
  const missing = (rooms) => {
    const have = stonesByRoom(rooms);
    const seen = new Set();
    return truth.filter(s => !have.has(stoneKey(s)))
      .filter(s => !seen.has(stoneKey(s)) && seen.add(stoneKey(s)))
      .map(s => (s.rooms?.length ? s.rooms.join('/') : String(s.room ?? '?')));
  };
  const extra = (rooms) => [...rooms.keys()].filter(r => !byRoom.has(r));
  const collisions = [...eRooms.entries()]
    .filter(([room, key]) => rRooms.has(room) && rRooms.get(room) !== key)
    .map(([room, key]) => ({ room, errand_key: key, runner_key: rRooms.get(room) }));

  return {
    stones: truth.length,
    in_the_bake: truth.filter(s => s.in_the_bake).length,
    tracked: { has: Object.keys(tracked).length, missing_rooms: missing(tRooms),
               rooms_not_in_the_kod: extra(tRooms) },
    errand: reads(errandSrc) ? { reads_the_table: true }
      : { has: Object.keys(errand).length, missing_rooms: missing(eRooms),
          rooms_not_in_the_kod: extra(eRooms) },
    runner: reads(runnerSrc) ? { reads_the_table: true }
      : { has: Object.keys(runner).length, missing_rooms: missing(rRooms),
          rooms_not_in_the_kod: extra(rRooms) },
    key_collisions: collisions,
    enum: { declares: enumerated.length, missing_from_table: enumMissingFromTable,
            unplaced_in_the_kod: enumUnplaced, in_the_table_but_not_the_enum: tableNotInEnum },
    // The TRACKED table is the one that must be right, and it is right when it names every
    // node the ENUM declares. The other two lists are reported so their owners can be pointed
    // at it, and a missing untracked file is not a failure.
    ok: !enumMissingFromTable.length && !tableNotInEnum.length && !collisions.length,
  };
}

// ---------------------------------------------------------------- CLI

const IS_ENTRY = !!process.argv[1] &&
  join(process.argv[1]) === join(fileURLToPath(import.meta.url));

if (IS_ENTRY) {
  const argv = process.argv.slice(2);
  const want = (f) => argv.includes(f);

  if (want('--json')) {
    console.log(JSON.stringify({ stones: stones(), drift: drift() }, null, 1));
    process.exit(0);
  }

  const all = stones();
  if (!all.length) {
    console.log(`no kod found under ${KOD_ROOT} — set M59_ROOT to the Meridian 59 source tree`);
    process.exit(1);
  }

  if (!want('--diff') && !want('--check')) {
    console.log('');
    console.log(`${all.length} mana nodes, read out of the kod under ${KOD_ROOT}`);
    console.log('');
    for (const s of all) {
      const at = s.row != null ? `r${s.row}c${s.col}` : 'no position in the kod';
      console.log(`  room ${String(s.room ?? '?').padStart(5)}  ${String(s.node).padEnd(15)}` +
                  `${at.padEnd(24)}${s.placement}` +
                  `${s.in_the_bake ? '' : '   NOT IN THE BAKE'}`);
      console.log(`         ${String(s.bake_name ?? s.room_name ?? '?').padEnd(34)} ${s.file}`);
      if (s.instanced)
        console.log(`         the bake carries this .roo as rooms ${s.rooms.join(' and ')} ` +
                    `— an INSTANCED room, so either number names this stone`);
      if (s.placement === 'deferred')
        console.log(`         APPEARS ONLY WHEN: ` +
                    `${s.when ?? `\`${s.when_method ?? '?'}\` runs (no readable guard, and the ` +
                      `method name is the condition)`}` +
                    `${s.when && s.when_method ? `   [${s.when_method}]` : ''}`);
    }
  }

  const d = drift();
  console.log('');
  console.log(`THE LISTS IN THIS REPOSITORY, against those ${d.stones}:`);
  console.log('');
  const say = (label, r) => {
    if (r.reads_the_table) {
      console.log(`  ${label} reads STONES — nothing to drift`);
      return;
    }
    console.log(`  ${label} has ${r.has}`);
    if (r.missing_rooms.length)
      console.log(`    MISSING rooms: ${r.missing_rooms.join(', ')}`);
    if (r.rooms_not_in_the_kod.length)
      console.log(`    rooms the kod places no stone in: ${r.rooms_not_in_the_kod.join(', ')}`);
    if (!r.missing_rooms.length && !r.rooms_not_in_the_kod.length) console.log('    complete');
  };
  console.log(`  kod/include/blakston.khd declares ${d.enum.declares} node numbers — the ` +
              `authority, since each is one bit of piNodelist`);
  if (d.enum.missing_from_table.length)
    console.log(`    MISSING FROM STONES: ${d.enum.missing_from_table.join(', ')}`);
  if (d.enum.in_the_table_but_not_the_enum.length)
    console.log(`    IN STONES AND NOT IN THE ENUM: ` +
                `${d.enum.in_the_table_but_not_the_enum.join(', ')}`);
  if (d.enum.unplaced_in_the_kod.length)
    console.log(`    declared but no placement found in the kod: ` +
                `${d.enum.unplaced_in_the_kod.join(', ')} — either unused, or placed in a way ` +
                `this parse cannot see, which is worth a look rather than a shrug`);
  console.log('');
  say('tools/m59-stones.mjs STONES (the tracked source everything should read)  ', d.tracked);
  if (d.errand.has || d.errand.reads_the_table)
    say('tools/fleetscripts/mana-node.mjs (the errand — UNTRACKED on this machine)', d.errand);
  say('tools/m59-node-run.mjs (the circuit)                                      ', d.runner);
  for (const c of d.key_collisions)
    console.log(`  ONE STONE, TWO KEYS: room ${c.room} is '${c.errand_key}' to the errand and ` +
                `'${c.runner_key}' to the circuit — so nodes/${c.errand_key}.md and ` +
                `nodes/${c.runner_key}.md can never both be found`);
  console.log('');
  if (!d.ok)
    console.log('  A stone missing from a list is a stone nobody can be SENT to. Add it there,\n' +
                '  and see .claude/skills/node-runner/SKILL.md — the stones are that skill\'s\n' +
                '  test suite, so a list that cannot name one cannot be tested against it.');
  console.log('');
  process.exit(want('--check') && !d.ok ? 1 : 0);
}
