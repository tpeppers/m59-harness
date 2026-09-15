#!/usr/bin/env node
// CLEAR A BOSS ROOM BACK TO THE BOSS — part of resetting a repeatable fight.
//
//   node tools/m59-clearroom.mjs 40 --keep Ghost            say what it would do
//   node tools/m59-clearroom.mjs 40 --keep Ghost --commit   do it
//
// A boss room does not stay a boss room. The Castle Victoria throne room generates tusked
// skeletons on its own clock, and by the third rerun of a raid it held EIGHT of them plus a
// zombie alongside the ghost — measured 2026-09-11, in a fight where the escort killed more
// raiders than the boss did and the ghost finished on 233 of 233 having never been touched.
// A test that is not run against the same room twice is not a repeatable test, and the
// difference here is not a detail: it is which creature the raid actually fought.
//
// So this is the room half of a checkpoint's `establish`: the postcondition is "this room
// contains the boss and nothing else", and it is established by DM command rather than by
// waiting out a generator. The same idea as skipping to an armed fleet instead of casting
// twenty-one enchantments.
//
// ============================================================================
// IT WILL NOT DELETE A PLAYER, AND THAT IS STRUCTURAL RATHER THAN CAREFUL
// ============================================================================
//
// The room's active list holds our own raiders, the operator's character if they are standing
// there, and anything else alive. A tool that deletes "the monsters" by deleting what it does
// not recognise is one bad class name away from deleting the fleet. So the rule is inverted:
// anything that IS a user, or IS on the keep list, is left alone, and everything else has to
// be positively identified as a class before it is touched. An object whose class cannot be
// read is REPORTED AND KEPT.
//
// Loopback only — m59-dm refuses any other host, and deleting objects on a server somebody
// else is playing on is not a configuration choice.
import { dm, roomObject } from './m59-dm.mjs';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PROTECTED = /^(User|Player|Admin|DM)$/i;

// ============================================================================
// WHAT IS LITTER AND WHAT IS THE ROOM ITSELF — asked of the kod, not of a list
// ============================================================================
//
// The throne room's passive list holds dropped reagents and weapons, six corpses, AND twelve
// Pillars, four Braziers and the Throne. The first dry run of this tool proposed deleting all
// of it, which would have permanently stripped a room the server only furnishes once
// (throne1.kod CreateStandardObjects). No property on the objects separates them — I checked
// piMoveOnType, piItem_flags, piBulk, piWeight and piFlags, and scenery and a hammer are
// identical in all of them.
//
// The class TREE separates them cleanly. A droppable item is declared under `kod/object/item/`
// (Hammer is object/item/passitem/weapon/hammer.kod, ElderBerry is .../numbitem/elderbry.kod);
// scenery is declared under `kod/object/passive/` (Pillar, Throne, Brazier). So the question
// "is this litter" is answered by where the class is DECLARED, which is a fact about the game
// rather than a list somebody maintains.
//
// DeadBody is the exception and is named: object/passive/body.kod, so structurally scenery,
// but six corpses on the floor are exactly the litter a rerun wants gone.
const LITTER_ANYWAY = /^(DeadBody)$/i;

const SEP = String.fromCharCode(92);      // a backslash, spelled so no layer can eat it
let CLASS_HOME = null;
function classHomes(root = process.env.M59_ROOT || 'C:/code/meridian59') {
  if (CLASS_HOME) return CLASS_HOME;
  CLASS_HOME = new Map();
  const walk = dir => {
    let entries = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e);
      let st; try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      if (!e.endsWith('.kod')) continue;
      let head = '';
      try { head = readFileSync(full, 'utf8').slice(0, 4000); } catch { continue; }
      const m = /^([A-Za-z_][\w]*)\s+is\s+[A-Za-z_]/m.exec(head);
      // Normalise the separator without writing one: on Windows `join` gives backslashes and
      // the membership test below is written with forward slashes.
      if (m) CLASS_HOME.set(m[1].toLowerCase(), full.split(SEP).join('/'));
    }
  };
  walk(join(root, 'kod', 'object'));
  return CLASS_HOME;
}

