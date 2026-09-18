#!/usr/bin/env node
// THE FLEET'S IDENTIFICATION SERVICE — find what is unidentified, and have one caster reveal it.
//
// The fleet farms Upstairs Castle Victoria and comes home with things whose properties nobody
// knows. Two Shal'ille spells answer that, both of them paid for in orc teeth, and the whole
// point of this tool is to spend those teeth only where they buy something.
//
//   identify   level 3   10 mana   15s   1 orc tooth    shows, then HIDES AGAIN
//   reveal     level 5   30 mana   30s   3 orc teeth    permanent, and public
//
// `identify` re-hides what it found the moment it has shown you (identify.kod:99-108:
// RevealHiddenAttributes, SendLook, HideHiddenAttributes). It is a private look, not a change
// to the item. `reveal` does not re-hide (reveal.kod:113-120), so the item stays identified for
// everyone, for ever. "Reveal everything we are bothering to keep" is therefore `reveal`: the
// fleet wants the knowledge ON the item, where a sell, a wield or a vault decision can read it,
// not in one transient look that dies with the packet.
//
// ---------------------------------------------------------------- what makes this cheap
//
// THE SERVER ALREADY SAYS WHICH ITEMS ARE WORTH A CAST, AND NOTHING WAS LISTENING.
//
// Every object on the wire carries a rarity grade, and `GetRarity` (item.kod:714-730) checks
// identification FIRST: anything with a hidden attribute comes back as
// ITEM_RARITY_GRADE_UNIDENTIFIED, 100. It was parsed from the beginning (m59-parse.mjs:245) and
// dropped by both item serializers, so until now the only way to ask "is there anything in this
// item" was to cast at it — 3 teeth a question, with no answer when the answer was no.
//
// That matters because of how advancement works. `reveal` sets `piAdvance` from
// `RevealHiddenAttributes`, which returns TRUE only if something WAS hidden (item.kod:1331-1347),
// and its `ImproveAbility` returns FALSE when piAdvance is falsy (reveal.kod:101-107). So a cast
// at a mundane item spends 3 teeth and 30 mana, reveals nothing, AND teaches the caster nothing.
// Filtering on grade 100 is what turns this from a grind into an errand.
//
// PRACTICE AND SERVICE ARE THE SAME ACT, which is the nice part. The caster can only advance on
// items that really had something hidden — so there is no way to farm the spell on junk, and
// every cast that trains Loial is a cast somebody wanted anyway.
//
// ---------------------------------------------------------------- what makes this awkward
//
// THE ITEM HAS TO BE WITHIN REACH, AND REACH IS NARROW. `IsTargetInRange` (reveal.kod:94-97) is
//
//     who = GetOwner(target)   OR   GetOwner(who) = GetOwner(target)
//
// so the item must be IN THE CASTER'S OWN PACK, or lying on the floor of the room he is standing
// in. An item in another character's pack is not reachable, however close they stand. There are
// therefore exactly two ways to get work to the caster and `plan` reports both: hand it over, or
// drop it on his floor. Dropping is usually better — a caster's pack fills with pork and a full
// pack answers `receiver_full` to every hand-over on WEIGHT, with only a handful of items in it.
//
// A RESTING CASTER CANNOT CAST AND THE REFUSAL IS FREE. PFLAG_NO_MAGIC is set while resting, so
// `run` stands the caster up before every attempt rather than after the first failure.
//
// AND THE CAST REPLY LIES ABOUT WHETHER IT HAPPENED. Measured 2026-09-12 driving Loial: `cast`
// answered `{cast: true, mana_spent: 0}` — "NOTHING was spent, the cast did not happen" — on a
// cast whose mana demonstrably went 65 -> 52. The reply's own before/after read races the
// server. So nothing here believes it: a cast is judged by re-reading the ITEM's rarity grade,
// which is the thing the errand exists to change. Rule 6, on the only field that answers it.
// ---------------------------------------------------------------- where the caster lives
//
// THE CASTER SHUTTLES, AND ONLY ONE DIRECTION IS WALKED — BUT ONLY BECAUSE OF WHERE THIS
// PARTICULAR CASTER HAPPENS TO LIVE.
//
// Reveal needs the caster, the item and the teeth in one place, and they start in three
// different towns. The caster is the one that moves, and moving a 20-max-health body is the
// most dangerous thing this service does: it killed Loial once on 2026-09-12.
//
// What made it cheap for HIM is a fact about him, not a technique. `rescue` is not a general
// way to get closer to somewhere — it is a teleport to ONE fixed destination that the caster
// does not choose. `DoRescue` (rescue.kod:114-167) picks, in order:
//
//   1. the GUILD HALL, and only if the guild has one, you are not in it, and it is in the SAME
//      REGION you are standing in
//   2. the Ko'catan Inn, if you are in the Ko'catan region or at the Pool of Vigor
//   3. the Pool of Vigor, if you are in the orc caves (region 2500, Ugol's Warren — NOT room 27)
//   4. otherwise `AdminGoToSafety`: the character's own HOME ROOM
//
// AND A HOMETOWN IS ASSIGNED AT RANDOM when a character leaves Raza. It is per-character, it
// is visible in that character's `inspect` text, and nothing in this repository sets it. So
// "rescue home and walk the rest" is worth checking PER CASTER and is not advice that
// generalises: Loial's home is Barloque, which happens to sit a short corridor from Tos, and
// another character's could be anywhere at all.
//
// For him, that luck is worth a lot, measured the same day:
//
//   Jasper 370   -> Tos 52   10 hops, 1234s p90    the trip that nearly killed him
//   Barloque 102 -> Tos 52    7 hops,  203s p90    crossed at 20/20 without a scratch
//
// If this fleet ever finishes its guild hall, rule 1 above starts firing and every guilded
// character's rescue destination changes at once — including this one's. Re-measure then
// rather than trusting these numbers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callTool, fleetRoster } from './m59-describe.mjs';
import { ITEM_RARITY, rarityName, isUnidentified } from './m59-items.mjs';
// THE SORTER IS A SEPARATE FILE ON PURPOSE. What an item is FOR is an operator's list that
// changes without redeploying anything; what is UNIDENTIFIED is the server's own grade. Joining
// them here rather than merging them keeps the volatile half editable by a person.
import { sortPack, VERDICTS, routeOf, describeItem, destinationOf } from './m59-magicsort.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const REVEAL = Object.freeze({ spell: 'reveal', mana: 30, teeth: 3, castMs: 30_000 });
export const IDENTIFY = Object.freeze({ spell: 'identify', mana: 10, teeth: 1, castMs: 15_000 });

