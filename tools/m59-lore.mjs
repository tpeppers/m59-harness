#!/usr/bin/env node
// ASK THE GAME'S OWN DATA A QUESTION, AND BE TOLD WHEN YOU ASK IT WRONG.
//
//   node tools/m59-lore.mjs help                     every subcommand, with examples
//   node tools/m59-lore.mjs drops elderberry         who drops it, best rate first
//   node tools/m59-lore.mjs loot "fungus beast"      what it drops, and how often
//   node tools/m59-lore.mjs where "fungus beast"     which rooms generate it
//   node tools/m59-lore.mjs hunt elderberry          where to go to farm an item
//   node tools/m59-lore.mjs sells bread              who sells it
//   node tools/m59-lore.mjs buys emerald             who buys it
//   node tools/m59-lore.mjs shop 202                 what that merchant deals in
//   node tools/m59-lore.mjs item "meat pie"          weight, class, food value
//   node tools/m59-lore.mjs spell "create food"      school, level, mana, reagents
//   node tools/m59-lore.mjs room 562                 size, exits, what spawns there
//   node tools/m59-lore.mjs creature centipede       level, difficulty, danger, loot
//   node tools/m59-lore.mjs fields creatures         what you may filter on
//   node tools/m59-lore.mjs find creatures level'>'40 attack_rating'<'250
//
// WHY THIS EXISTS, AND IT IS NOT CONVENIENCE.
//
// Every fact here was already on disk and already correct. What kept going wrong was the
// asking. Answering "does anything drop elderberry?" with a throwaway script, I read
// `c.drops || c.treasure` — two field names that do not exist on any of the 120 creature
// records, which have `loot`. Both were undefined, the `|| []` made it an empty array,
// and an empty array reads exactly like an answer: "nothing drops elderberry, the fleet
// must buy them". That was reported as a finding. Fungus beast drops elderberry at 30%,
// the best rate in the game, and the fleet was standing in three rooms full of them.
//
// The repo already had whoDrops() and it was right the whole time. The failure was
// bypassing it. So this tool exists to be the thing you reach for instead of a one-liner,
// and its first duty is to REFUSE A QUESTION IT CANNOT ANSWER rather than answer it
// emptily. A filter on an unknown field is an error with the real field names printed —
// never zero results.
//
// An empty result and a malformed question look identical in JSON. Only one of them is
// worth acting on.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const M59_ROOT = process.env.M59_ROOT || 'C:/code/Meridian59';
const GITHUB = 'https://github.com/Meridian59/Meridian59/blob/main';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const LINKS = String(flag('links', 'local'));
const JSON_OUT = !!flag('json', false);
const LIMIT = Number(flag('limit', 40));
const positional = argv.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !String(argv[i - 1]).includes('=')));

// ---------------------------------------------------------------- data

