// KILL THE GHOST OF FAR'NOHL, THEN HOLD THE THRONE ROOM AND FARM ITS ESCORT FOR HALF AN HOUR.
//
// THE CYCLE (operator, 2026-09-25). With camp_next the run is one ghost cycle long: first kill ->
// one spawn square open (valve_before_spawn) until the ghost is SEEN respawning -> reblock, kill it,
// start the countdown to the next (108-132 min, GHOST_CYCLE_S) -> the valve may open wide ->
// at `prep_close_min` after that spawn every square is shut, the room is cleared, and the fleet
// rests and re-buffs for the next ghost.
//
// `prep_close_min` IS A MEASUREMENT OF THIS FLEET, NOT A CONSTANT. Each prep phase logs how long
// the fleet took to be ready (valve shut -> room empty, everyone >= prep_ready_health) and by how
// much it beat the ghost, to substrate/raids/prep-lead.jsonl with the fleet, its size and the SHA.
// `node tools/m59-raidtimes.mjs --prep-lead` turns those into a recommended close time, and this
// script uses that recommendation when one exists (else 95 min). A different fleet — fewer raiders,
// weaker, lighter armour — re-derives it the same way, on the shadow fleet, before it matters.
//
//   node tools/m59-ghostraid.mjs fight --fleet shadow --lab
//   node tools/m59-ghostraid.mjs fight --fleet prod
//
// Phase three of `m59-ghostraid.mjs` (arm, prep, FIGHT). It is `raid-action.mjs` for the raiders
// and the healers — the same approach, first-contact probe and melee loop that took the two
// clean kills in docs/m59-raid-farnohl.md — with three things that script did not have:
//
// 1. EVERYBODY GOES IN TOGETHER. raid-action walks each raider in on its own clock. The escort
//    clock starts with the FIRST body through the door (throne1.kod FirstUserEntered), and one
//    skeleton follows every ~12s, so a raid that trickles in over ninety seconds hands the room
//    seven free skeletons. Here every raider stops in room 38 and a barrier opens the door for
//    all of them at once. Bounded: a wedged character does not hold the raid for ever.
//
// 2. THE LIGHT-BEARER DOES NOT STAND IN THE ROOM. The ghost is AI_FIGHT_WIZARD_KILLER and the
//    only character on prod with forces of light has TWENTY maximum health. Forces of light is a
//    ROOM enchantment — a timer on the room (forceslt.kod RoomStartEnchantment), cast with no
//    trance — so it outlives its caster leaving. The light-bearer walks in behind the raiders,
//    casts, walks back out to 38, and returns before it lapses: on a timer, and at once when a
//    raider inside hears "The spirit of Shal'ille departs from this place." A cast into a room
//    that is still lit is refused FREE ("already infused", CanPayCosts), so arriving early costs
//    one packet.
//
// 3. IT DOES NOT LEAVE WHEN THE BOSS DIES. The throne room generates a tusked skeleton (80%) or
//    a zombie (20%) about every twelve seconds while anyone is in it, to a cap of nine
//    (throne1.kod plMonsters, docs/m59-raid-farnohl.md). A TuskedSkeleton is level 100 and
//    Skeleton-family — it takes -20 from a hammer (skel.kod:75-82) — and it is the farm. Every
//    raider keeps fighting for `minutes` after the kill, breaking off to room 38 to heal below
//    `retreat_at` and walking back in above `return_at`. The keeper still owns survival on top of
//    all of it (docs/m59-boundary.md): a raid is not an errand, and nothing here disarms the
//    ladder.
//
// WHAT IT WRITES, for `m59-ghostraid.mjs report`: `run_dir/samples.jsonl` (every raider's room and
// health every `sample_s`), and `run_dir/events.jsonl` (entry, ghost seen, ghost gone, light cast,
// retreat, return, death, kill). The report reads THOSE plus the fleet's own `died`/`killed`
// ledger — never a tally this script kept in memory, which dies with the process.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTFIT_RUN } from './ghost-outfit.mjs';
import { verify, walk, call, castVerified, observe, assertLabFleet } from '../m59-fleetscript.mjs';
import { script as raidAction } from './raid-action.mjs';
import { GHOST_ROOM as DEFAULT_BOSS_ROOM, DOOR_ROOM as DEFAULT_DOOR_ROOM, STAGE_ROOM, LIGHT, BLESS, HEAL, STRENGTH, assignRoles, blessAssignments,
         buddyAssignments, expect, barrier, leave, isWeaponName, spawnBlockers, THRONE_GENERATORS,
         nextGhostWindow, valveStep }
  from '../m59-ghostraid-lib.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const HAZARD = 'Ghost of Far\'Nohl raid: a whole fleet with dedicated hammers, healers and forces of light';

// ---- one run's shared state
const RUN = {
  dir: null, startAt: null, killAt: null, ghostSeen: false,
  light: { lastCast: 0, expired: false, casts: 0, ready: false },
  // THE BOSS'S ROOMS, per run: the raid is written for the ghost of Far'Nohl (40 off 38) but
  // nothing in it is specific to those numbers — `room=` and `door=` retarget it.
  room: DEFAULT_BOSS_ROOM, door: DEFAULT_DOOR_ROOM,
  sampler: null, samplerStop: false, done: new Set(), agents: [],
  saved: new Map(), restored: new Set(), focus: null, geared: new Set(), checkpoint: null,
  // The ghost's clock and the spawn valve (see m59-ghostraid-lib GHOST_CYCLE_S, valveStep).
  ghostAlive: false, spawns: [], kills: [], nextWindow: null,
  valve: { open: 0, armed: false, changedAt: 0 }, valveLeader: null, valveAt: 0, blockerCount: 0,
};
const endAt = p => {
  // CAMPING FOR THE NEXT GHOST (camp_next): stay until the predicted window has passed, plus a margin
  // to fight it, capped at camp_max_min after the first kill. With no spawn seen the phase is
  // unknown, and the cap (>= 132 min) is long enough to see one.
  if (RUN.killAt && (p.camp_next === true || p.camp_next === 'true')) {
    const cap = RUN.killAt + Number(p.camp_max_min) * 60_000;
    const want = RUN.nextWindow ? RUN.nextWindow.hi + 15 * 60_000 : cap;
    return Math.min(cap, Math.max(RUN.killAt + Number(p.minutes) * 60_000, want));
  }
  if (RUN.killAt) return RUN.killAt + Number(p.minutes) * 60_000;
  if (RUN.startAt) return RUN.startAt + Number(p.fight_limit_s) * 1000 + Number(p.minutes) * 60_000;
  return Date.now() + 3600_000;
};

/**
 * SAVE THE WORLD, SO THE BATTLE CAN BE PLAYED AGAIN FROM HERE. Loopback only: the maintenance port
 * on this machine is the SHADOW server's, and a prod raid must never mistake it for prod's world.
 * Uses m59-shutdown --checkpoint (a `save game`, archived under the savegame's checkpoints/).
 * Replaying: stop the shadow server, `m59-shutdown --restore <name>`, start it, log the fleet in,
 * then `m59-ghostraid fight --fleet shadow --commit` — the fight phase alone.
 */
