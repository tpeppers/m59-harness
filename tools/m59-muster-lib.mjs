// THE MUSTER: FROM A COLD FLEET TO ONE READY TO SET OUT TOGETHER — decided here, done by FleetScript.
//
//   import { unitFromState, assess, planHandovers, readinessReport } from './m59-muster-lib.mjs';
//
// Pure. No socket, no broker, no file written: every function takes what was read and returns what to do,
// so a launch can be planned, printed and tested before a body moves, and the same plan runs on the shadow
// copy and on prod. The doing is FleetScript's (`supply`, `rest`, `act`) and the job board's.
//
// WHY THIS EXISTS. Operator, 2026-10-29: the Avar Village launch has to go smoothly on PROD, rehearsed on the
// shadow clone first, from the fleet's real cold state — and that state is not "standing in an inn":
//
//   * every body locked to a no-combat room by an operator lockdown (`inn-lock`), whose saved "before" is the
//     FARM order, so a plain release sends each one off alone (avar-village.md, "the release hazard");
//   * ten `second-wind-drill` jobs running, each turning survival and resting OFF on a loop, which is why
//     half the fleet sat at 35-60 vigor with survival off and fight_above_vigor 0;
//   * jobs PAUSED by a tripwire (`buy-sapphires`, `walk-legs`) over would-be participants, which the
//     tripwire's own release would restart mid-launch — the errand shape that killed Lew and Zoot;
//   * ten bodies with no food against "about ten meals per body per hour", and two with sapphires.
//
// The first shadow run of `avar-village` from that state lost five of twenty at the inn door (survival off:
// the broker refused their walk, correctly), and one on the road: Janice, at 78% in an avar room, was
// refused a walk out by the 100% travel floor and died there. Readiness is the half of a launch that no
// script had; this is it, as data.
//
// A GAP NAMES ITS REMEDY. `assess` never just says "not ready": every gap carries the remedy kind a
// launch script executes, and a hazard id when the remedy is an act the operator has to say out loud.
import { foodValue } from './m59-items.mjs';
import { survivalOffOf, isNoCombatRoom } from './m59-hazards.mjs';

export const LIVE_JOB_STATES = Object.freeze(['running', 'paused', 'resumed', 'orphaned']);

/** What "ready to set out" means unless a launch says otherwise. The Avar Village plan's own numbers:
 *  0.9 health, 80 vigor (the keeper will not leave a safe room below its rest cap), 4 meals, a fight floor of 60. */
export const DEFAULT_TARGET = Object.freeze({ health: 0.9, vigor: 80, meals: 4, fightAboveVigor: 60, items: {} });

const lc = s => String(s ?? '').toLowerCase().trim();
const amountOf = i => Math.max(1, Number(i?.amount) || 1);

/** Meals carried: the game's own Food tree (m59-items foodValue), never a hand list. */
export const mealsOf = (items = [], isFood = n => !!foodValue(n)) =>
  items.filter(i => isFood(String(i?.name ?? ''))).reduce((n, i) => n + amountOf(i), 0);

/** Count of one named item (singular or plural, exact otherwise). */
export function countOf(items = [], name) {
  const want = lc(name), plural = want.endsWith('s') ? want : `${want}s`, single = want.replace(/s$/, '');
  return items.filter(i => [want, plural, single].includes(lc(i?.name))).reduce((n, i) => n + amountOf(i), 0);
}

/**
 * One character, as a launch reads it: a keeper's cached `/state`, its fleet row, the live jobs over it and
 * the active postures over it. `isFood` is injectable for the offline test.
 */
