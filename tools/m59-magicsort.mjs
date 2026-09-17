#!/usr/bin/env node
// WHAT A REVEALED ITEM IS FOR — four answers, and an operator-curated list that decides.
//
//   node tools/m59-magicsort.mjs              the list in force, and where it came from
//   node tools/m59-magicsort.mjs --explain     the same, with the argument for each entry
//   node tools/m59-magicsort.mjs --sweep       every revealed item in the fleet, sorted
//
// Offline unless you pass --sweep. Pure, so the decision can be pinned by a test rather than
// discovered by selling somebody's sword.
//
// ---------------------------------------------------------------- the four piles
//
//   keep             back to the character it came from: it is worth more in use than sold
//   sell_to_players  worth more than a counter will pay. HELD, tagged, and taken to the
//                    menagerie merchant, who sells to real people on a shared server
//   sell_to_npc      a TIMED attribute. Worth money today and nothing tomorrow, so it goes to
//                    the smith on this same trip rather than being parked anywhere
//   unknown          nobody could read it. Not the same answer as any of the above
//
// Operator, 2026-09-17: "the selling I'm talking about is a sell-to-players list... we should
// have the concept of tagging items as sell_to_players", and timed-duration items are a
// separate category from that. So the split is by WHO BUYS IT, not by whether we want it.
//
// THE TIMER IS WHAT SEPARATES THE TWO SALES. Exactly one attribute in this game is permanent:
// `ItemAttTranscendant` (iatransc.kod), the "soft, white light" one. Shrouded, enchanted,
// glowing, holy, unholy, fiery, icy, shock and acid all run a 1-24h timer and IT KEEPS RUNNING
// IN THE VAULT — which is why a timed item cannot be held for a player sale or parked for later:
// whatever a person would have paid for it decays while it waits. An NPC pays less and pays now.
//
// ---------------------------------------------------------------- why a list and not a rule
//
// Two automatic rules were on the table and the operator picked neither. "Keep the permanent
// attributes" reads the mechanics correctly and has nothing to say about a mundane-looking item
// that happens to be wanted; "keep it if it beats what the owner has" needs a gear comparison
// that goes stale the moment anybody loots anything. A named list is predictable, is changed
// without a code edit, and — the part that matters — is WRONG VISIBLY. A rule that mis-sorts
// looks like a policy; a list that mis-sorts looks like a missing line.
//
// So the list is ORDERS, and orders live on the machine that owns the roster
// (`substrate/magic-keep.json`, gitignored, with `magic-keep.example.json` beside it). The
// default below ships in git because a fresh clone has to sort SOMETHING, and its entries are
// facts this repository has measured rather than a taste in loot.
//
// ---------------------------------------------------------------- a tag is not stored state
//
// "Tagging items as sell_to_players" is a verdict RECOMPUTED on demand, never a flag written
// against an object id. Ids are renumbered by every system save and 23% of stored ids named a
// different object within three days — a stored tag would eventually sell somebody else's
// property and read as success. `reveal` un-hides the attributes permanently
// (reveal.kod:113-120), so the evidence travels on the item itself and the verdict is a pure
// function of what can be read off it. `overrides` is the one exception and is keyed by NAME
// plus the text that must appear with it, never by id.
//
// ---------------------------------------------------------------- the fourth verdict
//
// `unknown` IS NOT A SALE, AND THAT IS THE WHOLE DESIGN. An item whose look text nobody could
// read is not an item with nothing on it. Every expensive mistake in this repository is an
// absence read as a value — a null rarity printed as `normal`, an absent ledger read as a quiet
// fleet, `Boolean({ok:false})` read as a pass — and this one is irreversible in the direction
// that matters: a sold keeper cannot be got back, while an unsorted item merely sits in a pack
// until somebody looks again. So an unreadable item stays where it is and is COUNTED.
//
// ---------------------------------------------------------------- reading the attribute
//
// Attributes live in the LOOK TEXT, not the name. Two traps in getting it, both in CLAUDE.md
// and both already paid for:
//
//   * `look_at` sometimes answers with the PREVIOUS call's object carrying its own wrong id —
//     measured two calls in nine. `describeItem` re-checks the id and answers null rather than
//     the wrong item's text.
//   * the name can ALSO gain the attribute, so both are matched. Deliberate redundancy rather
//     than duplication: the name is cheap and always present, the look text is complete.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (p) => join(fileURLToPath(new URL('.', import.meta.url)), p);

