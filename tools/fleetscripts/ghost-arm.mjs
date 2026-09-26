// ARM THE GHOST RAID: a hammer in every hand, the reagents where the casters are, and every
// hammer dedicated to Kraanan — formed up Outside Castle Victoria.
//
//   node tools/m59-ghostraid.mjs arm --fleet shadow --lab           the lab rehearsal
//   node tools/m59-ghostraid.mjs arm --fleet prod                   the same code, no DM powers
//
// Phase one of `m59-ghostraid.mjs`. The fight is `ghost-raid.mjs`; this is everything that has
// to be true before anybody walks into room 40, and it is re-runnable: every step asks the
// world first and does only what is still missing.
//
// ============================================================================
// WHY A HAMMER, AND WHY DEDICATED
// ============================================================================
//
// The ghost resists ATCK_WEAP_NONMAGIC 90 and takes -50 from ATCK_WEAP_MAGIC (ghost.kod:83):
// measured 1.0 health per landed blow mundane against 6.9-10.9 dedicated. Enchant weapon IS the
// Kraanan dedication ("Your %s is now dedicated to Kraanan." enchwp.kod:19) and it sets that flag.
//
// The ghost does not care what kind of blow lands; the ESCORT does. Every Skeleton takes -20
// from BLUDGEON and resists THRUST 70 (skel.kod:75-82) and `TuskedSkeleton is Skeleton`. The
// long sword, the fleet's commonest weapon, THRUSTS. So a dedicated hammer is right for the
// boss AND for the half hour of farming after it, and a dedicated long sword is right for one.
//
// ============================================================================
// HAND-OVERS GO THROUGH `supply`, ONE AT A TIME
// ============================================================================
//
// `supply` drives both ends of the trade and re-reads the receiver, which is the only honest
// answer to "did it move" (`trade` lies in both directions). It is SERIALISED here: a character
// is in one trade at a time, and a receiver being offered two stacks by two donors at once is
// how a hand-over completes its handshake and moves nothing.
//
// Dedication is by HAND rather than on the floor. raid-arm's floor pile works (IsTargetInRange
// accepts a weapon owned by the room the caster stands in, enchwp.kod:75) and is right on a test
// server, but on prod room 2 is a public road and a dedication round is minutes long when the
// casters have to rest for mana between casts. A hammer in a caster's pack cannot be picked up
// by a stranger. `handover=floor` still exists for the lab.
//
// Identical hammers are fungible: a dedicator returns ANY dedicated hammer to each owner it owes
// one, rather than tracking which object came from whom — object ids are handles, and a check
// that depends on one surviving a hand-over is a check that fails on a save.
//
// ============================================================================
// THE LAB POWERS, AND WHERE THEY STOP
// ============================================================================
//
// `lab=true` lets this (a) create a hammer when the whole fleet has none spare, (b) top up a
// reagent the whole fleet is short of, and (c) refill a dedicator's mana instead of resting.
// All three remove WAITING and SHOPPING — noise — and none changes the fight being measured,
// which is the lab bargain in docs/m59-fleetscratch.md. Each one calls `assertLabFleet`, which
// throws on any fleet not named in M59_LAB_FLEETS, so `lab=true` against prod refuses before a
// single DM packet. On prod the same steps rest for mana and report a shortfall instead.
import { verify, walk, call, castVerified, assertLabFleet } from '../m59-fleetscript.mjs';
import { weighItem } from '../m59-items.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { handOver, earmark, eatTo } from '../m59-inventory.mjs';
import { forge } from '../m59-foundry.mjs';
import { OUTFIT_RUN, outfitNeeds, planOutfit, hallStock, profileOf, deliver, packRoom, poolMoney, armorerErrand, wearOutfit, lateDedicate,
         hallDraw, hallSplit, HALL_WANTS, OUTFIT, makeRoom }
  from './ghost-outfit.mjs';
import { STAGE_ROOM, DEDICATE, LIGHT, BLESS, HEAL, STRENGTH, buddyAssignments, isHammer, isBlunt, isWeaponName, hammerNeed, matchHammers,
         planReagents, countFamily, isReagent, assignRoles, raidNeeds, blessAssignments, expect, reexpect, barrier, leave }
  from '../m59-ghostraid-lib.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- one run's shared state. fleetScript runs every agent in this process.
const SURVEY = new Map();              // agent -> { character, wielding, items, spells, mana }
const DEDICATED = new Map();           // agent -> { weapon, outcome }
let SUPPLY_CHAIN = Promise.resolve();
const serially = fn => { const p = SUPPLY_CHAIN.then(fn, fn); SUPPLY_CHAIN = p.catch(() => {}); return p; };
const HANDED = new Map();              // dedicator -> [{ owner, character }] hammers it owes back
const RETURNED = new Set();            // owners who have their hammer back
let DEDICATORS_DONE = 0;
const CONVOY = new Set();              // agents whose muster crosses Ukgoth together
const FRAGILE_WEST = new Set();        // fragile characters crossing Ukgoth behind the convoy

async function dmLab() {
  const dm = await import('../m59-dm.mjs');
  return dm;
}

/** Mana, from the broker's own status shape (`mana: {value, max}`). */
const manaOf = s => Number(s?.mana?.value ?? s?.vitals?.mana?.value ?? 0);

