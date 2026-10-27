// Complete the four Riija shard quests for a prepared GOOD-karma character, then release it.
// The pit-boss raid and gathering Wulfgang's randomly requested shipment are prerequisites.
// No live orders run on import or compilation. See docs/m59-riija-sword.md for preparation.
import { walk, walkTo, verify } from '../m59-fleetscript.mjs';
import { sayToNpc, sayApproachSquare, squaredDistance, QUEST_NPC_RADIUS } from '../m59-sayrange.mjs';
import { classOfIcon } from '../m59-item-signature.mjs';
import { loadMap, movementMapFile, findPath, edgeCandidatesOf } from '../m59-map.mjs';
import { saveRun, loadRun } from '../m59-questbook.mjs';

export const ROOMS = Object.freeze({ trader: 2144, bowmaker: 2100, priestess: 2141,
  scientist: 2136, hive: 2111 });
export const NPCS = Object.freeze({ trader: "Wulfgang zax'Ak", bowmaker: "Hanla zax'Ta",
  priestess: 'The Bone Priestess', scientist: "Bahal zax'Ot" });
// questengine.kod:2973-2976. The quantities are NOT the counts in old wiki guides.
export const SHIPMENTS = Object.freeze([
  { match: /meat pies?|meatpies?/i, name: 'meat pie', amount: 50 },
  { match: /water skins?/i, name: 'water skin', amount: 70 },
  { match: /apples?/i, name: 'apple', amount: 150 },
  { match: /grapes?/i, name: 'grapes', amount: 200 },
  { match: /elderberr(?:y|ies)/i, name: 'elderberry', amount: 350 },
  { match: /herbs?/i, name: 'herbs', amount: 250 },
  { match: /mushrooms?/i, name: 'mushroom', amount: 200 },
  { match: /jewel of froz/i, name: 'Jewel of Froz', amount: 1 },
]);
const names = Object.freeze({ A: 'priestess', B: 'scientist', C: 'trader', D: 'bowmaker' });
const lc = s => String(s ?? '').toLowerCase();
const roomOf = v => Number(v?.room?.num ?? v?.room);
const count = (items, match) => items.filter(i => match.test(i.name ?? ''))
  .reduce((n, i) => n + Number(i.amount ?? 1), 0);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (yes, why) => { if (!yes) throw Error(why); };
const ledgerId = agent => `riija-sword-${Buffer.from(agent).toString('hex')}`;

export function readShipment(lines) {
  const line = lines.find(s => /replenish my inventory/i.test(s));
  if (!line) return null;
  const hits = SHIPMENTS.filter(s => s.match.test(line));
  return hits.length === 1 ? { name: hits[0].name, amount: hits[0].amount, raw: line } : null;
}

// The server's queen follow hook uses a directional comparison without abs(). Use the
// stricter symmetric distance here, including the room identity, before each departure.
export function queenNear(view, id, distance = 2) {
  const q = view?.objects?.find(o => o.id === id && lc(o.name) === 'dragonfly queen');
  const me = view?.you;
  return !!q && [q.row, q.col, me?.row, me?.col].every(Number.isFinite)
    && Math.max(Math.abs(q.row - me.row), Math.abs(q.col - me.col)) <= distance;
}

async function inventory(ctx) {
  const r = await ctx.call('inventory', { agent: ctx.agent }, 60_000);
  check(!r?.error && !r?.ids_stale && Array.isArray(r?.items), 'Inventory is unreadable or stale; no offer was sent.');
  return r.items;
}
async function view(ctx) {
  const v = await ctx.call('look', { agent: ctx.agent }, 30_000);
  check(Number.isFinite(roomOf(v)), 'Cannot identify the current room.');
  ctx.state.here = roomOf(v);
  return v;
}
function persist(ctx) {
  saveRun({ ...ctx.state.record, id: ledgerId(ctx.agent), quest: 'riija-sword', agent: ctx.agent,
    fleet: ctx.fleet, at: new Date().toISOString() }, { fleet: ctx.fleet });
}