export const VERDICTS = Object.freeze(['keep', 'sell_to_players', 'sell_to_npc',
                                      'mule_keep', 'unknown']);

// WHERE AN ITEM PHYSICALLY ENDS UP, which is not the same question as what it is FOR.
//
// Operator, 2026-09-17: a fifth state, `mule_keep` — the mule holds it — "and I guess that
// means unknown will probably end up on Loial, so it's really just default mule-keep".
//
// Both are true and they stay SEPARATE VERDICTS anyway, because they need different actions from
// whoever reads the report. `mule_keep` is a decision: this is where the item belongs. `unknown`
// is a gap: either nobody could read the item, or the list has no line for what it says. They
// route to the same pack and they are not the same fact, and collapsing them would turn a
// growing backlog of unsorted loot into a category that looks deliberate.
//
// So: the ROUTING table maps a verdict to a destination, and two verdicts share one.
export const ROUTES = Object.freeze({
  // A KEEP GOES TO THE FINDER'S VAULT, NOT TO THE FINDER'S PACK. Operator, 2026-09-17: "anything
  // keep (e.g.: SWL) goes into the finder's vault". The pack is the one container that a death
  // empties and the one with two ceilings, so handing a permanent, fight-worthy attribute back
  // into it is handing it to the next groundworm. The vault is also the only store whose timers
  // do not matter, because a keep has no timer — that is what made it a keep.
  keep: { to: 'owner_vault', proceeds_to: null,
          why: "the finder's vault: a permanent attribute is worth storing, and the pack is the "
             + 'one container a death empties' },

  sell_to_players: { to: 'mule', proceeds_to: 'mule',
                     why: 'held for the menagerie merchant to sell to people' },

  // THE ITEM IS SOLD IN BARLOQUE AND THE MONEY IS THE FINDER'S. Same operator, same sentence:
  // sold to a Barloque merchant, and "the one who brought it to be revealed can have it returned
  // to them and keep the money from selling the magic item". The destination and the PROCEEDS are
  // two different questions and this table used to answer only the first — so a timed item read
  // as "the mule sells it and keeps the money", which is the fleet quietly taxing its own farmers
  // for using the reveal desk.
  //
  // Barloque because that is where the desk is. The timer runs wherever the item is parked, so
  // carrying it to a better counter spends the value it is being sold for.
  sell_to_npc: { to: 'counter_barloque', proceeds_to: 'owner',
                 why: 'a timed attribute is worth money today and nothing tomorrow, so it is sold '
                    + 'at the Barloque counter beside the desk — and the shillings go back to '
                    + 'whoever brought it in' },

  mule_keep: { to: 'mule', proceeds_to: 'mule',
               why: 'the collection lives on the mule — it cannot lose it by dying' },

  unknown: { to: 'mule', proceeds_to: null,
             why: 'DEFAULT mule-keep. Not a decision: either nobody could read it ' +
                  'or the list has no line for it, and neither is a reason to sell' },
});

// THE DESTINATIONS, NAMED ONCE. A reader deciding what to DO needs to tell "the finder's vault"
// from "the finder", and "a counter" from "the counter next to the desk" — and a caller that
// derives those from the `to` string is a second opinion waiting to disagree with this one.
export const DESTINATIONS = Object.freeze({
  owner_vault: { who: 'owner', store: 'vault',
                 label: "the finder's vault" },
  mule: { who: 'mule', store: 'pack', label: "the mule's pack" },
  counter_barloque: { who: 'mule', store: 'sold', town: 'Barloque',
                      label: 'a Barloque counter' },
});

/** What a route's destination means: who holds it, in which store, and how to say it. */
export const destinationOf = (to) => DESTINATIONS[to] ?? null;

/** Where a verdict sends the item. Unknown routes to the mule without becoming a decision. */
export const routeOf = (verdict) => ROUTES[verdict] ?? ROUTES.unknown;

// WHY THE MULE IS THE RIGHT SHELF, and why it has to be re-checked rather than assumed: a mule
// keeps its entire pack through death because it still carries the newbie honour string, and
// that protection is CLEARED at about two game months of age on a check that fires whenever
// anybody looks at the character. See m59-nodrop.mjs — the collection is only as safe as that
// sentence, and nothing here stores a claim about it.

