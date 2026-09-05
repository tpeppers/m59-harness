#!/usr/bin/env node
// THE BARLOQUE SELL CIRCUIT — plan (and, later, drive) a multi-stop town run that clears a
// mixed pack across the category merchants instead of dumping it all on Roq (room 110).
//
//   node tools/m59-sellrun.mjs --agent t8            # plan the circuit for one character
//   node tools/m59-sellrun.mjs --agents t4,t5,t6     # several
//   node tools/m59-sellrun.mjs --agent t8 --spec substrate/sellrun.json
//   node tools/m59-sellrun.mjs --pack '["axe","emerald (x3)","herb (x40)","wand"]'   # offline
//
// WHY IT EXISTS. townDestinations() picks ONE shop, and for a mixed pack that shop is Roq —
// the one NPC that buys every category — so a full pack has always meant a trip to room 110.
// With 110 banned (its tunnel is unsafe), a full pack deadlocks: nothing to sell to, nothing
// safe to drop. This routes the pack across the Barloque specialists instead: equipment to
// the smith, gems to the jeweler, reagents to the herbalist, the rare keepers into the vault,
// then reagents bought and the surplus banked. The circuit is in substrate/sellrun.json (an
// ORDER, gitignored); the shape is substrate/sellrun.example.json.
//
// PLAN-ONLY BY DEFAULT, ON PURPOSE. Selling is an allowlist and merchants are picky
// (docs/m59-economy.md): a smith handed a mushroom answers with silence, "trade lies in both
// directions", and a banker-robber takes goods for nothing. So this SHOWS what it would sell
// where — read off the character's live pack — and does not touch the fleet. Live execution is
// a follow-up that must be validated one character at a time against a purse delta.
//
// The lane a merchant BUYS is derived from what it SELLS in substrate/m59-merchants.json — a
// merchant buys the lane it stocks. Nothing about the categories is hardcoded here.
import { readFileSync, readdirSync } from 'node:fs';
// THE PROTECTED LIST IS NOT THIS FILE'S TO INVENT. See protectFor() below.
import { planTownStop } from './m59-townstop.mjs';
import { loadoutFor } from './m59-loadout.mjs';
import { resolveFleet } from './m59-fleetpath.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const sub = (f) => join(HERE, '..', 'substrate', f);
const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const has = (n) => process.argv.includes('--' + n);
const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));

const specPath = arg('spec', sub('sellrun.json'));
let spec;
try { spec = readJSON(specPath); }
catch { spec = readJSON(sub('sellrun.example.json')); console.error(`(no ${specPath}; using the example shape)`); }

const merchants = (() => { const m = readJSON(sub('m59-merchants.json')); return Array.isArray(m) ? m : (m.merchants || Object.values(m)); })();
const itemsTable = (() => { try { return readJSON(sub('m59-items.json')).items || {}; } catch { return {}; } })();

// PER-NPC SELLING RULES (substrate/merchants/<room>.json): stack caps, money caps, enabled flag.
// A missing file means no extra constraint — the committed default. See substrate/merchants.example.json.
const merchantRules = (() => {
  const out = {};
  try { for (const f of readdirSync(sub('merchants'))) if (f.endsWith('.json')) { const r = readJSON(sub(join('merchants', f))); if (r.room != null) out[r.room] = r; } } catch {}
  return out;
})();
const ruleFor = (room) => merchantRules[room] || merchantRules[String(room)] || {};

// FLEET PREFERENCES (substrate/preferences.json): named toggles. A missing key means its default.
const prefs = (() => { try { return readJSON(sub('preferences.json')); } catch { try { return readJSON(sub('preferences.example.json')); } catch { return {}; } } })();
const prefOn = (name) => prefs?.[name]?.enabled !== false;   // default ON unless explicitly disabled