export const script = {
  name: 'ghost-arm',
  describe: 'Muster outside Castle Victoria; a hammer in every hand; reagents to the casters; dedicate every hammer.',
  provenance: { pinned: '039a61e', verified: '2026-09-23',
                touches: ['tools/m59-fleetscript.mjs', 'tools/m59-supply.mjs', 'tools/m59-ghostraid-lib.mjs'] },
  recipe: {
    effect: 'Every raider stands in room 2 wielding a hammer (a mace if the fleet has no hammer ' +
            'for it) that is dedicated to Kraanan; the casters carry the reagents for it; the ' +
            'light-bearer carries forces-of-light reagents for the whole raid.',
    run: 'node tools/m59-ghostraid.mjs arm --fleet <fleet> [--lab]',
    needs: ['someone who knows enchant weapon', '3 elderberry + 1 orc tooth per hammer, fleet-wide',
            'a hammer per raider, fleet-wide, or --lab'],
    cost: { time: 'lab 3-6 min (mana refilled); prod 15-30 min, most of it resting for mana' },
  },
  params: {
    agents: { type: 'agents', required: true },
    stage: { type: 'number', default: STAGE_ROOM, describe: 'where the raid forms up. 2 = Outside Castle Victoria' },
    lightbearer: { type: 'string', default: '', describe: 'agent who casts forces of light; empty = whoever knows it' },
    healers: { type: 'string', default: '', describe: 'comma-separated; empty = three who know minor heal' },
    lab: { type: 'boolean', default: false, describe: 'allow DM grants and mana refills. REFUSES on a non-lab fleet' },
    plateau_ok: { type: 'number', default: 0.5, describe: 'a muster walk whose rest plateaus at or above this sets out from the plateau' },
    pack_room_min: { type: 'number', default: 400, describe: 'weight and bulk a raider must have free before hand-outs; heavy food is dropped to make it (0 = off)' },
    keep_food: { type: 'number', default: 10, describe: 'slices of each food kept when making room' },
    near_hops: { type: 'number', default: 2, describe: 'a muster walk this short (and not across Ukgoth) sets out at near_min_health' },
    near_min_health: { type: 'number', default: 0.3, describe: 'the floor for a short walk home; the stage room is where the raid rests' },
    muster_min_health: { type: 'number', default: 0.9, describe: 'health fraction to set out on the muster walk. NOT 1: a rest can plateau short of full (a ring of lethargy, a rounding step), and at 1 shadow12 (63/64) and shadow18 (57/60) were dropped from the 2026-09-25 rehearsal' },
    start_stats: { type: 'string', default: '', describe: 'LAB: JSON {agent:{karma,max_mana}} read from prod — mirrored at placement' },
    start_cup: { type: 'string', default: '', describe: 'LAB: the agent whose prod character holds the Chalice of the Rain; given a full one at placement if it has none' },
    start_positions: { type: 'string', default: '', describe: 'LAB: JSON {agent:{room,row,col}} — place each clone where its prod character stands, after the hold' },
    muster_wait_s: { type: 'number', default: 1500, describe: 'how long the survey waits for the muster to finish' },
    rally: { type: 'number', default: 598, describe: 'where a convoy gathers before crossing Ukgoth (0 = no convoy)' },
    fragile_below: { type: 'number', default: 30, describe: 'max health under which a character crosses Ukgoth BEHIND the convoy, at full health' },
    fragile_lag_s: { type: 'number', default: 6, describe: 'how far behind the convoy a fragile character sets out across Ukgoth' },
    rally_wait_s: { type: 'number', default: 600, describe: 'how long the convoy waits for its last member' },
    cross_gap_s: { type: 'number', default: 45, describe: 'seconds between characters crossing Ukgoth from the rally room (0 = all at once, a convoy)' },
    cross_min_health: { type: 'number', default: 0.7, describe: 'health a convoy member needs to cross from the rally room' },
    place: { type: 'boolean', default: false, describe: 'LAB: teleport to the stage room after the hold instead of walking' },
    handover: { type: 'string', default: 'hand', describe: '`hand` (supply to a dedicator and back) or `floor`' },
    light_casts: { type: 'number', default: 16,
                   describe: 'forces-of-light casts to provision the light-bearer for (~3 min each)' },
    bless_rounds: { type: 'number', default: 4,
                    describe: 'bless casts per raider to provision: the door, then a refresh every few minutes. ' +
                              'Sapphires are the scarce half — 2 a cast, and prod holds few' },
    herbs_each: { type: 'number', default: 30, describe: 'herbs every minor-heal caster should carry (1 a cast)' },
    channel: { type: 'string', default: 'say' },
    wait_mana_s: { type: 'number', default: 900, describe: 'how long a dedicator may rest for mana, in all' },
    // THE ARMORERS (ghost-outfit.mjs). Money pooled, a chalice ride to the guild hall, the Barloque
    // smith, back through Ukgoth together. No DM power anywhere in it.
    outfit: { type: 'boolean', default: true, describe: 'send armorers for shields, chain and missing hammers' },
    armorers: { type: 'string', default: '', describe: 'comma-separated; empty = the `armorer_count` strongest non-casters' },
    armorer_min_room: { type: 'number', default: 300, describe: 'an armorer needs this much free weight AND bulk, as the server counts it' },
    armorer_count: { type: 'number', default: 4, describe: 'how many armorers when none are named. The cup carries any number, one at a time' },
    hall_draw: { type: 'boolean', default: true, describe: 'armorers draw reagents, money and armour from the guild chests first' },
    hall_wants: { type: 'string', default: '', describe: 'JSON [{item, amount}] to take from the chests; empty = HALL_WANTS' },
    hall_wait_s: { type: 'number', default: 1800, describe: 'how long the fleet waits for the hall draw' },
    outfit_profile: { type: 'string', default: 'light', describe: 'light: leather + small round shield from the chests, chain from the smith for a gap; chain: rehearsal 21-24' },
    dress_limit_s: { type: 'number', default: 900, describe: 'late dedications must finish this long after the first starts; a raider not served by then goes to the door with the weapon it has' },
    extra_trip_min: { type: 'number', default: 3, describe: 'after the first armorer trip, ride again only for at least this many owed pieces' },
    spare_hammers: { type: 'number', default: 6, describe: 'hammers the armorers carry unassigned, for raiders the foundry fails' },
    gem_shop: { type: 'number', default: 109, describe: 'where a hall rider buys the sapphires and emeralds the chests lacked (Herbutte, the Sparkling Stone Shop; 0 = do not)' },
    split_hall: { type: 'boolean', default: true, describe: 'armorers draw armour and shop in ONE trip while runners fetch the reagents (false: rehearsal 21 order)' },
    hall_runners: { type: 'number', default: 1, describe: 'split_hall: how many raiders ride for the reagents' },
    trips: { type: 'number', default: 3, describe: 'shopping trips at most' },
    hall: { type: 'number', default: 714, describe: 'where the chalice lands a guild member (the Bookmakers hall)' },
    shop_room: { type: 'number', default: 113, describe: 'the Barloque smith' },
    reagent_shop: { type: 'number', default: 104, describe: 'the Barloque apothecary, where a hall rider buys what the chests lacked (0 = do not buy)' },
    apothecary: { type: 'string', default: 'Joguer', describe: 'the apothecary at reagent_shop' },
    smith: { type: 'string', default: "Fehr'loi Qan", describe: 'the merchant to sell to and buy from' },
    keep_shillings: { type: 'number', default: 20, describe: 'what each raider keeps when pooling money' },
    outfit_wait_s: { type: 'number', default: 3600, describe: 'how long the fleet waits for the armorers' },
    foundry: { type: 'boolean', default: true, describe: 'while the armorers are out, raiders with no blunt weapon make one with create weapon (m59-foundry)' },
    foundry_after_s: { type: 'number', default: 600, describe: 'how long into the armorer wait the foundry starts (a made weapon lasts 2 x spell power minutes)' },
    foundry_rooms: { type: 'string', default: '2,38', describe: 'rooms a caster may forge in; it picks the one whose head-count puts spell power nearest the hammer band' },
  },

  async steps(p, agentArg, state) {
    const agent = agentArg ?? p.agent;
    const agents = Array.isArray(p.agents) ? p.agents : String(p.agents).split(',').map(s => s.trim()).filter(Boolean);
    const lab = p.lab === true || p.lab === 'true';
    if (lab) assertLabFleet('ghost-arm lab=true');
    const say = text => call('say', { agent, type: p.channel, text: String(text).slice(0, 220) }, 30_000).catch(() => {});
    // WHAT THIS RAID HAS SPOKEN FOR, so no make-room ever drops it (operator, 2026-09-25: never drop
    // a sword earmarked for the current raid; any other weapon may go). Every hammer — the raid's
    // weapon, handed out and dedicated — and every weapon in a dedicator's pack, which is somebody's
    // weapon waiting for its dedication or on its way back.
    earmark('ghost raid: hammers', it => isHammer(it?.name));
    earmark('ghost raid: weapons a dedicator holds', (it, a) =>
      isWeaponName(it?.name) && SURVEY.size > 0 && rolesNow(agents, p).dedicators.includes(a));

    // START WHERE PROD STANDS (lab rehearsals only). A clone logs in wherever its body was last saved
    // on the lab server, not where its prod character is, because a DM placement does not stick to a
    // character that is logged out. Two no-DM rehearsals mustered from the wrong map because of it.
    // So `rehearse` hands in prod's positions and each clone is put there HERE — after the hold, so
    // no keeper can walk it off again — and everything after (the muster included) is walked.
    const mirror = (() => { try { return JSON.parse(String(p.start_positions || '{}'))[agent] ?? null; } catch { return null; } })();
    if (mirror) {
      assertLabFleet('ghost-arm start_positions');
      const dm = await dmLab();
      const me0 = await call('status', { agent, brief: true }, 30_000).catch(() => null);
      const who = me0?.character;
      if (who) {
        const r = await dm.relocate([who], Number(mirror.room), { row: mirror.row, col: mirror.col, verify: true });
        console.log(`  ${agent} placed where prod stands: room ${mirror.room} (${r?.moved?.[who] ?? '?'})`);
        // WAIT FOR THE KEEPER TO SEE IT. A relocation leaves the keeper's picture of the body stale
        // for a few seconds, and a walk that reads health in that gap refuses on "health is
        // unreadable" — shadow14 lost its whole run to that on 2026-09-25.
        const until = Date.now() + 30_000;
        while (Date.now() < until) {
          const o = await call('status', { agent, brief: true }, 20_000).catch(() => null);
          if ((o?.hp?.max ?? o?.vitals?.health?.max) && Number(o?.where?.num ?? o?.room_num) === Number(mirror.room)) break;
          await sleep(1500);
        }
        // THE CUP, WHERE PROD HAS IT. A clone runs free between the rebuild and the hold, and its
        // keeper rides the Chalice of the Rain on its own chalice-farming orders — every drink is
        // a charge and an empty cup is DELETED (chalice.kod NewApplied). On 2026-09-25 Loial's
        // clone came to the hold with none, and every armorer's ride found no cup. So the clone of
        // prod's cup holder is given a full one here, with the other start-of-run mirrors.
        // KARMA AND MAX MANA, WHERE PROD HAS THEM (see rehearse in m59-ghostraid.mjs). Karma is set;
        // mana is NODES — melded nodes are a bitmask ComputeMaxMana sums — so nodes are added one
        // at a time until the clone's max mana reaches prod's.
        const stats = (() => { try { return JSON.parse(String(p.start_stats || '{}'))[agent] ?? null; } catch { return null; } })();
        if (stats) {
          if (Number.isFinite(stats.karma)) await dm.kit(who, { karma: stats.karma }).catch(() => {});
          const maxManaNow = async () => Number((await call('status', { agent, brief: false }, 30_000).catch(() => null))?.mana?.max ?? 0);
          let mm = await maxManaNow();
          // BOTH DIRECTIONS: a clone can carry nodes from an earlier lab run (shadow20 had 44 max
          // mana against prod's 19), so the mask is rebuilt from ZERO up to prod's figure.
          if (Number.isFinite(stats.max_mana) && mm !== stats.max_mana) {
            const obj = (await dm.resolve([who]))[who];
            if (obj != null) {
              await dm.dm([`set object ${obj} piNodelist INT 0`, `send object ${obj} ComputeMaxMana`, `send object ${obj} NewMana`]);
              await sleep(1200);
              mm = await maxManaNow();
            }
            for (let k = 1; k <= 12 && mm < stats.max_mana && obj != null; k++) {
              await dm.dm([`set object ${obj} piNodelist INT ${(1 << k) - 1}`, `send object ${obj} ComputeMaxMana`, `send object ${obj} NewMana`]);
              await sleep(1200);
              mm = await maxManaNow();
            }
          }
          // READ BACK, not the number we asked for: the first version printed prod's karma while the
          // character still read 9, and the fight ran unlit.
          await sleep(1500);
          const kNow = (await call('status', { agent, brief: false }, 30_000).catch(() => null))?.karma?.value ?? '?';
          console.log(`  ${agent} mirrored prod: karma ${kNow} (prod ${stats.karma ?? '-'}), max mana ${mm} (prod ${stats.max_mana ?? '-'})`);
        }
        if (String(p.start_cup || '') === agent) {
          const has = ((await call('inventory', { agent }, 40_000).catch(() => null))?.items ?? [])
            .some(i => /chalice/i.test(String(i.name ?? '')));
          if (!has) {
            const ids = await dm.resolve([who]);
            const made = /Created object (\d+)/.exec(String(await dm.dm(['create object Chalice'])))?.[1];
            if (made && ids[who] != null) await dm.dm([`send object ${ids[who]} NewHold what OBJECT ${made}`]);
          }
          // READ BACK WITH PATIENCE: the keeper's inventory is a cache, and the first read after a
          // DM give still shows the old pack — the 2026-09-25 run printed NOT GIVEN for a cup that
          // had arrived, and a second give would have left two (a full cup refuses a second).
          let now = false;
          for (let i = 0; i < 5 && !now; i++) {
            await sleep(1500);
            now = ((await call('inventory', { agent }, 40_000).catch(() => null))?.items ?? [])
              .some(i2 => /chalice/i.test(String(i2.name ?? '')));
          }
          console.log(`  ${agent} holds the cup where prod does: ${has ? 'already' : now ? 'given a full one' : 'NOT GIVEN'}`);
        }
      }
    }
    const here = await call('status', { agent, brief: true }, 30_000).catch(() => null);
    const inStage = Number(here?.where?.num ?? here?.room_num ?? NaN) === Number(p.stage);
    for (const k of ['survey', 'hammers', 'reagents', 'dropped', 'armed']) expect(k, agents.length);

    // LAB PLACEMENT HAPPENS HERE, AFTER THE HOLD, NEVER BEFORE IT. The first shadow run placed
    // the fleet in room 2 from the driver and then took the hold: in the forty seconds between,
    // every keeper walked its character back towards its station, and fifteen of twenty-two were
    // standing in Ukgoth (599, KNOWN_TRAPS) when the claim landed. `steps()` runs after
    // `holdKeeper`, so a teleport issued from inside it cannot be undone by the keeper.
    const placeHere = lab && (p.place === true || p.place === 'true') && !inStage;

    // THE CONVOY. Room 2 has two routed neighbours: the castle (38) and Ukgoth (599), and Ukgoth's
    // only other routed neighbour is 598 (measured with travel_estimate over every baked room). So
    // from anywhere west, the last two hops are 598 -> 599 -> 2, and Ukgoth is 218 prod deaths —
    // the guardian StoneTroll is level 120 and simply there. One character at a time through that
    // room is the pattern that killed people; twenty at once is a fight the trolls lose. So anyone
    // whose road crosses 599 walks to the rally room, waits for the rest of the convoy, and crosses
    // with them. Characters on the castle side (38, 39) walk straight in.
    let convoy = false, hopsHome = null;
    if (!inStage && !placeHere && Number(p.rally)) {
      const from = Number(here?.where?.num ?? here?.room_num ?? NaN);
      if (from === Number(p.rally)) convoy = true;
      else {
        const [toStage, toRally] = await Promise.all([
          call('travel_estimate', { from, to: Number(p.stage) }, 20_000).catch(() => null),
          call('travel_estimate', { from, to: Number(p.rally) }, 20_000).catch(() => null)]);
        convoy = Number.isFinite(toStage?.hops) && Number.isFinite(toRally?.hops) && toStage.hops === toRally.hops + 2;
        hopsHome = Number.isFinite(toStage?.hops) ? toStage.hops : null;
      }
    }
    // A SHORT WALK HOME SETS OUT HURT. The muster's full-health floor is for open country; below
    // it the fleetscript hands the body back to its keeper to heal — and in the castle (38/39) the
    // keeper HUNTS skeletons and zombies, which is where prod's raiders stand. On the 2026-09-25
    // rehearsal that "heal" took Gonzo's clone from 48/72 to 1/72 and Robin's from 38 to 2/64,
    // one room from the stage. A walk of `near_hops` or fewer that does not cross Ukgoth sets out
    // at `near_min_health`, and the raid's own rest happens in the stage room, which is quiet.
    const nearHome = !convoy && hopsHome != null && hopsHome <= Number(p.near_hops);
    // A FRAGILE BODY CROSSES TOO — BEHIND THE CONVOY, AT FULL HEALTH. The first no-DM rehearsal
    // (2026-09-24) lost the 20-health light-bearer inside a convoy crossing Ukgoth, and this used
    // to refuse such a character outright. That was before the crossing was rebuilt: since
    // 7225998 a journey through 599 goes wall to wall on safe-spot legs (arrivals 22% -> 95%,
    // damage 724 -> 36). And the operator's standing requirement is that the raid muster fetches
    // the light-bearer from WHEREVER he is — on raid day nobody can promise he is at his post.
    // So he walks: to the rally room with the rest, healed to full there, and released a few
    // seconds after the convoy, so the trolls have somebody else to look at while he crosses.
    const maxHp = Number(here?.hp?.max ?? here?.vitals?.health?.max ?? 0);
    const fragile = convoy && maxHp && maxHp < Number(p.fragile_below);
    if (fragile) {
      FRAGILE_WEST.add(agent);
      console.log(`  ${agent}: ${maxHp} max health, west of Ukgoth — crossing behind the convoy at full health`);
    }
    if (convoy) CONVOY.add(agent);
    return [
      // ---- 0. MUSTER. A no-op walk to the room you stand in leaves a travel JOB registered
      // that refuses the next walk (raid-action.mjs, "A MUSTER WALK ... IS POISON").
      ...(inStage ? [] : placeHere ? [verify(async ({ state: st }) => {
        assertLabFleet('ghost-arm place=true');
        const dm = await dmLab();
        const me = await call('status', { agent, brief: true }, 30_000).catch(() => null);
        const who = me?.character;
        const r = who ? await dm.relocate([who], Number(p.stage), { verify: true }) : { ok: false };
        st.placed = r?.moved?.[who] ?? 'unknown';
        return { ok: st.placed === 'in the room', why: `lab placement: ${st.placed}` };
      }, 'the lab placement could not be read back', 'arm.place')]
        // FULL HEALTH TO SET OUT, whatever the raid's own floor is: this is the one walk that may
        // cross open country (m59-muster.mjs, "THE HEALTH FLOOR" — seven died at 0.35).
        : convoy ? [
          walk(Number(p.rally), { minHealth: Number(p.muster_min_health), plateauOk: Number(p.plateau_ok) }),
          verify(async ({ state: st }) => {
            // Everyone in the convoy, or the patience runs out — then whoever is here goes.
            reexpect('rally', CONVOY.size);
            const b = await barrier('rally', agent, { ms: Number(p.rally_wait_s) * 1000 });
            st.convoy = b;
            // ONE AT A TIME, NOT A CONVOY. The safe-leg crossing (7225998: arrivals 22% -> 95%) was
            // measured on single characters, wall to wall. Eight crossing at once on the 2026-09-25
            // rehearsal drew fifteen trolls into the room: one died at 4 squares in 54 s with no
            // wall reachable, and three were pushed back west. So the rally room is where they
            // GATHER and heal; they cross `cross_gap_s` apart, strongest first, the fragile last.
            const order = [...CONVOY].sort((x, y) => (FRAGILE_WEST.has(x) - FRAGILE_WEST.has(y)) || x.localeCompare(y));
            const turn = Math.max(0, order.indexOf(agent));
            await say(`Crossing Ukgoth alone, ${turn ? `after ${turn} ahead of me` : 'first'}.`);
            if (turn) await sleep(turn * Number(p.cross_gap_s) * 1000);
            if (fragile) await sleep(Number(p.fragile_lag_s) * 1000);
            return true;
          }, 'the convoy could not be read', 'arm.convoy'),
          // Nobody rests in 598 to top up: the convoy crosses together or it is not a convoy. The
          // fragile body is the exception — it was healed before the barrier (the walk to the
          // rally room sets out at muster_min_health), and it crosses at full or not at all.
          walk(Number(p.stage), { minHealth: fragile ? Math.max(0.95, Number(p.cross_min_health)) : Number(p.cross_min_health) }),
        ]
        : [walk(Number(p.stage), { minHealth: nearHome ? Number(p.near_min_health) : Number(p.muster_min_health), plateauOk: Number(p.plateau_ok) })]),

      // ---- 1. SURVEY. Everyone posts what it holds, then waits for everyone else, so the
      // hand-over plan below is computed from ONE picture of the fleet by every agent alike.
      verify(async ({ state: st }) => {
        const [me, inv, sp, lk] = await Promise.all([
          call('status', { agent, brief: false }, 40_000).catch(() => null),
          call('inventory', { agent }, 40_000).catch(() => null),
          call('spells', { agent }, 40_000).catch(() => null),
          call('look', { agent, fresh: true }, 40_000).catch(() => null),
        ]);
        const worn = (me?.equipment ?? []).find(e => isWeaponName(e)) ?? null;
        SURVEY.set(agent, { character: me?.character ?? agent, wielding: worn,
                            items: inv?.items ?? [], mana: manaOf(me), maxMana: Number(me?.mana?.max ?? 0),
                            maxHealth: Number(me?.hp?.max ?? me?.vitals?.health?.max ?? 0),
                            might: Number(me?.attributes?.might ?? 0),
                            // THE SERVER'S free room, not our estimate of it (see armorersOf).
                            roomFor: lk?.carry?.room_for ?? null,
                            spells: (sp?.spells ?? []).map(s => String(s.name ?? '').toLowerCase()) });
        // Long enough for a real muster (a convoy through 598 is ten-plus minutes), short when
        // the lab has teleported everyone. A character that failed its muster never arrives, and
        // everything after this barrier stops waiting for it (reexpect below).
        const b = await barrier('survey', agent, { ms: Number(p.muster_wait_s) * 1000 });
        // Whoever did not make the survey will not make anything after it.
        for (const k of ['hall-drawn', 'hammers', 'reagents-moved', 'reagents', 'dropped', 'armed', 'pooled']) reexpect(k, SURVEY.size);
        st.survey = { wielding: worn, fleet_seen: SURVEY.size, barrier: b };
        return true;
      }, 'the survey could not be read', 'arm.survey'),

      // ---- 1a. MAKE ROOM. A full pack refuses everything handed to it — a shield, chain, and on
      // the 2026-09-25 rehearsal the character's OWN weapon coming back from its dedicator, which
      // left shadow15 unarmed at the door. The weight is pork (the fleet carries thousands of
      // slices). A raider with less than `pack_room_min` weight or bulk free drops heavy food —
      // pork, then mutton — keeping `keep_food` of each, until it has the room. Lossy on purpose:
      // food is abundant and a weapon is not. pack_room_min=0 turns it off.
      verify(async ({ state: st }) => {
        const min = Number(p.pack_room_min);
        if (!(min > 0)) return true;
        // The operator's rule: junk loot, excess food and spare weapons go; money, reagents, the
        // cup, armour, anything worn, one spare of a worn weapon and whatever this raid earmarked
        // (every hammer, a dedicator's charges) stay (m59-inventory makeRoom).
        const dropped = await makeRoom(agent, { keep: Number(p.keep_food), min });
        if (dropped) console.log(`  ${agent} made room: dropped ${JSON.stringify(dropped)}`);
        st.room = { dropped };
        return true;
      }, 'making room in the pack', 'arm.make-room'),


      // ---- 1b. THE ARMORERS: everyone hands its money to one of the pair, and one plan is made.
      ...(outfitOn(p) ? [verify(async ({ state: st }) => {
        const pair = armorersOf(agents, p);
        const roles = rolesNow(agents, p);
        if (!pair.length) { st.pool = { skipped: 'no armorers' }; OUTFIT_RUN.done = true; return true; }
        if (!pair.includes(agent)) {
          const to = pair[[...agents].sort().indexOf(agent) % pair.length];
          st.pool = { to, ...(await poolMoney(agent, to, Number(p.keep_shillings))) };
        }
        await barrier('pooled', agent, { ms: 300_000 });
        if (agent === pair[0] && !OUTFIT_RUN.plan) {
          // THE HALL'S ARMOUR FIRST. Chain and shields drawn from the chests are in the armorers'
          // packs, where the planner would read them as the armorers' own. Each armorer keeps one
          // of a kind and hands the rest, here in the stage room, to raiders who have none.
          if (!splitOn(p)) {
            const want = {};
            await Promise.all(agents.filter(a => a !== roles.lightbearer && SURVEY.has(a) && !pair.includes(a)).map(async a => {
              want[a] = outfitNeeds((await call('inventory', { agent: a }, 40_000).catch(() => null))?.items ?? [], { profile: p.outfit_profile });
            }));
            const kinds = { chain: /^chain armor$/i, shield: /shield/i };
            for (const arm of pair) {
              const items = (await call('inventory', { agent: arm }, 40_000).catch(() => null))?.items ?? [];
              for (const [kind, re] of Object.entries(kinds)) {
                for (const piece of items.filter(i => re.test(String(i.name ?? '').trim())).slice(1)) {
                  const to = Object.keys(want).sort().find(a => want[a]?.[kind]);
                  if (!to) break;
                  // m59-inventory handOver: a full receiver makes room (junk, spare weapons, excess food) and is asked again.
                  const r = await handOver(arm, to, piece.id, { makeRoomMin: 200 }).then(h => ({ supplied: h.ok, reason: h.why }));
                  console.log(`  hall ${kind} ${arm} -> ${to}: ${r?.supplied ? 'given' : `NOT given (${r?.reason ?? '?'})`}`);
                  // A full pack refuses the piece; the next raider in need gets it instead of the
                  // same full one being offered every remaining piece (2026-09-25: receiver_full).
                  if (!r?.supplied) { want[to][kind] = false; continue; }
                  if (r?.supplied) {
                    want[to][kind] = false;
                    const got = OUTFIT_RUN.delivered.get(to) ?? []; got.push(kind); OUTFIT_RUN.delivered.set(to, got);
                  }
                }
              }
            }
          }
          // ONE plan for the whole fleet, from fresh packs, so the armorers split it without overlap.
          const needs = {}, packs = {};
          await Promise.all(agents.filter(a => a !== roles.lightbearer && SURVEY.has(a)).map(async a => {
            packs[a] = (await call('inventory', { agent: a }, 40_000).catch(() => null))?.items ?? [];
            needs[a] = outfitNeeds(packs[a], { profile: p.outfit_profile });
          }));
          const budget = pair.reduce((n, a) => n + (packs[a] ?? []).filter(i => /^shilling/i.test(String(i.name ?? '')))
            .reduce((m, i) => m + (Number(i.amount) || 1), 0), 0);
          // Planned against the pack as it will be AFTER selling: money, reagents, the cup and the
          // weapon are what stay.
          const capacity = pair.map(a => ({ agent: a, ...packRoom(SURVEY.get(a)?.might,
            (packs[a] ?? []).filter(i => /shilling|elderberr|herb|mushroom|orc tooth|emerald|sapphire|chalice|hammer|mace/i.test(String(i.name ?? '')))) }));
          // One load per trip; `trips` loads in all.
          const trips = Math.max(1, Number(p.trips));
          const bigCap = capacity.map(c => ({ ...c, weight: c.weight * trips, bulk: c.bulk * trips }));
          // Split mode plans against what the CHESTS hold (the armorers fetch it on the same trip) and
          // buys no hammer for anyone who can forge one while they are away.
          const stock = splitOn(p) && hallOn(p) ? hallStock(readChests(), { names: profileOf(p.outfit_profile).hall }) : [];
          const canForge = foundryOn(p)
            ? new Set(agents.filter(a => (SURVEY.get(a)?.spells ?? []).includes('create weapon'))) : new Set();
          // Spare hammers for whoever the foundry fails: one per raider with no blunt weapon at the
          // survey, capped by `spare_hammers` (0 = none).
          const noBlunt = agents.filter(a => a !== roles.lightbearer && SURVEY.has(a) && !(SURVEY.get(a).items ?? []).some(i => isBlunt(i.name))).length;
          const spares = Math.min(noBlunt, Number(p.spare_hammers ?? 0));
          OUTFIT_RUN.plan = planOutfit(needs, { budget, capacity: bigCap, stock, canForge, spares });
          const pl = OUTFIT_RUN.plan;
          console.log(`  armorers ${pair.join(' + ')}: budget ${budget}, buying ${pl.buys.length} piece(s) for ${pl.spend}` +
                      (pl.fromHall?.length ? `, ${pl.fromHall.length} from the chests` : '') +
                      (pl.spare?.length ? `, ${pl.spare.length} spare hammer(s)` : '') +
                      (pl.cut.length ? `; cut ${pl.cut.length} (${[...new Set(pl.cut.map(c => c.why))].join(', ')})` : ''));
          // EACH ARMORER PAYS FROM ITS OWN PURSE, and the hall's money arrived in one pack. So the
          // purses are levelled to each armorer's share of the bill before anyone leaves.
          const purse = a => (packs[a] ?? []).filter(i => /^shilling/i.test(String(i.name ?? '')))
            .reduce((m, i) => m + (Number(i.amount) || 1), 0);
          const bill = a => (pl.byCarrier?.[a] ?? []).reduce((m, l) => m + (OUTFIT[l.kind]?.price ?? 0), 0);
          const bal = Object.fromEntries(pair.map(a => [a, purse(a) - bill(a)]));
          for (const to of pair.filter(a => bal[a] < 0)) {
            for (const from of pair.filter(a => bal[a] > 0).sort((x, y) => bal[y] - bal[x])) {
              if (bal[to] >= 0) break;
              const amount = Math.min(bal[from], -bal[to]);
              const stack = (await call('inventory', { agent: from }, 40_000).catch(() => null))?.items
                ?.filter(i => /^shilling/i.test(String(i.name ?? '')) && i.id != null)
                .sort((x, y) => (y.amount || 1) - (x.amount || 1))[0];
              if (!stack) continue;
              const r = await call('supply', { from, to, what: [{ id: stack.id, amount }], who_travels: 'neither' }, 120_000)
                .catch(e => ({ supplied: false, reason: e.message }));
              console.log(`  purse ${from} -> ${to}: ${r?.supplied ? amount : 0}/${amount}${r?.supplied ? '' : ` (${r?.reason ?? '?'})`}`);
              if (r?.supplied) { bal[from] -= amount; bal[to] += amount; }
            }
          }
        }
        st.pool = { ...(st.pool ?? {}), armorers: pair };
        return true;
      }, 'the money pool could not be read back', 'arm.pool')] : []),

      // ---- 1c. THE HALL, SPLIT BY WHO IS WAITING FOR WHAT (split_hall, the default).
      //
      // Rehearsal 21 spent 92 minutes before the throne room. The four armorers rode to the hall,
      // drew everything, rode HOME, sat through the pool, hammer and reagent steps, then rode back
      // to the same hall to go shopping — and the fleet stood for 45 minutes waiting for that.
      // Now, straight after the money pool:
      //   ARMORERS leave every fleet barrier and go on ONE trip: the chests (armour by name, from
      //     the plan), the smith (what the chests lacked), home. The fleet meets them at the dress.
      //   RUNNERS (hall_runners, the roomiest raiders with no other job) draw only the REAGENTS and
      //     come straight back — dedication cannot start without them, and it need not wait for a
      //     shopping trip.
      //   EVERYONE ELSE rests; the hammer and reagent steps follow as soon as the runners are home.
      // split_hall=false is rehearsal 21's order: one hall draw by the armorers, then the rest.
      ...(outfitOn(p) && hallOn(p) ? [verify(async ({ state: st }) => {
        const roles = rolesNow(agents, p);
        const pair = armorersOf(agents, p);
        const wants = (() => { try { return JSON.parse(String(p.hall_wants || '')); } catch { return HALL_WANTS; } })();
        if (splitOn(p)) {
          if (pair.includes(agent)) {
            for (const k of ['hall-drawn', 'hammers', 'reagents-moved', 'reagents', 'armed', 'dropped']) leave(k, agent);
            const until = Date.now() + 180_000;
            while (!OUTFIT_RUN.plan && Date.now() < until) await sleep(2000);
            const lines = OUTFIT_RUN.plan?.byCarrier?.[agent] ?? [];
            await say(`Armorer: off to the hall and the smith for ${lines.length} piece(s).`);
            try {
              st.armorer = await armorerErrand({ agent, partner: pair.find(a => a !== agent), holder: cupHolderOf(agents, roles),
                                                 lines, p, crew: pair.length });
            } catch (e) {
              st.armorer = { error: e?.message ?? String(e) };
            } finally {
              OUTFIT_RUN.log.push({ agent, ...st.armorer });
              OUTFIT_RUN.finished = (OUTFIT_RUN.finished ?? 0) + 1;
              if (OUTFIT_RUN.finished >= pair.length) OUTFIT_RUN.done = true;
            }
            return true;
          }
          const runners = runnersOf(agents, p, roles, pair);
          if (runners.includes(agent)) {
            // WHAT THE RAID NEEDS, LESS WHAT THE FLEET CARRIES — every reagent, gems included (operator:
            // bring any and all required reagents). HALL_WANTS' reagent amounts are a floor. Rehearsal
            // 24's fixed list had no sapphires, and bless (two a cast) failed twenty times at the door.
            const need = raidNeeds(agents, roles, { lightCasts: Number(p.light_casts), blessRounds: Number(p.bless_rounds), herbsEach: Number(p.herbs_each) });
            const carried = k => agents.reduce((n, a) => n + countFamily(SURVEY.get(a)?.items ?? [], k), 0);
            const floor = Object.fromEntries(wants.filter(w => !/shield|armou?r|hammer/i.test(String(w.item))).map(w => [w.item, Number(w.amount) || 0]));
            const keys = new Set([...Object.keys(need), ...Object.keys(floor)]);
            const reagents = [...keys].map(k => ({ item: k, amount: Math.max(floor[k] ?? 0, Math.ceil((need[k] ?? 0) * 1.15) - carried(k)) }))
              .filter(w => w.amount > 0);
            console.log(`  ${agent} runner: drawing ${reagents.map(w => `${w.amount} ${w.item}`).join(', ')}`);
            const room = Object.fromEntries(runners.map(a => { const r = SURVEY.get(a)?.roomFor; return [a, r ? Math.min(r.weight ?? 0, r.bulk ?? 0) : undefined]; }));
            const share = hallSplit(runners, reagents, weighItem, room)[agent] ?? [];
            st.hall = await hallDraw({ agent, crew: runners, holder: cupHolderOf(agents, roles), share, p });
          } else if (agent !== roles.lightbearer) {
            await call('rest', { agent }, 30_000).catch(() => {});
          }
          await barrier('hall-drawn', agent, { ms: Number(p.hall_wait_s) * 1000 });
          return true;
        }
        const crew = pair;
        if (crew.includes(agent)) {
          // Each rider's free room as the server counted it at the survey: the split deals by it.
          const room = Object.fromEntries(crew.map(a => { const r = SURVEY.get(a)?.roomFor; return [a, r ? Math.min(r.weight ?? 0, r.bulk ?? 0) : undefined]; }));
          const share = hallSplit(crew, wants, weighItem, room)[agent] ?? [];
          st.hall = await hallDraw({ agent, crew, holder: cupHolderOf(agents, roles), share, p });
        } else if (agent !== roles.lightbearer) {
          await call('rest', { agent }, 30_000).catch(() => {});
        }
        await barrier('hall-drawn', agent, { ms: Number(p.hall_wait_s) * 1000 });
        return true;
      }, 'the hall draw could not be read back', 'arm.hall-draw')] : []),

      // ---- 2. A HAMMER IN EVERY HAND.
      verify(async ({ state: st }) => {
        const roles = rolesNow(agents, p);
        const isLight = roles.lightbearer === agent;
        // ONLY THE ONES STANDING HERE. A hand-over is one room; the armorers are out shopping by
        // now, and on the 2026-09-25 rehearsal one was planned as a hammer donor from Barloque
        // ("not in the room"). An armorer that comes back without one is lateDedicate's.
        const here = await presentOnce('hammers', agents, Number(p.stage));
        // FROM PACKS READ NOW, NOT THE SURVEY'S. Object ids are handles and packs have moved since the
        // survey (make-room, the pool, the hall): on the 2026-09-25 rehearsal two spare hammers were
        // offered by ids their donors no longer held ("carrying nothing matching those ids").
        // Read once for the step and shared, so every agent plans the same hand-overs.
        const packs = await packsOnce('hammers', agents.filter(a => a !== roles.lightbearer && SURVEY.has(a) && here.has(a)));
        const needs = Object.entries(packs).map(([a, pk]) => hammerNeed(a, { wielding: pk.wielding ?? SURVEY.get(a).wielding, items: pk.items }));
        const { transfers, short } = matchHammers(needs);

        // Donors hand over; receivers wait to see the hammer arrive.
        for (const t of transfers.filter(t => t.from === agent)) {
          // m59-inventory handOver: a full receiver makes room (junk, spare weapons, excess food) and is asked again.
          const r = await handOver(t.from, t.to, t.id, { makeRoomMin: 200 }).then(h => ({ supplied: h.ok, reason: h.why }));
          console.log(`  ${agent} -> ${t.to}: spare hammer ${r?.supplied ? 'handed over' : `NOT moved (${r?.reason ?? '?'})`}`);
        }
        let got = null;
        if (!isLight) {
          const mine = needs.find(n => n.agent === agent);
          if (mine?.has === 'none' && transfers.some(t => t.to === agent)) got = await waitForItem(agent, isHammer, 150_000);
          if (mine?.has === 'none' && !got && lab && short.includes(agent)) {
            assertLabFleet('ghost-arm: creating a hammer');
            const dm = await dmLab();
            const who = SURVEY.get(agent).character;
            const ids = await dm.resolve([who]);
            if (ids[who] != null) {
              const out = await dm.dm(['create object Hammer']);
              const id = /Created object (\d+)/.exec(String(out))?.[1];
              if (id) await dm.dm([`send object ${ids[who]} NewHold what OBJECT ${id}`]);
              got = await waitForItem(agent, isHammer, 20_000);
              console.log(`  ${agent} LAB: created a hammer (${got ? 'in the pack' : 'NOT seen in the pack'})`);
            }
          }
          st.hammer = await wieldBest(agent);
          if (!isHammer(st.hammer.wielding))
            await say(`No hammer for me — fighting with ${st.hammer.wielding ?? 'nothing'}.`);
        }
        await barrier('hammers', agent, { ms: 300_000 });
        st.hammer = { ...(st.hammer ?? {}), short_fleet_wide: short };
        return true;
      }, 'the hammer hand-out could not be read back', 'arm.hammers'),

      // ---- 3. REAGENTS TO THE CASTERS. The dedicators need 3 elderberry + 1 orc tooth per
      // hammer they will do, and the light-bearer 2 elderberry + 1 emerald per casting.
      verify(async ({ state: st }) => {
        const roles = rolesNow(agents, p);
        const weapons = agents.filter(a => a !== roles.lightbearer).length;
        const workers = roles.dedicators.length || 1;
        const each = Math.ceil(weapons / workers);
        const packsNow = {};
        // Re-read, not the survey: the hammer step moved things.
        const roomOf = {};
        await Promise.all(agents.map(async a => {
          packsNow[a] = (await call('inventory', { agent: a }, 40_000).catch(() => null))?.items ?? SURVEY.get(a)?.items ?? [];
          const s = await call('status', { agent: a, brief: true }, 30_000).catch(() => null);
          roomOf[a] = Number(s?.where?.num ?? s?.room_num ?? NaN);
        }));
        // A DONOR MUST BE STANDING WITH THE FLEET. `supply` is a hand-over in one room; on
        // 2026-09-25 the plan chose Uuuu (42 teeth, but in room 109) for two dedicators, both
        // hand-overs stopped at "not in the room", and neither could dedicate anything.
        const donorPacks = Object.fromEntries(Object.entries(packsNow).filter(([a]) => roomOf[a] === Number(p.stage)));
        // One want per agent, merged across its jobs: a Kraanan caster may dedicate AND bless, and
        // two separate wants for one agent would plan two sets of hand-overs for the same stack.
        const wantBy = new Map();
        const add = (a, perCast, casts) => {
          const w = wantBy.get(a) ?? {};
          for (const [k, n] of Object.entries(perCast)) w[k] = (w[k] ?? 0) + n * casts;
          wantBy.set(a, w);
        };
        for (const a of roles.dedicators) add(a, DEDICATE.reagents, each);
        if (roles.lightbearer) add(roles.lightbearer, LIGHT.reagents, Number(p.light_casts));
        // Bless: each blesser's share of the fleet, times the rounds the raid will cast it —
        // once at the door and again every few minutes it lasts.
        const shares = blessAssignments(agents, roles.blessers, { lightbearer: roles.lightbearer });
        for (const [b, targets] of Object.entries(shares)) add(b, BLESS.reagents, targets.length * Number(p.bless_rounds));
        // Super strength: self and one buddy, cast at the door and once more in the window.
        for (const [c, targets] of Object.entries(buddyAssignments(agents, roles.strongmen, { lightbearer: roles.lightbearer })))
          add(c, STRENGTH.reagents, targets.length * 2);
        // Herbs for everyone who can heal, the light-bearer included.
        for (const a of agents.filter(a => (SURVEY.get(a)?.spells ?? []).includes(HEAL.spell)))
          add(a, HEAL.reagents, Number(p.herbs_each));
        // A RECEIVER MUST BE STANDING WITH THE FLEET TOO. The donor rule above was half of it: on
        // the 2026-09-25 rehearsal five hand-overs went to the two armorers, who were in Barloque
        // buying shields, and every one stopped at "not in the room". An absent character keeps
        // what it carries; the rest is shared among those who are here.
        const away = [...wantBy.keys()].filter(a => roomOf[a] !== Number(p.stage));
        if (away.length && agent === agents[0]) console.log(`  reagents: not planning for ${away.join(', ')} — not in room ${p.stage}`);
        const wants = [...wantBy.entries()].filter(([a]) => !away.includes(a)).map(([a, per]) => {
          const short = {};
          for (const [k, n] of Object.entries(per)) { const have = countFamily(packsNow[a], k); if (have < n) short[k] = n - have; }
          return { agent: a, short };
        }).filter(w => Object.keys(w.short).length);
        const { moves, unmet } = planReagents(wants, donorPacks);

        // BY STACK ID, NOT BY NAME. `supply` matches a NAME whole, so asking for "mushroom" from a
        // donor holding only Inky-cap mushrooms moved nothing — six hand-overs failed that way on
        // the 2026-09-24 rehearsal — while `countFamily` had counted the Inky-caps as mushrooms.
        // So the donor sends the family's own stacks, largest first, each by id.
        for (const m of moves.filter(m => m.from === agent)) {
          let left = m.amount, moved = 0, why = null;
          for (let round = 0; left > 0 && round < 6; round++) {
            const inv = await call('inventory', { agent }, 40_000).catch(() => null);
            const stack = (inv?.items ?? []).filter(i => i.id != null && isReagent(i.name, m.what))
              .sort((a, b) => (b.amount || 1) - (a.amount || 1))[0];
            if (!stack) { why = 'none left in the pack'; break; }
            const n = Math.min(left, stack.amount || 1);
            // m59-inventory handOver: a full receiver makes room (junk, spare weapons, excess food) and is asked again.
            const r = await handOver(agent, m.to, { id: stack.id, amount: n }, { makeRoomMin: 200 }).then(h => ({ supplied: h.ok, reason: h.why }));
            if (!r?.supplied) { why = r?.reason ?? '?'; break; }
            left -= n; moved += n;
          }
          console.log(`  ${agent} -> ${m.to}: ${moved}/${m.amount} ${m.what}${why ? ` (stopped: ${why})` : ''}`);
        }
        // AFTER EVERY DONOR HAS FINISHED, each character re-reads its OWN pack against what it was
        // asked to carry. A planned move that failed is a shortfall like any other: the lab
        // grants it, prod says so. Planning from the survey and trusting the plan is how a caster
        // arrives at the door two reagents short with every hand-over "done".
        await barrier('reagents-moved', agent, { ms: 400_000 });
        const after = (await call('inventory', { agent }, 40_000).catch(() => null))?.items ?? [];
        const mine = Object.entries(wantBy.get(agent) ?? {})
          .map(([what, want]) => ({ agent, what, amount: want - countFamily(after, what) }))
          .filter(u => u.amount > 0);
        if (mine.length && lab) {
          assertLabFleet('ghost-arm: granting reagents');
          const dm = await dmLab();
          const who = SURVEY.get(agent)?.character ?? agent;
          const cls = { elderberry: 'ElderBerry', 'orc tooth': 'OrcTooth', emerald: 'Emerald',
                        herb: 'Herbs', mushroom: 'Mushroom', sapphire: 'Sapphire' };
          const ids = await dm.resolve([who]);
          for (const u of mine) {
            if (ids[who] == null || !cls[u.what]) continue;
            const out = await dm.dm([`create object ${cls[u.what]} number INT ${u.amount}`]);
            const id = /Created object (\d+)/.exec(String(out))?.[1];
            if (id) await dm.dm([`send object ${ids[who]} NewHold what OBJECT ${id}`]);
            console.log(`  ${agent} LAB: granted ${u.amount} ${u.what}`);
          }
        } else if (mine.length) {
          await say(`Short of ${mine.map(u => `${u.amount} ${u.what}`).join(', ')} for the raid.`);
        }
        await barrier('reagents', agent, { ms: 400_000 });
        st.reagents = { moves: moves.filter(m => m.from === agent || m.to === agent), unmet: mine };
        return true;
      }, 'the reagent hand-out could not be read back', 'arm.reagents'),

      // ---- 4. DEDICATE EVERY HAMMER.
      verify(async ({ state: st }) => {
        const roles = rolesNow(agents, p);
        if (agent === roles.lightbearer) { leave('dropped', agent); st.dedicate = { skipped: 'light-bearer' }; return true; }
        const dedicators = roles.dedicators;
        if (!dedicators.length) {
          await say('Nobody here knows enchant weapon — the raid goes in mundane.');
          leave('dropped', agent);
          st.dedicate = { skipped: 'no dedicator' };
          return true;
        }
        // THE ARMORERS SHOP WHILE THE FLEET DEDICATES. Their own hammers are dedicated when they
        // come back (lateDedicate): a hammer with a dedicator cannot be on the road as well.
        if (outfitOn(p) && splitOn(p) && hallOn(p) && armorersOf(agents, p).includes(agent)) {
          leave('dropped', agent);
          st.dedicate = { skipped: 'armorer (left at the hall step)' };
          return true;
        }
        if (outfitOn(p) && armorersOf(agents, p).includes(agent) && !dedicators.includes(agent)) {
          leave('dropped', agent);
          const pair = armorersOf(agents, p);
          const lines = OUTFIT_RUN.plan?.byCarrier?.[agent] ?? [];
          await say(`Armorer: off to Barloque for ${lines.length} piece(s).`);
          // FINISHED IN A finally: an errand that throws must not leave twenty characters waiting
          // out the whole outfit_wait_s for a delivery that is never coming.
          try {
            st.armorer = await armorerErrand({ agent, partner: pair.find(a => a !== agent), holder: cupHolderOf(agents, roles), lines, p, crew: pair.length });
          } catch (e) {
            st.armorer = { error: e?.message ?? String(e) };
          } finally {
            OUTFIT_RUN.log.push({ agent, ...st.armorer });
            OUTFIT_RUN.finished = (OUTFIT_RUN.finished ?? 0) + 1;
            if (OUTFIT_RUN.finished >= pair.length) OUTFIT_RUN.done = true;
          }
          return true;
        }
        return dedicators.includes(agent)
          ? dedicate({ agent, st, say, dedicators, agents, lab, p })
          : handIn({ agent, st, say, dedicators, agents, p });
      }, 'the dedication could not be read back', 'arm.dedicate'),

      // ---- 5. READ IT BACK. Wielding what, and did the dedication say so.
      verify(async ({ state: st }) => {
        const me = await call('status', { agent, brief: false }, 40_000).catch(() => null);
        const worn = (me?.equipment ?? []).find(e => isWeaponName(e)) ?? null;
        st.armed = { wielding: worn, hammer: isHammer(worn), blunt: isBlunt(worn),
                     dedicated: DEDICATED.get(agent)?.outcome ?? 'unknown' };
        console.log(`  ${String(me?.character ?? agent).padEnd(8)} ${String(worn ?? 'UNARMED').padEnd(12)} ` +
                    `dedicated=${st.armed.dedicated}`);
        await barrier('armed', agent, { ms: 60_000 });
        return true;
      }, 'the armed state could not be read back', 'arm.read-back'),

      // ---- 6. DRESS: wait for the armorers, wear shield and chain, dedicate a hammer that came late.
      ...(outfitOn(p) ? [verify(async ({ state: st }) => {
        const roles = rolesNow(agents, p);
        const until = Date.now() + Number(p.outfit_wait_s) * 1000;
        // THE ARMORERS' ROUND TRIP IS THE LONGEST WAIT IN THE RAID (45 min of 92 in rehearsal 21),
        // and it used to be spent standing still. Now whoever is not away uses it, in tiers that
        // each do nothing when their input is missing (operator, 2026-09-25: optimisations that
        // degrade gracefully):
        //   1. EAT to 180 vigor, if there is food — raid-prep then finds it done.
        //   2. FORGE a blunt weapon, if it has none and knows create weapon (m59-foundry) — after
        //      `foundry_after_s`, so a weapon lasting 2 x P minutes still lasts through the fight.
        //   3. REST, so health and mana are full before the door rather than after it.
        // The cup-holder and the light-bearer only wait: a second trip starts from the cup.
        const waitFrom = Date.now();
        const isArmorer = armorersOf(agents, p).includes(agent);
        let forged = null;
        if (agent !== roles.lightbearer && !isArmorer && agent !== cupHolderOf(agents, roles)) {
          if (!OUTFIT_RUN.done) st.ate = await eatTo(agent, 180).catch(() => null);
          const wantsBlunt = !isBlunt(SURVEY.get(agent)?.wielding) &&
            !(await call('inventory', { agent }, 40_000).catch(() => null))?.items?.some(i => isBlunt(i.name));
          if (foundryOn(p) && wantsBlunt) {
            while (!OUTFIT_RUN.done && Date.now() - waitFrom < Number(p.foundry_after_s) * 1000) await sleep(5000);
            if (!OUTFIT_RUN.done) {
              forged = await forge(agent, { rooms: String(p.foundry_rooms).split(',').map(Number).filter(Boolean),
                                            deadline: until - 60_000 }).catch(e => ({ ok: false, why: e.message }));
              st.forged = { ok: forged.ok, got: forged.got ?? null, casts: forged.casts?.length ?? 0, why: forged.why ?? null };
              console.log(`  ${agent} foundry: ${forged.ok ? `made a ${forged.got} (P~${forged.P}, lasts ~${forged.lifetime_min} min)` : `nothing (${forged.why})`} in ${forged.casts?.length ?? 0} cast(s)`);
            }
          }
          if (!OUTFIT_RUN.done) await call('rest', { agent }, 30_000).catch(() => {});
        }
        while (!OUTFIT_RUN.done && Date.now() < until) await sleep(5000);
        // THE PIECES WHOSE RECEIVER WAS AWAY. Everyone is in the stage room now; each armorer hands
        // over what it still holds for a raider who was out forging when it came home (rehearsal 24:
        // a chain and a shield for Dddd, "not in the room"), and nobody dresses until that is done.
        if (isArmorer && OUTFIT_RUN.redeliver?.get(agent)?.length) {
          const again = await deliver(agent, OUTFIT_RUN.redeliver.get(agent));
          OUTFIT_RUN.redeliver.set(agent, []);
          console.log(`  ${agent} redelivered ${again.filter(d => d.ok).length}/${again.length} to raiders who were away` +
                      (again.some(d => !d.ok) ? ` — ${again.filter(d => !d.ok).map(d => `${d.kind}->${d.agent} (${String(d.why ?? '?').slice(0, 50)})`).join('; ')}` : ''));
        }
        reexpect('redelivered', agents.filter(a => SURVEY.has(a)).length);
        await barrier('redelivered', agent, { ms: 180_000 });
        if (agent === roles.lightbearer) { st.outfit = { skipped: 'light-bearer (held the cup)' }; return true; }
        st.outfit = await wearOutfit(agent, { profile: p.outfit_profile });
        // A SPARE FOR WHOEVER THE FOUNDRY FAILED. The armorers carried unassigned hammers; a raider
        // still without a hammer or mace takes one, and it is dedicated like any late hammer.
        let spareTaken = false;
        if (!isArmorer && !(await call('inventory', { agent }, 40_000).catch(() => null))?.items?.some(i => isBlunt(i.name))) {
          for (const arm of armorersOf(agents, p)) {
            const r = await serially(async () => {
              const hs = ((await call('inventory', { agent: arm }, 40_000).catch(() => null))?.items ?? []).filter(i => isHammer(i.name) && i.id != null);
              if (hs.length < 2) return null;            // keep the armorer's own
              return handOver(arm, agent, hs[hs.length - 1].id, { makeRoomMin: 200 });
            });
            if (r?.ok) { spareTaken = true; (OUTFIT_RUN.gear ??= []).push({ agent, kind: 'hammer', name: 'hammer', source: 'spare', by: arm }); break; }
          }
          console.log(`  ${agent} spare hammer: ${spareTaken ? 'taken' : 'none left'}`);
        }
        const late = (OUTFIT_RUN.delivered.get(agent) ?? []).includes('hammer') || isArmorer || !!forged?.ok || spareTaken;
        if (late) st.outfit.dedicate = await lateDedicate(agent, roles.dedicators,
          { lab, dm: lab ? await dmLab() : null, donors: agents.filter(a => a !== roles.lightbearer),
            deadline: DRESS_DEADLINE.at ??= Date.now() + Number(p.dress_limit_s) * 1000 });
        console.log(`  ${String(SURVEY.get(agent)?.character ?? agent).padEnd(8)} dressed: ${st.outfit.wore.join('+') || 'nothing new'}` +
                    (st.outfit.dedicate ? `; hammer ${st.outfit.dedicate.ok ? st.outfit.dedicate.outcome : 'NOT dedicated: ' + st.outfit.dedicate.why}` : ''));
        return true;
      }, 'the outfit could not be read back', 'arm.dress')] : []),
    ];
  },
};