async function takeCheckpoint(label) {
  try {
    const dm = await import('../m59-dm.mjs');
    if (!dm.isLoopbackHost?.(process.env.M59_HOST ?? '127.0.0.1')) return { ok: false, why: 'not a loopback server' };
    const { spawnSync } = await import('node:child_process');
    const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'm59-shutdown.mjs');
    const r = spawnSync(process.execPath, [tool, '--checkpoint', '--label', label], {
      encoding: 'utf8', env: { ...process.env, M59_ADMIN_PORT: process.env.M59_ADMIN_PORT ?? '19998' }, timeout: 120_000 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const name = /done\s*\S+\s*(\S+-checkpoint)/.exec(out)?.[1] ?? null;
    const res = { ok: !!name, name, at: Date.now(), label,
                  replay: name ? [`node tools/m59-shutdown.mjs --restore ${name}   (with the shadow server stopped)`,
                                  'start the shadow server, log the shadow fleet in',
                                  'node tools/m59-ghostraid.mjs fight --fleet shadow --commit'] : null,
                  ...(name ? {} : { why: out.trim().split('\n').slice(-3).join(' | ').slice(0, 300) || `exit ${r.status}` }) };
    if (RUN.dir) try { fs.writeFileSync(path.join(RUN.dir, 'checkpoint.json'), JSON.stringify(res, null, 1)); } catch {}
    return res;
  } catch (e) { return { ok: false, why: e.message }; }
}

function event(kind, data = {}) {
  // INCIDENTS the valve answers to: a death, a retreat (low health) or a raider leaving the room.
  if (kind === 'died' || kind === 'retreat' || kind === 'left') RUN.incidents = (RUN.incidents ?? 0) + 1;
  if (!RUN.dir) return;
  try { fs.appendFileSync(path.join(RUN.dir, 'events.jsonl'), JSON.stringify({ t: Date.now(), kind, ...data }) + '\n'); }
  catch { /* a lost event line must never stop a fight */ }
}

function ghostGone(by) {
  if (RUN.killAt && RUN.ghostAlive) {
    // A LATER GHOST (a respawn the fleet fought) is gone too: counted, and the valve may reopen.
    RUN.ghostAlive = false; RUN.kills.push(Date.now());
    event('ghost_gone', { by, n: RUN.kills.length });
    console.log(`  *** ghost #${RUN.kills.length} is gone (seen by ${by})`);
    return;
  }
  if (RUN.killAt || !RUN.ghostSeen) return;
  RUN.killAt = Date.now(); RUN.ghostAlive = false; RUN.kills.push(RUN.killAt);
  event('ghost_gone', { by, after_s: RUN.startAt ? Math.round((RUN.killAt - RUN.startAt) / 1000) : null });
  console.log(`  *** the ghost is gone (seen by ${by}) — farming for the window`);
}

/** Every `sample_s`, every raider's room and health. One loop for the run, started at entry. */
function startSampler(p) {
  if (RUN.sampler) return;
  RUN.sampler = (async () => {
    while (!RUN.samplerStop && Date.now() < endAt(p) + 60_000) {
      const f = await call('fleet', {}, 40_000).catch(() => null);
      const t = Date.now();
      const rows = (f?.fleet ?? []).filter(r => RUN.agents.includes(r.agent)).map(r => {
        const [hp, max] = String(r.health ?? '').split('/').map(Number);
        return { t, agent: r.agent, character: r.character, room_num: r.room_num ?? null,
                 hp: Number.isFinite(hp) ? hp : null, max: Number.isFinite(max) ? max : null };
      });
      // WHAT IS IN THE ROOM, by name — from a raider's own look, so it works on prod too. This is
      // the measurement that says whether sparing zombies moves the room towards them.
      const inside = rows.find(r => Number(r.room_num) === RUN.room && r.hp > 0);
      if (inside && RUN.dir) {
        const look = await call('look', { agent: inside.agent }, 20_000).catch(() => null);
        const count = {};
        for (const o of look?.objects ?? [])
          if ((o.can ?? []).includes('attack') && !o.is_player) count[o.name] = (count[o.name] ?? 0) + 1;
        try { fs.appendFileSync(path.join(RUN.dir, 'events.jsonl'), JSON.stringify({ t, kind: 'room', count }) + '\n'); } catch {}
      }
      if (RUN.dir && rows.length)
        try { fs.appendFileSync(path.join(RUN.dir, 'samples.jsonl'), rows.map(x => JSON.stringify(x)).join('\n') + '\n'); } catch {}
      await sleep(Number(p.sample_s) * 1000);
    }
  })();
}

// ONE fleet read shared by every agent, three seconds fresh. Twenty-one medics each asking the
// broker "who is hurt" every loop is the self-inflicted load raid-action.mjs documents
// (`fetch failed` on ten of twenty-one agents); a shared snapshot is the fix it used too.
let FLEET = { at: 0, rows: [], inFlight: null };
async function fleetNow() {
  if (Date.now() - FLEET.at < 3000) return FLEET.rows;
  if (FLEET.inFlight) return FLEET.inFlight;
  FLEET.inFlight = (async () => {
    const f = await call('fleet', {}, 40_000).catch(() => null);
    const rows = (f?.fleet ?? []).map(r => {
      const [h, m] = String(r.health ?? '').split('/').map(Number);
      return { agent: r.agent, who: r.character, room: Number(r.room_num), h, m, frac: m ? h / m : null };
    });
    FLEET = { at: Date.now(), rows: rows.length ? rows : FLEET.rows, inFlight: null };
    return FLEET.rows;
  })();
  return FLEET.inFlight;
}

// A SPELL TARGET IS AN OBJECT ID, NEVER A NAME. The caster's own name does not resolve at all
// ("nothing here matches"), and on the second rehearsal every bless and super strength cast at
// the door by name came back `nothing_happened` with the mana untouched. The broker's /health
// publishes every session's current object id; ids are renumbered on every server save, so
// this is read fresh (ten seconds at most) and never stored across a run.
let IDS = { at: 0, map: {} };
async function objectIdOf(agent) {
  if (Date.now() - IDS.at > 10_000) {
    try {
      const h = await (await fetch(new URL('health', process.env.M59_CONTROL_URL ?? 'http://127.0.0.1:8901/'),
                                   { signal: AbortSignal.timeout(10_000) })).json();
      IDS = { at: Date.now(), map: h?.session_object_ids ?? IDS.map };
    } catch { /* keep the last answer; a stale id is refused by the server, not misapplied */ }
  }
  const id = IDS.map[agent];
  return Number.isFinite(Number(id)) ? Number(id) : null;
}

/** Enough mana for `need`? Lab: refill (at the door only). Prod: wait, bounded. */
async function manaFor(agent, need, { p, patient }) {
  const mana = async () => Number((await call('status', { agent, brief: true }, 30_000).catch(() => null))?.mana?.value ?? 0);
  let m = await mana();
  if (m >= need) return true;
  if (!patient) return false;                       // mid-fight: skip, never wait
  if (p.lab === true || p.lab === 'true') {
    assertLabFleet('ghost-raid: refilling mana at the door');
    const dm = await import('../m59-dm.mjs');
    const me = (await fleetNow()).find(r => r.agent === agent)?.who;
    if (me) await dm.heal([me]);
    await sleep(1200);
    return (await mana()) >= need;
  }
  const until = Date.now() + Number(p.door_mana_wait_s) * 1000;
  await call('rest', { agent }, 30_000).catch(() => {});
  while (m < need && Date.now() < until) { await sleep(8000); m = await mana(); }
  await call('rest', { agent, stand: true }, 30_000).catch(() => {});
  return m >= need;
}

/**
 * Cast this agent's share of the buffs: bless on its share of the fleet, super strength on
 * itself and its one buddy. Only on targets standing in `where` — a personal enchantment
 * resolves its target by name against the ROOM. "Already blessed" is refused free and counts
 * as up. Returns a tally.
 */
async function buffShare({ agent, duty, p, where, patient }) {
  const tally = { bless: 0, strength: 0, already: 0, failed: 0, skipped: 0, why: {} };
  const rows = await fleetNow();
  const here = new Map(rows.filter(r => r.room === Number(where)).map(r => [r.agent, r.who]));
  const jobs = [...duty.strength.map(a => [STRENGTH, a]), ...duty.bless.map(a => [BLESS, a])];
  for (const [buff, target] of jobs) {
    const who = here.get(target);
    const oid = await objectIdOf(target);
    if (!who || oid == null) { tally.skipped++; continue; }
    if (!(await manaFor(agent, buff.mana, { p, patient }))) { tally.skipped++; continue; }
    await call('rest', { agent, stand: true }, 30_000).catch(() => {});
    const r = await castVerified(agent, buff.spell, { target: oid, cost: buff.mana });
    if (r.landed) tally[buff === BLESS ? 'bless' : 'strength']++;
    else if (r.in_effect) tally.already++;
    else {
      tally.failed++;
      // WHY, not just how many: the first rehearsal logged 18 failures at the door and no
      // reason for any of them, which is a count nobody can act on.
      const k = `${buff.spell}: ${r.outcome ?? 'unclassified'}${r.why ? ` (${String(r.why).slice(0, 50)})` : ''}`;
      tally.why[k] = (tally.why[k] ?? 0) + 1;
    }
  }
  if (jobs.length) {
    event('buffs', { agent, where, ...tally });
    console.log(`  ${String(agent).padEnd(9)} buffs in ${where}: bless=${tally.bless} strength=${tally.strength} ` +
                `already=${tally.already} failed=${tally.failed} skipped=${tally.skipped}` +
                (tally.failed ? `  why ${JSON.stringify(tally.why)}` : ''));
  }
  return tally;
}

/** A medic's turn: heal the worst-hurt fleetmate in the room under `below`, if any. */
async function medicTick(agent, below) {
  const rows = await fleetNow();
  const me = rows.find(r => r.agent === agent);
  const hurt = rows.filter(r => RUN.agents.includes(r.agent) && r.room === RUN.room && r.room === me?.room
                                && r.frac != null && r.frac < below)
    .sort((a, b) => a.frac - b.frac)[0];
  if (!hurt) return null;
  if (!(await manaFor(agent, HEAL.mana, { patient: false }))) return null;
  await call('rest', { agent, stand: true }, 30_000).catch(() => {});
  const oid = await objectIdOf(hurt.agent);
  if (oid == null) return null;
  let r = await castVerified(agent, HEAL.spell, { target: oid, cost: HEAL.mana });
  // OUT OF RANGE IS A WALK, NOT A FAILURE. The third rehearsal's healers stood at the back of a
  // 23-row room and were refused "the target was out of range" for fleetmates at the far end.
  // Find the target where it stands, step next to it, and cast once more.
  if (!r.landed && r.outcome === 'out_of_range') {
    const look = await call('look', { agent }, 40_000).catch(() => null);
    const t = (look?.objects ?? []).find(o => o.is_player && String(o.name ?? '').toLowerCase() === String(hurt.who).toLowerCase());
    if (t?.col != null) {
      await call('walk_to', { agent, col: t.col, row: t.row + 1 }, 60_000).catch(() => {});
      await call('rest', { agent, stand: true }, 30_000).catch(() => {});
      r = await castVerified(agent, HEAL.spell, { target: oid, cost: HEAL.mana });
    }
  }
  FLEET.at = 0;                                     // the picture just changed
  if (!r.landed) event('heal_failed', { agent, on: hurt.who, outcome: r.outcome ?? null, why: String(r.why ?? '').slice(0, 80) });
  return { on: hurt.who, at: Number(hurt.frac.toFixed(2)), landed: r.landed, outcome: r.outcome };
}

// THE SETTINGS THIS RAID CHANGES, and nothing else. Read from the keeper's live policy, written
// to run_dir before anything is changed, so a run that dies can still be put back
// (`m59-ghostraid.mjs restore --run <dir>`).
export const POSTURE_KEYS = [['threatCeiling', 'threat_ceiling'], ['fleeBelow', 'flee_below'], ['restBelow', 'rest_below']];
async function raidPosture(agent, p) {
  const st = await call('autopilot', { agent, action: 'status' }, 40_000).catch(() => null);
  const pol = st?.policy ?? null;
  if (!pol) { console.log(`  !! ${agent}: policy unreadable, raid posture NOT applied`); return { applied: false }; }
  const saved = {};
  for (const [camel, snake] of POSTURE_KEYS) if (pol[camel] !== undefined) saved[snake] = pol[camel];
  RUN.saved.set(agent, saved);
  if (RUN.dir) try { fs.writeFileSync(path.join(RUN.dir, 'policy-snapshot.json'), JSON.stringify(Object.fromEntries(RUN.saved), null, 1)); } catch {}
  const r = await call('autopilot', { agent, action: 'start',
    threat_ceiling: { mode: 'flat', value: Number(p.raid_threat_ceiling) },
    flee_below: Number(p.raid_flee_below), rest_below: Number(p.raid_rest_below) }, 40_000).catch(e => ({ error: e.message }));
  if (r?.error) console.log(`  !! ${agent}: raid posture refused: ${r.error}`);
  return { applied: !r?.error, saved };
}
async function restorePosture(agent) {
  const saved = RUN.saved.get(agent);
  if (!saved || RUN.restored.has(agent)) return;
  const r = await call('autopilot', { agent, action: 'start', ...saved }, 40_000).catch(e => ({ error: e.message }));
  if (r?.error) console.log(`  !! ${agent}: could not restore its own settings: ${r.error} — run \`m59-ghostraid.mjs restore\``);
  else RUN.restored.add(agent);
}
/**
 * LEAVE BEFORE LETTING GO. A released keeper finishes whatever journey was last registered, and
 * on the first rehearsal that walked Loial back INTO the throne room after his loop ended, where
 * he died. So every role ends by walking to the stage room, then its settings are put back.
 */
async function windDown(agent, p) {
  // WITH THE DUM RAID PROFILE ON, DUM OWNS THE WAY OUT. It snapshotted this character's normal
  // settings before the raid and restores them on `off`; it also holds the raider inside the
  // throne room until then. Walking it out and restoring here would be two owners of one body.
  if (p.dum_profile === true || p.dum_profile === 'true') return;
  const o = await observe(agent);
  if (!o.dead && Number(o.room) !== Number(p.stage)) await hop(agent, Number(p.stage));
  await restorePosture(agent);
}

/**
 * RETREAT TO A WALL IN THE ROOM, NOT OUT OF IT. Operator, 2026-09-24: "raiders [should] not
 * leave the throne room voluntarily (it's unsafe outside, too)". The keeper's own safe-spot
 * finder names two squares in room 40 that nothing can swing at — r1c1 and r1c9, the ledge
 * corners by the entrance (can_reach_you 0 of 28) — so a hurt raider walks to the nearer one,
 * sits until return_at, and goes back to the fight from inside the room. Asked of the keeper
 * each time rather than hard-coded: it reads the room's real geometry and the live book.
 * Falls back to the door only when the room offers nothing.
 */
async function retreatInRoom(agent, p) {
  const r = await call('safe_spots', { agent }, 40_000).catch(() => null);
  const spot = (r?.spots ?? []).filter(x => (x.can_reach_you ?? 99) === 0)
    .sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0];
  if (!spot) { await hop(agent, RUN.door); return { to: 'door' }; }
  await call('walk_to', { agent, col: spot.col, row: spot.row }, 60_000).catch(() => {});
  await restUntil(agent, Number(p.return_at), p);
  return { to: `r${spot.row}c${spot.col}` };
}

