#!/usr/bin/env node
// FEED ME MORE: KEEP MORE OF ONE THING IN THE GUILD CHESTS, AND SAY WHAT GIVES UP THE ROOM.
//
//   node tools/m59-feed-me-more.mjs                                   the demands, and what they cost
//   node tools/m59-feed-me-more.mjs add "lightning wand" --per-chest 100 --also wand --why "..."
//   node tools/m59-feed-me-more.mjs remove "lightning wand"           give the room back
//   node tools/m59-feed-me-more.mjs config --floor-fraction 0.3 --floor-total 300
//   ...any of them with --apply to write the guild plan; without it, nothing is written.
//
// Operator, 2026-10-07: "When managing guild chests and increasing what it carries, we always
// have to give up space elsewhere... and while our default space usage is apportioned to
// reagents, and we default want to decrease how much we're saving for the least expensive of
// those reagents... it's still fundamentally useful to keep some minimum floor (maybe 30% of
// what we originally apportioned?), before we start decreasing our desired quantity of the
// next-least-expensive reagent, and so on (until we potentially begin the cycle again for
// another 70% reduction)." And: "having a floor of ~300 of each reagent easily available for
// zero cost is kind of a big deal for the ability to finish up advancing a spell".
//
// THE RULE, per chest, for each demand's extra bulk:
//
//   1. The reagents that give up room are the ones a merchant SELLS (m59-merchants.json) and that
//      have a value (m59-values.json), cheapest per unit of bulk first: mushroom, herb, uncut
//      seraphym, elderberry, firesand, red mushroom, blue mushroom, purple mushroom, emerald,
//      sapphire, diamond. A reagent nobody sells (fairy wing, orc tooth, entroot berry) is never
//      cut: it is not replaceable. `config.order` replaces the ranking outright.
//   2. Round 1 cuts the cheapest down to floor_fraction (0.3) of its ORIGINAL target, then the
//      next, and so on. Round 2 starts again from the cheapest down to 0.3 x 0.3, up to `rounds`.
//   3. No reagent goes below floor_total (300) across the chests that hold it, split evenly — and
//      a reagent already at or under that is never cut.
//   4. Demand that cannot be met is reported per chest, and the targets that COULD be found are
//      still written: a partial plan is said out loud, never silently trimmed.
//
// IT IS DECLARATIVE. The state file keeps the plan's targets as they were before any demand
// (`baseline`) and the list of demands; every run recomputes the whole allocation from those.
// Removing a demand therefore gives its room back to exactly the reagents that paid for it.
// A target an operator edits by hand after this wrote it becomes the new baseline for that item
// (`written` is what this tool last put there; a mismatch means a person changed it).
//
// IT ALSO CAPS THE REAGENT CO-OP. The co-op deposits against its own equal share per reagent and
// never read the plan, so a cut target would be refilled by co-op members. Every reagent this
// lowers below its baseline gets a matching `coop_caps` entry in the plan, which the co-op honours
// (m59-reagent-coop.mjs coopDepositPlan `capFor`). Reagents back at baseline lose their cap.
//
// The plan file is edited RAW: every other key in it is kept, chest keys stay as written (old
// slot numbers included), duplicate lines for one item all get the new target (the loader keeps
// the larger of two, so changing one would change nothing), and the write is atomic with a backup.
//
// State: substrate/feed-me-more.json (gitignored: it is this machine's orders, like the plan).

import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const STATE_FILE = process.env.M59_FEED_ME_MORE || join(HERE, '..', 'substrate', 'feed-me-more.json');
export const DEFAULT_CONFIG = Object.freeze({ floor_fraction: 0.3, floor_total: 300, rounds: 3, order: null });
export const LEGACY_SQUARES = ['r18c2', 'r18c6', 'r20c4'];   // m59-storage BOOKMAKERS_CHEST_SQUARES

const norm = s => String(s ?? '').trim().toLowerCase();
export const slotOf = key => /^[1-9][0-9]*$/.test(String(key)) ? (LEGACY_SQUARES[Number(key) - 1] ?? null) : String(key);

/** The effective target per chest per item in a RAW plan (the larger of duplicate lines). */
export function planTargets(raw) {
  const out = {};
  for (const [key, entry] of Object.entries(raw?.chests ?? {})) {
    const slot = slotOf(key);
    if (!slot) continue;
    const t = out[slot] ??= {};
    for (const it of [].concat(entry?.items ?? entry ?? [])) {
      const item = norm(it?.item ?? it?.name);
      if (!item) continue;
      const n = Math.max(0, Math.floor(Number(it?.target ?? it?.amount) || 0));
      t[item] = Math.max(t[item] ?? 0, n);
    }
  }
  return out;
}

