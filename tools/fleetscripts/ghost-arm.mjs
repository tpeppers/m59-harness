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
import { OUTFIT_RUN, outfitNeeds, planOutfit, packRoom, poolMoney, armorerErrand, wearOutfit, lateDedicate }
  from './ghost-outfit.mjs';
import { STAGE_ROOM, DEDICATE, LIGHT, BLESS, HEAL, STRENGTH, buddyAssignments, isHammer, isBlunt, isWeaponName, hammerNeed, matchHammers,
         planReagents, countFamily, assignRoles, blessAssignments, expect, reexpect, barrier, leave }
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
const FRAGILE_WEST = new Set();        // fragile characters refused the Ukgoth crossing

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
    muster_min_health: { type: 'number', default: 0.9, describe: 'health fraction to set out on the muster walk. NOT 1: a rest can plateau short of full (a ring of lethargy, a rounding step), and at 1 shadow12 (63/64) and shadow18 (57/60) were dropped from the 2026-09-25 rehearsal' },
    start_positions: { type: 'string', default: '', describe: 'LAB: JSON {agent:{room,row,col}} — place each clone where its prod character stands, after the hold' },
    muster_wait_s: { type: 'number', default: 1500, describe: 'how long the survey waits for the muster to finish' },
    rally: { type: 'number', default: 598, describe: 'where a convoy gathers before crossing Ukgoth (0 = no convoy)' },
    fragile_below: { type: 'number', default: 30, describe: 'max health under which a character is never walked through Ukgoth' },
    rally_wait_s: { type: 'number', default: 600, describe: 'how long the convoy waits for its last member' },
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
    armorers: { type: 'string', default: '', describe: 'comma-separated pair; empty = the two sturdiest non-casters' },
    trips: { type: 'number', default: 2, describe: 'shopping trips at most' },
    hall: { type: 'number', default: 714, describe: 'where the chalice lands a guild member (the Bookmakers hall)' },
    shop_room: { type: 'number', default: 113, describe: 'the Barloque smith' },
    smith: { type: 'string', default: "Fehr'loi Qan", describe: 'the merchant to sell to and buy from' },
    keep_shillings: { type: 'number', default: 20, describe: 'what each raider keeps when pooling money' },
    outfit_wait_s: { type: 'number', default: 3600, describe: 'how long the fleet waits for the armorers' },
  },

  async steps(p, agentArg, state) {
    const agent = agentArg ?? p.agent;
    const agents = Array.isArray(p.agents) ? p.agents : String(p.agents).split(',').map(s => s.trim()).filter(Boolean);
    const lab = p.lab === true || p.lab === 'true';
    if (lab) assertLabFleet('ghost-arm lab=true');
    const say = text => call('say', { agent, type: p.channel, text: String(text).slice(0, 220) }, 30_000).catch(() => {});

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
    let convoy = false;
    if (!inStage && !placeHere && Number(p.rally)) {
      const from = Number(here?.where?.num ?? here?.room_num ?? NaN);
      if (from === Number(p.rally)) convoy = true;
      else {
        const [toStage, toRally] = await Promise.all([
          call('travel_estimate', { from, to: Number(p.stage) }, 20_000).catch(() => null),
          call('travel_estimate', { from, to: Number(p.rally) }, 20_000).catch(() => null)]);
        convoy = Number.isFinite(toStage?.hops) && Number.isFinite(toRally?.hops) && toStage.hops === toRally.hops + 2;
      }
    }
    // A FRAGILE BODY DOES NOT TAKE THE CONVOY. The first no-DM rehearsal (2026-09-24) walked the
    // 20-health light-bearer from 598 across Ukgoth inside a convoy of seventeen, and the trolls
    // killed him on the way — taking the fleet's only chalice and its only forces of light with
    // him. A convoy spreads the trolls' attention; it does not make twenty health survivable in
    // 599. Such a character is refused here, loudly, and must be brought to the castle side by
    // other means (on prod his post is room 2 already) before the raid is run.
    const maxHp = Number(here?.hp?.max ?? here?.vitals?.health?.max ?? 0);
    if (convoy && maxHp && maxHp < Number(p.fragile_below)) {
      FRAGILE_WEST.add(agent);
      return [verify(async () => ({ ok: false,
        why: `${agent} has ${maxHp} max health and stands west of Ukgoth; the muster will not walk it ` +
             `through 599. Bring it to room ${p.stage} first (on prod the light-bearer's post is there).` }),
        'the fragile-body refusal')];
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
      }, 'the lab placement could not be read back')]
        // FULL HEALTH TO SET OUT, whatever the raid's own floor is: this is the one walk that may
        // cross open country (m59-muster.mjs, "THE HEALTH FLOOR" — seven died at 0.35).
        : convoy ? [
          walk(Number(p.rally), { minHealth: Number(p.muster_min_health) }),
          verify(async ({ state: st }) => {
            // Everyone in the convoy, or the patience runs out — then whoever is here goes.
            reexpect('rally', CONVOY.size);
            const b = await barrier('rally', agent, { ms: Number(p.rally_wait_s) * 1000 });
            await say(`Crossing Ukgoth with ${b.arrived} of ${CONVOY.size}.`);
            st.convoy = b;
            return true;
          }, 'the convoy could not be read'),
          // Nobody rests in 598 to top up: the convoy crosses together or it is not a convoy.
          walk(Number(p.stage), { minHealth: Number(p.cross_min_health) }),
        ]
        : [walk(Number(p.stage), { minHealth: Number(p.muster_min_health) })]),

      // ---- 1. SURVEY. Everyone posts what it holds, then waits for everyone else, so the
      // hand-over plan below is computed from ONE picture of the fleet by every agent alike.
      verify(async ({ state: st }) => {
        const [me, inv, sp] = await Promise.all([
          call('status', { agent, brief: false }, 40_000).catch(() => null),
          call('inventory', { agent }, 40_000).catch(() => null),
          call('spells', { agent }, 40_000).catch(() => null),
        ]);
        const worn = (me?.equipment ?? []).find(e => isWeaponName(e)) ?? null;
        SURVEY.set(agent, { character: me?.character ?? agent, wielding: worn,
                            items: inv?.items ?? [], mana: manaOf(me), maxMana: Number(me?.mana?.max ?? 0),
                            maxHealth: Number(me?.hp?.max ?? me?.vitals?.health?.max ?? 0),
                            might: Number(me?.attributes?.might ?? 0),
                            spells: (sp?.spells ?? []).map(s => String(s.name ?? '').toLowerCase()) });
        // Long enough for a real muster (a convoy through 598 is ten-plus minutes), short when
        // the lab has teleported everyone. A character that failed its muster never arrives, and
        // everything after this barrier stops waiting for it (reexpect below).
        const b = await barrier('survey', agent, { ms: Number(p.muster_wait_s) * 1000 });
        // Whoever did not make the survey will not make anything after it.
        for (const k of ['hammers', 'reagents-moved', 'reagents', 'dropped', 'armed', 'pooled']) reexpect(k, SURVEY.size);
        st.survey = { wielding: worn, fleet_seen: SURVEY.size, barrier: b };
        return true;
      }, 'the survey could not be read'),

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
          // ONE plan for the whole fleet, from fresh packs, so the armorers split it without overlap.
          const needs = {}, packs = {};
          await Promise.all(agents.filter(a => a !== roles.lightbearer && SURVEY.has(a)).map(async a => {
            packs[a] = (await call('inventory', { agent: a }, 40_000).catch(() => null))?.items ?? [];
            needs[a] = outfitNeeds(packs[a]);
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
          OUTFIT_RUN.plan = planOutfit(needs, { budget, capacity: bigCap });
          const pl = OUTFIT_RUN.plan;
          console.log(`  armorers ${pair.join(' + ')}: budget ${budget}, buying ${pl.buys.length} piece(s) for ${pl.spend}` +
                      (pl.cut.length ? `; cut ${pl.cut.length} (${[...new Set(pl.cut.map(c => c.why))].join(', ')})` : ''));
        }
        st.pool = { ...(st.pool ?? {}), armorers: pair };
        return true;
      }, 'the money pool could not be read back')] : []),

      // ---- 2. A HAMMER IN EVERY HAND.
      verify(async ({ state: st }) => {
        const roles = rolesNow(agents, p);
        const isLight = roles.lightbearer === agent;
        const needs = agents.filter(a => a !== roles.lightbearer && SURVEY.has(a))
          .map(a => hammerNeed(a, { wielding: SURVEY.get(a).wielding, items: SURVEY.get(a).items }));
        const { transfers, short } = matchHammers(needs);

        // Donors hand over; receivers wait to see the hammer arrive.
        for (const t of transfers.filter(t => t.from === agent)) {
          const r = await serially(() => call('supply', { from: t.from, to: t.to, what: [t.id],
                                                          who_travels: 'neither' }, 120_000)
            .catch(e => ({ supplied: false, reason: e.message })));
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
      }, 'the hammer hand-out could not be read back'),

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
        const wants = [...wantBy.entries()].map(([a, per]) => {
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
            const stack = (inv?.items ?? []).filter(i => i.id != null && String(i.name ?? '').toLowerCase().includes(m.what))
              .sort((a, b) => (b.amount || 1) - (a.amount || 1))[0];
            if (!stack) { why = 'none left in the pack'; break; }
            const n = Math.min(left, stack.amount || 1);
            const r = await serially(() => call('supply', { from: agent, to: m.to, what: [{ id: stack.id, amount: n }],
                                                            who_travels: 'neither' }, 180_000)
              .catch(e => ({ supplied: false, reason: e.message })));
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
      }, 'the reagent hand-out could not be read back'),

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
        if (outfitOn(p) && armorersOf(agents, p).includes(agent) && !dedicators.includes(agent)) {
          leave('dropped', agent);
          const pair = armorersOf(agents, p);
          const lines = OUTFIT_RUN.plan?.byCarrier?.[agent] ?? [];
          await say(`Armorer: off to Barloque for ${lines.length} piece(s).`);
          // FINISHED IN A finally: an errand that throws must not leave twenty characters waiting
          // out the whole outfit_wait_s for a delivery that is never coming.
          try {
            st.armorer = await armorerErrand({ agent, partner: pair.find(a => a !== agent), holder: roles.lightbearer, lines, p });
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
      }, 'the dedication could not be read back'),

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
      }, 'the armed state could not be read back'),

      // ---- 6. DRESS: wait for the armorers, wear shield and chain, dedicate a hammer that came late.
      ...(outfitOn(p) ? [verify(async ({ state: st }) => {
        const roles = rolesNow(agents, p);
        const until = Date.now() + Number(p.outfit_wait_s) * 1000;
        // EVERYONE WAITS, THE CUP-HOLDER INCLUDED: a second trip starts with the cup handed over in
        // room 2, and a light-bearer who had moved on to the door would strand it.
        while (!OUTFIT_RUN.done && Date.now() < until) await sleep(5000);
        if (agent === roles.lightbearer) { st.outfit = { skipped: 'light-bearer (held the cup)' }; return true; }
        st.outfit = await wearOutfit(agent);
        const late = (OUTFIT_RUN.delivered.get(agent) ?? []).includes('hammer') || armorersOf(agents, p).includes(agent);
        if (late) st.outfit.dedicate = await lateDedicate(agent, roles.dedicators,
          { lab, dm: lab ? await dmLab() : null });
        console.log(`  ${String(SURVEY.get(agent)?.character ?? agent).padEnd(8)} dressed: ${st.outfit.wore.join('+') || 'nothing new'}` +
                    (st.outfit.dedicate ? `; hammer ${st.outfit.dedicate.ok ? st.outfit.dedicate.outcome : 'NOT dedicated: ' + st.outfit.dedicate.why}` : ''));
        return true;
      }, 'the outfit could not be read back')] : []),
    ];
  },
};

const outfitOn = p => p.outfit === true || p.outfit === 'true';

/** The pair: named, or the two sturdiest characters who are not a caster, a healer or the light. */
function armorersOf(agents, p) {
  const named = String(p.armorers ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (named.length) return named;
  const roles = rolesNow(agents, p);
  return agents.filter(a => SURVEY.has(a) && a !== roles.lightbearer && !roles.dedicators.includes(a) && !roles.healers.includes(a))
    .sort((a, b) => (SURVEY.get(b).maxHealth - SURVEY.get(a).maxHealth) || a.localeCompare(b))
    .slice(0, 2);
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
    const r = await serially(() => call('supply', { from: agent, to, what: [item.id], who_travels: 'neither' }, 120_000)
      .catch(e => ({ supplied: false, reason: e.message })));
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
      const r = await serially(() => call('supply', { from: agent, to: w.owner, what: [target.id], who_travels: 'neither' }, 120_000)
        .catch(e => ({ supplied: false, reason: e.message })));
      if (r?.supplied) RETURNED.add(w.owner);
      else done.push({ on: w.owner, outcome: `hand-back failed: ${r?.reason ?? '?'}` });
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