export function unitFromState(state, { row = null, jobs = [], postures = [], isFood, now = Date.now() } = {}) {
  const policy = state?.autopilot_status?.policy ?? {};
  const items = Array.isArray(state?.items) ? state.items : [];
  return {
    agent: state?.agent ?? row?.agent ?? null, character: state?.character ?? row?.character ?? null,
    room: Number(state?.room?.num) || null, inGame: !!state?.in_game, piloted: !!row?.piloted,
    hp: Number(state?.hp?.value) || 0, hpMax: Number(state?.hp?.max) || 1,
    vigor: Number(state?.vigor?.value ?? state?.vigor) || 0,
    items, meals: mealsOf(items, isFood),
    policy, survivalOff: survivalOffOf(policy, now),
    jobs: jobs.filter(j => LIVE_JOB_STATES.includes(j?.state) && (j.agents ?? []).includes(state?.agent))
      .map(j => ({ id: j.id, name: j.name ?? j.kind ?? 'job', state: j.state, why: j.paused_why ?? j.why ?? null })),
    postures: [...postures],
  };
}

/**
 * The gaps between one character and `target`, each with its remedy. `exclude` is set when no remedy this
 * module knows can make the character a participant (offline, piloted, outside the launch's start rooms).
 *
 *   kind          remedy             what a launch does
 *   job           cancel_job         kill a running job / retire a paused one, so nothing resumes it mid-launch
 *   posture       release_to_hold    release THIS character from the posture to a hold where it stands
 *                                    (hazard release_lockdown: the operator ordered that lockdown)
 *   survival_off  survival_on        survival_enabled: true
 *   fight_floor   fight_floor        fight_above_vigor back to target (a drill leaves 0)
 *   unsafe_room   (exclude)          preparing means standing still; only in a NO_COMBAT room
 *   hurt          rest               rest in place
 *   hungry        receive_food       hand-overs from same-room donors (planHandovers)
 *   tired         eat | rest         eat if it carries food, else rest (resting stops at the rest cap)
 *   item_short    receive_item       hand-overs of a named item (target.items: { sapphire: 6 })
 */
export function assess(u, target = DEFAULT_TARGET, { startRooms = null, roleItems = null } = {}) {
  const t = { ...DEFAULT_TARGET, ...target };
  const gaps = [];
  let exclude = null;
  if (!u.inGame) exclude = 'not in game';
  else if (u.piloted) exclude = 'a person is at the controls';
  else if (startRooms && !startRooms.includes(u.room)) exclude = `in room ${u.room}, not one of the launch's start rooms`;
  else if (!isNoCombatRoom(u.room) && !(target.safeRooms ?? []).includes(u.room))
    exclude = `in room ${u.room}, which is not a no-combat room — preparing means standing still`;
  for (const j of u.jobs) gaps.push({ kind: 'job', remedy: 'cancel_job', id: j.id, why: `${j.name} is ${j.state}${j.why ? ` (${j.why})` : ''}` });
  for (const p of u.postures) gaps.push({ kind: 'posture', remedy: 'release_to_hold', posture: p, hazard: 'release_lockdown', why: `${p} is on over it` });
  if (u.survivalOff) gaps.push({ kind: 'survival_off', remedy: 'survival_on', why: 'survival is off' });
  const fav = Number(u.policy?.fightAboveVigor);
  if (Number.isFinite(fav) && fav < t.fightAboveVigor) gaps.push({ kind: 'fight_floor', remedy: 'fight_floor', why: `fight_above_vigor ${fav}`, to: t.fightAboveVigor });
  if (u.hp / u.hpMax < t.health) gaps.push({ kind: 'hurt', remedy: 'rest', why: `${u.hp}/${u.hpMax}` });
  if (u.meals < t.meals) gaps.push({ kind: 'hungry', remedy: 'receive_food', short: t.meals - u.meals, why: `${u.meals} of ${t.meals} meals` });
  if (u.vigor < t.vigor) gaps.push({ kind: 'tired', remedy: u.meals > 0 ? 'eat' : 'rest', why: `vigor ${u.vigor} of ${t.vigor}` });
  const items = { ...(t.items ?? {}), ...((roleItems && roleItems(u)) ?? {}) };
  for (const [name, min] of Object.entries(items)) {
    const have = countOf(u.items, name);
    if (have < min) gaps.push({ kind: 'item_short', remedy: 'receive_item', item: name, short: min - have, why: `${have} of ${min} ${name}` });
  }
  return { agent: u.agent, character: u.character, room: u.room, exclude, gaps, ready: !exclude && !gaps.length };
}