const TOOTH = /orc (teeth|tooth)/i;

/** How many orc teeth a pack holds. NumberItems carry an amount; a bare object is one. */
export function teethIn(items = []) {
  return items.filter(i => TOOTH.test(String(i.name ?? '')))
              .reduce((n, i) => n + (Number(i.amount) || 1), 0);
}

/**
 * WHAT IN THIS PACK IS WORTH A CAST.
 *
 * Strictly grade 100. Not "has a suggestive name", not "is not on a known-mundane list" — both
 * were considered and both are guesses that cost 3 teeth when wrong. A stack is excluded too:
 * a NumberItem with an amount is money, arrows or food, none of which carries an attribute, and
 * an identified-per-stack model does not exist on the server.
 */
export function revealable(items = []) {
  return (items ?? []).filter(i => isUnidentified(i) && !(Number(i.amount) > 1));
}

/** What one pass would cost and whether the caster can pay for it. */
export function budget(count, teeth, mana, spell = REVEAL) {
  const byTeeth = Math.floor(Number(teeth || 0) / spell.teeth);
  const byMana = Math.floor(Number(mana || 0) / spell.mana);
  // Mana regenerates and teeth do not, so a run is not "blocked" by mana — it is paced by it.
  // Saying so is the difference between an operator buying teeth and an operator waiting.
  const affordable = Math.min(count, byTeeth);
  return {
    wanted: count, affordable, by_teeth: byTeeth, by_mana_now: byMana,
    teeth_needed: count * spell.teeth, teeth_short: Math.max(0, count * spell.teeth - Number(teeth || 0)),
    paced_by: byMana < affordable ? 'mana — it regenerates, so this is a wait, not a shortage'
                                  : (byTeeth < count ? 'orc teeth — buy more (buy-orc-teeth)' : null),
  };
}

// ---------------------------------------------------------------- the live half

const inventoryOf = (agent, opts) => callTool('inventory', { agent }, opts).catch(() => null);