// ---------------------------------------------------------------- the evidence
//
// SIXTEEN WEAPON ATTRIBUTES, AND THE KOD SORTS THEM FOR US. Read out of
// kod/object/passive/itematt/weapatt/ on 2026-09-17 rather than remembered: `HasTimer` is the
// permanence test, `viDifficulty` is the strength one, `piValue_modifier` is what it does to the
// price, and the look-text signature is the only string that reliably identifies it — seven of
// these do not rename the item at all.
//
//   file      timed  diff  value  look-text signature
//   wavamper  perm   10    200    "unholy glow seems to suck all life"
//   wablindr  perm    9    200    "Q's insignia is emblazoned"
//   waparal   perm    9    200    "Zjiriaesqe"
//   wapurge   perm    9    200    "sign of Psychochild is engraved"
//   waexpert  perm    9    200    "Colhorr's signature is engraved"  (also "of the master")
//   wabonker  perm    9    150    "Mocker's signature flamboyantly emblazons"
//   waspell   perm    9    150    "Mystical energy flits about"
//   watwist   perm    9    150    "swirling green 'GMT'"
//   waghall   perm    8    200    "of the defender"
//   wafactn   perm    8    150    "The princess' sigil is embossed"  (also "of the duke")
//   wapunish  perm    7    —      "you scream out in pain"           (also "of the just")
//   wacerem   perm    5    150    "unsuitable for blood combat"      (also "ceremonial")
//   waench    TIMED   —    —      "enchanted"
//   waglow    TIMED   —    100    "glowing"
//   waspellt  TIMED   —    —      "holy"
//   wacursed  TIMED   —    100    "cursed"
//
// THAT TABLE IS THE WHOLE POLICY, and it lands where the operator said it would:
//
//   * TIMED -> sell_to_npc. `HasTimer`/`TimerExpired` in waench.kod:84-93 and waglow.kod:138-145
//     is the citation, and the timer runs in the vault as well as in the pack. Worth money today
//     and nothing tomorrow, so a counter that pays less and pays NOW beats a person who pays
//     more next week.
//   * PERMANENT AND STRONG -> keep. Difficulty 8 and up: the ones an actual fighter wants.
//   * PERMANENT AND WEAK -> sell_to_players. Operator, 2026-09-17: "we want all permanent
//     enchantments not good enough to keep to be sell_to_players", and ceremonial is the case
//     they remembered. The kod agrees in as many words — +2 damage, difficulty 5, x1.5 price, and
//     a description saying the weapon is "obviously unsuitable for blood combat, though it might
//     provide [an] edge in games and tourneys". A thing worth more for its looks than its edge is
//     exactly a thing to sell to a person.
//
// AND THE VAULT POLICY ALREADY ARGUED FOR THIS WITHOUT KNOWING IT. tools/vault-strategies/
// keep-unbuyable.mjs keeps "what no merchant will sell you back", and allocates the entire
// 3000-bulk vault to dark angel feathers and blue dragon scales — half each, which it says
// "leaves nothing spare, which is honest about what this strategy is for". By its own rule a
// permanently enchanted weapon outranks both: unbuyable AND unfarmable on demand, where a
// feather is merely unbuyable. So `keep` here is a claim on vault space that policy has no room
// for yet, and saying so is the point — a fleet that wants room for a third thing wants its own
// strategy.
export const WEAPON_ATTRIBUTES = Object.freeze([
  { look: 'unholy glow seems to suck all life', timed: false, difficulty: 10, value: 200, file: 'wavamper.kod' },
  { look: "Q's insignia is emblazoned", timed: false, difficulty: 9, value: 200, file: 'wablindr.kod' },
  { look: 'Zjiriaesqe', timed: false, difficulty: 9, value: 200, file: 'waparal.kod' },
  { look: 'sign of Psychochild is engraved', timed: false, difficulty: 9, value: 200, file: 'wapurge.kod' },
  { look: "Colhorr's signature is engraved", timed: false, difficulty: 9, value: 200, file: 'waexpert.kod' },
  { look: "Mocker's signature flamboyantly emblazons", timed: false, difficulty: 9, value: 150, file: 'wabonker.kod' },
  { look: 'Mystical energy flits about', timed: false, difficulty: 9, value: 150, file: 'waspell.kod' },
  { look: "swirling green 'GMT'", timed: false, difficulty: 9, value: 150, file: 'watwist.kod' },
  { look: 'of the defender', timed: false, difficulty: 8, value: 200, file: 'waghall.kod' },
  { look: "The princess' sigil is embossed", timed: false, difficulty: 8, value: 150, file: 'wafactn.kod' },
  { look: 'of the just', timed: false, difficulty: 7, value: null, file: 'wapunish.kod' },
  { look: 'unsuitable for blood combat', timed: false, difficulty: 5, value: 150, file: 'wacerem.kod' },
  { look: 'enchanted', timed: true, difficulty: null, value: null, file: 'waench.kod' },
  { look: 'glowing', timed: true, difficulty: null, value: 100, file: 'waglow.kod' },
  { look: 'holy', timed: true, difficulty: null, value: null, file: 'waspellt.kod' },
  { look: 'cursed', timed: true, difficulty: null, value: 100, file: 'wacursed.kod' },
]);

