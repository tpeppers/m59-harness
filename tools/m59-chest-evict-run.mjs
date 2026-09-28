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

export function brokerCall(url = process.env.M59_CONTROL_URL || 'http://127.0.0.1:8901') {
  return async (name, args, ms = 120_000) => {
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
                                    fleet = 'prod', ledgerFile = null, maxRounds = 6 } = {}) {
  if (!agent) throw new Error('--agent is required');
  const ledger = ledgerFile ?? fileURLToPath(new URL(`../substrate/history/${fleet}/chest-evict.jsonl`, import.meta.url));
  const record = row => { try { mkdirSync(dirname(ledger), { recursive: true }); appendFileSync(ledger, JSON.stringify({ at: new Date().toISOString(), agent, ...row }) + '\n'); } catch {} };
  const left = new Map(plan.total.map(t => [norm(t.item), { ...t }]));
  const sold = {}; let proceeds = 0;
  const row = async () => (await call('fleet', {}, 60_000)).fleet?.find(r => r.agent === agent);
  const pack = async () => (await call('inventory', { agent }, 60_000))?.items ?? [];
  if (!left.size) { log('nothing to evict'); return { sold, proceeds, rounds: 0 }; }
  record({ kind: 'start', dry, plan: plan.total.map(t => ({ item: t.item, amount: t.amount, tier: t.tier })) });

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
      const specs = m.items.flatMap(item => p.filter(o => norm(o.name) === norm(item))
        .map(o => (Number(o.amount) > 0 ? { id: o.id, amount: o.amount } : o.id)));
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
