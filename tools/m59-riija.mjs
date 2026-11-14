// THE SWORD OF RIIJA, AS DATA: rooms, NPCs, request lines, both of Wulfgang's cargo tables, the
// hall-713 stocking manifest, the orc-pit chamber puzzle, and the small team barrier the pit-boss
// phase needs. Pure: no socket, no broker, nothing runs on import. The three FleetScripts that use it
// are tools/fleetscripts/riija-prep.mjs, riija-pitboss.mjs and riija-quester.mjs; the derivation with
// kod line citations is m59-research/reports/riija-sword-quest.md (Meridian59 fe93b6c6), and the
// corrections made against the kod while writing this are marked CORRECTED below.
//
// WHY A SWORD AT ALL: the Monk of Riija (Ko'catan, room 2151) teaches Riija spells only to someone
// WIELDING a sword of Riija bound to themselves (kcrjmonk.kod CanAddSpell: GetPlayerUsing includes a
// RiijaSword whose GetQuester = who). Four shards from four NPCs, all with the same quester, assemble
// themselves into that sword the moment the fourth arrives (swshard.kod:52-150).

// ---------------------------------------------------------------- the world

// CORRECTED: the report (and the operator's brief) put Wulfgang in 2144. 2144 is RID_KD4, the jungle
// clearing OUTSIDE his shop; `RID_TRADING_POST = 2144` in blakston.khd:824 is an alias of it. The
// shop he stands in is tpost1.kod, piRoom_num RID_JUNGLE_TRADING_POST = 2101 (blakston.khd:795),
// and `Create(&KocatanTradeMaster)` is at tpost1.kod:85 at r3c7. m59-merchants.json agrees (2101).
export const ROOMS = Object.freeze({
  trader: 2101,        // Wulfgang zax'Ak, "The Remote Trading Post of Wulfgang zax'Ak" (tpost1.kod)
  traderYard: 2144,    // RID_KD4, the clearing the post is entered from (tpost1.kod:62-64)
  bowmaker: 2100,      // Hanla zax'Ta, The Bowmaker's Hut (bowhut.kod:86)
  priestess: 2141,     // The Bone Priestess, Lair of the Bone Priestess (kd1.kod:93)
  scientist: 2136,     // Bahal zax'Ot, Hut of the Mad Scientist (kmadscih.kod:68)
  hive: 2111,          // Cliff Hive, RID_KA1: dragonflies 90 / queens 10 (ka1.kod:44-57)
  hall: 713,           // The Hall of the Slaughtered Command (guildh13.kod), m59-guild-passage HALLS[713]
  tailor: 2006,        // Tepal ix'Zonak, The Crooked Hem Garment Shop (koctail.kod:95)
  inn: 2001,           // Moxal ix'Hanak, The Aerie Guest House (meat pies)
  feastHall: 953,      // The Duke's Feast Hall (duke4.kod): infinite grape and ale dispensers
  pit: 2506,           // Lair of the Orc Pit Boss (bossroom/orcpit1.kod)
  pitA: 2507,          // Grog's Antechamber (orcpita.kod), entered from 2502 (south edge)
  pitB: 2508,          // Brog's Antechamber (orcpitb.kod), entered from 2501 (south edge)
});

export const NPCS = Object.freeze({ trader: "Wulfgang zax'Ak", bowmaker: "Hanla zax'Ta",
  priestess: 'The Bone Priestess', scientist: "Bahal zax'Ot" });

// Which NPC gives which shard, and the word that starts it (questengine.kod:351-372).
export const SHARDS = Object.freeze({
  A: { npc: 'priestess', room: ROOMS.priestess, trigger: 'riija', what: 'tip' },
  B: { npc: 'scientist', room: ROOMS.scientist, trigger: 'kohuzotz', what: 'blade' },
  C: { npc: 'trader', room: ROOMS.trader, trigger: 'inventory', what: 'crosspiece' },
  D: { npc: 'bowmaker', room: ROOMS.bowmaker, trigger: 'arrows', what: 'handle' },
});
export const SHARD_ORDER = Object.freeze(['C', 'D', 'A', 'B']);   // the report's recommended order

