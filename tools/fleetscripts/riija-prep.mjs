// STOCK THE ISLAND GUILD HALL (713) FOR A SWORD OF RIIJA, so the quester's deliveries are only
// "draw from 713, walk to the NPC, hand over exactly what was asked".
//
// PUBLIC, parameterised; no character is named. The manifest, every source and the reasoning are in
// tools/m59-riija.mjs (prepManifest, SOURCES); usage is docs/m59-riija-sword.md.
//
// WHAT "EVERYTHING" MEANS FOR ONE KARMA SIDE (questengine.kod:2971-3058):
//   good  Wulfgang's good table (50 meat pies, 70 water skins, 150 apples, 200 bunches of grapes,
//         350 elderberries, 250 herbs, 200 mushrooms, 1 Jewel of Froz) + a chunk of nerudite for
//         Hanla's good route + spare meat pies for the dragonfly queen
//   evil  Wulfgang's evil table (1 mystic sword, 1 plate armor, 100 mugs of brew, 1 chunk of
//         nerudite, 70 goblets of wine, 70 goblets of ale) + spare meat pies for the queen
// plus the orc pit boss head, which only riija-pitboss can supply (it is listed so `plan` shows it).
// He asks for ONE row; stocking the whole table is the operator's choice, so delivery inside his
// one-hour node is a draw and never a shopping trip. `skip=` drops rows (e.g. the 350 elderberries)
// for an operator who would rather fetch that one row on demand.
//
// ONE MODE PER RUN, because the sources are on two landmasses and the pack is finite:
//   plan      read-only: the hall's last chest readings (substrate/storage, m59-hall-chests.mjs) against
//             the manifest; what is short, and where each short row can come from. Moves nobody.
//   buy       buy the short rows from shops on `where`=island (Moxal, Wulfgang, Tepal's conditional
//             nerudite) and deposit them in 713 -- or `where`=mainland (Zhieu, Pietro, Meidei...) and
//             END CARRYING them: the mainland half rides over with island-trip, then `deposit`.
//   dispense  the Duke's Feast Hall (953) tables: grapes and goblets of ale, one per `activate`.
//   draw      take short rows out of another guild hall the courier may enter (`fromHall`, 714/703).
//   deposit   walk to 713 and put every manifest item in the pack into the chests.
// Each run re-reads the hall, so `buy` twice is two laps, never a double order.
//
// EVERY matching stack in the courier's pack goes into the chests on a deposit (the hall's deposit takes
// whole stacks), so a courier's own travelling pies go too -- give it its food after the lap.
//
// A COURIER MUST BE ABLE TO ENTER 713: a member of its guild (or an ally), rank sir or above, or the
// door stays shut in silence (hall_withdraw). Money: shop steps spend the courier's purse; the shop
// step reports a purse clamp as such. Tepal's nerudite is 1,200 a chunk (kctailor.kod:115-118).
import { walk, verify, say, shop } from '../m59-fleetscript.mjs';
import { depositWithRecovery, withdrawWithRecovery } from '../m59-hall-access.mjs';
import { StorageCache } from '../m59-storage.mjs';
import { summarise } from '../m59-hall-chests.mjs';
import { ROOMS, ITEMS, SOURCES, prepManifest, countByKey, shortfall, pickSource } from '../m59-riija.mjs';