/**
 * SPARE THE ZOMBIES, FOCUS THE SKELETONS. Operator, 2026-09-24: "is it really the case that 21
 * attackers can't kill 10 defenders ... Perhaps intentionally leaving Zombies alive and only
 * killing some of the skeletons would help decrease the incoming damage?"
 *
 * The arithmetic says yes (monster.kod GetMaxHitPoints / GetDamage / GetOffense, speeds from
 * blakston.khd): a tusked skeleton is 120 hp, 7-10 a hit, to-hit 660, speed 16; a zombie is 66 hp,
 * 4-5 a hit, to-hit 405, speed 4 — perhaps a fifth of the incoming damage. The room refills to a
 * cap of TEN MONSTERS OF ANY KIND, 80% tusked / 20% zombie (throne1.kod plMonsters). So a zombie
 * nobody kills is a slot a tusked skeleton cannot have, and killing only skeletons walks the room
 * towards all-zombie.
 *
 * And FOCUS: the third hold dealt ~1,400 damage in 30 minutes, spread over whatever each raider
 * happened to be nearest. One shared target at a time turns ten raiders' blows into one kill.
 */
function pickFocus(others, p) {
  const spare = String(p.spare ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const fair = others.filter(o => !spare.some(w => String(o.name ?? '').toLowerCase().includes(w)));
  if (!fair.length) return null;
  const f = RUN.focus && fair.find(o => o.id === RUN.focus.id);
  if (f) return f;
  const next = fair[0];                                    // nearest to whoever chose it
  RUN.focus = { id: next.id, name: next.name, since: Date.now() };
  return next;
}

/** Find the ghost (and everything else attackable) from where this agent stands. */
async function lookAround(agent, target) {
  const look = await call('look', { agent }, 40_000).catch(() => null);
  const attackable = (look?.objects ?? []).filter(o => (o.can ?? []).includes('attack') && !o.is_player);
  const re = new RegExp(target, 'i');
  const ghost = attackable.find(o => re.test(o.name ?? '')) ?? null;
  const others = attackable.filter(o => !re.test(o.name ?? ''))
    .sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99));
  if (ghost && Number(look?.room?.num ?? look?.room) === RUN.room) {
    if (!RUN.ghostSeen) RUN.ghostAlive = true;
    else if (RUN.killAt && !RUN.ghostAlive) {
      // SEEN SPAWNING: the ghost's timer phase is now known, and with it the next window.
      RUN.ghostAlive = true;
      const t = Date.now();
      RUN.spawns.push(t);
      RUN.nextWindow = nextGhostWindow(t);
      RUN.valve = { ...RUN.valve, open: 0, changedAt: t, why: 'the ghost is back' };
      event('ghost_spawn', { seen_by: agent, next_lo: RUN.nextWindow.lo, next_hi: RUN.nextWindow.hi });
      if (RUN.prep) {
        const ep = { t, fleet: process.env.M59_FLEET ?? null, raiders: RUN.agents.length, closed_at: RUN.prep.closedAt,
                     ready_at: RUN.prep.readyAt, lead_ms: RUN.prep.readyAt ? RUN.prep.readyAt - RUN.prep.closedAt : null,
                     margin_ms: RUN.prep.readyAt ? t - RUN.prep.readyAt : null, closed_min_after_spawn: RUN.spawns.length > 1
                       ? Math.round((RUN.prep.closedAt - RUN.spawns[RUN.spawns.length - 2]) / 60_000) : null,
                     run: RUN.dir ? path.basename(RUN.dir) : null };
        event('prep_episode', ep);
        try { fs.appendFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'substrate', 'raids', 'prep-lead.jsonl'), JSON.stringify(ep) + String.fromCharCode(10)); } catch {}
        console.log(`  prep episode: ready ${ep.lead_ms != null ? Math.round(ep.lead_ms / 60_000) + ' min after closing, ' + Math.round(ep.margin_ms / 60_000) + ' min before the ghost' : 'NOT READY when the ghost came'}`);
        RUN.prep = null;
      }
      console.log(`  *** the ghost has SPAWNED (seen by ${agent}); the next one is due between ` +
                  `${new Date(RUN.nextWindow.lo).toISOString().slice(11, 16)} and ${new Date(RUN.nextWindow.hi).toISOString().slice(11, 16)} UTC`);
    }
  }
  return { ghost, others, room: look?.room ?? null };
}

