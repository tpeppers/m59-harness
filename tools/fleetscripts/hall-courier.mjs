// CARRY THE FARMERS' MAGIC TO THE GUILD CHESTS: collect in the room, deposit in the hall, walk home.
//
// PUBLIC. Operator, 2026-11-13: two karma-locked Shal'ille casters stand among the ~20 Great Ocean (552) farmers
// running a remove-curse desk, so the farmers may pick up unidentified weapons again -- and somebody has to carry what
// they pick up to the Second Swines hall (714) "as couriers carrying those magic items to the guild hall chests". This is
// that courier, written once so any character can run it for any room and any hall:
//
//   hall-courier agents=t2 from=room                       # everyone standing in the courier's room
//   hall-courier agents=t11 from=t4,t5,t9 hall=714 home=552 maxItems=6
//   hall-courier agents=t2 from=room items=ring,diamond     # name substrings instead of the weapon rule
//
// THE SHAPE, and every piece is one this repository already trusts:
//   COLLECT  for each farmer in the room, the hall-bound items in its pack (isHallBoundWeapon, the SAME rule the farm
//            town's own hall trip uses, m59-farm-town.mjs) -- never what it wears or wields, never an Amulet of Shadows
//            (the Shal'ille trainee's practice engine, never loot: shal3-courier.mjs goesToHall), never a stack -- handed
//            over with `supply` BY ID AND AMOUNT (a name alone hands over supply's default of two) and READ BACK off the
//            courier's own pack, because `supply` verifies the hand-over and the pack is still the evidence.
//   HALL     walk to the hall, then depositWithRecovery (m59-hall-access.mjs): the keeper walks the surveyed passage and
//            speaks the hall password, a passage refusal is retried once, and the pack says what left. Deposited BY ID
//            (`id:<n>`), re-read immediately before, so the courier's own long sword is never "a long sword".
//   HOME     walk back, `always`, so a refused deposit still brings the courier home to its post.
//
// Nothing collected and nothing hall-bound already carried: the run says so, and both walks are to the room the courier
// already stands in, which return at once. The farmers are never claimed or held: a hand-over is one `supply` per farmer, the same
// call shal3-courier.mjs makes, and every one of them keeps farming throughout.
import { walk, verify } from '../m59-fleetscript.mjs';
import { depositWithRecovery } from '../m59-hall-access.mjs';
import { isHallBoundWeapon } from '../m59-farm-town.mjs';
import { weaponScore } from '../m59-skills.mjs';
import { weighItem } from '../m59-items.mjs';

export const HALL_COURIER_DEFAULT_HALL = 714;
// The Shal'ille trainee's hospice and remove-curse engine. Never cargo, from anybody, under any selector.
export const NEVER_CARGO = /amulet of shadows/i;
const lc = s => String(s ?? '').trim().toLowerCase();
const isWeapon = name => weaponScore(String(name ?? '')) > 0;

/** `items=` as a list of lower-case name substrings; empty means the hall-bound weapon rule. */
export const parseSelector = v => String(v ?? '').split(',').map(lc).filter(Boolean);

/**
 * What of one pack goes to the hall: `[{ id, amount, name }]`, at most `maxItems` and `maxBulk` (bulk read from the item
 * table; an item it does not know counts as 0 bulk, which the item cap still bounds). Pure.
 *   inv       the `inventory` tool's reply: `{ items: [{ id, name, amount, rarity }], equipped: [names] }`
 *   names     parseSelector(items=); [] selects by isHallBoundWeapon
 * Worn or wielded items are excluded BY NAME: the inventory rows do not mark them, and the equipment tool's ids are
 * synthetic on a keeper-backed character, so a pack holding a second long sword beside the one in hand keeps both.
 */