// name -> class, best effort: exact table hit, else the item's own words.
const classOf = (name) => {
  const key = String(name || '').toLowerCase().replace(/\s*\(x\d+\)\s*$/, '').trim();
  return itemsTable[key]?.cls ?? null;
};
// each stop's accepted CLASSES = the classes that merchant sells (it buys what it stocks).
const laneClasses = (room) => {
  const set = new Set();
  for (const mch of merchants) if (Number(mch.room) === Number(room))
    for (const s of (mch.sells || [])) if (s?.cls) set.add(String(s.cls).toLowerCase());
  return set;
};
const stops = (spec.stops || []).map(st => ({ ...st, classes: laneClasses(st.room) }));
const reagentFloor = spec.keep_always?.reagent_floor || {};

// WHAT EACH LANE ACTUALLY BUYS, by NAME. A merchant buys a whole category, not just the four
// things it happens to stock, so deriving the lane from its `sells` list under-reports (a smith
// stocks a hammer and buys every shield and sword). These patterns match what the specialist
// merchants' ObjectDesired accepts. `sell_all` is still the authority live — it quotes each item
// and skips refusals — so a pattern that is slightly wide costs a quote, never a wrong sale.
const LANE = {
  gems:      /sapphire|emerald|diamond|ruby|topaz|amethyst|opal|pearl|jade|garnet|crystal|onyx/i,
  equipment: /shield|sword|armor|armour|\baxe\b|hammer|\bmace\b|dagger|\bbow\b|flail|staff|halberd|spear|helm|gauntlet|\bmail\b|\bplate\b|breastplate|greaves/i,
  reagents:  /mushroom/i,   // LOOT mushrooms only; inky-cap and the create-food reagents are caught first below
};
// Never sold or vaulted-away: create-food reagents (kept and topped up), and the rare keepers.
const KEEP_REAGENT = /\bherb\b|elderberry/i;
// AND NEVER SELL A MEAL. While the Duke's tables are open, food is the scarcest thing this
// fleet carries and the only thing it cannot buy: vigor above the resting cap of 80 comes
// ONLY from eating, so a slice of pork is worth more standing in a pack than anything an
// apothecary pays for it.
//
// `mushroom` on its own is a REAGENT and stays sellable — the brown one players call a
// "brown" is named just `mushroom`, and red and blue are reagents too. Only `edible
// mushroom` and `Inky-cap mushroom` are in the game's Food class tree, and they have to be
// named explicitly here because `edible mushroom` contains `mushroom` and the lane pattern
// above cannot tell them apart. See m59-food-test.
const KEEP_FOOD = /slice of pork|bowl of soup|roast pig|cauldron of soup|spider eye|drumstick|bunch of grapes|goblet of ale|fortune cookie|edible mushroom|inky-?cap/i;
const VAULT = new RegExp('(' + (spec.vault?.keep || []).map(s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'i');
// the exact fragments handed to sell_all's `keep` so it never offers a protected item.
//
// THE HARDCODED PAIR IS A FALLBACK NOW, NOT THE ANSWER. 'herb' and 'elderberry' are the two
// reagents somebody thought of; a character told to carry a THIRD had it fenced at the first
// stop and bought back at the last, paying the merchant spread twice for a pack that ended
// the same. The loadout already knows what each character is meant to hold, so ask it — and
// keep this list only for a character that has no loadout yet.
const PROTECT = [...new Set([...(spec.vault?.keep || []), 'herb', 'elderberry',
                             'slice of pork', 'bowl of soup', 'edible mushroom'])];

/**
 * Everything this character must not be offered, from its own loadout where it has one.
 * Falls back to PROTECT, because an absent loadout means "the behaviour that was already
 * there" and never "protect nothing".
 */
function protectFor(character, items = []) {
  if (!character) return PROTECT;
  let plan = null;
  try { plan = planTownStop(loadoutFor(character), { items }); } catch { plan = null; }
  if (!plan) return PROTECT;
  return [...new Set([...PROTECT, ...plan.keep_fragments])];
}

// ---- read a character's pack (live from the broker, or --pack for offline) ----
async function livePack(agent) {
  const res = await fetch('http://127.0.0.1:8901/', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'inventory', arguments: { agent } } }),
    signal: AbortSignal.timeout(15000) });
  const r = await res.json();
  const text = r.result?.content?.[0]?.text;
  if (r.result?.isError) throw new Error(text || 'inventory error');
  let inv; try { inv = JSON.parse(text); } catch { inv = null; }
  // shape tolerance: {pack:[...]} of strings, or {items:[{name,amount}]}
  const raw = inv?.pack ?? inv?.items ?? inv?.carrying ?? [];
  return raw.map(x => typeof x === 'string' ? x : `${x.name}${x.amount > 1 ? ` (x${x.amount})` : ''}`);
}