// THE SERVER'S SENTENCES, matched on fragments that survive the client's markup and the
// double spaces after full stops (questengine.kod:351-384). Each assignment is said ONCE, privately.
export const LINES = Object.freeze({
  A: /Hedd of Pit Boss/i,                                  // bonepriestessquest_assign_2
  B: /bring me a live specimen/i,                          // madscientistquest_assign_2
  C: /replenish my inventory/i,                            // tradingpost_assign_2
  Dgood: /willing to trade a tailfeather/i,                // bowmaker_assign_2 (karma >= +10)
  Devil: /kill avar shamans/i,                             // bowmaker_assign_4 (karma <= -10)
  okA: /chp chp chp/i,                                     // bonepriestessquest_success_2
  okB: /good work, fair apprentice/i,                      // madscientistquest_success_2
  okC: /splendid\.\s+here, i don't need this/i,            // tradingpost_success_2
  okD: /scrap of metal as your reward/i,                   // bowmaker_success_3
  ore: /nyuk nyuk/i,                                       // bowmaker_success_2 (the priestess took the ore)
  queen: /obvious adoration/i,                             // dflyq.kod:295-340, the charm took
});

// Quest node time limits are one REAL hour each (questengine.kod:2924,2953,2982,2999,3028,3041,3058);
// a failure locks a retry for an hour of LOGGED-IN time. Kept a little under, so a delivery that would
// land in the last minute is refused rather than sent into an expired node.
export const NODE_MS = 3600_000;
export const NODE_MARGIN_MS = 90_000;

// ---------------------------------------------------------------- karma

// quest.kod:126-134: GOOD is karma >= 10, EVIL is karma <= -10, endpoints included. Between them
// neither Wulfgang nor Hanla assigns anything at all (the karma-gated templates both refuse).
export const KARMA_LINE = 10;
export function karmaSide(karma) {
  const k = Number(karma);
  if (!Number.isFinite(k)) return null;
  if (k >= KARMA_LINE) return 'good';
  if (k <= -KARMA_LINE) return 'evil';
  return null;
}

// ---------------------------------------------------------------- items

// Display names exactly as the kod spells them (the singular and the plural the server uses
// when it names a stack). `match` is anchored so "meat pie" never matches "a slice of meat pie"
// and "goblet of ale" never matches "goblet of wine".
const item = (name, plural, extra = {}) => Object.freeze({ name, plural,
  match: new RegExp(`^(?:${escape(name)}|${escape(plural)})$`, 'i'), ...extra });
function escape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export const ITEMS = Object.freeze({
  head: item('orc pit boss head', 'orc pit boss heads', { weight: 80, bulk: 100 }),   // bosshead.kod:19,29-30
  nerudite: item('chunk of nerudite', 'chunks of nerudite'),                          // nerudore.kod:20
  feather: item('feather of an avar shaman', 'feathers of an avar shaman'),           // avarfeth.kod:19
  meatPie: item('meat pie', 'meat pies'),                                             // meatpie.kod:19,26
  waterSkin: item('water skin', 'water skins'),                                       // watrskin.kod:19
  apple: item('apple', 'apples'),                                                     // apple.kod:19,26
  grapes: item('bunch of grapes', 'bunches of grapes'),                               // grapes.kod:19,25
  elderberry: item('elderberry', 'elderberries'),
  herbs: item('herbs', 'herbs'),
  mushroom: item('mushroom', 'mushrooms'),
  jewelOfFroz: item('Jewel of Froz', 'Jewels of Froz'),                               // frozjewl.kod:25
  mysticSword: item('mystic sword', 'mystic swords'),                                 // mystswrd.kod:19
  plateArmor: item('plate armor', 'plate armor'),                                     // plate.kod:19
  mugOfBrew: item('mug of brew', 'mugs of brew'),                                     // gobletst.kod:19,25 (StoutGoblet)
  wine: item('goblet of wine', 'goblets of wine'),                                    // gobletwn.kod:19,23
  ale: item('goblet of ale', 'goblets of ale'),                                       // goblet.kod:19,23
  sword: item('sword of Riija', 'swords of Riija'),                                   // riijaswd.kod:19
  shard: item('shard of a sword', 'shards of a sword'),                               // swshard.kod:18
});