function load(name) {
  const p = here(`../substrate/${name}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
const SPAWNS = load('m59-spawns');
const ITEMS = load('m59-items');
const MERCHANTS = load('m59-merchants');
const MAP = load('m59-map');
const SPELLS = load('m59-spells');

// THE DATASETS, AND THE FIELDS EACH ACTUALLY HAS.
//
// Derived from the records themselves rather than typed here, because a hand-written list
// is the same class of thing that caused the bug — a name someone believed rather than
// one the data has.
const DATASETS = {
  creatures: { rows: () => Object.values(SPAWNS?.creatures ?? {}), of: 'm59-spawns.json' },
  items:     { rows: () => Object.values(ITEMS?.items ?? {}),      of: 'm59-items.json' },
  food:      { rows: () => Object.values(ITEMS?.food ?? {}),       of: 'm59-items.json' },
  weapons:   { rows: () => Object.values(ITEMS?.weapons ?? {}),    of: 'm59-items.json' },
  merchants: { rows: () => Object.values(MERCHANTS?.merchants ?? {}), of: 'm59-merchants.json' },
  rooms:     { rows: () => Object.values(MAP?.rooms ?? {}),        of: 'm59-map.json' },
  spells:    { rows: () => (SPELLS?.spells ?? []),                 of: 'm59-spells.json' },
};

function fieldsOf(dataset) {
  const rows = DATASETS[dataset].rows();
  const seen = new Set();
  for (const r of rows) if (r && typeof r === 'object') for (const k of Object.keys(r)) seen.add(k);
  return [...seen].sort();
}

// Levenshtein, small and local — this is only ever run against a list of a dozen names.
function near(word, candidates) {
  const d = (a, b) => {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length][b.length];
  };
  return candidates.map(c => [c, d(word.toLowerCase(), c.toLowerCase())])
    .filter(([, n]) => n <= Math.max(2, Math.floor(word.length / 3)))
    .sort((a, b) => a[1] - b[1]).map(([c]) => c);
}

// THE REFUSAL. Nothing below runs a filter until the field is known to exist.
function requireField(dataset, field) {
  const have = fieldsOf(dataset);
  if (have.includes(field)) return;
  const guesses = near(field, have);
  const lines = [
    `${dataset} has no field "${field}".`,
    `  fields: ${have.join(', ')}`,
  ];
  if (guesses.length) lines.push(`  did you mean: ${guesses.join(', ')}?`);
  lines.push(`  (from ${DATASETS[dataset].of} — an unknown field is refused rather than`);
  lines.push('   silently matching nothing, because no-results and wrong-question look the same)');
  die(lines.join('\n'));
}

function die(msg, code = 2) { console.error(msg); process.exit(code); }

// ---------------------------------------------------------------- source links

// The compendium prints cites as `kod/path.kod:1433`. A CLI can do better: a path the
// editor will open, or a URL, both pointing at the exact line the fact came from.
function link(cite) {
  if (!cite) return '';
  const out = [];
  for (const part of String(cite).split(/\s*·\s*/)) {
    const m = String(part).match(/^([^\s:]+\.kod)((?::\d+)+(?:,\s*:\d+)*)?/);
    if (!m) { out.push(part); continue; }
    const file = m[1];
    const line = (m[2] || '').match(/\d+/)?.[0];
    out.push(LINKS === 'github'
      ? `${GITHUB}/${file}${line ? `#L${line}` : ''}`
      : `${M59_ROOT}/${file}${line ? `:${line}` : ''}`);
  }
  return out.join('  ');
}

const norm = (s) => String(s ?? '').trim().toLowerCase();
const pct = (n) => (n == null ? '?' : `${n}%`);

// ---------------------------------------------------------------- lookups

function creaturesMatching(q) {
  const n = norm(q);
  const all = DATASETS.creatures.rows();
  const exact = all.filter(c => norm(c.name) === n);
  return exact.length ? exact : all.filter(c => norm(c.name).includes(n));
}

function whoDropsItem(q) {
  const n = norm(q);
  const hits = [];
  for (const c of DATASETS.creatures.rows())
    for (const it of (c.loot?.items ?? []))
      if (norm(it.item).includes(n))
        hits.push({ creature: c.name, item: it.item, per_roll_percent: it.per_roll_percent,
                    count: it.count, level: c.level, attack_rating: c.attack_rating,
                    karma: c.karma, rooms: (c.sites ?? []).map(s => s.room), cite: it.cite });
  return hits.sort((a, b) => (b.per_roll_percent ?? 0) - (a.per_roll_percent ?? 0));
}

// A SELLS ENTRY IS {id, cls, quantity} — THERE IS NO `name` ON IT.
//
// This matched against s.name, which is undefined on every row, so `sells elderberry`
// answered "no merchant sells anything matching that" for an item sold in seven shops —
// and I reported to the operator that buying reagents was impossible and the fleet could
// only farm them. The broker's live `merchants` tool resolves the class to a display name
// and had the right answer the whole time.
//
// Exactly the failure this tool was written to prevent, committed in the tool itself:
// a field that does not exist, an empty result, and an empty result read as an answer.
// Match on `cls`, which is what the file actually stores, and fall back to a string entry.
function merchantsFor(q, side) {
  const n = norm(q);
  const out = [];
  const label = (s) => (typeof s === 'string' ? s : (s?.cls ?? s?.name ?? ''));
  for (const m of DATASETS.merchants.rows()) {
    const sells = (m.sells ?? []).filter(s => norm(label(s)).includes(n));
    if (side === 'sells' && sells.length) out.push({ ...m, matched: sells });
    if (side === 'buys') {
      // buys_anything is the honest answer for most of them; buying_rule is the text.
      if (m.buys_anything) out.push({ ...m, matched: ['(buys anything)'] });
    }
  }
  return out;
}

// ---------------------------------------------------------------- rendering

const show = (obj) => { if (JSON_OUT) console.log(JSON.stringify(obj, null, 1)); return !JSON_OUT; };

function creatureLine(c) {
  return `${String(c.name).padEnd(22)} L${String(c.level).padStart(3)}  diff ${String(c.difficulty ?? '?').padStart(2)}` +
         `  rating ${String(c.attack_rating ?? '?').padStart(4)}  karma ${String(c.karma ?? '?').padStart(4)}`;
}

// ---------------------------------------------------------------- subcommands

const CMDS = {
  drops: {
    usage: 'drops <item>            who drops it, best rate first',
    run: (q) => {
      if (!q) die('drops needs an item, e.g. `drops elderberry`');
      const hits = whoDropsItem(q);
      if (!hits.length) {
        const every = [...new Set(DATASETS.creatures.rows()
          .flatMap(c => (c.loot?.items ?? []).map(i => i.item)))].sort();
        const guesses = near(q, every);
        die(`nothing drops anything matching "${q}".` +
            (guesses.length ? `\n  did you mean: ${guesses.slice(0, 6).join(', ')}?` : '') +
            `\n  (${every.length} distinct droppable items are known — \`m59-lore.mjs items-dropped\` lists them)`);
      }
      if (!show({ item: q, droppers: hits })) return;
      console.log(`${hits.length} creature(s) drop something matching "${q}", best rate first:\n`);
      for (const h of hits.slice(0, LIMIT)) {
        console.log(`  ${pct(h.per_roll_percent).padStart(4)}  ${String(h.creature).padEnd(20)} ` +
                    `L${String(h.level).padStart(3)}  rating ${String(h.attack_rating ?? '?').padStart(4)}` +
                    `  rooms ${(h.rooms ?? []).join(',') || '—'}`);
        if (h.cite) console.log(`        ${link(h.cite)}`);
      }
    },
  },
  loot: {
    usage: 'loot <creature>         what it drops, and how often',
    run: (q) => {
      if (!q) die('loot needs a creature, e.g. `loot "fungus beast"`');
      const cs = creaturesMatching(q);
      if (!cs.length) {
        const names = DATASETS.creatures.rows().map(c => c.name);
        die(`no creature matching "${q}".` +
            (near(q, names).length ? `\n  did you mean: ${near(q, names).slice(0, 6).join(', ')}?` : ''));
      }
      if (!show({ creatures: cs.map(c => ({ name: c.name, loot: c.loot })) })) return;
      for (const c of cs.slice(0, LIMIT)) {
        console.log(creatureLine(c));
        const items = c.loot?.items ?? [];
        if (!items.length) { console.log('   drops nothing recorded'); continue; }
        console.log(`   table ${c.loot?.tid ?? '?'}`);
        for (const it of items) {
          console.log(`     ${pct(it.per_roll_percent).padStart(4)}  ${it.item}${it.count > 1 ? ` x${it.count}` : ''}`);
          if (it.cite) console.log(`            ${link(it.cite)}`);
        }
      }
    },
  },
  where: {
    usage: 'where <creature>        which rooms generate it',
    run: (q) => {
      if (!q) die('where needs a creature, e.g. `where centipede`');
      const cs = creaturesMatching(q);
      if (!cs.length) die(`no creature matching "${q}"`);
      if (!show({ creatures: cs.map(c => ({ name: c.name, sites: c.sites })) })) return;
      for (const c of cs.slice(0, LIMIT)) {
        console.log(creatureLine(c));
        for (const s of (c.sites ?? [])) {
          console.log(`   room ${String(s.room).padStart(5)}  ${String(s.room_name ?? '').padEnd(34)} ` +
                      `${s.how ?? ''} ${s.chance != null ? `${s.chance}%` : ''} cap ${s.cap ?? '?'}`);
          if (s.cite) console.log(`         ${link(s.cite)}`);
        }
      }
    },
  },
  hunt: {
    usage: 'hunt <item>             where to go to farm an item',
    run: (q) => {
      if (!q) die('hunt needs an item, e.g. `hunt elderberry`');
      const hits = whoDropsItem(q);
      if (!hits.length) die(`nothing drops anything matching "${q}" — try \`drops ${q}\` for suggestions`);
      // Rooms scored by the best drop rate available in them, then by how dangerous the
      // thing dropping it is. A 30% drop off a rating-210 creature beats a 15% off a 390.
      const byRoom = new Map();
      for (const h of hits) for (const room of (h.rooms ?? [])) {
        const cur = byRoom.get(room);
        if (!cur || h.per_roll_percent > cur.per_roll_percent) byRoom.set(room, h);
      }
      const rows = [...byRoom].map(([room, h]) => ({ room, ...h }))
        .sort((a, b) => (b.per_roll_percent - a.per_roll_percent) || (a.attack_rating - b.attack_rating));
      if (!show({ item: q, rooms: rows })) return;
      console.log(`best rooms to farm "${q}":\n`);
      for (const r of rows.slice(0, LIMIT))
        console.log(`  room ${String(r.room).padStart(5)}  ${pct(r.per_roll_percent).padStart(4)} off ` +
                    `${String(r.creature).padEnd(20)} L${String(r.level).padStart(3)} rating ${String(r.attack_rating ?? '?').padStart(4)}`);
      console.log('\n  rating is 3*level + 60*difficulty — what it hits you with. Lower is safer;');
      console.log('  level only sets hit points and what the kill pays.');
    },
  },
  sells: {
    usage: 'sells <item>            who sells it',
    run: (q) => {
      if (!q) die('sells needs an item, e.g. `sells bread`');
      const hits = merchantsFor(q, 'sells');
      if (!hits.length) die(`no merchant sells anything matching "${q}"`);
      if (!show({ item: q, merchants: hits })) return;
      for (const m of hits.slice(0, LIMIT))
        console.log(`  room ${String(m.room).padStart(5)}  ${String(m.cls ?? '').padEnd(22)} markup ${m.markup ?? '?'}` +
                    `  sells: ${m.matched.map(x => (typeof x === 'string' ? x : (x?.cls ?? x?.name))).join(', ')}`);
    },
  },
  buys: {
    usage: 'buys <item>             who buys it',
    run: (q) => {
      const hits = merchantsFor(q ?? '', 'buys');
      if (!hits.length) die('no merchant is recorded as buying that');
      if (!show({ item: q, merchants: hits })) return;
      console.log('merchants that buy anything (the usual way to turn loot into shillings):\n');
      for (const m of hits.slice(0, LIMIT))
        console.log(`  room ${String(m.room).padStart(5)}  ${String(m.cls ?? '').padEnd(22)} ${m.buying_rule ?? ''}`);
    },
  },
  shop: {
    usage: 'shop <room>             what that merchant deals in',
    run: (q) => {
      if (!q) die('shop needs a room number, e.g. `shop 202`');
      const hits = DATASETS.merchants.rows().filter(m => String(m.room) === String(q));
      if (!hits.length) die(`no merchant recorded in room ${q}`);
      if (!show({ room: q, merchants: hits })) return;
      for (const m of hits) {
        console.log(`room ${m.room}  ${m.cls ?? ''}  markup ${m.markup ?? '?'}  buys_anything ${!!m.buys_anything}`);
        for (const s of (m.sells ?? [])) console.log(`   sells  ${typeof s === 'string' ? s : JSON.stringify(s)}`);
        for (const t of (m.teaches ?? [])) console.log(`   teaches ${typeof t === 'string' ? t : JSON.stringify(t)}`);
      }
    },
  },
  creature: {
    usage: 'creature <name>         level, difficulty, danger, loot, rooms',
    run: (q) => {
      if (!q) die('creature needs a name');
      const cs = creaturesMatching(q);
      if (!cs.length) {
        const names = DATASETS.creatures.rows().map(c => c.name);
        die(`no creature matching "${q}".` +
            (near(q, names).length ? `\n  did you mean: ${near(q, names).slice(0, 6).join(', ')}?` : ''));
      }
      if (!show({ creatures: cs })) return;
      for (const c of cs.slice(0, LIMIT)) {
        console.log(creatureLine(c));
        console.log(`   damage per blow ~ level/12 = ${(c.level / 12).toFixed(1)}   (Fuzzy(viLevel/Random(10,15)))`);
        console.log(`   rooms: ${(c.sites ?? []).map(s => `${s.room}${s.chance != null ? `@${s.chance}%` : ''}`).join(', ') || '—'}`);
        console.log(`   drops: ${(c.loot?.items ?? []).map(i => `${i.item} ${pct(i.per_roll_percent)}`).join(', ') || '—'}`);
      }
    },
  },
  item: {
    usage: 'item <name>             weight, class, and food value if edible',
    run: (q) => {
      if (!q) die('item needs a name');
      const n = norm(q);
      const rows = DATASETS.items.rows().filter(i => norm(i.name).includes(n));
      const food = DATASETS.food.rows().filter(i => norm(i.name).includes(n));
      if (!rows.length && !food.length) {
        const names = DATASETS.items.rows().map(i => i.name);
        die(`no item matching "${q}".` +
            (near(q, names).length ? `\n  did you mean: ${near(q, names).slice(0, 6).join(', ')}?` : ''));
      }
      if (!show({ items: rows, food })) return;
      for (const i of rows.slice(0, LIMIT))
        console.log(`  ${String(i.name).padEnd(24)} weight ${String(i.weight ?? '?').padStart(4)} bulk ${String(i.bulk ?? '?').padStart(4)}  ${i.cls ?? ''}`);
      for (const f of food)
        console.log(`  ${String(f.name).padEnd(24)} FOOD nutrition ${f.nutrition} filling ${f.filling}  (${f.cls})`);
    },
  },
  spell: {
    usage: 'spell <name>            school, level, mana, reagents',
    run: (q) => {
      if (!q) die('spell needs a name');
      const n = norm(q);
      const rows = DATASETS.spells.rows().filter(s => norm(s.name).includes(n));
      if (!rows.length) {
        const names = DATASETS.spells.rows().map(s => s.name);
        die(`no spell matching "${q}".` +
            (near(q, names).length ? `\n  did you mean: ${near(q, names).slice(0, 6).join(', ')}?` : ''));
      }
      if (!show({ spells: rows })) return;
      for (const s of rows.slice(0, LIMIT)) {
        console.log(`  ${String(s.name).padEnd(22)} ${String(s.school_name ?? '').padEnd(12)} L${s.level ?? '?'}  ` +
                    `mana ${s.mana ?? '?'}  karma ${s.required_karma ?? 0}`);
        if ((s.reagents ?? []).length)
          console.log(`      reagents: ${s.reagents.map(r => `${r.count} x ${r.item}`).join(' + ')}`);
        if (s.file) console.log(`      ${link(s.file)}`);
      }
    },
  },
  room: {
    usage: 'room <num>              size, exits, and what spawns there',
    run: (q) => {
      if (!q) die('room needs a number');
      const rows = DATASETS.rooms.rows().filter(r => String(r.num) === String(q) || norm(r.name).includes(norm(q)));
      if (!rows.length) die(`no room matching "${q}"`);
      if (!show({ rooms: rows })) return;
      for (const r of rows.slice(0, 5)) {
        console.log(`room ${r.num}  ${r.name}   ${r.rows}x${r.cols}`);
        const spawn = DATASETS.creatures.rows()
          .filter(c => (c.sites ?? []).some(s => String(s.room) === String(r.num)));
        if (spawn.length) {
          console.log('   spawns:');
          for (const c of spawn) {
            const site = c.sites.find(s => String(s.room) === String(r.num));
            console.log(`     ${String(c.name).padEnd(20)} L${String(c.level).padStart(3)} rating ${String(c.attack_rating ?? '?').padStart(4)} ` +
                        `${site.chance != null ? `${site.chance}%` : ''} cap ${site.cap ?? '?'}`);
          }
        }
      }
    },
  },
  fields: {
    usage: 'fields <dataset>        what you may filter on',
    run: (q) => {
      if (!q) {
        console.log('datasets:');
        for (const [k, v] of Object.entries(DATASETS))
          console.log(`  ${k.padEnd(11)} ${String(v.rows().length).padStart(4)} rows   ${v.of}`);
        return;
      }
      if (!DATASETS[q]) die(`no dataset "${q}".\n  datasets: ${Object.keys(DATASETS).join(', ')}`);
      console.log(`${q} (${DATASETS[q].rows().length} rows, from ${DATASETS[q].of}):`);
      for (const f of fieldsOf(q)) console.log(`  ${f}`);
    },
  },
  find: {
    usage: 'find <dataset> <field><op><value> ...   filter; unknown fields are refused',
    run: (...args) => {
      const [dataset, ...terms] = args.filter(Boolean);
      if (!dataset) die(`find needs a dataset: ${Object.keys(DATASETS).join(', ')}`);
      if (!DATASETS[dataset]) die(`no dataset "${dataset}".\n  datasets: ${Object.keys(DATASETS).join(', ')}`);
      if (!terms.length) die(`find needs at least one term, e.g. \`find creatures level>40\`\n` +
                             `  fields: ${fieldsOf(dataset).join(', ')}`);
      const preds = terms.map(t => {
        const m = String(t).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|!=|=|>|<|~)\s*(.*)$/);
        if (!m) die(`cannot read the term "${t}". Use field=value, field>value, field~substring`);
        const [, field, op, raw] = m;
        requireField(dataset, field);           // THE EARLY REFUSAL
        const num = Number(raw);
        const val = raw === '' ? '' : (Number.isNaN(num) ? raw : num);
        return (row) => {
          const v = row?.[field];
          switch (op) {
            case '=':  return String(v).toLowerCase() === String(val).toLowerCase();
            case '!=': return String(v).toLowerCase() !== String(val).toLowerCase();
            case '>':  return Number(v) > Number(val);
            case '<':  return Number(v) < Number(val);
            case '>=': return Number(v) >= Number(val);
            case '<=': return Number(v) <= Number(val);
            case '~':  return String(v).toLowerCase().includes(String(val).toLowerCase());
          }
        };
      });
      const rows = DATASETS[dataset].rows().filter(r => preds.every(p => p(r)));
      if (!show({ dataset, terms, count: rows.length, rows: rows.slice(0, LIMIT) })) return;
      console.log(`${rows.length} of ${DATASETS[dataset].rows().length} ${dataset} match ${terms.join(' ')}\n`);
      for (const r of rows.slice(0, LIMIT))
        console.log('  ' + (dataset === 'creatures' ? creatureLine(r)
                    : JSON.stringify(Object.fromEntries(Object.entries(r).slice(0, 6)))));
    },
  },
  'items-dropped': {
    usage: 'items-dropped           every item any creature drops',
    run: () => {
      const m = new Map();
      for (const c of DATASETS.creatures.rows())
        for (const it of (c.loot?.items ?? [])) {
          const cur = m.get(it.item) ?? { item: it.item, best: 0, from: 0 };
          cur.from++; cur.best = Math.max(cur.best, it.per_roll_percent ?? 0);
          m.set(it.item, cur);
        }
      const rows = [...m.values()].sort((a, b) => b.best - a.best);
      if (!show({ count: rows.length, items: rows })) return;
      console.log(`${rows.length} distinct droppable items, by best rate:\n`);
      for (const r of rows.slice(0, LIMIT))
        console.log(`  ${pct(r.best).padStart(4)}  ${String(r.item).padEnd(26)} from ${r.from} creature(s)`);
    },
  },
};