/**
 * Who hands what to whom, in ONE room at a time (a hand-over is a handshake; nobody walks for it).
 * `short(u)` is how many a character needs; `spare(u)` how many it can give and keep its own target.
 * Largest spare to largest need, so the fewest hand-overs cover the most. Returns
 *   { handovers: [{ room, from, to, amount }], unmet: [{ agent, room, short }] }
 */
export function planHandovers(units, { short, spare }) {
  const handovers = [], unmet = [];
  const rooms = new Map();
  for (const u of units) { if (!rooms.has(u.room)) rooms.set(u.room, []); rooms.get(u.room).push(u); }
  for (const [room, us] of rooms) {
    const donors = us.map(u => ({ u, left: Math.max(0, Math.floor(spare(u))) })).filter(d => d.left > 0).sort((a, b) => b.left - a.left);
    const needs = us.map(u => ({ u, need: Math.max(0, Math.ceil(short(u))) })).filter(n => n.need > 0).sort((a, b) => b.need - a.need);
    for (const n of needs) {
      for (const d of donors) {
        if (!n.need) break;
        if (!d.left || d.u.agent === n.u.agent) continue;
        const amount = Math.min(d.left, n.need);
        handovers.push({ room, from: d.u.agent, to: n.u.agent, amount });
        d.left -= amount; n.need -= amount;
      }
      if (n.need) unmet.push({ agent: n.u.agent, room, short: n.need });
    }
  }
  return { handovers, unmet };
}

/** Food hand-overs: every participant to `target.meals`; a donor keeps its own target plus `keep`. */
export const planFood = (units, { meals = DEFAULT_TARGET.meals, keep = 0 } = {}) =>
  planHandovers(units, { short: u => meals - u.meals, spare: u => u.meals - meals - keep });

/** Named-item hand-overs (sapphires for a lifter): `need(u)` per character, a donor keeps `keep(u)`. */
export const planItem = (units, name, { need, keep = () => 0 }) =>
  planHandovers(units, { short: u => need(u) - countOf(u.items, name), spare: u => countOf(u.items, name) - need(u) - keep(u) });

/** One line per character, worst first — the survey a launch prints before it does anything. */
export function readinessReport(assessments) {
  const rank = a => (a.exclude ? 2 : a.ready ? 0 : 1);
  return [...assessments].sort((a, b) => rank(b) - rank(a) || b.gaps.length - a.gaps.length).map(a =>
    `${String(a.agent).padEnd(9)}${String(a.character ?? '').slice(0, 12).padEnd(13)}${String(a.room ?? '?').padEnd(6)}` +
    (a.exclude ? `OUT: ${a.exclude}` : a.ready ? 'ready' : a.gaps.map(g => `${g.kind}(${g.why})`).join('; ')));
}

// ================================================================================== THE RESOURCES OF A MUSTER
//
// Operator, 2026-10-29: "your process of like 'check if people have food' and ending up bouncing back-and-forth with
// the 'are mushrooms edible?' and wasting time — our preliminary 'scope out resources available for the muster' tool
// should instantly cross reference what everyone's carrying, what's available within ~3 rooms (the island vaults for
// many of our people), etc." So a need and a holding are compared by what the GAME says an item is — its kod class
// (m59-itemclass.mjs, the same table the wire's names resolve through) and its Food tree — never by a name somebody
// typed. A red mushroom is a RedMushroom, a reagent; a loaf of bread is Bread, food. Asked of the game, not argued.
//
// THE PIECES, all pure (the CLI m59-preflight.mjs reads the world and hands them in):
//   needsOf(unit, spec)        what one participant must carry: meals, and every reagent of every spell the muster
//                              wants cast N times that THIS character knows (substrate/m59-spells.json, any spell)
//   sourcesFrom({...})         every place a thing can come from: packs, each character's vault (its owner only),
//                              guild chests — with the room each one is in
//   planSupply(...)            each need filled from the participant itself first, then the nearest source within
//                              `maxHops` rooms, a donor keeping its own need plus `keep`; what nothing covers is named
//
// A transfer names who acts and where: a HANDOVER is two bodies in one room (`supply`), a WITHDRAWAL is a vault's
// owner at that vault, a CHEST draw is any guild member at the hall. The executor fires each when its parties are
// together and retries a refusal (a full pack is an ordering problem more often than a capacity one).