// WHERE EACH THING COMES FROM. `island: true` sources are reachable from 713 without crossing the
// caves; everything else is mainland and rides over with island-trip. Read from
// substrate/m59-merchants.json (built from each merchant's plFor_sale) and the kod; the CONDITIONAL
// row (Tepal's nerudite) is not on any shelf until the trigger is said -- the same mechanism as
// Paddock's orc teeth (buy-orc-teeth.mjs, monster.kod:4725-4745). `kind`:
//   shop      walk, (say trigger), buy                     -- prices are the merchant's own
//   dispense  walk, `activate` a FoodDispenser N times     -- one item per activation, unlimited
//   hall      draw from another guild hall the courier may enter (714 / 703)
//   loot      only drops; farm it, or have it already in a hall
export const SOURCES = Object.freeze({
  meatPie: [{ kind: 'shop', seller: 'Moxal', room: 2001, island: true },
            { kind: 'shop', seller: 'Tova', room: 202 }, { kind: 'shop', seller: 'Pietro', room: 371 },
            { kind: 'shop', seller: 'Meidei', room: 103 }],
  waterSkin: [{ kind: 'shop', seller: 'Meidei', room: 103 }, { kind: 'shop', seller: 'Zhieu', room: 373 },
              { kind: 'shop', seller: 'Solomon', room: 151 }],
  apple: [{ kind: 'shop', seller: 'Wulfgang', room: 2101, island: true },
          { kind: 'shop', seller: 'Meidei', room: 103 }, { kind: 'shop', seller: 'Solomon', room: 151 }],
  grapes: [{ kind: 'dispense', room: 953, dispenser: /grape/i }, { kind: 'hall' }],
  // Operator rule 2026-10-27: herbs from Zhieu, never Tos. Zhieu sells all three reagents.
  elderberry: [{ kind: 'shop', seller: 'Zhieu', room: 373 }, { kind: 'hall' }],
  herbs: [{ kind: 'shop', seller: 'Zhieu', room: 373 }, { kind: 'hall' }],
  mushroom: [{ kind: 'shop', seller: 'Zhieu', room: 373 }, { kind: 'hall' }],
  jewelOfFroz: [{ kind: 'hall' }, { kind: 'loot', where: 'Ko\'catan jungle treasure (ka0.kod:90)' }],
  // The orc pit boss's own treasure table holds a mystic sword (orcpit1.kod SetupBossTemplates), so
  // the pit-boss phase deposits one when it drops -- the evil table's cheapest row.
  mysticSword: [{ kind: 'loot', where: 'orc pit boss treasure (orcpit1.kod)' }, { kind: 'hall' }],
  plateArmor: [{ kind: 'hall' }, { kind: 'loot', where: 'armour drops' }],
  mugOfBrew: [{ kind: 'shop', seller: 'Pietro', room: 371 }],
  // Tepal sells a chunk for 1,200 once "precious stones" is said (kctailor.kod:28,115-118). Cave
  // orcs also drop chunks (caveorct.kod:39), so the pit-boss team may bring some home.
  nerudite: [{ kind: 'shop', seller: 'Tepal', room: 2006, island: true, trigger: 'precious stones', price: 1200 },
             { kind: 'hall' }, { kind: 'loot', where: 'cave orc treasure (caveorct.kod:39)' }],
  wine: [{ kind: 'shop', seller: 'Wulfgang', room: 2101, island: true },
         { kind: 'shop', seller: 'Rycksher', room: 954 }, { kind: 'shop', seller: 'Meidei', room: 103 }],
  ale: [{ kind: 'dispense', room: 953, dispenser: /ale|goblet/i }, { kind: 'hall' }],
  head: [{ kind: 'loot', where: 'riija-pitboss.mjs (Orc Caves pit, 2506)' }],
});

// WULFGANG'S TWO TABLES (questengine.kod:2971-2999). He names ONE row, chosen by the server, in one
// private line; quantities are the kod's and NOT the old wiki's. `key` names an ITEMS/SOURCES entry.
export const SHIPMENTS = Object.freeze({
  good: Object.freeze([
    { key: 'meatPie', amount: 50 }, { key: 'waterSkin', amount: 70 }, { key: 'apple', amount: 150 },
    { key: 'grapes', amount: 200 }, { key: 'elderberry', amount: 350 }, { key: 'herbs', amount: 250 },
    { key: 'mushroom', amount: 200 }, { key: 'jewelOfFroz', amount: 1 },
  ]),
  evil: Object.freeze([
    { key: 'mysticSword', amount: 1 }, { key: 'plateArmor', amount: 1 }, { key: 'mugOfBrew', amount: 100 },
    { key: 'nerudite', amount: 1 }, { key: 'wine', amount: 70 }, { key: 'ale', amount: 70 },
  ]),
});

