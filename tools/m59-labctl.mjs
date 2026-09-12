#!/usr/bin/env node
// SIMULATION CONTROLLERS: PUT A UNIT THERE, STOP THE ROOM BREEDING, TRY AGAIN.
//
//   import { stageRoom, spawnsOff, spawnsOn, holdInRoom, stageAt } from './m59-labctl.mjs';
//
//   async setup(ctx) {
//     await stageRoom(45, { spawns: 'off',                  // the room stops generating
//                           hold: ['giant rat', 'orc'],     // what is there stops moving
//                           place: { name: ctx.agents[0], row: 60, col: 46 } });
//   }
//
// The pieces are exported individually too, but `stageRoom` is the one to reach for: it does them
// in the order that makes the result stable, and stops if the room could not be muted.
//
// These are the `#dm` controllers the FleetScratch doc describes: reusable lab setup, declared
// once, imported by any pad that needs the same starting conditions. They are LAB ONLY and they
// say so -- every one of them refuses a non-loopback admin target before it sends anything.
//
// ============================================================ WHY SPAWNS OFF IS NOT JUST QUIET
//
// A monster standing in a jump BLOCKS IT. Collision is height-agnostic (`CanMoveInRoomFine`
// takes no z), so a body under a ledge refuses a hop over it exactly like a wall -- which is the
// commonest cause of "it worked yesterday and refuses today", and the reason a rail that passes
// offline fails on the tenth attempt.
//
// AND IT MATTERS FOR REPRODUCIBILITY, NOT ONLY FOR NOISE. The server has ONE global rand()
// stream shared by every consumer (blakserv/ccode.c:1943), so every spawn tick consumes draws
// and shifts everything downstream. Two runs of one scene diverge if one of them bred a rat.
//
// ============================================================ THE MECHANISM, FROM THE CORPUS
//
// `reports/monster-room-spawning.md` in m59-research, which is pinned and was read rather than
// re-derived. `TryCreateMonster` is gated before it rolls anything
// (`monsroom.kod:136-141`):
//
//     if NOT send(self,@IsMonsterCountBelowMax) OR NOT pbGenerateMonsters { return; }
//
// So there are two independent ways to stop a room breeding, and they are not equivalent:
//
//   SetMonsterGeneration(FALSE)   `monsroom.kod:125-130`. A MESSAGE, which is the supported
//                                 door -- it sets pbGenerateMonsters and nothing else. Reversible
//                                 with TRUE. This is what these helpers use.
//   piMonster_count_max = 0       pokes the cap instead. Also works, and is worse: the cap is
//                                 read by other code and a room left at 0 looks like a room that
//                                 was configured that way rather than one somebody muted.
//
// Sending the message rather than poking the property is the same preference the rest of this
// repository has: a supported entry point leaves the object's own invariants intact.
import { dm, sendMsg, relocateCmd, split, rejections,
         isLoopbackHost, adminTarget } from './m59-dm.mjs';

export const GENERATION_MSG = 'SetMonsterGeneration';

/** Every controller refuses off a lab before it sends anything. */
export function assertLabCtl(env = process.env) {
  const t = adminTarget(env);
  if (!isLoopbackHost(t.host))
    throw new Error(
      `refusing a lab controller against ${t.host}:${t.port} — these set the world by fiat ` +
      `(stop a room breeding, move a body, raise the dead) and the only place that is a test ` +
      `rather than an incident is a loopback lab server.`);
  return t;
}

/** Resolve one name to its CURRENT object id. Never cached — ids are renumbered around a save. */
export async function objectOf(name, { dmFn = dm, env = process.env } = {}) {
  const cmd = `show name ${name}`;
  const out = await dmFn([cmd], { env });
  const m = /object (\d+)/i.exec(split(out, [cmd])[0] ?? '');
  return m ? Number(m[1]) : null;
}

