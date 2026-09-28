// THE EVICTION, WALKED: one character draws a planned overstock out of the guild chests and sells it
// at the merchant in town who stocks it (m59-chest-evict planEviction's `sell_at`). The plan is the
// policy; this is only the legs. Everything it does is on the ledger substrate/history/<fleet>/chest-evict.jsonl.
//
// The character must be able to reach the chests (30+ max health, a guild rank that opens the main
// door, the password) and should be one nobody else is driving: it is walked in, out and to the shops.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeRoom, whatFits } from './m59-vault-broker.mjs';
import { weighItem } from './m59-items.mjs';

const HALL = 714;
const norm = s => String(s ?? '').toLowerCase().trim();
const countOf = (pack, item) => (pack ?? []).filter(o => norm(o.name) === norm(item))
  .reduce((n, o) => n + (Number(o.amount) > 0 ? Number(o.amount) : 1), 0);

// A tool a broker started before it existed (hall_move) goes to the keeper's /action directly, as the
// vault desk does for hall_post.
async function keeperAction(agent, name, args, ms) {
  const { discover, bandFor } = await import('./m59-keeperwhy.mjs');
  const k = (await discover(bandFor('prod', fileURLToPath(new URL('..', import.meta.url)))))[agent];
  if (!k) throw new Error(`no keeper for ${agent}`);
  const r = await fetch(`http://127.0.0.1:${k.port}/action`, { method: 'POST', headers: { 'content-type': 'application/json',
    'x-m59-agent': agent, 'x-m59-character': k.character, 'x-m59-keeper-pid': String(k.pid) },
    body: JSON.stringify({ name, args, agent }), signal: AbortSignal.timeout(ms) });
  const j = await r.json();
  return j?.result ?? j;
}