/** Reagents that may give up room, cheapest per bulk first. Pure. */
export function cutOrder({ reagents, bulkOf, valueOf, buyable, order = null }) {
  if (Array.isArray(order) && order.length) return order.map(norm);
  return reagents.map(norm)
    .filter(r => buyable.has(r))
    .map(r => ({ r, bulk: bulkOf(r), value: valueOf(r) }))
    .filter(x => x.bulk > 0 && Number.isFinite(x.value) && x.value > 0)
    .sort((a, b) => a.value / a.bulk - b.value / b.bulk || a.r.localeCompare(b.r))
    .map(x => x.r);
}

/**
 * The whole allocation, from the baseline and the demands. Pure.
 * Returns { targets: {slot:{item:n}}, caps: {slot:{item:n}}, cuts: [...], unmet: {slot: bulk} }.
 */
export function allocate({ baseline, demands, config = DEFAULT_CONFIG, order, bulkOf, slots }) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const targets = {}, caps = {}, cuts = [], unmet = {};
  const holders = item => slots.filter(s => (baseline[s]?.[item] ?? 0) > 0).length || 1;
  const demandItems = new Set(demands.map(d => norm(d.item)));
  for (const slot of slots) {
    const base = baseline[slot] ?? {};
    const t = targets[slot] = {};
    let need = 0;
    // Each demanded item, at the largest per-chest ask among demands covering this chest.
    const ask = new Map();
    for (const d of demands) {
      if (d.chests?.length && !d.chests.includes(slot)) continue;
      ask.set(norm(d.item), Math.max(ask.get(norm(d.item)) ?? 0, Math.floor(Number(d.per_chest) || 0)));
    }
    for (const [item, want] of ask) {
      const was = base[item] ?? 0;
      t[item] = Math.max(was, want);
      const bulk = bulkOf(item);
      if (!(bulk > 0)) throw new Error(`no bulk known for "${item}" — cannot say what room it needs`);
      need += Math.max(0, want - was) * bulk;
    }
    const candidates = order.filter(r => !demandItems.has(r) && (base[r] ?? 0) > 0);
    for (const r of candidates) t[r] = base[r];
    for (let round = 1; round <= cfg.rounds && need > 0; round++) {
      for (const r of candidates) {
        if (need <= 0) break;
        const b = base[r], bulk = bulkOf(r);
        if (!(bulk > 0)) continue;
        const absolute = Math.ceil(cfg.floor_total / holders(r));
        if (b <= absolute) continue;                           // already at the floor that matters
        const floor = Math.max(absolute, Math.ceil(b * Math.pow(cfg.floor_fraction, round)));
        const can = t[r] - floor;
        if (can <= 0) continue;
        const take = Math.min(can, Math.ceil(need / bulk));
        t[r] -= take;
        need -= take * bulk;
        cuts.push({ slot, item: r, round, from: t[r] + take, to: t[r], freed_bulk: take * bulk });
      }
    }
    if (need > 0) unmet[slot] = need;
    for (const r of candidates) if (t[r] < base[r]) (caps[slot] ??= {})[r] = t[r];
  }
  return { targets, caps, cuts, unmet };
}

/** Write targets and caps into a RAW plan, keeping everything else. Pure: returns a new object. */
export function applyToPlan(raw, { targets, caps, demands, clearCaps = [], baseline = {} }) {
  const out = JSON.parse(JSON.stringify(raw ?? {}));
  const alsoFor = new Map(demands.filter(d => d.also?.length).map(d => [norm(d.item), d.also.map(norm)]));
  for (const [key, entry] of Object.entries(out.chests ?? {})) {
    const slot = slotOf(key);
    const want = targets[slot];
    if (!want) continue;
    const items = Array.isArray(entry?.items) ? entry.items : (entry.items = []);
    for (const [item, n] of Object.entries(want)) {
      // Back to "not in the plan": the line goes, rather than becoming a target of 0.
      if (baseline[slot]?.[item] === null && !demands.some(d => norm(d.item) === item &&
          (!d.chests?.length || d.chests.includes(slot)))) {
        entry.items = items.filter(it => norm(it?.item ?? it?.name) !== item);
        continue;
      }
      const lines = items.filter(it => norm(it?.item ?? it?.name) === item);
      if (!lines.length) items.push({ item, target: n });
      for (const line of lines.length ? lines : [items[items.length - 1]]) {
        line.target = n;
        if (alsoFor.has(item)) line.also = [...new Set([...(line.also ?? []), ...alsoFor.get(item)])];
      }
    }
  }
  const nextCaps = { ...(out.coop_caps ?? {}) };
  for (const slot of clearCaps) {
    for (const k of Object.keys(nextCaps)) if (slotOf(k) === slot) delete nextCaps[k];
  }
  for (const [slot, c] of Object.entries(caps)) nextCaps[slot] = c;
  if (Object.keys(nextCaps).length) out.coop_caps = nextCaps; else delete out.coop_caps;
  return out;
}

