import { pathToFileURL } from 'node:url';
import { tuningFor } from './m59-tuning.mjs';

// A PROFILE IS A WHOLE POSTURE, NOT A NUMBER.
//
// `substrate/policy.local.json` already carries this checkout's OPINIONS — flee thresholds,
// vigor floors — and its overridable surface is deliberately small. What it cannot express
// is the thing that actually keeps a bare fleet alive, which is not a threshold at all: it
// is WHERE the fleet is allowed to be, and every one of the dozen separate policy fields
// that can quietly walk a character out of that place.
//
// WHY THIS EXISTS. On 2026-08-19 a graveyard shift put 14 of 21 characters in the Underworld
// inside one 35-minute window. Not one of them died to the prey. They died CROSSING — 584
// The Flatlands, 585 the border of the Badlands, 576 The King's Way, 587 the Western border
// of the Twisted Wood — and death costs max health, which IS the level here. On top of that
// a player, Morpheus, landed 30 hits across 12 of them on those same roads.
//
// So the posture that survives is "farm what is already inside the walls and never step
// outside them". That is one setting in spirit and THIRTEEN in practice, and getting any one
// of them wrong puts a character on a road. This file is that list, written once.
//
// THE GUARD IS THE POINT, NOT THE POLICY BLOB. Anyone can set `assigned_room`. What this
// refuses is the two ways a "town-safe" posture silently stops being town-safe:
//
//   1. a farm room OUTSIDE the town — the character walks out to reach its own assignment;
//   2. a character that is not IN the town yet — applying the profile does not teleport it,
//      it sends it across exactly the wilderness this profile exists to avoid.
//
// Both are refusals rather than warnings, because both look like success from the board.

