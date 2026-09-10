// A FLEET ERRAND, DECLARED — AND THE SAFETIES COMPILED IN RATHER THAN REMEMBERED.
//
//   import { fleetScript, walk, bank, shop, verify } from './m59-fleetscript.mjs';
//
//   await fleetScript({
//     name: 'bulk resupply',
//     agents: ['t16', 't20'],
//     steps: [ walk(54), bank('withdraw', ({ need }) => need), walk(53),
//              shop('Frisconar', [{ match: /herb/, amount: 150 }]), walk(39) ],
//   });
//
// WHAT THIS CANNOT REACH YET — THE MANA NODES, AND WHY. (Operator, 2026-09-09.)
//
// Recorded here rather than in a doc for the same reason the #movement epoch tag is: it is a
// statement about WHICH CODE was running, and it stops being true the moment somebody fixes
// the mover. There are seven mana nodes and they are the standing test of the fleet's
// movement stack, because each one is a POINT target at the end of the world's worst
// approach — arriving in the room is not arriving at the stone.
//
//   reachable with the code as it stands   27 Icky Cave, 39 Castle Victoria,
//                                          579 Ancient Place, 589 Sentinel
//   NOT reachable — do not read a failure   45 Badlands, 515 Seafarer's Peak,
//   here as a bug in the errand             750 Ice Caves, 1006 Mausoleum
//
// Melded so far: 27 (Loial the Ogier, 2026-09-09, max mana 25 -> 33). The 49 -> 45 hop was
// attempted six times and refuses every time; the router offers it as ONE direct hop, so
// that is a boundary the mover cannot cross rather than a route it cannot find. Expected,
// and not worth debugging as an errand fault.
//
// What actually stands between us and the other four is not this file. It is exact .roo
// geometry, monster POSITIONS (collision is height-agnostic, so a body under a ledge blocks
// a hop over it), and jumps from location to location. Getting them needs enhancements to
// the MCP server's capabilities, to the fleetscripts, and to routing/pathing/jumping —
// three separate pieces of work, none of them a guarantee in this file.
//
// So: a node run that fails on one of the four right-hand entries is reporting the state of
// the mover, and belongs in the movement ledger under its #movement epoch, not in a bug
// report about the errand. See substrate/mananodes/<agent>.json for what a character holds
// and how each one was got, and `node tools/m59-fleetbook.mjs mana-nodes` for the recipe.

// WHY THIS EXISTS. Over one day, five separate ad-hoc scripts drove this fleet, and each one
// re-implemented the same handful of concerns and got a DIFFERENT subset of them wrong:
//
//   * no run lock, so three processes drove the same characters at once and every collision
//     surfaced as "movement cancelled by a newer command" — the sentence a genuine survival
//     interrupt produces, which is what made it expensive to find;
//   * no `busy`, so the keeper cancelled a walk home for its own town errand and the
//     character carrying the fleet's entire reagent stock wandered into Barloque;
//   * a fixed ten-second wait against journeys whose p90 is 317-740 seconds, reported as
//     "could not reach any of 373, 53, 104" — indistinguishable from there being no shop;
//   * re-issuing `travel` while the character was still walking, which the keeper refuses,
//     so every retry made it worse;
//   * a fixed sleep rather than a poll, so a courier that arrived in ninety seconds sat out
//     the remaining five minutes and one that died was watched for five minutes as a corpse;
//   * no health gate, so a recall walked a character out of the inn it was healing in at
//     1 of 44 health, straight back down the road that had just killed it;
//   * trusting the purchase call instead of reading the pack, when a handshake that moves
//     nothing is the commonest failure at a counter;
//   * and a `finally` that never ran because the process was force-killed, leaving six
//     characters stuck "driven" — which made the patrol re-send orders every pass for ever.
//
// None of those are interesting. All of them are mandatory. So they stop being the author's
// problem: a script DECLARES what it wants done and this compiles the guarantees around it.
//
// THE GUARANTEES, and none of them is optional:
//
//   1. ONE DRIVER PER FLEET. Takes the m59-runlock claim, refuses with the holder's pid,
//      label, age and argv, exits 3. Parallelism lives INSIDE one locked run, because what
//      contends is two drivers on the same character, not two characters.
//   2. THE BODY IS HELD. Every agent is marked `busy` for the whole errand and freed in a
//      finally AND on signals AND on uncaught exceptions — the three ways today's scripts
//      leaked a stuck character.
//   3. A JOURNEY HAS A HEALTH FLOOR. No walk begins below `minHealth` (default 1 — full),
//      matching the harness's own travel_start_health. Unknown health is not permission.
//   4. WAITS ARE THE JOURNEY'S OWN LENGTH. Budgets come from travel_estimate p90, polled,
//      exiting the moment the character arrives or dies. Never a fixed sleep.
//   5. TRAVEL IS ASYNCHRONOUS. Issued once per attempt and never re-issued while the
//      character is still walking.
//   6. RESULTS ARE READ BACK. A step may declare `verify`, and the recorded outcome is what
//      the world says afterwards, not what the call claimed.
//   7. THE BOT'S LEASE IS TAKEN, AND THE JOURNEY IN FLIGHT IS CANCELLED. `busy` is
//      broker-side and does not stop the process holding the socket, and a bot re-decides
//      about every thirty seconds — so every agent's work, movement and economy are leased
//      off the keeper for the errand and heartbeaten, while identity, mortality, survival
//      and recovery stay where they belong. Then the journey already running is cancelled,
//      because a claim takes the faculties and not the body. See `holdKeeper`.
//   8. A ROOM WE KNOW TRAPS CHARACTERS IS REFUSED BEFORE ANYTHING WALKS. Some rooms cannot
//      be left by any route the bake knows — because leaving needs an item, a spoken word or
//      a mechanic no collision map models. Walking into one is unrecoverable without an
//      operator. `KNOWN_TRAPS` names them with the reason; see `trapCheck`.
//
// EVERY ONE OF THOSE IS A MISTAKE SOMEBODY MADE TWICE. That is the entry criterion, and the
// reason to reach for this file rather than write a script: when a trap gets written down in
// CLAUDE.md it still has to be REMEMBERED, and the record of this fleet is that it is not.
// So when a fleet operation goes wrong for a reason a rule already covered, the fix is a
// guarantee in here that refuses before anything walks — not another paragraph.
//
// A step that fails ends THAT AGENT's errand and no other's. One courier dying is not the
// operation failing, which is the difference between a fleet tool and a script.
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { takeRunLock } from './m59-runlock.mjs';
import { fleetName, stateFileFor, resolveControlUrl } from './m59-fleetpath.mjs';
import { menageriePathFor } from './m59-menagerie-roster.mjs';
import { RAZA_ROOMS } from './m59-errandstate.mjs';
import { foodValue, allFoodNames } from './m59-items.mjs';
import { recordEvent, readLedger } from './m59-ledger.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
// ---------------------------------------------------------------- GUARANTEE 9: PROVENANCE
//
// A SCRIPT IS ONLY KNOWN TO WORK AGAINST THE WORLD IT WAS WRITTEN FOR, and nothing here
// could previously say which world that was.
//
// The failure this exists for, measured 2026-09-07. `m59-outfit.mjs` had worked. Then the
// fleet moved to the keeper-process session driver, which put the World inside the KEEPER
// and left the broker holding a snapshot. Three things in that script broke at once, and
// every one of them failed SILENTLY:
//
//   * `map` began answering `route: {found: null, reason: "...the broker holds a snapshot,
//     not a World"}`, and the script's `if (rt?.route?.found)` read "I cannot answer" as
//     "there is no route" — so it reported "no teacher of punch reachable" about a
//     stationary merchant it had just successfully looked up;
//   * a 30-second RPC timeout was being applied to a journey that takes minutes, so a walk
//     that was going fine was recorded as "travel refused" and RE-ISSUED twice more, which
//     is the thing guarantee 5 exists to prevent;
//   * the arrival check read `status.where.num`, a field the status tool does not return,
//     so it never fired and a character standing in the right room was walked again.
//
// None of that presented as a version problem. It presented as the game refusing, and it
// cost an evening and one character's shillings to find. The script was not wrong when it
// was written. The ground moved under it.
//
// So a task may now declare the generation it was last developed and seen green against,
// and what it depends on. Before anything walks, this compares that pin against the tree as
// it is now and says GREEN or REVIEW. It is deliberately the same mechanic as
// m59-research's report staleness — `repo_commit` plus `sources`, where a report goes stale
// when a file it cited changes — applied to an operation rather than a document, and for
// the same reason: a pin is what turns "this used to work" into a checkable claim.
//
//   provenance: {
//     pinned:   '1fb1f51',                    // last commit this was seen green against
//     verified: '2026-09-07',                 // when, and by whom, it was last seen green
//     touches:  ['tools/m59-outfit.mjs',      // what it would break WITH
//                'tools/m59-broker.mjs'],
//     refuseOnDrift: false,                   // default: warn loudly, run anyway
//   }
//
// DRIFT IS NOT FAILURE, which is why warning is the default. Most commits touching a
// dependency change nothing a given script relies on, and a check that refused on every one
// would be switched off inside a week. What it buys is the thing nobody had on the night it
// was written: the script says "I was last green at X, and these dependencies have moved
// since" BEFORE it drives a fleet — so an agent reads a diff first, instead of discovering
// it in production one silent failure at a time.

const git = (args, cwd) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8',
                                       stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
};

/**
 * Compare a task's pinned generation against the working tree.
 *
 * Exported on its own so an agent can ASK before it runs: deciding whether a script is
 * likely to work is a different act from executing it, and wanting that answer must never
 * require driving a fleet to get it.
 *
 * @returns {{status:'green'|'review'|'unpinned'|'unknown', why:string, changed:string[],
 *            behind:number|null, head:string|null, pinned:string|null}}
 */
// THE REPO IS THIS FILE'S REPO, NOT THE CALLER'S WORKING DIRECTORY.
//
// `cwd` defaulted to process.cwd(), so running an errand from anywhere but the checkout
// answered `unknown — not a git checkout` and the pin silently stopped meaning anything.
// Caught 2026-09-08 running fish-for-weapon from a scratch directory: the banner said
// "unknown" and I nearly read it as "this script has no pin". A guarantee that quietly
// downgrades when you move is not a guarantee.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export function checkProvenance(provenance, { cwd = REPO_ROOT } = {}) {
  if (!provenance?.pinned)
    return { status: 'unpinned', changed: [], behind: null, head: null, pinned: null,
             why: 'this task declares no `provenance.pinned`, so there is no generation to ' +
                  'compare against — it may well be current, and nothing here can tell you' };

  const head = git(['rev-parse', 'HEAD'], cwd);
  if (!head)
    return { status: 'unknown', changed: [], behind: null, head: null, pinned: provenance.pinned,
             why: 'not a git checkout, or git is unavailable, so the pin cannot be checked' };

  const pinned = provenance.pinned;
  if (git(['rev-parse', '--verify', `${pinned}^{commit}`], cwd) === null)
    return { status: 'unknown', changed: [], behind: null, head, pinned,
             why: `the pinned commit ${pinned} is not in this checkout — it may predate a ` +
                  'rebase, or belong to a different repository' };

  // WHAT MOVED, NOT HOW FAR. A count of commits is a number nobody can act on; the list of
  // dependencies that actually changed is a reading list.
  const touches = [].concat(provenance.touches ?? []).filter(Boolean);
  const range = `${pinned}..HEAD`;
  const changed = (git(touches.length ? ['diff', '--name-only', range, '--', ...touches]
                                      : ['diff', '--name-only', range], cwd) || '')
    .split('\n').map(s => s.trim()).filter(Boolean);
  const behindRaw = git(['rev-list', '--count', range], cwd);
  const behind = behindRaw == null ? null : Number(behindRaw);

  if (!changed.length)
    return { status: 'green', changed: [], behind, head, pinned,
             why: (touches.length ? `nothing this task depends on has changed since ${pinned}`
                                  : `the tree has not changed since ${pinned}`) +
                  (behind ? ` (${behind} commit(s) back)` : '') };

  return { status: 'review', changed, behind, head, pinned,
           why: `${changed.length} dependenc${changed.length === 1 ? 'y has' : 'ies have'} ` +
                `changed since this task was last green at ${pinned}` +
                (behind ? `, ${behind} commit(s) back` : '') +
                ' — read the diff before trusting it against production' };
}

// WHICH BROKER. Resolved rather than defaulted — see resolveControlUrl in
// m59-fleetpath.mjs for why this checkout is allowed to refuse to guess.
const RPC = () => {
  const r = resolveControlUrl();
  if (!r.url) throw new Error(`no broker named: ${r.why}`);
  return r.url;
};
let seq = 0;