const qtyOf = (s) => { const m = String(s).match(/\(x(\d+)\)/); return m ? +m[1] : 1; };
const bare = (s) => String(s).replace(/\s*\(x\d+\)\s*$/, '').trim();

// A LOADOUT IS FILED UNDER THE CHARACTER, NOT THE AGENT HANDLE. The roster is the only
// thing that knows which is which, and WHICH roster is itself a question — same resolution
// order every other tool here uses, most explicit first.
// resolveFleet() is the ONE resolver, and using it rather than reading the file is the whole
// lesson of this change: substrate/fleet-default carries four lines of comment above the
// name, so a bare readFileSync().trim() returns the comments and every lookup silently
// misses. Written by hand here first, and it did exactly that.
const ROSTER_PATH = resolveFleet().stateFile;
const characterOf = (agent) => {
  try { return readJSON(ROSTER_PATH)?.[agent]?.credentials?.character ?? null; } catch { return null; }
};
// The pack in the shape planTownStop reads. A failure here must not stop the circuit — it
// only means we fall back to PROTECT, which is the behaviour that was already there.
async function packItemsOf(agent) {
  try { return (await livePack(agent)).map(s => ({ name: bare(s), amount: qtyOf(s) })); }
  catch { return []; }
}

const laneMerchant = { gems: 'Herbutte', equipment: "Fehr'loi Qan", reagents: 'Joguer' };
// A PLAN THAT ADVERTISES A SALE EXECUTION WILL REFUSE IS A THIRD ANSWER TO THE SAME
// QUESTION. `protect` is the list executeCircuit() hands sell_all, so passing it here is
// what keeps the printed circuit and the actual one the same document. Omitted, it falls
// back to the module PROTECT and behaves as it always did.
function planFor(pack, protect = PROTECT) {
  const guarded = (name) => (protect || []).some(p => name.includes(String(p).toLowerCase()));
  const plan = { stops: {}, vault: [], keep: [], reagentsHeld: {} };
  for (const st of stops) plan.stops[st.merchant] = [];
  for (const it of pack) {
    const name = bare(it), lname = name.toLowerCase();
    // create-food reagents held, for the buy math
    for (const rk of Object.keys(reagentFloor)) if (new RegExp(`\\b${rk}`, 'i').test(lname)) plan.reagentsHeld[rk] = (plan.reagentsHeld[rk] || 0) + qtyOf(it);
    // order matters: money and worn are kept by sell_all itself; here we sort the rest.
    if (/\bshilling|\bcoins?\b/i.test(lname)) { plan.keep.push(it); continue; }
    if (VAULT.test(lname)) { plan.vault.push(it); continue; }          // rare keepers (incl. inky-cap)
    if (KEEP_REAGENT.test(lname)) { plan.keep.push(`${it}  [create-food reagent — keep]`); continue; }
    if (KEEP_FOOD.test(lname)) { plan.keep.push(`${it}  [food — vigor above 80 comes only from eating]`); continue; }
    if (guarded(lname)) { plan.keep.push(`${it}  [this character's loadout protects it]`); continue; }
    const lane = LANE.gems.test(lname) ? 'gems' : LANE.equipment.test(lname) ? 'equipment' : LANE.reagents.test(lname) ? 'reagents' : null;
    if (lane) plan.stops[laneMerchant[lane]].push(it);
    else plan.keep.push(`${it}  (no lane — carried, never fenced blind)`);
  }
  return plan;
}