// ---------------------------------------------------------------------------- the towns
//
// Derived by walking `edgeExits` + `goExits` out of the town hub in `substrate/m59-map.json`,
// then curated by hand — a name cannot do this job. "The Deep Dark Woods of Tos" (4) carries
// the town's name and is wilderness; "Familiars" (52) and "The Crypt" (71) do not carry it
// and are indoors. `boundary` is listed rather than merely omitted, because the rooms a
// character must NOT step into are the ones worth naming: 585 and 587 are where this fleet
// actually died.
export const TOWNS = {
  tos: {
    name: 'Tos',
    hub: 50,
    rooms: [50, 51, 52, 53, 54, 56, 57, 58, 61, 70, 71, 72, 73, 74],
    boundary: [586, 596, 585, 587],
    farms: {
      70: { prey: 'zombie', why: 'The Graveyard of Tos - zombie 85%, skeleton 15%. NIGHT ONLY: ' +
                                 'tosgrave.kod gates creation on the hour, 35 real minutes in every ' +
                                 '120. Ask tools/m59-dayclock.mjs before expecting anything there' },
      71: { prey: 'zombie', why: 'The Crypt - zombie 80%, skeleton 20%. Whether it is day-gated the ' +
                                 'way the graveyard is has NOT been verified here; do not assume it' },
    },
    // AN AREA IS TIGHTER THAN A TOWN, AND THIS ONE IS A POCKET WITH ONE DOOR.
    //
    // Read out of the baked map rather than assumed: room 71 has exactly ONE exit and it
    // is room 70; room 70 has two, the door back to 71 and a west EDGE to 50 The Streets
    // of Tos. So the graveyard and the crypt are a closed two-room pocket whose only leak
    // is 70 -> 50, which is what makes "these two rooms and nowhere else" a thing the map
    // itself supports rather than a rule we are hoping the keeper honours.
    //
    // Confining to an area is not the same as assigning a room. The assignment says where
    // to farm; the area says which rooms are not a failure, and the difference shows up
    // when something OTHER than the assignment moves a character - a rest, a refuge, a
    // withdraw. That is how Camilla left: `restInTown` walked her to an inn while her
    // assignment still read 70 and the board still read healthy.
    areas: {
      undead: {
        name: 'the Graveyard and the Crypt',
        rooms: [70, 71],
        leaks: [{ from: 70, to: 50, kind: 'west edge', name: 'The Streets of Tos' }],
        why: 'the crypt is a dead end off the graveyard; the graveyard\'s west edge is the ' +
             'only way out of the pair',
      },
    },
  },

  // NOT A TOWN - A KEEP. The same structure answers "which rooms are not a failure", and
  // the reason to farm here is the one thing Tos could not offer on 2026-08-19: it is
  // reported clear of the players who were killing this fleet for sport. The monsters are
  // still a real fight and are the whole of the risk.
  castle_victoria: {
    name: 'Castle Victoria',
    hub: 38,
    rooms: [38, 39],
    // Room 38 is a HUB, not a dead end: three ways out of the pair, and 2 leads on to
    // Ukgoth. 39 is the dead end. Naming them is what makes "she must not leave" checkable.
    boundary: [2, 40, 41],
    farms: {
      39: { prey: 'battered skeleton',
            why: 'Upstairs in Castle Victoria - battered skeleton 60% (level 60), zombie 40% ' +
                 '(level 55). THE ONE TO FARM: a dead end with one exit, and BOTH its spawns ' +
                 'sit under a 150% ceiling for a character of 41+ max health, so nothing here ' +
                 'has to be refused. Hunting the skeleton alone is fine - the zombies become ' +
                 'cap blockers and capBlockers() clears what it may safely kill' },
      38: { prey: 'zombie',
            why: 'Castle Victoria - skeleton 40% at LEVEL 75 and zombie 20%. A worse room for ' +
                 'a small character than its own upstairs: the 150% ceiling refuses the ' +
                 'skeletons, so she would stand among things she cannot fight and cannot clear' },
    },
    areas: {
      keep: {
        name: 'Castle Victoria and Upstairs',
        rooms: [38, 39],
        leaks: [
          // THE ONE THAT HAS ACTUALLY KILLED SOMEBODY. Inside the castle is reported clear
          // of the players hunting this fleet; the front step is NOT, and Gonzo was murdered
          // there on 2026-08-19 after drifting out of 38. `retreatToSafety` aims at exactly
          // this room - PREFERRED_QUIET_RETREATS maps both 38 and 39 to 2 - so the harness's
          // own survival path leads to the one square that is unsafe from players. It is
          // monster-free, which is what that table means by safe, and that is not the same
          // fact. Do not let a confinement here rely on nobody taking this door.
          { from: 38, to: 2,  kind: 'door',
            name: 'Outside Castle Victoria - NOT player-safe, and on to Ukgoth' },
          { from: 38, to: 40, kind: 'door', name: 'The Throne Room of Victoria Castle' },
          { from: 38, to: 41, kind: 'door', name: 'Underbasement of Victoria' },
        ],
        why: '39 is a dead end off 38; every way out of the pair is a door in 38',
      },
    },
  },
};

// The two things worth knowing about each before sending anybody at them. Levels are from
// substrate/m59-spawns.json. A kill only pays when the creature's level is STRICTLY above
// base max health, and max health IS the level here.
export const PREY = {
  zombie:             { level: 55, rating: 405 },
  'battered skeleton': { level: 60, rating: 420 },
  skeleton:           { level: 75, rating: 525 },
};