/** One broker call. Kept private so a step cannot bypass the pacing or the timeout. */
async function call(name, args = {}, ms = 180_000) {
  const r = await fetch(RPC(), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call',
                           params: { name, arguments: args } }),
    signal: AbortSignal.timeout(ms),
  });
  const d = await r.json();
  try { return JSON.parse(d.result.content[0].text); } catch { return d.result?.content?.[0]?.text ?? d; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- reading a character
//
// One place that knows how to ask "where is it, how hurt is it, is it dead". Every script
// today wrote its own and they disagreed: one read `st.room.id` (which does not exist), one
// trusted the fleet board's `activity: idle` for characters that were demonstrably walking.
/**
 * WHAT THIS CHARACTER CAN ACTUALLY SPEND, read off the pack because that is where money is.
 * Callers that already hold an inventory should sum it themselves rather than call this —
 * it costs a round trip, so it does not belong in a poll loop.
 */
export function purseOf(items = []) {
  return (items || []).filter(i => /shilling/i.test(i.name || ''))
                      .reduce((n, i) => n + (i.amount || 1), 0);
}

// ---------------------------------------------------------------- what is food, and what is not
//
// ASK THE GAME, NEVER A WORD LIST. `foodValue` reads the table built from the game's own Food
// class tree, so it knows all twenty-two foods and cannot be argued with.
//
// This is here because the same mistake has now been made in four places by four different
// hands, and each one cost something:
//
//   * m59-smartloot filed `spider eye`, `bunch of grapes` and `fortune cookie` as sellable
//     stock, because its FOOD was a pattern somebody typed.
//   * the sell circuit's keep list and the street giveaway's each named two of the SEVEN
//     things the Duke's tables hand out, so the other five were sold in Barloque or dropped
//     in the road — six hundred spider eyes among them, at nutrition 9, the same as pork.
//   * and a keep list that matched `mushroom` as a family would have held all five of this
//     world's mushrooms, four of which are casting reagents that are meant to be sold.
//
// So a script never has to decide what food is. It asks.
//
// VIGOR ABOVE 80 COMES ONLY FROM EATING — resting stops awarding it at 80 of 200 — which is
// why this matters at all: food in a pack is the only route to a character that fights at
// 150+, and every one of those four bugs was the fleet walking its own vigor to a merchant.

/**
 * The edible half of a pack, each with what it is worth.
 *
 * @param {Array<{name:string,amount?:number}|string>} items  from `pack(agent)`
 * @returns {Array<{name:string,amount:number,nutrition:number,vigor:number}>}
 *   `vigor` is nutrition * amount — what the whole stack is worth if it is all eaten.
 */
export function foodIn(items = []) {
  return (items || []).map(i => {
    const name = String(typeof i === 'string' ? i : (i?.name ?? '')).trim();
    const amount = typeof i === 'string' ? 1 : Number(i?.amount ?? 1) || 1;
    const f = name ? foodValue(name) : null;
    if (!f) return null;
    const nutrition = Number(f.nutrition) || 0;
    return { name, amount, nutrition, vigor: nutrition * amount };
  }).filter(Boolean);
}

/**
 * Everything else, in the shape it arrived in.
 *
 * Money is NOT filtered out here — a shilling is not food and belongs in "not food", which is
 * what a caller asking for non-food almost always means. Use `purseOf` when the question is
 * about money specifically; the two answers are different and both are wanted.
 */
export function nonFoodIn(items = []) {
  return (items || []).filter(i => {
    const name = String(typeof i === 'string' ? i : (i?.name ?? '')).trim();
    return !name || !foodValue(name);
  });
}

/**
 * Both halves and the arithmetic, in one pass — the usual call.
 *
 * `vigor` is the total if every bite were eaten. It is NOT vigor the character has: the
 * stomach admits 100 at a sitting and drains about 7.2 a minute (FOOD_USE_RATE, player.kod),
 * so a pack of 600 spider eyes is a fortnight of eating rather than a number to add to a
 * vitals reading. `meals` counts items, `kinds` counts distinct foods.
 */
export function splitFood(items = []) {
  const food = foodIn(items);
  return {
    food,
    other: nonFoodIn(items),
    meals: food.reduce((n, f) => n + f.amount, 0),
    kinds: new Set(food.map(f => f.name.toLowerCase())).size,
    vigor: food.reduce((n, f) => n + f.vigor, 0),
  };
}

/**
 * A keep list that spares every food this game has, for `sell`, `vault` and `drop_all`.
 *
 * Derived from the Food class tree rather than typed, for the reason at the top of this
 * section. Spread it into a longer list: `keep: [...FOOD_KEEP, 'wand', 'signet']`.
 *
 * The names are exact and never families. `mushroom` as an entry would hold all five of this
 * world's mushrooms and only two of them are edible; this list contains
 * `edible mushroom` and `inky-cap mushroom` and not the other three.
 */
export const FOOD_KEEP = Object.freeze(allFoodNames());

// ---------------------------------------------------------------- skills and spells
//
// A SKILL IS NOT GOODS, AND THE DIFFERENCE IS INVISIBLE AT THE COUNTER.
//
// A teacher's shelf arrives on BP_BUY_LIST as `{id, name, cost, amount}` — exactly the shape
// a potion has. Nothing on the wire says "this one is an ability". So a script that buys a
// skill with `shop` is making a mistake the protocol cannot warn it about, and `shop` cannot
// notice either: it judges a purchase by what entered the PACK. That is the right rule — a
// merchant that completes the handshake and hands over nothing looks like success on the
// wire — and the wrong question here, because `PlayerCanLearn` adds the ability silently
// (monster.kod:3865) and the pack is identical either side of a successful purchase.
//
// What that cost before this existed: the step waits out `packSettleMs`, reports `nothing
// entered the pack`, and — since a non-optional failure skips every later step without
// `always` — the verification that was the entire point never runs, and neither does the
// walk home. The character is left standing at the teacher, having paid, and the run reports
// a failure whose stated reason is about luggage.
//
// READ FROM THE GAME'S OWN CLASS TREE, never typed. Same discipline as FOOD_KEEP above and
// for the same reason: a hand-written list of abilities goes stale in silence. 22 skills and
// 177 spells carry a display name in `compendium/data/koddb.json` — a built artefact, absent
// from a fresh clone that has not built the compendium, in which case this answers "I do not
// know" and the runtime net in `case 'shop'` is what catches it. Not knowing must never
// become a refusal to run an errand that would have worked.
let ABILITY_NAMES;
export function abilityNames(file = here('../compendium/data/koddb.json')) {
  if (ABILITY_NAMES !== undefined) return ABILITY_NAMES;
  try {
    const cls = JSON.parse(readFileSync(file, 'utf8')).classes ?? {};
    const names = new Set();
    for (const root of ['skill', 'spell']) {
      // Walk the whole chain rather than trusting a depth: `attackspell` hangs off `spell`
      // and every bolt spell hangs off that.
      const tree = new Set([root]);
      for (let grew = true; grew;) {
        grew = false;
        for (const [n, c] of Object.entries(cls)) {
          const parent = String(c.parent ?? '').toLowerCase();
          if (parent && tree.has(parent) && !tree.has(n)) { tree.add(n); grew = true; }
        }
      }
      tree.delete(root);
      for (const n of tree) {
        const res = cls[n]?.resources ?? {};
        const key = Object.keys(res).find(k => /name_rsc$/.test(k));
        const value = key ? String(res[key].value ?? '').trim() : '';
        if (value) names.add(value.toLowerCase());
      }
    }
    ABILITY_NAMES = Object.freeze([...names].sort());
  } catch { ABILITY_NAMES = Object.freeze([]); }
  return ABILITY_NAMES;
}

/** Is this the name of a skill or a spell? False when the table is unavailable. */
export function isAbilityName(name) {
  const n = String(name ?? '').trim().toLowerCase();
  return n ? abilityNames().includes(n) : false;
}

// Which of a `shop` step's lines are really abilities. A line carries a RegExp rather than a
// name, so the question is asked the only way it can be: which known ability names does this
// pattern accept AS A WHOLE NAME.
//
// THE WHOLE-NAME RULE IS NOT FUSSINESS, IT IS THE DIFFERENCE BETWEEN THIS CHECK AND A
// BROKEN SUPPLY RUN. `resupply` buys reagents with a loose `/herb/i`, and `slitherbolt` is a
// spell — so a plain `rx.test(name)` refuses the errand that keeps twenty-one characters in
// reagents, on the grounds that it is secretly buying a bolt spell. Requiring the pattern to
// consume the entire ability name keeps `/^punch$/` and `/punch/i` (both of which really do
// name the skill) and drops `/herb/` against `slitherbolt`, which was never about it.
//
// A refusal that fires on a legitimate errand gets the whole check deleted by the next
// person in a hurry, and they would be right to.
export function abilitiesTargetedBy(lines = []) {
  const hits = [];
  for (const line of [].concat(lines ?? [])) {
    if (!(line?.match instanceof RegExp)) continue;
    for (const name of abilityNames()) {
      const m = name.match(line.match);
      if (m && m[0].length === name.length) hits.push(name);
    }
  }
  return [...new Set(hits)];
}

export async function observe(agent) {
  const s = await call('status', { agent }, 40_000).catch(() => null);
  // HEALTH LIVES UNDER TWO DIFFERENT KEYS AND ONLY ONE OF THEM WAS READ.
  //
  // A keeper-backed character's status carries `hp`; a character the broker holds directly —
  // one joined after the broker started, before the 45s sweep has given it a keeper — carries
  // `vitals.health` and no `hp` at all. This read only the first, so `observe()` returned
  // health: null for the second, and every journey then refused with "health is unreadable —
  // not setting out".
  //
  // That refusal is RIGHT when health is genuinely unknown (it is what catches a character
  // whose keeper has died) and it was firing on a character sitting at a perfectly readable
  // 20/20. Measured on prod 2026-09-09 with Loial, whose fleet row showed `health: "20/20"`
  // in the same breath as the script refusing to move him.
  const vit = s?.hp ?? s?.vitals?.health ?? null;
  const hp = vit && Number.isFinite(vit.value) && vit.max > 0 ? vit.value / vit.max : null;
  const roomName = s?.where?.name ?? s?.room?.name ?? '';
  return {
    ok: Boolean(s),
    room: s?.where?.num ?? s?.room?.num ?? null,
    roomName,
    // NULL IS NOT ZERO, AND ON THIS BROKER `status.gold` IS ALWAYS NULL. The money is not a
    // scalar on the character — it is a `shilling` stack in the pack, which is why the fleet
    // row builds `purse` by summing the inventory. `Number(null ?? 0)` turned "I do not know"
    // into a confident 0, and the resupply script then computed `withdraw = bill - 0` and
    // asked the banker for the full 5,540 on behalf of a courier already carrying it. A
    // banker refusal is a SENTENCE, so that ends the errand at the counter and the courier
    // walks home with nothing — the exact failure the operator was complaining about, just
    // relocated from Barloque to Tos. Callers that need the money read the pack; see
    // `purse()`. Reported by a peer session, 2026-09-03.
    // `Number(null)` is 0 and 0 is finite, so an isFinite guard alone lets the exact value
    // it was written to catch straight through. The null has to be tested first.
    gold: s?.gold == null || !Number.isFinite(Number(s.gold)) ? null : Number(s.gold),
    health: hp,
    hpText: vit ? `${vit.value}/${vit.max}` : '?',
    // A character in the Underworld is dead however its hit points read on the way in.
    dead: vit?.value === 0 || /underworld/i.test(roomName),
    busy: s?.busy ?? null,
  };
}

/** What the character is carrying. Separate from observe() because a pack read is a second
 *  call and most steps do not need one — but a script that ROUTES by cargo does, and it must
 *  ask before the plan is built rather than discovering it at the counter. */
export async function pack(agent) {
  const inv = await call('inventory', { agent }, 60_000).catch(() => ({ items: [] }));
  return inv.items ?? [];
}

// ---------------------------------------------------------------- rooms that keep characters
//
// A COLLISION MAP CANNOT SEE A LOCK. Every trap here is a room our geometry says is fine and
// the game does not, so no amount of routing work finds them — they are learned by stranding
// somebody, and the only way they stop costing us is by being written down where the code
// reads them rather than where a person has to remember them.
//
// Keyed by room number; the value is what an operator needs to hear.
export const KNOWN_TRAPS = Object.freeze({
  // 2026-09-04: three characters spent hours shuffling two squares here on the castle
  // patrol's route. The baked map offers three ways out (south 589, east 598, north 2 to
  // Outside Castle Victoria) and a region flood from their square says all three are
  // reachable. Their own keepers reported ONE — `exits: [{to: 589, direction: "south"}]` —
  // and the operator's word is that going back up needs a Relic of Qor and a spoken phrase.
  // So the north exit our router kept planning through does not exist for us, and a walk
  // aimed at it never ends.
  599: 'Ukgoth, Holy Land of Trolls — leaving northward to Castle Victoria needs a Relic of ' +
       'Qor and a spoken phrase. The baked map offers three exits and only the SOUTH one ' +
       '(to 589) is real for us; a plan through the north exit walks for ever.',
  // 2026-09-09, and learned the way 599 was — by stranding two characters in it. Loial the
  // Ogier and Beaker walked IN from 593 on a route to the Badlands node, and then could not
  // leave in any direction: 6 attempts to 45, 2 to 39 and 3 back to 593, across two
  // characters, every one refused with the router insisting 49 -> 45 was a single direct hop.
  // `look` reports `exits: []` and ONE object in the room, so it is not a crowd blocking a
  // boundary — there is nothing there. Blink was cast to move the body to the room's place of
  // power on the chance it was wedged against geometry; it moved him and changed nothing.
  // Entering worked and leaving does not, which is the signature of a bake that has the
  // inbound edge and no usable outbound one.
  49: "Kardde's Canyon - characters walk IN and cannot walk OUT. Eleven refused " +
      "departures across two characters and three destinations, with `exits: []` and " +
      "an empty room, so this is not a crowd. Reached on the way to the Badlands " +
      "node (45), which is itself not reachable with the current mover.",
});

/**
 * Refuse a plan that walks into a room we know keeps characters, and say so about a
 * character already standing in one.
 *
 * Returns `null` when the plan is fine, or the sentence to refuse it with. `allowTraps`
 * exists for the errand that is deliberately going in to fetch somebody out — it has to be
 * written down at the call site, because "I know about the trap" and "I forgot" otherwise
 * produce the same script.
 */
// GUARANTEE 12: A ROUTE THROUGH A TRAP IS A TRAP, AND `trapCheck` COULD NOT SEE ONE.
//
// `trapCheck` reads the PLAN — where each step is aimed and where the body is standing. The
// router picks everything in between, and nothing was asking it what it had chosen.
//
// 2026-09-09, and it cost the character this rule exists to protect. Loial the Ogier (20 max
// health) was sent `walk(39)` — Upstairs in Castle Victoria, an ordinary destination that is
// not a trap and never has been. From Jasper the router planned
//
//     382 -> 350 -> 568 -> 567 -> 566 -> 576 -> 587 -> 597 -> 598 -> 599 -> 2 -> 38 -> 39
//
// straight through **599**, the single entry in `KNOWN_TRAPS`, and the guarantee written for
// exactly that room said nothing because 599 was not the destination. Six trolls, health
// 11/20 -> 4/20 -> dead, and the travel doctrine makes it worse rather than better: "a
// monster cannot end a journey", so the flee threshold deliberately did not apply.
//
// So the destination test was never the whole test. This asks the ROUTER what it intends
// before anything walks, and refuses a journey that crosses a room we have written down as
// one that keeps characters. It is advisory when the route cannot be read — an unanswerable
// router is a question, not a permit, but refusing every walk because a keeper was slow
// would ground the fleet for the wrong reason. Which is why it says which of the two it did.
export function routeCrossesTrap(hops = []) {
  if (!Array.isArray(hops)) return null;
  for (const hop of hops) {
    const room = Number(hop?.room ?? hop?.to ?? hop);
    if (Number.isFinite(room) && KNOWN_TRAPS[room])
      return { room, why: KNOWN_TRAPS[room] };
  }
  return null;
}

export function trapCheck(plan = [], { standingIn = null, allowTraps = false } = {}) {
  if (allowTraps) return null;
  const into = plan.find(s => s?.do === 'walk' && KNOWN_TRAPS[Number(s.to)]);
  if (into) return `walks to room ${into.to} — ${KNOWN_TRAPS[Number(into.to)]} ` +
                   `Pass { allowTraps: true } if this errand is the rescue.`;
  const here = Number(standingIn);
  if (KNOWN_TRAPS[here] && plan.some(s => s?.do === 'walk'))
    return `is standing in room ${here} — ${KNOWN_TRAPS[here]} ` +
           `Get it out first; an errand started from here will not finish.`;
  return null;
}

// ------------------------------------------------------------------------ unsafe
//
// THE ESCAPE HATCH, AND WHY IT IS SHAPED LIKE RUST'S.
//
// This file exists because five hand-written scripts each got a different subset of the
// same mandatory concerns wrong. The answer to that cannot be "nobody may write anything
// else" — people who did not write these rules have to be able to drive this fleet, and
// some of them will need to do exactly the thing a guarantee here forbids. A rescue walks
// into a known trap on purpose. A test wants a character to set out at 4 health.
//
// So: not a wall, a declaration. `unsafe` does not turn the safeties off. It turns off the
// ones you NAME, leaves every other one running, and refuses to do even that without a
// reason written at the call site. That is the whole of Rust's bargain — the compiler stops
// checking, you start, and the block stays greppable so somebody can find every place the
// checking stopped.
//
//   export const script = {
//     name: 'rescue-from-ukgoth',
//     unsafe: {
//       reason: 'Rescue: going into 599 on purpose to pull a stranded character out.',
//       waives: ['trapCheck'],
//     },
//     ...
//   }
//
// FOUR PROPERTIES, EACH LOAD-BEARING:
//
//   1. NAMED, NOT BOOLEAN. `waives: ['trapCheck']` keeps the health floor. A single
//      `unsafe: true` would make "I wanted one exception" and "I turned everything off"
//      look identical in review — the failure `allowTraps` was already written to avoid.
//   2. A REASON IS MANDATORY. An unsafe block without one is refused, not warned about.
//      "I know about the trap" and "I forgot" have to look different on the page.
//   3. LOUD AT RUN TIME. Every run prints which guarantees are off and why, so the person
//      watching the log finds out before the character does.
//   4. GREPPABLE. `grep -rn "unsafe:" tools/fleetscripts/ substrate/fleetscripts/` is the
//      audit, and `unsafe` in the REPL prints it.
//
// `waives: ['*']` is the total waiver — a bare driver with a lock and nothing else. It is
// deliberately ugly to type and still demands a reason.

// EVERY GUARANTEE NAMES THE INCIDENT THAT CREATED IT, and that is a mechanism rather than a
// courtesy. The entry criterion in CLAUDE.md is already "a mistake somebody made twice" —
// writing the incident into the table is what makes that criterion checkable, and what makes
// the ABSENCE of new guarantees visible.
//
// THE LOOP THIS IS HALF OF. A class of bug recurs -> a guarantee is added that refuses it ->
// the class stops recurring. If we are hitting the same issues and this table is not growing,
// the loop is broken and that is the finding, not the bug. `node tools/m59-fleetscript.mjs
// --guarantees` prints the table with dates so the growth is countable.
//
// A guarantee with no incident is a guess. Do not add one.
// WHICH OF THESE AGENTS ARE MENAGERIE HOSTS.
//
// Read from the roster FILE rather than asked of the broker, deliberately: this runs before
// the lock and before anything walks, and "can I ask the broker" is a different question
// from "is this script well formed". A menagerie that cannot be read is reported as no
// hosts here — the authoritative refusal is still the broker's door, which cannot be
// bypassed; this one exists only to fail EARLY and legibly.
export function hostsAmong(agents, fleet = fleetName()) {
  let roster = {};
  try {
    roster = JSON.parse(readFileSync(menageriePathFor(stateFileFor(fleet)), 'utf8'));
  } catch { return []; }
  const names = new Map();
  for (const [agent, entry] of Object.entries(roster ?? {})) {
    names.set(agent.toLowerCase(), agent);
    const c = entry?.credentials?.character;
    if (c) names.set(String(c).toLowerCase(), agent);
  }
  const hit = new Set();
  for (const a of agents ?? []) {
    const found = names.get(String(a ?? '').toLowerCase());
    if (found) hit.add(found);
  }
  return [...hit];
}

export const UNSAFE_GUARANTEES = Object.freeze({
  runLock: {
    what: 'one driver per fleet',
    since: '2026-09-02',
    incident: 'five ad-hoc scripts drove the fleet in one day; twenty-one keepers and one ' +
              'runner ended up on the same bodies all afternoon',
  },
  keeperLease: {
    what: 'the faculty lease that stops the keeper steering underneath you',
    since: '2026-09-02',
    incident: 'orders given without a lease were silently overwritten by a DUM bot ' +
              're-deciding every ~30s, while every call reported success',
  },
  brokerHoldsFleet: {
    what: 'the broker this talks to is the one holding the fleet this names',
    since: '2026-09-09',
    incident: 'the control URL defaults to port 8901 and the fleet name comes from --fleet, ' +
              'so `M59_FLEET=shadow` with no M59_CONTROL_URL named the shadow fleet, took the ' +
              'shadow run lock, and sent every call to the PROD broker. Nothing errored: the ' +
              'agent simply did not exist there, so it read as an unreadable character',
  },
  menagerieCheck: {
    what: 'refusal to drive a MENAGERIE HOST as though it were a fleet character',
    since: '2026-09-09',
    incident: 'hosts share the broker, the server and the keeper band with the fleet, so a ' +
              'script written for "everyone" reaches them; the broker refuses each call, ' +
              'but only AFTER the lock is taken and the other characters have started ' +
              'walking. Refused here instead, before anything moves',
  },
  trapCheck: {
    what: 'refusal to walk into — or THROUGH — a room KNOWN_TRAPS says keeps characters',
    since: '2026-09-03',
    incident: 'room 599 (Ukgoth) cannot be left by any route the bake knows; the fleet was ' +
              'fed into it repeatedly and learned about it by stranding somebody. Widened ' +
              '2026-09-09 to the ROUTE as well as the destination: `walk(39)` is an ' +
              'ordinary errand to an ordinary room, and from Jasper the router planned it ' +
              'through 599, where six trolls killed a 20-health caster. The destination ' +
              'test was never the whole test',
  },
  minHealth: {
    what: 'the health floor under every journey',
    since: '2026-09-03',
    incident: 'a recall written as a bare travel walked a character out of the inn it was ' +
              'healing in at 1 of 44 health, back down the road that had just killed it',
  },
  vaultBeforeSell: {
    what: 'vault before sell, so a sale cannot eat what you meant to bank',
    since: '2026-09-03',
    incident: 'sell_all offers the merchant everything, so a vault step after a sell banks ' +
              'the leftovers — and the sale reports success either way',
  },
  journeyBudget: {
    what: 'the patience floors that stop a walk being declared failed too early',
    since: '2026-09-04',
    incident: 'with the budget hard-coded at three minutes a failing walk took nine to reach ' +
              'its verdict, so no offline test ever covered the give-up path',
  },
  safeRest: {
    what: 'a rest happens in a safe spot, or it does not happen',
    since: '2026-09-09',
    incident: 'Waldorf died four times in one day, every one of them resting: three with ' +
              '`in_safe_spot: false` in a room holding six hostiles, at 5-10 health of 51. ' +
              'The survival ladder is quiet during a rest BY DESIGN — resting presupposes ' +
              'you walked somewhere unhittable first — so nothing reacted. restUntil does ' +
              'abort on damage, but on a 3s poll, and from six health one skeleton hit ' +
              'lands first. 7 of 37 fleet deaths in three days were inside a safe spot and ' +
              'the other 28 were not in one at all.',
  },
  coordUnits: {
    what: 'coordinates carry their space (square / protocol / client) instead of being bare numbers',
    since: '2026-09-05',
    incident: 'kod PROTOCOL units fed to floorBaseAtClient, which wants CLIENT units — 16x ' +
              'and a one-square origin apart (9fb1ad3); and a declared jump that aimed at ' +
              'col*64+32, the square centre, when the point of declaring it was to land ' +
              'somewhere specific (abec3ac). See tools/m59-coords.mjs.',
  },
});

// The one-line form, for banners and messages.
export const guaranteeText = g =>
  (typeof UNSAFE_GUARANTEES[g] === 'string' ? UNSAFE_GUARANTEES[g] : UNSAFE_GUARANTEES[g]?.what)
  ?? g;

// THE LIST, OLDEST FIRST, WITH THE INCIDENT THAT BOUGHT EACH ONE. Read this when a fleet
// operation goes wrong: if the failure is a class already on the list, the guarantee has a
// hole; if it is not, the list is one entry short and that is the fix.
export function formatGuarantees() {
  const rows = Object.entries(UNSAFE_GUARANTEES)
    .map(([name, g]) => (typeof g === 'string' ? [name, { what: g }] : [name, g]))
    .sort((a, b) => String(a[1].since ?? '').localeCompare(String(b[1].since ?? '')));
  const out = [`${rows.length} guarantees, oldest first.`,
    'Each one is a mistake somebody made twice. A guarantee with no incident is a guess.', ''];
  for (const [name, g] of rows) {
    out.push(`  ${name}${g.since ? `  (since ${g.since})` : ''}`);
    out.push(`    ${g.what}`);
    if (g.incident) out.push(`    incident: ${g.incident}`);
    out.push('');
  }
  out.push('If the same class of bug keeps happening and this list is not growing,');
  out.push('the loop is broken — that is the finding, not the bug.');
  return out.join('\n');
}

// Validates and normalises a script's `unsafe` block. Throws rather than warns: a malformed
// waiver is the one case where carrying on is worse than stopping, because the author
// believes a guarantee is off when it is not, or on when it is not.
export function parseUnsafe(unsafe, { scriptName = 'script' } = {}) {
  if (unsafe == null) return { waived: new Set(), reason: null, all: false, owner: null };
  if (typeof unsafe !== 'object' || Array.isArray(unsafe))
    throw new Error(`${scriptName}: unsafe must be an object, e.g. { reason, waives: [...] }`);

  const reason = String(unsafe.reason ?? '').trim();
  if (!reason)
    throw new Error(
      `${scriptName}: unsafe needs a reason. Write why this errand has to bypass the ` +
      `guarantee — "I know about the trap" and "I forgot" are the same script otherwise.`);

  const waives = unsafe.waives;
  if (!Array.isArray(waives) || !waives.length)
    throw new Error(
      `${scriptName}: unsafe needs waives: [...] naming what to turn off. ` +
      `Known: ${Object.keys(UNSAFE_GUARANTEES).join(', ')}, or '*' for all of them.`);

  const all = waives.includes('*');
  const named = waives.filter(w => w !== '*');
  const unknown = named.filter(w => !(w in UNSAFE_GUARANTEES));
  if (unknown.length)
    throw new Error(
      `${scriptName}: unsafe waives unknown guarantee(s): ${unknown.join(', ')}. ` +
      `Known: ${Object.keys(UNSAFE_GUARANTEES).join(', ')}.`);

  const waived = new Set(all ? Object.keys(UNSAFE_GUARANTEES) : named);
  return { waived, reason, all, owner: unsafe.owner ?? null };
}

// ---------------------------------------------------------------- the step vocabulary

export const walk = (to, opts = {}) => ({ do: 'walk', to, ...opts });
export const bank = (action, amount, opts = {}) => ({ do: 'bank', action, amount, ...opts });
export const shop = (seller, lines, opts = {}) => ({ do: 'shop', seller, lines, ...opts });
// SELL BEFORE YOU BUY. A character leaving a farm room is carrying the loot it earned
// there, the town it is walking to is where that loot is worth money, and the money is
// what pays for the reagents — so the sale is free: no extra journey, no extra room.
// `keep` holds back what the errand still needs (its reagents above all, which several
// merchants will happily buy back off you).
// WHAT MUST SURVIVE A SELL_ALL, whatever else goes.
//
// `sell_all` offers the merchant everything it will take, so anything worth keeping has to be
// named before the counter, not after. This is the floor under every sell step: the reagents
// the errand exists to fetch, the food that gets a character home, and the loot that is worth
// more in a vault than in a purse. A script may add to it and may not silently drop it.
//
// Read off the Castle Victoria loot survey: wands and scrolls have their spoil timer disabled
// (piGoBadTime = -1), so they keep for ever; the ring of invisibility only spends charges
// while worn; gems stack and cost one shilling a point to vault. The temporary attributes —
// shrouded, enchanted, glowing, holy/unholy/fiery/icy/shock/acid — are deliberately NOT here:
// they expire on a 1-24h timer that keeps running in the vault, so they are worth selling.
export const VAULT_KEEP = Object.freeze([
  'herb', 'elderberry', 'inky', 'flask',
  'wand', 'scroll', 'rose', 'ring of invisibility', 'mystic sword', 'true lute',
  'dragon scale', 'angel feather', 'shrunken head',
  'emerald', 'sapphire', 'diamond', 'ruby',
]);

// `{ noVault: true }` acknowledges that this trip cannot or will not vault, and is
// REQUIRED when no vault() precedes the sell — see the plan check in fleetScript.
export const sell = (merchant, opts = {}) => ({ do: 'sell', merchant, ...opts });

// PUT THE KEEPERS SOMEWHERE THEY CANNOT BE SOLD OR DROPPED ON DEATH. Vaults are in Barloque
// and Ko'catan only, so a trip that does not pass one CANNOT vault — which is exactly why the
// keep list above is the real protection and this step is the bonus. Everything a character
// dies holding is on the floor where it fell; a vault is the only thing that is not.
export const vault = (vaultman, items = VAULT_KEEP, opts = {}) =>
  ({ do: 'vault', vaultman, items, ...opts });
// LEAVE THE NEWBIE ZONE, ONCE, AND READ BACK THAT IT HAPPENED.
//
// One-way and not routable: Raza's only exit is a portal in the Grand Museum that takes two
// touches, so `walk`/`travel` cannot express it and answers `started: true, hops: 0` for a
// character that then goes nowhere. Idempotent — a character already outside is skipped, so
// this is safe to put at the head of any errand that might be given a brand-new character.
export const leaveRaza = (opts = {}) => ({ do: 'leave_raza', ...opts });

export const act = (tool, args, opts = {}) => ({ do: 'act', tool, args, ...opts });
export const verify = (fn, why) => ({ do: 'verify', fn, why });

/**
 * Buy one skill or spell from the teacher who sells it, and prove the character holds it.
 *
 * THE VERB `shop` CANNOT BE. See the ability-table section above: `shop` is judged on the
 * pack and an ability enters nothing, so the purchase reads as a failure and every later
 * step is skipped. This is the same errand judged on the only evidence that exists — the
 * character's own skill and spell lists, asked for over the wire.
 *
 * THREE OUTCOMES, KEPT APART, because collapsing them is how money gets spent twice:
 *
 *   not offered  the shelf does not carry it. A teacher lists an ability only when
 *                PlayerCanLearn says SUCCESS and the character does not already hold it
 *                (monster.kod:4855-4862), so "not offered" means ALREADY HELD or NOT YET
 *                EARNED. Neither is an error and neither is worth retrying.
 *   learned      it appeared in the list afterwards. The purchase worked.
 *   charged_but_not_delivered  the purse moved and the ability did not. Measured on
 *                2026-09-07: a character standing with Rook, punch listed at 500, charged
 *                exactly 500, no skill, confirmed over 100 seconds of polling. That defect
 *                is unresolved and is not a scripting bug — which is exactly why this must
 *                be its own outcome and must never be retried in a loop. Each attempt costs
 *                the price again.
 *
 * The row id is DISCOVERED, never passed in: a shop row id is not stable and not derivable
 * from the name, so a hard-coded one buys whatever is in that slot today.
 */
/**
 * Sit down and recover — but only somewhere nothing can hit you.
 *
 * RESTING IS NOT AN ACTION, IT IS A BET THAT YOU CANNOT BE HIT. The survival ladder goes
 * quiet during a rest on purpose: you are meant to have walked somewhere unhittable first,
 * so there is nothing to react to. That is the whole contract, and when it is false the
 * quiet is not caution, it is a character sitting still while something kills it.
 *
 * WHAT IT COST. Waldorf died four times on 2026-09-08, every one of them `strategy:
 * fieldrest`. Three read `in_safe_spot: false` — he sat down in the open. His health trails
 * are `5 -> 6 -> 6 -> 1` of 51, `10 -> 2 -> 3 -> 4` of 51, `10 -> 7 -> 4 -> 5` of 52, with
 * six hostiles in the room each time, and his own fought_back rows show battered skeletons
 * hitting for 12, 13 and 16. From six health one hit is fatal.
 *
 * `restUntil` DOES abort on damage — that was checked, and `abortOnDamage` defaults to true
 * at all ten call sites. But it polls on `sleep(3000)` plus a stats read, so it can only
 * abort 3-5 seconds after the first blow lands. That window is survivable at full health
 * and fatal at a fifth of it. The abort is the second line of defence; standing somewhere
 * nothing reaches is the first, and nothing was enforcing it.
 *
 * So this verb walks to a spot BEFORE it rests, and refuses rather than resting in the open.
 * Preference order is the one `safe_spots` itself argues for: a PROVEN square that holds
 * outranks the geometry's best guess, and a square the book has discredited is never taken.
 *
 * `unsafe: { reason }` is the escape hatch, shaped like the script-level waiver and
 * deliberately as tedious to type: a rescue that must sit down in the open can say so, and
 * the reason is mandatory so "I meant it" and "I forgot" cannot look the same afterwards.
 */
export const rest = (opts = {}) => ({ do: 'rest', ...opts });

export const learn = (teacher, ability, opts = {}) =>
  ({ do: 'learn', teacher, ability, ...opts });

// ---------------------------------------------------------------- healing before a journey
//
// A HURT CHARACTER IS NOT DISQUALIFIED, IT IS EARLY. The first version refused anything
// below the floor, which turned a 2.5% shortfall into a cancelled errand: Rizzo was turned
// away from a shopping trip at 39 of 40. The floor is right — the harness's own
// travel_start_health defaults to full, because an inn or a safe wall heals for free and
// the road does not — but the answer to being below it is to WAIT, not to give up.
//
// AND THE KEEPER DOES THE HEALING, NOT THIS. That is the part worth being careful about:
// `busy` makes the keeper INERT on purpose, so a script that sits and rests while holding
// the body is resting with the survival ladder switched off, in a room that may generate
// monsters. The keeper already knows how to find a wall nothing can reach, sit behind it,
// and stand up again — it is the one-second clock's whole job. So the body is HANDED BACK
// for the duration and re-claimed once it is well.
//
// The cost of handing it back is that something else may move the character meanwhile;
// that is fine and is why the walk re-observes afterwards rather than assuming.
async function healToFloor(ctx, agent, floor, budgetMs) {
  const at0 = await observe(agent);
  if (at0.dead) return { ok: false, why: 'dead' };
  ctx.log(agent, `at ${at0.hpText}, below the ${floor} floor — handing back to the keeper to heal`);

  // Give the body back so the survival ladder and the safe-wall book are live again.
  await call('autopilot', { agent, action: 'free' }, 30_000).catch(() => {});
  await call('autopilot', { agent, action: 'revive' }, 30_000).catch(() => {});

  const until = Date.now() + budgetMs;
  let best = at0.health ?? 0, stalledSince = Date.now();
  try {
    while (Date.now() < until) {
      await sleep(ctx.pollMs);
      const now = await observe(agent);
      if (now.dead) return { ok: false, why: 'died while healing' };
      if (now.health != null && now.health >= floor) {
        ctx.log(agent, `healed to ${now.hpText} — setting out`);
        return { ok: true };
      }
      // NOT IMPROVING IS ITS OWN ANSWER. Some rooms prevent rest, and a character at its
      // ceiling is not going to get better by being watched; either is worth reporting
      // rather than burning the whole budget in silence.
      if (now.health != null && now.health > best + 0.01) { best = now.health; stalledSince = Date.now(); }
      else if (Date.now() - stalledSince > Math.min(120_000, budgetMs / 2))
        return { ok: false, why: `health stopped improving at ${now.hpText} (floor ${floor})` };
    }
    const end = await observe(agent);
    return { ok: false, why: `did not reach the floor in ${Math.round(budgetMs / 1000)}s ` +
                            `(${end.hpText}, floor ${floor})` };
  } finally {
    // Take it back either way: the caller still owns this errand and an unheld body is one
    // the patrol will re-task out from under the next step.
    await call('autopilot', { agent, action: 'busy', kind: 'fleetscript',
      label: ctx.name }, 30_000).catch(() => {});
  }
}

// ---------------------------------------------------------------- the compiled walk
//
// Rules 3, 4 and 5 live here together because they are one behaviour: do not set out hurt,
// wait the road's own length, and do not shout at a character that is already walking.
// Ask the character's own keeper for the route it would take, and judge it against
// KNOWN_TRAPS. Returns {trap} to refuse, {unknown} when the router could not be asked, or
// null when the road is clear. A waived trapCheck waives this too — the rescue that walks
// into 599 on purpose is the same errand either way.
async function routeTrapAhead(ctx, agent, from, to) {
  if (ctx.allowTraps) return null;
  try {
    const ports = await keeperPorts(ctx.fleet);
    const who = ports?.get?.(agent);
    if (!who) return { unknown: 'no keeper port' };
    const r = await keeperCall(who, 'route', { to });
    const hops = r?.route?.hops ?? r?.hops ?? r?.route ?? null;
    if (!Array.isArray(hops) || !hops.length) return { unknown: 'router gave no hops' };
    const trap = routeCrossesTrap(hops);
    return trap ? { trap } : null;
  } catch (e) {
    return { unknown: e?.message ?? String(e) };
  }
}

async function compiledWalk(ctx, agent, to, { minHealth }) {
  // A WALK TO A NON-ROOM IS A REFUSAL, NOT A JOURNEY.
  //
  // Logged live on 2026-09-03: `t11 walking 53 -> null, budget 490s`. A destination that is
  // not a room number cannot be reached, cannot be planned, and — because this is the step
  // that brings a courier home, and that step is `always` — burns the entire budget doing
  // nothing at the end of an errand that has already been paid for. Whatever produced the
  // null (I could not reproduce it from the current script; `home` resolves to 39 through
  // both the dry and the live path), a compiled plan holding one should say so at once
  // instead of asking the mover to walk to it.
  if (to == null || !Number.isFinite(Number(to)))
    return { ok: false, why: `the plan asked for a walk to ${JSON.stringify(to)}, ` +
                             'which is not a room number' };
  for (let attempt = 0; attempt < 3; attempt++) {
    const at = await observe(agent);
    if (!at.ok) return { ok: false, why: 'could not read the character' };
    if (at.room === to) return { ok: true, room: to };
    if (at.dead) return { ok: false, why: 'died', dead: true };
    if (at.health == null)
      // UNKNOWN IS STILL NOT PERMISSION, and it is not something resting fixes: a health we
      // cannot read usually means the keeper is not answering at all, which is exactly when
      // a journey must not start. This caught a character whose keeper process had died.
      return { ok: false, why: 'health is unreadable — not setting out', hurt: true };
    if (at.health < minHealth) {
      const healed = await healToFloor(ctx, agent, minHealth, ctx.healMs);
      if (!healed.ok) return { ok: false, why: `could not reach the health floor: ${healed.why}`,
                               hurt: true, dead: /died|dead/.test(healed.why) };
      continue;   // re-observe: it may have been moved while the keeper held it
    }

    // GUARANTEE 12. Ask the router what it intends BEFORE the body moves. The broker holds a
    // snapshot for a keeper-backed character and answers "ask the keeper", so this asks the
    // keeper — the same process that will actually do the planning, which is the only answer
    // worth having.
    const crossing = await routeTrapAhead(ctx, agent, at.room, to);
    if (crossing?.trap)
      return { ok: false, why: `the route ${at.room} -> ${to} crosses room ${crossing.trap.room} ` +
                               `— ${crossing.trap.why} Pass { allowTraps: true } if this errand ` +
                               `is the rescue.`, trap: crossing.trap };
    if (crossing?.unknown)
      ctx.log(agent, `route ${at.room} -> ${to} could not be read (${crossing.unknown}) — ` +
                     'walking without a trap check on the path');

    const est = await call('travel_estimate', { from: at.room, to, basis: 'p90' }, 30_000)
      .catch(() => null);
    const budget = Math.min(ctx.budgetCapMs,
      Math.max(ctx.budgetFloorMs, (Number(est?.ms) || 400_000) + 90_000));
    ctx.log(agent, `walking ${at.room} -> ${to}, budget ${Math.round(budget / 1000)}s`);
    await call('travel', { agent, to, background: true, run_errands: false }, 60_000).catch(() => ({}));

    const until = Date.now() + budget;
    while (Date.now() < until) {
      await sleep(ctx.pollMs);
      const now = await observe(agent);
      if (now.room === to) return { ok: true, room: to };
      if (now.dead) return { ok: false, why: 'died en route', dead: true };
    }
  }
  return { ok: false, why: `did not reach ${to} in three attempts` };
}

/**
 * DEATH LOSES THE CARGO, NOT THE ERRAND.
 *
 * Operator correction, 2026-09-03: "death interrupts the selling portion, but technically for
 * our purposes you can still go to Tos, buy the reagents (using banked funds) and return to
 * Castle Victoria." That is right, and my first version was wrong — it ended the whole trip,
 * which throws away a journey that is still most of the way to being worth making. What death
 * actually destroys is the PACK: the loot is on the floor where it fell, and so is the purse.
 * The bank balance is untouched, and the bank is the point of the bank.
 *
 * So the body is handed back so the keeper's recovery faculty can get it out of the Underworld
 * on its own one-second clock — that decision is never ours — and this waits for it to come
 * back alive, then re-claims it and reports the purse that survived, which is normally zero.
 */
// ---------------------------------------------------------------- holding a KEEPER, not a shell
//
// `busy` DOES NOT STOP THE KEEPER DRIVING. It was never meant to: it says "an operation is in
// flight" so the fleet's stall detectors step over the character, and on a keeper-backed broker
// it is set on the broker's own shell object, which is not the thing holding the socket. The
// keeper's `/state` has no busy field at all.
//
// So for most of 2026-09-02 this runner and twenty-one keepers were steering the same bodies.
// A peer session measured it: t12 reached the Tos bank at 06:41:49, its own confine (roam:false,
// home 39) walked it back toward Castle Victoria, and the runner re-issued the walk from room 38
// — a second crossing of the killing ground for nothing. t11 went nowhere in twelve minutes
// because its keeper was homing while the runner believed it was walking to 54. And the keeper's
// economy stayed live throughout, banking t12's purse from 5,602 down to walking_money 1,000 the
// moment it stood next to a teller, which is why the errand's own withdrawal arithmetic kept
// coming out wrong.
//
// THE FIX IS NOT `stop`. `Autopilot.stop()` without `hard` calls `goInert`, which puts out the
// survival ladder — and walking an inert character across these roads is exactly what killed
// Cccc on 2026-08-21. An errand may do that inside a town; a journey across the Cragged
// Mountains may not.
//
// What reaches the real driver AND leaves the ladder armed is the faculty lease the keeper
// process exposes itself: `commander_claim` takes work, movement and economy and leaves the four
// protected ones — identity, mortality, survival, recovery — with the keeper, which is the
// boundary this repository is built around. The keeper caps the lease at 30s, so it has to be
// heartbeaten; that cap is the point, because a runner that dies stops beating and the character
// is its keeper's again within half a minute.
const KEEPER_FACULTIES = Object.freeze(['work', 'movement', 'economy']);
const KEEPER_LEASE_MS = 30_000;        // the keeper's own ceiling; asking for more is clamped
const KEEPER_BEAT_MS = 10_000;

let keeperPortsPromise = null;
/**
 * Which port is whose. SCANNED, never computed: a keeper can be re-allocated off its default
 * slot, and a broker that guesses a port and commands whoever answers is a failure this
 * repository has already paid for. Every keeper names itself on `/live`, and the write path
 * refuses an order addressed to a different agent, so a wrong guess is refused rather than obeyed.
 */
async function keeperPorts(fleet) {
  if (keeperPortsPromise) return keeperPortsPromise;
  keeperPortsPromise = (async () => {
    const found = new Map();
    let band;
    try {
      const mod = await import('./runtime/keeper-bands.mjs');
      band = mod.lookupKeeperBand(fleet);
    } catch { return found; }
    if (!band) return found;
    const probes = [];
    for (let port = band.base; port <= band.end; port++)
      probes.push(fetch(`http://127.0.0.1:${port}/live`, { signal: AbortSignal.timeout(700) })
        .then(r => r.ok ? r.json() : null)
        // THE WHOLE IDENTITY TUPLE, because a write must carry all three. `addressedToUs`
        // requires agent AND character AND the keeper's own pid, and supplying only the agent
        // fails the check with the memorable message `this keeper is "t13", not "t13"` — every
        // part must be present before any part is compared. `/live` hands over all three,
        // which is exactly why it is exempt from the addressing rule it enforces.
        .then(v => { if (v?.agent) found.set(String(v.agent),
          { port, character: v.character, pid: v.pid }); })
        .catch(() => {}));
    await Promise.all(probes);
    return found;
  })();
  return keeperPortsPromise;
}

async function keeperCall(who, name, args) {
  const r = await fetch(`http://127.0.0.1:${who.port}/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // All three identity parts at the TOP level. The keeper checks the order is addressed to
    // it before it will even say whether the character is logged in, and a partial address is
    // refused rather than half-honoured.
    body: JSON.stringify({ name, agent: who.agent, character: who.character,
                           keeper_pid: who.pid, args }),
    signal: AbortSignal.timeout(20_000),
  });
  return r.json().catch(() => ({}));
}

/**
 * Take work, movement and economy off the keeper for the duration and keep them. Returns a
 * release function that is safe to call twice.
 */
export async function holdKeeper(ctx, agent, fleet) {
  const ports = await keeperPorts(fleet);
  const entry = ports.get(agent);
  const who = entry && { ...entry, agent };
  if (!who) {
    // NOT FATAL AND NOT SILENT. A broker-run session has no keeper process to lease from, and
    // the broker-side claim is then the whole story. Saying so matters because the difference
    // between "held" and "believed held" is the bug this whole block exists to close.
    ctx.log(agent, 'no keeper process answered on this fleet band — running against the ' +
                   'broker shell alone, so the keeper cannot be steering');
    return { ok: false, cancelJourney: async () => {}, release: async () => {} };
  }
  const claim = await keeperCall(who, 'commander_claim', {
    faculties: KEEPER_FACULTIES, by: `fleetscript:${ctx.name}`,
    lease_ms: KEEPER_LEASE_MS, why: `fleet errand: ${ctx.name}`,
  });
  const got = Object.keys(claim?.faculties ?? {}).filter(f => KEEPER_FACULTIES.includes(f));
  if (claim?.error || !got.length) {
    ctx.log(agent, `the keeper would not yield work/movement/economy: ${claim?.error ?? 'refused'}`);
    return { ok: false, cancelJourney: async () => {}, release: async () => {} };
  }
  ctx.log(agent, `holding ${got.join(', ')} on keeper :${who.port} — survival stays with the keeper`);

  // AND THE JOURNEY THAT IS ALREADY IN FLIGHT, WHICH THE CLAIM DOES NOT TOUCH.
  //
  // Taking the faculties is not taking the body. A `travelJob` started before we arrived
  // keeps running — it is a JOB, not a faculty — and every travel this errand issues then
  // comes back `"<agent> is busy: walk to Upstairs in Castle Victoria"`. The claim reports
  // full success while it happens, so it reads as a working hold that is being ignored.
  //
  // Measured on prod, 2026-09-04: three characters stranded in Ukgoth, claim granting
  // movement/work/economy every eight seconds for six minutes, and all three still walking
  // the castle patrol's route — `commander_claim` answered
  // `social: {owner: "inert:travelling to Upstairs in Castle Victoria"}`, which is the only
  // place the in-flight journey was visible at all. Adding this one call was the difference
  // between "refused: is busy" on every round and all three accepting the new destination.
  //
  // `/cancel` and not `release`: release ends the job slot AND hands the faculties back,
  // which would undo the claim we just took. This only bumps the movement generation, which
  // is what ends the walk.
  const cancelled = await fetch(`http://127.0.0.1:${who.port}/cancel`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: who.agent, character: who.character, keeper_pid: who.pid }),
    signal: AbortSignal.timeout(20_000),
  }).then(r => r.json()).catch(e => ({ error: e.message }));
  if (cancelled?.error) ctx.log(agent, `could not clear the journey in flight: ${cancelled.error}`);

  const beat = setInterval(() => {
    keeperCall(who, 'commander_heartbeat',
      { by: `fleetscript:${ctx.name}`, lease_ms: KEEPER_LEASE_MS }).catch(() => {});
  }, KEEPER_BEAT_MS);
  beat.unref?.();
  let done = false;
  return {
    ok: true,
    /**
     * STOP THE WALK WE STARTED. A runner that exits does not cancel the journey it issued:
     * `travelJob` lives in the KEEPER, so killing the runner leaves a character walking a
     * route nobody is watching any more. t10 died in the Cragged Mountains at 06:50:16Z on
     * 2026-09-03, one minute after its wave was killed, still carrying out the last travel
     * the dead runner had asked for. A stopped wave was not a stopped wave.
     *
     * The keeper's own `release` ends the job slot and the keeper hold, which is the one
     * definition of both — so this is the cancel, and it has to happen before the faculties
     * go back or the keeper inherits a journey it never chose.
     */
    cancelJourney: async why => {
      const r = await keeperCall(who, 'release', { why: why ?? 'the errand ended' })
        .catch(e => ({ error: e.message }));
      if (r?.error) ctx.log(agent, `could not cancel the journey: ${r.error}`);
      return r;
    },
    release: async () => {
      if (done) return;
      done = true;
      clearInterval(beat);
      await keeperCall(who, 'commander_release',
        { faculties: KEEPER_FACULTIES, by: `fleetscript:${ctx.name}` }).catch(() => {});
      ctx.log(agent, 'gave work, movement and economy back to the keeper');
    },
  };
}

