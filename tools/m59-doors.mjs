#!/usr/bin/env node
// THE DOORS YOU HAVE TO OPERATE, DERIVED FROM THE KOD RATHER THAN WRITTEN DOWN BY HAND.
//
//   node tools/m59-doors.mjs                 every room with operable doors, as a table
//   node tools/m59-doors.mjs --room 714      one room
//   node tools/m59-doors.mjs --write         write substrate/m59-doors.json
//   node tools/m59-doors.mjs --json          the whole thing, for a script
//
// A THIRD KIND OF DOOR, AND THE ONE THAT STRANDS CHARACTERS.
//
// `m59-codeexits.mjs` reads `SomethingMoved` — walk onto a square and the room hands you to
// another room. This reads `SomethingTryGo`: **attempt to GO on a square and the room opens a
// sector for you**, then closes it again on a timer. Nothing moves you; the geometry changes
// and you have a few seconds to walk through it.
//
// That is invisible to every other instrument here. The collision bake holds ONE sector state,
// so a hall of timed doors is baked as a warren: room 714 (The Bookmaker's Guild House) comes
// out as 28 regions, and its only exit sits in a region the main body cannot reach. The exit
// report says `OFF THE BODY`, the router says `route_progressing_exits_exhausted`, and both are
// telling the truth about a world in which the doors are welded shut.
//
// WHAT IT COST, 2026-09-19. Zoot, Statler and Pepe were all in 714 at once. Zoot and Statler
// were standing on `r4c28` — which IS door 59's outward trigger — with the hall's only exit two
// squares beyond it, alternating between a town trip they could not start and a chest room they
// could not reach. They were on the button, not pressing it. `m59-guild-passage.mjs`'s header
// records the same character doing the same thing for an hour on the same door before that.
//
// The machinery to work a door already exists (`guildPassage` presses, waits on the server's own
// `sector-height` events rather than a guessed delay, and steps through) — but the door TABLE it
// works from is hand-written and covers one room. This derives that table for all of them.
//
// WHAT THE KOD GIVES, AND THEREFORE WHAT A MOVER NEEDS TO KNOW:
//
//   * the TRIGGER squares — `when` is WHERE THE CHARACTER IS STANDING, not where it is trying
//     to go. `user.kod:5669` sends `@SomethingTryGo #row=piRow #col=piCol`, the player's own
//     position. So a door is worked by walking ONTO its square (they stay walkable while shut)
//     and issuing a go from there. Worth stating because the obvious other reading — the target
//     of the attempted step — puts every trigger one square off, and a trigger one square off
//     is a body pressing nothing;
//   * the sector that moves, and its open and closed heights, so a bake can be made per state;
//   * `speed`, which is how fast it animates — you cannot step the instant you press;
//   * `DOOR_DELAY`, which is how long you have before it shuts again. In 714 that is 5000ms,
//     and the timer starts at the PRESS, not when the door finishes opening;
//   * the GATE, where there is one: the main door asks `ReqLegalEntry` and the two lifts ask
//     `IsMember`, so a character not in the owning guild cannot open them at all and should
//     not be routed through them.
//
// TWENTY-TWO ROOMS USE THIS PATTERN, not one hall: every guild hall 1-14, the temples of
// Kraanan and Qor, the ice cave, the Tos arena, the Duke's chambers, the orc pit, the Marion
// crypt. The Kraanan temple is where the disciple quest goes and the ice cave is a mana node,
// so this is not a guild-hall curiosity.
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { methodBody, parseCondition, collapseDisjunctions } from './m59-codeexits.mjs';

/**
 * `NAME = 123` out of the class's `constants:` block.
 *
 * Case-insensitively keyed, because kod is case-insensitive and a table that only answers to
 * the canonical spelling is the bug that hid the Temple of Qor's two entrances for a month.
 */
export function parseConstants(src) {
  const out = new Map();
  const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+)\s*$/gm;
  let m;
  while ((m = re.exec(src))) out.set(m[1].toUpperCase(), Number(m[2]));
  return out;
}

const constant = (consts, name) =>
  name == null ? null
  : /^-?\d+$/.test(String(name).trim()) ? Number(name)
  : (consts.get(String(name).trim().toUpperCase()) ?? null);

