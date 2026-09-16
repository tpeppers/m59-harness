// Keeper adapter for the reagent coop. Every transfer is serialized, based on
// fresh server contents, quantity-bounded, and confirmed on both sides.
import { mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { claimFleetLock } from './runtime/fleet-lock.mjs';
import { StorageCache, chestKey } from './m59-storage.mjs';
import { MARKET_KEEP, weighItem } from './m59-items.mjs';
import { inventorySalePlan, carryCapacity } from './m59-skills.mjs';
import { reagentFloorFor } from './m59-stockpile.mjs';
import { dropSpec } from './m59-parse.mjs';
import { hallPassword } from './m59-hallsecret.mjs';
import { guildPassage } from './m59-guild-passage.mjs';
import { NORTH_BARLOQUE, withGuildSecrecy } from './m59-guild-secrecy.mjs';
import { coopConfig, coopKey, coopCount, coopDepositPlan, coopTithePlan,
  coopFundingAmount, coopRemainingPlan } from './m59-reagent-coop.mjs';

const pending = reason => ({ pending: true, ready: false, reason });
const interrupted = k => k.travelInterrupted() || k.suspendedJourney ||
  (k.s.job?.kind === 'commerce:coop' && k.s.job.generation !== k.s.movementGeneration);
const inwardInterrupted = k => interrupted(k) || !!k.coopSecrecy?.blocked;
const room = k => Number(k.s.world?.room?.num);
const pack = k => k.packAsItems();
const sale = k => inventorySalePlan(k.s, { keep: MARKET_KEEP,
  protect: k.protectedItemNames(), loadout: k.loadout(),
  maxWeapons: k.policy.maxWeapons, weaponPriority: k.weaponPriorityNow() }).items.filter(i => i.queued)
  .map(i => ({ ...i, amount: i.sale_amount }));
const ownFloor = (k, name) => reagentFloorFor({ loadout: k.loadout(), policy: {
  reagentTarget: ['herb', 'elderberry'].includes(name) ? k.policy.reagentTarget : null } }, name);

async function inventory(k) {
  const c = k.s.need(), since = c.evSeq;
  await k.s.pacer.submit('read', () => c.requestInventory());
  const r = await c.waitFor({ since, kinds: ['inventory'], timeoutMs: 3500 });
  if (!r.events?.some(e => e.kind === 'inventory')) throw new Error('no fresh coop inventory');
}

async function approach(k, box) {
  if (interrupted(k)) throw new Error('coop paused for survival');
  const s = k.s, c = s.need(), me = c.self;
  // user.kod UserGet accepts Manhattan distance <= 7. Walking all the way
  // beside a chest unnecessarily attempts the raised chest platform.
  const inRange = p => Math.abs(p.row - box.row) + Math.abs(p.col - box.col) <= 7;
  if (inRange(me)) return;
  await guildPassage(k, 4, () => inwardInterrupted(k));
  const route = s.world.approachSquare(box.col, box.row);
  const at = route?.path?.find(inRange) ?? route;
  if (!at) throw new Error('no reachable approach to coop chest ' + box.slot);
  await s.walkTo(at.col, at.row, { maxSteps: 30, beforeMutation: () => {
    if (inwardInterrupted(k)) throw new Error(k.coopSecrecy?.blocked ?? 'coop paused for survival');
  } });
  if (interrupted(k) || !inRange(c.self))
    throw new Error(`coop chest ${box.slot} not reached`);
}

async function readBox(k, box, cfg) {
  if (room(k) !== cfg.hall_room) throw new Error('left the coop hall');
  const c = k.s.need(), since = c.evSeq;
  await k.s.pacer.submit('read', () => c.contents(box.id));
  const r = await c.waitFor({ since, kinds: ['container'], timeoutMs: 3500 });
  const reply = r.events?.find(e => e.kind === 'container' && e.id === box.id);
  if (!reply) throw new Error(`no fresh contents for coop chest ${box.slot}`);
  box.items = reply.items;
  new StorageCache({ dir: process.env.M59_STORAGE_DIR }).writeChest(box.slot, { object_id: box.id, room: cfg.hall_room,
    items: box.items, by: k.name ?? k.s.name });
  return box;
}

async function transfer(k, box, item, amount, direction, cfg, receipt) {
  if (!(amount > 0) || interrupted(k)) return 0;
  await approach(k, box);
  // Caller has just refreshed the source. Bare IDs are only for non-stackables.
  const spec = dropSpec(item, Math.min(amount, item.amount || 1));
  const name = coopKey(item.name ?? k.s.client.rsc.get(item.nameRsc));
  const beforePack = coopCount(pack(k), name), beforeBox = coopCount(box.items, name);
  const c = k.s.need();
  await k.s.pacer.submit('trade', () => direction === 'deposit'
    ? c.put(spec, box.id) : c.getFromContainer(spec));
  await inventory(k);
  await readBox(k, box, cfg);
  const sign = direction === 'deposit' ? 1 : -1;
  const fromPack = sign * (beforePack - coopCount(pack(k), name));
  const intoBox = sign * (coopCount(box.items, name) - beforeBox);
  const moved = Math.max(0, Math.min(fromPack, intoBox, amount));
  receipt({ direction, slot: box.slot, item: name, requested: amount, amount: moved,
    pack_delta: fromPack, chest_delta: intoBox });
  // An inconsistent receipt must not be retried from the old plan.
  if (fromPack !== intoBox || moved !== fromPack) throw new Error('coop transfer receipt disagrees');
  return moved;
}

async function transact(k, state, cfg, fleet) {
  await k.coopSecrecy?.fresh();
  const s = k.s, c = s.need();
  const dir = resolve(process.env.M59_COOP_DIR ?? 'substrate/stockpile'); mkdirSync(dir, { recursive: true });
  const stem = String(fleet).replace(/[^A-Za-z0-9_-]/g, '_');
  const lock = claimFleetLock(resolve(dir, `${stem}.coop.lock`), { subject: `reagent-coop:${stem}` });
  if (!lock.ok) return pending('another keeper is using the reagent coop');
  const receipt = entry => {
    const row = { at: Date.now(), agent: k.name ?? s.name, operation: state.mode, ...entry };
    appendFileSync(resolve(dir, `${stem}.coop.ndjson`), JSON.stringify(row) + '\n');
    k.note('reagent coop transfer', row);
  };
  try {
    const since = c.evSeq;
    await s.pacer.submit('read', () => c.roomContents());
    const r = await c.waitFor({ since, kinds: ['room-contents'], timeoutMs: 3500 });
    if (!r.events?.some(e => e.kind === 'room-contents')) throw new Error('no fresh guild room contents');
    const boxes = [...c.room.objects.values()].filter(o => /chest/i.test(c.rsc.get(o.nameRsc) ?? ''))
      .map(o => ({ ...o, slot: chestKey(o) }));
    if (cfg.chest_keys.some(key => !boxes.some(b => b.slot === key)) || boxes.some(b => !b.slot))
      throw new Error('could not identify every configured guild chest');
    // Include extra chests in the global cash cap, even if not selected for deposits.
    for (const b of boxes) await readBox(k, b, cfg);
    await inventory(k);
    if (['contribute', 'town'].includes(state.mode)) {
      for (const box of boxes.filter(b => cfg.chest_keys.includes(b.slot))) {
        await readBox(k, box, cfg);
        const planned = coopDepositPlan({ config: cfg, chests: [box], pack: pack(k),
          saleItems: sale(k), keepFloor: name => ownFloor(k, name) });
        for (const line of planned.plan) {
          let left = line.amount;
          for (const item of [...c.inventory].filter(i => coopKey(c.rsc.get(i.nameRsc)) === line.item)) {
            if (!left) break;
            await readBox(k, box, cfg);
            const current = coopDepositPlan({ config: cfg, chests: [box], pack: pack(k),
              saleItems: sale(k), keepFloor: name => ownFloor(k, name) }).plan.find(p => p.item === line.item);
            const amount = Math.min(left, item.amount || 1, current?.amount ?? 0);
            if (!amount) break;
            const moved = await transfer(k, box, item, amount, 'deposit', cfg, receipt);
            left -= moved;
            if (!moved) break;
          }
        }
      }
    } else if (state.mode === 'supply') {
      for (const box of boxes) {
        await readBox(k, box, cfg);
        const needed = [...state.result.plan.lines, ...state.result.plan.unpriced]
          .filter(l => cfg.reagents.includes(coopKey(l.item)) && l.amount > 0);
        for (const line of needed) {
          let left = line.amount;
          for (const item of [...box.items].filter(i => coopKey(i.name) === coopKey(line.item))) {
            const space = carryCapacity(c).room_for, unit = weighItem(line.item);
            const amount = space && unit ? Math.max(0, Math.min(left, item.amount ?? 1,
              Math.floor(space.weight / unit.weight), Math.floor(space.bulk / unit.bulk))) : 0;
            if (!amount) break;
            const moved = await transfer(k, box, item, amount, 'withdraw', cfg, receipt);
            if (!moved) break;
            const took = { item: line.item, amount: moved };
            state.result.took.push(took);
            state.result.plan = coopRemainingPlan(state.result.plan, [took]); left -= moved;
            if (!left) break;
          }
        }
      }
      state.cashBudget ??= coopFundingAmount(state.result.plan, k.purseNow(), cfg);
      for (const box of boxes) {
        await readBox(k, box, cfg);
        for (const item of [...box.items].filter(i => coopKey(i.name) === 'shilling')) {
          const need = Math.min(state.cashBudget - state.result.shillings,
            coopFundingAmount(state.result.plan, k.purseNow(), cfg));
          if (!need) break;
          state.result.shillings += await transfer(k, box, item, Math.min(need, item.amount ?? 1), 'withdraw', cfg, receipt);
        }
      }
    }
    if (['tithe', 'town'].includes(state.mode)) {
      // Re-read all chests immediately before deciding the global cap.
      for (const box of boxes) await readBox(k, box, cfg);
      const stored = boxes.reduce((n, b) => n + coopCount(b.items, 'shilling'), 0);
      const available = Math.max(0, k.purseNow() - state.keep);
      const target = coopTithePlan({ config: cfg, bankable: available, stored,
        target: state.target, paid: state.result.shillings });
      state.target = target.target;
      const box = boxes.find(b => cfg.chest_keys.includes(b.slot));
      await readBox(k, box, cfg);
      const money = c.inventory.find(i => coopKey(c.rsc.get(i.nameRsc)) === 'shilling');
      if (money && target.amount) state.result.shillings += await transfer(k, box, money,
        target.amount, 'deposit', cfg, receipt);
    }
    return { done: true };
  } finally { lock.release(); }
}

// Travel is resumable separately from transfers: a survival interruption on the
// return leg must never repeat a completed withdrawal or charge the tithe twice.
export async function runReagentCoop(k, mode, options = {}, fleet, journey = null) {
  if (k.coopRunning) return pending('reagent coop visit is already executing');
  k.coopRunning = true;
  try {
    const cfg = coopConfig(k.policy.reagentCoop);
    if (!cfg) return { plan: options.plan ?? null, skipped: true };
    return await withGuildSecrecy(k, cfg, () => executeCoop(k, mode, options, fleet, journey));
  }
  finally { k.coopRunning = false; }
}
async function executeCoop(k, mode, { plan = null, bankable = 0, requestId = null, nextRoom = null, first = false } = {}, fleet, journey = null) {
  const cfg = coopConfig(k.policy.reagentCoop);
  if (!cfg) return { plan, skipped: true };
  let state = k.coopVisit;
  if (!state) {
    const key = `${mode}:${requestId ?? k.townTrip?.startedAt ?? 'outside'}`;
    // Town retries are opportunities on the route to the NEXT business stop.
    // They never create a final detour after selling/vaulting is finished.
    if (mode === 'town' && !first && ![NORTH_BARLOQUE, cfg.hall_room].includes(room(k))) {
      const route = nextRoom == null ? null : k.s.world.route?.(Number(nextRoom));
      if (!route?.found || !route.hops.some(h => Number(h.to) === NORTH_BARLOQUE))
        return { deferred: true, skipped: true, reason: 'guild secrecy: no North Barloque passage before the next task' };
    }
    if (Date.now() < (k.coopAttempts?.[key] ?? 0)) return { plan, skipped: true };
    if (mode === 'supply' && ![...plan.lines, ...plan.unpriced].some(l => cfg.reagents.includes(coopKey(l.item))))
      return { plan, skipped: true };
    if (mode === 'tithe' && bankable <= 0) return { skipped: true };
    if (['contribute', 'town'].includes(mode) && !(mode === 'town' && bankable > 0) &&
        !sale(k).some(i => cfg.reagents.includes(coopKey(i.name)))) return { skipped: true };
    const c = k.s.need(), since = c.evSeq;
    await k.s.pacer.submit('read', () => c.requestGuildInfo());
    const membership = await c.waitFor({ since, kinds: ['guild'], timeoutMs: 3000 });
    if (!membership.events?.some(e => e.kind === 'guild' && e.what === 'roster') ||
        !c.guild?.id || !(c.guild.rank >= 2) || !hallPassword(fleet)) {
      (k.coopAttempts ??= {})[key] = Date.now() + cfg.retry_ms;
      k.note('reagent coop unavailable', { reason: 'guild rank or hall key unavailable' });
      return { plan, skipped: true };
    }
    state = k.coopVisit = { mode, key, origin: mode === 'town' ? NORTH_BARLOQUE : room(k), started: Date.now(), stage: 'outbound',
      keep: k.purseNow() - bankable, target: null,
      result: { plan, took: [], shillings: 0, moved: true } };
  }
  if (state.mode !== mode) {
    const previous = await executeCoop(k, state.mode, {}, fleet, journey);
    return previous.pending ? previous : pending('previous reagent coop visit completed; re-evaluate this order');
  }
  if (interrupted(k)) return pending('reagent coop paused for survival');
  if (state.stage === 'outbound') {
    k.doing = 'travelling';
    try {
      // Split at the public entrance so no journey can enter on a stale reading
      // taken back at a merchant. The scoped pacer refreshes throughout crossing.
      if (![NORTH_BARLOQUE, cfg.hall_room].includes(room(k))) {
        const approach = await (journey ?? k.travel.bind(k))(NORTH_BARLOQUE, { maxHops: 30 });
        if (!approach?.arrived) throw new Error(approach?.reason ?? 'North Barloque not reached');
      }
      await k.coopSecrecy.fresh();
      const r = room(k) === cfg.hall_room ? { arrived: true }
        : await (journey ?? k.travel.bind(k))(cfg.hall_room, { maxHops: 2 });
      if (!r?.arrived || room(k) !== cfg.hall_room) throw new Error(r?.reason ?? 'guild hall not reached');
      await k.coopSecrecy.fresh();
      state.stage = 'transfer';
    } catch (e) {
      if (interrupted(k) && !k.coopSecrecy.blocked) return pending('reagent coop paused for survival');
      state.result.reason = k.coopSecrecy.blocked ?? e.message;
      state.result.deferred = !!k.coopSecrecy.blocked;
      state.stage = 'return';
      // A secrecy refusal continues from the street; never march back to the
      // farm/shop where the deferred town opportunity was first scheduled.
      if (state.result.deferred && room(k) !== cfg.hall_room) state.origin = room(k);
    }
  }
  if (state.stage === 'transfer') {
    k.doing = 'trading';
    try {
      const r = await transact(k, state, cfg, fleet);
      if (r.pending && Date.now() - state.started < cfg.retry_ms) return r;
      if (r.pending) state.result.reason = r.reason;
    } catch (e) {
      state.result.reason = k.coopSecrecy?.blocked ?? e.message;
      state.result.deferred = !!k.coopSecrecy?.blocked;
      k.note('reagent coop visit could not transfer', { mode, reason: e.message,
        at: { row: k.s.client.self?.row, col: k.s.client.self?.col } });
    }
    state.stage = 'return';
  }
  if (state.result.deferred) state.origin = room(k) === cfg.hall_room ? NORTH_BARLOQUE : room(k);
  if (interrupted(k)) return pending('reagent coop return paused for survival');
  // Also return to the foyer when a keeper restarted inside the hall. Its
  // next ordinary journey cannot reopen the internal chest-room doors.
  if (room(k) === cfg.hall_room) {
    try { await guildPassage(k, 0, () => interrupted(k)); }
    catch (e) { k.note('reagent coop return waiting', { reason: e.message }); return pending(e.message); }
  }
  if (room(k) !== state.origin) {
    k.doing = 'travelling';
    const r = await (journey ?? k.travel.bind(k))(state.origin, { maxHops: 30 });
    if (!r?.arrived || room(k) !== state.origin) return pending('returning from reagent coop');
  }
  k.coopStatus = { at: Date.now(), mode, ...state.result };
  k.note('reagent coop visit completed', { mode, took: state.result.took,
    shillings: state.result.shillings, reason: state.result.reason });
  k.coopAttempts ??= {};
  k.coopAttempts[state.key] = ['tithe', 'town'].includes(mode) && k.townTrip && !state.result.reason
    ? Infinity : Date.now() + cfg.retry_ms;
  // Keep only the current trip and bounded retry history.
  for (const key of Object.keys(k.coopAttempts))
    if (key !== state.key && (k.coopAttempts[key] < Date.now() ||
        !key.endsWith(`:${k.townTrip?.startedAt ?? 'outside'}`))) delete k.coopAttempts[key];
  k.coopVisit = null;
  return state.result;
}

// DUM/FleetScript use the same coop through an idempotent background command.
// Polling the request does not issue another tithe. Survival stays active during
// travel; the ordinary keeper economy waits behind this session's job slot.
export function reagentCoopCommand(k, s, args, fleet) {
  const id = args.request_id, mode = args.action;
  if (typeof id !== 'string' || !id || id.length > 160 || !['contribute', 'supply', 'tithe', 'town'].includes(mode))
    throw new Error('reagent_coop needs action and a stable request_id');
  if (!k.policy.reagentCoop?.enabled) return { skipped: true, reason: 'reagent coop disabled' };
  if (k.coopRunning) return pending('reagent coop visit is already executing');
  const prior = k.coopCommand;
  if (prior?.id === id) {
    if (prior.mode !== mode) throw new Error('reagent coop request_id already used for another action');
    if (!prior.job.done) return pending('reagent coop command in progress');
    if (prior.job.error) return { error: prior.job.error };
    if (!prior.job.result?.pending) return prior.job.result;
  }
  if (s.job && !s.job.done) return pending(`waiting for ${s.job.label}`);
  const job = s.startJob('commerce:coop', `reagent coop ${mode}`, async movementGeneration => {
    let hold = null;
    const assertHold = () => {
      if (!k.inert && !k.travelInterrupted() && !k.suspendedJourney) {
        k.goTravelling(`reagent coop ${mode}`, { to: room(k) }); hold = k.inert;
      }
    };
    assertHold();
    const timer = setInterval(assertHold, 2000); timer.unref?.();
    try {
      return await runReagentCoop(k, mode, { requestId: id, nextRoom: args.next_room, first: args.first === true,
        plan: mode === 'supply' ? k.shoppingPlan({ kind: 'reagents' }) : null,
        bankable: Math.max(0, k.purseNow() - Math.max(Number(args.keep ?? 0),
          Number(k.policy.walkingMoney ?? 400), k.shoppingPlan().required_purse)),
      }, fleet, (to, opts) => k.travel(to, { ...opts, movementGeneration }));
    } finally {
      clearInterval(timer);
      if (hold && k.inert === hold) k.revive('reagent coop command paused or finished');
    }
  });
  k.coopCommand = { id, mode, job };
  return pending('reagent coop command started');
}
