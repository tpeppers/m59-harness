// FILL THE PACK WITH ARROWS AT THE BOWMAKER'S HUT, STARTING AND ENDING IN KO'CATAN.
//
// Hanla zax'Ta (kcbowmak.kod) sells arrows in the Bowmaker's Hut, RID_JUNGLE_BOWMAKER_HUT =
// 2100, out in the jungle: Ko'catan -> East Guard Tower (2013) -> KA5 (2115) -> KA4 -> KA3 -> 2100.
// Her "Arrow x20" is a suggested quantity, not stock.
//
//   island-arrows agents=Pepe
//   island-arrows agents=t4,t5 keep=500 max=400 back=2000
//
// Per agent:
//   1. PLAN, in town, from the pack the character starts with (m59-carry.mjs, weights from the
//      kod): how many arrows fit under 1700 + might*20 on top of EVERYTHING it is carrying.
//   2. Walk to the tower and leave behind what the guard would refuse (m59-jungle-stash.mjs;
//      nothing, and no lock, for a character carrying only shillings and one weapon).
//   3. Walk to the hut and buy min(fit, purse - keep, max), journaled by buyCourierGoods. The
//      pack at the counter is lighter by whatever was stashed; the order is still sized from
//      step 1, so the space that was dropped is never filled with arrows.
//   4. ALWAYS, even after a failure: walk back to the tower, pick the stash up, re-equip, and
//      walk to `back`.
//   5. ALWAYS: weigh the pack again and WARN when it is under `warnBelow` (70%) of a full load,
//      the worse of weight and bulk — a trip the purse or `max` cut short.
//
// Arrows are Ammo, not Weapon (arrow.kod), so a pack full of them passes the guard either way,
// and nobody is checked coming back in. A run that dies before picking its stash up leaves a
// receipt; the next run for that agent picks the stash up and does nothing else.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { walk, verify } from '../m59-fleetscript.mjs';
import { buyCourierGoods } from '../m59-courier-purchases.mjs';
import { fillPlan, afterBuying, loadOf, maxFrom, pct } from '../m59-carry.mjs';
import { GUARD_TOWER, STASH_DIR, stashForJungle, recoverJungleStash, stashOwed } from '../m59-jungle-stash.mjs';

const HUT = 2100, SELLER = "Hanla zax'Ta", TOWN = 2000;
const isArrow = name => /^arrows?$/i.test(String(name ?? '').trim());
const isCash = name => /^shillings?$/i.test(String(name ?? '').trim());
const sum = (items, test) => items.filter(i => test(i.name)).reduce((n, i) => n + (i.amount > 0 ? i.amount : 1), 0);
const onIsland = room => room >= 2000 && room < 2100;   // Ko'catan and its buildings
export const receiptFile = agent => resolve(STASH_DIR, `${String(agent).replace(/[^a-z0-9_-]/gi, '_')}-arrows-pending.json`);