const outfitOn = p => p.outfit === true || p.outfit === 'true';
const foundryOn = p => !(p.foundry === false || p.foundry === 'false');
const hallOn = p => p.hall_draw === true || p.hall_draw === 'true';
const splitOn = p => !(p.split_hall === false || p.split_hall === 'false');

/** The guild chests as last observed (<roster dir>/../storage/chests/*.json), for the plan's stock. */
function readChests() {
  try {
    const roster = process.env.M59_STATE_FILE;
    if (!roster) return [];
    const dir = path.join(path.dirname(path.dirname(roster)), 'storage', 'chests');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  } catch { return []; }
}

/** split_hall's reagent riders: the roomiest raiders with no other job. */
function runnersOf(agents, p, roles, pair) {
  const cup = cupHolderOf(agents, roles);
  const free = a => { const r = SURVEY.get(a)?.roomFor; return r ? Math.min(r.weight ?? 0, r.bulk ?? 0) : 0; };
  return agents.filter(a => SURVEY.has(a) && !pair.includes(a) && a !== roles.lightbearer && a !== cup
                            && !roles.dedicators.includes(a) && !roles.healers.includes(a))
    .sort((a, b) => free(b) - free(a) || a.localeCompare(b))
    .slice(0, Math.max(1, Number(p.hall_runners) || 1));
}