/** Every unidentified item in the fleet, by who is holding it. Read-only. */
export async function sweep(opts = {}) {
  const roster = await fleetRoster(opts);
  const rows = [];
  for (const r of roster) {
    const inv = await inventoryOf(r.agent, opts);
    if (!inv) { rows.push({ ...r, unreadable: true, items: [] }); continue; }
    const items = revealable(inv.items).map(i => ({ id: i.id, name: i.name }));
    if (items.length) rows.push({ ...r, items, teeth: teethIn(inv.items) });
  }
  return rows;
}

/**
 * REVEAL WHAT IS IN THE CASTER'S OWN PACK, ONE AT A TIME, CHECKING EACH.
 *
 * Sequential on purpose. A cast shares the one-per-second timer with attacks, the trance is 30
 * seconds, and two casts in flight at once cannot be told apart afterwards — which would make
 * the per-item verdict below meaningless.
 */
export async function runPass(agent, { spell = REVEAL, max = Infinity, dry = false,
                                       opts = {}, log = () => {} } = {}) {
  const inv = await inventoryOf(agent, opts);
  if (!inv) return { ok: false, why: `cannot read ${agent}'s pack` };

  const work = revealable(inv.items);
  const teeth = teethIn(inv.items);
  const st = await callTool('status', { agent }, opts).catch(() => null);
  const mana = st?.mana?.value ?? st?.vitals?.mana?.value ?? 0;
  const plan = budget(work.length, teeth, mana, spell);
  if (dry || !work.length) return { agent, spell: spell.spell, dry: true, plan, work: work.map(w => w.name) };

  const done = [];
  for (const item of work.slice(0, Math.min(max, plan.affordable))) {
    // Stand FIRST, every time. Resting sets PFLAG_NO_MAGIC and the refusal is silent and free,
    // so this costs nothing and removes the commonest reason a cast does nothing at all.
    await callTool('rest', { agent, stand: true }, opts).catch(() => null);
    await callTool('cast', { agent, spell: spell.spell, target: item.id }, opts).catch(() => null);

    // JUDGE IT ON THE ITEM, NOT ON THE REPLY. The grade is what the errand exists to change,
    // and it is the one field that cannot be faked by a racing before/after read.
    let graded = null;
    const until = Date.now() + spell.castMs + 20_000;
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, 2000));
      const now = await inventoryOf(agent, opts);
      const row = (now?.items ?? []).find(i => i.id === item.id);
      // Gone from the pack is not a failure we can diagnose here; say so rather than loop.
      if (!row) { graded = { gone: true }; break; }
      if (!isUnidentified(row)) { graded = { rarity: row.rarity, name: row.name }; break; }
    }
    const ok = !!graded && !graded.gone;
    done.push({ id: item.id, name: item.name, ok,
                now: ok ? (rarityName(graded.rarity) ?? graded.rarity) : null,
                why: graded?.gone ? 'left the pack mid-cast'
                   : ok ? null : 'still reads unidentified after the trance' });
    log(`${ok ? 'revealed' : 'FAILED  '}  ${item.name}${ok ? ` -> ${done.at(-1).now}` : ''}`);
  }
  return { agent, spell: spell.spell, plan, done,
           revealed: done.filter(d => d.ok).length, failed: done.filter(d => !d.ok).length };
}


// ---------------------------------------------------------------- the desk

// WHAT HAPPENS TO AN ITEM AFTER THE TRANCE, which is the half this tool did not have.
//
// `runPass` above changes an item's grade and stops there. That was enough while revealing was a
// curiosity and is not enough now that it is a SERVICE: the operator's ask on 2026-09-17 is that
// the fleet hands its unidentified loot to one caster in Barloque, and that a `keep` comes back
// to whoever found it while the rest stays on the mule. Revealing without routing just moves the
// backlog one pack to the left.
//
// So the desk is `m59-magicsort.mjs` joined to this service at the one point where both facts
// exist at once: immediately after a cast, when the item is identified AND still in reach.
//
// THE LEDGER KEYS ON NAMES, NOT IDS, AND THAT IS NOT LAZINESS. An intake note has to survive
// longer than the errand — a \`keep\` goes home when its owner next stands here, which may be
// tomorrow — and an object id does not live that long. Ids are renumbered by every system save
// and 23% of them named a different object within three days (CLAUDE.md). A ledger keyed on one
// would silently start naming somebody else's property, which is worse than losing the note. The
// id is still recorded, as a corroborating hint for a lookup happening in the same session, and
// is never the thing matched on.
//
// TWO CHARACTERS CAN HAND IN THE SAME NAME, so a name is not a key either — it is a QUEUE. The
// rule is first in, first out per name, and `ownerOf` says how many others are waiting behind
// the row it returned. A desk that quietly picked one of three claimants would be inventing an
// answer; one that says "Gonzo, and two more short swords are queued" lets a person settle it.
export const DESK_VERSION = 1;
export const DESK_FILE = process.env.M59_REVEAL_DESK
  || path.join(REPO, 'substrate', 'reveal-desk.json');