CMDS.help = {
  usage: 'help                    this',
  run: () => {
    console.log('m59-lore — ask the game\'s own data, and be refused when the question is malformed.\n');
    for (const [name, c] of Object.entries(CMDS)) console.log('  ' + c.usage);
    console.log(`
options
  --json           machine-readable output
  --limit <n>      rows to print, default 40
  --links local    source links as ${M59_ROOT}/kod/...:LINE   (default)
  --links github   source links as ${GITHUB}/kod/...#LINE

on source links
  Every fact that carries a kod citation prints one. The compendium shows these as bare
  text; here they are a path your editor will open, or a URL. Set M59_ROOT to point the
  local form at your source tree.

on refusals
  Filtering on a field that does not exist is an ERROR, not an empty result. This tool was
  written because "does anything drop elderberry?" was answered NO by a script that read
  a field called \`drops\` — the records have \`loot\`, nothing has \`drops\`, and undefined
  became an empty list which read as a finding. Fungus beast drops elderberry at 30%.
  \`fields <dataset>\` lists what is really there.

reading the numbers
  attack_rating   3*level + 60*difficulty — what a creature HITS you with. This, not
                  level, is how dangerous something is: a fungus beast is level 50 and
                  rates 210; a centipede is level 30 and rates 390.
  per_roll_percent the chance of that item on one roll of the creature's loot table.
  cap             how many of that creature a room holds at once; the generator stops
                  while the room is full, counting every monster in it, not just this one.`);
  },
};

// ---------------------------------------------------------------- dispatch

const cmd = positional[0];
if (!cmd || cmd === '--help' || cmd === '-h') { CMDS.help.run(); process.exit(0); }
if (!CMDS[cmd]) {
  const guesses = near(cmd, Object.keys(CMDS));
  die(`no subcommand "${cmd}".` +
      (guesses.length ? `\n  did you mean: ${guesses.join(', ')}?` : '') +
      `\n  subcommands: ${Object.keys(CMDS).join(', ')}`);
}
if (!SPAWNS && ['drops', 'loot', 'where', 'hunt', 'creature', 'items-dropped'].includes(cmd))
  die('substrate/m59-spawns.json is missing — nothing to answer from');
await CMDS[cmd].run(...positional.slice(1));
