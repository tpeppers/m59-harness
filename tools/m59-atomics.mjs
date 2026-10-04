#!/usr/bin/env node
// m59-atomics.mjs -- shared atomic keeper operations for the GOAP planner and
// the behavior tree.
//
// The GOAP supervisor (m59-goap.mjs) and the behavior tree action nodes
// (m59-bt-nodes.mjs) both need the same primitive operations -- revive, stop,
// travel, set policy, pick prey, buy a weapon. Before this file each side
// implemented them against its own mechanism (GOAP over broker MCP tools via
// HTTP, the BT against in-process keeper methods), which meant two copies of
// every operation that could drift. This module is the single copy: an atomic
// is one primitive operation, declared with the world-state field it changes
// (`effect`), and reached through a small DRIVER that supplies the mechanism
// for the context it runs in.
//
//   - brokerDriver(baseURL)  -- GOAP: verbs call broker MCP tools over HTTP.
//   - keeperDriver(keeper)   -- BT:  verbs call in-process keeper methods.
//
// Atomics are invoked as   runAtomic(name, ctx, params)   and each returns a
// Promise. The BT action nodes wrap that promise in their RUNNING/slot pattern
// (kick it off, report status on a later tick); GOAP just awaits it.
//
// No broker, no autopilot, no client imports -- pure, so it is testable offline
// against mock drivers. HTTP (fetch) is only ever touched at call time inside
// brokerDriver, never at module load.

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

// Broker driver: every verb issues a broker MCP tool call over HTTP. `agent`
// names the roster slot the tool operates on. `callTool` is the low-level
// JSON-RPC sender; it defaults to one that hits `baseURL`, but callers can pass
// their own (the GOAP file already has one with the same shape) so there is a
// single HTTP implementation per process.
export function brokerDriver(baseURL, callTool) {
  const tool = callTool || ((name, args) => _httpTool(baseURL, name, args));
  return {
    // autopilot stop / revive / set
    stop:      (agent, why)        => tool('autopilot', { agent, action: 'stop',  why }),
    revive:    (agent, why)        => tool('autopilot', { agent, action: 'revive', why }),
    setPolicy: (agent, fields)     => tool('autopilot', { agent, action: 'set', ...fields }),
    // travel: returns { arrived }
    travel:    (agent, to)         => tool('travel',    { agent, to }),
    // read-only queries
    pickPrey:  (agent, { goals, karma, under } = {}) => tool('prey', { agent, goals, ...(karma ? { karma } : {}), ...(under != null ? { under } : {}) }),
    who:       (agent)             => tool('who',      { agent }),
    // inn claim / release
    claimInn:  (agent, character)  => tool('autopilot', { agent, action: 'park', why: `resting ${character ?? ''}`.trim() }),
    // skill purchasing: returns { results: [ { queued, ability, price, reason } ] }
    buySkills: (agents)            => tool('buy_next_planned_skills', { agents }),
    // leave the newbie zone (Raza)
    leaveRaza: (agent)             => tool('leave_raza', { agent }),
    // Arm-errand primitives. These are the pieces the old m59-outfit.mjs monolith
    // did in one 8-step function; each is one tool call with one effect.
    purse:  (agent)                => tool('inventory', { agent }),
    bank:   (agent, action, amount)=> tool('bank', { agent, action, ...(amount != null ? { amount } : {}) }),
    sellAll:(agent, merchant, keep)=> tool('sell_all', { agent, merchant, ...(keep ? { keep } : {}) }),
    shop:   (agent, seller, buyIds)=> tool('shop', { agent, seller, ...(buyIds ? { buy_ids: buyIds } : {}) }),
    // Ownership protocol: claim a faculty lease, declare an in-flight op, release.
    // These are what make "one owner at a time" real -- see armOwnership below.
    claim:   (agent, faculties, by, leaseMs) => tool('autopilot', { agent, action: 'claim', faculties, by, lease_ms: leaseMs }),
    heartbeat: (agent, by, leaseMs)          => tool('autopilot', { agent, action: 'heartbeat', by, lease_ms: leaseMs }),
    setBusy:   (agent, by, kind, label, leaseMs) => tool('autopilot', { agent, action: 'busy', by, kind, label, lease_ms: leaseMs }),
    freeBusy:  (agent, by)                     => tool('autopilot', { agent, action: 'free', by }),
    yield:     (agent, by)                     => tool('autopilot', { agent, action: 'yield', by }),
  };
}

