// BUY ANYTHING FROM ANYONE: ONE ERRAND IN PLACE OF A SCRIPT PER ITEM PER SHOP.
//
// PUBLIC, 2026-10-21. Operator: "I see a buy-purple FleetScript that's specialized down to buying
// specifically purple mushrooms from Zhieu B'hob, why not just a Buy" -- agents, amount, the shop,
// an optional withdrawal at a chosen bank, and the item picked from what that shop sells. The local
// pads it generalises (buy-purple, buy-wings, kraanan-buy, hammers-from-barloque, mace-from-rook,
// ...) each hard-coded one seller, one room and one regex; this takes all three as parameters, and
// the MANAGE tab fills them from the merchant catalogue (m59-plan-kinds.mjs: `merchant`, `item`).
//
//   buy agents=t20 seller=Zhieu%20B'hob item=purple%20mushroom amount=150 withdraw=18000 bank=376 back=38
//   buy agents=t9 seller=Maleval item=learn:curse%20weapon search=fleet waitMin=240
//
// WHAT IT DOES, per agent: withdraw at `bank` (if asked) -> get to the seller -> buy `amount`
// (in counters of 50, as buy-purple did), or LEARN the ability when the item is "learn:<name>" ->
// verify by count (goods) or by the ability list (learn) -> walk to `back`.
//
// A WANDERER IS FOUND FIRST (Maleval, Parrin Aragone, Miriana, Tendrath, Izzio). Each has a fixed
// list of 4-5 rooms and jumps to a random other one every 30-90 min; a player in his room holds him
// for up to six of those ticks (m59-research/reports/wandering-npcs.md, tools/m59-wanderers.mjs).
// `search` picks how:
//   sweep  one body at a time walks his rooms, the last sighting in the fleet world book first
//   camp   stand in ONE of his rooms (`camp`, or the nearest) and wait for him to jump there --
//          a 1-in-(n-1) chance per tick, so expect hours; cheap in walking, dear in time
//   fleet  the agents fan out, one per room, closest first; the first to see him holds him and
//          the rest walk to him. Bodies past the number of rooms add nothing
//   auto   fleet with two or more agents, otherwise sweep
// `waitMin` bounds the search for every strategy. Nobody buys from a rumour: the buyer looks and
// sees him in the room before the counter.
import { walk, bank, shop, learn, verify } from '../m59-fleetscript.mjs';
import { asAgents } from '../m59-fleetlib.mjs';
import { merchantNamed, bankAt } from '../m59-plan-kinds.mjs';
import { WANDERERS, wandererKey, watchSteps, whereIs, searchOrder, assignPosts, bodiesOf, planOnce, wanderersIn, recordView } from '../m59-wanderers.mjs';
import { call as fsCall } from '../m59-fleetscript.mjs';

const RUNS = new Map();   // run signature -> { at, found } shared by every body of one fleet search
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "purple mushroom" matches the counter's "purple mushroom" or "purple mushrooms"; "herbs" matches "herb".
export const itemMatch = item => {
  const base = String(item).trim().replace(/s$/i, '');
  return new RegExp(`^${esc(base).replace(/\s+/g, '\\s+')}(s|es)?$`, 'i');
};
const countIn = (inv, rx) => (inv?.items ?? []).filter(i => rx.test(String(i.name ?? '').trim()))
  .reduce((n, i) => n + (Number(i.amount) || 1), 0);
const wandererOfSeller = name => {
  try { return wandererKey(name); } catch { /* not by alias */ }
  const f = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return Object.keys(WANDERERS).find(k => f(WANDERERS[k].npc) === f(name)) ?? null;
};