export const script = {
  name: 'island-arrows',
  describe: "From Ko'catan, walk to the Bowmaker's Hut and buy as many arrows as the character's starting pack has room for, stashing and recovering whatever the East Tower guard refuses.",
  recipe: {
    effect: 'Each agent comes home carrying as many more arrows as its whole starting pack has room for (or its purse allows), with everything it set out with.',
    run: 'island-arrows agents=<a,b> [keep=0] [max=0] [back=2000] [warnBelow=0.7]',
    needs: ["start in Ko'catan (2000-2099)", 'shillings in the purse', 'a pack whose every item is in the weight table'],
    cost: { money: 'the arrows', time: 'the jungle walk to the hut and back', risk: 'KA5-KA3 are monster rooms' },
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'who buys; each fills its own pack' },
    keep: { type: 'number', default: 0, min: 0, describe: 'shillings each agent keeps back' },
    max: { type: 'number', default: 0, min: 0, describe: 'cap on arrows per agent (0: no cap beyond pack and purse)' },
    back: { type: 'room', default: TOWN, describe: "where to finish (2000 is Ko'catan)" },
    warnBelow: { type: 'number', default: 0.7, min: 0, max: 1, describe: 'warn when the pack ends under this fraction of a full load' },
    queueMin: { type: 'number', default: 60, min: 1, max: 240, describe: 'how long to wait for the stash spot while another traveller holds it' },
    minHealth: { type: 'number', default: 1 },
    fragileBelow: { type: 'number', default: 20 },
  },

  async steps(p) {
    const agent = p.agent;
    const keep = Math.max(0, Math.trunc(Number(p.keep) || 0));
    const cap = Math.max(0, Math.trunc(Number(p.max) || 0)) || Infinity;
    const back = Number(p.back ?? TOWN) || 0;
    const warnBelow = Number.isFinite(Number(p.warnBelow)) ? Number(p.warnBelow) : 0.7;
    const file = receiptFile(agent);
    mkdirSync(dirname(file), { recursive: true });
    let record = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    const save = () => writeFileSync(file, JSON.stringify(record, null, 2));
    const finishBack = back > 0 ? [{ ...walk(back, { why: 'home' }), always: true }] : [];
    const unstash = { ...verify(async ctx => { await recoverJungleStash(ctx, { record, save }); return true; },
      'stash picked up at the tower'), always: true };

    // A STASH FROM AN EARLIER RUN IS STILL ON THE TOWER FLOOR: fetch it, and do nothing else.
    if (record && !record.complete && stashOwed(record)) {
      record.receipt = file;
      return [walk(GUARD_TOWER, { why: 'pick up the stash an earlier run left' }), unstash,
              { ...verify(() => { record.complete = !stashOwed(record); save();
                  return { ok: false, why: 'recovered an earlier stash; run again to buy' }; }, 'recovery only'), always: true },
              ...finishBack];
    }
    record = { format: 'm59-island-arrows/1', at: new Date().toISOString(), agent, receipt: file, complete: false };

    return [
      verify(async ({ call }) => {
        const look = await call('look', { agent }, 30_000);
        if (!onIsland(look?.room?.num)) return { ok: false, why: `start in Ko'catan; ${agent} is in ${look?.room?.num ?? '?'}` };
        const inv = await call('inventory', { agent }, 60_000);
        if (!Array.isArray(inv?.items)) return { ok: false, why: 'could not read the pack' };
        const plan = fillPlan({ items: inv.items, max: maxFrom({ carry: inv.carry }), item: 'arrows', cap, warnBelow });
        record.start = { room: look.room.num, items: inv.items.map(i => ({ name: i.name, amount: i.amount })),
                         load: plan.load, max: plan.max, purse: sum(inv.items, isCash), arrows: sum(inv.items, isArrow) };
        record.plan = { fit: plan.fit, why: plan.why ?? null };
        save();
        if (plan.fit == null) return { ok: false, why: `nothing planned: ${plan.why}` };
        console.log(`  ${agent}: starting load ${plan.load.weight}w/${plan.load.bulk}b of ${plan.max}; room for ${plan.fit} arrows` +
          ` (a full fill would be ${pct(afterBuying(plan, plan.fit).fullness_after)})`);
        if (plan.fit < 1) return { ok: false, why: 'the starting pack has no room for even one arrow' };
        if (record.start.purse <= keep) return { ok: false, why: `${record.start.purse}sh in the purse, keep=${keep}` };
        return true;
      }, 'plan from the starting pack'),
      walk(GUARD_TOWER, { why: 'the East Tower, to pass the guard' }),
      verify(async ctx => {
        const s = await stashForJungle(ctx, { record, save, queueBudgetMs: Math.round((Number(p.queueMin) || 60) * 60_000) });
        console.log(`  ${agent}: ` + (s.items.length ? `stashed ${s.items.map(i => i.name).join(', ')} at the tower` : 'nothing for the guard to refuse'));
        return true;
      }, 'stash what the guard refuses'),
      walk(HUT, { why: `${SELLER}: arrows` }),
      verify(async ctx => {
        const inv = await ctx.call('inventory', { agent }, 60_000);
        const menu = await ctx.call('shop', { agent, seller: SELLER }, 60_000);
        const row = menu?.items?.find(i => isArrow(i.name));
        if (!(row?.cost > 0)) return { ok: false, why: `${SELLER} quoted no arrows` };
        // Sized from the STARTING pack; only the purse is read now.
        const plan = fillPlan({ items: record.start.items, max: record.start.max, item: 'arrows',
                                unitCost: row.cost, purse: sum(inv?.items ?? [], isCash), keep, cap, warnBelow });
        record.order = { unit_cost: row.cost, fit: plan.fit, afford: plan.afford, amount: plan.amount, limited_by: plan.limited_by };
        save();
        if (plan.amount < 1) return { ok: false, why: `nothing to buy (${plan.limited_by.join('+')})` };
        const r = await buyCourierGoods(ctx, { seller: SELLER, item: 'arrow', aliases: ['arrows'], amount: plan.amount });
        record.purchase = { status: r.status, quantity: r.quantity ?? 0, spent: r.spent ?? 0, limited_by: r.limited_by ?? [] };
        save();
        console.log(`  ${agent}: ordered ${plan.amount} at ${row.cost}sh (limited by ${plan.limited_by.join('+')}); ` +
          `${r.status} +${r.quantity ?? 0} for ${r.spent ?? 0}sh`);
        return r.status === 'confirmed' ? true
          : { ok: false, why: `purchase ${r.status}` + (r.error ? `: ${r.error}` : '') +
              (r.pending_previous ? ` — earlier purchase unresolved in ${r.pending_previous.file}` : '') };
      }, 'arrows for the starting pack'),
      // Through the tower only when a stash is owed: a plan that fails in town stays in town.
      { ...walk(() => stashOwed(record) || !back ? GUARD_TOWER : back,
                { candidates: [GUARD_TOWER, ...(back ? [back] : [])], why: 'back through the tower for the stash' }), always: true },
      unstash,
      ...finishBack,
      { ...verify(async ({ call }) => {
        const inv = await call('inventory', { agent }, 60_000);
        const items = Array.isArray(inv?.items) ? inv.items : [];
        const load = loadOf(items), max = record.start?.max;
        const full = max ? Math.max(load.weight, load.bulk) / max : null;
        const gained = sum(items, isArrow) - (record.start?.arrows ?? 0);
        Object.assign(record, { end: { load, fullness: full, arrows_gained: gained }, complete: !stashOwed(record) });
        save();
        const warn = full != null && full < warnBelow;
        console.log(`  ${agent}: +${gained} arrows; carrying ${load.weight}w/${load.bulk}b of ${max ?? '?'} = ${full != null ? pct(full) : '?'}` +
          (load.exact ? '' : ' (lower bound)') +
          (warn ? `  WARNING: under ${pct(warnBelow)} of a full load` +
                  (record.order?.limited_by?.length ? ` — limited by ${record.order.limited_by.join('+')}` : '') : ''));
        if (stashOwed(record)) return { ok: false, why: `stash still on the tower floor at ${JSON.stringify(record.stash.position)}; receipt ${file}` };
        return true;
      }, 'weigh the pack home'), always: true },
    ];
  },
};
