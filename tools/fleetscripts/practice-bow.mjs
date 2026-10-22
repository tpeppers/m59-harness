// practice-bow — TRAIN FIRE AND ARCHERY ON A PRACTICE BOW UNTIL WHAT THE CHARACTER HOLDS IS AT 99.
//
//   practice-bow agents=t4                         # here, both skills it holds, mend at the desk
//   practice-bow agents=t4,t5 room=40              # walk to the throne room first, train there
//   practice-bow agents=t4 skills=fire             # fire only, even if it holds archery
//   practice-bow agents=t4 desk=Loial              # mend only at this desk
//   practice-bow agents=t4 arrows_min=0            # never fight for arrows; stop when out
//   practice-bow agents=t1 room=38 supply_from=t10,t11,t16   # take arrows from farmers in the room
//   practice-bow agents=t1 room=38 supply_from=t10,t11 supply_rooms=39   # ...or walk next door to them
//
// Operator, 2026-10-20: "train the bow skills fire and/or archery, stopping when whichever 1-2 of
// skills possessed reach 99 (i.e., won't continue because doesn't have 99 in archery if the
// character doesn't have the skill!), given a character with a practice bow, near-infinite arrows
// (use create weapon/melee weapons to kill the map's arrow-dropping creatures if arrows ever run
// out) and a tasked nearby service desk they can travel to for mends ... It should largely be
// room agnostic."
//
// THE LOOP, per cycle:  train here -> (bow worn) walk to the desk -> mend -> walk back.
// Cycles are unrolled because a step list is compiled once; a finished character's remaining
// cycles are no-ops. The decisions live in tools/m59-practicebow.mjs, the game facts behind them
// in m59-research reports/archery-training.md and reports/mend-and-item-repair.md.
//
// WHAT IT DOES NOT DECIDE: where to stand. It shoots the weakest monster in the room that still
// teaches every skill in training (a target teaches only while the skill is below its level,
// stroke.kod:104-118), so a room that cannot teach the character any more ends the run with the
// strongest monster named. Upstairs in Castle Victoria (battered skeleton 60) teaches to 60;
// the throne room's tusked skeletons (100) teach to 99. Zombies (55) are never picked above 55.
//
// THE MEND DESK is any chalice desk that publishes Mend (tools/m59-chalice.mjs DESK_SERVICES):
// the holder must know Mend and carry a sapphire and an orc tooth above its reserve. The archer
// walks to the desk's room, drops the bow, files a `mend` ticket naming it, waits for the ticket
// to close, picks the bow up and reads its condition back. Mend keeps only 75-94% of the bow's
// current maximum every cast, and the new maximum does not depend on wear, so this mends at the
// LAST band ("well worn", <=30%) and never sooner. A broken bow cannot be mended at all.
import { verify, walk, observe } from '../m59-fleetscript.mjs';
import { fleetName } from '../m59-fleetpath.mjs';
import { chaliceStoreFor } from '../m59-chalice.mjs';
import { describeItem } from '../m59-magicsort.mjs';
import {
  bowSkillState, gainsInWindow, bowBand, bandAtOrBelow, findBow, arrowCount, findMelee,
  shouldRetire, loadBestiary, arrowTreasures, monstersIn, pickTarget, arrowDroppersIn, pickMendDesk, planArrowPull,
} from '../m59-practicebow.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = s => String(s ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const healthOf = st => {
  const h = st?.vitals?.health ?? st?.hp ?? null;
  return h?.max ? h.value / h.max : null;
};
const wielding = (eq, item) => (eq?.wielding ?? eq?.equipped ?? [])
  .some(w => String(w?.name ?? w).toLowerCase() === String(item?.name ?? '').toLowerCase());