/** true = a droppable item, false = the room's own furniture, null = not found in the tree. */
export function isDroppableItem(cls) {
  if (!cls) return null;
  if (LITTER_ANYWAY.test(cls)) return true;
  const home = classHomes().get(String(cls).toLowerCase());
  if (!home) return null;
  return /\/kod\/object\/item\//.test(home);
}

/** Everything the room is holding, with its class. */
export async function roomOccupants(roomNum, opts = {}) {
  const obj = await roomObject(roomNum, opts);
  if (!obj) return { room: null, active: [], passive: [] };
  const out = String(await dm([`show object ${obj}`], opts));
  const listOf = async spec => {
    const m = /LIST (\d+)/.exec(spec ?? '');
    if (!m) return [];
    const l = String(await dm([`show list ${m[1]}`], opts));
    return [...l.matchAll(/OBJECT (\d+)/g)].map(x => Number(x[1]));
  };
  const active = await listOf((out.match(/plActive\s+= (.+)/) ?? [])[1]);
  const passive = await listOf((out.match(/plPassive\s+= (.+)/) ?? [])[1]);
  const describe = async ids => {
    const rows = [];
    for (const id of ids) {
      const o = String(await dm([`show object ${id}`], opts));
      rows.push({ id, cls: (o.match(/OBJECT \d+ is CLASS (\w+)/) ?? [])[1] ?? null });
    }
    return rows;
  };
  return { room: obj, active: await describe(active), passive: await describe(passive) };
}

/**
 * What to remove so the room holds only the boss and whoever is standing in it.
 * Pure: it decides, it does not delete. `keep` is matched case-insensitively on the class.
 */
export function plan({ active = [], passive = [] }, { keep = [], loot = true } = {}) {
  const keeping = new Set(keep.map(k => String(k).toLowerCase()));
  const remove = [], kept = [], unknown = [];
  for (const o of active) {
    if (!o.cls) { unknown.push(o); continue; }            // cannot identify -> keep, loudly
    if (PROTECTED.test(o.cls) || keeping.has(o.cls.toLowerCase())) { kept.push(o); continue; }
    remove.push(o);
  }
  // Ground items are in plPassive. A corpse and a dropped weapon are both here, and both are
  // litter for a rerun — but a raider's dropped weapon is too, which is why this is optional.
  const removeLoot = [], keptScenery = [];
  if (loot) {
    for (const o of passive) {
      if (!o.cls || PROTECTED.test(o.cls)) { unknown.push(o); continue; }
      const drop = isDroppableItem(o.cls);
      // UNKNOWN CLASS KEEPS THE OBJECT. A class this tool cannot place in the tree might be
      // the room's own furniture, and deleting a room's furniture cannot be undone by a rerun.
      if (drop === true) removeLoot.push(o); else keptScenery.push(o);
    }
  }
  return { remove, removeLoot, kept, keptScenery, unknown };
}

/**
 * SUSPEND OR RESUME THE ROOM'S OWN MONSTER GENERATOR.
 *
 * Clearing a monster room once is not a reset: the throne room put EIGHT tusked skeletons and
 * a zombie back within minutes of being emptied, because `plGenerators` is still running and
 * `piMonster_count_max` is 10. A repeatable fight needs generation held for the duration.
 *
 * ALWAYS RELEASE IT AFTERWARDS. `pbGenerateMonsters` is a property of the live room and
 * nothing restores it on its own — leaving it at 0 permanently empties a room the rest of the
 * world expects to be populated, which is a change to the game rather than to a test. It also
 * stops the BOSS respawning: throne1.kod's SpawnGhost returns early on the same flag, so a
 * room left held will never produce another ghost.
 */
export async function holdGenerators(roomNum, on, opts = {}) {
  const obj = await roomObject(roomNum, opts);
  if (!obj) return { ok: false, why: `room ${roomNum} is not loaded` };
  await dm([`set object ${obj} pbGenerateMonsters INT ${on ? 0 : 1}`], opts);
  const out = String(await dm([`show object ${obj}`], opts));
  const now = Number((out.match(/pbGenerateMonsters\s+= INT (\d+)/) ?? [])[1] ?? NaN);
  return { ok: now === (on ? 0 : 1), room: obj, generating: now === 1 };
}

