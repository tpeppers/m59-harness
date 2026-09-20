#!/usr/bin/env node
// PROVE A SAFE WALL THE WAY A PERSON PROVES ONE: STEP OFF IT AND GET HIT.
//
//   node tools/m59-provewall.mjs --room 575 --at 4,23
//   node tools/m59-provewall.mjs --room 575 --at 4,23 --open 8,23 --seconds 20
//   node tools/m59-provewall.mjs --room 575 --sweep 6        the top fortress squares
//   node tools/m59-provewall.mjs --book                      what has been proven so far
//
// CLI CONTRACT: `--at` and `--open` square pairs are `row,col`
// (KOD/RoomGeometry order).
//
// THE TEST IS A/B/A AND THAT IS THE WHOLE POINT. The recorded safe-spot book asks one
// question — "did anything land while I stood here" — over a single window, and measured
// across the whole book that window has a median of SIXTEEN SECONDS with ONE attacker,
// exactly once per square. A quiet sixteen seconds is something ordinary floor produces
// all the time: the hit chance is bounded to [10,95]% (battler.kod:331), so a handful of
// swings missing is unremarkable. 256 squares were labelled "proven safe wall" on that
// evidence and 114 of them are not even squares the geometry nominates.
//
// This runs the experiment an operator ran by hand and described in one sentence:
//
//     "they can't hit me now, against the safewall. I can cast bait, and if I walk away
//      from the safewall I'm attacked, and returning to the safewall will stop the
//      incoming attacks entirely."
//
//   A  hold the candidate square      expect NO damage
//   B  step to open ground nearby     expect damage
//   A' return to the candidate        expect the damage to STOP
//
// SAME MONSTERS, ALREADY ANGRY, SECONDS APART. That controls for everything one window
// cannot: how many creatures were around, whether they had noticed you, what they were
// doing, the time of day. A square that goes quiet-loud-quiet on demand is not lucky.
// The single-window test cannot distinguish a wall from a coincidence and this can,
// which is why the verdict here is worth more than 256 rows of the old book.
//
// IT MEASURES HEALTH, AND IT MUST BE THE ONLY THING TOUCHING IT. Damage is read as the
// DROP in piHealth across a phase, so anything else topping the character up during a
// run — m59-safewalk's sustain loop, a keeper, a bot — erases the measurement and leaves
// a clean bill of health that means nothing. This detects health going UP mid-phase and
// says so rather than reporting a pass.
//
// LOOPBACK ONLY, by m59-dm.mjs's own guard.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dm, resolve, split, isLoopbackHost, adminTarget, roomObject, relocateCmd,
         clampSquare, heal } from './m59-dm.mjs';
import { RoomGeometry } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { exposureAt } from './m59-safespots.mjs';
import { movementMapFile } from './m59-map-path.mjs';
import { evidenceDirFor } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOK = join(evidenceDirFor(), 'proven-walls.json');

const load = () => { try { return JSON.parse(readFileSync(BOOK, 'utf8')); } catch { return { runs: [] }; } };
const save = b => { mkdirSync(dirname(BOOK), { recursive: true }); writeFileSync(BOOK, JSON.stringify(b, null, 1)); };

// The broker drives the swinging half; the maintenance socket cannot make a character
// attack. Character name -> the agent handle the broker knows it by.
const AGENTS = { TESTER: 't0', Alpha: 'arena1', Bravo: 'arena2', Charlie: 'arena3',
                 Delta: 'arena4', Echo: 'arena5' };
export const agentFor = name => AGENTS[name] ?? name;

export async function broker(name, args, { port = Number(process.env.M59_BROKER_PORT || 8961) } = {}) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                             params: { name, arguments: args } }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) return { _error: `broker answered ${r.status}` };
    const j = await r.json();
    if (j.error) return { _error: j.error.message };
    return JSON.parse(j.result?.content?.[0]?.text ?? '{}');
  } catch (e) { return { _error: e.message }; }
}

/**
 * Read one character's health and square, cheaply.
 *
 * Over the maintenance socket rather than a `look`: this is polled several times a
 * second for a minute at a time, and `show object` is the server reading its own
 * properties rather than a perception call that costs a round trip through the client.
 */
