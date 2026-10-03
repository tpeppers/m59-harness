// Buying in chunks, and judging each chunk by what reached the PACK. Pure: the broker's `shop`
// tool hands in how to send a chunk and how to count the pack, and this decides the rest.
//
// WHY IT IS A MODULE. The broker cannot be imported to test it (importing runs it), and the
// loop this replaced had a defect no source-text test could see. Measured 2026-10-03 on prod,
// keeper-backed t2 at Morrigan's counter in Marion:
//
//     shop {buy_ids:[{id:338, amount:120}]}
//       -> {"got":[],"bought":[],"chunks":3,
//           "note":"nothing arrived and nothing was said; check the purse first"}
//     inventory three seconds later: 50 herbs, from 0.
//
// THE PACK WAS READ OFF A FROZEN PICTURE. On a keeper-backed character `c` is a literal the
// proxy builds from one /state snapshot. The old `countOwn` asked for a fresh snapshot — and
// then counted `c.inventory`, the literal captured when the tool began, which never changes.
// So the count before chunk 1 and the count after it were the same picture, chunk 1 "brought
// nothing", and the loop stopped there: 120 asked, 50 (= SHOP_MAX_PER_BUY, one chunk)
// delivered, chunks 2 and 3 never sent. And because `got` frames rarely reach a keeper inside
// its wait, the summary keyed on `got` said nothing arrived at all.
//
// So: count from a read the caller guarantees is fresh, WAIT FOR THE PACK TO SETTLE rather
// than read it once (items land as separate frames, and a fresh read can beat the last of
// them), and report per item what was asked and what arrived — never the `got` frame alone.

import { foldName } from './m59-merchants.mjs';

// A shop offer and a pack row name the same item, but not always in the same number: one
// list says "herb", the other "herbs". Fold case, punctuation and a trailing plural s.
export const itemKey = (s) => foldName(s).replace(/s$/, '');

// Count the pack by item key, for the keys asked about only — a keeper loots and eats the
// whole time, and the pack moves for reasons that are not this purchase.
export function countByKey(inventory, nameOf, keys) {
  const by = new Map();
  for (const o of inventory ?? []) {
    const k = itemKey(nameOf(o));
    if (!keys.has(k)) continue;
    by.set(k, (by.get(k) ?? 0) + (Number(o.amount) || 1));
  }
  return by;
}

const sameCounts = (a, b) => {
  if (!a || !b) return false;
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) if ((a.get(k) ?? 0) !== (b.get(k) ?? 0)) return false;
  return true;
};

// Poll the pack until it has moved and then held still for `stableReads` consecutive reads,
// or until the deadline. Returns the last good count (or null if no read ever succeeded).
// A pack that never moves is polled to the deadline, because "not yet" and "never" look the
// same until then — that is the price of not trusting one read.
export async function settleCounts(read, baseline, {
  deadlineMs = 6000, pollMs = 400, stableReads = 2,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)), now = () => Date.now(),
} = {}) {
  const until = now() + deadlineMs;
  let last = null, steady = 0, moved = false;
  for (;;) {
    const cur = await read();
    if (cur) {
      if (!moved && baseline && !sameCounts(cur, baseline)) moved = true;
      if (moved && sameCounts(cur, last)) steady++;
      else steady = 0;
      last = cur;
      if (moved && steady >= stableReads - 1) return last;
    }
    if (now() >= until) return last;
    await sleep(pollMs);
  }
}

// Send `rounds` ({id, amount}) one chunk at a time. `send(line)` -> {got?, said?, error?};
// `read()` -> Map(itemKey -> count) from a FRESH pack, or null if it could not be read;
// `nameOf(id)` -> the offer's name for a shelf id.
//
// Stops at the first chunk that brought nothing to the pack — whatever ended it (purse,
// weight, a counter that has stopped answering) ends the next one too. A chunk that brought
// LESS than it asked is kept going past only if it brought something.
export async function buyInChunks({ rounds, nameOf, send, read, settle = {} }) {
  const askedBy = new Map(), nameBy = new Map();
  for (const r of rounds) {
    const nm = nameOf(r.id) ?? '';
    const k = itemKey(nm) || `#${r.id}`;
    askedBy.set(k, (askedBy.get(k) ?? 0) + r.amount);
    if (!nameBy.has(k)) nameBy.set(k, nm || `#${r.id}`);
  }
  const start = await read();
  let held = start;
  const got = [], messages = [], perChunk = [];
  let refusedAfter = null, sent = 0;

  for (const [n, line] of rounds.entries()) {
    const k = itemKey(nameOf(line.id) ?? '') || `#${line.id}`;
    const r = await send(line);
    sent++;
    if (r?.error) { refusedAfter = `keeper refused chunk ${n + 1}: ${r.error}`; perChunk.push({ ...line, arrived: null }); break; }
    const frames = Array.isArray(r?.got) ? r.got : [];
    if (r?.said) messages.push(r.said);
    got.push(...frames);

    let arrived = null;
    if (held) {
      const now = await settleCounts(read, held, settle);
      if (now) {
        arrived = Math.max(0, (now.get(k) ?? 0) - (held.get(k) ?? 0));
        held = now;
      }
    }
    // The pack is the judge when it can be read. When it cannot, a `got` frame is the only
    // evidence left — counted, not invented.
    // And a frame that DID come is not overruled by a pack read that has not caught up yet:
    // the stop decision takes whichever saw more.
    const framed = frames.reduce((s, f) => s + (Number(f?.amount) || 1), 0);
    arrived = arrived == null ? framed : Math.max(arrived, framed);
    perChunk.push({ ...line, arrived });
    if (!arrived) {
      refusedAfter = `chunk ${n + 1} of ${rounds.length} brought nothing` +
        (r?.said ? ` (the merchant said: ${r.said})` : '');
      break;
    }
    if (arrived < line.amount)
      messages.push(`chunk ${n + 1} asked ${line.amount}, ${arrived} arrived`);
  }

  // PER ITEM, ASKED AGAINST ARRIVED. Taken from the pack across the whole run where it was
  // readable, so an arrival that lands after its own chunk's settle is still counted.
  const received = [...askedBy.entries()].map(([k, asked]) => {
    let arrived;
    if (start && held) arrived = Math.max(0, (held.get(k) ?? 0) - (start.get(k) ?? 0));
    else arrived = perChunk.filter(c => (itemKey(nameOf(c.id) ?? '') || `#${c.id}`) === k)
                           .reduce((s, c) => s + (c.arrived ?? 0), 0);
    return { name: nameBy.get(k), asked, arrived, ...(arrived < asked ? { short: asked - arrived } : {}) };
  });
  return {
    got, messages, received, chunks: perChunk, chunks_sent: sent, chunks_planned: rounds.length,
    refused_after: refusedAfter,
    pack_readable: !!(start && held),
    total_arrived: received.reduce((s, x) => s + x.arrived, 0),
  };
}