// Do not use a shard's generic display name to decide which of the four quests is done.
// Local .rsc signatures identify existing shards. Newly earned shards also get their icon
// recorded after the exact delivery and inventory readback, allowing a later run without them.
export async function refresh(ctx) {
  const items = await inventory(ctx), parts = {};
  const record = ctx.state.record;
  ctx.state.complete = false;
  const sword = items.find(i => lc(i.name) === 'sword of riija');
  if (sword) {
    const d = await ctx.call('look_at', { agent: ctx.agent, target: sword.id }, 30_000);
    check(lc(d?.description).includes(lc(`Let ${record.character} walk with faith.`)),
      'The sword cannot be verified as belonging to this character.');
    ctx.state.complete = true;
  }
  for (const i of items.filter(i => lc(i.name) === 'shard of a sword')) {
    const signature = classOfIcon(i.icon_rsc)?.class;
    const key = /^swordshard([abcd])$/i.exec(signature ?? '')?.[1]?.toUpperCase()
      ?? Object.keys(record.icons).find(k => Number(record.icons[k]) === Number(i.icon_rsc));
    check(key, `Cannot identify shard ${i.id}; supply this server build's .rsc files through M59_RSC_DIR.`);
    const d = await ctx.call('look_at', { agent: ctx.agent, target: i.id }, 30_000);
    check(lc(d?.description).includes(lc(`${record.character}'s name is written`)),
      `Shard ${i.id} is not proven to belong to this character.`);
    parts[key] = i;
  }
  ctx.state.parts = parts;
  return items;
}

async function conversation(ctx, npc, text) {
  return sayToNpc({ text, to: npc, radius: QUEST_NPC_RADIUS }, {
    look: () => view(ctx),
    walkTo: (p, opts) => ctx.call('walk_to', { agent: ctx.agent, ...p,
      arrive_within: opts.arriveWithin }, opts.timeoutMs),
    speak: async words => {
      const before = await ctx.call('wait_for_event', { agent: ctx.agent,
        kinds: ['message', 'said'], timeout_ms: 1 }, 30_000);
      check(before?.cursor != null, 'Cannot establish a speech cursor.');
      const sent = await ctx.call('say', { agent: ctx.agent, text: words }, 30_000);
      check(!sent?.error, sent?.error);
      const replies = [], until = Date.now() + 6000;
      let cursor = before.cursor;
      while (Date.now() < until) {
        const got = await ctx.call('wait_for_event', { agent: ctx.agent, since: cursor,
          kinds: ['message', 'said'], timeout_ms: Math.max(1, until - Date.now()) }, 30_000);
        check(!got?.error && got?.cursor != null, 'Speech readback failed; inspect the quest before retrying.');
        cursor = got.cursor;
        replies.push(...(got.events ?? []).filter(e => e.text).map(e => ({ text: e.text })));
        if (got.timed_out) break;
      }
      return { spoken_ok: true, replies };
    },
  });
}

export async function offer(ctx, npc, match, amount, targetId = null, deadline = Infinity, beforeSend = null) {
  const pack = await inventory(ctx);
  // One full stack is required: the quest engine does not accumulate partial deliveries.
  const item = pack.find(i => match.test(i.name ?? '') && Number(i.amount ?? 1) >= amount);
  check(item, `Need one stack of ${amount} matching ${match}; nothing offered.`);
  let v = await view(ctx), target = v.objects?.find(i => lc(i.name) === lc(npc)
    && (targetId == null || i.id === targetId));
  check(target && Number.isFinite(target.id), `${npc} is not in the current room.`);
  const room = roomOf(v), id = target.id;
  const approach = sayApproachSquare(v.you, target, { radius: QUEST_NPC_RADIUS, leave: 2 });
  check(approach, 'Cannot establish offer distance.');
  if (!approach.already) {
    await ctx.call('walk_to', { agent: ctx.agent, row: approach.row, col: approach.col,
      arrive_within: 1 }, 120_000);
    v = await view(ctx);
    target = v.objects?.find(i => i.id === id && lc(i.name) === lc(npc));
  }
  const distance = squaredDistance(v.you, target);
  check(roomOf(v) === room && distance != null && distance <= QUEST_NPC_RADIUS,
    'Did not get within five squares of the same recipient; nothing offered.');
  check(Date.now() < deadline, 'Delivery deadline expired while approaching; nothing offered.');
  await beforeSend?.();
  const r = await ctx.keeper('trade', { op: 'offer', to_id: target.id,
    items: [{ id: item.id, amount }] }, 30_000);
  check(r?.sent && !r?.error, r?.error ?? 'Keeper did not confirm sending the offer.');
}