// The strength line, in one place so it can be argued with rather than hunted for. 8 is where the
// kod's own difficulty grading separates the fighting attributes from the decorative ones.
export const KEEP_AT_DIFFICULTY = 8;

// A TIMED ATTRIBUTE IS A NAME PREFIX AND IS EMITTED AS ONE.
//
// The four timed rows carry bare words — enchanted, glowing, holy, cursed — because that is how
// the kod names the weapon: waspellt.rsc is "holy %s", giving "holy long sword". Their look
// text says something else entirely ("The weapon glows with a pure, white light."). Left as
// plain substrings they matched PROSE, and the one they matched was a quest item: see needleOf.
//
// The twelve permanent rows stay plain substrings. They are distinctive phrases that appear in
// the description rather than the name, which is where they have to be looked for.
const attrs = (pick) => Object.freeze(WEAPON_ATTRIBUTES.filter(pick).map(
  a => (a.timed ? { text: a.look, in: 'name', word: true } : a.look)));

// THE COMMITTED DEFAULT, derived from the table above rather than typed beside it — so a
// correction to the kod reading cannot leave a stale list behind.
export const DEFAULT_LIST = Object.freeze({
  keep: Object.freeze({
    // Permanent and worth fighting with, plus the one ITEM attribute that never expires.
    attributes: Object.freeze([
      'soft, white light', 'transcendant',
      ...attrs(a => !a.timed && (a.difficulty ?? 0) >= KEEP_AT_DIFFICULTY),
    ]),
    items: Object.freeze([]),
  }),
  sell_to_players: Object.freeze({
    // Permanent but not good enough to fight with — worth more to a person than to a counter.
    attributes: attrs(a => !a.timed && (a.difficulty ?? 0) < KEEP_AT_DIFFICULTY),
    items: Object.freeze([
      // Charges are spent by USE, not by the clock, so these hold their value on a shelf.
      'wand', 'ring of', 'scroll',
      // A BASE ITEM rather than an attribute (weapon/mystswrd.kod), and the operator named it.
      // No fixed merchant stocks one — the only seller in the tree is Izzio, a WANDERER, plus
      // boss drops in orcpit1 and sewking — so it cannot simply be bought back, and a person
      // will pay for that.
      'mystic sword',
    ]),
  }),
  sell_to_npc: Object.freeze({
    attributes: attrs(a => a.timed),
    items: Object.freeze([]),
  }),
  // EMPTY BY DEFAULT, AND THAT IS NOT AN OVERSIGHT. Nothing in the kod says which items belong
  // on a mule — that is a judgement about this fleet's shelves, so the committed default makes
  // no claim and `unknown` carries everything unsorted to the mule anyway.
  mule_keep: Object.freeze({ attributes: Object.freeze([]), items: Object.freeze([]) }),
  why: Object.freeze({
    'soft, white light': 'ItemAttTranscendant (iatransc.kod) — no timer, so worth storing',
    transcendant: 'the same attribute under its class name, in case the look text uses it',
    'unsuitable for blood combat': 'ceremonial: +2 damage, difficulty 5, x1.5 price, and the kod ' +
      'calls it unsuitable for combat. Worth more for its looks than its edge',
    'of the just': 'punisher, difficulty 7 — under the line, and it hurts the wielder',
    enchanted: 'HasTimer/TimerExpired in waench.kod:84-93. The timer runs in the vault too',
    glowing: 'HasTimer in waglow.kod:138-145 — timed, as above',
    wand: 'charges spend by USE, not by the clock, so it keeps its value on a shelf',
    'ring of': 'the ring of invisibility spends charges only while worn',
    scroll: 'piGoBadTime is -1 on scrolls: they do not spoil, so they can wait for a buyer',
    'mystic sword': 'no fixed merchant stocks one — only Izzio the wanderer and two boss rooms — ' +
      'so it cannot be bought back on demand',
  }),
});