/**
 * The armorers: named, or the `armorer_count` STRONGEST characters who are not needed to start
 * the other preparation — not the light-bearer, a dedicator or a healer. Strongest by might,
 * because might is what a pack holds (1700 + 20 x might), then by health for the road home.
 */
// ONE READING PER STEP, SHARED: every agent plans the same hand-outs, and two readings a second
// apart can disagree about a character walking in — a receiver then waits for a hammer nobody sends.
// One deadline for the whole fleet's late dedications, set by the first raider to reach them.
const DRESS_DEADLINE = { at: null };
const PRESENT = new Map();
const presentOnce = (key, agents, room) => {
  if (!PRESENT.has(key)) PRESENT.set(key, presentIn(agents, room));
  return PRESENT.get(key);
};

/** Every listed agent's pack and wielded weapon, read now, once per `key`, shared by all agents. */
const PACKS = new Map();
const packsOnce = (key, list) => {
  if (!PACKS.has(key)) PACKS.set(key, (async () => {
    const out = {};
    await Promise.all(list.map(async a => {
      const [inv, st] = await Promise.all([call('inventory', { agent: a }, 40_000).catch(() => null),
                                           call('status', { agent: a, brief: false }, 40_000).catch(() => null)]);
      out[a] = { items: inv?.items ?? [], wielding: (st?.equipment ?? []).find(e => isWeaponName(e)) ?? null };
    }));
    return Object.fromEntries(list.filter(a => out[a]).map(a => [a, out[a]]));
  })());
  return PACKS.get(key);
};