const needed = (st, key) => !st.complete && !st.parts?.[key];
function leg(key, room) {
  return [verify(async ctx => { await view(ctx); await refresh(ctx); return { ok: true }; }, 'read quest progress'),
    walk(st => needed(st, key) ? room : st.here, { candidates: [room] })];
}
async function ask(ctx, key, trigger, expected) {
  if (!needed(ctx.state, key)) return { ok: true, skipped: true };
  const record = ctx.state.record, open = record.open[key];
  if (open) {
    check(Date.now() < open.deadline, `The ${names[key]} deadline expired. Let its failure/cooldown clear, then use reset=true.`);
    return { ok: true, resumed: open };
  }
  const started = Date.now();
  const r = await conversation(ctx, NPCS[names[key]], trigger);
  check(r.ok && r.spoken_ok, r.why ?? 'Could not ask the NPC.');
  const lines = (r.replies ?? []).map(r => String(r.text));
  // Store even an unrecognized response; the assignment can be spoken only once.
  record.heard.push({ key, lines, at: new Date().toISOString() });
  persist(ctx);
  check(lines.some(s => expected.test(s)), 'No recognized assignment. Check karma, anonymity, quest availability and cooldown; no delivery attempted.');
  record.open[key] = { assigned: started, deadline: started + 3600_000,
    ...(key === 'C' ? { shipment: readShipment(lines) } : {}) };
  persist(ctx);
  check(key !== 'C' || record.open[key].shipment, 'Unrecognized shipment recorded in the questbook; do not guess the delivery.');
  return { ok: true, assignment: record.open[key] };
}
async function reward(ctx, key, before) {
  for (let i = 0; i < 5; i++) {
    const after = await inventory(ctx);
    if (after.some(i => lc(i.name) === 'sword of riija')) {
      await refresh(ctx);
      check(ctx.state.complete, 'Sword ownership was not verified.');
    } else {
      const added = after.filter(i => lc(i.name) === 'shard of a sword' && !before.some(b => b.id === i.id));
      if (added.length === 1 && Number.isFinite(added[0].icon_rsc)) {
        const cls = classOfIcon(added[0].icon_rsc)?.class;
        check(!cls || lc(cls) === lc(`SwordShard${key}`), 'A different shard arrived; inspect the reward.');
        ctx.state.record.icons[key] = added[0].icon_rsc;
        await refresh(ctx);
        check(ctx.state.parts[key], 'The expected shard was not found.');
      } else { await sleep(1000); continue; }
    }
    delete ctx.state.record.open[key];
    persist(ctx);
    return { ok: true, shard: key, complete: !!ctx.state.complete };
  }
  throw Error(`No verified ${key} shard or owned sword arrived. The quest remains open in the questbook.`);
}
async function handIn(ctx, key, npc, match, amount) {
  if (!needed(ctx.state, key)) return { ok: true, skipped: true };
  check(Date.now() < ctx.state.record.open[key]?.deadline, 'Quest deadline expired; nothing offered.');
  const before = await inventory(ctx);
  if (key === 'C' && match.test('meat pie') && needed(ctx.state, 'B')) {
    check(count(before, match) >= amount + 1, 'Keep at least one extra meat pie for the queen before delivering this shipment.');
  }
  const open = ctx.state.record.open[key];
  check(!open.deliveryAttempt, 'An earlier delivery was sent without a verified reward. Inspect the questbook and inventory; do not send it again.');
  await offer(ctx, npc, match, amount, null, open.deadline, () => {
    open.deliveryAttempt = { at: Date.now(), amount, npc };
    persist(ctx);
  });
  return reward(ctx, key, before);
}