/** The room's current object. */
/**
 * A room's OBJECT id from its number.
 *
 * `show room <num>` IS NOT A COMMAND ON THIS SERVER. Measured against BlakSton v2.4 (Aug 25 2026)
 * on the lab server: every `show room` is answered `Unknown command; try 'help'.`, so this returned
 * null for EVERY room — including the one the body was standing in — and `setSpawns` reported
 * "room 49 was not found on this server". That message is honest about what it did and wrong about
 * why: the room exists, the query does not.
 *
 * WHAT DOES WORK, verified end to end: `show name <character>` answers `:< object 7252 :>`, and
 * `show object 7252` carries `poOwner = OBJECT 94` — the room object itself — whose own
 * `piRoom_num = INT 52` confirms which room it is. So a body in the room resolves the room, and the
 * room number is checkable rather than assumed.
 *
 * `via` is the character to resolve through. Without it this still tries `show room`, so an older
 * or differently-built server keeps working — but it now says WHICH way failed, because "there is
 * no such room" and "I have no way to ask" are different facts and only one of them is about the
 * world.
 */
export async function roomOf(num, { dmFn = dm, env = process.env, via = null } = {}) {
  const legacy = await dmFn([`show room ${num}`], { env });
  if (!/unknown command/i.test(String(legacy))) {
    const m = /object (\d+)/i.exec(String(legacy));
    if (m) return Number(m[1]);
  }
  if (!via) return null;
  const body = await objectOf(via, { dmFn, env });
  if (body == null) return null;
  const shown = String(await dmFn([`show object ${body}`], { env }));
  const owner = /poOwner\s*=\s*OBJECT\s+(\d+)/i.exec(shown);
  if (!owner) return null;
  const roomObj = Number(owner[1]);
  // VERIFY THE ROOM NUMBER. Resolving through a body is only sound if the body is in the room that
  // was asked about, and a body moves — so this checks rather than trusting the caller.
  const roomShown = String(await dmFn([`show object ${roomObj}`], { env }));
  const rn = /piRoom_num\s*=\s*INT\s+(\d+)/i.exec(roomShown);
  if (rn && Number(rn[1]) !== Number(num)) return null;
  return roomObj;
}

/**
 * Stop (or restart) a room generating monsters.
 *
 * Returns `{ ok, room, object, sent }`. A room that cannot be resolved is a refusal rather than a
 * silent no-op: "I muted the room" and "I could not find the room" must not look the same to a
 * pad that is about to spend twenty minutes walking into it.
 */
export async function setSpawns(roomNum, on, { dmFn = dm, env = process.env, via = null } = {}) {
  assertLabCtl(env);
  // `via` is a character in the room, used to resolve the room object on servers where
  // `show room` is not a command. See roomOf.
  const obj = await roomOf(roomNum, { dmFn, env, via });
  if (obj == null)
    return { ok: false, room: roomNum, object: null, sent: 0,
             why: `room ${roomNum} was not found on this server, so its spawners were NOT ` +
                  `touched — do not read this as "spawns are off"` };
  // sendMsg's parms are { name: [TYPE, value] } — the admin socket's own syntax.
  const cmd = sendMsg(obj, GENERATION_MSG, { bValue: ['INT', on ? 1 : 0] });
  const out = await dmFn([cmd], { env });
  const bad = rejections(out);
  return { ok: bad.length === 0, room: roomNum, object: obj, sent: 1, rejections: bad,
           why: bad.length ? `the server refused: ${bad[0]}` : null };
}

export const spawnsOff = (roomNum, opts) => setSpawns(roomNum, false, opts);
export const spawnsOn = (roomNum, opts) => setSpawns(roomNum, true, opts);

/**
 * Hold everything already in a room still, so a rail is not walked into a wandering body.
 *
 * `ClearBasicTimers` (monster.kod:4281) deletes a monster's own clocks. It does NOT make it
 * inert: reactive handlers fire on events rather than timers (brain.kod:132, :190), so a held
 * monster still answers a body walking into it. Quiet, not frozen in amber — and for a rail that
 * is enough, because what breaks a rail is a monster that MOVES onto it.
 *
 * Takes the names to hold, because a client cannot enumerate a room it is not standing in. A pad
 * that has just looked knows them; this does not pretend to discover them.
 */
export async function holdInRoom(names = [], { dmFn = dm, env = process.env } = {}) {
  assertLabCtl(env);
  const list = [].concat(names).filter(Boolean);
  if (!list.length) return { ok: true, held: [], missing: [], sent: 0 };
  const show = list.map(n => `show name ${n}`);
  const found = split(await dmFn(show, { env }), show);
  const held = [], missing = [], cmds = [];
  list.forEach((n, i) => {
    const m = /object (\d+)/i.exec(found[i] ?? '');
    if (m) { held.push(n); cmds.push(sendMsg(Number(m[1]), 'ClearBasicTimers')); }
    else missing.push(n);
  });
  if (!cmds.length) return { ok: false, held, missing, sent: 0,
                             why: `none of ${list.length} name(s) resolved` };
  const bad = rejections(await dmFn(cmds, { env }));
  return { ok: bad.length === 0, held, missing, sent: cmds.length, rejections: bad };
}