const EMPTY = Object.freeze({ attributes: [], items: [] });

/**
 * WHERE THE LIST IN FORCE CAME FROM, said out loud.
 *
 * A list that silently falls back to a default is a list nobody can audit — the same failure as
 * a report that cannot say which ledger it read. `source` is always populated.
 */
export function loadList({ file = null } = {}) {
  const path = file ?? process.env.M59_MAGIC_KEEP ?? here('../substrate/magic-keep.json');
  const fallback = (note, extra = {}) => ({
    ...structuredClone({ keep: DEFAULT_LIST.keep, sell_to_players: DEFAULT_LIST.sell_to_players,
                         sell_to_npc: DEFAULT_LIST.sell_to_npc,
                         mule_keep: DEFAULT_LIST.mule_keep }),
    why: { ...DEFAULT_LIST.why }, overrides: [],
    source: { path, ...extra, note },
  });

  if (!existsSync(path))
    return fallback('no local list, so the committed default is in force. Write one at ' +
                    `${path} — it is orders, so it is gitignored.`, { exists: false });
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    // A FILE THAT WILL NOT PARSE IS NOT AN EMPTY FILE, and says so — docs/m59-policy.md.
    return fallback('the local list will not parse, so the committed default is in force. It is ' +
                    'NOT being read as an empty list.', { exists: true, unreadable: e.message });
  }

  const names = (v) => (Array.isArray(v) ? v.map(String).map(s => s.trim()).filter(Boolean) : []);
  const bucket = (k) => ({
    attributes: names(raw?.[k]?.attributes),
    items: names(raw?.[k]?.items),
  });
  const out = { keep: bucket('keep'), sell_to_players: bucket('sell_to_players'),
                sell_to_npc: bucket('sell_to_npc'), mule_keep: bucket('mule_keep') };
  const entries = Object.values(out).reduce((n, b) => n + b.attributes.length + b.items.length, 0);

  // AN EMPTY FILE IS NOT AN EMPTY LIST. A file that parses to nothing would route every revealed
  // item in the fleet to `unknown` and stall the service silently — keep the default and say so.
  if (!entries)
    return fallback('the local list names nothing at all, which would leave every revealed item ' +
                    'unsorted — keeping the committed default instead', { exists: true, ignored: true });

  // OVERRIDES ARE KEYED BY NAME PLUS REQUIRED TEXT, NEVER BY OBJECT ID. See the header.
  const overrides = (Array.isArray(raw.overrides) ? raw.overrides : [])
    .map(o => ({ name: String(o?.name ?? '').trim(),
                 looks_like: String(o?.looks_like ?? '').trim(),
                 verdict: String(o?.verdict ?? '').trim(),
                 why: o?.why ? String(o.why) : null }))
    .filter(o => o.name && VERDICTS.includes(o.verdict));

  return { ...out, why: raw.why ?? {}, overrides,
           source: { path, exists: true, entries, overrides: overrides.length } };
}

const hay = (s) => String(s ?? '').toLowerCase();

// A NEEDLE THAT IS A BARE WORD NEEDS TO SAY WHERE IT MAY MATCH, AND THE COST OF NOT SAYING SO
// WAS A SALE.
//
// Measured on prod 2026-09-17: Loial's `Chalice of the Rain` — a Shal'ille quest item — was
// classified `sell_to_npc` because its description reads "adorned with holy markings of
// Shal'ille" and `holy` is on that list. `sell_to_npc` is the ONE verdict that destroys the
// item; every other verdict puts it on a shelf. So a false positive there is the expensive
// direction and the only one worth hardening against.
//
// The entry was never meant to match prose. `holy` is a timed weapon attribute and the kod
// states it as a NAME PREFIX — waspellt.rsc carries "holy %s", giving "holy long sword" — while
// the look text for that attribute is "The weapon glows with a pure, white light." The four
// timed attributes are all this shape (`enchanted`, `glowing`, `holy`, `cursed`) and the twelve
// permanent ones are distinctive phrases that cannot collide, which is why only these four bite.
//
// Note `unholy glow seems to suck all life` — a keep — CONTAINS "holy". Order saved that one:
// keep is tested before the sales. A whole-word test removes the dependence on luck.
//
// A plain string still means what it always did, so every hand-written list keeps working.
/** The TEXT of a list entry, whichever form it is written in. Exported because every consumer
 *  that wants to compare, print or audit a list needs it and none of them should have to know
 *  that two forms exist. */