const A = s => ({ ...s, anywhere: true });
const list = v => String(v ?? '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
const count = (items, match) => (items ?? []).filter(i => match.test(String(i.name ?? ''))).reduce((n, i) => n + (Number(i.amount) || 1), 0);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The manifest for one or both sides, with what the hall holds (last reading) and what is short. */
export function prepPlan({ side, queenPies = 5, skip = [], hall = ROOMS.hall, chests = null } = {}) {
  const sides = side === 'both' ? ['good', 'evil'] : [side];
  const merged = new Map();
  for (const s of sides) for (const m of prepManifest({ side: s, queenPies, skip })) {
    const prev = merged.get(m.key);
    merged.set(m.key, prev ? { ...prev, amount: Math.max(prev.amount, m.amount), why: `${prev.why}; ${m.why}` } : m);
  }
  const rows = chests ?? summarise(new StorageCache().allChests({ room: hall }));
  const have = countByKey(rows.flatMap(c => c.items ?? []));
  const oldest = rows.length ? Math.max(...rows.map(c => c.age_min ?? 0)) : null;
  return { hall, read: rows.length ? `${rows.length} chest(s), oldest reading ${oldest} min` : 'no chest readings for this hall',
           rows: shortfall([...merged.values()], have) };
}

export const script = {
  name: 'riija-prep',
  describe: "Stock guild hall 713 with everything a Sword of Riija quester's karma side can be asked for (plan / buy / dispense / draw / deposit).",
  provenance: { pinned: '019bf448', verified: '2026-11-13', refuseOnDrift: false,
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-hall-access.mjs', 'tools/m59-storage.mjs', 'tools/m59-riija.mjs'] },
  recipe: {
    effect: 'Hall 713 holds the side\'s whole manifest; `plan` says what is still short and where it comes from.',
    run: 'riija-prep agents=<courier> side=good|evil|both mode=plan|buy|dispense|draw|deposit [where=island|mainland] [items=meatPie,apple] [skip=elderberry]',
    needs: ['a courier who can enter hall 713 (guild member or ally, rank sir+)', 'the purse for what it buys',
      'for where=mainland: carry the goods over with island-trip, then mode=deposit'],
    cost: { time: 'one lap per run; the good table is ~1,300 items in all', risk: 'town shops; the Duke\'s Feast Hall; the cave road for mainland goods' },
    notes: ['Room numbers of the sources are in tools/m59-riija.mjs SOURCES (from substrate/m59-merchants.json and the kod).'],
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'the courier (one)' },
    side: { type: 'string', required: true, options: ['good', 'evil', 'both'], describe: "the quester's karma side (>= +10 good, <= -10 evil)" },
    mode: { type: 'string', default: 'plan', options: ['plan', 'buy', 'dispense', 'draw', 'deposit'] },
    where: { type: 'string', default: 'island', options: ['island', 'mainland'], describe: 'buy: which landmass\'s shops' },
    items: { type: 'string', default: '', describe: 'limit to these manifest keys (meatPie, apple, nerudite, wine, ...); empty = every short row' },
    skip: { type: 'string', default: '', describe: 'manifest keys never to stock (fetch those on demand instead)' },
    queenPies: { type: 'number', default: 5, describe: 'spare meat pies for the queen, on top of any table row' },
    cap: { type: 'number', default: 250, describe: 'at most this many of one item per run (a lap, not the whole table)' },
    fromHall: { type: 'room', default: 714, describe: 'draw: the other guild hall to take short rows from' },
    hall: { type: 'room', default: ROOMS.hall, describe: 'the hall being stocked' },
    home: { type: 'room', default: 0, describe: 'room to walk back to at the end (0 = stay)' },
    minHealth: { type: 'number', default: 0.8 },
  },

  async steps(p) {
    const hall = Number(p.hall) || ROOMS.hall;
    const only = new Set(list(p.items)), cap = Math.max(1, Number(p.cap) || 250);
    const plan = prepPlan({ side: p.side, queenPies: Number(p.queenPies), skip: list(p.skip), hall });
    const wanted = plan.rows.filter(r => r.short > 0 && r.key !== 'head' && (!only.size || only.has(r.key)));
    for (const k of only) if (!ITEMS[k] || !SOURCES[k]) throw Error(`unknown manifest key "${k}" -- one of ${Object.keys(SOURCES).join(', ')}`);
    const steps = [A(verify(async () => {
      const table = plan.rows.map(r => `${String(r.short).padStart(4)} short  ${String(r.have).padStart(4)}/${String(r.amount).padEnd(4)} ${r.name}` +
        (r.short ? `  <- ${r.sources.map(s => s.kind === 'shop' ? `${s.seller}@${s.room}${s.island ? ' (island)' : ''}${s.trigger ? ` say "${s.trigger}"` : ''}`
          : s.kind === 'dispense' ? `dispenser@${s.room}` : s.kind === 'hall' ? 'another hall' : `loot: ${s.where}`).join(' | ')}` : ''));
      console.log(`  riija-prep ${p.side}: hall ${hall} (${plan.read})\n    ` + table.join('\n    '));
      return { ok: true, hall, read: plan.read, short: Object.fromEntries(plan.rows.filter(r => r.short).map(r => [r.key, r.short])) };
    }, 'the manifest against the hall'))];
    if (p.mode === 'plan') return steps;

    // How much of `key` this lap should fetch: the hall's shortfall, minus what the courier already
    // carries, clamped to `cap`. Read LIVE off the pack, so a rerun after a partial lap buys the rest.
    const lapOf = key => A(verify(async ({ agent, call, state }) => {
      const pack = (await call('inventory', { agent }, 60_000).catch(() => null))?.items;
      if (!pack) return { ok: false, why: 'pack unreadable; nothing bought' };
      const row = wanted.find(r => r.key === key);
      const n = Math.min(cap, Math.max(0, row.short - count(pack, ITEMS[key].match)));
      (state.lap ??= {})[key] = n;
      return { ok: true, [key]: n };
    }, `how many ${ITEMS[key].name} this lap`));
    const goIf = (room, cond) => ({ ...walk(st => (cond(st) ? room : null), { candidates: [room] }), optional: true });

    if (p.mode === 'buy') {
      for (const r of wanted) {
        const src = pickSource(r.key, { where: p.where, kinds: ['shop'] });
        if (!src) continue;
        steps.push(lapOf(r.key), goIf(src.room, st => st.lap?.[r.key] > 0));
        if (src.trigger) steps.push(say(src.trigger, { to: src.seller }));
        steps.push({ ...shop(src.seller, st => (st.lap?.[r.key] > 0 ? [{ match: ITEMS[r.key].match, amount: st.lap[r.key] }] : [])), optional: true });
      }
    } else if (p.mode === 'dispense') {
      for (const r of wanted) {
        const src = (SOURCES[r.key] ?? []).find(s => s.kind === 'dispense');
        if (!src) continue;
        steps.push(lapOf(r.key), goIf(src.room, st => st.lap?.[r.key] > 0), A(verify(async ({ agent, call, state }) => {
          const n = state.lap?.[r.key] ?? 0;
          if (!n) return { ok: true, skipped: true };
          const v = await call('look', { agent }, 30_000).catch(() => null);
          if (Number(v?.room?.num ?? v?.room) !== src.room) return { ok: false, why: `not in ${src.room}` };
          // A FoodDispenser answers `activate` with one fresh item (dispensr.kod TryActivate); its display
          // name is the template's dispenser name, so the match is loose and checked against the pack.
          const disp = (v?.objects ?? []).filter(o => src.dispenser.test(String(o.name ?? '')));
          if (!disp.length) return { ok: false, why: `no dispenser matching ${src.dispenser} in ${src.room}: saw ${(v?.objects ?? []).map(o => o.name).slice(0, 12).join(', ')}` };
          const held = async () => count((await call('inventory', { agent }, 60_000).catch(() => null))?.items, ITEMS[r.key].match);
          const start = await held();
          let got = 0, stalls = 0;
          for (let i = 0; got < n && stalls < 3; i++) {
            const d = disp[i % disp.length];
            await call('act', { agent, verb: 'activate', target: d.id }, 30_000).catch(() => null);
            if ((i + 1) % 10 === 0 || got + 10 > n) {
              await sleep(500);
              const now = (await held()) - start;
              stalls = now > got ? 0 : stalls + 1;
              got = now;
            }
          }
          return got > 0 ? { ok: true, [r.key]: got } : { ok: false, why: `the dispensers gave no ${ITEMS[r.key].name} (pack full, or not the right object)` };
        }, `take ${ITEMS[r.key].name} from the tables`)));
      }
    } else if (p.mode === 'draw') {
      const from = Number(p.fromHall);
      steps.push(walk(from, { why: 'another guild hall' }), A(verify(async ({ agent, call }) => {
        const wants = wanted.map(r => ({ item: ITEMS[r.key].name, amount: Math.min(cap, r.short) }));
        if (!wants.length) return { ok: true, skipped: 'nothing short' };
        const r = await withdrawWithRecovery(call, agent, wants);
        return r.ok ? { ok: true, drew: r.arrived } : { ok: false, why: `hall ${from}: ${r.why}` };
      }, `draw short rows from hall ${from}`)));
    }

    // DEPOSIT: on the island (buy/island, dispense and draw end mainland-side, so only an island lap or an
    // explicit deposit run walks to 713). Every manifest name goes in; the pack says what left.
    const depositHere = p.mode === 'deposit' || (p.mode === 'buy' && p.where === 'island');
    if (depositHere) {
      steps.push(walk(hall, { why: 'the chests the quester draws from' }), A(verify(async ({ agent, call }) => {
        // BY ID, matched EXACTLY: the keeper's deposit list is substrings, and "mushroom" would carry
        // every purple and inky-cap mushroom in the pack into the chests with it.
        const pack = (await call('inventory', { agent }, 60_000).catch(() => null))?.items ?? [];
        const ids = pack.filter(i => plan.rows.some(r => ITEMS[r.key].match.test(String(i.name ?? '')))).map(i => `id:${i.id}`);
        if (!ids.length) return { ok: true, note: 'nothing from the manifest in the pack' };
        const r = await depositWithRecovery(call, agent, ids);
        if (r.before === 0) return { ok: true, note: 'nothing from the manifest in the pack' };
        return r.ok ? { ok: true, stowed: r.left, hall } : { ok: false, why: `deposit in ${hall}: ${r.why}` };
      }, `deposit the manifest items in hall ${hall}`)));
    } else if (p.mode !== 'deposit') {
      steps.push(A(verify(async () => ({ ok: true, next: `carry the goods to Ko'catan (island-trip task=riija-prep taskParams={"side":"${p.side}","mode":"deposit"}), or run mode=deposit once there` }),
        'what to do with the goods')));
    }
    if (Number(p.home) > 0) steps.push({ ...walk(Number(p.home)), always: true });
    return steps;
  },
};
