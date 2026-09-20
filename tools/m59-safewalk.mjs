#!/usr/bin/env node
// STAND ME ON A SAFE WALL WITH SOMETHING TRYING TO HIT ME.
//
//   node tools/m59-safewalk.mjs                        King's Way, TESTER, 6 giant rats
//   node tools/m59-safewalk.mjs --room 544             the Valley of Ileria instead
//   node tools/m59-safewalk.mjs --at 23,31             a particular square
//   node tools/m59-safewalk.mjs --monsters 10 --class GiantRat --radius 4
//   node tools/m59-safewalk.mjs --list                 the proven squares, no server
//   node tools/m59-safewalk.mjs --clear                delete everything this spawned
//
// CLI CONTRACT: `--at` is `row,col` (KOD/RoomGeometry order).
//
// THE SAFE WALL IS THE ONE THING IN THIS REPOSITORY THAT CANNOT BE READ OFF A MAP.
// `safeSpots()` nominates squares from geometry and it is a MODEL; the book records what
// actually held when something swung. Between those two sits a claim nobody has ever
// watched: that standing on this square, in this corner, means the thing in front of you
// cannot answer. That claim is what this tool arranges — a body on the square, monsters
// in front of it, and a person looking.
//
// WHY IT SPAWNS RATHER THAN WALKS SOMEWHERE MONSTERS LIVE. A room's own spawn table
// decides what is in it and when, so "go to King's Way and wait" is a twenty-minute
// experiment with no controls: you cannot choose the count, you cannot choose the level,
// you cannot repeat it, and if nothing bites you learn nothing at all. `create object`
// plus `UtilGoNearSquare` puts a known number of a known creature at a known distance,
// in about a second, as many times as you like.
//
// THE DEFAULT MONSTER IS DELIBERATELY FEEBLE. GiantRat is viLevel 30, viDifficulty 1 —
// attack rating 3*30 + 60*1 = 150, against a fungus beast's 210 and a faction soldier's
// 572 mean. The point is to be swung at repeatedly while you look at the map, not to
// find out how a test character dies. Pass --class for something meaner on purpose.
//
// IT WRITES DOWN WHAT IT CREATED, and `--clear` is the only reason that matters. An
// object created over this socket is a real object in a real world and nothing else will
// ever mention it again; a debugging aid that cannot be undone stops being used. Same
// rule, and the same book shape, as m59-ping.mjs.
//
// LOOPBACK ONLY, enforced by m59-dm.mjs's own guard rather than by a promise here. This
// creates monsters next to a player; it is not a thing to point at a shared server.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dm, isLoopbackHost, adminTarget, roomObject, relocateCmd, rejections,
         clampSquare, resolve, heal } from './m59-dm.mjs';
import { safeWalls, geometryFor } from './m59-safespots.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOK = HERE + '/../substrate/safewalk.json';
const MAP_FILE = process.env.M59_MAP_FILE || HERE + '/../substrate/m59-map.json';

const load = () => { try { return JSON.parse(readFileSync(BOOK, 'utf8')); } catch { return { spawned: [] }; } };
const save = b => { mkdirSync(dirname(BOOK), { recursive: true }); writeFileSync(BOOK, JSON.stringify(b, null, 1)); };

// Rooms worth doing this in, with why. Not a closed list — --room takes any number —
// but a default of "King's Way" beats a default of "544" for somebody who has not read
// the safe-spot book this morning.
export const PLACES = {
  575: { name: "The King's Way", why: '18 proven safe walls, 50 burned, the densest picture in the world' },
  544: { name: 'Valley of Ileria', why: '5 proven safe walls, and the fleet actually hunts here' },
  586: { name: 'Main gate to Tos', why: '21 proven, 57 burned' },
  587: { name: 'Western border of the Twisted Wood', why: 'the room NEXT-STEPS is named after' },
};

/**
 * The squares in a room worth demonstrating on, best first.
 *
 * COMPUTED, NOT REMEMBERED. This used to return the squares the safe-spot book recorded as
 * held-and-never-failed. That book is retired (tombstone in m59-safespots.mjs), and for this
 * particular job it was the wrong source even while it existed: its "proven" squares were
 * single ~16-second windows against a single attacker, which is something ordinary floor
 * produces regularly. Geometry is both available and now proven in play — 1,290s standing on
 * `attackers === 0` with monsters in reach and moving took zero attacks — so the demonstration
 * picks the squares the rule actually names.
 */
export function provenIn(room, geo = null) {
  const g = geo ?? geometryForRoom(room);
  if (!g) return [];
  return (safeWalls(g) ?? [])
    .filter(w => Number.isFinite(w.row) && Number.isFinite(w.col))
    .map(w => ({ ...w, held: null }));
}

let _map = null;
function geometryForRoom(room) {
  try {
    _map ??= JSON.parse(readFileSync(MAP_FILE, 'utf8'));
    const r = Object.values(_map.rooms ?? _map).find(x => Number(x?.num) === Number(room));
    return r ? geometryFor(r) : null;
  } catch { return null; }
}