/**
 * THE CLOSED HEIGHT IS NOT IN THE CALL, so it is READ from the other end of the swing.
 *
 * `SetSector` names only the height it is moving TO, so the shut height is wherever the room
 * puts it back — `CloseNorthDoor`, `lowerliftone`, whatever it is called. Two ways to find it,
 * in this order, because the first is a fact and the second is a naming habit:
 *
 *   1. EVERY `SetSector` FOR THAT SECTOR IN THE FILE. A door is opened in one place and closed
 *      in another, both naming the same sector; the height that is not the open one is the shut
 *      one. This works regardless of whether the kod used a constant or a literal.
 *   2. The sibling constant — `X_CLOSED`, or `X_DOWN` for a lift whose open state is `X_UP`.
 *
 * Measured why (1) has to come first: `guildh10.kod` writes `#height = 72` to open NORTH_DOOR
 * and `#height = 0` to close it, with no named constant for either. Convention alone left
 * twelve doors across five rooms with no closed height — including every door of guild halls
 * 710 and 712 — and a door with no second height cannot have a state baked for it, which is
 * exactly the door that strands somebody.
 *
 * More than two distinct heights is not a door this function understands, and it says so
 * rather than picking one.
 */
export function otherEnd(consts, sectorName, openHeight, seenHeights = null) {
  const base = String(sectorName).toUpperCase();
  if (seenHeights) {
    const others = [...seenHeights].filter(h => Number.isFinite(h) && h !== openHeight);
    if (others.length === 1) return { height: others[0], from: 'the sector\'s other SetSector' };
    if (others.length > 1)
      return { height: null, from: null, ambiguous: others.sort((a, b) => a - b) };
  }
  for (const suffix of ['_CLOSED', '_DOWN', '_SHUT']) {
    const v = consts.get(base + suffix);
    if (Number.isFinite(v) && v !== openHeight) return { height: v, from: base + suffix };
  }
  return { height: null, from: null };
}

/**
 * Every height each sector is ever set to, anywhere in the class. The raw material for
 * `otherEnd`, and the states an alternate grid would have to cover.
 */
export function sectorHeights(src, consts) {
  const out = new Map();
  const re = /SetSector\s*,?\s*#sector\s*=\s*([A-Za-z_][A-Za-z0-9_]*|\d+)[^;]*?#height\s*=\s*([A-Za-z_][A-Za-z0-9_]*|\d+)/gis;
  let m;
  while ((m = re.exec(src))) {
    const sector = constant(consts, m[1]);
    const height = constant(consts, m[2]);
    if (sector == null || height == null) continue;
    if (!out.has(sector)) out.set(sector, new Set());
    out.get(sector).add(height);
  }
  return out;
}

/**
 * The door facts in one piece of kod — a trigger branch, or the method it delegates to.
 * Null when this code does not move a sector at all.
 */
