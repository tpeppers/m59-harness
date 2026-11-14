// EARN A SWORD OF RIIJA FOR ONE CHARACTER: ask each of the four NPCs, read the request the server
// makes ONCE, draw exactly that from the island guild hall (713), hand it over, prove the shard
// arrived, and finally prove and wield the assembled sword.
//
// PUBLIC, parameterised, no character names. The derivation is
// m59-research/reports/riija-sword-quest.md; the data (rooms, lines, tables) is tools/m59-riija.mjs;
// the usage, and the two phases that come before this one, are in docs/m59-riija-sword.md:
//
//   1. riija-prep      stocks hall 713 with everything the quester's karma side can be asked for
//   2. riija-pitboss   a team of four solves the orc-pit chamber puzzle, kills the boss, and
//                      deposits the orc pit boss head in 713
//   3. riija-quester   THIS: per shard, ask -> draw from 713 -> deliver -> verify
//
// WHY "ASK, THEN DRAW" AND NOT "DRAW EVERYTHING, THEN ASK": Wulfgang's table on the good side is up
// to 350 elderberries or 250 herbs or 200 grapes -- one of eight, rolled by the server -- and no pack
// carries all of them. So the kit drawn before the first question is only what is CERTAIN to be
// needed (the head, the ore for Hanla's good route, pies for the queen); Wulfgang's shipment is drawn
// after he names it, which costs one hall round trip inside his one-hour node.
//
// THE SERVER NAMES THE CARGO ONCE (questnode.kod:67, NPC_quote_to_one) and never repeats it, so the
// heard lines and the parsed request are written to the fleet's questbook BEFORE anything else
// happens; a re-run resumes the open node instead of asking again (asking again is silence: the
// quest is already running for this character). Same discipline as jala-pupil.mjs and
// disciple-quest.mjs.
//
// KARMA PICKS THE ROUTE AND IS READ LIVE: >= +10 good, <= -10 evil, anything between gets NOTHING from
// Wulfgang or Hanla (quest.kod:126-134) and the run refuses before asking.
//   good: Hanla wants nerudite taken to the Bone Priestess, who hands back a feather for Hanla.
//   evil: Hanla wants an avar shaman killed BY THE QUESTER; the feather appears at the corpse
//         (questnode.kod:1527-1584) and must be picked up. Farming is a posture, not a step list, so
//         the kill is a `harvest` of "avar shaman" whose goal is "the feather is in the pack".
//
// WHAT IS LEFT TO A LIVE RUN, and stated rather than assumed: the request line's exact wording after
// the client's markup (readShipment refuses anything it cannot place on the table), whether the
// keeper's farm posture will engage an avar shaman at this character's level, and the queen escort
// itself (the report's "following is conditional" -- monster.kod:933-980).
import { walk, walkTo, verify, harvest } from '../m59-fleetscript.mjs';
import { sayToNpc, sayApproachSquare, squaredDistance, QUEST_NPC_RADIUS } from '../m59-sayrange.mjs';
import { classOfIcon } from '../m59-item-signature.mjs';
import { loadMap, movementMapFile, findPath, edgeCandidatesOf } from '../m59-map.mjs';
import { saveRun, loadRun } from '../m59-questbook.mjs';
import { withdrawWithRecovery } from '../m59-hall-access.mjs';
import { postureStep, restorePostureStep } from '../m59-errand-posture.mjs';
import { ROOMS, NPCS, SHARDS, LINES, ITEMS, NODE_MS, NODE_MARGIN_MS, karmaSide, readShipment,
         shardKeyOfClass, boundToShard, boundToSword, shardsNeeded } from '../m59-riija.mjs';

const TAG = 'riija-quester';
// Avar shaman spawn rooms in the Ko'catan jungle, heaviest weight first (k*.kod plMonsters):
// kc3 2133 and ke2 2152 at 25, kb2 2122 / kb3 2123 / kd3 2143 at 18, kd2 2142 at 15, kc2 2132 and
// kd4 2144 at 10. Ke4 (2154, Avar Village) is left out: it is a village raid, not a shaman hunt.
export const SHAMAN_ROOMS = Object.freeze([2133, 2152, 2122, 2123, 2143, 2142, 2132, 2144]);

const lc = s => String(s ?? '').toLowerCase();
const roomOf = v => Number(v?.room?.num ?? v?.room);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (yes, why) => { if (!yes) throw Error(why); };
const count = (items, match) => items.filter(i => match.test(String(i.name ?? '')))
  .reduce((n, i) => n + (Number(i.amount) || 1), 0);
const biggest = (items, match) => items.filter(i => match.test(String(i.name ?? '')))
  .sort((a, b) => (Number(b.amount) || 1) - (Number(a.amount) || 1))[0] ?? null;