export async function vitalsOf(name) {
  const ids = await resolve([name]);
  if (ids[name] == null) return null;
  const cmd = `show object ${ids[name]}`;
  const b = String(await dm([cmd]));
  const num = re => { const m = re.exec(b); return m ? Number(m[1]) : null; };
  return { id: ids[name], health: num(/piHealth\s+= INT (-?\d+)/),
           maxHealth: num(/piMax_Health\s+= INT (-?\d+)/),
           row: num(/piRow\s+= INT (-?\d+)/), col: num(/piCol\s+= INT (-?\d+)/),
           room: num(/poOwner\s+= OBJECT (\d+)/) };
}

/**
 * Hold a square and count what lands on it.
 *
 * NO HEALING INSIDE A PHASE. Topping up mid-phase would hide exactly the thing being
 * counted, and reading "health is full" would then be a statement about the healer.
 * Between phases is fine and necessary; during one it is the bug.
 *
 * `rose` is the guard: if health goes UP while nothing here is raising it, something
 * else is, and every number in this run is meaningless. Reported rather than swallowed.
 */
// THEY CANNOT SWING AT ALL, WHICH IS A STRONGER CLAIM THAN THEY CANNOT HURT YOU.
//
// The operator's correction, and it makes the test both sharper and cheaper: *"They
// can't SWING at you if you've moved into the safe wall position... so even receiving
// all the 'You dodge the giant rat's attack.' messages is a disqualifying piece of
// data."* That is right, and counting damage was counting the wrong thing:
//
//   * A SWING IS DETERMINISTIC EVIDENCE OF REACH. If it swung, `Monster.CanReach` ->
//     `Room.LineOfSight` (monster.kod:1782) returned true. Whether it then HURT us is a
//     second, independent roll bounded to [10,95]% (battler.kod:331), so zero damage over
//     fifteen seconds is perfectly consistent with a dozen successful reaches.
//   * THERE ARE FAR MORE OF THEM. Every swing is an event; only some are damage. Same
//     window, several times the statistical power — which is what the old book's 16
//     seconds never had.
//   * AND IT IS IMMUNE TO HEALING. Counting messages rather than health means a sustain
//     loop, a keeper, or ordinary regeneration cannot erase the measurement. That was a
//     standing hazard of the damage version and had already invalidated a live run.
//
// CORRECTION, 2026-09-20 — THIS FILE WAS READING HALF THE COMBAT LOG.
//
// It used to say: "`battler.rsc` carries exactly two templates: `%s%s%s %s your attack.` for a
// swing WE made, and `%sYou %s %s%s's attack.` for one made at US." Both of those are the MISS
// lines. There are FOUR, and the hits are separate resources (battler.kod:42-45):
//
//   battler_attacker_hit  = "%sYour %s %s %s%s."        Your scimitar wounds Psychochild.
//   battler_attacker_miss = "%s%s%s %s your attack."    Psychochild blocks your attack.
//   battler_defender_hit  = "%s%s%s %s you with %s %s." Psychochild wounds you with his scimitar.
//   battler_defender_miss = "%sYou %s %s%s's attack."   You block Psychochild's attack.
//
// So the old regex counted every incoming blow that MISSED and dropped every one that LANDED.
// For a test whose entire claim is "nothing can swing at me here", that undercount pointed the
// wrong way: a monster reaching through and CONNECTING is the most disqualifying thing that
// can happen on a candidate square, and it was the one thing not being counted.
//
// The distinction this file was right about — ours versus theirs — is kept. It is now the
// shared module's `isEnemySwing`, which spans both halves and is the same parser every other
// tool in the repo reads fights with. See tools/m59-combatlog.mjs.
import { isEnemySwing } from './m59-combatlog.mjs';
export const isIncomingSwing = text => isEnemySwing(text);

export async function recordingTail(agent, { limit = 400 } = {}) {
  const r = await broker('recording', { agent, action: 'tail', limit });
  return Array.isArray(r?.tail) ? r.tail : [];
}