export const script = {
  name: 'buy',
  describe: 'Buy goods (or learn a spell or skill) from any merchant: optional bank withdrawal, find him if he wanders, buy, verify, walk on.',
  recipe: {
    effect: 'Each agent comes away holding `amount` more of the item (or the ability), verified by count.',
    run: 'buy agents=<a,b> seller=<merchant> item=<item|learn:ability> [amount=N] [withdraw=N bank=376|54|2005] [back=<room>] [search=auto|sweep|camp|fleet]',
    needs: ['money: withdraw it here, or carry it', 'for an ability, eligibility -- one the character cannot learn is simply absent from the shelf'],
    cost: { money: 'the goods', time: 'a walk each way; for a wanderer, the search (minutes to hours)', risk: 'the roads between' },
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'who buys; each buys `amount`' },
    seller: { type: 'merchant', required: true, describe: 'the merchant, as the catalogue names him' },
    item: { type: 'item', of: 'seller', required: true, describe: 'what to buy, from his shelf; learn:<name> for a spell or skill he teaches' },
    amount: { type: 'number', default: 1, min: 1, max: 1000, describe: 'how many each agent buys (ignored for an ability)' },
    withdraw: { type: 'number', default: 0, bounds: 'balance', bank: 'bank', describe: 'shillings each agent withdraws first (0: use the purse)' },
    bank: { type: 'bank', default: 0, describe: 'the counter to withdraw at' },
    room: { type: 'room', default: 0, describe: 'where the seller stands (0: his room in the catalogue)' },
    search: { default: 'auto', options: ['auto', 'sweep', 'camp', 'fleet'], describe: 'how to find a wandering seller (ignored for one who stands still)' },
    camp: { type: 'room', default: 0, describe: 'camp: which of his rooms to wait in (0: the first in the search order)' },
    waitMin: { type: 'number', default: 120, min: 5, max: 1440, describe: 'how long to look for a wanderer before giving up' },
    back: { type: 'room', default: 0, describe: 'where to walk afterwards (0: stay at the counter)' },
  },

  async steps(p) {
    const agent = p.agent, agents = asAgents(p.agents);
    const m = merchantNamed(null, p.seller);
    const seller = m?.name ?? String(p.seller);
    const item = String(p.item).trim();
    const ability = /^learn:/i.test(item) ? item.replace(/^learn:\s*/i, '') : null;
    const n = Math.max(1, Math.trunc(Number(p.amount) || 1));
    const withdraw = Math.max(0, Math.trunc(Number(p.withdraw) || 0));
    const bankRoom = Number(p.bank) || 0, back = Number(p.back) || 0;
    if (withdraw > 0 && !bankAt(bankRoom)) throw Error(`withdraw=${withdraw} needs bank=376 (Jasper), 54 (Tos) or 2005 (Ko'catan)`);
    const key = wandererOfSeller(seller);

    const steps = [];
    if (withdraw > 0) steps.push(walk(bankRoom, { why: `${bankAt(bankRoom).name}: money for ${seller}` }), bank('withdraw', withdraw));

    if (!key) {
      const at = Number(p.room) || m?.rooms?.[0];
      if (!at) throw Error(`no room on record for ${seller}; give room=<n>`);
      steps.push(walk(at, { why: `${seller}: ${ability ? `learn ${ability}` : `${n} ${item}`}` }));
    } else {
      steps.push(...await searchFor(key, p, agents));
      const rooms = WANDERERS[key].rooms;
      steps.push(walk(st => st.found?.room ?? whereIs(key).room ?? st.watch?.here ?? rooms[0], { candidates: rooms, why: `to ${WANDERERS[key].npc}` }));
      steps.push(verify(async ({ call, state }) => {
        const v = await call('look', { agent }, 30_000).catch(() => null);
        const here = recordView(v, agent).includes(key) || wanderersIn(v).includes(key);
        return here ? true : { ok: false, why: `${WANDERERS[key].npc} is not in ${v?.room?.num ?? '?'} (he moves every 30-90 min); nothing was bought` };
      }, `${WANDERERS[key].npc} is here`));
    }

    if (ability) {
      steps.push(learn(seller, ability, { retry: true }));
    } else {
      const rx = itemMatch(item);
      let before = null;
      steps.push(verify(async ({ call }) => { before = countIn(await call('inventory', { agent }, 60_000), rx); return true; }, 'count before'));
      for (let left = n; left > 0; left -= 50) steps.push(shop(seller, [{ match: rx, amount: Math.min(50, left) }], { optional: true }));
      steps.push(verify(async ({ call }) => {
        const after = countIn(await call('inventory', { agent }, 60_000), rx);
        console.log(`  ${agent}: ${item} ${before} -> ${after} (asked ${n})`);
        return after > before ? true : { ok: false, why: `none bought (${before} -> ${after})` };
      }, `${item} in the pack`));
    }
    if (back > 0) steps.push({ ...walk(back, { why: 'back' }), always: true });
    return steps;
  },
};

// The search steps for one body. `fleet` shares one assignment and one sighting across the run.
async function searchFor(key, p, agents) {
  const mode = p.search === 'auto' ? (agents.length > 1 ? 'fleet' : 'sweep') : String(p.search);
  const until = Date.now() + Number(p.waitMin || 120) * 60_000;
  const sig = `buy|${key}|${agents.join(',')}|${mode}`;
  const run = RUNS.get(sig) && Date.now() - RUNS.get(sig).at < 60_000 ? RUNS.get(sig) : { at: Date.now(), found: null };
  RUNS.set(sig, run);
  const remember = { ...verify(({ state }) => { state.found = run.found ?? (whereIs(key).fresh ? { room: whereIs(key).room } : null); return true; }, 'where he was seen'), always: true };
  if (mode === 'camp') {
    const post = Number(p.camp) || searchOrder(key)[0];
    if (!WANDERERS[key].rooms.includes(post)) throw Error(`camp=${post} is not one of ${WANDERERS[key].npc}'s rooms (${WANDERERS[key].rooms.join(', ')})`);
    return [...watchSteps({ keys: key, route: [post], mode: 'find', until, shared: run, label: `camp ${post}` }), remember];
  }
  if (mode === 'sweep') return [...watchSteps({ keys: key, route: searchOrder(key), mode: 'find', until, shared: run, label: 'sweep' }), remember];
  if (mode !== 'fleet') throw Error(`search must be auto, sweep, camp or fleet, not ${p.search}`);
  // FLEET: one assignment per run (find-wanderer.mjs does the same), the closest body to each room.
  // A body left without a post (more bodies than rooms) waits where it is for the sighting.
  const plan = await planOnce(sig, async () => assignPosts(WANDERERS[key].rooms, await bodiesOf(fsCall, agents)));
  const route = plan.get(p.agent);
  if (route) return [...watchSteps({ keys: key, route, mode: 'find', until, shared: run, label: `post ${route.join('>')}` }), remember];
  return [verify(async () => {
    while (Date.now() < until && !run.found && !whereIs(key).fresh) await new Promise(r => setTimeout(r, 30_000));
    return run.found || whereIs(key).fresh ? true : { ok: false, why: `${WANDERERS[key].npc} was not seen within ${p.waitMin} min` };
  }, 'wait for the sighting'), remember];
}