export function brokerCall(url = process.env.M59_CONTROL_URL || 'http://127.0.0.1:8901') {
  let tools = null;
  return async (name, args, ms = 120_000) => {
    if (name === 'hall_move') {
      if (!tools) tools = await fetch(url.replace(/\/?$/, '/'), { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }).then(r => r.json()).then(j => new Set((j?.result?.tools ?? []).map(t => t.name))).catch(() => new Set());
      if (!tools.has(name)) return keeperAction(args.agent, name, { moves: args.moves }, ms);
    }
    const r = await fetch(url.replace(/\/?$/, '/'), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(ms) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
    const t = j.result?.content?.[0]?.text ?? '';
    try { return JSON.parse(t); } catch { return t; }
  };
}

/**
 * Run a plan's `total` with `agent`. Rounds: draw what fits the pack, walk to each merchant, sell,
 * repeat until everything planned is sold, the chests run out, or six rounds have passed.
 * Returns {sold: {item: n}, proceeds, rounds}.
 */
export async function runEviction({ plan, agent, dry = false, log = console.log, call = brokerCall(),
                                    fleet = 'prod', ledgerFile = null, maxRounds = 6, keep = {} } = {}) {
  if (!agent) throw new Error('--agent is required');
  const ledger = ledgerFile ?? fileURLToPath(new URL(`../substrate/history/${fleet}/chest-evict.jsonl`, import.meta.url));
  const record = row => { try { mkdirSync(dirname(ledger), { recursive: true }); appendFileSync(ledger, JSON.stringify({ at: new Date().toISOString(), agent, ...row }) + '\n'); } catch {} };
  const left = new Map(plan.total.map(t => [norm(t.item), { ...t }]));
  const sold = {}; let proceeds = 0;
  const row = async () => (await call('fleet', {}, 60_000)).fleet?.find(r => r.agent === agent);
  const pack = async () => (await call('inventory', { agent }, 60_000))?.items ?? [];
  if (!left.size) { log('nothing to evict'); return { sold, proceeds, rounds: 0 }; }
  record({ kind: 'start', dry, plan: plan.total.map(t => ({ item: t.item, amount: t.amount, tier: t.tier })) });

  // WORN GEAR IS NEVER OFFERED. The first live run (2026-09-28 07:58) was walking Statler to Izzio to sell
  // his own worn small round shield and leather armour, because they matched planned items. The
  // server's own use list decides; when it is unknown, nothing that is not a stack is offered at all.
  const eq = await call('equipment', { agent }, 30_000).catch(() => null);
  const worn = eq?.known === false || !eq ? null : new Set((eq.equipped ?? eq.items ?? []).map(o => Number(o.id)));
  const offerable = o => (Number(o.amount) > 0) || (worn != null && !worn.has(Number(o.id)));

  // ROOM FIRST, AND THE RUNNER'S OWN STOCK GOES IN, NOT OUT (operator, 2026-09-28: "Statler's own
  // bounced stock can go straight into those two chests"). What it carries of a planned item above
  // `keep` is deposited (the chests with room take it; the full one refuses) and `keep` drawn back,
  // in one visit. A deposit never takes anything worn (hallWithdraw's own rule).
  const names = [...new Set([...plan.total.map(t => t.item), ...(plan.moves ?? []).map(m => m.item)])];
  const mine = await pack();
  const carried = names.filter(n => countOf(mine.filter(offerable), n) > (Number(keep[norm(n)] ?? keep[n]) || 0));
  if (carried.length) {
    log(`first, room: depositing ${agent}'s own ${carried.join(', ')} (keeping ${JSON.stringify(keep)})`);
    if (!dry) {
      if (Number((await row())?.room_num) !== HALL) await call('travel', { agent, to: HALL, background: false }, 900_000).catch(() => null);
      const wants = Object.entries(keep).filter(([k]) => carried.some(n => norm(n) === norm(k))).map(([item, amount]) => ({ item, amount: Number(amount) }));
      const d = await call('hall_withdraw', { agent, wants, deposit: carried }, 620_000).catch(e => ({ ok: false, why: e.message }));
      record({ kind: 'predeposit', items: carried, ok: d?.ok !== false, why: d?.why ?? null, stashed: d?.stashed ?? null });
    }
  }

  // THE MOVES, chest to chest (hall_move), before anything is sold.
  if ((plan.moves ?? []).length) {
    log(`moving ${plan.moves.map(m => `${m.amount} ${m.item} ${m.from}->${m.to}`).join(', ')}`);
    if (!dry) {
      if (Number((await row())?.room_num) !== HALL) await call('travel', { agent, to: HALL, background: false }, 900_000).catch(() => null);
      const r = await call('hall_move', { agent, moves: plan.moves.map(m => ({ item: m.item, amount: m.amount, from: m.from, to: m.to })) }, 620_000)
        .catch(e => ({ ok: false, why: e.message }));
      record({ kind: 'moved', ok: r?.ok !== false, why: r?.why ?? null, moves: r?.moves ?? null });
      if (r?.ok === false) log(`  moves failed: ${r.why}`);
      for (const m of r?.moves ?? []) if (m.carried) log(`  ${m.carried} ${m.item} could not be put anywhere and is carried`);
    }
  }

  for (let round = 1; round <= maxRounds && [...left.values()].some(t => t.amount > 0); round++) {
    const r = await row();
    const room = freeRoom(r, 0.05);
    const { take } = whatFits([...left.values()].filter(t => t.amount > 0).map(t => ({ item: t.item, amount: t.amount })), room, weighItem);
    if (!take.length) { log(`round ${round}: ${agent}'s pack has no room (or its load is unknown) — stopping`); break; }
    log(`round ${round}: drawing ${take.map(t => `${t.amount} ${t.item}`).join(', ')}`);
    if (dry) { for (const t of take) left.get(norm(t.item)).amount -= t.amount; continue; }
    if (Number(r?.room_num) !== HALL) await call('travel', { agent, to: HALL, background: false }, 900_000).catch(() => null);
    const w = await call('hall_withdraw', { agent, wants: take }, 620_000).catch(e => ({ ok: false, why: e.message }));
    if (w?.ok === false) { log(`  could not draw: ${w.why}`); record({ kind: 'draw_failed', why: w.why }); break; }
    record({ kind: 'drawn', took: w.took ?? {}, short: w.short ?? {} });
    for (const [k, n] of Object.entries(w.short ?? {})) if (left.get(norm(k))) left.get(norm(k)).amount -= n;   // the chests are out
    // To each merchant, in turn, with what it stocks.
    const byMerchant = new Map();
    for (const t of take) {
      const e = left.get(norm(t.item));
      if (!e?.sell_at) continue;
      const key = `${e.sell_at.merchant}@${e.sell_at.room}`;
      if (!byMerchant.has(key)) byMerchant.set(key, { ...e.sell_at, items: [] });
      byMerchant.get(key).items.push(t.item);
    }
    for (const m of byMerchant.values()) {
      await call('travel', { agent, to: m.room, background: false }, 900_000).catch(() => null);
      const p = await pack();
      // ONLY WHAT THIS ROUND DREW: the runner's own stock of the same item (its kept herbs) is not the
      // chest's overstock, and selling it would also end the plan early.
      const drawnOf = item => Number(w.took?.[item] ?? w.took?.[norm(item)] ?? take.find(t => norm(t.item) === norm(item))?.amount ?? 0);
      const specs = m.items.flatMap(item => {
        let rest = drawnOf(item);
        return p.filter(o => norm(o.name) === norm(item) && offerable(o)).map(o => {
          if (rest <= 0) return null;
          const n = Number(o.amount) > 0 ? Math.min(Number(o.amount), rest) : 1;
          rest -= n;
          return Number(o.amount) > 0 ? { id: o.id, amount: n } : o.id;
        }).filter(Boolean);
      });
      if (!specs.length) continue;
      const before = Object.fromEntries(m.items.map(i => [i, countOf(p, i)]));
      const s = await call('sell', { agent, to: m.merchant, items: specs, confirm: true }, 120_000).catch(e => ({ error: e.message }));
      const after = await pack();
      for (const item of m.items) {
        const n = Math.max(0, before[item] - countOf(after, item));
        if (!n) continue;
        sold[item] = (sold[item] ?? 0) + n;
        left.get(norm(item)).amount -= n;
      }
      const got = Number(s?.received ?? s?.shillings ?? s?.price ?? 0) || 0;
      proceeds += got;
      log(`  sold to ${m.merchant} (${m.room}): ${m.items.map(i => `${Math.max(0, before[i] - countOf(after, i))} ${i}`).join(', ')}` +
          (s?.error ? ` — ${s.error}` : ''));
      record({ kind: 'sold', merchant: m.merchant, room: m.room, items: m.items.map(i => ({ item: i, amount: before[i] - countOf(after, i) })), reply: s?.error ?? null });
    }
  }
  record({ kind: 'end', sold, proceeds, left: [...left.values()].filter(t => t.amount > 0).map(t => ({ item: t.item, amount: t.amount })) });
  log(`done: sold ${Object.entries(sold).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing'}`);
  return { sold, proceeds };
}