// Keeper driver: every verb calls an in-process keeper method on the keeper
// that is already bound to its own character, so `agent` is ignored. Methods
// are guarded on existence so a mock keeper in a unit test only needs to
// implement the verbs it is asked for. The BT currently exercises only the
// weapon atomics; the rest exist for the travel/revive nodes that come next.
export function keeperDriver(keeper) {
  const k = keeper || {};
  return {
    stop:   (_agent, why)  => typeof k.stop === 'function' ? k.stop(why) : Promise.resolve(false),
    revive: (_agent, why)  => typeof k.revive === 'function' ? k.revive(why) : Promise.resolve(false),
    travel: (_agent, to)   => typeof k.travel === 'function' ? k.travel(to, { origin: keeperOrigin('atomics') }) : Promise.resolve(false),
    setPolicy: (_agent, fields) => {
      // The BT executes strategy; GOAP decides it. Mutating the keeper's live
      // policy object is the in-process analog of `autopilot set`. Guarded: a
      // keeper without a policy object cannot take one.
      if (k.policy && fields) Object.assign(k.policy, fields);
      return Promise.resolve(true);
    },
    pickPrey: (_agent, { goals, karma } = {}) => Promise.resolve({ candidates: [] }),
    who:   (_agent) => Promise.resolve({ here: [] }),
    claimInn: (_agent, _character) => Promise.resolve(false),
    buySkills: (_agents) => Promise.resolve({ results: [] }),
    leaveRaza: (_agent) => Promise.resolve(false),
    // The weapon atomics the get_armed subtree currently exercises.
    equipBest: (_agent, why) => typeof k.armSelf === 'function'
      ? k.armSelf(why)
      : (typeof k.equipBest === 'function' ? k.equipBest() : Promise.resolve(false)),
    conjureWeapon: (_agent, why) => typeof k.makeWeapon === 'function'
      ? k.makeWeapon(why) : Promise.resolve(false),
    buyWeapon: (_agent, why) => typeof k.buyWeaponsAtNearestSmith === 'function'
      ? k.buyWeaponsAtNearestSmith({ why }) : Promise.resolve(false),
    // Arm-errand primitives, in-process. The keeper reads its own purse from the
    // live client rather than over the wire; bank/sell/shop fall back to the
    // methods that already exist so a mock only implements what a test asks for.
    purse:   (_agent) => (k.client && typeof k.client.inventory === 'object'
      ? Promise.resolve({ items: k.client.inventory }) : Promise.resolve({ items: [] })),
    bank:    (_agent, action, amount) => typeof k.bank === 'function'
      ? k.bank(action, amount) : Promise.resolve(null),
    sellAll: (_agent, merchant, keep) => typeof k.sellAll === 'function'
      ? k.sellAll(merchant, keep) : Promise.resolve(null),
    shop:    (_agent, seller, buyIds) => typeof k.shop === 'function'
      ? k.shop(seller, buyIds) : Promise.resolve(null),
    // In-process: the keeper owns its own character, so claiming is a no-op that still
    // lets a test observe the full protocol. Real leasing happens over the broker
    // driver, where an external process drives somebody else's character.
    claim:     () => Promise.resolve({ ok: true }),
    heartbeat: () => Promise.resolve({ ok: true }),
    setBusy:   (_agent, by, kind, label) => Promise.resolve({ busy: { by, kind, label } }),
    freeBusy:  () => Promise.resolve({ ok: true }),
    yield:     () => Promise.resolve({ ok: true }),
  };
}

