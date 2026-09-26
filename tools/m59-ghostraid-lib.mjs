// THE GHOST RAID'S SHARED ARITHMETIC — roles, hand-overs, reagents, barriers and the report.
//
// Pure except for `barrier`, which is a rendezvous between agents running in ONE process
// (fleetScript runs every agent of a run in the same process, so a module-level map is the
// whole of the coordination — the same arrangement `raid-arm.mjs` uses for its weapon pile).
// Everything else takes plain data and returns plain data, so `m59-ghostraid-test.mjs` can
// pin it without a broker.
//
// Read `docs/m59-raid-farnohl.md` first. The short version of why each helper exists:
//
//   * The weapon IS the fight: the ghost resists ATCK_WEAP_NONMAGIC 90 and takes -50 from
//     ATCK_WEAP_MAGIC (ghost.kod:83). `enchant weapon` is the Kraanan dedication
//     ("Your %s is now dedicated to Kraanan.", enchwp.kod:19) and it sets that flag.
//   * The HAMMER is the farm: every Skeleton takes -20 from ATCK_WEAP_BLUDGEON and resists
//     THRUST/PIERCE 70 (skel.kod:75-82), and `TuskedSkeleton is Skeleton` (tuskskel.kod).
//     The ghost does not care what KIND of blow lands, only whether it is magic, so a
//     dedicated hammer is the right weapon for both halves of this errand.
//   * The ghost is AI_FIGHT_WIZARD_KILLER (ghost.kod), and the one character who can cast
//     forces of light has TWENTY maximum health. So the light-bearer does not stand in the
//     room: forces of light is a ROOM enchantment with a timer on the room (forceslt.kod
//     RoomStartEnchantment), it outlives its caster's presence, and it casts without a
//     trance. Walk in, cast, walk out, come back before it lapses.

export const GHOST_ROOM = 40;          // The Throne Room of Victoria Castle
export const DOOR_ROOM = 38;           // Castle Victoria — the room the throne room opens off

/**
 * THE THRONE ROOM'S SPAWN SQUARES, [row, col] — throne1.kod:61 `plGenerators`. MonsterRoom
 * GenerateMonster (monsroom.kod:216-232) picks ONE generator at random per tick and refuses the
 * spawn when a battler already stands on that square; nothing retries it. So k of these 6 held by
 * raiders removes k/6 of the tusked skeletons, and all 6 held stops them (m59-research report
 * theoretical-farming-maximum, "standing on a generator eats spawns"). The ghost itself is not a
 * generator spawn: it appears at r2c5 on its own timer.
 */
export const THRONE_GENERATORS = Object.freeze([[5, 3], [9, 2], [13, 3], [5, 9], [9, 10], [13, 9]]);

/**
 * THE GHOST'S CLOCK (throne1.kod:18, :86-106). GhostTimer fires every GHOST_CYCLE seconds x
 * random(90,110)% and IMMEDIATELY sets the next timer; SpawnGhost then makes a ghost only if none is
 * in the room. So the timer never resets on a kill: a spawn seen at T puts the next one in
 * [T + 0.9 x 7200 s, T + 1.1 x 7200 s]. Only a SEEN spawn (a ghost appearing where there was none)
 * fixes the phase; a ghost already present when the raid walks in says nothing about it.
 */
export const GHOST_CYCLE_S = 7200;
export const nextGhostWindow = spawnT => ({ lo: spawnT + Math.round(0.9 * GHOST_CYCLE_S * 1000), hi: spawnT + Math.round(1.1 * GHOST_CYCLE_S * 1000) });

/**
 * THE SPAWN VALVE (operator, 2026-09-25): after the kill, spawn-square holders step off one at a
 * time so the fleet farms what the room makes — and the room stays TIGHTLY under control, because
 * PVP can break out even on prod. Pure: given the state and one reading, the new state.
 *
 *   a STRANGER (a player who is not ours) in the room: every square shut, and none opens while one is;
 *   a DEATH, RETREAT or DEPARTURE since the last change: one square shut, now;
 *   anyone under `closeBelow`, or more alive than 2 x open + 2: one square shut;
 *   ONE MORE opens only when the fleet has EASILY cleared the current level: a whole dwell at it
 *     (dwellMs x (open + 1) — longer at every level), no incident in it, nobody under `easyHealth`
 *     at any reading in it, and the room nearly empty now; and never past `maxOpen` (5 by default:
 *     the sixth square is a deliberate choice).
 * The valve arms only once everyone in the room is at `startAt` or better.
 */