/** The intake book, or an empty one. A missing file is a desk nobody has used yet. */
export function loadDesk({ file = null } = {}) {
  const f = file || DESK_FILE;
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { version: raw.version ?? DESK_VERSION, intake: Array.isArray(raw.intake) ? raw.intake : [],
             source: f };
  } catch (e) {
    // A FILE THAT WILL NOT PARSE IS NOT AN EMPTY FILE, and this repository has paid for that
    // confusion elsewhere (docs/m59-policy.md). Say which it was.
    if (e.code === 'ENOENT') return { version: DESK_VERSION, intake: [], source: null };
    return { version: DESK_VERSION, intake: [], source: f, unreadable: String(e.message) };
  }
}

export function saveDesk(desk, { file = null } = {}) {
  const f = file || DESK_FILE;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ version: DESK_VERSION, intake: desk.intake ?? [] }, null, 1));
  return f;
}

/**
 * RECORD THAT SOMEBODY HANDED SOMETHING IN. Pure — it returns a new book and writes nothing.
 *
 * `from` is a CHARACTER NAME rather than an agent slot, because the note outlives the slot
 * assignment and a person reading the book later needs the name they would say out loud.
 */
export function noteIntake(desk, { from = null, items = [], at = Date.now() } = {}) {
  const intake = [...(desk.intake ?? [])];
  for (const it of items) {
    const name = String(it?.name ?? '').trim();
    if (!name || !from) continue;              // an unattributable note is worse than none
    intake.push({ from: String(from), name, id_when_seen: it?.id ?? null, at, returned: false });
  }
  return { ...desk, intake };
}

/**
 * WHO HANDED THIS IN — the oldest unreturned claim on this name, and how many are behind it.
 * Null when nobody did, which is the normal case for something the caster found himself.
 */
export function ownerOf(desk, { name = '', id = null } = {}) {
  const key = String(name ?? '').toLowerCase().trim();
  if (!key) return null;
  const queue = (desk.intake ?? [])
    .filter(r => !r.returned && String(r.name ?? '').toLowerCase().trim() === key)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  if (!queue.length) return null;
  // The id corroborates within one session and decides nothing: a match promotes that row,
  // a mismatch is not evidence of anything because ids are reissued.
  const exact = id != null ? queue.find(r => r.id_when_seen != null && Number(r.id_when_seen) === Number(id)) : null;
  const row = exact ?? queue[0];
  return { ...row, queued_behind: queue.length - 1, matched_by: exact ? 'id and name' : 'name, oldest first' };
}

/** Mark the oldest unreturned claim on this name as settled. Pure. */
export function markReturned(desk, { name = '', id = null } = {}) {
  const row = ownerOf(desk, { name, id });
  if (!row) return desk;
  let done = false;
  const intake = (desk.intake ?? []).map(r => {
    if (done || r.returned) return r;
    if (r.at !== row.at || r.from !== row.from || r.name !== row.name) return r;
    done = true;
    return { ...r, returned: true, returned_at: Date.now() };
  });
  return { ...desk, intake };
}

/**
 * READ THE LOOK TEXT FOR EVERY ITEM THAT COULD CARRY ONE.
 *
 * WITHOUT THIS THE DESK ANSWERS `unknown` FOR EVERYTHING, and that is not a stubbed verdict —
 * it is the honest one. `classify` decides on the NAME and the LOOK, an item's attributes live
 * only in its description, and `inventory` does not carry it. Measured on Loial's real pack
 * 2026-09-17: six items, six `unknown`, every one of them "the look text could not be read".
 *
 * It is opt-in because it costs one round trip per item and `look_at` is the call this
 * repository trusts least: two in nine answered with the PREVIOUS call's object carrying its own
 * wrong id. `describeItem` is the guarded read — it re-checks the id it got back and refuses a
 * description that belongs to another item rather than returning it.
 */
