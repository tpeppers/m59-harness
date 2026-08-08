#!/usr/bin/env node
// GO BACK AND PICK UP WHAT WE DROPPED.
//
//   node tools/m59-reclaim.mjs --dry-run      the sites, newest first, and who would go
//   node tools/m59-reclaim.mjs                do it, newest first, until sites stop paying
//   node tools/m59-reclaim.mjs --sites 12     how many death sites to try, default 10
//   node tools/m59-reclaim.mjs --dry-empties 3  give up after this many empty in a row
//
// WHY THIS IS THE MOST VALUABLE ERRAND IN THE REPOSITORY.
//
// Dying drops the character's ENTIRE inventory on the floor. bankSurplus already notes
// what that cost once: "twenty-three deaths, and an audit afterwards found nineteen of
// twenty-five characters wearing nothing and most carrying no money at all — everything
// they had earned was lying on corpses across the world." The answer taken at the time was
// to bank MONEY so a death stops costing everything. Items were never addressed.
//
// This fleet has now died 341 times. Nothing has ever gone back for a single pack. That
// one fact explains what were reported as four separate mysteries: no spare weapons
// anywhere, characters holding 0sh, elderberry falling 646 -> 28 while hunting the best
// droppers in the game, and loot runs returning "picked up nothing" — because loot_run is
// a courier between LIVING characters and has no concept of a corpse.
//
// TWO THINGS ABOUT M59 CORPSES, both from the operator standing in front of one:
//
//   * the corpse decays but THE ITEMS REMAIN ON THE GROUND. So an old death site is not
//     worthless — the drop outlives the body. I had assumed the opposite and would have
//     thrown away every site older than a few minutes.
//   * anyone can take them. Meridian's history includes players looting corpses to ransom
//     the gear back to its owner. So this is a RACE, not an archive: every hour a pile
//     sits there is an hour somebody else may walk off with it.
//
// They do not persist for ever, so this works NEWEST FIRST and stops when sites stop
// paying — that boundary is where the world has already swept up, and there is no value
// in walking further back past it.
//
// WHO GOES. Not everyone. The last errand that sent nineteen low-vigor characters walking
// across the map cost twenty-nine deaths in one pass, twenty-seven of them while
// travelling, killed by baby spiders and giant rats. A character that cannot survive the
// walk must not be sent on it — and the fleet's own dead are proof of what the walk costs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const PORT = Number(arg('port', 8901));
const RPC = `http://127.0.0.1:${PORT}/`;
const DRY = !!arg('dry-run', false);
const SITES = Number(arg('sites', 10));
const STOP_AFTER_EMPTY = Number(arg('dry-empties', 3));
// A courier has to be able to survive the trip. These are the floors the death record
// argues for: armed, near-whole, and not pinned at the resting cap.
const MIN_HEALTH_PCT = Number(arg('min-health', 0.8));
const MIN_VIGOR = Number(arg('min-vigor', 100));
// A pack worth walking back for when nothing notable is named in it.
// What a dropped pile has to be worth before anyone walks back for it, in shillings at
// viValue_average. 1000 is roughly a mace and a handful of gems — enough that the trip
// pays for itself even if it costs a rest, and far above the four-mushroom piles that had
// couriers crossing the Badlands for nothing.
const MIN_VALUE = Number(arg('min-value', 1000));