export const ledgerId = agent => `riija-sword-${Buffer.from(String(agent)).toString('hex')}`;
const A = s => ({ ...s, anywhere: true });
const need = (st, key) => !!st?.q && st.q.needed.includes(key);
const live = (st, key) => need(st, key) && st.q.open?.[key] && Date.now() < st.q.open[key].deadline - NODE_MARGIN_MS;

// ---------------------------------------------------------------- reading the world

async function inventory(ctx) {
  const r = await ctx.call('inventory', { agent: ctx.agent }, 60_000);
  check(!r?.error && !r?.ids_stale && Array.isArray(r?.items), 'Inventory is unreadable or stale; nothing was offered.');
  return r.items;
}
async function view(ctx) {
  const v = await ctx.call('look', { agent: ctx.agent }, 30_000);
  check(Number.isFinite(roomOf(v)), 'Cannot identify the current room.');
  ctx.state.here = roomOf(v);
  return v;
}
function persist(ctx) {
  const q = ctx.state.q;
  saveRun({ ...q.record, id: ledgerId(ctx.agent), quest: 'riija-sword', agent: ctx.agent,
    fleet: ctx.fleet, at: new Date().toISOString() }, { fleet: ctx.fleet });
}

// A shard's display name is the same for all four, so the CLASS decides which one it is: the icon
// signature from the local .rsc files first, then the icon this run saw arrive after a verified
// delivery (recorded in the questbook). The binding sentence decides whose it is.
export async function refresh(ctx) {
  const q = ctx.state.q, items = await inventory(ctx), parts = {};
  q.complete = false;
  const sword = items.find(i => ITEMS.sword.match.test(String(i.name ?? '')));
  if (sword) {
    const d = await ctx.call('look_at', { agent: ctx.agent, target: sword.id }, 30_000);
    check(Number(d?.id ?? sword.id) === Number(sword.id), 'look_at answered for a different object; re-run.');
    check(boundToSword(d?.description, q.record.character), 'A sword of Riija is carried but its runes do not name this character.');
    q.complete = true; q.sword = sword;
  }
  for (const i of items.filter(i => ITEMS.shard.match.test(String(i.name ?? '')))) {
    const key = shardKeyOfClass(classOfIcon(i.icon_rsc)?.class)
      ?? Object.keys(q.record.icons).find(k => Number(q.record.icons[k]) === Number(i.icon_rsc));
    check(key, `Cannot tell which shard ${i.id} is; supply this server build's .rsc files through M59_RSC_DIR.`);
    const d = await ctx.call('look_at', { agent: ctx.agent, target: i.id }, 30_000);
    check(Number(d?.id ?? i.id) === Number(i.id), 'look_at answered for a different object; re-run.');
    check(boundToShard(d?.description, q.record.character), `Shard ${i.id} is not bound to this character.`);
    parts[key] = i;
  }
  q.parts = parts;
  q.needed = shardsNeeded({ parts, complete: q.complete, want: q.want });
  return items;
}

/** Say `text` to `npc` from within the quest node's 5 squares, and return what came back. */
export async function conversation(ctx, npc, text) {
  return sayToNpc({ text, to: npc, radius: QUEST_NPC_RADIUS }, {
    look: () => view(ctx),
    walkTo: (p, opts) => ctx.call('walk_to', { agent: ctx.agent, ...p, arrive_within: opts.arriveWithin }, opts.timeoutMs),
    speak: async words => {
      const before = await ctx.call('wait_for_event', { agent: ctx.agent, kinds: ['message', 'said'], timeout_ms: 1 }, 30_000);
      check(before?.cursor != null, 'Cannot establish a speech cursor.');
      const sent = await ctx.call('say', { agent: ctx.agent, text: words }, 30_000);
      check(!sent?.error, sent?.error);
      return { spoken_ok: true, replies: await hear(ctx, before.cursor, 6000) };
    },
  });
}
async function hear(ctx, cursor, ms) {
  const replies = [], until = Date.now() + ms;
  while (Date.now() < until) {
    const got = await ctx.call('wait_for_event', { agent: ctx.agent, since: cursor, kinds: ['message', 'said'],
      timeout_ms: Math.max(1, until - Date.now()) }, 30_000);
    check(!got?.error && got?.cursor != null, 'Speech readback failed; inspect the quest before retrying.');
    cursor = got.cursor;
    replies.push(...(got.events ?? []).filter(e => e.text).map(e => ({ text: String(e.text) })));
    if (got.timed_out) break;
  }
  return replies;
}

/**
 * Offer exactly `amount` from ONE stack to `npc` (the node does not bank partial deliveries,
 * questnode.kod:710-729), from within five squares, re-read just before sending.
 */