/** Reagents of one spell, from the game's spell table: [{ class, count }], or null when no spell has that name. */
export function spellReagents(spell, spells = []) {
  const want = lc(spell).replace(/[^a-z0-9]/g, '');
  const s = spells.find(x => lc(x.name).replace(/[^a-z0-9]/g, '') === want || lc(x.cls) === want);
  return s ? (s.reagents ?? []).map(r => ({ class: r.item, count: Number(r.count) || 1 })) : null;
}

/**
 * What one participant needs to carry, as [{ key, kind, amount, why }]. `key` is 'meal' for food, else a kod class.
 * spec.target.meals: meals each; spec.casts: { '<spell>': castings } for every participant who KNOWS the spell;
 * spec.items: { '<class or name>': n } for everyone; spec.roleItems(unit) for per-character extras.
 */
export function needsOf(unit, spec, { spells = [], knows = (u, s) => (u.spells ?? []).some(n => lc(n) === lc(s)), classOf = n => n } = {}) {
  const need = new Map();
  const add = (key, kind, amount, why) => {
    if (!(amount > 0)) return;
    const cur = need.get(key) ?? { key, kind, amount: 0, why: [] };
    cur.amount += amount; cur.why.push(why); need.set(key, cur);
  };
  add('meal', 'food', Number(spec?.target?.meals ?? DEFAULT_TARGET.meals), 'meals');
  for (const [spell, n] of Object.entries(spec?.casts ?? {})) {
    if (!knows(unit, spell)) continue;
    const reagents = spellReagents(spell, spells);
    if (!reagents) throw new Error(`no spell called "${spell}" in the game's spell table`);
    for (const r of reagents) add(r.class, 'reagent', r.count * Number(n), `${n}x ${spell}`);
  }
  for (const [item, n] of Object.entries({ ...(spec?.items ?? {}), ...(spec?.roleItems?.(unit) ?? {}) }))
    add(classOf(item) ?? item, 'item', Number(n), item);
  return [...need.values()].map(n => ({ ...n, why: n.why.join(', ') }));
}

/**
 * Every source, as [{ id, kind: 'pack'|'vault'|'chest', holder, room, items, observed_at }]. A vault belongs to its
 * owner (only the owner withdraws) and is in the room it was read in — or `room: null`, said out loud, for a vault
 * read before the room was recorded.
 */
export function sourcesFrom({ units = [], vaults = [], chests = [] }) {
  const out = [];
  for (const u of units) out.push({ id: `pack:${u.agent}`, kind: 'pack', holder: u.agent, character: u.character, room: u.room, items: u.items ?? [] });
  for (const v of vaults) {
    const owner = units.find(u => lc(u.character) === lc(v.character));
    out.push({ id: `vault:${v.character}`, kind: 'vault', holder: owner?.agent ?? null, character: v.character, room: v.room ?? null,
               items: v.items ?? [], observed_at: v.observed_at ?? null });
  }
  for (const c of chests) out.push({ id: `chest:${c.slot ?? c.key}`, kind: 'chest', holder: null, room: c.room ?? null, items: c.items ?? [],
                                     observed_at: c.observed_at ?? null });
  return out;
}

/** Does an item row satisfy a need key? Food by the game's Food tree; anything else by kod class. */
export const satisfies = (row, key, { classOf, isFood }) =>
  key === 'meal' ? isFood(String(row?.name ?? '')) : lc(classOf(String(row?.name ?? ''))) === lc(key);

