// RAISE A SOLDIER SHIELD TO ITS TOP RANK BY KILLING THE OTHER TWO ARMIES' TROOPS.
//
//   max-faction-shield agents=t5                       find, farm, stop at "a supreme hero"
//   max-faction-shield agents=t5 rooms=568,557         farm only these flag rooms
//   max-faction-shield agents=t5 home=39 minutes=240   come back afterwards; a longer budget
//
// Operator's request, 2026-10-13. The sequel to `faction-shield.mjs`, which EARNS the shield; this
// one ranks it up. Everything below is read from the server source (Meridian59/kod).
//
// WHAT RANK IS. `SoldierShield.piFactionRank` (object/item/passitem/defmod/shield/soldshld.kod)
// starts at 4 and is bound to 1..10. `KilledSomething` adds ONE for every factioned monster of
// another faction the owner kills, and stops at MAX_RANK_FROM_MONSTERS = 10; killing a troop of
// your OWN faction costs one. It is told by `Player.KilledSomething` only through
// `FindUsing(&SoldierShield)`, so the shield has to be in use — it always is, since `ReqUnuse`
// refuses a player — and the killing blow has to be this character's. Nothing in an arena
// (ROOM_SAFE_DEATH) counts, and neither does a neutral monster.
//
// WHAT CAN BE SEEN OF IT. Only a band, appended to the shield's own description by `AppendDesc`:
//     "Your rank within <army> is: <title>."
//       1-2 a lowly peon   3-4 an average soldier   5-6 a notable fighter
//       7-8 a great warrior   9-10 a supreme hero
// So "the highest level" is the title "a supreme hero", and that is the goal this script stops
// at. It cannot tell 9 from 10 — nobody can, short of a DM — and it says so rather than claiming
// ten. The kills it reports needing are a RANGE for the same reason.
//
// WHICH SHIELD, WHICH FACTION. The shield names its faction (`ReqNewOwner` refuses anyone of
// another faction, `ReqUse` deletes a shield its owner has left), so the shield in the pack IS the
// faction and the rank — no profile read, no operator flag. No shield: a refusal and nothing moves.
// Already "a supreme hero": a no-op that moves nothing either.
//
// WHERE THE ENEMY IS. Troops spawn only at a flagpole their faction holds (flag.kod
// GenerateTroops), four a room at most, about twelve an hour. The starting holdings of BOTH enemy
// armies are scouted first, nearest first by `travel_estimate`, then every other wilderness flag
// room. A room is taken when an enemy troop is standing in it, or when its flagpole flies an enemy
// army's colours (the pole's description says whose — flag.kod flag_*_desc_rsc), because that pole
// will make more. Once a room is taken the character STAYS in it and farms until the title reads
// "a supreme hero" or the budget runs out. The farming itself is the keeper's (`harvest`), because
// a step list cannot farm; this script sets the posture, hands the body back, and reads the shield.
//
// THE DANGER, SAID PLAINLY. Troops are level 70-145, and a faction member is not neutral to them:
// `SpecialHatredBehavior` is +30 against any other faction. Every enemy troop in the room will come
// for this character, up to four at a time. The keeper's survival ladder stays armed throughout.
// Dying to a troop costs NO rank (`OwnerDied` penalises only a death to an enemy PLAYER) — but a
// LOGOFF GHOST that takes a penalty is treated as a death to an enemy (logghost.kod
// InflictPenalties), which costs four ranks, and at rank 3 or below DELETES THE SHIELD. Anything
// that logs this character off mid-fight is far more expensive here than anywhere else.
import { walk, verify, harvest, observe } from '../m59-fleetscript.mjs';
import { describeItem } from '../m59-magicsort.mjs';
import { FACTION_SOLDIER, WILDERNESS_FLAG_ROOMS } from '../m59-factions.mjs';
import { recordIntel } from '../m59-faction-intel.mjs';

const lower = s => String(s ?? '').trim().toLowerCase();

// ---------------------------------------------------------------- the pure half (tested offline)

/** The three armies: their shield, the army name the shield's rank line uses, and their troop. */
export const ARMIES = Object.freeze({
  duke: Object.freeze({ id: 'duke', shield: FACTION_SOLDIER.duke.shield, army: 'the ducal army',
                        troop: "soldier of the Duke's army", rooms: Object.freeze([586, 596, 585]) }),
  princess: Object.freeze({ id: 'princess', shield: FACTION_SOLDIER.princess.shield, army: 'the Royal army',
                            troop: "soldier of the Princess' army", rooms: Object.freeze([593, 583, 603]) }),
  rebel: Object.freeze({ id: 'rebel', shield: FACTION_SOLDIER.rebel.shield, army: 'the rebel militia',
                         troop: 'rebel soldier', rooms: Object.freeze([568, 557, 547]) }),
});