export function valveStep(v, { minFrac = 1, monsters = 0, now = Date.now(), squares = 6, incidents = 0, stranger = false } = {},
                          { startAt = 0.5, closeBelow = 0.35, easyHealth = 0.6, dwellMs = 180_000, maxOpen = 5 } = {}) {
  const out = { ...v };
  const reset = why => { out.changedAt = now; out.dwellFrom = now; out.incidentsAt = incidents; out.why = why; };
  if (!out.armed) {
    if (minFrac >= startAt && !stranger) { out.armed = true; reset('armed: everyone is over half health'); }
    return out;
  }
  // A DIP UNDER easyHealth RESTARTS THE DWELL: the level was not cleared easily, so it has to be
  // held cleanly for a whole dwell again before the next square.
  if (minFrac < easyHealth) out.dwellFrom = now;
  if (stranger) { if (out.open > 0) { out.open = 0; reset('a stranger is in the room'); } return out; }
  if (incidents > (out.incidentsAt ?? 0)) {
    if (out.open > 0) out.open--;
    reset('a death, retreat or departure'); return out;
  }
  if (minFrac < closeBelow || monsters > 2 * out.open + 2) {
    if (out.open > 0) { out.open--; reset(minFrac < closeBelow ? 'a raider is low' : 'too many alive'); }
    return out;
  }
  const cap = Math.min(squares, maxOpen);
  const dwelt = now - (out.dwellFrom ?? out.changedAt ?? 0) >= dwellMs * (out.open + 1);
  if (out.open < cap && dwelt && monsters <= 1 && minFrac >= easyHealth) {
    out.open++; reset(`level ${out.open - 1} cleared easily`);
  }
  return out;
}

/**
 * WHO HOLDS A SPAWN SQUARE: healers first (they stand back anyway and heal from where they are),
 * then the weakest by max health (the raiders a swarm on the ghost can spare), never the light-
 * bearer. -> { agent: { row, col } }, at most `count` of `squares`.
 */
export function spawnBlockers(agents = [], { lightbearer = '', healers = [], maxHealth = {}, squares = THRONE_GENERATORS, count = squares.length } = {}) {
  const pool = agents.filter(a => a !== lightbearer);
  const hs = pool.filter(a => healers.includes(a));
  const rest = pool.filter(a => !healers.includes(a))
    .sort((a, b) => (Number(maxHealth[a]) || 0) - (Number(maxHealth[b]) || 0) || a.localeCompare(b));
  const order = [...hs, ...rest];
  const n = Math.max(0, Math.min(Number(count) || 0, squares.length, order.length));
  return Object.fromEntries(order.slice(0, n).map((a, i) => [a, { row: squares[i][0], col: squares[i][1], index: i }]));
}
export const STAGE_ROOM = 2;           // Outside Castle Victoria — where the raid forms up

// Forces of light: 12 mana, 2 elderberry + 1 emerald (forceslt.kod ResetReagents), and
// 6*(power/3+1) seconds — about 3m24s at the top of the scale.
export const LIGHT = Object.freeze({ spell: 'forces of light', mana: 12,
                                     reagents: { elderberry: 2, emerald: 1 } });
// enchant weapon: 17 mana, 3 elderberry + 1 orc tooth, 30s trance (enchwp.kod:50).
export const DEDICATE = Object.freeze({ spell: 'enchant weapon', mana: 17,
                                        reagents: { elderberry: 3, 'orc tooth': 1 } });

const lower = s => String(s ?? '').toLowerCase();

// ---------------------------------------------------------------------------------- weapons