/** Rooms by hop count from `from` over a room graph (Map room -> Set(rooms)). */
export function hopsFrom(graph, from) {
  const dist = new Map([[Number(from), 0]]), q = [Number(from)];
  while (q.length) { const r = q.shift(); for (const n of graph?.get(r) ?? []) if (!dist.has(n)) { dist.set(n, dist.get(r) + 1); q.push(n); } }
  return dist;
}

/**
 * Fill every need. `needs`: { agent: [{key, kind, amount, why}] }; `units`: participants (agent, room); `sources` from
 * sourcesFrom. Order: the participant's OWN pack, then its own vault, then other sources by hop distance from the
 * participant (packs before vaults before chests at equal distance), never further than `maxHops`, and never a
 * donor's own need or its `keep` margin. Returns
 *   { transfers: [{ to, key, name, amount, kind, from, holder, room, hops }], shortfalls: [{ agent, key, short, why }] }
 * A pack-to-pack transfer across rooms is a WALK first; the executor brings the parties together (`hops` says how far).
 */
export function planSupply(needs, units, sources, { classOf, isFood, distance = () => 0, maxHops = 3, keep = () => 0 } = {}) {
  const avail = new Map(sources.map(s => [s.id, (s.items ?? []).map(i => ({ name: i.name, amount: Math.max(1, Number(i.amount) || 1) }))]));
  const sat = (row, key) => satisfies(row, key, { classOf, isFood });
  const take = (sourceId, key, max) => {
    const out = [];
    for (const row of avail.get(sourceId) ?? []) {
      if (max <= 0) break;
      if (!row.amount || !sat(row, key)) continue;
      const n = Math.min(row.amount, max);
      row.amount -= n; max -= n; out.push({ name: row.name, amount: n });
    }
    return out;
  };
  const byAgent = new Map(units.map(u => [u.agent, u]));
  const keys = new Set(Object.values(needs).flat().map(n => n.key));
  const remaining = {};
  // 1. Everybody covers itself from its own pack first, so a donor's own need is never given away.
  for (const [agent, list] of Object.entries(needs)) {
    remaining[agent] = list.map(n => ({ ...n, short: n.amount - take(`pack:${agent}`, n.key, n.amount).reduce((s, r) => s + r.amount, 0) }));
  }
  // 2. A donor's margin is held back the same way.
  for (const s of sources) for (const key of keys) take(s.id, key, keep(s, key));
  const transfers = [], shortfalls = [];
  const rank = { pack: 0, vault: 1, chest: 2 };
  for (const [agent, list] of Object.entries(remaining)) {
    const me = byAgent.get(agent);
    for (const n of list) {
      if (n.short <= 0) continue;
      const cands = sources.filter(s => s.id !== `pack:${agent}` && !(s.kind === 'vault' && !s.holder))
        .map(s => ({ s, hops: s.room == null ? Infinity : distance(me?.room, s.room), own: s.kind === 'vault' && s.holder === agent }))
        .filter(c => c.hops <= maxHops)
        .sort((a, b) => Number(b.own) - Number(a.own) || a.hops - b.hops || rank[a.s.kind] - rank[b.s.kind]);
      for (const c of cands) {
        if (n.short <= 0) break;
        for (const row of take(c.s.id, n.key, n.short)) {
          transfers.push({ to: agent, key: n.key, name: row.name, amount: row.amount, kind: c.s.kind, from: c.s.id,
                           holder: c.s.holder, room: c.s.room, hops: c.hops });
          n.short -= row.amount;
        }
      }
      if (n.short > 0) shortfalls.push({ agent, key: n.key, short: n.short, why: n.why });
    }
  }
  return { transfers, shortfalls };
}

/** What every source holds of each need key — the "what do we have at all" table, most first. */
export function holdingsTable(keys, sources, { classOf, isFood }) {
  const table = {};
  for (const key of keys) {
    table[key] = sources.map(s => ({ source: s.id, room: s.room, amount: (s.items ?? []).filter(r => satisfies(r, key, { classOf, isFood }))
      .reduce((n, r) => n + Math.max(1, Number(r.amount) || 1), 0) })).filter(x => x.amount > 0)
      .sort((a, b) => b.amount - a.amount);
  }
  return table;
}