/** Who is standing in `room` right now, by the broker's own status. */
async function presentIn(agents, room) {
  const here = new Set();
  await Promise.all(agents.map(async a => {
    const s = await call('status', { agent: a, brief: true }, 30_000).catch(() => null);
    if (Number(s?.where?.num ?? s?.room_num ?? NaN) === room) here.add(a);
  }));
  return here;
}

function armorersOf(agents, p) {
  const named = String(p.armorers ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (named.length) return named;
  const roles = rolesNow(agents, p);
  const cup = cupHolderOf(agents, roles);
  // FREE ROOM AS THE SERVER COUNTS IT when the survey has it. Our own estimate chose an armorer
  // 119 weight OVER its limit on 2026-09-25, and the server then refused it even the chalice.
  const free = x => { const live = SURVEY.get(x)?.roomFor;
    const r = live ?? packRoom(SURVEY.get(x)?.might, SURVEY.get(x)?.items ?? []);
    return Math.min(r.weight ?? 0, r.bulk ?? 0); };
  return agents.filter(a => SURVEY.has(a) && a !== roles.lightbearer && a !== cup && !roles.dedicators.includes(a) && !roles.healers.includes(a)
                           && free(a) >= Number(p.armorer_min_room))
    // BY FREE ROOM, NOT BY MIGHT. Might sets how big a pack is; what an armorer can bring home is
    // what is EMPTY in it. On the 2026-09-25 rehearsal a might-50 armorer reached the chests already
    // over its bulk cap and took a fraction of its share. Free weight + bulk, from the survey's pack.
    .sort((a, b) => (free(b) - free(a)) || (SURVEY.get(b).maxHealth - SURVEY.get(a).maxHealth)
                    || a.localeCompare(b))
    .slice(0, Math.max(1, Number(p.armorer_count) || 4));
}

/**
 * WHOEVER CARRIES THE CUP, read off the survey — not whoever is assumed to. On 2026-09-25 prod's
 * Chalice of the Rain was with Rizzo in room 2 (the chalice-farming holder), not with Loial, and a
 * raid that handed "Loial's" cup to its armorers would have walked every one of them. The holder
 * is never an armorer: it stays in the stage room to pick the cup back up after each drink.
 */
function cupHolderOf(agents, roles) {
  return agents.find(a => (SURVEY.get(a)?.items ?? []).some(i => /chalice/i.test(String(i.name ?? ''))))
    ?? roles.lightbearer ?? null;
}

function rolesNow(agents, p) {
  const spells = Object.fromEntries([...SURVEY.entries()].map(([a, s]) => [a, s.spells]));
  return assignRoles(agents, spells, { lightbearer: p.lightbearer, healers: p.healers });
}

async function waitForItem(agent, pred, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const inv = await call('inventory', { agent }, 40_000).catch(() => null);
    const it = (inv?.items ?? []).find(i => pred(i.name));
    if (it) return it;
    await sleep(3000);
  }
  return null;
}