export const script = {
  name: 'practice-bow',
  describe: 'Shoot monsters above your bow skills with a practice bow until fire/archery (whichever you hold) reach 99; mend at a Mend desk when worn; fight for arrows when out.',

  consults: ['the abilities tool', 'tools/monsters.json (viLevel, viTreasure_type)', 'compendium/data/treasure.json (who drops arrows)',
             'the chalice store desk menus (who offers Mend)'],

  notes: [
    'ONE BOW CAN LAST TO 99 only with a strong mender: at spell power 99 a practice bow gives',
    '~4,300-5,500 durability over ~60 mends; at 50-75 plan on two bows. retire_swings stops the run',
    'when a freshly mended bow wears to the mend band that fast, before a burst can break it.',
    '',
    'ARROWS GO AT ONE A SHOT, hit or miss. The 10-points-per-window cap is ~2,500 arrows an hour;',
    'shots past it teach nothing, so the loop pauses while the window is full.',
    '',
    'HOLDING ARCHERY SENDS 60% OF IMPROVEMENT ROLLS TO IT (stroke.kod:104). Train fire alone first',
    'with skills=fire if archery is not wanted yet.',
  ],

  params: {
    agents:        { type: 'agents', required: true, describe: 'the archers' },
    room:          { type: 'number', default: null, describe: 'practice room; default: where each archer stands now' },
    desk:          { type: 'string', default: null, describe: 'mend only at this desk character' },
    desk_room:     { type: 'number', default: null, describe: 'the desk room, if no desk has published one yet' },
    skills:        { type: 'string', default: 'fire,archery', describe: 'which held bow skills to train to 99' },
    bow:           { type: 'string', default: 'practice bow', describe: 'the bow to train with' },
    mend_at:       { type: 'string', default: 'poor', describe: 'mend at this band or worse: good, med, poor' },
    arrows_min:    { type: 'number', default: 15, describe: 'fight for arrows below this many; 0 = never' },
    arrows_to:     { type: 'number', default: 80, describe: 'stop fighting for arrows at this many' },
    supply_from:   { type: 'string', default: null, describe: 'fleetmates to take arrows from, comma separated; only those in the practice room' },
    supply_below:  { type: 'number', default: 40, describe: 'take arrows from supply_from below this many' },
    supply_to:     { type: 'number', default: 150, describe: '...up to this many' },
    supply_keep:   { type: 'number', default: 5, describe: 'arrows each giver keeps' },
    supply_wait_s: { type: 'number', default: 900, describe: 'out of arrows with supply_from: wait this long for a giver to have some' },
    supply_rooms:  { type: 'string', default: null, describe: 'other rooms the ARCHER may walk to for arrows, comma separated (the givers never walk)' },
    burst:         { type: 'number', default: 20, describe: 'shots between condition reads' },
    reach:         { type: 'number', default: 10, describe: 'close to this many squares before shooting' },
    abort_below:   { type: 'number', default: 0.5, describe: 'stop a burst below this health fraction' },
    retire_swings: { type: 'number', default: 80, describe: 'stop if a fresh mend wears out in fewer shots; 0 = never' },
    mend_wait_s:   { type: 'number', default: 600, describe: 'longest wait for the desk to cast' },
    hours:         { type: 'number', default: 24, describe: 'stop after this long' },
    cycles:        { type: 'number', default: 60, describe: 'most mend trips in one run' },
  },

  async steps(p) {
    const agent = p.agent;
    const fleet = fleetName();
    const asked = Number.isFinite(Number(p.room)) && Number(p.room) > 0 ? Number(p.room) : null;
    // THE PRACTICE ROOM IS A NUMBER AT COMPILE TIME, because every walk back to it must name it in
    // `candidates`. Not given: wherever the archer stands now.
    const practice = asked ?? (Number((await observe(agent).catch(() => null))?.room) || null);
    const desks = (() => { try { return chaliceStoreFor({ fleet }).desk(); } catch { return {}; } })();
    const chosen = pickMendDesk(desks, p.desk);
    const deskRoom = Number(p.desk_room) > 0 ? Number(p.desk_room) : Number(chosen.desk?.room) || null;
    const only = list(p.skills).filter(s => s === 'fire' || s === 'archery');
    const bestiary = loadBestiary(), arrowTids = arrowTreasures();

    const log = (msg) => console.log(`  ${agent}: ${msg}`);
    const S = state => (state.pb ??= { started: Date.now(), shots: 0, swingsSinceMend: 0, mends: 0,
                                         needMend: false, done: false, lastReport: Date.now() });

    // ------------------------------------------------------------------ helpers over `call`
    const readPack = async (call) => (await call('inventory', { agent }, 60_000).catch(() => null))?.items ?? null;
    // A PACK READ DURING A RELOG IS EMPTY, NOT EMPTIED. The keeper logs off rather than die and
    // logs straight back in ("rejoin: logging off rather than dying"); a read in that window came
    // back without the bow and ended a lab run on 2026-10-20 with the bow still in the pack. So
    // "no bow" is believed only after it has stayed true for about a minute.
    const bowInPack = async (call) => {
      for (let i = 0; i < 5; i++) {
        const items = await readPack(call);
        const bow = findBow(items ?? [], p.bow);
        if (bow) return { bow, items };
        await sleep(15_000);
      }
      return { bow: null, items: await readPack(call) };
    };
    const bandNow = async (call, bow) => bowBand((await describeItem(agent, bow.id, { call }))?.text);
    const wield = async (call, item) => {
      const eq = await call('equipment', { agent }, 30_000).catch(() => null);
      if (wielding(eq, item)) return true;
      await call('act', { agent, verb: 'use', target: item.id }, 30_000).catch(() => null);
      return wielding(await call('equipment', { agent }, 30_000).catch(() => null), item);
    };

    // ARROWS FROM THE ROOM: wield a melee weapon (the pack's, else one conjured with Create Weapon),
    // kill what drops arrows, and let the keeper's fight loot the floor. Switching weapon type zeroes
    // the 75-swing count (player.kod:4753-4756), which the next bow burst simply rebuilds.
    const resupply = async ({ call, keeper }, st) => {
      const until = Math.min(Date.now() + 45 * 60_000, st.started + Number(p.hours) * 3600_000);
      let items = await readPack(call);
      while (Date.now() < until && arrowCount(items) < Number(p.arrows_to)) {
        const look = await call('look', { agent }, 30_000).catch(() => null);
        const quarry = arrowDroppersIn(monstersIn(look), bestiary, arrowTids)[0];
        if (!quarry) {
          if (arrowCount(items) > 0) return { ok: true, why: 'no arrow-dropper here; shooting the arrows left' };
          await sleep(30_000);
          items = await readPack(call);
          continue;
        }
        let melee = findMelee(items);
        if (!melee) {
          const c = await call('cast', { agent, spell: 'create weapon', observe_created: true }, 60_000).catch(() => null);
          items = await readPack(call);
          melee = findMelee(items);
          if (!melee) return { ok: false, why: `out of arrows, no melee weapon, and create weapon gave none (${(c?.messages ?? []).join(' ').slice(0, 120) || 'no reply'})` };
          log(`conjured a ${melee.name} to fight for arrows`);
        }
        if (!(await wield(call, melee))) return { ok: false, why: `could not wield ${melee.name}` };
        const r = await keeper('fight', { target: quarry.name, rounds: 40, abort_below: Number(p.abort_below), reach: 2 }, 240_000);
        if (r?.error) { log(`arrow fight: ${r.error}`); await sleep(10_000); }
        else if (r?.killed) log(`killed a ${quarry.name} for arrows${r.looted?.length ? `: ${r.looted.join(', ')}` : ''}`);
        if (healthOf(await call('status', { agent }, 30_000).catch(() => null)) < Number(p.abort_below)) await sleep(30_000);
        items = await readPack(call);
      }
      return { ok: arrowCount(items) > 0, why: `${arrowCount(items)} arrows after the arrow fight` };
    };

    // ARROWS FROM FLEETMATES IN THE ROOM. Operator, 2026-10-22: the castle farmers collect nerudite
    // arrows for the archer ("More farmers on arrows"); prod-deploy-ac's fire-loop.mjs ferried them
    // from outside the run. Doing it here fixes three things that failed from outside:
    //   - only givers ALREADY IN THE ROOM, with no travel (`stationary`, `who_travels: neither`): a
    //     giver on a farm strategy left "the keeper never picked up the journey";
    //   - the call is the run's own, so the receiver's lease is ours: a supply sent by another
    //     process to a character this run held came back "no count rose";
    //   - `what` names the stacks by id: `items:` matches reagents only.
    const givers = list(p.supply_from);
    // THE ARCHER WALKS, NOT THE GIVER (prod-deploy-ac, 2026-10-22: the castle farmers live in 39 and
    // the archer shoots in 38, so "only givers already in the room" rarely found one). A giver's walk
    // is what failed before; the archer's is a compiled walk step like the one to the mend desk.
    const supplyRooms = [...new Set(String(p.supply_rooms ?? '').split(',').map(Number).filter(n => n > 0))];
    const MIN_TRIP = 10;   // not worth a walk for fewer
    const spareElsewhere = async (call) => {
      if (!givers.length || !supplyRooms.length) return null;
      const fleet = (await call('fleet', {}, 30_000).catch(() => null))?.fleet ?? [];
      const roomOf = a => Number(fleet.find(r => String(r.agent).toLowerCase() === a)?.room_num);
      const mine = roomOf(String(agent).toLowerCase());
      let best = null;
      for (const g of givers) {
        const r = roomOf(g);
        if (r === mine || !supplyRooms.includes(r)) continue;
        const inv = await call('inventory', { agent: g }, 60_000).catch(() => null);
        const spare = arrowCount(inv?.items ?? []) - Number(p.supply_keep);
        if (spare >= MIN_TRIP && (!best || spare > best.spare)) best = { room: r, giver: g, spare };
      }
      return best;
    };
    const pullArrows = async (call) => {
      if (!givers.length) return 0;
      const fleet = (await call('fleet', {}, 30_000).catch(() => null))?.fleet ?? [];
      const roomOf = a => Number(fleet.find(r => String(r.agent).toLowerCase() === a)?.room_num);
      const mine = roomOf(String(agent).toLowerCase());
      let got = 0;
      for (const g of givers) {
        if (g === String(agent).toLowerCase() || roomOf(g) !== mine) continue;
        const have = arrowCount(await readPack(call));
        if (have >= Number(p.supply_to)) break;
        const inv = await call('inventory', { agent: g }, 60_000).catch(() => null);
        const what = planArrowPull(inv?.items ?? [], have, { keep: Number(p.supply_keep), want: Number(p.supply_to) });
        if (!what.length) continue;
        const r = await call('supply', { from: g, to: agent, what, stationary: true, who_travels: 'neither',
                                         ...(Number.isFinite(inv?.ids_as_of) ? { ids_as_of: inv.ids_as_of } : {}) }, 180_000)
          .catch(e => ({ error: e.message }));
        const now = arrowCount(await readPack(call));
        log(`arrows from ${g}: asked ${what.reduce((n, w) => n + w.amount, 0)}, now ${now}` +
            (now > have ? '' : ` — ${r?.reason_code ?? r?.reason ?? r?.error ?? 'nothing moved'}`));
        got += Math.max(0, now - have);
      }
      return got;
    };

    // ------------------------------------------------------------------ the training step
    const train = (k) => verify(async ({ call, keeper, state }) => {
      const st = S(state);
      if (st.done) return { ok: true, why: 'already done' };
      const until = st.started + Number(p.hours) * 3600_000;
      for (;;) {
        if (Date.now() > until) return { ok: false, why: `${p.hours}h elapsed; ${st.shots} shots, ${st.mends} mends` };

        const ab = await call('abilities', { agent, kind: 'both', known_only: false }, 60_000).catch(() => null);
        const sk = bowSkillState(ab?.skills ?? [], { only });
        if (sk.none) return { ok: false, why: `${agent} holds none of ${only.join('/')} — nothing to train (learn fire first)` };
        if (sk.done) {
          st.done = true;
          log(`DONE — ${Object.entries(sk.held).map(([k, v]) => `${k} ${v}`).join(', ')}; ${st.shots} shots, ${st.mends} mends`);
          return { ok: true, why: `${Object.entries(sk.held).map(([k, v]) => `${k} ${v}`).join(', ')}` };
        }
        const cap = gainsInWindow(ab?.advancement?.recent ?? []);
        if (cap.capped) {
          const wait = Math.max(30_000, Math.min(5 * 60_000, (cap.resumeAt ?? Date.now()) - Date.now()));
          log(`advancement window full (${cap.points} points) — holding fire ${Math.round(wait / 1000)}s`);
          await sleep(wait);
          continue;
        }

        let { bow, items } = await bowInPack(call);
        if (!bow) return { ok: false, why: `no ${p.bow} in the pack (read five times over a minute)` };

        // Condition first: never shoot a burst at a bow that is due.
        const band = await bandNow(call, bow);
        if (band === 'broken') return { ok: false, why: `the ${bow.name} is broken — it cannot be mended; buy another` };
        if (band && bandAtOrBelow(band, p.mend_at)) {
          if (st.mends > 0 && shouldRetire(st.swingsSinceMend, p.retire_swings))
            return { ok: false, why: `the ${bow.name} wore from a mend to "${band}" in ${st.swingsSinceMend} shots — its maximum is nearly gone; retire it and buy another` };
          if (!deskRoom) return { ok: false, why: `the ${bow.name} needs a mend and ${chosen.why ?? 'no desk room is known'}` };
          st.needMend = true;
          log(`bow is "${band}" after ${st.swingsSinceMend} shots — to the desk in ${deskRoom}`);
          return { ok: true, why: `bow ${band}; mending (cycle ${k + 1})` };
        }

        if (givers.length && arrowCount(items) < Number(p.supply_below)) {
          await pullArrows(call);
          items = await readPack(call);
          const goFetch = async () => {
            if (arrowCount(items) >= Number(p.supply_below)) return false;
            const there = await spareElsewhere(call);
            if (!there) return false;
            st.needArrows = true; st.supplyRoom = there.room;
            log(`${arrowCount(items)} arrows; ${there.giver} has ${there.spare} spare in ${there.room} — going to fetch them`);
            return true;
          };
          if (await goFetch()) return { ok: true, why: `fetching arrows from ${st.supplyRoom}` };
          if (arrowCount(items) === 0 && Number(p.arrows_min) <= 0) {
            // Out, and told not to fight: wait for a giver to collect some rather than end the run.
            const giveUp = Math.min(Date.now() + Number(p.supply_wait_s) * 1000, until);
            while (arrowCount(items) === 0 && Date.now() < giveUp) {
              log(`no arrows; waiting for ${givers.join('/')} to collect some`);
              await sleep(60_000);
              await pullArrows(call);
              items = await readPack(call);
              if (await goFetch()) return { ok: true, why: `fetching arrows from ${st.supplyRoom}` };
            }
          }
        }
        if (arrowCount(items) < Math.max(1, Number(p.arrows_min))) {
          if (Number(p.arrows_min) <= 0 && arrowCount(items) === 0) return { ok: false, why: 'out of arrows (arrows_min=0: not fighting for more)' };
          if (Number(p.arrows_min) > 0) {
            log(`${arrowCount(items)} arrows — fighting for more`);
            const r = await resupply({ call, keeper }, st);
            if (!r.ok) return { ok: false, why: r.why };
            items = await readPack(call);
          }
        }
        if (!(await wield(call, bow))) return { ok: false, why: `could not wield the ${bow.name}` };

        const look = await call('look', { agent }, 30_000).catch(() => null);
        const monsters = monstersIn(look);
        if (!monsters.length) { await sleep(20_000); continue; }      // between spawns
        const pick = pickTarget(monsters, bestiary, Object.fromEntries(sk.training.map(n => [n, sk.held[n]])));
        if (!pick.target) return { ok: false, why: `this room cannot teach ${agent} any more: ${pick.why}` };

        const r = await keeper('fight', { target: pick.target.name, rounds: Math.max(1, Number(p.burst)),
                                          abort_below: Number(p.abort_below), reach: Number(p.reach) }, 240_000);
        const spent = Number(r?.swings_spent) || 0;
        st.shots += spent; st.swingsSinceMend += spent;
        if (r?.error) { log(`fight: ${r.error}`); await sleep(10_000); }
        else if (!r?.engaged && r?.why) { log(`fight: ${r.why}`); await sleep(5_000); }
        if (healthOf(await call('status', { agent }, 30_000).catch(() => null)) < Number(p.abort_below)) {
          log('hurt — pausing while survival decides'); await sleep(30_000);
        }
        if (Date.now() - st.lastReport > 10 * 60_000) {
          st.lastReport = Date.now();
          log(`${Object.entries(sk.held).map(([k, v]) => `${k} ${v}`).join(', ')}; ${st.shots} shots, ${arrowCount(items)} arrows, bow "${band}", ${st.mends} mends`);
        }
      }
    }, 'shoot until the bow is due a mend, the skills are done, or the room cannot teach', `train ${k + 1}`);

    // ------------------------------------------------------------------ the mend step
    const mend = (k) => verify(async ({ call, state, fleet: f }) => {
      const st = S(state);
      if (st.done || !st.needMend) return { ok: true, why: 'no mend needed' };
      const store = chaliceStoreFor({ fleet: f ?? fleet });
      const { desk, why } = pickMendDesk(store.desk(), p.desk);
      if (!desk) return { ok: false, why };
      const room = (await observe(agent).catch(() => null))?.room ?? null;
      if (Number(room) !== Number(desk.room)) return { ok: false, why: `standing in ${room}, but ${desk.name}'s desk is in ${desk.room}` };

      const { bow } = await bowInPack(call);
      if (!bow) return { ok: false, why: `no ${p.bow} in the pack at the desk` };
      const before = await bandNow(call, bow);
      await call('act', { agent, verb: 'unuse', target: bow.id }, 30_000).catch(() => null);
      const dropped = await call('act', { agent, verb: 'drop', target: bow.id }, 30_000).catch(e => ({ error: e.message }));
      if (dropped?.error) return { ok: false, why: `could not drop the bow: ${dropped.error}` };
      const pickUp = async () => {
        await call('act', { agent, verb: 'get', target: bow.id }, 30_000).catch(() => null);
        return findBow((await readPack(call)) ?? [], p.bow);
      };

      // MEND REACHES ONLY ITS OWN FLOOR (mend.kod:106-110): the bow lies at the desk's feet until
      // the ticket closes. It is watched the whole time — a floor is public.
      // THE TICKET NAMES THE CHARACTER, not the agent: the desk looks for its traveller among the
      // players in its room by name (playerHere), and an agent id is nobody's name. Measured in the
      // lab 2026-10-20: a ticket filed as "pbow01" was claimed, waited on beside the archer, and
      // timed out at serve.
      const me = (await call('status', { agent }, 30_000).catch(() => null))?.character || agent;
      const t = store.request(me, { room: desk.room, kind: 'mend', items: [{ id: bow.id, name: bow.name }],
                                       ttlMs: Number(p.mend_wait_s) * 1000 });
      log(`dropped the ${bow.name} ("${before}") for ${desk.name}; ticket ${t.id}`);
      const deadline = Date.now() + Number(p.mend_wait_s) * 1000;
      let ticket = t;
      while (Date.now() < deadline) {
        await sleep(3_000);
        ticket = store.ticket(t.id) ?? ticket;
        if (['done', 'abandoned', 'expired'].includes(ticket.status)) break;
        const look = await call('look', { agent }, 30_000).catch(() => null);
        if (look?.objects && !look.objects.some(o => Number(o.id) === Number(bow.id))) {
          const back = await pickUp();
          if (!back) return { ok: false, why: `THE BOW LEFT THE FLOOR while waiting for ${desk.name} — somebody took it` };
        }
      }
      if (!['done', 'abandoned', 'expired'].includes(ticket.status)) try { store.mark(t.id, 'abandoned', { note: 'archer stopped waiting' }); } catch {}
      const back = await pickUp();
      if (!back) return { ok: false, why: `could not pick the ${bow.name} back up (ticket ${ticket.status})` };
      const after = await bandNow(call, back);
      await wield(call, back);
      if (ticket.status !== 'done' || !(Number(ticket.mended) > 0) || !after || bandAtOrBelow(after, p.mend_at))
        return { ok: false, why: `not mended: ticket ${ticket.status}${ticket.note ? ` (${ticket.note})` : ''}, bow "${after}"` };
      st.mends++; st.needMend = false; st.swingsSinceMend = 0;
      log(`mended by ${desk.name}: "${before}" -> "${after}" (mend ${st.mends})`);
      return { ok: true, why: `mend ${st.mends}: ${before} -> ${after}` };
    }, 'drop the bow at the desk, wait for the Mend, take it back', `mend ${k + 1}`);

    // ------------------------------------------------------------------ the arrow step
    // Standing in a supply room (the walk before this took the archer there): take arrows from the
    // givers here, exactly as in the practice room.
    const restock = (k) => verify(async ({ call, state }) => {
      const st = S(state);
      if (st.done || !st.needArrows) return { ok: true, why: 'no arrow trip' };
      st.needArrows = false;
      const got = await pullArrows(call);
      const now = arrowCount(await readPack(call));
      log(`arrow trip to ${st.supplyRoom}: +${got}, ${now} now`);
      return { ok: true, why: `+${got} arrows in ${st.supplyRoom}` };
    }, 'take arrows from the givers in the supply room', `arrows ${k + 1}`);

    // ------------------------------------------------------------------ the plan
    if (!practice) return [verify(async () => ({ ok: false, why: `could not read ${agent}'s room — say room=` }), 'know the practice room')];
    const rooms = [...new Set([practice, ...(deskRoom ? [deskRoom] : []), ...supplyRooms])];
    const away = rooms.some(r => r !== practice);
    const steps = [verify(async () => {
      log(`practising in ${practice}; mend desk ${chosen.desk ? `${chosen.desk.name} in ${deskRoom}` : (deskRoom ? `room ${deskRoom}` : `none (${chosen.why})`)}; training ${only.join('+')} where held`);
      return { ok: true };
    }, 'say where and with whom', 'plan')];
    if (asked) steps.push(walk(practice));
    for (let k = 0; k < Math.max(1, Number(p.cycles)); k++) {
      steps.push(train(k));
      if (away) {
        // To the desk when the bow is due, to a supply room when an arrow trip is due; otherwise this
        // resolves to where the archer already is.
        steps.push(walk(state => {
          const pb = state.pb;
          if (pb?.done) return practice;
          if (pb?.needMend && deskRoom) return deskRoom;
          if (pb?.needArrows && pb.supplyRoom) return pb.supplyRoom;
          return practice;
        }, { candidates: rooms }));
        if (deskRoom) steps.push(mend(k));
        if (supplyRooms.length) steps.push(restock(k));
        steps.push(walk(practice));
      } else if (deskRoom) steps.push(mend(k));
    }
    return steps;
  },
};