// ---------------------------------------------------------------------------- the profile
//
// EVERY FIELD HERE THAT LOOKS LIKE HOUSEKEEPING IS A DEPARTURE. That is the whole content of
// this object: `bank_above` walks to a bank, `sell_at_load` to a market, `vault_items` to the
// BARLOQUE vault, `guild_wants`/`guild_tithe` to a guild hall, `conflict_response_hops` to
// wherever a fleetmate is fighting, `farm_delivery` to an apothecary. None of them are
// obviously about travel and all of them are.
export const PROFILES = {
  town_safe_farming: {
    why: 'farm what is inside the walls and never step outside them',
    policy: {
      mode: 'farm',
      roam: false,
      roam_limit: 0,
      use_safe_spots: true,
      // THE ONE THAT ACTUALLY LET CAMILLA OUT. Every other strategy carries
      // `restInTown: true`, which walks a hurt character back to an inn to recover - a
      // journey, taken while hurt, through the rooms this profile exists to keep it out
      // of, and it happens with the assignment still reading 70 and the board still
      // reading healthy. `fieldrest` is the one that says "never walk back to town;
      // withdraw within the hunting area and rest there", which is the whole posture.
      strategy: 'fieldrest',
      rest_below: 0.9,
      flee_below: 0.6,
      hold_resume_above: 0.9,
      // This profile deliberately chooses the keeper's food-backed default. A direct
      // operator/controller floor can be lower (80 is the reachable no-food cap), but this
      // confined undead farm keeps the extra opening margin.
      fight_above_vigor: 100,
      // The resting cap. Above it a mid-journey heal can never fire for an unfed fleet.
      travel_hold_vigor: 80,
      // A bare fleet cannot out-trade a murderer, but standing still is not a defence.
      defend_against_players: true,
      // A PREFERENCE, NOT A FILTER. The default (null) ranks by the character's existing
      // proficiency, which only ever rewards what it is already best at - so a fleet that
      // starts with a mace never trains anything else. Naming the hammer trains one skill
      // across the whole fleet instead of twenty-one divergent ones, and because it is a
      // preference rather than a filter a character holding nothing else still arms itself.
      // Note the skill is called "wielding", not "hammer proficiency" - see WEAPON_PROFICIENCY.
      weapon_priority: ['hammer'],
      // NO CEILING ON FETCHING. `pull` walks out, hits it once and walks straight back to
      // the wall, and the walk out happens before the thing has noticed us - so a long pull
      // is the same danger for longer, not more danger. Refusing it leaves a character
      // standing at a good wall with nothing to kill.
      pull_within: 999,
      // --- the departures ---
      buy_food: false,
      buy_weapons: false,
      buy_reagents: false,
      sell_when_broke: false,
      sell_at_load: 1,
      // No merchant trip during a shelter shift: retain food/reagents/gear and shed
      // only the lowest-value expendable loot to keep pickup headroom.
      drop_at_load: 0.75,
      bank_above: 100000000,
      farm_delivery: null,
      farm_cleanup: null,
      vault_items: [],
      guild_wants: null,          // MUST be null - `false` throws and aborts the rest of the call
      guild_tithe: null,
      conflict_response_hops: 1,  // 0 is silently turned into 5 by `Number(x) || 5`
      max_carry: 200,
    },
  },
};

const townOf = t => TOWNS[String(t || '').toLowerCase()] ?? null;

/**
 * Plan the profile for ONE character. Pure - it reads nothing and moves nobody, so the
 * preview and the write are the same function and a preview cannot drift from what it
 * previews.
 *
 * @param {object}  a
 * @param {string}  a.character   for the report
 * @param {number}  a.at          the room it is standing in RIGHT NOW
 * @param {number}  a.room        the room to farm
 * @param {number}  a.maxHealth   base max health - the level, and the engagement ceiling
 * @param {string} [a.town]       default 'tos'
 * @param {string} [a.profile]    default 'town_safe_farming'
 */
