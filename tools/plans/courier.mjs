// PLAN ROWS: THE COURIER (Zheng He's lap, substrate/fleetscripts/zheng-he-lap.mjs).
//
// Every knob this lap has lives in files it re-reads at the start of a lap, so asking it
// for something is writing a file — never interrupting the courier mid-trade:
//   courier-requests.json   standing top-up targets   { agent: { item: count } }
//   zheng-he-next-lap.json  one-shot "only this" order { only, why, to }
//   courier-holds.json      room kept for a person's goods, and the human half of the
//                           trade at home (m59-human-handoff.mjs)
//   courier-settings.json   per person: { mode: 'auto'|'manual', instructions: bool } — the
//                           "Automated Courier" settings row. Full Auto means the proxy does the
//                           person's half of the trade (m59-proxy-trade.mjs); this provider's
//                           tick() tells it when, from the presence the client reports
//   courier-wishlist.json   things asked for that the lap has NO shopping line for — kept
//                           apart so the lap's own arithmetic never sees an item it
//                           cannot buy, and so the gap is visible instead of silent
//
// REFLECTION: the options are read out of the lap's SOURCE (its SHOPPING and POOL
// tables), not imported. Importing a FleetScript pulls in the broker RPC layer and the
// map; reading its text works on whichever copy a deployment runs, including one this
// checkout has never seen. The merchants in the towns those lines name come from
// m59-merchants.json, which is how a request can offer "everything Joguer stocks" and say
// which of those the lap actually knows how to buy.

import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { findSession } from './control.mjs';

const LAP = 'zheng-he-lap';
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const fold = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/(ies)$/, 'y').replace(/(es|s)$/, '');
const spaced = cls => String(cls).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')) ?? d; } catch { return d; } };
const writeJson = (f, v) => { writeFileSync(f + '.tmp', JSON.stringify(v, null, 1)); renameSync(f + '.tmp', f); };

