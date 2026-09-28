#!/usr/bin/env node
// WHAT IS IN THE GUILD CHESTS, WITHOUT WALKING ANYBODY THERE. Read-only; opens no socket to the game.
//
//   node tools/m59-hall-chests.mjs                    every chest, stacks merged by name, with its age
//   node tools/m59-hall-chests.mjs --find ring        only names matching (a regex, case-insensitive)
//   node tools/m59-hall-chests.mjs --find "inky|herb" --total     one line per name, all chests summed
//   node tools/m59-hall-chests.mjs --json             the same, for a script
//   node tools/m59-hall-chests.mjs --root C:/code/m59-lab/prod-deploy    whose substrate to read
//
// Operator, 2026-09-28: "Write the tool to view the guild hall chests without walking there: I
// believe the cached info is available on the fleet page, under the inventory tab." It is — the
// Inventory board (m59-inventory-page.mjs) renders StorageCache.allChests(), and this prints the
// same readings in a terminal.
//
// A READING IS NOT THE CHEST. Every file under substrate/storage/chests/ is what the chest held
// when somebody last opened it (`opened_by`, `observed_at`), so every row here carries its age, and
// a withdrawal since then is not in it. Only chests somebody has looked inside appear at all — the
// same rule the board keeps: inventing rows for unopened chests would be inventing chests.
//
// WHICH SUBSTRATE. The chests are one set in the world but the readings are per checkout: the
// broker's keepers write them under the broker's own root. So with no --root this asks the broker
// on M59_CONTROL_URL (default 8901) for its /health `root` and reads there, falling back to this
// checkout. An unidentified item is cached under its unrevealed name (a resistance ring reads
// "ring"), so --find ring finds every ring, identified or not.
import { resolve, join } from 'node:path';
import { StorageCache, chestFullness } from './m59-storage.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const has = name => argv.includes(name);

async function brokerRoot() {
  const url = (process.env.M59_CONTROL_URL || 'http://127.0.0.1:8901').replace(/\/?$/, '/');
  try {
    const h = await (await fetch(`${url}health`, { signal: AbortSignal.timeout(8000) })).json();
    return typeof h?.root === 'string' ? h.root : null;
  } catch { return null; }
}

export function summarise(chests, { find = null, now = Date.now() } = {}) {
  const rx = find ? new RegExp(find, 'i') : null;
  return chests.map(ch => {
    const merged = new Map();
    for (const it of ch.items ?? []) {
      const name = String(it.name ?? '?');
      if (rx && !rx.test(name)) continue;
      // amount 0 is a single non-stacking item (a scroll, a suit of armour), the same as the pack.
      merged.set(name, (merged.get(name) ?? 0) + (Number(it.amount) || 1));
    }
    return {
      slot: ch.slot, room: ch.room ?? null, opened_by: ch.opened_by ?? null,
      observed_at: ch.observed_at ?? null,
      age_min: Number.isFinite(ch.observed_at) ? Math.round((now - ch.observed_at) / 60000) : null,
      fullness: chestFullness(ch.items ?? []),
      items: [...merged].map(([name, amount]) => ({ name, amount })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

async function main() {
  const root = opt('--root') ?? (process.env.M59_STORAGE_DIR ? null : await brokerRoot()) ?? process.cwd();
  const dir = process.env.M59_STORAGE_DIR && !opt('--root') ? process.env.M59_STORAGE_DIR : join(resolve(root), 'substrate', 'storage');
  const chests = summarise(new StorageCache({ dir }).allChests(), { find: opt('--find') });
  if (has('--json')) { console.log(JSON.stringify({ dir, chests }, null, 2)); return; }
  if (!chests.length) { console.log(`no chest readings under ${dir} — nobody has opened a chest from this checkout`); return; }
  console.log(`guild chests, as last read — ${dir}`);
  if (has('--total')) {
    const tot = new Map();
    for (const ch of chests) for (const it of ch.items) tot.set(it.name, (tot.get(it.name) ?? 0) + it.amount);
    const oldest = Math.max(...chests.map(c => c.age_min ?? 0));
    console.log(`  (${chests.length} chests; oldest reading ${oldest} min ago)`);
    for (const [n, a] of [...tot].sort((x, y) => x[0].localeCompare(y[0]))) console.log(`  ${String(a).padStart(6)}  ${n}`);
    if (!tot.size) console.log('  nothing matches');
    return;
  }
  for (const ch of chests) {
    const f = ch.fullness;
    console.log(`\n${ch.slot}  room ${ch.room ?? '?'}  read ${ch.age_min ?? '?'} min ago by ${ch.opened_by ?? '?'}` +
                (f ? `  · ${f.percent ?? '?'}% full` : ''));
    if (!ch.items.length) console.log('  nothing matches');
    for (const it of ch.items) console.log(`  ${String(it.amount).padStart(6)}  ${it.name}`);
  }
}

// Importable for summarise() without printing anything.
if (/m59-hall-chests\.mjs$/.test(process.argv[1] ?? '')) await main();