export function hallCargo(inv, { names = [], maxItems = 8, maxBulk = Infinity, weigh = weighItem } = {}) {
  const worn = new Set((inv?.equipped ?? []).map(e => lc(typeof e === 'string' ? e : e?.name)));
  const out = [];
  let bulk = 0;
  for (const o of inv?.items ?? []) {
    if (out.length >= maxItems) break;
    const name = String(o?.name ?? '');
    if (!name || !(Number(o?.id) > 0) || NEVER_CARGO.test(name) || worn.has(lc(name))) continue;
    const ok = names.length
      ? names.some(n => lc(name).includes(n))
      : isHallBoundWeapon({ o, name, isWeapon });
    if (!ok) continue;
    const amount = Math.max(1, Number(o.amount) || 1);
    const b = (Number(weigh(name)?.bulk) || 0) * amount;
    if (bulk + b > maxBulk) continue;
    bulk += b;
    out.push({ id: Number(o.id), amount, name });
  }
  return out;
}

/** How many of each name a pack holds (an unstackable item is reported as amount 0, meaning one). */
export const countByName = inv => (inv?.items ?? []).reduce((m, o) => {
  const k = lc(o?.name);
  if (k) m.set(k, (m.get(k) ?? 0) + (Number(o.amount) || 1));
  return m;
}, new Map());

/** The farmers to collect from: named agents, or every fleet row in `room` but the courier. Pure over the `fleet` reply. */
export function collectFrom(rows, { from = 'room', courier, room } = {}) {
  const live = r => r?.agent && r.agent !== courier && r.in_game !== false && r.piloted !== true;
  if (lc(from) === 'room' || !String(from ?? '').trim())
    return (rows ?? []).filter(r => live(r) && Number(r.room_num) === Number(room)).map(r => r.agent);
  const named = String(from).split(',').map(s => s.trim()).filter(Boolean);
  return named.filter(a => a !== courier && (rows ?? []).some(r => r.agent === a && live(r) && Number(r.room_num) === Number(room)));
}

/**
 * One farmer's hand-over, verified: `supply` by id and amount, then the courier's pack read back. Never throws.
 *   -> { farmer, asked: n, arrived: n, why }
 */
export async function collectOne(call, { courier, farmer, names = [], maxItems = 8, maxBulk = Infinity }) {
  const inv = await call('inventory', { agent: farmer }, 60_000).catch(() => null);
  if (!inv?.items) return { farmer, asked: 0, arrived: 0, why: 'could not read the farmer\'s pack' };
  const cargo = hallCargo(inv, { names, maxItems, maxBulk });
  if (!cargo.length) return { farmer, asked: 0, arrived: 0, why: null };
  const before = countByName(await call('inventory', { agent: courier }, 60_000).catch(() => null));
  const r = await call('supply', { from: farmer, to: courier, who_travels: 'neither', ids_as_of: inv.ids_as_of,
    what: cargo }, 180_000).catch(e => ({ error: e?.message ?? String(e) }));
  const after = countByName(await call('inventory', { agent: courier }, 60_000).catch(() => null));
  const asked = cargo.reduce((n, x) => n + x.amount, 0);
  const arrived = [...new Set(cargo.map(x => lc(x.name)))]
    .reduce((n, k) => n + Math.max(0, (after.get(k) ?? 0) - (before.get(k) ?? 0)), 0);
  return { farmer, asked, arrived: Math.min(arrived, asked),
           why: r?.error ?? (arrived ? null : (r?.why ?? 'nothing arrived in the courier\'s pack')) };
}