/** The bands `AppendDesc` prints, lowest first. */
export const RANKS = Object.freeze([
  Object.freeze({ title: 'a lowly peon', min: 1, max: 2 }),
  Object.freeze({ title: 'an average soldier', min: 3, max: 4 }),
  Object.freeze({ title: 'a notable fighter', min: 5, max: 6 }),
  Object.freeze({ title: 'a great warrior', min: 7, max: 8 }),
  Object.freeze({ title: 'a supreme hero', min: 9, max: 10 }),
]);
export const TOP_RANK = RANKS[RANKS.length - 1];

/** Which soldier shield this pack holds, as {faction, item}, or null. */
export function shieldOf(items = []) {
  for (const army of Object.values(ARMIES)) {
    const item = items.find(i => lower(i?.name ?? i) === lower(army.shield));
    if (item) return { faction: army.id, item };
  }
  return null;
}

/** The other two armies — the ones whose troops raise this shield. */
export const enemiesOf = faction => Object.values(ARMIES).filter(a => a.id !== faction);

/** The rank band out of a shield's description, as {army, title, min, max}, or null. */
export function readRank(description) {
  const m = /Your rank within\s+(.+?)\s+is:\s*(.+?)\s*\./i.exec(String(description ?? ''));
  if (!m) return null;
  const band = RANKS.find(r => lower(r.title) === lower(m[2]));
  return band ? { army: m[1], ...band } : null;
}

export const isMaxed = rank => !!rank && rank.min >= TOP_RANK.min;

/**
 * HOW MANY ENEMY TROOPS STAND BETWEEN THIS BAND AND THE TOP ONE. One rank per kill, so it is the
 * distance from the band's ends to rank 9, the first rank that reads "a supreme hero". A range,
 * because the band hides which of its two ranks the shield is on.
 */
export function killsToMax(rank) {
  if (!rank) return null;
  return { min: Math.max(0, TOP_RANK.min - rank.max), max: Math.max(0, TOP_RANK.min - rank.min) };
}

/** Who holds a flagpole, from its description: duke | princess | rebel | 'none', or null. */
export function flagHolder(description) {
  const text = String(description ?? '');
  if (!text.trim()) return null;
  if (/Duke Akardius/i.test(text)) return 'duke';
  if (/Princess Kateriina/i.test(text)) return 'princess';
  if (/rebel forces/i.test(text)) return 'rebel';
  if (/lies empty|unclaimed/i.test(text)) return 'none';
  return null;
}

/**
 * WHERE TO LOOK, IN ORDER. Both enemy armies' starting holdings first, nearest first; then every
 * other wilderness flag room, nearest first. `etaMs` maps room -> estimated ms; unknown sorts last.
 * An explicit `rooms` list replaces the search outright.
 */
export function enemyHuntOrder(faction, etaMs = {}, { rooms = null, max = 8 } = {}) {
  const eta = r => (Number.isFinite(etaMs[r]) ? etaMs[r] : Infinity);
  const byEta = list => [...list].sort((a, b) => eta(a) - eta(b));
  if (rooms?.length) return byEta(rooms).slice(0, Math.max(1, max));
  const homes = [...new Set(enemiesOf(faction).flatMap(a => a.rooms))];
  const rest = WILDERNESS_FLAG_ROOMS.filter(r => !homes.includes(r));
  return [...byEta(homes), ...byEta(rest)].slice(0, Math.max(1, max));
}

/** Is this room worth staying in? `objects` is a look's object list; `holder` the pole's owner. */
export function roomVerdict(faction, objects = [], holder = null) {
  const enemies = enemiesOf(faction);
  const troops = enemies.map(a => ({ troop: a.troop,
    count: objects.filter(o => lower(o?.name) === lower(a.troop)).length })).filter(t => t.count > 0);
  if (troops.length) return { take: true, why: 'enemy troops present', troops };
  if (enemies.some(a => a.id === holder))
    return { take: true, why: `the flagpole flies ${holder} colours — it will spawn more`, troops };
  return { take: false, why: holder ? `the flagpole is ${holder === 'none' ? 'unclaimed' : `held by ${holder}`}`
                                    : 'no enemy troop, and whose flagpole it is could not be read', troops };
}