// How the request names the cargo (questnode.kod:540-552): a NumberItem of more than one is
// "<cardinal> <plural>", where the cardinal is a WORD up to twelve and for the round tens and 100
// ("fifty", "seventy", "a hundred") and digits otherwise ("150", "350"); a single item is
// "<indefinite article> <name>" ("a mystic sword", "a chunk of nerudite").
const CARDINALS = Object.freeze({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, 'a hundred': 100 });

/**
 * Which row of the table the request line names, or null. `side` restricts the table (pass the
 * quester's side); with no side both are searched and an ambiguous line is refused. The amount is
 * the TABLE's; a number read off the line that disagrees with it is refused, never preferred.
 */
export function readShipment(lines, side = null) {
  const line = [].concat(lines ?? []).map(String).find(s => LINES.C.test(s));
  if (!line) return null;
  const rows = side ? SHIPMENTS[side] ?? [] : [...SHIPMENTS.good, ...SHIPMENTS.evil];
  const tail = line.slice(line.search(/bring me/i) >= 0 ? line.search(/bring me/i) : 0);
  const hits = rows.filter(r => new RegExp(`\\b(?:${escape(ITEMS[r.key].name)}|${escape(ITEMS[r.key].plural)})\\b`, 'i').test(tail));
  // "goblet of ale" and "goblets of wine" share no words that matter; "mug of brew" stands alone.
  if (hits.length !== 1) return null;
  const row = hits[0], it = ITEMS[row.key];
  const said = /bring me\s+(a hundred|\d+|[a-z]+)\s/i.exec(tail)?.[1]?.toLowerCase();
  const n = said == null ? null : /^\d+$/.test(said) ? Number(said) : CARDINALS[said] ?? null;
  if (n != null && row.amount > 1 && n !== row.amount) return null;
  return { key: row.key, name: it.name, amount: row.amount, raw: line };
}

// ---------------------------------------------------------------- the hall-713 manifest

/**
 * Everything any request on `side` could ask for, so that delivery is only draw -> walk -> offer.
 *   side 'good': Wulfgang's good table + a chunk of nerudite (Hanla's good route) + pies for the queen
 *   side 'evil': Wulfgang's evil table + pies for the queen (Hanla's evil route is a kill; no item)
 * Meat pies appear ONCE, summed: the 50 the trader may want plus `queenPies` spare.
 * The head is listed for completeness (riija-pitboss.mjs deposits it; prep cannot buy one).
 */
export function prepManifest({ side, queenPies = 5, shipments = true, head = true, skip = [] } = {}) {
  if (!['good', 'evil'].includes(side)) throw Error(`side must be good or evil, got ${JSON.stringify(side)}`);
  const want = new Map();
  const add = (key, amount, why) => {
    const prev = want.get(key);
    want.set(key, prev ? { ...prev, amount: prev.amount + amount, why: `${prev.why}; ${why}` } : { key, amount, why });
  };
  if (shipments) for (const r of SHIPMENTS[side]) add(r.key, r.amount, `Wulfgang (${side}) may ask for ${r.amount}`);
  if (side === 'good') add('nerudite', 1, "Hanla's good route: ore to the Bone Priestess");
  if (queenPies > 0) add('meatPie', queenPies, 'one per dragonfly-queen charm attempt');
  if (head) add('head', 1, "the Bone Priestess's tip (from riija-pitboss)");
  const skipped = new Set([].concat(skip).map(s => String(s).trim()).filter(Boolean));
  return [...want.values()].filter(w => !skipped.has(w.key))
    .map(w => ({ ...w, name: ITEMS[w.key].name, sources: SOURCES[w.key] ?? [] }));
}

/** Sum a chest reading (StorageCache.allChests / summarise rows) or a pack, by manifest key. */
export function countByKey(rows = []) {
  const out = {};
  for (const r of rows) {
    const name = String(r?.name ?? '');
    for (const [key, it] of Object.entries(ITEMS)) {
      if (!it.match.test(name)) continue;
      out[key] = (out[key] ?? 0) + (Number(r.amount) || 1);   // amount 0 = one unstackable item
    }
  }
  return out;
}

/** What the hall still lacks: manifest rows with `have` and `short` (0 = stocked). */
export function shortfall(manifest, have = {}) {
  return manifest.map(m => ({ ...m, have: have[m.key] ?? 0, short: Math.max(0, m.amount - (have[m.key] ?? 0)) }));
}