// Blunt first, because the escort is Skeleton-family. `spiritual hammer` is a Qor summons and
// not something to hand around; it is excluded by the word boundary on purpose.
export const WEAPON_PREFERENCE = ['hammer', 'mace'];
export const isWeaponName = n => /\b(sword|hammer|axe|mace|scimitar|dagger|flail|staff)\b/i.test(String(n ?? ''));
export const isHammer = n => /^hammer$/i.test(String(n ?? '').trim());
export const isBlunt = n => /^(hammer|mace)$/i.test(String(n ?? '').trim());

/**
 * What one raider needs, from what it wields and carries.
 *   { agent, wielding, hammers: [ids], has: 'wielding'|'carrying'|'none', spares: [ids] }
 * A SPARE is a hammer beyond the one this raider will wield. Nobody gives away its last.
 */
export function hammerNeed(agent, { wielding = null, items = [] } = {}) {
  const hammers = items.filter(i => isHammer(i.name) && i.id != null).map(i => i.id);
  const has = isHammer(wielding) ? 'wielding' : hammers.length ? 'carrying' : 'none';
  // Wielding one means every carried hammer beyond the wielded one is spare. `inventory`
  // lists the wielded hammer too, so keep one back either way.
  const spares = hammers.slice(1);
  return { agent, wielding, hammers, has, spares };
}

/**
 * Pair every raider without a hammer with a spare, deterministically.
 *
 * Every agent computes this independently from the same survey, so it MUST come out the same
 * for all of them — sorted by agent name, first spare to first need. Returns
 * { transfers: [{from, to, id}], short: [agents still with nothing] }.
 */
export function matchHammers(needs = []) {
  const byName = [...needs].sort((a, b) => lower(a.agent).localeCompare(lower(b.agent)));
  const pool = byName.flatMap(n => n.spares.map(id => ({ from: n.agent, id })));
  const transfers = [], short = [];
  for (const n of byName) {
    if (n.has !== 'none') continue;
    const s = pool.shift();
    if (s) transfers.push({ from: s.from, to: n.agent, id: s.id });
    else short.push(n.agent);
  }
  return { transfers, short };
}

// ---------------------------------------------------------------------------------- reagents

/** Sum a reagent family out of an item list, matched as a substring (mushroom is five stacks). */
// A REAGENT IS ONE CLASS, NOT A FAMILY. Bless and super strength each want two `&Mushroom`
// (bless.kod:68, strength.kod:60) — the plain "mushroom" — and a blue, purple, red or Inky-cap
// mushroom is a different class that pays for nothing. Counting by substring filed a caster with
// 88 blue mushrooms and no plain ones as stocked, and on the 2026-09-25 rehearsal every bless and
// strength at the door came back "no mana and no reagents moved". Plurals only.
export const reagentName = n => lower(n).trim().replace(/teeth$/, 'tooth').replace(/ies$/, 'y').replace(/s$/, '');
export const isReagent = (itemName, family) => reagentName(itemName) === reagentName(family);
export function countFamily(items = [], family) {
  return items.filter(i => isReagent(i.name, family)).reduce((n, i) => n + (Number(i.amount) || 1), 0);
}

/**
 * How many of `perCast` a character can already pay for, and what it is short of for `casts`.
 * perCast: { elderberry: 3, 'orc tooth': 1 }
 */
export function reagentShortfall(items, perCast, casts) {
  const short = {};
  for (const [name, n] of Object.entries(perCast)) {
    const want = n * casts, have = countFamily(items, name);
    if (have < want) short[name] = want - have;
  }
  return short;
}

/**
 * Plan donor -> receiver reagent hand-overs so every caster can pay for its share.
 *
 *   wants: [{ agent, short: { elderberry: 6 } }]
 *   packs: { agent: items[] }            every raider's pack, donors included
 *   keep:  { elderberry: 0 }             floor a donor keeps for itself
 *
 * Greedy, biggest donor first, and deterministic. Returns
 * { moves: [{from, to, what, amount}], unmet: [{agent, what, amount}] }.
 */