export const needleText = (x) => (x && typeof x === 'object') ? String(x.text ?? '') : String(x ?? '');

const needleOf = (x) => (x && typeof x === 'object')
  ? { text: String(x.text ?? ''), in: x.in ?? 'both', word: !!x.word }
  : { text: String(x ?? ''), in: 'both', word: false };

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Word-anchored on request, substring otherwise. Anchors on non-alphanumerics, not \b, so
 *  an apostrophe or a hyphen in the surrounding text still counts as a boundary. */
const containsNeedle = (haystack, key, word) => word
  ? new RegExp(`(^|[^a-z0-9])${reEscape(key)}([^a-z0-9]|$)`).test(haystack)
  : haystack.includes(key);

/**
 * KEEP, SELL TO A PERSON, SELL TO A COUNTER, OR NOBODY COULD TELL.
 *
 * `look` is the item's description AFTER a reveal. Pass null when it could not be read — that is
 * what `unknown` is for, and it is not the same answer as any of the sales.
 *
 * ORDER MATTERS AND IS DELIBERATE: an explicit override, then keep, then the player sale, then
 * the counter. An item that is both permanent and a wand is a keeper; one that is both timed and
 * a wand goes to a person, because the wand's charges are what the buyer is paying for and they
 * do not tick. Only a timed attribute with nothing else to recommend it goes to the smith.
 */
export function classify({ name = '', look = null } = {}, list = null) {
  const L = list ?? loadList();
  const n = hay(name);
  const l = look === null || look === undefined ? null : hay(look);

  const hit = (raw) => {
    const q = needleOf(raw);
    const k = hay(q.text);
    if (!k) return null;
    if (q.in !== 'look text' && containsNeedle(n, k, q.word))
      return { matched: q.text, where: 'name' };
    if (q.in !== 'name' && l !== null && containsNeedle(l, k, q.word))
      return { matched: q.text, where: 'look text' };
    return null;
  };

  for (const o of L.overrides ?? []) {
    if (!n.includes(hay(o.name))) continue;
    // `looks_like` is what makes an override safe on a recycling name: "the mace whose text
    // says X", not "any mace". Absent, it matches the name alone and says so.
    if (o.looks_like && !(l !== null && l.includes(hay(o.looks_like)))) continue;
    return { verdict: o.verdict, matched: o.name, where: 'override', kind: 'override',
             why: o.why ?? `an operator override for "${o.name}"` +
                  (o.looks_like ? ` reading "${o.looks_like}"` : '') };
  }

  // ORDER: override, keep, MULE_KEEP, then the two sales. `mule_keep` sits above both sales
  // because naming something for the mule is a decision to hold it, and a hold has to beat a
  // sale — otherwise an item on both lists would be sold out from under the operator's own line.
  for (const [verdict, bucket] of [['keep', L.keep ?? EMPTY],
                                   ['mule_keep', L.mule_keep ?? EMPTY],
                                   ['sell_to_players', L.sell_to_players ?? EMPTY],
                                   ['sell_to_npc', L.sell_to_npc ?? EMPTY]]) {
    for (const kind of ['attributes', 'items']) {
      for (const needle of bucket[kind] ?? []) {
        const h = hit(needle);
        const key = needleOf(needle).text;
        if (h) return { verdict, ...h, kind: kind === 'attributes' ? 'attribute' : 'item',
                        why: L.why?.[key] ?? `"${key}" is on the ${verdict} list` };
      }
    }
  }

  // NOTHING MATCHED — and what that means depends entirely on whether we could read it.
  if (l === null)
    return { verdict: 'unknown', matched: null, kind: null,
             why: 'nothing on any list appears in the NAME and the look text could not be read, ' +
                  'so this is "nobody looked" rather than "nothing is on it". It stays put.' };
  return { verdict: 'unknown', matched: null, kind: null,
           why: 'the look text was read and nothing on any list is in it. An unlisted item is a ' +
                'MISSING LINE rather than a decision — add it to substrate/magic-keep.json. ' +
                'Nothing is sold on the strength of an absent entry.' };
}