/** The first source of `kind`(s) usable from where the courier is. */
export function pickSource(key, { where = 'island', kinds = ['shop', 'dispense'] } = {}) {
  return (SOURCES[key] ?? []).find(s => kinds.includes(s.kind) && (where === 'island' ? s.island === true : s.island !== true)) ?? null;
}

// ---------------------------------------------------------------- the orc pit puzzle

// orcpitb.kod EvaluatePuzzle, on the lever at r48c29 in 2508 (range 3, lever.kod:58-80): it solves
// when the users counted in chamber A (2507) and chamber B (2508) satisfy A*3 = B, A*2 = B or
// A*2 = B*3.
//
// CORRECTED: the kod's own comment (and the report after it) says "1/3, 1/2 or 2/3 as many people in A
// as in B". The third test as WRITTEN, `NumChamberA * 2 = NumChamberB * 3`, is A:B = 3:2 -- MORE in A
// than in B -- and 2:3 does not solve (2*2=4, 3*3=9). This module follows the code, not the comment:
// three bodies are 1:2, four are 1:3, five are 3:2. Chambers are STRICT bounds on the coarse square (NumInChamber): A is rows 82-90 x cols
// 21-29 of 2507 (orcpita.kod), B is rows 44-52 x cols 25-33 of 2508. EVERY user counts -- a
// stranger standing in a chamber changes the ratio.
//
// What a solve does: both chambers' SOLUTIONSECTOR floors move (A rises from 500 to 600-900, B
// drops from 500 to 0-250) for 60 s (ResetPuzzle timer), and the lever resets. Which heights is
// decided by who stands on marked squares:
//   'squares'  someone on 2507 r83c25 AND on 2508 r45c29 and r51c29  -> A 600 / B 250
//   'plain'    anything else                                         -> A 900 / B   0
// The third branch ("all B squares", A 750 / B 100) can NEVER fire on this source: OrcPitB.AllBUsed
// sets bBTwo three times and never sets bBThree or bBFour (orcpitb.kod:306-339). And 'plain' gives
// the same heights as the all-squares branch, which is why it is the default here. WHERE those
// heights let a body walk to the boss is NOT in our map -- no SOLUTIONSECTOR is baked in
// substrate/m59-variable-sectors.json -- so that is the first thing the live trial must confirm.
export const PIT = Object.freeze({
  A: Object.freeze({ room: ROOMS.pitA, chamber: { rowMin: 82, rowMax: 90, colMin: 21, colMax: 29 },
    marked: Object.freeze([[83, 25]]) }),
  B: Object.freeze({ room: ROOMS.pitB, chamber: { rowMin: 44, rowMax: 52, colMin: 25, colMax: 33 },
    marked: Object.freeze([[45, 29], [51, 29]]), lever: Object.freeze({ row: 48, col: 29, range: 3 }) }),
  resetMs: 60_000,
});
// Squares inside each chamber, off every marked square, for the 'plain' solution; the lever puller
// stands within range of the lever. [row, col]. Walkability is the live trial's to confirm.
const PLAIN = Object.freeze({ A: [[86, 25], [85, 24], [87, 26]], B: [[48, 27], [47, 31], [49, 31], [46, 27], [50, 31]] });

export function inChamber(pos, side) {
  const c = PIT[side]?.chamber, r = Number(pos?.row), k = Number(pos?.col);
  return !!c && Number.isFinite(r) && Number.isFinite(k) && r >= c.rowMin && r <= c.rowMax && k >= c.colMin && k <= c.colMax;
}
export const onMarked = (pos, side) => (PIT[side]?.marked ?? []).some(([r, c]) => r === Number(pos?.row) && c === Number(pos?.col));
export const pitSolves = (a, b) => a > 0 && b > 0 && (a * 3 === b || a * 2 === b || a * 2 === b * 3);   // verbatim from EvaluatePuzzle

/**
 * Who stands where. `agents` is the team in order; the first goes to chamber A (the first THREE for a
 * team of five), the rest to chamber B, and `lever` (default the first B member) pulls. Four is the
 * operator's team: 1 in A, 3 in B (A*3=B). Three is 1:2; five is 3:2 (see CORRECTED above).
 * Anything else is refused before anybody walks.
 */
