// WHAT A CHARACTER WAS JUST GIVEN, REMEMBERED ACROSS A KEEPER HANDOFF.
//
// Prod, 2026-10-27: Zheng He delivered six maces to the dedication desk at 03:37 (verified). The desk's keeper was handed
// off at 03:41:31, and within six seconds the new keeper's field weapon cap (capFieldWeapons) dropped all six as spares
// over maxWeapons: its protected names held 'long sword' but not 'mace', and the old keeper's memory of the delivery died
// with it. The floor looter then refused to pick them back up ("just shed"), and eleven troll farmers sat on their
// fallback with no dedication.
//
// So what arrives by trade is written down, by name and count, per character, on disk (substrate/.received/), and for
// RECEIVED_PROTECT_MS a standing rule that throws things away (the field weapon cap) leaves that many of each name alone.
// A delivery is somebody's decision; a standing rule is not entitled to undo it within the hour. Pure apart from the
// small file.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECEIVED_DIR = process.env.M59_RECEIVED_DIR
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'substrate', '.received');
export const RECEIVED_PROTECT_MS = Number(process.env.M59_RECEIVED_PROTECT_MS || 3 * 3_600_000);
const KEEP_MS = 24 * 3_600_000;
const fileOf = (agent, dir) => join(dir, `${String(agent ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

export function readReceived(agent, dir = RECEIVED_DIR) {
  try { const j = JSON.parse(readFileSync(fileOf(agent, dir), 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; }
}
/** Record arrivals: [{ name, amount }] at `now`, from `from`. Entries older than a day are pruned. */
export function noteReceived(agent, items = [], { from = null, now = Date.now(), dir = RECEIVED_DIR } = {}) {
  const rows = readReceived(agent, dir).filter(r => now - Number(r.at) < KEEP_MS);
  for (const i of items) {
    const name = String(i?.name ?? '').trim().toLowerCase();
    const amount = Number(i?.amount) > 0 ? Number(i.amount) : 1;
    if (name) rows.push({ name, amount, at: now, ...(from ? { from: String(from) } : {}) });
  }
  try {
    mkdirSync(dir, { recursive: true });
    const p = fileOf(agent, dir), tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows) + '\n'); renameSync(tmp, p);
  } catch { /* the record is a guard: unwritable means less is protected, never that anything is dropped */ }
  return rows;
}
/** name -> how many of it arrived within the window: what a standing rule must leave alone. */
export function protectedReceived(agent, { now = Date.now(), windowMs = RECEIVED_PROTECT_MS, dir = RECEIVED_DIR } = {}) {
  const out = new Map();
  for (const r of readReceived(agent, dir)) if (now - Number(r.at) < windowMs) out.set(r.name, (out.get(r.name) ?? 0) + Number(r.amount || 1));
  return out;
}
/**
 * Which of an offer's names actually arrived: the offer (`theirs`) against the pack's name counts before and after.
 * The server says the same thing when a trade completes and when it is cancelled, so only the pack can tell.
 */
export function arrivedFrom(theirs = [], before = new Map(), after = new Map()) {
  const out = [];
  for (const name of new Set(theirs.map(t => String(t?.name ?? '').trim().toLowerCase()).filter(Boolean))) {
    const rose = (after.get(name) ?? 0) - (before.get(name) ?? 0);
    if (rose > 0) out.push({ name, amount: rose });
  }
  return out;
}