/** Sort a revealed pack into the four piles, keeping the reason with each row. */
export function sortPack(items = [], list = null) {
  const L = list ?? loadList();
  const out = { keep: [], sell_to_players: [], sell_to_npc: [], mule_keep: [], unknown: [],
                source: L.source };
  for (const it of items) {
    const v = classify({ name: it.name, look: it.look ?? null }, L);
    // The destination travels with the row: a reader deciding what to DO needs it, and
    // deriving it twice is how two callers come to disagree about where `unknown` goes.
    out[v.verdict].push({ ...it, ...v, route: routeOf(v.verdict).to });
  }
  return out;
}

/**
 * ONE ITEM'S DESCRIPTION, OR NULL — never another item's.
 *
 * `look_at` was measured answering with the PREVIOUS call's object twice in nine calls, carrying
 * its own wrong id (CLAUDE.md, object ids). So the id that comes back is checked against the id
 * asked for, and a mismatch is a refusal to answer rather than an answer about the wrong sword.
 */
export async function describeItem(agent, id, { call, tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await call('look_at', { agent, target: id }).catch(() => null);
    if (!r) continue;
    const got = r.id ?? r.object_id ?? r.object?.id ?? null;
    if (got != null && Number(got) !== Number(id)) continue;   // somebody else's description
    const text = r.description ?? r.text ?? r.look ?? r.object?.description ?? null;
    if (text) return { text: String(text), id: got ?? id, tries: i + 1 };
  }
  return null;
}

// ---------------------------------------------------------------- cli

const isMain = !!process.argv[1] &&
  import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;

if (isMain) {
  const argv = process.argv.slice(2);
  const L = loadList();
  const pad = (s, n) => String(s ?? '').padEnd(n);

  console.log(`\nthe list in force: ${L.source.exists ? L.source.path : '(committed default)'}`);
  if (L.source.note) console.log(`  ! ${L.source.note}`);
  if (L.source.unreadable) console.log(`  ! parse error: ${L.source.unreadable}`);

  for (const k of ['keep', 'mule_keep', 'sell_to_players', 'sell_to_npc']) {
    const b = L[k] ?? { attributes: [], items: [] };
    console.log(`\n${k}`);
    for (const a of b.attributes) console.log('  attribute  ' + pad(a, 42) +
      (argv.includes('--explain') && L.why?.[a] ? L.why[a] : ''));
    for (const i of b.items) console.log('  item       ' + pad(i, 42) +
      (argv.includes('--explain') && L.why?.[i] ? L.why[i] : ''));
    if (!b.attributes.length && !b.items.length) console.log('  (nothing)');
  }
  if (L.overrides?.length) {
    console.log('\noverrides (name + required text, never an object id)');
    for (const o of L.overrides)
      console.log(`  ${pad(o.name, 20)} ${pad(o.looks_like || '(name alone)', 30)} -> ${o.verdict}`);
  }

  console.log('\nAn UNLISTED item sorts to `unknown` and is NOT sold — that is a missing line in ' +
              'the list,\nnot a decision about the item. `unknown` also covers anything whose ' +
              'look text could not be read.');

  if (argv.includes('--sweep')) {
    // The only path here that touches the fleet. Reveal grade first: an item still at 100 has
    // nothing to sort, because its attributes are still hidden.
    const { callTool, fleetRoster } = await import('./m59-describe.mjs');
    const { isUnidentified } = await import('./m59-items.mjs');
    const call = (name, args) => callTool(name, args, {});
    const roster = await fleetRoster({});
    const rows = [];
    for (const r of roster) {
      const inv = await call('inventory', { agent: r.agent }).catch(() => null);
      for (const it of (inv?.items ?? [])) {
        if ((Number(it.amount) || 0) > 1) continue;
        if (Number(it.rarity) !== 0) continue;        // 100 is unrevealed; sort only the read
        const d = await describeItem(r.agent, it.id, { call });
        rows.push({ owner: r.character, agent: r.agent, name: it.name, id: it.id,
                    look: d?.text ?? null });
      }
    }
    const out = sortPack(rows, L);
    console.log('\n--- the fleet, sorted ---');
    for (const k of ['keep', 'mule_keep', 'sell_to_players', 'sell_to_npc', 'unknown']) {
      console.log(`\n${k} (${out[k].length})`);
      for (const r of out[k].slice(0, 25))
        console.log(`  ${pad(r.owner, 16)} ${pad(r.name, 22)} ${r.matched ?? '-'}`);
    }
  }
}