export async function holdAndCount(name, { seconds = 20, pollMs = 500, agent = null,
                                           onSample = null } = {}) {
  const who = agent ?? agentFor(name);
  const start = await vitalsOf(name);
  if (!start) return { error: `cannot find ${name}` };

  // The recorder is a ring, so the window is bounded by SEQUENCE rather than by time:
  // comparing timestamps would re-count whatever was already in the buffer.
  const before = await recordingTail(who, { limit: 40 });
  const mark = before.length ? Math.max(...before.map(e => e.seq ?? 0)) : 0;

  let last = start.health ?? 0;
  let damage = 0, drops = 0, rose = 0, samples = 0;
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, pollMs));
    const v = await vitalsOf(name);
    if (!v || v.health == null) continue;
    samples++;
    const d = last - v.health;
    if (d > 0) { damage += d; drops++; }
    else if (d < 0) rose++;
    last = v.health;
    onSample?.({ health: v.health, row: v.row, col: v.col, damage });
  }

  const after = await recordingTail(who, { limit: 800 });
  const fresh = after.filter(e => (e.seq ?? 0) > mark && e.kind === 'message');
  const avoided = fresh.filter(e => isIncomingSwing(e.text));
  // EVERY SWING EITHER LANDS OR IS AVOIDED, so this is the whole count: a landed one
  // shows up as a health drop and an avoided one as a message, and neither alone is it.
  const swings = avoided.length + drops;

  return { swings, avoided: avoided.length, damage, drops, rose, samples, seconds,
           examples: avoided.slice(0, 3).map(e => e.text),
           ended: { health: last, row: start.row, col: start.col } };
}

/**
 * An ordinary square to be hit on, near the candidate.
 *
 * MATCHED, NOT ARBITRARY. The B phase has to differ from A in one thing — the wall —
 * so the comparison square must be in the same room, close enough that the same
 * creatures reach it, and genuinely exposed. Picking the most exposed square within a
 * few steps satisfies all three; picking one across the room would be testing whether
 * the monsters can walk.
 */
export function openSquareNear(geometry, { row, col }, { within = 5 } = {}) {
  let best = null;
  for (let dr = -within; dr <= within; dr++)
    for (let dc = -within; dc <= within; dc++) {
      const r = row + dr, c = col + dc;
      if (!geometry.walkable(r, c)) continue;
      if (Math.abs(dr) + Math.abs(dc) < 2) continue;      // not the candidate itself
      let ex = null;
      try { ex = exposureAt(geometry, r, c); } catch { continue; }
      if (!ex) continue;
      const score = ex.attackers ?? 0;
      if (!best || score > best.score) best = { row: r, col: c, score, ex };
    }
  return best;
}

/**
 * The verdict.
 *
 * THE MIDDLE PHASE IS A CONTROL AND A FAILED CONTROL IS NOT A PASS. If nothing hit us on
 * open ground either, then nothing was trying, and the quiet on the wall says nothing at
 * all — that is `inconclusive`, and reporting it as proof is exactly the error the old
 * book made 256 times.
 */
// THE VERDICT IS ABOUT SWINGS, AND A SINGLE SWING DISQUALIFIES.
//
// Not "took little damage" — *"even receiving all the 'You dodge' messages is a
// disqualifying piece of data"*. A safe wall is a claim that nothing can REACH the
// square, so one swing that reached it falsifies the claim regardless of what it rolled.
// That is why there is no tolerance band on A and A'.
export function verdictOf(a, b, c) {
  // Health rising is not evidence of interference any more, because the count no longer
  // rests on health — but a run where MOST samples rose still means another healer is
  // active, and the damage figures in the record would be meaningless. Reported, not
  // fatal: `swings` survives it.
  const topped = [a, b, c].some(p => (p.samples ?? 0) > 4 && (p.rose ?? 0) > (p.samples ?? 0) * 0.5);

  // THE CONTROL FAILING IS NOT A PASS. If nothing swung at us on open ground either then
  // nothing was trying, and the quiet on the wall says nothing at all. Reporting that as
  // proof is precisely the error the old book made 256 times over.
  if ((b.swings ?? 0) <= 0)
    return { verdict: 'inconclusive',
             why: 'nothing swung at us on open ground either — nothing was trying',
             topped };

  const on = (a.swings ?? 0) + (c.swings ?? 0);
  if (on === 0)
    return { verdict: 'PROVEN',
             why: `NOTHING swung on the wall, ${b.swings} swing(s) off it, nothing again on return`,
             topped };
  if (on < (b.swings ?? 0) / 4)
    return { verdict: 'partial',
             why: `${on} swing(s) reached the wall against ${b.swings} off it — better, but reachable`,
             topped };
  return { verdict: 'NOT A WALL',
           why: `${on} swing(s) reached it against ${b.swings} on open ground`,
           topped };
}

