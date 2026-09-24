#!/usr/bin/env node
// THE NAME ON THE WIRE -> THE KOD CLASS THAT MAKES ONE. Built from the game's own source.
//
//   node tools/m59-itemclass.mjs herb                 -> Herbs (a stack; set piNumber)
//   node tools/m59-itemclass.mjs "long sword"         -> LongSword
//   node tools/m59-itemclass.mjs --ambiguous          every name that names more than one class
//   node tools/m59-itemclass.mjs --stats              how much of the item tree is covered
//
// WHY THIS EXISTS. Cloning a character means recreating what it is carrying, and the only
// handle we have on an item is the NAME the server sent us — `inventory` reports
// `{name: 'herb', amount: 60}`. Creating one needs the class: `create object Herbs`. Every
// tool that has needed that mapping so far has hand-written it, and a hand-written list of
// this world's item names has now been wrong in FOUR places in this repository (see
// CLAUDE.md on `splitFood`), each time by omission and each time silently.
//
// So it is derived instead. Every class in `compendium/data/koddb.json` that descends from
// `Item` carries its display name as a resource — `Herbs_name_rsc` is the string `"herb"` —
// and that resource IS what the client shows, so it is exactly the name that comes back on
// the wire. 751 of 1232 classes carry one.
//
// **SINGULAR AND PLURAL ARE DIFFERENT RESOURCES AND BOTH APPEAR ON THE WIRE.** `Herbs` is
// named `herb` and pluralised `herbs`, so a lookup table built from one of them misses the
// other — which is the same bug as the fleet board reading `herb` and getting undefined on
// twenty-one rows. Both are indexed.
//
// **AN AMBIGUOUS NAME IS REPORTED, NEVER GUESSED.** Several classes can share a display
// name, and picking one silently arms a shadow with something production is not carrying —
// the precise failure `m59-shadow.mjs`'s own weapon map warns about in its comment. A name
// that maps to more than one class resolves to `ok: false` with the candidates listed, and
// the caller decides or says so out loud.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
export const KODDB = join(REPO, 'compendium', 'data', 'koddb.json');

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Build the index. Returns
 *   { byName: Map<name, [{class, stack, file}]>, ambiguous: [...], items: n, named: n }
 * `stack` means the class descends from NumberItem, so the count lives in `piNumber` and a
 * single `create object` makes the whole pile rather than one of them.
 */