export async function offer(ctx, npc, match, amount, { targetId = null, deadline = Infinity, beforeSend = null } = {}) {
  const pack = await inventory(ctx);
  const item = pack.find(i => match.test(String(i.name ?? '')) && (Number(i.amount) || 1) >= amount);
  check(item, `Need one stack of ${amount} matching ${match}; nothing offered.`);
  let v = await view(ctx);
  let target = v.objects?.find(o => lc(o.name) === lc(npc) && (targetId == null || o.id === targetId));
  check(target && Number.isFinite(target.id), `${npc} is not in the current room.`);
  const room = roomOf(v), id = target.id;
  const approach = sayApproachSquare(v.you, target, { radius: QUEST_NPC_RADIUS, leave: 2 });
  check(approach, 'Cannot establish offer distance.');
  if (!approach.already) {
    await ctx.call('walk_to', { agent: ctx.agent, row: approach.row, col: approach.col, arrive_within: 1 }, 120_000);
    v = await view(ctx);
    target = v.objects?.find(o => o.id === id && lc(o.name) === lc(npc));
  }
  const d2 = squaredDistance(v.you, target);
  check(roomOf(v) === room && d2 != null && d2 <= QUEST_NPC_RADIUS, 'Not within five squares of the same recipient; nothing offered.');
  check(Date.now() < deadline, 'The node deadline passed while approaching; nothing offered.');
  await beforeSend?.();
  const r = await ctx.keeper('trade', { op: 'offer', to_id: target.id, items: [{ id: item.id, amount }] }, 30_000);
  check(r?.sent && !r?.error, r?.error ?? 'The keeper did not confirm sending the offer.');
  return { offered: item.name, amount, to: npc };
}

/** After a delivery: the new shard (or the sword) must be IN THE PACK, bound to this character. */
async function reward(ctx, key, before) {
  const q = ctx.state.q;
  for (let i = 0; i < 6; i++) {
    const after = await inventory(ctx);
    if (after.some(x => ITEMS.sword.match.test(String(x.name ?? '')))) {
      await refresh(ctx);
      check(q.complete, 'A sword arrived but its binding was not verified.');
    } else {
      const added = after.filter(x => ITEMS.shard.match.test(String(x.name ?? '')) && !before.some(b => b.id === x.id));
      if (added.length !== 1 || !Number.isFinite(Number(added[0].icon_rsc))) { await sleep(1000); continue; }
      const cls = classOfIcon(added[0].icon_rsc)?.class;
      check(!cls || shardKeyOfClass(cls) === key, `A different shard (${cls}) arrived; inspect the reward.`);
      q.record.icons[key] = Number(added[0].icon_rsc);
      await refresh(ctx);
      check(q.parts[key], `The ${key} shard was not found after the delivery.`);
    }
    delete q.record.open[key];
    q.open = q.record.open;
    persist(ctx);
    return { ok: true, shard: key, sword: !!q.complete };
  }
  throw Error(`No verified ${key} shard (or owned sword) arrived. The node stays open in the questbook; inspect before re-sending anything.`);
}

async function ask(ctx, key, expect) {
  const q = ctx.state.q;
  if (!need(ctx.state, key)) return { ok: true, skipped: 'already held' };
  check(ctx.state.here === SHARDS[key].room, `Not in room ${SHARDS[key].room} to ask ${NPCS[SHARDS[key].npc]}.`);
  const open = q.record.open[key];
  if (open) {
    check(Date.now() < open.deadline, `The ${key} node expired at ${new Date(open.deadline).toISOString()}. ` +
      'Wait out the server failure and the hour of logged-in time, then re-run with reset=true.');
    return { ok: true, resumed: open };
  }
  const started = Date.now();
  const r = await conversation(ctx, NPCS[SHARDS[key].npc], SHARDS[key].trigger);
  check(r.ok && r.spoken_ok, r.why ?? 'Could not speak to the NPC.');
  const lines = (r.replies ?? []).map(x => x.text);
  // Stored even when unrecognised: the assignment is spoken only once.
  q.record.heard.push({ key, lines, at: new Date().toISOString() });
  persist(ctx);
  check(lines.some(s => expect.test(s)), `${NPCS[SHARDS[key].npc]} assigned nothing recognisable. Silence means: ` +
    'karma on the wrong side of +/-10, anonymous or morphed, failed within the last logged-in hour, or ' +
    'too far away. The lines heard are in the questbook.');
  q.record.open[key] = { assigned: started, deadline: started + NODE_MS };
  if (key === 'C') {
    q.record.open.C.shipment = readShipment(lines, q.side);
    persist(ctx);
    check(q.record.open.C.shipment, 'Wulfgang named a shipment this script cannot place on the table; it is in the ' +
      'questbook. Fetch it by hand within the hour -- never guess the cargo.');
  }
  q.open = q.record.open;
  persist(ctx);
  return { ok: true, assigned: q.record.open[key] };
}