/**
 * DEAD MEANS DEAD TWICE. `observe().dead` is true on a health reading of 0 or an Underworld
 * room name, and a single status read mid-hop can return either transiently. On the first
 * shadow rehearsal (2026-09-24) one such read ended the light-bearer's whole loop ninety
 * seconds in, before his first cast, while he stood alive in room 38 at 13/20.
 */
async function confirmedDead(agent) {
  const a = await observe(agent);
  if (!a.dead) return false;
  await sleep(3000);
  return (await observe(agent)).dead;
}

/** One hop between adjacent rooms, read back. The keeper may be holding a job: retry briefly. */
async function hop(agent, to, { tries = 3 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    // health_floor 0, ALWAYS. Omitted, the broker applies the character's own
    // travel_start_health — FULL health by default — and refuses the journey in silence. On the
    // second rehearsal that stopped the light-bearer (14/20) re-entering to relight, and every
    // raider who rested to 85% from walking back in: returns=0 across the board. These hops are
    // two rooms inside a castle, the script has already decided the body is fit (return_at),
    // and a RETREAT refused for being hurt is the worst refusal there is.
    // CLEAR WHATEVER JOURNEY IS STILL REGISTERED FIRST — the hop that brought us in is the usual
    // one — or this travel is refused "busy" and the loop below waits out 75 s standing still.
    // On the 2026-09-25 rehearsal the light-bearer cast, could not get out, and was killed in the
    // throne room 35 s later.
    await call('cancel_movement', { agent, why: `hop to ${to}` }, 30_000).catch(() => {});
    const r = await call('travel', { agent, to, background: true, run_errands: false, health_floor: 0,
                                     ...(to === RUN.room ? { despite_hazard: { reason: HAZARD } } : {}) }, 60_000)
      .catch(e => ({ error: e.message }));
    // A REFUSED TRAVEL IS RETRIED AT ONCE, not after 75 seconds of standing in place.
    const refused = r?.started === false || r?.error || /busy|refus/i.test(String(r?.reason ?? r?.why ?? ''));
    const until = Date.now() + (refused ? 4_000 : 75_000);
    while (Date.now() < until) {
      const o = await observe(agent);
      if (o.dead && await confirmedDead(agent)) return { ok: false, dead: true };
      if (Number(o.room) === Number(to)) return { ok: true };
      await sleep(1500);
    }
    last = r;
    // KEEP TRYING WHATEVER THE REFUSAL SAID. This used to give up on anything but "busy", and
    // the second rehearsal's light-bearer then failed to cross 38 -> 40 three times running
    // while the keeper logged "entering a hazard room on purpose" each time: the door off 38 is
    // one square wide and sixteen raiders stood around it. Patience is cheap; a dark room is not.
    await sleep(3000);
  }
  const o = await observe(agent);
  return { ok: Number(o.room) === Number(to), room: o.room,
           reply: String(last?.error ?? last?.why ?? last?.reason ?? '').slice(0, 120) || null };
}

/** Sit until healthy enough, or until the window ends. The keeper sits people too; stand after. */
async function restUntil(agent, frac, p) {
  await call('rest', { agent }, 30_000).catch(() => {});
  while (Date.now() < endAt(p)) {
    const o = await observe(agent);
    if (o.dead || (o.health ?? 0) >= frac) break;
    await sleep(5000);
  }
  await call('rest', { agent, stand: true }, 30_000).catch(() => {});
}