export function itemClassIndex({ koddb = KODDB, db = null } = {}) {
  const j = db ?? JSON.parse(readFileSync(koddb, 'utf8'));
  const classes = j.classes ?? {};

  // Walk to the root once per class. Bounded, because a malformed parent chain in a
  // generated file should not hang the tool that reads it.
  const chainOf = (key) => {
    const out = [];
    let k = norm(key);
    for (let i = 0; i < 32 && classes[k]; i++) { out.push(classes[k].name); k = norm(classes[k].parent); }
    return out;
  };

  const byName = new Map();
  let items = 0, named = 0;
  for (const key of Object.keys(classes)) {
    const chain = chainOf(key);
    if (!chain.includes('Item')) continue;          // not a thing a character can carry
    items++;
    const c = classes[key];
    const stack = chain.includes('NumberItem');
    const res = c.resources ?? {};
    const names = new Set();
    for (const [rk, rv] of Object.entries(res)) {
      // `_name_one_rsc` / `_name_many_rsc` is MONEY's spelling of the same pair
      // (numbitem/money.kod:19-20). Without it the one item every character carries —
      // `shilling` — resolved to nothing, and a clone's purse was the thing it could not copy.
      if (!/_name(_plural|_one|_many)?_rsc$/i.test(rk)) continue;
      if (rv?.kind !== 'string' || !rv.value) continue;
      names.add(norm(rv.value));
    }
    if (names.size) named++;
    for (const n of names) {
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push({ class: c.name, stack, file: c.file ?? null });
    }
  }

  const ambiguous = [...byName.entries()]
    .filter(([, v]) => v.length > 1)
    .map(([name, v]) => ({ name, candidates: v.map(x => x.class) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { byName, ambiguous, items, named };
}

/**
 * Resolve one wire name. Never guesses: an unknown or ambiguous name comes back `ok: false`
 * carrying enough to say so usefully.
 */
export function resolveItemClass(name, index) {
  const n = norm(name);
  if (!n) return { ok: false, why: 'empty name' };
  const hits = index.byName.get(n);
  if (!hits || !hits.length)
    return { ok: false, why: `no item class in the kod is named "${name}"`, candidates: [] };
  if (hits.length > 1)
    return { ok: false, why: `"${name}" names ${hits.length} classes; pick one deliberately`,
             candidates: hits.map(h => h.class) };
  return { ok: true, class: hits[0].class, stack: hits[0].stack, file: hits[0].file };
}

/**
 * The DM commands that put `count` of `name` into the pack of object `holderId`.
 * Returns `{ ok:false }` unchanged from resolveItemClass when the name cannot be resolved,
 * so a caller can report the name rather than create the wrong thing.
 *
 * A STACK IS ONE OBJECT WITH A COUNT, NOT N OBJECTS. `piNumber` is the pile; creating sixty
 * separate Herbs would fill a fourteen-slot pack with fifty-nine things nobody asked for.
 * `amount: 0` on the wire is the marker for "not a stack" and means ONE — the same rule
 * `countIn` follows in m59-loadout.mjs.
 */
export function giveItemCmds({ holderId, name, count = 1, index, objectVar = 'OBJ' }) {
  const r = resolveItemClass(name, index);
  if (!r.ok) return r;
  const n = Math.max(1, Number(count) || 1);
  return {
    ok: true, class: r.class, stack: r.stack, count: n,
    // The id of the created object is only known at run time, so this is a shape rather
    // than a finished script: the caller runs `create`, reads `Created object <id>` back,
    // and substitutes. Same two-step m59-shadow.mjs already uses to arm a weapon.
    create: `create object ${r.class}`,
    setCount: r.stack && n > 1 ? (id) => `set object ${id} piNumber INT ${n}` : null,
    give: (id) => `send object ${holderId} NewHold what OBJECT ${id}`,
    // A non-stack asked for more than one needs that many objects; say so rather than
    // silently delivering one.
    repeat: r.stack ? 1 : n,
  };
}

// ---------------------------------------------------------------- cli
if (import.meta.filename === process.argv[1]) {
  const argv = process.argv.slice(2);
  if (!existsSync(KODDB)) {
    console.error(`no koddb at ${KODDB} — build the compendium first`);
    process.exit(2);
  }
  const index = itemClassIndex();
  if (argv.includes('--stats')) {
    console.log(`item classes: ${index.items}, of which ${index.named} carry a display name`);
    console.log(`distinct names: ${index.byName.size}, ambiguous: ${index.ambiguous.length}`);
    process.exit(0);
  }
  if (argv.includes('--ambiguous')) {
    for (const a of index.ambiguous) console.log(`${a.name.padEnd(28)} ${a.candidates.join(', ')}`);
    console.log(`\n${index.ambiguous.length} ambiguous name(s)`);
    process.exit(0);
  }
  const name = argv.filter(a => !a.startsWith('--')).join(' ');
  if (!name) { console.error('usage: m59-itemclass.mjs <item name> | --ambiguous | --stats'); process.exit(2); }
  const r = resolveItemClass(name, index);
  console.log(r.ok ? `${name} -> ${r.class}${r.stack ? '  (a stack; the count is piNumber)' : ''}\n${r.file ?? ''}`
                   : `${name}: ${r.why}${r.candidates?.length ? '\n  ' + r.candidates.join('\n  ') : ''}`);
  process.exit(r.ok ? 0 : 1);
}