/** Fold the current plan into the baseline: new items are recorded, hand edits win. Pure. */
export function refreshBaseline({ baseline = {}, written = {}, current, items, slots }) {
  const next = JSON.parse(JSON.stringify(baseline));
  for (const slot of slots) {
    const b = next[slot] ??= {};
    for (const item of items) {
      // null means NOT IN THE PLAN, which is different from a target of 0 ("hold none").
      const now = current[slot]?.[item] ?? null;
      const ours = written[slot]?.[item] ?? null;
      if (!(item in b)) b[item] = now;                       // first sight: as the plan has it
      else if (item in (written[slot] ?? {}) && now !== ours) b[item] = now;  // a person changed it
    }
  }
  return next;
}

// ------------------------------------------------------------------------------- live inputs
function liveInputs(root) {
  const read = (rel, d) => { try { return JSON.parse(readFileSync(join(root, rel), 'utf8')); } catch { return d; } };
  const items = read('substrate/m59-items.json', {}).items ?? {};
  const values = read('substrate/m59-values.json', {}).values ?? {};
  const merchantsRaw = read('substrate/m59-merchants.json', []);
  const merchants = Array.isArray(merchantsRaw) ? merchantsRaw : (merchantsRaw.merchants ?? []);
  const byCls = new Map(Object.entries(items).map(([name, it]) => [it.cls, norm(name)]));
  const buyable = new Set();
  for (const m of merchants)
    for (const s of m?.sells ?? []) {
      const cls = typeof s === 'string' ? s : (s?.cls ?? s?.name);
      if (byCls.has(cls)) buyable.add(byCls.get(cls));
    }
  const lookup = (table, name) => table[name] ?? table[norm(name)] ?? table[norm(name).replace(/s$/, '')] ?? table[norm(name) + 's'];
  const bulkOf = name => Number(lookup(items, norm(name))?.bulk) || null;
  // m59-values.json keys are mixed: some reagents by display name ("red mushroom"), others by
  // class lower-cased ("solagh", "polishedseraphym"). Try the name, then the class.
  const valueOf = name => {
    const cls = lookup(items, norm(name))?.cls;
    const v = values[norm(name)] ?? (cls ? values[String(cls).toLowerCase()] : undefined);
    const n = Number(v?.value ?? v);
    return Number.isFinite(n) ? n : null;
  };
  return { bulkOf, valueOf, buyable };
}

const COOP_REAGENTS = ['blue dragon scale', 'blue mushroom', 'dark angel feather', 'diamond', 'dragonfly eye',
  'edible mushroom', 'elderberry', 'emerald', 'entroot berry', 'fairy wing', 'firesand', 'heartstone', 'herb',
  'kriipa claw', 'mushroom', 'orc tooth', 'polished seraphym', 'purple mushroom', 'rainbow fern', 'red mushroom',
  'ruby', 'sapphire', 'shaman blood', 'uncut seraphym', 'vial of solagh', 'web moss', 'yrxl sap'];