export function planReagents(wants = [], packs = {}, { keep = {}, reserved = new Set() } = {}) {
  const left = {};
  for (const [agent, items] of Object.entries(packs)) {
    left[agent] = {};
    for (const w of wants) for (const what of Object.keys(w.short)) left[agent][what] ??= countFamily(items, what);
  }
  // Somebody who is itself short of X must not donate X, however much it holds.
  const shortOf = new Map(wants.map(w => [w.agent, w.short]));
  const moves = [], unmet = [];
  for (const w of [...wants].sort((a, b) => lower(a.agent).localeCompare(lower(b.agent)))) {
    for (const [what, need0] of Object.entries(w.short)) {
      let need = need0;
      const donors = Object.keys(left)
        .filter(a => a !== w.agent && !reserved.has(a) && !(shortOf.get(a)?.[what] > 0))
        .map(a => ({ a, spare: (left[a][what] ?? 0) - (keep[what] ?? 0) }))
        .filter(d => d.spare > 0)
        .sort((x, y) => y.spare - x.spare || lower(x.a).localeCompare(lower(y.a)));
      for (const d of donors) {
        if (need <= 0) break;
        const amount = Math.min(need, d.spare);
        moves.push({ from: d.a, to: w.agent, what, amount });
        left[d.a][what] -= amount;
        need -= amount;
      }
      if (need > 0) unmet.push({ agent: w.agent, what, amount: need });
    }
  }
  return { moves, unmet };
}

// ---------------------------------------------------------------------------------- roles

/**
 * Who does what, from the spell lists. Pure: `spells` is { agent: ['minor heal', ...] }.
 *
 *   lightbearer  the one who knows forces of light (named explicitly wins)
 *   dedicators   who knows enchant weapon
 *   healers      named, or the first `healerCount` who know minor heal and are neither of the
 *                above — sorted by name so every agent computes the same answer
 *   raiders      everybody else AND the dedicators: casting is done before the fight
 */
export function assignRoles(agents = [], spells = {}, { lightbearer = '', healers = '', healerCount = 3 } = {}) {
  const knows = (a, s) => (spells[a] ?? []).some(x => lower(x) === s);
  const light = lightbearer || agents.find(a => knows(a, LIGHT.spell)) || null;
  const dedicators = agents.filter(a => a !== light && knows(a, DEDICATE.spell));
  const named = String(healers).split(',').map(s => s.trim()).filter(Boolean);
  const heal = named.length ? named.filter(a => agents.includes(a) && a !== light)
    : [...agents].sort((a, b) => lower(a).localeCompare(lower(b)))
        .filter(a => a !== light && !dedicators.includes(a) && knows(a, 'minor heal'))
        .slice(0, healerCount);
  const raiders = agents.filter(a => a !== light && !heal.includes(a));
  // Everybody else who knows the spells does them BETWEEN swings: a raider who knows minor heal
  // is a medic, and one who knows bless keeps its share of the fleet blessed.
  const medics = raiders.filter(a => knows(a, 'minor heal'));
  const blessers = agents.filter(a => a !== light && knows(a, BLESS.spell));
  const strongmen = agents.filter(a => a !== light && knows(a, STRENGTH.spell));
  return { lightbearer: light, dedicators, healers: heal, raiders, medics, blessers, strongmen };
}

// bless: 6 mana, 2 mushroom + 2 sapphire (persench/bless.kod ResetReagents), castable on others
// (persench.kod vbCanCastOnOthers = TRUE), hit roll +power and damage +random(0, power/33),
// duration random(half, all) of 40+6*power seconds — ~3-5 minutes at the fleet's power.
export const BLESS = Object.freeze({ spell: 'bless', mana: 6, reagents: { mushroom: 2, sapphire: 2 } });
// minor heal: 3 mana, 1 herb (heal.kod), 1-10 health, refused FREE on a healthy target.
export const HEAL = Object.freeze({ spell: 'minor heal', mana: 3, reagents: { herb: 1 } });

// super strength: 10 mana, 2 mushroom + 1 orc tooth, castable on others (strength.kod:51),
// 300 + 6*power seconds — five to fifteen minutes.
export const STRENGTH = Object.freeze({ spell: 'super strength', mana: 10, reagents: { mushroom: 2, 'orc tooth': 1 } });

