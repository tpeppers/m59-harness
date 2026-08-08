// Where each creature actually lives, and what else lives there.
//
// Monsters in Meridian 59 do not roam the world looking for you. Every room has a
// generator with a fixed spawn table, and a creature appears in a room only if that
// room's table names it. So "where do I find giant rats" is a LOOKUP, and a keeper
// that wanders room to room hoping to trip over one is running the wrong algorithm
// entirely — it walks a character across the map into the Princess's castle to hunt
// vermin that were never going to be there.
//
// Built from compendium/data/spawns.json, which is extracted from the kod room
// sources and carries the spawn chance, the population cap, and the cite line for
// every entry. NOT from the rendered creature pages: groundwormlarva.html claims
// "no room in the world declares this creature", while the data shows it generated
// at 70% in OutdoorsF6 and again in OutdoorsF7 — which is exactly where a character
// of mine kept dying to something the page said could not be there.
//
// Levels and karma come from tools/monsters.json (viLevel / viKarma straight out of
// the class definitions), because the danger of a room is the level of the WORST
// thing in it, not of the thing you meant to hunt.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Room keys in spawns.json are kod class names — "OutdoorsF7" — and the map records
// the same string as `cls`, so this join is exact. (The creature PAGES cite the .roo
// basename instead; different key, same rooms.)
export function buildSpawnIndex({ spawnsFile, mapFile, monstersFile, treasureFile, outFile }) {
  const raw = JSON.parse(readFileSync(spawnsFile, 'utf8'));
  const map = JSON.parse(readFileSync(mapFile, 'utf8'));
  const mons = JSON.parse(readFileSync(monstersFile, 'utf8'));

  // WHAT A KILL LEAVES BEHIND, from compendium/data/treasure.json.
  //
  // This file used to say a drop table could not be built without tracing item creation
  // through 172 monster kod files. That was wrong, and it was wrong in the way worth
  // recording: the compendium had already done it — extract-treasure.mjs reads the
  // TreasureType classes rather than the monsters, which is where the tables actually
  // live, and each type already carries the list of monster classes that resolve to it.
  // 42 treasure ids, 38 tables, 435 rows, 171 monsters mapped, and every row cited.
  //
  // Optional on purpose. The index is still built without it, and every consumer treats
  // a missing `loot` as "unknown", never as "drops nothing".
  const loot = new Map();               // monster class (lower) -> loot record
  if (treasureFile) {
    let tre = null;
    try { tre = JSON.parse(readFileSync(treasureFile, 'utf8')); } catch { tre = null; }
    for (const [tid, t] of Object.entries(tre?.types ?? {})) {
      const rec = {
        tid,
        // chancePercent is that row's share of ONE roll of the table. A monster rolls
        // the table more than once (1 + level/55 + random(0, difficulty/3)), so this is
        // a per-roll share and not a per-kill probability. Named so nobody reads it as one.
        items: (t.items ?? []).map(i => ({
          item: i.cls, per_roll_percent: i.chancePercent, count: i.count ?? 1, cite: i.cite,
        })),
        money: t.money
          ? { min: t.money.min, max: t.money.max, per_roll_percent: t.money.chancePercent,
              cite: t.money.cite }
          : null,
        cite: t.classCite ?? t.cite ?? null,
      };
      for (const m of t.monsters ?? []) loot.set(String(m).toLowerCase(), rec);
    }
  }

  const byCls = new Map();
  for (const r of Object.values(map.rooms))
    if (r.cls) byCls.set(String(r.cls).toLowerCase(), r);

  // class name -> { display name, level, karma }
  const info = new Map();
  for (const m of mons) {
    if (!m.class) continue;
    const disp = m._res?.[m.vrName]?.[0] || m.class;
    info.set(m.class.toLowerCase(), {
      name: disp,
      level: m.viLevel != null ? Number(m.viLevel) : null,
      karma: m.viKarma != null ? Number(m.viKarma) : null,
      // DIFFICULTY, WHICH IS WHAT ACTUALLY DECIDES HOW HARD A THING HITS YOU.
      //
      // It was read out of monsters.json and thrown away, so everything downstream
      // ranked prey by LEVEL — and level is close to the opposite of danger here. A
      // fungus beast is level 50 difficulty 1; a baby spider is level 25 difficulty 4.
      // GetAttackAbility is 3*viLevel + 60*viDifficulty (monster.kod), so the fungus
      // beast rates 210 against the baby spider's 315 and a centipede's 390: the
      // level-50 creature is the SAFER fight by a wide margin, and a band that sorts on
      // level will not offer it while happily offering the things that kill us.
      difficulty: m.viDifficulty != null ? Number(m.viDifficulty) : null,
    });
  }

  const creatures = {};                 // display name (lower) -> { ..., sites }
  const rooms = {};                     // room number -> [ { creature, level, karma, chance, cap } ]
  let joined = 0, unjoined = 0;
  const missingRooms = new Set();

  for (const [cls, entries] of Object.entries(raw.byMonster || {})) {
    const meta = info.get(cls.toLowerCase()) || { name: cls, level: null, karma: null, difficulty: null };
    const sites = [];
    for (const e of entries) {
      const room = byCls.get(String(e.room).toLowerCase());
      if (!room) { unjoined++; missingRooms.add(e.room); continue; }
      joined++;
      const site = { room: room.num, room_name: room.name, how: e.how,
                     chance: e.chance, cap: e.cap, count: e.count, cite: e.cite };
      sites.push(site);
      (rooms[room.num] ||= []).push({ creature: meta.name, cls, level: meta.level,
                                      difficulty: meta.difficulty,
                                      attack_rating: attackRating(meta),
                                      karma: meta.karma, chance: e.chance, cap: e.cap,
                                      // `generator` means the room keeps making these.
                                      // `create` means one was placed at construction —
                                      // a shopkeeper, a guard, a set piece. Quintor the
                                      // blacksmith is a `create`, which is why "does this
                                      // room spawn anything" said YES about a smithy.
                                      how: e.how, huntable: e.how === 'generator' });
    }
    creatures[meta.name.toLowerCase()] = { name: meta.name, cls, level: meta.level,
                                           difficulty: meta.difficulty,
                                           attack_rating: attackRating(meta),
                                           karma: meta.karma, sites,
                                           ...(loot.has(cls.toLowerCase())
                                                 ? { loot: loot.get(cls.toLowerCase()) } : {}) };
  }

  // Precompute the danger of each room once: the toughest thing its table can
  // produce. This is the number that decides whether a room is survivable, and it
  // is not the level of what you came to kill.
  const danger = {};
  for (const [num, list] of Object.entries(rooms)) {
    const worst = list.reduce((a, b) => ((b.level ?? 0) > (a?.level ?? 0) ? b : a), null);
    danger[num] = { toughest: worst?.creature ?? null, level: worst?.level ?? null,
                    kinds: list.length };
  }

  const withLoot = Object.values(creatures).filter(c => c.loot).length;
  const out = { creatures, rooms, danger,
                stats: { creatures: Object.keys(creatures).length, rooms: Object.keys(rooms).length,
                         sites_joined: joined, sites_unjoined: unjoined,
                         creatures_with_loot: withLoot,
                         unmapped_rooms: [...missingRooms].slice(0, 40) } };
  if (outFile) writeFileSync(outFile, JSON.stringify(out));
  return out;
}

