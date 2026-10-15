// TRADING WITH A PERSON, FROM THE FLEET'S SIDE OF THE TABLE.
//
// Every transfer the fleet makes is `supply`, which drives BOTH ends of a trade from two
// keeper sessions. A character a human is piloting has no keeper session — the client
// holds the one connection the server allows — so every courier stop skips it
// (`!r.piloted` in zheng-he-lap.mjs, eight places). The person standing in the room with
// diamonds to sell is the one participant the courier cannot see.
//
// But a trade is two halves, and the fleet only needs to own ONE of them:
//
//   PICKUP   the person offers in their client -> we counter with NOTHING, which is how a
//            gift is accepted (counter grants the other side permission to accept) -> they
//            accept in their client.
//   DELIVER  we offer -> they counter (with nothing) in their client -> we accept, which
//            is only legal once their counter has arrived (`may_accept`).
//
// Everything goes through the broker's `trade` tool on the COURIER's agent, so this module
// never touches a socket and is testable with a fake `call`. Both halves are bounded by a
// deadline and cancel on the way out, so a person who walks off leaves no open trade
// behind to wedge the courier's next `supply`.
//
// Holds live in substrate/courier-holds.json, written by the plan desk:
//   { "<agent>": { "items": { "diamond": 40 }, "character": "Kermit", "at": <ms>, "by": "plan-desk" } }

import fs from 'node:fs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function readHolds(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}

// How much of the courier's pack to keep empty for the people who have asked him to carry
// their goods. Counted in UNITS against a per-unit pack share, deliberately crude: the
// courier's own `fill` thresholds are percentages, and this is subtracted from them.
export function reservedPercent(holds, perUnit = 0.25, cap = 40) {
  let units = 0;
  for (const h of Object.values(holds ?? {})) for (const n of Object.values(h?.items ?? {})) units += Math.max(0, Number(n) || 0);
  return Math.min(cap, Math.round(units * perUnit));
}

const tradeOf = r => r?.trade ?? null;

// Wait for `character` to offer us something, then accept it as a gift by countering with
// nothing. Resolves {received:[...], why}.
export async function acceptGiftFrom(call, agent, character, { timeoutMs = 90_000, pollMs = 1500, say = null } = {}) {
  if (say) await call('say', { agent, text: say }, 60_000).catch(() => null);
  const until = Date.now() + timeoutMs;
  try {
    while (Date.now() < until) {
      const t = tradeOf(await call('trade', { agent, action: 'status' }, 30_000).catch(() => null));
      if (t?.role === 'recipient' && String(t.withName ?? '').toLowerCase() === String(character).toLowerCase()) {
        const c = await call('trade', { agent, action: 'counter', items: [] }, 30_000).catch(e => ({ error: e.message }));
        if (!c?.countered) return { received: [], why: c?.error ?? 'counter refused' };
        // Their accept closes it; we are the non-accepting side, so OFFER_CANCELED is success here.
        for (let i = 0; i < 40; i++) {
          await sleep(pollMs);
          if (!tradeOf(await call('trade', { agent, action: 'status' }, 30_000).catch(() => null)))
            return { received: t.theirs ?? [], why: 'trade closed after our counter (accepted, or they cancelled — check the pack)' };
        }
        return { received: [], why: 'they never accepted after our counter' };
      }
      if (t && t.role === 'recipient') await call('trade', { agent, action: 'cancel' }, 30_000).catch(() => null);  // someone else
      await sleep(pollMs);
    }
    return { received: [], why: `${character} made no offer within ${Math.round(timeoutMs / 1000)}s` };
  } finally {
    const t = tradeOf(await call('trade', { agent, action: 'status' }, 30_000).catch(() => null));
    if (t) await call('trade', { agent, action: 'cancel' }, 30_000).catch(() => null);
  }
}

// Offer `items` ([{id, amount}]) to `character` and accept once they have countered.
export async function deliverTo(call, agent, character, items, { timeoutMs = 90_000, pollMs = 1500, say = null } = {}) {
  if (!items?.length) return { delivered: false, why: 'nothing to hand over' };
  const o = await call('trade', { agent, action: 'offer', to: character, items }, 30_000).catch(e => ({ error: e.message }));
  if (!o?.offered) return { delivered: false, why: o?.error ?? (o?.messages ?? []).join(' ') ?? 'offer not confirmed' };
  if (say) await call('say', { agent, text: say }, 60_000).catch(() => null);
  const until = Date.now() + timeoutMs;
  try {
    while (Date.now() < until) {
      await sleep(pollMs);
      const t = tradeOf(await call('trade', { agent, action: 'status' }, 30_000).catch(() => null));
      if (!t) return { delivered: false, why: 'they cancelled' };
      if (t.mayAccept) {
        const a = await call('trade', { agent, action: 'accept' }, 30_000).catch(e => ({ error: e.message }));
        return { delivered: !!a?.accepted, why: a?.accepted ? 'accepted' : (a?.reason ?? a?.error ?? 'accept refused'), on_table: o.on_the_table };
      }
    }
    return { delivered: false, why: `${character} did not counter within ${Math.round(timeoutMs / 1000)}s` };
  } finally {
    const t = tradeOf(await call('trade', { agent, action: 'status' }, 30_000).catch(() => null));
    if (t) await call('trade', { agent, action: 'cancel' }, 30_000).catch(() => null);
  }
}