async function handIn(ctx, key, npc, match, amount) {
  const q = ctx.state.q;
  if (!need(ctx.state, key)) return { ok: true, skipped: 'already held' };
  const open = q.record.open[key];
  check(open && Date.now() < open.deadline - NODE_MARGIN_MS, `The ${key} node is not open or is about to expire; nothing offered.`);
  check(!open.deliveryAttempt, 'An earlier delivery was sent without a verified reward. Inspect the questbook and pack; do not send it again.');
  const before = await inventory(ctx);
  await offer(ctx, npc, match, amount, { deadline: open.deadline, beforeSend: () => {
    open.deliveryAttempt = { at: Date.now(), amount, npc }; persist(ctx);
  } });
  return reward(ctx, key, before);
}

/** Draw `wants` ([{key, amount}]) from the hall the body is standing in, read back off the pack. */
async function drawFromHall(ctx, wants, hall) {
  if (!wants.length) return { ok: true, skipped: 'nothing to draw' };
  await view(ctx);
  check(ctx.state.here === hall, `Not in hall ${hall}; cannot draw ${wants.map(w => w.key).join(', ')}.`);
  const r = await withdrawWithRecovery(ctx.call, ctx.agent, wants.map(w => ({ item: ITEMS[w.key].name, amount: w.amount })));
  const pack = await inventory(ctx);
  const missing = wants.filter(w => count(pack, ITEMS[w.key].match) < w.need);
  check(!missing.length, `Hall ${hall} could not supply ${missing.map(w => `${w.need} ${ITEMS[w.key].name}`).join(', ')}` +
    ` (${r.why ?? 'short'}). Run riija-prep, then re-run this; open nodes resume.`);
  return { ok: true, drew: r.arrived };
}

// ---------------------------------------------------------------- the script