let cached;
export function loadSpawns(file) {
  if (cached !== undefined) return cached;
  try { cached = JSON.parse(readFileSync(file, 'utf8')); } catch { cached = null; }
  return cached;
}

// Every room that generates something matching `want`, best chance first.
//
// `maxDanger` is the whole point of the call: it drops rooms whose table can also
// produce something too strong, which is the check that distinguishes room 566 from
// room 603. Both list giant rats; one of them also rolls a level-35 groundworm larva
// seven times in ten.
export function huntingGrounds(spawns, want, { maxDanger = null, limit = 12 } = {}) {
  if (!spawns) return [];
  const needle = String(want).toLowerCase();
  const hits = Object.values(spawns.creatures)
    .filter(c => c.name.toLowerCase().includes(needle) || c.cls.toLowerCase() === needle);
  // Only rooms that GENERATE the creature are hunting grounds. A room that merely
  // had one placed at construction will never make another, so it is a location,
  // not a source.
  const generates = (roomNum, name) => (spawns.rooms[roomNum] || [])
    .some(x => x.huntable && x.creature === name);
  const rows = [];
  for (const c of hits) {
    for (const s of c.sites) {
      if (s.how && s.how !== 'generator' && !generates(s.room, c.name)) continue;
      const here = spawns.rooms[s.room] || [];
      // THE THREAT CEILING IS ABOUT BYSTANDERS, NOT ABOUT THE PREY.
      //
      // Prey has to be ABOVE your level to pay anything at all — AdvancementCheck
      // needs monster_level > base_max_health — so measuring a room's danger with
      // the prey included rejects every room worth being in. A level-23 character
      // hunting level-30 giant rats had a ceiling of 29 and was told that all four
      // rat rooms were too dangerous, which left it with nowhere to go; nineteen
      // characters ended up standing in shops and inns because of it.
      //
      // What the ceiling is actually for is the thing you did NOT choose to fight:
      // the level-35 larva sharing a room with the rats, the level-50 spider next to
      // the ants. So exclude the quarry and judge the rest.
      const _others = here.filter(x => x.cls !== c.cls);
      // JUDGE THE NEIGHBOURS BY WHAT THEY HIT WITH, NOT BY THEIR LEVEL.
      //
      // Level is close to the opposite of danger here. GetAttackAbility is
      // 3*viLevel + 60*viDifficulty (monster.kod), so difficulty dominates at sixty per
      // point against three: a fungus beast is level 50 difficulty 1 and rates 210,
      // while a baby spider is level 25 difficulty 4 and rates 315 and a centipede
      // level 30 difficulty 5 rates 390. Damage per blow does scale with level —
      // Fuzzy(viLevel/Random(10,15)) — but difficulty decides how often a blow lands
      // at all, and that is what kills.
      //
      // Judging on level alone rejected rooms for containing the second-safest creature
      // in the game. "something OTHER than your prey here is level 50, above your limit
      // of 32" was a fungus beast, and rooms were thrown out for it while rooms full of
      // centipedes passed. Nine characters were left unplaceable, wandered instead of
      // hunting, and every creature on the death list — ant, spider, centipede, slime,
      // baby spider — is a difficulty-4-or-worse one.
      //
      // The ceiling is expressed in levels, so compare like with like: convert it to a
      // rating with the same formula at difficulty 1, which is what a caller passing
      // "level 32" has always meant to say — that much of a threat, no more.
      // The level test stays as it is, and a room it rejects gets ONE second chance: if
      // everything objectionable in it hits no harder than a fungus beast, keep it.
      //
      // Written this way on purpose. A threshold expressed directly in ratings would need
      // calibrating against how much punishment each level can take, and I do not have
      // that; guessing it low leaves the fleet unplaceable and guessing it high walks it
      // into centipedes. This can only ADD rooms the old rule threw away, never remove
      // one it allowed, so the worst case is the behaviour we already had.
      //
      // FORGIVING_RATING is the fungus beast: level 50, difficulty 1, rating 210, and the
      // creature this fleet demonstrably farms without dying to it. Anything at or under
      // that is not what is killing us — every creature on the death list (ant 360,
      // spider 390, centipede 390, slime 345, baby spider 315) is well above it.
      const others = _others;
      const worstOther = others.reduce((m, x) => Math.max(m, x.level ?? 0), 0);
      const d = spawns.danger[s.room] || {};
      const overLevel = maxDanger != null && worstOther > maxDanger;
      // Unknown difficulty means unknown danger, and unknown is not forgiven.
      const ratings = others.map(x => attackRating(x));
      const allGentle = ratings.length > 0 && ratings.every(r => r != null && r <= FORGIVING_RATING);
      const tooHot = overLevel && !allGentle;
      rows.push({
        room: s.room, room_name: s.room_name,
        creature: c.name, level: c.level, karma: c.karma,
        chance: s.chance, cap: s.cap, how: s.how,
        toughest_here: d.level != null ? `${d.toughest} (${d.level})` : null,
        also_here: here.filter(x => x.cls !== c.cls)
                       .sort((a, b) => (b.level ?? 0) - (a.level ?? 0))
                       .map(x => `${x.creature} ${x.level}${x.chance ? ` @${x.chance}%` : ''}`),
        ...(tooHot ? { rejected: `something OTHER than your prey here is level ${worstOther}, ` +
                                 `above your limit of ${maxDanger}` } : {}),
        ...(overLevel && allGentle
              ? { allowed_anyway: `level ${worstOther} is over the ${maxDanger} limit, but nothing ` +
                                  `here hits harder than ${Math.max(...ratings)} — a fungus beast ` +
                                  `rates 210 and a centipede 390` } : {}),
      });
    }
  }
  // RANK BY THE PREY'S SHARE OF THE ROOM, not by its raw spawn chance.
  //
  // Two rooms can both list centipedes at 50%, and be completely different places to
  // stand: one where the rest of the table is also centipedes, and one where the
  // other half is baby spiders that will attack you while you fight. Everything in a
  // room comes for you; only the share you are hunting pays you anything.
  //
  // This is not theoretical. Every room a Qor character may legally hunt in is 50-75%
  // baby spider and only 25-50% centipede — they are the one faction hunting the
  // MINORITY spawn everywhere they can go, and they accounted for thirteen of the
  // fleet's last twenty deaths.
  const share = (r) => {
    const here = spawns.rooms[r.room] || [];
    const total = here.reduce((a, x) => a + (x.chance ?? 0), 0);
    return total ? (r.chance ?? 0) / total : 0;
  };
  for (const r of rows) {
    r.share_of_room = +(share(r) * 100).toFixed(0);
    r.bystanders = (spawns.rooms[r.room] || [])
      .filter(x => x.cls !== rows.find(y => y === r)?.cls && x.creature !== r.creature)
      .reduce((a, x) => a + (x.chance ?? 0), 0);
  }
  const ok = rows.filter(r => !r.rejected)
    // Share first, then raw chance to break ties. A room that is mostly your prey is
    // worth more than a busier room that is mostly something else.
    .sort((a, b) => (b.share_of_room ?? 0) - (a.share_of_room ?? 0) || (b.chance ?? 0) - (a.chance ?? 0));
  const bad = rows.filter(r => r.rejected).sort((a, b) => (b.chance ?? 0) - (a.chance ?? 0));
  // Rejected rooms are RETURNED, not hidden — a caller that cannot see why the
  // obvious room was skipped will keep trying to send characters there.
  return [...ok.slice(0, limit), ...bad.slice(0, 4)];
}