export async function readLooks(agent, items = [], { call = callTool, log = () => {} } = {}) {
  const out = [];
  for (const it of items) {
    if (it.id == null) { out.push(it); continue; }
    const d = await describeItem(agent, it.id, { call }).catch(() => null);
    if (!d) log(`  could not read ${it.name} — left unknown rather than guessed`);
    out.push({ ...it, look: d?.text ?? null });
  }
  return out;
}

/**
 * WHAT THE DESK SHOULD DO WITH WHAT IS IN FRONT OF IT.
 *
 * Pure, and it deliberately answers for EVERY item rather than only the revealed ones: an item
 * still reading unidentified is work the desk has not finished, and leaving it out of the plan
 * is how a backlog becomes invisible. `stage` is the one word that says which it is.
 */
export function deskPlan(items = [], { desk = { intake: [] }, list = null, mule = null } = {}) {
  // A STACK IS NOT A MAGIC ITEM, AND THE TEST IS THE TAG.
  //
  // Measured against Loial's real pack 2026-09-17: the first version of this sorted his 16,876
  // shillings, 108 elderberries and 21 orc teeth as `unknown` — and `unknown` routes to the
  // MULE, so a driver reading that plan would have set out to move the fleet's money and
  // reagents to Barloque. Thirteen rows, five of them the pack's own supplies.
  //
  // `amount > 1` is the WRONG test and this repository already says so in two places
  // (CLAUDE.md: "`stack` is tested on the TAG rather than on the number"; the hand-over that
  // moves nothing). His sapphire is a stack of ONE — amount 1, tag 1 — so an amount test lets
  // it through, and a stack of one is exactly what a pack looks like after it spends the rest.
  // `revealable` above gets away with the amount test only because it filters on grade 100
  // first and no NumberItem is ever unidentified; here there is no grade filter to hide behind.
  //
  // The tag is absent from older keeper snapshots, so the amount is kept as a fallback rather
  // than a primary: an unknown tag with a plain amount is still plainly a stack.
  const isStack = (i) => (i?.tag != null ? Number(i.tag) === 1 : (Number(i?.amount) || 0) > 1);
  const setAside = items.filter(isStack);
  const sortable = items.filter(i => !isStack(i));
  const sorted = sortPack(sortable.map(i => ({ id: i.id, name: i.name, look: i.look ?? null,
                                               rarity: i.rarity ?? null })), list);
  const rows = [];
  for (const v of VERDICTS) {
    for (const r of sorted[v]) {
      const src = sortable.find(i => Number(i.id) === Number(r.id)) ?? {};
      const stage = isUnidentified(src) ? 'awaiting_reveal' : 'revealed';
      const owner = ownerOf(desk, { name: r.name, id: r.id });
      // WHO HOLDS IT, WHERE THEY PUT IT, AND WHO GETS PAID — three answers, and the routing
      // table owns all three. Deriving them from the `to` string here would be a second opinion
      // about a question m59-magicsort.mjs has already answered.
      const dest = destinationOf(r.route);
      const proceeds = routeOf(r.verdict).proceeds_to;

      // `keep` GOES HOME, AND HOME MAY BE HERE. When the caster found it himself there is no
      // owner to send it to, and naming a journey to where the item already is would have a
      // reader planning a hand-over that is a no-op. Say `stays` instead.
      const mine = dest?.who === 'owner';
      const who = mine ? (owner ? owner.from : null) : (mule ?? 'the mule');
      const to = mine
        ? (owner ? `${owner.from}'s ${dest.store}` : `${mule ?? 'the finder'}'s ${dest.store}`)
        : dest?.town ? `a counter in ${dest.town}` : (mule ?? 'the mule');

      rows.push({ id: r.id, name: r.name, stage, verdict: r.verdict, why: r.why,
                  route: r.route, to, store: dest?.store ?? null,
                  owner: owner ? owner.from : null,
                  // THE MONEY IS A SEPARATE ROW FROM THE ITEM. A timed attribute is sold at the
                  // Barloque counter beside the desk and the shillings are the FINDER'S — the
                  // operator's rule, and the one the plain `to` column cannot express.
                  proceeds_to: proceeds === 'owner' ? (owner ? owner.from : null) : proceeds,
                  owes_proceeds: proceeds === 'owner' && !!owner,
                  queued_behind: owner?.queued_behind ?? 0,
                  stays: mine ? !owner : dest?.store !== 'sold' });
    }
  }
  // Worst first is not meaningful here; group by what a person would act on.
  const order = { awaiting_reveal: 0, revealed: 1 };
  return { rows: rows.sort((a, b) => (order[a.stage] - order[b.stage]) || a.name.localeCompare(b.name)),
           source: sorted.source,
           // REPORTED, NEVER SILENTLY DROPPED. "Sorted 8 of 13, set 5 aside as stacks" is a
           // sentence somebody can check; a plan that quietly lost five rows is not.
           set_aside: setAside.map(i => ({ id: i.id, name: i.name, amount: i.amount ?? null })),
           counts: VERDICTS.reduce((o, v) => ({ ...o, [v]: sorted[v].length }), {}) };
}