/** Wield a hammer if carried, else a mace, else leave the hand alone. Read back. */
async function wieldBest(agent) {
  const me = await call('status', { agent, brief: false }, 40_000).catch(() => null);
  const worn = (me?.equipment ?? []).find(e => isWeaponName(e)) ?? null;
  if (isHammer(worn)) return { wielding: worn, changed: false };
  const inv = await call('inventory', { agent }, 40_000).catch(() => null);
  const pick = (inv?.items ?? []).find(i => isHammer(i.name)) ?? (isBlunt(worn) ? null
             : (inv?.items ?? []).find(i => isBlunt(i.name)));
  if (!pick) return { wielding: worn, changed: false };
  await call('rest', { agent, stand: true }, 30_000).catch(() => {});
  await call('act', { agent, verb: 'use', target: pick.id }, 60_000).catch(() => {});
  await sleep(1500);
  const after = await call('status', { agent, brief: false }, 40_000).catch(() => null);
  return { wielding: (after?.equipment ?? []).find(e => isWeaponName(e)) ?? null, changed: true };
}

/** A non-caster: give the hammer to a dedicator, wait for a dedicated one back, wield it. */
async function handIn({ agent, st, say, dedicators, agents, p }) {
  const me = await call('status', { agent, brief: false }, 40_000).catch(() => null);
  const worn = (me?.equipment ?? []).find(e => isWeaponName(e)) ?? null;
  const inv = await call('inventory', { agent }, 40_000).catch(() => null);
  const item = (inv?.items ?? []).find(i => worn && String(i.name).toLowerCase() === String(worn).toLowerCase());
  if (!item) { leave('dropped', agent); st.dedicate = { skipped: 'nothing wielded' }; return true; }

  // Deterministic assignment: the Nth non-dedicator (by name) goes to dedicator N mod k.
  const others = agents.filter(a => !dedicators.includes(a)).sort();
  const to = dedicators[Math.max(0, others.indexOf(agent)) % dedicators.length];

  // Unwield first: an item in use is not something to put on a trade table or the floor, and
  // a refusal there is one more silent no-op in a game built out of them.
  await call('rest', { agent, stand: true }, 30_000).catch(() => {});
  await call('act', { agent, verb: 'unuse', target: item.id }, 60_000).catch(() => {});
  await sleep(1000);
  if (String(p.handover) === 'floor') {
    await call('act', { agent, verb: 'drop', target: item.id }, 60_000).catch(() => {});
    (HANDED.get(to) ?? HANDED.set(to, []).get(to)).push({ owner: agent, id: item.id, floor: true, name: item.name });
  } else {
    // m59-inventory handOver: a full receiver makes room (junk, spare weapons, excess food) and is asked again.
    const r = await handOver(agent, to, item.id, { makeRoomMin: 200 }).then(h => ({ supplied: h.ok, reason: h.why }));
    if (!r?.supplied) {
      await call('act', { agent, verb: 'use', target: item.id }, 60_000).catch(() => {});
      leave('dropped', agent);
      st.dedicate = { skipped: `could not hand my ${item.name} to ${to}: ${r?.reason ?? '?'}` };
      await say(`Could not hand my ${item.name} over for dedication.`);
      return true;
    }
    (HANDED.get(to) ?? HANDED.set(to, []).get(to)).push({ owner: agent, name: item.name });
  }
  await barrier('dropped', agent, { ms: 240_000 });
  await say(`My ${item.name} is with ${SURVEY.get(to)?.character ?? to} for dedication.`);

  // Wait for it back — a dedicator hands back ONE weapon per owner it owes.
  const until = Date.now() + Number(p.wait_mana_s) * 1000 + 300_000;
  while (!RETURNED.has(agent) && Date.now() < until) await sleep(3000);
  const back = await wieldBest(agent);
  st.dedicate = { weapon: item.name, back: RETURNED.has(agent), wielding: back.wielding };
  if (!RETURNED.has(agent)) await say('My weapon did not come back from dedication.');
  return true;
}

