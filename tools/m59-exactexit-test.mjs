#!/usr/bin/env node
import { readToolSource } from './autopilot/source.mjs';
// CAN THE BAKED ANCHOR OVERRIDE A DOOR THE CALLER CHOSE ON PURPOSE?
//
//   node tools/m59-exactexit-test.mjs
//
// Offline. Reads source and the baked map; opens no socket, starts no broker.
//
// WHY THIS FILE EXISTS. `leaveViaAny` widens a boundary on purpose: `spreadEdges` offers
// every square that crosses it, and the baked anchor is unshifted to the FRONT because the
// bake planned a walkable line to it while a scanned square only has floor on it. There is
// a comment in orderExits saying so in capitals — "THE BAKED ANCHOR GOES FIRST, AND
// DISTANCE MUST NOT OUTRANK IT" — and it is right, for the case it was written for: a wide
// wall whose crossings are alternatives.
//
// THEY ARE NOT ALTERNATIVES WHEN THE DESTINATION IS SPLIT. Measured on prod 2026-08-27,
// Castle Victoria into Upstairs Castle Victoria:
//
//     door (19,2) lands (28,8)   <- THE BAKED ANCHOR, and the wrong island
//     door (19,1) lands (28,8)
//     door (17,2) lands (23,8)   <- where the quarry is
//     door (17,1) lands (23,8)
//
// `crossSameRoomIsland` filtered correctly down to the two doors that land on the quarry's
// side. The anchor then won the ordering, the character crossed by (19,2), and the keeper
// reported "returned to the room, but not to the quarry's connected side" — a flawless round
// trip back to where it started. Three of six characters did that in a single window, and
// the group killed nothing all night.
//
// So the law being pinned is narrow: when a caller passes `exact`, the door set it named is
// the whole permitted set — no anchor injected, no spreading to other squares on the wall —
// and `exact` is OFF everywhere else so ordinary crossings keep the behaviour that makes a
// wide wall reliable. And it must still FALL BACK: narrowing to nothing would strand a
// character at a boundary it could otherwise have crossed, which is worse than a wrong door.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMap } from './m59-map.mjs';
import { attachStepMasks, activeRoutes, anchorFor } from './m59-routes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const game = readToolSource(join(HERE, 'm59-session-walk.mjs'), 'utf8');
const pilot = readToolSource(join(HERE, 'm59-autopilot.mjs'), 'utf8');

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

// The slice of leaveViaAny that does the widening, so the assertions are about the real
// function rather than about the whole file.
const leave = (() => {
  const i = game.indexOf('async leaveViaAny(');
  return i === -1 ? "" : game.slice(i, i + 16000);
})();

console.log('leaveViaAny takes an exact mode, and it is OFF by default');
{
  ok('the option exists', /exact = false/.test(leave));
  // Default-off is the whole safety argument: every other crossing in the game keeps the
  // anchor-first behaviour, and only a caller that has already chosen opts out of it.
  ok('and it defaults to the old behaviour', /exact = false \} = \{\} \) =>|exact = false \} = \{\}\) \{/.test(leave)
     || /controlToken,\s*\n\s*exact = false \} = \{\}\) \{/.test(leave), 'default is not false');
}

console.log('\nwith it on, the anchor is not injected');
{
  ok('the injection loop is skipped entirely',
     /for \(const e of \(exact \? \[\] : \(candidates \|\| \[\]\)\)\)/.test(leave),
     'the anchor loop still runs over the candidates');
  ok('and the spread is narrowed to the squares the caller named',
     /const exactSquares = exact/.test(leave) &&
     /exactSquares\.has\(`\$\{e\.stand_on\.col\},\$\{e\.stand_on\.row\}`\)/.test(leave));
}

console.log('\nbut it never narrows to nothing');
{
  // A boundary refused is not recoverable in the way a wrong door is: the character simply
  // stops travelling. So an empty filter keeps the original spread.
  ok('an empty result falls back to the unfiltered spread',
     /if \(kept\.length\) \{ spread\.length = 0; spread\.push\(\.\.\.kept\); \}/.test(leave),
     'the filter is applied unconditionally — a disagreement would strand the character');
}

console.log('\nand the split-room crossing asks for it, on BOTH legs');
{
  ok('the leg out', /leaveViaAny\(out, \{ exact: true \}\)/.test(pilot));
  ok('and the leg back — the one that was broken',
     /leaveViaAny\(back, \{ exact: true \}\)/.test(pilot));
  // Nothing else should be using it: exact is for a caller that has already decided, and
  // an ordinary journey has not.
  const uses = [...pilot.matchAll(/leaveViaAny\([^)]*exact: true/g)].length;
  ok('and nothing else in the keeper uses it', uses === 2, `${uses} call site(s)`);
}

console.log('\nthe measurement this is all about, against the live bake');
{
  if (!existsSync(join(HERE, '..', 'substrate', 'm59-map.json'))) {
    console.log('  (no baked map — skipping the data check)');
  } else {
    const map = loadMap();
    const masks = attachStepMasks(map);
    ok('the bake carries step masks, or this is the wrong map', masks.attached > 0);
    const doors = (map.rooms?.[38]?.goExits || [])
      .filter(e => Number(e.to) === 39 && !e.locked && e.arriveCol != null);
    ok('Castle Victoria still publishes several doors into the split room', doors.length > 1);
    let anchor = null;
    try { anchor = anchorFor(activeRoutes(), 38, 39); } catch { anchor = null; }
    ok('and a baked anchor still exists for that boundary', !!anchor, 'no anchor');
    if (anchor && doors.length) {
      const anchorDoor = doors.find(d => Number(d.col) === Number(anchor.col)
                                      && Number(d.row) === Number(anchor.row));
      const landings = new Set(doors.map(d => `${d.arriveCol},${d.arriveRow}`));
      // THE TRAP, STATED AS DATA. If the anchor's landing is not the only landing, then an
      // anchor that outranks a filtered set can and will cross by the wrong door.
      ok('the anchor is one of those doors', !!anchorDoor,
         `anchor ${anchor.col},${anchor.row} is not a published door`);
      ok('and it does NOT serve every island — which is why exact had to exist',
         landings.size > 1, `${landings.size} landing(s)`);
      if (anchorDoor)
        console.log(`       anchor door (${anchorDoor.col},${anchorDoor.row}) lands ` +
                    `(${anchorDoor.arriveCol},${anchorDoor.arriveRow}) of ${landings.size} landings`);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