let id = 0;
async function call(name, args = {}, ms = 120_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
                             params: { name, arguments: args } }),
    });
    const j = await r.json();
    const text = j.result?.content?.[0]?.text;
    if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
    if (j.result?.isError) throw new Error(`${name}: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
  } finally { clearTimeout(t); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// NOBODY IS LEFT INERT, INCLUDING THROUGH A KILL. A finally does not run through a hard
// kill — this repository has now learned that twice, once when outfitPair's timeout
// stranded characters in Marion and once when my own `timeout 520` stranded Fozzie.
const madeInert = new Set();
async function reviveAll(why) {
  for (const agent of [...madeInert]) {
    try { await call('autopilot', { agent, action: 'revive', why }, 30_000); madeInert.delete(agent); }
    catch { /* try the rest regardless */ }
  }
}
let bailing = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, async () => {
    if (bailing) return; bailing = true;
    console.log(`\n${sig} — reviving ${madeInert.size} keeper(s) before exit`);
    await reviveAll(`reclaim interrupted by ${sig}`);
    process.exit(130);
  });
}
process.on('uncaughtException', async (e) => {
  console.error('uncaught: ' + e.message);
  await reviveAll('reclaim threw'); process.exit(1);
});

const pctOf = (s) => { const m = /^(\d+)\/(\d+)/.exec(String(s || '')); return m ? +m[1] / +m[2] : 0; };

// Anything worth the walk. Deliberately broad: the whole point is that this is OUR gear,
// already the right level for whoever lost it, and the fleet is short of every category.
const WORTH_TAKING = new RegExp([
  'shilling', 'elder', 'herb',                                   // money and the recipe
  'mace', 'sword', 'axe', 'hammer', 'bow',                       // weapons
  'armor', 'armour', 'shield', 'helm',                           // what to wear
  'emerald', 'sapphire', 'ruby', 'diamond',                      // sells for real money
  'flask', 'potion', 'ring',
  'mushroom', 'apple', 'bread', 'pie', 'cheese',                 // food and sellable junk
].join('|'), 'i');

async function reclaim(site, courier) {
  const who = courier.character || courier.agent;
  const where = async () => {
    const st = await call('status', { agent: courier.agent, brief: true }, 60_000).catch(() => null);
    return st?.where?.num ?? st?.room?.id ?? null;
  };
  await call('autopilot', { agent: courier.agent, action: 'inert',
                            why: `reclaiming ${site.character}'s drop in room ${site.room_num}` })
              .catch(() => {});
  madeInert.add(courier.agent);
  try {
    // Travel is resumable and a failed hop is normal — judge on whether the room CHANGED.
    let at = await where(), stuck = 0;
    for (let i = 0; i < 8 && at !== site.room_num && stuck < 2; i++) {
      await call('travel', { agent: courier.agent, to: site.room_num, max_hops: 20 }).catch(() => ({}));
      const now = await where();
      if (now === site.room_num) { at = now; break; }
      if (now === at) stuck++; else { stuck = 0; at = now; }
      await sleep(1200);
    }
    if (at !== site.room_num) return { ok: false, why: `could not reach room ${site.room_num}` };

    // Walk onto the square it fell on. The drop is where the body was, and a room can be
    // sixty squares across — being in the room is not being on the pile.
    if (site.at_col != null)
      await call('walk_to', { agent: courier.agent, col: site.at_col, row: site.at_row }, 90_000)
                .catch(() => {});

    const look = await call('look', { agent: courier.agent }, 60_000).catch(() => ({ objects: [] }));
    const onFloor = (look.objects || []).filter(o => (o.can || []).includes('get'));
    const wanted = onFloor.filter(o => WORTH_TAKING.test(String(o.name || '')));
    if (!wanted.length) return { ok: true, took: [], why: 'nothing on the floor here' };

    const took = [];
    for (const o of wanted.slice(0, 14)) {
      const g = await call('loot', { agent: courier.agent, ids: [o.id] }, 60_000)
                      .catch(() => null);
      if (g && !g.raw) took.push(o.name);
      await sleep(400);
    }
    // GET OUT WITH IT. A courier standing on a death site is standing where somebody just
    // died, holding more than it arrived with. Going straight back to hunting from there
    // is how the recovered pack becomes the next drop — and twenty-nine of the last sixty
    // deaths were characters STALLED in exactly these rooms rather than fighting in them.
    //
    // So retreat to the nearest room nothing huntable spawns in before the keeper resumes.
    // travel picks the route; sanctuary is what makes the destination worth reaching.
    if (took.length) {
      const safe = await call('hunting_grounds', { agent: courier.agent, creature: 'inn' }, 60_000)
                         .catch(() => null);
      // Prefer the character's own home room — it is an inn by construction and the
      // routes to it are the ones this character has already walked.
      const home = courier.home_room ?? courier.assigned_room ?? null;
      const dest = home ?? (safe?.rooms || [])[0]?.room_num ?? null;
      if (dest != null) {
        const r = await call('travel', { agent: courier.agent, to: dest, max_hops: 20 }, 180_000)
                        .catch(() => ({ arrived: false }));
        return { ok: true, took, retreated: !!r?.arrived, to: dest };
      }
    }
    return { ok: true, took };
  } finally {
    const ok = await call('autopilot', { agent: courier.agent, action: 'revive',
                                         why: 'reclaim finished' })
                     .then(() => true).catch(() => false);
    if (ok) madeInert.delete(courier.agent);
    else console.log(`  ${who}: COULD NOT REVIVE ITS KEEPER after the reclaim`);
  }
}

// ---------------------------------------------------------------- main