/**
 * Put a character on a square, and say whether it landed there.
 *
 * THE SERVER NEVER SAYS NO. `UtilGoNearSquare` (util.kod:20) searches outward for something
 * standable and returns 1 for a target square of (99,99) in a 24x24 room — so a clean reply means
 * "somebody was moved somewhere", not "moved where you asked". This reads the body back.
 *
 * `--at` is row,col: KOD order. See docs/m59-coordinates.md before arguing with it.
 */
export async function stageAt(name, roomNum, { row, col } = {}, { dmFn = dm, env = process.env, via = null } = {}) {
  assertLabCtl(env);
  if (!Number.isFinite(row) || !Number.isFinite(col))
    throw new Error('stageAt needs { row, col } — and they are row,col in KOD order, not col,row');
  const obj = await objectOf(name, { dmFn, env });
  // The body being staged is itself in the room often enough to resolve it; `via` overrides.
  const room = await roomOf(roomNum, { dmFn, env, via: via ?? name });
  if (obj == null || room == null)
    return { ok: false, landed: null,
             why: `${obj == null ? `character "${name}"` : `room ${roomNum}`} was not found` };
  // relocateCmd, not a hand-rolled message: it is the form m59-dm.mjs already proves against
  // this socket (`send object 0 UtilGoNearSquare what OBJECT .. where OBJECT .. new_row INT ..`),
  // and inventing a second spelling of one command is how two callers drift apart.
  await dmFn([relocateCmd(obj, room, row, col)], { env });

  // READ IT BACK. The whole point.
  const where = `show name ${name}`;
  const out = String(split(await dmFn([where], { env }), [where])[0] ?? '');
  const rc = /row\s+(\d+).*?col\s+(\d+)/is.exec(out) ?? /\((\d+),\s*(\d+)\)/.exec(out);
  const landed = rc ? { row: Number(rc[1]), col: Number(rc[2]) } : null;
  const exact = landed && landed.row === row && landed.col === col;
  return { ok: !!landed, asked: { row, col }, landed, exact,
           why: !landed ? 'could not read the body back, so where it is is unknown'
                : exact ? null
                : `asked for r${row}c${col} and it landed on r${landed.row}c${landed.col} — ` +
                  `UtilGoNearSquare searched outward and found something standable, which is ` +
                  `what it does when the square you named is not`, };
}

/**
 * The whole staging sequence a movement pad wants, in the order that makes it stable.
 *
 * Spawns off FIRST: a room that is still breeding can put a body in the square you are about to
 * move somebody onto, between the clear and the stage.
 */
export async function stageRoom(roomNum, { hold = [], place = null, spawns = 'off',
                                           dmFn = dm, env = process.env } = {}) {
  assertLabCtl(env);
  const steps = [];
  if (spawns === 'off' || spawns === 'on') {
    const r = await setSpawns(roomNum, spawns === 'on', { dmFn, env });
    steps.push({ what: `spawns ${spawns}`, ...r });
    if (!r.ok) return { ok: false, steps, why: r.why };
  }
  if (hold.length) {
    const r = await holdInRoom(hold, { dmFn, env });
    steps.push({ what: `hold ${hold.length}`, ...r });
  }
  if (place) {
    const r = await stageAt(place.name, roomNum, place, { dmFn, env });
    steps.push({ what: `stage ${place.name}`, ...r });
    if (!r.ok) return { ok: false, steps, why: r.why };
  }
  return { ok: steps.every(s => s.ok !== false), steps, why: null };
}

export function formatStaging(r) {
  const out = [r.ok ? 'staged' : `STAGING FAILED — ${r.why ?? 'see below'}`];
  for (const s of r.steps ?? [])
    out.push(`  ${s.ok === false ? 'NO ' : 'ok '} ${s.what}` +
             `${s.exact === false ? `  (landed r${s.landed?.row}c${s.landed?.col}, not what was asked)` : ''}` +
             `${s.why ? `  — ${s.why}` : ''}`);
  return out.join('\n');
}