/**
 * Where to put the monsters.
 *
 * A RING, AND NOT ON THE SPOT ITSELF. `UtilGoNearSquare` searches outward for somewhere
 * standable, so asking for the square the player is on lands the monster next to them —
 * which is the one arrangement that cannot demonstrate anything, because a creature in
 * contact does not need a line of sight. The ring is placed at a radius inside melee
 * reach (2-3 squares, `Bound(2 + viDifficulty/6, 2, 3)`), so they will try, and whether
 * they connect is the thing being tested.
 */
export function ringAround({ row, col }, { count = 6, radius = 3, rows = 0, cols = 0 } = {}) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = (2 * Math.PI * i) / count;
    const r = Math.round(row + radius * Math.sin(a));
    const c = Math.round(col + radius * Math.cos(a));
    out.push(clampSquare(r, c, rows, cols));
  }
  return out;
}

/**
 * Keep the subject on its feet, for as long as somebody is looking.
 *
 * A DEAD TEST CHARACTER ENDS THE EXPERIMENT AND TELLS YOU NOTHING. The question being
 * asked here is "does anything land on this square", and the honest answer to that is a
 * count of blows — but a character that dies stops being on the square, gets sent to the
 * Underworld, and takes the operator's next ten minutes. Topping it up converts every
 * death into another data point.
 *
 * IT DOES NOT MAKE THE READING DISHONEST, and it is worth being clear about why: the
 * safe-spot book records whether damage was TAKEN, not whether the character survived.
 * Healing after the fact changes the survival and not the observation. What it would
 * corrupt is a test of how LONG something survives, and that is not a question anybody
 * asks of a wall.
 *
 * `heal` is the one that gets this right — it reads each character's own ceilings and
 * SETS the properties rather than sending a gain message, which is the difference
 * between 50/50 and 88/50. See its comment for all three traps.
 */
export async function sustain(who, { everyMs = 2000, onTick = null } = {}) {
  // A LIST, BECAUSE THE BOTS ARE SUBJECTS TOO. The first version topped up only the
  // person playing, on the assumption that the bots were instruments rather than
  // participants — and then five of them stood in a ring of rats being chewed while the
  // one character that could not die watched. A dead follower is a follower that stops
  // demonstrating the routing bug, which is the whole reason it is standing there.
  const names = Array.isArray(who) ? who : [who];
  for (;;) {
    try {
      const r = await heal(names);
      onTick?.(r);
    } catch (e) {
      // A FAILED TOP-UP IS NOT A REASON TO STOP TOPPING UP. The socket can be busy, the
      // server can be mid-save, the character can be momentarily unresolvable during a
      // room change — all transient, and all things that would otherwise end the loop
      // silently and let the subject die twenty minutes later.
      onTick?.({ error: e.message });
    }
    await new Promise(res => setTimeout(res, everyMs));
  }
}