// ---------------------------------------------------------------- cli

const isMain = !!process.argv[1] &&
  import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;

if (isMain) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'sweep';
  const flag = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
  const has = f => argv.includes(f);
  const spell = has('--identify') ? IDENTIFY : REVEAL;

  if (cmd === 'sweep') {
    const rows = await sweep();
    if (!rows.length) { console.log('nothing in the fleet reads unidentified.'); process.exit(0); }
    let total = 0;
    for (const r of rows) {
      if (r.unreadable) { console.log(`${r.agent.padEnd(5)} ${String(r.character).padEnd(12)} (pack unreadable)`); continue; }
      total += r.items.length;
      console.log(`${r.agent.padEnd(5)} ${String(r.character).padEnd(12)} room ${String(r.room).padEnd(5)} ` +
                  `teeth ${String(r.teeth).padEnd(4)} ${r.items.map(i => i.name).join(', ')}`);
    }
    console.log(`\n${total} unidentified item(s). ` +
                `reveal: ${total * REVEAL.teeth} orc teeth. identify: ${total * IDENTIFY.teeth}.`);
    console.log('An item is only reachable in the CASTER\'S OWN pack or on his floor — hand it ' +
                'over, or drop it in his room. `m59-reveal.mjs run --agent <caster>` does the rest.');
  } else if (cmd === 'run') {
    const agent = flag('--agent', 'hk1');
    const out = await runPass(agent, { spell, dry: has('--dry'),
                                       max: Number(flag('--max', Infinity)),
                                       log: s => console.log('  ' + s) });
    console.log(JSON.stringify(out, null, 1));
  } else if (cmd === 'status') {
    const agent = flag('--agent', 'hk1');
    const inv = await inventoryOf(agent);
    const st = await callTool('status', { agent }).catch(() => null);
    const work = revealable(inv?.items ?? []);
    const teeth = teethIn(inv?.items ?? []);
    const mana = st?.mana?.value ?? st?.vitals?.mana?.value ?? 0;
    console.log(`${agent} ${st?.character ?? ''} in ${st?.room?.name ?? '?'} — ` +
                `${teeth} orc teeth, ${mana} mana`);
    console.log(`in reach right now: ${work.length} unidentified item(s)` +
                (work.length ? ': ' + work.map(w => w.name).join(', ') : ''));
    console.log(JSON.stringify(budget(work.length, teeth, mana, spell), null, 1));
  } else if (cmd === 'desk') {
    // THE SERVICE DESK: what is in front of the caster, and where each of it goes.
    // Read-only. Nothing here casts, hands over or sells — it says what the pass would do, and
    // an operator who disagrees edits the list rather than this file.
    const agent = flag('--agent', 'hk1');
    const inv = await inventoryOf(agent);
    const st = await callTool('status', { agent }).catch(() => null);
    const me = st?.character ?? null;
    const desk = loadDesk();
    // --look reads each item's description first. Without it every verdict below is `unknown`,
    // because the attributes a verdict turns on are only ever in the look text.
    let packItems = inv?.items ?? [];
    if (has('--look')) {
      const isStack = (i) => (i?.tag != null ? Number(i.tag) === 1 : (Number(i?.amount) || 0) > 1);
      const worth = packItems.filter(i => !isStack(i));
      console.log(`reading ${worth.length} description(s)...`);
      const read = await readLooks(agent, worth, { log: s => console.log(s) });
      const byId = new Map(read.map(i => [Number(i.id), i]));
      packItems = packItems.map(i => byId.get(Number(i.id)) ?? i);
    }
    if (desk.unreadable) console.log(`! the intake book at ${desk.source} will not parse: ${desk.unreadable}\n`
      + '  Treating it as empty would silently forget who owns what, so nothing is matched below.\n');
    const plan = deskPlan(packItems, { desk, mule: me });
    if (has('--json')) { console.log(JSON.stringify({ agent, character: me, ...plan }, null, 1)); }
    else {
      // `loadList().source` is an OBJECT — {path, exists, note} — and printing it straight
      // gave "verdicts from [object Object]" on the first live run. Which list is in force is
      // the single most useful line here, because every verdict below is downstream of it.
      const src = plan.source;
      console.log(`${agent} ${me ?? ''} at ${st?.room?.name ?? '?'}`);
      console.log(`verdicts from: ${src?.exists ? src.path : (src?.note ?? String(src ?? 'the built-in default'))}`);
      console.log(`intake book: ${desk.source ?? '(none yet — nobody has handed anything in)'}`
        + `, ${(desk.intake ?? []).filter(r => !r.returned).length} unreturned claim(s)\n`);
      if (!plan.rows.length) console.log('  nothing in the pack to sort.');
      for (const r of plan.rows) {
        const where = r.stays ? 'stays here' : `-> ${r.to}`;
        const owed = r.owes_proceeds ? `  [shillings -> ${r.proceeds_to}]` : '';
        console.log(`  ${String(r.stage === 'awaiting_reveal' ? 'UNREVEALED' : 'revealed').padEnd(11)}`
          + ` ${String(r.name).padEnd(24)} ${String(r.verdict).padEnd(16)} ${where}${owed}`
          + (r.queued_behind ? `  (${r.queued_behind} more of this name queued)` : ''));
      }
      const waiting = plan.rows.filter(r => r.stage === 'awaiting_reveal').length;
      console.log(`\n${plan.rows.length} item(s): ${waiting} awaiting a reveal, `
        + `${plan.rows.length - waiting} sorted.`);
      // SAY WHAT WAS SET ASIDE. Silently dropping the pack's own money and reagents would make
      // the plan look complete when it had ignored most of the pack.
      if (plan.set_aside.length)
        console.log(`${plan.set_aside.length} stack(s) set aside — money, reagents, arrows and `
          + `food carry no attribute: ${plan.set_aside.map(i => i.name).join(', ')}`);
      if (waiting) console.log(`\`m59-reveal.mjs run --agent ${agent}\` casts on the unrevealed ones.`);
    }
  } else if (cmd === 'intake') {
    // RECORD A HAND-OVER. The desk cannot see who gave it something — a pack is a list of
    // objects and carries no provenance — so the hand-over has to say so, and this is where.
    const from = flag('--from', null);
    const names = (flag('--items', '') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!from || !names.length) {
      console.log('intake --from "<character name>" --items "short sword,leather armor"');
      process.exit(2);
    }
    const before = loadDesk();
    const after = noteIntake(before, { from, items: names.map(n => ({ name: n })) });
    const f = saveDesk(after);
    console.log(`noted ${names.length} item(s) from ${from} -> ${f}`);
    console.log('Matched by NAME, oldest first, when the item is later sorted — an object id '
      + 'does not survive a system save, so it is recorded as a hint and never matched on.');
  } else {
    console.log(`m59-reveal.mjs — the fleet's identification service

  sweep                      every unidentified item in the fleet and who holds it
  status  --agent <a>        one caster: teeth, mana, and what is in reach
  run     --agent <a>        reveal everything unidentified in that caster's pack
          --dry              plan only
          --max <n>          stop after n
          --identify         use identify (1 tooth, transient) instead of reveal (3, permanent)
  desk    --agent <a>        what is in front of the caster and WHERE EACH PIECE GOES
          --look             read each description first — WITHOUT IT EVERY VERDICT IS \`unknown\`
          --json             the same, for a driver
  intake  --from <who> --items <a,b>   record a hand-over, so a \`keep\` can find its way home

\`desk\` is \`run\` re-read through m59-magicsort.mjs: reveal changes an item's GRADE, the sorter
decides what it is FOR, and the two only coincide while the item is still in reach. \`keep\` goes
back to whoever handed it in, which is what \`intake\` is for — a pack carries no provenance.

Teeth come from buy-orc-teeth (say "orc teeth" to Paddock in 52 — his shelf does not list
them until you ask). Grade 100 is the whole filter; see the header for why.`);
  }
}