// Default HTTP tool for brokerDriver when no callTool is supplied.
async function _httpTool(baseURL, name, args) {
  const r = await fetch(baseURL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                           params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
  const text = j.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Which inn a town trip should aim for. Rooms west of 400 (Ileria/Barloque/Tos
// side) go to Tos inn 52, east (Jasper side) to Jasper inn 370. This rule is
// duplicated across four GOAP town-trip actions; it lives here so it has one
// home, exactly as the effect discipline does.
export function innDest(room) {
  return (room ?? 0) < 400 ? 52 : 370;
}

// Bounded call: a hung tool call must not hang the errand forever. The old
// m59-outfit.mjs had no timeout on any HTTP call, so one stuck shop call left a
// character driven and inert with a child process that never returned. Every
// arm-errand atom goes through this, so the worst case is a reported failure,
// not a hang.
async function _bounded(fn, ms = 20000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out')), ms); }),
    ]).catch(e => ({ __timedOut: true, message: e.message }));
  } finally { clearTimeout(timer); }        // do not leak the timer into the errand
}

// Composite: stop the keeper, travel to `to`, revive it. The five GOAP town-trip
// actions all do exactly this triple; collapsing them here is the point of the
// shared layer. Returns { arrived } from the travel call.
export async function relocateThenRevive(ctx, { agent, to, stopWhy, reviveWhy }) {
  await ctx.stop(agent, stopWhy);
  const result = await ctx.travel(agent, to);
  await ctx.revive(agent, reviveWhy);
  return result;
}

// ---------------------------------------------------------------------------
// armOwnership -- ONE OWNER AT A TIME.
//
// This is the missing piece that let the keeper, GOAP and the BT each spawn an
// outfit errand for the same character and walk it to two shops at once. The
// broker already has the lease machinery (claim / heartbeat / busy / free), and
// GOAP already refuses to drive a character whose `busyErrand` is set -- but the
// arm errand never declared itself busy, so the guard had nothing to see.
//
// armOwnership wraps the errand in the protocol that makes the guard work:
//   claim  movement+work from the keeper (lease fails BACK to the keeper, so a
//          driver that dies returns the character to the thing that keeps it alive)
//   busy   declare the op in-flight, which is what GOAP's `busyErrand` reads
//   ...run the errand, heartbeating to keep the lease alive...
//   free   release the busy flag
//   yield  give the faculties back to the keeper
//
// The `by` id is the owner. Two concurrent errands use different `by` ids; the
// second claim is refused (the first lease is still held) and run() is never
// called -- so only one ever drives the character. That is the guard, in code.
export async function armOwnership(ctx, { agent, by, kind = 'arm', label = 'arming',
                                           leaseMs = 120_000, heartbeatMs = 60_000, run }) {
  const claim = await _bounded(() => ctx.claim(agent, ['movement', 'work'], by, leaseMs));
  if (claim?.__error || claim?.error || (claim && claim.ok === false)) {
    // Somebody else holds this character. Not our fight -- GOAP or the other
    // errand is already doing it. Report, do not drive.
    return { ran: false, refused: (claim && (claim.error || claim.reason)) || 'claimed by another' };
  }
  await _bounded(() => ctx.setBusy(agent, by, kind, label, leaseMs));

  // Keep the lease alive for as long as the errand runs. If the process dies, the
  // lease lapses and the keeper takes the character back -- no permanent hold.
  const beat = setInterval(() => {
    ctx.heartbeat?.(agent, by, leaseMs).catch(() => {});
  }, heartbeatMs);
  if (beat.unref) beat.unref();

  try {
    const result = await run();
    return { ran: true, result };
  } finally {
    clearInterval(beat);
    await _bounded(() => ctx.freeBusy(agent, by)).catch(() => {});
    await _bounded(() => ctx.yield(agent, by)).catch(() => {});
  }
}

import { RAZA_ROOMS } from './m59-errandstate.mjs';
import { keeperOrigin } from './m59-move-origin.mjs';