export const script = {
  name: 'hall-courier',
  describe: 'Collect hall-bound magic items from farmers in the room (verified hand-over), deposit them in the guild hall chests, walk home.',
  // GUARANTEE 9. What this errand leans on: the hand-over, the hall passage and deposit, and the rule for what is hall-bound.
  provenance: {
    pinned: '0eb0a7ab', verified: '2026-11-12',
    touches: ['tools/m59-hall-access.mjs', 'tools/m59-farm-town.mjs', 'tools/m59-fleetscript.mjs'],
  },
  recipe: {
    effect: 'The farmers\' unidentified and magic weapons (or the named items) are in the guild chests, and the courier is home.',
    run: 'hall-courier agents=<courier> from=room hall=714',
    needs: ['the courier is a guild member the hall door admits (the keeper speaks the password)',
            'farmers standing in the courier\'s room, in game and not piloted'],
    cost: { time: 'a hand-over a farmer (~10 s), the road to the hall and back', risk: 'the road; the keeper\'s survival stays armed' },
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'the courier (one character a run)' },
    from: { type: 'string', default: 'room', describe: '"room" (every fleet-mate in the courier\'s room) or a comma list of farmer agents' },
    hall: { type: 'number', default: HALL_COURIER_DEFAULT_HALL, describe: 'the guild hall room' },
    home: { type: 'number', default: 0, describe: 'where to end; 0 = the room the courier started in' },
    items: { type: 'string', default: '', describe: 'comma list of name substrings; empty = hall-bound weapons (isHallBoundWeapon)' },
    maxItems: { type: 'number', default: 8, describe: 'items to carry in one run, all farmers together' },
    maxBulk: { type: 'number', default: 600, describe: 'bulk to carry in one run (item table bulk)' },
    minCargo: { type: 'number', default: 1, describe: 'skip the hall walk unless at least this many items are carried' },
  },
  async steps(p, state = {}) {
    const agent = p.agent, hall = Number(p.hall) || HALL_COURIER_DEFAULT_HALL;
    const start = Number(state?.startRoom);
    const home = Number(p.home) > 0 ? Number(p.home) : Number.isFinite(start) && start > 0 ? start : null;
    const names = parseSelector(p.items);
    const go = st => (st?.cargo ?? 0) >= Math.max(1, Number(p.minCargo) || 1);
    const steps = [
      verify(async ({ call, state: st }) => {
        const status = await call('status', { agent }, 30_000).catch(() => null);
        const room = Number(status?.room?.num ?? status?.room_num);
        const rows = (await call('fleet', {}, 60_000).catch(() => null))?.fleet ?? [];
        const farmers = collectFrom(rows, { from: p.from, courier: agent, room });
        let left = Math.max(0, Number(p.maxItems) || 0), got = 0;
        const report = [];
        for (const farmer of farmers) {
          if (left <= 0) break;
          const r = await collectOne(call, { courier: agent, farmer, names, maxItems: left,
                                             maxBulk: Number(p.maxBulk) > 0 ? Number(p.maxBulk) : Infinity });
          if (r.asked) report.push(`${farmer} ${r.arrived}/${r.asked}${r.why ? ` (${r.why})` : ''}`);
          got += r.arrived; left -= r.arrived;
        }
        // WHAT GOES IN is what the courier now carries, whoever handed it over, this run or an earlier one.
        const mine = hallCargo(await call('inventory', { agent }, 60_000).catch(() => null), { names, maxItems: 1000 });
        st.cargo = mine.length; st.here = Number.isFinite(room) ? room : null;
        console.log(`  ${agent}: collected ${got} from ${farmers.length} farmer(s) in ${room}` +
                    (report.length ? ` [${report.join('; ')}]` : '') + `; carrying ${mine.length} for the hall`);
        return true;
      }, 'collect the hall-bound items from the farmers, read back off the courier\'s pack'),
      // Nothing to carry: a walk to where the courier already stands, which returns at once.
      { ...walk(st => (go(st) ? hall : st.here), { candidates: [hall], why: 'the guild hall' }), optional: true },
      { ...verify(async ({ call, state: st }) => {
        if (!go(st)) return true;
        // Re-read immediately before: an id is a handle, and a deposit by name would take the courier's own gear too.
        const now = hallCargo(await call('inventory', { agent }, 60_000).catch(() => null), { names, maxItems: 1000 });
        if (!now.length) return true;
        const d = await depositWithRecovery(call, agent, now.map(x => `id:${x.id}`));
        st.deposited = d.left ?? 0;
        console.log(`  ${agent}: deposited ${d.left ?? '?'} of ${now.length} into the chests in ${d.attempts} attempt(s)` + (d.why ? ` -- ${d.why}` : ''));
        return d.ok ? true : { ok: false, why: `hall deposit: ${d.why}` };
      }, 'deposit into the hall chests, read back off the pack'), optional: true },
    ];
    if (home != null) steps.push({ ...walk(home, { why: 'home: a no-op when the hall walk never left' }), always: true });
    return steps;
  },
};