/** A dedicator: its own weapon first, then every weapon handed to it, resting for mana. */
async function dedicate({ agent, st, say, dedicators, agents, lab, p }) {
  const done = [];
  const manaNow = async () => manaOf(await call('status', { agent, brief: true }, 30_000).catch(() => null));
  const deadline = Date.now() + Number(p.wait_mana_s) * 1000;

  const haveMana = async () => {
    let m = await manaNow();
    if (m >= DEDICATE.mana) return true;
    if (lab) {
      assertLabFleet('ghost-arm: refilling mana');
      const dm = await dmLab();
      await dm.heal([SURVEY.get(agent)?.character ?? agent]);
      await sleep(1500);
      return (await manaNow()) >= DEDICATE.mana;
    }
    await say(`Resting for mana (${m}/${DEDICATE.mana}).`);
    await call('rest', { agent }, 30_000).catch(() => {});
    while (m < DEDICATE.mana && Date.now() < deadline) { await sleep(10_000); m = await manaNow(); }
    await call('rest', { agent, stand: true }, 30_000).catch(() => {});
    return m >= DEDICATE.mana;
  };

  const castOn = async (id, label) => {
    if (!(await haveMana())) return 'no mana';
    await call('rest', { agent, stand: true }, 30_000).catch(() => {});
    let r = null;
    for (let i = 0; i < 4; i++) {
      r = await castVerified(agent, DEDICATE.spell, { target: id, cost: DEDICATE.mana });
      if (!r.retryable) break;
      // A retryable miss has usually SPENT the mana (a fizzle costs it), so rest again first. The
      // 2026-09-25 rehearsal retried at once and every retry read "costs 17, you have 4/7".
      if (!(await haveMana())) break;
      await call('rest', { agent, stand: true }, 30_000).catch(() => {});
    }
    const outcome = r?.in_effect ? 'already' : r?.landed ? 'dedicated' : `failed: ${String(r?.why ?? '').slice(0, 60)}`;
    done.push({ on: label, outcome });
    return outcome;
  };

  // Own weapon, in its own pack — the first clause of IsTargetInRange.
  const own = await wieldBest(agent);
  const inv0 = await call('inventory', { agent }, 40_000).catch(() => null);
  const ownItem = (inv0?.items ?? []).find(i => String(i.name).toLowerCase() === String(own.wielding ?? '').toLowerCase());
  if (ownItem) DEDICATED.set(agent, { weapon: own.wielding, outcome: await castOn(ownItem.id, 'own') });

  leave('dropped', agent);
  await barrier('dropped', agent, { ms: 240_000 });
  const owed = HANDED.get(agent) ?? [];
  if (owed.length) await say(`Dedicating ${owed.length} weapon(s).`);

  if (String(p.handover) === 'floor') {
    for (const w of owed) {
      const o = await castOn(w.id, SURVEY.get(w.owner)?.character ?? w.owner);
      DEDICATED.set(w.owner, { weapon: w.name, outcome: o });
      await call('act', { agent: w.owner, verb: 'get', target: w.id }, 60_000).catch(() => {});
      RETURNED.add(w.owner);
    }
  } else {
    // Every non-wielded weapon in my pack that came from somebody: dedicate, then hand one back
    // per owner. Casting on an already-dedicated weapon is refused FREE in CanPayCosts, so a
    // second pass over the same object costs a packet and tells the truth.
    for (const w of owed) {
      const inv = await call('inventory', { agent }, 40_000).catch(() => null);
      const mineNow = (await call('status', { agent, brief: false }, 40_000).catch(() => null))?.equipment ?? [];
      const candidates = (inv?.items ?? []).filter(i => String(i.name).toLowerCase() === String(w.name).toLowerCase());
      // Skip the one I am wielding when it is the same kind: `inventory` lists it too.
      const pool = candidates.length > 1 || !mineNow.some(e => String(e).toLowerCase() === String(w.name).toLowerCase())
        ? candidates : [];
      const target = pool.find(i => !(ownItem && i.id === ownItem.id)) ?? pool[0];
      if (!target) { done.push({ on: w.owner, outcome: 'not in my pack' }); continue; }
      const o = await castOn(target.id, SURVEY.get(w.owner)?.character ?? w.owner);
      DEDICATED.set(w.owner, { weapon: w.name, outcome: o });
      // handOver makes room on a full receiver and tries again: on the 2026-09-25 rehearsal a
      // dedicated sword stayed in the dedicator's pack on receiver_full, its owner unarmed.
      const r = await handOver(agent, w.owner, target.id, { makeRoomMin: 200 });
      if (r.ok) RETURNED.add(w.owner);
      else done.push({ on: w.owner, outcome: `hand-back failed: ${r.why}` });
    }
  }
  DEDICATORS_DONE++;
  st.dedicate = { cast: done };
  console.log(`  ${String(SURVEY.get(agent)?.character ?? agent).padEnd(8)} dedicated ` +
              `${done.filter(d => d.outcome === 'dedicated').length} (+${done.filter(d => d.outcome === 'already').length} already) ` +
              `of ${done.length}` + (done.some(d => /fail|no mana|not in/.test(d.outcome))
                ? `  !! ${done.filter(d => /fail|no mana|not in/.test(d.outcome)).map(d => `${d.on}: ${d.outcome}`).join('; ')}` : ''));
  return true;
}

export const _internal = { SURVEY, DEDICATED, HANDED, RETURNED };
