// SELL A GUILD HALL'S MUNDANE WEAPONS, ARMOUR AND SHIELDS, IN LAPS -- and bring the magic ones back.
//
// PUBLIC. Operator, 2026-11-18: "Send someone to each guildhall to go in laps and sell (or just drop, for anything not
// able to be sold quickly in the nearest town) all *non-magic* weapons and armors from the hall chests that can be
// rebought -- with a keep list of exceptions: bows of all types, plate mail, and helms ... Non-magic shields also should be
// included ... magic here refers to the 'unidentified' or with special properties".
//
//   node tools/m59-fleet-repl.mjs  ->  dry hall-sell-mundane agents=t10 hall=714        (the plan and the steps, sends nothing)
//                                  ->  hall-sell-mundane agents=t10 hall=714
//                                  ->  hall-sell-mundane agents=t5 hall=703 keep=bow,plate%20armor,helm,nerudite
//   node tools/m59-hall-sell.mjs plan --all                                              (the same plan, read-only, no REPL)
//
// The generalisation of a prod-local errand (hall-sell-gear: 714 only, one smith, a name list that sold plate and bows
// and could not tell a magic long sword from a plain one, because the chest cache stores names). The pure half --
// which names are candidates, which smith, is a drawn piece magic, how much fits -- is tools/m59-hall-sell.mjs; this is
// the legs. Every lap:
//
//   walk to the hall -> READ the chests (hall_withdraw `wants: []` replies with every object's id and GRADE, stamped
//   `chest_ids_as_of`) -> plan from THAT reading, NORMAL grade only (uncommon, rare, unidentified, cursed and ungraded
//   pieces are left in the chest and counted per name and grade) -> pick the ids of what fits, leaving the weapon reserve
//   free -> draw BY ID with the stamp (a server save since the read voids every id: re-read and re-select; the keeper
//   checks the arrival by id, name and grade and puts anything else straight back) -> classify every drawn piece again by
//   its grade AND its look text -> MAGIC or UNREAD pieces go back into the chests, by id, and are counted aside -> walk to
//   the smith -> sell each
//
//   WHY BY ID (2026-11-19 05:34Z, hall 714): the draw asked for "short sword" by name, the chest handed over the
//   unidentified one beside the plain one, and it wielded itself in Animal's hand, cursed. The chest had sent its grade.
//   mundane piece, one per call, judged by the PACK (the id left) and the PURSE (it rose): a refusal is a sentence, not an
//   error -> what the smith will not take is dropped there (or at drop_room), never in the hall.
//
// THE RUNNER'S OWN KIT IS NEVER SOLD. Before the first draw the pack is snapshotted: what it carries of each name is a
// floor no sale, drop or deposit dips under, and only ids that ARRIVED in a lap's draw are ever offered.
//
// A REFUSED DOOR IS A RETRY, NOT THE END (hall-sell-gear, 2026-11-02: "guild door 59 could not be crossed" twice in an
// hour at a door that opened for the same body minutes later). A draw refused at the passage is retried after a minute,
// three times; a lap that still cannot draw is counted, and three such laps end the run with the reason.
import { walk, verify, purseOf } from '../m59-fleetscript.mjs';
import { withdrawWithRecovery, depositWithRecovery, hallWithdrawRetrying } from '../m59-hall-access.mjs';
import { freeRoom } from '../m59-vault-broker.mjs';
import { weaponReserveSize } from '../m59-weapon-reserve.mjs';
import { parseKeep, hallInputs, planHall, formatPlan, planLap, classifyPiece, readingHasGrades, contentsAsChests,
         selectIds, idDrawnRows, newTally, bump, formatTally, HALL_BUYERS } from '../m59-hall-sell.mjs';
import { gradeOf } from '../m59-items.mjs';

const norm = s => String(s ?? '').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const yes = v => !/^(no|false|0|off)$/i.test(String(v ?? 'yes').trim());
const RETRYABLE = /could not be crossed|not in a guild hall|not in game|trigger not reached|outside the known passage|not in the hall/i;