/**
 * SELF AND ONE BUDDY — the operator's rule for a self-buff: everyone who can cast it casts it on
 * itself and on ONE other raider who cannot. Buddies are dealt in name order so every agent
 * computes the same pairs; a caster left over when the buddies run out buffs only itself.
 */
export function buddyAssignments(agents = [], casters = [], { lightbearer = null } = {}) {
  const order = [...casters].sort((a, b) => lower(a).localeCompare(lower(b)));
  const buddies = [...agents].filter(a => a !== lightbearer && !casters.includes(a))
    .sort((a, b) => lower(a).localeCompare(lower(b)));
  const out = {};
  order.forEach((c, i) => { out[c] = buddies[i] ? [c, buddies[i]] : [c]; });
  return out;
}

/**
 * Who blesses whom: every non-light agent, dealt round-robin over the blessers in name order,
 * so every agent computes the same answer and nobody is blessed twice per round.
 */
export function blessAssignments(agents = [], blessers = [], { lightbearer = null } = {}) {
  const out = Object.fromEntries(blessers.map(b => [b, []]));
  if (!blessers.length) return out;
  const order = [...blessers].sort((a, b) => lower(a).localeCompare(lower(b)));
  const targets = [...agents].filter(a => a !== lightbearer).sort((a, b) => lower(a).localeCompare(lower(b)));
  // A blesser takes itself first — no walking, no targeting by name — then the rest are dealt.
  for (const b of order) if (targets.includes(b)) out[b].push(b);
  const rest = targets.filter(t => !order.includes(t));
  rest.forEach((t, i) => out[order[i % order.length]].push(t));
  return out;
}

// ---------------------------------------------------------------------------------- barrier

// One process, one map. `expected` may shrink while agents wait (a death, a refusal), which
// is what `leave` is for: the dead do not hold the door for the living.
const BARRIERS = new Map();

function bar(key) {
  if (!BARRIERS.has(key)) BARRIERS.set(key, { arrived: new Set(), left: new Set(), expected: 0, openedAt: null });
  return BARRIERS.get(key);
}

/** Declare how many agents a barrier waits for. Idempotent; the largest answer wins. */
export function expect(key, n) { const b = bar(key); b.expected = Math.max(b.expected, n); }

/**
 * Re-set how many a barrier waits for — DOWN as well as up. An agent whose FleetScript step
 * failed never reaches a later barrier and nothing tells the barrier so: the first shadow run
 * lost one character at the muster walk and every later rendezvous waited out its full timeout
 * for it. After a survey, the survey's own count is the honest `expected` for what follows.
 */
export function reexpect(key, n) { bar(key).expected = n; }

/** An agent that will never arrive (dead, refused) stops being waited for. */
export function leave(key, agent) { bar(key).left.add(agent); }

/**
 * Wait until everyone expected has arrived (or left), or `ms` passes. Bounded ON PURPOSE:
 * a raid that waits for ever on one wedged character is a raid that never starts, and the
 * escort clock does not start until somebody walks in. Returns { opened, waited_ms, arrived, missing }.
 */
export async function barrier(key, agent, { ms = 180_000, poll = 500, sleep = defaultSleep } = {}) {
  const b = bar(key);
  b.arrived.add(agent);
  const t0 = Date.now();
  // A DOOR THAT HAS OPENED STAYS OPEN. Whoever arrives after the barrier released (it filled, or
  // its patience ran out) goes straight through. The third rehearsal's light-bearer reached the
  // door four minutes after it had released the raid, found 21 of 22 still "missing", and waited
  // out the whole timeout again — six minutes of throne room with no forces of light.
  if (b.openedAt != null) return { opened: true, waited_ms: 0, arrived: b.arrived.size, expected: b.expected, late: true };
  const ready = () => b.arrived.size + [...b.left].filter(a => !b.arrived.has(a)).length >= b.expected;
  while (!ready() && Date.now() - t0 < ms) await sleep(poll);
  // Released either way — filled, or out of patience — and from here on it stays open.
  if (b.openedAt == null) b.openedAt = Date.now();
  return { opened: ready(), waited_ms: Date.now() - t0, arrived: b.arrived.size, expected: b.expected };
}