// ---------------------------------------------------------------- the world-facing helpers

/**
 * THE SHIELD, READ FROM THE WORLD: which faction, and which band its description is in.
 *
 * The id comes from a fresh inventory read every time (a save renumbers it), and `describeItem`
 * refuses a reply about some other object. A negative id is an array index wearing an id's name
 * (CLAUDE.md), so it falls back to asking by the shield's name.
 */
export async function readShield(call, agent, opts = {}) {
  const inv = await call('inventory', { agent }, 60_000).catch(() => null);
  if (!inv?.items) return { error: 'could not read the pack' };
  const found = shieldOf(inv.items);
  if (!found) return { none: true };
  const { item } = found;
  let text = null;
  if (Number(item.id) > 0) text = (await describeItem(agent, item.id, { call }).catch(() => null))?.text ?? null;
  if (!readRank(text)) {
    const r = await call('look_at', { agent, target: ARMIES[found.faction].shield }, 30_000).catch(() => null);
    if (readRank(r?.description)) text = r.description;
  }
  const rank = readRank(text);
  // The /faction board's rank column is this reading; nothing else on the wire carries it.
  if (rank && opts.record !== false)
    recordIntel({ type: 'rank', army: rank.army, title: rank.title, min: rank.min, max: rank.max }, { agent });
  return { faction: found.faction, shield: ARMIES[found.faction].shield, id: item.id,
           in_use: item.in_use ?? item.equipped ?? null, rank, text };
}

/** The pole's owner in the room this character is standing in, or null when unreadable. */
async function poleOwner(call, agent, objects) {
  const pole = objects.find(o => lower(o?.name) === 'flagpole');
  if (!pole?.id) return null;
  const r = await describeItem(agent, pole.id, { call }).catch(() => null);
  return flagHolder(r?.text);
}

// ---------------------------------------------------------------- the errand