// WHAT SHOULD THIS CHARACTER BE KILLING RIGHT NOW.
//
// Two hard constraints, and they pull against each other.
//
// PAYS: AdvancementCheck only rolls when monster_level > base_max_health. Max health
// IS the level, so prey at or below your own level pays literally nothing — a room
// full of level-25 mummies is worthless to a level-25 character, and fifteen of mine
// ground away in one for the best part of an hour proving it.
//
// SURVIVABLE: and yet the prey must be ABOVE your level to pay at all, so "nothing
// above my level" is not available as a safety rule. `over` is the usable band, and
// what actually decides survival is not the prey but the TOUGHEST thing the room's
// table can roll — the level-35 larva sharing a room with the level-30 rats.
//
// KARMA is the third constraint and applies to the schools. A kill is an act worth
// the NEGATIVE of the victim's karma, so killing something evil pushes you good and
// vice versa:
//   want: 'evil'    (Qor)       kill POSITIVE-karma creatures
//   want: 'good'    (Shal'ille) kill NEGATIVE-karma creatures
//   want: 'neutral'             kill karma-0 creatures — no karma moves at all, so
//                               this is the prey that suits ANY character, and it is
//                               the only thing that works for a Qor student between
//                               level 30 and 50, where every positive-karma creature
//                               in the world is far too strong.
export function preyFor(spawns, level, { want = null, over = 6, limit = 6 } = {}) {
  if (!spawns || !level) return [];
  const karmaOk = (k) => {
    if (want === 'evil') return k != null && k > 0;
    if (want === 'good') return k != null && k < 0;
    if (want === 'neutral') return k === 0;
    return true;
  };
  // `ceiling` null means "accept any room" — used only by the relaxed second pass.
  const gather = (ceiling) => {
    const out = [];
    for (const c of Object.values(spawns.creatures)) {
      if (c.level == null || c.level <= level || c.level > level + over) continue;
      if (!karmaOk(c.karma)) continue;
      let rooms = huntingGrounds(spawns, c.name, { maxDanger: ceiling, limit: 20 })
        .filter(r => !r.rejected && r.creature === c.name);
      if (!rooms.length) continue;
      // With a ceiling in force every surviving room is safe, so rank by how much
      // prey it produces. WITHOUT one, every room is over the line and ranking by
      // prey chance is actively dangerous: it picked, for a level-35 character, the
      // room with the best ant density AND a level-100 groundworm on 40% of the
      // table. When nothing is safe, the question stops being "where is the most
      // prey" and becomes "where is the least likely to kill me".
      if (ceiling == null) {
        const risk = (r) => {
          const here = spawns.rooms[r.room] || [];
          const bad = here.filter(x => (x.level ?? 0) > level + over);
          const share = bad.reduce((a, x) => a + (x.chance ?? 0), 0);
          const worst = bad.reduce((a, x) => Math.max(a, x.level ?? 0), 0);
          return share * 1000 + worst;          // share dominates; level breaks ties
        };
        rooms = rooms.sort((a, b) => risk(a) - risk(b) || (b.chance ?? 0) - (a.chance ?? 0));
      }
      const best = rooms[0];
      const overLevel = (spawns.rooms[best.room] || [])
        .filter(x => (x.level ?? 0) > level + over);
      out.push({
        creature: c.name, level: c.level, karma: c.karma,
        pushes: c.karma == null ? 'unknown' : c.karma > 0 ? 'you toward evil'
              : c.karma < 0 ? 'you toward good' : 'nothing — karma-neutral',
        best_room: best.room, best_room_name: best.room_name,
        chance: best.chance, cap: best.cap,
        rooms: rooms.map(r => r.room),
        ...(overLevel.length ? { risk: overLevel.map(x =>
              `${x.creature} is level ${x.level}${x.chance ? ` and takes ${x.chance}% of this room's table` : ''}`) }
          : {}),
      });
    }
    // Highest qualifying level first: the fastest advancement still inside the band.
    return out.sort((a, b) => b.level - a.level).slice(0, limit);
  };

  const safe = gather(level + over);
  if (safe.length) return safe;

  // NOTHING CLEAN EXISTS, WHICH IS A FACT ABOUT THE WORLD AND NOT A FAILURE.
  // Between roughly level 35 and 45 every room that generates the right prey also
  // generates level-50 spiders — the ants live with them, and there is no third
  // room. Returning an empty list here would read as "no prey exists" and park a
  // character at 35 forever. Return the best compromise instead, labelled, so the
  // caller can decide whether the keeper's flee threshold covers it.
  return gather(null).map(p => ({ ...p, compromise: true,
    note: 'no room generates this without something well above your level; the ' +
          'keeper must be set to withdraw early' }));
}

// THE ROOM'S TOTAL MONSTER CAP, and it is a TOTAL — not a per-creature one.
//
// monsroom.kod:242 IsMonsterCountBelowMax gates the WHOLE generator on
// `piMonster_count < piMonster_count_max`, and only then rolls the weighted table to
// decide which creature. So the room does not keep a quota per species: whatever is
// standing in it occupies the same pool.
//
// The consequence is the one nobody plans for. A fleet that hunts centipedes and ignores
// baby spiders does not get a room of centipedes — it gets a room of baby spiders, and
// then a room of nothing, because the spiders it declined to kill fill the cap and the
// generator stops rolling at all. Found live: East Merchant Way, cap 10, eight baby
// spiders and two centipedes, with five characters in it hunting centipedes.
// HOW HARD IT HITS, from the game's own formula rather than from its level.
//
//   GetAttackAbility = 3 * viLevel + 60 * viDifficulty     (monster.kod)
//
// Damage per blow is Fuzzy(viLevel / Random(10,15)) and depends on level alone, so level
// still says how much a landed blow costs. Difficulty says how OFTEN one lands, and it
// dominates: sixty per point against three. Null when the kod does not declare a
// difficulty — say so rather than assuming the safe value, because assuming safety is how
// a fleet walks into a centipede.
// The fungus beast: level 50, difficulty 1, rating 210 — the creature this fleet farms
// without dying to it. Used as "gentle enough to share a room with".
export const FORGIVING_RATING = 210;

export function attackRating(m) {
  if (!m || m.level == null || m.difficulty == null) return null;
  return 3 * Number(m.level) + 60 * Number(m.difficulty);
}

export function roomCap(spawns, roomNum) {
  const list = spawns?.rooms?.[roomNum];
  if (!list?.length) return null;
  for (const e of list) if (e.cap != null) return e.cap;
  return null;
}

// WOULD KILLING THIS MOVE OUR KARMA THE WRONG WAY?
//
// A kill is an act worth the NEGATIVE of the victim's karma, so killing something
// positive pushes you evil and killing something negative pushes you good. `want` is
// the school being protected, and it reads backwards for exactly that reason.
//
// Unknown karma is NOT treated as forbidden. A prohibition invented from missing data
// would quietly stop a character clearing a room, and the failure would look like
// idleness rather than like a rule.
export function karmaSafe(creatureKarma, want) {
  if (!want || creatureKarma == null) return true;
  if (want === 'evil') return creatureKarma > 0;
  if (want === 'good') return creatureKarma < 0;
  if (want === 'neutral') return creatureKarma === 0;
  return true;
}

// What is in a room, worst first. The other half of the same question.
export function roomThreats(spawns, roomNum) {
  const list = spawns?.rooms?.[roomNum];
  if (!list) return null;
  return [...list].sort((a, b) => (b.level ?? 0) - (a.level ?? 0));
}

// ===================================================== WHAT THE FARMING IS *FOR*
//
// `preyFor` above answers exactly one question: what is worth killing to gain a HIT
// POINT. That was the only goal the fleet had, and it is not the only goal a character
// has. Farming divides into three purposes, and they rank prey differently:
//
//   money    sell what drops. Nearly everything drops something, so almost nothing is
//            disqualified; the ranking is safety first, then whatever advancement
//            happens to come free alongside the money.
//   items    a named thing — orc teeth, inky cap mushrooms. Searches the drop index by
//            item name; a caller may still name creatures directly. See THE DROP INDEX.
//   advance  raise something specific: max health, a skill, or a spell. Those three
//            advance under three DIFFERENT rules, and confusing them is how a
//            character grinds for an hour and gains nothing.
//
// -------------------------------------------------------------- THE THREE RULES
//
// Derived from the kod, not from playing memory. `node tools/m59-progression.mjs check`
// re-reads the constants, so this cannot quietly drift away from the game.
//
// HIT POINTS — player.kod:7736 AdvancementCheck
//   Rolls only when `monster_level > piBase_Max_health`. Prey at or below your own
//   level pays literally nothing. Stops entirely at `piBase_Max_health >= 101+stamina`.
//   The roll improves with the gap: `bound((monster_level - max_health)/5, 0, 10)`.
//   NOT subject to the advancement-point cap — there is no CheckAdvancementPoints call
//   anywhere in that path. Hit points are an uncapped track.
//
// SKILLS — skill.kod:294 ImproveAbility, factor at :414
//   factor = bound(2*difficulty - iAbility + 10, 50, 100),  difficulty = monster level
//   BUT for a SKILL, `iAbility` is read with `Send(who,@GetSpellAbility,#spell_num=
//   viSkill_num)` — a SPELL-table lookup keyed by a SKILL number. It yields 0. So:
//
//     *** A SKILL'S IMPROVE CHANCE DOES NOT DEPEND ON YOUR CURRENT SKILL PERCENT. ***
//
//   factor collapses to bound(2*level + 10, 50, 100): flat below level 20, rising to
//   level 45, saturated above it. Rats are exactly as good for slash at 31% as at 11% —
//   they are simply worse than a level-45 monster, at every ability. This is a bug in
//   the game, it is load-bearing here, and it is the one place where the obvious
//   intuition ("I have outgrown rats for slash") is wrong.
//
// SPELLS — same formula, real ability
//   Here `iAbility` IS the spell's ability, so the chance DOES fall as ability rises,
//   and collapses at the softcap once ability >= 2 x the requisite stat. One trap:
//   `difficulty` defaults to 60 and a MONSTER TARGET REPLACES IT with the monster's
//   level. Casting at a level-30 rat is therefore WORSE than casting at no monster at
//   all. Break-even is a level-60 monster.
//
// ------------------------------------------------------------ THE SHARED CEILING
//
// player.kod:7630 AddAdvancementPoints — "A player can only gain so many advancement
// points per hour, in spells / And skills combined." Ten per 15-22 minute window, with
// 2 refunded per room change (player.kod:1465, commented "give them a break on the
// botting imp cap").
//
// So the pools are NOT symmetric, and this is what decides how goals combine:
//
//   hit points          uncapped   — stacks with anything, for free
//   skills + spells     ONE shared capped pool
//
// Killing something above your max health with your weapon advances both tracks at
// once and the two do not compete. Chasing a skill AND a spell together does compete:
// the cap binds long before the odds do, so a second capped goal diversifies what you
// gain without raising throughput. combine() below encodes exactly that asymmetry.
//
// ------------------------------------------------------------------- THE DROP INDEX
//
// This block used to say a drop table could not be built, on the grounds that monsters
// carry items in inventory and spill them into a DeadBody (monster.kod:3056), so drops
// would have to be traced per-monster across ~172 kod files. That was wrong, and the
// mistake is worth keeping written down: I searched the MONSTERS for a loot list and
// concluded from finding none that there was none to find.
//
// The tables are not on the monsters. They are TreasureType classes — one per TID, with
// weighted rows — and `compendium/data/treasure.json` has held all of them the whole
// time: 42 treasure ids, 38 tables, 435 rows, 132 distinct items, 171 monsters mapped,
// zero unresolved, every row carrying its kod cite. buildSpawnIndex now joins it in, so
// every creature in the index carries `loot`.
//
// What the index does NOT cover, and neither does anything downstream:
//   * things that GROW IN ROOMS rather than dropping. Inky caps are generated by
//     kcforest/ka0.kod and marcry3a.kod. They are also a drop, which is exactly why
//     "is it a drop" is not answerable by intuition.
//   * merchant stock, and anything else acquired by trade rather than by killing.
// A creature with no `loot` key is UNKNOWN, never "drops nothing".

export const PURPOSES = ['money', 'items', 'advance'];

// WHO DROPS THIS.
//
// The caller types what the thing is called out loud and the kod holds a class name, and
// the two disagree in the ordinary ways: "orc teeth" against `OrcTooth`, "inky cap
// mushrooms" against `InkyCap`. A plain substring match answers "nothing drops that" to a
// perfectly good question, which is the worst available answer because it reads as a fact
// about the world rather than about the spelling.
//
// So: strip punctuation, singularise each word, and match if the joined form appears in
// the class name OR every word does. `suggest` exists for the remaining misses — an
// unmatched query should come back with the near names, not with silence.
const IRREGULAR = { teeth: 'tooth', feet: 'foot', mice: 'mouse', geese: 'goose',
                    children: 'child', men: 'man', women: 'woman', leaves: 'leaf',
                    knives: 'knife', wolves: 'wolf', lice: 'louse' };
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const singular = (w) => IRREGULAR[w]
  ?? (w.endsWith('ies') && w.length > 4 ? `${w.slice(0, -3)}y`
    : w.endsWith('ses') || w.endsWith('xes') || w.endsWith('hes') ? w.slice(0, -2)
    : w.endsWith('s') && !w.endsWith('ss') && w.length > 3 ? w.slice(0, -1) : w);
const words = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(singular);

export function whoDrops(spawns, item) {
  if (!spawns || !item) return [];
  const toks = words(item);
  if (!toks.length) return [];
  const joined = toks.join('');
  const matches = (cls) => {
    const n = norm(cls);
    // Three ways round, because callers both abbreviate and elaborate. "orc teeth" is
    // SHORTER than nothing and matches by tokens; "inky cap mushrooms" is LONGER than
    // `InkyCap` and matches only because the query contains the class name. The length
    // guard on that third case stops a three-letter class matching half the world.
    return n.includes(joined) || (n.length >= 4 && joined.includes(n))
        || toks.every(t => n.includes(t));
  };
  const out = [];
  for (const c of Object.values(spawns.creatures ?? {})) {
    const hit = (c.loot?.items ?? []).find(i => matches(i.item));
    if (hit) out.push({ creature: c.name, level: c.level, karma: c.karma,
                        item: hit.item, per_roll_percent: hit.per_roll_percent, cite: hit.cite });
  }
  return out.sort((a, b) => (b.per_roll_percent ?? 0) - (a.per_roll_percent ?? 0));
}

// Every item the drop index knows, for the "did you mean" on a miss.
export function knownDrops(spawns) {
  const s = new Set();
  for (const c of Object.values(spawns?.creatures ?? {}))
    for (const i of c.loot?.items ?? []) s.add(i.item);
  return [...s].sort();
}

// Near names for a query that matched nothing: anything sharing one of its words.
export function suggestDrops(spawns, item, limit = 8) {
  const toks = words(item);
  return knownDrops(spawns)
    .filter(n => toks.some(t => t.length > 2 && norm(n).includes(t)))
    .slice(0, limit);
}

// What one kill is worth in shillings, at the midpoint of the money range. Used only to
// ORDER candidates for `money` — the absolute number is a table midpoint, not a forecast,
// because the roll count varies with level and difficulty and the server's ItemFactor.
export const moneyPerKill = (c) => {
  const m = c?.loot?.money;
  if (!m) return null;
  return ((m.min + m.max) / 2) * ((m.per_roll_percent ?? 0) / 100);
};

// The advancement ceiling, and the reason a hit-point goal can be *finished*.
export const healthCeiling = (stamina) => 101 + (stamina ?? 0);

// One goal's opinion of one creature, normalised to 0..1 so goals can be added up.
// `pays: false` means this creature does nothing for this goal — for `advance` that
// disqualifies it, for `money` it merely scores no bonus.
export function goalYield(goal, creature, { maxHealth, stamina = 0 } = {}) {
  const level = creature.level;
  if (level == null) return { goal: goal.kind, pays: false, why: 'creature level unknown' };

  if (goal.kind === 'hp') {
    if (maxHealth >= healthCeiling(stamina))
      return { goal: 'hp', pays: false, done: true,
               why: `max health ${maxHealth} is at the ceiling of ${healthCeiling(stamina)} ` +
                    `(101 + stamina ${stamina}) — no kill raises it again` };
    if (level <= maxHealth)
      return { goal: 'hp', pays: false,
               why: `level ${level} is not above max health ${maxHealth}; AdvancementCheck never rolls` };
    // The roll bonus is the only part prey choice controls. It saturates 50 levels up,
    // which no safety band will ever reach, so inside the band higher is always better.
    const edge = Math.min(Math.max((level - maxHealth) / 5, 0), 10) / 10;
    return { goal: 'hp', pays: true, capped: false, value: 0.5 + 0.5 * edge,
             why: `level ${level} is ${level - maxHealth} above max health ${maxHealth}` };
  }

  if (goal.kind === 'skill') {
    // iAbility is 0 for skills — the GetSpellAbility lookup bug. Current percent is
    // deliberately NOT read here; including it would encode a rule the game does not have.
    const factor = Math.min(Math.max(2 * level + 10, 50), 100);
    const saturated = level >= 45;
    return { goal: `skill:${goal.name ?? '?'}`, pays: true, capped: true, value: factor / 100,
             why: `improve factor ${factor}/100 at monster level ${level}` +
                  (saturated ? ' (saturated — nothing above level 45 improves this further)'
                             : `; a level-45 target would give 100`),
             note: goal.ability != null
               ? `current ability ${goal.ability}% is irrelevant to a SKILL's improve chance ` +
                 `(skill.kod:414 reads the spell table by skill number and gets 0)`
               : undefined };
  }

  if (goal.kind === 'spell') {
    const ability = goal.ability ?? 0;
    const requisite = goal.requisite ?? null;
    if (requisite != null && ability >= 2 * requisite)
      return { goal: `spell:${goal.name ?? '?'}`, pays: false, softcapped: true,
               why: `ability ${ability} is at or past the softcap of 2 x requisite stat ` +
                    `${requisite} = ${2 * requisite}; the improve chance has collapsed` };
    const factor = Math.min(Math.max(2 * level - ability + 10, 50), 100);
    // The honest comparison is not "does this help" but "does this beat not targeting a
    // monster at all", because difficulty falls back to 60 without a monster target.
    const baseline = Math.min(Math.max(2 * 60 - ability + 10, 50), 100);
    return { goal: `spell:${goal.name ?? '?'}`, pays: factor >= baseline, capped: true,
             value: factor / 100,
             why: factor >= baseline
               ? `improve factor ${factor}/100 at monster level ${level}, at or above the ` +
                 `no-monster baseline of ${baseline}`
               : `improve factor ${factor}/100 at monster level ${level} is BELOW the ${baseline} ` +
                 `you would get casting at no monster — this prey actively costs you` };
  }

  return { goal: String(goal.kind), pays: false, why: `unknown goal kind ${goal.kind}` };
}

// How several goals add up for one creature. See THE SHARED CEILING: hit points are a
// separate uncapped track and stack freely; skills and spells share one capped pool, so
// the best capped goal sets the throughput and further capped goals add only a little.
const SECOND_CAPPED_GOAL_BONUS = 0.15;
function combine(yields) {
  const paying = yields.filter(y => y.pays);
  const uncapped = paying.filter(y => !y.capped).reduce((a, y) => a + (y.value ?? 0), 0);
  const capped = paying.filter(y => y.capped).map(y => y.value ?? 0).sort((a, b) => b - a);
  const cappedScore = capped.length
    ? capped[0] + SECOND_CAPPED_GOAL_BONUS * capped.slice(1).reduce((a, v) => a + v, 0)
    : 0;
  return { score: uncapped + cappedScore, satisfied: paying.length };
}

// WHAT SHOULD THIS CHARACTER BE KILLING, GIVEN WHAT IT IS TRYING TO GET.
//
// This RANKS and EXPLAINS. It does not choose, and nothing in the keeper calls it — prey
// selection stays with whoever is driving over MCP, because the trade-off between money,
// items and advancement is a decision about what the character is for, and the keeper
// has no business inventing one. See the keeper's `hunt`, which is still never guessed.
//
// `character`: { maxHealth, stamina }.  `goals`: [{kind:'hp'} | {kind:'skill',name,ability}
// | {kind:'spell',name,ability,requisite}].  `want`: karma school, as preyFor.
export function scorePrey(spawns, character, {
  purpose = 'advance', goals = [], over = 6, limit = 8, want = null, creatures = null,
  item = null,
} = {}) {
  if (!spawns) return { purpose, candidates: [], note: 'no spawn index loaded' };
  if (!PURPOSES.includes(purpose))
    return { purpose, candidates: [], note: `unknown purpose — one of ${PURPOSES.join(', ')}` };

  const maxHealth = character?.maxHealth ?? 0;
  const stamina = character?.stamina ?? 0;
  if (!maxHealth)
    return { purpose, candidates: [], note: 'character max health unknown; every rule keys on it' };

  // A finished goal is worth saying out loud rather than silently scoring zero for ever.
  const finished = goals
    .map(g => goalYield(g, { level: maxHealth + 1 }, { maxHealth, stamina }))
    .filter(y => y.done || y.softcapped)
    .map(y => ({ goal: y.goal, why: y.why }));

  // `items` searches the drop index imported from the compendium. A caller may still name
  // creatures instead, for a thing the index does not know about.
  let dropChance = null;
  if (purpose === 'items') {
    if (!item && !creatures?.length)
      return { purpose, candidates: [], finished,
               note: 'say what you are farming: pass `item` (e.g. "orc teeth") to search the ' +
                     'drop index, or `creatures` to name the quarry yourself.' };
    if (item) {
      const drops = whoDrops(spawns, item);
      if (!drops.length) {
        const near = suggestDrops(spawns, item);
        return { purpose, item, candidates: [], finished,
                 ...(near.length ? { did_you_mean: near } : {}),
                 note: `no monster treasure table lists anything matching "${item}". The index ` +
                       'covers monster drops only: things that grow in rooms and things sold by ' +
                       'merchants are not drops and will never appear here, however common they ' +
                       'are in the world.' };
      }
      dropChance = new Map(drops.map(d => [d.creature.toLowerCase(), d]));
    }
  }

  const pool = dropChance
    ? Object.values(spawns.creatures).filter(c => dropChance.has(c.name.toLowerCase()))
    : creatures?.length
      ? Object.values(spawns.creatures).filter(c =>
          creatures.some(n => c.name.toLowerCase().includes(String(n).toLowerCase())))
      : Object.values(spawns.creatures);

  const karmaOk = (k) => want === 'evil' ? (k != null && k > 0)
                       : want === 'good' ? (k != null && k < 0)
                       : want === 'neutral' ? k === 0 : true;

  const ceiling = maxHealth + over;
  const rows = [];
  for (const c of pool) {
    if (c.level == null || !karmaOk(c.karma)) continue;
    // The safety band is the one rule every purpose obeys. It is about the room's whole
    // table, not the quarry — huntingGrounds rejects on the worst OTHER thing present.
    if (c.level > ceiling) continue;

    const yields = goals.map(g => goalYield(g, c, { maxHealth, stamina }));
    const { score, satisfied } = combine(yields);
    // `advance` is the purpose with teeth: prey that pays no goal is not a candidate.
    // `money` and `items` keep it — anything sellable is acceptable — and treat the
    // advancement score purely as a tie-breaker, which is the whole point of the
    // "hunt what pays twice" preference.
    if (purpose === 'advance' && satisfied === 0) continue;

    const rooms = huntingGrounds(spawns, c.name, { maxDanger: ceiling, limit: 20 })
      .filter(r => !r.rejected && r.creature === c.name);
    if (!rooms.length) continue;
    const best = rooms[0];

    const money = moneyPerKill(c);
    const drop = dropChance?.get(c.name.toLowerCase());
    rows.push({
      creature: c.name, level: c.level, karma: c.karma,
      score: +score.toFixed(3), goals_satisfied: satisfied, goals_total: goals.length,
      best_room: best.room, best_room_name: best.room_name,
      chance: best.chance, share_of_room: best.share_of_room, rooms: rooms.map(r => r.room),
      ...(drop ? { drops: drop.item, drop_per_roll_percent: drop.per_roll_percent,
                   drop_cite: drop.cite } : {}),
      ...(money != null ? { money_per_kill: +money.toFixed(1) } : {}),
      ...(c.loot ? {} : { loot: 'unknown — this creature is not in the drop index' }),
      pays: yields.filter(y => y.pays).map(y => `${y.goal}: ${y.why}`),
      pays_nothing_for: yields.filter(y => !y.pays).map(y => `${y.goal}: ${y.why}`),
      notes: yields.map(y => y.note).filter(Boolean),
    });
  }

  // MULTI-GOAL PREY FIRST, whatever the purpose. That is the "satisfies more criteria"
  // preference, and it leads deliberately: two half-good tracks beat one excellent one
  // when they draw on different pools. What breaks the tie is what the farming is FOR —
  // shillings for money, drop share for items, advancement score for advance. With no
  // goals set, `money` is therefore ranked purely on money, which is what you want.
  const tiebreak = purpose === 'money'
    ? (a, b) => (b.money_per_kill ?? -1) - (a.money_per_kill ?? -1)
    : purpose === 'items'
      ? (a, b) => (b.drop_per_roll_percent ?? -1) - (a.drop_per_roll_percent ?? -1)
      : () => 0;
  rows.sort((a, b) => b.goals_satisfied - a.goals_satisfied
                   || tiebreak(a, b)
                   || b.score - a.score
                   || (b.share_of_room ?? 0) - (a.share_of_room ?? 0));

  const out = { purpose, band: { max_level: ceiling, why: `max health ${maxHealth} + over ${over}` },
                candidates: rows.slice(0, limit) };
  if (item) out.item = item;
  if (finished.length) out.finished = finished;
  const unknown = rows.filter(r => r.loot).length;
  if (purpose === 'money')
    out.note = 'money_per_kill is the treasure table\'s midpoint times its chance, for ORDERING ' +
               'only — the real yield also depends on how many times the table is rolled ' +
               '(1 + level/55 + random(0, difficulty/3)) and on the server\'s ItemFactor. ' +
               'Goals still lead the ranking, so prey that pays twice comes first.' +
               (unknown ? ` ${unknown} of these are not in the drop index and are ranked last.` : '');
  // The single most useful thing to say when a skill goal is in play: what is stopping you.
  if (goals.some(g => g.kind === 'skill') && ceiling < 45)
    out.limited_by = `the safety band (${ceiling}), not the rule — a skill improves fastest ` +
                     `against level-45 prey, which is ${45 - ceiling} above what this ` +
                     `character can safely fight.`;
  return out;
}

if (process.argv[1]?.endsWith('m59-spawns.mjs')) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const idx = buildSpawnIndex({
    spawnsFile: root + 'compendium/data/spawns.json',
    mapFile: root + 'substrate/m59-map.json',
    monstersFile: root + 'tools/monsters.json',
    treasureFile: root + 'compendium/data/treasure.json',
    outFile: root + 'substrate/m59-spawns.json',
  });
  console.log(JSON.stringify({ ...idx.stats, unmapped_rooms: idx.stats.unmapped_rooms.length }));
  for (const w of ['giant rat', 'centipede']) {
    console.log(`\n${w} (nothing above level 32):`);
    for (const r of huntingGrounds(idx, w, { maxDanger: 32, limit: 6 }))
      console.log(`  ${String(r.room).padStart(4)} ${String(r.room_name).slice(0, 34).padEnd(35)} ` +
                  `${String(r.chance ?? '?').padStart(3)}% cap ${String(r.cap ?? '?').padStart(2)}  ` +
                  `${r.rejected ? 'REJECTED: ' + r.rejected : 'also: ' + (r.also_here.join(', ') || 'nothing')}`);
  }
}