export function planProfile({ character = null, at = null, room = null, maxHealth = null,
                              town = 'tos', profile = 'town_safe_farming', area = null } = {}) {
  const refusals = [], notes = [];
  const spec = PROFILES[profile];
  const t = townOf(town);
  if (!spec) refusals.push(`no profile called "${profile}" - known: ${Object.keys(PROFILES).join(', ')}`);
  if (!t) refusals.push(`no town called "${town}" - known: ${Object.keys(TOWNS).join(', ')}`);
  if (!spec || !t) return { ok: false, character, refusals, notes, policy: null };

  // AN AREA NARROWS THE TOWN, IT NEVER WIDENS IT. Asking for one that does not exist is a
  // refusal rather than a silent fall back to the whole town, because the caller asking
  // for a two-room pocket and getting a fourteen-room town would look like it worked.
  let ar = null;
  if (area != null) {
    ar = t.areas?.[String(area)] ?? null;
    if (!ar) refusals.push(`no area called "${area}" in ${t.name} - known: ` +
                           `${Object.keys(t.areas ?? {}).join(', ') || 'none'}`);
  }

  const farm = room ?? null;
  // REFUSAL 1: a farm room outside the walls makes the profile walk the character out to
  // reach its own assignment, which is the exact opposite of what it is for.
  if (farm == null) refusals.push('no farm room given');
  else if (!t.rooms.includes(Number(farm))) {
    const edge = t.boundary.includes(Number(farm));
    refusals.push(`room ${farm} is not inside ${t.name}` +
      (edge ? ' - it is a BOUNDARY room, which is where this fleet actually dies'
            : `. Inside: ${t.rooms.join(', ')}`));
  }
  // REFUSAL 1b: with an area asked for, the farm must be inside THAT, not merely in town.
  if (ar && farm != null && !ar.rooms.includes(Number(farm)))
    refusals.push(`room ${farm} is inside ${t.name} but not inside ${ar.name} - ` +
                  `confined to ${ar.rooms.join(' and ')}`);

  // REFUSAL 2: applying a posture does not move anybody. A character outside the walls
  // would travel to its assignment through the wilderness, unattended.
  if (at == null) notes.push('current room unknown - cannot confirm it is already inside the walls');
  else if (!t.rooms.includes(Number(at)))
    refusals.push(`standing in room ${at}, outside ${t.name} - applying this would send it ` +
                  `across the wilderness to reach the farm. Walk it in first, then apply`);
  // Inside the town but outside the area is NOT a refusal: walking Familiars -> the
  // graveyard is a town walk, which is the thing this profile considers safe. It is a note
  // because the character is about to make a trip, and a trip is worth saying out loud.
  else if (ar && !ar.rooms.includes(Number(at)))
    notes.push(`in ${t.name} but outside ${ar.name} - it will walk to room ${farm} ` +
               `(inside the town) before it starts`);

  // The leak is REPORTED rather than assumed shut. Nothing here can close a door; what
  // this profile does is remove every REASON to take it, and naming it is what lets
  // somebody check the difference by watching one room instead of the whole map. It is a
  // property of the AREA and not of the character, so it is returned once rather than
  // pushed onto twenty-one identical note lists.
  const leak = ar?.leaks?.length
    ? `the ${ar.leaks.length === 1 ? 'only way' : `${ar.leaks.length} ways`} out of ` +
      `${ar.name}: ` +
      ar.leaks.map(l => `${l.from} -> ${l.to} (${l.kind}, ${l.name})`).join('; ') +
      ` - watch ${ar.leaks.length === 1 ? 'that door' : 'those doors'} to know whether this ` +
      'is holding'
    : null;

  // Not a refusal: a character that cannot engage the prey is safe, it just earns nothing,
  // and saying so is more useful than silently assigning it.
  const preyName = t.farms[Number(farm)]?.prey ?? null;
  const prey = PREY[preyName] ?? null;
  if (prey && Number.isFinite(maxHealth) && maxHealth > 0) {
    const ceiling = maxHealth * 1.5;           // threat_ceiling default {percent, 150}
    if (prey.level > ceiling)
      notes.push(`the engagement ceiling refuses ${preyName} (level ${prey.level} > ` +
                 `${ceiling.toFixed(1)}) - it will hold a wall and earn nothing`);
    else if (prey.level <= maxHealth)
      notes.push(`${preyName} PAYS NOTHING for advance (level ${prey.level} is not above ` +
                 `max health ${maxHealth}) - it can fight, but not level`);
  }

  // THE TACTICS OVERLAY GOES ON LAST, because a profile is a posture and tactics are the
  // half somebody changes their mind about. Silence means the profile stands; an unusable
  // value or an unknown key is REPORTED here rather than applied, so a typo shows up on the
  // plan instead of quietly running on a live fleet. See m59-tactics.mjs.
  const tac = tuningFor({ profile, character });
  const policy = { ...spec.policy, ...tac.overrides, assigned_room: Number(farm) };
  if (preyName) policy.hunt = preyName;
  // AN AREA IS A CONFINEMENT, SO SAY SO TO THE PART THAT MOVES A CHARACTER ANYWAY.
  // `assigned_room` is where to farm and the survival refuge does not read it — which is
  // how Gonzo was walked to room 2 and killed there twice on 2026-08-19 while his
  // assignment still read 39. `confine_rooms` is the same list the area already holds,
  // handed to the one code path that would otherwise ignore it.
  if (ar?.rooms?.length) policy.confine_rooms = ar.rooms.slice();
  for (const p of tac.problems) notes.push(`tuning ${p.where}: ${p.why}`);
  const tuned = Object.keys(tac.overrides);
  if (tuned.length) notes.push(`tuning overlay: ${tuned.map(k => `${k}=${JSON.stringify(tac.overrides[k])}`).join(', ')}`);
  return { ok: refusals.length === 0, character, town: t.name, area: ar?.name ?? null,
           confinedTo: ar?.rooms?.slice() ?? null, leak, profile, room: Number(farm),
           policy, refusals, notes };
}