export const barrierState = key => {
  const b = BARRIERS.get(key);
  return b ? { arrived: [...b.arrived], left: [...b.left], expected: b.expected, openedAt: b.openedAt } : null;
};
export const resetBarriers = () => BARRIERS.clear();
const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------------- the report

/**
 * THE SURVIVAL REPORT, from evidence rather than from anybody's own tally.
 *
 *   participants  [{ agent, character, role }]
 *   killAt        ms the ghost was seen gone (null if it never died)
 *   startAt       ms the raid entered the throne room
 *   windowMin     the post-kill window (30)
 *   died          ledger `died` rows: { t, character|agent, killed_by, died_in }
 *   killed        ledger `killed` rows: { t, agent|character, creature, room_num }
 *   samples       sampler rows: { t, agent, room_num, hp, max }
 *
 * A character SURVIVED THE WINDOW if it has no `died` row inside [killAt, killAt+window].
 * Deaths during the fight are reported separately — they are a different question (could the
 * fleet kill the boss) from the one asked (could it live in the room afterwards).
 */
export function survivalReport({ participants = [], killAt = null, startAt = null, windowMin = 30,
                                  died = [], killed = [], samples = [], endAt = null } = {}) {
  const whoOf = r => r.agent ?? null;
  const charOf = new Map(participants.map(p => [lower(p.character), p.agent]));
  const agentOfRow = r => whoOf(r) ?? charOf.get(lower(r.character)) ?? null;
  const mine = new Set(participants.map(p => p.agent));
  const deaths = died.map(r => ({ ...r, agent: agentOfRow(r) })).filter(r => mine.has(r.agent));

  const winFrom = killAt ?? startAt;
  const winTo = winFrom != null ? winFrom + windowMin * 60_000 : null;
  const inFight = startAt != null && killAt != null ? deaths.filter(d => d.t >= startAt && d.t < killAt) : [];
  const inWindow = winFrom != null ? deaths.filter(d => d.t >= winFrom && d.t <= winTo) : [];
  const observedTo = endAt ?? (samples.length ? Math.max(...samples.map(s => s.t)) : winTo);
  const covered = winFrom != null && observedTo != null ? Math.min(1, (observedTo - winFrom) / (winTo - winFrom)) : 0;

  const rows = participants.map(p => {
    const mySamples = samples.filter(s => s.agent === p.agent && (winFrom == null || s.t >= (startAt ?? winFrom)));
    const fracs = mySamples.filter(s => s.max).map(s => s.hp / s.max);
    const inRoom = mySamples.filter(s => s.t >= (winFrom ?? 0) && s.room_num === GHOST_ROOM).length;
    const windowSamples = mySamples.filter(s => s.t >= (winFrom ?? 0)).length;
    const myKills = killed.filter(k => agentOfRow(k) === p.agent && winFrom != null && k.t >= winFrom && k.t <= winTo);
    const d = inWindow.filter(x => x.agent === p.agent);
    return {
      agent: p.agent, character: p.character, role: p.role,
      died_in_fight: inFight.filter(x => x.agent === p.agent).length,
      died_in_window: d.length,
      first_death_min: d.length ? Number(((d[0].t - winFrom) / 60_000).toFixed(1)) : null,
      killed_by: d.map(x => x.killed_by).filter(Boolean),
      min_health_frac: fracs.length ? Number(Math.min(...fracs).toFixed(2)) : null,
      time_in_throne_room: windowSamples ? Number((inRoom / windowSamples).toFixed(2)) : null,
      kills: myKills.length,
    };
  });

  const survivors = rows.filter(r => r.died_in_window === 0).length;
  const kills = killed.filter(k => mine.has(agentOfRow(k)) && winFrom != null && k.t >= winFrom && k.t <= winTo);
  const byCreature = {};
  for (const k of kills) byCreature[k.creature ?? 'unnamed'] = (byCreature[k.creature ?? 'unnamed'] ?? 0) + 1;
  const raiderHours = participants.length * windowMin / 60;

  return {
    ghost_killed: killAt != null,
    fight_seconds: startAt != null && killAt != null ? Math.round((killAt - startAt) / 1000) : null,
    window_minutes: windowMin,
    window_coverage: Number(covered.toFixed(2)),
    participants: participants.length,
    survivors,
    // NULL, never 0, when the window was not observed — the savelog rule: a rate without its
    // opportunity is not a rate.
    survival_rate: participants.length && covered > 0 ? Number((survivors / participants.length).toFixed(3)) : null,
    deaths_in_fight: inFight.length,
    deaths_in_window: inWindow.length,
    deaths_per_raider_hour: covered > 0 ? Number((inWindow.length / (raiderHours * covered)).toFixed(3)) : null,
    kills_in_window: kills.length,
    kills_by_creature: byCreature,
    killers: countBy(inWindow.map(d => d.killed_by ?? 'unknown')),
    rows,
  };
}