export const script = {
  name: 'ghost-raid',
  describe: 'Everyone in together; forces of light cast from the door; kill the ghost; farm the escort for 30 min.',
  provenance: { pinned: '039a61e', verified: '2026-09-23',
                touches: ['tools/fleetscripts/raid-action.mjs', 'tools/m59-fleetscript.mjs', 'tools/m59-ghostraid-lib.mjs'] },
  recipe: {
    effect: 'The ghost of Far\'Nohl dead, then `minutes` of the fleet holding room 40 against its ' +
            'escort, with every raider\'s health sampled and every death on the ledger.',
    run: 'node tools/m59-ghostraid.mjs fight --fleet <fleet> [--lab]',
    needs: ['ghost-arm first (dedicated hammers)', 'a light-bearer with forces of light and reagents',
            'the throne room EMPTY of players, so it starts cold'],
    cost: { risk: 'room 40 is a declared hazard: tusked skeletons are level 100' },
  },
  params: {
    valve_before_spawn: { type: 'number', default: 1, describe: 'spawn squares the valve may open before a ghost respawn has been seen (the phase unknown)' },
    prep_close_min: { type: 'string', default: 'auto', describe: 'minutes after a seen spawn to shut the valve and prepare for the next ghost; auto = the fleet\'s measured recommendation (m59-raidtimes --prep-lead), else 95' },
    prep_ready_health: { type: 'number', default: 0.9, describe: 'prep counts as READY when the room is empty and everyone in it is at this fraction of health' },
    valve: { type: 'boolean', default: true, describe: 'after the kill, open spawn squares one at a time to farm what the room makes (needs spawn_block)' },
    valve_start: { type: 'number', default: 0.5, describe: 'the valve arms, and opens, only with everyone in the room at this fraction of health or better' },
    valve_close_below: { type: 'number', default: 0.35, describe: 'close a square when anyone in the room falls under this' },
    valve_dwell_s: { type: 'number', default: 180, describe: 'a level must be held this long (x level+1) without incident before the next square opens' },
    valve_easy_health: { type: 'number', default: 0.6, describe: 'a level counts as EASY only if nobody in the room fell under this during its dwell' },
    valve_max: { type: 'number', default: 5, describe: 'the most spawn squares the valve opens; 6 (all) is a deliberate choice' },
    camp_next: { type: 'boolean', default: false, describe: 'stay in the throne room for the NEXT ghost: until its predicted window has passed (see GHOST_CYCLE_S)' },
    camp_max_min: { type: 'number', default: 150, describe: 'camp_next: the longest to stay after the first kill' },
    spawn_block: { type: 'number', default: 6, describe: 'how many of the throne room\'s 6 spawn squares raiders stand on (healers first, then the weakest); 0 = off' },
    checkpoint: { type: 'boolean', default: false, describe: 'rehearsals only: save the (loopback) world once everyone is armed, before the door, for replay' },
    agents: { type: 'agents', required: true },
    target: { type: 'string', default: 'ghost of Far', describe: 'the boss, as a name pattern' },
    room: { type: 'number', default: DEFAULT_BOSS_ROOM, describe: 'the boss room (40, the Throne Room of Victoria Castle)' },
    door: { type: 'number', default: DEFAULT_DOOR_ROOM, describe: 'the room the raid gathers in before the boss room (38)' },
    stage: { type: 'number', default: STAGE_ROOM },
    lightbearer: { type: 'string', default: '' },
    healers: { type: 'string', default: '' },
    rounds: { type: 'number', default: 10, describe: 'raid-action melee rounds before the farm loop takes over' },
    minutes: { type: 'number', default: 30, describe: 'how long to hold the room after the kill' },
    fight_limit_s: { type: 'number', default: 600, describe: 'if the ghost is not dead by now the window starts anyway' },
    retreat_at: { type: 'number', default: 0.25, describe: 'break off to room 38 below this health fraction' },
    // THE RAID POSTURE, applied to every fighter at the door and restored when its part ends.
    // Operator, 2026-09-24: holding the room "is going to take a lot of fighting from everyone".
    // The first rehearsal lost it because each keeper's own survival judged a level-100 tusked
    // skeleton out of band (default ceiling: 150% of max health, 67-91 on this fleet) and pulled
    // its character out. The keeper still owns survival — these only move where it draws the lines.
    raid_threat_ceiling: { type: 'number', default: 60, describe: 'flat engagement band above max health for the raid' },
    raid_flee_below: { type: 'number', default: 0.15, describe: 'keeper flee point during the raid' },
    raid_rest_below: { type: 'number', default: 0.3, describe: 'keeper rest point during the raid' },
    swings: { type: 'number', default: 3, describe: 'swings per attack call in the farm loop' },
    spare: { type: 'string', default: 'zombie',
             describe: 'comma-separated creatures the farm never attacks, to hold room slots. Empty = fight everything' },
    return_at: { type: 'number', default: 0.85, describe: 'walk back in at this health fraction' },
    light_every_s: { type: 'number', default: 150, describe: 'recast forces of light at least this often' },
    light_rest_below: { type: 'number', default: 0.8, describe: 'the light-bearer rests in 38 below this' },
    door_min_mana: { type: 'number', default: 0.9, describe: 'casters rest to this fraction of max mana before the door' },
    door_rest_s: { type: 'number', default: 600, describe: 'the longest a raider rests before the door' },
    door_min_health: { type: 'number', default: 0.8, describe: 'raiders rest in the stage room to this before walking to the door' },
    light_gate_s: { type: 'number', default: 180, describe: 'raiders hold at the door this long for the first light; 0 = do not wait' },
    sample_s: { type: 'number', default: 15 },
    run_dir: { type: 'string', default: '' },
    mustered: { type: 'boolean', default: false, describe: 'the fleet was mustered earlier in this same run' },
    dum_profile: { type: 'boolean', default: false, describe: 'a DUM raid profile is on: leave the wind-down and restore to it' },
    channel: { type: 'string', default: 'say' },
    lab: { type: 'boolean', default: false,
           describe: 'LAB ONLY: refill a buffer mana at the door instead of waiting for it. Never during the fight' },
    heal_below: { type: 'number', default: 0.95,
                  describe: 'a healer heals anyone in the room under this — i.e. anyone being hit. A heal on a ' +
                            'healthy target is refused free (heal.kod "is perfectly healthy")' },
    medic_below: { type: 'number', default: 0.6, describe: 'a FIGHTER who knows minor heal stops swinging to heal someone under this' },
    bless_every_s: { type: 'number', default: 150, describe: 'blessers re-bless their share this often (bless lasts ~3-5 min)' },
    strength_every_s: { type: 'number', default: 540, describe: 'super strength self+buddy refresh (it lasts 5-15 min)' },
    door_mana_wait_s: { type: 'number', default: 180, describe: 'how long a buffer may wait at the door for mana (prod)' },
    enter_wait_s: { type: 'number', default: 480, describe: 'how long the door waits for stragglers. Long enough for seven Kraanan casters to finish the door buffs: at 240 s the third rehearsal went in with 15 of 22 and the late casters walked in one at a time and died' },
    // Room 2, not the door (38): the operator's standing order for Loial, 2026-09-24, is to wait
    // Outside Castle Victoria and step in only to cast — his DUM doctrine places him at 2 as well.
    // Two hops to the throne room instead of one; still well inside a ~3.4-minute light.
    light_wait_room: { type: 'number', default: STAGE_ROOM, describe: 'where the light-bearer waits between casts' },
    light_heals: { type: 'boolean', default: false,
                   describe: 'let the light-bearer heal from inside the room after the kill. Off: at 20 health he died 1.6 min into the third hold' },
  },

  async steps(p, agentArg, state) {
    const agent = agentArg ?? p.agent;
    const agents = Array.isArray(p.agents) ? p.agents : String(p.agents).split(',').map(s => s.trim()).filter(Boolean);
    RUN.agents = agents;
    RUN.room = Number(p.room) || DEFAULT_BOSS_ROOM;
    RUN.door = Number(p.door) || DEFAULT_DOOR_ROOM;
    if (p.run_dir && !RUN.dir) { RUN.dir = p.run_dir; fs.mkdirSync(RUN.dir, { recursive: true }); }
    expect('enter', agents.length);
    const say = text => call('say', { agent, type: p.channel, text: String(text).slice(0, 220) }, 30_000).catch(() => {});

    // Roles from the spell lists, computed identically by every agent.
    // ONCE PER RUN, not once per agent: 22 agents each reading 22 spell lists is 484 calls.
    RUN.spells ??= (async () => {
      const out = {};
      await Promise.all(agents.map(async a => {
        out[a] = ((await call('spells', { agent: a }, 40_000).catch(() => null))?.spells ?? [])
          .map(s => String(s.name ?? '').toLowerCase());
      }));
      return out;
    })();
    const spells = await RUN.spells;
    const roles = assignRoles(agents, spells, { lightbearer: p.lightbearer, healers: p.healers });
    state && (state.fleet = process.env.M59_FLEET ?? state.fleet);
    expect('at-door', agents.length);
    const duty = {
      bless: blessAssignments(agents, roles.blessers, { lightbearer: roles.lightbearer })[agent] ?? [],
      strength: buddyAssignments(agents, roles.strongmen, { lightbearer: roles.lightbearer })[agent] ?? [],
      medic: roles.medics.includes(agent) || roles.healers.includes(agent),
    };
    // SPAWN BLOCKING (operator, 2026-09-25): some raiders stand ON the throne room's spawn squares,
    // which makes each spawn that picks their square fail. Healers first, then the weakest — the
    // ones a swarm on the ghost can spare. Computed once and shared; `spawn_block` is how many of
    // the six squares to hold (0 = off). Only meaningful in the ghost's own room.
    if (Number(p.spawn_block) > 0 && RUN.room === DEFAULT_BOSS_ROOM) {
      RUN.blockers ??= (async () => {
        const maxHealth = {};
        await Promise.all(agents.map(async a => {
          const st = await call('status', { agent: a, brief: true }, 30_000).catch(() => null);
          maxHealth[a] = Number(st?.health?.max ?? st?.hp?.max ?? 0);
        }));
        const b = spawnBlockers(agents, { lightbearer: roles.lightbearer, healers: roles.healers, maxHealth,
                                          count: Number(p.spawn_block), squares: THRONE_GENERATORS });
        event('spawn_block', { holders: b });
        RUN.blockerCount = Object.keys(b).length;
        RUN.valveLeader = [...agents].filter(a => a !== roles.lightbearer && !b[a]).sort()[0] ?? Object.keys(b)[0] ?? null;
        console.log(`  spawn block: ${Object.entries(b).map(([a, q]) => `${a} r${q.row}c${q.col}`).join(', ') || 'nobody'}`);
        return b;
      })();
      const mine = (await RUN.blockers)[agent];
      if (mine) duty.block = mine;
    }

    // ---- THE DOOR, IN TWO BEATS. Everyone gathers in 38; the Kraanan casters bless their
    // share of the fleet and put super strength on themselves and one buddy; THEN the door
    // opens. Buffing here rather than in room 2 is the point: bless lasts three to five minutes,
    // and 38 is one hop from the fight. Nothing is cast in 40 before the fight — a hit breaks a
    // casting trance, and the ghost hits about once a second.
    const atDoor = verify(async ({ state: st }) => {
      if (agent !== roles.lightbearer) st.posture = await raidPosture(agent, p);
      const b = await barrier('at-door', agent, { ms: Number(p.enter_wait_s) * 1000 });
      st.buffs = await buffShare({ agent, duty, p, where: RUN.door, patient: true });
      st.at_door = b;
      return true;
    }, 'the door buffs could not be read back', 'raid.door-buffs');

    const theDoor = verify(async ({ state: st }) => {
      const b = await barrier('enter', agent, { ms: Number(p.enter_wait_s) * 1000 });
      if (!RUN.startAt) { RUN.startAt = Date.now(); event('entered', { expected: b.expected, arrived: b.arrived }); }
      startSampler(p);
      st.door = b;
      return true;
    }, 'the door could not be read', 'raid.door');

    if (agent === roles.lightbearer) return lightbearerSteps({ agent, p, say, atDoor, theDoor });

    // ---- raiders and healers: raid-action, with the door inserted before the last hop.
    const base = await raidAction.steps({
      // stage_room 0 when ghost-arm already mustered us in this same run: raid-action decides its
      // muster walk when its steps are COMPILED, which in a composed run is before the muster.
      target: p.target, room: RUN.room, via: `${RUN.door},${RUN.room}`,
      stage_room: p.mustered === true || p.mustered === 'true' ? 0 : Number(p.stage),
      room_caster: '', healers: roles.healers.join(','), escort: '', heal_spell: 'minor heal',
      heal_below: Number(p.heal_below), require_enchanted: false, despite_hazard: HAZARD, channel: p.channel,
      rounds: Number(p.rounds), disengage_at: Number(p.retreat_at),
    }, agent, state ?? {});
    const i40 = base.findIndex(s => s?.do === 'walk' && Number(s.to) === RUN.room);
    // NOBODY GOES IN WITHOUT THE LIGHT FOLLOWING. On the 2026-09-25 no-DM rehearsal the light-
    // bearer reached the door at 55% health and rested toward 95% AFTER the door opened; the
    // raiders fought the ghost unlit and six died in two minutes with no light ever cast. The
    // raiders still go in FIRST — the ghost takes the first caster it sees, and he has twenty
    // health — but only once he is READY: rested, and three seconds behind them. `light_gate_s`
    // bounds the wait, so a light-bearer who cannot get ready does not freeze the raid for ever.
    const lightGate = verify(async () => {
      if (!roles.lightbearer || !(Number(p.light_gate_s) > 0)) return true;
      const until = Date.now() + Number(p.light_gate_s) * 1000;
      while (!RUN.light.ready && Date.now() < until) await sleep(2000);
      if (!RUN.light.ready) console.log(`  ${agent} going in without the light: not ready in ${p.light_gate_s}s`);
      return true;
    }, 'waiting at the door for the light-bearer to be ready', 'raid.light-gate');
    // REST IN THE STAGE ROOM BEFORE THE DOOR, HELD. The raid's walks carry a low health floor on
    // purpose: under a floor the fleetscript FREES the keeper to heal, and a freed keeper follows
    // its own orders — on the 2026-09-25 rehearsal a dedicator "healing" before the door walk went
    // shopping in Barloque and every late dedication waited on it. So raiders sit down here, in
    // place, to `door_min_health`, the way the light-bearer always has.
    // AND MANA: a caster walks to the door with enough to buff and heal. On the 2026-09-25 rehearsal
    // the dedications had drained it — 32 door buffs failed "no mana", bless and strength barely
    // landed, and the raid went in unbuffed.
    const restFirst = verify(async () => {
      const readMana = async () => (await call('status', { agent, brief: true }, 30_000).catch(() => null))?.mana ?? null;
      const needMana = async () => { const m = await readMana(); return m?.max > 0 && m.value < m.max * Number(p.door_min_mana); };
      const o = await observe(agent);
      if ((o.health ?? 1) < Number(p.door_min_health) || await needMana()) {
        await call('rest', { agent }, 30_000).catch(() => {});
        const until = Date.now() + Number(p.door_rest_s) * 1000;
        while (Date.now() < until) {
          const h = (await observe(agent)).health ?? 1;
          if (h >= Number(p.door_min_health) && !(await needMana())) break;
          await sleep(5000);
        }
        await call('rest', { agent, stand: true }, 30_000).catch(() => {});
      }
      return true;
    }, 'rested (health and mana) in the stage room before the door', 'raid.rest-first');
    // ---- ARMED, PREPPED, ON RECORD. Every raider writes down what it carries into the fight (the
    // battle report's gear section: weapon, body armour, shield, and where each came from), and on a
    // rehearsal the world is CHECKPOINTED here — after hand-outs, dedications, eating and resting,
    // before the door buffs — so the battle can be replayed from this instant (operator, 2026-09-25).
    // Nobody walks to the door until the save is on disk.
    const gearAndCheckpoint = verify(async () => {
      const me = await call('status', { agent, brief: false }, 40_000).catch(() => null);
      const eq = (me?.equipment ?? []).map(String);
      const weapon = eq.find(e => isWeaponName(e)) ?? null;
      const body = eq.find(e => /\b(leather|chain|plate|scale)\s+(armou?r|mail)\b/i.test(e)) ?? null;
      const shield = eq.find(e => /shield/i.test(e)) ?? null;
      const src = (OUTFIT_RUN.gear ?? []).filter(g => g.agent === agent);
      const from = kind => src.filter(g => g.kind === kind).map(g => `${g.source}${g.by ? ` (${g.by})` : ''}`).pop() ?? 'own';
      event('gear', { agent, character: me?.character ?? agent, weapon, body, shield,
                      weapon_from: from('hammer'), body_from: from('chain'), shield_from: from('shield'), equipment: eq,
                      health: me?.health ?? me?.vitals?.health ?? null, mana: me?.mana ?? me?.vitals?.mana ?? null,
                      vigor: me?.vigor ?? me?.vitals?.vigor ?? null });
      RUN.geared.add(agent);
      const expected = RUN.agents.filter(a => a !== p.lightbearer).length;
      const leader = [...RUN.agents].filter(a => a !== p.lightbearer).sort()[0];
      if (p.checkpoint === true || p.checkpoint === 'true') {
        if (agent === leader) {
          const until = Date.now() + 10 * 60_000;
          while (RUN.geared.size < expected && Date.now() < until) await sleep(2000);
          // THE FLEET'S OWN STATE, ALWAYS: where each raider stands, its vitals, what it wears and
          // carries. A server save can fail (the lab container's savegame mount was broken on
          // 2026-09-25 — `Save time is (0)`), and this is still enough to see what went into the
          // fight and to dress a shadow fleet back into it.
          const fleetState = {};
          await Promise.all(RUN.agents.map(async a => {
            const [st, inv] = await Promise.all([call('status', { agent: a, brief: false }, 40_000).catch(() => null),
                                                 call('inventory', { agent: a }, 40_000).catch(() => null)]);
            fleetState[a] = { character: st?.character ?? null, room: st?.where?.num ?? st?.room_num ?? null,
                              row: st?.where?.row ?? null, col: st?.where?.col ?? null,
                              health: st?.health ?? null, mana: st?.mana ?? null, vigor: st?.vigor ?? null,
                              karma: st?.karma ?? null, equipment: st?.equipment ?? [],
                              items: (inv?.items ?? []).map(i => ({ name: i.name, amount: i.amount ?? 1 })) };
          }));
          if (RUN.dir) try { fs.writeFileSync(path.join(RUN.dir, 'fleet-state.json'), JSON.stringify({ at: Date.now(), agents: fleetState }, null, 1)); } catch {}
          RUN.checkpoint = await takeCheckpoint(`ghost raid ${path.basename(RUN.dir ?? '')} armed, before the door`);
          RUN.checkpoint.fleet_state = RUN.dir ? path.join(RUN.dir, 'fleet-state.json') : null;
          event('checkpoint', RUN.checkpoint);
          console.log(`  checkpoint: ${RUN.checkpoint.ok ? RUN.checkpoint.name : 'NOT TAKEN — ' + RUN.checkpoint.why} (${RUN.geared.size}/${expected} raiders on record)`);
        } else {
          const until = Date.now() + 12 * 60_000;
          while (!RUN.checkpoint && Date.now() < until) await sleep(2000);
        }
      }
      return true;
    }, 'the gear record and checkpoint could not be written', 'raid.checkpoint');

    const steps = i40 >= 0 ? [restFirst, gearAndCheckpoint, ...base.slice(0, i40), atDoor, theDoor, lightGate, ...base.slice(i40)]
                           : [restFirst, gearAndCheckpoint, atDoor, theDoor, lightGate, ...base];

    // The melee loop ends on "the boss is gone from here" — which is the kill, if it saw it.
    steps.push(verify(async ({ state: st }) => {
      const o = await observe(agent);
      if (Number(o.room) === RUN.room) {
        const { ghost } = await lookAround(agent, p.target);
        if (ghost) RUN.ghostSeen = true;
        else if (st.melee || st.approach) { RUN.ghostSeen = true; ghostGone(agent); }
      }
      return true;
    }, 'the kill could not be read', 'raid.fight'));

    steps.push(roles.healers.includes(agent)
      ? verify(async ({ state: st }) => healLoop({ agent, p, st, say, duty }), 'the healer could not be read back')
      : verify(async ({ state: st }) => farmLoop({ agent, p, st, say, duty }), 'the farm could not be read back'));
    return steps;
  },
};