// THE COORDINATES ARE IN THE FILES, NOT IN THE LIST.
//
// post_mortem's listing carries character, time, room NAME, what it was doing and what
// killed it — but not room_num, at_col or at_row. Those live in each death's own file
// under substrate/postmortems/, in its `summary`. Filtering the listing on room_num
// therefore removed every single row and printed "no death sites on record" about a fleet
// with 341 of them: an empty result from a field that is not there, which is the exact
// failure m59-lore was written to refuse. Read the files.
const { readdirSync } = await import('node:fs');
const PM_DIR = fileURLToPath(new URL('../substrate/postmortems/', import.meta.url));
const deaths = readdirSync(PM_DIR).filter(f => f.endsWith('.json')).map(f => {
  try {
    const j = JSON.parse(readFileSync(PM_DIR + f, 'utf8'));
    const s = j.summary ?? {};
    return { character: j.character, at: j.at,
             room_num: s.room_num ?? j.where?.num ?? null,
             at_col: s.at_col ?? j.where?.col ?? null,
             at_row: s.at_row ?? j.where?.row ?? null,
             died_in: s.died_in ?? j.where?.room ?? '',
             carrying: s.carrying ?? null };
  } catch { return null; }
}).filter(d => d && d.room_num != null)
  // ONLY GO BACK FOR A PACK WORTH THE WALK.
  //
  // Every site used to qualify, so couriers walked to all of them — including the ones
  // that held nothing. Of sixty recent deaths, twenty were at the border of the Badlands
  // and eighteen at the Tos gate, the two rooms this file's own supervisor excludes by
  // name, and only four of the sixty died fighting. Sending recovery trips into those
  // rooms for an unknown payoff is how a recovery errand starts costing more than it
  // returns.
  //
  // `carrying` is recorded at death now: stack count and the notable kinds. A site with
  // no record is SKIPPED rather than guessed at — an unknown payoff does not justify a
  // walk through ground that kills, and skipping costs only the drops from deaths that
  // predate the recording.
  // SIGNIFICANT MEANS A NUMBER, AND THE NUMBER IS SELL VALUE.
  //
  // A stack count cannot tell four mushrooms from four swords. viValue_average is declared
  // per item class in the kod — mushroom 10, emerald 30, mace 50, sapphire 60, and a
  // riijasword 5000 — so a dropped pile has an actual worth and the walk can be judged
  // against it rather than against how many things happened to be in the pack.
  //
  // Shillings count at face. Anything the value table does not know counts as zero, which
  // means an unrecognised pile reads as not-worth-the-walk — the safe direction to fail
  // in, given a trip to the border of the Badlands is what the last unfiltered version
  // was buying with those lives.
  .filter(d => d.carrying && (d.carrying.value ?? 0) >= MIN_VALUE)
  .sort((a, b) => String(b.at).localeCompare(String(a.at)));      // NEWEST FIRST
if (!deaths.length) { console.error('no death sites on record'); process.exit(1); }

const f = await call('fleet', {}, 120_000).catch(() => null);
const fleet = (f?.fleet || []).filter(r => r.character && r.room_num != null);
const couriers = fleet.filter(r => r.has_weapon
  && pctOf(r.health) >= MIN_HEALTH_PCT && Number(r.vigor || 0) >= MIN_VIGOR);

console.log(`${deaths.length} recorded death sites; trying the newest ${SITES}` +
            `${DRY ? ' (dry run)' : ''}`);
console.log(`couriers fit to travel (armed, >=${Math.round(MIN_HEALTH_PCT * 100)}% health, ` +
            `>=${MIN_VIGOR} vigor): ${couriers.length ? couriers.map(c => c.character).join(', ') : 'NONE'}`);
if (!couriers.length && !DRY) {
  console.log('nobody can safely make the trip — not sending anyone. The last errand that ');
  console.log('ignored this cost 29 deaths in one pass, 27 of them while travelling.');
  process.exit(0);
}

let empties = 0, recovered = 0;
for (const site of deaths.slice(0, SITES)) {
  if (empties >= STOP_AFTER_EMPTY) {
    console.log(`\n${empties} sites in a row had nothing — the world has swept up past here, stopping.`);
    break;
  }
  if (DRY) {
    console.log(`  ${String(site.at).slice(0, 19)}  ${String(site.character).padEnd(9)} ` +
                `room ${String(site.room_num).padStart(5)} (${site.at_col},${site.at_row})  ${site.died_in}`);
    continue;
  }
  // Nearest fit courier by route.
  let best = null;
  for (const c of couriers) {
    if (c.room_num === site.room_num) { best = { c, hops: 0 }; break; }
    const m = await call('map', { agent: c.agent, to: site.room_num }, 60_000).catch(() => null);
    if (m?.route?.found && (!best || m.route.hops.length < best.hops))
      best = { c, hops: m.route.hops.length };
  }
  if (!best) { console.log(`  ${site.character}'s site (room ${site.room_num}): nobody can route there`); continue; }
  const r = await reclaim(site, best.c).catch(e => ({ ok: false, why: e.message }));
  if (!r.ok) { console.log(`  ${site.character}'s site: ${r.why}`); continue; }
  if (r.took.length) {
    empties = 0; recovered += r.took.length;
    console.log(`  ${best.c.character} recovered from ${site.character}'s site (room ${site.room_num}): ${r.took.join(', ')}`);
  } else {
    empties++;
    console.log(`  ${site.character}'s site (room ${site.room_num}): empty (${empties} in a row)`);
  }
}

await reviveAll('reclaim finished');
if (madeInert.size) console.log(`WARNING: ${madeInert.size} keeper(s) still inert`);
if (!DRY) console.log(`\nrecovered ${recovered} item stack(s)`);