const countBy = xs => xs.reduce((m, x) => (m[x] = (m[x] ?? 0) + 1, m), {});

/** The report as Markdown — what the operator reads. */
export function reportMarkdown(rep, { fleet = '?', startedIso = '', notes = [] } = {}) {
  const pct = x => x == null ? 'n/a' : `${Math.round(x * 100)}%`;
  const L = [];
  L.push(`# Ghost of Far'Nohl raid — fleet \`${fleet}\``, '');
  if (startedIso) L.push(`Raid entered the throne room ${startedIso}.`, '');
  L.push('| | |', '|---|---|');
  L.push(`| ghost killed | ${rep.ghost_killed ? `yes, ${rep.fight_seconds}s after entry` : '**no**'} |`);
  L.push(`| raiders | ${rep.participants} |`);
  L.push(`| deaths during the ghost fight | ${rep.deaths_in_fight} |`);
  L.push(`| **survival, ${rep.window_minutes} min after the kill** | **${rep.survivors}/${rep.participants} = ${pct(rep.survival_rate)}** |`);
  L.push(`| deaths in the window | ${rep.deaths_in_window} (${rep.deaths_per_raider_hour ?? 'n/a'} per raider-hour) |`);
  L.push(`| window observed | ${pct(rep.window_coverage)} |`);
  L.push(`| kills in the window | ${rep.kills_in_window} ${Object.keys(rep.kills_by_creature).length ? '(' + Object.entries(rep.kills_by_creature).map(([k, v]) => `${k} ${v}`).join(', ') + ')' : ''} |`);
  if (Object.keys(rep.killers).length)
    L.push(`| killed by | ${Object.entries(rep.killers).map(([k, v]) => `${k} ×${v}`).join(', ')} |`);
  L.push('', '| character | role | died (fight) | died (window) | first death | min health | in throne room | kills |',
         '|---|---|---|---|---|---|---|---|');
  for (const r of rep.rows)
    L.push(`| ${r.character ?? r.agent} | ${r.role} | ${r.died_in_fight} | ${r.died_in_window} | ` +
           `${r.first_death_min != null ? r.first_death_min + ' min' : '—'} | ${pct(r.min_health_frac)} | ` +
           `${pct(r.time_in_throne_room)} | ${r.kills} |`);
  if (notes.length) { L.push('', '## Notes', ''); for (const n of notes) L.push(`- ${n}`); }
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------- the guild chests

/**
 * WHAT THE RAID CONSUMES, from its roles. The same arithmetic the arm step provisions with, so
 * the chest plan and the hand-out cannot disagree: a dedication per raider, the light's casts,
 * bless and super strength per their assignments and rounds, herbs for every heal caster. Pure.
 */
export function raidNeeds(agents = [], roles = {}, { lightCasts = 16, blessRounds = 4, herbsEach = 30,
                                                     healCasters = null } = {}) {
  const need = {};
  const add = (reagents, times) => { for (const [k, n] of Object.entries(reagents)) need[k] = (need[k] ?? 0) + n * times; };
  const weapons = agents.filter(a => a !== roles.lightbearer).length;
  add(DEDICATE.reagents, weapons);
  if (roles.lightbearer) add(LIGHT.reagents, lightCasts);
  const bless = blessAssignments(agents, roles.blessers ?? [], { lightbearer: roles.lightbearer });
  add(BLESS.reagents, Object.values(bless).reduce((n, t) => n + t.length, 0) * blessRounds);
  const strong = buddyAssignments(agents, roles.strongmen ?? [], { lightbearer: roles.lightbearer });
  add(STRENGTH.reagents, Object.values(strong).reduce((n, t) => n + t.length, 0) * 2);
  add(HEAL.reagents, (healCasters ?? ((roles.healers ?? []).length + (roles.lightbearer ? 1 : 0))) * herbsEach);
  return need;
}

/**
 * THE CHEST PLAN: need against what the fleet carries and what each chest held when last read,
 * and where to take the shortfall from — plus what the draw leaves behind to be put back.
 *
 * A get takes a WHOLE STACK (REQ_GET has no amount), so drawing 40 teeth from a 162-stack takes
 * 162, and 122 come home as surplus. That surplus has to go back in somewhere, so every chest the
 * plan draws from is given a RESERVE — the bulk to keep free for the return — and a chest that is
 * already too full to take its own surplus back is named, with the chest that has the room.
 *
 *   needs {item:n}; fleet {item:n}; chests [{slot, items:[{name, amount}]}]; weigh name->{bulk}
 *   -> { rows: [{item, need, fleet, short, draws:[{slot, take}], surplus, unmet}], chests: [...], warnings }
 */
export function chestPlan({ needs = {}, fleet = {}, chests = [], weigh = () => null, bulkMax = 24000 } = {}) {
  // EXACT, after folding a plural: "mushroom" is one class of five mushrooms here, and a reagent
  // list that took a purple mushroom for a mushroom would plan a draw the cast then refuses.
  const key = s => lower(s).trim().replace(/ies$/, 'y').replace(/s$/, '');
  const matches = (name, item) => key(name) === key(item);
  const bulkOf = (name, n) => (Number(weigh(name)?.bulk) || 0) * n;
  const state = chests.map(c => ({ slot: c.slot, items: (c.items ?? []).map(i => ({ ...i })),
    bulk: (c.items ?? []).reduce((b, i) => b + bulkOf(i.name, Number(i.amount) || 1), 0), reserve: 0, draws: [] }));
  const rows = [], warnings = [];
  for (const [item, need] of Object.entries(needs).sort()) {
    const have = Number(fleet[item] ?? 0);
    const short = Math.max(0, need - have);
    const row = { item, need, fleet: have, short, draws: [], surplus: 0, unmet: 0 };
    let left = short;
    // Fewest trips into the chest: the largest stacks first, whichever chest they sit in.
    const stacks = state.flatMap(c => c.items.filter(i => matches(i.name, item)).map(i => ({ c, i })))
      .sort((a, b) => (Number(b.i.amount) || 1) - (Number(a.i.amount) || 1));
    for (const { c, i } of stacks) {
      if (left <= 0) break;
      const take = Number(i.amount) || 1;
      row.draws.push({ slot: c.slot, name: i.name, take });
      c.draws.push({ item, take });
      c.bulk -= bulkOf(i.name, take);
      left -= take;
    }
    row.unmet = Math.max(0, left);
    row.surplus = Math.max(0, -left);
    if (row.surplus) {
      const from = row.draws[row.draws.length - 1];
      const home = state.find(c => c.slot === from.slot);
      home.reserve += bulkOf(from.name, row.surplus);
    }
    if (row.unmet) warnings.push(`${item}: short ${row.unmet} even after every chest — buy it, or cut the plan`);
    rows.push(row);
  }
  for (const c of state) {
    const free = bulkMax - c.bulk;
    c.free = free;
    if (c.reserve > free) {
      const other = state.filter(o => o !== c).sort((a, b) => (bulkMax - b.bulk - b.reserve) - (bulkMax - a.bulk - a.reserve))[0];
      warnings.push(`chest ${c.slot} cannot take back its own surplus (${c.reserve} bulk, ${free} free)` +
                    (other ? ` — put it in ${other.slot} (${bulkMax - other.bulk - other.reserve} free after its own)` : ''));
    }
  }
  return { rows, chests: state.map(({ items, ...c }) => c), warnings };
}