export const script = {
  name: 'max-faction-shield',
  describe: "Raise a soldier shield to its top rank (\"a supreme hero\") by farming the other two " +
            "armies' troops at the nearest flag room that has them. A no-op when already there; a " +
            'refusal without a shield.',
  recipe: {
    effect: 'The soldier shield in the pack reads "Your rank within <army> is: a supreme hero." ' +
            '(rank 9 or 10 — the description cannot say which)',
    run: 'max-faction-shield agents=<a> [rooms=<flag rooms>] [minutes=180] [home=<room>]',
    needs: ['a soldier shield — earn one with faction-shield.mjs',
            'a body that can stand up to level 70-145 troops, up to four at once, all hostile to it'],
    cost: {
      money: 'nothing',
      time: 'one rank per kill; a flag room makes about twelve troops an hour. From "a lowly peon", ' +
            'up to eight kills',
      risk: 'TROOPS ARE LEVEL 70-145 AND HOSTILE TO EVERY FACTION MEMBER. A death to a troop costs no ' +
            'rank, but a penalised logoff ghost costs four — and the shield itself at rank 3 or below',
    },
    scales: 'One character per flag room is plenty: a room holds four troops at most.',
  },

  provenance: {
    pinned: 'a175efb1',
    verified: '2026-10-13 (offline only)',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-factions.mjs', 'tools/m59-magicsort.mjs',
              'tools/m59-broker.mjs'],
    refuseOnDrift: false,
  },

  params: {
    agents: { type: 'agents', required: true, describe: 'who ranks up their shield' },
    rooms: { describe: 'comma list of flag rooms to scout, overriding the search' },
    max_rooms: { type: 'number', default: 10, describe: 'flag rooms to scout before giving up' },
    minutes: { type: 'number', default: 180, describe: 'farming budget once a room is found' },
    threat_flat: { type: 'number', default: 90, describe: 'flat engagement band over max health for the farm; ' +
                   '90 admits the level-145 top roll from 55 max health (prefarm-equipment uses the same)' },
    home: { type: 'number', describe: 'room to walk back to afterwards; omit to stay in the flag room' },
  },

  async steps({ rooms: roomsArg, max_rooms: maxRooms, minutes, threat_flat: threatFlat, home }) {
    const override = roomsArg ? String(roomsArg).split(',').map(Number).filter(Number.isFinite) : null;
    const maxR = Math.max(1, Number(maxRooms) || 10);
    // EVERY ROOM ANY LEG COULD CHOOSE, declared up front so trapCheck sees the whole set.
    const candidates = override ?? [...new Set([...Object.values(ARMIES).flatMap(a => a.rooms),
                                                ...WILDERNESS_FLAG_ROOMS])];
    const searching = st => !st.done && st.farmRoom == null;
    const stay = st => st.farmRoom ?? st.here;

    // ------------------------------------------------------------ preflight: the shield decides
    const preflight = verify(async ({ agent: me, call, state }) => {
      const o = await observe(me);
      state.here = o.room;
      const s = await readShield(call, me);
      if (s.error) return { ok: false, why: `${s.error} — refusing rather than guessing` };
      if (s.none)
        return { ok: false, outcome: 'no_shield',
                 why: 'this character carries no soldier shield (shield of the Duke\'s army, of the ' +
                      'Princess\' army, or of the rebel militia), so there is no rank to raise. Nothing ' +
                      'was done. Earn one first: faction-shield agents=<a> faction=<liege>' };
      state.faction = s.faction;
      state.enemyTroops = enemiesOf(s.faction).map(a => a.troop);
      state.rank = s.rank;
      if (!s.rank)
        return { ok: false, why: `holds the ${s.shield} but its description carried no rank line ` +
                 '("Your rank within ... is: ...") — refusing rather than farming blind' };
      if (isMaxed(s.rank)) {
        state.done = true;
        return { ok: true, outcome: 'already_max', faction: s.faction,
                 note: `NO-OP: the ${s.shield} already reads "${s.rank.title}" (rank 9-10), the top band` };
      }
      if (s.in_use === false)
        return { ok: false, why: `the ${s.shield} is in the pack but not in use — kills only count through ` +
                 'a shield the owner is using (Player.KilledSomething, FindUsing)' };
      // A CONFINEMENT THAT EXCLUDES THE FARM IS A KEEPER STANDING IN THE WRONG ROOM FOR EVER.
      const ap = await call('autopilot', { agent: me, action: 'status' }, 40_000).catch(() => null);
      const pol = ap?.policy ?? ap?.autopilot?.policy ?? {};
      state.confine = Array.isArray(pol.confineRooms) && pol.confineRooms.length ? pol.confineRooms : null;
      state.saved = { mode: ap?.mode ?? ap?.autopilot?.mode ?? null, hunt: pol.hunt ?? null,
                      assignedRoom: pol.assignedRoom ?? null, threatCeiling: pol.threatCeiling ?? null };
      const need = killsToMax(s.rank);
      return { ok: true, faction: s.faction, rank: s.rank.title, ranks: `${s.rank.min}-${s.rank.max}`,
               kills_needed: need.min === need.max ? need.min : `${need.min}-${need.max}`,
               hunting: state.enemyTroops };
    }, 'preflight: the shield');

    // ------------------------------------------------------------ plan the search
    const plan = verify(async ({ agent: me, call, state }) => {
      if (state.done) return { ok: true, skipped: 'already at the top rank' };
      const eta = {};
      for (const r of candidates) {
        const e = await call('travel_estimate', { from: state.here, to: r }, 15_000).catch(() => null);
        if (Number.isFinite(e?.ms)) eta[r] = e.ms;
      }
      state.order = enemyHuntOrder(state.faction, eta, { rooms: override, max: maxR });
      if (state.confine) {
        const allowed = state.order.filter(r => state.confine.includes(r));
        if (!allowed.length)
          return { ok: false, why: `this character is confined to ${state.confine.join(', ')}, and none of ` +
                   `the flag rooms is among them — lift the confinement (or a farm_strategy) first` };
        state.order = allowed;
      }
      return { ok: true, from: state.here, order: state.order };
    }, 'could not plan the search');

    // ------------------------------------------------------------ scout, nearest first
    const scout = [];
    for (let i = 0; i < maxR; i++) {
      scout.push(
        walk(st => (searching(st) && st.order?.[i]) || stay(st), { candidates, optional: true }),
        verify(async ({ agent: me, call, state }) => {
          const view = await call('look', { agent: me }, 30_000).catch(() => null);
          state.here = Number(view?.room?.num ?? state.here);
          if (!searching(state) || !state.order?.[i]) return { ok: true, skipped: true };
          const objects = view?.objects ?? [];
          const holder = await poleOwner(call, me, objects);
          const v = roomVerdict(state.faction, objects, holder);
          (state.scouted ??= []).push({ room: state.here, ...v });
          if (v.take) state.farmRoom = state.here;
          return { ok: true, room: state.here, take: v.take, why: v.why, troops: v.troops };
        }, 'could not look around the flag room'),
      );
    }

    // ------------------------------------------------------------ farm until the title changes
    const until = async ({ agent: me, call, state }) => {
      if (state.done) return { done: true, note: 'already at the top rank' };
      const s = await readShield(call, me);
      if (s.none) return { done: false, why: 'the shield is GONE from the pack (a penalised logoff ghost at ' +
                           'rank 3 or below deletes it)' };
      if (s.rank) {
        if (state.rank && s.rank.min !== state.rank.min)
          console.log(`  ${me}: shield rank now "${s.rank.title}" (${s.rank.min}-${s.rank.max})`);
        state.rank = s.rank;
      }
      return { done: isMaxed(state.rank), rank: state.rank?.title ?? null,
               ...(s.rank ? {} : { why: 'the shield\'s rank line could not be read this time' }) };
    };

    const farm = [
      verify(async ({ state }) => {
        if (state.done) return { ok: true, skipped: true };
        if (state.farmRoom != null) return { ok: true, farming: state.farmRoom };
        return { ok: false, scouted: state.scouted ?? [],
                 why: `no enemy troop and no enemy-held flagpole in ${state.order?.length ?? 0} flag room(s): ` +
                      `${state.order?.join(', ') ?? 'none'}. Holdings change in the territory game — pass ` +
                      'rooms=<flag rooms an enemy holds> or max_rooms=<more>' };
      }, 'no enemy flag room found'),
      // THE BAND. A troop is refused by the default 150% band, so take a flat one for the farm.
      verify(async ({ agent: me, call, state }) => {
        if (state.done) return { ok: true, skipped: true };
        const r = await call('autopilot', { agent: me, action: 'start',
          threat_ceiling: { mode: 'flat', value: Number(threatFlat) || 90 } }, 40_000).catch(e => ({ error: e.message }));
        if (r?.error) return { ok: false, why: `the troop band was refused: ${r.error}` };
        state.pushed = true;
        return true;
      }, 'the troop band'),
      walk(stay, { candidates }),
      harvest({ quarry: st => st.enemyTroops ?? [], room: st => st.farmRoom ?? st.here,
                minutes: Number(minutes) || 180, until }),
    ];

    return [
      preflight,
      plan,
      ...scout,
      ...farm,
      // ALWAYS: put the posture back the way it was found — a maxed shield gains nothing more,
      // and a keeper left hunting troops in a flag room is a keeper fighting for nothing.
      { ...verify(async ({ agent: me, call, state }) => {
          if (!state.pushed) return { ok: true, skipped: 'nothing was changed' };
          const s = state.saved ?? {};
          const back = {
            ...(s.mode ? { mode: s.mode } : {}),
            ...(s.hunt != null ? { hunt: s.hunt } : {}),
            assigned_room: s.assignedRoom ?? null,
            ...(s.threatCeiling ? { threat_ceiling: s.threatCeiling } : {}),
          };
          const r = await call('autopilot', { agent: me, action: 'start', ...back }, 40_000)
            .catch(e => ({ error: e.message }));
          return r?.error ? { ok: false, why: `could not restore the posture: ${r.error}`, saved: s }
                          : { ok: true, restored: back };
        }, 'posture restored'), always: true },
      ...(home === undefined || home === null ? []
        // Home only if the search set out: a refusal or a no-op stays exactly where it stood.
        : [{ ...walk(st => (st.order ? Number(home) : st.here), { candidates: [Number(home)] }),
             always: true }]),
      { ...verify(async ({ agent: me, call, state }) => {
          if (!state.faction) return { ok: true, outcome: 'no_shield' };
          const s = await readShield(call, me).catch(() => ({}));
          const rank = s.rank ?? state.rank;
          return { ok: true, outcome: isMaxed(rank) ? 'max' : 'not_max', faction: state.faction,
                   rank: rank?.title ?? 'unreadable', farmed_in: state.farmRoom ?? null,
                   note: isMaxed(rank) ? 'rank 9 or 10 — the description cannot say which' : undefined };
        }, 'could not read the shield at the end'), always: true },
    ];
  },
};