// The lap's SHOPPING table, line by line: { item, seller, room, max }.
export function reflectShopping(src) {
  const out = [];
  const block = src.slice(src.indexOf('const SHOPPING'), src.indexOf('];', src.indexOf('const SHOPPING')));
  for (const m of block.matchAll(/\{\s*item:\s*'([^']+)'[^}]*?seller:\s*(["'])(.*?)\2,\s*room:\s*(\d+)[^}]*?max:\s*(\d+)/g))
    out.push({ item: m[1], seller: m[3], room: Number(m[4]), max: Number(m[5]) });
  return out;
}
// The POOL: what the courier takes off people to sell. Regex sources, turned into names.
export function reflectPool(src) {
  const block = src.slice(src.indexOf('const POOL'), src.indexOf('];', src.indexOf('const POOL')));
  return [...block.matchAll(/rx:\s*\/(.+?)\/i,\s*sell:\s*\{\s*seller:\s*'([^']+)',\s*room:\s*(\d+)/g)]
    .map(m => ({ rx: new RegExp(m[1], 'i'), seller: m[2], room: Number(m[3]) }));
}

export function lapState(substrate, fleet) {
  const file = join(substrate, 'fleetscripts', `${LAP}.mjs`);
  if (!existsSync(file)) return null;
  const src = readFileSync(file, 'utf8');
  const loops = join(substrate, 'history', fleet || 'default', 'loops');
  const pidFile = join(loops, `${LAP}-repeat.pid`);
  const loopPid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : null;
  let agent = (src.match(/agents=([a-z0-9]+)/) ?? [])[1] ?? null, running = !!(loopPid && alive(loopPid)), lapNow = false;
  for (const f of existsSync(substrate) ? readdirSync(substrate).filter(f => /^run-.*\.lock$/.test(f)) : []) {
    const l = readJson(join(substrate, f), null);
    if (l?.label?.includes(LAP) && l.pid && alive(l.pid)) { lapNow = true; agent = l.agent ?? agent; }
  }
  return { file, src, agent, running: running || lapNow, lapNow, shopping: reflectShopping(src), pool: reflectPool(src) };
}

export function townStock(shopping, merchantsFile) {
  const rooms = new Set(shopping.map(s => s.room));
  const m = readJson(merchantsFile, {}).merchants ?? [];
  const rows = new Map();
  for (const mer of m.filter(x => rooms.has(x.room)))
    for (const s of mer.sells ?? []) {
      const name = spaced(s.cls), key = fold(name);
      if (!rows.has(key)) rows.set(key, { name, room: mer.room, merchant: spaced(mer.cls) });
    }
  return [...rows.values()];
}

export function itemOptions(lap, merchantsFile) {
  const known = new Map(lap.shopping.map(s => [fold(s.item), s]));
  const opts = lap.shopping.map(s => ({ value: s.item, label: `${s.item} — ${s.seller} (${s.room})${s.max ? '' : ', on request'}` }));
  for (const t of townStock(lap.shopping, merchantsFile))
    if (!known.has(fold(t.name))) opts.push({ value: `wish:${t.name}`, label: `${t.name} — ${t.merchant} (${t.room}), NOT a lap line: wishlist only` });
  return opts;
}

export const MODES = [{ value: 'auto', label: 'Full Auto — the proxy trades for you; no window opens' },
                      { value: 'manual', label: 'Manual — you offer and accept in your own trade window' }];
export function settingsFor(substrate, agent) {
  const s = readJson(join(substrate, 'courier-settings.json'), {})[agent] ?? {};
  return { mode: s.mode === 'auto' ? 'auto' : 'manual', instructions: s.instructions !== false };
}
const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const lastGive = new Map();   // agent -> the ready.at it already answered

export const provider = {
  id: 'courier',
  // FULL AUTO, every desk tick. When the person chose Full Auto and the courier is standing in
  // their room (by the client's own room list), the proxy is told to accept the courier's offers;
  // and when the lap has said it is ready to collect a hold, the proxy offers the held goods.
  async tick(ctx) {
    const me = ctx.client.agent;
    if (!me || settingsFor(ctx.substrate, me).mode !== 'auto') return;
    const lap = lapState(ctx.substrate, ctx.fleet);
    const courier = ctx.agents.find(a => a.agent === lap?.agent);
    const there = courier?.character && ctx.client.room.find(o => sameName(o.name, courier.character));
    if (!there) return;
    const found = await findSession(ctx.client);
    if (!found) return;
    const post = (path, body) => fetch(`http://127.0.0.1:${found.advert.gate_control}${path}?player=${found.session.player_id}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) })
      .then(r => r.json()).catch(e => ({ ok: false, why: e.message }));
    await post('/trade/accept-from', { from_id: there.id, ttl_ms: 15_000 });
    const ready = readJson(join(ctx.substrate, 'courier-ready.json'), {})[me];
    const hold = readJson(join(ctx.substrate, 'courier-holds.json'), {})[me];
    if (!ready || !hold || ctx.now - ready.at > 90_000 || lastGive.get(me) === ready.at) return;
    const items = Object.entries(hold.items ?? {}).map(([name, n]) => {
      const inv = ctx.client.inventory.find(i => fold(i.name) === fold(name));
      return inv ? { id: inv.id, amount: Math.min(Number(n) || 0, inv.amount) } : null;
    }).filter(x => x && x.amount > 0);
    lastGive.set(me, ready.at);
    if (!items.length) { ctx.log(`[plan ${me}] courier ready but none of the held goods are in the pack`); return; }
    const r = await post('/trade/give', { to_id: there.id, items, ttl_ms: 60_000 });
    ctx.log(`[plan ${me}] full auto: offered ${items.map(i => i.amount).join('+')} to ${courier.character}: ${r.ok ? 'sent' : r.why}`);
  },
  entries(ctx) {
    const lap = lapState(ctx.substrate, ctx.fleet);
    if (!lap) return [];
    const me = ctx.client.agent;
    const reqFile = join(ctx.substrate, 'courier-requests.json');
    const mine = readJson(reqFile, {})[me] ?? {};
    const holds = readJson(join(ctx.substrate, 'courier-holds.json'), {})[me]?.items ?? {};
    const who = [{ value: me ?? '', label: `me (${ctx.client.character})` },
                 ...ctx.agents.filter(a => a.agent !== me).map(a => ({ value: a.agent, label: `${a.agent}${a.character ? ' — ' + a.character : ''}` }))];
    const items = itemOptions(lap, join(ctx.harness, 'substrate', 'm59-merchants.json'));
    const sellable = ctx.client.inventory.filter(i => lap.pool.some(p => p.rx.test(i.name.trim())));
    const status = `${lap.agent ?? 'the courier'} — ${lap.lapNow ? 'on a lap now' : lap.running ? 'looping between laps' : 'NOT running'}`;
    const set = settingsFor(ctx.substrate, me);
    const rows = [
      { id: 'courier.settings', group: 'Courier', icon: 'scroll', configure: true, disabled: !me,
        title: `Automated Courier: ${set.mode === 'auto' ? 'Full Auto' : 'Manual'}${set.instructions ? ', with instructions' : ''}`,
        describe: 'How the courier trades with YOU while you are at the keyboard. Full Auto: the proxy carrying your client ' +
          'offers your held goods and accepts your deliveries itself — no trade window opens, items simply arrive and leave. ' +
          'Needs a gate-capable proxy (see Control). Manual: you work the trade window yourself. ' +
          'Instructions: the courier sends you a private tell saying what it is doing or what to offer.',
        args: [{ id: 'mode', title: 'Handling', type: 'choice', options: MODES, default: set.mode },
               { id: 'instructions', title: 'With instruction text (a private tell)', type: 'boolean', default: String(set.instructions) }] },
      { id: 'courier.request', group: 'Courier', icon: 'elderberry', running: lap.running, disabled: !me,
        title: 'Request a delivery from the courier',
        describe: `${status}. Sets a standing top-up target: every lap buys the total of all requests and tops the requester ` +
          'up first. Delivery to a character YOU are piloting is a trade you accept in your own client at home (38).',
        args: [{ id: 'item', title: 'Item', type: 'choice', options: items },
               { id: 'count', title: 'Top up to', type: 'count', default: '20' },
               { id: 'for', title: 'For', type: 'choice', options: who, default: me ?? '' }] },
      { id: 'courier.carry', group: 'Courier', icon: 'diamond', running: lap.running, disabled: !me || !sellable.length,
        title: 'Have the courier carry my goods to sell',
        describe: sellable.length ? `${status}. Keeps room in the pack for these and, at home (38), waits for you to OFFER them ` +
            `to ${lap.agent ?? 'the courier'} — he counters with nothing, you accept. Sold on his next town trip.`
          : `Nothing you carry is something the lap sells (${lap.pool.map(p => p.rx.source).join(', ')}).`,
        args: [{ id: 'item', title: 'Item', type: 'choice', options: sellable.map(i => ({ value: i.name, label: `${i.name} (you hold ${i.amount})` })) },
               { id: 'count', title: 'How many', type: 'count', default: String(sellable[0]?.amount ?? 1) }] },
      { id: 'courier.next', group: 'Courier', icon: 'scroll', running: lap.running, disabled: !me,
        title: 'Next lap: bring back only…',
        describe: 'A one-shot order (zheng-he-next-lap.json): sell as usual, buy only this line with the whole pack, come straight home. ' +
                  'Retired by the lap itself once it has handed the goods out.',
        args: [{ id: 'item', title: 'Item', type: 'choice', options: lap.shopping.map(s => ({ value: s.item, label: `${s.item} — ${s.seller}` })) }] },
    ];
    for (const [item, n] of Object.entries(mine))
      rows.push({ id: `courier.cancel.${fold(item)}`.slice(0, 100), group: 'Courier', icon: item, running: true,
        title: `Cancel my standing request: ${item} to ${n}`, describe: 'Removes it from courier-requests.json; the next lap stops buying it for you.',
        _item: item });
    for (const [item, n] of Object.entries(holds))
      rows.push({ id: `courier.unhold.${fold(item)}`.slice(0, 100), group: 'Courier', icon: item, running: true,
        title: `Stop holding room for my ${n} ${item}`, describe: 'Removes the hold from courier-holds.json.', _item: item });
    return rows;
  },
  run(entry, args, ctx, e) {
    const me = ctx.client.agent, S = ctx.substrate;
    if (!me) return { ok: false, message: 'this account is not in the fleet roster' };
    if (entry === 'courier.settings') {
      const f = join(S, 'courier-settings.json'), all = readJson(f, {});
      all[me] = { mode: args.mode === 'auto' ? 'auto' : 'manual', instructions: args.instructions === 'true', at: Date.now(), by: 'plan-desk' };
      writeJson(f, all);
      return { ok: true, message: `Automated Courier: ${all[me].mode === 'auto' ? 'Full Auto' : 'Manual'}, instructions ${all[me].instructions ? 'on' : 'off'}.` };
    }
    if (entry === 'courier.request') {
      const to = args.for || me, n = Number(args.count);
      if (args.item.startsWith('wish:')) {
        const f = join(S, 'courier-wishlist.json'), w = readJson(f, {});
        (w[to] ??= {})[args.item.slice(5)] = { count: n, at: Date.now(), by: `plan-desk:${me}` }; writeJson(f, w);
        return { ok: true, message: `${args.item.slice(5)} is on the wishlist for ${to}. The lap has no shopping line for it, so it will NOT be bought until someone adds one.` };
      }
      const f = join(S, 'courier-requests.json'), r = readJson(f, {});
      if (n === 0) { delete r[to]?.[args.item]; } else (r[to] ??= {})[args.item] = n;
      if (r[to] && !Object.keys(r[to]).length) delete r[to];
      writeJson(f, r);
      return { ok: true, message: n ? `Standing request: ${to} topped up to ${n} ${args.item} on every lap.` : `Request for ${args.item} cleared.` };
    }
    if (entry === 'courier.carry') {
      const f = join(S, 'courier-holds.json'), h = readJson(f, {});
      const hold = h[me] ??= { items: {}, character: ctx.client.character, by: 'plan-desk' };
      hold.items[args.item] = Number(args.count); hold.at = Date.now(); hold.character = ctx.client.character;
      writeJson(f, h);
      return { ok: true, message: `Room held for ${args.count} ${args.item}. Be at home (38) when the courier is, and offer them to him when he asks.` };
    }
    if (entry === 'courier.next') {
      const f = join(S, 'zheng-he-next-lap.json');
      if (existsSync(f)) return { ok: false, message: `a next-lap order is already waiting: ${readFileSync(f, 'utf8').slice(0, 200)}` };
      writeJson(f, { only: args.item, why: `PLAN tab, ${ctx.client.character} (${me})`, to: me, at: Date.now() });
      return { ok: true, message: `Next lap brings back only ${args.item}.` };
    }
    if (entry.startsWith('courier.cancel.')) {
      const f = join(S, 'courier-requests.json'), r = readJson(f, {});
      delete r[me]?.[e._item]; if (r[me] && !Object.keys(r[me]).length) delete r[me]; writeJson(f, r);
      return { ok: true, message: `Standing request for ${e._item} cancelled.` };
    }
    if (entry.startsWith('courier.unhold.')) {
      const f = join(S, 'courier-holds.json'), h = readJson(f, {});
      delete h[me]?.items?.[e._item]; if (h[me] && !Object.keys(h[me].items ?? {}).length) delete h[me]; writeJson(f, h);
      return { ok: true, message: `No longer holding room for ${e._item}.` };
    }
    return { ok: false, message: `unknown courier entry ${entry}` };
  },
};