// ---------------------------------------------------------------------------
// The atomic registry
// ---------------------------------------------------------------------------
//
// Each atomic is { effect, run(ctx, params) }. `effect` names the world-state
// field(s) the atomic moves forward -- the same answer GOAP's cycle-guard and
// the BT's docs read, so monotonicity has one source. Params are per-atomic.

const ATOMICS = {
  // revive_keeper: un-inert the keeper. effect: inert=false.
  revive_keeper: {
    effect: 'inert=false',
    pre: [], effects: ['keeper_running'],
    run: (ctx, { agent, why }) => ctx.revive(agent, why),
  },
  // stop_keeper: soft-stop (goInert). effect: inert=true. An intermediate of
  // the relocate composite, not a standalone plan step.
  stop_keeper: {
    effect: 'inert=true',
    pre: ['keeper_running'], effects: ['!keeper_running'],
    run: (ctx, { agent, why }) => ctx.stop(agent, why),
  },
  // travel_to: move to a room. effect: room=to, health non-null once readable.
  travel_to: {
    effect: 'room=to, health readable',
    // PARAMETERISED -- see errandAction(). Statically it promises NOTHING, because
    // where this verb leaves you is entirely in `to`.
    pre: [], effects: [],
    run: (ctx, { agent, to }) => ctx.travel(agent, to),
  },
  // set_policy: write hunt/assigned_room/purpose/goals. effect: those fields.
  set_policy: {
    effect: 'hunt/assigned_room/purpose/goals set',
    // PARAMETERISED -- see errandAction(). And note what it does NOT establish:
    // writing assigned_room moves the TARGET, never the character, so it can never
    // satisfy at_assigned_room. Declaring that it did would let the planner 'arrive'
    // anywhere by writing a number.
    pre: [], effects: [],
    run: (ctx, { agent, fields }) => ctx.setPolicy(agent, fields),
  },
  // pick_prey: read prey candidates (respecting karma). effect: none (query).
  pick_prey: {
    effect: 'none (query)',
    pre: [], effects: [],
    run: (ctx, { agent, goals, karma, under }) => ctx.pickPrey(agent, { goals, karma, under }),
  },
  // claim_inn: park at an inn to rest. effect: parked_at_inn=true.
  claim_inn: {
    effect: 'parked_at_inn=true',
    // No errand symbol says 'parked'. Rather than invent one for a single verb, this
    // declares nothing: an unplannable verb is honest, an invented symbol is not.
    pre: [], effects: [],
    run: (ctx, { agent, character }) => ctx.claimInn(agent, character),
  },
  // buy_skills: queue next planned skill purchase. effect: nextSkillCost
  // advances, totalFunds drops.
  buy_skills: {
    effect: 'nextSkillCost advances, totalFunds drops',
    pre: ['funded', 'out_of_raza'], effects: [],
    run: (ctx, { agents }) => ctx.buySkills(agents),
  },
  // leave_raza: walk out of the newbie zone. effect: room outside 1011-1018.
  leave_raza: {
    effect: 'room outside 1011-1018',
    pre: [], effects: ['out_of_raza'],
    run: (ctx, { agent }) => ctx.leaveRaza(agent),
  },
  // who_in_room: read the room's occupants. effect: none (query).
  who_in_room: {
    effect: 'none (query)',
    pre: [], effects: [],
    run: (ctx, { agent }) => ctx.who(agent),
  },
  // equip_best: wear the best weapon in the pack. effect: hasWeapon=true.
  equip_best: {
    effect: 'hasWeapon=true',
    // `armed` IS AN ACT SYMBOL AND MAY NOT BE NAMED HERE. That is not a gap to fill:
    // being armed is read off a live client on a one-second clock, and a fleet row is
    // minutes old. validateErrand() rejects it by name if anyone tries.
    pre: [], effects: [],
    run: (ctx, { agent, why }) => ctx.equipBest(agent, why),
  },
  // conjure_weapon: cast create weapon. effect: hasWeapon=true.
  conjure_weapon: {
    effect: 'hasWeapon=true',
    pre: [], effects: [],   // `armed` is an act symbol -- see equip_best
    run: (ctx, { agent, why }) => ctx.conjureWeapon(agent, why),
  },
  // buy_weapon: walk to a smith and buy one. effect: hasWeapon=true.
  // SUPERSEDED for new code by the decomposed pair below (ensure_funded +
  // buy_item); kept because the BT's existing get_armed subtree and the legacy
  // keeper still call it, and deleting it would break the proven field path.
  buy_weapon: {
    effect: 'hasWeapon=true',
    pre: ['funded', 'out_of_raza'], effects: [],   // `armed` is an act symbol
    run: (ctx, { agent, why }) => ctx.buyWeapon(agent, why),
  },

  // ── The decomposed arm-errand. ─────────────────────────────────────────
  // The old m59-outfit.mjs did the whole errand in one 8-step function with no
  // timeouts and no notion of who owned the character. These two atoms are the
  // funding and purchase steps pulled out as single-decision units, each with
  // one precondition, one effect, and a bounded call, so the keeper, GOAP and
  // the BT can compose them and a unit test can drive each one offline.
  //
  // ensure_funded: get the character holding at least `need` shillings. It
  // reads the purse, withdraws from the bank in the current room if short, and
  // (if still short) sells what it is carrying except the keep-list. It does NOT
  // move the character and does NOT buy anything — those are separate atoms. A
  // failed withdrawal (no bank here, money in another town) is reported, not
  // thrown, because carrying on with what you have is the right call.
  ensure_funded: {
    effect: 'purse>=need (best effort)',
    // BEST EFFORT IS STILL AN EFFECT, and `funded` is checked against the row after
    // the fact rather than assumed -- the atomic itself returns { funded } from a
    // re-read purse, never from the amount it asked for.
    pre: [], effects: ['funded'],
    async run(ctx, { agent, need, withdraw = 1000, keep = [] } = {}) {
      const count = (inv) => (inv?.items || []).reduce((t, i) => t + (i.amount || 0), 0);
      let inv = await _bounded(() => ctx.purse(agent));
      let purse = count(inv);
      const did = [];
      if (purse < need) {
        const b = await _bounded(() => ctx.bank(agent, 'withdraw', withdraw));
        const now = count(await _bounded(() => ctx.purse(agent)));
        if (now > purse) { did.push(`withdrew ${now - purse}sh`); purse = now; }
        else if (b?.__timedOut) did.push('withdrawal timed out');
        else if (b?.error) did.push('no withdrawal here');
        else did.push('bank said yes, purse did not grow');
      }
      if (purse < need) {
        const sold = await _bounded(() => ctx.sellAll(agent, null, keep));
        const gained = Number(sold?.total_received || 0);
        if (gained > 0) { purse += gained; did.push(`sold for ${gained}sh`); }
      }
      return { purse, funded: purse >= need, steps: did };
    },
  },

  // buy_item: purchase one named item from an already-adjacent merchant's stock.
  // Precondition: the character is in the room with the merchant (ensure_moved_to)
  // and holds enough (ensure_funded). It reads the stock, picks the cheapest
  // item matching `want` (or `fallback`), buys it, and reports. It does not move
  // or fund — that is the composition order. A missing item is a clean { bought:false },
  // never a throw, so the caller can try the next candidate shop.
  buy_item: {
    effect: 'item in pack, purse debited',
    // IT DOES NOT ESTABLISH `stocked`, and that is not an oversight. `stocked` is one
    // casting of create food -- 2 elderberry AND 2 herbs, the min of a pair -- and this
    // buys ONE item. Claiming it would let the planner satisfy a pair with a single
    // purchase, which is the same min-not-sum error that left twenty of twenty-one
    // characters unable to cast while the fleet total looked healthy.
    pre: ['funded'], effects: [],
    async run(ctx, { agent, seller, want, fallback } = {}) {
      const stock = (await _bounded(() => ctx.shop(agent, seller)))?.items || [];
      const nameOf = (i) => i?.name || i?.label || '';
      const opt = stock.filter(i => want?.test?.(nameOf(i)) ?? nameOf(i) === want)
        .sort((a, b) => (a.cost ?? a.price ?? 9e9) - (b.cost ?? b.price ?? 9e9))[0]
        || stock.filter(i => fallback?.test?.(nameOf(i)) ?? nameOf(i) === fallback)
        .sort((a, b) => (a.cost ?? a.price ?? 9e9) - (b.cost ?? b.price ?? 9e9))[0];
      if (!opt) return { bought: false, reason: 'not in stock', stock: stock.length };
      const cost = Number(opt.cost ?? opt.price ?? 0);
      await _bounded(() => ctx.shop(agent, seller, [opt.id]));
      return { bought: true, item: nameOf(opt), cost, id: opt.id };
    },
  },
};