function lightbearerSteps({ agent, p, say, atDoor, theDoor }) {
  return [
    // REST WHERE IT IS SAFE AND WHILE THE RAID IS STILL FORMING, not at the door with the raiders
    // released and waiting on him. Twenty health heals slowly; this is the time to do it.
    verify(async () => {
      const o = await observe(agent);
      if ((o.health ?? 1) < 0.95) { await say('Resting before the raid.'); await restUntil(agent, 0.95, p); }
      return true;
    }, 'the light-bearer rests before walking to the door', 'raid.light-rest'),
    walk(RUN.door),
    atDoor,
    theDoor,
    verify(async ({ state: st }) => {
      const log = [];
      // Rested BEFORE the raiders are let in (they wait on RUN.light.ready), then behind them, not
      // in front: the wizard-killer takes the first caster it sees.
      {
        const o = await observe(agent);
        if ((o.health ?? 1) < Math.max(0.95, Number(p.light_rest_below))) await restUntil(agent, 0.95, p);
      }
      RUN.light.ready = true;
      await sleep(3000);
      const castIn = async why => {
        const o = await observe(agent);
        if (o.dead && await confirmedDead(agent)) return false;
        if ((o.health ?? 0) < Number(p.light_rest_below)) {
          await say('Resting before the next light.');
          await restUntil(agent, 0.95, p);
        }
        const h = await hop(agent, RUN.room, { tries: 5 });
        if (!h.ok) {
          log.push({ t: Date.now(), outcome: 'could not enter', ...h });
          event('light', { outcome: 'could not enter', why, room: h.room ?? null, reply: h.reply ?? null });
          console.log(`  ${agent} forces of light: could not enter the throne room (${why}; standing in ${h.room ?? '?'})`);
          return !h.dead;
        }
        await call('rest', { agent, stand: true }, 30_000).catch(() => {});
        // RETRY WHAT IS RETRYABLE, THERE AND THEN. The fourth rehearsal's opening light came back
        // `nothing_happened` — most likely interrupted, since the ghost goes for casters — and the
        // loop then waited out the whole relight timer with the room dark. A broken cast is a
        // second cast, not a two-and-a-half-minute wait.
        let r = await castVerified(agent, LIGHT.spell, { target: null, cost: LIGHT.mana });
        for (let i = 0; i < 2 && !r.landed && !r.in_effect && r.retryable !== false
                         && /nothing_happened|interrupt/.test(String(r.outcome ?? '')); i++) {
          await call('rest', { agent, stand: true }, 30_000).catch(() => {});
          r = await castVerified(agent, LIGHT.spell, { target: null, cost: LIGHT.mana });
        }
        const outcome = r.landed ? 'cast' : r.in_effect ? 'still up' : `failed: ${String(r.why ?? '').slice(0, 60)}`;
        if (r.landed || r.in_effect) { RUN.light.lastCast = Date.now(); RUN.light.expired = false; }
        if (r.landed) RUN.light.casts++;
        log.push({ t: Date.now(), why, outcome });
        event('light', { outcome, why });
        console.log(`  ${agent} forces of light: ${outcome} (${why})`);
        // OUT AGAIN AT ONCE, before and after the kill. The third rehearsal had the light-bearer
        // stay after the kill to heal, and he died 1.6 minutes into the hold: seven level-100
        // tusked skeletons do not care that the ghost is gone, and he has twenty health. The
        // operator's standing order is the same — wait outside, step in only to cast.
        // OUT BY THE NEAREST DOOR: 38 is one hop, and the throne room is where he dies. Then on to
        // the wait room.
        await hop(agent, Number(RUN.door), { tries: 6 });
        if (Number(p.light_wait_room) !== Number(RUN.door)) await hop(agent, Number(p.light_wait_room));
        return true;
      };
      const heals = [];
      await castIn('opening');
      while (Date.now() < endAt(p)) {
        const due = Date.now() - RUN.light.lastCast > Number(p.light_every_s) * 1000;
        if (RUN.light.expired || due) {
          if (!(await castIn(RUN.light.expired ? 'a raider saw it lapse' : 'timer'))) break;
          continue;
        }
        const o = await observe(agent);
        if (o.dead) { event('died', { agent }); break; }
        if (!RUN.killAt || !(p.light_heals === true || p.light_heals === 'true')) {
          if (Number(o.room) === RUN.room) await hop(agent, Number(p.light_wait_room));
          await sleep(3000); continue;
        }
        // After the kill: heal from inside the room, and step out to rest when hurt.
        if ((o.health ?? 0) < Number(p.light_rest_below)) {
          // After the kill the wall in the room, like everyone else; before it, out of the room.
          if (Number(o.room) === RUN.room) {
            const where = await retreatInRoom(agent, { ...p, return_at: 0.95 });
            event('retreat', { agent, health: o.health, to: where.to });
          } else await restUntil(agent, 0.95, p);
          continue;
        }
        if (Number(o.room) !== RUN.room) { await hop(agent, RUN.room); continue; }
        const h = await medicTick(agent, Number(p.heal_below));
        if (h) heals.push(h); else await sleep(2500);
      }
      await windDown(agent, p);
      RUN.done.add(agent);
      st.light = { casts: log.filter(l => l.outcome === 'cast').length, attempts: log.length, log: log.slice(-12),
                   heals: heals.length, heals_landed: heals.filter(x => x.landed).length };
      event('light_summary', { agent, ...st.light, log: undefined });
      return true;
    }, 'the light-bearer could not be read back', 'raid.light'),
  ];
}

