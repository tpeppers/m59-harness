// #movement: ONE CHARACTER FROM ANYWHERE IN THE ORC PIT COMPLEX TO A GUILD HALL, AND DEPOSIT.
//
//   pit-to-hall agents=t17 items=orc%20pit%20boss%20head,plate%20armor
//   pit-to-hall agents=t17 items=orc%20pit%20boss%20head hall=713
//
// Starts in 2506, 2507 (north part or chamber side), 2508, 2509, 2510 or 2500-2505; resumes from
// wherever a previous run stopped (Ko'catan, the hall). Route and why: tools/m59-pit-to-hall.mjs.
// Each pit room is a fine walk to an approach point, then one hop: 2507/2508 north part -> 2506 ->
// 2509 -> 2500; then the cave chain (2502 and 2505 one body at a time) to Ko'catan; then the hall.
// A failure stops the run and names the step and the position; it never wanders.
//
// `items` are substrings the keeper matches against pack items that are NOT worn (hall_withdraw's
// `deposit`); a worn piece stays on.
import { act, verify, walk } from '../m59-fleetscript.mjs';
import { depositWithRecovery } from '../m59-hall-access.mjs';
import { ordinaryHop, admittedIslandTransit, topUpAtPool, withIslandSafeLegs } from '../m59-island-route.mjs';
import { checkedIslandWalk } from '../m59-island-finewalk.mjs';
import { walkOutOfPit, walkChainToIsland, pitToHallStart } from '../m59-pit-to-hall.mjs';

const roomOf = v => Number(v?.room?.num ?? v?.room);
const list = v => [].concat(v ?? []).flatMap(a => String(a).split(',')).map(s => s.trim()).filter(Boolean);

export const script = {
  name: 'pit-to-hall',
  describe: "One character from the orc pit complex (or the caves) to Ko'catan and a guild hall, depositing named items.",
  provenance: { pinned: '15627b2f', verified: '2026-11-15', refuseOnDrift: false,
    touches: ['tools/m59-pit-to-hall.mjs', 'tools/m59-orc-pit-exit.mjs', 'tools/m59-island-route.mjs',
      'tools/m59-island-finewalk.mjs', 'tools/m59-hall-access.mjs', 'tools/m59-fleetscript.mjs'] },
  recipe: {
    effect: 'The named items leave the pack for the hall chests.',
    run: 'pit-to-hall agents=<one> items=<name>,<name> [hall=713]',
    needs: ['one character in 2500-2510 (or already on Ko\'catan / in the hall)', 'membership of the hall\'s guild (rank sir+) or an ally'],
    cost: { time: 'about 20-40 minutes of cave walking', risk: 'cave monsters; the declared Hollows and Konima crossings need running vigor' },
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'exactly one character' },
    items: { type: 'string', required: true, describe: 'comma list of item-name substrings to deposit (URL-encode spaces as %20)' },
    hall: { type: 'room', default: 713, describe: 'the guild hall' },
    budgetMs: { type: 'number', default: 240_000, describe: 'per hop / per fine walk' },
  },
  async steps(p) {
    const team = list(p.agents);
    if (team.length !== 1) throw Error(`pit-to-hall takes exactly one agent, got ${team.length}`);
    const items = list(decodeURIComponent(String(p.items ?? '')));
    if (!items.length) throw Error('items= is required: comma list of item names to deposit');
    const hall = Number(p.hall) || 713, budgetMs = Number(p.budgetMs) || 240_000;
    const look = ctx => () => ctx.call('look', { agent: ctx.agent }, 30_000);
    const hop = ctx => to => (ctx.pitHop ?? (t => ordinaryHop(ctx, t, { budgetMs, maxHops: 1, recoverAtEntry: true })))(to);
    return [
      act('rest', { stand: true }),
      verify(async ctx => {
        const l = await look(ctx)().catch(() => null);
        const s = pitToHallStart(roomOf(l), Number(l?.you?.row), Number(l?.you?.col), hall);
        return s?.refuse ? { ok: false, why: `start: ${s.refuse}` } : { ok: true, start: s, at: `${roomOf(l)} r${l?.you?.row}c${l?.you?.col}` };
      }, 'start where this route goes'),
      verify(async ctx => {
        if (roomOf(await look(ctx)().catch(() => null)) === hall) return { ok: true, skipped: 'in the hall' };
        try {
          return await walkOutOfPit(ctx, { look: look(ctx), hop: hop(ctx),
            go: ctx.pitGo ?? (async () => { await ctx.call('rest', { agent: ctx.agent, stand: true }); await ctx.call('act', { agent: ctx.agent, verb: 'go' }); }),
            fineWalk: ctx.pitFineWalk ?? ((room, point, edgeTo) => checkedIslandWalk(ctx, point, { room, allowEdgeTo: edgeTo, budgetMs })) });
        } catch (e) { return { ok: false, why: e.message }; }
      }, 'out of the orc pit complex onto the cave chain'),
      verify(async ctx => {
        const here = roomOf(await look(ctx)().catch(() => null));
        if (here === hall) return { ok: true, skipped: 'in the hall' };
        const record = { legs: [] };
        try {
          return await withIslandSafeLegs(ctx, () => walkChainToIsland(ctx, { look: look(ctx), hop: hop(ctx),
            transit: ctx.pitTransit ?? ((from, room, to) => admittedIslandTransit(ctx, { from, room, to, budgetMs, onLeg: leg => record.legs.push(leg) })),
            onPool: () => topUpAtPool(ctx, record, () => {}, { budgetMs }) }), { required: false });
        } catch (e) { return { ok: false, why: e.message }; }
      }, "the cave chain to Ko'catan"),
      walk(hall, { why: 'the guild chests (a no-op if already there)' }),
      verify(async ({ agent, call }) => {
        const r = await depositWithRecovery(call, agent, items);
        console.log(`  ${agent}: deposit ${r.left ?? '?'} of ${r.before ?? '?'} in ${r.attempts} attempt(s)${r.why ? ` - ${String(r.why).slice(0, 160)}` : ''}`);
        return r.ok ? { ok: true, deposited: r.left, of: r.before } : { ok: false, why: `deposit in ${hall}: ${r.why}` };
      }, 'deposit in the hall chests'),
    ];
  },
};