// --------------------------------------------------------------------------- cli
if (process.argv[1]?.endsWith('m59-safewalk.mjs')) {
  const argv = process.argv.slice(2);
  const has = n => argv.includes('--' + n);
  const flag = (n, d = null) => {
    const at = argv.indexOf('--' + n);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
  };

  const room = Number(flag('room', 575));
  const who = flag('who', 'TESTER');
  const klass = flag('class', 'GiantRat');
  const count = Number(flag('monsters', 6));
  const radius = Number(flag('radius', 3));
  const proven = provenIn(room);

  if (has('list')) {
    console.log(`room ${room}${PLACES[room] ? ' — ' + PLACES[room].name : ''}: ` +
                `${proven.length} square(s) the geometry calls a safe wall\n`);
    for (const e of proven)
      console.log(`  row ${String(e.row).padStart(3)}  col ${String(e.col).padStart(3)}` +
                  `   attackers ${e.attackers ?? '?'}   back cover ${e.back_cover ?? '?'}`);
    console.log('\nrooms worth trying:');
    for (const [n, p] of Object.entries(PLACES))
      console.log(`  --room ${n}  ${p.name} — ${p.why}`);
    process.exit(0);
  }

  const target = adminTarget();
  if (!isLoopbackHost(target.host)) {
    console.error(`refusing: ${target.host} is not loopback. This creates monsters next to a ` +
                  'player, and the maintenance port has no authentication at all.');
    process.exit(2);
  }

  if (has('clear')) {
    const b = load();
    const ids = b.spawned.map(s => s.id);
    if (!ids.length) { console.log('nothing spawned by this tool is outstanding'); process.exit(0); }
    // `send object N Delete`, NOT `delete object N` — the admin console has a `delete`
    // subcommand and it answers "Unknown command" for this. Same finding as m59-ping.
    const out = await dm(ids.map(id => `send object ${id} Delete`));
    const refused = rejections(out);
    console.log(`asked the server to delete ${ids.length} spawned object(s)` +
                (refused.length ? ` — ${refused.length} refused` : ''));
    save({ spawned: [] });
    process.exit(0);
  }

  // WHERE. An explicit --at beats the book, because the whole point of some of these
  // runs is a square the book has nothing to say about yet.
  let at = null;
  const atArg = flag('at');
  if (atArg) {
    const [r, c] = atArg.split(',').map(Number);
    if (!Number.isFinite(r) || !Number.isFinite(c)) {
      console.error('--at wants row,col');
      process.exit(2);
    }
    at = { row: r, col: c };
  } else if (proven.length) {
    at = { row: proven[0].row, col: proven[0].col };
  } else {
    console.error(`no proven safe square recorded in room ${room}. Pass --at row,col, or ` +
                  'try --list for a room that has some.');
    process.exit(2);
  }

  const roomObj = await roomObject(room);
  if (roomObj == null) {
    console.error(`could not resolve room ${room} on this server — is it loaded?`);
    process.exit(1);
  }

  // WHO. Resolved in the same breath it is used, because object ids are reissued on
  // every save and a cached one goes quietly deaf.
  const ids = await resolve([who]);
  const mine = ids[who];
  if (mine == null) {
    console.error(`no character called ${who} on this server`);
    process.exit(1);
  }

  console.log(`room ${room}${PLACES[room] ? ' — ' + PLACES[room].name : ''}`);
  console.log(`placing ${who} on row ${at.row}, col ${at.col}` +
              (atArg ? ' (as asked)' : ` — held ${proven[0].held}x, never failed`));

  await dm([relocateCmd(mine, roomObj, at.row, at.col)]);

  // THE MONSTERS. Created first, ids read back, then placed — two batches rather than
  // one only because the new object's id has to be read in between. `create object`
  // answers with its own sentence and NOT the shape `returnedObject` parses; reading it
  // the other way silently creates objects and places none of them.
  const ring = ringAround(at, { count, radius });
  const made = await dm(Array.from({ length: count }, () => `create object ${klass}`));
  const newIds = [...String(made).matchAll(/Created object (\d+)/g)].map(m => Number(m[1]));
  if (newIds.length !== count)
    console.log(`  warning: asked for ${count} ${klass} and read back ${newIds.length} id(s)`);

  const placed = await dm(newIds.map((id, i) => relocateCmd(id, roomObj, ring[i].row, ring[i].col)));
  const refused = [...rejections(made), ...rejections(placed)];

  const b = load();
  b.spawned.push(...newIds.map((id, i) => ({ id, klass, room, ...ring[i], at: Date.now() })));
  save(b);

  console.log(`spawned ${newIds.length} ${klass} in a ring of radius ${radius}` +
              (refused.length ? ` — ${refused.length} refused: ${refused.slice(0, 2).join('; ')}` : ''));
  console.log(`  ${ring.map(p => p.row + ',' + p.col).join('  ')}`);
  console.log('\nA rat is level 30 difficulty 1 — attack rating 150, the mildest thing worth');
  console.log('spawning. Melee reach is 2-3 SQUARES and ignores fine position entirely, so');
  console.log('up to 28 squares can hit you; the wall is what stops them, not the distance.');
  console.log(`\nundo:  node tools/m59-safewalk.mjs --clear`);

  // THE TOP-UP LOOP IS THE DEFAULT, because the failure it prevents is the one that ends
  // the session: the subject dies, goes to the Underworld, and the person who was
  // looking at a wall is now doing a corpse run. `--once` opts out.
  if (has('once')) {
    console.log('\n--once: not sustaining. The character is on its own.');
    process.exit(0);
  }

  const everyMs = Number(flag('every', 2000));
  console.log(`\nsustaining ${who} — health, mana and vigor to their own ceilings every ` +
              `${everyMs}ms. Ctrl-C to stop; the rats stay until --clear.`);
  let ticks = 0, complaints = 0;
  const sustainList = [who, ...(flag("also", "Alpha,Bravo,Charlie,Delta,Echo").split(",").map(s => s.trim()).filter(Boolean))];
  console.log(`  also sustaining: ${sustainList.slice(1).join(", ")}`);
  await sustain(sustainList, { everyMs, onTick: r => {
    ticks++;
    // QUIET WHEN IT IS WORKING. This runs for as long as somebody is playing, and a
    // line every two seconds buries the one line that matters. Only failures speak,
    // and only the first few of each — a socket that has gone away would otherwise
    // produce a thousand identical complaints.
    if (r?.error || r?.rejected?.length || r?.missing?.length) {
      if (complaints++ < 5)
        console.log(`  tick ${ticks}: ${r.error ?? (r.missing?.length ? 'cannot find ' + who
                     : r.rejected.slice(0, 2).join('; '))}`);
      else if (complaints === 6)
        console.log('  (further top-up complaints suppressed)');
    }
  } });
}