export const script = {
  name: 'riija-sword',
  describe: 'Earn a sword of Riija on the good-karma route with staged raid loot and shipment supplies; release control.',
  provenance: { pinned: '6abba8a4', verified: '2026-10-27', refuseOnDrift: false,
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-sayrange.mjs', 'tools/m59-keeper-process.mjs'] },
  recipe: {
    effect: 'Four island quests, queen escort, owned-sword readback, optional return home, and normal FleetScript release.',
    run: 'riija-sword agents=<one-bot> [home=<room>] [reset=false]',
    needs: ['karma >= +10, not anonymous or morphed; safe jungle travel and permission through the east tower',
      'orc pit boss head, chunk of nerudite, spare meat pies, and the shipment Wulfgang actually requests',
      'one bot per invocation; raid and missing supplies are not gathered by this script'],
    cost: { time: 'one hour per active quest node; missing resources stop the run for resupply',
      risk: 'dangerous jungle and Cliff Hive; queen can die or fail to follow; no live completion measured' },
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'exactly one prepared bot' },
    home: { type: 'number', describe: 'optional return room, attempted even after a failed quest step' },
    reset: { type: 'boolean', default: false, describe: 'discard expired local assignments only after server cooldown clears' },
    minHealth: { type: 'number', default: 1, describe: 'departure health fraction' },
  },
  async steps({ agents, home, reset = false }) {
    check(agents.length === 1, 'riija-sword requires exactly one bot.');
    if (home != null) check(Number.isInteger(Number(home)) && Number(home) > 0, 'home must be a positive room number.');
    const map = loadMap(movementMapFile());
    const route = findPath(map, ROOMS.hive, ROOMS.scientist);
    check(route.found, `No queen escort route: ${route.reason}`);
    const steps = [verify(async ctx => {
      const v = await view(ctx), s = await ctx.call('status', { agent: ctx.agent }, 30_000);
      const character = s?.character ?? v?.you?.name;
      check(typeof character === 'string' && character.length, 'Cannot identify the assigned character.');
      const saved = loadRun(ledgerId(ctx.agent), { fleet: ctx.fleet });
      check(!saved || saved.character === character, 'Quest checkpoint belongs to another character; inspect it before reusing this agent name.');
      check(!saved || (saved.icons && saved.open && Array.isArray(saved.heard)), 'Malformed quest checkpoint; inspect the questbook before running.');
      ctx.state.record = saved ?? { character, icons: {}, open: {}, heard: [] };
      if (reset === true || reset === 'true') {
        check(Object.values(ctx.state.record.open).every(q => Date.now() >= q.deadline),
          'reset cannot discard an unexpired assignment.');
        ctx.state.record.open = {};
      }
      const pack = await refresh(ctx);
      if (ctx.state.complete) return { ok: true, already_complete: true };
      // Require items before opening the timed quests; no party members are commandeered.
      check(!needed(ctx.state, 'A') || count(pack, /^orc pit boss head$/i) >= 1, 'Stage an orc pit boss head first.');
      check(!needed(ctx.state, 'D') || count(pack, /^chunk of nerudite$/i) >= 1
        || count(pack, /^feather of an avar shaman$/i) >= 1, 'Stage a chunk of nerudite first.');
      check(!needed(ctx.state, 'B') || count(pack, /^meat pies?$/i) >= 1, 'Stage spare meat pies for the queen.');
      persist(ctx);
      return { ok: true, character, prepared: true };
    }, 'verify character, shards and prepared quest items')];
    steps.push(...leg('C', ROOMS.trader), verify(ctx => ask(ctx, 'C', 'inventory', /replenish my inventory/i), 'request the shipment'),
      verify(async ctx => {
        if (!needed(ctx.state, 'C')) return { ok: true, skipped: true };
        const s = ctx.state.record.open.C.shipment;
        check(s && SHIPMENTS.some(p => p.name === s.name && p.amount === s.amount), 'Unknown recorded shipment.');
        const match = SHIPMENTS.find(p => p.name === s.name).match;
        return handIn(ctx, 'C', NPCS.trader, match, s.amount);
      }, 'deliver exactly the requested shipment; otherwise resupply and rerun'));
    steps.push(...leg('D', ROOMS.bowmaker),
      verify(ctx => ask(ctx, 'D', 'arrows', /willing to trade a tailfeather/i), 'request the GOOD-karma feather quest'),
      ...leg('D', ROOMS.priestess), verify(async ctx => {
        if (!needed(ctx.state, 'D')) return { ok: true, skipped: true };
        check(Date.now() < ctx.state.record.open.D?.deadline, 'Feather trade deadline expired.');
        if (count(await inventory(ctx), /^feather of an avar shaman$/i)) return { ok: true, feather_present: true };
        check(!ctx.state.record.open.D.oreAttempt, 'An earlier nerudite offer is unresolved. Inspect the quest before sending more ore.');
        const started = Date.now();
        await offer(ctx, NPCS.priestess, /^chunk of nerudite$/i, 1, null, ctx.state.record.open.D.deadline, () => {
          ctx.state.record.open.D.oreAttempt = { at: started };
          persist(ctx);
        });
        for (let i = 0; i < 5; i++) {
          if (count(await inventory(ctx), /^feather of an avar shaman$/i)) {
            ctx.state.record.open.D.deadline = started + 3600_000;
            persist(ctx);
            return { ok: true, feather_received: true };
          }
          await sleep(1000);
        }
        throw Error('No feather arrived; do not repeat the nerudite offer blindly.');
      }, 'trade nerudite for the quest feather'), ...leg('D', ROOMS.bowmaker),
      verify(ctx => handIn(ctx, 'D', NPCS.bowmaker, /^feather of an avar shaman$/i, 1), 'deliver the feather'),
      ...leg('A', ROOMS.priestess), verify(ctx => ask(ctx, 'A', 'riija', /Hedd of Pit Boss/i), 'request the head quest'),
      verify(ctx => handIn(ctx, 'A', NPCS.priestess, /^orc pit boss head$/i, 1), 'deliver the prepared head'),
      ...leg('B', ROOMS.scientist), verify(ctx => ask(ctx, 'B', 'kohuzotz', /bring me a live specimen/i), 'request the queen quest'),
      ...leg('B', ROOMS.hive), verify(async ctx => {
        if (!needed(ctx.state, 'B')) return { ok: true, skipped: true };
        const v = await view(ctx), q = v.objects?.find(o => lc(o.name) === 'dragonfly queen');
        check(q, 'No live queen at Cliff Hive; wait for a spawn and rerun within the quest deadline.');
        await offer(ctx, q.name, /^meat pies?$/i, 1, q.id, ctx.state.record.open.B.deadline);
        ctx.state.queen = q.id;
        return { ok: true, queen: q.id };
      }, 'offer one meat pie to a live queen'));
    for (const hop of route.hops) {
      steps.push(verify(async ctx => {
        const v = await view(ctx);
        if (!needed(ctx.state, 'B')) { ctx.state.edgeStage = null; return { ok: true, skipped: true }; }
        check(roomOf(v) === Number(hop.from), 'Escort is in an unexpected room.');
        // Bring the character to the actual departure before waiting for the follower.
        // Waiting only at the start of a long room walk can strand the queen at the exit.
        const room = map.rooms[hop.from];
        const edge = room.edgeExits?.find(e => Number(e.to) === Number(hop.to) && e.leaveName === hop.direction);
        check(hop.kind === 'go' || edge, 'Escort route has no matching declared exit.');
        const candidates = hop.kind === 'go' ? [{ row: hop.row, col: hop.col }]
          : edgeCandidatesOf(room, edge, null, { live: true }).flatMap(c => c.stages ?? [c]);
        check(candidates.length, 'No validated departure approach for the queen escort.');
        candidates.sort((a, b) => Math.hypot(a.row - v.you.row, a.col - v.you.col)
          - Math.hypot(b.row - v.you.row, b.col - v.you.col));
        ctx.state.edgeStage = candidates[0];
        return { ok: true, departure: ctx.state.edgeStage };
      }, 'choose a validated approach to this exit'),
      { ...walkTo(st => st.edgeStage?.col ?? null, st => st.edgeStage?.row ?? null,
        { within: 0, arriveWithin: 0, deadlineMs: 180_000 }),
        room: st => needed(st, 'B') ? Number(hop.from) : null, optional: true },
      verify(async ctx => {
        await view(ctx);
        if (!needed(ctx.state, 'B')) return { ok: true, skipped: true };
        check(Date.now() < ctx.state.record.open.B?.deadline, 'Queen delivery deadline expired.');
        // Stand still for the follower. Never leave a room merely because the walk succeeded.
        for (let i = 0; i < 20; i++) {
          const v = await view(ctx);
          check(roomOf(v) === Number(hop.from), 'Escort is in an unexpected room.');
          check(ctx.state.edgeStage && Math.max(Math.abs(v.you.row - ctx.state.edgeStage.row),
            Math.abs(v.you.col - ctx.state.edgeStage.col)) <= 1, 'Did not reach the departure approach; queen escort stopped.');
          if (queenNear(v, ctx.state.queen)) return { ok: true, queen_near: true };
          await sleep(1500);
        }
        throw Error('Queen lost or not within two squares; escort stopped.');
      }, 'wait for the same queen before leaving'),
      walk(st => needed(st, 'B') ? Number(hop.to) : st.here, { candidates: [Number(hop.to)] }));
    }
    steps.push(verify(async ctx => {
      await view(ctx);
      if (!needed(ctx.state, 'B')) return { ok: true, skipped: true };
      const before = await inventory(ctx);
      const v = await view(ctx);
      check(roomOf(v) === ROOMS.scientist && v.objects?.some(o => o.id === ctx.state.queen),
        'The escorted queen did not arrive in the scientist hut.');
      check(Date.now() < ctx.state.record.open.B?.deadline, 'Queen deadline expired.');
      const said = await conversation(ctx, NPCS.scientist, 'kohuzotz');
      check(said.ok && said.spoken_ok, said.why ?? 'Scientist could not hear the delivery.');
      return reward(ctx, 'B', before);
    }, 'deliver the live queen and verify the final reward'), verify(async ctx => {
      await refresh(ctx);
      check(ctx.state.complete, 'All steps ran, but no owned sword of Riija was verified.');
      ctx.state.record.outcome = 'ok';
      persist(ctx);
      return { ok: true, sword_owned: true };
    }, 'prove the completed sword belongs to the assigned character'));
    if (home != null) steps.push({ ...walk(Number(home)), always: true });
    // The runner cancels pending travel, releases keeper faculties, and clears busy in finally.
    // No autopilot policy is rewritten by this script, so normal control resumes after release.
    return steps;
  },
};