// --------------------------------------------------------------------------- cli
if (process.argv[1]?.endsWith('m59-provewall.mjs')) {
  const argv = process.argv.slice(2);
  const has = n => argv.includes('--' + n);
  const flag = (n, d = null) => {
    const at = argv.indexOf('--' + n);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
  };

  if (has('book')) {
    const b = load();
    console.log(`${b.runs.length} run(s) recorded\n`);
    for (const r of b.runs.slice(-40))
      console.log(`  room ${String(r.room).padStart(4)}  ${String(r.row + ',' + r.col).padEnd(8)} ` +
                  `${r.verdict.padEnd(12)}  swings on ${r.on_swings ?? '?'} / off ${r.off_swings ?? '?'} / back ${r.back_swings ?? '?'}` +
                  `   ${new Date(r.at).toISOString().slice(0, 16)}`);
    process.exit(0);
  }

  const target = adminTarget();
  if (!isLoopbackHost(target.host)) {
    console.error(`refusing: ${target.host} is not loopback.`);
    process.exit(2);
  }

  const room = Number(flag('room', 575));
  const who = flag('who', 'TESTER');
  const seconds = Number(flag('seconds', 20));

  const map = JSON.parse(readFileSync(movementMapFile(), 'utf8'));
  const byRoom = new Map();
  attachStepMasks(map, { geometryOf: r => {
    let g = byRoom.get(r); if (!g) { g = RoomGeometry.fromJSON(r.roo); byRoom.set(r, g); } return g; } });
  const geometry = byRoom.get(map.rooms[String(room)]);
  if (!geometry) { console.error(`no geometry for room ${room}`); process.exit(1); }

  // WHICH SQUARES. Either the one named, or the best fortress squares in the room.
  let candidates = [];
  const atArg = flag('at');
  if (atArg) {
    const [r, c] = atArg.split(',').map(Number);
    candidates = [{ row: r, col: c }];
  } else {
    const sweep = Number(flag('sweep', 3));
    for (let r = 1; r <= geometry.rows; r++)
      for (let c = 1; c <= geometry.cols; c++) {
        if (!geometry.walkable(r, c)) continue;
        let ex = null; try { ex = exposureAt(geometry, r, c); } catch { continue; }
        if (ex && ex.attackers === 0 && (ex.free_shots ?? 0) > 0)
          candidates.push({ row: r, col: c, free: ex.free_shots });
      }
    candidates.sort((a, b) => (b.free ?? 0) - (a.free ?? 0));
    candidates = candidates.slice(0, sweep);
  }

  const roomObj = await roomObject(room);
  if (roomObj == null) { console.error(`no room ${room} on this server`); process.exit(1); }

  console.log(`room ${room} — proving ${candidates.length} square(s) with ${who}, ` +
              `${seconds}s per phase\n`);
  console.log('NOTE: stop any sustain loop first. This measures health DROP, and anything');
  console.log('else topping the character up erases the measurement.\n');

  const b = load();
  for (const cand of candidates) {
    const open = flag('open')
      ? (([r, c]) => ({ row: r, col: c }))(flag('open').split(',').map(Number))
      : openSquareNear(geometry, cand);
    if (!open) { console.log(`  ${cand.row},${cand.col}: no open square nearby to compare against`); continue; }

    const ex = (() => { try { return exposureAt(geometry, cand.row, cand.col); } catch { return null; } })();
    console.log(`--- ${cand.row},${cand.col}  (geometry: attackers ${ex?.attackers}, ` +
                `free_shots ${ex?.free_shots})  vs open ${open.row},${open.col} ---`);

    const go = async (r, c) => {
      await dm([relocateCmd((await resolve([who]))[who], roomObj, r, c)]);
      await new Promise(res => setTimeout(res, 1500));   // let it settle before counting
    };

    // BRING THE MONSTERS, AND PUT THEM ON THE OPEN SQUARE.
    //
    // The B phase is the CONTROL and it is the one that can silently fail: if nothing is
    // near enough to swing, B reads zero, the verdict is `inconclusive`, and a run that
    // looks like it tested something tested nothing. Ringing the OPEN square guarantees
    // B is hot — and since the open square is chosen within a few steps of the candidate,
    // the same creatures are also in reach of the wall, which is what makes A and A'
    // meaningful rather than merely distant.
    //
    // Deleted at the end of every candidate, not at the end of the run: leaving them
    // between candidates would let phase B of the next square inherit an unknown number
    // of angry rats, and the count is the measurement.
    const spawnCount = Number(flag('monsters', 6));
    let spawned = [];
    if (spawnCount > 0) {
      const made = await dm(Array.from({ length: spawnCount },
                                       () => `create object ${flag('class', 'GiantRat')}`));
      spawned = [...String(made).matchAll(/Created object (\d+)/g)].map(m => Number(m[1]));
      const ring = spawned.map((_, i) => {
        const a = (2 * Math.PI * i) / spawned.length;
        return clampSquare(Math.round(open.row + 2 * Math.sin(a)),
                           Math.round(open.col + 2 * Math.cos(a)), geometry.rows, geometry.cols);
      });
      await dm(spawned.map((id, i) => relocateCmd(id, roomObj, ring[i].row, ring[i].col)));
      console.log(`   spawned ${spawned.length} around the open square`);
    }
    const despawn = async () => {
      if (spawned.length) await dm(spawned.map(id => `send object ${id} Delete`));
    };

    // BAIT FIRST, AND THIS IS THE STEP THE FIRST RUN WAS MISSING.
    //
    // The operator's own description of the test includes it — *"I can cast bait, and if
    // I walk away from the safewall I'm attacked"* — and without it the first live run
    // came back 0/0/0 and honestly reported `inconclusive`. A monster that has not
    // noticed you is not evidence about a wall; it is evidence that nothing was looking.
    //
    // Provoked from the OPEN square rather than the wall, because the whole claim under
    // test is that things on the wall cannot be reached — including, possibly, by our own
    // aggro. Anger it where it can definitely see us, then go and stand behind the wall.
    // BAIT IS THE RIGHT PRIMITIVE AND SWINGING WAS NOT.
    //
    // `Bait.CastSpell` (spell/bait.kod:67) walks every active monster in the ROOM and
    // does `TargetSwitch #iHatred=100` then `EnterStateChase #actnow=True` on each — it
    // makes the whole room angry at the caster, which is exactly the precondition this
    // test needs and is what the operator meant by "I can cast bait". Swinging at one
    // rat angers one rat, and the first live run came back 0/0/0 because of it.
    //
    // CAST FROM THE OPEN SQUARE, NOT THE WALL. The claim under test is that nothing on
    // the wall can be reached; if the aggro itself only works from open ground that is
    // part of the same fact, and casting from the wall would confound the two.
    //
    // 25% BASE PER MONSTER PER CAST (`iBaseChance = 25`, modified by spell power), so it
    // is cast several times rather than once — a single cast leaves most of the room
    // uninterested and turns the control phase into another silent no-op.
    const baitCasts = Number(flag('baits', 4));
    const provoke = async () => {
      await go(open.row, open.col);
      for (let i = 0; i < baitCasts; i++) {
        const r = await broker('cast', { agent: agentFor(who), spell: 'bait' });
        if (r?._error) { console.log(`   bait failed: ${r._error}`); break; }
        if (r?.cast === false || r?.declined)
          console.log(`   bait declined: ${r.why ?? r.reason ?? JSON.stringify(r).slice(0, 120)}`);
        await new Promise(res => setTimeout(res, 900));
      }
      await new Promise(res => setTimeout(res, 1200));   // let them close
    };
    await provoke();

    await heal([who]);
    await go(cand.row, cand.col);
    const A = await holdAndCount(who, { seconds });
    console.log(`   A  on the wall   : ${A.swings} swing(s) reached us` +
                (A.examples?.length ? `   e.g. "${A.examples[0]}"` : ''));

    await heal([who]);
    await go(open.row, open.col);
    const B = await holdAndCount(who, { seconds });
    console.log(`   B  open ground   : ${B.swings} swing(s) reached us` +
                (B.examples?.length ? `   e.g. "${B.examples[0]}"` : ''));

    await heal([who]);
    await go(cand.row, cand.col);
    const C = await holdAndCount(who, { seconds });
    console.log(`   A' back on wall  : ${C.swings} swing(s) reached us` +
                (C.examples?.length ? `   e.g. "${C.examples[0]}"` : ''));

    await despawn();

    const v = verdictOf(A, B, C);
    console.log(`   => ${v.verdict}: ${v.why}\n`);

    b.runs.push({ at: Date.now(), room, row: cand.row, col: cand.col,
                  open: { row: open.row, col: open.col }, seconds,
                  on_swings: A.swings, off_swings: B.swings, back_swings: C.swings,
                  on_damage: A.damage, off_damage: B.damage, back_damage: C.damage,
                  attackers: ex?.attackers ?? null, free_shots: ex?.free_shots ?? null,
                  verdict: v.verdict, why: v.why });
    save(b);
  }
  console.log(`recorded in ${BOOK}`);
}