/**
 * STAND ON THE SPAWN SQUARE. true when this raider is on its assigned square (after walking back to
 * it if it had moved); counts the samples on and off it for the report.
 */
async function holdSquare(agent, block, tally) {
  const l = await call('look', { agent }, 40_000).catch(() => null);
  const me = l?.you;
  if (me && Number(me.row) === block.row && Number(me.col) === block.col) { tally.block_on = (tally.block_on ?? 0) + 1; return true; }
  tally.block_off = (tally.block_off ?? 0) + 1;
  await call('walk_to', { agent, col: block.col, row: block.row }, 60_000).catch(() => {});
  return false;
}

/**
 * THE SPAWN VALVE, once every 15 s by one raider. Shut while the ghost lives and from two minutes
 * before a predicted ghost window (so the room is quiet for it); otherwise m59-ghostraid-lib
 * valveStep decides from the lowest health in the room and the live monster count.
 */
async function valveTick(agent, p) {
  if (!(Number(p.spawn_block) > 0) || !(p.valve === true || p.valve === 'true') || Date.now() - RUN.valveAt < 15_000) return;
  RUN.valveAt = Date.now();
  const now = Date.now();
  const before = RUN.valve.open;
  const lastSpawn = RUN.spawns[RUN.spawns.length - 1] ?? null;
  const closeAt = lastSpawn != null ? lastSpawn + prepCloseMin(p) * 60_000 : null;
  // THE PHASE. Before the first kill and while a ghost lives: shut. Before a respawn has been seen:
  // at most valve_before_spawn (1) open. After one: wide, until closeAt; from closeAt: PREP — shut,
  // clear the room, get ready for the ghost the countdown says is coming.
  const phase = !RUN.killAt || RUN.ghostAlive ? 'shut'
    : lastSpawn == null ? 'one'
    : now < closeAt ? 'wide' : 'prep';
  if (phase !== RUN.phase) {
    event('phase', { phase, ...(closeAt ? { close_at: closeAt } : {}), ...(RUN.nextWindow ? { next_lo: RUN.nextWindow.lo, next_hi: RUN.nextWindow.hi } : {}) });
    console.log(`  phase: ${phase}` + (RUN.nextWindow ? ` (next ghost ${Math.round((RUN.nextWindow.lo - now) / 60_000)}-${Math.round((RUN.nextWindow.hi - now) / 60_000)} min)` : ''));
    if (phase === 'prep') RUN.prep = { closedAt: now, readyAt: null };
    RUN.phase = phase;
  }
  // THE COUNTDOWN, every ten minutes while a ghost is due.
  if (RUN.nextWindow && now - (RUN.countdownAt ?? 0) > 10 * 60_000 && !RUN.ghostAlive) {
    RUN.countdownAt = now;
    console.log(`  countdown: next ghost in ${Math.max(0, Math.round((RUN.nextWindow.lo - now) / 60_000))}-${Math.max(0, Math.round((RUN.nextWindow.hi - now) / 60_000))} min (phase ${phase})`);
  }
  const all = await fleetNow();
  const rows = all.filter(r => RUN.agents.includes(r.agent) && r.room === RUN.room && r.frac != null);
  const minFrac = rows.length ? Math.min(...rows.map(r => r.frac)) : 1;
  const { others } = await lookAround(agent, p.target);
  // A STRANGER: a player in the room who is none of ours. PVP can break out on prod, and a room full
  // of spawns is the worst place to meet it, so every square shuts while one is here.
  const ours = new Set(all.map(r => String(r.who ?? '').toLowerCase()).filter(Boolean));
  const players = ((await call('look', { agent }, 40_000).catch(() => null))?.objects ?? []).filter(o => o.is_player);
  const strangers = players.filter(o => !ours.has(String(o.name ?? '').toLowerCase())).map(o => o.name);
  if (strangers.length && !RUN.strangerSeen) { RUN.strangerSeen = true; event('stranger', { names: strangers }); console.log(`  STRANGER in the throne room: ${strangers.join(', ')} — every spawn square shut`); }
  if (!strangers.length) RUN.strangerSeen = false;
  if (phase === 'shut' || phase === 'prep') {
    RUN.valve = { ...RUN.valve, open: 0, why: phase === 'prep' ? 'preparing for the next ghost' : RUN.ghostAlive ? 'the ghost is up' : 'before the kill' };
    // READY: the room is empty and everyone in it is healthy. The lead this took is the fleet's
    // own number for prep_close_min, and the margin by which it beat the ghost is logged when the
    // ghost appears.
    if (phase === 'prep' && RUN.prep && !RUN.prep.readyAt && others.length === 0 && minFrac >= Number(p.prep_ready_health)) {
      RUN.prep.readyAt = now;
      event('prep_ready', { closed_at: RUN.prep.closedAt, lead_ms: now - RUN.prep.closedAt });
      console.log(`  prep: ready ${Math.round((now - RUN.prep.closedAt) / 60_000)} min after the valve shut`);
    }
  } else {
    const squares = phase === 'one' ? Math.min(RUN.blockerCount, Number(p.valve_before_spawn)) : RUN.blockerCount;
    RUN.valve = valveStep(RUN.valve, { minFrac, monsters: others.length, squares, incidents: RUN.incidents ?? 0, stranger: strangers.length > 0 },
      { startAt: Number(p.valve_start), closeBelow: Number(p.valve_close_below), easyHealth: Number(p.valve_easy_health),
        dwellMs: Number(p.valve_dwell_s) * 1000, maxOpen: Number(p.valve_max) });
    if (RUN.valve.open > squares) RUN.valve = { ...RUN.valve, open: squares };
  }
  if (RUN.valve.open !== before) {
    event('valve', { open: RUN.valve.open, phase, monsters: others.length, min_frac: Number(minFrac.toFixed(2)), why: RUN.valve.why });
    console.log(`  valve: ${RUN.valve.open} of ${RUN.blockerCount} open (${phase}; ${others.length} alive, lowest ${Math.round(minFrac * 100)}%) — ${RUN.valve.why}`);
  }
}