export const script = {
  name: 'hall-sell-mundane',
  describe: "In laps, draw a guild hall's mundane weapons, armour and shields that a merchant sells, sell them to the hall's town smith (drop what he will not take), and put every magic or unread piece back.",
  recipe: {
    effect: "The hall's chests end with no rebuyable non-magic weapon, body armour or shield outside the keep list; the run prints drawn/sold/dropped/returned per name and the shillings earned.",
    run: 'hall-sell-mundane agents=<one> hall=<703|713|714> [laps=20] [keep=bow,plate%20armor,helm] [sell_at=Name@room]',
    needs: ['membership (or alliance) of the hall\'s guild at rank SIR or above -- CanEnter refuses in silence (ghall.kod:1039)',
            'a keeper with the hall_withdraw op that records the chests it reads (every keeper since the per-hall chest cache)',
            'pack room: at least one piece plus the 90 bulk/weight weapon reserve'],
    cost: { time: 'a lap is ~2-4 min at 714 (the smith is two doors away), longer at 703 (Jasper) and 713 (Ko\'catan)',
            risk: 'what the smith refuses is dropped in the street; a mid-run system save renumbers ids (handled by counts)' },
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'the runner (one)' },
    hall: { type: 'number', required: true, describe: `the guild hall room (${Object.keys(HALL_BUYERS).join(', ')} have a default buyer)` },
    laps: { type: 'number', default: 20, describe: 'draw-and-sell laps at most' },
    keep: { type: 'string', default: '', describe: 'comma list of name substrings never sold (default bow, plate armor, helm; "none" keeps nothing)' },
    sell_at: { type: 'string', default: '', describe: 'override the buyer: "<merchant>@<room>"' },
    drop_unsellable: { default: 'yes', describe: 'drop what the buyer refuses (yes) or put it back in the hall (no)' },
    drop_room: { type: 'number', default: 0, describe: 'where to drop refused pieces (0 = the buyer\'s room)' },
    proceeds: { type: 'string', default: 'hall', describe: '"hall": deposit the shillings earned into the chests at the end; "keep": the runner keeps them' },
    max_pieces: { type: 'number', default: 20, describe: 'most pieces drawn in one lap (each is looked at and sold one call at a time)' },
    home: { type: 'number', default: 0, describe: 'walk here at the end (0 = stay where the run ends)' },
  },

  async steps(p, agentArg) {
    const agent = p.agent ?? agentArg;
    if (String(p.agents ?? agent).split(',').filter(Boolean).length > 1)
      throw new Error('hall-sell-mundane takes ONE runner: two drawing from the same chests would plan the same pieces');
    const hall = Number(p.hall);
    if (!Number.isFinite(hall)) throw new Error('hall-sell-mundane: hall=<room> is required (703, 713 or 714)');
    const keep = parseKeep(p.keep);
    const laps = Math.max(1, Math.min(60, Number(p.laps) || 20));
    const dropUnsellable = yes(p.drop_unsellable);
    const proceeds = String(p.proceeds ?? 'hall').toLowerCase() === 'keep' ? 'keep' : 'hall';
    const maxPieces = Math.max(1, Number(p.max_pieces) || 20);
    // The plan now, from the cache as it stands: printed by `dry`, and it REFUSES here (no buyer, no hall) before a step.
    const inputs0 = await hallInputs({ hall });
    const plan0 = planHall({ hall, inputs: inputs0, keep, sellAt: p.sell_at || null });
    const buyer = plan0.buyer;
    const dropRoom = Number(p.drop_room) > 0 ? Number(p.drop_room) : buyer.room;
    console.log(formatPlan(plan0));

    const S = { tally: newTally(), setAside: {}, carry: [], toSell: [], toDrop: [], done: null, failedLaps: 0,
                drawn: new Set(), missed: new Set(), at: null, own: null, worn: null, wornNames: null, lap: 0,
                returnedIds: new Set() };
    const log = m => console.log(`  ${agent}: ${m}`);
    const finish = why => { if (!S.done) { S.done = why; log(`DONE: ${why}`); } };

    const inventory = async call => (await call('inventory', { agent }, 60_000).catch(() => null))?.items ?? null;
    const equippedNames = async call => {
      const eq = await call('equipment', { agent }, 30_000).catch(() => null);
      if (!eq || eq.known === false) return null;
      return (eq.equipped ?? eq.items ?? []).map(e => norm(typeof e === 'string' ? e : e?.name)).filter(Boolean).sort();
    };
    const countBy = (items, worn = new Set()) => {
      const m = {};
      for (const o of items ?? []) if (!worn.has(Number(o.id))) m[norm(o.name)] = (m[norm(o.name)] ?? 0) + (Number(o.amount) > 0 ? Number(o.amount) : 1);
      return m;
    };
    const lookAt = async (call, id) => {
      for (let i = 0; i < 2; i++) {
        const l = await call('look_at', { agent, target: id }, 30_000).catch(() => null);
        if (l && Number(l.id) === Number(id) && l.description) return l;
        await sleep(700);
      }
      return null;
    };

    // PUT PIECES BACK, BY ID, AND COUNT ONLY WHAT LEFT THE PACK.
    const fieldOf = x => x.verdict === 'unknown' ? 'returned_unknown' : x.verdict === 'unsold' ? 'returned_unsold' : 'returned_magic';
    const putBack = async (call, pieces) => {
      if (!pieces.length) return [];
      const r = await depositWithRecovery(call, agent, pieces.map(x => `id:${x.id}`));
      const now = await inventory(call);
      const still = new Set((now ?? []).map(o => Number(o.id)));
      const left = [];
      for (const x of pieces) {
        if (now && !still.has(Number(x.id))) {
          bump(S.tally, x.name, fieldOf(x));
          // A NORMAL-GRADED piece put back (a look-text attribute, unread, unsold) still reads as a candidate in the next
          // fresh reading: counted aside, and its id skipped while it stands. Graded pieces are excluded by the plan anyway.
          if (x.grade == null || x.grade === 'normal') S.setAside[norm(x.name)] = (S.setAside[norm(x.name)] ?? 0) + 1;
          S.returnedIds.add(Number(x.id));
        } else left.push(x);
      }
      if (left.length) log(`could not put back ${left.map(x => `${x.name} #${x.id}`).join(', ')} (${r.why ?? 'still in the pack'}) -- carried, retried next visit, never sold`);
      return left;
    };

    // ONE DRAW, THE DOOR RETRIED (hall-sell-gear's pattern: a minute's pause, up to three tries).
    const drawWithDoors = async (call, wants, chestIdsAsOf) => {
      let r = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        r = await withdrawWithRecovery(call, agent, wants, { chestIdsAsOf });
        if (r.chest_ids_stale) return r;          // the ids are void: re-read, never re-send them
        if (r.ok || !RETRYABLE.test(String(r.why ?? ''))) return r;
        log(`draw attempt ${attempt} refused at the passage (${r.why}) -- waiting a minute`);
        await sleep(60_000);
      }
      return r;
    };

    const drawLap = i => verify(async ({ call }) => {
      S.drawn.add(i);
      if (S.done) return true;
      S.lap++;
      // The snapshot, once, before anything comes out of a chest.
      if (!S.own) {
        const inv = await inventory(call);
        const eq = await call('equipment', { agent }, 30_000).catch(() => null);
        if (!inv || !eq || eq.known === false) { finish('the pack or the equipment could not be read before the first draw'); return { ok: false, why: S.done }; }
        S.worn = new Set((eq.equipped ?? eq.items ?? []).map(e => Number(e?.id)).filter(n => n > 0));
        S.wornNames = await equippedNames(call);
        S.own = countBy(inv, S.worn);
        S.purse0 = purseOf(inv);
        log(`own kit snapshot: worn ${S.wornNames.join(', ') || 'nothing'}; purse ${S.purse0}`);
      }
      // Anything still carried from a failed put-back goes in first.
      if (S.carry.length) S.carry = await putBack(call, S.carry);
      // READ, PLAN, PICK IDS, DRAW -- in one visit, and again from the top if a save renumbered the ids in between.
      // The reading is hall_withdraw's own reply (`contents`, every object with its id and grade, stamped
      // `chest_ids_as_of`): the cache keeps names and grades but no ids, because an id is a handle every save renumbers.
      let r = null, lap = null, before = null, sel = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const rd = await hallWithdrawRetrying(call, { agent, wants: [] }, 620_000, { retries: 2, pauseMs: 60_000 })
          .catch(e => ({ ok: false, why: e.message }));
        if (!rd?.ok) { S.failedLaps++; log(`chest read refused (${rd?.why ?? '?'}); ${S.failedLaps} empty lap(s)`);
          if (S.failedLaps >= 3) finish(`three chest reads refused; last: ${rd?.why ?? '?'}`); return true; }
        const contents = Array.isArray(rd.contents) ? rd.contents : [];
        // A READING WITHOUT GRADES CANNOT SAY WHICH PIECE IS MUNDANE, and without ids nothing can be drawn by id: the
        // keeper predates graded chest reads (restart-keepers). Refused, never planned by name.
        if (!contents.length || !readingHasGrades(contents) || !rd.chest_ids_as_of) {
          finish('the fresh chest reading carries no grades or no ids (a keeper from before graded chest reads: ' +
                 'restart-keepers) -- nothing is drawn by name');
          return { ok: false, why: S.done };
        }
        const plan = planHall({ hall, inputs: { ...inputs0, chests: contentsAsChests(contents, rd.chest_ids_as_of.read_at) },
                                keep, sellAt: p.sell_at || null, setAside: S.setAside });
        if (S.lap === 1 && attempt === 1 && plan.excluded.graded.length)
          log(`left in the chests by grade: ${plan.excluded.graded.map(g => `${g.amount} ${g.item} (${g.grade})`).join(', ')}`);
        const cands = [...plan.sell, ...plan.drop];
        if (!cands.length) { finish(`nothing left to draw (${plan.excluded.set_aside.length ? 'only known magic/unsold pieces remain' : 'the chests hold no normal-graded candidate'})`); return true; }
        const row = (await call('fleet', {}, 60_000).catch(() => null))?.fleet?.find(x => x.agent === agent);
        lap = planLap({ candidates: cands, room: freeRoom(row), reserve: weaponReserveSize(), weigh: inputs0.weigh, extra: {}, maxPieces });
        if (!lap.take.length) {
          finish(lap.why ?? (lap.blocked.length ? `nothing fits: ${lap.blocked.map(b => `${b.item} (${b.why})`).join('; ')}`
                                                : 'the pack has no room beyond the weapon reserve'));
          return true;
        }
        sel = selectIds({ contents, take: lap.take, skipIds: S.returnedIds });
        if (!sel.wants.length) { finish(`no normal-graded piece to draw by id (${sel.missing.map(m => m.item).join(', ')})`); return true; }
        log(`lap ${S.lap}: drawing by id ${sel.wants.length} piece(s): ${lap.take.map(t => `${t.amount} ${t.item}`).join(', ')}`);
        before = await inventory(call);
        r = await drawWithDoors(call, sel.wants, rd.chest_ids_as_of);
        if (r?.chest_ids_stale && !(r.took_ids ?? []).length) { log(`a server save renumbered the ids (${r.stopped ?? r.why}): re-reading and re-selecting`); continue; }
        break;
      }
      if (r?.stopped) log(`the keeper stopped the id draw: ${r.stopped}`);
      for (const x of r?.returned_ids ?? []) {
        log(`#${x.id} ${x.name} (${x.grade}) ${x.put_back ? 'was put back' : 'COULD NOT BE PUT BACK -- carried, returned next visit'}: ${x.why}`);
        if (!x.put_back) S.carry.push({ id: x.id, name: x.name, verdict: 'unknown', why: x.why });
      }
      const after = await inventory(call);
      // A CURSED PIECE WIELDS ITSELF ON ENTERING THE PACK (item.kod:508-514). Nothing the fleet deposits can be cursed (it
      // would have been stuck in the depositor's hand), but a changed hand after a draw is checked rather than assumed.
      const wornNow = await equippedNames(call);
      if (wornNow && S.wornNames && wornNow.join('|') !== S.wornNames.join('|')) {
        finish(`THE EQUIPPED SET CHANGED DURING A DRAW (${S.wornNames.join(', ')} -> ${wornNow.join(', ')}): a cursed piece may have ` +
               'wielded itself. Stopping; check the runner by hand (town.uncurse in docs/m59-economy.md lifts one)');
        return { ok: false, why: S.done };
      }
      if (!before || !after) { S.failedLaps++; log('the pack could not be read around the draw'); return true; }
      // WHAT ARRIVED: the ids the keeper drew and verified (id, name and grade in the pack), read back here once more.
      const { rows, mismatched } = idDrawnRows({ before, after, took: r?.took_ids ?? [] });
      for (const m of mismatched) {
        log(`#${m.id} is in the pack as "${m.name}", not the "${m.expected}" that was drawn -- a renumbered handle: back into the chests`);
        S.carry.push({ id: m.id, name: m.name, verdict: 'unknown', why: 'arrived under a different name' });
      }
      if (!rows.length) {
        S.failedLaps++;
        log(`nothing arrived (${r.why ?? 'no reason given'}); ${S.failedLaps} empty lap(s)`);
        if (S.failedLaps >= 3) finish(`three laps drew nothing; last: ${r.why ?? '?'}`);
        return true;
      }
      S.failedLaps = 0;
      const back = [];
      for (const o of rows) {
        bump(S.tally, o.name, 'drawn');
        const v = classifyPiece(o, await lookAt(call, o.id));
        if (v.verdict === 'cursed') { finish(`${o.name} #${o.id} is graded CURSED: stopping`); continue; }
        if (v.verdict === 'magic' || v.verdict === 'unknown') { back.push({ id: o.id, name: o.name, verdict: v.verdict, why: v.why, grade: gradeOf(o) }); continue; }
        const buys = buyer.cls ? inputs0.willBuy(buyer.cls, o.name).buys : null;
        if (v.verdict === 'conjured' || buys === false) S.toDrop.push({ id: o.id, name: o.name, why: v.verdict === 'conjured' ? v.why : `${buyer.merchant} refuses it by rule` });
        else S.toSell.push({ id: o.id, name: o.name });
      }
      for (const x of back) log(`${x.name} #${x.id}: ${x.verdict.toUpperCase()} (${x.why}) -> back into the chests`);
      const magic = back.filter(x => x.verdict === 'magic'), unknown = back.filter(x => x.verdict === 'unknown');
      S.carry.push(...await putBack(call, [...magic, ...unknown]));
      return true;
    }, 'draw a lap, classify each piece, put the magic back');

    const sellLap = () => verify(async ({ call }) => {
      const unsold = [];
      for (const x of S.toSell.splice(0)) {
        const inv0 = await inventory(call);
        if (!inv0?.some(o => Number(o.id) === Number(x.id))) { log(`${x.name} #${x.id} is no longer in the pack -- not offered`); continue; }
        const s = await call('sell', { agent, to: buyer.merchant, items: [Number(x.id)], confirm: true }, 120_000).catch(e => ({ error: e.message }));
        const inv1 = await inventory(call);
        const gone = inv1 && !inv1.some(o => Number(o.id) === Number(x.id));
        const got = inv1 ? purseOf(inv1) - purseOf(inv0) : 0;
        if (gone && got > 0) { bump(S.tally, x.name, 'sold'); S.tally.earned += got; }
        else if (gone) { bump(S.tally, x.name, 'sold'); S.tally.given_away.push(`${x.name} #${x.id} to ${buyer.merchant}`); log(`${x.name} LEFT THE PACK AND NO MONEY CAME BACK`); }
        else { unsold.push({ ...x, why: s?.error ?? s?.why ?? s?.said ?? 'the merchant did not take it' }); }
      }
      if (unsold.length) log(`${buyer.merchant} would not take ${unsold.map(x => x.name).join(', ')}`);
      if (dropUnsellable) S.toDrop.push(...unsold);
      else S.unsold = [...(S.unsold ?? []), ...unsold.map(x => ({ ...x, verdict: 'unsold' }))];
      S.at = buyer.room;
      return true;
    }, 'sell each mundane piece, judged by the pack and the purse');

    const dropLap = () => verify(async ({ call }) => {
      for (const x of S.toDrop.splice(0)) {
        await call('act', { agent, verb: 'drop', target: Number(x.id) }, 30_000).catch(() => null);
        const inv = await inventory(call);
        if (inv && !inv.some(o => Number(o.id) === Number(x.id))) { bump(S.tally, x.name, 'dropped'); log(`dropped ${x.name} (${x.why})`); }
        else { S.unsold = [...(S.unsold ?? []), { ...x, verdict: 'unsold' }]; log(`${x.name} #${x.id} would not drop -- it goes back to the hall at the end`); }
      }
      S.at = dropRoom;
      return true;
    }, 'drop what the buyer will not take, outside the hall');

    // THE RUNNER'S OWN ORDERS ARE LIFTED FOR THE ERRAND AND PUT BACK AFTER IT. A keeper confined to its farm (Bunsen to
    // 377) or to a practice room (Animal to 48) refuses every journey to the hall and the smith, and each refused walk is an
    // optional skip: the first run on prod, 2026-11-19 05:31Z, skipped forty-one walks on both runners and reported "1/1
    // completed" having drawn nothing. So the posture is read first, the errand runs unconfined in survive mode (no farming
    // pass to pull the body back to its room between legs), and the saved posture is restored at the end whatever happened.
    const posture = async call => {
      const st = await call('autopilot', { action: 'status', agent }, 30_000).catch(() => null);
      const pol = st?.policy ?? {};
      return { mode: st?.mode ?? null, farm_strategy: pol.farmStrategy ?? null, assigned_room: pol.assignedRoom ?? null,
               confine_rooms: Array.isArray(pol.confineRooms) ? pol.confineRooms : [], town_trips: pol.townTrips ?? null };
    };
    const steps = [verify(async ({ call }) => {
      S.posture = await posture(call);
      log(`orders saved for the errand: ${JSON.stringify(S.posture)}`);
      // A FARM STRATEGY OWNS ITS CONFINEMENT and puts it back over a bare confine_rooms push (Bunsen, 05:34Z: still [377]
      // after the push), so the strategy is cleared for the errand too; the restore step below gives it back.
      const r = await call('autopilot', { action: 'start', agent, mode: 'survive', confine_rooms: [], assigned_room: hall,
        town_trips: false, ...(S.posture.farm_strategy ? { farm_strategy: null } : {}),
        why: 'hall-sell-mundane: selling hall gear' }, 60_000).catch(e => ({ error: e.message }));
      const now = await posture(call);
      if (now.confine_rooms.length) return { ok: false, why: `could not lift the confinement (${JSON.stringify(now.confine_rooms)}): ${r?.error ?? r?.reason ?? 'no reason given'}` };
      return true;
    }, 'lift the runner\'s confinement for the errand')];
    for (let i = 0; i < laps; i++) {
      // A LAP WHOSE DRAW NEVER RAN had its walk to the hall fail (an optional walk skips the steps that needed the room).
      // Counted here, idempotently (a retried walk resolves its destination again), and three of them end the run.
      steps.push({ ...walk(() => {
        if (i > 0 && !S.done && !S.drawn.has(i - 1)) { S.missed.add(i - 1); if (S.missed.size >= 3) finish('three walks to the hall failed'); }
        return S.done ? (S.at ?? buyer.room) : hall;
      }, { candidates: [hall, buyer.room, dropRoom], why: `lap ${i + 1}: the guild chests` }), optional: true });
      steps.push(drawLap(i));
      steps.push({ ...walk(() => (S.done && S.at != null ? S.at : buyer.room), { candidates: [buyer.room, dropRoom], why: `lap ${i + 1}: ${buyer.merchant}` }), optional: true });
      steps.push(sellLap());
      if (dropRoom !== buyer.room)
        steps.push({ ...walk(() => (S.toDrop.length ? dropRoom : (S.at ?? buyer.room)), { candidates: [dropRoom, buyer.room], why: `lap ${i + 1}: a street to drop in` }), optional: true });
      steps.push(dropLap());
    }
    // THE END: what could not go back or be sold, and the proceeds, into the chests.
    const needHall = () => S.carry.length || (S.unsold ?? []).length || (proceeds === 'hall' && S.tally.earned > 0);
    steps.push({ ...walk(() => (needHall() ? hall : (S.at ?? buyer.room)), { candidates: [hall, buyer.room, dropRoom], why: 'the proceeds and the leftovers into the chests' }),
                 optional: true, always: true });
    steps.push({ ...verify(async ({ call }) => {
      if (!needHall()) return true;
      const pieces = [...S.carry, ...(S.unsold ?? [])];
      const inv = await inventory(call);
      const purse = inv ? purseOf(inv) : null;
      const earned = proceeds === 'hall' ? S.tally.earned : 0;
      // DEPOSIT THE PURSE, DRAW BACK WHAT WAS THE RUNNER'S (the chalice hand-in's pattern, autopilot/chalice.mjs): a
      // deposit takes a whole stack, so the earnings alone cannot be put in.
      const drawBack = earned > 0 && purse != null ? Math.max(0, purse - earned) : 0;
      const deposit = [...pieces.map(x => `id:${x.id}`), ...(earned > 0 ? ['shilling'] : [])];
      const r = await hallWithdrawRetrying(call, { agent, wants: drawBack > 0 ? [{ item: 'shilling', amount: drawBack }] : [], deposit }, 620_000,
                                           { retries: 2, pauseMs: 60_000 }).catch(e => ({ ok: false, why: e.message }));
      const inv2 = await inventory(call);
      const still = new Set((inv2 ?? []).map(o => Number(o.id)));
      for (const x of pieces) bump(S.tally, x.name, inv2 && !still.has(Number(x.id)) ? fieldOf(x) : 'carried');
      if (earned > 0) {
        const p2 = inv2 ? purseOf(inv2) : null;
        S.tally.notes.push(p2 == null ? `proceeds: deposit sent (${r?.ok ? 'ok' : r?.why}), purse unread`
          : `proceeds: purse ${purse} -> ${p2} (deposited ${purse - p2} of ${earned} earned${r?.ok ? '' : `; ${r?.why}`})`);
      }
      return true;
    }, 'leftovers and proceeds into the chests'), optional: true, always: true });
    steps.push({ ...verify(async () => {
      if (!S.done) S.done = `ran out of laps (${laps})`;
      const end = await hallInputs({ hall }).catch(() => null);
      const left = end ? planHall({ hall, inputs: end, keep, sellAt: p.sell_at || null, setAside: S.setAside }) : null;
      console.log(`  ${agent}: HALL-SELL-MUNDANE ${hall} REPORT (${S.done}; ${S.lap} lap(s))\n${formatTally(S.tally)}` +
        (proceeds === 'keep' ? `\n  proceeds kept by ${agent}` : '') +
        (S.tally.notes.length ? `\n  ${S.tally.notes.join('\n  ')}` : '') +
        (left ? `\n  LEFT IN THE CHESTS (last reading):\n${formatPlan(left).split('\n').slice(1).map(l => `  ${l}`).join('\n')}` : ''));
      // A RUN THAT NEVER DREW, WITH PIECES PLANNED, FAILED, and says so rather than "completed".
      if (!S.drawn.size && plan0.sell.length + plan0.drop.length > 0)
        return { ok: false, why: `no lap drew anything (${S.done}); nothing was sold` };
      return true;
    }, 'the report'), always: true });
    if (Number(p.home) > 0) steps.push({ ...walk(Number(p.home), { why: 'home' }), always: true });
    // AND THE RUNNER'S ORDERS GO BACK. A farm strategy re-applies its own confinement and station, so it is the one thing
    // restored when there was one; otherwise the mode, room and confinement as they were.
    steps.push({ ...verify(async ({ call }) => {
      const o = S.posture;
      if (!o) return true;
      const back = o.farm_strategy
        ? { mode: o.mode ?? 'farm', farm_strategy: o.farm_strategy }
        : { mode: o.mode ?? 'survive', assigned_room: o.assigned_room, confine_rooms: o.confine_rooms };
      if (o.town_trips != null) back.town_trips = o.town_trips;
      const r = await call('autopilot', { action: 'start', agent, ...back, why: 'hall-sell-mundane: orders restored' }, 60_000)
        .catch(e => ({ error: e.message }));
      log(`orders restored: ${JSON.stringify(back)}${r?.error ? ` (refused: ${r.error})` : ''}`);
      return true;
    }, 'restore the runner\'s orders'), always: true });
    return steps;
  },
};