// ------------------------------------------------------------------------------------- cli
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  const has = n => argv.includes(`--${n}`);
  const root = resolve(flag('root', join(HERE, '..')));
  const planFile = process.env.M59_GUILD_PLAN || join(root, 'substrate', 'guild-plan.json');
  const stateFile = process.env.M59_FEED_ME_MORE || join(root, 'substrate', 'feed-me-more.json');
  const [cmd = 'show', subject] = argv[0]?.startsWith('--') ? ['show'] : argv;

  const raw = JSON.parse(readFileSync(planFile, 'utf8'));
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
  state.config = { ...DEFAULT_CONFIG, ...(state.config ?? {}) };
  state.demands ??= [];

  if (cmd === 'add') {
    const per = Number(flag('per-chest'));
    if (!subject || !(per > 0)) { console.error('usage: add "<item>" --per-chest N [--chests r18c2,r18c6] [--also a,b] [--why "..."] [--apply]'); process.exit(2); }
    const d = { item: norm(subject), per_chest: Math.floor(per),
      chests: flag('chests') ? flag('chests').split(',').map(s => slotOf(s.trim())) : null,
      also: flag('also') ? flag('also').split(',').map(norm).filter(Boolean) : [],
      why: flag('why', ''), at: new Date().toISOString() };
    state.demands = state.demands.filter(x => norm(x.item) !== d.item).concat(d);
  } else if (cmd === 'remove') {
    const before = state.demands.length;
    state.demands = state.demands.filter(x => norm(x.item) !== norm(subject));
    if (state.demands.length === before) { console.error(`no demand for "${subject}"`); process.exit(2); }
  } else if (cmd === 'config') {
    for (const k of ['floor-fraction', 'floor-total', 'rounds']) if (flag(k) != null)
      state.config[k.replace('-', '_')] = Number(flag(k));
    if (flag('order') != null) state.config.order = flag('order') === 'auto' ? null : flag('order').split(',').map(norm);
  } else if (cmd !== 'show') { console.error(`unknown command ${cmd}`); process.exit(2); }

  const { bulkOf, valueOf, buyable } = liveInputs(root);
  const order = cutOrder({ reagents: COOP_REAGENTS, bulkOf, valueOf, buyable, order: state.config.order });
  const current = planTargets(raw);
  const slots = Object.keys(current);
  const tracked = [...new Set([...order, ...state.demands.map(d => norm(d.item)),
    ...Object.values(state.baseline ?? {}).flatMap(o => Object.keys(o))])];
  state.baseline = refreshBaseline({ baseline: state.baseline, written: state.written, current, items: tracked, slots });
  const result = allocate({ baseline: state.baseline, demands: state.demands, config: state.config, order, bulkOf, slots });

  console.log(`cut order (cheapest buyable per bulk first): ${order.join(', ')}`);
  console.log(`floors: ${state.config.floor_fraction} of the original target per round, ${state.config.rounds} rounds, ` +
              `never under ${state.config.floor_total} across the chests holding it`);
  if (!state.demands.length) console.log('no demands — every reagent at its original target');
  for (const d of state.demands)
    console.log(`demand: ${d.per_chest} "${d.item}" per chest${d.chests ? ` in ${d.chests.join(', ')}` : ''}` +
                `${d.also?.length ? ` (also counting ${d.also.join(', ')})` : ''}${d.why ? ` — ${d.why}` : ''}`);
  for (const slot of slots) {
    const changes = Object.entries(result.targets[slot] ?? {}).filter(([i, n]) => (current[slot]?.[i] ?? 0) !== n);
    if (!changes.length && !result.unmet[slot]) continue;
    console.log(`\n${slot}:`);
    for (const [i, n] of changes) console.log(`  ${i.padEnd(20)} ${String(current[slot]?.[i] ?? 0).padStart(5)} -> ${n}` +
      `${state.baseline[slot]?.[i] != null && n < state.baseline[slot][i] ? `  (original ${state.baseline[slot][i]}, co-op capped)` : ''}`);
    if (result.unmet[slot]) console.log(`  UNMET: ${result.unmet[slot]} bulk could not be freed above the floors`);
  }

  if (!has('apply')) { console.log('\n(dry run — nothing written; add --apply)'); process.exit(0); }
  // Items no demand asks for any more are written back to their baseline (or removed).
  for (const slot of slots) for (const [item, b] of Object.entries(state.baseline[slot] ?? {}))
    if (!(item in (result.targets[slot] ??= {}))) result.targets[slot][item] = b ?? 0;
  const next = applyToPlan(raw, { targets: result.targets, caps: result.caps, demands: state.demands,
                                  clearCaps: slots, baseline: state.baseline });
  // The backup goes under substrate/history/ (gitignored), never beside the plan: an untracked
  // file in the deploy checkout makes `m59-deploy.mjs --cut` refuse, which is how this was found.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(dirname(planFile), 'history', 'feed-me-more');
  mkdirSync(backupDir, { recursive: true });
  const backup = join(backupDir, `guild-plan.before-${stamp}.json`);
  copyFileSync(planFile, backup);
  writeFileSync(planFile + '.tmp', JSON.stringify(next, null, 2) + '\n');
  renameSync(planFile + '.tmp', planFile);
  state.written = planTargets(next);
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2) + '\n');
  renameSync(stateFile + '.tmp', stateFile);
  console.log(`\nwrote ${planFile} (backup ${backup}) and ${stateFile}`);
}