export function pitRoles(agents, { lever = null, solution = 'plain' } = {}) {
  const team = [...agents];
  const plans = { 3: [1, 2], 4: [1, 3], 5: [3, 2] };
  const split = plans[team.length];
  if (!split) throw Error(`the pit puzzle needs a team of 3, 4 or 5 (A:B = 1:2, 1:3 or 3:2); got ${team.length}`);
  if (!['plain', 'squares'].includes(solution)) throw Error(`solution must be plain or squares, got ${solution}`);
  const [na] = split;
  const inA = team.slice(0, na), inB = team.slice(na);
  const puller = lever ?? inB[0];
  if (!inB.includes(puller)) throw Error(`the lever is in chamber B (2508 r48c29); ${puller} is not assigned there`);
  if (solution === 'squares' && inB.length < 3)
    throw Error('the squares solution needs one body on A r83c25 and two on B r45c29/r51c29 besides the puller');
  const roles = [];
  for (const [side, members] of [['A', inA], ['B', inB]]) {
    // The puller first, on a square in reach of the lever (PLAIN.B[0] is r48c27, two columns off it);
    // under 'squares' the marked squares go to the next bodies, the plain ones to anyone left over.
    const order = side === 'B' ? [puller, ...members.filter(m => m !== puller)] : members;
    const pool = solution === 'squares'
      ? (side === 'B' ? [PLAIN.B[0], ...PIT.B.marked, ...PLAIN.B.slice(1)] : [...PIT.A.marked, ...PLAIN.A])
      : PLAIN[side];
    order.forEach((m, i) => {
      const [row, col] = pool[i];
      roles.push({ agent: m, side, room: PIT[side].room, row, col, lever: m === puller });
    });
  }
  return roles;
}

// ---------------------------------------------------------------- a barrier for one run's team

// The runner drives every agent of a run in parallel, in ONE process (m59-fleetscript.mjs, `parallel`),
// so a module-level map is a barrier the four bodies share. Keyed by the run's own key; a later run
// with the same key starts clean only after `clearTeam`. Never persisted: a barrier from a dead run is
// the one thing that must not survive it.
const TEAMS = new Map();
export function teamMark(key, agent, phase, data = {}, now = Date.now) {
  const t = TEAMS.get(key) ?? new Map(); TEAMS.set(key, t);
  const a = t.get(agent) ?? {}; a[phase] = { at: now(), ...data }; t.set(agent, a);
  return a[phase];
}
export const teamRead = (key, agent, phase) => TEAMS.get(key)?.get(agent)?.[phase] ?? null;
export const teamAll = (key, agents, phase) => agents.every(a => teamRead(key, a, phase));
export const clearTeam = key => TEAMS.delete(key);
/** Forget one agent's marks (its run is starting, or over). A dead run's marks must not open a gate. */
export const teamForget = (key, agent) => { TEAMS.get(key)?.delete(agent); };
/**
 * Wait until every agent has marked `phase`, or anyone has marked `abort`. Never throws.
 * `since` (ms) ignores marks older than it -- the waiter passes its own start, so marks a dead
 * earlier run left behind (the REPL is one long-lived process) can neither open nor shut a gate.
 */
export async function teamWait(key, agents, phase, { since = 0, budgetMs = 600_000, pollMs = 2000, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  const until = now() + budgetMs;
  const fresh = (a, ph) => { const m = teamRead(key, a, ph); return m && m.at >= since ? m : null; };
  for (;;) {
    const aborted = agents.find(a => fresh(a, 'abort'));
    if (aborted) return { ok: false, why: `${aborted} aborted: ${fresh(aborted, 'abort')?.why ?? '?'}` };
    if (agents.every(a => fresh(a, phase))) return { ok: true };
    if (now() >= until) return { ok: false, why: `waited ${Math.round(budgetMs / 1000)} s for ${agents.filter(a => !fresh(a, phase)).join(', ')} to reach "${phase}"` };
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------- shards

const lc = s => String(s ?? '').toLowerCase();
/** The shard letter a class name names (SwordShardA..D), or null. */
export const shardKeyOfClass = cls => /^swordshard([abcd])$/i.exec(String(cls ?? ''))?.[1]?.toUpperCase() ?? null;
/** The binding sentence each piece carries (swshard.kod:20, riijaswd.kod:21-26). */
export const boundToShard = (description, character) => lc(description).includes(lc(`${character}'s name is written`));
export const boundToSword = (description, character) => lc(description).includes(lc(`Let ${character} walk with faith.`));
/** Which shards are still needed, given held ones and whether the sword is already there. */
export const shardsNeeded = ({ parts = {}, complete = false, want = SHARD_ORDER } = {}) =>
  complete ? [] : want.filter(k => !parts[k]);