/** Minutes after a seen spawn to shut the valve and prepare: the fleet's measured recommendation, else the param. */
function prepCloseMin(p) {
  if (p.prep_close_min != null && String(p.prep_close_min) !== '' && String(p.prep_close_min) !== 'auto') return Number(p.prep_close_min);
  RUN.prepRec ??= (() => {
    try {
      const f = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'substrate', 'raids', 'prep-lead.json');
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      return Number.isFinite(Number(j.recommended_close_min)) ? Number(j.recommended_close_min) : 95;
    } catch { return 95; }
  })();
  return RUN.prepRec;
}

/** Hold the room: the ghost first while it lives, then whatever is nearest. */
async function farmLoop({ agent, p, st, say, duty }) {
  const tally = { swings: 0, kills: 0, retreats: 0, returns: 0, died: false, left: null, killed: {},
                  heals: 0, heals_landed: 0, buff_rounds: 0 };
  let lastBless = Date.now(), lastStrength = Date.now(), lastHeal = 0;
  const RING = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]];
  let closes = 0, lastTooFar = false;
  while (Date.now() < endAt(p)) {
    const o = await observe(agent);
    if (o.dead) { tally.died = true; event('died', { agent }); await say('I am down.'); break; }
    const room = Number(o.room);
    if (room !== RUN.room) {
      if (room !== RUN.door) { tally.left = room; event('left', { agent, room }); break; }   // fled far; the keeper has it
      if ((o.health ?? 0) < Number(p.return_at)) { await restUntil(agent, Number(p.return_at), p); continue; }
      const h = await hop(agent, RUN.room);
      if (h.ok) { tally.returns++; event('return', { agent }); }
      continue;
    }
    if ((o.health ?? 1) < Number(p.retreat_at)) {
      tally.retreats++;
      const where = await retreatInRoom(agent, p);
      event('retreat', { agent, health: o.health, to: where.to });
      continue;
    }
    // BETWEEN SWINGS: a medic heals whoever is worst hurt under medic_below, at most every 4s,
    // and a blesser re-blesses its share when bless is due — cast inside the room on purpose,
    // because leaving to cast costs the fight a body. A broken trance costs a retry, not a death.
    if (duty?.medic && Date.now() - lastHeal > 4000) {
      const h = await medicTick(agent, Number(p.medic_below));
      if (h) { lastHeal = Date.now(); tally.heals++; if (h.landed) tally.heals_landed++; continue; }
    }
    if (duty?.bless?.length && Date.now() - lastBless > Number(p.bless_every_s) * 1000) {
      lastBless = Date.now(); tally.buff_rounds++;
      await buffShare({ agent, duty: { ...duty, strength: [] }, p, where: RUN.room, patient: false });
      continue;
    }
    if (duty?.strength?.length && Date.now() - lastStrength > Number(p.strength_every_s) * 1000) {
      lastStrength = Date.now();
      await buffShare({ agent, duty: { ...duty, bless: [] }, p, where: RUN.room, patient: false });
      continue;
    }
    if (RUN.valveLeader === agent) await valveTick(agent, p);
    // A SPAWN-SQUARE HOLDER stays on its square: back onto it first, then only what is in reach —
    // unless the valve has opened its square, when it fights like anyone else (and comes back when
    // the valve closes it again).
    const holding = duty?.block && !(RUN.valve.open > (duty.block.index ?? 0));
    if (holding && !(await holdSquare(agent, duty.block, tally))) continue;
    const { ghost, others } = await lookAround(agent, p.target);
    if (ghost) RUN.ghostSeen = true; else ghostGone(agent);
    const g = ghost ?? pickFocus(others, p);
    if (!g) {
      // PREP WITH AN EMPTY ROOM: sit and recover for the ghost the countdown says is coming. A seated
      // raider cannot swing — the attack path stands it up the moment one is refused.
      if (RUN.phase === 'prep') await call('rest', { agent }, 30_000).catch(() => {});
      await sleep(3000); continue;                           // nothing yet: the next one is ~12s off
    }
    if (holding && (g.distance ?? 99) > 1) {
      const near = [ghost, ...(others ?? [])].filter(Boolean).find(o => (o.distance ?? 99) <= 1);
      if (!near) { await sleep(2000); continue; }             // nothing adjacent: hold, do not chase
      const r = await call('attack', { agent, target: near.id, swings: Number(p.swings) }, 60_000).catch(e => ({ error: e.message }));
      if (!r?.error) tally.swings += Number(p.swings);
      for (const m of r?.messages ?? []) {
        const k = /^You killed (?:the |a |an )?(.+?)\.?$/i.exec(m);
        if (k) { tally.kills++; tally.killed[k[1]] = (tally.killed[k[1]] ?? 0) + 1; event('kill', { agent, creature: k[1] }); }
      }
      continue;
    }
    // A refusal on reach closes to adjacent before the next swing (raid-action's rule, same
    // 2026-09-25 rehearsal: twenty swings from "distance 2", every one too far away).
    if ((g.distance ?? 99) > (lastTooFar ? 1 : 2)) {
      lastTooFar = false;
      const off = RING[closes++ % RING.length];
      await call('walk_to', { agent, col: g.col + off[0], row: g.row + off[1] }, 60_000).catch(() => {});
      continue;
    }
    closes = 0;
    const r = await call('attack', { agent, target: g.id, swings: Number(p.swings) }, 60_000).catch(e => ({ error: e.message }));
    const msgs = r?.messages ?? [];
    if (r?.could_not_swing || msgs.some(m => /unable to lift your weapon/i.test(m))) {
      await call('rest', { agent, stand: true }, 30_000).catch(() => {});
      continue;
    }
    if (!r?.error) tally.swings += Number(p.swings);
    if (msgs.some(m => /too far away/i.test(m))) lastTooFar = true;
    if (msgs.some(m => /spirit of Shal'ille departs/i.test(m))) RUN.light.expired = true;
    for (const m of msgs) {
      const k = /^You killed (?:the |a |an )?(.+?)\.?$/i.exec(m);
      if (k) { tally.kills++; tally.killed[k[1]] = (tally.killed[k[1]] ?? 0) + 1; event('kill', { agent, creature: k[1] }); }
    }
  }
  await windDown(agent, p);
  RUN.done.add(agent);
  st.farm = tally;
  event('farm_summary', { agent, ...tally, ...(duty?.block ? { block: duty.block } : {}) });
  console.log(`  ${String(agent).padEnd(9)} farm: kills=${tally.kills} swings=${tally.swings} ` +
              `retreats=${tally.retreats} returns=${tally.returns} heals=${tally.heals_landed}/${tally.heals}${tally.died ? ' DIED' : ''}` +
              (tally.left != null ? ` left-to-${tally.left}` : ''));
  return true;
}

/** A healer holds the back of the room for the whole window, as raid-action's healer does for the fight. */
async function healLoop({ agent, p, st, say, duty }) {
  const casts = [];
  let lastBless = Date.now();
  while (Date.now() < endAt(p)) {
    const o = await observe(agent);
    if (o.dead) { event('died', { agent }); break; }
    if (Number(o.room) !== RUN.room) {
      if (Number(o.room) !== RUN.door) { event('left', { agent, room: o.room }); break; }
      if ((o.health ?? 0) < Number(p.return_at)) { await restUntil(agent, Number(p.return_at), p); continue; }
      await hop(agent, RUN.room);
      continue;
    }
    if ((o.health ?? 1) < Number(p.retreat_at)) {
      const where = await retreatInRoom(agent, p);
      event('retreat', { agent, health: o.health, to: where.to });
      continue;
    }
    if (duty?.bless?.length && Date.now() - lastBless > Number(p.bless_every_s) * 1000) {
      lastBless = Date.now();
      await buffShare({ agent, duty: { ...duty, strength: [] }, p, where: RUN.room, patient: false });
      continue;
    }
    if (RUN.valveLeader === agent) await valveTick(agent, p);
    if (duty?.block && !(RUN.valve.open > (duty.block.index ?? 0)) && !(await holdSquare(agent, duty.block, st.blockTally ??= {}))) continue;
    // Anyone being hit, not only the badly hurt: under heal_below, worst first.
    const h = await medicTick(agent, Number(p.heal_below));
    if (!h) { await sleep(2000); continue; }
    casts.push(h);
    await sleep(1000);
  }
  await windDown(agent, p);
  RUN.done.add(agent);
  st.heal_window = { casts: casts.length, landed: casts.filter(c => c.landed).length };
  event('heal_summary', { agent, ...st.heal_window, ...(duty?.block ? { block: duty.block, ...(st.blockTally ?? {}) } : {}) });
  console.log(`  ${String(agent).padEnd(9)} heals in the window: ${st.heal_window.landed}/${st.heal_window.casts}`);
  return true;
}

export const _run = RUN;