function doorFacts(code, consts, heights = null) {
  const set = /SetSector\s*,?\s*#sector\s*=\s*([A-Za-z_][A-Za-z0-9_]*|\d+)/i.exec(code);
  if (!set) return null;
  const sectorName = set[1];
  const heightM = /#height\s*=\s*([A-Za-z_][A-Za-z0-9_]*|\d+)/i.exec(code);
  const open = constant(consts, heightM?.[1]);
  const sector = constant(consts, sectorName);
  const { height: closed, from: closedFrom, ambiguous } =
    otherEnd(consts, sectorName, open, heights?.get(sector) ?? null);
  const speed = Number(/#speed\s*=\s*(\d+)/i.exec(code)?.[1] ?? NaN);
  const delayName =
    /createtimer\s*\([^,]*,\s*@[A-Za-z0-9_]+\s*,\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*\)/i
      .exec(code)?.[1] ?? null;
  return {
    sectorName, sector,
    open, closed, closedFrom, ambiguousHeights: ambiguous ?? null,
    speed: Number.isFinite(speed) ? speed : null,
    anim: /#animation\s*=\s*(ANIMATE_[A-Z_]+)/i.exec(code)?.[1] ?? null,
    delayName, delayMs: constant(consts, delayName),
    openHeightName: heightM?.[1] ?? null,
  };
}

/**
 * Every branch of `SomethingTryGo` that opens a sector.
 *
 * Returns one entry per branch: which squares arm it, which sector moves, between which
 * heights, how fast, how long it stays open, and what stops a character using it.
 */
export function doorsFor(src) {
  const body = methodBody(src, 'SomethingTryGo');
  if (!body) return [];
  const consts = parseConstants(src);
  const heights = sectorHeights(src, consts);
  const out = [];
  const ifRe = /\bif\s*([^{]*?)\s*\{/g;
  let m;
  while ((m = ifRe.exec(body))) {
    const condText = m[1];
    const when = parseCondition(condText);
    if (!when.length) continue;
    let depth = 1, i = m.index + m[0].length;
    for (; i < body.length && depth; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') depth--;
    }
    const block = body.slice(m.index + m[0].length, i);

    // ONE LEVEL OF INDIRECTION, BECAUSE THE MOST IMPORTANT DOOR IN THE TREE USES IT.
    //
    // Most trigger branches move the sector inline. 714's ENTRANCE does not — the branch reads
    // `if ReqLegalEntry { send(self,@OpenEntranceDoor) }` and the `SetSector` lives in that
    // method. A version of this that only looked in the branch found five of 714's six doors
    // and missed MAIN_DOOR (59), which is the one the hall's only exit is behind, and the one
    // Zoot and Statler were standing on when this was written. The near-complete table would
    // have been worse than none: every door but the one that mattered.
    const facts = (() => {
      const direct = doorFacts(block, consts, heights);
      if (direct) return direct;
      for (const call of block.matchAll(/send\s*\(\s*self\s*,\s*@([A-Za-z0-9_]+)/gi)) {
        const body = methodBody(src, call[1]);
        if (!body) continue;
        const f = doorFacts(body, consts, heights);
        if (f) return { ...f, via: call[1] };
      }
      return null;
    })();
    if (!facts) continue;                     // a branch that does something else entirely
    const { sectorName, sector, open, closed, closedFrom, speed, anim, delayName, delayMs, via,
            ambiguousHeights } = facts;

    // WHAT STOPS A CHARACTER USING IT. Recorded rather than inferred: a router that sends an
    // outsider at a members-only lift produces a body standing on a trigger that will never
    // fire, which is the exact failure this file exists to make visible.
    const gate = /ReqLegalEntry/i.test(block) ? 'ReqLegalEntry'
               : /IsMember/i.test(block) ? 'IsMember'
               : null;

    // SAME-AXIS EQUALITIES ARE ALTERNATIVES — the rule m59-codeexits.mjs owns — so `(row = 18
    // and col = 10) or (row = 19 and col = 10)` collapses correctly to rows [18,19], col 10.
    //
    // IT DOES NOT COLLAPSE CORRECTLY WHEN BOTH AXES VARY. `(r18,c10) or (r19,c11)` would flatten
    // to rows [18,19] x cols [10,11], admitting two squares the kod never names. Flagged rather
    // than silently widened, because a trigger square that is not a trigger square is a body
    // standing somewhere pressing nothing.
    const eq = a => [...new Set(when.filter(c => c.axis === a && c.op === '==').map(c => c.value))];
    const ambiguous = /\bor\b/i.test(condText) && eq('row').length > 1 && eq('col').length > 1;

    out.push({
      sector, sector_name: sectorName.toUpperCase(),
      when: collapseDisjunctions(when),
      open, closed, closed_from: closedFrom,
      kind: anim ? (/CEILING/i.test(anim) ? 'ceiling' : 'floor') : null, animation: anim,
      speed, delay_ms: delayMs, delay_from: delayName,
      gate,
      ...(via ? { opened_via: via } : {}),
      ...(ambiguousHeights ? { ambiguous_heights: ambiguousHeights } : {}),
      ...(ambiguous ? { ambiguous_pairs: true } : {}),
      ...(sector == null ? { unresolved_sector: sectorName } : {}),
      ...(open == null ? { unresolved_height: facts.openHeightName } : {}),
    });
  }
  return out;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.kod')) out.push(p);
  }
  return out;
}

/** Scan every room class and index its operable doors by room number. */
export function buildDoors({ kodRoot, mapFile, outFile }) {
  const map = JSON.parse(readFileSync(mapFile, 'utf8'));
  const byCls = new Map();
  for (const r of Object.values(map.rooms)) if (r.cls) byCls.set(r.cls.toLowerCase(), r);

  const rooms = {};
  const unmatched = [], incomplete = [], noAutoClose = [];
  let scanned = 0;
  for (const file of walk(join(kodRoot, 'object', 'active', 'holder', 'room'))) {
    const src = readFileSync(file, 'utf8');
    const cls = /^\s*([A-Za-z0-9_]+)\s+is\s+[A-Za-z0-9_]+/m.exec(src)?.[1];
    if (!cls) continue;
    scanned++;
    const doors = doorsFor(src);
    if (!doors.length) continue;
    const room = byCls.get(cls.toLowerCase());
    // A CLASS WITH DOORS AND NO ROOM IS REPORTED, NEVER DROPPED. It means the map does not
    // carry that room, which is a fact about the bake and not about the door.
    if (!room) { unmatched.push({ cls, doors: doors.length }); continue; }
    // TWO DIFFERENT THINGS, AND ONLY ONE OF THEM IS A DEFECT.
    //
    // A door with no second HEIGHT cannot have a state baked for it — that is a gap in what was
    // read. A door with no close DELAY is a door that does not shut itself: the Temple of Qor's
    // and the feast hall's stay as they are put. Filing the second under "incomplete" sends the
    // next reader looking for a number the kod never had.
    for (const d of doors) {
      if (d.closed == null || d.open == null)
        incomplete.push(`${room.num} ${d.sector_name}` +
          (d.open == null ? ' (no open height)' : '') +
          (d.closed == null ? ' (no closed height)' : '') +
          (d.ambiguous_heights ? ` (${d.ambiguous_heights.length} candidate heights)` : ''));
      else if (d.delay_ms == null) noAutoClose.push(`${room.num} ${d.sector_name}`);
    }
    rooms[room.num] = { name: room.name, cls, file: file.slice(file.indexOf('object')).replace(/\\/g, '/'), doors };
  }

  const out = {
    note: 'Doors you OPERATE: attempt a `go` on a trigger square, the room moves a sector, and ' +
          'it closes again after delay_ms — which is timed from the PRESS, not from the moment ' +
          'it finishes opening. Derived from SomethingTryGo by tools/m59-doors.mjs; do not ' +
          'hand-edit. `gate` is what refuses the press: ReqLegalEntry or IsMember.',
    built_at: new Date().toISOString(),
    rooms,
    stats: { classes_scanned: scanned, rooms_with_doors: Object.keys(rooms).length,
             doors: Object.values(rooms).reduce((n, r) => n + r.doors.length, 0),
             unmatched_classes: unmatched, incomplete, no_auto_close: noAutoClose },
  };
  if (outFile) writeFileSync(outFile, JSON.stringify(out, null, 1));
  return out;
}

if (process.argv[1]?.endsWith('m59-doors.mjs')) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const kod = process.env.M59_KOD || 'C:/code/meridian59/kod';
  if (!existsSync(kod)) { console.error('no kod source at ' + kod); process.exit(1); }
  const argv = process.argv.slice(2);
  const only = argv.includes('--room') ? Number(argv[argv.indexOf('--room') + 1]) : null;
  const idx = buildDoors({ kodRoot: kod, mapFile: root + 'substrate/m59-map.json',
                           outFile: argv.includes('--write') ? root + 'substrate/m59-doors.json' : null });
  if (argv.includes('--json')) { console.log(JSON.stringify(idx, null, 1)); process.exit(0); }
  console.log(JSON.stringify(idx.stats.doors) + ' door(s) in ' + idx.stats.rooms_with_doors +
              ' room(s), from ' + idx.stats.classes_scanned + ' class(es) scanned');
  for (const [num, r] of Object.entries(idx.rooms).sort((a, b) => a[0] - b[0])) {
    if (only && Number(num) !== only) continue;
    console.log(`\n  ${num}  ${r.name}`);
    for (const d of r.doors) {
      const sq = d.when.map(c => `${c.axis}${c.op}${Array.isArray(c.values) ? '[' + c.values + ']' : c.value}`).join(' ');
      console.log(`     sector ${String(d.sector ?? '?').padEnd(3)} ${String(d.sector_name).padEnd(14)}` +
                  ` ${String(d.kind ?? '?').padEnd(8)} ${String(d.closed ?? '?')}->${String(d.open ?? '?')}` +
                  ` speed ${String(d.speed ?? '?').padEnd(4)} shuts after ${d.delay_ms ?? '?'}ms` +
                  (d.gate ? `  [${d.gate}]` : '') + (d.ambiguous_pairs ? '  [AMBIGUOUS PAIRS]' : ''));
      console.log(`         press at: ${sq}`);
    }
  }
  if (idx.stats.incomplete.length) {
    console.log('\n  INCOMPLETE — no second height, so no state can be baked for these:');
    for (const w of idx.stats.incomplete.slice(0, 12)) console.log('    ' + w);
  }
  if (idx.stats.no_auto_close.length)
    console.log('\n  stays as it is put (no close timer): ' + idx.stats.no_auto_close.join(', '));
  if (idx.stats.unmatched_classes.length)
    console.log('\n  classes with doors and no room in the map: ' +
                idx.stats.unmatched_classes.map(u => `${u.cls}(${u.doors})`).join(', '));
}