export const script = {
  name: 'riija-quester',
  describe: 'Earn a sword of Riija for one character: ask each NPC, draw exactly what was asked from hall 713, deliver, verify, wield.',
  provenance: { pinned: '019bf448', verified: '2026-11-13', refuseOnDrift: false,
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-sayrange.mjs', 'tools/m59-hall-access.mjs',
              'tools/m59-keeper-process.mjs', 'tools/m59-riija.mjs', 'tools/m59-errand-posture.mjs'] },
  recipe: {
    effect: 'Up to four shards, each read back bound to the quester; the assembled sword proved by its runes and wielded.',
    run: 'riija-quester agents=<quester> [shards=C,D,A,B] [home=<room>] [reset=false]',
    needs: ['karma >= +10 or <= -10, read live; not anonymous or morphed',
      'a member (rank sir+) of the guild that owns hall 713, or an ally -- the draws happen there',
      'hall 713 stocked by riija-prep (and the head by riija-pitboss) for the quester\'s side',
      'already on Ko\'catan, or run inside island-trip (task=riija-quester)'],
    cost: { time: 'one real hour per open node; the queen escort is the long one',
      risk: 'jungle travel, the shaman kill on the evil route, Cliff Hive; no live completion measured yet' },
    notes: ['Each node is one REAL hour; a failure locks the retry for one LOGGED-IN hour.',
      'The questbook (substrate/questbook/<fleet>/) carries the heard lines and open nodes; it is gitignored.'],
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'exactly one quester' },
    shards: { type: 'string', default: 'C,D,A,B', describe: 'which shards to work on, in this order (A tip, B blade, C crosspiece, D handle)' },
    hall: { type: 'room', default: ROOMS.hall, describe: 'the stocked guild hall to draw from' },
    queenPies: { type: 'number', default: 3, describe: 'meat pies to carry for the dragonfly queen' },
    queenWaitMin: { type: 'number', default: 20, describe: 'how long to wait at Cliff Hive for a queen to spawn' },
    shamanRooms: { type: 'string', default: SHAMAN_ROOMS.join(','), describe: 'evil route: where to hunt avar shamans, in order' },
    huntMin: { type: 'number', default: 12, describe: 'evil route: minutes of farm posture per shaman room' },
    wield: { type: 'boolean', default: true, describe: 'wield the finished sword' },
    home: { type: 'room', default: 0, describe: 'room to walk back to at the end (0 = stay)' },
    reset: { type: 'boolean', default: false, describe: 'discard EXPIRED open nodes from the questbook (after the server cooldown)' },
    minHealth: { type: 'number', default: 0.8, describe: 'health fraction to set out on a walk' },
    fleeBelow: { type: 'number', default: 0.35 }, restBelow: { type: 'number', default: 0.5 },
  },

  async steps(p) {
    const agents = [].concat(p.agents ?? []).flatMap(a => String(a).split(/[\s,]+/)).filter(Boolean);
    check(agents.length === 1, 'riija-quester drives exactly one quester.');
    const want = String(p.shards ?? 'C,D,A,B').split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
    check(want.length && want.every(k => SHARDS[k]), `shards must be letters from A,B,C,D; got ${p.shards}`);
    const hall = Number(p.hall) || ROOMS.hall;
    const shamanRooms = String(p.shamanRooms ?? '').split(/[\s,]+/).map(Number).filter(n => Number.isInteger(n) && n > 0);
    const pose = (room, label) => A(postureStep(TAG, room, { fleeBelow: p.fleeBelow, restBelow: p.restBelow }, label));
    const goIf = (to, cond, candidates) => ({ ...walk(st => (cond(st) ? to : null), { candidates }), optional: true });
    const evil = st => st.q?.side === 'evil';
    const hasFeather = st => !!st.q?.feather;

    // The escort route is the map's, planned once at compile time (as the earlier riija-sword did).
    const map = loadMap(movementMapFile());
    const route = want.includes('B') ? findPath(map, ROOMS.hive, ROOMS.scientist) : { found: true, hops: [] };
    check(route.found, `No queen escort route from ${ROOMS.hive} to ${ROOMS.scientist}: ${route.reason}`);

    const steps = [
      // ---- who, which side, what is held, what is open.
      A(verify(async ctx => {
        const v = await view(ctx), s = await ctx.call('status', { agent: ctx.agent, brief: false }, 30_000);
        const character = s?.character ?? v?.you?.name;
        check(typeof character === 'string' && character.length, 'Cannot identify the quester.');
        const side = karmaSide(s?.karma?.value ?? s?.karma);
        const saved = loadRun(ledgerId(ctx.agent), { fleet: ctx.fleet });
        check(!saved || saved.character === character, 'The questbook entry belongs to another character; inspect it before reusing this agent id.');
        const record = saved ?? { character, icons: {}, open: {}, heard: [] };
        record.icons ??= {}; record.open ??= {}; record.heard ??= [];
        if (p.reset === true || p.reset === 'true') {
          check(Object.values(record.open).every(o => Date.now() >= o.deadline), 'reset will not discard an unexpired node.');
          record.open = {};
        }
        ctx.state.q = { record, open: record.open, side, want, needed: [...want], parts: {}, complete: false };
        const pack = await refresh(ctx);
        if (ctx.state.q.complete) return { ok: true, already: 'sword held and bound' };
        // Hanla and Wulfgang refuse a neutral character in silence, so refuse here instead.
        check(side || !ctx.state.q.needed.some(k => k === 'C' || k === 'D'),
          `karma ${s?.karma?.value ?? '?'} is between -10 and +10: Wulfgang and Hanla assign nothing (quest.kod:126-134).`);
        ctx.state.q.feather = count(pack, ITEMS.feather.match) > 0;
        // THE KIT: what is certain to be needed, drawn before the first question opens a clock.
        // Totals per item first (a pie shipment and the queen's pies are ONE stack), then only what the
        // pack does not already hold.
        const total = new Map();
        const want1 = (key, amount) => total.set(key, (total.get(key) ?? 0) + amount);
        if (need(ctx.state, 'A')) want1('head', 1);
        if (need(ctx.state, 'D') && side === 'good' && !ctx.state.q.feather && !record.open.D?.oreAttempt) want1('nerudite', 1);
        if (need(ctx.state, 'B')) want1('meatPie', Number(p.queenPies) || 1);
        const sh = record.open.C?.shipment;
        if (need(ctx.state, 'C') && sh) want1(sh.key, sh.amount);
        const kit = [...total].map(([key, amount]) => ({ key, need: amount, amount: amount - count(pack, ITEMS[key].match) }))
          .filter(k => k.amount > 0);
        ctx.state.q.kit = kit;
        persist(ctx);
        return { ok: true, character, side, needed: ctx.state.q.needed, kit: kit.map(k => `${k.amount} ${ITEMS[k.key].name}`),
          resumed: Object.keys(record.open) };
      }, 'who, which karma side, which shards are held, which nodes are open')),

      // ---- the kit, from the hall.
      goIf(hall, st => st.q?.kit?.length > 0, [hall]),
      A(verify(ctx => drawFromHall(ctx, ctx.state.q?.kit ?? [], hall), 'draw the certain kit from the hall')),

      // ---- C, the crosspiece: Wulfgang names one row of his karma table.
      pose(st => (need(st, 'C') ? ROOMS.trader : null), NPCS.trader),
      goIf(ROOMS.trader, st => need(st, 'C'), [ROOMS.trader]),
      A(verify(async ctx => {
        if (!need(ctx.state, 'C')) return { ok: true, skipped: 'held' };
        await view(ctx);
        const r = await ask(ctx, 'C', LINES.C);
        const sh = ctx.state.q.record.open.C?.shipment;
        const pack = await inventory(ctx);
        const extra = sh?.key === 'meatPie' && need(ctx.state, 'B') ? 1 : 0;
        const stack = biggest(pack, ITEMS[sh.key].match);
        const short = (Number(stack?.amount) || (stack ? 1 : 0)) < sh.amount + extra;
        ctx.state.q.drawC = short ? [{ key: sh.key, amount: sh.amount + extra - count(pack, ITEMS[sh.key].match), need: sh.amount + extra }] : null;
        if (ctx.state.q.drawC && ctx.state.q.drawC[0].amount <= 0) ctx.state.q.drawC[0].amount = sh.amount;   // split stacks: draw a whole one
        return { ...r, shipment: `${sh.amount} ${sh.name}`, draw: !!ctx.state.q.drawC };
      }, "ask Wulfgang 'inventory' and record the shipment")),
      goIf(hall, st => need(st, 'C') && !!st.q?.drawC, [hall]),
      A(verify(ctx => (ctx.state.q?.drawC ? drawFromHall(ctx, ctx.state.q.drawC, hall) : { ok: true, skipped: 'carried' }),
        'draw the named shipment from the hall')),
      goIf(ROOMS.trader, st => need(st, 'C') && !!st.q?.drawC, [ROOMS.trader]),
      A(verify(async ctx => {
        if (!need(ctx.state, 'C')) return { ok: true, skipped: 'held' };
        await view(ctx);
        check(ctx.state.here === ROOMS.trader, `Not back at ${ROOMS.trader} with the shipment.`);
        const sh = ctx.state.q.record.open.C.shipment;
        return handIn(ctx, 'C', NPCS.trader, ITEMS[sh.key].match, sh.amount);
      }, 'deliver exactly the requested shipment')),

      // ---- D, the handle: Hanla. Karma decides the route.
      pose(st => (need(st, 'D') ? ROOMS.bowmaker : null), NPCS.bowmaker),
      goIf(ROOMS.bowmaker, st => need(st, 'D') && !st.q?.record?.open?.D, [ROOMS.bowmaker]),
      A(verify(async ctx => {
        if (!need(ctx.state, 'D')) return { ok: true, skipped: 'held' };
        if (ctx.state.q.record.open.D) return { ok: true, resumed: ctx.state.q.record.open.D };
        await view(ctx);
        return ask(ctx, 'D', evil(ctx.state) ? LINES.Devil : LINES.Dgood);
      }, "ask Hanla 'arrows'")),
      // good: ore to the Bone Priestess; she hands back the feather (node 39 -> node 40 gives it).
      goIf(ROOMS.priestess, st => need(st, 'D') && !evil(st) && !hasFeather(st), [ROOMS.priestess]),
      A(verify(async ctx => {
        const q = ctx.state.q;
        if (!need(ctx.state, 'D') || evil(ctx.state)) return { ok: true, skipped: true };
        if (count(await inventory(ctx), ITEMS.feather.match)) { q.feather = true; return { ok: true, feather: 'already carried' }; }
        await view(ctx);
        const open = q.record.open.D;
        check(open && Date.now() < open.deadline - NODE_MARGIN_MS, 'Hanla\'s node is not open or is about to expire.');
        check(!open.oreAttempt, 'An earlier nerudite offer is unresolved; inspect before sending more ore.');
        const started = Date.now();
        await offer(ctx, NPCS.priestess, ITEMS.nerudite.match, 1, { deadline: open.deadline,
          beforeSend: () => { open.oreAttempt = { at: started }; persist(ctx); } });
        for (let i = 0; i < 6; i++) {
          if (count(await inventory(ctx), ITEMS.feather.match)) {
            open.deadline = started + NODE_MS;          // node 40 is a fresh hour (questnode.kod:615-616)
            q.feather = true; persist(ctx);
            return { ok: true, feather: 'received' };
          }
          await sleep(1000);
        }
        throw Error('No feather arrived after the ore; do not repeat the nerudite offer blindly.');
      }, 'trade the nerudite for the quest feather')),
      // evil: the quester's own kill of an avar shaman, the feather picked up off the floor.
      ...shamanRooms.flatMap(room => [
        goIf(room, st => need(st, 'D') && evil(st) && !hasFeather(st) && !!st.q?.record?.open?.D, shamanRooms),
        { ...harvest({ quarry: ['avar shaman'], room, forMs: Number(p.huntMin) * 60_000,
          until: async ({ agent, call, state }) => {
            const pack = (await call('inventory', { agent }, 60_000).catch(() => null))?.items ?? [];
            if (count(pack, ITEMS.feather.match)) { state.q.feather = true; return { done: true }; }
            const v = await call('look', { agent }, 30_000).catch(() => null);
            const f = (v?.objects ?? []).find(o => ITEMS.feather.match.test(String(o.name ?? '')));
            if (f) await call('loot', { agent, ids: [f.id] }, 60_000).catch(() => null);
            return { done: false, note: f ? 'feather on the floor; picking it up' : 'no feather yet' };
          } }), optional: true },
        A(verify(async ({ state }) => { state.postureRoom = null; return { ok: true }; }, 'the farm posture is over')),
      ]),
      A(verify(async ctx => {
        if (!need(ctx.state, 'D')) return { ok: true, skipped: true };
        const n = count(await inventory(ctx), ITEMS.feather.match);
        check(n > 0, evil(ctx.state) ? `No feather of an avar shaman after hunting ${shamanRooms.join(', ')}. ` +
          'The kill must be the quester\'s own; the node stays open -- re-run inside its hour.' : 'No feather in the pack.');
        ctx.state.q.feather = true;
        return { ok: true, feather: n };
      }, 'the feather is in the pack')),
      goIf(ROOMS.bowmaker, st => need(st, 'D'), [ROOMS.bowmaker]),
      A(verify(async ctx => { await view(ctx); return handIn(ctx, 'D', NPCS.bowmaker, ITEMS.feather.match, 1); }, 'deliver the feather to Hanla')),

      // ---- A, the tip: the Bone Priestess and the head (anyone's kill counts).
      pose(st => (need(st, 'A') ? ROOMS.priestess : null), NPCS.priestess),
      goIf(ROOMS.priestess, st => need(st, 'A'), [ROOMS.priestess]),
      A(verify(async ctx => { if (!need(ctx.state, 'A')) return { ok: true, skipped: true }; await view(ctx); return ask(ctx, 'A', LINES.A); },
        "ask the Bone Priestess 'riija'")),
      A(verify(ctx => handIn(ctx, 'A', NPCS.priestess, ITEMS.head.match, 1), 'deliver the orc pit boss head')),

      // ---- B, the blade: Bahal wants a live dragonfly queen in his hut.
      pose(st => (need(st, 'B') ? ROOMS.scientist : null), NPCS.scientist),
      goIf(ROOMS.scientist, st => need(st, 'B') && !st.q?.record?.open?.B, [ROOMS.scientist]),
      A(verify(async ctx => {
        if (!need(ctx.state, 'B')) return { ok: true, skipped: true };
        if (ctx.state.q.record.open.B) return { ok: true, resumed: ctx.state.q.record.open.B };
        await view(ctx); return ask(ctx, 'B', LINES.B);
      }, "ask Bahal 'kohuzotz'")),
      goIf(ROOMS.hive, st => need(st, 'B'), [ROOMS.hive]),
      A(verify(async ctx => {
        if (!need(ctx.state, 'B')) return { ok: true, skipped: true };
        const open = ctx.state.q.record.open.B;
        check(open && Date.now() < open.deadline - NODE_MARGIN_MS, 'Bahal\'s node is not open or is about to expire.');
        // Queens are 10% of Cliff Hive's spawns, one roll every 90 s at 70% (ka1.kod:44-57): wait.
        const until = Math.min(Date.now() + Number(p.queenWaitMin) * 60_000, open.deadline - NODE_MARGIN_MS);
        let q = null;
        for (;;) {
          const v = await view(ctx);
          check(ctx.state.here === ROOMS.hive, `Not at Cliff Hive (${ROOMS.hive}).`);
          q = v.objects?.find(o => lc(o.name) === 'dragonfly queen');
          if (q || Date.now() >= until) break;
          await sleep(15_000);
        }
        check(q, `No dragonfly queen at Cliff Hive within ${p.queenWaitMin} min; the node stays open, re-run inside the hour.`);
        const cursor = (await ctx.call('wait_for_event', { agent: ctx.agent, kinds: ['message', 'said'], timeout_ms: 1 }, 30_000))?.cursor;
        await offer(ctx, 'dragonfly queen', ITEMS.meatPie.match, 1, { targetId: q.id, deadline: open.deadline });
        const lines = cursor == null ? [] : (await hear(ctx, cursor, 5000)).map(x => x.text);
        ctx.state.q.queen = q.id;
        // The adoration line is the charm's only receipt; a silence is reported, not assumed a failure.
        return { ok: true, queen: q.id, charmed: lines.some(s => LINES.queen.test(s)) ? 'adoration' : 'unconfirmed' };
      }, 'charm a live queen with one meat pie')),
    ];

    // The escort, hop by hop: stand AT the departure, wait for THE SAME queen, then cross.
    for (const hop of route.hops) {
      steps.push(A(verify(async ctx => {
        if (!need(ctx.state, 'B')) { ctx.state.edgeStage = null; return { ok: true, skipped: true }; }
        const v = await view(ctx);
        check(roomOf(v) === Number(hop.from), `Escort is in ${roomOf(v)}, expected ${hop.from}.`);
        const room = map.rooms[hop.from];
        const edge = room.edgeExits?.find(e => Number(e.to) === Number(hop.to) && e.leaveName === hop.direction);
        check(hop.kind === 'go' || edge, 'The escort route has no matching declared exit.');
        const candidates = hop.kind === 'go' ? [{ row: hop.row, col: hop.col }]
          : edgeCandidatesOf(room, edge, null, { live: true }).flatMap(c => c.stages ?? [c]);
        check(candidates.length, 'No validated departure square for the escort.');
        candidates.sort((a, b) => Math.hypot(a.row - v.you.row, a.col - v.you.col) - Math.hypot(b.row - v.you.row, b.col - v.you.col));
        ctx.state.edgeStage = candidates[0];
        return { ok: true, departure: ctx.state.edgeStage };
      }, `escort: choose the departure ${hop.from} -> ${hop.to}`)),
      { ...walkTo(st => st.edgeStage?.col ?? null, st => st.edgeStage?.row ?? null, { within: 0, arriveWithin: 0, deadlineMs: 180_000 }),
        room: st => (need(st, 'B') ? Number(hop.from) : null), optional: true, anywhere: true },
      A(verify(async ctx => {
        if (!need(ctx.state, 'B')) return { ok: true, skipped: true };
        check(Date.now() < ctx.state.q.record.open.B?.deadline - NODE_MARGIN_MS, 'The queen node is about to expire.');
        for (let i = 0; i < 20; i++) {
          const v = await view(ctx);
          check(roomOf(v) === Number(hop.from), 'Escort is in an unexpected room.');
          if (queenNear(v, ctx.state.q.queen)) return { ok: true, queen_near: true };
          await sleep(1500);
        }
        throw Error('The queen is lost or not within two squares; escort stopped (the node stays open).');
      }, 'escort: wait for the same queen')),
      goIf(Number(hop.to), st => need(st, 'B'), [Number(hop.to)]));
    }

    steps.push(
      A(verify(async ctx => {
        if (!need(ctx.state, 'B')) return { ok: true, skipped: true };
        const before = await inventory(ctx);
        const v = await view(ctx);
        check(roomOf(v) === ROOMS.scientist && v.objects?.some(o => o.id === ctx.state.q.queen),
          'The escorted queen is not in the hut with the quester.');
        check(Date.now() < ctx.state.q.record.open.B?.deadline, 'Queen node expired.');
        const said = await conversation(ctx, NPCS.scientist, SHARDS.B.trigger);
        check(said.ok && said.spoken_ok, said.why ?? 'Bahal could not hear the delivery.');
        return reward(ctx, 'B', before);
      }, 'deliver the live queen and verify the blade')),

      // ---- the sword: proved by its runes, then wielded and read back off the use list.
      { ...verify(async ctx => {
        const q = ctx.state.q;
        if (!q) return { ok: false, why: 'never started' };
        await refresh(ctx);
        if (!q.complete && !q.needed.length && q.want.length < 4)
          return { ok: true, shards: q.want, sword: 'not yet -- the other shards were not asked for this run' };
        if (!q.complete) return { ok: false, still_needed: q.needed, open: Object.keys(q.record.open),
          why: `no bound sword yet; still needed: ${q.needed.join(', ')}` };
        q.record.outcome = 'ok'; persist(ctx);
        if (!(p.wield === true || p.wield === 'true')) return { ok: true, sword: 'held, not wielded' };
        const eq0 = await ctx.call('equipment', { agent: ctx.agent }, 30_000).catch(() => null);
        if (wielding(eq0)) return { ok: true, sword: 'held and wielded' };
        await ctx.call('act', { agent: ctx.agent, verb: 'use', target: q.sword.id }, 30_000).catch(() => null);
        const eq = await ctx.call('equipment', { agent: ctx.agent }, 30_000).catch(() => null);
        return wielding(eq) ? { ok: true, sword: 'held and wielded' }
          : { ok: false, why: 'the sword is held and bound but the use list does not show it wielded (short-sword proficiency? hands full?)' };
      }, 'prove the sword and wield it'), always: true, anywhere: true },
      restorePostureStep(TAG),
    );
    if (Number(p.home) > 0) steps.push({ ...walk(Number(p.home)), always: true });
    return steps;
  },
};

const wielding = eq => (eq?.wielding ?? eq?.equipped ?? []).some(w => ITEMS.sword.match.test(String(w?.name ?? w)));

// The server's follow hook compares without abs() (monster.kod:933-980); this is the stricter
// symmetric reading, by id, so a different queen never counts as ours.
export function queenNear(v, id, distance = 2) {
  const q = v?.objects?.find(o => o.id === id && lc(o.name) === 'dragonfly queen');
  const me = v?.you;
  return !!q && [q.row, q.col, me?.row, me?.col].every(Number.isFinite)
    && Math.max(Math.abs(q.row - me.row), Math.abs(q.col - me.col)) <= distance;
}