// Dispatch: run an atomic by name against a driver. Throws on an unknown name
// rather than silently no-opping, so a typo in a caller is reported, not hidden.
export async function runAtomic(name, ctx, params = {}) {
  const a = ATOMICS[name];
  if (!a) throw new Error(`unknown atomic: ${name}`);
  return a.run(ctx, params);
}

export const ATOMIC_NAMES = Object.keys(ATOMICS);

// ---------------------------------------------------------------------------
// The plannable face of the coarse layer
// ---------------------------------------------------------------------------
//
// Until now every verb here declared `effect` as PROSE -- 'room=to, health readable'
// -- which reads like a contract and is worth nothing to a planner. So the errand
// layer could not be planned over at all, and "two libraries, two vocabularies" was
// asserted rather than true.
//
// These declare `pre`/`effects` in the ERRAND vocabulary (m59-errandstate.mjs), which
// reads a `fleet` row that may be MINUTES OLD. Naming an act symbol here is a scope
// error and validateErrand() rejects it by name -- see equip_best, where the honest
// answer is to declare nothing rather than to reach for `armed`.
//
// TWO VERBS CANNOT BE DECLARED STATICALLY, because what they establish is decided by
// their parameters rather than by the verb. A static declaration for those would be a
// lever connected to nothing: travel_to would claim to arrive somewhere in particular
// however it was called. So they are SPECIALISED against the params, the same way
// m59-act/cast.mjs specialises a cast against its target.
export function errandAction(name, params = {}) {
  const a = ATOMICS[name];
  if (!a) throw new Error(`unknown atomic: ${name}`);
  const base = { name, pre: [...(a.pre ?? [])], effects: [...(a.effects ?? [])],
                 run: (ctx, p = params) => a.run(ctx, p) };

  if (name === 'travel_to') {
    const to = params.to;
    const assigned = params.assignedRoom ?? params.assigned_room ?? null;
    // Arriving at the assigned room is a claim only when that is where we are going.
    if (to != null && assigned != null && Number(to) === Number(assigned))
      base.effects.push('at_assigned_room');
    // And a destination outside the island is the only way this verb leaves Raza. An
    // UNKNOWN destination promises neither -- silence, not a guess.
    if (to != null && !RAZA_ROOMS.includes(Number(to)))
      base.effects.push('out_of_raza');
  }

  if (name === 'set_policy') {
    // `hunt` is the only field of the four that any errand symbol reads. Naming a prey
    // is what makes has_prey true; it is also the field whose absence sends a keeper
    // roaming somewhere it has no business being.
    if (params.fields && params.fields.hunt) base.effects.push('has_prey');
  }

  return base;
}

// Every coarse verb as a plannable action, with the params bound. Callers hand this
// to validateErrands() and to a planner over the errand vocabulary.
export function errandActions(paramsByName = {}) {
  return ATOMIC_NAMES.map(n => errandAction(n, paramsByName[n] ?? {}));
}