async function recoverFromDeath(ctx, agent, budgetMs) {
  await call('autopilot', { agent, action: 'free' }, 30_000).catch(() => {});
  await call('autopilot', { agent, action: 'revive' }, 30_000).catch(() => {});
  const until = Date.now() + budgetMs;
  try {
    while (Date.now() < until) {
      await sleep(ctx.pollMs);
      const now = await observe(agent);
      if (!now.ok || now.dead) continue;
      const inv = await call('inventory', { agent }, 40_000).catch(() => ({ items: [] }));
      const purse = purseOf(inv.items || []);
      ctx.log(agent, `back on its feet in ${now.roomName || 'room ' + now.room} at ${now.hpText}` +
                     ` with ${purse}sh — the loot is gone, the bank is not`);
      return { ok: true, purse };
    }
    return { ok: false, why: `did not come back within ${Math.round(budgetMs / 1000)}s` };
  } finally {
    await call('autopilot', { agent, action: 'busy', kind: 'fleetscript',
      label: ctx.name }, 30_000).catch(() => {});
  }
}

async function runStep(ctx, agent, step, state) {
  switch (step.do) {
    case 'walk':
      return compiledWalk(ctx, agent, step.to, { minHealth: step.minHealth ?? ctx.minHealth });

    case 'bank': {
      const amount = typeof step.amount === 'function' ? step.amount(state) : step.amount;
      if (!(amount > 0)) return { ok: true, skipped: 'nothing to move' };
      const ask = async n => {
        const r = await call('bank', { agent, action: step.action, amount: n }, 60_000)
          .catch(e => ({ error: e.message }));
        // The banker answers in PROSE and a refusal is a sentence, not an error.
        const said = String(r?.banker_said ?? r?.error ?? '');
        return { said, refused: /can't|cannot|only have|no /i.test(said) };
      };
      let out = await ask(amount);
      // THE REFUSAL NAMES THE ANSWER — TAKE IT.
      //
      // "But you only have 5313 shillings in your account!" is not a wall, it is a quote. On
      // 2026-09-03 t11 asked for 5,540 against a balance of 5,313, the step was skipped as
      // optional, and it walked to the apothecary with an empty purse and bought nothing —
      // 227 shillings short of a trip that had already cost a death. Withdrawing what the
      // banker just said is there turns a wasted journey into a full load.
      const named = out.refused && /withdraw/i.test(String(step.action))
        ? out.said.match(/only have\s+([\d,]+)\s+shilling/i) : null;
      if (named) {
        const affordable = Number(named[1].replace(/,/g, ''));
        if (Number.isFinite(affordable) && affordable > 0) {
          ctx.log(agent, `the banker refused ${amount} and named ${affordable} — taking that`);
          const retry = await ask(affordable);
          if (!retry.refused)
            return { ok: true, said: retry.said.slice(0, 120), amount: affordable,
                     asked: amount, note: 'withdrew the balance the banker named' };
          out = retry;
        }
      }
      return { ok: !out.refused, said: out.said.slice(0, 120), amount,
               why: out.refused ? `banker refused: ${out.said.slice(0, 80)}` : undefined };
    }

    case 'rest': {
      const want = { health: step.health ?? 0.9, vigor: step.vigor ?? null };
      // The SCRIPT-level waiver reaches here too, so `unsafe: { waives: ['safeRest'] }` on the
      // script is honoured exactly like the per-step one, banner and all.
      if (ctx.safeRestWaived && step.unsafe === undefined) step = { ...step, unsafe: { reason: ctx.safeRestWaived } };
      // THE WAIVER IS READ BEFORE ANYTHING WALKS, and a bare `unsafe: true` is refused.
      // A reason is the whole difference between a deliberate exception and a forgotten one,
      // and the same rule the script-level waiver keeps.
      if (step.unsafe !== undefined && step.unsafe !== null) {
        const reason = typeof step.unsafe === 'object' ? step.unsafe.reason : null;
        if (!reason || !String(reason).trim()) return { ok: false, outcome: 'unsafe_needs_reason',
          why: 'rest({ unsafe: true }) is refused. Resting in the open is what killed Waldorf ' +
               'four times on 2026-09-08; if an errand genuinely needs it, say why: ' +
               "rest({ unsafe: { reason: 'pulling a corpse out of 599, nowhere is safe' } })" };
        const r = await call('rest_up', { agent, to: want.health }, 300_000).catch(e => ({ error: e.message }));
        recordEvent(agent, 'rest_unsafe', { reason: String(reason).slice(0, 200), room: state.room ?? null });
        return { ok: !r?.error, outcome: 'rested_unsafe', waived: String(reason).slice(0, 200),
                 why: r?.error };
      }

      const look = await call('safe_spots', { agent, reachable_only: true }, 60_000)
        .catch(e => ({ error: e.message }));
      if (look?.error) return { ok: false, outcome: 'no_safe_spot_read', why: look.error };

      // ALREADY STANDING IN ONE THAT WORKS. `in_a_safe_spot_now` is now a MEASUREMENT of the
      // square underfoot rather than a lookup in the retired book — see `standingVerdict` in
      // m59-safewall.mjs. Believe it rather than re-deriving it here.
      const here = look.in_a_safe_spot_now;
      if (here && typeof here === 'object' && here.works !== false) {
        const r = await call('rest_up', { agent, to: want.health }, 300_000).catch(e => ({ error: e.message }));
        return { ok: !r?.error, outcome: 'rested_in_place', at: here.at ?? null, why: r?.error };
      }

      // THE GEOMETRY'S ORDER IS THE ORDER. This used to promote squares the book called
      // `holds` above the geometry's own ranking, and to drop the ones it called
      // `does not work`. Both tiers came from a failure column that is 89% mis-recorded
      // retaliation and crowding (see m59-safewall.mjs), so the promotion preferred whichever
      // square the fleet had piled onto in August and the filter excluded sound walls.
      // `spots` already arrives best-first by geometry, which is the whole answer.
      const usable = (look.spots ?? []).filter(x => Number.isInteger(x.col)
                                                 && Number.isInteger(x.row));
      const target = usable[0] ?? null;
      if (!target) return { ok: false, outcome: 'nowhere_safe_to_rest',
        room: look.room ?? null,
        why: `nothing in ${look.room?.name ?? 'this room'} is safe to rest in — ` +
             `${(look.spots ?? []).length} candidate square(s), none usable. Move somewhere ` +
             'else, or pass unsafe: { reason } if this errand really must sit down here.' };

      const walked = await call('walk_to', { agent, col: target.col, row: target.row }, 120_000)
        .catch(e => ({ error: e.message }));
      // ARRIVING IS NOT ASSUMED. The whole failure this verb exists for is a character that
      // believed it was somewhere it was not, so the spot is re-read from the world and the
      // rest only happens if the keeper now agrees we are in one.
      const after = await call('safe_spots', { agent, reachable_only: true }, 60_000)
        .catch(() => null);
      const nowIn = after?.in_a_safe_spot_now;
      if (!(nowIn && typeof nowIn === 'object' && nowIn.works !== false))
        return { ok: false, outcome: 'could_not_reach_safe_spot',
                 wanted: { col: target.col, row: target.row,
                           can_reach_you: target.can_reach_you ?? null,
                           refused_approaches: target.refused_approaches ?? null },
                 why: `walked toward r${target.row}c${target.col} and the keeper still does not ` +
                      'report us in a working safe spot, so this is not a place to sit down' +
                      (walked?.error ? ` (${walked.error})` : '') };

      const r = await call('rest_up', { agent, to: want.health }, 300_000).catch(e => ({ error: e.message }));
      return { ok: !r?.error, outcome: 'rested_after_moving',
               at: nowIn.at ?? null, can_reach_you: target.can_reach_you ?? null,
               why: r?.error };
    }

    case 'learn': {
      const rx = step.ability instanceof RegExp ? step.ability
        : new RegExp(`^${String(step.ability).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
      // ONE ROW PER ATTEMPT, WHATEVER HAPPENED. The money defect this verb exists to catch
      // has been observed exactly once, by somebody who happened to be watching a console.
      // A row makes it a number: how often the fleet is charged for nothing, and for what.
      // It is also what the refusal above reads, so the two are one feature.
      //
      // `room` is the MAP NUMBER and never the room object id — `observe` reads it off
      // `status.where.num`, which is the map's own view. See m59-ledger-space-test.
      let learnRoom = null;
      const note = (outcome, extra = {}) => {
        try {
          recordEvent(agent, 'learn_attempt', {
            ability: String(step.ability), teacher: String(step.teacher),
            outcome, room: learnRoom, ...extra });
        } catch { /* a ledger write must never cost the errand */ }
      };
      const held = async (refresh) => {
        const a = await call('abilities', { agent, kind: 'both', refresh }, 60_000)
          .catch(() => null);
        return [...(a?.skills ?? []), ...(a?.spells ?? [])]
          .some(x => rx.test(String(x?.name ?? '')));
      };
      // ASK BEFORE BUYING. An ability already held is not on the shelf, so without this the
      // "not offered" branch below cannot tell "you have it" from "you have not earned it",
      // and the first is a success reported as a failure on every repeat run of an errand.
      if (await held(false)) return { ok: true, outcome: 'already_held', ability: step.ability };

      // "DO NOT RETRY IN A LOOP" WAS A COMMENT, AND A COMMENT IS NOT A GUARANTEE.
      //
      // The failure this exists for is not a bug in a step, it is a TRIP THAT CANNOT FIX THE
      // THING THAT OPENED IT: the ability is still missing, so the next sweep plans the same
      // errand, walks the same road, and pays again — reporting a clean, correct,
      // well-formed refusal every time. A sibling session watched exactly that shape on
      // 2026-09-08 in an identify sweep (`karma_too_low`, unfixable by repetition, and it
      // would have looped for ever once armed), and this verb carries the same hazard with
      // money attached.
      //
      // So a charge that bought nothing is remembered, and the SECOND attempt is refused
      // rather than merely deprecated in a comment. `retry: true` on the step is the way
      // past it, because an operator who has fixed the cause must be able to say so — the
      // same shape as `allowTraps`, and deliberately something you have to type.
      // MATCHED ON THE SAME KEY IT IS WRITTEN WITH, which here is the AGENT — as the
      // `vault_trip` row above already is. m59-ledger's own rule is that rows are keyed by
      // CHARACTER NAME, because an agent name is a broker slot and gets reassigned, and
      // fleetscript has been writing the slot instead. That is a real inconsistency and
      // fixing it is a migration of existing rows, not a line in this step; what matters
      // here is that the read and the write agree, so the refusal cannot silently miss.
      const priorCharge = step.retry ? null : (() => {
        try {
          return readLedger({ sinceMs: step.forgetChargeMs ?? 7 * 24 * 3600 * 1000 }).events
            .find(e => e.kind === 'learn_attempt' && e.character === agent
                    && e.outcome === 'charged_but_not_delivered'
                    && rx.test(String(e.ability ?? '')));
        } catch { return null; }   // an unreadable ledger must never block an errand
      })();
      if (priorCharge) return { ok: false, outcome: 'refused_after_charge',
        ability: step.ability, when: priorCharge.iso ?? null,
        why: `this character was already charged ${priorCharge.spent ?? '?'} for ` +
             `"${step.ability}" on ${String(priorCharge.iso ?? '?').slice(0, 19)} and never ` +
             'received it. Refusing rather than paying again — pass `retry: true` once the ' +
             'cause is understood.' };
      const list = await call('shop', { agent, seller: step.teacher }, 60_000).catch(() => null);
      const row = (list?.items || []).find(i => rx.test(String(i.name || '')));
      if (!row) return { ok: false, outcome: 'not_offered', ability: step.ability,
        why: `${step.teacher} is not offering "${step.ability}" and the character does not ` +
             'hold it — PlayerCanLearn says it has not been earned yet. Do not retry.' };
      learnRoom = (await observe(agent).catch(() => null))?.room ?? null;
      const purseBefore = purseOf((await call('inventory', { agent }, 60_000)
        .catch(() => ({ items: [] }))).items ?? []);
      await call('shop', { agent, seller: step.teacher, buy_ids: [{ id: row.id, amount: 1 }] },
                 600_000).catch(() => null);
      // POLLED, because the ability list lags the counter and asking once races it. A "no"
      // that survives the poll is the real answer.
      const until = Date.now() + (ctx.learnSettleMs ?? 15_000);
      for (let i = 0; ; i++) {
        await sleep(Math.min(2500, Math.max(200, ctx.pollMs)));
        if (await held(i > 0)) {
          note('learned', { paid: row.cost ?? null });
          return { ok: true, outcome: 'learned', ability: step.ability, paid: row.cost ?? null };
        }
        if (Date.now() >= until) break;
      }
      const purseAfter = purseOf((await call('inventory', { agent }, 60_000)
        .catch(() => ({ items: [] }))).items ?? []);
      const spent = purseBefore - purseAfter;
      const outcome = spent > 0 ? 'charged_but_not_delivered' : 'not_learned';
      note(outcome, { spent });
      return { ok: false, outcome, ability: step.ability, spent,
               why: spent > 0
                 ? `the purse went down ${spent} for "${step.ability}" and it never appeared ` +
                   'in the skill or spell list — do NOT retry in a loop, each attempt costs ' +
                   'the price again'
                 : `"${step.ability}" was offered but never appeared in the list, and the ` +
                   'purse did not move — the purchase did not happen' };
    }

    case 'shop': {
      const list = await call('shop', { agent, seller: step.seller }, 60_000).catch(() => null);
      const items = list?.items || [];
      const buy = [];
      for (const line of step.lines) {
        const row = items.find(i => line.match.test(i.name || ''));
        if (!row) return { ok: false, why: `${step.seller} has no row matching ${line.match}` };
        // THE RUNTIME NET, for what the plan-time check could not see. `abilitiesTargetedBy`
        // reads a built artefact a fresh clone may not have, and a teacher can list an
        // ability under a name the table does not carry. Caught here the errand still stops
        // before the money moves, which is the part that matters — the plan-time refusal is
        // better only because it stops it before the character walks.
        if (isAbilityName(row.name)) return { ok: false, outcome: 'ability_needs_learn',
          why: `"${row.name}" on ${step.seller}'s shelf is a skill or spell, not goods. ` +
               '`shop` is judged on what enters the pack and an ability enters nothing, so ' +
               'this would have paid and then reported "nothing entered the pack". ' +
               `Use learn('${step.seller}', '${row.name}') instead.` };
        buy.push({ id: row.id, amount: line.amount });
      }
      const before = await inventoryCounts(agent, step.lines);
      const r = await call('shop', { agent, seller: step.seller, buy_ids: buy }, 600_000)
        .catch(e => ({ error: e.message }));
      // THE PACK ARRIVES ON AN EVENT, SO THE READ RIGHT AFTER THE COUNTER IS A READ OF THE
      // PAST. t12 bought 116 elderberry and 116 herbs at Frisconar's on 2026-09-03 and this
      // step reported "nothing entered the pack" two seconds later; the keeper's own state a
      // minute on showed the whole load aboard. A false negative here is worse than a slow
      // step: it unwinds a successful errand and tells an operator the supply run is broken
      // when the reagents are already in the character's hands.
      //
      // So wait for the evidence rather than for a fixed delay — first read that shows a gain
      // wins, and the timeout is only reached when nothing is ever coming.
      let after = before;
      const until = Date.now() + (ctx.packSettleMs ?? 15_000);
      while (Date.now() < until) {
        after = await inventoryCounts(agent, step.lines);
        if (after.some((n, i) => n > before[i])) break;
        await sleep(Math.min(1500, ctx.pollMs));
      }
      // RULE 6. What is in the pack now, minus what was there before. A merchant that
      // completes the handshake and hands over nothing looks like success on the wire.
      const gained = step.lines.map((l, i) => ({ match: String(l.match), got: after[i] - before[i],
                                                 asked: l.amount }));
      const anything = gained.some(g => g.got > 0);
      // A SKILL IS NOT AN ITEM AND NEVER ENTERS THE PACK, so "nothing entered the pack" is
      // not evidence about a skill purchase -- it is the only possible outcome of one. The
      // teacher lists abilities alongside goods and sells them with the same handshake
      // (monster.kod:3866-3874), but what arrives is a row in plSkills, not an object.
      //
      // Measured 2026-09-08. Scooter bought punch from Rook for 500. This step declared
      // "nothing entered the pack", the errand short-circuited, and the `verify` step that
      // WOULD have polled the skill list never ran. He had the skill the whole time -- it
      // read `ability: null` for several minutes first, which is how a freshly bought skill
      // looks before the server states a value.
      //
      // The cost of getting this backwards is not a confusing log line. A purchase reported
      // as failed is a purchase something will retry, and the sale takes the money whether
      // or not the skill was added (monster.kod:3873). `expectsPack: false` hands the
      // verdict to whatever check the caller actually wrote.
      if (step.expectsPack === false)
        return { ok: true, gained, note: r?.note ?? r?.error,
                 bought: anything ? 'and something entered the pack too'
                   : 'nothing entered the pack, which is what an ability purchase looks ' +
                     'like — the caller’s own verification decides whether it worked' };
      return { ok: anything, gained, note: r?.note ?? r?.error,
               why: anything ? undefined : 'nothing entered the pack' };
    }

    case 'sell': {
      const before = await call('inventory', { agent }, 60_000).catch(() => ({ items: [] }));
      const purse0 = (before.items || []).filter(i => /shilling/i.test(i.name || ''))
        .reduce((n, i) => n + (i.amount || 1), 0);
      const r = await call('sell_all', {
        agent, merchant: step.merchant,
        // The reagents this errand exists to fetch must never be sold back at the counter
        // that just sold them, and the food is what gets a character home alive.
        // MERGED, NEVER REPLACED. A script that passes its own `keep` is adding to the
        // floor, not choosing a different one — the commonest way to lose a vault item is a
        // narrower list written for one errand.
        // UN-KEEP WHAT THE VAULT JUST HANDED BACK. `state.sellAnyway` is written by the vault
        // step for surplus it withdrew over a stockpile cap. Dropping those names is safe
        // precisely BECAUSE the deposit ran first: the stock we mean to hold is in the vault,
        // so what carries that name in the pack now is the overflow we already decided to sell.
        keep: [...new Set([...VAULT_KEEP, ...(step.keep ?? [])])]
          .filter(n => !(state.sellAnyway ?? []).some(e =>
            String(e).trim().toLowerCase() === String(n).trim().toLowerCase())),
        min_price: step.minPrice ?? 1,
        // One wielded weapon and one spare. sell_all already keeps equipped gear and one
        // piece for an empty armour slot, which is the shape a farmer should walk home in.
        max_weapons: step.maxWeapons ?? 2,
      }, 600_000).catch(e => ({ error: e.message }));
      const after = await call('inventory', { agent }, 60_000).catch(() => ({ items: [] }));
      const purse1 = (after.items || []).filter(i => /shilling/i.test(i.name || ''))
        .reduce((n, i) => n + (i.amount || 1), 0);
      // JUDGED ON THE PURSE, not on the reply. A merchant that will not deal answers with a
      // SENTENCE spoken to the room, and `sold: []` with no error looks identical to a
      // successful sale of nothing — so the money is the only honest evidence.
      const earned = purse1 - purse0;
      const shed = (before.items || []).length - (after.items || []).length;
      return {
        ok: true,                       // selling nothing is disappointing, not a failure
        earned, shed,
        refused: r?.not_offered?.length ?? 0,
        why: earned <= 0 ? `${step.merchant} bought nothing` : undefined,
      };
    }

    // THIS STEP STORED NOTHING FOR AS LONG AS IT EXISTED, and said `ok` every time.
    //
    // It called `container` with `action:'deposit'`, and `container` has no deposit: it is
    // BP_SEND_OBJECT_CONTENTS, it LOOKS INSIDE a box, and its schema is {agent, target, slot}.
    // So `action`, `container` and `items` were all ignored, `target` arrived undefined, and
    // the tool answered `nothing here matches "undefined"` - which is not a throw, so the
    // catch never fired, `r.error` stayed undefined, nothing left the pack, and the step
    // returned `{ok:true, vaulted:0}`. A silence that reads as success is this game's whole
    // failure mode and this was one of ours.
    //
    // `vault` is the tool that actually deposits. It resolves the vaultman off the live room
    // in the keeper process rather than trusting a name from here, and it reports what left
    // the pack rather than what it sent - so the arithmetic below is the tool's now, and this
    // step is thin on purpose.
    case 'vault': {
      const r = await call('vault', { agent, action: 'deposit', items: step.items },
                           300_000).catch(e => ({ error: e.message }));
      const stored = Number(r?.stored ?? 0);
      // ok when something was stored OR when there was nothing to store. A pack with no
      // keepers in it is not a failed vault trip, and must not stop a circuit.
      const nothingToStore = !stored && !(r?.wanted?.length && r?.refused?.length);
      const ok = stored > 0 || (!r?.error && nothingToStore);
      // WHETHER THE FLEET REACHES ITS VAULTS IS A NUMBER WE HAD TO RECONSTRUCT BY HAND.
      //
      // For a fortnight every trip to room 114 failed and nothing said so: the journey
      // record said `route_progressing_exits_exhausted` like any other short walk, and the
      // only way to see that a DESTINATION was at 0% while its neighbours were at 100% was
      // to write a script that grouped journeys by `to`. That script is what found the
      // off-grid door. It should not have taken a script.
      //
      // So the vault step now says what happened, every time, in one row. `reached` is the
      // question that matters — arriving at the vaultman is the hard part and the part that
      // was broken; `vaulted` is what it was worth once there. A trip that arrives and
      // stores nothing is a healthy no-op and must read differently from one that never
      // arrived, which is why `nothing_to_store` is its own field rather than a zero.
      recordEvent(agent, 'vault_trip', {
        reached: !r?.error,
        vaulted: stored,
        offered: (r?.wanted ?? step.items ?? []).length,
        refused: (r?.refused ?? []).length,
        nothing_to_store: nothingToStore,
        ok,
        why: r?.error ?? r?.reason ?? r?.note ?? null,
      });
      // ALWAYS READ THE SHELF BACK AFTER DEPOSITING, even when this trip stored nothing. A
      // stockpile grows by deposits and shrinks by nothing else, so the only moment it can be
      // over its caps is just after one — and we are standing at the vaultman with the pack
      // already lightened, which is the cheapest this check will ever be.
      //
      // A FAILED EVICTION NEVER FAILS THE VAULT STEP. The deposit is the thing that had to
      // happen; tidying the shelf is a bonus, and a circuit that aborted because a retrieval
      // fee was short would strand a character mid-town having gained nothing.
      const eviction = ok
        ? await runEvictionCheck(ctx, agent, step, call).catch(e => ({ ran: false, why: e.message }))
        : { ran: false, why: 'the deposit did not succeed, so the shelf was not read back' };
      for (const e of (eviction.evicted ?? []))
        if (e.ok && e.disposition !== 'carry' && e.disposition !== 'drop')
          (state.sellAnyway ??= []).push(e.name);
      if (eviction.ran && (eviction.evicted ?? []).length)
        ctx.log(agent, `vault at ${eviction.pct ?? '?'}% — took back ` +
          eviction.evicted.map(e => `${e.evict} ${e.name} (${e.disposition})`).join(', '));
      return { ok,
               vaulted: stored, offered: (r?.wanted ?? step.items ?? []).length,
               deposited: r?.deposited ?? [], refused: r?.refused ?? [],
               said: r?.vaultman_said ?? [],
               eviction,
               why: r?.error ?? r?.reason ?? r?.note ?? null };
    }

    // LEAVE THE NEWBIE ZONE. One-way, and not a journey the router can plan.
    //
    // Raza has no door. The only way out is the portal standing in the Grand Museum
    // (room 1018) at col 11, row 2, and it takes TWO touches — the first bounces you off
    // with a warning. `travel` cannot express that: it returned `started: true, hops: 0`
    // for a character in the Raza Inn and moved it nowhere, which is the exact shape of
    // failure this repository keeps paying for. Nothing errored.
    //
    // The capability was already here twice — the broker's `leave_raza` tool and the
    // `leave_raza` atomic in m59-atomics.mjs — and FLEETSCRIPT HAD NO VERB FOR IT. So the
    // one thing every order is supposed to go through could not express the one move a new
    // character has to make first, and the obvious substitute (`travel`) fails silently
    // rather than refusing. That is the gap this closes: not a missing capability, an
    // unreachable one, which costs the same and is harder to see.
    //
    // TWO THINGS THIS DELIBERATELY DOES NOT DO.
    //
    // It does not use the tool's own `then_travel_to`. That would run a cross-world
    // journey inside a single tool call, outside every guarantee this file exists to
    // compile in — no health floor, no p90-sized wait, no once-only travel. The onward leg
    // is a separate `walk` step, which gets all of them.
    //
    // And it does not trust the reply. `left: true` is what the tool believes; the room
    // the character is standing in is what happened. Read back, always.
    case 'leave_raza': {
      // `observe`, NOT a hand-rolled status read. This file's own comment above observe()
      // says why: every script used to write its own and they disagreed, one reading
      // `st.room.id`, which does not exist. The first draft of this step made that exact
      // mistake one more time.
      const roomNow = async () => (await observe(agent)).room;
      const before = await roomNow();
      if (Number.isInteger(before) && !RAZA_ROOMS.includes(before))
        return { ok: true, skipped: `already outside the newbie zone (room ${before})` };

      const r = await call('leave_raza', { agent }, step.timeoutMs ?? 240_000)
        .catch(e => ({ error: e.message }));
      const after = await roomNow();
      const out = Number.isInteger(after) && !RAZA_ROOMS.includes(after);
      // An unreadable room is NOT success. It is the one answer that must never be
      // rounded to the convenient one — see the menagerie driver reading `where.num`.
      if (!Number.isInteger(after))
        return { ok: false, why: 'could not read which room it is in afterwards, so whether ' +
                 'it left is unknown — not assuming it did', result: r };
      return out
        ? { ok: true, result: { from: before, to: after, note: 'one-way; it cannot walk back in' } }
        : { ok: false, why: `still in the newbie zone (room ${after})` +
             (r?.error ? `: ${r.error}` : '. The portal is in room 1018 at col 11 row 2 and ' +
              'needs two touches; the first only warns.'), result: r };
    }

    case 'act': {
      const r = await call(step.tool, { agent, ...step.args }, step.timeoutMs ?? 120_000)
        .catch(e => ({ error: e.message }));
      return { ok: !r?.error, result: r, why: r?.error };
    }

    case 'verify': {
      const v = await step.fn({ agent, observe, call, state });
      return { ok: Boolean(v), why: v ? undefined : (step.why || 'verification failed') };
    }

    default:
      return { ok: false, why: `unknown step "${step.do}"` };
  }
}

