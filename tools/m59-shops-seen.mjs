#!/usr/bin/env node
// Every shop a character has actually opened: who, in which room, and what was on the list.
//
//   node tools/m59-shops-seen.mjs            what has been seen, newest first
//
// A MERCHANT SEEN LIVE IS NEVER "NOT FOUND" AGAIN. `substrate/m59-merchants.json` is built
// from a server's admin socket — a server we run. Prod is not ours, so its catalogue is a
// copy of a different world taken in July, and nothing a character learns at a counter
// ever reached it. On 2026-10-03 `shop {seller:'Morrigan'}` opened her list live (herbs,
// elderberry, torch, pants) in the same minute `merchants` said there was no Morrigan.
//
// So the `shop` tool records each list it opens here, keyed by room and the person's name,
// and `merchants` consults it: a catalogue row it matches is marked as confirmed live, and
// one the catalogue lacks is added as a row of its own. Nothing here is an instruction to a
// character — it is an observation, like the ledgers — and it is one machine's evidence
// about one server, so the file is gitignored.
//
// A list is a SNAPSHOT of what was offered, not stock: `amount` on an offer is a suggested
// quantity, and every merchant except two assembles the list on demand (docs/m59-economy.md).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldName } from './m59-merchants.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SHOPS_SEEN_FILE = process.env.M59_SHOPS_SEEN
  || path.join(here, '..', 'substrate', 'm59-shops-seen.json');

export function loadShopsSeen(file = SHOPS_SEEN_FILE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && j.shops && typeof j.shops === 'object' ? j : { shops: {} };
  } catch { return { shops: {} }; }
}

const keyOf = (room, name) => `${room ?? '?'}:${foldName(name)}`;

// Record one opened shop. Returns the stored row, or null when there is nothing to key it
// on — an unnamed seller cannot be found again by name, so it is not worth a row.
export function recordShopSeen({ name, room, room_name = null, server = null, items = [] } = {},
                               { file = SHOPS_SEEN_FILE, now = Date.now() } = {}) {
  if (!foldName(name) || !Array.isArray(items) || !items.length) return null;
  const book = loadShopsSeen(file);
  const row = {
    name: String(name), room: Number.isFinite(Number(room)) ? Number(room) : null, room_name,
    ...(server ? { server } : {}),
    items: items.map(i => ({ name: String(i.name ?? ''), cost: Number(i.cost) || null,
                             quantity: Number(i.amount ?? i.quantity) || null }))
                .filter(i => i.name),
    seen_at: new Date(now).toISOString(),
  };
  book.shops[keyOf(row.room, row.name)] = row;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(book, null, 1));
    fs.renameSync(tmp, file);
  } catch { return null; }
  return row;
}

// The catalogue, with what has been seen at a counter folded in. A seen shop that matches
// a catalogue row (same room, same person) marks that row `seen_live`; one that matches
// nothing becomes a row of its own, shaped like a catalogue row so every reader of the
// catalogue reads it unchanged. The catalogue rows themselves are copied, never mutated.
export function withShopsSeen(merchants, seen) {
  const rows = (merchants ?? []).map(m => ({ ...m }));
  for (const s of Object.values(seen?.shops ?? {})) {
    const f = foldName(s.name);
    const match = rows.find(m => m.name != null && foldName(m.name) === f && m.room === s.room)
      ?? rows.find(m => m.name != null && foldName(m.name) === f && m.room == null);
    if (match) {
      match.seen_live = { at: s.seen_at, items: s.items };
      continue;
    }
    rows.push({
      seen: true, seen_live: { at: s.seen_at, items: s.items },
      id: null, cls: null, name: s.name, room: s.room, markup: null, wanders: false,
      sells: s.items.map(i => ({ id: null, cls: i.name, name: i.name, quantity: i.quantity, cost: i.cost })),
      teaches: [], buying_rule: null, buys_anything: null,
      source: 'seen live at the counter (substrate/m59-shops-seen.json); not in the built catalogue',
    });
  }
  return rows;
}

if (import.meta.filename === process.argv[1]) {
  const rows = Object.values(loadShopsSeen().shops).sort((a, b) => String(b.seen_at).localeCompare(String(a.seen_at)));
  if (!rows.length) { console.log('no shop has been opened and recorded yet'); process.exit(0); }
  for (const r of rows)
    console.log(`${r.seen_at}  ${r.name} (room ${r.room ?? '?'}${r.room_name ? `, ${r.room_name}` : ''}): ` +
                r.items.map(i => `${i.name}${i.cost ? ` ${i.cost}` : ''}`).join(', '));
}