function render(agent, pack, plan) {
  console.log(`\n=== ${agent} — Barloque sell circuit (plan only) ===`);
  console.log(`pack (${pack.length}): ${pack.join(', ') || '(empty)'}`);
  for (const st of stops) {
    const rule = ruleFor(st.room);
    if (rule.enabled === false) { console.log(`  ${String(st.room).padEnd(4)} ${st.merchant.padEnd(14)} — DISABLED (${rule.note || 'merchant off'})`); continue; }
    const cap = rule.max_stack;
    const items = plan.stops[st.merchant].map(it => {
      const q = qtyOf(it);
      if (cap && q > cap) { const n = Math.ceil(q / cap); return `${it} -> ${n} offers of <=${cap} (this merchant refuses a stack over ${cap})`; }
      return it;
    });
    console.log(`  ${String(st.room).padEnd(4)} ${st.merchant.padEnd(14)} (${st.buys})${cap ? ` [<=${cap}/offer]` : ''}: ${items.length ? items.join(', ') : '— nothing this trip'}`);
  }
  console.log(`  ${String(spec.vault?.room).padEnd(4)} ${'vault'.padEnd(14)} (deposit): ${plan.vault.length ? plan.vault.join(', ') : '— nothing to store'}`);
  const br = spec.buy_reagents || {};
  const buys = Object.entries(br.targets || {}).map(([k, want]) => { const have = plan.reagentsHeld[k] || 0; const need = Math.max(0, want - have); return `${k} ${have}/${want}${need ? ` (buy ${need})` : ' (full)'}`; });
  console.log(`  ${String(br.at_room).padEnd(4)} ${'buy reagents'.padEnd(14)} @ ${br.town}: ${buys.join(', ')}`);
  console.log(`  ${String(spec.bank?.room).padEnd(4)} ${'bank'.padEnd(14)} @ ${spec.bank?.town}: deposit proceeds above ${spec.bank?.keep_walking_money} walking money`);
  if (plan.keep.length) console.log(`  keep/carry: ${plan.keep.join(', ')}`);
}

const agents = (arg('agents') || arg('agent') || '').split(',').map(s => s.trim()).filter(Boolean);
const rawPack = arg('pack');