async function inventoryCounts(agent, lines) {
  const inv = await call('inventory', { agent }, 60_000).catch(() => ({ items: [] }));
  return lines.map(l => (inv.items || [])
    .filter(i => l.match.test(i.name || ''))
    .reduce((n, i) => n + (i.amount || 1), 0));
}

// ---------------------------------------------------------------- vault eviction
//
// THE CAPS LIVE WITH THE FLEET, NOT WITH THE HARNESS. `substrate/dumbot/vault-strategy.mjs`
// is this machine's file — gitignored, like substrate/loadouts — and it holds the per-item
// stockpile caps, the bulk/value tables the eviction ranks on, and the disposition rules.
// A machine without one simply does not evict, which is the correct behaviour for a fleet
// that has never said what it wants kept.
//
// It is loaded ONCE and cached. That is a real constraint worth stating: editing the caps
// does not take effect until the process restarts, the same as every other substrate hook.
// THREE PLACES, MOST SPECIFIC FIRST, and there is always an answer:
//
//   M59_VAULT_STRATEGY                      an explicit path. Testing, and one-off runs.
//   substrate/dumbot/vault-strategy.mjs     THIS MACHINE'S fleet, gitignored like loadouts.
//   tools/vault-strategies/keep-unbuyable   the default that ships — see that file.
//
// A fleet that has never said what it wants therefore still gets a defensible shelf rather
// than an unbounded one, which is the behaviour an operator expects from a feature that
// exists at all. Overriding is writing one file; there is nothing to switch on.
export const DEFAULT_VAULT_STRATEGY =
  join(REPO_ROOT, 'tools', 'vault-strategies', 'keep-unbuyable.mjs');