export async function clearRoom(roomNum, { keep = [], loot = true, commit = false } = {}, opts = {}) {
  const occ = await roomOccupants(roomNum, opts);
  if (!occ.room) return { ok: false, why: `room ${roomNum} is not loaded` };
  const p = plan(occ, { keep, loot });
  if (!commit) return { ok: true, room: occ.room, committed: false, ...p };

  // `delete object <id>` IS NOT A COMMAND. The admin socket's `delete` takes account, timer or
  // user and nothing else, so every one of those lines was a no-op — and this function happily
  // reported "removed: TuskedSkeleton x8" from its PLAN, having removed nothing, twice.
  //
  // The kod way is to send the object its own Delete (object.kod:102), which takes it out of
  // its holder. The object RECORD survives until garbage collection, so `show object` still
  // answers with its class afterwards — which is why the check below re-reads THE ROOM rather
  // than the object.
  const ids = [...p.remove, ...p.removeLoot].map(o => o.id);
  for (let i = 0; i < ids.length; i += 20)
    await dm(ids.slice(i, i + 20).map(id => `send object ${id} Delete`), { timeoutMs: 60_000, ...opts });

  // AND READ IT BACK. A tool that reports what it MEANT to do is the instrument this whole
  // session keeps being bitten by. What it reports now is what the room says afterwards.
  const after = await roomOccupants(roomNum, opts);
  const stillThere = new Set([...after.active, ...after.passive].map(o => o.id));
  const gone = ids.filter(id => !stillThere.has(id));
  const stayed = ids.filter(id => stillThere.has(id));
  return { ok: stayed.length === 0, room: occ.room, committed: true, ...p,
           removed_count: gone.length, stayed,
           ...(stayed.length ? { why: `${stayed.length} object(s) did not leave the room` } : {}) };
}

if (process.argv[1] && process.argv[1].endsWith('m59-clearroom.mjs')) {
  const args = process.argv.slice(2);
  const roomNum = Number(args.find(a => /^\d+$/.test(a)));
  if (!Number.isFinite(roomNum)) {
    console.error('usage: m59-clearroom.mjs <room> [--keep Ghost] [--no-loot] [--commit]');
    process.exit(2);
  }
  const keep = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--keep' && args[i + 1]) keep.push(args[i + 1]);

  // --hold suspends generation before clearing, --release puts it back. Release is its own
  // command precisely so it can be run on its own after a test that crashed.
  if (args.includes('--release')) {
    const r = await holdGenerators(roomNum, false);
    console.log(r.ok ? `room ${roomNum}: generators RUNNING again` : `could not release: ${r.why}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (args.includes('--hold')) {
    if (!args.includes('--commit')) { console.log(`would suspend generation in room ${roomNum}`); }
    else {
      const r = await holdGenerators(roomNum, true);
      console.log(r.ok ? `room ${roomNum}: generation SUSPENDED — remember --release`
                       : `could not hold: ${r.why}`);
      if (!r.ok) process.exit(1);
    }
  }
  const r = await clearRoom(roomNum, {
    keep, loot: !args.includes('--no-loot'), commit: args.includes('--commit'),
  });
  if (!r.ok) { console.error(r.why); process.exit(1); }
  const count = xs => Object.entries(xs.reduce((a, o) => ((a[o.cls ?? '?'] = (a[o.cls ?? '?'] ?? 0) + 1), a), {}))
    .map(([k, n]) => `${k} x${n}`).join(', ') || 'nothing';
  console.log(`room ${roomNum} (object ${r.room})`);
  console.log(`  keeping:  ${count(r.kept)}`);
  console.log(`  ${r.committed ? 'asked to remove' : 'WOULD remove'}:  ${count(r.remove)}`);
  console.log(`  ${r.committed ? 'asked to remove loot' : 'WOULD remove loot'}: ${count(r.removeLoot)}`);
  if (r.committed) {
    console.log(`  CONFIRMED GONE from the room: ${r.removed_count}`);
    if (r.stayed?.length) console.log(`  STILL THERE: ${r.stayed.join(', ')}`);
  }
  if (r.keptScenery?.length) console.log(`  kept as the room's own: ${count(r.keptScenery)}`);
  if (r.unknown.length) console.log(`  KEPT, class unreadable: ${r.unknown.map(o => o.id).join(', ')}`);
  if (!r.committed) console.log('\nnothing was changed. Add --commit.');
}