// ---- broker plumbing for live execution ----
const call = async (name, argsObj, ms = 90000) => {
  const res = await fetch('http://127.0.0.1:8901/', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: argsObj } }),
    signal: AbortSignal.timeout(ms) });
  const r = await res.json();
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r);
  if (r.result?.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
};
const statusOf = async (agent) => { try { return await call('status', { agent }, 15000); } catch { return null; } };
const purseOf = async (agent) => { const s = await statusOf(agent); return s?.money?.carrying ?? s?.purse ?? s?.gold ?? s?.money ?? null; };
const roomOf = async (agent) => { const s = await statusOf(agent); const r = s?.room; return typeof r === 'object' ? (r.num ?? r.id) : r; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// travel is a multi-room WALK that returns immediately; wait until the character is actually
// in `room` (or give up) before interacting with a merchant there.
async function travelAndArrive(agent, room, log, maxWaitS = 240) {
  await call('travel', { agent, to: room }, 30000).catch(() => {});
  const start = Date.now();
  while ((Date.now() - start) / 1000 < maxWaitS) {
    await sleep(4000);
    if ((await roomOf(agent)) === room) return true;
  }
  log.push(`     did not arrive at room ${room} within ${maxWaitS}s — skipping this stop`);
  return false;
}
// the order set to restore after the run — the current unrestricted fleet config.
const restoreOrders = (hunt) => hunt === 'battered skeleton'
  ? { mode: 'farm', hunt, roam: true, assigned_room: null, confine_rooms: [], banned_destinations: [110], require_safe_wall: true, use_safe_spots: true, max_bots_per_safe_spot: 1, defend_against_players: true, clear_weak: true, max_carry: 200, drop_at_load: null, sell_at_load: 1, sell_when_broke: false, bank_above: null }
  : { mode: 'farm', hunt: hunt || 'fungus beast', roam: true, assigned_room: null, confine_rooms: [], banned_destinations: [110], require_safe_wall: true, use_safe_spots: true, max_bots_per_safe_spot: 1, defend_against_players: true, drop_at_load: null, sell_at_load: 1, sell_when_broke: false, bank_above: null };

// Run the Barloque circuit for one character. Keeper is stopped for the errand and its orders
// are ALWAYS restored (finally), so a crash mid-run never leaves a character parked.
async function executeCircuit(agent) {
  const log = [];
  const before = await purseOf(agent);
  // DO NOT stop the keeper: `travel` only walks with a RUNNING keeper (it holds the keeper INERT for
  // the journey and drives the walk itself), and a stopped keeper sits still. So the keeper stays
  // running throughout — travel holds it inert per leg, sell_all freezes the tick during a sale — and
  // there is nothing to restore because its orders were never changed. If this crashes mid-run the
  // last travel job simply completes and the keeper resumes farming a cleared pack.
  log.push(`${agent}: purse ${before} — running the sell circuit (keeper stays live)`);
  // vault keepers + whatever THIS character's loadout protects; sell_all also keeps money
  // and worn gear on its own. Read from the live pack so a floor can be counted against it.
  const protect = protectFor(characterOf(agent), await packItemsOf(agent));
  {
    for (const st of stops) {
      if (ruleFor(st.room).enabled === false) { log.push(`  -> ${st.merchant} (${st.room}) — DISABLED, skipped`); continue; }
      log.push(`  -> ${st.merchant} (${st.room})`);
      if (!await travelAndArrive(agent, st.room, log)) continue;   // wait for the WALK to finish
      // The merchant is resolved by NAME in the room we just walked to — not the room number.
      // max_stack comes from the per-NPC rule (the jeweler's 25-cap) so big stacks sell in chunks.
      const sold = await call('sell_all', { agent, merchant: st.merchant, keep: protect, min_price: 1, max_stack: ruleFor(st.room).max_stack ?? null }, 120000)
        .catch(e => ({ error: e.message }));
      if (sold?.error) log.push(`     sell_all error: ${sold.error}`);
      else log.push(`     sold ${sold?.sold?.length ?? 0} item(s) for ${sold?.total_received ?? 0}` +
        (sold?.refused?.length ? `, ${sold.refused.length} refused` : ''));
    }
    // bank the proceeds above walking money, at Tos (bank room 54)
    const bankRoom = spec.bank?.room ?? 54, keepWalk = spec.bank?.keep_walking_money ?? 400;
    const atBank = await travelAndArrive(agent, bankRoom, log);
    const purse = atBank ? await purseOf(agent) : null;
    if (purse != null && purse > keepWalk) {
      const dep = purse - keepWalk;
      const b = await call('bank', { agent, action: 'deposit', amount: dep }, 30000).catch(e => ({ error: e.message }));
      log.push(`  bank: ${b?.error ? 'error ' + b.error : 'deposited ~' + dep}`);
    } else log.push(`  bank: nothing above ${keepWalk} to deposit (purse ${purse})`);
  }
  const after = await purseOf(agent);
  log.push(`${agent}: done. purse ${before} -> ${after}.`);
  return log.join('\n');
}

if (rawPack) {
  render('offline', pack_from(rawPack), planFor(pack_from(rawPack)));
} else if (has('execute') && agents.length) {
  if (!prefOn('sell_circuit')) { console.log("preference 'sell_circuit' is disabled in substrate/preferences.json — not running. Enable it to run the circuit."); process.exit(0); }
  const delayMin = Number(arg('delay', '2'));
  console.log(`LIVE sell-run circuit for ${agents.length} character(s), ${delayMin} min apart. Ctrl-C is safe (keeper restores in finally).`);
  for (let i = 0; i < agents.length; i++) {
    console.log(`\n[${i + 1}/${agents.length}] ${new Date().toISOString().slice(11, 19)}`);
    console.log(await executeCircuit(agents[i]));
    if (i < agents.length - 1) await new Promise(r => setTimeout(r, delayMin * 60000));
  }
} else if (agents.length) {
  for (const a of agents) {
    try {
      const pack = await livePack(a);
      render(a, pack, planFor(pack, protectFor(characterOf(a), await packItemsOf(a))));
    }
    catch (e) { console.log(`\n=== ${a} — could not read pack: ${e.message}`); }
  }
} else {
  console.log('plan:    m59-sellrun.mjs --agent t8   (or --agents t4,t5   or --pack \'["axe"]\')');
  console.log('execute: m59-sellrun.mjs --execute --agents t8,t4  [--delay 2]');
}
function pack_from(s) { return JSON.parse(s); }