/** Every room this profile would ever let a character stand in. */
export function allowedRooms(town = 'tos') { return townOf(town)?.rooms?.slice() ?? []; }

// ---------------------------------------------------------------------------- the CLI
//
// Guarded on being the entry point so the pure half above can be imported by a test
// without this running - the same arrangement m59-supervise.mjs uses.

const argv = process.argv.slice(2);
const has = f => argv.includes(`--${f}`);
const argOf = (f, d = null) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

async function call(name, args = {}, port) {
  const r = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
                           params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  const t = j.result?.content?.[0]?.text;
  try { return JSON.parse(t); } catch { return t; }
}

async function main() {
  const port = Number(argOf('port', 8901));
  const town = argOf('town', 'tos');
  const room = Number(argOf('room', 70));
  const profile = argOf('profile', 'town_safe_farming');
  const APPLY = has('apply');

  let fleet;
  try { fleet = await call('fleet', {}, port); }
  catch (e) { console.error(`no broker on ${port}: ${e.message}`); process.exitCode = 1; return; }

  const area = argOf('area', null);
  // --split spreads the fleet over every room in the area instead of stacking it on one.
  // Two rooms both generating the same prey is two respawn pools; twenty characters in one
  // of them is twenty characters waiting on one.
  const split = has('split') && area;
  const areaRooms = (TOWNS[town]?.areas?.[area]?.rooms) ?? [room];

  // --agent/--character narrows to one. Micromanaging a single character is a real case:
  // one may be somewhere safe that the rest of the fleet cannot reach.
  const only = argOf('agent', null) ?? argOf('character', null);
  if (only) fleet.fleet = (fleet.fleet || []).filter(
    r => String(r.agent) === only || String(r.character).toLowerCase() === only.toLowerCase());

  const rows = (fleet.fleet || []).map((r, i) => {
    const max = Number(String(r.health ?? '0/0').split('/')[1]) || null;
    const farm = split ? areaRooms[i % areaRooms.length] : room;
    return { agent: r.agent, room: farm,
             plan: planProfile({ character: r.character, at: r.room_num,
                                 room: farm, maxHealth: max, town, profile, area }) };
  });

  const ready = rows.filter(x => x.plan.ok);
  const held  = rows.filter(x => !x.plan.ok);

  for (const { agent, plan } of rows) {
    const tag = plan.ok ? 'ready ' : 'HELD  ';
    console.log(`${tag} ${String(agent).padEnd(4)} ${String(plan.character ?? '?').padEnd(10)}` +
                ` room ${plan.room}`);
    for (const r of plan.refusals) console.log(`         refused: ${r}`);
    for (const n of plan.notes)    console.log(`         note:    ${n}`);
  }
  const where = area ? `${TOWNS[town].areas[area].name} (rooms ${areaRooms.join(', ')})`
                     : `room ${room} in ${town}`;
  const leak = rows.find(x => x.plan.leak)?.plan.leak;
  if (leak) console.log(`\n${leak}`);
  console.log(`\n${ready.length} ready, ${held.length} held back — ${where}` +
              (split ? ', split across the area' : ''));

  if (!APPLY) { console.log('plan only — pass --apply'); return; }
  let ok = 0;
  for (const { agent, plan } of ready) {
    try { await call('autopilot', { agent, action: 'start', ...plan.policy }, port); ok++; }
    catch (e) { console.log(`  ${agent} FAILED: ${e.message}`); }
  }
  console.log(`applied to ${ok} of ${ready.length}`);
}

// A Windows path is neither a URL nor comparable to import.meta.url without pathToFileURL -
// the same note m59-supervise.mjs carries, and the same fix.
const isEntryPoint = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) main().catch(e => { console.error(e); process.exitCode = 1; });