const vaultStrategyCache = new Map();
export async function fleetVaultStrategy() {
  const local = join(REPO_ROOT, 'substrate', 'dumbot', 'vault-strategy.mjs');
  const file = process.env.M59_VAULT_STRATEGY
    || (existsSync(local) ? local : DEFAULT_VAULT_STRATEGY);
  if (vaultStrategyCache.has(file)) return vaultStrategyCache.get(file);
  let mod = null;
  if (existsSync(file)) {
    try { mod = await import(pathToFileURL(file).href); }
    catch { mod = null; }                  // a broken strategy must not break a vault trip
  }
  vaultStrategyCache.set(file, mod);
  return mod;
}

const sameItemName = (a, b) =>
  String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * READ THE VAULT BACK AND TAKE OUT WHAT NO LONGER EARNS ITS SLOT.
 *
 * Runs after every deposit, because the deposit is the only moment we are standing in front
 * of the vaultman with the pack already unburdened. Reading it back is a BUY request — a
 * vaultman's sell list is your own deposit offered at a retrieval fee — so `list` is both
 * how we see the contents and how we open the menu we withdraw through.
 *
 * WHY WITHDRAWN SURPLUS IS SAFE TO SELL, which is the part that is not obvious: the circuit
 * vaults BEFORE any shop stop, deliberately, so that a wrong keep list cannot sell the
 * stock. That ordering gives the invariant this relies on — once the deposit has run, the
 * intended stockpile is in the VAULT, and anything of a capped name left in the pack is
 * surplus by construction. So the sell step may un-keep exactly the evicted names without
 * risking the collection.
 */
async function runEvictionCheck(ctx, agent, step, call) {
  const mod = await fleetVaultStrategy();
  if (!mod?.evictionPlan)
    return { ran: false, why: 'no usable vault strategy (not even the shipped default)' };

  const listed = await call('vault', { agent, action: 'list' }, 180_000)
    .catch(e => ({ error: e.message }));
  if (listed?.error || listed?.ok === false)
    return { ran: false, why: listed?.error ?? listed?.reason ?? 'the vaultman did not open a list' };
  const contents = listed.items ?? [];
  if (!contents.length) return { ran: true, held: 0, evicted: [], why: 'the vault is empty' };

  const plan = mod.evictionPlan(contents);
  const rows = (plan?.plan ?? []).filter(r => Number(r.evict) > 0);
  if (!rows.length)
    return { ran: true, held: contents.length, evicted: [],
             pct: plan?.pct ?? null, why: 'everything is under its cap' };

  // WITHDRAWAL IS A PURCHASE AND PURCHASES NEED IDS, which `vault list` does not carry — it
  // reports names and amounts. The shop tool lists the same menu WITH ids, so one extra read
  // buys the whole plan.
  const menu = await call('shop', { agent, seller: step.vaultman }, 180_000)
    .catch(e => ({ error: e.message }));
  const offered = menu?.items ?? [];

  const done = [];
  for (const r of rows) {
    const row = offered.find(i => sameItemName(i.name, r.name));
    if (!row) { done.push({ ...r, ok: false, why: 'the vaultman did not offer it back' }); continue; }
    const bought = await call('shop',
      { agent, seller: step.vaultman, buy_ids: [{ id: row.id, amount: r.evict }] }, 300_000)
      .catch(e => ({ error: e.message }));
    if (bought?.error) { done.push({ ...r, ok: false, why: bought.error }); continue; }

    // THE DISPOSITION DECIDES WHAT HAPPENS NEXT, AND SELL IS THE DEFAULT.
    //
    //   sell / hand-over-or-sell  leave it in the pack and un-keep the name for the shop
    //                             stops further down the circuit. A genuine hand-off needs a
    //                             two-sided trade with a character this errand is not driving,
    //                             so it degrades to selling and SAYS SO rather than pretending.
    //   carry                     leave it in the pack, still protected. Inky-caps are food.
    //   drop                      put it down here; it was not worth the retrieval fee.
    const disposition = r.disposition ?? 'sell';
    if (disposition === 'drop') {
      await call('act', { agent, verb: 'drop', target: r.name, amount: r.evict }, 120_000)
        .catch(() => null);
    }
    done.push({ ...r, ok: true, disposition,
                degraded: disposition === 'hand-over-or-sell'
                  ? 'no fleetmate is being driven by this errand, so it is sold' : undefined });
  }
  return { ran: true, held: contents.length, pct: plan?.pct ?? null,
           freed: plan?.freed ?? 0, evicted: done };
}
// ---------------------------------------------------------------- the compiler
//
// `steps` may be an array, or a function of the agent so each courier can compute its own
// (a withdrawal sized to what it already carries, say).
export async function fleetScript({
  name, agents, steps, fleet = fleetName(), minHealth = 1, pollMs = 8000,
  // DELIBERATELY GOING INTO A ROOM WE KNOW KEEPS CHARACTERS — a rescue, and nothing else.
  // It has to be written at the call site because "I know about the trap" and "I forgot"
  // otherwise produce exactly the same script. See KNOWN_TRAPS.
  allowTraps = false,
  // THE GENERAL FORM OF allowTraps. `{ reason, waives: ['trapCheck', ...] }` — see
  // UNSAFE_GUARANTEES. allowTraps stays because scripts already pass it, and the two
  // agree: either one waives the trap check, neither turns anything else off.
  unsafe = null,
  // THE FLOOR UNDER A WALK'S PATIENCE, and the only reason it is a parameter: with it
  // hard-coded at three minutes, the FAILING walk took nine minutes to reach its verdict,
  // so no offline test ever covered the path where a walk gives up. That is exactly the
  // path that stranded Zoot in Barloque with his cargo. Untestable code is where bugs live.
  budgetFloorMs = 180_000, budgetCapMs = 900_000,
  // How long to keep re-reading the pack for goods that are on their way in.
  packSettleMs = 15_000,
  // The same patience for an ABILITY, which arrives on a different clock and in a different
  // place: the skill and spell lists lag the counter, so asking once races the purchase.
  // Separate from packSettleMs because they are answers to different questions and a caller
  // tuning one must not silently retune the other.
  learnSettleMs = 15_000,
  // How long to wait for a keeper to walk a corpse out of the Underworld before giving up.
  reviveMs = 300_000,
  // How long a character may rest before a journey. Long enough to climb a full bar
  // at the resting rate (0.29 hp/s at 80 vigor is ~3 minutes for 50 points), bounded
  // so an errand cannot wait for ever on somebody who cannot heal where it stands.
  healMs = 300_000,
  force = process.argv.includes('--force'), parallel = true,
  // GUARANTEE 9. `{ pinned, verified, touches, refuseOnDrift }` — the generation this task
  // was last seen green against. See checkProvenance above for why it exists.
  provenance = null,
  onLog = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a),
} = {}) {
  if (!Array.isArray(agents) || !agents.length) throw new Error('fleetScript needs agents');
  if (!steps) throw new Error('fleetScript needs steps');


  // BEFORE THE LOCK AND BEFORE ANYTHING WALKS, because the whole value of the answer is
  // having it while the fleet is still untouched. Reported on every path — including
  // `unpinned`, quietly — so that "nobody pinned this" and "this is current" never read
  // the same, which is the distinction the outfit errand did not have.
  const prov = checkProvenance(provenance);
  if (prov.status === 'review') {
    onLog(`PROVENANCE: REVIEW — ${prov.why}`);
    for (const f of prov.changed.slice(0, 12)) onLog(`  moved: ${f}`);
    if (prov.changed.length > 12) onLog(`  ...and ${prov.changed.length - 12} more`);
    onLog(`  diff it with: git diff ${prov.pinned}..HEAD -- ${(provenance.touches ?? []).join(' ')}`);
    // A REFUSAL IS THE AUTHOR'S CALL, not this file's. Some errands are cheap to retry and
    // some spend money in a shop; only the author knows which, so the default runs and says
    // so loudly rather than blocking an operation on a diff that may change nothing.
    if (provenance?.refuseOnDrift && !force)
      throw new Error(`${name}: refusing — ${prov.why}. Re-verify and move \`provenance.pinned\`, ` +
                      'or pass --force if you have read the diff and it does not touch this task.');
  } else if (prov.status === 'green') {
    onLog(`provenance: green — ${prov.why}`);
  } else {
    onLog(`provenance: ${prov.status} — ${prov.why}`);
  }

  // Parsed BEFORE anything is claimed or walked: a malformed waiver must fail while the
  // fleet is still untouched, and the banner has to be on screen before the first step.
  const waiver = parseUnsafe(unsafe, { scriptName: name });
  const waived = waiver.waived;
  if (waived.size) {
    onLog('─'.repeat(72));
    onLog(`UNSAFE — ${name} is running with ${waived.size} guarantee(s) OFF:`);
    for (const g of waived) onLog(`    ${g}: ${guaranteeText(g)}`);
    onLog(`  reason: ${waiver.reason}`);
    if (waiver.owner) onLog(`  owner: ${waiver.owner}`);
    onLog(`  still on: ${Object.keys(UNSAFE_GUARANTEES)
      .filter(g => !waived.has(g)).join(', ') || 'nothing'}`);
    onLog('─'.repeat(72));
  }
  // GUARANTEE 11. THE BROKER YOU ARE TALKING TO MUST BE HOLDING THE FLEET YOU NAMED.
  //
  // These arrive from two unrelated places: the fleet name from `--fleet`/`M59_FLEET`/the
  // fleet-default file, and the broker from `M59_CONTROL_URL`, which DEFAULTS TO 8901. So
  // `M59_FLEET=shadow node ...` names shadow, takes shadow's run lock, reports "fleet
  // shadow" in every log line, and sends every call to whatever is on 8901 — which on this
  // machine is production.
  //
  // Measured 2026-09-09, doing exactly that: a `graduate` run for a shadow character was
  // sent to the prod broker. It was harmless only because the agent name did not exist
  // there, so every call refused; had the two fleets shared an agent name — `t1`, or any
  // name a lab roster copies — it would have driven the wrong twenty-one characters and
  // said `fleet shadow` the whole way.
  //
  // This is m59-which.mjs's doctrine, which every /m59 command already runs and which
  // scripts had no equivalent of: a broker is ours only when its /health STATE PATH IS our
  // roster file, never when a label or a reachable port merely matches.
  if (!waived.has('brokerHoldsFleet')) {
    const want = stateFileFor(fleet);
    let held = null, why = null;
    try {
      const r = await fetch(new URL('/health', RPC()), { signal: AbortSignal.timeout(8000) });
      held = (await r.json())?.state ?? null;
    } catch (e) { why = String(e?.message ?? e); }
    // A BROKER THAT WILL NOT ANSWER IS A QUESTION, NOT A FLEET. Same third answer
    // m59-which.mjs had to grow: silence is INDETERMINATE and refuses, because the busiest
    // broker is the one slowest to reply and it is always the one that matters.
    if (held === null)
      throw new Error(`${name}: cannot tell whether the broker at ${RPC()} is holding fleet ` +
        `"${fleet}" (${why ?? 'no state path in /health'}). Refusing rather than guessing. ` +
        `Point it at the right one with M59_CONTROL_URL=http://127.0.0.1:<port>/`);
    if (resolve(held) !== resolve(want))
      throw new Error(`${name}: WRONG BROKER. You named fleet "${fleet}" (${want}) but ` +
        `${RPC()} is holding ${held}. A fleet is its ROSTER FILE and never its name. ` +
        `Set M59_CONTROL_URL=http://127.0.0.1:<port>/ for the broker that holds it.`);
  }

  // GUARANTEE 10. A MENAGERIE HOST IS NOT A FLEET CHARACTER.
  //
  // Hosts ride along on this fleet's broker and are refused by every MCP tool (see
  // docs/m59-menagerie.md), so a script naming one would fail anyway — but it would fail on
  // the call, which is after the run lock is taken and after every other character has
  // started walking. The whole argument for this file is that the refusals happen BEFORE
  // anything moves, so this is checked with the rest of them.
  if (!waived.has('menagerieCheck')) {
    const named = hostsAmong(agents, fleet);
    if (named.length)
      throw new Error(`${name}: ${named.length} of these agents are MENAGERIE HOSTS, not fleet ` +
        `characters: ${named.join(', ')}.
They are driven by tools/m59-menagerie.mjs and ` +
        `their behaviour is a script on disk, not an errand. Drop them from \`agents\`, or — if ` +
        `this script really is meant to drive one — say so with ` +
        `\`unsafe: { reason: '...', waives: ['menagerieCheck'] }\`.`);
  }

  // A waived floor is zero, not "skip the check": every downstream reader keeps working,
  // and a run that waives minHealth still reports the health it set out on.
  if (waived.has('minHealth')) minHealth = 0;
  if (waived.has('trapCheck')) allowTraps = true;
  if (waived.has('journeyBudget')) { budgetFloorMs = 0; budgetCapMs = Math.max(budgetCapMs, 0); }

  // RULE 1 — waivable, and the one most likely to be regretted: two drivers on one fleet is
  // how twenty-one keepers ended up on the same bodies. It is here because a test harness
  // driving a shadow fleet legitimately needs it.
  const claim = waived.has('runLock')
    ? { ok: true, holder: null, tookOverFrom: null }
    : takeRunLock(fleet, { label: `${name} [${agents.join(',')}]`, force });
  if (!claim.ok) {
    const h = claim.holder ?? {};
    onLog(`REFUSING — fleet "${fleet}" is already being driven.`);
    onLog(`  pid ${h.pid ?? '?'} | ${h.label ?? '?'} | ` +
          `${h.at ? Math.round((Date.now() - h.at) / 1000) + 's ago' : '?'}`);
    onLog(`  argv ${h.argv ?? '?'}`);
    onLog('Wait for it, stop that pid, or pass --force if you know it is dead.');
    return { ok: false, refused: true, holder: h };
  }
  if (claim.tookOverFrom) onLog(`note: took over a stale lock — ${claim.tookOverFrom.why}`);

  const ctx = { log: onLog, pollMs, minHealth, healMs, budgetFloorMs, budgetCapMs,
                reviveMs, packSettleMs, learnSettleMs, name,
                // GUARANTEE 12 needs both: the fleet to find the keeper that will plan the
                // route, and the waiver so a rescue into 599 is still allowed to go.
                fleet, allowTraps,
                // WIRED, not merely registered. `waives: ['safeRest']` has to actually reach
                // the step or the entry in UNSAFE_GUARANTEES is decoration — the same failure
                // as a setting that silently does nothing, which is how `purpose` stayed out
                // of a schema for a year with every audit switched off.
                safeRestWaived: waived.has('safeRest') ? (waiver.reason ?? 'waived by the script') : null };
  const held = new Set();

  // RULE 2, and the part every script got wrong: freeing on the abnormal exits too. A
  // force-killed run left six characters "driven", which makes the patrol re-send orders
  // every pass for ever — 15 sends across 15 passes before it was found.
  const freeAll = async () => {
    await Promise.all([...held].map(a =>
      call('autopilot', { agent: a, action: 'free' }, 30_000).catch(() => {})));
    held.clear();
  };
  // Removed again in the finally: these are per-RUN, and a long-lived process that calls
  // fleetScript repeatedly would otherwise accumulate one set per call until node warns
  // about a leak — which is a real handle leak, not just noise.
  const onSignal = () => { freeAll().finally(() => process.exit(130)); };
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const sig of SIGNALS) { try { process.once(sig, onSignal); } catch { /* not here */ } }
  const dropSignalHandlers = () => {
    for (const sig of SIGNALS) { try { process.off(sig, onSignal); } catch { /* fine */ } }
  };

  const results = {};
  const runOne = async agent => {
    const state = { agent, results: {} };
    // Reassigned across a death, when the legs go back to the keeper and are taken again.
    let hold = { ok: false, cancelJourney: async () => {}, release: async () => {} };
    try {
      // TWO DIFFERENT HOLDS, AND BOTH ARE NEEDED. `busy` is for the FLEET — it is what makes
      // stall detectors and supervisors step over this character. The faculty lease is for the
      // KEEPER — it is the only one of the two that stops the process holding the socket from
      // steering. Sending only the first is what put this runner and twenty-one keepers on the
      // same bodies all afternoon.
      await call('autopilot', { agent, action: 'busy', kind: 'fleetscript', label: name }, 40_000)
        .catch(() => {});
      held.add(agent);
      // Waivable, and the sharpest edge in the file: without the lease a DUM bot re-decides
      // about every thirty seconds and quietly overwrites the order while every call still
      // reports success. Anything waiving this is choosing to race the keeper.
      hold = waived.has('keeperLease')
        ? { ok: true, cancelJourney: async () => {}, release: async () => {} }
        : await holdKeeper(ctx, agent, fleet);
      const plan = typeof steps === 'function' ? await steps(agent, state) : steps;

      // VAULT BEFORE SELL, CHECKED BEFORE ANYTHING WALKS.
      //
      // `sell_all` offers the merchant everything it will take, so a vault step AFTER a sell
      // is a vault of whatever the merchant did not want. The order is not a preference, it
      // is the difference between banking a ring of invisibility and selling it — and the
      // mistake is invisible afterwards, because the sale reports success either way.
      //
      // Refused up front rather than at the counter, the same contract the fleet-plan
      // interpreter keeps: a typo in step four must not be discovered by a character standing
      // in the wrong town with its loot already gone.
      // A KNOWN TRAP IS REFUSED FIRST, because every other check here is about an errand
      // going wrong and this one is about a character not coming back. Asked before the
      // first step so the refusal costs nothing, and asked per agent because where a
      // character is standing is part of the question.
      const trap = trapCheck(plan, { standingIn: (await observe(agent)).room, allowTraps });
      if (trap) {
        ctx.log(agent, `plan refused: ${trap}`);
        results[agent] = { ok: false, at: 0, step: 'trap', why: trap, state: state.results };
        return;
      }

      // A SKILL BOUGHT WITH `shop` IS REFUSED BEFORE THE CHARACTER WALKS.
      //
      // Here rather than at the counter because the counter is on the far side of the world:
      // the mistake is cheap to catch and expensive to discover, and discovering it there
      // means a character has crossed a continent, paid, and been left standing at the
      // teacher with the run reporting a failure about luggage. `case 'shop'` keeps its own
      // net for what this cannot see, but by then the walk has happened.
      //
      // The test is the ability table, which is read from the game's own class tree — so a
      // fresh clone without a built compendium simply gets no opinion here and falls through
      // to the runtime net, exactly as it should. Silence is "I do not know", never "fine".
      const shopAbilities = plan.flatMap((s, at) => s.do !== 'shop' ? []
        : abilitiesTargetedBy(s.lines).map(name => ({ at, name, seller: s.seller })));
      if (shopAbilities.length) {
        const first = shopAbilities[0];
        const why = `step ${first.at} buys "${first.name}" from ${first.seller} with \`shop\`, ` +
          'and that is a skill or spell rather than goods. `shop` is judged on what enters ' +
          'the pack; an ability enters nothing (PlayerCanLearn adds it silently, ' +
          'monster.kod:3865), so this would pay and then report "nothing entered the pack", ' +
          'skipping every later step including the walk home. ' +
          `Use learn('${first.seller}', '${first.name}') instead.`;
        ctx.log(agent, `plan refused: ${why}`);
        results[agent] = { ok: false, at: first.at, step: 'shop', why,
                           abilities: shopAbilities.map(a => a.name), state: state.results };
        return;
      }

      const firstSell = waived.has('vaultBeforeSell')
        ? -1 : plan.findIndex(x => x.do === 'sell');
      const lastVault = plan.map(x => x.do).lastIndexOf('vault');
      if (firstSell >= 0 && lastVault > firstSell) {
        const why = `step ${lastVault} vaults AFTER step ${firstSell} sells — ` +
                    'sell_all would have offered the vault items to the merchant first';
        ctx.log(agent, `plan refused: ${why}`);
        results[agent] = { ok: false, at: lastVault, step: 'vault', why, state: state.results };
        return;
      }
      // AND A SELL WITH NO VAULT AT ALL HAS TO SAY SO OUT LOUD.
      //
      // Not every trip can vault — the vaults are in Barloque and Ko'catan only, so a Tos
      // errand physically cannot — and that is a fine thing to do. What is not fine is doing
      // it by omission, because "I decided the keep list is enough" and "I forgot" produce
      // exactly the same plan. `sell(merchant, { noVault: true })` is the acknowledgement:
      // it says the author considered the vault and is relying on VAULT_KEEP instead.
      const unacknowledged = waived.has('vaultBeforeSell') ? -1 : plan.findIndex((x, i) =>
        x.do === 'sell' && !x.noVault && !plan.slice(0, i).some(p => p.do === 'vault'));
      if (unacknowledged >= 0) {
        const why = `step ${unacknowledged} sells with no vault before it — add a vault() step, ` +
                    'or sell(merchant, { noVault: true }) to say the keep list is the plan';
        ctx.log(agent, `plan refused: ${why}`);
        results[agent] = { ok: false, at: unacknowledged, step: 'sell', why, state: state.results };
        return;
      }

      // THE PLAN RUNS IN LEGS, AND AN ABANDONED ERRAND STILL COMES HOME.
      //
      // ZOOT, 2026-09-02. The walk to the Barloque vault failed three times, this loop
      // returned on the spot, and a character was left standing in a foreign town holding
      // seven long swords, a wand and the entire point of the trip. An hour later DUM
      // recalled him to Castle Victoria still carrying all of it, and from the outside that
      // read as the bot losing interest. It was not: this loop dropped him. Two separate
      // things were wrong and they need separate fixes.
      //
      // FIRST, A NICETY KILLED THE ERRAND. Vaulting is a bonus — VAULT_KEEP is what actually
      // protects those items, at the counter, and it was doing its job. The vault stop is
      // worth attempting and never worth abandoning a sale for. `optional` marks such a stop.
      // When an optional WALK fails, every step up to the next walk is skipped with it,
      // because those steps were going to happen AT the place we could not reach — running
      // them where we are standing is how a vault deposit gets offered to a blacksmith.
      //
      // SECOND, NOTHING BROUGHT HIM HOME. A failure returned before the last walk. `always`
      // marks a step that still runs while the plan is unwinding — the same shape DUM's own
      // sell circuit uses for its return leg. A trip that ends in the wrong town is worse
      // than one that ends having bought nothing, because the wrong town is where the roads
      // that killed four characters this week begin.
      let failure = null;
      for (let i = 0; i < plan.length; i++) {
        const step = plan[i], at = i;
        // Unwinding: only the steps that promised to run anyway.
        if (failure && !step.always) continue;
        // NOTHING TO SELL AND NOTHING TO VAULT once the pack is on a floor in another room.
        // The buying half of the errand is still worth finishing; the carrying half is not.
        if (state.died && (step.do === 'sell' || step.do === 'vault')) {
          ctx.log(agent, `step ${at} (${step.do}) skipped: the cargo was lost on death`);
          continue;
        }
        const r = await runStep(ctx, agent, step, state);
        state.results[`${at}:${step.do}`] = r;
        if (!r.ok) {
          // DEATH IS NOT A SKIPPED LEG, AND IT IS NOT THE END OF THE ERRAND EITHER.
          //
          // t18 died on the road to Barloque four minutes after the leg logic shipped, and
          // because the walk was marked `optional` the loop read a corpse as "could not reach
          // that room", skipped the leg, tried the next two stops and then ran the `always`
          // walk home — four orders to a body in the Underworld. `optional` is a claim about
          // a PLACE and `always` is a claim about finishing a trip; neither says whether the
          // character is alive.
          //
          // But ending the whole errand was also wrong. The pack is lost, not the journey:
          // the bank balance is untouched and the shopping is still worth doing. So the body
          // goes back to its keeper — INCLUDING the movement faculty, or the keeper cannot
          // walk it out of the Underworld — and the errand resumes once it is on its feet.
          if (r.dead) {
            ctx.log(agent, `step ${at} (${step.do}): DIED — handing the body back for recovery, ` +
                           'then finishing the shopping on banked funds');
            state.died = true;
            // Hand movement back first: recovery is the keeper's faculty and it cannot walk a
            // corpse out of the Underworld while we are holding the character's legs.
            await hold.release();
            const back = await recoverFromDeath(ctx, agent, ctx.reviveMs);
            if (back.ok) hold = await holdKeeper(ctx, agent, fleet);
            if (!back.ok) {
              failure = { at, step: step.do, why: `died and did not recover: ${back.why}`,
                          dead: true };
              break;
            }
            // The purse died with the body, so anything sized against it has to be re-read.
            state.purse = back.purse;
            i = at - 1;          // retry the step that was interrupted, now alive
            continue;
          }
          if (step.optional) {
            let skipped = 0;
            if (step.do === 'walk')
              while (i + 1 < plan.length && plan[i + 1].do !== 'walk') { i++; skipped++; }
            ctx.log(agent, `step ${at} (${step.do}) skipped, carrying on: ${r.why ?? '?'}` +
              (skipped ? ` (and ${skipped} step(s) that needed to be there)` : ''));
            continue;
          }
          ctx.log(agent, `step ${at} (${step.do}) failed: ${r.why ?? '?'}` +
            (plan.some(x => x.always) ? ' — unwinding to the steps that always run' : ''));
          failure = { at, step: step.do, why: r.why };
          continue;
        }
        ctx.log(agent, `step ${at} (${step.do}) ok` +
          (r.gained ? ` — ${r.gained.map(g => `${g.match} +${g.got}/${g.asked}`).join(', ')}` : '') +
          (r.earned !== undefined ? ` — earned ${r.earned}sh, shed ${r.shed} stack(s)` : '') +
          (r.vaulted !== undefined ? ` — vaulted ${r.vaulted}/${r.offered ?? 0}` : ''));
      }
      // SAY WHETHER THE CARGO IS STILL ABOARD. The operator's question after a failed supply
      // run is never "which step" — it is "is my character still carrying the loot", because
      // that decides whether the next thing to do is retry or rescue.
      const sells = plan.map((x, i) => [i, x]).filter(([, x]) => x.do === 'sell');
      const unsold = sells.length > 0 &&
                     sells.every(([i, x]) => state.results[`${i}:${x.do}`] === undefined);
      results[agent] = failure
        ? { ok: false, ...failure, unsold, state: state.results }
        : { ok: true, unsold: false, state: state.results };
    } catch (e) {
      results[agent] = { ok: false, why: e.message };
      ctx.log(agent, 'ERROR', e.message);
    } finally {
      // CANCEL BEFORE HANDING BACK. Whatever ended this errand — success, a give-up after
      // three attempts, a thrown error, a Ctrl-C — the keeper may still be walking the route
      // we asked for. Handing the faculties back without cancelling gives it a journey it
      // never chose, across the roads that kill this fleet.
      await hold.cancelJourney?.('the fleet errand ended').catch(() => {});
      // Faculties second: give the character its own legs back before anything else is
      // allowed to notice it is free.
      await hold.release().catch(() => {});
      await call('autopilot', { agent, action: 'free' }, 30_000).catch(() => {});
      held.delete(agent);
    }
  };

  ctx.log(`${name}: ${agents.length} agent(s), ${parallel ? 'in parallel' : 'one at a time'}`);
  try {
    if (parallel) await Promise.all(agents.map(runOne));
    else for (const a of agents) await runOne(a);
  } finally {
    await freeAll();
    dropSignalHandlers();
    claim.release();
  }

  const ok = agents.filter(a => results[a]?.ok).length;
  ctx.log(`${name}: ${ok}/${agents.length} completed`);
  return { ok: ok > 0, results };
}
